import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { isTmuxInstalled } from '../../tmux/binary.js';
import { createSession, capturePane, killAll } from '../../tmux/session.js';
import { runAgents, writeUpdateCache } from '../../../commands/sessions.test-fixture.js';
import { sessionProvider } from './session.js';

describe('session provider — refuses what it cannot deliver', () => {
  it('fails loud on attachments, threads, sender labels, and empty text before any lookup', async () => {
    await expect(sessionProvider.send('hi', { target: 'x', attachments: ['/tmp/a.png'] }))
      .resolves.toMatchObject({ ok: false, error: expect.stringContaining('--attach') });
    await expect(sessionProvider.send('hi', { target: 'x', thread: '1' }))
      .resolves.toMatchObject({ ok: false, error: expect.stringContaining('--thread') });
    await expect(sessionProvider.send('hi', { target: 'x', from: 'bot' }))
      .resolves.toMatchObject({ ok: false, error: expect.stringContaining('--from') });
    await expect(sessionProvider.send('  ', { target: 'x' }))
      .resolves.toMatchObject({ ok: false, error: expect.stringContaining('empty') });
  });
});

describe.skipIf(!isTmuxInstalled())('agents send --channel session — real tmux round-trip', () => {
  const SHORT = 'cafe1234';
  const NAME = `ag-claude-${SHORT}`;
  let tempHome: string;
  let socket: string;

  beforeEach(() => {
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-send-'));
    writeUpdateCache(tempHome);
    const tmuxDir = path.join(tempHome, '.agents', '.cache', 'helpers', 'tmux');
    fs.mkdirSync(tmuxDir, { recursive: true, mode: 0o700 });
    socket = path.join(tmuxDir, 'server.sock');
  });

  afterEach(async () => {
    try { await killAll(socket); } catch { /* server already gone */ }
    fs.rmSync(tempHome, { recursive: true, force: true });
  });

  it('types the text + Enter into the pane the selector names', async () => {
    await createSession({ name: NAME, cmd: 'cat', socket, cwd: tempHome });

    const sent = runAgents(
      ['send', '--channel', 'session', '--to', SHORT, '--text', 'continue-from-send', '--json'],
      tempHome,
      tempHome,
    );
    expect(sent.status, `${sent.stdout}${sent.stderr}`).toBe(0);
    expect(JSON.parse(sent.stdout.trim().split('\n').pop()!)).toMatchObject({ ok: true, channel: 'session', id: SHORT });

    let seen = '';
    for (let i = 0; i < 40; i++) {
      seen = await capturePane({ name: NAME, socket });
      if (seen.includes('continue-from-send')) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(seen).toContain('continue-from-send');
  }, 60_000);

  it('exits non-zero naming the selector when no live session matches', () => {
    const sent = runAgents(['send', '--channel', 'session', '--to', 'deadbeef', '--text', 'hi'], tempHome, tempHome);
    expect(sent.status).toBe(1);
    expect(sent.stderr).toContain('No active session matches "deadbeef"');
  }, 60_000);
});
