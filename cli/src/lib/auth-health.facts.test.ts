import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// auth-health.ts -> state.ts resolves HOME (and thus the auth-health cache dir)
// at import time, so pin HOME to a throwaway dir BEFORE the module is loaded,
// then a single dynamic import picks it up. Mirrors star-nudge.test.ts; no mocks
// of our own modules — this exercises the real cache read/write path (PHNX-4116).
const savedHome = process.env.HOME;
const TMP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-facts-test-'));
process.env.HOME = TMP_HOME;
fs.mkdirSync(path.join(TMP_HOME, '.agents', '.cache'), { recursive: true });

type AuthHealthMod = typeof import('./auth-health.js');
let authHealth: AuthHealthMod;
// The real auth-failure detector + reason parser from the execution engine.
type ExecMod = typeof import('./exec.js');
let exec: ExecMod;

const HOST = 'testbox';

beforeAll(async () => {
  authHealth = await import('./auth-health.js');
  exec = await import('./exec.js');
});

afterAll(() => {
  if (savedHome === undefined) delete process.env.HOME; else process.env.HOME = savedHome;
  fs.rmSync(TMP_HOME, { recursive: true, force: true });
});

describe('formatAuthFact (per-box auth FACT, never a verdict word)', () => {
  it('reads "not used on this box yet" with no evidence', () => {
    expect(authHealth.formatAuthFact(null)).toBe('not used on this box yet');
    // A present-credential-no-evidence verdict is still just a fact-of-absence.
    expect(authHealth.formatAuthFact({ verdict: 'no_evidence', checkedAt: Date.now() }))
      .toBe('not used on this box yet');
    expect(authHealth.formatAuthFact({ verdict: 'unverified', checkedAt: Date.now() }))
      .toBe('not used on this box yet');
  });

  it('reads "last used ok <age>" for a recorded successful run', () => {
    const now = Date.now();
    const fact = authHealth.formatAuthFact({ verdict: 'live', source: 'run', checkedAt: now - 12 * 60_000, detail: 'run ok' }, now);
    expect(fact).toBe('last used ok 12m ago');
  });

  it('reads "last auth failure <detail> <time>" for a server rejection', () => {
    const at = new Date(2026, 8, 20, 14, 2).getTime(); // Sep 20 14:02 local
    const fact = authHealth.formatAuthFact({ verdict: 'revoked', source: 'run', checkedAt: at, detail: '401' });
    expect(fact).toBe('last auth failure 401 Sep 20 14:02');
  });

  it('reads a throttle as a fact with its reset and time', () => {
    const at = new Date(2026, 8, 20, 14, 2).getTime();
    const fact = authHealth.formatAuthFact({ verdict: 'rate_limited', source: 'run', checkedAt: at, detail: 'until 15:00' });
    expect(fact).toBe('rate-limited until 15:00 (Sep 20 14:02)');
  });
});

describe('runOutcomeVersionKey (pure fallback key)', () => {
  it('prefers an explicit version label', () => {
    expect(authHealth.runOutcomeVersionKey({ version: '2.1.1' })).toBe('2.1.1');
  });
  it('derives the label from a version home path', () => {
    expect(authHealth.runOutcomeVersionKey({ home: path.join('/x', '2.1.1', 'home') })).toBe('2.1.1');
  });
  it('is null when nothing resolves', () => {
    expect(authHealth.runOutcomeVersionKey({})).toBeNull();
  });
});

describe('probeAuthHealth — the row a non-headed box drops (why the host path needs launchability, PHNX-4116)', () => {
  it('a signed-in claude account on a non-headed box yields no_evidence, not a probe verdict', async () => {
    // The temp HOME has no configured role, so it is not headed and cannot read
    // the usage endpoint (RUSH-2392). With no usageKey there is no fresh-usage
    // shortcut either, so the honest verdict is "we did not look" — no_evidence.
    // `probeLocalFleetAuth` DROPS that row, which is exactly why the host
    // readiness path must fall back to launchability rather than read the absent
    // row as 'unconfigured'. Real behavior: no network probe is issued on this path.
    const info = {
      accountKey: 'acct-1', usageKey: null, accountId: null, organizationId: null,
      userId: null, email: 'bot@example.com', plan: null, usageStatus: null,
      overageCredits: null, lastActive: null, signedIn: true,
    };
    const health = await authHealth.probeAuthHealth('claude', undefined, { info });
    expect(health.verdict).toBe('no_evidence');
  });
});

describe('recordRunAuthOutcome -> the auth cache -> the fact (real IO, temp HOME)', () => {
  it('records a clean run as "last used ok" on the account row', () => {
    authHealth.recordRunAuthOutcome({ agent: 'claude', version: 'ver-ok', host: HOST, outcome: { ok: true }, now: Date.now() });
    const row = authHealth.readAuthHealth(HOST, 'claude', 'ver-ok');
    expect(row?.source).toBe('run');
    expect(row?.verdict).toBe('live');
    expect(authHealth.formatAuthFact(row)).toMatch(/^last used ok /);
  });

  it('records a real 401 log (through the real isAuthFailureFromLog) as an auth-failure fact', () => {
    const LOGGED_OUT_CLAUDE_LOG = [
      '{"type":"system","subtype":"init","session_id":"x"}',
      '{"type":"system","subtype":"api_retry","attempt":1,"max_retries":10,"error_status":401,"error":"authentication_failed","session_id":"x"}',
      '{"type":"result","subtype":"success","is_error":true,"api_error_status":401,"terminal_reason":"completed","result":"Failed to authenticate. API Error: 401 OAuth access token has been revoked.","num_turns":1}',
    ].join('\n');
    // The real detector classifies it, and the real reason parser names it.
    expect(exec.isAuthFailureFromLog(LOGGED_OUT_CLAUDE_LOG, 'claude', { processFailed: false })).toBe(true);
    const reason = exec.authFailureReason(LOGGED_OUT_CLAUDE_LOG) ?? 'authentication_failed';
    authHealth.recordRunAuthOutcome({ agent: 'claude', version: 'ver-401', host: HOST, outcome: { ok: false, verdict: 'revoked', detail: reason }, now: new Date(2026, 8, 20, 14, 2).getTime() });
    const row = authHealth.readAuthHealth(HOST, 'claude', 'ver-401');
    expect(row?.source).toBe('run');
    expect(authHealth.formatAuthFact(row)).toBe(`last auth failure ${reason} Sep 20 14:02`);
  });
});
