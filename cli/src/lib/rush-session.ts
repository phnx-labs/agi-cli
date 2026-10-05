/** Rush session freshness, the ONE judgment for every consumer of ~/.rush/user.yaml. `expires_at`
 * is Unix MILLISECONDS, so compare to `Date.now()` (PHNX-3805). `0` and `undefined` mean never
 * expires; reading `0` as 1970 rejected valid sessions (PHNX-3645). */
export function isRushSessionExpired(expiresAt: number | undefined): boolean {
  // `0` (non-expiring pid_ bearer) and a missing value are never expired.
  if (typeof expiresAt !== 'number' || expiresAt === 0) return false;
  // expires_at is Unix milliseconds — compare ms to ms.
  return expiresAt <= Date.now();
}
