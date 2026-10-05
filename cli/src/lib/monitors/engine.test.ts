import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { decideFire, evaluateMonitorOnce, MonitorEngine, shouldEscalateDrought } from './engine.js';
import { writeState, readState, readLiveness, getMonitorHistoryDir } from './state.js';
import { writeMonitor, deleteMonitor } from './config.js';
import type { MonitorConfig } from './config.js';

function monitor(partial: Partial<MonitorConfig>): MonitorConfig {
  return {
    name: partial.name!,
    enabled: true,
    source: { type: 'command', command: 'echo x' },
    condition: { mode: 'on-change' },
    action: { type: 'notify', notifyChannel: 'telegram' },
    ...partial,
  } as MonitorConfig;
}

const names: string[] = [];
function uniq(tag: string): string {
  const n = `test-engine-${tag}-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  names.push(n);
  return n;
}

afterEach(() => {
  for (const n of names.splice(0)) {
    try { fs.rmSync(getMonitorHistoryDir(n), { recursive: true, force: true }); } catch {  }
  }
});

describe('decideFire — every mode', () => {
  it('fires on every non-empty observation', () => {
    const m = monitor({ name: uniq('every'), condition: { mode: 'every' } });
    const d = decideFire(m, { raw: 'anything' });
    expect(d.fire).toBe(true);
    expect(d.event).not.toBeNull();
    expect(d.persist).toBe(false);
  });

  it('does NOT fire on an empty or whitespace-only observation (RUSH-2488)', () => {
    const m = monitor({ name: uniq('every-empty'), condition: { mode: 'every' } });
    for (const raw of ['', '   ', '\n', ' \t\n ']) {
      const d = decideFire(m, { raw });
      expect(d.fire).toBe(false);
      expect(d.event).toBeNull();
      expect(d.persist).toBe(false);
    }
  });
});

describe('decideFire — on-change mode', () => {
  it('does NOT fire on the first observation (silent baseline) but marks it to persist', () => {
    const m = monitor({ name: uniq('onchange') });
    const d = decideFire(m, { raw: 'first' });
    expect(d.fire).toBe(false);
    expect(d.persist).toBe(true);
  });

  it('fires when the value differs from the stored baseline', () => {
    const name = uniq('onchange');
    const m = monitor({ name });
    writeState(name, 'baseline');
    expect(decideFire(m, { raw: 'baseline' }).fire).toBe(false);
    expect(decideFire(m, { raw: 'changed' }).fire).toBe(true);
  });
});

describe('decideFire — match mode', () => {
  it('fires once on a match, then stays silent until the matched token changes', () => {
    const name = uniq('match');
    const m = monitor({ name, condition: { mode: 'match', match: 'fail' } });

    expect(decideFire(m, { raw: 'all green' }).fire).toBe(false);

    const first = decideFire(m, { raw: 'build 1 fail' });
    expect(first.fire).toBe(true);

    writeState(name, first.value, m.condition.dedupeKey);
    expect(decideFire(m, { raw: 'build 2 fail' }).fire).toBe(false);
  });
});

describe('evaluateMonitorOnce — real command source, no side effects', () => {
  it('evaluates a command source and reports a fire decision without writing state', async () => {
    const name = uniq('once');
    const m = monitor({ name, source: { type: 'command', command: 'echo alive' }, condition: { mode: 'every' } });
    const { observation, decision } = await evaluateMonitorOnce(m);
    expect(observation?.raw).toBe('alive');
    expect(decision?.fire).toBe(true);
    expect(fs.existsSync(getMonitorHistoryDir(name))).toBe(false);
  });
});

describe('MonitorEngine.runMonitor — liveness heartbeat (RUSH-2485)', () => {
  const engine = new MonitorEngine();

  it('records a heartbeat on a poll that matches NOTHING — the core bug', async () => {
    const name = uniq('nomatch');
    const m = monitor({
      name,
      source: { type: 'command', command: 'echo all-green' },
      condition: { mode: 'match', match: 'FAILURE' },
    });
    await engine.runMonitor(m);
    const live = readLiveness(name);
    expect(live).not.toBeNull();
    expect(live!.checkCount).toBe(1);
    expect(live!.consecutiveErrors).toBe(0);
    expect(live!.lastError).toBeUndefined();
    expect(readState(name)).toBeNull();

    await engine.runMonitor(m);
    expect(readLiveness(name)!.checkCount).toBe(2);
  });

  it('records a heartbeat AND a fire when the action runs (webhook-out to an unreachable URL)', async () => {
    const name = uniq('fire');
    const m = monitor({
      name,
      source: { type: 'command', command: 'echo tick' },
      condition: { mode: 'every' },
      action: { type: 'webhook-out', url: 'http://127.0.0.1:1/' },
    });
    await engine.runMonitor(m);
    const live = readLiveness(name);
    expect(live!.checkCount).toBe(1);
    expect(live!.consecutiveErrors).toBe(1);
    expect(live!.lastError).toContain('webhook-out');
    expect(readState(name)!.lastFiredAt).toBeTruthy();
  });

  it('records NO liveness for a push-only source (ws) — those deliver via subscribe', async () => {
    const name = uniq('push');
    const m = monitor({ name, source: { type: 'ws', wsUrl: 'ws://127.0.0.1:1/' }, condition: { mode: 'every' } });
    await engine.runMonitor(m);
    expect(readLiveness(name)).toBeNull();
  });
});

describe('decideFire — a failed observation never fires, in ANY mode (PHNX-3510)', () => {
  it('returns no-fire / no-persist for on-change, match, and every', () => {
    const obs = {
      raw: 'GraphQL: API rate limit already exceeded for user ID 13007401.',
      failed: true,
      failureReason: 'API rate limit exceeded',
    };
    const cases = [
      monitor({ name: uniq('failguard-onchange'), condition: { mode: 'on-change' } }),
      monitor({ name: uniq('failguard-match'), condition: { mode: 'match', match: '.*' } }),
      monitor({ name: uniq('failguard-every'), condition: { mode: 'every' } }),
    ];
    for (const m of cases) {
      const d = decideFire(m, obs);
      expect(d.fire, m.condition.mode).toBe(false);
      expect(d.persist, m.condition.mode).toBe(false);
      expect(d.event, m.condition.mode).toBeNull();
    }
  });

  it('evaluateMonitorOnce (the `monitors test` path) reports fire:false for a failing real command', async () => {
    const name = uniq('test-fail');
    const m = monitor({
      name,
      source: { type: 'command', command: 'echo "GraphQL: API rate limit already exceeded for user ID 1."' },
      condition: { mode: 'on-change' },
    });
    const { observation, decision } = await evaluateMonitorOnce(m);
    expect(observation?.failed).toBe(true);
    expect(decision?.fire).toBe(false);
    expect(fs.existsSync(getMonitorHistoryDir(name))).toBe(false);
  });
});

describe('MonitorEngine.runMonitor — a poll FAILURE is not a value change (PHNX-3510)', () => {
  const engine = new MonitorEngine();
  const tmpDirs: string[] = [];
  function togglePoll(): { command: string; set: (body: string) => void } {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'monitor-poll-'));
    tmpDirs.push(dir);
    const script = path.join(dir, 'poll.sh');
    fs.writeFileSync(script, "printf ''\n");
    return { command: `sh ${script}`, set: (body: string) => fs.writeFileSync(script, body) };
  }
  afterEach(() => {
    for (const d of tmpDirs.splice(0)) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {  } }
  });

  it('does NOT fire, and leaves the baseline untouched, across empty→error→empty (the exact ticket flap)', async () => {
    const name = uniq('pollfail-flap');
    const poll = togglePoll();
    const m = monitor({
      name,
      source: { type: 'command', command: poll.command },
      condition: { mode: 'on-change' },
      action: { type: 'notify', notifyChannel: 'telegram' },
    });

    poll.set("printf ''\n");
    await engine.runMonitor(m);
    expect(readState(name)?.lastValue).toBe('');
    expect(readState(name)?.lastFiredAt).toBeUndefined();
    expect(readLiveness(name)!.consecutiveErrors).toBe(0);

    poll.set("printf 'GraphQL: API rate limit already exceeded for user ID 13007401.\\n'\n");
    await engine.runMonitor(m);
    expect(readState(name)?.lastValue).toBe('');
    expect(readState(name)?.lastFiredAt).toBeUndefined();
    const live = readLiveness(name)!;
    expect(live.consecutiveErrors).toBe(1);
    expect(live.lastError).toContain('API rate limit exceeded');

    poll.set("printf ''\n");
    await engine.runMonitor(m);
    expect(readState(name)?.lastValue).toBe('');
    expect(readState(name)?.lastFiredAt).toBeUndefined();
    expect(readLiveness(name)!.consecutiveErrors).toBe(0);
  });

  it('treats a non-zero exit as an observation failure, not a value change', async () => {
    const name = uniq('pollfail-exit');
    const poll = togglePoll();
    const m = monitor({
      name,
      source: { type: 'command', command: poll.command },
      condition: { mode: 'on-change' },
    });

    poll.set("printf 'up\\n'\n");
    await engine.runMonitor(m);
    expect(readState(name)?.lastValue).toBe('up');

    poll.set("printf 'boom\\n' >&2\nexit 2\n");
    await engine.runMonitor(m);
    expect(readState(name)?.lastValue).toBe('up');
    expect(readState(name)?.lastFiredAt).toBeUndefined();
    const live = readLiveness(name)!;
    expect(live.consecutiveErrors).toBe(1);
    expect(live.lastError).toContain('exited 2');
  });

  it('a genuine value change on a CLEAN (exit 0, non-error) poll still fires', async () => {
    const name = uniq('pollfail-clean');
    const poll = togglePoll();
    const m = monitor({
      name,
      source: { type: 'command', command: poll.command },
      condition: { mode: 'on-change' },
      action: { type: 'webhook-out', url: 'http://127.0.0.1:1/' },
    });

    poll.set("printf 'OPEN\\n'\n");
    await engine.runMonitor(m);
    expect(readState(name)?.lastFiredAt).toBeUndefined();

    poll.set("printf 'MERGED\\n'\n");
    await engine.runMonitor(m);
    expect(readState(name)?.lastValue).toBe('MERGED');
    expect(readState(name)?.lastFiredAt).toBeTruthy();
  });
});

describe('MonitorEngine.tick — a stopped engine dispatches nothing (PHNX-3608)', () => {
  it('tick() runs monitors while started, and no longer dispatches after stop()', async () => {
    const name = uniq('stopgate');
    writeMonitor(monitor({ name, source: { type: 'command', command: 'echo x' }, condition: { mode: 'every' } }));
    try {
      const engine = new MonitorEngine();
      engine.start({ externalScheduler: true });
      await engine.tick();
      const afterFirst = readLiveness(name);
      expect(afterFirst).not.toBeNull();
      expect(afterFirst!.checkCount).toBe(1);

      engine.stop();
      await engine.tick();
      expect(readLiveness(name)!.checkCount).toBe(1);
    } finally {
      deleteMonitor(name);
    }
  });

  it('an engine that was never started dispatches nothing on tick()', async () => {
    const name = uniq('nostart');
    writeMonitor(monitor({ name, source: { type: 'command', command: 'echo x' }, condition: { mode: 'every' } }));
    try {
      const engine = new MonitorEngine();
      await engine.tick();
      expect(readLiveness(name)).toBeNull();
    } finally {
      deleteMonitor(name);
    }
  });
});

describe('MonitorEngine.tick — slow monitors cannot hold a tick past its deadline', () => {
  // 26 polls run one after another, several taking ~30s, kept the daemon's
  // monitors tick past its 2-minute deadline on every boot, so the supervisor
  // exited the daemon every two minutes (PHNX-4225 follow-up).
  function writeSlow(count: number): string[] {
    const created = Array.from({ length: count }, () => uniq('slow'));
    for (const name of created) {
      writeMonitor(monitor({ name, source: { type: 'command', command: 'sleep 1; echo x' }, condition: { mode: 'every' } }));
    }
    return created;
  }
  const checked = (created: string[]): number => created.filter((name) => readLiveness(name) !== null).length;

  it('runs due polls concurrently instead of one after another', async () => {
    const created = writeSlow(8);
    try {
      const engine = new MonitorEngine();
      engine.start({ externalScheduler: true });
      const start = Date.now();
      await engine.tick();
      expect(Date.now() - start).toBeLessThan(4_000); // serial would be 8s
      expect(checked(created)).toBe(8);
    } finally {
      for (const name of created) deleteMonitor(name);
    }
  });

  it('launches nothing past the window and picks the skipped monitors up next tick', async () => {
    const created = writeSlow(8);
    try {
      const engine = new MonitorEngine();
      engine.start({ externalScheduler: true });
      const start = Date.now();
      await engine.tick(500);
      expect(Date.now() - start).toBeLessThan(2_500); // one round of four, no second launch
      expect(checked(created)).toBe(4);
      await engine.tick(500);
      expect(checked(created)).toBe(8);
    } finally {
      for (const name of created) deleteMonitor(name);
    }
  });
});

describe('shouldEscalateDrought', () => {
  it('escalates once a run of failed checks crosses the threshold', () => {
    expect(shouldEscalateDrought({ consecutiveErrors: 4 })).toBe(false);
    expect(shouldEscalateDrought({ consecutiveErrors: 5 })).toBe(true);
  });
  it('does not escalate again once notified for this drought', () => {
    expect(shouldEscalateDrought({ consecutiveErrors: 9, droughtNotifiedAt: '2026-01-01T00:00:00.000Z' })).toBe(false);
  });
});
