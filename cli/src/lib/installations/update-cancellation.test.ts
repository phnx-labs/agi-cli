import { afterEach, describe, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { createRequire } from 'module';
import {
  cancelMessage,
  isGuardedAutoUpdateActive,
  withGuardedUpdateCancellation,
} from './update-cancellation.js';

const LEAF_PATH = new URL('./update-cancellation.ts', import.meta.url).href;
const TSX_URL = pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href;
const INDEX_SRC_PATH = fileURLToPath(new URL('../../index.ts', import.meta.url));
const IS_WIN = process.platform === 'win32';

const tempDirs: string[] = [];
function tmp(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function writeFixture(source: string): string {
  const dir = tmp('agents-cancel-fix-');
  const file = path.join(dir, 'fixture.mts');
  fs.writeFileSync(file, source);
  return file;
}

afterEach(() => {
  while (tempDirs.length) fs.rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

const tick = () => new Promise<void>((r) => setTimeout(r, 5));

describe('withGuardedUpdateCancellation (in-process wiring)', () => {
  it('holds the guard for the pass duration and releases it after', async () => {
    expect(isGuardedAutoUpdateActive()).toBe(false);
    let guardedDuringRun = false;
    const result = await withGuardedUpdateCancellation(async () => {
      guardedDuringRun = isGuardedAutoUpdateActive();
      return 'done';
    });
    expect(result).toBe('done');
    expect(guardedDuringRun).toBe(true);
    expect(isGuardedAutoUpdateActive()).toBe(false);
  });

  it('releases the guard even when the pass throws', async () => {
    await expect(withGuardedUpdateCancellation(async () => { throw new Error('boom'); }))
      .rejects.toThrow('boom');
    expect(isGuardedAutoUpdateActive()).toBe(false);
  });

  it('an IPC cancel message flips cancelled() mid-pass', async () => {
    let cancelledObserved = false;
    const done = withGuardedUpdateCancellation(async (cancelled) => {
      while (!cancelled()) await tick();
      cancelledObserved = cancelled();
      return 'ok';
    });
    await tick();
    (process as NodeJS.EventEmitter).emit('message', { type: 'something-else' });
    await tick();
    expect(cancelledObserved).toBe(false);
    (process as NodeJS.EventEmitter).emit('message', cancelMessage());
    await expect(done).resolves.toBe('ok');
    expect(cancelledObserved).toBe(true);
  });

  it('a channel disconnect flips cancelled() (daemon went away)', async () => {
    const done = withGuardedUpdateCancellation(async (cancelled) => {
      while (!cancelled()) await tick();
      return 'stopped';
    });
    await tick();
    (process as NodeJS.EventEmitter).emit('disconnect');
    await expect(done).resolves.toBe('stopped');
  });
});

const LOOP_FIXTURE = `
import * as fs from 'fs';
import * as path from 'path';
import { withGuardedUpdateCancellation } from ${JSON.stringify(LEAF_PATH)};

const dir = process.argv[2];
const count = Number(process.argv[3]);

function nextMessage() {
  return new Promise((resolve) => process.once('message', resolve));
}

await withGuardedUpdateCancellation(async (cancelled) => {
  for (let i = 1; i <= count; i++) {
    if (cancelled()) break;                       // top-of-loop guard, mirrors the real pass
    const staging = path.join(dir, '.staging-' + i);
    fs.writeFileSync(staging, String(i));         // stage
    fs.renameSync(staging, path.join(dir, 'committed-' + i)); // atomic commit/record
    process.send({ committed: i });
    await nextMessage();                          // parent's cancel envelope also resolves this
  }
});
process.send({ done: true });
process.exit(0);
`;

interface LoopMsg { committed?: number; done?: boolean }

function spawnLoop(dir: string, count: number): ChildProcess {
  const fixture = writeFixture(LOOP_FIXTURE);
  return spawn(process.execPath, ['--import', TSX_URL, fixture, dir, String(count)], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
}

describe('real subprocess: IPC cancel stops the loop at a safe boundary', () => {
  it('starts cancelled when the IPC parent disconnects before the guard is installed', async () => {
    const fixture = writeFixture(`
      import { withGuardedUpdateCancellation } from ${JSON.stringify(LEAF_PATH)};
      process.send({ ready: true });
      await new Promise((r) => setTimeout(r, 100));
      const cancelled = await withGuardedUpdateCancellation(async (isCancelled) => isCancelled());
      process.stdout.write(JSON.stringify({ cancelled }));
      process.exit(0);
    `);
    const child = spawn(process.execPath, ['--import', TSX_URL, fixture], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    let stdout = '';
    child.stdout!.on('data', (data) => { stdout += data.toString(); });
    const exit = new Promise<number | null>((resolve) => child.on('exit', resolve));
    const drained = new Promise<void>((resolve) => child.stdout!.on('end', resolve));
    child.once('message', () => child.disconnect());
    expect(await exit).toBe(0);
    await drained;
    expect(JSON.parse(stdout)).toEqual({ cancelled: true });
  }, 10_000);

  it('after cancel, the in-flight commit finishes and NO second transaction starts', async () => {
    const dir = tmp('agents-cancel-loop-');
    const child = spawnLoop(dir, 5);
    const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
      child.on('close', (code, signal) => resolve({ code, signal }));
    });
    child.on('message', (m: LoopMsg) => {
      if (m.committed === 1) child.send(cancelMessage());
    });
    const { code, signal } = await exit;

    expect(signal).toBeNull();
    expect(code).toBe(0);
    expect(fs.existsSync(path.join(dir, 'committed-1'))).toBe(true);
    expect(fs.existsSync(path.join(dir, 'committed-2'))).toBe(false);
    expect(fs.readdirSync(dir).filter((e) => e.startsWith('.staging-'))).toEqual([]);
    expect(fs.readdirSync(dir).filter((e) => e.startsWith('committed-'))).toEqual(['committed-1']);
  }, 30_000);

  it('control: with no cancel every item commits — the stop above is caused by the cancel, not the harness', async () => {
    const dir = tmp('agents-cancel-loop-ctl-');
    const child = spawnLoop(dir, 4);
    let done = false;
    const exit = new Promise<number | null>((resolve) => child.on('close', (code) => resolve(code)));
    child.on('message', (m: LoopMsg) => {
      if (m.done) { done = true; return; }
      if (m.committed) child.send({ ack: m.committed });
    });
    const code = await exit;

    expect(code).toBe(0);
    expect(done).toBe(true);
    expect(fs.readdirSync(dir).filter((e) => e.startsWith('committed-')).sort())
      .toEqual(['committed-1', 'committed-2', 'committed-3', 'committed-4']);
  }, 30_000);
});

const SIGINT_FIXTURE = `
import { withGuardedUpdateCancellation, isGuardedAutoUpdateActive } from ${JSON.stringify(LEAF_PATH)};

// Exactly what index.ts installs: defer the hard exit only while the guard holds.
process.on('SIGINT', () => {
  if (isGuardedAutoUpdateActive()) { process.send({ deferred: true }); return; }
  process.exit(130);
});

await withGuardedUpdateCancellation(async (cancelled) => {
  process.send({ guarded: isGuardedAutoUpdateActive() });
  while (!cancelled()) await new Promise((r) => setTimeout(r, 20)); // SIGINT cancels this cooperatively
  process.send({ leaving: true });
});
process.send({ unguarded: !isGuardedAutoUpdateActive() });
setInterval(() => {}, 1000); // keep a real handle alive for the parent's second SIGINT
`;

(IS_WIN ? describe.skip : describe)('real subprocess: index.ts SIGINT guard', () => {
  it('defers a SIGINT while the guarded pass runs, then exits 130 once released', async () => {
    const fixture = writeFixture(SIGINT_FIXTURE);
    const child = spawn(process.execPath, ['--import', TSX_URL, fixture], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    const messages: Record<string, unknown>[] = [];
    const exit = new Promise<number | null>((resolve) => child.on('close', (code) => resolve(code)));

    const waitFor = (key: string) => new Promise<void>((resolve) => {
      const handler = (m: Record<string, unknown>) => {
        messages.push(m);
        if (key in m) { child.off('message', handler); resolve(); }
      };
      child.on('message', handler);
    });

    await waitFor('guarded');
    expect(messages.find((m) => 'guarded' in m)?.guarded).toBe(true);

    const releasedAndAlive = waitFor('unguarded');
    child.kill('SIGINT');
    await releasedAndAlive;
    expect(messages.some((m) => m.deferred === true)).toBe(true);
    expect(messages.some((m) => m.leaving === true)).toBe(true);
    expect(messages.find((m) => 'unguarded' in m)?.unguarded).toBe(true);

    child.kill('SIGINT');
    expect(await exit).toBe(130);
  }, 30_000);

  it('index.ts installs a SIGINT handler that reads the guard symbol and defers on it', () => {
    const src = fs.readFileSync(INDEX_SRC_PATH, 'utf-8');
    expect(src).toMatch(/process\.on\('SIGINT'/);
    expect(src).toContain("Symbol.for('agents.guardedAutoUpdateDepth')");
    expect(src).toMatch(/if \(depth > 0\) return;/);
    expect(src).toMatch(/process\.exit\(130\)/);
  });
});
