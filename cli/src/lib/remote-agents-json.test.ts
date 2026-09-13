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

/**
 * A fake `ssh` child: an EventEmitter for the process-level `error`/`close`
 * events with a nested emitter standing in for `stdout`, recording every kill so
 * a test can assert the capture aborted a runaway peer.
 */
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
    // The npm `agents.ps1` shim is bypassed: it splats `$args` into native
    // node.exe, where PowerShell 5.1 drops empty args and eats embedded quotes.
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
    expect(child.kills).toEqual([]); // a well-behaved peer is never killed
  });

  it('SIGKILLs a peer that overflows the ceiling and settles it as unreachable', async () => {
    const child = new FakeChild();
    const capture = captureBoundedStdout(child, { timeoutMs: 5_000 });
    // First chunk sits exactly at the ceiling (allowed); the next byte trips it.
    child.stdout.emit('data', Buffer.alloc(REMOTE_STDOUT_MAX_BYTES, 0x20));
    child.stdout.emit('data', Buffer.from('x'));
    const result = await capture;
    expect(result.code).toBeNull(); // overflow → treated as unreachable, not trusted
    expect(child.kills).toEqual(['SIGKILL']);
    // The buffer never grew past the ceiling (the tripping byte was dropped).
    expect(Buffer.byteLength(result.stdout)).toBeLessThanOrEqual(REMOTE_STDOUT_MAX_BYTES);
  });

  it('does not corrupt a multi-byte code point split across chunks', async () => {
    const child = new FakeChild();
    const capture = captureBoundedStdout(child, { timeoutMs: 1_000 });
    // '€' is 0xE2 0x82 0xAC — split it so a naive per-chunk toString() would mangle it.
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
  // `user@fqdn` tokens resolve to distinct dialable targets with no registry and
  // no real SSH; the injected capture is the only boundary the fan-out touches.
  const FAST = 'tester@fast.example.com';
  const SLOW = 'tester@slow.example.com';

  interface Row { id: string }
  const parseRows = (stdout: string): Row[] => (stdout ? JSON.parse(stdout) as Row[] : []);

  // The SLOW peer models a slow/unreachable box: it never answers on its own —
  // only its AbortSignal firing settles it, recording that it was cancelled. If
  // the fan-out waited for it (no early-exit), the 60s timeout would hang the test.
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
      timeoutMs: 60_000, // long: only the abort, never a timeout, can settle SLOW
      parse: parseRows,
      earlyExit: { isDefinitive: (item) => item.id === 'the-match' },
    }, { capture });

    expect(result.items).toEqual([{ id: 'the-match' }]);
    expect(aborted).toEqual([SLOW]);   // the hanging peer's signal fired (was cancelled)
    expect(result.skipped).toEqual([]); // a cancelled peer is NOT reported unreachable
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
      // no earlyExit → both peers must be collected (tool-search / program-count path)
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
      earlyExit: { isDefinitive: (item) => item.id === 'the-match' }, // never matches
    }, { capture });

    expect(result.items.map(r => r.id).sort()).toEqual(['another', 'other']);
  });

  it('with NO earlyExit, two peers holding distinct same-label rows are BOTH collected (conflict stays visible)', async () => {
    // The regression the reviewer caught: if labels early-exited, the first peer
    // would abort the second and hide the collision. Labels do NOT pass earlyExit
    // (they are not globally unique), so both rows come back and the caller can
    // surface the conflict. Modelled as two distinct ids sharing a label.
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
      // no earlyExit — a label lookup must wait for every peer
    }, { capture });

    expect(result.items.map(r => r.id).sort()).toEqual(['peer-a', 'peer-b']);
  });

  // PHNX-3292 widened isDefinitiveMatch/selectorAllowsEarlyExit past full UUID
  // to a live tmux alias and an exact 8-hex short id — both name at most one
  // session PER ANSWERING peer, so the trade above (label rows stay all-settle)
  // does not apply to them the same way. These two tests pin the accepted risk
  // documented on isDefinitiveMatch: a peer that has genuinely not answered YET
  // when the abort fires is invisible to the uniqueness check (same stance
  // SES-9a already takes for an unreachable peer post-sweep) — but a peer that
  // HAS answered, even a beat before the abort takes effect, still contributes
  // its row, so a real collision between two ANSWERED peers is never hidden.
  it('PHNX-3292: a genuinely slower peer sharing the short id is cancelled, not surfaced as a collision (accepted risk)', async () => {
    const capture: SshCaptureFn = (target, _cmd, { signal }) => new Promise((resolve) => {
      if (target === FAST) { resolve({ code: 0, stdout: JSON.stringify([{ id: 'session-a', shortId: '0145ab8f' }]) }); return; }
      // SLOW never answers on its own — it also holds a session with the SAME
      // short id, but only settles via the abort, modelling "has not answered yet".
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

    // Only the fast, answered peer's row comes back — the slower peer's
    // colliding session is invisible, the accepted PHNX-3292 trade.
    expect(result.items).toEqual([{ id: 'session-a', shortId: '0145ab8f' }]);
    expect(result.skipped).toEqual([]); // cancelled, not reported unreachable
  });

  it('PHNX-3292: two peers that BOTH answer before the abort lands still surface the collision', async () => {
    // Both peers resolve immediately (no artificial delay), so their captures
    // settle in the same microtask sweep — modelling two REACHABLE peers that
    // both answered, not one that is still in flight.
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

    // Both distinct sessions' rows are present — the caller's uniqueness gate
    // (metadataResolveOutcome/fleetCandidatesByQuery) is what turns this into
    // an `ambiguous` outcome, not gatherRemoteAgentsJson itself.
    expect(result.items.map((r) => r.id).sort()).toEqual(['session-a', 'session-b']);
  });
});
