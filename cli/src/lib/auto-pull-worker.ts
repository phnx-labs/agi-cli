/** Detached worker entry for background sync (see auto-pull.ts). The system repo is fast-forward
 * pulled (local read-only); the user repo and enabled extras get `git fetch` plus a status marker.
 * Per-repo locks under ~/.agents/.system/.fetch/ skip a fetch when the mtime is under 5 min. */

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

/** Background auto-pull of ~/.agents/.system/ is off by default: it fast-forwards a tree the CLI
 * reads for skills, hooks, manifests and commands, so anyone with upstream push access would get
 * remote code execution on users. Set AGENTS_AUTO_PULL=1 to opt in. */
const ENABLE_AUTO_PULL = process.env.AGENTS_AUTO_PULL === '1';

interface RepoTarget {
  alias: string;
  dir: string;
  /** 'pull' for system (FF auto-merge), 'notify' for user/extras (fetch + marker only). */
  mode: 'pull' | 'notify';
}

function ensureFetchDir(): string {
  const dir = getFetchCacheDir();
  if (!fs.existsSync(dir)) {
    try { fs.mkdirSync(dir, { recursive: true }); } catch { /* ignore */ }
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
    /* no lock yet */
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
  try { fs.utimesSync(lockFilePath(alias), now, now); } catch { /* lock gone; nothing to extend */ }
}

function releaseLock(alias: string): void {
  try { fs.unlinkSync(lockFilePath(alias)); } catch { /* ignore */ }
}

function writeStatusMarker(marker: FetchStatusMarker): void {
  ensureFetchDir();
  try {
    fs.writeFileSync(statusFilePath(marker.alias), JSON.stringify(marker));
  } catch {
    /* best-effort */
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
        // Demote to a fetch + notify; the user still sees ahead/behind on the
        // next foreground CLI invocation, but the source tree is never mutated
        // by a detached worker.
        await notifyRepo(target);
      } else {
        // Verify origin is the expected system remote before fast-forwarding: the system repo
        // ships shell hooks, so a repointed origin is RCE (PHNX-2957). Refuse, don't pull; the
        // detached worker can't warn, so the foreground `agents use` path surfaces it.
        await tryAutoPullSystemRepo(target.dir);
      }
    } else {
      await notifyRepo(target);
    }
  } catch {
    /* network / git failures are non-fatal */
  } finally {
    releaseLock(target.alias);
  }
}

/** macOS only: fetch the floor AGI Menu release into the verified cache when the installed helper
 * is behind and no bundle ships with this install, so the next foreground self-heal has a source
 * (`sourceAppPath` candidate 4). Same lock discipline as the repo targets. */
async function prefetchMenubarHelperTarget(): Promise<void> {
  if (process.platform !== 'darwin') return;
  const alias = 'menubar-helper';
  if (!tryAcquireLock(alias)) return;
  // The zip fetch may run up to 15 min (helper-download.ts) while the lock reads stale after
  // SYNC_LOCK_TTL_MS, and the download uses one shared partial file, so keep the lock mtime fresh
  // while fetching or a second worker races onto the same bytes.
  const heartbeat = setInterval(() => touchLock(alias), SYNC_LOCK_TTL_MS / 2);
  heartbeat.unref();
  try {
    const { prefetchMenubarHelper } = await import('./menubar/install-menubar.js');
    await prefetchMenubarHelper();
  } catch {
    /* network / verification failures are non-fatal; the next cycle retries */
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

  // Stamp the cycle so the next foreground invocation can skip the ~7ms detached spawn for
  // SYNC_LOCK_TTL_MS (RUSH-2324). Written even when all targets were lock-skipped or empty:
  // nothing to do is a completed cycle.
  markDetachedSyncComplete();
}

main().catch(() => {
  /* swallow — detached worker must never crash the parent's terminal */
  process.exit(0);
});
