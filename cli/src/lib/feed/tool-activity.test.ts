import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { collectToolRows, watchToolActivity, ToolRowSet, type ToolDiff } from './tool-activity.js';
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
    const rows = collectToolRows('m1', {
      browserRows: () => [browserRow('post', 3_000), browserRow('stale', 1_000)],
      computerRows: () => [computerRow('inv-1', 2_000)],
      bindings: () => [{ name: 'post', device: 'm1', url: 'https://example.com/', createdAt: 100 }],
    });
    expect(rows.map((row) => [row.kind, row.task, row.live])).toEqual([
      ['browser', 'post', true],
      ['computer', undefined, false],
      ['browser', 'stale', false],
    ]);
  });

  it('survives a source that throws instead of losing the other kind', () => {
    const rows = collectToolRows('m1', {
      browserRows: () => { throw new Error('no browser runtime dir'); },
      computerRows: () => [computerRow('inv-1', 2_000)],
      bindings: () => { throw new Error('no task index'); },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.kind).toBe('computer');
  });

  it('emits only changed rows and the keys that vanished', () => {
    const set = new ToolRowSet();
    const scope = 'm1';
    const first = collectToolRows(scope, { browserRows: () => [browserRow('post', 1_000)], computerRows: () => [], bindings: () => [] });
    expect(set.diff(first).upserts).toHaveLength(1);
    // Identical projection: no upsert, no remove.
    expect(set.diff(collectToolRows(scope, { browserRows: () => [browserRow('post', 1_000)], computerRows: () => [], bindings: () => [] })))
      .toEqual({ upserts: [], removes: [] });
    // A new capture upserts under the SAME key rather than adding a row.
    const grown = set.diff(collectToolRows(scope, { browserRows: () => [browserRow('post', 2_000, 2)], computerRows: () => [], bindings: () => [] }));
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
    };
    const initial = collectToolRows('m1', sources);
    const collectedAfterSeed = collected;
    const watch = watchToolActivity({
      scope: 'm1', signal: controller.signal, roots: [browserDir, eventsDir],
      sweepMs: 30, sources, initial, onDiff: (diff) => diffs.push(diff),
    });
    try {
      expect(watch.armed).toBe(true);
      // Many ticks pass with nothing written: the collector must not read.
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
      sources: { browserRows: () => tasks.map((task) => browserRow(task, 1_000)), computerRows: () => [], bindings: () => [] },
      onDiff: (diff) => diffs.push(diff),
    });
    try {
      expect(watch.armed).toBe(false);
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
      sources: { browserRows: () => { collected += 1; return [browserRow(`t${collected}`, 1_000)]; }, computerRows: () => [], bindings: () => [] },
      onDiff: (diff) => seen.push(...diff.upserts),
    });
    await until('at least one projection', () => collected > 0);
    controller.abort();
    const after = collected;
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(collected).toBe(after);
  });
});
