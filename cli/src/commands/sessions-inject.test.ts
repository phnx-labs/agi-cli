/**
 * Tests for `agents sessions inject` selector + device handling (PHNX-3688).
 *
 * Two bugs the command shipped with, both exercised on the real path:
 *   1. A live tmux session whose id column shows `-` (only a tmux label like
 *      `ag-claude-214edaae:0.0`, no resolvable session id) could not be targeted
 *      at all — `matchInjectSelector` now matches the `<shortid>` suffix, proved
 *      here end-to-end against a real tmux server (discover the id-less row, match
 *      it, resolve its pane, inject, read the bytes back).
 *   2. `--device` arrived as an array under `optsWithGlobals()` (the parent
 *      `sessions` command's variadic `-D, --device <target...>` shadows this
 *      subcommand's scalar one), and the array flowed into `sshExec` and crashed
 *      on `host.startsWith` — `normalizeInjectDevice` coerces it and fails loud on
 *      more than one.
 */

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

/** A minimal ActiveSession for the pure matcher tests. */
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
    // The exact id-less shape listTmuxAgentSessions emits for a born-unidentified
    // pane: sessionId absent, only the tmux name + pane id known.
    const s = row({ sessionId: undefined, host: 'tmux', tmuxName: 'ag-claude-214edaae', paneId: '%122' });
    expect(matchInjectSelector(s, '214edaae')).toBe(true); // the tmux-name suffix
    expect(matchInjectSelector(s, '214e')).toBe(true); // a prefix of it
    expect(matchInjectSelector(s, 'ag-claude-214edaae')).toBe(true); // the full name
    expect(matchInjectSelector(s, '%122')).toBe(true); // the pane id
    expect(matchInjectSelector(s, 'deadbeef')).toBe(false);
  });

  it('never matches an empty selector', () => {
    expect(matchInjectSelector(row({ sessionId: 'a1b2c3d4' }), '')).toBe(false);
    expect(matchInjectSelector(row({ tmuxName: 'ag-claude-214edaae' }), '')).toBe(false);
  });
});

describe('normalizeInjectDevice', () => {
  it('coerces the single-element array optsWithGlobals delivers to a string (Bug 2)', () => {
    // The parent `sessions` variadic `-D, --device <target...>` shadows the
    // scalar one, so a single `--device box` arrives as `['box']`.
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
  // A short id chosen so it cannot resolve to a real transcript in sessions.db,
  // so the discovered row stays id-less — exactly the failing case.
  const SHORT = 'deadbe12';
  const SESS = `ag-claude-${SHORT}`;
  let tempDir: string;
  let socket: string;
  let socketSpy: ReturnType<typeof vi.spyOn> | undefined;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-inject-idless-'));
    socket = path.join(tempDir, 'server.sock');
    // Point discovery at our throwaway server, never the fleet socket.
    socketSpy = vi.spyOn(tmuxPaths, 'getDefaultSocketPath').mockReturnValue(socket);
  });

  afterEach(async () => {
    socketSpy?.mockRestore();
    try { await killAll(socket); } catch { /* best-effort */ }
    try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch { /* gone */ }
  });

  it('discovers the row id-less, matches its <shortid>, and injects into its pane', async () => {
    // `cat` echoes stdin, so an injected line is visible in the pane capture.
    await createSession({ name: SESS, cmd: 'cat', socket, cwd: tempDir });

    const rows = await listTmuxAgentSessions();
    const mine = rows.find((r) => r.tmuxName === SESS);
    expect(mine, `expected an ${SESS} row; got ${JSON.stringify(rows.map((r) => ({ kind: r.kind, tmuxName: r.tmuxName, sessionId: r.sessionId })))}`).toBeDefined();

    // The failing shape: the row carries the tmux label but no session id.
    expect(mine!.sessionId).toBeUndefined();
    expect(mine!.host).toBe('tmux');
    expect(mine!.tmuxName).toBe(SESS);

    // The fix: the operator can target it by the tmux-name suffix.
    expect(matchInjectSelector(mine!, SHORT)).toBe(true);

    // And that match resolves to the exact tmux pane the send-keys goes to.
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
