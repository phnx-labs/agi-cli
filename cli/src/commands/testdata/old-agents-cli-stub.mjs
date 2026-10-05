#!/usr/bin/env node
// Reproduces the pre-`--resolve-safe-v1` peer rejection without fetching an old
// package or letting its self-heal touch the real host. Keep its text and exit
// status aligned with @phnx-labs/agents-cli@1.20.88.
const args = process.argv.slice(2);
const unknown = args.find((arg) => arg === '--resolve-safe-v1');
if (unknown) {
  process.stderr.write(`error: unknown option '${unknown}'\n`);
  process.exit(1);
}
process.stderr.write(`old-agents-cli-stub: unexpected invocation: ${args.join(' ')}\n`);
process.exit(2);
