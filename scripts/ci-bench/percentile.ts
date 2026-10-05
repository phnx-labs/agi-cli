import type { GatedPercentile } from './types';

/** p=99.99 → 9999. Integer tenths-of-a-basis-point, so 99.9 is not 0.998999… */
export function percentileUnits(p: number): number {
  if (!Number.isFinite(p) || p < 0 || p > 100) {
    throw new RangeError(`percentile must be in [0, 100], got ${p}`);
  }
  return Math.round(p * 100);
}

/** Minimum observations so percentile `p` is a real sample, not an interpolation: P99 needs 100,
 * P99.9 needs 1_000, P99.99 needs 10_000 (`ceil(1 / (1 - p/100))`). */
export function minSamplesForPercentile(p: number): number {
  const units = percentileUnits(p);
  if (units === 0 || units === 10_000) return 1;
  return Math.ceil(10_000 / (10_000 - units));
}

export function nearestRank(n: number, p: number): number {
  const units = percentileUnits(p);
  if (n <= 0) throw new RangeError('nearestRank requires n > 0');
  if (units === 0) return 1;
  return Math.ceil((units * n) / 10_000);
}

/** Nearest-rank percentile of a sorted-ascending array: rank = ceil(p/100 * n), value = sorted[rank
 * - 1]. Returns an observed sample, never an interpolation. */
export function exactPercentile(sortedAscending: readonly number[], p: number): number {
  if (sortedAscending.length === 0) {
    throw new RangeError('exactPercentile requires at least one sample');
  }
  return sortedAscending[nearestRank(sortedAscending.length, p) - 1];
}

export function gatedPercentile(values: readonly number[], p: number): GatedPercentile {
  const n = values.length;
  const required = minSamplesForPercentile(p);
  if (n < required) {
    return { p, n, required, status: 'insufficient-sample', valueMs: null, rank: null };
  }
  const sorted = [...values].sort((a, b) => a - b);
  const rank = nearestRank(n, p);
  return {
    p,
    n,
    required,
    status: 'ok',
    valueMs: sorted[rank - 1],
    rank,
  };
}

export function gatedPercentiles(
  values: readonly number[],
  percentiles: readonly number[],
): GatedPercentile[] {
  return percentiles.map((p) => gatedPercentile(values, p));
}
