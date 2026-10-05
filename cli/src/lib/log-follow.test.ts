import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { followFile } from './log-follow.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('followFile', () => {
  it('emits existing content then streams appends', async () => {
    const f = path.join(os.tmpdir(), `follow-test-${process.pid}-${Date.now()}`);
    fs.writeFileSync(f, 'line1\n');
    const chunks: string[] = [];
    const stop = followFile(f, (t) => chunks.push(t), { intervalMs: 15 });
    try {
      await sleep(40);
      fs.appendFileSync(f, 'line2\n');
      for (let i = 0; i < 50 && !chunks.join('').includes('line2'); i++) await sleep(15);
    } finally {
      stop();
      fs.rmSync(f, { force: true });
    }
    const all = chunks.join('');
    expect(all).toContain('line1');
    expect(all).toContain('line2');
  });

  it('with fromEnd, skips existing content and only emits new appends', async () => {
    const f = path.join(os.tmpdir(), `follow-end-${process.pid}-${Date.now()}`);
    fs.writeFileSync(f, 'OLD\n');
    const chunks: string[] = [];
    const stop = followFile(f, (t) => chunks.push(t), { intervalMs: 15, fromEnd: true });
    try {
      await sleep(40);
      fs.appendFileSync(f, 'NEW\n');
      for (let i = 0; i < 50 && !chunks.join('').includes('NEW'); i++) await sleep(15);
    } finally {
      stop();
      fs.rmSync(f, { force: true });
    }
    const all = chunks.join('');
    expect(all).not.toContain('OLD');
    expect(all).toContain('NEW');
  });
});
