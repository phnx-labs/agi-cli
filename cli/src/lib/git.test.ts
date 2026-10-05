
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import simpleGit from 'simple-git';
import {
  adoptRepo,
  assertSafeGitTransport,
  assertValidBranchName,
  canonicalGitRemote,
  commitAndPush,
  commitsBehindUpstream,
  displayHomePath,
  isExpectedSystemRepoRemote,
  isSystemRepoOrigin,
  isSystemRepoRemote,
  parseSource,
  tryAutoPullSystemRepo,
  pullRepo,
  pushOrigin,
  resolveSnapshotSha,
  sameGitRemote,
  syncRepoGit,
  _resetSnapshotShaCacheForTest,
} from './git.js';
import { commitCentralConfig } from './state.js';

describe('assertValidBranchName', () => {
  it('allows ordinary branch names', () => {
    expect(() => assertValidBranchName('main')).not.toThrow();
    expect(() => assertValidBranchName('feature/foo')).not.toThrow();
    expect(() => assertValidBranchName('rush-1765-git-push')).not.toThrow();
  });

  it('rejects empty names', () => {
    expect(() => assertValidBranchName('')).toThrow(/empty/);
    expect(() => assertValidBranchName('   ')).toThrow(/empty/);
  });

  it('rejects names that would be parsed as git push options', () => {
    expect(() => assertValidBranchName('--mirror')).toThrow(/git option/);
    expect(() => assertValidBranchName('--receive-pack=evil')).toThrow(/git option/);
    expect(() => assertValidBranchName('-u')).toThrow(/git option/);
    expect(() => assertValidBranchName('--force')).toThrow(/git option/);
  });
});

describe('assertSafeGitTransport', () => {
  const allowed = [
    'https://github.com/owner/repo.git',
    'https://gitlab.com/owner/repo',
    'ssh://git@github.com/owner/repo.git',
    'git@github.com:owner/repo.git',
    'example.com:owner/repo.git',
    '/abs/local/path',
    './relative/path',
    'C:\\Users\\me\\repo',
  ];

  for (const src of allowed) {
    it(`allows ${src}`, () => {
      expect(() => assertSafeGitTransport(src)).not.toThrow();
    });
  }

  const rejected: Array<[string, RegExp]> = [
    ['ext::sh -c "id"', /remote-helper/],
    ['ext::sh -c touch\\ /tmp/pwned', /remote-helper/],
    ['fd::17/18', /remote-helper/],
    ['-oProxyCommand=evil', /interpreted as a git option/],
    ['--upload-pack=evil', /interpreted as a git option/],
    ['http://example.com/repo.git', /not an allowed transport/],
    ['git://example.com/repo.git', /not an allowed transport/],
    ['file:///etc/passwd', /not an allowed transport/],
  ];

  for (const [src, pattern] of rejected) {
    it(`rejects ${src}`, () => {
      expect(() => assertSafeGitTransport(src)).toThrow(pattern);
    });
  }

  it('ignores surrounding whitespace when classifying', () => {
    expect(() => assertSafeGitTransport('  ext::sh -c id  ')).toThrow(/remote-helper/);
  });
});

describe('parseSource transport safety', () => {
  it('rejects a generic http:// URL', () => {
    expect(() => parseSource('http://example.com/owner/repo')).toThrow(/not an allowed transport/);
  });

  it('accepts a generic https:// URL as type url', () => {
    const parsed = parseSource('https://example.com/owner/repo');
    expect(parsed.type).toBe('url');
    expect(parsed.url).toBe('https://example.com/owner/repo.git');
  });

  it('upgrades an http://github.com URL to https (does not reject)', () => {
    const parsed = parseSource('http://github.com/owner/repo');
    expect(parsed.type).toBe('github');
    expect(parsed.url).toBe('https://github.com/owner/repo.git');
  });

  it('keeps gh: shorthand on https', () => {
    const parsed = parseSource('gh:owner/repo');
    expect(parsed.type).toBe('github');
    expect(parsed.url).toBe('https://github.com/owner/repo.git');
  });
});

describe('syncRepoGit', () => {
  let root: string;
  let remote: string;
  let local: string;
  let author: string;

  async function commitFile(dir: string, name: string, body: string, msg: string): Promise<void> {
    const g = simpleGit(dir);
    fs.writeFileSync(path.join(dir, name), body);
    await g.add('-A');
    await g.commit(msg);
  }

  async function configIdentity(dir: string): Promise<void> {
    const g = simpleGit(dir);
    await g.addConfig('user.email', 'test@example.com');
    await g.addConfig('user.name', 'Test');
    await g.addConfig('commit.gpgsign', 'false');
    await g.addConfig('core.autocrlf', 'false');
  }

  beforeEach(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'syncrepo-'));
    remote = path.join(root, 'remote.git');
    local = path.join(root, 'local');
    author = path.join(root, 'author');

    await simpleGit().raw(['init', '--bare', '-b', 'main', remote]);

    await simpleGit().clone(remote, author);
    await configIdentity(author);
    fs.writeFileSync(path.join(author, '.gitattributes'), '* -text\n');
    await commitFile(author, 'README.md', 'v1\n', 'init');
    await simpleGit(author).push('origin', 'main');

    await simpleGit().clone(remote, local);
    await configIdentity(local);
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });


  it('fast-forwards past dirt the incoming changes do not touch, preserving it', async () => {
    await commitFile(author, 'README.md', 'v2\n', 'upstream change');
    await simpleGit(author).push('origin', 'main');
    fs.writeFileSync(path.join(local, 'dirty.txt'), 'uncommitted\n');

    const res = await syncRepoGit(local, { push: false });

    expect(res.success).toBe(true);
    expect(fs.readFileSync(path.join(local, 'README.md'), 'utf8')).toBe('v2\n');
    expect(fs.readFileSync(path.join(local, 'dirty.txt'), 'utf8')).toBe('uncommitted\n');
  });

  it('refuses when an incoming change touches an uncommitted path, and names it', async () => {
    await commitFile(author, 'README.md', 'v2\n', 'upstream change');
    await simpleGit(author).push('origin', 'main');
    fs.writeFileSync(path.join(local, 'README.md'), 'local edit\n');

    const res = await syncRepoGit(local, { push: false });

    expect(res.success).toBe(false);
    expect(res.error).toMatch(/uncommitted changes/);
    expect(res.error).toMatch(/README\.md/);
    expect(fs.readFileSync(path.join(local, 'README.md'), 'utf8')).toBe('local edit\n');
  });

  it('refuses on a dirty tree when local commits still need rebasing', async () => {
    await commitFile(author, 'README.md', 'v2\n', 'upstream change');
    await simpleGit(author).push('origin', 'main');
    await commitFile(local, 'local-only.txt', 'mine\n', 'local work');
    fs.writeFileSync(path.join(local, 'dirty.txt'), 'uncommitted\n');

    const res = await syncRepoGit(local, { push: false });

    expect(res.success).toBe(false);
    expect(res.error).toMatch(/local commit/);
  });


  it('treats a staged deletion as dirty and refuses when it collides', async () => {
    await commitFile(author, 'doomed.txt', 'v1\n', 'add doomed');
    await simpleGit(author).push('origin', 'main');
    await syncRepoGit(local, { push: false });
    await commitFile(author, 'doomed.txt', 'v2\n', 'upstream edits doomed');
    await simpleGit(author).push('origin', 'main');
    await simpleGit(local).rm('doomed.txt');

    const res = await syncRepoGit(local, { push: false });

    expect(res.success).toBe(false);
    expect(res.error).toMatch(/doomed\.txt/);
  });

  it('treats both ends of a staged rename as dirty', async () => {
    await commitFile(author, 'before.txt', 'v1\n', 'add before');
    await simpleGit(author).push('origin', 'main');
    await syncRepoGit(local, { push: false });
    await commitFile(author, 'before.txt', 'v2\n', 'upstream edits before');
    await simpleGit(author).push('origin', 'main');
    await simpleGit(local).raw(['mv', 'before.txt', 'after.txt']);

    const res = await syncRepoGit(local, { push: false });

    expect(res.success).toBe(false);
    expect(res.error).toMatch(/before\.txt/);
  });

  it('refuses when a C-quoted unicode path collides — the case -z exists for', async () => {
    await commitFile(author, 'caf\u00e9.txt', 'v1\n', 'add unicode');
    await simpleGit(author).push('origin', 'main');
    await syncRepoGit(local, { push: false });
    await commitFile(author, 'caf\u00e9.txt', 'v2\n', 'upstream edits unicode');
    await simpleGit(author).push('origin', 'main');
    fs.writeFileSync(path.join(local, 'caf\u00e9.txt'), 'local edit\n');

    const res = await syncRepoGit(local, { push: false });

    expect(res.success).toBe(false);
    expect(res.error).toMatch(/incoming changes touch uncommitted paths/);
    expect(res.error).toMatch(/caf/);
    expect(fs.readFileSync(path.join(local, 'caf\u00e9.txt'), 'utf8')).toBe('local edit\n');
  });


  it('pullRepo also fast-forwards past unrelated dirt', async () => {
    await commitFile(author, 'README.md', 'v2\n', 'upstream change');
    await simpleGit(author).push('origin', 'main');
    fs.writeFileSync(path.join(local, 'dirty.txt'), 'uncommitted\n');

    const res = await pullRepo(local);

    expect(res.success).toBe(true);
    expect(fs.readFileSync(path.join(local, 'README.md'), 'utf8')).toBe('v2\n');
    expect(fs.readFileSync(path.join(local, 'dirty.txt'), 'utf8')).toBe('uncommitted\n');
  });

  it('pullRepo refuses when an incoming change touches an uncommitted path', async () => {
    await commitFile(author, 'README.md', 'v2\n', 'upstream change');
    await simpleGit(author).push('origin', 'main');
    fs.writeFileSync(path.join(local, 'README.md'), 'local edit\n');

    const res = await pullRepo(local);

    expect(res.success).toBe(false);
    expect(res.error).toMatch(/Blocked by local changes/);
    expect(res.error).toMatch(/README\.md/);
    expect(fs.readFileSync(path.join(local, 'README.md'), 'utf8')).toBe('local edit\n');
  });

  it('rebases local onto new upstream commits (pull-only)', async () => {
    await commitFile(author, 'README.md', 'v2\n', 'upstream change');
    await simpleGit(author).push('origin', 'main');

    const res = await syncRepoGit(local, { push: false });
    expect(res.success).toBe(true);
    expect(res.pushed).toBe(false);
    expect(fs.readFileSync(path.join(local, 'README.md'), 'utf8')).toBe('v2\n');
  });

  it('rebases a local commit on top of upstream and pushes it up', async () => {
    await commitFile(author, 'up.txt', 'from-author\n', 'author commit');
    await simpleGit(author).push('origin', 'main');
    await commitFile(local, 'down.txt', 'from-local\n', 'local commit');

    const res = await syncRepoGit(local, { push: true });
    expect(res.success).toBe(true);
    expect(res.pushed).toBe(true);

    const verify = path.join(root, 'verify');
    await simpleGit().clone(remote, verify);
    expect(fs.existsSync(path.join(verify, 'down.txt'))).toBe(true);
    expect(fs.existsSync(path.join(verify, 'up.txt'))).toBe(true);
  });

  const HEADER = '# agents-cli metadata\n# Auto-generated - do not edit manually\n';

  it('REFUSES (does not discard) a dirty central agents.yaml the incoming commit also touches', async () => {
    await commitFile(author, 'agents.yaml', HEADER + 'accounts: {}\n', 'seed central');
    await simpleGit(author).push('origin', 'main');
    await syncRepoGit(local, { push: false });

    await commitFile(author, 'agents.yaml', HEADER + 'accounts:\n  peer: 1\n', 'peer publish');
    await simpleGit(author).push('origin', 'main');
    fs.writeFileSync(path.join(local, 'agents.yaml'), HEADER + 'accounts:\n  mine: 1\n');

    const res = await syncRepoGit(local, { push: false });

    expect(res.success).toBe(false);
    expect(res.error).toMatch(/uncommitted changes/);
    expect(res.error).toMatch(/agents\.yaml/);
    expect(fs.readFileSync(path.join(local, 'agents.yaml'), 'utf8')).toBe(HEADER + 'accounts:\n  mine: 1\n');
  });

  it('pullRepo also REFUSES a dirty central agents.yaml collision, preserving the local edit', async () => {
    await commitFile(author, 'agents.yaml', HEADER + 'accounts: {}\n', 'seed central');
    await simpleGit(author).push('origin', 'main');
    await syncRepoGit(local, { push: false });

    await commitFile(author, 'agents.yaml', HEADER + 'accounts:\n  peer: 2\n', 'peer publish');
    await simpleGit(author).push('origin', 'main');
    fs.writeFileSync(path.join(local, 'agents.yaml'), HEADER + 'accounts:\n  mine: 2\n');

    const res = await pullRepo(local);

    expect(res.success).toBe(false);
    expect(res.error).toMatch(/agents\.yaml/);
    expect(fs.readFileSync(path.join(local, 'agents.yaml'), 'utf8')).toBe(HEADER + 'accounts:\n  mine: 2\n');
  });

  it('Repro B closed by commit-on-write: committed central edit + device-only peer commit integrates with no refusal', async () => {
    await commitFile(author, 'agents.yaml', HEADER + 'accounts: {}\n', 'seed central');
    await simpleGit(author).push('origin', 'main');
    await syncRepoGit(local, { push: false });

    fs.writeFileSync(path.join(local, 'agents.yaml'), HEADER + 'accounts:\n  mine: 1\n');
    expect(commitCentralConfig(local)).toBe(true);
    expect((await simpleGit(local).status()).isClean()).toBe(true);

    fs.mkdirSync(path.join(author, 'devices', 'box'), { recursive: true });
    await commitFile(author, 'devices/box/daemon-state.json', '{"v":1}\n', 'peer device publish');
    await simpleGit(author).push('origin', 'main');

    const res = await syncRepoGit(local, { push: false });

    expect(res.success).toBe(true);
    expect(fs.readFileSync(path.join(local, 'agents.yaml'), 'utf8')).toBe(HEADER + 'accounts:\n  mine: 1\n');
    expect(fs.existsSync(path.join(local, 'devices', 'box', 'daemon-state.json'))).toBe(true);
    expect((await simpleGit(local).status()).isClean()).toBe(true);
  });

  it('refuses regardless of header — there is no header-based tolerance', async () => {
    await commitFile(author, 'agents.yaml', 'accounts: {}\n', 'seed central');
    await simpleGit(author).push('origin', 'main');
    await syncRepoGit(local, { push: false });

    await commitFile(author, 'agents.yaml', 'accounts:\n  peer: 1\n', 'peer publish');
    await simpleGit(author).push('origin', 'main');
    fs.writeFileSync(path.join(local, 'agents.yaml'), 'accounts:\n  mine: 1\n');

    const res = await syncRepoGit(local, { push: false });

    expect(res.success).toBe(false);
    expect(res.error).toMatch(/uncommitted changes/);
    expect(res.error).toMatch(/agents\.yaml/);
    expect(fs.readFileSync(path.join(local, 'agents.yaml'), 'utf8')).toBe('accounts:\n  mine: 1\n');
  });

  it('refuses when a second tracked file also collides (agents.yaml is not the only one)', async () => {
    await commitFile(author, 'agents.yaml', HEADER + 'accounts: {}\n', 'seed central');
    await simpleGit(author).push('origin', 'main');
    await syncRepoGit(local, { push: false });

    fs.writeFileSync(path.join(author, 'agents.yaml'), HEADER + 'accounts:\n  peer: 1\n');
    fs.writeFileSync(path.join(author, 'README.md'), 'peer\n');
    await simpleGit(author).add('-A');
    await simpleGit(author).commit('peer publish two files');
    await simpleGit(author).push('origin', 'main');
    fs.writeFileSync(path.join(local, 'agents.yaml'), HEADER + 'accounts:\n  mine: 1\n');
    fs.writeFileSync(path.join(local, 'README.md'), 'mine\n');

    const res = await syncRepoGit(local, { push: false });

    expect(res.success).toBe(false);
    expect(res.error).toMatch(/uncommitted changes/);
  });

  it('refuses when there are local commits to rebase, even with only an agents.yaml collision', async () => {
    await commitFile(author, 'agents.yaml', HEADER + 'accounts: {}\n', 'seed central');
    await simpleGit(author).push('origin', 'main');
    await syncRepoGit(local, { push: false });

    await commitFile(author, 'agents.yaml', HEADER + 'accounts:\n  peer: 1\n', 'peer publish');
    await simpleGit(author).push('origin', 'main');
    await commitFile(local, 'local-only.txt', 'mine\n', 'local work');
    fs.writeFileSync(path.join(local, 'agents.yaml'), HEADER + 'accounts:\n  mine: 1\n');

    const res = await syncRepoGit(local, { push: false });

    expect(res.success).toBe(false);
    expect(res.error).toMatch(/local commit/);
  });
});

describe('displayHomePath', () => {
  it('renders a home-anchored path in ~-relative form with forward slashes', () => {
    const abs = os.homedir() + path.sep + '.agents' + path.sep + '.system';
    expect(displayHomePath(abs)).toBe('~/.agents/.system');
  });

  it('leaves a path outside the home directory unchanged (bar slash normalization)', () => {
    expect(displayHomePath('/opt/other/repo')).toBe('/opt/other/repo');
    expect(displayHomePath('C:\\some\\win\\path')).toBe('C:/some/win/path');
  });
});

describe('pullRepo dirty-tree hint', () => {
  const tmpDirs: string[] = [];

  afterEach(() => {
    for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true });
    tmpDirs.length = 0;
  });

  it('points the remediation hint at the repo that actually failed, not a hardcoded path', async () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'git-pull-'));
    tmpDirs.push(repo);
    await simpleGit(repo).init();
    fs.writeFileSync(path.join(repo, 'dirty.txt'), 'uncommitted');

    const res = await pullRepo(repo);

    expect(res.success).toBe(false);
    expect(res.error).toContain('Blocked by local changes');
    expect(res.error).toContain(path.basename(repo));
    expect(res.error).toContain(`cd ${displayHomePath(repo)} && git status`);
    expect(res.error).not.toContain('cd ~/.agents ');
  });
});

describe('commitAndPush (clean-but-ahead + dirty)', () => {
  let root: string;
  let remote: string;
  let local: string;

  async function configIdentity(dir: string): Promise<void> {
    const g = simpleGit(dir);
    await g.addConfig('user.email', 'test@example.com');
    await g.addConfig('user.name', 'Test');
    await g.addConfig('commit.gpgsign', 'false');
    await g.addConfig('core.autocrlf', 'false');
  }

  async function commitFile(dir: string, name: string, body: string, msg: string): Promise<void> {
    const g = simpleGit(dir);
    fs.writeFileSync(path.join(dir, name), body);
    await g.add('-A');
    await g.commit(msg);
  }

  beforeEach(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'commitpush-'));
    remote = path.join(root, 'remote.git');
    local = path.join(root, 'local');

    await simpleGit().raw(['init', '--bare', '-b', 'main', remote]);
    await simpleGit().clone(remote, local);
    await configIdentity(local);
    fs.writeFileSync(path.join(local, '.gitattributes'), '* -text\n');
    await commitFile(local, 'README.md', 'v1\n', 'init');
    await simpleGit(local).push('origin', 'main');
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('reports already up to date when clean and not ahead', async () => {
    const res = await commitAndPush(local, 'noop');
    expect(res.success).toBe(true);
    expect(res.pushed).toBe(false);
    expect(res.committed).toBe(false);
    expect(res.detail).toBe('already up to date');
    expect(res.branch).toBe('main');
  });

  it('pushes when the tree is clean but local is ahead of origin', async () => {
    await commitFile(local, 'local-only.txt', 'ahead\n', 'local ahead');
    const pre = await simpleGit(local).status();
    expect(pre.isClean()).toBe(true);
    expect(pre.ahead).toBe(1);

    const res = await commitAndPush(local, 'should not create a new commit');
    expect(res.success).toBe(true);
    expect(res.committed).toBe(false);
    expect(res.pushed).toBe(true);
    expect(res.detail).toMatch(/pushed /);
    expect(res.detail).not.toBe('already up to date');

    const verify = path.join(root, 'verify-ahead');
    await simpleGit().clone(remote, verify);
    expect(fs.existsSync(path.join(verify, 'local-only.txt'))).toBe(true);
  });

  it('commits dirty changes and pushes them', async () => {
    fs.writeFileSync(path.join(local, 'dirty.txt'), 'new\n');
    const res = await commitAndPush(local, 'add dirty');
    expect(res.success).toBe(true);
    expect(res.committed).toBe(true);
    expect(res.pushed).toBe(true);
    expect(res.detail).toMatch(/committed and pushed/);

    const verify = path.join(root, 'verify-dirty');
    await simpleGit().clone(remote, verify);
    expect(fs.readFileSync(path.join(verify, 'dirty.txt'), 'utf8')).toBe('new\n');
  });

  it('refuses to push a hostile branch name that would be a git option', async () => {
    const git = simpleGit(local);
    await expect(pushOrigin(git, '--mirror')).rejects.toThrow(/git option/);
    await expect(pushOrigin(git, '--receive-pack=evil')).rejects.toThrow(/git option/);
    await commitFile(local, 'safe-push.txt', 'ok\n', 'safe push');
    await pushOrigin(git, 'main');
    const verify = path.join(root, 'verify-safe-push');
    await simpleGit().clone(remote, verify);
    expect(fs.readFileSync(path.join(verify, 'safe-push.txt'), 'utf8')).toBe('ok\n');
  });

  it('pushes to a named target branch, not the checked-out one', async () => {
    fs.writeFileSync(path.join(local, 'skills-index.json'), '{"skills":[]}\n');
    const res = await commitAndPush(local, 'update index', 'dev');
    expect(res.success).toBe(true);
    expect(res.pushed).toBe(true);
    expect(res.branch).toBe('dev');

    const onDev = path.join(root, 'verify-dev');
    await simpleGit().clone(remote, onDev, ['--branch', 'dev']);
    expect(fs.existsSync(path.join(onDev, 'skills-index.json'))).toBe(true);

    const onMain = path.join(root, 'verify-main');
    await simpleGit().clone(remote, onMain, ['--branch', 'main']);
    expect(fs.existsSync(path.join(onMain, 'skills-index.json'))).toBe(false);
  });

  it('pushes to a new target branch from a clean, not-ahead tree', async () => {
    const pre = await simpleGit(local).status();
    expect(pre.isClean()).toBe(true);
    expect(pre.ahead).toBe(0);

    const res = await commitAndPush(local, 'noop', 'dev');
    expect(res.success).toBe(true);
    expect(res.committed).toBe(false);
    expect(res.pushed).toBe(true);
    expect(res.branch).toBe('dev');
    expect(res.detail).not.toBe('already up to date');

    const onDev = path.join(root, 'verify-clean-dev');
    await simpleGit().clone(remote, onDev, ['--branch', 'dev']);
    expect(fs.existsSync(path.join(onDev, 'README.md'))).toBe(true);
  });
});

describe('pullRepo reconciliation', () => {
  let root: string;
  let remote: string;
  let local: string;
  let author: string;

  async function configIdentity(dir: string): Promise<void> {
    const g = simpleGit(dir);
    await g.addConfig('user.email', 'test@example.com');
    await g.addConfig('user.name', 'Test');
    await g.addConfig('commit.gpgsign', 'false');
    await g.addConfig('core.autocrlf', 'false');
  }

  async function commitFile(dir: string, name: string, body: string, msg: string): Promise<void> {
    const g = simpleGit(dir);
    fs.writeFileSync(path.join(dir, name), body);
    await g.add('-A');
    await g.commit(msg);
  }

  beforeEach(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'pullrepo-'));
    remote = path.join(root, 'remote.git');
    local = path.join(root, 'local');
    author = path.join(root, 'author');

    await simpleGit().raw(['init', '--bare', '-b', 'main', remote]);
    await simpleGit().clone(remote, author);
    await configIdentity(author);
    fs.writeFileSync(path.join(author, '.gitattributes'), '* -text\n');
    await commitFile(author, 'README.md', 'v1\n', 'init');
    await simpleGit(author).push('origin', 'main');

    await simpleGit().clone(remote, local);
    await configIdentity(local);
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('fast-forwards when the local branch is behind origin', async () => {
    await commitFile(author, 'up.txt', 'from-author\n', 'author commit');
    await simpleGit(author).push('origin', 'main');

    const before = await simpleGit(local).revparse(['HEAD']);
    const res = await pullRepo(local);
    const after = await simpleGit(local).revparse(['HEAD']);

    expect(res.success).toBe(true);
    expect(res.branch).toBe('main');
    expect(res.commit).toMatch(/^[0-9a-f]{7,8}$/);
    expect(after).not.toBe(before);
    expect(fs.existsSync(path.join(local, 'up.txt'))).toBe(true);
  });

  it('fast-forwards a clean 1-behind checkout despite multi-entry FETCH_HEAD (RUSH-2282)', async () => {
    await commitFile(author, 'side.txt', 'side\n', 'side branch base');
    await simpleGit(author).push('origin', 'main');
    await simpleGit(author).checkoutLocalBranch('other');
    await commitFile(author, 'other.txt', 'other\n', 'other branch tip');
    await simpleGit(author).push('origin', 'other');
    await simpleGit(author).checkout('main');

    await commitFile(author, 'up.txt', 'from-author\n', 'author tip');
    await simpleGit(author).push('origin', 'main');

    await simpleGit(local).fetch();
    const fetchHead = path.join(local, '.git', 'FETCH_HEAD');
    expect(fs.existsSync(fetchHead)).toBe(true);
    const fetchHeadBody = fs.readFileSync(fetchHead, 'utf-8');
    expect(fetchHeadBody.trim().split('\n').length).toBeGreaterThanOrEqual(2);

    const before = await simpleGit(local).revparse(['HEAD']);
    const remoteTip = await simpleGit(local).revparse(['origin/main']);
    expect(before).not.toBe(remoteTip);

    const res = await pullRepo(local);
    const after = await simpleGit(local).revparse(['HEAD']);

    expect(res.success, res.error).toBe(true);
    expect(after).toBe(remoteTip);
    expect(fs.existsSync(path.join(local, 'up.txt'))).toBe(true);
  });

  it('reports already up to date when local matches origin', async () => {
    const before = await simpleGit(local).revparse(['HEAD']);
    const res = await pullRepo(local);
    const after = await simpleGit(local).revparse(['HEAD']);

    expect(res.success).toBe(true);
    expect(res.branch).toBe('main');
    expect(after).toBe(before);
  });

  it('rebases a diverged branch instead of refusing when nothing conflicts', async () => {
    await commitFile(author, 'up.txt', 'from-author\n', 'author commit');
    await simpleGit(author).push('origin', 'main');
    await commitFile(local, 'down.txt', 'from-local\n', 'local commit');

    const res = await pullRepo(local);

    expect(res.success).toBe(true);
    expect(fs.existsSync(path.join(local, 'up.txt'))).toBe(true);
    expect(fs.existsSync(path.join(local, 'down.txt'))).toBe(true);
    const log = await simpleGit(local).log({ maxCount: 1 });
    expect(log.latest?.message).toContain('local commit');
  });
});

describe('adoptRepo guards', () => {
  let base: string;
  beforeEach(() => {
    base = fs.mkdtempSync(path.join(os.tmpdir(), 'adopt-guard-'));
  });
  afterEach(() => {
    fs.rmSync(base, { recursive: true, force: true });
  });

  it('refuses a local source (adopt is remote-only, like cloneIntoExisting)', async () => {
    const target = path.join(base, 'target');
    fs.mkdirSync(target);
    const res = await adoptRepo(base, target);
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/local source/i);
    expect(fs.existsSync(path.join(target, '.git'))).toBe(false);
  });

  it('refuses to adopt a dir that is already a git repo', async () => {
    const target = path.join(base, 'already');
    fs.mkdirSync(target);
    await simpleGit(target).init();
    const res = await adoptRepo('https://github.com/owner/repo.git', target);
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/already a git repo/i);
  });

  it('returns a graceful error (never throws) for an unsafe transport URL', async () => {
    const target = path.join(base, 'bad');
    fs.mkdirSync(target);
    const res = await adoptRepo('http://insecure.example/repo.git', target);
    expect(res.success).toBe(false);
    expect(res.error).toBeTruthy();
    expect(fs.existsSync(path.join(target, '.git'))).toBe(false);
    expect(fs.existsSync(path.join(target, '.git-adopt-temp'))).toBe(false);
  });
});

describe('sameGitRemote (adopt-existing repo matching)', () => {
  it('treats the same repo cloned over SSH vs HTTPS as equal', () => {
    expect(sameGitRemote('git@github.com:phnx-labs/.agents-extras.git', 'https://github.com/phnx-labs/.agents-extras.git')).toBe(true);
    expect(sameGitRemote('ssh://git@github.com/acme/team-skills', 'https://github.com/acme/team-skills.git')).toBe(true);
    expect(sameGitRemote('https://user@github.com/acme/team-skills.git', 'https://github.com/acme/team-skills')).toBe(true);
  });

  it('is case-insensitive on host/owner and tolerates trailing slash + .git', () => {
    expect(sameGitRemote('https://GitHub.com/Acme/Team-Skills.git/', 'https://github.com/acme/team-skills')).toBe(true);
  });

  it('distinguishes different repos and refuses null/empty', () => {
    expect(sameGitRemote('git@github.com:acme/a.git', 'git@github.com:acme/b.git')).toBe(false);
    expect(sameGitRemote('https://github.com/acme/a', 'https://gitlab.com/acme/a')).toBe(false);
    expect(sameGitRemote(null, 'https://github.com/acme/a')).toBe(false);
    expect(sameGitRemote('https://github.com/acme/a', undefined)).toBe(false);
  });

  it('canonicalizes to host/owner/repo', () => {
    expect(canonicalGitRemote('git@github.com:phnx-labs/.agents-extras.git')).toBe('github.com/phnx-labs/.agents-extras');
    expect(canonicalGitRemote('https://github.com/phnx-labs/.agents-extras')).toBe('github.com/phnx-labs/.agents-extras');
  });

  it('folds the renamed system repo (.agents → .agents-system) so both names compare equal (PHNX-3394)', () => {
    expect(canonicalGitRemote('git@github.com:phnx-labs/.agents.git')).toBe('github.com/phnx-labs/.agents-system');
    expect(canonicalGitRemote('https://github.com/phnx-labs/.agents')).toBe('github.com/phnx-labs/.agents-system');
    expect(canonicalGitRemote('git@github.com:phnx-labs/.agents-system.git')).toBe('github.com/phnx-labs/.agents-system');
    expect(sameGitRemote('git@github.com:phnx-labs/.agents.git', 'https://github.com/phnx-labs/.agents-system')).toBe(true);
    expect(sameGitRemote('git@github.com:phnx-labs/.agents-extras.git', 'https://github.com/phnx-labs/.agents-system')).toBe(false);
  });
});

describe('isSystemRepoRemote / isSystemRepoOrigin (PHNX-3394 additive rename)', () => {
  it('recognizes BOTH the new canonical name and the legacy name across transports', () => {
    expect(isSystemRepoRemote('git@github.com:phnx-labs/.agents.git')).toBe(true);
    expect(isSystemRepoRemote('https://github.com/phnx-labs/.agents.git')).toBe(true);
    expect(isSystemRepoRemote('https://github.com/phnx-labs/.agents')).toBe(true);
    expect(isSystemRepoRemote('ssh://git@github.com/phnx-labs/.agents')).toBe(true);
    expect(isSystemRepoRemote('git@github.com:phnx-labs/.agents-system.git')).toBe(true);
    expect(isSystemRepoRemote('https://github.com/phnx-labs/.agents-system.git')).toBe(true);
    expect(isSystemRepoRemote('https://github.com/phnx-labs/.agents-system')).toBe(true);
    expect(isSystemRepoRemote('ssh://git@github.com/phnx-labs/.agents-system')).toBe(true);
  });

  it('rejects unrelated repos and empty input', () => {
    expect(isSystemRepoRemote('git@github.com:phnx-labs/.agents-extras.git')).toBe(false);
    expect(isSystemRepoRemote('https://github.com/acme/.agents')).toBe(false);
    expect(isSystemRepoRemote(null)).toBe(false);
    expect(isSystemRepoRemote(undefined)).toBe(false);
    expect(isSystemRepoRemote('')).toBe(false);
  });

  it('reads a real checkout origin (no mocks) for both names', async () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'sysrepo-origin-'));
    try {
      for (const url of [
        'https://github.com/phnx-labs/.agents.git',
        'git@github.com:phnx-labs/.agents-system.git',
      ]) {
        const dir = fs.mkdtempSync(path.join(base, 'repo-'));
        const git = simpleGit(dir);
        await git.init();
        await git.addRemote('origin', url);
        expect(await isSystemRepoOrigin(dir)).toBe(true);
      }

      const other = fs.mkdtempSync(path.join(base, 'repo-'));
      const otherGit = simpleGit(other);
      await otherGit.init();
      await otherGit.addRemote('origin', 'https://github.com/phnx-labs/.agents-extras.git');
      expect(await isSystemRepoOrigin(other)).toBe(false);
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  });
});

describe('pullRepo reconciles a diverged branch by rebasing', () => {
  const tmpDirs: string[] = [];
  afterEach(() => {
    for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true });
    tmpDirs.length = 0;
  });

  async function identity(dir: string): Promise<void> {
    const g = simpleGit(dir);
    await g.addConfig('user.email', 'test@example.com');
    await g.addConfig('user.name', 'Test');
    await g.addConfig('commit.gpgsign', 'false');
    await g.addConfig('core.autocrlf', 'false');
  }

  async function divergedPair(): Promise<{ local: string; author: string }> {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pullrebase-'));
    tmpDirs.push(root);
    const remote = path.join(root, 'remote.git');
    const author = path.join(root, 'author');
    const local = path.join(root, 'local');
    await simpleGit().raw(['init', '--bare', '-b', 'main', remote]);
    await simpleGit().clone(remote, author);
    await identity(author);
    fs.writeFileSync(path.join(author, '.gitattributes'), '* -text\n');
    fs.writeFileSync(path.join(author, 'seed.txt'), 'seed\n');
    await simpleGit(author).add('-A');
    await simpleGit(author).commit('seed');
    await simpleGit(author).push('origin', 'main');
    await simpleGit().clone(remote, local);
    await identity(local);
    return { local, author };
  }

  it('replays a local-only commit on top of upstream instead of refusing', async () => {
    const { local, author } = await divergedPair();

    fs.mkdirSync(path.join(local, 'devices', 'boxA'), { recursive: true });
    fs.writeFileSync(path.join(local, 'devices', 'boxA', 'agents.yaml'), 'agents:\n  claude: 1.0.0\n');
    await simpleGit(local).add('-A');
    await simpleGit(local).commit('chore(devices): snapshot boxA agent pins');

    fs.writeFileSync(path.join(author, 'rule.md'), '# a rule\n');
    await simpleGit(author).add('-A');
    await simpleGit(author).commit('add a rule');
    await simpleGit(author).push('origin', 'main');

    const res = await pullRepo(local);

    expect(res.success).toBe(true);
    expect(fs.existsSync(path.join(local, 'rule.md'))).toBe(true);
    expect(fs.existsSync(path.join(local, 'devices', 'boxA', 'agents.yaml'))).toBe(true);
    const log = await simpleGit(local).log({ maxCount: 1 });
    expect(log.latest?.message).toContain('snapshot boxA agent pins');
  });

  it('rolls the tree back when a conflict aborts the rebase, leaving the repo usable', async () => {
    const { local, author } = await divergedPair();

    fs.writeFileSync(path.join(local, 'seed.txt'), 'local version\n');
    await simpleGit(local).add('-A');
    await simpleGit(local).commit('local edit');

    fs.writeFileSync(path.join(author, 'seed.txt'), 'upstream version\n');
    await simpleGit(author).add('-A');
    await simpleGit(author).commit('upstream edit');
    await simpleGit(author).push('origin', 'main');

    const before = await simpleGit(local).revparse(['HEAD']);
    const res = await pullRepo(local);
    const after = await simpleGit(local).revparse(['HEAD']);

    expect(res.success).toBe(false);

    expect(after).toBe(before);
    expect(fs.existsSync(path.join(local, '.git', 'rebase-merge'))).toBe(false);
    expect(fs.existsSync(path.join(local, '.git', 'rebase-apply'))).toBe(false);
    expect(fs.readFileSync(path.join(local, 'seed.txt'), 'utf-8')).not.toContain('<<<<<<<');
    const status = await simpleGit(local).status();
    expect(status.current).toBe('main');
    expect(status.conflicted).toEqual([]);
  });

  it('reports an in-progress rebase as itself, not as a dirty tree', async () => {
    const { local } = await divergedPair();

    const gp = (await simpleGit(local).raw(['rev-parse', '--git-path', 'rebase-merge'])).trim();
    fs.mkdirSync(path.isAbsolute(gp) ? gp : path.join(local, gp), { recursive: true });

    const res = await pullRepo(local);
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/rebase is still in progress/i);
    expect(res.error).not.toMatch(/Blocked by local changes/);
  });

  it('pulls the remote the branch actually tracks, not a hardcoded origin', async () => {
    const { local } = await divergedPair();

    const root = path.dirname(local);
    const upstreamBare = path.join(root, 'upstream.git');
    await simpleGit().raw(['init', '--bare', '-b', 'main', upstreamBare]);
    await simpleGit(local).raw(['remote', 'add', 'upstream', upstreamBare]);
    await simpleGit(local).raw(['push', 'upstream', 'main']);

    const mover = path.join(root, 'mover');
    await simpleGit().clone(upstreamBare, mover);
    await simpleGit(mover).addConfig('user.email', 'test@example.com');
    await simpleGit(mover).addConfig('user.name', 'Test');
    await simpleGit(mover).addConfig('commit.gpgsign', 'false');
    fs.writeFileSync(path.join(mover, 'from-upstream.txt'), 'x\n');
    await simpleGit(mover).add('-A');
    await simpleGit(mover).commit('upstream moved');
    await simpleGit(mover).push('origin', 'main');

    await simpleGit(local).raw(['fetch', 'upstream']);
    await simpleGit(local).raw(['branch', '--set-upstream-to=upstream/main', 'main']);

    const res = await pullRepo(local);

    expect(res.success).toBe(true);
    expect(fs.existsSync(path.join(local, 'from-upstream.txt'))).toBe(true);
  });

  it('detects an in-progress rebase in a worktree, where .git is a file', async () => {
    const { local } = await divergedPair();
    const wt = path.join(path.dirname(local), 'wt');
    await simpleGit(local).raw(['worktree', 'add', '--detach', wt]);

    expect(fs.statSync(path.join(wt, '.git')).isFile()).toBe(true);

    const gp = (await simpleGit(wt).raw(['rev-parse', '--git-path', 'rebase-merge'])).trim();
    fs.mkdirSync(path.isAbsolute(gp) ? gp : path.join(wt, gp), { recursive: true });

    const res = await pullRepo(wt);
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/rebase is still in progress/i);
  });
});

describe('commitsBehindUpstream', () => {
  let root: string, remote: string, author: string, local: string;

  async function configIdentity(dir: string): Promise<void> {
    const g = simpleGit(dir);
    await g.addConfig('user.email', 'test@example.com');
    await g.addConfig('user.name', 'Test');
    await g.addConfig('commit.gpgsign', 'false');
  }

  beforeEach(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'behind-'));
    remote = path.join(root, 'remote.git');
    author = path.join(root, 'author');
    local = path.join(root, 'local');
    await simpleGit().raw(['init', '--bare', '-b', 'main', remote]);
    await simpleGit().clone(remote, author);
    await configIdentity(author);
    fs.writeFileSync(path.join(author, 'README.md'), 'v1\n');
    await simpleGit(author).add('-A');
    await simpleGit(author).commit('init');
    await simpleGit(author).push('origin', 'main');
    await simpleGit().clone(remote, local);
    await configIdentity(local);
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('counts how many commits the checkout trails its upstream', async () => {
    await simpleGit(author).raw(['commit', '--allow-empty', '-m', 'up1']);
    await simpleGit(author).raw(['commit', '--allow-empty', '-m', 'up2']);
    await simpleGit(author).push('origin', 'main');
    await simpleGit(local).fetch('origin');

    const res = commitsBehindUpstream(local);
    expect(res).not.toBeNull();
    expect(res!.behind).toBe(2);
    expect(res!.branch).toBe('origin/main');
  });

  it('reports zero behind when the checkout matches its upstream', () => {
    const res = commitsBehindUpstream(local);
    expect(res).toMatchObject({ behind: 0, branch: 'origin/main' });
  });

  it('returns null for a non-git directory', () => {
    expect(commitsBehindUpstream(root)).toBeNull();
  });
});

describe('resolveSnapshotSha (#12 — resource/plugin provenance)', () => {
  let repoDir: string;

  beforeEach(async () => {
    repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-cli-git-snapshotsha-'));
    _resetSnapshotShaCacheForTest();
    const g = simpleGit(repoDir);
    await g.init();
    await g.addConfig('user.email', 'test@example.com');
    await g.addConfig('user.name', 'Test');
    await g.addConfig('commit.gpgsign', 'false');
    await g.raw(['commit', '--allow-empty', '-m', 'init']);
  });

  afterEach(() => {
    fs.rmSync(repoDir, { recursive: true, force: true });
    _resetSnapshotShaCacheForTest();
  });

  it('returns the real short HEAD sha for a git repo', () => {
    const expected = execFileSync('git', ['-C', repoDir, 'rev-parse', '--short', 'HEAD']).toString().trim();
    expect(resolveSnapshotSha(repoDir)).toBe(expected);
  });

  it('returns undefined (never throws) for a non-git directory', () => {
    const plainDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-cli-not-a-repo-'));
    try {
      expect(resolveSnapshotSha(plainDir)).toBeUndefined();
    } finally {
      fs.rmSync(plainDir, { recursive: true, force: true });
    }
  });

  it('memoizes per repoRoot — a second commit after the first call is NOT reflected until the cache is cleared', async () => {
    const first = resolveSnapshotSha(repoDir);
    expect(first).toBeTruthy();
    await simpleGit(repoDir).raw(['commit', '--allow-empty', '-m', 'second']);
    expect(resolveSnapshotSha(repoDir)).toBe(first);

    _resetSnapshotShaCacheForTest();
    const expected = execFileSync('git', ['-C', repoDir, 'rev-parse', '--short', 'HEAD']).toString().trim();
    expect(resolveSnapshotSha(repoDir)).toBe(expected);
    expect(resolveSnapshotSha(repoDir)).not.toBe(first);
  });
});

describe('pullRepo strict mode (default-branch-fast-forward)', () => {
  let root: string;
  let remote: string;
  let author: string;
  let local: string;

  async function configIdentity(dir: string): Promise<void> {
    const g = simpleGit(dir);
    await g.addConfig('user.email', 'test@example.com');
    await g.addConfig('user.name', 'Test');
    await g.addConfig('commit.gpgsign', 'false');
    await g.addConfig('core.autocrlf', 'false');
  }

  async function commitFile(dir: string, name: string, body: string, msg: string): Promise<void> {
    const g = simpleGit(dir);
    fs.writeFileSync(path.join(dir, name), body);
    await g.add('-A');
    await g.commit(msg);
  }

  beforeEach(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'pullrepo-strict-'));
    remote = path.join(root, 'remote.git');
    author = path.join(root, 'author');
    local = path.join(root, 'local');

    await simpleGit().raw(['init', '--bare', '-b', 'main', remote]);
    await simpleGit().clone(remote, author);
    await configIdentity(author);
    fs.writeFileSync(path.join(author, '.gitattributes'), '* -text\n');
    await commitFile(author, 'README.md', 'v1\n', 'init');
    await simpleGit(author).push('origin', 'main');

    await simpleGit().clone(remote, local);
    await configIdentity(local);
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('fast-forwards a clean checkout that is behind its upstream', async () => {
    await commitFile(author, 'up.txt', 'new\n', 'upstream commit');
    await simpleGit(author).push('origin', 'main');

    const res = await pullRepo(local, { mode: 'default-branch-fast-forward' });

    expect(res.success).toBe(true);
    expect(res.branch).toBe('main');
    expect(res.commit).toMatch(/^[0-9a-f]{7,8}$/);
    expect(fs.existsSync(path.join(local, 'up.txt'))).toBe(true);
  });

  it('reports success and the current commit when already up-to-date', async () => {
    const res = await pullRepo(local, { mode: 'default-branch-fast-forward' });

    expect(res.success).toBe(true);
    expect(res.branch).toBe('main');
    expect(res.commit).toMatch(/^[0-9a-f]{7,8}$/);
  });

  it('blocks a dirty tree immediately (no fetch attempted)', async () => {
    fs.writeFileSync(path.join(local, 'dirty.txt'), 'unsaved\n');

    const res = await pullRepo(local, { mode: 'default-branch-fast-forward' });

    expect(res.success).toBe(false);
    expect(res.error).toMatch(/dirty|uncommitted/i);
  });

  it('blocks when the local branch has commits ahead of upstream', async () => {
    await commitFile(local, 'local.txt', 'local\n', 'local commit');

    const res = await pullRepo(local, { mode: 'default-branch-fast-forward' });

    expect(res.success).toBe(false);
    expect(res.error).toMatch(/ahead/i);
  });

  it('blocks when the checkout is on a non-default branch', async () => {
    await simpleGit(local).checkoutBranch('feature/x', 'main');

    const res = await pullRepo(local, { mode: 'default-branch-fast-forward' });

    expect(res.success).toBe(false);
    expect(res.error).toMatch(/feature\/x/i);
    expect(res.error).toMatch(/main/i);
  });
});

describe('isExpectedSystemRepoRemote', () => {
  const SAVED = process.env.AGENTS_SYSTEM_REPO;
  afterEach(() => {
    if (SAVED === undefined) delete process.env.AGENTS_SYSTEM_REPO;
    else process.env.AGENTS_SYSTEM_REPO = SAVED;
  });

  it('accepts the canonical system repo and its rename target when no override is set', () => {
    delete process.env.AGENTS_SYSTEM_REPO;
    expect(isExpectedSystemRepoRemote('https://github.com/phnx-labs/.agents-system.git')).toBe(true);
    expect(isExpectedSystemRepoRemote('git@github.com:phnx-labs/.agents-system.git')).toBe(true);
    expect(isExpectedSystemRepoRemote('https://github.com/phnx-labs/.agents.git')).toBe(true);
  });

  it('rejects an unexpected / repointed origin, and null', () => {
    delete process.env.AGENTS_SYSTEM_REPO;
    expect(isExpectedSystemRepoRemote('https://github.com/attacker/evil.git')).toBe(false);
    expect(isExpectedSystemRepoRemote('git@github.com:someone/.agents-system-fork.git')).toBe(false);
    expect(isExpectedSystemRepoRemote(null)).toBe(false);
    expect(isExpectedSystemRepoRemote(undefined)).toBe(false);
    expect(isExpectedSystemRepoRemote('')).toBe(false);
  });

  it('honours an AGENTS_SYSTEM_REPO override and then rejects the default', () => {
    process.env.AGENTS_SYSTEM_REPO = 'gh:acme/dotagents';
    expect(isExpectedSystemRepoRemote('https://github.com/acme/dotagents.git')).toBe(true);
    expect(isExpectedSystemRepoRemote('git@github.com:acme/dotagents.git')).toBe(true);
    expect(isExpectedSystemRepoRemote('https://github.com/phnx-labs/.agents-system.git')).toBe(false);
  });
});

describe('tryAutoPullSystemRepo', () => {
  let root: string;
  let remote: string;
  let local: string;
  let author: string;
  const SAVED = process.env.AGENTS_SYSTEM_REPO;

  async function configIdentity(dir: string): Promise<void> {
    const g = simpleGit(dir);
    await g.addConfig('user.email', 'test@example.com');
    await g.addConfig('user.name', 'Test');
    await g.addConfig('commit.gpgsign', 'false');
    await g.addConfig('core.autocrlf', 'false');
  }

  beforeEach(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'sysrepo-pull-'));
    remote = path.join(root, 'remote.git');
    local = path.join(root, 'system');
    author = path.join(root, 'author');

    await simpleGit().raw(['init', '--bare', '-b', 'main', remote]);
    await simpleGit().clone(remote, author);
    await configIdentity(author);
    fs.writeFileSync(path.join(author, '.gitattributes'), '* -text\n');
    fs.writeFileSync(path.join(author, 'hooks.yaml'), 'v1\n');
    await simpleGit(author).add('-A');
    await simpleGit(author).commit('init');
    await simpleGit(author).push('origin', 'main');

    await simpleGit().clone(remote, local);
    await configIdentity(local);
  });

  afterEach(() => {
    if (SAVED === undefined) delete process.env.AGENTS_SYSTEM_REPO;
    else process.env.AGENTS_SYSTEM_REPO = SAVED;
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('REFUSES a fast-forward when origin is not the expected system remote', async () => {
    delete process.env.AGENTS_SYSTEM_REPO;

    fs.writeFileSync(path.join(author, 'hooks.yaml'), 'v2-EVIL\n');
    await simpleGit(author).add('-A');
    await simpleGit(author).commit('upstream change');
    await simpleGit(author).push('origin', 'main');

    const res = await tryAutoPullSystemRepo(local);

    expect(res.refused).toBe(true);
    expect(res.pulled).toBe(false);
    expect(res.actualRemote).toBe(remote);
    expect(fs.readFileSync(path.join(local, 'hooks.yaml'), 'utf8')).toBe('v1\n');
  });

  it('fast-forwards cleanly when origin matches AGENTS_SYSTEM_REPO', async () => {
    process.env.AGENTS_SYSTEM_REPO = remote;

    fs.writeFileSync(path.join(author, 'hooks.yaml'), 'v2\n');
    await simpleGit(author).add('-A');
    await simpleGit(author).commit('upstream change');
    await simpleGit(author).push('origin', 'main');

    const res = await tryAutoPullSystemRepo(local);

    expect(res.refused).toBeFalsy();
    expect(res.pulled).toBe(true);
    expect(fs.readFileSync(path.join(local, 'hooks.yaml'), 'utf8')).toBe('v2\n');
  });

  it('is a plain no-op (not a refusal) when the checkout has no origin', async () => {
    delete process.env.AGENTS_SYSTEM_REPO;
    await simpleGit(local).removeRemote('origin');

    const res = await tryAutoPullSystemRepo(local);

    expect(res.pulled).toBe(false);
    expect(res.refused).toBeFalsy();
  });

  it('returns pulled:false for a non-git directory', async () => {
    const plain = path.join(root, 'not-a-repo');
    fs.mkdirSync(plain);
    const res = await tryAutoPullSystemRepo(plain);
    expect(res.pulled).toBe(false);
    expect(res.refused).toBeFalsy();
  });
});
