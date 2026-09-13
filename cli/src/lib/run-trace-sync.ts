/**
 * Auto-sync this device's just-finished session trace when a local, headless
 * `agents run` exits (PHNX-3628).
 *
 * Why exit-armed + spawn, exactly like `run-notify`: the sync reads this
 * device's `sessions.db` and PUTs redacted shards over the network — async work
 * that CANNOT run inside a `process.on('exit')` handler (Node runs no more
 * microtasks after exit). So, mirroring `notifyDesktop`, on exit we SPAWN a
 * detached `agents traces sync` and unref it; it finishes after the parent is
 * gone, and the run itself returns immediately instead of waiting on the PUTs.
 *
 * The upload is incremental by construction (`syncTraces` de-dups by the
 * `traces-sync.json` mtime watermark), so the spawned sync pushes essentially
 * just the session that finished, not the whole history.
 *
 * Default policy: fire ONLY when the user has ALREADY opted into the traces
 * store — i.e. they are signed in AND have run `agents traces sync` at least
 * once (`hasSyncedBefore`). A user who never synced is never touched. Opt out
 * of a given run with `--no-trace-sync` or `AGENTS_NO_TRACE_SYNC=1`.
 *
 * Local runs only: a run placed on another machine (`--device`/`--on`/
 * `--computer`/`--where device:`, `--lease`, `--box`, or `--cloud`) has its
 * trajectory on the REMOTE box, not this device's `sessions.db`, so arming here
 * would upload nothing useful — the remote box runs its own exit sync. The
 * caller gates every remote-placement signal out before arming (it reuses the
 * file's own `hostTargetGiven` predicate plus `--lease`/`--box`; `--cloud`
 * returns earlier).
 */
import { spawn } from 'child_process';

import { getCliLaunch } from './cli-entry.js';
import { readSession } from './identity/client.js';
import { hasSyncedBefore } from './traces/sync.js';

/**
 * The policy gate, pure and unit-testable. `disabled` is the resolved
 * `--no-trace-sync` (commander maps it to `traceSync === false`).
 */
export function shouldAutoSyncTraces(disabled: boolean): boolean {
  if (disabled) return false;
  if (process.env.AGENTS_NO_TRACE_SYNC === '1') return false;
  if (!readSession()) return false; // not signed in → nothing to authenticate an upload
  if (!hasSyncedBefore()) return false; // never opted into the traces store
  return true;
}

/**
 * Spawn a detached, unref'd `agents traces sync` and return immediately. The one
 * place the fire-and-forget child is built, shared by the run-exit arm and the
 * feed/notify important-post trigger.
 *
 * Re-invoke this CLI through getCliLaunch, NOT a hand-rolled
 * [process.execPath, process.argv[1], …] — under the compiled standalone binary
 * argv[1] is the bun virtual entry (/$bunfs/root/agents), which would become a
 * bogus subcommand and silently no-op the whole feature (cli-entry.ts). The
 * spawned `traces sync` is a fresh process with its own event loop, so its own
 * per-request network timeouts (syncTraces) bound it.
 */
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

/**
 * Arm a fire-and-forget `agents traces sync` for when this process exits.
 * No-op unless {@link shouldAutoSyncTraces} passes. Best-effort by
 * construction: a missing binary or a stalled child never affects the run.
 * The spawn happens in the exit handler because the upload is async work Node
 * cannot run after `exit` — a watchdog here could never fire.
 */
export function armRunFinishTraceSync(opts: { disabled?: boolean } = {}): void {
  if (!shouldAutoSyncTraces(!!opts.disabled)) return;
  process.on('exit', spawnDetachedTraceSync);
}

/**
 * Fire a fire-and-forget `agents traces sync` NOW (not on exit). An important
 * owner-bound ping (`feed post --level important`, `agents notify`,
 * `send --to owner`) links the caller's `…/console/sessions/<id>` page, and that
 * page only exists once the session's shard has been uploaded — trace sync fires
 * on run exit (PHNX-3628), not when a mid-run ping is posted. This closes that
 * gap so the tapped link resolves instead of 404ing. No-op unless
 * {@link shouldAutoSyncTraces} passes (signed in + already opted into the store);
 * the incremental watermark keeps the push to essentially just this session.
 */
export function fireTraceSyncInBackground(opts: { disabled?: boolean } = {}): void {
  if (!shouldAutoSyncTraces(!!opts.disabled)) return;
  spawnDetachedTraceSync();
}
