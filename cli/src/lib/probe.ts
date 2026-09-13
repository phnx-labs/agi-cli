/**
 * Spawn helpers for CAPABILITY PROBES — short-lived invocations of third-party
 * binaries (`copilot --version`, a manifest's `check:` command) whose only job
 * is an exit status or a line of stdout.
 *
 * A probed binary may fork children of its own: the copilot npm wrapper forks
 * a platform-binary downloader into `~/Library/Caches/copilot` on first run
 * under a fresh HOME. Node's `timeout:` option kills only the DIRECT child, so
 * such grandchildren outlive the probe and keep writing — under a test's temp
 * HOME that race is the ENOTEMPTY teardown class (RUSH-3028; residual after
 * RUSH-3021 gated the daemon autostart). Every probe here therefore runs in
 * its OWN process group (`detached`), and the whole group is reaped once the
 * probe settles, so nothing a probe spawned can outlive it.
 *
 * Group semantics are POSIX only: on win32 `detached` means a new console and
 * negative-pid group kills are unsupported, so there the DIRECT child is
 * killed on settle instead — the same guarantee `execFileAsync`'s `timeout:`
 * gave (the grandchild leak class is a darwin/linux temp-HOME teardown race).
 *
 * The parent dying mid-probe is covered too: a detached probe leaves the
 * terminal's foreground group, so a Ctrl-C that hard-exits the CLI
 * (`process.exit(130)` in index.ts) would strand it. Live probe groups are
 * tracked in LIVE_GROUPS and a `process.on('exit')` hook — which runs on
 * every `process.exit` path, including that SIGINT handler — reaps them
 * synchronously.
 */
import { spawn } from 'child_process';

const GROUP_REAP = process.platform !== 'win32';

const LIVE_GROUPS = new Set<number>();
let exitHookInstalled = false;

function ensureExitHook(): void {
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  process.on('exit', () => {
    for (const pid of LIVE_GROUPS) {
      try {
        process.kill(-pid, 'SIGKILL');
      } catch {
        /* group already fully exited */
      }
    }
  });
}

function reapGroup(pid: number | undefined): void {
  if (!GROUP_REAP || !pid) return;
  LIVE_GROUPS.delete(pid);
  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    /* group already fully exited */
  }
}

/**
 * Async probe capturing stdout. Rejects on spawn error, non-zero exit, or
 * timeout — matching the `execFileAsync` contract the version probe had — and
 * reaps the probe's whole process group on every settle path.
 */
export function probeCapture(
  cmd: string,
  args: string[],
  timeoutMs: number,
  options: { acceptedExitCodes?: number[]; maxOutputBytes?: number } = {},
): Promise<{ stdout: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      detached: GROUP_REAP,
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
    });
    if (GROUP_REAP && child.pid) {
      LIVE_GROUPS.add(child.pid);
      ensureExitHook();
    }
    let out = '';
    let settled = false;
    const settle = (err: Error | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reapGroup(child.pid);
      // win32 has no group to reap: kill the direct child so a timed-out
      // probe still dies, matching execFile's `timeout:` behavior. No-op
      // after a clean exit.
      if (!GROUP_REAP) child.kill('SIGKILL');
      if (err) reject(err);
      else resolve({ stdout: out });
    };
    const timer = setTimeout(
      () => settle(new Error(`probe timed out after ${timeoutMs}ms: ${cmd} ${args.join(' ')}`)),
      timeoutMs,
    );
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (d: string) => {
      out += d;
      if (Buffer.byteLength(out) > (options.maxOutputBytes ?? 1024 * 1024)) {
        settle(new Error(`probe output exceeded limit: ${cmd}`));
      }
    });
    child.on('error', (e) => settle(e));
    // 'exit', not 'close': a forked grandchild inherits the stdout pipe, and
    // 'close' waits for EVERY holder of that pipe to exit — exactly the
    // process this helper exists to reap. Settle when the probed binary
    // itself exits; one tick's grace lets its final stdout chunks land.
    child.on('exit', (code) => {
      setImmediate(() =>
        settle(code !== null && (options.acceptedExitCodes ?? [0]).includes(code) ? null : new Error(`probe exited ${code}: ${cmd} ${args.join(' ')}`)),
      );
    });
  });
}
