/** RUSH-2007 Layer C, composed integration (real tmp state dir, no mocks): runWatchdogTick persists
 * presence across ticks; tick 1 sees a session (connected), tick 2 does not (disconnected
 * transition). */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { ActiveSession } from '../session/active.js';
import type { SessionProvenance } from '../session/provenance.js';
import { runWatchdogTick, type WatchdogTickOptions } from './runner.js';

let stateDir: string;
beforeEach(() => { stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wd-presence-')); });
afterEach(() => { fs.rmSync(stateDir, { recursive: true, force: true }); });

const NOW = 1_700_000_000_000;

/** An interactive tmux session on a peer (machine set => location ssh). */
function peerTerminal(sessionId: string): ActiveSession {
  const provenance: SessionProvenance = {
    host: 'yosemite-s0',
    transport: 'ssh',
    mux: { kind: 'tmux', pane: '%1', socket: '/tmp/s' },
    reply: { rail: 'tmux', target: '%1', socket: '/tmp/s' },
  };
  return {
    context: 'terminal',
    kind: 'codex',
    host: 'ssh',
    sessionId,
    machine: 'yosemite-s0',
    status: 'idle',
    startedAtMs: NOW,
    provenance,
  } as ActiveSession;
}

function tick(sessions: ActiveSession[], nowMs: number): Promise<ReturnType<typeof runWatchdogTick> extends Promise<infer R> ? R : never> {
  const opts: WatchdogTickOptions = {
    sessions,
    nowMs,
    stateDir,
    injectDryRun: true,
    logPath: path.join(stateDir, 'watchdog.log'),
    openBlockFor: () => null,
    // recent activity => not stalled, so the nudge path stays quiet and the test
    // isolates presence reconciliation.
    lastActivityFor: () => nowMs,
  };
  return runWatchdogTick(opts);
}

describe('runWatchdogTick — Layer C presence reconciliation (composed)', () => {
  it('tracks connect on the first tick, then disconnect + transition when the session vanishes', async () => {
    // Tick 1: the codex session is present -> connected, no transition (first sighting).
    const t1 = await tick([peerTerminal('codex-1')], NOW);
    expect(t1.presence.connected).toBe(1);
    expect(t1.presence.disconnected).toBe(0);
    expect(t1.presence.transitions).toHaveLength(0);
    // and it was persisted for the next tick
    expect(fs.existsSync(path.join(stateDir, 'presence.json'))).toBe(true);

    // Tick 2: the session is gone (SSH dropped / peer unreachable) -> disconnected.
    const t2 = await tick([], NOW + 10_000);
    expect(t2.presence.connected).toBe(0);
    expect(t2.presence.disconnected).toBe(1);
    expect(t2.presence.transitions).toEqual([
      expect.objectContaining({
        from: 'connected',
        to: 'disconnected',
        action: 'reconnect-nudge', // interactive session -> reconnect nudge candidate
        record: expect.objectContaining({ sessionId: 'codex-1', device: 'yosemite-s0', location: 'ssh' }),
      }),
    ]);

    // Tick 3: still gone, but no NEW transition (already disconnected last tick).
    const t3 = await tick([], NOW + 20_000);
    expect(t3.presence.transitions).toHaveLength(0);
  });
});
