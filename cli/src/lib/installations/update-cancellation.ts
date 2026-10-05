/** Cooperative cancellation for the auto-update pass (PHNX-3940). A transactional pass can't be
 * killed mid-swap, and `execFile`'s timeout force-kills (always on Windows), so the daemon
 * sends an IPC message that flips the flag `shouldCancel` reads. A dependency-free leaf. */

/** The hidden verb the daemon spawns to run one auto-update pass with IPC-driven cancellation
 * (dispatched in `index.ts`, handled by `runHarnessUpdateChild` in update-runtime.ts); an
 * internal protocol, not a public command. */
export const HARNESS_UPDATE_CHILD_CMD = '__harness-update-run';

/** IPC message `type` the daemon sends to request a cooperative stop. */
export const HARNESS_UPDATE_CANCEL_MSG = 'harness-update:cancel';

/** Well-known cross-realm key for the count of guarded auto-update passes in this process.
 * `index.ts`'s SIGINT handler reads it via `Symbol.for(...)` without importing this module
 * (keeping the entry shell slim), so the state lives in the global symbol registry. */
export const GUARDED_AUTO_UPDATE_SYMBOL = Symbol.for('agents.guardedAutoUpdateDepth');

type GuardHolder = { [GUARDED_AUTO_UPDATE_SYMBOL]?: number };

/** The IPC payload the daemon sends; `child.send(cancelMessage())`. */
export function cancelMessage(): { type: typeof HARNESS_UPDATE_CANCEL_MSG } {
  return { type: HARNESS_UPDATE_CANCEL_MSG };
}

function isCancelMessage(msg: unknown): boolean {
  return (
    typeof msg === 'object' &&
    msg !== null &&
    (msg as { type?: unknown }).type === HARNESS_UPDATE_CANCEL_MSG
  );
}

/** True while a guarded auto-update pass is mutating this process; `index.ts`'s SIGINT handler
 * defers `process.exit(130)` so Ctrl+C can't tear a swap apart, while the pass stops
 * cooperatively at its next boundary. A ref-counted depth, correct if passes nest. */
export function isGuardedAutoUpdateActive(): boolean {
  return ((globalThis as GuardHolder)[GUARDED_AUTO_UPDATE_SYMBOL] ?? 0) > 0;
}

function beginGuardedAutoUpdate(): void {
  const holder = globalThis as GuardHolder;
  holder[GUARDED_AUTO_UPDATE_SYMBOL] = (holder[GUARDED_AUTO_UPDATE_SYMBOL] ?? 0) + 1;
}

function endGuardedAutoUpdate(): void {
  const holder = globalThis as GuardHolder;
  const depth = holder[GUARDED_AUTO_UPDATE_SYMBOL] ?? 0;
  holder[GUARDED_AUTO_UPDATE_SYMBOL] = depth > 0 ? depth - 1 : 0;
}

/** Run `run(cancelled)` with cooperative cancellation from every source, holding the SIGINT
 * guard: an IPC cancel message (primary, works on Windows), `disconnect` (daemon gone) and
 * SIGTERM/SIGINT. `cancelled()` never un-sets; listeners are removed in `finally`. */
export async function withGuardedUpdateCancellation<T>(
  run: (cancelled: () => boolean) => Promise<T>,
): Promise<T> {
  let cancelled = typeof process.send === 'function' && process.connected === false;
  const requestStop = (): void => {
    cancelled = true;
  };
  const onMessage = (msg: unknown): void => {
    if (isCancelMessage(msg)) requestStop();
  };

  process.on('SIGTERM', requestStop);
  process.on('SIGINT', requestStop);
  process.on('message', onMessage);
  process.on('disconnect', requestStop);
  beginGuardedAutoUpdate();
  try {
    return await run(() => cancelled);
  } finally {
    endGuardedAutoUpdate();
    process.removeListener('SIGTERM', requestStop);
    process.removeListener('SIGINT', requestStop);
    process.removeListener('message', onMessage);
    process.removeListener('disconnect', requestStop);
  }
}
