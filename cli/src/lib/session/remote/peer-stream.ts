/**
 * One peer's `--local` watch subscription, with connection hygiene.
 *
 * Both fleet fan-outs (`watchFleetSessions`, `watchFleetFeed`) subscribe to
 * every dialable device with a long-lived `ssh <peer> agents … watch --json
 * --local`. Both used to respawn that child on a bare 2 s timer with the
 * child's stderr set to `'ignore'`, so an offline peer — and `isDialableDevice`
 * deliberately never excludes one — got a fresh ssh every ConnectTimeout + 2 s
 * for the whole life of the watcher, with the reason discarded. That is the
 * ssh-child churn the 2026-09-03 incident reported.
 *
 * This module is the single implementation both fan-outs call:
 *
 * - exponential backoff per peer, {@link PEER_BACKOFF_BASE_MS} doubling to
 *   {@link PEER_BACKOFF_CAP_MS}, reset the moment the peer delivers a healthy
 *   protocol event;
 * - the child's stderr captured (bounded to {@link PEER_STDERR_BYTES}) and
 *   surfaced as the `unavailable` reason instead of being thrown away;
 * - a peer that fails {@link PEER_PARK_AFTER_FAILURES} spawns in a row parked —
 *   it stops the reconnect cycle and re-dials only when the device registry
 *   changes or the capped backoff elapses;
 * - a peer that fails {@link PEER_RETIRE_AFTER_FAILURES} in a row RETIRED — the
 *   capped 60 s ladder is itself unbounded in total work, so past that point the
 *   re-dial drops to {@link PEER_RETIRED_RECHECK_MS};
 * - abort listeners removed per iteration, so a watcher open for hours does not
 *   accumulate one per reconnect on the caller's AbortSignal.
 */
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import { createInterface } from 'node:readline';
import { deviceIdentityArgs, sshTargetFor } from '../../devices/connect.js';
import type { DeviceProfile } from '../../devices/registry.js';
import { SSH_OPTS, controlOpts } from '../../ssh-exec.js';
import { getDevicesRegistryPath } from '../../state.js';

/** First reconnect delay after a failed subscription. */
export const PEER_BACKOFF_BASE_MS = 2_000;
/** Ceiling the doubling delay saturates at. */
export const PEER_BACKOFF_CAP_MS = 60_000;
/** Consecutive failed spawns before the peer is parked. */
export const PEER_PARK_AFTER_FAILURES = 3;
/**
 * Consecutive failed spawns before the peer is RETIRED — the capped 60 s ladder
 * gives way to {@link PEER_RETIRED_RECHECK_MS}.
 *
 * The cap alone bounds the delay but not the total work: a box that is off for a
 * weekend was dialed every 60 s for two days, ~2,880 ssh children per watcher
 * per peer, each one already known to fail. Ten consecutive failures is well
 * past any transient network event, so past that point the peer is treated as
 * genuinely absent and re-dialed on the slow cadence instead.
 */
export const PEER_RETIRE_AFTER_FAILURES = 10;
/**
 * Re-dial cadence for a retired peer. Still bounded rather than never, because a
 * box can come back without anything touching the device registry — waiting
 * only on a registry change would leave it unreachable until an operator acted.
 */
export const PEER_RETIRED_RECHECK_MS = 15 * 60_000;
/** Bytes of a peer's stderr retained for the `unavailable` reason. */
const PEER_STDERR_BYTES = 2_048;
/** How often a parked peer re-checks the device registry for a refresh. */
const PEER_REGISTRY_POLL_MS = 5_000;

/**
 * Reconnect delay for `failures` consecutive failed spawns: 0 for a healthy
 * peer, then {@link PEER_BACKOFF_BASE_MS} doubling to {@link PEER_BACKOFF_CAP_MS},
 * and {@link PEER_RETIRED_RECHECK_MS} once the peer is retired.
 */
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
  /** The device to subscribe to. */
  device: DeviceProfile;
  /** Remote command to run over ssh, already shell-quoted for the peer's OS. */
  command: string;
  signal: AbortSignal;
  /**
   * One line of the peer's stdout. Return `true` when the line was a valid
   * protocol event — that is the health signal that resets the backoff.
   */
  onLine: (line: string) => boolean;
  /** Report the peer as unavailable, with the captured reason. */
  onUnavailable: (reason: string) => void;
  /** Override the first backoff delay (tests). */
  backoffBaseMs?: number;
  /** Override the backoff ceiling (tests). */
  backoffCapMs?: number;
  /** Override the park threshold (tests). */
  parkAfterFailures?: number;
  /** Override the retire threshold (tests). */
  retireAfterFailures?: number;
  /** Override the retired re-dial cadence (tests). */
  retiredRecheckMs?: number;
  /** Override the ssh binary (tests). */
  sshBin?: string;
  /** Override the parked peer's registry re-check cadence (tests). */
  registryPollMs?: number;
  /** Override the registry file a parked peer waits on (tests). */
  registryPath?: string;
}

/** Bounded tail of a child's stderr, kept for the unavailable reason. */
function stderrTail(chunks: string, next: string, limit: number): string {
  const joined = chunks + next;
  return joined.length > limit ? joined.slice(joined.length - limit) : joined;
}

/** Collapse captured stderr to one quotable line. */
function reasonFor(exit: string, stderr: string): string {
  const detail = stderr.split('\n').map((line) => line.trim()).filter(Boolean).pop();
  return detail ? `${exit}: ${detail}` : exit;
}

/** Await a delay, a device-registry change, or abort — whichever comes first. */
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

/**
 * Hold one peer subscription open for the life of the signal, reconnecting with
 * backoff. Resolves when the signal aborts or the peer cannot be addressed.
 */
export async function streamFromPeer(options: PeerStreamOptions): Promise<void> {
  const parkAfter = options.parkAfterFailures ?? PEER_PARK_AFTER_FAILURES;
  let failures = 0;
  while (!options.signal.aborted) {
    let target: string;
    try { target = sshTargetFor(options.device); } catch (error) {
      // No address at all is not a transient failure: retrying cannot fix it.
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
      // A peer that is delivering protocol is healthy, so the next disconnect
      // starts the backoff over rather than inheriting an old failure streak.
      if (options.onLine(line)) failures = 0;
    });
    const code = await new Promise<number | null>((resolve) => {
      child.once('error', () => resolve(null));
      child.once('close', resolve);
    });
    reader.close();
    // Removed per iteration: a watcher open for hours would otherwise leak one
    // listener per reconnect onto the caller's signal.
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
