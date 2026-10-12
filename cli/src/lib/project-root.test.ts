import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { execFileSync } from 'child_process';
import {
  toHomeRelative,
  expandLocalHome,
  toRemotePortable,
  parseProjectRef,
  buildProjectPath,
  inferProjectRoot,
  resolveProjectRef,
  resolveProjectDirs,
  localProjectFolder,
  localizeHome,
} from './project-root.js';
import { writeProjectDef } from './projects.js';

const HOME = process.env.HOME ?? os.homedir();

describe('toHomeRelative', () => {
  it('rewrites a path under $HOME to ~/…', () => {
    expect(toHomeRelative(path.join(HOME, 'src/github.com/me'))).toBe('~/src/github.com/me');
  });
  it('maps the home dir itself to ~', () => {
    expect(toHomeRelative(HOME)).toBe('~');
  });
  it('leaves a path outside $HOME absolute', () => {
    expect(toHomeRelative('/opt/projects')).toBe('/opt/projects');
  });
});

describe('expandLocalHome', () => {
  it('expands ~ and $HOME against the local home', () => {
    expect(expandLocalHome('~/src/x')).toBe(path.join(HOME, 'src/x'));
    expect(expandLocalHome('$HOME/src/x')).toBe(path.join(HOME, 'src/x'));
    expect(expandLocalHome('~')).toBe(HOME);
  });
  it('passes non-home paths through unchanged', () => {
    expect(expandLocalHome('/opt/x')).toBe('/opt/x');
    expect(expandLocalHome('rel/path')).toBe('rel/path');
  });
});

describe('toRemotePortable', () => {
  it('rewrites a local-home absolute to ~/… so the remote re-roots it', () => {
    expect(toRemotePortable(path.join(HOME, 'src/x'))).toBe('~/src/x');
  });
  it('leaves ~/$HOME-anchored paths as-is', () => {
    expect(toRemotePortable('~/src/x')).toBe('~/src/x');
    expect(toRemotePortable('$HOME/src/x')).toBe('$HOME/src/x');
  });
  it('leaves a non-home absolute path verbatim (used literally on the host)', () => {
    expect(toRemotePortable('/opt/work')).toBe('/opt/work');
  });
  it('leaves a relative path as-is', () => {
    expect(toRemotePortable('sub/dir')).toBe('sub/dir');
  });
});

describe('parseProjectRef', () => {
  it('parses a bare slug', () => {
    expect(parseProjectRef('agents-cli')).toEqual({ slug: 'agents-cli' });
  });
  it('parses slug@worktree', () => {
    expect(parseProjectRef('agents-cli@fix-bug')).toEqual({ slug: 'agents-cli', worktree: 'fix-bug' });
  });
  it('treats a trailing @ as no worktree', () => {
    expect(parseProjectRef('agents-cli@')).toEqual({ slug: 'agents-cli', worktree: undefined });
  });
});

describe('buildProjectPath', () => {
  it('joins root + slug, home-relative for remote', () => {
    expect(buildProjectPath('~/src/github.com/me', 'agents-cli', true)).toBe(
      '~/src/github.com/me/agents-cli',
    );
  });
  it('appends the worktree path under .agents/worktrees for remote', () => {
    expect(buildProjectPath('~/src/github.com/me', 'agents-cli@fix', true)).toBe(
      '~/src/github.com/me/agents-cli/.agents/worktrees/fix',
    );
  });
  it('expands to an absolute local path when not for remote', () => {
    expect(buildProjectPath('~/src/x', 'repo', false)).toBe(path.join(HOME, 'src/x/repo'));
  });
  it('rejects an empty slug', () => {
    expect(() => buildProjectPath('~/src', '@wt', true)).toThrow(/Invalid --project/);
  });
});

describe('resolveProjectRef — definition first', () => {
  let projDir: string;
  beforeAll(() => {
    projDir = fs.mkdtempSync(path.join(os.tmpdir(), 'proj-def-'));
    process.env.AGENTS_PROJECTS_DIR = projDir;
    writeProjectDef({ name: 'acme', root: '~/src/acme', defaultPath: '~/src/acme/apps/api' });
  });
  afterAll(() => {
    delete process.env.AGENTS_PROJECTS_DIR;
    fs.rmSync(projDir, { recursive: true, force: true });
  });

  it('a defined project resolves to its defaultPath (forRemote keeps ~)', async () => {
    expect(await resolveProjectRef('acme', { forRemote: true })).toBe('~/src/acme/apps/api');
  });
  it('a defined project @worktree resolves under the repo root', async () => {
    expect(await resolveProjectRef('acme@fix', { forRemote: true })).toBe(
      '~/src/acme/.agents/worktrees/fix',
    );
  });
});

describe('resolveProjectDirs', () => {
  let projDir: string;
  let sysDir: string;
  let mainDir: string;

  beforeAll(() => {
    projDir = fs.mkdtempSync(path.join(os.tmpdir(), 'proj-dirs-'));
    process.env.AGENTS_PROJECTS_DIR = projDir;
    mainDir = fs.mkdtempSync(path.join(os.tmpdir(), 'proj-main-'));
    sysDir = fs.mkdtempSync(path.join(os.tmpdir(), 'proj-sys-'));
    writeProjectDef({
      name: 'multi',
      root: mainDir,
      repos: [
        { slug: 'o/main', path: mainDir },
        { slug: 'o/sys', path: sysDir },
      ],
    });
    writeProjectDef({ name: 'lonely', root: mainDir });
  });
  afterAll(() => {
    delete process.env.AGENTS_PROJECTS_DIR;
    for (const d of [projDir, mainDir, sysDir]) fs.rmSync(d, { recursive: true, force: true });
  });

  it('returns the cwd resolveProjectRef gives, and never repeats it in extraDirs', async () => {
    const { cwd, extraDirs } = await resolveProjectDirs('multi', { forRemote: false });
    expect(cwd).toBe(await resolveProjectRef('multi', { forRemote: false }));
    expect(extraDirs).toEqual([path.resolve(sysDir)]);
    expect(extraDirs).not.toContain(cwd);
  });

  it('is empty for a project that binds only its own checkout', async () => {
    const { cwd, extraDirs } = await resolveProjectDirs('lonely', { forRemote: false });
    expect(cwd).toBe(path.resolve(mainDir));
    expect(extraDirs).toEqual([]);
  });


  it('a @worktree ref keeps the worktree as cwd and grants the main checkout too', async () => {
    const wt = path.join(mainDir, '.agents', 'worktrees', 'fix');
    fs.mkdirSync(wt, { recursive: true });
    const { cwd, extraDirs } = await resolveProjectDirs('multi@fix', { forRemote: false });
    expect(cwd).toBe(path.resolve(wt));
    expect(extraDirs).toEqual([path.resolve(mainDir), path.resolve(sysDir)]);
  });
});

describe('inferProjectRoot', () => {
  let tmp: string;
  let repo: string;

  const expectedRoot = () =>
    toHomeRelative(process.platform === 'win32' ? tmp : fs.realpathSync(tmp));


  beforeAll(() => {
    tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'proot-')));
    repo = path.join(tmp, 'my-repo');
    fs.mkdirSync(path.join(repo, 'sub', 'deep'), { recursive: true });
    const git = (args: string[]) =>
      execFileSync('git', args, {
        cwd: repo,
        env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' },
      });
    git(['init', '-q']);
    fs.writeFileSync(path.join(repo, 'README'), 'x');
    git(['add', '-A']);
    git(['commit', '-qm', 'init']);
  });
  afterAll(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('returns the directory ABOVE the git root, resolved from a nested cwd', async () => {
    const root = await inferProjectRoot(path.join(repo, 'sub', 'deep'));
    expect(root && path.normalize(root)).toBe(path.normalize(expectedRoot()));
  });

  it('resolves the MAIN repo root from inside a linked worktree (not the worktree dir)', async () => {
    const wt = path.join(repo, '.agents', 'worktrees', 'feat');
    fs.mkdirSync(path.dirname(wt), { recursive: true });
    execFileSync('git', ['worktree', 'add', '-q', wt], { cwd: repo });
    expect(path.normalize((await inferProjectRoot(wt))!)).toBe(path.normalize(expectedRoot()));
  });

  it('returns undefined when cwd is not inside a git repo', async () => {
    const nonRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'norepo-'));
    try {
      expect(await inferProjectRoot(nonRepo)).toBeUndefined();
    } finally {
      fs.rmSync(nonRepo, { recursive: true, force: true });
    }
  });
});

describe('localProjectFolder — the local window folder for a session cwd', () => {
  const home = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'lpf-home-')), 'muqsit');
  const repo = path.join(home, 'src', 'github.com', 'me', 'svatlas');
  fs.mkdirSync(repo, { recursive: true });

  it('maps the same user\'s home on a peer (/home/<u> or /Users/<u>) onto this home', () => {
    expect(localProjectFolder('/home/muqsit/src/github.com/me/svatlas', home)).toBe(repo);
    expect(localProjectFolder('/Users/muqsit/src/github.com/me/svatlas', home)).toBe(repo);
    expect(localProjectFolder('/Users/someone/src/github.com/me/svatlas', home)).toBeUndefined();
  });
  it('keeps a cwd that is already local, and folds a worktree to its repo', () => {
    expect(localProjectFolder(repo, home)).toBe(repo);
    expect(localProjectFolder('/home/muqsit/src/github.com/me/svatlas/.agents/worktrees/fix-x/cli', home)).toBe(repo);
  });
  it('is undefined when no local copy exists or the cwd is just the home', () => {
    expect(localProjectFolder('/home/muqsit/src/github.com/me/missing', home)).toBeUndefined();
    expect(localProjectFolder('/home/muqsit', home)).toBeUndefined();
    expect(localProjectFolder(undefined, home)).toBeUndefined();
  });
});

describe('localizeHome — a path from another box\'s home, named on this one', () => {
  it('maps /home/<u> and /Users/<u> onto this home and keeps local and non-home paths', () => {
    expect(localizeHome('/home/muqsit/src/x', '/Users/muqsit')).toBe('/Users/muqsit/src/x');
    expect(localizeHome('/Users/muqsit', '/home/muqsit')).toBe('/home/muqsit');
    expect(localizeHome('/Users/muqsit/src/x', '/Users/muqsit')).toBe('/Users/muqsit/src/x');
    expect(localizeHome('/srv/data/x', '/Users/muqsit')).toBe('/srv/data/x');
    expect(localizeHome('/home', '/Users/muqsit')).toBe('/home');
  });
  it('leaves another user\'s home and non-user dirs alone (PHNX-4344 review)', () => {
    expect(localizeHome('/Users/Shared/proj', '/Users/muqsit')).toBe('/Users/Shared/proj');
    expect(localizeHome('/home/linuxbrew/x', '/Users/muqsit')).toBe('/home/linuxbrew/x');
    expect(localizeHome('/Users/muqsit2/x', '/Users/muqsit')).toBe('/Users/muqsit2/x');
    expect(localizeHome('/home/alice/x', '/home/bob')).toBe('/home/alice/x');
    expect(localizeHome('/Users/Shared/proj', '/Users/Shared')).toBe('/Users/Shared/proj');
  });
});
