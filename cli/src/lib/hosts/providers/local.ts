/** Local host provider: `list()` unions ssh-config `Host` stanzas (read-only) with inline
 * entries plus the caps/os overlay; ssh config is never rewritten. PHNX-3315: registrations are
 * device-scoped (`Meta.deviceHosts`); reads union every device doc plus legacy central entries. */

import { readMeta, updateMeta } from '../../state.js';
import { unionDeviceHosts } from '../../devices/device-docs.js';
import type { HostEntry } from '../../types.js';
import type { Host, HostProvider, HostProviderCapabilities } from '../types.js';
import { listSshConfigHosts, isSshConfigHost } from '../ssh-config.js';

function entries(): Record<string, HostEntry> {
  // Reads union legacy central registrations with every device-owned document.
  return { ...readMeta().hosts, ...unionDeviceHosts() };
}

function ownEntries(meta = readMeta()): Record<string, HostEntry> {
  // Mutations are confined to this device's document; never rewrite a peer's registration.
  return meta.deviceHosts ?? {};
}

function toHost(name: string, entry: HostEntry, enrolled: boolean): Host {
  return {
    name,
    provider: 'local',
    enrolled,
    source: entry.source,
    address: entry.address,
    user: entry.user,
    os: entry.os,
    caps: entry.caps,
    addedAt: entry.addedAt,
  };
}

export class LocalHostProvider implements HostProvider {
  readonly id = 'local' as const;

  capabilities(): HostProviderCapabilities {
    return { directory: true, mutate: true, presence: false, relay: false, lease: false };
  }

  async list(): Promise<Host[]> {
    const overlay = entries();
    const out: Host[] = [];
    const seen = new Set<string>();

    for (const [name, entry] of Object.entries(overlay)) {
      out.push(toHost(name, entry, true));
      seen.add(name);
    }
    for (const name of listSshConfigHosts()) {
      if (seen.has(name)) continue;
      out.push(toHost(name, { source: 'ssh-config' }, false));
      seen.add(name);
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
  }

  async resolve(name: string): Promise<Host | null> {
    const entry = entries()[name];
    if (entry) return toHost(name, entry, true);
    if (isSshConfigHost(name)) return toHost(name, { source: 'ssh-config' }, false);
    return null;
  }

  async register(spec: Host): Promise<Host> {
    const entry: HostEntry = {
      source: spec.source,
      ...(spec.source === 'inline' ? { address: spec.address, user: spec.user } : {}),
      ...(spec.os ? { os: spec.os } : {}),
      ...(spec.caps && spec.caps.length ? { caps: spec.caps } : {}),
      addedAt: spec.addedAt ?? new Date().toISOString(),
    };
    updateMeta((meta) => ({ ...meta, deviceHosts: { ...ownEntries(meta), [spec.name]: entry } }));
    return toHost(spec.name, entry, true);
  }

  async remove(name: string): Promise<void> {
    updateMeta((meta) => {
      const hosts = { ...ownEntries(meta) };
      delete hosts[name];
      return { ...meta, deviceHosts: hosts };
    });
  }
}
