import { afterEach, beforeEach, describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { Command } from 'commander';
import simpleGit from 'simple-git';
import {
  computeProjectListWidths,
  formatFleetSkippedNote,
  formatFleetUnverifiedNote,
  formatMilestoneDue,
  formatMilestoneLines,
  formatNextMilestone,
  projectRepoFromDir,
  registerProjectsCommands,
  detectProjectForPath,
  looksLikePath,
  type ProjectListRow,
} from './projects.js';
import {
  fingerprintTargets,
  parseProjectPullEnvelope,
  pullLocalArgs,
} from '../lib/project-pull.js';
import { machineId } from '../lib/machine-id.js';
import type { ProjectDef, ProjectRepoTarget } from '../lib/projects.js';

const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '');

describe('formatFleetSkippedNote', () => {
  it('says nothing when every peer answered', () => {
    expect(formatFleetSkippedNote([])).toBe('');
  });

  it('names up to four peers, collapsing the rest to +N, with honest reasons', () => {
    expect(stripAnsi(formatFleetSkippedNote(['gpu-box'])))
      .toBe("  · 1 device didn't answer (unreachable, older agents-cli, or timed out): gpu-box\n");
    expect(stripAnsi(formatFleetSkippedNote(['a', 'b', 'c', 'd', 'e', 'f'])))
      .toBe("  · 6 devices didn't answer (unreachable, older agents-cli, or timed out): a, b, c, d +2\n");
  });
});

describe('looksLikePath', () => {
  it('treats ., .., a ~-prefixed value, and any /-containing token as a directory', () => {
    for (const t of ['.', '..', '~', '~/src/foo', 'a/b', '/abs/path', './rel', '../up']) {
      expect(looksLikePath(t)).toBe(true);
    }
  });

  it('treats a bare token (a project name, dots and dashes included) as NOT a path', () => {
    for (const t of ['agents-cli', 'prix', 'foo.bar', 'my_project', 'a-b-c']) {
      expect(looksLikePath(t)).toBe(false);
    }
  });
});

describe('detectProjectForPath', () => {
  const defs: ProjectDef[] = [
    {
      name: 'prix',
      root: '/work/monorepo',
      defaultPath: '/work/monorepo/prix',
      linear: { name: 'Prix', projectId: 'lin_prix_123', url: 'https://linear.app/x/project/prix' },
    },
    { name: 'umbrella', root: '/work/monorepo' },
    { name: 'nolinear', root: '/work/other' },
  ];

  it('returns name + Linear binding + root in ONE call for a cwd inside a project', () => {
    const d = detectProjectForPath('/work/monorepo/prix/api', defs);
    expect(d.name).toBe('prix');
    expect(d.linear).toEqual({ name: 'Prix', projectId: 'lin_prix_123' });
    expect(d.root).toBe('/work/monorepo');
  });

  it('emits null Linear fields when the matched project has no Linear binding', () => {
    const d = detectProjectForPath('/work/other/sub', defs);
    expect(d.name).toBe('nolinear');
    expect(d.linear).toEqual({ name: null, projectId: null });
    expect(d.root).toBe('/work/other');
  });

  it('fail-open: an all-null shape when nothing contains the path (never throws)', () => {
    expect(detectProjectForPath('/somewhere/unclaimed', defs)).toEqual({
      name: null,
      linear: { name: null, projectId: null },
      root: null,
    });
  });
});

describe('projects view <path> — CLI dispatch disambiguation', () => {
  let projectsDir: string;
  let projectRoot: string;
  let priorEnv: string | undefined;

  async function runView(args: string[]): Promise<string> {
    const program = new Command();
    program.exitOverride();
    registerProjectsCommands(program);
    const lines: string[] = [];
    const realLog = console.log;
    console.log = (...a: unknown[]) => { lines.push(a.join(' ')); };
    try {
      await program.parseAsync(['projects', ...args], { from: 'user' });
    } finally {
      console.log = realLog;
    }
    return lines.join('\n');
  }

  beforeEach(() => {
    projectsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'projects-defs-'));
    projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'proj-root-'));
    priorEnv = process.env.AGENTS_PROJECTS_DIR;
    process.env.AGENTS_PROJECTS_DIR = projectsDir;
    fs.writeFileSync(
      path.join(projectsDir, 'prix.yaml'),
      `name: prix\nroot: ${projectRoot}\nlinear:\n  projectId: lin_prix_9\n  name: Prix\n`,
    );
  });

  afterEach(() => {
    if (priorEnv === undefined) delete process.env.AGENTS_PROJECTS_DIR;
    else process.env.AGENTS_PROJECTS_DIR = priorEnv;
    fs.rmSync(projectsDir, { recursive: true, force: true });
    fs.rmSync(projectRoot, { recursive: true, force: true });
  });

  it('a /-containing positional path auto-detects the project — one JSON call yields name + linear + root', async () => {
    const out = await runView(['status', path.join(projectRoot, 'api'), '--json']);
    expect(JSON.parse(out)).toEqual({
      name: 'prix',
      linear: { name: 'Prix', projectId: 'lin_prix_9' },
      root: projectRoot,
    });
  });

  it('--path <dir> overrides a bare positional token and detects that directory', async () => {
    const out = await runView(['status', 'somename', '--path', path.join(projectRoot, 'sub'), '--json']);
    expect(JSON.parse(out).name).toBe('prix');
  });

  it('a bare --path (no value) auto-detects the cwd', async () => {
    const cwd = process.cwd();
    process.chdir(projectRoot);
    try {
      const out = await runView(['status', '--path', '--json']);
      expect(JSON.parse(out).name).toBe('prix');
    } finally {
      process.chdir(cwd);
    }
  });

  it('a path that no def contains prints the all-null fail-open shape to stdout (JSON branch returns, never falls through)', async () => {
    const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), 'unclaimed-'));
    try {
      const out = await runView(['status', elsewhere, '--json']);
      expect(JSON.parse(out)).toEqual({
        name: null,
        linear: { name: null, projectId: null },
        root: null,
      });
    } finally {
      fs.rmSync(elsewhere, { recursive: true, force: true });
    }
  });
});

describe('computeProjectListWidths', () => {
  const render = (r: ProjectListRow, w: { name: number; path: number; repo: number }) =>
    `  ${r.name.padEnd(w.name)} ${r.path.padEnd(w.path)} ${r.repo.padEnd(w.repo)} 0 agents`;

  it('sizes every column to the widest row instead of a fixed 32', () => {
    const rows: ProjectListRow[] = [
      { name: 'agents', path: '~/src/github.com/muqsitnawaz/agents', repo: 'muqsitnawaz/agents' },
      { name: 'agents-cli', path: '~/src/github.com/muqsitnawaz/agents-cli', repo: 'muqsitnawaz/agents-cli' },
    ];
    const w = computeProjectListWidths(rows);
    expect(w).toEqual({ name: 10, path: 39, repo: 22 });
    const offsets = rows.map((r) => render(r, w).indexOf(r.repo));
    expect(new Set(offsets).size).toBe(1);
  });

  it('caps the path column so one long root cannot widen the whole table', () => {
    const w = computeProjectListWidths([
      { name: 'a', path: '~/' + 'x'.repeat(120), repo: 'o/r' },
      { name: 'b', path: '~/short', repo: 'o/r2' },
    ]);
    expect(w.path).toBe(48);
  });

  it('collapses to zero-width columns when there is nothing to show', () => {
    expect(computeProjectListWidths([])).toEqual({ name: 0, path: 0, repo: 0 });
    expect(computeProjectListWidths([{ name: 'a', path: '', repo: '' }])).toEqual({ name: 1, path: 0, repo: 0 });
  });
});

describe('formatMilestoneDue', () => {
  const now = new Date(2026, 7, 3, 12, 0, 0).getTime();

  it('speaks in days a person would use', () => {
    expect(formatMilestoneDue('2026-08-03', now)).toBe('due today');
    expect(formatMilestoneDue('2026-08-04', now)).toBe('due tomorrow');
    expect(formatMilestoneDue('2026-08-09', now)).toBe('due in 6 days');
    expect(formatMilestoneDue('2026-08-02', now)).toBe('overdue by a day');
    expect(formatMilestoneDue('2026-07-27', now)).toBe('overdue by 7 days');
  });

  it('switches to a calendar date once the countdown stops being useful', () => {
    expect(formatMilestoneDue('2026-08-21', now)).toBe('due Aug 21');
    expect(formatMilestoneDue('2027-01-15', now)).toBe('due Jan 15, 2027');
  });

  it('reads the date at LOCAL midnight, not UTC', () => {
    expect(formatMilestoneDue('2026-08-03', new Date(2026, 7, 3, 23, 59).getTime())).toBe('due today');
    expect(formatMilestoneDue('2026-08-03', new Date(2026, 7, 3, 0, 1).getTime())).toBe('due today');
  });

  it('returns nothing for a value that is not a calendar date', () => {
    expect(formatMilestoneDue('', now)).toBeUndefined();
    expect(formatMilestoneDue('someday', now)).toBeUndefined();
    expect(formatMilestoneDue('2026-08-03T00:00:00Z', now)).toBeUndefined();
  });
});

describe('formatNextMilestone', () => {
  const now = new Date(2026, 7, 3, 12, 0, 0).getTime();

  it('reads name, progress, then when it is due', () => {
    expect(stripAnsi(formatNextMilestone({ name: 'Beta cut', targetDate: '2026-08-09', done: 3, total: 8 }, now)))
      .toBe('Beta cut  ·  3/8  ·  due in 6 days');
  });

  it('omits the date entirely when the milestone has none', () => {
    expect(stripAnsi(formatNextMilestone({ name: 'Someday', done: 0, total: 4 }, now)))
      .toBe('Someday  ·  0/4');
  });

  it('omits the fraction when nothing is filed under the milestone yet', () => {
    expect(stripAnsi(formatNextMilestone({ name: 'Factory onboarding', targetDate: '2026-09-15', done: 0, total: 0 }, now)))
      .toBe('Factory onboarding  ·  due Sep 15');
  });

  it('does not print a raw date when the stored value is unparseable', () => {
    expect(stripAnsi(formatNextMilestone({ name: 'Odd', targetDate: 'not-a-date', done: 1, total: 2 }, now)))
      .toBe('Odd  ·  1/2');
  });
});

describe('formatMilestoneLines', () => {
  const now = new Date(2026, 7, 3, 12, 0, 0).getTime();
  const ms = [
    { name: 'Factory converts strategy', targetDate: '2026-09-15', done: 0, total: 0 },
    { name: 'Factory reliability', targetDate: '2026-09-30', done: 0, total: 0 },
    { name: 'Factory onboarding', targetDate: '2026-10-15', done: 0, total: 0 },
  ];

  it('shows one line plus a pointer on the compact card', () => {
    const out = formatMilestoneLines(ms, ms[0], now, 1).map(stripAnsi);
    expect(out).toHaveLength(2);
    expect(out[0]).toContain('next');
    expect(out[0]).toContain('Factory converts strategy');
    expect(out[1]).toContain('+2 more milestones');
    expect(out[1]).toContain('agents projects view');
  });

  it('shows every milestone when the limit allows, with no pointer', () => {
    const out = formatMilestoneLines(ms, ms[0], now, 99).map(stripAnsi);
    expect(out).toHaveLength(3);
    expect(out.join('\n')).toContain('Factory onboarding');
    expect(out.join('\n')).not.toContain('more milestone');
  });

  it('labels the first row `plan` when there is no next at all', () => {
    const out = formatMilestoneLines(ms, undefined, now, 1).map(stripAnsi);
    expect(out[0].trimStart().startsWith('plan')).toBe(true);
  });

  it('leads with the NEXT milestone even when a different one is dated earlier', () => {
    const out = formatMilestoneLines(ms, ms[2], now, 1).map(stripAnsi);
    expect(out[0]).toContain('next');
    expect(out[0]).toContain('Factory onboarding');
    expect(out[1]).toContain('+2 more');
  });

  it('does not repeat the next milestone further down the full list', () => {
    const out = formatMilestoneLines(ms, ms[2], now, 99).map(stripAnsi);
    expect(out).toHaveLength(3);
    expect(out.filter((l) => l.includes('Factory onboarding'))).toHaveLength(1);
    expect(out[0]).toContain('Factory onboarding');
  });

  it('labels the right row when two milestones share a name', () => {
    const dup = [
      { name: 'Cut', targetDate: '2026-09-01', done: 0, total: 0 },
      { name: 'Cut', targetDate: '2026-10-01', done: 0, total: 0 },
    ];
    const out = formatMilestoneLines(dup, dup[1], now, 99).map(stripAnsi);
    expect(out[0]).toContain('next');
    expect(out[0]).toContain('Oct 1');
    expect(out[1]).not.toContain('next');
  });

  it('renders nothing when the project declares no milestones', () => {
    expect(formatMilestoneLines([], undefined, now, 1)).toEqual([]);
  });

  it('still renders a next carried alone by an older cached answer', () => {
    const out = formatMilestoneLines([], ms[0], now, 1).map(stripAnsi);
    expect(out).toHaveLength(1);
    expect(out[0]).toContain('Factory converts strategy');
  });
});

describe('projectRepoFromDir', () => {
  let tmp: string;

  const git = (cwd: string, args: string[]) =>
    execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });

  const repoAt = (name: string, origin?: string): string => {
    const p = path.join(tmp, name);
    fs.mkdirSync(p, { recursive: true });
    git(p, ['init', '-b', 'main']);
    if (origin) git(p, ['remote', 'add', 'origin', origin]);
    return p;
  };

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'projrepo-test-'));
  });
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('reads the slug from the directory OWN origin, not from its path', () => {
    const dir = repoAt(path.join('muqsitnawaz', 'agents-cli'), 'git@github.com:phnx-labs/agents-cli.git');
    const r = projectRepoFromDir(dir);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.repo.slug).toBe('phnx-labs/agents-cli');
  });

  it('refuses a directory with no origin, and names the flag that fixes it', () => {
    const dir = repoAt('no-origin');
    const r = projectRepoFromDir(dir);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toMatch(/no origin remote/);
      expect(r.error).toMatch(/--slug <owner\/repo>/);
    }
  });

  it('accepts an explicit slug override for a directory with no origin', () => {
    const dir = repoAt('vendored');
    const r = projectRepoFromDir(dir, 'phnx-labs/thing');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.repo.slug).toBe('phnx-labs/thing');
  });

  it('refuses a path that does not exist, and one that is a file', () => {
    const missing = projectRepoFromDir(path.join(tmp, 'nope'));
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.error).toMatch(/No such directory/);

    const file = path.join(tmp, 'a-file');
    fs.writeFileSync(file, 'x');
    const notDir = projectRepoFromDir(file);
    expect(notDir.ok).toBe(false);
    if (!notDir.ok) expect(notDir.error).toMatch(/Not a directory/);
  });

  it('stores the path home-relative when the directory lives under $HOME', () => {
    const home = process.env.HOME ?? os.homedir();
    const under = path.join(home, `.projrepo-test-${process.pid}`);
    fs.mkdirSync(under, { recursive: true });
    try {
      git(under, ['init', '-b', 'main']);
      git(under, ['remote', 'add', 'origin', 'git@github.com:o/r.git']);
      const r = projectRepoFromDir(under);
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.repo.path?.startsWith('~/')).toBe(true);
    } finally {
      fs.rmSync(under, { recursive: true, force: true });
    }
  });
});


describe('formatFleetUnverifiedNote', () => {
  it('says nothing when every answer verified', () => {
    expect(formatFleetUnverifiedNote([])).toBe('');
  });

  it('names the peers whose answer could not be trusted, distinctly from silence', () => {
    expect(stripAnsi(formatFleetUnverifiedNote(['gpu-box'])))
      .toBe('  · 1 device answered with a result that could not be verified: gpu-box\n');
    expect(stripAnsi(formatFleetUnverifiedNote(['a', 'b', 'c', 'd', 'e'])))
      .toBe('  · 5 devices answered with a result that could not be verified: a, b, c, d +1\n');
  });
});


describe('projects pull-local — CLI-arg round trip from pull', () => {
  let root: string;
  let remote: string;
  let author: string;
  let plain: string;
  let mismatched: string;

  async function configIdentity(dir: string): Promise<void> {
    const g = simpleGit(dir);
    await g.addConfig('user.email', 'test@example.com');
    await g.addConfig('user.name', 'Test');
    await g.addConfig('commit.gpgsign', 'false');
  }

  async function runPullLocal(args: string[]): Promise<string> {
    const program = new Command();
    program.exitOverride();
    registerProjectsCommands(program);
    const lines: string[] = [];
    const realLog = console.log;
    console.log = (...a: unknown[]) => { lines.push(a.join(' ')); };
    try {
      await program.parseAsync(args, { from: 'user' });
    } finally {
      console.log = realLog;
    }
    return lines.join('\n');
  }

  beforeEach(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'projects-pull-cli-'));
    remote = path.join(root, 'remote.git');
    author = path.join(root, 'author');
    plain = path.join(root, 'plain');
    mismatched = path.join(root, 'mismatched');

    await simpleGit().raw(['init', '--bare', '-b', 'main', remote]);
    await simpleGit().clone(remote, author);
    await configIdentity(author);
    fs.writeFileSync(path.join(author, 'README.md'), 'v1\n');
    await simpleGit(author).add('-A');
    await simpleGit(author).commit('init');
    await simpleGit(author).push('origin', 'main');

    await simpleGit().clone(remote, plain);
    await configIdentity(plain);
    await simpleGit().clone(remote, mismatched);
    await configIdentity(mismatched);
    await simpleGit(mismatched).raw(['remote', 'set-url', 'origin', 'https://github.com/org/other.git']);
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('carries expectedSlug across the boundary, so the peer verifies slugs AND its fingerprint matches', async () => {
    const targets: ProjectRepoTarget[] = [
      { path: plain },
      { path: mismatched, expectedSlug: 'org/a' },
    ];
    const expectedFingerprint = fingerprintTargets(targets);
    const stdout = await runPullLocal(pullLocalArgs(targets));

    const parsed = parseProjectPullEnvelope(stdout, machineId(), { expectedFingerprint });

    expect(parsed.valid).toBe(true);
    expect(parsed.items).toHaveLength(2);

    const blocked = parsed.items.find((r) => r.path === mismatched);
    expect(blocked?.status).toBe('blocked');
    expect(blocked?.message).toMatch(/Slug mismatch: expected org\/a, found org\/other/);
    expect(blocked?.expectedSlug).toBe('org/a');

    expect(parsed.items.find((r) => r.path === plain)?.status).toBe('current');
  });

  it('rejects a peer answer whose fingerprint does not match the targets that were sent', async () => {
    const sent: ProjectRepoTarget[] = [{ path: plain, expectedSlug: 'org/a' }];
    const stdout = await runPullLocal(pullLocalArgs([{ path: plain }]));

    expect(parseProjectPullEnvelope(stdout, machineId(), {
      expectedFingerprint: fingerprintTargets(sent),
    })).toEqual({ items: [], valid: false });
  });
});

describe('projects prs — list is the default, merge owns its flags', () => {
  let projectsDir: string;
  let priorEnv: string | undefined;

  async function run(args: string[]): Promise<{ out: string; err: string; exit?: number }> {
    const program = new Command();
    program.exitOverride();
    registerProjectsCommands(program);
    const out: string[] = [];
    const err: string[] = [];
    const realLog = console.log;
    const realError = console.error;
    const realExit = process.exit;
    console.log = (...a: unknown[]) => { out.push(a.join(' ')); };
    console.error = (...a: unknown[]) => { err.push(a.join(' ')); };
    let exit: number | undefined;
    process.exit = ((code?: number) => { exit = code; throw new Error(`exit ${code}`); }) as typeof process.exit;
    try {
      await program.parseAsync(['projects', ...args], { from: 'user' });
    } catch (e) {
      if (exit === undefined) throw e;
    } finally {
      console.log = realLog;
      console.error = realError;
      process.exit = realExit;
    }
    return { out: out.join('\n'), err: stripAnsi(err.join('\n')), exit };
  }

  beforeEach(() => {
    projectsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'projects-prs-'));
    priorEnv = process.env.AGENTS_PROJECTS_DIR;
    process.env.AGENTS_PROJECTS_DIR = projectsDir;
    fs.writeFileSync(path.join(projectsDir, 'merge.yaml'), 'name: merge\n');
  });

  afterEach(() => {
    if (priorEnv === undefined) delete process.env.AGENTS_PROJECTS_DIR;
    else process.env.AGENTS_PROJECTS_DIR = priorEnv;
    fs.rmSync(projectsDir, { recursive: true, force: true });
  });

  it('`prs <name> --json` lists, and a project named merge is reachable as `prs list merge`', async () => {
    const listed = await run(['prs', 'list', 'merge', '--json']);
    expect(JSON.parse(listed.out)).toEqual({ project: { name: 'merge', linearProjectId: null }, viewer: null, repositories: [], partial: false });
    const implicit = await run(['prs', 'nosuch', '--json']);
    expect(implicit.exit).toBe(1);
    expect(implicit.err).toContain('No project named "nosuch"');
  });

  it('`prs merge` parses its own --repo/--number/--sha before touching GitHub', async () => {
    const bad = await run(['prs', 'merge', 'merge', '--repo', 'acme/mono', '--number', '7', '--sha', 'nothex', '--json']);
    expect(bad.exit).toBe(1);
    expect(bad.err).toContain('--sha expects a commit SHA, got "nothex"');
    const method = await run(['prs', 'merge', 'merge', '--repo', 'acme/mono', '--number', '7', '--sha', 'abc1234', '--method', 'fast']);
    expect(method.err).toContain('--method expects one of rebase, squash, merge');
  });

  it('`prs ready/review/comment` refuse bad flags before touching GitHub', async () => {
    const ready = await run(['prs', 'ready', 'merge', '--repo', 'acme/mono', '--number', '7junk']);
    expect(ready.exit).toBe(1);
    expect(ready.err).toContain('--number expects a positive integer, got "7junk"');

    const noApprove = await run(['prs', 'review', 'merge', '--repo', 'acme/mono', '--number', '7', '--sha', 'abc1234']);
    expect(noApprove.exit).toBe(1);
    expect(noApprove.err).toContain('Pass --approve');

    const both = await run(['prs', 'comment', 'merge', '--repo', 'acme/mono', '--number', '7', '--body', 'x', '--body-file', '-']);
    expect(both.err).toContain('Pass exactly one of --body <text> or --body-file <path|->');
    const neither = await run(['prs', 'comment', 'merge', '--repo', 'acme/mono', '--number', '7']);
    expect(neither.err).toContain('Pass exactly one of --body');

    const blank = path.join(projectsDir, 'blank.md');
    fs.writeFileSync(blank, '  \n\n');
    const empty = await run(['prs', 'comment', 'merge', '--repo', 'acme/mono', '--number', '7', '--body-file', blank]);
    expect(empty.exit).toBe(1);
    expect(empty.err).toContain('The comment is empty.');
    const missing = await run(['prs', 'comment', 'merge', '--repo', 'acme/mono', '--number', '7', '--body-file', path.join(projectsDir, 'nope.md')]);
    expect(missing.err).toContain('Could not read --body-file');
  });

  it('`prs automerge` needs --sha to turn on and refuses --method with --off, before touching GitHub', async () => {
    const noSha = await run(['prs', 'automerge', 'merge', '--repo', 'acme/mono', '--number', '7']);
    expect(noSha.exit).toBe(1);
    expect(noSha.err).toContain('Pass --sha <head-sha>');
    const offMethod = await run(['prs', 'automerge', 'merge', '--repo', 'acme/mono', '--number', '7', '--off', '--method', 'rebase']);
    expect(offMethod.exit).toBe(1);
    expect(offMethod.err).toContain('--method only applies when turning auto-merge on');
    const method = await run(['prs', 'automerge', 'merge', '--repo', 'acme/mono', '--number', '7', '--sha', 'abc1234', '--method', 'fast']);
    expect(method.err).toContain('--method expects one of rebase, squash, merge');
  });
});
