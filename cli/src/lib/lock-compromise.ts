export function logAndContinueOnLockCompromised(scope: string): (err: Error) => void {
  return (err: Error) => {
    console.warn(`[agents ${scope}] Lock was compromised; continuing without crashing: ${err.message}`);
  };
}
