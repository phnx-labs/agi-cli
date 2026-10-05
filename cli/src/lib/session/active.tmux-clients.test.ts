
import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { isTmuxInstalled, runTmux } from '../tmux/binary.js';
import { foldTmuxClients, type ActiveSession } from './active.js';

const skipReason = isTmuxInstalled() ? null : 'tmux not installed';

describe.skipIf(skipReason)('tmux attached-client fold', () => {
  let socket: string;
  let tempDir: string;
  const sessionName = 'agents-clients-test';

  beforeEach(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-tmux-clients-'));
    socket = path.join(tempDir, 'server.sock');
    await runTmux({ socket, args: ['new-session', '-d', '-s', sessionName, 'sleep', '120'] });
  });

  afterEach(async () => {
    await runTmux({ socket, args: ['kill-server'], throwOnError: false });
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  async function firstPane(): Promise<string> {
    const res = await runTmux({ socket, args: ['list-panes', '-a', '-F', '#{pane_id}'] });
    return res.stdout.split('\n').filter(Boolean)[0];
  }

  function row(pane: string): ActiveSession {
    return {
      context: 'terminal',
      kind: 'claude',
      status: 'idle',
      provenance: { host: 'test', transport: 'local', mux: { kind: 'tmux', socket, pane } },
    } as ActiveSession;
  }

  it('reads zero clients for a detached session — the orphan signal', async () => {
    const pane = await firstPane();
    const rows = [row(pane)];
    await foldTmuxClients(rows);
    expect(rows[0].tmuxClients).toBe(0);
  });

  it('survives tmux sanitizing the format separator (the tab bug)', async () => {
    const tabbed = await runTmux({
      socket,
      args: ['list-panes', '-a', '-F', '#{pane_id}\t#{session_attached}'],
      throwOnError: false,
    });
    const printable = await runTmux({
      socket,
      args: ['list-panes', '-a', '-F', '#{pane_id}:#{session_attached}'],
      throwOnError: false,
    });
    expect(printable.stdout.split('\n')[0].split(':')).toHaveLength(2);
    const tabFields = tabbed.stdout.split('\n')[0].split('\t').length;
    if (tabFields === 1) expect(tabbed.stdout).not.toContain('\t');
  });

  it('leaves rows on another socket untouched', async () => {
    const pane = await firstPane();
    const mine = row(pane);
    const other = row(pane);
    other.provenance!.mux!.socket = path.join(tempDir, 'not-a-server.sock');
    const rows = [mine, other];
    await foldTmuxClients(rows);
    expect(mine.tmuxClients).toBe(0);
    expect(other.tmuxClients).toBeUndefined();
  });

  it('does nothing when no row is tmux-hosted', async () => {
    const plain: ActiveSession = { context: 'terminal', kind: 'claude', status: 'idle' };
    await foldTmuxClients([plain]);
    expect(plain.tmuxClients).toBeUndefined();
  });
});

describe.skipIf(skipReason)('tmux format separator safety', () => {
  it('cannot appear in a session name — tmux rewrites it', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-tmux-sep-'));
    const sock = path.join(dir, 'server.sock');
    try {
      await runTmux({ socket: sock, args: ['new-session', '-d', '-s', 'has:colon.dot', 'sleep', '60'] });
      const res = await runTmux({ socket: sock, args: ['list-sessions', '-F', '#{session_name}'] });
      const name = res.stdout.trim();
      expect(name).not.toContain(':');
      expect(name).toBe('has_colon_dot');
      const panes = await runTmux({
        socket: sock,
        args: ['list-panes', '-a', '-F', '#{pane_id}:#{session_name}:#{pane_pid}:#{pane_current_path}'],
      });
      const parts = panes.stdout.split('\n').filter(Boolean)[0].split(':');
      expect(parts.length).toBeGreaterThanOrEqual(4);
      expect(parts[1]).toBe('has_colon_dot');
    } finally {
      await runTmux({ socket: sock, args: ['kill-server'], throwOnError: false });
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
