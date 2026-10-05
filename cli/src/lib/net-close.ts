/** Bounded-close helper for a local `net.Server`. Generic (no secrets/engine dependency), so the
 * webhook receiver and daemon webhook service no longer import `lib/secrets/*`. */
import type * as net from 'node:net';

const SERVER_CLOSE_TIMEOUT_MS = 5000;

/** Closes `server`, resolving once closed or after `timeoutMs`, whichever comes first: a shutdown
 * must never hang on a client that never disconnects. */
export function closeServerBounded(
  server: net.Server,
  timeoutMs: number = SERVER_CLOSE_TIMEOUT_MS,
): Promise<void> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(finish, timeoutMs);
    try {
      server.close(() => finish());
    } catch {
      // Already closed / not listening — treat as released.
      finish();
    }
  });
}
