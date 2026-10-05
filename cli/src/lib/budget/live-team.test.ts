import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawn, type ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'live-team-home-'));
process.env.HOME = fakeHome;
fs.mkdirSync(path.join(fakeHome, '.agents'), { recursive: true });

const { AgentManager, AgentProcess, AgentStatus, captureProcessStartTime } = await import('../teams/agents.js');
const { runSupervisor } = await import('../teams/supervisor.js');
const { createTeamBudgetWatcher } = await import('./live-team.js');
import type { AgentType } from '../teams/agents.js';
import type { BreachInfo } from './enforce.js';
import type { TeamBudgetWatcher } from './live-team.js';

let tmpBase: string;
let projectDir: string;
let mgr: InstanceType<typeof AgentManager>;
let spawnedChildren: ChildProcess[] = [];

function claudeAssistantTurnJson(): string {
  return JSON.stringify({
    type: 'assistant',
    message: { model: 'claude-opus-4', usage: { input_tokens: 1_000_000 } },
  });
}

beforeEach(async () => {
  tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'live-team-'));
  projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'live-team-proj-'));
  mgr = new AgentManager(50, tmpBase);
  await mgr.listAll();
});

afterEach(() => {
  for (const c of spawnedChildren) {
    try { if (c.pid) process.kill(-c.pid, 'SIGKILL'); } catch {  }
    try { if (c.pid) process.kill(c.pid, 'SIGKILL'); } catch {  }
  }
  spawnedChildren = [];
  fs.rmSync(tmpBase, { recursive: true, force: true });
  fs.rmSync(projectDir, { recursive: true, force: true });
});

async function plantRunningTeammate(
  taskName: string,
  agentType: AgentType,
  stdoutLines: string[],
): Promise<InstanceType<typeof AgentProcess>> {
  const agentId = `agent-${Math.random().toString(36).slice(2, 10)}`;
  const child = spawn('sleep', ['30'], { detached: true, stdio: 'ignore' });
  child.unref();
  spawnedChildren.push(child);
  if (!child.pid) throw new Error('Failed to spawn sleep child');

  const agent = new AgentProcess(
    agentId,
    taskName,
    agentType,
    'test-prompt',
    projectDir,
    'edit',
    child.pid,
    AgentStatus.RUNNING,
    new Date(),
    null,
    tmpBase,
  );
  agent.startTime = captureProcessStartTime(child.pid);
  await agent.saveMeta();
  mgr.registerAgent(agent);
  const stdoutPath = await agent.getStdoutPath();
  fs.writeFileSync(stdoutPath, stdoutLines.join('\n') + (stdoutLines.length ? '\n' : ''));
  return agent;
}

describe('createTeamBudgetWatcher', () => {
  it('returns null when no caps are configured (feature dormant)', () => {
    const w = createTeamBudgetWatcher({
      manager: mgr,
      team: 't1',
      cwd: projectDir,
      onBreach: () => {},
    });
    expect(w).toBeNull();
  });

  it('trips per_project when aggregated teammate spend crosses the cap', async () => {
    fs.writeFileSync(
      path.join(projectDir, 'agents.yaml'),
      'budget:\n  per_project: 8\n  on_exceed: block\n',
    );
    await plantRunningTeammate('t1', 'claude', [claudeAssistantTurnJson()]);
    await plantRunningTeammate('t1', 'claude', [claudeAssistantTurnJson()]);

    let breach: BreachInfo | null = null;
    const w = createTeamBudgetWatcher({
      manager: mgr,
      team: 't1',
      cwd: projectDir,
      onBreach: (b) => { breach = b; },
    });
    expect(w).not.toBeNull();
    await w!.poll();
    expect(w!.breached()).toBe(true);
    expect(breach!.cap).toBe('per_project');
    expect(breach!.spend).toBeCloseTo(10, 6);
    expect(breach!.limit).toBe(8);
  });

  it('does NOT trip when only one teammate spends under the aggregate cap', async () => {
    fs.writeFileSync(
      path.join(projectDir, 'agents.yaml'),
      'budget:\n  per_project: 20\n',
    );
    await plantRunningTeammate('t1', 'claude', [claudeAssistantTurnJson()]);
    const w = createTeamBudgetWatcher({
      manager: mgr,
      team: 't1',
      cwd: projectDir,
      onBreach: () => {},
    });
    await w!.poll();
    expect(w!.breached()).toBe(false);
  });

  it('is idempotent — polling twice with no new bytes does not double-count', async () => {
    fs.writeFileSync(
      path.join(projectDir, 'agents.yaml'),
      'budget:\n  per_project: 8\n',
    );
    await plantRunningTeammate('t1', 'claude', [claudeAssistantTurnJson()]);
    const w = createTeamBudgetWatcher({
      manager: mgr,
      team: 't1',
      cwd: projectDir,
      onBreach: () => {},
    });
    await w!.poll();
    await w!.poll();
    expect(w!.breached()).toBe(false);
  });
});

describe('runSupervisor + TeamBudgetWatcher', () => {
  it('stops the team via stopByTask and returns stoppedBy=budget on breach', async () => {
    fs.writeFileSync(
      path.join(projectDir, 'agents.yaml'),
      'budget:\n  per_project: 3\n  on_exceed: block\n',
    );
    const teammate = await plantRunningTeammate('t-kill', 'claude', [claudeAssistantTurnJson()]);
    const watcher = createTeamBudgetWatcher({
      manager: mgr,
      team: 't-kill',
      cwd: projectDir,
      onBreach: () => {},
    });
    expect(watcher).not.toBeNull();

    let onBreachSaw: BreachInfo | null = null;
    const result = await runSupervisor(mgr, {
      team: 't-kill',
      intervalMs: 10,
      maxWaves: 5,
      budgetWatcher: watcher,
      onBudgetBreach: (b) => { onBreachSaw = b; },
      onWave: () => {},
    });

    expect(result.stoppedBy).toBe('budget');
    expect(onBreachSaw).not.toBeNull();
    expect(onBreachSaw!.cap).toBe('per_project');
    expect(result.budgetBreach?.cap).toBe('per_project');

    const after = await mgr.get(teammate.agentId);
    expect(after?.status).toBe(AgentStatus.STOPPED);
  });

  it('supervisor with a null budgetWatcher behaves exactly as before', async () => {
    fs.writeFileSync(path.join(projectDir, 'agents.yaml'), '');
    const result = await runSupervisor(mgr, {
      team: 'no-work',
      intervalMs: 10,
      maxWaves: 5,
      budgetWatcher: null,
      onWave: () => {},
    });
    expect(result.stoppedBy).toBe('drained');
    expect(result.budgetBreach).toBeUndefined();
  });
});

describe('TeamBudgetWatcher.dispose', () => {
  it('is idempotent and stops accepting new events', async () => {
    fs.writeFileSync(
      path.join(projectDir, 'agents.yaml'),
      'budget:\n  per_project: 100\n',
    );
    await plantRunningTeammate('t1', 'claude', [claudeAssistantTurnJson()]);
    const w = createTeamBudgetWatcher({
      manager: mgr,
      team: 't1',
      cwd: projectDir,
      onBreach: () => {},
    }) as TeamBudgetWatcher;
    w.dispose();
    expect(() => w.dispose()).not.toThrow();
    await w.poll();
    expect(w.breached()).toBe(false);
  });
});
