import { describe, expect, it } from 'vitest';
import { ALL_AGENT_IDS } from './agents.js';
import { NATIVE_ACCOUNT_CAPABILITIES, NATIVE_ACCOUNT_SELECTOR_AGENTS, NATIVE_ACCOUNT_SELECTOR_EXCLUSIONS, nativeAccountNameable, nativeAccountNamingRefusal, nativeIdentityKey, supportedNativeHarnesses } from './account-capabilities.js';
import { CONFIG_ENV_ISOLATED_AGENTS } from './installations/shims.js';

describe('native account capability registry', () => {
  it('classifies every harness exactly once', () => {
    expect(Object.keys(NATIVE_ACCOUNT_CAPABILITIES).sort()).toEqual([...ALL_AGENT_IDS].sort());
  });

  it('never claims name/attach support without an inspectable identity', () => {
    for (const capability of Object.values(NATIVE_ACCOUNT_CAPABILITIES)) {
      if (capability.status === 'supported' || capability.status === 'conditional') {
        expect(capability.inspection).not.toBe('none');
        expect(capability.scope).not.toBe('unsupported');
      }
    }
  });

  it('pins the selector-capable set to the config-isolated native harnesses', () => {
    const versionStrong = ALL_AGENT_IDS.filter((id) => {
      const cap = NATIVE_ACCOUNT_CAPABILITIES[id];
      return cap.scope === 'version' && cap.status === 'supported';
    });
    expect(versionStrong.sort()).toEqual(['claude', 'codex', 'cursor', 'grok', 'kimi']);
    for (const id of versionStrong) expect(CONFIG_ENV_ISOLATED_AGENTS).toContain(id);
    expect([...NATIVE_ACCOUNT_SELECTOR_AGENTS].sort()).toEqual(versionStrong.sort());
    for (const id of CONFIG_ENV_ISOLATED_AGENTS) {
      expect(NATIVE_ACCOUNT_SELECTOR_AGENTS.includes(id as typeof NATIVE_ACCOUNT_SELECTOR_AGENTS[number]) || !!NATIVE_ACCOUNT_SELECTOR_EXCLUSIONS[id]).toBe(true);
    }
  });

  it('treats Muse as a conditional, email-only version harness', () => {
    expect(NATIVE_ACCOUNT_CAPABILITIES.muse).toEqual({ inspection: 'email', scope: 'version', status: 'conditional' });
  });

  it('records Cursor isolation and Kimi manual-label-only truthfully', () => {
    expect(NATIVE_ACCOUNT_CAPABILITIES.cursor).toEqual({ inspection: 'strong', scope: 'version', status: 'supported' });
    expect(NATIVE_ACCOUNT_CAPABILITIES.kimi).toEqual({ inspection: 'opaque', scope: 'version', status: 'supported' });
    expect(nativeAccountNameable('cursor')).toBe(true);
    expect(nativeAccountNameable('kimi')).toBe(true);
  });

  it('records Antigravity / Droid / OpenCode as device-scoped opaque but UNSUPPORTED', () => {
    // No device-id discriminator in NativeAccount → an opaque/singleton identity
    // cannot be proven unique across synced metadata, so naming is refused.
    for (const id of ['antigravity', 'droid', 'opencode'] as const) {
      expect(NATIVE_ACCOUNT_CAPABILITIES[id]).toEqual({ inspection: 'opaque', scope: 'device', status: 'unsupported' });
      expect(nativeAccountNameable(id)).toBe(false);
    }
  });

  it('only permits opaque naming when the harness has version-isolated config', () => {
    for (const [, cap] of Object.entries(NATIVE_ACCOUNT_CAPABILITIES)) {
      if (cap.inspection === 'opaque' && cap.status === 'supported') expect(cap.scope).toBe('version');
    }
  });

  it('exposes nameability for the supported + conditional set only', () => {
    expect(nativeAccountNameable('claude')).toBe(true);
    expect(nativeAccountNameable('muse')).toBe(true); // conditional
    expect(nativeAccountNameable('copilot')).toBe(false); // unsupported
  });

  it('names the supported native set', () => {
    expect(supportedNativeHarnesses()).toEqual(['claude', 'codex', 'cursor', 'grok', 'kimi']);
  });

  it('refuses native naming with a named reason for device-scoped logins', () => {
    const reason = nativeAccountNamingRefusal('antigravity');
    expect(reason).toContain("antigravity accounts can't be isolated by agents-cli yet (device-scoped login)");
    expect(reason).toContain('Supported today: claude, codex, cursor, grok, kimi');
    expect(nativeAccountNamingRefusal('claude')).toBeNull();
    expect(nativeAccountNamingRefusal('muse')).toBeNull();
  });

  it('stores Muse (email-inspection) as accountKey, never the bare email', () => {
    // getAccountInfo('muse') sets accountKey to muse:email=<addr>. If name
    // stored the bare email, run/view would compare liveKey !== identityKey
    // and reject a correctly signed-in install.
    const muse = NATIVE_ACCOUNT_CAPABILITIES.muse;
    expect(nativeIdentityKey(
      { signedIn: true, email: 'user@x.com', accountKey: 'muse:email=user@x.com' },
      muse,
    )).toBe('muse:email=user@x.com');
    expect(nativeIdentityKey({ signedIn: true, email: 'user@x.com', accountKey: null }, muse)).toBe('user@x.com');
    expect(nativeIdentityKey({ signedIn: true, email: null, accountKey: 'muse:email=x' }, muse)).toBeNull();
    expect(nativeIdentityKey({ signedIn: false, email: 'user@x.com', accountKey: 'muse:email=user@x.com' }, muse)).toBeNull();
  });

  it('stores a strong harness as accountKey', () => {
    expect(nativeIdentityKey(
      { signedIn: true, email: 'a@b.com', accountKey: 'claude:user=abc' },
      NATIVE_ACCOUNT_CAPABILITIES.claude,
    )).toBe('claude:user=abc');
  });
});
