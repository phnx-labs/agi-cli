export function isRushSessionExpired(expiresAt: number | undefined): boolean {
  if (typeof expiresAt !== 'number' || expiresAt === 0) return false;
  return expiresAt <= Date.now();
}
