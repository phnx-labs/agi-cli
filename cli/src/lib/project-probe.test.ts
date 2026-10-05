import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { stripAnsi } from './session/width.js';
import {
  formatFleetSummary,
  formatFleetWorkspaces,
  workspaceWarnings,
  formatWorkspaceLine,
  parseRemoteProbe,
  probeProjectWorkspaces,
  probeRepoWorkspace,
  workspaceTargetsForDef,
  type HostWorkspaceStatus,
} from './project-probe.js';

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'project-probe-test-'));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

function initRepo(p: string): void {
  fs.mkdirSync(p, { recursive: true });
  git(p, ['init', '-b', 'main']);
  git(p, ['config', 'user.email', 'probe@example.com']);
  git(p, ['config', 'user.name', 'Probe Test']);
  git(p, ['config', 'commit.gpgsign', 'false']);
}

function commit(p: string, msg: string): void {
  fs.appendFileSync(path.join(p, 'file.txt'), `${msg}\n`);
  git(p, ['add', '.']);
  git(p, ['commit', '-m', msg]);
}

function repoWithUpstream(name: string): { repo: string; remote: string } {
  const remote = path.join(dir, `${name}.git`);
  git(dir, ['init', '--bare', '-b', 'main', remote]);
  const repo = path.join(dir, name);
  initRepo(repo);
  commit(repo, 'initial');
  git(repo, ['remote', 'add', 'origin', remote]);
  git(repo, ['push', '-u', 'origin', 'main']);
  return { repo, remote };
}

describe('probeRepoWorkspace', () => {
  it('reports a missing path as not present without any git state', () => {
    const s = probeRepoWorkspace(path.join(dir, 'nope'));
    expect(s).toEqual({ path: path.join(dir, 'nope'), present: false });
  });

  it('reads branch, upstream, zero drift, and cleanliness on an even repo', () => {
    const { repo } = repoWithUpstream('even');
    const s = probeRepoWorkspace(repo);
    expect(s.present).toBe(true);
    expect(s.branch).toBe('main');
    expect(s.upstream).toBe('origin/main');
    expect(s.ahead).toBe(0);
    expect(s.behind).toBe(0);
    expect(s.dirty).toBe(0);
    expect(s.error).toBeUndefined();
    expect(s.lastCommit).toBe(git(repo, ['log', '-1', '--format=%cI']).trim());
  });

  it('counts ahead commits not yet pushed', () => {
    const { repo } = repoWithUpstream('ahead');
    commit(repo, 'one');
    commit(repo, 'two');
    const s = probeRepoWorkspace(repo);
    expect(s.ahead).toBe(2);
    expect(s.behind).toBe(0);
  });

  it('counts behind commits against the last-fetched upstream (no fetch in the probe)', () => {
    const { repo, remote } = repoWithUpstream('behind');
    const other = path.join(dir, 'behind-other');
    git(dir, ['clone', remote, other]);
    git(other, ['config', 'user.email', 'probe@example.com']);
    git(other, ['config', 'user.name', 'Probe Test']);
    git(other, ['config', 'commit.gpgsign', 'false']);
    commit(other, 'remote-work');
    git(other, ['push', 'origin', 'main']);
    git(repo, ['fetch', 'origin']);
    const s = probeRepoWorkspace(repo);
    expect(s.behind).toBe(1);
    expect(s.ahead).toBe(0);
  });

  it('counts uncommitted and untracked files as dirty', () => {
    const { repo } = repoWithUpstream('dirty');
    fs.appendFileSync(path.join(repo, 'file.txt'), 'modified\n');
    fs.writeFileSync(path.join(repo, 'untracked.txt'), 'new\n');
    const s = probeRepoWorkspace(repo);
    expect(s.dirty).toBe(2);
  });

  it('leaves ahead/behind undefined on a repo with no upstream', () => {
    const repo = path.join(dir, 'no-upstream');
    initRepo(repo);
    commit(repo, 'initial');
    const s = probeRepoWorkspace(repo);
    expect(s.present).toBe(true);
    expect(s.branch).toBe('main');
    expect(s.upstream).toBeUndefined();
    expect(s.ahead).toBeUndefined();
    expect(s.behind).toBeUndefined();
    expect(s.error).toBeUndefined();
  });

  it('treats a linked worktree (a .git FILE) as present', () => {
    const { repo } = repoWithUpstream('wt-src');
    const wt = path.join(dir, 'wt-linked');
    git(repo, ['worktree', 'add', '-b', 'wt-branch', wt]);
    expect(fs.statSync(path.join(wt, '.git')).isFile()).toBe(true);
    const s = probeRepoWorkspace(wt);
    expect(s.present).toBe(true);
    expect(s.branch).toBe('wt-branch');
  });

  it('surfaces a broken .git as present-with-error, never silently clean', () => {
    const broken = path.join(dir, 'broken');
    fs.mkdirSync(path.join(broken, '.git'), { recursive: true });
    const s = probeRepoWorkspace(broken);
    expect(s.present).toBe(true);
    expect(s.error).toBeTruthy();
    expect(s.branch).toBeUndefined();
  });
});

describe('probeProjectWorkspaces', () => {
  it('probes each given path in order', () => {
    const repo = path.join(dir, 'home-rel');
    initRepo(repo);
    commit(repo, 'initial');
    const [s, missing] = probeProjectWorkspaces([repo, path.join(dir, 'absent')]);
    expect(s.present).toBe(true);
    expect(s.path).toBe(repo);
    expect(missing.present).toBe(false);
  });
});

describe('workspaceTargetsForDef', () => {
  it('collects root plus repos[].path, deduped', () => {
    expect(workspaceTargetsForDef({
      name: 'rush',
      root: '~/src/rush',
      repos: [
        { slug: 'phnx-labs/rush-infra', path: '~/src/rush-infra' },
        { slug: 'phnx-labs/rush-docs', path: '~/src/rush' },
        { slug: 'phnx-labs/slug-only' },
      ],
    })).toEqual(['~/src/rush', '~/src/rush-infra']);
  });

  it('anchors on root, NOT defaultPath — a monorepo subproject probes its checkout', () => {
    expect(workspaceTargetsForDef({
      name: 'rush-web',
      root: '~/src/rush',
      defaultPath: '~/src/rush/apps/web',
    })).toEqual(['~/src/rush']);
  });

  it('does NOT join repos[].subpath — the probe wants the repo root', () => {
    expect(workspaceTargetsForDef({
      name: 'rush',
      root: '~/src/rush',
      repos: [{ slug: 'phnx-labs/rush-infra', path: '~/src/rush-infra', subpath: 'deploy' }],
    })).toEqual(['~/src/rush', '~/src/rush-infra']);
  });

  it('returns an empty list when the def carries no on-disk paths', () => {
    expect(workspaceTargetsForDef({ name: 'x', repo: 'a/b' })).toEqual([]);
  });

  it('normalizes hand-edited def paths to the same home-relative form the probe echoes', () => {
    const abs = path.join(os.homedir(), 'src', 'rush');
    expect(workspaceTargetsForDef({ name: 'rush', root: abs })).toEqual(['~/src/rush']);
    expect(workspaceTargetsForDef({ name: 'rush', root: '~/src/rush/' })).toEqual(['~/src/rush']);
  });
});

describe('parseRemoteProbe', () => {
  it('host-tags valid rows and drops malformed ones', () => {
    const rows = parseRemoteProbe(JSON.stringify([
      { path: '~/src/rush', present: true, branch: 'main', dirty: 0 },
      { path: 42, present: true },
      'nope',
    ]), 'mac-mini');
    expect(rows).toEqual([{ path: '~/src/rush', present: true, branch: 'main', dirty: 0, host: 'mac-mini' }]);
  });

  it('returns [] on non-JSON or non-array output (version skew)', () => {
    expect(parseRemoteProbe('not json', 'a')).toEqual([]);
    expect(parseRemoteProbe('{"x":1}', 'a')).toEqual([]);
  });
});

describe('formatWorkspaceLine', () => {
  const base = { path: '~/src/rush', present: true };

  it('renders each state', () => {
    expect(stripAnsi(formatWorkspaceLine({ path: '~/src/rush', present: false }))).toBe('✗ missing');
    expect(stripAnsi(formatWorkspaceLine({ ...base, branch: 'main', dirty: 0, ahead: 0, behind: 0 })))
      .toBe('✓ clean · main');
    expect(stripAnsi(formatWorkspaceLine({ ...base, branch: 'feature/x', dirty: 12, ahead: 3, behind: 1 })))
      .toBe('⚠ 12 dirty · ↑3 ↓1 · feature/x');
    expect(stripAnsi(formatWorkspaceLine({ ...base, branch: 'main', dirty: 0, ahead: 3 })))
      .toBe('⚠ ↑3 · main');
    expect(stripAnsi(formatWorkspaceLine({ ...base, branch: 'main', dirty: 0, behind: 5 })))
      .toBe('⚠ ↓5 · main');
    expect(stripAnsi(formatWorkspaceLine({ ...base, error: 'git exploded' }))).toBe('⚠ error: git exploded');
  });
});

describe('formatFleetWorkspaces', () => {
  it('joins one line host-sorted for a single probed path', () => {
    const statuses: HostWorkspaceStatus[] = [
      { path: '~/src/rush', present: false, host: 'zion' },
      { path: '~/src/rush', present: true, branch: 'main', dirty: 0, host: 'gpu-box' },
      { path: '~/src/rush', present: true, branch: 'feature/x', dirty: 2, behind: 5, host: 'mac-mini' },
    ];
    const lines = formatFleetWorkspaces(statuses).map(stripAnsi);
    expect(lines).toEqual([
      'gpu-box: ✓ clean · main  ·  mac-mini: ⚠ 2 dirty · ↓5 · feature/x  ·  zion: ✗ missing',
    ]);
  });

  it('renders one labelled line per path when a project probes several', () => {
    const statuses: HostWorkspaceStatus[] = [
      { path: '~/src/rush', present: true, branch: 'main', dirty: 0, host: 'zion' },
      { path: '~/src/rush-infra', present: false, host: 'zion' },
    ];
    const lines = formatFleetWorkspaces(statuses).map(stripAnsi);
    expect(lines).toEqual([
      '~/src/rush · zion: ✓ clean · main',
      '~/src/rush-infra · zion: ✗ missing',
    ]);
  });
});

describe('workspaceWarnings', () => {
  it('marks missing checkouts critical and dirty trees continue', () => {
    const w = workspaceWarnings([
      { host: 'zion', path: '~/src/x', present: true, dirty: 2, behind: 0, branch: 'main' },
      { host: 'yosemite-s0', path: '~/src/x', present: true, behind: 40, upstream: 'origin/main', branch: 'main' },
      { host: 'mac-mini', path: '~/src/x', present: false },
    ]);
    expect(w.find((x) => x.text.includes('missing'))?.severity).toBe('critical');
    expect(w.find((x) => x.text.includes('40'))?.severity).toBe('critical');
    expect(w.find((x) => x.text.includes('uncommitted'))?.severity).toBe('continue');
  });

  it('treats small behind as continue', () => {
    const w = workspaceWarnings([
      { host: 'zion', path: '~/src/x', present: true, behind: 2, upstream: 'origin/main' },
    ]);
    expect(w[0].severity).toBe('continue');
  });

  it('groups several behind hosts into ONE warning with ONE remediation, worst first', () => {
    const w = workspaceWarnings([
      { host: 'yosemite-m1', path: '~/src/x', present: true, behind: 8, upstream: 'origin/main' },
      { host: 'mac-mini', path: '~/src/x', present: true, behind: 172, upstream: 'origin/main' },
      { host: 'yosemite-m2', path: '~/src/x', present: true, behind: 217, upstream: 'origin/main' },
    ]);
    expect(w).toHaveLength(1);
    expect(stripAnsi(w[0].text)).toBe(
      '3 hosts behind origin/main (~/src/x) — yosemite-m2 ↓217, mac-mini ↓172, yosemite-m1 ↓8',
    );
    expect(w[0].severity).toBe('critical');
    expect(w[0].remediation).toBe('pull (or rebase) before agents on these hosts open PRs against a stale base');
  });

  it('keeps a behind group continue when every host is <10 behind', () => {
    const w = workspaceWarnings([
      { host: 'a', path: '~/src/x', present: true, behind: 3, upstream: 'origin/main' },
      { host: 'b', path: '~/src/x', present: true, behind: 9, upstream: 'origin/main' },
    ]);
    expect(w).toHaveLength(1);
    expect(w[0].severity).toBe('continue');
    expect(stripAnsi(w[0].text)).toBe('2 hosts behind origin/main (~/src/x) — b ↓9, a ↓3');
  });

  it('falls back to "upstream" when the behind hosts do not share one', () => {
    const w = workspaceWarnings([
      { host: 'a', path: '~/src/x', present: true, behind: 5, upstream: 'origin/main' },
      { host: 'b', path: '~/src/x', present: true, behind: 4, upstream: 'origin/dev' },
    ]);
    expect(stripAnsi(w[0].text)).toBe('2 hosts behind upstream (~/src/x) — a ↓5, b ↓4');
  });

  it('groups several dirty hosts into one continue warning, most changes first', () => {
    const w = workspaceWarnings([
      { host: 'zion', path: '~/src/x', present: true, dirty: 1, branch: 'main' },
      { host: 'pinnacles', path: '~/src/x', present: true, dirty: 16, branch: 'main' },
    ]);
    expect(w).toHaveLength(1);
    expect(w[0].severity).toBe('continue');
    expect(stripAnsi(w[0].text)).toBe('2 hosts with uncommitted changes (~/src/x) — pinnacles 16, zion 1');
    expect(w[0].remediation).toBeUndefined();
  });

  it('groups several missing checkouts into one critical warning', () => {
    const w = workspaceWarnings([
      { host: 'win-mini', path: '~/src/x', present: false },
      { host: 'winbox', path: '~/src/x', present: false },
    ]);
    expect(w).toHaveLength(1);
    expect(w[0].severity).toBe('critical');
    expect(stripAnsi(w[0].text)).toBe('2 hosts missing checkout (~/src/x) — win-mini, winbox');
  });

  it('keeps a lone behind/dirty/missing host as its full sentence (not a group of one)', () => {
    const behind = workspaceWarnings([
      { host: 'mac-mini', path: '~/src/x', present: true, behind: 172, upstream: 'origin/main' },
    ]);
    expect(stripAnsi(behind[0].text)).toBe('mac-mini is 172 commits behind origin/main (~/src/x)');
    const missing = workspaceWarnings([{ host: 'win-mini', path: '~/src/x', present: false }]);
    expect(stripAnsi(missing[0].text)).toBe('win-mini: checkout missing (~/src/x)');
  });

  it('groups per path so two different repos never merge into one count', () => {
    const w = workspaceWarnings([
      { host: 'a', path: '~/src/x', present: true, behind: 12, upstream: 'origin/main' },
      { host: 'b', path: '~/src/y', present: true, behind: 15, upstream: 'origin/main' },
    ]);
    expect(w).toHaveLength(2);
    expect(w.map((x) => stripAnsi(x.text)).sort()).toEqual([
      'a is 12 commits behind origin/main (~/src/x)',
      'b is 15 commits behind origin/main (~/src/y)',
    ]);
  });
});

describe('formatFleetSummary', () => {
  it('counts clean vs behind/dirty/missing and omits zero buckets', () => {
    const s = formatFleetSummary([
      { host: 'a', path: '~/x', present: true, behind: 0, dirty: 0, branch: 'main' },
      { host: 'b', path: '~/x', present: true, behind: 172, dirty: 0, branch: 'main' },
      { host: 'c', path: '~/x', present: true, behind: 0, dirty: 3, branch: 'main' },
      { host: 'd', path: '~/x', present: false },
    ]);
    expect(stripAnsi(s)).toBe('1/4 clean · 1 behind · 1 dirty · 1 missing');
  });

  it('counts a host that is both behind and dirty in both buckets', () => {
    const s = formatFleetSummary([
      { host: 'a', path: '~/x', present: true, behind: 5, dirty: 2, branch: 'main' },
    ]);
    expect(stripAnsi(s)).toBe('0/1 clean · 1 behind · 1 dirty');
  });

  it('counts ahead-only as clean', () => {
    const s = formatFleetSummary([
      { host: 'a', path: '~/x', present: true, ahead: 3, behind: 0, dirty: 0, branch: 'main' },
    ]);
    expect(stripAnsi(s)).toBe('1/1 clean');
  });
});
