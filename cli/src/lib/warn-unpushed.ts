/** Post-run guard against stranded work: a headless writable run can end with commits never pushed.
 * Prints a stderr warning with the push/PR commands. Advisory only: never pushes, mutates, or
 * throws. */
import { execFile } from 'child_process';
import { promisify } from 'util';
import chalk from 'chalk';

const execFileAsync = promisify(execFile);

// Unit-separator byte (0x1f) as the git-log field delimiter: it cannot occur in
// a commit subject, so splitting on it never truncates a subject with spaces.
const SEP = '\x1f';

/** Whether a finished run should be checked: only writable modes (plan is read-only) and only
 * non-interactive runs. Centralized so every exit path applies it identically. */
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

/** Commits on the current branch not on any remote, via `git log --not --remotes` (works without an
 * upstream). Inert, never throws, for a non-repo, detached HEAD, or no remotes. */
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

/** Render the warning for an unpushed state, or null when nothing to warn about; split out for
 * testing. */
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

/** If the run left committed-but-unpushed work in `cwd`, print a loud stderr warning with push/PR
 * commands. Failures are swallowed so the run's exit path never breaks. */
export async function warnUnpushedWork(cwd: string): Promise<void> {
  try {
    const warning = formatUnpushedWarning(await getUnpushedState(cwd), cwd);
    if (warning) process.stderr.write(chalk.yellow(warning) + '\n');
  } catch {
    // Advisory only — never break the run over a warning.
  }
}
