/** REST-backed PR CI reads behind the `gh` overload shim. The fleet shares one token and `gh pr
 * checks/view/list` are GraphQL (5000 points/hr), so GraphQL drains while REST core idles.
 * Also fixes PHNX-3042: `commits/{sha}/check-runs` returns only that SHA's runs, never stale ones. */

import { ghExec, type GhExec } from './pr-mergeable.js';
import type { StatusCheck } from './pr-verdict.js';

export interface RollupItem extends StatusCheck {
  name: string;
  link?: string;
}

interface PrHead {
  number: number;
  sha: string;
}

function parseNdjson(out: string): Array<Record<string, unknown>> {
  const rows: Array<Record<string, unknown>> = [];
  for (const line of out.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    rows.push(JSON.parse(t) as Record<string, unknown>);
  }
  return rows;
}

/** Resolves a PR's current head SHA over REST (`GET pulls/{n}`), the anchor for every check
 * query that makes the watch immune to a superseded run (PHNX-3042). Throws if the PR has no
 * head SHA rather than returning a wrong empty. */
export async function prHead(
  repo: string,
  number: number,
  gh: GhExec = ghExec,
): Promise<PrHead> {
  const sha = (await gh(['api', `repos/${repo}/pulls/${number}`, '--jq', '.head.sha'])).trim();
  if (!sha) throw new Error(`no head SHA for ${repo}#${number}`);
  return { number, sha };
}

/** The status-check rollup for one SHA over REST, the union of what `gh pr checks`'s GraphQL
 * rollup merges: `commits/{sha}/check-runs` (Actions and check-run apps, paginated) and
 * `commits/{sha}/status` (legacy external CI). */
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

/** How many check-suites are still queued/in_progress for a SHA. Disambiguates an empty rollup:
 * a pending suite with no runs means checks are coming (keep polling), not that the PR has
 * none. Without it, `--watch` on a fresh push would read empty as green. */
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

const RATE_LIMIT_SIGNAL =
  /GraphQL: API rate limit (?:already )?exceeded|You have exceeded a secondary rate limit/i;

export function isRateLimitError(stderr: string): boolean {
  return RATE_LIMIT_SIGNAL.test(stderr);
}

function str(v: unknown): string | undefined {
  return v === undefined || v === null || v === '' ? undefined : String(v);
}
