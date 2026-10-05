import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createRequire } from 'module';
import { fileURLToPath, pathToFileURL } from 'url';
import type { DaemonContext } from './service.js';
import { driveCooperativeChild } from './harness-update-service.js';
import { readLastSelfHealAttempt, runSelfHealTick, type SelfHealDeps } from './self-heal-service.js';
import { SELF_HEAL_CHILD_CMD, selfHealCancelMessage } from '../self-heal/child.js';

const TSX_URL = pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href;
const CLI_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const SIX_HOURS = 6 * 60 * 60_000;

const tempDirs: string[] = [];
function tmp(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}
function writeFixture(source: string): string {
  const file = path.join(tmp('agents-selfheal-fix-'), 'fixture.mjs');
  fs.writeFileSync(file, source);
  return file;
}

function fakeCtx(): { ctx: DaemonContext; logs: Array<{ level: string; message: string }> } {
  const logs: Array<{ level: string; message: string }> = [];
  return { ctx: { log: (level, message) => logs.push({ level, message }) }, logs };
}

function busyChild(ms: number, summary: object): string {
  return writeFixture(`
const end = Date.now() + ${ms};
while (Date.now() < end) { /* synchronous work, like a byte-compare sweep */ }
process.stdout.write(${JSON.stringify(JSON.stringify(summary))});
process.exit(0);
`);
}

function depsFor(fixture: string, clock: { now: number }, calls: { n: number }): SelfHealDeps {
  return {
    runChild(signal) {
      calls.n++;
      return driveCooperativeChild(process.execPath, [fixture], signal, 5_000, {
        cancelMsg: selfHealCancelMessage(),
        label: 'self-heal',
      });
    },
    now: () => clock.now,
  };
}

let savedDaemonDir: string | undefined;
beforeEach(() => {
  savedDaemonDir = process.env.AGENTS_DAEMON_DIR;
  process.env.AGENTS_DAEMON_DIR = tmp('agents-selfheal-daemon-');
});
afterEach(() => {
  if (savedDaemonDir === undefined) delete process.env.AGENTS_DAEMON_DIR;
  else process.env.AGENTS_DAEMON_DIR = savedDaemonDir;
  while (tempDirs.length) fs.rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

describe('runSelfHealTick', () => {
  it('keeps the daemon event loop responsive while the pass burns CPU in its child', async () => {
    const summary = { v: 1, changed: true, needsAttention: false, summary: 'resources: 1 fixed' };
    const fixture = busyChild(1_500, summary);
    const { ctx, logs } = fakeCtx();

    let lastTick = Date.now();
    let maxGap = 0;
    const timer = setInterval(() => {
      const t = Date.now();
      maxGap = Math.max(maxGap, t - lastTick);
      lastTick = t;
    }, 20);
    const outcome = await runSelfHealTick(ctx, new AbortController().signal, depsFor(fixture, { now: Date.now() }, { n: 0 }));
    clearInterval(timer);

    expect(outcome).toMatchObject({ ran: true, exitCode: 0, cancelled: false, summary });
    expect(maxGap).toBeLessThan(400);
    expect(logs).toContainEqual({ level: 'INFO', message: 'self-heal: resources: 1 fixed' });
  }, 30_000);

  it('does not re-run after a daemon restart inside the interval, and runs again once it elapses', async () => {
    const fixture = busyChild(0, { v: 1, changed: false, needsAttention: false, summary: '' });
    const clock = { now: 1_800_000_000_000 };
    const calls = { n: 0 };

    expect((await runSelfHealTick(fakeCtx().ctx, new AbortController().signal, depsFor(fixture, clock, calls))).ran).toBe(true);
    expect(await readLastSelfHealAttempt()).toBe(clock.now);

    clock.now += 77_000;
    expect(await runSelfHealTick(fakeCtx().ctx, new AbortController().signal, depsFor(fixture, clock, calls)))
      .toEqual({ ran: false, reason: 'recent' });
    expect(calls.n).toBe(1);

    clock.now += SIX_HOURS - 77_000 - 5_000;
    expect((await runSelfHealTick(fakeCtx().ctx, new AbortController().signal, depsFor(fixture, clock, calls))).ran).toBe(true);
    expect(calls.n).toBe(2);
  }, 30_000);

  it('records the attempt before the child runs, so a pass that dies does not loop on restart', async () => {
    const crashing = writeFixture(`process.stderr.write('boom'); process.exit(3);`);
    const clock = { now: 1_800_000_000_000 };
    const calls = { n: 0 };
    const { ctx, logs } = fakeCtx();

    const first = await runSelfHealTick(ctx, new AbortController().signal, depsFor(crashing, clock, calls));
    expect(first).toEqual({ ran: true, exitCode: 3, cancelled: false });
    expect(logs.some((l) => l.level === 'WARN' && l.message.includes('exited 3'))).toBe(true);

    clock.now += 60_000;
    expect((await runSelfHealTick(ctx, new AbortController().signal, depsFor(crashing, clock, calls))).ran).toBe(false);
    expect(calls.n).toBe(1);
  }, 30_000);

  it('does not run, and says why, when the attempt cannot be recorded', async () => {
    const dir = process.env.AGENTS_DAEMON_DIR!;
    fs.mkdirSync(path.join(dir, 'self-heal-last-attempt'));
    const calls = { n: 0 };
    const { ctx, logs } = fakeCtx();
    expect(await runSelfHealTick(ctx, new AbortController().signal, depsFor(busyChild(0, {}), { now: Date.now() }, calls)))
      .toEqual({ ran: false, reason: 'stamp-unwritable' });
    expect(calls.n).toBe(0);
    expect(logs.some((l) => l.level === 'ERROR' && l.message.includes('cannot record the attempt'))).toBe(true);
  });

  it('skips without spawning when the daemon state dir is gone', async () => {
    process.env.AGENTS_DAEMON_DIR = path.join(tmp('agents-selfheal-gone-'), 'missing');
    const calls = { n: 0 };
    const fixture = busyChild(0, {});
    expect(await runSelfHealTick(fakeCtx().ctx, new AbortController().signal, depsFor(fixture, { now: Date.now() }, calls)))
      .toEqual({ ran: false, reason: 'no-daemon-dir' });
    expect(calls.n).toBe(0);
  });
});

describe(`${SELF_HEAL_CHILD_CMD} (real verb)`, () => {
  it('runs a safe-mode pass in its own process and prints the summary the daemon logs', async () => {
    const home = tmp('agents-selfheal-home-');
    const settled = await driveCooperativeChild(
      process.execPath,
      ['--import', TSX_URL, 'src/index.ts', SELF_HEAL_CHILD_CMD],
      new AbortController().signal,
      30_000,
      { cwd: CLI_ROOT, env: { ...process.env, HOME: home, USERPROFILE: home }, cancelMsg: selfHealCancelMessage(), label: 'self-heal' },
    );
    expect(settled.exitCode).toBe(0);
    const summary = JSON.parse(settled.stdout);
    expect(summary.v).toBe(1);
    expect(typeof summary.changed).toBe('boolean');
    expect(typeof summary.needsAttention).toBe('boolean');
    expect(typeof summary.summary).toBe('string');
  }, 120_000);
});
