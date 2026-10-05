interface BoundedMapOptions {
  concurrency: number;
  staggerMs?: number;
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export async function mapBounded<T, R>(
  items: readonly T[],
  fn: (item: T, index: number) => Promise<R>,
  opts: BoundedMapOptions,
): Promise<R[]> {
  const concurrency = Math.max(1, Math.floor(opts.concurrency));
  const stagger = Math.max(0, opts.staggerMs ?? 0);
  const results = new Array<R>(items.length);
  if (items.length === 0) return results;

  let cursor = 0;
  let nextStart = 0;

  async function worker(): Promise<void> {
    for (;;) {
      const i = cursor++;
      if (i >= items.length) return;
      if (stagger > 0) {
        const now = performance.now();
        const wait = Math.max(0, nextStart - now);
        nextStart = Math.max(now, nextStart) + stagger;
        if (wait > 0) await delay(wait);
      }
      results[i] = await fn(items[i], i);
    }
  }

  const workers = Math.min(concurrency, items.length);
  await Promise.all(Array.from({ length: workers }, () => worker()));
  return results;
}
