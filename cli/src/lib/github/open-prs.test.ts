import * as fs from 'fs';
import { describe, expect, it } from 'vitest';
import { buildOpenPrs } from './open-prs.js';
import type { ProjectDef } from '../projects.js';

const FIX = JSON.parse(fs.readFileSync(new URL('./testdata/open-prs.json', import.meta.url), 'utf-8')) as {
  viewer: Record<string, unknown>;
  orgs: string;
  search: Record<string, Array<Record<string, unknown>>>;
  settings: Record<string, unknown>;
};

const ndjson = (rows: readonly unknown[]) => rows.map((r) => JSON.stringify(r)).join('\n') + '\n';
const SEARCH_PREFIX = 'is:pr is:open archived:false sort:updated-desc ';
const ghError = (stderr: string) => Object.assign(new Error('Command failed: gh api'), { stderr });

function fixtureGh(fail: Record<string, Error> = {}) {
  const asked: string[] = [];
  const gh = async (args: string[]): Promise<string> => {
    const q = args.find((a) => a.startsWith('q='))?.slice(2);
    const endpoint = args[1] === 'graphql' && q ? `graphql ${q.replace(SEARCH_PREFIX, '')}` : args[1];
    asked.push(endpoint);
    if (fail[endpoint]) throw fail[endpoint];
    if (endpoint === 'user') return JSON.stringify(FIX.viewer);
    if (endpoint === 'user/orgs') return FIX.orgs;
    if (endpoint.startsWith('graphql ')) return ndjson(FIX.search[endpoint.slice('graphql '.length)] ?? []);
    const m = /^repos\/([^/]+\/[^/]+)$/.exec(endpoint);
    if (m) return args.includes('.full_name') ? `${m[1]}\n` : JSON.stringify(FIX.settings);
    throw new Error(`unexpected gh ${args.join(' ')}`);
  };
  return { gh, asked };
}

const DEFS = [{ name: 'app', repo: 'acme/app' } as ProjectDef];

describe('buildOpenPrs across the viewer and their orgs', () => {
  it('reads every owner, folds in review requests from elsewhere, and puts what needs the viewer first', async () => {
    const { gh } = fixtureGh();
    const open = await buildOpenPrs(DEFS, {}, gh);

    expect(open.viewer).toBe('octo');
    expect(open.owners.map((o) => [o.login, o.open, o.error])).toEqual([['octo', 1, null], ['acme', 3, null]]);
    expect(open.repositories.map((r) => [r.slug, r.projects])).toEqual([
      ['other/lib', []], ['octo/tools', []], ['acme/app', ['app']],
    ]);
    expect(open.repositories[0].pullRequests[0]).toMatchObject({ number: 9, needsMe: 'review', reviewRequested: true, mergeableState: 'clean' });
    expect(open.repositories[1].pullRequests[0]).toMatchObject({ number: 5, needsMe: 'failing', ciState: 'FAILURE', failingChecks: ['test'] });
    const app = open.repositories[2].pullRequests.map((pr) => [pr.number, pr.needsMe]);
    expect(app).toEqual([[1, 'conflicts'], [2, null], [3, null]]);
    expect(open.partial).toBe(false);
  });

  it('a failed owner search marks the read partial and keeps every other owner', async () => {
    const { gh } = fixtureGh({ 'graphql user:acme': ghError('gh: Server Error (HTTP 502)\n') });
    const open = await buildOpenPrs(DEFS, {}, gh);
    expect(open.partial).toBe(true);
    expect(open.owners.find((o) => o.login === 'acme')).toMatchObject({ open: 0, error: 'Server Error (HTTP 502)' });
    expect(open.repositories.map((r) => r.slug)).toEqual(['other/lib', 'octo/tools']);
  });

  it('reads each owner in one search that already carries merge state and checks, with no per-PR read', async () => {
    const { gh, asked } = fixtureGh();
    const open = await buildOpenPrs(DEFS, {}, gh);
    expect(asked.filter((e) => e.startsWith('graphql ')).sort()).toEqual(['graphql review-requested:@me', 'graphql user:acme', 'graphql user:octo']);
    expect(asked.some((e) => /\/pulls\/\d+$|\/commits\//.test(e))).toBe(false);
    const app = open.repositories.find((r) => r.slug === 'acme/app')!;
    expect(app.pullRequests.find((pr) => pr.number === 3)).toMatchObject({ headSha: '3'.repeat(40), mergeable: true, mergeableState: 'clean', ciState: 'SUCCESS' });
    expect(app.pullRequests.find((pr) => pr.number === 2)!.author.login).toBe('dependabot[bot]');
  });

  it('--org reads only the named owners, review requests included, and never lists the viewer\'s orgs', async () => {
    const { gh, asked } = fixtureGh();
    const open = await buildOpenPrs(DEFS, { owners: ['acme'] }, gh);
    expect(open.owners.map((o) => o.login)).toEqual(['acme']);
    expect(open.repositories.map((r) => r.slug)).toEqual(['acme/app']);
    expect(asked).not.toContain('user/orgs');
  });

  it('a failed review-request search marks the read partial, since needs-me would silently lose reviews', async () => {
    const { gh } = fixtureGh({ 'graphql review-requested:@me': ghError('gh: API rate limit exceeded (HTTP 403)\n') });
    const open = await buildOpenPrs(DEFS, {}, gh);
    expect(open.partial).toBe(true);
    expect(open.reviewRequestedError).toBe('API rate limit exceeded (HTTP 403)');
  });

  it('an --org that is not a login is refused before it can add search qualifiers', async () => {
    const { gh, asked } = fixtureGh();
    await expect(buildOpenPrs(DEFS, { owners: ['x repo:y/z'] }, gh)).rejects.toThrow(/--org expects/);
    expect(asked.some((e) => e.startsWith('graphql'))).toBe(false);
  });
});
