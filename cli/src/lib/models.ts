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

export interface ModelPerCloud {
  firstParty: string;
  bedrock?: string;
  vertex?: string;
  foundry?: string;
  anthropicAws?: string;
  mantle?: string | null;
}

export interface ReasoningLevel {
  effort: string;
  description?: string;
}

export interface ModelInfo {
  id: string;
  displayName?: string;
  description?: string;
  alias?: string;
  isDefault?: boolean;
  perCloud?: ModelPerCloud;
  reasoningLevels?: ReasoningLevel[];
  defaultReasoningLevel?: string;
  pricing?: ModelPricing;
}

export interface ModelCatalog {
  agent: AgentId;
  version: string;
  source: ModelSourceKind;
  sourcePath: string;
  models: ModelInfo[];
  aliases: Record<string, string>;
}

const CACHE_PATH = getModelsCachePath();

const CACHE_SCHEMA_VERSION = 4;

const EMPTY_CATALOG_RETRY_MS = 24 * 60 * 60 * 1000;

interface CacheEntry {
  sourcePath: string;
  mtime: number;
  catalog: ModelCatalog;
  attemptedAt?: number;
}

interface CacheFile {
  schema: number;
  entries: Record<string, CacheEntry>;
}

let memoryCache: CacheFile | null = null;

function cacheKey(agent: AgentId, version: string): string {
  return `${agent}@${version}`;
}

function loadCache(): CacheFile {
  if (memoryCache) return memoryCache;
  try {
    const raw = JSON.parse(fs.readFileSync(CACHE_PATH, 'utf-8'));
    if (raw && raw.schema === CACHE_SCHEMA_VERSION && raw.entries) {
      memoryCache = raw as CacheFile;
    } else {
      memoryCache = { schema: CACHE_SCHEMA_VERSION, entries: {} };
    }
  } catch {
    memoryCache = { schema: CACHE_SCHEMA_VERSION, entries: {} };
  }
  return memoryCache!;
}

function saveCache(): void {
  if (!memoryCache) return;
  try {
    const dir = path.dirname(CACHE_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(CACHE_PATH, JSON.stringify(memoryCache));
  } catch {
  }
}

export type ModelSourceKind = 'bundle' | 'binary' | 'cli';

export interface ModelSource {
  path: string;
  kind: ModelSourceKind;
}

export function locateModelSource(
  agent: AgentId,
  version: string
): ModelSource | null {
  const versionDir = getVersionDir(agent, version);

  if (agent === 'claude') {
    const bundle = path.join(versionDir, 'node_modules', '@anthropic-ai', 'claude-code', 'cli.js');
    if (fs.existsSync(bundle)) return { path: bundle, kind: 'bundle' };
    const bin = path.join(versionDir, 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe');
    if (fs.existsSync(bin)) return { path: bin, kind: 'binary' };
    return null;
  }

  if (agent === 'codex') {
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

  if (agent === 'opencode') {
    const cli = path.join(versionDir, 'node_modules', '.bin', 'opencode');
    if (fs.existsSync(cli)) return { path: cli, kind: 'cli' };
    return null;
  }

  if (agent === 'openclaw') {
    const cli = path.join(versionDir, 'node_modules', '.bin', 'openclaw');
    if (fs.existsSync(cli)) return { path: cli, kind: 'cli' };
    const pathBin = findOnPath('openclaw');
    if (pathBin) return { path: pathBin, kind: 'cli' };
    return null;
  }

  if (agent === 'antigravity') {
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
    }
    return null;
  }

  if (agent === 'cursor') {
    const pathBin = findOnPath('cursor-agent');
    if (pathBin) return { path: pathBin, kind: 'cli' };
    return null;
  }

  if (agent === 'muse') {
    const pathBin = findOnPath('muse');
    if (pathBin) return { path: pathBin, kind: 'cli' };
    return null;
  }

  return null;
}

function isUsableGrokBinary(filePath: string): boolean {
  try {
    const st = fs.statSync(filePath);
    return st.isFile() && st.size > 1024 * 1024;
  } catch {
    return false;
  }
}

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
      }
    }
  }
  return null;
}

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

function extractStrings(filePath: string, minLen = 6): string {
  const buf = fs.readFileSync(filePath);
  const out: string[] = [];
  let run: number[] = [];
  for (let i = 0; i < buf.length; i++) {
    const b = buf[i];
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

export function dropBareLegacyIds(ids: string[]): string[] {
  // Drop only a dash-boundary prefix with a longer sibling; unrelated IDs remain valid.
  return ids.filter(
    (id) => !ids.some((other) => other !== id && other.startsWith(`${id}-`)),
  );
}

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

  let models = build([
    ...Object.values(aliases),
    ...Object.keys(displayNames),
    ...Object.keys(perCloud),
  ]);

  if (models.length < 2) {
    const filtered = scanClaudeCatalogIds(text);
    if (filtered.length >= 2) models = build(filtered);
  }

  return { models, aliases };
}

function extractCodexCatalog(text: string): { models: ModelInfo[]; aliases: Record<string, string> } {
  const models: ModelInfo[] = [];
  const seen = new Set<string>();

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

  const lines = stdout.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!/^[a-z0-9][a-z0-9.-]*\/[^\s]+$/i.test(line)) continue;
    const fullKey = line;
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
      const nonDefaultStatus = obj.status && obj.status !== 'active' ? obj.status : undefined;
      models.push({
        id: fullKey,
        displayName: obj.name,
        description: nonDefaultStatus,
      });
    } catch {
    }
    i = end;
  }

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
    }
  }

  return { models, aliases: {} };
}

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

  // eslint-disable-next-line no-control-regex
  const plain = stdout.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');
  const models: ModelInfo[] = [];
  const seen = new Set<string>();

  for (const raw of plain.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
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

  // eslint-disable-next-line no-control-regex
  const plain = stdout.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');
  const models: ModelInfo[] = [];
  const seen = new Set<string>();

  for (const raw of plain.split('\n')) {
    const name = raw.trim();
    if (!name) continue;
    if (!/^[A-Za-z0-9].*\([^)]+\)\s*$/.test(name)) continue;
    if (seen.has(name)) continue;
    seen.add(name);
    models.push({
      id: name,
      displayName: name,
      isDefault: models.length === 0,
    });
  }

  return { models, aliases: {} };
}

export function parseGrokModelsStdout(stdout: string): { models: ModelInfo[]; aliases: Record<string, string> } {
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
    const m = line.match(/^\*?\s*([A-Za-z0-9][A-Za-z0-9._-]*)(?:\s+\(([^)]*)\))?\s*$/);
    if (!m) continue;
    const id = m[1];
    if (!/^grok[-_]/i.test(id) && id !== defaultId) continue;
    if (seen.has(id)) continue;
    seen.add(id);
    const flags = (m[2] ?? '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
    models.push({
      id,
      isDefault: (defaultId != null && id === defaultId) || flags.includes('default'),
    });
  }

  if (defaultId && !seen.has(defaultId)) {
    models.unshift({ id: defaultId, isDefault: true });
  }

  if (defaultId) {
    for (const model of models) model.isDefault = model.id === defaultId;
  } else if (models.length > 0 && !models.some((model) => model.isDefault)) {
    models[0].isDefault = true;
  }

  return { models, aliases: {} };
}

function extractGrokCatalog(binaryPath: string): { models: ModelInfo[]; aliases: Record<string, string> } {
  const env = { ...process.env };
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

  cache.entries[key] = { sourcePath: src.path, mtime, catalog, attemptedAt: Date.now() };
  saveCache();
  return catalog;
}

export interface ResolvedModel {
  forwarded: string;
  canonical?: string;
  warning?: string;
}

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

  const stripped = requested.replace(/\[[^\]]+\]$/, '');
  if (knownIds.has(stripped)) {
    return { forwarded: requested, canonical: requested };
  }

  // Catalogs are advisory: new provider model IDs must pass through unchanged.
  const suggestions = pickSuggestions(requested, catalog);
  const hint = suggestions.length > 0 ? ` (closest: ${suggestions.join(', ')})` : '';
  return {
    forwarded: requested,
    warning: `model "${requested}" not in known catalog for ${agent}@${version}; forwarding as-is${hint}`,
  };
}

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

export type ConfiguredModelSource = 'run-default' | 'config' | 'cli-default';

export interface ConfiguredModel {
  model: string;
  source: ConfiguredModelSource;
}

export function resolveConfiguredModel(agent: AgentId, version: string, home?: string): ConfiguredModel | null {
  // Precedence is explicit run default, native config, native selection, then catalog default.
  const runModel = resolveRunDefaults(agent, version).model;
  if (runModel && runModel.trim() !== '') return { model: runModel, source: 'run-default' };

  const nativeModel = readNativeConfigModel(agent, version, home);
  if (nativeModel) return { model: nativeModel, source: 'config' };

  const selected = readNativeSelectedModel(agent, version);
  if (selected) return { model: selected, source: 'cli-default' };

  const catalog = getModelCatalog(agent, version);
  if (catalog) {
    const flagged = catalog.models.find((m) => m.isDefault);
    return { model: flagged?.id ?? 'default', source: 'cli-default' };
  }

  return null;
}

interface NativeModelConfig {
  paths: (home: string) => string[];
  jsonc: boolean;
}

const NATIVE_MODEL_CONFIGS: Partial<Record<AgentId, NativeModelConfig>> = {
  opencode: {
    paths: (home) => [
      path.join(home, '.config', 'opencode', 'opencode.jsonc'),
      path.join(home, '.config', 'opencode', 'opencode.json'),
    ],
    jsonc: true,
  },
};

function readNativeConfigModel(agent: AgentId, version: string, home?: string): string | null {
  const resolvedHome = home ?? getVersionHomePath(agent, version);
  const native = NATIVE_MODEL_CONFIGS[agent];
  const candidates = native?.paths(resolvedHome)
    ?? [path.join(resolvedHome, agentConfigDirName(agent), 'settings.json')];
  for (const configPath of candidates) {
    try {
      const raw = fs.readFileSync(configPath, 'utf8');
      const parsed = JSON.parse(native?.jsonc ? stripJsonComments(raw) : raw) as { model?: unknown };
      if (typeof parsed.model === 'string' && parsed.model.trim() !== '') return parsed.model;
    } catch {
    }
  }
  return null;
}

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

export function formatAgentIdentity(...parts: Array<string | null | undefined>): string {
  return parts.filter((p): p is string => !!p && p.length > 0).join(` ${chalk.gray('·')} `);
}

function pickSuggestions(requested: string, catalog: ModelCatalog): string[] {
  const all = [...catalog.models.map((m) => m.id), ...Object.keys(catalog.aliases)];
  return all
    .map((id) => ({ id, score: similarity(requested, id) }))
    .filter((s) => s.score > 0.5)
    .sort((a, b) => b.score - a.score)
    .slice(0, 3)
    .map((s) => s.id);
}

function similarity(a: string, b: string): number {
  const longer = a.length >= b.length ? a : b;
  const shorter = a.length >= b.length ? b : a;
  if (longer.length === 0) return 1;
  const distance = levenshtein(longer, shorter);
  return (longer.length - distance) / longer.length;
}

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

export function buildReasoningFlags(agent: AgentId, level: string): string[] {
  const normalized = level.toLowerCase();
  if (normalized === 'auto') {
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
    const droidLevel = (normalized === 'xhigh' || normalized === 'max') ? 'high' : normalized;
    return ['-r', droidLevel];
  }
  if (agent === 'grok') {
    const grokLevel = (normalized === 'xhigh' || normalized === 'max') ? 'high' : normalized;
    return ['--reasoning-effort', grokLevel];
  }
  if (agent === 'muse') {
    const museLevel = normalized === 'max' ? 'ultra' : normalized;
    return ['--reasoning-effort', museLevel];
  }
  return [];
}
