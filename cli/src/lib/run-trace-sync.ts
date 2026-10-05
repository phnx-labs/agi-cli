import { spawn } from 'child_process';

import { getCliLaunch } from './cli-entry.js';
import { readSession } from './identity/client.js';
import { hasSyncedBefore } from './traces/sync.js';

export function shouldAutoSyncTraces(disabled: boolean): boolean {
  if (disabled) return false;
  if (process.env.AGENTS_NO_TRACE_SYNC === '1') return false;
  if (!readSession()) return false;
  if (!hasSyncedBefore()) return false;
  return true;
}

function spawnDetachedTraceSync(): void {
  try {
    const { command, args } = getCliLaunch(['traces', 'sync']);
    const child = spawn(command, args, { detached: true, stdio: 'ignore' });
    child.on('error', () => {});
    child.unref();
  } catch {
  }
}

export function armRunFinishTraceSync(opts: { disabled?: boolean } = {}): void {
  if (!shouldAutoSyncTraces(!!opts.disabled)) return;
  process.on('exit', spawnDetachedTraceSync);
}

export function fireTraceSyncInBackground(opts: { disabled?: boolean } = {}): void {
  if (!shouldAutoSyncTraces(!!opts.disabled)) return;
  spawnDetachedTraceSync();
}
