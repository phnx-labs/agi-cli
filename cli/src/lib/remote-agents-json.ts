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

interface RemoteAgentsJsonOptions<T> {
  args: string[];
  noFanoutEnv: string;
  hosts?: string[];
  parse: (stdout: string, machine: string) => T[] | RemoteAgentsJsonParseResult<T>;
  quiet?: boolean;
  timeoutMs?: number;
  earlyExit?: {
    isDefinitive: (item: T, machine: string) => boolean;
  };
}

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

interface RemoteAgentsJsonResult<T> {
  items: T[];
  deviceCount: number;
  skipped: string[];
  parseFailed: string[];
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
  const parsed = normalizeRemoteAgentsJsonParse(parse(stripClixml(stdout), machine));
  return parsed.valid
    ? { items: parsed.items, parseFailed: false }
    : { items: [], parseFailed: true };
}

export function remoteAgentsJsonCommand(args: string[], noFanoutEnv: string, os?: string): string {

  if (remoteShellFor(os) === 'powershell') {
    return buildWindowsAgentsCommand({ args, env: { [noFanoutEnv]: '1' } });
  }
  const inner = `${noFanoutEnv}=1 agents ${args.map(shellQuote).join(' ')}`;
  return `bash -lc ${shellQuote(inner)}`;
}

export interface CapturableChild {
  stdout: { on(event: 'data', listener: (chunk: Buffer) => void): unknown } | null;
  on(event: 'error' | 'close', listener: (arg?: number | null) => void): unknown;
  kill(signal?: NodeJS.Signals): unknown;
}

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
      resolve({ code, stdout: code === null ? decoded.current() : decoded.end() });
    };
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      done(null);
    }, timeoutMs);
    const onAbort = () => { child.kill('SIGTERM'); done(null); };
    signal?.addEventListener('abort', onAbort, { once: true });
    child.stdout?.on('data', (data: Buffer) => {
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
      }
    }
  }

  const skipped: string[] = [];
  const parseFailed: string[] = [];

  const controller = options.earlyExit ? new AbortController() : undefined;
  if (controller) setMaxListeners(targets.length + 1, controller.signal);
  let earlyResolved = false;

  const results = await Promise.all(targets.map(async (target) => {
    const command = remoteAgentsJsonCommand(options.args, options.noFanoutEnv, target.os);
    const result = await capture(target.target, command, {
      timeoutMs: options.timeoutMs ?? REMOTE_TIMEOUT_MS,
      signal: controller?.signal,
      extraSshArgs: target.extraSshArgs,
    });
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
      controller.abort();
    }
    return parsed.items;
  }));

  return { items: results.flat(), deviceCount: targets.length, skipped, parseFailed, discoveryFailed: false };
}
