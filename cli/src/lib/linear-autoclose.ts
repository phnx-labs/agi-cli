/**
 * Linear auto-close: close Linear issues whose linked GitHub PRs have merged.
 *
 * The pure decision function `shouldCloseIssue` is the only logic here —
 * it is unit-tested and shared with the command routine's equivalent
 * shell check.  The rest (Linear GraphQL, gh invocations) lives in the
 * routine YAML's `command:` shell script so the routine stays self-contained
 * and independent of the CLI build.
 *
 * @see cli/routines/linear-autoclose.yml
 */

/**
 * Subset of `gh pr view --json state,mergedAt` output that drives the
 * close decision.  State is one of: OPEN | CLOSED | MERGED (gh GraphQL).
 */
export interface PrInfo {
  /** gh GraphQL PR state: 'OPEN' | 'CLOSED' | 'MERGED' */
  state: string;
  /** ISO-8601 merge timestamp, or null when the PR was not merged. */
  mergedAt: string | null;
}

/**
 * Pure decision: returns true when the PR has been merged and its linked
 * Linear issue should therefore be closed.
 *
 * A PR is considered merged only when both conditions hold:
 *   1. `state === 'MERGED'`  — gh marks CLOSED (rejected) separately from MERGED
 *   2. `mergedAt !== null`   — defensive guard; a merged PR always carries a timestamp
 */
export function shouldCloseIssue(pr: PrInfo): boolean {
  return pr.state === 'MERGED' && pr.mergedAt !== null;
}
