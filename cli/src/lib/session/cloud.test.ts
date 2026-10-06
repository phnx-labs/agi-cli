import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-cloud-cache-test-'));
const cacheRoot = path.join(tmpRoot, 'cache');
const originalHome = process.env.HOME;
const originalUserProfile = process.env.USERPROFILE;

vi.mock('../state.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../state.js')>()),
  getCacheDir: () => cacheRoot,
}));

describe('cloud session cache path safety', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    process.env.HOME = tmpRoot;
    process.env.USERPROFILE = tmpRoot;
    fs.mkdirSync(path.join(tmpRoot, '.rush'), { recursive: true });
    fs.writeFileSync(path.join(tmpRoot, '.rush', 'user.yaml'), 'org: test-org\nsession:\n  access_token: test-token\n');

    globalThis.fetch = vi.fn(async () => new Response('{"role":"user"}\n', {
      headers: { 'X-Session-Format': 'rush' },
    })) as any;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
    fs.rmSync(cacheRoot, { recursive: true, force: true });
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    if (originalUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = originalUserProfile;
  });

  it('writes a valid UUID execution id inside the cloud cache', async () => {
    const { ensureCloudSessionCached } = await import('./cloud.js');

    const cachedPath = await ensureCloudSessionCached('c07ec355-d841-45fc-b2eb-f500355e15c6');

    expect(cachedPath).toBe(path.join(cacheRoot, 'cloud-runs', 'c07ec355-d841-45fc-b2eb-f500355e15c6', 'session.rush.jsonl'));
    expect(fs.readFileSync(cachedPath, 'utf-8')).toBe('{"role":"user"}\n');
    const [url, init] = vi.mocked(globalThis.fetch).mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.prix.dev/o/test-org/p/_/sessions/c07ec355-d841-45fc-b2eb-f500355e15c6/trajectory');
    expect((init.headers as Record<string, string>).Accept).toBe('application/x-ndjson');
  });

  it('accepts the opencode session format and caches it as session.opencode.jsonl', async () => {
    const { ensureCloudSessionCached } = await import('./cloud.js');
    globalThis.fetch = vi.fn(async () => new Response('{"role":"user","part_type":"text"}\n', {
      headers: { 'X-Session-Format': 'opencode' },
    })) as any;

    const cachedPath = await ensureCloudSessionCached('c07ec355-d841-45fc-b2eb-f500355e15c6');

    expect(cachedPath).toBe(path.join(cacheRoot, 'cloud-runs', 'c07ec355-d841-45fc-b2eb-f500355e15c6', 'session.opencode.jsonl'));
  });

  it('lists the org-wide sessions and parses each by its captured harness, not its agent profile', async () => {
    const { discoverCloudSessions } = await import('./cloud.js');
    globalThis.fetch = vi.fn(async () => Response.json({
      sessions: [
        { id: 'c07ec355-d841-45fc-b2eb-f500355e15c6', agent: 'claude-workhorse', harness: 'opencode', status: 'completed' },
        { id: 'd07ec355-d841-45fc-b2eb-f500355e15c6', agent: 'claude', status: 'completed' },
      ],
      next_cursor: null,
    })) as any;

    const sessions = await discoverCloudSessions();
    expect(vi.mocked(globalThis.fetch).mock.calls[0][0]).toBe('https://api.prix.dev/o/test-org/sessions?limit=50');
    expect(sessions).toHaveLength(1);
    expect(sessions[0].agent).toBe('opencode');
    expect(sessions[0].filePath).toContain('session.opencode.jsonl');
  });

  it('falls back to the personal org from /me when user.yaml saves none', async () => {
    const { discoverCloudSessions } = await import('./cloud.js');
    fs.writeFileSync(path.join(tmpRoot, '.rush', 'user.yaml'), 'session:\n  access_token: test-token\n');
    globalThis.fetch = vi.fn(async (url: string) => url.endsWith('/me')
      ? Response.json({ orgs: [{ slug: 'team', kind: 'team' }, { slug: 'me-personal', kind: 'personal' }] })
      : Response.json({ sessions: [], next_cursor: null })) as any;

    await discoverCloudSessions();
    expect(vi.mocked(globalThis.fetch).mock.calls.map((c) => c[0])).toEqual([
      'https://api.prix.dev/me',
      'https://api.prix.dev/o/me-personal/sessions?limit=50',
    ]);
  });

  it('rejects invalid execution ids returned by cloud listing', async () => {
    const { discoverCloudSessions } = await import('./cloud.js');
    globalThis.fetch = vi.fn(async () => Response.json({
      sessions: [{ id: '../escape', harness: 'claude', status: 'completed' }],
    })) as any;

    await expect(discoverCloudSessions()).rejects.toThrow('Invalid cloud execution_id');
  });

  it.each([
    '../escape',
    '..\\escape',
    '/etc/passwd',
    'bad\0id',
    '.hidden',
  ])('rejects invalid execution id %j before any filesystem write', async (executionId) => {
    const { ensureCloudSessionCached } = await import('./cloud.js');

    await expect(ensureCloudSessionCached(executionId)).rejects.toThrow('Invalid cloud execution_id');

    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect(fs.existsSync(cacheRoot)).toBe(false);
  });

  it('rejects caller supplied destination paths outside the cloud cache', async () => {
    const { ensureCloudSessionCached } = await import('./cloud.js');
    const outside = path.join(tmpRoot, 'outside', 'session.rush.jsonl');

    await expect(
      ensureCloudSessionCached('c07ec355-d841-45fc-b2eb-f500355e15c6', outside),
    ).rejects.toThrow('Path escapes cloud session cache');

    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect(fs.existsSync(outside)).toBe(false);
  });

  it('normalizes caller supplied destination paths before filesystem IO', async () => {
    const { ensureCloudSessionCached } = await import('./cloud.js');
    const linkLikePath = path.join(cacheRoot, 'cloud-runs', 'link', '..', '..', 'outside', 'session.rush.jsonl');

    await expect(
      ensureCloudSessionCached('c07ec355-d841-45fc-b2eb-f500355e15c6', linkLikePath),
    ).rejects.toThrow('Path escapes cloud session cache');

    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(tmpRoot, 'outside', 'session.rush.jsonl'))).toBe(false);
  });
});
