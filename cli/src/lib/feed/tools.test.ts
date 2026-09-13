import { describe, expect, it } from 'vitest';
import { projectBrowserToolRow, projectComputerToolRow, redactToolUrl, sortToolRows, toolRowKey, TOOL_CAPTURE_LIMIT, TOOL_ACTION_LIMIT } from './tools.js';
import type { BrowserSessionRow } from '../browser/sessions-list.js';
import type { ComputerRunRow } from '../computer/sessions-list.js';

function browserRow(extra: Partial<BrowserSessionRow> = {}): BrowserSessionRow {
  return {
    kind: 'task', profile: 'work', task: 'post', linkStatus: 'linked',
    sessionId: 'sess-1', launchId: 'launch-1',
    linkedSession: { id: 'sess-1', shortId: 'sess-1', agent: 'claude', machine: 'Zion', timestamp: '2026-09-13T00:00:00Z', label: 'ship the feed' } as BrowserSessionRow['linkedSession'],
    artifacts: [
      { kind: 'screenshot', task: 'post', name: 'b.png', path: '/caps/b.png', bytes: 20, mtimeMs: 2_000 },
      { kind: 'screenshot', task: 'post', name: 'a.png', path: '/caps/a.png', bytes: 10, mtimeMs: 1_000 },
    ],
    counts: { screenshot: 2, pdf: 0, recording: 0, download: 0 },
    latestMtimeMs: 2_000,
    ...extra,
  };
}

function computerRow(extra: Partial<ComputerRunRow> = {}): ComputerRunRow {
  return {
    pid: 4242, invocationId: 'inv-1', task: 'fill the form', machine: 'yosemite-m1',
    bundle: 'com.apple.Safari', linkStatus: 'unlinked',
    actions: [
      { verb: 'click', ts: '2026-09-13T00:00:02Z', tsMs: 2_000, pid: 4242, bundle: 'com.apple.Safari' },
      { verb: 'type', ts: '2026-09-13T00:00:01Z', tsMs: 1_000, pid: 4242 },
    ],
    counts: { click: 1, type: 1 }, startMs: 1_000, endMs: 2_000,
    ...extra,
  };
}

describe('canonical tool rows', () => {
  it('names the owner through the one headline ladder, generated title included', () => {
    const generated = projectBrowserToolRow('m1', browserRow({
      linkedSession: { id: 'sess-1', shortId: 'sess-1', agent: 'claude', machine: 'm1', timestamp: '2026-09-13T00:00:00Z', generatedTitle: 'wire the tool rows', topic: 'raw first prompt' } as BrowserSessionRow['linkedSession'],
    }));
    expect(generated.owner?.label).toBe('wire the tool rows');
    const topicOnly = projectBrowserToolRow('m1', browserRow({
      linkedSession: { id: 'sess-1', shortId: 'sess-1', agent: 'claude', machine: 'm1', timestamp: '2026-09-13T00:00:00Z', topic: 'raw first prompt' } as BrowserSessionRow['linkedSession'],
    }));
    expect(topicOnly.owner?.label).toBe('raw first prompt');
  });

  it('projects a live browser task with its owner, captures and close command', () => {
    const row = projectBrowserToolRow('yosemite-m1', browserRow(), { device: 'Zion', url: 'https://x.com/home', createdAt: 500 });
    expect(row.kind).toBe('browser');
    expect(row.live).toBe(true);
    expect(row.device).toBe('zion');
    expect(row.scope).toBe('yosemite-m1');
    expect(row.closeCommand).toEqual({ command: 'agents', args: ['browser', 'done', '--task', 'post'] });
    expect(row.owner).toEqual({ sessionId: 'sess-1', device: 'zion', label: 'ship the feed', agent: 'claude' });
    expect(row.captures.map((capture) => capture.name)).toEqual(['b.png', 'a.png']);
    expect(row.captureCounts).toEqual({ screenshot: 2 });
    expect(row.startedAtMs).toBe(500);
    expect(row.updatedAtMs).toBe(2_000);
  });

  it('drops the close command once the task is no longer bound, and keeps the row', () => {
    const row = projectBrowserToolRow('yosemite-m1', browserRow(), undefined);
    expect(row.live).toBe(false);
    expect(row.closeCommand).toBeUndefined();
    // Start falls back to the oldest capture when no binding recorded a time.
    expect(row.startedAtMs).toBe(1_000);
  });

  it('never marks a computer run live and never offers a stop affordance', () => {
    const row = projectComputerToolRow('yosemite-m1', computerRow());
    expect(row.kind).toBe('computer');
    expect(row.live).toBe(false);
    expect('closeCommand' in row).toBe(false);
    expect(row.actions.map((action) => action.verb)).toEqual(['click', 'type']);
    expect(row.actionCounts).toEqual({ click: 1, type: 1 });
    expect(row.bundle).toBe('com.apple.Safari');
  });

  it('names the driven machine, not the invoking one, for a --device run', () => {
    const row = projectComputerToolRow('yosemite-m1', computerRow({ remoteHost: 'Win-Mini' }));
    expect(row.device).toBe('win-mini');
    expect(row.scope).toBe('yosemite-m1');
  });

  it('carries a pruned run\'s surviving total instead of inventing per-verb detail', () => {
    const row = projectComputerToolRow('m1', computerRow({ actions: [], counts: {}, recoveredActionCount: 97, invocationId: undefined, pid: undefined }));
    expect(row.recoveredActionCount).toBe(97);
    expect(row.actions).toEqual([]);
    expect(row.actionCounts).toEqual({});
  });

  it('bounds captures and actions so one envelope cannot carry a whole task history', () => {
    const many = Array.from({ length: TOOL_CAPTURE_LIMIT + 25 }, (_, i) => (
      { kind: 'screenshot' as const, task: 'post', name: `s${i}.png`, path: `/caps/s${i}.png`, bytes: 1, mtimeMs: 10_000 - i }
    ));
    const browser = projectBrowserToolRow('m1', browserRow({ artifacts: many, latestMtimeMs: 10_000 }));
    expect(browser.captures).toHaveLength(TOOL_CAPTURE_LIMIT);
    // Counts still describe the WHOLE row, not the truncated window.
    expect(browser.captureCounts.screenshot).toBe(many.length);

    const actions = Array.from({ length: TOOL_ACTION_LIMIT + 10 }, (_, i) => (
      { verb: 'click', ts: '2026-09-13T00:00:00Z', tsMs: 9_000 - i, pid: 1 }
    ));
    expect(projectComputerToolRow('m1', computerRow({ actions })).actions).toHaveLength(TOOL_ACTION_LIMIT);
  });

  it('keeps row identity stable per scope and distinct across scope, kind and task', () => {
    const a = projectBrowserToolRow('m1', browserRow());
    const b = projectBrowserToolRow('m1', browserRow());
    expect(a.rowKey).toBe(b.rowKey);
    expect(projectBrowserToolRow('m2', browserRow()).rowKey).not.toBe(a.rowKey);
    expect(projectBrowserToolRow('m1', browserRow({ task: 'other' })).rowKey).not.toBe(a.rowKey);
    expect(toolRowKey('m1', 'computer', 'post')).not.toBe(toolRowKey('m1', 'browser', 'post'));
  });

  it('redacts credentials out of a published url and drops an unparseable one', () => {
    expect(redactToolUrl('https://u:p@example.com/a?access_token=abc&page=2#id_token=zzz'))
      .toBe('https://example.com/a?access_token=%3Credacted%3E&page=2');
    expect(redactToolUrl('https://example.com/a?api_key=k&secret=s&q=hello'))
      .toBe('https://example.com/a?api_key=%3Credacted%3E&secret=%3Credacted%3E&q=hello');
    expect(redactToolUrl('not a url')).toBeUndefined();
    expect(redactToolUrl(undefined)).toBeUndefined();
  });

  it('never publishes a raw url a binding recorded with a token in it', () => {
    const row = projectBrowserToolRow('m1', browserRow(), { url: 'https://api.example.com/v1?token=SUPERSECRET' });
    expect(JSON.stringify(row)).not.toContain('SUPERSECRET');
  });

  it('orders both kinds newest-updated first', () => {
    const rows = sortToolRows([
      projectComputerToolRow('m1', computerRow({ endMs: 1_000 })),
      projectBrowserToolRow('m1', browserRow({ latestMtimeMs: 9_000 })),
    ]);
    expect(rows.map((row) => row.kind)).toEqual(['browser', 'computer']);
  });
});
