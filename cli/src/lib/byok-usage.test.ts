import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  getByokUsageForHarness,
  renderByokBar,
  setByokFetchForTest,
  resetByokCacheForTest,
  setByokCachePathForTest,
  refreshDueByokUsage,
  BYOK_REFRESH_INTERVAL_MS,
} from './byok-usage.js';
import { profileKeychainItem, setKeychainTokenSync } from './secrets-client.js';
import { standaloneKeychainIsFileBacked, useFreshSecretsHome } from '../../tests/secrets-standalone.js';
import type { Profile } from './profiles.js';
import * as state from './state.js';
import { addAccount } from './account-registry.js';

// Keychain item for 'openrouter' provider: agents-cli.openrouter.token
const KEYCHAIN_ITEM = profileKeychainItem('openrouter');

// Profile tokens and account bundles are keychain items, so on a headed macOS box the real
// standalone would use the operator's login keychain; credential-backed cases run where items are
// file-backed (headless Linux/Windows, CI). Each test gets its own empty standalone store.
const fileBacked = await standaloneKeychainIsFileBacked();
useFreshSecretsHome();

function makeProfile(overrides?: Partial<Profile>): Profile {
  return {
    name: 'test-harness',
    host: { agent: 'claude' },
    env: {},
    auth: { envVar: 'ANTHROPIC_API_KEY', keychainItem: KEYCHAIN_ITEM },
    provider: 'openrouter',
    ...overrides,
  };
}

let cacheDir: string;
let previousCachePath: string | null;

beforeAll(() => {
  cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-byok-usage-'));
  previousCachePath = setByokCachePathForTest(path.join(cacheDir, 'cache.json'));
});

afterAll(() => {
  setByokCachePathForTest(previousCachePath);
  fs.rmSync(cacheDir, { recursive: true, force: true });
});

beforeEach(() => {
  resetByokCacheForTest();
  setByokFetchForTest(globalThis.fetch);
  vi.spyOn(state, 'getUserAgentsDir').mockReturnValue(cacheDir);
});

afterEach(() => {
  setByokFetchForTest(globalThis.fetch);
  vi.restoreAllMocks();
});

const OR_SUCCESS = {
  data: { limit: 10, limit_remaining: 7.5, usage: 2.5 },
};

function makeFetch(body: unknown, status = 200): typeof globalThis.fetch {
  return async () =>
    ({
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
    }) as Response;
}

describe('getByokUsageForHarness', () => {
  it('returns null when the profile has no registered provider', async () => {
    const result = await getByokUsageForHarness(makeProfile({ provider: 'unknown-provider' }));
    expect(result).toBeNull();
  });

  it('returns null when the profile has no auth', async () => {
    const result = await getByokUsageForHarness(makeProfile({ auth: undefined }));
    expect(result).toBeNull();
  });
});

describe.skipIf(!fileBacked)('getByokUsageForHarness with a credential in the standalone secrets store', () => {
  it('returns budget:null error:null when the token is not in the keychain', async () => {
    const result = await getByokUsageForHarness(makeProfile(), { forceRefresh: true });
    expect(result).toEqual({ budget: null, error: null });
  });

  it('maps a successful OpenRouter response to ByokBudgetInfo fields', async () => {
    setKeychainTokenSync(KEYCHAIN_ITEM, 'sk-or-test');
    setByokFetchForTest(makeFetch(OR_SUCCESS));
    const result = await getByokUsageForHarness(makeProfile(), { forceRefresh: true });
    expect(result?.error).toBeNull();
    expect(result?.budget).toMatchObject({
      limitUsd: 10,
      remainingUsd: 7.5,
      usedUsd: 2.5,
      usedPercent: 25,
    });
    expect(result?.budget?.fetchedAt).toBeInstanceOf(Date);
  });

  it('maps DeepInfra checklist usage from a durable account', async () => {
    addAccount('deepinfra-test', 'deepinfra', 'api-key', 'di-test', cacheDir);
    let request: { url: string; authorization: string | null } | null = null;
    setByokFetchForTest(async (input, init) => {
      request = {
        url: String(input),
        authorization: new Headers(init?.headers).get('Authorization'),
      };
      return {
        ok: true,
        status: 200,
        json: async () => ({ stripe_balance: -12, recent: 3, limit: 10 }),
      } as Response;
    });
    const profile = makeProfile({
      host: { agent: 'codex' },
      provider: 'deepinfra',
      account: 'deepinfra-test',
      auth: undefined,
    });
    const result = await getByokUsageForHarness(profile, { forceRefresh: true });
    expect(request).toEqual({
      url: 'https://api.deepinfra.com/payment/checklist',
      authorization: 'Bearer di-test',
    });
    expect(result?.budget).toMatchObject({
      limitUsd: 10,
      remainingUsd: 7,
      usedUsd: 3,
      usedPercent: 30,
    });
  });

  it('renders DeepInfra prepaid credit when no spending limit is configured', async () => {
    addAccount('deepinfra-prepaid', 'deepinfra', 'api-key', 'di-prepaid', cacheDir);
    setByokFetchForTest(makeFetch({ stripe_balance: -12, recent: 3, limit: null }));
    const result = await getByokUsageForHarness(makeProfile({
      host: { agent: 'codex' },
      provider: 'deepinfra',
      account: 'deepinfra-prepaid',
      auth: undefined,
    }), { forceRefresh: true });
    expect(result?.budget).toMatchObject({
      limitUsd: null,
      remainingUsd: 12,
      usedUsd: 3,
      usedPercent: null,
    });
    expect(renderByokBar(result!)).toContain('$12.00 credit, $3.00 used (no spending limit)');
  });

  it('treats limit:null as an unlimited key', async () => {
    setKeychainTokenSync(KEYCHAIN_ITEM, 'sk-or-test');
    setByokFetchForTest(makeFetch({ data: { limit: null, limit_remaining: null, usage: 1.23 } }));
    const result = await getByokUsageForHarness(makeProfile(), { forceRefresh: true });
    expect(result?.budget?.limitUsd).toBeNull();
    expect(result?.budget?.remainingUsd).toBeNull();
    expect(result?.budget?.usedPercent).toBeNull();
    expect(result?.budget?.usedUsd).toBe(1.23);
  });

  it('returns error when the response is non-200', async () => {
    setKeychainTokenSync(KEYCHAIN_ITEM, 'sk-or-test');
    setByokFetchForTest(makeFetch({ error: 'unauthorized' }, 401));
    const result = await getByokUsageForHarness(makeProfile(), { forceRefresh: true });
    expect(result?.error).toMatch(/401/);
    expect(result?.budget).toBeNull();
  });

  it('does not divide by zero when limit is 0', async () => {
    setKeychainTokenSync(KEYCHAIN_ITEM, 'sk-or-test');
    setByokFetchForTest(makeFetch({ data: { limit: 0, limit_remaining: 0, usage: 0 } }));
    const result = await getByokUsageForHarness(makeProfile(), { forceRefresh: true });
    expect(result?.budget?.usedPercent).toBeNull();
  });

  it('ordinary reads are cache-only and never fetch', async () => {
    setKeychainTokenSync(KEYCHAIN_ITEM, 'sk-or-test');
    let calls = 0;
    setByokFetchForTest(async () => {
      calls++;
      return { ok: true, status: 200, json: async () => OR_SUCCESS } as Response;
    });
    const cold = await getByokUsageForHarness(makeProfile());
    expect(cold).toEqual({ budget: null, error: 'stale' });
    await getByokUsageForHarness(makeProfile(), { forceRefresh: true });
    await getByokUsageForHarness(makeProfile());
    expect(calls).toBe(1);
  });

  it('serves a shared snapshot after an explicit refresh', async () => {
    setKeychainTokenSync(KEYCHAIN_ITEM, 'sk-or-test');
    let calls = 0;
    setByokFetchForTest(async () => {
      calls++;
      return { ok: true, status: 200, json: async () => OR_SUCCESS } as Response;
    });
    await getByokUsageForHarness(makeProfile(), { forceRefresh: true });
    expect(calls).toBe(1);
    // Second call (fresh): still 1.
    await getByokUsageForHarness(makeProfile());
    expect(calls).toBe(1);
  });

  it('bypasses cache when forceRefresh is true', async () => {
    setKeychainTokenSync(KEYCHAIN_ITEM, 'sk-or-test');
    let calls = 0;
    setByokFetchForTest(async () => {
      calls++;
      return { ok: true, status: 200, json: async () => OR_SUCCESS } as Response;
    });
    await getByokUsageForHarness(makeProfile(), { forceRefresh: true });
    await getByokUsageForHarness(makeProfile(), { forceRefresh: true });
    expect(calls).toBe(2);
  });

  it('lets the daemon refresh due BYOK snapshots while ordinary reads stay cache-only', async () => {
    setKeychainTokenSync(KEYCHAIN_ITEM, 'sk-or-test');
    let calls = 0;
    setByokFetchForTest(async () => {
      calls++;
      return { ok: true, status: 200, json: async () => OR_SUCCESS } as Response;
    });
    const now = Date.now();
    expect(await refreshDueByokUsage([makeProfile()], now)).toEqual({ refreshed: 1, skipped: 0 });
    expect((await getByokUsageForHarness(makeProfile()))?.budget?.usedUsd).toBe(2.5);
    expect(await refreshDueByokUsage([makeProfile()], now + BYOK_REFRESH_INTERVAL_MS - 1)).toEqual({ refreshed: 0, skipped: 1 });
    expect(calls).toBe(1);
  });
});
