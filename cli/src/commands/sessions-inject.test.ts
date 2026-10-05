
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { normalizeInjectDevice, buildRemoteInjectArgv } from './sessions-inject.js';
import { matchInjectSelector } from '../lib/session/inject-target.js';
import type { ActiveSession } from '../lib/session/active.js';
import { listTmuxAgentSessions } from '../lib/session/active.js';
import { resolveInjectTargetForSession, injectIntoTerminal } from '../lib/terminal/index.js';
import { isTmuxInstalled } from '../lib/tmux/binary.js';
import { createSession, capturePane, killAll } from '../lib/tmux/session.js';
import * as tmuxPaths from '../lib/tmux/paths.js';

function row(over: Partial<ActiveSession>): ActiveSession {
  return { context: 'terminal', kind: 'claude', status: 'running', ...over } as ActiveSession;
}

describe('matchInjectSelector', () => {
  it('matches a full or prefix session id', () => {
    const s = row({ sessionId: 'a1b2c3d4-0000-0000-0000-000000000001' });
    expect(matchInjectSelector(s, 'a1b2c3d4-0000-0000-0000-000000000001')).toBe(true);
    expect(matchInjectSelector(s, 'a1b2c3d4')).toBe(true);
    expect(matchInjectSelector(s, 'ffffffff')).toBe(false);
  });

  it('matches the tmux <shortid> suffix when the row has NO session id (Bug 1)', () => {
    const s = row({ sessionId: undefined, host: 'tmux', tmuxName: 'ag-claude-214edaae', paneId: '%122' });
    expect(matchInjectSelector(s, '214edaae')).toBe(true);
    expect(matchInjectSelector(s, '214e')).toBe(true);
    expect(matchInjectSelector(s, 'ag-claude-214edaae')).toBe(true);
    expect(matchInjectSelector(s, '%122')).toBe(true);
    expect(matchInjectSelector(s, 'deadbeef')).toBe(false);
  });

  it('never matches an empty selector', () => {
    expect(matchInjectSelector(row({ sessionId: 'a1b2c3d4' }), '')).toBe(false);
    expect(matchInjectSelector(row({ tmuxName: 'ag-claude-214edaae' }), '')).toBe(false);
  });
});

describe('normalizeInjectDevice', () => {
  it('coerces the single-element array optsWithGlobals delivers to a string (Bug 2)', () => {
    expect(normalizeInjectDevice(['yosemite-s0'])).toBe('yosemite-s0');
    expect(normalizeInjectDevice('yosemite-s0')).toBe('yosemite-s0');
  });

  it('returns undefined for no device', () => {
    expect(normalizeInjectDevice(undefined)).toBeUndefined();
    expect(normalizeInjectDevice([])).toBeUndefined();
  });

  it('fails loud on more than one device (inject targets exactly one terminal)', () => {
    expect(() => normalizeInjectDevice(['box1', 'box2'])).toThrow(/single device/);
  });
});

describe('buildRemoteInjectArgv', () => {
  it('re-runs the same inject on the device, WITHOUT --device (it resolves there)', () => {
    const argv = buildRemoteInjectArgv('214edaae', 'continue', { device: ['yosemite-s0'] });
    expect(argv).toEqual(['agents', 'sessions', 'inject', '214edaae', 'continue']);
    expect(argv).not.toContain('--device');
  });

  it('forwards every delivery flag that shapes the injection', () => {
    const argv = buildRemoteInjectArgv('sid', 'hi', {
      enter: false,
      combined: true,
      socket: '/tmp/s.sock',
      pane: '%3',
      json: true,
      device: ['box'],
    });
    expect(argv).toEqual([
      'agents', 'sessions', 'inject', 'sid', 'hi',
      '--no-enter', '--combined', '--socket', '/tmp/s.sock', '--pane', '%3', '--json',
    ]);
  });
});

const tmuxSkip = isTmuxInstalled() ? null : 'tmux not installed';

describe.skipIf(tmuxSkip)('sessions inject — id-less tmux session, real round-trip (Bug 1)', () => {
  const SHORT = 'deadbe12';
  const SESS = `ag-claude-${SHORT}`;
  let tempDir: string;
  let socket: string;
  let socketSpy: ReturnType<typeof vi.spyOn> | undefined;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-inject-idless-'));
    socket = path.join(tempDir, 'server.sock');
    socketSpy = vi.spyOn(tmuxPaths, 'getDefaultSocketPath').mockReturnValue(socket);
  });

  afterEach(async () => {
    socketSpy?.mockRestore();
    try { await killAll(socket); } catch {  }
    try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {  }
  });

  it('discovers the row id-less, matches its <shortid>, and injects into its pane', async () => {
    await createSession({ name: SESS, cmd: 'cat', socket, cwd: tempDir });

    const rows = await listTmuxAgentSessions();
    const mine = rows.find((r) => r.tmuxName === SESS);
    expect(mine, `expected an ${SESS} row; got ${JSON.stringify(rows.map((r) => ({ kind: r.kind, tmuxName: r.tmuxName, sessionId: r.sessionId })))}`).toBeDefined();

    expect(mine!.sessionId).toBeUndefined();
    expect(mine!.host).toBe('tmux');
    expect(mine!.tmuxName).toBe(SESS);

    expect(matchInjectSelector(mine!, SHORT)).toBe(true);

    const resolution = resolveInjectTargetForSession(mine!);
    expect(resolution.addressable).toBe(true);
    if (!resolution.addressable) throw new Error(resolution.reason);
    expect(resolution.target.backend).toBe('tmux');

    const res = await injectIntoTerminal(resolution.target, 'continue-please', { enter: false });
    expect(res.ok).toBe(true);

    let seen = '';
    for (let i = 0; i < 40; i++) {
      seen = await capturePane({ name: SESS, socket });
      if (seen.includes('continue-please')) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(seen).toContain('continue-please');
  });
});
