/**
 * Contract tests for `agents projects prs`.
 *
 * The gh runner is a fake that answers the same REST/GraphQL shapes `gh` returns,
 * routed by argument semantics (repo view / pulls list / single pull / check-runs
 * / status / pr view) — the pure mapping under test, not a stub of the verdict.
 * gh `--jq` runs inside real gh, so the fake returns the ALREADY-projected NDJSON
 * a jq projection would emit, exactly as the live command receives it.
 */

import { describe, expect, it } from 'vitest';
import {
  buildProjectPrs,
  listOpenPrs,
  resolveTargetSlugs,
  type ProjectPrsEnvelope,
} from './project-prs.js';
import type { GhExec } from './pr-mergeable.js';
import type { ProjectDef } from '../projects.js';

/** A projected PR row (what `.[] | <PR_JQ>` emits), one per line as NDJSON. */
function prRow(o: Partial<Record<string, unknown>> & { number: number }): string {
  return JSON.stringify({
    number: o.number,
    title: o.title ?? `PR ${o.number}`,
    url: o.url ?? `https://github.com/o/r/pull/${o.number}`,
    isDraft: o.isDraft ?? false,
    state: o.state ?? 'OPEN',
    updatedAt: o.updatedAt ?? '2026-09-13T00:00:00Z',
    login: o.login ?? 'octocat',
    avatarUrl: o.avatarUrl ?? 'https://avatars/octocat',
    headRefName: o.headRefName ?? `feat/${o.number}`,
    baseRefName: o.baseRefName ?? 'main',
    headSha: o.headSha ?? `sha${o.number}`,
    body: o.body ?? '',
  });
}

/**
 * A fake gh routed by argument semantics. `canon` maps a raw slug to its
 * canonical nameWithOwner; `lists`/`singles` are keyed by canonical slug;
 * `checks`/`decisions` key detail enrichment; `fail` names a slug whose pulls
 * fetch throws (an auth/network failure).
 */
function fakeGh(opts: {
  canon?: Record<string, string>;
  lists?: Record<string, string[]>; // slug -> array of prRow() strings
  singles?: Record<string, string>; // "slug#n" -> prRow()
  checkRuns?: Record<string, string[]>; // slug -> NDJSON check-run rows
  statuses?: Record<string, string[]>; // slug -> NDJSON status rows
  decisions?: Record<string, { reviewDecision?: string; headRefOid?: string }>; // "slug#n"
  fail?: string;
}): GhExec {
  return async (args: string[]) => {
    if (args[0] === 'repo' && args[1] === 'view') {
      const slug = args[2];
      return (opts.canon?.[slug] ?? slug) + '\n';
    }
    if (args[0] === 'pr' && args[1] === 'view') {
      const n = args[2];
      const repo = args[args.indexOf('--repo') + 1];
      return JSON.stringify(opts.decisions?.[`${repo}#${n}`] ?? {}) + '\n';
    }
    if (args[0] === 'api') {
      const pathArg = args[1];
      const listMatch = pathArg.match(/^repos\/(.+?)\/pulls\?/);
      if (listMatch) {
        const slug = listMatch[1];
        if (opts.fail === slug) throw new Error('HTTP 401: Bad credentials');
        return (opts.lists?.[slug] ?? []).join('\n') + '\n';
      }
      const singleMatch = pathArg.match(/^repos\/(.+?)\/pulls\/(\d+)$/);
      if (singleMatch) {
        const key = `${singleMatch[1]}#${singleMatch[2]}`;
        if (opts.fail === singleMatch[1]) throw new Error('HTTP 404: Not Found');
        return (opts.singles?.[key] ?? '') + '\n';
      }
      const runsMatch = pathArg.match(/^repos\/(.+?)\/commits\/.+\/check-runs$/);
      if (runsMatch) return (opts.checkRuns?.[runsMatch[1]] ?? []).join('\n') + '\n';
      const statusMatch = pathArg.match(/^repos\/(.+?)\/commits\/.+\/status$/);
      if (statusMatch) return (opts.statuses?.[statusMatch[1]] ?? []).join('\n') + '\n';
    }
    throw new Error(`unexpected gh ${args.join(' ')}`);
  };
}

const DEF: ProjectDef = {
  name: 'rush',
  repo: 'phnx-labs/agents-cli',
  repos: [{ slug: 'phnx-labs/linear-cli' }],
  linear: { projectId: 'proj-uuid' },
} as ProjectDef;

describe('listOpenPrs', () => {
  it('maps every open PR including drafts, across pages', async () => {
    const gh = fakeGh({
      lists: { 'o/r': [prRow({ number: 1 }), prRow({ number: 2, isDraft: true, login: 'dependabot' })] },
    });
    const prs = await listOpenPrs('o/r', gh);
    expect(prs.map((p) => p.number)).toEqual([1, 2]);
    expect(prs[1].isDraft).toBe(true);
    expect(prs[1].author).toEqual({ login: 'dependabot', avatarUrl: 'https://avatars/octocat' });
    expect(prs[0].checks).toBeNull();
    expect(prs[0].reviewDecision).toBeNull();
  });
});

describe('resolveTargetSlugs', () => {
  it('canonicalizes attached slugs and dedupes', async () => {
    const gh = fakeGh({ canon: { 'phnx-labs/agents-cli': 'phnx-labs/agi-cli', 'phnx-labs/linear-cli': 'phnx-labs/linear-cli' } });
    expect(await resolveTargetSlugs(DEF, undefined, gh)).toEqual(['phnx-labs/agi-cli', 'phnx-labs/linear-cli']);
  });

  it('accepts a --repo that is an attached repo (via its renamed canonical name)', async () => {
    const gh = fakeGh({ canon: { 'phnx-labs/agents-cli': 'phnx-labs/agi-cli', 'phnx-labs/linear-cli': 'phnx-labs/linear-cli' } });
    expect(await resolveTargetSlugs(DEF, 'phnx-labs/agents-cli', gh)).toEqual(['phnx-labs/agi-cli']);
  });

  it('refuses a --repo that is not attached to the project', async () => {
    const gh = fakeGh({ canon: { 'phnx-labs/agents-cli': 'phnx-labs/agi-cli', 'phnx-labs/linear-cli': 'phnx-labs/linear-cli' } });
    await expect(resolveTargetSlugs(DEF, 'someone/else', gh)).rejects.toThrow(/not attached to project "rush"/);
  });
});

describe('buildProjectPrs', () => {
  it('lists open PRs per repo with null checks/reviewDecision, linear id carried', async () => {
    const gh = fakeGh({
      canon: { 'phnx-labs/agents-cli': 'phnx-labs/agi-cli', 'phnx-labs/linear-cli': 'phnx-labs/linear-cli' },
      lists: { 'phnx-labs/agi-cli': [prRow({ number: 10 })], 'phnx-labs/linear-cli': [] },
    });
    const env: ProjectPrsEnvelope = await buildProjectPrs(DEF, {}, gh);
    expect(env.project).toEqual({ name: 'rush', linearProjectId: 'proj-uuid' });
    expect(env.partial).toBe(false);
    expect(env.repositories).toHaveLength(2);
    expect(env.repositories[0].pullRequests[0].number).toBe(10);
    expect(env.repositories[0].pullRequests[0].checks).toBeNull();
    expect(env.repositories[1].pullRequests).toEqual([]);
    expect(env.repositories[1].error).toBeNull();
  });

  it('enriches exactly one PR with checks + reviewDecision under --repo --number', async () => {
    const gh = fakeGh({
      canon: { 'phnx-labs/agents-cli': 'phnx-labs/agi-cli', 'phnx-labs/linear-cli': 'phnx-labs/linear-cli' },
      singles: { 'phnx-labs/agi-cli#10': prRow({ number: 10, headSha: 'abc' }) },
      checkRuns: { 'phnx-labs/agi-cli': [JSON.stringify({ name: 'Tests', status: 'COMPLETED', conclusion: 'SUCCESS', link: 'x' })] },
      statuses: { 'phnx-labs/agi-cli': [] },
      decisions: { 'phnx-labs/agi-cli#10': { reviewDecision: 'APPROVED', headRefOid: 'abc' } },
    });
    const env = await buildProjectPrs(DEF, { repo: 'phnx-labs/agents-cli', number: 10 }, gh);
    expect(env.repositories).toHaveLength(1);
    const pr = env.repositories[0].pullRequests[0];
    expect(pr.checks).toEqual([{ name: 'Tests', status: 'COMPLETED', conclusion: 'SUCCESS', link: 'x' }]);
    expect(pr.reviewDecision).toBe('APPROVED');
    expect(pr.headSha).toBe('abc');
  });

  it('anchors checks to the gh-view head oid when the PR advanced since the REST read', async () => {
    const gh = fakeGh({
      canon: { 'phnx-labs/agents-cli': 'phnx-labs/agi-cli', 'phnx-labs/linear-cli': 'phnx-labs/linear-cli' },
      singles: { 'phnx-labs/agi-cli#10': prRow({ number: 10, headSha: 'stale' }) },
      // check-runs are matched by slug regardless of sha in the fake; the point is
      // the returned headSha reflects the authoritative gh-view oid, not the REST one.
      checkRuns: { 'phnx-labs/agi-cli': [] },
      statuses: { 'phnx-labs/agi-cli': [] },
      decisions: { 'phnx-labs/agi-cli#10': { reviewDecision: 'REVIEW_REQUIRED', headRefOid: 'fresh' } },
    });
    const env = await buildProjectPrs(DEF, { repo: 'phnx-labs/agents-cli', number: 10 }, gh);
    const pr = env.repositories[0].pullRequests[0];
    expect(pr.headSha).toBe('fresh');
    expect(pr.reviewDecision).toBe('REVIEW_REQUIRED');
  });

  it('reports a per-repo fetch failure as an error + partial, never as zero open', async () => {
    const gh = fakeGh({
      canon: { 'phnx-labs/agents-cli': 'phnx-labs/agi-cli', 'phnx-labs/linear-cli': 'phnx-labs/linear-cli' },
      lists: { 'phnx-labs/linear-cli': [prRow({ number: 5 })] },
      fail: 'phnx-labs/agi-cli',
    });
    const env = await buildProjectPrs(DEF, {}, gh);
    expect(env.partial).toBe(true);
    const failed = env.repositories.find((r) => r.slug === 'phnx-labs/agi-cli')!;
    expect(failed.pullRequests).toEqual([]);
    expect(failed.error).toMatch(/401/);
    const ok = env.repositories.find((r) => r.slug === 'phnx-labs/linear-cli')!;
    expect(ok.error).toBeNull();
    expect(ok.pullRequests[0].number).toBe(5);
  });

  it('returns an honest empty repositories list for a project with no repos', async () => {
    const noRepo = { name: 'empty', linear: {} } as ProjectDef;
    const env = await buildProjectPrs(noRepo, {}, fakeGh({}));
    expect(env.repositories).toEqual([]);
    expect(env.partial).toBe(false);
    expect(env.project.linearProjectId).toBeNull();
  });
});
