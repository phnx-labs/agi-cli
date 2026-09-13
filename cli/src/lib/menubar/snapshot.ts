import * as fs from 'fs';
import * as path from 'path';

import { buildRoutineListJson } from '../scheduling/routines.js';
import { backfillActiveRowsFromIndex, isRunningLiveSession, serializeActiveSessionsForJson, serializeSessionsJson } from '../session/active.js';
import { getConfigValue, listConfiguredDeviceRoles, loadAutoLaunchPreferences } from '../device-config.js';
import { filterAutoPool } from '../devices/pool.js';
import { isFreshDeviceStats, readStatsCache } from '../devices/stats-cache.js';
import { MENUBAR_MENU_PROPERTIES } from '../config-keys.js';
import { migrateMenubarPreferencesFromUserDefaults } from './migrate-prefs.js';
import { loadDevices } from '../devices/registry.js';
import { machineId } from '../machine-id.js';
import { querySessions } from '../session/db.js';
import { readActiveSessionsCache } from '../session/session-cache.js';
import { getRuntimeStateDir } from '../state.js';
import { getCliVersion } from '../version.js';
import type { DeviceStats } from '../devices/health.js';
import type { WatchdogTickResult } from '../watchdog/runner.js';

/**
 * One registered fleet device, for the menu-bar's collapsible DEVICES section.
 * Sourced from the local registry read (`loadDevices`) — no network probe — so
 * it carries only local persisted state (name, platform, preferred status,
 * whether it is the interactive host, whether it is this machine). Live load% is merged in
 * on the Swift side from the daemon-warmed `.fleet-stats.json`; online/offline
 * is deliberately NOT claimed here (the registry's cached tailscale flag is
 * documented as stale in both directions — registry.ts isLikelyOnline).
 */
interface MenubarDevice {
  name: string;
  platform: string;
  /**
   * Physical form factor for a factual hardware icon: `laptop` | `desktop` |
   * `server` | `unknown` (PHNX-3999). A shared device-scope config fact set
   * explicitly per device — never inferred from `platform`. `unknown` when unset.
   */
  formFactor: string;
  interactive: boolean;
  isLocal: boolean;
  preferred: boolean;
  /**
   * The operator's role mark — `worker` | `personal` | `desktop`, or `unknown`
   * when the device was never marked (PHNX-3999 F25). Read from the same
   * device-scope config `--device auto` consults, so the menu shows the fact that
   * governs placement rather than a second notion of it.
   */
  role: string;
  /**
   * True when automatic placement (`agents run --device auto`) may pick this
   * device: the verdict of the ONE canonical pool filter, so a `personal` box the
   * user sits at reads as ineligible here exactly as it behaves there.
   */
  autoEligible: boolean;
  /** Hardware facts and the current reading, or null when never observed. */
  stats: MenubarDeviceStats | null;
}

/**
 * One device's hardware facts and last reading, projected from the fleet-stats
 * cache the CLI already keeps (`~/.agents/.cache/.fleet-stats.json`).
 *
 * Cache-only by construction: the snapshot never probes the fleet, so opening
 * Settings costs nothing and a device nobody has measured says so. Every value
 * is `null` when that number was not observed — never 0, which would render as a
 * real "idle, empty disk" reading. `stale` carries the CLI's own freshness bound
 * so the menu can label an old reading instead of showing it as live, and
 * `observedAt` / `specsObservedAt` give the observation age F25 asks for
 * (hardware totals survive an unreachable probe; current-state readings do not).
 */
interface MenubarDeviceStats {
  reachable: boolean;
  observedAt: string;
  stale: boolean;
  cpus: number | null;
  memTotalBytes: number | null;
  memFreeBytes: number | null;
  memPercent: number | null;
  diskTotalBytes: number | null;
  diskFreeBytes: number | null;
  diskUsedPercent: number | null;
  loadPercent: number | null;
  specsObservedAt: string | null;
}

interface MenubarSnapshot {
  version: 1;
  capturedAt: string;
  /**
   * The installed CLI version that produced this snapshot — the same string
   * `agents --version` prints (RUSH-2688). The snapshot is emitted by whatever
   * `agents` binary is on PATH, so this is resolved at runtime, letting the menu
   * bar show its own version in the header and making a stale menu bar visible.
   */
  cliVersion: string;
  routines: Record<string, unknown>[];
  recentSessions: Record<string, unknown>[];
  activeSessions: Record<string, unknown>[];
  devices: MenubarDevice[];
  /**
   * AGI Menu preferences (PHNX-3999), keyed by the full `menubar.menu.*` config
   * name, carrying the EFFECTIVE value — the stored value, else the registered
   * default. The native menu consumes this from the snapshot it already polls
   * rather than a second preference-read mechanism. `menubar.menu.defaultProject`
   * is omitted when unset (it has no default); every other key is always present.
   * Writes stay one `agents config set/unset <key>` per setting.
   */
  menuPreferences: Record<string, unknown>;
  watchdog: {
    enabled: boolean;
    lastTick: Pick<WatchdogTickResult, 'didNudge' | 'counts'> | null;
  };
}

/**
 * The effective AGI Menu preferences map for the snapshot: each `menubar.menu.*`
 * key's stored value, or its registered default when unset. A key with neither
 * (only `defaultProject`) is omitted so the native app keeps its own default.
 */
export function buildMenuPreferences(): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const prop of MENUBAR_MENU_PROPERTIES) {
    const name = `menubar.menu.${prop}`;
    const entry = getConfigValue(name);
    const value = entry.value !== undefined ? entry.value : entry.spec.defaultValue;
    if (value === undefined) continue; // unset defaultProject — no default to emit
    out[name] = value;
  }
  return out;
}

/**
 * The full registered-device roster for the menu bar, from the local registry
 * file only (no ssh, no stats probe) — as cheap as `buildRoutineListJson()`, so
 * it rides the same 3-minute snapshot poll instead of a second timer.
 */
async function buildMenubarDevices(): Promise<MenubarDevice[]> {
  const reg = await loadDevices();
  const roster = Object.keys(reg);
  // Pass the roster so a fleet-wide default (fleet.defaults.config) reaches
  // devices that have no doc of their own.
  const prefs = loadAutoLaunchPreferences(roster);
  const roles = listConfiguredDeviceRoles(roster);
  // The placement verdict from the one canonical filter — not a re-implementation
  // of the role rule (`devices/pool.ts` owns it).
  const autoEligible = new Set(filterAutoPool(roster, { roles, autoLaunch: prefs }));
  // Cache read only: no ssh, no probe, so this still rides the existing snapshot
  // poll (docs/menubar.md: the menu bar must not probe the fleet per render).
  const stats = readStatsCache();
  const interactiveHost = getConfigValue('interactive.host').value as string | undefined;
  const self = machineId();
  return roster
    .sort()
    .map((name) => ({
      name,
      platform: reg[name].platform,
      // Shared device-scope fact (readable for any device); `unknown` when unset.
      formFactor: (getConfigValue('formFactor', { device: name }).value as string | undefined) ?? 'unknown',
      interactive: name === interactiveHost,
      isLocal: name === self,
      preferred: prefs[name]?.preferred === true,
      role: roles[name] ?? 'unknown',
      autoEligible: autoEligible.has(name),
      stats: projectDeviceStats(stats[name]),
    }));
}

/**
 * Project one cached {@link DeviceStats} row into the snapshot shape, or `null`
 * when the device has no cached reading at all.
 *
 * `?? null` rather than a default: an absent number means "not observed", and the
 * menu renders that as unavailable. A 0 would be indistinguishable from a real
 * measurement of an idle box or a full disk.
 */
export function projectDeviceStats(row: DeviceStats | undefined): MenubarDeviceStats | null {
  if (!row) return null;
  return {
    reachable: row.reachable,
    observedAt: new Date(row.fetchedAt).toISOString(),
    stale: !isFreshDeviceStats(row),
    cpus: row.ncpu ?? null,
    memTotalBytes: row.memTotalBytes ?? null,
    memFreeBytes: row.memFreeBytes ?? null,
    memPercent: row.memPercent ?? null,
    diskTotalBytes: row.diskTotalBytes ?? null,
    diskFreeBytes: row.diskFreeBytes ?? null,
    diskUsedPercent: row.diskUsedPercent ?? null,
    loadPercent: row.loadPercent ?? null,
    specsObservedAt: row.specsFetchedAt ? new Date(row.specsFetchedAt).toISOString() : null,
  };
}

export function readLastWatchdogTick(
  stateDir = path.join(getRuntimeStateDir(), 'watchdog'),
): WatchdogTickResult | null {
  try {
    return JSON.parse(fs.readFileSync(path.join(stateDir, 'last-tick.json'), 'utf-8')) as WatchdogTickResult;
  } catch {
    return null;
  }
}

/** One-process read model for AGI Menu's repeating three-minute refresh. */
export async function computeMenubarSnapshot(): Promise<MenubarSnapshot> {
  // One-shot, sentinel-gated, macOS-only lift of legacy UserDefaults prefs into
  // config before we read them. After the first run it is a cheap existsSync
  // no-op; it never throws into the snapshot.
  migrateMenubarPreferencesFromUserDefaults();
  const [routines, recent, devices] = await Promise.all([
    Promise.resolve(buildRoutineListJson()),
    Promise.resolve(querySessions({ limit: 40, skipExistenceCheck: true })),
    buildMenubarDevices(),
  ]);
  const active = readActiveSessionsCache('local');
  const rawSessions = active?.sessions ?? [];
  // The raw cache is never filtered at write time (RUSH-2336) — it retains
  // queued/closed/crashed rows so `--queued`/`--closed`/`--crashed` can
  // recover them, and the daemon's warm-tick gather (unlike the CLI's own
  // local gather) never stamps `machine` on a row. Stamp self here — this IS
  // the 'local' scope by construction — then apply the ONE canonical
  // bare-active selector so the menubar never shows a retained dead/queued
  // row nor a process row of unverified liveness.
  const self = machineId();
  for (const s of rawSessions) if (!s.machine) s.machine = self;
  const activeSessions = rawSessions.filter(isRunningLiveSession);
  backfillActiveRowsFromIndex(activeSessions);
  return {
    version: 1,
    capturedAt: new Date().toISOString(),
    cliVersion: getCliVersion(),
    routines,
    recentSessions: JSON.parse(serializeSessionsJson(recent)) as Record<string, unknown>[],
    activeSessions: serializeActiveSessionsForJson(activeSessions) as Record<string, unknown>[],
    devices,
    menuPreferences: buildMenuPreferences(),
    watchdog: {
      enabled: getConfigValue('watchdog.enabled').value === true,
      lastTick: (() => {
        const tick = readLastWatchdogTick();
        return tick ? { didNudge: tick.didNudge, counts: tick.counts } : null;
      })(),
    },
  };
}
