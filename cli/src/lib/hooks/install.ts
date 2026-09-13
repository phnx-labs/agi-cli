/**
 * Hook management -- discovery, registration, and syncing of event hooks.
 *
 * Hooks are shell scripts in ~/.agents/hooks/ that fire on agent events
 * (tool calls, session start, etc.). Each hook directory contains a manifest
 * (agents.yaml) declaring events, matchers, and timeout. This module handles
 * parsing those manifests, registering hooks into agent-native settings files,
 * and syncing them across version switches.
 */

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as yaml from 'yaml';
import * as TOML from 'smol-toml';
import { execFile, execFileSync } from 'child_process';
import { promisify } from 'util';
import { fileURLToPath } from 'url';
import { AGENTS, ALL_AGENT_IDS, agentConfigDirName, isAgentHardDeprecated } from '../agents.js';
import { supports, explainSkip, capableAgents } from '../capabilities.js';
import { getAgentsDir, getHooksDir as getSystemHooksDir, getUserHooksDir, getUserAgentsDir, getSystemAgentsDir, getProjectAgentsDir, getTrashHooksDir, getEnabledExtraRepos, getResolvedRulesDir, getUserRulesDir, getPerfDir } from '../state.js';
import { collectSubruleHooksFromState } from '../rules/compose.js';

function getCentralHooksDir(): string { return getUserHooksDir(); }

/**
 * Resolve a hook script's absolute path. Checks user dir first, then enabled
 * extra repos in insertion order, then system dir. Returns null if not found.
 */
function resolveContainedHookPath(hooksRoot: string, script: string): string | null {
  const resolvedRoot = path.resolve(hooksRoot);
  const candidate = path.join(hooksRoot, script);
  const resolved = path.resolve(candidate);
  if (!resolved.startsWith(resolvedRoot + path.sep)) return null;
  if (!fs.existsSync(resolved)) return null;
  return resolved;
}

/**
 * Subdirectories under hooks/ that group event families (e.g. session-starts/).
 * Scripts one level down are first-class hooks; their install name remains the
 * file basename so version-home copies stay flat and doctor/diff keep matching.
 */
const HOOK_GROUP_SKIP_DIRS = new Set(['node_modules', '.git', '.cache']);

export function resolveHookScriptPath(script: string): string | null {
  const extraDirs = getEnabledExtraRepos().map(e => e.dir);
  for (const root of [getUserAgentsDir(), ...extraDirs, getSystemAgentsDir()]) {
    const hooksRoot = path.join(root, 'hooks');
    const resolved = resolveContainedHookPath(hooksRoot, script);
    if (resolved) return resolved;
    // Basename fallback: manifests may say `session-starts/foo.sh` or just
    // `foo.sh` while the file lives under a one-level group dir.
    const base = path.basename(script);
    const nested = findHookScriptInGroupDirs(hooksRoot, base);
    if (nested) return nested;
  }
  return null;
}

/**
 * Find `basename` under hooks/<group>/ (one level). Skips known non-group dirs.
 * Returns the first match in sorted group order for stability.
 */
function findHookScriptInGroupDirs(hooksRoot: string, basename: string): string | null {
  if (!fs.existsSync(hooksRoot)) return null;
  let entries: string[];
  try {
    entries = fs.readdirSync(hooksRoot).sort();
  } catch {
    return null;
  }
  for (const name of entries) {
    if (name.startsWith('.') || HOOK_GROUP_SKIP_DIRS.has(name)) continue;
    const groupDir = path.join(hooksRoot, name);
    let st: fs.Stats;
    try {
      st = fs.lstatSync(groupDir);
    } catch {
      continue;
    }
    if (!st.isDirectory() || st.isSymbolicLink()) continue;
    // Only treat dirs that themselves contain scripts as groups (session-starts/),
    // not fixture-only directory bundles (tests/).
    let hasScript = false;
    try {
      for (const child of fs.readdirSync(groupDir)) {
        if (SCRIPT_EXTENSIONS.has(path.extname(child).toLowerCase())) {
          const cp = path.join(groupDir, child);
          if (fs.existsSync(cp) && fs.statSync(cp).isFile()) { hasScript = true; break; }
        }
      }
    } catch {
      continue;
    }
    if (!hasScript) continue;
    const candidate = path.join(groupDir, basename);
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
  }
  return null;
}

/**
 * Prefixes used for stale-entry cleanup in agent settings files. A registered
 * hook command is considered "managed" if it lives under any known hooks dir
 * (user, extra repos, or system). Entries from removed extra repos are also
 * garbage-collected because they won't appear in this list any more.
 */
function getManagedHookPrefixes(): string[] {
  const extraDirs = getEnabledExtraRepos().map(e => e.dir);
  return [
    path.join(getUserAgentsDir(), 'hooks') + path.sep,
    ...extraDirs.map(d => path.join(d, 'hooks') + path.sep),
    path.join(getSystemAgentsDir(), 'hooks') + path.sep,
    // Subrule-dir hook scripts register by their absolute source path under a
    // rules `subrules/` tree. Cover those trees so a removed subrule/hook's
    // stale settings entry gets garbage-collected like any other managed hook.
    path.join(getUserRulesDir(), 'subrules') + path.sep,
    ...extraDirs.map(d => path.join(d, 'rules', 'subrules') + path.sep),
    path.join(getResolvedRulesDir(), 'subrules') + path.sep,
  ];
}

/**
 * Convert an absolute path under HOME to a portable ~/... form with forward
 * slashes. Hook commands stored this way work on both macOS and Windows:
 * absolute Windows paths break in bash because backslashes are stripped as
 * escape characters, whereas ~/... paths expand correctly via the ~/.claude
 * symlink/junction on both platforms.
 *
 * `home` and `sep` are injectable so the Windows behavior (backslash sep,
 * drive-letter home) is unit-testable on a POSIX CI host — pass sep='\\' to
 * simulate Windows. With the defaults this is byte-identical to reading
 * os.homedir()/path.sep at the call site.
 */
export function toPortableCommand(
  absPath: string,
  home: string = os.homedir(),
  sep: string = path.sep
): string {
  const normalized = absPath.split(sep).join('/');
  const homeNorm = home.split(sep).join('/');
  if (normalized.startsWith(homeNorm + '/')) {
    return '~/' + normalized.slice(homeNorm.length + 1);
  }
  return normalized;
}

function isManagedHookCommand(command: string, prefixes: string[]): boolean {
  // Expand ~/... so tilde-form portable commands can be matched against
  // absolute managed prefixes.
  let expanded = command;
  if (command.startsWith('~/')) {
    expanded = path.join(os.homedir(), command.slice(2));
  }
  // Resolve the directory through symlinks/junctions (e.g. ~/.claude on
  // Windows is a junction to the versioned home dir where prefixes live).
  // Resolve the dir, not the full path — the file may not exist after removal.
  const dir = path.dirname(expanded);
  let resolvedDir = dir;
  try { resolvedDir = fs.realpathSync(dir); } catch { /* absent or broken link */ }
  const resolved = path.join(resolvedDir, path.basename(expanded));

  for (const prefix of prefixes) {
    if (resolved.startsWith(prefix)) return true;
    // The command dir above is realpath-resolved, but a raw prefix may still
    // point through a symlink (macOS TMPDIR /var -> /private/var, or a
    // symlinked ~/.agents). Compare against a realpath-normalized prefix too
    // so the two sides match. Strip the trailing sep, resolve the dir, re-add.
    const rawPrefixDir = prefix.endsWith(path.sep) ? prefix.slice(0, -path.sep.length) : prefix;
    let resolvedPrefix = prefix;
    try { resolvedPrefix = fs.realpathSync(rawPrefixDir) + path.sep; } catch { /* absent or broken link */ }
    if (resolvedPrefix !== prefix && resolved.startsWith(resolvedPrefix)) return true;
  }
  return false;
}

/**
 * Per-version-home command detection. Sync copies each hook script into the
 * active version's home and registers the command by that version-scoped path
 * (`~/.agents/.history/versions/<agent>/<version>/home/…`). Because the path
 * embeds the version number, a later version's sync appends a fresh set whose
 * paths never string-match (and thus never prune) the prior version's entries —
 * so entries for every version installed over time pile up in one settings
 * file, and once a version is removed its entries become dead hooks that error
 * on every tool call. `versionHomeIdentity` extracts the `<agent>/<version>` a
 * command (or home path) belongs to so stale sibling-version entries can be
 * pruned. Returns null for any path outside a per-version home (system hooks,
 * the user's own custom hooks) — those are never a prune target.
 */
const VERSION_HOME_SEGMENT_RE = /\.history\/versions\/([^/]+)\/([^/]+)\/home(?:\/|$)/;
function versionHomeIdentity(commandOrPath: string): { agent: string; version: string } | null {
  const norm = commandOrPath.split(/[\\/]/).join('/');
  const m = VERSION_HOME_SEGMENT_RE.exec(norm);
  return m ? { agent: m[1], version: m[2] } : null;
}

/**
 * True when `command` points into a DIFFERENT version home of the same agent as
 * `current` — i.e. a stale entry left behind by an earlier version's sync.
 * Non-version-home commands (system + user-custom hooks) always return false.
 */
function isStaleSiblingVersionCommand(
  command: string,
  current: { agent: string; version: string } | null
): boolean {
  if (!current) return false;
  const id = versionHomeIdentity(command);
  return id !== null && id.agent === current.agent && id.version !== current.version;
}

function hookResourceName(command: string): string {
  const withoutArgs = command.trim().split(/\s+/)[0];
  return path.basename(withoutArgs).replace(/\.[^.]+$/, '');
}

/**
 * Collapse version-scoped registrations by logical resource identity rather
 * than absolute command path. When the same resource is present in several
 * homes, the active home's command wins even if it appears later. Commands
 * outside version homes are user-owned and remain untouched.
 */
export function deduplicateVersionHookCommands(
  commands: string[],
  activeVersionHome: string,
): string[] {
  const active = versionHomeIdentity(activeVersionHome);
  if (!active) return [...commands];

  const selected = new Map<string, { command: string; active: boolean }>();
  const passthrough: string[] = [];
  for (const command of commands) {
    const identity = versionHomeIdentity(command);
    if (!identity || identity.agent !== active.agent) {
      passthrough.push(command);
      continue;
    }
    const key = `${identity.agent}\0${hookResourceName(command)}`;
    const candidateIsActive = identity.version === active.version;
    const prior = selected.get(key);
    if (!prior || (!prior.active && candidateIsActive)) {
      selected.set(key, { command, active: candidateIsActive });
    }
  }
  return [...passthrough, ...Array.from(selected.values(), ({ command }) => command)];
}

/**
 * Collapse a matcher group's hook entries down to the deduplicated command
 * multiset {@link deduplicateVersionHookCommands} returns, preserving order and
 * the concrete entry objects. The deduped list is honored as a per-command
 * budget, NOT a membership set: two identical active-version entries collapse to
 * one because the budget for that command is one. (A membership `Set.has` test
 * would keep both — the bug this replaces.) Passthrough (user / non-version-home)
 * commands keep their original multiplicity, so genuine user hooks are untouched.
 */
function collapseVersionHookEntries<T extends { command: string }>(
  entries: T[],
  activeVersionHome: string,
): T[] {
  const budget = new Map<string, number>();
  for (const command of deduplicateVersionHookCommands(entries.map((e) => e.command), activeVersionHome)) {
    budget.set(command, (budget.get(command) ?? 0) + 1);
  }
  return entries.filter((e) => {
    const remaining = budget.get(e.command) ?? 0;
    if (remaining <= 0) return false;
    budget.set(e.command, remaining - 1);
    return true;
  });
}

import {
  getEffectiveHome,
  getGlobalDefault,
  getVersionHomePath,
  isVersionIsolated,
  listInstalledVersions,
  resolveVersion,
} from '../installations/versions.js';
import type { AgentId, HookCacheConfig, HookMatches, InstalledHook, ManifestHook } from '../types.js';
import { generateHookShim, getHookShimPath, isValidHookShimName, parseCacheConfig, removeHookShim } from './cache.js';
import { getHookShimsDir } from '../state.js';

export type HookEntry = { name: string; scriptPath: string; dataFile?: string };

export interface VersionHookCopy {
  agent: AgentId;
  version: string;
  name: string;
  path: string;
  hash: string;
  active: boolean;
}

export interface DuplicateVersionHook {
  agent: AgentId;
  name: string;
  kind: 'duplicate' | 'drift';
  authoritative: VersionHookCopy;
  copies: VersionHookCopy[];
}

function hookContentHash(scriptPath: string): string {
  return crypto.createHash('sha256').update(fs.readFileSync(scriptPath)).digest('hex');
}

/**
 * Inspect every installed hooks-capable harness without assuming a native
 * settings format. Same-name copies with one content hash are installation
 * noise; multiple hashes are drift. The active version is always selected as
 * the authoritative copy when it participates in the group.
 */
export function inspectDuplicateVersionHooks(cwd = process.cwd()): DuplicateVersionHook[] {
  const byResource = new Map<string, VersionHookCopy[]>();
  for (const { agent, version } of iterHooksCapableVersions()) {
    const activeVersion = resolveVersion(agent, cwd);
    for (const entry of listHooksInVersionHome(agent, version)) {
      let hash: string;
      try {
        hash = hookContentHash(entry.scriptPath);
      } catch {
        continue;
      }
      const copy: VersionHookCopy = {
        agent,
        version,
        name: entry.name,
        path: entry.scriptPath,
        hash,
        active: version === activeVersion,
      };
      const key = `${agent}\0${entry.name}`;
      const copies = byResource.get(key) ?? [];
      copies.push(copy);
      byResource.set(key, copies);
    }
  }

  const findings: DuplicateVersionHook[] = [];
  for (const copies of byResource.values()) {
    if (copies.length < 2) continue;
    copies.sort((a, b) => a.version.localeCompare(b.version, undefined, { numeric: true }));
    const authoritative = copies.find((copy) => copy.active) ?? copies[copies.length - 1];
    findings.push({
      agent: authoritative.agent,
      name: authoritative.name,
      kind: new Set(copies.map((copy) => copy.hash)).size === 1 ? 'duplicate' : 'drift',
      authoritative,
      copies,
    });
  }
  return findings.sort((a, b) => `${a.agent}/${a.name}`.localeCompare(`${b.agent}/${b.name}`));
}

/**
 * Resolve the command path to register for a hook.
 *
 * Returns either the raw script path (no `cache:`, `matches:`, or `matcher:`
 * set — a bare lifecycle hook with nothing to gate or time) or the path to a
 * generated wrapper shim. The shim is written as a side effect when `cache:`
 * and/or `matches:` is configured — it enforces the `matches:` gate at fire
 * time and layers the caching/timing machinery when `cache:` is set.
 *
 * A hook that declares only `matcher:` (e.g. git-guard/rm-guard scoped to the
 * `Bash` tool, no `cache:`/`matches:`) also gets a shim now — a pass-through
 * one with no gate and no cache, whose only job is the trailing timing sample
 * (see PASSTHROUGH_TAIL in hooks/cache.ts). Before this, a matcher-only hook
 * took the raw-path branch and fired completely uninstrumented: `agents perf
 * hooks` showed zero samples for it no matter how often it ran. The agent-
 * native settings file gets the same shape either way — just a different
 * command path.
 */
function resolveHookCommand(
  name: string,
  hookDef: ManifestHook,
  resolveScript: (script: string) => string | null
): string | null {
  const scriptPath = resolveScript(hookDef.script);
  if (!scriptPath) return null;
  if (!isValidHookShimName(name)) return null;
  const cache = parseCacheConfig(hookDef.cache);
  const matches = hookDef.matches;
  const hasMatches = matches != null && Object.keys(matches).length > 0;
  const hasMatcher = !!hookDef.matcher;
  if (!cache && !hasMatches && !hasMatcher) {
    // Nothing to gate, cache, or time: make sure a previously generated shim
    // from an earlier cache:/matches:/matcher config is gone so the JSONL
    // doesn't keep claiming hits.
    removeHookShim(name);
    return toPortableCommand(scriptPath);
  }
  // A shim is generated when the hook opts into caching, declares `matches:`
  // predicates, or declares a `matcher:` (even alone — see the doc comment
  // above). The shim enforces the `matches:` gate at fire time (skipping the
  // script when predicates don't hold) and, when `cache:` is set, layers the
  // cache/timing machinery on top; with neither, it is a pure pass-through
  // timing wrapper.
  return toPortableCommand(generateHookShim({ name, scriptPath, cache, matches }));
}

/**
 * Extensions that are NEVER hooks — docs, configuration, plain data. A file
 * in hooks/ with one of these extensions is auxiliary content (e.g., the
 * `promptcuts.yaml` data file read directly by the expand-promptcuts
 * script, or the `README.md` that documents the hooks directory). They
 * sometimes carry an exec bit by accident (older sync runs chmod 0o755'd
 * everything) but they are not scripts.
 */
const NON_SCRIPT_EXTENSIONS = new Set([
  '.md', '.markdown', '.rst', '.txt',
  '.yaml', '.yml', '.json', '.toml', '.ini', '.conf',
]);

// Documentation siblings of a hook (e.g. `git-guard.md` next to `git-guard.sh`)
// are human-readable docs the hook never reads at runtime — NOT a data sidecar.
// Treating them as the hook's `dataFile` made the installer's correct omission
// of docs look like perpetual drift in `agents doctor` that no sync could fix.
// Structured siblings (.yaml/.json/.toml/...) remain valid data files.
const DOC_EXTENSIONS = new Set(['.md', '.markdown', '.rst']);

const SCRIPT_EXTENSIONS = new Set([
  '.sh',
  '.bash',
  '.zsh',
  '.py',
  '.js',
  '.ts',
  '.mjs',
  '.cjs',
  '.rb',
  '.pl',
  '.ps1',
  '.cmd',
  '.bat',
]);

function isExecutable(mode: number): boolean {
  return (mode & 0o111) !== 0;
}

/**
 * Ensure a script file carries an exec bit. Subrule-dir hook scripts are
 * registered by their source path (not copied), so they must be executable in
 * place. Best-effort: a chmod failure (read-only fs, foreign owner) is ignored.
 */
function ensureExecutable(scriptPath: string): void {
  try {
    const mode = fs.statSync(scriptPath).mode;
    if (!isExecutable(mode)) fs.chmodSync(scriptPath, mode | 0o755);
  } catch { /* best effort */ }
}

function getHooksDir(agentId: AgentId): string {
  const agent = AGENTS[agentId];
  const home = getEffectiveHome(agentId);
  return path.join(home, agentConfigDirName(agentId), agent.hooksDir);
}

function getProjectHooksDirs(agentId: AgentId, cwd: string): string[] {
  const agent = AGENTS[agentId];
  const dirs: string[] = [];
  const projectAgentsDir = getProjectAgentsDir(cwd);
  if (projectAgentsDir) {
    dirs.push(path.join(projectAgentsDir, 'hooks'));
  }
  dirs.push(path.join(cwd, `.${agentId}`, agent.hooksDir));
  return dirs;
}

function ensureDir(dir: string): void {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function removeHookFiles(dir: string, name: string): void {
  if (!fs.existsSync(dir)) {
    return;
  }
  const files = fs.readdirSync(dir);
  for (const file of files) {
    const ext = path.extname(file);
    const base = path.basename(file, ext);
    if (base === name) {
      const fullPath = path.join(dir, file);
      const stat = fs.statSync(fullPath);
      if (stat.isFile()) {
        fs.unlinkSync(fullPath);
      }
    }
  }
}

/**
 * Collect hook-adjacent files from a hooks root: top-level files plus files in
 * one-level group subdirs (e.g. hooks/session-starts/*.sh). Group dirs exist
 * only for layout; the install/list name stays the file basename so sync and
 * doctor keep a flat version-home model.
 */
function collectHookFilesFromRoot(dir: string): {
  name: string;
  base: string;
  ext: string;
  fullPath: string;
  isExec: boolean;
}[] {
  const files: {
    name: string;
    base: string;
    ext: string;
    fullPath: string;
    isExec: boolean;
  }[] = [];

  const pushFile = (fullPath: string, fileName: string, mode: number) => {
    const ext = path.extname(fileName);
    const base = path.basename(fileName, ext);
    files.push({
      name: fileName,
      base,
      ext,
      fullPath,
      isExec: isExecutable(mode),
    });
  };

  let top: string[];
  try {
    top = fs.readdirSync(dir);
  } catch {
    return files;
  }

  for (const file of top) {
    if (file.startsWith('.')) continue;
    const fullPath = path.join(dir, file);
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(fullPath);
    } catch {
      continue;
    }
    if (stat.isSymbolicLink()) continue;
    if (stat.isFile()) {
      pushFile(fullPath, file, stat.mode);
      continue;
    }
    if (!stat.isDirectory() || HOOK_GROUP_SKIP_DIRS.has(file)) continue;
    // One-level event-group layout: hooks/<group>/<script>. Only dirs that
    // contain top-level scripts are groups; fixture-only dirs (tests/) are not.
    let nested: string[];
    try {
      nested = fs.readdirSync(fullPath);
    } catch {
      continue;
    }
    const nestedFiles: { nestedName: string; nestedPath: string; mode: number }[] = [];
    let hasScript = false;
    for (const nestedName of nested) {
      if (nestedName.startsWith('.')) continue;
      const nestedPath = path.join(fullPath, nestedName);
      let nstat: fs.Stats;
      try {
        nstat = fs.lstatSync(nestedPath);
      } catch {
        continue;
      }
      if (nstat.isSymbolicLink() || !nstat.isFile()) continue;
      nestedFiles.push({ nestedName, nestedPath, mode: nstat.mode });
      if (SCRIPT_EXTENSIONS.has(path.extname(nestedName).toLowerCase())) hasScript = true;
    }
    if (!hasScript) continue;
    for (const n of nestedFiles) pushFile(n.nestedPath, n.nestedName, n.mode);
  }
  return files;
}

/**
 * List hook entries in a single directory, grouping script + data files by
 * basename. Also discovers scripts in one-level group subdirs
 * (hooks/session-starts/). Exported so doctor-diff can reuse the same grouping
 * the sync path applies; without this, doctor would double-count `foo.sh` and
 * `foo.yaml`. On basename collision, the top-level file wins over a nested one.
 */
export function listHookEntriesFromDir(dir: string): HookEntry[] {
  if (!fs.existsSync(dir)) {
    return [];
  }

  const files = collectHookFilesFromRoot(dir);

  // Prefer top-level over nested when basenames collide (stable install name).
  const byBase = new Map<string, typeof files>();
  for (const file of files) {
    const list = byBase.get(file.base) || [];
    // Top-level files sit directly under dir; nested have an extra path segment.
    const isTop = path.dirname(file.fullPath) === path.resolve(dir);
    if (isTop) list.unshift(file);
    else list.push(file);
    byBase.set(file.base, list);
  }

  const entries: HookEntry[] = [];
  for (const [base, groupAll] of byBase) {
    // Keep only files that share the winning script's directory so a nested
    // data sidecar next to a nested script still pairs, and a top-level
    // winner is not paired with a nested yaml of the same basename.
    const winnerScript =
      groupAll.find((f) => SCRIPT_EXTENSIONS.has(f.ext.toLowerCase())) ||
      groupAll.find((f) => f.isExec && !NON_SCRIPT_EXTENSIONS.has(f.ext.toLowerCase()));
    if (!winnerScript) continue;
    const groupDir = path.dirname(winnerScript.fullPath);
    const group = groupAll.filter((f) => path.dirname(f.fullPath) === groupDir);
    group.sort((a, b) => a.name.localeCompare(b.name));
    // A group is a hook only if it has an actual script: a script extension,
    // OR an executable bit on a file whose extension is not a known data /
    // docs type. Files like `README.md` (docs) or `promptcuts.yaml` (data
    // the expand-promptcuts hook reads directly) sit alongside hooks but
    // are NOT hooks themselves and must not surface in the hooks list
    // anywhere — doctor, sync, view, or otherwise. Older sync runs may have
    // chmod 0o755'd these files; an exec bit alone is not enough.
    const script =
      group.find((f) => SCRIPT_EXTENSIONS.has(f.ext.toLowerCase())) ||
      group.find((f) => f.isExec && !NON_SCRIPT_EXTENSIONS.has(f.ext.toLowerCase()));
    if (!script) continue;
    const data = group.find((f) => f !== script && !DOC_EXTENSIONS.has(f.ext.toLowerCase()));
    entries.push({
      name: base,
      scriptPath: script.fullPath,
      dataFile: data ? data.fullPath : undefined,
    });
  }

  entries.sort((a, b) => a.name.localeCompare(b.name));
  return entries;
}

function buildHookMap(entries: HookEntry[]): Map<string, HookEntry> {
  const map = new Map<string, HookEntry>();
  for (const entry of entries) {
    map.set(entry.name, entry);
  }
  return map;
}

function copyHook(entry: HookEntry, targetDir: string): void {
  ensureDir(targetDir);
  removeHookFiles(targetDir, entry.name);

  const scriptTarget = path.join(targetDir, path.basename(entry.scriptPath));
  fs.copyFileSync(entry.scriptPath, scriptTarget);
  const scriptStat = fs.statSync(entry.scriptPath);
  fs.chmodSync(scriptTarget, scriptStat.mode);

  if (entry.dataFile) {
    const dataTarget = path.join(targetDir, path.basename(entry.dataFile));
    fs.copyFileSync(entry.dataFile, dataTarget);
  }
}

/**
 * Check if a hook exists for an agent.
 */
export function hookExists(agentId: AgentId, hookName: string): boolean {
  const agent = AGENTS[agentId];
  if (!agent.supportsHooks) {
    return false;
  }
  const hooksDir = getHooksDir(agentId);
  if (!fs.existsSync(hooksDir)) {
    return false;
  }
  const files = fs.readdirSync(hooksDir);
  return files.some((file) => {
    const ext = path.extname(file);
    const baseName = path.basename(file, ext);
    return baseName === hookName && SCRIPT_EXTENSIONS.has(ext);
  });
}

/**
 * Normalize content for comparison (trim, normalize line endings).
 */
function normalizeContent(content: string): string {
  return content.replace(/\r\n/g, '\n').trim();
}

/**
 * Get the installed hook entry for an agent.
 */
function getInstalledHookEntry(agentId: AgentId, hookName: string): HookEntry | null {
  const hooksDir = getHooksDir(agentId);
  const entries = listHookEntriesFromDir(hooksDir);
  return entries.find((e) => e.name === hookName) || null;
}

/**
 * Check if installed hook content matches source hook content.
 * Compares both script file and data file (if present).
 */
export function hookContentMatches(
  agentId: AgentId,
  hookName: string,
  sourceEntry: HookEntry
): boolean {
  const agent = AGENTS[agentId];
  if (!agent.supportsHooks) {
    return false;
  }

  const installedEntry = getInstalledHookEntry(agentId, hookName);
  if (!installedEntry) {
    return false;
  }

  try {
    const installedScript = fs.readFileSync(installedEntry.scriptPath, 'utf-8');
    const sourceScript = fs.readFileSync(sourceEntry.scriptPath, 'utf-8');

    if (normalizeContent(installedScript) !== normalizeContent(sourceScript)) {
      return false;
    }

    const hasInstalledData = !!installedEntry.dataFile;
    const hasSourceData = !!sourceEntry.dataFile;

    if (hasInstalledData !== hasSourceData) {
      return false;
    }

    if (hasInstalledData && hasSourceData) {
      const installedData = fs.readFileSync(installedEntry.dataFile!, 'utf-8');
      const sourceData = fs.readFileSync(sourceEntry.dataFile!, 'utf-8');
      if (normalizeContent(installedData) !== normalizeContent(sourceData)) {
        return false;
      }
    }

    return true;
  } catch {
    return false;
  }
}

/**
 * Hooks dir for an agent under an arbitrary home (version home or effective
 * home). An agent whose `hooksDir` is configured absolute under `$HOME` (grok,
 * kimi) must be translated to config-dir-relative first — a raw `path.join`
 * would embed the absolute path as a relative segment and produce a hybrid
 * path that never exists (RUSH-2237).
 */
export function getHooksDirInHome(agentId: AgentId, home: string): string {
  const config = AGENTS[agentId];
  const hooksDir = path.isAbsolute(config.hooksDir)
    ? path.relative(config.configDir, config.hooksDir)
    : config.hooksDir;
  return path.join(home, agentConfigDirName(agentId), hooksDir);
}

export function listInstalledHooksWithScope(
  agentId: AgentId,
  cwd: string = process.cwd(),
  options?: { home?: string }
): InstalledHook[] {
  const agent = AGENTS[agentId];
  if (!agent.supportsHooks) {
    return [];
  }

  const results: InstalledHook[] = [];
  const seen = new Set<string>();

  const addHook = (hook: HookEntry, scope: 'user' | 'project', agentId: AgentId) => {
    if (seen.has(hook.name)) return;
    results.push({
      name: hook.name,
      path: hook.scriptPath,
      dataFile: hook.dataFile,
      scope,
      agent: agentId,
    });
    seen.add(hook.name);
  };

  // Project-scoped hooks (project .agents overrides agent-specific dirs)
  const projectDirs = getProjectHooksDirs(agentId, cwd);
  for (const dir of projectDirs) {
    const projectHooks = listHookEntriesFromDir(dir);
    for (const hook of projectHooks) {
      addHook(hook, 'project', agentId);
    }
  }

  // User-scoped hooks (version-aware when home is provided)
  const home = options?.home || getEffectiveHome(agentId);
  const userDir = getHooksDirInHome(agentId, home);
  const userHooks = listHookEntriesFromDir(userDir);
  for (const hook of userHooks) {
    addHook(hook, 'user', agentId);
  }

  return results;
}

export async function installHooks(
  source: string,
  agents: AgentId[],
  options: { scope?: 'user' | 'project' } = {}
): Promise<{ installed: string[]; errors: string[] }> {
  const installed: string[] = [];
  const errors: string[] = [];
  const scope = options.scope || 'user';
  const cwd = process.cwd();

  const hooksDir = path.join(source, 'hooks');
  const hooks = listHookEntriesFromDir(hooksDir);

  const uniqueAgents = Array.from(new Set(agents));
  for (const agentId of uniqueAgents) {
    const agent = AGENTS[agentId];
    if (!agent || !agent.supportsHooks) {
      errors.push(`${agentId}:Agent does not support hooks`);
      continue;
    }

    const targetDir =
      scope === 'project' ? getProjectHooksDirs(agentId, cwd)[0] : getHooksDir(agentId);

    for (const entry of hooks) {
      try {
        copyHook(entry, targetDir);
        installed.push(`${entry.name}:${agentId}`);
      } catch (err) {
        errors.push(`${entry.name}:${agentId}:${(err as Error).message}`);
      }
    }
  }

  return { installed, errors };
}

/**
 * Path to the hooks dir of a specific version home (not the active one).
 */
export function getVersionHooksDir(agent: AgentId, version: string): string {
  return getHooksDirInHome(agent, getVersionHomePath(agent, version));
}

/**
 * List hook entries in a specific version home.
 */
export function listHooksInVersionHome(agent: AgentId, version: string): HookEntry[] {
  return listHookEntriesFromDir(getVersionHooksDir(agent, version));
}

// ─── wiring inspection ────────────────────────────────────────────────────────

/**
 * Native hook-config families understood by this read-only inspector. Claude,
 * Droid, and Muse share settings.json; Grok uses the same grouped event shape
 * in hooks/hooks.json; Kimi stores one hook per [[hooks]] config.toml table.
 * Other harnesses report unsupported rather than risk a false verdict.
 */
const SETTINGS_JSON_HOOK_FAMILY: readonly AgentId[] = ['claude', 'droid', 'muse'];
const HOOKS_JSON_HOOK_FAMILY: readonly AgentId[] = ['grok'];
const TOML_ARRAY_HOOK_FAMILY: readonly AgentId[] = ['kimi'];

export interface HookWiringIssue {
  /** Hook name (script basename minus extension). */
  name: string;
  /** Native lifecycle event the hook should be wired to (Stop, PreToolUse, …). */
  event: string;
  /** Matcher group the hook belongs to under `event` (`''` = the catch-all
   *  group). Real hooks scope by matcher — ask-user-question-guard=AskUserQuestion,
   *  user-message-guard=Bash — so wiring is verified per (event, matcher). */
  matcher: string;
  /** The command the harness-native config should reference under `event`. */
  command: string;
}

/** A generated, agents-managed hook wrapper and the inputs needed to recreate it. */
export interface ManagedHookRuntimeArtifact {
  agent: AgentId;
  version: string;
  name: string;
  scriptPath: string;
  shimPath: string;
  cache: HookCacheConfig | null;
  matches?: HookMatches;
}

/** A generated hook wrapper that is referenced by managed configuration but cannot run. */
export interface BrokenManagedHookRuntimeArtifact extends ManagedHookRuntimeArtifact {
  /** Stable, human-readable filesystem failure; the hook is never executed to find it. */
  reason: string;
}

/** Public, doctor-safe shape for a broken generated hook wrapper. */
export interface HookRuntimeIssue {
  name: string;
  path: string;
  reason: string;
}

export interface HookWiringReport {
  /** Whether this agent's hook config format is understood by the inspector. */
  supported: boolean;
  /** Absolute path of the settings file inspected (when supported). */
  settingsPath?: string;
  /** Number of hooks the manifest says should be wired for this version. */
  expected?: number;
  /** Native hook config does not exist — nothing declared can be wired. */
  settingsMissing?: boolean;
  /** Native hook config cannot be parsed — wiring can't be verified. */
  settingsUnparseable?: boolean;
  /** Hooks whose file is present/resolvable but that are NOT referenced in the
   *  native event group/entry should carry them in. */
  unwired: HookWiringIssue[];
  /** Expected hooks that ARE referenced in native config (expected − unwired).
   *  Empty whenever wiring cannot be verified (unsupported family, missing or
   *  unparseable settings). */
  wired: HookWiringIssue[];
  /** Generated agents-managed wrappers that are absent or unusable. This is
   * independent of whether the native config format itself is understood. */
  runtimeBroken: HookRuntimeIssue[];
}

/**
 * Check the filesystem properties a shell hook needs without invoking it. A
 * dangling symlink is deliberately distinguished from an absent file because
 * the repair/remediation is the same but the diagnostic is materially clearer.
 */
function shellQuoteForHookShim(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function hookRuntimeProblem(
  artifact: ManagedHookRuntimeArtifact,
  platform: NodeJS.Platform = process.platform,
): string | null {
  const { shimPath } = artifact;
  let link: fs.Stats;
  try {
    link = fs.lstatSync(shimPath);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return 'missing';
    // Stable: errno code only — never absolute path text (fleet/menu aggregation).
    return `cannot inspect (${code || 'error'})`;
  }

  let target: fs.Stats;
  try {
    target = link.isSymbolicLink() ? fs.statSync(shimPath) : link;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return 'broken symlink';
    return `cannot inspect (${code || 'error'})`;
  }
  if (!target.isFile()) return 'not a regular file';
  // Generation always writes non-empty content; an empty placeholder is broken.
  if (target.size === 0) return 'broken (empty)';
  // Windows does not use a POSIX executable bit; requiring it there would
  // continuously rewrite healthy .sh files on Windows hosts.
  if (platform !== 'win32' && (target.mode & 0o111) === 0) return 'not executable';
  try {
    const body = fs.readFileSync(shimPath, 'utf-8');
    // The global shim must name the selected live version-home script. A
    // wrapper can remain executable while its SOURCE points to an older or
    // deleted version; detect that without running either script.
    if (!body.includes(`SOURCE=${shellQuoteForHookShim(artifact.scriptPath)}`)) {
      return 'source mismatch';
    }
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return `cannot inspect (${code || 'error'})`;
  }
  return null;
}

/**
 * Gather managed generated-shim expectations for one installed version. The
 * script must resolve inside that version home (or be an existing absolute
 * subrule), matching the registrar's selection rules. This function never
 * creates a shim or runs a hook.
 */
function managedHookRuntimeArtifactsForVersion(agent: AgentId, version: string): ManagedHookRuntimeArtifact[] {
  if (!AGENTS[agent].supportsHooks) return [];
  const localHooksDir = getVersionHooksDir(agent, version);
  const resolveScript = (script: string): string | null => {
    if (path.isAbsolute(script) && fs.existsSync(script)) return script;
    return resolveContainedHookPath(localHooksDir, script);
  };
  const artifacts: ManagedHookRuntimeArtifact[] = [];
  for (const [name, hookDef] of Object.entries(parseHookManifest({ warn: false }))) {
    if (!hookDef.events || hookDef.events.length === 0 || !isValidHookShimName(name)) continue;
    const scriptPath = resolveScript(hookDef.script);
    if (!scriptPath) continue;
    const cache = parseCacheConfig(hookDef.cache);
    const hasMatches = hookDef.matches != null && Object.keys(hookDef.matches).length > 0;
    if (!cache && !hasMatches && !hookDef.matcher) continue;
    artifacts.push({
      agent,
      version,
      name,
      scriptPath,
      shimPath: getHookShimPath(name),
      cache,
      matches: hookDef.matches,
    });
  }
  return artifacts;
}

/** Inspect managed generated hook wrappers without executing user hook code. */
export function inspectBrokenManagedHookRuntimeArtifacts(
  filter?: { agent?: AgentId; version?: string },
  platform: NodeJS.Platform = process.platform,
): BrokenManagedHookRuntimeArtifact[] {
  // Generated destinations are shared across every harness. Always select the
  // owner from the global population first; an agent-scoped doctor call may
  // restrict which shim names are relevant, but must not change the expected
  // SOURCE for a shared wrapper.
  const versions = iterHooksCapableVersions();
  if (
    filter?.agent &&
    filter.version &&
    !versions.some((v) => v.agent === filter.agent && v.version === filter.version)
  ) {
    versions.push({ agent: filter.agent, version: filter.version });
  }
  const artifacts: ManagedHookRuntimeArtifact[] = [];
  for (const { agent, version } of versions) {
    artifacts.push(...managedHookRuntimeArtifactsForVersion(agent, version));
  }

  const requestedArtifacts = filter?.agent
    ? artifacts.filter((artifact) =>
      artifact.agent === filter.agent &&
      (!filter.version || artifact.version === filter.version),
    )
    : undefined;
  const relevantShimPaths = requestedArtifacts
    ? new Set(eligibleHookRuntimeArtifacts(requestedArtifacts).map((artifact) => artifact.shimPath))
    : undefined;

  const broken: BrokenManagedHookRuntimeArtifact[] = [];
  for (const artifact of selectCanonicalHookRuntimeArtifacts(artifacts)) {
    if (relevantShimPaths && !relevantShimPaths.has(artifact.shimPath)) continue;
    const reason = hookRuntimeProblem(artifact, platform);
    if (reason) broken.push({ ...artifact, reason });
  }
  return broken.sort((a, b) =>
    a.shimPath.localeCompare(b.shimPath) ||
    `${a.agent}@${a.version}/${a.name}`.localeCompare(`${b.agent}@${b.version}/${b.name}`),
  );
}

/** Outcome of one generation attempt for a unique shim path. */
export interface HookRuntimeRepairAttempt {
  name: string;
  path: string;
  reasonBefore: string;
  /** True when generateHookShim ran for this path in this pass. */
  attempted: boolean;
  repaired: boolean;
  /** Stable failure text when not repaired after an attempt (or dry-run skip). */
  reason?: string;
}

/**
 * Result of one bounded repair pass over agents-managed generated hook shims.
 * Shared by self-heal and doctor --fix; additive types for the doctor track.
 */
export interface HookRuntimeRepairReport {
  /** Broken artifacts found before any write (inspect-only snapshot). */
  brokenBefore: BrokenManagedHookRuntimeArtifact[];
  /** Unique shim paths considered for generation in this pass. */
  attemptedPaths: string[];
  attempts: HookRuntimeRepairAttempt[];
  /** Human-readable lines for CheckResult.fixed (includes dry-run would-fix). */
  fixed: string[];
  /** Human-readable lines for CheckResult.needsAttention — stable wording. */
  needsAttention: string[];
}

export interface RepairManagedHookRuntimeOptions {
  /** Detect only — never write. Default false. */
  dryRun?: boolean;
  filter?: { agent?: AgentId; version?: string };
  platform?: NodeJS.Platform;
}

/**
 * Prefer the agent's global default when it appears in the candidate set;
 * otherwise the newest non-isolated version. Shared shim paths embed a single
 * SOURCE script — picking the wrong version permanently points every harness
 * at a stale or dead path.
 */
function pickCanonicalHookRuntimeArtifact<T extends ManagedHookRuntimeArtifact>(
  candidates: T[],
): T {
  if (candidates.length === 1) return candidates[0];
  const agents = Array.from(new Set(candidates.map((c) => c.agent))).sort();
  for (const agent of agents) {
    const defaultVersion = getGlobalDefault(agent);
    if (!defaultVersion || isVersionIsolated(agent, defaultVersion)) continue;
    const active = candidates.find((c) => c.agent === agent && c.version === defaultVersion);
    if (active) return active;
  }
  // listInstalledVersions is the canonical semver ordering. Scan backward
  // rather than inventing another version comparator at this call site.
  for (const agent of agents) {
    for (const version of [...listInstalledVersions(agent)].reverse()) {
      const newest = candidates.find((c) => c.agent === agent && c.version === version);
      if (newest) return newest;
    }
  }
  return candidates[0];
}

/**
 * One repair target per unique shim path. Generated shims are global, so both
 * unattended and explicit repair leave isolated/private version homes out.
 */
function selectCanonicalHookRuntimeArtifacts<T extends ManagedHookRuntimeArtifact>(
  artifacts: T[],
): T[] {
  // No hook runtime exists for a version that does not support hooks. Isolated
  // versions never own a global generated shim, even when a caller names one:
  // selecting it would repoint every harness at a private version home.
  const pool = eligibleHookRuntimeArtifacts(artifacts);

  const byPath = new Map<string, T[]>();
  for (const artifact of pool) {
    const list = byPath.get(artifact.shimPath) ?? [];
    list.push(artifact);
    byPath.set(artifact.shimPath, list);
  }
  const selected: T[] = [];
  for (const group of byPath.values()) {
    selected.push(pickCanonicalHookRuntimeArtifact(group));
  }
  return selected;
}

/** Versions that may own — and therefore diagnose — a shared generated shim. */
function eligibleHookRuntimeArtifacts<T extends ManagedHookRuntimeArtifact>(
  artifacts: T[],
): T[] {
  return artifacts.filter(
    (artifact) =>
      supports(artifact.agent, 'hooks', artifact.version).ok &&
      !isVersionIsolated(artifact.agent, artifact.version),
  );
}

/**
 * Stable failure text: errno code + detector reason only.
 * Never include absolute paths or randomized atomic-temp basenames — those
 * break cross-device / menu-bar aggregation of identical failures. The hook
 * name is attached by the caller (`hook shim <name>: …`).
 */
function stableHookRuntimeRepairFailure(
  before: string,
  err: unknown,
): string {
  const code = (err as NodeJS.ErrnoException)?.code;
  return `repair failed [${code || 'UNKNOWN'}]: ${before}`;
}

/**
 * Regenerate one known-broken wrapper and prove the result is usable. Callers
 * provide a snapshot from inspectBrokenManagedHookRuntimeArtifacts; this never
 * loops or retries and returns a stable error for the current pass.
 *
 * Generation is delegated to generateHookShim (idempotent — preserves mtime when
 * content already matches). This path never calls registerHooksToSettings,
 * installHooks, or any sync routine.
 */
export function repairManagedHookRuntimeArtifact(
  artifact: ManagedHookRuntimeArtifact,
  platform: NodeJS.Platform = process.platform,
): { repaired: boolean; reason?: string } {
  const before = hookRuntimeProblem(artifact, platform);
  // Already healthy (e.g. race with another pass) — no-op, no needsAttention.
  if (!before) return { repaired: false };
  try {
    generateHookShim({
      name: artifact.name,
      scriptPath: artifact.scriptPath,
      cache: artifact.cache,
      matches: artifact.matches,
    });
  } catch (err) {
    return { repaired: false, reason: stableHookRuntimeRepairFailure(before, err) };
  }
  // Post-repair reinspection — prove the artifact is usable without executing it.
  const after = hookRuntimeProblem(artifact, platform);
  return after
    ? { repaired: false, reason: `${before}; repair did not produce a usable shim (${after})` }
    : { repaired: true };
}

/**
 * Bounded repair of all broken agents-managed generated hook shims.
 *
 * - Inspect first (read-only, no hook execution).
 * - One generation attempt per unique shim path per call (no retry, no timer).
 * - Canonical owner per shared path: global default, else newest non-isolated.
 * - Post-repair reinspection; unresolved findings become stable needsAttention.
 * - Never recurses into resource sync / registerHooksToSettings.
 *
 * This is the shared routine used by the self-heal `hook-runtime` check and
 * exported for the doctor track.
 */
export function repairManagedHookRuntimeArtifacts(
  opts: RepairManagedHookRuntimeOptions = {},
): HookRuntimeRepairReport {
  const platform = opts.platform ?? process.platform;
  const dryRun = opts.dryRun ?? false;
  const brokenBefore = inspectBrokenManagedHookRuntimeArtifacts(opts.filter, platform);
  const targets = selectCanonicalHookRuntimeArtifacts(brokenBefore);

  const attemptedPaths: string[] = [];
  const attempts: HookRuntimeRepairAttempt[] = [];
  const fixed: string[] = [];
  const needsAttention: string[] = [];

  for (const artifact of targets) {
    attemptedPaths.push(artifact.shimPath);

    if (dryRun) {
      // Would-fix: same shape as a real fix so doctor dry-run and daemon previews
      // stay consistent with other HealChecks.
      attempts.push({
        name: artifact.name,
        path: artifact.shimPath,
        reasonBefore: artifact.reason,
        attempted: false,
        repaired: false,
      });
      fixed.push(`hook shim ${artifact.name}`);
      continue;
    }

    const result = repairManagedHookRuntimeArtifact(artifact, platform);
    attempts.push({
      name: artifact.name,
      path: artifact.shimPath,
      reasonBefore: artifact.reason,
      attempted: true,
      repaired: result.repaired,
      reason: result.reason,
    });

    if (result.repaired) {
      fixed.push(`hook shim ${artifact.name}`);
    } else if (result.reason) {
      // Stable needs-attention wording for aggregation across devices / menubar.
      // No reason means already-healthy no-op (race) — do not emit attention noise.
      needsAttention.push(`hook shim ${artifact.name}: ${result.reason}`);
    }
  }

  return { brokenBefore, attemptedPaths, attempts, fixed, needsAttention };
}

/**
 * Verify that every hook the manifest says should be wired is actually
 * referenced in that version's harness-native config, not merely present as a
 * file on disk.
 *
 * `agents doctor` compares hook FILES against source (see diffHooks in
 * doctor-diff.ts) but never checks the wiring, so a hook whose script is
 * byte-identical to source yet missing from settings.json's PreToolUse/Stop/…
 * array reads as "ok" while it never fires. This closes that blind spot.
 *
 * Read-only by construction: it mirrors registerHooksForClaude's command
 * resolution WITHOUT the shim-generation / chmod side effects that
 * resolveHookCommand performs, so it never mutates the version home.
 */
export function checkVersionHookWiring(agent: AgentId, version: string): HookWiringReport {
  // Runtime verification does not rely on parsing a native settings format.
  // That lets doctor catch a deleted generated shim for every hooks-capable
  // harness, including families whose wiring schema is intentionally unsupported.
  const runtimeBroken = inspectBrokenManagedHookRuntimeArtifacts({ agent, version })
    .map(({ name, shimPath, reason }) => ({ name, path: shimPath, reason }));
  if (
    !AGENTS[agent].supportsHooks ||
    (!SETTINGS_JSON_HOOK_FAMILY.includes(agent) &&
      !HOOKS_JSON_HOOK_FAMILY.includes(agent) &&
      !TOML_ARRAY_HOOK_FAMILY.includes(agent))
  ) {
    return { supported: false, unwired: [], wired: [], runtimeBroken };
  }

  const versionHome = getVersionHomePath(agent, version);
  const settingsPath = HOOKS_JSON_HOOK_FAMILY.includes(agent)
    ? path.join(versionHome, '.grok', 'hooks', 'hooks.json')
    : TOML_ARRAY_HOOK_FAMILY.includes(agent)
      ? path.join(versionHome, '.kimi-code', 'config.toml')
      : path.join(versionHome, agentConfigDirName(agent), 'settings.json');
  const localHooksDir = getVersionHooksDir(agent, version);

  // Resolve ONLY to a script that was actually synced for THIS agent+version: the
  // copy in the version home hooks dir, or an absolute subrule-dir path (those are
  // registered in place, never copied). Deliberately NO central-source fallback —
  // sync wires `selectHookManifest(parseHookManifest(), hooksToSync)` where
  // hooksToSync is the per-agent selected set (versions.ts), so a hook the manifest
  // declares but that was never synced into THIS version home (e.g. a claude-scoped
  // hook viewed for droid) must not be expected here. A missing-but-declared hook
  // is a FILE gap that diffHooks reports as `missing`, not a wiring gap.
  // No ensureExecutable — that chmods, and this path must not touch disk.
  const resolveScript = (script: string): string | null => {
    if (path.isAbsolute(script) && fs.existsSync(script)) return script;
    return resolveContainedHookPath(localHooksDir, script);
  };
  // Read-only mirror of resolveHookCommand — same command string, no shim write.
  const expectedCommand = (name: string, hookDef: ManifestHook): string | null => {
    const scriptPath = resolveScript(hookDef.script);
    if (!scriptPath) return null;
    if (!isValidHookShimName(name)) return null;
    const cache = parseCacheConfig(hookDef.cache);
    const hasMatches = hookDef.matches != null && Object.keys(hookDef.matches).length > 0;
    if (!cache && !hasMatches && !hookDef.matcher) return toPortableCommand(scriptPath);
    return toPortableCommand(getHookShimPath(name));
  };

  const manifest = parseHookManifest({ warn: false });
  const expected: HookWiringIssue[] = [];
  for (const [name, hookDef] of Object.entries(manifest)) {
    if (!hookDef.events || hookDef.events.length === 0) continue;
    const command = expectedCommand(name, hookDef);
    if (!command) continue; // script unresolved — a file gap, reported by diffHooks
    for (const event of hookDef.events) {
      if (HOOKS_JSON_HOOK_FAMILY.includes(agent)) {
        const matcher = GROK_MATCHER_EVENTS.has(event)
          ? (GROK_MATCHER_ALIASES[hookDef.matcher || ''] ?? hookDef.matcher ?? '')
          : '';
        expected.push({ name, event, matcher, command });
      } else {
        expected.push({ name, event, matcher: hookDef.matcher || '', command });
      }
    }
  }

  if (!fs.existsSync(settingsPath)) {
    return {
      supported: true,
      settingsPath,
      expected: expected.length,
      settingsMissing: expected.length > 0,
      unwired: [],
      wired: [],
      runtimeBroken,
    };
  }
  let config: Record<string, unknown>;
  try {
    const raw = fs.readFileSync(settingsPath, 'utf-8');
    config = TOML_ARRAY_HOOK_FAMILY.includes(agent)
      ? TOML.parse(raw) as Record<string, unknown>
      : JSON.parse(raw);
  } catch {
    return {
      supported: true,
      settingsPath,
      expected: expected.length,
      settingsUnparseable: true,
      unwired: [],
      wired: [],
      runtimeBroken,
    };
  }

  // Command strings actually referenced, keyed by (event, matcher) — a hook wired
  // under the WRONG matcher group must NOT read as wired, so scope by matcher and
  // not just by event.
  const wiredByGroup = new Map<string, Set<string>>();
  const groupKey = (event: string, matcher: string): string => `${event}\n${matcher}`;
  if (TOML_ARRAY_HOOK_FAMILY.includes(agent)) {
    const hooks = Array.isArray(config.hooks) ? config.hooks : [];
    for (const hook of hooks as Array<{ event?: unknown; matcher?: unknown; command?: unknown }>) {
      if (typeof hook.event !== 'string' || typeof hook.command !== 'string') continue;
      const matcher = typeof hook.matcher === 'string' ? hook.matcher : '';
      const key = groupKey(hook.event, matcher);
      let cmds = wiredByGroup.get(key);
      if (!cmds) { cmds = new Set<string>(); wiredByGroup.set(key, cmds); }
      cmds.add(hook.command);
    }
  } else {
    const hooks = config.hooks && typeof config.hooks === 'object'
      ? (config.hooks as Record<string, unknown>)
      : {};
    for (const [event, groups] of Object.entries(hooks)) {
      if (!Array.isArray(groups)) continue;
      for (const group of groups as Array<{ matcher?: unknown; hooks?: Array<{ command?: unknown }> }>) {
        if (!group || !Array.isArray(group.hooks)) continue;
        const matcher = typeof group.matcher === 'string' ? group.matcher : '';
        const key = groupKey(event, matcher);
        let cmds = wiredByGroup.get(key);
        if (!cmds) { cmds = new Set<string>(); wiredByGroup.set(key, cmds); }
        for (const h of group.hooks) {
          if (h && typeof h.command === 'string') cmds.add(h.command);
        }
      }
    }
  }

  const isWired = (entry: HookWiringIssue): boolean =>
    wiredByGroup.get(groupKey(entry.event, entry.matcher))?.has(entry.command) ?? false;
  const unwired = expected.filter((entry) => !isWired(entry));
  const wired = expected.filter(isWired);
  return { supported: true, settingsPath, expected: expected.length, unwired, wired, runtimeBroken };
}

/**
 * Check if a hook installed in a specific version matches central content.
 */
function versionHookMatches(agent: AgentId, version: string, hookName: string): boolean {
  const central = listHookEntriesFromDir(getCentralHooksDir()).find((e) => e.name === hookName);
  if (!central) return false;
  const installed = listHooksInVersionHome(agent, version).find((e) => e.name === hookName);
  if (!installed) return false;

  try {
    if (normalizeContent(fs.readFileSync(installed.scriptPath, 'utf-8')) !==
        normalizeContent(fs.readFileSync(central.scriptPath, 'utf-8'))) {
      return false;
    }
    if (!!installed.dataFile !== !!central.dataFile) return false;
    if (installed.dataFile && central.dataFile) {
      if (normalizeContent(fs.readFileSync(installed.dataFile, 'utf-8')) !==
          normalizeContent(fs.readFileSync(central.dataFile, 'utf-8'))) {
        return false;
      }
    }
    return true;
  } catch {
    return false;
  }
}

export interface VersionHookDiff {
  agent: AgentId;
  version: string;
  toAdd: string[];
  toUpdate: string[];
  matched: string[];
  orphans: string[];
}

/**
 * Compare a version home's hooks against central. Returns the reconciliation diff.
 */
export function diffVersionHooks(agent: AgentId, version: string): VersionHookDiff {
  const central = new Set(listHookEntriesFromDir(getCentralHooksDir()).map((e) => e.name));
  const installed = new Set(listHooksInVersionHome(agent, version).map((e) => e.name));

  const toAdd: string[] = [];
  const toUpdate: string[] = [];
  const matched: string[] = [];
  const orphans: string[] = [];

  for (const name of central) {
    if (!installed.has(name)) {
      toAdd.push(name);
    } else if (!versionHookMatches(agent, version, name)) {
      toUpdate.push(name);
    } else {
      matched.push(name);
    }
  }

  for (const name of installed) {
    if (!central.has(name)) orphans.push(name);
  }

  return { agent, version, toAdd: toAdd.sort(), toUpdate: toUpdate.sort(), matched, orphans: orphans.sort() };
}

/**
 * Install a single hook from central into a specific version home.
 */
export function installHookToVersion(
  agent: AgentId,
  version: string,
  hookName: string
): { success: boolean; error?: string } {
  const gate = supports(agent, 'hooks', version);
  if (!gate.ok) {
    return { success: false, error: explainSkip(agent, 'hooks', gate, version) };
  }

  const central = listHookEntriesFromDir(getCentralHooksDir()).find((e) => e.name === hookName);
  if (!central) {
    return { success: false, error: `Hook '${hookName}' not found in central` };
  }

  const targetDir = getVersionHooksDir(agent, version);
  try {
    fs.mkdirSync(targetDir, { recursive: true });
    copyHook(central, targetDir);
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
  return { success: true };
}

/**
 * Remove a single hook (script + data file) from a specific version home.
 * Soft-deletes to ~/.agents/.trash/hooks/.
 */
export function removeHookFromVersion(
  agent: AgentId,
  version: string,
  hookName: string
): { success: boolean; error?: string } {
  try {
    const hooksDir = getVersionHooksDir(agent, version);
    if (!fs.existsSync(hooksDir)) return { success: true };

    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const trashDir = path.join(getTrashHooksDir(), agent, version, hookName, stamp);
    let moved = false;

    const files = fs.readdirSync(hooksDir);
    for (const file of files) {
      const ext = path.extname(file);
      const base = path.basename(file, ext);
      if (base === hookName) {
        const fullPath = path.join(hooksDir, file);
        const stat = fs.statSync(fullPath);
        if (stat.isFile()) {
          if (!moved) {
            fs.mkdirSync(trashDir, { recursive: true, mode: 0o700 });
            moved = true;
          }
          fs.renameSync(fullPath, path.join(trashDir, file));
        }
      }
    }
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
  return { success: true };
}

/**
 * Iterate all (agent, version) pairs that support hooks and are installed,
 * optionally scoped to a single agent/version.
 */
export function iterHooksCapableVersions(filter?: { agent?: AgentId; version?: string }): Array<{ agent: AgentId; version: string }> {
  const pairs: Array<{ agent: AgentId; version: string }> = [];
  const hookAgents: AgentId[] = capableAgents('hooks');
  const agents = filter?.agent ? [filter.agent] : hookAgents;
  for (const agent of agents) {
    if (!hookAgents.includes(agent)) continue;
    const versions = listInstalledVersions(agent);
    for (const version of versions) {
      if (filter?.version && filter.version !== version) continue;
      pairs.push({ agent, version });
    }
  }
  return pairs;
}

export async function removeHook(
  name: string,
  agents: AgentId[]
): Promise<{ removed: string[]; errors: string[] }> {
  const removed: string[] = [];
  const errors: string[] = [];

  const uniqueAgents = Array.from(new Set(agents));
  for (const agentId of uniqueAgents) {
    const agent = AGENTS[agentId];
    if (!agent || !agent.supportsHooks) {
      errors.push(`${agentId}:Agent does not support hooks`);
      continue;
    }

    try {
      const dir = getHooksDir(agentId);
      const filesBefore = fs.existsSync(dir) ? fs.readdirSync(dir) : [];
      removeHookFiles(dir, name);
      const filesAfter = fs.existsSync(dir) ? fs.readdirSync(dir) : [];
      if (filesBefore.length !== filesAfter.length) {
        removed.push(`${name}:${agentId}`);
      }
    } catch (err) {
      errors.push(`${name}:${agentId}:${(err as Error).message}`);
    }
  }

  return { removed, errors };
}

/**
 * Get detailed info about a hook from central storage.
 */
export function getHookInfo(name: string): {
  name: string;
  path: string;
  content: string;
} | null {
  const centralDir = getCentralHooksDir();
  const hookPath = path.join(centralDir, name);

  if (!fs.existsSync(hookPath)) {
    return null;
  }

  // Read hook content - it could be a file or directory
  let content = '';
  const stat = fs.statSync(hookPath);
  if (stat.isFile()) {
    content = fs.readFileSync(hookPath, 'utf-8');
  } else if (stat.isDirectory()) {
    // For directory hooks, list the files
    const files = fs.readdirSync(hookPath);
    content = `Directory hook containing:\n${files.map((f) => `  - ${f}`).join('\n')}`;
  }

  return {
    name,
    path: hookPath,
    content,
  };
}

export function discoverHooksFromRepo(repoPath: string): string[] {
  const hooksDir = path.join(repoPath, 'hooks');
  return listHookEntriesFromDir(hooksDir).map((h) => h.name);
}

/**
 * Get the source hook entry from repo.
 */
export function getSourceHookEntry(
  repoPath: string,
  hookName: string
): HookEntry | null {
  const hooksDir = path.join(repoPath, 'hooks');
  const entries = listHookEntriesFromDir(hooksDir);
  return entries.find((e) => e.name === hookName) || null;
}

/**
 * Install hooks to central ~/.agents/hooks/ directory.
 * Shims will symlink this to per-agent directories for synced agents.
 */
export async function installHooksCentrally(
  source: string
): Promise<{ installed: string[]; errors: string[] }> {
  const installed: string[] = [];
  const errors: string[] = [];

  const centralDir = getCentralHooksDir();
  if (!fs.existsSync(centralDir)) {
    fs.mkdirSync(centralDir, { recursive: true });
  }

  // Collect all hooks from shared directory
  const sharedDir = path.join(source, 'hooks');
  const sharedHooks = listHookEntriesFromDir(sharedDir);

  for (const entry of sharedHooks) {
    try {
      copyHook(entry, centralDir);
      installed.push(entry.name);
    } catch (err) {
      errors.push(`${entry.name}: ${(err as Error).message}`);
    }
  }

  return { installed, errors };
}

/**
 * List hooks from user (~/.agents/hooks/) and system (~/.agents/.system/hooks/) dirs.
 * User dir takes priority; deduplication preserves first occurrence.
 */
export function listCentralHooks(): HookEntry[] {
  const seen = new Set<string>();
  const results: HookEntry[] = [];
  for (const dir of [getUserHooksDir(), getSystemHooksDir()]) {
    for (const entry of listHookEntriesFromDir(dir)) {
      if (!seen.has(entry.name)) {
        seen.add(entry.name);
        results.push(entry);
      }
    }
  }
  return results;
}

const MAX_HOOK_DURATION_SECONDS = 24 * 60 * 60;

/**
 * Normalize a hook `timeout` from agents.yaml into a whole number of seconds.
 *
 * A bare number stays seconds (`timeout: 30` → 30) for backward compatibility.
 * A Go-style duration string is parsed into seconds: `5s`, `2m`, `1h30m`,
 * `90s`, `1h`. Suffixed durations longer than 24 hours are rejected as likely
 * typos, while bare seconds stay uncapped for backward compatibility. This
 * intentionally does NOT reuse {@link parseTimeout} from routines.ts — that one
 * returns milliseconds, has no seconds (`s`) unit, and floors at one minute,
 * none of which fit hook timeouts (typically 5–600s).
 *
 * Returns the seconds value, or `null` when the input is not a positive number,
 * is not parseable, or is a suffixed duration longer than 24 hours — the caller
 * decides how to surface that.
 */
export function normalizeHookTimeoutSeconds(value: unknown): number | null {
  if (typeof value === 'number') {
    return Number.isFinite(value) && value > 0 ? value : null;
  }
  if (typeof value === 'string') {
    const s = value.trim();
    if (s === '') return null;
    // A bare integer string means seconds, matching the bare-number form.
    if (/^\d+$/.test(s)) {
      const n = Number(s);
      return n > 0 ? n : null;
    }
    const m = s.match(/^(?:(\d+)w)?(?:(\d+)d)?(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/i);
    if (!m) return null;
    const weeks = Number(m[1] || 0);
    const days = Number(m[2] || 0);
    const hours = Number(m[3] || 0);
    const minutes = Number(m[4] || 0);
    const seconds = Number(m[5] || 0);
    const total = ((weeks * 7 + days) * 24 + hours) * 3600 + minutes * 60 + seconds;
    return total > 0 && total <= MAX_HOOK_DURATION_SECONDS ? total : null;
  }
  return null;
}

/**
 * Parse hook manifests. Reads system hooks from ~/.agents/.system/hooks.yaml
 * (npm-shipped defaults) and user hooks from the `hooks:` section of
 * ~/.agents/agents.yaml. Merges with user-wins-on-key-collision precedence.
 * A user entry with `enabled: false` disables the system-shipped hook of
 * the same name without forking the system file.
 *
 * Hooks marked `enabled: false` are dropped from the returned map. A hook
 * `timeout` written as a duration string (`5s`, `2m`) is normalized to a
 * seconds number here, so every downstream serializer keeps reading a number.
 */
export function parseHookManifest(opts: { warn?: boolean } = {}): Record<string, ManifestHook> {
  const warn = opts.warn !== false;
  const merged: Record<string, ManifestHook> = {};
  const systemHooks: Record<string, ManifestHook> = {};

  // Lowest-precedence layer: hooks declared inside active subrule directories.
  // Seeded first so any same-key entry from system/user agents.yaml wins.
  // Gated so a malformed hooks.yaml never breaks rule sync.
  try {
    const subruleHooks = collectSubruleHooksFromState();
    for (const [name, def] of Object.entries(subruleHooks)) merged[name] = def;
  } catch { /* subrule hook collection is best-effort */ }

  // System layer: hooks: section of agents.yaml (npm-shipped, separate repo).
  const systemPath = path.join(getSystemAgentsDir(), 'agents.yaml');
  if (fs.existsSync(systemPath)) {
    try {
      const meta = yaml.parse(fs.readFileSync(systemPath, 'utf-8')) as { hooks?: Record<string, ManifestHook> } | null;
      if (meta?.hooks) for (const [name, def] of Object.entries(meta.hooks)) {
        systemHooks[name] = def;
        merged[name] = def;
      }
    } catch { /* skip unreadable manifest */ }
  }

  // Extra-repo layer: hooks: section of each enabled extra repo's agents.yaml.
  // Sits above system but below user, mirroring resolveHookScriptPath's
  // first-found order (user > extra > system). Without this layer the script
  // path of an extra-repo hook resolves but its events never register (#602).
  // Earlier extras win over later ones, so iterate in reverse: the last write
  // for a given name comes from the earliest-registered repo.
  for (const { dir } of [...getEnabledExtraRepos()].reverse()) {
    const extraMetaPath = path.join(dir, 'agents.yaml');
    if (!fs.existsSync(extraMetaPath)) continue;
    try {
      const meta = yaml.parse(fs.readFileSync(extraMetaPath, 'utf-8')) as { hooks?: Record<string, ManifestHook> } | null;
      if (meta?.hooks) for (const [name, def] of Object.entries(meta.hooks)) merged[name] = def;
    } catch { /* skip unreadable extra-repo manifest */ }
  }

  // User layer: hooks: section of agents.yaml.
  const userMetaPath = path.join(getUserAgentsDir(), 'agents.yaml');
  if (fs.existsSync(userMetaPath)) {
    try {
      const meta = yaml.parse(fs.readFileSync(userMetaPath, 'utf-8')) as { hooks?: Record<string, ManifestHook> } | null;
      if (meta?.hooks) for (const [name, def] of Object.entries(meta.hooks)) {
        if (warn && systemHooks[name] && def.override !== true) {
          const action = def.enabled === false ? 'disables' : 'shadows';
          console.warn(
            `[agents hooks] User-layer hook '${name}' ${action} system-shipped hook. Set 'override: true' to silence this warning.`,
          );
        }
        merged[name] = def;
      }
    } catch { /* skip unreadable meta */ }
  }

  // Strip disabled hooks so they never reach the registrar.
  for (const [name, def] of Object.entries(merged)) {
    if (def.enabled === false) delete merged[name];
  }

  // Normalize each surviving hook's timeout to a seconds number, so the raw
  // agents.yaml can express it as a duration string (`5s`, `2m`) while every
  // downstream serializer keeps consuming a plain number. An unparseable value
  // is dropped with a warning rather than silently coerced to a wrong duration.
  for (const [name, def] of Object.entries(merged)) {
    const raw = (def as { timeout?: unknown }).timeout;
    if (raw === undefined) continue;
    const seconds = normalizeHookTimeoutSeconds(raw);
    if (seconds === null) {
      if (warn) {
        console.warn(
          `[agents hooks] Hook '${name}' has an invalid timeout ${JSON.stringify(raw)}; ` +
          `expected seconds or a duration string like '5s', '2m', '1h30m'. Ignoring it.`,
        );
      }
      delete def.timeout;
    } else {
      def.timeout = seconds;
    }
  }

  return merged;
}

export function selectHookManifest(
  manifest: Record<string, ManifestHook>,
  selected: string[]
): Record<string, ManifestHook> {
  const selectedHooks = new Set(selected);
  return Object.fromEntries(
    Object.entries(manifest).filter(([name, hook]) =>
      selectedHooks.has(name) || selectedHooks.has(path.basename(hook.script))
    )
  );
}

/**
 * Hook files present in a version home but absent from every configured
 * SOURCE — genuine orphans left behind by a removed/renamed source hook.
 *
 * The definition is deliberately source-based, not manifest-based (PHNX-2693).
 * Sync copies EVERY source hook file into a version home — registered hooks AND
 * the helper / test / benchmark scripts that sit alongside them — but only the
 * registered ones appear in `parseHookManifest`. Diffing installed names against
 * the manifest therefore flagged every source-present-but-unregistered file
 * (e.g. `permission-handler`, `verify-work-state`, `*_test`, `benchmark_*`) as
 * an orphan, so `agents prune cleanup` offered to trash ~1000 in-use files. An
 * installed hook is only truly orphaned when NO configured source still carries
 * a file of that name — which is exactly what the `prune`/`doctor` help already
 * promised ("present in a version home but missing from every configured
 * source").
 *
 * Pure on purpose (no disk reads) so it is trivially testable; callers pass the
 * installed hook names and the source hook script paths.
 */
export function unmanagedHookNames(installedHookNames: string[], sourceHookScripts: string[]): string[] {
  const inSource = new Set(sourceHookScripts.map((s) => path.basename(s).replace(/\.[^.]+$/, '')));
  return installedHookNames.filter((name) => !inSource.has(name)).sort();
}

/**
 * Every hook script path across the resolved SOURCE roots — user
 * (`~/.agents/hooks`), system (`~/.agents/.system/hooks`), and each enabled
 * extra repo's `hooks/` — grouped the same way sync materializes them
 * ({@link listHookEntriesFromDir}, which also descends one-level event-group
 * dirs). This is the set an installed hook must be absent from to count as an
 * orphan.
 */
export function listResolvedSourceHookScripts(): string[] {
  const roots = [
    getUserHooksDir(),
    getSystemHooksDir(),
    ...getEnabledExtraRepos().map((e) => path.join(e.dir, 'hooks')),
  ];
  const scripts: string[] = [];
  for (const root of roots) {
    for (const entry of listHookEntriesFromDir(root)) scripts.push(entry.scriptPath);
  }
  return scripts;
}

/**
 * The orphan hooks (see {@link unmanagedHookNames}) sitting in one version home:
 * installed hook files whose name matches no file in any configured source root.
 */
export function listUnmanagedHooksInVersionHome(agent: AgentId, version: string): string[] {
  if (!AGENTS[agent].supportsHooks) return [];
  const installed = listHooksInVersionHome(agent, version).map((e) => e.name);
  return unmanagedHookNames(installed, listResolvedSourceHookScripts());
}

// Codex events that support a matcher field (matches tool name or session type).
// UserPromptSubmit and Stop never include a matcher.
const CODEX_MATCHER_EVENTS = new Set(['PreToolUse', 'PostToolUse', 'SessionStart']);

type CodexMatcherGroup = {
  matcher?: string;
  hooks: Array<{ type: string; command: string; timeout: number }>;
};

type CodexHooksFile = {
  hooks: Record<string, CodexMatcherGroup[]>;
};

// Maps PascalCase hook event names (as written in hooks.json) to the
// snake_case labels Codex uses in its persisted [hooks.state] keys.
// Mirrors hook_event_key_label() in codex-rs/hooks/src/lib.rs.
const CODEX_EVENT_KEY_LABELS: Record<string, string> = {
  PreToolUse: 'pre_tool_use',
  PermissionRequest: 'permission_request',
  PostToolUse: 'post_tool_use',
  PreCompact: 'pre_compact',
  PostCompact: 'post_compact',
  SessionStart: 'session_start',
  UserPromptSubmit: 'user_prompt_submit',
  SubagentStart: 'subagent_start',
  SubagentStop: 'subagent_stop',
  Stop: 'stop',
};

// Recursively sort object keys alphabetically at every level, mirroring
// canonical_json() in codex-rs/config/src/fingerprint.rs. Codex hashes the
// canonical JSON form so trust survives key-order differences.
function canonicalizeForHash(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalizeForHash);
  }
  if (value && typeof value === 'object') {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      sorted[key] = canonicalizeForHash((value as Record<string, unknown>)[key]);
    }
    return sorted;
  }
  return value;
}

/**
 * Compute the trust hash Codex expects for a single command hook handler, so
 * agents-cli can pre-trust the hooks it registers. Without a matching
 * trusted_hash in [hooks.state], Codex classifies the hook Untrusted and
 * silently drops it in non-interactive (`codex exec`) mode where there is no
 * TUI prompt to approve it.
 *
 * Mirrors command_hook_hash() in codex-rs/hooks/src/engine/discovery.rs +
 * version_for_toml() in codex-rs/config/src/fingerprint.rs:
 *   sha256( canonicalJson( NormalizedHookIdentity ) ) prefixed with "sha256:".
 *
 * The identity passes through TOML on the Codex side, which drops None fields
 * (commandWindows, statusMessage, and matcher when absent). `async` is always
 * false (async hooks are not yet supported) and is always present. `timeout`
 * is normalized to >= 1 (Codex: unwrap_or(600).max(1)).
 */
export function computeCodexHookTrustHash(
  eventKeyLabel: string,
  command: string,
  timeout: number,
  matcher: string | undefined
): string {
  const handler: Record<string, unknown> = {
    type: 'command',
    command,
    timeout: Math.max(timeout, 1),
    async: false,
  };
  const identity: Record<string, unknown> = {
    event_name: eventKeyLabel,
    hooks: [handler],
  };
  if (matcher !== undefined && matcher !== '') {
    identity.matcher = matcher;
  }
  const canonical = canonicalizeForHash(identity);
  const hex = crypto.createHash('sha256').update(JSON.stringify(canonical), 'utf-8').digest('hex');
  return `sha256:${hex}`;
}

/**
 * Register hooks as lifecycle events in an agent's config.
 * Reads hooks.yaml manifest, merges into the agent's config file(s).
 * Only manages hooks whose command paths are under ~/.agents/hooks/ or
 * ~/.agents/.system/hooks/. Does not remove user-added hooks.
 *
 * @param agentsDirOverride - When provided, treats this single dir as the
 *   only managed hook root. Used by tests to inject a temp path. In normal
 *   operation, both user and system roots are consulted with user precedence.
 */
/**
 * Delete shim files for hooks that no longer exist in the manifest.
 * managedPrefixes already GCs the settings.json entries pointing at orphaned
 * shims, but the .sh files on disk would otherwise persist forever. Called
 * once per registerHooksToSettings invocation — cheap (a single readdir).
 */
function sweepOrphanShims(manifest: Record<string, ManifestHook>): void {
  const shimsDir = getHookShimsDir();
  if (!fs.existsSync(shimsDir)) return;
  const activeNames = new Set(Object.keys(manifest));
  for (const file of fs.readdirSync(shimsDir)) {
    if (!file.endsWith('.sh')) continue;
    const name = file.slice(0, -3);
    if (activeNames.has(name)) continue;
    try { fs.unlinkSync(path.join(shimsDir, file)); } catch { /* best effort */ }
  }
}

/**
 * Options that narrow `registerHooksToSettings`'s process-global side effects.
 *
 * `skipGlobalShimSweep` — do NOT run {@link sweepOrphanShims}. The sweep deletes
 * every `.sh` in the ONE process-global shim dir (`getHookShimsDir()`,
 * `~/.agents/.cache/shims/hooks/`) whose name is absent from the manifest it is
 * handed. That is correct for a normal install/sync (the manifest is the
 * operator's complete hook set), but catastrophic when the materializer registers
 * a portable PACKAGE's hooks into an isolated output home: that manifest carries
 * only the package's hooks, so the sweep would wipe the operator's unrelated
 * global shims. The materializer sets this so materialization stays isolated
 * (PHNX-3838); every normal caller leaves it unset and keeps the sweep.
 */
export interface RegisterHooksOptions {
  skipGlobalShimSweep?: boolean;
}

export function registerHooksToSettings(
  agentId: AgentId,
  versionHome: string,
  hookManifest?: Record<string, ManifestHook>,
  agentsDirOverride?: string,
  options?: RegisterHooksOptions
): { registered: string[]; errors: string[] } {
  if (isAgentHardDeprecated(agentId)) {
    return { registered: [], errors: [] };
  }
  const manifest = hookManifest || parseHookManifest();
  if (Object.keys(manifest).length === 0) {
    if (agentId === 'opencode') {
      const pluginPath = path.join(versionHome, '.config', 'opencode', 'plugins', 'agents-cli-hooks.ts');
      try {
        fs.rmSync(pluginPath, { force: true });
      } catch (e) {
        return { registered: [], errors: [`Failed to remove agents-cli-hooks.ts: ${(e as Error).message}`] };
      }
    }
    return { registered: [], errors: [] };
  }
  if (!options?.skipGlobalShimSweep) sweepOrphanShims(manifest);

  const overrideRoots = agentsDirOverride ? [agentsDirOverride] : null;
  // Scripts are copied into the version home during sync — prefer that stable
  // local path so registered commands don't break when source dirs change.
  const localHooksDir = !overrideRoots
    ? getHooksDirInHome(agentId, versionHome)
    : null;
  const resolveScript = (script: string): string | null => {
    // Subrule-dir hooks declare an already-absolute script path. Use it
    // directly (made executable) — these are not copied into the version home.
    if (path.isAbsolute(script) && fs.existsSync(script)) {
      ensureExecutable(script);
      return script;
    }
    if (overrideRoots) {
      return resolveContainedHookPath(path.join(overrideRoots[0], 'hooks'), script);
    }
    if (localHooksDir) {
      // Prefer the exact relative path, then a flat basename copy (sync flattens
      // group-dir scripts into the version-home hooks/ root).
      const local =
        resolveContainedHookPath(localHooksDir, script) ||
        resolveContainedHookPath(localHooksDir, path.basename(script));
      if (local) return local;
    }
    return resolveHookScriptPath(script);
  };
  const managedPrefixes = overrideRoots
    ? [
        path.join(overrideRoots[0], 'hooks') + path.sep,
        // The shim dir is one global location regardless of which hooks
        // source (agentsDirOverride vs the normal user/system dirs) resolved
        // the underlying script, so it belongs in every managedPrefixes
        // shape — omitting it here left a shim path unrecognized as managed
        // under the override branch, so a hook's matcher/event change never
        // GC'd its stale shim-path entry (only reachable via a caller that
        // passes agentsDirOverride; no production call site does today).
        getHookShimsDir() + path.sep,
      ]
    : [
        ...getManagedHookPrefixes(),
        ...(localHooksDir ? [localHooksDir + path.sep] : []),
        // Generated cache/timing shims live here; needs GC coverage so that a
        // hook whose `cache:` field is removed gets its stale shim path purged
        // from the agent's settings file (see resolveHookCommand).
        getHookShimsDir() + path.sep,
      ];

  if (agentId === 'claude') {
    return registerHooksForClaude(versionHome, manifest, resolveScript, managedPrefixes);
  }
  if (agentId === 'droid') {
    // Droid's settings.json hooks schema is identical to Claude's (top-level
    // `hooks` object → event → matcher-group array), so reuse the Claude
    // registrar targeting `.factory/settings.json` (agentConfigDirName('droid')).
    return registerHooksForClaude(
      versionHome,
      manifest,
      resolveScript,
      managedPrefixes,
      agentConfigDirName('droid')
    );
  }
  if (agentId === 'muse') {
    // Muse Code: Claude-compatible hooks block in ~/.config/muse/settings.json
    // (events SessionStart / PreToolUse / …, matcher groups, command hooks).
    // settings.json MUST carry schema_version: 1 or Muse refuses to start.
    return registerHooksForClaude(
      versionHome,
      manifest,
      resolveScript,
      managedPrefixes,
      agentConfigDirName('muse'),
      { schemaVersion: 1 }
    );
  }
  if (agentId === 'codex') {
    return registerHooksForCodex(versionHome, manifest, resolveScript, managedPrefixes);
  }
  if (agentId === 'antigravity') {
    return registerHooksForAntigravity(versionHome, manifest, resolveScript, managedPrefixes);
  }
  if (agentId === 'grok') {
    return registerHooksForGrok(versionHome, manifest, resolveScript, managedPrefixes);
  }
  if (agentId === 'opencode') {
    return registerHooksForOpenCode(versionHome, manifest, resolveScript);
  }
  if (agentId === 'kimi') {
    return registerHooksForKimi(versionHome, manifest, resolveScript, managedPrefixes);
  }
  if (agentId === 'copilot') {
    return registerHooksForCopilot(versionHome, manifest, resolveScript, managedPrefixes);
  }
  if (agentId === 'goose') {
    return registerHooksForGoose(versionHome, manifest, resolveScript, managedPrefixes);
  }
  if (agentId === 'cursor') {
    return registerHooksForCursor(versionHome, manifest, resolveScript, managedPrefixes);
  }
  if (agentId === 'hermes') {
    return registerHooksForHermes(versionHome, manifest, resolveScript, managedPrefixes);
  }
  return { registered: [], errors: [] };
}

/**
 * The concrete config file(s) `registerHooksToSettings` writes for `agentId` in
 * `home` — the settings/registrar leaves, NOT the per-hook script copies. A
 * caller materializing into an UNTRUSTED home (the portable-agent materializer)
 * uses this to verify none of those leaves is a preplanted symlink before the
 * registrar follows it and overwrites a file outside the home.
 *
 * This MUST mirror the `registerHooksToSettings` dispatch above — each arm's
 * write target is reproduced here, so a new registrar branch adds its leaf here
 * too. It intentionally returns only the primary settings/registrar file(s); the
 * per-event/script files a registrar also writes live under the hooks dir the
 * caller already guards. An agent with no hooks registrar returns `[]`.
 */
export function hookRegistrationTargets(agentId: AgentId, home: string): string[] {
  switch (agentId) {
    case 'claude':
    case 'droid':
    case 'muse':
      return [path.join(home, agentConfigDirName(agentId), 'settings.json')];
    case 'codex':
      return [path.join(home, '.codex', 'hooks.json'), path.join(home, '.codex', 'config.toml')];
    case 'antigravity':
      return [path.join(home, '.gemini', 'antigravity-cli', 'settings.json')];
    case 'grok':
      return [path.join(home, '.grok', 'hooks', 'hooks.json')];
    case 'kimi':
      return [path.join(home, '.kimi-code', 'config.toml')];
    case 'copilot':
      return [path.join(home, '.copilot', 'hooks', COPILOT_MANAGED_HOOKS_FILE)];
    case 'goose':
      return [path.join(home, '.agents', 'plugins', GOOSE_MANAGED_PLUGIN_NAME, 'hooks', 'hooks.json')];
    case 'cursor':
      return [path.join(home, '.cursor', 'hooks.json')];
    case 'hermes':
      return [path.join(home, '.hermes', 'config.yaml')];
    case 'opencode':
      return [path.join(home, '.config', 'opencode', 'plugins', 'agents-cli-hooks.ts')];
    default:
      return [];
  }
}

const OPENCODE_DIRECT_EVENT_MAP: Record<string, string> = {
  PreToolUse: 'tool.execute.before',
  PostToolUse: 'tool.execute.after',
  UserPromptSubmit: 'chat.message',
};

const OPENCODE_LIFECYCLE_EVENT_MAP: Record<string, string[]> = {
  SessionStart: ['session.created'],
  SessionEnd: ['session.deleted'],
  Stop: ['session.idle', 'session.error'],
  PreCompact: ['session.compacted'],
  OnError: ['session.error'],
  Notification: ['permission.asked'],
};

type OpenCodeGeneratedHook = {
  name: string;
  command: string;
  timeout?: number;
  matcher?: string;
};

/**
 * Compile canonical hooks.yaml entries into a local OpenCode plugin.
 *
 * OpenCode has no declarative shell-hook config block. It auto-loads direct
 * TS/JS modules from ~/.config/opencode/plugins/, and supplies Bun's `$` shell
 * primitive to each plugin. The generated module subscribes to native plugin
 * events, sends the event payload to the managed hook script as JSON on stdin,
 * and surfaces a non-zero script exit as a plugin error.
 */
function registerHooksForOpenCode(
  versionHome: string,
  manifest: Record<string, ManifestHook>,
  resolveScript: (script: string) => string | null
): { registered: string[]; errors: string[] } {
  const registered: string[] = [];
  const errors: string[] = [];
  const direct = new Map<string, OpenCodeGeneratedHook[]>();
  const lifecycle = new Map<string, OpenCodeGeneratedHook[]>();

  for (const [name, hookDef] of Object.entries(manifest)) {
    if (!hookDef.events || hookDef.events.length === 0) continue;
    const command = resolveHookCommand(name, hookDef, resolveScript);
    if (!command) {
      errors.push(`${name}: script not found`);
      continue;
    }
    const generated = {
      name,
      command,
      ...(hookDef.timeout !== undefined ? { timeout: hookDef.timeout } : {}),
      ...(hookDef.matcher ? { matcher: hookDef.matcher } : {}),
    };
    for (const event of hookDef.events) {
      const directEvent = OPENCODE_DIRECT_EVENT_MAP[event];
      if (directEvent) {
        const hooks = direct.get(directEvent) ?? [];
        hooks.push(generated);
        direct.set(directEvent, hooks);
        registered.push(`${name} -> ${directEvent}`);
      }
      for (const lifecycleEvent of OPENCODE_LIFECYCLE_EVENT_MAP[event] ?? []) {
        const hooks = lifecycle.get(lifecycleEvent) ?? [];
        hooks.push(generated);
        lifecycle.set(lifecycleEvent, hooks);
        registered.push(`${name} -> ${lifecycleEvent}`);
      }
    }
  }

  const serializedDirect = JSON.stringify(Object.fromEntries(direct), null, 2);
  const serializedLifecycle = JSON.stringify(Object.fromEntries(lifecycle), null, 2);
  // Same disposable perf spool the bash shims (hooks/cache.ts) append to — see
  // the timedOut branch below for why OpenCode needs its own writer.
  const perfSpoolPath = path.join(getPerfDir(), 'spool.jsonl');
  const pluginSource = `// Generated by agents-cli. Re-run agents sync to update.
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

const directHooks = ${serializedDirect}
const lifecycleHooks = ${serializedLifecycle}
const PERF_SPOOL = ${JSON.stringify(perfSpoolPath)}

function recordTimeoutSample(hook, payload) {
  // hook.command already ran through a generated shim (hooks/cache.ts) that
  // writes its own hook.fire sample on exit — but Bun.spawn's child.kill()
  // below (SIGTERM) tears the shim down before it reaches that trailing
  // printf, so a timed-out fire would otherwise leave ZERO trace in the
  // warehouse. Write the sample ourselves from the side that knows it timed out.
  try {
    // path.dirname — not lastIndexOf('/') — so Windows backslash spool paths
    // still resolve to the parent dir (see #1869).
    fs.mkdirSync(path.dirname(PERF_SPOOL), { recursive: true })
    const line = JSON.stringify({
      ts_ms: Date.now(),
      kind: "hook.fire",
      label: hook.name,
      duration_ms: hook.timeout * 1000,
      cache: "none",
      exit_code: null,
      status: "timeout",
      cwd: payload && typeof payload.cwd === "string" ? payload.cwd : undefined,
      session_id: payload && typeof payload.session_id === "string" ? payload.session_id : undefined,
      hostname: (() => { try { return os.hostname() } catch { return "unknown" } })(),
    }) + "\\n"
    fs.appendFileSync(PERF_SPOOL, line)
  } catch {
    // best effort — never let sample recording break the timeout error path
  }
}

function matches(hook, tool) {
  if (!hook.matcher) return true
  try {
    return new RegExp(hook.matcher).test(tool)
  } catch {
    return hook.matcher === tool
  }
}

async function runHooks(hooks, payload, $, matchTool = false) {
  for (const hook of hooks ?? []) {
    if (matchTool && !matches(hook, payload.tool_name ?? "")) continue
    const input = JSON.stringify(payload)
    const home = Bun.env.HOME ?? Bun.env.USERPROFILE ?? ""
    const command = hook.command.startsWith("~/")
      ? \`\${home}/\${hook.command.slice(2)}\`
      : hook.command
    const shell = Bun.which("bash") ?? Bun.which("sh")
    if (!shell) throw new Error(\`\${hook.name} requires bash or sh\`)
    const execArgs = [shell, "-c", 'exec "$1"', "agents-hook", command]
    if (hook.timeout !== undefined) {
      const child = Bun.spawn(execArgs, {
        stdin: new Response(input),
        stdout: "ignore",
        stderr: "pipe",
      })
      let timedOut = false
      const timer = setTimeout(() => {
        timedOut = true
        if (process.platform === "win32") {
          Bun.spawnSync(["taskkill", "/PID", String(child.pid), "/T", "/F"])
        } else {
          child.kill()
        }
      }, hook.timeout * 1000)
      const exitCode = await child.exited.finally(() => clearTimeout(timer))
      const stderr = await new Response(child.stderr).text()
      if (timedOut) {
        recordTimeoutSample(hook, payload)
        throw new Error(\`\${hook.name} timed out after \${hook.timeout} seconds\`)
      }
      if (exitCode !== 0) {
        throw new Error(\`\${hook.name} failed with exit code \${exitCode}: \${stderr.trim()}\`)
      }
      continue
    }
    const result = await $\`\${shell} -c \${'exec "$1"'} \${"agents-hook"} \${command} < \${new Response(input)}\`.nothrow().quiet()
    if (result.exitCode !== 0) {
      throw new Error(\`\${hook.name} failed with exit code \${result.exitCode}: \${result.stderr.toString().trim()}\`)
    }
  }
}

export const AgentsCliHooks = async ({ $ }) => ({
  event: async ({ event }) => {
    await runHooks(lifecycleHooks[event.type], { hook_event_name: event.type, ...event }, $)
  },
  "chat.message": async (input, output) => {
    await runHooks(directHooks["chat.message"], { hook_event_name: "UserPromptSubmit", ...input, ...output }, $)
  },
  "tool.execute.before": async (input, output) => {
    await runHooks(directHooks["tool.execute.before"], { hook_event_name: "PreToolUse", tool_name: input.tool, tool_input: output.args, ...input }, $, true)
  },
  "tool.execute.after": async (input, output) => {
    await runHooks(directHooks["tool.execute.after"], { hook_event_name: "PostToolUse", tool_name: input.tool, tool_input: input.args, tool_response: output, ...input }, $, true)
  },
})
`;

  const pluginDir = path.join(versionHome, '.config', 'opencode', 'plugins');
  try {
    fs.mkdirSync(pluginDir, { recursive: true });
    fs.writeFileSync(path.join(pluginDir, 'agents-cli-hooks.ts'), pluginSource, 'utf-8');
  } catch (e) {
    errors.push(`Failed to write agents-cli-hooks.ts: ${(e as Error).message}`);
  }
  return { registered, errors };
}

/**
 * Antigravity (agy) event names differ from agents-cli manifest names. The
 * mapping below is the documented agy schema. PostToolUse has no exact
 * agy equivalent — agy fires `after_model_call` after the model finishes a
 * turn (which includes any tool calls in that turn), so it's the closest
 * lifecycle phase but not a 1:1 match. Manifest events not in this map are
 * skipped silently (the manifest may declare events for other agents).
 */
const ANTIGRAVITY_EVENT_MAP: Record<string, string> = {
  PreToolUse: 'before_tool_call',
  // Imperfect mapping: agy has no per-tool post-event. after_model_call
  // fires once at the end of the turn, after all tool calls completed.
  PostToolUse: 'after_model_call',
  Stop: 'on_loop_stop',
  OnError: 'on_error',
};

function registerHooksForClaude(
  versionHome: string,
  manifest: Record<string, ManifestHook>,
  resolveScript: (script: string) => string | null,
  managedPrefixes: string[],
  configDirName = '.claude',
  options?: { schemaVersion?: number }
): { registered: string[]; errors: string[] } {
  const registered: string[] = [];
  const errors: string[] = [];

  const configDir = path.join(versionHome, configDirName);
  const settingsPath = path.join(configDir, 'settings.json');

  let config: Record<string, unknown> = {};
  let existingRaw: string | undefined;
  if (fs.existsSync(settingsPath)) {
    try {
      existingRaw = fs.readFileSync(settingsPath, 'utf-8');
      config = JSON.parse(existingRaw);
    } catch {
      errors.push('Failed to parse settings.json');
      return { registered, errors };
    }
  }

  // Muse (and any future agent that pins a settings schema) requires this key.
  if (options?.schemaVersion !== undefined && config.schema_version === undefined) {
    config.schema_version = options.schemaVersion;
  }

  if (!config.hooks || typeof config.hooks !== 'object') {
    config.hooks = {};
  }
  const hooks = config.hooks as Record<string, unknown[]>;

  // Build set of all command paths the current manifest will register.
  // Used to garbage-collect stale entries left behind after hook renames
  // or after a `cache:` field is added/removed (raw script vs shim path).
  const currentManifestPaths = new Set<string>();
  for (const [hookName, hookDef] of Object.entries(manifest)) {
    if (!hookDef.events || hookDef.events.length === 0) continue;
    const resolved = resolveHookCommand(hookName, hookDef, resolveScript);
    if (resolved) currentManifestPaths.add(resolved);
  }

  // Identity of the version home being synced. Used to prune entries that point
  // at a DIFFERENT version home of the same agent (see isStaleSiblingVersionCommand).
  const currentVh = versionHomeIdentity(versionHome);

  // Remove stale entries: any hook command under a managed root that isn't in
  // the current manifest is a leftover from a renamed/deleted hook script; any
  // command pointing at a sibling version's home is a leftover from that
  // version's sync (its version-scoped path never matches the current set).
  for (const eventEntries of Object.values(hooks)) {
    if (!Array.isArray(eventEntries)) continue;
    for (const group of eventEntries as Array<{
      matcher?: string;
      hooks?: Array<{ type: string; command: string; timeout?: number }>;
    }>) {
      if (!group.hooks) continue;
      const managed = group.hooks.filter(
        (h) =>
          (!isManagedHookCommand(h.command, managedPrefixes) || currentManifestPaths.has(h.command)) &&
          !isStaleSiblingVersionCommand(h.command, currentVh)
      );
      group.hooks = collapseVersionHookEntries(managed, versionHome);
    }
  }

  // Remove empty matcher groups left after cleanup
  for (const [event, eventEntries] of Object.entries(hooks)) {
    if (!Array.isArray(eventEntries)) continue;
    hooks[event] = (eventEntries as Array<{ hooks?: unknown[] }>).filter(
      (g) => g.hooks && g.hooks.length > 0
    );
  }

  for (const [name, hookDef] of Object.entries(manifest)) {
    if (!hookDef.events || hookDef.events.length === 0) continue;

    const commandPath = resolveHookCommand(name, hookDef, resolveScript);
    if (!commandPath) {
      errors.push(`${name}: script not found in user or system hooks dir`);
      continue;
    }

    for (const event of hookDef.events) {
      if (!hooks[event]) {
        hooks[event] = [];
      }

      const eventEntries = hooks[event] as Array<{
        matcher?: string;
        hooks?: Array<{ type: string; command: string; timeout?: number }>;
      }>;

      const matcher = hookDef.matcher || '';
      const timeout = hookDef.timeout || 600;

      let matcherGroup = eventEntries.find((e) => (e.matcher || '') === matcher);
      if (!matcherGroup) {
        matcherGroup = { matcher, hooks: [] };
        eventEntries.push(matcherGroup);
      }

      if (!matcherGroup.hooks) {
        matcherGroup.hooks = [];
      }

      const existingIdx = matcherGroup.hooks.findIndex((h) => h.command === commandPath);
      const hookEntry = { type: 'command' as const, command: commandPath, timeout };

      if (existingIdx >= 0) {
        matcherGroup.hooks[existingIdx] = hookEntry;
      } else {
        matcherGroup.hooks.push(hookEntry);
      }

      registered.push(`${name} -> ${event}`);
    }
  }

  try {
    fs.mkdirSync(configDir, { recursive: true });
    const nextRaw = JSON.stringify(config, null, 2);
    if (existingRaw !== nextRaw) {
      fs.writeFileSync(settingsPath, nextRaw, 'utf-8');
    }
  } catch (err) {
    errors.push(`Failed to write settings.json: ${(err as Error).message}`);
  }

  return { registered, errors };
}

/**
 * Prune every Claude-family (`settings.json`) hook entry whose command lives
 * under a removed version's home
 * (`~/.agents/.history/versions/<agent>/<removedVersion>/home/…`).
 *
 * `agents remove <agent>@<version>` soft-deletes the version's files but leaves
 * the hook entries other version homes registered against it — dead hooks that
 * error on every tool call ("No such file or directory") until the next sync.
 * This clears them from a remaining version's settings immediately. Only the
 * removed version's entries are touched; the current version's entries, system
 * hooks, and the user's own custom hooks are left intact. Returns the number of
 * entries removed.
 */
export function pruneVersionHomeHookEntriesFromSettings(
  settingsPath: string,
  agent: AgentId,
  removedVersion: string
): number {
  if (!fs.existsSync(settingsPath)) return 0;

  let config: Record<string, unknown>;
  try {
    config = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
  } catch {
    return 0;
  }
  if (!config.hooks || typeof config.hooks !== 'object') return 0;
  const hooks = config.hooks as Record<string, unknown[]>;

  let removed = 0;
  for (const eventEntries of Object.values(hooks)) {
    if (!Array.isArray(eventEntries)) continue;
    for (const group of eventEntries as Array<{ hooks?: Array<{ command: string }> }>) {
      if (!group.hooks) continue;
      const before = group.hooks.length;
      group.hooks = group.hooks.filter((h) => {
        const id = versionHomeIdentity(h.command);
        return !(id !== null && id.agent === agent && id.version === removedVersion);
      });
      removed += before - group.hooks.length;
    }
  }
  if (removed === 0) return 0;

  // Drop matcher groups left empty by the prune.
  for (const [event, eventEntries] of Object.entries(hooks)) {
    if (!Array.isArray(eventEntries)) continue;
    hooks[event] = (eventEntries as Array<{ hooks?: unknown[] }>).filter(
      (g) => g.hooks && g.hooks.length > 0
    );
  }

  try {
    fs.writeFileSync(settingsPath, JSON.stringify(config, null, 2), 'utf-8');
  } catch {
    // Best-effort cleanup: a write failure leaves the dead entry to be pruned
    // on the next sync (see isStaleSiblingVersionCommand).
    return 0;
  }
  return removed;
}

function trustCodexHooks(hooksPath: string): void {
  const configPath = path.join(path.dirname(hooksPath), 'config.toml');
  const hooksFile = JSON.parse(fs.readFileSync(hooksPath, 'utf-8')) as CodexHooksFile;
  let tomlConfig: Record<string, unknown> = {};
  if (fs.existsSync(configPath)) {
    tomlConfig = TOML.parse(fs.readFileSync(configPath, 'utf-8')) as Record<string, unknown>;
  }

  if (!tomlConfig.features || typeof tomlConfig.features !== 'object') {
    tomlConfig.features = {};
  }
  // Codex 0.116+ feature flag is `hooks` (the legacy `codex_hooks` name is
  // an unrecognized key that triggers a deprecation error and is ignored).
  const features = tomlConfig.features as Record<string, unknown>;
  delete features.codex_hooks;
  features.hooks = true;

  // Pre-trust hooks. The [hooks.state] key is keyed by the hooks.json path
  // exactly as Codex resolves it (the absolute CODEX_HOME path), the
  // snake_case event label, and the per-event group/handler indices — which
  // must match Codex's parse order, so we iterate the just-written
  // hooksFile structure in array order.
  if (!tomlConfig.hooks || typeof tomlConfig.hooks !== 'object') {
    tomlConfig.hooks = {};
  }
  const hooksTable = tomlConfig.hooks as Record<string, unknown>;
  const existingState =
    hooksTable.state && typeof hooksTable.state === 'object'
      ? (hooksTable.state as Record<string, { enabled?: boolean; trusted_hash?: string }>)
      : {};
  const hookState: Record<string, { enabled?: boolean; trusted_hash?: string }> = {};

  for (const [event, eventGroups] of Object.entries(hooksFile.hooks)) {
    const eventKeyLabel = CODEX_EVENT_KEY_LABELS[event];
    if (!eventKeyLabel) continue;
    eventGroups.forEach((group, groupIdx) => {
      if (!group.hooks) return;
      group.hooks.forEach((handler, handlerIdx) => {
        if (handler.type !== 'command') return;
        const key = `${hooksPath}:${eventKeyLabel}:${groupIdx}:${handlerIdx}`;
        const trustedHash = computeCodexHookTrustHash(
          eventKeyLabel,
          handler.command,
          handler.timeout,
          group.matcher
        );
        // Preserve a user's explicit `enabled = false` for this exact hook;
        // only (re)write the trust hash.
        const prior = existingState[key];
        const entry: { enabled?: boolean; trusted_hash?: string } = { trusted_hash: trustedHash };
        if (prior && prior.enabled === false) {
          entry.enabled = false;
        }
        hookState[key] = entry;
      });
    });
  }

  // Carry forward trust state for any hooks we did not (re)register this
  // pass — e.g. user-added hooks under a different command path.
  for (const [key, entry] of Object.entries(existingState)) {
    if (!(key in hookState)) {
      hookState[key] = entry;
    }
  }

  hooksTable.state = hookState;

  fs.writeFileSync(configPath, TOML.stringify(tomlConfig as Parameters<typeof TOML.stringify>[0]), 'utf-8');
}

function registerHooksForCodex(
  versionHome: string,
  manifest: Record<string, ManifestHook>,
  resolveScript: (script: string) => string | null,
  managedPrefixes: string[]
): { registered: string[]; errors: string[] } {
  const registered: string[] = [];
  const errors: string[] = [];

  const configDir = path.join(versionHome, '.codex');
  const hooksPath = path.join(configDir, 'hooks.json');

  // Read existing hooks.json — must have top-level "hooks" wrapper key
  let hooksFile: CodexHooksFile = { hooks: {} };
  if (fs.existsSync(hooksPath)) {
    try {
      const existing = JSON.parse(fs.readFileSync(hooksPath, 'utf-8'));
      if (
        existing &&
        typeof existing === 'object' &&
        !Array.isArray(existing) &&
        existing.hooks &&
        typeof existing.hooks === 'object'
      ) {
        hooksFile = existing as CodexHooksFile;
      }
    } catch {
      errors.push('Failed to parse hooks.json');
      return { registered, errors };
    }
  }

  // Build set of current manifest command paths for codex to GC stale entries.
  // Uses resolveHookCommand so cached hooks resolve to their shim path.
  const currentManifestPaths = new Set<string>();
  for (const [hookName, hookDef] of Object.entries(manifest)) {
    if (!hookDef.events || hookDef.events.length === 0) continue;
    const resolved = resolveHookCommand(hookName, hookDef, resolveScript);
    if (resolved) currentManifestPaths.add(resolved);
  }

  // Identity of the version home being synced. Codex stores hooks in a shared
  // hooks.json per CODEX_HOME, but agents-cli registers version-scoped command
  // paths; without this, old version entries keep firing after upgrades.
  const currentVh = versionHomeIdentity(versionHome);

  // Remove stale entries from all event groups
  for (const eventGroups of Object.values(hooksFile.hooks)) {
    for (const group of eventGroups) {
      if (!group.hooks) continue;
      const managed = group.hooks.filter(
        (h) =>
          (!isManagedHookCommand(h.command, managedPrefixes) || currentManifestPaths.has(h.command)) &&
          !isStaleSiblingVersionCommand(h.command, currentVh)
      );
      group.hooks = collapseVersionHookEntries(managed, versionHome);
    }
  }
  for (const [event, eventGroups] of Object.entries(hooksFile.hooks)) {
    hooksFile.hooks[event] = eventGroups.filter((g) => g.hooks && g.hooks.length > 0);
  }

  for (const [name, hookDef] of Object.entries(manifest)) {
    if (!hookDef.events || hookDef.events.length === 0) continue;

    const commandPath = resolveHookCommand(name, hookDef, resolveScript);
    if (!commandPath) {
      errors.push(`${name}: script not found in user or system hooks dir`);
      continue;
    }

    const timeout = hookDef.timeout || 600;

    for (const event of hookDef.events) {
      if (!hooksFile.hooks[event]) {
        hooksFile.hooks[event] = [];
      }

      const eventGroups = hooksFile.hooks[event];

      // PreToolUse / PostToolUse / SessionStart use a matcher field.
      // UserPromptSubmit / Stop never include a matcher.
      const usesMatcher = CODEX_MATCHER_EVENTS.has(event);
      const matcherValue = usesMatcher ? (hookDef.matcher ?? '') : undefined;

      // Find the group for this matcher (or the sole no-matcher group)
      let group: CodexMatcherGroup | undefined;
      if (matcherValue !== undefined) {
        group = eventGroups.find((g) => (g.matcher ?? '') === matcherValue);
        if (!group) {
          group = matcherValue ? { matcher: matcherValue, hooks: [] } : { hooks: [] };
          eventGroups.push(group);
        }
      } else {
        group = eventGroups.find((g) => g.matcher === undefined);
        if (!group) {
          group = { hooks: [] };
          eventGroups.push(group);
        }
      }

      if (!group.hooks) {
        group.hooks = [];
      }

      const existingIdx = group.hooks.findIndex((h) => h.command === commandPath);
      const eventTimeout = event === 'SessionEnd' ? Math.min(timeout, 3) : timeout;
      const hookEntry = { type: 'command', command: commandPath, timeout: eventTimeout };

      if (existingIdx >= 0) {
        group.hooks[existingIdx] = hookEntry;
      } else {
        group.hooks.push(hookEntry);
      }

      registered.push(`${name} -> ${event}`);
    }
  }

  if (registered.length === 0) {
    return { registered, errors };
  }

  try {
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(hooksPath, JSON.stringify(hooksFile, null, 2), 'utf-8');
  } catch (err) {
    errors.push(`Failed to write hooks.json: ${(err as Error).message}`);
    return { registered, errors };
  }

  // Ensure [features] hooks = true and pre-trust every registered hook in
  // config.toml. Codex only runs hooks that are enabled AND trusted; in
  // non-interactive (`codex exec`) mode there is no TUI prompt to approve
  // them, so an untrusted hook is silently dropped. We compute the same
  // trust hash Codex would and persist it under [hooks.state].
  try {
    trustCodexHooks(hooksPath);
  } catch (err) {
    errors.push(`Failed to update config.toml: ${(err as Error).message}`);
  }

  return { registered, errors };
}

/**
 * Register hooks into antigravity's (agy) settings.json. Unlike gemini, agy uses
 * a flat per-event array of `{ command }` entries (no matcher groups). Events
 * are renamed via ANTIGRAVITY_EVENT_MAP; unmapped manifest events are skipped.
 *
 * settings.json lives at `${versionHome}/.gemini/antigravity-cli/settings.json`
 * because agy nests its config under the shared `.gemini` parent dir.
 */
function registerHooksForAntigravity(
  versionHome: string,
  manifest: Record<string, ManifestHook>,
  resolveScript: (script: string) => string | null,
  managedPrefixes: string[]
): { registered: string[]; errors: string[] } {
  const registered: string[] = [];
  const errors: string[] = [];

  const configDir = path.join(versionHome, '.gemini', 'antigravity-cli');
  const settingsPath = path.join(configDir, 'settings.json');

  let config: Record<string, unknown> = {};
  if (fs.existsSync(settingsPath)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        config = parsed as Record<string, unknown>;
      }
    } catch {
      errors.push('Failed to parse antigravity settings.json');
      return { registered, errors };
    }
  }

  if (!config.hooks || typeof config.hooks !== 'object' || Array.isArray(config.hooks)) {
    config.hooks = {};
  }
  const hooks = config.hooks as Record<string, unknown[]>;

  // Build set of all command paths the current manifest will register, so we
  // can garbage-collect stale managed entries left over from renamed/deleted
  // hooks. Only managed paths are considered for removal — user-added entries
  // outside managedPrefixes are preserved.
  const currentManifestPaths = new Set<string>();
  for (const [hookName, hookDef] of Object.entries(manifest)) {
    if (!hookDef.events || hookDef.events.length === 0) continue;
    // Only paths whose events map to a known agy event would actually be
    // registered, so only those should survive GC.
    const anyMapped = hookDef.events.some((e) => ANTIGRAVITY_EVENT_MAP[e]);
    if (!anyMapped) continue;
    const resolved = resolveHookCommand(hookName, hookDef, resolveScript);
    if (resolved) currentManifestPaths.add(resolved);
  }

  for (const eventKey of Object.keys(hooks)) {
    const entries = hooks[eventKey];
    if (!Array.isArray(entries)) continue;
    hooks[eventKey] = entries.filter((entry) => {
      if (!entry || typeof entry !== 'object') return true;
      const cmd = (entry as { command?: unknown }).command;
      if (typeof cmd !== 'string') return true;
      if (!isManagedHookCommand(cmd, managedPrefixes)) return true;
      return currentManifestPaths.has(cmd);
    });
    if ((hooks[eventKey] as unknown[]).length === 0) {
      delete hooks[eventKey];
    }
  }

  for (const [name, hookDef] of Object.entries(manifest)) {
    if (!hookDef.events || hookDef.events.length === 0) continue;

    const commandPath = resolveHookCommand(name, hookDef, resolveScript);
    if (!commandPath) {
      errors.push(`${name}: script not found in user or system hooks dir`);
      continue;
    }

    for (const event of hookDef.events) {
      const agyEvent = ANTIGRAVITY_EVENT_MAP[event];
      if (!agyEvent) continue; // unmapped event — silently skip

      if (!hooks[agyEvent]) {
        hooks[agyEvent] = [];
      }
      // Antigravity settings entries: command + optional matcher (tool scope).
      // Without matcher every PreToolUse guard fires on ALL tools (RUSH-1353).
      const list = hooks[agyEvent] as Array<{ command: string; matcher?: string }>;

      const existingIdx = list.findIndex(
        (e) => e && typeof e === 'object' && e.command === commandPath
      );
      const entry: { command: string; matcher?: string } = { command: commandPath };
      if (hookDef.matcher) entry.matcher = hookDef.matcher;
      if (existingIdx >= 0) {
        list[existingIdx] = entry;
      } else {
        list.push(entry);
      }

      registered.push(`${name} -> ${agyEvent}`);
    }
  }

  try {
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(settingsPath, JSON.stringify(config, null, 2) + '\n', 'utf-8');
  } catch (err) {
    errors.push(`Failed to write antigravity settings.json: ${(err as Error).message}`);
  }

  return { registered, errors };
}

/**
 * Grok events that accept a `matcher` field. Per the Grok hooks guide
 * (docs/user-guide/10-hooks.md, "Key Fields"): the matcher applies to the tool
 * events — `PreToolUse`, `PostToolUse`, `PostToolUseFailure`, `PermissionDenied`
 * (matches the tool name) — and to `Notification` (matches the notification
 * type). The lifecycle events `SessionStart`, `SessionEnd`, `Stop`,
 * `UserPromptSubmit` REJECT a matcher (they raise loading errors); other events
 * ignore it. Of the events this registrar emits (see GROK_EVENT_MAP), only these
 * three accept a matcher, so we emit it for these alone.
 */
const GROK_MATCHER_EVENTS = new Set(['PreToolUse', 'PostToolUse', 'Notification']);

/**
 * Tool-name matcher aliases for tools Grok does NOT auto-alias. Grok maps common
 * Claude tool names to its own (Bash → run_terminal_command, Read → read_file,
 * etc. — docs/user-guide/10-hooks.md, "Tool Name Aliases") and "a matcher keeps
 * its original name too", so most matchers need no translation. But there is no
 * alias for `ExitPlanMode`: Grok's plan tools are `enter_plan_mode` /
 * `exit_plan_mode` (docs/user-guide/19-plan-mode.md line 14), so a bare
 * `ExitPlanMode` matcher would never fire. Broaden it to a regex that matches
 * both names. Keep this an explicit, minimal map — not a general translation
 * engine.
 */
const GROK_MATCHER_ALIASES: Record<string, string> = {
  ExitPlanMode: 'ExitPlanMode|exit_plan_mode',
};

/**
 * Register hooks for Grok Build.
 *
 * Grok merges ALL of `~/.grok/hooks/*.json` (docs/user-guide/10-hooks.md, "Hook
 * Locations"), so this registrar writes exactly ONE manifest file, `hooks.json`,
 * and prunes any stale per-event files (`pretooluse.json`, …) that an older
 * build wrote — otherwise every hook would run twice per event, forever, on
 * already-synced installs.
 *
 * Matchers are grouped one-per-distinct-matcher (like the Claude writer) and are
 * emitted only for the events that accept them (GROK_MATCHER_EVENTS); tool-name
 * matchers Grok does not auto-alias are translated via GROK_MATCHER_ALIASES.
 */
function registerHooksForGrok(
  versionHome: string,
  manifest: Record<string, ManifestHook>,
  resolveScript: (script: string) => string | null,
  managedPrefixes: string[]
): { registered: string[]; errors: string[] } {
  const registered: string[] = [];
  const errors: string[] = [];

  const grokHooksDir = path.join(versionHome, '.grok', 'hooks');
  fs.mkdirSync(grokHooksDir, { recursive: true });

  const eventMap: Record<string, string> = {
    SessionStart: 'SessionStart',
    SessionEnd: 'SessionEnd',
    UserPromptSubmit: 'UserPromptSubmit',
    PreToolUse: 'PreToolUse',
    PostToolUse: 'PostToolUse',
    PreCompact: 'PreCompact',
    Stop: 'Stop',
    Notification: 'Notification',
  };

  type GrokGroup = {
    matcher?: string;
    hooks: Array<{ type: 'command'; command: string; timeout: number }>;
  };
  const grokHooks: { hooks: Record<string, GrokGroup[]> } = { hooks: {} };

  for (const [name, hookDef] of Object.entries(manifest)) {
    if (!hookDef.events || hookDef.events.length === 0) continue;

    const commandPath = resolveHookCommand(name, hookDef, resolveScript);
    if (!commandPath) {
      errors.push(`${name}: script not found`);
      continue;
    }

    const timeout = hookDef.timeout ?? 30;

    for (const ev of hookDef.events) {
      const grokEvent = eventMap[ev] || ev;

      if (!grokHooks.hooks[grokEvent]) {
        grokHooks.hooks[grokEvent] = [];
      }
      const groups = grokHooks.hooks[grokEvent];

      // Emit the matcher only for events that accept one; translate tool names
      // Grok does not auto-alias. Empty/omitted matcher matches everything.
      let matcher: string | undefined;
      if (GROK_MATCHER_EVENTS.has(grokEvent) && hookDef.matcher) {
        matcher = GROK_MATCHER_ALIASES[hookDef.matcher] ?? hookDef.matcher;
      }

      // Group by matcher the way the Claude writer does: one group per distinct
      // matcher, hooks appended into the group — not one group per hook.
      let group = groups.find((g) => (g.matcher ?? '') === (matcher ?? ''));
      if (!group) {
        group = matcher ? { matcher, hooks: [] } : { hooks: [] };
        groups.push(group);
      }

      const hookEntry = { type: 'command' as const, command: commandPath, timeout };
      const existingIdx = group.hooks.findIndex((h) => h.command === commandPath);
      if (existingIdx >= 0) {
        group.hooks[existingIdx] = hookEntry;
      } else {
        group.hooks.push(hookEntry);
      }

      registered.push(`${name} -> ${grokEvent}`);
    }
  }

  // Single source of truth: hooks.json. Written fresh from the manifest every
  // sync, so the registrar owns it outright.
  const mainHooksPath = path.join(grokHooksDir, 'hooks.json');
  try {
    fs.writeFileSync(mainHooksPath, JSON.stringify(grokHooks, null, 2));
  } catch (e) {
    errors.push(`Failed to write hooks.json: ${(e as Error).message}`);
  }

  // Clean up stale per-event files (pretooluse.json, session-start.json, …) that
  // older builds double-wrote. Grok merges every *.json in this dir, so leaving
  // them would run each hook twice per event. Only remove files whose contents
  // are entirely managed by us (a lone `hooks` object referencing our managed
  // command paths); a user's own custom *.json is left untouched.
  try {
    for (const file of fs.readdirSync(grokHooksDir)) {
      if (!file.endsWith('.json') || file === 'hooks.json') continue;
      const filePath = path.join(grokHooksDir, file);
      if (isManagedGrokHookFile(filePath, managedPrefixes)) {
        fs.rmSync(filePath, { force: true });
      }
    }
  } catch (e) {
    errors.push(`Failed to prune stale grok hook files: ${(e as Error).message}`);
  }

  return { registered, errors };
}

/**
 * A per-event Grok hook file is "ours" (safe to prune) when it is a
 * `{ hooks: { <Event>: [...] } }` document in which every command entry points
 * at a managed path (see isManagedHookCommand). This is exactly the shape older
 * builds double-wrote; a user's hand-authored *.json that mixes in unmanaged
 * commands is preserved. A file we can't parse is treated as not-ours.
 */
function isManagedGrokHookFile(filePath: string, managedPrefixes: string[]): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch {
    return false;
  }
  if (!parsed || typeof parsed !== 'object') return false;
  const hooks = (parsed as { hooks?: unknown }).hooks;
  if (!hooks || typeof hooks !== 'object' || Array.isArray(hooks)) return false;

  const commands: string[] = [];
  for (const groups of Object.values(hooks as Record<string, unknown>)) {
    if (!Array.isArray(groups)) return false;
    for (const group of groups) {
      const entries = (group as { hooks?: unknown }).hooks;
      if (!Array.isArray(entries)) return false;
      for (const entry of entries) {
        const cmd = (entry as { command?: unknown }).command;
        if (typeof cmd !== 'string') return false;
        commands.push(cmd);
      }
    }
  }
  if (commands.length === 0) return false;
  return commands.every((cmd) => isManagedHookCommand(cmd, managedPrefixes));
}

function registerHooksForKimi(
  versionHome: string,
  manifest: Record<string, ManifestHook>,
  resolveScript: (script: string) => string | null,
  managedPrefixes: string[]
): { registered: string[]; errors: string[] } {
  const registered: string[] = [];
  const errors: string[] = [];

  const configPath = path.join(versionHome, '.kimi-code', 'config.toml');

  // Read existing config.toml
  let config: Record<string, unknown> = {};
  if (fs.existsSync(configPath)) {
    try {
      config = TOML.parse(fs.readFileSync(configPath, 'utf-8')) as Record<string, unknown>;
    } catch {
      errors.push('Failed to parse config.toml');
      return { registered, errors };
    }
  }

  // Build set of current manifest command paths for GC
  const currentManifestPaths = new Set<string>();
  for (const [hookName, hookDef] of Object.entries(manifest)) {
    if (!hookDef.events || hookDef.events.length === 0) continue;
    const resolved = resolveHookCommand(hookName, hookDef, resolveScript);
    if (resolved) currentManifestPaths.add(resolved);
  }

  // Remove stale managed hooks from existing hooks array
  let hooksArray: Array<Record<string, unknown>> = [];
  if (Array.isArray(config.hooks)) {
    hooksArray = config.hooks as Array<Record<string, unknown>>;
  }

  const filteredHooks = hooksArray.filter((h) => {
    const cmd = typeof h.command === 'string' ? h.command : '';
    if (!cmd) return true;
    if (!isManagedHookCommand(cmd, managedPrefixes)) return true;
    return currentManifestPaths.has(cmd);
  });

  // Add/update hooks from manifest
  for (const [name, hookDef] of Object.entries(manifest)) {
    if (!hookDef.events || hookDef.events.length === 0) continue;

    const commandPath = resolveHookCommand(name, hookDef, resolveScript);
    if (!commandPath) {
      errors.push(`${name}: script not found in user or system hooks dir`);
      continue;
    }

    const timeout = hookDef.timeout ?? 30;

    for (const event of hookDef.events) {
      const matcher = hookDef.matcher;

      // Find existing hook with same event, command, and matcher
      const existingIdx = filteredHooks.findIndex((h) => {
        const sameEvent = h.event === event;
        const sameCmd = h.command === commandPath;
        const sameMatcher = (h.matcher ?? '') === (matcher ?? '');
        return sameEvent && sameCmd && sameMatcher;
      });

      const hookEntry: Record<string, unknown> = {
        event,
        command: commandPath,
        timeout,
      };
      if (matcher) {
        hookEntry.matcher = matcher;
      }

      if (existingIdx >= 0) {
        filteredHooks[existingIdx] = hookEntry;
      } else {
        filteredHooks.push(hookEntry);
      }

      registered.push(`${name} -> ${event}`);
    }
  }

  config.hooks = filteredHooks;

  try {
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, TOML.stringify(config as Parameters<typeof TOML.stringify>[0]), 'utf-8');
  } catch (err) {
    errors.push(`Failed to write config.toml: ${(err as Error).message}`);
  }

  return { registered, errors };
}


/**
 * Canonical hooks.yaml event names → Copilot camelCase event names.
 * Copilot accepts both camelCase (native) and PascalCase (VS Code-compatible).
 * We emit camelCase, the format documented at
 * https://docs.github.com/en/copilot/reference/hooks-configuration.
 * Unmapped events are skipped so a Claude-only event does not land in the file.
 */
const COPILOT_EVENT_MAP: Record<string, string> = {
  SessionStart: 'sessionStart',
  SessionEnd: 'sessionEnd',
  UserPromptSubmit: 'userPromptSubmitted',
  PreToolUse: 'preToolUse',
  PostToolUse: 'postToolUse',
  PostToolUseFailure: 'postToolUseFailure',
  Stop: 'agentStop',
  SubagentStart: 'subagentStart',
  SubagentStop: 'subagentStop',
  OnError: 'errorOccurred',
  PreCompact: 'preCompact',
  Notification: 'notification',
  PermissionRequest: 'permissionRequest',
};

/**
 * Copilot events that accept a `matcher` field (regex, full-string match).
 * See "Matcher filtering" in the Copilot hooks reference.
 */
const COPILOT_MATCHER_EVENTS = new Set([
  'preToolUse',
  'postToolUse',
  'permissionRequest',
  'preCompact',
  'notification',
  'subagentStart',
]);

/** Managed filename under ~/.copilot/hooks/ — we own this file entirely. */
const COPILOT_MANAGED_HOOKS_FILE = 'agents-cli-hooks.json';

/**
 * Register hooks for GitHub Copilot CLI.
 *
 * Copilot loads every `*.json` under `~/.copilot/hooks/` (and project
 * `.github/hooks/`). Schema: `{ "version": 1, "hooks": { event: [entries] } }`
 * with command entries `{ type: "command", bash|command, timeoutSec?, matcher? }`.
 *
 * We rewrite a single managed file (`agents-cli-hooks.json`) on every sync so
 * GC is trivial — user-authored sibling JSON files are never touched.
 */
function registerHooksForCopilot(
  versionHome: string,
  manifest: Record<string, ManifestHook>,
  resolveScript: (script: string) => string | null,
  _managedPrefixes: string[]
): { registered: string[]; errors: string[] } {
  const registered: string[] = [];
  const errors: string[] = [];

  const copilotHooksDir = path.join(versionHome, '.copilot', 'hooks');
  fs.mkdirSync(copilotHooksDir, { recursive: true });

  type CopilotEntry = {
    type: 'command';
    command: string;
    timeoutSec: number;
    matcher?: string;
  };
  const hooks: Record<string, CopilotEntry[]> = {};

  for (const [name, hookDef] of Object.entries(manifest)) {
    if (!hookDef.events || hookDef.events.length === 0) continue;

    const commandPath = resolveHookCommand(name, hookDef, resolveScript);
    if (!commandPath) {
      errors.push(`${name}: script not found in user or system hooks dir`);
      continue;
    }

    const timeoutSec = hookDef.timeout ?? 30;

    for (const event of hookDef.events) {
      const copilotEvent = COPILOT_EVENT_MAP[event];
      if (!copilotEvent) continue; // unmapped — skip silently

      if (!hooks[copilotEvent]) hooks[copilotEvent] = [];

      const entry: CopilotEntry = {
        type: 'command',
        command: commandPath,
        timeoutSec,
      };
      if (COPILOT_MATCHER_EVENTS.has(copilotEvent) && hookDef.matcher) {
        entry.matcher = hookDef.matcher;
      }

      // De-dupe on (event, command, matcher) so repeated sync is idempotent.
      const existingIdx = hooks[copilotEvent].findIndex(
        (h) => h.command === entry.command && (h.matcher ?? '') === (entry.matcher ?? '')
      );
      if (existingIdx >= 0) {
        hooks[copilotEvent][existingIdx] = entry;
      } else {
        hooks[copilotEvent].push(entry);
      }

      registered.push(`${name} -> ${copilotEvent}`);
    }
  }

  const outPath = path.join(copilotHooksDir, COPILOT_MANAGED_HOOKS_FILE);
  try {
    // Always rewrite: empty manifest → empty hooks object (GC of prior managed entries).
    fs.writeFileSync(
      outPath,
      JSON.stringify({ version: 1, hooks }, null, 2) + '\n',
      'utf-8'
    );
  } catch (err) {
    errors.push(`Failed to write ${COPILOT_MANAGED_HOOKS_FILE}: ${(err as Error).message}`);
  }

  return { registered, errors };
}







/**
 * Canonical hooks.yaml event names that goose supports (Open Plugins PascalCase).
 * Unmapped events are skipped. Goose ≥ 1.34.0.
 */
const GOOSE_EVENT_MAP: Record<string, string> = {
  SessionStart: 'SessionStart',
  SessionEnd: 'SessionEnd',
  Stop: 'Stop',
  UserPromptSubmit: 'UserPromptSubmit',
  PreToolUse: 'PreToolUse',
  PostToolUse: 'PostToolUse',
  PostToolUseFailure: 'PostToolUseFailure',
  BeforeReadFile: 'BeforeReadFile',
  AfterFileEdit: 'AfterFileEdit',
  BeforeShellExecution: 'BeforeShellExecution',
  AfterShellExecution: 'AfterShellExecution',
  // SubagentStart/SubagentStop are not emitted by Goose — do not advertise them.
};

/** Managed Open Plugins directory name under ~/.agents/plugins/. */
const GOOSE_MANAGED_PLUGIN_NAME = 'agents-cli-hooks';

/**
 * Register hooks for Goose (block-goose-cli ≥ 1.34.0).
 *
 * Goose auto-discovers Open Plugins under `$HOME/.agents/plugins/<name>/` that
 * contain `hooks/hooks.json` (HOME is the version home under the agents-cli
 * shim). Schema (Open Plugins / Claude-shaped):
 *   { "hooks": { Event: [ { matcher?, hooks: [{ type: "command", command }] } ] } }
 *
 * We own a single managed plugin (`agents-cli-hooks`) under the version home
 * and rewrite its hooks.json on every sync. Command paths are absolute
 * (portable ~/ form) pointing at the already-copied hook scripts.
 */
function registerHooksForGoose(
  versionHome: string,
  manifest: Record<string, ManifestHook>,
  resolveScript: (script: string) => string | null,
  _managedPrefixes: string[]
): { registered: string[]; errors: string[] } {
  const registered: string[] = [];
  const errors: string[] = [];

  type GooseCmd = { type: 'command'; command: string; timeout?: number };
  type GooseGroup = { matcher?: string; hooks: GooseCmd[] };
  const eventHooks: Record<string, GooseGroup[]> = {};

  for (const [name, hookDef] of Object.entries(manifest)) {
    if (!hookDef.events || hookDef.events.length === 0) continue;

    const commandPath = resolveHookCommand(name, hookDef, resolveScript);
    if (!commandPath) {
      errors.push(`${name}: script not found in user or system hooks dir`);
      continue;
    }

    const timeout = hookDef.timeout ?? 60;
    const cmd: GooseCmd = { type: 'command', command: commandPath, timeout };

    for (const event of hookDef.events) {
      const gooseEvent = GOOSE_EVENT_MAP[event];
      if (!gooseEvent) continue;

      if (!eventHooks[gooseEvent]) eventHooks[gooseEvent] = [];
      const groups = eventHooks[gooseEvent];
      const matcher = hookDef.matcher || undefined;

      let group = groups.find((g) => (g.matcher || undefined) === matcher);
      if (!group) {
        group = { hooks: [] };
        if (matcher) group.matcher = matcher;
        groups.push(group);
      }

      const existingIdx = group.hooks.findIndex((h) => h.command === cmd.command);
      if (existingIdx >= 0) {
        group.hooks[existingIdx] = cmd;
      } else {
        group.hooks.push(cmd);
      }

      registered.push(`${name} -> ${gooseEvent}`);
    }
  }

  // Goose discovers Open Plugins at ~/.agents/plugins/<name>/ when HOME is the
  // version home (shim sets HOME). Write under versionHome so each installed
  // goose version gets its own managed plugin and tests stay hermetic.
  const pluginRoot = path.join(versionHome, '.agents', 'plugins', GOOSE_MANAGED_PLUGIN_NAME);
  const hooksDir = path.join(pluginRoot, 'hooks');
  const outPath = path.join(hooksDir, 'hooks.json');

  try {
    fs.mkdirSync(hooksDir, { recursive: true });
    // Minimal plugin marker so the directory is a valid Open Plugins bundle.
    const markerPath = path.join(pluginRoot, '.agents-cli-managed');
    if (!fs.existsSync(markerPath)) {
      fs.writeFileSync(markerPath, 'managed by agents-cli hooks sync\n', 'utf-8');
    }
    fs.writeFileSync(
      outPath,
      JSON.stringify({ hooks: eventHooks }, null, 2) + '\n',
      'utf-8'
    );
  } catch (err) {
    errors.push(`Failed to write goose hooks plugin: ${(err as Error).message}`);
  }

  return { registered, errors };
}


/**
 * Canonical → Cursor CLI camelCase events.
 *
 * Only events verified to fire in cursor-agent CLI (not full IDE parity).
 * Ticket RUSH-1326 note (2026-06): working = sessionStart, stop, preToolUse,
 * postToolUse, beforeShellExecution, afterShellExecution, beforeReadFile,
 * afterFileEdit. Also map SessionEnd / beforeSubmitPrompt / preCompact /
 * subagent* which Cursor documents for agent hooks.
 * Unmapped events (e.g. afterAgentResponse) are skipped.
 */
const CURSOR_EVENT_MAP: Record<string, string> = {
  SessionStart: 'sessionStart',
  SessionEnd: 'sessionEnd',
  Stop: 'stop',
  UserPromptSubmit: 'beforeSubmitPrompt',
  PreToolUse: 'preToolUse',
  PostToolUse: 'postToolUse',
  PostToolUseFailure: 'postToolUseFailure',
  PreCompact: 'preCompact',
  SubagentStart: 'subagentStart',
  SubagentStop: 'subagentStop',
  BeforeShellExecution: 'beforeShellExecution',
  AfterShellExecution: 'afterShellExecution',
  BeforeReadFile: 'beforeReadFile',
  AfterFileEdit: 'afterFileEdit',
};

/**
 * Register hooks for Cursor CLI (`cursor-agent`).
 *
 * Writes `~/.cursor/hooks.json` (under version home):
 *   { "version": 1, "hooks": { event: [{ command, timeout?, matcher? }] } }
 *
 * GC: rewrite managed entries by command path under managedPrefixes; preserve
 * user-authored entries whose command is outside managed roots.
 */
function registerHooksForCursor(
  versionHome: string,
  manifest: Record<string, ManifestHook>,
  resolveScript: (script: string) => string | null,
  managedPrefixes: string[]
): { registered: string[]; errors: string[] } {
  const registered: string[] = [];
  const errors: string[] = [];

  const configDir = path.join(versionHome, '.cursor');
  const hooksPath = path.join(configDir, 'hooks.json');

  type CursorEntry = {
    command: string;
    timeout?: number;
    matcher?: string;
  };

  let existing: { version?: number; hooks?: Record<string, CursorEntry[]> } = { version: 1, hooks: {} };
  if (fs.existsSync(hooksPath)) {
    try {
      existing = JSON.parse(fs.readFileSync(hooksPath, 'utf-8'));
      if (!existing.hooks || typeof existing.hooks !== 'object') existing.hooks = {};
    } catch {
      errors.push('Failed to parse existing hooks.json');
      return { registered, errors };
    }
  }

  // Desired managed entries keyed by event|command|matcher so a matcher or
  // event change drops the stale entry instead of retaining it by command path alone.
  const desiredManaged = new Set<string>();
  for (const [hookName, hookDef] of Object.entries(manifest)) {
    if (!hookDef.events || hookDef.events.length === 0) continue;
    const resolved = resolveHookCommand(hookName, hookDef, resolveScript);
    if (!resolved) continue;
    for (const event of hookDef.events) {
      const cursorEvent = CURSOR_EVENT_MAP[event];
      if (!cursorEvent) continue;
      desiredManaged.add(`${cursorEvent}|${resolved}|${hookDef.matcher ?? ''}`);
    }
  }

  // GC managed entries that are no longer in the manifest (by event+command+matcher)
  const hooks: Record<string, CursorEntry[]> = {};
  for (const [event, entries] of Object.entries(existing.hooks || {})) {
    if (!Array.isArray(entries)) continue;
    hooks[event] = entries.filter((e) => {
      if (typeof e?.command !== 'string') return true;
      if (!isManagedHookCommand(e.command, managedPrefixes)) return true;
      return desiredManaged.has(`${event}|${e.command}|${e.matcher ?? ''}`);
    });
    if (hooks[event].length === 0) delete hooks[event];
  }

  for (const [name, hookDef] of Object.entries(manifest)) {
    if (!hookDef.events || hookDef.events.length === 0) continue;

    const commandPath = resolveHookCommand(name, hookDef, resolveScript);
    if (!commandPath) {
      errors.push(`${name}: script not found in user or system hooks dir`);
      continue;
    }

    const timeout = hookDef.timeout ?? 30;

    for (const event of hookDef.events) {
      const cursorEvent = CURSOR_EVENT_MAP[event];
      if (!cursorEvent) continue;

      if (!hooks[cursorEvent]) hooks[cursorEvent] = [];

      const entry: CursorEntry = { command: commandPath, timeout };
      if (hookDef.matcher) entry.matcher = hookDef.matcher;

      const existingIdx = hooks[cursorEvent].findIndex(
        (h) => h.command === entry.command && (h.matcher ?? '') === (entry.matcher ?? '')
      );
      if (existingIdx >= 0) {
        hooks[cursorEvent][existingIdx] = entry;
      } else {
        hooks[cursorEvent].push(entry);
      }

      registered.push(`${name} -> ${cursorEvent}`);
    }
  }

  try {
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(
      hooksPath,
      JSON.stringify({ version: 1, hooks }, null, 2) + '\n',
      'utf-8'
    );
  } catch (err) {
    errors.push(`Failed to write hooks.json: ${(err as Error).message}`);
  }

  return { registered, errors };
}

/**
 * Canonical → Hermes (Nous Research) snake_case lifecycle events.
 *
 * Hermes ≥ 0.11.0 runs configurable hooks declared under `hooks:` in
 * ~/.hermes/config.yaml. Only events with a documented Hermes equivalent are
 * mapped; unmapped canonical events (the manifest may declare events for other
 * agents) are skipped silently. UserPromptSubmit maps to `pre_llm_call` (the
 * closest pre-turn phase) and Stop to `on_session_finalize`.
 */
const HERMES_EVENT_MAP: Record<string, string> = {
  SessionStart: 'on_session_start',
  SessionEnd: 'on_session_end',
  PreToolUse: 'pre_tool_call',
  PostToolUse: 'post_tool_call',
  SubagentStop: 'subagent_stop',
  UserPromptSubmit: 'pre_llm_call',
  Stop: 'on_session_finalize',
};

/** Hermes caps hook timeouts at 300s (default 60s). */
const HERMES_TIMEOUT_CAP = 300;
const HERMES_TIMEOUT_DEFAULT = 60;

/**
 * Register hooks for Hermes Agent (Nous Research ≥ 0.11.0).
 *
 * Read-modify-writes the shared `~/.hermes/config.yaml` (under the version
 * home): it merges a `hooks:` block of the form
 *   hooks: { <event>: [ { command, timeout, matcher? } ] }
 * into the YAML doc WITHOUT touching sibling keys (`mcp_servers` in
 * particular — a naive overwrite would wipe the user's MCP servers). No
 * `version` wrapper: Hermes' config is a flat YAML map.
 *
 * GC: rewrite managed entries by command path under managedPrefixes; preserve
 * user-authored entries whose command is outside managed roots. Keyed by
 * event|command|matcher so a matcher or event change drops the stale entry.
 */
function registerHooksForHermes(
  versionHome: string,
  manifest: Record<string, ManifestHook>,
  resolveScript: (script: string) => string | null,
  managedPrefixes: string[]
): { registered: string[]; errors: string[] } {
  const registered: string[] = [];
  const errors: string[] = [];

  const configDir = path.join(versionHome, '.hermes');
  const configPath = path.join(configDir, 'config.yaml');

  type HermesEntry = { command: string; timeout: number; matcher?: string };

  // Read-modify-write: preserve the full existing YAML doc (mcp_servers, etc.).
  let config: Record<string, unknown> = {};
  if (fs.existsSync(configPath)) {
    try {
      const parsed = yaml.parse(fs.readFileSync(configPath, 'utf-8'));
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        config = parsed as Record<string, unknown>;
      }
    } catch {
      errors.push('Failed to parse existing config.yaml');
      return { registered, errors };
    }
  }

  const existingHooks =
    config.hooks && typeof config.hooks === 'object' && !Array.isArray(config.hooks)
      ? (config.hooks as Record<string, HermesEntry[]>)
      : {};

  // Desired managed entries keyed by event|command|matcher so a matcher or
  // event change drops the stale entry instead of retaining it by command alone.
  const desiredManaged = new Set<string>();
  for (const [hookName, hookDef] of Object.entries(manifest)) {
    if (!hookDef.events || hookDef.events.length === 0) continue;
    const resolved = resolveHookCommand(hookName, hookDef, resolveScript);
    if (!resolved) continue;
    for (const event of hookDef.events) {
      const hermesEvent = HERMES_EVENT_MAP[event];
      if (!hermesEvent) continue;
      desiredManaged.add(`${hermesEvent}|${resolved}|${hookDef.matcher ?? ''}`);
    }
  }

  // GC managed entries that are no longer in the manifest; preserve user entries.
  const hooks: Record<string, HermesEntry[]> = {};
  for (const [event, entries] of Object.entries(existingHooks)) {
    if (!Array.isArray(entries)) continue;
    hooks[event] = entries.filter((e) => {
      if (typeof e?.command !== 'string') return true;
      if (!isManagedHookCommand(e.command, managedPrefixes)) return true;
      return desiredManaged.has(`${event}|${e.command}|${e.matcher ?? ''}`);
    });
    if (hooks[event].length === 0) delete hooks[event];
  }

  for (const [name, hookDef] of Object.entries(manifest)) {
    if (!hookDef.events || hookDef.events.length === 0) continue;

    const commandPath = resolveHookCommand(name, hookDef, resolveScript);
    if (!commandPath) {
      errors.push(`${name}: script not found in user or system hooks dir`);
      continue;
    }

    const timeout = Math.min(HERMES_TIMEOUT_CAP, hookDef.timeout ?? HERMES_TIMEOUT_DEFAULT);

    for (const event of hookDef.events) {
      const hermesEvent = HERMES_EVENT_MAP[event];
      if (!hermesEvent) continue;

      if (!hooks[hermesEvent]) hooks[hermesEvent] = [];

      const entry: HermesEntry = { command: commandPath, timeout };
      if (hookDef.matcher) entry.matcher = hookDef.matcher;

      const existingIdx = hooks[hermesEvent].findIndex(
        (h) => h.command === entry.command && (h.matcher ?? '') === (entry.matcher ?? '')
      );
      if (existingIdx >= 0) {
        hooks[hermesEvent][existingIdx] = entry;
      } else {
        hooks[hermesEvent].push(entry);
      }

      registered.push(`${name} -> ${hermesEvent}`);
    }
  }

  if (Object.keys(hooks).length > 0) {
    config.hooks = hooks;
  } else {
    delete config.hooks;
  }

  try {
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(configPath, yaml.stringify(config), 'utf-8');
  } catch (err) {
    errors.push(`Failed to write config.yaml: ${(err as Error).message}`);
  }

  return { registered, errors };
}

const execFileAsync = promisify(execFile);

export interface InstallSessionTrackerHookResult {
  installed: boolean;
  error?: string;
}

function resolveSessionTrackerRoot(): string | null {
  const here = path.dirname(fileURLToPath(import.meta.url));
  // Built/installed layout: dist/lib/hooks/ -> dist/session-tracker
  const built = path.resolve(here, '..', '..', 'session-tracker');
  if (fs.existsSync(path.join(built, 'dist', 'hook.sh'))) {
    return built;
  }
  // Source layout: cli/src/lib/hooks/ -> repo root (4 up) -> packages/session-tracker
  const source = path.resolve(here, '..', '..', '..', '..', 'packages', 'session-tracker');
  if (fs.existsSync(path.join(source, 'src', 'hook.sh'))) {
    return source;
  }
  return null;
}

function resolveTsxLoader(trackerRoot: string): string | null {
  const loader = path.join(trackerRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs');
  if (fs.existsSync(loader)) return loader;
  return null;
}

function buildInstallHookInvocation(
  trackerRoot: string,
  agent: AgentId,
): { command: string; args: string[] } | null {
  const distScript = path.join(trackerRoot, 'dist', 'install-hook.js');
  if (fs.existsSync(distScript)) {
    return { command: process.execPath, args: [distScript, agent] };
  }
  const loader = resolveTsxLoader(trackerRoot);
  if (!loader) return null;
  return {
    command: process.execPath,
    args: [loader, path.join(trackerRoot, 'src', 'install-hook.ts'), agent],
  };
}

/**
 * Install the shared SessionStart state-writer hook (`packages/session-tracker`)
 * into the harness's native config. Gated by `supports(agent, 'hooks', version)`;
 * unsupported agents return `installed: false` with a reason instead of throwing.
 *
 * This is the bridge that makes bare `claude` / `codex` / `kimi` launches write
 * `~/.agents/.cache/terminals/sessions/<pid>.json`, not just `agents run` launches.
 */
export async function installSessionTrackerHook(
  agent: AgentId,
  version?: string,
  home?: string,
): Promise<InstallSessionTrackerHookResult> {
  const gate = supports(agent, 'hooks', version);
  if (!gate.ok) {
    return { installed: false, error: explainSkip(agent, 'hooks', gate, version) };
  }
  const trackerRoot = resolveSessionTrackerRoot();
  if (!trackerRoot) {
    return { installed: false, error: 'session-tracker package not found' };
  }
  const invocation = buildInstallHookInvocation(trackerRoot, agent);
  if (!invocation) {
    return { installed: false, error: 'session-tracker not built and tsx is unavailable' };
  }
  const env = sessionTrackerInstallEnv(agent, version, home);
  try {
    await execFileAsync(invocation.command, invocation.args, {
      env,
      encoding: 'utf8',
    });
    if (agent === 'codex') trustCodexHooks(path.join(env.HOME ?? os.homedir(), '.codex', 'hooks.json'));
    return { installed: true };
  } catch (err) {
    return { installed: false, error: installFailureMessage(err) };
  }
}

/**
 * The child reports its refusal reason on stdout (its HOOK_SUPPORT table), not
 * stderr — and a Buffer-typed empty stderr is truthy, so a bare `err.stderr ??
 * err.message` surfaced an empty string. Prefer the first NON-EMPTY stream.
 */
function installFailureMessage(err: unknown): string {
  const e = err as Error & { stdout?: string | Buffer; stderr?: string | Buffer };
  for (const stream of [e.stderr, e.stdout]) {
    const text = stream == null ? '' : String(stream).trim();
    if (text.length > 0) return text;
  }
  return e.message;
}

/**
 * Synchronous variant for callers that cannot be made async (e.g.
 * `syncResourcesToVersion`). Best-effort: failures are returned, not thrown.
 */
export function installSessionTrackerHookSync(
  agent: AgentId,
  version?: string,
  home?: string,
): InstallSessionTrackerHookResult {
  const gate = supports(agent, 'hooks', version);
  if (!gate.ok) {
    return { installed: false, error: explainSkip(agent, 'hooks', gate, version) };
  }
  const trackerRoot = resolveSessionTrackerRoot();
  if (!trackerRoot) {
    return { installed: false, error: 'session-tracker package not found' };
  }
  const invocation = buildInstallHookInvocation(trackerRoot, agent);
  if (!invocation) {
    return { installed: false, error: 'session-tracker not built and tsx is unavailable' };
  }
  const env = sessionTrackerInstallEnv(agent, version, home);
  try {
    execFileSync(invocation.command, invocation.args, {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      encoding: 'utf8',
    });
    if (agent === 'codex') trustCodexHooks(path.join(env.HOME ?? os.homedir(), '.codex', 'hooks.json'));
    return { installed: true };
  } catch (err) {
    return { installed: false, error: installFailureMessage(err) };
  }
}

/** The hook installer must target this account, not the current global home. */
function sessionTrackerInstallEnv(agent: AgentId, version?: string, home?: string): NodeJS.ProcessEnv {
  const target = home ?? (version ? getVersionHomePath(agent, version) : undefined);
  return target ? { ...process.env, HOME: target, USERPROFILE: target } : { ...process.env };
}
