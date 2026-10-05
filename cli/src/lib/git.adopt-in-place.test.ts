/**
 * Real-repo tests for adoptRepoInPlace — the `agents repo sync user` self-heal
 * (PHNX-3301). A directory that carries runtime state but lost (or never had)
 * its `.git` is git-backed IN PLACE against a real local bare remote: no mocks of
 * the unit, no re-clone. Asserts it restores tracking, materializes only the
 * MISSING tracked files, preserves gitignored runtime state, reconciles a
 * stale-stub agents.yaml, surfaces (never clobbers) real local edits, pushes no
 * stray commit, and is idempotent.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import simpleGit from 'simple-git';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  adoptRepoInPlace,
  adoptUserRepoIfNeeded,
  isStaleAgentsYamlStub,
  recordUserRepoRemote,
  resolveUserRepoRemoteUrl,
} from './git.js';

const COMMITTED_AGENTS_YAML = [
  '# agents-cli metadata',
  'hooks:',
  '  SessionStart:',
  '    - startup',
  'config:',
  '  interactiveHost: zion',
  '  defaultBrowserDevice: zion',
  'fleet:',
  '  devices: {}',
  '',
].join('\n');

async function configIdentity(dir: string): Promise<void> {
  const g = simpleGit(dir);
  await g.addConfig('user.email', 'test@example.com');
  await g.addConfig('user.name', 'Test');
  await g.addConfig('commit.gpgsign', 'false');
  await g.addConfig('core.autocrlf', 'false');
}

async function originCommitCount(remote: string): Promise<number> {
  const out = await simpleGit().raw(['--git-dir', remote, 'rev-list', '--count', 'main']);
  return parseInt(out.trim(), 10);
}

describe('adoptRepoInPlace', () => {
  let root: string;
  let remote: string; // bare origin
  let author: string; // seeds the remote
  let target: string; // the non-git dir being adopted

  beforeEach(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'adopt-'));
    remote = path.join(root, 'remote.git');
    author = path.join(root, 'author');
    target = path.join(root, 'target');

    await simpleGit().raw(['init', '--bare', '-b', 'main', remote]);
    await simpleGit().clone(remote, author);
    await configIdentity(author);
    // Tracked resources + a .gitignore that excludes runtime state.
    fs.writeFileSync(path.join(author, '.gitattributes'), '* -text\n');
    fs.writeFileSync(path.join(author, '.gitignore'), '.cache/\nscratch/\n');
    fs.writeFileSync(path.join(author, 'agents.yaml'), COMMITTED_AGENTS_YAML);
    fs.mkdirSync(path.join(author, 'skills'), { recursive: true });
    fs.writeFileSync(path.join(author, 'skills', 'browser.md'), 'browser skill\n');
    fs.mkdirSync(path.join(author, 'rules'), { recursive: true });
    fs.writeFileSync(path.join(author, 'rules', 'keep.md'), 'committed\n');
    const g = simpleGit(author);
    await g.add('-A');
    await g.commit('seed config repo');
    await g.push('origin', 'main');

    // The partial box: runtime state present, one existing tracked file with a
    // LOCAL edit, a stub agents.yaml, and NO .git.
    fs.mkdirSync(path.join(target, '.cache'), { recursive: true });
    fs.writeFileSync(path.join(target, '.cache', 'state.json'), '{"runtime":true}\n');
    fs.mkdirSync(path.join(target, 'scratch'), { recursive: true });
    fs.writeFileSync(path.join(target, 'scratch', 'note.txt'), 'do not lose me\n');
    fs.mkdirSync(path.join(target, 'rules'), { recursive: true });
    fs.writeFileSync(path.join(target, 'rules', 'keep.md'), 'LOCAL EDIT\n');
    fs.writeFileSync(path.join(target, 'agents.yaml'), 'hooks:\nfleet: {}\n'); // short stub
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('adopts a non-git dir in place: tracking, materialize-missing, preserve runtime, no stray commit', async () => {
    expect(fs.existsSync(path.join(target, '.git'))).toBe(false);
    const before = await originCommitCount(remote);

    const res = await adoptRepoInPlace(target, remote);

    expect(res.error).toBeUndefined();
    expect(res.success).toBe(true);

    // 1. Tracking restored: real repo, HEAD -> main on origin/main, origin set.
    const g = simpleGit(target);
    expect(fs.existsSync(path.join(target, '.git'))).toBe(true);
    expect((await g.raw(['symbolic-ref', 'HEAD'])).trim()).toBe('refs/heads/main');
    const remotes = await g.getRemotes(true);
    expect(remotes.find((r) => r.name === 'origin')?.refs.fetch).toBe(remote);
    // HEAD is exactly origin/main — no local divergence.
    const head = (await g.raw(['rev-parse', 'HEAD'])).trim();
    const originMain = (await g.raw(['rev-parse', 'origin/main'])).trim();
    expect(head).toBe(originMain);

    // 2. Missing tracked files materialized from origin.
    expect(fs.readFileSync(path.join(target, 'skills', 'browser.md'), 'utf8')).toBe('browser skill\n');
    expect(res.materialized).toBeGreaterThan(0);

    // 3. Runtime (gitignored) state preserved untouched.
    expect(fs.readFileSync(path.join(target, '.cache', 'state.json'), 'utf8')).toBe('{"runtime":true}\n');
    expect(fs.readFileSync(path.join(target, 'scratch', 'note.txt'), 'utf8')).toBe('do not lose me\n');

    // 4. Stale-stub agents.yaml reconciled from origin — and the pre-reconcile
    //    local copy saved to gitignored runtime state (recoverable, not lost).
    expect(res.reconciledAgentsYaml).toBe(true);
    expect(fs.readFileSync(path.join(target, 'agents.yaml'), 'utf8')).toBe(COMMITTED_AGENTS_YAML);
    expect(res.agentsYamlBackup).toBeTruthy();
    expect(fs.readFileSync(res.agentsYamlBackup!, 'utf8')).toBe('hooks:\nfleet: {}\n');

    // 5. A real local edit is surfaced, NOT overwritten.
    expect(fs.readFileSync(path.join(target, 'rules', 'keep.md'), 'utf8')).toBe('LOCAL EDIT\n');
    expect(res.localEdits).toContain('rules/keep.md');
    // The reconciled agents.yaml is not counted as an unresolved edit.
    expect(res.localEdits).not.toContain('agents.yaml');

    // 6. No stray commit pushed to origin.
    expect(await originCommitCount(remote)).toBe(before);
    expect((await g.raw(['rev-list', '--count', 'origin/main..HEAD'])).trim()).toBe('0');
  });

  it('is idempotent — a second run re-materializes nothing and keeps origin clean', async () => {
    const before = await originCommitCount(remote);
    const first = await adoptRepoInPlace(target, remote);
    expect(first.success).toBe(true);

    const second = await adoptRepoInPlace(target, remote);
    expect(second.success).toBe(true);
    expect(second.materialized).toBe(0);
    expect(await originCommitCount(remote)).toBe(before);
  });

  it('adoptUserRepoIfNeeded returns null when already git-backed with an origin', async () => {
    await adoptRepoInPlace(target, remote);
    expect(await adoptUserRepoIfNeeded(target)).toBeNull();
  });

  it('adoptUserRepoIfNeeded reports needsUrl when no remote URL is known', async () => {
    delete process.env.AGENTS_USER_REPO_URL;
    const res = await adoptUserRepoIfNeeded(target);
    expect(res?.success).toBe(false);
    expect(res?.needsUrl).toBe(true);
  });
});

describe('resolveUserRepoRemoteUrl', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'resolve-url-'));
    delete process.env.AGENTS_USER_REPO_URL;
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    delete process.env.AGENTS_USER_REPO_URL;
  });

  it('falls back to a device-local record after a .git loss', () => {
    expect(resolveUserRepoRemoteUrl(dir)).toBeNull();
    recordUserRepoRemote(dir, 'git@github.com:me/.agents.git');
    expect(resolveUserRepoRemoteUrl(dir)).toBe('git@github.com:me/.agents.git');
  });

  it('prefers the env override over a stale record', () => {
    recordUserRepoRemote(dir, 'git@github.com:me/.agents.git');
    process.env.AGENTS_USER_REPO_URL = 'https://github.com/me/other.git';
    expect(resolveUserRepoRemoteUrl(dir)).toBe('https://github.com/me/other.git');
  });
});

describe('isStaleAgentsYamlStub', () => {
  it('flags a shorter stub missing config:/hooks: blocks', () => {
    expect(isStaleAgentsYamlStub('fleet: {}\n', COMMITTED_AGENTS_YAML)).toBe(true);
  });
  it('leaves a full/customized agents.yaml alone', () => {
    const customized = COMMITTED_AGENTS_YAML + '\nextra: value\n';
    expect(isStaleAgentsYamlStub(customized, COMMITTED_AGENTS_YAML)).toBe(false);
  });
  it('is a no-op when local already equals committed', () => {
    expect(isStaleAgentsYamlStub(COMMITTED_AGENTS_YAML, COMMITTED_AGENTS_YAML)).toBe(false);
  });
});
