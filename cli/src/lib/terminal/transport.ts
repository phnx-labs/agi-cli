import { spawn } from 'child_process';
import { sshExec } from '../ssh-exec.js';
import { shellQuote } from './quote.js';
import type { LaunchSpec } from './types.js';

export type HostResolver = (alias: string) => string;

export interface RunResult {
  ok: boolean;
  error?: string;
}

export const SPEC_KILL_GRACE_MS = 250;

export function runLocal(spec: LaunchSpec, timeoutMs?: number): Promise<RunResult> {
  return new Promise((resolve) => {

    const child = spawn(spec.argv[0], spec.argv.slice(1), { stdio: 'ignore', detached: !!timeoutMs });
    let settled = false;
    let killTimer: ReturnType<typeof setTimeout> | null = null;
    const done = (result: RunResult): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(result);
    };
    const signalGroup = (signal: NodeJS.Signals): void => {
      try {
        if (child.pid) process.kill(timeoutMs ? -child.pid : child.pid, signal);
      } catch {  }
    };
    const timer = timeoutMs
      ? setTimeout(() => {
          signalGroup('SIGTERM');
          killTimer = setTimeout(() => signalGroup('SIGKILL'), SPEC_KILL_GRACE_MS);
          killTimer.unref?.();
          done({ ok: false, error: `${spec.argv[0]} did not finish in ${timeoutMs}ms` });
        }, timeoutMs)
      : null;
    const childGone = (): void => { if (killTimer) { clearTimeout(killTimer); killTimer = null; } };
    child.on('error', (err: any) => { childGone(); done({ ok: false, error: err.message }); });
    child.on('close', (code) => {
      childGone();
      done(code === 0 ? { ok: true } : { ok: false, error: `${spec.argv[0]} exited with code ${code}` });
    });
  });
}

export function remoteCommand(spec: LaunchSpec): string {
  return spec.argv.map(shellQuote).join(' ');
}

export function runRemote(spec: LaunchSpec, target: string, timeoutMs?: number): RunResult {
  const res = sshExec(target, remoteCommand(spec), { multiplex: !timeoutMs, timeoutMs });
  if (res.timedOut) return { ok: false, error: `ssh to ${target} did not finish in ${timeoutMs}ms` };
  if (res.code === 0) return { ok: true };
  const err = (res.stderr || '').trim();
  return { ok: false, error: err || `ssh exited with code ${res.code}` };
}

export async function runSpec(
  spec: LaunchSpec, host?: string, resolveHost?: HostResolver, timeoutMs?: number,
): Promise<RunResult> {
  if (!host || host === 'local') return runLocal(spec, timeoutMs);
  const target = resolveHost ? resolveHost(host) : host;
  return runRemote(spec, target, timeoutMs);
}
