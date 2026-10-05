/** Remaining-capacity weighting for account selection: a pure primitive shared by `rotate.ts` and
 * `account-pool.ts`, kept separate so neither pulls in the usage/secrets graph. */

/** Distance from its projected cap within which an account's headroom weight scales down linearly
 * toward the floor, so one racing toward its 5h cap loses priority before it maxes. */
export const PROJECTION_HORIZON_MIN = 30;

/** Weight for an account with no usage snapshot: unverifiable, not empty (GWT-E5c, SING-1a); on
 * workers every account is null (setup-token lacks `user:profile`, RUSH-2392). Scoring null as
 * full picked a weekly-exhausted account (PHNX-3392). Floored at 1, never 0: a blind pool picks. */
export const UNVERIFIED_WEIGHT = 1;

/** Weight a candidate by weekly headroom, scaled toward 1 as `minutesToLimit` (5h projection) falls
 * below the horizon. No snapshot draws UNVERIFIED_WEIGHT so any verified-healthy account outranks
 * it (GWT-E5c). */
export function capacityWeight(
  usedPercent: number | null,
  minutesToLimit: number | null,
): number {
  const base = usedPercent === null ? UNVERIFIED_WEIGHT : Math.max(1, 100 - usedPercent);
  if (minutesToLimit === null || !Number.isFinite(minutesToLimit)) return base;
  const factor = Math.max(0, Math.min(1, minutesToLimit / PROJECTION_HORIZON_MIN));
  return Math.max(1, base * factor);
}
