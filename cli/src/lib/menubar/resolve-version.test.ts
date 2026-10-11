import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { fileURLToPath } from 'node:url';
import {
  MENUBAR_LS_REFS_REQUEST,
  parseLsRefsTags,
  pickNewestMenubarVersion,
  resolveMenubarVersion,
  cachedMenubarVersion,
  readMenubarResolveCache,
} from './resolve-version.js';

const LS_REFS = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'testdata', 'ls-refs-menubar.txt'));

function tmpCache(): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'menubar-resolve-')), 'latest.json');
}

describe('git ls-refs wire format', () => {
  it('asks only for menubar tags', () => {
    expect(MENUBAR_LS_REFS_REQUEST).toBe('0014command=ls-refs\n00010022ref-prefix refs/tags/menubar/\n0000');
  });

  it('parses the real response into tag names', () => {
    const tags = parseLsRefsTags(LS_REFS);
    expect(tags).toHaveLength(65);
    expect(tags).toContain('menubar/v1.0.0');
    expect(tags).toContain('menubar/v1.15.25');
    expect(tags).toContain('menubar/v1.1.2-pre.1');
    expect(tags.every((t) => t.startsWith('menubar/'))).toBe(true);
  });

  it('rejects a truncated, malformed or error response', () => {
    expect(() => parseLsRefsTags(LS_REFS.subarray(0, LS_REFS.length - 4))).toThrow('without a flush packet');
    expect(() => parseLsRefsTags(LS_REFS.subarray(0, 30))).toThrow('malformed');
    expect(() => parseLsRefsTags(Buffer.from('zzzz0000'))).toThrow('malformed');
    expect(() => parseLsRefsTags(Buffer.from('0015ERR access denied0000'))).toThrow('tag list: access denied');
  });
});

describe('pickNewestMenubarVersion', () => {
  const all = async () => true;

  it('picks the newest menubar tag above the floor, probing newest first and nothing at or below the floor', async () => {
    const probed: string[] = [];
    const tags = ['menubar/v1.2.3', 'menubar/v1.3.0', 'menubar/v1.2.9', 'v1.22.102', 'computer-mac/v9.0.0'];
    expect(await pickNewestMenubarVersion(tags, '1.2.3', async (v) => { probed.push(v); return true; })).toBe('1.3.0');
    expect(probed).toEqual(['1.3.0']);
  });

  it('never goes below the floor, even when every published build is older', async () => {
    expect(await pickNewestMenubarVersion(['menubar/v1.1.0'], '1.2.3', all)).toBe('1.2.3');
    expect(await pickNewestMenubarVersion([], '1.2.3', all)).toBe('1.2.3');
  });

  it('skips pre-release tags and tags whose zip and sha256 are not both published', async () => {
    const probed: string[] = [];
    const tags = ['menubar/v1.4.2-pre.1', 'menubar/v1.4.3', 'menubar/v1.3.0', 'menubar/v1.4.0'];
    const published = new Set(['1.3.0']);
    expect(await pickNewestMenubarVersion(tags, '1.2.3', async (v) => { probed.push(v); return published.has(v); })).toBe('1.3.0');
    expect(probed).toEqual(['1.4.3', '1.4.0', '1.3.0']);
    expect(await pickNewestMenubarVersion(tags, '1.2.3', async () => false)).toBe('1.2.3');
  });
});

describe('resolveMenubarVersion over github.com', () => {
  let server: Server;
  let origin = '';
  let requests: Array<{ method: string; url: string; headers: IncomingMessage['headers']; body: string }> = [];
  let published = new Set<string>();
  let assetStatus = 0;
  let listStatus = 200;

  beforeAll(async () => {
    server = createServer((req, res) => {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        requests.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers, body });
        if (req.url === '/phnx-labs/agi-cli.git/git-upload-pack') {
          res.writeHead(listStatus, { 'Content-Type': 'application/x-git-upload-pack-result' });
          res.end(listStatus === 200 ? LS_REFS : '');
          return;
        }
        const asset = /^\/phnx-labs\/agi-cli\/releases\/download\/menubar\/v([\d.]+)\/(MenubarHelper\.app\.zip(?:\.sha256)?)$/.exec(req.url ?? '');
        if (assetStatus) { res.writeHead(assetStatus); res.end(); return; }
        if (asset && published.has(`${asset[1]}/${asset[2]}`)) {
          res.writeHead(302, { Location: 'https://release-assets.example/blob' });
        } else {
          res.writeHead(404);
        }
        res.end();
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  });
  afterAll(async () => { await new Promise<void>((resolve) => server.close(() => resolve())); });
  beforeEach(() => {
    requests = [];
    assetStatus = 0;
    listStatus = 200;
    published = new Set(['1.15.25', '1.15.24'].flatMap((v) => [`${v}/MenubarHelper.app.zip`, `${v}/MenubarHelper.app.zip.sha256`]));
  });

  const fetchImpl: NonNullable<Parameters<typeof resolveMenubarVersion>[0]>['fetchImpl'] = (url, init) => {
    expect(url.startsWith('https://github.com/')).toBe(true);
    return fetch(url.replace('https://github.com', origin), init);
  };
  const lists = () => requests.filter((r) => r.method === 'POST').length;

  it('lists tags with one git ls-refs POST, confirms both assets with HEAD, and caches the answer', async () => {
    const file = tmpCache();
    expect(await resolveMenubarVersion({ floor: '1.15.21', cacheFile: file, now: 1_000, fetchImpl })).toBe('1.15.25');
    expect(requests.map((r) => `${r.method} ${r.url}`).sort()).toEqual([
      'HEAD /phnx-labs/agi-cli/releases/download/menubar/v1.15.25/MenubarHelper.app.zip',
      'HEAD /phnx-labs/agi-cli/releases/download/menubar/v1.15.25/MenubarHelper.app.zip.sha256',
      'POST /phnx-labs/agi-cli.git/git-upload-pack',
    ]);
    const list = requests.find((r) => r.method === 'POST')!;
    expect(list.headers['git-protocol']).toBe('version=2');
    expect(list.body).toBe(MENUBAR_LS_REFS_REQUEST);
    expect(readMenubarResolveCache(file)).toEqual({ checkedAt: 1_000, version: '1.15.25' });
    expect(await resolveMenubarVersion({ floor: '1.15.21', cacheFile: file, now: 2_000, fetchImpl })).toBe('1.15.25');
    expect(lists()).toBe(1);
  });

  it('a tag whose sha256 is not published yet (or a draft, which serves no download) is skipped', async () => {
    published.delete('1.15.25/MenubarHelper.app.zip.sha256');
    expect(await resolveMenubarVersion({ floor: '1.15.21', cacheFile: tmpCache(), fetchImpl })).toBe('1.15.24');
    published.clear();
    expect(await resolveMenubarVersion({ floor: '1.15.21', cacheFile: tmpCache(), fetchImpl })).toBe('1.15.21');
  });

  it('re-reads after the ttl and on force', async () => {
    const file = tmpCache();
    await resolveMenubarVersion({ floor: '1.15.21', cacheFile: file, now: 0, ttlMs: 100, fetchImpl });
    await resolveMenubarVersion({ floor: '1.15.21', cacheFile: file, now: 50, ttlMs: 100, fetchImpl });
    await resolveMenubarVersion({ floor: '1.15.21', cacheFile: file, now: 150, ttlMs: 100, fetchImpl });
    await resolveMenubarVersion({ floor: '1.15.21', cacheFile: file, now: 160, ttlMs: 100, fetchImpl, force: true });
    expect(lists()).toBe(3);
  });

  it('falls back to the cached answer, then the floor, unless strict', async () => {
    const file = tmpCache();
    const failing = async () => { throw new Error('offline'); };
    expect(await resolveMenubarVersion({ floor: '1.2.3', cacheFile: file, fetchImpl: failing })).toBe('1.2.3');
    fs.writeFileSync(file, JSON.stringify({ checkedAt: 0, version: '1.3.0' }));
    expect(await resolveMenubarVersion({ floor: '1.2.3', cacheFile: file, now: 10 ** 12, fetchImpl: failing })).toBe('1.3.0');
    listStatus = 429;
    expect(await resolveMenubarVersion({ floor: '1.2.3', cacheFile: file, now: 10 ** 12, fetchImpl })).toBe('1.3.0');
    await expect(resolveMenubarVersion({ floor: '1.2.3', cacheFile: file, strict: true, fetchImpl })).rejects.toThrow('tag list: HTTP 429');
    listStatus = 200;
    assetStatus = 500;
    await expect(resolveMenubarVersion({ floor: '1.2.3', cacheFile: file, strict: true, fetchImpl })).rejects.toThrow('release asset check: HTTP 500');
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
