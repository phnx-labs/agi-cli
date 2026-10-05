import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';

import { AgentManager, AgentProcess, AgentStatus } from '../agents.js';
import { handleTasks } from '../api.js';

describe('handleTasks stranded detection (PHNX-2951)', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  function createRepo(name: string): { repoRoot: string; worktreePath: string } {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), name));
    tempDirs.push(repoRoot);

    execFileSync('git', ['init'], { cwd: repoRoot });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repoRoot });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: repoRoot });
    fs.writeFileSync(path.join(repoRoot, 'README.md'), '# repo\n');
    execFileSync('git', ['add', 'README.md'], { cwd: repoRoot });
    execFileSync('git', ['commit', '-m', 'init'], { cwd: repoRoot });

    const worktreePath = path.join(repoRoot, '.agents', 'worktrees', 'monitor-auth');
    execFileSync(
      'git',
      ['worktree', 'add', '-b', 'agents/monitor-auth', worktreePath],
      { cwd: repoRoot },
    );

    return { repoRoot, worktreePath };
  }

  function saveCompletedAgent(
    baseDir: string,
    agentId: string,
    taskName: string,
    workspaceDir: string,
    status: AgentStatus = AgentStatus.COMPLETED,
    prUrl: string | null = null,
  ): Promise<void> {
    const now = new Date();
    const agent = new AgentProcess(
      agentId,
      taskName,
      'cursor',
      'fix the monitor',
      null,
      'edit',
      null,
      status,
      now,
      status === AgentStatus.COMPLETED ? now : null,
      baseDir,
      null,
      workspaceDir,
      null,
      null,
      prUrl,
      null,
      null,
      'monitor-auth',
    );
    return agent.saveMeta();
  }

  it('counts a completed teammate with uncommitted work and no PR as stranded', async () => {
    const { repoRoot, worktreePath } = createRepo('agents-tasks-stranded-');
    fs.writeFileSync(path.join(worktreePath, 'fix.ts'), 'export const fixed = true;\n');

    const agentsDir = path.join(repoRoot, '.agents', '.history', 'agents');
    fs.mkdirSync(agentsDir, { recursive: true });
    await saveCompletedAgent(agentsDir, 'agent-tasks-stranded-1', 'bugfix-swarm', worktreePath);

    const manager = new AgentManager(50, agentsDir);
    const result = await handleTasks(manager, 10);

    expect(result.tasks).toHaveLength(1);
    expect(result.tasks[0]).toMatchObject({
      task_name: 'bugfix-swarm',
      agent_count: 1,
      completed: 1,
      stranded: 1,
      failed: 0,
      stopped: 0,
      running: 0,
      pending: 0,
    });
  });

  it('leaves a clean completed teammate without a PR as not stranded', async () => {
    const { repoRoot, worktreePath } = createRepo('agents-tasks-clean-');

    const agentsDir = path.join(repoRoot, '.agents', '.history', 'agents');
    fs.mkdirSync(agentsDir, { recursive: true });
    await saveCompletedAgent(agentsDir, 'agent-tasks-clean-1', 'bugfix-swarm', worktreePath);

    const manager = new AgentManager(50, agentsDir);
    const result = await handleTasks(manager, 10);

    expect(result.tasks[0]).toMatchObject({
      completed: 1,
      stranded: 0,
    });
  });

  it('does not count a remote dirty teammate as stranded', async () => {
    const { repoRoot, worktreePath } = createRepo('agents-tasks-remote-');
    fs.writeFileSync(path.join(worktreePath, 'fix.ts'), 'export const fixed = true;\n');

    const agentsDir = path.join(repoRoot, '.agents', '.history', 'agents');
    fs.mkdirSync(agentsDir, { recursive: true });

    const agent = new AgentProcess(
      'agent-tasks-remote-1',
      'bugfix-swarm',
      'cursor',
      'fix the monitor',
      null,
      'edit',
      null,
      AgentStatus.COMPLETED,
      new Date(),
      new Date(),
      agentsDir,
      null,
      '/remote/path/that/does/not/exist',
      null,
      null,
      null,
      null,
      null,
      'monitor-auth',
    );
    agent.hostName = 'yosemite-s1';
    await agent.saveMeta();

    const manager = new AgentManager(50, agentsDir);
    const result = await handleTasks(manager, 10);

    expect(result.tasks[0]).toMatchObject({
      completed: 1,
      stranded: 0,
    });
  });
});
