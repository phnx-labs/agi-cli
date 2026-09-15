import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as yaml from 'yaml';
import { detrackViaGitExclude, formatKeptProjectResources, managedGitignoreEntries, syncProjectResourcesToAgent } from './project-resources.js';

const tempDirs: string[] = [];

function makeTempProject(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-cli-project-resources-'));
  tempDirs.push(dir);
  return path.join(dir, 'repo');
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('syncProjectResourcesToAgent', () => {
  it('syncs Cursor project commands to both native and generated-skill surfaces', () => {
    const project = makeTempProject();
    const projectAgentsDir = path.join(project, '.agents');
    const command = path.join(projectAgentsDir, 'commands', 'ping.md');
    fs.mkdirSync(path.dirname(command), { recursive: true });
    fs.writeFileSync(command, 'Ping from the project.', 'utf-8');

    const result = syncProjectResourcesToAgent('cursor', '2026.07.23-e383d2b', projectAgentsDir);

    expect(result.synced).toEqual(['commands/ping']);
    expect(fs.readFileSync(path.join(project, '.cursor', 'commands', 'ping.md'), 'utf-8')).toBe('Ping from the project.');
    expect(fs.readFileSync(path.join(project, '.cursor', 'skills', 'ping', 'SKILL.md'), 'utf-8')).toContain('agents_command: "ping"');
  });

  it('syncs project skills into native skill agents project config dirs', () => {
    const project = makeTempProject();
    const projectAgentsDir = path.join(project, '.agents');
    const skillDir = path.join(projectAgentsDir, 'skills', 'myskill');
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(path.join(skillDir, 'SKILL.md'), 'Project skill.', 'utf-8');

    const goose = syncProjectResourcesToAgent('goose', '1.25.0', projectAgentsDir);

    expect(goose.synced).toEqual(['skills/myskill']);
    expect(goose.skipped).toEqual([]);

    expect(fs.readFileSync(path.join(project, '.config', 'goose', 'skills', 'myskill', 'SKILL.md'), 'utf-8')).toBe('Project skill.');

    const gooseManifest = JSON.parse(fs.readFileSync(path.join(project, '.config', 'goose', '.agents-managed.json'), 'utf-8')) as { paths: string[] };
    expect(gooseManifest.paths).toEqual(['skills/myskill']);
  });

  it('cleans up a manifest written on Windows, with backslash-separated paths', () => {
    // .agents-managed.json travels with the version-controlled project dir, so
    // a manifest minted by a Windows build (or by a pre-fix version of this
    // code) can be read on POSIX. Its entries must still match, or the cleanup
    // pass silently leaves previously managed files behind.
    const project = makeTempProject();
    const projectAgentsDir = path.join(project, '.agents');
    fs.mkdirSync(projectAgentsDir, { recursive: true });

    // A file this manifest claims to manage, which is no longer backed by any
    // project resource — the next sync must remove it.
    const gooseRoot = path.join(project, '.config', 'goose');
    const stale = path.join(gooseRoot, 'skills', 'gone');
    fs.mkdirSync(stale, { recursive: true });
    fs.writeFileSync(path.join(stale, 'SKILL.md'), 'stale', 'utf-8');
    fs.writeFileSync(
      path.join(gooseRoot, '.agents-managed.json'),
      // Backslashes exactly as a Windows run would have persisted them.
      JSON.stringify({ v: 1, paths: ['skills\\gone'] }),
      'utf-8',
    );

    syncProjectResourcesToAgent('goose', '1.25.0', projectAgentsDir);

    expect(fs.existsSync(stale)).toBe(false);
  });

  it('tracks Goose workflow subrecipes in the manifest from the first sync', () => {
    const project = makeTempProject();
    const projectAgentsDir = path.join(project, '.agents');
    const workflowDir = path.join(projectAgentsDir, 'workflows', 'review-wf');
    const subagentsDir = path.join(workflowDir, 'subagents');
    fs.mkdirSync(subagentsDir, { recursive: true });
    fs.writeFileSync(
      path.join(workflowDir, 'WORKFLOW.md'),
      [
        '---',
        'name: Review workflow',
        'description: Review code',
        'model: claude-sonnet-4',
        'allowedAgents:',
        '  - reviewer',
        '---',
        'Coordinate the review.',
        '',
      ].join('\n'),
      'utf-8',
    );
    fs.writeFileSync(
      path.join(subagentsDir, 'reviewer.md'),
      '---\nname: reviewer\ndescription: Reviews code\n---\n\nInspect code changes.',
      'utf-8',
    );

    const first = syncProjectResourcesToAgent('goose', '1.0.0', projectAgentsDir);
    expect(first.synced).toContain('workflows/review-wf');
    expect(first.skipped).toEqual([]);

    const recipePath = path.join(project, '.config', 'goose', 'recipes', 'review-wf.yaml');
    const subrecipesPath = path.join(project, '.config', 'goose', 'recipes', 'review-wf.subrecipes');
    expect(fs.existsSync(recipePath)).toBe(true);
    expect(fs.existsSync(subrecipesPath)).toBe(true);

    const manifestPath = path.join(project, '.config', 'goose', '.agents-managed.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8')) as { paths: string[] };
    expect(manifest.paths).toContain('recipes/review-wf.yaml');
    expect(manifest.paths).toContain('recipes/review-wf.subrecipes');

    const second = syncProjectResourcesToAgent('goose', '1.0.0', projectAgentsDir);
    expect(second.synced).toContain('workflows/review-wf');
    expect(second.skipped).toEqual([]);
  });

  it('removes the Kimi subagent markdown when the last project subagent is removed', () => {
    const project = makeTempProject();
    const projectAgentsDir = path.join(project, '.agents');
    const subagentDir = path.join(projectAgentsDir, 'subagents', 'reviewer');
    fs.mkdirSync(subagentDir, { recursive: true });
    fs.writeFileSync(
      path.join(subagentDir, 'AGENT.md'),
      '---\nname: reviewer\ndescription: Reviews diffs\n---\n\nReview the diff.',
      'utf-8',
    );

    const first = syncProjectResourcesToAgent('kimi', '0.29.0', projectAgentsDir);

    const agentsDir = path.join(project, '.kimi-code', 'agents');
    expect(first.synced).toContain('subagents/reviewer');
    // One Claude-shaped markdown file; no yaml pair and no parent index.
    expect(fs.existsSync(path.join(agentsDir, 'reviewer.md'))).toBe(true);
    expect(fs.existsSync(path.join(agentsDir, 'reviewer.yaml'))).toBe(false);
    expect(fs.existsSync(path.join(agentsDir, '_agents-cli.yaml'))).toBe(false);

    fs.rmSync(subagentDir, { recursive: true, force: true });
    const second = syncProjectResourcesToAgent('kimi', '0.29.0', projectAgentsDir);

    expect(second.synced).toEqual([]);
    expect(fs.existsSync(path.join(agentsDir, 'reviewer.md'))).toBe(false);
    const manifest = JSON.parse(fs.readFileSync(path.join(project, '.kimi-code', '.agents-managed.json'), 'utf-8')) as { paths: string[] };
    expect(manifest.paths).toEqual([]);
  });

  it('reports files it left alone in the result, without printing one warning per file', () => {
    const project = makeTempProject();
    const projectAgentsDir = path.join(project, '.agents');
    for (const name of ['debug', 'product', 'prune']) {
      const command = path.join(projectAgentsDir, 'commands', `${name}.md`);
      fs.mkdirSync(path.dirname(command), { recursive: true });
      fs.writeFileSync(command, `Project ${name}.`, 'utf-8');
      const existing = path.join(project, '.claude', 'commands', `${name}.md`);
      fs.mkdirSync(path.dirname(existing), { recursive: true });
      fs.writeFileSync(existing, `Mine: ${name}.`, 'utf-8');
    }

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const result = syncProjectResourcesToAgent('claude', '2.1.143', projectAgentsDir);

      expect(result.skipped.sort()).toEqual([
        path.join('.claude', 'commands', 'debug.md'),
        path.join('.claude', 'commands', 'product.md'),
        path.join('.claude', 'commands', 'prune.md'),
      ]);
      expect(warn).not.toHaveBeenCalled();
      expect(log).not.toHaveBeenCalled();
      // The user's own files survive untouched.
      expect(fs.readFileSync(path.join(project, '.claude', 'commands', 'debug.md'), 'utf-8')).toBe('Mine: debug.');
    } finally {
      warn.mockRestore();
      log.mockRestore();
    }
  });
});

describe('formatKeptProjectResources', () => {
  it('says nothing when nothing was kept', () => {
    expect(formatKeptProjectResources([])).toBeNull();
  });

  it('names a lone file in full', () => {
    expect(formatKeptProjectResources(['.claude/commands/debug.md'])).toBe(
      'Kept your existing .claude/commands/debug.md',
    );
  });

  it('folds one directory into a single line with a preview', () => {
    const kept = ['debug', 'product', 'prune', 'video-k3z', 'doc-gaps', 'image-nbp']
      .map((n) => `.claude/commands/${n}.md`);
    expect(formatKeptProjectResources(kept)).toBe(
      'Kept 6 of your own files in .claude/commands: debug.md, doc-gaps.md, image-nbp.md, +3 more',
    );
  });

  it('counts per directory when several are involved', () => {
    expect(formatKeptProjectResources([
      '.claude/commands/debug.md',
      '.claude/commands/prune.md',
      '.claude/skills/rqa',
    ])).toBe('Kept 3 of your own files in .claude/commands (2), .claude/skills (1)');
  });

  it('normalizes Windows separators so the line reads the same on every platform', () => {
    expect(formatKeptProjectResources(['.claude\\commands\\debug.md', '.claude\\commands\\prune.md'])).toBe(
      'Kept 2 of your own files in .claude/commands: debug.md, prune.md',
    );
  });
});

describe('syncProjectResourcesToAgent — self-managed ignores in .git/info/exclude', () => {
  const CURSOR_BEGIN = '# >>> agents-cli project resources: cursor (generated on launch — do not edit) >>>';
  const CURSOR_END = '# <<< agents-cli project resources: cursor <<<';

  function initRepo(project: string): (...args: string[]) => string {
    fs.mkdirSync(project, { recursive: true });
    const git = (...args: string[]) => execFileSync('git', ['-C', project, ...args], { encoding: 'utf-8' });
    git('init', '-q');
    git('config', 'user.email', 'demo@x.co');
    git('config', 'user.name', 'demo');
    return git;
  }

  // Build a real git repo with one project command. Managed ignores now land in
  // `.git/info/exclude`, so the helper hands back that path — and the .git dir
  // must be a genuine repo (git rev-parse resolves the exclude path), not a
  // faked empty `.git` directory.
  function makeRepoWithCommand(): {
    project: string;
    projectAgentsDir: string;
    excludePath: string;
    gitignore: string;
    git: (...args: string[]) => string;
  } {
    const project = makeTempProject();
    const git = initRepo(project);
    const projectAgentsDir = path.join(project, '.agents');
    const command = path.join(projectAgentsDir, 'commands', 'ping.md');
    fs.mkdirSync(path.dirname(command), { recursive: true });
    fs.writeFileSync(command, 'Ping from the project.', 'utf-8');
    return {
      project,
      projectAgentsDir,
      git,
      excludePath: path.join(project, '.git', 'info', 'exclude'),
      gitignore: path.join(project, '.gitignore'),
    };
  }

  it('ignores the generated per-harness dir in .git/info/exclude, never the tracked .gitignore', () => {
    const { projectAgentsDir, excludePath, gitignore } = makeRepoWithCommand();
    syncProjectResourcesToAgent('cursor', '2026.07.23-e383d2b', projectAgentsDir);

    const excl = fs.readFileSync(excludePath, 'utf-8');
    expect(excl).toContain(CURSOR_BEGIN);
    expect(excl).toContain(CURSOR_END);
    // Every managed entry is anchored (/) and lives under the harness root.
    const entries = excl.split('\n').filter((l) => l.startsWith('/'));
    expect(entries.length).toBeGreaterThan(0);
    for (const e of entries) expect(e.startsWith('/.cursor/')).toBe(true);
    expect(excl).toContain('/.cursor/commands/ping.md');
    // The tracked .gitignore is never touched — that was the whole bug (PHNX-3718).
    expect(fs.existsSync(gitignore)).toBe(false);
  });

  it('does NOT write any ignore file outside a git repo', () => {
    const project = makeTempProject();
    const projectAgentsDir = path.join(project, '.agents');
    const command = path.join(projectAgentsDir, 'commands', 'ping.md');
    fs.mkdirSync(path.dirname(command), { recursive: true });
    fs.writeFileSync(command, 'Ping.', 'utf-8');

    syncProjectResourcesToAgent('cursor', '2026.07.23-e383d2b', projectAgentsDir);
    expect(fs.existsSync(path.join(project, '.gitignore'))).toBe(false);
    expect(fs.existsSync(path.join(project, '.git'))).toBe(false);
  });

  it('preserves git\'s default info/exclude content and any hand-written excludes', () => {
    const { projectAgentsDir, excludePath } = makeRepoWithCommand();
    // git init already wrote a default header into info/exclude; add a rule too.
    fs.appendFileSync(excludePath, 'scratch/\n');
    const before = fs.readFileSync(excludePath, 'utf-8');

    syncProjectResourcesToAgent('cursor', '2026.07.23-e383d2b', projectAgentsDir);
    const excl = fs.readFileSync(excludePath, 'utf-8');
    // Everything that was there survives, and the managed block is appended after it.
    expect(excl.startsWith(before.replace(/\n+$/, ''))).toBe(true);
    expect(excl).toContain('scratch/');
    expect(excl).toContain(CURSOR_BEGIN);
    expect(excl.indexOf('scratch/')).toBeLessThan(excl.indexOf(CURSOR_BEGIN));
  });

  it('is idempotent — a second sync leaves info/exclude byte-for-byte identical', () => {
    const { projectAgentsDir, excludePath } = makeRepoWithCommand();
    syncProjectResourcesToAgent('cursor', '2026.07.23-e383d2b', projectAgentsDir);
    const first = fs.readFileSync(excludePath, 'utf-8');
    syncProjectResourcesToAgent('cursor', '2026.07.23-e383d2b', projectAgentsDir);
    const second = fs.readFileSync(excludePath, 'utf-8');
    expect(second).toBe(first);
  });

  it('drops resource entries but keeps the manifest ignored when the source resources are gone', () => {
    const { projectAgentsDir, excludePath } = makeRepoWithCommand();
    syncProjectResourcesToAgent('cursor', '2026.07.23-e383d2b', projectAgentsDir);
    expect(fs.readFileSync(excludePath, 'utf-8')).toContain('/.cursor/commands/ping.md');

    // Remove the project command, then re-sync. The sync still leaves an
    // (emptied) .agents-managed.json in the harness dir, so the block must NOT
    // vanish — it shrinks to just the manifest entry, keeping the dir clean.
    fs.rmSync(path.join(projectAgentsDir, 'commands', 'ping.md'));
    syncProjectResourcesToAgent('cursor', '2026.07.23-e383d2b', projectAgentsDir);
    const excl = fs.readFileSync(excludePath, 'utf-8');
    expect(excl).not.toContain('/.cursor/commands/ping.md');
    expect(excl).toContain('/.cursor/.agents-managed.json');
  });

  it('managedGitignoreEntries drops any path that escapes the harness dir', () => {
    // grok writes commands back into the tracked .agents/ tree via a ../ subdir
    // (commandsSubdir = ../.agents/commands). Ignoring tracked source is exactly
    // the wrong move — the escape guard must drop those, keep in-root paths.
    const referenceRoot = path.join(os.tmpdir(), 'proj');
    const agentRoot = path.join(referenceRoot, '.grok');
    const entries = managedGitignoreEntries(agentRoot, referenceRoot, [
      'commands/ok.md',
      path.join('..', '.agents', 'commands', 'leak.md'),
      path.join('..', '..', 'outside.md'),
    ]);
    expect(entries).toContain('/.grok/commands/ok.md');
    expect(entries.every((e) => !e.includes('.agents/commands'))).toBe(true);
    expect(entries.every((e) => !e.includes('..'))).toBe(true);
    expect(entries).toHaveLength(1);
  });

  it('anchors entries at the WORKTREE root for a repo whose .agents lives in a subdir', () => {
    // A monorepo subdir carries its own .agents/ while .git is a level up. An
    // info/exclude pattern anchors at the worktree TOP, so the entry must be
    // /sub/.cursor/…, not /.cursor/… (which would anchor at the wrong dir).
    const repo = makeTempProject();
    initRepo(repo);
    const sub = path.join(repo, 'sub');
    const projectAgentsDir = path.join(sub, '.agents');
    const command = path.join(projectAgentsDir, 'commands', 'ping.md');
    fs.mkdirSync(path.dirname(command), { recursive: true });
    fs.writeFileSync(command, 'Ping.', 'utf-8');

    syncProjectResourcesToAgent('cursor', '2026.07.23-e383d2b', projectAgentsDir);
    const excl = fs.readFileSync(path.join(repo, '.git', 'info', 'exclude'), 'utf-8');
    expect(excl).toContain('/sub/.cursor/commands/ping.md');
    expect(excl).toContain('/sub/.cursor/.agents-managed.json');
  });

  it('re-syncing one harness does not reorder another harness block (no churn)', () => {
    // The blocker regression: strip-then-append moved the re-synced agent's
    // block to the end, bumping the other agent every launch. In-place
    // replacement must leave a multi-harness info/exclude byte-stable.
    const project = makeTempProject();
    initRepo(project);
    const projectAgentsDir = path.join(project, '.agents');
    const command = path.join(projectAgentsDir, 'commands', 'ping.md');
    fs.mkdirSync(path.dirname(command), { recursive: true });
    fs.writeFileSync(command, 'Ping.', 'utf-8');
    const skillDir = path.join(projectAgentsDir, 'skills', 'myskill');
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(path.join(skillDir, 'SKILL.md'), 'Project skill.', 'utf-8');
    const excludePath = path.join(project, '.git', 'info', 'exclude');

    syncProjectResourcesToAgent('cursor', '2026.07.23-e383d2b', projectAgentsDir);
    syncProjectResourcesToAgent('opencode', '1.0.0', projectAgentsDir);
    const afterBoth = fs.readFileSync(excludePath, 'utf-8');
    expect(afterBoth).toContain('agents-cli project resources: cursor');
    expect(afterBoth).toContain('agents-cli project resources: opencode');

    // Re-sync the first harness: the file must not change at all.
    syncProjectResourcesToAgent('cursor', '2026.07.23-e383d2b', projectAgentsDir);
    expect(fs.readFileSync(excludePath, 'utf-8')).toBe(afterBoth);
    // And re-syncing the second is also a no-op.
    syncProjectResourcesToAgent('opencode', '1.0.0', projectAgentsDir);
    expect(fs.readFileSync(excludePath, 'utf-8')).toBe(afterBoth);
  });

  it('never truncates info/exclude when the managed block has an orphaned begin marker', () => {
    const { projectAgentsDir, excludePath } = makeRepoWithCommand();
    // A begin marker with NO matching end (hand-truncated / botched merge),
    // with a legitimate hand-written rule below it.
    const orphaned = `node_modules/\n${CURSOR_BEGIN}\n/.cursor/commands/ping.md\ndist/\n`;
    fs.writeFileSync(excludePath, orphaned, 'utf-8');

    syncProjectResourcesToAgent('cursor', '2026.07.23-e383d2b', projectAgentsDir);
    const excl = fs.readFileSync(excludePath, 'utf-8');
    // The hand-written rule below the orphaned marker must survive untouched.
    expect(excl).toContain('dist/');
    expect(excl).toContain('node_modules/');
  });

  it('ignores the .agents-managed.json manifest too, not just the synced resources', () => {
    const { projectAgentsDir, excludePath } = makeRepoWithCommand();
    syncProjectResourcesToAgent('cursor', '2026.07.23-e383d2b', projectAgentsDir);
    // The manifest file the sync writes into the harness dir must be ignored —
    // otherwise the dir still shows as untracked on the strength of that one file.
    expect(fs.readFileSync(excludePath, 'utf-8')).toContain('/.cursor/.agents-managed.json');
  });

  it('leaves the whole generated harness dir clean in a REAL git status, tree untouched', () => {
    // The actual goal: git reports NOTHING new — not the .cursor/ dir, and not
    // a .gitignore (the PHNX-3718 regression). info/exclude lives inside .git,
    // so it never shows in status.
    const project = makeTempProject();
    const git = initRepo(project);
    const projectAgentsDir = path.join(project, '.agents');
    const command = path.join(projectAgentsDir, 'commands', 'ping.md');
    fs.mkdirSync(path.dirname(command), { recursive: true });
    fs.writeFileSync(command, 'Ping.', 'utf-8');
    const skillDir = path.join(projectAgentsDir, 'skills', 'demoskill');
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(path.join(skillDir, 'SKILL.md'), '---\nname: demoskill\n---\n', 'utf-8');
    git('add', '.agents');
    git('commit', '-qm', 'project source');

    syncProjectResourcesToAgent('cursor', '2026.07.23-e383d2b', projectAgentsDir);

    // A completely clean tree: no .cursor/, no .gitignore, nothing.
    expect(git('status', '--porcelain').trim()).toBe('');

    // Manifest-only state: remove every source resource and resync. Still clean.
    fs.rmSync(path.join(projectAgentsDir, 'commands', 'ping.md'));
    fs.rmSync(skillDir, { recursive: true });
    syncProjectResourcesToAgent('cursor', '2026.07.23-e383d2b', projectAgentsDir);
    // (The committed .agents lost two files, so status shows those deletions —
    //  but nothing generated leaks in.)
    const after = git('status', '--porcelain').split('\n').filter(Boolean);
    expect(after.some((l) => l.includes('.cursor'))).toBe(false);
    expect(after.some((l) => l.includes('.gitignore'))).toBe(false);
  });

  describe('migration off the legacy tracked-.gitignore location (PHNX-3718)', () => {
    it('strips this agent\'s leftover block from a tracked .gitignore and moves it to info/exclude', () => {
      const { project, projectAgentsDir, gitignore, excludePath, git } = makeRepoWithCommand();
      // Commit real hand-written rules, then simulate the OLD behavior: append
      // our managed block, dirtying the committed file (the bug that blocked git pull).
      fs.writeFileSync(gitignore, 'node_modules/\n.env\n', 'utf-8');
      git('add', '.gitignore');
      git('commit', '-qm', 'gitignore');
      fs.appendFileSync(
        gitignore,
        `\n${CURSOR_BEGIN}\n/.cursor/commands/ping.md\n/.cursor/.agents-managed.json\n${CURSOR_END}\n`,
      );
      expect(git('status', '--porcelain')).toContain('.gitignore');

      syncProjectResourcesToAgent('cursor', '2026.07.23-e383d2b', projectAgentsDir);

      // The tracked file is back to exactly its committed content — clean tree.
      expect(fs.readFileSync(gitignore, 'utf-8')).toBe('node_modules/\n.env\n');
      expect(git('status', '--porcelain').split('\n').filter(Boolean).some((l) => l.includes('.gitignore'))).toBe(false);
      // The block now lives in info/exclude instead.
      expect(fs.readFileSync(excludePath, 'utf-8')).toContain('/.cursor/commands/ping.md');
      // Unused variable guard.
      expect(project).toBeTruthy();
    });

    it('removes an untracked .gitignore that held only the old managed block', () => {
      const { projectAgentsDir, gitignore } = makeRepoWithCommand();
      // The old code, in a repo with no prior .gitignore, wrote a file whose
      // only content was our block. Migration must delete it, not leave an
      // empty `?? .gitignore`.
      fs.writeFileSync(gitignore, `${CURSOR_BEGIN}\n/.cursor/commands/ping.md\n${CURSOR_END}\n`, 'utf-8');
      syncProjectResourcesToAgent('cursor', '2026.07.23-e383d2b', projectAgentsDir);
      expect(fs.existsSync(gitignore)).toBe(false);
    });

    it('leaves a foreign .gitignore untouched (only strips our own fenced block)', () => {
      const { projectAgentsDir, gitignore } = makeRepoWithCommand();
      fs.writeFileSync(gitignore, 'dist/\ncoverage/\n', 'utf-8');
      syncProjectResourcesToAgent('cursor', '2026.07.23-e383d2b', projectAgentsDir);
      // No block of ours was there, so the file is left exactly as written.
      expect(fs.readFileSync(gitignore, 'utf-8')).toBe('dist/\ncoverage/\n');
    });
  });
});

// ── detrackViaGitExclude — Stage 0 de-track of the duplicated CHANGELOG (PHNX-3968) ──
describe('detrackViaGitExclude', () => {
  function initRepo(): { dir: string; git: (...a: string[]) => string; excludePath: string } {
    const dir = makeTempProject();
    fs.mkdirSync(dir, { recursive: true });
    const git = (...a: string[]) => execFileSync('git', ['-C', dir, ...a], { encoding: 'utf-8' });
    git('init', '-q');
    git('config', 'user.email', 'demo@x.co');
    git('config', 'user.name', 'demo');
    git('config', 'commit.gpgsign', 'false');
    return { dir, git, excludePath: path.join(dir, '.git', 'info', 'exclude') };
  }

  it('untracks a tracked file (keeping it on disk) and ignores it via info/exclude, not .gitignore', () => {
    const { dir, git, excludePath } = initRepo();
    fs.writeFileSync(path.join(dir, 'CHANGELOG.md'), '# changelog\n');
    git('add', 'CHANGELOG.md');
    git('commit', '-q', '-m', 'add changelog');

    const untracked = detrackViaGitExclude(dir, 'CHANGELOG.md');

    expect(untracked).toBe(true);
    // No longer tracked...
    expect(() => git('ls-files', '--error-unmatch', '--', 'CHANGELOG.md')).toThrow();
    // ...but the working file is kept.
    expect(fs.existsSync(path.join(dir, 'CHANGELOG.md'))).toBe(true);
    // Ignored via info/exclude (anchored), never a tracked .gitignore.
    expect(fs.readFileSync(excludePath, 'utf-8')).toContain('/CHANGELOG.md');
    expect(fs.existsSync(path.join(dir, '.gitignore'))).toBe(false);
    // And the working tree is clean at rest — the whole point.
    expect(git('status', '--porcelain').trim()).toBe('');
  });

  it('is idempotent: a second call is a no-op and never re-dirties the tree', () => {
    const { dir, git, excludePath } = initRepo();
    fs.writeFileSync(path.join(dir, 'CHANGELOG.md'), '# changelog\n');
    git('add', 'CHANGELOG.md');
    git('commit', '-q', '-m', 'add changelog');

    detrackViaGitExclude(dir, 'CHANGELOG.md');
    const firstExclude = fs.readFileSync(excludePath, 'utf-8');
    const secondUntracked = detrackViaGitExclude(dir, 'CHANGELOG.md');

    expect(secondUntracked).toBe(false); // already untracked
    expect(fs.readFileSync(excludePath, 'utf-8')).toBe(firstExclude); // exclude unchanged
    expect(git('status', '--porcelain').trim()).toBe('');
  });

  it('fails open outside a git repo', () => {
    const dir = makeTempProject();
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'CHANGELOG.md'), '# changelog\n');
    expect(detrackViaGitExclude(dir, 'CHANGELOG.md')).toBe(false);
  });
});
