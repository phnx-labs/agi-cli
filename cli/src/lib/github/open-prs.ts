import { ghExec, canonicalizeRepo, projectRepoSlugs, type GhExec } from './pr-mergeable.js';
import {
  CiErrors,
  KeyedCache,
  enrichPr,
  fetchOnePr,
  fetchViewer,
  ghFailure,
  isCachedRollup,
  mapBounded,
  readCi,
  readRepoMergeAbility,
  rowToProjectPr,
  type CachedRollup,
  type CiReader,
  type ProjectPr,
  type RepoMergeAbility,
} from './project-prs.js';
import type { ProjectDef } from '../projects.js';
import { getCacheDir } from '../state.js';

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
  cacheDir?: string;
  nowMs?: number;
}

export const SEARCH_RESULT_CAP = 1000;

const SEARCH_JQ =
  '.items[] | {number, title, url: .html_url, isDraft: (.draft // false), ' +
  'state: (.state // "" | ascii_upcase), createdAt: (.created_at // ""), updatedAt: (.updated_at // ""), ' +
  'login: (.user.login // ""), avatarUrl: (.user.avatar_url // ""), ' +
  'slug: (.repository_url // "" | sub("^.*/repos/"; ""))}';

interface SearchRow {
  slug: string;
  pr: ProjectPr;
}

function parseNdjson(out: string): Array<Record<string, unknown>> {
  return out.split('\n').map((l) => l.trim()).filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);
}

async function searchOpenPrs(qualifier: string, gh: GhExec): Promise<SearchRow[]> {
  const q = encodeURIComponent(`is:pr is:open archived:false ${qualifier}`);
  const out = await gh([
    'api', `search/issues?q=${q}&sort=updated&order=desc&per_page=100`, '--paginate', '--cache', '60s', '--jq', SEARCH_JQ,
  ]);
  return parseNdjson(out).map((row) => ({ slug: String(row.slug ?? ''), pr: rowToProjectPr(row) }));
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

export function compareOpenPrs(a: OpenPr, b: OpenPr): number {
  const ra = a.needsMe === null ? 3 : NEEDS_ME_RANK[a.needsMe];
  const rb = b.needsMe === null ? 3 : NEEDS_ME_RANK[b.needsMe];
  return ra - rb || b.updatedAt.localeCompare(a.updatedAt);
}

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

  const ownerLogins = opts.owners?.length ? [...new Set(opts.owners)] : await listViewerOwners(viewer, gh);
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
  const requested = new Set(requestedRead.rows.map((r) => key(r.slug, r.pr.number)));
  const bySlug = new Map<string, Map<number, ProjectPr>>();
  for (const { slug, pr } of [...ownerReads.flatMap((r) => r.rows), ...requestedRead.rows]) {
    if (!slug) continue;
    const prs = bySlug.get(slug) ?? new Map<number, ProjectPr>();
    prs.set(pr.number, pr);
    bySlug.set(slug, prs);
  }

  const cacheDir = opts.cacheDir ?? getCacheDir();
  const rollups = new KeyedCache<CachedRollup>(cacheDir, 'project-pr-ci.json', '@', isCachedRollup);
  const nowMs = opts.nowMs ?? Date.now();
  const projects = await projectMap;

  const slugs = [...bySlug.keys()].sort((a, b) => a.localeCompare(b));
  const repositories = await Promise.all(slugs.map(async (slug): Promise<OpenPrRepo> => {
    const errors = new CiErrors();
    const ci: CiReader = { slug, gh, rollups, errors, nowMs, reads: new Map() };
    const mergeRead = readRepoMergeAbility(slug, gh).catch((err: unknown) => {
      errors.record(err);
      return null;
    });
    const pullRequests = await mapBounded([...bySlug.get(slug)!.values()], 8, async (listed): Promise<OpenPr> => {
      let pr = listed;
      try {
        pr = await fetchOnePr(slug, listed.number, gh, '60s');
      } catch (err) {
        errors.record(err);
      }
      const ciSummary = await readCi(ci, pr.headSha || null);
      return withNeeds({ ...pr, ...ciSummary }, viewer, requested.has(key(slug, pr.number)));
    });
    return {
      slug,
      projects: projects.get(slug.toLowerCase()) ?? [],
      merge: await mergeRead,
      pullRequests: pullRequests.sort(compareOpenPrs),
      ciError: errors.message,
    };
  }));
  rollups.save();

  const owners = ownerReads.map((r) => r.owner);
  return {
    viewer,
    owners,
    reviewRequestedError: requestedRead.error,
    repositories,
    partial: owners.some((o) => o.error !== null),
  };
}
