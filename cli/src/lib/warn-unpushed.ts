import { execFile } from 'child_process';
import { promisify } from 'util';
import chalk from 'chalk';

const execFileAsync = promisify(execFile);

const SEP = '\x1f';

export function shouldWarnUnpushed(mode: string, interactive: boolean): boolean {
  // Advisory only for writable noninteractive runs; it never mutates, blocks, or throws.
  return mode !== 'plan' && !interactive;
}

interface UnpushedState {
  isRepo: boolean;
  branch: string | null;
  hasUpstream: boolean;
  unpushed: { sha: string; subject: string }[];
}

const INERT: UnpushedState = { isRepo: false, branch: null, hasUpstream: false, unpushed: [] };

// Every probe is bounded to five seconds.
async function git(args: string[], cwd: string): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd, timeout: 5000 });
  return stdout.trim();
}

export async function getUnpushedState(cwd: string): Promise<UnpushedState> {
  let branch: string;
  try {
    branch = await git(['rev-parse', '--abbrev-ref', 'HEAD'], cwd);
  } catch {
    return INERT;
  }
  if (!branch || branch === 'HEAD') {
    return { isRepo: true, branch: null, hasUpstream: false, unpushed: [] };
  }

  let hasRemote = false;
  try {
    hasRemote = (await git(['remote'], cwd)).length > 0;
  } catch {
    hasRemote = false;
  }
  if (!hasRemote) {
    // With no remote there is no actionable push command to recommend.
    return { isRepo: true, branch, hasUpstream: false, unpushed: [] };
  }

  let unpushed: { sha: string; subject: string }[] = [];
  try {
    // HEAD must precede --not --remotes; unit separator preserves spaces in subjects.
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

export async function warnUnpushedWork(cwd: string): Promise<void> {
  try {
    const warning = formatUnpushedWarning(await getUnpushedState(cwd), cwd);
    if (warning) process.stderr.write(chalk.yellow(warning) + '\n');
  } catch {
  }
}
