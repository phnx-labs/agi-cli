import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { AgentManager, AgentProcess, AgentStatus } from '../lib/teams/agents.js';
import { runOneWave } from './teams.js';

const roots: string[] = [];
const tmpBase = (): string => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-team-wave-'));
  roots.push(root);
  return root;
};

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
  process.exitCode = undefined;
  vi.restoreAllMocks();
});

async function persist(
  base: string,
  id: string,
  name: string,
  status: AgentStatus,
  after: string[] = [],
): Promise<AgentProcess> {
  const agent = new AgentProcess(
    id, 'wave-team', 'claude', 'test task', null, 'plan', null, status,
    new Date(), status === AgentStatus.COMPLETED ? new Date() : null,
    base, null, null, null, null, null, null, null, name, after,
  );
  await agent.saveMeta();
  return agent;
}

describe('runOneWave failure surfacing', () => {
  it('reports a teammate terminalized during the wave in JSON and exits non-zero', async () => {
    const base = tmpBase();
    await persist(base, 'blocked-child', 'blocked-child', AgentStatus.PENDING, ['__never_done__']);
    const mgr = new AgentManager(50, base);
    const logs: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((line: string) => { logs.push(String(line)); });

    await runOneWave(mgr, 'wave-team', true);

    const payload = JSON.parse(logs.join('\n'));
    expect(payload.launched).toEqual([]);
    expect(payload.still_pending).toEqual([]);
    expect(payload.failed).toHaveLength(1);
    expect(payload.failed[0]).toMatchObject({
      name: 'blocked-child',
      failure: {
        stage: 'dependency', code: 'dependency-failed',
        message: 'Blocked by dependency: __never_done__ (missing).',
      },
    });
    expect(process.exitCode).toBe(1);
  });

  it('names the failed teammate and its evidence in text mode', async () => {
    const base = tmpBase();
    await persist(base, 'blocked-child', 'blocked-child', AgentStatus.PENDING, ['__never_done__']);
    const mgr = new AgentManager(50, base);
    const logs: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((line?: unknown) => { logs.push(String(line ?? '')); });

    await runOneWave(mgr, 'wave-team', false);

    const out = logs.join('\n');
    expect(out).not.toContain('No pending teammates');
    expect(out).toContain('Failed this wave (1)');
    expect(out).toContain('blocked-child');
    expect(out).toContain('dependency-failed: Blocked by dependency: __never_done__ (missing).');
    expect(process.exitCode).toBe(1);
  });

  it('does not report pre-existing failures or set the exit code on a quiet wave', async () => {
    const base = tmpBase();
    const failed = await persist(base, 'old-failure', 'old-failure', AgentStatus.FAILED);
    failed.failure = {
      stage: 'placement', code: 'no-viable-device', message: 'No viable device.',
      exit_code: null, retryable: false, observed_at: new Date().toISOString(),
    };
    await failed.saveMeta();
    const mgr = new AgentManager(50, base);
    const logs: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((line: string) => { logs.push(String(line)); });

    await runOneWave(mgr, 'wave-team', true);

    const payload = JSON.parse(logs.join('\n'));
    expect(payload.failed).toEqual([]);
    expect(process.exitCode).toBeUndefined();
  });
});
