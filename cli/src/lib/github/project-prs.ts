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
 *   - A per-repo fetch failure is reported as `repositories[].error` and flips
 *     `partial` — it is NEVER relabeled as "zero open PRs".
 */

import * as fs from 'fs';
import * as path from 'path';
import { ghExec, canonicalizeRepo, projectRepoSlugs, type GhExec } from './pr-mergeable.js';
import { rollupForSha, type RollupItem } from './rest.js';
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
}

/** One repository's open PRs, or the error that stopped its fetch. */
export interface ProjectRepoPrs {
  slug: string;
  /** Other project definitions attached to this same repository. */
  sharedWith: string[];
  pullRequests: ProjectPr[];
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
  return { ...pr, headSha: head, checks, reviewDecision };
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
 * immutable, so a cached entry never goes stale; a push mints a new key. Entries
 * for heads that are no longer open in that repo are pruned on write.
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

  async files(slug: string, pr: ProjectPr, gh: GhExec): Promise<string[]> {
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

  prune(slug: string, openHeads: ReadonlySet<string>): void {
    for (const key of Object.keys(this.entries)) {
      const at = key.lastIndexOf('@');
      if (key.slice(0, at) === slug && !openHeads.has(key.slice(at + 1))) {
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
 * its list keeps only PRs that touch those paths (`scope: project`) or touch no
 * sharing project's paths (`scope: repo-wide`).
 */
export async function buildProjectPrs(
  def: ProjectDef,
  opts: ProjectPrsOptions = {},
  gh: GhExec = ghExec,
  peers: readonly ProjectDef[] = [],
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
        let pullRequests: ProjectPr[];
        if (opts.number !== undefined) {
          const pr = await fetchOnePr(slug, opts.number, gh);
          pullRequests = [await enrichPr(slug, pr, gh)];
        } else {
          pullRequests = await listOpenPrs(slug, gh);
          const own = ownClaims.get(slug);
          if (peer && own) {
            filesCache.prune(slug, new Set(pullRequests.map((pr) => pr.headSha)));
            const scopes = await mapBounded(pullRequests, 8, async (pr) =>
              scopeForFiles(await filesCache.files(slug, pr, gh), own, peer.prefixes));
            pullRequests = pullRequests
              .map((pr, i) => ({ ...pr, scope: scopes[i] }))
              .filter((pr) => pr.scope !== null);
          }
        }
        return { slug, sharedWith, pullRequests, error: null };
      } catch (err) {
        // A fetch failure is reported, never relabeled as zero open PRs.
        return { slug, sharedWith, pullRequests: [], error: err instanceof Error ? err.message : String(err) };
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
