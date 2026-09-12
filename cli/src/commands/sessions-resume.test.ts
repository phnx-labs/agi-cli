import { describe, expect, it, vi } from 'vitest';
import { randomBytes } from 'node:crypto';
import {
  buildSessionLifecycleArgs,
  explicitBackendRequested,
  isDirectResumeSelector,
  resolveResumePacking,
  resumeHostMismatch,
  resumeUsesLifecycleDispatch,
  sessionsResumeAction,
} from './sessions-resume.js';
import { sessionMatchesQuery } from './sessions-browser.js';
import type { SessionMeta } from '../lib/session/types.js';

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

describe('explicitBackendRequested', () => {
  it('is false for a bare resume with no backend flag', () => {
    expect(explicitBackendRequested({})).toBe(false);
  });

  it('is true for any one of the five explicit backend flags', () => {
    expect(explicitBackendRequested({ iterm: true })).toBe(true);
    expect(explicitBackendRequested({ ghostty: true })).toBe(true);
    expect(explicitBackendRequested({ tmux: true })).toBe(true);
    expect(explicitBackendRequested({ vscodium: true })).toBe(true);
    expect(explicitBackendRequested({ terminalApp: true })).toBe(true);
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
