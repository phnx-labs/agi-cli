import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import {
  approveProjectPr,
  buildProjectPrs,
  ciFromRollupItems,
  isPassingRollup,
  PASSING_ROLLUP_TTL_MS,
  FAILING_ROLLUP_TTL_MS,
  isFinishedRollup,
  commentOnProjectPr,
  markProjectPrReady,
  mergeProjectPr,
  readableMergeRefusal,
  readRepoMergeAbility,
  rowToProjectPr,
  scopeForFiles,
  setProjectPrAutoMerge,
  BLOCKED_WITHOUT_ADMIN,
  OWN_PR_APPROVAL,
} from './project-prs.js';
import { repoPathClaims } from '../projects.js';
import type { ProjectDef } from '../projects.js';

describe('project PR projection', () => {
  it('decodes auto-merge from the REST row, null when off', () => {
    expect(rowToProjectPr({ number: 1, autoMerge: { enabledBy: 'octocat', method: 'rebase' } }).autoMerge)
      .toEqual({ enabledBy: 'octocat', method: 'rebase' });
    expect(rowToProjectPr({ number: 1, autoMerge: null }).autoMerge).toBeNull();
  });

  it('preserves draft, author, Markdown body and head identity from the REST projection', () => {
    const row = { number: 42, title: 'A change', url: 'https://github.com/example/repo/pull/42',
      isDraft: true, state: 'OPEN', updatedAt: '2026-09-13T00:00:00Z', login: 'octocat',
      avatarUrl: 'https://github.com/octocat.png', headRefName: 'feature', baseRefName: 'main',
      headSha: 'abc', body: '# Details\n\n- A change' };
    const result = rowToProjectPr(row);
    expect(result.author).toEqual({ login: row.login, avatarUrl: row.avatarUrl });
    expect(result.isDraft).toBe(true);
    expect(result.body).toBe(row.body);
    expect(result.headSha).toBe(row.headSha);
    expect(result.checks).toBeNull();
    expect(result.reviewDecision).toBeNull();
  });

  it('a project without linked repositories has an honest empty board without a network call', async () => {
    const project = { name: 'unlinked' } as ProjectDef;
    expect(await buildProjectPrs(project)).toEqual({
      project: { name: 'unlinked', linearProjectId: null }, viewer: null, repositories: [], partial: false,
    });
  });
});

type Routes = Record<string, string | Error | ((args: string[]) => string)>;

function recordedGh(routes: Routes) {
  const asked: string[] = [];
  const gh = async (args: string[]) => {
    const endpoint = args[0] === 'api' ? (args[1] === '-X' ? `${args[2]} ${args[3]}` : args[1]) : args.join(' ');
    asked.push(endpoint);
    const hit = routes[endpoint];
    if (hit === undefined) throw new Error(`unexpected gh ${args.join(' ')}`);
    if (hit instanceof Error) throw hit;
    return typeof hit === 'function' ? hit(args) : hit;
  };
  return { gh, asked };
}

const prLine = (number: number, sha: string) => JSON.stringify({
  number, title: `PR ${number}`, url: `https://github.com/acme/mono/pull/${number}`, isDraft: false,
  state: 'OPEN', createdAt: '2026-09-30T00:00:00Z', updatedAt: '2026-10-01T00:00:00Z', login: 'octocat',
  avatarUrl: '', headRefName: `b${number}`, baseRefName: 'main', headSha: sha, body: '', mergeable: null, mergeableState: null,
});

describe('monorepo scoping', () => {
  it('classifies by path prefix, never by a name that merely starts the same', () => {
    expect(scopeForFiles(['rush/cli/main.ts'], ['rush/'], ['prix/'])).toBe('project');
    expect(scopeForFiles(['prix/api.ts', 'rush/app.ts'], ['rush/'], ['prix/'])).toBe('project');
    expect(scopeForFiles(['prix/api.ts'], ['rush/'], ['prix/'])).toBeNull();
    expect(scopeForFiles(['rush-infra/main.tf', 'AGENTS.md'], ['rush/'], ['prix/'])).toBe('repo-wide');
  });

  it('claims the subtree a session would be attributed to: a narrowed defaultPath, a repos[] subpath', () => {
    expect(repoPathClaims({ name: 'r', repo: 'acme/mono', root: '/src/mono', defaultPath: '/src/mono/rush/' } as ProjectDef))
      .toEqual([{ slug: 'acme/mono', prefix: 'rush/' }]);
    expect(repoPathClaims({ name: 'u', repo: 'acme/mono', root: '/src/mono', defaultPath: '/src/mono' } as ProjectDef)).toEqual([]);
    expect(repoPathClaims({ name: 'x', repos: [{ slug: 'acme/mono', subpath: './apps/web/' }, { slug: 'acme/other' }] } as ProjectDef))
      .toEqual([{ slug: 'acme/mono', prefix: 'apps/web/' }]);
  });

  it('lists only this project\'s and repo-wide PRs of a shared repo, reading each head\'s files once', async () => {
    const rush = { name: 'rush', repo: 'acme/mono', root: '/src/mono', defaultPath: '/src/mono/rush' } as ProjectDef;
    const prix = { name: 'prix', repo: 'acme/mono', root: '/src/mono', defaultPath: '/src/mono/prix' } as ProjectDef;
    const routes: Record<string, string> = {
      'repos/acme/mono': 'acme/mono\n',
      'user': '{"login":"octocat","avatar_url":"https://avatars.githubusercontent.com/u/583231?v=4","name":"The Octocat","email":null}\n',
      'repos/acme/mono/pulls?state=open&per_page=100': [prLine(1, 'a1'), prLine(2, 'b2'), prLine(3, 'c3')].join('\n'),
      'repos/acme/mono/pulls/1/files?per_page=100': 'prix/api.ts\n',
      'repos/acme/mono/pulls/2/files?per_page=100': 'rush/cli/main.ts\nprix/api.ts\n',
      'repos/acme/mono/pulls/3/files?per_page=100': 'docs/guide.md\n',
    };
    const first = recordedGh(routes);
    const envelope = await buildProjectPrs(rush, {}, first.gh, [rush, prix]);
    expect(envelope.viewer).toBe('octocat');
    const [repo] = envelope.repositories;
    expect(repo.sharedWith).toEqual(['prix']);
    expect(repo.pullRequests.map((pr) => [pr.number, pr.scope])).toEqual([[2, 'project'], [3, 'repo-wide']]);

    const second = recordedGh(routes);
    await buildProjectPrs(rush, {}, second.gh, [rush, prix]);
    expect(second.asked.filter((e) => e.includes('/files'))).toEqual([]);
  });

  it('leaves a repository nobody else is attached to unscoped', async () => {
    const solo = { name: 'solo', repo: 'acme/mono', root: '/src/mono', defaultPath: '/src/mono/rush' } as ProjectDef;
    const { gh, asked } = recordedGh({
      'repos/acme/mono': 'acme/mono\n',
      'user': '{"login":"octocat","avatar_url":"https://avatars.githubusercontent.com/u/583231?v=4","name":"The Octocat","email":null}\n',
      'repos/acme/mono/pulls?state=open&per_page=100': prLine(9, 'd4'),
    });
    const envelope = await buildProjectPrs(solo, {}, gh, [solo]);
    expect(envelope.repositories[0].pullRequests.map((pr) => [pr.number, pr.scope])).toEqual([[9, null]]);
    expect(asked.some((e) => e.includes('/files'))).toBe(false);
  });
});

const REST = (() => {
  const raw = JSON.parse(fs.readFileSync(new URL('./testdata/project-prs-rest.json', import.meta.url), 'utf-8')) as {
    routes: Record<string, string | Array<Record<string, unknown>>>;
  };
  const routes: Record<string, string> = {};
  for (const [endpoint, body] of Object.entries(raw.routes)) {
    routes[endpoint] = typeof body === 'string' ? body : body.map((row) => JSON.stringify(row)).join('\n');
  }
  return routes;
})();
const NOW = Date.parse('2026-10-04T12:00:00Z');
const CLOSED_PAGE = (n: number) => `repos/acme/mono/pulls?state=closed&sort=updated&direction=desc&per_page=100&page=${n}`;
const MERGE = JSON.parse(fs.readFileSync(new URL('./testdata/project-prs-merge.json', import.meta.url), 'utf-8')) as Record<string, string>;
const ghError = (stderr: string) => Object.assign(new Error('Command failed: gh api'), { stderr });
const repoRead = (args: string[]) => (args.includes('.default_branch')
  ? 'main\n'
  : args.some((a) => a.includes('allow_rebase_merge')) ? MERGE['repo-nonadmin'] : 'acme/mono\n');
const freshCache = () => fs.mkdtempSync(path.join(os.tmpdir(), 'project-prs-'));

describe('CI at a glance and recently merged PRs', () => {
  const solo = { name: 'solo', repo: 'acme/mono' } as ProjectDef;
  const soloRoutes = (): Routes => ({
    ...REST,
    'repos/acme/mono': repoRead,
    'user': '{"login":"octocat","avatar_url":"https://avatars.githubusercontent.com/u/583231?v=4","name":"The Octocat","email":null}\n',
    'repos/acme/mono/pulls?state=open&per_page=100': [prLine(1, 'o1'), prLine(2, 'o2'), prLine(3, 'o3')].join('\n'),
  });

  it('classifies each open head\'s REST rollup and names the failing checks', async () => {
    const { gh } = recordedGh(soloRoutes());
    const [repo] = (await buildProjectPrs(solo, {}, gh, [solo], { nowMs: NOW, cacheDir: freshCache() })).repositories;
    expect(repo.error).toBeNull();
    expect(repo.ciError).toBeNull();
    expect(repo.truncated).toBe(false);
    expect(repo.pullRequests.map((pr) => [pr.number, pr.ciState, pr.failingChecks])).toEqual([
      [1, 'FAILURE', ['ci/external', 'test', 'deploy']],
      [2, 'SUCCESS', []],
      [3, null, []],
    ]);
    expect(repo.defaultBranch).toEqual({ name: 'main', sha: 'd0d0d0d', ciState: 'FAILURE', failingChecks: ['test'] });
  });

  it('lists merges in the last 7 days, newest first, keeping one at the cutoff and dropping one a millisecond earlier', async () => {
    const { gh } = recordedGh(soloRoutes());
    const [repo] = (await buildProjectPrs(solo, {}, gh, [solo], { nowMs: NOW, cacheDir: freshCache() })).repositories;
    expect(repo.recentlyMerged.map((pr) => pr.number)).toEqual([13, 10, 15]);
    expect(repo.recentlyMerged[0]).toEqual({
      number: 13, title: 'Docs touch-up', url: 'https://github.com/acme/mono/pull/13',
      author: { login: 'octocat', avatarUrl: 'https://github.com/octocat.png' },
      headRefName: 'docs', baseRefName: 'main', mergedAt: '2026-10-04T08:00:00Z', mergedBy: 'hubot',
      mergeCommitSha: 'c13', ciState: 'FAILURE', failingChecks: ['test'], additions: 4, deletions: 1, scope: null,
    });
    expect(repo.recentlyMerged[1]).toMatchObject({ author: { login: '' }, mergedBy: null, additions: 12, ciState: 'SUCCESS' });
    expect(repo.recentlyMerged[2]).toMatchObject({ mergedAt: '2026-09-27T12:00:00Z', ciState: 'SUCCESS' });
  });

  it('caches only a finished rollup: a warm run re-reads just the running and check-less commits', async () => {
    const cacheDir = freshCache();
    await buildProjectPrs(solo, {}, recordedGh(soloRoutes()).gh, [solo], { nowMs: NOW, cacheDir });
    const warm = recordedGh(soloRoutes());
    const [repo] = (await buildProjectPrs(solo, {}, warm.gh, [solo], { nowMs: NOW, cacheDir })).repositories;
    expect(warm.asked.filter((e) => e.endsWith('/check-runs')).sort()).toEqual([
      'repos/acme/mono/commits/o1/check-runs',
      'repos/acme/mono/commits/o3/check-runs',
    ]);
    expect(warm.asked.filter((e) => /pulls\/\d+$/.test(e))).toEqual([]);
    expect(repo.pullRequests.map((pr) => pr.ciState)).toEqual(['FAILURE', 'SUCCESS', null]);
    expect(repo.recentlyMerged.map((pr) => [pr.number, pr.mergedBy, pr.ciState])).toEqual([
      [13, 'hubot', 'FAILURE'], [10, null, 'SUCCESS'], [15, 'hubot', 'SUCCESS'],
    ]);
  });

  it('trusts a red SHA for five minutes, then re-reads it so a re-run that went green shows up', async () => {
    const cacheDir = freshCache();
    const red = JSON.stringify({ name: 'test', status: 'COMPLETED', conclusion: 'FAILURE', link: '' });
    const green = JSON.stringify({ name: 'test', status: 'COMPLETED', conclusion: 'SUCCESS', link: '' });
    const routesWith = (checkRuns: string): Routes => ({
      ...soloRoutes(), 'repos/acme/mono/commits/o1/check-runs': checkRuns, 'repos/acme/mono/commits/o1/status': '',
    });
    const first = await buildProjectPrs(solo, {}, recordedGh(routesWith(red)).gh, [solo], { nowMs: NOW, cacheDir });
    expect(first.repositories[0].pullRequests[0]).toMatchObject({ number: 1, ciState: 'FAILURE', failingChecks: ['test'] });

    const early = recordedGh(routesWith(green));
    const stillRed = await buildProjectPrs(solo, {}, early.gh, [solo], { nowMs: NOW + FAILING_ROLLUP_TTL_MS - 1, cacheDir });
    expect(early.asked).not.toContain('repos/acme/mono/commits/o1/check-runs');
    expect(stillRed.repositories[0].pullRequests[0]).toMatchObject({ number: 1, ciState: 'FAILURE' });

    const due = recordedGh(routesWith(green));
    const nowGreen = await buildProjectPrs(solo, {}, due.gh, [solo], { nowMs: NOW + FAILING_ROLLUP_TTL_MS, cacheDir });
    expect(due.asked).toContain('repos/acme/mono/commits/o1/check-runs');
    expect(nowGreen.repositories[0].pullRequests[0]).toMatchObject({ number: 1, ciState: 'SUCCESS', failingChecks: [] });
  });

  it('trusts a green SHA for an hour, then re-reads it so a late workflow shows up', async () => {
    const cacheDir = freshCache();
    await buildProjectPrs(solo, {}, recordedGh(soloRoutes()).gh, [solo], { nowMs: NOW, cacheDir });

    const withinHour = recordedGh(soloRoutes());
    await buildProjectPrs(solo, {}, withinHour.gh, [solo], { nowMs: NOW + PASSING_ROLLUP_TTL_MS - 1, cacheDir });
    expect(withinHour.asked).not.toContain('repos/acme/mono/commits/o2/check-runs');

    const late = [
      JSON.stringify({ name: 'test', status: 'COMPLETED', conclusion: 'SUCCESS', link: '' }),
      JSON.stringify({ name: 'deploy-preview', status: 'COMPLETED', conclusion: 'FAILURE', link: '' }),
    ].join('\n');
    const afterHour = recordedGh({ ...soloRoutes(), 'repos/acme/mono/commits/o2/check-runs': late });
    const [repo] = (await buildProjectPrs(solo, {}, afterHour.gh, [solo], { nowMs: NOW + PASSING_ROLLUP_TTL_MS, cacheDir })).repositories;
    expect(afterHour.asked).toContain('repos/acme/mono/commits/o2/check-runs');
    expect(repo.pullRequests[1]).toMatchObject({ number: 2, ciState: 'FAILURE', failingChecks: ['deploy-preview'] });
  });

  it('does not trust a cached rollup from the future after the clock steps backwards', async () => {
    const cacheDir = freshCache();
    await buildProjectPrs(solo, {}, recordedGh(soloRoutes()).gh, [solo], { nowMs: NOW, cacheDir });
    const back = recordedGh(soloRoutes());
    await buildProjectPrs(solo, {}, back.gh, [solo], { nowMs: NOW - 1, cacheDir });
    expect(back.asked).toContain('repos/acme/mono/commits/o2/check-runs');
  });

  it('drops a malformed cache entry on load: the repo still returns, and the commit is re-read', async () => {
    const cacheDir = freshCache();
    fs.writeFileSync(path.join(cacheDir, 'project-pr-ci.json'), JSON.stringify({
      'acme/mono@o2': { items: 'not-an-array', readAt: NOW },
      'acme/mono@d0d0d0d': { items: [{ name: 'test', status: 'COMPLETED', conclusion: 'SUCCESS' }] },
    }));
    fs.writeFileSync(path.join(cacheDir, 'project-pr-merged.json'), JSON.stringify({ 'acme/mono#13': { mergedBy: 7 } }));
    fs.writeFileSync(path.join(cacheDir, 'project-pr-files.json'), JSON.stringify({ 'acme/mono@o1': 'rush/app.ts' }));
    const { gh, asked } = recordedGh(soloRoutes());
    const [repo] = (await buildProjectPrs(solo, {}, gh, [solo], { nowMs: NOW, cacheDir })).repositories;
    expect(repo.error).toBeNull();
    expect(repo.ciError).toBeNull();
    expect(asked).toEqual(expect.arrayContaining([
      'repos/acme/mono/commits/o2/check-runs', 'repos/acme/mono/commits/d0d0d0d/check-runs', 'repos/acme/mono/pulls/13',
    ]));
    expect(repo.pullRequests[1]).toMatchObject({ number: 2, ciState: 'SUCCESS' });
    expect(repo.defaultBranch).toMatchObject({ ciState: 'FAILURE' });
    expect(repo.recentlyMerged[0]).toMatchObject({ number: 13, mergedBy: 'hubot' });
  });

  it('reads at most three pages of closed PRs, and stops as soon as a page reaches past the window', async () => {
    const closedRow = (n: number, updatedAt: string) => JSON.stringify({
      number: n, title: `PR ${n}`, url: '', login: '', avatarUrl: '', headRefName: '', headSha: '', baseRefName: 'main',
      mergedAt: null, mergeCommitSha: null, updatedAt,
    });
    const fullPage = (from: number, lastUpdatedAt = '2026-10-01T00:00:00Z') =>
      Array.from({ length: 100 }, (_, i) => closedRow(from + i, i === 99 ? lastUpdatedAt : '2026-10-02T00:00:00Z')).join('\n');

    const capped = recordedGh({
      ...soloRoutes(), [CLOSED_PAGE(1)]: fullPage(100), [CLOSED_PAGE(2)]: fullPage(200), [CLOSED_PAGE(3)]: fullPage(300), [CLOSED_PAGE(4)]: fullPage(400),
    });
    const [cappedRepo] = (await buildProjectPrs(solo, {}, capped.gh, [solo], { nowMs: NOW, cacheDir: freshCache() })).repositories;
    expect(capped.asked.filter((e) => e.includes('state=closed'))).toEqual([CLOSED_PAGE(1), CLOSED_PAGE(2), CLOSED_PAGE(3)]);
    expect(cappedRepo.truncated).toBe(true);

    const stopped = recordedGh({ ...soloRoutes(), [CLOSED_PAGE(1)]: fullPage(100, '2026-09-26T00:00:00Z'), [CLOSED_PAGE(2)]: fullPage(200) });
    const [stoppedRepo] = (await buildProjectPrs(solo, {}, stopped.gh, [solo], { nowMs: NOW, cacheDir: freshCache() })).repositories;
    expect(stopped.asked.filter((e) => e.includes('state=closed'))).toEqual([CLOSED_PAGE(1)]);
    expect(stoppedRepo.truncated).toBe(false);
  });

  it('reports the latest version tag, npm\'s version of its package, and the merges since it', async () => {
    const tagRoutes: Routes = {
      ...soloRoutes(),
      'repos/acme/mono/tags?per_page=100': 'menubar/v3.0.0\tm3\nv2.0.0\tt2\nv1.9.0\tt1\n',
      'repos/acme/mono/commits/t2': '{"date":"2026-10-01T00:00:00Z","files":["package.json","CHANGELOG.md"]}\n',
      'repos/acme/mono/contents/package.json?ref=v2.0.0': `${Buffer.from('{"name":"@acme/mono","version":"2.0.0"}').toString('base64')}\n`,
    };
    const viewed: string[] = [];
    const envelope = await buildProjectPrs(solo, {}, recordedGh(tagRoutes).gh, [solo], {
      nowMs: NOW, cacheDir: freshCache(), npmView: async (name) => { viewed.push(name); return '1.9.0'; },
    });
    const [repo] = envelope.repositories;
    expect(repo.releaseError).toBeNull();
    expect(repo.release).toEqual({
      latestTag: 'v2.0.0', latestTagAt: '2026-10-01T00:00:00Z', mergesSince: 2, mergesSinceComplete: true,
      npm: { name: '@acme/mono', version: '1.9.0', error: null },
    });
    expect(viewed).toEqual(['@acme/mono']);

    const failed = await buildProjectPrs(solo, {}, recordedGh({
      ...tagRoutes, 'repos/acme/mono/tags?per_page=100': Object.assign(new Error('gh'), { stderr: 'gh: Server Error (HTTP 500)\n' }),
    }).gh, [solo], { nowMs: NOW, cacheDir: freshCache() });
    expect(failed.repositories[0]).toMatchObject({ release: null, releaseError: 'Server Error (HTTP 500)', error: null });
  });

  it('a failed read names itself in ciError, keeps what succeeded, and never fails the repository', async () => {
    const rateLimited = Object.assign(new Error('Command failed: gh api'), {
      stderr: 'gh: API rate limit exceeded for user ID 1. (HTTP 403)\n',
    });
    const serverError = Object.assign(new Error('Command failed: gh api'), { stderr: 'gh: Server Error (HTTP 500)\n' });
    const { gh } = recordedGh({
      ...soloRoutes(),
      [CLOSED_PAGE(1)]: serverError,
      'repos/acme/mono/commits/o1/check-runs': rateLimited,
    });
    const envelope = await buildProjectPrs(solo, {}, gh, [solo], { nowMs: NOW, cacheDir: freshCache() });
    const [repo] = envelope.repositories;
    expect(envelope.partial).toBe(false);
    expect(repo.error).toBeNull();
    expect(repo.ciError).toBe('API rate limit exceeded for user ID 1. (HTTP 403)');
    expect(repo.pullRequests.map((pr) => [pr.number, pr.ciState])).toEqual([[1, null], [2, 'SUCCESS'], [3, null]]);
    expect(repo.recentlyMerged).toEqual([]);
    expect(repo.defaultBranch).toMatchObject({ name: 'main', ciState: 'FAILURE' });
  });

  it('scopes merged PRs in a shared repo like open ones, and keeps both in the files cache', async () => {
    const rush = { name: 'rush', repo: 'acme/mono', root: '/src/mono', defaultPath: '/src/mono/rush' } as ProjectDef;
    const prix = { name: 'prix', repo: 'acme/mono', root: '/src/mono', defaultPath: '/src/mono/prix' } as ProjectDef;
    const routes: Routes = {
      ...soloRoutes(),
      'repos/acme/mono/pulls?state=open&per_page=100': prLine(1, 'o1'),
      'repos/acme/mono/pulls/1/files?per_page=100': 'rush/app.ts\n',
      'repos/acme/mono/pulls/13/files?per_page=100': 'AGENTS.md\n',
      'repos/acme/mono/pulls/10/files?per_page=100': 'rush/cli/main.ts\n',
      'repos/acme/mono/pulls/15/files?per_page=100': 'prix/api.ts\n',
    };
    const cacheDir = freshCache();
    const first = recordedGh(routes);
    const [repo] = (await buildProjectPrs(rush, {}, first.gh, [rush, prix], { nowMs: NOW, cacheDir })).repositories;
    expect(repo.pullRequests.map((pr) => [pr.number, pr.scope, pr.ciState])).toEqual([[1, 'project', 'FAILURE']]);
    expect(repo.recentlyMerged.map((pr) => [pr.number, pr.scope])).toEqual([[13, 'repo-wide'], [10, 'project']]);
    expect(first.asked).not.toContain('repos/acme/mono/pulls/15');

    const second = recordedGh(routes);
    await buildProjectPrs(rush, {}, second.gh, [rush, prix], { nowMs: NOW, cacheDir });
    expect(second.asked.filter((e) => e.includes('/files'))).toEqual([]);
  });

  it('one project\'s run in a shared repo keeps the rollups another project cached', async () => {
    const rush = { name: 'rush', repo: 'acme/mono', root: '/src/mono', defaultPath: '/src/mono/rush' } as ProjectDef;
    const prix = { name: 'prix', repo: 'acme/mono', root: '/src/mono', defaultPath: '/src/mono/prix' } as ProjectDef;
    const routes: Routes = {
      ...soloRoutes(),
      'repos/acme/mono/pulls?state=open&per_page=100': [prLine(1, 'o1'), prLine(2, 'o2')].join('\n'),
      'repos/acme/mono/pulls/1/files?per_page=100': 'rush/app.ts\n',
      'repos/acme/mono/pulls/2/files?per_page=100': 'prix/api.ts\n',
      'repos/acme/mono/pulls/13/files?per_page=100': 'AGENTS.md\n',
      'repos/acme/mono/pulls/10/files?per_page=100': 'rush/cli/main.ts\n',
      'repos/acme/mono/pulls/15/files?per_page=100': 'prix/api.ts\n',
    };
    const cacheDir = freshCache();
    await buildProjectPrs(prix, {}, recordedGh(routes).gh, [rush, prix], { nowMs: NOW, cacheDir });
    await buildProjectPrs(rush, {}, recordedGh(routes).gh, [rush, prix], { nowMs: NOW, cacheDir });
    const again = recordedGh(routes);
    const [repo] = (await buildProjectPrs(prix, {}, again.gh, [rush, prix], { nowMs: NOW, cacheDir })).repositories;
    expect(again.asked).not.toContain('repos/acme/mono/commits/o2/check-runs');
    expect(repo.pullRequests.map((pr) => [pr.number, pr.ciState])).toEqual([[2, 'SUCCESS']]);
  });

  it('--number carries the same verdict from the REST rollup and no merged list', async () => {
    const { gh } = recordedGh({
      'repos/acme/mono': repoRead,
      'user': '{"login":"octocat","avatar_url":"https://avatars.githubusercontent.com/u/583231?v=4","name":"The Octocat","email":null}\n',
      'repos/acme/mono/pulls/1': prLine(1, 'o1'),
      'pr view 1 --repo acme/mono --json reviewDecision,headRefOid': JSON.stringify({ reviewDecision: 'APPROVED', headRefOid: 'o1' }),
      'repos/acme/mono/commits/o1/check-runs': REST['repos/acme/mono/commits/o1/check-runs'],
      'repos/acme/mono/commits/o1/status': REST['repos/acme/mono/commits/o1/status'],
    });
    const [repo] = (await buildProjectPrs(solo, { repo: 'acme/mono', number: 1 }, gh, [solo], { nowMs: NOW, cacheDir: freshCache() })).repositories;
    expect(repo.pullRequests[0]).toMatchObject({
      ciState: 'FAILURE', failingChecks: ['ci/external', 'test', 'deploy'], reviewDecision: 'APPROVED',
    });
    expect(repo).toMatchObject({ recentlyMerged: [], defaultBranch: null, ciError: null, truncated: false, release: null, releaseError: null });
    expect(repo.merge).toEqual({ viewerIsAdmin: false, adminBypass: false, autoMergeAllowed: false, methods: ['squash', 'merge'] });
  });

  it('a failed merge-settings read leaves merge null and names itself in ciError, on both paths', async () => {
    const failing = (args: string[]) => {
      if (args.some((a) => a.includes('allow_rebase_merge'))) throw ghError('gh: Server Error (HTTP 502)\n');
      return repoRead(args);
    };
    const detail = recordedGh({
      'repos/acme/mono': failing,
      'user': '{"login":"octocat"}\n',
      'repos/acme/mono/pulls/1': prLine(1, 'o1'),
      'pr view 1 --repo acme/mono --json reviewDecision,headRefOid': JSON.stringify({ reviewDecision: null, headRefOid: 'o1' }),
      'repos/acme/mono/commits/o1/check-runs': REST['repos/acme/mono/commits/o1/check-runs'],
      'repos/acme/mono/commits/o1/status': REST['repos/acme/mono/commits/o1/status'],
    });
    const [one] = (await buildProjectPrs(solo, { repo: 'acme/mono', number: 1 }, detail.gh, [solo], { nowMs: NOW, cacheDir: freshCache() })).repositories;
    expect(one).toMatchObject({ merge: null, ciError: 'Server Error (HTTP 502)', error: null });
    const list = recordedGh({ ...soloRoutes(), 'repos/acme/mono': failing });
    const [all] = (await buildProjectPrs(solo, {}, list.gh, [solo], { nowMs: NOW, cacheDir: freshCache() })).repositories;
    expect(all).toMatchObject({ merge: null, ciError: 'Server Error (HTTP 502)', error: null });
    expect(all.pullRequests.length).toBe(3);
  });

  it('reads the REST rollup with GitHub\'s precedence, and tells a finished rollup from a passing one', () => {
    expect(ciFromRollupItems([])).toEqual({ ciState: null, failingChecks: [] });
    expect(ciFromRollupItems([{ name: 'a', status: 'COMPLETED', conclusion: 'SKIPPED' }, { name: 'b', state: 'SUCCESS' }]))
      .toEqual({ ciState: 'SUCCESS', failingChecks: [] });
    expect(ciFromRollupItems([{ name: 'a', status: 'QUEUED', conclusion: '' }])).toEqual({ ciState: 'PENDING', failingChecks: [] });
    expect(ciFromRollupItems([{ name: 'a', state: 'ERROR' }, { name: 'b', state: 'PENDING' }]))
      .toEqual({ ciState: 'ERROR', failingChecks: ['a'] });
    expect(ciFromRollupItems([{ name: 'a', state: 'ERROR' }, { name: 'b', status: 'COMPLETED', conclusion: 'ACTION_REQUIRED' }]))
      .toEqual({ ciState: 'FAILURE', failingChecks: ['a', 'b'] });
    expect(isPassingRollup([])).toBe(false);
    expect(isPassingRollup([{ name: 'a', status: 'COMPLETED', conclusion: 'SUCCESS' }, { name: 'b', status: 'COMPLETED', conclusion: 'SKIPPED' }, { name: 'c', state: 'SUCCESS' }])).toBe(true);
    expect(isPassingRollup([{ name: 'a', status: 'COMPLETED', conclusion: 'FAILURE' }])).toBe(false);
    expect(isPassingRollup([{ name: 'a', status: 'COMPLETED', conclusion: 'SUCCESS' }, { name: 'b', state: 'PENDING' }])).toBe(false);
    expect(isFinishedRollup([])).toBe(false);
    expect(isFinishedRollup([{ name: 'a', status: 'COMPLETED', conclusion: 'FAILURE' }, { name: 'b', state: 'ERROR' }])).toBe(true);
    expect(isFinishedRollup([{ name: 'a', status: 'IN_PROGRESS', conclusion: '' }])).toBe(false);
  });
});

describe('mergeProjectPr', () => {
  it('pins the merge to the reviewed SHA with the first method the repo allows', async () => {
    const { gh, asked } = recordedGh({
      'repos/acme/mono': MERGE['repo-nonadmin'],
      'repos/acme/mono/pulls/7': 'clean\n',
      'PUT repos/acme/mono/pulls/7/merge': 'm1\n',
    });
    const calls: string[][] = [];
    const result = await mergeProjectPr('acme/mono', 7, 'abc1234', undefined, {}, async (args) => { calls.push(args); return gh(args); });
    expect(result).toEqual({ repo: 'acme/mono', number: 7, method: 'squash', merged: true, sha: 'm1', message: 'Merged' });
    expect(asked).toContain('PUT repos/acme/mono/pulls/7/merge');
    expect(calls.at(-1)).toEqual(expect.arrayContaining(['sha=abc1234', 'merge_method=squash']));
  });

  it('reports a moved head (409) as not merged, in words', async () => {
    const refusal = ghError('gh: Head branch was modified. Review and try the merge again. (HTTP 409)\nsee: https://docs.github.com\n');
    const { gh } = recordedGh({ 'repos/acme/mono/pulls/7': 'unstable\n', 'PUT repos/acme/mono/pulls/7/merge': refusal });
    const result = await mergeProjectPr('acme/mono', 7, 'abc1234', 'rebase', {}, gh);
    expect(result.merged).toBe(false);
    expect(result.message).toBe('The head moved since you looked; reload the PR and try again (HTTP 409)');
  });

  it('refuses a blocked PR without --admin before any write', async () => {
    const { gh, asked } = recordedGh({ 'repos/acme/mono/pulls/7': 'blocked\n' });
    const result = await mergeProjectPr('acme/mono', 7, 'abc1234', 'rebase', {}, gh);
    expect(result).toEqual({ repo: 'acme/mono', number: 7, method: 'rebase', merged: false, sha: null, message: BLOCKED_WITHOUT_ADMIN });
    expect(asked).toEqual(['repos/acme/mono/pulls/7']);
  });

  it('fails closed on a state GitHub has not computed yet, or a branch behind its base', async () => {
    for (const [state, message] of [
      ['', 'GitHub is still computing mergeability; try again in a moment'],
      ['unknown', 'GitHub is still computing mergeability; try again in a moment'],
      ['behind', 'The branch is behind its base; update it, or pass --admin to merge as an admin'],
      ['dirty', 'Has merge conflicts'],
    ] as const) {
      const { gh, asked } = recordedGh({ 'repos/acme/mono/pulls/7': `${state}\n` });
      const result = await mergeProjectPr('acme/mono', 7, 'abc1234', 'rebase', {}, gh);
      expect(result).toMatchObject({ merged: false, message });
      expect(asked).toEqual(['repos/acme/mono/pulls/7']);
    }
  });

  it('--admin puts the pinned merge without reading mergeable_state', async () => {
    const calls: string[][] = [];
    const { gh, asked } = recordedGh({ 'PUT repos/acme/mono/pulls/7/merge': 'm2\n' });
    const result = await mergeProjectPr('acme/mono', 7, 'abc1234', 'rebase', { admin: true }, async (args) => { calls.push(args); return gh(args); });
    expect(result).toEqual({ repo: 'acme/mono', number: 7, method: 'rebase', merged: true, sha: 'm2', message: 'Merged' });
    expect(asked).toEqual(['PUT repos/acme/mono/pulls/7/merge']);
    expect(calls[0]).toEqual(expect.arrayContaining(['sha=abc1234', 'merge_method=rebase']));
  });

  it('--admin that GitHub still refuses names the required check that has not passed', async () => {
    const { gh } = recordedGh({ 'PUT repos/acme/mono/pulls/7/merge': ghError(MERGE['refusal-405-stderr']) });
    const result = await mergeProjectPr('acme/mono', 7, 'abc1234', 'rebase', { admin: true }, gh);
    expect(result).toMatchObject({ merged: false, message: "Required check test hasn't passed (HTTP 405)" });
  });

  it('turns GitHub\'s refusals into readable reasons and leaves others verbatim', () => {
    expect(readableMergeRefusal('Required status checks test, gitleaks are expected. (HTTP 405)'))
      .toBe("Required checks test, gitleaks haven't passed (HTTP 405)");
    expect(readableMergeRefusal('At least 1 approving review is required by reviewers with write access. (HTTP 405)'))
      .toBe('At least 1 approving review is required by reviewers with write access. (HTTP 405)');
  });

  it('a repository read that fails is a refusal, not a crash', async () => {
    const { gh } = recordedGh({ 'repos/acme/mono': Object.assign(new Error('x'), { stderr: 'gh: Not Found (HTTP 404)\n' }) });
    const result = await mergeProjectPr('acme/mono', 7, 'abc1234', undefined, {}, gh);
    expect(result).toMatchObject({ merged: false, message: 'Not Found (HTTP 404)' });
  });
});

const HEAD = 'abc1234def5678abc1234def5678abc1234def56';
const livePr = (sha: string, author: string) => `${JSON.stringify({ sha, author })}\n`;
const viewer = (login: string | null) => async () => login;

describe('readRepoMergeAbility', () => {
  it('an admin on a branch that enforces protection on admins has no bypass', async () => {
    const { gh, asked } = recordedGh({
      'repos/acme/mono': MERGE['repo-protected'],
      'repos/acme/mono/branches/main/protection': MERGE['protection-enforced'],
    });
    expect(await readRepoMergeAbility('acme/mono', gh)).toEqual({
      viewerIsAdmin: true, adminBypass: false, autoMergeAllowed: true, methods: ['rebase', 'squash', 'merge'],
    });
    expect(asked).toEqual(['repos/acme/mono', 'repos/acme/mono/branches/main/protection']);
  });

  it('an admin bypasses when enforce_admins is off, and when the branch is unprotected (404)', async () => {
    const off = recordedGh({ 'repos/acme/mono': MERGE['repo-protected'], 'repos/acme/mono/branches/main/protection': MERGE['protection-not-enforced'] });
    expect((await readRepoMergeAbility('acme/mono', off.gh)).adminBypass).toBe(true);
    const none = recordedGh({ 'repos/acme/mono': MERGE['repo-protected'], 'repos/acme/mono/branches/main/protection': ghError(MERGE['protection-404-stderr']) });
    expect((await readRepoMergeAbility('acme/mono', none.gh)).adminBypass).toBe(true);
  });

  it('a protection read that fails for another reason fails the read instead of guessing', async () => {
    const { gh } = recordedGh({ 'repos/acme/mono': MERGE['repo-protected'], 'repos/acme/mono/branches/main/protection': ghError('gh: Server Error (HTTP 502)\n') });
    await expect(readRepoMergeAbility('acme/mono', gh)).rejects.toMatchObject({ stderr: 'gh: Server Error (HTTP 502)\n' });
  });

  it('a non-admin never reads protection', async () => {
    const { gh, asked } = recordedGh({ 'repos/acme/mono': MERGE['repo-nonadmin'] });
    expect(await readRepoMergeAbility('acme/mono', gh)).toEqual({
      viewerIsAdmin: false, adminBypass: false, autoMergeAllowed: false, methods: ['squash', 'merge'],
    });
    expect(asked).toEqual(['repos/acme/mono']);
  });
});

describe('setProjectPrAutoMerge', () => {
  const pr = (over: Record<string, unknown> = {}) => `${JSON.stringify({ sha: HEAD, nodeId: 'PR_kw7', state: 'open', merged: false, autoMethod: null, ...over })}\n`;

  it('turns it on with one mutation pinned to the full live head and the repo\'s first method', async () => {
    const calls: string[][] = [];
    const { gh, asked } = recordedGh({
      'repos/acme/mono/pulls/7': pr(),
      'repos/acme/mono': MERGE['repo-protected'],
      graphql: 'REBASE\n',
    });
    const result = await setProjectPrAutoMerge('acme/mono', 7, { enable: true, sha: 'abc1234' }, async (args) => { calls.push(args); return gh(args); });
    expect(result).toMatchObject({ repo: 'acme/mono', number: 7, enabled: true, method: 'rebase' });
    expect(asked).toEqual(['repos/acme/mono/pulls/7', 'repos/acme/mono', 'graphql']);
    const mutation = calls.at(-1)!;
    expect(mutation.join(' ')).toContain('enablePullRequestAutoMerge');
    expect(mutation).toEqual(expect.arrayContaining(['id=PR_kw7', 'method=REBASE', `head=${HEAD}`]));
  });

  it('refuses a moved head before the mutation', async () => {
    const { gh, asked } = recordedGh({ 'repos/acme/mono/pulls/7': pr({ sha: `fff0000${HEAD.slice(7)}` }) });
    const result = await setProjectPrAutoMerge('acme/mono', 7, { enable: true, sha: 'abc1234', method: 'squash' }, gh);
    expect(result).toMatchObject({ enabled: false, method: null });
    expect(result.message).toContain('moved to fff0000');
    expect(asked).not.toContain('graphql');
  });

  it('turns it off with one mutation, and answers "not on" without a write', async () => {
    const calls: string[][] = [];
    const on = recordedGh({ 'repos/acme/mono/pulls/7': pr({ autoMethod: 'rebase' }), graphql: 'null\n' });
    const result = await setProjectPrAutoMerge('acme/mono', 7, { enable: false }, async (args) => { calls.push(args); return on.gh(args); });
    expect(result).toEqual({ repo: 'acme/mono', number: 7, enabled: false, method: null, message: 'Auto-merge turned off' });
    expect(calls.at(-1)!.join(' ')).toContain('disablePullRequestAutoMerge');
    const off = recordedGh({ 'repos/acme/mono/pulls/7': pr() });
    expect(await setProjectPrAutoMerge('acme/mono', 7, { enable: false }, off.gh)).toMatchObject({ enabled: false, message: 'Auto-merge was not on' });
    expect(off.asked).toEqual(['repos/acme/mono/pulls/7']);
  });

  it('reports GitHub\'s refusal and the unchanged state', async () => {
    const { gh } = recordedGh({
      'repos/acme/mono/pulls/7': pr(),
      graphql: ghError('gh: Pull request is in clean status\n'),
    });
    const result = await setProjectPrAutoMerge('acme/mono', 7, { enable: true, sha: HEAD, method: 'rebase' }, gh);
    expect(result).toEqual({ repo: 'acme/mono', number: 7, enabled: false, method: null, message: 'Pull request is in clean status' });
  });
});

describe('markProjectPrReady', () => {
  it('marks a draft ready with one mutation on the node id the REST read returned', async () => {
    const { gh, asked } = recordedGh({
      'repos/acme/mono/pulls/7': JSON.stringify({ sha: HEAD, draft: true, nodeId: 'PR_kw7', state: 'open', merged: false }),
      graphql: 'false\n',
    });
    const calls: string[][] = [];
    const result = await markProjectPrReady('acme/mono', 7, 'abc1234', async (args) => { calls.push(args); return gh(args); });
    expect(result).toEqual({ repo: 'acme/mono', number: 7, ready: true, sha: HEAD, message: 'Marked ready for review' });
    expect(asked).toEqual(['repos/acme/mono/pulls/7', 'graphql']);
    expect(calls.at(-1)).toContain('id=PR_kw7');
    expect(calls.at(-1)!.join(' ')).toContain('markPullRequestReadyForReview');
  });

  it('a PR that is already ready succeeds without a write', async () => {
    const { gh, asked } = recordedGh({
      'repos/acme/mono/pulls/7': JSON.stringify({ sha: HEAD, draft: false, nodeId: 'PR_kw7', state: 'open', merged: false }),
    });
    const result = await markProjectPrReady('acme/mono', 7, undefined, gh);
    expect(result).toMatchObject({ ready: true, message: 'Already ready for review' });
    expect(asked).toEqual(['repos/acme/mono/pulls/7']);
  });

  it('refuses a merged or closed PR instead of reporting it ready, without a write', async () => {
    const { gh, asked } = recordedGh({
      'repos/acme/mono/pulls/7': JSON.stringify({ sha: HEAD, draft: false, nodeId: 'PR_kw7', state: 'closed', merged: true }),
    });
    const result = await markProjectPrReady('acme/mono', 7, undefined, gh);
    expect(result).toMatchObject({ ready: false, message: 'Already merged' });
    expect(asked).toEqual(['repos/acme/mono/pulls/7']);
  });

  it('refuses a head that moved since the caller looked, before any write', async () => {
    const { gh, asked } = recordedGh({
      'repos/acme/mono/pulls/7': JSON.stringify({ sha: 'fff0000' + HEAD.slice(7), draft: true, nodeId: 'PR_kw7', state: 'open', merged: false }),
    });
    const result = await markProjectPrReady('acme/mono', 7, 'abc1234', gh);
    expect(result).toMatchObject({ ready: false, sha: null });
    expect(result.message).toContain('moved to fff0000');
    expect(asked).not.toContain('graphql');
  });
});

describe('approveProjectPr', () => {
  it('records the approval against the full live SHA the short --sha names', async () => {
    const { gh, asked } = recordedGh({
      'repos/acme/mono/pulls/7': livePr(HEAD, 'someone-else'),
      'POST repos/acme/mono/pulls/7/reviews': JSON.stringify({ id: 99, url: 'https://github.com/acme/mono/pull/7#pullrequestreview-99' }),
    });
    const calls: string[][] = [];
    const result = await approveProjectPr('acme/mono', 7, 'ABC1234', 'Checked it', async (args) => { calls.push(args); return gh(args); }, viewer('octocat'));
    expect(result).toEqual({
      repo: 'acme/mono', number: 7, event: 'APPROVE', submitted: true, sha: HEAD, id: 99,
      url: 'https://github.com/acme/mono/pull/7#pullrequestreview-99', message: 'Approved',
    });
    expect(asked).toContain('POST repos/acme/mono/pulls/7/reviews');
    expect(calls.at(-1)).toEqual(expect.arrayContaining(['event=APPROVE', `commit_id=${HEAD}`, 'body=Checked it']));
  });

  it('refuses a moved head without posting a review', async () => {
    const { gh, asked } = recordedGh({ 'repos/acme/mono/pulls/7': livePr(`fff0000${HEAD.slice(7)}`, 'someone-else') });
    const result = await approveProjectPr('acme/mono', 7, 'abc1234', undefined, gh, viewer('octocat'));
    expect(result).toMatchObject({ submitted: false, sha: null, id: null });
    expect(asked.some((e) => e.startsWith('POST'))).toBe(false);
  });

  it('answers your own PR without posting, whatever the head', async () => {
    const { gh, asked } = recordedGh({ 'repos/acme/mono/pulls/7': livePr(HEAD, 'OctoCat') });
    const result = await approveProjectPr('acme/mono', 7, 'fff0000', undefined, gh, viewer('octocat'));
    expect(result).toEqual({
      repo: 'acme/mono', number: 7, event: 'APPROVE', submitted: false, sha: HEAD, id: null, url: null, message: OWN_PR_APPROVAL,
    });
    expect(asked).toEqual(['repos/acme/mono/pulls/7']);
  });

  it('still reports GitHub\'s own refusal when the viewer is unknown', async () => {
    const { gh } = recordedGh({
      'repos/acme/mono/pulls/7': livePr(HEAD, 'octocat'),
      'POST repos/acme/mono/pulls/7/reviews': ghError('gh: Unprocessable Entity (HTTP 422)\n'),
    });
    const result = await approveProjectPr('acme/mono', 7, HEAD, undefined, gh, viewer(null));
    expect(result).toMatchObject({ submitted: false, sha: HEAD, message: 'Unprocessable Entity (HTTP 422)' });
  });
});

describe('commentOnProjectPr', () => {
  it('posts the body verbatim to the issue comments endpoint', async () => {
    const { gh } = recordedGh({
      'POST repos/acme/mono/issues/7/comments': JSON.stringify({ id: 5, url: 'https://github.com/acme/mono/pull/7#issuecomment-5' }),
    });
    const calls: string[][] = [];
    const body = '@octocat two notes:\n- one\n- two';
    const result = await commentOnProjectPr('acme/mono', 7, body, async (args) => { calls.push(args); return gh(args); });
    expect(result).toEqual({
      repo: 'acme/mono', number: 7, commented: true, id: 5, url: 'https://github.com/acme/mono/pull/7#issuecomment-5', message: 'Commented',
    });
    expect(calls[0]).toEqual(expect.arrayContaining(['-f', `body=${body}`]));
  });

  it('reports a refusal as not commented', async () => {
    const { gh } = recordedGh({
      'POST repos/acme/mono/issues/7/comments': Object.assign(new Error('x'), { stderr: 'gh: Not Found (HTTP 404)\n' }),
    });
    expect(await commentOnProjectPr('acme/mono', 7, 'hi', gh)).toMatchObject({ commented: false, message: 'Not Found (HTTP 404)' });
  });
});
