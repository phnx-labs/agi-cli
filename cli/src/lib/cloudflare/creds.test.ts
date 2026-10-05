import { describe, expect, it } from 'vitest';
import { DEFAULT_CF_BUNDLE, readCloudflareCreds } from './creds.js';

describe('readCloudflareCreds', () => {
  it('defaults to the `cloudflare` bundle', () => {
    expect(DEFAULT_CF_BUNDLE).toBe('cloudflare');
  });

  it('an explicit --token/--account override bypasses the bundle entirely', () => {
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
