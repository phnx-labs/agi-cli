import { spawnSync } from 'child_process';
import {
  type DeviceInput,
  type DevicePlatform,
  platformFromOs,
} from './registry.js';

export interface TailscaleNode {
  name: string;
  platform: DevicePlatform;
  dnsName?: string;
  ip?: string;
  online: boolean;
  direct: boolean;
  relay?: string;
  lastSeen?: string;
  sharee: boolean;
}

interface RawTsNode {
  HostName?: string;
  DNSName?: string;
  OS?: string;
  TailscaleIPs?: string[];
  Online?: boolean;
  Relay?: string;
  CurAddr?: string;
  LastSeen?: string;
  ShareeNode?: boolean;
}

interface RawTsStatus {
  Self?: RawTsNode;
  Peer?: Record<string, RawTsNode>;
}

function trimDnsDot(dns: string | undefined): string | undefined {
  if (!dns) return undefined;
  return dns.endsWith('.') ? dns.slice(0, -1) : dns;
}

function firstIpv4(ips: string[] | undefined): string | undefined {
  if (!ips) return undefined;
  return ips.find((ip) => /^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) ?? ips[0];
}

export function slugifyHostName(hostName: string): string {
  return hostName
    .toLowerCase()
    .replace(/['’"]/g, '')
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function deviceNameFor(raw: RawTsNode, dnsName: string | undefined): string | null {
  const label = dnsName?.split('.')[0];
  if (label && label.length > 0) return label;
  const host = raw.HostName?.trim();
  if (!host) return null;
  const slug = slugifyHostName(host);
  return slug.length > 0 ? slug : null;
}

function toNode(raw: RawTsNode): TailscaleNode | null {
  const dnsName = trimDnsDot(raw.DNSName);
  const name = deviceNameFor(raw, dnsName);
  if (!name) return null;
  const direct = Boolean(raw.CurAddr && raw.CurAddr.length > 0);
  return {
    name,
    platform: platformFromOs(raw.OS),
    dnsName,
    ip: firstIpv4(raw.TailscaleIPs),
    online: Boolean(raw.Online),
    direct,
    relay: raw.Relay || undefined,
    lastSeen: raw.LastSeen,
    sharee: Boolean(raw.ShareeNode),
  };
}

export function parseTailscaleStatus(json: string): TailscaleNode[] {
  let parsed: RawTsStatus;
  try {
    parsed = JSON.parse(json) as RawTsStatus;
  } catch (err: any) {
    throw new Error(`Could not parse tailscale status JSON: ${err?.message ?? err}`);
  }
  const out: TailscaleNode[] = [];
  if (parsed.Self) {
    const self = toNode(parsed.Self);
    if (self) out.push(self);
  }
  for (const raw of Object.values(parsed.Peer ?? {})) {
    const node = toNode(raw);
    if (node) out.push(node);
  }
  return out;
}

export function nodeToDeviceInput(node: TailscaleNode): DeviceInput {
  return {
    platform: node.platform,
    address: { via: 'tailscale', dnsName: node.dnsName, ip: node.ip },
    tailscale: {
      online: node.online,
      direct: node.direct,
      relay: node.relay,
      lastSeen: node.lastSeen,
    },
  };
}

export function tailscaleStatusJson(): string {
  const res = spawnSync('tailscale', ['status', '--json'], { encoding: 'utf-8', windowsHide: true });
  if (res.error && (res.error as NodeJS.ErrnoException).code === 'ENOENT') {
    throw new Error('tailscale not found on PATH. Install Tailscale, or add devices manually with `agents devices add`.');
  }
  if (res.status !== 0) {
    throw new Error(`tailscale status failed: ${(res.stderr || res.stdout || '').trim() || `exit ${res.status}`}`);
  }
  return res.stdout ?? '';
}
