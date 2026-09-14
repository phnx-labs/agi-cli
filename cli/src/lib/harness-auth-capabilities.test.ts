import { describe, expect, it } from 'vitest';
import { ALL_AGENT_IDS } from './agents.js';
import {
  HARNESS_AUTH,
  LOGIN_INVOCATIONS,
  harnessAuth,
  harnessWorkerIsPerDevice,
  harnessWorkerKinds,
} from './harness-auth-capabilities.js';

describe('HARNESS_AUTH', () => {
  it('classifies every harness exactly once', () => {
    expect(Object.keys(HARNESS_AUTH).sort()).toEqual([...ALL_AGENT_IDS].sort());
  });

  it('matches the evidence table for the wired login/status/worker rows', () => {
    expect(HARNESS_AUTH.claude).toEqual({
      login: ['auth', 'login'],
      status: ['auth', 'status'],
      identity: 'strong',
      worker: 'setup-token',
      slotEnv: 'CLAUDE_CONFIG_DIR',
    });
    expect(HARNESS_AUTH.codex).toEqual({
      login: ['login'],
      status: ['login', 'status'],
      identity: 'strong',
      worker: ['api-key:OPENAI_API_KEY', 'per-device:device-auth'],
      slotEnv: 'CODEX_HOME',
    });
    expect(HARNESS_AUTH.grok).toEqual({
      login: ['login', '--device-auth'],
      status: null,
      identity: 'strong',
      worker: 'api-key:XAI_API_KEY',
      slotEnv: 'GROK_HOME',
    });
    expect(HARNESS_AUTH.kimi).toMatchObject({ login: null, worker: 'none', identity: 'opaque' });
    expect(HARNESS_AUTH.opencode.identity).toBe('opaque');
    expect(HARNESS_AUTH.muse.slotEnv).toBe('XDG_CONFIG_HOME');
    expect(HARNESS_AUTH.antigravity.worker).toBe('none');
    expect(HARNESS_AUTH.droid.worker).toBe('api-key:FACTORY_API_KEY');
    expect(harnessWorkerKinds('codex')).toEqual(['api-key:OPENAI_API_KEY', 'per-device:device-auth']);
    expect(harnessWorkerIsPerDevice('kimi')).toBe(true);
    expect(harnessWorkerIsPerDevice('antigravity')).toBe(true);
    expect(harnessWorkerIsPerDevice('claude')).toBe(false);
    expect(harnessWorkerIsPerDevice('codex')).toBe(false);
  });

  it('keeps LOGIN_INVOCATIONS as the connect subset with the same login argv', () => {
    expect(Object.keys(LOGIN_INVOCATIONS).sort()).toEqual(['claude', 'codex']);
    expect(LOGIN_INVOCATIONS.claude?.args).toEqual(HARNESS_AUTH.claude.login);
    expect(LOGIN_INVOCATIONS.codex?.args).toEqual(HARNESS_AUTH.codex.login);
    expect(LOGIN_INVOCATIONS.claude?.emailFlag).toBe('--email');
  });

  it('fails loud for a missing id only if the table were incomplete (type-complete)', () => {
    expect(harnessAuth('claude').slotEnv).toBe('CLAUDE_CONFIG_DIR');
    expect(HARNESS_AUTH.cursor.slotEnv).toBeNull();
    expect(HARNESS_AUTH.copilot.slotEnv).toBe('COPILOT_HOME');
  });
});
