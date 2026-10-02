import { describe, expect, it } from 'vitest';
import { buildProjectPrs, mergeProjectPr, rowToProjectPr, scopeForFiles } from './project-prs.js';
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
