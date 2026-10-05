/** Local host provider: `list()` unions ssh-config `Host` stanzas (read-only) with inline
 * entries plus the caps/os overlay; ssh config is never rewritten. PHNX-3315: registrations are
 * device-scoped (`Meta.deviceHosts`); reads union every device doc plus legacy central entries. */

import { readMeta, updateMeta } from '../../state.js';
import { unionDeviceHosts } from '../../devices/device-docs.js';
import type { HostEntry } from '../../types.js';
import type { Host, HostProvider, HostProviderCapabilities } from '../types.js';
import { listSshConfigHosts, isSshConfigHost } from '../ssh-config.js';

/** The EFFECTIVE host overlay: the cross-box union of every device doc's
 * `hosts:` block, with any lingering central-legacy `hosts:` entries as a base
 * (a device doc wins on a name collision). Newest `addedAt` wins across boxes. */
function entries(): Record<string, HostEntry> {
  return { ...readMeta().hosts, ...unionDeviceHosts() };
}

/** THIS box's OWN host registrations (the writable slice in the device doc). */
function ownEntries(meta = readMeta()): Record<string, HostEntry> {
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

    // Inline + overlaid hosts from the registry.
    for (const [name, entry] of Object.entries(overlay)) {
      out.push(toHost(name, entry, true));
      seen.add(name);
    }
    // ssh-config hosts not already carrying an overlay → available, not enrolled.
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
    // Device-scoped: land in THIS box's device doc, never the shared central map.
    updateMeta((meta) => ({ ...meta, deviceHosts: { ...ownEntries(meta), [spec.name]: entry } }));
    return toHost(spec.name, entry, true);
  }

  async remove(name: string): Promise<void> {
    // A box only owns the registrations in its own device doc; drop from there.
    updateMeta((meta) => {
      const hosts = { ...ownEntries(meta) };
      delete hosts[name];
      return { ...meta, deviceHosts: hosts };
    });
  }
}
