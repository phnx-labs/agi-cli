/**
 * Team registry.
 *
 * Manages the persistent registry of named teams stored at
 * ~/.agents/.history/teams/registry.json. This is per-machine runtime
 * state (timestamps + worktree paths that include absolute filesystem
 * paths) and intentionally lives under .history/ so it's NOT pulled in
 * by `agents repo push`.
 */
import * as fs from 'fs/promises';
import * as fsSync from 'fs';
import * as path from 'path';
import lockfile from 'proper-lockfile';
import { getTeamsRegistryPath } from '../state.js';
import { emit } from '../feed/events.js';
import { atomicWriteJsonSync } from '../fs-atomic.js';
import { logAndContinueOnLockCompromised } from '../lock-compromise.js';

/** Metadata for a registered team. */
export interface TeamMeta {
  created_at: string;
  description?: string;
  enable_worktrees?: boolean;
  /** Shared worktree path for all teammates (mutually exclusive with enable_worktrees). */
  use_worktree?: string;
  /**
   * Distributed teams: the pool of devices this team may auto-schedule teammates
   * onto (from `agents devices`). One device → the whole team runs there; many →
   * unpinned teammates are least-loaded-scheduled across them; empty/absent →
   * every teammate runs locally (today's behavior).
   */
  devices?: string[];
  /**
   * Distributed teams: how each device gets the code — a git URL to clone or a
   * path that already exists on the host. Defaults to the local checkout's
   * `origin` at create time. Used by `ensureRemoteRepo` to provision the repo.
   */
  repo?: string;
  /**
   * The project (`agents projects`) this team works on. Its primary directory
   * is a local teammate's base cwd when neither `--cwd` nor a worktree gives
   * one, and its other bound directories become `--add-dir` grants.
   */
  project?: string;
}

/** Map of team name to team metadata. */
export type TeamRegistry = Record<string, TeamMeta>;

async function registryPath(): Promise<string> {
  return getTeamsRegistryPath();
}

/**
 * Run `fn` while holding an exclusive cross-process lock on the registry
 * file. proper-lockfile requires the target to exist, so we touch it first.
 * Stale locks (from crashed callers) auto-expire after `stale` ms.
 */
async function withRegistryLock<T>(p: string, fn: () => Promise<T>): Promise<T> {
  await fs.mkdir(path.dirname(p), { recursive: true });
  if (!fsSync.existsSync(p)) {
    // Use 'wx' so a concurrent caller doesn't clobber data written between
    // our existsSync check and writeFile.
    try {
      await fs.writeFile(p, '{}', { flag: 'wx' });
    } catch (err: any) {
      if (err && err.code !== 'EEXIST') throw err;
    }
  }
  const release = await lockfile.lock(p, {
    retries: { retries: 60, minTimeout: 25, maxTimeout: 250, factor: 1.5 },
    stale: 10_000,
    onCompromised: logAndContinueOnLockCompromised('teams registry'),
  });
  try {
    return await fn();
  } finally {
    await release();
  }
}

/**
 * Load all teams from the registry file. Returns an empty object only when
 * the file does not exist. A malformed file is a hard error — silently
 * returning {} would let any caller wipe the user's registry on the next
 * write, which is exactly the data-loss path we are trying to close.
 */
export async function loadTeams(): Promise<TeamRegistry> {
  const p = await registryPath();
  let raw: string;
  try {
    raw = await fs.readFile(p, 'utf-8');
  } catch (err: any) {
    if (err && err.code === 'ENOENT') return {};
    throw err;
  }
  try {
    return JSON.parse(raw) as TeamRegistry;
  } catch (err: any) {
    throw new Error(
      `Team registry corrupted at ${p}: ${err?.message ?? err}. Inspect and restore from backup.`
    );
  }
}

async function saveTeams(reg: TeamRegistry): Promise<void> {
  const p = await registryPath();
  atomicWriteJsonSync(p, reg);
}

interface CreateTeamOptions {
  description?: string;
  enableWorktrees?: boolean;
  /** Path to an existing worktree for all teammates to share. */
  useWorktree?: string;
  /** Distributed pool of devices this team may auto-schedule teammates onto. */
  devices?: string[];
  /** How each device gets the code (git URL to clone, or a path on the host). */
  repo?: string;
  /** The `agents projects` project this team works on. */
  project?: string;
}

/** Create a new team. Throws if a team with the same name already exists. */
export async function createTeam(name: string, options?: CreateTeamOptions): Promise<TeamMeta> {
  if (options?.enableWorktrees && options?.useWorktree) {
    throw new Error('Cannot use both --enable-worktrees and --use-worktree. Pick one.');
  }
  const p = await registryPath();
  const meta = await withRegistryLock(p, async () => {
    const reg = await loadTeams();
    if (reg[name]) {
      throw new Error(`Team '${name}' already exists`);
    }
    const m: TeamMeta = {
      created_at: new Date().toISOString(),
      ...(options?.description ? { description: options.description } : {}),
      ...(options?.enableWorktrees ? { enable_worktrees: true } : {}),
      ...(options?.useWorktree ? { use_worktree: options.useWorktree } : {}),
      ...(options?.devices && options.devices.length ? { devices: options.devices } : {}),
      ...(options?.repo ? { repo: options.repo } : {}),
      ...(options?.project ? { project: options.project } : {}),
    };
    reg[name] = m;
    await saveTeams(reg);
    return m;
  });
  // A re-created name is a fresh team — drop any prior disband tombstone so
  // saveMeta will persist new teammates again (RUSH-2450).
  await clearTeamDisbanded(name);
  // Audit the lifecycle boundary, not the CLI shell — captures every creation
  // path (create + ensure) with team metadata the generic command log lacks.
  emit('teams.create', { module: 'teams', team: name, worktrees: Boolean(options?.enableWorktrees || options?.useWorktree) });
  return meta;
}

/** Return existing team metadata or create a new team if it does not exist. */
export async function ensureTeam(name: string): Promise<TeamMeta> {
  const p = await registryPath();
  let created = false;
  const meta = await withRegistryLock(p, async () => {
    const reg = await loadTeams();
    if (reg[name]) return reg[name];
    const m: TeamMeta = { created_at: new Date().toISOString() };
    reg[name] = m;
    await saveTeams(reg);
    created = true;
    return m;
  });
  // `teams add` auto-creates the team on first teammate — audit that creation
  // too, but only when it actually happened (not the get-existing path).
  if (created) {
    await clearTeamDisbanded(name);
    emit('teams.create', { module: 'teams', team: name, worktrees: false });
  }
  return meta;
}

/**
 * Tombstone dir for disbanded teams (RUSH-2450). Lives next to the registry so
 * a long-lived supervisor can see that a team was deliberately removed and
 * refuse to re-persist its in-memory AgentProcess objects via saveMeta.
 * Cleared on create/ensure so a re-used name is a fresh team.
 */
function disbandedDir(): string {
  return path.join(path.dirname(getTeamsRegistryPath()), 'disbanded');
}

function disbandedPath(name: string): string {
  // Encode the name so a team called `../x` cannot escape the dir.
  const safe = Buffer.from(name, 'utf8').toString('base64url');
  return path.join(disbandedDir(), `${safe}.json`);
}

/** Mark a team as disbanded so saveMeta will not resurrect its teammates. */
export async function markTeamDisbanded(name: string): Promise<void> {
  const dir = disbandedDir();
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    disbandedPath(name),
    JSON.stringify({ team: name, disbanded_at: new Date().toISOString() }),
    'utf-8',
  );
}

/** Clear a disband tombstone — called when the name is re-created. */
async function clearTeamDisbanded(name: string): Promise<void> {
  try {
    await fs.unlink(disbandedPath(name));
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') throw err;
  }
}

/** True when the team was disbanded and has not been re-created since. */
export async function isTeamDisbanded(name: string): Promise<boolean> {
  try {
    await fs.access(disbandedPath(name));
    return true;
  } catch {
    return false;
  }
}

/** Remove a team from the registry. Returns false if the team did not exist. */
export async function removeTeam(name: string): Promise<boolean> {
  const p = await registryPath();
  const existed = await withRegistryLock(p, async () => {
    const reg = await loadTeams();
    if (!reg[name]) return false;
    delete reg[name];
    await saveTeams(reg);
    return true;
  });
  // Always stamp the tombstone when removeTeam is invoked from disband — even
  // if the registry entry was already gone, so a concurrent supervisor still
  // sees the disband. Idempotent.
  await markTeamDisbanded(name);
  // "Disband" — only fires when a real team was removed, not a no-op.
  if (existed) emit('teams.disband', { module: 'teams', team: name });
  return existed;
}

/** Check whether a team with the given name exists in the registry. */
export async function teamExists(name: string): Promise<boolean> {
  const reg = await loadTeams();
  return Boolean(reg[name]);
}

/** Get metadata for a specific team. Returns null if team does not exist. */
export async function getTeam(name: string): Promise<TeamMeta | null> {
  const reg = await loadTeams();
  return reg[name] ?? null;
}
