import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { cachedViewer, parseViewer, viewerCachePath, VIEWER_FRESH_MS, VIEWER_RETRY_MS } from './viewer.js';

/** Real `gh api users/octocat --jq '{login, avatar_url, name}'` output. */
const RECORDED = fs.readFileSync(new URL('./testdata/gh-api-user.json', import.meta.url), 'utf-8');
const OCTOCAT = { login: 'octocat', name: 'The Octocat', avatarUrl: 'https://avatars.githubusercontent.com/u/583231?v=4' };

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});
function tmp(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'gh-viewer-'));
  dirs.push(d);
  return d;
}

/** Replays the recorded REST answer (or a failure) and counts the spawns. */
function replay(answer: string | Error) {
  let calls = 0;
  const gh = async (args: string[]) => {
    calls++;
    expect(args).toEqual(['api', 'user', '--cache', '24h', '--jq', '{login, avatar_url, name}']);
    if (answer instanceof Error) throw answer;
    return answer;
  };
  return { gh, calls: () => calls };
}

describe('parseViewer', () => {
  it('reads login, name and the https avatar from the recorded gh output', () => {
    expect(parseViewer(RECORDED)).toEqual(OCTOCAT);
  });

  it('drops a non-https avatar and an empty name rather than passing them on', () => {
    expect(parseViewer('{"login":"a","avatar_url":"http://x/y.png","name":""}')).toEqual({ login: 'a', name: null, avatarUrl: null });
    expect(parseViewer('{"login":"","avatar_url":null,"name":null}')).toBeNull();
    expect(parseViewer('gh: not logged in')).toBeNull();
  });
});

describe('cachedViewer', () => {
  it('asks gh once, then answers from the disk record for a day', async () => {
    const dir = tmp();
    const r = replay(RECORDED);
    const t0 = 1_800_000_000_000;
    expect(await cachedViewer({ gh: r.gh, cacheDir: dir, nowMs: t0 })).toEqual(OCTOCAT);
    expect(await cachedViewer({ gh: r.gh, cacheDir: dir, nowMs: t0 + VIEWER_FRESH_MS })).toEqual(OCTOCAT);
    expect(r.calls()).toBe(1);
    expect(JSON.parse(fs.readFileSync(viewerCachePath(dir), 'utf-8'))).not.toHaveProperty('viewer.email');

    expect(await cachedViewer({ gh: r.gh, cacheDir: dir, nowMs: t0 + VIEWER_FRESH_MS + 1 })).toEqual(OCTOCAT);
    expect(r.calls()).toBe(2);
  });

  it('records a failed read so gh is retried hourly, not on every poll', async () => {
    const dir = tmp();
    const r = replay(new Error('gh: To get started with GitHub CLI, please run: gh auth login'));
    const t0 = 1_800_000_000_000;
    expect(await cachedViewer({ gh: r.gh, cacheDir: dir, nowMs: t0 })).toBeNull();
    expect(await cachedViewer({ gh: r.gh, cacheDir: dir, nowMs: t0 + VIEWER_RETRY_MS })).toBeNull();
    expect(r.calls()).toBe(1);
    await cachedViewer({ gh: r.gh, cacheDir: dir, nowMs: t0 + VIEWER_RETRY_MS + 1 });
    expect(r.calls()).toBe(2);
  });

  it('re-reads a record from the future instead of trusting it forever', async () => {
    const dir = tmp();
    fs.writeFileSync(viewerCachePath(dir), JSON.stringify({ fetchedAt: 1_900_000_000_000, viewer: OCTOCAT }));
    const r = replay(RECORDED);
    expect(await cachedViewer({ gh: r.gh, cacheDir: dir, nowMs: 1_800_000_000_000 })).toEqual(OCTOCAT);
    expect(r.calls()).toBe(1);
  });
});
