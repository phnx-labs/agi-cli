/** Closes Linear issues whose linked GitHub PRs merged. Only the pure `shouldCloseIssue` lives
 * here; the Linear GraphQL and gh calls stay in cli/routines/linear-autoclose.yml so the routine
 * is self-contained. */

/** Subset of `gh pr view --json state,mergedAt` that drives the close decision; state is OPEN |
 * CLOSED | MERGED. */
export interface PrInfo {
  /** gh GraphQL PR state: 'OPEN' | 'CLOSED' | 'MERGED' */
  state: string;
  /** ISO-8601 merge timestamp, or null when the PR was not merged. */
  mergedAt: string | null;
}

/** True only when the PR is merged: `state === 'MERGED'` (CLOSED means rejected) and `mergedAt !==
 * null`. */
export function shouldCloseIssue(pr: PrInfo): boolean {
  return pr.state === 'MERGED' && pr.mergedAt !== null;
}
