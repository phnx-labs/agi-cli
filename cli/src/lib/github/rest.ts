
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

// Every later verdict is anchored to this exact head SHA, never the mutable PR object.
export async function prHead(
  repo: string,
  number: number,
  gh: GhExec = ghExec,
): Promise<PrHead> {
  const sha = (await gh(['api', `repos/${repo}/pulls/${number}`, '--jq', '.head.sha'])).trim();
  if (!sha) throw new Error(`no head SHA for ${repo}#${number}`);
  return { number, sha };
}

// Query checks and statuses for one reviewed commit so superseded results cannot leak in.
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

// Pending suites distinguish checks not registered yet from a genuinely settled empty rollup.
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
