/**
 * Shared cross-machine fan-out for JSON-producing `agents` commands.
 *
 * Registered online devices are queried in parallel over the canonical SSH
 * transport. A recursion-guard environment variable makes each peer answer for
 * itself, and version-skewed or unreachable peers are skipped without hiding
 * healthy results from the rest of the fleet.
 */
import { spawn } from 'child_process';
import { setMaxListeners } from 'node:events';
import chalk from 'chalk';
import {
  SSH_OPTS,
  controlOpts,
  assertValidSshTarget,
  shellQuote,
  REMOTE_STDOUT_MAX_BYTES,
  RemoteUtf8Accumulator,
} from './ssh-exec.js';
import { deviceIdentityArgs, sshTargetFor } from './devices/connect.js';
import { resolveExplicitTargets } from './devices/resolve-target.js';
import { loadDevices, isDialableDevice, type DeviceProfile } from './devices/registry.js';
import { remoteShellFor, buildWindowsAgentsCommand, stripClixml } from './hosts/remote-cmd.js';
import { machineId, normalizeHost } from './machine-id.js';

const REMOTE_TIMEOUT_MS = 12_000;

export interface RemoteAgentsJsonOptions<T> {
  args: string[];
  noFanoutEnv: string;
  hosts?: string[];
  parse: (stdout: string, machine: string) => T[] | RemoteAgentsJsonParseResult<T>;
  /**
   * Suppress the per-device "unreachable — skipped" stderr line. The skipped
   * names still come back in {@link RemoteAgentsJsonResult.skipped}, so a caller
   * that fans out by DEFAULT can report them once, compactly, instead of
   * printing a line per offline box above its output. Never a silent drop.
   */
  quiet?: boolean;
  /** Per-peer deadline. Long-running maintenance commands override 12 seconds. */
  timeoutMs?: number;
  /**
   * Opt-in early-exit for a globally-unique lookup (a full session UUID). When a
   * peer returns an item that satisfies {@link isDefinitive}, the fan-out
   * resolves immediately and SIGTERMs every still-outstanding peer instead of
   * waiting for the slowest one to hit {@link REMOTE_TIMEOUT_MS}.
   *
   * OMITTED BY DEFAULT — tool-search, program-count, and the default session
   * listing keep the all-settle behavior (ambiguity, or a label/prefix conflict,
   * is only known once every peer has answered). Only the full-UUID resolve path
   * opts in, since only a UUID guarantees the first hit is the only hit.
   */
  earlyExit?: {
    isDefinitive: (item: T, machine: string) => boolean;
  };
}

/**
 * The SSH boundary as a swappable dependency so the fan-out logic is testable
 * without a live tailnet. Production wires this to the real {@link sshCapture}.
 */
export type SshCaptureFn = (
  target: string,
  remoteCmd: string,
  opts: { timeoutMs: number; signal?: AbortSignal; extraSshArgs?: string[] },
) => Promise<{ code: number | null; stdout: string }>;

export interface GatherRemoteAgentsJsonDeps {
  capture?: SshCaptureFn;
}

export interface RemoteAgentsJsonParseResult<T> {
  items: T[];
  valid: boolean;
}

export interface RemoteAgentsJsonResult<T> {
  items: T[];
  deviceCount: number;
  /** Devices that were dialed but answered with an error / no CLI / a timeout. */
  skipped: string[];
  /** Devices that exited successfully but returned invalid JSON for this command. */
  parseFailed: string[];
  /** Whether automatic target discovery failed before any peer could be dialed. */
  discoveryFailed: boolean;
}

export function normalizeRemoteAgentsJsonParse<T>(
  parsed: T[] | RemoteAgentsJsonParseResult<T>,
): RemoteAgentsJsonParseResult<T> {
  return Array.isArray(parsed) ? { items: parsed, valid: true } : parsed;
}

export function parseRemoteAgentsJsonPayload<T>(
  stdout: string,
  machine: string,
  parse: RemoteAgentsJsonOptions<T>['parse'],
): { items: T[]; parseFailed: boolean } {
  // A Windows peer can prefix the JSON with a PowerShell CLIXML banner; strip it
  // before handing stdout to the command-specific parser (RUSH-2286).
  const parsed = normalizeRemoteAgentsJsonParse(parse(stripClixml(stdout), machine));
  return parsed.valid
    ? { items: parsed.items, parseFailed: false }
    : { items: [], parseFailed: true };
}

/** Build the command one peer runs, with a guard that prevents recursive fan-out. */
export function remoteAgentsJsonCommand(args: string[], noFanoutEnv: string, os?: string): string {
  if (remoteShellFor(os) === 'powershell') {
    return buildWindowsAgentsCommand({ args, env: { [noFanoutEnv]: '1' } });
  }
  const inner = `${noFanoutEnv}=1 agents ${args.map(shellQuote).join(' ')}`;
  return `bash -lc ${shellQuote(inner)}`;
}

/**
 * The subset of a spawned `ssh` child this capture loop drives. Structural so a
 * unit test can feed synthetic `data`/`close` events through a fake without a
 * live SSH connection.
 */
export interface CapturableChild {
  stdout: { on(event: 'data', listener: (chunk: Buffer) => void): unknown } | null;
  on(event: 'error' | 'close', listener: (arg?: number | null) => void): unknown;
  kill(signal?: NodeJS.Signals): unknown;
}

/**
 * Stream one child's stdout into memory under a hard per-peer byte ceiling.
 *
 * A cross-machine fan-out awaits every peer's capture under one `Promise.all`,
 * so an unbounded buffer means a single runaway peer (a corrupt or
 * pathologically large payload) exhausts the caller's heap and takes the whole
 * sweep down — RUSH-2065. Once the accumulated bytes would exceed
 * {@link REMOTE_STDOUT_MAX_BYTES}, the child is SIGKILLed and the capture settles
 * as `code: null` (unreachable) rather than trust a truncated body. A definitive
 * early-exit `signal` SIGTERMs the child the same way, and the timer is the
 * per-peer deadline.
 */
export function captureBoundedStdout(
  child: CapturableChild,
  { timeoutMs, signal }: { timeoutMs: number; signal?: AbortSignal },
): Promise<{ code: number | null; stdout: string }> {
  return new Promise((resolve) => {
    const decoded = new RemoteUtf8Accumulator();
    let stdoutBytes = 0;
    let settled = false;
    const done = (code: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      // A killed/aborted capture never cleanly ends its decoder; return what
      // decoded so far (the caller treats a non-zero code as unreachable and
      // ignores stdout anyway).
      resolve({ code, stdout: code === null ? decoded.current() : decoded.end() });
    };
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      done(null);
    }, timeoutMs);
    // A definitive hit on a fast peer cancels the rest: SIGTERM the child so an
    // unreachable peer is not left running to its full timeout.
    const onAbort = () => { child.kill('SIGTERM'); done(null); };
    signal?.addEventListener('abort', onAbort, { once: true });
    child.stdout?.on('data', (data: Buffer) => {
      // Over the ceiling, SIGKILL the child and treat it as unreachable rather
      // than trust a partial payload — the RUSH-2065 OOM guard.
      if (stdoutBytes + data.byteLength > REMOTE_STDOUT_MAX_BYTES) {
        child.kill('SIGKILL');
        done(null);
        return;
      }
      stdoutBytes += data.byteLength;
      decoded.write(data);
    });
    child.on('error', () => done(null));
    child.on('close', (code) => done(code ?? null));
  });
}

const sshCapture: SshCaptureFn = (target, remoteCmd, { timeoutMs, signal, extraSshArgs }) => {
  assertValidSshTarget(target);
  if (signal?.aborted) return Promise.resolve({ code: null, stdout: '' });
  const args = [...SSH_OPTS, ...controlOpts(), ...(extraSshArgs ?? []), target, remoteCmd];
  const child = spawn('ssh', args, { stdio: ['ignore', 'pipe', 'ignore'] });
  return captureBoundedStdout(child, { timeoutMs, signal });
};

/** Query explicit hosts, or every registered online peer when hosts is omitted. */
export async function gatherRemoteAgentsJson<T>(
  options: RemoteAgentsJsonOptions<T>,
  deps: GatherRemoteAgentsJsonDeps = {},
): Promise<RemoteAgentsJsonResult<T>> {
  const capture = deps.capture ?? sshCapture;
  const self = machineId();
  const targets: Array<{ target: string; machine: string; name: string; os?: string; extraSshArgs?: string[] }> = [];

  if (options.hosts && options.hosts.length > 0) {
    targets.push(...await resolveExplicitTargets(options.hosts));
  } else {
    let devices: Record<string, DeviceProfile>;
    try {
      devices = await loadDevices();
    } catch {
      return { items: [], deviceCount: 0, skipped: [], parseFailed: [], discoveryFailed: true };
    }
    for (const device of Object.values(devices)) {
      // Live SSH-probe verdict first, cached tailscale snapshot only as a
      // fallback — see isDialableDevice (mirrors session/remote-list.ts).
      if (!isDialableDevice(device)) continue;
      if (normalizeHost(device.name) === self) continue;
      if (!['windows', 'linux', 'macos'].includes(device.platform)) continue;
      try {
        targets.push({
          target: sshTargetFor(device),
          machine: normalizeHost(device.name),
          name: device.name,
          os: device.platform,
          extraSshArgs: deviceIdentityArgs(device),
        });
      } catch {
        // A registered profile without a dialable address is not a peer yet.
      }
    }
  }

  const skipped: string[] = [];
  const parseFailed: string[] = [];

  // The controller exists ONLY for early-exit: the first definitive hit aborts
  // every still-outstanding peer. When earlyExit is not requested there is no
  // controller and no per-peer abort listener, so the default path is a plain
  // all-settle Promise.all, byte-identical to before (tool-search, program-count).
  const controller = options.earlyExit ? new AbortController() : undefined;
  // A fleet can hold more peers than Node's default 10-listener cap; each peer's
  // capture adds one abort listener, so lift the cap to avoid a spurious warning.
  if (controller) setMaxListeners(targets.length + 1, controller.signal);
  let earlyResolved = false;

  const results = await Promise.all(targets.map(async (target) => {
    const command = remoteAgentsJsonCommand(options.args, options.noFanoutEnv, target.os);
    const result = await capture(target.target, command, {
      timeoutMs: options.timeoutMs ?? REMOTE_TIMEOUT_MS,
      signal: controller?.signal,
      extraSshArgs: target.extraSshArgs,
    });
    // A peer we deliberately cancelled is neither a hit nor a failure — it never
    // got to answer, so it must not pollute skipped/parseFailed (which drive the
    // "unreachable" listing and the fail-closed partial-resolution gate).
    const cancelled = controller?.signal.aborted ?? false;
    if (result.code !== 0) {
      if (!cancelled) {
        skipped.push(target.name);
        if (!options.quiet) {
          process.stderr.write(chalk.gray(`  ${target.name}: unreachable or no agents CLI — skipped\n`));
        }
      }
      return [] as T[];
    }
    const parsed = parseRemoteAgentsJsonPayload(result.stdout, target.machine, options.parse);
    if (parsed.parseFailed) {
      if (!cancelled) {
        parseFailed.push(target.name);
        if (!options.quiet) {
          process.stderr.write(chalk.gray(`  ${target.name}: invalid response data — skipped\n`));
        }
      }
      return [] as T[];
    }
    if (controller && options.earlyExit && !earlyResolved
      && parsed.items.some((item) => options.earlyExit!.isDefinitive(item, target.machine))) {
      earlyResolved = true;
      controller.abort(); // SIGTERM the remaining peers; they settle fast below.
    }
    return parsed.items;
  }));

  return { items: results.flat(), deviceCount: targets.length, skipped, parseFailed, discoveryFailed: false };
}
