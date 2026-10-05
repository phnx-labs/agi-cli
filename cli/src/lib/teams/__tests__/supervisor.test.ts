import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

import {
  AgentManager,
  AgentProcess,
  AgentStatus,
  type AgentType,
} from '../agents.js';
import { runSupervisor } from '../supervisor.js';

let tmpBase: string;
let mgr: AgentManager;

beforeEach(async () => {
  tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'sup-test-'));
  mgr = new AgentManager(50, tmpBase);
  await mgr.listAll();
});

afterEach(() => {
  fs.rmSync(tmpBase, { recursive: true, force: true });
});

async function plantAgent(
  taskName: string,
  overrides: Partial<{
    agentId: string;
    name: string | null;
    after: string[];
    status: AgentStatus;
    taskType: 'plan' | 'implement' | 'test' | 'review' | 'bugfix' | 'docs' | null;
  }> = {}
): Promise<AgentProcess> {
  const agent = new AgentProcess(
    overrides.agentId ?? `agent-${Math.random().toString(36).slice(2, 10)}`,
    taskName,
    'claude' as AgentType,
    'prompt',
    null,
    'edit',
    overrides.status === AgentStatus.RUNNING ? process.pid : null,
    overrides.status ?? AgentStatus.COMPLETED,
    new Date(Date.now() - 10), new Date(),
    tmpBase,
    null, null, null, null, null, null, null,
    overrides.name ?? null,
    overrides.after ?? [],
    'medium', null, null,
    overrides.taskType ?? null
  );
  await agent.saveMeta();
  mgr.registerAgent(agent);
  return agent;
}

describe('runSupervisor', () => {
  it('drains immediately when the DAG is empty', async () => {
    const events: number[] = [];
    const result = await runSupervisor(mgr, {
      team: 'empty',
      intervalMs: 50,
      onWave: (s) => { events.push(s.launched.length); },
    });
    expect(result.stoppedBy).toBe('drained');
    expect(result.waves).toBe(1);
    expect(events).toEqual([0]);
  });

  it('drains when all teammates are already completed', async () => {
    await plantAgent('t1', { name: 'impl-a', status: AgentStatus.COMPLETED, taskType: 'implement' });
    await plantAgent('t1', { name: 'test-a', status: AgentStatus.COMPLETED, taskType: 'test', after: ['impl-a'] });

    const waves: Array<{ pending: number; running: number; completed: number }> = [];
    const result = await runSupervisor(mgr, {
      team: 't1',
      intervalMs: 50,
      onWave: (s) => { waves.push({ pending: s.pending, running: s.running, completed: s.completed }); },
    });
    expect(result.stoppedBy).toBe('drained');
    expect(waves[waves.length - 1]).toEqual({ pending: 0, running: 0, completed: 2 });
  });

  it('picks up a teammate added mid-flight', async () => {
    let added = false;
    let wavesSeen = 0;
    const waveSnaps: Array<{ pending: number; running: number; completed: number }> = [];

    const result = await runSupervisor(mgr, {
      team: 'dyn',
      intervalMs: 30,
      maxWaves: 15,
      onWave: async (s) => {
        wavesSeen++;
        waveSnaps.push({ pending: s.pending, running: s.running, completed: s.completed });
        if (!added) {
          added = true;
          await plantAgent('dyn', {
            name: 'late-pending',
            status: AgentStatus.PENDING,
            after: ['__never_done__'],
            taskType: 'implement',
          });
          return;
        }
      },
    });

    expect(result.stoppedBy).toBe('drained');
    expect(result.waves).toBe(2);
    const [failed] = await mgr.listByTask('dyn');
    expect(failed.status).toBe(AgentStatus.FAILED);
    expect(failed.failure).toMatchObject({
      stage: 'dependency', code: 'dependency-failed',
      message: 'Blocked by dependency: __never_done__ (missing).',
    });
  });

  it('stops when onWave returns false', async () => {
    await plantAgent('t1', { name: 'impl-a', status: AgentStatus.RUNNING, taskType: 'implement' });
    let waveCount = 0;
    const result = await runSupervisor(mgr, {
      team: 't1',
      intervalMs: 50,
      maxWaves: 100,
      onWave: () => {
        waveCount++;
        return waveCount >= 3 ? false : true;
      },
    });
    expect(result.stoppedBy).toBe('callback');
    expect(result.waves).toBe(3);
  });

  it('rescans disk so teammates created by a sibling process get picked up', async () => {
    let waveCount = 0;
    await plantAgent('cross-proc', {
      name: 'seed',
      status: AgentStatus.RUNNING,
      taskType: 'implement',
    });
    const seenNames: Set<string> = new Set();
    const result = await runSupervisor(mgr, {
      team: 'cross-proc',
      intervalMs: 20,
      maxWaves: 10,
      onWave: async (s) => {
        waveCount++;
        for (const a of await mgr.listByTask('cross-proc')) {
          if (a.name) seenNames.add(a.name);
        }
        if (waveCount === 1) {
          const newId = 'cross-proc-alien';
          const dir = path.join(tmpBase, newId);
          fs.mkdirSync(dir, { recursive: true });
          fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify({
            agent_id: newId,
            task_name: 'cross-proc',
            agent_type: 'claude',
            prompt: 'p', cwd: null, workspace_dir: null,
            mode: 'edit', pid: null,
            status: 'completed',
            started_at: new Date().toISOString(),
            completed_at: new Date().toISOString(),
            name: 'alien', after: [], task_type: 'implement',
          }));
        }
        if (waveCount === 2) {
          const all = await mgr.listByTask('cross-proc');
          for (const a of all) {
            if (a.name === 'seed') {
              a.status = AgentStatus.COMPLETED;
              a.completedAt = new Date();
              await a.saveMeta();
            }
          }
        }
      },
    });
    expect(result.stoppedBy).toBe('drained');
    expect(seenNames.has('alien')).toBe(true);
    expect(seenNames.has('seed')).toBe(true);
  });

  it('reports failed count on drain: a failed teammate drains with failed >= 1', async () => {
    await plantAgent('mixed', { name: 'ok', status: AgentStatus.COMPLETED, taskType: 'implement' });
    await plantAgent('mixed', { name: 'boom', status: AgentStatus.FAILED, taskType: 'implement' });
    const result = await runSupervisor(mgr, {
      team: 'mixed',
      intervalMs: 50,
      onWave: () => {},
    });
    expect(result.stoppedBy).toBe('drained');
    expect(result.failed).toBe(1);
  });

  it('a fully-successful drain reports failed === 0', async () => {
    await plantAgent('allok', { name: 'a', status: AgentStatus.COMPLETED, taskType: 'implement' });
    await plantAgent('allok', { name: 'b', status: AgentStatus.COMPLETED, taskType: 'test', after: ['a'] });
    const result = await runSupervisor(mgr, {
      team: 'allok',
      intervalMs: 50,
      onWave: () => {},
    });
    expect(result.stoppedBy).toBe('drained');
    expect(result.failed).toBe(0);
  });

  it('stops at --max-waves if the DAG never drains', async () => {
    await plantAgent('t1', { name: 'running', status: AgentStatus.RUNNING, taskType: 'implement' });
    const result = await runSupervisor(mgr, {
      team: 't1',
      intervalMs: 30,
      maxWaves: 4,
      onWave: () => {},
    });
    expect(result.stoppedBy).toBe('max-waves');
    expect(result.waves).toBe(4);
  });
});
