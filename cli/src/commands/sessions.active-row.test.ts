import { describe, it, expect } from 'vitest';
import {
  renderActiveRowLines,
  backfillActiveRowsFromMeta,
  filterActiveSessionsByRoutine,
} from './sessions.js';
import { stringWidth } from '../lib/session/width.js';
import type { ActiveSession } from '../lib/session/active.js';
import type { SessionMeta } from '../lib/session/types.js';

/**
 * RUSH-2205 enriched the live `--orphan`/`--active` row: agent version, a human
 * created/idle time cell, and ticket/PR badges backfilled from the historical
 * index, with the label/topic on its own line — all width-safe. These pin the
 * pure row builder (content + width) and the pure meta-backfill join.
 */

const DAY = 86_400_000;

function active(over: Partial<ActiveSession> = {}): ActiveSession {
  return {
    kind: 'claude',
    status: 'orphaned',
    sessionId: '2f8a96e5-1111-2222-3333-444455556666',
    cwd: '/home/u/src/agents-cli',
    ...over,
  } as ActiveSession;
}

describe('renderActiveRowLines', () => {
  it('line 1 shows version + created/idle + ticket/PR; line 2 carries the label/topic', () => {
    const now = Date.now();
    const s = active({
      version: '2.1.207',
      startedAtMs: now - (6 * DAY + 3_600_000),
      lastActivityMs: now - (3 * DAY + 3_600_000),
      owner: 'muqsit@getrush.ai',
      ticket: { id: 'RUSH-2198' },
      pr: { url: 'https://github.com/phnx-labs/agents-cli/pull/2091', number: 2091 },
      topic: 'picker preview collapses to empty',
    });
    const [line1, line2] = renderActiveRowLines(s, '  ', 120);

    expect(line1).toContain('2.1.207');
    expect(line1).toContain('created 6d');
    expect(line1).toContain('idle 3d');
    expect(line1).toContain('RUSH-2198');
    expect(line1).toContain('PR#2091');
    // The label/topic is on its own line, not buried in a grey snippet.
    expect(line2).toContain('picker preview collapses to empty');
  });

  it('keeps every line within terminal width (no wrap under tmux/SSH), even when narrow', () => {
    const now = Date.now();
    const s = active({
      version: '2.1.207',
      startedAtMs: now - 6 * DAY,
      lastActivityMs: now - 3 * DAY,
      owner: 'muqsit@getrush.ai',
      ticket: { id: 'RUSH-2198' },
      pr: { url: 'https://github.com/phnx-labs/agents-cli/pull/2091', number: 2091 },
      topic: 'a very long topic '.repeat(20).trim(),
    });
    for (const termW of [40, 60, 80, 120]) {
      for (const line of renderActiveRowLines(s, '  ', termW)) {
        expect(stringWidth(line), `width ${termW} overflow: <${line}>`).toBeLessThanOrEqual(termW);
      }
    }
  });

  it('renders a dim secondary line for a pending question / needs-you (PHNX-3797)', () => {
    const q = active({
      status: 'input_required',
      topic: 'add a widget',
      importantMessage: { text: 'Which region should I deploy to?', kind: 'question' },
    });
    const lines = renderActiveRowLines(q, '  ', 120);
    // header + identity + the ranked secondary line.
    expect(lines).toHaveLength(3);
    expect(lines[2]).toContain('Which region should I deploy to?');

    const n = active({
      status: 'input_required',
      topic: 'ship it',
      importantMessage: { text: 'Waiting for you', kind: 'needs_you' },
    });
    expect(renderActiveRowLines(n, '  ', 120).join('\n')).toContain('Waiting for you');
  });

  it('adds no secondary line for plain activity — the preview already carries it', () => {
    const a = active({
      status: 'running',
      topic: 'edit the db',
      importantMessage: { text: 'editing db.ts', kind: 'activity' },
    });
    const lines = renderActiveRowLines(a, '  ', 120);
    expect(lines).toHaveLength(2); // header + identity only
    expect(lines.join('\n')).not.toContain('editing db.ts');
  });

  it('keeps the secondary question line within terminal width', () => {
    const q = active({
      status: 'input_required',
      topic: 'a very long topic '.repeat(20).trim(),
      importantMessage: { text: 'Which region should I deploy to? '.repeat(12).trim(), kind: 'question' },
    });
    for (const termW of [40, 60, 80, 120]) {
      for (const line of renderActiveRowLines(q, '  ', termW)) {
        expect(stringWidth(line), `width ${termW} overflow: <${line}>`).toBeLessThanOrEqual(termW);
      }
    }
  });

  it('emits a single line when there is no label/topic/project/locator to show', () => {
    // cwd cleared too: formatActiveRowDescription surfaces the project (basename cwd)
    // when present, which would otherwise fill line 2.
    const s = active({ topic: undefined, label: undefined, cwd: undefined, status: 'idle' });
    expect(renderActiveRowLines(s, '  ', 120)).toHaveLength(1);
  });

  // RUSH-2336: every process-backed row now surfaces its exact machine + pid
  // handle; a cloud row surfaces its provider + task id instead of a pid.
  it('shows the custom-harness name instead of the host process (PHNX-2935)', () => {
    const [line1] = renderActiveRowLines(
      active({ kind: 'claude', harness: 'deepseek', cwd: undefined, topic: undefined, label: undefined }),
      '  ',
      120,
    );
    expect(line1).toContain('deepseek');
    expect(line1).not.toMatch(/\bclaude\b/);
  });

  it('shows a machine:pid locator for a process row', () => {
    const s = active({ context: 'terminal', machine: 'yosemite-s0', pid: 48213, cwd: undefined, topic: undefined, label: undefined });
    const lines = renderActiveRowLines(s, '  ', 120);
    expect(lines.join('\n')).toContain('yosemite-s0:pid 48213');
  });

  it('shows a provider · task-id locator for a cloud row, never a fabricated pid', () => {
    const s = active({
      context: 'cloud',
      cloudProvider: 'rush',
      cloudTaskId: 'task-abcdef1234567890',
      cwd: undefined,
      topic: undefined,
      label: undefined,
    });
    const lines = renderActiveRowLines(s, '  ', 120);
    expect(lines.join('\n')).toContain('rush · task-abcdef1');
    expect(lines.join('\n')).not.toMatch(/pid \d/);
  });

  it('keeps the machine:pid / provider · task-id locator width-safe at every common terminal width', () => {
    const now = Date.now();
    const process_ = active({
      context: 'terminal',
      version: '2.1.207',
      machine: 'yosemite-s0',
      pid: 48213,
      startedAtMs: now - 6 * DAY,
      lastActivityMs: now - 3 * DAY,
      ticket: { id: 'RUSH-2198' },
      pr: { url: 'https://github.com/phnx-labs/agents-cli/pull/2091', number: 2091 },
      topic: 'a very long topic '.repeat(20).trim(),
    });
    const cloud = active({
      context: 'cloud',
      cloudProvider: 'rush',
      cloudTaskId: 'task-abcdef1234567890',
      version: '2.1.207',
      startedAtMs: now - 6 * DAY,
      lastActivityMs: now - 3 * DAY,
      topic: 'a very long topic '.repeat(20).trim(),
    });
    for (const s of [process_, cloud]) {
      for (const termW of [40, 60, 80, 120]) {
        for (const line of renderActiveRowLines(s, '  ', termW)) {
          expect(stringWidth(line), `width ${termW} overflow: <${line}>`).toBeLessThanOrEqual(termW);
        }
      }
    }
  });
});

function meta(over: Partial<SessionMeta> = {}): SessionMeta {
  return {
    id: '2f8a96e5-1111-2222-3333-444455556666',
    shortId: '2f8a96e5',
    agent: 'claude',
    timestamp: '2026-07-30T10:00:00.000Z',
    filePath: '/home/u/.agents/.history/sessions/2f8a96e5.jsonl',
    ...over,
  };
}

describe('backfillActiveRowsFromMeta', () => {
  it('fills identity, refs, metrics, and fan-out onto a live row that lacks them', () => {
    const s = active({ sessionId: 'sid-1', version: undefined, account: undefined, ticket: undefined, pr: undefined, label: undefined, startedAtMs: undefined });
    const byId = new Map<string, SessionMeta>([
      ['sid-1', meta({ id: 'sid-1', version: '2.1.207', account: 'muqsit@getrush.ai', label: 'refresh auth', firstUserMessage: 'Fix auth\nand keep the full acceptance criteria.', ticketId: 'RUSH-2198', prUrl: 'https://github.com/o/r/pull/2091', prNumber: 2091, timestamp: '2026-07-30T10:00:00.000Z', tokenCount: 42_000, durationMs: 90_000, subAgentCount: 3 })],
    ]);
    backfillActiveRowsFromMeta([s], byId);
    expect(s.version).toBe('2.1.207');
    // account rides the same index backfill as version (PHNX-3184) so the watch
    // row carries it and the AGI EXT status bar reads it off the stream instead
    // of spawning a per-tab `agents sessions <id> --device <host> --json`.
    expect(s.account).toBe('muqsit@getrush.ai');
    expect(s.label).toBe('refresh auth');
    expect(s.firstUserMessage).toBe('Fix auth\nand keep the full acceptance criteria.');
    expect(s.ticket?.id).toBe('RUSH-2198');
    expect(s.pr?.number).toBe(2091);
    expect(s.pr?.url).toContain('/pull/2091');
    expect(s.startedAtMs).toBe(Date.parse('2026-07-30T10:00:00.000Z'));
    expect(s.tokenCount).toBe(42_000);
    expect(s.durationMs).toBe(90_000);
    expect(s.subAgentCount).toBe(3);
  });

  it('backfills routine provenance for every active JSON consumer', () => {
    const s = active({ sessionId: 'sid-routine', origin: undefined, routineName: undefined });
    const byId = new Map<string, SessionMeta>([
      ['sid-routine', meta({ id: 'sid-routine', origin: 'routine', routineName: 'nightly-review' })],
    ]);
    backfillActiveRowsFromMeta([s], byId);
    expect(s.origin).toBe('routine');
    expect(s.routineName).toBe('nightly-review');
  });

  it('never overrides a value the live row already carries (live wins)', () => {
    const s = active({ sessionId: 'sid-2', version: '9.9.9', account: 'live@getrush.ai', ticket: { id: 'LIVE-1' }, startedAtMs: 111 });
    const byId = new Map<string, SessionMeta>([
      ['sid-2', meta({ id: 'sid-2', version: '2.1.207', account: 'index@getrush.ai', ticketId: 'RUSH-2198', timestamp: '2026-07-30T10:00:00.000Z' })],
    ]);
    backfillActiveRowsFromMeta([s], byId);
    expect(s.version).toBe('9.9.9');
    expect(s.account).toBe('live@getrush.ai');
    expect(s.ticket?.id).toBe('LIVE-1');
    expect(s.startedAtMs).toBe(111);
  });

  it('leaves a row untouched when no meta matches its id', () => {
    const s = active({ sessionId: 'sid-3', version: undefined });
    backfillActiveRowsFromMeta([s], new Map());
    expect(s.version).toBeUndefined();
  });
});

describe('filterActiveSessionsByRoutine', () => {
  const sessions = [
    active({ sessionId: 'nightly', origin: 'routine', routineName: 'nightly-review' }),
    active({ sessionId: 'release', origin: 'routine', routineName: 'release-notes' }),
    active({ sessionId: 'manual', origin: 'cli', routineName: undefined }),
  ];

  it('keeps every routine and excludes manually-launched rows for --routine', () => {
    expect(filterActiveSessionsByRoutine(sessions, true).map((session) => session.sessionId))
      .toEqual(['nightly', 'release']);
  });

  it('fuzzy-resolves a named routine for non-browser active output', () => {
    expect(filterActiveSessionsByRoutine(sessions, 'nightly').map((session) => session.sessionId))
      .toEqual(['nightly']);
  });

  it('leaves active output unchanged when no routine filter was requested', () => {
    expect(filterActiveSessionsByRoutine(sessions, undefined)).toBe(sessions);
  });
});
