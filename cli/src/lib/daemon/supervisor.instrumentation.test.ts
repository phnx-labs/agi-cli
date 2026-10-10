import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ServiceSupervisor } from './supervisor.js';
import { installSpanLog, spanSync, type LogFields } from './diagnostics.js';
import type { DaemonContext, PeriodicService, ServiceHealth } from './service.js';
import type { DaemonServiceId } from '../daemon-services.js';

interface Line { level: string; message: string; fields?: Record<string, unknown> }

let daemonDir = '';
const originalDaemonDir = process.env.AGENTS_DAEMON_DIR;

beforeEach(() => {
  daemonDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-supervisor-instr-'));
  process.env.AGENTS_DAEMON_DIR = daemonDir;
});

afterEach(() => {
  installSpanLog(null);
  if (originalDaemonDir === undefined) delete process.env.AGENTS_DAEMON_DIR;
  else process.env.AGENTS_DAEMON_DIR = originalDaemonDir;
  fs.rmSync(daemonDir, { recursive: true, force: true });
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function blockFor(ms: number): void {
  const until = Date.now() + ms;
  while (Date.now() < until);
}

class TimedService implements PeriodicService {
  readonly intervalMs = 60_000;
  constructor(readonly id: DaemonServiceId, readonly deadlineMs: number, private readonly body: () => Promise<void>) {}
  async start(): Promise<void> {}
  async stop(): Promise<void> {}
  async restart(): Promise<void> {}
  async tick(): Promise<void> { await this.body(); }
  health(): ServiceHealth { return { state: 'running', lastRunMs: 0, consecutiveFailures: 0 }; }
}

function capture(): { lines: Line[]; ctx: DaemonContext } {
  const lines: Line[] = [];
  return { lines, ctx: { log: (level, message, fields) => { lines.push({ level, message, fields }); } } };
}

describe('ServiceSupervisor instrumentation', () => {
  it('a tick over half its deadline is a tick.slow warning with its duration and what else was in flight', async () => {
    const { lines, ctx } = capture();
    const sup = new ServiceSupervisor({ exit: (() => {}) as never });
    sup.register(new TimedService('watchdog', 300, () => sleep(200)));
    sup.register(new TimedService('device-probe', 5_000, () => sleep(400)));
    await sup.startAll(ctx);
    await sleep(300);
    await sup.stopAll();
    const slow = lines.find((l) => l.fields?.event === 'tick.slow');
    expect(slow?.level).toBe('WARN');
    expect(slow?.fields).toMatchObject({ service: 'watchdog', deadlineMs: 300 });
    expect(slow?.fields?.durMs as number).toBeGreaterThanOrEqual(150);
    expect(slow?.fields?.inFlight).toContainEqual(expect.objectContaining({ service: 'device-probe' }));
  });

  it('a fast tick is logged at debug with its duration, so debug traces every tick', async () => {
    const { lines, ctx } = capture();
    const sup = new ServiceSupervisor({ exit: (() => {}) as never });
    sup.register(new TimedService('watchdog', 5_000, async () => {}));
    await sup.startAll(ctx);
    await sleep(20);
    await sup.stopAll();
    expect(lines.map((l) => [l.level, l.fields?.event])).toEqual(expect.arrayContaining([['DEBUG', 'tick.start'], ['DEBUG', 'tick.ok']]));
  });

  it('a throwing tick is a tick.failed warning carrying the error and duration', async () => {
    const { lines, ctx } = capture();
    const sup = new ServiceSupervisor({ exit: (() => {}) as never });
    sup.register(new TimedService('watchdog', 5_000, async () => { throw new Error('probe refused'); }));
    await sup.startAll(ctx);
    await sleep(20);
    await sup.stopAll();
    const failed = lines.find((l) => l.fields?.event === 'tick.failed');
    expect(failed?.fields).toMatchObject({ service: 'watchdog', error: 'probe refused', consecutiveFailures: 1 });
    expect(typeof failed?.fields?.durMs).toBe('number');
  });

  it('a breach logs a snapshot naming the in-flight ticks, the synchronous section that held the loop, and the daemon vitals', async () => {
    const { lines, ctx } = capture();
    installSpanLog(ctx.log as (level: never, message: string, fields?: LogFields) => void, { slowSyncMs: 10_000 });
    let exitCode: number | undefined;
    const sup = new ServiceSupervisor({
      exit: ((code: number) => { exitCode = code; }) as never,
      diagnostics: () => ({ vitals: { cpuPct: 99 } }),
    });
    sup.register(new TimedService('attention-notify', 250, () => new Promise(() => {})));
    sup.register(new TimedService('session-state', 10_000, () => sleep(2_000)));
    await sup.startAll(ctx);
    setTimeout(() => spanSync('feed.tools.collect-test', () => blockFor(150)), 20);
    await sleep(500);
    await sup.stopAll();

    expect(exitCode).toBe(70);
    const breach = lines.find((l) => l.level === 'ERROR' && l.fields?.event === 'tick.breach');
    expect(breach?.message).toContain("service 'attention-notify' breached its deadline");
    expect(breach?.fields).toMatchObject({ service: 'attention-notify', vitals: { cpuPct: 99 } });
    expect(breach?.fields?.elapsedMs as number).toBeGreaterThanOrEqual(250);
    expect(breach?.fields?.inFlight).toContainEqual(expect.objectContaining({ service: 'session-state' }));
    expect((breach?.fields?.syncSpansDuringTick as Array<{ span: string; durMs: number }>)[0]).toMatchObject({ span: 'feed.tools.collect-test' });
  });
});
