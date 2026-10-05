
import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'yaml';
import {
  META_HEADER,
  getDevicesAutoLaunchPath,
  getDevicesIgnoredPath,
  getDevicePinsPath,
  getUserAgentsDir,
  readMeta,
  updateMeta,
  withMetaLock,
} from '../state.js';
import { atomicWriteFileSync } from '../fs-atomic.js';
import { machineId } from '../machine-id.js';
import { withIgnoredAdded } from './registry.js';
import { addIgnoredEntry } from './device-docs.js';
import type { Meta } from '../types.js';
import type { FleetDeviceOverride, FleetManifest, IgnoredDeviceEntry } from '../fleet/types.js';

interface DeviceDoc {
  name: string;
  path: string;
  doc: Record<string, unknown>;
}

function readDeviceDocs(devicesRoot: string): DeviceDoc[] {
  const docs: DeviceDoc[] = [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(devicesRoot, { withFileTypes: true });
  } catch {
    return docs;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const docPath = path.join(devicesRoot, entry.name, 'agents.yaml');
    if (!fs.existsSync(docPath)) continue;
    let parsed: unknown;
    try {
      parsed = yaml.parse(fs.readFileSync(docPath, 'utf-8'));
    } catch (err) {
      console.error(`device config migration: could not parse ${docPath} (${(err as Error).message}); leaving it for a later retry`);
      continue;
    }
    if (parsed === null || parsed === undefined) continue;
    if (typeof parsed !== 'object' || Array.isArray(parsed)) {
      console.error(`device config migration: ${docPath} is not a YAML map; leaving it for manual repair`);
      continue;
    }
    docs.push({ name: entry.name, path: docPath, doc: parsed as Record<string, unknown> });
  }
  return docs;
}

function writeDeviceDoc(docPath: string, doc: Record<string, unknown>): void {
  try {
    if (Object.keys(doc).length === 0) {
      fs.rmSync(docPath, { force: true });
      try {
        fs.rmdirSync(path.dirname(docPath));
      } catch {  }
    } else {
      fs.mkdirSync(path.dirname(docPath), { recursive: true });
      atomicWriteFileSync(docPath, META_HEADER + yaml.stringify(doc));
    }
  } catch (err) {
    console.error(`device config migration: could not rewrite ${docPath} (${(err as Error).message}); a later run retries`);
  }
}

function readAutoLaunchFlags(autoLaunchPath: string): Record<string, Record<string, unknown>> {
  const out: Record<string, Record<string, unknown>> = {};
  let raw: string;
  try {
    raw = fs.readFileSync(autoLaunchPath, 'utf-8');
  } catch {
    return out;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    console.error(`device config migration: could not parse ${autoLaunchPath} (${(err as Error).message}); leaving it for a later retry`);
    return out;
  }
  const devices = (parsed as { devices?: unknown })?.devices;
  if (devices && typeof devices === 'object' && !Array.isArray(devices)) {
    for (const [name, pref] of Object.entries(devices as Record<string, { enabled?: unknown; preferred?: unknown }>)) {
      const config: Record<string, unknown> = {};
      if (pref?.enabled === false) config.autoLaunchEnabled = false;
      if (pref?.preferred === true) config.autoLaunchPreferred = true;
      if (Object.keys(config).length > 0) out[name] = config;
    }
  }
  return out;
}

function isConfigMap(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function readLegacyIgnoredFile(p: string): { names: string[]; updatedAt?: string } | null | undefined {
  let raw: string;
  try {
    raw = fs.readFileSync(p, 'utf-8');
  } catch {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as { ignored?: unknown; updatedAt?: unknown };
    return {
      names: Array.isArray(parsed.ignored) ? parsed.ignored.filter((n): n is string => typeof n === 'string') : [],
      updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : undefined,
    };
  } catch (err) {
    console.error(`device config migration: could not parse ${p} (${(err as Error).message}); leaving it for a later retry`);
    return undefined;
  }
}

export function migrateDeviceConfigStores(): void {
  const devicesRoot = path.join(getUserAgentsDir(), 'devices');
  const autoLaunchPath = getDevicesAutoLaunchPath();
  const self = machineId();

  const fleet = readMeta().fleet;
  const centralDevices: Record<string, FleetDeviceOverride> =
    fleet && fleet.devices !== 'all' ? fleet.devices : {};
  const centralHasConfig = Object.values(centralDevices).some(
    (ov) => ov?.config && Object.keys(ov.config).length > 0,
  );

  const autoLaunchFlags = readAutoLaunchFlags(autoLaunchPath);
  const docs = readDeviceDocs(devicesRoot);

  const legacyIgnoredPath = getDevicesIgnoredPath();
  const legacyIgnoredPending = fs.existsSync(legacyIgnoredPath);
  const legacyIgnored = legacyIgnoredPending ? readLegacyIgnoredFile(legacyIgnoredPath) : null;

  const centralFleetState = !!(
    fleet &&
    ((fleet.discovery && Object.keys(fleet.discovery).length > 0) ||
      (Array.isArray(fleet.ignored) && fleet.ignored.length > 0))
  );

  const centralHosts = readMeta().hosts;
  const centralHostsPending = !!(centralHosts && Object.keys(centralHosts).length > 0);

  const centralAccounts = readMeta().accounts;
  const accountsPending = !!(
    centralAccounts?.native && Object.values(centralAccounts.native).some((a) => a.scope === 'device')
  );

  const pinsPath = getDevicePinsPath();
  let selfPins: { agents?: Record<string, string>; isolatedAgents?: Record<string, string> } = {};
  try {
    selfPins = (JSON.parse(fs.readFileSync(pinsPath, 'utf-8')) as typeof selfPins) || {};
  } catch {  }

  const plans: Array<{ name: string; path: string; next: Record<string, unknown> }> = [];
  for (const { name, path: docPath, doc } of docs) {
    const plan = planDeviceDocFold(name, docPath, doc, centralDevices[name]?.config, autoLaunchFlags[name]);
    if (plan) plans.push(plan);
  }
  const docNames = new Set(docs.map((d) => d.name));
  const newDocs: Array<{ path: string; doc: Record<string, unknown> }> = [];
  for (const [name, ov] of Object.entries(centralDevices)) {
    if (docNames.has(name) || !isConfigMap(ov?.config)) continue;
    newDocs.push({ path: path.join(devicesRoot, name, 'agents.yaml'), doc: { config: { ...autoLaunchFlags[name], ...ov.config } } });
  }
  for (const [name, flags] of Object.entries(autoLaunchFlags)) {
    if (docNames.has(name) || isConfigMap(centralDevices[name]?.config)) continue;
    newDocs.push({ path: path.join(devicesRoot, name, 'agents.yaml'), doc: { config: { ...flags } } });
  }
  const selfDoc = docs.find((d) => d.name === self);
  const docAgents = isConfigMap(selfDoc?.doc.agents) ? (selfDoc!.doc.agents as Record<string, string>) : undefined;
  const docIsolated = isConfigMap(selfDoc?.doc.isolatedAgents)
    ? (selfDoc!.doc.isolatedAgents as Record<string, string>)
    : undefined;
  const hasDestinationWork = plans.length > 0 || newDocs.length > 0 || docAgents !== undefined || docIsolated !== undefined;

  const autoLaunchPending = fs.existsSync(autoLaunchPath);
  if (!centralHasConfig && !hasDestinationWork && !autoLaunchPending && !legacyIgnoredPending && !centralFleetState && !centralHostsPending && !accountsPending) return;

  if (hasDestinationWork) {
    // Commit every destination before removing a legacy source so interruption can only cause a safe retry.
    withMetaLock(() => {
      if (docAgents || docIsolated) {
        const pins: typeof selfPins = { ...selfPins };
        if (docAgents) pins.agents = { ...docAgents, ...selfPins.agents };
        if (docIsolated) pins.isolatedAgents = { ...docIsolated, ...selfPins.isolatedAgents };
        try {
          fs.mkdirSync(path.dirname(pinsPath), { recursive: true });
          atomicWriteFileSync(pinsPath, JSON.stringify(pins, null, 2) + '\n');
        } catch (err) {
          console.error(`device config migration: could not write ${pinsPath} (${(err as Error).message}); a later run retries`);
        }
      }
      for (const plan of plans) writeDeviceDoc(plan.path, plan.next);
      for (const nd of newDocs) writeDeviceDoc(nd.path, nd.doc);
    });
  }

  if (centralHasConfig) {
    updateMeta((m) => {
      const devices = m.fleet?.devices;
      if (!devices || devices === 'all') return m;
      const nextDevices: Record<string, FleetDeviceOverride> = {};
      for (const [name, ov] of Object.entries(devices)) {
        const rest = { ...ov };
        delete rest.config;
        if (Object.keys(rest).length > 0) nextDevices[name] = rest;
      }
      const fleet: FleetManifest = { ...m.fleet, devices: nextDevices };
      const fleetIsEmpty =
        Object.keys(nextDevices).length === 0 &&
        !fleet.defaults &&
        !fleet.secrets &&
        !fleet.routines &&
        !fleet.discovery &&
        !(fleet.ignored && fleet.ignored.length > 0);
      if (fleetIsEmpty) {
        const { fleet: _, ...rest } = m;
        void _;
        return rest;
      }
      return { ...m, fleet };
    });
  }

  if (autoLaunchPending) {
    try {
      fs.rmSync(autoLaunchPath, { force: true });
    } catch (err) {
      console.error(`device config migration: could not remove ${autoLaunchPath} (${(err as Error).message}); a later run retries`);
    }
  }

  if (legacyIgnored) {
    if (legacyIgnored.names.length > 0) {
      updateMeta((m) => withIgnoredAdded(m, legacyIgnored.names, legacyIgnored.updatedAt ?? new Date().toISOString()));
    }
    try {
      fs.rmSync(legacyIgnoredPath, { force: true });
    } catch (err) {
      console.error(`device config migration: could not remove ${legacyIgnoredPath} (${(err as Error).message}); a later run retries`);
    }
  }

  if (centralFleetState) {
    updateMeta((m) => {
      const disc = m.fleet?.discovery;
      const ign = m.fleet?.ignored;
      const hasDisc = !!disc && Object.keys(disc).length > 0;
      const hasIgn = Array.isArray(ign) && ign.length > 0;
      if (!hasDisc && !hasIgn) return m;

      const discovery: Record<string, 'approved' | 'ignored'> = { ...m.deviceFleet?.discovery };
      if (hasDisc) {
        for (const [name, status] of Object.entries(disc!)) {
          if (status !== 'approved' && status !== 'ignored') continue;
          if (discovery[name] === 'ignored') continue;
          discovery[name] = status;
        }
      }

      const byName = new Map<string, IgnoredDeviceEntry>();
      for (const e of m.deviceFleet?.ignored ?? []) addIgnoredEntry(byName, e);
      if (hasIgn) for (const e of ign!) addIgnoredEntry(byName, e);
      const ignored = [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));

      const deviceFleet = {
        ...(Object.keys(discovery).length > 0 ? { discovery } : {}),
        ...(ignored.length > 0 ? { ignored } : {}),
      };

      const fleet: FleetManifest | undefined = m.fleet ? { ...m.fleet } : undefined;
      if (fleet) {
        delete fleet.discovery;
        delete fleet.ignored;
      }
      const fleetEmpty =
        !fleet ||
        ((fleet.devices === undefined ||
          (fleet.devices !== 'all' && Object.keys(fleet.devices).length === 0)) &&
          !fleet.defaults &&
          !fleet.secrets &&
          !fleet.routines);
      if (fleetEmpty) {
        const { fleet: _drop, ...rest } = m;
        void _drop;
        return { ...rest, deviceFleet } as Meta;
      }
      return { ...m, deviceFleet, fleet } as Meta;
    });
  }

  if (centralHostsPending) {
    updateMeta((m) => {
      const hosts = m.hosts;
      if (!hosts || Object.keys(hosts).length === 0) return m;
      const deviceHosts = { ...hosts, ...m.deviceHosts };
      const { hosts: _drop, ...rest } = m;
      void _drop;
      return { ...rest, deviceHosts } as Meta;
    });
  }

  if (accountsPending) {
    // Device-scoped account identity is machine-local and must leave the tracked central account map.
    updateMeta((m) => {
      const native = { ...m.accounts?.native };
      const bindings = { ...m.accounts?.bindings };
      const devNative = { ...m.deviceAccounts?.native };
      const devBindings = { ...m.deviceAccounts?.bindings };
      const movedIds = new Set<string>();
      let changed = false;
      for (const [id, entry] of Object.entries(native)) {
        if (entry.scope === 'device') {
          devNative[id] = entry;
          movedIds.add(id);
          delete native[id];
          changed = true;
        }
      }
      for (const [target, id] of Object.entries(bindings)) {
        if (movedIds.has(id)) {
          devBindings[target] = id;
          delete bindings[target];
          changed = true;
        }
      }
      if (!changed) return m;

      const deviceAccounts = {
        ...(Object.keys(devNative).length > 0 ? { native: devNative } : {}),
        ...(Object.keys(devBindings).length > 0 ? { bindings: devBindings } : {}),
      };
      const accounts: NonNullable<Meta['accounts']> = { ...m.accounts };
      if (Object.keys(native).length > 0) accounts.native = native;
      else delete accounts.native;
      if (Object.keys(bindings).length > 0) accounts.bindings = bindings;
      else delete accounts.bindings;
      const accountsEmpty = !accounts.native && !accounts.bindings && !accounts.defaults;
      if (accountsEmpty) {
        const { accounts: _drop, ...rest } = m;
        void _drop;
        return { ...rest, deviceAccounts } as Meta;
      }
      return { ...m, accounts, deviceAccounts } as Meta;
    });
  }
}

function sameDocContent(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
  const ak = Object.keys(a);
  const bk = Object.keys(b);
  if (ak.length !== bk.length) return false;
  return ak.every((k) => k in b && JSON.stringify(a[k]) === JSON.stringify(b[k]));
}

function planDeviceDocFold(
  name: string,
  docPath: string,
  doc: Record<string, unknown>,
  centralConfig: unknown,
  autoFlags: Record<string, unknown> | undefined,
): { name: string; path: string; next: Record<string, unknown> } | null {
  const config: Record<string, unknown> = {};
  Object.assign(config, autoFlags);
  if (doc.config !== undefined) {
    if (!isConfigMap(doc.config)) {
      console.error(`device config migration: ${docPath} has a non-map config: block; leaving it for manual repair`);
      return null;
    }
    Object.assign(config, doc.config);
  }
  if (typeof doc.defaultBrowserProfile === 'string' && config.defaultBrowserProfile === undefined) {
    config.defaultBrowserProfile = doc.defaultBrowserProfile;
  }
  if (isConfigMap(centralConfig)) Object.assign(config, centralConfig);

  const next: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(doc)) {
    if (k === 'config' || k === 'defaultBrowserProfile' || k === 'agents' || k === 'isolatedAgents') continue;
    next[k] = v;
  }
  if (Object.keys(config).length > 0) next.config = config;

  return sameDocContent(next, doc) ? null : { name, path: docPath, next };
}
