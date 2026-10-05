import { describe, it, expect } from 'vitest';
import { parseAgentsUrl, isDeepLinkSessionId } from './url.js';

const UUID = '39a9f321-1c2d-4e5f-8a9b-0c1d2e3f4a5b';

describe('parseAgentsUrl', () => {
  it('parses agents://session/<uuid>', () => {
    expect(parseAgentsUrl(`agents://session/${UUID}`)).toEqual({ kind: 'session', id: UUID });
  });

  it('accepts a bare hex short id', () => {
    expect(parseAgentsUrl('agents://session/39a9f321')).toEqual({ kind: 'session', id: '39a9f321' });
  });

  it('accepts a session_-prefixed id and a ses_ ulid', () => {
    expect(parseAgentsUrl(`agents://session/session_${UUID}`)).toEqual({ kind: 'session', id: `session_${UUID}` });
    expect(parseAgentsUrl('agents://session/ses_01arz3ndektsv4rrffq69g5fav')).toMatchObject({ kind: 'session' });
  });

  it('accepts an ag- tmux alias', () => {
    expect(parseAgentsUrl('agents://session/ag-claude-1a2b3c4d')).toEqual({ kind: 'session', id: 'ag-claude-1a2b3c4d' });
  });

  it('carries a valid host hint and drops an invalid one', () => {
    expect(parseAgentsUrl(`agents://session/${UUID}?host=yosemite-s1`)).toEqual({ kind: 'session', id: UUID, host: 'yosemite-s1' });
    expect(parseAgentsUrl(`agents://session/${UUID}?host=a;b`)).toEqual({ kind: 'session', id: UUID });
  });

  it('rejects a non-agents scheme', () => {
    expect(parseAgentsUrl(`https://session/${UUID}`)).toHaveProperty('error');
    expect(parseAgentsUrl(`file:///${UUID}`)).toHaveProperty('error');
  });

  it('rejects an unknown verb', () => {
    expect(parseAgentsUrl(`agents://run/${UUID}`)).toHaveProperty('error');
  });

  it('rejects empty / malformed input', () => {
    expect(parseAgentsUrl('')).toHaveProperty('error');
    expect(parseAgentsUrl('   ')).toHaveProperty('error');
    expect(parseAgentsUrl('not a url')).toHaveProperty('error');
  });

  it('rejects an injection payload as the session id (never routes it)', () => {
    for (const bad of [
      'agents://session/$(touch /tmp/pwned)',
      'agents://session/;rm -rf ~',
      'agents://session/`id`',
      'agents://session/..%2F..%2Fetc',
      'agents://session/',
    ]) {
      expect(parseAgentsUrl(bad)).toHaveProperty('error');
    }
  });
});

describe('isDeepLinkSessionId', () => {
  it('accepts real id shapes and rejects phrases / metacharacters', () => {
    expect(isDeepLinkSessionId(UUID)).toBe(true);
    expect(isDeepLinkSessionId('39a9f321')).toBe(true);
    expect(isDeepLinkSessionId('ag-claude-1a2b3c4d')).toBe(true);
    expect(isDeepLinkSessionId('hello world')).toBe(false);
    expect(isDeepLinkSessionId('$(touch x)')).toBe(false);
    expect(isDeepLinkSessionId('abc')).toBe(false);
    expect(isDeepLinkSessionId('')).toBe(false);
  });
});
