/** Tests for the teams live budget kill-switch (issue #399): `createTeamBudgetWatcher.poll()` reads
 * each running teammate's stdout.log, feeds real stream-json usage into a shared watcher and calls
 * `onBreach` on aggregate overspend; `runSupervisor` then stops the team. No mocks. */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawn, type ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// HOME must be pinned BEFORE any import that reaches state.ts, so
// getHistoryDir() (which loadLedger uses) points at our temp dir and the
// ledger starts empty regardless of the developer's real ~/.agents.
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
/** Every child we spawn — cleaned up in afterEach so a failed test can't leak processes. */
let spawnedChildren: ChildProcess[] = [];

/** One Claude stream-json assistant turn costing exactly $5 on claude-opus-4 (1M input tokens at
 * $5/Mtok), the same fixture shape the local exec.ts watcher reads, so tapping teammate stdout.logs
 * must behave the same. */
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
  // Reap any live children — a supervisor breach cascade may leave them
  // dead already; force-kill is idempotent, and unref() lets vitest exit.
  for (const c of spawnedChildren) {
    try { if (c.pid) process.kill(-c.pid, 'SIGKILL'); } catch { /* already gone */ }
    try { if (c.pid) process.kill(c.pid, 'SIGKILL'); } catch { /* already gone */ }
  }
  spawnedChildren = [];
  fs.rmSync(tmpBase, { recursive: true, force: true });
  fs.rmSync(projectDir, { recursive: true, force: true });
});

/** Plant a running teammate backed by a real killable `sleep`, so `isProcessAlive()` sees a live
 * PID with a matching startTime and doesn't flip it to COMPLETED early. The breach path's
 * `stopByTask` signals this sleep. */
async function plantRunningTeammate(
  taskName: string,
  agentType: AgentType,
  stdoutLines: string[],
): Promise<InstanceType<typeof AgentProcess>> {
  const agentId = `agent-${Math.random().toString(36).slice(2, 10)}`;
  // Detached so kill(-pid) reaches the whole group — the same pattern the
  // teams launcher uses in production.
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
    // Empty project — no agents.yaml at any parent. resolveBudgetConfig
    // returns { on_exceed: 'block' } with zero caps → hasAnyCap = false.
    const w = createTeamBudgetWatcher({
      manager: mgr,
      team: 't1',
      cwd: projectDir,
      onBreach: () => {},
    });
    expect(w).toBeNull();
  });

  it('trips per_project when aggregated teammate spend crosses the cap', async () => {
    // per_project = $8; two teammates each emit $5 of Claude usage → $10 > $8.
    // This is the exact cross-vendor property the local exec watcher CANNOT
    // enforce (each child sees only its own $5): the supervisor watcher must.
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
    await plantRunningTeammate('t1', 'claude', [claudeAssistantTurnJson()]); // $5
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
    await plantRunningTeammate('t1', 'claude', [claudeAssistantTurnJson()]); // $5
    const w = createTeamBudgetWatcher({
      manager: mgr,
      team: 't1',
      cwd: projectDir,
      onBreach: () => {},
    });
    await w!.poll();
    await w!.poll();
    // Two polls, one $5 event → still $5, not $10. No breach against $8 cap.
    expect(w!.breached()).toBe(false);
  });
});

describe('runSupervisor + TeamBudgetWatcher', () => {
  it('stops the team via stopByTask and returns stoppedBy=budget on breach', async () => {
    fs.writeFileSync(
      path.join(projectDir, 'agents.yaml'),
      'budget:\n  per_project: 3\n  on_exceed: block\n',
    );
    // One teammate whose stdout blows the cap on its first emitted turn.
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

    // The supervisor must recognize the breach, terminate via stopByTask,
    // and surface it as a distinct exit reason so the CLI can map it to
    // BUDGET_KILL_EXIT_CODE.
    expect(result.stoppedBy).toBe('budget');
    expect(onBreachSaw).not.toBeNull();
    expect(onBreachSaw!.cap).toBe('per_project');
    expect(result.budgetBreach?.cap).toBe('per_project');

    // The running teammate must have been stopped by the supervisor's
    // stopByTask call (state must be STOPPED, not RUNNING).
    const after = await mgr.get(teammate.agentId);
    expect(after?.status).toBe(AgentStatus.STOPPED);
  });

  it('supervisor with a null budgetWatcher behaves exactly as before', async () => {
    // Regression guard: passing budgetWatcher: null must be a no-op — the
    // team drains normally with no budget path exercised at all.
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
    // Second dispose must not throw.
    expect(() => w.dispose()).not.toThrow();
    // A poll after dispose is a no-op — no crash, no state change.
    await w.poll();
    expect(w.breached()).toBe(false);
  });
});
