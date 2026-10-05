/** Auto-sync this device's finished session trace when a local headless `agents run` exits
 * (PHNX-3628) by spawning a detached `agents traces sync` (async can't run in an 'exit' handler).
 * Only if signed in and synced before; local runs only; opt out via --no-trace-sync or env. */
import { spawn } from 'child_process';

import { getCliLaunch } from './cli-entry.js';
import { readSession } from './identity/client.js';
import { hasSyncedBefore } from './traces/sync.js';

/** The policy check, pure and unit-testable; `disabled` is the resolved `--no-trace-sync` (commander
 * maps it to `traceSync === false`). */
export function shouldAutoSyncTraces(disabled: boolean): boolean {
  if (disabled) return false;
  if (process.env.AGENTS_NO_TRACE_SYNC === '1') return false;
  if (!readSession()) return false; // not signed in → nothing to authenticate an upload
  if (!hasSyncedBefore()) return false; // never opted into the traces store
  return true;
}

/** Spawn a detached, unref'd `agents traces sync` and return immediately. Re-invoke through
 * getCliLaunch, NOT [process.execPath, process.argv[1]]: under the compiled standalone binary
 * argv[1] is a bun virtual entry that silently no-ops the feature (cli-entry.ts). */
function spawnDetachedTraceSync(): void {
  try {
    const { command, args } = getCliLaunch(['traces', 'sync']);
    const child = spawn(command, args, { detached: true, stdio: 'ignore' });
    // A child that never starts (ENOENT) emits an async 'error'; without a
    // listener Node re-throws it as uncaught. Swallow — this is best-effort.
    child.on('error', () => {});
    child.unref();
  } catch {
    // A synchronous spawn failure must never change the caller's outcome.
  }
}

/** Arm a fire-and-forget `agents traces sync` for process exit; no-op unless {@link
 * shouldAutoSyncTraces} passes. Best-effort: a missing binary or stalled child never affects the
 * run. Spawned at exit because async upload can't run after it. */
export function armRunFinishTraceSync(opts: { disabled?: boolean } = {}): void {
  if (!shouldAutoSyncTraces(!!opts.disabled)) return;
  process.on('exit', spawnDetachedTraceSync);
}

/** Fire `agents traces sync` NOW. An important owner ping (`feed post --level important`, `agents
 * send --to owner`) links a console session page that exists only after upload, and sync otherwise
 * fires on run exit (PHNX-3628), so the link would 404. */
export function fireTraceSyncInBackground(opts: { disabled?: boolean } = {}): void {
  if (!shouldAutoSyncTraces(!!opts.disabled)) return;
  spawnDetachedTraceSync();
}
