import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { sessionFileTimes } from './active.js';


let dir: string;
let file: string;

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sesstimes-'));
  file = path.join(dir, 'session.jsonl');
  fs.writeFileSync(file, '{"first":1}\n');
});

afterAll(() => {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {  }
});

describe('sessionFileTimes', () => {
  it('returns a real last-write (mtime) for a live transcript', () => {
    const before = Date.now() + 1000;
    const { mtimeMs, birthtimeMs } = sessionFileTimes(file);
    expect(typeof mtimeMs).toBe('number');
    expect(mtimeMs!).toBeGreaterThan(0);
    expect(mtimeMs!).toBeLessThanOrEqual(before);
    if (birthtimeMs !== undefined) expect(birthtimeMs).toBeGreaterThan(0);
  });

  it('tracks the last write — a later append moves mtime forward', () => {
    const first = sessionFileTimes(file).mtimeMs!;
    const past = new Date(Date.now() - 120_000);
    fs.utimesSync(file, past, past);
    const rewound = sessionFileTimes(file).mtimeMs!;
    expect(rewound).toBeLessThan(first);
    fs.appendFileSync(file, '{"second":2}\n');
    const bumped = sessionFileTimes(file).mtimeMs!;
    expect(bumped).toBeGreaterThan(rewound);
  });

  it('returns nothing (never epoch 0) for an absent or undefined file', () => {
    expect(sessionFileTimes(undefined)).toEqual({});
    expect(sessionFileTimes(path.join(dir, 'does-not-exist.jsonl'))).toEqual({});
  });
});
