/**
 * Project routine discovery, source tracking, and user-layer sync.
 *
 * Project YAML under `<project>/.agents/routines/*.yml` never fires on its own
 * (a cloned repo must not auto-run agent prompts). A routine has exactly one
 * state — enabled or disabled — owned by this device's `meta.deviceRoutines`
 * list, never by the project YAML's own `enabled:` field. `agents routines
 * enable <name>` materialises the routine into `~/.agents/routines/` with
 * `source:` provenance (so the daemon, which loads only user + system layers,
 * can see it) and flips the device flag on — one action. `discoverProjectRoutines`
 * surfaces not-yet-materialised routines from the user's registered projects so
 * `list` shows them as disabled. `syncProjectRoutines` refreshes materialised
 * copies from their source YAML (also invoked on daemon SIGHUP).
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as yaml from 'yaml';
import { execFileSync } from 'child_process';
import {
  getProjectAgentsDir,
  getProjectRoutinesDir,
  ensureAgentsDir,
} from './state.js';
import {
  type JobConfig,
  type JobSource,
  readJob,
  writeJob,
  deleteJob,
  listJobs,
  validateJob,
} from './scheduling/routines.js';
import { parseOwnerRepoFromRemote } from './registry.js';
import { listProjectDefs, projectDirsAbs } from './projects.js';
import { isSafeSegmentName } from './paths.js';

/** Expand `~/…` and resolve to an absolute path. */
export function expandProjectPath(p: string): string {
  const trimmed = p.trim();
  if (trimmed.startsWith('~/') || trimmed === '~') {
    return path.resolve(trimmed.replace(/^~(?=$|[/\\])/, os.homedir()));
  }
  return path.resolve(trimmed);
}

/** Store paths home-relative when under $HOME so they travel across machines. */
export function displayProjectPath(abs: string): string {
  const home = os.homedir();
  const resolved = path.resolve(abs);
  if (resolved === home) return '~';
  if (resolved.startsWith(home + path.sep)) {
    return '~' + resolved.slice(home.length);
  }
  return resolved;
}

/** Resolve the project root (parent of `.agents/`) from a cwd, or null. */
export function resolveProjectRoot(cwd: string = process.cwd()): string | null {
  const agentsDir = getProjectAgentsDir(cwd);
  if (!agentsDir) return null;
  return path.dirname(agentsDir);
}

/** Git provenance for a project root (best-effort; never throws). */
function readProjectGitSource(projectRoot: string): Pick<JobSource, 'repo' | 'branch' | 'commit'> {
  const abs = expandProjectPath(projectRoot);
  const out: Pick<JobSource, 'repo' | 'branch' | 'commit'> = {};
  try {
    const remote = execFileSync('git', ['-C', abs, 'remote', 'get-url', 'origin'], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 5_000,
    }).trim();
    const repo = parseOwnerRepoFromRemote(remote);
    if (repo) out.repo = repo;
  } catch { /* no origin */ }
  try {
    out.branch = execFileSync('git', ['-C', abs, 'rev-parse', '--abbrev-ref', 'HEAD'], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 5_000,
    }).trim();
    if (out.branch === 'HEAD') delete out.branch; // detached
  } catch { /* not a git repo */ }
  try {
    out.commit = execFileSync('git', ['-C', abs, 'rev-parse', '--short', 'HEAD'], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 5_000,
    }).trim();
  } catch { /* ignore */ }
  return out;
}

/** List project routine YAML files (name + absolute path). */
export function listProjectRoutineFiles(projectRoot: string): Array<{ name: string; path: string }> {
  const routinesDir = getProjectRoutinesDir(expandProjectPath(projectRoot));
  if (!routinesDir || !fs.existsSync(routinesDir)) return [];
  return fs.readdirSync(routinesDir)
    .filter((f) => f.endsWith('.yml') || f.endsWith('.yaml'))
    .map((f) => ({
      name: f.replace(/\.ya?ml$/, ''),
      path: path.join(routinesDir, f),
    }))
    .filter((e) => isSafeSegmentName(e.name));
}

function readProjectJobFile(filePath: string): JobConfig | null {
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    const parsed = yaml.parse(content);
    if (!parsed || typeof parsed !== 'object') return null;
    if (Object.prototype.hasOwnProperty.call(parsed, 'device')) return null;
    return {
      mode: 'auto',
      effort: 'auto',
      timeout: '10m',
      enabled: true,
      ...parsed,
      name: parsed.name || path.basename(filePath).replace(/\.ya?ml$/, ''),
    } as JobConfig;
  } catch {
    return null;
  }
}

interface SyncProjectResult {
  projectRoot: string;
  synced: string[];
  skipped: Array<{ name: string; reason: string }>;
  removed: string[];
  errors: Array<{ name: string; error: string }>;
}

/**
 * Refresh one project's already-materialised routines from its source YAML.
 * - Overwrites user copies that already carry matching `source.projectPath`
 * - Never clobbers a hand-authored user routine (no source / different source)
 * - Removes user copies from this project whose YAML disappeared
 *
 * Sync NEVER touches the device enable flag: a routine's enabled/disabled state
 * is owned solely by `meta.deviceRoutines` (via `agents routines enable/disable`),
 * never by the project YAML's own `enabled:` field. That is what keeps a cloned
 * repo from auto-firing — refreshing a definition can never turn it on.
 */
export function syncProjectRoutines(projectRoot: string): SyncProjectResult {
  ensureAgentsDir();
  const abs = expandProjectPath(projectRoot);
  const git = readProjectGitSource(abs);
  const source: JobSource = {
    kind: 'project',
    projectPath: abs,
    ...(git.repo ? { repo: git.repo } : {}),
    ...(git.branch ? { branch: git.branch } : {}),
    ...(git.commit ? { commit: git.commit } : {}),
  };

  const result: SyncProjectResult = {
    projectRoot: abs,
    synced: [],
    skipped: [],
    removed: [],
    errors: [],
  };

  const files = listProjectRoutineFiles(abs);
  const seenNames = new Set<string>();

  for (const file of files) {
    seenNames.add(file.name);

    // Refresh only routines the user already materialised from THIS project.
    // A project file with no existing user-layer copy is "available, not
    // enabled" — it surfaces via `discoverProjectRoutines` and is materialised
    // by `agents routines enable <name>`, never auto-pulled by a refresh.
    const existing = readJob(file.name);
    if (!existing) continue;
    const existingSource = existing.source;
    const fromThisProject = existingSource?.kind === 'project'
      && expandProjectPath(existingSource.projectPath) === abs;
    if (!fromThisProject) {
      result.skipped.push({
        name: file.name,
        reason: existingSource
          ? `user-layer routine already exists from another source (${existingSource.projectPath})`
          : 'user-layer routine already exists (hand-authored); not overwriting without source match',
      });
      continue;
    }

    const job = readProjectJobFile(file.path);
    if (!job) {
      result.errors.push({ name: file.name, error: 'unreadable or invalid YAML' });
      continue;
    }

    // Preserve user-layer devices pin when project YAML omits it (same overlay
    // semantics as listJobs project discovery).
    if (job.devices === undefined && existing.devices && existing.devices.length > 0) {
      job.devices = existing.devices;
    }
    // Carry the original creation stamp across. A sync rebuilds the config
    // from the PROJECT yaml, which never carries `createdAt`, so without this
    // every `agents routines sync` would re-stamp it to now — walking the
    // overdue floor forward and hiding real missed fires for project routines.
    if (existing.createdAt) job.createdAt = existing.createdAt;

    // Surface repo for list/display when project has a GitHub origin.
    if (git.repo && !job.repo) job.repo = git.repo;
    job.source = source;
    job.name = file.name;

    const errors = validateJob(job);
    if (errors.length > 0) {
      result.errors.push({ name: file.name, error: errors.join('; ') });
      continue;
    }

    try {
      // Refresh the definition only. Enablement lives in meta.deviceRoutines and
      // is never derived from the project YAML here.
      writeJob(job);
      result.synced.push(file.name);
    } catch (err) {
      result.errors.push({ name: file.name, error: (err as Error).message });
    }
  }

  // Drop user-layer copies from this project that no longer exist in project YAML.
  for (const job of listJobs()) {
    if (job.source?.kind !== 'project') continue;
    if (expandProjectPath(job.source.projectPath) !== abs) continue;
    if (seenNames.has(job.name)) continue;
    if (deleteJob(job.name)) result.removed.push(job.name);
  }

  return result;
}

export interface SyncAllResult {
  projects: SyncProjectResult[];
  /** Project roots that were listed but missing on disk. */
  missing: string[];
}

/** Distinct project roots that already have at least one materialised routine. */
export function materialisedProjectRoots(): string[] {
  const roots = new Set<string>();
  for (const job of listJobs()) {
    if (job.source?.kind === 'project') roots.add(expandProjectPath(job.source.projectPath));
  }
  return [...roots];
}

/**
 * Refresh every materialised project routine from its source YAML. The set of
 * roots is derived from what the user has already enabled/materialised (their
 * `source.projectPath`), not from any allowlist — enabling a routine is the only
 * thing that brings its project into the refresh set. Also runs on daemon SIGHUP.
 */
export function syncAllProjectRoutines(opts: { extraRoots?: string[] } = {}): SyncAllResult {
  const roots = new Set<string>(materialisedProjectRoots());
  for (const r of opts.extraRoots ?? []) roots.add(expandProjectPath(r));

  const projects: SyncProjectResult[] = [];
  const missing: string[] = [];
  for (const root of roots) {
    if (!fs.existsSync(root)) {
      missing.push(root);
      continue;
    }
    projects.push(syncProjectRoutines(root));
  }
  return { projects, missing };
}

/** A project routine available to enable, not yet materialised on this device. */
export interface DiscoveredProjectRoutine {
  name: string;
  projectRoot: string;
  file: string;
  /** Display config for `list` (always disabled — enablement is a local act). */
  config: JobConfig;
}

/**
 * Absolute local checkout roots for every registered project, deduped. This is
 * the discovery universe for project routines: bounded to projects the user
 * registered (`agents projects`), never an arbitrary filesystem scan.
 */
function registeredProjectRoots(): string[] {
  const roots = new Set<string>();
  for (const def of listProjectDefs()) {
    for (const dir of projectDirsAbs(def, { forRemote: false })) {
      if (dir) roots.add(path.resolve(dir));
    }
  }
  return [...roots];
}

/**
 * Project routines from registered projects that are NOT already materialised
 * in the user layer. These surface in `agents routines list` as disabled rows so
 * the single enabled/disabled model is visible, and `enable <name>` resolves a
 * name against them. A routine whose name already exists as a user/system
 * routine is omitted (that materialised copy is the live one).
 */
export function discoverProjectRoutines(): DiscoveredProjectRoutine[] {
  const materialisedNames = new Set(listJobs().map((j) => j.name));
  const out: DiscoveredProjectRoutine[] = [];
  const seen = new Set<string>();
  for (const root of registeredProjectRoots()) {
    const files = listProjectRoutineFiles(root).filter(
      (f) => !materialisedNames.has(f.name) && !seen.has(f.name),
    );
    if (files.length === 0) continue;
    const git = readProjectGitSource(root); // once per root, not per routine
    for (const file of files) {
      const job = readProjectJobFile(file.path);
      if (!job) continue;
      seen.add(file.name);
      job.name = file.name;
      job.source = {
        kind: 'project',
        projectPath: expandProjectPath(root),
        ...(git.repo ? { repo: git.repo } : {}),
        ...(git.branch ? { branch: git.branch } : {}),
        ...(git.commit ? { commit: git.commit } : {}),
      };
      if (git.repo && !job.repo) job.repo = git.repo;
      job.enabled = false; // available, not enabled — never inferred from the repo YAML
      out.push({ name: file.name, projectRoot: expandProjectPath(root), file: file.path, config: job });
    }
  }
  return out;
}

/**
 * Resolve a routine name to a project source for `enable <name>`: first the cwd
 * project, then registered projects. Returns null when the name matches no
 * project routine, or throws-by-return when it is ambiguous across projects.
 */
export function findProjectRoutine(
  name: string,
  cwd: string = process.cwd(),
): { projectRoot: string; file: string } | { ambiguous: string[] } | null {
  const cwdRoot = resolveProjectRoot(cwd);
  if (cwdRoot) {
    const match = listProjectRoutineFiles(cwdRoot).find((f) => f.name === name);
    if (match) return { projectRoot: expandProjectPath(cwdRoot), file: match.path };
  }
  const hits: Array<{ projectRoot: string; file: string }> = [];
  const seenRoots = new Set<string>();
  for (const root of registeredProjectRoots()) {
    const abs = expandProjectPath(root);
    if (seenRoots.has(abs)) continue;
    seenRoots.add(abs);
    const match = listProjectRoutineFiles(abs).find((f) => f.name === name);
    if (match) hits.push({ projectRoot: abs, file: match.path });
  }
  if (hits.length === 0) return null;
  if (hits.length > 1) return { ambiguous: hits.map((h) => displayProjectPath(h.projectRoot)) };
  return hits[0];
}

/**
 * Materialise one project routine into the user layer WITHOUT enabling it. The
 * caller (`agents routines enable`) flips the device flag separately, so a
 * materialise can never by itself make a routine fire. Returns the written
 * config, or an error string.
 */
export function materialiseProjectRoutine(
  projectRoot: string,
  name: string,
): { job: JobConfig } | { error: string } {
  ensureAgentsDir();
  const abs = expandProjectPath(projectRoot);
  const match = listProjectRoutineFiles(abs).find((f) => f.name === name);
  if (!match) return { error: `no routine '${name}' under ${displayProjectPath(abs)}/.agents/routines` };

  const job = readProjectJobFile(match.path);
  if (!job) return { error: `routine '${name}' is unreadable or invalid YAML` };

  const existing = readJob(name);
  if (existing) {
    const src = existing.source;
    const fromThisProject = src?.kind === 'project' && expandProjectPath(src.projectPath) === abs;
    if (!fromThisProject) {
      return {
        error: src
          ? `a routine named '${name}' already exists from another source (${src.projectPath})`
          : `a hand-authored routine named '${name}' already exists; rename one before enabling`,
      };
    }
    if (existing.createdAt) job.createdAt = existing.createdAt;
    if (job.devices === undefined && existing.devices && existing.devices.length > 0) {
      job.devices = existing.devices;
    }
  }

  const git = readProjectGitSource(abs);
  job.name = name;
  job.source = {
    kind: 'project',
    projectPath: abs,
    ...(git.repo ? { repo: git.repo } : {}),
    ...(git.branch ? { branch: git.branch } : {}),
    ...(git.commit ? { commit: git.commit } : {}),
  };
  if (git.repo && !job.repo) job.repo = git.repo;

  const errors = validateJob(job);
  if (errors.length > 0) return { error: errors.join('; ') };

  writeJob(job);
  return { job };
}
