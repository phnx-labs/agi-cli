
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

export interface FocusArea {
  path: string;
  touches: number;
}

const DEPTH = 3;
export const FOCUS_LIMIT = 4;

// Focus is local read-only git history: no fetch/API; churn is excluded and counts are file touches.
const NOISE = /(^|\/)(\.changelog|CHANGELOG\.md|bun\.lock|package-lock\.json|yarn\.lock)(\/|$)/;

export function focusBucket(file: string): string | undefined {
  if (NOISE.test(file)) return undefined;
  const parts = file.split('/').filter(Boolean);
  if (parts.length === 0) return undefined;
  if (parts.length === 1) return parts[0];
  return parts.slice(0, Math.min(DEPTH, parts.length - 1)).join('/');
}

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

export function formatFocusCount(n: number): string {
  if (!Number.isFinite(n) || n < 0) return '0';
  if (n < 1000) return String(Math.round(n));
  const k = n / 1000;
  const s = k >= 10 ? String(Math.round(k)) : k.toFixed(1).replace(/\.0$/, '');
  return `${s}k`;
}

export function formatFocusAreas(areas: FocusArea[], windowDays: number): string {
  if (areas.length === 0) return '';
  const body = areas.map((a) => `${a.path} ${formatFocusCount(a.touches)}`).join('  ·  ');
  const unit = `file-touches (${windowDays}d)`;
  return `${body}  ${unit}`;
}
