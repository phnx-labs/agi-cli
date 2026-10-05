import { LRUCache } from 'lru-cache';

export interface MemoryCacheOptions<K extends {} = string, V extends {} = {}> {
  max: number;
  ttlMs: number;
  fetchMethod?: (key: K, staleValue: V | undefined) => Promise<V>;
  now?: () => number;
}

export function createMemoryCache<K extends {}, V extends {}>(
  options: MemoryCacheOptions<K, V>,
): LRUCache<K, V> {
  if (!Number.isSafeInteger(options.max) || options.max < 1) {
    throw new Error('memory cache max must be a positive integer');
  }
  if (!Number.isFinite(options.ttlMs) || options.ttlMs <= 0) {
    throw new Error('memory cache ttlMs must be positive');
  }

  return new LRUCache<K, V>({
    max: options.max,
    ttl: options.ttlMs,
    allowStale: false,
    updateAgeOnGet: false,
    updateAgeOnHas: false,
    ttlAutopurge: false,
    ttlResolution: options.now ? 0 : 1,
    fetchMethod: options.fetchMethod
      ? async (key, staleValue) => options.fetchMethod!(key, staleValue)
      : undefined,
    perf: options.now ? { now: options.now } : undefined,
  });
}
