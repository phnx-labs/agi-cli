import { describe, it, expect, afterEach } from 'vitest';
import {
  PROCESS_TABLE_FRESH_MS,
  UNATTRIBUTED_RESCAN_MS,
  attributedSetLostPids,
  filterCachedUnattributed,
  clearActiveScanCachesForTest,
  setActiveScanClockForTest,
  processTableLiveReadCountForTest,
  unattributedFullRescanCountForTest,
  listUnattributedActive,
  hostFromPid,
  type ActiveSession,
} from './active.js';

afterEach(() => {
  clearActiveScanCachesForTest();
});

describe('attributedSetLostPids', () => {
  it('is false when next is a superset of prev', () => {
    expect(attributedSetLostPids(new Set([1, 2]), new Set([1, 2, 3]))).toBe(false);
    expect(attributedSetLostPids(new Set([1]), new Set([1]))).toBe(false);
    expect(attributedSetLostPids(new Set(), new Set([1]))).toBe(false);
  });

  it('is true when any prev pid is missing from next', () => {
    expect(attributedSetLostPids(new Set([1, 2]), new Set([1]))).toBe(true);
    expect(attributedSetLostPids(new Set([5]), new Set())).toBe(true);
  });
});

describe('filterCachedUnattributed', () => {
  const row = (pid: number): ActiveSession => ({
    context: 'headless',
    kind: 'claude',
    status: 'running',
    pid,
  });

  it('drops attributed and dead pids; keeps live unattributed', () => {
    const sessions = [row(10), row(20), row(30)];
    const attributed = new Set([20]);
    const alive = (pid: number) => pid !== 30;
    const out = filterCachedUnattributed(sessions, attributed, alive);
    expect(out.map((s) => s.pid)).toEqual([10]);
  });

  it('passes startedAtMs to the alive predicate (pid-reuse guard)', () => {
    const sessions: ActiveSession[] = [
      { context: 'headless', kind: 'claude', status: 'running', pid: 42, startedAtMs: 1_700_000_000_000 },
    ];
    const seen: Array<{ pid: number; startedAtMs?: number }> = [];
    filterCachedUnattributed(sessions, new Set(), (pid, startedAtMs) => {
      seen.push({ pid, startedAtMs });
      return true;
    });
    expect(seen).toEqual([{ pid: 42, startedAtMs: 1_700_000_000_000 }]);
  });

  it('drops a cached child when its shell becomes attributed', () => {
    const rows = [{ context: 'headless' as const, kind: 'claude', pid: 21, status: 'running' as const }];
    expect(filterCachedUnattributed(rows, new Set([10]), () => true, new Map([[21, 20], [20, 10]]))).toEqual([]);
  });

  it('drops rows with no pid', () => {
    const sessions: ActiveSession[] = [
      { context: 'headless', kind: 'claude', status: 'running' },
      row(11),
    ];
    expect(filterCachedUnattributed(sessions, new Set(), () => true).map((s) => s.pid)).toEqual([11]);
  });
});

describe('process-table memo (#2047)', () => {
  it('reuses one live ps/CIM snapshot across callers within PROCESS_TABLE_FRESH_MS', async () => {
    let t = 1_000_000;
    setActiveScanClockForTest(() => t);
    clearActiveScanCachesForTest();
    setActiveScanClockForTest(() => t);

    await hostFromPid(process.pid);
    const afterFirst = processTableLiveReadCountForTest();
    expect(afterFirst).toBeGreaterThanOrEqual(1);

    await hostFromPid(process.pid);
    expect(processTableLiveReadCountForTest()).toBe(afterFirst);

    t += PROCESS_TABLE_FRESH_MS + 1;
    await hostFromPid(process.pid);
    expect(processTableLiveReadCountForTest()).toBe(afterFirst + 1);
  });
});

describe('unattributed rescan throttle (#2047)', () => {
  it('reuses the last full scan within UNATTRIBUTED_RESCAN_MS when attributed did not shrink', async () => {
    let t = 2_000_000;
    setActiveScanClockForTest(() => t);

    const first = await listUnattributedActive(new Set());
    expect(unattributedFullRescanCountForTest()).toBe(1);
    expect(Array.isArray(first)).toBe(true);

    const second = await listUnattributedActive(new Set());
    expect(unattributedFullRescanCountForTest()).toBe(1);
    const firstPids = new Set(first.map((s) => s.pid));
    for (const s of second) {
      expect(firstPids.has(s.pid)).toBe(true);
    }

    const processReads = processTableLiveReadCountForTest();
    t += PROCESS_TABLE_FRESH_MS + 1;
    await listUnattributedActive(new Set());
    expect(processTableLiveReadCountForTest()).toBe(processReads);

    const samplePid = first.find((s) => s.pid != null)?.pid;
    if (samplePid != null) {
      const filtered = await listUnattributedActive(new Set([samplePid]));
      expect(unattributedFullRescanCountForTest()).toBe(1);
      expect(filtered.some((s) => s.pid === samplePid)).toBe(false);
    }

    t += UNATTRIBUTED_RESCAN_MS + 1;
    await listUnattributedActive(new Set());
    expect(unattributedFullRescanCountForTest()).toBe(2);
  });

  it('forces a full rescan when the attributed set loses a pid', async () => {
    let t = 3_000_000;
    setActiveScanClockForTest(() => t);

    await listUnattributedActive(new Set([999_001, 999_002]));
    expect(unattributedFullRescanCountForTest()).toBe(1);

    await listUnattributedActive(new Set([999_001]));
    expect(unattributedFullRescanCountForTest()).toBe(2);
  });
});
