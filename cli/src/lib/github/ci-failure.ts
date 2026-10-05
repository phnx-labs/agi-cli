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
import { FAILING_CONCLUSIONS, FAILING_STATES, ghFailure } from './project-prs.js';
import { rollupForSha, type RollupItem } from './rest.js';

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
// A job log is written by the code under test, a fork PR's included, and the
// excerpt reaches a terminal and the menu. gh's own escape-sequence guard is off
// for the log read, so every escape sequence goes here: CSI (colour, cursor),
// OSC/DCS/APC/PM strings (title, clipboard writes, hyperlinks), other ESC pairs,
// then any C0/C1 control character left (bare CR, BEL, the 8-bit CSI 0x9b).
// eslint-disable-next-line no-control-regex
const ESCAPES = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b[\]P^_][\s\S]*?(?:\x07|\x1b\\|$)|\x1b[@-Z\\-_]|\x9b[0-9;?]*[ -/]*[@-~]/g;
// eslint-disable-next-line no-control-regex
const CONTROLS = /[\x00-\x08\x0b-\x1f\x7f-\x9f]/g;
const ERRORISH = /error|fail|exit(?:ed|ing)? (?:with )?code|✗|×/i;
/** Summary lines that name the error words while saying nothing failed: "0 failed", "errors: 0". */
const ALL_CLEAR = /(?:^|\W)0 (?:failed|failures?|errors?)\b|\b(?:failed|failures?|errors?):? 0\b/i;
/** Runner bookkeeping that carries "error"/"fail" words without being the failure. */
const NOISE = /^(?:##\[(?:group|endgroup)\]|\[command\]|shell: |env:$)/;
/** The runner's post-steps (checkout cleanup, credential removal) start here. */
const CLEANUP = /^Post job cleanup\.?$/;

/** One raw log line as a person reads it: no timestamp, no colour, no runner annotation marker. */
function cleanLine(raw: string): string {
  return raw.replace(TIMESTAMP, '').replace(ESCAPES, '').replace(CONTROLS, '').replace(/^##\[(?:error|warning)\]/, '').trimEnd();
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
    if (!usable(i) || !ERRORISH.test(line) || ALL_CLEAR.test(line)) return;
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

/** One job's log, over REST. gh refuses to print a payload with escape sequences unless told it may; {@link cleanLine} strips them. */
async function readJobLog(repo: string, jobId: number, gh: GhExec): Promise<string> {
  return gh(['api', '--allow-escape-sequences', `repos/${repo}/actions/jobs/${jobId}/logs`]);
}

/** A failed log read in words a person can act on; gh's own message otherwise. */
function logFailure(err: unknown): string {
  const raw = `${String((err as { stderr?: unknown })?.stderr ?? '')} ${err instanceof Error ? err.message : String(err)}`;
  if (/unknown flag: --allow-escape-sequences/.test(raw)) return 'This gh is too old to read job logs (it lacks --allow-escape-sequences); upgrade gh.';
  if (/maxBuffer/i.test(raw)) return 'The job log is larger than 8 MB; open it on GitHub.';
  if ((err as { killed?: boolean })?.killed) return 'The job log did not download within 30 s; open it on GitHub.';
  return ghFailure(err);
}

/** A rollup item that makes the commit red, by the same rule as the ✗ glyph (`ciFromRollupItems`). */
const isFailing = (item: RollupItem) => (item.state === undefined
  ? FAILING_CONCLUSIONS.has(item.conclusion ?? '')
  : FAILING_STATES.has(item.state));

/**
 * Every failing check on `sha` with the error lines of its job log. The checks
 * are the same REST rollup the ✗ glyph is computed from ({@link rollupForSha}:
 * check runs and legacy statuses, a check run winning a name collision), so this
 * names exactly the checks the glyph counted. Logs are read concurrently. A log
 * that cannot be read (expired, still uploading, no access) empties that check's
 * excerpt and says why in `excerptError`; it never fails the report.
 */
export async function readCiFailure(repo: string, sha: string, gh: GhExec = ghExec): Promise<CiFailureReport> {
  let items: RollupItem[];
  try {
    items = await rollupForSha(repo, sha, gh);
  } catch (err) {
    return { repo, sha, checks: [], error: ghFailure(err) };
  }
  const checks = await Promise.all(items.filter(isFailing).map(async (item): Promise<FailingCheck> => {
    const url = item.link || null;
    const check = { name: item.name, url, ...actionsIds(url), conclusion: (item.conclusion ?? item.state ?? '') };
    if (check.jobId === null) {
      return { ...check, excerpt: [], excerptError: 'Not a GitHub Actions job: open the check for its log.' };
    }
    try {
      return { ...check, excerpt: excerptFromLog(await readJobLog(repo, check.jobId, gh)), excerptError: null };
    } catch (err) {
      return { ...check, excerpt: [], excerptError: logFailure(err) };
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
