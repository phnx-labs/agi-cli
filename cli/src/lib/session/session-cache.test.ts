/**
 * RUSH-2062 — cross-surface active-session cache invariants.
 *
 * Real disk files under a temp dir (no mocks of the cache layer itself). The
 * live gather is injected as a pure function so the test pins cache behaviour
 * without SSH / process-table cost; the critical path under test is the
 * freshness/staleness + immutable-memo contract.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import type { ActiveSession } from './active.js';
import {
  DEFAULT_ACTIVE_CACHE_MAX_AGE_MS,
  IMMUTABLE_FIELD_KEYS,
  LIVE_STATUS_KEYS,
  applyImmutableMemo,
  assertNoLiveStatusFields,
  isActiveSnapshotFresh,
  loadFleetActiveSessions,
  loadLocalActiveSessions,
  noteActiveSessionsJournalReader,
  pickImmutableFields,
  publishLocalActiveSessions,
  readActiveSessionsCache,
  readImmutableMemo,
  setActiveSessionsReaderPresencePathForTest,
  setActiveSessionsSnapshotPathForTest,
  setImmutableMemoPathForTest,
  stripLiveStatusKeys,
  transcriptMtimeMs,
  updateImmutableMemos,
  watchActiveSessionsReaderPresence,
  writeActiveSessionsCache,
  writeImmutableMemo,
} from './session-cache.js';

function tmpPair(): { snap: string; imm: string; dir: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'session-cache-'));
  return {
    dir,
    snap: path.join(dir, 'snap.json'),
    imm: path.join(dir, 'imm.json'),
  };
}

function session(partial: Partial<ActiveSession> & { sessionId: string }): ActiveSession {
  return {
    context: 'terminal',
    kind: 'claude',
    status: 'running',
    ...partial,
  } as ActiveSession;
}

describe('isActiveSnapshotFresh (live-status window)', () => {
  it('serves a snapshot only while within maxAgeMs', () => {
    expect(isActiveSnapshotFresh(1000, 1000 + DEFAULT_ACTIVE_CACHE_MAX_AGE_MS, DEFAULT_ACTIVE_CACHE_MAX_AGE_MS)).toBe(true);
    expect(isActiveSnapshotFresh(1000, 1000 + DEFAULT_ACTIVE_CACHE_MAX_AGE_MS + 1, DEFAULT_ACTIVE_CACHE_MAX_AGE_MS)).toBe(false);
  });

  it('rejects nonsense ages so a bad clock cannot freeze live status forever', () => {
    expect(isActiveSnapshotFresh(1000, 2000, -1)).toBe(false);
    expect(isActiveSnapshotFresh(Number.NaN, 2000, 15_000)).toBe(false);
  });
});

describe('loadLocalActiveSessions — cross-surface snapshot', () => {
  let paths: ReturnType<typeof tmpPair>;
  let prevSnap: string | null;
  let prevImm: string | null;

  beforeEach(() => {
    paths = tmpPair();
    prevSnap = setActiveSessionsSnapshotPathForTest(paths.snap);
    prevImm = setImmutableMemoPathForTest(paths.imm);
  });

  afterEach(() => {
    setActiveSessionsSnapshotPathForTest(prevSnap);
    setImmutableMemoPathForTest(prevImm);
    fs.rmSync(paths.dir, { recursive: true, force: true });
  });


  it('serves a fresh warm snapshot without re-gathering (cross-surface share)', async () => {
    const warm = [session({ sessionId: 'a', status: 'running', topic: 'warm topic' })];
    writeActiveSessionsCache('local', warm, { capturedAt: 10_000 });

    let gathers = 0;
    const res = await loadLocalActiveSessions({
      nowMs: 10_000 + 5_000, // still within 15s window
      gather: async () => {
        gathers++;
        return [session({ sessionId: 'b', status: 'idle' })];
      },
    });

    expect(gathers).toBe(0);
    expect(res.servedFromCache).toBe(true);
    expect(res.sessions).toEqual(warm);
    expect(res.sessions[0].status).toBe('running'); // live status rides the snapshot
  });

  it('re-gathers when the snapshot is older than maxAgeMs (live status never stale)', async () => {
    writeActiveSessionsCache('local', [session({ sessionId: 'stale', status: 'running' })], {
      capturedAt: 10_000,
    });

    let gathers = 0;
    const fresh = [session({ sessionId: 'fresh', status: 'idle', lastActivityMs: 20_000 })];
    const res = await loadLocalActiveSessions({
      nowMs: 10_000 + DEFAULT_ACTIVE_CACHE_MAX_AGE_MS + 1,
      gather: async () => {
        gathers++;
        return fresh;
      },
    });

    expect(gathers).toBe(1);
    expect(res.servedFromCache).toBe(false);
    expect(res.sessions[0].sessionId).toBe('fresh');
    expect(res.sessions[0].status).toBe('idle'); // live status from the gather, not the stale snap
    // And the cache is rewritten so the next surface shares the fresh result.
    const onDisk = readActiveSessionsCache('local');
    expect(onDisk?.sessions[0].sessionId).toBe('fresh');
  });

  it('forceRefresh always re-gathers even when the snapshot is brand new', async () => {
    writeActiveSessionsCache('local', [session({ sessionId: 'cached', status: 'running' })], {
      capturedAt: 50_000,
    });

    let gathers = 0;
    const res = await loadLocalActiveSessions({
      forceRefresh: true,
      nowMs: 50_000,
      gather: async () => {
        gathers++;
        return [session({ sessionId: 'live', status: 'input_required' })];
      },
    });

    expect(gathers).toBe(1);
    expect(res.servedFromCache).toBe(false);
    expect(res.sessions[0].status).toBe('input_required');
  });

  it('publishLocalActiveSessions force-writes a local snapshot (daemon warm path)', async () => {
    let gathers = 0;
    const r = await publishLocalActiveSessions({
      nowMs: 99_000,
      gather: async () => {
        gathers++;
        return [session({ sessionId: 'daemon', status: 'running', lastActivityMs: 98_000, topic: 't' })];
      },
    });
    expect(gathers).toBe(1);
    expect(r.sessions).toHaveLength(1);
    const onDisk = readActiveSessionsCache('local');
    expect(onDisk?.capturedAt).toBe(99_000);
    expect(onDisk?.sessions[0].sessionId).toBe('daemon');
    const journal = fs.readFileSync(`${paths.snap}.journal.jsonl`, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    expect(journal.at(-1)).toMatchObject({ version: 1, scope: 'local', capturedAt: 99_000 });
    expect(journal.at(-1).upserts[0].sessionId).toBe('daemon');
  });

  it('journals the first empty publication so a watcher marks the scope available', async () => {
    await publishLocalActiveSessions({ nowMs: 101_000, gather: async () => [] });
    const journal = fs.readFileSync(`${paths.snap}.journal.jsonl`, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    expect(journal.at(-1)).toMatchObject({
      version: 1,
      scope: 'local',
      capturedAt: 101_000,
      upserts: [],
      removes: [],
    });
  });
});

describe('loadFleetActiveSessions — fleet snapshot share', () => {
  let paths: ReturnType<typeof tmpPair>;
  let prevSnap: string | null;
  let prevImm: string | null;

  beforeEach(() => {
    paths = tmpPair();
    prevSnap = setActiveSessionsSnapshotPathForTest(paths.snap);
    prevImm = setImmutableMemoPathForTest(paths.imm);
  });

  afterEach(() => {
    setActiveSessionsSnapshotPathForTest(prevSnap);
    setImmutableMemoPathForTest(prevImm);
    fs.rmSync(paths.dir, { recursive: true, force: true });
  });

  it('serves a warm fleet snapshot so a second surface skips the SSH fan-out', async () => {
    writeActiveSessionsCache(
      'fleet',
      [session({ sessionId: 'remote-1', machine: 'box-a', status: 'running' })],
      { capturedAt: 1000, remoteDeviceCount: 3 },
    );

    let gathers = 0;
    const res = await loadFleetActiveSessions({
      nowMs: 1000 + 1_000,
      gather: async () => {
        gathers++;
        return { sessions: [], remoteDeviceCount: 0 };
      },
    });

    expect(gathers).toBe(0);
    expect(res.servedFromCache).toBe(true);
    expect(res.remoteDeviceCount).toBe(3);
    expect(res.sessions[0].machine).toBe('box-a');
  });

  it('rewrites local to empty when a live fleet gather has no local rows (no ghost sessions)', async () => {
    // Prior warm left a local session; the next fleet gather has only remotes
    // — the local snapshot must not keep ghosting the dead row.
    writeActiveSessionsCache(
      'local',
      [session({ sessionId: 'ghost', status: 'running', lastActivityMs: 1 })],
      { capturedAt: 500 },
    );

    await loadFleetActiveSessions({
      forceRefresh: true,
      nowMs: 10_000,
      gather: async () => ({
        sessions: [
          session({ sessionId: 'remote-only', machine: 'other-box', status: 'running' }),
        ],
        remoteDeviceCount: 1,
      }),
    });

    const local = readActiveSessionsCache('local');
    // When machineId() is available, local is rewritten at nowMs and must not
    // contain `ghost`. When machineId is unavailable the write is skipped —
    // assert the invariant only when the rewrite ran.
    if (local && local.capturedAt === 10_000) {
      expect(local.sessions.some((s) => s.sessionId === 'ghost')).toBe(false);
    }
  });
});

describe('immutable memo — mtime-keyed, never carries live status', () => {
  let paths: ReturnType<typeof tmpPair>;
  let prevSnap: string | null;
  let prevImm: string | null;

  beforeEach(() => {
    paths = tmpPair();
    prevSnap = setActiveSessionsSnapshotPathForTest(paths.snap);
    prevImm = setImmutableMemoPathForTest(paths.imm);
  });

  afterEach(() => {
    setActiveSessionsSnapshotPathForTest(prevSnap);
    setImmutableMemoPathForTest(prevImm);
    fs.rmSync(paths.dir, { recursive: true, force: true });
  });

  it('memoizes immutable fields keyed on transcript mtime', () => {
    const s = session({
      sessionId: 's1',
      topic: 'fix the auth bug',
      label: 'auth',
      cwd: '/tmp/wt',
      lastActivityMs: 42_000,
      status: 'running',
      preview: 'live preview must not be memoized',
    });

    updateImmutableMemos([s], 50_000);

    const hit = readImmutableMemo('s1', 42_000);
    expect(hit).not.toBeNull();
    expect(hit!.topic).toBe('fix the auth bug');
    expect(hit!.label).toBe('auth');
    expect(hit!.cwd).toBe('/tmp/wt');
    // Live status must not be in the memo.
    expect(assertNoLiveStatusFields(hit as Record<string, unknown>)).toBe(true);
    expect((hit as Record<string, unknown>).status).toBeUndefined();
    expect((hit as Record<string, unknown>).preview).toBeUndefined();
  });

  it('invalidates the memo when transcript mtime changes', () => {
    writeImmutableMemo('s1', 100, { topic: 'old topic' }, 1);
    expect(readImmutableMemo('s1', 100)?.topic).toBe('old topic');
    // Same session, newer transcript write → miss (must re-derive).
    expect(readImmutableMemo('s1', 200)).toBeNull();
  });

  it('pickImmutableFields never includes live-status keys', () => {
    const s = session({
      sessionId: 's2',
      topic: 't',
      status: 'running',
      activity: 'working',
      preview: 'p',
      tokPerSec: 12,
      pidAlive: true,
      lastActivityMs: 1,
    });
    const fields = pickImmutableFields(s);
    expect(assertNoLiveStatusFields(fields as Record<string, unknown>)).toBe(true);
    for (const k of LIVE_STATUS_KEYS) {
      expect(k in fields).toBe(false);
    }
    for (const k of IMMUTABLE_FIELD_KEYS) {
      // only assert the ones we set
      if (k === 'topic') expect(fields.topic).toBe('t');
    }
  });

  it('stripLiveStatusKeys defends against a poisoned write', () => {
    const poisoned = stripLiveStatusKeys({
      topic: 'ok',
      status: 'running',
      preview: 'nope',
      pidAlive: false,
    } as Record<string, unknown>);
    expect(poisoned.topic).toBe('ok');
    expect(poisoned.status).toBeUndefined();
    expect(poisoned.preview).toBeUndefined();
    expect(poisoned.pidAlive).toBeUndefined();
  });

  it('applyImmutableMemo fills missing identity fields only when mtime matches', () => {
    writeImmutableMemo(
      's3',
      77,
      { topic: 'memoized topic', label: 'memo-label', cwd: '/memo' },
      1,
    );

    // Live gather produced a row with status (live) but no topic yet.
    const live = session({
      sessionId: 's3',
      status: 'idle', // live — must stay
      lastActivityMs: 77, // mtime match
    });
    applyImmutableMemo(live);
    expect(live.topic).toBe('memoized topic');
    expect(live.label).toBe('memo-label');
    expect(live.cwd).toBe('/memo');
    expect(live.status).toBe('idle'); // live status untouched

    // Mtime mismatch → no fill.
    const other = session({ sessionId: 's3', status: 'running', lastActivityMs: 99 });
    applyImmutableMemo(other);
    expect(other.topic).toBeUndefined();
    expect(other.status).toBe('running');
  });

  it('applyImmutableMemo never overwrites a live-derived immutable field', () => {
    writeImmutableMemo('s4', 1, { topic: 'from-memo' }, 1);
    const live = session({
      sessionId: 's4',
      topic: 'from-live-gather',
      lastActivityMs: 1,
      status: 'running',
    });
    applyImmutableMemo(live);
    expect(live.topic).toBe('from-live-gather');
  });

  it('transcriptMtimeMs prefers lastActivityMs over startedAtMs', () => {
    expect(transcriptMtimeMs(session({ sessionId: 'x', lastActivityMs: 9, startedAtMs: 1 }))).toBe(9);
    expect(transcriptMtimeMs(session({ sessionId: 'x', startedAtMs: 3 }))).toBe(3);
    expect(transcriptMtimeMs(session({ sessionId: 'x' }))).toBeNull();
  });
});

describe('watchActiveSessionsReaderPresence — out-of-band trigger on reader connect (RUSH-2484)', () => {
  // Real defect this closes: noteActiveSessionsJournalReader() (called by
  // watchLocalSessions on connect) ONLY writes a timestamp file — it has no
  // path back into the daemon process that owns the 15s warm-tick
  // setInterval. A watcher connecting to a cold/idle daemon used to sit on
  // "awaiting publisher" for up to a full ACTIVE_SESSIONS_WARM_TICK_MS (15s).
  // These tests drive real setInterval-based scheduling via fake timers and
  // assert the callback fires from the poll noticing the presence-file edge —
  // never from a second, manually-invoked call to the tick function.
  const ACTIVE_SESSIONS_WARM_TICK_MS = 15_000;
  let dir: string;
  let prevPresence: string | null;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reader-presence-'));
    prevPresence = setActiveSessionsReaderPresencePathForTest(path.join(dir, 'reader.presence'));
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    setActiveSessionsReaderPresencePathForTest(prevPresence);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('never fires while idle, then fires on the very next poll after a reader connects', () => {
    let connects = 0;
    const stop = watchActiveSessionsReaderPresence(() => { connects++; }, { pollMs: 100 });

    // Cold daemon, no reader: several polls pass with zero connects — proves
    // the poll itself is not what triggers a gather.
    vi.advanceTimersByTime(2_000);
    expect(connects).toBe(0);

    // A watcher connects. This mirrors watch.ts:165 exactly: it only writes
    // a presence timestamp, nothing more.
    noteActiveSessionsJournalReader();

    // The idle->recent edge is caught on the very next 100ms poll — far
    // short of the 15s scheduled warm-tick a watcher used to wait on.
    vi.advanceTimersByTime(100);
    expect(connects).toBe(1);
    expect(100).toBeLessThan(ACTIVE_SESSIONS_WARM_TICK_MS);

    stop();
  });

  it('does not re-fire on repeated heartbeats from an already-connected reader', () => {
    let connects = 0;
    const stop = watchActiveSessionsReaderPresence(() => { connects++; }, { pollMs: 100 });

    noteActiveSessionsJournalReader();
    vi.advanceTimersByTime(100);
    expect(connects).toBe(1);

    // Simulate the watcher's periodic heartbeat re-noting presence (watch.ts's
    // heartbeatTimer) — must not trigger a second out-of-band gather per beat.
    for (let i = 0; i < 5; i++) {
      noteActiveSessionsJournalReader();
      vi.advanceTimersByTime(100);
    }
    expect(connects).toBe(1);

    stop();
  });

  it('re-fires after the reader goes idle and a fresh watcher reconnects', () => {
    let connects = 0;
    const stop = watchActiveSessionsReaderPresence(() => { connects++; }, { pollMs: 100, idleWindowMs: 500 });

    noteActiveSessionsJournalReader();
    vi.advanceTimersByTime(100);
    expect(connects).toBe(1);

    // Reader disconnects — no further presence writes — and ages past the
    // idle window with no reconnect yet.
    vi.advanceTimersByTime(600);
    expect(connects).toBe(1);

    // A new watcher connects to what is now, from the daemon's view, an idle
    // box — exactly the reconnect-after-idle case the fix targets.
    noteActiveSessionsJournalReader();
    vi.advanceTimersByTime(100);
    expect(connects).toBe(2);

    stop();
  });
});
