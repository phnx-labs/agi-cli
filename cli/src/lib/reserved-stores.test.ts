import { describe, expect, it } from 'vitest';
import { ALL_AGENT_IDS } from './agents.js';
import {
  AUTH_BUNDLE_BACKEND,
  AUTH_BUNDLE_NAME,
  AUTH_STORE_ALIAS,
  RESERVED_STORES,
  ReservedBundleWrongBackendError,
  assertReservedAuthBackend,
  assertStorableCredentialKind,
  isReservedBundleBackendError,
  isReservedStoreName,
  reservedStoreName,
} from './reserved-stores.js';
import { SecretsClientError } from './secrets-client.js';

describe('RESERVED_STORES', () => {
  it('names one __<harness>__ store for every ALL_AGENT_IDS entry', () => {
    expect(Object.keys(RESERVED_STORES).sort()).toEqual([...ALL_AGENT_IDS].sort());
    for (const id of ALL_AGENT_IDS) {
      expect(RESERVED_STORES[id]).toBe(`__${id}__`);
      expect(isReservedStoreName(`__${id}__`)).toBe(true);
      expect(reservedStoreName(id)).toBe(`__${id}__`);
    }
  });

  it('keeps the legacy auth bundle as a readable alias without migrating data', () => {
    expect(AUTH_STORE_ALIAS).toBe('auth');
    expect(AUTH_BUNDLE_NAME).toBe(AUTH_STORE_ALIAS);
    expect(isReservedStoreName('auth')).toBe(true);
    expect(isReservedStoreName('AUTH')).toBe(true);
    expect(isReservedStoreName('prod')).toBe(false);
  });
});

describe('assertStorableCredentialKind', () => {
  it('accepts only setup-token and api-key', () => {
    expect(() => assertStorableCredentialKind('setup-token')).not.toThrow();
    expect(() => assertStorableCredentialKind('api-key')).not.toThrow();
  });

  it('refuses a rotating session with the harness-specific reason', () => {
    expect(() => assertStorableCredentialKind('oauth', 'codex')).toThrow(
      'codex: auth.json is a rotating session; add an API key instead',
    );
    expect(() => assertStorableCredentialKind('refresh', 'droid')).toThrow(/FACTORY_API_KEY/);
    expect(() => assertStorableCredentialKind('native', 'claude')).toThrow(/setup-token/);
    expect(() => assertStorableCredentialKind('session', 'kimi')).toThrow(/log in per device/);
    expect(() => assertStorableCredentialKind('bearer-token')).toThrow(
      /reserved stores accept only a setup-token or an API key/,
    );
  });
});

describe('reserved auth bundle backend rule (credential-management invariant 7)', () => {
  it('accepts only the file backend and names the offending backend otherwise', () => {
    expect(AUTH_BUNDLE_BACKEND).toBe('file');
    expect(() => assertReservedAuthBackend('file')).not.toThrow();
    for (const backend of ['keychain', 'vault'] as const) {
      let thrown: unknown;
      try {
        assertReservedAuthBackend(backend);
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(ReservedBundleWrongBackendError);
      expect((thrown as ReservedBundleWrongBackendError).bundle).toBe(AUTH_STORE_ALIAS);
      expect((thrown as ReservedBundleWrongBackendError).backend).toBe(backend);
      expect((thrown as Error).message).toContain(`agents secrets create ${AUTH_STORE_ALIAS} --backend file`);
    }
  });

  it('recognizes the refusal whether raised here or returned by the standalone', () => {
    expect(isReservedBundleBackendError(new ReservedBundleWrongBackendError('auth', 'keychain'))).toBe(true);
    expect(isReservedBundleBackendError(new SecretsClientError('WRONG_BACKEND', 'Secrets operation failed (WRONG_BACKEND)'))).toBe(true);
    expect(isReservedBundleBackendError(new SecretsClientError('NOT_FOUND', 'Secrets operation failed (NOT_FOUND)'))).toBe(false);
    expect(isReservedBundleBackendError(new Error('Bundle not found'))).toBe(false);
  });
});
