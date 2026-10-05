import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { cachedViewer, emailDigest, parseViewer, viewerCachePath, VIEWER_FRESH_MS, VIEWER_RETRY_MS } from './viewer.js';

const RECORDED = fs.readFileSync(new URL('./testdata/gh-api-user.json', import.meta.url), 'utf-8');
const OCTOCAT = {
  login: 'octocat',
  name: 'The Octocat',
  avatarUrl: 'https://avatars.githubusercontent.com/u/583231?v=4',
  emailSha256: emailDigest('octocat@github.com'),
};
const T0 = 1_800_000_000_000;

const dirs: string[] = [];
const savedPath = process.env.PATH;
afterEach(() => {
  process.env.PATH = savedPath;
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});
function tmp(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'gh-viewer-'));
  dirs.push(d);
  return d;
}

function replay(answer: string | Error) {
  let calls = 0;
  const gh = async (args: string[]) => {
    calls++;
    expect(args).toEqual(['api', 'user', '--cache', '24h', '--jq', '{login, avatar_url, name, email}']);
    if (answer instanceof Error) throw answer;
    return answer;
  };
  return { gh, calls: () => calls };
}

describe('parseViewer', () => {
  it('reads login, name, the https avatar and a digest of the public email — never the email itself', () => {
    const v = parseViewer(RECORDED);
    expect(v).toEqual(OCTOCAT);
    expect(JSON.stringify(v)).not.toContain('octocat@github.com');
  });

  it('drops a non-https avatar and an empty name rather than passing them on', () => {
    expect(parseViewer('{"login":"a","avatar_url":"http://x/y.png","name":"","email":null}'))
      .toEqual({ login: 'a', name: null, avatarUrl: null, emailSha256: null });
    expect(parseViewer('{"login":"","avatar_url":null,"name":null}')).toBeNull();
    expect(parseViewer('gh: not logged in')).toBeNull();
  });
});

describe('cachedViewer', () => {
  it('asks gh once, then answers from the disk record for a day; the record holds no email', async () => {
    const dir = tmp();
    const r = replay(RECORDED);
    expect(await cachedViewer({ gh: r.gh, cacheDir: dir, nowMs: T0 })).toEqual(OCTOCAT);
    expect(await cachedViewer({ gh: r.gh, cacheDir: dir, nowMs: T0 + VIEWER_FRESH_MS })).toEqual(OCTOCAT);
    expect(r.calls()).toBe(1);
    expect(fs.readFileSync(viewerCachePath(dir), 'utf-8')).not.toContain('@');

    expect(await cachedViewer({ gh: r.gh, cacheDir: dir, nowMs: T0 + VIEWER_FRESH_MS + 1 })).toEqual(OCTOCAT);
    expect(r.calls()).toBe(2);
  });

  it('a failed refresh of a stale good record keeps the viewer and retries an hour later', async () => {
    const dir = tmp();
    await cachedViewer({ gh: replay(RECORDED).gh, cacheDir: dir, nowMs: T0 });
    const down = replay(new Error('gh: error connecting to api.github.com'));
    const stale = T0 + VIEWER_FRESH_MS + 1;
    expect(await cachedViewer({ gh: down.gh, cacheDir: dir, nowMs: stale })).toEqual(OCTOCAT);
    expect(await cachedViewer({ gh: down.gh, cacheDir: dir, nowMs: stale + VIEWER_RETRY_MS })).toEqual(OCTOCAT);
    expect(down.calls()).toBe(1);
    expect(await cachedViewer({ gh: down.gh, cacheDir: dir, nowMs: stale + VIEWER_RETRY_MS + 1 })).toEqual(OCTOCAT);
    expect(down.calls()).toBe(2);
  });

  it('records a failure with no prior viewer so gh is retried hourly, not on every poll', async () => {
    const dir = tmp();
    const r = replay(new Error('gh: To get started with GitHub CLI, please run: gh auth login'));
    expect(await cachedViewer({ gh: r.gh, cacheDir: dir, nowMs: T0 })).toBeNull();
    expect(await cachedViewer({ gh: r.gh, cacheDir: dir, nowMs: T0 + VIEWER_RETRY_MS })).toBeNull();
    expect(r.calls()).toBe(1);
  });

  it('distrusts a corrupt, misshapen or future-dated record and asks gh again', async () => {
    const dir = tmp();
    const file = viewerCachePath(dir);
    const ok = { checkedAt: T0, ok: true };
    for (const body of [
      '{"checkedAt": 1800000000000, "ok": tr',
      JSON.stringify({ ...ok, viewer: { ...OCTOCAT, avatarUrl: 'http://insecure/x.png' } }),
      JSON.stringify({ ...ok, viewer: { ...OCTOCAT, name: 42 } }),
      JSON.stringify({ ...ok, viewer: { ...OCTOCAT, emailSha256: 'octocat@github.com' } }),
      JSON.stringify({ checkedAt: T0 + 1_000_000, ok: true, viewer: OCTOCAT }),
    ]) {
      fs.writeFileSync(file, body);
      const r = replay(RECORDED);
      expect(await cachedViewer({ gh: r.gh, cacheDir: dir, nowMs: T0 })).toEqual(OCTOCAT);
      expect(r.calls()).toBe(1);
    }
  });

  it('with no injected runner, spawns the real gh on PATH', async () => {
    const bin = tmp();
    fs.writeFileSync(path.join(bin, 'gh'), `#!/bin/sh\ncat '${new URL('./testdata/gh-api-user.json', import.meta.url).pathname}'\n`, { mode: 0o755 });
    process.env.PATH = `${bin}${path.delimiter}${savedPath}`;
    expect(await cachedViewer({ cacheDir: tmp(), nowMs: T0 })).toEqual(OCTOCAT);
  });
});
