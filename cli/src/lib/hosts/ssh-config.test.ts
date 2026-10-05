import { describe, it, expect } from 'vitest';
import { parseSshConfigHosts, parseKnownHosts, sshResolve } from './ssh-config.js';

describe('parseSshConfigHosts', () => {
  it('extracts concrete Host names and skips wildcard/negated patterns', () => {
    const cfg = [
      '# my ssh config',
      'Host yosemite-s0 yosemite-s1',
      '  HostName 100.84.0.1',
      '  User muqsit',
      '',
      'Host mac-mini',
      '  HostName mac-mini.local',
      '',
      'Host *',
      '  ServerAliveInterval 60',
      '',
      'Host *.internal !secret',
      '  User root',
    ].join('\n');
    expect(parseSshConfigHosts(cfg)).toEqual(['yosemite-s0', 'yosemite-s1', 'mac-mini']);
  });

  it('dedupes repeated names and ignores comments/blank lines', () => {
    const cfg = 'Host a\nHost a\n\n#Host b\nHost c';
    expect(parseSshConfigHosts(cfg)).toEqual(['a', 'c']);
  });
});

describe('parseKnownHosts', () => {
  it('extracts hostnames, skips hashed entries, strips [host]:port and comma lists', () => {
    const kh = [
      '|1|abc123hashed=|def= ssh-ed25519 AAAA',
      'yosemite-s1 ssh-ed25519 AAAA',
      '[mac-mini.local]:2222 ssh-rsa BBBB',
      'gh.example.com,140.82.1.2 ssh-ed25519 CCCC',
      '',
      '# comment',
    ].join('\n');
    expect(parseKnownHosts(kh)).toEqual(['yosemite-s1', 'mac-mini.local', 'gh.example.com', '140.82.1.2']);
  });
});

describe('sshResolve target-injection guard', () => {
  it('refuses a dash-led name instead of passing it to `ssh -G` as a flag', () => {
    expect(sshResolve('-oProxyCommand=evil')).toBeUndefined();
    expect(sshResolve('a;rm -rf /')).toBeUndefined();
  });
});
