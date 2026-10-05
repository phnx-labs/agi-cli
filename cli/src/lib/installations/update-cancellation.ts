
export const HARNESS_UPDATE_CHILD_CMD = '__harness-update-run';

export const HARNESS_UPDATE_CANCEL_MSG = 'harness-update:cancel';

export const GUARDED_AUTO_UPDATE_SYMBOL = Symbol.for('agents.guardedAutoUpdateDepth');

type GuardHolder = { [GUARDED_AUTO_UPDATE_SYMBOL]?: number };

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
