/** Where a project's work went, from local git history: no API call, credential or rate-limit budget
 * (0.23s for 897 commits), so unconditional. Deliberately not `gh`, which costs a request per PR
 * and is wrong for monorepo subdirectories. */

import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

/** One directory and how many file-touches landed in it during the window. */
export interface FocusArea {
  path: string;
  touches: number;
}

/** How deep a bucket goes: `apps/cli/src`, not `apps` and not every leaf file. */
const DEPTH = 3;
/** Areas shown on the card before the tail is dropped. */
export const FOCUS_LIMIT = 4;

/** Paths whose churn is process, not engineering: `.changelog` fragments (one per PR) would rank
 * second by file-touches and just count PRs; same for CHANGELOG and lockfiles. */
const NOISE = /(^|\/)(\.changelog|CHANGELOG\.md|bun\.lock|package-lock\.json|yarn\.lock)(\/|$)/;

/** Bucket a file path to its area; files shallower than {@link DEPTH} bucket to their own directory
 * so a root `README.md` doesn't vanish. */
export function focusBucket(file: string): string | undefined {
  if (NOISE.test(file)) return undefined;
  const parts = file.split('/').filter(Boolean);
  if (parts.length === 0) return undefined;
  if (parts.length === 1) return parts[0];
  return parts.slice(0, Math.min(DEPTH, parts.length - 1)).join('/');
}

/** Rank areas by file-touches descending, ties broken by path for stable order. Pure: the caller
 * supplies the file list. */
export function rankFocusAreas(files: string[], limit = FOCUS_LIMIT): FocusArea[] {
  const counts = new Map<string, number>();
  for (const f of files) {
    const bucket = focusBucket(f.trim());
    if (!bucket) continue;
    counts.set(bucket, (counts.get(bucket) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([path, touches]) => ({ path, touches }))
    .sort((a, b) => b.touches - a.touches || a.path.localeCompare(b.path))
    .slice(0, Math.max(1, limit));
}

/** Read the window's changed files from a checkout; a missing checkout, shallow clone, or no commits
 * yields an empty list, never a throw. Reads the LOCAL default branch ref without fetching, since a
 * status command must not mutate the repo; freshness is the user's last fetch. */
export async function readFocusAreas(root: string, windowDays: number): Promise<FocusArea[]> {
  try {
    const { stdout } = await execFileAsync(
      'git',
      ['-C', root, 'log', `--since=${windowDays} days ago`, '--name-only', '--pretty=format:'],
      { timeout: 5000, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 },
    );
    return rankFocusAreas(stdout.split('\n').filter((l) => l.trim().length > 0));
  } catch {
    return [];
  }
}

/** Compact count: 2329 → "2.3k", under 1000 stays exact. */
export function formatFocusCount(n: number): string {
  if (!Number.isFinite(n) || n < 0) return '0';
  if (n < 1000) return String(Math.round(n));
  const k = n / 1000;
  const s = k >= 10 ? String(Math.round(k)) : k.toFixed(1).replace(/\.0$/, '');
  return `${s}k`;
}

/** One scannable focus line: path + count with a single unit trailer so the integer isn't read as
 * commits or minutes, e.g. `apps/cli/src 2.3k  ·  apps/cli/docs 302  file-touches (7d)`. */
export function formatFocusAreas(areas: FocusArea[], windowDays: number): string {
  if (areas.length === 0) return '';
  const body = areas.map((a) => `${a.path} ${formatFocusCount(a.touches)}`).join('  ·  ');
  const unit = `file-touches (${windowDays}d)`;
  return `${body}  ${unit}`;
}

