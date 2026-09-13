/**
 * Headless-exit warning for an open PR left behind by a run (RUSH-2394).
 *
 * A headless agent that backgrounds `gh pr checks --watch` and exits strands its
 * own PR: that watcher is a child of the agent's process tree, so it dies with
 * the agent and nothing merges on green. This module is the fail-loud half of
 * that story — it probes the run's branch for an OPEN PR on exit and says so.
 *
 * The `agents pr land --detach` lander this warning used to point at was removed
 * with the `agents pr` command group (RUSH-2472): merge-on-green is a monitor
 * (`agents monitors`), not a bespoke command with its own scheduler. The
 * reusable CI/review polling it will run on lives in lib/teams/pr-watch.ts, so
 * this module keeps only the exit-path warning and names no specific command.
 */
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsyncDefault = promisify(execFile);

/**
 * Snapshot of the current branch's open PR (if any), for the headless-exit
 * fail-loud path. Returns null when there is no open PR or `gh` cannot answer.
 */
interface BranchOpenPr {
  number: number;
  url: string;
  state: string;
}

/**
 * Pure classifier: should the exit path warn about this open PR?
 * Warn when the PR exists and is still OPEN.
 */
export function shouldWarnOrphanedOpenPr(pr: BranchOpenPr | null): boolean {
  if (!pr) return false;
  return pr.state.toUpperCase() === 'OPEN';
}

/** Human-readable warning for an open PR the exiting run left unattended. */
export function formatOrphanedOpenPrWarning(pr: BranchOpenPr): string {
  const lines = [
    '',
    chalkRed('WARNING: open PR left unattended (RUSH-2394)'),
    `  ${pr.url}`,
    `  PR #${pr.number} is still OPEN and nothing is watching it. A background`,
    '  `gh pr checks --watch` child dies when a headless agent exits, so the PR',
    '  will sit green and unmerged.',
    '  Merge it once CI is green and a non-author review has cleared it, or set up',
    '  a merge-on-green monitor (`agents monitors`) that outlives this process.',
    '',
  ];
  return lines.join('\n');
}

/** Tiny chalk-free red for environments where chalk is not wanted on the exit path. */
function chalkRed(s: string): string {
  // Match warn-unpushed: bold red when stderr is a TTY; plain otherwise.
  if (process.stderr.isTTY) return `\u001b[1m\u001b[31m${s}\u001b[0m`;
  return s;
}

/**
 * Probe `cwd` for an open PR on the current branch via `gh pr view`.
 * Fail-open: any error / missing gh → null (never block the run's exit).
 */
export async function getBranchOpenPr(
  cwd: string,
  execFileAsync: (
    file: string,
    args: string[],
    opts: { cwd: string; timeout: number; maxBuffer: number },
  ) => Promise<{ stdout: string }>,
): Promise<BranchOpenPr | null> {
  try {
    const { stdout } = await execFileAsync(
      'gh',
      ['pr', 'view', '--json', 'number,url,state'],
      { cwd, timeout: 5000, maxBuffer: 512 * 1024 },
    );
    const raw = JSON.parse(stdout) as { number?: number; url?: string; state?: string };
    if (!raw?.number || !raw?.url || !raw?.state) return null;
    return { number: Number(raw.number), url: String(raw.url), state: String(raw.state) };
  } catch {
    return null;
  }
}

/**
 * Headless-exit fail-loud: if the cwd's branch has an OPEN PR, print a loud
 * stderr warning. Never throws.
 */
export async function warnOrphanedOpenPr(cwd: string = process.cwd()): Promise<void> {
  try {
    const pr = await getBranchOpenPr(cwd, (file, args, opts) =>
      execFileAsyncDefault(file, args, opts).then((r) => ({ stdout: String(r.stdout ?? '') })),
    );
    if (!shouldWarnOrphanedOpenPr(pr)) return;
    process.stderr.write(formatOrphanedOpenPrWarning(pr as BranchOpenPr));
  } catch {
    // Advisory only — never break the run's exit.
  }
}
