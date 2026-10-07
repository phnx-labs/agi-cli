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

export interface SessionMirrorRow {
  id: string;
  shortId: string;
  agent: string;
  version?: string;
  machine: string;
  cwd?: string;
  topic?: string;
  label?: string;
  title?: string;
  firstUser?: string;
  lastActivity?: string;
  timestamp: string;
  ticketId?: string;
  prUrl?: string;
  goal?: string;
  checkpoints?: import('@phnx-labs/sessions-cli/reader').SessionCheckpoint[];
  summaryChecklist?: import('@phnx-labs/sessions-cli/reader').SessionChecklistItem[];
  summaryState?: import('@phnx-labs/sessions-cli/reader').SummaryState;
  request?: import('@phnx-labs/sessions-cli/reader').SessionRequest;
  timeline?: import('@phnx-labs/sessions-cli/reader').SessionTimeline;
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
  accounts?: {
    rows: unknown[];
  };
  ownerNotify?: {
    signedIn: boolean;
    deviceToken: boolean;
  };
  receivedAt?: number;
}

interface FleetSharedStatePatch {
  usage?: FleetSharedDeviceState['usage'];
  auth?: FleetSharedDeviceState['auth'];
  sessions?: FleetSharedDeviceState['sessions'];
  accounts?: FleetSharedDeviceState['accounts'];
  ownerNotify?: FleetSharedDeviceState['ownerNotify'];
  receivedAt?: number;
}

interface FleetSharedStateReadResult {
  states: FleetSharedDeviceState[];
  errors: Array<{ device: string; message: string }>;
}

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
  const ownerNotify = parsed.ownerNotify;
  if (
    ownerNotify !== undefined &&
    (!isRecord(ownerNotify) || typeof ownerNotify.signedIn !== 'boolean' || typeof ownerNotify.deviceToken !== 'boolean')
  ) {
    throw new Error('unrecognized owner-notify state');
  }
  if (parsed.receivedAt !== undefined && (typeof parsed.receivedAt !== 'number' || !Number.isFinite(parsed.receivedAt))) {
    throw new Error('unrecognized receivedAt');
  }
  return parsed as unknown as FleetSharedDeviceState;
}

function parseFleetSharedDeviceState(raw: string, owner: string): FleetSharedDeviceState {
  return parseFleetSharedDeviceStateEnvelope(JSON.parse(raw) as unknown, owner);
}

function mergeFleetState(currentRaw: string, device: string, patch: FleetSharedStatePatch): { serialized: string; changed: boolean } {
  let current: FleetSharedDeviceState = { version: FLEET_SHARED_STATE_VERSION, device };
  const trimmed = currentRaw.trim();
  if (trimmed) {
    try { current = parseFleetSharedDeviceState(trimmed, device); }
    catch {  }
  }
  // Patches merge fieldwise so a partial peer update cannot erase unrelated state.
  const next: FleetSharedDeviceState = {
    ...current,
    ...(patch.usage !== undefined ? { usage: patch.usage } : {}),
    ...(patch.auth !== undefined ? { auth: patch.auth } : {}),
    ...(patch.sessions !== undefined ? { sessions: patch.sessions } : {}),
    ...(patch.accounts !== undefined ? { accounts: patch.accounts } : {}),
    ...(patch.ownerNotify !== undefined ? { ownerNotify: patch.ownerNotify } : {}),
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
    try { raw = fs.readFileSync(file, 'utf-8'); } catch {  }
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
    try { raw = await fsp.readFile(file, 'utf-8'); } catch {  }
    const { serialized, changed } = mergeFleetState(raw, device, patch);
    if (!changed) return { changed: false, path: file };
    atomicWriteFileSync(file, serialized, 'utf-8');
    return { changed: true, path: file };
  });
}

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

export function readOwnFleetSharedDeviceState(
  device: string,
  userAgentsDir = getUserAgentsDir(),
): FleetSharedDeviceState {
  const file = fleetSharedStatePath(device, userAgentsDir);
  let raw = '';
  try { raw = fs.readFileSync(file, 'utf-8'); } catch {  }
  if (!raw.trim()) return { version: FLEET_SHARED_STATE_VERSION, device };
  const state = parseFleetSharedDeviceState(raw, device);
  const { receivedAt: _receivedAt, ...own } = state;
  return own;
}

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
  if (state.ownerNotify !== undefined) patch.ownerNotify = state.ownerNotify;
  return updateFleetSharedDeviceStateAsync(state.device, patch, userAgentsDir);
}
