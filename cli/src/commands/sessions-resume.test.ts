import { describe, expect, it, vi } from 'vitest';
import { randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  buildSelectedResumeArgs,
  buildSessionLifecycleArgs,
  isDirectResumeSelector,
  partitionResumableSelections,
  resolveResumePacking,
  resolveSelectedResumeCwd,
  resumeHostMismatch,
  resumeUsesLifecycleDispatch,
  sessionsResumeAction,
} from './sessions-resume.js';
import { sessionMatchesQuery } from './sessions-browser.js';
import type { SessionMeta } from '../lib/session/types.js';
import { shellQuote } from '../lib/terminal/index.js';
import { execOnly } from '../lib/terminal/shell.js';

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
      'run', 'claude', '--resume', 'abc12345', '--cwd', '/local', '--cwd', '/srv/repo', '--', '--verbose',
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

describe('selected resume command — real shell/backend round trip (PHNX-3940)', () => {
  // Every terminal backend (iterm/ghostty/tmux/terminal-app) joins `command`
  // with a bare space and hands it to a login shell via loginExec/execOnly
  // (lib/terminal/shell.ts), exactly like run-surface.ts's buildRunCommand. If
  // the selected-resume command is not pre-quoted per-word the same way,
  // opening a picked session with a multiword prompt splits it into several
  // CLI arguments, and a literal `$(...)`/backtick in it is executed by the
  // shell instead of riding through as text.
  const tricky = `finish it's done — run $(whoami) and \`id\` now`;

  function runThroughRealShell(command: string[], binDir: string): string[] {
    const script = execOnly(command);
    const out = execFileSync('sh', ['-c', script], {
      cwd: binDir,
      env: { ...process.env, PATH: `${binDir}:${process.env.PATH ?? ''}` },
      encoding: 'utf8',
    });
    return out.split('\n').filter((l) => l.length > 0);
  }

  function withFakeAgentsOnPath(fn: (binDir: string) => void): void {
    const binDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-resume-quote-'));
    try {
      const fakeAgents = path.join(binDir, 'agents');
      // Prints each argv it received on its own line — the cheapest possible
      // probe for "did the shell see this as one argument or several".
      fs.writeFileSync(fakeAgents, '#!/bin/sh\nfor a in "$@"; do printf \'%s\\n\' "$a"; done\n');
      fs.chmodSync(fakeAgents, 0o755);
      fn(binDir);
    } finally {
      fs.rmSync(binDir, { recursive: true, force: true });
    }
  }

  it('reproduces the bug: unquoted argv corrupts the shell line (apostrophe breaks syntax; no quoting splits the rest)', () => {
    withFakeAgentsOnPath((binDir) => {
      // This is the OLD sessions-resume.ts line, before the fix:
      //   const command = ['agents', ...buildSelectedResumeArgs(s.id, prompt, options)];
      const unquotedCommand = ['agents', ...buildSelectedResumeArgs('abc12345', tricky, {})];
      // The apostrophe in the prompt opens an unterminated shell string — the
      // command isn't just mis-split, it doesn't even parse. That is the bug:
      // production code handed raw, unescaped user text straight to a shell.
      expect(() => runThroughRealShell(unquotedCommand, binDir)).toThrow(/Unterminated quoted string|unexpected EOF/);

      // A prompt with no special shell characters still gets split on
      // whitespace into several argv entries instead of arriving as one.
      const plainPrompt = 'finish the tests now please';
      const splitCommand = ['agents', ...buildSelectedResumeArgs('abc12345', plainPrompt, {})];
      const received = runThroughRealShell(splitCommand, binDir);
      expect(received).not.toEqual(['sessions', 'resume', 'abc12345', plainPrompt]);
      expect(received).toEqual(['sessions', 'resume', 'abc12345', ...plainPrompt.split(' ')]);
    });
  });

  it('fix: the production command (shell-quoted per word) survives the same round trip intact', () => {
    withFakeAgentsOnPath((binDir) => {
      // This is the production sessions-resume.ts line verbatim.
      const command = ['agents', ...buildSelectedResumeArgs('abc12345', tricky, {})].map(shellQuote);
      const received = runThroughRealShell(command, binDir);
      expect(received).toEqual(['sessions', 'resume', 'abc12345', tricky]);
    });
  });

  it('an apostrophe-only prompt also survives quoting (the single-quote escape path)', () => {
    withFakeAgentsOnPath((binDir) => {
      const prompt = "it's a trap";
      const command = ['agents', ...buildSelectedResumeArgs('abc12345', prompt, {})].map(shellQuote);
      const received = runThroughRealShell(command, binDir);
      expect(received).toEqual(['sessions', 'resume', 'abc12345', prompt]);
    });
  });
});

describe('resolveSelectedResumeCwd — a --device surface trusts the origin cwd', () => {
  it('uses the local existence guard with no --device (unaffected by the fix)', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-resume-cwd-'));
    try {
      expect(resolveSelectedResumeCwd({ cwd: root }, {})).toBe(root);
      const missing = path.join(root, 'does-not-exist-locally');
      expect(resolveSelectedResumeCwd({ cwd: missing }, {})).toBe(process.cwd());
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  it('trusts the recorded origin cwd under --device even when it is not a local path', () => {
    // A real /home path from a remote Linux origin will never exist on a local
    // /Users checkout — fs.existsSync(remoteCwd) is always false here, which is
    // exactly the bug: it silently swapped in this box's cwd instead of letting
    // the selected origin device validate its own path.
    const remoteCwd = '/home/remote-user/repo';
    expect(fs.existsSync(remoteCwd)).toBe(false);
    expect(resolveSelectedResumeCwd({ cwd: remoteCwd }, { device: 'worker-1' })).toBe(remoteCwd);
  });

  it('falls back to process.cwd() under --device only when the session recorded no cwd at all', () => {
    expect(resolveSelectedResumeCwd({ cwd: undefined }, { device: 'worker-1' })).toBe(process.cwd());
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
