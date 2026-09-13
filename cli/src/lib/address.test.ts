import { describe, expect, it } from 'vitest';
import {
  ADDRESS_SCHEMES,
  DEFAULT_PORTS,
  addressPort,
  browserEndpointPort,
  parseAddress,
  sshPortArgs,
  sshTarget,
  tcpEndpoint,
  vncEndpoint,
} from './address.js';

// Shared vectors (PHNX-4090). This file is identical in agents-cli, computer-cli,
// browser-cli and secrets-cli apart from the test-runner import; a vector added
// here is added to all four.

describe('parseAddress', () => {
  it('parses ssh://user@host and never invents a DevTools port', () => {
    const addr = parseAddress('ssh://muqsit@linux-desk');
    expect(addr.scheme).toBe('ssh');
    expect(addr.user).toBe('muqsit');
    expect(addr.host).toBe('linux-desk');
    expect(addr.port).toBeUndefined();
    expect(addressPort(addr)).toBe(22);
    expect(sshTarget(addr)).toBe('muqsit@linux-desk');
    expect(sshPortArgs(addr)).toEqual([]);
  });

  it('treats the ssh authority port as the SSH port, not 9222', () => {
    const addr = parseAddress('ssh://muqsit@linux-desk:2222');
    expect(addr.port).toBe(2222);
    expect(addressPort(addr)).toBe(2222);
    expect(sshPortArgs(addr)).toEqual(['-o', 'Port=2222']);
    expect(browserEndpointPort(addr)).toBe(9222);
  });

  it('treats a bare user@host as implicit ssh://', () => {
    const addr = parseAddress('Administrator@win-mini');
    expect(addr.scheme).toBe('ssh');
    expect(addr.user).toBe('Administrator');
    expect(addr.host).toBe('win-mini');
    expect(sshTarget(addr)).toBe('Administrator@win-mini');
  });

  it('treats a bare alias as implicit ssh://', () => {
    const addr = parseAddress('win-mini');
    expect(addr.scheme).toBe('ssh');
    expect(addr.host).toBe('win-mini');
    expect(addr.user).toBeUndefined();
    expect(sshTarget(addr)).toBe('win-mini');
  });

  it('parses cdp://host:port', () => {
    const addr = parseAddress('cdp://127.0.0.1:9333');
    expect(addr.scheme).toBe('cdp');
    expect(addr.host).toBe('127.0.0.1');
    expect(addr.port).toBe(9333);
    expect(browserEndpointPort(addr)).toBe(9333);
  });

  it('defaults cdp to 9222 only through the port helpers', () => {
    const addr = parseAddress('cdp://127.0.0.1');
    expect(addr.port).toBeUndefined();
    expect(addressPort(addr)).toBe(9222);
    expect(browserEndpointPort(addr)).toBe(9222);
  });

  it('defaults vnc to 5901', () => {
    const addr = parseAddress('vnc://linux-desk');
    expect(addr.port).toBeUndefined();
    expect(addressPort(addr)).toBe(5901);
    expect(vncEndpoint(addr)).toBe('linux-desk:5901');
  });

  it('keeps an explicit vnc port', () => {
    expect(vncEndpoint(parseAddress('vnc://10.0.0.5:5900'))).toBe('10.0.0.5:5900');
  });

  it('requires a tcp port', () => {
    expect(tcpEndpoint(parseAddress('tcp://127.0.0.1:17600'))).toBe('127.0.0.1:17600');
    expect(addressPort(parseAddress('tcp://127.0.0.1'))).toBeUndefined();
    expect(() => tcpEndpoint(parseAddress('tcp://127.0.0.1'))).toThrow(/requires a port/);
  });

  it('keeps a wss path and has no port default for it', () => {
    const addr = parseAddress('wss://hub.example/devtools');
    expect(addr.scheme).toBe('wss');
    expect(addr.host).toBe('hub.example');
    expect(addr.path).toBe('/devtools');
    expect(addressPort(addr)).toBeUndefined();
    expect(browserEndpointPort(addr)).toBeUndefined();
  });

  it('preserves ?port= and ?os= on an ssh browser endpoint', () => {
    const addr = parseAddress('ssh://muqsit@win-mini?port=9333&os=windows');
    expect(addr.port).toBeUndefined();
    expect(addr.query).toEqual({ port: '9333', os: 'windows' });
    expect(browserEndpointPort(addr)).toBe(9333);
    expect(sshTarget(addr)).toBe('muqsit@win-mini');
  });

  it('parses firefox-bidi://', () => {
    const addr = parseAddress('firefox-bidi://127.0.0.1:9222');
    expect(addr.scheme).toBe('firefox-bidi');
    expect(addr.port).toBe(9222);
  });

  it('rejects passwords in URIs', () => {
    expect(() => parseAddress('ssh://muqsit:secret@linux-desk')).toThrow(/passwords are not allowed/);
    expect(() => parseAddress('vnc://:secret@linux-desk')).toThrow(/passwords are not allowed/);
  });

  it('rejects an unknown scheme', () => {
    expect(() => parseAddress('ftp://box')).toThrow(/unsupported address scheme "ftp"/);
    expect(() => parseAddress('http://box')).toThrow(/unsupported address scheme "http"/);
  });

  it('rejects an empty address or a missing host', () => {
    expect(() => parseAddress('')).toThrow(/empty address/);
    expect(() => parseAddress('   ')).toThrow(/empty address/);
    expect(() => parseAddress('ssh://')).toThrow(/missing host/);
    expect(() => parseAddress('vnc://:5901')).toThrow(/Invalid address/);
  });

  it('rejects an injection-shaped user or host', () => {
    expect(() => parseAddress('-oProxyCommand=curl')).toThrow(/Invalid address/);
    expect(() => parseAddress('a@b;rm')).toThrow(/Invalid address/);
    expect(() => parseAddress('ssh://-evil@box')).toThrow(/cannot start with -/);
    expect(() => parseAddress('host:2222')).toThrow(/Invalid address/);
  });

  it('rejects a bad port', () => {
    expect(() => parseAddress('ssh://box:99999')).toThrow(/Invalid address/);
    expect(() => browserEndpointPort(parseAddress('ssh://box?port=abc'))).toThrow(/bad \?port/);
  });

  it('refuses to treat a non-ssh address as an ssh target', () => {
    expect(() => sshTarget(parseAddress('vnc://desk'))).toThrow(/expected ssh:\/\//);
    expect(() => sshPortArgs(parseAddress('cdp://127.0.0.1:9222'))).toThrow(/expected ssh:\/\//);
    expect(() => vncEndpoint(parseAddress('ssh://desk'))).toThrow(/expected vnc:\/\//);
    expect(() => tcpEndpoint(parseAddress('vnc://desk'))).toThrow(/expected tcp:\/\//);
  });

  it('pins the scheme list and the default ports', () => {
    expect([...ADDRESS_SCHEMES]).toEqual(['ssh', 'cdp', 'vnc', 'tcp', 'wss', 'ws', 'firefox-bidi']);
    expect(DEFAULT_PORTS).toEqual({ ssh: 22, cdp: 9222, vnc: 5901 });
  });
});
