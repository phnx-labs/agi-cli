import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { claudeProjectDirName } from '../project-key.js';
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

describe('warm-cache tick keeps a resumed session (PHNX-4326)', () => {
  const posixOnly = process.platform === 'win32' ? it.skip : it;
  const UUID = '9ff4d220-6b1e-4c41-9b0e-3f2b8a4d7c11';
  let child: ChildProcess | undefined;
  let dir: string | undefined;

  afterEach(() => {
    if (child?.pid) {
      try { process.kill(child.pid, 'SIGKILL'); } catch {  }
    }
    child = undefined;
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  posixOnly('stamps the row with the process start, so a transcript older than its process survives the cached tick', async (ctx) => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'phnx-4326-'));
    const cwd = fs.realpathSync(dir);
    const projectDir = path.join(process.env.HOME!, '.claude', 'projects', claudeProjectDirName(cwd));
    fs.mkdirSync(projectDir, { recursive: true });
    const transcript = path.join(projectDir, `${UUID}.jsonl`);
    fs.writeFileSync(transcript, `${JSON.stringify({ type: 'user', sessionId: UUID, cwd, message: { role: 'user', content: 'resume me' } })}\n`);
    const twoDaysAgo = (Date.now() - 2 * 86_400_000) / 1000;
    fs.utimesSync(transcript, twoDaysAgo, twoDaysAgo);
    fs.utimesSync(transcript, new Date(), new Date());
    await new Promise((r) => setTimeout(r, 2_100));

    const bin = path.join(cwd, 'claude');
    try { fs.linkSync(process.execPath, bin); } catch { fs.copyFileSync(process.execPath, bin); fs.chmodSync(bin, 0o755); }
    child = spawn(bin, ['-e', 'setInterval(() => {}, 60_000)', '--', '--session-id', UUID], { cwd, stdio: 'ignore' });
    const pid = child.pid!;

    let t = 5_000_000;
    setActiveScanClockForTest(() => t);
    let row: ActiveSession | undefined;
    const deadline = Date.now() + 10_000;
    while (!row && Date.now() < deadline) {
      clearActiveScanCachesForTest();
      setActiveScanClockForTest(() => t);
      row = (await listUnattributedActive(new Set())).find((s) => s.pid === pid && s.sessionFile === transcript);
      if (!row) await new Promise((r) => setTimeout(r, 100));
    }
    if (!row) {
      ctx.skip(`ps never classified pid ${pid} as claude or its cwd did not resolve - see RUSH-2508`);
      return;
    }
    const lstart = execFileSync('ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8' }).trim();
    expect(row.startedAtMs).toBe(Date.parse(lstart));
    expect(row.startedAtMs).toBeGreaterThan(fs.statSync(transcript).birthtimeMs);

    const scans = unattributedFullRescanCountForTest();
    t += 1_000;
    const warm = await listUnattributedActive(new Set());
    expect(unattributedFullRescanCountForTest()).toBe(scans);
    expect(warm.find((s) => s.pid === pid)?.sessionId).toBe(UUID);
  });
});
