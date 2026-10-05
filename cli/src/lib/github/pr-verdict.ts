
export interface PrReview {
  state?: string;
}

export interface PrComment {
  body?: string;
}

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

// Mirror merge-guard syntax and reject approvals merely carried from another PR.
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

export function isCiGreen(rollup: readonly StatusCheck[] | null | undefined): boolean {
  const items = rollup ?? [];
  return items.every((c) => {
    const v = (c.conclusion || c.state || c.status || '').toUpperCase();
    return v === 'SUCCESS' || v === 'NEUTRAL' || v === 'SKIPPED';
  });
}

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
