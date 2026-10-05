/** Union-on-read across every tracked device document (PHNX-3315). Each box records only its own
 * decisions, so pulls never conflict; the view is a deterministic union. A doc that fails to parse
 * is a hard error, since an empty union would let a write wipe a peer's decision. */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as yaml from 'yaml';
import { getUserAgentsDir } from '../state.js';
import type { HostEntry } from '../types.js';
import type { IgnoredDeviceEntry } from '../fleet/types.js';

export interface DeviceDoc {
  device: string;
  doc: Record<string, unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/** Every device doc, sorted by name so the union is order-independent. A corrupt or non-map doc
 * throws; a silently skipped doc would let the next writer clobber that peer's slice. */
export function readAllDeviceDocs(): DeviceDoc[] {
  // Discovery, host, and device-account auto-writers touch only their box's document; readers fold all docs.
  const devicesDir = path.join(getUserAgentsDir(), 'devices');
  if (!fs.existsSync(devicesDir)) return [];
  const out: DeviceDoc[] = [];
  const names = fs
    .readdirSync(devicesDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  for (const device of names) {
    const file = path.join(devicesDir, device, 'agents.yaml');
    if (!fs.existsSync(file)) continue;
    let parsed: unknown;
    try {
      parsed = yaml.parse(fs.readFileSync(file, 'utf8'));
    } catch (err) {
      throw new Error(`Device config corrupted at ${file}: ${(err as Error).message}. Inspect and restore from backup.`);
    }
    if (parsed == null) continue;
    if (!isRecord(parsed)) {
      throw new Error(`Device config corrupted at ${file}: document root must be a map.`);
    }
    out.push({ device, doc: parsed });
  }
  return out;
}

/** Union the per-box `fleet.discovery` maps. For a name declared by several boxes `ignored` beats
 * `approved`, so every box computes the same policy regardless of walk order. */
export function unionDeviceDiscovery(docs: DeviceDoc[] = readAllDeviceDocs()): Record<string, 'approved' | 'ignored'> {
  // Omission never deletes another box's decision, and ignored always wins over approved.
  const out: Record<string, 'approved' | 'ignored'> = {};
  for (const { device, doc } of docs) {
    const fleet = doc.fleet;
    if (fleet === undefined) continue;
    if (!isRecord(fleet)) throw new Error(`Device config corrupted at devices/${device}/agents.yaml: fleet must be a map.`);
    const discovery = fleet.discovery;
    if (discovery === undefined) continue;
    if (!isRecord(discovery)) throw new Error(`Device config corrupted at devices/${device}/agents.yaml: fleet.discovery must be a map.`);
    for (const [name, status] of Object.entries(discovery)) {
      if (status !== 'approved' && status !== 'ignored') {
        throw new Error(`Device discovery policy for '${name}' in devices/${device}/agents.yaml must be approved or ignored.`);
      }
      if (out[name] === 'ignored') continue;
      out[name] = status;
    }
  }
  return out;
}

/** Union the per-box `fleet.ignored` lists by node name. For the same node the newest `ignoredAt`
 * wins (ties by `ignoredOn`); sorted by name to match the central writer. */
export function unionDeviceIgnored(docs: DeviceDoc[] = readAllDeviceDocs()): IgnoredDeviceEntry[] {
  const byName = new Map<string, IgnoredDeviceEntry>();
  for (const { device, doc } of docs) {
    const fleet = doc.fleet;
    if (fleet === undefined) continue;
    if (!isRecord(fleet)) throw new Error(`Device config corrupted at devices/${device}/agents.yaml: fleet must be a map.`);
    const ignored = fleet.ignored;
    if (ignored === undefined) continue;
    if (!Array.isArray(ignored)) throw new Error(`Device config corrupted at devices/${device}/agents.yaml: fleet.ignored must be a list.`);
    for (const raw of ignored) {
      if (!raw || typeof raw.name !== 'string' || typeof raw.ignoredAt !== 'string' || typeof raw.ignoredOn !== 'string') {
        throw new Error(`Device config corrupted at devices/${device}/agents.yaml: fleet.ignored entries must be { name, ignoredAt, ignoredOn }.`);
      }
      addIgnoredEntry(byName, raw);
    }
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export function addIgnoredEntry(byName: Map<string, IgnoredDeviceEntry>, entry: IgnoredDeviceEntry): void {
  const prev = byName.get(entry.name);
  if (!prev) { byName.set(entry.name, entry); return; }
  const at = Date.parse(entry.ignoredAt);
  const prevAt = Date.parse(prev.ignoredAt);
  if (at > prevAt || (at === prevAt && entry.ignoredOn.localeCompare(prev.ignoredOn) > 0)) {
    byName.set(entry.name, entry);
  }
}

/** Union the per-box `hosts:` registries by host name. The newest `addedAt` wins (ties by device
 * name); entries without `addedAt` sort oldest. */
export function unionDeviceHosts(docs: DeviceDoc[] = readAllDeviceDocs()): Record<string, HostEntry> {
  const out: Record<string, HostEntry> = {};
  const wonAt = new Map<string, number>();
  for (const { device, doc } of docs) {
    const hosts = doc.hosts;
    if (hosts === undefined) continue;
    if (!isRecord(hosts)) throw new Error(`Device config corrupted at devices/${device}/agents.yaml: hosts must be a map.`);
    for (const [name, entry] of Object.entries(hosts)) {
      if (!isRecord(entry)) throw new Error(`Device config corrupted at devices/${device}/agents.yaml: host '${name}' must be a map.`);
      const at = typeof entry.addedAt === 'string' ? Date.parse(entry.addedAt) : 0;
      const prev = wonAt.get(name);
      if (prev === undefined || at > prev) {
        out[name] = entry as unknown as HostEntry;
        wonAt.set(name, Number.isNaN(at) ? 0 : at);
      }
    }
  }
  return out;
}

// Native accounts and bindings are machine-local (a native login lives in one box's harness home),
// so account-registry.ts reads this box's own slice (meta.deviceAccounts) merged with the central
// store; there is deliberately no unionDeviceAccounts.
