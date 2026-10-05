/**
 * Why a commit's CI failed, and the one-click remedy, for AGI Menu's ✗ glyph:
 * `agents projects prs failure` and `agents projects prs rerun`.
 *
 * `failure` lists every failing check on ONE commit (a PR head, a merge commit,
 * or the default branch head) and, for each GitHub Actions job, the error lines
 * from that job's log: `GET repos/{repo}/actions/jobs/{job}/logs`, timestamps and
 * ANSI colour stripped, runner cleanup after "Post job cleanup." dropped, and only
 * the lines that read like an error (plus one line of context each side) kept,
 * at most {@link EXCERPT_LIMIT}. `rerun` asks GitHub to re-run a workflow run's
 * failed jobs (`POST repos/{repo}/actions/runs/{id}/rerun-failed-jobs`).
 *
 * REST only: the root AGENTS.md bans GraphQL reads, and a log is a REST blob.
 */

import { ghExec, type GhExec } from './pr-mergeable.js';
import { FAILING_CONCLUSIONS, ghFailure } from './project-prs.js';

/** The most excerpt lines one failing check carries. */
export const EXCERPT_LIMIT = 12;

/** One failing check on the commit, with the error lines of its job log. */
export interface FailingCheck {
  name: string;
  /** The check's page (an Actions job page, or a status's target URL); null when GitHub gave none. */
  url: string | null;
  /** The Actions workflow run and job; null for a check that is not an Actions job. */
  runId: number | null;
  jobId: number | null;
  /** Upper-cased conclusion (FAILURE, TIMED_OUT, CANCELLED, …) or a status's state (FAILURE, ERROR). */
  conclusion: string;
  /** At most {@link EXCERPT_LIMIT} error lines from the job log; [] when there is no log or it could not be read. */
  excerpt: string[];
  /** Why `excerpt` is empty, when it is not simply a log with no error lines. */
  excerptError: string | null;
}

/** `agents projects prs failure --json`. */
export interface CiFailureReport {
  repo: string;
  sha: string;
  checks: FailingCheck[];
  /** Non-null when the commit's checks could not be read; `checks` is then not authoritative. */
  error: string | null;
}

/** `agents projects prs rerun --json`. */
export interface RerunResult {
  repo: string;
  runId: number;
  requested: boolean;
  message: string;
}

const TIMESTAMP = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z ?/;
// CSI sequences (colour, cursor) as the runner writes them.
// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;
const ERRORISH = /error|fail|exit(?:ed|ing)? (?:with )?code|✗|×/i;
/** Runner bookkeeping that carries "error"/"fail" words without being the failure. */
const NOISE = /^(?:##\[(?:group|endgroup)\]|\[command\]|shell: |env:$)/;
/** The runner's post-steps (checkout cleanup, credential removal) start here. */
const CLEANUP = /^Post job cleanup\.?$/;

/** One raw log line as a person reads it: no timestamp, no colour, no runner annotation marker. */
function cleanLine(raw: string): string {
  return raw.replace(TIMESTAMP, '').replace(ANSI, '').replace(/^##\[(?:error|warning)\]/, '').trimEnd();
}

/**
 * The error lines of one job log. Lines are cleaned ({@link cleanLine}), the
 * runner's cleanup after "Post job cleanup." is dropped, and each line that reads
 * like an error is kept with one line of context on each side; blank and runner
 * bookkeeping lines never count. Over {@link EXCERPT_LIMIT} lines, the first seven
 * (where the root cause usually is) and the last four (the exit) are kept around
 * an "…" line.
 */
export function excerptFromLog(log: string): string[] {
  const lines: string[] = [];
  for (const raw of log.replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const line = cleanLine(raw);
    if (CLEANUP.test(line.trim())) break;
    lines.push(line);
  }
  const usable = (i: number) => i >= 0 && i < lines.length && lines[i].trim() !== '' && !NOISE.test(lines[i]);
  const keep = new Set<number>();
  lines.forEach((line, i) => {
    if (!usable(i) || !ERRORISH.test(line)) return;
    for (const j of [i - 1, i, i + 1]) if (usable(j)) keep.add(j);
  });
  const picked: string[] = [];
  for (const i of [...keep].sort((a, b) => a - b)) {
    if (picked.at(-1) !== lines[i]) picked.push(lines[i]);
  }
  if (picked.length <= EXCERPT_LIMIT) return picked;
  return [...picked.slice(0, 7), '…', ...picked.slice(-4)];
}

/** `…/actions/runs/{run}/job/{job}` → the run and job ids; nulls for any other URL. */
export function actionsIds(url: string | null): { runId: number | null; jobId: number | null } {
  const m = url?.match(/\/actions\/runs\/(\d+)\/jobs?\/(\d+)/);
  return m ? { runId: Number(m[1]), jobId: Number(m[2]) } : { runId: null, jobId: null };
}

/** Parse newline-delimited JSON (gh `--jq` streams one object per line/page). */
function ndjson(out: string): Array<Record<string, unknown>> {
  return out.split('\n').map((l) => l.trim()).filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);
}

const text = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);

/** One job's log, over REST. gh refuses to print a payload with escape sequences unless told it may. */
async function readJobLog(repo: string, jobId: number, gh: GhExec): Promise<string> {
  return gh(['api', '--allow-escape-sequences', `repos/${repo}/actions/jobs/${jobId}/logs`]);
}

/**
 * Every failing check on `sha` with the error lines of its job log. Check runs
 * and legacy commit statuses are both read (a check run wins a name collision,
 * as in `rollupForSha`); only failing ones are kept. Logs are read concurrently.
 * A log that cannot be read (expired, still uploading, no access) empties that
 * check's excerpt and says why in `excerptError`; it never fails the report.
 */
export async function readCiFailure(repo: string, sha: string, gh: GhExec = ghExec): Promise<CiFailureReport> {
  let runs: Array<Record<string, unknown>>;
  let statuses: Array<Record<string, unknown>>;
  try {
    const [runsOut, statusOut] = await Promise.all([
      gh(['api', `repos/${repo}/commits/${sha}/check-runs`, '--paginate', '--jq',
        '.check_runs[] | {name, conclusion: (.conclusion // "" | ascii_upcase), url: .html_url}']),
      gh(['api', `repos/${repo}/commits/${sha}/status`, '--jq',
        '.statuses[] | {name: .context, state: (.state // "" | ascii_upcase), url: .target_url}']),
    ]);
    runs = ndjson(runsOut);
    statuses = ndjson(statusOut);
  } catch (err) {
    return { repo, sha, checks: [], error: ghFailure(err) };
  }

  const byName = new Map<string, Omit<FailingCheck, 'excerpt' | 'excerptError'>>();
  for (const s of statuses) {
    const state = String(s.state ?? '');
    if (state !== 'FAILURE' && state !== 'ERROR') continue;
    byName.set(String(s.name), { name: String(s.name), url: text(s.url), runId: null, jobId: null, conclusion: state });
  }
  for (const r of runs) {
    const name = String(r.name);
    const conclusion = String(r.conclusion ?? '');
    if (!FAILING_CONCLUSIONS.has(conclusion)) {
      byName.delete(name);
      continue;
    }
    const url = text(r.url);
    byName.set(name, { name, url, ...actionsIds(url), conclusion });
  }

  const checks = await Promise.all([...byName.values()].map(async (check): Promise<FailingCheck> => {
    if (check.jobId === null) {
      return { ...check, excerpt: [], excerptError: 'Not a GitHub Actions job: open the check for its log.' };
    }
    try {
      return { ...check, excerpt: excerptFromLog(await readJobLog(repo, check.jobId, gh)), excerptError: null };
    } catch (err) {
      return { ...check, excerpt: [], excerptError: ghFailure(err) };
    }
  }));
  return { repo, sha, checks, error: null };
}

/**
 * Re-run a workflow run's failed jobs (`POST actions/runs/{id}/rerun-failed-jobs`).
 * GitHub answers 201 with no body; a refusal (the run is still in progress, or
 * too old to re-run) comes back as `requested: false` with GitHub's message.
 */
export async function rerunFailedJobs(repo: string, runId: number, gh: GhExec = ghExec): Promise<RerunResult> {
  try {
    await gh(['api', '-X', 'POST', `repos/${repo}/actions/runs/${runId}/rerun-failed-jobs`]);
  } catch (err) {
    return { repo, runId, requested: false, message: ghFailure(err) };
  }
  return { repo, runId, requested: true, message: 'Re-run of the failed jobs requested' };
}
