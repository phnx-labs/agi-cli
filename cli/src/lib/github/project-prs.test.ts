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
  commentOnProjectPr,
  markProjectPrReady,
  mergeProjectPr,
  rowToProjectPr,
  scopeForFiles,
} from './project-prs.js';
import { repoPathClaims } from '../projects.js';
import type { ProjectDef } from '../projects.js';

describe('project PR projection', () => {
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

/**
 * A gh runner that answers from recorded REST payloads keyed by endpoint, and
 * records which endpoints were asked — the same JSON lines `gh api --jq` prints.
 */
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
      'user': 'octocat\n',
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
      'user': 'octocat\n',
      'repos/acme/mono/pulls?state=open&per_page=100': prLine(9, 'd4'),
    });
    const envelope = await buildProjectPrs(solo, {}, gh, [solo]);
    expect(envelope.repositories[0].pullRequests.map((pr) => [pr.number, pr.scope])).toEqual([[9, null]]);
    expect(asked.some((e) => e.includes('/files'))).toBe(false);
  });
});

/** Recorded REST answers for acme/mono (open-PR, merge-commit and default-branch CI, the closed-PR list). */
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
/** `repos/{r}` answers canonicalization (`.full_name`) and the default branch (`.default_branch`). */
const repoRead = (args: string[]) => (args.includes('.default_branch') ? 'main\n' : 'acme/mono\n');
const freshCache = () => fs.mkdtempSync(path.join(os.tmpdir(), 'project-prs-'));

describe('CI at a glance and recently merged PRs', () => {
  const solo = { name: 'solo', repo: 'acme/mono' } as ProjectDef;
  const soloRoutes = (): Routes => ({
    ...REST,
    'repos/acme/mono': repoRead,
    'user': 'octocat\n',
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

  it('caches only an all-passing rollup: a warm run re-reads the running, empty and red commits', async () => {
    const cacheDir = freshCache();
    await buildProjectPrs(solo, {}, recordedGh(soloRoutes()).gh, [solo], { nowMs: NOW, cacheDir });
    const warm = recordedGh(soloRoutes());
    const [repo] = (await buildProjectPrs(solo, {}, warm.gh, [solo], { nowMs: NOW, cacheDir })).repositories;
    expect(warm.asked.filter((e) => e.endsWith('/check-runs')).sort()).toEqual([
      'repos/acme/mono/commits/c13/check-runs',
      'repos/acme/mono/commits/d0d0d0d/check-runs',
      'repos/acme/mono/commits/o1/check-runs',
      'repos/acme/mono/commits/o3/check-runs',
    ]);
    expect(warm.asked.filter((e) => /pulls\/\d+$/.test(e))).toEqual([]);
    expect(repo.pullRequests.map((pr) => pr.ciState)).toEqual(['FAILURE', 'SUCCESS', null]);
    expect(repo.recentlyMerged.map((pr) => [pr.number, pr.mergedBy, pr.ciState])).toEqual([
      [13, 'hubot', 'FAILURE'], [10, null, 'SUCCESS'], [15, 'hubot', 'SUCCESS'],
    ]);
  });

  it('a red SHA is re-read every run, so re-running the failed job on it turns the row green', async () => {
    const cacheDir = freshCache();
    const red = JSON.stringify({ name: 'test', status: 'COMPLETED', conclusion: 'FAILURE', link: '' });
    const green = JSON.stringify({ name: 'test', status: 'COMPLETED', conclusion: 'SUCCESS', link: '' });
    const first = await buildProjectPrs(solo, {}, recordedGh({ ...soloRoutes(), 'repos/acme/mono/commits/o1/check-runs': red, 'repos/acme/mono/commits/o1/status': '' }).gh,
      [solo], { nowMs: NOW, cacheDir });
    expect(first.repositories[0].pullRequests[0]).toMatchObject({ number: 1, ciState: 'FAILURE', failingChecks: ['test'] });

    const rerun = recordedGh({ ...soloRoutes(), 'repos/acme/mono/commits/o1/check-runs': green, 'repos/acme/mono/commits/o1/status': '' });
    const second = await buildProjectPrs(solo, {}, rerun.gh, [solo], { nowMs: NOW + 60_000, cacheDir });
    expect(rerun.asked).toContain('repos/acme/mono/commits/o1/check-runs');
    expect(second.repositories[0].pullRequests[0]).toMatchObject({ number: 1, ciState: 'SUCCESS', failingChecks: [] });
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
    // A merged PR scoped out is never read further.
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
    // rush never reads PR 2 (prix-only), and must not evict prix's cached green rollup for it.
    await buildProjectPrs(rush, {}, recordedGh(routes).gh, [rush, prix], { nowMs: NOW, cacheDir });
    const again = recordedGh(routes);
    const [repo] = (await buildProjectPrs(prix, {}, again.gh, [rush, prix], { nowMs: NOW, cacheDir })).repositories;
    expect(again.asked).not.toContain('repos/acme/mono/commits/o2/check-runs');
    expect(repo.pullRequests.map((pr) => [pr.number, pr.ciState])).toEqual([[2, 'SUCCESS']]);
  });

  it('--number carries the same verdict from the REST rollup and no merged list', async () => {
    const { gh } = recordedGh({
      'repos/acme/mono': repoRead,
      'user': 'octocat\n',
      'repos/acme/mono/pulls/1': prLine(1, 'o1'),
      'pr view 1 --repo acme/mono --json reviewDecision,headRefOid': JSON.stringify({ reviewDecision: 'APPROVED', headRefOid: 'o1' }),
      'repos/acme/mono/commits/o1/check-runs': REST['repos/acme/mono/commits/o1/check-runs'],
      'repos/acme/mono/commits/o1/status': REST['repos/acme/mono/commits/o1/status'],
    });
    const [repo] = (await buildProjectPrs(solo, { repo: 'acme/mono', number: 1 }, gh, [solo], { nowMs: NOW, cacheDir: freshCache() })).repositories;
    expect(repo.pullRequests[0]).toMatchObject({
      ciState: 'FAILURE', failingChecks: ['ci/external', 'test', 'deploy'], reviewDecision: 'APPROVED',
    });
    expect(repo).toMatchObject({ recentlyMerged: [], defaultBranch: null, ciError: null, truncated: false });
  });

  it('reads the REST rollup with GitHub\'s precedence, and calls only a finished green rollup cacheable', () => {
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
  });
});

describe('mergeProjectPr', () => {
  it('pins the merge to the reviewed SHA with the first method the repo allows', async () => {
    const { gh, asked } = recordedGh({
      'repos/acme/mono': JSON.stringify({ rebase: false, squash: true, merge: true }),
      'PUT repos/acme/mono/pulls/7/merge': 'm1\n',
    });
    const calls: string[][] = [];
    const result = await mergeProjectPr('acme/mono', 7, 'abc1234', undefined, async (args) => { calls.push(args); return gh(args); });
    expect(result).toEqual({ repo: 'acme/mono', number: 7, method: 'squash', merged: true, sha: 'm1', message: 'Merged' });
    expect(asked).toContain('PUT repos/acme/mono/pulls/7/merge');
    expect(calls.at(-1)).toEqual(expect.arrayContaining(['sha=abc1234', 'merge_method=squash']));
  });

  it('reports GitHub\'s refusal as not merged with GitHub\'s own line', async () => {
    const refusal = Object.assign(new Error('Command failed: gh api'), {
      stderr: 'gh: Head branch was modified. Review and try the merge again. (HTTP 409)\nsee: https://docs.github.com\n',
    });
    const { gh } = recordedGh({ 'PUT repos/acme/mono/pulls/7/merge': refusal });
    const result = await mergeProjectPr('acme/mono', 7, 'abc1234', 'rebase', gh);
    expect(result.merged).toBe(false);
    expect(result.message).toBe('Head branch was modified. Review and try the merge again. (HTTP 409)');
  });

  it('a repository read that fails is a refusal, not a crash', async () => {
    const { gh } = recordedGh({ 'repos/acme/mono': Object.assign(new Error('x'), { stderr: 'gh: Not Found (HTTP 404)\n' }) });
    const result = await mergeProjectPr('acme/mono', 7, 'abc1234', undefined, gh);
    expect(result).toMatchObject({ merged: false, message: 'Not Found (HTTP 404)' });
  });
});

const HEAD = 'abc1234def5678abc1234def5678abc1234def56';

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
      'repos/acme/mono/pulls/7': `${HEAD}\n`,
      'POST repos/acme/mono/pulls/7/reviews': JSON.stringify({ id: 99, url: 'https://github.com/acme/mono/pull/7#pullrequestreview-99' }),
    });
    const calls: string[][] = [];
    const result = await approveProjectPr('acme/mono', 7, 'ABC1234', 'Checked it', async (args) => { calls.push(args); return gh(args); });
    expect(result).toEqual({
      repo: 'acme/mono', number: 7, event: 'APPROVE', submitted: true, sha: HEAD, id: 99,
      url: 'https://github.com/acme/mono/pull/7#pullrequestreview-99', message: 'Approved',
    });
    expect(asked).toContain('POST repos/acme/mono/pulls/7/reviews');
    expect(calls.at(-1)).toEqual(expect.arrayContaining(['event=APPROVE', `commit_id=${HEAD}`, 'body=Checked it']));
  });

  it('refuses a moved head without posting a review', async () => {
    const { gh, asked } = recordedGh({ 'repos/acme/mono/pulls/7': `fff0000${HEAD.slice(7)}\n` });
    const result = await approveProjectPr('acme/mono', 7, 'abc1234', undefined, gh);
    expect(result).toMatchObject({ submitted: false, sha: null, id: null });
    expect(asked.some((e) => e.startsWith('POST'))).toBe(false);
  });

  it('reports GitHub\'s refusal to approve your own PR', async () => {
    const own = Object.assign(new Error('Command failed: gh api'), {
      stderr: 'gh: Unprocessable Entity (HTTP 422)\n',
    });
    const { gh } = recordedGh({
      'repos/acme/mono/pulls/7': `${HEAD}\n`,
      'POST repos/acme/mono/pulls/7/reviews': own,
    });
    const result = await approveProjectPr('acme/mono', 7, HEAD, undefined, gh);
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
    // -f keeps a leading @ literal; -F would read it as a file name.
    expect(calls[0]).toEqual(expect.arrayContaining(['-f', `body=${body}`]));
  });

  it('reports a refusal as not commented', async () => {
    const { gh } = recordedGh({
      'POST repos/acme/mono/issues/7/comments': Object.assign(new Error('x'), { stderr: 'gh: Not Found (HTTP 404)\n' }),
    });
    expect(await commentOnProjectPr('acme/mono', 7, 'hi', gh)).toMatchObject({ commented: false, message: 'Not Found (HTTP 404)' });
  });
});
