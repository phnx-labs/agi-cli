import * as fs from 'fs';
import * as path from 'path';

import { httpsUrl } from '../actor.js';
import { cachedViewer, emailDigest, type GithubViewer } from '../github/viewer.js';
import { readSession, type PhoenixSession } from '../identity/client.js';
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

/** One registered fleet device for the menu's DEVICES section, from the local registry (no network
 * probe). Live load% is merged by the Swift side; online/offline is deliberately not claimed (the
 * registry's tailscale flag is stale both ways; registry.ts isLikelyOnline). */
interface MenubarDevice {
  name: string;
  platform: string;
  /** Physical form factor for a hardware icon: `laptop` | `desktop` | `server` | `unknown`
   * (PHNX-3999). A device-scope config fact set explicitly, never inferred from `platform`;
   * `unknown` when unset. */
  formFactor: string;
  interactive: boolean;
  isLocal: boolean;
  preferred: boolean;
  /** The operator's role mark: `worker` | `personal` | `desktop`, or `unknown` when never marked
   * (PHNX-3999 F25). Read from the same device-scope config `--device auto` uses, so the menu
   * shows the fact that governs placement. */
  role: string;
  /** True when `agents run --device auto` may pick this device: the verdict of the ONE canonical
   * pool filter, so a `personal` box the user sits at reads as ineligible here as it behaves
   * there. */
  autoEligible: boolean;
  /** Hardware facts and the current reading, or null when never observed. */
  stats: MenubarDeviceStats | null;
}

/** One device's hardware facts and last reading from the fleet-stats cache
 * (`~/.agents/.cache/.fleet-stats.json`); never probes the fleet. Unobserved values are `null`,
 * never 0 (it would read as idle). `stale` carries the freshness bound. */
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

/** The person signed in here, for the avatar, from local reads only: the Phoenix session file and
 * the cached `gh api user` record. `avatarUrl` is the Phoenix picture, else GitHub's, else null
 * (initials); `avatarSource` says which. Null when neither knows anyone. */
export interface MenubarMe {
  name: string | null;
  email: string | null;
  github: string | null;
  avatarUrl: string | null;
  avatarSource: 'phoenix' | 'github' | null;
}

/** Pure: folds the Phoenix session and GitHub viewer into `me`, one person, never a blend. With a
 * session, `gh` contributes only when its public email matches, so a shared box's other `gh` login
 * can't lend its face. Without one, `gh` supplies all but `email`. */
export function resolveMenubarMe(session: PhoenixSession | null, viewer: GithubViewer | null): MenubarMe | null {
  const sessionEmail = session?.email?.trim() || null;
  const github = !session
    ? viewer
    : viewer?.emailSha256 && sessionEmail && viewer.emailSha256 === emailDigest(sessionEmail)
      ? viewer
      : null;
  if (!session && !github) return null;
  const phoenixAvatar = httpsUrl(session?.avatarUrl) ?? null;
  const githubAvatar = github?.avatarUrl ?? null;
  return {
    name: session?.name?.trim() || github?.name || null,
    email: sessionEmail,
    github: github?.login ?? null,
    avatarUrl: phoenixAvatar ?? githubAvatar,
    avatarSource: phoenixAvatar ? 'phoenix' : githubAvatar ? 'github' : null,
  };
}

interface MenubarSnapshot {
  version: 1;
  capturedAt: string;
  /** The installed CLI version that produced this snapshot (what `agents --version` prints,
   * RUSH-2688), resolved at runtime since whatever `agents` is on PATH emits it; lets the menu
   * show its version and a stale menu bar be visible. */
  cliVersion: string;
  routines: Record<string, unknown>[];
  recentSessions: Record<string, unknown>[];
  activeSessions: Record<string, unknown>[];
  devices: MenubarDevice[];
  /** Who is signed in on this machine; see {@link MenubarMe}. */
  me: MenubarMe | null;
  /** AGI Menu preferences (PHNX-3999) by full `menubar.menu.*` name with the EFFECTIVE value
   * (stored, else default). `defaultProject` is omitted when unset. Writes stay `agents config
   * set/unset`. Scalars only: one array would fail every shipped menu's snapshot decode. */
  menuPreferences: Record<string, unknown>;
  /** List-valued `menubar.menu.*` preferences (pinned projects, tab order, hidden tabs), same
   * keying and default rule. A separate field so a menu predating list preferences ignores it
   * instead of failing to decode the snapshot. */
  menuListPreferences: Record<string, string[]>;
  watchdog: {
    enabled: boolean;
    lastTick: Pick<WatchdogTickResult, 'didNudge' | 'counts'> | null;
  };
}

/** The effective AGI Menu preferences map: each `menubar.menu.*` key's stored value, or its
 * registered default. A key with neither (only `defaultProject`) is omitted so the native app
 * keeps its own default. */
export function buildMenuPreferences(): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [name, value] of effectiveMenuPreferences()) {
    if (!Array.isArray(value)) out[name] = value;
  }
  return out;
}

/** The list-valued AGI Menu preferences, effective values, for `menuListPreferences`. */
export function buildMenuListPreferences(): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const [name, value] of effectiveMenuPreferences()) {
    if (Array.isArray(value)) out[name] = value.map(String);
  }
  return out;
}

function effectiveMenuPreferences(): Array<[string, unknown]> {
  const out: Array<[string, unknown]> = [];
  for (const prop of MENUBAR_MENU_PROPERTIES) {
    const name = `menubar.menu.${prop}`;
    const entry = getConfigValue(name);
    const value = entry.value !== undefined ? entry.value : entry.spec.defaultValue;
    if (value === undefined) continue; // unset defaultProject — no default to emit
    out.push([name, value]);
  }
  return out;
}

/** The full registered-device roster for the menu bar, from the local registry only (no ssh, no
 * stats probe), cheap enough to ride the 3-minute snapshot poll. */
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

/** Projects one cached DeviceStats row into the snapshot shape, or `null` with no reading. `??
 * null`, not a default: an absent number means "not observed"; 0 would look like a real idle box
 * or full disk. */
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
  // Started first so a due `gh` refresh (at most daily, capped at 5 s) overlaps
  // the synchronous reads below instead of following them.
  const viewerRead = cachedViewer();
  const [routines, recent, devices, viewer] = await Promise.all([
    Promise.resolve(buildRoutineListJson()),
    Promise.resolve(querySessions({ limit: 40, skipExistenceCheck: true })),
    buildMenubarDevices(),
    viewerRead,
  ]);
  const active = readActiveSessionsCache('local');
  const rawSessions = active?.sessions ?? [];
  // The raw cache is never filtered at write time (RUSH-2336) and the daemon's warm-tick never
  // stamps `machine`. Stamp self here (this IS the 'local' scope), then apply the ONE canonical
  // bare-active selector so no dead/queued or unverified-liveness row shows.
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
    me: resolveMenubarMe(readSession(), viewer),
    menuPreferences: buildMenuPreferences(),
    menuListPreferences: buildMenuListPreferences(),
    watchdog: {
      enabled: getConfigValue('watchdog.enabled').value === true,
      lastTick: (() => {
        const tick = readLastWatchdogTick();
        return tick ? { didNudge: tick.didNudge, counts: tick.counts } : null;
      })(),
    },
  };
}
