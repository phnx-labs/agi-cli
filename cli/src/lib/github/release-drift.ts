
import { execFile } from 'child_process';
import { promisify } from 'util';
import type { GhExec } from './pr-mergeable.js';

const execFileAsync = promisify(execFile);

export interface NpmVersion {
  name: string;
  version: string | null;
  error: string | null;
}

export interface RepoRelease {
  latestTag: string;
  latestTagAt: string;
  mergesSince: number;
  mergesSinceComplete: boolean;
  npm: NpmVersion | null;
}

export type TagRead = Omit<RepoRelease, 'mergesSince' | 'mergesSinceComplete'>;

const SEMVER_TAG = /^v?(\d+)\.(\d+)\.(\d+)$/;

export function latestVersionTag(names: readonly string[]): string | null {
  let best: { name: string; parts: number[] } | null = null;
  for (const name of names) {
    const m = name.match(SEMVER_TAG);
    if (!m) continue;
    const parts = [Number(m[1]), Number(m[2]), Number(m[3])];
    if (!best || (parts[0] - best.parts[0] || parts[1] - best.parts[1] || parts[2] - best.parts[2]) > 0) best = { name, parts };
  }
  return best?.name ?? null;
}

export function packageJsonCandidates(changedFiles: readonly string[]): string[] {
  const changed = changedFiles.filter((f) => f === 'package.json' || f.endsWith('/package.json'));
  return [...new Set([...changed, 'package.json'])];
}

export function releasedPackage(manifest: unknown, version: string): string | null {
  if (typeof manifest !== 'object' || manifest === null) return null;
  const m = manifest as { name?: unknown; version?: unknown; private?: unknown };
  if (typeof m.name !== 'string' || !m.name || m.private === true || m.version !== version) return null;
  return m.name;
}

export const NPM_VERSION_TTL_MS = 60 * 60 * 1000;

export type NpmView = (name: string) => Promise<string>;

export const npmView: NpmView = async (name) => {
  const { stdout } = await execFileAsync('npm', ['view', name, 'version'], { timeout: 5000, encoding: 'utf-8' });
  return stdout.trim();
};

export interface NpmVersionCache {
  get(name: string): { version: string | null; error: string | null; readAt: number } | undefined;
  set(name: string, value: { version: string | null; error: string | null; readAt: number }): void;
}

const isNotFound = (err: unknown) => /\(HTTP 404\)|Not Found/i.test(String((err as { stderr?: unknown })?.stderr ?? err));

export async function readLatestTag(
  slug: string,
  gh: GhExec,
  npm: { view: NpmView; cache: NpmVersionCache; nowMs: number },
): Promise<TagRead | null> {
  const tags = (await gh(['api', `repos/${slug}/tags?per_page=100`, '--paginate', '--cache', '1h', '--jq', '.[] | [.name, .commit.sha] | @tsv']))
    .split('\n').map((l) => l.trim()).filter(Boolean).map((l) => l.split('\t') as [string, string]);
  const latestTag = latestVersionTag(tags.map(([name]) => name));
  if (!latestTag) return null;
  const sha = tags.find(([name]) => name === latestTag)![1];
  const commit = JSON.parse((await gh([
    'api', `repos/${slug}/commits/${sha}`, '--cache', '1h', '--jq', '{date: .commit.committer.date, files: [.files[]?.filename]}',
  ])).trim()) as { date: string; files: string[] };

  const version = latestTag.replace(/^v/, '');
  let name: string | null = null;
  for (const file of packageJsonCandidates(commit.files ?? [])) {
    let manifest: unknown;
    try {
      const encoded = (await gh(['api', `repos/${slug}/contents/${file}?ref=${encodeURIComponent(latestTag)}`, '--cache', '1h', '--jq', '.content'])).trim();
      manifest = JSON.parse(Buffer.from(encoded, 'base64').toString('utf-8'));
    } catch (err) {
      if (isNotFound(err)) continue;
      throw err;
    }
    name = releasedPackage(manifest, version);
    if (name) break;
  }
  return { latestTag, latestTagAt: commit.date, npm: name ? await readNpmVersion(name, npm) : null };
}

async function readNpmVersion(name: string, npm: { view: NpmView; cache: NpmVersionCache; nowMs: number }): Promise<NpmVersion> {
  const hit = npm.cache.get(name);
  const age = hit ? npm.nowMs - hit.readAt : -1;
  if (hit && age >= 0 && age < NPM_VERSION_TTL_MS) return { name, version: hit.version, error: hit.error };
  let read: { version: string | null; error: string | null };
  try {
    const version = await npm.view(name);
    read = version ? { version, error: null } : { version: null, error: `npm has no version of ${name}` };
  } catch (err) {
    const stderr = String((err as { stderr?: unknown })?.stderr ?? '').trim();
    const killed = (err as { killed?: boolean })?.killed;
    read = { version: null, error: killed ? 'npm view timed out after 5 s' : (stderr.split('\n').find(Boolean) ?? String(err)) };
  }
  if (read.version !== null) npm.cache.set(name, { ...read, readAt: npm.nowMs });
  return { name, ...read };
}

export function withMergesSince(
  tag: TagRead,
  merged: ReadonlyArray<{ mergedAt: string; baseRefName: string }> | null,
  window: { sinceMs: number; truncated: boolean; base: string | null },
): RepoRelease {
  const tagMs = Date.parse(tag.latestTagAt);
  const since = (merged ?? []).filter((m) => Date.parse(m.mergedAt) > tagMs && (window.base === null || m.baseRefName === window.base)).length;
  return {
    ...tag,
    mergesSince: since,
    mergesSinceComplete: merged !== null && window.base !== null && tagMs >= window.sinceMs && !window.truncated,
  };
}
