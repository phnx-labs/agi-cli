import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

type ConfigMod = typeof import('./config.js');
type PublishMod = typeof import('./publish.js');

let cfg: ConfigMod;
let publish: PublishMod;
let tmpHome: string;
let tmpDir: string;
let originalHome: string | undefined;
let originalNoAgent: string | undefined;
let originalShareWriteToken: string | undefined;

beforeAll(async () => {
  vi.resetModules();
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-share-publish-home-'));
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-share-publish-files-'));
  originalHome = process.env.HOME;
  originalNoAgent = process.env.AGENTS_SECRETS_NO_AGENT;
  process.env.HOME = tmpHome;
  process.env.AGENTS_SECRETS_NO_AGENT = '1';
  cfg = await import('./config.js');
  // readWriteToken() prefers SHARE_WRITE_TOKEN over the keychain-backed bundle
  // (config.ts:126-127) so a fleet/cloud agent can inject the token ephemerally.
  // These tests assert the publish upload carries `Bearer write-token-1`, i.e.
  // publish BEHAVIOR, not token storage — so seed the token on that env rail and
  // never touch the (now standalone-backed) bundle path at all. The bundle-store
  // round-trip is covered against a real standalone in config.test.ts. First
  // clear the box's own real token so an un-isolated run can't leak it (RUSH-2749).
  originalShareWriteToken = process.env[cfg.SHARE_TOKEN_ENV_KEY];
  delete process.env[cfg.SHARE_TOKEN_ENV_KEY];

  publish = await import('./publish.js');
  cfg.writeShareConfig({
    baseUrl: 'https://share.example.com',
    accountId: 'acct_1',
    workerName: 'agents-share',
    bucketName: 'agents-share',
  });
  process.env[cfg.SHARE_TOKEN_ENV_KEY] = 'write-token-1';
});

afterAll(async () => {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  if (originalNoAgent === undefined) delete process.env.AGENTS_SECRETS_NO_AGENT;
  else process.env.AGENTS_SECRETS_NO_AGENT = originalNoAgent;
  if (originalShareWriteToken === undefined) delete process.env[cfg.SHARE_TOKEN_ENV_KEY];
  else process.env[cfg.SHARE_TOKEN_ENV_KEY] = originalShareWriteToken;
  vi.resetModules();
  fs.rmSync(tmpHome, { recursive: true, force: true });
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('publishFile with injected uploader', () => {
  it('uploads the file body with auth, content type, and expiry headers', async () => {
    const htmlPath = path.join(tmpDir, 'report.html');
    fs.writeFileSync(htmlPath, '<!doctype html><title>Report</title>');
    const uploads: Array<{ url: string; body: string; headers: Record<string, string> }> = [];

    const result = await publish.publishFile(htmlPath, {
      slug: 'rush-1800-report',
      githubUser: 'octocat',
      expire: '2030-01-01',
      cover: false,
      // Suppress auto-captured provenance so this is deterministic regardless
      // of the ambient env (this repo's own agent sessions set AGENTS_SESSION_ID).
      provenance: {},
      uploader: async (url, body, headers) => {
        uploads.push({ url, body: body.toString('utf8'), headers });
        return { ok: true, status: 200, url };
      },
    });

    expect(result).toEqual({
      url: 'https://share.example.com/octocat/rush-1800-report',
      slug: 'rush-1800-report',
      expiresAt: new Date('2030-01-01').toISOString(),
      coverUrl: undefined,
      label: 'Report',
      labelSource: 'derived',
      visibility: 'public',
    });
    expect(uploads).toEqual([
      {
        url: 'https://share.example.com/octocat/rush-1800-report',
        body: '<!doctype html><title>Report</title>',
        headers: {
          authorization: 'Bearer write-token-1',
          'content-type': 'text/html; charset=utf-8',
          'x-share-expires-at': new Date('2030-01-01').toISOString(),
          'x-share-visibility': 'public',
          'x-share-label': 'Report',
          'x-share-label-source': 'derived',
        },
      },
    ]);
  });

  it('uses the same uploader seam for cover upload before the page publish', async () => {
    const htmlPath = path.join(tmpDir, 'cover.html');
    fs.writeFileSync(htmlPath, '<html><head><title>Cover</title></head><body>ok</body></html>');
    const uploads: string[] = [];

    const result = await publish.publishFile(htmlPath, {
      slug: 'cover-page',
      githubUser: 'octocat',
      uploader: async (url) => {
        uploads.push(url);
        return { ok: true, status: 200, url };
      },
      capturer: async () => Buffer.from('PNG'),
    });

    expect(result.coverUrl).toBe('https://share.example.com/octocat/cover-page.png');
    expect(uploads).toEqual([
      'https://share.example.com/octocat/cover-page.png',
      'https://share.example.com/octocat/cover-page',
    ]);
  });

  it('publishes when accountId is empty — only baseUrl + WRITE_TOKEN are required (RUSH-2837)', async () => {
    const htmlPath = path.join(tmpDir, 'partial.html');
    fs.writeFileSync(htmlPath, '<!doctype html><title>Partial</title>');
    const uploads: string[] = [];

    const result = await publish.publishFile(htmlPath, {
      slug: 'partial-config',
      githubUser: 'octocat',
      cover: false,
      provenance: {},
      config: {
        baseUrl: 'https://share.example.com',
        accountId: '',
        workerName: 'agents-share',
        bucketName: 'agents-share',
      },
      uploader: async (url) => {
        uploads.push(url);
        return { ok: true, status: 200, url };
      },
    });

    expect(result.url).toBe('https://share.example.com/octocat/partial-config');
    expect(uploads).toEqual(['https://share.example.com/octocat/partial-config']);
  });
});
