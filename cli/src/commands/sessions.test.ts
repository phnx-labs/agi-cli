import { describe, it, expect } from 'vitest';
import {
  buildResumeCommand,
  resumeSpawnInvocation,
  resolveSessionQuery,
  buildSessionDescription,
  metadataResolveOutcome,
  isDefinitiveMatch,
  selectorAllowsEarlyExit,
  fleetNotFoundMessage,
  mergeToolSearchEnvelopes,
  mergeToolProgramCountEnvelopes,
  toolOriginSessions,
  toolSearchFleetSortError,
  toolSearchForwardedArgs,
  resolveSessionAgentName,
  parseInstalledAgentVersionQuery,
  executionKind,
  printRoutineDrilldown,
  parseRemoteComputerSessionRows,
  serializeSessionPickerRows,
  type RoutineDrilldown,
} from './sessions.js';
import type { RunMeta } from '../lib/scheduling/routines.js';
import { needsWindowsShell, composeWin32CommandLine } from '../lib/platform/index.js';
import type { SessionMeta } from '@phnx-labs/sessions-cli/reader';
import type { ActiveSession } from '../lib/session/active.js';

// Pure unit tests for src/commands/sessions.ts exports. The subprocess-heavy
// behavior tests live in the sessions.*.test.ts slices next to this file
// (cli-list, cli-live, cli-tools, computer, render, resolve, resolve-errors,
// ssh-peer), split so vitest can parallelize them across worker forks
// (RUSH-2819) — this file was one 2,600-line suite measured at 172s, the
// single slowest file in CI. Shared fixtures: sessions.test-fixture.ts.

describe('session harness name resolution', () => {
  it('shares canonical aliases and typo correction with focus selectors', () => {
    expect(resolveSessionAgentName('claude-code')).toBe('claude');
    expect(resolveSessionAgentName('cladue')).toBe('claude');
    expect(resolveSessionAgentName('GROK')).toBe('grok');
    expect(resolveSessionAgentName('not-a-harness')).toBeNull();
  });
});

describe('session picker JSON contract', () => {
  it('joins durable and cached live state into one recovery-ready row', () => {
    const session = {
      id: 'aaaaaaaa-1111-4222-8333-bbbbbbbbbbbb', shortId: 'aaaaaaaa', agent: 'codex',
      timestamp: '2026-08-10T00:00:00.000Z', lastActivity: '2026-08-10T00:01:00.000Z',
      filePath: '/sessions/a.jsonl', cwd: '/repo',
    } satisfies SessionMeta;
    const live = {
      context: 'terminal', kind: 'codex', sessionId: session.id, status: 'idle',
      machine: 'box-a', pid: 42, cwd: '/repo', lastActivityMs: 123,
    } satisfies ActiveSession;
    expect(serializeSessionPickerRows([session], [live], 'self')).toEqual([
      expect.objectContaining({
        id: session.id, state: 'idle', resumable: true, unwatched: true,
        viewingIn: null, sourceDevice: 'box-a', lastActivityMs: 123, pid: 42,
        recovery: { command: 'agents', args: ['sessions', 'resume', session.id, '--device', 'box-a'], cwd: '/repo' },
      }),
    ]);
  });
});
describe('routine drilldown — run history + linked sessions (RUSH-2409)', () => {
  const run = (over: Partial<RunMeta> & { runId: string; status: RunMeta['status'] }): RunMeta => ({
    jobName: 'r', pid: null, startedAt: '2026-08-08T05:00:00.000Z', completedAt: null, exitCode: null,
    ...over,
  });
  const sess = (over: Partial<SessionMeta> & { id: string }): SessionMeta => ({
    shortId: over.id.slice(0, 8), agent: 'claude', timestamp: '2026-08-08T05:00:00.000Z',
    filePath: '/tmp/s.jsonl', ...over,
  });
  const capture = (fn: () => void): string => {
    const lines: string[] = [];
    const orig = console.log;
    console.log = (line = '') => { lines.push(String(line)); };
    try { fn(); } finally { console.log = orig; }
    // eslint-disable-next-line no-control-regex
    return lines.join('\n').replace(/\[[0-9;]*m/g, '');
  };

  it('classifies execution kind from the run record, not the session', () => {
    expect(executionKind(run({ runId: 'x', status: 'completed', agent: 'claude' }))).toBe('agent');
    expect(executionKind(run({ runId: 'x', status: 'completed', workflow: 'wf' }))).toBe('workflow');
    expect(executionKind(run({ runId: 'x', status: 'skipped', command: 'agents __daemon-tick x' }))).toBe('command');
  });

  it('renders a command-only routine as run history with no session synthesized', () => {
    const drill: RoutineDrilldown = {
      name: 'auto-dispatch',
      runs: [
        { meta: run({ runId: '2026-08-08T05-03-00-002Z', status: 'skipped', command: 'agents __daemon-tick auto-dispatch', triggerKind: 'schedule', skipReason: 'wrong_owner', duration: 0 }), sessions: [] },
        { meta: run({ runId: '2026-08-08T05-00-00-002Z', status: 'completed', command: 'echo hi', triggerKind: 'schedule', duration: 1500, exitCode: 0 }), sessions: [] },
      ],
      orphanSessions: [],
      runRecordCount: 2,
      linkedSessionCount: 0,
      isAgentRoutine: false,
    };
    const out = capture(() => printRoutineDrilldown(drill));
    expect(out).toContain('auto-dispatch  2 run records · 0 linked sessions');
    expect(out).toContain('Command routine — runs execute a shell command; no agent session is produced.');
    expect(out).toContain('▸ 2026-08-08T05-03-00-002Z');
    expect(out).toContain('skipped');
    expect(out).toContain('wrong owner');
    expect(out).toContain('command · local');
    expect(out).toContain('completed');
    // No fake session row — command runs never manufacture a SessionMeta line.
    expect(out).not.toContain('no agent session archived for this run');
  });

  it('links an indexed agent session to its run with token/cost/tool metadata', () => {
    const linked = sess({
      id: 'aaaa1111-2222-4333-8444-555566667777', agent: 'claude', version: '2.1.181',
      account: 'dev@x.io', model: 'claude-opus-4-8', outputTokens: 42000, costUsd: 1.23,
      durationMs: 720000, toolCallCount: 88, routineName: 'nightly', routineRunId: 'run-1',
      topic: 'nightly review',
    });
    const drill: RoutineDrilldown = {
      name: 'nightly',
      runs: [{ meta: run({ runId: 'run-1', status: 'completed', agent: 'claude', version: '2.1.181', triggerKind: 'schedule', duration: 720000, exitCode: 0 }), sessions: [linked] }],
      orphanSessions: [],
      runRecordCount: 1,
      linkedSessionCount: 1,
      isAgentRoutine: true,
    };
    const out = capture(() => printRoutineDrilldown(drill));
    expect(out).toContain('nightly  1 run record · 1 linked session');
    expect(out).not.toContain('no agent session is produced');
    expect(out).toContain('claude v2.1.181');
    expect(out).toContain('dev@x.io');
    expect(out).toContain('42K out');
    expect(out).toContain('$1.23');
    expect(out).toContain('88 tools');
  });

  it('shows the outcome for failed and blocked runs without a session, never a fake row', () => {
    const drill: RoutineDrilldown = {
      name: 'nightly',
      runs: [
        { meta: run({ runId: 'run-2', status: 'failed', agent: 'claude', triggerKind: 'schedule', exitCode: 1, errorMessage: 'auth_failed: login required', duration: 3000 }), sessions: [] },
        { meta: run({ runId: 'run-3', status: 'blocked', agent: 'claude', triggerKind: 'schedule', readiness: { code: 'dead_auth', message: 'account signed out' } }), sessions: [] },
      ],
      orphanSessions: [],
      runRecordCount: 2,
      linkedSessionCount: 0,
      isAgentRoutine: true,
    };
    const out = capture(() => printRoutineDrilldown(drill));
    expect(out).toContain('failed');
    expect(out).toContain('auth_failed: login required');
    expect(out).toContain('blocked');
    expect(out).toContain('dead_auth: account signed out');
    // An agent run that produced no session says so explicitly, never fakes one.
    expect(out).toContain('no agent session archived for this run');
  });

  it('surfaces sessions whose run record is on another host as orphans, counted honestly', () => {
    const orphanSess = sess({ id: 'bbbb1111-2222-4333-8444-555566667777', routineName: 'nightly', routineRunId: 'remote-run', timestamp: '2026-08-08T04:00:00.000Z' });
    const drill: RoutineDrilldown = {
      name: 'nightly',
      runs: [],
      orphanSessions: [{ runId: 'remote-run', timestamp: '2026-08-08T04:00:00.000Z', sessions: [orphanSess] }],
      runRecordCount: 0,
      linkedSessionCount: 1,
      isAgentRoutine: true,
    };
    const out = capture(() => printRoutineDrilldown(drill));
    expect(out).toContain('nightly  0 run records · 1 linked session');
    expect(out).toContain('Sessions with no local run record (run archived on another host):');
    expect(out).toContain('▸ remote-run');
  });

  it('keeps the hidden team and unmanaged-session disclosures (every listing path says what it dropped)', () => {
    const drill: RoutineDrilldown = {
      name: 'nightly',
      runs: [{ meta: run({ runId: 'run-1', status: 'completed', agent: 'claude', triggerKind: 'schedule', duration: 1000, exitCode: 0 }), sessions: [] }],
      orphanSessions: [],
      runRecordCount: 1,
      linkedSessionCount: 0,
      isAgentRoutine: true,
    };
    const out = capture(() => printRoutineDrilldown(drill, undefined, { hiddenCount: 2, hiddenUnmanaged: 1 }));
    expect(out).toContain('2 team sessions hidden');
    expect(out).toContain('1 session from your own unmanaged installs hidden');
  });

  it('labels a workflow routine as an agent routine, not a command routine', () => {
    const drill: RoutineDrilldown = {
      name: 'wf-routine',
      runs: [{ meta: run({ runId: 'wf-1', status: 'completed', workflow: 'nightly-wf', triggerKind: 'schedule', duration: 5000, exitCode: 0 }), sessions: [] }],
      orphanSessions: [],
      runRecordCount: 1,
      linkedSessionCount: 0,
      isAgentRoutine: true,
    };
    const out = capture(() => printRoutineDrilldown(drill));
    expect(out).not.toContain('no agent session is produced');
    expect(out).toContain('workflow · ');
  });
});
describe('positional installed agent version filters', () => {
  const installed = (agent: string) => agent === 'claude' ? ['2.1.181'] : ['0.146.0'];

  it('recognizes an exact installed agent@version pair', () => {
    expect(parseInstalledAgentVersionQuery('claude@2.1.181', installed)).toBe('claude@2.1.181');
    expect(parseInstalledAgentVersionQuery('CODEX@0.146.0', installed)).toBe('codex@0.146.0');
  });

  it('leaves unknown, uninstalled, and prose queries on the free-text path', () => {
    expect(parseInstalledAgentVersionQuery('claude@9.9.9', installed)).toBeUndefined();
    expect(parseInstalledAgentVersionQuery('cladue@2.1.181', installed)).toBeUndefined();
    expect(parseInstalledAgentVersionQuery('project@2026', installed)).toBeUndefined();
    expect(parseInstalledAgentVersionQuery('claude@2.1.181 notes', installed)).toBeUndefined();
  });
});
describe('toolSearchForwardedArgs', () => {
  it('removes coordinator device flags and forces a whole-index local peer query', () => {
    const argv = [
      process.execPath, 'agents', 'sessions', '--include', 'tools',
      '--query', 'program:git', '--device', 'peer-one', '--fleet', '--json',
    ];
    expect(toolSearchForwardedArgs(argv, ['peer-one'])).toEqual([
      'sessions', '--include', 'tools', '--query', 'program:git', '--json', '--all', '--local',
    ]);
  });
});

describe('toolSearchFleetSortError', () => {
  it('rejects cost and duration sorts only when tool evidence spans devices', () => {
    expect(toolSearchFleetSortError('cost', true)).toContain('only --sort recent');
    expect(toolSearchFleetSortError('duration', true)).toContain('only --sort recent');
    expect(toolSearchFleetSortError('recent', true)).toBeUndefined();
    expect(toolSearchFleetSortError('cost', false)).toBeUndefined();
  });
});

describe('fleet tool query origin partitioning', () => {
  it('sums occurrences, containing calls, sessions, and coverage across machines', () => {
    const make = (machine: string, occurrences: number, complete = true) => ({
      schemaVersion: 1 as const,
      kind: 'tool-program-count' as const,
      generatedAt: '2026-08-03T00:00:00Z',
      query: { program: 'git', semantics: 'static-program-occurrences-v1' as const },
      coverage: { indexedFiles: 1, indexedCalls: 2, skippedFiles: 0, limitedFiles: 0, remainingFiles: complete ? 0 : 1, complete },
      totals: { occurrences, toolCalls: occurrences - 1, sessions: 1 },
      machines: [{
        machine,
        coverage: { indexedFiles: 1, indexedCalls: 2, skippedFiles: 0, limitedFiles: 0, remainingFiles: complete ? 0 : 1, complete },
        totals: { occurrences, toolCalls: occurrences - 1, sessions: 1 },
      }],
    });
    expect(mergeToolProgramCountEnvelopes(make('one', 3), [make('two', 2, false)]))
      .toMatchObject({
        coverage: { indexedFiles: 2, complete: false },
        totals: { occurrences: 5, toolCalls: 3, sessions: 2 },
        machines: [{ machine: 'one' }, { machine: 'two' }],
      });
  });

  it('keeps synced mirrors out of an origin device fleet partition', () => {
    const local = { id: 'local', machine: 'one' } as SessionMeta;
    const mirror = { id: 'mirror', machine: 'two' } as SessionMeta;
    expect(toolOriginSessions([local, mirror], 'one', true)).toEqual([local]);
    expect(toolOriginSessions([local, mirror], 'one', false)).toEqual([local, mirror]);
  });

  it('deduplicates evidence for the same origin session returned through two peers', () => {
    const coverage = {
      indexedFiles: 1, indexedCalls: 1, skippedFiles: 0,
      limitedFiles: 0, remainingFiles: 0, complete: true,
    };
    const make = (timestamp: string) => ({
      schemaVersion: 1 as const,
      generatedAt: timestamp,
      query: { clauses: ['program:git'] },
      coverage,
      sessions: [{
        id: 'same', shortId: 'same', agent: 'codex', machine: 'origin-one', timestamp,
        calls: [],
      }],
    });
    expect(mergeToolSearchEnvelopes(make('2026-08-03T00:00:00Z'), [
      make('2026-08-03T00:00:01Z'),
    ]).sessions).toHaveLength(1);
  });
});
describe('parseRemoteComputerSessionRows', () => {
  it('accepts a clean peer array and supplies its machine name', () => {
    const parsed = parseRemoteComputerSessionRows('[{"pid":7,"endMs":9}]', 'yosemite-m0');
    expect(parsed.valid).toBe(true);
    expect(parsed.items).toEqual([{ pid: 7, endMs: 9, machine: 'yosemite-m0' }]);
  });

  it('rejects banner-prefixed multi-host output instead of corrupting JSON', () => {
    const parsed = parseRemoteComputerSessionRows('── host ──\n[{"pid":7}]', 'yosemite-m0');
    expect(parsed).toEqual({ items: [], valid: false });
  });
});
describe('buildResumeCommand version-pinned resume', () => {
  const baseSession = (overrides: Partial<SessionMeta> = {}): SessionMeta => ({
    id: 'abc12345-def6-7890-1234-567890abcdef',
    shortId: 'abc12345',
    agent: 'claude',
    timestamp: '2026-04-19T12:00:00.000Z',
    filePath: '/fake/path.jsonl',
    ...overrides,
  });

  it('uses version-pinned binary when claude session has a recorded version', () => {
    const session = baseSession({ version: '2.1.138' });
    expect(buildResumeCommand(session)).toEqual([
      'claude@2.1.138', '--resume', session.id,
    ]);
  });

  it('falls back to bare shim when claude session has no recorded version', () => {
    const session = baseSession({ version: undefined });
    expect(buildResumeCommand(session)).toEqual([
      'claude', '--resume', session.id,
    ]);
  });

  it('uses version-pinned binary when codex session has a recorded version', () => {
    const session = baseSession({ agent: 'codex', version: '0.116.0' });
    expect(buildResumeCommand(session)).toEqual([
      'codex@0.116.0', 'resume', session.id,
    ]);
  });

  it('falls back to bare shim when codex session has no recorded version', () => {
    const session = baseSession({ agent: 'codex', version: undefined });
    expect(buildResumeCommand(session)).toEqual([
      'codex', 'resume', session.id,
    ]);
  });

  it('opencode always uses shared --session flag (not version-isolated)', () => {
    const session = baseSession({ agent: 'opencode', version: '0.5.0' });
    expect(buildResumeCommand(session)).toEqual([
      'opencode', '--session', session.id,
    ]);
  });

  it('returns null for agents without resume support', () => {
    expect(buildResumeCommand(baseSession({ agent: 'gemini', version: '1.0.0' }))).toBeNull();
    expect(buildResumeCommand(baseSession({ agent: 'openclaw', version: '1.0.0' }))).toBeNull();
  });

  // Regression: resumeSessionInPlace must spawn the resume launcher through the
  // shell on Windows. The launcher is a bare command / `.cmd` shim
  // (`claude@2.1.138`, `codex`), which `spawn` can't exec directly on win32 —
  // a `shell:false` spawn there threw `EFTYPE` and surfaced as a misleading
  // "Failed to discover sessions" error. Off Windows it must stay a direct exec.
  it('resume launcher requires a shell on win32 and not on posix', () => {
    for (const session of [
      baseSession({ version: '2.1.138' }),                       // claude@2.1.138
      baseSession({ version: undefined }),                       // bare claude
      baseSession({ agent: 'codex', version: '0.116.0' }),       // codex@0.116.0
      baseSession({ agent: 'opencode', version: '0.5.0' }),      // opencode
    ]) {
      const launcher = buildResumeCommand(session)![0];
      expect(needsWindowsShell(launcher, 'win32')).toBe(true);
      expect(needsWindowsShell(launcher, 'linux')).toBe(false);
    }
  });

  // RUSH-1753: session.id comes from the JSONL filename with no char validation.
  // spawn(cmd[0], cmd.slice(1), { shell: true }) on win32 concatenates args into
  // the cmd.exe line unescaped — so id `x&calc.exe&` injects. resumeSpawnInvocation
  // must compose a quoted line + empty argv when the shell is needed.
  it('quotes shell metacharacters in session id on win32 resume spawn (RUSH-1753)', () => {
    const evilId = 'x&calc.exe&';
    const cmd = buildResumeCommand(baseSession({ id: evilId }))!;
    expect(cmd).toEqual(['claude', '--resume', evilId]);

    const inv = resumeSpawnInvocation(cmd, 'win32');
    expect(inv.shell).toBe(true);
    expect(inv.args).toEqual([]);
    // Full line is the sole command; & | etc. sit inside quotes (not bare).
    expect(inv.command).toBe(composeWin32CommandLine(cmd[0], cmd.slice(1)));
    expect(inv.command).toBe('claude --resume "x&calc.exe&"');

    // Posix path stays a direct exec (no shell, raw argv).
    const posix = resumeSpawnInvocation(cmd, 'linux');
    expect(posix).toEqual({ command: 'claude', args: ['--resume', evilId], shell: false });
  });

  it('quotes shell metacharacters for codex and opencode resume spawn too', () => {
    const evilId = 'a|b<c>d';
    for (const session of [
      baseSession({ agent: 'codex', id: evilId }),
      baseSession({ agent: 'opencode', id: evilId }),
    ]) {
      const cmd = buildResumeCommand(session)!;
      const inv = resumeSpawnInvocation(cmd, 'win32');
      expect(inv.shell).toBe(true);
      expect(inv.args).toEqual([]);
      expect(inv.command).toBe(composeWin32CommandLine(cmd[0], cmd.slice(1)));
      expect(inv.command).toContain(`"${evilId}"`);
    }
  });
});
describe('resolveSessionQuery id-vs-search resolution', () => {
  const meta = (over: Partial<SessionMeta> & { id: string }): SessionMeta => ({
    shortId: over.id.slice(0, 8),
    agent: 'claude',
    timestamp: '2026-08-01T12:00:00.000Z',
    filePath: '/fake/path.jsonl',
    ...over,
  });

  // The session the user actually asked for is absent from the pool (it lives on
  // another machine); the pool holds an unrelated session whose topic merely
  // quotes that id — the exact shape that made `sessions <uuid>` render the wrong
  // transcript and advise "Pass a longer ID" for an already-complete id.
  // Synthetic id that cannot exist in any real session DB: a complete id absent
  // from the pool now also consults the on-disk index (findSessionsById), so a
  // REAL id here would resolve from the developer's own history and make these
  // tests machine-specific (they'd fail wherever that session exists).
  const wanted = '00000000-0000-4000-8000-000000000042';
  const decoy = meta({
    id: 'ffa1f432-1a9e-4a81-8e93-e70aa8df1c95',
    topic: `Resume previous work: ${wanted}`,
  });

  it('does not answer a complete id with a session that merely mentions it', () => {
    const r = resolveSessionQuery([decoy], wanted);
    expect(r.matches).toEqual([]);
    expect(r.completeId).toBe(true);
    expect(r.byId).toBe(true);
  });

  it('still resolves a complete id that is genuinely present', () => {
    const real = meta({ id: wanted, topic: 'Improve session display' });
    const r = resolveSessionQuery([decoy, real], wanted);
    expect(r.matches.map(s => s.id)).toEqual([wanted]);
    expect(r.byId).toBe(true);
  });

  it('keeps short-id prefix lookup working', () => {
    const real = meta({ id: wanted, topic: 'Improve session display' });
    const r = resolveSessionQuery([real], '00000000');
    expect(r.matches.map(s => s.id)).toEqual([wanted]);
    expect(r.byId).toBe(true);
    expect(r.completeId).toBe(false);
  });

  it('still falls through to text search for a real search phrase', () => {
    const r = resolveSessionQuery([decoy], 'Resume previous');
    expect(r.matches.map(s => s.id)).toEqual([decoy.id]);
    expect(r.byId).toBe(false);
    expect(r.completeId).toBe(false);
  });

  // isCompleteSessionId trims but resolveSessionById does not, so without a
  // single normalization point a pasted, padded id classified as complete and
  // then missed the lookup — reporting a session that IS here as absent.
  it('resolves a padded id instead of declaring it missing', () => {
    const real = meta({ id: wanted, topic: 'Improve session display' });
    const r = resolveSessionQuery([decoy, real], `  ${wanted} `);
    expect(r.matches.map(s => s.id)).toEqual([wanted]);
    expect(r.completeId).toBe(true);
  });

  // Synthetic ids, so these assert the resolver and never the developer's own
  // session index (a complete id that MISSES the pool now also consults the DB,
  // so a real id here would resolve from disk and make the test machine-specific).
  it('resolves a session_-prefixed complete id by id, not by content', () => {
    const prefixed = 'session_00000000-0000-4000-8000-000000000001';
    const mentions = meta({ id: 'aaaa1111-2222-4333-8444-555566667777', topic: `see ${prefixed}` });
    const r = resolveSessionQuery([mentions], prefixed);
    expect(r.completeId).toBe(true);
    expect(r.matches.map(s => s.id)).not.toContain(mentions.id);
    const real = meta({ id: prefixed, topic: 'kimi run' });
    expect(resolveSessionQuery([mentions, real], prefixed).matches.map(s => s.id)).toEqual([prefixed]);
  });

  it('resolves a ses_ ULID complete id by id, not by content', () => {
    const ses = 'ses_00000000000000000000000001';
    const mentions = meta({ id: 'bbbb1111-2222-4333-8444-555566667777', topic: `see ${ses}` });
    const r = resolveSessionQuery([mentions], ses);
    expect(r.completeId).toBe(true);
    expect(r.matches.map(s => s.id)).not.toContain(mentions.id);
  });
});

describe('buildSessionDescription — team lineage', () => {
  it('shows "by <orchestrator label>" for a teammate with a resolved orchestrator', () => {
    const desc = buildSessionDescription({
      context: 'teams', kind: 'claude', status: 'working',
      teamName: 'my-feature', orchestratorLabel: 'refactor auth', label: 'auth',
    } as any);
    expect(desc).toContain('my-feature');
    expect(desc).toContain('by refactor auth');
  });

  it('falls back to the orchestrator short id when no label resolved', () => {
    const desc = buildSessionDescription({
      context: 'teams', kind: 'claude', status: 'working',
      teamName: 't', orchestratorSessionId: 'abcd1234efgh',
    } as any);
    expect(desc).toContain('by abcd1234'); // first 8 chars
  });

  it('omits the "by" clause when there is no orchestrator link', () => {
    const desc = buildSessionDescription({
      context: 'teams', kind: 'claude', status: 'working', teamName: 't', label: 'x',
    } as any);
    expect(desc).not.toContain('by ');
  });
});

describe('buildSessionDescription — team target + teammate', () => {
  it('shows team, teammate, orchestrator, and the assigned mission', () => {
    const desc = buildSessionDescription({
      context: 'teams', kind: 'claude', status: 'working',
      teamName: 'session-ship', label: 'cli-ids', orchestratorLabel: 'ship the CLI',
      assignedTask: 'Make short + full session ids resolve everywhere',
    } as any);
    expect(desc).toContain('session-ship');
    expect(desc).toContain('cli-ids');
    expect(desc).toContain('by ship the CLI');
    expect(desc).toContain('Make short + full session ids resolve everywhere');
  });
  it('prefers the live preview over the assigned mission once working', () => {
    const desc = buildSessionDescription({
      context: 'teams', kind: 'claude', status: 'working',
      teamName: 't', assignedTask: 'the mission', preview: 'editing usage.ts',
    } as any);
    expect(desc).toContain('editing usage.ts');
    expect(desc).not.toContain('the mission');
  });
  it('shows the assigned mission for a teammate with no transcript yet (pending)', () => {
    const desc = buildSessionDescription({
      context: 'teams', kind: 'claude', status: 'pending',
      teamName: 't', assignedTask: 'wire up the auth flow',
    } as any);
    expect(desc).toContain('wire up the auth flow');
  });
});

describe('RUSH-2203 definitive-match fleet resolve', () => {
  const FULL = '019fd0c8-b3e9-77a2-a1a4-444698c4d897';
  const base: SessionMeta = {
    id: FULL,
    shortId: '019fd0c8',
    agent: 'claude',
    version: '2.1.0',
    mode: 'edit',
    machine: 'yosemite-m0',
    timestamp: '2026-08-05T09:29:43.616Z',
    filePath: '/sessions/claude.jsonl',
  };

  describe('isDefinitiveMatch', () => {
    it('treats a full UUID exact match as definitive (case-insensitive)', () => {
      expect(isDefinitiveMatch(base, FULL)).toBe(true);
      expect(isDefinitiveMatch(base, FULL.toUpperCase())).toBe(true);
      expect(isDefinitiveMatch({ ...base, id: 'other' }, FULL)).toBe(false);
    });

    it('is NOT definitive for an exact label — labels can collide across machines', () => {
      const labelled = { ...base, label: 'Fix the flaky ssh test' };
      expect(isDefinitiveMatch(labelled, 'fix the flaky ssh test')).toBe(false);
    });

    it('is NOT definitive for a short-id prefix narrower than 8 hex — ambiguity needs every peer', () => {
      expect(isDefinitiveMatch(base, '019fd')).toBe(false);
      expect(isDefinitiveMatch(base, 'abcd12')).toBe(false);
    });

    // PHNX-3292: `agents tmux ls` prints `ag-<agent>-<8hex>` names and the bare
    // 8-hex suffix — both name at most one session per answering peer, so the
    // first reachable hit is enough (same trade `isUniqueEnoughSelector`
    // already makes post-sweep for SES-9a, now applied in-flight too).
    it('IS definitive for an exact 8-hex short id (the shortId column width)', () => {
      expect(isDefinitiveMatch(base, base.shortId)).toBe(true);
      expect(isDefinitiveMatch(base, base.shortId.toUpperCase())).toBe(true);
      expect(isDefinitiveMatch({ ...base, shortId: 'deadbeef' }, base.shortId)).toBe(false);
    });

    it('IS definitive for a live tmux alias embedding this session\'s short id', () => {
      expect(isDefinitiveMatch(base, `ag-claude-${base.shortId}`)).toBe(true);
      expect(isDefinitiveMatch(base, `ag-codex-${base.shortId}`)).toBe(true);
      expect(isDefinitiveMatch(base, 'ag-claude-deadbeef')).toBe(false);
    });
  });

  describe('selectorAllowsEarlyExit', () => {
    it('enables early-exit for a full UUID (globally unique)', () => {
      expect(selectorAllowsEarlyExit(FULL)).toBe(true);
    });
    it('enables early-exit for a live tmux alias and an exact 8-hex short id (PHNX-3292)', () => {
      expect(selectorAllowsEarlyExit('ag-claude-0145ab8f')).toBe(true);
      expect(selectorAllowsEarlyExit('ag-kimi-632c1fbc')).toBe(true);
      expect(selectorAllowsEarlyExit('0145ab8f')).toBe(true);
      expect(selectorAllowsEarlyExit('0145AB8F')).toBe(true);
    });
    it('disables early-exit for labels and short-id prefixes narrower than 8 hex', () => {
      expect(selectorAllowsEarlyExit('fix the flaky ssh test')).toBe(false);
      expect(selectorAllowsEarlyExit('019fd0c')).toBe(false);
      expect(selectorAllowsEarlyExit('abcd12')).toBe(false);
    });
  });

  describe('metadataResolveOutcome with labels', () => {
    it('auto-resumes a unique exact-label match once every peer has answered', () => {
      const labelled = { ...base, label: 'ship the resume fix' };
      expect(
        metadataResolveOutcome([], { sessions: [labelled], unreachable: [] }, 'ship the resume fix'),
      ).toEqual({ kind: 'resolved', session: labelled });
    });

    it('fails closed (partial) for a label when a peer is unreachable — it may hold a same-label session', () => {
      const labelled = { ...base, label: 'ship the resume fix' };
      expect(
        metadataResolveOutcome([], { sessions: [labelled], unreachable: ['offline-box'] }, 'ship the resume fix'),
      ).toEqual({ kind: 'partial', failedPeers: ['offline-box'] });
    });

    it('surfaces a conflict when two distinct sessions share the exact label', () => {
      const one = { ...base, id: `${'1'.repeat(8)}-b3e9-77a2-a1a4-444698c4d897`, label: 'dup label' };
      const two = { ...base, id: `${'2'.repeat(8)}-b3e9-77a2-a1a4-444698c4d897`, machine: 'yosemite-m1', label: 'dup label' };
      const outcome = metadataResolveOutcome([], { sessions: [one, two], unreachable: [] }, 'dup label');
      expect(outcome.kind).toBe('ambiguous');
    });
  });

  describe('fleetNotFoundMessage', () => {
    it('reports the sweep result and never tells the user to pass --device', () => {
      const lines = fleetNotFoundMessage(FULL, 5, ['zion', 'box']).join('\n');
      expect(lines).toContain('5 devices searched');
      expect(lines).toContain('Unreachable (not searched): zion, box');
      expect(lines).not.toContain('--device');
    });

    it('handles a fleet with no reachable peers', () => {
      const lines = fleetNotFoundMessage(FULL, 0, []).join('\n');
      expect(lines).toContain('No other reachable devices to search.');
      expect(lines).not.toContain('--device');
    });
  });
});
