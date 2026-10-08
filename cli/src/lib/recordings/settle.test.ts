import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { RecordingSettler } from './settle.js';

const directories: string[] = [];
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});

describe('RecordingSettler', () => {
  it('does not discover files created before the watcher was enabled', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'recording-settle-'));
    directories.push(directory);
    const file = path.join(directory, 'CleanShot old.mp4');
    await fs.writeFile(file, Buffer.alloc(32));
    const stat = await fs.stat(file);
    const settler = new RecordingSettler({ settleMs: 0, sessionsAt: async () => undefined });

    const scan = await settler.scan(directory, { notBeforeMs: stat.birthtimeMs + 1 });

    expect(scan.latest).toHaveLength(0);
    expect(scan.ready).toHaveLength(0);
  });

  it('waits for a real growing file to remain unchanged for the settle window', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'recording-settle-'));
    directories.push(directory);
    const file = path.join(directory, 'CleanShot 2026-10-08 at 4.51.47 AM.mp4');
    await fs.writeFile(file, Buffer.alloc(32));
    const settler = new RecordingSettler({ settleMs: 80, sessionsAt: async () => undefined });

    expect((await settler.scan(directory)).ready).toHaveLength(0);
    await sleep(45);
    await fs.appendFile(file, Buffer.alloc(32));
    expect((await settler.scan(directory)).ready).toHaveLength(0);
    await sleep(45);
    expect((await settler.scan(directory)).ready).toHaveLength(0);
    await sleep(45);

    const settled = await settler.scan(directory);
    expect(settled.ready).toHaveLength(1);
    expect(settled.ready[0]).toMatchObject({ path: file, size: 64 });
    expect((await settler.scan(directory)).ready).toHaveLength(0);
  });
});
