
import { execFileBounded } from '../../exec-bounded.js';
import type { MonitorSource } from '../config.js';
import type { Observation } from './types.js';
import { classifyPollFailure } from './failure.js';

/** Hard cap on one command poll, the longest any poll source runs (http and device probes are shorter). */
export const POLL_TIMEOUT_MS = 60_000;

// execFileBounded kills the whole process group: execFile's timeout signalled only
// the shell, so a timed-out `agents devices ps | grep` left its children running.
export async function evaluate(source: MonitorSource, timeoutMs = POLL_TIMEOUT_MS): Promise<Observation | null> {
  const command = source.command;
  if (!command) return null;

  const [bin, args] = process.platform === 'win32'
    ? ['cmd', ['/c', command]]
    : ['/bin/sh', ['-c', command]];

  const { stdout, stderr, code, timedOut } = await execFileBounded(bin, args, { timeoutMs, maxBuffer: 8 * 1024 * 1024 });
  const exitCode = code ?? 1;
  const raw = (stdout.length > 0 ? stdout : stderr).replace(/\s+$/, '');
  const failureReason = timedOut ? `timed out after ${timeoutMs / 1000}s` : classifyPollFailure({ exitCode, text: raw });
  return {
    raw,
    meta: { exitCode },
    ...(failureReason ? { failed: true, failureReason } : {}),
  };
}
