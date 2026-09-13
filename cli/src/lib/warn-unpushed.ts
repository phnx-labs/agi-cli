/**
 * Post-run guard against silently stranded work.
 *
 * A headless `agents run` in a writable mode can end with the agent having
 * committed on a branch but never pushed it — the CLI's exit path does no git
 * work, so those commits sit invisible in a worktree until someone audits the
 * box. This module detects that state and prints a loud stderr warning with the
 * exact push / PR commands. It is advisory only: it never pushes, never mutates
 * the repo, and never throws (a non-repo cwd or any git error yields an inert
 * result), so it can sit on the run's exit path without ever breaking it.
 */
import { execFile } from 'child_process';
import { promisify } from 'util';
import chalk from 'chalk';

const execFileAsync = promisify(execFile);

// Unit-separator byte (0x1f) as the git-log field delimiter: it cannot occur in
// a commit subject, so splitting on it never truncates a subject with spaces.
const SEP = '\x1f';

/**
 * Whether a just-finished run should be checked for stranded work: only
 * writable modes can leave commits (plan is read-only), and only non-interactive
 * runs need the warning (an interactive user sees their own shell). Centralizes
 * the gate so every exit path in the run command applies it identically.
 */
export function shouldWarnUnpushed(mode: string, interactive: boolean): boolean {
  return mode !== 'plan' && !interactive;
}

interface UnpushedState {
  /** cwd is inside a git work tree. */
  isRepo: boolean;
  /** current branch, or null when detached / not a repo. */
  branch: string | null;
  /** the branch has an upstream tracking ref configured. */
  hasUpstream: boolean;
  /** commits reachable from HEAD but not from any remote-tracking ref. */
  unpushed: { sha: string; subject: string }[];
}

const INERT: UnpushedState = { isRepo: false, branch: null, hasUpstream: false, unpushed: [] };

async function git(args: string[], cwd: string): Promise<string> {
  // These are all local, non-prompting reads, but the call sits on a run's exit
  // path — a hard timeout guarantees a wedged git can never delay exit unbounded.
  const { stdout } = await execFileAsync('git', args, { cwd, timeout: 5000 });
  return stdout.trim();
}

/**
 * Inspect `cwd` for commits on the current branch that have not reached any
 * remote. Uses `git log --not --remotes` so it is correct even when the branch
 * has no upstream set: commits already present on some `origin/*` ref are NOT
 * reported (no false positive), and a never-pushed branch reports all its
 * commits. Returns an inert result — never throws — for a non-repo cwd, a
 * detached HEAD, or a repo with no remotes (nothing to push to).
 */
export async function getUnpushedState(cwd: string): Promise<UnpushedState> {
  let branch: string;
  try {
    branch = await git(['rev-parse', '--abbrev-ref', 'HEAD'], cwd);
  } catch {
    return INERT; // not a git repo
  }
  // Detached HEAD: agents commit on branches; nothing nameable to push.
  if (!branch || branch === 'HEAD') {
    return { isRepo: true, branch: null, hasUpstream: false, unpushed: [] };
  }

  // No remote configured -> `--remotes` matches nothing and would report the
  // entire history as "unpushed". There's nowhere to push, so stay silent.
  let hasRemote = false;
  try {
    hasRemote = (await git(['remote'], cwd)).length > 0;
  } catch {
    hasRemote = false;
  }
  if (!hasRemote) {
    return { isRepo: true, branch, hasUpstream: false, unpushed: [] };
  }

  let unpushed: { sha: string; subject: string }[] = [];
  try {
    // HEAD must precede `--not`: everything after `--not` is negated, so
    // `--not --remotes HEAD` would negate HEAD too and always return empty.
    const out = await git(['log', 'HEAD', '--not', '--remotes', `--pretty=format:%h${SEP}%s`], cwd);
    unpushed = out
      ? out.split('\n').map((line) => {
          const idx = line.indexOf(SEP);
          return idx === -1
            ? { sha: line, subject: '' }
            : { sha: line.slice(0, idx), subject: line.slice(idx + 1) };
        })
      : [];
  } catch {
    return { isRepo: true, branch, hasUpstream: false, unpushed: [] };
  }

  let hasUpstream = false;
  try {
    await git(['rev-parse', '--abbrev-ref', '@{u}'], cwd);
    hasUpstream = true;
  } catch {
    hasUpstream = false;
  }

  return { isRepo: true, branch, hasUpstream, unpushed };
}

/**
 * Render the warning for an unpushed state, or null when there is nothing to
 * warn about. Split out from the printer so it is directly testable.
 */
export function formatUnpushedWarning(state: UnpushedState, cwd: string): string | null {
  if (!state.isRepo || !state.branch || state.unpushed.length === 0) return null;

  const n = state.unpushed.length;
  const lines = [`\n⚠ agent left ${n} commit${n === 1 ? '' : 's'} on '${state.branch}' not pushed to any remote:`];
  for (const c of state.unpushed.slice(0, 5)) lines.push(`    ${c.sha} ${c.subject}`);
  if (n > 5) lines.push(`    … and ${n - 5} more`);

  const pushCmd = state.hasUpstream
    ? `git -C "${cwd}" push`
    : `git -C "${cwd}" push -u origin ${state.branch}`;
  lines.push(`  push them:  ${pushCmd}`);
  lines.push(`  open a PR:  gh pr create --head ${state.branch}`);
  return lines.join('\n');
}

/**
 * If the just-finished run left committed-but-unpushed work in `cwd`, print a
 * loud stderr warning with the exact push / PR commands. Non-fatal by contract:
 * any failure is swallowed so it can never break a run's exit path.
 */
export async function warnUnpushedWork(cwd: string): Promise<void> {
  try {
    const warning = formatUnpushedWarning(await getUnpushedState(cwd), cwd);
    if (warning) process.stderr.write(chalk.yellow(warning) + '\n');
  } catch {
    // Advisory only — never break the run over a warning.
  }
}
