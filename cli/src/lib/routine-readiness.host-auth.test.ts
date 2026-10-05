import { describe, it, expect } from 'vitest';
import { decideRoutineAuthReadiness, decideHostAuthFromPing } from './routine-readiness.js';

// Missing auth is ready only with an explicit remote launchable bit; older payloads fail closed.
describe('decideRoutineAuthReadiness (shared local/host decision)', () => {
  it('worker with no probe row but a launchable token → ready', () => {
    expect(decideRoutineAuthReadiness(undefined, true)).toEqual({ ok: true });
  });

  it('a box with no probe row AND no launchable credential → not ready (unconfigured)', () => {
    expect(decideRoutineAuthReadiness(undefined, false)).toEqual({ ok: false, reason: 'unconfigured' });
  });

  it('a fresh revoked verdict → not ready, regardless of a token on disk', () => {
    expect(decideRoutineAuthReadiness({ verdict: 'revoked' }, true)).toEqual({ ok: false, reason: 'revoked' });
  });

  it('a present no_evidence row (probe budget spent) → ready', () => {
    expect(decideRoutineAuthReadiness({ verdict: 'no_evidence' }, false)).toEqual({ ok: true });
  });

  it('the ordinary usable verdicts are ready', () => {
    for (const verdict of ['live', 'rate_limited', 'unverified'] as const) {
      expect(decideRoutineAuthReadiness({ verdict }, false), verdict).toEqual({ ok: true });
    }
  });
});

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
    expect(decideHostAuthFromPing(payload, 'claude')).toEqual({ ok: true });
  });
});
