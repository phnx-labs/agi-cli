#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === 'ps' && args[1] === 'resolve') {
  process.stderr.write("error: unknown command 'resolve'\n");
  process.exit(1);
}
process.stderr.write(`old-agents-cli-stub: unexpected invocation: ${args.join(' ')}\n`);
process.exit(2);
