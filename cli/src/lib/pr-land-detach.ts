import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsyncDefault = promisify(execFile);

interface BranchOpenPr {
  number: number;
  url: string;
  state: string;
}

export function shouldWarnOrphanedOpenPr(pr: BranchOpenPr | null): boolean {
  if (!pr) return false;
  return pr.state.toUpperCase() === 'OPEN';
}

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

function chalkRed(s: string): string {
  if (process.stderr.isTTY) return `\u001b[1m\u001b[31m${s}\u001b[0m`;
  return s;
}

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
