
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

export function expandProjectPath(p: string): string {
  const trimmed = p.trim();
  if (trimmed.startsWith('~/') || trimmed === '~') {
    return path.resolve(trimmed.replace(/^~(?=$|[/\\])/, os.homedir()));
  }
  return path.resolve(trimmed);
}

export function displayProjectPath(abs: string): string {
  const home = os.homedir();
  const resolved = path.resolve(abs);
  if (resolved === home) return '~';
  if (resolved.startsWith(home + path.sep)) {
    return '~' + resolved.slice(home.length);
  }
  return resolved;
}

export function resolveProjectRoot(cwd: string = process.cwd()): string | null {
  const agentsDir = getProjectAgentsDir(cwd);
  if (!agentsDir) return null;
  return path.dirname(agentsDir);
}

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

export function syncProjectRoutines(projectRoot: string): SyncProjectResult {
  // Project YAML never auto-fires: refresh only matching materialized copies and preserve activation, device pins, and createdAt.
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

    if (job.devices === undefined && existing.devices && existing.devices.length > 0) {
      job.devices = existing.devices;
    }
    if (existing.createdAt) job.createdAt = existing.createdAt;

    if (git.repo && !job.repo) job.repo = git.repo;
    job.source = source;
    job.name = file.name;

    const errors = validateJob(job);
    if (errors.length > 0) {
      result.errors.push({ name: file.name, error: errors.join('; ') });
      continue;
    }

    try {
      writeJob(job);
      result.synced.push(file.name);
    } catch (err) {
      result.errors.push({ name: file.name, error: (err as Error).message });
    }
  }

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
  missing: string[];
}

export function materialisedProjectRoots(): string[] {
  // Sync is limited to sources already materialized in the job store.
  const roots = new Set<string>();
  for (const job of listJobs()) {
    if (job.source?.kind === 'project') roots.add(expandProjectPath(job.source.projectPath));
  }
  return [...roots];
}

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

export function discoverProjectRoutines(): DiscoveredProjectRoutine[] {
  // Discovery is restricted to registered projects, never an arbitrary filesystem scan.
  const materialisedNames = new Set(listJobs().map((j) => j.name));
  const out: DiscoveredProjectRoutine[] = [];
  const seen = new Set<string>();
  for (const root of registeredProjectRoots()) {
    const files = listProjectRoutineFiles(root).filter(
      (f) => !materialisedNames.has(f.name) && !seen.has(f.name),
    );
    if (files.length === 0) continue;
    const git = readProjectGitSource(root);
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
      job.enabled = false;
      out.push({ name: file.name, projectRoot: expandProjectPath(root), file: file.path, config: job });
    }
  }
  return out;
}

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

export function materialiseProjectRoutine(
  projectRoot: string,
  name: string,
): { job: JobConfig } | { error: string } {
  // Materialization and enablement are separate; copying a routine must not activate it.
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
