/**
 * Detached worker entry point for background sync. See auto-pull.ts for the public API.
 *
 * For the system repo: fast-forward pull (safe — repo is read-only locally).
 * For the user repo + enabled extras: `git fetch` + write a status marker the foreground
 * CLI surfaces on its next invocation.
 *
 * Per-repo lock files at ~/.agents/.system/.fetch/<alias>.lock prevent concurrent fetches.
 * Lock mtime under 5 min => skip (another invocation already in flight).
 */

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

/**
 * Background auto-pull of ~/.agents/.system/ is off by default. When enabled it
 * silently fast-forwards a tracked source tree that the CLI then reads as a
 * source of skills, hooks, install manifests, and commands — anyone with push
 * access to that upstream gets remote code execution on every user the next
 * time they invoke a command that loads a system resource. Operators that
 * really want the convenience can set AGENTS_AUTO_PULL=1.
 */
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
        // Verify origin is the EXPECTED system remote before fast-forwarding —
        // the system repo ships hooks that run as shell, so a pull from a
        // repointed origin is RCE. An unexpected origin is refused, not pulled
        // (PHNX-2957). The detached worker has no terminal to warn on; the
        // foreground `agents use` path surfaces the refusal to the operator.
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

/**
 * macOS only: fetch the floor AGI Menu release into the verified cache when the
 * installed helper is behind it and no bundle ships with this install, so the
 * next foreground invocation's network-free self-heal has a source to install
 * from (`sourceAppPath` candidate 4). Same lock discipline as the repo targets.
 */
async function prefetchMenubarHelperTarget(): Promise<void> {
  if (process.platform !== 'darwin') return;
  const alias = 'menubar-helper';
  if (!tryAcquireLock(alias)) return;
  try {
    const { prefetchMenubarHelper } = await import('./menubar/install-menubar.js');
    await prefetchMenubarHelper();
  } catch {
    /* network / verification failures are non-fatal; the next cycle retries */
  } finally {
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

  // Stamp the cycle so the next foreground CLI invocation can skip the ~7ms
  // detached spawn for SYNC_LOCK_TTL_MS (RUSH-2324). Written even when every
  // target was lock-skipped or the target list was empty — "nothing to do"
  // is still a completed cycle.
  markDetachedSyncComplete();
}

main().catch(() => {
  /* swallow — detached worker must never crash the parent's terminal */
  process.exit(0);
});
