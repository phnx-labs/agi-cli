/** `--copy-creds` must not copy a native OAuth/session login (SING-1b): the builder refuses and
 * never serializes it. */
import { describe, it, expect } from 'vitest';
import {
  buildHostCredentialScript,
  wrapHostCommandWithCredentials,
  isNativeOAuthRuntime,
} from './credentials.js';
import { LEASE_RUNTIMES, type DetectedRuntime } from '../crabbox/runtimes.js';
import type { AgentId } from '../types.js';

function detected(id: AgentId): DetectedRuntime {
  return { id, label: id, email: `${id}@example.com`, signedIn: true, credPath: `/tmp/${id}-cred.json` };
}

const OAUTH_BLOB = '{"claudeAiOauth":{"accessToken":"sk-ant-oat01-SECRET","refreshToken":"rt-SECRET"}}';

describe('buildHostCredentialScript — native OAuth transfer is refused (SING-1b)', () => {
  it('every runtime --copy-creds handles is classified native OAuth', () => {
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

    try {
      buildHostCredentialScript({ runtimes: ['claude'], detected: [detected('claude')], claudeCredentialsJson: OAUTH_BLOB });
      throw new Error('expected a refusal');
    } catch (e) {
      const msg = (e as Error).message;
      expect(msg).toContain('agents accounts sync');
      expect(msg).toContain('SING-1b');
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
    expect(produced).toBeNull();
  });

  it('wraps a no-credential run normally (no runtimes → no refusal)', () => {
    const wrapped = wrapHostCommandWithCredentials('echo hi', { runtimes: [], detected: [] });
    expect(wrapped).toContain('set -uo pipefail');
    expect(wrapped).toContain('echo hi');
    expect(wrapped).toContain('exit $rc');
    expect(wrapped).not.toContain('.credentials.json');
    expect(wrapped).not.toContain('claudeAiOauth');
  });
});
