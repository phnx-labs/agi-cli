/**
 * REST-backed reads for PR CI state — the engine behind the `gh` overload shim.
 *
 * The problem this exists for: the whole fleet shares one GitHub token, and the
 * merge loop's `gh pr checks/view/list` are all **GraphQL**-backed. GraphQL is
 * metered on a 5000-POINT/hr budget separate from REST core (5000 req/hr), so the
 * fleet drains GraphQL while REST core sits idle, and every agent's CI watch dies
 * with `GraphQL: API rate limit already exceeded`. These functions answer the same
 * questions over REST, which is the budget nobody is using.
 *
 * They also fix PHNX-3042 (a superseded run's red reported as the current verdict):
 * `commits/{sha}/check-runs` returns ONLY runs for that exact SHA, so anchoring on
 * the PR's live head SHA can never surface a stale run from a superseded commit —
 * the head-exact property `gh pr checks`'s denormalized GraphQL rollup lacks.
 *
 * `gh api …` here draws REST core, and reuses {@link ghExec}'s hardened env
 * (`ghEnv` strips FORCE_COLOR / pins GH_NO_COLOR — this fleet exports FORCE_COLOR
 * and gh otherwise paints the JSON payload and JSON.parse dies).
 */

import { ghExec, type GhExec } from './pr-mergeable.js';
import type { StatusCheck } from './pr-verdict.js';

/** A rollup item shaped like `gh pr checks --json`, built from REST. */
export interface RollupItem extends StatusCheck {
  /** Check name / status context. */
  name: string;
  /** html_url (check-run) or target_url (legacy status); may be empty. */
  link?: string;
}

/** PR head identity — the SHA every check query must anchor to. */
interface PrHead {
  number: number;
  sha: string;
}

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

/**
 * Resolve a PR's current head SHA over REST (`GET repos/{repo}/pulls/{n}`).
 *
 * This is the anchor for every check query: pinning to the live head SHA is what
 * makes the watch immune to a superseded run's verdict (PHNX-3042). Throws if the
 * PR has no head SHA (deleted / not found) rather than returning a wrong empty.
 */
export async function prHead(
  repo: string,
  number: number,
  gh: GhExec = ghExec,
): Promise<PrHead> {
  const sha = (await gh(['api', `repos/${repo}/pulls/${number}`, '--jq', '.head.sha'])).trim();
  if (!sha) throw new Error(`no head SHA for ${repo}#${number}`);
  return { number, sha };
}

/**
 * The status-check rollup for ONE commit SHA, over REST — the union of the two
 * GitHub subsystems `gh pr checks`'s GraphQL rollup merges for you:
 *
 *   - `GET commits/{sha}/check-runs` — GitHub Actions + check-run apps (paginated).
 *   - `GET commits/{sha}/status`     — legacy commit statuses (external CI).
 *
 * Deduped by name; a check-run wins over a legacy status of the same context.
 * Fields are ASCII-upper-cased to match {@link StatusCheck}, which
 * {@link isCiGreen} reads as `conclusion || state || status`.
 */
export async function rollupForSha(
  repo: string,
  sha: string,
  gh: GhExec = ghExec,
): Promise<RollupItem[]> {
  const [runsRaw, statusRaw] = await Promise.all([
    gh([
      'api', `repos/${repo}/commits/${sha}/check-runs`, '--paginate',
      '--jq',
      '.check_runs[] | {name: .name, status: (.status // "" | ascii_upcase), ' +
        'conclusion: (.conclusion // "" | ascii_upcase), link: (.html_url // "")}',
    ]),
    gh([
      'api', `repos/${repo}/commits/${sha}/status`,
      '--jq',
      '.statuses[] | {name: .context, state: (.state // "" | ascii_upcase), ' +
        'link: (.target_url // "")}',
    ]),
  ]);

  const byName = new Map<string, RollupItem>();
  // Legacy statuses first; check-runs override on a name collision.
  for (const s of parseNdjson(statusRaw)) {
    byName.set(String(s.name), { name: String(s.name), state: str(s.state), link: str(s.link) });
  }
  for (const r of parseNdjson(runsRaw)) {
    byName.set(String(r.name), {
      name: String(r.name),
      status: str(r.status),
      conclusion: str(r.conclusion),
      link: str(r.link),
    });
  }
  return [...byName.values()];
}

/**
 * How many check-suites are still queued/in_progress for a SHA.
 *
 * Disambiguates the empty rollup: a suite that is `queued`/`in_progress` with no
 * runs yet means "checks are coming, not registered" (keep polling), NOT "this PR
 * has no checks" (terminal). Without this, a `--watch` on a freshly-pushed SHA
 * would read an empty rollup as green before CI registers.
 */
export async function pendingCheckSuites(
  repo: string,
  sha: string,
  gh: GhExec = ghExec,
): Promise<number> {
  const out = await gh([
    'api', `repos/${repo}/commits/${sha}/check-suites`,
    '--jq',
    '[.check_suites[] | select(.status == "queued" or .status == "in_progress")] | length',
  ]);
  const n = Number.parseInt(out.trim(), 10);
  return Number.isFinite(n) ? n : 0;
}

/** The exact GitHub GraphQL primary rate-limit signal (never the bare noun). */
const RATE_LIMIT_SIGNAL =
  /GraphQL: API rate limit (?:already )?exceeded|You have exceeded a secondary rate limit/i;

/** True when gh stderr is the rate-limit outcome the shim should switch to REST on. */
export function isRateLimitError(stderr: string): boolean {
  return RATE_LIMIT_SIGNAL.test(stderr);
}

function str(v: unknown): string | undefined {
  return v === undefined || v === null || v === '' ? undefined : String(v);
}
