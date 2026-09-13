import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { sshStreamWithArgs, SSH_STREAM_MAX_STDERR } from './ssh-exec.js';

/**
 * A fake `ssh` that runs its last argument as a shell script.
 *
 * The hardening under test is process lifecycle — SIGTERM/SIGKILL escalation,
 * bounded stderr, a consumer that throws — none of which needs a real peer. A
 * stub binary exercises the REAL spawn/kill/stream code with a controllable
 * child, which is what these guarantees are about.
 */
const fixtureDirs: string[] = [];
function fakeSsh(body: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-ssh-'));
  fixtureDirs.push(dir);
  const bin = path.join(dir, 'ssh');
  fs.writeFileSync(bin, `#!/usr/bin/env bash\n${body}\n`, { mode: 0o755 });
  return bin;
}
// One stub per case adds up over a suite run; remove them rather than leaving
// temp dirs behind on every machine the suite touches.
afterEach(() => { for (const dir of fixtureDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });

describe('sshStreamWithArgs lifecycle', () => {
  it('streams stdout and reports a clean exit', async () => {
    const out: Buffer[] = [];
    const result = await sshStreamWithArgs({
      args: ['ignored-target'],
      sshBin: fakeSsh('printf "hello"'),
      onStdout: (chunk) => out.push(chunk),
    });
    expect(Buffer.concat(out).toString()).toBe('hello');
    expect(result.code).toBe(0);
    expect(result.killed).toBe(false);
    expect(result.timedOut).toBe(false);
  });

  /**
   * Run until the child says it is ready, then abort.
   *
   * Handshake-driven, NOT timing-driven. An earlier version used
   * `timeoutMs: 150` and asserted escalation — but on a loaded machine the
   * child's `trap` is not installed within 150ms, SIGTERM lands before it, the
   * child dies politely and `killed` is correctly false. That made the test
   * report a bug in the code when the only thing it had measured was bash
   * startup latency. Waiting for the child's own readiness marker removes every
   * assumption about how fast a process starts.
   */
  async function abortOnReady(body: string, killGraceMs: number) {
    const controller = new AbortController();
    return sshStreamWithArgs({
      args: ['t'],
      sshBin: fakeSsh(body),
      signal: controller.signal,
      killGraceMs,
      onStdout: (chunk) => { if (chunk.toString().includes('ready')) controller.abort(); },
    });
  }

  it('SIGKILLs a child that ignores SIGTERM, instead of hanging forever', async () => {
    // The bug this covers: sending SIGTERM and waiting means a child that traps
    // or ignores it never exits, so the promise never settles and the transfer
    // hangs. The trap is installed BEFORE the readiness marker, so by the time
    // this aborts, SIGTERM is guaranteed to be ignored.
    const started = Date.now();
    const result = await abortOnReady('trap "" TERM; printf "ready"; sleep 30', 200);
    expect(result.killed).toBe(true);
    // Settled on the escalation, not after the child's own 30s sleep.
    expect(Date.now() - started).toBeLessThan(10_000);
  });

  it('does not escalate a child that exits on SIGTERM', async () => {
    // Escalation must be a response to a child that ignores TERM, not something
    // applied indiscriminately.
    const result = await abortOnReady('printf "ready"; sleep 30', 5_000);
    expect(result.killed).toBe(false);
  });

  it('still reports a real timeout, with the deadline doing the work', async () => {
    // The timeout path itself is covered separately from escalation, with a
    // deadline generous enough that it cannot be confused with slow startup.
    const result = await sshStreamWithArgs({
      args: ['t'],
      sshBin: fakeSsh('printf "ready"; sleep 30'),
      timeoutMs: 1_500,
      killGraceMs: 5_000,
      onStdout: () => {},
    });
    expect(result.timedOut).toBe(true);
  });

  it('bounds stderr instead of buffering whatever the peer writes', async () => {
    const result = await sshStreamWithArgs({
      args: ['t'],
      // Far more than the cap, written to stderr.
      sshBin: fakeSsh('for i in $(seq 1 400); do printf "%0.sE" $(seq 1 100) >&2; done'),
      maxStderrBytes: 1024,
      onStdout: () => {},
    });
    expect(result.stderr.length).toBe(1024);
    expect(result.stderrTruncated).toBe(true);
  });

  it('keeps short stderr whole and does not claim truncation', async () => {
    const result = await sshStreamWithArgs({
      args: ['t'],
      sshBin: fakeSsh('printf "boom" >&2; exit 3'),
      onStdout: () => {},
    });
    expect(result.stderr.toString()).toBe('boom');
    expect(result.stderrTruncated).toBe(false);
    expect(result.code).toBe(3);
    expect(SSH_STREAM_MAX_STDERR).toBeGreaterThan(0);
  });

  it('rejects with the consumer error rather than letting it escape the stream', async () => {
    // A throw inside `onStdout` used to surface as an unhandled error on the
    // stream and skip the caller's cleanup entirely, leaving a partial file.
    const boom = new Error('local disk full');
    await expect(sshStreamWithArgs({
      args: ['t'],
      sshBin: fakeSsh('printf "x"; sleep 30'),
      killGraceMs: 200,
      onStdout: () => { throw boom; },
    })).rejects.toBe(boom);
  });

  it('stops feeding the consumer after it throws', async () => {
    let calls = 0;
    await expect(sshStreamWithArgs({
      args: ['t'],
      sshBin: fakeSsh('for i in $(seq 1 50); do printf "chunk"; sleep 0.01; done'),
      killGraceMs: 200,
      onStdout: () => { calls += 1; throw new Error('stop'); },
    })).rejects.toThrow('stop');
    expect(calls).toBe(1);
  });

  it('settles when the binary cannot be spawned at all', async () => {
    const result = await sshStreamWithArgs({
      args: ['t'],
      sshBin: '/nonexistent/ssh-binary',
      onStdout: () => {},
    });
    expect(result.code).toBeNull();
  });

  it('honours an already-aborted signal without streaming', async () => {
    const controller = new AbortController();
    controller.abort();
    const out: Buffer[] = [];
    const result = await sshStreamWithArgs({
      args: ['t'],
      sshBin: fakeSsh('sleep 30; printf "late"'),
      signal: controller.signal,
      killGraceMs: 200,
      onStdout: (chunk) => out.push(chunk),
    });
    expect(Buffer.concat(out).toString()).toBe('');
    expect(result.code).not.toBe(0);
  });
});
