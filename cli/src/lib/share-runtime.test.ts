import { describe, expect, it, beforeEach, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-share-runtime-'));
const prevHome = process.env.HOME;
process.env.HOME = HOME;

describe('shareRuntimeEnv', () => {
  let prevToken: string | undefined;

  beforeEach(() => {
    prevToken = process.env.SHARE_WRITE_TOKEN;
    delete process.env.SHARE_WRITE_TOKEN;
    fs.rmSync(path.join(HOME, '.agents'), { recursive: true, force: true });
  });

  afterAll(() => {
    if (prevToken === undefined) delete process.env.SHARE_WRITE_TOKEN;
    else process.env.SHARE_WRITE_TOKEN = prevToken;
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    fs.rmSync(HOME, { recursive: true, force: true });
  });

  it('returns undefined when no BYO share endpoint is configured', async () => {
    const { shareRuntimeEnv } = await import('./share-runtime.js');
    expect(shareRuntimeEnv()).toBeUndefined();
  });

  it('an injected SHARE_WRITE_TOKEN is not injected without a configured endpoint', async () => {
    process.env.SHARE_WRITE_TOKEN = 'env-token';
    const { shareRuntimeEnv } = await import('./share-runtime.js');
    expect(shareRuntimeEnv()).toBeUndefined();
  });

  it('injects the ambient SHARE_WRITE_TOKEN when an endpoint is configured (no bundle read)', async () => {
    const { updateMeta } = await import('./state.js');
    updateMeta((meta) => ({ ...meta, share: { baseUrl: 'https://share.example.com' } }));
    process.env.SHARE_WRITE_TOKEN = 'env-token';
    const { shareRuntimeEnv } = await import('./share-runtime.js');
    expect(shareRuntimeEnv()).toEqual({ SHARE_WRITE_TOKEN: 'env-token' });
  });
});
