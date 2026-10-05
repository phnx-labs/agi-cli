export function isRushSessionExpired(expiresAt: number | undefined): boolean {
  // expires_at is Unix milliseconds; zero or missing means non-expiring.
  if (typeof expiresAt !== 'number' || expiresAt === 0) return false;
  return expiresAt <= Date.now();
}
