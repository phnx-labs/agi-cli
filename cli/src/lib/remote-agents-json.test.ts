// Bound each peer before buffering; early exit cancels only pending peers, while already-returned duplicate matches remain visible as collisions.
import { describe, expect, it } from 'vitest';
import { spawnSync } from 'child_process';
import { EventEmitter } from 'events';
import { decodePowershell } from './hosts/remote-cmd.js';
import {
  captureBoundedStdout,
  gatherRemoteAgentsJson,
  parseRemoteAgentsJsonPayload,
  remoteAgentsJsonCommand,
  type CapturableChild,
  type SshCaptureFn,
} from './remote-agents-json.js';
import { REMOTE_STDOUT_MAX_BYTES } from './ssh-exec.js';
import { parseRemoteListPayload } from './session/remote-list.js';
import { decodeRenderedPowershell } from './hosts/remote-cmd.test-fixture.js';

class FakeChild extends EventEmitter implements CapturableChild {
  readonly stdout = new EventEmitter();
  readonly kills: Array<NodeJS.Signals | undefined> = [];
  kill(signal?: NodeJS.Signals): boolean {
    this.kills.push(signal);
    return true;
  }
}

describe('remoteAgentsJsonCommand', () => {
  it('guards a POSIX peer against recursive fan-out', () => {
    const command = remoteAgentsJsonCommand(['feed', '--json'], 'AGENTS_FEED_LOCAL', 'linux');
    expect(command).toContain('AGENTS_FEED_LOCAL=1 agents feed --json');
    expect(command).not.toContain('--local');
  });

  it('guards a Windows peer through its PowerShell environment', () => {
    const command = remoteAgentsJsonCommand(['feed', '--json'], 'AGENTS_FEED_LOCAL', 'windows');
    const script = decodeRenderedPowershell(command);
    expect(script).toContain("$env:AGENTS_FEED_LOCAL = '1'");
    expect(script).not.toContain("& 'agents'");
    expect(script).toMatch(/\$zi\.Arguments\s*=\s*\$zr\s*\+\s*'feed --json'/);
  });
});

describe('parseRemoteAgentsJsonPayload', () => {
  it('preserves a strict parse failure from a zero-exit peer', () => {
    const peer = spawnSync(process.execPath, ['--eval', "process.stdout.write('[{}]')"], { encoding: 'utf8' });
    expect(peer.status).toBe(0);

    const parsed = parseRemoteAgentsJsonPayload(
      peer.stdout,
      'peer',
      (stdout, machine) => parseRemoteListPayload(stdout, machine, true),
    );

    expect(parsed).toEqual({ items: [], parseFailed: true });
  });
});

describe('captureBoundedStdout per-peer stdout cap (RUSH-2065)', () => {
  it('returns a clean sub-ceiling payload on a zero-exit close', async () => {
    const child = new FakeChild();
    const capture = captureBoundedStdout(child, { timeoutMs: 1_000 });
    child.stdout.emit('data', Buffer.from('[{"id":"a"}]'));
    child.emit('close', 0);
    await expect(capture).resolves.toEqual({ code: 0, stdout: '[{"id":"a"}]' });
    expect(child.kills).toEqual([]);
  });

  it('SIGKILLs a peer that overflows the ceiling and settles it as unreachable', async () => {
    const child = new FakeChild();
    const capture = captureBoundedStdout(child, { timeoutMs: 5_000 });
    child.stdout.emit('data', Buffer.alloc(REMOTE_STDOUT_MAX_BYTES, 0x20));
    child.stdout.emit('data', Buffer.from('x'));
    const result = await capture;
    expect(result.code).toBeNull();
    expect(child.kills).toEqual(['SIGKILL']);
    expect(Buffer.byteLength(result.stdout)).toBeLessThanOrEqual(REMOTE_STDOUT_MAX_BYTES);
  });

  it('does not corrupt a multi-byte code point split across chunks', async () => {
    const child = new FakeChild();
    const capture = captureBoundedStdout(child, { timeoutMs: 1_000 });
    child.stdout.emit('data', Buffer.from([0xe2, 0x82]));
    child.stdout.emit('data', Buffer.from([0xac]));
    child.emit('close', 0);
    await expect(capture).resolves.toEqual({ code: 0, stdout: '€' });
  });

  it('settles null on a spawn error without killing', async () => {
    const child = new FakeChild();
    const capture = captureBoundedStdout(child, { timeoutMs: 1_000 });
    child.emit('error', new Error('ENOENT'));
    await expect(capture).resolves.toEqual({ code: null, stdout: '' });
  });
});

describe('gatherRemoteAgentsJson early-exit + cancellation', () => {
  const FAST = 'tester@fast.example.com';
  const SLOW = 'tester@slow.example.com';

  interface Row { id: string }
  const parseRows = (stdout: string): Row[] => (stdout ? JSON.parse(stdout) as Row[] : []);

  it('resolves on the first definitive hit and SIGTERMs the still-hanging peer', async () => {
    const aborted: string[] = [];
    const capture: SshCaptureFn = (target, _cmd, { signal }) => new Promise((resolve) => {
      if (target === FAST) { resolve({ code: 0, stdout: JSON.stringify([{ id: 'the-match' }]) }); return; }
      if (signal?.aborted) { aborted.push(target); resolve({ code: null, stdout: '' }); return; }
      signal?.addEventListener('abort', () => { aborted.push(target); resolve({ code: null, stdout: '' }); }, { once: true });
    });

    const result = await gatherRemoteAgentsJson<Row>({
      args: ['sessions', '--json'],
      noFanoutEnv: 'AGENTS_SESSIONS_LOCAL',
      hosts: [FAST, SLOW],
      quiet: true,
      timeoutMs: 60_000,
      parse: parseRows,
      earlyExit: { isDefinitive: (item) => item.id === 'the-match' },
    }, { capture });

    expect(result.items).toEqual([{ id: 'the-match' }]);
    expect(aborted).toEqual([SLOW]);
    expect(result.skipped).toEqual([]);
  });

  it('without early-exit, the default all-settle waits for every peer', async () => {
    const capture: SshCaptureFn = (target) => new Promise((resolve) => {
      if (target === FAST) resolve({ code: 0, stdout: JSON.stringify([{ id: 'a' }]) });
      else setTimeout(() => resolve({ code: 0, stdout: JSON.stringify([{ id: 'b' }]) }), 25);
    });

    const result = await gatherRemoteAgentsJson<Row>({
      args: ['sessions', '--json'],
      noFanoutEnv: 'X',
      hosts: [FAST, SLOW],
      quiet: true,
      parse: parseRows,
    }, { capture });

    expect(result.items.map(r => r.id).sort()).toEqual(['a', 'b']);
  });

  it('does not early-exit when no returned item satisfies the predicate', async () => {
    const capture: SshCaptureFn = (target) => new Promise((resolve) => {
      if (target === FAST) resolve({ code: 0, stdout: JSON.stringify([{ id: 'other' }]) });
      else setTimeout(() => resolve({ code: 0, stdout: JSON.stringify([{ id: 'another' }]) }), 25);
    });

    const result = await gatherRemoteAgentsJson<Row>({
      args: ['sessions', '--json'],
      noFanoutEnv: 'X',
      hosts: [FAST, SLOW],
      quiet: true,
      parse: parseRows,
      earlyExit: { isDefinitive: (item) => item.id === 'the-match' },
    }, { capture });

    expect(result.items.map(r => r.id).sort()).toEqual(['another', 'other']);
  });

  it('with NO earlyExit, two peers holding distinct same-label rows are BOTH collected (conflict stays visible)', async () => {
    const capture: SshCaptureFn = (target) => new Promise((resolve) => {
      if (target === FAST) resolve({ code: 0, stdout: JSON.stringify([{ id: 'peer-a', label: 'dup' }]) });
      else setTimeout(() => resolve({ code: 0, stdout: JSON.stringify([{ id: 'peer-b', label: 'dup' }]) }), 25);
    });

    const result = await gatherRemoteAgentsJson<Row & { label: string }>({
      args: ['sessions', '--json'],
      noFanoutEnv: 'X',
      hosts: [FAST, SLOW],
      quiet: true,
      parse: (stdout) => (stdout ? JSON.parse(stdout) : []),
    }, { capture });

    expect(result.items.map(r => r.id).sort()).toEqual(['peer-a', 'peer-b']);
  });

  it('PHNX-3292: a genuinely slower peer sharing the short id is cancelled, not surfaced as a collision (accepted risk)', async () => {
    const capture: SshCaptureFn = (target, _cmd, { signal }) => new Promise((resolve) => {
      if (target === FAST) { resolve({ code: 0, stdout: JSON.stringify([{ id: 'session-a', shortId: '0145ab8f' }]) }); return; }
      if (signal?.aborted) { resolve({ code: null, stdout: '' }); return; }
      signal?.addEventListener('abort', () => resolve({ code: null, stdout: '' }), { once: true });
    });

    const result = await gatherRemoteAgentsJson<{ id: string; shortId: string }>({
      args: ['sessions', '--resolve-safe-v1', '0145ab8f', '--json'],
      noFanoutEnv: 'X',
      hosts: [FAST, SLOW],
      quiet: true,
      timeoutMs: 60_000,
      parse: (stdout) => (stdout ? JSON.parse(stdout) : []),
      earlyExit: { isDefinitive: (item) => item.shortId === '0145ab8f' },
    }, { capture });

    expect(result.items).toEqual([{ id: 'session-a', shortId: '0145ab8f' }]);
    expect(result.skipped).toEqual([]);
  });

  it('PHNX-3292: two peers that BOTH answer before the abort lands still surface the collision', async () => {
    const capture: SshCaptureFn = (target) => new Promise((resolve) => {
      if (target === FAST) resolve({ code: 0, stdout: JSON.stringify([{ id: 'session-a', shortId: '0145ab8f' }]) });
      else resolve({ code: 0, stdout: JSON.stringify([{ id: 'session-b', shortId: '0145ab8f' }]) });
    });

    const result = await gatherRemoteAgentsJson<{ id: string; shortId: string }>({
      args: ['sessions', '--resolve-safe-v1', '0145ab8f', '--json'],
      noFanoutEnv: 'X',
      hosts: [FAST, SLOW],
      quiet: true,
      parse: (stdout) => (stdout ? JSON.parse(stdout) : []),
      earlyExit: { isDefinitive: (item) => item.shortId === '0145ab8f' },
    }, { capture });

    expect(result.items.map((r) => r.id).sort()).toEqual(['session-a', 'session-b']);
  });
});
