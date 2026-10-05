import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const gatherRemoteActiveMock = vi.hoisted(() =>
  vi.fn(async () => ({
    sessions: [],
    deviceCount: 2,
    skipped: ['asleep-peer'],
    discoveryFailed: false,
  })),
);

vi.mock('../lib/session/remote-active.js', async () => {
  const actual = await vi.importActual<typeof import('../lib/session/remote-active.js')>(
    '../lib/session/remote-active.js',
  );
  return { ...actual, gatherRemoteActive: gatherRemoteActiveMock };
});

import { gatherLiveTargets } from './go.js';
import { writePidSessionEntry, prunePidSessionRegistry } from '../lib/session/pid-registry.js';
import { isTmuxInstalled, runTmux } from '../lib/tmux/binary.js';
import * as tmuxPaths from '../lib/tmux/paths.js';

const tmuxSkip = isTmuxInstalled() ? null : 'tmux not installed';

const SESSION_ID = 'c1a0de70-3298-4000-8000-000000003298';
const SHORT = SESSION_ID.slice(0, 8);
const SESS = `ag-claude-${SHORT}`;

describe.skipIf(tmuxSkip)('gatherLiveTargets — skip fleet on unique local live id (PHNX-3298)', () => {
  let tempDir: string;
  let socket: string;
  let panePid: number;
  let socketSpy: ReturnType<typeof vi.spyOn> | undefined;

  beforeEach(async () => {
    gatherRemoteActiveMock.mockClear();
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-live-selector-'));
    socket = path.join(tempDir, 'server.sock');
    await runTmux({
      socket,
      args: ['new-session', '-d', '-s', SESS, 'sleep', '120'],
    });
    const listed = await runTmux({
      socket,
      args: ['list-panes', '-a', '-F', '#{pane_id}:#{pane_pid}:#{session_name}'],
    });
    const line = listed.stdout.split('\n').filter(Boolean)[0];
    const [pane, pidRaw, name] = line.split(':');
    expect(name).toBe(SESS);
    panePid = parseInt(pidRaw, 10);
    expect(panePid).toBeGreaterThan(0);
    socketSpy = vi.spyOn(tmuxPaths, 'getDefaultSocketPath').mockReturnValue(socket);
    writePidSessionEntry({
      pid: panePid,
      agent: 'claude',
      sessionId: SESSION_ID,
      startedAtMs: Date.now() - 60_000,
      tmuxPane: pane,
      cwd: tempDir,
    });
  });

  afterEach(async () => {
    socketSpy?.mockRestore();
    prunePidSessionRegistry((pid) => pid !== panePid);
    await runTmux({ socket, args: ['kill-server'], throwOnError: false });
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('full UUID of a live local pane does not call gatherRemoteActive', async () => {
    const { activeById } = await gatherLiveTargets(false, { selector: SESSION_ID, includeCloud: true });
    expect(gatherRemoteActiveMock).not.toHaveBeenCalled();
    expect(activeById.get(SESSION_ID)?.sessionId).toBe(SESSION_ID);
  });

  it('unique 8-hex of that pane does not call gatherRemoteActive', async () => {
    const { activeById } = await gatherLiveTargets(false, { selector: SHORT, includeCloud: true });
    expect(gatherRemoteActiveMock).not.toHaveBeenCalled();
    expect(activeById.get(SESSION_ID)?.sessionId).toBe(SESSION_ID);
  });

  it('a unique 4-hex local hit still races the fleet so a remote collision can fail closed', async () => {
    await gatherLiveTargets(false, { selector: SHORT.slice(0, 4), includeCloud: true });
    expect(gatherRemoteActiveMock).toHaveBeenCalledOnce();
  });

  it('a genuine miss still races the fleet', async () => {
    await gatherLiveTargets(false, {
      selector: 'ffffffff-3298-4000-8000-00000000ffff',
      includeCloud: true,
    });
    expect(gatherRemoteActiveMock).toHaveBeenCalledOnce();
    const opts = gatherRemoteActiveMock.mock.calls[0]?.[1] as { earlyExit?: { isDefinitive: unknown } } | undefined;
    expect(opts?.earlyExit?.isDefinitive).toEqual(expect.any(Function));
  });

  it('browse (no selector) still all-settles — gatherRemoteActive with no earlyExit', async () => {
    await gatherLiveTargets(false, { includeCloud: true });
    expect(gatherRemoteActiveMock).toHaveBeenCalledOnce();
    const opts = gatherRemoteActiveMock.mock.calls[0]?.[1] as { earlyExit?: unknown } | undefined;
    expect(opts?.earlyExit).toBeUndefined();
  });
});
