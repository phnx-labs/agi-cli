import { describe, it, expect } from 'vitest';
import { assertNoNativeOAuthTransfer, buildCredentialScript, isNativeOAuthRuntime, LEASE_RUNTIMES, refusedNativeOAuthRuntimes, inferLeaseRuntime, profileNeedsBaseRuntimeCredentials, type DetectedRuntime } from './runtimes.js';
import type { AgentId } from '../types.js';
import { getPreset } from '../profiles-presets.js';
import { profileFromPreset } from '../profiles.js';

describe('inferLeaseRuntime', () => {
  const signedIn = (id: DetectedRuntime['id'], email: string | null): DetectedRuntime => ({
    id, label: id, email, signedIn: true, credPath: `/tmp/${id}.json`,
  });

  it('uses the agent itself when it is a lease-capable runtime', () => {
    const detected = [signedIn('claude', 'a@b.com'), signedIn('grok', 'g@x.ai')];
    expect(inferLeaseRuntime('grok', detected)).toBe('grok');
    expect(inferLeaseRuntime('codex', [signedIn('codex', null)])).toBe('codex');
  });

  it('returns null when the named runtime is not signed in — never substitutes another', () => {
    expect(inferLeaseRuntime('codex', [signedIn('claude', 'a@b.com')])).toBeNull();
    expect(inferLeaseRuntime('grok', [
      { id: 'grok', label: 'Grok CLI', email: null, signedIn: false, credPath: null },
      signedIn('claude', 'a@b.com'),
    ])).toBeNull();
  });

  it('falls back to the signed-in runtime (preferring claude) for a custom agent', () => {
    const detected = [signedIn('claude', 'a@b.com'), signedIn('grok', 'g@x.ai')];
    expect(inferLeaseRuntime('my-workflow', detected)).toBe('claude');
  });

  it('falls back to the only signed-in runtime when claude is absent', () => {
    expect(inferLeaseRuntime('my-workflow', [signedIn('grok', 'g@x.ai')])).toBe('grok');
  });

  it('ignores runtimes with no local credential', () => {
    const detected: DetectedRuntime[] = [
      { id: 'claude', label: 'Claude Code', email: null, signedIn: true, credPath: null },
      signedIn('grok', 'g@x.ai'),
    ];
    expect(inferLeaseRuntime('my-workflow', detected)).toBe('grok');
  });

  it('returns null when nothing is signed in', () => {
    expect(inferLeaseRuntime('my-workflow', [])).toBeNull();
    expect(inferLeaseRuntime('my-workflow', [
      { id: 'claude', label: 'Claude Code', email: null, signedIn: false, credPath: null },
    ])).toBeNull();
  });
});

describe('buildCredentialScript — native OAuth transfer is refused (SING-1b)', () => {
  const detected = (id: AgentId): DetectedRuntime => ({ id, label: id, email: `${id}@x.com`, signedIn: true, credPath: `/tmp/${id}.json` });
  const OAUTH_BLOB = '{"claudeAiOauth":{"accessToken":"sk-ant-oat01-SECRET","refreshToken":"rt-SECRET"}}';

  it('classifies every LEASE_RUNTIMES entry as native OAuth (nothing slips through)', () => {
    for (const cred of LEASE_RUNTIMES) expect(isNativeOAuthRuntime(cred.id)).toBe(true);
    expect(LEASE_RUNTIMES.map((c) => c.id).sort()).toEqual(['claude', 'codex', 'grok']);
  });

  it('refuses each native runtime (claude/codex/grok) instead of serializing its login', () => {
    for (const id of ['claude', 'codex', 'grok'] as AgentId[]) {
      expect(() => buildCredentialScript([id], [detected(id)])).toThrow(/Refusing to copy native OAuth/i);
    }
  });

  it('refuses BEFORE reading any file or emitting the OAuth blob, and steers to accounts sync', () => {
    try {
      buildCredentialScript(['claude'], [detected('claude')], { claudeCredentialsJson: OAUTH_BLOB });
      throw new Error('expected a refusal');
    } catch (e) {
      const msg = (e as Error).message;
      expect(msg).toContain('agents accounts sync');
      expect(msg).toContain('SING-1b');
      expect(msg).not.toContain('sk-ant-oat01-SECRET');
      expect(msg).not.toContain('rt-SECRET');
    }
  });

  it('an empty runtime set is a no-op — nothing to copy, nothing forbidden', () => {
    expect(buildCredentialScript([], [])).toBe('');
  });

  it('does NOT refuse a native runtime that is not signed in locally (nothing to copy)', () => {
    const notSignedIn: DetectedRuntime[] = [
      { id: 'claude', label: 'Claude Code', email: null, signedIn: false, credPath: null },
    ];
    expect(refusedNativeOAuthRuntimes(['claude'], notSignedIn)).toEqual([]);
    expect(() => assertNoNativeOAuthTransfer(['claude'], notSignedIn)).not.toThrow();
    expect(buildCredentialScript(['claude'], notSignedIn)).toBe('');
  });

  it('assertNoNativeOAuthTransfer / refusedNativeOAuthRuntimes flag a signed-in native runtime', () => {
    const signedIn: DetectedRuntime[] = [detected('claude'), detected('codex')];
    expect(refusedNativeOAuthRuntimes(['claude', 'codex'], signedIn).sort()).toEqual(['claude', 'codex']);
    expect(() => assertNoNativeOAuthTransfer(['claude'], signedIn)).toThrow(/Refusing to copy native OAuth/i);
    expect(refusedNativeOAuthRuntimes(['claude'], [{ id: 'claude', label: 'c', email: null, signedIn: true, credPath: null }], { claudeCredentialsJson: OAUTH_BLOB })).toEqual(['claude']);
  });
});

describe('profileNeedsBaseRuntimeCredentials', () => {
  it('does not require Claude OAuth when a profile carries its own Anthropic-compatible token', () => {
    expect(profileNeedsBaseRuntimeCredentials('claude', {
      ANTHROPIC_BASE_URL: 'https://openrouter.ai/api',
      ANTHROPIC_AUTH_TOKEN: 'sk-or-profile',
      ANTHROPIC_MODEL: 'moonshotai/kimi-k2.5',
    })).toBe(false);
  });

  it('does not require Claude OAuth for the foundry preset auth env', () => {
    const preset = getPreset('foundry')!;
    const profile = profileFromPreset('foundry-work', preset);
    const env = {
      ...profile.env,
      [profile.auth!.envVar]: 'foundry-profile-token',
    };

    expect(profile.host.agent).toBe('claude');
    expect(profile.auth!.envVar).toBe('ANTHROPIC_FOUNDRY_API_KEY');
    expect(profileNeedsBaseRuntimeCredentials(profile.host.agent, env, profile.auth!.envVar)).toBe(false);
  });

  it('requires base runtime credentials when the profile only changes endpoint/model', () => {
    expect(profileNeedsBaseRuntimeCredentials('claude', {
      ANTHROPIC_BASE_URL: 'https://proxy.example.test',
      ANTHROPIC_MODEL: 'claude-sonnet-4-5',
    })).toBe(true);
  });

  it('recognizes host-specific API keys for non-Claude profile hosts', () => {
    expect(profileNeedsBaseRuntimeCredentials('codex', { OPENAI_API_KEY: 'sk-profile' })).toBe(false);
    expect(profileNeedsBaseRuntimeCredentials('grok', { XAI_API_KEY: 'xai-profile' })).toBe(false);
  });

  it('does not require base credentials for profile hosts with no lease credential to copy', () => {
    expect(profileNeedsBaseRuntimeCredentials('opencode', { OPENCODE_API_KEY: 'sk-profile' })).toBe(false);
    expect(profileNeedsBaseRuntimeCredentials('antigravity', { ANTIGRAVITY_API_KEY: 'ag-profile' })).toBe(false);
  });
});
