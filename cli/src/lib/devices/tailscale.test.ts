import { describe, expect, it } from 'vitest';
import { parseTailscaleStatus, nodeToDeviceInput, slugifyHostName } from './tailscale.js';

const FIXTURE = JSON.stringify({
  Self: {
    HostName: 'yosemite-s1',
    DNSName: 'yosemite-s1.tail1a85a1.ts.net.',
    OS: 'linux',
    TailscaleIPs: ['100.93.177.123', 'fd7a:115c:a1e0::1'],
    Online: true,
    CurAddr: '192.168.1.80:41641',
    Relay: 'sfo',
  },
  Peer: {
    nodekey1: {
      HostName: 'win-mini',
      DNSName: 'win-mini.tail1a85a1.ts.net.',
      OS: 'windows',
      TailscaleIPs: ['100.68.123.39', 'fd7a:115c:a1e0::53a:7b28'],
      Online: true,
      CurAddr: '',
      Relay: 'sfo',
      LastSeen: '2026-06-30T20:00:00Z',
    },
    nodekey2: {
      OS: 'linux',
      Online: false,
    },
    nodekey3: { HostName: 'localhost', DNSName: 'ipad165.tail1a85a1.ts.net.', OS: 'iOS', Online: true, CurAddr: '1.2.3.4:1' },
    nodekey4: { HostName: 'localhost', DNSName: 'iphone182.tail1a85a1.ts.net.', OS: 'iOS', Online: true, CurAddr: '1.2.3.4:2' },
    nodekey5: { HostName: "Bisma's MacBook Pro", DNSName: 'bismas-macbook-pro.tail1a85a1.ts.net.', OS: 'macOS', Online: false },
    nodekey6: { HostName: 'funnel-ingress-node', DNSName: 'funnel-ingress-node.tail99.ts.net.', Online: true, ShareeNode: true },
  },
});

describe('parseTailscaleStatus', () => {
  it('maps OS to platform, includes Self, skips nameless nodes, and dedups iOS localhosts via DNS label', () => {
    const nodes = parseTailscaleStatus(FIXTURE);
    expect(nodes.map((n) => n.name).sort()).toEqual([
      'bismas-macbook-pro',
      'funnel-ingress-node',
      'ipad165',
      'iphone182',
      'win-mini',
      'yosemite-s1',
    ]);
    expect(nodes.find((n) => n.name === 'bismas-macbook-pro')!.platform).toBe('macos');

    const self = nodes.find((n) => n.name === 'yosemite-s1')!;
    expect(self.platform).toBe('linux');
    expect(self.dnsName).toBe('yosemite-s1.tail1a85a1.ts.net');
    expect(self.ip).toBe('100.93.177.123');
    expect(self.direct).toBe(true);

    const win = nodes.find((n) => n.name === 'win-mini')!;
    expect(win.platform).toBe('windows');
    expect(win.direct).toBe(false);
    expect(win.relay).toBe('sfo');
  });

  it('flags sharee nodes (shared into the tailnet by another user) and no one else', () => {
    const nodes = parseTailscaleStatus(FIXTURE);
    const shared = nodes.find((n) => n.name === 'funnel-ingress-node')!;
    expect(shared.sharee).toBe(true);
    for (const n of nodes.filter((x) => x.name !== 'funnel-ingress-node')) {
      expect(n.sharee).toBe(false);
    }
  });

  it('throws on malformed JSON', () => {
    expect(() => parseTailscaleStatus('{ not json')).toThrow(/Could not parse/);
  });

  it('slugifies hostnames into valid ssh aliases', () => {
    expect(slugifyHostName("Bisma's MacBook Pro")).toBe('bismas-macbook-pro');
    expect(slugifyHostName('WIN-MINI')).toBe('win-mini');
    expect(slugifyHostName('  edge_case! ')).toBe('edge_case');
  });

  it('projects a node into registry fields', () => {
    const [self] = parseTailscaleStatus(FIXTURE);
    const input = nodeToDeviceInput(self);
    expect(input.platform).toBe('linux');
    expect(input.address).toEqual({ via: 'tailscale', dnsName: 'yosemite-s1.tail1a85a1.ts.net', ip: '100.93.177.123' });
    expect(input.tailscale?.direct).toBe(true);
  });
});
