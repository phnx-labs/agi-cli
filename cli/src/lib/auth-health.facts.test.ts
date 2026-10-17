import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const savedHome = process.env.HOME;
const TMP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-facts-test-'));
process.env.HOME = TMP_HOME;
fs.mkdirSync(path.join(TMP_HOME, '.agents', '.cache'), { recursive: true });

type AuthHealthMod = typeof import('./auth-health.js');
let authHealth: AuthHealthMod;

const HOST = 'testbox';

function readRow(agent: string, version: string) {
  return authHealth.readAuthHealthCache()[authHealth.authCacheKey(HOST, agent, version)] ?? null;
}

beforeAll(async () => {
  authHealth = await import('./auth-health.js');
});

afterAll(() => {
  if (savedHome === undefined) delete process.env.HOME; else process.env.HOME = savedHome;
  fs.rmSync(TMP_HOME, { recursive: true, force: true });
});

describe('formatAuthFact (per-box auth FACT, never a verdict word)', () => {
  it('reads "not used on this box yet" with no evidence', () => {
    expect(authHealth.formatAuthFact(null)).toBe('not used on this box yet');
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
    const at = new Date(2026, 8, 20, 14, 2).getTime();
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
    const row = readRow('claude', 'ver-ok');
    expect(row?.source).toBe('run');
    expect(row?.verdict).toBe('live');
    expect(authHealth.formatAuthFact(row)).toMatch(/^last used ok /);
  });

  it('records a failed run as an auth-failure fact', () => {
    authHealth.recordRunAuthOutcome({ agent: 'claude', version: 'ver-401', host: HOST, outcome: { ok: false, verdict: 'revoked', detail: 'OAuth access token has been revoked' }, now: new Date(2026, 8, 20, 14, 2).getTime() });
    const row = readRow('claude', 'ver-401');
    expect(row?.source).toBe('run');
    expect(authHealth.formatAuthFact(row)).toBe('last auth failure OAuth access token has been revoked Sep 20 14:02');
  });
});
