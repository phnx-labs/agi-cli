/**
 * Per-subsystem health record for the always-on daemon.
 *
 * Today a subsystem failure inside `runDaemon()` (daemon.ts) is a single
 * `log('ERROR', ...)` line that scrolls out of the log file and is never
 * surfaced anywhere else — `agents daemon status` has no way to answer "is the
 * browser IPC server actually healthy right now?" beyond "the daemon process
 * is alive". This module gives every subsystem a small persisted record —
 * {@link SubsystemHealth} — so `agents daemon status` / `agents daemon
 * services` can report health, not just liveness (RUSH-2354).
 *
 * Scheduled routines get this for free once migrated onto `agents routines`
 * (their run history already carries success/failure — `agents routines
 * stats`). This module exists for the subsystems that predate routines and have
 * no run history of their own: the browser IPC server, plus the daemon's own
 * startup (`SUBSYSTEM_DAEMON_START`, RUSH-2418) — which is the one record that
 * also GATES behaviour rather than only reporting it. The secrets broker moved
 * with the standalone `secrets` engine (PHNX-3989 OWN-1) — this daemon no
 * longer hosts or supervises it, so it carries no health record here.
 *
 * File-backed (one JSON object keyed by subsystem name) rather than in-memory
 * because `agents daemon status` runs as a SEPARATE process from the daemon —
 * it must read what the daemon last recorded, not maintain its own state.
 */
import * as fs from 'fs';
import * as path from 'path';
import { getDaemonDir } from './state.js';
import { atomicWriteFileSync, ensureLockTarget, withFileLock } from './fs-atomic.js';

const HEALTH_FILE = 'health.json';

/** Stable subsystem identifiers shared by the daemon (writer) and `agents daemon` (reader). */
export const SUBSYSTEM_BROWSER_IPC = 'browser-ipc';
/**
 * Daemon startup itself (RUSH-2418). Unlike the two above, this record is
 * written from BOTH sides: the launching CLI records a start that produced no
 * live daemon, and the daemon records its own successful claim. Its
 * `consecutiveFailures` is what `ensureDaemonStarted` reads to open the
 * auto-start circuit breaker, so a daemon dying on boot stops being relaunched
 * by every foreground command that happens to want one.
 */
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
  /**
   * `ServiceSupervisor`'s lifecycle state (`idle`/`running`/`parked`/`stopped`),
   * written by `recordSubsystemState` on every transition. Only present for
   * supervisor-managed subsystems (RUSH-3193 P4) — a subsystem that predates the
   * supervisor (e.g. `daemon-start`) never has this field, which is how `agents
   * daemon services` tells a measured state from an inferred one.
   */
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

/**
 * Never throws. `recordSubsystemOk`/`recordSubsystemError` are called from
 * inside a service's error boundary (`ServiceSupervisor.runTick`'s catch, and
 * its own catch-of-a-catch in `recordFailure`) — a write failure here (disk
 * full, permission, or the state dir removed mid-run, which this daemon
 * explicitly anticipates via the state-dir self-check) must degrade to a
 * dropped health update, never escape as an unhandled rejection that would
 * hit the process-wide handler and take down every OTHER service too.
 */
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

/**
 * Refine the reason on an already-counted failure, without bumping the streak.
 *
 * Exists because a start is counted BEFORE its outcome is known (RUSH-2418):
 * the launcher marks the attempt, then replaces the provisional reason with the
 * real one if it fails outright. Calling `recordSubsystemError` a second time
 * would count one failed start as two.
 *
 * Describing a failure that was never counted would be a lie in the other
 * direction — a `lastError` with `consecutiveFailures: 0` — so an unreported
 * subsystem is left alone rather than given a blank record to decorate.
 */
export function recordSubsystemErrorReason(subsystem: string, error: string, at: string = new Date().toISOString()): void {
  updateAll((all) => {
    const existing = all[subsystem];
    if (!existing) return;
    all[subsystem] = { ...existing, lastError: error, lastErrorAt: at };
  });
}

/**
 * Record a `ServiceSupervisor` lifecycle-state transition, without touching
 * the ok/error streak. Cross-process readers (`agents daemon services`) have
 * no other way to see `parked`/`stopped` vs `running` — `agents daemon
 * status` runs as a separate process from the daemon (see module docblock).
 */
export function recordSubsystemState(subsystem: string, state: string): void {
  updateAll((all) => {
    const existing = all[subsystem] ?? blankRecord(subsystem);
    all[subsystem] = { ...existing, subsystem, state };
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
