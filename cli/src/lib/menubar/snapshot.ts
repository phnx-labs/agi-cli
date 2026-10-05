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

interface MenubarDevice {
  name: string;
  platform: string;
  formFactor: string;
  interactive: boolean;
  isLocal: boolean;
  preferred: boolean;
  role: string;
  autoEligible: boolean;
  stats: MenubarDeviceStats | null;
}

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

export interface MenubarMe {
  name: string | null;
  email: string | null;
  github: string | null;
  avatarUrl: string | null;
  avatarSource: 'phoenix' | 'github' | null;
}

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
  cliVersion: string;
  routines: Record<string, unknown>[];
  recentSessions: Record<string, unknown>[];
  activeSessions: Record<string, unknown>[];
  devices: MenubarDevice[];
  me: MenubarMe | null;
  menuPreferences: Record<string, unknown>;
  menuListPreferences: Record<string, string[]>;
  watchdog: {
    enabled: boolean;
    lastTick: Pick<WatchdogTickResult, 'didNudge' | 'counts'> | null;
  };
}

export function buildMenuPreferences(): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [name, value] of effectiveMenuPreferences()) {
    if (!Array.isArray(value)) out[name] = value;
  }
  return out;
}

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
    if (value === undefined) continue;
    out.push([name, value]);
  }
  return out;
}

async function buildMenubarDevices(): Promise<MenubarDevice[]> {
  const reg = await loadDevices();
  const roster = Object.keys(reg);
  const prefs = loadAutoLaunchPreferences(roster);
  const roles = listConfiguredDeviceRoles(roster);
  const autoEligible = new Set(filterAutoPool(roster, { roles, autoLaunch: prefs }));
  const stats = readStatsCache();
  const interactiveHost = getConfigValue('interactive.host').value as string | undefined;
  const self = machineId();
  return roster
    .sort()
    .map((name) => ({
      name,
      platform: reg[name].platform,
      formFactor: (getConfigValue('formFactor', { device: name }).value as string | undefined) ?? 'unknown',
      interactive: name === interactiveHost,
      isLocal: name === self,
      preferred: prefs[name]?.preferred === true,
      role: roles[name] ?? 'unknown',
      autoEligible: autoEligible.has(name),
      stats: projectDeviceStats(stats[name]),
    }));
}

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

export async function computeMenubarSnapshot(): Promise<MenubarSnapshot> {
  migrateMenubarPreferencesFromUserDefaults();
  const viewerRead = cachedViewer();
  const [routines, recent, devices, viewer] = await Promise.all([
    Promise.resolve(buildRoutineListJson()),
    Promise.resolve(querySessions({ limit: 40, skipExistenceCheck: true })),
    buildMenubarDevices(),
    viewerRead,
  ]);
  const active = readActiveSessionsCache('local');
  const rawSessions = active?.sessions ?? [];
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
