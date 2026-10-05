
const ENABLED = Boolean(process.env.AGENTS_DEBUG || process.env.DEBUG);

export function debug(...args: unknown[]): void {
  if (ENABLED) console.error(...args);
}
