/**
 * List this user's mergeable PRs across registered project repos.
 *
 * The built-in `pr-merge-on-green` monitor used to run `gh pr list --author @me`
 * with no `--repo`. `gh` then infers the repository from the working directory,
 * and the daemon's cwd is not a git repo, so every poll returned empty.
 *
 * This helper:
 *   1. Collects GitHub slugs from `~/.agents/projects/*.yaml` (`repo` / `repos[].slug`).
 *   2. Canonicalizes each slug (REST `repos/{slug}` — `phnx-labs/agents-cli` lists
 *      nothing; the live name is `phnx-labs/agi-cli`).
 *   3. Runs `gh pr list --repo <slug> --author @me` (cwd-independent).
 *   4. Keeps CI-green PRs with a merge-guard verdict (formal APPROVED review
 *      OR an APPROVE comment on THIS PR).
 *
 * Stdout is a single line of `owner/repo#n` refs (or empty). Empty is a silent
 * observation under `condition.mode: every` — do not write to stderr on the
 * no-match path, or command.ts will treat stderr as the observation and fire.
 */

import { execFile } from 'child_process';
import { promisify } from 'util';
import { listProjectDefs, type ProjectDef } from '../projects.js';
import {
  formatMergeableRef,
  hasApproveVerdict,
  isCiGreen,
  type MergeablePrInput,
  type PrComment,
  type PrReview,
  type StatusCheck,
} from './pr-verdict.js';

const execFileAsync = promisify(execFile);

export type GhExec = (args: string[]) => Promise<string>;

/**
 * `gh --json` is not color-safe when this fleet exports FORCE_COLOR /
 * CLICOLOR_FORCE: gh paints the payload and JSON.parse / jq die on the ANSI
 * prefix (live miss on the sibling poll script). Strip the force vars and
 * pin GH_NO_COLOR for every gh spawn.
 */
function ghEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  env.CLICOLOR = '0';
  env.NO_COLOR = '1';
  env.GH_NO_COLOR = '1';
  env.GH_PAGER = 'cat';
  delete env.CLICOLOR_FORCE;
  delete env.FORCE_COLOR;
  delete env.GH_FORCE_TTY;
  return env;
}

/** Default runner: `gh` with a 30s timeout. Non-zero exit throws. */
export async function ghExec(args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('gh', args, {
    timeout: 30_000,
    maxBuffer: 8 * 1024 * 1024,
    encoding: 'utf-8',
    env: ghEnv(),
  });
  return String(stdout ?? '');
}

/** Unique GitHub slugs declared on project definitions. */
export function projectRepoSlugs(defs: readonly ProjectDef[]): string[] {
  const slugs = new Set<string>();
  for (const d of defs) {
    if (d.repo) slugs.add(d.repo);
    for (const r of d.repos ?? []) {
      if (r.slug) slugs.add(r.slug);
    }
  }
  return [...slugs].sort();
}

/**
 * Resolve a slug to GitHub's current `nameWithOwner`. A renamed repo
 * (`phnx-labs/agents-cli` → `phnx-labs/agi-cli`) lists zero PRs under the old
 * name; the REST repo read follows the rename redirect and returns the live one.
 * REST + a 24h gh cache: a rename is rare, and every `projects prs` refresh asks.
 * On error, keep the input slug.
 */
export async function canonicalizeRepo(slug: string, gh: GhExec): Promise<string> {
  try {
    const out = (await gh([
      'api', `repos/${slug}`, '--cache', '24h', '--jq', '.full_name',
    ])).trim();
    return out || slug;
  } catch {
    return slug;
  }
}

interface ListedPr {
  number: number;
  reviewDecision?: string | null;
  statusCheckRollup?: StatusCheck[] | null;
}

async function fetchVerdict(
  repo: string,
  number: number,
  gh: GhExec,
): Promise<{ reviews: PrReview[]; comments: PrComment[] }> {
  const [reviewsRaw, commentsRaw] = await Promise.all([
    gh(['api', `repos/${repo}/pulls/${number}/reviews`, '--cache', '60s']),
    gh(['api', `repos/${repo}/issues/${number}/comments`, '--cache', '60s']),
  ]);
  const reviews = JSON.parse(reviewsRaw) as unknown;
  const comments = JSON.parse(commentsRaw) as unknown;
  return {
    reviews: Array.isArray(reviews) ? reviews as PrReview[] : [],
    comments: Array.isArray(comments) ? comments as PrComment[] : [],
  };
}

/**
 * Given PRs already listed for one repo, attach verdict payloads only for the
 * CI-green ones that lack a formal APPROVED reviewDecision, then select.
 */
export async function selectListedMergeable(
  repo: string,
  listed: readonly ListedPr[],
  gh: GhExec,
): Promise<MergeablePrInput[]> {
  const candidates: MergeablePrInput[] = [];
  for (const row of listed) {
    if (!isCiGreen(row.statusCheckRollup)) continue;
    const base: MergeablePrInput = {
      number: row.number,
      repo,
      reviewDecision: row.reviewDecision ?? '',
      statusCheckRollup: row.statusCheckRollup,
      reviews: [],
      comments: [],
    };
    if (base.reviewDecision === 'APPROVED') {
      candidates.push(base);
      continue;
    }
    try {
      const extra = await fetchVerdict(repo, row.number, gh);
      candidates.push({ ...base, ...extra });
    } catch {
      // A single PR's reviews/comments probe failed — skip it, keep the rest.
      continue;
    }
  }
  return candidates.filter((pr) =>
    pr.reviewDecision === 'APPROVED' || hasApproveVerdict(pr.reviews, pr.comments),
  );
}

/** List mergeable `owner/repo#n` refs, space-separated. Empty string if none. */
export async function listMergeableRefs(opts?: {
  gh?: GhExec;
  defs?: ProjectDef[];
  repos?: string[];
}): Promise<string> {
  const gh = opts?.gh ?? ghExec;
  const slugs = opts?.repos ?? projectRepoSlugs(opts?.defs ?? listProjectDefs());
  const seen = new Set<string>();
  const refs: string[] = [];

  for (const raw of slugs) {
    const repo = await canonicalizeRepo(raw, gh);
    if (seen.has(repo)) continue;
    seen.add(repo);
    let listed: ListedPr[] = [];
    try {
      const rawList = await gh([
        'pr', 'list',
        '--repo', repo,
        '--author', '@me',
        '--state', 'open',
        '--limit', '50',
        '--json', 'number,reviewDecision,statusCheckRollup',
      ]);
      const parsed = JSON.parse(rawList) as unknown;
      listed = Array.isArray(parsed) ? parsed as ListedPr[] : [];
    } catch {
      continue;
    }
    const mergeable = await selectListedMergeable(repo, listed, gh);
    for (const pr of mergeable) refs.push(formatMergeableRef(pr));
  }

  return refs.join(' ');
}
