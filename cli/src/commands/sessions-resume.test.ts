import { describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  buildSelectedResumeArgs,
  buildSessionLifecycleArgs,
  partitionResumableSelections,
  resolveResumePacking,
  buildSelectedResumeSurface,
  resumeHostMismatch,
  sessionsResumeAction,
  stillRunningNotice,
} from './sessions-resume.js';
import { sessionMatchesQuery } from '../lib/session/selection.js';
import type { SessionMeta } from '@phnx-labs/sessions-cli/reader';
import { shellQuote } from '../lib/terminal/index.js';
import { execOnly } from '../lib/terminal/shell.js';
import { buildFullCommandTree } from '../cli/command-registry.js';
import { setArgvCommandTree } from '../lib/hosts/routing-flag.js';

describe('resolveResumePacking', () => {
  it('opens every resumed session in its own tab by default', () => {
    expect(resolveResumePacking({})).toBe('tabs');
  });

  it('packs session pairs into split panes only when requested', () => {
    expect(resolveResumePacking({ splits: true })).toBe('two-per-tab');
  });
});

describe('buildSessionLifecycleArgs', () => {
  it('routes an identity through focus and preserves source-device scope', () => {
    expect(buildSessionLifecycleArgs('ag-codex-c1f3d813', ['yosemite-s0'])).toEqual([
      'ps', 'focus', 'ag-codex-c1f3d813', '--device', 'yosemite-s0',
    ]);
  });

  it('forwards --attach-only so the no-fork behaviour survives the collapse', () => {
    expect(buildSessionLifecycleArgs('019fd114', [], true)).toEqual([
      'ps', 'focus', '019fd114', '--attach-only',
    ]);
  });

  it('omits the flag by default — the default stays attach-or-recover', () => {
    expect(buildSessionLifecycleArgs('019fd114')).toEqual(['ps', 'focus', '019fd114']);
  });

  it('forwards --local so the extension remote path keeps working', () => {
    expect(buildSessionLifecycleArgs('019fd114', [], false, true)).toEqual([
      'ps', 'focus', '019fd114', '--local',
    ]);
  });

  it('keeps both the host scope and the flag together', () => {
    expect(buildSessionLifecycleArgs('019fd114', ['zion'], true)).toEqual([
      'ps', 'focus', '019fd114', '--device', 'zion', '--attach-only',
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
    const resumeMod = await import('./sessions-resume.js');
    expect((resumeMod as Record<string, unknown>)['filterSessionsByQuery']).toBeUndefined();
    expect(typeof sessionMatchesQuery).toBe('function');
    const s = { id: 'x', shortId: 'x', agent: 'claude', topic: 'test topic', cwd: '/tmp' } as SessionMeta;
    expect(sessionMatchesQuery(s, 'test')).toBe(true);
    expect(sessionMatchesQuery(s, 'notfound')).toBe(false);
  });
});

describe('sessionsResumeAction', () => {
  it('refuses to open the picker without an interactive terminal and names the id form', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const priorExitCode = process.exitCode;
    process.exitCode = undefined;
    try {
      await sessionsResumeAction({ runArgs: ['run', 'claude', '--resume'] });
      expect(errSpy.mock.calls.flat().join('\n')).toContain('agents run --resume needs an interactive terminal');
      expect(process.exitCode).toBe(1);
    } finally {
      errSpy.mockRestore();
      process.exitCode = priorExitCode;
    }
  });

  it('reports an older copy left running, naming the host and pid', () => {
    expect(stillRunningNotice('abc12345', 4242, 'zion'))
      .toBe('An older copy of abc12345 is still running on zion (pid 4242). It was left alone.\n');
  });
});

describe('selected resume argv', () => {
  it('consumes placement already applied by the outer terminal surface', () => {
    expect(buildSelectedResumeArgs('abc12345', { device: 'worker', runArgs: ['run', 'claude#work', '--resume', '--device', 'worker', '--mode', 'plan'] })).toEqual(['run', 'claude#work', '--resume', 'abc12345', '--mode', 'plan']);
  });

  it.each([['-D', 'worker'], ['-Dworker'], ['--on', 'worker'], ['--computer=worker']])('consumes placement alias %j and applies remote cwd', (...placement) => {
    const runArgs = ['run', 'claude', '--resume', ...placement, '--cwd', '/local', '--remote-cwd', '/srv/repo', '--', '--verbose'];
    expect(buildSelectedResumeArgs('abc12345', { device: 'worker', runArgs })).toEqual([
      'run', 'claude', '--resume', 'abc12345', '--cwd', '/srv/repo', '--', '--verbose',
    ]);
  });

  it('drops the picker-only filters from the child run, keeping option values and passthrough intact', async () => {
    setArgvCommandTree(await buildFullCommandTree());
    try {
      const runArgs = [
        'run', 'claude', '--resume', '--all', '--teams', '--since=7d', '-n5', '--name', '--all', '--limit', '9',
        '--', '--all', '--since', '1d', '-n', '2',
      ];
      expect(buildSelectedResumeArgs('abc12345', { runArgs })).toEqual([
        'run', 'claude', '--resume', 'abc12345', '--name', '--all', '--', '--all', '--since', '1d', '-n', '2',
      ]);
      expect(buildSelectedResumeArgs('abc12345', {
        runArgs: ['run', 'claude', '--resume', '--teams', '--since=60d', '-bn5', '--name', '-bn5', '--', '-bn5'],
      })).toEqual(['run', 'claude', '--resume', 'abc12345', '-b', '--name', '-bn5', '--', '-bn5']);
      expect(buildSelectedResumeArgs('abc12345', { runArgs: ['run', 'claude', '--resume', '-bn', '5'] }))
        .toEqual(['run', 'claude', '--resume', 'abc12345', '-b']);
    } finally {
      setArgvCommandTree(undefined);
    }
  });

  it('retains run flags and native passthrough while filling the selected identity', () => {
    const runArgs = ['run', 'claude#work', '--resume', '--raw', '--env', 'FEATURE=on', '--timeout', '3m', '--effort', 'high', '--', '--verbose'];
    expect(buildSelectedResumeArgs('abc12345', { runArgs })).toEqual([
      'run', 'claude#work', '--resume', 'abc12345', '--raw', '--env', 'FEATURE=on', '--timeout', '3m', '--effort', 'high', '--', '--verbose',
    ]);
    expect(runArgs[3]).toBe('--raw');
  });

});

describe('selected resume terminal surface', () => {
  const session = (cwd?: string): SessionMeta => ({ id: 'abc12345', shortId: 'abc12345', cwd } as SessionMeta);
  const run = (): string[] => ['run', 'claude', '--resume'];

  it.each([
    'finish the tests now please',
    "finish it's done: literal $(whoami), `id`, and a\nsecond line",
  ])('preserves prompt argv through the production surface and a real shell: %j', (prompt) => {
    const surface = buildSelectedResumeSurface(session(), { runArgs: ['run', 'claude', prompt, '--resume'] });
    const command = [
      shellQuote(process.execPath), '-e',
      shellQuote('process.stdout.write(JSON.stringify(process.argv.slice(1)))'),
      ...surface.command.slice(1),
    ];
    const received = JSON.parse(execFileSync('sh', ['-c', execOnly(command)], { encoding: 'utf8' }));
    expect(received).toEqual(['run', 'claude', prompt, '--resume', 'abc12345', '--quiet']);
  });

  it('keeps raw run-picker argv until the terminal boundary', () => {
    const prompt = "finish it's done";
    const options = { runArgs: ['run', 'claude', prompt, '--resume'], headless: true };
    const surface = buildSelectedResumeSurface(session(), options);
    const command = [shellQuote(process.execPath), '-e', shellQuote('process.stdout.write(JSON.stringify(process.argv.slice(1)))'), ...surface.command.slice(1)];
    expect(JSON.parse(execFileSync('sh', ['-c', execOnly(command)], { encoding: 'utf8' })))
      .toEqual(['run', 'claude', prompt, '--resume', 'abc12345', '--quiet']);
    expect(options.runArgs).toEqual(['run', 'claude', prompt, '--resume']);
  });

  it('checks local and --here directories while leaving origin directories to the peer', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-resume-cwd-'));
    try {
      const missing = path.join(root, 'only-on-the-origin');
      expect(buildSelectedResumeSurface(session(root), { runArgs: run() }).cwd).toBe(root);
      expect(buildSelectedResumeSurface(session(missing), { here: true, runArgs: run() }).cwd).toBe(process.cwd());
      expect(buildSelectedResumeSurface(session(missing), { device: 'worker', runArgs: run() }).cwd).toBe(missing);
      expect(buildSelectedResumeSurface(session(missing), { device: 'worker', here: true, runArgs: run() }).cwd).toBe(missing);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  it("uses the run picker's effective remote cwd for both the terminal and the resumed command", () => {
    const runArgs = ['run', 'claude', '--resume', '--device', 'worker', '--cwd', '/local', '--remote-cwd', '/srv/repo'];
    const surface = buildSelectedResumeSurface(session(), { device: 'worker', cwd: '/srv/repo', runArgs });
    expect(surface.cwd).toBe('/srv/repo');
    expect(surface.command).toEqual(['agents', 'run', 'claude', '--resume', 'abc12345', '--cwd', '/srv/repo', '--quiet'].map(shellQuote));
  });

  it('makes run cwd portable once and leaves native passthrough arguments unchanged', () => {
    const runArgs = ['run', 'claude', '--resume', '--device=worker', '--cwd=' + path.join(os.homedir(), 'repo'), '--', '--cwd', '/native'];
    expect(buildSelectedResumeArgs('abc12345', { device: 'worker', runArgs }))
      .toEqual(['run', 'claude', '--resume', 'abc12345', '--cwd', '~/repo', '--', '--cwd', '/native']);
  });

  it('opens a remote surface in the explicit cwd even when the recorded directory is gone', () => {
    const surface = buildSelectedResumeSurface(session('/old/repo'), { device: 'worker', cwd: '/new/repo', runArgs: run() });
    expect(surface.cwd).toBe('/new/repo');
    expect(surface.command.slice(-3)).toEqual(['--cwd', '/new/repo', '--quiet'].map(shellQuote));
  });

  it('the command a tab runs opens straight into the agent (--quiet) exactly once, before a native passthrough', () => {
    expect(buildSelectedResumeSurface(session(), { runArgs: run() }).command).toEqual(['agents', 'run', 'claude', '--resume', 'abc12345', '--quiet'].map(shellQuote));
    expect(buildSelectedResumeSurface(session(), { runArgs: [...run(), '--quiet'] }).command).toEqual(['agents', 'run', 'claude', '--resume', 'abc12345', '--quiet'].map(shellQuote));
    const runArgs = ['run', 'claude', '--resume', '--', '--verbose'];
    expect(buildSelectedResumeSurface(session(), { runArgs }).command)
      .toEqual(['agents', 'run', 'claude', '--resume', 'abc12345', '--quiet', '--', '--verbose'].map(shellQuote));
  });

  it("refuses a remote surface with no cwd instead of sending this machine's path", () => {
    expect(() => buildSelectedResumeSurface(session(), { device: 'worker', runArgs: run() }))
      .toThrow('without a recorded working directory. Pass --cwd <path>.');
    expect(buildSelectedResumeSurface(session(), { device: 'worker', cwd: '/repo', runArgs: run() }).cwd).toBe('/repo');
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
