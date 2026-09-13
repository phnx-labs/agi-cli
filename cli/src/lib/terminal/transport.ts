/**
 * Transport — runs a LaunchSpec locally or on a remote host.
 *
 * Local: spawn the launcher (osascript / tmux) and wait for it to exit — these
 * are short-lived commands that create the surface and return, so waiting gives
 * a real success/failure. Remote: serialize the argv into one shell string and
 * hand it to `sshExec` — the same hardened SSH primitive `agents sessions
 * --device` and the browser driver use (target-injection guard, POSIX quoting,
 * connection multiplexing).
 */
import { spawn } from 'child_process';
import { sshExec } from '../ssh-exec.js';
import { shellQuote } from './quote.js';
import type { LaunchSpec } from './types.js';

/** Resolve a host alias to an ssh target. Default: identity (ssh_config resolves it). */
export type HostResolver = (alias: string) => string;

export interface RunResult {
  ok: boolean;
  error?: string;
}

/** Grace between SIGTERM and SIGKILL when a deadline cancels a launcher. */
export const SPEC_KILL_GRACE_MS = 250;

/**
 * Run the spec on this machine: spawn the launcher, resolve when it exits.
 *
 * `timeoutMs` makes the call genuinely bounded rather than merely raced: the
 * child is spawned in its OWN process group (`detached`) and the whole group is
 * signalled on expiry, so a launcher that itself spawned something (osascript →
 * the app, tmux → the server) cannot keep running after the caller has given up.
 * Racing the promise alone leaves the process behind (PHNX-3999).
 */
export function runLocal(spec: LaunchSpec, timeoutMs?: number): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = spawn(spec.argv[0], spec.argv.slice(1), { stdio: 'ignore', detached: !!timeoutMs });
    let settled = false;
    let killTimer: ReturnType<typeof setTimeout> | null = null;
    // NOTE: the pending SIGKILL is deliberately NOT cancelled here. Resolving
    // the promise is the CALLER giving up; it is not the child exiting. Clearing
    // the kill timer on the timeout path (which resolves immediately after
    // arming it) meant a SIGTERM-ignoring child was never killed and simply
    // survived the bound this function exists to enforce.
    const done = (result: RunResult): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(result);
    };
    const signalGroup = (signal: NodeJS.Signals): void => {
      try {
        if (child.pid) process.kill(timeoutMs ? -child.pid : child.pid, signal);
      } catch { /* already gone */ }
    };
    const timer = timeoutMs
      ? setTimeout(() => {
          signalGroup('SIGTERM');
          killTimer = setTimeout(() => signalGroup('SIGKILL'), SPEC_KILL_GRACE_MS);
          killTimer.unref?.();
          done({ ok: false, error: `${spec.argv[0]} did not finish in ${timeoutMs}ms` });
        }, timeoutMs)
      : null;
    // Only the child ACTUALLY exiting retires the pending SIGKILL.
    const childGone = (): void => { if (killTimer) { clearTimeout(killTimer); killTimer = null; } };
    child.on('error', (err: any) => { childGone(); done({ ok: false, error: err.message }); });
    child.on('close', (code) => {
      childGone();
      done(code === 0 ? { ok: true } : { ok: false, error: `${spec.argv[0]} exited with code ${code}` });
    });
  });
}

/** Serialize a launch argv into a single POSIX-quoted shell command string. */
export function remoteCommand(spec: LaunchSpec): string {
  return spec.argv.map(shellQuote).join(' ');
}

/** Run the spec on a remote host over SSH. `timeoutMs` bounds the ssh client. */
export function runRemote(spec: LaunchSpec, target: string, timeoutMs?: number): RunResult {
  const res = sshExec(target, remoteCommand(spec), { multiplex: !timeoutMs, timeoutMs });
  if (res.timedOut) return { ok: false, error: `ssh to ${target} did not finish in ${timeoutMs}ms` };
  if (res.code === 0) return { ok: true };
  const err = (res.stderr || '').trim();
  return { ok: false, error: err || `ssh exited with code ${res.code}` };
}

/** Run a spec locally (no host / 'local') or on a resolved remote host. */
export async function runSpec(
  spec: LaunchSpec, host?: string, resolveHost?: HostResolver, timeoutMs?: number,
): Promise<RunResult> {
  if (!host || host === 'local') return runLocal(spec, timeoutMs);
  const target = resolveHost ? resolveHost(host) : host;
  return runRemote(spec, target, timeoutMs);
}
