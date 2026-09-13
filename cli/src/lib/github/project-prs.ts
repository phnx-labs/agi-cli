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

import { ghExec, canonicalizeRepo, projectRepoSlugs, type GhExec } from './pr-mergeable.js';
import { rollupForSha, type RollupItem } from './rest.js';
import type { ProjectDef } from '../projects.js';

/** The author of a PR, as the menu renders it (login + avatar). */
export interface ProjectPrAuthor {
  login: string;
  avatarUrl: string;
}

/** One open PR row. `checks`/`reviewDecision` are null unless the PR was enriched. */
export interface ProjectPr {
  number: number;
  title: string;
  url: string;
  isDraft: boolean;
  /** Upper-cased GitHub state — always `OPEN` here (only open PRs are listed). */
  state: string;
  updatedAt: string;
  author: ProjectPrAuthor;
  headRefName: string;
  baseRefName: string;
  headSha: string;
  body: string;
  /** Populated only for the `--number` PR: the head-SHA status-check rollup. */
  checks: RollupItem[] | null;
  /** Populated only for the `--number` PR: GitHub's computed review decision. */
  reviewDecision: string | null;
}

/** One repository's open PRs, or the error that stopped its fetch. */
export interface ProjectRepoPrs {
  slug: string;
  pullRequests: ProjectPr[];
  /** Non-null when the fetch failed — the list is then NOT authoritative. */
  error: string | null;
}

/** The full `projects prs --json` envelope. */
export interface ProjectPrsEnvelope {
  project: { name: string; linearProjectId: string | null };
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
  'state: (.state // "" | ascii_upcase), updatedAt: (.updated_at // ""), ' +
  'login: (.user.login // ""), avatarUrl: (.user.avatar_url // ""), ' +
  'headRefName: (.head.ref // ""), baseRefName: (.base.ref // ""), ' +
  'headSha: (.head.sha // ""), body: (.body // "")}';

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
    updatedAt: String(row.updatedAt ?? ''),
    author: { login: String(row.login ?? ''), avatarUrl: String(row.avatarUrl ?? '') },
    headRefName: String(row.headRefName ?? ''),
    baseRefName: String(row.baseRefName ?? ''),
    headSha: String(row.headSha ?? ''),
    body: String(row.body ?? ''),
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
  // Canonicalize CONCURRENTLY — each `gh repo view` can take up to gh's 30s
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
 * Build the full envelope. `number` (which the command requires alongside
 * `repo`) fetches and enriches exactly that one PR; otherwise every target
 * repo's open PRs are listed with checks/reviewDecision left null.
 */
export async function buildProjectPrs(
  def: ProjectDef,
  opts: ProjectPrsOptions = {},
  gh: GhExec = ghExec,
): Promise<ProjectPrsEnvelope> {
  const project = { name: def.name, linearProjectId: def.linear?.projectId ?? null };
  const slugs = await resolveTargetSlugs(def, opts.repo, gh);

  // Fetch repos in PARALLEL so a native caller's overall deadline scales with the
  // slowest repo, not the sum — a serial multi-repo walk of 30s gh calls can blow
  // past a bounded caller timeout and lose the whole result. Repo count is small
  // (a project's attached repos), so this is a bounded fan-out, not unbounded.
  const repositories: ProjectRepoPrs[] = await Promise.all(
    slugs.map(async (slug): Promise<ProjectRepoPrs> => {
      try {
        let pullRequests: ProjectPr[];
        if (opts.number !== undefined) {
          const pr = await fetchOnePr(slug, opts.number, gh);
          pullRequests = [await enrichPr(slug, pr, gh)];
        } else {
          pullRequests = await listOpenPrs(slug, gh);
        }
        return { slug, pullRequests, error: null };
      } catch (err) {
        // A fetch failure is reported, never relabeled as zero open PRs.
        return { slug, pullRequests: [], error: err instanceof Error ? err.message : String(err) };
      }
    }),
  );

  const partial = repositories.some((r) => r.error !== null);
  return { project, repositories, partial };
}
