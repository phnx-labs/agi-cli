/**
 * Release drift for `agents projects prs`: a repository's latest version tag, when
 * it was cut, and what npm serves for the package that tag released, so AGI Menu
 * can say "v1.22.121 tagged · npm still 1.22.120 · 1 merge since" without a
 * browser trip.
 *
 * Every GitHub read is REST and cached by gh for an hour (`--cache 1h`); the npm
 * version is `npm view <name> version` (5 s timeout), cached for an hour in
 * `project-npm-versions.json`. The merge count costs nothing: it is the repo's
 * `recentlyMerged` list filtered by the tag time.
 */

import { execFile } from 'child_process';
import { promisify } from 'util';
import type { GhExec } from './pr-mergeable.js';

const execFileAsync = promisify(execFile);

/** What npm serves for the package the latest tag released. */
export interface NpmVersion {
  name: string;
  /** The `latest` dist-tag version; null when npm could not be read. */
  version: string | null;
  /** Why `version` is null; null when it was read. */
  error: string | null;
}

/** The latest version tag of a repository and what has happened since. */
export interface RepoRelease {
  /** The highest `vX.Y.Z` / `X.Y.Z` tag (prefixed tags such as `menubar/v1.2.0` are another train and ignored). */
  latestTag: string;
  /** When the tagged commit was committed. */
  latestTagAt: string;
  /** PRs in `recentlyMerged` merged into the default branch after `latestTagAt`. */
  mergesSince: number;
  /** False when `mergesSince` may be short: the tag predates the merged window, the merged list was truncated or unread, or the default branch is unknown. */
  mergesSinceComplete: boolean;
  /** Null when no package.json in the tagged commit (or at the root) is public and carries the tag's version. */
  npm: NpmVersion | null;
}

/** A tag read: the latest version tag, its time, and npm's view of its package. `mergesSince` is filled by the caller. */
export type TagRead = Omit<RepoRelease, 'mergesSince' | 'mergesSinceComplete'>;

const SEMVER_TAG = /^v?(\d+)\.(\d+)\.(\d+)$/;

/** The highest plain semver tag name, or null. Pre-releases and prefixed tags never count. */
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

/** The package.json paths a release commit could have bumped: every package.json it changed, then the root one. */
export function packageJsonCandidates(changedFiles: readonly string[]): string[] {
  const changed = changedFiles.filter((f) => f === 'package.json' || f.endsWith('/package.json'));
  return [...new Set([...changed, 'package.json'])];
}

/** The public package a package.json describes at `version`, or null (private, nameless, or another version). */
export function releasedPackage(manifest: unknown, version: string): string | null {
  if (typeof manifest !== 'object' || manifest === null) return null;
  const m = manifest as { name?: unknown; version?: unknown; private?: unknown };
  if (typeof m.name !== 'string' || !m.name || m.private === true || m.version !== version) return null;
  return m.name;
}

/** How long an npm version read is trusted. */
export const NPM_VERSION_TTL_MS = 60 * 60 * 1000;

/** The `npm view` runner; injected by tests that must not reach the registry. */
export type NpmView = (name: string) => Promise<string>;

/** `npm view <name> version` with a 5 s timeout. Throws on a non-zero exit or a timeout. */
export const npmView: NpmView = async (name) => {
  const { stdout } = await execFileAsync('npm', ['view', name, 'version'], { timeout: 5000, encoding: 'utf-8' });
  return stdout.trim();
};

/** The npm version cache: package name → the version read and when. */
export interface NpmVersionCache {
  get(name: string): { version: string | null; error: string | null; readAt: number } | undefined;
  set(name: string, value: { version: string | null; error: string | null; readAt: number }): void;
}

/** True for gh's "not found" failure, the normal answer for a repository with no root package.json. */
const isNotFound = (err: unknown) => /\(HTTP 404\)|Not Found/i.test(String((err as { stderr?: unknown })?.stderr ?? err));

/**
 * Read a repository's latest version tag, the tagged commit's time, and npm's
 * version of the package that commit released. Null when the repository has no
 * version tag. A package.json that does not exist is skipped; any other failure
 * throws, so the caller reports it instead of showing a repository as current.
 */
export async function readLatestTag(
  slug: string,
  gh: GhExec,
  npm: { view: NpmView; cache: NpmVersionCache; nowMs: number },
): Promise<TagRead | null> {
  // Every page: the highest version is computed here, not taken from GitHub's listing order.
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

/** npm's version of `name`, from the cache within {@link NPM_VERSION_TTL_MS}, else one `npm view`. */
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
  // Only an answer is cached: a timeout or a missing npm must not blank the version for an hour.
  if (read.version !== null) npm.cache.set(name, { ...read, readAt: npm.nowMs });
  return { name, ...read };
}

/**
 * Complete a tag read with the merges into `base` (the default branch) since it.
 * `merged` is the repository's
 * scoped merges in the window, before the 20-row cap (null when they could not be
 * read); the count is complete only when the tag falls inside the merged window
 * and the closed-PR scan was not truncated.
 */
export function withMergesSince(
  tag: TagRead,
  merged: ReadonlyArray<{ mergedAt: string; baseRefName: string }> | null,
  window: { sinceMs: number; truncated: boolean; base: string | null },
): RepoRelease {
  const tagMs = Date.parse(tag.latestTagAt);
  // Without the default branch's name every base counts, and the count is not complete.
  const since = (merged ?? []).filter((m) => Date.parse(m.mergedAt) > tagMs && (window.base === null || m.baseRefName === window.base)).length;
  return {
    ...tag,
    mergesSince: since,
    mergesSinceComplete: merged !== null && window.base !== null && tagMs >= window.sinceMs && !window.truncated,
  };
}
