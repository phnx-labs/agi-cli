/** proper-lockfile calls this from its background refresh timer and by default throws there,
 * outside the caller's promise chain, which can kill the daemon. These leases are advisory, so log
 * a compromised lease and let the operation finish. */
export function logAndContinueOnLockCompromised(scope: string): (err: Error) => void {
  return (err: Error) => {
    console.warn(`[agents ${scope}] Lock was compromised; continuing without crashing: ${err.message}`);
  };
}
