import { describe, it, expect } from 'vitest';
import { runFailureReason } from './routines.js';
import type { RunMeta } from '../lib/scheduling/routines.js';

/** Minimal RunMeta with the fields runFailureReason reads; the rest are inert. */
function meta(over: Partial<RunMeta>): RunMeta {
  return {
    jobName: 'r',
    runId: '2026-08-28T09-00-00-000Z',
    status: 'failed',
    startedAt: '2026-08-28T09:00:00.000Z',
    completedAt: '2026-08-28T09:00:01.000Z',
    exitCode: 1,
    ...over,
  } as RunMeta;
}

describe('runFailureReason', () => {
  it('returns null for a healthy run (completed/running need no annotation)', () => {
    expect(runFailureReason(meta({ status: 'completed', exitCode: 0 }))).toBeNull();
    expect(runFailureReason(meta({ status: 'running', completedAt: null, exitCode: null }))).toBeNull();
  });

  it('surfaces the auth-failure text verbatim from errorMessage', () => {
    const r = runFailureReason(meta({ status: 'failed', errorMessage: 'auth_failed: Please run /login' }));
    expect(r).toBe('auth_failed: Please run /login');
  });

  it('names an active-run overlap skip as blocked on the live run + when it started (PHNX-4116)', () => {
    // The live run id is a timestamp-shaped run id, so "active since" reverses it.
    const r = runFailureReason(meta({
      status: 'skipped', skipReason: 'active_run', exitCode: null,
      activeRunId: '2026-08-08T21-24-00-005Z',
    }));
    expect(r).toBe('blocked: run 2026-08-08T21-24-00-005Z active since 2026-08-08T21:24:00.005Z');
  });

  it('reads blocked without a time when the live run id is not timestamp-shaped', () => {
    const r = runFailureReason(meta({
      status: 'skipped', skipReason: 'active_run', exitCode: null, activeRunId: 'manual-xyz',
    }));
    expect(r).toBe('blocked: run manual-xyz still active');
  });

  it('names an active_run skip in human terms, not the removed "wedged" wording', () => {
    // No structured activeRunId and no errorMessage: the skipReason is the only signal.
    const r = runFailureReason(meta({ status: 'skipped', skipReason: 'active_run', exitCode: null }));
    expect(r).toBe('blocked: a prior run is still active');
  });

  it('falls back to the errorMessage for a legacy active_run record with no activeRunId', () => {
    const r = runFailureReason(meta({
      status: 'skipped', skipReason: 'active_run', exitCode: null,
      errorMessage: "skipped — 'x' already has an active run (2026-08-08T21-24-00-005Z)",
    }));
    expect(r).toContain('already has an active run');
  });

  it('uses the readiness message for a blocked run', () => {
    const r = runFailureReason(meta({
      status: 'blocked', exitCode: null,
      readiness: { code: 'agent_auth_failed', message: 'the selected account failed a live auth check' },
    }));
    expect(r).toBe('the selected account failed a live auth check');
  });

  it('falls back to the exit code for a plain nonzero failure (no errorMessage)', () => {
    // The most common shape: a command body exits 2, cause is in stdout.
    expect(runFailureReason(meta({ status: 'failed', errorMessage: undefined, exitCode: 2 }))).toBe('exit 2');
    // ...but a failure with no exit code at all still yields no fabricated reason.
    expect(runFailureReason(meta({ status: 'failed', errorMessage: undefined, exitCode: null }))).toBeNull();
  });

  it('explains a missed fire', () => {
    expect(runFailureReason(meta({ status: 'missed', exitCode: null }))).toBe(
      'scheduler was not running when it came due',
    );
  });

  it('compacts and truncates a long, multiline errorMessage', () => {
    const long = 'x'.repeat(200) + '\n\tmore';
    const r = runFailureReason(meta({ status: 'failed', errorMessage: long }))!;
    expect(r.length).toBeLessThanOrEqual(80);
    expect(r.endsWith('…')).toBe(true);
    expect(r).not.toContain('\n');
  });
});
