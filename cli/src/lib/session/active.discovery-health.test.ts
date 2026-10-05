import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  listTmuxAgentSessions,
  getActiveSessions,
  describeActiveDiscoveryHealth,
  TmuxDiscoveryDegradedError,
} from './active.js';
import { isTmuxInstalled } from '../tmux/binary.js';
import * as tmuxPaths from '../tmux/paths.js';

/** RUSH-2507: a fleet sweep found ~41 running agents while `agents sessions --active` said none,
 * because the tmux source collapsed "socket unreadable" into the same `[]` as an idle socket. A
 * missing socket stays a clean empty; a present-but-unreachable one is reported DEGRADED. */
const tmuxSkip = isTmuxInstalled() ? null : 'tmux not installed';

describe('listTmuxAgentSessions / describeActiveDiscoveryHealth — degraded vs genuinely empty', () => {
  let tempDir: string;
  let socketSpy: ReturnType<typeof vi.spyOn> | undefined;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-tmux-discovery-health-'));
  });

  afterEach(() => {
    socketSpy?.mockRestore();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('a socket that has never existed is a clean empty, not degraded', async () => {
    const socket = path.join(tempDir, 'never-created.sock');
    socketSpy = vi.spyOn(tmuxPaths, 'getDefaultSocketPath').mockReturnValue(socket);

    await expect(listTmuxAgentSessions()).resolves.toEqual([]);
    const health = await describeActiveDiscoveryHealth();
    expect(health.degradedSources).toEqual([]);
  });

  it.skipIf(tmuxSkip)('a present socket that is not a real tmux server throws TmuxDiscoveryDegradedError', async () => {
    // A plain file at the socket path: fs.existsSync sees it (so the "never
    // ran" early return does not fire), but tmux -S <path> list-panes -a fails
    // against it — the exact "tmux truth exists but couldn't be read" case.
    const socket = path.join(tempDir, 'stale.sock');
    fs.writeFileSync(socket, '', 'utf-8');
    socketSpy = vi.spyOn(tmuxPaths, 'getDefaultSocketPath').mockReturnValue(socket);

    await expect(listTmuxAgentSessions()).rejects.toBeInstanceOf(TmuxDiscoveryDegradedError);
  });

  it.skipIf(tmuxSkip)('describeActiveDiscoveryHealth reports tmux as degraded for the same socket', async () => {
    const socket = path.join(tempDir, 'stale.sock');
    fs.writeFileSync(socket, '', 'utf-8');
    socketSpy = vi.spyOn(tmuxPaths, 'getDefaultSocketPath').mockReturnValue(socket);

    const health = await describeActiveDiscoveryHealth();
    expect(health.degradedSources).toEqual(['tmux']);
  });

  it.skipIf(tmuxSkip)('getActiveSessions still swallows the degraded tmux source to a plain array', async () => {
    // getActiveSessions' return type is a bare ActiveSession[] for every existing
    // caller — it must never throw just because one source degraded; only the
    // dedicated health probe (above) surfaces that as a signal.
    const socket = path.join(tempDir, 'stale.sock');
    fs.writeFileSync(socket, '', 'utf-8');
    socketSpy = vi.spyOn(tmuxPaths, 'getDefaultSocketPath').mockReturnValue(socket);

    await expect(getActiveSessions({ localOnly: true, skipHeadless: true })).resolves.toBeInstanceOf(Array);
  });
});
