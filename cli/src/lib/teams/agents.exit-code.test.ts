import { describe, it, expect } from 'vitest';
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  AgentProcess,
  AgentStatus,
  buildSentinelCommand,
  captureProcessStartTime,
} from './agents.js';
import { IS_WINDOWS } from '../platform/index.js';

function tmpBase(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'agents-exitcode-test-'));
}

function makeAgent(base: string, id: string): AgentProcess {
  fs.mkdirSync(path.join(base, id), { recursive: true });
  return new AgentProcess(
    id,
    'test-team',
    'kimi',
    'do a thing',
    null,
    'plan',
    null,
    AgentStatus.RUNNING,
    new Date(),
    null,
    base,
  );
}

function spawnTeammate(
  agent: AgentProcess,
  agentDir: string,
  cmd: string[],
  sentinel = true,
): Promise<void> {
  const stdoutFd = fs.openSync(path.join(agentDir, 'stdout.log'), 'w');
  const exitCodePath = path.join(agentDir, 'exit_code');
  const shellCmd = sentinel
    ? buildSentinelCommand(cmd, exitCodePath)
    : cmd.map((c) => `'${c.replace(/'/g, `'\\''`)}'`).join(' ');
  const child = spawn('/bin/sh', ['-c', shellCmd], {
    stdio: ['ignore', stdoutFd, stdoutFd],
    detached: true,
  });
  agent.pid = child.pid ?? null;
  agent.startTime = agent.pid ? captureProcessStartTime(agent.pid) : null;
  agent.status = AgentStatus.RUNNING;
  return new Promise((resolve) => {
    child.on('exit', () => {
      try { fs.closeSync(stdoutFd); } catch {  }
      resolve();
    });
  });
}

describe.skipIf(IS_WINDOWS)('teams exit-code sentinel', () => {
  it('marks a clean exit COMPLETED even when the stream has no terminal event', async () => {
    const base = tmpBase();
    const agentDir = path.join(base, 'a1');
    const agent = makeAgent(base, 'a1');

    await spawnTeammate(agent, agentDir, ['echo', 'plain-text-not-json']);
    await agent.updateStatusFromProcess();

    expect(fs.readFileSync(path.join(agentDir, 'exit_code'), 'utf-8').trim()).toBe('0');
    expect(agent.status).toBe(AgentStatus.COMPLETED);
  });

  it('marks a non-zero exit FAILED', async () => {
    const base = tmpBase();
    const agentDir = path.join(base, 'a2');
    const agent = makeAgent(base, 'a2');

    await spawnTeammate(agent, agentDir, ['sh', '-c', 'exit 3']);
    await agent.updateStatusFromProcess();

    expect(fs.readFileSync(path.join(agentDir, 'exit_code'), 'utf-8').trim()).toBe('3');
    expect(agent.status).toBe(AgentStatus.FAILED);
    expect(agent.failure).toMatchObject({
      stage: 'execution', code: 'process-exit-nonzero', exit_code: 3, retryable: false,
    });
  });

  it('marks a process killed before writing the sentinel FAILED', async () => {
    const base = tmpBase();
    const agentDir = path.join(base, 'a3');
    const agent = makeAgent(base, 'a3');

    await spawnTeammate(agent, agentDir, ['true'], false);
    expect(fs.existsSync(path.join(agentDir, 'exit_code'))).toBe(false);
    await agent.updateStatusFromProcess();

    expect(agent.status).toBe(AgentStatus.FAILED);
    expect(agent.failure).toMatchObject({
      stage: 'execution', code: 'process-exit-unrecorded', exit_code: null, retryable: true,
    });
  });
});

describe('buildSentinelCommand', () => {
  it('appends the exit-code redirect after the command', () => {
    const wrapped = buildSentinelCommand(['echo', 'hi'], '/tmp/x/exit_code');
    expect(wrapped).toBe(`'echo' 'hi'; echo $? > '/tmp/x/exit_code'`);
  });

  it('single-quotes args so shell metacharacters cannot inject', () => {
    const wrapped = buildSentinelCommand(['echo', '$(rm -rf /); `boom`'], '/tmp/exit_code');
    expect(wrapped).toContain(`'$(rm -rf /); \`boom\`'`);
    expect(wrapped.startsWith(`'echo' '`)).toBe(true);
  });

  it('escapes embedded single quotes via the close-escape-reopen idiom', () => {
    const wrapped = buildSentinelCommand(["it's"], '/tmp/exit_code');
    expect(wrapped).toBe(`'it'\\''s'; echo $? > '/tmp/exit_code'`);
  });
});
