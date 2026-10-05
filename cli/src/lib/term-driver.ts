import { termStart, termExec, termWrite, termScreen, termStop } from './term-client.js';

export interface TermDriver {
  start(opts?: { rows?: number; cols?: number }): Promise<string>;
  exec(id: string, command: string): Promise<void>;
  write(id: string, input: string): Promise<void>;
  screen(id: string): Promise<{ screen: string; exited: boolean }>;
  stop(id: string): Promise<void>;
}

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
  initialDelayMs?: number;
  pollMs?: number;
  timeoutMs?: number;
}
