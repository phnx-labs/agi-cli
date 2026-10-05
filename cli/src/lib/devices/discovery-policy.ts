import { readMeta, updateMeta } from '../state.js';
import { unionDeviceDiscovery } from './device-docs.js';
import {
  addIgnored,
  assertValidDeviceName,
  loadDevices,
  removeDevice,
  removeIgnored,
  upsertDevice,
} from './registry.js';
import { localLoginUser, withDefaultUser } from './sync.js';
import { nodeToDeviceInput, parseTailscaleStatus, tailscaleStatusJson } from './tailscale.js';

type DeviceDiscoveryStatus = 'approved' | 'ignored';

interface DeviceDiscoveryReconcileResult {
  approved: string[];
  ignored: string[];
  registered: string[];
  unresolved: string[];
}

export function getDeviceDiscoveryStatus(name: string): DeviceDiscoveryStatus | undefined {
  assertValidDeviceName(name);
  return loadDeviceDiscoveryPolicies().get(name);
}

export function setDeviceDiscoveryStatus(name: string, status: DeviceDiscoveryStatus | undefined): void {
  assertValidDeviceName(name);
  updateMeta((meta) => {
    const discovery = { ...meta.deviceFleet?.discovery };
    if (status) discovery[name] = status;
    else delete discovery[name];
    return { ...meta, deviceFleet: { ...meta.deviceFleet, discovery } };
  });
}

export function loadDeviceDiscoveryPolicies(): Map<string, DeviceDiscoveryStatus> {
  // Corruption is fatal: silently dropping one document could re-enroll an intentionally ignored peer.
  const policies = new Map<string, DeviceDiscoveryStatus>();
  const apply = (rec: Record<string, unknown> | undefined) => {
    for (const [name, status] of Object.entries(rec ?? {})) {
      assertValidDeviceName(name);
      if (status !== 'approved' && status !== 'ignored') {
        throw new Error(`Device discovery policy for '${name}' must be approved or ignored.`);
      }
      if (policies.get(name) === 'ignored') continue;
      policies.set(name, status);
    }
  };
  apply(readMeta().fleet?.discovery);
  apply(unionDeviceDiscovery());
  return policies;
}

export async function reconcileDeviceDiscoveryPolicies(): Promise<DeviceDiscoveryReconcileResult> {
  const policies = loadDeviceDiscoveryPolicies();
  if (policies.size === 0) {
    return { approved: [], ignored: [], registered: [], unresolved: [] };
  }
  const approved = [...policies].filter(([, s]) => s === 'approved').map(([n]) => n).sort();
  const ignored = [...policies].filter(([, s]) => s === 'ignored').map(([n]) => n).sort();

  for (const name of ignored) {
    await removeDevice(name);
    await addIgnored(name);
  }
  for (const name of approved) await removeIgnored(name);

  const currentRegistry = await loadDevices();
  const missing = approved.filter((name) => !currentRegistry[name]);
  if (missing.length === 0) return { approved, ignored, registered: [], unresolved: [] };

  let json: string;
  try {
    json = tailscaleStatusJson();
  } catch {
    return { approved, ignored, registered: [], unresolved: missing };
  }
  return registerApprovedDevicesFromTailscale(json, approved, ignored, missing);
}

export async function registerApprovedDevicesFromTailscale(
  json: string,
  approved: string[],
  ignored: string[],
  missing: string[],
): Promise<DeviceDiscoveryReconcileResult> {
  const nodes = parseTailscaleStatus(json);
  const byName = new Map(nodes.map((node) => [node.name, node]));
  const registered: string[] = [];
  const unresolved: string[] = [];
  const user = localLoginUser();
  for (const name of missing) {
    const node = byName.get(name);
    if (!node) {
      unresolved.push(name);
      continue;
    }
    await upsertDevice(name, withDefaultUser(nodeToDeviceInput(node), undefined, user));
    registered.push(name);
  }
  return { approved, ignored, registered, unresolved };
}
