
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Server, type Connection } from 'ssh2';
import { sessionHeadline } from '../title.js';
import type { SessionMeta } from '@phnx-labs/sessions-cli/reader';
import {
  parseRemoteListPayload,
  parsePeerPreviewDigest,
  remoteListCommand,
  sshCapture,
  peerHopCloseNotice,
  peerHopOutcome,
  peerAnswers,
  quietLoginShell,
} from './remote-list.js';
import { SSH_CONN_FAILURE_CODE, RemoteUtf8Accumulator } from '../../ssh-exec.js';

interface RealSshPeer {
  port: number;
  connectionClosed: Promise<void>;
  stop(): Promise<void>;
}

async function startRealSshPeer(mode: 'success' | 'hang'): Promise<RealSshPeer> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'session-ssh-capture-'));
  const hostKey = path.join(dir, 'host-key');
  const keygen = spawnSync('ssh-keygen', ['-q', '-t', 'rsa', '-b', '2048', '-N', '', '-f', hostKey], {
    encoding: 'utf8',
  });
  if (keygen.status !== 0) throw new Error(`ssh-keygen failed: ${keygen.stderr}`);

  let resolveConnectionClosed!: () => void;
  const connectionClosed = new Promise<void>((resolve) => { resolveConnectionClosed = resolve; });
  const connections = new Set<Connection>();
  const server = new Server({ hostKeys: [fs.readFileSync(hostKey)] }, (client) => {
    connections.add(client);
    client.on('authentication', (ctx) => {
      if (ctx.method === 'none' && ctx.username === 'tool-index-test') ctx.accept();
      else ctx.reject();
    });
    client.on('ready', () => {
      client.on('session', (accept) => {
        const session = accept();
        session.on('exec', (acceptExec, reject, info) => {
          if (info.command !== 'tool-index-command') {
            reject();
            return;
          }
          const stream = acceptExec();
          if (mode === 'success') {
            stream.write('{"ok":true}');
            stream.exit(0);
            stream.end();
          }
        });
      });
    });
    client.on('close', () => {
      connections.delete(client);
      resolveConnectionClosed();
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('ssh2 peer did not bind TCP');

  return {
    port: address.port,
    connectionClosed,
    async stop() {
      for (const connection of connections) connection.end();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

const isolatedHostKeyOpts = [
  '-o', 'StrictHostKeyChecking=no',
  '-o', 'UserKnownHostsFile=/dev/null',
];

describe.skipIf(process.platform === 'win32')('sshCapture direct timeout connection', () => {
  it('uses a real direct SSH connection without leaving a multiplexed master', async () => {
    const peer = await startRealSshPeer('success');
    try {
      const result = await sshCapture(
        'tool-index-test@127.0.0.1',
        'tool-index-command',
        2_000,
        { multiplex: false, port: peer.port, hostKeyOpts: isolatedHostKeyOpts },
      );
      expect(result).toEqual({ code: 0, stdout: '{"ok":true}' });
      await expect(Promise.race([
        peer.connectionClosed.then(() => 'closed'),
        new Promise<string>((resolve) => setTimeout(() => resolve('open'), 1_000)),
      ])).resolves.toBe('closed');
    } finally {
      await peer.stop();
    }
  });

  it('closes the real remote SSH channel at its deadline', async () => {
    const peer = await startRealSshPeer('hang');
    try {
      const result = await sshCapture(
        'tool-index-test@127.0.0.1',
        'tool-index-command',
        500,
        { multiplex: false, port: peer.port, hostKeyOpts: isolatedHostKeyOpts },
      );
      expect(result.code).toBeNull();
      await expect(Promise.race([
        peer.connectionClosed.then(() => 'closed'),
        new Promise<string>((resolve) => setTimeout(() => resolve('open'), 2_000)),
      ])).resolves.toBe('closed');
    } finally {
      await peer.stop();
    }
  });
});

describe('RemoteUtf8Accumulator', () => {
  it('preserves a multibyte code point split across SSH stdout chunks', () => {
    const bytes = Buffer.from('before 界 after', 'utf8');
    const split = bytes.indexOf(Buffer.from('界')) + 1;
    const decoded = new RemoteUtf8Accumulator();
    decoded.write(bytes.subarray(0, split));
    decoded.write(bytes.subarray(split));
    expect(decoded.end()).toBe('before 界 after');
  });
});

describe('parseRemoteListPayload', () => {
  it('accepts valid output and tags the owning machine', () => {
    const stdout = JSON.stringify([{id:'abcd7777',shortId:'abcd7777',agent:'claude',timestamp:'2026-08-03T00:00:00Z'}]);
    expect(parseRemoteListPayload(stdout, 'peer-one', true)).toEqual({
      items: [{
        id: 'abcd7777', shortId: 'abcd7777', agent: 'claude',
        timestamp: '2026-08-03T00:00:00Z', machine: 'peer-one', _remote: true,
      }],
      valid: true,
    });
  });

  it('carries a peer\'s daemon-generated title through the fan-out (PHNX-3797)', () => {
    const stdout = JSON.stringify([{
      id: 'a', shortId: 'a', agent: 'claude', timestamp: '2026-07-01T00:00:00Z',
      filePath: '/peer/a.jsonl',
      topic: 'the fleet list headline is the agent last message',
      generatedTitle: 'Session headline ladder fix',
    }]);
    const [row] = parseRemoteListPayload(stdout, 'zion').items;
    expect(row.generatedTitle).toBe('Session headline ladder fix');
    expect(sessionHeadline(row)).toBe('Session headline ladder fix');
  });

  it('parses a payload a Windows peer prefixed with a PowerShell CLIXML banner (RUSH-2286)', () => {
    const payload = JSON.stringify([
      { id: 'w', shortId: 'w', agent: 'claude', timestamp: '2026-08-01T00:00:00Z', filePath: 'C:\\r\\w.jsonl' },
    ]);
    const polluted =
      '#< CLIXML\n' +
      '<Objs Version="1.1.0.1" xmlns="http://schemas.microsoft.com/powershell/2004/04">' +
      '<Obj S="progress" RefId="0"><MS><AV>Preparing modules for first use.</AV></MS></Obj></Objs>\n' +
      payload;
    const { items, valid } = parseRemoteListPayload(polluted, 'win-mini');
    expect(valid).toBe(true);
    expect(items.map((row) => [row.id, row.machine])).toEqual([['w', 'win-mini']]);
  });

  it('accepts the production resolver projection with launch mode and custom harness', async () => {
    const { serializeResolvedSessionsJson } = await import('../selection.js');
    const row = {
      id: 'abcd7777', shortId: 'abcd7777', agent: 'claude', harness: 'custom-claude',
      timestamp: '2026-09-13T00:00:00Z', mode: 'plan', origin: 'cli',
      lastActivity: '2026-09-13T00:01:00Z', project: 'project', version: '2.1.270',
      label: 'Resume probe', topic: 'Session resume', machine: 'origin',
      filePath: '/private/transcript.jsonl', cwd: '/private/project',
    } as SessionMeta;
    const payload = serializeResolvedSessionsJson([row]);
    const parsed = parseRemoteListPayload(payload, 'origin', true);
    expect(parsed.valid).toBe(true);
    expect(parsed.items).toEqual([{ ...JSON.parse(payload)[0], machine: 'origin', _remote: true }]);
    expect(parsed.items[0]).toMatchObject({ harness: 'custom-claude', mode: 'plan' });
    expect(parsed.items[0]).not.toHaveProperty('filePath');
    expect(parsed.items[0]).not.toHaveProperty('cwd');
  });

  it('marks an exit-0 structurally invalid resolver row incomplete', () => {
    expect(parseRemoteListPayload('[{}]', 'peer', true)).toEqual({ items: [], valid: false });
  });

  it('rejects unsafe fields from a versioned resolver peer', () => {
    const unsafe = JSON.stringify([{
      id: 'abcd7777', shortId: 'abcd7777', agent: 'claude',
      timestamp: '2026-08-03T00:00:00Z', filePath: '/private/transcript.jsonl',
    }]);
    expect(parseRemoteListPayload(unsafe, 'peer', true)).toEqual({ items: [], valid: false });
  });

  it('accepts an exit-0 empty array as a complete peer response', () => {
    expect(parseRemoteListPayload('[]', 'peer')).toEqual({ items: [], valid: true });
  });
});

describe('remoteListCommand', () => {
  it('passes the recursion guard so the peer stays local and never re-fans-out', () => {
    const cmd = remoteListCommand(['sessions', 'auth bug', '--json']);
    expect(cmd).toContain('AGENTS_SESSIONS_LOCAL=1');
    expect(cmd).toContain('agents');
  });

  it('carries the caller query and filters over to the peer', () => {
    const cmd = remoteListCommand(['sessions', 'deploy', '--since', '2d', '--json']);
    expect(cmd).toContain('deploy');
    expect(cmd).toContain('--since');
    expect(cmd).toContain('--json');
  });
});

describe('parsePeerPreviewDigest', () => {
  it('returns the preview object from the peer JSON envelope verbatim', () => {
    const preview = { summary: 'remote result', files: ['src/a.ts'], nested: { ok: true } };
    expect(parsePeerPreviewDigest({ preview, ignored: 'peer metadata' })).toBe(preview);
  });

  it.each([
    { payload: null },
    { payload: [] },
    { payload: 'not an envelope' },
    { payload: {} },
    { payload: { preview: null } },
    { payload: { preview: 'not an object' } },
    { payload: { preview: [] } },
  ])('rejects a missing or malformed preview envelope: $payload', ({ payload }) => {
    expect(parsePeerPreviewDigest(payload)).toBeUndefined();
  });
});

describe('peerHopCloseNotice — TTY hop leaves the session id (RUSH-3227)', () => {
  const SID = '26d69286-a323-45a0-9a63-d75b90a66730';

  it('tty + sessionId on a clean close prints the full id and resume command', () => {
    const s = peerHopCloseNotice({ tty: true, sessionId: SID }, 'yosemite-m2', 0);
    expect(s).toContain('Connection to yosemite-m2 closed.');
    expect(s).toContain(`Session ${SID}`);
    expect(s).toContain(`agents run auto --resume ${SID}`);
  });

  it('tty + sessionId on a 255 drop says dropped', () => {
    const s = peerHopCloseNotice({ tty: true, sessionId: SID }, 'yosemite-m2', SSH_CONN_FAILURE_CODE);
    expect(s).toContain('Connection to yosemite-m2 dropped.');
    expect(s).toContain(`Session ${SID}`);
  });

  it('non-TTY renders (markdown/json one-shots) print nothing', () => {
    expect(peerHopCloseNotice({ sessionId: SID }, 'yosemite-m2', 0)).toBeUndefined();
    expect(peerHopCloseNotice({ tty: false, sessionId: SID }, 'yosemite-m2', 0)).toBeUndefined();
  });

  it('TTY without a session id prints nothing', () => {
    expect(peerHopCloseNotice({ tty: true }, 'yosemite-m2', 0)).toBeUndefined();
  });
});

describe('peerHopOutcome — offline-device fallback discriminator (PHNX-3626)', () => {
  const answers = () => true;
  const silent = () => false;
  it('reports unreachable only when ssh exited 255 and a fresh connection also fails, or never settled (null)', () => {
    expect(peerHopOutcome(SSH_CONN_FAILURE_CODE, silent)).toBe('unreachable');
    expect(peerHopOutcome(null, answers)).toBe('unreachable');
  });
  it('a 255 from a session whose remote side died while the host still answers is not unreachable', () => {
    expect(peerHopOutcome(SSH_CONN_FAILURE_CODE, answers)).toBe('ok');
  });
  it('reports ok when the hop reached the peer, whatever the remote command exit code, without probing', () => {
    const never = () => { throw new Error('probed'); };
    expect(peerHopOutcome(0, never)).toBe('ok');
    expect(peerHopOutcome(1, never)).toBe('ok');
    expect(peerHopOutcome(130, never)).toBe('ok');
    expect(peerHopOutcome(254, never)).toBe('ok');
  });
  it('a one-shot command reports failed when the remote command exits non-zero, so a caller can tell it did not happen (PHNX-4344)', () => {
    const never = () => { throw new Error('probed'); };
    expect(peerHopOutcome(0, never, true)).toBe('ok');
    expect(peerHopOutcome(1, never, true)).toBe('failed');
    expect(peerHopOutcome(254, never, true)).toBe('failed');
    expect(peerHopOutcome(SSH_CONN_FAILURE_CODE, answers, true)).toBe('failed');
    expect(peerHopOutcome(SSH_CONN_FAILURE_CODE, silent, true)).toBe('unreachable');
  });
  it.skipIf(process.platform === 'win32')('peerAnswers is false for a host that does not exist', () => {
    expect(peerAnswers('nobody@host.invalid')).toBe(false);
  });
});

describe.skipIf(process.platform === 'win32')('quietLoginShell — the peer\'s profile chatter never reaches the tab', () => {
  it('sources the login profile, logs its output, and leaves the command\'s own output alone', async () => {
    const { spawnSync } = await import('node:child_process');
    const fs = await import('node:fs');
    const os = await import('node:os');
    const path = await import('node:path');
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'quiet-login-'));
    fs.writeFileSync(path.join(home, '.bash_profile'),
      'echo "Your user\'s .npmrc file has a globalconfig setting"; echo nvm-warning >&2; export FROM_PROFILE=yes\n');
    const cmd = quietLoginShell('echo "agent $FROM_PROFILE"; echo agent-err >&2; exit 7');
    const res = spawnSync('sh', ['-c', cmd], { env: { PATH: process.env.PATH, HOME: home }, encoding: 'utf8' });
    expect(res.stdout).toBe('agent yes\n');
    expect(res.stderr).toBe('agent-err\n');
    expect(res.status).toBe(7);
    const log = fs.readFileSync(path.join(home, '.agents', '.cache', 'logs', 'peer-login.log'), 'utf8');
    expect(log).toContain('.npmrc');
    expect(log).toContain('nvm-warning');
  });
});
