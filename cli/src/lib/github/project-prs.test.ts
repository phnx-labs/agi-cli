import * as fs from 'fs';
import { describe, expect, it } from 'vitest';
import {
  approveProjectPr,
  buildProjectPrs,
  ciFromRollupItems,
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
function recordedGh(routes: Record<string, string | Error>) {
  const asked: string[] = [];
  const gh = async (args: string[]) => {
    const endpoint = args[0] === 'api' ? (args[1] === '-X' ? `${args[2]} ${args[3]}` : args[1]) : args.join(' ');
    asked.push(endpoint);
    const hit = routes[endpoint];
    if (hit === undefined) throw new Error(`unexpected gh ${args.join(' ')}`);
    if (hit instanceof Error) throw hit;
    return hit;
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

/** A recorded `gh api graphql` answer for acme/mono: open-PR CI, merged PRs, and the default branch. */
const GRAPHQL = fs.readFileSync(new URL('./testdata/project-prs-graphql.json', import.meta.url), 'utf-8');
const NOW = Date.parse('2026-10-04T12:00:00Z');

describe('CI at a glance and recently merged PRs', () => {
  const solo = { name: 'solo', repo: 'acme/mono' } as ProjectDef;
  const soloRoutes = (graphql: string | Error) => ({
    'repos/acme/mono': 'acme/mono\n',
    'user': 'octocat\n',
    'repos/acme/mono/pulls?state=open&per_page=100': [prLine(1, 'o1'), prLine(2, 'o2'), prLine(3, 'o3'), prLine(4, 'o4')].join('\n'),
    graphql,
  });

  it('joins each open PR to its head rollup and names the failing checks', async () => {
    const { gh } = recordedGh(soloRoutes(GRAPHQL));
    const [repo] = (await buildProjectPrs(solo, {}, gh, [solo], NOW)).repositories;
    expect(repo.error).toBeNull();
    expect(repo.pullRequests.map((pr) => [pr.number, pr.ciState, pr.failingChecks])).toEqual([
      [1, 'FAILURE', ['test', 'deploy', 'ci/external']],
      [2, 'PENDING', []],
      // No rollup on the head commit, and a PR past the GraphQL page: no checks to report.
      [3, null, []],
      [4, null, []],
    ]);
    expect(repo.defaultBranch).toEqual({ name: 'main', sha: 'd0d0d0d', ciState: 'FAILURE', failingChecks: ['test'] });
  });

  it('lists PRs merged in the last 7 days, newest first, with CI on the merge commit', async () => {
    const { gh } = recordedGh(soloRoutes(GRAPHQL));
    const [repo] = (await buildProjectPrs(solo, {}, gh, [solo], NOW)).repositories;
    expect(repo.recentlyMerged.map((pr) => pr.number)).toEqual([13, 10, 11]);
    expect(repo.recentlyMerged[0]).toEqual({
      number: 13, title: 'Docs touch-up', url: 'https://github.com/acme/mono/pull/13',
      author: { login: 'octocat', avatarUrl: 'https://github.com/octocat.png' },
      headRefName: 'docs', baseRefName: 'main', mergedAt: '2026-10-04T08:00:00Z', mergedBy: 'hubot',
      mergeCommitSha: 'c13', ciState: 'FAILURE', failingChecks: ['test'], additions: 4, deletions: 1, scope: null,
    });
    expect(repo.recentlyMerged[1]).toMatchObject({ author: { login: '', avatarUrl: '' }, mergedBy: null, ciState: 'SUCCESS' });
  });

  it('a failed GraphQL read empties the CI fields without failing the repository', async () => {
    const { gh } = recordedGh(soloRoutes(Object.assign(new Error('x'), { stderr: 'gh: API rate limit already exceeded\n' })));
    const envelope = await buildProjectPrs(solo, {}, gh, [solo], NOW);
    const [repo] = envelope.repositories;
    expect(envelope.partial).toBe(false);
    expect(repo.error).toBeNull();
    expect(repo.pullRequests).toHaveLength(4);
    expect(repo.pullRequests.every((pr) => pr.ciState === null && pr.failingChecks.length === 0)).toBe(true);
    expect(repo.recentlyMerged).toEqual([]);
    expect(repo.defaultBranch).toBeNull();
  });

  it('scopes merged PRs in a shared repo like open ones, and keeps both in the files cache', async () => {
    const rush = { name: 'rush', repo: 'acme/mono', root: '/src/mono', defaultPath: '/src/mono/rush' } as ProjectDef;
    const prix = { name: 'prix', repo: 'acme/mono', root: '/src/mono', defaultPath: '/src/mono/prix' } as ProjectDef;
    const routes: Record<string, string> = {
      'repos/acme/mono': 'acme/mono\n',
      'user': 'octocat\n',
      'repos/acme/mono/pulls?state=open&per_page=100': prLine(1, 'o1'),
      graphql: GRAPHQL,
      'repos/acme/mono/pulls/1/files?per_page=100': 'rush/app.ts\n',
      'repos/acme/mono/pulls/13/files?per_page=100': 'AGENTS.md\n',
      'repos/acme/mono/pulls/11/files?per_page=100': 'prix/api.ts\n',
      'repos/acme/mono/pulls/10/files?per_page=100': 'rush/cli/main.ts\n',
    };
    const first = recordedGh(routes);
    const [repo] = (await buildProjectPrs(rush, {}, first.gh, [rush, prix], NOW)).repositories;
    expect(repo.pullRequests.map((pr) => [pr.number, pr.scope, pr.ciState])).toEqual([[1, 'project', 'FAILURE']]);
    expect(repo.recentlyMerged.map((pr) => [pr.number, pr.scope])).toEqual([[13, 'repo-wide'], [10, 'project']]);

    const second = recordedGh(routes);
    await buildProjectPrs(rush, {}, second.gh, [rush, prix], NOW);
    expect(second.asked.filter((e) => e.includes('/files'))).toEqual([]);
  });

  it('--number carries the same verdict from the REST rollup and no merged list', async () => {
    const { gh } = recordedGh({
      'repos/acme/mono': 'acme/mono\n',
      'user': 'octocat\n',
      'repos/acme/mono/pulls/1': prLine(1, 'o1'),
      'pr view 1 --repo acme/mono --json reviewDecision,headRefOid': JSON.stringify({ reviewDecision: 'APPROVED', headRefOid: 'o1' }),
      'repos/acme/mono/commits/o1/check-runs': [
        JSON.stringify({ name: 'test', status: 'COMPLETED', conclusion: 'FAILURE', link: '' }),
        JSON.stringify({ name: 'e2e', status: 'IN_PROGRESS', conclusion: '', link: '' }),
      ].join('\n'),
      'repos/acme/mono/commits/o1/status': JSON.stringify({ name: 'ci/external', state: 'SUCCESS', link: '' }),
    });
    const [repo] = (await buildProjectPrs(solo, { repo: 'acme/mono', number: 1 }, gh, [solo], NOW)).repositories;
    expect(repo.pullRequests[0]).toMatchObject({ ciState: 'FAILURE', failingChecks: ['test'], reviewDecision: 'APPROVED' });
    expect(repo.recentlyMerged).toEqual([]);
    expect(repo.defaultBranch).toBeNull();
  });

  it('reads the REST rollup with GitHub\'s precedence', () => {
    expect(ciFromRollupItems([])).toEqual({ ciState: null, failingChecks: [] });
    expect(ciFromRollupItems([{ name: 'a', status: 'COMPLETED', conclusion: 'SKIPPED' }, { name: 'b', state: 'SUCCESS' }]))
      .toEqual({ ciState: 'SUCCESS', failingChecks: [] });
    expect(ciFromRollupItems([{ name: 'a', status: 'QUEUED', conclusion: '' }])).toEqual({ ciState: 'PENDING', failingChecks: [] });
    expect(ciFromRollupItems([{ name: 'a', state: 'ERROR' }, { name: 'b', state: 'PENDING' }]))
      .toEqual({ ciState: 'ERROR', failingChecks: ['a'] });
    expect(ciFromRollupItems([{ name: 'a', state: 'ERROR' }, { name: 'b', status: 'COMPLETED', conclusion: 'ACTION_REQUIRED' }]))
      .toEqual({ ciState: 'FAILURE', failingChecks: ['a', 'b'] });
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
