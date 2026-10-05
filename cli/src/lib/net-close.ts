import type * as net from 'node:net';

const SERVER_CLOSE_TIMEOUT_MS = 5000;

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
      finish();
    }
  });
}
