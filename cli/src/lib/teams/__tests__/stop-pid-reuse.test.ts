import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

import { AgentManager, AgentProcess, AgentStatus } from '../agents.js';

let baseDir: string;

beforeEach(() => {
  baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-stop-pidreuse-'));
});

afterEach(async () => {
  await fsp.rm(baseDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('AgentManager.stop() PID-reuse guard', () => {
  it('refuses to signal a PID whose start-time mismatches', async () => {
    const manager = new AgentManager(50, baseDir, 'plan', null, 7);

    const agent = new AgentProcess(
      'agent-fake-id',
      'team-a',
      'claude',
      'noop',
      null,
      'plan',
      process.pid,
      AgentStatus.RUNNING,
      new Date(),
      null,
      baseDir,
    );
    agent.startTime = 'BOGUS-START-TIME-NEVER-MATCHES';

    manager.registerAgent(agent);

    const killSpy = vi.spyOn(process, 'kill');

    const result = await manager.stop('agent-fake-id');
    expect(result).toBe(true);
    expect(agent.status).toBe(AgentStatus.STOPPED);
    expect(agent.completedAt).toBeInstanceOf(Date);

    const lethalCalls = killSpy.mock.calls.filter(
      ([, sig]) => sig === 'SIGTERM' || sig === 'SIGKILL'
    );
    expect(lethalCalls).toEqual([]);
  });

  it('reports isProcessAlive() === false when start-time mismatches', () => {
    const agent = new AgentProcess(
      'agent-fake-id-2',
      'team-b',
      'claude',
      'noop',
      null,
      'plan',
      process.pid,
      AgentStatus.RUNNING,
    );
    agent.startTime = 'BOGUS-START-TIME-NEVER-MATCHES';
    expect(agent.isProcessAlive()).toBe(false);
  });
});
