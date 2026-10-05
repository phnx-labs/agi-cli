/** Non-author PR approval plus CI-green checks for merge-on-green. Rules are copied from
 * merge-guard.sh: accept an APPROVED review or an APPROVE comment on this PR; reject one citing
 * another PR (#2736 laundering). No third rule; change with the hook's regexes in one delivery. */

export interface PrReview {
  state?: string;
}

export interface PrComment {
  body?: string;
}

/** One status-check rollup item from `gh pr list --json statusCheckRollup`; empty fields are
 * pending/in-progress. */
export interface StatusCheck {
  conclusion?: string;
  state?: string;
  status?: string;
}

export interface MergeablePrInput {
  number: number;
  repo: string;
  reviewDecision?: string | null;
  statusCheckRollup?: StatusCheck[] | null;
  reviews?: PrReview[] | null;
  comments?: PrComment[] | null;
}

/** True when a non-author verdict exists on this PR, mirroring merge-guard.sh: a review with
 * `state == "APPROVED"`, or an issue comment containing `\bAPPROVE\b` that is not a
 * carried-from citation (`\bcarried\s+(?:over\s+)?from\b` or `\bAPPROVE\s+(?:on|from)\s+#\d+`). */
export function hasApproveVerdict(
  reviews: readonly PrReview[] | null | undefined,
  comments: readonly PrComment[] | null | undefined,
): boolean {
  if (Array.isArray(reviews) && reviews.some((r) => r?.state === 'APPROVED')) {
    return true;
  }
  if (!Array.isArray(comments)) return false;
  for (const c of comments) {
    const body = c?.body ?? '';
    if (!/\bAPPROVE\b/.test(body)) continue;
    if (/\bcarried\s+(?:over\s+)?from\b|\bAPPROVE\s+(?:on|from)\s+#\d+/.test(body)) {
      continue;
    }
    return true;
  }
  return false;
}

/** True when every check is a terminal success-class conclusion (SUCCESS/NEUTRAL/SKIPPED, from
 * conclusion, else state, else status), matching the monitor's original jq. An empty rollup is
 * green, as jq `all([])` is true. */
export function isCiGreen(rollup: readonly StatusCheck[] | null | undefined): boolean {
  const items = rollup ?? [];
  return items.every((c) => {
    const v = (c.conclusion || c.state || c.status || '').toUpperCase();
    return v === 'SUCCESS' || v === 'NEUTRAL' || v === 'SKIPPED';
  });
}

/** Keeps PRs that are CI-green and non-author-approved. `reviewDecision == "APPROVED"` suffices;
 * when empty (reviewers post APPROVE comments by fleet convention), fall through to
 * hasApproveVerdict. */
export function selectMergeablePrs(prs: readonly MergeablePrInput[]): MergeablePrInput[] {
  return prs.filter((pr) => {
    if (!isCiGreen(pr.statusCheckRollup)) return false;
    if (pr.reviewDecision === 'APPROVED') return true;
    return hasApproveVerdict(pr.reviews, pr.comments);
  });
}

export function formatMergeableRef(pr: Pick<MergeablePrInput, 'repo' | 'number'>): string {
  return `${pr.repo}#${pr.number}`;
}
