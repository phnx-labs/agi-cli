/** Why a commit's CI failed and the one-click remedy, for AGI Menu's failure glyph: `agents
 * projects prs failure` lists failing checks on one commit with error lines from each Actions
 * job log (timestamps/ANSI stripped, post-cleanup dropped, at most EXCERPT_LIMIT); */

import { ghExec, type GhExec } from './pr-mergeable.js';
import { FAILING_CONCLUSIONS, FAILING_STATES, ghFailure } from './project-prs.js';
import { rollupForSha, type RollupItem } from './rest.js';

export const EXCERPT_LIMIT = 12;

export interface FailingCheck {
  name: string;
  url: string | null;
  runId: number | null;
  jobId: number | null;
  conclusion: string;
  excerpt: string[];
  excerptError: string | null;
}

export interface CiFailureReport {
  repo: string;
  sha: string;
  checks: FailingCheck[];
  error: string | null;
}

export interface RerunResult {
  repo: string;
  runId: number;
  requested: boolean;
  message: string;
}

// Fork-controlled logs are hostile terminal input: strip CSI/OSC/DCS/APC/PM and C0/C1 controls.
const TIMESTAMP = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z ?/;
// eslint-disable-next-line no-control-regex
const ESCAPES = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b[\]P^_][\s\S]*?(?:\x07|\x1b\\|$)|\x1b[@-Z\\-_]|\x9b[0-9;?]*[ -/]*[@-~]/g;
// eslint-disable-next-line no-control-regex
const CONTROLS = /[\x00-\x08\x0b-\x1f\x7f-\x9f]/g;
const ERRORISH = /error|fail|exit(?:ed|ing)? (?:with )?code|✗|×/i;
const ALL_CLEAR = /(?:^|\W)0 (?:failed|failures?|errors?)\b|\b(?:failed|failures?|errors?):? 0\b/i;
const NOISE = /^(?:##\[(?:group|endgroup)\]|\[command\]|shell: |env:$)/;
const CLEANUP = /^Post job cleanup\.?$/;

function cleanLine(raw: string): string {
  return raw.replace(TIMESTAMP, '').replace(ESCAPES, '').replace(CONTROLS, '').replace(/^##\[(?:error|warning)\]/, '').trimEnd();
}

/** The error lines of one job log: cleaned, runner cleanup after "Post job cleanup." dropped,
 * each error-like line kept with one context line each side. Over EXCERPT_LIMIT, the first
 * seven lines (usually the root cause) and last four (the exit) are kept around an "…" line. */
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

export function actionsIds(url: string | null): { runId: number | null; jobId: number | null } {
  const m = url?.match(/\/actions\/runs\/(\d+)\/jobs?\/(\d+)/);
  return m ? { runId: Number(m[1]), jobId: Number(m[2]) } : { runId: null, jobId: null };
}

// gh may preserve escapes for binary-safe output; cleanLine must sanitize the result before display.
async function readJobLog(repo: string, jobId: number, gh: GhExec): Promise<string> {
  return gh(['api', '--allow-escape-sequences', `repos/${repo}/actions/jobs/${jobId}/logs`]);
}

function logFailure(err: unknown): string {
  const raw = `${String((err as { stderr?: unknown })?.stderr ?? '')} ${err instanceof Error ? err.message : String(err)}`;
  if (/unknown flag: --allow-escape-sequences/.test(raw)) return 'This gh is too old to read job logs (it lacks --allow-escape-sequences); upgrade gh.';
  if (/maxBuffer/i.test(raw)) return 'The job log is larger than 8 MB; open it on GitHub.';
  if ((err as { killed?: boolean })?.killed) return 'The job log did not download within 30 s; open it on GitHub.';
  return ghFailure(err);
}

const isFailing = (item: RollupItem) => (item.state === undefined
  ? FAILING_CONCLUSIONS.has(item.conclusion ?? '')
  : FAILING_STATES.has(item.state));

/** Every failing check on `sha` with its job-log error lines. Checks come from the same REST
 * rollup as the glyph (rollupForSha), so this names exactly what the glyph counted. An unreadable
 * log empties that excerpt and sets `excerptError`; it never fails the report. */
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

/** Re-runs a workflow run's failed jobs. GitHub answers 201 with no body; a refusal (run in
 * progress or too old) returns `requested: false` with GitHub's message. */
export async function rerunFailedJobs(repo: string, runId: number, gh: GhExec = ghExec): Promise<RerunResult> {
  try {
    await gh(['api', '-X', 'POST', `repos/${repo}/actions/runs/${runId}/rerun-failed-jobs`]);
  } catch (err) {
    return { repo, runId, requested: false, message: ghFailure(err) };
  }
  return { repo, runId, requested: true, message: 'Re-run of the failed jobs requested' };
}
