import { describe, it, expect } from 'vitest';
import { classifyConnectionOutput } from './harness-connection-test.js';

describe('classifyConnectionOutput — exit code + stderr → classified outcome', () => {
  it('treats exit 0 as a pass regardless of output', () => {
    const r = classifyConnectionOutput(0, 'alive');
    expect(r.ok).toBe(true);
    expect(r.reason).toBeUndefined();
  });

  it('classifies a 401 / invalid key as an auth failure', () => {
    for (const out of [
      'API error (401): {"error":{"message":"invalid x-api-key"}}',
      'Error: Unauthorized',
      'authentication_error: invalid API key',
      'missing api key for provider',
    ]) {
      const r = classifyConnectionOutput(1, out);
      expect(r.ok).toBe(false);
      expect(r.reason).toBe('auth');
    }
  });

  it('classifies a model-not-served error as a model failure', () => {
    for (const out of [
      'Error: model `gpt-x` not found',
      'The model deepseek/deepseek-v9 does not exist',
      'unknown model: foo-bar',
      'invalid model specified',
    ]) {
      const r = classifyConnectionOutput(1, out);
      expect(r.ok).toBe(false);
      expect(r.reason).toBe('model');
    }
  });

  it('classifies a DNS/connection failure as an endpoint failure', () => {
    for (const out of [
      'FetchError: request to https://gw.corp/v1 failed, reason: getaddrinfo ENOTFOUND gw.corp',
      'connect ECONNREFUSED 127.0.0.1:8080',
      'Error: connection refused',
      'fetch failed',
    ]) {
      const r = classifyConnectionOutput(1, out);
      expect(r.ok).toBe(false);
      expect(r.reason).toBe('endpoint');
    }
  });

  it('falls back to unknown when a failure matches no known shape', () => {
    const r = classifyConnectionOutput(2, 'something went sideways in an unfamiliar way');
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('unknown');
    expect(r.message).toContain('exit 2');
  });

  it('carries the first non-empty output line into the message for context', () => {
    const r = classifyConnectionOutput(1, '\n  Error: Unauthorized (401)\n  at foo\n');
    expect(r.message).toContain('Unauthorized');
  });
});
