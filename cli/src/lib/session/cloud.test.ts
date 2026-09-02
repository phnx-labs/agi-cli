import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-cloud-cache-test-'));
const cacheRoot = path.join(tmpRoot, 'cache');
const originalHome = process.env.HOME;
const originalUserProfile = process.env.USERPROFILE;

vi.mock('../state.js', () => ({
  getCacheDir: () => cacheRoot,
}));

describe('cloud session cache path safety', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    process.env.HOME = tmpRoot;
    // cloud.ts resolves ~/.rush/user.yaml via os.homedir(), which reads
    // USERPROFILE (not HOME) on Windows — set both so the temp home takes
    // effect and readToken() finds the fixture token cross-platform.
    process.env.USERPROFILE = tmpRoot;
    fs.mkdirSync(path.join(tmpRoot, '.rush'), { recursive: true });
    fs.writeFileSync(path.join(tmpRoot, '.rush', 'user.yaml'), 'session:\n  access_token: test-token\n');

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
  });

  it('accepts the opencode session format and caches it as session.opencode.jsonl', async () => {
    const { ensureCloudSessionCached } = await import('./cloud.js');
    globalThis.fetch = vi.fn(async () => new Response('{"role":"user","part_type":"text"}\n', {
      headers: { 'X-Session-Format': 'opencode' },
    })) as any;

    const cachedPath = await ensureCloudSessionCached('c07ec355-d841-45fc-b2eb-f500355e15c6');

    expect(cachedPath).toBe(path.join(cacheRoot, 'cloud-runs', 'c07ec355-d841-45fc-b2eb-f500355e15c6', 'session.opencode.jsonl'));
  });

  it('surfaces opencode cloud runs from discovery (agentToFormat maps opencode)', async () => {
    const { discoverCloudSessions } = await import('./cloud.js');
    globalThis.fetch = vi.fn(async () => Response.json({
      executions: [
        { execution_id: 'c07ec355-d841-45fc-b2eb-f500355e15c6', agent: 'opencode', status: 'completed' },
      ],
    })) as any;

    const sessions = await discoverCloudSessions();
    expect(sessions).toHaveLength(1);
    expect(sessions[0].agent).toBe('opencode');
    expect(sessions[0].filePath).toContain('session.opencode.jsonl');
  });

  it('rejects invalid execution ids returned by cloud listing', async () => {
    const { discoverCloudSessions } = await import('./cloud.js');
    globalThis.fetch = vi.fn(async () => Response.json({
      executions: [
        {
          execution_id: '../escape',
          agent: 'rush',
          status: 'completed',
        },
      ],
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
