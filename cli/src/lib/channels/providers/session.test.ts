import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { isTmuxInstalled } from '../../tmux/binary.js';
import { createSession, killAll } from '../../tmux/session.js';
import { runAgents, writeUpdateCache } from '../../../commands/sessions.test-fixture.js';
import { sessionProvider } from './session.js';

describe('session provider — refuses what it cannot deliver', () => {
  it('fails loud on attachments, threads and sender labels before any lookup', async () => {
    await expect(sessionProvider.send('hi', { target: 'x', attachments: ['/tmp/a.png'] }))
      .resolves.toMatchObject({ ok: false, error: expect.stringContaining('--attach') });
    await expect(sessionProvider.send('hi', { target: 'x', thread: '1' }))
      .resolves.toMatchObject({ ok: false, error: expect.stringContaining('--thread') });
    await expect(sessionProvider.send('hi', { target: 'x', from: 'bot' }))
      .resolves.toMatchObject({ ok: false, error: expect.stringContaining('--from') });
  });
});

describe.skipIf(!isTmuxInstalled())('agents send --channel session — real tmux delivery', () => {
  const SHORT = 'cafe1234';
  const NAME = `ag-claude-${SHORT}`;
  let tempHome: string;
  let socket: string;
  let otherSocket: string;

  beforeEach(() => {
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-send-'));
    writeUpdateCache(tempHome);
    const tmuxDir = path.join(tempHome, '.agents', '.cache', 'helpers', 'tmux');
    fs.mkdirSync(tmuxDir, { recursive: true, mode: 0o700 });
    socket = path.join(tmuxDir, 'server.sock');
    otherSocket = path.join(tempHome, 'other.sock');
  });

  afterEach(async () => {
    try { await killAll(socket); } catch {  }
    try { await killAll(otherSocket); } catch {  }
    fs.rmSync(tempHome, { recursive: true, force: true });
  });

  async function startReader(name: string, sock: string): Promise<{ out: string; pane: string }> {
    const out = path.join(tempHome, `${name}.bytes`);
    await createSession({ name, cmd: `stty raw -echo; exec cat > '${out}'`, socket: sock, cwd: tempHome });
    for (let i = 0; i < 100 && !fs.existsSync(out); i++) await new Promise((r) => setTimeout(r, 20));
    expect(fs.existsSync(out), `reader ${name} never started`).toBe(true);
    const pane = execFileSync('tmux', ['-S', sock, 'display', '-p', '-t', name, '#{pane_id}'], { encoding: 'utf-8' }).trim();
    return { out, pane };
  }

  async function received(out: string, expectedLength: number): Promise<string> {
    for (let i = 0; i < 100 && fs.readFileSync(out, 'latin1').length < expectedLength; i++) {
      await new Promise((r) => setTimeout(r, 20));
    }
    await new Promise((r) => setTimeout(r, 200));
    return fs.readFileSync(out, 'latin1');
  }

  function send(args: string[]) {
    const res = runAgents(['send', '--channel', 'session', ...args, '--json'], tempHome, tempHome);
    const last = res.stdout.trim().split('\n').pop() ?? '';
    return { ...res, json: last.startsWith('{') ? JSON.parse(last) : undefined, out: `${res.stdout}${res.stderr}` };
  }

  it('types the exact text then Enter as two writes, keeping the send result fields', async () => {
    const { out } = await startReader(NAME, socket);
    const text = '  lead "quoted" $(touch nope) ; | & `x`\nnext line  ';

    const sent = send(['--to', SHORT, '--text', text]);
    expect(sent.status, sent.out).toBe(0);
    expect(sent.json).toMatchObject({
      ok: true, channel: 'session', id: SHORT, text, dryRun: false,
      backend: 'tmux', writes: 2, confirmed: true,
    });
    expect(await received(out, text.length + 1)).toBe(`${text}\r`);
    expect(fs.existsSync(path.join(tempHome, 'nope'))).toBe(false);
  }, 60_000);

  it('delivers explicitly whitespace-only text, and an explicitly empty message presses Enter alone', async () => {
    const { out } = await startReader(NAME, socket);

    expect(send(['--to', SHORT, '--text', '   ']).status).toBe(0);
    expect(await received(out, 4)).toBe('   \r');

    const empty = send(['--to', SHORT, '--text', '']);
    expect(empty.status, empty.out).toBe(0);
    expect(await received(out, 5)).toBe('   \r\r');

    const absent = send(['--to', SHORT]);
    expect(absent.status).toBe(1);
    expect(absent.out).toContain('Message is empty');
    expect(await received(out, 5)).toBe('   \r\r');
  }, 60_000);

  it('--no-enter writes only the text, --combined writes text + one CR in one write', async () => {
    const { out } = await startReader(NAME, socket);

    const typed = send(['--to', SHORT, '--text', ' draft ', '--no-enter']);
    expect(typed.status, typed.out).toBe(0);
    expect(typed.json).toMatchObject({ ok: true, writes: 1 });
    expect(await received(out, 7)).toBe(' draft ');

    const fused = send(['--to', SHORT, '--text', 'go', '--combined']);
    expect(fused.status, fused.out).toBe(0);
    expect(fused.json).toMatchObject({ ok: true, writes: 1 });
    expect(await received(out, 10)).toBe(' draft go\r');

    const contradictory = send(['--to', SHORT, '--text', 'x', '--combined', '--no-enter']);
    expect(contradictory.status).toBe(1);
    expect(await received(out, 10)).toBe(' draft go\r');
  }, 60_000);

  it('--pane on a custom socket reaches an unregistered pane and nothing else', async () => {
    const discovered = await startReader(NAME, socket);
    const target = await startReader('plain-a', otherSocket);
    const sibling = await startReader('plain-b', otherSocket);

    const sent = send(['--pane', target.pane, '--socket', otherSocket, '--text', 'direct']);
    expect(sent.status, sent.out).toBe(0);
    expect(sent.json).toMatchObject({ ok: true, channel: 'session', id: target.pane, writes: 2 });
    expect(await received(target.out, 7)).toBe('direct\r');
    expect(await received(sibling.out, 0)).toBe('');
    expect(await received(discovered.out, 0)).toBe('');

    const conflicting = send(['--to', SHORT, '--pane', target.pane, '--socket', otherSocket, '--text', 'x']);
    expect(conflicting.status).toBe(1);
    expect(conflicting.out).toContain('name different targets');
    const socketOnly = send(['--to', SHORT, '--socket', otherSocket, '--text', 'x']);
    expect(socketOnly.status).toBe(1);
    const badSocket = send(['--pane', target.pane, '--socket', path.join(tempHome, 'missing.sock'), '--text', 'x']);
    expect(badSocket.status).toBe(1);
    expect(badSocket.json).toMatchObject({ ok: false, channel: 'session' });

    expect(await received(target.out, 7)).toBe('direct\r');
    expect(await received(discovered.out, 0)).toBe('');
  }, 60_000);

  it('fails without delivering when no session or several sessions match --to', async () => {
    const a = await startReader(NAME, socket);
    const b = await startReader('ag-claude-cafe5678', socket);

    const missing = send(['--to', 'deadbeef', '--text', 'hi']);
    expect(missing.status).toBe(1);
    expect(missing.json?.error).toContain('No active session matches "deadbeef"');

    const ambiguous = send(['--to', 'cafe', '--text', 'hi']);
    expect(ambiguous.status).toBe(1);
    expect(ambiguous.json?.error).toContain('matches 2 live sessions');

    expect(await received(a.out, 0)).toBe('');
    expect(await received(b.out, 0)).toBe('');
  }, 60_000);

  it('--dry-run resolves the target and reports the plan without typing', async () => {
    const { out, pane } = await startReader(NAME, socket);

    const viaTo = send(['--to', SHORT, '--text', 'probe', '--dry-run']);
    expect(viaTo.status, viaTo.out).toBe(0);
    expect(viaTo.json).toMatchObject({ ok: true, dryRun: true, backend: 'tmux', writes: 2 });
    const viaPane = send(['--pane', pane, '--socket', socket, '--text', 'probe', '--dry-run', '--no-enter']);
    expect(viaPane.status, viaPane.out).toBe(0);
    expect(viaPane.json).toMatchObject({ ok: true, dryRun: true, writes: 1 });

    expect(await received(out, 0)).toBe('');
  }, 60_000);

  it('refuses terminal options on other channels and the owner alias before any sink runs', async () => {
    const mailboxDir = path.join(tempHome, '.agents', '.history', 'mailbox');
    for (const args of [
      ['--channel', 'mailbox', '--to', 'peer-1', '--text', 'x', '--no-enter'],
      ['--channel', 'mailbox', '--to', 'peer-1', '--text', 'x', '--pane', '%1'],
      ['--to', 'owner', '--text', 'x', '--combined'],
    ]) {
      const res = runAgents(['send', ...args], tempHome, tempHome);
      expect(res.status, args.join(' ')).toBe(1);
      expect(res.stderr).toContain('only apply to --channel session');
    }
    expect(fs.existsSync(mailboxDir)).toBe(false);
  }, 60_000);
});
