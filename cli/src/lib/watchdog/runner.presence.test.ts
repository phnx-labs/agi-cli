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
    lastActivityFor: () => nowMs,
  };
  return runWatchdogTick(opts);
}

describe('runWatchdogTick — Layer C presence reconciliation (composed)', () => {
  it('tracks connect on the first tick, then disconnect + transition when the session vanishes', async () => {
    const t1 = await tick([peerTerminal('codex-1')], NOW);
    expect(t1.presence.connected).toBe(1);
    expect(t1.presence.disconnected).toBe(0);
    expect(t1.presence.transitions).toHaveLength(0);
    expect(fs.existsSync(path.join(stateDir, 'presence.json'))).toBe(true);

    const t2 = await tick([], NOW + 10_000);
    expect(t2.presence.connected).toBe(0);
    expect(t2.presence.disconnected).toBe(1);
    expect(t2.presence.transitions).toEqual([
      expect.objectContaining({
        from: 'connected',
        to: 'disconnected',
        action: 'reconnect-nudge',
        record: expect.objectContaining({ sessionId: 'codex-1', device: 'yosemite-s0', location: 'ssh' }),
      }),
    ]);

    const t3 = await tick([], NOW + 20_000);
    expect(t3.presence.transitions).toHaveLength(0);
  });
});
