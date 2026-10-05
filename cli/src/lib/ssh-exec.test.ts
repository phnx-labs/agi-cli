import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  assertValidSshTarget,
  SSH_TARGET_RE,
  shellQuote,
  controlOpts,
  SSH_CONTROL_PERSIST_SECONDS,
  SSH_OPTS,
  sshConnectOpts,
  sshExec,
  sshExecAsync,
  SSH_TIMEOUT_KILL_GRACE_MS,
  sshExecRawStream,
  TERMINAL_MODE_RESET, restoreLocalTerminal, saveLocalTerminal,
} from './ssh-exec.js';

describe('assertValidSshTarget', () => {
  it('accepts bare host aliases and user@host', () => {
    expect(() => assertValidSshTarget('yosemite-s0')).not.toThrow();
    expect(() => assertValidSshTarget('muqsit@yosemite-s1')).not.toThrow();
    expect(() => assertValidSshTarget('box.local')).not.toThrow();
    expect(() => assertValidSshTarget('100.84.1.2')).not.toThrow();
  });

  it('rejects shell metacharacters and command injection', () => {
    expect(() => assertValidSshTarget('a;rm -rf /')).toThrow();
    expect(() => assertValidSshTarget('a$(whoami)')).toThrow();
    expect(() => assertValidSshTarget('a host')).toThrow();
    expect(() => assertValidSshTarget('a|b')).toThrow();
    expect(() => assertValidSshTarget('')).toThrow();
  });

  it('rejects a leading dash so a target cannot be smuggled as an ssh flag', () => {
    // This is the bug the bare regex misses — guarded explicitly in ssh-exec.
    expect(() => assertValidSshTarget('-oProxyCommand=evil')).toThrow();
    expect(() => assertValidSshTarget('-l')).toThrow();
    expect(SSH_TARGET_RE.test('-l')).toBe(true); // the bare regex matches '-l' — the leading-dash guard is what blocks it
  });
});

describe('shellQuote', () => {
  it('passes safe tokens through unquoted', () => {
    expect(shellQuote('claude')).toBe('claude');
    expect(shellQuote('/usr/bin/agents')).toBe('/usr/bin/agents');
  });

  it('single-quotes strings with spaces or shell metacharacters', () => {
    expect(shellQuote('fix the bug')).toBe("'fix the bug'");
    expect(shellQuote('a;b')).toBe("'a;b'");
  });

  it('escapes embedded single quotes correctly', () => {
    // it's -> 'it'\''s'  (close, escaped quote, reopen)
    expect(shellQuote("it's")).toBe("'it'\\''s'");
  });
});

describe('SSH_OPTS (hardened baseline)', () => {
  it('keeps the connection hardening', () => {
    expect(SSH_OPTS).toContain('StrictHostKeyChecking=accept-new');
    expect(SSH_OPTS).toContain('BatchMode=yes');
    expect(SSH_OPTS).toContain('ConnectTimeout=10');
  });

  it('adds keepalive so a dropped link exits instead of zombying', () => {
    // ServerAliveInterval * ServerAliveCountMax bounds how long a dead
    // connection can hang before ssh gives up (~45s here).
    expect(SSH_OPTS).toContain('ServerAliveInterval=15');
    expect(SSH_OPTS).toContain('ServerAliveCountMax=3');
  });
});

describe('sshConnectOpts (host-key override ordering)', () => {
  it('is the plain baseline when no override is given', () => {
    expect(sshConnectOpts(['-o', 'ControlMaster=auto'])).toEqual([
      ...SSH_OPTS,
      '-o', 'ControlMaster=auto',
    ]);
  });

  it('prepends host-key opts AHEAD of the accept-new baseline (RUSH-1767: ssh honors the first value)', () => {
    const override = ['-o', 'UserKnownHostsFile=/managed/kh', '-o', 'StrictHostKeyChecking=yes'];
    const args = sshConnectOpts([], override);
    const firstStrict = args.indexOf('StrictHostKeyChecking=yes');
    const baselineAcceptNew = args.indexOf('StrictHostKeyChecking=accept-new');
    // The strict override must appear before the baseline accept-new, or ssh
    // would silently keep accept-new and ship creds over an unverified connect.
    expect(firstStrict).toBeGreaterThanOrEqual(0);
    expect(baselineAcceptNew).toBeGreaterThan(firstStrict);
  });
});

describe('controlOpts (connection multiplexing)', () => {
  it('is empty on Windows (OpenSSH there has no ControlMaster support)', () => {
    if (process.platform !== 'win32') return; // asserted on the other branch below
    expect(controlOpts()).toEqual([]);
  });

  it('returns ControlMaster/ControlPath/ControlPersist and creates the socket dir', () => {
    if (process.platform === 'win32') return; // multiplexing skipped on Windows
    const opts = controlOpts();
    expect(opts).toContain('ControlMaster=auto');
    expect(opts).toContain(`ControlPersist=${SSH_CONTROL_PERSIST_SECONDS}s`);
    const cp = opts.find((o) => o.startsWith('ControlPath='));
    expect(cp).toBeDefined();
    // %C keeps the socket path short (macOS sun_path limit) and the dir must exist.
    expect(cp).toContain('%C');
    const dir = path.dirname(cp!.replace('ControlPath=', ''));
    expect(fs.existsSync(dir)).toBe(true);
  });

  it('keeps a multi-minute burst of same-host touches warm — well above the old 60s (PHNX-2582)', () => {
    // The master survives only while idle under ControlPersist, so the window must span the gap
    // between ad-hoc --device and fan-out touches, which come in bursts over minutes; at 60s any
    // two more than a minute apart were cold. Guard that it stays several minutes.
    const OLD_COLD_WINDOW_SECONDS = 60;
    expect(SSH_CONTROL_PERSIST_SECONDS).toBeGreaterThanOrEqual(5 * 60);
    expect(SSH_CONTROL_PERSIST_SECONDS).toBeGreaterThan(OLD_COLD_WINDOW_SECONDS);
  });
});

// POSIX-only: the stub is a `#!/bin/sh` script, which Windows cannot exec.
// Same skip rationale as the sshExecAsync suite below.
describe.skipIf(process.platform === 'win32')('sshExec timedOut detection (PATH ssh stub)', () => {
  function withStubSshSync<T>(script: string, fn: () => T): T {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sshstub-'));
    fs.writeFileSync(path.join(dir, 'ssh'), script, { mode: 0o755 });
    const prevPath = process.env.PATH;
    process.env.PATH = dir + path.delimiter + prevPath;
    try {
      return fn();
    } finally {
      process.env.PATH = prevPath;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  it('flags timedOut when spawnSync kills the ssh process after timeoutMs', () => {
    // Before the fix, spawnSync set res.signal = 'SIGTERM' on timeout but NOT
    // res.error.code = 'ETIMEDOUT', so the old detection always returned false.
    const res = withStubSshSync(
      '#!/bin/sh\nexec sleep 30\n',
      () => sshExec('testhost', 'slow', { multiplex: false, timeoutMs: 150 }),
    );
    expect(res.timedOut).toBe(true);
    expect(res.code).toBeNull();
  });

  it('does not flag timedOut when the stub exits normally within the timeout', () => {
    const res = withStubSshSync(
      '#!/bin/sh\nprintf "out"\nexit 0\n',
      () => sshExec('testhost', 'fast', { multiplex: false, timeoutMs: 5000 }),
    );
    expect(res.timedOut).toBe(false);
    expect(res.code).toBe(0);
  });
});

// POSIX-only: the stub is a `#!/bin/sh` script Windows cannot exec. The product code
// (sshExecAsync) is cross-platform; only this harness is not. The Windows matrix runs on release
// PRs, which is where this surfaced.
describe.skipIf(process.platform === 'win32')('sshExecAsync (real spawn via a PATH ssh stub — no mocks)', () => {
  // Put a real executable named `ssh` first on PATH so sshExecAsync's spawn('ssh') runs it: a real
  // subprocess round-trip for stdout/stderr capture, exit codes and the timeout -> SIGTERM path,
  // without a reachable host.
  function withStubSsh<T>(script: string, fn: () => Promise<T>): Promise<T> {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sshstub-'));
    fs.writeFileSync(path.join(dir, 'ssh'), script, { mode: 0o755 });
    const prevPath = process.env.PATH;
    process.env.PATH = dir + path.delimiter + prevPath;
    return fn().finally(() => {
      process.env.PATH = prevPath;
      fs.rmSync(dir, { recursive: true, force: true });
    });
  }

  it('captures stdout/stderr and propagates the exit code from a real spawn', async () => {
    const res = await withStubSsh(
      '#!/bin/sh\nprintf "OUT_OK"\nprintf "ERR_OK" 1>&2\nexit 7\n',
      () => sshExecAsync('testhost', 'echo hi', { multiplex: false }),
    );
    expect(res.stdout).toContain('OUT_OK');
    expect(res.stderr).toContain('ERR_OK');
    expect(res.code).toBe(7);
    expect(res.timedOut).toBe(false);
  });

  it('kills the child and flags timedOut when it exceeds timeoutMs', async () => {
    const res = await withStubSsh(
      // exec so the killed pid IS the sleep (its stdio pipes close on death, firing
      // 'close'); a plain `sleep` child would orphan and hold the pipes open.
      '#!/bin/sh\nexec sleep 30\n',
      () => sshExecAsync('testhost', 'slow', { multiplex: false, timeoutMs: 150 }),
    );
    expect(res.timedOut).toBe(true);
    expect(res.code).toBeNull(); // SIGTERM-terminated child closes with a null exit code
  });

  it('hard-kills an ssh child that ignores SIGTERM without freezing the event loop', async () => {
    let heartbeats = 0;
    const interval = setInterval(() => { heartbeats += 1; }, 20);
    const startedAt = Date.now();
    try {
      const res = await withStubSsh(
        // A real child process that deliberately ignores the soft timeout. The
        // busy loop avoids an orphaned grandchild holding stdout/stderr open.
        '#!/bin/sh\ntrap "" TERM\nwhile :; do :; done\n',
        () => sshExecAsync('testhost', 'wedged', { multiplex: false, timeoutMs: 500 }),
      );
      expect(res.timedOut).toBe(true);
      expect(res.code).toBeNull();
      const elapsed = Date.now() - startedAt;
      // If SIGTERM killed the child, this would resolve around 500ms. Waiting
      // through the grace proves the SIGKILL branch handled the ignored signal.
      expect(elapsed).toBeGreaterThanOrEqual(500 + SSH_TIMEOUT_KILL_GRACE_MS - 50);
      expect(elapsed).toBeLessThan(500 + SSH_TIMEOUT_KILL_GRACE_MS + 1_500);
      expect(heartbeats).toBeGreaterThanOrEqual(20);
    } finally {
      clearInterval(interval);
    }
  });

  it('uses a fresh connection (no ControlMaster) when a timeout is set, even if multiplexing is requested', async () => {
    const res = await withStubSsh(
      '#!/bin/sh\nprintf "%s" "$*"\nexit 0\n',
      () => sshExecAsync('testhost', 'cmd', { timeoutMs: 1000 }),
    );
    // If multiplexing were honoured, ControlMaster=auto would appear in the argv
    // we forwarded to ssh. With a timeout we must use a direct connection so the
    // local timeout actually stops the remote command (RUSH-2114).
    expect(res.stdout).not.toContain('ControlMaster');
  });

  it('does not crash on EPIPE when input is piped to a child that exits before reading it', async () => {
    // Stub exits immediately without reading stdin; end(bigInput) would emit EPIPE
    // on child.stdin. Without the stream 'error' guard that is an uncaught exception
    // that kills the process — with it, this resolves to a normal result.
    const bigInput = 'x'.repeat(2 * 1024 * 1024);
    const res = await withStubSsh(
      '#!/bin/sh\nexit 0\n',
      () => sshExecAsync('testhost', 'consume', { multiplex: false, input: bigInput }),
    );
    expect(res.timedOut).toBe(false);
    expect(res.code === 0 || res.code === null).toBe(true);
  });

  it('streams raw stdout chunks and captures stderr without UTF-8 decoding', async () => {
    const chunks: Buffer[] = [];
    const res = await withStubSsh(
      '#!/bin/sh\nprintf "\\303"\nprintf "ERR_OK" 1>&2\nexit 4\n',
      () => sshExecRawStream('testhost', 'raw', {
        multiplex: false,
        onStdout: (chunk) => { chunks.push(chunk); },
      }),
    );

    expect(Buffer.concat(chunks)).toEqual(Buffer.from([0xc3]));
    expect(res.stderr.toString('utf8')).toBe('ERR_OK');
    expect(res.code).toBe(4);
    expect(res.timedOut).toBe(false);
  });
});


describe('local terminal restore after an interactive stream (RUSH-3125)', () => {
  // A remote TUI killed by a dropped link never sends its exit sequences, so its DEC modes stay
  // armed on the local terminal and it answers back at the shell (the `^[[?997;1n ^[[I ^[[O`
  // litter in the reported capture) (RUSH-3125).
  it('disables every DEC mode a full-screen TUI arms, and re-shows the cursor', () => {
    for (const mode of ['1004', '996', '997', '2004', '1049', '1000', '1002', '1003', '1006']) {
      expect(TERMINAL_MODE_RESET).toContain(`\x1b[?${mode}l`);
    }
    expect(TERMINAL_MODE_RESET).toContain('\x1b[?25h');
  });

  it('sets no mode it means to clear — every sequence is a reset but the cursor', () => {
    const set = TERMINAL_MODE_RESET.match(/\x1b\[\?\d+h/g) ?? [];
    expect(set).toEqual(['\x1b[?25h']);
  });

  // The suite's stdin is a pipe, so this is the real non-TTY branch, not a mock.
  it('snapshots nothing when stdin is not a TTY', () => {
    expect(process.stdin.isTTY).toBeFalsy();
    expect(saveLocalTerminal()).toBeUndefined();
  });

  // Restore runs while recovering from a dropped link. If it could throw it
  // would turn a recoverable blink into a crash, so every branch is guarded.
  it('is a safe no-op with no snapshot and no TTY — recovery must never throw', () => {
    expect(() => restoreLocalTerminal(undefined, { drainStdin: true })).not.toThrow();
    expect(() => restoreLocalTerminal(undefined, { drainStdin: false })).not.toThrow();
    expect(() => restoreLocalTerminal('garbage-not-a-stty-string', { drainStdin: true })).not.toThrow();
  });

  // Review finding on PR #3006: resetting termios/DEC modes is idempotent, but draining stdin is
  // destructive (it eats legitimate type-ahead after a clean session), so it is opt-in and only
  // for abnormal exits that cause the answerback storm.
  it('only drains stdin when asked — the destructive step is opt-in', () => {
    const reads: unknown[] = [];
    const stdin = process.stdin as unknown as { isTTY?: boolean; read?: () => unknown };
    const realIsTTY = stdin.isTTY;
    const realRead = stdin.read;
    // Present a real readable-shaped stdin with a byte queued, then assert the
    // drain is what consumes it — no mocking of the function under test.
    stdin.isTTY = true;
    let queued: unknown[] = ['typed-ahead'];
    stdin.read = () => { const v = queued.shift() ?? null; reads.push(v); return v; };
    try {
      restoreLocalTerminal(undefined, { drainStdin: false });
      expect(queued).toEqual(['typed-ahead']); // a clean exit leaves type-ahead alone

      queued = ['typed-ahead'];
      restoreLocalTerminal(undefined, { drainStdin: true });
      expect(queued).toEqual([]); // an abnormal exit clears the answerback burst
    } finally {
      stdin.isTTY = realIsTTY;
      stdin.read = realRead;
    }
  });
});
