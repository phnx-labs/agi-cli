/** Native per-monitor state-diff store: monitors' one new primitive over routines, a
 * last-observed-VALUE store. Layout under `~/.agents/.history/monitors/<name>/`: `state.json`
 * (hash/value, fire bookkeeping) and `fires/<id>/`; atomic writes. */

import * as fs from 'fs';
import * as path from 'path';
import { createHash } from 'crypto';
import { spawnSync } from 'child_process';
import { getMonitorsHistoryDir, ensureAgentsDir } from '../state.js';
import { safeJoin } from '../paths.js';
import { readRunMeta, type RunMeta } from '../scheduling/routines.js';
import type { MonitorEvent } from './config.js';

/** Persisted last-seen state for one monitor. */
interface MonitorState {
  monitorName: string;
  /** Hash of the last-seen de-dupe signature (see hasChanged). */
  lastHash: string;
  /** The last-seen raw observation (truncated for storage). */
  lastValue: string;
  /** RFC3339 timestamp of the last observation. */
  lastSeenAt: string;
  /** RFC3339 timestamp of the last fire, when the monitor has ever fired. */
  lastFiredAt?: string;
  /** Epoch-ms timestamps of recent fires, for the rate-limit / firehose guard. */
  fireTimes?: number[];
}

const MAX_STORED_VALUE = 4096;

/** Per-monitor liveness heartbeat, recorded on EVERY poll. Separate from MonitorState (written only
 * on a fire or baseline) so a monitor that polls but never matches isn't `state: null`, like one
 * never touched (RUSH-2485). Its own file, so it can't perturb decideFire. */
export interface MonitorLiveness {
  monitorName: string;
  /** RFC3339 timestamp of the last poll attempt. */
  lastCheckedAt: string;
  /** Total polls the engine has run against this monitor's source. */
  checkCount: number;
  /** The last poll's error (source produced nothing / threw), cleared on the next good poll. */
  lastError?: string;
  /** Consecutive failed polls; reset to 0 on any successful observation. Drives drought escalation. */
  consecutiveErrors: number;
  /** RFC3339 timestamp of the last drought notification, so the engine notifies once per drought. */
  droughtNotifiedAt?: string;
}

/** Per-monitor history root, with the (untrusted) name contained to one segment. */
export function getMonitorHistoryDir(name: string): string {
  return safeJoin(getMonitorsHistoryDir(), name);
}

function getStatePath(name: string): string {
  return path.join(getMonitorHistoryDir(name), 'state.json');
}

function getLivenessPath(name: string): string {
  return path.join(getMonitorHistoryDir(name), 'liveness.json');
}

/** Directory holding a monitor's fire history. */
function getMonitorFiresDir(name: string): string {
  return path.join(getMonitorHistoryDir(name), 'fires');
}

/** Read a monitor's last-seen state, or null if it has never been observed. */
export function readState(name: string): MonitorState | null {
  const statePath = getStatePath(name);
  if (!fs.existsSync(statePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(statePath, 'utf-8')) as MonitorState;
  } catch {
    return null;
  }
}

/** Persist a monitor's state atomically (temp file + rename, like writeRunMeta). */
function writeStateRaw(state: MonitorState): void {
  ensureAgentsDir();
  const dir = getMonitorHistoryDir(state.monitorName);
  fs.mkdirSync(dir, { recursive: true });
  const statePath = path.join(dir, 'state.json');
  const tmp = `${statePath}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf-8');
  fs.renameSync(tmp, statePath);
}

/** Records a new observation as the monitor's last-seen state, preserving fire bookkeeping.
 * Truncates the stored raw value so a firehose can't bloat disk. */
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

/** The de-dupe signature for an observation: the first regex match of `dedupeKey` against it (so
 * "the same event" is the same matched token), else the full observation. An unmatched dedupeKey
 * falls back to the full observation. */
export function dedupeSignature(observation: string, dedupeKey?: string): string {
  if (!dedupeKey) return observation;
  try {
    const m = new RegExp(dedupeKey).exec(observation);
    if (m) return m[1] ?? m[0];
  } catch {
    /* invalid regex — fall back to full observation */
  }
  return observation;
}

function hashSignature(observation: string, dedupeKey?: string): string {
  return createHash('sha256').update(dedupeSignature(observation, dedupeKey)).digest('hex');
}

/** True when the observation's de-dupe signature differs from the last-seen one (or the monitor was
 * never observed). Pure read; the caller persists via writeState only on a real fire. */
export function hasChanged(name: string, observation: string, dedupeKey?: string): boolean {
  const prev = readState(name);
  if (!prev) return true;
  return prev.lastHash !== hashSignature(observation, dedupeKey);
}

/** Read a monitor's liveness heartbeat, or null if the engine has never polled it. */
export function readLiveness(name: string): MonitorLiveness | null {
  const livenessPath = getLivenessPath(name);
  if (!fs.existsSync(livenessPath)) return null;
  try {
    return JSON.parse(fs.readFileSync(livenessPath, 'utf-8')) as MonitorLiveness;
  } catch {
    return null;
  }
}

/** Records one poll attempt as the liveness heartbeat, the engine's single per-evaluation call.
 * Success clears `lastError`/`consecutiveErrors` and the drought flag; failure records the error
 * and bumps the counter drought escalation reads. Atomic; never touches state.json. */
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
    // A drought flag only survives while the drought does — cleared on recovery.
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

/** Stamp the drought-notified marker so the engine notifies at most once per drought. */
export function markDroughtNotified(name: string, at: string): void {
  const prev = readLiveness(name);
  if (!prev) return;
  const livenessPath = getLivenessPath(name);
  const next: MonitorLiveness = { ...prev, droughtNotifiedAt: at };
  const tmp = `${livenessPath}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2), 'utf-8');
  fs.renameSync(tmp, livenessPath);
}

/** Appends a fire timestamp and returns the pruned window (fires within `windowMs`); the engine
 * uses its length to decide whether the rate limit tripped. */
export function recordFireTime(name: string, now: number, windowMs: number): number[] {
  const prev = readState(name);
  const times = [...(prev?.fireTimes ?? []), now].filter((t) => now - t <= windowMs);
  return times;
}

/** Write a fire record to fires/<id>/event.json and return the fire id. */
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

/** A single fire history entry (as read back from disk). */
interface FireRecord extends MonitorEvent {
  runId?: string;
  action?: string;
  ok?: boolean;
  error?: string;
  /** The dispatched run's status AT FIRE TIME, best-effort (RUSH-2690). `executeJobDetached` writes
   * 'running' and returns at once; the real outcome lands later in `settle()`, so `ok` was frozen
   * early. Marks fires to revisit; never gates `ok` (`resolveFireOutcome` re-reads the run). */
  runStatusAtFire?: RunMeta['status'];
  /** The action's postcondition command, snapshotted at fire time with `{event}` interpolated
   * (PHNX-2842). `resolveFireOutcome` runs it once the run has settled `completed`. */
  postcondition?: string;
  /** Result of the postcondition check, persisted after the first evaluation. */
  postconditionOk?: boolean;
  /** stderr/stdout snippet when `postconditionOk` is false. */
  postconditionError?: string;
}

/** List a monitor's fire history, chronologically ascending. */
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
      /* skip corrupt record */
    }
  }
  return fires;
}

/** Cap a display-time postcondition so `monitors runs` cannot hang on a stuck command. */
const POSTCONDITION_TIMEOUT_MS = 15_000;

/** The reconciled outcome of one fire, resolved against the run's live status. */
interface ReconciledFireOutcome {
  /** True fire outcome, correcting the frozen `ok` against the run's CURRENT status. */
  ok: boolean;
  /** The run's live terminal status, when a runId is present and resolvable. */
  runStatus?: RunMeta['status'];
  /** Present when a `completed` run had a postcondition (PHNX-2842): `met` = exited 0; `none` = ran
   * but the intended effect didn't happen (must not read as `ok`). */
  effect?: 'met' | 'none';
  /** Why the fire is not ok, when the postcondition failed. */
  error?: string;
}

/** Runs a fire's postcondition command: exit 0 means the effect happened; anything else (nonzero,
 * timeout, spawn error, empty command) is "no effect". Real `/bin/sh -c` (`cmd /c`), as command
 * sources use. */
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

/** Persist the postcondition result onto the existing fire record. Frozen `ok` is left as the fire-time snapshot. */
function persistPostcondition(fire: FireRecord, result: { ok: boolean; error?: string }): void {
  writeFireRecord(fire, {
    postconditionOk: result.ok,
    ...(result.error ? { postconditionError: result.error } : {}),
  });
}

/** Reconciles a fire's frozen `ok` against the run's REAL current status (RUSH-2690) and, for
 * `completed` runs, a declared postcondition (PHNX-2842), at DISPLAY time, leaving the write path
 * alone. A failing postcondition gives `ok: false, effect: 'none'`. No `runId`: frozen `ok`. */
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
