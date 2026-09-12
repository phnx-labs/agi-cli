#!/usr/bin/env node
/**
 * A stand-in for the standalone `computer` engine, used by computer-client.test.ts.
 *
 * This is NOT a mock of the client: the tests spawn this as a real child process
 * over real pipes, so they exercise the actual fd-3 / fd-4 protocol, the actual
 * stdio inheritance, and the actual exit-code propagation. It implements the
 * engine's side of the contract and nothing else.
 *
 * Behavior is driven by argv so one fixture covers every case:
 *   echo-context   read fd 3 to EOF, write the parsed context back on stdout
 *   emit <n>       write n NDJSON action events to fd 4
 *   emit-garbage   write one unparseable line, then one good event
 *   emit-partial   write a final event with NO trailing newline
 *   exit <code>    exit with that code
 *   ignore-context exit immediately without reading fd 3 (EPIPE race)
 */
import * as fs from 'node:fs';

const [mode, arg] = process.argv.slice(2);

function readContext() {
  const fd = Number(process.env.COMPUTER_CONTEXT_FD);
  return fs.readFileSync(fd, 'utf-8');
}
function writeEvents(lines) {
  const fd = Number(process.env.COMPUTER_EVENTS_FD);
  fs.writeFileSync(fd, lines);
}

if (mode === 'ignore-context') process.exit(7);

if (mode === 'echo-context') {
  process.stdout.write(readContext());
  process.exit(0);
}

readContext();

if (mode === 'emit') {
  const n = Number(arg);
  let out = '';
  for (let i = 0; i < n; i++) {
    out += JSON.stringify({ verb: 'click', targetPid: 100 + i, bundle: 'com.apple.notes' }) + '\n';
  }
  writeEvents(out);
  process.exit(0);
}

if (mode === 'emit-garbage') {
  writeEvents('not json at all\n\n' + JSON.stringify({ verb: 'type' }) + '\n');
  process.exit(0);
}

if (mode === 'emit-partial') {
  writeEvents(JSON.stringify({ verb: 'key' }));
  process.exit(0);
}

if (mode === 'exit') process.exit(Number(arg));

process.exit(0);
