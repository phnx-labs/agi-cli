/**
 * Injectable terminal driver over the standalone `term` CLI.
 *
 * A small seam that lets a flow drive a PTY session — start, exec, write,
 * screen-scrape, stop — through the real `term` CLI in production and a fake in
 * tests. The setup-token mint (`lib/auth-mint.ts`) is the sole consumer today.
 */
import { termStart, termExec, termWrite, termScreen, termStop } from './term-client.js';

/** The subset of the `term` CLI a screen-scraping drive loop needs — faked in tests. */
export interface TermDriver {
  start(opts?: { rows?: number; cols?: number }): Promise<string>;
  exec(id: string, command: string): Promise<void>;
  write(id: string, input: string): Promise<void>;
  screen(id: string): Promise<{ screen: string; exited: boolean }>;
  stop(id: string): Promise<void>;
}

/** Real driver over the standalone `term` CLI (`./term-client.js`). */
export function defaultTermDriver(): TermDriver {
  const expectOk = (res: { ok: boolean; error?: string }, what: string) => {
    if (!res.ok) throw new Error(`term ${what} failed: ${res.error ?? 'unknown'}`);
  };
  return {
    async start(opts) {
      const res = await termStart({ rows: opts?.rows ?? 40, cols: opts?.cols ?? 120 });
      expectOk(res, 'start');
      return res.id as string;
    },
    async exec(id, command) {
      expectOk(await termExec(id, command), 'exec');
    },
    async write(id, input) {
      expectOk(await termWrite(id, input), 'write');
    },
    async screen(id) {
      const res = await termScreen(id);
      expectOk(res, 'screen');
      return { screen: (res.screen as string) ?? '', exited: Boolean(res.exited) };
    },
    async stop(id) {
      await termStop(id).catch(() => undefined);
    },
  };
}

export interface DriveOptions {
  /** Wait after launching before steering / scraping (default 4000ms). */
  initialDelayMs?: number;
  /** Poll cadence for the scrape loop (default 1000ms). */
  pollMs?: number;
  /** Overall scrape deadline (default 90000ms). */
  timeoutMs?: number;
}
