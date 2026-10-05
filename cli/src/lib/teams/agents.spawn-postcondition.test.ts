import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { AgentManager, AgentProcess, AgentStatus } from './agents.js';

function tmpBase(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'agents-spawn-post-'));
}

describe('spawn() postcondition — never reports success for a record that is not on disk (RUSH-2356)', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
  });

  it('a staged --after teammate is durably persisted before spawn() resolves', async () => {
    const base = tmpBase();
    dirs.push(base);

    const sibling = new AgentProcess(
      'sibling-1', 'post-team', 'claude', 'first half', null, 'plan',
      null, AgentStatus.COMPLETED, new Date(Date.now() - 60_000), new Date(), base,
      null, null, null, null, null, null, null, 'first',
    );
    await sibling.saveMeta();

    const mgr = new AgentManager(50, base);
    const agent = await mgr.spawn(
      'post-team', 'claude', 'second half', null, null, 'medium',
      null, null, null, 'second', ['first'],
      null, null, null, 'rush',
    );

    expect(agent.status).toBe(AgentStatus.PENDING);

    const reread = await AgentProcess.loadFromDisk(agent.agentId, base);
    expect(reread).not.toBeNull();
    expect(reread?.name).toBe('second');
    expect(reread?.after).toEqual(['first']);
    expect(reread?.status).toBe(AgentStatus.PENDING);
  });

  it('spawn() THROWS (never returns a success) when the record is not on disk afterward', async () => {
    const base = tmpBase();
    dirs.push(base);

    const sibling = new AgentProcess(
      'sibling-2', 'post-team', 'claude', 'first half', null, 'plan',
      null, AgentStatus.COMPLETED, new Date(Date.now() - 60_000), new Date(), base,
      null, null, null, null, null, null, null, 'first',
    );
    await sibling.saveMeta();

    const mgr = new AgentManager(50, base);

    const realCleanup = (mgr as unknown as { cleanupOldAgents(): Promise<void> }).cleanupOldAgents;
    (mgr as unknown as { cleanupOldAgents(): Promise<void> }).cleanupOldAgents = async function reapEverything() {
      await realCleanup.call(mgr);
      for (const entry of await fs.promises.readdir(base)) {
        await fs.promises.rm(path.join(base, entry), { recursive: true, force: true });
      }
    };

    let spawned: AgentProcess | null = null;
    let thrown: Error | null = null;
    try {
      spawned = await mgr.spawn(
        'post-team', 'claude', 'second half', null, null, 'medium',
        null, null, null, 'second', ['first'],
        null, null, null, 'rush',
      );
    } catch (err) {
      thrown = err as Error;
    }

    expect(spawned).toBeNull();
    expect(thrown).not.toBeNull();
    expect(thrown?.message).toMatch(/was not durably persisted to disk after add/);
    expect(thrown?.message).toContain('second');

    const all = await mgr.listAll();
    expect(all.map((a) => a.name)).not.toContain('second');
  });
});
