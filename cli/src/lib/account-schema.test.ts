import { describe, expect, it } from 'vitest';
import type { SecretsBundle } from './secrets-types.js';
import { ACCOUNT_POLICY, ACCOUNT_VARS, accountSecretItem, buildAccountBundle, parseAccountBundle, secretVarFor } from './account-schema.js';

describe('account bundle schema', () => {
  it('routes the credential to API_KEY for api-key and TOKEN otherwise', () => {
    expect(secretVarFor('api-key')).toBe('API_KEY');
    expect(secretVarFor('setup-token')).toBe('TOKEN');
    expect(secretVarFor('bearer-token')).toBe('TOKEN');
    expect(accountSecretItem('work', 'api-key')).toBe('agents-cli.secrets.work.API_KEY');
    expect(accountSecretItem('work', 'setup-token')).toBe('agents-cli.secrets.work.TOKEN');
  });

  it('builds a never-policy bundle with identity literals and a keychain-ref secret', () => {
    const { bundle, items } = buildAccountBundle(
      { id: 'id-1', name: 'work', provider: 'openrouter', auth: 'api-key', baseUrl: 'https://gw/api' },
      'sk-secret',
    );
    expect(bundle.name).toBe('work');
    expect(bundle.policy).toBe(ACCOUNT_POLICY);
    expect(bundle.vars[ACCOUNT_VARS.id]).toBe('id-1');
    expect(bundle.vars[ACCOUNT_VARS.provider]).toBe('openrouter');
    expect(bundle.vars[ACCOUNT_VARS.authType]).toBe('api-key');
    expect(bundle.vars[ACCOUNT_VARS.baseUrl]).toEqual({ value: 'https://gw/api' });
    expect(bundle.vars[ACCOUNT_VARS.apiKey]).toBe('keychain:API_KEY');
    expect([...items.entries()]).toEqual([['agents-cli.secrets.work.API_KEY', 'sk-secret']]);
  });

  it('omits BASE_URL when the account has none', () => {
    const { bundle } = buildAccountBundle({ id: 'id', name: 'n', provider: 'cursor', auth: 'api-key' }, 'k');
    expect(ACCOUNT_VARS.baseUrl in bundle.vars).toBe(false);
  });

  it('round-trips an account through build then parse', () => {
    const record = { id: 'id-9', name: 'company', provider: 'anthropic', auth: 'setup-token' as const, baseUrl: undefined };
    const { bundle } = buildAccountBundle(record, 'sk-ant-oat01-x');
    expect(parseAccountBundle(bundle)).toEqual(record);
  });

  it('does not recognize an ordinary secrets bundle as an account', () => {
    const bundle: SecretsBundle = { name: 'apple.com', vars: { APPLE_TEAM_ID: 'keychain:APPLE_TEAM_ID' } };
    expect(parseAccountBundle(bundle)).toBeNull();
  });

  it('rejects a bundle with an unknown AUTH_TYPE literal', () => {
    const bundle: SecretsBundle = { name: 'x', vars: { ACCOUNT_ID: 'id', PROVIDER: 'openrouter', AUTH_TYPE: 'password' } };
    expect(parseAccountBundle(bundle)).toBeNull();
  });
});
