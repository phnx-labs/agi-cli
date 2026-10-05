import * as fs from 'fs/promises';
import * as fsSync from 'fs';
import * as path from 'path';
import lockfile from 'proper-lockfile';
import { getTeamsRegistryPath } from '../state.js';
import { emit } from '../feed/events.js';
import { atomicWriteJsonSync } from '../fs-atomic.js';
import { logAndContinueOnLockCompromised } from '../lock-compromise.js';

export interface TeamMeta {
  created_at: string;
  description?: string;
  enable_worktrees?: boolean;
  use_worktree?: string;
  devices?: string[];
  repo?: string;
  project?: string;
}

export type TeamRegistry = Record<string, TeamMeta>;

async function registryPath(): Promise<string> {
  return getTeamsRegistryPath();
}

async function withRegistryLock<T>(p: string, fn: () => Promise<T>): Promise<T> {
  await fs.mkdir(path.dirname(p), { recursive: true });
  if (!fsSync.existsSync(p)) {
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
  useWorktree?: string;
  devices?: string[];
  repo?: string;
  project?: string;
}

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
  await clearTeamDisbanded(name);
  emit('teams.create', { module: 'teams', team: name, worktrees: Boolean(options?.enableWorktrees || options?.useWorktree) });
  return meta;
}

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
  if (created) {
    await clearTeamDisbanded(name);
    emit('teams.create', { module: 'teams', team: name, worktrees: false });
  }
  return meta;
}

function disbandedDir(): string {
  return path.join(path.dirname(getTeamsRegistryPath()), 'disbanded');
}

function disbandedPath(name: string): string {
  const safe = Buffer.from(name, 'utf8').toString('base64url');
  return path.join(disbandedDir(), `${safe}.json`);
}

export async function markTeamDisbanded(name: string): Promise<void> {
  const dir = disbandedDir();
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    disbandedPath(name),
    JSON.stringify({ team: name, disbanded_at: new Date().toISOString() }),
    'utf-8',
  );
}

async function clearTeamDisbanded(name: string): Promise<void> {
  try {
    await fs.unlink(disbandedPath(name));
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') throw err;
  }
}

export async function isTeamDisbanded(name: string): Promise<boolean> {
  try {
    await fs.access(disbandedPath(name));
    return true;
  } catch {
    return false;
  }
}

export async function removeTeam(name: string): Promise<boolean> {
  const p = await registryPath();
  const existed = await withRegistryLock(p, async () => {
    const reg = await loadTeams();
    if (!reg[name]) return false;
    delete reg[name];
    await saveTeams(reg);
    return true;
  });
  await markTeamDisbanded(name);
  if (existed) emit('teams.disband', { module: 'teams', team: name });
  return existed;
}

export async function teamExists(name: string): Promise<boolean> {
  const reg = await loadTeams();
  return Boolean(reg[name]);
}

export async function getTeam(name: string): Promise<TeamMeta | null> {
  const reg = await loadTeams();
  return reg[name] ?? null;
}
