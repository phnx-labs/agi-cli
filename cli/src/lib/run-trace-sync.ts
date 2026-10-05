import { spawn } from 'child_process';

import { getCliLaunch } from './cli-entry.js';
import { readSession } from './identity/client.js';
import { hasSyncedBefore } from './traces/sync.js';

export function shouldAutoSyncTraces(disabled: boolean): boolean {
  // Auto-upload is opt-in only: signed in and previously synced; never first-touch an unsynced user.
  if (disabled) return false;
  if (process.env.AGENTS_NO_TRACE_SYNC === '1') return false;
  if (!readSession()) return false;
  if (!hasSyncedBefore()) return false;
  return true;
}

function spawnDetachedTraceSync(): void {
  // Exit handlers cannot await PUTs, so spawn an unref'd incremental sync through getCliLaunch; compiled Bun argv is unusable.
  try {
    const { command, args } = getCliLaunch(['traces', 'sync']);
    const child = spawn(command, args, { detached: true, stdio: 'ignore' });
    child.on('error', () => {});
    child.unref();
  } catch {
  }
}

export function armRunFinishTraceSync(opts: { disabled?: boolean } = {}): void {
  // Arm only local runs; a remotely placed run's machine owns its trace.
  if (!shouldAutoSyncTraces(!!opts.disabled)) return;
  process.on('exit', spawnDetachedTraceSync);
}

export function fireTraceSyncInBackground(opts: { disabled?: boolean } = {}): void {
  // Important pings sync now so their console-session link exists before the recipient opens it.
  if (!shouldAutoSyncTraces(!!opts.disabled)) return;
  spawnDetachedTraceSync();
}
