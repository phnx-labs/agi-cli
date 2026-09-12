/**
 * Device picker for `agents run <agent>@` (PHNX-4083).
 *
 * The menu behind the trailing-`@` form: every registered fleet device,
 * rendered from files the daemon already keeps on disk — the SSH device
 * registry, the cached fleet stats (`.fleet-stats.json`), the fleet-synced
 * device docs (roles + descriptions), and the fleet-synced account catalog.
 *
 * This module NEVER probes: no SSH, no network, no re-fetch of stale rows.
 * `loadFleetStats` re-probes rows older than 3 minutes over SSH, which is the
 * multi-second hang a mid-run menu cannot afford; the whole point here is that
 * the picker renders the last cached fleet state, honestly aged ("fleet state
 * as of 2 min ago"), instead of re-deriving it live.
 *
 * PR 2 wires this into `agents run`; this module ships the data + menu only.
 */
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

/** One row of the menu, already resolved from disk. Pure data so ordering is testable. */
export interface RunDeviceRow {
  name: string;
  platform?: string;               // 'macos' | 'linux' | 'windows' | undefined
  isLocal: boolean;                // this machine
  online: 'online' | 'offline' | 'unknown';
  role?: string;                   // configured device role: 'worker' | 'personal' | 'desktop' | … (undefined when none)
  description?: string;            // the registry's free-text description, if any
  loadPercent?: number;
  memPercent?: number;
  headroom: Headroom;              // 'idle' | 'light' | 'busy' | 'loaded' | 'unknown'
  statsFetchedAt?: number;         // ms epoch of the cached stats row
  lastSeenAt?: string;             // ISO, for offline rows (registry reachability.checkedAt or tailscale lastSeen)
  hasAccount?: boolean;            // undefined = unknown; true/false when an account label was given and the catalog knows
}

export interface RunDeviceChoice {
  name: string;                    // rendered line: name · platform · this machine|online|offline · headroom · NN% load · NN% mem · role · ✓ acct|– acct
  value: string;                   // device name
  disabled?: boolean | string;     // offline rows: 'offline since HH:MM' (string is what @inquirer shows)
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

/** 'HH:MM' (local) from an ISO timestamp; the raw string when it does not parse. */
function formatHourMinute(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
}

/**
 * Pure. Ordering: this machine first; then online rows by headroom (idle,
 * light, busy, loaded, unknown) then loadPercent ascending then name; then
 * unknown-state rows; then offline rows, disabled with the last-seen time.
 *
 * `accountLabel` renders the ✓/– account mark on rows whose `hasAccount` the
 * catalog answered; without it the mark is omitted (hasAccount stays on the
 * row for the caller either way).
 */
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

/**
 * The catalog's per-device answer for one account label, straight off the
 * fleet-synced shared state (the same rows `agents view` renders): the daemon
 * on each box publishes an auth verdict per registered account, and absence of
 * a verdict row on a publishing box means the account is not provisioned
 * there. A box that publishes no account rows at all (an older release) cannot
 * be answered for — its devices stay `undefined`, never guessed.
 */
function resolveAccountDevices(
  agent: AgentId,
  accountLabel: string,
): { byDevice: Map<string, boolean>; publishing: Set<string> } | undefined {
  const account = listNativeAccounts(readMeta()).find(
    (row) => row.agent === agent && (row.name === accountLabel || row.id === accountLabel),
  );
  if (!account) return undefined; // the catalog has no such account — it cannot answer for any device
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

/**
 * Reads devices.yaml + the cached fleet stats + configured roles + (optionally)
 * whether `accountLabel` exists on each box. ZERO SSH, zero network, never
 * re-probes. Returns the rows and the age of the newest stats row (undefined
 * when no cache).
 */
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

/** Human age for the prompt's "fleet state as of …" note: 'just now', '2 min ago', '3 h ago', … */
function formatSnapshotAge(ageMs: number): string {
  if (ageMs < 45_000) return 'just now';
  if (ageMs < 90_000) return '1 min ago';
  if (ageMs < 3_600_000) return `${Math.round(ageMs / 60_000)} min ago`;
  if (ageMs < 86_400_000) return `${Math.round(ageMs / 3_600_000)} h ago`;
  return `${Math.round(ageMs / 86_400_000)} d ago`;
}

/**
 * Interactive menu. Off a TTY: fail loud with the non-interactive forms,
 * exactly like the account picker. Prompt message: `Select a device for this
 * run (fleet state as of <age>):` where <age> is e.g. '2 min ago', or
 * `Select a device for this run (no cached fleet state):`. Returns the device
 * name, or null when the user cancels (Esc/Ctrl-C) — a cancel launches
 * nothing. Throws when the registry has no devices at all (the message names
 * `agents devices add`).
 */
export async function pickRunDevice(opts: { agent: AgentId; accountLabel?: string }): Promise<string | null> {
  // An empty registry is wrong on every terminal, so it is judged before the
  // TTY gate: "register a device" is the useful answer, not "need a TTY".
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
