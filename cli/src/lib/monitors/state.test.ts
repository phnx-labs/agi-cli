import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import {
  readState,
  writeState,
  hasChanged,
  dedupeSignature,
  recordFireTime,
  writeFireRecord,
  listFires,
  readLiveness,
  recordCheck,
  markDroughtNotified,
  getMonitorHistoryDir,
  resolveFireOutcome,
  evaluatePostcondition,
} from './state.js';
import type { MonitorEvent } from './config.js';
import { writeRunMeta, getJobRunsDir, type RunMeta } from '../scheduling/routines.js';

const NAME = `test-state-${process.pid}-${Date.now()}`;

afterEach(() => {
  try {
    fs.rmSync(getMonitorHistoryDir(NAME), { recursive: true, force: true });
  } catch {
  }
  try {
    fs.rmSync(getJobRunsDir(NAME), { recursive: true, force: true });
  } catch {
  }
});

describe('state-diff round-trip', () => {
  it('round-trips a value through writeState/readState', () => {
    expect(readState(NAME)).toBeNull();
    writeState(NAME, 'value-1');
    const state = readState(NAME);
    expect(state).not.toBeNull();
    expect(state!.monitorName).toBe(NAME);
    expect(state!.lastValue).toBe('value-1');
    expect(state!.lastHash.length).toBeGreaterThan(0);
  });

  it('preserves fire bookkeeping across a plain re-observation', () => {
    writeState(NAME, 'v1', undefined, { lastFiredAt: '2026-01-01T00:00:00.000Z', fireTimes: [1, 2] });
    writeState(NAME, 'v2');
    const state = readState(NAME);
    expect(state!.lastValue).toBe('v2');
    expect(state!.lastFiredAt).toBe('2026-01-01T00:00:00.000Z');
    expect(state!.fireTimes).toEqual([1, 2]);
  });
});

describe('hasChanged', () => {
  it('is true when there is no prior state (first observation)', () => {
    expect(hasChanged(NAME, 'anything')).toBe(true);
  });

  it('is false when the observation matches the stored value', () => {
    writeState(NAME, 'same');
    expect(hasChanged(NAME, 'same')).toBe(false);
  });

  it('is true when the observation differs', () => {
    writeState(NAME, 'old');
    expect(hasChanged(NAME, 'new')).toBe(true);
  });

  it('dedupes on the matched token when a dedupeKey is given', () => {
    writeState(NAME, 'status: issued at 10:00', 'status: (\\w+)');
    expect(hasChanged(NAME, 'status: issued at 11:59', 'status: (\\w+)')).toBe(false);
    expect(hasChanged(NAME, 'status: pending at 12:00', 'status: (\\w+)')).toBe(true);
  });
});

describe('dedupeSignature', () => {
  it('returns the full observation when no key', () => {
    expect(dedupeSignature('abc')).toBe('abc');
  });
  it('returns the first capture group of the key', () => {
    expect(dedupeSignature('build 42 failed', 'build (\\d+)')).toBe('42');
  });
  it('returns the whole match when there is no capture group', () => {
    expect(dedupeSignature('build 42 failed', 'failed')).toBe('failed');
  });
  it('falls back to the full observation on no match', () => {
    expect(dedupeSignature('all good', 'failed')).toBe('all good');
  });
});

describe('recordFireTime', () => {
  it('appends and prunes to the window', () => {
    const now = 1_000_000;
    writeState(NAME, 'v', undefined, { fireTimes: [now - 120_000, now - 10_000] });
    const times = recordFireTime(NAME, now, 60_000);
    expect(times).toEqual([now - 10_000, now]);
  });
});

describe('liveness heartbeat (RUSH-2485)', () => {
  it('is null until the engine records a check', () => {
    expect(readLiveness(NAME)).toBeNull();
  });

  it('records a check and increments checkCount on each poll', () => {
    recordCheck(NAME, '2026-03-01T00:00:00.000Z');
    let live = readLiveness(NAME);
    expect(live!.checkCount).toBe(1);
    expect(live!.lastCheckedAt).toBe('2026-03-01T00:00:00.000Z');
    expect(live!.consecutiveErrors).toBe(0);
    expect(live!.lastError).toBeUndefined();

    recordCheck(NAME, '2026-03-01T00:01:00.000Z');
    live = readLiveness(NAME);
    expect(live!.checkCount).toBe(2);
    expect(live!.lastCheckedAt).toBe('2026-03-01T00:01:00.000Z');
  });

  it('does NOT write change-detection state — a polled-but-never-matched monitor still has no state.json', () => {
    recordCheck(NAME, '2026-03-01T00:00:00.000Z');
    expect(readLiveness(NAME)).not.toBeNull();
    expect(readState(NAME)).toBeNull();
  });

  it('accumulates consecutive errors and clears them on a good poll', () => {
    recordCheck(NAME, '2026-03-01T00:00:00.000Z', 'boom');
    recordCheck(NAME, '2026-03-01T00:01:00.000Z', 'boom');
    let live = readLiveness(NAME);
    expect(live!.consecutiveErrors).toBe(2);
    expect(live!.lastError).toBe('boom');

    recordCheck(NAME, '2026-03-01T00:02:00.000Z');
    live = readLiveness(NAME);
    expect(live!.consecutiveErrors).toBe(0);
    expect(live!.lastError).toBeUndefined();
    expect(live!.checkCount).toBe(3);
  });

  it('keeps the drought marker across failures and drops it on recovery', () => {
    recordCheck(NAME, '2026-03-01T00:00:00.000Z', 'boom');
    markDroughtNotified(NAME, '2026-03-01T00:00:05.000Z');
    expect(readLiveness(NAME)!.droughtNotifiedAt).toBe('2026-03-01T00:00:05.000Z');

    recordCheck(NAME, '2026-03-01T00:01:00.000Z', 'boom');
    expect(readLiveness(NAME)!.droughtNotifiedAt).toBe('2026-03-01T00:00:05.000Z');

    recordCheck(NAME, '2026-03-01T00:02:00.000Z');
    expect(readLiveness(NAME)!.droughtNotifiedAt).toBeUndefined();
  });
});

describe('fire history', () => {
  it('writes and lists fire records', () => {
    const event: MonitorEvent = {
      monitorName: NAME,
      firedAt: '2026-02-01T00:00:00.000Z',
      summary: 'CI failed on #1',
      payload: { exitCode: 1 },
    };
    const id = writeFireRecord(event, { runId: 'run-1', action: 'run', ok: true });
    expect(id).toBe('2026-02-01T00-00-00-000Z');

    const fires = listFires(NAME);
    expect(fires.length).toBe(1);
    expect(fires[0].summary).toBe('CI failed on #1');
    expect(fires[0].runId).toBe('run-1');
    expect(fires[0].ok).toBe(true);
  });
});

describe('resolveFireOutcome (RUSH-2690 — reconcile the frozen ok against the run\'s real status)', () => {
  function baseMeta(runId: string, status: RunMeta['status']): RunMeta {
    return {
      jobName: NAME,
      runId,
      agent: 'claude',
      pid: null,
      spawnedAt: Date.now(),
      timeoutMs: 600_000,
      status,
      startedAt: '2026-08-15T08:00:41.400Z',
      completedAt: status === 'running' ? null : '2026-08-15T08:00:41.414Z',
      exitCode: status === 'running' ? null : 1,
    } as RunMeta;
  }

  const event: MonitorEvent = {
    monitorName: NAME,
    firedAt: '2026-08-15T08:00:41.411Z',
    summary: 'FIRE-NOW',
    payload: {},
  };

  it('the async-race case: fire recorded ok:true off a "running" snapshot, run later failed with no output — reconciled read says failed', () => {
    const runId = 'run-async-fail';
    const fire = { ...event, runId, action: 'run', ok: true, runStatusAtFire: 'running' as const };
    writeRunMeta(baseMeta(runId, 'failed'));

    const outcome = resolveFireOutcome(NAME, fire);
    expect(outcome.ok).toBe(false);
    expect(outcome.runStatus).toBe('failed');
  });

  it('a run still genuinely in flight (status: running) still reads ok — not everything running is a bug', () => {
    const runId = 'run-still-running';
    const fire = { ...event, runId, action: 'run', ok: true };
    writeRunMeta(baseMeta(runId, 'running'));

    const outcome = resolveFireOutcome(NAME, fire);
    expect(outcome.ok).toBe(true);
    expect(outcome.runStatus).toBe('running');
  });

  it('a run that settled clean (completed) reads ok', () => {
    const runId = 'run-completed';
    const fire = { ...event, runId, action: 'run', ok: true };
    writeRunMeta(baseMeta(runId, 'completed'));

    const outcome = resolveFireOutcome(NAME, fire);
    expect(outcome.ok).toBe(true);
    expect(outcome.runStatus).toBe('completed');
  });

  it('a run that was skipped/blocked/timeout at settle time still reads failed, not just the async-failed case', () => {
    for (const status of ['skipped', 'blocked', 'timeout'] as const) {
      const runId = `run-${status}`;
      const fire = { ...event, runId, action: 'run', ok: true };
      writeRunMeta(baseMeta(runId, status));
      expect(resolveFireOutcome(NAME, fire).runStatus, status).toBe(status);
      expect(resolveFireOutcome(NAME, fire).ok, status).toBe(false);
    }
  });

  it('a fire with no runId (notify/webhook-out) has nothing to reconcile against — the frozen ok is returned as-is', () => {
    expect(resolveFireOutcome(NAME, { ...event, action: 'notify', ok: true })).toEqual({ ok: true });
    expect(resolveFireOutcome(NAME, { ...event, action: 'notify', ok: false, error: 'no channel' })).toEqual({ ok: false });
  });

  it('a runId whose run record is missing/unreadable falls back to the frozen ok rather than throwing', () => {
    const fire = { ...event, runId: 'run-does-not-exist-on-disk', action: 'run', ok: true };
    expect(resolveFireOutcome(NAME, fire)).toEqual({ ok: true });
  });
});

describe('resolveFireOutcome (PHNX-2842 — completed is not ok unless the postcondition holds)', () => {
  function nodeExit(code: number): string {
    return process.platform === 'win32'
      ? `"${process.execPath}" -e "process.exit(${code})"`
      : `${JSON.stringify(process.execPath)} -e 'process.exit(${code})'`;
  }

  function baseMeta(runId: string, status: RunMeta['status']): RunMeta {
    return {
      jobName: NAME,
      runId,
      agent: 'claude',
      pid: null,
      spawnedAt: Date.now(),
      timeoutMs: 600_000,
      status,
      startedAt: '2026-08-20T16:48:18.000Z',
      completedAt: status === 'running' ? null : '2026-08-20T16:50:00.000Z',
      exitCode: status === 'running' ? null : 0,
    } as RunMeta;
  }

  const event: MonitorEvent = {
    monitorName: NAME,
    firedAt: '2026-08-20T16:48:18.000Z',
    summary: 'phnx-labs/agents-cli#1682',
    payload: {},
  };

  it('the bug: fire recorded ok:true, run completed exit 0, postcondition fails — reconciled read is no-effect, not ok', () => {
    const runId = 'run-merged-nothing';
    const postcondition = nodeExit(1);
    writeRunMeta(baseMeta(runId, 'completed'));
    writeFireRecord(event, {
      runId,
      action: 'run',
      ok: true,
      runStatusAtFire: 'running',
      postcondition,
    });

    const fire = listFires(NAME)[0]!;
    const outcome = resolveFireOutcome(NAME, fire);
    expect(outcome.ok).toBe(false);
    expect(outcome.runStatus).toBe('completed');
    expect(outcome.effect).toBe('none');
    expect(outcome.error).toMatch(/postcondition not met/);

    const persisted = listFires(NAME)[0]!;
    expect(persisted.postconditionOk).toBe(false);
    expect(persisted.postconditionError).toMatch(/postcondition not met/);
    expect(persisted.ok).toBe(true);
  });

  it('a completed run whose postcondition exits 0 reads ok with effect met', () => {
    const runId = 'run-merged';
    const postcondition = nodeExit(0);
    writeRunMeta(baseMeta(runId, 'completed'));
    writeFireRecord(event, { runId, action: 'run', ok: true, postcondition });

    const outcome = resolveFireOutcome(NAME, listFires(NAME)[0]!);
    expect(outcome.ok).toBe(true);
    expect(outcome.runStatus).toBe('completed');
    expect(outcome.effect).toBe('met');
    expect(listFires(NAME)[0]!.postconditionOk).toBe(true);
  });

  it('does not run the postcondition while the run is still in flight', () => {
    const runId = 'run-still-going';
    const marker = `${getMonitorHistoryDir(NAME)}/must-not-run`;
    const postcondition = process.platform === 'win32'
      ? `echo ran> "${marker}" & exit 1`
      : `touch ${JSON.stringify(marker)} && exit 1`;
    writeRunMeta(baseMeta(runId, 'running'));
    writeFireRecord(event, { runId, action: 'run', ok: true, postcondition });

    const outcome = resolveFireOutcome(NAME, listFires(NAME)[0]!);
    expect(outcome.ok).toBe(true);
    expect(outcome.runStatus).toBe('running');
    expect(outcome.effect).toBeUndefined();
    expect(fs.existsSync(marker)).toBe(false);
  });

  it('a failed run is failed even when its postcondition would pass', () => {
    const runId = 'run-failed-but-pr-merged-anyway';
    writeRunMeta({ ...baseMeta(runId, 'failed'), exitCode: 1 });
    writeFireRecord(event, { runId, action: 'run', ok: true, postcondition: nodeExit(0) });

    const outcome = resolveFireOutcome(NAME, listFires(NAME)[0]!);
    expect(outcome.ok).toBe(false);
    expect(outcome.runStatus).toBe('failed');
    expect(outcome.effect).toBeUndefined();
    expect(listFires(NAME)[0]!.postconditionOk).toBeUndefined();
  });

  it('a completed run with no postcondition still reads ok (investigation monitors are not merge monitors)', () => {
    const runId = 'run-investigate';
    writeRunMeta(baseMeta(runId, 'completed'));
    const fire = { ...event, runId, action: 'run' as const, ok: true };
    expect(resolveFireOutcome(NAME, fire)).toEqual({ ok: true, runStatus: 'completed' });
  });
});

describe('evaluatePostcondition', () => {
  it('exit 0 is met', () => {
    expect(evaluatePostcondition('exit 0')).toEqual({ ok: true });
  });

  it('exit 1 is not met and names the failure', () => {
    const result = evaluatePostcondition('exit 1');
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/postcondition not met/);
  });

  it('an empty command fails loud rather than looking like success', () => {
    expect(evaluatePostcondition('   ')).toEqual({ ok: false, error: 'postcondition not met: empty command' });
  });
});
