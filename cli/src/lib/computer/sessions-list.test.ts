import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as crypto from 'crypto';
import {
  listComputerActions,
  groupIntoComputerRuns,
  matchesComputerSessionRow,
  formatActionCounts,
  renderComputerSessionRows,
  buildComputerSessionRows,
  applyRowDisplayLimit,
  TASK_PREVIEW_MAX_CHARS,
  DEFAULT_ROW_DISPLAY_LIMIT,
  type ComputerAction,
  type ComputerRunRow,
} from './sessions-list.js';
import { emit, query, truncate, _resetForTest } from '../feed/events.js';
import type { SessionMeta } from '../session/types.js';

function makeSession(overrides: Partial<SessionMeta> = {}): SessionMeta {
  return {
    id: 'sess-1234',
    shortId: 'sess1234',
    agent: 'claude',
    timestamp: '2026-01-01T00:00:00.000Z',
    filePath: '/tmp/does-not-exist.jsonl',
    ...overrides,
  } as SessionMeta;
}

function action(overrides: Partial<ComputerAction> = {}): ComputerAction {
  const invocationId = Object.prototype.hasOwnProperty.call(overrides, 'invocationId')
    ? overrides.invocationId
    : `invocation-${overrides.pid ?? 100}`;
  return {
    verb: 'click',
    ts: new Date(1000).toISOString(),
    tsMs: 1000,
    pid: 100,
    invocationId,
    ...overrides,
  };
}

// ─── Pure grouping (RUSH-2432) ──────────────────────────────────────────────
// groupIntoComputerRuns / matchesComputerSessionRow are pure — resolvers are
// injected, so these run with no filesystem or session-index dependency.
// listComputerActions / buildComputerSessionRows are the impure ledger/disk
// readers, covered further down against the real event log (same pattern as
// browser/sessions-list.test.ts's disk-backed section).

describe('groupIntoComputerRuns', () => {
  it('collapses every action sharing a pid into one row, newest action first', () => {
    const actions = [
      action({ verb: 'click', tsMs: 1000, pid: 100 }),
      action({ verb: 'type', tsMs: 3000, pid: 100 }),
      action({ verb: 'screenshot', tsMs: 2000, pid: 100 }),
    ];
    const rows = groupIntoComputerRuns(actions);
    expect(rows).toHaveLength(1);
    expect(rows[0].pid).toBe(100);
    expect(rows[0].actions.map((a) => a.verb)).toEqual(['type', 'screenshot', 'click']);
    expect(rows[0].startMs).toBe(1000);
    expect(rows[0].endMs).toBe(3000);
    expect(rows[0].counts).toEqual({ click: 1, type: 1, screenshot: 1 });
  });

  it('separates actions from different pids into distinct rows, sorted newest-run-first', () => {
    const actions = [
      action({ pid: 1, tsMs: 1000 }),
      action({ pid: 2, tsMs: 9000 }),
    ];
    const rows = groupIntoComputerRuns(actions);
    expect(rows.map((r) => r.pid)).toEqual([2, 1]);
  });

  it('separates unrelated invocations when the OS reuses a pid', () => {
    const rows = groupIntoComputerRuns([
      action({ pid: 44, invocationId: 'old-process', tsMs: 1_000, bundle: 'app.old' }),
      action({ pid: 44, invocationId: 'new-process', tsMs: 604_801_000, bundle: 'app.new' }),
    ]);
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.bundle)).toEqual(['app.new', 'app.old']);
  });

  it('never merges legacy events that lack an invocation identity', () => {
    const rows = groupIntoComputerRuns([
      action({ pid: 44, invocationId: undefined, tsMs: 1_000 }),
      action({ pid: 44, invocationId: undefined, tsMs: 2_000 }),
    ]);
    expect(rows).toHaveLength(2);
  });

  it('pulls the task label from the run marker and excludes it from the driving action counts', () => {
    const actions = [
      action({ verb: 'run', tsMs: 500, pid: 100, task: 'open Notes and write a haiku' }),
      action({ verb: 'describe', tsMs: 600, pid: 100 }),
      action({ verb: 'click', tsMs: 700, pid: 100 }),
    ];
    const rows = groupIntoComputerRuns(actions);
    expect(rows).toHaveLength(1);
    expect(rows[0].task).toBe('open Notes and write a haiku');
    expect(rows[0].actions.map((a) => a.verb)).toEqual(['click', 'describe']);
    expect(rows[0].counts).toEqual({ describe: 1, click: 1 });
    expect(rows[0].counts.run).toBeUndefined();
  });

  it('a bare verb invocation (no run marker) has no task', () => {
    const rows = groupIntoComputerRuns([action({ verb: 'apps', pid: 5 })]);
    expect(rows[0].task).toBeUndefined();
  });

  it('reports the best-known bundle and a remote --device target across the run', () => {
    const actions = [
      action({ pid: 1, tsMs: 1000, bundle: undefined, host: 'win-mini' }),
      action({ pid: 1, tsMs: 2000, bundle: 'com.apple.notes', host: undefined }),
    ];
    const rows = groupIntoComputerRuns(actions);
    expect(rows[0].bundle).toBe('com.apple.notes');
    expect(rows[0].remoteHost).toBe('win-mini');
  });

  it('links a run to its session when sessionId resolves directly', () => {
    const session = makeSession({ agent: 'codex', topic: 'fix the flaky test' });
    const rows = groupIntoComputerRuns(
      [action({ sessionId: 'sess-1234', agent: 'codex' })],
      (id) => (id === 'sess-1234' ? session : null),
    );
    expect(rows[0].linkStatus).toBe('linked');
    expect(rows[0].linkedSession).toBe(session);
  });

  it('falls back to the launchId join when sessionId does not resolve', () => {
    const session = makeSession({ agent: 'grok' });
    const rows = groupIntoComputerRuns(
      [action({ sessionId: 'stale-id', launchId: 'launch-1' })],
      () => null,
      (id) => (id === 'launch-1' ? session : null),
    );
    expect(rows[0].linkStatus).toBe('linked');
    expect(rows[0].linkedSession).toBe(session);
  });

  it('marks a run unresolved when it carries identity but no resolver finds a session', () => {
    const rows = groupIntoComputerRuns([action({ sessionId: 'ghost-id' })], () => null);
    expect(rows[0].linkStatus).toBe('unresolved');
    expect(rows[0].linkedSession).toBeUndefined();
  });

  it('marks a run unlinked when it carries no session/launch identity at all', () => {
    const rows = groupIntoComputerRuns([action({})]);
    expect(rows[0].linkStatus).toBe('unlinked');
  });
});

describe('matchesComputerSessionRow', () => {
  const session = makeSession({ agent: 'codex', topic: 'fix the flaky test', label: undefined });
  const linkedRow = groupIntoComputerRuns(
    [action({ verb: 'run', task: 'rush-2432 task text', pid: 9, sessionId: 's1' }), action({ verb: 'click', pid: 9 })],
    () => session,
  )[0];

  it('matches on task text', () => {
    expect(matchesComputerSessionRow(linkedRow, 'rush-2432')).toBe(true);
    expect(matchesComputerSessionRow(linkedRow, 'no-such-task')).toBe(false);
  });

  it('matches on the linked session agent and topic', () => {
    expect(matchesComputerSessionRow(linkedRow, 'codex')).toBe(true);
    expect(matchesComputerSessionRow(linkedRow, 'flaky test')).toBe(true);
  });

  it('matches on a driven verb', () => {
    expect(matchesComputerSessionRow(linkedRow, 'click')).toBe(true);
  });

  it('is case-insensitive and treats a blank query as match-all', () => {
    expect(matchesComputerSessionRow(linkedRow, 'CODEX')).toBe(true);
    expect(matchesComputerSessionRow(linkedRow, '  ')).toBe(true);
  });

  it('matches on machine and remote host', () => {
    const row = groupIntoComputerRuns([action({ pid: 1, hostname: 'zion', host: 'win-mini' })])[0];
    expect(matchesComputerSessionRow(row, 'zion')).toBe(true);
    expect(matchesComputerSessionRow(row, 'win-mini')).toBe(true);
  });
});

describe('formatActionCounts', () => {
  it('sorts by frequency, most common first', () => {
    expect(formatActionCounts({ click: 1, type: 5, screenshot: 2 })).toBe('type 5, screenshot 2, click 1');
  });

  it('reports the no-actions case', () => {
    expect(formatActionCounts({})).toBe('(no actions)');
  });
});

describe('renderComputerSessionRows', () => {
  it('handles the no-rows case', () => {
    expect(renderComputerSessionRows([])).toBe('No computer actions recorded.');
  });

  it('prints machine, task/bundle label, and link status', () => {
    const rows = groupIntoComputerRuns([
      action({ verb: 'run', task: 'write a haiku', pid: 1, hostname: 'zion' }),
      action({ verb: 'type', pid: 1, hostname: 'zion' }),
    ]);
    const out = renderComputerSessionRows(rows);
    expect(out).toContain('zion');
    expect(out).toContain('write a haiku');
    expect(out).toContain('unlinked');
    expect(out).toContain('type 1');
  });
});

describe('applyRowDisplayLimit', () => {
  const manyRows = (n: number): ComputerRunRow[] =>
    groupIntoComputerRuns(Array.from({ length: n }, (_, i) => action({ pid: i, tsMs: i })));

  it('shows every row and reports zero more when under the cap', () => {
    const { shown, more } = applyRowDisplayLimit(manyRows(3), 50);
    expect(shown).toHaveLength(3);
    expect(more).toBe(0);
  });

  it('caps at the given limit and reports the exact remainder — the real-history explosion (RUSH-2432 demo finding)', () => {
    // A real machine's history is mostly one standalone verb per CLI
    // invocation (one pid = one row), not `run --task` loops — an unbounded
    // flat dump against it prints hundreds of one-action rows. This pins the
    // fix found while demonstrating the feature against real history.
    const { shown, more } = applyRowDisplayLimit(manyRows(237), 50);
    expect(shown).toHaveLength(50);
    expect(more).toBe(187);
  });

  it('defaults to DEFAULT_ROW_DISPLAY_LIMIT when no limit is given', () => {
    const { shown } = applyRowDisplayLimit(manyRows(DEFAULT_ROW_DISPLAY_LIMIT + 10));
    expect(shown).toHaveLength(DEFAULT_ROW_DISPLAY_LIMIT);
  });

  it('keeps the newest rows — grouping already sorts newest-run-first', () => {
    const rows = manyRows(5); // pids 0..4, tsMs 0..4 -> newest (pid 4) first
    const { shown } = applyRowDisplayLimit(rows, 2);
    expect(shown.map((r) => r.pid)).toEqual([4, 3]);
  });
});

// ─── Ledger round-trip (real event log) ─────────────────────────────────────
// listComputerActions / buildComputerSessionRows read through the REAL
// events.ts query() path, isolated per test via _resetForTest(eventsPath()) —
// same seam lib/computer/record.ts writes through
// already use for computer.action. `emit()` always stamps the CALLING
// process's own pid (see events.ts sanitizePayload's reserved-key note), so
// every event this suite writes shares one pid and collapses to one row —
// multi-row grouping is covered above with synthetic actions instead.

describe('listComputerActions + buildComputerSessionRows (real event log)', () => {
  let dir: string;
  const savedEnv: Record<string, string | undefined> = {};
  const ENV_KEYS = ['AGENT_SESSION_ID', 'AGENTS_SESSION_ID', 'AGENT_LAUNCH_ID', 'AGENTS_AGENT_NAME', 'AGENTS_PARENT_SESSION_ID'];

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-cli-computer-sessions-'));
    for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
  });

  afterEach(() => {
    _resetForTest();
    fs.rmSync(dir, { recursive: true, force: true });
    for (const k of ENV_KEYS) {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k];
    }
  });

  function eventsPath(): string {
    return path.join(dir, 'events.jsonl');
  }

  it('reads back a run with a task marker and driving verbs as one grouped row', () => {
    for (const k of ENV_KEYS) delete process.env[k];
    _resetForTest(eventsPath());

    emit('computer.action', { command: 'run', invocationId: 'real-run', bundle: 'com.apple.notes', task: 'open Notes and write a haiku' });
    emit('computer.action', { command: 'describe', invocationId: 'real-run', targetPid: 4242, bundle: 'com.apple.notes' });
    emit('computer.action', { command: 'click', invocationId: 'real-run', targetPid: 4242, bundle: 'com.apple.notes', id: '@e3' });

    const actions = listComputerActions();
    expect(actions).toHaveLength(3);
    expect(actions.every((a) => a.pid === process.pid)).toBe(true);

    // Scope to THIS run's invocation: buildComputerSessionRows also recovers
    // runs from the durable computer_sessions table (RUSH-2549), so the machine's
    // own history legitimately contributes rows this ledger never wrote. The
    // assertion here is about grouping — three events, one row — not about how
    // much history the box happens to hold.
    const rows = buildComputerSessionRows();
    const ledgerRows = rows.filter((r) => r.invocationId === 'real-run');
    expect(ledgerRows).toHaveLength(1);
    expect(ledgerRows[0].task).toBe('open Notes and write a haiku');
    expect(ledgerRows[0].bundle).toBe('com.apple.notes');
    expect(ledgerRows[0].counts).toEqual({ describe: 1, click: 1 });
    // No AGENT_SESSION_ID/AGENT_LAUNCH_ID at emit time → no identity recorded.
    expect(ledgerRows[0].linkStatus).toBe('unlinked');
  });

  it('carries the remote --device target through to the row', () => {
    for (const k of ENV_KEYS) delete process.env[k];
    _resetForTest(eventsPath());
    emit('computer.action', { command: 'click', host: 'win-mini' });

    const rows = buildComputerSessionRows();
    expect(rows[0].remoteHost).toBe('win-mini');
  });

  it('reports unresolved for a sessionId this machine cannot index (missing-link case)', () => {
    process.env.AGENT_SESSION_ID = `nonexistent-${crypto.randomBytes(8).toString('hex')}`;
    delete process.env.AGENT_LAUNCH_ID;
    _resetForTest(eventsPath());
    emit('computer.action', { command: 'click' });

    const rows = buildComputerSessionRows();
    expect(rows[0].linkStatus).toBe('unresolved');
    expect(rows[0].sessionId).toBe(process.env.AGENT_SESSION_ID);
  });

  it('skips a corrupted ledger line instead of throwing (adversarial disk corruption)', () => {
    for (const k of ENV_KEYS) delete process.env[k];
    _resetForTest(eventsPath());
    emit('computer.action', { command: 'click' });
    fs.appendFileSync(eventsPath(), 'not valid json at all\n');
    emit('computer.action', { command: 'type', textLength: 4 });

    expect(() => listComputerActions()).not.toThrow();
    const actions = listComputerActions();
    expect(actions.map((a) => a.verb).sort()).toEqual(['click', 'type']);
  });

  it('never persists raw typed text — only the length events.ts already redacts to', () => {
    for (const k of ENV_KEYS) delete process.env[k];
    _resetForTest(eventsPath());
    const secret = 'super-secret-password-hunter2';
    emit('computer.action', { command: 'type', targetPid: 1, textLength: secret.length, committed: true });

    const recs = query({ eventTypes: ['computer.action'] });
    expect(JSON.stringify(recs)).not.toContain(secret);
  });

  it('bounds a run --task description to TASK_PREVIEW_MAX_CHARS before it is ever written', () => {
    for (const k of ENV_KEYS) delete process.env[k];
    _resetForTest(eventsPath());
    const longTask = 'x'.repeat(TASK_PREVIEW_MAX_CHARS * 5);
    emit('computer.action', { command: 'run', task: truncate(longTask, TASK_PREVIEW_MAX_CHARS) });

    const rows = buildComputerSessionRows();
    expect(rows[0].task!.length).toBeLessThanOrEqual(TASK_PREVIEW_MAX_CHARS);
    expect(JSON.stringify(query({ eventTypes: ['computer.action'] }))).not.toContain(longTask);
  });

  it('returns an empty listing rather than throwing when the ledger has no computer.action rows yet', () => {
    _resetForTest(eventsPath());
    expect(listComputerActions()).toEqual([]);
    // An empty ledger contributes no rows OF ITS OWN. Any row still present came
    // from the durable computer_sessions table, and every such row is a RECOVERED
    // one — identified by carrying recoveredActionCount (RUSH-2549). Asserting
    // on `actions.length === 0` instead would be vacuous: appendPrunedRunsFromDb
    // hardcodes `actions: []`, so that can never fail. A ledger row leaking in
    // here would have recoveredActionCount undefined, and this catches it.
    expect(() => buildComputerSessionRows()).not.toThrow();
    expect(buildComputerSessionRows().every((r) => r.recoveredActionCount !== undefined)).toBe(true);
  });

  it('the --machine filter narrows to rows on a matching hostname/remote host', () => {
    for (const k of ENV_KEYS) delete process.env[k];
    _resetForTest(eventsPath());
    emit('computer.action', { command: 'click', host: 'win-mini' });

    expect(buildComputerSessionRows({ machine: 'win-mini' })).toHaveLength(1);
    expect(buildComputerSessionRows({ machine: 'no-such-machine-anywhere' })).toHaveLength(0);
  });
});
