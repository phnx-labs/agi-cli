
export const PROJECTION_HORIZON_MIN = 30;

// Blind accounts keep a nonzero chance so an all-blind pool can still launch.
export const UNVERIFIED_WEIGHT = 1;

export function capacityWeight(
  usedPercent: number | null,
  minutesToLimit: number | null,
): number {
  // Missing usage is unknown, not full; verified headroom tapers across 30 minutes.
  const base = usedPercent === null ? UNVERIFIED_WEIGHT : Math.max(1, 100 - usedPercent);
  if (minutesToLimit === null || !Number.isFinite(minutesToLimit)) return base;
  const factor = Math.max(0, Math.min(1, minutesToLimit / PROJECTION_HORIZON_MIN));
  return Math.max(1, base * factor);
}
