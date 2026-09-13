import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { collectToolRows, readLiveBrowserTasks, watchToolActivity, ToolRowSet, type ToolDiff } from './tool-activity.js';
import type { BrowserSessionRow } from '../browser/sessions-list.js';
import type { ComputerRunRow } from '../computer/sessions-list.js';
import type { ToolRow } from './tools.js';

const roots: string[] = [];
function tempRoot(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tool-activity-'));
  roots.push(dir);
  return dir;
}
afterEach(() => { for (const dir of roots.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });

function browserRow(task: string, mtimeMs: number, captures = 1): BrowserSessionRow {
  return {
    kind: 'task', profile: 'work', task, linkStatus: 'unlinked',
    artifacts: Array.from({ length: captures }, (_, i) => (
      { kind: 'screenshot' as const, task, name: `c${i}.png`, path: `/caps/${task}/c${i}.png`, bytes: 1, mtimeMs: mtimeMs - i }
    )),
    counts: { screenshot: captures, pdf: 0, recording: 0, download: 0 },
    latestMtimeMs: mtimeMs,
  };
}

function computerRow(invocationId: string, endMs: number): ComputerRunRow {
  return {
    invocationId, machine: 'm1', linkStatus: 'unlinked',
    actions: [{ verb: 'click', ts: '2026-09-13T00:00:00Z', tsMs: endMs, pid: 1 }],
    counts: { click: 1 }, startMs: endMs - 10, endMs,
  };
}

/** Wait for a real condition rather than a fixed sleep; fails loud on timeout. */
async function until(what: string, predicate: () => boolean, timeoutMs = 4_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`timed out waiting for ${what}`);
}

describe('tool activity collection over real directories', () => {
  it('collects both kinds and binds liveness from the task index', () => {
    const { rows, complete } = collectToolRows('m1', {
      browserRows: () => [browserRow('post', 3_000), browserRow('stale', 1_000)],
      computerRows: () => [computerRow('inv-1', 2_000)],
      bindings: () => [{ name: 'post', device: 'm1', url: 'https://example.com/', createdAt: 100 }],
      liveTasks: () => [],
    });
    expect(complete).toBe(true);
    expect(rows.map((row) => [row.kind, row.task, row.live])).toEqual([
      ['browser', 'post', true],
      ['computer', undefined, false],
      ['browser', 'stale', false],
    ]);
  });

  it('survives a source that throws, keeps the other kind, and reports INCOMPLETE', () => {
    const { rows, complete } = collectToolRows('m1', {
      browserRows: () => { throw new Error('no browser runtime dir'); },
      computerRows: () => [computerRow('inv-1', 2_000)],
      bindings: () => { throw new Error('no task index'); },
      liveTasks: () => [],
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.kind).toBe('computer');
    // The flag is what stops the differ from reading a failed read as "all closed".
    expect(complete).toBe(false);
  });

  it('emits only changed rows and the keys that vanished', () => {
    const set = new ToolRowSet();
    const scope = 'm1';
    const only = (browserRows: () => BrowserSessionRow[]) => collectToolRows(scope, { browserRows, computerRows: () => [], bindings: () => [], liveTasks: () => [] }).rows;
    const first = only(() => [browserRow('post', 1_000)]);
    expect(set.diff(first).upserts).toHaveLength(1);
    // Identical projection: no upsert, no remove.
    expect(set.diff(only(() => [browserRow('post', 1_000)]))).toEqual({ upserts: [], removes: [] });
    // A new capture upserts under the SAME key rather than adding a row.
    const grown = set.diff(only(() => [browserRow('post', 2_000, 2)]));
    expect(grown.upserts).toHaveLength(1);
    expect(grown.upserts[0]!.rowKey).toBe(first[0]!.rowKey);
    expect(grown.removes).toEqual([]);
    // The task disappears entirely: one remove, keyed the same.
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
    const initial = collectToolRows('m1', sources).rows;
    const watch = watchToolActivity({
      scope: 'm1', signal: controller.signal, roots: [browserDir, eventsDir],
      sweepMs: 30, sources, initial, onDiff: (diff) => diffs.push(diff),
    });
    try {
      expect(watch.armed()).toBe(true);
      // macOS can deliver directory-creation events after fs.watch returns.
      await new Promise((resolve) => setTimeout(resolve, 500));
      const collectedAfterSeed = collected;
      // Once warm, untouched roots must not cause another projection.
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(collected).toBe(collectedAfterSeed);
      expect(diffs).toEqual([]);

      // A capture landing deep under the browser root is a real change.
      tasks = ['post', 'review'];
      fs.mkdirSync(path.join(browserDir, 'work', 'sessions', 'review'), { recursive: true });
      fs.writeFileSync(path.join(browserDir, 'work', 'sessions', 'review', 'c0.png'), 'x');
      await until('the new task to be reported', () => diffs.length > 0);
      expect(diffs[0]!.upserts.map((row) => row.task)).toEqual(['review']);
      expect(diffs[0]!.removes).toEqual([]);
      expect(collected).toBeGreaterThan(collectedAfterSeed);

      // A ledger append under the events root is the computer-side trigger.
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
    // A path whose parent is a FILE cannot be created or watched.
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
    // An unwatchable root, so every tick projects and an abort is observable as
    // the projections STOPPING rather than as a tick that had nothing to do.
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
    // The REAL persisted schema: createdAt + lastActionAt, per browser/types.ts
    // `Task`. `startedAt` is a service DTO field that tasks.json never carries.
    fs.writeFileSync(path.join(profile, 'tasks.json'), JSON.stringify({
      post: {
        id: 'p1', name: 'post', profile: 'work@zion', label: 'x.com',
        tabs: { a: 'TARGET-AAAA', b: 'TARGET-BBBB' },
        currentTabId: 'b', borrowedTabs: ['a'],
        createdAt: 1_700, lastActionAt: 4_200, sessionId: 'sess-9', actor: 'claude:abc',
      },
    }));
    // A second profile dir, plus the `sessions` dir that is never a profile.
    fs.mkdirSync(path.join(root, 'sessions'), { recursive: true });
    const other = path.join(root, 'dev');
    fs.mkdirSync(other, { recursive: true });
    // A pre-RUSH-2622 task carries no lastActionAt; createdAt is the fallback the
    // browser's own reader normalizes it to.
    fs.writeFileSync(path.join(other, 'tasks.json'), JSON.stringify({ review: { name: 'review', tabs: {}, createdAt: 900 } }));

    const tasks = readLiveBrowserTasks(root);
    expect(tasks.map((task) => task.task).sort()).toEqual(['post', 'review']);
    const post = tasks.find((task) => task.task === 'post')!;
    // The task's own SHORT ids, never the engine target ids.
    expect(post.tabs).toEqual([{ id: 'a', borrowed: true }, { id: 'b', current: true }]);
    expect(JSON.stringify(post)).not.toContain('TARGET-AAAA');
    expect(post.startedAtMs).toBe(1_700);
    expect(post.lastActionAtMs).toBe(4_200);
    expect(post.sessionId).toBe('sess-9');
    expect(post.actor).toBe('claude:abc');
    // A profile whose task map is empty is still a live task with no tabs.
    expect(tasks.find((task) => task.task === 'review')!.tabs).toEqual([]);
    expect(tasks.find((task) => task.task === 'review')!.lastActionAtMs).toBe(900);
  });

  it('treats an absent tasks.json or runtime dir as genuinely no tasks', () => {
    const root = tempRoot();
    // A profile dir with no tasks.json: no live browser on it.
    fs.mkdirSync(path.join(root, 'idle'), { recursive: true });
    expect(readLiveBrowserTasks(root)).toEqual([]);
    // No runtime dir at all: no browser has ever run here.
    expect(readLiveBrowserTasks(path.join(root, 'absent'))).toEqual([]);
  });

  it('THROWS on a tasks.json it cannot trust, so stale rows survive', () => {
    // Returning [] here is indistinguishable from "every task closed", which is
    // what made live rows flicker out on a mid-write read.
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
      // Running as root defeats the mode bits, so only assert when it really is
      // unreadable — the ENOENT-vs-other split is what the test is about.
      let readable = true;
      try { fs.readFileSync(file, 'utf8'); } catch { readable = false; }
      if (!readable) expect(() => readLiveBrowserTasks(root)).toThrow();
      else expect(readLiveBrowserTasks(root)).toHaveLength(1);
    } finally { fs.chmodSync(file, 0o600); }
  });

  it('a failed live-task read marks the projection incomplete and keeps rows', () => {
    const set = new ToolRowSet();
    const good = collectToolRows('m1', {
      browserRows: () => [], computerRows: () => [], bindings: () => [],
      liveTasks: () => [{ task: 'post', tabs: [] }],
    });
    expect(good.complete).toBe(true);
    expect(set.diff(good.rows).upserts).toHaveLength(1);

    const failed = collectToolRows('m1', {
      browserRows: () => [], computerRows: () => [], bindings: () => [],
      liveTasks: () => { throw new Error('EACCES'); },
    });
    expect(failed.complete).toBe(false);
    // The differ must never be handed this snapshot; if it were, it would remove
    // the live row. The watcher's own guard is covered in the stale-rows test.
    expect(failed.rows).toEqual([]);
  });

  it('surfaces a live task that has produced no capture at all', () => {
    const { rows } = collectToolRows('m1', {
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
    expect(row.kind === 'browser' && row.showCommand?.args).toEqual(['browser', 'tab', 'focus', 'a', '--task', 'fresh']);
  });

  it('does not duplicate a task that has BOTH a live record and captures', () => {
    const { rows } = collectToolRows('m1', {
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
    // Unwatchable root so every tick projects, making the failure observable.
    const watch = watchToolActivity({
      scope: 'm1', signal: controller.signal, roots: [path.join(blocker, 'nested')], sweepMs: 20,
      sources, onDiff: (diff) => diffs.push(diff),
    });
    try {
      await until('the task to be reported', () => diffs.length > 0);
      expect(diffs[0]!.upserts.map((row) => row.task)).toEqual(['post']);
      const afterFirst = diffs.length;

      // Now every read fails. The row must NOT be removed.
      failing = true;
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(diffs.slice(afterFirst).flatMap((diff) => diff.removes)).toEqual([]);

      // Recovery emits nothing new either — the row never changed.
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
      // An armed watcher is correctly idle until something reports a change, so
      // touch the watched root to get the first projection.
      fs.writeFileSync(path.join(watched, 'touch'), 'x');
      await until('the initial row', () => diffs.length > 0);
      // Remove the watched directory: the watcher errors and closes itself.
      fs.rmSync(watched, { recursive: true, force: true });
      const before = diffs.length;
      // A change while the watcher is down must still be reported, and the root
      // must come back armed rather than being abandoned.
      tasks = ['post', 'second'];
      await until('the change to surface after the watcher died', () => diffs.length > before);
      await until('the root to be re-armed', () => watch.armed());
      expect(diffs[diffs.length - 1]!.upserts.map((row) => row.task)).toContain('second');
    } finally { controller.abort(); }
  });
});
