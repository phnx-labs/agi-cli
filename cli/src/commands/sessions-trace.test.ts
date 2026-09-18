import { describe, it, expect } from 'vitest';
import { Command } from 'commander';
import {
  chooseFormat,
  decideTraceLayout,
  buildTraceEnvelope,
  buildCompareTraceEnvelope,
  buildLineageTraceEnvelope,
  registerSessionsTraceCommand,
  registerTraceCommand,
  renderSessionSteps,
  SESSIONS_TRACE_SCHEMA_VERSION,
} from './sessions-trace.js';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildTrajectory } from '@phnx-labs/sessions-cli/reader';
import { diffTrajectories } from '@phnx-labs/sessions-cli/reader';
import { buildLineage } from '@phnx-labs/sessions-cli/reader';
import type { SessionEvent, SessionMeta } from '@phnx-labs/sessions-cli/reader';

function meta(overrides: Partial<SessionMeta> = {}): SessionMeta {
  return { id: 'sess-0001', shortId: 'sess0001', agent: 'claude', timestamp: '2026-08-01T00:00:00Z', filePath: '/tmp/s.jsonl', ...overrides };
}

describe('decideTraceLayout — keyed on selector count, not resolved count', () => {
  it('one selector resolving to one session → single', () => {
    expect(decideTraceLayout({}, 1, 1)).toBe('single');
  });
  it('two selectors each resolving to one → compare', () => {
    expect(decideTraceLayout({}, 2, 2)).toBe('compare');
  });
  it('the blocker: ONE selector resolving to TWO sessions fails loud, never a silent compare', () => {
    expect(() => decideTraceLayout({}, 1, 2)).toThrow(/matched — pass a more specific selector/);
  });
  it('--compare with one selector fails loud', () => {
    expect(() => decideTraceLayout({ compare: true }, 1, 1)).toThrow(/needs exactly two selectors/);
  });
  it('three or more selectors fail loud', () => {
    expect(() => decideTraceLayout({}, 3, 3)).toThrow(/needs exactly two selectors/);
  });
  it('two selectors that resolve to a wrong count (ambiguous / same) fail loud', () => {
    expect(() => decideTraceLayout({}, 2, 3)).toThrow(/must match exactly one session/);
    expect(() => decideTraceLayout({}, 2, 1)).toThrow(/must match exactly one session/);
  });
  it('--tree with one selector resolving to one session → lineage (PR3)', () => {
    expect(decideTraceLayout({ tree: true }, 1, 1)).toBe('lineage');
  });
  it('--tree roots at ONE session — more selectors fail loud', () => {
    expect(() => decideTraceLayout({ tree: true }, 2, 2)).toThrow(/Lineage roots at ONE session/);
  });
  it('--tree with an ambiguous selector fails loud rather than guessing a root', () => {
    expect(() => decideTraceLayout({ tree: true }, 1, 3)).toThrow(/must match exactly one session to root a lineage/);
  });
  it('--tree and --compare together fail loud — they are different layouts', () => {
    expect(() => decideTraceLayout({ tree: true, compare: true }, 1, 1)).toThrow(/different layouts/);
  });
});

describe('chooseFormat — audience auto-selection', () => {
  it('explicit flags always win', () => {
    expect(chooseFormat({ json: true }, true)).toBe('json');
    expect(chooseFormat({ html: true }, false)).toBe('html');
    expect(chooseFormat({ text: true }, true)).toBe('text');
  });
  it('defaults to HTML on a TTY (a person) and text when piped (an agent)', () => {
    expect(chooseFormat({}, true)).toBe('html');
    expect(chooseFormat({}, false)).toBe('text');
  });
});

describe('buildTraceEnvelope — the --json contract', () => {
  it('emits the versioned single-layout envelope', () => {
    const events: SessionEvent[] = [
      { type: 'tool_use', agent: 'claude', timestamp: '2026-08-01T00:00:00Z', tool: 'Bash', callId: 'c1', command: 'ls' },
      { type: 'tool_result', agent: 'claude', timestamp: '2026-08-01T00:00:01Z', tool: 'Bash', callId: 'c1', outcome: 'ok' },
    ];
    const envelope = buildTraceEnvelope([buildTrajectory(events, meta())]);
    expect(envelope.schemaVersion).toBe(SESSIONS_TRACE_SCHEMA_VERSION);
    expect(envelope.kind).toBe('sessions-trace');
    expect(envelope.layout).toBe('single');
    expect(envelope.sessions).toHaveLength(1);
    const model = envelope.sessions[0];
    expect(model.session.id).toBe('sess-0001');
    expect(model.steps[0].tool).toBe('Bash');
    expect(model).toHaveProperty('gaps');
    expect(model).toHaveProperty('programTimeShare');
    expect(model).toHaveProperty('stats');
  });
});

describe('buildCompareTraceEnvelope — the --json compare contract', () => {
  it('emits the versioned compare-layout envelope with both trajectories and the diff', () => {
    const eventsA: SessionEvent[] = [
      { type: 'tool_use', agent: 'claude', timestamp: '2026-08-01T00:00:00Z', tool: 'Bash', callId: 'a1', command: 'ls' },
      { type: 'tool_result', agent: 'claude', timestamp: '2026-08-01T00:00:01Z', tool: 'Bash', callId: 'a1', outcome: 'ok' },
    ];
    const eventsB: SessionEvent[] = [
      { type: 'tool_use', agent: 'codex', timestamp: '2026-08-01T00:00:00Z', tool: 'Grep', callId: 'b1', args: { pattern: 'x' } },
      { type: 'tool_result', agent: 'codex', timestamp: '2026-08-01T00:00:01Z', tool: 'Grep', callId: 'b1', outcome: 'ok' },
    ];
    const a = buildTrajectory(eventsA, meta({ id: 'a', agent: 'claude' }));
    const b = buildTrajectory(eventsB, meta({ id: 'b', agent: 'codex' }));
    const envelope = buildCompareTraceEnvelope(diffTrajectories(a, b));
    expect(envelope.schemaVersion).toBe(SESSIONS_TRACE_SCHEMA_VERSION);
    expect(envelope.kind).toBe('sessions-trace');
    expect(envelope.layout).toBe('compare');
    expect(envelope.sessions).toHaveLength(2);
    expect(envelope.sessions[0].session.id).toBe('a');
    expect(envelope.sessions[1].session.id).toBe('b');
    expect(envelope.diff).toBeDefined();
    expect(envelope.diff!.divergence).toBeDefined();
    expect(envelope.diff!.summaryA.session.id).toBe('a');
    expect(envelope.diff!.summaryB.session.id).toBe('b');
  });
});

describe('buildLineageTraceEnvelope — the --json lineage contract', () => {
  it('emits the versioned lineage-layout envelope with nodes, edges, and the root trajectory', () => {
    const events: SessionEvent[] = [
      { type: 'tool_use', agent: 'claude', timestamp: '2026-08-01T00:00:00Z', tool: 'Task', callId: 'c1', args: { description: 'spawn' } },
      { type: 'tool_result', agent: 'claude', timestamp: '2026-08-01T00:00:01Z', tool: 'Task', callId: 'c1', outcome: 'ok' },
    ];
    const root = meta({ id: 'orch-0001', shortId: 'orch0001', toolCallCount: 22 });
    const kid = meta({
      id: 'mate-0001',
      shortId: 'mate0001',
      agent: 'codex',
      toolCallCount: 31,
      isTeamOrigin: true,
      teamOrigin: { handle: 'auth', team: 'fleet-resume', parentSessionId: 'orch-0001', startedAt: '2026-08-01T00:00:00Z', source: 'meta' },
    });
    const lineage = buildLineage([root, kid], { rootId: root.id, now: Date.parse('2026-08-01T00:10:00Z') });
    const envelope = buildLineageTraceEnvelope(lineage, buildTrajectory(events, root));

    expect(envelope.schemaVersion).toBe(SESSIONS_TRACE_SCHEMA_VERSION);
    expect(envelope.kind).toBe('sessions-trace');
    expect(envelope.layout).toBe('lineage');
    expect(envelope.sessions).toHaveLength(1);
    expect(envelope.sessions[0].session.id).toBe('orch-0001');
    expect(envelope.lineage).toBeDefined();
    expect(envelope.lineage!.rootId).toBe('orch-0001');
    expect(envelope.lineage!.nodes.map((n) => n.id)).toEqual(['orch-0001', 'mate-0001']);
    expect(envelope.lineage!.nodes[1].toolCount).toBe(31);
    expect(envelope.lineage!.edges).toEqual([{ parent: 'orch-0001', child: 'mate-0001', source: 'parentSessionId' }]);
    expect(envelope.lineage!.teams).toEqual(['fleet-resume']);
    // An inline Task tool_use in the root transcript is a STEP, never a node.
    expect(envelope.sessions[0].steps[0].delegation).toBe('inline-task');
    expect(envelope.lineage!.nodes).toHaveLength(2);
  });
});

describe('command registration', () => {
  function optionNames(cmd: Command): string[] {
    return cmd.options.map((o) => o.long ?? o.short ?? '');
  }

  it('registers the canonical `sessions trace` with the audience/rendering flags', () => {
    const sessions = new Command('sessions');
    registerSessionsTraceCommand(sessions);
    const trace = sessions.commands.find((c) => c.name() === 'trace');
    expect(trace).toBeTruthy();
    const opts = optionNames(trace!);
    for (const flag of ['--html', '--text', '--json', '--output', '--no-open', '--errors-only', '--steps', '--no-redact', '--compare', '--tree']) {
      expect(opts).toContain(flag);
    }
  });

  it('registers the top-level `agents trace` alias with the same shape', () => {
    const program = new Command('agents');
    registerTraceCommand(program);
    const trace = program.commands.find((c) => c.name() === 'trace');
    expect(trace).toBeTruthy();
    expect(optionNames(trace!)).toContain('--json');
  });
});


describe('--steps — the narration-anchored step list as text (PHNX-3939)', () => {
  // A real Claude session (c9d700d5), redacted and value-capped, committed as a
  // fixture beside the session library.
  const FIXTURE = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    '..', 'lib', 'session', 'testdata', 'timeline-claude.jsonl',
  );

  it('prints one line per step with the offset, source, headline and counts', () => {
    const out = renderSessionSteps(meta({ id: 'c9d700d5', shortId: 'c9d700d5', filePath: FIXTURE }));
    const lines = out.trimEnd().split('\n');
    // The session opened with a `/continue <id>` turn.
    expect(lines[0]).toMatch(/^\s*1\s+\+0s\s+user\s+\/continue 8231082e$/);
    // A narration beat carries its counts as the sidebar renders them.
    expect(lines.some((line) => /narr\s+.+·\s+\d+ \w+/.test(line))).toBe(true);
    // Milestones ride the same detail column.
    expect(out).toContain('worktree created');
    // The footer totals the whole session.
    expect(lines[lines.length - 1]).toMatch(/^\d+ steps · \d+ tools/);
  });

  it('says so plainly for a harness that writes no parseable transcript', () => {
    // OpenClaw: `parseSession` returns no events, so there is nothing to fold —
    // and the command says that rather than printing an empty, authoritative list.
    const out = renderSessionSteps(meta({ id: 'claw0001', shortId: 'claw0001', agent: 'openclaw', filePath: FIXTURE }));
    expect(out).toContain('No steps folded for claw0001');
  });

  // `--steps` short-circuits before `buildTrajectory`, so it has to honour the
  // command's own `--redact` default itself — otherwise `trace <id> --steps -o
  // out.txt` writes an unredacted artifact while `--no-redact` advertises that
  // redaction is on by default (review BLOCKER 1c).
  const REDACTION_FIXTURE = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    '..', 'lib', 'session', 'testdata', 'timeline-redaction-claude.jsonl',
  );
  const redactionMeta = meta({ id: 'redact01', shortId: 'redact01', filePath: REDACTION_FIXTURE });

  it('redacts secrets and terminal escapes by default', () => {
    const out = renderSessionSteps(redactionMeta);
    expect(out).not.toContain('sk-ant-api03-AAAABBBBCCCC');
    expect(out.includes('\u001b')).toBe(false);
  });

  it('keeps the raw text only when the caller passed --no-redact', () => {
    const out = renderSessionSteps(redactionMeta, { redact: false });
    expect(out).toContain('sk-ant-api03-AAAABBBBCCCC');
    // --no-redact buys skipping SECRET redaction, never raw control characters.
    expect(out.includes('\u001b')).toBe(false);
  });
});
