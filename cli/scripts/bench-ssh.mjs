#!/usr/bin/env node
/** A/B benchmark for the shared SSH engine against a real enrolled host: `bun run build`, then
 * `node scripts/bench-ssh.mjs <host>`. Needs passwordless ssh with real network latency (a
 * Tailscale-relayed peer shows it best). Not a CI benchmark. */
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { execSync } from 'child_process';

const here = dirname(fileURLToPath(import.meta.url));
const dist = join(here, '..', 'dist');
const { sshExec, sshExecRawStream } = await import(join(dist, 'lib', 'ssh-exec.js'));
const { readyProbe } = await import(join(dist, 'lib', 'hosts', 'ready.js'));
const { buildStreamingFollowCommand, parseStreamingExitFrame } = await import(join(dist, 'lib', 'hosts', 'progress.js'));

const HOST = process.argv[2];
if (!HOST) {
  console.error('usage: node scripts/bench-ssh.mjs <host>   (run `bun run build` first)');
  process.exit(2);
}

const ms = (t0) => Number(process.hrtime.bigint() - t0) / 1e6;
const clearSockets = () => { try { execSync('rm -f ~/.agents/.cache/ssh/cm-*', { shell: '/bin/bash' }); } catch {  } };
const median = (a) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };

function timeLoop(label, n, fn) {
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < n; i++) fn(i);
  const total = ms(t0);
  console.log(`  ${label.padEnd(34)} ${total.toFixed(0).padStart(6)}ms total  ${(total / n).toFixed(0).padStart(5)}ms/call`);
  return total;
}

console.log(`\nHost: ${HOST}   (wall-clock on this laptop)\n`);

console.log('P3  repeated `--host` calls (10x trivial remote `true`)');
const N = 10;
clearSockets();
const off = timeLoop('multiplex OFF (fresh handshake)', N, () => sshExec(HOST, 'true', { multiplex: false }));
clearSockets();
const on = timeLoop('multiplex ON  (reused socket)', N, () => sshExec(HOST, 'true', { multiplex: true }));
console.log(`  => ${(off / on).toFixed(1)}x faster, ${(off - on).toFixed(0)}ms saved over ${N} calls\n`);

console.log('P2  readiness check (median of 5)');
const oldReady = [], newReady = [];
for (let r = 0; r < 5; r++) {
  clearSockets();
  let t0 = process.hrtime.bigint();
  sshExec(HOST, 'true', { multiplex: true });
  sshExec(HOST, 'bash -lc "agents --version 2>/dev/null"', { multiplex: false });
  sshExec(HOST, 'bash -lc "agents view 2>/dev/null || agents list 2>/dev/null"', { multiplex: false });
  oldReady.push(ms(t0));
  clearSockets();
  t0 = process.hrtime.bigint();
  readyProbe(HOST);
  newReady.push(ms(t0));
}
console.log(`  old (3 round-trips)   ${median(oldReady).toFixed(0).padStart(6)}ms`);
console.log(`  new (1 readyProbe)    ${median(newReady).toFixed(0).padStart(6)}ms`);
console.log(`  => ${(median(oldReady) / median(newReady)).toFixed(1)}x faster, ${(median(oldReady) - median(newReady)).toFixed(0)}ms saved per dispatch\n`);

console.log('P1  follow loop, cost of 20 poll cycles vs one persistent stream');
const CYCLES = 20;
const log = '$HOME/.agents/.cache/hosts/benchfollow.log';
const exit = '$HOME/.agents/.cache/hosts/benchfollow.exit';
execSync(`ssh ${HOST} ${JSON.stringify('mkdir -p ~/.agents/.cache/hosts; printf "x\\n" > ~/.agents/.cache/hosts/benchfollow.log; rm -f ~/.agents/.cache/hosts/benchfollow.exit')}`, { stdio: 'ignore' });
clearSockets();
const oldFollow = timeLoop('OLD 2 un-muxed calls/cycle', CYCLES, () => {
  sshExec(HOST, `tail -c +1 ${log} 2>/dev/null`, { multiplex: false });
  sshExec(HOST, `cat ${exit} 2>/dev/null`, { multiplex: false });
});
clearSockets();
const newFollow = timeLoop('NEW 1 muxed combined call/cycle', CYCLES, () => {
  sshExec(HOST, `tail -c +1 ${log} 2>/dev/null; printf '\\n@@M@@\\n'; cat ${exit} 2>/dev/null`, { multiplex: true });
});
execSync(`ssh ${HOST} ${JSON.stringify('rm -f ~/.agents/.cache/hosts/benchfollow.exit; printf "x\\n" > ~/.agents/.cache/hosts/benchfollow.log; (sleep 0.2; printf "0\\n" > ~/.agents/.cache/hosts/benchfollow.exit) >/dev/null 2>&1 &')}`, { stdio: 'ignore' });
clearSockets();
let streamed = 0;
let t0 = process.hrtime.bigint();
const stream = await sshExecRawStream(HOST, buildStreamingFollowCommand({
  remoteLog: log,
  remoteExit: exit,
  taskId: 'benchfollow',
  offset: 0,
}), {
  multiplex: true,
  onStdout: (chunk) => { streamed += chunk.length; },
});
const streamFollow = ms(t0);
const streamExit = parseStreamingExitFrame(stream.stderr, 'benchfollow')?.toString('utf8').trim() ?? '<missing>';
console.log(`  STREAM 1 ssh for whole follow       ${streamFollow.toFixed(0).padStart(6)}ms total  exit=${streamExit} bytes=${streamed}`);
execSync(`ssh ${HOST} 'rm -f ~/.agents/.cache/hosts/benchfollow.*'`, { stdio: 'ignore' });
console.log(`  ssh process spawns:   OLD ${CYCLES * 2}   NEW ${CYCLES}   STREAM 1`);
console.log(`  => NEW is ${(oldFollow / newFollow).toFixed(1)}x faster than OLD; STREAM removes ${CYCLES - 1}/${CYCLES} per-cycle spawns\n`);
