/** Non-secret daemon state exchanged over SSH between fleet devices (PHNX-4116): one untracked
 * `~/.agents/devices/<device>/daemon-state.json` per device; a peer's is written only by the
 * usage-sync exchange, stamped `receivedAt`. OAuth/setup-token values never belong here. */
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

/** One session's lightweight preview mirrored to the fleet so a remote-host row renders inline
 * instead of fetching the peer's digest over SSH per row (PHNX-3792). Not a transcript. */
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
  checkpoints?: import('@phnx-labs/sessions-cli/reader').SessionCheckpoint[];
  /** Daemon-computed detailed checklist (PHNX-3939). */
  summaryChecklist?: import('@phnx-labs/sessions-cli/reader').SessionChecklistItem[];
  /** Lifecycle of the daemon-computed summary (PHNX-3939). */
  summaryState?: import('@phnx-labs/sessions-cli/reader').SummaryState;
  /** Tidied latest user turn, so a peer row shows what the agent was asked (PHNX-3939). */
  request?: import('@phnx-labs/sessions-cli/reader').SessionRequest;
  /** Bounded narration-anchored steps, so a peer row shows what the agent did. */
  timeline?: import('@phnx-labs/sessions-cli/reader').SessionTimeline;
  /** Bounded file-change list for the peer row. */
  files?: import('@phnx-labs/sessions-cli/reader').SessionFiles;
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
  /** Per-account auth verdict rows, written by the account-state daemon service and read by
   * `readSharedAccountVerdicts`; opaque here and carried unchanged. */
  accounts?: {
    rows: unknown[];
  };
  /** Epoch ms this box received the envelope from its owner over SSH. Present only in a peer's
   * file, never a device's own; auth-sync reads it to know the peer replied. */
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

/** Validates an already-parsed envelope. `owner` pins `device` when the caller knows whose it
 * must be (a file under `devices/<owner>/`); an envelope over the exchange names its own owner,
 * so the caller checks `device` against the dialed peer afterwards. */
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

/** Merges one daemon-owned field into this device's shared file under a real inter-process lock;
 * stable serialization avoids dirtying the user repo. */
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

/** Async twin of updateFleetSharedDeviceState for the daemon's usage-sync/auth-sync ticks
 * (PHNX-3695): the sync version takes the lock via `sleepSync` (Atomics.wait), freezing the
 * event loop up to 30s under contention; this uses `withFileLockAsync`. */
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

/** This device's own envelope as on disk, sent to peers and printed by `__usage-ingest --reply`.
 * A device that never published yields the bare `{version, device}` envelope so a peer still
 * learns it exists and answered. */
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

/** Stores a peer's envelope in that peer's file, stamped with `receivedAt`, merging field by
 * field so a partial envelope (a placement probe sends usage only) does not erase the last auth
 * verdict, session digests or account rows. */
export async function storePeerFleetSharedDeviceState(
  state: FleetSharedDeviceState,
  userAgentsDir = getUserAgentsDir(),
  receivedAt: number = Date.now(),
): Promise<{ changed: boolean; path: string }> {
  const patch: FleetSharedStatePatch = { receivedAt };
  if (state.usage !== undefined) patch.usage = state.usage;
  if (state.auth !== undefined) patch.auth = state.auth;
  if (state.sessions !== undefined) patch.sessions = state.sessions;
  if (state.accounts !== undefined) patch.accounts = state.accounts;
  return updateFleetSharedDeviceStateAsync(state.device, patch, userAgentsDir);
}
