import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { ActiveSession } from '../session/active.js';
import type { SessionProvenance } from '../session/provenance.js';
import type { InjectTarget } from '../terminal/index.js';
import {
  runWatchdogTick,
  type SmartDecider,
  type WatchdogTickOptions,
} from './runner.js';
import {
  buildRotateLaunchCommand,
  buildRotateReplayText,
  classifyTailForRotate,
  defaultTuiLiveFor,
  exitSequenceFor,
  isCorrelatedRelaunch,
  parseRotateResetMs,
  readRotateState,
  writeRotateState,
  DEFAULT_ROTATE_EXIT_SEQUENCE,
  DEFAULT_ROTATE_FAILED_COOLDOWN_MS,
  DEFAULT_ROTATE_SKIP_COOLDOWN_MS,
  ROTATE_EXIT_SEQUENCES,
  type RotateState,
} from './rotate.js';

const NOW = 1_700_000_000_000;
const STALE_AGO = NOW - 6 * 60_000;

const LIMIT_TAIL = [
  '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"You\'ve hit your weekly limit · resets 7am"}]}}',
];
const LIMIT_TAIL_ISO = [
  '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"You\'ve hit your weekly limit · resets 2026-08-10T14:00:00.000Z"}]}}',
];
const ISO_RESET_MS = Date.parse('2026-08-10T14:00:00.000Z');

function tmuxSession(over: Partial<ActiveSession> = {}): ActiveSession {
  const provenance: SessionProvenance = {
    host: 'zion',
    transport: 'local',
    mux: { kind: 'tmux', pane: '%3', socket: '/tmp/s' },
    reply: { rail: 'tmux', target: '%3', socket: '/tmp/s' },
  };
  return {
    context: 'terminal',
    kind: 'claude',
    host: 'iterm',
    sessionId: 'sess-tmux',
    status: 'idle',
    startedAtMs: STALE_AGO,
    provenance,
    ...over,
  };
}

function ghosttySession(): ActiveSession {
  return {
    context: 'terminal',
    kind: 'claude',
    host: 'ghostty',
    sessionId: 'sess-ghostty',
    status: 'idle',
    startedAtMs: STALE_AGO,
    provenance: { host: 'zion', transport: 'local', reply: null },
  };
}

let stateDir: string;
let logPath: string;
beforeEach(() => {
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'watchdog-rotate-'));
  logPath = path.join(stateDir, 'watchdog.log');
});
afterEach(() => {
  try { fs.rmSync(stateDir, { recursive: true, force: true }); } catch {  }
});

interface InjectCall { target: InjectTarget; text: string; opts: { dryRun?: boolean; enter?: boolean } }

function rig(over: Partial<WatchdogTickOptions> = {}) {
  const calls: InjectCall[] = [];
  let deciderCalled = false;
  const injectFn = async (target: InjectTarget, text: string, opts: { dryRun?: boolean; enter?: boolean }) => {
    calls.push({ target, text, opts });
    return { ok: true as const, confirmed: true as const, backend: target.backend, writes: 1 };
  };
  const smartDecider: SmartDecider = async () => {
    deciderCalled = true;
    return { nudge: false, reason: 'synthetic decider' };
  };
  const run = (extra: Partial<WatchdogTickOptions> = {}) =>
    runWatchdogTick({
      logPath,
      openBlockFor: () => null,
      stateDir,
      nowMs: NOW,
      nudge: true,
      injectDryRun: true,
      rotateKeyDelayMs: 0,
      rotateGate: async () => ({ healthy: true, detail: 'picked claude' }),
      newSessionIdFor: () => 'new-sess-1',
      smartDecider,
      injectFn,
      ...over,
      ...extra,
    });
  return { run, calls, wasDeciderCalled: () => deciderCalled };
}

function readLogEvents(): Array<{ kind: string; message: string; terminalId?: string }> {
  try {
    return fs.readFileSync(logPath, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  } catch {
    return [];
  }
}
function readFlags(): Record<string, { reason: string; host?: string; atMs: number }> {
  try { return JSON.parse(fs.readFileSync(path.join(stateDir, 'flags.json'), 'utf8')); } catch { return {}; }
}
function readNudgeLedger(): Record<string, number> {
  try { return JSON.parse(fs.readFileSync(path.join(stateDir, 'nudges.json'), 'utf8')); } catch { return {}; }
}
function readSkipLedger(): Record<string, number> {
  try { return JSON.parse(fs.readFileSync(path.join(stateDir, 'rotate-skips.json'), 'utf8')); } catch { return {}; }
}


describe('classifyTailForRotate', () => {
  it('detects claude\'s weekly-limit form and parses the time-of-day reset', () => {
    const v = classifyTailForRotate(LIMIT_TAIL, NOW);
    expect(v.kind).toBe('rate_limited');
    expect(v.resetsAtMs).toBeDefined();
    expect(v.resetsAtMs!).toBeGreaterThan(NOW);
  });

  it('detects a session/usage limit and parses an ISO reset exactly', () => {
    const v = classifyTailForRotate(LIMIT_TAIL_ISO, NOW);
    expect(v.kind).toBe('rate_limited');
    expect(v.resetsAtMs).toBe(ISO_RESET_MS);
  });

  it('matches the session-limit and out-of-credits variants', () => {
    expect(classifyTailForRotate(['hit your session limit'], NOW).kind).toBe('rate_limited');
    expect(classifyTailForRotate(['usage limit has been reached'], NOW).kind).toBe('rate_limited');
    expect(classifyTailForRotate(['rate limit exceeded'], NOW).kind).toBe('rate_limited');
    expect(classifyTailForRotate(['out of extra usage'], NOW).kind).toBe('rate_limited');
  });

  it('returns none for a normal tail (an agent merely DISCUSSING limits is not rotated)', () => {
    expect(classifyTailForRotate(['{"type":"assistant","message":{"content":"the config has limits on size"}}'], NOW).kind).toBe('none');
    expect(classifyTailForRotate([], NOW).kind).toBe('none');
  });
});

describe('parseRotateResetMs', () => {
  it('parses the ISO form with milliseconds + Z (never as local time)', () => {
    expect(parseRotateResetMs('resets 2026-08-10T14:00:00.000Z.', NOW)).toBe(ISO_RESET_MS);
  });
  it('refuses a reset already in the past (caller falls back to the default cooldown)', () => {
    expect(parseRotateResetMs('resets 2020-01-01T00:00:00.000Z', NOW)).toBeUndefined();
  });
  it('parses a zoned time-of-day form', () => {
    const ms = parseRotateResetMs("You've hit your weekly limit · resets 7am (America/Los_Angeles)", NOW);
    expect(ms).toBeDefined();
    expect(ms!).toBeGreaterThan(NOW);
  });
  it('returns undefined when no reset clause exists', () => {
    expect(parseRotateResetMs('usage limit reached', NOW)).toBeUndefined();
  });
});


describe('exitSequenceFor (per-harness table)', () => {
  it('claude: Esc, Ctrl+C, Ctrl+C', () => {
    expect(exitSequenceFor('claude')).toEqual(['\x1b', '\x03', '\x03']);
  });
  it('codex / cursor / opencode: Ctrl+C twice', () => {
    for (const agent of ['codex', 'cursor', 'opencode']) {
      expect(exitSequenceFor(agent)).toEqual(['\x03', '\x03']);
    }
  });
  it('an unknown harness gets the default Ctrl+C pair', () => {
    expect(exitSequenceFor('kimi')).toEqual(DEFAULT_ROTATE_EXIT_SEQUENCE);
    expect(ROTATE_EXIT_SEQUENCES.kimi).toBeUndefined();
  });
});


describe('buildRotateLaunchCommand', () => {
  it('local terminal: run auto + session id, no --device', () => {
    expect(buildRotateLaunchCommand({ sessionId: 'abc' }))
      .toBe('agents run auto --interactive --session-id abc');
  });
  it('remote terminal: single-quotes the device name', () => {
    expect(buildRotateLaunchCommand({ host: 'mac mini', sessionId: 'abc' }))
      .toBe("agents run auto --interactive --device 'mac mini' --session-id abc");
    expect(buildRotateLaunchCommand({ host: "o'brien", sessionId: 'abc' }))
      .toBe("agents run auto --interactive --device 'o'\\''brien' --session-id abc");
  });
});

describe('buildRotateReplayText', () => {
  it('points the new session at the old transcript', () => {
    const text = buildRotateReplayText('old-123');
    expect(text).toContain('Resume previous work by loading session old-123');
    expect(text).toContain('agents sessions old-123');
    expect(text).toContain('continue working');
  });
});


describe('runWatchdogTick — limit tail rotates instead of nudging', () => {
  it('injects the exit sequence + run auto relaunch into the resolved rail; never nudges, never consults the brain', async () => {
    const { run, calls, wasDeciderCalled } = rig({
      sessions: [tmuxSession()],
      tailFor: () => LIMIT_TAIL,
    });
    const result = await run();

    const o = result.outcomes[0];
    expect(o.decision).toBe('rotate');
    expect(o.rotatePhase).toBe('awaiting-tui');
    expect(o.rail).toBe('tmux');
    expect(o.addressable).toBe(true);
    expect(result.counts.rotating).toBe(1);
    expect(wasDeciderCalled()).toBe(false);
    expect(readNudgeLedger()['sess-tmux']).toBeUndefined();
    expect(calls.map((c) => c.text)).toEqual([
      '\x1b', '\x03', '\x03',
      'agents run auto --interactive --session-id new-sess-1',
    ]);
    expect(calls[0].opts.enter).toBe(false);
    expect(calls[3].opts.enter).toBeUndefined();
    expect(calls.every((c) => (c.target as { backend: string }).backend === 'tmux')).toBe(true);
    const state = readRotateState(stateDir, 'sess-tmux');
    expect(state?.phase).toBe('awaiting-tui');
    expect(state?.newSessionId).toBe('new-sess-1');
    expect(state?.deadlineMs).toBe(NOW + 60_000);
    expect(readLogEvents().some((e) => e.kind === 'rotate' && e.message.includes('rotating sess-tmux'))).toBe(true);
  });

  it('a dry tick (no --nudge) reports would-rotate and touches nothing', async () => {
    let gateCalled = false;
    const { run, calls } = rig({
      sessions: [tmuxSession()],
      tailFor: () => LIMIT_TAIL,
      nudge: false,
      rotateGate: async () => { gateCalled = true; return { healthy: true, detail: '' }; },
    });
    const result = await run();
    expect(result.outcomes[0].decision).toBe('rotate');
    expect(result.outcomes[0].reason).toMatch(/dry/i);
    expect(calls).toHaveLength(0);
    expect(gateCalled).toBe(false);
    expect(readRotateState(stateDir, 'sess-tmux')).toBeNull();
  });

  it('handsoff policy: flags the rate-limited session, never rotates', async () => {
    const { run, calls } = rig({
      sessions: [tmuxSession()],
      tailFor: () => LIMIT_TAIL,
      policyFor: () => 'handsoff',
    });
    const result = await run();
    expect(result.outcomes[0].decision).toBe('skip');
    expect(result.outcomes[0].reason).toMatch(/handsoff/i);
    expect(calls).toHaveLength(0);
    expect(readFlags()['sess-tmux'].reason).toMatch(/hands-off/i);
    expect(readRotateState(stateDir, 'sess-tmux')).toBeNull();
  });
});


describe('runWatchdogTick — zero healthy accounts', () => {
  const zeroHealthy = { healthy: false as const, detail: "agents: no healthy harness for 'run auto'" };

  it('logs ONE rotate skip event per cooldown window and leaves the terminal untouched', async () => {
    const { run, calls } = rig({
      sessions: [tmuxSession()],
      tailFor: () => LIMIT_TAIL,
      rotateGate: async () => ({ ...zeroHealthy, resetsAtMs: NOW + 3_600_000 }),
    });
    const first = await run();
    expect(first.outcomes[0].decision).toBe('skip');
    expect(first.outcomes[0].reason).toMatch(/no healthy/i);
    expect(calls).toHaveLength(0);
    expect(readRotateState(stateDir, 'sess-tmux')).toBeNull();
    expect(readSkipLedger()['sess-tmux']).toBe(NOW + 3_600_000);
    const skipsAfterFirst = readLogEvents().filter((e) => e.kind === 'rotate' && e.message.includes('rotate skipped'));
    expect(skipsAfterFirst).toHaveLength(1);

    const second = await run();
    expect(second.outcomes[0].decision).toBe('skip');
    const skipsAfterSecond = readLogEvents().filter((e) => e.kind === 'rotate' && e.message.includes('rotate skipped'));
    expect(skipsAfterSecond).toHaveLength(1);
    expect(calls).toHaveLength(0);
  });

  it('falls back to the parsed tail reset when the gate has none, then the 30m default', async () => {
    const { run } = rig({
      sessions: [tmuxSession()],
      tailFor: () => LIMIT_TAIL_ISO,
      rotateGate: async () => zeroHealthy,
    });
    await run();
    expect(readSkipLedger()['sess-tmux']).toBe(ISO_RESET_MS);

    const { run: run2 } = rig({
      sessions: [tmuxSession({ sessionId: 'sess-b' })],
      tailFor: () => ['usage limit reached'],
      rotateGate: async () => zeroHealthy,
    });
    await run2();
    expect(readSkipLedger()['sess-b']).toBe(NOW + DEFAULT_ROTATE_SKIP_COOLDOWN_MS);
  });
});


describe('runWatchdogTick — rotate state machine', () => {
  it('happy path: begin → (old session drops out) → sweep replays → done', async () => {
    const { run, calls } = rig({
      sessions: [tmuxSession()],
      tailFor: () => LIMIT_TAIL,
    });
    await run();
    expect(calls).toHaveLength(4);

    const result2 = await run({ sessions: [], tuiLiveFor: () => true });
    expect(result2.outcomes).toHaveLength(0);
    expect(calls).toHaveLength(5);
    const replay = calls[4];
    expect(replay.text).toContain('Resume previous work by loading session sess-tmux');
    expect(replay.text).toContain('agents sessions sess-tmux');
    expect((replay.target as { backend: string }).backend).toBe('tmux');
    const state = readRotateState(stateDir, 'sess-tmux');
    expect(state?.phase).toBe('done');
    expect(readLogEvents().some((e) => e.kind === 'rotate' && e.message.includes('rotated sess-tmux → new-sess-1'))).toBe(true);
  });

  it('readiness timeout: failed + flagged, nothing typed into the dead shell', async () => {
    const { run, calls } = rig({
      sessions: [tmuxSession()],
      tailFor: () => LIMIT_TAIL,
    });
    await run();
    const callsAfterBegin = calls.length;

    await run({ sessions: [], nowMs: NOW + 61_000, tuiLiveFor: () => false });
    expect(calls).toHaveLength(callsAfterBegin);
    const state = readRotateState(stateDir, 'sess-tmux');
    expect(state?.phase).toBe('failed');
    expect(state?.error).toMatch(/not live within the readiness budget/i);
    const flag = readFlags()['sess-tmux'];
    expect(flag.reason).toMatch(/rotate failed/i);
    expect(flag.reason).toMatch(/bare shell/i);
    expect(flag.reason).toContain('agents run auto');
    expect(flag.reason).toMatch(/no automatic recovery/i);
    expect(readLogEvents().some((e) => e.kind === 'rotate' && e.message.includes('rotate failed: sess-tmux'))).toBe(true);
  });

  it('an in-flight rotate OWNS its session in-loop: a still-listed stalled session advances, never nudges', async () => {
    const { run, calls, wasDeciderCalled } = rig({
      sessions: [tmuxSession()],
      tailFor: () => LIMIT_TAIL,
    });
    await run();
    const result2 = await run({ sessions: [tmuxSession()], tuiLiveFor: () => true });
    const o = result2.outcomes[0];
    expect(o.decision).toBe('rotate');
    expect(o.rotatePhase).toBe('done');
    expect(wasDeciderCalled()).toBe(false);
    expect(calls).toHaveLength(5);
  });

  it('a dry tick never delivers the replay (machine holds, no inject)', async () => {
    const { run, calls } = rig({
      sessions: [tmuxSession()],
      tailFor: () => LIMIT_TAIL,
    });
    await run();
    const callsAfterBegin = calls.length;
    await run({ sessions: [], nudge: false, tuiLiveFor: () => true });
    expect(calls).toHaveLength(callsAfterBegin);
    expect(readRotateState(stateDir, 'sess-tmux')?.phase).toBe('replaying');
  });

  it('un-addressable terminal (ghostty, no tmux): honest flag, no rotate, never a guessed target', async () => {
    const { run, calls } = rig({
      sessions: [ghosttySession()],
      tailFor: () => LIMIT_TAIL,
    });
    const result = await run();
    const o = result.outcomes[0];
    expect(o.decision).toBe('skip');
    expect(o.addressable).toBe(false);
    expect(o.reason).toMatch(/un-addressable/i);
    expect(o.reason).toContain('agents sessions resume sess-gho');
    expect(o.reason).not.toContain('<id>');
    expect(calls).toHaveLength(0);
    expect(readFlags()['sess-ghostty']).toBeDefined();
    expect(readFlags()['sess-ghostty'].reason).toMatch(/rotate:/i);
    expect(readRotateState(stateDir, 'sess-ghostty')).toBeNull();
  });
});


describe('runWatchdogTick — watchdog.rotate: off', () => {
  it('a limit tail falls through to the normal nudge path; the gate is never consulted', async () => {
    let gateCalled = false;
    const { run, calls } = rig({
      sessions: [tmuxSession()],
      tailFor: () => LIMIT_TAIL,
      rotate: false,
      rotateGate: async () => { gateCalled = true; return { healthy: true, detail: '' }; },
    });
    const result = await run();
    expect(gateCalled).toBe(false);
    expect(readRotateState(stateDir, 'sess-tmux')).toBeNull();
    expect(result.outcomes[0].decision).toBe('skip');
    expect(result.outcomes[0].reason).toBe('synthetic decider');
    expect(calls).toHaveLength(1);
    expect(calls[0].text).toMatch(/agents feed post/i);
  });
});


describe('rotate state persistence', () => {
  it('writeRotateState → readRotateState round-trips (target survives JSON)', () => {
    const state: RotateState = {
      sessionId: 'sess-x',
      newSessionId: 'new-x',
      agent: 'claude',
      phase: 'awaiting-tui',
      target: { backend: 'tmux', pane: '%3', socket: '/tmp/s' },
      startedAtMs: NOW,
      updatedAtMs: NOW,
      deadlineMs: NOW + 60_000,
    };
    expect(readRotateState(stateDir, 'sess-x')).toBeNull();
    writeRotateState(stateDir, state);
    const read = readRotateState(stateDir, 'sess-x');
    expect(read).toEqual(state);
  });
});


function freshState(over: Partial<RotateState> = {}): RotateState {
  return {
    sessionId: 'sess-old',
    newSessionId: 'new-sess-1',
    agent: 'claude',
    phase: 'awaiting-tui',
    target: { backend: 'tmux', pane: '%3', socket: '/tmp/s' },
    cwd: '/repo/a',
    machineHost: 'zion',
    startedAtMs: NOW,
    updatedAtMs: NOW,
    deadlineMs: NOW + 60_000,
    ...over,
  };
}

function freshSession(over: Partial<ActiveSession> = {}): ActiveSession {
  return {
    context: 'terminal',
    kind: 'claude',
    host: 'iterm',
    sessionId: 'sess-fresh',
    status: 'working',
    cwd: '/repo/a',
    startedAtMs: NOW + 5_000,
    provenance: { host: 'zion', transport: 'local', reply: null },
    ...over,
  };
}

describe('isCorrelatedRelaunch — the readiness fallback is correlated', () => {
  const state = freshState();

  it('a fresh session in the SAME cwd on the SAME machine correlates', () => {
    expect(isCorrelatedRelaunch(state, freshSession())).toBe(true);
  });

  it('cwd correlation normalizes trailing slashes', () => {
    expect(isCorrelatedRelaunch(state, freshSession({ cwd: '/repo/a/' }))).toBe(true);
    expect(isCorrelatedRelaunch(freshState({ cwd: '/repo/a/' }), freshSession())).toBe(true);
  });

  it('an unrelated fresh session on another cwd does NOT correlate', () => {
    expect(isCorrelatedRelaunch(state, freshSession({ cwd: '/repo/b' }))).toBe(false);
  });

  it('an unrelated fresh session on another host does NOT correlate', () => {
    const remote = freshSession({
      provenance: { host: 'mac-mini', transport: 'local', reply: null },
    });
    expect(isCorrelatedRelaunch(state, remote)).toBe(false);
  });

  it('a session started BEFORE the rotate began does NOT correlate', () => {
    expect(isCorrelatedRelaunch(state, freshSession({ startedAtMs: NOW - 1_000 }))).toBe(false);
  });

  it('the old session itself never correlates', () => {
    expect(isCorrelatedRelaunch(state, freshSession({ sessionId: 'sess-old' }))).toBe(false);
  });

  it('without cwd or host in the state the fallback cannot correlate at all', () => {
    expect(isCorrelatedRelaunch(freshState({ cwd: undefined }), freshSession())).toBe(false);
    expect(isCorrelatedRelaunch(freshState({ machineHost: undefined }), freshSession())).toBe(false);
  });
});

describe('defaultTuiLiveFor — transcript probe primary, correlated fallback', () => {
  it('an unrelated fresh session (other cwd) with no transcript does NOT trip readiness', () => {
    expect(defaultTuiLiveFor(freshState(), [freshSession({ cwd: '/repo/b' })])).toBe(false);
  });

  it('a correlated fresh session trips readiness even with no transcript yet', () => {
    expect(defaultTuiLiveFor(freshState(), [freshSession()])).toBe(true);
  });
});

describe('runWatchdogTick — readiness correlation through the sweep (default probe)', () => {
  it('an unrelated fresh session on another cwd does NOT trip readiness; the rotate deadline-fails without typing', async () => {
    const { run, calls } = rig({
      sessions: [tmuxSession({ cwd: '/repo/a' })],
      tailFor: () => LIMIT_TAIL,
    });
    await run();
    expect(calls).toHaveLength(4);

    const r2 = await run({
      sessions: [tmuxSession({ sessionId: 'sess-other', cwd: '/repo/b', startedAtMs: NOW + 5_000 })],
      nowMs: NOW + 10_000,
    });
    expect(readRotateState(stateDir, 'sess-tmux')?.phase).toBe('awaiting-tui');
    expect(calls).toHaveLength(4);
    expect(r2.outcomes.every((o) => o.decision !== 'rotate' || o.sessionId !== 'sess-tmux')).toBe(true);

    await run({
      sessions: [tmuxSession({ sessionId: 'sess-other', cwd: '/repo/b', startedAtMs: NOW + 5_000 })],
      nowMs: NOW + 61_000,
    });
    expect(readRotateState(stateDir, 'sess-tmux')?.phase).toBe('failed');
    expect(calls).toHaveLength(4);
  });

  it('a fresh session in the SAME cwd on the SAME machine trips readiness and the replay lands', async () => {
    const { run, calls } = rig({
      sessions: [tmuxSession({ cwd: '/repo/a' })],
      tailFor: () => LIMIT_TAIL,
    });
    await run();
    expect(calls).toHaveLength(4);

    await run({
      sessions: [tmuxSession({ sessionId: 'sess-new', cwd: '/repo/a', startedAtMs: NOW + 5_000 })],
      nowMs: NOW + 10_000,
    });
    expect(calls).toHaveLength(5);
    expect(calls[4].text).toContain('Resume previous work by loading session sess-tmux');
    expect(readRotateState(stateDir, 'sess-tmux')?.phase).toBe('done');
  });
});


describe('runWatchdogTick — rotate gate throw', () => {
  it('a throwing gate skips the session, records an error event, and the tick completes', async () => {
    const { run, calls } = rig({
      sessions: [tmuxSession()],
      tailFor: () => LIMIT_TAIL,
      rotateGate: async () => { throw new Error('usage cache blew up'); },
    });
    const result = await run();
    const o = result.outcomes[0];
    expect(o.decision).toBe('skip');
    expect(o.reason).toMatch(/health gate failed/i);
    expect(o.reason).toContain('usage cache blew up');
    expect(calls).toHaveLength(0);
    expect(readRotateState(stateDir, 'sess-tmux')).toBeNull();
    expect(readLogEvents().some((e) => e.kind === 'error' && e.message.includes('rotate gate failed: usage cache blew up'))).toBe(true);
    const lastTick = JSON.parse(fs.readFileSync(path.join(stateDir, 'last-tick.json'), 'utf8'));
    expect(lastTick.counts.total).toBe(1);
  });
});


describe('runWatchdogTick — failed rotate is suppressed, then retried', () => {
  it('a failed rotate suppresses re-begin for 15m and retries after', async () => {
    let gateCalls = 0;
    const { run, calls } = rig({
      sessions: [tmuxSession()],
      tailFor: () => LIMIT_TAIL,
      rotateGate: async () => { gateCalls++; return { healthy: true, detail: 'picked claude' }; },
    });
    await run();
    expect(calls).toHaveLength(4);

    const failedAt = NOW + 61_000;
    await run({ sessions: [], nowMs: failedAt, tuiLiveFor: () => false });
    const failed = readRotateState(stateDir, 'sess-tmux');
    expect(failed?.phase).toBe('failed');
    expect(failed?.suppressUntilMs).toBe(failedAt + DEFAULT_ROTATE_FAILED_COOLDOWN_MS);

    const r3 = await run({ sessions: [tmuxSession()], nowMs: failedAt + 60_000, tuiLiveFor: () => false });
    expect(r3.outcomes[0].decision).toBe('skip');
    expect(r3.outcomes[0].rotatePhase).toBe('failed');
    expect(r3.outcomes[0].reason).toMatch(/suppressed until/i);
    expect(gateCalls).toBe(1);
    expect(calls).toHaveLength(4);

    const r4 = await run({ sessions: [tmuxSession()], nowMs: failedAt + 16 * 60_000, tuiLiveFor: () => false });
    expect(r4.outcomes[0].decision).toBe('rotate');
    expect(gateCalls).toBe(2);
    expect(calls.length).toBeGreaterThan(4);
  });
});


describe('agents watchdog rotate on|off (subcommand)', () => {
  it('persists watchdog.rotate to agents.yaml via the real meta writer', async () => {
    const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'watchdog-rotate-cmd-'));
    const oldHome = process.env.HOME;
    const oldExitCode = process.exitCode;
    process.env.HOME = TMP;
    vi.resetModules();
    const origLog = console.log;
    const origErr = console.error;
    const logs: string[] = [];
    const errs: string[] = [];
    console.log = (...a: unknown[]) => { logs.push(a.map(String).join(' ')); };
    console.error = (...a: unknown[]) => { errs.push(a.map(String).join(' ')); };
    try {
      const { Command } = await import('commander');
      const { registerWatchdogCommand } = await import('../../commands/watchdog.js');
      const parse = async (argv: string[]) => {
        const program = new Command();
        program.exitOverride();
        registerWatchdogCommand(program);
        await program.parseAsync(['node', 'agents', ...argv]);
      };
      const metaText = () => fs.readFileSync(path.join(TMP, '.agents', 'agents.yaml'), 'utf8');

      await parse(['watchdog', 'rotate', 'off']);
      expect(metaText()).toMatch(/watchdog:[\s\S]*rotate: off/);
      expect(logs.join('\n')).toMatch(/rotate OFF/i);
      const { isWatchdogRotateEnabled } = await import('./rotate.js');
      expect(isWatchdogRotateEnabled()).toBe(false);

      await parse(['watchdog', 'rotate', 'on']);
      expect(metaText()).toMatch(/watchdog:[\s\S]*rotate: on/);
      expect(isWatchdogRotateEnabled()).toBe(true);

      await parse(['watchdog', 'rotate', 'maybe']);
      expect(process.exitCode).toBe(1);
      expect(errs.join('\n')).toMatch(/invalid state/i);
    } finally {
      console.log = origLog;
      console.error = origErr;
      process.exitCode = oldExitCode;
      if (oldHome === undefined) delete process.env.HOME;
      else process.env.HOME = oldHome;
      vi.resetModules();
      fs.rmSync(TMP, { recursive: true, force: true });
    }
  });
});
