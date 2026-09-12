/**
 * Model catalog extraction, caching, and resolution for all supported agents.
 *
 * Each agent ships its model list differently -- Claude and Codex embed it in
 * compiled bundles/binaries, Gemini exports it from a JS module, and OpenCode/
 * Cursor/OpenClaw/Antigravity/Kimi/Grok expose it via CLI commands. This
 * module provides a unified `getModelCatalog()` and `resolveModel()` interface
 * over all of them, backed by a file-system cache keyed on source mtime.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execFileSync } from 'child_process';
import type { AgentId } from './types.js';
import chalk from 'chalk';
import { getVersionDir, getVersionHomePath, getBinaryPath } from './installations/versions.js';
import { getModelsCachePath } from './state.js';
import { agentConfigDirName, resolveOpenCodeXdgPath } from './agents.js';
import { stripJsonComments } from './permissions-registry.js';
import { resolveRunDefaults } from './run-defaults.js';
import { getModelPricing, type ModelPricing } from './pricing/index.js';

/** Model identifiers per cloud provider (used by Claude's multi-cloud routing). */
export interface ModelPerCloud {
  firstParty: string;
  bedrock?: string;
  vertex?: string;
  foundry?: string;
  anthropicAws?: string;
  mantle?: string | null;
}

/** A reasoning effort level exposed by an agent's model. */
export interface ReasoningLevel {
  effort: string;
  description?: string;
}

/** Metadata for a single model within an agent's catalog. */
export interface ModelInfo {
  id: string;
  displayName?: string;
  description?: string;
  /** alias label (e.g. "opus", "sonnet", "haiku") that resolves to this id */
  alias?: string;
  /** true if this is the agent's default model */
  isDefault?: boolean;
  /** Per-cloud routing IDs (claude only) */
  perCloud?: ModelPerCloud;
  /** Reasoning levels (codex; claude exposes via --effort with global levels) */
  reasoningLevels?: ReasoningLevel[];
  /** Default reasoning level if applicable */
  defaultReasoningLevel?: string;
  /** Per-token USD pricing when known (from prices.json); absent for subscription/unpriced models. */
  pricing?: ModelPricing;
}

/** The complete model catalog for a specific (agent, version) pair. */
export interface ModelCatalog {
  agent: AgentId;
  version: string;
  source: ModelSourceKind;
  sourcePath: string;
  models: ModelInfo[];
  /** Aliases that the CLI resolves to a canonical id (e.g. { opus: "claude-opus-4-7" } for claude, { flash: "gemini-3-flash-preview" } for gemini) */
  aliases: Record<string, string>;
}

const CACHE_PATH = getModelsCachePath();

/**
 * Bump when the extractor logic changes shape in an incompatible way so cached
 * catalogs from older agents-cli builds are re-extracted.
 */
const CACHE_SCHEMA_VERSION = 4;

/**
 * How long a cached 0-model extraction is trusted before we retry it. Bounds
 * the self-healing window for a transient failure (mid-install, a broken
 * extractor regex fixed in a later agents-cli release) without falling back
 * to re-extracting -- and re-scanning the whole binary -- on every call.
 */
const EMPTY_CATALOG_RETRY_MS = 24 * 60 * 60 * 1000;

/** A single cached model catalog entry keyed by source path and mtime. */
interface CacheEntry {
  sourcePath: string;
  mtime: number;
  catalog: ModelCatalog;
  /** When this entry was extracted. Only checked for a 0-model catalog, to bound its retry window. */
  attemptedAt?: number;
}

/** On-disk shape of the model catalog cache file. */
interface CacheFile {
  schema: number;
  entries: Record<string, CacheEntry>;
}

let memoryCache: CacheFile | null = null;

function cacheKey(agent: AgentId, version: string): string {
  return `${agent}@${version}`;
}

/** Load the cache file from disk (or return the in-memory copy). */
function loadCache(): CacheFile {
  if (memoryCache) return memoryCache;
  try {
    const raw = JSON.parse(fs.readFileSync(CACHE_PATH, 'utf-8'));
    if (raw && raw.schema === CACHE_SCHEMA_VERSION && raw.entries) {
      memoryCache = raw as CacheFile;
    } else {
      // Legacy (pre-schema) or stale-schema cache -- drop it.
      memoryCache = { schema: CACHE_SCHEMA_VERSION, entries: {} };
    }
  } catch {
    memoryCache = { schema: CACHE_SCHEMA_VERSION, entries: {} };
  }
  return memoryCache!;
}

/** Persist the in-memory cache to disk. Best-effort; failures are silent. */
function saveCache(): void {
  if (!memoryCache) return;
  try {
    const dir = path.dirname(CACHE_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(CACHE_PATH, JSON.stringify(memoryCache));
  } catch {
    /* best-effort */
  }
}

/** How the model catalog source was obtained. */
export type ModelSourceKind = 'bundle' | 'binary' | 'cli';

/** Describes the location and extraction strategy for a model catalog source. */
export interface ModelSource {
  path: string;
  kind: ModelSourceKind;
}

/**
 * Locate the file that authoritatively describes the installed model catalog
 * for a given (agent, version). The `kind` tells `getModelCatalog` how to
 * read it:
 *   bundle/binary -- strings(1)-style extraction (claude/codex)
 *   js            -- read + regex-parse an exported JS module (gemini)
 *   cli           -- spawn the agent's own `models` command (opencode/cursor/openclaw)
 *
 * Returns null if nothing usable is found.
 */
export function locateModelSource(
  agent: AgentId,
  version: string
): ModelSource | null {
  const versionDir = getVersionDir(agent, version);

  if (agent === 'claude') {
    const bundle = path.join(versionDir, 'node_modules', '@anthropic-ai', 'claude-code', 'cli.js');
    if (fs.existsSync(bundle)) return { path: bundle, kind: 'bundle' };
    // 2.1.113+ ships a native Mach-O binary
    const bin = path.join(versionDir, 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe');
    if (fs.existsSync(bin)) return { path: bin, kind: 'binary' };
    return null;
  }

  if (agent === 'codex') {
    // Codex's vendored binary has moved across releases:
    //   <=0.98:     @openai/codex/vendor/<triple>/codex/codex
    //   0.99..0.13: @openai/codex-<plat>-<arch>/vendor/<triple>/codex/codex
    //   0.134+:     @openai/codex-<plat>-<arch>/vendor/<triple>/bin/codex
    // We probe all known shapes; first hit wins.
    const triples = ['aarch64-apple-darwin', 'x86_64-apple-darwin', 'x86_64-unknown-linux-musl', 'aarch64-unknown-linux-musl', 'x86_64-pc-windows-msvc', 'aarch64-pc-windows-msvc'];
    const triple = currentTargetTriple();
    const orderedTriples = triple ? [triple, ...triples.filter((t) => t !== triple)] : triples;

    const platformPkgFor = (t: string) => `codex-${t.includes('apple') ? 'darwin' : t.includes('linux') ? 'linux' : 'win32'}-${t.includes('aarch64') ? 'arm64' : 'x64'}`;

    for (const t of orderedTriples) {
      const candidates = [
        path.join(versionDir, 'node_modules', '@openai', platformPkgFor(t), 'vendor', t, 'bin', 'codex'),
        path.join(versionDir, 'node_modules', '@openai', platformPkgFor(t), 'vendor', t, 'codex', 'codex'),
        path.join(versionDir, 'node_modules', '@openai', 'codex', 'vendor', t, 'bin', 'codex'),
        path.join(versionDir, 'node_modules', '@openai', 'codex', 'vendor', t, 'codex', 'codex'),
      ];
      for (const p of candidates) {
        if (fs.existsSync(p)) return { path: p, kind: 'binary' };
      }
    }
    return null;
  }

  // gemini is hard-deprecated (no launch path left to validate a model
  // against), so its bundle is deliberately not parsed for a catalog here.

  if (agent === 'opencode') {
    // The `opencode` shim under node_modules/.bin dispatches to a platform-
    // specific native binary. We don't parse the 100MB binary; we let the CLI
    // produce its own catalog via `opencode models --verbose`.
    const cli = path.join(versionDir, 'node_modules', '.bin', 'opencode');
    if (fs.existsSync(cli)) return { path: cli, kind: 'cli' };
    return null;
  }

  if (agent === 'openclaw') {
    const cli = path.join(versionDir, 'node_modules', '.bin', 'openclaw');
    if (fs.existsSync(cli)) return { path: cli, kind: 'cli' };
    // Fallback: installed outside agents-cli version management (e.g. global npm).
    const pathBin = findOnPath('openclaw');
    if (pathBin) return { path: pathBin, kind: 'cli' };
    return null;
  }

  if (agent === 'antigravity') {
    // The `agy` shim under node_modules/.bin exposes `agy models`. We don't parse
    // any bundle; the CLI produces its own (display-name-only) catalog.
    const cli = path.join(versionDir, 'node_modules', '.bin', 'agy');
    if (fs.existsSync(cli)) return { path: cli, kind: 'cli' };
    const pathBin = findOnPath('agy');
    if (pathBin) return { path: pathBin, kind: 'cli' };
    return null;
  }

  if (agent === 'kimi') {
    const cli = path.join(versionDir, 'node_modules', '.bin', 'kimi');
    if (fs.existsSync(cli)) return { path: cli, kind: 'cli' };
    const pathBin = findOnPath('kimi');
    if (pathBin) return { path: pathBin, kind: 'cli' };
    return null;
  }

  if (agent === 'grok') {
    // Grok ships a native binary under the version home's `.grok/downloads/`,
    // not node_modules/.bin. Prefer a real binary over a failed-download stub
    // (a 99-byte placeholder sometimes left beside a prior good download).
    const preferred = getBinaryPath('grok', version);
    if (isUsableGrokBinary(preferred)) return { path: preferred, kind: 'cli' };
    const downloads = path.join(getVersionHomePath('grok', version), '.grok', 'downloads');
    try {
      const candidates = fs
        .readdirSync(downloads)
        .filter((e) => e.startsWith('grok-'))
        .map((e) => path.join(downloads, e))
        .filter(isUsableGrokBinary)
        .sort((a, b) => {
          try {
            return fs.statSync(b).size - fs.statSync(a).size;
          } catch {
            return 0;
          }
        });
      if (candidates[0]) return { path: candidates[0], kind: 'cli' };
    } catch {
      /* empty downloads */
    }
    return null;
  }

  if (agent === 'cursor') {
    // cursor-agent is installed via curl script, not agents-cli. Version argument
    // is accepted for API symmetry but ignored -- cursor lives on PATH.
    const pathBin = findOnPath('cursor-agent');
    if (pathBin) return { path: pathBin, kind: 'cli' };
    return null;
  }

  if (agent === 'muse') {
    // Muse Code is a self-updating native binary on PATH. It has no catalog
    // CLI; the published model IDs are fixed by Meta Model API docs. Point at
    // the binary so the cache key moves with upgrades, and extract a static
    // catalog in getModelCatalog.
    const pathBin = findOnPath('muse');
    if (pathBin) return { path: pathBin, kind: 'cli' };
    return null;
  }

  return null;
}

/** Real Grok binaries are ~100MB+; failed-download stubs are tens of bytes. */
function isUsableGrokBinary(filePath: string): boolean {
  try {
    const st = fs.statSync(filePath);
    return st.isFile() && st.size > 1024 * 1024;
  } catch {
    return false;
  }
}

/** Search PATH for a command and return its absolute path, or null. */
function findOnPath(command: string): string | null {
  const pathEnv = process.env.PATH || '';
  const exts = process.platform === 'win32' ? (process.env.PATHEXT || '').split(';') : [''];
  for (const dir of pathEnv.split(path.delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const full = path.join(dir, command + ext);
      try {
        if (fs.statSync(full).isFile()) return full;
      } catch {
        /* not here */
      }
    }
  }
  return null;
}

/** Map the current Node.js platform/arch pair to a Rust-style target triple. */
function currentTargetTriple(): string | null {
  switch (`${process.platform}-${process.arch}`) {
    case 'darwin-arm64': return 'aarch64-apple-darwin';
    case 'darwin-x64': return 'x86_64-apple-darwin';
    case 'linux-x64': return 'x86_64-unknown-linux-musl';
    case 'linux-arm64': return 'aarch64-unknown-linux-musl';
    case 'win32-x64': return 'x86_64-pc-windows-msvc';
    case 'win32-arm64': return 'aarch64-pc-windows-msvc';
    default: return null;
  }
}

/**
 * Read a file and return only the printable ASCII runs of length >= minLen,
 * joined with newlines. Mirrors `strings(1)` for portability.
 */
function extractStrings(filePath: string, minLen = 6): string {
  const buf = fs.readFileSync(filePath);
  const out: string[] = [];
  let run: number[] = [];
  for (let i = 0; i < buf.length; i++) {
    const b = buf[i];
    // printable ASCII (incl. tab, newline)
    if ((b >= 0x20 && b <= 0x7e) || b === 0x09 || b === 0x0a) {
      run.push(b);
    } else {
      if (run.length >= minLen) out.push(Buffer.from(run).toString('utf8'));
      run = [];
    }
  }
  if (run.length >= minLen) out.push(Buffer.from(run).toString('utf8'));
  return out.join('\n');
}

/**
 * Extract Claude's model catalog from its bundle/binary.
 *
 * Bundle/binary contains:
 *   - alias map: {opus:"claude-opus-4-7",sonnet:"claude-sonnet-4-6",haiku:"..."}
 *   - per-cloud maps: {firstParty:"claude-opus-4-5-...",bedrock:"...",vertex:"...",...}
 *   - constants: {OPUS_ID:"...",OPUS_NAME:"...",SONNET_ID:"...",...}
 */
/**
 * Drop a catalog id that is a proper dash-boundary prefix of a more-specific
 * sibling also present in the list (e.g. `claude-opus-4` when `claude-opus-4-8`
 * is present, or `claude-opus-4-1` when `claude-opus-4-1-20250805` is present).
 *
 * Two sources produce these prefix forms in the native binary:
 *  - standalone `.includes("claude-opus-4")` prefix-check strings (#1892)
 *  - per-cloud metadata field values such as `foundry:"claude-opus-4-1"` next
 *    to a real firstParty id `claude-opus-4-1-20250805` (#2233)
 *
 * A genuine bare current id with no longer sibling (e.g. `claude-sonnet-5`) is
 * kept. The dash boundary (`startsWith(id + '-')`) avoids collapsing
 * `claude-opus-4-1` into `claude-opus-4-10`.
 */
export function dropBareLegacyIds(ids: string[]): string[] {
  return ids.filter(
    (id) => !ids.some((other) => other !== id && other.startsWith(`${id}-`)),
  );
}

/**
 * Scan raw binary/bundle text for canonical Claude model ids, then drop bare
 * legacy / cloud-metadata prefixes (#1892, #2233). Two independent guards keep
 * non-model strings out of the catalog:
 *
 *  - **Word-boundary anchors on the id regex.** The id must not be glued to a
 *    surrounding identifier character, and must not be the truncated prefix of a
 *    longer *version* token. `(?<![A-Za-z0-9_])` rejects a glued prefix;
 *    `(?![A-Za-z0-9])` rejects a glued alnum suffix; `(?!\.\d)` rejects a
 *    dotted-version continuation — so the bare-major prefix of the binary's own
 *    "Typo in model ID" troubleshooting string `claude-sonnet-4.6` is not
 *    scraped as `claude-sonnet-4`, while a real id followed by an unrelated `.`
 *    suffix (`claude-fable-5.md`) still matches. Dash-separated segments only:
 *    the dotted form never appears in a genuine id.
 *
 *    The id body is captured inside a lookahead (`(?=(...))\1`) so the greedy
 *    `-\d+` run matches **atomically**: without it, a suffix-glued token like
 *    `claude-opus-4-1x` would fail the trailing anchor on the full match, then
 *    backtrack a segment and re-emit the bare `claude-opus-4` — the exact 404-able
 *    id this scan exists to suppress (two packed strings can end up glued with no
 *    separator in the extracted binary text). The atomic match fails outright
 *    instead of degrading to the bare form.
 *  - **`dropBareLegacyIds`.** A fully delimited string the anchors cannot tell
 *    apart from a real id — whether a bare major (`.includes("claude-opus-4")`)
 *    or a bare-minor per-cloud field value (`foundry:"claude-opus-4-1"`) — is
 *    dropped when a more-specific sibling is also present; a genuinely bare
 *    current id with no sibling (`claude-sonnet-5`) is kept.
 */
export function scanClaudeCatalogIds(text: string): string[] {
  const idRe =
    /(?<![A-Za-z0-9_])(?=(claude-(?:opus|sonnet|haiku|fable|mythos)-\d+(?:-\d+)*(?:-(?:fast|v\d+))?))\1(?![A-Za-z0-9])(?!\.\d)/g;
  const scanned = new Set<string>();
  let sm: RegExpExecArray | null;
  while ((sm = idRe.exec(text)) !== null) {
    scanned.add(sm[0]);
    if (sm.index === idRe.lastIndex) idRe.lastIndex++;
  }
  return dropBareLegacyIds([...scanned]);
}

function extractClaudeCatalog(text: string): { models: ModelInfo[]; aliases: Record<string, string> } {
  const aliases: Record<string, string> = {};

  const aliasMapMatch = text.match(/\{opus:"(claude-[^"]+)",sonnet:"(claude-[^"]+)",haiku:"(claude-[^"]+)"\}/);
  if (aliasMapMatch) {
    aliases.opus = aliasMapMatch[1];
    aliases.sonnet = aliasMapMatch[2];
    aliases.haiku = aliasMapMatch[3];
  }

  const constMatch = text.match(/\{OPUS_ID:"([^"]+)",OPUS_NAME:"([^"]+)",SONNET_ID:"([^"]+)",SONNET_NAME:"([^"]+)",HAIKU_ID:"([^"]+)",HAIKU_NAME:"([^"]+)"/);
  const displayNames: Record<string, string> = {};
  if (constMatch) {
    displayNames[constMatch[1]] = constMatch[2];
    displayNames[constMatch[3]] = constMatch[4];
    displayNames[constMatch[5]] = constMatch[6];
  }

  const perCloud: Record<string, ModelPerCloud> = {};
  // The record may carry additional trailing fields (e.g. gateway, eagerInputStreaming)
  // in newer Claude bundles, so the regex does not anchor at the closing brace.
  const perCloudRe = /\{firstParty:"(claude-[^"]+)",bedrock:"([^"]+)"(?:,vertex:"([^"]+)")?(?:,foundry:"([^"]+)")?(?:,anthropicAws:"([^"]+)")?(?:,mantle:(?:null|"([^"]*)"))?/g;
  let m: RegExpExecArray | null;
  while ((m = perCloudRe.exec(text)) !== null) {
    const id = m[1];
    if (perCloud[id]) continue;
    perCloud[id] = {
      firstParty: id,
      bedrock: m[2],
      vertex: m[3],
      foundry: m[4],
      anthropicAws: m[5],
      mantle: m[6] ?? null,
    };
  }

  const aliasReverse: Record<string, string> = {};
  for (const [a, id] of Object.entries(aliases)) aliasReverse[id] = a;
  const defaults = new Set(Object.values(aliases));

  const build = (ids: Iterable<string>): ModelInfo[] =>
    Array.from(new Set(ids))
      .filter((id) => /^claude-(opus|sonnet|haiku|fable|mythos)-/.test(id))
      .sort()
      .map((id) => ({
        id,
        displayName: displayNames[id],
        alias: aliasReverse[id],
        isDefault: defaults.has(id),
        perCloud: perCloud[id],
      }));

  // The structured maps (alias/perCloud/const) are the curated, accurate
  // supported set. Prefer them.
  let models = build([
    ...Object.values(aliases),
    ...Object.keys(displayNames),
    ...Object.keys(perCloud),
  ]);

  // Fallback id scan. The structured maps fail on the newest native-binary
  // format (verified: claude@2.1.219 leaks only a stray id, so the curated set
  // is effectively empty). Only when the curated catalog is that thin do we scan
  // the raw strings for canonical ids -- so an older version keeps its precise
  // catalog while a newer one still gets a real catalog (incl. fable/mythos and
  // the opus-5/sonnet-5 line) rather than an empty or single-model one.
  if (models.length < 2) {
    const filtered = scanClaudeCatalogIds(text);
    if (filtered.length >= 2) models = build(filtered);
  }

  return { models, aliases };
}

/**
 * Extract Codex's model catalog. Catalog is embedded as JSON-ish records:
 *   "slug": "...", "display_name": "...", "description": "...",
 *   "default_reasoning_level": "...", "supported_reasoning_levels": [...]
 */
function extractCodexCatalog(text: string): { models: ModelInfo[]; aliases: Record<string, string> } {
  const models: ModelInfo[] = [];
  const seen = new Set<string>();

  // Anchor on each "slug" then walk forward for the related fields within ~1500 chars
  const slugRe = /"slug":\s*"([^"]+)"/g;
  let m: RegExpExecArray | null;
  while ((m = slugRe.exec(text)) !== null) {
    const slug = m[1];
    if (seen.has(slug)) continue;
    seen.add(slug);

    const window = text.slice(Math.max(0, m.index - 200), m.index + 1500);

    const displayMatch = window.match(/"display_name":\s*"([^"]+)"/);
    const descMatch = window.match(/"description":\s*"([^"]+)"/);
    const defaultLevelMatch = window.match(/"default_reasoning_level":\s*"([^"]+)"/);

    const reasoningLevels: ReasoningLevel[] = [];
    const levelsBlock = window.match(/"supported_reasoning_levels":\s*\[([\s\S]*?)\]/);
    if (levelsBlock) {
      const levelRe = /\{\s*"effort":\s*"([^"]+)"(?:,\s*"description":\s*"([^"]+)")?\s*\}/g;
      let lm: RegExpExecArray | null;
      while ((lm = levelRe.exec(levelsBlock[1])) !== null) {
        reasoningLevels.push({ effort: lm[1], description: lm[2] });
      }
    }

    models.push({
      id: slug,
      displayName: displayMatch?.[1],
      description: descMatch?.[1],
      defaultReasoningLevel: defaultLevelMatch?.[1],
      reasoningLevels: reasoningLevels.length > 0 ? reasoningLevels : undefined,
    });
  }

  return { models, aliases: {} };
}

/**
 * Extract OpenCode's catalog by invoking `opencode models --verbose`. The
 * output is a sequence of `<provider>/<id>\n{json}` blocks -- we parse every
 * JSON block that follows a provider/id line.
 *
 * OpenCode caches the models.dev snapshot internally, so this is a local,
 * non-network call after first launch.
 */
function extractOpenCodeCatalog(binaryPath: string): { models: ModelInfo[]; aliases: Record<string, string> } {
  let stdout: string;
  try {
    stdout = execFileSync(binaryPath, ['models', '--verbose'], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 15_000,
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch {
    return { models: [], aliases: {} };
  }

  const models: ModelInfo[] = [];
  const seen = new Set<string>();

  // Blocks look like:
  //   provider/model-id
  //   {
  //     "id": "...", "providerID": "...", "name": "...", ...
  //   }
  // Walk forward finding `{` at column 0 that terminates with a `}` at column 0.
  const lines = stdout.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!/^[a-z0-9][a-z0-9.-]*\/[^\s]+$/i.test(line)) continue;
    const fullKey = line;
    // Find the opening `{` right after this line, collect until matching `}`.
    let start = -1;
    for (let j = i + 1; j < lines.length; j++) {
      if (lines[j] === '{') { start = j; break; }
      if (lines[j].trim() !== '') break;
    }
    if (start === -1) continue;
    let depth = 0;
    let end = -1;
    for (let j = start; j < lines.length; j++) {
      for (const ch of lines[j]) {
        if (ch === '{') depth++;
        else if (ch === '}') depth--;
      }
      if (depth === 0) { end = j; break; }
    }
    if (end === -1) continue;
    const json = lines.slice(start, end + 1).join('\n');
    try {
      const obj = JSON.parse(json);
      if (seen.has(fullKey)) continue;
      seen.add(fullKey);
      // obj.status can be "active" | "deprecated" | "preview" -- surface only
      // when it isn't the default so the consumer can flag stale models.
      const nonDefaultStatus = obj.status && obj.status !== 'active' ? obj.status : undefined;
      models.push({
        id: fullKey,
        displayName: obj.name,
        description: nonDefaultStatus,
      });
    } catch {
      /* skip malformed block */
    }
    i = end;
  }

  // Second pass: if --verbose produced nothing, fall back to the plain list.
  if (models.length === 0) {
    try {
      const plain = execFileSync(binaryPath, ['models'], {
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 10_000,
        maxBuffer: 16 * 1024 * 1024,
      });
      for (const raw of plain.split('\n')) {
        const id = raw.trim();
        if (!id || !/^[a-z0-9][a-z0-9.-]*\/[^\s]+$/i.test(id)) continue;
        if (seen.has(id)) continue;
        seen.add(id);
        models.push({ id });
      }
    } catch {
      /* leave empty */
    }
  }

  return { models, aliases: {} };
}

/**
 * Extract Cursor's catalog via `cursor-agent --list-models`. Output lines look like:
 *   `auto - Auto`
 *   `composer-2-fast - Composer 2 Fast  (current, default)`
 *   `gpt-5.3-codex - Codex 5.3`
 */
function extractCursorCatalog(binaryPath: string): { models: ModelInfo[]; aliases: Record<string, string> } {
  let stdout: string;
  try {
    stdout = execFileSync(binaryPath, ['--list-models'], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 15_000,
      maxBuffer: 8 * 1024 * 1024,
    });
  } catch {
    return { models: [], aliases: {} };
  }

  // Strip ANSI escape sequences; cursor renders a loading spinner.
  // eslint-disable-next-line no-control-regex
  const plain = stdout.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');
  const models: ModelInfo[] = [];
  const seen = new Set<string>();

  for (const raw of plain.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    // Expect `id - display[  (flag1, flag2, ...)]`
    const m = line.match(/^([A-Za-z0-9][A-Za-z0-9.\-_]*)\s+-\s+(.+)$/);
    if (!m) continue;
    const id = m[1];
    if (seen.has(id)) continue;
    seen.add(id);
    const rest = m[2];
    const flagMatch = rest.match(/\s+\(([^)]+)\)\s*$/);
    const flags = flagMatch ? flagMatch[1].split(',').map((s) => s.trim().toLowerCase()) : [];
    const displayName = (flagMatch ? rest.slice(0, flagMatch.index) : rest).trim();
    models.push({
      id,
      displayName,
      isDefault: flags.includes('default'),
    });
  }

  return { models, aliases: {} };
}

/**
 * Extract OpenClaw's catalog via `openclaw models list --all --json`. OpenClaw
 * bundles its own models.dev-like snapshot and exposes a stable JSON shape.
 */
function extractOpenClawCatalog(binaryPath: string): { models: ModelInfo[]; aliases: Record<string, string> } {
  let stdout: string;
  try {
    stdout = execFileSync(binaryPath, ['models', 'list', '--all', '--json'], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 20_000,
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch {
    return { models: [], aliases: {} };
  }

  // OpenClaw prefaces output with a banner line on stderr; stdout should be
  // pure JSON, but be defensive and skip preface text if any slipped through.
  const firstBrace = stdout.indexOf('{');
  if (firstBrace === -1) return { models: [], aliases: {} };
  let parsed: any;
  try {
    parsed = JSON.parse(stdout.slice(firstBrace));
  } catch {
    return { models: [], aliases: {} };
  }

  const rawModels = Array.isArray(parsed?.models) ? parsed.models : [];
  const models: ModelInfo[] = rawModels
    .filter((m: any) => typeof m?.key === 'string')
    .map((m: any) => ({
      id: m.key,
      displayName: typeof m.name === 'string' ? m.name : undefined,
      isDefault: m.available === true && m.tags?.includes?.('default'),
    }));

  return { models, aliases: {} };
}

/**
 * Extract Antigravity's catalog via `agy models`. Antigravity is unusual: it
 * prints DISPLAY NAMES ONLY, one per line, with no machine ids and no --json:
 *   Gemini 3.5 Flash (Medium)
 *   Claude Sonnet 4.6 (Thinking)
 * Verified (agy 1.0.11) that those display strings ARE the accepted `--model`
 * values -- `agy --model "Claude Opus 4.6 (Thinking)"` routes to that model,
 * and an unknown value silently falls back to the first row. So we use each
 * display string as both id and displayName, and mark the first row default.
 */
function extractAntigravityCatalog(binaryPath: string): { models: ModelInfo[]; aliases: Record<string, string> } {
  let stdout: string;
  try {
    stdout = execFileSync(binaryPath, ['models'], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 15_000,
      maxBuffer: 8 * 1024 * 1024,
    });
  } catch {
    return { models: [], aliases: {} };
  }

  // Strip ANSI in case a spinner or color codes slip through.
  // eslint-disable-next-line no-control-regex
  const plain = stdout.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');
  const models: ModelInfo[] = [];
  const seen = new Set<string>();

  for (const raw of plain.split('\n')) {
    const name = raw.trim();
    if (!name) continue;
    // Guard against any stray banner/usage lines: real rows look like
    // "<Vendor> <Model> (<Level>)". Require an alphanumeric start and a
    // parenthesized suffix, which every observed model row has.
    if (!/^[A-Za-z0-9].*\([^)]+\)\s*$/.test(name)) continue;
    if (seen.has(name)) continue;
    seen.add(name);
    models.push({
      id: name,
      displayName: name,
      // Antigravity's first listed model is its default (unknown --model values
      // fall back to it), so flag the first row we accept.
      isDefault: models.length === 0,
    });
  }

  return { models, aliases: {} };
}

/**
 * Parse `grok models` stdout into a catalog. Exported for unit tests.
 *
 * Output shape (verified 0.2.118):
 *   You are logged in with grok.com.
 *
 *   Default model: grok-4.5
 *
 *   Available models:
 *     * grok-4.5 (default)
 *
 * The `Default model:` line is authoritative; rows may also carry a leading `*`
 * and a `(default)` flag. Grok has no `--json` on this subcommand. Settings live
 * in `config.toml` / `models_cache.json`, not `settings.json`, so the native
 * settings.json reader cannot surface the default — the catalog is the source
 * that makes `resolveConfiguredModel` return a cli-default for Grok.
 */
export function parseGrokModelsStdout(stdout: string): { models: ModelInfo[]; aliases: Record<string, string> } {
  // Strip ANSI in case a spinner or color codes slip through.
  // eslint-disable-next-line no-control-regex
  const plain = stdout.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');

  let defaultId: string | null = null;
  const defaultLine = plain.match(/Default model:\s*(\S+)/i);
  if (defaultLine) defaultId = defaultLine[1];

  const models: ModelInfo[] = [];
  const seen = new Set<string>();

  for (const raw of plain.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    // Rows: "* grok-4.5 (default)" or "grok-4.5" or "  grok-code-fast-1"
    const m = line.match(/^\*?\s*([A-Za-z0-9][A-Za-z0-9._-]*)(?:\s+\(([^)]*)\))?\s*$/);
    if (!m) continue;
    const id = m[1];
    // Real model ids are grok-* (or match the Default model: line). Skip banner words.
    if (!/^grok[-_]/i.test(id) && id !== defaultId) continue;
    if (seen.has(id)) continue;
    seen.add(id);
    const flags = (m[2] ?? '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
    models.push({
      id,
      isDefault: (defaultId != null && id === defaultId) || flags.includes('default'),
    });
  }

  // If Default model was set but did not appear as a row, still surface it.
  if (defaultId && !seen.has(defaultId)) {
    models.unshift({ id: defaultId, isDefault: true });
  }

  // Normalize: exactly one default when we know the Default model: id.
  if (defaultId) {
    for (const model of models) model.isDefault = model.id === defaultId;
  } else if (models.length > 0 && !models.some((model) => model.isDefault)) {
    models[0].isDefault = true;
  }

  return { models, aliases: {} };
}

/** Extract Grok's catalog via `grok models` (see parseGrokModelsStdout). */
function extractGrokCatalog(binaryPath: string): { models: ModelInfo[]; aliases: Record<string, string> } {
  const env = { ...process.env };
  // Point GROK_HOME at the version home that owns this binary so auth +
  // models_cache come from the right install, not a host ~/.grok symlink.
  // binary: <home>/.grok/downloads/grok-<ver>-...
  const downloadsDir = path.dirname(binaryPath);
  if (path.basename(downloadsDir) === 'downloads') {
    env.GROK_HOME = path.dirname(downloadsDir);
  }

  let stdout: string;
  try {
    stdout = execFileSync(binaryPath, ['models'], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 15_000,
      maxBuffer: 8 * 1024 * 1024,
      env,
    });
  } catch {
    return { models: [], aliases: {} };
  }

  return parseGrokModelsStdout(stdout);
}

/**
 * Extract Kimi's catalog via `kimi provider list --json`, which emits the raw
 * providers/models config. Model ids are the `models` object keys (e.g.
 * `kimi-code/kimi-for-coding`). The default is reported on a separate plain
 * `Default model: <id>` line by `kimi provider list` (no flags), so we run that
 * too to flag the default row.
 */
function extractKimiCatalog(binaryPath: string): { models: ModelInfo[]; aliases: Record<string, string> } {
  let jsonOut: string;
  try {
    jsonOut = execFileSync(binaryPath, ['provider', 'list', '--json'], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 15_000,
      maxBuffer: 16 * 1024 * 1024,
    });
  } catch {
    return { models: [], aliases: {} };
  }

  const firstBrace = jsonOut.indexOf('{');
  if (firstBrace === -1) return { models: [], aliases: {} };
  let parsed: any;
  try {
    parsed = JSON.parse(jsonOut.slice(firstBrace));
  } catch {
    return { models: [], aliases: {} };
  }

  // Resolve the default model id from the plain listing's "Default model:" line.
  let defaultId: string | null = null;
  try {
    const plain = execFileSync(binaryPath, ['provider', 'list'], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 10_000,
      maxBuffer: 4 * 1024 * 1024,
    });
    const m = plain.match(/Default model:\s*(\S+)/);
    if (m) defaultId = m[1];
  } catch {
    /* default flag is best-effort */
  }

  const modelsObj = parsed?.models && typeof parsed.models === 'object' ? parsed.models : {};
  const models: ModelInfo[] = [];
  for (const id of Object.keys(modelsObj)) {
    const info = modelsObj[id] ?? {};
    models.push({
      id,
      displayName: typeof info.displayName === 'string' ? info.displayName : undefined,
      isDefault: defaultId != null && id === defaultId,
    });
  }

  return { models, aliases: {} };
}


/**
 * Build (or load from cache) the model catalog for a specific (agent, version).
 * Cache is keyed on source-file mtime (binary or js module), so re-extracts
 * automatically when the user upgrades or reinstalls a version.
 */
/**
 * Static Muse Spark catalog. Meta Model API publishes these IDs; Muse Code
 * has no `muse models` command. Default is muse-spark-1.2 (docs + first-run).
 * Source: https://dev.meta.ai/docs/pricing-rate-limits and muse-code overview.
 */
function extractMuseCatalog(): { models: ModelInfo[]; aliases: Record<string, string> } {
  const models: ModelInfo[] = [
    {
      id: 'muse-spark-1.2',
      displayName: 'Muse Spark 1.2',
      isDefault: true,
    },
    {
      id: 'muse-spark-1.1',
      displayName: 'Muse Spark 1.1',
    },
    {
      id: 'muse-spark-1.2-contributor',
      displayName: 'Muse Spark 1.2 Contributor',
    },
  ];
  const aliases: Record<string, string> = {
    spark: 'muse-spark-1.2',
    'spark-1.2': 'muse-spark-1.2',
    'spark-1.1': 'muse-spark-1.1',
    contributor: 'muse-spark-1.2-contributor',
    default: 'muse-spark-1.2',
  };
  return { models, aliases };
}

export function getModelCatalog(agent: AgentId, version: string): ModelCatalog | null {
  const src = locateModelSource(agent, version);
  if (!src) return null;

  let mtime = 0;
  try {
    mtime = fs.statSync(src.path).mtimeMs;
  } catch {
    return null;
  }

  const cache = loadCache();
  const key = cacheKey(agent, version);
  const cached = cache.entries[key];
  if (cached && cached.sourcePath === src.path && cached.mtime === mtime) {
    const isFresh =
      cached.catalog.models.length > 0 ||
      Date.now() - (cached.attemptedAt ?? 0) < EMPTY_CATALOG_RETRY_MS;
    if (isFresh) return cached.catalog;
  }

  let models: ModelInfo[] = [];
  let aliases: Record<string, string> = {};

  if (src.kind === 'bundle' || src.kind === 'binary') {
    const text = extractStrings(src.path);
    ({ models, aliases } =
      agent === 'claude' ? extractClaudeCatalog(text)
      : agent === 'codex' ? extractCodexCatalog(text)
      : { models: [], aliases: {} });
  } else if (src.kind === 'cli') {
    if (agent === 'opencode') ({ models, aliases } = extractOpenCodeCatalog(src.path));
    else if (agent === 'cursor') ({ models, aliases } = extractCursorCatalog(src.path));
    else if (agent === 'openclaw') ({ models, aliases } = extractOpenClawCatalog(src.path));
    else if (agent === 'antigravity') ({ models, aliases } = extractAntigravityCatalog(src.path));
    else if (agent === 'kimi') ({ models, aliases } = extractKimiCatalog(src.path));
    else if (agent === 'grok') ({ models, aliases } = extractGrokCatalog(src.path));
    else if (agent === 'muse') ({ models, aliases } = extractMuseCatalog());
  }

  // Attach per-token pricing where the offline table knows the model, so the
  // catalog carries $/token for the tier display and budgeting. Subscription /
  // unknown models keep `pricing` undefined (surfaced as "--", never faked).
  for (const m of models) {
    const p = getModelPricing(m.id);
    if (p) m.pricing = p;
  }

  const catalog: ModelCatalog = {
    agent,
    version,
    source: src.kind,
    sourcePath: src.path,
    models,
    aliases,
  };

  // Cache a 0-model extraction too, stamped with when it was attempted, so a
  // broken/mid-install extractor doesn't force a full re-scan of the source
  // binary (up to ~1.85s each for a 230-270MB Claude binary) on every call --
  // `getModelCatalog` runs once per installed version per invocation of
  // commands like `agents view`. It self-heals: the read site above re-tries
  // extraction once EMPTY_CATALOG_RETRY_MS has elapsed, or immediately once
  // the source file's mtime changes (an upgrade/reinstall).
  cache.entries[key] = { sourcePath: src.path, mtime, catalog, attemptedAt: Date.now() };
  saveCache();
  return catalog;
}

/** The result of resolving a user-supplied model string against the catalog. */
export interface ResolvedModel {
  /** The model string to forward to the CLI (canonical id when we can resolve, else passed through unchanged). */
  forwarded: string;
  /** The canonical id, when we could resolve the input through the alias map. */
  canonical?: string;
  /** Warning to surface to the user (e.g. "model X not in known catalog for v Y"). */
  warning?: string;
}

/**
 * Resolve a user-supplied model string for a specific (agent, version).
 *
 * Pass-through semantics: we never block. If the input doesn't match anything
 * we know about, we forward it as-is and return a warning the caller can log.
 *
 * - If `requested` matches an alias in the catalog (e.g. "opus"), we still
 *   forward the alias (the CLI accepts both), but we report the canonical id
 *   so logs/metadata can record the concrete model.
 * - If `requested` matches a known canonical id, no warning.
 * - If `requested` is unknown to our extractor, we forward it and warn.
 */
export function resolveModel(agent: AgentId, version: string, requested: string): ResolvedModel {
  const catalog = getModelCatalog(agent, version);
  if (!catalog) {
    return { forwarded: requested };
  }

  const aliasTarget = catalog.aliases[requested];
  if (aliasTarget) {
    return { forwarded: requested, canonical: aliasTarget };
  }

  const knownIds = new Set(catalog.models.map((m) => m.id));
  if (knownIds.has(requested)) {
    return { forwarded: requested, canonical: requested };
  }

  // Strip [1m] context-window suffix before checking (Claude appends at runtime)
  const stripped = requested.replace(/\[[^\]]+\]$/, '');
  if (knownIds.has(stripped)) {
    return { forwarded: requested, canonical: requested };
  }

  const suggestions = pickSuggestions(requested, catalog);
  const hint = suggestions.length > 0 ? ` (closest: ${suggestions.join(', ')})` : '';
  return {
    forwarded: requested,
    warning: `model "${requested}" not in known catalog for ${agent}@${version}; forwarding as-is${hint}`,
  };
}

/**
 * Resolve the model id an `agents run` will ACTUALLY use, for cost estimation
 * (issue #346). The run path resolves the model in this precedence:
 *   1. explicit `--model` (or profile/workflow/runDefaults value) — `requested`
 *   2. otherwise the agent CLI's own built-in default, which we read from the
 *      extracted catalog's `isDefault` model.
 * Returns null only when we have neither — the caller must then treat the
 * estimate as unpriced rather than silently using an unpriced placeholder id
 * like `${agent}-default`.
 */
export function resolveEffectiveModel(
  agent: AgentId,
  version: string,
  requested?: string,
): string | null {
  if (requested && requested.trim() !== '') {
    const resolved = resolveModel(agent, version, requested);
    return resolved.canonical ?? resolved.forwarded;
  }
  const catalog = getModelCatalog(agent, version);
  if (!catalog) return null;
  const def = catalog.models.find((m) => m.isDefault);
  return def?.id ?? null;
}

/** Where the model a given agent+version will actually run with came from. */
export type ConfiguredModelSource = 'run-default' | 'config' | 'cli-default';

export interface ConfiguredModel {
  /** The model id the agent will run with (e.g. `opus`, `gpt-5-codex`). */
  model: string;
  source: ConfiguredModelSource;
}

/**
 * The model a given agent+version is actually configured to use right now, with
 * where that selection comes from. First hit wins:
 *   1. run-default — the user's agents-cli `run.defaults` in agents.yaml
 *   2. config      — the agent's OWN native settings.json `model` field
 *   3. cli-default — the CLI's built-in default: the catalog's `isDefault` model
 *                    if one is flagged (e.g. Kimi), otherwise the literal
 *                    `default` for a model-capable agent whose runtime picks its
 *                    own default (Claude/Codex don't flag one — Claude's own UI
 *                    calls this "Default").
 * Each layer is a real source the agent consults; `version` must be concrete.
 * Returns null only when the agent exposes no model catalog at all.
 */
export function resolveConfiguredModel(agent: AgentId, version: string): ConfiguredModel | null {
  const runModel = resolveRunDefaults(agent, version).model;
  if (runModel && runModel.trim() !== '') return { model: runModel, source: 'run-default' };

  const nativeModel = readNativeConfigModel(agent, version);
  if (nativeModel) return { model: nativeModel, source: 'config' };

  // The agent's own persisted selection, for a runtime that stores one instead
  // of flagging a catalog default. Ranks below `config` (an explicit setting
  // wins) and above the catalog, whose `isDefault` OpenCode never sets.
  const selected = readNativeSelectedModel(agent, version);
  if (selected) return { model: selected, source: 'cli-default' };

  const catalog = getModelCatalog(agent, version);
  if (catalog) {
    const flagged = catalog.models.find((m) => m.isDefault);
    return { model: flagged?.id ?? 'default', source: 'cli-default' };
  }

  return null;
}

/** An agent's own config document, for agents whose `model` is not in settings.json. */
interface NativeModelConfig {
  /** Accepted spellings under a version home, in precedence order. */
  paths: (home: string) => string[];
  /** Whether the harness's own loader tolerates comments in these files. */
  jsonc: boolean;
}

/**
 * Where each agent keeps its OWN `model` setting, when that is not the
 * `<configDir>/settings.json` every Claude-shaped harness uses.
 *
 * OpenCode reads `~/.config/opencode/opencode.{jsonc,json}` and puts `model` at
 * its top level as `"<provider>/<model-id>"`. Its `~/.opencode/settings.json`
 * DOES exist, but that is agents-cli's own plugin-enablement file, which
 * OpenCode never reads a model from — so the default path found nothing and
 * every OpenCode row rendered the placeholder `default`. Comments are stripped
 * for BOTH spellings because OpenCode's loader accepts them in both, which is
 * also how the MCP writer treats the same file (`format: 'opencode-jsonc'`).
 */
const NATIVE_MODEL_CONFIGS: Partial<Record<AgentId, NativeModelConfig>> = {
  opencode: {
    paths: (home) => [
      path.join(home, '.config', 'opencode', 'opencode.jsonc'),
      path.join(home, '.config', 'opencode', 'opencode.json'),
    ],
    jsonc: true,
  },
};

/**
 * Best-effort read of the agent's own `model` from its native config
 * (e.g. `~/.agents/.history/versions/claude/<ver>/home/.claude/settings.json`).
 * A missing/malformed file is a fall-through, not an error.
 */
function readNativeConfigModel(agent: AgentId, version: string): string | null {
  const home = getVersionHomePath(agent, version);
  const native = NATIVE_MODEL_CONFIGS[agent];
  const candidates = native?.paths(home)
    ?? [path.join(home, agentConfigDirName(agent), 'settings.json')];
  for (const configPath of candidates) {
    try {
      const raw = fs.readFileSync(configPath, 'utf8');
      const parsed = JSON.parse(native?.jsonc ? stripJsonComments(raw) : raw) as { model?: unknown };
      if (typeof parsed.model === 'string' && parsed.model.trim() !== '') return parsed.model;
    } catch {
      /* absent or malformed — try the next spelling */
    }
  }
  return null;
}

/**
 * The model the agent's OWN runtime will start with, for a harness that persists
 * its selection rather than flagging a catalog default.
 *
 * OpenCode is the case that needs it: it ships no default model, so its catalog
 * has no `isDefault` and `agents view` fell through to the literal `default` —
 * a placeholder, not something the user could act on. OpenCode instead records
 * the model picked in its TUI to `$XDG_STATE_HOME/opencode/model.json` as
 * `{ recent: [{ providerID, modelID }, …] }`, newest first, and reuses
 * `recent[0]` for the next session. That entry is the real answer to "what model
 * is this install on", rendered the same `<provider>/<model-id>` way OpenCode's
 * own config spells it.
 *
 * Returns null for every other agent, and for OpenCode when nothing has been
 * selected yet — the catalog fallback still applies.
 */
function readNativeSelectedModel(agent: AgentId, version: string): string | null {
  if (agent !== 'opencode') return null;
  const statePath = resolveOpenCodeXdgPath(getVersionHomePath(agent, version), 'state', 'model.json');
  if (!statePath) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(statePath, 'utf8')) as {
      recent?: Array<{ providerID?: unknown; modelID?: unknown }>;
    };
    const current = parsed.recent?.[0];
    const provider = typeof current?.providerID === 'string' ? current.providerID : '';
    const model = typeof current?.modelID === 'string' ? current.modelID : '';
    if (!model) return null;
    return provider ? `${provider}/${model}` : model;
  } catch {
    return null;
  }
}

/**
 * Join the identity cluster — `agent@version · model · account` — with a dim
 * separator, dropping empty pieces. Pieces are pre-colored by the caller so the
 * same cluster reads identically across `view`, `use`, `add`, and `status`.
 */
export function formatAgentIdentity(...parts: Array<string | null | undefined>): string {
  return parts.filter((p): p is string => !!p && p.length > 0).join(` ${chalk.gray('·')} `);
}

/** Find the closest matching model ids/aliases using edit distance. */
function pickSuggestions(requested: string, catalog: ModelCatalog): string[] {
  const all = [...catalog.models.map((m) => m.id), ...Object.keys(catalog.aliases)];
  return all
    .map((id) => ({ id, score: similarity(requested, id) }))
    .filter((s) => s.score > 0.5)
    .sort((a, b) => b.score - a.score)
    .slice(0, 3)
    .map((s) => s.id);
}

/** Normalized Levenshtein similarity (0..1, where 1 is identical). */
function similarity(a: string, b: string): number {
  const longer = a.length >= b.length ? a : b;
  const shorter = a.length >= b.length ? b : a;
  if (longer.length === 0) return 1;
  const distance = levenshtein(longer, shorter);
  return (longer.length - distance) / longer.length;
}

/** Standard Levenshtein edit distance between two strings. */
function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  const dp: number[][] = Array(m + 1)
    .fill(null)
    .map(() => Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = a[i - 1] === b[j - 1]
        ? dp[i - 1][j - 1]
        : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
    }
  }
  return dp[m][n];
}

/**
 * Build the per-agent CLI flags for a unified reasoning effort knob.
 *
 * Both Claude (`--effort`) and Codex (`-c model_reasoning_effort=...`) expose a
 * reasoning intensity dial. Inputs accepted: low | medium | high | xhigh | max | auto.
 * - Codex only supports low/medium/high; xhigh and max are clamped to high.
 * - 'auto' skips reasoning flags for codex (lets it use model default).
 * - 'auto' passes --effort auto to claude if supported.
 */
export function buildReasoningFlags(agent: AgentId, level: string): string[] {
  const normalized = level.toLowerCase();
  if (normalized === 'auto') {
    // For claude, forward --effort auto if the agent supports it
    // For codex and others, omit (let agent use its default)
    return agent === 'claude' ? ['--effort', 'auto'] : [];
  }
  if (agent === 'claude') {
    return ['--effort', normalized];
  }
  if (agent === 'codex') {
    const codexLevel = (normalized === 'xhigh' || normalized === 'max') ? 'high' : normalized;
    return ['-c', `model_reasoning_effort=${codexLevel}`];
  }
  if (agent === 'droid') {
    // Droid: `-r off|none|low|medium|high`. xhigh/max clamp to high.
    const droidLevel = (normalized === 'xhigh' || normalized === 'max') ? 'high' : normalized;
    return ['-r', droidLevel];
  }
  if (agent === 'grok') {
    // Grok: `--reasoning-effort <low|medium|high>` (alias --effort). xhigh/max
    // clamp to high. This is the effort dial cost tiers steer for Grok, whose
    // catalog exposes a single model.
    const grokLevel = (normalized === 'xhigh' || normalized === 'max') ? 'high' : normalized;
    return ['--reasoning-effort', grokLevel];
  }
  if (agent === 'muse') {
    // Muse Code: `--reasoning-effort none|minimal|low|medium|high|xhigh|ultra`.
    // Map our unified `max` to Muse's `ultra` (client-side multi-agent aggression).
    const museLevel = normalized === 'max' ? 'ultra' : normalized;
    return ['--reasoning-effort', museLevel];
  }
  return [];
}
