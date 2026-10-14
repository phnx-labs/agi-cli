import { ghExec, canonicalizeRepo, projectRepoSlugs, type GhExec } from './pr-mergeable.js';
import {
  CiErrors,
  PR_NODE_FIELDS,
  enrichPr,
  fetchOnePr,
  fetchViewer,
  ghFailure,
  prFromNode,
  readRepoMergeAbility,
  type ProjectPr,
  type RepoMergeAbility,
} from './project-prs.js';
import { parseNdjson } from './rest.js';
import type { ProjectDef } from '../projects.js';

export type NeedsMe = 'review' | 'failing' | 'conflicts';

const NEEDS_ME_RANK: Record<NeedsMe, number> = { review: 0, failing: 1, conflicts: 2 };

export interface OpenPr extends ProjectPr {
  reviewRequested: boolean;
  needsMe: NeedsMe | null;
}

export interface OpenPrRepo {
  slug: string;
  projects: string[];
  merge: RepoMergeAbility | null;
  pullRequests: OpenPr[];
  ciError: string | null;
}

export interface OpenPrOwner {
  login: string;
  open: number;
  truncated: boolean;
  error: string | null;
}

export interface OpenPrsEnvelope {
  viewer: string | null;
  owners: OpenPrOwner[];
  reviewRequestedError: string | null;
  repositories: OpenPrRepo[];
  partial: boolean;
}

export interface OpenPrsOptions {
  owners?: string[];
  repo?: string;
  number?: number;
}

export const SEARCH_RESULT_CAP = 1000;

const SEARCH_QUERY = `query($q: String!, $endCursor: String) {
  search(query: $q, type: ISSUE, first: 100, after: $endCursor) {
    pageInfo { hasNextPage endCursor }
    nodes { ... on PullRequest { ${PR_NODE_FIELDS} } }
  }
}`;

interface SearchRow {
  slug: string;
  pr: ProjectPr;
}

async function searchOpenPrs(qualifier: string, gh: GhExec): Promise<SearchRow[]> {
  const out = await gh([
    'api', 'graphql', '--paginate',
    '-f', `q=is:pr is:open archived:false sort:updated-desc ${qualifier}`, '-f', `query=${SEARCH_QUERY}`,
    '--jq', '.data.search.nodes[] | select(.number)',
  ]);
  return parseNdjson(out).map(prFromNode);
}

export async function listViewerOwners(viewer: string | null, gh: GhExec = ghExec): Promise<string[]> {
  const orgs = (await gh(['api', 'user/orgs', '--paginate', '--cache', '1h', '--jq', '.[].login']))
    .split('\n').map((l) => l.trim()).filter(Boolean);
  return [...new Set([...(viewer ? [viewer] : []), ...orgs.sort((a, b) => a.localeCompare(b))])];
}

export function needsMeFor(pr: ProjectPr, viewer: string | null, reviewRequested: boolean): NeedsMe | null {
  if (reviewRequested) return 'review';
  if (!viewer || pr.author.login.toLowerCase() !== viewer.toLowerCase()) return null;
  if (pr.ciState === 'FAILURE' || pr.ciState === 'ERROR') return 'failing';
  if (pr.mergeableState === 'dirty') return 'conflicts';
  return null;
}

const needsRank = (pr: OpenPr) => (pr.needsMe === null ? 3 : NEEDS_ME_RANK[pr.needsMe]);

export function compareOpenPrs(a: OpenPr, b: OpenPr): number {
  return needsRank(a) - needsRank(b) || b.updatedAt.localeCompare(a.updatedAt);
}

function compareRepos(a: OpenPrRepo, b: OpenPrRepo): number {
  const best = (r: OpenPrRepo) => Math.min(3, ...r.pullRequests.map(needsRank));
  return best(a) - best(b) || a.slug.localeCompare(b.slug);
}

export const OWNER_LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/;

async function projectsBySlug(defs: readonly ProjectDef[], gh: GhExec): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  await Promise.all(defs.map(async (def) => {
    const slugs = await Promise.all(projectRepoSlugs([def]).map((s) => canonicalizeRepo(s, gh)));
    for (const slug of new Set(slugs.map((s) => s.toLowerCase()))) {
      out.set(slug, [...(out.get(slug) ?? []), def.name]);
    }
  }));
  for (const names of out.values()) names.sort((a, b) => a.localeCompare(b));
  return out;
}

function withNeeds(pr: ProjectPr, viewer: string | null, reviewRequested: boolean): OpenPr {
  return { ...pr, reviewRequested, needsMe: needsMeFor(pr, viewer, reviewRequested) };
}

export async function buildOpenPrs(
  defs: readonly ProjectDef[],
  opts: OpenPrsOptions = {},
  gh: GhExec = ghExec,
): Promise<OpenPrsEnvelope> {
  const viewer = await fetchViewer(gh);
  const projectMap = projectsBySlug(defs, gh);

  if (opts.repo !== undefined && opts.number !== undefined) {
    const slug = await canonicalizeRepo(opts.repo, gh);
    const [{ pr, reviewError }, merge, requested] = await Promise.all([
      fetchOnePr(slug, opts.number, gh).then((pr) => enrichPr(slug, pr, gh)),
      readRepoMergeAbility(slug, gh).then((m) => ({ merge: m, error: null }), (err: unknown) => ({ merge: null, error: ghFailure(err) })),
      gh(['api', `repos/${slug}/pulls/${opts.number}/requested_reviewers`, '--jq', '.users[].login'])
        .then((out) => ({ logins: out.split('\n').map((l) => l.trim().toLowerCase()).filter(Boolean), error: null }),
          (err: unknown) => ({ logins: [] as string[], error: ghFailure(err) })),
    ]);
    const reviewRequested = viewer !== null && requested.logins.includes(viewer.toLowerCase());
    return {
      viewer,
      owners: [],
      reviewRequestedError: requested.error,
      repositories: [{
        slug,
        projects: (await projectMap).get(slug.toLowerCase()) ?? [],
        merge: merge.merge,
        pullRequests: [withNeeds(pr, viewer, reviewRequested)],
        ciError: [reviewError, merge.error].filter(Boolean).join('; ') || null,
      }],
      partial: false,
    };
  }

  const bad = opts.owners?.find((o) => !OWNER_LOGIN.test(o));
  if (bad !== undefined) throw new Error(`--org expects a GitHub org or account login, got "${bad}".`);
  const ownerLogins = opts.owners?.length ? [...new Set(opts.owners)] : await listViewerOwners(viewer, gh);
  const ownerSet = new Set(ownerLogins.map((o) => o.toLowerCase()));
  const [ownerReads, requestedRead] = await Promise.all([
    Promise.all(ownerLogins.map(async (login) => {
      try {
        const rows = await searchOpenPrs(`user:${login}`, gh);
        return { owner: { login, open: rows.length, truncated: rows.length >= SEARCH_RESULT_CAP, error: null }, rows };
      } catch (err) {
        return { owner: { login, open: 0, truncated: false, error: ghFailure(err) }, rows: [] as SearchRow[] };
      }
    })),
    searchOpenPrs('review-requested:@me', gh).then(
      (rows) => ({ rows, error: null }),
      (err: unknown) => ({ rows: [] as SearchRow[], error: ghFailure(err) }),
    ),
  ]);

  const key = (slug: string, n: number) => `${slug.toLowerCase()}#${n}`;
  const requestedRows = opts.owners?.length
    ? requestedRead.rows.filter((r) => ownerSet.has(r.slug.split('/')[0].toLowerCase()))
    : requestedRead.rows;
  const requested = new Set(requestedRows.map((r) => key(r.slug, r.pr.number)));
  const bySlug = new Map<string, Map<number, ProjectPr>>();
  for (const { slug, pr } of [...ownerReads.flatMap((r) => r.rows), ...requestedRows]) {
    if (!slug) continue;
    const prs = bySlug.get(slug) ?? new Map<number, ProjectPr>();
    prs.set(pr.number, pr);
    bySlug.set(slug, prs);
  }

  const projects = await projectMap;
  const errors = new Map([...bySlug.keys()].map((slug) => [slug, new CiErrors()]));
  const merges = new Map([...bySlug.keys()].map((slug) => [slug, readRepoMergeAbility(slug, gh).catch((err: unknown) => {
    errors.get(slug)!.record(err);
    return null;
  })]));
  const repositories = await Promise.all([...bySlug.keys()].map(async (slug): Promise<OpenPrRepo> => ({
    slug,
    projects: projects.get(slug.toLowerCase()) ?? [],
    merge: await merges.get(slug)!,
    pullRequests: [...bySlug.get(slug)!.values()]
      .map((pr) => withNeeds(pr, viewer, requested.has(key(slug, pr.number))))
      .sort(compareOpenPrs),
    ciError: errors.get(slug)!.message,
  })));
  repositories.sort(compareRepos);

  const owners = ownerReads.map((r) => r.owner);
  return {
    viewer,
    owners,
    reviewRequestedError: requestedRead.error,
    repositories,
    partial: owners.some((o) => o.error !== null) || requestedRead.error !== null,
  };
}
