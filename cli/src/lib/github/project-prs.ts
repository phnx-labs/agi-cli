/**
 * `agents projects prs <PROJECT>` — every OPEN pull request across a project's
 * attached repositories, as one machine-readable envelope for AGI Menu.
 *
 * Why this exists: `agents projects status`'s `openPrs` only carries the PRs the
 * fleet's own SESSIONS opened (the session rollup), so a project's board of open
 * PRs — drafts, other people's PRs, anything not tied to a live session — is
 * invisible to it. This reads the truth straight from GitHub.
 *
 * Design constraints (see docs conventions + the contract in
 * `.agents/scratch/contracts-status.json`):
 *   - Repos come ONLY from the ProjectDef's own attached slugs
 *     ({@link projectRepoSlugs}); `--repo` is refused unless it is one of them.
 *   - The list is REST + paginated (`gh api repos/{repo}/pulls?state=open
 *     --paginate`), includes drafts, and applies NO author filter — it is the
 *     whole open board, not this user's mergeable set. REST is the budget the
 *     fleet's GraphQL poll loops do not drain (PHNX-3501).
 *   - `checks` / `reviewDecision` are null in the list; `--number N` enriches
 *     exactly that one PR against its live head SHA (checks via REST
 *     {@link rollupForSha}, reviewDecision via a single lazy `gh pr view`).
 *   - The at-a-glance CI verdict (`ciState` + `failingChecks`) on every open PR,
 *     the PRs merged in the last 7 days, and the default branch's own CI come
 *     from ONE GraphQL read per repository per run ({@link fetchRepoCi}). The
 *     REST equivalent is a check-runs read plus a status read PER PR and per
 *     merge commit, which costs far more than the one query it replaces. A failed
 *     query degrades those fields to null/empty; it never fails the repository.
 *   - A per-repo fetch failure is reported as `repositories[].error` and flips
 *     `partial` — it is NEVER relabeled as "zero open PRs".
 */

import * as fs from 'fs';
import * as path from 'path';
import { ghExec, canonicalizeRepo, projectRepoSlugs, type GhExec } from './pr-mergeable.js';
import { prHead, rollupForSha, type RollupItem } from './rest.js';
import { repoPathClaims, type ProjectDef } from '../projects.js';
import { getCacheDir } from '../state.js';
import { atomicWriteFileSync } from '../fs-atomic.js';

/** The author of a PR, as the menu renders it (login + avatar). */
export interface ProjectPrAuthor {
  login: string;
  avatarUrl: string;
}

/**
 * Where a PR sits for a project whose repository is SHARED with another project
 * (a monorepo): `project` touches the paths this project claims, `repo-wide`
 * touches no sharing project's paths (root config, CI, docs). A PR that touches
 * only another project's paths is not listed at all. Null when the repository is
 * not shared, or this project claims all of it. Claims are {@link repoPathClaims},
 * the same ownership that attributes a session's cwd.
 */
export type ProjectPrScope = 'project' | 'repo-wide';

/** GitHub's `StatusState` for a commit's combined check rollup. */
export type CiState = 'SUCCESS' | 'FAILURE' | 'PENDING' | 'ERROR' | 'EXPECTED';

/** One open PR row. `checks`/`reviewDecision`/merge state are null unless the PR was enriched. */
export interface ProjectPr {
  number: number;
  title: string;
  url: string;
  isDraft: boolean;
  /** Upper-cased GitHub state — always `OPEN` here (only open PRs are listed). */
  state: string;
  createdAt: string;
  updatedAt: string;
  author: ProjectPrAuthor;
  headRefName: string;
  baseRefName: string;
  headSha: string;
  body: string;
  scope: ProjectPrScope | null;
  /** Populated only for the `--number` PR: GitHub's mergeability (null while it computes). */
  mergeable: boolean | null;
  /** Populated only for the `--number` PR: `clean` | `unstable` | `blocked` | `behind` | `dirty` | `draft` | `unknown` … */
  mergeableState: string | null;
  /** Populated only for the `--number` PR: the head-SHA status-check rollup. */
  checks: RollupItem[] | null;
  /** Populated only for the `--number` PR: GitHub's computed review decision. */
  reviewDecision: string | null;
  /** The head commit's combined CI verdict; null when it has no checks or the CI read failed. */
  ciState: CiState | null;
  /** Names of the head commit's failing, errored, timed-out, cancelled or action-required checks. */
  failingChecks: string[];
}

/** One PR merged into the repository in the last {@link MERGED_WINDOW_DAYS} days. */
export interface MergedPr {
  number: number;
  title: string;
  url: string;
  author: ProjectPrAuthor;
  headRefName: string;
  baseRefName: string;
  mergedAt: string;
  /** Login of whoever merged it; null when GitHub does not say (a deleted account). */
  mergedBy: string | null;
  mergeCommitSha: string | null;
  /** CI on the MERGE commit: the base branch right after this PR landed. */
  ciState: CiState | null;
  failingChecks: string[];
  additions: number;
  deletions: number;
  scope: ProjectPrScope | null;
}

/** The repository's default branch head and its CI. */
export interface DefaultBranchCi {
  name: string;
  sha: string;
  ciState: CiState | null;
  failingChecks: string[];
}

/** One repository's open PRs, or the error that stopped its fetch. */
export interface ProjectRepoPrs {
  slug: string;
  /** Other project definitions attached to this same repository. */
  sharedWith: string[];
  pullRequests: ProjectPr[];
  /** PRs merged in the last 7 days, newest first, at most 20; [] with `--number`. */
  recentlyMerged: MergedPr[];
  /** The default branch head and its CI; null with `--number` or when the CI read failed. */
  defaultBranch: DefaultBranchCi | null;
  /** Non-null when the fetch failed — the list is then NOT authoritative. */
  error: string | null;
}

/** The full `projects prs --json` envelope. */
export interface ProjectPrsEnvelope {
  project: { name: string; linearProjectId: string | null };
  /** The authenticated GitHub login — what a "mine" filter compares `author.login` to. */
  viewer: string | null;
  repositories: ProjectRepoPrs[];
  /** True when at least one repository fetch failed (its list is incomplete). */
  partial: boolean;
}

/** Options for one `projects prs` run. `number` requires `repo`. */
export interface ProjectPrsOptions {
  /** Restrict to one attached repo (canonicalized, membership-checked). */
  repo?: string;
  /** Lazy detail: enrich exactly this PR's checks + reviewDecision. */
  number?: number;
}

/** The jq projection that flattens a REST PR object into {@link ProjectPr}'s scalars. */
const PR_JQ =
  '{number, title, url: .html_url, isDraft: (.draft // false), ' +
  'state: (.state // "" | ascii_upcase), createdAt: (.created_at // ""), updatedAt: (.updated_at // ""), ' +
  'login: (.user.login // ""), avatarUrl: (.user.avatar_url // ""), ' +
  'headRefName: (.head.ref // ""), baseRefName: (.base.ref // ""), ' +
  'headSha: (.head.sha // ""), body: (.body // ""), ' +
  'mergeable: .mergeable, mergeableState: .mergeable_state}';

/** Parse newline-delimited JSON (gh `--jq` streams one object per line/page). */
function parseNdjson(out: string): Array<Record<string, unknown>> {
  const rows: Array<Record<string, unknown>> = [];
  for (const line of out.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    rows.push(JSON.parse(t) as Record<string, unknown>);
  }
  return rows;
}

/** Build a {@link ProjectPr} from the flattened jq row. checks/reviewDecision start null. */
export function rowToProjectPr(row: Record<string, unknown>): ProjectPr {
  return {
    number: Number(row.number),
    title: String(row.title ?? ''),
    url: String(row.url ?? ''),
    isDraft: Boolean(row.isDraft),
    state: String(row.state ?? ''),
    createdAt: String(row.createdAt ?? ''),
    updatedAt: String(row.updatedAt ?? ''),
    author: { login: String(row.login ?? ''), avatarUrl: String(row.avatarUrl ?? '') },
    headRefName: String(row.headRefName ?? ''),
    baseRefName: String(row.baseRefName ?? ''),
    headSha: String(row.headSha ?? ''),
    body: String(row.body ?? ''),
    scope: null,
    mergeable: typeof row.mergeable === 'boolean' ? row.mergeable : null,
    mergeableState: typeof row.mergeableState === 'string' ? row.mergeableState : null,
    checks: null,
    reviewDecision: null,
    ciState: null,
    failingChecks: [],
  };
}

/**
 * Every OPEN PR for one repo, over REST, fully paginated, drafts included, no
 * author filter. `--paginate` follows Link headers; `--jq` streams one flattened
 * object per line so a multi-page result stays parseable.
 */
export async function listOpenPrs(repo: string, gh: GhExec = ghExec): Promise<ProjectPr[]> {
  const out = await gh([
    'api',
    `repos/${repo}/pulls?state=open&per_page=100`,
    '--paginate',
    '--jq',
    `.[] | ${PR_JQ}`,
  ]);
  return parseNdjson(out).map(rowToProjectPr);
}

/** One PR by number, over REST (`GET repos/{repo}/pulls/{n}`). Throws if it is gone. */
export async function fetchOnePr(repo: string, number: number, gh: GhExec = ghExec): Promise<ProjectPr> {
  const out = await gh(['api', `repos/${repo}/pulls/${number}`, '--jq', PR_JQ]);
  const rows = parseNdjson(out);
  if (rows.length === 0) throw new Error(`no PR ${repo}#${number}`);
  return rowToProjectPr(rows[0]);
}

/**
 * GitHub's computed review decision AND the PR's current head oid, from ONE lazy
 * `gh pr view` (GraphQL). reviewDecision is deliberately NOT REST-derived: it is
 * a branch-protection / CODEOWNERS decision REST cannot compute, and
 * approximating it could mislead a merge decision (PHNX-3501 note). `headRefOid`
 * rides the same call so the checks and the review verdict can be anchored to the
 * SAME head — a PR that advanced between the REST read and this call would
 * otherwise pair a stale check rollup with a current review. One call per
 * `--number`, never a poll loop, so it does not drain the shared GraphQL budget.
 */
export async function fetchReviewAndHead(
  repo: string,
  number: number,
  gh: GhExec = ghExec,
): Promise<{ reviewDecision: string | null; headRefOid: string | null }> {
  const out = (await gh([
    'pr', 'view', String(number), '--repo', repo, '--json', 'reviewDecision,headRefOid',
  ])).trim();
  const parsed = out ? (JSON.parse(out) as { reviewDecision?: string; headRefOid?: string }) : {};
  return {
    reviewDecision: parsed.reviewDecision || null,
    headRefOid: parsed.headRefOid || null,
  };
}

/**
 * Enrich one PR with its checks + reviewDecision, both anchored to the SAME head.
 * `gh pr view` gives the authoritative current head oid; the check rollup is run
 * against THAT (not the possibly-staler REST head SHA), and `headSha` is updated
 * to match, so checks and reviewDecision can never describe two different heads.
 */
export async function enrichPr(repo: string, pr: ProjectPr, gh: GhExec = ghExec): Promise<ProjectPr> {
  const { reviewDecision, headRefOid } = await fetchReviewAndHead(repo, pr.number, gh);
  const head = headRefOid || pr.headSha;
  const checks = await rollupForSha(repo, head, gh);
  return { ...pr, headSha: head, checks, reviewDecision, ...ciFromRollupItems(checks) };
}

/** How far back `recentlyMerged` reaches, and how many rows it keeps after scoping. */
export const MERGED_WINDOW_DAYS = 7;
export const MERGED_LIMIT = 20;

/** Check-run conclusions and status-context states that count as a failing check. */
const FAILING_CONCLUSIONS = new Set(['FAILURE', 'TIMED_OUT', 'CANCELLED', 'ACTION_REQUIRED', 'STARTUP_FAILURE']);
const FAILING_STATES = new Set(['FAILURE', 'ERROR']);
const CI_STATES = new Set<string>(['SUCCESS', 'FAILURE', 'PENDING', 'ERROR', 'EXPECTED']);

/** What a menu row renders: the rollup state, plus the names to show when it is red. */
export interface CiSummary {
  ciState: CiState | null;
  failingChecks: string[];
}

const NO_CI: CiSummary = { ciState: null, failingChecks: [] };

interface GraphRollupNode {
  __typename?: string;
  name?: string;
  conclusion?: string | null;
  status?: string;
  context?: string;
  state?: string;
}
type GraphRollup = { state?: string; contexts?: { nodes?: Array<GraphRollupNode | null> } } | null | undefined;

/** Summarize one GraphQL `statusCheckRollup`. A commit GitHub gives no rollup has no checks: null. */
export function ciFromGraphRollup(rollup: GraphRollup): CiSummary {
  if (!rollup?.state || !CI_STATES.has(rollup.state)) return NO_CI;
  const failing: string[] = [];
  for (const node of rollup.contexts?.nodes ?? []) {
    if (!node) continue;
    const isStatus = node.__typename === 'StatusContext';
    const name = isStatus ? node.context : node.name;
    const bad = isStatus ? FAILING_STATES.has(node.state ?? '') : FAILING_CONCLUSIONS.has(node.conclusion ?? '');
    if (bad && name && !failing.includes(name)) failing.push(name);
  }
  return { ciState: rollup.state as CiState, failingChecks: failing };
}

/**
 * Summarize the REST rollup the `--number` path already reads, with GitHub's own
 * precedence: any failing check makes it red even while others still run, and it
 * is `ERROR` only when errored statuses are the only red.
 */
export function ciFromRollupItems(items: readonly RollupItem[]): CiSummary {
  if (items.length === 0) return NO_CI;
  const failing: string[] = [];
  let failed = false;
  let pending = false;
  for (const item of items) {
    const isCheckRun = item.state === undefined;
    if (isCheckRun ? FAILING_CONCLUSIONS.has(item.conclusion ?? '') : FAILING_STATES.has(item.state ?? '')) {
      failing.push(item.name);
      if (isCheckRun || item.state === 'FAILURE') failed = true;
    } else if (isCheckRun ? item.status !== 'COMPLETED' : item.state === 'PENDING') {
      pending = true;
    }
  }
  if (failing.length > 0) return { ciState: failed ? 'FAILURE' : 'ERROR', failingChecks: failing };
  return { ciState: pending ? 'PENDING' : 'SUCCESS', failingChecks: [] };
}

const ROLLUP_FIELDS =
  'statusCheckRollup { state contexts(first: 50) { nodes { __typename ' +
  '... on CheckRun { name conclusion status } ... on StatusContext { context state } } } }';

/** The one query behind every CI field and `recentlyMerged`. */
const REPO_CI_QUERY =
  'query($owner: String!, $name: String!) { repository(owner: $owner, name: $name) { ' +
  `defaultBranchRef { name target { ... on Commit { oid ${ROLLUP_FIELDS} } } } ` +
  'open: pullRequests(states: OPEN, first: 100, orderBy: {field: UPDATED_AT, direction: DESC}) { ' +
  `nodes { number commits(last: 1) { nodes { commit { ${ROLLUP_FIELDS} } } } } } ` +
  'merged: pullRequests(states: MERGED, first: 30, orderBy: {field: UPDATED_AT, direction: DESC}) { ' +
  'nodes { number title url author { login avatarUrl } headRefName baseRefName headRefOid ' +
  `mergedAt mergedBy { login } additions deletions mergeCommit { oid ${ROLLUP_FIELDS} } } } } }`;

interface GraphMergedNode {
  number: number;
  title?: string;
  url?: string;
  author?: { login?: string; avatarUrl?: string } | null;
  headRefName?: string;
  baseRefName?: string;
  headRefOid?: string;
  mergedAt?: string | null;
  mergedBy?: { login?: string } | null;
  additions?: number;
  deletions?: number;
  mergeCommit?: { oid?: string; statusCheckRollup?: GraphRollup } | null;
}

interface GraphRepository {
  defaultBranchRef?: { name?: string; target?: { oid?: string; statusCheckRollup?: GraphRollup } | null } | null;
  open?: { nodes?: Array<{ number: number; commits?: { nodes?: Array<{ commit?: { statusCheckRollup?: GraphRollup } } | null> } } | null> };
  merged?: { nodes?: Array<GraphMergedNode | null> };
}

/** What {@link fetchRepoCi} reads for one repository. */
export interface RepoCi {
  /** Open PR number → its head commit's CI. */
  openCi: Map<number, CiSummary>;
  /** Merged PRs inside the window, newest `mergedAt` first, with the head SHA their file list is keyed by. */
  merged: Array<{ pr: MergedPr; headSha: string }>;
  defaultBranch: DefaultBranchCi | null;
}

/**
 * Read open-PR CI, recently merged PRs, and the default branch's CI for one
 * repository in ONE GraphQL request; throws on any failure so the caller can
 * degrade. Merged PRs arrive most-recently-updated first, are kept only when
 * `mergedAt` falls inside the last {@link MERGED_WINDOW_DAYS} days, and are then
 * ordered by `mergedAt`.
 */
export async function fetchRepoCi(repo: string, nowMs: number, gh: GhExec = ghExec): Promise<RepoCi> {
  const [owner, name] = repo.split('/');
  const out = await gh(['api', 'graphql', '-f', `query=${REPO_CI_QUERY}`, '-f', `owner=${owner}`, '-f', `name=${name}`]);
  const repository = (JSON.parse(out) as { data?: { repository?: GraphRepository | null } }).data?.repository;
  if (!repository) throw new Error(`GitHub returned no repository for ${repo}`);

  const openCi = new Map<number, CiSummary>();
  for (const node of repository.open?.nodes ?? []) {
    if (node) openCi.set(Number(node.number), ciFromGraphRollup(node.commits?.nodes?.[0]?.commit?.statusCheckRollup));
  }

  const since = nowMs - MERGED_WINDOW_DAYS * 24 * 60 * 60 * 1000;
  const merged: RepoCi['merged'] = [];
  for (const node of repository.merged?.nodes ?? []) {
    if (!node?.mergedAt || Date.parse(node.mergedAt) < since) continue;
    merged.push({
      headSha: String(node.headRefOid ?? ''),
      pr: {
        number: Number(node.number),
        title: String(node.title ?? ''),
        url: String(node.url ?? ''),
        author: { login: String(node.author?.login ?? ''), avatarUrl: String(node.author?.avatarUrl ?? '') },
        headRefName: String(node.headRefName ?? ''),
        baseRefName: String(node.baseRefName ?? ''),
        mergedAt: node.mergedAt,
        mergedBy: node.mergedBy?.login || null,
        mergeCommitSha: node.mergeCommit?.oid || null,
        ...ciFromGraphRollup(node.mergeCommit?.statusCheckRollup),
        additions: Number(node.additions ?? 0),
        deletions: Number(node.deletions ?? 0),
        scope: null,
      },
    });
  }
  merged.sort((a, b) => Date.parse(b.pr.mergedAt) - Date.parse(a.pr.mergedAt));

  const ref = repository.defaultBranchRef;
  const defaultBranch: DefaultBranchCi | null = ref?.name && ref.target?.oid
    ? { name: ref.name, sha: ref.target.oid, ...ciFromGraphRollup(ref.target.statusCheckRollup) }
    : null;
  return { openCi, merged, defaultBranch };
}

/**
 * Resolve which repositories a run targets, restricted to the project's own
 * attached repos. Slugs are canonicalized (a renamed repo lists nothing under
 * its old name — `phnx-labs/agents-cli` → `phnx-labs/agi-cli`). A `--repo` that
 * is not one of the project's attached repos (raw or canonical) is refused.
 */
export async function resolveTargetSlugs(
  def: ProjectDef,
  repo: string | undefined,
  gh: GhExec,
): Promise<string[]> {
  const raw = projectRepoSlugs([def]);
  // Canonicalize CONCURRENTLY — each repo read can take up to gh's 30s
  // timeout, so a sequential walk of N repos would stack N×30s and blow past a
  // native caller's bounded deadline. Repo count per project is small.
  const canonPairs = await Promise.all(raw.map(async (slug) => [slug, await canonicalizeRepo(slug, gh)] as const));
  const canon = new Map<string, string>(canonPairs);
  const canonical = [...new Set(canon.values())];
  if (!repo) return canonical;

  const requested = await canonicalizeRepo(repo, gh);
  const attached =
    raw.includes(repo) ||
    canonical.includes(requested) ||
    [...canon.keys()].some((k) => k === repo);
  if (!attached) {
    const list = raw.length ? raw.join(', ') : '(none)';
    throw new Error(
      `Repo "${repo}" is not attached to project "${def.name}". Attached repos: ${list}.`,
    );
  }
  return [requested];
}

/**
 * Classify one PR of a shared repository by the files it changes. `own` are
 * this project's prefixes, `others` every other sharing project's. Returns
 * null when the PR belongs only to another project.
 */
export function scopeForFiles(files: readonly string[], own: readonly string[], others: readonly string[]): ProjectPrScope | null {
  const under = (prefixes: readonly string[]) => files.some((f) => prefixes.some((p) => f.startsWith(p)));
  if (under(own)) return 'project';
  if (under(others)) return null;
  return 'repo-wide';
}

/**
 * The files a PR changes, keyed by its head SHA. The list for a given head is
 * immutable, so a cached entry never goes stale; a push mints a new key. Open and
 * recently merged PRs share one key space (a PR that merges keeps its entry), and
 * pruning keeps every head the run listed, open or merged, so neither list evicts
 * the other's entries.
 */
class PrFilesCache {
  private readonly file = path.join(getCacheDir(), 'project-pr-files.json');
  private entries: Record<string, string[]> = {};
  private dirty = false;

  constructor() {
    // A missing or unreadable cache only costs re-reads; it never fails a list.
    try {
      const parsed: unknown = JSON.parse(fs.readFileSync(this.file, 'utf-8'));
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) this.entries = parsed as Record<string, string[]>;
    } catch {
      this.entries = {};
    }
  }

  async files(slug: string, pr: { number: number; headSha: string }, gh: GhExec): Promise<string[]> {
    const key = `${slug}@${pr.headSha}`;
    const hit = this.entries[key];
    if (hit) return hit;
    // A rename counts on both sides: moving a file out of a project's path touches that project.
    const out = await gh(['api', `repos/${slug}/pulls/${pr.number}/files?per_page=100`, '--paginate', '--jq', '.[] | .filename, (.previous_filename // empty)']);
    const files = out.split('\n').map((l) => l.trim()).filter(Boolean);
    this.entries[key] = files;
    this.dirty = true;
    return files;
  }

  prune(slug: string, listedHeads: ReadonlySet<string>): void {
    for (const key of Object.keys(this.entries)) {
      const at = key.lastIndexOf('@');
      if (key.slice(0, at) === slug && !listedHeads.has(key.slice(at + 1))) {
        delete this.entries[key];
        this.dirty = true;
      }
    }
  }

  save(): void {
    if (!this.dirty) return;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    atomicWriteFileSync(this.file, JSON.stringify(this.entries));
  }
}

/** Run `fn` over `items` with at most `limit` in flight, preserving order. */
async function mapBounded<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

/** The authenticated login, from a REST read gh caches for a day. */
export async function fetchViewer(gh: GhExec = ghExec): Promise<string | null> {
  try {
    return (await gh(['api', 'user', '--cache', '24h', '--jq', '.login'])).trim() || null;
  } catch {
    return null;
  }
}

/**
 * The repository paths `def` claims, keyed by canonical slug. Canonicalization
 * is cached, so this costs no network after the first run of the day.
 */
async function canonicalClaims(def: ProjectDef, gh: GhExec): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  for (const { slug, prefix } of repoPathClaims(def)) {
    const canonical = await canonicalizeRepo(slug, gh);
    out.set(canonical, [...(out.get(canonical) ?? []), prefix]);
  }
  return out;
}

/** For each canonical slug, the other projects attached to it and the paths they claim. */
async function repoPeers(
  def: ProjectDef,
  peers: readonly ProjectDef[],
  gh: GhExec,
): Promise<Map<string, { names: string[]; prefixes: string[] }>> {
  const bySlug = new Map<string, { names: string[]; prefixes: string[] }>();
  await Promise.all(peers.filter((p) => p.name !== def.name).map(async (peer) => {
    const [slugs, claims] = await Promise.all([
      Promise.all(projectRepoSlugs([peer]).map((s) => canonicalizeRepo(s, gh))),
      canonicalClaims(peer, gh),
    ]);
    for (const slug of new Set(slugs)) {
      const entry = bySlug.get(slug) ?? { names: [], prefixes: [] };
      entry.names.push(peer.name);
      entry.prefixes.push(...(claims.get(slug) ?? []));
      bySlug.set(slug, entry);
    }
  }));
  for (const entry of bySlug.values()) entry.names.sort();
  return bySlug;
}

/**
 * Build the full envelope. `number` (which the command requires alongside
 * `repo`) fetches and enriches exactly that one PR; otherwise every target
 * repo's open PRs are listed with checks/reviewDecision left null.
 *
 * `peers` are every project definition. A repository attached to more than one
 * project is scoped: when this project claims part of it ({@link repoPathClaims}),
 * its open AND recently merged lists keep only PRs that touch those paths
 * (`scope: project`) or touch no sharing project's paths (`scope: repo-wide`).
 * `nowMs` anchors the merged window.
 */
export async function buildProjectPrs(
  def: ProjectDef,
  opts: ProjectPrsOptions = {},
  gh: GhExec = ghExec,
  peers: readonly ProjectDef[] = [],
  nowMs: number = Date.now(),
): Promise<ProjectPrsEnvelope> {
  const project = { name: def.name, linearProjectId: def.linear?.projectId ?? null };
  const slugs = await resolveTargetSlugs(def, opts.repo, gh);
  if (slugs.length === 0) return { project, viewer: null, repositories: [], partial: false };
  const viewerRead = fetchViewer(gh);
  const [shared, ownClaims] = await Promise.all([repoPeers(def, peers, gh), canonicalClaims(def, gh)]);
  const filesCache = new PrFilesCache();

  // Fetch repos in PARALLEL so a native caller's overall deadline scales with the
  // slowest repo, not the sum — a serial multi-repo walk of 30s gh calls can blow
  // past a bounded caller timeout and lose the whole result. Repo count is small
  // (a project's attached repos), so this is a bounded fan-out, not unbounded.
  const repositories: ProjectRepoPrs[] = await Promise.all(
    slugs.map(async (slug): Promise<ProjectRepoPrs> => {
      const peer = shared.get(slug);
      const sharedWith = peer?.names ?? [];
      try {
        if (opts.number !== undefined) {
          const pr = await fetchOnePr(slug, opts.number, gh);
          return { slug, sharedWith, pullRequests: [await enrichPr(slug, pr, gh)], recentlyMerged: [], defaultBranch: null, error: null };
        }
        const [listed, ci] = await Promise.all([
          listOpenPrs(slug, gh),
          // CI is a glance aid: a failed read empties those fields, it never fails the repository.
          fetchRepoCi(slug, nowMs, gh).catch((): RepoCi => ({ openCi: new Map(), merged: [], defaultBranch: null })),
        ]);
        let pullRequests: ProjectPr[] = listed.map((pr) => ({ ...pr, ...(ci.openCi.get(pr.number) ?? NO_CI) }));
        let recentlyMerged = ci.merged.map((m) => m.pr);
        const own = ownClaims.get(slug);
        if (peer && own) {
          filesCache.prune(slug, new Set([...listed.map((pr) => pr.headSha), ...ci.merged.map((m) => m.headSha)]));
          const scopeOf = async (pr: { number: number; headSha: string }) =>
            scopeForFiles(await filesCache.files(slug, pr, gh), own, peer.prefixes);
          const [openScopes, mergedScopes] = await Promise.all([
            mapBounded(pullRequests, 8, scopeOf),
            mapBounded(ci.merged, 8, (m) => scopeOf({ number: m.pr.number, headSha: m.headSha })),
          ]);
          pullRequests = pullRequests
            .map((pr, i) => ({ ...pr, scope: openScopes[i] }))
            .filter((pr) => pr.scope !== null);
          recentlyMerged = recentlyMerged
            .map((pr, i) => ({ ...pr, scope: mergedScopes[i] }))
            .filter((pr) => pr.scope !== null);
        }
        return {
          slug, sharedWith, pullRequests,
          recentlyMerged: recentlyMerged.slice(0, MERGED_LIMIT),
          defaultBranch: ci.defaultBranch,
          error: null,
        };
      } catch (err) {
        // A fetch failure is reported, never relabeled as zero open PRs.
        return {
          slug, sharedWith, pullRequests: [], recentlyMerged: [], defaultBranch: null,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    }),
  );
  filesCache.save();

  const partial = repositories.some((r) => r.error !== null);
  return { project, viewer: await viewerRead, repositories, partial };
}

/** How a PR is merged; the default is the first of these the repository allows. */
export const MERGE_METHODS = ['rebase', 'squash', 'merge'] as const;
export type MergeMethod = (typeof MERGE_METHODS)[number];

/** The result of one `projects prs merge`. */
export interface ProjectPrMergeResult {
  repo: string;
  number: number;
  method: MergeMethod;
  merged: boolean;
  /** The merge commit SHA GitHub reports. */
  sha: string | null;
  message: string;
}

/** The first of {@link MERGE_METHODS} the repository allows. */
export async function defaultMergeMethod(repo: string, gh: GhExec = ghExec): Promise<MergeMethod> {
  const allowed = JSON.parse((await gh([
    'api', `repos/${repo}`, '--cache', '1h',
    '--jq', '{rebase: .allow_rebase_merge, squash: .allow_squash_merge, merge: .allow_merge_commit}',
  ])).trim()) as Record<MergeMethod, boolean | undefined>;
  const method = MERGE_METHODS.find((m) => allowed[m]);
  if (!method) throw new Error(`${repo} allows no merge method this token can see.`);
  return method;
}

/**
 * gh prints GitHub's refusal on stderr (`gh: Required status check … (HTTP 405)`),
 * sometimes followed by a hint line (a 401 adds `try authenticating with: gh auth
 * login`). Keep the line carrying the HTTP status, else the first line.
 */
function ghFailure(err: unknown): string {
  const stderr = (err as { stderr?: unknown })?.stderr;
  const text = typeof stderr === 'string' && stderr.trim() ? stderr : err instanceof Error ? err.message : String(err);
  const lines = text.trim().split('\n').map((l) => l.trim()).filter(Boolean);
  const line = lines.find((l) => /\(HTTP \d{3}\)/.test(l)) ?? lines[0] ?? text;
  return line.replace(/^gh:\s*/, '');
}

/**
 * Merge one PR over REST (`PUT repos/{repo}/pulls/{n}/merge`), pinned to `sha`:
 * GitHub refuses with 409 when the head moved since the caller looked, so a push
 * that landed after the menu rendered is never merged unseen. Branch protection,
 * required checks and reviews are GitHub's to enforce; their refusal comes back
 * as `merged: false` with GitHub's own message.
 */
export async function mergeProjectPr(
  repo: string,
  number: number,
  sha: string,
  method: MergeMethod | undefined,
  gh: GhExec = ghExec,
): Promise<ProjectPrMergeResult> {
  let chosen: MergeMethod;
  try {
    chosen = method ?? await defaultMergeMethod(repo, gh);
  } catch (err) {
    return { repo, number, method: method ?? MERGE_METHODS[0], merged: false, sha: null, message: ghFailure(err) };
  }
  let out: string;
  try {
    out = await gh([
      'api', '-X', 'PUT', `repos/${repo}/pulls/${number}/merge`,
      '-f', `sha=${sha}`, '-f', `merge_method=${chosen}`, '--jq', '.sha',
    ]);
  } catch (err) {
    return { repo, number, method: chosen, merged: false, sha: null, message: ghFailure(err) };
  }
  // GitHub answers this endpoint 200 only once the PR is merged; anything else made gh exit non-zero.
  return { repo, number, method: chosen, merged: true, sha: out.trim() || null, message: 'Merged' };
}

/**
 * Refuse when the PR's live head is not the SHA the caller reviewed. `seen` may
 * be short (the menu shows 7 characters); the full live SHA is returned so the
 * write can pin to it exactly.
 */
function assertHeadIs(repo: string, number: number, live: string, seen: string): string {
  if (!live.toLowerCase().startsWith(seen.toLowerCase())) {
    throw new Error(`${repo}#${number} moved to ${live.slice(0, 7)} since you looked at ${seen.slice(0, 7)}; reload it and try again.`);
  }
  return live;
}

/** The result of one `projects prs ready`. */
export interface ProjectPrReadyResult {
  repo: string;
  number: number;
  /** True when the PR is ready for review afterwards, including when it already was. */
  ready: boolean;
  /** The full head SHA the PR had when it was marked ready; null when the read failed. */
  sha: string | null;
  message: string;
}

/**
 * Mark a draft PR ready for review. GitHub has no REST endpoint for this (a REST
 * `PATCH pulls/{n}` ignores `draft`), so the write is ONE GraphQL mutation,
 * `markPullRequestReadyForReview`, after a REST read for the node id and draft
 * flag. A single mutation does not drain the shared GraphQL budget the way a poll
 * loop does (root AGENTS.md, the Mutations note). With `sha`, a PR whose head
 * moved since the caller looked is refused; the mutation itself takes no SHA, so
 * that check is read-then-write, not atomic.
 */
export async function markProjectPrReady(
  repo: string,
  number: number,
  sha: string | undefined,
  gh: GhExec = ghExec,
): Promise<ProjectPrReadyResult> {
  let head: { sha: string; draft: boolean; nodeId: string; state: string; merged: boolean };
  try {
    head = JSON.parse((await gh([
      'api', `repos/${repo}/pulls/${number}`, '--jq',
      '{sha: .head.sha, draft: (.draft // false), nodeId: .node_id, state: .state, merged: (.merged // false)}',
    ])).trim()) as { sha: string; draft: boolean; nodeId: string; state: string; merged: boolean };
    if (sha) assertHeadIs(repo, number, head.sha, sha);
  } catch (err) {
    return { repo, number, ready: false, sha: null, message: ghFailure(err) };
  }
  if (head.state !== 'open') {
    return { repo, number, ready: false, sha: head.sha, message: head.merged ? 'Already merged' : 'The pull request is closed' };
  }
  if (!head.draft) return { repo, number, ready: true, sha: head.sha, message: 'Already ready for review' };
  try {
    await gh([
      'api', 'graphql',
      '-f', 'query=mutation($id: ID!) { markPullRequestReadyForReview(input: {pullRequestId: $id}) { pullRequest { isDraft } } }',
      '-f', `id=${head.nodeId}`,
      '--jq', '.data.markPullRequestReadyForReview.pullRequest.isDraft',
    ]);
  } catch (err) {
    return { repo, number, ready: false, sha: head.sha, message: ghFailure(err) };
  }
  return { repo, number, ready: true, sha: head.sha, message: 'Marked ready for review' };
}

/** The result of one `projects prs review --approve`. */
export interface ProjectPrReviewResult {
  repo: string;
  number: number;
  event: 'APPROVE';
  submitted: boolean;
  /** The full head SHA the review is recorded against; null when the read failed. */
  sha: string | null;
  /** GitHub's review id and page, when submitted. */
  id: number | null;
  url: string | null;
  message: string;
}

/**
 * Approve a PR over REST (`POST pulls/{n}/reviews`, `event=APPROVE`). GitHub
 * accepts a review on an older commit instead of refusing it, so the live head is
 * read first and a moved head is refused; the review then carries `commit_id` set
 * to that full SHA, so a push racing the call cannot turn this into an approval
 * of code the caller never saw. Approving your own PR is GitHub's to refuse
 * (HTTP 422), reported as `submitted: false`.
 */
export async function approveProjectPr(
  repo: string,
  number: number,
  sha: string,
  body: string | undefined,
  gh: GhExec = ghExec,
): Promise<ProjectPrReviewResult> {
  const base = { repo, number, event: 'APPROVE' as const };
  let commitId: string;
  try {
    commitId = assertHeadIs(repo, number, (await prHead(repo, number, gh)).sha, sha);
  } catch (err) {
    return { ...base, submitted: false, sha: null, id: null, url: null, message: ghFailure(err) };
  }
  const args = ['api', '-X', 'POST', `repos/${repo}/pulls/${number}/reviews`, '-f', 'event=APPROVE', '-f', `commit_id=${commitId}`];
  if (body) args.push('-f', `body=${body}`);
  let posted: { id?: number; url?: string };
  try {
    posted = JSON.parse((await gh([...args, '--jq', '{id, url: .html_url}'])).trim()) as { id?: number; url?: string };
  } catch (err) {
    return { ...base, submitted: false, sha: commitId, id: null, url: null, message: ghFailure(err) };
  }
  return { ...base, submitted: true, sha: commitId, id: posted.id ?? null, url: posted.url || null, message: 'Approved' };
}

/** The result of one `projects prs comment`. */
export interface ProjectPrCommentResult {
  repo: string;
  number: number;
  commented: boolean;
  /** GitHub's comment id and page, when posted. */
  id: number | null;
  url: string | null;
  message: string;
}

/**
 * Post a conversation comment on a PR over REST (`POST issues/{n}/comments`, the
 * endpoint root AGENTS.md names instead of the GraphQL-backed `gh pr comment`).
 * A comment changes no code, so it is not pinned to a head SHA.
 */
export async function commentOnProjectPr(
  repo: string,
  number: number,
  body: string,
  gh: GhExec = ghExec,
): Promise<ProjectPrCommentResult> {
  let posted: { id?: number; url?: string };
  try {
    posted = JSON.parse((await gh([
      'api', '-X', 'POST', `repos/${repo}/issues/${number}/comments`, '-f', `body=${body}`, '--jq', '{id, url: .html_url}',
    ])).trim()) as { id?: number; url?: string };
  } catch (err) {
    return { repo, number, commented: false, id: null, url: null, message: ghFailure(err) };
  }
  return { repo, number, commented: true, id: posted.id ?? null, url: posted.url || null, message: 'Commented' };
}
