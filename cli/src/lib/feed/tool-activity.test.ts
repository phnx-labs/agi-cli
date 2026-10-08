import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { collectToolRows, linkToolSessions, readLiveBrowserTasks, readStandaloneComputerRows, readToolJson, watchToolActivity, ToolRowSet, type ToolDiff } from './tool-activity.js';
import type { BrowserSessionRow, ComputerRunRow, ToolRow } from './tools.js';
import { _resetBrowserClientForTest } from '../browser-client.js';
import { _resetComputerClientForTest } from '../computer-client.js';
import { getSessionsDir } from '../state.js';
import { upsertSession } from '../session/db.js';

const roots: string[] = [];
function tempRoot(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tool-activity-'));
  roots.push(dir);
  return dir;
}
afterEach(() => { for (const dir of roots.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });

function browserRow(task: string, mtimeMs: number, captures = 1): BrowserSessionRow {
  return {
    kind: 'task', profile: 'work', task,
    artifacts: Array.from({ length: captures }, (_, i) => (
      { kind: 'screenshot' as const, task, name: `c${i}.png`, path: `/caps/${task}/c${i}.png`, bytes: 1, mtimeMs: mtimeMs - i }
    )),
    counts: { screenshot: captures, pdf: 0, recording: 0, download: 0 },
    latestMtimeMs: mtimeMs,
  };
}

function computerRow(invocationId: string, endMs: number): ComputerRunRow {
  return {
    invocationId, machine: 'm1',
    actions: [{ verb: 'click', tsMs: endMs }],
    counts: { click: 1 }, startMs: endMs - 10, endMs,
  };
}

async function until(what: string, predicate: () => boolean, timeoutMs = 4_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`timed out waiting for ${what}`);
}

describe('tool activity collection over real directories', () => {
  it('collects both kinds and binds liveness from the task index', async () => {
    const { rows, incomplete } = await collectToolRows('m1', {
      browserRows: () => [browserRow('post', 3_000), browserRow('stale', 1_000)],
      computerRows: () => [computerRow('inv-1', 2_000)],
      bindings: () => [{ name: 'post', device: 'm1', url: 'https://example.com/', createdAt: 100 }],
      liveTasks: () => [],
    });
    expect(incomplete).toEqual([]);
    expect(rows.map((row) => [row.kind, row.task, row.live])).toEqual([
      ['browser', 'post', true],
      ['computer', undefined, false],
      ['browser', 'stale', false],
    ]);
  });

  it('survives a source that throws, keeps the other kind, and names the incomplete kind', async () => {
    const { rows, incomplete, retry } = await collectToolRows('m1', {
      browserRows: () => { throw new Error('no browser runtime dir'); },
      computerRows: () => [computerRow('inv-1', 2_000)],
      bindings: () => { throw new Error('no task index'); },
      liveTasks: () => [],
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.kind).toBe('computer');
    expect(incomplete).toEqual(['browser']);
    expect(retry).toBe(true);
  });

  it('emits only changed rows and the keys that vanished', async () => {
    const set = new ToolRowSet();
    const scope = 'm1';
    const only = async (browserRows: () => BrowserSessionRow[]) => (await collectToolRows(scope, { browserRows, computerRows: () => [], bindings: () => [], liveTasks: () => [] })).rows;
    const first = await only(() => [browserRow('post', 1_000)]);
    expect(set.diff(first).upserts).toHaveLength(1);
    expect(set.diff(await only(() => [browserRow('post', 1_000)]))).toEqual({ upserts: [], removes: [] });
    const grown = set.diff(await only(() => [browserRow('post', 2_000, 2)]));
    expect(grown.upserts).toHaveLength(1);
    expect(grown.upserts[0]!.rowKey).toBe(first[0]!.rowKey);
    expect(grown.removes).toEqual([]);
    const gone = set.diff([]);
    expect(gone.upserts).toEqual([]);
    expect(gone.removes).toEqual([first[0]!.rowKey]);
  });

  it('does no work at all while the watched roots are untouched, then reports a real change', async () => {
    const browserDir = tempRoot();
    const eventsDir = tempRoot();
    let collected = 0;
    let tasks = ['post'];
    const diffs: ToolDiff[] = [];
    const controller = new AbortController();
    const sources = {
      browserRows: () => { collected += 1; return tasks.map((task) => browserRow(task, 1_000)); },
      computerRows: () => [],
      bindings: () => tasks.map((task) => ({ name: task, device: 'm1', createdAt: 1 })),
      liveTasks: () => [],
    };
    const initial = (await collectToolRows('m1', sources)).rows;
    const watch = watchToolActivity({
      scope: 'm1', signal: controller.signal, roots: [browserDir, eventsDir],
      sweepMs: 30, sources, initial, onDiff: (diff) => diffs.push(diff),
    });
    try {
      expect(watch.armed()).toBe(true);
      await new Promise((resolve) => setTimeout(resolve, 500));
      const collectedAfterSeed = collected;
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(collected).toBe(collectedAfterSeed);
      expect(diffs).toEqual([]);

      tasks = ['post', 'review'];
      fs.mkdirSync(path.join(browserDir, 'work', 'sessions', 'review'), { recursive: true });
      fs.writeFileSync(path.join(browserDir, 'work', 'sessions', 'review', 'c0.png'), 'x');
      await until('the new task to be reported', () => diffs.length > 0);
      expect(diffs[0]!.upserts.map((row) => row.task)).toEqual(['review']);
      expect(diffs[0]!.removes).toEqual([]);
      expect(collected).toBeGreaterThan(collectedAfterSeed);

      const before = diffs.length;
      tasks = ['post'];
      fs.appendFileSync(path.join(eventsDir, 'events.jsonl'), '{"event":"computer.action"}\n');
      await until('the closed task to be removed', () => diffs.length > before);
      expect(diffs[diffs.length - 1]!.removes).toHaveLength(1);
    } finally { controller.abort(); }
  });

  it('re-projects on the sweep when no root can be watched, rather than going silent', async () => {
    const controller = new AbortController();
    let tasks: string[] = [];
    const diffs: ToolDiff[] = [];
    const blocker = path.join(tempRoot(), 'not-a-dir');
    fs.writeFileSync(blocker, 'x');
    const watch = watchToolActivity({
      scope: 'm1', signal: controller.signal, roots: [path.join(blocker, 'nested')], sweepMs: 25,
      sources: { browserRows: () => tasks.map((task) => browserRow(task, 1_000)), computerRows: () => [], bindings: () => [], liveTasks: () => [] },
      onDiff: (diff) => diffs.push(diff),
    });
    try {
      expect(watch.armed()).toBe(false);
      tasks = ['post'];
      await until('the unwatched change to surface on the sweep', () => diffs.length > 0);
      expect(diffs[0]!.upserts.map((row) => row.task)).toEqual(['post']);
    } finally { controller.abort(); }
  });

  it('stops reading once the signal aborts', async () => {
    const controller = new AbortController();
    let collected = 0;
    const seen: ToolRow[] = [];
    const blocker = path.join(tempRoot(), 'not-a-dir');
    fs.writeFileSync(blocker, 'x');
    watchToolActivity({
      scope: 'm1', signal: controller.signal, roots: [path.join(blocker, 'nested')], sweepMs: 20,
      sources: { browserRows: () => { collected += 1; return [browserRow(`t${collected}`, 1_000)]; }, computerRows: () => [], bindings: () => [], liveTasks: () => [] },
      onDiff: (diff) => seen.push(...diff.upserts),
    });
    await until('at least one projection', () => collected > 0);
    controller.abort();
    const after = collected;
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(collected).toBe(after);
  });
});

describe('live browser tasks read from real tasks.json files', () => {
  it('reads every profile\'s live tasks with their short tab ids', () => {
    const root = tempRoot();
    const profile = path.join(root, 'work@zion');
    fs.mkdirSync(profile, { recursive: true });
    fs.writeFileSync(path.join(profile, 'tasks.json'), JSON.stringify({
      post: {
        id: 'p1', name: 'post', profile: 'work@zion', label: 'x.com',
        tabs: { a: 'TARGET-AAAA', b: 'TARGET-BBBB' },
        currentTabId: 'b', borrowedTabs: ['a'],
        createdAt: 1_700, lastActionAt: 4_200, sessionId: 'sess-9', actor: 'claude:abc',
      },
    }));
    fs.mkdirSync(path.join(root, 'sessions'), { recursive: true });
    const other = path.join(root, 'dev');
    fs.mkdirSync(other, { recursive: true });
    fs.writeFileSync(path.join(other, 'tasks.json'), JSON.stringify({ review: { name: 'review', tabs: {}, createdAt: 900 } }));

    const tasks = readLiveBrowserTasks(root);
    expect(tasks.map((task) => task.task).sort()).toEqual(['post', 'review']);
    const post = tasks.find((task) => task.task === 'post')!;
    expect(post.tabs).toEqual([{ id: 'a', borrowed: true }, { id: 'b', current: true }]);
    expect(JSON.stringify(post)).not.toContain('TARGET-AAAA');
    expect(post.startedAtMs).toBe(1_700);
    expect(post.lastActionAtMs).toBe(4_200);
    expect(post.sessionId).toBe('sess-9');
    expect(post.actor).toBe('claude:abc');
    expect(tasks.find((task) => task.task === 'review')!.tabs).toEqual([]);
    expect(tasks.find((task) => task.task === 'review')!.lastActionAtMs).toBe(900);
  });

  it('treats an absent tasks.json or runtime dir as genuinely no tasks', () => {
    const root = tempRoot();
    fs.mkdirSync(path.join(root, 'idle'), { recursive: true });
    expect(readLiveBrowserTasks(root)).toEqual([]);
    expect(readLiveBrowserTasks(path.join(root, 'absent'))).toEqual([]);
  });

  it('THROWS on a tasks.json it cannot trust, so stale rows survive', () => {
    const root = tempRoot();
    fs.mkdirSync(path.join(root, 'broken'), { recursive: true });
    fs.writeFileSync(path.join(root, 'broken', 'tasks.json'), '{not json');
    expect(() => readLiveBrowserTasks(root)).toThrow(/unreadable live task state/);

    const listy = tempRoot();
    fs.mkdirSync(path.join(listy, 'listy'), { recursive: true });
    fs.writeFileSync(path.join(listy, 'listy', 'tasks.json'), '[]');
    expect(() => readLiveBrowserTasks(listy)).toThrow(/unexpected live task state/);
  });

  it('THROWS rather than reporting no tasks when the file cannot be read', () => {
    const root = tempRoot();
    const profile = path.join(root, 'locked');
    fs.mkdirSync(profile, { recursive: true });
    const file = path.join(profile, 'tasks.json');
    fs.writeFileSync(file, JSON.stringify({ post: { name: 'post', createdAt: 1 } }));
    fs.chmodSync(file, 0o000);
    try {
      let readable = true;
      try { fs.readFileSync(file, 'utf8'); } catch { readable = false; }
      if (!readable) expect(() => readLiveBrowserTasks(root)).toThrow();
      else expect(readLiveBrowserTasks(root)).toHaveLength(1);
    } finally { fs.chmodSync(file, 0o600); }
  });

  it('a failed live-task read marks the projection incomplete and keeps rows', async () => {
    const set = new ToolRowSet();
    const good = await collectToolRows('m1', {
      browserRows: () => [], computerRows: () => [], bindings: () => [],
      liveTasks: () => [{ task: 'post', tabs: [] }],
    });
    expect(good.incomplete).toEqual([]);
    expect(set.diff(good.rows).upserts).toHaveLength(1);

    const failed = await collectToolRows('m1', {
      browserRows: () => [], computerRows: () => [], bindings: () => [],
      liveTasks: () => { throw new Error('EACCES'); },
    });
    expect(failed.incomplete).toEqual(['browser']);
    expect(failed.rows).toEqual([]);
    expect(set.diff(failed.rows, failed.incomplete)).toEqual({ upserts: [], removes: [] });
  });

  it('surfaces a live task that has produced no capture at all', async () => {
    const { rows } = await collectToolRows('m1', {
      browserRows: () => [],
      computerRows: () => [],
      bindings: () => [],
      liveTasks: () => [{ task: 'fresh', profile: 'work', tabs: [{ id: 'a', current: true }], startedAtMs: 9_000 }],
    });
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect([row.kind, row.task, row.live]).toEqual(['browser', 'fresh', true]);
    expect(row.captures).toEqual([]);
    expect(row.kind === 'browser' && row.tabs?.map((tab) => tab.id)).toEqual(['a']);
    expect(row.kind === 'browser' && row.showCommand?.args).toEqual(['tab', 'focus', 'a', '--task', 'fresh']);
  });

  it('does not duplicate a task that has BOTH a live record and captures', async () => {
    const { rows } = await collectToolRows('m1', {
      browserRows: () => [browserRow('post', 5_000)],
      computerRows: () => [],
      bindings: () => [{ name: 'post', device: 'm1', createdAt: 1 }],
      liveTasks: () => [{ task: 'post', tabs: [{ id: 'a' }] }],
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.kind === 'browser' && rows[0]!.tabs?.length).toBe(1);
    expect(rows[0]!.captures).toHaveLength(1);
  });
});

describe('a failed read never removes live rows', () => {
  it('retains stale rows and retries instead of publishing removes', async () => {
    const controller = new AbortController();
    const diffs: ToolDiff[] = [];
    let failing = false;
    const blocker = path.join(tempRoot(), 'not-a-dir');
    fs.writeFileSync(blocker, 'x');
    const sources = {
      browserRows: () => { if (failing) throw new Error('EMFILE'); return [browserRow('post', 1_000)]; },
      computerRows: () => [],
      bindings: () => [],
      liveTasks: () => [],
    };
    const watch = watchToolActivity({
      scope: 'm1', signal: controller.signal, roots: [path.join(blocker, 'nested')], sweepMs: 20,
      sources, onDiff: (diff) => diffs.push(diff),
    });
    try {
      await until('the task to be reported', () => diffs.length > 0);
      expect(diffs[0]!.upserts.map((row) => row.task)).toEqual(['post']);
      const afterFirst = diffs.length;

      failing = true;
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(diffs.slice(afterFirst).flatMap((diff) => diff.removes)).toEqual([]);

      failing = false;
      await new Promise((resolve) => setTimeout(resolve, 120));
      expect(diffs.flatMap((diff) => diff.removes)).toEqual([]);
      expect(watch.armed()).toBe(false);
    } finally { controller.abort(); }
  });

  it('re-arms a watcher that dies, so `armed` never stays stuck true', async () => {
    const root = tempRoot();
    const watched = path.join(root, 'goes-away');
    fs.mkdirSync(watched, { recursive: true });
    const controller = new AbortController();
    const diffs: ToolDiff[] = [];
    let tasks = ['post'];
    const watch = watchToolActivity({
      scope: 'm1', signal: controller.signal, roots: [watched], sweepMs: 25,
      sources: { browserRows: () => tasks.map((task) => browserRow(task, 1_000)), computerRows: () => [], bindings: () => [], liveTasks: () => [] },
      onDiff: (diff) => diffs.push(diff),
    });
    try {
      expect(watch.armed()).toBe(true);
      fs.writeFileSync(path.join(watched, 'touch'), 'x');
      await until('the initial row', () => diffs.length > 0);
      fs.rmSync(watched, { recursive: true, force: true });
      const before = diffs.length;
      tasks = ['post', 'second'];
      await until('the change to surface after the watcher died', () => diffs.length > before);
      await until('the root to be re-armed', () => watch.armed());
      expect(diffs[diffs.length - 1]!.upserts.map((row) => row.task)).toContain('second');
    } finally { controller.abort(); }
  });
});

describe('rows read from the standalone tools (real processes printing fixture JSON)', () => {
  const testdata = path.join(path.dirname(new URL(import.meta.url).pathname), 'testdata');
  const saved = { ...process.env };
  let argvLog: string;

  beforeEach(() => {
    argvLog = path.join(tempRoot(), 'argv.log');
    process.env.BROWSER_BIN = path.join(testdata, 'bin', 'browser');
    process.env.COMPUTER_BIN = path.join(testdata, 'bin', 'computer');
    process.env.BROWSER_SESSIONS_FIXTURE = path.join(testdata, 'browser-sessions.json');
    process.env.COMPUTER_SESSIONS_FIXTURE = path.join(testdata, 'computer-sessions.json');
    process.env.TOOL_FIXTURE_ARGV_LOG = argvLog;
    _resetBrowserClientForTest();
    _resetComputerClientForTest();
  });
  afterEach(() => {
    for (const key of ['BROWSER_BIN', 'COMPUTER_BIN', 'BROWSER_SESSIONS_FIXTURE', 'COMPUTER_SESSIONS_FIXTURE', 'TOOL_FIXTURE_ARGV_LOG', 'PATH']) {
      if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key];
    }
    _resetBrowserClientForTest();
    _resetComputerClientForTest();
  });

  const live = { bindings: () => [], liveTasks: () => [] };

  it('projects `browser sessions` and `computer sessions` JSON onto the stream, asking each for its bounded listing', async () => {
    const { rows, incomplete } = await collectToolRows('m1', live);
    expect(incomplete).toEqual([]);
    expect(fs.readFileSync(argvLog, 'utf8').trim().split('\n').sort()).toEqual([
      'browser sessions --tasks --json --no-interactive',
      'computer sessions --json --no-interactive --limit 500',
    ]);

    const post = rows.find((row) => row.kind === 'browser' && row.task === 'post')!;
    expect(post).toMatchObject({
      profile: 'work@zion', machine: 'zion', sessionId: 'sess-post', launchId: 'launch-post',
      linkStatus: 'unresolved', live: false, startedAtMs: 1791464700000,
      captureCounts: { screenshot: 1, pdf: 1 },
    });
    expect(post.captures.map((capture) => capture.name)).toEqual(['2.png', '1.pdf']);
    expect(rows.filter((row) => row.kind === 'browser').map((row) => row.task ?? 'downloads').sort()).toEqual(['downloads', 'post']);

    const run = rows.find((row) => row.kind === 'computer')!;
    expect(run).toMatchObject({
      device: 'win-mini', task: 'open the dashboard', sessionId: 'sess-computer', linkStatus: 'unresolved',
      bundle: 'com.apple.Safari', actionCounts: { click: 1, screenshot: 1 }, captureCounts: { screenshot: 1 },
      updatedAtMs: 1791464910000,
    });
    expect(run.captures).toEqual([{ kind: 'screenshot', name: 'shot.png', path: '/caps/shot.png', host: 'm1', bytes: 12, atMs: 1791464910000 }]);
  });

  it('links a row to the agent session agents-cli has indexed for its session id', async () => {
    fs.mkdirSync(getSessionsDir(), { recursive: true });
    const transcript = path.join(tempRoot(), 'sess-post.jsonl');
    fs.writeFileSync(transcript, '');
    upsertSession({
      id: 'sess-post', shortId: 'sess-pos', agent: 'claude', timestamp: '2026-10-08T00:00:00.000Z', filePath: transcript, topic: 'post the release notes',
    } as unknown as Parameters<typeof upsertSession>[0], 'post the release notes');

    const [row] = linkToolSessions([{ sessionId: 'sess-post' }, { sessionId: 'never-indexed' }]);
    expect(row!.linkedSession?.id).toBe('sess-post');

    const { rows } = await collectToolRows('m1', live);
    const post = rows.find((r) => r.kind === 'browser' && r.task === 'post')!;
    expect(post.linkStatus).toBe('linked');
    expect(post.owner).toMatchObject({ sessionId: 'sess-post', agent: 'claude', label: 'post the release notes' });
    expect(rows.find((r) => r.kind === 'computer')!.linkStatus).toBe('unresolved');
  });

  it('a tool that exits non-zero makes the snapshot incomplete and keeps the other tool\'s rows', async () => {
    process.env.BROWSER_SESSIONS_FIXTURE = path.join(testdata, 'absent.json');
    await expect(readToolJson('browser', ['sessions'])).rejects.toThrow(/`browser sessions` exited 1/);
    const { rows, incomplete } = await collectToolRows('m1', live);
    expect(incomplete).toEqual(['browser']);
    expect(rows.map((row) => row.kind)).toEqual(['computer']);
  });

  it('unparseable output is a failure, never an empty listing', async () => {
    process.env.COMPUTER_SESSIONS_FIXTURE = path.join(testdata, 'not-json.txt');
    await expect(readStandaloneComputerRows()).rejects.toThrow(/printed unparseable JSON/);
    expect(await collectToolRows('m1', live)).toMatchObject({ incomplete: ['computer'], retry: true });
  });

  it('names `agents setup tools` when the tool is not installed', async () => {
    delete process.env.COMPUTER_BIN;
    process.env.PATH = tempRoot();
    await expect(readStandaloneComputerRows()).rejects.toThrow(/agents setup tools/);
    expect(await collectToolRows('m1', { ...live, browserRows: () => [] })).toMatchObject({ incomplete: ['computer'], retry: false });
  });
});
