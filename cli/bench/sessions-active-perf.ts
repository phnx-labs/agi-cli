#!/usr/bin/env bun
/** Benchmark and regression guard for the cross-fleet session-query path (`agents sessions --active
 * --local` and `--host <peer>`), isolated to temp dirs. CI has no live fleet or sshd;
 * `scripts/bench-ssh.mjs` covers real-network latency. Both parts assert a threshold and exit 1. */

import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { performance } from 'perf_hooks';

const LOCAL_THRESHOLD_MS = Number(process.env.BENCH_LOCAL_THRESHOLD_MS ?? 500);
const REMOTE_TEAMMATES = Number(process.env.BENCH_REMOTE_TEAMMATES ?? 30);
const FAN_OUT_PEERS = Number(process.env.BENCH_FAN_OUT_PEERS ?? 8);
const PEER_LATENCY_MS = Number(process.env.BENCH_PEER_LATENCY_MS ?? 60);
const PARALLELISM_FACTOR = Number(process.env.BENCH_PARALLELISM_FACTOR ?? 3);

const SHIM_ENV = 'BENCH_SESSIONS_SHIM_DIR';

function shQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** Re-exec this script with a shim `ssh` on PATH from process bootstrap (runtime PATH mutation does
 * not reach spawnSync/execSync calls without an explicit `env`; see the file header). Only the
 * parent takes this branch; the child sees `BENCH_SESSIONS_SHIM_DIR` and runs the benchmark. */
function reexecWithShimOnPath(): never {
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-bench-ssh-shim-'));
  // One dispatcher script for both parts: it reads a "mode" file fresh on every invocation (a
  // plain file read, unaffected by the env-snapshot quirk), so the bun child can flip between Part
  // A (guard) and Part B (peer) without changing PATH again.
  const modeFile = path.join(binDir, 'mode');
  const sentinelFile = path.join(binDir, 'ssh-calls.log');
  const latencyFile = path.join(binDir, 'latency-seconds');
  const payloadFile = path.join(binDir, 'peer-payload.json');
  fs.writeFileSync(modeFile, 'guard');
  const shimScript = [
    '#!/bin/sh',
    `MODE=$(cat ${shQuote(modeFile)} 2>/dev/null || echo guard)`,
    'if [ "$MODE" = "peer" ]; then',
    `  sleep "$(cat ${shQuote(latencyFile)} 2>/dev/null || echo 0)"`,
    `  cat ${shQuote(payloadFile)}`,
    '  exit 0',
    'fi',
    `echo "unexpected ssh call: $*" >> ${shQuote(sentinelFile)}`,
    'exit 7',
    '',
  ].join('\n');
  fs.writeFileSync(path.join(binDir, 'ssh'), shimScript, { mode: 0o755 });

  const newPath = `${binDir}${path.delimiter}${process.env.PATH ?? ''}`;
  const child = spawnSync(process.execPath, [process.argv[1]], {
    stdio: 'inherit',
    env: { ...process.env, PATH: newPath, [SHIM_ENV]: binDir },
  });
  process.exit(child.status ?? 1);
}

function setShimMode(binDir: string, mode: 'guard' | 'peer'): void {
  fs.writeFileSync(path.join(binDir, 'mode'), mode);
}

function setShimLatency(binDir: string, ms: number): void {
  fs.writeFileSync(path.join(binDir, 'latency-seconds'), (Math.max(ms, 0) / 1000).toFixed(3));
}

function writeShimPayload(binDir: string, json: string): void {
  fs.writeFileSync(path.join(binDir, 'peer-payload.json'), json);
}

function countSentinelCalls(binDir: string): number {
  const sentinelFile = path.join(binDir, 'ssh-calls.log');
  if (!fs.existsSync(sentinelFile)) return 0;
  return fs.readFileSync(sentinelFile, 'utf8').split('\n').filter(Boolean).length;
}

function resetSentinel(binDir: string): void {
  fs.rmSync(path.join(binDir, 'ssh-calls.log'), { force: true });
}

async function time<T>(fn: () => Promise<T>): Promise<{ ms: number; value: T }> {
  const t0 = performance.now();
  const value = await fn();
  const ms = performance.now() - t0;
  return { ms, value };
}


async function benchLocalGuard(binDir: string): Promise<{
  teammates: number;
  sessionsSeen: number;
  bestMs: number;
  allRunsMs: number[];
  sshCallsDuringLocalQuery: number;
  positiveControlSshCalls: number;
  pass: boolean;
}> {
  const { AgentManager, AgentProcess, AgentStatus } = await import('../src/lib/teams/agents.js');

  async function addTeammate(base: string, id: string, status: import('../src/lib/teams/agents.js').AgentStatus) {
    const agent = new AgentProcess(
      id, 'bench-dist-team', 'claude', 'benchmark synthetic teammate',
      null, 'plan', null, status, new Date(),
      status === AgentStatus.RUNNING ? null : new Date(), base,
    );
    agent.hostName = `bench-peer-${id}`;
    agent.hostTarget = `bench-peer-${id}.tail1a85a1.ts.net`;
    agent.repoPath = '/home/bench/.agents/repos/bench-dist-team';
    agent.remotePid = 1000;
    agent.remoteLog = '$HOME/.agents/.cache/hosts/bench.log';
    agent.remoteExit = '$HOME/.agents/.cache/hosts/bench.exit';
    agent.remoteLogOffset = 0;
    await agent.saveMeta();
  }

  setShimMode(binDir, 'guard');
  resetSentinel(binDir);

  // Positive control first, on its own throwaway dataset: a RUNNING remote teammate polled with
  // localOnly=false must dial, proving the shim is watching before we trust its "0 calls" verdict
  // on the --local case (run against the real `ssh` PATH boundary).
  const controlBase = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-bench-teams-control-'));
  await addTeammate(controlBase, 'control-running', AgentStatus.RUNNING);
  const controlMgr = new AgentManager(50, controlBase, undefined, undefined, undefined, false);
  await controlMgr.listAll();
  const positiveControlSshCalls = countSentinelCalls(binDir);
  if (positiveControlSshCalls === 0) {
    throw new Error(
      'Positive control failed: a still-RUNNING remote teammate polled without --local ' +
        'made zero observed ssh calls. The ssh PATH shim is not intercepting — this bench ' +
        'cannot certify the --local guard below. (Expected the shim\'s own sentinel file to ' +
        'record at least one call.)',
    );
  }
  resetSentinel(binDir);

  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-bench-teams-'));
  for (let i = 0; i < REMOTE_TEAMMATES; i++) {
    const status = i % 2 === 0 ? AgentStatus.RUNNING : AgentStatus.COMPLETED;
    await addTeammate(base, `bench-remote-${i}`, status);
  }

  const runs: number[] = [];
  let sessionsSeen = 0;
  for (let i = 0; i < 3; i++) {
    // A fresh AgentManager per run (as the CLI does per invocation) so doInitialize()'s initial
    // poll, the one RUSH-2118 regressed, is what is timed, not a warm cache. localOnly=true is the
    // 6th constructor arg: the `--local` path (listTeamsActive).
    const mgr = new AgentManager(50, base, undefined, undefined, undefined, true);
    const r = await time(() => mgr.listAll());
    runs.push(r.ms);
    sessionsSeen = r.value.length;
  }
  const bestMs = Math.min(...runs);
  const sshCallsDuringLocalQuery = countSentinelCalls(binDir);
  const pass = sshCallsDuringLocalQuery === 0 && bestMs < LOCAL_THRESHOLD_MS;
  return {
    teammates: REMOTE_TEAMMATES,
    sessionsSeen,
    bestMs,
    allRunsMs: runs,
    sshCallsDuringLocalQuery,
    positiveControlSshCalls,
    pass,
  };
}


function cannedPeerPayload(): string {
  const sessions = [
    {
      context: 'terminal',
      kind: 'claude',
      sessionId: 'bench-0000-0000-0000-000000000001',
      pid: 4242,
      cwd: '/home/bench/project',
      topic: 'benchmark synthetic session',
      activity: 'working',
    },
    {
      context: 'headless',
      kind: 'codex',
      sessionId: 'bench-0000-0000-0000-000000000002',
      pid: 4243,
      cwd: '/home/bench/project',
      topic: 'benchmark synthetic session 2',
      activity: 'idle',
    },
  ];
  return JSON.stringify(sessions);
}

async function benchDistributedFanOut(binDir: string): Promise<{
  peers: number;
  perPeerLatencyMs: number;
  bestMs: number;
  allRunsMs: number[];
  sessionsSeen: number;
  parallelismThresholdMs: number;
  pass: boolean;
}> {
  const { gatherActiveSessions } = await import('../src/commands/ps-roster.js');

  setShimMode(binDir, 'peer');
  setShimLatency(binDir, PEER_LATENCY_MS);
  writeShimPayload(binDir, cannedPeerPayload());

  // Ad-hoc `user@ip` tokens resolve as literal peers with no registry entry (matchHost's
  // ad-hoc-literal branch, src/lib/hosts/registry.ts) and each has a distinct machine id (the ip),
  // so N peers merge into N rows though every shimmed ssh call returns identical stdout.
  const hosts = Array.from({ length: FAN_OUT_PEERS }, (_, i) => `bench${i}@10.99.0.${i + 1}`);

  const runs: number[] = [];
  let sessionsSeen = 0;
  for (let i = 0; i < 3; i++) {
    const r = await time(() => gatherActiveSessions({ hosts }));
    runs.push(r.ms);
    sessionsSeen = r.value.sessions.length;
  }
  const bestMs = Math.min(...runs);
  const parallelismThresholdMs = PEER_LATENCY_MS * PARALLELISM_FACTOR;
  const pass = bestMs < parallelismThresholdMs;
  return {
    peers: FAN_OUT_PEERS,
    perPeerLatencyMs: PEER_LATENCY_MS,
    bestMs,
    allRunsMs: runs,
    sessionsSeen,
    parallelismThresholdMs,
    pass,
  };
}

async function main() {
  const binDir = process.env[SHIM_ENV];
  if (!binDir) reexecWithShimOnPath();

  const local = await benchLocalGuard(binDir!);
  console.error(
    `A. --active --local (${local.teammates} synthetic remote-host teammates): ` +
      `best ${local.bestMs.toFixed(1)}ms, ${local.sshCallsDuringLocalQuery} ssh calls ` +
      `(threshold ${LOCAL_THRESHOLD_MS}ms, 0 calls; positive control observed ` +
      `${local.positiveControlSshCalls} call(s)) — ${local.pass ? 'PASS' : 'FAIL'}`,
  );

  const distributed = await benchDistributedFanOut(binDir!);
  console.error(
    `B. --host fan-out (${distributed.peers} synthetic peers, ${distributed.perPeerLatencyMs}ms/call): ` +
      `best ${distributed.bestMs.toFixed(1)}ms (parallelism threshold ${distributed.parallelismThresholdMs}ms) ` +
      `— ${distributed.pass ? 'PASS' : 'FAIL'}`,
  );

  const result = {
    node: process.version,
    timestamp: new Date().toISOString(),
    local,
    distributed,
  };
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');

  if (!local.pass || !distributed.pass) {
    console.error('\nFAIL: distributed session-query regression guard tripped.');
    if (!local.pass) {
      console.error(
        `  - Part A: ${local.sshCallsDuringLocalQuery} ssh call(s) during a --local query ` +
          `(want 0), best run ${local.bestMs.toFixed(1)}ms (want < ${LOCAL_THRESHOLD_MS}ms). ` +
          'A --local query must never dial a remote-host teammate (RUSH-2118).',
      );
    }
    if (!distributed.pass) {
      console.error(
        `  - Part B: fan-out took ${distributed.bestMs.toFixed(1)}ms for ${distributed.peers} peers ` +
          `at ${distributed.perPeerLatencyMs}ms/call (want < ${distributed.parallelismThresholdMs}ms). ` +
          'The peer fan-out may have gone sequential.',
      );
    }
    process.exit(1);
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
