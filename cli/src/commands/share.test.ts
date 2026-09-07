import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Command } from 'commander';
import type { CloudflareRequest, CloudflareRequester } from '../lib/share/provision.js';
import { formatSharePublishResult, formatShareDeleteResult, runShareDelete } from './share.js';
import { SHARE_TOKEN_ENV_KEY } from '../lib/share/config.js';
import type { DeleteShareResult } from '../lib/share/delete.js';

let tmpHome = '';
let previousHome: string | undefined;
let previousPath: string | undefined;
let previousShareGitHubUser: string | undefined;
let previousShareWriteToken: string | undefined;

/**
 * Re-import the share modules fresh, against the real standalone `secrets`
 * engine (PHNX-3989) rooted at this test's already-isolated `tmpHome`
 * (`beforeEach` below points `HOME` at a fresh temp dir per test, and the
 * client's `SECRETS_HOME` default follows `getUserAgentsDir()`, i.e. HOME —
 * so every test gets its own empty store with no shared state and no
 * in-process fake to keep in sync with the client's wire behavior).
 */
async function freshShareModules() {
  vi.resetModules();
  const { _resetSecretsClientForTest } = await import('../lib/secrets-client.js');
  _resetSecretsClientForTest();
  const share = await import('./share.js');
  const artifacts = await import('./artifacts.js');
  const config = await import('../lib/share/config.js');
  return { share, artifacts, config };
}

/**
 * A root program carrying the REAL surface — `agents artifacts share ...` plus
 * nested `agents artifacts unshare`. Registering share.ts against a bare
 * `new Command()` would give `agents share ...`, a shape the CLI no longer has
 * (RUSH-2580), so every CLI-level assertion goes through this.
 */
function programWithArtifacts(artifacts: { registerArtifactsCommands: (p: Command) => void }): Command {
  const program = new Command();
  program.exitOverride();
  artifacts.registerArtifactsCommands(program);
  return program;
}

/** The `share` group as it is actually reachable: `agents artifacts share`. */
function shareGroup(program: Command): Command | undefined {
  return program.commands.find((c) => c.name() === 'artifacts')?.commands.find((c) => c.name() === 'share');
}

function clearPhoenixSessionFile(): void {
  // identity/client.ts reads phoenix-session.json from AGENTS_STATE_DIR (the
  // vitest fork sandbox), not from $HOME. Tests that writeSession() must not
  // leak a signed-in principal into a later BYO-only assertion.
  const stateDir = process.env.AGENTS_STATE_DIR;
  if (stateDir) fs.rmSync(path.join(stateDir, 'phoenix-session.json'), { force: true });
}

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-share-command-'));
  previousHome = process.env.HOME;
  process.env.HOME = tmpHome;
  previousPath = process.env.PATH;
  previousShareGitHubUser = process.env.AGENTS_SHARE_GITHUB_USER;
  delete process.env.AGENTS_SHARE_GITHUB_USER;
  // A live `agents artifacts share` session in this shell may have SHARE_WRITE_TOKEN
  // injected (shareRuntimeEnv) — clear it so readWriteToken() in tests always
  // resolves through the (mocked) bundle, not this process's real env.
  previousShareWriteToken = process.env.SHARE_WRITE_TOKEN;
  delete process.env.SHARE_WRITE_TOKEN;
  clearPhoenixSessionFile();
  // Reads go to a temp HOME with an in-memory keychain backend.
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
  if (previousHome === undefined) delete process.env.HOME;
  else process.env.HOME = previousHome;
  if (previousPath === undefined) delete process.env.PATH;
  else process.env.PATH = previousPath;
  if (previousShareGitHubUser === undefined) delete process.env.AGENTS_SHARE_GITHUB_USER;
  else process.env.AGENTS_SHARE_GITHUB_USER = previousShareGitHubUser;
  if (previousShareWriteToken === undefined) delete process.env.SHARE_WRITE_TOKEN;
  else process.env.SHARE_WRITE_TOKEN = previousShareWriteToken;
  clearPhoenixSessionFile();
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

function installFakeGh(username: string): void {
  const bin = path.join(tmpHome, 'bin');
  fs.mkdirSync(bin, { recursive: true });
  if (process.platform === 'win32') {
    fs.writeFileSync(path.join(bin, 'gh.cmd'), `@echo off\r\necho ${username}\r\n`);
  } else {
    const gh = path.join(bin, 'gh');
    fs.writeFileSync(gh, `#!/bin/sh\nprintf '%s\\n' ${JSON.stringify(username)}\n`);
    fs.chmodSync(gh, 0o755);
  }
  process.env.PATH = `${bin}${path.delimiter}${process.env.PATH ?? ''}`;
}

function loggedOutput(): string {
  return vi.mocked(console.log).mock.calls.map((call) => call.map(String).join(' ')).join('\n');
}

// storeWriteToken now round-trips the write token through the standalone
// `secrets` process client (PHNX-3989), which spawns the real binary — the
// in-memory keychain backend freshShareModules() installs can't serve it. So
// the provision path (which STORES a freshly generated token and reads it back)
// runs only against a real standalone, gated on AGENTS_TEST_SECRETS_BIN exactly
// like secrets-client.test.ts / config.test.ts. Read-only flows below seed the
// token via SHARE_WRITE_TOKEN (readWriteToken() checks env first) and stay in CI.
const REAL_SECRETS_BIN = process.env.AGENTS_TEST_SECRETS_BIN;

describe.skipIf(!REAL_SECRETS_BIN)('runShareProvision custom domain selection', () => {
  const savedSecretsEnv: Record<string, string | undefined> = {};
  const SECRETS_ENV_KEYS = ['SECRETS_BIN', 'SECRETS_HOME', 'AGENTS_SECRETS_PASSPHRASE', 'SECRETS_NO_AGENT'];
  beforeEach(async () => {
    for (const k of SECRETS_ENV_KEYS) savedSecretsEnv[k] = process.env[k];
    process.env.SECRETS_BIN = REAL_SECRETS_BIN;
    process.env.SECRETS_HOME = path.join(tmpHome, '.secrets-home');
    process.env.AGENTS_SECRETS_PASSPHRASE = 'test-passphrase';
    process.env.SECRETS_NO_AGENT = '1';
    const { _resetSecretsClientForTest } = await import('../lib/secrets-client.js');
    _resetSecretsClientForTest();
  });
  afterEach(async () => {
    for (const k of SECRETS_ENV_KEYS) {
      if (savedSecretsEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedSecretsEnv[k];
    }
    const { _resetSecretsClientForTest } = await import('../lib/secrets-client.js');
    _resetSecretsClientForTest();
  });

  it('maps share.getrush.ai by default when the token can see getrush.ai', async () => {
    const { share, config } = await freshShareModules();
    const seen: CloudflareRequest[] = [];
    const request: CloudflareRequester = async (req) => {
      seen.push(req);
      if (req.pathname === '/accounts/acct_1/workers/subdomain') return { subdomain: 'acct-sub' };
      if (req.pathname === '/zones?name=getrush.ai') return [{ id: 'zone_getrush', name: 'getrush.ai' }];
      if (req.pathname.startsWith('/zones?name=')) return [];
      return {};
    };

    await share.runShareProvision({
      bundle: 'unused',
      worker: 'agents-share',
      bucket: 'agents-share',
      account: 'acct_1',
      token: 'cf-token',
      request,
    });

    expect(config.readShareConfig()).toMatchObject({
      baseUrl: 'https://share.getrush.ai',
      accountId: 'acct_1',
      workerName: 'agents-share',
      bucketName: 'agents-share',
      domain: 'share.getrush.ai',
    });
    expect(config.readWriteToken()).toMatch(/^[0-9a-f]{64}$/);
    expect(seen.map((req) => req.pathname)).toEqual([
      '/accounts/acct_1/r2/buckets',
      '/accounts/acct_1/r2/buckets/agents-share/lifecycle',
      '/accounts/acct_1/r2/buckets/agents-share/lifecycle',
      '/accounts/acct_1/workers/scripts/agents-share',
      '/accounts/acct_1/workers/scripts/agents-share/secrets',
      '/accounts/acct_1/workers/scripts/agents-share/subdomain',
      '/accounts/acct_1/workers/subdomain',
      '/zones?name=share.getrush.ai',
      '/zones?name=getrush.ai',
      '/accounts/acct_1/workers/domains',
      '/accounts/acct_1/workers/scripts/agents-share/secrets',
    ]);
    expect(seen.find((req) => req.pathname === '/accounts/acct_1/workers/domains')?.body).toEqual({
      zone_id: 'zone_getrush',
      hostname: 'share.getrush.ai',
      service: 'agents-share',
      environment: 'production',
    });
    const secrets = seen.filter((req) => req.pathname.endsWith('/secrets'));
    expect(secrets[0]?.body).toMatchObject({ name: 'WRITE_TOKEN', type: 'secret_text' });
    const { PHOENIX_ID_BASE } = await import('../lib/identity/client.js');
    expect(secrets[1]?.body).toEqual({
      name: 'PHOENIX_ID_BASE',
      text: PHOENIX_ID_BASE.replace(/\/+$/, ''),
      type: 'secret_text',
    });
  });

  it('stays on workers.dev when the default getrush.ai zone is not visible', async () => {
    const { share, config } = await freshShareModules();
    const seen: CloudflareRequest[] = [];
    const request: CloudflareRequester = async (req) => {
      seen.push(req);
      if (req.pathname === '/accounts/acct_1/workers/subdomain') return { subdomain: 'acct-sub' };
      if (req.pathname.startsWith('/zones?name=')) return [];
      return {};
    };

    await share.runShareProvision({
      bundle: 'unused',
      worker: 'agents-share',
      bucket: 'agents-share',
      account: 'acct_1',
      token: 'cf-token',
      request,
    });

    expect(config.readShareConfig()).toEqual({
      baseUrl: 'https://agents-share.acct-sub.workers.dev',
      accountId: 'acct_1',
      workerName: 'agents-share',
      bucketName: 'agents-share',
      domain: undefined,
      templateHash: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
    expect(seen.some((req) => req.pathname === '/accounts/acct_1/workers/domains')).toBe(false);
    const secrets = seen.filter((req) => req.pathname.endsWith('/secrets'));
    expect(secrets).toHaveLength(1);
    expect(secrets[0]?.body).toMatchObject({ name: 'WRITE_TOKEN', type: 'secret_text' });
  });

  it('uses --domain as the custom-domain candidate instead of the default hostname', async () => {
    const { share, config } = await freshShareModules();
    const seen: CloudflareRequest[] = [];
    const request: CloudflareRequester = async (req) => {
      seen.push(req);
      if (req.pathname === '/accounts/acct_1/workers/subdomain') return { subdomain: 'acct-sub' };
      if (req.pathname === '/zones?name=example.com') return [{ id: 'zone_example', name: 'example.com' }];
      if (req.pathname.startsWith('/zones?name=')) return [];
      return {};
    };

    await share.runShareProvision({
      bundle: 'unused',
      worker: 'agents-share',
      bucket: 'agents-share',
      account: 'acct_1',
      token: 'cf-token',
      domain: 'https://share.example.com/path/',
      request,
    });

    expect(config.readShareConfig()).toMatchObject({
      baseUrl: 'https://share.example.com',
      domain: 'share.example.com',
    });
    expect(seen.map((req) => req.pathname)).toContain('/zones?name=share.example.com');
    expect(seen.map((req) => req.pathname)).toContain('/zones?name=example.com');
    expect(seen.map((req) => req.pathname)).not.toContain('/zones?name=getrush.ai');
    expect(seen.at(-1)?.body).toMatchObject({
      zone_id: 'zone_example',
      hostname: 'share.example.com',
    });
    const secrets = seen.filter((req) => req.pathname.endsWith('/secrets'));
    expect(secrets).toHaveLength(1);
    expect(secrets[0]?.body).toMatchObject({ name: 'WRITE_TOKEN', type: 'secret_text' });
  });

  it('persists --analytics-token in the share config', async () => {
    const { share, config } = await freshShareModules();
    const request: CloudflareRequester = async (req) => {
      if (req.pathname === '/accounts/acct_1/workers/subdomain') return { subdomain: 'acct-sub' };
      if (req.pathname.startsWith('/zones?name=')) return [];
      return {};
    };

    await share.runShareProvision({
      bundle: 'unused',
      worker: 'agents-share',
      bucket: 'agents-share',
      account: 'acct_1',
      token: 'cf-token',
      analyticsToken: 'cf-web-analytics-token',
      request,
    });

    expect(config.readShareConfig()).toMatchObject({
      analyticsToken: 'cf-web-analytics-token',
    });
  });
});

describe('runShareUpdate', () => {
  it('refuses when share was never configured', async () => {
    const { share } = await freshShareModules();
    await expect(share.runShareUpdate({})).rejects.toThrow(/Run 'agents artifacts setup'/);
  });

  it('uses --account when share.accountId is empty rather than treating the endpoint as missing (RUSH-2837)', async () => {
    const { share, config } = await freshShareModules();
    config.writeShareConfig({
      baseUrl: 'https://share.test',
      accountId: '',
      workerName: 'worker-existing',
      bucketName: 'bucket-existing',
    });
    process.env.SHARE_WRITE_TOKEN = 'the-original-write-token';
    const seen: CloudflareRequest[] = [];
    await share.runShareUpdate({
      token: 'cf-token',
      account: 'acct_from_flag',
      request: async (req) => {
        seen.push(req);
        return {};
      },
    });
    expect(seen.map((r) => r.pathname)).toEqual([
      '/accounts/acct_from_flag/workers/scripts/worker-existing',
      '/accounts/acct_from_flag/workers/scripts/worker-existing/secrets',
    ]);
  });

  it('reuses the existing account/worker/bucket/token from config — never re-provisions', async () => {
    const { share, config } = await freshShareModules();
    config.writeShareConfig({
      baseUrl: 'https://share.test',
      accountId: 'acct_existing',
      workerName: 'worker-existing',
      bucketName: 'bucket-existing',
    });
    process.env.SHARE_WRITE_TOKEN = 'the-original-write-token';

    const seen: CloudflareRequest[] = [];
    const request: CloudflareRequester = async (req) => { seen.push(req); return {}; };

    const result = await share.runShareUpdate({ token: 'cf-token', account: 'acct_existing', request });

    expect(result.updated).toBe(true);
    expect(result.baseUrl).toBe('https://share.test');
    expect(result.workerName).toBe('worker-existing');
    // No bucket/subdomain/domain calls — an update never re-provisions.
    expect(seen.map((r) => r.pathname)).toEqual([
      '/accounts/acct_existing/workers/scripts/worker-existing',
      '/accounts/acct_existing/workers/scripts/worker-existing/secrets',
    ]);
    expect(seen[1].body).toEqual({ name: 'WRITE_TOKEN', text: 'the-original-write-token', type: 'secret_text' });
    // The token in the bundle is untouched — never regenerated.
    expect(config.readWriteToken()).toBe('the-original-write-token');
    expect(config.readShareConfig()?.templateHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is idempotent — a second call with a matching hash makes no request', async () => {
    const { share, config } = await freshShareModules();
    config.writeShareConfig({
      baseUrl: 'https://share.test',
      accountId: 'acct_1',
      workerName: 'worker-one',
      bucketName: 'bucket-one',
    });
    process.env.SHARE_WRITE_TOKEN = 'tok';

    const first: CloudflareRequest[] = [];
    await share.runShareUpdate({ token: 'cf-token', request: async (req) => { first.push(req); return {}; } });
    expect(first.length).toBeGreaterThan(0);

    const second: CloudflareRequest[] = [];
    const result = await share.runShareUpdate({ token: 'cf-token', request: async (req) => { second.push(req); return {}; } });

    expect(result.updated).toBe(false);
    expect(second).toEqual([]);
  });

  // --check is the release train's change-detection entry point (PHNX-3403): it
  // reports whether a deploy is due and returns WITHOUT deploying or reading any
  // Cloudflare credentials. The release preflight uses it to skip a Worker deploy
  // when the shipped worker-template.ts is unchanged.
  it('--check reports deployNeeded, deploys nothing, and needs no Cloudflare creds', async () => {
    const { share, config } = await freshShareModules();
    // Endpoint with NO account id and NO recorded templateHash — the state a
    // real deploy would reject for missing creds. --check must still resolve.
    config.writeShareConfig({
      baseUrl: 'https://share.test',
      accountId: '',
      workerName: 'worker-existing',
      bucketName: 'bucket-existing',
    });

    const request: CloudflareRequester = async () => { throw new Error('check must not call Cloudflare'); };
    // No token, no account — proves change detection is a pure local render+hash.
    const result = await share.runShareUpdate({ check: true, request });

    expect(result.checked).toBe(true);
    expect(result.updated).toBe(false);
    expect(result.deployNeeded).toBe(true); // no recorded hash → deploy (mirrors updateWorker's undefined-previous behavior)
    expect(result.deployedHash).toBeUndefined();
    expect(result.templateHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('--check reports deployNeeded:false once the deployed template matches (still deploys nothing)', async () => {
    const { share, config } = await freshShareModules();
    config.writeShareConfig({
      baseUrl: 'https://share.test',
      accountId: 'acct_1',
      workerName: 'worker-one',
      bucketName: 'bucket-one',
    });
    process.env.SHARE_WRITE_TOKEN = 'tok';

    // A real deploy records the current template hash in config.
    await share.runShareUpdate({ token: 'cf-token', request: async () => ({}) });

    const request: CloudflareRequester = async () => { throw new Error('check must not call Cloudflare'); };
    const result = await share.runShareUpdate({ check: true, request });

    expect(result.checked).toBe(true);
    expect(result.deployNeeded).toBe(false);
    expect(result.deployedHash).toBe(result.templateHash);
  });

  it('--check with --force reports deployNeeded even when the template already matches', async () => {
    const { share, config } = await freshShareModules();
    config.writeShareConfig({
      baseUrl: 'https://share.test',
      accountId: 'acct_1',
      workerName: 'worker-one',
      bucketName: 'bucket-one',
    });
    process.env.SHARE_WRITE_TOKEN = 'tok';
    await share.runShareUpdate({ token: 'cf-token', request: async () => ({}) });

    const result = await share.runShareUpdate({ check: true, force: true, request: async () => { throw new Error('no call'); } });
    expect(result.deployNeeded).toBe(true);
  });

  it('does not persist templateHash when the secret re-apply fails mid-update (RUSH-2453 self-heal pin)', async () => {
    // writeShareConfig runs only after updateWorker returns successfully. If the
    // second call (setWorkerSecret) throws after the deploy already landed, the
    // on-disk hash must stay stale so a plain re-run of `agents artifacts share update`
    // does not short-circuit on a matching hash and leaves the broken endpoint
    // unfixed. This is the recovery property the error message above depends on.
    const { share, config } = await freshShareModules();
    config.writeShareConfig({
      baseUrl: 'https://share.test',
      accountId: 'acct_1',
      workerName: 'worker-one',
      bucketName: 'bucket-one',
      templateHash: 'pre-update-stale-hash',
    });
    process.env.SHARE_WRITE_TOKEN = 'tok';

    await expect(
      share.runShareUpdate({
        token: 'cf-token',
        request: async (req) => {
          if (req.pathname.endsWith('/secrets')) {
            throw new Error('Cloudflare API 503: secrets unavailable');
          }
          return {};
        },
      }),
    ).rejects.toThrow(/Worker deployed but the write token failed to re-apply/);

    // Config must NOT have been rewritten with the new template hash — the stale
    // hash is what makes the next `agents artifacts share update` re-deploy instead of
    // no-op'ing as "already matches".
    expect(config.readShareConfig()?.templateHash).toBe('pre-update-stale-hash');
  });

  it('a managed endpoint update sets PHOENIX_ID_BASE (RUSH-3138)', async () => {
    const { share, config } = await freshShareModules();
    config.writeShareConfig({
      baseUrl: 'https://share.agents-cli.sh',
      accountId: 'acct_1',
      workerName: 'worker-one',
      bucketName: 'bucket-one',
      domain: 'share.agents-cli.sh',
    });
    process.env.SHARE_WRITE_TOKEN = 'tok';
    const { PHOENIX_ID_BASE } = await import('../lib/identity/client.js');

    const seen: CloudflareRequest[] = [];
    await share.runShareUpdate({
      token: 'cf-token',
      request: async (req) => { seen.push(req); return {}; },
    });

    expect(seen.map((r) => r.pathname)).toEqual([
      '/accounts/acct_1/workers/scripts/worker-one',
      '/accounts/acct_1/workers/scripts/worker-one/secrets',
      '/accounts/acct_1/workers/scripts/worker-one/secrets',
    ]);
    expect(seen[1].body).toEqual({ name: 'WRITE_TOKEN', text: 'tok', type: 'secret_text' });
    expect(seen[2].body).toEqual({
      name: 'PHOENIX_ID_BASE',
      text: PHOENIX_ID_BASE.replace(/\/+$/, ''),
      type: 'secret_text',
    });
  });

  it('a managed re-deploy re-applies PHOENIX_ID_BASE after the script upload', async () => {
    const { share, config } = await freshShareModules();
    config.writeShareConfig({
      baseUrl: 'https://share.agents-cli.sh',
      accountId: 'acct_1',
      workerName: 'worker-one',
      bucketName: 'bucket-one',
      domain: 'share.agents-cli.sh',
      templateHash: 'stale-hash',
    });
    process.env.SHARE_WRITE_TOKEN = 'tok';
    const { PHOENIX_ID_BASE } = await import('../lib/identity/client.js');

    const seen: CloudflareRequest[] = [];
    await share.runShareUpdate({
      token: 'cf-token',
      request: async (req) => { seen.push(req); return {}; },
    });

    const phoenix = seen.filter((r) => (r.body as { name?: string } | undefined)?.name === 'PHOENIX_ID_BASE');
    expect(phoenix).toHaveLength(1);
    expect(phoenix[0].body).toEqual({
      name: 'PHOENIX_ID_BASE',
      text: PHOENIX_ID_BASE.replace(/\/+$/, ''),
      type: 'secret_text',
    });
  });

  it('opts.managed on a non-managed hostname still binds PHOENIX_ID_BASE', async () => {
    const { share, config } = await freshShareModules();
    config.writeShareConfig({
      baseUrl: 'https://share.test',
      accountId: 'acct_1',
      workerName: 'worker-one',
      bucketName: 'bucket-one',
    });
    process.env.SHARE_WRITE_TOKEN = 'tok';
    const { PHOENIX_ID_BASE } = await import('../lib/identity/client.js');

    const seen: CloudflareRequest[] = [];
    await share.runShareUpdate({
      token: 'cf-token',
      managed: true,
      request: async (req) => { seen.push(req); return {}; },
    });

    expect(seen[2].body).toEqual({
      name: 'PHOENIX_ID_BASE',
      text: PHOENIX_ID_BASE.replace(/\/+$/, ''),
      type: 'secret_text',
    });
  });

  it('a BYO endpoint update does not send PHOENIX_ID_BASE', async () => {
    const { share, config } = await freshShareModules();
    config.writeShareConfig({
      baseUrl: 'https://share.test',
      accountId: 'acct_1',
      workerName: 'worker-one',
      bucketName: 'bucket-one',
    });
    process.env.SHARE_WRITE_TOKEN = 'tok';

    const seen: CloudflareRequest[] = [];
    await share.runShareUpdate({
      token: 'cf-token',
      request: async (req) => { seen.push(req); return {}; },
    });

    expect(seen).toHaveLength(2);
    expect(seen[1].body).toEqual({ name: 'WRITE_TOKEN', text: 'tok', type: 'secret_text' });
    expect(seen.some((r) => (r.body as { name?: string } | undefined)?.name === 'PHOENIX_ID_BASE')).toBe(false);
  });
});

describe('shareTemplateStatus', () => {
  it('is unknown for a config with no recorded hash', async () => {
    const { share } = await freshShareModules();
    expect(
      share.shareTemplateStatus({ baseUrl: 'x', accountId: 'a', workerName: 'w', bucketName: 'b' }),
    ).toBe('unknown');
  });

  it('is current when the recorded hash matches the live template', async () => {
    const { share } = await freshShareModules();
    const { renderWorkerBundle } = await import('../lib/share/worker-template.js');
    const { hashWorkerScript } = await import('../lib/share/provision.js');
    expect(
      share.shareTemplateStatus({
        baseUrl: 'x', accountId: 'a', workerName: 'w', bucketName: 'b',
        templateHash: hashWorkerScript(renderWorkerBundle().script),
      }),
    ).toBe('current');
  });

  it('is outdated when the recorded hash does not match', async () => {
    const { share } = await freshShareModules();
    expect(
      share.shareTemplateStatus({
        baseUrl: 'x', accountId: 'a', workerName: 'w', bucketName: 'b', templateHash: 'stale-hash',
      }),
    ).toBe('outdated');
  });
});

describe('agents artifacts share update (CLI)', () => {
  it('--update-json reports skipped:false=>updated true with the new hash on first run', async () => {
    const { artifacts, share, config } = await freshShareModules();
    config.writeShareConfig({
      baseUrl: 'https://share.test',
      accountId: 'acct_1',
      workerName: 'worker-one',
      bucketName: 'bucket-one',
    });
    process.env.SHARE_WRITE_TOKEN = 'tok';

    // The CLI action doesn't accept a `request` override, so this exercises the
    // real Cloudflare requester path only up to argument parsing — assert via
    // the underlying function instead, and cover the CLI wiring/help surface here.
    const program = programWithArtifacts(artifacts);
    const updateCmd = shareGroup(program)?.commands.find((c) => c.name() === 'update');
    expect(updateCmd).toBeDefined();
    expect(updateCmd?.options.map((o) => o.long)).toEqual(
      expect.arrayContaining(['--bundle', '--account', '--token', '--force', '--update-json']),
    );
  });

  it('a real parse actually delivers --update-json through to the update result (RUSH-2687 — --json collides with the parent `share --json`)', async () => {
    // Same collision class as `list`'s --for-user/--list-json above: `update`
    // would have registered its own --json, which shares a name with the
    // parent `share` command's publish-time --json — renamed to --update-json
    // instead (RUSH-2687).
    const { artifacts, share, config } = await freshShareModules();
    config.writeShareConfig({
      baseUrl: 'https://share.test',
      accountId: 'acct_1',
      workerName: 'worker-one',
      bucketName: 'bucket-one',
    });
    process.env.SHARE_WRITE_TOKEN = 'tok';

    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response(JSON.stringify({ success: true, result: {} }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })) as typeof fetch;

    try {
      const program = programWithArtifacts(artifacts);
      await program.parseAsync([
        'node', 'agents', 'artifacts', 'share', 'update', '--token', 'cf-token', '--update-json',
      ]);
      const out = loggedOutput();
      // A dropped --update-json would fall through to the human-readable line
      // ("Worker '…' updated → template …"), never valid JSON.
      expect(() => JSON.parse(out)).not.toThrow();
      expect(JSON.parse(out)).toMatchObject({ updated: true, workerName: 'worker-one' });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe('share status and analytics namespace display', () => {
  it('resolves the status namespace through gh auth when github.user is unset', async () => {
    const { artifacts, share, config } = await freshShareModules();
    config.writeShareConfig({
      baseUrl: 'https://share.test',
      accountId: 'acct_1',
      workerName: 'agents-share',
      bucketName: 'agents-share',
    });
    installFakeGh('gh-only-user');

    const program = programWithArtifacts(artifacts);
    await program.parseAsync(['node', 'agents', 'artifacts', 'share', 'status']);

    const out = loggedOutput();
    expect(out).toContain('https://share.test/gh-only-user');
    // The namespace line resolves via gh — it must not fall back to the
    // "unknown — set gh auth" hint (a separate "template unknown" line is
    // expected here since this config has no recorded template hash).
    expect(out).not.toMatch(/namespace.*unknown/);
  });

  it('uses the gh-resolved namespace in the analytics path hint', async () => {
    const { artifacts, share, config } = await freshShareModules();
    config.writeShareConfig({
      baseUrl: 'https://share.test',
      accountId: 'acct_1',
      workerName: 'agents-share',
      bucketName: 'agents-share',
      domain: 'share.test',
      analyticsToken: 'cf-web-analytics-token',
    });
    installFakeGh('gh-only-user');

    const program = programWithArtifacts(artifacts);
    await program.parseAsync(['node', 'agents', 'artifacts', 'share', 'analytics']);

    expect(loggedOutput()).toContain('filter by /gh-only-user/');
  });

  it('shows the template as unknown for a config with no recorded hash', async () => {
    const { artifacts, share, config } = await freshShareModules();
    config.writeShareConfig({
      baseUrl: 'https://share.test',
      accountId: 'acct_1',
      workerName: 'agents-share',
      bucketName: 'agents-share',
    });
    installFakeGh('gh-only-user');

    const program = programWithArtifacts(artifacts);
    await program.parseAsync(['node', 'agents', 'artifacts', 'share', 'status']);

    expect(loggedOutput()).toContain('unknown');
  });

  it('status reports the endpoint when accountId is empty instead of "Not configured" (RUSH-2837)', async () => {
    const { artifacts, config } = await freshShareModules();
    fs.mkdirSync(path.join(tmpHome, '.agents'), { recursive: true });
    fs.writeFileSync(
      path.join(tmpHome, '.agents', 'agents.yaml'),
      [
        'share:',
        '  baseUrl: https://share.agents-cli.sh',
        '  accountId: ""',
        '  workerName: agents-share',
        '  bucketName: agents-share',
        '',
      ].join('\n'),
    );
    // Re-import so readMeta sees the yaml we just wrote (module cache was
    // populated by writeShareConfig in sibling tests via a reset).
    expect(config.readShareConfig()?.baseUrl).toBe('https://share.agents-cli.sh');
    installFakeGh('gh-only-user');

    const program = programWithArtifacts(artifacts);
    await program.parseAsync(['node', 'agents', 'artifacts', 'share', 'status']);

    const out = loggedOutput();
    expect(out).toContain('https://share.agents-cli.sh');
    expect(out).toContain('account missing');
    expect(out).not.toMatch(/Not configured/);
  });

  it('signed-in with no BYO config reports the managed endpoint (RUSH-3135)', async () => {
    const { artifacts } = await freshShareModules();
    const { writeSession } = await import('../lib/identity/client.js');
    writeSession({ access_token: 'pid_alice', userId: 'alice-user-1', email: 'alice@example.com' });

    const program = programWithArtifacts(artifacts);
    await program.parseAsync(['node', 'agents', 'artifacts', 'share', 'status']);

    const out = loggedOutput();
    expect(out).toContain('managed');
    expect(out).toContain('share.getrush.ai/alice');
    expect(out).not.toMatch(/Not configured/);
    expect(out).not.toMatch(/artifacts setup/);
  });

  it('signed-in analytics names the managed endpoint instead of "Not configured" (RUSH-3135)', async () => {
    const { artifacts } = await freshShareModules();
    const { writeSession } = await import('../lib/identity/client.js');
    writeSession({ access_token: 'pid_alice', userId: 'alice', email: 'a@b.com' });

    const program = programWithArtifacts(artifacts);
    await program.parseAsync(['node', 'agents', 'artifacts', 'share', 'analytics']);

    const out = loggedOutput();
    expect(out).toMatch(/BYO feature/i);
    expect(out).toContain('share.getrush.ai');
    expect(out).not.toMatch(/Not configured/);
  });

  it('shows the template as current right after `agents artifacts share update` and outdated once the hash is stale', async () => {
    const { artifacts, share, config } = await freshShareModules();
    config.writeShareConfig({
      baseUrl: 'https://share.test',
      accountId: 'acct_1',
      workerName: 'agents-share',
      bucketName: 'agents-share',
    });
    process.env.SHARE_WRITE_TOKEN = 'tok';
    await share.runShareUpdate({ token: 'cf-token', request: async () => ({}) });
    installFakeGh('gh-only-user');

    const program = programWithArtifacts(artifacts);
    await program.parseAsync(['node', 'agents', 'artifacts', 'share', 'status']);
    expect(loggedOutput()).toContain('current');

    config.writeShareConfig({ ...config.readShareConfig()!, templateHash: 'stale-hash' });
    vi.mocked(console.log).mockClear();
    await program.parseAsync(['node', 'agents', 'artifacts', 'share', 'status']);
    expect(loggedOutput()).toContain('outdated');
  });
});



describe('parseShareListing', () => {
  it('validates and normalizes the Worker listing payload', async () => {
    const { share } = await freshShareModules();
    const body = JSON.stringify({
      user: 'octocat',
      count: 2,
      objects: [
        { slug: 'a', url: 'https://s/octocat/a', size: 10, contentType: 'text/html; charset=utf-8', publishedAt: '2026-08-08T00:00:00.000Z', expiresAt: null },
        { slug: 'b', url: 'https://s/octocat/b', size: 20, contentType: null, publishedAt: '2026-08-07T00:00:00.000Z', expiresAt: '2099-01-01T00:00:00.000Z' },
      ],
    });
    const result = share.parseShareListing('octocat', body);
    expect(result.user).toBe('octocat');
    expect(result.count).toBe(2);
    expect(result.objects[0]).toEqual({
      slug: 'a', url: 'https://s/octocat/a', size: 10, contentType: 'text/html; charset=utf-8', publishedAt: '2026-08-08T00:00:00.000Z', expiresAt: null,
      label: null, visibility: 'public', agent: null, session: null, host: null, repo: null, revisionCount: 0, meta: {},
    });
    expect(result.objects[1].contentType).toBeNull();
    expect(result.objects[1].expiresAt).toBe('2099-01-01T00:00:00.000Z');
  });

  it('surfaces arbitrary --meta entries under objects[].meta (RUSH-2683 review fix)', async () => {
    // --meta kind=plan --meta ticket=RUSH-2683 was previously write-only: stored
    // in customMetadata but never returned by any read route, so it couldn't be
    // seen again via `share list --list-json`.
    const { share } = await freshShareModules();
    const body = JSON.stringify({
      user: 'octocat',
      count: 1,
      objects: [
        { slug: 'a', url: 'https://s/octocat/a', size: 10, contentType: 'text/html', publishedAt: '2026-08-08T00:00:00.000Z', expiresAt: null, meta: { kind: 'plan', ticket: 'RUSH-2683' } },
      ],
    });
    const result = share.parseShareListing('octocat', body);
    expect(result.objects[0].meta).toEqual({ kind: 'plan', ticket: 'RUSH-2683' });
  });

  it('defaults meta to {} when the Worker response has none (predates the field)', async () => {
    const { share } = await freshShareModules();
    const body = JSON.stringify({
      user: 'octocat', count: 1,
      objects: [{ slug: 'a', url: 'https://s/octocat/a', size: 10, contentType: null, publishedAt: '2026-08-08T00:00:00.000Z', expiresAt: null }],
    });
    const result = share.parseShareListing('octocat', body);
    expect(result.objects[0].meta).toEqual({});
  });

  it('fails loud with the outdated-template hint when the body is HTML (old Worker gallery)', async () => {
    const { share } = await freshShareModules();
    expect(() => share.parseShareListing('octocat', '<!doctype html><h1>@octocat</h1>')).toThrow(/agents artifacts share update/);
  });

  it('fails loud when the JSON has no objects array', async () => {
    const { share } = await freshShareModules();
    expect(() => share.parseShareListing('octocat', JSON.stringify({ user: 'octocat' }))).toThrow(/agents artifacts share update/);
  });
});

describe('formatShareList', () => {
  const result = {
    user: 'octocat',
    count: 2,
    objects: [
      { slug: 'plan-a', url: 'https://s/octocat/plan-a', size: 2048, contentType: 'text/html; charset=utf-8', publishedAt: '2026-08-08T12:00:00.000Z', expiresAt: null, label: null, visibility: 'public', agent: null, session: null, host: null, repo: null, revisionCount: 0 },
      { slug: 'report-b', url: 'https://s/octocat/report-b', size: 640, contentType: 'text/html; charset=utf-8', publishedAt: '2026-08-07T12:00:00.000Z', expiresAt: '2026-09-01T00:00:00.000Z', label: null, visibility: 'public', agent: null, session: null, host: null, repo: null, revisionCount: 0 },
    ],
  };

  it('--json emits the raw stable result', async () => {
    const { share } = await freshShareModules();
    expect(JSON.parse(share.formatShareList(result, true))).toEqual(result);
  });

  it('renders a human table with slug, date, size, url, and expiry', async () => {
    const { share } = await freshShareModules();
    const text = share.formatShareList(result);
    expect(text).toContain('@octocat');
    expect(text).toContain('2 published pages');
    expect(text).toContain('plan-a');
    expect(text).toContain('2026-08-08');
    expect(text).toContain('2.0 KB');
    expect(text).toContain('640 B');
    expect(text).toContain('https://s/octocat/plan-a');
    expect(text).toContain('expires 2026-09-01');
  });

  it('says nothing is published for an empty namespace', async () => {
    const { share } = await freshShareModules();
    expect(share.formatShareList({ user: 'octocat', count: 0, objects: [] })).toMatch(/No active pages/i);
  });

  it('shows label, agent, and revision count when present (RUSH-2683)', async () => {
    const { share } = await freshShareModules();
    const withMeta = {
      user: 'octocat',
      count: 1,
      objects: [
        { slug: 'plan-a', url: 'https://s/octocat/plan-a', size: 2048, contentType: 'text/html', publishedAt: '2026-08-08T12:00:00.000Z', expiresAt: null, label: 'Fleet Plan', agent: 'claude', session: 'sess-1', host: 'zion', repo: 'agents-cli', revisionCount: 3 },
      ],
    };
    const text = share.formatShareList(withMeta);
    expect(text).toContain('Fleet Plan');
    expect(text).toContain('claude');
    expect(text).toContain('3 revisions');
  });

  it('shows arbitrary --meta key=value pairs in the human table (RUSH-2683 review fix)', async () => {
    const { share } = await freshShareModules();
    const withCustomMeta = {
      user: 'octocat',
      count: 1,
      objects: [
        { slug: 'plan-a', url: 'https://s/octocat/plan-a', size: 2048, contentType: 'text/html', publishedAt: '2026-08-08T12:00:00.000Z', expiresAt: null, label: null, agent: null, session: null, host: null, repo: null, revisionCount: 0, meta: { kind: 'plan', ticket: 'RUSH-2683' } },
      ],
    };
    const text = share.formatShareList(withCustomMeta);
    expect(text).toContain('kind=plan');
    expect(text).toContain('ticket=RUSH-2683');
  });
});

describe('runShareList', () => {
  async function currentConfig(share: typeof import('./share.js')): Promise<{ baseUrl: string; accountId: string; workerName: string; bucketName: string; templateHash: string }> {
    const { renderWorkerBundle } = await import('../lib/share/worker-template.js');
    const { hashWorkerScript } = await import('../lib/share/provision.js');
    return {
      baseUrl: 'https://share.test', accountId: 'a', workerName: 'w', bucketName: 'b',
      templateHash: hashWorkerScript(renderWorkerBundle().script),
    };
  }

  it('fetches, parses, and returns the listing when the template is current', async () => {
    const { share } = await freshShareModules();
    const config = await currentConfig(share);
    const seen: string[] = [];
    const result = await share.runShareList({
      githubUser: 'octocat',
      config,
      fetchListing: async (url: string) => {
        seen.push(url);
        return {
          status: 200,
          contentType: 'application/json; charset=utf-8',
          body: JSON.stringify({ user: 'octocat', count: 1, objects: [{ slug: 'a', url: 'https://share.test/octocat/a', size: 5, contentType: 'text/html', publishedAt: '2026-08-08T00:00:00.000Z', expiresAt: null }] }),
        };
      },
    });
    expect(seen).toEqual(['https://share.test/octocat?format=json']);
    expect(result.count).toBe(1);
    expect(result.objects[0].slug).toBe('a');
  });

  it('throws the outdated-template hint up front (no network) when the recorded hash is stale', async () => {
    const { share } = await freshShareModules();
    let fetched = false;
    await expect(
      share.runShareList({
        githubUser: 'octocat',
        config: { baseUrl: 'https://share.test', accountId: 'a', workerName: 'w', bucketName: 'b', templateHash: 'stale-hash' },
        fetchListing: async () => { fetched = true; return { status: 200, contentType: 'application/json', body: '{}' }; },
      }),
    ).rejects.toThrow(/agents artifacts share update/);
    expect(fetched).toBe(false);
  });

  it('reads a 404 on a CURRENT template as an empty namespace (nothing published), not an outdated route', async () => {
    const { share } = await freshShareModules();
    const config = await currentConfig(share);
    const result = await share.runShareList({
      githubUser: 'octocat',
      config,
      fetchListing: async () => ({ status: 404, contentType: 'text/plain', body: 'not found' }),
    });
    expect(result).toEqual({ user: 'octocat', count: 0, objects: [] });
  });

  it('maps a 404 (route absent on an old, hash-unknown endpoint) to the outdated-template hint', async () => {
    const { share } = await freshShareModules();
    await expect(
      share.runShareList({
        githubUser: 'octocat',
        config: { baseUrl: 'https://share.test', accountId: 'a', workerName: 'w', bucketName: 'b' },
        fetchListing: async () => ({ status: 404, contentType: 'text/plain', body: 'not found' }),
      }),
    ).rejects.toThrow(/agents artifacts share update/);
  });

  it('maps a non-JSON 200 (old Worker served the HTML gallery) to the outdated-template hint', async () => {
    const { share } = await freshShareModules();
    await expect(
      share.runShareList({
        githubUser: 'octocat',
        config: { baseUrl: 'https://share.test', accountId: 'a', workerName: 'w', bucketName: 'b' },
        fetchListing: async () => ({ status: 200, contentType: 'text/html; charset=utf-8', body: '<h1>@octocat</h1>' }),
      }),
    ).rejects.toThrow(/agents artifacts share update/);
  });

  it('refuses when share was never configured', async () => {
    const { share } = await freshShareModules();
    await expect(share.runShareList({ githubUser: 'octocat' })).rejects.toThrow(/Not set up yet/);
    await expect(share.runShareList({ githubUser: 'octocat' })).rejects.toThrow(/agents auth login/);
  });

  it('signed-in with no BYO config lists the managed endpoint namespace (RUSH-3135)', async () => {
    const { share } = await freshShareModules();
    const { DEFAULT_SHARE_DOMAIN } = await import('../lib/share/config.js');
    const seen: string[] = [];
    const result = await share.runShareList({
      phoenixSession: { access_token: 'pid_alice', userId: 'alice-user-1', email: 'alice@example.com' },
      fetchListing: async (url: string) => {
        seen.push(url);
        return {
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            user: 'alice',
            count: 1,
            objects: [{
              slug: 'plan',
              url: `https://${DEFAULT_SHARE_DOMAIN}/alice/plan`,
              size: 5,
              contentType: 'text/html',
              publishedAt: '2026-08-08T00:00:00.000Z',
              expiresAt: null,
            }],
          }),
        };
      },
    });
    expect(seen).toEqual([`https://${DEFAULT_SHARE_DOMAIN}/alice?format=json`]);
    expect(result.user).toBe('alice');
    expect(result.count).toBe(1);
    expect(result.objects[0].slug).toBe('plan');
  });

  it('managed 404 is an empty namespace, not "not set up"', async () => {
    const { share } = await freshShareModules();
    const result = await share.runShareList({
      phoenixSession: { access_token: 'pid_alice', userId: 'alice', email: 'a@b.com' },
      fetchListing: async () => ({ status: 404, contentType: 'text/plain', body: 'not found' }),
    });
    expect(result).toEqual({ user: 'a', count: 0, objects: [] });
  });

  it('filters by --agent (case-insensitive, exact) and reflects it in count', async () => {
    const { share } = await freshShareModules();
    const config = await currentConfig(share);
    const objects = [
      { slug: 'a', url: 'https://s/octocat/a', size: 1, contentType: null, publishedAt: '2026-08-08T00:00:00.000Z', expiresAt: null, label: null, agent: 'Claude', session: null, host: null, repo: null, revisionCount: 0 },
      { slug: 'b', url: 'https://s/octocat/b', size: 1, contentType: null, publishedAt: '2026-08-07T00:00:00.000Z', expiresAt: null, label: null, agent: 'codex', session: null, host: null, repo: null, revisionCount: 0 },
    ];
    const result = await share.runShareList({
      githubUser: 'octocat',
      config,
      agent: 'claude',
      fetchListing: async () => ({ status: 200, contentType: 'application/json', body: JSON.stringify({ user: 'octocat', count: 2, objects }) }),
    });
    expect(result.count).toBe(1);
    expect(result.objects.map((o) => o.slug)).toEqual(['a']);
  });

  it('filters by --session (exact)', async () => {
    const { share } = await freshShareModules();
    const config = await currentConfig(share);
    const objects = [
      { slug: 'a', url: 'https://s/octocat/a', size: 1, contentType: null, publishedAt: '2026-08-08T00:00:00.000Z', expiresAt: null, label: null, agent: null, session: 'sess-1', host: null, repo: null, revisionCount: 0 },
      { slug: 'b', url: 'https://s/octocat/b', size: 1, contentType: null, publishedAt: '2026-08-07T00:00:00.000Z', expiresAt: null, label: null, agent: null, session: 'sess-2', host: null, repo: null, revisionCount: 0 },
    ];
    const result = await share.runShareList({
      githubUser: 'octocat',
      config,
      session: 'sess-2',
      fetchListing: async () => ({ status: 200, contentType: 'application/json', body: JSON.stringify({ user: 'octocat', count: 2, objects }) }),
    });
    expect(result.objects.map((o) => o.slug)).toEqual(['b']);
  });

  it('filters by --label (case-insensitive substring)', async () => {
    const { share } = await freshShareModules();
    const config = await currentConfig(share);
    const objects = [
      { slug: 'a', url: 'https://s/octocat/a', size: 1, contentType: null, publishedAt: '2026-08-08T00:00:00.000Z', expiresAt: null, label: 'Fleet Plan', agent: null, session: null, host: null, repo: null, revisionCount: 0 },
      { slug: 'b', url: 'https://s/octocat/b', size: 1, contentType: null, publishedAt: '2026-08-07T00:00:00.000Z', expiresAt: null, label: 'Q3 report', agent: null, session: null, host: null, repo: null, revisionCount: 0 },
    ];
    const result = await share.runShareList({
      githubUser: 'octocat',
      config,
      label: 'fleet',
      fetchListing: async () => ({ status: 200, contentType: 'application/json', body: JSON.stringify({ user: 'octocat', count: 2, objects }) }),
    });
    expect(result.objects.map((o) => o.slug)).toEqual(['a']);
  });

  it('uses a public, anonymous listing by default (no scope param, no auth header)', async () => {
    const { share } = await freshShareModules();
    const config = await currentConfig(share);
    const seen: { url: string; headers?: Record<string, string> }[] = [];
    await share.runShareList({
      githubUser: 'octocat',
      config,
      fetchListing: async (url, headers) => {
        seen.push({ url, headers });
        return { status: 200, contentType: 'application/json', body: JSON.stringify({ user: 'octocat', count: 0, objects: [] }) };
      },
    });
    expect(seen.length).toBe(1);
    expect(seen[0].url).toBe('https://share.test/octocat?format=json');
    expect(seen[0].headers?.authorization).toBeUndefined();
  });

  it('sends scope=mine + owner bearer for hidden scopes', async () => {
    const { share } = await freshShareModules();
    const config = await currentConfig(share);
    const seen: { url: string; headers?: Record<string, string> }[] = [];
    const objects = [
      { slug: 'public', url: 'https://s/octocat/public', size: 1, contentType: null, publishedAt: '2026-08-08T00:00:00.000Z', expiresAt: null, label: null, visibility: 'public', agent: null, session: null, host: null, repo: null, revisionCount: 0 },
      { slug: 'secret', url: 'https://s/octocat/secret', size: 1, contentType: null, publishedAt: '2026-08-07T00:00:00.000Z', expiresAt: null, label: null, visibility: 'me', agent: null, session: null, host: null, repo: null, revisionCount: 0 },
    ];
    const result = await share.runShareList({
      githubUser: 'octocat',
      config,
      writeToken: 'byo-secret',
      scope: 'all',
      fetchListing: async (url, headers) => {
        seen.push({ url, headers });
        return { status: 200, contentType: 'application/json', body: JSON.stringify({ user: 'octocat', count: 2, objects }) };
      },
    });
    expect(seen[0].url).toBe('https://share.test/octocat?format=json&scope=mine');
    expect(seen[0].headers?.authorization).toBe('Bearer byo-secret');
    expect(result.objects.map((o) => o.slug)).toEqual(['public', 'secret']);
  });

  it('client-side filters a scope=all response down to --scope me', async () => {
    const { share } = await freshShareModules();
    const config = await currentConfig(share);
    const objects = [
      { slug: 'public', url: 'https://s/octocat/public', size: 1, contentType: null, publishedAt: '2026-08-08T00:00:00.000Z', expiresAt: null, label: null, visibility: 'public', agent: null, session: null, host: null, repo: null, revisionCount: 0 },
      { slug: 'secret', url: 'https://s/octocat/secret', size: 1, contentType: null, publishedAt: '2026-08-07T00:00:00.000Z', expiresAt: null, label: null, visibility: 'me', agent: null, session: null, host: null, repo: null, revisionCount: 0 },
      { slug: 'unlisted', url: 'https://s/octocat/unlisted', size: 1, contentType: null, publishedAt: '2026-08-06T00:00:00.000Z', expiresAt: null, label: null, visibility: 'unlisted', agent: null, session: null, host: null, repo: null, revisionCount: 0 },
    ];
    const result = await share.runShareList({
      githubUser: 'octocat',
      config,
      writeToken: 'byo-secret',
      scope: 'me',
      fetchListing: async () => ({ status: 200, contentType: 'application/json', body: JSON.stringify({ user: 'octocat', count: 3, objects }) }),
    });
    expect(result.objects.map((o) => o.slug)).toEqual(['secret']);
    expect(result.objects[0].visibility).toBe('me');
  });

  it('fails loud before network when a hidden scope is requested with no owner token', async () => {
    const { share } = await freshShareModules();
    const config = await currentConfig(share);
    await expect(
      share.runShareList({
        githubUser: 'octocat',
        config,
        // BYO config but no writeToken / session → backend.token is empty
        scope: 'all',
        fetchListing: async () => ({ status: 200, contentType: 'application/json', body: '{}' }),
      }),
    ).rejects.toThrow(/owner authentication/);
  });
});

describe('agents artifacts share list (CLI)', () => {
  it('registers the list command with --list-json, --for-user, --scope, --all, --agent, --session, --label-contains', async () => {
    const { artifacts, share } = await freshShareModules();
    const program = programWithArtifacts(artifacts);
    const listCmd = shareGroup(program)?.commands.find((c) => c.name() === 'list');
    expect(listCmd).toBeDefined();
    expect(listCmd?.options.map((o) => o.long)).toEqual(
      expect.arrayContaining(['--list-json', '--for-user', '--scope', '--all', '--agent', '--session', '--label-contains']),
    );
    // The parent `share` command owns --json/--github-user/--visibility; a same-named child
    // option is silently dropped at parse time (RUSH-2687), so `list` must
    // never re-declare them.
    expect(listCmd?.options.map((o) => o.long)).not.toEqual(expect.arrayContaining(['--json', '--github-user', '--visibility']));
  });

  it('a real parse actually delivers --agent/--session/--label-contains/--list-json/--for-user through to runShareList (not just registration)', async () => {
    // Regression guard: commander resolves an option's long name against the
    // WHOLE ancestor chain, not per-command — a `list` option that happens to
    // share a name with the parent `share` command (--label/--title,
    // --json, --github-user) is silently dropped at parse time even though
    // `--help` and `.options` show it registered correctly. Renamed to
    // `--label-contains`/`--list-json`/`--for-user` to avoid the collision
    // (RUSH-2687; see the comment on the option registration). This test
    // exercises the REAL commander parse, not the `runShareList` unit tests
    // above, which call it directly and would never have caught this.
    const { artifacts, share, config } = await freshShareModules();
    const { renderWorkerBundle } = await import('../lib/share/worker-template.js');
    const { hashWorkerScript } = await import('../lib/share/provision.js');
    config.writeShareConfig({
      baseUrl: 'https://share.test', accountId: 'a', workerName: 'w', bucketName: 'b',
      templateHash: hashWorkerScript(renderWorkerBundle().script),
    });
    // `gh` resolves to a DIFFERENT user than the explicit --for-user below —
    // if that flag were silently dropped, the request would go to
    // /gh-default-user instead of /octocat, and the assertion below fails.
    installFakeGh('gh-default-user');

    const objects = [
      { slug: 'a', url: 'https://s/octocat/a', size: 1, contentType: null, publishedAt: '2026-08-08T00:00:00.000Z', expiresAt: null, label: 'Fleet Plan', agent: 'claude', session: 'sess-1', host: null, repo: null, revisionCount: 0, meta: { kind: 'plan' } },
      { slug: 'b', url: 'https://s/octocat/b', size: 1, contentType: null, publishedAt: '2026-08-07T00:00:00.000Z', expiresAt: null, label: 'Other', agent: 'codex', session: 'sess-2', host: null, repo: null, revisionCount: 0, meta: { kind: 'report' } },
    ];
    const seenUrls: string[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string) => {
      seenUrls.push(String(url));
      return new Response(JSON.stringify({ user: 'octocat', count: 2, objects }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;

    try {
      const program = programWithArtifacts(artifacts);
      await program.parseAsync([
        'node', 'agents', 'artifacts', 'share', 'list',
        '--agent', 'claude', '--label-contains', 'fleet', '--meta', 'kind=plan', '--for-user', 'octocat', '--list-json',
      ]);
      const out = loggedOutput();
      expect(seenUrls.length).toBe(1);
      // --for-user reached resolveShareUsername: the fetched URL is scoped
      // to the EXPLICIT namespace, not whatever `gh`/`git` config would resolve.
      expect(seenUrls[0]).toContain('/octocat?');
      // --list-json reached formatShareList: JSON output, not the human table
      // (which would print "Fleet Plan" as a bare heading line, not JSON).
      expect(() => JSON.parse(out)).not.toThrow();
      const parsed = JSON.parse(out) as { objects: Array<{ label: string | null }> };
      expect(parsed.objects.map((o) => o.label)).toEqual(['Fleet Plan']);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('a real parse delivers --scope (and --all as an alias) through to runShareList', async () => {
    const { artifacts, share, config } = await freshShareModules();
    const { renderWorkerBundle } = await import('../lib/share/worker-template.js');
    const { hashWorkerScript } = await import('../lib/share/provision.js');
    config.writeShareConfig({
      baseUrl: 'https://share.test', accountId: 'a', workerName: 'w', bucketName: 'b',
      templateHash: hashWorkerScript(renderWorkerBundle().script),
    });
    installFakeGh('octocat');
    // Hidden scopes need an owner bearer; for BYO tests it can come from env.
    process.env.SHARE_WRITE_TOKEN = 'byo-secret';

    const objects = [
      { slug: 'secret', url: 'https://s/octocat/secret', size: 1, contentType: null, publishedAt: '2026-08-08T00:00:00.000Z', expiresAt: null, label: null, visibility: 'me', agent: null, session: null, host: null, repo: null, revisionCount: 0 },
    ];
    const seenUrls: string[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string) => {
      seenUrls.push(String(url));
      return new Response(JSON.stringify({ user: 'octocat', count: 1, objects }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;

    try {
      const program = programWithArtifacts(artifacts);
      await program.parseAsync([
        'node', 'agents', 'artifacts', 'share', 'list', '--scope', 'me', '--list-json',
      ]);
      expect(seenUrls[0]).toContain('scope=mine');
      const out = loggedOutput();
      const parsed = JSON.parse(out) as { objects: Array<{ slug: string; visibility: string }> };
      expect(parsed.objects[0].visibility).toBe('me');

      // --all is equivalent to --scope all
      seenUrls.length = 0;
      await program.parseAsync([
        'node', 'agents', 'artifacts', 'share', 'list', '--all', '--list-json',
      ]);
      expect(seenUrls[0]).toContain('scope=mine');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe('share metadata edit/filter (PHNX-3278)', () => {
  it('real CLI parsing delivers edit flags to the authenticated PATCH', async () => {
    const { artifacts, config } = await freshShareModules();
    config.writeShareConfig({ baseUrl: 'https://share.test', accountId: 'a', workerName: 'w', bucketName: 'b' });
    process.env.SHARE_WRITE_TOKEN = 'secret';
    process.env.AGENTS_SHARE_BACKEND = 'byo';
    installFakeGh('octocat');
    let init: RequestInit | undefined;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (_url: string | URL | Request, requestInit?: RequestInit) => {
      init = requestInit;
      return new Response(JSON.stringify({ ok: true, url: 'https://share.test/octocat/plan', label: 'Final', meta: { status: 'final' } }), { status: 200 });
    }) as typeof fetch;
    try {
      const program = programWithArtifacts(artifacts);
      await program.parseAsync(['node', 'agents', 'artifacts', 'share', 'edit', 'plan', '--label', 'Final', '--meta', 'status=final', '--edit-json']);
      expect(init?.method).toBe('PATCH');
      expect(JSON.parse(String(init?.body))).toMatchObject({ label: 'Final', meta: { status: 'final' }, metaMode: 'merge' });
      expect(JSON.parse(loggedOutput()).label).toBe('Final');
    } finally {
      globalThis.fetch = originalFetch;
      delete process.env.SHARE_WRITE_TOKEN;
      delete process.env.AGENTS_SHARE_BACKEND;
    }
  });

  it('applies repeatable exact metadata filters with JSON-count parity', async () => {
    const { share } = await freshShareModules();
    const base = {
      user: 'octocat', count: 2,
      objects: [
        { slug: 'a', url: 'https://s/a', size: 1, contentType: null, publishedAt: '', expiresAt: null, label: null, agent: null, session: null, host: null, repo: null, revisionCount: 0, meta: { kind: 'plan', status: 'final' } },
        { slug: 'b', url: 'https://s/b', size: 1, contentType: null, publishedAt: '', expiresAt: null, label: null, agent: null, session: null, host: null, repo: null, revisionCount: 0, meta: { kind: 'plan', status: 'draft' } },
      ],
    };
    const result = share.applyShareListFilters(base, { meta: { kind: 'plan', status: 'final' } });
    expect(result.count).toBe(1);
    expect(result.objects.map((o) => o.slug)).toEqual(['a']);
    expect(JSON.parse(share.formatShareList(result, true)).count).toBe(1);
  });

  it('PATCHes the resolved target with bearer auth and the deliberate edit model', async () => {
    const { share } = await freshShareModules();
    let request: RequestInit | undefined;
    const result = await share.runShareEdit('plan', {
      githubUser: 'octocat', writeToken: 'secret',
      config: { baseUrl: 'https://share.test', accountId: 'a', workerName: 'w', bucketName: 'b' },
      label: 'Final', meta: { status: 'final' }, metaMode: 'merge', removeMeta: ['draft'],
      fetchEdit: (async (_url: string | URL | Request, init?: RequestInit) => {
        request = init;
        return new Response(JSON.stringify({ ok: true, url: 'https://share.test/octocat/plan', label: 'Final', meta: { status: 'final' } }), { status: 200 });
      }) as typeof fetch,
    });
    expect(request?.method).toBe('PATCH');
    expect((request?.headers as Record<string, string>).authorization).toBe('Bearer secret');
    expect(JSON.parse(String(request?.body))).toEqual({ label: 'Final', meta: { status: 'final' }, metaMode: 'merge', removeMeta: ['draft'] });
    expect(result.label).toBe('Final');
  });

  it('refuses credential-shaped metadata on edit unless force is set', async () => {
    const { share } = await freshShareModules();
    const config = { baseUrl: 'https://share.test', accountId: 'a', workerName: 'w', bucketName: 'b' };
    const secret = 'ghp_' + 'A'.repeat(24);
    await expect(share.runShareEdit('plan', {
      githubUser: 'octocat', writeToken: 'secret', config,
      meta: { token: secret },
      fetchEdit: (async () => { throw new Error('must not fetch'); }) as typeof fetch,
    })).rejects.toThrow(/credential-shaped strings/);

    let fetched = false;
    const result = await share.runShareEdit('plan', {
      githubUser: 'octocat', writeToken: 'secret', config,
      meta: { token: secret }, force: true,
      fetchEdit: (async () => {
        fetched = true;
        return new Response(JSON.stringify({ ok: true, url: 'https://share.test/octocat/plan', label: null, meta: { token: secret } }), { status: 200 });
      }) as typeof fetch,
    });
    expect(fetched).toBe(true);
    expect(result.url).toBe('https://share.test/octocat/plan');
  });
});

describe('parseShareRevisions', () => {
  it('validates and normalizes the Worker revisions payload', async () => {
    const { share } = await freshShareModules();
    const body = JSON.stringify({
      key: 'octocat/plan',
      count: 1,
      revisions: [
        { key: 'octocat/plan/rev-1-abc', url: 'https://s/octocat/plan/rev-1-abc', size: 5, contentType: 'text/html', uploadedAt: '2026-08-08T00:00:00.000Z', expiresAt: null, label: 'v1', agent: 'claude', session: 's1', host: 'zion', repo: 'agents-cli' },
      ],
    });
    const result = share.parseShareRevisions('octocat/plan', body);
    expect(result.count).toBe(1);
    expect(result.revisions[0]).toEqual({
      key: 'octocat/plan/rev-1-abc', url: 'https://s/octocat/plan/rev-1-abc', size: 5, contentType: 'text/html',
      uploadedAt: '2026-08-08T00:00:00.000Z', expiresAt: null, label: 'v1', agent: 'claude', session: 's1', host: 'zion', repo: 'agents-cli', meta: {},
    });
  });

  it('surfaces arbitrary --meta entries under revisions[].meta (RUSH-2683 review fix)', async () => {
    const { share } = await freshShareModules();
    const body = JSON.stringify({
      key: 'octocat/plan',
      count: 1,
      revisions: [
        { key: 'octocat/plan/rev-1-abc', url: 'https://s/octocat/plan/rev-1-abc', size: 5, contentType: 'text/html', uploadedAt: '2026-08-08T00:00:00.000Z', expiresAt: null, meta: { kind: 'plan', ticket: 'RUSH-2683' } },
      ],
    });
    const result = share.parseShareRevisions('octocat/plan', body);
    expect(result.revisions[0].meta).toEqual({ kind: 'plan', ticket: 'RUSH-2683' });
  });

  it('fails loud with the outdated-template hint on a non-JSON body', async () => {
    const { share } = await freshShareModules();
    expect(() => share.parseShareRevisions('octocat/plan', '<h1>not json</h1>')).toThrow(/agents artifacts share update/);
  });

  it('fails loud when the JSON has no revisions array', async () => {
    const { share } = await freshShareModules();
    expect(() => share.parseShareRevisions('octocat/plan', JSON.stringify({ key: 'octocat/plan' }))).toThrow(/agents artifacts share update/);
  });
});

describe('runShareRevisions', () => {
  async function currentConfig(share: typeof import('./share.js')): Promise<{ baseUrl: string; accountId: string; workerName: string; bucketName: string; templateHash: string }> {
    const { renderWorkerBundle } = await import('../lib/share/worker-template.js');
    const { hashWorkerScript } = await import('../lib/share/provision.js');
    return {
      baseUrl: 'https://share.test', accountId: 'a', workerName: 'w', bucketName: 'b',
      templateHash: hashWorkerScript(renderWorkerBundle().script),
    };
  }

  it('resolves a bare slug against the caller namespace and fetches ?revisions=json', async () => {
    const { share } = await freshShareModules();
    const config = await currentConfig(share);
    const seen: string[] = [];
    const result = await share.runShareRevisions('q3-report', {
      githubUser: 'octocat',
      config,
      fetchListing: async (url: string) => {
        seen.push(url);
        return { status: 200, contentType: 'application/json', body: JSON.stringify({ key: 'octocat/q3-report', count: 0, revisions: [] }) };
      },
    });
    expect(seen).toEqual(['https://share.test/octocat/q3-report?revisions=json']);
    expect(result.count).toBe(0);
  });

  it('accepts a full URL target, same as agents artifacts unshare', async () => {
    const { share } = await freshShareModules();
    const config = await currentConfig(share);
    const seen: string[] = [];
    await share.runShareRevisions('https://share.test/octocat/q3-report', {
      config,
      fetchListing: async (url: string) => {
        seen.push(url);
        return { status: 200, contentType: 'application/json', body: JSON.stringify({ key: 'octocat/q3-report', count: 0, revisions: [] }) };
      },
    });
    expect(seen).toEqual(['https://share.test/octocat/q3-report?revisions=json']);
  });

  it('throws the outdated-template hint up front when the recorded hash is stale', async () => {
    const { share } = await freshShareModules();
    let fetched = false;
    await expect(
      share.runShareRevisions('q3-report', {
        githubUser: 'octocat',
        config: { baseUrl: 'https://share.test', accountId: 'a', workerName: 'w', bucketName: 'b', templateHash: 'stale-hash' },
        fetchListing: async () => { fetched = true; return { status: 200, contentType: 'application/json', body: '{}' }; },
      }),
    ).rejects.toThrow(/agents artifacts share update/);
    expect(fetched).toBe(false);
  });

  it('refuses when share was never configured', async () => {
    const { share } = await freshShareModules();
    await expect(share.runShareRevisions('q3-report', { githubUser: 'octocat' })).rejects.toThrow(/Not set up yet/);
    await expect(share.runShareRevisions('q3-report', { githubUser: 'octocat' })).rejects.toThrow(/agents auth login/);
  });

  it('signed-in resolves a bare slug against the Phoenix namespace (RUSH-3135)', async () => {
    const { share } = await freshShareModules();
    const { DEFAULT_SHARE_DOMAIN } = await import('../lib/share/config.js');
    const seen: string[] = [];
    const result = await share.runShareRevisions('q3-report', {
      session: { access_token: 'pid_alice', userId: 'alice', email: 'alice@example.com' },
      fetchListing: async (url: string) => {
        seen.push(url);
        return {
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ key: 'alice/q3-report', count: 0, revisions: [] }),
        };
      },
    });
    expect(seen).toEqual([`https://${DEFAULT_SHARE_DOMAIN}/alice/q3-report?revisions=json`]);
    expect(result.key).toBe('alice/q3-report');
  });
});

describe('formatShareRevisions', () => {
  it('--json emits the raw stable result', async () => {
    const { share } = await freshShareModules();
    const result = { key: 'octocat/plan', count: 1, revisions: [{ key: 'octocat/plan/rev-1', url: 'https://s/octocat/plan/rev-1', size: 10, contentType: null, uploadedAt: '2026-08-08T00:00:00.000Z', expiresAt: null, label: 'v1', agent: 'claude', session: null, host: null, repo: null }] };
    expect(JSON.parse(share.formatShareRevisions(result, true))).toEqual(result);
  });

  it('renders a human table with date, size, agent, label, and url', async () => {
    const { share } = await freshShareModules();
    const result = {
      key: 'octocat/plan', count: 1,
      revisions: [{ key: 'octocat/plan/rev-1', url: 'https://s/octocat/plan/rev-1', size: 2048, contentType: null, uploadedAt: '2026-08-08T00:00:00.000Z', expiresAt: null, label: 'v1', agent: 'claude', session: null, host: null, repo: null }],
    };
    const text = share.formatShareRevisions(result);
    expect(text).toContain('octocat/plan');
    expect(text).toContain('1 retained revision');
    expect(text).toContain('2026-08-08');
    expect(text).toContain('2.0 KB');
    expect(text).toContain('claude');
    expect(text).toContain('v1');
    expect(text).toContain('https://s/octocat/plan/rev-1');
  });

  it('says there are no retained revisions for an empty result', async () => {
    const { share } = await freshShareModules();
    expect(share.formatShareRevisions({ key: 'octocat/plan', count: 0, revisions: [] })).toMatch(/No retained revisions/i);
  });

  it('shows arbitrary --meta key=value pairs in the human table (RUSH-2683 review fix)', async () => {
    const { share } = await freshShareModules();
    const result = {
      key: 'octocat/plan', count: 1,
      revisions: [{ key: 'octocat/plan/rev-1', url: 'https://s/octocat/plan/rev-1', size: 2048, contentType: null, uploadedAt: '2026-08-08T00:00:00.000Z', expiresAt: null, label: 'v1', agent: 'claude', session: null, host: null, repo: null, meta: { kind: 'plan', ticket: 'RUSH-2683' } }],
    };
    const text = share.formatShareRevisions(result);
    expect(text).toContain('kind=plan');
    expect(text).toContain('ticket=RUSH-2683');
  });
});

describe('agents artifacts share revisions (CLI)', () => {
  it('registers the revisions command with a target argument and --revisions-json/--for-user (not --json/--github-user, which collide with the parent)', async () => {
    const { artifacts } = await freshShareModules();
    const program = programWithArtifacts(artifacts);
    const revCmd = shareGroup(program)?.commands.find((c) => c.name() === 'revisions');
    expect(revCmd).toBeDefined();
    expect(revCmd?.registeredArguments.map((a) => a.name())).toEqual(['target']);
    expect(revCmd?.options.map((o) => o.long)).toEqual(expect.arrayContaining(['--revisions-json', '--for-user']));
    // The parent `share` command owns these two names; a same-named child
    // option is silently dropped at parse time (see the real-parse test
    // below), so `revisions` must never re-declare them.
    expect(revCmd?.options.map((o) => o.long)).not.toEqual(expect.arrayContaining(['--json', '--github-user']));
  });

  it('a real parse actually delivers --revisions-json/--for-user through to runShareRevisions (not just registration)', async () => {
    // Regression guard: commander resolves an option's long name against the
    // WHOLE ancestor chain, not per-command — a `revisions` option that
    // happens to share a name with the parent `share` command (--json,
    // --github-user) is silently dropped at parse time even though `--help`
    // and `.options` show it registered correctly, and even when the flag is
    // passed ALONE with no other conflicting flags. This exercises the REAL
    // commander parse, not the `runShareRevisions`/`formatShareRevisions` unit
    // tests above, which call those functions directly and would never have
    // caught this (verified with a bare commander repro against both
    // `--github-user`/`--json` colliding names before the rename).
    const { artifacts, config } = await freshShareModules();
    const { renderWorkerBundle } = await import('../lib/share/worker-template.js');
    const { hashWorkerScript } = await import('../lib/share/provision.js');
    config.writeShareConfig({
      baseUrl: 'https://share.test', accountId: 'a', workerName: 'w', bucketName: 'b',
      templateHash: hashWorkerScript(renderWorkerBundle().script),
    });

    const seenUrls: string[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string) => {
      seenUrls.push(String(url));
      return new Response(
        JSON.stringify({ key: 'octocat/q3-report', count: 1, revisions: [
          { key: 'octocat/q3-report/rev-1', url: 'https://s/octocat/q3-report/rev-1', size: 10, contentType: null, uploadedAt: '2026-08-08T00:00:00.000Z', expiresAt: null, label: 'v1', agent: 'claude', session: null, host: null, repo: null },
        ] }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }) as typeof fetch;

    try {
      const program = programWithArtifacts(artifacts);
      await program.parseAsync([
        'node', 'agents', 'artifacts', 'share', 'revisions', 'q3-report',
        '--for-user', 'octocat', '--revisions-json',
      ]);
      // --for-user reached resolveDeleteTarget-equivalent resolution: the
      // fetched URL is scoped to octocat's namespace, not the caller's own
      // (no `gh`/`git` config faked here, so a dropped --for-user would
      // throw "could not resolve a GitHub username" instead of fetching).
      expect(seenUrls).toEqual(['https://share.test/octocat/q3-report?revisions=json']);
      // --revisions-json reached formatShareRevisions: JSON output, not the
      // human table (which would print "1 retained revision").
      const out = loggedOutput();
      expect(() => JSON.parse(out)).not.toThrow();
      expect(JSON.parse(out)).toMatchObject({ key: 'octocat/q3-report', count: 1 });
      expect(out).not.toContain('retained revision');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe('formatSharePublishResult', () => {
  it('emits stable JSON for plan-render hooks and scripts', () => {
    const text = formatSharePublishResult(
      {
        url: 'https://share.example/plan',
        coverUrl: 'https://share.example/plan.png',
        expiresAt: '2030-01-01T00:00:00.000Z',
      },
      true,
    );

    expect(JSON.parse(text)).toEqual({
      url: 'https://share.example/plan',
      coverUrl: 'https://share.example/plan.png',
      expiresAt: '2030-01-01T00:00:00.000Z',
    });
  });

  it('keeps the first human output line as the share URL', () => {
    const text = formatSharePublishResult({ url: 'https://share.example/plan' });

    expect(text.split('\n')[0]).toContain('https://share.example/plan');
  });

  it('prints the resolved slug when publish returns it', () => {
    const text = formatSharePublishResult({
      url: 'https://share.example/octocat/fleet-plan',
      slug: 'fleet-plan',
    });
    expect(text).toContain('slug: fleet-plan');
  });

  it('shows an explicit label plainly, with no derived hint', () => {
    const text = formatSharePublishResult({ url: 'https://share.example/plan', label: 'Fleet Plan', labelSource: 'explicit' });
    expect(text).toContain('Fleet Plan');
    expect(text).not.toContain('derived');
  });

  it('nudges toward --label when the title was auto-derived (never blocks)', () => {
    const text = formatSharePublishResult({ url: 'https://share.example/plan', label: 'plan', labelSource: 'derived' });
    expect(text).toContain('plan');
    expect(text).toMatch(/derived.*--label/);
  });

  it('prints visibility: unlisted with the noindex hint', () => {
    const text = formatSharePublishResult({
      url: 'https://share.example/plan',
      visibility: 'unlisted',
      unlisted: true,
    });
    expect(text).toContain('visibility: unlisted (noindex, hidden from gallery — NOT authenticated)');
  });

  it('prints visibility: private with the token-gated hint + a secret-URL warning', () => {
    const text = formatSharePublishResult({
      url: 'https://share.example/octocat/plan-abc123?k=deadbeef',
      visibility: 'private',
    });
    expect(text).toContain('visibility: private (token-gated');
    expect(text).toMatch(/key is in the URL/);
  });

  it('JSON includes visibility', () => {
    const text = formatSharePublishResult(
      { url: 'https://share.example/plan', visibility: 'unlisted', unlisted: true },
      true,
    );
    expect(JSON.parse(text)).toMatchObject({ visibility: 'unlisted', unlisted: true });
  });
});

describe('--visibility flag (RUSH-3135)', () => {
  it('registers --visibility with public|unlisted|private|me|org choices and NO commander default (the backend-aware me/public default is applied in the action); --protected is visible, --unlisted/--private stay hidden aliases', async () => {
    const { artifacts } = await freshShareModules();
    const program = programWithArtifacts(artifacts);
    const share = shareGroup(program);
    expect(share).toBeDefined();
    const longs = share!.options.map((o) => o.long);
    expect(longs).toEqual(expect.arrayContaining(['--visibility', '--protected', '--unlisted', '--private']));

    const vis = share!.options.find((o) => o.long === '--visibility');
    expect(vis?.argChoices).toEqual(['public', 'unlisted', 'private', 'me', 'org']);
    // No commander default — an unset --visibility must reach the action as
    // undefined so the backend-aware product default (me on managed, public on
    // BYO) can apply. A hardcoded 'public' default here would defeat "private by
    // default when signed in".
    expect(vis?.defaultValue).toBeUndefined();
    expect(vis?.hidden).toBeFalsy();

    // --protected is a first-class (non-hidden) flag — the real read-auth control.
    const prot = share!.options.find((o) => o.long === '--protected');
    expect(prot?.hidden).toBeFalsy();

    const unlisted = share!.options.find((o) => o.long === '--unlisted');
    const priv = share!.options.find((o) => o.long === '--private');
    expect(unlisted?.hidden).toBe(true);
    expect(priv?.hidden).toBe(true);
  });

  async function publishWithFlag(
    args: string[],
  ): Promise<{ visibilityHeader: string; viewerTokenHeader: string; putUrl: string; output: string }> {
    const { artifacts, config } = await freshShareModules();
    config.writeShareConfig({
      baseUrl: 'https://share.test',
      accountId: 'acct',
      workerName: 'w',
      bucketName: 'b',
    });
    process.env.SHARE_WRITE_TOKEN = 'tok';
    installFakeGh('octocat');

    const file = path.join(tmpHome, 'plan.html');
    fs.writeFileSync(file, '<!doctype html><title>Plan</title><h1>ok</h1>');

    let visibilityHeader = '';
    let viewerTokenHeader = '';
    let putUrl = '';
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      if (headers.has('x-share-visibility')) visibilityHeader = headers.get('x-share-visibility') ?? '';
      if (headers.has('x-share-viewer-token')) viewerTokenHeader = headers.get('x-share-viewer-token') ?? '';
      putUrl = String(url);
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as typeof fetch;

    try {
      const program = programWithArtifacts(artifacts);
      await program.parseAsync(['node', 'agents', 'artifacts', 'share', file, '--no-cover', ...args]);
      return { visibilityHeader, viewerTokenHeader, putUrl, output: loggedOutput() };
    } finally {
      globalThis.fetch = originalFetch;
    }
  }

  it('a real parse of --visibility unlisted sends x-share-visibility: unlisted and prints it', async () => {
    const { visibilityHeader, output } = await publishWithFlag(['--visibility', 'unlisted', '--expire', 'never']);
    expect(visibilityHeader).toBe('unlisted');
    expect(output).toContain('visibility: unlisted');
  });

  it('the hidden --unlisted alias maps to --visibility unlisted (no breakage)', async () => {
    const { visibilityHeader, output } = await publishWithFlag(['--unlisted', '--expire', 'never']);
    expect(visibilityHeader).toBe('unlisted');
    expect(output).toContain('visibility: unlisted');
  });

  it('the hidden --private alias maps to --visibility unlisted (no breakage)', async () => {
    const { visibilityHeader } = await publishWithFlag(['--private', '--expire', 'never']);
    expect(visibilityHeader).toBe('unlisted');
  });

  it('--protected sends x-share-visibility: private + a viewer token, and prints a ?k= URL (PHNX-3654)', async () => {
    const { visibilityHeader, viewerTokenHeader, putUrl, output } = await publishWithFlag(['--protected', '--expire', 'never']);
    expect(visibilityHeader).toBe('private');
    // The raw token rides one header; the Worker hashes it. The PUT hits the bare key.
    expect(viewerTokenHeader).toBeTruthy();
    expect(putUrl).not.toContain('?k=');
    // The printed URL carries the key so it is actually openable.
    expect(output).toContain(`?k=${encodeURIComponent(viewerTokenHeader)}`);
    expect(output).toContain('visibility: private (token-gated');
  });

  it('an unlisted publish warns on stderr that unlisted is NOT authentication (PHNX-3654)', async () => {
    const errors: string[] = [];
    const errSpy = vi.spyOn(console, 'error').mockImplementation((s?: unknown) => { errors.push(String(s)); });
    try {
      await publishWithFlag(['--visibility', 'unlisted', '--expire', 'never']);
    } finally {
      errSpy.mockRestore();
    }
    const stderr = errors.join('\n');
    expect(stderr).toMatch(/unlisted is NOT private/i);
    expect(stderr).toContain('--protected');
  });

  it('BYO default (signed out, no flag) sends x-share-visibility: public', async () => {
    const { visibilityHeader, output } = await publishWithFlag(['--expire', 'never']);
    expect(visibilityHeader).toBe('public');
    expect(output).toContain('visibility: public');
  });

  it('managed default (signed in, no flag) sends x-share-visibility: me — private by default (product spec)', async () => {
    const { artifacts } = await freshShareModules();
    const { writeSession } = await import('../lib/identity/client.js');
    writeSession({ access_token: 'pid_alice', userId: 'alice-user-1', email: 'alice@example.com' });

    const file = path.join(tmpHome, 'plan.html');
    fs.writeFileSync(file, '<!doctype html><title>Plan</title><h1>ok</h1>');

    let visibilityHeader = '';
    let putUrl = '';
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      if (headers.has('x-share-visibility')) visibilityHeader = headers.get('x-share-visibility') ?? '';
      putUrl = String(url);
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as typeof fetch;

    try {
      const program = programWithArtifacts(artifacts);
      await program.parseAsync(['node', 'agents', 'artifacts', 'share', file, '--no-cover', '--expire', 'never']);
    } finally {
      globalThis.fetch = originalFetch;
    }
    expect(visibilityHeader).toBe('me');
    // Managed namespace is the email local-part, on the platform endpoint.
    expect(putUrl).toContain('share.getrush.ai/alice/');
    expect(loggedOutput()).toContain('visibility: me (login required, hidden from gallery)');
  });

  it('--visibility me sends x-share-visibility: me and prints the login-required hint', async () => {
    const { visibilityHeader, output } = await publishWithFlag(['--visibility', 'me', '--expire', 'never']);
    expect(visibilityHeader).toBe('me');
    expect(output).toContain('visibility: me (login required, hidden from gallery)');
  });

  it('--visibility org sends x-share-visibility: org and prints the login-required hint', async () => {
    const { visibilityHeader, output } = await publishWithFlag(['--visibility', 'org', '--expire', 'never']);
    expect(visibilityHeader).toBe('org');
    expect(output).toContain('visibility: org (login required, hidden from gallery)');
  });

  it('managed --handle namespaces the publish under the alternate handle and sends x-share-handle (PHNX-3547)', async () => {
    const { artifacts } = await freshShareModules();
    const { writeSession } = await import('../lib/identity/client.js');
    writeSession({ access_token: 'pid_alice', userId: 'alice-user-1', email: 'alice@example.com' });

    const file = path.join(tmpHome, 'plan.html');
    fs.writeFileSync(file, '<!doctype html><title>Plan</title><h1>ok</h1>');

    let handleHeader = '';
    let putUrl = '';
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      if (headers.has('x-share-handle')) handleHeader = headers.get('x-share-handle') ?? '';
      if (headers.has('x-share-visibility')) putUrl = String(url);
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as typeof fetch;

    try {
      const program = programWithArtifacts(artifacts);
      await program.parseAsync(['node', 'agents', 'artifacts', 'share', file, '--no-cover', '--expire', 'never', '--handle', 'Vanity Name!']);
    } finally {
      globalThis.fetch = originalFetch;
    }
    expect(handleHeader).toBe('vanity-name');
    expect(putUrl).toContain('share.getrush.ai/vanity-name/');
  });
});

describe('formatShareDeleteResult', () => {
  it('emits stable JSON with the cover result nested', () => {
    const result: DeleteShareResult = {
      key: 'octocat/plan',
      url: 'https://share.example/octocat/plan',
      existedBefore: true,
      verified404: true,
      cover: {
        key: 'octocat/plan.png',
        url: 'https://share.example/octocat/plan.png',
        existedBefore: true,
        verified404: true,
      },
    };
    expect(JSON.parse(formatShareDeleteResult(result, true))).toEqual(result);
  });

  it('reports a skipped (--if-exists) target distinctly from a real delete', () => {
    const skipped: DeleteShareResult = {
      key: 'octocat/gone',
      url: 'https://share.example/octocat/gone',
      existedBefore: false,
      verified404: true,
      skipped: true,
    };
    expect(formatShareDeleteResult(skipped)).toMatch(/skipped/i);
  });
});

describe('runShareDelete (CLI-layer multi-target handler)', () => {
  const okResult = (target: string): DeleteShareResult => ({
    key: target,
    url: `https://share.example/${target}`,
    existedBefore: true,
    verified404: true,
  });

  it('continues past a failed target and deletes the rest (rm-style)', async () => {
    const attempted: string[] = [];
    const fakeDelete = async (target: string) => {
      attempted.push(target);
      if (target === 'octocat/bad') throw new Error('takedown NOT verified');
      return okResult(target);
    };
    await runShareDelete(['octocat/good-1', 'octocat/bad', 'octocat/good-2'], {}, fakeDelete as never);
    expect(attempted).toEqual(['octocat/good-1', 'octocat/bad', 'octocat/good-2']);
  });

  it('sets a non-zero exitCode when any target failed', async () => {
    const prevExitCode = process.exitCode;
    try {
      const fakeDelete = async (target: string) => {
        if (target === 'octocat/bad') throw new Error('boom');
        return okResult(target);
      };
      process.exitCode = 0;
      await runShareDelete(['octocat/good', 'octocat/bad'], {}, fakeDelete as never);
      expect(process.exitCode).toBe(1);
    } finally {
      process.exitCode = prevExitCode;
    }
  });

  it('leaves exitCode untouched when every target succeeds', async () => {
    const prevExitCode = process.exitCode;
    try {
      process.exitCode = 0;
      await runShareDelete(['octocat/a', 'octocat/b'], {}, (async (t: string) => okResult(t)) as never);
      expect(process.exitCode).toBe(0);
    } finally {
      process.exitCode = prevExitCode;
    }
  });

  it('a --if-exists skip does not count as a failure', async () => {
    const prevExitCode = process.exitCode;
    try {
      process.exitCode = 0;
      const skipped: DeleteShareResult = { key: 'octocat/gone', url: 'x', existedBefore: false, verified404: true, skipped: true };
      await runShareDelete(['octocat/gone'], { ifExists: true }, (async () => skipped) as never);
      expect(process.exitCode).toBe(0);
    } finally {
      process.exitCode = prevExitCode;
    }
  });

  it('--delete-json emits one array covering every target, success and failure alike', async () => {
    const logs: string[] = [];
    const errors: string[] = [];
    const logSpy = vi.spyOn(console, 'log').mockImplementation((s: string) => { logs.push(s); });
    const errSpy = vi.spyOn(console, 'error').mockImplementation((s: string) => { errors.push(s); });
    try {
      const fakeDelete = async (target: string) => {
        if (target === 'octocat/bad') throw new Error('takedown NOT verified');
        return okResult(target);
      };
      await runShareDelete(['octocat/good', 'octocat/bad'], { deleteJson: true }, fakeDelete as never);
      // JSON mode suppresses the per-target console lines — only the final array prints.
      expect(errors).toEqual([]);
      expect(logs.length).toBe(1);
      const parsed = JSON.parse(logs[0]);
      expect(parsed).toHaveLength(2);
      expect(parsed[0]).toMatchObject({ target: 'octocat/good', result: { key: 'octocat/good' } });
      expect(parsed[1]).toMatchObject({ target: 'octocat/bad', error: expect.stringContaining('takedown NOT verified') });
    } finally {
      logSpy.mockRestore();
      errSpy.mockRestore();
    }
  });
});

describe('agents artifacts share delete (CLI)', () => {
  it('a real parse actually delivers --for-user/--delete-json through to the delete result (RUSH-2687 — --github-user/--json collide with the parent `share`)', async () => {
    // Same collision class as `list`/`update` above: `delete` would have
    // registered its own --json and --github-user, both of which share a name
    // with the parent `share` command's own --json/--github-user — renamed to
    // --delete-json/--for-user instead (RUSH-2687).
    const { artifacts, config } = await freshShareModules();
    config.writeShareConfig({
      baseUrl: 'https://share.test', accountId: 'a', workerName: 'w', bucketName: 'b',
    });
    process.env.SHARE_WRITE_TOKEN = 'tok';
    // `gh` resolves to a DIFFERENT user than the explicit --for-user below —
    // if that flag were silently dropped, the request would target
    // /gh-default-user/my-plan instead of /octocat/my-plan.
    installFakeGh('gh-default-user');

    const seenUrls: string[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      seenUrls.push(`${init?.method ?? 'GET'} ${url}`);
      // HEAD check before delete: exists (200). HEAD check after delete: gone (404).
      const isCheck = !init?.method || init.method === 'HEAD';
      const alreadyDeleted = seenUrls.filter((u) => u.includes('DELETE')).length > 0;
      const status = isCheck && alreadyDeleted ? 404 : 200;
      return new Response(isCheck ? null : JSON.stringify({ ok: true }), { status });
    }) as typeof fetch;

    try {
      const program = programWithArtifacts(artifacts);
      await program.parseAsync([
        'node', 'agents', 'artifacts', 'share', 'delete', 'my-plan',
        '--for-user', 'octocat', '--delete-json',
      ]);
      // --for-user reached resolveDeleteTarget: the HEAD/DELETE calls target
      // the EXPLICIT namespace, not whatever `gh`/`git` config would resolve.
      expect(seenUrls.some((u) => u.includes('/octocat/my-plan'))).toBe(true);
      expect(seenUrls.some((u) => u.includes('/gh-default-user/'))).toBe(false);
      // --delete-json reached formatShareDeleteResult / the results array:
      // JSON output, not the human "deleted <url>" line.
      const out = loggedOutput();
      expect(() => JSON.parse(out)).not.toThrow();
      const parsed = JSON.parse(out) as Array<{ target: string; result?: { key: string } }>;
      expect(parsed).toHaveLength(1);
      expect(parsed[0]).toMatchObject({ target: 'my-plan', result: { key: 'octocat/my-plan' } });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe('runShareOpen (PHNX-3370 — open my page signed in as owner)', () => {
  const OCTO = { access_token: 'pid_octo', userId: 'u-octo', email: 'octocat@example.com' };

  it('mints a ticket with the owner bearer and builds the ticketed owner URL', async () => {
    const share = await import('./share.js');
    let hitUrl = '';
    let bearer = '';
    const result = await share.runShareOpen('plan', {
      session: OCTO,
      fetchTicket: async (url: string, b: string) => {
        hitUrl = url;
        bearer = b;
        return { status: 200, body: JSON.stringify({ ticket: 'TICKET123' }) };
      },
    });
    expect(hitUrl).toMatch(/\/__ticket$/);
    expect(bearer).toBe('pid_octo'); // the Phoenix access_token, not printed anywhere
    expect(result.key).toBe('octocat/plan');
    expect(result.url).toMatch(/\/octocat\/plan$/);
    expect(result.ownerUrl).toBe(`${result.url}?phoenix_ticket=TICKET123`);
  });

  it('points at share update when the Worker predates the mint route', async () => {
    const share = await import('./share.js');
    await expect(
      share.runShareOpen('plan', {
        session: OCTO,
        fetchTicket: async () => ({ status: 501, body: '{"error":"ticket minting is not configured"}' }),
      }),
    ).rejects.toThrow(/share update/i);
  });

  it('refuses a BYO endpoint — the owner control is Phoenix-gated', async () => {
    const share = await import('./share.js');
    const prev = process.env[SHARE_TOKEN_ENV_KEY];
    process.env[SHARE_TOKEN_ENV_KEY] = 'byo-token';
    try {
      await expect(
        share.runShareOpen('plan', {
          session: null,
          config: { baseUrl: 'https://byo.example', accountId: '', workerName: '', bucketName: '', domain: '' },
          fetchTicket: async () => ({ status: 200, body: '{"ticket":"x"}' }),
        }),
      ).rejects.toThrow(/managed/i);
    } finally {
      if (prev === undefined) delete process.env[SHARE_TOKEN_ENV_KEY];
      else process.env[SHARE_TOKEN_ENV_KEY] = prev;
    }
  });
});
