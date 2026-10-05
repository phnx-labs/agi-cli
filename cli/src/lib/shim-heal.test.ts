import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { computeShimNoticeSignature } from './shim-heal.js';

describe('computeShimNoticeSignature', () => {
  it('is empty when nothing is actionable', () => {
    expect(computeShimNoticeSignature({ shadowNotes: [], pathState: 'ok' })).toBe('');
  });

  it('encodes real-binary shadows, order-independent', () => {
    const a = computeShimNoticeSignature({ shadowNotes: ['claude: /a', 'codex: /b'], pathState: 'ok' });
    const b = computeShimNoticeSignature({ shadowNotes: ['codex: /b', 'claude: /a'], pathState: 'ok' });
    expect(a).toBe(b);
    expect(a).toContain('claude: /a');
  });

  it('distinguishes path states', () => {
    expect(computeShimNoticeSignature({ shadowNotes: [], pathState: 'added' }))
      .not.toBe(computeShimNoticeSignature({ shadowNotes: [], pathState: 'reload' }));
  });
});

describe('shouldSurfaceShimNotice (persistent, once per condition)', () => {
  let home: string;
  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'shim-notice-test-'));
    fs.mkdirSync(path.join(home, '.agents'), { recursive: true });
  });
  afterEach(() => { fs.rmSync(home, { recursive: true, force: true }); });

  function run(sequence: string[]): boolean[] {
    const modulePath = path.resolve(process.cwd(), 'src/lib/shim-heal.ts');
    const script = `
      import { shouldSurfaceShimNotice } from ${JSON.stringify(modulePath)};
      const seq = ${JSON.stringify(sequence)};
      console.log(JSON.stringify(seq.map((s) => shouldSurfaceShimNotice(s))));
    `;
    const out = execFileSync('bun', ['-e', script], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        HOME: home,
        AGENTS_STATE_DIR: path.join(home, '.agents', '.cache', 'state'),
      },
      stdio: ['ignore', 'pipe', 'inherit'],
    }).toString('utf-8');
    return JSON.parse(out);
  }

  it('surfaces a condition once, suppresses the identical repeat, re-surfaces on change, clears on empty', () => {
    const res = run(['shadow:claude=/x', 'shadow:claude=/x', 'shadow:codex=/y', '', 'shadow:claude=/x']);
    expect(res).toEqual([true, false, true, false, true]);
  });
});
