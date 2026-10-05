import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as secretsClient from '../../secrets-client.js';
import {
  loadR2Config,
  isSyncConfigured,
  clearR2ConfigCache,
  SYNC_BUNDLE,
} from './config.js';

const VALID_ENV = {
  R2_ACCOUNT_ID: 'acct123',
  R2_BUCKET_NAME: 'agents-sessions',
  R2_ACCESS_KEY_ID: 'ak-test',
  R2_SECRET_ACCESS_KEY: 'sk-test',
};

let spy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  spy = vi.spyOn(secretsClient, 'readAndResolveBundleEnvSync');
  clearR2ConfigCache();
});
afterEach(() => {
  spy.mockRestore();
  clearR2ConfigCache();
});

function resolvesWith(env: Record<string, string>): void {
  spy.mockReturnValue({ bundle: { name: SYNC_BUNDLE, vars: {} }, env });
}

function throwsWith(message: string): void {
  spy.mockImplementation(() => { throw new Error(message); });
}

describe('R2 config resolution cache', () => {
  it('reads through the client once across many loadR2Config calls', () => {
    resolvesWith(VALID_ENV);
    const a = loadR2Config();
    const b = loadR2Config();
    const c = loadR2Config();
    expect(a.bucket).toBe('agents-sessions');
    expect(a.endpoint).toBe('https://acct123.r2.cloudflarestorage.com');
    expect(b).toBe(a);
    expect(c).toBe(a);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('lets isSyncConfigured short-circuit once resolved (no re-read)', () => {
    resolvesWith(VALID_ENV);
    expect(isSyncConfigured()).toBe(true);
    expect(isSyncConfigured()).toBe(true);
    expect(isSyncConfigured()).toBe(true);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('clearR2ConfigCache forces a fresh read (credential rotation / SIGHUP)', () => {
    resolvesWith(VALID_ENV);
    loadR2Config();
    expect(spy).toHaveBeenCalledTimes(1);
    clearR2ConfigCache();
    loadR2Config();
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it('re-checks an ABSENT bundle every cycle (never prompts, fast pickup)', () => {
    throwsWith(`Bundle '${SYNC_BUNDLE}' not found.`);
    expect(isSyncConfigured(1_000)).toBe(false);
    expect(isSyncConfigured(2_000)).toBe(false);
    expect(spy).toHaveBeenCalledTimes(2);
  });
});

describe('session-sync SEC-13: any client throw degrades, never propagates through isSyncConfigured', () => {
  it('a throw from the client (e.g. a locked bundle) degrades to no-transport: isSyncConfigured false, NO throw propagates', () => {
    throwsWith('not unlocked in the secrets agent — run `agents secrets unlock r2.backups`');
    expect(() => isSyncConfigured()).not.toThrow();
    expect(isSyncConfigured()).toBe(false);
  });

  it('loadR2Config still surfaces the real error for a caller that wants it (not a silent no-op)', () => {
    throwsWith('not unlocked in the secrets agent — run `agents secrets unlock r2.backups`');
    expect(() => loadR2Config()).toThrow(/not unlocked in the secrets agent/);
    expect(() => loadR2Config()).toThrow(/agents secrets unlock r2\.backups/);
  });

  it('is re-checked each cycle (no cooldown) and recovers once the client resolves', () => {
    throwsWith('locked');
    expect(isSyncConfigured(1_000)).toBe(false);
    expect(isSyncConfigured(2_000)).toBe(false);
    expect(spy).toHaveBeenCalledTimes(2);
    resolvesWith(VALID_ENV);
    expect(isSyncConfigured(3_000)).toBe(true);
    expect(loadR2Config().bucket).toBe('agents-sessions');
  });

  it('recovers immediately once an unreadable bundle becomes valid (no backoff)', () => {
    const t0 = 5_000_000;
    throwsWith('not found');
    expect(isSyncConfigured(t0)).toBe(false);
    resolvesWith(VALID_ENV);
    expect(isSyncConfigured(t0 + 1)).toBe(true);
    expect(loadR2Config().bucket).toBe('agents-sessions');
  });
});
