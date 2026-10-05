
export const PROJECTION_HORIZON_MIN = 30;

export const UNVERIFIED_WEIGHT = 1;

export function capacityWeight(
  usedPercent: number | null,
  minutesToLimit: number | null,
): number {
  const base = usedPercent === null ? UNVERIFIED_WEIGHT : Math.max(1, 100 - usedPercent);
  if (minutesToLimit === null || !Number.isFinite(minutesToLimit)) return base;
  const factor = Math.max(0, Math.min(1, minutesToLimit / PROJECTION_HORIZON_MIN));
  return Math.max(1, base * factor);
}
