import { describe, it, expect } from 'vitest';
import { decideRoutineAuthReadiness, decideHostAuthFromPing } from './routine-readiness.js';

/**
 * The ONE decision both readiness paths share (PHNX-4116). Pure, so these run the
 * real code with no mocks. The bug this covers: after the PR dropped the
 * `no_evidence` row from `probeLocalFleetAuth`, a `--host <worker>` routine on
 * claude/kimi/droid found no row, fell to the literal `'unconfigured'`, and was
 * reported `agent_auth_failed` with a valid token on disk. The fix is the
 * absent-row + launchability fallback below — the same one the local path uses,
 * so both reach the same answer for the same box.
 */
describe('decideRoutineAuthReadiness (shared local/host decision)', () => {
  it('worker with no probe row but a launchable token → ready', () => {
    // A worker drops its `no_evidence` row, so `row` is absent; the token on disk
    // makes it launchable. This is the exact regression case.
    expect(decideRoutineAuthReadiness(undefined, true)).toEqual({ ok: true });
  });

  it('a box with no probe row AND no launchable credential → not ready (unconfigured)', () => {
    // A genuinely signed-out box still fails — the token, not the missing row,
    // is what decides.
    expect(decideRoutineAuthReadiness(undefined, false)).toEqual({ ok: false, reason: 'unconfigured' });
  });

  it('a fresh revoked verdict → not ready, regardless of a token on disk', () => {
    expect(decideRoutineAuthReadiness({ verdict: 'revoked' }, true)).toEqual({ ok: false, reason: 'revoked' });
  });

  it('a present no_evidence row (probe budget spent) → ready', () => {
    // A headed box that spent its hourly usage-endpoint budget yields no_evidence;
    // it is accepted directly, and would also be ready via launchability.
    expect(decideRoutineAuthReadiness({ verdict: 'no_evidence' }, false)).toEqual({ ok: true });
  });

  it('the ordinary usable verdicts are ready', () => {
    for (const verdict of ['live', 'rate_limited', 'unverified'] as const) {
      expect(decideRoutineAuthReadiness({ verdict }, false), verdict).toEqual({ ok: true });
    }
  });
});

/**
 * The host path parses the REMOTE box's `devices ping --local --json` payload and
 * runs the shared decision. `decideHostAuthFromPing` is pure over that payload
 * TEXT so the exact worker/headed/revoked payloads are tested without SSH.
 */
describe('decideHostAuthFromPing (remote `devices ping --local --json` → readiness)', () => {
  const now = Date.now();

  it('worker payload: no probe row for the agent + launchable → ready', () => {
    const payload = JSON.stringify({ host: 'worker-1', rows: [], launchable: ['claude', 'kimi'] });
    expect(decideHostAuthFromPing(payload, 'claude')).toEqual({ ok: true });
  });

  it('worker payload: no probe row and NOT launchable → not ready (unconfigured)', () => {
    const payload = JSON.stringify({ host: 'worker-1', rows: [], launchable: [] });
    expect(decideHostAuthFromPing(payload, 'claude')).toEqual({ ok: false, reason: 'unconfigured' });
  });

  it('payload carrying a fresh revoked row → not ready', () => {
    const payload = JSON.stringify({
      host: 'worker-1',
      rows: [{ agent: 'claude', version: '2.1.0', health: { verdict: 'revoked', checkedAt: now } }],
      launchable: ['claude'],
    });
    expect(decideHostAuthFromPing(payload, 'claude')).toEqual({ ok: false, reason: 'revoked' });
  });

  it('headed payload carrying a no_evidence row (probe budget spent) → ready', () => {
    const payload = JSON.stringify({
      host: 'zion',
      rows: [{ agent: 'claude', version: '2.1.0', health: { verdict: 'no_evidence', checkedAt: now } }],
      launchable: ['claude'],
    });
    expect(decideHostAuthFromPing(payload, 'claude')).toEqual({ ok: true });
  });

  it('a payload missing the launchable field degrades to rows-only (older CLI) → absent row is unconfigured', () => {
    // A peer on the pre-fix CLI emits no `launchable`; a dropped row then reads as
    // no credential. This is the honest floor, not a silent pass.
    const payload = JSON.stringify({ host: 'worker-1', rows: [] });
    expect(decideHostAuthFromPing(payload, 'claude')).toEqual({ ok: false, reason: 'unconfigured' });
  });

  it('unparseable output → null (a probe failure, never "no credential")', () => {
    expect(decideHostAuthFromPing('not json', 'claude')).toBeNull();
    expect(decideHostAuthFromPing('', 'claude')).toBeNull();
  });

  it('a row for a DIFFERENT agent does not answer for this agent', () => {
    const payload = JSON.stringify({
      host: 'worker-1',
      rows: [{ agent: 'kimi', health: { verdict: 'live', checkedAt: now } }],
      launchable: ['claude'],
    });
    // No claude row, but claude is launchable → ready via the fallback.
    expect(decideHostAuthFromPing(payload, 'claude')).toEqual({ ok: true });
  });
});
