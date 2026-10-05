/** Tests for the interactive auto-reconnect policy: the pure state machine `reconnectStep` +
 * `backoffMs` run with real inputs, and `reconnectInteractiveSession` runs through it with only
 * the SSH re-attach and the wall-clock wait supplied, since CI has no SSH. */
import { describe, expect, test } from 'vitest';
import { execFileSync } from 'node:child_process';
import type { Host } from './types.js';
import {
  reconnectStep,
  refillsBudget,
  backoffMs,
  reconnectNotice,
  exhaustedNotice,
  unstableNotice,
  remoteExitNotice,
  connectionEndedNotice,
  connectionStartedNotice,
  startConnectionTarget,
  afterInteractiveRemoteExit,
  reconnectInteractiveSession,
  reattachRemoteCommand,
  pickReconnectTarget,
  recoveryHint,
  type ReconnectTarget,
  wrapRemoteExitCode,
  initialReconnectState,
  SSH_CONN_FAILURE,
  RECONNECT_WINDOW_MS,
  formatDuration,
  interruptedNotice,
  type ReconnectState,
  MIN_HOLD_MS,
  REMOTE_EXIT_255_REMAPPED,
  type ReconnectOutcome,
} from './reconnect.js';

const HOST = { name: 'zion' } as Host;
const SID = '94c75686-145c-465d-b3f8-a9c0d3a0387c';
/** The ordinary case: an id known before the drop (Claude's forced id, or a resume). */
const SESSION_TARGET: ReconnectTarget = { kind: 'session', id: SID };
/** A launcher-minted AGENT_LAUNCH_ID — what every non-Claude harness reconnects by. */
const LAUNCH_ID = 'dcf80180-4679-46ad-ba2f-8ebb83f5b2af';

/** Reconnected, held the pane, then dropped — the one shape that refills the budget. */
const heldThenDropped = (): ReconnectOutcome => ({ code: SSH_CONN_FAILURE, connected: true, heldMs: MIN_HOLD_MS });
/** Never reached the host (the preflight probe failed): a sustained outage. */
const unreachable = (): ReconnectOutcome => ({ code: SSH_CONN_FAILURE, connected: false, heldMs: 0 });
/** Reached the host, then the attach died straight back — the flapping link / dead-at-
 *  TTY-negotiation case that used to refill the budget forever (agents-cli#1884). */
const flapped = (): ReconnectOutcome => ({ code: SSH_CONN_FAILURE, connected: true, heldMs: MIN_HOLD_MS - 1 });

describe('reconnectStep — the pure retry decision', () => {
  /** A fresh streak. `unproductiveMs` is what the window bounds; `attempt` only shapes backoff. */
  const st = (attempt: number, unproductiveMs = 0): ReconnectState => ({ attempt, unproductiveMs });

  test('a clean detach (exit 0) stops and surfaces 0 — never reconnects', () => {
    expect(reconnectStep(initialReconnectState(), { code: 0, connected: true, heldMs: MIN_HOLD_MS })).toEqual({
      action: 'stop',
      code: 0,
    });
  });

  test('a real remote exit code (agent ended, non-255) stops and surfaces it', () => {
    expect(reconnectStep(st(0), { code: 1, connected: true, heldMs: MIN_HOLD_MS })).toEqual({ action: 'stop', code: 1 });
    expect(reconnectStep(st(3), { code: 130, connected: false, heldMs: 0 })).toEqual({ action: 'stop', code: 130 });
  });

  test('a 255 drop from an attempt that reconnected AND HELD retries with backoff and resets the streak', () => {
    expect(reconnectStep(st(0), heldThenDropped())).toMatchObject({ action: 'retry', waitMs: 2_000, state: { attempt: 1, unproductiveMs: 2_000 } });
    // Deep into a streak, a productive attach still puts us back at the start.
    expect(reconnectStep(st(9, 10 * 60_000), heldThenDropped())).toMatchObject({ action: 'retry', waitMs: 2_000, state: { attempt: 1, unproductiveMs: 2_000 } });
  });

  test('a 255 from a FAILED connect accumulates both the attempt and the elapsed streak', () => {
    expect(reconnectStep(st(0), unreachable())).toMatchObject({ action: 'retry', waitMs: 2_000, state: { attempt: 1, unproductiveMs: 2_000 } });
    expect(reconnectStep(st(1, 2_000), unreachable())).toMatchObject({ action: 'retry', waitMs: 4_000, state: { attempt: 2, unproductiveMs: 6_000 } });
    expect(reconnectStep(st(3, 14_000), unreachable())).toMatchObject({ action: 'retry', waitMs: 16_000, state: { attempt: 4, unproductiveMs: 30_000 } });
  });

  test('the time each failed attach itself burned counts against the window, not just the waits', () => {
    // A failed connect costs up to ConnectTimeout (10s) per attempt. Ignoring it
    // would stretch a "15 minute" window well past fifteen real minutes.
    const slowFail: ReconnectOutcome = { code: SSH_CONN_FAILURE, connected: true, heldMs: 5_000 };
    expect(reconnectStep(st(1, 10_000), slowFail)).toMatchObject({ state: { unproductiveMs: 10_000 + 5_000 + 4_000 } });
  });

  // RUSH-3125: this used to be MAX_ATTEMPTS = 6 over a 2/4/8/16/30/30 backoff —
  // it gave up after ~90 seconds, shorter than a lid close, a Wi-Fi handoff, or
  // a Tailscale re-auth. The bound is now wall-clock.
  test('the streak is bounded by RECONNECT_WINDOW_MS, and that window outlasts a lid close', () => {
    expect(reconnectStep(st(40, RECONNECT_WINDOW_MS), unreachable())).toEqual({ action: 'stop', code: SSH_CONN_FAILURE });
    // Just inside the window still retries…
    expect(reconnectStep(st(40, RECONNECT_WINDOW_MS - 1), unreachable())).toMatchObject({ action: 'retry' });
    // …and the window is minutes, not the old ~90 seconds.
    expect(RECONNECT_WINDOW_MS).toBeGreaterThan(10 * 60_000);
  });

  test('a retry reports how much of the window is left, so the notice can count down', () => {
    const d = reconnectStep(st(0), unreachable());
    expect(d).toMatchObject({ action: 'retry' });
    if (d.action !== 'retry') throw new Error('unreachable');
    expect(d.remainingMs).toBe(RECONNECT_WINDOW_MS - 2_000);
    expect(d.remainingMs + d.state.unproductiveMs).toBe(RECONNECT_WINDOW_MS);
  });

  test('a genuine reconnection refills even past the window — an all-day blinking session never gets stranded', () => {
    // The property the file header insists on: the window bounds a STREAK, not a
    // session. A hung/failed connect must NOT look like a live one.
    expect(reconnectStep(st(40, RECONNECT_WINDOW_MS * 3), heldThenDropped())).toMatchObject({
      action: 'retry',
      waitMs: backoffMs(0),
      state: { attempt: 1, unproductiveMs: 2_000 },
    });
  });

  test('agents-cli#1884: an attach that CONNECTED but died inside MIN_HOLD_MS does NOT refill', () => {
    // The bug: `connected` was set by the preflight probe alone, so a link that
    // reconnected and dropped the user straight back out refilled forever.
    expect(refillsBudget(flapped())).toBe(false);
    expect(reconnectStep(st(1, 2_000), flapped())).toMatchObject({ action: 'retry', waitMs: 4_000, state: { attempt: 2 } });
    expect(reconnectStep(st(40, RECONNECT_WINDOW_MS), flapped())).toEqual({ action: 'stop', code: SSH_CONN_FAILURE });
  });

  test('MIN_HOLD_MS is the boundary: exactly at the floor refills, one ms under does not', () => {
    expect(refillsBudget({ code: SSH_CONN_FAILURE, connected: true, heldMs: MIN_HOLD_MS })).toBe(true);
    expect(refillsBudget({ code: SSH_CONN_FAILURE, connected: true, heldMs: MIN_HOLD_MS - 1 })).toBe(false);
    // A long hold on an attempt that never connected is not reachable in production
    // (heldMs is 0 there) and must not refill on the duration alone either.
    expect(refillsBudget({ code: SSH_CONN_FAILURE, connected: false, heldMs: MIN_HOLD_MS * 10 })).toBe(false);
  });
});

describe('formatDuration — a waiting human reads this, not a machine', () => {
  test('minutes and seconds, zero-padded', () => {
    expect(formatDuration(15 * 60_000)).toBe('15m00s');
    expect(formatDuration(14 * 60_000 + 51_000)).toBe('14m51s');
    expect(formatDuration(51_000)).toBe('51s');
    expect(formatDuration(0)).toBe('0s');
    expect(formatDuration(-5)).toBe('0s');
  });
});

describe('backoffMs — capped exponential', () => {
  test('doubles then caps at 30s', () => {
    expect(backoffMs(0)).toBe(2_000);
    expect(backoffMs(1)).toBe(4_000);
    expect(backoffMs(2)).toBe(8_000);
    expect(backoffMs(3)).toBe(16_000);
    expect(backoffMs(4)).toBe(30_000); // 32s clamped
    expect(backoffMs(10)).toBe(30_000);
  });
});

describe('wrapRemoteExitCode — the root-cause fix, exercised with a REAL shell (no mock)', () => {
  // These run the returned string through a real `bash`, reproducing the "attempt 1/6 forever" bug:
  // a remote-origin 255 was indistinguishable from a real ssh drop. Skipped on Windows, where
  // interactive host dispatch is already POSIX-only (dispatch.ts).
  const runsBash = process.platform !== 'win32';

  // `(exit N)` runs in a forked subshell and returns status N to the wrapper, unlike a bare `exit
  // N`, which would end the wrapper before its remap logic runs; this mirrors a real subprocess
  // returning exit code N.
  function realBashExitCode(cmd: string): number | undefined {
    try {
      execFileSync('bash', ['-c', wrapRemoteExitCode(cmd)]);
      return 0;
    } catch (e) {
      return (e as { status?: number }).status;
    }
  }

  test.skipIf(!runsBash)('exit codes other than 255 pass through unchanged (0, 1, 42)', () => {
    for (const code of [0, 1, 42]) {
      expect(realBashExitCode(`(exit ${code})`)).toBe(code);
    }
  });

  test.skipIf(!runsBash)('a 255 exit is remapped to REMOTE_EXIT_255_REMAPPED (254), verified via real bash exit status — this is the exact mechanism that let the "attempt 1/6 forever" bug loop', () => {
    // Before the fix, a remote command exiting 255 for its own reasons rode back through
    // `sshStream` as SSH_CONN_FAILURE, indistinguishable from an ssh drop, and kept refilling the
    // reconnect retry budget forever.
    expect(realBashExitCode('(exit 255)')).toBe(REMOTE_EXIT_255_REMAPPED);
    expect(REMOTE_EXIT_255_REMAPPED).not.toBe(SSH_CONN_FAILURE);
  });

  test('wraps in bash -lc, matching buildRemoteAgentsInvocation\'s pattern for every other remote dispatch', () => {
    expect(wrapRemoteExitCode('true')).toBe(`bash -lc 'true; rc=$?; [ "$rc" = "255" ] && rc=254; exit "$rc"'`);
  });
});

describe('reattachRemoteCommand — the real remote invocation, exercised through a REAL shell with an argv-echoing "agents" shim (no mock)', () => {
  const runsBash = process.platform !== 'win32';
  // Mirrors remote-cmd.test.ts's shim: `agents` is a bash function that echoes its argv or
  // `return`s a chosen status (not `exit`, which would kill the script), like a real subprocess
  // handing back an exit code.
  const argvShim = `agents() { for a in "$@"; do printf '%s\\n' "$a"; done; }; export -f agents; `;
  const exit255Shim = `agents() { return 255; }; export -f agents; `;

  // A session id is never attacker-controlled in production, but this proves the composition is
  // safe anyway: shellQuote on the id and the whole wrapper, with nested POSIX `'\''` escaping,
  // must still deliver the real command.
  const INJECTION_SID = "a'b; touch /tmp/PWNED-reconnect-test; #";

  test.skipIf(!runsBash)('argv round-trips through bash -lc even for a session id needing quoting — no injection', () => {
    const res = execFileSync('bash', ['-c', argvShim + reattachRemoteCommand({ kind: 'session', id: INJECTION_SID })], { encoding: 'utf8' });
    // No --attach-only: the peer's focus attaches a live pane or RESUMES a dead
    // one (RUSH-2085), so a reattach after the pane died never dead-ends.
    expect(res.trimEnd().split('\n')).toEqual(['sessions', 'focus', INJECTION_SID, '--local', '--reconnect-reattach']);
  });

  test.skipIf(!runsBash)('a 255 from the wrapped `agents` command comes back as REMOTE_EXIT_255_REMAPPED (254) — exercised end-to-end through reattachRemoteCommand, not just the wrapRemoteExitCode primitive', () => {
    // Before the fix, refuseFallback's remote branch (or a nested remote-tmux hop) exiting 255 for
    // its own reasons rode back as SSH_CONN_FAILURE, indistinguishable from an ssh drop, and
    // refilled the retry budget forever.
    let status: number | undefined;
    try {
      execFileSync('bash', ['-c', exit255Shim + reattachRemoteCommand(SESSION_TARGET)]);
      status = 0;
    } catch (e) {
      status = (e as { status?: number }).status;
    }
    expect(status).toBe(REMOTE_EXIT_255_REMAPPED);
    expect(REMOTE_EXIT_255_REMAPPED).not.toBe(SSH_CONN_FAILURE);
    expect(
      reconnectStep(initialReconnectState(), { code: REMOTE_EXIT_255_REMAPPED, connected: true, heldMs: MIN_HOLD_MS }),
    ).toEqual({
      action: 'stop',
      code: REMOTE_EXIT_255_REMAPPED,
    });
  });

  test("the plain string, no shell needed: wraps in bash -lc around the peer's own recovery verb (attach-else-resume, no --attach-only)", () => {
    expect(reattachRemoteCommand(SESSION_TARGET)).toBe(
      `bash -lc 'agents sessions focus ${SID} --local --reconnect-reattach; rc=$?; [ "$rc" = "255" ] && rc=254; exit "$rc"'`,
    );
  });
});

describe('pickReconnectTarget — what we go back for, and why a launch id is the fallback (RUSH-3125)', () => {
  const RESOLVED = '11111111-2222-3333-4444-555555555555';
  const RESUME = '99999999-8888-7777-6666-555555555555';

  test('a forced session id wins for a named harness — Claude mints one before the connection exists', () => {
    expect(pickReconnectTarget({ agent: 'claude', sessionId: SID, resolvedId: RESOLVED, launchId: LAUNCH_ID }))
      .toEqual({ kind: 'session', id: SID });
  });

  test('`run auto` prefers the id read back from the peer — the launcher\'s --session-id names a harness the remote may not have picked', () => {
    expect(pickReconnectTarget({ agent: 'auto', sessionId: SID, resolvedId: RESOLVED, launchId: LAUNCH_ID }))
      .toEqual({ kind: 'session', id: RESOLVED });
  });

  test('a resumed run falls back to the session it was continuing', () => {
    expect(pickReconnectTarget({ agent: 'codex', resumeId: RESUME, launchId: LAUNCH_ID }))
      .toEqual({ kind: 'session', id: RESUME });
  });

  // Every id above is forced by the launcher or read back from the peer after the stream returned,
  // over the link that just dropped. On a real outage that read fails, so a Grok/Codex/Kimi tab had
  // no id and skipped reconnect while a Claude tab retried.
  test('a non-Claude harness whose id could not be read back still reconnects, by launch id', () => {
    expect(pickReconnectTarget({ agent: 'grok', launchId: LAUNCH_ID }))
      .toEqual({ kind: 'launch', id: LAUNCH_ID });
  });

  test('only a run with no handle at all is unreconnectable', () => {
    expect(pickReconnectTarget({ agent: 'grok' })).toBeUndefined();
  });
});

describe('reattachRemoteCommand — a launch target resolves on the PEER, needing no network from this side', () => {
  const runsBash = process.platform !== 'win32';
  const argvShim = `agents() { for a in "$@"; do printf '%s\\n' "$a"; done; }; export -f agents; `;

  test.skipIf(!runsBash)('sends --launch-id, so the box holding the hook records does the lookup', () => {
    const cmd = reattachRemoteCommand({ kind: 'launch', id: LAUNCH_ID });
    const res = execFileSync('bash', ['-c', argvShim + cmd], { encoding: 'utf8' });
    expect(res.trimEnd().split('\n')).toEqual(['sessions', 'focus', '--launch-id', LAUNCH_ID, '--local', '--reconnect-reattach']);
  });

  test.skipIf(!runsBash)('a launch id needing shell quoting still round-trips intact — no injection', () => {
    const nasty = "a'b; touch /tmp/PWNED-launchid-test; #";
    const res = execFileSync('bash', ['-c', argvShim + reattachRemoteCommand({ kind: 'launch', id: nasty })], { encoding: 'utf8' });
    expect(res.trimEnd().split('\n')).toEqual(['sessions', 'focus', '--launch-id', nasty, '--local', '--reconnect-reattach']);
  });
});

describe('recoveryHint — the command printed when the loop gives up must exist (F7)', () => {
  test('a session target names the live resume verb, never the deprecated `agents reconnect`', () => {
    const hint = recoveryHint(SESSION_TARGET, 'zion');
    expect(hint).toContain(`agents sessions resume ${SID}`);
    expect(hint).not.toContain('agents reconnect');
  });

  test('a session target labels the full id on its own line, not only inside the command (RUSH-3227)', () => {
    const hint = recoveryHint(SESSION_TARGET, 'zion');
    expect(hint).toContain(`Session ${SID}`);
    expect(hint).toContain('Resume:');
  });

  test("a launch target points at the peer's own resolver — no local verb takes a launch id", () => {
    const hint = recoveryHint({ kind: 'launch', id: LAUNCH_ID }, 'yosemite-s0');
    expect(hint).toContain('agents ssh yosemite-s0');
    expect(hint).toContain(`--launch-id ${LAUNCH_ID}`);
    expect(hint).toContain(`Launch ${LAUNCH_ID}`);
    expect(hint).not.toContain('agents reconnect');
  });
});

describe('connectionEndedNotice — the id left on the shell after SSH closes (RUSH-3227)', () => {
  test('a clean close names the host, the full session id, and the resume command', () => {
    const s = connectionEndedNotice(SESSION_TARGET, 'yosemite-m2');
    expect(s).toContain('Connection to yosemite-m2 closed.');
    expect(s).toContain(`Session ${SID}`);
    expect(s).toContain(`agents sessions resume ${SID}`);
    expect(s).not.toContain('dropped');
  });

  test('a drop (exit 255 that is not auto-reconnecting) says dropped, not closed', () => {
    const s = connectionEndedNotice(SESSION_TARGET, 'yosemite-m2', { dropped: true });
    expect(s).toContain('Connection to yosemite-m2 dropped.');
    expect(s).toContain(`Session ${SID}`);
  });

  test('a launch target still points at the peer resolver', () => {
    const s = connectionEndedNotice({ kind: 'launch', id: LAUNCH_ID }, 'yosemite-s0');
    expect(s).toContain('Connection to yosemite-s0 closed.');
    expect(s).toContain(`Launch ${LAUNCH_ID}`);
    expect(s).toContain('--launch-id');
  });
});

describe('connectionStartedNotice — id while the connection exists (RUSH-3227 B)', () => {
  test('a known session id names the host, the full id, and resume-later', () => {
    const s = connectionStartedNotice(SESSION_TARGET, 'yosemite-m2');
    expect(s).toContain(`Session ${SID} on yosemite-m2`);
    expect(s).toContain(`Resume later:  agents sessions resume ${SID}`);
  });

  test('a launch id is not a resume handle — print nothing', () => {
    expect(connectionStartedNotice({ kind: 'launch', id: LAUNCH_ID }, 'yosemite-m2')).toBeUndefined();
  });

  test('resume uses resumeId when hostSessionId is empty (resolveHostSessionId returns undefined)', () => {
    expect(startConnectionTarget({ agent: 'claude', resumeId: SID })).toEqual({ kind: 'session', id: SID });
  });

  test('a fresh Claude id wins', () => {
    expect(startConnectionTarget({ agent: 'claude', hostSessionId: SID })).toEqual({ kind: 'session', id: SID });
  });

  test('run auto never prints — its forwarded --session-id is only real on a claude pick', () => {
    expect(startConnectionTarget({ agent: 'auto', hostSessionId: SID, resumeId: SID })).toBeUndefined();
  });

  test('a non-Claude fresh launch with no id prints nothing', () => {
    expect(startConnectionTarget({ agent: 'grok' })).toBeUndefined();
  });
});

describe('afterInteractiveRemoteExit — reconnect vs notice (RUSH-3227)', () => {
  const host = 'yosemite-m2';

  test('tmux-hosted 255 reconnects and prints nothing — the user is not at a shell yet', () => {
    expect(afterInteractiveRemoteExit({
      target: SESSION_TARGET, host, exitCode: SSH_CONN_FAILURE, willReconnect: true,
    })).toEqual({ reconnect: true, notice: undefined });
  });

  test('--raw 255 does NOT reconnect but still prints the dropped notice (EXEC-55)', () => {
    const next = afterInteractiveRemoteExit({
      target: SESSION_TARGET, host, exitCode: SSH_CONN_FAILURE, willReconnect: false,
    });
    expect(next.reconnect).toBe(false);
    expect(next.notice).toContain('Connection to yosemite-m2 dropped.');
    expect(next.notice).toContain(`Session ${SID}`);
  });

  test('a clean detach (0) never reconnects and prints closed + the full id', () => {
    const next = afterInteractiveRemoteExit({
      target: SESSION_TARGET, host, exitCode: 0, willReconnect: false,
    });
    expect(next.reconnect).toBe(false);
    expect(next.notice).toContain('Connection to yosemite-m2 closed.');
    expect(next.notice).toContain(`Session ${SID}`);
  });

  test('no target (hookless harness) prints nothing and does not reconnect', () => {
    expect(afterInteractiveRemoteExit({
      host, exitCode: 0, willReconnect: false,
    })).toEqual({ reconnect: false, notice: undefined });
  });
});

describe('remoteExitNotice — human readable', () => {
  test('names the host and short id, and reads as "not a network drop"', () => {
    const s = remoteExitNotice(SESSION_TARGET, 'zion');
    expect(s).toContain('zion');
    expect(s).toContain('94c75686');
    expect(s).toContain('not a network drop');
  });
});

describe('notices — human readable', () => {
  test('reconnect notice names the host, the short id, the wait, and the attempt', () => {
    const s = reconnectNotice(SESSION_TARGET, 'zion', 2, 4_000, 14 * 60_000 + 51_000);
    expect(s).toContain('zion');
    expect(s).toContain('94c75686');
    expect(s).toContain('in 4s');
    expect(s).toContain('attempt 2');
    // With a wall-clock budget the attempt number no longer says when this stops,
    // so the notice counts the window down and advertises the safe way out.
    expect(s).toContain('14m51s left');
    expect(s).toContain('Ctrl-C to stop');
    expect(s).toContain('reconnecting to 94c75686');
    expect(s).not.toContain('still running there');
  });

  test('exhausted notice hands back the manual reconnect command', () => {
    // F7: this used to name `agents reconnect`, which is deprecated + hidden —
    // stale advice printed at the exact moment the user needs a command that works.
    expect(exhaustedNotice(SESSION_TARGET, 'zion')).toContain(`agents sessions resume ${SID}`);
    expect(exhaustedNotice(SESSION_TARGET, 'zion')).not.toContain('agents reconnect');
  });

  test('unstable notice says the link kept dropping, not that it could not reconnect', () => {
    const s = unstableNotice(SESSION_TARGET, 'zion');
    expect(s).toContain('zion');
    expect(s).toContain('kept dropping again within');
    expect(s).toContain(formatDuration(RECONNECT_WINDOW_MS));
    expect(s).toContain(`agents sessions resume ${SID}`);
    expect(s).not.toContain('agents reconnect');
    // The distinction that makes it worth a second notice: it DID reconnect. It
    // also claims no count of successful reconnections — the budget can be spent
    // by unreachable attempts plus one that reconnected and dropped straight out.
    expect(s).not.toContain("Couldn't reconnect");
    expect(s).not.toMatch(/Reconnected to \w+ \d+ times/);
  });
});

describe('reconnectInteractiveSession — the loop over the real state machine', () => {
  const noWait = async (): Promise<'elapsed'> => 'elapsed';

  test('reattaches after a drop, then returns 0 when the user detaches cleanly', async () => {
    const seq: ReconnectOutcome[] = [{ code: 0, connected: true, heldMs: MIN_HOLD_MS }]; // reattach → clean detach
    const writes: string[] = [];
    const rc = await reconnectInteractiveSession({
      host: HOST,
      target: SESSION_TARGET,
      initialExit: SSH_CONN_FAILURE,
      reattach: () => seq.shift()!,
      wait: noWait,
      write: (s) => writes.push(s),
    });
    expect(rc).toBe(0);
    expect(writes.some((w) => w.includes('attempt 1'))).toBe(true);
    expect(writes.some((w) => w.includes("Couldn't reconnect"))).toBe(false);
    // Clean detach after reattach still leaves the session id on the shell.
    expect(writes.some((w) => w.includes(`Session ${SID}`))).toBe(true);
    expect(writes.some((w) => w.includes('Connection to zion closed.'))).toBe(true);
  });

  test('a SUSTAINED outage (every reattach fails to connect) gives up after MAX_ATTEMPTS with the manual hint', async () => {
    // This is the boundary prix flagged: failed connects (connected:false) must NOT
    // refill the budget, so the loop terminates instead of retrying forever.
    let calls = 0;
    const writes: string[] = [];
    const rc = await reconnectInteractiveSession({
      host: HOST,
      target: SESSION_TARGET,
      initialExit: SSH_CONN_FAILURE,
      reattach: () => {
        calls++;
        return unreachable(); // host unreachable every time
      },
      wait: noWait,
      write: (s) => writes.push(s),
    });
    expect(rc).toBe(SSH_CONN_FAILURE);
    // Bounded by the wall-clock window, not a fixed count: with a 2/4/8/16/30…
    // backoff a 15-minute streak is ~33 attempts. The property under test is that
    // it TERMINATES and does so having actually spent the window.
    expect(calls).toBeGreaterThan(6); // the old ~90s budget would have stopped here
    expect(calls).toBeLessThan(100);
    expect(writes.some((w) => w.includes("Couldn't reconnect"))).toBe(true);
    expect(writes.some((w) => w.includes(`agents sessions resume ${SID}`))).toBe(true);
  });

  test('agents-cli#1884: a link that reconnects and drops straight back out ALSO terminates', async () => {
    // The reported spin. Every reattach reaches the host (so the old `connected`
    // check refilled the budget) but the attach dies inside MIN_HOLD_MS, so the
    // loop printed "attempt 1/6" forever. It must now spend the budget and stop.
    let calls = 0;
    const writes: string[] = [];
    const rc = await reconnectInteractiveSession({
      host: HOST,
      target: SESSION_TARGET,
      initialExit: SSH_CONN_FAILURE,
      reattach: () => {
        calls++;
        return flapped();
      },
      wait: noWait,
      write: (s) => writes.push(s),
    });
    expect(rc).toBe(SSH_CONN_FAILURE);
    expect(calls).toBeGreaterThan(6); // bounded — this looped forever before the fix
    expect(calls).toBeLessThan(100);
    // The attempt counter actually advances now instead of resetting to 1 each cycle.
    expect(writes.some((w) => w.includes('attempt 7'))).toBe(true);
    // And the reason is reported truthfully: it reconnected, it could not stay.
    expect(writes.some((w) => w.includes('kept dropping again within'))).toBe(true);
    expect(writes.some((w) => w.includes("Couldn't reconnect"))).toBe(false);
    expect(writes.some((w) => w.includes(`agents sessions resume ${SID}`))).toBe(true);
  });

  test('a mixed outage — unreachable attempts, then one that reconnects and drops out — reports the drop, not "couldn\'t reconnect"', async () => {
    // The budget is spent by unreachable attempts, but the attempt that spends it did reach the
    // host, so the notice must say so and not claim reconnections it never made. Mixed case: an
    // unreachable start, then the host returns but every attach drops immediately.
    let calls = 0;
    const writes: string[] = [];
    const rc = await reconnectInteractiveSession({
      host: HOST,
      target: SESSION_TARGET,
      initialExit: SSH_CONN_FAILURE,
      reattach: () => (++calls <= 10 ? unreachable() : flapped()),
      wait: noWait,
      write: (s) => writes.push(s),
    });
    expect(rc).toBe(SSH_CONN_FAILURE);
    expect(calls).toBeGreaterThan(10); // it got past the unreachable stretch
    expect(writes.some((w) => w.includes('kept dropping again within'))).toBe(true);
    expect(writes.some((w) => w.includes("Couldn't reconnect"))).toBe(false);
    expect(writes.some((w) => /Reconnected to \w+ \d+ times/.test(w))).toBe(false);
  });

  test('a mid-run second drop after a genuine reconnection keeps reconnecting', async () => {
    // drop → reattach connects and holds, then drops again → reattach → clean exit.
    const seq: ReconnectOutcome[] = [
      heldThenDropped(), // reconnected, held, then dropped
      { code: 0, connected: true, heldMs: MIN_HOLD_MS }, // reconnected, clean detach
    ];
    const rc = await reconnectInteractiveSession({
      host: HOST,
      target: SESSION_TARGET,
      initialExit: SSH_CONN_FAILURE,
      reattach: () => seq.shift()!,
      wait: noWait,
      write: () => {},
    });
    expect(rc).toBe(0);
  });

  test('a few failed connects then a successful reconnection resets the budget', async () => {
    // 3 unreachable attempts, then a connect that holds and cleanly exits — the
    // failed attempts alone are under MAX_ATTEMPTS, and the connect refills anyway.
    const seq: ReconnectOutcome[] = [
      unreachable(),
      unreachable(),
      unreachable(),
      { code: 0, connected: true, heldMs: MIN_HOLD_MS },
    ];
    const rc = await reconnectInteractiveSession({
      host: HOST,
      target: SESSION_TARGET,
      initialExit: SSH_CONN_FAILURE,
      reattach: () => seq.shift()!,
      wait: noWait,
      write: () => {},
    });
    expect(rc).toBe(0);
  });

  // RUSH-3125: Ctrl-C during the backoff hit node's default SIGINT handler and killed the process
  // mid-notice, dropping the user at a bare shell with no hint the agent was still alive on the
  // peer, the dead-end reconnect exists to prevent.
  test('Ctrl-C during the wait stops the loop cleanly and says where the agent is', async () => {
    let calls = 0;
    const writes: string[] = [];
    const rc = await reconnectInteractiveSession({
      host: HOST,
      target: SESSION_TARGET,
      initialExit: SSH_CONN_FAILURE,
      reattach: () => { calls++; return unreachable(); },
      wait: async () => 'interrupted',
      write: (s) => writes.push(s),
    });
    expect(rc).toBe(130); // 128 + SIGINT, not a crash and not a success
    expect(calls).toBe(0); // interrupted during the FIRST wait — never reattached
    const notice = writes.join('');
    expect(notice).toContain('Stopped reconnecting');
    expect(notice).toContain('on zion. Recover it when the link is stable');
    expect(notice).not.toContain('still running');
    expect(notice).toContain(`agents sessions resume ${SID}`);
    // It must not read as a failure: nothing was lost.
    expect(notice).not.toContain("Couldn't reconnect");
    expect(notice).not.toContain('Gave up');
  });

  test('interruptedNotice names the agent, the host, and the way back', () => {
    const s = interruptedNotice(SESSION_TARGET, 'yosemite-s0');
    expect(s).toContain('94c75686');
    expect(s).toContain('yosemite-s0');
    expect(s).toContain(`agents sessions resume ${SID}`);
  });

  test('the all-day-blinking session the feature exists for is still unbounded', async () => {
    // The reason the fix is a hold FLOOR and not a flat total-attempt ceiling: a
    // link that drops repeatedly but puts the user back into a working pane each
    // time must keep reconnecting, well past any single window's worth of drops.
    const blinks = 40;
    let calls = 0;
    const rc = await reconnectInteractiveSession({
      host: HOST,
      target: SESSION_TARGET,
      initialExit: SSH_CONN_FAILURE,
      reattach: () => {
        calls++;
        return calls <= blinks ? heldThenDropped() : { code: 0, connected: true, heldMs: MIN_HOLD_MS };
      },
      wait: noWait,
      write: () => {},
    });
    expect(rc).toBe(0);
    expect(calls).toBe(blinks + 1);
  });
});
