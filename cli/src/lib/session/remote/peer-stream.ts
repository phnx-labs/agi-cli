import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import { createInterface } from 'node:readline';
import { deviceIdentityArgs, sshTargetFor } from '../../devices/connect.js';
import type { DeviceProfile } from '../../devices/registry.js';
import { SSH_OPTS, controlOpts } from '../../ssh-exec.js';
import { getDevicesRegistryPath } from '../../state.js';

export const PEER_BACKOFF_BASE_MS = 2_000;
export const PEER_BACKOFF_CAP_MS = 60_000;
export const PEER_PARK_AFTER_FAILURES = 3;
export const PEER_RETIRE_AFTER_FAILURES = 10;
export const PEER_RETIRED_RECHECK_MS = 15 * 60_000;
const PEER_STDERR_BYTES = 2_048;
const PEER_REGISTRY_POLL_MS = 5_000;

export function peerBackoffDelayMs(
  failures: number,
  base = PEER_BACKOFF_BASE_MS,
  cap = PEER_BACKOFF_CAP_MS,
  retireAfter = PEER_RETIRE_AFTER_FAILURES,
  retiredMs = PEER_RETIRED_RECHECK_MS,
): number {
  if (failures <= 0) return 0;
  if (failures >= retireAfter) return retiredMs;
  return Math.min(cap, base * 2 ** (failures - 1));
}

interface PeerStreamOptions {
  device: DeviceProfile;
  command: string;
  signal: AbortSignal;
  onLine: (line: string) => boolean;
  onUnavailable: (reason: string) => void;
  backoffBaseMs?: number;
  backoffCapMs?: number;
  parkAfterFailures?: number;
  retireAfterFailures?: number;
  retiredRecheckMs?: number;
  sshBin?: string;
  registryPollMs?: number;
  registryPath?: string;
}

function stderrTail(chunks: string, next: string, limit: number): string {
  const joined = chunks + next;
  return joined.length > limit ? joined.slice(joined.length - limit) : joined;
}

function reasonFor(exit: string, stderr: string): string {
  const detail = stderr.split('\n').map((line) => line.trim()).filter(Boolean).pop();
  return detail ? `${exit}: ${detail}` : exit;
}

async function parkedWait(options: PeerStreamOptions, delayMs: number): Promise<void> {
  const registry = options.registryPath ?? getDevicesRegistryPath();
  const pollMs = options.registryPollMs ?? PEER_REGISTRY_POLL_MS;
  const stampOf = () => {
    try { const st = fs.statSync(registry); return `${st.size}:${st.mtimeMs}`; } catch { return ''; }
  };
  const before = stampOf();
  await new Promise<void>((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(deadline);
      clearInterval(poll);
      options.signal.removeEventListener('abort', finish);
      resolve();
    };
    const deadline = setTimeout(finish, delayMs);
    const poll = setInterval(() => { if (stampOf() !== before) finish(); }, Math.min(pollMs, Math.max(delayMs, 1)));
    options.signal.addEventListener('abort', finish, { once: true });
  });
}

export async function streamFromPeer(options: PeerStreamOptions): Promise<void> {
  const parkAfter = options.parkAfterFailures ?? PEER_PARK_AFTER_FAILURES;
  let failures = 0;
  while (!options.signal.aborted) {
    let target: string;
    try { target = sshTargetFor(options.device); } catch (error) {
      options.onUnavailable(error instanceof Error ? error.message : String(error));
      return;
    }
    const child = spawn(options.sshBin ?? 'ssh', [
      ...SSH_OPTS, ...controlOpts(), ...deviceIdentityArgs(options.device), target, options.command,
    ], { stdio: ['ignore', 'pipe', 'pipe'] });
    const stop = () => child.kill('SIGTERM');
    options.signal.addEventListener('abort', stop, { once: true });
    let stderr = '';
    child.stderr?.setEncoding('utf-8');
    child.stderr?.on('data', (chunk: string) => { stderr = stderrTail(stderr, chunk, PEER_STDERR_BYTES); });
    const reader = createInterface({ input: child.stdout! });
    reader.on('line', (line) => {
      if (options.onLine(line)) failures = 0;
    });
    const code = await new Promise<number | null>((resolve) => {
      child.once('error', () => resolve(null));
      child.once('close', resolve);
    });
    reader.close();
    options.signal.removeEventListener('abort', stop);
    if (options.signal.aborted) return;
    failures += 1;
    const exit = code == null ? 'ssh failed' : `ssh exited ${code}`;
    const parked = failures >= parkAfter;
    const retireAfter = options.retireAfterFailures ?? PEER_RETIRE_AFTER_FAILURES;
    const retired = failures >= retireAfter;
    const delay = peerBackoffDelayMs(failures, options.backoffBaseMs, options.backoffCapMs, retireAfter, options.retiredRecheckMs);
    options.onUnavailable(retired
      ? `${reasonFor(exit, stderr)} — retired after ${failures} failed connections, re-dialing in ${Math.round(delay / 60_000)}min or on a device refresh`
      : parked
        ? `${reasonFor(exit, stderr)} — parked after ${failures} failed connections, retrying in ${Math.round(delay / 1000)}s or on a device refresh`
        : reasonFor(exit, stderr));
    await parkedWait(options, delay);
  }
}
