import { describe, expect, it } from 'vitest';

import { createMemoryCache } from './memory-cache.js';

describe('createMemoryCache', () => {
  it('expires entries without returning or extending stale values', () => {
    let now = 100;
    const cache = createMemoryCache<string, string>({ max: 2, ttlMs: 10, now: () => now });

    cache.set('a', 'value');
    now = 109;
    expect(cache.get('a')).toBe('value');
    now = 111;
    expect(cache.get('a')).toBeUndefined();
  });

  it('evicts the least-recently-used entry at the hard bound', () => {
    const cache = createMemoryCache<string, string>({ max: 2, ttlMs: 1_000 });
    cache.set('a', 'one');
    cache.set('b', 'two');
    cache.get('a');
    cache.set('c', 'three');

    expect(cache.has('a')).toBe(true);
    expect(cache.has('b')).toBe(false);
    expect(cache.has('c')).toBe(true);
  });

  it('coalesces concurrent fetches for the same key', async () => {
    let loads = 0;
    const cache = createMemoryCache<string, string>({
      max: 2,
      ttlMs: 1_000,
      fetchMethod: async (key) => {
        loads++;
        await Promise.resolve();
        return `loaded:${key}`;
      },
    });

    const [first, second] = await Promise.all([cache.fetch('a'), cache.fetch('a')]);
    expect(first).toBe('loaded:a');
    expect(second).toBe('loaded:a');
    expect(loads).toBe(1);
  });
});
