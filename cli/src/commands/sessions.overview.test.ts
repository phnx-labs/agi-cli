import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { overviewProjectKey, buildOverviewGroups } from './sessions.js';
import type { SessionMeta } from '@phnx-labs/sessions-cli/reader';

function s(id: string, project: string | undefined, timestamp: string, cwd?: string, lastActivity?: string): SessionMeta {
  return { id, shortId: id.slice(0, 8), agent: 'claude', timestamp, lastActivity, project, cwd, filePath: '' } as SessionMeta;
}

describe('overviewProjectKey', () => {
  it('resolves a monorepo subdir to its repo, not the stale indexed basename', () => {
    // The indexer stamps basename(cwd) at scan time; the overview must agree with
    // the activity timeline, which groups by the repository containing the cwd.
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'overview-key-'));
    try {
      const repo = path.join(tmp, 'agents');
      const sub = path.join(repo, 'apps', 'cli');
      fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
      fs.mkdirSync(sub, { recursive: true });
      expect(overviewProjectKey({ project: 'cli', cwd: sub })).toBe('agents');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('falls back to the indexed project name when the cwd is unusable', () => {
    expect(overviewProjectKey({ project: 'agents-cli', cwd: '' })).toBe('agents-cli');
    expect(overviewProjectKey({ project: 'agents-cli' })).toBe('agents-cli');
  });

  it('folds a worktree path back to its repo even when the path is not local', () => {
    // A synced session from another machine: the fs walk finds nothing, and the
    // pure worktree fold inside the shared resolver still applies.
    expect(overviewProjectKey({ project: undefined, cwd: '/home/me/src/swarmify/.agents/worktrees/floor-redesign' })).toBe('swarmify');
  });

  it('uses the leaf dir for a path inside no repo', () => {
    expect(overviewProjectKey({ project: undefined, cwd: '/definitely/not-inside-any/repo/path-xyz' })).toBe('path-xyz');
  });

  it('a defined project name wins over the repo key when defs are given', () => {
    // Same canonical resolver as the activity timeline: a multi-repo project's
    // sessions group under the project's name, not the repo's.
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'overview-canonical-'));
    try {
      const repo = path.join(tmp, 'agents');
      const sub = path.join(repo, 'apps', 'cli');
      fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
      fs.mkdirSync(sub, { recursive: true });
      expect(overviewProjectKey({ project: undefined, cwd: sub }, [{ name: 'agentic', root: repo }])).toBe('agentic');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('returns a sentinel for an empty cwd and no project', () => {
    expect(overviewProjectKey({ project: undefined, cwd: '' })).toBe('(no project)');
    expect(overviewProjectKey({ project: '  ', cwd: undefined })).toBe('(no project)');
  });
});

describe('buildOverviewGroups', () => {
  // Pool is recency-descending, as discoverSessions returns it.
  const pool: SessionMeta[] = [
    s('a1', 'agents-cli', '2026-07-04T10:00:05.000Z'),
    s('b1', 'swarmify', '2026-07-04T10:00:04.000Z'),
    s('a2', 'agents-cli', '2026-07-04T10:00:03.000Z'),
    s('c1', 'rush', '2026-07-04T10:00:02.000Z'),
    s('a3', 'agents-cli', '2026-07-04T10:00:01.000Z'),
  ];

  it('groups by project with accurate per-project totals (cap not exceeded)', () => {
    const { groups, projectCount } = buildOverviewGroups(pool, 5);
    expect(projectCount).toBe(3);
    const cli = groups.find((g) => g.key === 'agents-cli')!;
    expect(cli.total).toBe(3);
    expect(cli.shown.map((x) => x.id)).toEqual(['a1', 'a2', 'a3']);
    expect(cli.more).toBe(0);
  });

  it('orders groups by most-recent activity, NOT by count', () => {
    // 'newproj' has one very recent session; 'bigproj' has three older ones.
    const p: SessionMeta[] = [
      s('x', 'newproj', '2026-07-04T09:00:09.000Z'),
      s('g1', 'bigproj', '2026-07-04T09:00:08.000Z'),
      s('g2', 'bigproj', '2026-07-04T09:00:07.000Z'),
      s('g3', 'bigproj', '2026-07-04T09:00:06.000Z'),
    ];
    const { groups } = buildOverviewGroups(p, 4);
    expect(groups.map((g) => g.key)).toEqual(['newproj', 'bigproj']);
  });

  it('orders and labels by last activity, not creation time', () => {
    // 'revived' was CREATED long before 'fresh' but was ACTIVE most recently.
    // The pool arrives last-activity-descending (as the SQL now returns it), so
    // the revived project must lead and its maxTs must be the last-activity time.
    const p: SessionMeta[] = [
      s('r1', 'revived', '2026-06-01T09:00:00.000Z', undefined, '2026-07-04T12:00:00.000Z'),
      s('f1', 'fresh', '2026-07-04T08:00:00.000Z', undefined, '2026-07-04T08:05:00.000Z'),
    ];
    const { groups } = buildOverviewGroups(p, 5);
    expect(groups.map((g) => g.key)).toEqual(['revived', 'fresh']);
    expect(groups[0].maxTs).toBe('2026-07-04T12:00:00.000Z'); // last activity, NOT the June creation
  });

  it('caps rows per project and rolls the rest into "more"', () => {
    // cap 1 → each project shows only its most-recent row; every project still appears.
    const { groups } = buildOverviewGroups(pool, 1);
    expect(groups.map((g) => g.key)).toEqual(['agents-cli', 'swarmify', 'rush']); // recency order
    const cli = groups.find((g) => g.key === 'agents-cli')!;
    expect(cli.shown.map((x) => x.id)).toEqual(['a1']); // most-recent only
    expect(cli.total).toBe(3);
    expect(cli.more).toBe(2); // a2, a3 rolled into "more"
    const rush = groups.find((g) => g.key === 'rush')!;
    expect(rush.shown.map((x) => x.id)).toEqual(['c1']);
    expect(rush.more).toBe(0);
  });

  it('expands every row when the cap is Infinity', () => {
    const { groups } = buildOverviewGroups(pool, Infinity);
    const cli = groups.find((g) => g.key === 'agents-cli')!;
    expect(cli.shown).toHaveLength(3);
    expect(cli.more).toBe(0);
  });
});
