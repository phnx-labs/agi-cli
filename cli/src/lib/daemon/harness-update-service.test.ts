import { afterEach, describe, expect, it, vi } from 'vitest';
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { createRequire } from 'module';
import type { DaemonContext } from './service.js';
import {
  driveCooperativeChild,
  runHarnessUpdateTick,
  type HarnessUpdateDeps,
} from './harness-update-service.js';

const LEAF_PATH = new URL('../installations/update-cancellation.ts', import.meta.url).href;
const TSX_URL = pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href;
const CLI_ROOT = fileURLToPath(new URL('../../../', import.meta.url));

function fakeCtx(): { ctx: DaemonContext; logs: Array<{ level: string; message: string }> } {
  const logs: Array<{ level: string; message: string }> = [];
  return { ctx: { log: (level, message) => logs.push({ level, message }) }, logs };
}

describe('runHarnessUpdateTick', () => {
  it('a clean pass (exit 0) logs INFO and reports ran:true', async () => {
    const { ctx, logs } = fakeCtx();
    const deps: HarnessUpdateDeps = {
      runAutoUpdatePass: vi.fn().mockResolvedValue({ exitCode: 0, stdout: '{"outcomes":[]}', cancelled: false }),
    };

    const outcome = await runHarnessUpdateTick(ctx, new AbortController().signal, deps);

    expect(outcome).toEqual({ ran: true, exitCode: 0, stdout: '{"outcomes":[]}', cancelled: false });
    expect(logs.some((l) => l.level === 'INFO' && l.message.includes('completed'))).toBe(true);
    expect(logs.some((l) => l.level === 'ERROR' || l.level === 'WARN')).toBe(false);
  });

  it('a cancelled pass (exit 0, cancelled) logs the safe-boundary stop, not a plain completion', async () => {
    const { ctx, logs } = fakeCtx();
    const deps: HarnessUpdateDeps = {
      runAutoUpdatePass: vi.fn().mockResolvedValue({ exitCode: 0, stdout: '{"cancelled":true}', cancelled: true }),
    };

    const outcome = await runHarnessUpdateTick(ctx, new AbortController().signal, deps);

    expect(outcome.ran).toBe(true);
    expect(outcome.cancelled).toBe(true);
    expect(logs.some((l) => l.level === 'INFO' && l.message.includes('cancelled at a safe boundary'))).toBe(true);
    expect(logs.some((l) => l.level === 'ERROR' || l.level === 'WARN')).toBe(false);
  });

  it('a pass with per-installation errors (non-zero exit) logs WARN but still reports ran:true — it is not a service failure', async () => {
    const { ctx, logs } = fakeCtx();
    const deps: HarnessUpdateDeps = {
      runAutoUpdatePass: vi.fn().mockResolvedValue({ exitCode: 1, stdout: 'claude@2.0.65: npm install timed out', cancelled: false }),
    };

    const outcome = await runHarnessUpdateTick(ctx, new AbortController().signal, deps);

    expect(outcome.ran).toBe(true);
    expect(outcome.exitCode).toBe(1);
    expect(logs.some((l) => l.level === 'WARN' && l.message.includes('npm install timed out'))).toBe(true);
  });

  it('a genuine failure to run the pass at all (spawn error, force-reap) logs ERROR and reports ran:false, never throws', async () => {
    const { ctx, logs } = fakeCtx();
    const deps: HarnessUpdateDeps = {
      runAutoUpdatePass: vi.fn().mockRejectedValue(new Error('spawn agents ENOENT')),
    };

    const outcome = await runHarnessUpdateTick(ctx, new AbortController().signal, deps);

    expect(outcome).toEqual({ ran: false, reason: 'spawn agents ENOENT' });
    expect(logs.some((l) => l.level === 'ERROR' && l.message.includes('spawn agents ENOENT'))).toBe(true);
  });

  it('threads the supervisor-provided AbortSignal into the pass — the tick must be abortable, not fire-and-forget', async () => {
    const { ctx } = fakeCtx();
    const controller = new AbortController();
    let observedSignal: AbortSignal | undefined;
    const deps: HarnessUpdateDeps = {
      runAutoUpdatePass: vi.fn((signal: AbortSignal) => {
        observedSignal = signal;
        return Promise.resolve({ exitCode: 0, stdout: '', cancelled: false });
      }),
    };

    await runHarnessUpdateTick(ctx, controller.signal, deps);

    expect(observedSignal).toBe(controller.signal);
  });
});

const tempDirs: string[] = [];
function tmp(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}
function writeFixture(source: string): string {
  const file = path.join(tmp('agents-hus-fix-'), 'fixture.mts');
  fs.writeFileSync(file, source);
  return file;
}
afterEach(() => { while (tempDirs.length) fs.rmSync(tempDirs.pop()!, { recursive: true, force: true }); });

const COOP_FIXTURE = `
import { withGuardedUpdateCancellation } from ${JSON.stringify(LEAF_PATH)};
await withGuardedUpdateCancellation(async (cancelled) => {
  while (!cancelled()) await new Promise((r) => setTimeout(r, 20));
});
process.stdout.write(JSON.stringify({ v: 1, cancelled: true }));
process.exit(0);
`;

const WEDGED_FIXTURE = `await new Promise((r) => setTimeout(r, 60_000));`;

describe('driveCooperativeChild (real subprocess)', () => {
  it('on abort, sends an IPC cancel (not a kill) and resolves on the child\'s true exit', async () => {
    const controller = new AbortController();
    const started = Date.now();
    const result = driveCooperativeChild(process.execPath, ['--import', TSX_URL, writeFixture(COOP_FIXTURE)], controller.signal, 5_000);
    controller.abort();

    const settled = await result;
    expect(settled.exitCode).toBe(0);
    expect(settled.cancelled).toBe(true);
    expect(settled.stdout).toContain('"cancelled":true');
    expect(Date.now() - started).toBeLessThan(5_000);
  }, 30_000);

  it('force-reaps and REJECTS a wedged child that ignores the cancel — the orphan backstop, reported as failure', async () => {
    const controller = new AbortController();
    const graceMs = 400;
    const result = driveCooperativeChild(process.execPath, ['--import', TSX_URL, writeFixture(WEDGED_FIXTURE)], controller.signal, graceMs);
    controller.abort();

    await expect(result).rejects.toThrow(/force-reaped after 400ms grace/);
  }, 30_000);

  it('a non-zero exit with no kill RESOLVES — a per-installation vendor error is a normal tick outcome', async () => {
    const controller = new AbortController();
    const fixture = writeFixture(`process.stdout.write('boom'); process.exit(1);`);
    const settled = await driveCooperativeChild(process.execPath, ['--import', TSX_URL, fixture], controller.signal, 5_000);
    expect(settled.exitCode).toBe(1);
    expect(settled.cancelled).toBe(false);
    expect(settled.stdout).toContain('boom');
  }, 30_000);

  it('rejects a spawn failure (missing binary) rather than reading it as a clean pass', async () => {
    const controller = new AbortController();
    await expect(driveCooperativeChild('definitely-not-a-real-binary-xyz', [], controller.signal, 5_000))
      .rejects.toThrow();
  }, 30_000);

  it('drives the REAL __harness-update-run verb end-to-end to completion (empty home = clean no-op pass)', async () => {
    const home = tmp('agents-hus-home-');
    const controller = new AbortController();
    const settled = await driveCooperativeChild(
      process.execPath,
      ['--import', TSX_URL, 'src/index.ts', '__harness-update-run'],
      controller.signal,
      30_000,
      { cwd: CLI_ROOT, env: { ...process.env, HOME: home, USERPROFILE: home } },
    );
    expect(settled.exitCode).toBe(0);
    const summary = JSON.parse(settled.stdout);
    expect(summary.v).toBe(1);
    expect(summary.cancelled).toBe(false);
    expect(Array.isArray(summary.outcomes)).toBe(true);
  }, 60_000);
});
