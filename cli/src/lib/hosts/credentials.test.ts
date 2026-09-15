/**
 * `--copy-creds` MUST NOT copy a native OAuth / session login to another device
 * (docs/specifications.md SING-1b). These tests prove the transfer path is gone:
 * for any signed-in native runtime the builder REFUSES loudly (steering to the
 * portable `agents accounts sync` path) and never serializes the credential —
 * the OAuth blob and the runtime auth files never appear in any produced script.
 */
import { describe, it, expect } from 'vitest';
import {
  buildHostCredentialScript,
  wrapHostCommandWithCredentials,
  isNativeOAuthRuntime,
} from './credentials.js';
import { LEASE_RUNTIMES, type DetectedRuntime } from '../crabbox/runtimes.js';
import type { AgentId } from '../types.js';

/** A signed-in native runtime, with a plausible on-disk credential path. */
function detected(id: AgentId): DetectedRuntime {
  return { id, label: id, email: `${id}@example.com`, signedIn: true, credPath: `/tmp/${id}-cred.json` };
}

// The exact OAuth blob a --copy-creds run used to ship; it must never surface.
const OAUTH_BLOB = '{"claudeAiOauth":{"accessToken":"sk-ant-oat01-SECRET","refreshToken":"rt-SECRET"}}';

describe('buildHostCredentialScript — native OAuth transfer is refused (SING-1b)', () => {
  it('every runtime --copy-creds handles is classified native OAuth', () => {
    // The refusal is only complete if the classifier covers the whole set the
    // path ever transferred — else a runtime could slip through unguarded.
    for (const cred of LEASE_RUNTIMES) {
      expect(isNativeOAuthRuntime(cred.id)).toBe(true);
    }
    expect(LEASE_RUNTIMES.map((c) => c.id).sort()).toEqual(['claude', 'codex', 'grok']);
  });

  it('throws for a native runtime instead of serializing its login, and steers to accounts sync', () => {
    expect(() =>
      buildHostCredentialScript({
        runtimes: ['claude'],
        detected: [detected('claude')],
        claudeCredentialsJson: OAUTH_BLOB,
      }),
    ).toThrow(/Refusing to copy native OAuth/i);

    // The steer names the portable, non-rotating path.
    try {
      buildHostCredentialScript({ runtimes: ['claude'], detected: [detected('claude')], claudeCredentialsJson: OAUTH_BLOB });
      throw new Error('expected a refusal');
    } catch (e) {
      const msg = (e as Error).message;
      expect(msg).toContain('agents accounts sync');
      expect(msg).toContain('SING-1b');
      // Proof the credential is never echoed, even into the refusal itself.
      expect(msg).not.toContain('sk-ant-oat01-SECRET');
      expect(msg).not.toContain('rt-SECRET');
    }
  });

  it('refuses codex / grok native auth files too', () => {
    for (const id of ['codex', 'grok'] as AgentId[]) {
      expect(() => buildHostCredentialScript({ runtimes: [id], detected: [detected(id)] })).toThrow(
        /Refusing to copy native OAuth/i,
      );
    }
  });

  it('refuses a mixed set and names every forbidden runtime', () => {
    try {
      buildHostCredentialScript({
        runtimes: ['claude', 'codex'],
        detected: [detected('claude'), detected('codex')],
        claudeCredentialsJson: OAUTH_BLOB,
      });
      throw new Error('expected a refusal');
    } catch (e) {
      const msg = (e as Error).message;
      expect(msg).toContain('claude');
      expect(msg).toContain('codex');
    }
  });

  it('an empty runtime set is a no-op — nothing to provision, nothing forbidden', () => {
    expect(buildHostCredentialScript({ runtimes: [], detected: [] })).toEqual({ setup: '', teardown: '' });
  });
});

describe('wrapHostCommandWithCredentials — the native OAuth never reaches the wire', () => {
  it('fails loud before producing any remote script containing the credential', () => {
    let produced: string | null = null;
    try {
      produced = wrapHostCommandWithCredentials('agents run claude "hi" --quiet', {
        runtimes: ['claude'],
        detected: [detected('claude')],
        claudeCredentialsJson: OAUTH_BLOB,
      });
    } catch (e) {
      expect((e as Error).message).toMatch(/Refusing to copy native OAuth/i);
    }
    // No script was ever built, so the OAuth blob and the credential-file writes
    // it used to emit can never have been serialized or sent.
    expect(produced).toBeNull();
  });

  it('wraps a no-credential run normally (no runtimes → no refusal)', () => {
    const wrapped = wrapHostCommandWithCredentials('echo hi', { runtimes: [], detected: [] });
    expect(wrapped).toContain('set -uo pipefail');
    expect(wrapped).toContain('echo hi');
    expect(wrapped).toContain('exit $rc');
    // No credential file write and no OAuth blob anywhere.
    expect(wrapped).not.toContain('.credentials.json');
    expect(wrapped).not.toContain('claudeAiOauth');
  });
});
