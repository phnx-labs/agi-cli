/** One-time migration to the device-config + pins layout: legacy and central config (#2458) fold
 * into each device doc's `config:`; pins leave tracked docs; `ignored.json` folds into
 * `fleet.ignored` (RUSH-3062). Writes precede strips, so a crash re-folds as a no-op. */

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

/** One parsed device doc under ~/.agents/devices/. */
interface DeviceDoc {
  name: string;
  path: string;
  doc: Record<string, unknown>;
}

/** Read every device doc. A doc that fails to parse is loudly skipped. */
function readDeviceDocs(devicesRoot: string): DeviceDoc[] {
  const docs: DeviceDoc[] = [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(devicesRoot, { withFileTypes: true });
  } catch {
    return docs; // no devices/ tree — nothing to fold
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
    if (parsed === null || parsed === undefined) continue; // empty doc
    if (typeof parsed !== 'object' || Array.isArray(parsed)) {
      console.error(`device config migration: ${docPath} is not a YAML map; leaving it for manual repair`);
      continue;
    }
    docs.push({ name: entry.name, path: docPath, doc: parsed as Record<string, unknown> });
  }
  return docs;
}

/** Write a device doc, or remove it (and its dir) when nothing remains. */
function writeDeviceDoc(docPath: string, doc: Record<string, unknown>): void {
  try {
    if (Object.keys(doc).length === 0) {
      fs.rmSync(docPath, { force: true });
      try {
        fs.rmdirSync(path.dirname(docPath));
      } catch { /* not empty — other files live in the device dir */ }
    } else {
      fs.mkdirSync(path.dirname(docPath), { recursive: true });
      atomicWriteFileSync(docPath, META_HEADER + yaml.stringify(doc));
    }
  } catch (err) {
    console.error(`device config migration: could not rewrite ${docPath} (${(err as Error).message}); a later run retries`);
  }
}

/** The legacy auto-launch.json flags, keyed by device name ({} when absent). */
function readAutoLaunchFlags(autoLaunchPath: string): Record<string, Record<string, unknown>> {
  const out: Record<string, Record<string, unknown>> = {};
  let raw: string;
  try {
    raw = fs.readFileSync(autoLaunchPath, 'utf-8');
  } catch {
    return out; // absent — nothing to fold
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

/** The legacy per-machine ignored.json; absent is null. A parse failure is logged and reported as
 * `undefined` so the caller leaves the file for a retry, never silently emptied. */
function readLegacyIgnoredFile(p: string): { names: string[]; updatedAt?: string } | null | undefined {
  let raw: string;
  try {
    raw = fs.readFileSync(p, 'utf-8');
  } catch {
    return null; // absent — nothing to fold
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

/** Fold every legacy device-config/pins location into the current layout. Safe on every boot or
 * config access: a cheap no-op once folded. */
export function migrateDeviceConfigStores(): void {
  const devicesRoot = path.join(getUserAgentsDir(), 'devices');
  const autoLaunchPath = getDevicesAutoLaunchPath();
  const self = machineId();

  // ── 1. Gather ────────────────────────────────────────────────────────────
  // Central per-device config (the #2458 store).
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

  // Central shared fleet.discovery / fleet.ignored (PHNX-3315): the maps N boxes
  // used to rewrite. Folded into THIS box's device doc below, then stripped.
  const centralFleetState = !!(
    fleet &&
    ((fleet.discovery && Object.keys(fleet.discovery).length > 0) ||
      (Array.isArray(fleet.ignored) && fleet.ignored.length > 0))
  );

  // Central shared `hosts:` map (PHNX-3315): the host registry N boxes used to
  // rewrite. Folded into THIS box's device doc below, then the central key is
  // dropped entirely.
  const centralHosts = readMeta().hosts;
  const centralHostsPending = !!(centralHosts && Object.keys(centralHosts).length > 0);

  // Central device-scoped native accounts (PHNX-3315): a native login is
  // machine-local, so `scope:'device'` identities (and the bindings that target
  // them) belong in this box's device doc, off the git-tracked shared file.
  const centralAccounts = readMeta().accounts;
  const accountsPending = !!(
    centralAccounts?.native && Object.values(centralAccounts.native).some((a) => a.scope === 'device')
  );

  const pinsPath = getDevicePinsPath();
  let selfPins: { agents?: Record<string, string>; isolatedAgents?: Record<string, string> } = {};
  try {
    selfPins = (JSON.parse(fs.readFileSync(pinsPath, 'utf-8')) as typeof selfPins) || {};
  } catch { /* absent or malformed — the fold below recreates it */ }

  // ── 1b. Plan (pure) — so a converged install never takes the meta lock or
  //    rewrites a byte-identical doc on every boot.
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

  // Step 2: destination writes first (crash-safe), under the meta lock so they serialize with
  // writeMetaUnlocked. Only taken when there is a write; locking a converged install would create
  // a default central agents.yaml.
  if (hasDestinationWork) {
    withMetaLock(() => {
      // 2a. THIS machine's pins: doc pins merge INTO the pins file (pins file
      //     wins — it is the destination, and a re-fold after a crash must not
      //     clobber pins the new CLI already wrote).
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
      // 2b/2c. The planned doc rewrites + creations.
      for (const plan of plans) writeDeviceDoc(plan.path, plan.next);
      for (const nd of newDocs) writeDeviceDoc(nd.path, nd.doc);
    });
  }

  // Step 3: source strips last. Drop every central devices.<name>.config block (now in device
  // docs); overrides left empty are dropped, and an emptied fleet block goes away.
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
      // Drop the whole `fleet` block only when nothing else lives in it. Name every resident here:
      // `ignored` and `discovery` would otherwise be lost, and `agents repo push` would sync the
      // deletion fleet-wide. Add any new fleet.* key to this guard.
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

  // 3b. The legacy auto-launch.json.
  if (autoLaunchPending) {
    try {
      fs.rmSync(autoLaunchPath, { force: true });
    } catch (err) {
      console.error(`device config migration: could not remove ${autoLaunchPath} (${(err as Error).message}); a later run retries`);
    }
  }

  // Step 4: legacy ignored.json to central fleet.ignored. The destination write lands before the
  // legacy file is removed, so a crash re-folds as a no-op (withIgnoredAdded unions by name). A
  // file that failed to parse is left for that retry.
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

  // Step 5 (PHNX-3315): central fleet.discovery / fleet.ignored fold into this box's device doc,
  // then are stripped from central. The device doc is written first, and union-dedup (ignored
  // beats approved; newest ignoredAt wins) makes a re-fold a no-op.
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
          if (discovery[name] === 'ignored') continue; // ignored is never downgraded
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
      // Drop an emptied fleet block entirely (mirrors step 3a's guard) so the
      // strip does not leave a bare `fleet: { devices: {} }` behind.
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

  // Step 6 (PHNX-3315): the central hosts map folds into this box's deviceHosts, then the central
  // key is dropped. The device doc is written first; newest-addedAt union makes a re-fold a no-op.
  if (centralHostsPending) {
    updateMeta((m) => {
      const hosts = m.hosts;
      if (!hosts || Object.keys(hosts).length === 0) return m;
      // This box's own device-doc entries win over the shared legacy on a name
      // collision (a re-fold after a crash must not clobber a fresher local edit).
      const deviceHosts = { ...hosts, ...m.deviceHosts };
      const { hosts: _drop, ...rest } = m;
      void _drop;
      return { ...rest, deviceHosts } as Meta;
    });
  }

  // Step 7 (PHNX-3315): fold `scope:'device'` native accounts and bindings from central into the
  // device doc, removing identity PII from the tracked file. Selection is recomputed inside the
  // lock so concurrent writes are not clobbered; the id-keyed merge makes a re-fold a no-op.
  if (accountsPending) {
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
      // Drop the whole central `accounts` block only when nothing fleet-shared
      // remains (no version natives, no bindings, no defaults).
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

/** Shallow-set equality for folded doc content (values compared deep via JSON). */
function sameDocContent(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
  const ak = Object.keys(a);
  const bk = Object.keys(b);
  if (ak.length !== bk.length) return false;
  return ak.every((k) => k in b && JSON.stringify(a[k]) === JSON.stringify(b[k]));
}

/** Compute a device doc's post-fold content: merge config layers (auto-launch.json < the doc's
 * `config:` < central #2458 block, newest wins), fold `defaultBrowserProfile`, strip pins. Returns
 * null when the doc is corrupt (loudly, left for manual repair) or the fold would change nothing. */
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
  // Preserve fields the migration does not own (routines:, anything else).
  for (const [k, v] of Object.entries(doc)) {
    if (k === 'config' || k === 'defaultBrowserProfile' || k === 'agents' || k === 'isolatedAgents') continue;
    next[k] = v;
  }
  if (Object.keys(config).length > 0) next.config = config;

  return sameDocContent(next, doc) ? null : { name, path: docPath, next };
}
