import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { AgentManager, AgentProcess, AgentStatus, captureProcessStartTime } from './agents.js';

function tmpBase(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'agents-stale-mgr-'));
}

async function makeRunningLocal(base: string, id: string): Promise<AgentProcess> {
  const agent = new AgentProcess(
    id, 'stale-team', 'claude', 'do a thing', null, 'plan',
    process.pid, AgentStatus.RUNNING, new Date(), null, base,
  );
  agent.startTime = captureProcessStartTime(process.pid);
  await agent.saveMeta();
  return agent;
}

describe('stale-manager race never clobbers an explicit stop (RUSH-2366)', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
  });

  it('mgr.get() adopts a disk-terminal status instead of re-persisting a stale cached RUNNING', async () => {
    const base = tmpBase();
    dirs.push(base);
    const id = 'stale-1';
    await makeRunningLocal(base, id);

    const mgr = new AgentManager(50, base);
    const first = await mgr.get(id);
    expect(first?.status).toBe(AgentStatus.RUNNING);

    const onDisk = await AgentProcess.loadFromDisk(id, base);
    expect(onDisk).not.toBeNull();
    onDisk!.status = AgentStatus.STOPPED;
    onDisk!.completedAt = new Date();
    await onDisk!.saveMeta();

    const polled = await mgr.get(id);
    expect(polled?.status).toBe(AgentStatus.STOPPED);

    const reread = await AgentProcess.loadFromDisk(id, base);
    expect(reread?.status).toBe(AgentStatus.STOPPED);
  });

  it('rescanFromDisk refreshes an already-cached teammate once disk latches it terminal', async () => {
    const base = tmpBase();
    dirs.push(base);
    const id = 'stale-2';
    await makeRunningLocal(base, id);

    const mgr = new AgentManager(50, base);
    await mgr.get(id);

    const onDisk = await AgentProcess.loadFromDisk(id, base);
    onDisk!.status = AgentStatus.FAILED;
    onDisk!.completedAt = new Date();
    await onDisk!.saveMeta();

    const added = await mgr.rescanFromDisk();
    expect(added).toBe(0);

    const all = await mgr.listByTask('stale-team');
    expect(all.find((a) => a.agentId === id)?.status).toBe(AgentStatus.FAILED);
  });

  it('rescanFromDisk leaves a still-live cached teammate untouched', async () => {
    const base = tmpBase();
    dirs.push(base);
    const id = 'stale-3';
    await makeRunningLocal(base, id);

    const mgr = new AgentManager(50, base);
    const cached = await mgr.get(id);
    expect(cached?.status).toBe(AgentStatus.RUNNING);

    await mgr.rescanFromDisk();

    const all = await mgr.listByTask('stale-team');
    expect(all.find((a) => a.agentId === id)?.status).toBe(AgentStatus.RUNNING);
  });
});
