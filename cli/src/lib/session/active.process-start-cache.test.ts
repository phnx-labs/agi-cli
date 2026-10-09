import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PROCESS_START_CACHE_TTL_MS, processStartMs } from './active.js';

const unix = process.platform === 'win32' ? describe.skip : describe;

unix('processStartMs — one ps per TTL for the whole process table (PHNX-4225)', () => {
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

  it('reads every pid start time with one ps per TTL, not one per pid', () => {
    const calls = () => fs.readFileSync(log, 'utf-8').trim().split('\n');
    const t0 = 1_000_000;
    const self = processStartMs(process.pid, t0);
    expect(self).not.toBeNull();
    expect(processStartMs(process.ppid, t0 + 1_000)).not.toBeNull();
    expect(processStartMs(process.pid, t0 + PROCESS_START_CACHE_TTL_MS - 1)).toBe(self);
    expect(calls()).toEqual(['-A -o pid=,lstart=']);
    expect(processStartMs(process.pid, t0 + PROCESS_START_CACHE_TTL_MS)).toBe(self);
    expect(calls()).toEqual(['-A -o pid=,lstart=', '-A -o pid=,lstart=']);
  });
});
