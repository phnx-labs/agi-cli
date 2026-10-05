import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { ingestBatch, routeFor } from './events-ingest.js';
import { query, _resetForTest } from './feed/events.js';

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-ingest-'));
  tempDirs.push(dir);
  return dir;
}

function setup(): { activityRoot: string } {
  const dir = makeTempDir();
  _resetForTest(path.join(dir, 'events.jsonl'));
  const activityRoot = path.join(dir, 'activity');
  fs.mkdirSync(activityRoot, { recursive: true });
  return { activityRoot };
}

afterEach(() => {
  for (const dir of tempDirs) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {  }
  }
  tempDirs.length = 0;
  _resetForTest();
});

const jsonl = (...objs: unknown[]) => objs.map((o) => JSON.stringify(o)).join('\n');

describe('routing between the two stores', () => {
  it('sends a non-milestone UI event to the operational log, stamped with --source as module', () => {
    const { activityRoot } = setup();

    const res = ingestBatch(
      jsonl({ event: 'factory.command', commandId: 'agents.newClaude', windowId: 'w1' }),
      { source: 'factory', activityRoot },
    );

    expect(res.written).toBe(1);
    expect(res.rejected).toEqual([]);
    expect(res.routed).toEqual({ operational: 1, activity: 0 });

    const records = query({});
    expect(records).toHaveLength(1);
    expect(records[0].event).toBe('factory.command');
    expect(records[0].module).toBe('factory');
    expect((records[0] as Record<string, unknown>).commandId).toBe('agents.newClaude');

    expect(fs.readdirSync(activityRoot)).toEqual([]);
  });

  it('sends a milestone WITH a sessionId to that session activity shard', () => {
    const { activityRoot } = setup();

    const res = ingestBatch(
      jsonl({
        event: 'factory.launch',
        sessionId: 'abc-123',
        terminalId: 'CC-3',
        agent: 'claude',
        host: 'zion',
      }),
      { source: 'factory', activityRoot },
    );

    expect(res.routed).toEqual({ operational: 0, activity: 1 });
    expect(fs.readdirSync(activityRoot)).toEqual(['abc-123.jsonl']);

    const written = JSON.parse(fs.readFileSync(path.join(activityRoot, 'abc-123.jsonl'), 'utf-8').trim());
    expect(written.event).toBe('factory.launch');
    expect(written.tier).toBe('milestone');
    expect(written.terminalId).toBe('CC-3');
    expect(written.mailboxId).toBe('abc-123');
    expect(query({})).toHaveLength(0);
  });

  it('routeFor is the single rule both stores agree on', () => {
    expect(routeFor('factory.launch', 'abc')).toBe('activity');
    expect(routeFor('factory.launch', '')).toBe('operational');
    expect(routeFor('factory.command', 'abc')).toBe('operational');
  });
});

describe('rejection is loud, per line, and lossless', () => {
  it('rejects a milestone with no sessionId instead of silently demoting it', () => {
    const { activityRoot } = setup();

    const res = ingestBatch(jsonl({ event: 'factory.launch', terminalId: 'CC-1' }), {
      source: 'factory',
      activityRoot,
    });

    expect(res.written).toBe(0);
    expect(res.rejected).toHaveLength(1);
    expect(res.rejected[0].reason).toMatch(/sessionId/);
    expect(query({})).toHaveLength(0);
    expect(fs.readdirSync(activityRoot)).toEqual([]);
  });

  it('rejects an unknown event kind but still writes its valid siblings', () => {
    const { activityRoot } = setup();

    const res = ingestBatch(
      jsonl(
        { event: 'factory.command', commandId: 'a' },
        { event: 'factory.clik', commandId: 'typo' },
        { event: 'factory.command', commandId: 'b' },
      ),
      { source: 'factory', activityRoot },
    );

    expect(res.written).toBe(2);
    expect(res.rejected).toEqual([{ line: 2, reason: 'unknown event kind: factory.clik' }]);
    expect(query({}).map((r) => (r as Record<string, unknown>).commandId).sort()).toEqual(['a', 'b']);
  });

  it('rejects malformed JSON and a bad ts without aborting the batch', () => {
    const { activityRoot } = setup();

    const res = ingestBatch(
      ['{not json', JSON.stringify({ event: 'factory.command', ts: 'yesterday' }), JSON.stringify({ event: 'factory.command', commandId: 'ok' })].join('\n'),
      { source: 'factory', activityRoot },
    );

    expect(res.written).toBe(1);
    expect(res.rejected.map((r) => r.line)).toEqual([1, 2]);
    expect(res.rejected[0].reason).toMatch(/not valid JSON/);
    expect(res.rejected[1].reason).toMatch(/invalid "ts"/);
  });

  it('skips blank lines without counting them as rejects', () => {
    const { activityRoot } = setup();
    const res = ingestBatch(`\n${JSON.stringify({ event: 'factory.command' })}\n\n`, {
      source: 'factory',
      activityRoot,
    });
    expect(res.written).toBe(1);
    expect(res.rejected).toEqual([]);
  });
});

describe('caller-supplied timestamps', () => {
  it('preserves each event own ts so a batched flush does not collapse them', () => {
    const { activityRoot } = setup();
    const t1 = '2026-08-03T01:00:00.000Z';
    const t2 = '2026-08-03T01:00:05.000Z';

    ingestBatch(
      jsonl(
        { event: 'factory.command', ts: t1, commandId: 'first' },
        { event: 'factory.command', ts: t2, commandId: 'second' },
      ),
      { source: 'factory', activityRoot },
    );

    const byCommand = new Map(query({}).map((r) => [(r as Record<string, unknown>).commandId, r.ts]));
    expect(byCommand.get('first')).toBe(t1);
    expect(byCommand.get('second')).toBe(t2);
  });
});

describe('guards', () => {
  it('refuses an empty --source, because an unattributed event is not auditable', () => {
    const { activityRoot } = setup();
    expect(() => ingestBatch(jsonl({ event: 'factory.command' }), { source: '  ', activityRoot }))
      .toThrow(/--source is required/);
  });

  it('--dry-run validates and reports without writing either store', () => {
    const { activityRoot } = setup();

    const res = ingestBatch(
      jsonl(
        { event: 'factory.command', commandId: 'a' },
        { event: 'factory.launch', sessionId: 's1' },
        { event: 'nope.nope' },
      ),
      { source: 'factory', dryRun: true, activityRoot },
    );

    expect(res.written).toBe(2);
    expect(res.rejected).toHaveLength(1);
    expect(res.routed).toEqual({ operational: 1, activity: 1 });
    expect(query({})).toHaveLength(0);
    expect(fs.readdirSync(activityRoot)).toEqual([]);
  });
});
