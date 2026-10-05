
import { execFile } from 'child_process';
import type { MonitorSource } from '../config.js';
import type { Observation } from './types.js';
import { classifyPollFailure } from './failure.js';

const DEFAULT_TIMEOUT_MS = 60_000;

export function evaluate(source: MonitorSource): Promise<Observation | null> {
  const command = source.command;
  if (!command) return Promise.resolve(null);

  const [bin, args] = process.platform === 'win32'
    ? ['cmd', ['/c', command]]
    : ['/bin/sh', ['-c', command]];

  return new Promise<Observation | null>((resolve) => {
    execFile(
      bin as string,
      args as string[],
      { encoding: 'utf-8', timeout: DEFAULT_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024 },
      (err, stdout, stderr) => {
        const exitCode = err && typeof (err as { code?: unknown }).code === 'number'
          ? (err as { code: number }).code
          : err
            ? 1
            : 0;
        const raw = (stdout && stdout.length > 0 ? stdout : stderr ?? '').replace(/\s+$/, '');
        const failureReason = classifyPollFailure({ exitCode, text: raw });
        resolve({
          raw,
          meta: { exitCode },
          ...(failureReason ? { failed: true, failureReason } : {}),
        });
      },
    );
  });
}
