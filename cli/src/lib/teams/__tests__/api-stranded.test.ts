import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';

import { AgentManager, AgentProcess, AgentStatus } from '../agents.js';
import { handleStatus } from '../api.js';

describe('handleStatus stranded detection (PHNX-2951)', () => {
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
    workspaceDir: string,
    prUrl: string | null = null,
  ): Promise<void> {
    const now = new Date();
    const agent = new AgentProcess(
      'agent-stranded-1',
      'bugfix-swarm',
      'cursor',
      'fix the monitor',
      null,
      'edit',
      null,
      AgentStatus.COMPLETED,
      now,
      now,
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

  it('marks a completed teammate with uncommitted work and no PR as stranded', async () => {
    const { repoRoot, worktreePath } = createRepo('agents-stranded-');
    fs.writeFileSync(path.join(worktreePath, 'fix.ts'), 'export const fixed = true;\n');

    const agentsDir = path.join(repoRoot, '.agents', '.history', 'agents');
    fs.mkdirSync(agentsDir, { recursive: true });
    await saveCompletedAgent(agentsDir, worktreePath);

    const manager = new AgentManager(50, agentsDir);
    const result = await handleStatus(manager, 'bugfix-swarm');

    expect(result.summary).toMatchObject({
      completed: 1,
      stranded: 1,
      failed: 0,
      stopped: 0,
      running: 0,
      pending: 0,
    });
    expect(result.agents).toHaveLength(1);
    expect(result.agents[0].delivery).toBe('stranded');
    expect(result.agents[0].workspace_dir).toBe(worktreePath);
  });

  it('leaves a clean completed teammate without a PR as no_pr', async () => {
    const { repoRoot, worktreePath } = createRepo('agents-clean-');

    const agentsDir = path.join(repoRoot, '.agents', '.history', 'agents');
    fs.mkdirSync(agentsDir, { recursive: true });
    await saveCompletedAgent(agentsDir, worktreePath);

    const manager = new AgentManager(50, agentsDir);
    const result = await handleStatus(manager, 'bugfix-swarm');

    expect(result.summary).toMatchObject({
      completed: 1,
      stranded: 0,
      failed: 0,
      stopped: 0,
      running: 0,
      pending: 0,
    });
    expect(result.agents[0].delivery).toBe('no_pr');
  });

  it('does not probe remote teammates for uncommitted changes', async () => {
    const { repoRoot, worktreePath } = createRepo('agents-remote-');
    fs.writeFileSync(path.join(worktreePath, 'fix.ts'), 'export const fixed = true;\n');

    const agentsDir = path.join(repoRoot, '.agents', '.history', 'agents');
    fs.mkdirSync(agentsDir, { recursive: true });

    const now = new Date();
    const agent = new AgentProcess(
      'agent-remote-dirty-1',
      'bugfix-swarm',
      'cursor',
      'fix the monitor',
      null,
      'edit',
      null,
      AgentStatus.COMPLETED,
      now,
      now,
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
    const result = await handleStatus(manager, 'bugfix-swarm');

    expect(result.agents[0].delivery).toBe('no_pr');
    expect(result.summary.stranded).toBe(0);
  });

  function saveRunningAgent(baseDir: string): Promise<void> {
    const now = new Date();
    const agent = new AgentProcess(
      'agent-running-1',
      'bugfix-swarm',
      'claude',
      'keep running',
      null,
      'edit',
      process.pid,
      AgentStatus.RUNNING,
      now,
      null,
      baseDir,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      'runner',
    );
    return agent.saveMeta();
  }

  it('counts stranded teammates even when status is filtered to running', async () => {
    const { repoRoot, worktreePath } = createRepo('agents-filter-running-');
    fs.writeFileSync(path.join(worktreePath, 'fix.ts'), 'export const fixed = true;\n');

    const agentsDir = path.join(repoRoot, '.agents', '.history', 'agents');
    fs.mkdirSync(agentsDir, { recursive: true });
    await saveCompletedAgent(agentsDir, worktreePath);
    await saveRunningAgent(agentsDir);

    const manager = new AgentManager(50, agentsDir);
    const result = await handleStatus(manager, 'bugfix-swarm', 'running');

    expect(result.summary).toMatchObject({
      pending: 0,
      running: 1,
      completed: 1,
      stranded: 1,
      failed: 0,
      stopped: 0,
    });
    expect(result.agents).toHaveLength(1);
    expect(result.agents[0].status).toBe('running');
  });
});
