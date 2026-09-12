import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  pickNewestMenubarVersion,
  resolveMenubarVersion,
  cachedMenubarVersion,
  readMenubarResolveCache,
  type ReleaseCandidate,
} from './resolve-version.js';

const ASSETS = ['MenubarHelper.app.zip', 'MenubarHelper.app.zip.sha256', 'menubar-source.txt'];
const rel = (tag: string, extra: Partial<ReleaseCandidate> = {}): ReleaseCandidate => ({ tagName: tag, assets: ASSETS, ...extra });

function tmpCache(): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'menubar-resolve-')), 'latest.json');
}

describe('pickNewestMenubarVersion', () => {
  it('picks the newest menubar tag at or above the floor', () => {
    const tags = [rel('menubar/v1.2.3'), rel('menubar/v1.3.0'), rel('menubar/v1.2.9'), rel('v1.22.102'), rel('computer-mac/v1.0.0')];
    expect(pickNewestMenubarVersion(tags, '1.2.3')).toBe('1.3.0');
  });

  it('never goes below the floor, even when every published build is older', () => {
    expect(pickNewestMenubarVersion([rel('menubar/v1.1.0')], '1.2.3')).toBe('1.2.3');
    expect(pickNewestMenubarVersion([], '1.2.3')).toBe('1.2.3');
  });

  it('ignores drafts, pre-releases, pre-release tags and releases missing the zip or its sha256', () => {
    const tags = [
      rel('menubar/v1.4.0', { draft: true }),
      rel('menubar/v1.4.1', { prerelease: true }),
      rel('menubar/v1.4.2-pre.1'),
      rel('menubar/v1.4.3', { assets: ['MenubarHelper.app.zip'] }),
      rel('menubar/v1.4.4', { assets: ['MenubarHelper.app.zip.sha256'] }),
      rel('menubar/v1.3.0'),
    ];
    expect(pickNewestMenubarVersion(tags, '1.2.3')).toBe('1.3.0');
  });
});

describe('resolveMenubarVersion', () => {
  const releases = (tags: string[]) => async () => ({
    ok: true, status: 200,
    json: async () => tags.map((t) => ({ tag_name: t, assets: ASSETS.map((name) => ({ name })) })),
  });

  it('reads the release list, caches the answer and serves the cache while fresh', async () => {
    const file = tmpCache();
    let calls = 0;
    const fetchImpl = async () => { calls++; return releases(['menubar/v1.3.0', 'menubar/v1.2.3'])(); };
    expect(await resolveMenubarVersion({ floor: '1.2.3', cacheFile: file, now: 1_000, fetchImpl })).toBe('1.3.0');
    expect(readMenubarResolveCache(file)).toEqual({ checkedAt: 1_000, version: '1.3.0' });
    expect(await resolveMenubarVersion({ floor: '1.2.3', cacheFile: file, now: 2_000, fetchImpl })).toBe('1.3.0');
    expect(calls).toBe(1);
  });

  it('re-reads after the ttl and on force', async () => {
    const file = tmpCache();
    let calls = 0;
    const fetchImpl = async () => { calls++; return releases(['menubar/v1.3.0'])(); };
    await resolveMenubarVersion({ floor: '1.2.3', cacheFile: file, now: 0, ttlMs: 100, fetchImpl });
    await resolveMenubarVersion({ floor: '1.2.3', cacheFile: file, now: 50, ttlMs: 100, fetchImpl });
    await resolveMenubarVersion({ floor: '1.2.3', cacheFile: file, now: 150, ttlMs: 100, fetchImpl });
    await resolveMenubarVersion({ floor: '1.2.3', cacheFile: file, now: 160, ttlMs: 100, fetchImpl, force: true });
    expect(calls).toBe(3);
  });

  it('falls back to the cached answer, then the floor, when the network fails', async () => {
    const file = tmpCache();
    const failing = async () => { throw new Error('offline'); };
    expect(await resolveMenubarVersion({ floor: '1.2.3', cacheFile: file, fetchImpl: failing })).toBe('1.2.3');
    fs.writeFileSync(file, JSON.stringify({ checkedAt: 0, version: '1.3.0' }));
    expect(await resolveMenubarVersion({ floor: '1.2.3', cacheFile: file, now: 10 ** 12, fetchImpl: failing })).toBe('1.3.0');
    const http403 = async () => ({ ok: false, status: 403, json: async () => ({}) });
    expect(await resolveMenubarVersion({ floor: '1.2.3', cacheFile: file, now: 10 ** 12, fetchImpl: http403 })).toBe('1.3.0');
  });

  it('a cache below a raised floor is ignored: the floor wins', async () => {
    const file = tmpCache();
    fs.writeFileSync(file, JSON.stringify({ checkedAt: 0, version: '1.1.0' }));
    expect(cachedMenubarVersion({ floor: '1.2.3', cacheFile: file })).toBe('1.2.3');
    const failing = async () => { throw new Error('offline'); };
    expect(await resolveMenubarVersion({ floor: '1.2.3', cacheFile: file, fetchImpl: failing })).toBe('1.2.3');
  });

  it('a corrupt cache reads as no cache', () => {
    const file = tmpCache();
    fs.writeFileSync(file, '{not json');
    expect(readMenubarResolveCache(file)).toBeNull();
    fs.writeFileSync(file, JSON.stringify({ checkedAt: 'x', version: 'latest' }));
    expect(readMenubarResolveCache(file)).toBeNull();
  });
});
