/** One lock for install, migration, launch, update and policy changes. Its target stays outside
 * the installation dir so a fresh install gets exclusion before publishing a dir readers can
 * migrate. All holders share the stale threshold so none breaks a live npm install. */
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
