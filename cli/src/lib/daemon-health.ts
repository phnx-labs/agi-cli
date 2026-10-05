import * as fs from 'fs';
import * as path from 'path';
import { getDaemonDir } from './state.js';
import { atomicWriteFileSync, ensureLockTarget, withFileLock } from './fs-atomic.js';

const HEALTH_FILE = 'health.json';

export const SUBSYSTEM_DAEMON_START = 'daemon-start';

export interface SubsystemHealth {
  subsystem: string;
  lastError: string | null;
  lastErrorAt: string | null;
  consecutiveFailures: number;
  lastOkAt: string | null;
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

function updateAll(update: (records: Record<string, SubsystemHealth>) => void): void {
  try {
    const healthPath = getHealthPath();
    ensureLockTarget(healthPath, '{}');
    withFileLock(healthPath, () => {
      const records = readAll();
      update(records);
      atomicWriteFileSync(healthPath, JSON.stringify(records), { encoding: 'utf-8', mode: 0o600 });
      try { fs.chmodSync(healthPath, 0o600); } catch {  }
    });
  } catch {  }
}

function blankRecord(subsystem: string): SubsystemHealth {
  return { subsystem, lastError: null, lastErrorAt: null, consecutiveFailures: 0, lastOkAt: null };
}

export function recordSubsystemOk(subsystem: string, at: string = new Date().toISOString()): void {
  updateAll((all) => {
    const existing = all[subsystem] ?? blankRecord(subsystem);
    all[subsystem] = { ...existing, subsystem, consecutiveFailures: 0, lastOkAt: at };
  });
}

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

export function recordSubsystemErrorReason(subsystem: string, error: string, at: string = new Date().toISOString()): void {
  updateAll((all) => {
    const existing = all[subsystem];
    if (!existing) return;
    all[subsystem] = { ...existing, lastError: error, lastErrorAt: at };
  });
}

export function recordSubsystemState(subsystem: string, state: string): void {
  updateAll((all) => {
    const existing = all[subsystem] ?? blankRecord(subsystem);
    all[subsystem] = { ...existing, subsystem, state };
  });
}


const RESTARTS_FILE = 'restarts.json';
const MAX_RESTART_RECORDS = 200;

export interface DaemonRestartRecord {
  at: string;
  subsystem: string;
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

export function recordDaemonRestart(subsystem: string, cause: string, at: string = new Date().toISOString()): void {
  try {
    const restartsPath = getRestartsPath();
    ensureLockTarget(restartsPath, '[]');
    withFileLock(restartsPath, () => {
      const records = readRestarts();
      records.push({ at, subsystem, cause });
      atomicWriteFileSync(restartsPath, JSON.stringify(records.slice(-MAX_RESTART_RECORDS)), { encoding: 'utf-8', mode: 0o600 });
      try { fs.chmodSync(restartsPath, 0o600); } catch {  }
    });
  } catch {  }
}

export function readRecentDaemonRestarts(sinceMs: number): DaemonRestartRecord[] {
  return readRestarts().filter((r) => {
    const t = Date.parse(r.at);
    return Number.isFinite(t) && t >= sinceMs;
  });
}

export function readSubsystemHealth(subsystem: string): SubsystemHealth | null {
  return readAll()[subsystem] ?? null;
}

export function readAllSubsystemHealth(): SubsystemHealth[] {
  return Object.values(readAll()).sort((a, b) => a.subsystem.localeCompare(b.subsystem));
}
