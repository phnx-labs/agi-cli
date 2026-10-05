import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import lockfile from 'proper-lockfile';

import { getCacheDir } from './state.js';
import { logAndContinueOnLockCompromised } from './lock-compromise.js';

const REFRESH_LOCK_STALE_MS = 2 * 60_000;
let refreshLockRootOverride: string | null = null;

export function setRefreshLockRootForTest(root: string | null): string | null {
  const previous = refreshLockRootOverride;
  refreshLockRootOverride = root;
  return previous;
}

function lockTarget(scope: string, key: string): string {
  const digest = createHash('sha256').update(`${scope}\0${key}`).digest('hex');
  return path.join(refreshLockRootOverride ?? getCacheDir(), 'refresh-locks', scope, `${digest}.lock`);
}

interface RefreshLeaseOptions<T> {
  scope: string;
  key: string;
  readCompleted: () => T | null;
  isCompleted: (value: T) => boolean;
  refresh: () => Promise<T>;
}

export async function withRefreshLease<T>(options: RefreshLeaseOptions<T>): Promise<T> {
  const target = lockTarget(options.scope, options.key);
  await fs.mkdir(path.dirname(target), { recursive: true });
  try {
    await fs.writeFile(target, '', { flag: 'wx', mode: 0o600 });
  } catch (error: any) {
    if (error?.code !== 'EEXIST') throw error;
  }

  const release = await lockfile.lock(target, {
    realpath: false,
    stale: REFRESH_LOCK_STALE_MS,
    update: REFRESH_LOCK_STALE_MS / 4,
    retries: { retries: 240, minTimeout: 25, maxTimeout: 500, factor: 1.2 },
    onCompromised: logAndContinueOnLockCompromised('refresh lease'),
  });
  try {
    const completed = options.readCompleted();
    if (completed !== null && options.isCompleted(completed)) return completed;
    return await options.refresh();
  } finally {
    await release();
  }
}
