import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import {
  latestVersionTag,
  NPM_VERSION_TTL_MS,
  packageJsonCandidates,
  readLatestTag,
  releasedPackage,
  withMergesSince,
  type NpmVersionCache,
} from './release-drift.js';

const testdata = (name: string) => fs.readFileSync(path.join(__dirname, 'testdata', name), 'utf-8');

// Recorded from phnx-labs/agi-cli on 2026-10-04: v1.22.121 is tagged on the
// release commit a752915, which bumped cli/package.json; npm still served 1.22.120.
const REPO = 'phnx-labs/agi-cli';
const TAG_SHA = 'a7529150a0e1adc9b3fa2135b063a6bbf726f3be';
const tagNames = () => testdata('agi-cli-tags.tsv').trim().split('\n').map((l) => l.split('\t')[0]);

function recordedGh(routes: Record<string, string | Error>) {
  const asked: string[][] = [];
  const gh = async (args: string[]) => {
    asked.push(args);
    const hit = routes[args[1]];
    if (hit === undefined) throw new Error(`unexpected gh ${args.join(' ')}`);
    if (hit instanceof Error) throw hit;
    return hit;
  };
  return { gh, asked };
}

const ghError = (stderr: string) => Object.assign(new Error('Command failed: gh'), { stderr });

function memoryCache(): NpmVersionCache & { entries: Map<string, { version: string | null; error: string | null; readAt: number }> } {
  const entries = new Map<string, { version: string | null; error: string | null; readAt: number }>();
  return { entries, get: (n) => entries.get(n), set: (n, v) => entries.set(n, v) };
}

const routes = {
  [`repos/${REPO}/tags?per_page=100`]: testdata('agi-cli-tags.tsv'),
  [`repos/${REPO}/commits/${TAG_SHA}`]: testdata('agi-cli-release-commit.json'),
  [`repos/${REPO}/contents/cli/package.json?ref=v1.22.121`]: testdata('agi-cli-package-json-v1.22.121.b64'),
  [`repos/${REPO}/contents/package.json?ref=v1.22.121`]: ghError(testdata('agi-cli-root-package-json-404.stderr')),
};

describe('release drift parts', () => {
  it('picks the highest plain version tag and ignores other release trains', () => {
    expect(latestVersionTag(tagNames())).toBe('v1.22.121');
    expect(latestVersionTag(['menubar/v9.0.0', 'v1.2.10', 'v1.2.9', 'v1.3.0-rc.1'])).toBe('v1.2.10');
    expect(latestVersionTag(['menubar/v1.11.0', 'nightly'])).toBeNull();
  });

  it('looks for the released package in the package.json files the release commit changed, then the root', () => {
    const files = (JSON.parse(testdata('agi-cli-release-commit.json')) as { files: string[] }).files;
    expect(packageJsonCandidates(files)).toEqual(['cli/package.json', 'package.json']);
  });

  it('names only a public package carrying the tag\'s version', () => {
    const manifest = JSON.parse(Buffer.from(testdata('agi-cli-package-json-v1.22.121.b64').trim(), 'base64').toString('utf-8'));
    expect(releasedPackage(manifest, '1.22.121')).toBe('@phnx-labs/agents-cli');
    expect(releasedPackage(manifest, '1.22.120')).toBeNull();
    expect(releasedPackage({ ...manifest, private: true }, '1.22.121')).toBeNull();
  });

  it('counts the merges after the tag, and says when the window cannot see them all', () => {
    const tag = { latestTag: 'v1.22.121', latestTagAt: '2026-10-04T15:40:42Z', npm: null };
    const merged = [{ mergedAt: '2026-10-04T22:00:00Z' }, { mergedAt: '2026-10-04T15:42:33Z' }, { mergedAt: '2026-10-04T15:08:06Z' }];
    const sinceMs = Date.parse('2026-09-28T00:00:00Z');
    expect(withMergesSince(tag, merged, { sinceMs, truncated: false })).toMatchObject({ mergesSince: 2, mergesSinceComplete: true });
    expect(withMergesSince(tag, merged, { sinceMs, truncated: true }).mergesSinceComplete).toBe(false);
    expect(withMergesSince(tag, merged, { sinceMs: Date.parse('2026-10-05T00:00:00Z'), truncated: false }).mergesSinceComplete).toBe(false);
    expect(withMergesSince(tag, null, { sinceMs, truncated: false })).toMatchObject({ mergesSince: 0, mergesSinceComplete: false });
  });
});

describe('readLatestTag', () => {
  const nowMs = Date.parse('2026-10-04T23:30:00Z');

  it('reads the tag, its commit time and npm\'s version of the package it released', async () => {
    const { gh } = recordedGh(routes);
    const viewed: string[] = [];
    const cache = memoryCache();
    const read = await readLatestTag(REPO, gh, { view: async (n) => { viewed.push(n); return '1.22.120'; }, cache, nowMs });
    expect(read).toEqual({
      latestTag: 'v1.22.121',
      latestTagAt: '2026-10-04T15:40:42Z',
      npm: { name: '@phnx-labs/agents-cli', version: '1.22.120', error: null },
    });
    expect(viewed).toEqual(['@phnx-labs/agents-cli']);

    // Within the hour npm is not asked again; after it, it is.
    await readLatestTag(REPO, gh, { view: async (n) => { viewed.push(n); return '1.22.120'; }, cache, nowMs: nowMs + 60_000 });
    expect(viewed).toHaveLength(1);
    await readLatestTag(REPO, gh, { view: async (n) => { viewed.push(n); return '1.22.121'; }, cache, nowMs: nowMs + NPM_VERSION_TTL_MS });
    expect(viewed).toHaveLength(2);
  });

  it('caches every GitHub read for an hour through gh', async () => {
    const { gh, asked } = recordedGh(routes);
    await readLatestTag(REPO, gh, { view: async () => '1.22.120', cache: memoryCache(), nowMs });
    for (const args of asked) expect(args.slice(args.indexOf('--cache'), args.indexOf('--cache') + 2)).toEqual(['--cache', '1h']);
  });

  it('says why npm could not be read instead of reporting no version', async () => {
    const { gh } = recordedGh(routes);
    const timedOut = Object.assign(new Error('Command failed: npm view'), { killed: true, stderr: '' });
    const read = await readLatestTag(REPO, gh, { view: async () => { throw timedOut; }, cache: memoryCache(), nowMs });
    expect(read?.npm).toEqual({ name: '@phnx-labs/agents-cli', version: null, error: 'npm view timed out after 5 s' });
  });

  it('is null for a repository with no version tag, and throws on a read that is not a missing file', async () => {
    const none = recordedGh({ [`repos/${REPO}/tags?per_page=100`]: 'menubar/v1.11.0\tabc\n' });
    expect(await readLatestTag(REPO, none.gh, { view: async () => '0', cache: memoryCache(), nowMs })).toBeNull();
    const limited = recordedGh({ ...routes, [`repos/${REPO}/contents/cli/package.json?ref=v1.22.121`]: ghError('gh: API rate limit exceeded (HTTP 403)\n') });
    await expect(readLatestTag(REPO, limited.gh, { view: async () => '0', cache: memoryCache(), nowMs })).rejects.toThrow();
  });
});
