import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PROCESS_START_CACHE_TTL_MS, processStartMs } from './active.js';

const unix = process.platform === 'win32' ? describe.skip : describe;

unix('processStartMs — one ps spawn per pid per TTL (PHNX-4225)', () => {
  let dir: string;
  let log: string;
  let savedPath: string | undefined;

  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ps-cache-'));
    log = path.join(dir, 'ps.log');
    const realPs = execFileSync('sh', ['-c', 'command -v ps'], { encoding: 'utf-8' }).trim();
    fs.writeFileSync(path.join(dir, 'ps'), `#!/bin/sh\necho "$@" >> "${log}"\nexec "${realPs}" "$@"\n`, { mode: 0o755 });
    savedPath = process.env.PATH;
    process.env.PATH = `${dir}:${savedPath}`;
  });

  afterAll(() => {
    process.env.PATH = savedPath;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('reads a live pid start time once and serves repeats from the cache until the TTL passes', () => {
    const pid = process.pid;
    const t0 = 1_000_000;
    const first = processStartMs(pid, t0);
    expect(first).not.toBeNull();
    expect(processStartMs(pid, t0 + 1_000)).toBe(first);
    expect(processStartMs(pid, t0 + PROCESS_START_CACHE_TTL_MS - 1)).toBe(first);
    expect(fs.readFileSync(log, 'utf-8').trim().split('\n')).toHaveLength(1);
    expect(processStartMs(pid, t0 + PROCESS_START_CACHE_TTL_MS)).toBe(first);
    expect(fs.readFileSync(log, 'utf-8').trim().split('\n')).toHaveLength(2);
  });
});
