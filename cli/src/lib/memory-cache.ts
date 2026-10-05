import { LRUCache } from 'lru-cache';

export interface MemoryCacheOptions<K extends {} = string, V extends {} = {}> {
  /** Hard entry bound. A cache without a bound is not allowed. */
  max: number;
  /** Milliseconds before an entry is treated as absent. */
  ttlMs: number;
  /** Optional async loader. Concurrent fetches for one key are coalesced. */
  fetchMethod?: (key: K, staleValue: V | undefined) => Promise<V>;
  /** Injectable monotonic clock for deterministic TTL tests. */
  now?: () => number;
}

/** Correctness-first process-local cache: always bounded, never returns stale values, reads don't
 * extend an entry's life. Durable or cross-process state belongs in SQLite or an atomic on-disk
 * snapshot. */
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
    // A supplied deterministic clock must be read on every operation; the
    // library's 1ms cached-now optimization follows wall time, not that clock.
    ttlResolution: options.now ? 0 : 1,
    fetchMethod: options.fetchMethod
      ? async (key, staleValue) => options.fetchMethod!(key, staleValue)
      : undefined,
    perf: options.now ? { now: options.now } : undefined,
  });
}
