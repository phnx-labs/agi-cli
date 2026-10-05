import { select } from '@inquirer/prompts';
import type { AgentId } from '../lib/types.js';
import { headroom, type Headroom } from '../lib/devices/health.js';
import { loadDevicesSync } from '../lib/devices/registry.js';
import { readStatsCache } from '../lib/devices/stats-cache.js';
import { deviceOnlineState } from '../lib/devices/reachability.js';
import { isSelfHost } from '../lib/devices/self-host.js';
import { normalizeHost } from '../lib/machine-id.js';
import { localMachineId } from '../lib/origin-machine.js';
import { listConfiguredDeviceRoles, readDeviceConfigValues } from '../lib/device-config.js';
import { listNativeAccounts } from '../lib/account-registry.js';
import { readSharedAccountVerdicts } from '../lib/account-catalog.js';
import { readMeta } from '../lib/state.js';
import { isInteractiveTerminal, isPromptCancelled, requireInteractiveSelection } from './utils.js';

export interface RunDeviceRow {
  name: string;
  platform?: string;
  isLocal: boolean;
  online: 'online' | 'offline' | 'unknown';
  role?: string;
  description?: string;
  loadPercent?: number;
  memPercent?: number;
  headroom: Headroom;
  statsFetchedAt?: number;
  lastSeenAt?: string;
  hasAccount?: boolean;
}

interface RunDeviceChoice {
  name: string;
  value: string;
  disabled?: boolean | string;
}

const HEADROOM_ORDER: Record<Headroom, number> = {
  idle: 0,
  light: 1,
  busy: 2,
  loaded: 3,
  unknown: 4,
};

function formatPercentCell(value: number | undefined, suffix: string): string {
  return value === undefined ? '—' : `${Math.round(value)}% ${suffix}`;
}

function formatHourMinute(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
}

export function buildRunDeviceChoices(rows: RunDeviceRow[], accountLabel?: string): RunDeviceChoice[] {

  const byHeadroomLoadName = (a: RunDeviceRow, b: RunDeviceRow): number =>
    HEADROOM_ORDER[a.headroom] - HEADROOM_ORDER[b.headroom]
    || (a.loadPercent ?? Number.POSITIVE_INFINITY) - (b.loadPercent ?? Number.POSITIVE_INFINITY)
    || a.name.localeCompare(b.name);

  const local = rows.filter((row) => row.isLocal);
  const online = rows.filter((row) => !row.isLocal && row.online === 'online').sort(byHeadroomLoadName);
  const unknownState = rows.filter((row) => !row.isLocal && row.online === 'unknown').sort(byHeadroomLoadName);
  const offline = rows
    .filter((row) => !row.isLocal && row.online === 'offline')
    .sort((a, b) => a.name.localeCompare(b.name));
  const ordered = [...local, ...online, ...unknownState, ...offline];

  const nameWidth = Math.max(0, ...ordered.map((row) => row.name.length));
  const platformWidth = Math.max(0, ...ordered.map((row) => row.platform?.length ?? 0));
  const statusWidth = Math.max(0, ...ordered.map((row) => (row.isLocal ? 'this machine' : row.online).length));
  const headroomWidth = Math.max(0, ...ordered.map((row) => row.headroom.length));
  const loadWidth = Math.max(0, ...ordered.map((row) => formatPercentCell(row.loadPercent, 'load').length));
  const memWidth = Math.max(0, ...ordered.map((row) => formatPercentCell(row.memPercent, 'mem').length));

  return ordered.map((row) => {
    const account = accountLabel !== undefined && row.hasAccount !== undefined
      ? `${row.hasAccount ? '✓' : '–'} ${accountLabel}`
      : undefined;
    const name = [
      row.name.padEnd(nameWidth),
      (row.platform ?? '').padEnd(platformWidth),
      (row.isLocal ? 'this machine' : row.online).padEnd(statusWidth),
      row.headroom.padEnd(headroomWidth),
      formatPercentCell(row.loadPercent, 'load').padEnd(loadWidth),
      formatPercentCell(row.memPercent, 'mem').padEnd(memWidth),
      row.role,
      account,
    ].filter((segment): segment is string => segment !== undefined && segment !== '').join(' · ');
    return {
      name: name.trimEnd(),
      value: row.name,
      ...(row.online === 'offline'
        ? { disabled: row.lastSeenAt ? `offline since ${formatHourMinute(row.lastSeenAt)}` : 'offline' }
        : {}),
    };
  });
}

function resolveAccountDevices(
  agent: AgentId,
  accountLabel: string,
): { byDevice: Map<string, boolean>; publishing: Set<string> } | undefined {
  const account = listNativeAccounts(readMeta()).find(
    (row) => row.agent === agent && (row.name === accountLabel || row.id === accountLabel),
  );
  if (!account) return undefined;
  const shared = readSharedAccountVerdicts();
  const publishing = new Set<string>();
  for (const rows of shared.values()) {
    for (const row of rows) publishing.add(normalizeHost(row.device));
  }
  const byDevice = new Map<string, boolean>();
  for (const row of shared.get(`${agent}:${account.id}`) ?? []) {
    byDevice.set(normalizeHost(row.device), row.verdict !== 'missing');
  }
  return { byDevice, publishing };
}

export function readRunDeviceRows(opts: { agent: AgentId; accountLabel?: string }): { rows: RunDeviceRow[]; snapshotAgeMs?: number } {

  const registry = loadDevicesSync();
  const statsCache = readStatsCache();
  const names = Object.keys(registry);
  const roles = listConfiguredDeviceRoles(names);
  const local = normalizeHost(localMachineId());
  const accountDevices = opts.accountLabel
    ? resolveAccountDevices(opts.agent, opts.accountLabel)
    : undefined;

  let newestFetchedAt: number | undefined;
  for (const stats of Object.values(statsCache)) {
    if (newestFetchedAt === undefined || stats.fetchedAt > newestFetchedAt) newestFetchedAt = stats.fetchedAt;
  }
  const snapshotAgeMs = newestFetchedAt === undefined ? undefined : Math.max(0, Date.now() - newestFetchedAt);

  const rows: RunDeviceRow[] = names.map((name) => {
    const profile = registry[name];
    const stats = statsCache[name];
    const online = deviceOnlineState(profile, stats);
    const config = readDeviceConfigValues(name);
    const description = typeof config.description === 'string' ? config.description : undefined;
    const host = normalizeHost(name);
    return {
      name,
      platform: profile.platform === 'unknown' ? undefined : profile.platform,
      isLocal: isSelfHost(name) || host === local,
      online,
      role: roles[name],
      description,
      loadPercent: stats?.loadPercent,
      memPercent: stats?.memPercent,
      headroom: headroom(stats),
      statsFetchedAt: stats?.fetchedAt,
      lastSeenAt: online === 'offline'
        ? profile.reachability?.checkedAt ?? profile.tailscale?.lastSeen
        : undefined,
      hasAccount: accountDevices
        ? accountDevices.publishing.has(host)
          ? accountDevices.byDevice.get(host) ?? false
          : undefined
        : undefined,
    };
  });
  return { rows, snapshotAgeMs };
}

function formatSnapshotAge(ageMs: number): string {
  if (ageMs < 45_000) return 'just now';
  if (ageMs < 90_000) return '1 min ago';
  if (ageMs < 3_600_000) return `${Math.round(ageMs / 60_000)} min ago`;
  if (ageMs < 86_400_000) return `${Math.round(ageMs / 3_600_000)} h ago`;
  return `${Math.round(ageMs / 86_400_000)} d ago`;
}

export async function pickRunDevice(opts: { agent: AgentId; accountLabel?: string }): Promise<string | null> {
  const { rows, snapshotAgeMs } = readRunDeviceRows(opts);
  if (rows.length === 0) {
    throw new Error('No devices are registered. Add one with: agents devices add <name>');
  }

  if (!isInteractiveTerminal()) {
    requireInteractiveSelection('Selecting a device', [
      `agents run ${opts.agent} --device <name>`,
      'agents devices',
    ]);
  }

  const choices = buildRunDeviceChoices(rows, opts.accountLabel);
  try {
    return await select({
      message: snapshotAgeMs !== undefined
        ? `Select a device for this run (fleet state as of ${formatSnapshotAge(snapshotAgeMs)}):`
        : 'Select a device for this run (no cached fleet state):',
      choices,
      loop: false,
    });
  } catch (err) {
    if (isPromptCancelled(err)) return null;
    throw err;
  }
}
