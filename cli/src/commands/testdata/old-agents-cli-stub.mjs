#!/usr/bin/env node
const args = process.argv.slice(2);
const unknown = args.find((arg) => arg === '--resolve-safe-v1');
if (unknown) {
  process.stderr.write(`error: unknown option '${unknown}'\n`);
  process.exit(1);
}
process.stderr.write(`old-agents-cli-stub: unexpected invocation: ${args.join(' ')}\n`);
process.exit(2);
