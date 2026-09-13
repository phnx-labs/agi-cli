/**
 * Bounded, order-preserving async mapper.
 *
 * Runs `fn` over `items` with at most `concurrency` calls in flight, and — when
 * `staggerMs` is set — spaces successive task starts at least that far apart so
 * spawns trickle out instead of firing as one simultaneous burst. Results come
 * back in input order regardless of completion order.
 *
 * The stagger matters beyond scheduling: a burst of identical child spawns (per-PID
 * `lsof`, multi-dotfile scans) reads to behavioral EDR as recon/enumeration. A
 * bounded, spread-out spawn rate produces the same data without the burst signature.
 */
interface BoundedMapOptions {
  /** Maximum number of `fn` calls running at once. Coerced to >= 1. */
  concurrency: number;
  /** Minimum spacing (ms) between successive task starts. 0 (default) = no spacing. */
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
  // Shared gate: the earliest time the next task is allowed to start. Updated
  // atomically (no await between read and write) so parallel workers each claim
  // a distinct slot spaced `stagger` apart.
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
