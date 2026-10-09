import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { buildOpenPrs } from './open-prs.js';
import type { ProjectDef } from '../projects.js';

const FIX = JSON.parse(fs.readFileSync(new URL('./testdata/open-prs.json', import.meta.url), 'utf-8')) as {
  viewer: Record<string, unknown>;
  orgs: string;
  search: Record<string, Array<Record<string, unknown>>>;
  pulls: Record<string, Record<string, unknown>>;
  checkRuns: Record<string, Record<string, unknown>>;
  settings: Record<string, unknown>;
};

const ndjson = (rows: readonly unknown[]) => rows.map((r) => JSON.stringify(r)).join('\n') + '\n';
const ghError = (stderr: string) => Object.assign(new Error('Command failed: gh api'), { stderr });

function fixtureGh(fail: Record<string, Error> = {}) {
  const asked: string[] = [];
  const gh = async (args: string[]): Promise<string> => {
    const endpoint = args[1];
    asked.push(endpoint);
    if (fail[endpoint]) throw fail[endpoint];
    if (endpoint === 'user') return JSON.stringify(FIX.viewer);
    if (endpoint === 'user/orgs') return FIX.orgs;
    if (endpoint.startsWith('search/issues?q=')) {
      const q = decodeURIComponent(endpoint.slice('search/issues?q='.length).split('&')[0]);
      return ndjson(FIX.search[q.replace('is:pr is:open archived:false ', '')] ?? []);
    }
    let m = /^repos\/([^/]+\/[^/]+)\/pulls\/(\d+)$/.exec(endpoint);
    if (m) return ndjson([FIX.pulls[`${m[1]}#${m[2]}`]]);
    m = /^repos\/[^/]+\/[^/]+\/commits\/([0-9a-f]+)\/check-runs$/.exec(endpoint);
    if (m) return ndjson([FIX.checkRuns[m[1]]]);
    if (/\/commits\/[0-9a-f]+\/status$/.test(endpoint)) return '';
    m = /^repos\/([^/]+\/[^/]+)$/.exec(endpoint);
    if (m) return args.includes('.full_name') ? `${m[1]}\n` : JSON.stringify(FIX.settings);
    throw new Error(`unexpected gh ${args.join(' ')}`);
  };
  return { gh, asked };
}

const DEFS = [{ name: 'app', repo: 'acme/app' } as ProjectDef];
const tmpCache = () => fs.mkdtempSync(path.join(os.tmpdir(), 'open-prs-'));

describe('buildOpenPrs across the viewer and their orgs', () => {
  it('reads every owner, folds in review requests from elsewhere, and puts what needs the viewer first', async () => {
    const { gh } = fixtureGh();
    const open = await buildOpenPrs(DEFS, { cacheDir: tmpCache() }, gh);

    expect(open.viewer).toBe('octo');
    expect(open.owners.map((o) => [o.login, o.open, o.error])).toEqual([['octo', 1, null], ['acme', 3, null]]);
    expect(open.repositories.map((r) => [r.slug, r.projects])).toEqual([
      ['acme/app', ['app']], ['octo/tools', []], ['other/lib', []],
    ]);
    const app = open.repositories[0].pullRequests.map((pr) => [pr.number, pr.needsMe]);
    expect(app).toEqual([[1, 'conflicts'], [2, null], [3, null]]);
    expect(open.repositories[1].pullRequests[0]).toMatchObject({ number: 5, needsMe: 'failing', ciState: 'FAILURE', failingChecks: ['test'] });
    expect(open.repositories[2].pullRequests[0]).toMatchObject({ number: 9, needsMe: 'review', reviewRequested: true, mergeableState: 'clean' });
    expect(open.partial).toBe(false);
  });

  it('a failed owner search marks the read partial and keeps every other owner', async () => {
    const q = `search/issues?q=${encodeURIComponent('is:pr is:open archived:false user:acme')}&sort=updated&order=desc&per_page=100`;
    const { gh } = fixtureGh({ [q]: ghError('gh: Server Error (HTTP 502)\n') });
    const open = await buildOpenPrs(DEFS, { cacheDir: tmpCache() }, gh);
    expect(open.partial).toBe(true);
    expect(open.owners.find((o) => o.login === 'acme')).toMatchObject({ open: 0, error: 'Server Error (HTTP 502)' });
    expect(open.repositories.map((r) => r.slug)).toEqual(['octo/tools', 'other/lib']);
  });

  it('a PR whose detail read fails keeps its search row and says why', async () => {
    const { gh } = fixtureGh({ 'repos/acme/app/pulls/3': ghError('gh: Not Found (HTTP 404)\n') });
    const open = await buildOpenPrs(DEFS, { owners: ['acme'], cacheDir: tmpCache() }, gh);
    const app = open.repositories.find((r) => r.slug === 'acme/app')!;
    expect(app.pullRequests.find((pr) => pr.number === 3)).toMatchObject({ title: 'feat: app ready', headSha: '', ciState: null });
    expect(app.ciError).toBe('Not Found (HTTP 404)');
  });

  it('--org reads only the named owners and never lists the viewer\'s orgs', async () => {
    const { gh, asked } = fixtureGh();
    const open = await buildOpenPrs(DEFS, { owners: ['acme'], cacheDir: tmpCache() }, gh);
    expect(open.owners.map((o) => o.login)).toEqual(['acme']);
    expect(asked).not.toContain('user/orgs');
  });
});
