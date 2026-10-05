/** Tests daemon-ticks.ts (usage + fleet auth bodies run by `AccountStateDaemonService`).
 * `isFreshFleetAuthSnapshot` decides whether a recent publication satisfies an on-demand refresh.
 * `runActiveSessionsWarmTick` is the journal writer `sessions watch` depends on (RUSH-2484). */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { isFreshFleetAuthSnapshot, isCachedFleetAuthProbeFresh, installedAuthRows, shouldReuseCachedAuthProbe, AUTH_PROBE_MAX_AGE_MS, runActiveSessionsWarmTick, runUsageRefreshTick } from './daemon-ticks.js';
import {
  authCacheKey,
  authTargetKey,
  readFleetAuthRows,
  writeAuthHealthEntries,
  writeFleetAuthRows,
  type AuthProbeRow,
} from './auth-health.js';
import { machineId } from './machine-id.js';
import {
  readActiveSessionsCache,
  setActiveSessionsSnapshotPathForTest,
  setImmutableMemoPathForTest,
  setActiveSessionsReaderPresencePathForTest,
  noteActiveSessionsJournalReader,
  isActiveSessionsJournalReaderRecent,
  ACTIVE_SESSIONS_READER_IDLE_WINDOW_MS,
} from './session/session-cache.js';

describe('isFreshFleetAuthSnapshot', () => {
  const minimum = 1_000;
  const row = { host: 'host-a', agents: { running: 0, live: 0, byContext: {}, byAgent: {} }, stats: null, capturedAt: minimum };
  const authRow = { agent: 'claude' as const, version: '1.0.0', health: { verdict: 'live' as const, checkedAt: minimum } };

  it('requires auth rows captured in the same freshness window as fleet status', () => {
    expect(isFreshFleetAuthSnapshot({ row, authRows: [] }, minimum)).toBe(false);
    expect(isFreshFleetAuthSnapshot({ row, authRows: [{ ...authRow, health: { ...authRow.health, checkedAt: minimum - 1 } }] }, minimum)).toBe(false);
    expect(isFreshFleetAuthSnapshot({ row, authRows: [authRow] }, minimum)).toBe(true);
  });
});

describe('isCachedFleetAuthProbeFresh — periodic tick reuses a real verdict, does not re-hit /oauth/usage every 3min (RUSH-2998)', () => {
  const now = 100 * 60_000;
  const row = (checkedAt: number, version = '1.0.0') => ({ agent: 'claude' as const, version, health: { verdict: 'live' as const, checkedAt } });
  /** The (agent, version) homes that still exist on the box — what the probe enumerates. */
  const installed = (...versions: string[]) => new Set(versions.map((v) => authTargetKey('claude', v)));
  const only1_0_0 = installed('1.0.0');

  it('reuses a verdict probed within the 20-minute window', () => {
    expect(isCachedFleetAuthProbeFresh([row(now - 5 * 60_000)], now, only1_0_0)).toBe(true);
    // Exactly at the boundary is stale (strict <), so the tick re-probes.
    expect(isCachedFleetAuthProbeFresh([row(now - AUTH_PROBE_MAX_AGE_MS)], now, only1_0_0)).toBe(false);
    expect(isCachedFleetAuthProbeFresh([row(now - (AUTH_PROBE_MAX_AGE_MS + 60_000))], now, only1_0_0)).toBe(false);
  });

  it('never reuses an empty cache (nothing to reuse — must probe)', () => {
    expect(isCachedFleetAuthProbeFresh([], now, only1_0_0)).toBe(false);
  });

  it('re-probes when ANY row is stale, so one aged account cannot pin the rest to a stale verdict', () => {
    expect(isCachedFleetAuthProbeFresh([row(now - 60_000), row(now - (AUTH_PROBE_MAX_AGE_MS + 1), '1.1.0')], now, installed('1.0.0', '1.1.0'))).toBe(false);
  });

  // force=true is the on-demand `agents devices ping [--strict]` contract and must never reuse the
  // throttled cached verdict, or --strict silently passes a revoked account still inside the
  // 20-minute window (RUSH-2998).
  it('force always re-probes, even against a perfectly fresh cache', () => {
    const freshCache = [row(now - 60_000)];
    expect(shouldReuseCachedAuthProbe(false, freshCache, now, only1_0_0)).toBe(true);  // periodic tick reuses
    expect(shouldReuseCachedAuthProbe(true, freshCache, now, only1_0_0)).toBe(false);  // on-demand ping re-probes
  });

  it('force never rescues an empty or stale cache into a reuse either', () => {
    expect(shouldReuseCachedAuthProbe(true, [], now, only1_0_0)).toBe(false);
    expect(shouldReuseCachedAuthProbe(false, [], now, only1_0_0)).toBe(false);
    expect(shouldReuseCachedAuthProbe(false, [row(now - (AUTH_PROBE_MAX_AGE_MS + 1))], now, only1_0_0)).toBe(false);
  });

  // PHNX-4051: the cache keeps a row per probed (agent, version) home and nothing deletes one on
  // uninstall, so its checkedAt freezes. Counting it made the predicate permanently false, so the
  // tick live-probed /api/oauth/usage forever, re-arming the 429 park (RUSH-2998).
  describe('orphan rows for uninstalled versions (PHNX-4051)', () => {
    const weeksOld = now - 9 * 24 * 60 * 60_000;

    it('does not defeat reuse when every INSTALLED row is fresh', () => {
      const cached = [row(now - 5 * 60_000, '1.0.0'), row(weeksOld, '0.9.0')];
      expect(isCachedFleetAuthProbeFresh(cached, now, only1_0_0)).toBe(true);
      expect(shouldReuseCachedAuthProbe(false, cached, now, only1_0_0)).toBe(true);
    });

    it('a STALE row for an installed version still forces a re-probe', () => {
      const cached = [row(now - 5 * 60_000, '1.0.0'), row(now - (AUTH_PROBE_MAX_AGE_MS + 1), '1.1.0'), row(weeksOld, '0.9.0')];
      expect(isCachedFleetAuthProbeFresh(cached, now, installed('1.0.0', '1.1.0'))).toBe(false);
      expect(shouldReuseCachedAuthProbe(false, cached, now, installed('1.0.0', '1.1.0'))).toBe(false);
    });

    it('a cache of nothing but orphans is never reused — there is no live verdict to reuse', () => {
      expect(isCachedFleetAuthProbeFresh([row(now - 60_000, '0.9.0')], now, only1_0_0)).toBe(false);
    });

    it('installedAuthRows keeps installed rows and drops orphans, matching on agent AND version', () => {
      const cached = [row(now, '1.0.0'), row(now, '0.9.0'), { ...row(now, '1.0.0'), agent: 'kimi' as const }];
      expect(installedAuthRows(cached, only1_0_0).map((r) => `${r.agent}@${r.version}`)).toEqual(['claude@1.0.0']);
    });
  });
});

/** PHNX-4051, other half: an orphan must also leave the cache, or `agents view` and fleet status
 * keep rendering a verdict for a gone version. Real cache file and lock, hermetic HOME
 * (tests/setup.ts). */
describe('writeFleetAuthRows prunes this host\'s orphan rows (PHNX-4051)', () => {
  const health = (checkedAt: number) => ({ verdict: 'live' as const, checkedAt });
  const probed = (version: string, checkedAt: number): AuthProbeRow => ({ agent: 'claude', version, health: health(checkedAt) });

  it('drops rows whose (agent, version) home is gone, keeps the installed ones and other hosts', () => {
    const self = machineId();
    const now = Date.now();
    // Seed the cache the way a box that has uninstalled two versions looks.
    writeAuthHealthEntries({
      [authCacheKey(self, 'claude', '1.0.0')]: health(now - 40 * 60_000),
      [authCacheKey(self, 'claude', '0.9.0')]: health(now - 9 * 24 * 60 * 60_000),
      [authCacheKey(self, 'claude', 'slot:gone')]: health(now - 5 * 24 * 60 * 60_000),
      [authCacheKey('peer-box', 'claude', '0.9.0')]: health(now - 9 * 24 * 60 * 60_000),
    });

    writeFleetAuthRows(self, [probed('1.0.0', now)], new Set([authTargetKey('claude', '1.0.0')]));

    expect(readFleetAuthRows(self).map((r) => r.version).sort()).toEqual(['1.0.0']);
    expect(readFleetAuthRows(self)[0]!.health.checkedAt).toBe(now);
    // A peer's rows are written by the fleet-ping fan-out, which cannot enumerate
    // that box's homes — pruning this host must never touch them.
    expect(readFleetAuthRows('peer-box').map((r) => r.version)).toEqual(['0.9.0']);
  });

  it('without an installed set (the peer fan-out) it merges as before and deletes nothing', () => {
    const now = Date.now();
    writeAuthHealthEntries({ [authCacheKey('peer-two', 'claude', '0.9.0')]: health(now - 60_000) });
    writeFleetAuthRows('peer-two', [probed('1.0.0', now)]);
    expect(readFleetAuthRows('peer-two').map((r) => r.version).sort()).toEqual(['0.9.0', '1.0.0']);
  });
});

describe('runActiveSessionsWarmTick', () => {
  let dir: string;
  let prevSnap: string | null;
  let prevImm: string | null;
  let prevPresence: string | null;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'active-warm-'));
    prevSnap = setActiveSessionsSnapshotPathForTest(path.join(dir, 'snap.json'));
    prevImm = setImmutableMemoPathForTest(path.join(dir, 'imm.json'));
    prevPresence = setActiveSessionsReaderPresencePathForTest(path.join(dir, 'reader.presence'));
  });

  afterEach(() => {
    setActiveSessionsSnapshotPathForTest(prevSnap);
    setImmutableMemoPathForTest(prevImm);
    setActiveSessionsReaderPresencePathForTest(prevPresence);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('publishes a local active-sessions snapshot when a reader is present', async () => {
    noteActiveSessionsJournalReader();
    const r = await runActiveSessionsWarmTick({ gather: async () => [] });
    expect(r.sessions).toBe(0);
    const cached = readActiveSessionsCache('local');
    expect(cached).not.toBeNull();
    expect(cached!.sessions).toEqual([]);
    const journal = fs.readFileSync(path.join(dir, 'snap.json.journal.jsonl'), 'utf8').trim().split('\n');
    expect(journal.length).toBeGreaterThanOrEqual(1);
    expect(JSON.parse(journal.at(-1)!)).toMatchObject({ version: 1, scope: 'local', upserts: [], removes: [] });
  });

  it('gathers exactly ONCE per tick', async () => {
    // The tick is gather, fold timelines, publish (PHNX-3939). The publish must not re-gather: a
    // second live gather is ~9s of `ps`/`lsof` and would fold the published row from a different
    // snapshot than it carries.
    noteActiveSessionsJournalReader();
    let gathers = 0;
    await runActiveSessionsWarmTick({ gather: async () => { gathers++; return []; } });
    expect(gathers).toBe(1);
  });

  it('skips the gather when no reader has checked in (idle box)', async () => {
    let gatherCalled = false;
    const r = await runActiveSessionsWarmTick({ gather: async () => { gatherCalled = true; return []; } });
    expect(r.sessions).toBe(0);
    expect(gatherCalled).toBe(false);
    // Snapshot must remain absent — the gather was skipped entirely.
    expect(readActiveSessionsCache('local')).toBeNull();
  });

  it('skips the gather when the reader presence is older than the idle window', async () => {
    const staleTs = Date.now() - ACTIVE_SESSIONS_READER_IDLE_WINDOW_MS - 1_000;
    fs.writeFileSync(path.join(dir, 'reader.presence'), String(staleTs));
    let gatherCalled = false;
    const r = await runActiveSessionsWarmTick({ gather: async () => { gatherCalled = true; return []; } });
    expect(r.sessions).toBe(0);
    expect(gatherCalled).toBe(false);
  });

  it('gathers immediately after a reader signals presence mid-idle', async () => {
    // First tick — idle, no gather.
    const r1 = await runActiveSessionsWarmTick({ gather: async () => [] });
    expect(r1.sessions).toBe(0);
    expect(readActiveSessionsCache('local')).toBeNull();

    // Reader connects and notes itself.
    noteActiveSessionsJournalReader();

    // Next tick — gathers and publishes.
    let gatherCalled = false;
    const r2 = await runActiveSessionsWarmTick({ gather: async () => { gatherCalled = true; return []; } });
    expect(r2.sessions).toBe(0);
    expect(gatherCalled).toBe(true);
    expect(readActiveSessionsCache('local')).not.toBeNull();
  });
});

describe('isActiveSessionsJournalReaderRecent', () => {
  let dir: string;
  let prevPresence: string | null;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reader-presence-'));
    prevPresence = setActiveSessionsReaderPresencePathForTest(path.join(dir, 'reader.presence'));
  });

  afterEach(() => {
    setActiveSessionsReaderPresencePathForTest(prevPresence);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('returns false when no presence file exists', () => {
    expect(isActiveSessionsJournalReaderRecent()).toBe(false);
  });

  it('returns true for a freshly written presence', () => {
    noteActiveSessionsJournalReader();
    expect(isActiveSessionsJournalReaderRecent()).toBe(true);
  });

  it('returns false when the presence is older than the idle window', () => {
    const staleTs = Date.now() - ACTIVE_SESSIONS_READER_IDLE_WINDOW_MS - 1_000;
    fs.writeFileSync(path.join(dir, 'reader.presence'), String(staleTs));
    expect(isActiveSessionsJournalReaderRecent()).toBe(false);
  });

  it('returns true for a presence written just inside the idle window', () => {
    const freshTs = Date.now() - ACTIVE_SESSIONS_READER_IDLE_WINDOW_MS + 5_000;
    fs.writeFileSync(path.join(dir, 'reader.presence'), String(freshTs));
    expect(isActiveSessionsJournalReaderRecent()).toBe(true);
  });

  it('returns false for corrupt content', () => {
    fs.writeFileSync(path.join(dir, 'reader.presence'), 'not-a-number');
    expect(isActiveSessionsJournalReaderRecent()).toBe(false);
  });
});

// `runSessionIndexWarmTick` is covered by daemon-ticks.session-index.test.ts,
// which must redirect HOME before the session modules load (they capture it at
// import time) — so it needs its own file rather than a suite here.

describe('runUsageRefreshTick — every host is its own publisher (RUSH-3193 #15)', () => {
  it('runs the local refresh unconditionally, with no primary/subscriber envelope in its report', async () => {
    const logs: string[] = [];
    const originalLog = console.log;
    console.log = (msg: string) => { logs.push(String(msg)); };
    try {
      await runUsageRefreshTick();
    } finally {
      console.log = originalLog;
    }
    const line = logs.find((l) => l.startsWith('usage refresh:'));
    expect(line).toBeDefined();
    // The old envelope-shaped report ("imported N account(s) from primary host
    // X" or "published N account(s)") is gone — this host always ran its own
    // local refresh, never a cross-host import.
    expect(line).not.toMatch(/imported \d+ account\(s\) from primary host/);
    expect(line).not.toMatch(/published \d+ account\(s\)/);
    expect(line).toMatch(/refreshed, .* failed, .* not-due, .* backed-off, .* capped, .* over-budget, .* statusline-fresh; BYOK/);
  });
});
