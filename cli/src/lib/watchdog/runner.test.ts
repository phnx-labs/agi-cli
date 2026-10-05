import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { ActiveSession } from '../session/active.js';
import type { SessionProvenance, MuxLocation } from '../session/provenance.js';
import type { InjectTarget } from '../terminal/index.js';
import type { WatchdogCandidate } from './watchdog.js';
import type { WatchdogAgentDecider } from './watchdog-agent.js';
import type { OpenBlock } from '../feed/feed.js';
import {
  runWatchdogTick,
  DEFAULT_THRESHOLDS,
  type WatchdogPolicy,
  type WatchdogTickOptions,
  type SmartDecider,
} from './runner.js';

function run(opts: WatchdogTickOptions) {
  return runWatchdogTick({
    logPath: path.join(stateDir, 'watchdog.log'),
    openBlockFor: () => null,
    ...opts,
  });
}

const NOW = 1_700_000_000_000;
const STALE_AGO = NOW - 6 * 60_000;

function tmuxSession(over: Partial<ActiveSession> & { mux?: MuxLocation } = {}): ActiveSession {
  const provenance: SessionProvenance = {
    host: 'zion',
    transport: 'local',
    mux: over.mux ?? { kind: 'tmux', pane: '%3', socket: '/tmp/s' },
    reply: { rail: 'tmux', target: '%3', socket: '/tmp/s' },
  };
  return {
    context: 'terminal',
    kind: 'claude',
    host: over.host ?? 'iterm',
    sessionId: over.sessionId ?? 'sess-tmux',
    status: 'idle',
    startedAtMs: over.startedAtMs ?? STALE_AGO,
    provenance,
    ...over,
  };
}

function ghosttySession(over: Partial<ActiveSession> = {}): ActiveSession {
  return {
    context: 'terminal',
    kind: 'claude',
    host: 'ghostty',
    sessionId: over.sessionId ?? 'sess-ghostty',
    status: 'idle',
    startedAtMs: STALE_AGO,
    provenance: { host: 'zion', transport: 'local', reply: null },
    ...over,
  };
}

const PROMISE_TAIL = [
  '{"type":"user","message":{"role":"user","content":[{"type":"text","text":"add the flag"}]}}',
  '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"Let me run the tests now."}]}}',
];
const DONE_TAIL = [
  '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"The feature is finished and pushed."}]}}',
];
const ASK_TAIL = [
  '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"Should I proceed with running the tests?"}]}}',
];
const AMBIGUOUS_TAIL = [
  '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"The config has three sections."}]}}',
];

const nudgeDecider: SmartDecider = async () => ({ nudge: true, reason: 'idle but unfinished — drive it to finish' });
const doneDecider: SmartDecider = async () => ({ nudge: false, reason: 'task complete', needsHuman: false });
function confirmingInject(captured?: { target?: InjectTarget }) {
  return async (target: InjectTarget, _text: string, _o: { dryRun?: boolean }) => {
    if (captured) captured.target = target;
    return { ok: true as const, confirmed: true as const, backend: target.backend, writes: 2 };
  };
}

function vscodiumSession(over: Partial<ActiveSession> = {}): ActiveSession {
  return {
    context: 'terminal',
    kind: 'claude',
    host: 'codium',
    sessionId: over.sessionId ?? 'sess-codium',
    status: 'input_required',
    activity: 'waiting_input',
    awaitingReason: 'question',
    tty: '/dev/ttys009',
    startedAtMs: STALE_AGO,
    provenance: { host: 'zion', transport: 'local', reply: null },
    ...over,
  };
}

let stateDir: string;
beforeEach(() => {
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'watchdog-runner-'));
});
afterEach(() => {
  try { fs.rmSync(stateDir, { recursive: true, force: true }); } catch {  }
});

function readLedger(): Record<string, number> {
  try { return JSON.parse(fs.readFileSync(path.join(stateDir, 'nudges.json'), 'utf8')); } catch { return {}; }
}
function readFlags(): Record<string, { reason: string; host?: string; atMs: number }> {
  try { return JSON.parse(fs.readFileSync(path.join(stateDir, 'flags.json'), 'utf8')); } catch { return {}; }
}

describe('runWatchdogTick — nudge fires', () => {
  it('injects on promise-without-toolcall + addressable, and records the cooldown', async () => {
    const s = tmuxSession();
    const result = await run({
      sessions: [s], nowMs: NOW, nudge: true, injectDryRun: true, stateDir,
      tailFor: () => PROMISE_TAIL, smartDecider: nudgeDecider,
    });

    const o = result.outcomes[0];
    expect(o.stall).toBe('stalled');
    expect(o.decision).toBe('nudge');
    expect(o.addressable).toBe(true);
    expect(o.rail).toBe('tmux');
    expect(o.injected).toBe(true);
    expect(o.nudgeText).toBe('Continue.');
    expect(result.counts.nudged).toBe(1);
    expect(readLedger()['sess-tmux']).toBe(NOW);
  });

  it('honors a custom nudge text', async () => {
    const result = await run({
      sessions: [tmuxSession()], nowMs: NOW, nudge: true, injectDryRun: true, stateDir,
      nudgeText: 'Keep going.', tailFor: () => PROMISE_TAIL, smartDecider: nudgeDecider,
    });
    expect(result.outcomes[0].injected).toBe(true);
    expect(result.outcomes[0].nudgeText).toBe('Keep going.');
  });
});

describe('runWatchdogTick — parked-on-question escalates to the brain', () => {
  const parked = () => tmuxSession({ activity: 'waiting_input', awaitingReason: 'question' });

  it('escalates a waiting_input session and DRIVES FORWARD when the brain says nudge', async () => {
    let sawEscalation: WatchdogCandidate | null = null;
    const smartDecider: SmartDecider = async (_s, candidate) => {
      sawEscalation = candidate;
      return { nudge: true, reason: 'needless question — proceed with the obvious next step', text: 'Use best judgment and finish end-to-end; run the tests without asking.' };
    };
    const result = await run({
      sessions: [parked()], nowMs: NOW, nudge: true, injectDryRun: true, stateDir,
      tailFor: () => ASK_TAIL, smartDecider,
    });
    expect(sawEscalation).not.toBeNull();
    const o = result.outcomes[0];
    expect(o.decision).toBe('nudge');
    expect(o.injected).toBe(true);
    expect(o.rail).toBe('tmux');
    expect(o.nudgeText).toMatch(/best judgment/i);
    expect(readLedger()['sess-tmux']).toBe(NOW);
  });

  it('escalates a waiting_input session and LEAVES FOR HUMAN when the brain says skip', async () => {
    const smartDecider: SmartDecider = async () => ({ nudge: false, reason: 'credentials required — needs the human' });
    const result = await run({
      sessions: [parked()], nowMs: NOW, nudge: true, injectDryRun: true, stateDir,
      tailFor: () => ASK_TAIL, smartDecider,
    });
    const o = result.outcomes[0];
    expect(o.decision).toBe('skip');
    expect(o.injected).toBeUndefined();
    expect(o.reason).toMatch(/human/i);
    expect(readLedger()['sess-tmux']).toBe(NOW);
  });

  it('an ambiguous stall (no promise, no completion, not waiting) also escalates', async () => {
    let escalated = false;
    const smartDecider: SmartDecider = async () => { escalated = true; return { nudge: false, reason: 'unclear' }; };
    await run({
      sessions: [tmuxSession()], nowMs: NOW, nudge: true, injectDryRun: true, stateDir,
      tailFor: () => AMBIGUOUS_TAIL, smartDecider,
    });
    expect(escalated).toBe(true);
  });
});

describe('runWatchdogTick — skips (no nudge)', () => {
  it('SKIPS a completed (idle-and-done) session, never booking a nudge', async () => {
    const result = await run({
      sessions: [tmuxSession()], nowMs: NOW, nudge: true, injectDryRun: true, stateDir,
      tailFor: () => DONE_TAIL, smartDecider: doneDecider,
    });
    const o = result.outcomes[0];
    expect(o.stall).toBe('stalled');
    expect(o.decision).toBe('skip');
    expect(o.injected).toBeUndefined();
    expect(result.counts.nudged).toBe(0);
    expect(readLedger()['sess-tmux']).toBeUndefined();
  });

  it('SKIPS and FLAGS an un-addressable NUDGE-WORTHY stall (ghostty, no tmux) — flag only, NEVER pages the owner', async () => {
    const blocks: OpenBlock[] = [];
    const result = await run({
      sessions: [ghosttySession()], nowMs: NOW, nudge: true, injectDryRun: true, stateDir,
      tailFor: () => PROMISE_TAIL, smartDecider: nudgeDecider, publishBlockFn: (b) => blocks.push(b),
    });
    const o = result.outcomes[0];
    expect(o.decision).toBe('skip');
    expect(o.addressable).toBe(false);
    expect(o.injected).toBeUndefined();
    expect(o.reason).toMatch(/un-addressable/i);
    expect(o.reason).toContain('agents sessions resume sess-gho');
    expect(o.reason).not.toContain('<id>');
    expect(result.counts.unaddressable).toBe(1);
    const flags = readFlags();
    expect(flags['sess-ghostty']).toBeDefined();
    expect(flags['sess-ghostty'].host).toBe('ghostty');
    expect(blocks).toHaveLength(0);
    expect(readLedger()['sess-ghostty']).toBeUndefined();
  });

  it('SKIPS within cooldown (rate-limited by a recent nudge)', async () => {
    fs.writeFileSync(path.join(stateDir, 'nudges.json'), JSON.stringify({ 'sess-tmux': NOW - 60_000 }));
    const result = await run({
      sessions: [tmuxSession()], nowMs: NOW, nudge: true, injectDryRun: true, stateDir,
      tailFor: () => PROMISE_TAIL,
    });
    const o = result.outcomes[0];
    expect(o.stall).toBe('rate_limited');
    expect(o.decision).toBe('skip');
    expect(o.injected).toBeUndefined();
    expect(readLedger()['sess-tmux']).toBe(NOW - 60_000);
  });

  it('handsoff policy: detects + flags a nudge-worthy stall but NEVER injects or pages', async () => {
    const policyFor = (): WatchdogPolicy => 'handsoff';
    const blocks: OpenBlock[] = [];
    const result = await run({
      sessions: [tmuxSession()], nowMs: NOW, nudge: true, injectDryRun: true, stateDir,
      tailFor: () => PROMISE_TAIL, smartDecider: nudgeDecider, policyFor, publishBlockFn: (b) => blocks.push(b),
    });
    const o = result.outcomes[0];
    expect(o.policy).toBe('handsoff');
    expect(o.decision).toBe('nudge');
    expect(o.addressable).toBe(true);
    expect(o.injected).toBe(false);
    expect(o.reason).toMatch(/handsoff/i);
    expect(blocks).toHaveLength(0);
    expect(readLedger()['sess-tmux']).toBeUndefined();
    const flags = readFlags();
    expect(flags['sess-tmux']).toBeDefined();
    expect(flags['sess-tmux'].reason).toMatch(/hands-off/i);
    expect(flags['sess-tmux'].host).toBe('iterm');
  });

  it('policy off: fully opted out, not even classified as stalled', async () => {
    const result = await run({
      sessions: [tmuxSession()], nowMs: NOW, nudge: true, injectDryRun: true, stateDir,
      tailFor: () => PROMISE_TAIL, policyFor: () => 'off',
    });
    const o = result.outcomes[0];
    expect(o.stall).toBe('opted_out');
    expect(o.decision).toBe('skip');
    expect(o.injected).toBeUndefined();
  });
});

describe('runWatchdogTick — dry run (default, no --nudge)', () => {
  it('reports WOULD-nudge without injecting or touching the cooldown', async () => {
    const result = await run({
      sessions: [tmuxSession()], nowMs: NOW, nudge: false, injectDryRun: true, stateDir,
      tailFor: () => PROMISE_TAIL, smartDecider: nudgeDecider,
    });
    const o = result.outcomes[0];
    expect(o.decision).toBe('nudge');
    expect(o.addressable).toBe(true);
    expect(o.injected).toBe(false);
    expect(o.reason).toMatch(/would nudge/i);
    expect(result.didNudge).toBe(false);
    expect(readLedger()['sess-tmux']).toBeUndefined();
  });
});

describe('runWatchdogTick — active / not-yet-stalled', () => {
  it('SKIPS an active session (recent activity)', async () => {
    const s = tmuxSession({ startedAtMs: NOW - 5_000 });
    const result = await run({
      sessions: [s], nowMs: NOW, nudge: true, injectDryRun: true, stateDir,
      tailFor: () => PROMISE_TAIL,
    });
    const o = result.outcomes[0];
    expect(o.stall).toBe('active');
    expect(o.decision).toBe('skip');
    expect(o.injected).toBeUndefined();
    expect(DEFAULT_THRESHOLDS.stallMs).toBe(300_000);
  });

  it('preserves the cached session metadata needed by diagnostic output', async () => {
    const s = tmuxSession({
      startedAtMs: NOW - 60_000,
      lastActivityMs: NOW - 5_000,
      project: 'agents-cli',
      name: 'watchdog-check',
      topic: 'Explain a stalled routine',
      preview: 'Reading the session tail',
      activity: 'working',
      origin: 'routine',
      routineName: 'session-health',
      machine: 'zion',
      owner: 'muqsit@example.com',
    });
    const result = await run({ sessions: [s], nowMs: NOW, nudge: false, stateDir });
    expect(result.outcomes[0]).toMatchObject({
      project: 'agents-cli',
      name: 'watchdog-check',
      topic: 'Explain a stalled routine',
      preview: 'Reading the session tail',
      activity: 'working',
      status: 'idle',
      startedAtMs: NOW - 60_000,
      lastActivityMs: NOW - 5_000,
      origin: 'routine',
      routineName: 'session-health',
      machine: 'zion',
      owner: 'muqsit@example.com',
    });
  });

  it('SKIPS a session with no session id (cannot address or track)', async () => {
    const s = tmuxSession({ sessionId: undefined });
    const result = await run({
      sessions: [s], nowMs: NOW, nudge: true, injectDryRun: true, stateDir,
      tailFor: () => PROMISE_TAIL,
    });
    expect(result.outcomes[0].decision).toBe('skip');
    expect(result.outcomes[0].reason).toMatch(/no session id/i);
  });
});

describe('runWatchdogTick — delivery routing (answer-router + vscodium)', () => {
  it('routes an IDE (VS Codium) parked session to the vscodium inject rail, targeting the EXACT terminal', async () => {
    const captured: { target?: InjectTarget } = {};
    const smartDecider: SmartDecider = async () => ({ nudge: true, reason: 'proceed', text: 'Finish it; use the sensible default.' });
    const result = await run({
      sessions: [vscodiumSession()], nowMs: NOW, nudge: true, stateDir,
      tailFor: () => ASK_TAIL, smartDecider, injectFn: confirmingInject(captured),
    });
    const o = result.outcomes[0];
    expect(o.decision).toBe('nudge');
    expect(o.rail).toBe('vscodium');
    expect(o.via).toBe('inject');
    expect(o.injected).toBe(true);
    expect(captured.target).toMatchObject({ backend: 'vscodium', terminalId: 'sess-codium', cli: 'codium', scheme: 'vscodium' });
    expect(result.counts.nudged).toBe(1);
    expect(readLedger()['sess-codium']).toBe(NOW);
  });
});

describe('runWatchdogTick — confirmed vs unconfirmed delivery', () => {
  it('an UNCONFIRMED delivery (vscodium fire-and-forget) is recorded undelivered, NOT a nudge', async () => {
    const unconfirmedInject = async (target: InjectTarget) =>
      ({ ok: true as const, confirmed: false as const, backend: target.backend, writes: 2 });
    const smartDecider: SmartDecider = async () => ({ nudge: true, reason: 'proceed' });
    const result = await run({
      sessions: [vscodiumSession()], nowMs: NOW, nudge: true, stateDir,
      tailFor: () => ASK_TAIL, smartDecider, injectFn: unconfirmedInject,
    });
    const o = result.outcomes[0];
    expect(o.decision).toBe('skip');
    expect(o.injected).toBe(false);
    expect(o.reason).toMatch(/unconfirmed/i);
    expect(result.counts.nudged).toBe(0);
    expect(readLedger()['sess-codium']).toBe(NOW);
  });

  it('a CONFIRMED tmux delivery is booked as a nudge', async () => {
    const result = await run({
      sessions: [tmuxSession()], nowMs: NOW, nudge: true, stateDir,
      tailFor: () => PROMISE_TAIL, smartDecider: nudgeDecider, injectFn: confirmingInject(),
    });
    const o = result.outcomes[0];
    expect(o.decision).toBe('nudge');
    expect(o.injected).toBe(true);
    expect(result.counts.nudged).toBe(1);
    expect(readLedger()['sess-tmux']).toBe(NOW);
  });
});

describe('runWatchdogTick — the agent decides only when something is idle', () => {
  it('does NOT consult the decider when the only session is active', async () => {
    let called = false;
    const spyDecider: SmartDecider = async () => { called = true; return { nudge: false, reason: 'x' }; };
    const s = tmuxSession({ startedAtMs: NOW - 5_000 });
    await run({
      sessions: [s], nowMs: NOW, nudge: true, injectDryRun: true, stateDir,
      tailFor: () => PROMISE_TAIL, smartDecider: spyDecider,
    });
    expect(called).toBe(false);
  });
});

describe('runWatchdogTick — the batched agent decider (production path)', () => {
  function readLog(): Array<{ kind: string; message: string; terminalId?: string }> {
    try {
      return fs.readFileSync(path.join(stateDir, 'watchdog.log'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    } catch { return []; }
  }

  it('applies a batched verdict keyed by terminalId (one decider call for all idle sessions)', async () => {
    let calls = 0;
    let sawCount = 0;
    const agentDecider: WatchdogAgentDecider = async (cands) => {
      calls++; sawCount = cands.length;
      return new Map(cands.map((c) => [c.terminalId, { terminalId: c.terminalId, action: 'nudge' as const, text: '', reason: 'unfinished' }]));
    };
    const a = tmuxSession({ sessionId: 'sess-a' });
    const b = tmuxSession({ sessionId: 'sess-b' });
    const result = await run({
      sessions: [a, b], nowMs: NOW, nudge: true, injectDryRun: true, stateDir,
      tailFor: () => PROMISE_TAIL, agentDecider,
    });
    expect(calls).toBe(1);
    expect(sawCount).toBe(2);
    expect(result.outcomes.every((o) => o.decision === 'nudge')).toBe(true);
    expect(result.counts.nudged).toBe(2);
  });

  it('a session with NO verdict is a neutral safe-skip — not marked done, not booked, retried next tick', async () => {
    const emptyDecider: WatchdogAgentDecider = async () => new Map();
    const result = await run({
      sessions: [tmuxSession()], nowMs: NOW, nudge: true, injectDryRun: true, stateDir,
      tailFor: () => PROMISE_TAIL, agentDecider: emptyDecider,
    });
    const o = result.outcomes[0];
    expect(o.decision).toBe('skip');
    expect(o.reason).toMatch(/no verdict/i);
    expect(readLedger()['sess-tmux']).toBeUndefined();
    expect(readLog().some((e) => e.kind === 'error' && /no verdicts/i.test(e.message))).toBe(true);
  });
});

describe('runWatchdogTick — the cooldown ledger is lock-serialized (no lost updates)', () => {
  it('two concurrent ticks nudging different sessions both persist their timestamps', async () => {
    const a = tmuxSession({ sessionId: 'sess-a' });
    const b = tmuxSession({ sessionId: 'sess-b' });
    const shared = fs.mkdtempSync(path.join(os.tmpdir(), 'watchdog-lock-'));
    const common = {
      nowMs: NOW, nudge: true, injectDryRun: true, stateDir: shared,
      logPath: path.join(shared, 'watchdog.log'), openBlockFor: () => null,
      tailFor: () => PROMISE_TAIL, smartDecider: nudgeDecider,
    };
    await Promise.all([
      runWatchdogTick({ ...common, sessions: [a] }),
      runWatchdogTick({ ...common, sessions: [b] }),
    ]);
    const ledger = JSON.parse(fs.readFileSync(path.join(shared, 'nudges.json'), 'utf8'));
    expect(ledger['sess-a']).toBe(NOW);
    expect(ledger['sess-b']).toBe(NOW);
    fs.rmSync(shared, { recursive: true, force: true });
  });
});

describe('runWatchdogTick — brain says needs-human → wires the owner feed', () => {

  const needsHumanDecider: SmartDecider = async () => ({ nudge: false, reason: 'credentials required — needs the human' });

  describe('A. addressable session (tmux) — inject a self-file reminder', () => {
    it('injects the reminder text and records the cooldown', async () => {
      let capturedText: string | null = null;
      const injectFn = async (_target: InjectTarget, text: string, _o: { dryRun?: boolean }) => {
        capturedText = text;
        return { ok: true as const, confirmed: true as const, backend: 'tmux' as const, writes: 2 };
      };
      const result = await run({
        sessions: [tmuxSession()], nowMs: NOW, nudge: true, stateDir,
        tailFor: () => ASK_TAIL, smartDecider: needsHumanDecider, injectFn,
        openBlockFor: () => null,
      });
      const o = result.outcomes[0];
      expect(o.decision).toBe('skip');
      expect(o.reason).toMatch(/credentials/i);
      expect(capturedText).not.toBeNull();
      expect(capturedText).toMatch(/agents feed post/i);
      expect(capturedText).toMatch(/--blocked/i);
      expect(readLedger()['sess-tmux']).toBe(NOW);
    });

    it('does NOT inject when a block already exists for the session', async () => {
      let injected = false;
      const injectFn = async () => { injected = true; return { ok: true as const, confirmed: true as const, backend: 'tmux' as const, writes: 2 }; };
      const existingBlock = { blockId: 'block-sess-tmux', sessionId: 'sess-tmux', mailboxId: 'sess-tmux' } as OpenBlock;
      await run({
        sessions: [tmuxSession()], nowMs: NOW, nudge: true, stateDir,
        tailFor: () => ASK_TAIL, smartDecider: needsHumanDecider, injectFn,
        openBlockFor: () => existingBlock,
      });
      expect(injected).toBe(false);
      expect(readLedger()['sess-tmux']).toBeUndefined();
    });

    it('does NOT inject a second time within the cooldown window', async () => {
      fs.writeFileSync(path.join(stateDir, 'nudges.json'), JSON.stringify({ 'sess-tmux': NOW - 60_000 }));
      let injected = false;
      const injectFn = async () => { injected = true; return { ok: true as const, confirmed: true as const, backend: 'tmux' as const, writes: 2 }; };
      await run({
        sessions: [tmuxSession()], nowMs: NOW, nudge: true, stateDir,
        tailFor: () => ASK_TAIL, smartDecider: needsHumanDecider, injectFn,
        openBlockFor: () => null,
      });
      expect(injected).toBe(false);
      expect(readLedger()['sess-tmux']).toBe(NOW - 60_000);
    });
  });

  describe('B. un-addressable session (ghostty, no tmux) — file a declared block', () => {
    const unaddressableNeedsHuman = () => ghosttySession({ activity: 'waiting_input', awaitingReason: 'question' });

    it('publishes a declared block and records the cooldown', async () => {
      const published: OpenBlock[] = [];
      const publishBlockFn = (b: OpenBlock) => { published.push(b); };
      const result = await run({
        sessions: [unaddressableNeedsHuman()], nowMs: NOW, nudge: true, stateDir,
        tailFor: () => ASK_TAIL, smartDecider: needsHumanDecider, publishBlockFn,
        openBlockFor: () => null,
      });
      const o = result.outcomes[0];
      expect(o.decision).toBe('skip');
      expect(published).toHaveLength(1);
      expect(published[0].sessionId).toBe('sess-ghostty');
      expect(published[0].costOfDelay).toBe('high');
      expect(published[0].questions[0].text).toContain('agents sessions resume sess-gho');
      expect(published[0].questions[0].text).not.toContain('<id>');
      expect(readLedger()['sess-ghostty']).toBe(NOW);
    });

    it('does NOT publish when a block already exists', async () => {
      const published: OpenBlock[] = [];
      const existingBlock = { blockId: 'block-sess-ghostty', sessionId: 'sess-ghostty', mailboxId: 'sess-ghostty' } as OpenBlock;
      await run({
        sessions: [unaddressableNeedsHuman()], nowMs: NOW, nudge: true, stateDir,
        tailFor: () => ASK_TAIL, smartDecider: needsHumanDecider,
        publishBlockFn: (b) => published.push(b),
        openBlockFor: () => existingBlock,
      });
      expect(published).toHaveLength(0);
      expect(readLedger()['sess-ghostty']).toBeUndefined();
    });

    it('does NOT publish a second time within the cooldown window', async () => {
      fs.writeFileSync(path.join(stateDir, 'nudges.json'), JSON.stringify({ 'sess-ghostty': NOW - 60_000 }));
      const published: OpenBlock[] = [];
      await run({
        sessions: [unaddressableNeedsHuman()], nowMs: NOW, nudge: true, stateDir,
        tailFor: () => ASK_TAIL, smartDecider: needsHumanDecider,
        publishBlockFn: (b) => published.push(b),
        openBlockFor: () => null,
      });
      expect(published).toHaveLength(0);
      expect(readLedger()['sess-ghostty']).toBe(NOW - 60_000);
    });
  });

  describe('C. a nudge-worthy (NOT needsHuman) session is NEVER paged', () => {

    it('un-addressable NUDGE-worthy poke → flag only, no block, no cooldown write', async () => {
      const published: OpenBlock[] = [];
      const result = await run({
        sessions: [ghosttySession()], nowMs: NOW, nudge: true, stateDir,
        tailFor: () => PROMISE_TAIL, smartDecider: nudgeDecider, publishBlockFn: (b) => published.push(b),
        openBlockFor: () => null,
      });
      const o = result.outcomes[0];
      expect(o.decision).toBe('skip');
      expect(o.addressable).toBe(false);
      expect(o.reason).toContain('agents sessions resume sess-gho');
      expect(o.reason).not.toContain('<id>');
      expect(readFlags()['sess-ghostty']).toBeDefined();
      expect(published).toHaveLength(0);
      expect(readLedger()['sess-ghostty']).toBeUndefined();
    });

    it('handsoff NUDGE-worthy poke → flag only, never injects, no block, no cooldown write', async () => {
      const published: OpenBlock[] = [];
      let injected = false;
      const injectFn = async () => { injected = true; return { ok: true as const, confirmed: true as const, backend: 'tmux' as const, writes: 2 }; };
      const result = await run({
        sessions: [tmuxSession()], nowMs: NOW, nudge: true, stateDir,
        tailFor: () => PROMISE_TAIL, smartDecider: nudgeDecider, policyFor: () => 'handsoff',
        publishBlockFn: (b) => published.push(b), injectFn, openBlockFor: () => null,
      });
      const o = result.outcomes[0];
      expect(o.policy).toBe('handsoff');
      expect(o.injected).toBe(false);
      expect(injected).toBe(false);
      expect(readFlags()['sess-tmux']).toBeDefined();
      expect(published).toHaveLength(0);
      expect(readLedger()['sess-tmux']).toBeUndefined();
    });
  });
});
