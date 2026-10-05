/** Per-subsystem health record for the daemon (RUSH-2354): a persisted {@link SubsystemHealth} so
 * `agents daemon status` / `services` report health, not just liveness. Covers browser IPC and
 * daemon startup (RUSH-2418). File-backed because `status` runs in another process. */
import * as fs from 'fs';
import * as path from 'path';
import { getDaemonDir } from './state.js';
import { atomicWriteFileSync, ensureLockTarget, withFileLock } from './fs-atomic.js';

const HEALTH_FILE = 'health.json';

/** Daemon startup itself (RUSH-2418), written from both sides: the launching CLI records a start
 * with no live daemon, and the daemon records its own claim. Its `consecutiveFailures` opens the
 * auto-start circuit breaker in `ensureDaemonStarted`. */
export const SUBSYSTEM_DAEMON_START = 'daemon-start';

/** One subsystem's health as of the last time it reported in. */
export interface SubsystemHealth {
  /** Stable identifier, e.g. 'browser-ipc', 'monitors'. */
  subsystem: string;
  /** Most recent error message, or null if it has never failed. */
  lastError: string | null;
  /** ISO timestamp of the most recent error, or null. */
  lastErrorAt: string | null;
  /** Consecutive failures since the last success (0 when currently healthy). */
  consecutiveFailures: number;
  /** ISO timestamp of the most recent success, or null if it has never succeeded. */
  lastOkAt: string | null;
  /** `ServiceSupervisor` lifecycle state (`idle`/`running`/`stopped`), written on every transition
   * (RUSH-3193 P4). Absent for pre-supervisor subsystems like `daemon-start`, which tells `agents
   * daemon services` a measured state from an inferred one. */
  state?: string;
}

function getHealthPath(): string {
  return path.join(getDaemonDir(), HEALTH_FILE);
}

function readAll(): Record<string, SubsystemHealth> {
  try {
    const raw = fs.readFileSync(getHealthPath(), 'utf-8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, SubsystemHealth>;
    }
    return {};
  } catch {
    return {};
  }
}

/** Never throws. recordSubsystemOk/Error run inside a service's error boundary, so a write failure
 * (disk full, permission, state dir removed mid-run) must degrade to a dropped update rather than
 * an unhandled rejection that takes down every other service. */
function updateAll(update: (records: Record<string, SubsystemHealth>) => void): void {
  try {
    const healthPath = getHealthPath();
    ensureLockTarget(healthPath, '{}');
    withFileLock(healthPath, () => {
      const records = readAll();
      update(records);
      atomicWriteFileSync(healthPath, JSON.stringify(records), { encoding: 'utf-8', mode: 0o600 });
      try { fs.chmodSync(healthPath, 0o600); } catch { /* best effort */ }
    });
  } catch { /* see docblock above — health recording must never crash a caller */ }
}

function blankRecord(subsystem: string): SubsystemHealth {
  return { subsystem, lastError: null, lastErrorAt: null, consecutiveFailures: 0, lastOkAt: null };
}

/** Record a successful subsystem check-in — clears the failure streak. */
export function recordSubsystemOk(subsystem: string, at: string = new Date().toISOString()): void {
  updateAll((all) => {
    const existing = all[subsystem] ?? blankRecord(subsystem);
    all[subsystem] = { ...existing, subsystem, consecutiveFailures: 0, lastOkAt: at };
  });
}

/** Record a subsystem failure — bumps the consecutive-failure streak. */
export function recordSubsystemError(subsystem: string, error: string, at: string = new Date().toISOString()): void {
  updateAll((all) => {
    const existing = all[subsystem] ?? blankRecord(subsystem);
    all[subsystem] = {
      ...existing,
      subsystem,
      lastError: error,
      lastErrorAt: at,
      consecutiveFailures: existing.consecutiveFailures + 1,
    };
  });
}

/** Refine the reason on an already-counted failure without bumping the streak (RUSH-2418: a start
 * is counted before its outcome is known; a second recordSubsystemError would double-count). An
 * unreported subsystem is left alone. */
export function recordSubsystemErrorReason(subsystem: string, error: string, at: string = new Date().toISOString()): void {
  updateAll((all) => {
    const existing = all[subsystem];
    if (!existing) return;
    all[subsystem] = { ...existing, lastError: error, lastErrorAt: at };
  });
}

/** Record a `ServiceSupervisor` state transition without touching the ok/error streak;
 * cross-process readers (`agents daemon services`) have no other way to see `stopped`/`idle` vs
 * `running`. */
export function recordSubsystemState(subsystem: string, state: string): void {
  updateAll((all) => {
    const existing = all[subsystem] ?? blankRecord(subsystem);
    all[subsystem] = { ...existing, subsystem, state };
  });
}

// ─── Supervised-restart ledger (PHNX-4116) ────────────────────────────────────

const RESTARTS_FILE = 'restarts.json';
/** Bound so a crash loop cannot grow the ledger file without limit. */
const MAX_RESTART_RECORDS = 200;

/** One supervised restart: the service whose deadline breach forced the daemon to exit, and when. */
export interface DaemonRestartRecord {
  /** ISO timestamp of the breach that forced the restart. */
  at: string;
  /** The service id whose tick or lifecycle call breached its deadline. */
  subsystem: string;
  /** The deadline-breach message. */
  cause: string;
}

function getRestartsPath(): string {
  return path.join(getDaemonDir(), RESTARTS_FILE);
}

function readRestarts(): DaemonRestartRecord[] {
  try {
    const parsed = JSON.parse(fs.readFileSync(getRestartsPath(), 'utf-8'));
    return Array.isArray(parsed) ? (parsed as DaemonRestartRecord[]) : [];
  } catch {
    return [];
  }
}

/** Append a supervised-restart record and flush it SYNCHRONOUSLY: the caller
 * (`ServiceSupervisor.exitForRestart`) calls `process.exit` right after. Never throws; a dropped
 * entry must not block the restart exit. */
export function recordDaemonRestart(subsystem: string, cause: string, at: string = new Date().toISOString()): void {
  try {
    const restartsPath = getRestartsPath();
    ensureLockTarget(restartsPath, '[]');
    withFileLock(restartsPath, () => {
      const records = readRestarts();
      records.push({ at, subsystem, cause });
      atomicWriteFileSync(restartsPath, JSON.stringify(records.slice(-MAX_RESTART_RECORDS)), { encoding: 'utf-8', mode: 0o600 });
      try { fs.chmodSync(restartsPath, 0o600); } catch { /* best effort */ }
    });
  } catch { /* a dropped restart record must never block the exit-for-restart */ }
}

/** Every supervised restart recorded at or after `sinceMs`, oldest first. */
export function readRecentDaemonRestarts(sinceMs: number): DaemonRestartRecord[] {
  return readRestarts().filter((r) => {
    const t = Date.parse(r.at);
    return Number.isFinite(t) && t >= sinceMs;
  });
}

/** Read one subsystem's health record, or null if it has never reported in. */
export function readSubsystemHealth(subsystem: string): SubsystemHealth | null {
  return readAll()[subsystem] ?? null;
}

/** Read every subsystem's health record, sorted by subsystem name. */
export function readAllSubsystemHealth(): SubsystemHealth[] {
  return Object.values(readAll()).sort((a, b) => a.subsystem.localeCompare(b.subsystem));
}
