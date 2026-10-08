import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runProcess } from './process.js';

const directories: string[] = [];
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});

describe('recording subprocess cancellation', () => {
  it('terminates a real in-flight child before it can finish its work', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'recording-process-'));
    directories.push(directory);
    const marker = path.join(directory, 'finished');
    const controller = new AbortController();
    const running = runProcess(process.execPath, [
      '-e',
      `setTimeout(() => require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'done'), 500); setInterval(() => {}, 1000);`,
    ], { signal: controller.signal });
    await sleep(50);
    controller.abort();

    await expect(running).rejects.toMatchObject({ name: 'AbortError' });
    await sleep(600);
    await expect(fs.stat(marker)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
