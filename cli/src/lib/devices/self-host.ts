import { machineId } from '../machine-id.js';
import { loadDevicesSync } from './registry.js';

const LOOPBACK = ['localhost', '127.0.0.1', '::1'];

function normalize(name: string): string {
  return name.trim().toLowerCase().replace(/\.$/, '');
}

let cached: Set<string> | null = null;

function selfAliases(): Set<string> {
  if (cached) return cached;
  const aliases = new Set<string>([machineId(), ...LOOPBACK]);

  try {
    const dns = loadDevicesSync()[machineId()]?.address?.dnsName;
    if (dns) {
      const d = normalize(dns);
      aliases.add(d);
      aliases.add(d.split('.')[0]);
    }
  } catch {
  }
  cached = aliases;
  return cached;
}

export function isSelfHost(name: string | undefined | null): boolean {
  if (!name) return false;
  const n = normalize(name);
  return n.length > 0 && selfAliases().has(n);
}

export function resetSelfHostCache(): void {
  cached = null;
}
