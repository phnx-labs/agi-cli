
import * as fs from 'fs';
import * as path from 'path';
import { simpleGit } from 'simple-git';
import { tryAutoPullSystemRepo, isGitRepo } from './git.js';
import {
  getSystemAgentsDir,
  getUserAgentsDir,
  getEnabledExtraRepos,
  getFetchCacheDir,
} from './state.js';
import {
  lockFilePath,
  statusFilePath,
  markDetachedSyncComplete,
  SYNC_LOCK_TTL_MS,
  type FetchStatusMarker,
} from './auto-pull.js';

const ENABLE_AUTO_PULL = process.env.AGENTS_AUTO_PULL === '1';
// Pulling executable hooks/commands is opt-in; system repos retain their expected origin.

interface RepoTarget {
  alias: string;
  dir: string;
  mode: 'pull' | 'notify';
}

function ensureFetchDir(): string {
  const dir = getFetchCacheDir();
  if (!fs.existsSync(dir)) {
    try { fs.mkdirSync(dir, { recursive: true }); } catch {  }
  }
  return dir;
}

function tryAcquireLock(alias: string): boolean {
  ensureFetchDir();
  const lock = lockFilePath(alias);
  try {
    const stat = fs.statSync(lock);
    if (Date.now() - stat.mtimeMs < SYNC_LOCK_TTL_MS) return false;
  } catch {
  }
  try {
    fs.writeFileSync(lock, String(process.pid));
    return true;
  } catch {
    return false;
  }
}

function touchLock(alias: string): void {
  const now = new Date();
  try { fs.utimesSync(lockFilePath(alias), now, now); } catch {  }
}

function releaseLock(alias: string): void {
  try { fs.unlinkSync(lockFilePath(alias)); } catch {  }
}

function writeStatusMarker(marker: FetchStatusMarker): void {
  ensureFetchDir();
  try {
    fs.writeFileSync(statusFilePath(marker.alias), JSON.stringify(marker));
  } catch {
  }
}

async function notifyRepo(target: RepoTarget): Promise<void> {
  if (!isGitRepo(target.dir)) return;
  const git = simpleGit(target.dir);
  const remotes = await git.getRemotes(true);
  const origin = remotes.find((r) => r.name === 'origin');
  if (!origin?.refs?.fetch) return;

  await git.fetch('origin');

  const status = await git.status();
  if (!status.tracking) return;

  writeStatusMarker({
    alias: target.alias,
    dir: target.dir,
    ahead: status.ahead ?? 0,
    behind: status.behind ?? 0,
    branch: status.tracking,
    fetchedAt: Date.now(),
  });
}

async function processTarget(target: RepoTarget): Promise<void> {
  if (!tryAcquireLock(target.alias)) return;
  try {
    if (target.mode === 'pull') {
      if (!ENABLE_AUTO_PULL) {
        await notifyRepo(target);
      } else {
        await tryAutoPullSystemRepo(target.dir);
      }
    } else {
      await notifyRepo(target);
    }
  } catch {
  } finally {
    releaseLock(target.alias);
  }
}

async function prefetchMenubarHelperTarget(): Promise<void> {
  if (process.platform !== 'darwin') return;
  const alias = 'menubar-helper';
  if (!tryAcquireLock(alias)) return;
  const heartbeat = setInterval(() => touchLock(alias), SYNC_LOCK_TTL_MS / 2);
  heartbeat.unref();
  try {
    const { prefetchMenubarHelper } = await import('./menubar/install-menubar.js');
    await prefetchMenubarHelper();
  } catch {
  } finally {
    clearInterval(heartbeat);
    releaseLock(alias);
  }
}

async function main(): Promise<void> {
  const targets: RepoTarget[] = [];

  const systemDir = getSystemAgentsDir();
  if (isGitRepo(systemDir)) {
    targets.push({ alias: 'system', dir: systemDir, mode: 'pull' });
  }

  const userDir = getUserAgentsDir();
  if (isGitRepo(userDir)) {
    targets.push({ alias: 'user', dir: userDir, mode: 'notify' });
  }

  for (const extra of getEnabledExtraRepos()) {
    if (isGitRepo(extra.dir)) {
      targets.push({ alias: extra.alias, dir: extra.dir, mode: 'notify' });
    }
  }

  await Promise.all([...targets.map(processTarget), prefetchMenubarHelperTarget()]);

  markDetachedSyncComplete();
}

main().catch(() => {
  process.exit(0);
});
