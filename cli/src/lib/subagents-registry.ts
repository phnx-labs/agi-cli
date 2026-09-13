/**
 * Declarative subagent-target registry.
 *
 * Each subagents-capable agent gets ONE table entry (`SUBAGENT_TARGETS`)
 * describing how a central subagent (`~/.agents/subagents/<name>/`) is
 * materialized into that agent's home, how it is enumerated, and where it lives
 * on disk. Generic install / list / detect / orphan / remove logic iterates the
 * table instead of the near-identical `else if (agent === '...')` chains that
 * used to be copy-pasted across `subagents.ts`, the staleness writer, and the
 * staleness detector -- roughly O(agents x operations) arms.
 *
 * Adding a *standard* integration is now one line here (plus the `subagents`
 * capability flag in `agents.ts`, the version gate). Three layout builders cover
 * every current agent, so most entries are a single call:
 *
 *   - `flatFile`  one `<name><ext>` file, body from a `transform` fn.
 *                 (claude, grok, pi, droid, codex, opencode, copilot,
 *                  cursor, goose, kimi)
 *   - `dirFile`   a `<name>/` directory holding one generated `<file>`.
 *                 (antigravity: `<name>/agent.md`)
 *   - `dirCopy`   copy the whole source directory to `<name>/`, applying
 *                 renames, detected by a `marker` file. (openclaw)
 *
 * Every agent now uses a builder; there are no bespoke handlers left. Legacy
 * on-disk layouts are folded once by `lib/migrate.ts`, never by a target --
 * a target describes the CURRENT shape and nothing else.
 *
 * The per-agent `transform`/metadata parsers are the escape hatch: they live in
 * `subagents.ts` and are referenced by the table, so the generic engine has zero
 * per-agent branches. See `docs/orchestration.md`.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as TOML from 'smol-toml';
import * as yaml from 'yaml';
import type { AgentId, InstalledSubagent, SubagentFrontmatter } from './types.js';
import { safeJoin } from './paths.js';
import { filesContentMatch, normalizeResourceContent } from './resource-content-diff.js';
import {
  parseSubagentFrontmatter,
  transformSubagentForClaude,
  transformSubagentForCodex,
  transformSubagentForCopilot,
  transformSubagentForCursor,
  transformSubagentForDroid,
  transformSubagentForGoose,
  transformSubagentForOpenCode,
  transformSubagentForAntigravity,
} from './subagents.js';

/** A path an installed subagent occupies, tagged for removal/trash handling. */
interface OccupiedEntry {
  path: string;
  kind: 'file' | 'dir';
}

/** Parsed metadata for one installed subagent (drives the rich listing). */
interface SubagentMeta {
  frontmatter: SubagentFrontmatter;
  files: string[];
  /** Primary on-disk path for the listing's `path` field (a file or a dir, per layout). */
  path: string;
}

/**
 * The complete on-disk contract for one agent's subagents. Every operation is
 * expressed here so the engine below never branches on the agent id.
 */
interface SubagentTarget {
  /** Absolute container dir under a home root (a version home or an agent home). */
  dir(home: string): string;
  /** Materialize central subagent `sub` into container `dir`. Throws on fs error. */
  write(dir: string, sub: { name: string; path: string }): void;
  /** Installed subagent names in `dir` (detector + orphan diff). */
  names(dir: string): string[];
  /** On-disk paths subagent `name` occupies (for removal / soft-delete). */
  occupied(dir: string, name: string): OccupiedEntry[];
  /** Rich metadata for `name`; `null` skips it from the listing. */
  read(dir: string, name: string): SubagentMeta | null;
  /**
   * True when the installed subagent `sub` in `dir` byte-matches what `write`
   * would materialize from `sub.path` NOW — the content-drift check `agents
   * doctor` uses. Re-renders the CURRENT source through the same transform the
   * writer uses (never a stored hash), so a prompt-body edit to the source
   * surfaces as drift even though the filename is unchanged.
   */
  matches(dir: string, sub: { name: string; path: string }): boolean;
}

/** Read a file's UTF-8 content, or null when it is missing/unreadable. */
function readFileSafe(filePath: string): string | null {
  try {
    return fs.readFileSync(filePath, 'utf-8');
  } catch {
    return null;
  }
}

// ── metadata readers (the per-format escape hatch) ───────────────────────────

/** Frontmatter, skipping files that lack a valid block (claude/grok/droid). */
function metaFrontmatterSkip(filePath: string): SubagentFrontmatter | null {
  return parseSubagentFrontmatter(filePath);
}

/** Frontmatter, falling back to an empty description (opencode/copilot/cursor). */
function metaFrontmatterFallback(filePath: string, name: string): SubagentFrontmatter {
  return parseSubagentFrontmatter(filePath) ?? { name, description: '' };
}

function metaJson(filePath: string, name: string): SubagentFrontmatter | null {
  try {
    const cfg = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as {
      name?: string;
      description?: string;
      model?: string;
    };
    return { name: cfg.name || name, description: cfg.description || '', model: cfg.model };
  } catch {
    return null;
  }
}

/** Goose recipe YAML: title -> name, description; skip on parse error. */
function metaGooseYaml(filePath: string, name: string): SubagentFrontmatter | null {
  try {
    const recipe = yaml.parse(fs.readFileSync(filePath, 'utf-8')) as {
      title?: string;
      description?: string;
    } | null;
    return { name: recipe?.title || name, description: recipe?.description || '' };
  } catch {
    return null;
  }
}

/**
 * Codex custom-agent TOML: name / description / model (optional).
 * Codex writes no YAML frontmatter — without this reader, `flatFile.read`
 * drops every installed `.toml` and `agents subagents list` reports codex
 * targets as `missing` even when the files are present and Codex loads them.
 */
function metaToml(filePath: string, name: string): SubagentFrontmatter | null {
  try {
    const cfg = TOML.parse(fs.readFileSync(filePath, 'utf-8')) as {
      name?: unknown;
      description?: unknown;
      model?: unknown;
    };
    const tomlName = typeof cfg.name === 'string' ? cfg.name : '';
    const description = typeof cfg.description === 'string' ? cfg.description : '';
    const model = typeof cfg.model === 'string' ? cfg.model : undefined;
    return { name: tomlName || name, description, model };
  } catch {
    return null;
  }
}

// ── shared fs primitive ──────────────────────────────────────────────────────

/**
 * Copy every file in `src` into `dest` (created if missing), applying
 * `rename` (source filename -> target filename) on the way. Directories in
 * `src` are skipped -- subagents are flat file sets. Throws on fs error.
 */
export function copyDirWithRename(
  src: string,
  dest: string,
  rename?: Record<string, string>,
): void {
  if (!fs.existsSync(dest)) {
    fs.mkdirSync(dest, { recursive: true });
  }
  for (const file of fs.readdirSync(src)) {
    const sourcePath = path.join(src, file);
    if (!fs.statSync(sourcePath).isFile()) continue;
    const targetName = rename?.[file] ?? file;
    fs.copyFileSync(sourcePath, path.join(dest, targetName));
  }
}

// ── layout builders ──────────────────────────────────────────────────────────

/** One flattened `<name><ext>` file per subagent under `subdir`. */
function flatFile(opts: {
  subdir: string[];
  ext: string;
  transform: (subagentDir: string) => string;
  /** Metadata reader; defaults to frontmatter-with-skip. */
  readMeta?: (filePath: string, name: string) => SubagentFrontmatter | null;
}): SubagentTarget {
  const readMeta = opts.readMeta ?? metaFrontmatterSkip;
  return {
    dir: (home) => path.join(home, ...opts.subdir),
    write(dir, sub) {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(safeJoin(dir, `${sub.name}${opts.ext}`), opts.transform(sub.path));
    },
    names(dir) {
      if (!fs.existsSync(dir)) return [];
      return fs
        .readdirSync(dir)
        .filter((f) => f.endsWith(opts.ext))
        .map((f) => f.slice(0, -opts.ext.length));
    },
    occupied(dir, name) {
      return [{ path: safeJoin(dir, `${name}${opts.ext}`), kind: 'file' }];
    },
    read(dir, name) {
      const filePath = path.join(dir, `${name}${opts.ext}`);
      if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) return null;
      const frontmatter = readMeta(filePath, name);
      if (!frontmatter) return null;
      return { frontmatter, files: [`${name}${opts.ext}`], path: filePath };
    },
    matches(dir, sub) {
      const filePath = path.join(dir, `${sub.name}${opts.ext}`);
      const installed = readFileSafe(filePath);
      if (installed == null) return false;
      return normalizeResourceContent(installed) === normalizeResourceContent(opts.transform(sub.path));
    },
  };
}

/** A `<name>/` directory holding one generated `<file>` per subagent. */
function dirFile(opts: {
  subdir: string[];
  file: string;
  transform: (subagentDir: string) => string;
  readMeta?: (filePath: string, name: string) => SubagentFrontmatter | null;
}): SubagentTarget {
  const readMeta = opts.readMeta ?? ((p: string, name: string) => metaFrontmatterFallback(p, name));
  return {
    dir: (home) => path.join(home, ...opts.subdir),
    write(dir, sub) {
      const target = safeJoin(dir, sub.name);
      fs.mkdirSync(target, { recursive: true });
      fs.writeFileSync(safeJoin(target, opts.file), opts.transform(sub.path));
    },
    names(dir) {
      if (!fs.existsSync(dir)) return [];
      return fs
        .readdirSync(dir, { withFileTypes: true })
        .filter((e) => e.isDirectory() && fs.existsSync(path.join(dir, e.name, opts.file)))
        .map((e) => e.name);
    },
    occupied(dir, name) {
      return [{ path: safeJoin(dir, name), kind: 'dir' }];
    },
    read(dir, name) {
      const filePath = path.join(dir, name, opts.file);
      if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) return null;
      const frontmatter = readMeta(filePath, name);
      if (!frontmatter) return null;
      return { frontmatter, files: [opts.file], path: filePath };
    },
    matches(dir, sub) {
      const filePath = path.join(dir, sub.name, opts.file);
      const installed = readFileSafe(filePath);
      if (installed == null) return false;
      return normalizeResourceContent(installed) === normalizeResourceContent(opts.transform(sub.path));
    },
  };
}

/** Copy the whole source directory to `<name>/`, detected by `marker`. */
function dirCopy(opts: {
  subdir: string[];
  marker: string;
  rename?: Record<string, string>;
}): SubagentTarget {
  return {
    dir: (home) => path.join(home, ...opts.subdir),
    write(dir, sub) {
      copyDirWithRename(sub.path, safeJoin(dir, sub.name), opts.rename);
    },
    names(dir) {
      if (!fs.existsSync(dir)) return [];
      return fs
        .readdirSync(dir, { withFileTypes: true })
        .filter((d) => d.isDirectory() && fs.existsSync(path.join(dir, d.name, opts.marker)))
        .map((d) => d.name);
    },
    occupied(dir, name) {
      return [{ path: safeJoin(dir, name), kind: 'dir' }];
    },
    read(dir, name) {
      const markerPath = path.join(dir, name, opts.marker);
      if (!fs.existsSync(markerPath)) return null;
      // The marker may lack frontmatter; fall back to the first content line.
      let frontmatter: SubagentFrontmatter = { name, description: '' };
      const parsed = parseSubagentFrontmatter(markerPath);
      if (parsed) {
        frontmatter = parsed;
      } else {
        const content = fs.readFileSync(markerPath, 'utf-8');
        const firstLine = content.split('\n').find((l) => l.trim() && !l.startsWith('#'));
        frontmatter.description = firstLine?.slice(0, 80) || `${name}`;
      }
      const subagentDir = path.join(dir, name);
      const files = fs
        .readdirSync(subagentDir)
        .filter((f) => f.endsWith('.md'))
        .sort();
      return { frontmatter, files, path: subagentDir };
    },
    matches(dir, sub) {
      // dirCopy materializes every source file (with rename) into <dir>/<name>/.
      // Re-derive the expected file set from source and byte-compare each, so an
      // edit to any copied file — or an added/removed source file — is drift.
      const dest = path.join(dir, sub.name);
      let sourceFiles: string[];
      try {
        sourceFiles = fs.readdirSync(sub.path).filter((f) => {
          try { return fs.statSync(path.join(sub.path, f)).isFile(); } catch { return false; }
        });
      } catch {
        return false;
      }
      const expectedDestNames = new Set<string>();
      for (const file of sourceFiles) {
        const destName = opts.rename?.[file] ?? file;
        expectedDestNames.add(destName);
        if (!filesContentMatch(path.join(sub.path, file), path.join(dest, destName))) return false;
      }
      // An extra file left in the installed dir (source file removed) is drift.
      let destFiles: string[];
      try {
        destFiles = fs.readdirSync(dest).filter((f) => {
          try { return fs.statSync(path.join(dest, f)).isFile(); } catch { return false; }
        });
      } catch {
        return false;
      }
      return destFiles.every((f) => expectedDestNames.has(f));
    },
  };
}

// ── the registry ─────────────────────────────────────────────────────────────

/**
 * Single source of truth for how each subagents-capable agent stores subagents.
 * The keys MUST match `capableAgents('subagents')` (the `subagents` flag in
 * `agents.ts`): the capability flag is the version gate, this table is the shape.
 */
export const SUBAGENT_TARGETS: Partial<Record<AgentId, SubagentTarget>> = {
  // Tier 1 -- flat markdown, Claude-compatible flatten.
  claude: flatFile({ subdir: ['.claude', 'agents'], ext: '.md', transform: transformSubagentForClaude }),
  grok: flatFile({ subdir: ['.grok', 'agents'], ext: '.md', transform: transformSubagentForClaude }),
  droid: flatFile({ subdir: ['.factory', 'droids'], ext: '.md', transform: transformSubagentForDroid }),
  // Bespoke frontmatter/format, still one flat file.
  codex: flatFile({
    subdir: ['.codex', 'agents'],
    ext: '.toml',
    transform: transformSubagentForCodex,
    readMeta: metaToml,
  }),
  opencode: flatFile({
    subdir: ['.config', 'opencode', 'agents'],
    ext: '.md',
    transform: transformSubagentForOpenCode,
    readMeta: metaFrontmatterFallback,
  }),
  copilot: flatFile({
    subdir: ['.copilot', 'agents'],
    ext: '.agent.md',
    transform: transformSubagentForCopilot,
    readMeta: metaFrontmatterFallback,
  }),
  cursor: flatFile({
    subdir: ['.cursor', 'agents'],
    ext: '.md',
    transform: transformSubagentForCursor,
    readMeta: metaFrontmatterFallback,
  }),
  goose: flatFile({
    subdir: ['.config', 'goose', 'agents'],
    ext: '.yaml',
    transform: transformSubagentForGoose,
    readMeta: metaGooseYaml,
  }),
  // Directory layouts.
  antigravity: dirFile({
    subdir: ['.gemini', 'config', 'agents'],
    file: 'agent.md',
    transform: transformSubagentForAntigravity,
  }),
  openclaw: dirCopy({ subdir: ['.openclaw'], marker: 'AGENTS.md', rename: { 'AGENT.md': 'AGENTS.md' } }),
  // Kimi discovers Claude-shaped agent markdown from its brand home's `agents/`
  // dir (`USER_BRAND_DIRS = ["agents"]`, kimi-code >= 0.29.0). Frontmatter
  // name/description + body, kebab-case name -- the same shape as claude/grok.
  // The pre-markdown files agents-cli used to write here are swept once by
  // `migrateKimiSubagentsToMarkdown` (lib/migrate.ts), not by this target.
  kimi: flatFile({ subdir: ['.kimi-code', 'agents'], ext: '.md', transform: transformSubagentForClaude, readMeta: metaFrontmatterFallback }),
};

/** The registry entry for `agent`, or undefined if it stores no subagents. */
export function subagentTarget(agent: AgentId): SubagentTarget | undefined {
  return SUBAGENT_TARGETS[agent];
}

// ── generic engine (zero per-agent branches) ─────────────────────────────────

/**
 * Materialize central subagent `sub` into `home` for `agent`. Returns whether a
 * write happened (false when the agent has no registry entry). Throws only on
 * unexpected fs errors -- bulk callers wrap per-item.
 */
export function writeSubagentToHome(
  agent: AgentId,
  home: string,
  sub: { name: string; path: string },
): boolean {
  const target = SUBAGENT_TARGETS[agent];
  if (!target) return false;
  target.write(target.dir(home), sub);
  return true;
}

/** Installed subagent names for `agent` under `home` (detector + orphan diff). */
export function listInstalledSubagentNames(agent: AgentId, home: string): string[] {
  const target = SUBAGENT_TARGETS[agent];
  if (!target) return [];
  return target.names(target.dir(home));
}

/**
 * True when subagent `name` installed for `agent` under `home` byte-matches what
 * the writer would produce NOW from `sourceDir` — the content-drift predicate
 * `agents doctor` uses. Returns false when the agent has no registry entry
 * (nothing could have been written) so an unexpected home copy reads as drift.
 */
export function subagentContentMatches(
  agent: AgentId,
  home: string,
  name: string,
  sourceDir: string,
): boolean {
  const target = SUBAGENT_TARGETS[agent];
  if (!target) return false;
  return target.matches(target.dir(home), { name, path: sourceDir });
}

/**
 * Rich listing of subagents installed for `agent` under `home`, with parsed
 * metadata. Enumerates names, then reads each -- entries whose metadata is
 * unreadable (per the target's reader) are dropped.
 */
export function listInstalledSubagentsRich(agent: AgentId, home: string): InstalledSubagent[] {
  const target = SUBAGENT_TARGETS[agent];
  if (!target) return [];
  const dir = target.dir(home);
  const out: InstalledSubagent[] = [];
  for (const name of target.names(dir)) {
    const meta = target.read(dir, name);
    if (!meta) continue;
    out.push({ name, path: meta.path, files: meta.files, frontmatter: meta.frontmatter });
  }
  return out;
}

/**
 * Remove subagent `name` for `agent` from `home` (hard delete). No-op success
 * when the agent has no registry entry or nothing is installed.
 */
export function removeSubagentFromHome(
  agent: AgentId,
  home: string,
  name: string,
): { success: boolean; error?: string } {
  const target = SUBAGENT_TARGETS[agent];
  if (!target) return { success: true };
  try {
    for (const entry of target.occupied(target.dir(home), name)) {
      if (!fs.existsSync(entry.path)) continue;
      if (entry.kind === 'dir') fs.rmSync(entry.path, { recursive: true, force: true });
      else fs.unlinkSync(entry.path);
    }
    return { success: true };
  } catch (err) {
    return { success: false, error: String(err) };
  }
}

/**
 * Soft-delete subagent `name` for `agent` from `home` into `trashDir`, stamping
 * each moved entry. Files land as `<basename>.<stamp>`, directories as
 * `<stamp>/`. No-op success when nothing is installed.
 */
export function trashSubagentFromHome(
  agent: AgentId,
  home: string,
  name: string,
  trashDir: string,
  stamp: string,
): { success: boolean; error?: string } {
  const target = SUBAGENT_TARGETS[agent];
  if (!target) return { success: true };
  try {
    const present = target.occupied(target.dir(home), name).filter((e) => fs.existsSync(e.path));
    if (present.length > 0) {
      fs.mkdirSync(trashDir, { recursive: true, mode: 0o700 });
      for (const entry of present) {
        const dest =
          entry.kind === 'dir'
            ? path.join(trashDir, stamp)
            : path.join(trashDir, `${path.basename(entry.path)}.${stamp}`);
        fs.renameSync(entry.path, dest);
      }
    }
    return { success: true };
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
}
