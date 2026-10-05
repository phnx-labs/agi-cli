import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { runLoop, defaultRunIteration, loopSignalPath } from './loop.js';
import { readCheckpoint, checkpointPath } from './checkpoint.js';
import type { ExecOptions } from './exec.js';

let binDir: string;
let runDir: string;
let origPath: string | undefined;
let origHome: string | undefined;

const FAKE_CLAUDE = `#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
process.stdout.write('{"type":"assistant","message":{"model":"claude-sonnet-4-5","usage":{"input_tokens":100,"output_tokens":50,"cache_read_input_tokens":10}}}\\n');
process.stdout.write('{"type":"result","usage":{"input_tokens":100,"output_tokens":50}}\\n');
const dir = process.env.FAKE_CLAUDE_SIGNAL_DIR;
if (dir) {

  const counter = path.join(dir, 'counter');
  let n = 0;
  try { n = parseInt(fs.readFileSync(counter, 'utf-8').trim(), 10) || 0; } catch {}
  if (n > 1) {
    fs.writeFileSync(path.join(dir, 'loop-signal.json'), '{"continue":true,"reason":"more"}');
    fs.writeFileSync(counter, String(n - 1));
  } else {
    fs.writeFileSync(path.join(dir, 'loop-signal.json'), '{"continue":false,"reason":"done"}');
  }
}
process.exit(0);
`;

beforeAll(() => {
  binDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-loop-int-bin-'));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-loop-int-home-'));
  runDir = path.join(home, 'rundir');
  fs.mkdirSync(runDir, { recursive: true });
  const fakeClaude = path.join(binDir, 'claude');
  fs.writeFileSync(fakeClaude, FAKE_CLAUDE, { mode: 0o755 });
  if (process.platform === 'win32') {
    fs.writeFileSync(fakeClaude + '.cmd', `@echo off\r\nnode "${fakeClaude}" %*\r\n`);
  }
  origPath = process.env.PATH;
  origHome = process.env.HOME;
  process.env.PATH = `${binDir}${path.delimiter}${origPath}`;
  process.env.HOME = home;
});
afterAll(() => {
  if (origPath !== undefined) process.env.PATH = origPath;
  if (origHome !== undefined) process.env.HOME = origHome;
});

const exec: ExecOptions = {
  agent: 'claude',
  prompt: 'loop please',
  mode: 'skip',
  effort: 'auto',
};

describe('loop driver — real spawn + token parse', () => {
  it('defaultRunIteration spawns the agent and sums tokens off the real stream-json', async () => {
    const res = await defaultRunIteration(exec);
    expect(res.exitCode).toBe(0);
    expect(res.tokens).toBe(160);
  });

  it('runs 3 real iterations then stops with max (interval 0, real spawns)', async () => {
    const res = await runLoop(exec, { maxIterations: 3, interval: '0' }, {
      runId: 'int-max',
      runDir,
      agent: 'claude',
    });
    expect(res.iterations).toBe(3);
    expect(res.stoppedBy).toBe('max');
    expect(res.tokens).toBe(480);
  });

  it('until=signal stops with condition-met when the fake agent writes continue:false', async () => {
    const signalRunDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-loop-int-sig-'));
    fs.writeFileSync(path.join(signalRunDir, 'counter'), '2', 'utf-8');
    const res = await runLoop(
      { ...exec, env: { FAKE_CLAUDE_SIGNAL_DIR: signalRunDir } },
      { until: 'signal', maxIterations: 10, interval: '0' },
      { runId: 'int-sig', runDir: signalRunDir, agent: 'claude' },
    );
    expect(res.stoppedBy).toBe('condition-met');
    expect(res.iterations).toBe(2);
    expect(res.lastSignal?.continue).toBe(false);
    expect(res.lastSignal?.reason).toBe('done');
  });
});

describe('loop driver — checkpoint write + resume continuity', () => {
  it('writes a checkpoint at the real run path and resume continues from it', async () => {
    const phase1 = await runLoop(exec, { maxIterations: 2, interval: '0' }, {
      runId: 'int-resume',
      runDir,
      agent: 'claude',
      version: undefined,
    });
    expect(phase1.iterations).toBe(2);
    const cpFile = checkpointPath('int-resume');
    const cp = readCheckpoint(cpFile);
    expect(cp).not.toBeNull();
    expect(cp!.iteration).toBe(2);
    expect(cp!.cumulativeTokens).toBe(320);
    expect(typeof cp!.sessionId).toBe('string');

    const phase2 = await runLoop(exec, { maxIterations: 4, interval: '0' }, {
      runId: cp!.id,
      runDir,
      agent: 'claude',
      startIteration: cp!.iteration + 1,
      startTokens: cp!.cumulativeTokens ?? 0,
      sessionId: cp!.sessionId,
    });
    expect(phase2.iterations).toBe(2);
    expect(phase2.stoppedBy).toBe('max');
    expect(phase2.tokens).toBe(640);

    const finalCp = readCheckpoint(cpFile)!;
    expect(finalCp.iteration).toBe(4);
    expect(finalCp.cumulativeTokens).toBe(640);
    expect(typeof finalCp.sessionId).toBe('string');
    expect(finalCp.sessionId).not.toBe(cp!.sessionId);
  });
});
