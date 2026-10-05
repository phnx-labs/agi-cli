
import * as fs from 'fs';
import * as path from 'path';
import { createHash } from 'crypto';
import { spawnSync } from 'child_process';
import { getMonitorsHistoryDir, ensureAgentsDir } from '../state.js';
import { safeJoin } from '../paths.js';
import { readRunMeta, type RunMeta } from '../scheduling/routines.js';
import type { MonitorEvent } from './config.js';

interface MonitorState {
  monitorName: string;
  lastHash: string;
  lastValue: string;
  lastSeenAt: string;
  lastFiredAt?: string;
  fireTimes?: number[];
}

const MAX_STORED_VALUE = 4096;

export interface MonitorLiveness {
  monitorName: string;
  lastCheckedAt: string;
  checkCount: number;
  lastError?: string;
  consecutiveErrors: number;
  droughtNotifiedAt?: string;
}

export function getMonitorHistoryDir(name: string): string {
  return safeJoin(getMonitorsHistoryDir(), name);
}

function getStatePath(name: string): string {
  return path.join(getMonitorHistoryDir(name), 'state.json');
}

function getLivenessPath(name: string): string {
  return path.join(getMonitorHistoryDir(name), 'liveness.json');
}

function getMonitorFiresDir(name: string): string {
  return path.join(getMonitorHistoryDir(name), 'fires');
}

export function readState(name: string): MonitorState | null {
  const statePath = getStatePath(name);
  if (!fs.existsSync(statePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(statePath, 'utf-8')) as MonitorState;
  } catch {
    return null;
  }
}

function writeStateRaw(state: MonitorState): void {
  ensureAgentsDir();
  const dir = getMonitorHistoryDir(state.monitorName);
  fs.mkdirSync(dir, { recursive: true });
  const statePath = path.join(dir, 'state.json');
  const tmp = `${statePath}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf-8');
  fs.renameSync(tmp, statePath);
}

export function writeState(
  name: string,
  value: string,
  dedupeKey?: string,
  extra: Partial<Pick<MonitorState, 'lastFiredAt' | 'fireTimes'>> = {},
): MonitorState {
  const prev = readState(name);
  const state: MonitorState = {
    monitorName: name,
    lastHash: hashSignature(value, dedupeKey),
    lastValue: value.length > MAX_STORED_VALUE ? value.slice(0, MAX_STORED_VALUE) : value,
    lastSeenAt: new Date().toISOString(),
    ...(prev?.lastFiredAt ? { lastFiredAt: prev.lastFiredAt } : {}),
    ...(prev?.fireTimes ? { fireTimes: prev.fireTimes } : {}),
    ...extra,
  };
  writeStateRaw(state);
  return state;
}

export function dedupeSignature(observation: string, dedupeKey?: string): string {
  if (!dedupeKey) return observation;
  try {
    const m = new RegExp(dedupeKey).exec(observation);
    if (m) return m[1] ?? m[0];
  } catch {
  }
  return observation;
}

function hashSignature(observation: string, dedupeKey?: string): string {
  return createHash('sha256').update(dedupeSignature(observation, dedupeKey)).digest('hex');
}

export function hasChanged(name: string, observation: string, dedupeKey?: string): boolean {
  const prev = readState(name);
  if (!prev) return true;
  return prev.lastHash !== hashSignature(observation, dedupeKey);
}

export function readLiveness(name: string): MonitorLiveness | null {
  const livenessPath = getLivenessPath(name);
  if (!fs.existsSync(livenessPath)) return null;
  try {
    return JSON.parse(fs.readFileSync(livenessPath, 'utf-8')) as MonitorLiveness;
  } catch {
    return null;
  }
}

export function recordCheck(
  name: string,
  checkedAt: string,
  error?: string,
): MonitorLiveness {
  const prev = readLiveness(name);
  const consecutiveErrors = error ? (prev?.consecutiveErrors ?? 0) + 1 : 0;
  const liveness: MonitorLiveness = {
    monitorName: name,
    lastCheckedAt: checkedAt,
    checkCount: (prev?.checkCount ?? 0) + 1,
    consecutiveErrors,
    ...(error ? { lastError: error } : {}),
    ...(error && prev?.droughtNotifiedAt ? { droughtNotifiedAt: prev.droughtNotifiedAt } : {}),
  };
  ensureAgentsDir();
  const dir = getMonitorHistoryDir(name);
  fs.mkdirSync(dir, { recursive: true });
  const livenessPath = path.join(dir, 'liveness.json');
  const tmp = `${livenessPath}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(liveness, null, 2), 'utf-8');
  fs.renameSync(tmp, livenessPath);
  return liveness;
}

export function markDroughtNotified(name: string, at: string): void {
  const prev = readLiveness(name);
  if (!prev) return;
  const livenessPath = getLivenessPath(name);
  const next: MonitorLiveness = { ...prev, droughtNotifiedAt: at };
  const tmp = `${livenessPath}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2), 'utf-8');
  fs.renameSync(tmp, livenessPath);
}

export function recordFireTime(name: string, now: number, windowMs: number): number[] {
  const prev = readState(name);
  const times = [...(prev?.fireTimes ?? []), now].filter((t) => now - t <= windowMs);
  return times;
}

export function writeFireRecord(
  event: MonitorEvent,
  meta: Record<string, unknown> = {},
): string {
  ensureAgentsDir();
  const fireId = event.firedAt.replace(/[:.]/g, '-');
  const fireDir = safeJoin(getMonitorFiresDir(event.monitorName), fireId);
  fs.mkdirSync(fireDir, { recursive: true });
  fs.writeFileSync(
    path.join(fireDir, 'event.json'),
    JSON.stringify({ ...event, ...meta }, null, 2),
    'utf-8',
  );
  return fireId;
}

interface FireRecord extends MonitorEvent {
  runId?: string;
  action?: string;
  ok?: boolean;
  error?: string;
  runStatusAtFire?: RunMeta['status'];
  postcondition?: string;
  postconditionOk?: boolean;
  postconditionError?: string;
}

export function listFires(name: string): FireRecord[] {
  const dir = getMonitorFiresDir(name);
  if (!fs.existsSync(dir)) return [];
  const ids = fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
  const fires: FireRecord[] = [];
  for (const id of ids) {
    const eventPath = path.join(dir, id, 'event.json');
    if (!fs.existsSync(eventPath)) continue;
    try {
      fires.push(JSON.parse(fs.readFileSync(eventPath, 'utf-8')) as FireRecord);
    } catch {
    }
  }
  return fires;
}

const POSTCONDITION_TIMEOUT_MS = 15_000;

interface ReconciledFireOutcome {
  ok: boolean;
  runStatus?: RunMeta['status'];
  effect?: 'met' | 'none';
  error?: string;
}

export function evaluatePostcondition(command: string): { ok: boolean; error?: string } {
  const trimmed = command.trim();
  if (!trimmed) return { ok: false, error: 'postcondition not met: empty command' };

  const [bin, args] = process.platform === 'win32'
    ? ['cmd', ['/c', trimmed]]
    : ['/bin/sh', ['-c', trimmed]];

  const result = spawnSync(bin as string, args as string[], {
    encoding: 'utf-8',
    timeout: POSTCONDITION_TIMEOUT_MS,
    maxBuffer: 8 * 1024 * 1024,
    env: { ...process.env, CLICOLOR: '0', NO_COLOR: '1', FORCE_COLOR: '0' },
  });

  if (result.status === 0) return { ok: true };

  if (result.error) {
    const err = result.error as NodeJS.ErrnoException;
    if (err.code === 'ETIMEDOUT') {
      return { ok: false, error: `postcondition not met: timed out after ${POSTCONDITION_TIMEOUT_MS / 1000}s` };
    }
    return { ok: false, error: `postcondition not met: ${err.message}` };
  }

  const detail = (result.stderr || result.stdout || '').trim().replace(/\s+/g, ' ').slice(0, 200);
  const exit = result.status ?? 'unknown';
  return { ok: false, error: `postcondition not met${detail ? `: ${detail}` : ` (exit ${exit})`}` };
}

function persistPostcondition(fire: FireRecord, result: { ok: boolean; error?: string }): void {
  writeFireRecord(fire, {
    postconditionOk: result.ok,
    ...(result.error ? { postconditionError: result.error } : {}),
  });
}

export function resolveFireOutcome(jobName: string, fire: FireRecord): ReconciledFireOutcome {
  if (!fire.runId) return { ok: fire.ok !== false };
  const run = readRunMeta(jobName, fire.runId);
  if (!run) return { ok: fire.ok !== false };
  if (run.status === 'running') return { ok: true, runStatus: run.status };
  if (run.status !== 'completed') return { ok: false, runStatus: run.status };

  if (!fire.postcondition) return { ok: true, runStatus: 'completed' };

  if (fire.postconditionOk === true) {
    return { ok: true, runStatus: 'completed', effect: 'met' };
  }
  if (fire.postconditionOk === false) {
    return {
      ok: false,
      runStatus: 'completed',
      effect: 'none',
      ...(fire.postconditionError ? { error: fire.postconditionError } : {}),
    };
  }

  const result = evaluatePostcondition(fire.postcondition);
  persistPostcondition(fire, result);
  fire.postconditionOk = result.ok;
  if (result.error) fire.postconditionError = result.error;
  return {
    ok: result.ok,
    runStatus: 'completed',
    effect: result.ok ? 'met' : 'none',
    ...(result.error ? { error: result.error } : {}),
  };
}
