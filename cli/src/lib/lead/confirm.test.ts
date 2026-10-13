import * as fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CONFIRM_TTL_MS, ConfirmError, claimConfirm, mintConfirm, sweepExpiredConfirms } from './confirm.js';
import { confirmsDir } from './paths.js';

const input = { project: 'demo', action: 'stop' as const, sessionId: 's-1', label: 'Stop “Docs”' };

describe('confirm tokens', () => {
  it('mints a c_ token that claims exactly once', () => {
    const rec = mintConfirm(input, 1_000);
    expect(rec.token).toMatch(/^c_[0-9a-f]{16}$/);
    expect(rec.expiresAtMs).toBe(1_000 + CONFIRM_TTL_MS);
    expect(claimConfirm(rec.token, 2_000)).toMatchObject(input);
    expect(() => claimConfirm(rec.token, 2_000)).toThrow(ConfirmError);
  });

  it('refuses a token after 10 minutes and consumes it', () => {
    const rec = mintConfirm(input, 0);
    let caught: unknown;
    try { claimConfirm(rec.token, CONFIRM_TTL_MS + 1); } catch (err) { caught = err; }
    expect(caught).toBeInstanceOf(ConfirmError);
    expect((caught as ConfirmError).reason).toBe('expired');
    expect(fs.existsSync(`${confirmsDir()}/${rec.token}.json`)).toBe(false);
  });

  it('rejects malformed tokens without touching the disk', () => {
    expect(() => claimConfirm('../../etc/passwd')).toThrow(/not a confirm token/);
  });

  it('sweeps only expired tokens', () => {
    const live = mintConfirm(input, 10 * CONFIRM_TTL_MS);
    const dead = mintConfirm(input, 0);
    expect(sweepExpiredConfirms(10 * CONFIRM_TTL_MS)).toBeGreaterThanOrEqual(1);
    expect(fs.existsSync(`${confirmsDir()}/${dead.token}.json`)).toBe(false);
    expect(claimConfirm(live.token, 10 * CONFIRM_TTL_MS)).toMatchObject(input);
  });
});
