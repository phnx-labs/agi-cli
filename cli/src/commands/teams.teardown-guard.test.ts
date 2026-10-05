import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { tearDownOrphanWorktree } from './teams.js';
import { AgentManager, AgentStatus } from '../lib/teams/agents.js';
import { createWorktree } from '../lib/teams/worktree.js';

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function makeRepo(): { tmp: string; clone: string } {
  const tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'agents-teardown-')));
  const bare = path.join(tmp, 'remote.git');
  const seed = path.join(tmp, 'seed');
  const clone = path.join(tmp, 'clone');

  git(tmp, ['init', '-q', '--bare', '-b', 'main', bare]);
  git(tmp, ['clone', '-q', bare, seed]);
  git(seed, ['config', 'user.email', 'test@example.com']);
  git(seed, ['config', 'user.name', 'test']);
  fs.writeFileSync(path.join(seed, 'seed.txt'), 'seed\n');
  git(seed, ['add', 'seed.txt']);
  git(seed, ['commit', '-qm', 'seed']);
  git(seed, ['push', '-q', 'origin', 'main']);
  git(tmp, ['clone', '-q', bare, clone]);
  git(clone, ['config', 'user.email', 'test@example.com']);
  git(clone, ['config', 'user.name', 'test']);
  return { tmp, clone };
}

function writeRecord(agentsDir: string, id: string, worktreeName: string, status: AgentStatus): void {
  const dir = path.join(agentsDir, id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'meta.json'),
    JSON.stringify({ agent_id: id, task_name: 'wt-team', worktree_name: worktreeName, status }, null, 2),
  );
}

const worktreePath = (repo: string, name: string) => path.join(repo, '.agents', 'worktrees', name);

describe('tearDownOrphanWorktree (RUSH-2356)', () => {
  const roots: string[] = [];
  const agentDirs: string[] = [];
  afterEach(() => {
    for (const d of roots.splice(0)) fs.rmSync(d, { recursive: true, force: true });
    for (const d of agentDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
  });

  function setup(): { repo: string; agentsDir: string; mgr: AgentManager } {
    const { tmp, clone: repo } = makeRepo();
    roots.push(tmp);
    const agentsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-teardown-recs-'));
    agentDirs.push(agentsDir);
    return { repo, agentsDir, mgr: new AgentManager(50, agentsDir) };
  }

  it('removes a genuine orphan — nothing claims it', async () => {
    const { repo, mgr } = setup();
    await createWorktree(repo, 'orphan');
    expect(fs.existsSync(worktreePath(repo, 'orphan'))).toBe(true);

    await tearDownOrphanWorktree(mgr, repo, 'orphan');

    expect(fs.existsSync(worktreePath(repo, 'orphan'))).toBe(false);
    expect(() => git(repo, ['rev-parse', '--verify', 'agents/orphan'])).toThrow();
  });

  it('PRESERVES a worktree a live, merely-pending teammate claims', async () => {
    const { repo, agentsDir, mgr } = setup();
    await createWorktree(repo, 'claimed');
    writeRecord(agentsDir, 'agent-pending', 'claimed', AgentStatus.PENDING);

    await tearDownOrphanWorktree(mgr, repo, 'claimed');

    expect(fs.existsSync(worktreePath(repo, 'claimed'))).toBe(true);
    expect(git(repo, ['rev-parse', '--verify', 'agents/claimed'])).toBeTruthy();
  });

  it('PRESERVES a worktree when a record is unreadable — fails closed', async () => {
    const { repo, agentsDir, mgr } = setup();
    await createWorktree(repo, 'unknown');
    const dir = path.join(agentsDir, 'agent-corrupt');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'meta.json'), '{ "worktree_name": "unk');

    await tearDownOrphanWorktree(mgr, repo, 'unknown');

    expect(fs.existsSync(worktreePath(repo, 'unknown'))).toBe(true);
  });

  it('removes it once the claiming teammate reaches a terminal status', async () => {
    const { repo, agentsDir, mgr } = setup();
    await createWorktree(repo, 'finished');
    writeRecord(agentsDir, 'agent-done', 'finished', AgentStatus.COMPLETED);

    await tearDownOrphanWorktree(mgr, repo, 'finished');

    expect(fs.existsSync(worktreePath(repo, 'finished'))).toBe(false);
  });

  it('leaves an unrelated teammate\'s worktree alone', async () => {
    const { repo, agentsDir, mgr } = setup();
    await createWorktree(repo, 'mine');
    await createWorktree(repo, 'theirs');
    writeRecord(agentsDir, 'agent-other', 'theirs', AgentStatus.RUNNING);

    await tearDownOrphanWorktree(mgr, repo, 'mine');

    expect(fs.existsSync(worktreePath(repo, 'mine'))).toBe(false);
    expect(fs.existsSync(worktreePath(repo, 'theirs'))).toBe(true);
  });
});
