import { afterEach, beforeEach, describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  LINEAR_HOURLY_REQUEST_BUDGET,
  LINEAR_RATE_WINDOW_MS,
  linearRequestsInWindow,
  reserveLinearRequest,
  setLinearRateLimitDirForTest,
} from './linear-rate-limit.js';

let root: string;
let prevOverride: string | null;
const KEY = 'lin_api_test_key';
const OTHER_KEY = 'lin_api_other_key';
const T0 = new Date(2026, 7, 3, 12, 0, 0).getTime();

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'linear-rate-'));
  prevOverride = setLinearRateLimitDirForTest(root);
});
afterEach(() => {
  setLinearRateLimitDirForTest(prevOverride);
  fs.rmSync(root, { recursive: true, force: true });
});

describe('linear shared request budget', () => {
  it('reports zero for a key it has never seen', () => {
    expect(linearRequestsInWindow(KEY, T0)).toBe(0);
  });

  it('counts each reservation and allows up to the budget', () => {
    for (let i = 0; i < 5; i++) {
      expect(reserveLinearRequest(KEY, T0 + i)).toBe(true);
    }
    expect(linearRequestsInWindow(KEY, T0 + 5)).toBe(5);
  });

  it('denies once the hourly budget is spent, then re-allows as requests age out', () => {
    for (let i = 0; i < LINEAR_HOURLY_REQUEST_BUDGET; i++) {
      expect(reserveLinearRequest(KEY, T0)).toBe(true);
    }
    expect(reserveLinearRequest(KEY, T0 + 1)).toBe(false);
    expect(linearRequestsInWindow(KEY, T0 + 1)).toBe(LINEAR_HOURLY_REQUEST_BUDGET);

    const later = T0 + LINEAR_RATE_WINDOW_MS + 1;
    expect(linearRequestsInWindow(KEY, later)).toBe(0);
    expect(reserveLinearRequest(KEY, later)).toBe(true);
    expect(linearRequestsInWindow(KEY, later)).toBe(1);
  });

  it('sweeps only the stamps that have aged out, keeping the ones still in window', () => {
    reserveLinearRequest(KEY, T0);
    reserveLinearRequest(KEY, T0 + LINEAR_RATE_WINDOW_MS - 10);
    const now = T0 + LINEAR_RATE_WINDOW_MS + 5;
    expect(linearRequestsInWindow(KEY, now)).toBe(1);
  });

  it('budgets each key independently — one key exhausted does not throttle another', () => {
    for (let i = 0; i < LINEAR_HOURLY_REQUEST_BUDGET; i++) {
      reserveLinearRequest(KEY, T0);
    }
    expect(reserveLinearRequest(KEY, T0)).toBe(false);
    expect(linearRequestsInWindow(OTHER_KEY, T0)).toBe(0);
    expect(reserveLinearRequest(OTHER_KEY, T0)).toBe(true);
  });

  it('coordinates across independent module invocations sharing the same dir (the cross-process case)', () => {
    expect(reserveLinearRequest(KEY, T0)).toBe(true);
    expect(reserveLinearRequest(KEY, T0)).toBe(true);
    expect(linearRequestsInWindow(KEY, T0)).toBe(2);
  });

  it('fails OPEN when the cache dir cannot be written — the request still goes out', () => {
    const asFile = path.join(root, 'not-a-dir');
    fs.writeFileSync(asFile, '');
    setLinearRateLimitDirForTest(path.join(asFile, 'under-a-file'));
    expect(reserveLinearRequest(KEY, T0)).toBe(true);
    expect(linearRequestsInWindow(KEY, T0)).toBe(0);
  });

  it('never writes the raw API key into the on-disk path', () => {
    reserveLinearRequest(KEY, T0);
    const walk = (dir: string): string[] =>
      fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
        e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)],
      );
    for (const p of walk(root)) {
      expect(p).not.toContain(KEY);
    }
  });
});
