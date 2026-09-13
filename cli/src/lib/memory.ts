/**
 * Canonical agent memory resource — accumulated facts/preferences/knowledge
 * distinct from `rules` (instructions / AGENTS.md persona).
 *
 * Layout (project > user > system layering):
 *   ~/.agents/memory/MEMORY.md          always-read index
 *   ~/.agents/memory/<slug>.md          individual facts
 *   ~/.agents/.system/memory/           system layer
 *   <project>/.agents/memory/           project layer
 *
 * Sync fans out into each capable agent's version home under an agent-specific
 * target dir (see memoryTargetDir).
 */

import * as fs from 'fs';
import * as path from 'path';
import type { AgentId } from './types.js';
import {
  getUserAgentsDir,
  getSystemAgentsDir,
  getProjectAgentsDir,
  ensureAgentsDir,
  getRuntimeStateDir,
} from './state.js';
import { agentConfigDirName } from './agents.js';
import { supports } from './capabilities.js';
import { claudeProjectDirName } from './project-key.js';

interface MemoryFact {
  /** Filename without .md (slug). */
  name: string;
  /** Absolute path to the fact file. */
  path: string;
  /** Layer that wins for this name. */
  layer: 'project' | 'user' | 'system';
  /** First non-empty line of the body (for list display). */
  summary: string;
}

interface MemoryLayerDir {
  layer: 'project' | 'user' | 'system';
  dir: string;
}

/** User-layer memory root (~/.agents/memory/). */
export function getUserMemoryDir(): string {
  return path.join(getUserAgentsDir(), 'memory');
}

/** System-layer memory root (~/.agents/.system/memory/). */
function getSystemMemoryDir(): string {
  return path.join(getSystemAgentsDir(), 'memory');
}

/** Project-layer memory root when a project agents dir exists. */
function getProjectMemoryDir(cwd: string = process.cwd()): string | null {
  const project = getProjectAgentsDir(cwd);
  return project ? path.join(project, 'memory') : null;
}

/** Ensure the user memory dir exists (creates MEMORY.md index if missing). */
export function ensureUserMemoryDir(): string {
  ensureAgentsDir();
  const dir = getUserMemoryDir();
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const index = path.join(dir, 'MEMORY.md');
  if (!fs.existsSync(index)) {
    fs.writeFileSync(
      index,
      [
        '# Memory index',
        '',
        'Always-read summary of accumulated agent memory. Individual facts live',
        'as sibling `*.md` files. Managed by `agents memory`.',
        '',
      ].join('\n'),
      'utf-8',
    );
  }
  return dir;
}

const RULE_FILE_NAMES = new Set(['memory.md', 'agents.md', 'claude.md', 'gemini.md', 'readme.md']);

function isFactFile(name: string): boolean {
  return name.endsWith('.md') && !RULE_FILE_NAMES.has(name.toLowerCase());
}

function slugify(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64) || 'fact';
}

function summarize(content: string): string {
  for (const line of content.split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    return t.length > 80 ? t.slice(0, 77) + '...' : t;
  }
  return '(empty)';
}

/** Layer dirs highest-priority first. */
function getMemoryLayerDirs(cwd: string = process.cwd()): MemoryLayerDir[] {
  const out: MemoryLayerDir[] = [];
  const project = getProjectMemoryDir(cwd);
  if (project && fs.existsSync(project)) out.push({ layer: 'project', dir: project });
  const user = getUserMemoryDir();
  if (fs.existsSync(user)) out.push({ layer: 'user', dir: user });
  const system = getSystemMemoryDir();
  if (fs.existsSync(system)) out.push({ layer: 'system', dir: system });
  return out;
}

/** List memory facts with project > user > system override on name. */
export function listMemoryFacts(cwd: string = process.cwd()): MemoryFact[] {
  const seen = new Set<string>();
  const results: MemoryFact[] = [];
  for (const { layer, dir } of getMemoryLayerDirs(cwd)) {
    let entries: string[] = [];
    try {
      entries = fs.readdirSync(dir);
    } catch {
      continue;
    }
    for (const file of entries) {
      if (!isFactFile(file)) continue;
      const name = file.replace(/\.md$/i, '');
      if (seen.has(name)) continue;
      seen.add(name);
      const filePath = path.join(dir, file);
      let content = '';
      try {
        content = fs.readFileSync(filePath, 'utf-8');
      } catch {
        continue;
      }
      results.push({ name, path: filePath, layer, summary: summarize(content) });
    }
  }
  return results.sort((a, b) => a.name.localeCompare(b.name));
}

/** Read one fact by name (winning layer). */
export function readMemoryFact(name: string, cwd: string = process.cwd()): MemoryFact | null {
  const slug = slugify(name);
  for (const { layer, dir } of getMemoryLayerDirs(cwd)) {
    const filePath = path.join(dir, `${slug}.md`);
    if (!fs.existsSync(filePath)) continue;
    let content = '';
    try {
      content = fs.readFileSync(filePath, 'utf-8');
    } catch {
      continue;
    }
    return { name: slug, path: filePath, layer, summary: summarize(content) };
  }
  return null;
}

/** Write a fact into the user layer. Returns the absolute path. */
export function addMemoryFact(name: string, body: string): string {
  const dir = ensureUserMemoryDir();
  const slug = slugify(name);
  const filePath = path.join(dir, `${slug}.md`);
  const content = body.trimStart().startsWith('#')
    ? body.endsWith('\n') ? body : body + '\n'
    : `# ${slug}\n\n${body.trim()}\n`;
  fs.writeFileSync(filePath, content, 'utf-8');
  rebuildMemoryIndex(dir);
  return filePath;
}

/** Remove a fact from the user layer. Returns true if a file was deleted. */
export function removeMemoryFact(name: string): boolean {
  const dir = getUserMemoryDir();
  const slug = slugify(name);
  const filePath = path.join(dir, `${slug}.md`);
  if (!fs.existsSync(filePath)) return false;
  fs.unlinkSync(filePath);
  if (fs.existsSync(dir)) rebuildMemoryIndex(dir);
  return true;
}

/** Rebuild MEMORY.md index from sibling fact files in a single layer dir. */
function rebuildMemoryIndex(dir: string): void {
  let facts: string[] = [];
  try {
    facts = fs.readdirSync(dir).filter(isFactFile).sort();
  } catch {
    return;
  }
  const lines = [
    '# Memory index',
    '',
    'Always-read summary of accumulated agent memory. Managed by `agents memory`.',
    '',
  ];
  if (facts.length === 0) {
    lines.push('_No facts yet. Add one with `agents memory add <name> --body "..."`._', '');
  } else {
    for (const file of facts) {
      const name = file.replace(/\.md$/i, '');
      let summary = '';
      try {
        summary = summarize(fs.readFileSync(path.join(dir, file), 'utf-8'));
      } catch {
        summary = '';
      }
      lines.push(`- **${name}** — ${summary}`);
    }
    lines.push('');
  }
  fs.writeFileSync(path.join(dir, 'MEMORY.md'), lines.join('\n'), 'utf-8');
}

/**
 * Per-agent target directory (relative to version home) for synced memory.
 * Claude/Codex/OpenClaw/Grok get native-ish paths; others get a generic memory/.
 */
export function memoryTargetDir(agent: AgentId): string {
  switch (agent) {
    case 'claude':
      return path.join(agentConfigDirName(agent), 'memory');
    case 'codex':
      return path.join(agentConfigDirName(agent), 'memories');
    case 'openclaw':
    case 'grok':
      return 'memory';
    default:
      return path.join(agentConfigDirName(agent), 'memory');
  }
}

/** Copy canonical layered memory into one version home. Returns fact names written. */
export function syncMemoryToVersionHome(
  agent: AgentId,
  versionHome: string,
  cwd: string = process.cwd(),
): string[] {
  if (!supports(agent, 'memory').ok) return [];
  const facts = listMemoryFacts(cwd);
  const targetRel = memoryTargetDir(agent);
  const targetDir = path.join(versionHome, targetRel);
  fs.mkdirSync(targetDir, { recursive: true });

  // Managed manifest tracks which fact files *we* wrote. On sync we only
  // remove previously-managed names that are no longer in the canonical set —
  // never wipe every .md (user-authored native memory must survive).
  const managedManifestPath = path.join(targetDir, '.agents-cli-memory.json');
  let previouslyManaged: string[] = [];
  try {
    const raw = JSON.parse(fs.readFileSync(managedManifestPath, 'utf-8')) as { facts?: unknown };
    if (Array.isArray(raw.facts)) {
      previouslyManaged = raw.facts.filter((f): f is string => typeof f === 'string');
    }
  } catch { /* missing or corrupt → treat as first managed sync */ }

  const desiredNames = new Set(facts.map((f) => f.name));
  const managedThisSync = new Set<string>(desiredNames);

  for (const name of previouslyManaged) {
    if (desiredNames.has(name)) continue;
    if (name === 'MEMORY') continue; // index rewritten below
    try { fs.unlinkSync(path.join(targetDir, `${name}.md`)); } catch { /* ignore */ }
  }

  const written: string[] = [];
  for (const fact of facts) {
    const dest = path.join(targetDir, `${fact.name}.md`);
    try {
      fs.copyFileSync(fact.path, dest);
      written.push(fact.name);
    } catch { /* skip unreadable */ }
  }

  // Always write an index from the winning layers.
  const indexSrc = (() => {
    for (const { dir } of getMemoryLayerDirs(cwd)) {
      const p = path.join(dir, 'MEMORY.md');
      if (fs.existsSync(p)) return p;
    }
    return null;
  })();
  if (indexSrc) {
    try {
      fs.copyFileSync(indexSrc, path.join(targetDir, 'MEMORY.md'));
      managedThisSync.add('MEMORY');
    } catch { /* ignore */ }
  } else {
    rebuildMemoryIndex(targetDir);
    managedThisSync.add('MEMORY');
  }

  try {
    fs.writeFileSync(
      managedManifestPath,
      JSON.stringify({ facts: [...managedThisSync].sort() }, null, 2) + '\n',
      'utf-8',
    );
  } catch { /* best-effort */ }

  return written;
}

/**
 * Canonical shared dir for Claude Code's NATIVE per-project auto-memory —
 * `<versionHome>/.claude/projects/<project-key>/memory/*.md`, the freeform
 * notes Claude writes for itself during a session. Distinct from the layered
 * `memory` resource above (~/.agents/memory/ facts synced into
 * `.claude/memory/`): this dir is keyed by project (via
 * {@link claudeProjectDirName}), not by agent version, and Claude Code itself
 * decides what goes in it — agents-cli only makes the directory
 * version-independent, never writes into it.
 */
export function getClaudeProjectMemoryDir(cwd: string): string {
  const projectKey = claudeProjectDirName(path.resolve(cwd));
  return path.join(getRuntimeStateDir(), 'claude-project-memory', projectKey);
}

/**
 * Make Claude Code's native per-project memory dir version-independent by
 * symlinking `<versionHome>/.claude/projects/<project-key>/memory/` into the
 * one canonical dir every installed Claude version's home shares for this
 * project (PHNX-2817). Without this, `getVersionHomePath` gives every
 * installed version its own isolated HOME, so a note written under one
 * version is invisible under another — the directory is just empty there.
 *
 * Idempotent and safe to call on every sync: a dir already linked to the
 * canonical target is left alone; a PRE-EXISTING real directory with content
 * (the common case today, since this bug has always left one behind) has its
 * files migrated into the canonical dir first — never discarded — before
 * being replaced by the symlink.
 */
export function syncClaudeProjectMemoryDir(versionHome: string, cwd: string = process.cwd()): void {
  const projectKey = claudeProjectDirName(path.resolve(cwd));
  const canonicalDir = path.join(getRuntimeStateDir(), 'claude-project-memory', projectKey);
  const projectDir = path.join(versionHome, agentConfigDirName('claude'), 'projects', projectKey);
  const nativeMemoryDir = path.join(projectDir, 'memory');

  fs.mkdirSync(canonicalDir, { recursive: true, mode: 0o700 });

  let existing: fs.Stats | undefined;
  try {
    existing = fs.lstatSync(nativeMemoryDir);
  } catch { /* nothing there yet */ }

  if (existing?.isSymbolicLink()) {
    let currentTarget: string | undefined;
    try { currentTarget = fs.readlinkSync(nativeMemoryDir); } catch { /* dangling link */ }
    if (currentTarget === canonicalDir) return; // already wired correctly
    fs.unlinkSync(nativeMemoryDir); // stale/foreign link — replace below
  } else if (existing?.isDirectory()) {
    // Migrate first (never clobber content already promoted to canonical by
    // an earlier-synced version home), then remove the now-redundant copy.
    fs.cpSync(nativeMemoryDir, canonicalDir, { recursive: true, force: false, errorOnExist: false });
    fs.rmSync(nativeMemoryDir, { recursive: true, force: true });
  } else if (existing) {
    return; // an unexpected file at this path — leave it alone rather than destroy it
  }

  fs.mkdirSync(projectDir, { recursive: true });
  try {
    fs.symlinkSync(canonicalDir, nativeMemoryDir, process.platform === 'win32' ? 'junction' : undefined);
  } catch (err) {
    // A concurrent sync (e.g. two `agents run claude` launches racing on a
    // first-ever project) can win this exact link between our lstat above
    // and this call. If it landed the same canonical target, that's the
    // outcome we wanted — treat it as success rather than throwing.
    if ((err as NodeJS.ErrnoException)?.code !== 'EEXIST') throw err;
    let racedTarget: string | undefined;
    try { racedTarget = fs.readlinkSync(nativeMemoryDir); } catch { /* not even a symlink — fall through to rethrow */ }
    if (racedTarget !== canonicalDir) throw err;
  }
}

