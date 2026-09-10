import { describe, it, expect } from 'vitest';
import * as path from 'node:path';
import type { SessionEvent } from './types.js';
import {
  inferActivity,
  inferSessionState,
  detectWorktree,
  detectTicket,
  extractPrUrl,
  isPrCreateCommand,
  detectDurableSignals,
  detectSpawnedTeam,
  isTicketCreateTool,
  extractCreatedTicket,
  structuredQuestionFromAsk,
  extractTodoProgress,
  extractTodoProgressFromEvents,
  extractRecentDirectoriesTouched,
} from './state.js';

const now = Date.now();
const fresh = now - 5_000;      // within the 2-min window
const stale = now - 20 * 60_000; // well outside

function msg(role: 'user' | 'assistant', content: string): SessionEvent {
  return { type: 'message', agent: 'claude', timestamp: '', role, content };
}
function tool(toolName: string, args: Record<string, any> = {}, command?: string): SessionEvent {
  return { type: 'tool_use', agent: 'claude', timestamp: '', tool: toolName, args, command };
}
function toolResult(toolName: string, output: string): SessionEvent {
  return { type: 'tool_result', agent: 'claude', timestamp: '', tool: toolName, success: true, output };
}

describe('inferActivity — waiting signals', () => {
  it('ExitPlanMode as the last event ⇒ waiting / plan_review', () => {
    const s = inferActivity([msg('user', 'plan it'), tool('ExitPlanMode')], { pidAlive: true, mtimeMs: fresh });
    expect(s.activity).toBe('waiting_input');
    expect(s.awaitingReason).toBe('plan_review');
  });

  it('ExitPlanMode as the last event ⇒ surfaces plan markdown on state.plan', () => {
    const planText = '# Plan\n\n1. Read the code\n2. Ship it';
    const s = inferActivity([msg('user', 'plan it'), tool('ExitPlanMode', { plan: planText })], { pidAlive: true, mtimeMs: fresh });
    expect(s.awaitingReason).toBe('plan_review');
    expect(s.plan).toBe(planText);
  });

  it('ExitPlanMode with empty plan input ⇒ state.plan is undefined', () => {
    const s = inferActivity([msg('user', 'plan it'), tool('ExitPlanMode', { plan: '   ' })], { pidAlive: true, mtimeMs: fresh });
    expect(s.awaitingReason).toBe('plan_review');
    expect(s.plan).toBeUndefined();
  });

  it('AskUserQuestion trailing tool ⇒ no plan surfaced', () => {
    const s = inferActivity([msg('user', 'go'), tool('AskUserQuestion', { plan: 'not a plan' })], { pidAlive: true, mtimeMs: fresh });
    expect(s.awaitingReason).toBe('question');
    expect(s.plan).toBeUndefined();
  });

  it('AskUserQuestion as the last event ⇒ waiting / question', () => {
    const s = inferActivity([msg('user', 'go'), tool('AskUserQuestion')], { pidAlive: true, mtimeMs: fresh });
    expect(s.activity).toBe('waiting_input');
    expect(s.awaitingReason).toBe('question');
  });

  it('an answered AskUserQuestion (tool_result after) is no longer waiting', () => {
    const s = inferActivity(
      [tool('AskUserQuestion'), toolResult('AskUserQuestion', 'user picked B'), msg('assistant', 'Proceeding with B.')],
      { pidAlive: true, mtimeMs: fresh },
    );
    expect(s.activity).not.toBe('waiting_input');
  });

  it('assistant message ending in a question ⇒ waiting / question', () => {
    const s = inferActivity([msg('assistant', 'I can do A or B. Which do you prefer?')], { pidAlive: true, mtimeMs: stale });
    expect(s.activity).toBe('waiting_input');
    expect(s.awaitingReason).toBe('question');
  });

  it('assistant statement (no question) with stale mtime ⇒ idle', () => {
    const s = inferActivity([msg('assistant', 'Done — tests pass.')], { pidAlive: true, mtimeMs: stale });
    expect(s.activity).toBe('idle');
  });

  it('a prose trailing question DECAYS: an hours-old "?" is a finished session, not waiting (RUSH-1522)', () => {
    const ancient = now - 2 * 60 * 60_000; // 2h — far past PROSE_QUESTION_FRESH_MS
    const s = inferActivity([msg('assistant', 'All done. Anything else you need?')], { pidAlive: true, mtimeMs: ancient });
    expect(s.activity).toBe('idle');
  });

  it('a prose trailing question with NO mtime signal does NOT fire (RUSH-1522 null-mtime hole)', () => {
    // Freshness can't be asserted without an mtime, so the prose heuristic must
    // NOT claim "waiting on you" — previously a null mtime kept the question
    // forever, the exact ended-vs-waiting ambiguity the decay was meant to fix.
    const s = inferActivity([msg('assistant', 'All done. Anything else you need?')], { pidAlive: true });
    expect(s.activity).toBe('idle');
  });

  it('a structural AskUserQuestion never decays: hours-old, still waiting', () => {
    const ancient = now - 2 * 60 * 60_000;
    const s = inferActivity([msg('user', 'go'), tool('AskUserQuestion')], { pidAlive: true, mtimeMs: ancient });
    expect(s.activity).toBe('waiting_input');
    expect(s.awaitingReason).toBe('question');
  });

  it('a structural ExitPlanMode never decays: hours-old, still waiting', () => {
    const ancient = now - 2 * 60 * 60_000;
    const s = inferActivity([msg('user', 'plan it'), tool('ExitPlanMode')], { pidAlive: true, mtimeMs: ancient });
    expect(s.activity).toBe('waiting_input');
    expect(s.awaitingReason).toBe('plan_review');
  });
});

describe('inferActivity — working signals', () => {
  it('pending tool call while fresh ⇒ working', () => {
    const s = inferActivity([msg('user', 'run tests'), tool('Bash', { command: 'bun test' }, 'bun test')], { pidAlive: true, mtimeMs: fresh });
    expect(s.activity).toBe('working');
    expect(s.preview).toContain('bun test');
  });

  it('pending non-plan tool, alive but stale ⇒ still working, never a permission request (PHNX-3999)', () => {
    // A tool call with no result and a quiet file is what BOTH a long-running
    // command and a permission dialog leave behind; elapsed time cannot tell them
    // apart, so the engine reports the in-flight call and lets the harness's own
    // permission_prompt hook event (the feed block) be the evidence of a dialog.
    const s = inferActivity([tool('Bash', { command: 'rm -rf x' }, 'rm -rf x')], { pidAlive: true, mtimeMs: stale });
    expect(s.activity).toBe('working');
    expect(s.awaitingReason).toBeUndefined();
    expect(s.question).toBeUndefined();
  });

  it('a dead process is never working', () => {
    const s = inferActivity([tool('Bash', { command: 'bun test' }, 'bun test')], { pidAlive: false, mtimeMs: fresh });
    expect(s.activity).toBe('idle');
  });

  it('user spoke last and process alive ⇒ working (owes a reply)', () => {
    const s = inferActivity([msg('assistant', 'anything else?'), msg('user', 'yes, add logging')], { pidAlive: true, mtimeMs: fresh });
    expect(s.activity).toBe('working');
  });
});

// A Claude AskUserQuestion tool_use carries the full question + options on `args`.
function ask(question: string, options: Array<{ label: string; description?: string }>): SessionEvent {
  return { type: 'tool_use', agent: 'claude', timestamp: '', tool: 'AskUserQuestion', args: { questions: [{ question, header: 'Scope', options }] } };
}

describe('structuredQuestionFromAsk', () => {
  it('pulls the question text + labelled options with 1-based select keys', () => {
    const q = structuredQuestionFromAsk({
      questions: [{ question: 'Ship v0.9.290 now?', options: [{ label: 'Build now', description: 'the two follow-ups' }, { label: 'Pull more backlog' }] }],
    });
    expect(q?.text).toBe('Ship v0.9.290 now?');
    expect(q?.reason).toBe('question');
    expect(q?.options).toEqual([
      { label: 'Build now', description: 'the two follow-ups', key: '1' },
      { label: 'Pull more backlog', description: undefined, key: '2' },
    ]);
  });
  it('falls back to the header when the question text is empty', () => {
    const q = structuredQuestionFromAsk({ questions: [{ header: 'Pick one', options: [{ label: 'A' }] }] });
    expect(q?.text).toBe('Pick one');
  });
  it('returns undefined when there is no question', () => {
    expect(structuredQuestionFromAsk({})).toBeUndefined();
    expect(structuredQuestionFromAsk(undefined)).toBeUndefined();
  });
});

describe('inferActivity — structured question (the panel fix)', () => {
  it('AskUserQuestion surfaces the REAL question + options, not "Asked you a question"', () => {
    const s = inferActivity([msg('user', 'go'), ask('Ship v0.9.290 now?', [{ label: 'Build now' }, { label: 'Pull backlog' }])], { pidAlive: true, mtimeMs: fresh });
    expect(s.activity).toBe('waiting_input');
    expect(s.question?.text).toBe('Ship v0.9.290 now?');
    expect(s.question?.options?.map(o => o.label)).toEqual(['Build now', 'Pull backlog']);
    // preview must be the question, never the discarded generic line.
    expect(s.preview).toBe('Ship v0.9.290 now?');
    expect(s.preview).not.toBe('Asked you a question');
  });

  it('a trailing thinking block no longer masks the question as "thinking…"', () => {
    const s = inferActivity(
      [msg('assistant', 'I can do A or B. Which do you prefer?'), { type: 'thinking', agent: 'claude', timestamp: '', content: 'weighing options' }],
      { pidAlive: true, mtimeMs: fresh },
    );
    // last event is a thinking block, but the preview shows the assistant question.
    expect(s.preview).not.toBe('thinking…');
    expect(s.preview).toContain('Which do you prefer?');
  });

  it('a prose question carries a question object with no select keys (free-text reply)', () => {
    const s = inferActivity([msg('assistant', 'Should I merge this PR?')], { pidAlive: true, mtimeMs: stale });
    expect(s.question?.reason).toBe('question');
    expect(s.question?.text).toBe('Should I merge this PR?');
    expect(s.question?.options).toBeUndefined();
  });

  it('a prose question ages by its own transcript stamp against the injected clock, not the file mtime (PHNX-3999)', () => {
    const askedAt = '2026-09-10T10:00:06.000Z';
    const askedMs = Date.parse(askedAt);
    const events: SessionEvent[] = [{ type: 'message', agent: 'claude', timestamp: askedAt, role: 'assistant', content: 'Which data directory should I use?' }];
    // Same bytes, same mtime: only the clock moves. 10 minutes on it is a live
    // ask; 31 minutes on it has decayed — the verdict must not be frozen by an
    // mtime-keyed memo, which is what kept a stale question "waiting" for hours.
    const live = inferActivity(events, { pidAlive: true, mtimeMs: askedMs + 2_000, nowMs: askedMs + 10 * 60_000 });
    expect(live.activity).toBe('waiting_input');
    expect(live.awaitingReason).toBe('question');
    expect(live.lastEventMs).toBe(askedMs);
    const decayed = inferActivity(events, { pidAlive: true, mtimeMs: askedMs + 2_000, nowMs: askedMs + 31 * 60_000 });
    expect(decayed.activity).toBe('idle');
    expect(decayed.question).toBeUndefined();
  });

  it('an event stamp later than the file mtime is not transcript evidence (a parser filled it at read time)', () => {
    const mtimeMs = Date.parse('2026-09-10T10:00:00.000Z');
    const events: SessionEvent[] = [{ type: 'message', agent: 'grok', timestamp: new Date(mtimeMs + 60 * 60_000).toISOString(), role: 'assistant', content: 'Should I continue?' }];
    // The stamp claims the question is an hour newer than the file's last write;
    // the write time is the physical bound, so the age falls to the mtime — and at
    // 31 minutes past it the question has decayed rather than reading as fresh.
    const s = inferActivity(events, { pidAlive: true, mtimeMs, nowMs: mtimeMs + 31 * 60_000 });
    expect(s.activity).toBe('idle');
    expect(s.lastEventMs).toBeUndefined();
  });

  it('collects the last few assistant turns as tail context', () => {
    const s = inferActivity(
      [msg('assistant', 'first'), msg('user', 'ok'), msg('assistant', 'second'), msg('assistant', 'Which one — A or B?')],
      { pidAlive: true, mtimeMs: fresh },
    );
    expect(s.tail).toEqual(['first', 'second', 'Which one — A or B?']);
  });
});

describe('detectWorktree', () => {
  it('extracts slug + branch from a worktree cwd', () => {
    const wt = detectWorktree('/home/u/repo/.agents/worktrees/tree-view', 'agents/tree-view');
    expect(wt).toEqual({ path: '/home/u/repo/.agents/worktrees/tree-view', slug: 'tree-view', branch: 'agents/tree-view' });
  });
  it('returns undefined for a normal cwd', () => {
    expect(detectWorktree('/home/u/repo', 'main')).toBeUndefined();
  });
});

describe('detectTicket', () => {
  it('finds an uppercase ref in prompt text', () => {
    expect(detectTicket('please fix RUSH-1234 today')?.id).toBe('RUSH-1234');
  });
  it('does not match utf-8 style noise', () => {
    expect(detectTicket('decode the utf-8 bytes')).toBeUndefined();
  });
  it('recovers a ref from a lowercase Linear branch', () => {
    expect(detectTicket(undefined, 'muqsit/rush-1234-fix-thing')?.id).toBe('RUSH-1234');
  });
  it('ignores denylisted keys in branches (sha-256)', () => {
    expect(detectTicket(undefined, 'add-sha-256-hash')).toBeUndefined();
  });
  it('skips a leading denylisted unit string to find the real key (PHNX-3698)', () => {
    // Since detection moved onto the canonical linearIssueKeys(), a denylisted
    // first token (UTF-8) no longer blanks the whole scan — the real key after
    // it is found. Pinned because this changed detectTicket broadly, not just
    // the owner-ping feature.
    expect(detectTicket('decode UTF-8, root cause is RUSH-42')?.id).toBe('RUSH-42');
    expect(extractCreatedTicket('logged UTF-8 issue; created RUSH-99')).toBe('RUSH-99');
  });
});

describe('PR detection', () => {
  it('recognizes gh pr create commands', () => {
    expect(isPrCreateCommand('gh pr create --fill')).toBe(true);
    expect(isPrCreateCommand('gh pr view 4')).toBe(false);
  });
  it('extracts a PR url + number from output', () => {
    const pr = extractPrUrl('Created: https://github.com/phnx-labs/agents-cli/pull/482');
    expect(pr).toEqual({ url: 'https://github.com/phnx-labs/agents-cli/pull/482', number: 482 });
  });
  it('correlates gh pr create with the following result url', () => {
    const events: SessionEvent[] = [
      tool('Bash', { command: 'gh pr create --fill' }, 'gh pr create --fill'),
      toolResult('Bash', 'https://github.com/phnx-labs/agents-cli/pull/491'),
    ];
    expect(detectDurableSignals(events).pr?.number).toBe(491);
  });

  it('does NOT flag a PR from prose mentioning the command + a URL (no real tool call)', () => {
    // A session that merely discusses PRs (like this one) must not self-report a PR.
    const events: SessionEvent[] = [
      msg('assistant', 'You could run `gh pr create` and it prints https://github.com/x/y/pull/482'),
      msg('user', 'ok'),
    ];
    expect(detectDurableSignals(events).pr).toBeUndefined();
  });
});

describe('detectDurableSignals — produced artifacts', () => {
  it('carries created documents and singles out the plan on the live state', () => {
    const state = inferSessionState([
      tool('Write', { file_path: '/repo/.agents/plans/sidebar.md' }),
      tool('Write', { file_path: '/repo/.agents/artifacts/sidebar.html' }),
    ], { cwd: '/repo', pidAlive: true, mtimeMs: Date.now() });
    expect(state.planFile).toBe('/repo/.agents/plans/sidebar.md');
    expect(state.artifacts).toEqual([
      { path: '/repo/.agents/plans/sidebar.md', basename: 'sidebar.md', bucket: 'plans' },
      { path: '/repo/.agents/artifacts/sidebar.html', basename: 'sidebar.html', bucket: 'artifacts' },
    ]);
  });

  it('correlates a Linear create_issue tool with the created ref in its result', () => {
    const events: SessionEvent[] = [
      tool('mcp__claude_ai_Linear__create_issue', { title: 'Fix flaky test' }),
      toolResult('mcp__claude_ai_Linear__create_issue', 'Created issue RUSH-1519 in Rush'),
    ];
    expect(detectDurableSignals(events).createdTickets).toEqual(['RUSH-1519']);
  });
  it('captures a gh issue-create ref and a spawned team from shell commands', () => {
    const events: SessionEvent[] = [
      tool('Bash', { command: 'agents teams create redesign --enable-worktrees' }, 'agents teams create redesign --enable-worktrees'),
      tool('Bash', { command: 'gh issue create --title x' }, 'gh issue create --title x'),
      toolResult('Bash', 'https://github.com/phnx-labs/agents-cli/issues/812'),
    ];
    const sig = detectDurableSignals(events);
    expect(sig.spawnedTeam).toBe('redesign');
    expect(sig.createdTickets).toEqual(['#812']);
  });
  it('leaves artifacts undefined for a session that created nothing', () => {
    const events: SessionEvent[] = [
      tool('Bash', { command: 'gh issue list' }, 'gh issue list'),
      msg('user', 'just browsing'),
    ];
    const sig = detectDurableSignals(events);
    expect(sig.createdTickets).toBeUndefined();
    expect(sig.spawnedTeam).toBeUndefined();
  });
});

describe('ticket false positives', () => {
  it('does NOT treat a regex snippet like [A-Z0-9]-\\d as a ticket', () => {
    expect(detectTicket('the pattern /([A-Z0-9]-\\d)/ matches')).toBeUndefined();
  });
  it('does NOT treat a digit-bearing key like Z0-9 as a ticket', () => {
    expect(detectTicket('bucket Z0-9 rotated')).toBeUndefined();
  });
  it('still detects a real letters-only key', () => {
    expect(detectTicket('working on ENG-42')?.id).toBe('ENG-42');
  });
});

describe('detectSpawnedTeam', () => {
  it('extracts the team name from `agents teams create <name>`', () => {
    expect(detectSpawnedTeam('agents teams create my-feature')).toBe('my-feature');
  });
  it('extracts from the `ag` alias and `add` sub-verb, skipping flags', () => {
    expect(detectSpawnedTeam('ag teams add auth-work claude --name auth --mode edit')).toBe('auth-work');
  });
  it('handles a leading `--enable-worktrees` flag before the name', () => {
    expect(detectSpawnedTeam('agents teams create --enable-worktrees redesign')).toBe('redesign');
  });
  it('returns undefined for a non-spawn teams command', () => {
    expect(detectSpawnedTeam('agents teams list')).toBeUndefined();
    expect(detectSpawnedTeam('git commit -m "teams create fake"')).toBeUndefined();
    expect(detectSpawnedTeam(undefined)).toBeUndefined();
  });
});

describe('created-ticket detection', () => {
  it('flags a Linear create_issue MCP tool by name', () => {
    expect(isTicketCreateTool('mcp__claude_ai_Linear__create_issue', undefined)).toBe(true);
    expect(isTicketCreateTool('mcp__linear__createIssue', undefined)).toBe(true);
  });
  it('flags any shell tool running `gh issue create`', () => {
    expect(isTicketCreateTool('Bash', 'gh issue create --title x')).toBe(true);
    expect(isTicketCreateTool('shell', 'gh issue create --title x')).toBe(true);
  });
  it('does NOT flag unrelated tools/commands', () => {
    expect(isTicketCreateTool('Bash', 'gh issue list')).toBe(false);
    expect(isTicketCreateTool('Read', undefined)).toBe(false);
  });
  it('extracts a Linear key from the create result', () => {
    expect(extractCreatedTicket('Created issue RUSH-1519 (In Progress)')).toBe('RUSH-1519');
  });
  it('extracts a #number from a gh issue-create result URL', () => {
    expect(extractCreatedTicket('https://github.com/phnx-labs/agents-cli/issues/812')).toBe('#812');
  });
  it('returns undefined when the result carries no ticket', () => {
    expect(extractCreatedTicket('done, nothing to report')).toBeUndefined();
    expect(extractCreatedTicket(undefined)).toBeUndefined();
  });
});

describe('inferSessionState — composed', () => {
  it('attaches worktree + ticket + pr alongside activity', () => {
    const events: SessionEvent[] = [
      msg('user', 'ship RUSH-77 in a worktree'),
      tool('Bash', { command: 'gh pr create' }, 'gh pr create'),
      toolResult('Bash', 'https://github.com/x/y/pull/9'),
      msg('assistant', 'Opened the PR. Anything else?'),
    ];
    const s = inferSessionState(events, {
      cwd: '/home/u/repo/.agents/worktrees/rush-77',
      gitBranch: 'agents/rush-77',
      pidAlive: true,
      mtimeMs: stale,
    });
    expect(s.activity).toBe('waiting_input');
    expect(s.pr?.number).toBe(9);
    expect(s.worktree?.slug).toBe('rush-77');
    expect(s.ticket?.id).toBe('RUSH-77');
  });

  it('carries session attachments alongside activity signals', () => {
    const s = inferSessionState([
      msg('user', 'use this screenshot'),
      { type: 'attachment', agent: 'claude', timestamp: '2026-07-12T10:00:00Z', path: '/home/u/.agents/.history/attachments/shot.png', name: 'shot.png', mediaType: 'image/png', sizeBytes: 4096 },
      msg('assistant', 'Reading the screenshot.'),
    ]);

    expect(s.attachments).toEqual([
      { path: '/home/u/.agents/.history/attachments/shot.png', name: 'shot.png', mediaType: 'image/png', sizeBytes: 4096 },
    ]);
  });
});

describe('extractTodoProgress (RUSH-1380)', () => {
  it('folds TaskCreate and TaskUpdate as an event log', () => {
    const p = extractTodoProgressFromEvents([
      tool('TaskCreate', { subject: 'Inspect loader', description: 'Read formats', activeForm: 'Inspecting loader' }),
      tool('TaskCreate', { subject: 'Refactor loader', activeForm: 'Refactoring loader' }),
      tool('TaskCreate', { subject: 'Remove me' }),
      tool('TaskUpdate', { taskId: '1', status: 'completed' }),
      tool('TaskUpdate', { taskId: '2', status: 'in_progress', subject: 'Refactor config loader' }),
      tool('TaskUpdate', { taskId: '3', status: 'deleted' }),
    ]);
    expect(p).toEqual({
      items: [
        { content: 'Inspect loader', status: 'completed', description: 'Read formats', activeForm: 'Inspecting loader' },
        { content: 'Refactor config loader', status: 'in_progress', activeForm: 'Refactoring loader' },
      ],
      done: 1,
      total: 2,
      activeForm: 'Refactoring loader',
    });
  });

  it('normalizes Grok todo_write and Droid nested TodoWrite snapshots', () => {
    const grok = extractTodoProgressFromEvents([tool('todo_write', { todos: [
      { content: 'One', status: 'completed' }, { content: 'Two', status: 'in_progress' },
    ] })]);
    const droid = extractTodoProgressFromEvents([tool('TodoWrite', { input: { todos: [
      { content: 'One', status: 'completed' }, { content: 'Two', status: 'in_progress', activeForm: 'Doing two' },
    ] } })]);
    expect(grok).toMatchObject({ done: 1, total: 2, activeForm: 'Two' });
    expect(droid).toMatchObject({ done: 1, total: 2, activeForm: 'Doing two' });
  });

  // Fixture paths are built through `path` so the case reads the same on every
  // platform. extractRecentDirectoriesTouched resolves with the host's path
  // flavor (its inputs are always host-native: db.ts:852 bails before enrichment
  // when filePath is empty, which is exactly how remote transcripts are indexed
  // — hosts/session-index.ts sets `filePath: ''`). A hardcoded POSIX literal
  // therefore breaks on win32, where `path.resolve('/repo')` is drive-rooted
  // (`D:\repo`) while `path.isAbsolute('/repo/tests')` is already true, so the
  // relative and absolute forms of the same directory stop string-matching and
  // dedup silently splits one entry into two.
  it('derives recent directories from edit/write and shell cwd events', () => {
    const root = path.resolve('/repo');
    const src = path.join(root, 'src');
    const tests = path.join(root, 'tests');
    expect(extractRecentDirectoriesTouched([
      tool('Edit', { file_path: path.join('src', 'a.ts') }),  // relative → resolved against cwd, then dirname'd
      tool('exec_command', { cmd: 'bun test', workdir: tests }),
      tool('Write', { file_path: path.join(src, 'b.ts') }),   // absolute → same dir as the Edit, so it dedups
    ], root)).toEqual([tests, src]);
  });
  it('registers cwd for every harness shell tool via the shared predicate, not just Bash/exec_command', () => {
    const root = path.resolve('/repo');
    const a = path.join(root, 'a');
    const b = path.join(root, 'b');
    const c = path.join(root, 'c');
    // 'run_command' (Grok) and the 'EXEC' casing were NOT matched by the old hardcoded
    // array (which had exact-case 'Execute' but no 'run_command' and no case-folding) —
    // isShellExecTool now recognizes them, so their working dir is a touched directory.
    expect(extractRecentDirectoriesTouched([
      tool('run_command', { workdir: a }),
      tool('EXEC', { cwd: b }),
      tool('Execute', { working_directory: c }),
    ], root)).toEqual([a, b, c]);
  });
  it('tallies done/total and surfaces the in-progress activeForm', () => {
    const p = extractTodoProgress({
      todos: [
        { content: 'Read the code', status: 'completed', activeForm: 'Reading the code' },
        { content: 'Ship it', status: 'in_progress', activeForm: 'Shipping it' },
        { content: 'Verify', status: 'pending', activeForm: 'Verifying' },
      ],
    });
    expect(p?.done).toBe(1);
    expect(p?.total).toBe(3);
    expect(p?.activeForm).toBe('Shipping it');
    expect(p?.items).toHaveLength(3);
  });

  it('falls back to content when the in-progress item has no activeForm', () => {
    const p = extractTodoProgress({
      todos: [
        { content: 'Done thing', status: 'completed' },
        { content: 'Current thing', status: 'in_progress' },
      ],
    });
    expect(p?.activeForm).toBe('Current thing');
  });

  it('uses activeForm as content when content is missing, defaults unknown status to pending', () => {
    const p = extractTodoProgress({
      todos: [{ activeForm: 'Migrating store', status: 'weird' }],
    });
    expect(p?.items[0]).toEqual({ content: 'Migrating store', status: 'pending', activeForm: 'Migrating store' });
    expect(p?.done).toBe(0);
    expect(p?.total).toBe(1);
    expect(p?.activeForm).toBeUndefined(); // nothing in_progress
  });

  it('returns undefined for empty, missing, or contentless lists', () => {
    expect(extractTodoProgress(undefined)).toBeUndefined();
    expect(extractTodoProgress({})).toBeUndefined();
    expect(extractTodoProgress({ todos: [] })).toBeUndefined();
    expect(extractTodoProgress({ todos: [{ status: 'pending' }] })).toBeUndefined();
  });

  it('parses Codex update_plan (plan: [{step,status}]) into the same shape (RUSH-1503)', () => {
    const p = extractTodoProgress({
      plan: [
        { step: 'Investigate', status: 'completed' },
        { step: 'Implement', status: 'in_progress' },
        { step: 'Verify', status: 'pending' },
      ],
    });
    expect(p?.done).toBe(1);
    expect(p?.total).toBe(3);
    expect(p?.items[0]).toEqual({ content: 'Investigate', status: 'completed' });
    expect(p?.items[1]).toEqual({ content: 'Implement', status: 'in_progress' });
    // Codex plans carry no activeForm, so the live step falls back to content.
    expect(p?.activeForm).toBe('Implement');
  });

  it('inferActivity attaches todos from a Codex update_plan tool call (RUSH-1503)', () => {
    const s = inferActivity(
      [
        msg('user', 'do the thing'),
        tool('update_plan', {
          plan: [
            { step: 'Step one', status: 'completed' },
            { step: 'Step two', status: 'in_progress' },
          ],
        }),
      ],
      { pidAlive: true, mtimeMs: fresh },
    );
    expect(s.todos?.done).toBe(1);
    expect(s.todos?.total).toBe(2);
    expect(s.todos?.activeForm).toBe('Step two');
  });

  it('inferActivity attaches todos from the latest TodoWrite, even mid-work', () => {
    const s = inferActivity(
      [
        msg('user', 'do the thing'),
        tool('TodoWrite', {
          todos: [
            { content: 'Step one', status: 'completed', activeForm: 'Doing step one' },
            { content: 'Step two', status: 'in_progress', activeForm: 'Doing step two' },
          ],
        }),
        tool('Bash', { command: 'bun test' }),
      ],
      { pidAlive: true, mtimeMs: fresh },
    );
    expect(s.activity).toBe('working');            // latest event is Bash, still working
    expect(s.todos?.done).toBe(1);                 // todos come from the earlier TodoWrite
    expect(s.todos?.total).toBe(2);
    expect(s.todos?.activeForm).toBe('Doing step two');
  });

  it('uses the LATEST TodoWrite when several were written', () => {
    const s = inferActivity(
      [
        tool('TodoWrite', { todos: [{ content: 'a', status: 'pending' }] }),
        tool('TodoWrite', { todos: [
          { content: 'a', status: 'completed' },
          { content: 'b', status: 'completed' },
        ] }),
      ],
      { pidAlive: true, mtimeMs: fresh },
    );
    expect(s.todos?.done).toBe(2);
    expect(s.todos?.total).toBe(2);
  });

  it('no TodoWrite ⇒ no todos field', () => {
    const s = inferActivity([msg('user', 'hi'), tool('Bash', { command: 'ls' })], { pidAlive: true, mtimeMs: fresh });
    expect(s.todos).toBeUndefined();
  });
});

describe('detectSpawnedTeam — rejects prose and flag values', () => {
  // Every string below was pulled from a real transcript on a live index, where
  // it had been indexed as a team name. They only became visible once the row
  // started rendering a `team:<name>` badge, at which point a wrong name is
  // worse than none.
  it('ignores a backticked mention inside prose or tool output', () => {
    const line =
      '`agents run --device auto` and `agents teams add --device auto`\n"is_error":false\n=== installed binary carries';
    expect(detectSpawnedTeam(line)).toBeUndefined();
  });

  it('does not run the flag-skip across a newline into another line\'s word', () => {
    // `\s` in the flag-skip let a match starting on one line capture a bareword
    // from the next — a heredoc of docs indexed as `team:installed`.
    expect(detectSpawnedTeam('agents teams add --device auto\nsomething installed here')).toBeUndefined();
  });

  it('ignores a single-character doc placeholder', () => {
    expect(detectSpawnedTeam('`agents teams create t --device <name>`')).toBeUndefined();
  });

  it('ignores an English article after the sub-verb', () => {
    expect(detectSpawnedTeam('you can use agents teams add a teammate later')).toBeUndefined();
  });

  it('lets a value-taking flag swallow its value instead of naming the team', () => {
    expect(detectSpawnedTeam('agents teams add --device yosemite-s0 remote-team codex "x"')).toBe('remote-team');
    expect(detectSpawnedTeam('agents teams add my-team claude "go" --worktree auth --mode edit')).toBe('my-team');
  });

  it('still detects a real invocation after a shell separator or at a line start', () => {
    expect(detectSpawnedTeam('cd /repo && agents teams create shipit')).toBe('shipit');
    expect(detectSpawnedTeam('agents teams create lineage-probe\nagents teams start lineage-probe')).toBe(
      'lineage-probe'
    );
  });
});

describe('detectSpawnedTeam — review findings from PR #1710', () => {
  it('lets a QUOTED flag value be swallowed whole', () => {
    // `-d`/`--description` normally carries a phrase. A value pattern of \S+ stops
    // at the first space, so the rest of the phrase fell out of the flag branch and
    // the next word became the "team name" — the same corruption class the earlier
    // --device fix was supposed to close, still open for the commonest flag.
    expect(detectSpawnedTeam('agents teams create -d "sessions lineage" my-team')).toBe('my-team');
    expect(detectSpawnedTeam('agents teams create --description "redesign resume picker" my-team')).toBe('my-team');
    expect(detectSpawnedTeam("agents teams create -d 'single quoted phrase' my-team")).toBe('my-team');
  });

  it('detects a team name that starts with a digit', () => {
    // createTeam validates nothing (lib/teams/registry.ts), so digit-leading names
    // are legal. Narrowing the capture class to [A-Za-z] silently stopped detecting
    // them; the all-digits junk it was meant to stop is rejected by the guard instead.
    expect(detectSpawnedTeam('agents teams create 2fa-migration')).toBe('2fa-migration');
    expect(detectSpawnedTeam('agents teams create 3d-viewer')).toBe('3d-viewer');
  });

  it('still rejects an all-digits token', () => {
    expect(detectSpawnedTeam('agents teams add --after 22 ')).toBeUndefined();
  });
});
