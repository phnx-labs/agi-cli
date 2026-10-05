
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  rollupSessionsByProject,
  isDeadStatus,
  liveDeadSplit,
  formatDeadSummary,
  enrichProjectSignals,
  sortProjectMembers,
  formatProjectMembers,
  withDefaultMachine,
  formatProjectMembersByHost,
  formatProjectWarnings,
  warningEmoji,
  MEMBERS_LINE_LIMIT,
  type ProjectMember,
} from './project-status.js';
import { stripAnsi } from './session/width.js';
import type { ProjectDef } from './projects.js';
import type { ActiveSession } from './session/active.js';

const HOME = process.env.HOME ?? os.homedir();
const defs: ProjectDef[] = [
  { name: 'rush', root: '~/src/rush' },
  { name: 'other', root: '~/src/other' },
];

function s(partial: Partial<ActiveSession>): ActiveSession {
  return { context: 'terminal', kind: 'claude', status: 'running', ...partial } as unknown as ActiveSession;
}

describe('rollupSessionsByProject', () => {
  it('groups by cwd, counts statuses, sums plan, dedups PRs and tickets', () => {
    const sessions = [
      s({ cwd: path.join(HOME, 'src/rush/apps/web'), status: 'running', todos: { done: 3, total: 5 } as never }),
      s({
        cwd: path.join(HOME, 'src/rush/.agents/worktrees/fix'),
        status: 'idle',
        todos: { done: 2, total: 2 } as never,
        pr: { url: 'https://github.com/o/r/pull/9', number: 9 } as never,
        worktree: { path: 'x' } as never,
      }),
      s({
        cwd: path.join(HOME, 'src/rush/apps/api'),
        status: 'input_required',
        pr: { url: 'https://github.com/o/r/pull/9', number: 9 } as never,
        ticket: { id: 'RUSH-1' } as never,
        createdTickets: ['RUSH-2', 'RUSH-1'],
      }),
      s({ cwd: path.join(HOME, 'src/other'), status: 'running' }),
      s({ cwd: path.join(HOME, 'src/unrelated'), status: 'running' }),
    ];
    const map = rollupSessionsByProject(defs, sessions);

    const rush = map.get('rush')!;
    expect(rush.agents).toBe(3);
    expect(rush.byStatus).toEqual({ running: 1, idle: 1, input_required: 1 });
    expect(rush.plan).toEqual({ done: 5, total: 7 });
    expect(rush.openPrs).toEqual([{ url: 'https://github.com/o/r/pull/9', number: 9 }]);
    expect(rush.tickets.sort()).toEqual(['RUSH-1', 'RUSH-2']);
    expect(rush.worktrees).toBe(1);

    expect(map.get('other')!.agents).toBe(1);
    expect(map.has('unrelated')).toBe(false);
  });

  it('carries one member per session with agent, status, ticket, and host', () => {
    const sessions = [
      s({
        cwd: path.join(HOME, 'src/rush/apps/web'),
        kind: 'claude',
        status: 'running',
        ticket: { id: 'RUSH-2107' } as never,
        machine: 'zion',
      }),
      s({ cwd: path.join(HOME, 'src/rush/apps/api'), kind: 'codex', status: 'idle', machine: 'mac-mini' }),
      s({ cwd: path.join(HOME, 'src/rush'), kind: 'gemini', status: 'queued' }),
    ];
    const rush = rollupSessionsByProject(defs, sessions).get('rush')!;
    expect(rush.members).toEqual([
      { agent: 'claude', status: 'running', ticket: 'RUSH-2107', host: 'zion' },
      { agent: 'codex', status: 'idle', host: 'mac-mini' },
      { agent: 'gemini', status: 'queued' },
    ]);
    expect(rush.plan).toEqual({ done: 0, total: 0 });
  });

  it('is empty when no session matches a project', () => {
    const map = rollupSessionsByProject(defs, [s({ cwd: path.join(HOME, 'elsewhere') })]);
    expect(map.size).toBe(0);
  });
});

describe('liveDeadSplit', () => {
  it('counts orphaned as LIVE — it is an agent that outlived its window', () => {
    const s = liveDeadSplit({ running: 13, idle: 2, orphaned: 5, crashed: 19 });
    expect(s.live).toBe(20);
    expect(s.dead).toBe(19);
  });

  it('breaks the dead down, biggest first', () => {
    const s = liveDeadSplit({ running: 1, crashed: 19, closed: 3 });
    expect(s.deadByStatus).toEqual([
      { status: 'crashed', n: 19 },
      { status: 'closed', n: 3 },
    ]);
  });

  it('classifies every ActiveStatus, not just the common ones', () => {
    const s = liveDeadSplit({
      running: 1, idle: 1, queued: 1, input_required: 1, orphaned: 1, abandoned: 1, unknown: 1,
      closed: 1, crashed: 1,
    });
    expect(s.live).toBe(7);
    expect(s.dead).toBe(2);
  });

  it('handles an empty or all-live project', () => {
    expect(liveDeadSplit({})).toEqual({ live: 0, dead: 0, deadByStatus: [] });
    expect(liveDeadSplit({ running: 4 })).toEqual({ live: 4, dead: 0, deadByStatus: [] });
  });

  it('ignores zero counts rather than emitting empty buckets', () => {
    expect(liveDeadSplit({ running: 2, crashed: 0 }).deadByStatus).toEqual([]);
  });
});

describe('formatDeadSummary', () => {
  const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '');

  it('names the status directly when every dead session shares one', () => {
    expect(strip(formatDeadSummary(liveDeadSplit({ running: 1, crashed: 41 })))).toBe('41 crashed');
    expect(strip(formatDeadSummary(liveDeadSplit({ closed: 5 })))).toBe('5 closed');
  });

  it('keeps the generic phrase + breakdown only when statuses differ', () => {
    expect(strip(formatDeadSummary(liveDeadSplit({ crashed: 19, closed: 3 })))).toBe(
      '22 finished or lost (19 crashed, 3 closed)',
    );
  });
});

describe('isDeadStatus — keeps the agents roster consistent with the headline', () => {
  const EVERY_STATUS = [
    'running', 'idle', 'queued', 'input_required',
    'orphaned', 'abandoned', 'unknown',
    'closed', 'crashed',
  ];

  it('agrees with liveDeadSplit on every ActiveStatus', () => {
    const keptByRoster = EVERY_STATUS.filter((s) => !isDeadStatus(s)).length;
    const split = liveDeadSplit(Object.fromEntries(EVERY_STATUS.map((s) => [s, 1])));
    expect(keptByRoster).toBe(split.live);
  });

  it('drops exactly the statuses the dead row already accounts for', () => {
    expect(isDeadStatus('crashed')).toBe(true);
    expect(isDeadStatus('closed')).toBe(true);
    expect(isDeadStatus('orphaned')).toBe(false);
    expect(isDeadStatus('running')).toBe(false);
  });
});

describe('sortProjectMembers', () => {
  it('orders running → idle → input_required → queued → rest, agent asc within a state', () => {
    const members: ProjectMember[] = [
      { agent: 'grok', status: 'unknown' },
      { agent: 'zed', status: 'idle' },
      { agent: 'codex', status: 'running' },
      { agent: 'claude', status: 'running' },
      { agent: 'gemini', status: 'input_required' },
      { agent: 'amp', status: 'queued' },
      { agent: 'droid', status: 'abandoned' },
    ];
    expect(sortProjectMembers(members).map((m) => m.agent)).toEqual([
      'claude',
      'codex',
      'zed',
      'gemini',
      'amp',
      'droid',
      'grok',
    ]);
  });

  it('does not mutate the input', () => {
    const members: ProjectMember[] = [
      { agent: 'b', status: 'idle' },
      { agent: 'a', status: 'running' },
    ];
    sortProjectMembers(members);
    expect(members.map((m) => m.agent)).toEqual(['b', 'a']);
  });
});

describe('formatProjectMembers', () => {
  it('renders agent · status · ticket @host cells joined by a wide dot', () => {
    const line = stripAnsi(
      formatProjectMembers([
        { agent: 'codex', status: 'idle', host: 'mac-mini' },
        { agent: 'claude', status: 'running', ticket: 'RUSH-2107', host: 'zion' },
      ]),
    );
    expect(line).toBe('claude · running · RUSH-2107 @zion  ·  codex · idle @mac-mini');
  });

  it('caps at MEMBERS_LINE_LIMIT with a +N more tail, sorted so the live ones show', () => {
    const members: ProjectMember[] = Array.from({ length: MEMBERS_LINE_LIMIT + 2 }, (_, i) => ({
      agent: `agent${i}`,
      status: i === MEMBERS_LINE_LIMIT + 1 ? 'running' : 'idle',
    }));
    const line = stripAnsi(formatProjectMembers(members));
    expect(line.startsWith(`agent${MEMBERS_LINE_LIMIT + 1} · running`)).toBe(true);
    expect(line.endsWith('+2 more')).toBe(true);
    expect(line.split('·').length).toBeGreaterThan(2);
  });

  it('is empty for no members', () => {
    expect(formatProjectMembers([])).toBe('');
  });

  it('collapses identical cells to one ×N cell — a same-harness fleet is one fact', () => {
    const members: ProjectMember[] = [
      ...Array.from({ length: 14 }, () => ({ agent: 'claude', status: 'running', host: 'zion' })),
      { agent: 'codex', status: 'idle', host: 'mac-mini' },
      { agent: 'claude', status: 'running', ticket: 'RUSH-2107', host: 'zion' },
    ];
    const line = stripAnsi(formatProjectMembers(members));
    expect(line).toBe('claude · running @zion ×14  ·  claude · running · RUSH-2107 @zion  ·  codex · idle @mac-mini');
  });

  it('the +N tail counts members, not cells, when collapsed groups are capped', () => {
    const members: ProjectMember[] = [
      ...Array.from({ length: 30 }, () => ({ agent: 'claude', status: 'running' })),
      ...Array.from({ length: MEMBERS_LINE_LIMIT }, (_, i) => ({ agent: `agent${i}`, status: 'idle' })),
    ];
    expect(stripAnsi(formatProjectMembers(members)).endsWith('+1 more')).toBe(true);
  });
});

describe('enrichProjectSignals — artifact counting from the activity log', () => {
  let actDir: string;
  const NOW = 1_754_000_000_000;
  const def: ProjectDef = { name: 'rush', root: '~/src/rush' };

  beforeEach(() => {
    actDir = fs.mkdtempSync(path.join(os.tmpdir(), 'act-'));
  });
  afterEach(() => fs.rmSync(actDir, { recursive: true, force: true }));

  const ev = (tsMs: number, cwd: string, detail: string) =>
    JSON.stringify({
      v: 1,
      ts: new Date(tsMs).toISOString(),
      event: 'artifact.created',
      tier: 'milestone',
      sessionId: 's1',
      cwd,
      detail,
    });

  it('counts only this project’s in-window artifacts, newest detail surfaced', async () => {
    const inWin = NOW - 2 * 86_400_000;
    const newest = NOW - 3600_000;
    const outWin = NOW - 30 * 86_400_000;
    const rushCwd = path.join(HOME, 'src/rush/apps/web');
    fs.writeFileSync(
      path.join(actDir, 's1.jsonl'),
      [
        ev(inWin, rushCwd, 'a.html'),
        ev(newest, rushCwd, 'newest.html'),
        ev(outWin, rushCwd, 'old.html'),
        ev(inWin, path.join(HOME, 'src/other'), 'other.html'),
      ].join('\n') + '\n',
    );

    const sig = await enrichProjectSignals(def, 7, NOW, { activityRoot: actDir, skipRemote: true });
    expect(sig.artifacts).toBe(2);
    expect(sig.lastArtifact).toBe('newest.html');
    expect(sig.mergedPrs).toBe(0);
    expect(sig.windowDays).toBe(7);
  });

  it('is zero when nothing matches, and never throws on a missing log dir', async () => {
    const sig = await enrichProjectSignals(def, 7, NOW, {
      activityRoot: path.join(actDir, 'nope'),
      skipRemote: true,
    });
    expect(sig.artifacts).toBe(0);
    expect(sig.lastArtifact).toBeUndefined();
  });
});

describe('formatProjectMembersByHost', () => {
  it('groups cells under each host without repeating @host on the cell', () => {
    const lines = formatProjectMembersByHost([
      { agent: 'claude', status: 'running', host: 'zion' },
      { agent: 'claude', status: 'running', host: 'zion' },
      { agent: 'claude', status: 'idle', host: 'zion' },
      { agent: 'codex', status: 'running', host: 'yosemite-s0' },
      { agent: 'claude', status: 'running', ticket: 'RUSH-1', host: 'yosemite-s0' },
    ]).map(stripAnsi);
    expect(lines[0]).toMatch(/^@zion\s+claude · running ×2  ·  claude · idle$/);
    expect(lines[1]).toMatch(/^@yosemite-s0\s+claude · running · RUSH-1  ·  codex · running$/);
  });

  it('falls back to the flat line when no member carries a host', () => {
    const lines = formatProjectMembersByHost([
      { agent: 'claude', status: 'running' },
      { agent: 'claude', status: 'running' },
    ]).map(stripAnsi);
    expect(lines).toEqual(['claude · running ×2']);
  });

  it('ranks hosts by member count so the busiest box is first', () => {
    const lines = formatProjectMembersByHost([
      { agent: 'claude', status: 'idle', host: 'mac-mini' },
      { agent: 'claude', status: 'running', host: 'zion' },
      { agent: 'claude', status: 'running', host: 'zion' },
      { agent: 'claude', status: 'running', host: 'zion' },
    ]).map(stripAnsi);
    expect(lines[0].startsWith('@zion')).toBe(true);
    expect(lines[1].startsWith('@mac-mini')).toBe(true);
  });
});

describe('formatProjectWarnings', () => {
  it('prints critical before continue with severity emojis', () => {
    const lines = formatProjectWarnings([
      { severity: 'continue', text: 'dirty tree' },
      { severity: 'critical', text: '40 behind', remediation: 'pull first' },
    ]).map(stripAnsi);
    expect(lines[0]).toBe(`  ${warningEmoji('critical')}  40 behind`);
    expect(lines[1]).toBe('      pull first');
    expect(lines[2]).toBe(`  ${warningEmoji('continue')}  dirty tree`);
  });

  it('is empty when there is nothing to say', () => {
    expect(formatProjectWarnings([])).toEqual([]);
  });
});

describe('withDefaultMachine', () => {
  it('fills only missing machine stamps so local rows match peer host ids', () => {
    const out = withDefaultMachine(
      [
        { id: 'a', machine: undefined },
        { id: 'b', machine: 'yosemite-s0' },
        { id: 'c' },
      ],
      'zion',
    );
    expect(out.map((s) => s.machine)).toEqual(['zion', 'yosemite-s0', 'zion']);
  });

  it('makes host-grouped roster use the real local name, not @local', () => {
    const sessions = withDefaultMachine(
      [
        { kind: 'claude', status: 'running' as const, cwd: '/x', machine: undefined },
        { kind: 'claude', status: 'idle' as const, cwd: '/x', machine: 'yosemite-s0' },
      ],
      'zion',
    );
    const members = sessions.map((s) => ({
      agent: s.kind,
      status: s.status,
      host: s.machine,
    }));
    const lines = formatProjectMembersByHost(members).map((l) => l.replace(/\x1b\[[0-9;]*m/g, ''));
    expect(lines.some((l) => l.startsWith('@zion'))).toBe(true);
    expect(lines.some((l) => l.startsWith('@yosemite-s0'))).toBe(true);
    expect(lines.some((l) => l.includes('@local'))).toBe(false);
  });
});
