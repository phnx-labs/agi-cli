/**
 * Non-secret daemon state exchanged over SSH between fleet devices (PHNX-4116).
 *
 * Each device owns exactly one file under `~/.agents/devices/<device>/`
 * (`daemon-state.json`, UNTRACKED in the user repo). A device writes its OWN
 * file locally; a PEER's file on this box is written only by the usage-sync
 * exchange — a headed daemon dials each peer with `agents __usage-ingest
 * --reply`, sending its own envelope on stdin and writing the peer's reply
 * envelope here stamped with `receivedAt`. The envelope used to ride the user
 * repo as a tracked file, which turned the shared store into 18k `chore(devices)`
 * commits and wedged every clone behind a `git fetch` that timed out; git now
 * carries only human-authored resources. OAuth/setup-token values never belong
 * here: auth publishes only a readiness verdict; the existing encrypted SSH
 * bundle push remains the one path that may carry secret material.
 */
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';

import { assertValidDeviceName } from './devices/registry.js';
import { atomicWriteFileSync, ensureLockTarget, withFileLock, withFileLockAsync } from './fs-atomic.js';
import { getUserAgentsDir } from './state.js';
import type { CachedUsageSnapshot } from './accounting/usage.js';

export const FLEET_SHARED_STATE_VERSION = 1;
export const FLEET_SHARED_STATE_FILE = 'daemon-state.json';

export type SharedAuthStatus = 'ready' | 'missing' | 'invalid';

/**
 * One session's lightweight preview/metadata, mirrored to the fleet so the
 * interactive device renders a remote-host row's topic/preview INLINE instead of
 * fetching the peer's digest live over SSH per row (PHNX-3792). Deliberately
 * NOT a full transcript: only the fields a list row and a compact preview card
 * need. `machine` is the EXECUTION host the publisher recorded (so an offloaded
 * session's mirror row matches the same `machine:id` key the live fan-out uses,
 * never double-counting), `firstUser` is a bounded first-user-message snippet,
 * and `capturedAt` stamps publish time for the staleness marker.
 */
export interface SessionMirrorRow {
  id: string;
  shortId: string;
  agent: string;
  version?: string;
  machine: string;
  cwd?: string;
  topic?: string;
  label?: string;
  /** The publisher's daemon-generated headline (PHNX-3797), when it has produced one. */
  title?: string;
  firstUser?: string;
  lastActivity?: string;
  timestamp: string;
  ticketId?: string;
  prUrl?: string;
  /** Daemon-computed goal (PHNX-3939) — carried so a peer renders it with no transcript. */
  goal?: string;
  /** Daemon-computed progress checkpoints, newest last (PHNX-3939). */
  checkpoints?: import('./session/types.js').SessionCheckpoint[];
  /** Daemon-computed detailed checklist (PHNX-3939). */
  summaryChecklist?: import('./session/types.js').SessionChecklistItem[];
  /** Lifecycle of the daemon-computed summary (PHNX-3939). */
  summaryState?: import('./session/types.js').SummaryState;
  /** Tidied latest user turn, so a peer row shows what the agent was asked (PHNX-3939). */
  request?: import('./session/types.js').SessionRequest;
  /** Bounded narration-anchored steps, so a peer row shows what the agent did. */
  timeline?: import('./session/types.js').SessionTimeline;
  /** Bounded file-change list for the peer row. */
  files?: import('./session/types.js').SessionFiles;
  capturedAt: number;
}

export interface FleetSharedDeviceState {
  version: typeof FLEET_SHARED_STATE_VERSION;
  device: string;
  usage?: {
    rows: Record<string, CachedUsageSnapshot>;
  };
  auth?: {
    status: SharedAuthStatus;
  };
  sessions?: {
    rows: SessionMirrorRow[];
  };
  /**
   * Per-account auth verdict rows, written by the account-state daemon service
   * (`account-state-daemon-service.ts`) and read by `readSharedAccountVerdicts`.
   * Opaque here: the envelope carries them across the exchange unchanged.
   */
  accounts?: {
    rows: unknown[];
  };
  /**
   * Epoch ms this box received the envelope from its owner over the SSH
   * exchange. Present ONLY in a peer's file on this box, never in a device's own
   * file. auth-sync reads it per peer to know that peer has replied at all.
   */
  receivedAt?: number;
}

interface FleetSharedStatePatch {
  usage?: FleetSharedDeviceState['usage'];
  auth?: FleetSharedDeviceState['auth'];
  sessions?: FleetSharedDeviceState['sessions'];
  accounts?: FleetSharedDeviceState['accounts'];
  receivedAt?: number;
}

interface FleetSharedStateReadResult {
  states: FleetSharedDeviceState[];
  errors: Array<{ device: string; message: string }>;
}

/** Path owned by one device in the conflict-free tracked device-doc tree. */
export function fleetSharedStatePath(
  device: string,
  userAgentsDir = getUserAgentsDir(),
): string {
  assertValidDeviceName(device);
  return path.join(userAgentsDir, 'devices', device, FLEET_SHARED_STATE_FILE);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Validate an already-parsed envelope. `owner` pins the `device` field when the
 * caller knows whose envelope this must be (a file under `devices/<owner>/`);
 * an envelope arriving over the exchange names its own owner, so the caller
 * passes none and checks `device` against the dialed peer afterwards.
 */
export function parseFleetSharedDeviceStateEnvelope(parsed: unknown, owner?: string): FleetSharedDeviceState {
  if (!isRecord(parsed) || parsed.version !== FLEET_SHARED_STATE_VERSION || typeof parsed.device !== 'string' || !parsed.device) {
    throw new Error('unrecognized shared-state envelope');
  }
  if (owner !== undefined && parsed.device !== owner) throw new Error('unrecognized shared-state envelope');
  assertValidDeviceName(parsed.device);
  const usage = parsed.usage;
  if (usage !== undefined && (!isRecord(usage) || !isRecord(usage.rows))) {
    throw new Error('unrecognized usage snapshot');
  }
  const auth = parsed.auth;
  if (
    auth !== undefined &&
    (!isRecord(auth) || !['ready', 'missing', 'invalid'].includes(String(auth.status)))
  ) {
    throw new Error('unrecognized auth verdict');
  }
  const sessions = parsed.sessions;
  if (sessions !== undefined && (!isRecord(sessions) || !Array.isArray(sessions.rows))) {
    throw new Error('unrecognized session mirror');
  }
  const accounts = parsed.accounts;
  if (accounts !== undefined && (!isRecord(accounts) || !Array.isArray(accounts.rows))) {
    throw new Error('unrecognized account verdict rows');
  }
  if (parsed.receivedAt !== undefined && (typeof parsed.receivedAt !== 'number' || !Number.isFinite(parsed.receivedAt))) {
    throw new Error('unrecognized receivedAt');
  }
  return parsed as unknown as FleetSharedDeviceState;
}

function parseFleetSharedDeviceState(raw: string, owner: string): FleetSharedDeviceState {
  return parseFleetSharedDeviceStateEnvelope(JSON.parse(raw) as unknown, owner);
}

/**
 * Merge one daemon-owned field into this device's shared file under a real
 * inter-process lock. Stable serialization avoids dirtying the user repo when
 * neither usage nor auth state changed.
 */
/** Merge `patch` onto the current on-disk state; returns the serialized next state, or null when unchanged. Shared by the sync and async writers. */
function mergeFleetState(currentRaw: string, device: string, patch: FleetSharedStatePatch): { serialized: string; changed: boolean } {
  let current: FleetSharedDeviceState = { version: FLEET_SHARED_STATE_VERSION, device };
  const trimmed = currentRaw.trim();
  if (trimmed) {
    try { current = parseFleetSharedDeviceState(trimmed, device); }
    catch { /* owning device repairs its own malformed file; peers are never repaired here */ }
  }
  const next: FleetSharedDeviceState = {
    ...current,
    ...(patch.usage !== undefined ? { usage: patch.usage } : {}),
    ...(patch.auth !== undefined ? { auth: patch.auth } : {}),
    ...(patch.sessions !== undefined ? { sessions: patch.sessions } : {}),
    ...(patch.accounts !== undefined ? { accounts: patch.accounts } : {}),
    ...(patch.receivedAt !== undefined ? { receivedAt: patch.receivedAt } : {}),
    version: FLEET_SHARED_STATE_VERSION,
    device,
  };
  const serialized = `${JSON.stringify(next, null, 2)}\n`;
  return { serialized, changed: currentRaw !== serialized };
}

export function updateFleetSharedDeviceState(
  device: string,
  patch: FleetSharedStatePatch,
  userAgentsDir = getUserAgentsDir(),
): { changed: boolean; path: string } {
  const file = fleetSharedStatePath(device, userAgentsDir);
  ensureLockTarget(file, '');
  return withFileLock(file, () => {
    let raw = '';
    try { raw = fs.readFileSync(file, 'utf-8'); } catch { /* missing → treat as empty */ }
    const { serialized, changed } = mergeFleetState(raw, device, patch);
    if (!changed) return { changed: false, path: file };
    atomicWriteFileSync(file, serialized, 'utf-8');
    return { changed: true, path: file };
  });
}

/**
 * Async, non-blocking twin of {@link updateFleetSharedDeviceState} for the
 * daemon's usage-sync / auth-sync ticks (PHNX-3695). The sync version acquires
 * the file lock with `sleepSync` (`Atomics.wait`), freezing the shared event
 * loop for up to 30s under contention on EVERY tick; this uses
 * `withFileLockAsync`. The under-lock read is async; the atomic write is a tiny
 * bounded write held inside the lock.
 */
export async function updateFleetSharedDeviceStateAsync(
  device: string,
  patch: FleetSharedStatePatch,
  userAgentsDir = getUserAgentsDir(),
): Promise<{ changed: boolean; path: string }> {
  const file = fleetSharedStatePath(device, userAgentsDir);
  ensureLockTarget(file, '');
  return withFileLockAsync(file, async () => {
    let raw = '';
    try { raw = await fsp.readFile(file, 'utf-8'); } catch { /* missing → treat as empty */ }
    const { serialized, changed } = mergeFleetState(raw, device, patch);
    if (!changed) return { changed: false, path: file };
    atomicWriteFileSync(file, serialized, 'utf-8');
    return { changed: true, path: file };
  });
}

/** Read every valid peer-owned state file; malformed peers fail separately. */
export function readFleetSharedDeviceStates(
  userAgentsDir = getUserAgentsDir(),
): FleetSharedStateReadResult {
  const devicesDir = path.join(userAgentsDir, 'devices');
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(devicesDir, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { states: [], errors: [] };
    return { states: [], errors: [{ device: '*', message: (err as Error).message }] };
  }
  const states: FleetSharedDeviceState[] = [];
  const errors: Array<{ device: string; message: string }> = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory()) continue;
    const file = path.join(devicesDir, entry.name, FLEET_SHARED_STATE_FILE);
    if (!fs.existsSync(file)) continue;
    try {
      states.push(parseFleetSharedDeviceState(fs.readFileSync(file, 'utf-8'), entry.name));
    } catch (err) {
      errors.push({ device: entry.name, message: (err as Error).message });
    }
  }
  return { states, errors };
}

/**
 * This device's own envelope as it stands on disk — what the usage-sync exchange
 * sends to peers and what `__usage-ingest --reply` prints back. A device that has
 * never published anything yields the bare `{version, device}` envelope, so a
 * peer still learns the device exists and answered.
 */
export function readOwnFleetSharedDeviceState(
  device: string,
  userAgentsDir = getUserAgentsDir(),
): FleetSharedDeviceState {
  const file = fleetSharedStatePath(device, userAgentsDir);
  let raw = '';
  try { raw = fs.readFileSync(file, 'utf-8'); } catch { /* never published → bare envelope */ }
  if (!raw.trim()) return { version: FLEET_SHARED_STATE_VERSION, device };
  const state = parseFleetSharedDeviceState(raw, device);
  // `receivedAt` is a receiver-side stamp; the owner never advertises one.
  const { receivedAt: _receivedAt, ...own } = state;
  return own;
}

/**
 * Store a PEER's envelope, received over the SSH exchange, in that peer's file on
 * this box, stamped with `receivedAt`. Merges field-by-field onto whatever the
 * file already holds, so a partial envelope (a placement probe sends usage only)
 * refreshes that field without erasing the peer's last auth verdict, session
 * digests, or account rows. The five readers of `devices/<peer>/daemon-state.json`
 * (usage merge, poller claims, auth verdicts, session mirror, account catalog)
 * are unchanged by the transport swap.
 */
export function storePeerFleetSharedDeviceState(
  state: FleetSharedDeviceState,
  userAgentsDir = getUserAgentsDir(),
  receivedAt: number = Date.now(),
): { changed: boolean; path: string } {
  const patch: FleetSharedStatePatch = { receivedAt };
  if (state.usage !== undefined) patch.usage = state.usage;
  if (state.auth !== undefined) patch.auth = state.auth;
  if (state.sessions !== undefined) patch.sessions = state.sessions;
  if (state.accounts !== undefined) patch.accounts = state.accounts;
  return updateFleetSharedDeviceState(state.device, patch, userAgentsDir);
}
