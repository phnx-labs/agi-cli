
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Server, type Connection } from 'ssh2';
import { sessionHeadline } from '../title.js';
import type { SessionMeta } from '@phnx-labs/sessions-cli/reader';
import {
  parseRemoteList,
  parseRemoteListPayload,
  parsePeerPreviewDigest,
  isAutomaticSessionPeer,
  remoteListCommand,
  sshCapture,
  peerHopCloseNotice,
  peerHopOutcome,
} from './remote-list.js';
import { SSH_CONN_FAILURE_CODE, RemoteUtf8Accumulator } from '../../ssh-exec.js';
import type { DeviceProfile } from '../../devices/registry.js';

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

describe('isAutomaticSessionPeer', () => {
  it('keeps manual and probe-reachable computers in both fleet sweeps', () => {
    const manual = {
      name: 'manual-linux',
      platform: 'linux',
      address: { via: 'manual', host: 'manual.example' },
    } as DeviceProfile;
    const probed = {
      name: 'sleepy-mac',
      platform: 'macos',
      tailscale: { online: false },
      reachability: { reachable: true },
    } as DeviceProfile;

    expect(isAutomaticSessionPeer(manual, 'local')).toBe(true);
    expect(isAutomaticSessionPeer(probed, 'local')).toBe(true);
    expect(isAutomaticSessionPeer({ ...manual, name: 'local' }, 'local')).toBe(false);
  });
});

describe('parseRemoteList', () => {
  it('tags every parsed session with the source machine', () => {
    const stdout = JSON.stringify([
      { id: 'a', shortId: 'a', agent: 'claude', timestamp: '2026-07-01T00:00:00Z', filePath: '/r/a.jsonl' },
      { id: 'b', shortId: 'b', agent: 'codex', timestamp: '2026-07-02T00:00:00Z', filePath: '/r/b.jsonl' },
    ]);
    const out = parseRemoteList(stdout, 'zion');
    expect(out).toHaveLength(2);
    expect(out.every((s) => s.machine === 'zion')).toBe(true);
    expect(out[0].id).toBe('a');
  });

  it('carries a peer\'s daemon-generated title through the fan-out (PHNX-3797)', () => {
    const stdout = JSON.stringify([{
      id: 'a', shortId: 'a', agent: 'claude', timestamp: '2026-07-01T00:00:00Z',
      filePath: '/peer/a.jsonl',
      topic: 'the fleet list headline is the agent last message',
      generatedTitle: 'Session headline ladder fix',
    }]);
    const [row] = parseRemoteList(stdout, 'zion');
    expect(row.generatedTitle).toBe('Session headline ladder fix');
    expect(sessionHeadline(row)).toBe('Session headline ladder fix');
  });

  it('marks every parsed row _remote so it routes read/resume back over SSH', () => {
    const stdout = JSON.stringify([
      { id: 'a', shortId: 'a', agent: 'claude', timestamp: '2026-07-01T00:00:00Z', filePath: '/peer/a.jsonl' },
    ]);
    const out = parseRemoteList(stdout, 'zion');
    expect(out[0]._remote).toBe(true);
  });

  it('overrides any machine tag the peer set on its own rows', () => {
    const stdout = JSON.stringify([
      { id: 'a', shortId: 'a', agent: 'claude', timestamp: '2026-07-01T00:00:00Z', filePath: '/r/a.jsonl', machine: 'their-local-name' },
    ]);
    const out = parseRemoteList(stdout, 'mark');
    expect(out[0].machine).toBe('mark');
  });

  it('returns [] on non-JSON (a login-shell banner leaked into stdout)', () => {
    expect(parseRemoteList('bash: agents: command not found\n', 'zion')).toEqual([]);
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
    const out = parseRemoteList(polluted, 'win-mini');
    expect(out).toHaveLength(1);
    expect(out[0].id).toBe('w');
    expect(out[0].machine).toBe('win-mini');
  });

  it('returns [] when the top level is not an array', () => {
    expect(parseRemoteList(JSON.stringify({ error: 'nope' }), 'zion')).toEqual([]);
  });

  it('drops non-object entries but keeps the valid ones', () => {
    const stdout = JSON.stringify([null, 'weird', 42, { id: 'x', shortId: 'x', agent: 'claude', timestamp: '2026-07-01T00:00:00Z', filePath: '/r/x.jsonl' }]);
    const out = parseRemoteList(stdout, 'mark');
    expect(out).toHaveLength(1);
    expect(out[0].machine).toBe('mark');
  });

  it('returns [] on empty stdout (peer produced nothing)', () => {
    expect(parseRemoteList('', 'zion')).toEqual([]);
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

  it('accepts the production resolver projection with launch mode and custom harness', async () => {
    const { serializeResolvedSessionsJson } = await import('../../../commands/sessions.js');
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
    expect(s).toContain(`agents sessions resume ${SID}`);
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
  it('reports unreachable when the SSH connection itself failed (255) or never settled (null)', () => {
    expect(peerHopOutcome(SSH_CONN_FAILURE_CODE)).toBe('unreachable');
    expect(peerHopOutcome(null)).toBe('unreachable');
  });
  it('reports ok when the hop reached the peer, whatever the remote command exit code', () => {
    expect(peerHopOutcome(0)).toBe('ok');
    expect(peerHopOutcome(1)).toBe('ok');
    expect(peerHopOutcome(130)).toBe('ok');
    expect(peerHopOutcome(254)).toBe('ok');
  });
});
