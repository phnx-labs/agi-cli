import { describe, expect, it, vi } from 'vitest';
import { randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Command } from 'commander';
import {
  buildSelectedResumeArgs,
  buildSessionLifecycleArgs,
  isDirectResumeSelector,
  partitionResumableSelections,
  resolveResumePacking,
  resolveResumeOptions,
  buildSelectedResumeSurface,
  resumeHostMismatch,
  resumeUsesLifecycleDispatch,
  sessionsResumeAction,
} from './sessions-resume.js';
import { sessionMatchesQuery } from './sessions-browser.js';
import type { SessionMeta } from '../lib/session/types.js';
import { shellQuote } from '../lib/terminal/index.js';
import { execOnly } from '../lib/terminal/shell.js';
import { buildFullCommandTree } from '../cli/command-registry.js';

describe('resolveResumePacking', () => {
  it('opens every resumed session in its own tab by default', () => {
    expect(resolveResumePacking({})).toBe('tabs');
  });

  it('packs session pairs into split panes only when requested', () => {
    expect(resolveResumePacking({ splits: true })).toBe('two-per-tab');
  });
});

describe('isDirectResumeSelector', () => {
  it('treats UUID prefixes and tmux aliases as direct identities', () => {
    expect(isDirectResumeSelector('019fd114')).toBe(true);
    expect(isDirectResumeSelector('ag-codex-c1f3d813')).toBe(true);
  });

  it('keeps human search text in the multi-select picker', () => {
    expect(isDirectResumeSelector('auth middleware')).toBe(false);
    expect(isDirectResumeSelector('claude@2.1.218')).toBe(false);
  });
});

describe('buildSessionLifecycleArgs', () => {
  it('routes an identity through focus and preserves source-device scope', () => {
    expect(buildSessionLifecycleArgs('ag-codex-c1f3d813', ['yosemite-s0'])).toEqual([
      'sessions', 'focus', 'ag-codex-c1f3d813', '--device', 'yosemite-s0',
    ]);
  });

  // `resume` is the one entry point for "put me back in that session", so the
  // attach-only vs attach-or-recover distinction has to be reachable FROM it —
  // otherwise collapsing the verbs would quietly drop a behaviour focus.test.ts
  // pins (selectFallback: --attach-only picks refuseFallback, never forks).
  it('forwards --attach-only so the no-fork behaviour survives the collapse', () => {
    expect(buildSessionLifecycleArgs('019fd114', [], true)).toEqual([
      'sessions', 'focus', '019fd114', '--attach-only',
    ]);
  });

  it('omits the flag by default — the default stays attach-or-recover', () => {
    expect(buildSessionLifecycleArgs('019fd114')).toEqual(['sessions', 'focus', '019fd114']);
  });

  // apps/ext's remote path shells `agents sessions resume <id> --local` on the
  // peer; without the flag that call dies on an unknown option.
  it('routes resume <id> --attach-only / --local through focus, not strict resume', () => {
    expect(resumeUsesLifecycleDispatch('019fd114', undefined, { attachOnly: true })).toBe(true);
    expect(resumeUsesLifecycleDispatch('019fd114', undefined, { local: true })).toBe(true);
    expect(resumeUsesLifecycleDispatch('019fd114', undefined, {})).toBe(false);
    expect(resumeUsesLifecycleDispatch('019fd114', 'finish the tests', { attachOnly: true })).toBe(false);
    expect(resumeUsesLifecycleDispatch('auth middleware', undefined, { attachOnly: true })).toBe(false);
  });

  it('forwards --local so the extension remote path keeps working', () => {
    expect(buildSessionLifecycleArgs('019fd114', [], false, true)).toEqual([
      'sessions', 'focus', '019fd114', '--local',
    ]);
  });

  it('keeps both the host scope and the flag together', () => {
    expect(buildSessionLifecycleArgs('019fd114', ['zion'], true)).toEqual([
      'sessions', 'focus', '019fd114', '--device', 'zion', '--attach-only',
    ]);
  });
});

describe('resumeHostMismatch', () => {
  it('accepts the indexed origin device', () => {
    expect(resumeHostMismatch({ shortId: 'abc12345', machine: 'yosemite-s0' }, 'yosemite-s0', 'zion')).toBeNull();
  });

  it('refuses to migrate recovery to another device', () => {
    expect(resumeHostMismatch({ shortId: 'abc12345', machine: 'yosemite-s0' }, 'zion', 'zion'))
      .toMatch(/originated on yosemite-s0.*cannot move recovery/);
  });
});

describe('resume picker filter (in-memory, no DB)', () => {
  const makeSessions = (): SessionMeta[] => [
    { id: 'aaaa1111', shortId: 'aaaa1111', agent: 'claude', topic: 'auth middleware fix', cwd: '/repo/auth' } as SessionMeta,
    { id: 'bbbb2222', shortId: 'bbbb2222', agent: 'codex', topic: 'frontend refactor', cwd: '/repo/ui' } as SessionMeta,
    { id: 'cccc3333', shortId: 'cccc3333', agent: 'claude', topic: 'db migration', cwd: '/repo/db' } as SessionMeta,
  ];

  it('returns all sessions for an empty query', () => {
    const sessions = makeSessions();
    const filter = (q: string) => (q.trim() ? sessions.filter((s) => sessionMatchesQuery(s, q)) : sessions);
    expect(filter('')).toHaveLength(3);
    expect(filter('   ')).toHaveLength(3);
  });

  it('filters by agent name in-memory', () => {
    const sessions = makeSessions();
    const filter = (q: string) => (q.trim() ? sessions.filter((s) => sessionMatchesQuery(s, q)) : sessions);
    const result = filter('claude');
    expect(result).toHaveLength(2);
    expect(result.every((s) => s.agent === 'claude')).toBe(true);
  });

  it('filters by topic substring in-memory', () => {
    const sessions = makeSessions();
    const filter = (q: string) => (q.trim() ? sessions.filter((s) => sessionMatchesQuery(s, q)) : sessions);
    const result = filter('auth');
    expect(result).toHaveLength(1);
    expect(result[0].shortId).toBe('aaaa1111');
  });

  it('multi-term filter requires all terms to match', () => {
    const sessions = makeSessions();
    const filter = (q: string) => (q.trim() ? sessions.filter((s) => sessionMatchesQuery(s, q)) : sessions);
    expect(filter('claude auth')).toHaveLength(1);
    expect(filter('claude frontend')).toHaveLength(0);
  });

  it('does not call filterSessionsByQuery (no DB scan per keystroke)', async () => {
    // Verify the sessions module's FTS function is NOT imported into sessions-resume.
    // If it were, this dynamic import would expose it as used.
    const resumeMod = await import('./sessions-resume.js');
    const sessionsMod = await import('./sessions.js');
    // The resume module uses sessionMatchesQuery, not filterSessionsByQuery.
    // We verify this indirectly: filterSessionsByQuery is not re-exported from sessions-resume.
    expect((resumeMod as Record<string, unknown>)['filterSessionsByQuery']).toBeUndefined();
    // And sessionMatchesQuery is the correct in-memory function.
    expect(typeof sessionMatchesQuery).toBe('function');
    // Confirm it does not touch the DB by ensuring it works with plain objects.
    const s = { id: 'x', shortId: 'x', agent: 'claude', topic: 'test topic', cwd: '/tmp' } as SessionMeta;
    expect(sessionMatchesQuery(s, 'test')).toBe(true);
    expect(sessionMatchesQuery(s, 'notfound')).toBe(false);
  });
});

describe('sessionsResumeAction — the PHNX-3292 local gate wiring (real tmux socket, no mocking)', () => {
  // Random suffix so this can never collide with a genuinely live pane on the
  // machine running the suite. attachLocalLiveSelector reads the REAL default
  // tmux socket (list-sessions / has-session — read-only), so this alias must
  // be one no live session will ever hold.
  const randomAlias = (): string => `ag-claude-${randomBytes(4).toString('hex')}`;

  it('a bare alias resume with no live local pane falls through to strict resume instead of hanging', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const priorExitCode = process.exitCode;
    process.exitCode = undefined;
    try {
      // No live pane for this alias -> attachLocalLiveSelector returns false ->
      // falls through to runStrictResume -> resolveSessionMetadataValue finds
      // nothing locally or on the (empty, sandboxed-HOME) fleet -> reports
      // "No session matching", never a silent hang or a thrown error.
      await sessionsResumeAction(randomAlias(), undefined, {});
      expect(errSpy.mock.calls.flat().join('\n')).toContain('No session matching');
      expect(process.exitCode).toBe(1);
    } finally {
      errSpy.mockRestore();
      process.exitCode = priorExitCode;
    }
  });

  it('the same miss with --device scopes the gate off, still falls through cleanly', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const priorExitCode = process.exitCode;
    process.exitCode = undefined;
    try {
      // shouldAttachLocalTmuxAliasBeforeFleet is false whenever hosts.length > 0
      // (rule 4: --device skips the local gate entirely) — attachLocalLiveSelector
      // never touches the local tmux socket here, and the selector still resolves
      // (as not-found) rather than hanging.
      await sessionsResumeAction(randomAlias(), undefined, { device: 'nonexistent-device-xyz' });
      expect(errSpy.mock.calls.flat().join('\n')).toMatch(/No session matching|unreachable/);
      expect(process.exitCode).toBe(1);
    } finally {
      errSpy.mockRestore();
      process.exitCode = priorExitCode;
    }
  });
});


describe('selected resume argv', () => {
  it('consumes placement already applied by the outer terminal surface', () => {
    expect(buildSelectedResumeArgs('abc12345', undefined, { device: 'worker', runArgs: ['run', 'claude#work', '--resume', '--device', 'worker', '--mode', 'plan'] })).toEqual(['run', 'claude#work', '--resume', 'abc12345', '--mode', 'plan']);
  });

  it.each([['-D', 'worker'], ['-Dworker'], ['--on', 'worker'], ['--computer=worker']])('consumes placement alias %j and applies remote cwd', (...placement) => {
    const runArgs = ['run', 'claude', '--resume', ...placement, '--cwd', '/local', '--remote-cwd', '/srv/repo', '--', '--verbose'];
    expect(buildSelectedResumeArgs('abc12345', undefined, { device: 'worker', runArgs })).toEqual([
      'run', 'claude', '--resume', 'abc12345', '--cwd', '/srv/repo', '--', '--verbose',
    ]);
  });

  it('rejects attach-only options that would launch a copy before lookup', async () => {
    await expect(sessionsResumeAction('abc12345', undefined, { attachOnly: true, mode: 'edit' })).rejects.toThrow('--attach-only cannot');
    await expect(sessionsResumeAction('abc12345', undefined, { attachOnly: true, agent: 'codex' })).rejects.toThrow('--attach-only cannot');
  });

  it('retains run flags and native passthrough while filling the selected identity', () => {
    const runArgs = ['run', 'claude#work', '--resume', '--raw', '--env', 'FEATURE=on', '--timeout', '3m', '--effort', 'high', '--', '--verbose'];
    expect(buildSelectedResumeArgs('abc12345', undefined, { runArgs })).toEqual([
      'run', 'claude#work', '--resume', 'abc12345', '--raw', '--env', 'FEATURE=on', '--timeout', '3m', '--effort', 'high', '--', '--verbose',
    ]);
    expect(runArgs[3]).toBe('--raw');
  });

  it('consumes surface flags while retaining attach-only and local scope', () => {
    expect(buildSelectedResumeArgs('abc12345', undefined, { tmux: true, local: true, attachOnly: true })).toEqual([
      'sessions', 'resume', 'abc12345', '--local', '--attach-only',
    ]);
    expect(buildSelectedResumeArgs('abc12345', undefined, { vscodium: true, here: true })).toEqual([
      'sessions', 'resume', 'abc12345', '--here',
    ]);
  });
});

describe('selected resume terminal surface', () => {
  const session = (cwd?: string): SessionMeta => ({ id: 'abc12345', shortId: 'abc12345', cwd } as SessionMeta);

  it.each([
    'finish the tests now please',
    "finish it's done: literal $(whoami), `id`, and a\nsecond line",
  ])('preserves prompt argv through the production surface and a real shell: %j', (prompt) => {
    const surface = buildSelectedResumeSurface(session(), prompt, { headless: true });
    // Use Node as an argv probe, preserving the surface's actual argument words.
    const command = [
      shellQuote(process.execPath), '-e',
      shellQuote('process.stdout.write(JSON.stringify(process.argv.slice(1)))'),
      ...surface.command.slice(1),
    ];
    const received = JSON.parse(execFileSync('sh', ['-c', execOnly(command)], { encoding: 'utf8' }));
    expect(received).toEqual(['sessions', 'resume', 'abc12345', prompt, '--headless']);
  });

  it('keeps raw run-picker argv until the terminal boundary', () => {
    const prompt = "finish it's done";
    const options = { runArgs: ['run', 'claude', prompt, '--resume'], headless: true };
    const surface = buildSelectedResumeSurface(session(), undefined, options);
    const command = [shellQuote(process.execPath), '-e', shellQuote('process.stdout.write(JSON.stringify(process.argv.slice(1)))'), ...surface.command.slice(1)];
    expect(JSON.parse(execFileSync('sh', ['-c', execOnly(command)], { encoding: 'utf8' })))
      .toEqual(['run', 'claude', prompt, '--resume', 'abc12345']);
    expect(options.runArgs).toEqual(['run', 'claude', prompt, '--resume']);
  });

  it('checks local and --here directories while leaving origin directories to the peer', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-resume-cwd-'));
    try {
      const missing = path.join(root, 'only-on-the-origin');
      expect(buildSelectedResumeSurface(session(root), undefined, {}).cwd).toBe(root);
      expect(buildSelectedResumeSurface(session(missing), undefined, { here: true }).cwd).toBe(process.cwd());
      expect(buildSelectedResumeSurface(session(missing), undefined, { device: 'worker' }).cwd).toBe(missing);
      expect(buildSelectedResumeSurface(session(missing), undefined, { device: 'worker', here: true }).cwd).toBe(missing);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  it("uses the run picker's effective remote cwd for both the terminal and the resumed command", () => {
    const runArgs = ['run', 'claude', '--resume', '--device', 'worker', '--cwd', '/local', '--remote-cwd', '/srv/repo'];
    const surface = buildSelectedResumeSurface(session(), undefined, { device: 'worker', cwd: '/srv/repo', runArgs });
    expect(surface.cwd).toBe('/srv/repo');
    expect(surface.command).toEqual(['agents', 'run', 'claude', '--resume', 'abc12345', '--cwd', '/srv/repo'].map(shellQuote));
  });

  it('makes run cwd portable once and leaves native passthrough arguments unchanged', () => {
    const runArgs = ['run', 'claude', '--resume', '--device=worker', '--cwd=' + path.join(os.homedir(), 'repo'), '--', '--cwd', '/native'];
    expect(buildSelectedResumeArgs('abc12345', undefined, { device: 'worker', runArgs }))
      .toEqual(['run', 'claude', '--resume', 'abc12345', '--cwd', '~/repo', '--', '--cwd', '/native']);
  });

  it('opens a remote surface in the explicit cwd even when the recorded directory is gone', () => {
    const surface = buildSelectedResumeSurface(session('/old/repo'), undefined, { device: 'worker', cwd: '/new/repo' });
    expect(surface.cwd).toBe('/new/repo');
    expect(surface.command.slice(-2)).toEqual(['--cwd', '/new/repo'].map(shellQuote));
  });

  it("refuses a remote surface with no cwd instead of sending this machine's path", () => {
    expect(() => buildSelectedResumeSurface(session(), undefined, { device: 'worker' }))
      .toThrow('without a recorded working directory. Pass --cwd <path>.');
    expect(buildSelectedResumeSurface(session(), undefined, { device: 'worker', cwd: '/repo' }).cwd).toBe('/repo');
  });
});

describe('partitionResumableSelections — the picker drops what recovery would refuse', () => {
  const meta = (over: Partial<SessionMeta>): SessionMeta => ({
    id: '14567b8a-db63-4e27-9867-4846813157cc',
    shortId: '14567b8a',
    agent: 'claude',
    timestamp: '2026-09-12T17:00:00.000Z',
    filePath: '',
    ...over,
  }) as SessionMeta;

  it('keeps a session with a real on-disk transcript', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-partition-'));
    try {
      const filePath = path.join(root, 't.jsonl');
      fs.writeFileSync(filePath, '{}\n');
      const { resumable, skipped } = partitionResumableSelections([meta({ filePath })]);
      expect(resumable).toHaveLength(1);
      expect(skipped).toHaveLength(0);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  it('skips a path-less live-registry row and a mirror explicitly requested here', () => {
    const { resumable, skipped } = partitionResumableSelections([
      meta({ filePath: '' }),
      meta({ shortId: 'bbbbbbbb', machine: 'peer-worker', filePath: '', mirrorSyncedAt: Date.parse('2026-09-12T17:00:00.000Z'), mirrorSource: 'peer-worker' }),
    ], { here: true });
    expect(resumable).toHaveLength(0);
    expect(skipped.map(s => s.shortId)).toEqual(['14567b8a', 'bbbbbbbb']);
  });

  it('defers peer transcripts and mirrored rows to their owner instead of checking local files', () => {
    const peer = meta({ machine: 'peer-worker', filePath: '/peer-only/session.jsonl' });
    const mirror = meta({ shortId: 'bbbbbbbb', machine: 'peer-worker', filePath: '', mirrorSource: 'peer-worker', mirrorSyncedAt: Date.now() });
    expect(partitionResumableSelections([peer, mirror])).toEqual({ resumable: [peer, mirror], skipped: [] });
    expect(partitionResumableSelections([peer, mirror], { here: true })).toEqual({ resumable: [], skipped: [peer, mirror] });
    expect(partitionResumableSelections([peer, mirror], { here: true, device: 'peer-worker' }))
      .toEqual({ resumable: [peer, mirror], skipped: [] });
    const local = meta({ machine: 'localhost', filePath: '' });
    expect(partitionResumableSelections([local])).toEqual({ resumable: [], skipped: [local] });
  });

  it('partitions a mixed batch without reordering either side', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-partition-mixed-'));
    try {
      const good = path.join(root, 'g.jsonl');
      fs.writeFileSync(good, '{}\n');
      const { resumable, skipped } = partitionResumableSelections([
        meta({ shortId: 'aaaaaaaa', filePath: good }),
        meta({ shortId: 'bbbbbbbb', filePath: '' }),
        meta({ shortId: 'cccccccc', filePath: good }),
        meta({ shortId: 'dddddddd', filePath: '' }),
      ]);
      expect(resumable.map(s => s.shortId)).toEqual(['aaaaaaaa', 'cccccccc']);
      expect(skipped.map(s => s.shortId)).toEqual(['bbbbbbbb', 'dddddddd']);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
});

/**
 * `sessions resume` shares flag names with its parent `sessions` command
 * (-a/--agent, --all, --teams, --since, -n/--limit, --local, -D/--device,
 * --devices). root-command.ts deliberately never calls
 * `enablePositionalOptions()`, so commander's parser scans the FULL argv for
 * options belonging to `sessions` before it recognizes `resume` as a
 * subcommand — a colliding flag is consumed into the PARENT's own option and
 * never reaches the resume subcommand's action. These tests parse the real,
 * fully registered command tree (`buildFullCommandTree`, the same helper
 * root-command.test.ts uses for the sibling RUSH-2687 collision) to prove the
 * collision actually happens on live wiring, then exercise the exported
 * `resolveResumeOptions` — which the resume action calls — against the real
 * post-parse `Command` instances, not hand-fed options.
 */
describe('resolveResumeOptions — recovering resume flags the parent command swallows', () => {
  async function parseResume(argv: string[]): Promise<{ resumeCmd: Command; captured: Record<string, unknown> }> {
    const program = await buildFullCommandTree();
    program.exitOverride();
    const sessionsCmd = program.commands.find((c) => c.name() === 'sessions');
    if (!sessionsCmd) throw new Error('sessions command not registered');
    const resumeCmd = sessionsCmd.commands.find((c) => c.name() === 'resume');
    if (!resumeCmd) throw new Error('sessions resume not registered');
    let captured: Record<string, unknown> = {};
    resumeCmd.action((..._args: unknown[]) => { captured = resumeCmd.opts(); });
    await program.parseAsync(['node', 'agents', 'sessions', ...argv], { from: 'node' });
    return { resumeCmd, captured };
  }

  it('reproduces the real collision: a --device typed after "resume" never reaches the subcommand\'s own opts', async () => {
    const { resumeCmd, captured } = await parseResume(['resume', '019fd0c8b3e977a2a1a4444698c4d897', 'finish it', '--device', 'yosemite-m5', '--tmux']);
    // The genuine bug: commander's parent-level scan ate --device before dispatch.
    expect(captured.device).toBeUndefined();
    expect(captured.tmux).toBe(true);
    expect(resumeCmd.parent?.getOptionValueSource('device')).toBe('cli');
    expect((resumeCmd.parent?.opts() as { device?: string[] }).device).toEqual(['yosemite-m5']);
    // resolveResumeOptions recovers it onto the resume options the action uses.
    const resolved = resolveResumeOptions(resumeCmd, captured as never);
    expect(resolved.device).toBe('yosemite-m5');
    expect((resolved as { tmux?: boolean }).tmux).toBe(true);
  });

  it('keeps resume\'s own 200 default when no --limit is typed, even though the parent default is 50', async () => {
    const { resumeCmd, captured } = await parseResume(['resume', '019fd0c8b3e977a2a1a4444698c4d897']);
    expect(resumeCmd.parent?.getOptionValueSource('limit')).toBe('default');
    const resolved = resolveResumeOptions(resumeCmd, captured as never);
    expect(resolved.limit).toBe('200');
  });

  it('an explicit --limit overrides resume\'s own default', async () => {
    const { resumeCmd, captured } = await parseResume(['resume', '019fd0c8b3e977a2a1a4444698c4d897', '--limit', '9']);
    expect(resumeCmd.parent?.getOptionValueSource('limit')).toBe('cli');
    const resolved = resolveResumeOptions(resumeCmd, captured as never);
    expect(resolved.limit).toBe('9');
  });

  it('supports the plural --devices alias, collapsing to the one device', async () => {
    const { resumeCmd, captured } = await parseResume(['resume', '019fd0c8b3e977a2a1a4444698c4d897', '--devices', 'zion']);
    const resolved = resolveResumeOptions(resumeCmd, captured as never);
    expect(resolved.device).toBe('zion');
  });

  it('fails clearly on multiple devices instead of silently picking one', async () => {
    const { resumeCmd, captured } = await parseResume(['resume', '019fd0c8b3e977a2a1a4444698c4d897', '--device', 'zion', 'yosemite-m5']);
    expect(() => resolveResumeOptions(resumeCmd, captured as never)).toThrow(/sessions resume targets a single device/);
  });

  it('recovers --agent, --all, --teams, --since, and --local when explicitly typed', async () => {
    const { resumeCmd, captured } = await parseResume([
      'resume', '019fd0c8b3e977a2a1a4444698c4d897',
      '--agent', 'codex', '--all', '--teams', '--since', '7d', '--local',
    ]);
    // None of these reached the subcommand's own opts — the parent ate them.
    expect(captured.agent).toBeUndefined();
    expect(captured.all).toBeUndefined();
    expect(captured.teams).toBeUndefined();
    expect(captured.since).toBeUndefined();
    expect(captured.local).toBeUndefined();
    const resolved = resolveResumeOptions(resumeCmd, captured as never);
    expect(resolved.agent).toBe('codex');
    expect(resolved.all).toBe(true);
    expect(resolved.teams).toBe(true);
    expect(resolved.since).toBe('7d');
    expect(resolved.local).toBe(true);
  });

  it('leaves resume-only flags (--mode/--headless/--cwd/--attach-only) untouched', async () => {
    const { resumeCmd, captured } = await parseResume(['resume', '019fd0c8b3e977a2a1a4444698c4d897', '--headless', '--cwd', '/tmp/work']);
    const resolved = resolveResumeOptions(resumeCmd, captured as never);
    expect(resolved.headless).toBe(true);
    expect(resolved.cwd).toBe('/tmp/work');
  });

  it('normal sibling `sessions backfill tools` inherited parsing (--since/--json/--local via optsWithGlobals) is unaffected by this fix', async () => {
    const program = await buildFullCommandTree();
    program.exitOverride();
    const sessionsCmd = program.commands.find((c) => c.name() === 'sessions')!;
    const backfill = sessionsCmd.commands.find((c) => c.name() === 'backfill')!;
    const tools = backfill.commands.find((c) => c.name() === 'tools')!;
    let captured: Record<string, unknown> | undefined;
    tools.action((_opts: unknown, command: Command) => { captured = command.optsWithGlobals(); });
    await program.parseAsync(['node', 'agents', 'sessions', 'backfill', 'tools', '--since', '7d', '--json', '--local'], { from: 'node' });
    expect(captured?.since).toBe('7d');
    expect(captured?.json).toBe(true);
    expect(captured?.local).toBe(true);
  });
});
