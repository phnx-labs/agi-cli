import { describe, expect, it } from 'vitest';
import { DEFAULT_CF_BUNDLE, readCloudflareCreds } from './creds.js';

describe('readCloudflareCreds', () => {
  it('defaults to the `cloudflare` bundle', () => {
    expect(DEFAULT_CF_BUNDLE).toBe('cloudflare');
  });

  it('an explicit --token/--account override bypasses the bundle entirely', () => {
    // The escape hatch: with a token passed directly, the function never touches
    // the secrets store (no bundle needs to exist), so this is deterministic and
    // needs no secrets backend.
    expect(readCloudflareCreds('cloudflare', { apiToken: 'cf-tok', accountId: 'acct-1' })).toEqual({
      apiToken: 'cf-tok',
      accountId: 'acct-1',
    });
  });

  it('an override token with no account yields an empty accountId, not undefined', () => {
    expect(readCloudflareCreds('cloudflare', { apiToken: 'cf-tok' })).toEqual({
      apiToken: 'cf-tok',
      accountId: '',
    });
  });

  it('a missing bundle fails loud naming the bundle (no override, no store)', () => {
    // Points SECRETS_HOME at an empty throwaway dir so the `cloudflare` bundle
    // genuinely does not exist; the error must name it and the remediation.
    const prev = process.env.SECRETS_HOME;
    process.env.SECRETS_HOME = '/nonexistent/agents-cf-creds-test';
    try {
      expect(() => readCloudflareCreds('cloudflare')).toThrow(/'cloudflare' bundle does not exist|--token/);
    } finally {
      if (prev === undefined) delete process.env.SECRETS_HOME;
      else process.env.SECRETS_HOME = prev;
    }
  });
});
