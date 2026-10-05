import { describe, expect, it } from 'vitest';
import { classifyPollFailure, matchFailureText } from './failure.js';

describe('classifyPollFailure (PHNX-3510)', () => {
  it('flags a non-zero exit as a failure', () => {
    expect(classifyPollFailure({ exitCode: 1, text: '' })).toBe('command exited 1');
    expect(classifyPollFailure({ exitCode: 127, text: 'not found' })).toBe('command exited 127');
  });

  it('flags the gh GraphQL rate-limit text even on exit 0 (the `gh … | jq` case)', () => {
    const text = 'GraphQL: API rate limit already exceeded for user ID 13007401.';
    expect(classifyPollFailure({ exitCode: 0, text })).not.toBeNull();
    expect(matchFailureText(text)).toBe('API rate limit exceeded');
  });

  it('combines the text reason with the exit code when both are present', () => {
    const text = 'GraphQL: API rate limit already exceeded for user ID 13007401.';
    expect(classifyPollFailure({ exitCode: 1, text })).toBe('API rate limit exceeded (exit 1)');
  });

  it('flags common transport/auth shapes', () => {
    for (const text of [
      'HTTP 403 Forbidden',
      'Bad credentials',
      'could not resolve host: api.github.com',
      'connection refused',
      'network is unreachable',
    ]) {
      expect(classifyPollFailure({ exitCode: 0, text }), text).not.toBeNull();
    }
  });

  it('does NOT flag a clean value, even one that merely mentions timeout-like words', () => {
    for (const text of ['OPEN', 'MERGED', '42', 'deploy finished in 3s', 'timeout: 30', '']) {
      expect(classifyPollFailure({ exitCode: 0, text }), text).toBeNull();
    }
  });
});
