/**
 * Fleet distribution of identity-keyed Claude usage over SSH (PHNX-4116).
 *
 * A headed device can read authoritative usage; a worker's setup-token cannot
 * (credential-management.md invariant 5: a worker never polls
 * `/api/oauth/usage`). So the headed daemon's `usage-sync` tick dials every
 * dialable peer in parallel with `agents __usage-ingest --reply`, sending this
 * box's own daemon-state envelope on stdin; the peer merges the usage rows into
 * its cache newest-wins and prints its own envelope back, which the headed box
 * stores in `~/.agents/devices/<peer>/daemon-state.json` stamped `receivedAt`.
 * Workers never initiate. A peer that times out is skipped this tick and never
 * blocks another. Only usage rows, verdicts, and session digests move here —
 * never a credential (invariant 7: roles never cross).
 *
 * This replaced a git exchange over the fleet-synced user repo: every daemon
 * committed its own file each tick, so the shared store reached 1.1 GiB /
 * 18,358 commits with 100% of the last 2,000 being `chore(devices): publish
 * <device> daemon state`, and a worker's clone fell 10k commits behind with
 * `git fetch timed out` on every tick — a valid setup-token could not be
 * scheduled because a repo was bloated. Git now carries human-authored
 * resources only; `devices/<device>/daemon-state.json` is untracked.
 */
import { isHeadedDeviceRole, selfConfiguredDeviceRole, type ConfiguredDeviceRole } from '../device-config.js';
import {
  FLEET_SHARED_STATE_VERSION,
  parseFleetSharedDeviceStateEnvelope,
  readFleetSharedDeviceStates,
  readOwnFleetSharedDeviceState,
  storePeerFleetSharedDeviceState,
  updateFleetSharedDeviceStateAsync,
  type FleetSharedDeviceState,
} from '../fleet-shared-state.js';
import { getUserAgentsDir } from '../state.js';
import { machineId, normalizeHost } from '../session/sync/config.js';
import type { DeviceProfile } from '../devices/registry.js';
import { resolveDeviceProfile } from '../devices/resolve-profile.js';
import type { SshExecResult } from '../ssh-exec.js';
import {
  exportClaudeUsageCacheRows,
  ingestPeerClaudeUsageRows,
  type CachedUsageSnapshot,
} from './usage.js';

/** Cadence of the usage-sync tick — the trust window for a `sync` snapshot. */
export const USAGE_SYNC_INTERVAL_MS = 15 * 60_000;
/** Re-publish an unchanged windowed row at least this often so workers' 15-min trust does not lapse. */
export const USAGE_PUBLISH_HEARTBEAT_MS = 10 * 60_000;
/** Per-peer SSH budget for one exchange; a peer past it is skipped this tick. */
export const USAGE_EXCHANGE_PEER_TIMEOUT_MS = 20_000;
/** Marks the start of the JSON reply on the peer's stdout, so login-shell noise before it is ignored. */
export const FLEET_STATE_REPLY_MARKER = '@@AGENTS_FLEET_STATE@@';

function usageMeterSignature(row: CachedUsageSnapshot): string {
  return JSON.stringify({
    windows: row.windows,
    plan: row.plan ?? null,
    unavailable: row.unavailable ?? null,
    freshnessSource: row.freshnessSource ?? null,
    pollerDevice: row.pollerDevice ?? null,
  });
}

/**
 * Keep the previously published `capturedAt` when meters have not moved and
 * the last publish is still inside the heartbeat. Stops statusline re-renders
 * from rewriting the own-state file every few seconds.
 */
export function mergeUsageRowsForPublish(
  previous: Record<string, CachedUsageSnapshot> | undefined,
  next: Record<string, CachedUsageSnapshot>,
  nowMs: number = Date.now(),
): Record<string, CachedUsageSnapshot> {
  if (!previous) return next;
  const out: Record<string, CachedUsageSnapshot> = {};
  for (const [key, row] of Object.entries(next)) {
    const prior = previous[key];
    if (prior && usageMeterSignature(prior) === usageMeterSignature(row)) {
      const priorMs = prior.capturedAt ? Date.parse(prior.capturedAt) : NaN;
      if (Number.isFinite(priorMs) && nowMs - priorMs < USAGE_PUBLISH_HEARTBEAT_MS) {
        out[key] = { ...row, capturedAt: prior.capturedAt };
        continue;
      }
    }
    out[key] = row;
  }
  return out;
}

/** Legacy `__usage-ingest` envelope (v1): bare rows from an older headed peer. */
export interface UsageSyncPayload {
  v: 1;
  rows: Record<string, CachedUsageSnapshot>;
}

/**
 * The exchange envelope (v2), identical in both directions: a device's own
 * daemon-state envelope. `errors` carries the replying peer's non-fatal
 * publisher failures so the headed box can log them against that peer.
 */
export interface FleetStateExchangePayload {
  v: 2;
  state: FleetSharedDeviceState;
  errors?: string[];
}

interface PublishUsageSnapshotOptions {
  userAgentsDir?: string;
  cachePath?: string;
  role?: ConfiguredDeviceRole;
  device?: string;
}

interface PublishUsageSnapshotResult {
  published: boolean;
  changed: boolean;
  skipped: string | null;
  error: string | null;
  path: string | null;
}

/** Publish this headed device's stable usage snapshot into its own state file. */
export async function publishUsageSnapshotToSharedStore(
  options: PublishUsageSnapshotOptions = {},
): Promise<PublishUsageSnapshotResult> {
  const result: PublishUsageSnapshotResult = {
    published: false,
    changed: false,
    skipped: null,
    error: null,
    path: null,
  };
  const role = options.role ?? selfConfiguredDeviceRole();
  if (!isHeadedDeviceRole(role)) {
    result.skipped = 'this device is not a usage publisher (mark it personal or desktop)';
    return result;
  }
  const rawRows = exportClaudeUsageCacheRows(options.cachePath);
  if (Object.keys(rawRows).length === 0) {
    result.skipped = 'no local usage snapshot to publish';
    return result;
  }
  try {
    const device = options.device ?? machineId();
    const userAgentsDir = options.userAgentsDir ?? getUserAgentsDir();
    const prior = readFleetSharedDeviceStates(userAgentsDir).states
      .find((state) => normalizeHost(state.device) === normalizeHost(device))
      ?.usage?.rows;
    const rows = mergeUsageRowsForPublish(prior, rawRows);
    const write = await updateFleetSharedDeviceStateAsync(
      device,
      { usage: { rows } },
      userAgentsDir,
    );
    result.published = true;
    result.changed = write.changed;
    result.path = write.path;
  } catch (err) {
    result.error = (err as Error).message;
  }
  return result;
}

export interface PublishOwnFleetStateResult {
  usage: PublishUsageSnapshotResult;
  mirror: { changed: boolean; count: number; error: string | null };
  auth: { status: string; error: string | null };
  /** Every publisher failure, as `<field>: <message>` — logged by the caller, never fatal. */
  errors: string[];
}

/**
 * Refresh every field this device owns in its own state file: the usage
 * snapshot (headed only), the session digests, and the reserved-auth readiness
 * verdict. Run before the envelope is sent (the headed tick) or printed back
 * (`__usage-ingest --reply`) so a peer always receives current fields. Each
 * publisher is independent: one failing is reported in `errors` and the others
 * still land. All three writers are the async, non-blocking variants
 * (`updateFleetSharedDeviceStateAsync` underneath).
 */
export async function publishOwnFleetState(
  options: PublishUsageSnapshotOptions = {},
): Promise<PublishOwnFleetStateResult> {
  const errors: string[] = [];
  const usage = await publishUsageSnapshotToSharedStore(options);
  if (usage.error) errors.push(`usage: ${usage.error}`);
  let mirror: PublishOwnFleetStateResult['mirror'] = { changed: false, count: 0, error: null };
  try {
    const { publishSessionMirrorToSharedStore } = await import('../session/mirror.js');
    const published = await publishSessionMirrorToSharedStore({ userAgentsDir: options.userAgentsDir, device: options.device });
    mirror = { changed: published.changed, count: published.count, error: published.error };
  } catch (err) {
    mirror = { changed: false, count: 0, error: (err as Error).message };
  }
  if (mirror.error) errors.push(`sessions: ${mirror.error}`);
  let auth: PublishOwnFleetStateResult['auth'] = { status: 'unknown', error: null };
  try {
    const { publishReservedAuthVerdict } = await import('../secrets-policy.js');
    const verdict = await publishReservedAuthVerdict({ userAgentsDir: options.userAgentsDir, localName: options.device });
    auth = { status: verdict.status, error: verdict.error };
  } catch (err) {
    auth = { status: 'unknown', error: (err as Error).message };
  }
  if (auth.error) errors.push(`auth: ${auth.error}`);
  return { usage, mirror, auth, errors };
}

interface BuildPayloadOptions {
  device?: string;
  userAgentsDir?: string;
  cachePath?: string;
  role?: ConfiguredDeviceRole;
  /**
   * Send only the usage rows (read live from the cache, headed only) — the
   * placement probe's shape: the dispatcher hands the chosen worker current
   * numbers without the sessions/auth fields the tick carries.
   */
  usageOnly?: boolean;
  errors?: string[];
}

/** This device's exchange envelope, from its own state file (or usage-only from the cache). */
export function buildFleetStatePayload(options: BuildPayloadOptions = {}): FleetStateExchangePayload {
  const device = options.device ?? machineId();
  if (options.usageOnly) {
    const state: FleetSharedDeviceState = { version: FLEET_SHARED_STATE_VERSION, device };
    if (isHeadedDeviceRole(options.role ?? selfConfiguredDeviceRole())) {
      const rows = exportClaudeUsageCacheRows(options.cachePath);
      if (Object.keys(rows).length > 0) state.usage = { rows };
    }
    return { v: 2, state };
  }
  const state = readOwnFleetSharedDeviceState(device, options.userAgentsDir);
  return { v: 2, state, ...(options.errors?.length ? { errors: options.errors } : {}) };
}

/** Serialize the reply as the peer prints it: marker line, then one JSON line. */
export function formatFleetStateReply(payload: FleetStateExchangePayload): string {
  return `${FLEET_STATE_REPLY_MARKER}\n${JSON.stringify(payload)}\n`;
}

/**
 * Parse what a peer sent — a v2 exchange envelope, or the legacy v1 bare-rows
 * envelope from an older headed peer. Throws a clear message on anything else;
 * the caller decides whether that is exit code 2 (the receiver) or a per-peer
 * error (the headed tick).
 */
export function parseFleetStateExchangeInput(raw: string): FleetStateExchangePayload | UsageSyncPayload {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('malformed JSON payload');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('unrecognized usage-sync payload shape');
  }
  const record = parsed as Record<string, unknown>;
  if (record.v === 2) {
    const state = parseFleetSharedDeviceStateEnvelope(record.state);
    const errors = Array.isArray(record.errors) ? record.errors.filter((e): e is string => typeof e === 'string') : undefined;
    return { v: 2, state, ...(errors?.length ? { errors } : {}) };
  }
  if (record.v === 1) {
    const rows = record.rows;
    // `typeof [] === 'object'` — an array is NOT a rows map.
    if (typeof rows !== 'object' || rows === null || Array.isArray(rows)) {
      throw new Error('unrecognized usage-sync payload shape');
    }
    return { v: 1, rows: rows as Record<string, CachedUsageSnapshot> };
  }
  throw new Error('unrecognized usage-sync payload shape');
}

/** Extract the reply envelope from a peer's stdout (text before the marker is login-shell noise). */
export function parseFleetStateReply(stdout: string): FleetStateExchangePayload {
  const idx = stdout.lastIndexOf(FLEET_STATE_REPLY_MARKER);
  if (idx === -1) {
    throw new Error(stdout.trim()
      ? 'no reply envelope on stdout (peer agents-cli predates `__usage-ingest --reply`?)'
      : 'empty reply (peer agents-cli predates `__usage-ingest --reply`?)');
  }
  const body = stdout.slice(idx + FLEET_STATE_REPLY_MARKER.length).trim();
  const payload = parseFleetStateExchangeInput(body);
  if (payload.v !== 2) throw new Error('reply is not a v2 exchange envelope');
  return payload;
}

/**
 * Rows as the receiver stores them: provenance `sync` (so the trust window is
 * `USAGE_SYNC_TRUST_MS`, not the local-capture bar) and the poller pinned to the
 * device that actually read the endpoint, defaulting to the sender.
 */
function stampSyncRows(rows: Record<string, CachedUsageSnapshot>, sender: string): Record<string, CachedUsageSnapshot> {
  const out: Record<string, CachedUsageSnapshot> = {};
  for (const [identity, incoming] of Object.entries(rows)) {
    if (!incoming || !Array.isArray(incoming.windows) || incoming.windows.length === 0) continue;
    out[identity] = { ...incoming, freshnessSource: 'sync', pollerDevice: incoming.pollerDevice ?? sender };
  }
  return out;
}

interface ApplyPeerStateOptions {
  userAgentsDir?: string;
  cachePath?: string;
  device?: string;
  receivedAt?: number;
}

export interface ApplyPeerStateResult {
  path: string;
  /** Usage rows merged into the local cache (newest-wins per identity). */
  merged: number;
  receivedAt: number;
}

/**
 * Take a peer's envelope in: store it as that peer's file (stamped `receivedAt`)
 * and merge its usage rows into this box's cache newest-wins. The same step runs
 * on both ends — the worker on the pushed envelope, the headed box on the reply.
 * Both writes take their file lock asynchronously: this runs on the daemon tick
 * once per peer, and a `sleepSync` lock there freezes every other service.
 */
export async function applyPeerFleetState(
  state: FleetSharedDeviceState,
  options: ApplyPeerStateOptions = {},
): Promise<ApplyPeerStateResult> {
  const self = normalizeHost(options.device ?? machineId());
  if (normalizeHost(state.device) === self) {
    throw new Error(`peer envelope names this device (${state.device}); refusing to overwrite the own state file`);
  }
  const receivedAt = options.receivedAt ?? Date.now();
  const write = await storePeerFleetSharedDeviceState(state, options.userAgentsDir ?? getUserAgentsDir(), receivedAt);
  const merged = state.usage
    ? await ingestPeerClaudeUsageRows(stampSyncRows(state.usage.rows, state.device), options.cachePath)
    : 0;
  return { path: write.path, merged, receivedAt };
}

/** The remote command one exchange runs on a peer, in the peer's shell dialect. */
export async function buildFleetStateExchangeCommand(os?: string): Promise<string> {
  const { buildRemoteAgentsInvocation, buildWindowsStdinAgentsCommand, remoteShellFor } = await import('../hosts/remote-cmd.js');
  // The Windows `agents.ps1` shim does not forward ssh-piped stdin, so the
  // payload goes through a temp file and `--from <path>` there.
  return remoteShellFor(os) === 'powershell'
    ? buildWindowsStdinAgentsCommand(['__usage-ingest', '--reply'])
    : buildRemoteAgentsInvocation(['__usage-ingest', '--reply'], undefined, os);
}

/** The SSH boundary: run `remoteCmd` on `peer` with `input` on stdin. Injected by tests. */
export type FleetStateDial = (peer: DeviceProfile, remoteCmd: string, input: string) => Promise<SshExecResult>;

async function sshDial(timeoutMs: number): Promise<FleetStateDial> {
  const { sshExecAsync } = await import('../ssh-exec.js');
  const { sshTargetFor, deviceIdentityArgs } = await import('../devices/connect.js');
  return (peer, remoteCmd, input) => sshExecAsync(sshTargetFor(peer), remoteCmd, {
    input,
    timeoutMs,
    extraSshArgs: deviceIdentityArgs(peer),
  });
}

async function defaultPeers(self: string): Promise<DeviceProfile[]> {
  const { isDialableDevice, loadDevicesSync } = await import('../devices/registry.js');
  return Object.values(loadDevicesSync())
    .filter((d) => normalizeHost(d.name) !== self && isDialableDevice(d))
    .sort((a, b) => a.name.localeCompare(b.name));
}

interface ExchangeOptions {
  peers?: DeviceProfile[];
  dial?: FleetStateDial;
  payload?: FleetStateExchangePayload;
  device?: string;
  userAgentsDir?: string;
  cachePath?: string;
  timeoutMs?: number;
}

export interface PeerExchangeOutcome {
  device: string;
  delivered: boolean;
  /** Set when the peer's reply was stored — PR 5's per-peer freshness input. */
  receivedAt: number | null;
  merged: number;
  /** Why this peer got nothing this tick (timeout, old CLI, mismatched name, …). */
  error: string | null;
  /** The peer's own publisher failures, verbatim from its reply. */
  peerErrors: string[];
}

export interface ExchangeResult {
  skipped: string | null;
  outcomes: PeerExchangeOutcome[];
}

/**
 * The headed publisher's fan-out: dial every peer in parallel, each under its
 * own timeout, and apply each reply as it arrives. Never throws for a peer — a
 * timeout, an old CLI with no `--reply`, or a reply naming the wrong device is
 * that peer's `error` and the others are unaffected. A non-headed device skips:
 * workers never initiate (they only answer), so a worker's tick is a no-op here.
 */
export async function exchangeFleetStateWithPeers(options: ExchangeOptions = {}): Promise<ExchangeResult> {
  const device = options.device ?? machineId();
  const self = normalizeHost(device);
  const peers = options.peers ?? await defaultPeers(self);
  if (peers.length === 0) return { skipped: 'no dialable peer in the device registry', outcomes: [] };
  const timeoutMs = options.timeoutMs ?? USAGE_EXCHANGE_PEER_TIMEOUT_MS;
  const dial = options.dial ?? await sshDial(timeoutMs);
  const payload = options.payload ?? buildFleetStatePayload({ device, userAgentsDir: options.userAgentsDir });
  const input = JSON.stringify(payload);
  const outcomes = await Promise.all(peers.map(async (peer): Promise<PeerExchangeOutcome> => {
    const outcome: PeerExchangeOutcome = { device: peer.name, delivered: false, receivedAt: null, merged: 0, error: null, peerErrors: [] };
    try {
      // Resolve the operator config (`platform`) before picking the shell family,
      // matching the profile sshTargetFor/deviceIdentityArgs dial with.
      const remoteCmd = await buildFleetStateExchangeCommand(resolveDeviceProfile(peer).shell === 'powershell' ? 'windows' : undefined);
      const res = await dial(peer, remoteCmd, input);
      if (res.timedOut) throw new Error(`timed out after ${Math.round(timeoutMs / 1000)}s`);
      if (res.code !== 0) {
        const detail = res.stderr.trim().split('\n').pop() ?? '';
        throw new Error(`exited ${res.code ?? 'without a status'}${detail ? `: ${detail}` : ''}`);
      }
      const reply = parseFleetStateReply(res.stdout);
      if (normalizeHost(reply.state.device) !== normalizeHost(peer.name)) {
        throw new Error(`reply names device '${reply.state.device}', expected '${peer.name}'`);
      }
      const applied = await applyPeerFleetState(reply.state, {
        device,
        userAgentsDir: options.userAgentsDir,
        cachePath: options.cachePath,
      });
      outcome.delivered = true;
      outcome.receivedAt = applied.receivedAt;
      outcome.merged = applied.merged;
      outcome.peerErrors = reply.errors ?? [];
    } catch (err) {
      outcome.error = (err as Error).message;
    }
    return outcome;
  }));
  return { skipped: null, outcomes };
}
