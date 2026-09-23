/**
 * Account usage/auth services (PHNX-3608): usage and auth refresh now run as TWO
 * independent supervised PeriodicServices — `AccountUsageService` (`account-state`)
 * and `AccountAuthService` (`account-auth`) — each with its own per-tick deadline,
 * AbortSignal, and circuit breaker, replacing the old un-deadlined dual-`setInterval`
 * loop whose `usageRunning` latch could hang forever (the 12h usage-dark root cause).
 * Independent services mean a run of usage THROWS keeps usage ticking without ever
 * starving the slower auth refresh, and a usage HANG exits the daemon for a
 * supervised restart (PHNX-4116). Driven through the real ServiceSupervisor so the
 * deadline/abort/exit-on-breach path is exercised, not stubbed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ServiceSupervisor } from './supervisor.js';
import {
  AccountUsageService,
  AccountAuthService,
  AUTH_STATE_TICK_MS,
  processAccountAuthTransitions,
  publishAccountDaemonStateRows,
  USAGE_STATE_TICK_MS,
} from './account-state-daemon-service.js';
import type { DaemonContext } from './service.js';

let testDaemonDir = '';
const originalDaemonDir = process.env.AGENTS_DAEMON_DIR;

beforeEach(() => {
  testDaemonDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-cli-acctstate-'));
  process.env.AGENTS_DAEMON_DIR = testDaemonDir;
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  if (originalDaemonDir === undefined) delete process.env.AGENTS_DAEMON_DIR;
  else process.env.AGENTS_DAEMON_DIR = originalDaemonDir;
  fs.rmSync(testDaemonDir, { recursive: true, force: true });
});

function makeCtx(): DaemonContext {
  return { log: () => {} };
}

describe('AccountUsageService / AccountAuthService', () => {
  it('usage ticks on its interval; auth ticks on its slower interval', async () => {
    const usage = vi.fn(async () => {});
    const auth = vi.fn(async () => {});
    const supervisor = new ServiceSupervisor();
    supervisor.register(new AccountUsageService(usage));
    supervisor.register(new AccountAuthService(auth));

    await supervisor.startAll(makeCtx());
    await vi.advanceTimersByTimeAsync(0); // immediate first tick for both
    expect(usage).toHaveBeenCalledTimes(1);
    expect(auth).toHaveBeenCalledTimes(1);

    // One usage interval later: usage ticks again, auth does not (slower cadence).
    await vi.advanceTimersByTimeAsync(USAGE_STATE_TICK_MS);
    expect(usage).toHaveBeenCalledTimes(2);
    expect(auth).toHaveBeenCalledTimes(1);

    // Reach the auth interval: auth ticks again.
    await vi.advanceTimersByTimeAsync(AUTH_STATE_TICK_MS - USAGE_STATE_TICK_MS);
    expect(auth).toHaveBeenCalledTimes(2);

    await supervisor.stopAll();
  });

  it('each service passes its tick an AbortSignal', async () => {
    let usageSignal: AbortSignal | undefined;
    let authSignal: AbortSignal | undefined;
    const supervisor = new ServiceSupervisor();
    supervisor.register(new AccountUsageService(async (s) => { usageSignal = s; }));
    supervisor.register(new AccountAuthService(async (s) => { authSignal = s; }));

    await supervisor.startAll(makeCtx());
    await vi.advanceTimersByTimeAsync(0);
    expect(usageSignal).toBeInstanceOf(AbortSignal);
    expect(authSignal).toBeInstanceOf(AbortSignal);

    await supervisor.stopAll();
  });

  it('a run of usage THROWS keeps usage ticking without exiting — auth keeps ticking independently (PHNX-4116)', async () => {
    const exit = vi.fn();
    const usage = vi.fn(async () => { throw new Error('usage boom'); });
    const auth = vi.fn(async () => {});
    const supervisor = new ServiceSupervisor({ exit: exit as unknown as (code: number) => never });
    supervisor.register(new AccountUsageService(usage));
    supervisor.register(new AccountAuthService(auth));

    await supervisor.startAll(makeCtx());
    await vi.advanceTimersByTimeAsync(0); // tick #1 throws
    await vi.advanceTimersByTimeAsync(USAGE_STATE_TICK_MS); // #2 throws
    await vi.advanceTimersByTimeAsync(USAGE_STATE_TICK_MS); // #3 throws

    const health = supervisor.health();
    // A throw is recoverable — usage keeps ticking on its interval, never parked,
    // and the daemon is never exited for it.
    expect(health['account-state'].state).toBe('running');
    expect(health['account-state'].consecutiveFailures).toBeGreaterThanOrEqual(3);
    expect(health['account-state'].lastError).toMatch(/usage boom/);
    // Auth is untouched by usage's failures — the whole point of the split.
    expect(health['account-auth'].state).toBe('running');
    expect(auth).toHaveBeenCalled();
    expect(exit).not.toHaveBeenCalled();

    await supervisor.stopAll();
  });

  it('a hung usage refresh breaches its deadline and exits the daemon for a supervised restart (12h usage-dark fix, PHNX-4116)', async () => {
    const exit = vi.fn();
    const usage = vi.fn(async () => new Promise<void>(() => {})); // never settles
    const supervisor = new ServiceSupervisor({ exit: exit as unknown as (code: number) => never });
    supervisor.register(new AccountUsageService(usage));

    await supervisor.startAll(makeCtx());
    await vi.advanceTimersByTimeAsync(0); // first tick — usage hangs
    expect(usage).toHaveBeenCalledTimes(1);

    // The 2-minute deadline elapses -> the supervisor exits, rather than latching
    // forever (the old 12h usage-dark wedge) or parking.
    await vi.advanceTimersByTimeAsync(2 * 60_000);
    expect(exit).toHaveBeenCalledWith(70);

    await supervisor.stopAll();
  });
});

describe('account auth transition notification', () => {
  it('posts exactly once for each live to expired/revoked transition and persists the verdict', async () => {
    vi.useRealTimers();
    const stateFile = path.join(testDaemonDir, 'transitions.json');
    const sent: string[] = [];
    const notify = async (transition: { agent: string; account: string; verdict: string }) => {
      sent.push(`${transition.agent}:${transition.account}:${transition.verdict}`);
    };
    const row = (verdict: 'live' | 'expired' | 'revoked', checkedAt: number) => [{
      agent: 'claude' as const,
      version: 'main',
      account: 'work',
      health: { verdict, checkedAt },
    }];

    expect(await processAccountAuthTransitions(row('live', 1), { stateFile, notify })).toEqual([]);
    expect(await processAccountAuthTransitions(row('expired', 2), { stateFile, notify })).toHaveLength(1);
    expect(await processAccountAuthTransitions(row('expired', 3), { stateFile, notify })).toEqual([]);
    expect(await processAccountAuthTransitions(row('live', 4), { stateFile, notify })).toEqual([]);
    expect(await processAccountAuthTransitions(row('revoked', 5), { stateFile, notify })).toHaveLength(1);

    expect(sent).toEqual([
      'claude:work:expired',
      'claude:work:revoked',
    ]);
    expect(JSON.parse(fs.readFileSync(stateFile, 'utf-8'))).toMatchObject({
      version: 2,
      entries: {
        'claude:work': { verdict: 'revoked', checkedAt: 5 },
      },
      pending: {},
    });
  });

  it('keys transitions on the stable account id, never the display label', async () => {
    vi.useRealTimers();
    const stateFile = path.join(testDaemonDir, 'transitions.json');
    const notify = async () => {};
    const row = (verdict: 'live' | 'expired', checkedAt: number) => [{
      agent: 'claude' as const,
      version: 'main',
      account: 'shared@example.com',
      accountId: 'acct-work',
      health: { verdict, checkedAt },
    }];

    await processAccountAuthTransitions(row('live', 1), { stateFile, notify });
    const delivered = await processAccountAuthTransitions(row('expired', 2), { stateFile, notify });
    expect(delivered).toHaveLength(1);
    const state = JSON.parse(fs.readFileSync(stateFile, 'utf-8'));
    expect(Object.keys(state.entries)).toEqual(['claude:acct-work']);
    // The label stays on the delivered transition for display only.
    expect(delivered[0].account).toBe('shared@example.com');
  });

  it('keeps a failed notification in the outbox and retries it on the next tick', async () => {
    vi.useRealTimers();
    const stateFile = path.join(testDaemonDir, 'transitions.json');
    const sent: string[] = [];
    let fail = true;
    const notify = async (transition: { agent: string; account: string; verdict: string }) => {
      if (fail) throw new Error('sink down');
      sent.push(`${transition.agent}:${transition.account}:${transition.verdict}`);
    };
    const row = (verdict: 'live' | 'expired', checkedAt: number) => [{
      agent: 'claude' as const,
      version: 'main',
      account: 'work',
      health: { verdict, checkedAt },
    }];

    await processAccountAuthTransitions(row('live', 1), { stateFile, notify });
    // The failed delivery throws (the supervisor must see the unhealthy tick)…
    await expect(processAccountAuthTransitions(row('expired', 2), { stateFile, notify }))
      .rejects.toThrow(/kept in the outbox/);
    expect(sent).toEqual([]);
    // …and the pending entry is durable even though delivery failed.
    expect(JSON.parse(fs.readFileSync(stateFile, 'utf-8')).pending['claude:work'])
      .toMatchObject({ verdict: 'expired' });

    // Next tick: same verdict (expired → expired, no new transition), yet the
    // outbox entry is retried and now succeeds exactly once.
    fail = false;
    expect(await processAccountAuthTransitions(row('expired', 3), { stateFile, notify })).toHaveLength(1);
    expect(sent).toEqual(['claude:work:expired']);
    expect(JSON.parse(fs.readFileSync(stateFile, 'utf-8')).pending).toEqual({});

    // A later tick does not re-send.
    expect(await processAccountAuthTransitions(row('expired', 4), { stateFile, notify })).toEqual([]);
    expect(sent).toEqual(['claude:work:expired']);
  });

  it('publishes per-account verdicts into the real daemon-state envelope without dropping sibling fields', async () => {
    vi.useRealTimers();
    const previousMachine = process.env.AGENTS_SYNC_MACHINE_ID;
    process.env.AGENTS_SYNC_MACHINE_ID = 'account-test-device';
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-account-publish-'));
    try {
      const dir = path.join(root, 'devices', 'account-test-device');
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, 'daemon-state.json');
      fs.writeFileSync(file, JSON.stringify({
        version: 1,
        device: 'account-test-device',
        sessions: { rows: [] },
      }));
      await publishAccountDaemonStateRows([{
        agent: 'claude',
        version: 'main',
        account: 'work@example.com',
        accountId: 'acct-work',
        health: { verdict: 'live', checkedAt: Date.parse('2026-09-06T01:02:03.000Z') },
      }], root);
      expect(JSON.parse(fs.readFileSync(file, 'utf-8'))).toMatchObject({
        sessions: { rows: [] },
        accounts: {
          rows: [{
            // The stable registry id is the identity; the email rides along as
            // the display label only.
            accountId: 'acct-work',
            identityLabel: 'work@example.com',
            harness: 'claude',
            verdict: 'live',
            checkedAt: '2026-09-06T01:02:03.000Z',
          }],
        },
      });
    } finally {
      if (previousMachine === undefined) delete process.env.AGENTS_SYNC_MACHINE_ID;
      else process.env.AGENTS_SYNC_MACHINE_ID = previousMachine;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
