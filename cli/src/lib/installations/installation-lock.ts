/**
 * One lock for install, migration, launch, update, and policy changes.
 * Keep its target OUTSIDE the installation directory: a fresh install must
 * acquire exclusion before publishing a directory that readers can migrate.
 * Every holder agrees on the stale threshold so none breaks a live npm install.
 */
import * as path from 'node:path';
import { ensureLockTarget, type FileLockOptions } from '../fs-atomic.js';
import { getHistoryDir } from '../state.js';
import { VERSION_RE } from '../agent-spec/primitives.js';
import { isAgentId, type AgentId } from '../types.js';

export function installationLockTarget(agent: AgentId, label: string): string {
  if (!isAgentId(agent) || !VERSION_RE.test(label)) throw new Error('Invalid managed installation.');
  // Encode labels so a valid "foo.lock" cannot collide with the lock directory
  // for "foo". Windows aliases must still contend for the same physical home.
  const canonicalLabel = process.platform === 'win32' ? label.toLowerCase().replace(/\.+$/, '') : label;
  const key = Buffer.from(canonicalLabel).toString('hex') || 'empty';
  const target = path.join(getHistoryDir(), 'installation-locks', agent, key);
  ensureLockTarget(target, '', 0o700);
  return target;
}

const INSTALLATION_LOCK_STALE_MS = 10 * 60_000;
const INSTALLATION_LOCK_ACQUIRE_TIMEOUT_MS = 5 * 60_000;

export const INSTALLATION_LOCK_OPTIONS: Required<FileLockOptions> = {
  staleMs: INSTALLATION_LOCK_STALE_MS,
  acquireTimeoutMs: INSTALLATION_LOCK_ACQUIRE_TIMEOUT_MS,
  realpath: false,
};
