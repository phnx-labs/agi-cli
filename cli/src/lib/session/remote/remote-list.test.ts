/**
 * Tests for parsing a peer's `sessions --json` output during the browse-listing
 * fan-out. Like the --active parser, this must be defensive: a peer may run an
 * older/newer agents whose stdout is truncated, non-JSON, or carries its own
 * `machine` tag — one bad peer must never throw and blank the merged list, and
 * the machine we dialed must win so grouping keys off the computer we asked.
 */

import { describe, it, expect } from 'vitest';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Server, type Connection } from 'ssh2';
import { sessionHeadline } from '../title.js';
import {
  REMOTE_STDOUT_MAX_BYTES,
  REMOTE_TOOL_AGGREGATE_MAX_BYTES,
  consumeParsedRemoteToolSearchBudget,
  consumeRemoteToolByteBudget,
  parseRemoteList,
  parseRemoteListPayload,
  parsePeerPreviewDigest,
  parseRemoteToolSearch,
  parseRemoteToolProgramCount,
  RemoteUtf8Accumulator,
  isAutomaticSessionPeer,
  remoteListCommand,
  sshCapture,
  peerHopCloseNotice,
  peerHopOutcome,
} from './remote-list.js';
import { SSH_CONN_FAILURE_CODE } from '../../ssh-exec.js';
import type { DeviceProfile } from '../../devices/registry.js';
import { TOOL_QUERY_MAX_CALL_ROWS } from '../tool-index.js';

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
        undefined,
        { multiplex: false, port: peer.port, hostKeyOpts: isolatedHostKeyOpts },
      );
      expect(result).toEqual({ code: 0, stdout: '{"ok":true}', aggregateBudgetExceeded: undefined });
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
        undefined,
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
    // "A remote session shows the SAME title in the viewer" rests on this parse
    // SPREADING the peer's row rather than re-listing known fields: a re-listed
    // projection silently drops the generatedTitle rung and the remote row
    // headlines its raw prompt instead.
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
    // The peer's discover tags rows with ITS local id; we must relabel to the
    // machine we dialed, else two peers that both call themselves "local" collide.
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

describe('parseRemoteToolSearch', () => {
  it('preserves a multibyte code point split across SSH stdout chunks', () => {
    const bytes = Buffer.from('before 界 after', 'utf8');
    const split = bytes.indexOf(Buffer.from('界')) + 1;
    const decoded = new RemoteUtf8Accumulator();
    decoded.write(bytes.subarray(0, split));
    decoded.write(bytes.subarray(split));
    expect(decoded.end()).toBe('before 界 after');
  });

  it('accepts only the versioned envelope and stamps the peer when origin is absent', () => {
    const credential = 'opaque-session-credential-123456';
    const payload = JSON.stringify({
      schemaVersion: 1,
      generatedAt: '2026-08-03T00:00:00Z',
      query: { clauses: ['program:git'] },
      coverage: { indexedFiles: 0, indexedCalls: 0, skippedFiles: 0, limitedFiles: 0, remainingFiles: 0, complete: true },
      sessions: [{
        id: 'one', shortId: 'one', agent: 'codex', timestamp: '2026-08-03T00:00:00Z',
        filePath: '/peer/one.jsonl', calls: [{
          id: 'call', ordinal: 0, timestamp: '2026-08-03T00:00:01Z', tool: 'exec_command',
          programs: ['git'], programOccurrences: [{ program: 'git', role: 'effective' }],
          input: `git status\u001b]52;c;payload\u0007 -H "Cookie: sid=${credential}" --proxy-user=user:${credential}`, outcome: 'unknown',
        }],
      }],
    });
    const parsed = parseRemoteToolSearch(payload, 'mac-mini');
    expect(parsed?.sessions[0].machine).toBe('mac-mini');
    expect(parsed?.sessions[0].filePath).toBeUndefined();
    expect(parsed?.sessions[0].calls[0].input).toContain('git status');
    expect(parsed?.sessions[0].calls[0].input).not.toContain(credential);
    expect(parsed?.sessions[0].calls[0].input).not.toContain('\u001b');
    expect(parseRemoteToolSearch('[]', 'mac-mini')).toBeUndefined();
    expect(parseRemoteToolSearch('{broken', 'mac-mini')).toBeUndefined();
    expect(parseRemoteToolSearch(payload, 'mac-mini', ['program:gh'])).toBeUndefined();
    expect(parseRemoteToolSearch(payload, 'mac-mini', ['program:git'])?.sessions).toHaveLength(1);
  });

  it('parses an envelope a Windows peer prefixed with a CLIXML banner (RUSH-2286)', () => {
    const payload = JSON.stringify({
      schemaVersion: 1,
      generatedAt: '2026-08-06T00:00:00Z',
      query: { clauses: ['program:git'] },
      coverage: { indexedFiles: 0, indexedCalls: 0, skippedFiles: 0, limitedFiles: 0, remainingFiles: 0, complete: true },
      sessions: [{
        id: 'w', shortId: 'w', agent: 'codex', timestamp: '2026-08-06T00:00:00Z',
        filePath: 'C:\\peer\\w.jsonl', calls: [{
          id: 'c', ordinal: 0, timestamp: '2026-08-06T00:00:01Z', tool: 'exec_command',
          programs: ['git'], programOccurrences: [{ program: 'git', role: 'effective' }],
          input: 'git status', outcome: 'unknown',
        }],
      }],
    });
    const polluted =
      '#< CLIXML\n' +
      '<Objs Version="1.1.0.1" xmlns="http://schemas.microsoft.com/powershell/2004/04">' +
      '<Obj S="progress" RefId="0"><MS><AV>Preparing modules for first use.</AV></MS></Obj></Objs>\n' +
      payload;
    const parsed = parseRemoteToolSearch(polluted, 'win-mini');
    expect(parsed?.sessions).toHaveLength(1);
    expect(parsed?.sessions[0].machine).toBe('win-mini');
  });

  it('preserves the transcript origin machine across a peer hop', () => {
    const payload = JSON.stringify({
      schemaVersion: 1,
      generatedAt: '2026-08-03T00:00:00Z',
      query: { clauses: ['program:git'] },
      coverage: { indexedFiles: 1, indexedCalls: 1, skippedFiles: 0, limitedFiles: 0, remainingFiles: 0, complete: true },
      sessions: [{
        id: 'one', shortId: 'one', agent: 'codex', machine: 'origin-one',
        timestamp: '2026-08-03T00:00:00Z', calls: [],
      }],
    });
    expect(parseRemoteToolSearch(payload, 'cache-peer')?.sessions[0].machine).toBe('origin-one');
  });

  it('rejects oversized or structurally invalid peer evidence before merging', () => {
    expect(parseRemoteToolSearch('x'.repeat(REMOTE_STDOUT_MAX_BYTES + 1), 'peer')).toBeUndefined();
    expect(parseRemoteToolSearch(JSON.stringify({
      schemaVersion: 1,
      generatedAt: '2026-08-03T00:00:00Z',
      query: { clauses: [] },
      coverage: { indexedFiles: 0, indexedCalls: 0, skippedFiles: 0, limitedFiles: 0, remainingFiles: 0, complete: true },
      sessions: [{ id: 'one', shortId: 'one', agent: 'codex', timestamp: '2026-08-03T00:00:00Z', calls: [{}] }],
    }), 'peer')).toBeUndefined();

    const envelope = {
      schemaVersion: 1,
      generatedAt: '2026-08-03T00:00:00Z',
      query: { clauses: [] },
      coverage: { indexedFiles: 0, indexedCalls: 0, skippedFiles: 0, limitedFiles: 0, remainingFiles: 0, complete: true },
      sessions: [{
        id: 'one', shortId: 'one', agent: 'codex', timestamp: '2026-08-03T00:00:00Z',
        calls: Array.from({ length: TOOL_QUERY_MAX_CALL_ROWS + 1 }, () => ({})),
      }],
    };
    expect(parseRemoteToolSearch(JSON.stringify(envelope), 'peer')).toBeUndefined();

    const half = Math.ceil(TOOL_QUERY_MAX_CALL_ROWS / 2);
    envelope.sessions = ['one', 'two'].map((id) => ({
      id, shortId: id, agent: 'codex', timestamp: '2026-08-03T00:00:00Z',
      calls: Array.from({ length: half }, () => ({})),
    }));
    expect(parseRemoteToolSearch(JSON.stringify(envelope), 'peer')).toBeUndefined();

    envelope.sessions = [{
      id: 'one', shortId: 'one', agent: 'codex', timestamp: '2026-08-03T00:00:00Z', calls: [],
    }];
    envelope.sessions[0].calls = [{
      id: 'call', ordinal: 0, timestamp: '2026-08-03T00:00:01Z', tool: 'exec_command',
      programs: Array.from({ length: 129 }, () => 'git'), input: 'git status', outcome: 'unknown',
    }];
    expect(parseRemoteToolSearch(JSON.stringify(envelope), 'peer')).toBeUndefined();
  });
});

describe('parseRemoteToolProgramCount', () => {
  it('accepts the versioned aggregate and replaces its machine with the dialed peer', () => {
    const payload = JSON.stringify({
      schemaVersion: 1,
      kind: 'tool-program-count',
      generatedAt: '2026-08-03T00:00:00Z',
      query: { program: 'git', semantics: 'static-program-occurrences-v1' },
      coverage: { indexedFiles: 4, indexedCalls: 8, skippedFiles: 0, limitedFiles: 0, remainingFiles: 0, complete: true },
      totals: { occurrences: 7, toolCalls: 5, sessions: 3 },
      machines: [{ machine: 'untrusted', coverage: {}, totals: {} }],
    });
    const parsed = parseRemoteToolProgramCount(payload, 'peer-one', 'git');
    expect(parsed).toMatchObject({
      valid: true,
      items: [{ machine: 'peer-one', envelope: {
        totals: { occurrences: 7, toolCalls: 5, sessions: 3 },
        machines: [{ machine: 'peer-one' }],
      } }],
    });
    expect(parseRemoteToolProgramCount(payload, 'peer-one', 'gh').valid).toBe(false);
    expect(parseRemoteToolProgramCount('{broken', 'peer-one', 'git').valid).toBe(false);
  });
});

describe('fleet tool-result byte budget', () => {
  it('stops retaining peer bytes at the global fleet-query ceiling', () => {
    const budget = { remainingBytes: REMOTE_TOOL_AGGREGATE_MAX_BYTES, exhausted: false };
    expect(consumeRemoteToolByteBudget(budget, REMOTE_TOOL_AGGREGATE_MAX_BYTES - 1)).toBe(true);
    expect(consumeRemoteToolByteBudget(budget, 2)).toBe(false);
    expect(budget).toEqual({ remainingBytes: 0, exhausted: true });
  });

  it('charges the sanitized envelope so redaction expansion cannot overflow the merge', () => {
    const raw = JSON.stringify({
        schemaVersion: 1,
        generatedAt: '2026-08-03T00:00:00Z',
        query: { clauses: [] },
        coverage: { indexedFiles: 1, indexedCalls: 1, skippedFiles: 0, limitedFiles: 0, remainingFiles: 0, complete: true },
        sessions: [{
          id: 'one', shortId: 'one', agent: 'codex', timestamp: '2026-08-03T00:00:00Z',
          calls: [{
            id: 'one:0', ordinal: 0, timestamp: '2026-08-03T00:00:00Z',
            tool: 'exec_command', programs: ['printf'],
            programOccurrences: [{ program: 'printf', role: 'effective' }],
            input: 'printf TOKEN=abcdef', outcome: 'unknown',
          }],
        }],
      }, null, 2) + '\n';
    const parsed = parseRemoteToolSearch(raw, 'peer');
    expect(parsed?.sessions[0].calls[0].input).toContain('TOKEN=[REDACTED]');
    const budget = { remainingBytes: Buffer.byteLength(raw), exhausted: false };
    expect(consumeParsedRemoteToolSearchBudget(budget, parsed!)).toBe(false);
    expect(budget.exhausted).toBe(true);
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
