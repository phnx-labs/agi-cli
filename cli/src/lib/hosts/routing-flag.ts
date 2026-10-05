
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

export function hasHostRoutingFlag(args: string[]): boolean {
  return (
    flagValue(args, 'device', 'D') !== undefined ||
    flagValue(args, 'hosts') !== undefined ||
    flagValue(args, 'devices') !== undefined
  );
}
