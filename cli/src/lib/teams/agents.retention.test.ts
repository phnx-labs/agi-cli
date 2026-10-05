import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { AgentManager, AgentProcess, AgentStatus, captureProcessStartTime } from './agents.js';

function tmpBase(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'agents-retention-'));
}

async function makeCompleted(base: string, id: string, minutesAgo: number): Promise<void> {
  const completedAt = new Date(Date.now() - minutesAgo * 60_000);
  const agent = new AgentProcess(
    id, 'retention-team', 'claude', 'do a thing', null, 'plan',
    null, AgentStatus.COMPLETED, new Date(completedAt.getTime() - 1000), completedAt, base,
  );
  await agent.saveMeta();
}

async function makePending(base: string, id: string, name: string, dep: string): Promise<void> {
  const agent = new AgentProcess(
    id, 'retention-team', 'claude', 'do a thing', null, 'plan',
    null, AgentStatus.PENDING, new Date(), null, base,
    null, null, null, null, null, null, null,
    name, [dep],
  );
  await agent.saveMeta();
}

describe('retention never reaps a non-terminal teammate (RUSH-2356)', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
  });

  it('55 completed + 5 pending, cap=50: only the 5 oldest completed are reaped; every pending survives', async () => {
    const base = tmpBase();
    dirs.push(base);

    for (let i = 0; i < 55; i++) {
      await makeCompleted(base, `done-${i}`, 55 - i);
    }
    for (let i = 0; i < 5; i++) {
      await makePending(base, `pending-${i}`, `p${i}`, 'done-54');
    }

    const mgr = new AgentManager(50, base);
    await mgr.listAll();

    await (mgr as unknown as { cleanupOldAgents(): Promise<void> }).cleanupOldAgents();

    const all = await mgr.listAll();
    const completedIds = all.filter((a) => a.status === AgentStatus.COMPLETED).map((a) => a.agentId).sort();
    const pendingIds = all.filter((a) => a.status === AgentStatus.PENDING).map((a) => a.agentId).sort();

    expect(completedIds).toHaveLength(50);
    expect(pendingIds).toHaveLength(5);
    for (let i = 0; i < 5; i++) expect(completedIds).not.toContain(`done-${i}`);

    for (let i = 0; i < 5; i++) {
      const reread = await AgentProcess.loadFromDisk(`pending-${i}`, base);
      expect(reread?.status).toBe(AgentStatus.PENDING);
      expect(reread?.after).toEqual(['done-54']);
    }
  });

  it('a still-RUNNING teammate is never a reap candidate, however deep the completed backlog', async () => {
    const base = tmpBase();
    dirs.push(base);

    for (let i = 0; i < 60; i++) {
      await makeCompleted(base, `done-${i}`, 60 - i);
    }
    const running = new AgentProcess(
      'still-running', 'retention-team', 'claude', 'do a thing', null, 'plan',
      process.pid, AgentStatus.RUNNING, new Date(), null, base,
    );
    running.startTime = captureProcessStartTime(process.pid);
    await running.saveMeta();

    const mgr = new AgentManager(50, base);
    await mgr.listAll();
    await (mgr as unknown as { cleanupOldAgents(): Promise<void> }).cleanupOldAgents();

    const reread = await AgentProcess.loadFromDisk('still-running', base);
    expect(reread?.status).toBe(AgentStatus.RUNNING);

    const all = await mgr.listAll();
    expect(all.filter((a) => a.status === AgentStatus.COMPLETED)).toHaveLength(50);
  });

  it('the age-based reap (loadExistingAgents) also never deletes a non-terminal record, even a stale one', async () => {
    const base = tmpBase();
    dirs.push(base);

    const stalePending = new AgentProcess(
      'stale-pending', 'age-team', 'claude', 'do a thing', null, 'plan',
      null, AgentStatus.PENDING, new Date(Date.now() - 30 * 86_400_000),
      new Date(Date.now() - 30 * 86_400_000), base,
      null, null, null, null, null, null, null, 'staged', ['someone'],
    );
    await stalePending.saveMeta();

    const staleCompleted = new AgentProcess(
      'stale-completed', 'age-team', 'claude', 'do a thing', null, 'plan',
      null, AgentStatus.COMPLETED, new Date(Date.now() - 30 * 86_400_000),
      new Date(Date.now() - 30 * 86_400_000), base,
    );
    await staleCompleted.saveMeta();

    const mgr = new AgentManager(50, base, undefined, undefined, 7);
    await mgr.listAll();

    expect(fs.existsSync(path.join(base, 'stale-pending'))).toBe(true);
    expect(fs.existsSync(path.join(base, 'stale-completed'))).toBe(false);

    const reread = await AgentProcess.loadFromDisk('stale-pending', base);
    expect(reread?.status).toBe(AgentStatus.PENDING);
  });
});

describe('isWorktreeClaimed distinguishes an orphan worktree from a live teammate (RUSH-2356)', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
  });

  async function makeOwner(
    base: string, id: string, task: string, worktree: string, status: AgentStatus,
  ): Promise<void> {
    const agent = new AgentProcess(
      id, task, 'claude', 'do a thing', null, 'plan',
      null, status, new Date(), status === AgentStatus.PENDING ? null : new Date(), base,
      null, null, null, null, null, null, null, worktree, [],
      null, null, null, null, null, null, worktree,
    );
    await agent.saveMeta();
    expect((await AgentProcess.loadFromDisk(id, base))?.worktreeName).toBe(worktree);
  }

  it('true for a PENDING --after teammate that persisted — its worktree is never torn down', async () => {
    const base = tmpBase();
    dirs.push(base);
    await makeOwner(base, 'staged-1', 'wt-team', 'surface', AgentStatus.PENDING);

    const mgr = new AgentManager(50, base);
    expect(await mgr.isWorktreeClaimed('surface')).toBe(true);
  });

  it('true across TEAMS — worktree names are global to the repo, records are per-team', async () => {
    const base = tmpBase();
    dirs.push(base);
    await makeOwner(base, 'other-1', 'different-team', 'surface', AgentStatus.PENDING);

    const mgr = new AgentManager(50, base);
    expect(await mgr.isWorktreeClaimed('surface')).toBe(true);
  });

  it('false for a TERMINAL owner — its worktree is already gone, so the branch is a real orphan', async () => {
    const base = tmpBase();
    dirs.push(base);
    await makeOwner(base, 'done-1', 'wt-team', 'surface', AgentStatus.COMPLETED);
    await makeOwner(base, 'dead-1', 'wt-team', 'surface2', AgentStatus.FAILED);

    const mgr = new AgentManager(50, base);
    expect(await mgr.isWorktreeClaimed('surface')).toBe(false);
    expect(await mgr.isWorktreeClaimed('surface2')).toBe(false);
  });

  it('false when nothing claims the name at all', async () => {
    const base = tmpBase();
    dirs.push(base);
    await makeOwner(base, 'other-2', 'wt-team', 'ui', AgentStatus.PENDING);

    const mgr = new AgentManager(50, base);
    expect(await mgr.isWorktreeClaimed('surface')).toBe(false);
  });

  it('reads raw meta.json, so it still answers when a sibling would fail a status refresh', async () => {
    const base = tmpBase();
    dirs.push(base);
    await makeOwner(base, 'staged-2', 'wt-team', 'surface', AgentStatus.PENDING);

    fs.mkdirSync(path.join(base, 'empty-1'), { recursive: true });

    const mgr = new AgentManager(50, base);
    expect(await mgr.isWorktreeClaimed('surface')).toBe(true);
    expect(await mgr.isWorktreeClaimed('nothing-claims-this')).toBe(false);
  });

  it('fails CLOSED on an unreadable record rather than reporting the worktree free', async () => {
    const base = tmpBase();
    dirs.push(base);

    const brokenDir = path.join(base, 'broken-1');
    fs.mkdirSync(brokenDir, { recursive: true });
    fs.writeFileSync(path.join(brokenDir, 'meta.json'), '{ "worktree_name": "surf');

    const mgr = new AgentManager(50, base);
    expect(await mgr.isWorktreeClaimed('nothing-claims-this')).toBe(true);
  });

});

describe('constructor init failure is observed, never an unhandled rejection (RUSH-3036)', () => {
  it('a manager whose base dir cannot be created fails at the AWAITED call, not the process', async () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-retention-'));
    const asFile = path.join(base, 'not-a-dir');
    fs.writeFileSync(asFile, '');
    const mgr = new AgentManager(50, path.join(asFile, 'agents'));
    await new Promise((r) => setTimeout(r, 50));
    await expect(mgr.rescanFromDisk()).rejects.toThrow();
    fs.rmSync(base, { recursive: true, force: true });
  });
});
