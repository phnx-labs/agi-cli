import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { assertNoNativeOAuthTransfer, buildCredentialScript, isNativeOAuthRuntime, LEASE_RUNTIMES, pickRuntimes, refusedNativeOAuthRuntimes, resolveClaudeCredentialsBlob, inferLeaseRuntime, profileNeedsBaseRuntimeCredentials, type DetectedRuntime } from './runtimes.js';
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
    // `run codex --lease` while only claude is signed in must NOT provision claude.
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
  // The exact OAuth blob --lease used to write onto the box; it must never surface.
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
    // credPath points nowhere; the refusal must precede the fs read, so the box's
    // token never enters a --script-stdin body.
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
    // credPath null and no claude blob → nothing would transfer → no refusal, so a
    // --lease of a not-signed-in runtime still bootstraps. This is why the fail-fast
    // guard keys on refusedNativeOAuthRuntimes, not on the runtime id alone.
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
    // A Claude OAuth blob alone (no credPath) is also enough to refuse.
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

describe('resolveClaudeCredentialsBlob', () => {
  const WRAPPED = '{"claudeAiOauth":{"accessToken":"tok"}}';
  // Only the darwin branch is unit-tested (the Linux branch reads a real file).
  const itDarwin = process.platform === 'darwin' ? it : it.skip;

  itDarwin('returns the bare-service payload for a default native install', async () => {
    const blob = await resolveClaudeCredentialsBlob({
      service: (home) => (home ? `svc-${home}` : 'bare'),
      readItem: (svc) => (svc === 'bare' ? WRAPPED : (() => { throw new Error('miss'); })()),
      listVersions: () => ['2.1.0'],
      versionHome: (v) => `/home/${v}`,
      accountEmail: async () => null,
    });
    expect(blob).toBe(WRAPPED);
  });

  itDarwin('falls back to a managed version home when the bare service misses', async () => {
    const blob = await resolveClaudeCredentialsBlob({
      service: (home) => (home ? `svc:${home}` : 'bare'),
      readItem: (svc) => (svc === 'svc:/home/2.1.0' ? WRAPPED : (() => { throw new Error('miss'); })()),
      listVersions: () => ['2.1.0'],
      versionHome: (v) => `/home/${v}`,
      accountEmail: async () => null,
    });
    expect(blob).toBe(WRAPPED);
  });

  itDarwin('prefers the version whose account email matches preferEmail', async () => {
    const reads: string[] = [];
    const blob = await resolveClaudeCredentialsBlob({
      preferEmail: 'want@x.com',
      service: (home) => (home ? `svc:${home}` : 'bare'),
      readItem: (svc) => {
        reads.push(svc);
        if (svc === 'bare') throw new Error('miss');
        // Both managed homes have a token; the matching one must be read first.
        return WRAPPED;
      },
      listVersions: () => ['other', 'match'],
      versionHome: (v) => `/home/${v}`,
      accountEmail: async (home) => (home === '/home/match' ? 'want@x.com' : 'no@x.com'),
    });
    expect(blob).toBe(WRAPPED);
    // After the bare miss, the matching home is tried before the non-matching one.
    expect(reads.filter((r) => r !== 'bare')[0]).toBe('svc:/home/match');
  });

  itDarwin('returns the bare-service blob when preferEmail matches the bare service account', async () => {
    const blob = await resolveClaudeCredentialsBlob({
      preferEmail: 'want@b.com',
      service: (home) => (home ? `svc:${home}` : 'bare'),
      readItem: (svc) => (svc === 'bare' ? WRAPPED : (() => { throw new Error('miss'); })()),
      listVersions: () => [],
      versionHome: (v) => v,
      accountEmail: async (_home) => 'want@b.com',
    });
    expect(blob).toBe(WRAPPED);
  });

  itDarwin('falls through bare service and returns null when preferEmail does not match', async () => {
    const blob = await resolveClaudeCredentialsBlob({
      preferEmail: 'want@b.com',
      service: (home) => (home ? `svc:${home}` : 'bare'),
      readItem: (svc) => (svc === 'bare' ? WRAPPED : (() => { throw new Error('miss'); })()),
      listVersions: () => [],
      versionHome: (v) => v,
      accountEmail: async (_home) => 'other@b.com',
    });
    expect(blob).toBeNull();
  });

  itDarwin('rejects a payload without a claudeAiOauth.accessToken', async () => {
    const blob = await resolveClaudeCredentialsBlob({
      service: () => 'bare',
      readItem: () => '{"claudeAiOauth":{"refreshToken":"r"}}',
      listVersions: () => [],
      versionHome: (v) => v,
    });
    expect(blob).toBeNull();
  });

  itDarwin('returns null when every read misses', async () => {
    const blob = await resolveClaudeCredentialsBlob({
      service: (home) => (home ? `svc:${home}` : 'bare'),
      readItem: () => { throw new Error('miss'); },
      listVersions: () => ['2.1.0'],
      versionHome: (v) => `/home/${v}`,
      accountEmail: async () => null,
    });
    expect(blob).toBeNull();
  });

  describe('off-darwin .credentials.json (RUSH-2359 / SING-1b split)', () => {
    const itOffDarwin = process.platform === 'darwin' ? it.skip : it;
    let linuxHome: string;
    let prevRealHome: string | undefined;
    beforeEach(() => {
      linuxHome = fs.mkdtempSync(path.join(os.tmpdir(), 'lease-creds-'));
      prevRealHome = process.env.AGENTS_REAL_HOME;
      process.env.AGENTS_REAL_HOME = linuxHome;
      fs.mkdirSync(path.join(linuxHome, '.claude'), { recursive: true });
    });
    afterEach(() => {
      if (prevRealHome === undefined) delete process.env.AGENTS_REAL_HOME;
      else process.env.AGENTS_REAL_HOME = prevRealHome;
      fs.rmSync(linuxHome, { recursive: true, force: true });
    });

    itOffDarwin('returns the wrapped rotating blob from .credentials.json', async () => {
      const wrapped = '{"claudeAiOauth":{"accessToken":"tok-live"}}';
      fs.writeFileSync(path.join(linuxHome, '.claude', '.credentials.json'), wrapped);
      expect(await resolveClaudeCredentialsBlob()).toBe(wrapped);
    });

    itOffDarwin('returns null for a setup-token-shaped payload — not a native OAuth blob', async () => {
      fs.writeFileSync(
        path.join(linuxHome, '.claude', '.credentials.json'),
        JSON.stringify({ accessToken: 'sk-ant-oat01-not-a-native-login' }),
      );
      expect(await resolveClaudeCredentialsBlob()).toBeNull();
    });

    itOffDarwin('returns null when .credentials.json is absent', async () => {
      expect(await resolveClaudeCredentialsBlob()).toBeNull();
    });
  });
});

describe('pickRuntimes', () => {
  const detected: DetectedRuntime[] = [
    { id: 'claude', label: 'Claude Code', email: 'a@b.com', signedIn: true, credPath: '/tmp/claude.json' },
    { id: 'codex', label: 'Codex CLI', email: null, signedIn: false, credPath: null },
  ];

  it('defaults the checkbox to signed-in runtimes that have a credential', async () => {
    let captured: any[] = [];
    await pickRuntimes(detected, async (choices) => {
      captured = choices;
      return choices.filter((c) => c.checked).map((c) => c.value);
    });
    const claude = captured.find((c) => c.value === 'claude');
    const codex = captured.find((c) => c.value === 'codex');
    expect(claude.checked).toBe(true);
    expect(codex.checked).toBe(false);
    // No local credential → disabled with an explanation.
    expect(typeof codex.disabled).toBe('string');
  });

  it('returns exactly the selected runtime ids', async () => {
    const picked = await pickRuntimes(detected, async () => ['claude']);
    expect(picked).toEqual(['claude']);
  });
});
