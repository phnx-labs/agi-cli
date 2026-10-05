import { describe, it, expect } from 'vitest';
import {
  SESSION_HOST_BACKENDS,
  backendFromSessions,
  resolveLaunchBackend,
  describeBackendChoice,
  type SessionHostSample,
  type BackendResolveDeps,
} from './preferred.js';
import type { Backend, EngineContext } from './types.js';

const guiCtx: EngineContext = { platform: 'darwin', env: {} };

function withApps(...installed: Backend[]): BackendResolveDeps {
  return { isAvailable: (b) => installed.includes(b) };
}
const macDefaults = withApps('iterm', 'ghostty', 'vscodium-agent', 'terminal');

describe('backendFromSessions', () => {
  it('picks the terminal the most recent live session runs in', () => {
    const sessions: SessionHostSample[] = [
      { host: 'terminal', lastActivityMs: 1_000 },
      { host: 'ghostty', lastActivityMs: 9_000 },
      { host: 'iterm', lastActivityMs: 5_000 },
    ];
    expect(backendFromSessions(sessions, guiCtx, macDefaults))
      .toEqual({ backend: 'ghostty', host: 'ghostty' });
  });

  it('falls to the next session when the newest host has no drivable backend', () => {
    const sessions: SessionHostSample[] = [
      { host: 'warp', lastActivityMs: 9_000 },
      { host: 'iterm', lastActivityMs: 5_000 },
    ];
    expect(backendFromSessions(sessions, guiCtx, macDefaults))
      .toEqual({ backend: 'iterm', host: 'iterm' });
  });

  it('ranks by startedAtMs when a session has no activity stamp', () => {
    const sessions: SessionHostSample[] = [
      { host: 'iterm', startedAtMs: 100 },
      { host: 'ghostty', startedAtMs: 900 },
    ];
    expect(backendFromSessions(sessions, guiCtx, macDefaults)?.backend).toBe('ghostty');
  });

  it('skips a backend that is not installed, however recent the session', () => {
    const sessions: SessionHostSample[] = [
      { host: 'ghostty', lastActivityMs: 9_000 },
      { host: 'iterm', lastActivityMs: 1_000 },
    ];
    expect(backendFromSessions(sessions, guiCtx, withApps('iterm')))
      .toEqual({ backend: 'iterm', host: 'iterm' });
  });

  it('skips tmux from a GUI caller, and takes it from inside tmux', () => {
    expect(backendFromSessions([{ host: 'tmux', lastActivityMs: 1 }], guiCtx)).toBeNull();
    const inTmux: EngineContext = { platform: 'darwin', env: { TMUX: '/tmp/tmux-501/default,1,0' } };
    expect(backendFromSessions([{ host: 'tmux', lastActivityMs: 1 }], inTmux))
      .toEqual({ backend: 'tmux', host: 'tmux' });
  });

  it('prefers the app a tmux session is VIEWED in over the multiplexer', () => {
    expect(backendFromSessions([{ host: 'tmux', viewingApp: 'ghostty', lastActivityMs: 9 }], guiCtx, macDefaults))
      .toEqual({ backend: 'ghostty', host: 'ghostty' });
  });

  it('keeps the tmux host when the session is detached (no viewer)', () => {
    expect(backendFromSessions([{ host: 'tmux', lastActivityMs: 9 }], guiCtx, macDefaults)).toBeNull();
  });

  it('returns null for sessions with no host at all', () => {
    expect(backendFromSessions([{ lastActivityMs: 5 }, {}], guiCtx, macDefaults)).toBeNull();
  });

  it('ignores a host that only matches Object.prototype', () => {
    expect(backendFromSessions([{ host: 'constructor', lastActivityMs: 9 }], guiCtx, macDefaults)).toBeNull();
    expect(backendFromSessions([{ host: 'toString', lastActivityMs: 9 }], guiCtx, macDefaults)).toBeNull();
  });

  it('maps only hosts the engine can really drive', () => {
    expect(SESSION_HOST_BACKENDS.cursor).toBeUndefined();
    expect(SESSION_HOST_BACKENDS.code).toBeUndefined();
    expect(SESSION_HOST_BACKENDS.warp).toBeUndefined();
    expect(SESSION_HOST_BACKENDS.codium).toBe('vscodium-agent');
  });
});

describe('resolveLaunchBackend', () => {
  it('prefers the terminal the caller is already in over session history', () => {
    const inGhostty: EngineContext = { platform: 'darwin', env: { TERM_PROGRAM: 'ghostty' } };
    expect(resolveLaunchBackend(inGhostty, [{ host: 'iterm', lastActivityMs: 9 }], macDefaults))
      .toEqual({ backend: 'ghostty', source: 'current-terminal' });
  });

  it('skips the current terminal when it is not drivable here', () => {
    const inGhostty: EngineContext = { platform: 'darwin', env: { TERM_PROGRAM: 'ghostty' } };
    expect(resolveLaunchBackend(inGhostty, [{ host: 'iterm', lastActivityMs: 9 }], withApps('iterm')))
      .toEqual({ backend: 'iterm', source: 'active-session', host: 'iterm' });
  });

  it('uses live sessions when the caller has no terminal (the menu-bar case)', () => {
    expect(resolveLaunchBackend(guiCtx, [{ host: 'iterm', lastActivityMs: 9 }], macDefaults))
      .toEqual({ backend: 'iterm', source: 'active-session', host: 'iterm' });
  });

  it('falls back to an available backend when nothing names a terminal', () => {
    expect(resolveLaunchBackend(guiCtx, [], macDefaults))
      .toEqual({ backend: 'iterm', source: 'available' });
  });

  it('lands on Terminal.app as the floor when it is the only thing installed', () => {
    expect(resolveLaunchBackend(guiCtx, [], withApps('terminal')))
      .toEqual({ backend: 'terminal', source: 'available' });
  });

  it('returns null where no terminal can be driven at all', () => {
    expect(resolveLaunchBackend({ platform: 'linux', env: {} }, [{ host: 'iterm' }])).toBeNull();
  });
});

describe('describeBackendChoice', () => {
  it('names why each backend was chosen', () => {
    expect(describeBackendChoice({ backend: 'ghostty', source: 'active-session', host: 'ghostty' }))
      .toBe('Ghostty (where your ghostty sessions run)');
    expect(describeBackendChoice({ backend: 'iterm', source: 'current-terminal' }))
      .toBe("iTerm (the terminal you're in)");
    expect(describeBackendChoice({ backend: 'terminal', source: 'available' }))
      .toBe('Terminal (no running session named a terminal)');
    expect(describeBackendChoice({ backend: 'iterm', source: 'forced' }))
      .toBe('iTerm (you asked for it)');
  });
});
