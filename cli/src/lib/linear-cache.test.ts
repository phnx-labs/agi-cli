import { afterEach, beforeEach, describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  LINEAR_CACHE_TTL_MS,
  invalidateCached,
  isRateLimited,
  noteRateLimited,
  parseRateLimitReset,
  readCached,
  writeCached,
} from './linear-cache.js';

let home: string;
let cacheFile: string;
const T0 = new Date(2026, 7, 3, 12, 0, 0).getTime();


beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'linear-cache-'));
  cacheFile = path.join(home, 'cache');
  process.env.AGENTS_LINEAR_CACHE_PATH = cacheFile;
});
afterEach(() => {
  delete process.env.AGENTS_LINEAR_CACHE_PATH;
  fs.rmSync(home, { recursive: true, force: true });
});

describe('linear cache', () => {
  it('returns nothing for a project it has never seen', () => {
    expect(readCached('p1', T0)).toBeUndefined();
  });

  it('round-trips a value and reports it fresh inside the TTL', () => {
    writeCached('p1', { progress: 0.88, scope: 419 }, T0);
    const hit = readCached<{ progress: number; scope: number }>('p1', T0 + 60_000);
    expect(hit?.value).toEqual({ progress: 0.88, scope: 419 });
    expect(hit?.stale).toBe(false);
    expect(hit?.ageMs).toBe(60_000);
  });

  it('KEEPS serving past the TTL, flagged stale, rather than vanishing', () => {
    writeCached('p1', { progress: 0.88 }, T0);
    const hit = readCached<{ progress: number }>('p1', T0 + LINEAR_CACHE_TTL_MS + 1);
    expect(hit?.value).toEqual({ progress: 0.88 });
    expect(hit?.stale).toBe(true);
  });

  it('keeps entries separate per project', () => {
    writeCached('p1', 'one', T0);
    writeCached('p2', 'two', T0);
    expect(readCached<string>('p1', T0)?.value).toBe('one');
    expect(readCached<string>('p2', T0)?.value).toBe('two');
  });

  it('honours a 429 reset time, then lifts', () => {
    expect(isRateLimited(T0)).toBe(false);
    noteRateLimited(T0 + 30 * 60_000, T0);
    expect(isRateLimited(T0 + 60_000)).toBe(true);
    expect(isRateLimited(T0 + 31 * 60_000)).toBe(false);
  });

  it('backs off for one TTL when the 429 carried no usable reset header', () => {
    noteRateLimited(undefined, T0);
    expect(isRateLimited(T0 + LINEAR_CACHE_TTL_MS - 1)).toBe(true);
    expect(isRateLimited(T0 + LINEAR_CACHE_TTL_MS + 1)).toBe(false);
    noteRateLimited(T0 - 5, T0);
    expect(isRateLimited(T0 + LINEAR_CACHE_TTL_MS - 1)).toBe(true);
  });

  it('parses a usable 429 reset header, and rejects the rest', () => {
    expect(parseRateLimitReset(String(T0 + 30 * 60_000), T0)).toBe(T0 + 30 * 60_000);
    expect(parseRateLimitReset(null, T0)).toBeUndefined();
    expect(parseRateLimitReset('soon', T0)).toBeUndefined();
    expect(parseRateLimitReset('', T0)).toBeUndefined();
    expect(parseRateLimitReset(String(T0 - 1), T0)).toBeUndefined();
  });

  it('invalidates one project without disturbing the rest', () => {
    writeCached('p1', 'one', T0);
    writeCached('p2', 'two', T0);
    invalidateCached('p1');
    expect(readCached('p1', T0)).toBeUndefined();
    expect(readCached<string>('p2', T0)?.value).toBe('two');
    expect(() => invalidateCached('nope')).not.toThrow();
  });

  it('treats a corrupt cache file as an empty one instead of throwing', () => {
    writeCached('p1', 'one', T0);
    fs.writeFileSync(path.join(cacheFile, 'p1.json'), '{not json');
    expect(readCached('p1', T0)).toBeUndefined();
    expect(isRateLimited(T0)).toBe(false);
    writeCached('p1', 'again', T0);
    expect(readCached<string>('p1', T0)?.value).toBe('again');
  });

  it('rejects a wrong-shaped entry rather than handing it to the card', () => {
    fs.mkdirSync(cacheFile, { recursive: true });
    fs.writeFileSync(path.join(cacheFile, 'p9.json'), JSON.stringify({ nope: true }));
    expect(readCached('p9', T0)).toBeUndefined();
  });

  it('keeps a project id from escaping the cache directory', () => {
    writeCached('../../escape', 'x', T0);
    expect(fs.existsSync(path.join(cacheFile, '.._.._escape.json'))).toBe(true);
    expect(readCached<string>('../../escape', T0)?.value).toBe('x');
  });

  it('survives concurrent writers of distinct keys', () => {
    for (let i = 0; i < 40; i++) writeCached(`a-${i}`, i, T0);
    for (let i = 0; i < 40; i++) writeCached(`b-${i}`, i, T0);
    const survived = fs.readdirSync(cacheFile).filter((f) => f.endsWith('.json')).length;
    expect(survived).toBe(80);
  });
});
