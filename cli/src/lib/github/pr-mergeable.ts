
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

export async function ghExec(args: string[], opts: { timeoutMs?: number } = {}): Promise<string> {
  const { stdout } = await execFileAsync('gh', args, {
    timeout: opts.timeoutMs ?? 30_000,
    maxBuffer: 8 * 1024 * 1024,
    encoding: 'utf-8',
    env: ghEnv(),
  });
  return String(stdout ?? '');
}

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
      continue;
    }
  }
  return candidates.filter((pr) =>
    pr.reviewDecision === 'APPROVED' || hasApproveVerdict(pr.reviews, pr.comments),
  );
}

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
