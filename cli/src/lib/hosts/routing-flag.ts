/** Leaf argv helpers for host/device routing flags, with zero imports on purpose: bootstrap.ts
 * gates the ~187 ms passthrough import on hasHostRoutingFlag, so the gate must not pull in
 * passthrough, remote-cmd, ssh-exec or the registry (RUSH-2374). */

export function flagValue(args: string[], long: string, short?: string): string | undefined {
  // Keep this probe import-free: it runs before ordinary commands may load the SSH graph.
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === `--${long}` || (short && a === `-${short}`)) return args[i + 1];
    if (a.startsWith(`--${long}=`)) return a.slice(long.length + 3);
    if (short && a.startsWith(`-${short}=`)) return a.slice(short.length + 2);
    if (short && new RegExp(`^-${short}(.+)`).test(a)) return a.slice(2);
  }
  return undefined;
}

/** True when argv carries any device routing flag maybeRunOnHost inspects (`--device`/`-D`,
 * `--hosts`, `--devices`; space, `=` or glued form). Presence-only; used by bootstrap before
 * loading passthrough and by `maybeRunStandaloneOnHost`. */
export function hasHostRoutingFlag(args: string[]): boolean {
  return (
    flagValue(args, 'device', 'D') !== undefined ||
    flagValue(args, 'hosts') !== undefined ||
    flagValue(args, 'devices') !== undefined
  );
}
