
import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  AgentManager,
  AgentProcess,
  AgentStatus,
} from '../agents.js';

describe('Agent lifecycle reconciliation', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('marks local running teammates without a pid as failed during refresh', async () => {
    const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-nullpid-'));
    tempDirs.push(baseDir);

    const agent = new AgentProcess(
      'stuck-local',
      'demo-team',
      'claude',
      'prompt',
      null,
      'plan',
      null,
      AgentStatus.RUNNING,
      new Date('2026-04-26T22:42:44.108Z'),
      null,
      baseDir,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      'tests-and-ci',
    );
    await agent.saveMeta();

    const manager = new AgentManager(50, baseDir);
    const [refreshed] = await manager.listAll();
    const running = await manager.listRunning();
    const completed = await manager.listCompleted();

    expect(refreshed.status).toBe(AgentStatus.FAILED);
    expect(refreshed.completedAt).toBeInstanceOf(Date);
    expect(running).toEqual([]);
    expect(completed.map((a) => a.agentId)).toContain('stuck-local');
  });

  it('leaves pending teammates without a pid pending during refresh', async () => {
    const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-pending-'));
    tempDirs.push(baseDir);

    const agent = new AgentProcess(
      'waiting-local',
      'demo-team',
      'claude',
      'prompt',
      null,
      'plan',
      null,
      AgentStatus.PENDING,
      new Date('2026-04-26T22:42:44.108Z'),
      null,
      baseDir,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      'late-worker',
      ['dep-a'],
    );
    await agent.saveMeta();

    const manager = new AgentManager(50, baseDir);
    const [refreshed] = await manager.listAll();
    const running = await manager.listRunning();
    const all = await manager.listAll();

    expect(refreshed.status).toBe(AgentStatus.PENDING);
    expect(refreshed.completedAt).toBeNull();
    expect(running).toEqual([]);
    expect(all.map((a) => a.status)).toEqual([AgentStatus.PENDING]);
  });
});
