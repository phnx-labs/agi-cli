/** Percentile of a sorted-ascending array, linear interpolation, p in [0,100]. Its own zero-import
 * file: `perf/db.ts`, `hooks/profile.ts` and `routines.ts` all need it, but the latter two must
 * not pull in `perf/db.ts`'s heavier sqlite dependency just to round a percentile. */
export function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  if (sorted.length === 1) return sorted[0];
  const rank = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  if (lo === hi) return sorted[lo];
  const frac = rank - lo;
  return sorted[lo] * (1 - frac) + sorted[hi] * frac;
}
