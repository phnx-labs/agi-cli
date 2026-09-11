/**
 * `agents devices` (registry) + `agents ssh` (smart wrapper).
 *
 * `agents devices` keeps a registry of SSH device profiles — platform, login
 * user, address, and auth — self-populated from `tailscale status --json`.
 * `agents ssh <name>` then connects through one hardened path: preflight
 * (offline → fail fast instead of a 2-minute hang), platform-aware exec
 * (PowerShell on Windows), and password-from-bundle auth via an askpass shim.
 * Rendering the registry to an ssh_config include also lets plain ssh / scp /
 * rsync / `agents sessions --device` resolve the same logical names.
 */

import type { Command } from 'commander';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import chalk from 'chalk';
import ora from 'ora';
import { getCliVersion } from '../lib/version.js';
import { readAndResolveBundleEnv } from '../lib/secrets-client.js';
import { machineId } from '../lib/session/sync/config.js';
import { assertRegistrableDeviceName } from '../lib/devices/registry.js';
import { isDeviceAuto, resolveDeviceAffinity } from '../lib/smart-launch.js';
import {
  isDeviceInteractive,
  resolveInteractiveDevice,
  interactiveUnsetError,
} from '../lib/devices/interactive-host.js';
import { registerFleetCaptureCommand } from './fleet-capture.js';
import { registerFleetApplyAlias } from './apply.js';
import {
  addIgnored,
  getDevice,
  loadDevices,
  loadIgnored,
  loadIgnoredEntries,
  removeDevice,
  removeIgnored,
  upsertDevice,
  writeReachability,
  type DeviceAuthMethod,
  type DevicePlatform,
  type DeviceProfile,
  type DeviceRegistry,
  type IgnoredDeviceEntry,
} from '../lib/devices/registry.js';
import { resolveDeviceProfile } from '../lib/devices/resolve-profile.js';
import { collectReachabilityWriteBacks, deviceOnlineState } from '../lib/devices/reachability.js';
import {
  nodeToDeviceInput,
  parseTailscaleStatus,
  tailscaleStatusJson,
} from '../lib/devices/tailscale.js';
import { defaultPickerChecked, localLoginUser, planDeviceReconciliation, runDeviceSync, withDefaultUser } from '../lib/devices/sync.js';
import { resolveDeviceTarget, splitUserHost } from '../lib/devices/resolve-target.js';
import { deriveMirroredCwd } from '../lib/project-root.js';
import { clearPendingSentinel } from '../lib/devices/pending.js';
import { getDeviceDiscoveryStatus, setDeviceDiscoveryStatus } from '../lib/devices/discovery-policy.js';
import { isInteractiveTerminal, isPromptCancelled } from './utils.js';
import { hostNameFor, renderSshConfig } from '../lib/devices/ssh-config.js';
import {
  ASKPASS_BUNDLE_ENV,
  ASKPASS_KEY_ENV,
  ASKPASS_AGENT_ONLY_ENV,
  buildSshInvocation,
  deviceIdentityArgs,
  fleetDialTarget,
  isAgentsBrowserDrive,
  markFleetRemote,
  writeAskpassShim,
} from '../lib/devices/connect.js';
import { ensureManagedKnownHostsDir, isHostPinned } from '../lib/devices/known-hosts.js';
import { shouldSyncTerminfo, syncTerminfoToDevice, terminfoHostKey } from '../lib/devices/terminfo.js';
import {
  fanOutDevices,
  fleetHealthSkip,
  planFleetTargets,
  remoteFleetTargets,
  runFleet,
  runOnDevice,
  runLocalCommand,
  skipLabel,
  upgradeCommand,
  type FanOutDeviceTarget,
  type FleetRunResult,
} from '../lib/devices/fleet.js';
import {
  isRolloutSuccess,
  verifyFleetRollout,
  type RolloutVerification,
} from '../lib/devices/rollout-verify.js';
import {
  fleetCapacity,
  fmtBytes,
  headroom,
  type DeviceStats,
  type Headroom,
} from '../lib/devices/health.js';
import {
  buildFleetHealthReport,
  renderFleetMatrix,
  renderFleetSummary,
  renderFleetWarnings,
  type FleetHealthRow,
} from '../lib/devices/health-report.js';
import { isFreshDeviceStats, loadFleetStats, readStatsCache } from '../lib/devices/stats-cache.js';
import { collectLocalFleetInventory } from '../lib/devices/fleet-inventory.js';
import { checkSyncStatus, countOrphans } from '../lib/drift.js';
import { checkAllClis } from '../lib/teams/agents.js';
import { buildRemoteAgentsInvocation } from '../lib/hosts/remote-cmd.js';
import { listTasks, resolveTaskRef } from '../lib/hosts/tasks.js';
import { reconcileRunningTasks } from '../lib/hosts/reconcile.js';
import { stopDispatchedTask } from '../lib/hosts/dispatch.js';
import { stringWidth, stripAnsi, terminalWidth, truncateToWidth } from '../lib/session/width.js';
import { sshExec, sshExecAsync, SSH_OPTS } from '../lib/ssh-exec.js';
import { ALL_AGENT_IDS } from '../lib/agents.js';
import type { AgentId } from '../lib/types.js';
import {
  collectLocalHarnessInventory,
  groupByAccount,
  renderAccountsMatrix,
  renderHarnessMatrix,
  type HarnessRow,
  type HostHarnessResult,
} from '../lib/devices/harness-inventory.js';
import { usageErrorForDisplay } from '../lib/accounting/usage.js';
import { crabboxList, crabboxFind, crabboxSshArgv, type CrabboxBox } from '../lib/crabbox/cli.js';
import { boxAddress, boxStatus, fmtIdleShort, fmtExpiresShort, registerLeaseCommand } from './lease.js';
import { registerSnapshotCommand } from './snapshot.js';
import {
  authCellColor,
  formatCheckedAge,
  isDeadVerdict,
  readAuthHealthCache,
  summarizeHostAuth,
  summarizeVerdicts,
  verdictColor,
  verdictLabel,
  writeFleetAuthRows,
  type AuthCellColor,
  type AuthProbeRow,
  type VerdictSummary,
} from '../lib/auth-health.js';
import { runFleetLogin, type LoginStatus } from '../lib/fleet/remote-login.js';
import {
  getConfigValue,
  listConfig,
  setConfigValue,
  unsetConfigValue,
  configKeySpec,
  autoPoolMode,
  configuredDeviceRole,
  listConfiguredDeviceRoles,
  setConfiguredDeviceRole,
  type ConfigKeySpec,
  type ConfigEntry,
  type ConfiguredDeviceRole,
} from '../lib/device-config.js';
import { filterAutoPool, listWorkerDevices } from '../lib/devices/pool.js';
import { registerCommandGroups, setHelpSections } from '../lib/help.js';
import { isSelfHost } from '../lib/devices/self-host.js';
import {
  collectHeldWorktrees,
  collectHeldWorktreesUnder,
  summarizeHeld,
  aggregateHeld,
  pushStrandedBranch,
  type HeldWorktree,
  type HeldBucket,
  type DeviceHeld,
} from '../lib/worktree/held.js';

/** One-line summary of a device for `list`. `isSelf` marks the machine this
 * command is running on so it stands out from the rest of the tailnet.
 * `isInteractive` marks the configured interactive host (`devices config <name> interactive.host`). */
function deviceSummary(
  d: DeviceProfile,
  isSelf = false,
  stats?: DeviceStats,
  isInteractive = false,
  roles?: Record<string, ConfiguredDeviceRole>,
): string {
  d = resolveDeviceProfile(d);
  const addr = hostNameFor(d) ?? chalk.gray('no address');
  // Prefer a fresh live verdict (this run's probe, else the written-back
  // reachability) over the stale tailscale.online snapshot (RUSH-1965).
  const state = deviceOnlineState(d, stats);
  const online =
    state === 'online'
      ? chalk.green('online')
      : state === 'offline'
        ? chalk.gray('offline')
        : chalk.gray('unknown');
  const reach = state === 'online' && d.tailscale && !d.tailscale.direct ? chalk.yellow(' (relayed)') : '';
  const marker = isSelf ? chalk.cyan('▸ ') : '  ';
  const name = isSelf ? chalk.bold.cyan(d.name.padEnd(16)) : chalk.bold(d.name.padEnd(16));
  const here = isSelf ? chalk.cyan('  ← this machine') : '';
  // `roles` defaults to a single-device roster so a fleet-wide `role` default
  // still reaches this device even when it has no per-device doc of its own.
  const roleMap = roles ?? listConfiguredDeviceRoles([d.name]);
  // `personal` already means "the interactive box you sit at", so the star would
  // just repeat it — show it only when the interactive host is NOT a personal box
  // (e.g. an unmarked or worker box deliberately pinned as the artifact target).
  const interactive = isInteractive && roleMap[d.name] !== 'personal' ? chalk.yellow('  ★ interactive') : '';
  const role = roleTag(d.name, roleMap);
  return `${marker}${name} ${String(d.platform).padEnd(8)} ${(d.user ? d.user + '@' : '') + addr}  ${online}${reach}${here}${interactive}${role}`;
}

/** The fleet-wide role mark, rendered for a device row. Empty when unmarked —
 * an unmarked device is the common case and must not add a column of noise. */
function roleTag(name: string, roles: Record<string, ConfiguredDeviceRole>): string {
  const role = roles[name];
  if (!role) return '';
  if (role === 'worker') return chalk.green('  worker');
  if (role === 'personal') return chalk.yellow('  personal');
  if (role === 'desktop') return chalk.cyan('  desktop');
  return '';
}

const HEADROOM_BADGE: Record<Headroom, string> = {
  idle: chalk.green('○ idle'),
  light: chalk.green('● light'),
  busy: chalk.yellow('● busy'),
  loaded: chalk.red('● loaded'),
  unknown: chalk.gray('· —'),
};

/** A right-aligned percentage cell, colored by severity (green/yellow/red). */
function pctCell(v: number | undefined, width: number): string {
  if (v === undefined) return chalk.gray('—'.padStart(width));
  const s = `${Math.round(v)}%`.padStart(width);
  if (v < 40) return chalk.green(s);
  if (v < 75) return chalk.yellow(s);
  return chalk.red(s);
}

/** Floor for the `spec` column; the real width is measured from the rows.
 *
 * A fixed width cannot work here: `fmtBytes` emits an optional decimal, so a
 * spec string runs from `8c 16G 256G` (11) to `10c 23.5G 460G` (14) depending
 * purely on the hardware behind it. Anything narrower than the widest row
 * pushes load/mem/disk/headroom out of alignment row-to-row AND against the
 * header — which defeats the scannability this column exists for. */
const SPEC_WIDTH_MIN = 12;

/** The static hardware as one compact cell — `12c 64G 1T`: cores, total RAM,
 * total root disk via fmtBytes. `—` covers two cases: no probe has ever seen
 * the box, or the probe answered but yielded no usable core count (`parseNcpu`
 * finding none, or the Windows `ncpu` group failing the finite-and-positive
 * check) — the cell is keyed on `ncpu` because a spec string without it would
 * read as a machine with zero cores.
 *
 * Deliberately NOT gated on `reachable`: hardware does not change while a
 * machine is down, so an offline device keeps rendering the spec from its last
 * successful probe (`retainHardwareFacts`, RUSH-3096) rather than blanking a
 * fact that is still true. The volatile columns beside it — load, mem, disk
 * used — stay `—`, and `fleetCapacity` still counts only reachable boxes, so
 * a down machine never contributes to usable capacity.
 *
 * Unpadded; {@link renderDeviceTable} pads to the measured column width. */
function specText(stats: DeviceStats | undefined): string {
  if (!stats?.ncpu) return '—';
  return `${stats.ncpu}c ${fmtBytes(stats.memTotalBytes)} ${fmtBytes(stats.diskTotalBytes)}`;
}

/** The widest spec string across the rows actually being rendered, floored at
 * SPEC_WIDTH_MIN so a short fleet still lines up with the header. */
function specColumnWidth(names: string[], statsMap: Map<string, DeviceStats>): number {
  return Math.max(SPEC_WIDTH_MIN, ...names.map((n) => stringWidth(specText(statsMap.get(n)))));
}

/** Colour + pad one spec cell to the measured column width. */
function specCell(stats: DeviceStats | undefined, width: number): string {
  const text = specText(stats);
  return (text === '—' ? chalk.gray : chalk.greenBright)(text.padEnd(width));
}

/** The one-line `description` config value per device (absent when unset). */
function listDeviceDescriptions(names: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const n of names) {
    const v = getConfigValue('description', { device: n }).value;
    if (typeof v === 'string' && v.length > 0) out[n] = v;
  }
  return out;
}

/**
 * Fit a device row to the terminal width. The description is the FIRST thing
 * to truncate, then the role tag; the fixed columns (device, platform, spec,
 * load/mem/disk numbers, headroom, and the ▸/★/←/relay markers) never
 * truncate. `role` and `desc` arrive fully rendered (ansi + leading gap).
 */
function fitDeviceRow(fixed: string, role: string, desc: string, width: number): string {
  const w = (s: string) => stringWidth(stripAnsi(s));
  let over = w(fixed) + w(role) + w(desc) - width;
  if (over > 0 && desc) {
    // `desc` is '  ' + gray(text) — truncate the text, keep the gap.
    const text = stripAnsi(desc).slice(2);
    const budget = w(text) - over;
    desc = budget > 0 ? '  ' + chalk.gray(truncateToWidth(text, budget)) : '';
    over = w(fixed) + w(role) + w(desc) - width;
  }
  // A partial role word ("work…") reads as a bug — when it can't fit whole,
  // it drops entirely. The numbers are never touched.
  if (over > 0 && role) role = '';
  return fixed + role + desc;
}

/**
 * Render the device list. When `statsMap` is provided, resource columns are
 * appended — a `spec` cell (cores / total RAM / total disk), normalized load,
 * memory and disk-used percentages, a headroom badge, and (in `full` mode)
 * free/total memory — with the per-device role and `description` riding the
 * tail, so it's obvious which boxes have room and what each box is for.
 * Without it (probe skipped) the classic reachability line is used. A fleet
 * capacity summary is appended whenever stats were gathered.
 */
export function renderDeviceTable(
  reg: DeviceRegistry,
  names: string[],
  self: string | undefined,
  statsMap?: Map<string, DeviceStats>,
  full = false,
  interactiveHost?: string,
  opts: { width?: number; ignoredCount?: number } = {},
): string[] {
  if (!statsMap) {
    const roles = listConfiguredDeviceRoles(names);
    return names.map((n) => deviceSummary(reg[n], n === self, undefined, n === interactiveHost, roles));
  }

  const deviceRoles = listConfiguredDeviceRoles(names);
  const specWidth = specColumnWidth(names, statsMap);
  const descriptions = listDeviceDescriptions(names);
  const width = opts.width ?? terminalWidth();
  const lines: string[] = [];
  const head =
    '  ' +
    chalk.gray('device'.padEnd(16)) +
    chalk.gray('platform'.padEnd(8)) +
    ' ' +
    chalk.gray('spec'.padEnd(specWidth)) +
    chalk.gray('load'.padStart(5)) +
    chalk.gray('mem'.padStart(6)) +
    chalk.gray('disk'.padStart(5)) +
    (full ? '  ' + chalk.gray('free/total'.padEnd(12)) : '') +
    '  ' +
    chalk.gray('headroom') +
    '  ' +
    chalk.gray('role') +
    '  ' +
    chalk.gray('description');
  lines.push(head);

  for (const name of names) {
    // Effective profile: the operator's central config (ssh.*/platform/user)
    // overlays the discovery record, so the table shows what would be dialed.
    const d = resolveDeviceProfile(reg[name]);
    const isSelf = name === self;
    const marker = isSelf ? chalk.cyan('▸ ') : '  ';
    const label = isSelf ? chalk.bold.cyan(name.padEnd(16)) : chalk.bold(name.padEnd(16));
    const plat = String(d.platform).padEnd(8);
    const stats = statsMap.get(name);
    const role = roleTag(name, deviceRoles);
    const desc = descriptions[name] ? '  ' + chalk.gray(descriptions[name]) : '';
    // Prefer this run's live probe, then the written-back verdict, over the
    // stale tailscale.online snapshot — so a reachable box never renders
    // "offline" while its live load/mem sit one column over (RUSH-1965).
    const offline = deviceOnlineState(d, stats) === 'offline';
    if (offline) {
      // The spec cell rides the offline row: hardware is what the box IS, not
      // what it is doing, so it stays legible while the machine is down
      // (RUSH-3096). The live columns are omitted rather than dashed — there is
      // no current load/mem/disk to report for a box that did not answer.
      //
      // The explicit gap is load-bearing: `specCell` pads to the MEASURED
      // column width, so the widest spec on the fleet pads to nothing and the
      // marker would collide with it ("455Goffline"). An online row gets its
      // separation for free from `pctCell`'s right-alignment; this one has no
      // numeric cell to lean on.
      lines.push(
        fitDeviceRow(
          `${marker}${label}${plat} ${specCell(stats, specWidth)}  ${chalk.gray('offline')}`,
          role,
          desc,
          width,
        ),
      );
      continue;
    }
    const relay = !isSelf && d.tailscale?.online && !d.tailscale.direct ? chalk.yellow(' relay') : '';
    const load = pctCell(stats?.loadPercent, 5);
    const mem = pctCell(stats?.memPercent, 6);
    const disk = pctCell(stats?.diskUsedPercent, 5);
    const freeTotal = full
      ? '  ' +
        (stats?.reachable && stats.memTotalBytes
          ? `${fmtBytes(stats.memFreeBytes)}/${fmtBytes(stats.memTotalBytes)}`.padEnd(12)
          : chalk.gray('—'.padEnd(12)))
      : '';
    const badge = HEADROOM_BADGE[headroom(stats)];
    const here = isSelf ? chalk.cyan('  ← this machine') : '';
    // A `personal` role already conveys "your interactive seat"; don't double-
    // render the star on it. Keep it for a non-personal pinned interactive host.
    const interactive = name === interactiveHost && deviceRoles[name] !== 'personal' ? chalk.yellow('  ★ interactive') : '';
    lines.push(
      fitDeviceRow(
        `${marker}${label}${plat} ${specCell(stats, specWidth)}${load}${mem}${disk}${freeTotal}  ${badge}${relay}${here}${interactive}`,
        role,
        desc,
        width,
      ),
    );
  }

  // Fleet capacity summary — total cores, how much RAM is free right now, and
  // total free root disk across the reachable fleet.
  const cap = fleetCapacity(statsMap.values());
  if (cap.reachable > 0) {
    const freePct = cap.memTotalBytes > 0 ? Math.round((cap.memFreeBytes / cap.memTotalBytes) * 100) : 0;
    let diskFreeBytes = 0;
    for (const s of statsMap.values()) if (s.reachable) diskFreeBytes += s.diskFreeBytes ?? 0;
    lines.push(
      chalk.gray(
        `  Fleet capacity: ${cap.cores} cores · ${fmtBytes(cap.memFreeBytes)} free / ${fmtBytes(cap.memTotalBytes)} RAM (${freePct}% free) · ${fmtBytes(diskFreeBytes)} disk free across ${cap.reachable} reachable device${cap.reachable === 1 ? '' : 's'}`,
      ),
    );
  }
  if (opts.ignoredCount) {
    lines.push(
      chalk.gray(
        `  ${opts.ignoredCount} ignored node${opts.ignoredCount === 1 ? '' : 's'} not listed — 'agents devices ignored'`,
      ),
    );
  }
  return lines;
}

/**
 * Live "Leased boxes" section for `agents devices` (F4, RUSH-1923), computed
 * from `crabboxList()` — these are ephemeral crabbox leases, NEVER written into
 * the device registry. Returns [] when crabbox is unavailable / has no creds /
 * reports no boxes, so the section is simply omitted. `nowSecs` is injected so
 * the row formatting is deterministic in tests.
 */
export function renderLeasedBoxesSection(boxes: CrabboxBox[], nowSecs: number): string[] {
  if (boxes.length === 0) return [];
  const lines: string[] = [];
  lines.push('');
  lines.push(chalk.bold('Leased boxes') + chalk.gray(' (ephemeral · via crabbox)'));
  lines.push(
    '  ' +
      chalk.gray('box'.padEnd(16)) +
      chalk.gray('class'.padEnd(10)) +
      chalk.gray('address'.padEnd(24)) +
      chalk.gray('status'.padEnd(9)) +
      chalk.gray('idle'.padEnd(12)) +
      chalk.gray('expires'),
  );
  for (const b of boxes) {
    const addr = boxAddress(b) ?? '—';
    lines.push(
      '  ' +
        chalk.cyan(b.slug.padEnd(16)) +
        (b.class ?? '?').padEnd(10) +
        addr.padEnd(24) +
        boxStatus(b).padEnd(9) +
        chalk.gray(fmtIdleShort(b, nowSecs).padEnd(12)) +
        chalk.gray(fmtExpiresShort(b, nowSecs)),
    );
  }
  lines.push(chalk.gray('  Reuse a box with `agents run --box <slug>` · stop with `agents devices lease stop <slug>`'));
  return lines;
}

/** The leased-box rows for the devices list, or [] when crabbox can't be read. */
function loadLeasedBoxesSection(): string[] {
  try {
    const boxes = crabboxList({ secretsBundle: process.env.AGENTS_LEASE_SECRETS_BUNDLE, timeoutMs: 5000 });
    return renderLeasedBoxesSection(boxes, Math.floor(Date.now() / 1000));
  } catch {
    return []; // crabbox not installed / no provider creds — omit the section
  }
}

/**
 * Whether `agents devices list` shows the "Leased boxes" section (RUSH-2190).
 * Opt-in via --all only: loading it scans the keychain for bundle credentials
 * and can raise a Touch ID sheet after the table has printed, so the default
 * list must never reach for it. --no-stats stays the hard "instant, no provider
 * calls" opt-out even when --all is passed.
 */
export function showLeasedBoxesSection(opts: { all?: boolean; stats?: boolean }): boolean {
  return opts.all === true && opts.stats !== false;
}

/**
 * `agents ssh <slug>` targeting a leased crabbox box. crabbox provisions a
 * per-lease identity key, so we ssh via crabbox's OWN emitted invocation
 * (`crabboxSshArgv`) — a raw `ssh crabbox@ip` fails publickey. Returns false when
 * `name` is not a known crabbox slug so the caller can fall through to the normal
 * "Unknown device" error.
 */
function trySshLeasedBox(name: string, cmd: string[]): boolean {
  let box: CrabboxBox | null;
  try {
    box = crabboxFind(name, { secretsBundle: process.env.AGENTS_LEASE_SECRETS_BUNDLE, timeoutMs: 5000 });
  } catch {
    return false; // crabbox unavailable — not a leased-box target
  }
  if (!box) return false;
  const sshArgv = crabboxSshArgv(name, { secretsBundle: process.env.AGENTS_LEASE_SECRETS_BUNDLE, timeoutMs: 8000 });
  if (!sshArgv) {
    console.error(chalk.red(`Leased box '${name}' is not reachable yet (status: ${boxStatus(box)}).`));
    process.exit(1);
  }
  // Crabbox ssh does not go through buildSshInvocation; stamp the same
  // consent marker so a browser drive on a leased box is gated too.
  const remoteCmd = leasedBoxRemoteCmd(cmd);
  const res = spawnSync(sshArgv[0], [...sshArgv.slice(1), ...remoteCmd], { stdio: 'inherit' });
  process.exit(res.status ?? 1);
}

/**
 * Remote argv for `agents ssh <slug>` into a leased crabbox. Crabbox ssh does
 * not go through {@link buildSshInvocation}, so this stamps the same
 * AGENTS_FLEET_REMOTE consent marker a registered-device ssh would (PHNX-3065).
 * Exported so the branch is unit-testable without a live crabbox.
 */
export function leasedBoxRemoteCmd(cmd: string[]): string[] {
  return isAgentsBrowserDrive(cmd) ? markFleetRemote(cmd, { shell: 'posix' }) : cmd;
}

/** Resolve a device or exit with a clear error. */
async function mustGetDevice(name: string): Promise<DeviceProfile> {
  const d = await getDevice(name);
  if (!d) {
    console.error(chalk.red(`Unknown device '${name}'. See 'agents devices list'.`));
    process.exit(1);
  }
  return d;
}

/**
 * Interactive `agents devices sync`: discover tailscale nodes, present a
 * checkbox pre-checked with what's already registered, and reconcile the
 * choice. Checked = registered (and un-ignored). Unchecked = removed from the
 * registry AND added to the ignore-list, so auto-discovery never re-suggests
 * it — this is the "click to register/unregister" surface, with dismissals that
 * stick.
 */
async function runInteractiveDeviceSync(): Promise<void> {
  const spinner = ora('Reading tailscale status...').start();
  let nodes;
  try {
    nodes = parseTailscaleStatus(tailscaleStatusJson());
  } catch (err: any) {
    spinner.fail(err.message);
    process.exit(1);
  }
  const [reg, ignored] = await Promise.all([loadDevices(), loadIgnored()]);
  const registered = new Set(Object.keys(reg));
  spinner.stop();

  if (nodes.length === 0) {
    console.log(chalk.gray('No tailscale nodes found.'));
    return;
  }

  const { checkbox } = await import('@inquirer/prompts');
  let selected: string[];
  try {
    selected = await checkbox({
      // Everything not already dismissed starts checked, so pressing Enter keeps
      // the fleet as-is (matching what auto-sync would register). Unchecking a
      // device removes it AND dismisses it so auto-sync never re-adds it.
      // Sharee nodes (shared in by another user) start unchecked unless already
      // registered — registering one must be a deliberate check, never the
      // default Enter.
      message: 'Your fleet — uncheck a device to remove and stop suggesting it:',
      pageSize: Math.min(nodes.length, 20),
      choices: nodes.map((n) => {
        const flags = [n.platform, n.online ? undefined : 'offline', n.sharee ? 'shared' : undefined, ignored.has(n.name) ? 'ignored' : undefined]
          .filter(Boolean)
          .join(', ');
        return { value: n.name, name: `${n.name}  ${chalk.gray(`(${flags})`)}`, checked: defaultPickerChecked(n, registered, ignored) };
      }),
    });
  } catch (err) {
    if (isPromptCancelled(err)) {
      console.log(chalk.gray('Cancelled — no changes.'));
      return;
    }
    throw err;
  }

  const byName = new Map(nodes.map((n) => [n.name, n]));
  const plan = planDeviceReconciliation(byName.keys(), selected, registered, ignored);
  const localUser = localLoginUser();
  for (const name of plan.toRegister) {
    const input = withDefaultUser(nodeToDeviceInput(byName.get(name)!), reg[name]?.user, localUser);
    await upsertDevice(name, input);
    setDeviceDiscoveryStatus(name, 'approved');
  }
  for (const name of plan.toUnignore) await removeIgnored(name);
  for (const name of plan.toRemove) await removeDevice(name);
  for (const name of plan.toIgnore) {
    await addIgnored(name);
    setDeviceDiscoveryStatus(name, 'ignored');
  }

  const parts = [
    chalk.green(`${plan.toRegister.length} registered`),
    plan.toRemove.length ? chalk.yellow(`${plan.toRemove.length} removed`) : null,
    plan.toIgnore.length ? chalk.gray(`${plan.toIgnore.length} ignored`) : null,
  ].filter(Boolean);
  console.log(parts.join(chalk.gray(' · ')));
}

/**
 * Print a per-device result table for fleet update/run.
 *
 * `verifications` is supplied only by the rollout (`agents fleet update`), which
 * re-probes what `agents` resolves to on each upgraded box. A box that upgraded
 * with `exit 0` but still resolves to another copy — the dev-install shadow of
 * RUSH-2446 — is rendered `stale` / `unverified`, counted as **not upgraded**,
 * and makes the command exit non-zero. An `exit 0` alone never reads as `ok` on
 * a rollout again.
 */
function printFleetResults(
  results: FleetRunResult[],
  verifications?: Map<string, RolloutVerification>,
): void {
  const nameW = Math.max(8, ...results.map((r) => r.name.length));
  console.log(
    chalk.bold('DEVICE'.padEnd(nameW)) + '  ' +
    chalk.bold('STATUS'.padEnd(10)) + '  ' +
    chalk.bold('DETAIL'),
  );
  let notUpgraded = 0;
  for (const r of results) {
    const verified = r.status === 'ok' ? verifications?.get(r.name) : undefined;
    if (verified && !isRolloutSuccess(verified.verdict)) notUpgraded++;
    const label =
      r.status === 'skipped' ? chalk.gray('skipped'.padEnd(10)) :
      r.status === 'failed' ? chalk.red('failed'.padEnd(10)) :
      verified === undefined ? chalk.green('ok'.padEnd(10)) :
      verified.verdict === 'on-target' ? chalk.green('ok'.padEnd(10)) :
      verified.verdict === 'unverified' ? chalk.yellow('unverified'.padEnd(10)) :
      chalk.red('stale'.padEnd(10));
    const detail =
      r.status === 'skipped' ? chalk.gray(skipLabel(r.reason as 'offline' | 'no-address')) :
      r.status === 'failed' ? chalk.red(r.detail || `exit ${r.code ?? '?'}`) :
      verified === undefined ? chalk.gray(r.code === 0 ? 'exit 0' : '') :
      verified.verdict === 'on-target' ? chalk.gray(verified.detail) :
      verified.verdict === 'unverified' ? chalk.yellow(verified.detail) :
      chalk.red(verified.detail);
    console.log(`${r.name.padEnd(nameW)}  ${label}  ${detail}`);
  }
  const failed = results.filter((r) => r.status === 'failed').length;
  const skipped = results.filter((r) => r.status === 'skipped').length;
  const ok = results.filter((r) => r.status === 'ok').length - notUpgraded;
  const parts = [`${ok} ok`, `${failed} failed`, `${skipped} skipped`];
  if (verifications) parts.splice(1, 0, `${notUpgraded} not upgraded`);
  console.log(chalk.gray(parts.join(' · ')));
  if (notUpgraded > 0) {
    console.log(chalk.yellow('A box that upgraded but still resolves elsewhere runs OLD code — remove the stale install that owns the `agents` name on that box, or reorder PATH. `agents doctor` names it.'));
  }
  if (failed > 0 || notUpgraded > 0) process.exitCode = 1;
}

interface RemoteDoctorJson {
  clis?: FleetHealthRow['clis'];
  sync?: FleetHealthRow['sync'];
  orphans?: FleetHealthRow['orphans'];
  auth?: FleetHealthRow['auth'];
  fleet?: FleetHealthRow['inventory'];
}

interface FleetStatusTarget extends FanOutDeviceTarget {
  platform?: string;
  /**
   * The address to hand `ssh` — the registry's drift-proof Tailscale dnsName/IP
   * (via {@link fleetDialTarget}), NOT the bare device name. Dialing the bare
   * name lets ssh resolve it through the user's ~/.ssh/config, where a stale
   * hand-written `Host <name>` block with a drifted LAN IP silently shadows the
   * correct entry and makes a reachable box look dead (the 60s fleet-status hang).
   */
  dialTarget: string;
  extraSshArgs?: string[];
}

async function localHealthRow(self: string, stats?: DeviceStats): Promise<FleetHealthRow> {
  return {
    name: self,
    platform: process.platform === 'darwin' ? 'macos' : process.platform,
    version: getCliVersion(),
    stats,
    clis: checkAllClis(),
    sync: checkSyncStatus(process.cwd()),
    orphans: countOrphans(),
    // Local baseline inventory for cross-device divergence (RUSH-2027) — the
    // yardstick every remote box is compared against.
    inventory: await collectLocalFleetInventory(process.cwd()),
  };
}

/** SSH into a host and read its already-computed fleet-status row (a cheap
 *  `fleet status --local --json` on the peer — NOT a fresh remote resource probe;
 *  the peer's daemon keeps that row warm). Bounded + reaped via sshExecAsync's
 *  timeout (RUSH-2114). */
async function probeRemoteFleetStatus(target: FleetStatusTarget): Promise<import('../lib/fleet-status.js').FleetStatusRow> {
  const isWin = /^win/i.test((target.platform ?? '').trim());
  const env = isWin ? undefined : { PATH: '$HOME/.agents/.cache/shims:$HOME/.local/bin:$PATH' };
  const cmd = buildRemoteAgentsInvocation(['devices', 'status', '--local', '--json'], undefined, isWin ? 'windows' : undefined, env);
  const res = await sshExecAsync(target.dialTarget, cmd, { timeoutMs: 15000, multiplex: true, extraSshArgs: target.extraSshArgs });
  if (res.code !== 0) {
    throw new Error(res.timedOut ? 'timed out' : (res.stderr.trim() || `exit ${res.code ?? 'unknown'}`));
  }
  return JSON.parse(res.stdout) as import('../lib/fleet-status.js').FleetStatusRow;
}

async function probeRemoteHealth(target: FleetStatusTarget): Promise<Omit<FleetHealthRow, 'name' | 'platform' | 'stats'>> {
  const isWin = /^win/i.test((target.platform ?? '').trim());
  const env = isWin ? undefined : { PATH: '$HOME/.agents/.cache/shims:$HOME/.local/bin:$PATH' };
  const versionCmd = buildRemoteAgentsInvocation(['--version'], undefined, isWin ? 'windows' : undefined, env);
  const versionRes = await sshExecAsync(target.dialTarget, versionCmd, { timeoutMs: 15000, multiplex: true, extraSshArgs: target.extraSshArgs });
  const version = versionRes.code === 0 ? versionRes.stdout.trim().split(/\s+/)[0] || null : null;

  const doctorCmd = buildRemoteAgentsInvocation(['doctor', '--json'], undefined, isWin ? 'windows' : undefined, env);
  const doctorRes = await sshExecAsync(target.dialTarget, doctorCmd, { timeoutMs: 30000, multiplex: true, extraSshArgs: target.extraSshArgs });
  if (doctorRes.code !== 0) {
    throw new Error(doctorRes.timedOut ? 'timed out' : (doctorRes.stderr.trim() || `exit ${doctorRes.code ?? 'unknown'}`));
  }
  const parsed = JSON.parse(doctorRes.stdout) as RemoteDoctorJson;
  return {
    version,
    clis: parsed.clis ?? {},
    sync: parsed.sync ?? [],
    orphans: parsed.orphans ?? [],
    // The remote self-reports its own cached auth rollup (fresh via its daemon),
    // so the Auth column is current without a prior fleet-wide `fleet ping`.
    // Older remotes that don't emit it fall back to this host's cache below.
    auth: parsed.auth,
    // Harness inventory (resources / agent versions / repo state) for
    // cross-device divergence detection (RUSH-2027). Undefined on an older CLI
    // that doesn't emit the `fleet` field — the comparator skips it.
    inventory: parsed.fleet,
  };
}

/** Device-layer config only (not fleet defaults), keyed by the canonical YAML key. */
function deviceConfigJson(name: string): Record<string, unknown> | undefined {
  const config: Record<string, unknown> = {};
  for (const entry of listConfig({ device: name })) {
    // The device's OWN layer only — a fleet-default value is not this
    // device's setting (the effective profile fields already carry the
    // merged view via resolveDeviceProfile).
    if (entry.source !== 'device') continue;
    config[entry.spec.yamlKey] = entry.value;
  }
  return Object.keys(config).length > 0 ? config : undefined;
}

async function runFleetStatus(opts: { json?: boolean; strict?: boolean; stats?: boolean; refresh?: boolean; live?: boolean; local?: boolean; verbose?: boolean }): Promise<void> {
  const reg = await loadDevices();
  const self = machineId();
  const forceRefresh = Boolean(opts.refresh || opts.live);

  // `--local`: the publish endpoint the read-union reads over ssh. Probe THIS
  // host only (resource stats + live-agent workload, no ssh) and print its row.
  // Publishes into the local mirror as a side effect so a same-host reader is
  // instantly warm too.
  if (opts.local) {
    const { publishLocalFleetStatus } = await import('../lib/fleet-status.js');
    const row = await publishLocalFleetStatus(self);
    if (opts.json) console.log(JSON.stringify(row, null, 2));
    else console.log(`${self}: ${row.agents.running} running agent(s), ${row.agents.live} live`);
    return;
  }
  const planned = planFleetTargets(reg);
  const probeable = planned.filter((t) => !t.skip).map((t) => t.device);
  // Cache-first: serve remote stats from the daemon-warmed cache (instant),
  // probe this machine locally, and only ssh out for missing/forced rows.
  const statsMap = opts.stats === false
    ? new Map<string, DeviceStats>()
    : (await loadFleetStats(probeable, { forceRefresh, selfName: self })).stats;

  // Persist the live probe's reachability verdict so the online/offline word is
  // read from a fresh probe, not a stale tailscale snapshot (RUSH-1965).
  // Best-effort: a registry write must never break the status render.
  await writeReachability(collectReachabilityWriteBacks(reg, statsMap)).catch(() => {});

  const rows: FleetHealthRow[] = [await localHealthRow(self, statsMap.get(self))];
  const remoteTargets: FleetStatusTarget[] = remoteFleetTargets(planned, self)
    .map((t) => ({
      name: t.device.name,
      platform: resolveDeviceProfile(t.device).platform,
      // Fail fast: gate the expensive version+doctor dials on the reachability
      // verdict the cheap stats probe already computed one step earlier. A box
      // it found unreachable skips straight to an `unreachable` row instead of
      // burning 15s+30s per box — so one genuinely-offline device can't stall
      // the matrix for ~60s (RUSH-1964). See {@link fleetHealthSkip} for why
      // this is trusted on the default path, not just under `--refresh`.
      skip: fleetHealthSkip(t.skip, statsMap.get(t.device.name)),
      dialTarget: fleetDialTarget(t.device),
      extraSshArgs: deviceIdentityArgs(t.device),
    }));
  const remote = await fanOutDevices(remoteTargets, probeRemoteHealth);
  for (const result of remote) {
    const profile = reg[result.name];
    if (result.status === 'ok' && result.value) {
      rows.push({
        name: result.name,
        platform: profile?.platform,
        stats: statsMap.get(result.name),
        ...result.value,
      });
    } else {
      rows.push({
        name: result.name,
        platform: profile?.platform,
        stats: statsMap.get(result.name),
        skipped: result.reason ? String(result.reason) : undefined,
        error: result.error,
        clis: {},
        sync: [],
        orphans: [],
      });
    }
  }

  // Auth column: remote rows already carry the host's self-reported rollup from
  // its `doctor --json`. Fill the rest (this machine; older remotes that don't
  // emit it) from this host's local cache — written by `agents fleet ping` and
  // the daemon's local refresh. A never-probed host rolls up to "—". No network.
  const authCache = readAuthHealthCache();
  for (const row of rows) {
    if (!row.auth) row.auth = summarizeHostAuth(authCache, row.name);
    // Resolve the online/offline verdict and last-seen once (RUSH-1966) so the
    // summary view reads one truth — the same `deviceOnlineState` ordering the
    // registry write-back uses — instead of re-deriving it from error/skipped.
    const profile = reg[row.name];
    if (profile) {
      row.online = deviceOnlineState(profile, statsMap.get(row.name));
      row.lastSeen = profile.tailscale?.lastSeen ?? profile.reachability?.checkedAt;
    }
  }

  // Live-agent workload (RUSH-2061): publish THIS host's row, then union peers'
  // rows cache-first. The daemon no longer probes the fleet (publish-own /
  // read-union), so cross-host counts are gathered HERE, on demand — a mirror row
  // younger than the freshness window is served without ssh; a missing/stale one
  // is read over ssh via `fleet status --local --json` (bounded + kill-on-timeout
  // through sshExecAsync/fanOutDevices, RUSH-2114). Best-effort: agent counts are
  // additive, so a failed gather never breaks the status render.
  try {
    const { publishLocalFleetStatus, readFleetStatus, writeFleetStatusRows } = await import('../lib/fleet-status.js');
    const selfRow = await publishLocalFleetStatus(self);
    const mirror = readFleetStatus();
    const now = Date.now();
    const AGENT_STATUS_STALE_MS = 3 * 60_000;
    const toRead = remoteTargets.filter((t) => {
      if (t.skip) return false;
      if (forceRefresh) return true;
      const row = mirror[t.name];
      return !row || now - row.capturedAt > AGENT_STATUS_STALE_MS;
    });
    if (toRead.length > 0) {
      const gathered = await fanOutDevices(toRead, probeRemoteFleetStatus, { perDeviceTimeoutMs: 20_000 });
      const updates: Record<string, import('../lib/fleet-status.js').FleetStatusRow> = {};
      for (const g of gathered) {
        if (g.status === 'ok' && g.value) updates[g.name] = { ...g.value, host: g.name };
      }
      if (Object.keys(updates).length > 0) writeFleetStatusRows(updates);
    }
    const union = readFleetStatus();
    for (const row of rows) {
      const r = row.name === self ? selfRow : union[row.name];
      if (r) row.agents = r.agents;
    }
  } catch {
    // best-effort — agent counts are additive to the health view
  }

  const report = buildFleetHealthReport(rows, new Date(), { self });
  if (opts.json) {
    const interactiveHost = getConfigValue('interactive.host').value as string | undefined;
    console.log(JSON.stringify({
      ...report,
      devices: report.devices.map((row) => {
        const registered = reg[row.name];
        const config = deviceConfigJson(row.name);
        return {
          ...row,
          profile: registered ? resolveDeviceProfile(registered) : { name: row.name },
          interactive: row.name === interactiveHost,
          ...(config ? { config } : {}),
        };
      }),
    }, null, 2));
  } else if (opts.verbose) {
    // Full grid: the auth/CLI/sync/version columns and the warnings rollup.
    for (const line of renderFleetWarnings(report)) console.log(line);
    console.log();
    for (const line of renderFleetMatrix(report)) console.log(line);
  } else {
    // Default: rollup + NEEDS ATTENTION + OS-grouped quiet rows + footer.
    for (const line of renderFleetSummary(report, { self })) console.log(line);
  }
  if (opts.strict && report.hasWarnings) process.exitCode = 1;
}

interface FleetPingHostResult {
  host: string;
  rows: AuthProbeRow[];
  error?: string;
  skipped?: string;
}

/** SSH into a host and run its local auth probe, returning its rows. */
async function probeRemoteAuth(target: FleetStatusTarget): Promise<AuthProbeRow[]> {
  const isWin = /^win/i.test((target.platform ?? '').trim());
  const env = isWin ? undefined : { PATH: '$HOME/.agents/.cache/shims:$HOME/.local/bin:$PATH' };
  const cmd = buildRemoteAgentsInvocation(['devices', 'ping', '--local', '--json'], undefined, isWin ? 'windows' : undefined, env);
  const res = await sshExecAsync(target.dialTarget, cmd, { timeoutMs: 15000, multiplex: true, extraSshArgs: target.extraSshArgs });
  if (res.code !== 0) {
    throw new Error(res.timedOut ? 'timed out' : (res.stderr.trim() || `exit ${res.code ?? 'unknown'}`));
  }
  const parsed = JSON.parse(res.stdout) as { host: string; rows: AuthProbeRow[] };
  return parsed.rows ?? [];
}

/**
 * Race `fanOut` against an overall wall-clock deadline (RUSH-2041).
 *
 * If `fanOut` settles first the result passes through unchanged. If the
 * deadline fires first every pending remote target is mapped to `failed` (or
 * `skipped` for pre-skipped targets), so callers always get a complete result
 * array and the command exits promptly rather than hanging.
 *
 * Exported so the unit test can exercise the real path with a hanging probe
 * instead of reimplementing the logic.
 */
export async function raceFleetPingDeadline<T, Target extends FanOutDeviceTarget>(
  fanOut: Promise<import('../lib/devices/fleet.js').FanOutDeviceResult<T>[]>,
  remoteTargets: Target[],
  overallTimeoutMs: number,
): Promise<import('../lib/devices/fleet.js').FanOutDeviceResult<T>[]> {
  const overallDeadline = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error('fleet ping overall deadline exceeded')), overallTimeoutMs),
  );
  try {
    return await Promise.race([fanOut, overallDeadline]);
  } catch (err) {
    // Overall deadline hit before all devices settled — mark every pending
    // device as failed so the command exits promptly. Individual probes that
    // already settled are not retrievable (Promise.all internals), so we
    // record all remote targets as timed out / skipped.
    const errMsg = err instanceof Error ? err.message : String(err);
    return remoteTargets.map((t) => ({
      name: t.name,
      status: t.skip ? ('skipped' as const) : ('failed' as const),
      reason: t.skip,
      error: t.skip ? undefined : errMsg,
    }));
  }
}

async function runFleetPing(opts: { json?: boolean; local?: boolean; verbose?: boolean; strict?: boolean }): Promise<void> {
  const self = machineId();
  const { refreshLocalFleetAuthState } = await import('../lib/daemon-ticks.js');

  // --local: probe just this host. Used both directly and as the fan-out worker.
  // force: this command promises "a real request for every account" (--strict
  // gates on it), so it must never reuse the periodic tick's rate-limit-throttled
  // cached verdict (RUSH-2998).
  if (opts.local) {
    const { authRows: rows } = await refreshLocalFleetAuthState({ force: true });
    if (opts.json) {
      console.log(JSON.stringify({ host: self, rows }));
    } else {
      for (const line of renderAuthMatrix([{ host: self, rows }], { verbose: opts.verbose })) console.log(line);
    }
    if (opts.strict && rows.some((r) => isDeadVerdict(r.health.verdict))) {
      process.exitCode = 1;
    }
    return;
  }

  // Origin: probe locally, then fan out to the rest of the fleet in parallel.
  const reg = await loadDevices();
  const planned = planFleetTargets(reg);
  const results: FleetPingHostResult[] = [];

  // force: same as the --local worker below — this command promises a real
  // request for every account and --strict gates on it, so the self row must
  // never reuse the periodic tick's rate-limit-throttled cached verdict. Each
  // remote peer is force-probed via its own `devices ping --local` worker (see
  // probeRemoteAuth); the self row must match (RUSH-2998).
  const { authRows: localRows } = await refreshLocalFleetAuthState({ force: true });
  results.push({ host: self, rows: localRows });

  const remoteTargets: FleetStatusTarget[] = remoteFleetTargets(planned, self).map((t) => ({
    name: t.device.name,
    platform: resolveDeviceProfile(t.device).platform,
    skip: t.skip,
    dialTarget: fleetDialTarget(t.device),
    extraSshArgs: deviceIdentityArgs(t.device),
  }));
  const probeable = remoteTargets.filter((t) => !t.skip).length;
  const spinner = isInteractiveTerminal() && !opts.json
    ? ora(`Pinging ${probeable} device${probeable === 1 ? '' : 's'}…`).start()
    : undefined;
  // Per-device: 15 s (matches the version probe budget; enough for the ~8 s
  // provider-fetch inside the remote local auth probe, with headroom).
  // Overall: 30 s hard cap so the command can never outlast a reasonable
  // budget when several devices are simultaneously unreachable (RUSH-2041).
  const FLEET_PING_DEVICE_TIMEOUT_MS = 15_000;
  const FLEET_PING_OVERALL_TIMEOUT_MS = 30_000;
  let remote: Awaited<ReturnType<typeof fanOutDevices<AuthProbeRow[], FleetStatusTarget>>>;
  try {
    const fanOut = fanOutDevices(remoteTargets, probeRemoteAuth, { perDeviceTimeoutMs: FLEET_PING_DEVICE_TIMEOUT_MS });
    remote = await raceFleetPingDeadline(fanOut, remoteTargets, FLEET_PING_OVERALL_TIMEOUT_MS);
  } finally {
    spinner?.stop();
  }
  for (const r of remote) {
    if (r.status === 'ok' && r.value) {
      results.push({ host: r.name, rows: r.value });
      writeFleetAuthRows(r.name, r.value);
    } else {
      results.push({
        host: r.name,
        rows: [],
        error: r.error,
        skipped: r.reason ? String(r.reason) : undefined,
      });
    }
  }

  if (opts.json) {
    console.log(JSON.stringify(results, null, 2));
  } else {
    for (const line of renderAuthMatrix(results, { verbose: opts.verbose })) console.log(line);
  }

  const anyBad = results.some((r) => r.rows.some((row) => isDeadVerdict(row.health.verdict)));
  if (opts.strict && anyBad) process.exitCode = 1;
}

// ---------------------------------------------------------------------------
// `agents devices harnesses` / `agents devices accounts` (RUSH-2003)
//
// Both render the same per-device inventory — every installed (agent, version)
// with its account, sign-in, quota, and a single "ready" verdict — through two
// lenses: `harnesses` groups by install, `accounts` collapses installs that
// share one account. The fan-out mirrors `runFleetPing`: probe THIS host in
// process, then SSH each peer's `devices harnesses --local --json` worker.
// ---------------------------------------------------------------------------

export interface HarnessInventoryOpts {
  agents?: AgentId[];
  devices?: string[];
  refresh?: boolean;
  json?: boolean;
  local?: boolean;
}

/** SSH into a host and read its raw harness rows (the `--local --json` worker). */
async function probeRemoteHarnesses(
  target: FleetStatusTarget,
  refresh: boolean,
): Promise<HarnessRow[]> {
  const isWin = /^win/i.test((target.platform ?? '').trim());
  const env = isWin ? undefined : { PATH: '$HOME/.agents/.cache/shims:$HOME/.local/bin:$PATH' };
  const args = ['devices', 'harnesses', '--local', '--json'];
  if (refresh) args.push('--refresh');
  const cmd = buildRemoteAgentsInvocation(args, undefined, isWin ? 'windows' : undefined, env);
  const res = await sshExecAsync(target.dialTarget, cmd, { timeoutMs: 15000, multiplex: true, extraSshArgs: target.extraSshArgs });
  if (res.code !== 0) {
    throw new Error(res.timedOut ? 'timed out' : (res.stderr.trim() || `exit ${res.code ?? 'unknown'}`));
  }
  const parsed = JSON.parse(res.stdout) as { host: string; rows: HarnessRow[] };
  return parsed.rows ?? [];
}

/**
 * Gather harness rows across the fleet: THIS host in process, every reachable
 * peer over SSH. Shared by both `harnesses` and `accounts` (they differ only in
 * how the rows are rendered). Honors an optional `--device` allowlist on both
 * the local and remote rows. Bounded by the same per-device + overall deadlines
 * as `fleet ping`, so one unreachable box can never stall the glance.
 */
export async function collectFleetHarnesses(opts: HarnessInventoryOpts): Promise<HostHarnessResult[]> {
  const self = machineId();
  const want = opts.devices?.length ? new Set(opts.devices) : null;
  const results: HostHarnessResult[] = [];

  if (!want || want.has(self)) {
    const localRows = await collectLocalHarnessInventory({ agents: opts.agents, refresh: opts.refresh });
    results.push({ host: self, rows: localRows });
  }

  const reg = await loadDevices();
  const planned = planFleetTargets(reg);
  let remoteTargets: FleetStatusTarget[] = remoteFleetTargets(planned, self).map((t) => ({
    name: t.device.name,
    platform: resolveDeviceProfile(t.device).platform,
    skip: t.skip,
    dialTarget: fleetDialTarget(t.device),
    extraSshArgs: deviceIdentityArgs(t.device),
  }));
  if (want) remoteTargets = remoteTargets.filter((t) => want.has(t.name));

  if (remoteTargets.length > 0) {
    const probeable = remoteTargets.filter((t) => !t.skip).length;
    const spinner = isInteractiveTerminal() && !opts.json
      ? ora(`Probing ${probeable} device${probeable === 1 ? '' : 's'}…`).start()
      : undefined;
    let remote: Awaited<ReturnType<typeof fanOutDevices<HarnessRow[], FleetStatusTarget>>>;
    try {
      const fanOut = fanOutDevices(
        remoteTargets,
        (t) => probeRemoteHarnesses(t, !!opts.refresh),
        { perDeviceTimeoutMs: 15_000 },
      );
      remote = await raceFleetPingDeadline(fanOut, remoteTargets, 30_000);
    } finally {
      spinner?.stop();
    }
    for (const r of remote) {
      if (r.status === 'ok' && r.value) {
        results.push({ host: r.name, rows: r.value });
      } else {
        results.push({
          host: r.name,
          rows: [],
          error: r.error,
          skipped: r.reason ? String(r.reason) : undefined,
        });
      }
    }
  }

  return results;
}

async function runDevicesHarnesses(opts: HarnessInventoryOpts): Promise<void> {
  if (opts.local) {
    const rows = await collectLocalHarnessInventory({ agents: opts.agents, refresh: opts.refresh });
    if (opts.json) {
      const sanitized = rows.map((row) => ({ ...row, usageError: usageErrorForDisplay(row.usageError) }));
      console.log(JSON.stringify({ host: machineId(), rows: sanitized }));
    } else for (const line of renderHarnessMatrix([{ host: machineId(), rows }])) console.log(line);
    return;
  }
  const results = await collectFleetHarnesses(opts);
  if (opts.json) {
    const sanitized = results.map((result) => ({
      ...result,
      rows: result.rows.map((row) => ({ ...row, usageError: usageErrorForDisplay(row.usageError) })),
    }));
    console.log(JSON.stringify(sanitized, null, 2));
  } else for (const line of renderHarnessMatrix(results)) console.log(line);
}

export async function runDevicesAccounts(opts: HarnessInventoryOpts): Promise<void> {
  if (opts.local) {
    const rows = await collectLocalHarnessInventory({ agents: opts.agents, refresh: opts.refresh });
    if (opts.json) console.log(JSON.stringify({ host: machineId(), accounts: groupByAccount(rows) }));
    else for (const line of renderAccountsMatrix([{ host: machineId(), rows }])) console.log(line);
    return;
  }
  const results = await collectFleetHarnesses(opts);
  if (opts.json) {
    const grouped = results.map((r) => ({
      host: r.host,
      error: r.error,
      skipped: r.skipped,
      accounts: groupByAccount(r.rows),
    }));
    console.log(JSON.stringify(grouped, null, 2));
  } else {
    for (const line of renderAccountsMatrix(results)) console.log(line);
  }
}

/** Resolve an {@link AuthCellColor} to a chalk painter. Single map for cells + labels. */
const CELL_PAINT: Record<AuthCellColor, (s: string) => string> = {
  green: chalk.green,
  yellow: chalk.yellow,
  red: chalk.red,
  gray: chalk.gray,
  dim: chalk.dim,
};

/**
 * Color a per-host×agent cell. The numerator counts accounts that are usable
 * right now — live-verified PLUS signed-in-but-unverifiable (codex/grok) — over
 * the total, so a logged-in codex fleet reads "1/1", not a scary "0/1". Color is
 * the shared {@link authCellColor}: red only for revoked (re-login), yellow for
 * soft/expired (self-refreshes), gray for present-but-unverifiable, green when
 * all live.
 */
function authCell(summary: VerdictSummary, width: number): string {
  if (summary.total === 0) return chalk.dim('·'.padEnd(width));
  const ok = summary.live + summary.present;
  const padded = `${ok}/${summary.total}`.padEnd(width);
  return CELL_PAINT[authCellColor(summary)](padded);
}

/** Render the fleet auth matrix (device rows × agent columns) plus an optional per-account breakdown. */
function renderAuthMatrix(results: FleetPingHostResult[], opts?: { verbose?: boolean }): string[] {
  // Only show agent columns that appear somewhere in the results.
  const present = new Set<string>();
  for (const r of results) for (const row of r.rows) present.add(row.agent);
  const agents = ALL_AGENT_IDS.filter((a) => present.has(a));
  const cellW = 6; // 6 disambiguates opencode/openclaw (both 'openc' at 5)
  const nameW = Math.max(6, ...results.map((r) => r.host.length));

  const lines: string[] = [chalk.bold('Fleet auth')];
  const header = `  ${'Device'.padEnd(nameW)}  ${agents.map((a) => a.slice(0, cellW).padEnd(cellW)).join(' ')}`;
  lines.push(chalk.gray(header));

  for (const r of results) {
    const cells = agents.map((a) => {
      const verdicts = r.rows.filter((row) => row.agent === a).map((row) => row.health.verdict);
      return authCell(summarizeVerdicts(verdicts), cellW);
    });
    let note = '';
    if (r.skipped) note = chalk.dim(`  ${r.skipped}`);
    else if (r.error) note = chalk.red(`  ${r.error}`);
    else {
      const dead = r.rows.filter((row) => isDeadVerdict(row.health.verdict)).length;
      if (dead > 0) note = chalk.red(`  ${dead} revoked — re-login`);
    }
    lines.push(`  ${r.host.padEnd(nameW)}  ${cells.join(' ')}${note}`);
  }

  lines.push('');
  lines.push(chalk.gray('  cell = signed-in/total accounts · green live · gray signed-in (unverifiable: codex/grok) · yellow expired (self-refreshes) · red revoked (re-login)'));

  if (opts?.verbose) {
    lines.push('');
    lines.push(chalk.bold('Accounts'));
    for (const r of results) {
      if (r.rows.length === 0) continue;
      for (const row of r.rows.slice().sort((x, y) => (x.agent + x.version).localeCompare(y.agent + y.version))) {
        const v = row.health.verdict;
        const label = CELL_PAINT[verdictColor(v)](verdictLabel(v));
        const acctRaw = row.account ?? '—';
        const acct = row.account ? chalk.cyan(acctRaw.padEnd(28)) : chalk.dim(acctRaw.padEnd(28));
        const detail = row.health.detail ? chalk.dim(` ${row.health.detail}`) : '';
        const age = chalk.dim(` · ${formatCheckedAge(row.health.checkedAt)}`);
        lines.push(`  ${r.host.padEnd(nameW)}  ${`${row.agent}@${row.version}`.padEnd(22)}  ${acct}  ${label}${detail}${age}`);
      }
    }
  }

  return lines;
}

/** Render the final `fleet login` result summary in the house auth-matrix style. */
function renderLoginMatrix(results: LoginStatus[]): string[] {
  const lines: string[] = [chalk.bold('Fleet login')];
  if (results.length === 0) {
    lines.push(chalk.gray('  Nothing pending — every requested account is already logged in.'));
    return lines;
  }
  const nameW = Math.max(6, ...results.map((r) => `${r.agent}@${r.device}`.length));
  for (const r of results) {
    const who = `${r.agent}@${r.device}`.padEnd(nameW);
    let badge: string;
    switch (r.state) {
      case 'authorized': badge = chalk.green('authorized'); break;
      case 'ready': badge = chalk.cyan('code ready'); break;
      case 'driving': badge = chalk.yellow('driving'); break;
      case 'skipped': badge = chalk.gray('not remotable'); break;
      case 'error': badge = chalk.red('error'); break;
      default: badge = chalk.gray(r.state); break;
    }
    const note = r.detail ? chalk.dim(`  ${r.detail}`) : (r.reason && !r.remotable ? chalk.dim(`  ${r.reason}`) : '');
    lines.push(`  ${who}  ${badge}${note}`);
  }
  const auth = results.filter((r) => r.state === 'authorized').length;
  const remotable = results.filter((r) => r.remotable).length;
  lines.push('');
  lines.push(chalk.gray(`  ${auth}/${remotable} remotable logins authorized`));
  return lines;
}

/** Register the `agents devices` command tree (also aliased as `fleet`). */
function registerDevicesCommands(program: Command): void {
  const devicesCmd = program
    .command('devices')
    .alias('fleet')
    .description('Registry of SSH device profiles (platform, user, address, auth), self-populated from Tailscale. Alias: fleet.');

  setHelpSections(devicesCmd, {
    examples: `
      Discover & register:
        agents devices sync            # pick which tailscale nodes to keep (TTY)
        agents devices sync --yes      # register all non-ignored nodes
        agents devices ignore ipad165  # dismiss a node so it's never re-suggested
        agents devices ignored         # list dismissed nodes (when / which machine)

      Inspect:
        agents devices list            # what's registered (★ = interactive host)
        agents devices status          # live reachability + load
        agents devices ping            # quick liveness probe
        agents devices lease list      # disposable crabbox devices available for reuse

      Configure a device:
        agents devices config mac-mini                       # settings menu (TTY) / print (piped)
        agents devices config mac-mini agents.max-concurrent 4
        agents devices config mac-mini scheduler.enabled off
        agents devices config mac-mini notes "runs the releases"
        agents devices config win-mini ssh.auth password
        agents devices config worker ssh.identity-file ~/.ssh/worker_ed25519
        agents devices config mac-mini auto-launch.enabled off
        agents devices describe mark-1 "gpu box — cuda 12.4"  # one-line purpose, shown in the list
        agents devices config mac-mini interactive.host zion # where agents show YOU artifacts
        agents devices render --write  # write ~/.ssh/config.d/agents include

      Fleet operations:
        agents fleet update              # roll out latest agents-cli everywhere
        agents fleet run uname -a        # run a command on every online device
    `,
    notes: '`agents fleet` is an alias for `agents devices` — same subcommands.',
  });

  registerLeaseCommand(devicesCmd);
  registerSnapshotCommand(devicesCmd);

  registerCommandGroups(devicesCmd, [
    { title: 'Discover & register', names: ['sync', 'register', 'add', 'ignore', 'unignore', 'ignored', 'remove'] },
    { title: 'Inspect', names: ['list', 'show', 'status', 'ping', 'harnesses', 'accounts', 'snapshot'] },
    { title: 'Disposable devices', names: ['lease'] },
    { title: 'Configure a device', names: ['config', 'describe', 'render'] },
    { title: 'Fleet operations', names: ['update', 'run', 'login', 'capture', 'apply', 'worktrees'] },
  ]);

  devicesCmd
    .command('sync')
    .description('Ingest `tailscale status --json` into device profiles. In a terminal, opens a checkbox to register/unregister nodes; with --yes, registers every non-ignored node.')
    .option('--yes', 'skip the picker; register all discovered non-ignored nodes')
    .action(async (opts: { yes?: boolean }) => {
      if (isInteractiveTerminal() && !opts.yes) {
        await runInteractiveDeviceSync();
        return;
      }
      const spinner = ora('Reading tailscale status...').start();
      try {
        const res = await runDeviceSync();
        for (const name of res.syncedNames) setDeviceDiscoveryStatus(name, 'approved');
        const extra = res.pending.length ? chalk.gray(` (${res.pending.length} new)`) : '';
        spinner.succeed(`Synced ${res.synced} device${res.synced === 1 ? '' : 's'} from Tailscale${extra}`);
      } catch (err: any) {
        spinner.fail(err.message);
        process.exit(1);
      }
    });

  // `agents fleet capture` — snapshot live state into agents.yaml fleet:.
  registerFleetCaptureCommand(devicesCmd);

  // `agents fleet apply` — canonical fleet reconcile (top-level apply is retired).
  registerFleetApplyAlias(devicesCmd);

  devicesCmd
    .command('register <name>')
    .description("Register a discovered node and record the approval in this box's device doc (fleet.discovery), unioned fleet-wide.")
    .action(async (name: string) => {
      try {
        const nodes = parseTailscaleStatus(tailscaleStatusJson());
        const node = nodes.find((n) => n.name === name);
        if (!node) {
          console.error(chalk.red(`'${name}' is not a current tailscale node. See 'agents devices sync'.`));
          process.exit(1);
        }
        await removeIgnored(name); // clear THIS box's dismissal, if any
        const d = await upsertDevice(name, nodeToDeviceInput(node));
        setDeviceDiscoveryStatus(name, 'approved');
        clearPendingSentinel(name); // drop the notification immediately
        console.log(chalk.green(`Registered '${name}'`) + chalk.gray(` (${d.platform})`));
        // A dismissal on another box still wins the union (ignored beats
        // approved), so approving here does not un-dismiss it fleet-wide — say so
        // rather than imply the node is now discoverable everywhere (PHNX-3315).
        const otherDismissals = loadIgnoredEntries().filter((e) => e.name === name);
        if (otherDismissals.length > 0 || getDeviceDiscoveryStatus(name) === 'ignored') {
          const boxes = [...new Set(otherDismissals.map((e) => e.ignoredOn))].sort().join(', ') || 'another box';
          console.error(
            chalk.yellow(`Note: '${name}' is still dismissed on: ${boxes}, so it stays ignored fleet-wide`) +
              chalk.gray(` until you run \`agents devices unignore ${name}\` there.`),
          );
        }
      } catch (err: any) {
        console.error(chalk.red(err.message));
        process.exit(1);
      }
    });

  devicesCmd
    .command('ignore <name>')
    .description("Dismiss a node and record the decision in this box's device doc (fleet.ignored), unioned fleet-wide (also removes it locally).")
    .action(async (name: string) => {
      try {
        await removeDevice(name);
        await addIgnored(name);
        setDeviceDiscoveryStatus(name, 'ignored');
        clearPendingSentinel(name); // drop the notification immediately
        console.log(chalk.green(`Ignored '${name}'`) + chalk.gray(" — it won't be suggested again. Undo with `agents devices unignore`."));
      } catch (err: any) {
        console.error(chalk.red(err.message));
        process.exit(1);
      }
    });

  devicesCmd
    .command('unignore <name>')
    .description('Undo `ignore`: allow a node to be discovered and registered again.')
    .action(async (name: string) => {
      const wasIgnored =
        getDeviceDiscoveryStatus(name) === 'ignored' || loadIgnoredEntries().some((e) => e.name === name);
      // A box can edit only its OWN device doc (PHNX-3315), so this clears just
      // this box's dismissal/approval decision.
      await removeIgnored(name);
      setDeviceDiscoveryStatus(name, undefined);
      // Re-evaluate the cross-box union AFTER clearing our slice: another box's
      // dismissal keeps the node ignored fleet-wide (ignored beats approved), so
      // never report a false "no longer ignoring" — name the box(es) to clear.
      const remaining = loadIgnoredEntries().filter((e) => e.name === name);
      if (remaining.length > 0 || getDeviceDiscoveryStatus(name) === 'ignored') {
        const boxes = [...new Set(remaining.map((e) => e.ignoredOn))].sort().join(', ') || 'another box';
        console.error(
          chalk.yellow(`Cleared this box's decision, but '${name}' is still dismissed on: ${boxes}.`) +
            chalk.gray(`\nRun \`agents devices unignore ${name}\` there too to clear it fleet-wide.`),
        );
        return;
      }
      if (!wasIgnored) {
        console.error(chalk.gray(`'${name}' was not ignored.`));
        return;
      }
      console.log(chalk.green(`No longer ignoring '${name}'`) + chalk.gray(' — run `agents devices sync` to register it.'));
    });

  const ignoredCmd = devicesCmd
    .command('ignored')
    .description('List dismissed tailscale nodes — what was dismissed, when, and on which machine.')
    .option('--json', 'output machine-readable JSON')
    .action((opts: { json?: boolean }) => {
      try {
        const entries: IgnoredDeviceEntry[] = loadIgnoredEntries();
        if (opts.json) {
          process.stdout.write(JSON.stringify(entries, null, 2) + '\n');
          return;
        }
        if (entries.length === 0) {
          console.log(chalk.gray("No ignored nodes. 'agents devices ignore <name>' dismisses one — it won't be re-suggested."));
          return;
        }
        console.log(chalk.bold(`Ignored nodes (${entries.length})`));
        for (const e of entries) {
          const age = formatCheckedAge(Date.parse(e.ignoredAt));
          console.log(`  ${chalk.bold(e.name.padEnd(24))} ${chalk.gray(`${age} · dismissed on ${e.ignoredOn}`)}`);
        }
        console.log(chalk.gray("Undo one with 'agents devices unignore <name>'."));
      } catch (err: any) {
        console.error(chalk.red(err.message));
        process.exit(1);
      }
    });
  setHelpSections(ignoredCmd, {
    examples: `
      agents devices ignored          # what was dismissed, when, and on which machine
      agents devices ignored --json   # machine-readable [{ name, ignoredAt, ignoredOn }]
      agents devices unignore old-laptop   # undo a dismissal
    `,
    notes: `
      Dismissals live in each box's tracked device doc
      (devices/<host>/agents.yaml fleet.ignored) and sync with 'agents repo
      push/pull'; the effective list is their cross-box union, so a node
      dismissed on one box stays dismissed everywhere without the boxes ever
      rewriting one shared file. An ignored node is not a device — it never
      enters the registry, so 'agents devices list' never shows it; this command
      is where dismissals are visible.
    `,
  });

  // ─── devices config (unified settings surface) ────────────────────────────
  //
  // ONE command for every per-device setting: `agents devices config <name>
  // [key] [value] [--unset] [--json]`. The retired subcommands (configure,
  // note, set-interactive, set, enable/disable/prefer/unprefer) are hidden
  // tombstones below — each prints a deprecation notice on STDERR (so a --json
  // consumer's stdout stays parseable) and delegates to this same engine,
  // preserving its old output shape and exit codes.

  /** Parse a raw CLI string into a config key's typed value (bool/int pass validation, strings verbatim). */
  const parseConfigValueInput = (spec: ConfigKeySpec, raw: string): unknown => {
    switch (spec.type) {
      case 'int': {
        const n = Number(raw);
        if (!Number.isInteger(n)) throw new Error(`Config key '${spec.name}' expects an integer, got '${raw}'.`);
        return n;
      }
      case 'bool': {
        if (raw === 'on' || raw === 'true') return true;
        if (raw === 'off' || raw === 'false') return false;
        throw new Error(`Config key '${spec.name}' expects on/off (or true/false), got '${raw}'.`);
      }
      default:
        return raw;
    }
  };

  const writeJson = (payload: unknown): void => {
    process.stdout.write(JSON.stringify(payload, null, 2) + '\n');
  };

  /** The device-scope config entries for `name` (what the config surface edits). */
  const deviceConfigEntries = (name: string) =>
    listConfig({ device: name }).filter((e) => e.spec.scope === 'device');

  /** Render one entry's effective value with its layer tag. */
  const entryValueText = (e: ConfigEntry): string => {
    if (e.source === 'default') return chalk.gray('— (default)');
    const tag = e.source === 'fleet' ? chalk.yellow('  (fleet default)') : e.source === 'user' ? chalk.gray('  (user scope)') : '';
    return chalk.cyan(JSON.stringify(e.value)) + tag;
  };

  /** Print the full resolved config for a device (bare invocation, non-menu). */
  const printDevicesConfig = (name: string, json: boolean): void => {
    const entries = deviceConfigEntries(name);
    if (json) {
      const config: Record<string, unknown> = {};
      for (const e of entries) config[e.spec.name] = { value: e.value ?? null, source: e.source };
      writeJson({ device: name, config });
      return;
    }
    console.log(chalk.bold(`Config for '${name}'`));
    for (const e of entries) {
      console.log(`  ${e.spec.name.padEnd(24)} ${entryValueText(e)}${chalk.gray(`  ${e.spec.description}`)}`);
    }
  };

  /** Print the fleet-wide defaults layer (`config --fleet`, bare). */
  const printFleetConfig = (json: boolean): void => {
    const entries = listConfig({ fleet: true }).filter((e) => e.spec.scope === 'device');
    if (json) {
      const config: Record<string, unknown> = {};
      for (const e of entries) config[e.spec.name] = { value: e.value ?? null, source: e.source };
      writeJson({ fleet: true, config });
      return;
    }
    console.log(chalk.bold('Fleet-wide config defaults') + chalk.gray('  (every device inherits these unless it overrides the key)'));
    for (const e of entries) {
      const value = e.value === undefined ? chalk.gray('— (default)') : chalk.cyan(JSON.stringify(e.value));
      console.log(`  ${e.spec.name.padEnd(24)} ${value}${chalk.gray(`  ${e.spec.description}`)}`);
    }
  };

  /**
   * The `devices config` engine — shared by the config command's action and
   * every tombstone. `quiet` performs the write with no output (a tombstone
   * that prints its own legacy shape). `fleet` targets the fleet-wide defaults
   * layer instead of a device (`name` is then unused). Throws on a bad
   * key/value; callers map that to exit 1.
   */
  const runDevicesConfig = async (
    name: string | undefined,
    key: string | undefined,
    valueParts: string[],
    opts: { unset?: boolean; json?: boolean; quiet?: boolean; fleet?: boolean },
  ): Promise<void> => {
    const spec = key ? configKeySpec(key) : undefined; // unknown key → throw listing the valid keys

    // ── Fleet-defaults layer (`--fleet`): no device involved.
    if (opts.fleet) {
      if (spec && spec.scope === 'user') {
        throw new Error(`Config key '${spec.name}' is user-scope (already fleet-wide) — --fleet does not apply.`);
      }
      if (opts.unset) {
        if (!spec) throw new Error('--unset needs a key: agents devices config --fleet <key> --unset');
        unsetConfigValue(spec!.name, { fleet: true });
        if (opts.quiet) return;
        if (opts.json) writeJson({ fleet: true, key: spec!.name, value: null, source: 'default' });
        else console.log(chalk.green(`Unset ${spec!.name}`) + chalk.gray(' in the fleet defaults.'));
        return;
      }
      if (spec && valueParts.length > 0) {
        let value: unknown;
        if (spec.type === 'string-list') {
          const existing = (getConfigValue(spec.name, { fleet: true }).value as string[] | undefined) ?? [];
          value = [...existing, valueParts.join(' ')];
        } else {
          value = parseConfigValueInput(spec, valueParts.join(' '));
        }
        setConfigValue(spec.name, value, { fleet: true });
        if (opts.quiet) return;
        if (opts.json) writeJson({ fleet: true, key: spec.name, value, source: 'fleet' });
        else console.log(chalk.green(`Set ${spec.name} = ${JSON.stringify(value)}`) + chalk.gray(' as the fleet-wide default.'));
        return;
      }
      if (spec) {
        const entry = getConfigValue(spec.name, { fleet: true });
        if (opts.quiet) return;
        if (opts.json) writeJson({ fleet: true, key: spec.name, value: entry.value ?? null, source: entry.source });
        else console.log(`  ${spec.name.padEnd(24)} ${entryValueText(entry)}${chalk.gray(`  ${spec.description}`)}`);
        return;
      }
      printFleetConfig(Boolean(opts.json));
      return;
    }

    // User-scope keys (interactive.host) are stored centrally — the device name
    // is syntax only, so an unregistered name is not an error for them.
    if (!spec || spec.scope === 'device') await mustGetDevice(name!);

    if (opts.unset) {
      if (!spec) throw new Error('--unset needs a key: agents devices config <name> <key> --unset');
      unsetConfigValue(spec.name, { device: name });
      if (opts.quiet) return;
      if (opts.json) writeJson({ device: name, key: spec.name, value: null, source: 'default' });
      else console.log(chalk.green(`Unset ${spec.name}`) + chalk.gray(` on '${name}' — falls back to the fleet default / built-in behavior.`));
      return;
    }

    if (spec && valueParts.length > 0) {
      let value: unknown;
      if (spec.type === 'string-list') {
        // List keys (notes) APPEND — one entry per invocation.
        const existing = (getConfigValue(spec.name, { device: name }).value as string[] | undefined) ?? [];
        value = [...existing, valueParts.join(' ')];
      } else {
        value = parseConfigValueInput(spec, valueParts.join(' '));
      }
      setConfigValue(spec.name, value, { device: name });
      if (opts.quiet) return;
      if (opts.json) writeJson({ device: name, key: spec.name, value, source: 'device' });
      else console.log(chalk.green(`Set ${spec.name} = ${JSON.stringify(value)}`) + chalk.gray(` on '${name}'.`));
      return;
    }

    if (spec) {
      const entry = getConfigValue(spec.name, { device: name });
      if (opts.quiet) return;
      if (opts.json) {
        writeJson({ device: name, key: spec.name, value: entry.value ?? null, source: entry.source });
      } else {
        console.log(`  ${spec.name.padEnd(24)} ${entryValueText(entry)}${chalk.gray(`  ${spec.description}`)}`);
      }
      return;
    }

    // Bare: TTY → the interactive settings menu; piped/--json → print.
    if (opts.json || !isInteractiveTerminal()) {
      printDevicesConfig(name!, Boolean(opts.json));
      return;
    }
    await runDevicesConfigMenu(name!);
  };

  /**
   * The `devices role` engine — read or write the fleet-wide role mark, and say
   * what it does to automatic placement.
   *
   * A role written here lands in that device's tracked per-device doc
   * (`devices/<name>/agents.yaml` `config.role`) and syncs with repo
   * push/pull. The vocabulary is `worker | personal | desktop`.
   */
  const runDevicesRole = async (
    name: string | undefined,
    role: string | undefined,
    opts: { clear?: boolean; json?: boolean },
  ): Promise<void> => {
    if (!name) {
      if (role) throw new Error('Name a device: agents devices role <name> <worker|personal|desktop>');
      const reg = await loadDevices();
      // The full registered roster, not just online — a fleet-wide `role`
      // default must reach a registered device even when it has no per-device
      // doc of its own, or it silently falls out of the worker allowlist.
      const roles = listConfiguredDeviceRoles(Object.keys(reg));
      const mode = autoPoolMode();
      const online = Object.entries(reg)
        .filter(([, d]) => d?.tailscale?.online !== false)
        .map(([n]) => n);
      const pool = filterAutoPool(online, { mode, roles });
      if (opts.json) {
        writeJson({ mode, roles, autoPool: pool });
        return;
      }
      const marked = Object.entries(roles);
      if (marked.length === 0) {
        console.log(chalk.gray('No device is marked. `--device auto` considers every online device.'));
      } else {
        for (const [device, r] of marked) {
          const tint = r === 'worker' ? chalk.green : r === 'personal' ? chalk.yellow : r === 'desktop' ? chalk.cyan : chalk.gray;
          console.log(`  ${device.padEnd(20)} ${tint(r)}`);
        }
      }
      console.log();
      console.log(chalk.bold('--device auto picks from: ') + (pool.length > 0 ? pool.join(', ') : chalk.red('nothing — no eligible device')));
      if (mode === 'all') console.log(chalk.gray('auto.pool=all — worker marks are ignored (personal and desktop devices are still excluded).'));
      return;
    }

    await mustGetDevice(name);

    if (opts.clear || role === 'none') {
      setConfiguredDeviceRole(name, undefined);
      if (opts.json) writeJson({ device: name, role: null });
      else console.log(chalk.green(`Cleared the role on '${name}'.`));
      return;
    }

    if (!role) {
      const current = configuredDeviceRole(name);
      if (opts.json) writeJson({ device: name, role: current ?? null });
      else console.log(`  ${name.padEnd(20)} ${current ? chalk.cyan(current) : chalk.gray('— (unmarked)')}`);
      return;
    }

    // configuredDeviceRole's key spec validates the value; a bad one throws with
    // the accepted list, which the command's catch turns into exit 1.
    setConfiguredDeviceRole(name, role as ConfiguredDeviceRole);
    // Full registered roster, mirroring the bare-listing branch above — a
    // fleet-wide `role` default must reach a doc-less registered device here
    // too, or `autoPoolWorkers` under-reports the allowlist right after this
    // write changed it.
    const roles = listConfiguredDeviceRoles(Object.keys(await loadDevices()));
    if (opts.json) {
      writeJson({ device: name, role, autoPoolWorkers: listWorkerDevices({ roles }) });
      return;
    }
    console.log(chalk.green(`Marked '${name}' role=${role}.`));
    const workers = listWorkerDevices({ roles });
    if (workers.length > 0) {
      console.log(chalk.gray(`\`--device auto\` now picks only from: ${workers.join(', ')}`));
    } else {
      console.log(chalk.gray('No device is marked worker, so `--device auto` still considers every online device.'));
    }
    console.log(chalk.gray('Sync it to the fleet with `agents repo push`.'));
  };

  /** The interactive settings menu: pick a key, edit it, repeat. TTY-only.
   * Shows EFFECTIVE values (with a fleet tag when inherited); edits always
   * write the device layer. */
  const runDevicesConfigMenu = async (name: string): Promise<void> => {
    const { select, input, confirm } = await import('@inquirer/prompts');
    const DONE = '__done__';
    try {
      for (;;) {
        const entries = deviceConfigEntries(name);
        const picked = await select<string>({
          message: `Config for '${name}' — pick a key to edit (writes the device layer):`,
          pageSize: Math.min(entries.length + 1, 20),
          choices: [
            ...entries.map((e) => {
              const value =
                e.source !== 'default'
                  ? entryValueText(e)
                  : chalk.gray(
                      e.spec.defaultValue !== undefined
                        ? `default: ${JSON.stringify(e.spec.defaultValue)}`
                        : 'unset (default)',
                    );
              return { value: e.spec.name, name: `${e.spec.name.padEnd(24)} ${value}  ${chalk.gray(e.spec.description)}` };
            }),
            { value: DONE, name: 'Done' },
          ],
        });
        if (picked === DONE) return;
        const spec = configKeySpec(picked);
        if (spec.type === 'bool') {
          const current = getConfigValue(picked, { device: name }).value as boolean | undefined;
          const next = await confirm({
            message: `${picked} — enable?`,
            default: current ?? (spec.defaultValue as boolean | undefined) ?? true,
          });
          setConfigValue(picked, next, { device: name });
          console.log(chalk.green(`Set ${picked} = ${next}`) + chalk.gray(` on '${name}'.`));
        } else if (spec.type === 'string-list') {
          const text = await input({ message: `${picked} — append an entry (empty to go back):` });
          if (text.trim().length > 0) {
            const existing = (getConfigValue(picked, { device: name }).value as string[] | undefined) ?? [];
            setConfigValue(picked, [...existing, text.trim()], { device: name });
            console.log(chalk.green(`Noted on '${name}':`) + ` ${text.trim()}`);
          }
        } else {
          const current = getConfigValue(picked, { device: name }).value;
          const raw = await input({
            message: `${picked}:`,
            default: current === undefined ? undefined : String(current),
          });
          if (raw.trim().length === 0) continue;
          const value = parseConfigValueInput(spec, raw.trim());
          setConfigValue(spec.name, value, { device: name });
          console.log(chalk.green(`Set ${spec.name} = ${JSON.stringify(value)}`) + chalk.gray(` on '${name}'.`));
        }
      }
    } catch (err) {
      if (isPromptCancelled(err)) return; // ctrl-c / esc — leave the menu quietly
      throw err;
    }
  };

  const configCmd = devicesCmd
    .command('config [name] [key] [value...]')
    .description(
      'Get, set, or unset a device’s settings (scheduler, agent cap, ssh overrides, auto-launch, notes). ' +
        'Bare opens an interactive settings menu (TTY) or prints the resolved config (piped). ' +
        'Per-device values live in the tracked devices/<name>/agents.yaml config: block; --fleet targets the ' +
        'fleet-wide defaults (central fleet.defaults.config) every device inherits unless it overrides the key.',
    )
    .option('--fleet', 'target the fleet-wide defaults layer instead of a device (first positional is the key)')
    .option('--unset', 'reset the key at that layer (a device key then inherits the fleet default)')
    .option('--json', 'output machine-readable JSON (each key carries its source: device | fleet | default)')
    .action(async (name: string | undefined, key: string | undefined, valueParts: string[] | undefined, opts: { fleet?: boolean; unset?: boolean; json?: boolean }) => {
      try {
        if (opts.fleet) {
          // Positionals shift left: the first one is the key, the rest the value.
          const fleetValue = [key, ...(valueParts ?? [])].filter((v): v is string => v !== undefined);
          await runDevicesConfig(undefined, name, fleetValue, opts);
          return;
        }
        if (!name) {
          throw new Error('Missing device name. Usage: agents devices config <name> [key] [value] — or --fleet <key> <value> for the fleet-wide defaults.');
        }
        await runDevicesConfig(name, key, valueParts ?? [], opts);
      } catch (err: any) {
        console.error(chalk.red(err.message));
        process.exit(1);
      }
    });
  setHelpSections(configCmd, {
    examples: `
      agents devices config mac-mini                            # settings menu (TTY) / print config (piped)
      agents devices config mac-mini agents.max-concurrent 4    # cap concurrent agents on mac-mini
      agents devices config mac-mini scheduler.enabled off      # no routines firing there
      agents devices config mac-mini scheduler.enabled          # read the effective value back
      agents devices config mac-mini scheduler.enabled --unset  # inherit the fleet default again
      agents devices config --fleet scheduler.enabled off       # fleet-wide default (all devices)
      agents devices config --fleet agents.max-concurrent 2     # every box caps at 2 unless it overrides
      agents devices config --fleet                             # print the fleet defaults layer
      agents devices config mac-mini notes "runs the releases"  # append an operator note
      agents devices config win-mini ssh.auth password          # password auth…
      agents devices config win-mini ssh.bundle muqsit          # …from this secrets bundle
      agents devices config worker ssh.identity-file ~/.ssh/worker_ed25519
      agents devices config mac-mini role worker                 # same as \`agents devices role mac-mini worker\`
      agents devices config mac-mini auto-launch.enabled off    # exclude from AGI EXT auto-launch
      agents devices config mac-mini auto-launch.preferred on   # boost in auto-launch ranking
      agents devices config zion interactive.host zion          # user scope: where agents show YOU artifacts
      agents devices config mac-mini --json                     # machine-readable, per-key source
    `,
    notes: `
      Keys: role (worker|personal), see 'agents devices role',
      description (one line saying what the box is for — see
      'agents devices describe'; renders in the devices list tail),
      agents.max-concurrent, scheduler.enabled, daemon.enabled,
      watchdog.enabled, tmux.enabled, browser.remote-control,
      browser.task-idle-minutes, browser.profile,
      notes, ssh.user, ssh.auth (key|password), ssh.bundle, ssh.bundle-key,
      ssh.identity-file, platform (windows|linux|macos|unknown),
      auto-launch.enabled, auto-launch.preferred — plus the user-scope
      interactive.host (stored centrally; the device name is syntax only).

      Three layers, read in order — built-in default < fleet default
      (--fleet, central fleet.defaults.config) < per-device value
      (devices/<name>/agents.yaml config:). Both files are tracked and sync
      with 'agents repo push/pull'; per-device files are conflict-free because
      each machine writes only its own folder. --unset removes the value at
      the targeted layer, so a device key falls back to the fleet default.

      Booleans take on/off (or true/false). 'notes' appends one entry per
      invocation. ssh.* / platform / user overlay the discovered registry
      profile at dial time. scheduler.enabled / daemon.enabled take effect
      when the daemon reloads or restarts on that device. Machine-local keys
      (scheduler.enabled, daemon.enabled, tmux.enabled, browser.remote-control,
      browser.task-idle-minutes, browser.profile) can only be read or set on
      the device itself; --fleet still writes a fleet-wide default those boxes
      inherit until they override.

      The retired subcommands still work and forward here: configure, note,
      set, set-interactive, enable, disable, prefer, unprefer.
    `,
  });

  const roleCmd = devicesCmd
    .command('role [name] [role]')
    .description(
      'Show or set what a device is for: worker (agents run here), personal (you sit here), or desktop (a headed ' +
        'always-on box — the release/credential home). Personal and desktop are never picked automatically. ' +
        'Marking any device worker makes `--device auto` an allowlist over the marked workers.',
    )
    .option('--clear', 'remove the mark, returning the device to unmarked')
    .option('--json', 'output machine-readable JSON')
    .action(async (name: string | undefined, role: string | undefined, opts: { clear?: boolean; json?: boolean }) => {
      try {
        await runDevicesRole(name, role, opts);
      } catch (err: any) {
        console.error(chalk.red(err.message));
        process.exit(1);
      }
    });
  setHelpSections(roleCmd, {
    examples: `
      agents devices role                          # who is marked what, and what --device auto would pick
      agents devices role yosemite-s0 worker       # agents spin up here
      agents devices role yosemite-s1 worker       # …and here; auto now rotates over these two only
      agents devices role zion personal            # your laptop — keep automatic placement off it
      agents devices role mac-mini desktop         # headed always-on box — also kept out of auto placement
      agents devices role yosemite-s0 --clear      # unmark
      agents devices role --json                   # machine-readable
    `,
    notes: `
      Roles live in that device's tracked per-device doc
      (devices/<name>/agents.yaml config.role) and travel with
      'agents repo push/pull', so a mark set on one box is the whole fleet's
      answer.

      Effect on '--device auto' (agents run, teams, agents ssh auto, and the AGI
      EXT launch commands, which all resolve placement through the CLI):
        no device marked   -> every online device, as before
        any worker marked  -> ONLY the marked workers
        personal / desktop -> never picked, under either state

      Turn the allowlist off with 'agents config set auto.pool all'; personal and
      desktop boxes stay excluded, since that is what the mark is for.
    `,
  });

  const describeCmd = devicesCmd
    .command('describe <name> [text...]')
    .description(
      'Show or set the one-line description of what a device is FOR ("gpu box — cuda 12.4"). ' +
        'Rendered as the tail column of `agents devices list` and synced fleet-wide. ' +
        'Same key as `agents devices config <name> description` — one store, two names.',
    )
    .option('--unset', 'remove the description (the device falls back to the fleet default / unset)')
    .option('--json', 'output machine-readable JSON')
    .action(async (name: string, textParts: string[] | undefined, opts: { unset?: boolean; json?: boolean }) => {
      try {
        // Thin sugar over the 'description' config key — the same engine that
        // backs `agents devices config <name> description`, not a second path.
        await runDevicesConfig(name, 'description', textParts ?? [], opts);
      } catch (err: any) {
        console.error(chalk.red(err.message));
        process.exit(1);
      }
    });
  setHelpSections(describeCmd, {
    examples: `
      agents devices describe mark-1 "gpu box — cuda 12.4"  # set it (80 chars, one line)
      agents devices describe mark-1                        # read it back
      agents devices describe mark-1 --unset                # remove it
      agents devices describe mark-1 --json                 # machine-readable
      agents devices config mark-1 description "gpu box"    # equivalent — same store
    `,
    notes: `
      The description is the device-scope 'description' config key: stored in
      the tracked per-device doc (devices/<name>/agents.yaml config: block),
      synced fleet-wide with 'agents repo push/pull', and rendered as the tail
      column of 'agents devices list'. It replaces on each set — for appended
      long-form scratch use 'agents devices config <name> notes "…"'.
    `,
  });

  /** Deprecation notice for a retired subcommand — STDERR only, so a --json consumer's stdout stays parseable. */
  const configTombstoneNotice = (retired: string, replacement: string): void => {
    console.error(chalk.yellow(`Deprecated: "agents devices ${retired}" is now "agents devices ${replacement}". Running that for you.\n`));
  };

  devicesCmd
    .command('enable <name>', { hidden: true })
    .action(async (name: string) => {
      try {
        configTombstoneNotice('enable <name>', 'config <name> auto-launch.enabled on');
        await mustGetDevice(name);
        // Back to the default (enabled) = remove the key.
        await runDevicesConfig(name, 'auto-launch.enabled', [], { unset: true, quiet: true });
        console.log(chalk.green(`Enabled '${name}'`) + chalk.gray(' for AGI EXT auto-launch.'));
      } catch (err: any) {
        console.error(chalk.red(err.message));
        process.exit(1);
      }
    });

  devicesCmd
    .command('disable <name>', { hidden: true })
    .action(async (name: string) => {
      try {
        configTombstoneNotice('disable <name>', 'config <name> auto-launch.enabled off');
        await mustGetDevice(name);
        await runDevicesConfig(name, 'auto-launch.enabled', ['off'], { quiet: true });
        console.log(chalk.green(`Disabled '${name}'`) + chalk.gray(' for AGI EXT auto-launch.'));
      } catch (err: any) {
        console.error(chalk.red(err.message));
        process.exit(1);
      }
    });

  devicesCmd
    .command('prefer <name>', { hidden: true })
    .action(async (name: string) => {
      try {
        configTombstoneNotice('prefer <name>', 'config <name> auto-launch.preferred on');
        await mustGetDevice(name);
        await runDevicesConfig(name, 'auto-launch.preferred', ['on'], { quiet: true });
        console.log(chalk.green(`Preferred '${name}'`) + chalk.gray(' for AGI EXT auto-launch.'));
      } catch (err: any) {
        console.error(chalk.red(err.message));
        process.exit(1);
      }
    });

  devicesCmd
    .command('unprefer <name>', { hidden: true })
    .action(async (name: string) => {
      try {
        configTombstoneNotice('unprefer <name>', 'config <name> auto-launch.preferred off');
        await mustGetDevice(name);
        // Back to the default (not preferred) = remove the key.
        await runDevicesConfig(name, 'auto-launch.preferred', [], { unset: true, quiet: true });
        console.log(chalk.green(`No longer preferring '${name}'`) + chalk.gray(' for AGI EXT auto-launch.'));
      } catch (err: any) {
        console.error(chalk.red(err.message));
        process.exit(1);
      }
    });

  devicesCmd
    .command('set-interactive [name]', { hidden: true })
    .option('--unset', 'clear the interactive host')
    .option('--json', 'output machine-readable JSON')
    .action(async (name: string | undefined, opts: { unset?: boolean; json?: boolean }) => {
      try {
        configTombstoneNotice('set-interactive [name]', 'config <name> interactive.host <name>');
        if (opts.unset) {
          unsetConfigValue('interactive.host');
          if (opts.json) writeJson({ interactiveHost: null });
          else console.log(chalk.green('Cleared the interactive host.'));
          return;
        }
        if (name) {
          await mustGetDevice(name);
          setConfigValue('interactive.host', name);
          if (opts.json) writeJson({ interactiveHost: name });
          else console.log(chalk.green(`Interactive host: '${name}'`) + chalk.gray(' — agents show you artifacts there. Clear with --unset.'));
          return;
        }
        const current = getConfigValue('interactive.host').value as string | undefined;
        if (opts.json) {
          writeJson({ interactiveHost: current ?? null });
        } else if (current) {
          console.log(`${chalk.bold('Interactive host:')} ${chalk.cyan(current)}`);
        } else {
          console.log(chalk.gray("No interactive host set. Set one with 'agents devices config <name> interactive.host <name>'."));
        }
      } catch (err: any) {
        console.error(chalk.red(err.message));
        process.exit(1);
      }
    });

  devicesCmd
    .command('configure <name>', { hidden: true })
    .option('--max-agents <n>', 'cap concurrent agents')
    .option('--scheduler <on|off>', 'allow the routines scheduler (daemon) to fire on this device')
    .option('--json', 'output machine-readable JSON')
    .action(async (name: string, opts: { maxAgents?: string; scheduler?: string; inherited?: boolean; json?: boolean }) => {
      try {
        configTombstoneNotice('configure <name> [--max-agents N] [--scheduler on|off]', 'config <name> <key> <value>');
        await mustGetDevice(name);
        const writes: Array<[string, string]> = [];
        if (opts.maxAgents !== undefined) writes.push(['agents.max-concurrent', opts.maxAgents]);
        if (opts.scheduler !== undefined) {
          if (opts.scheduler !== 'on' && opts.scheduler !== 'off') {
            throw new Error(`--scheduler expects 'on' or 'off', got '${opts.scheduler}'.`);
          }
          writes.push(['scheduler.enabled', opts.scheduler]);
        }
        for (const [key, value] of writes) {
          await runDevicesConfig(name, key, [value], { quiet: Boolean(opts.json) });
        }
        if (opts.json) printDevicesConfig(name, true);
        else if (writes.length === 0) printDevicesConfig(name, false);
      } catch (err: any) {
        console.error(chalk.red(err.message));
        process.exit(1);
      }
    });

  devicesCmd
    .command('note <name> [text...]', { hidden: true })
    .option('--clear', 'remove all notes from the device')
    .option('--json', 'output machine-readable JSON')
    .action(async (name: string, text: string[], opts: { clear?: boolean; json?: boolean }) => {
      try {
        configTombstoneNotice('note <name> [text...]', 'config <name> notes <text>');
        await mustGetDevice(name);
        if (opts.clear) {
          await runDevicesConfig(name, 'notes', [], { unset: true, quiet: true });
          if (opts.json) writeJson({ device: name, notes: [] });
          else console.log(chalk.green(`Cleared notes on '${name}'.`));
          return;
        }
        if (text.length > 0) {
          await runDevicesConfig(name, 'notes', text, { quiet: true });
          const notes = (getConfigValue('notes', { device: name }).value as string[] | undefined) ?? [];
          if (opts.json) writeJson({ device: name, notes });
          else console.log(chalk.green(`Noted on '${name}':`) + ` ${text.join(' ')}`);
          return;
        }
        const notes = (getConfigValue('notes', { device: name }).value as string[] | undefined) ?? [];
        if (opts.json) {
          writeJson({ device: name, notes });
        } else if (notes.length > 0) {
          console.log(chalk.bold(`Notes for '${name}'`));
          for (const n of notes) console.log(`  ${chalk.gray('•')} ${n}`);
        } else {
          console.log(chalk.gray(`No notes on '${name}'. Add one with 'agents devices config ${name} notes "..."'.`));
        }
      } catch (err: any) {
        console.error(chalk.red(err.message));
        process.exit(1);
      }
    });

  const runList = async (opts: { json?: boolean; stats?: boolean; full?: boolean; refresh?: boolean; live?: boolean; all?: boolean } = {}) => {
    const reg = await loadDevices();
    const names = Object.keys(reg).sort();
    const interactiveHost = getConfigValue('interactive.host').value as string | undefined;
    if (names.length === 0) {
      if (opts.json) {
        process.stdout.write('[]\n');
        return;
      }
      console.log(chalk.gray("No devices. Run 'agents devices sync' or 'agents devices add <name> <user@host>'."));
      return;
    }
    const self = machineId();
    const forceRefresh = Boolean(opts.refresh || opts.live);

    let statsMap: Map<string, DeviceStats> | undefined;
    let freshness: { oldestFetchedAt: number | null; servedFromCache: boolean } | undefined;
    if (opts.stats !== false) {
      // Cache-first: serve remote devices from the daemon-warmed cache
      // (instant), probe this machine locally, and only ssh out for missing or
      // forced (--refresh/--live) rows — so a warm read never hangs on a box.
      const probeable = planFleetTargets(reg)
        .filter((t) => !t.skip)
        .map((t) => t.device);
      // Only spin when we'll actually ssh (forced, or a cold/partial cache).
      const cache = readStatsCache();
      const willSsh = forceRefresh || probeable.some((d) => d.name !== self && (!cache[d.name] || !isFreshDeviceStats(cache[d.name])));
      const spinner = willSsh && isInteractiveTerminal()
        ? ora(`Probing ${probeable.length} device${probeable.length === 1 ? '' : 's'}…`).start()
        : undefined;
      try {
        const res = await loadFleetStats(probeable, { forceRefresh, selfName: self });
        statsMap = res.stats;
        freshness = res;
      } finally {
        spinner?.stop();
      }
      // Write the live verdict back so this and every other consumer read one
      // reachability truth instead of the stale tailscale snapshot (RUSH-1965).
      if (statsMap) await writeReachability(collectReachabilityWriteBacks(reg, statsMap)).catch(() => {});
    }

    if (opts.json) {
      const jsonRoles = listConfiguredDeviceRoles(names);
      const autoPool = new Set(filterAutoPool(names, { roles: jsonRoles }));
      process.stdout.write(JSON.stringify(names.map((name) => {
        const config = deviceConfigJson(name);
        const health = statsMap?.get(name);
        const description = getConfigValue('description', { device: name }).value;
        return {
          ...resolveDeviceProfile(reg[name]),
          interactive: name === interactiveHost,
          // Roles as machine-readable fields: `role` is what the operator
          // marked (absent when unmarked), `autoPool` is the answer that
          // matters to a caller — may `--device auto` pick this box.
          ...(jsonRoles[name] ? { role: jsonRoles[name] } : {}),
          ...(typeof description === 'string' && description ? { description } : {}),
          autoPool: autoPool.has(name),
          ...(config ? { config } : {}),
          ...(health ? { health: { ...health, headroom: headroom(health) } } : {}),
        };
      }), null, 2) + '\n');
      return;
    }

    console.log(chalk.bold(`Devices (${names.length})`));
    // Dismissed nodes are not devices (never in the registry) — surface their
    // count under the table so a "missing" node is explainable from the list.
    const ignoredCount = loadIgnoredEntries().length;
    for (const line of renderDeviceTable(reg, names, self, statsMap, opts.full, interactiveHost, { ignoredCount })) console.log(line);
    if (freshness?.servedFromCache && freshness.oldestFetchedAt != null) {
      console.log(chalk.gray(`  updated ${formatCheckedAge(freshness.oldestFetchedAt)} — pass --refresh (--live) for a live probe`));
    }
    // Ephemeral crabbox leases live alongside the registered fleet but are never
    // written into the registry — surface them as their own live section, but only
    // behind --all (RUSH-2190). Reading them routes through crabboxEnv, whose
    // bundle auto-detect scans the keychain and can raise a Touch ID sheet AFTER
    // the table has printed — unacceptable for the default list, which hooks and
    // other non-interactive callers rely on. The predicate is exported so the
    // gate itself is unit-tested; keep it the ONLY condition guarding this call.
    if (showLeasedBoxesSection(opts)) {
      for (const line of loadLeasedBoxesSection()) console.log(line);
    }
  };

  devicesCmd.action(runList);

  devicesCmd
    .command('list')
    .alias('ls')
    .description('List registered devices with platform, spec (cores/RAM/disk), live load/mem/disk headroom, role, and description.')
    .option('--json', 'output effective device profiles, config, and health as a JSON array')
    .option('--no-stats', 'skip the live resource probe (instant; names/addresses only)')
    .option('--refresh', 'force a live probe of every device, bypassing the cache')
    .option('--live', 'alias of --refresh (shorter to type)')
    .option('-f, --full', 'full mode: add per-device core count and free/total memory')
    .option('--all', 'also show ephemeral leased boxes (live crabbox call; may need bundle secrets)')
    .action(runList);

  devicesCmd
    .command('status')
    .description('Fleet health at a glance: online/offline rollup, a NEEDS ATTENTION list (each with its fix command), and quiet per-device rows grouped by OS. Use --verbose for the full auth/CLI/sync grid.')
    .option('--json', 'output machine-readable JSON')
    .option('--strict', 'exit non-zero when any device has drift or is unreachable')
    .option('--no-stats', 'skip the live resource probe')
    .option('--refresh', 'force a live probe of every device, bypassing the cache')
    .option('--live', 'alias of --refresh (shorter to type)')
    .option('--local', "this machine only: print THIS host's status row (resource stats + live-agent workload). The publish endpoint the fleet-status read-union reads over ssh.")
    .option('--verbose', 'show the full per-device auth/CLI/sync/version grid instead of the summary')
    .action(async (opts: { json?: boolean; strict?: boolean; stats?: boolean; refresh?: boolean; live?: boolean; local?: boolean; verbose?: boolean }, cmd: Command) => {
      // The root program also defines a global `--verbose`; commander binds a
      // shared long flag to the program, not the leaf. Read the effective value
      // from the merged globals so `fleet status --verbose` works at either level
      // (same pattern as `fleet ping --verbose`).
      const verbose = opts.verbose ?? Boolean(cmd.optsWithGlobals().verbose);
      await runFleetStatus({ ...opts, verbose });
    });

  devicesCmd
    .command('ping')
    .description('Live auth health: complete a real request for every agent account across the fleet (unlike the cached "signed in" flag). Writes the shared auth-health cache read by `agents view` and `fleet status`.')
    .option('--json', 'output machine-readable JSON')
    .option('--local', 'probe only this host (used internally for fan-out)')
    .option('--verbose', 'show a per-account breakdown, not just the per-host rollup')
    .option('--strict', 'exit non-zero when any account is revoked (expired is soft — it self-refreshes)')
    .action(async (opts: { json?: boolean; local?: boolean; verbose?: boolean; strict?: boolean }, cmd: Command) => {
      // The root program also defines a global `--verbose` (startup self-heal
      // detail), and commander binds a shared long flag to the program, not the
      // leaf — so `fleet ping --verbose` never set opts.verbose and the
      // per-account breakdown was silently unreachable. Read the effective value
      // from the merged globals so the flag works at either level.
      const verbose = opts.verbose ?? Boolean(cmd.optsWithGlobals().verbose);
      await runFleetPing({ ...opts, verbose });
    });

  const csvList = (s?: string): string[] | undefined =>
    s ? s.split(',').map((x) => x.trim()).filter(Boolean) : undefined;

  devicesCmd
    .command('pick')
    .description('Print the device automatic placement would choose for offloaded machine work (the suite, a build) — least-loaded, reachable, POSIX, never the box you are sitting at. Writes just the name to stdout so scripts can consume it.')
    .option('--json', 'output the pick plus every candidate and exclusion reason')
    .option('--platform <list>', 'comma-separated platforms to allow (default: linux,macos)')
    .action(async (opts: { json?: boolean; platform?: string }) => {
      const { resolveWorkerDevice } = await import('../lib/devices/worker-pick.js');
      let plan;
      try {
        plan = await resolveWorkerDevice({ platforms: csvList(opts.platform) });
      } catch (err) {
        // Fail loud with the resolver's own message. Never print a device name
        // we did not actually pick: a caller reading stdout would ship a tree to it.
        console.error(err instanceof Error ? err.message : String(err));
        process.exitCode = 1;
        return;
      }
      if (opts.json) {
        console.log(JSON.stringify(plan, null, 2));
        return;
      }
      // stdout is the name alone (`box="$(agents devices pick)"`); the human
      // detail goes to stderr so it never pollutes that capture.
      const detail = plan.candidates
        .map((c) => `${c.device}:${c.loadPercent === undefined ? '?' : `${Math.round(c.loadPercent)}%`}`)
        .join(' ');
      console.error(chalk.gray(`[agents] worker=${plan.device}${plan.isLocal ? ' (this machine)' : ''}  candidates: ${detail}`));
      console.log(plan.device);
    });
  const harnessInvOpts = (opts: {
    agents?: string;
    device?: string;
    devices?: string;
    refresh?: boolean;
    live?: boolean;
    json?: boolean;
    local?: boolean;
  }): HarnessInventoryOpts => ({
    agents: csvList(opts.agents) as AgentId[] | undefined,
    devices: csvList(opts.device ?? opts.devices),
    refresh: opts.refresh || opts.live,
    json: opts.json,
    local: opts.local,
  });

  const harnessesCmd = devicesCmd
    .command('harnesses')
    .description('Per device, one row per installed agent@version: account, signed-in, quota, and a single ready verdict. SSH-probes each online box.')
    .option('--json', 'output machine-readable JSON (per-host rows)')
    .option('--agents <csv>', 'only these agents (comma-separated)')
    .option('--device <csv>', 'only these devices (comma-separated); default: every online box')
    .option('--refresh', 'fetch live quota instead of the cached snapshot (slower)')
    .option('--live', 'alias of --refresh')
    .option('--local', "this host only: emit THIS box's rows (the per-host worker the fan-out reads over ssh)")
    .action(async (opts: { json?: boolean; agents?: string; device?: string; refresh?: boolean; live?: boolean; local?: boolean }) => {
      await runDevicesHarnesses(harnessInvOpts(opts));
    });
  setHelpSections(harnessesCmd, {
    examples: `
agents devices harnesses                 # every box: agent@version · account · signed · quota · ready
agents devices harnesses --agents claude,codex   # just these harnesses
agents devices harnesses --device zion   # one box
agents devices harnesses --refresh       # live quota (bypass the cached snapshot)
agents devices harnesses --json          # machine-readable, per-host rows`,
    notes: `
"ready" = signed in AND not rate-limited — usable for a run right now.
Quota is the cached usage snapshot (the daemon warms it); --refresh fetches live.
Use \`agents devices accounts\` for the same data grouped by account.`,
  });

  const accountsCmd = devicesCmd
    .command('accounts')
    .description('Per device, one row per account: which harnesses share it, signed-in, quota, and ready. The identity lens on `agents devices harnesses`.')
    .option('--json', 'output machine-readable JSON (per-host account groups)')
    .option('--agents <csv>', 'only these agents (comma-separated)')
    .option('--device <csv>', 'only these devices (comma-separated); default: every online box')
    .option('--refresh', 'fetch live quota instead of the cached snapshot (slower)')
    .option('--live', 'alias of --refresh')
    .option('--local', "this host only: emit THIS box's account groups")
    .action(async (opts: { json?: boolean; agents?: string; device?: string; refresh?: boolean; live?: boolean; local?: boolean }) => {
      await runDevicesAccounts(harnessInvOpts(opts));
    });
  setHelpSections(accountsCmd, {
    examples: `
agents devices accounts                  # every box: account · agents · signed · quota · ready
agents devices accounts --device mac-mini
agents devices accounts --json           # machine-readable, per-host account groups`,
    notes: `
Collapses the installs that share one account (e.g. five claude versions on one
email) into a single row. Use \`agents devices harnesses\` for the per-install view.`,
  });

  devicesCmd
    .command('login')
    .description('Log agent CLIs into fleet boxes over SSH: drive each box\'s device-code OAuth, scrape the URL + code, and surface every pending login in one local browser page. Default drives all codes at once; --interactive walks one box at a time (codes requested just-in-time so they don\'t expire).')
    .option('--agents <csv>', 'only these agents (comma-separated); default: every agent with a device-code flow')
    .option('--devices <csv>', 'only these devices (comma-separated); default: every online box')
    .option('--all', 'target every device-code pair regardless of cached login state (cold cache / forced re-login)')
    .option('--interactive', 'guided one-box-at-a-time wizard (codes requested just-in-time)')
    .option('--json', 'output the final result matrix as JSON')
    .action(async (opts: { agents?: string; devices?: string; all?: boolean; interactive?: boolean; json?: boolean }) => {
      const csv = (s?: string) => (s ? s.split(',').map((x) => x.trim()).filter(Boolean) : undefined);
      const results = await runFleetLogin({
        agents: csv(opts.agents),
        devices: csv(opts.devices),
        all: opts.all,
        interactive: opts.interactive,
        json: opts.json,
      });
      if (opts.json) {
        console.log(JSON.stringify(results, null, 2));
      } else {
        for (const line of renderLoginMatrix(results)) console.log(line);
      }
      if (results.some((r) => r.remotable && r.state !== 'authorized')) process.exitCode = 1;
    });

  devicesCmd
    .command('show <name>')
    .description('Show the full profile for one device.')
    .action(async (name: string) => {
      const d = await mustGetDevice(name);
      console.log(JSON.stringify(d, null, 2));
    });

  devicesCmd
    .command('add <name> <target>')
    .description('Add a device manually (target is user@host or host).')
    .option('--platform <platform>', 'windows | linux | macos')
    .action(async (name: string, target: string, opts: { platform?: string }) => {
      try {
        // The one place a device name is CHOSEN rather than observed, so the one
        // place the reserved-sentinel policy belongs. upsertDevice itself stays
        // shape-only — `devices sync` feeds it tailnet node names in a loop.
        assertRegistrableDeviceName(name);
        const { host, user } = splitUserHost(target);
        const isIp = /^\d{1,3}(\.\d{1,3}){3}$/.test(host);
        const d = await upsertDevice(name, {
          platform: (opts.platform as DevicePlatform) ?? undefined,
          user,
          address: { via: 'manual', dnsName: isIp ? undefined : host, ip: isIp ? host : undefined },
        });
        setDeviceDiscoveryStatus(name, 'approved');
        console.log(chalk.green(`Added device '${name}'`) + chalk.gray(` (${d.platform}, ${user ? user + '@' : ''}${host})`));
      } catch (err: any) {
        console.error(chalk.red(err.message));
        process.exit(1);
      }
    });

  devicesCmd
    .command('set <name>', { hidden: true })
    .option('--platform <platform>', 'windows | linux | macos')
    .option('--user <user>', 'login user')
    .option('--auth <method>', 'key | password')
    .option('--bundle <bundle>', 'secrets bundle holding the password (for --auth password)')
    .option('--bundle-key <key>', "key within the bundle (default 'password')")
    .option('--identity-file <path>', 'private-key path for --auth key')
    .option('--clear-identity-file', 'return key auth to ssh-agent/default-key discovery')
    .action(async (name: string, opts: { platform?: string; user?: string; auth?: string; bundle?: string; bundleKey?: string; identityFile?: string; clearIdentityFile?: boolean }) => {
      try {
        configTombstoneNotice('set <name> [--platform|--user|--auth|--bundle|--bundle-key|--identity-file …]', 'config <name> <ssh.*|platform> <value>');
        const existing = await mustGetDevice(name);
        const nextMethod = (opts.auth as DeviceAuthMethod | undefined) ?? resolveDeviceProfile(existing).auth.method;
        if (opts.identityFile && nextMethod !== 'key') {
          throw new Error('--identity-file requires key auth; pass --auth key in the same command.');
        }
        const writes: Array<{ key: string; value?: string }> = [];
        if (opts.platform) writes.push({ key: 'platform', value: opts.platform });
        if (opts.user) writes.push({ key: 'ssh.user', value: opts.user });
        if (opts.auth) writes.push({ key: 'ssh.auth', value: opts.auth });
        if (opts.bundle) writes.push({ key: 'ssh.bundle', value: opts.bundle });
        if (opts.bundleKey) writes.push({ key: 'ssh.bundle-key', value: opts.bundleKey });
        if (opts.identityFile) writes.push({ key: 'ssh.identity-file', value: opts.identityFile });
        if (opts.clearIdentityFile) writes.push({ key: 'ssh.identity-file' }); // unset
        if (writes.length === 0) {
          printDevicesConfig(name, false);
          return;
        }
        for (const w of writes) {
          await runDevicesConfig(name, w.key, w.value !== undefined ? [w.value] : [], { unset: w.value === undefined, quiet: true });
        }
        const d = resolveDeviceProfile((await mustGetDevice(name)));
        console.log(chalk.green(`Updated device '${name}'`) + chalk.gray(` (auth: ${d.auth.method}${d.auth.bundle ? ` via ${d.auth.bundle}` : ''})`));
      } catch (err: any) {
        console.error(chalk.red(err.message));
        process.exit(1);
      }
    });

  devicesCmd
    .command('remove <name>')
    .alias('rm')
    .description('Remove a device from the registry.')
    .action(async (name: string) => {
      const ok = await removeDevice(name);
      if (!ok) {
        console.error(chalk.red(`Unknown device '${name}'.`));
        process.exit(1);
      }
      setDeviceDiscoveryStatus(name, undefined);
      console.log(chalk.green(`Removed device '${name}'`));
    });

  devicesCmd
    .command('render')
    .description('Render the registry to ssh_config. Prints to stdout, or use --write to update ~/.ssh/config.d/agents.')
    .option('--write', 'write to ~/.ssh/config.d/agents instead of printing')
    .action(async (opts: { write?: boolean }) => {
      const reg = await loadDevices();
      const text = renderSshConfig(reg);
      if (!opts.write) {
        process.stdout.write(text);
        return;
      }
      const dir = path.join(os.homedir(), '.ssh', 'config.d');
      const file = path.join(dir, 'agents');
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      fs.writeFileSync(file, text, { mode: 0o600 });
      console.log(chalk.green(`Wrote ${file}`));
      console.log(chalk.gray('Add this to ~/.ssh/config (once):  Include config.d/agents'));
    });

  devicesCmd
    .command('update')
    .description('Roll out agents-cli to every online registered device (`agents upgrade --yes` on each), then verify each box actually runs the new version. Offline devices are skipped.')
    .argument('[version]', 'Target version or dist-tag (default: latest)')
    .addHelpText('after', `
Examples:
  agents fleet update                        # roll out latest, then verify each box
  agents fleet update 1.22.35                # pin the target version
  agents devices update                      # same command under the devices group

After each upgrade the rollout asks the box what \`agents\` resolves to and what
version that copy reports. A box that upgraded with exit 0 but still resolves to
another install — a stale copy in a second node prefix, a Homebrew shim, or a
hand-made link that sits earlier on PATH than the npm global — is reported
\`stale\` with its resolved path, counted as NOT upgraded, and makes the command
exit non-zero. Remove the install that owns the name, or reorder PATH on that
box; \`agents doctor\` names it.

A box whose probe cannot answer (no POSIX shell, e.g. Windows) is reported
\`unverified\` rather than counted as a success.

The upgrade OWNS its global bin links: after installing, it verifies that
\`<prefix>/bin/{agents,ag,browser,computer}\` resolve to the freshly-installed
copy and RESTORES any the package manager dropped — the state that once left a
box upgraded in place but with every \`agents\` invocation "command not found"
(PHNX-2768). A link it cannot make resolve fails the upgrade loud, so that box
is reported \`failed\` (exit non-zero), never a stranded \`ok\`.
`)
    .action(async (version: string | undefined) => {
      let cmd: string[];
      try {
        cmd = upgradeCommand(version);
      } catch (err: any) {
        console.error(chalk.red(err?.message ?? err));
        process.exit(1);
      }
      const reg = await loadDevices();
      const targets = planFleetTargets(reg);
      if (targets.length === 0) {
        console.log(chalk.gray("No devices. Run 'agents devices sync' first."));
        return;
      }
      console.log(chalk.gray(`Running \`${cmd.join(' ')}\` on ${targets.filter((t) => !t.skip).length} online device(s)…`));
      const self = machineId();
      const results = runFleet(targets, cmd, { self });
      // `exit 0` from the upgrade only proves the npm global moved. Ask each box
      // what `agents` actually resolves to before calling the rollout a success
      // (RUSH-2446) — a dev install shadowing the global keeps running old code.
      const verifications = verifyFleetRollout(targets, results, version, { self });
      printFleetResults(results, verifications);
    });

  devicesCmd
    .command('run <cmd...>')
    .description('Run a command on every online registered device. Offline devices are skipped. Alias surface: agents fleet run …')
    .allowUnknownOption()
    .action(async (cmd: string[]) => {
      if (!cmd.length) {
        console.error(chalk.red('Usage: agents fleet run <cmd...>'));
        process.exit(1);
      }
      const reg = await loadDevices();
      const targets = planFleetTargets(reg);
      if (targets.length === 0) {
        console.log(chalk.gray("No devices. Run 'agents devices sync' first."));
        return;
      }
      console.log(chalk.gray(`Running \`${cmd.join(' ')}\` on ${targets.filter((t) => !t.skip).length} online device(s)…`));
      const results = runFleet(targets, cmd, { self: machineId() });
      printFleetResults(results);
    });

  devicesCmd
    .command('ps')
    .description('List agent tasks dispatched to devices with `agents run --device <name> --no-follow`. Reconciles each still-`running` record against the remote before listing. View a log with `agents logs <id>`.')
    .option('--json', 'Output JSON')
    .action((opts: { json?: boolean }) => doDeviceTaskPs(!!opts.json));

  devicesCmd
    .command('stop <id>')
    .alias('kill')
    .description('Terminate a running dispatched task from this machine (SIGTERM the remote process group; marks it failed/143).')
    .action((id: string) => doDeviceTaskStop(id));

  const worktreesCmd = devicesCmd
    .command('worktrees')
    .description("Surface the held set of agent worktrees the sweep only counts, broken into buckets: unmerged-commits (real stranded work), uncommitted-changes, undeterminable. Read-only; --push publishes stranded branches.")
    .option('--json', 'emit the structured held set (device, repo, worktree, branch, reason, age, size) for machine callers / fleet aggregation')
    .option('--home <dir>', 'search root to discover repos under (default: $HOME)')
    .option('--repo <path>', 'scope to a single repo root instead of discovering')
    .option('--bucket <name>', 'show only one bucket: unmerged-commits | uncommitted-changes | undeterminable')
    .option('--fleet', 'fan out across every online device and aggregate the held set fleet-wide')
    .option('--push', 'PUBLISH each unmerged-commits branch that is on no remote (the safe recovery action); never deletes')
    .option('--yes', 'skip the confirmation prompt for --push')
    .action((opts: WorktreesHeldOptions) => runWorktreesHeld(opts));

  setHelpSections(worktreesCmd, {
    examples: `
      Inspect the residue:
        agents fleet worktrees                       # this box, grouped by bucket
        agents fleet worktrees --bucket unmerged-commits
        agents fleet worktrees --json               # structured, for scripts

      Fleet-wide:
        agents fleet worktrees --fleet              # aggregate every online device
        agents fleet run 'agents fleet worktrees --json'  # per-device composition

      Recover stranded work (never deletes):
        agents fleet worktrees --push               # publish on-no-remote branches
    `,
    notes:
      'The nightly worktree-sweep (phnx-labs/.agents) reclaims merged worktrees and HOLDS the rest, reporting only a count. This surfaces that held set. unmerged-commits is the one that matters — a branch with commits on no remote is the PHNX-2951/PHNX-2732 stranded-work class; --push makes it visible. --push and --fleet are mutually exclusive (recovery is per-device on purpose).',
  });
}

interface WorktreesHeldOptions {
  json?: boolean;
  home?: string;
  repo?: string;
  bucket?: string;
  fleet?: boolean;
  push?: boolean;
  yes?: boolean;
}

const BUCKET_ORDER: HeldBucket[] = ['unmerged-commits', 'uncommitted-changes', 'undeterminable'];
const BUCKET_LABEL: Record<HeldBucket, string> = {
  'unmerged-commits': 'unmerged-commits (stranded work — push or open a PR)',
  'uncommitted-changes': 'uncommitted-changes (dirty tree — needs review)',
  'undeterminable': 'undeterminable (broken/locked — re-examine)',
};

function isHeldBucket(v: string): v is HeldBucket {
  return (BUCKET_ORDER as string[]).includes(v);
}

function fmtWtSize(n: number): string {
  if (n < 0) return '?';
  if (n < 1024) return `${n}B`;
  const units = ['K', 'M', 'G', 'T'];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v < 10 ? 1 : 0)}${units[i]}`;
}

/**
 * `agents fleet worktrees` — surface the held set the sweep only counts. Never
 * removes anything; `--push` publishes on-no-remote stranded branches. This is
 * the CLI-native surfacing half of PHNX-3520 (the sweep itself lives in
 * phnx-labs/.agents; it still emits a bare count until a sibling change teaches
 * it to consume this).
 */
async function runWorktreesHeld(opts: WorktreesHeldOptions): Promise<void> {
  if (opts.bucket && !isHeldBucket(opts.bucket)) {
    console.error(chalk.red(`Unknown bucket '${opts.bucket}'. Use one of: ${BUCKET_ORDER.join(', ')}`));
    process.exitCode = 1;
    return;
  }
  if (opts.fleet && opts.push) {
    console.error(chalk.red('--push and --fleet are mutually exclusive; run --push on the device that holds the work.'));
    process.exitCode = 1;
    return;
  }
  if (opts.fleet && opts.repo) {
    console.error(chalk.red('--repo scopes a single local repo and cannot combine with --fleet; drop one. To scope on each device, run `agents fleet run \'agents fleet worktrees --repo <path> --json\'`.'));
    process.exitCode = 1;
    return;
  }

  if (opts.fleet) {
    await runWorktreesHeldFleet(opts);
    return;
  }

  const searchHome = opts.home ?? os.homedir();
  const held = opts.repo
    ? await collectHeldWorktrees(path.resolve(opts.repo))
    : await collectHeldWorktreesUnder(searchHome);

  if (opts.push) {
    await runWorktreesPush(held, opts);
    return;
  }

  const shown = opts.bucket ? held.filter((w) => w.bucket === opts.bucket) : held;

  if (opts.json) {
    console.log(JSON.stringify(shown, null, 2));
    return;
  }

  const summary = summarizeHeld(shown);
  if (summary.total === 0) {
    console.log(chalk.green('No held worktrees — nothing stranded, dirty, or undeterminable.'));
    return;
  }
  for (const bucket of BUCKET_ORDER) {
    const items = summary.buckets[bucket];
    if (items.length === 0) continue;
    const color = bucket === 'unmerged-commits' ? chalk.yellow : chalk.gray;
    console.log('\n' + color(chalk.bold(`${BUCKET_LABEL[bucket]} — ${items.length}`)));
    for (const w of items.sort((a, b) => b.unmergedCommits - a.unmergedCommits)) {
      const detail =
        bucket === 'unmerged-commits'
          ? `${w.unmergedCommits} commit${w.unmergedCommits === 1 ? '' : 's'}, ${w.hasRemoteBranch ? 'on remote' : chalk.red('NO remote')}`
          : bucket === 'uncommitted-changes'
            ? `${w.dirtyFiles} dirty file${w.dirtyFiles === 1 ? '' : 's'}`
            : w.reason;
      console.log(
        `  ${chalk.cyan(w.repoName + '/' + w.name).padEnd(48)} ${chalk.gray((w.branch ?? 'detached').padEnd(28))} ${detail}  ${chalk.dim(`${w.ageDays}d · ${fmtWtSize(w.sizeBytes)}`)}`,
      );
    }
  }
  const stranded = summary.buckets['unmerged-commits'].filter((w) => !w.hasRemoteBranch).length;
  if (stranded > 0) {
    console.log('\n' + chalk.yellow(`${stranded} branch${stranded === 1 ? '' : 'es'} with unmerged commits on no remote. Recover: agents fleet worktrees --push`));
  }
}

/** `--push`: publish every on-no-remote stranded branch. Never deletes. */
async function runWorktreesPush(held: HeldWorktree[], opts: WorktreesHeldOptions): Promise<void> {
  const candidates = held.filter((w) => w.bucket === 'unmerged-commits' && !w.hasRemoteBranch && w.branch);
  if (candidates.length === 0) {
    console.log(chalk.green('No stranded branches to publish (nothing with unmerged commits on no remote).'));
    return;
  }
  if (isInteractiveTerminal() && !opts.yes) {
    console.log(chalk.yellow(`About to push ${candidates.length} stranded branch${candidates.length === 1 ? '' : 'es'} to origin:`));
    for (const w of candidates) console.log(`  ${chalk.cyan(w.repoName + '/' + w.name)} → ${w.branch}`);
    const { confirm } = await import('@inquirer/prompts');
    const go = await confirm({ message: 'Push these branches?', default: true }).catch(() => false);
    if (!go) {
      console.log(chalk.gray('Cancelled — nothing pushed.'));
      return;
    }
  }
  let pushed = 0;
  for (const w of candidates) {
    const res = await pushStrandedBranch(w.repo, w);
    if (res.pushed) {
      pushed++;
      console.log(chalk.green(`  pushed ${w.repoName}/${w.name} (${res.branch})`));
    } else {
      console.log(chalk.yellow(`  skipped ${w.repoName}/${w.name}: ${res.reason}`));
    }
  }
  console.log('\n' + chalk.green(`Published ${pushed}/${candidates.length} stranded branch${candidates.length === 1 ? '' : 'es'}.`));
}

/** `--fleet`: run this same read-only surface on every online device, aggregate. */
async function runWorktreesHeldFleet(opts: WorktreesHeldOptions): Promise<void> {
  const reg = await loadDevices();
  const targets = planFleetTargets(reg);
  const online = targets.filter((t) => !t.skip);
  if (online.length === 0) {
    console.log(chalk.gray("No online devices. Run 'agents devices sync' first."));
    return;
  }
  const self = machineId();
  const remoteCmd = ['agents', 'fleet', 'worktrees', '--json'];
  if (opts.home) remoteCmd.push('--home', opts.home);

  const perDevice: DeviceHeld[] = [];
  for (const t of online) {
    const name = t.device.name;
    const isSelf = name === self || isSelfHost(name);
    const res = isSelf ? runLocalCommand(remoteCmd) : runOnDevice(t.device, remoteCmd);
    if (res.code !== 0) {
      console.error(chalk.gray(`  ${name}: ${(res.stderr || 'failed').trim().slice(0, 120)}`));
      continue;
    }
    try {
      perDevice.push({ device: name, held: JSON.parse(res.stdout) as HeldWorktree[] });
    } catch {
      console.error(chalk.gray(`  ${name}: unparseable output (older CLI?)`));
    }
  }

  // Apply the bucket filter to the per-device inputs BEFORE aggregating, so
  // `total`, per-`devices` totals, and `buckets` all describe the same filtered
  // set — zeroing buckets after the sum leaves `total` counting rows the output
  // no longer lists.
  const scoped = opts.bucket
    ? perDevice.map((d) => ({ device: d.device, held: d.held.filter((w) => w.bucket === opts.bucket) }))
    : perDevice;
  const agg = aggregateHeld(scoped);

  if (opts.json) {
    console.log(JSON.stringify(agg, null, 2));
    return;
  }

  console.log(chalk.bold(`Held worktrees across ${perDevice.length} device(s): ${agg.total}`));
  for (const bucket of BUCKET_ORDER) {
    const items = agg.buckets[bucket];
    if (items.length === 0) continue;
    const color = bucket === 'unmerged-commits' ? chalk.yellow : chalk.gray;
    console.log('\n' + color(chalk.bold(`${BUCKET_LABEL[bucket]} — ${items.length}`)));
    for (const w of items) {
      const dev = (w as HeldWorktree & { device?: string }).device ?? '?';
      const detail = bucket === 'unmerged-commits' ? `${w.unmergedCommits} commits, ${w.hasRemoteBranch ? 'on remote' : chalk.red('NO remote')}` : w.reason;
      console.log(`  ${chalk.magenta(dev.padEnd(14))} ${chalk.cyan((w.repoName + '/' + w.name).padEnd(40))} ${chalk.gray((w.branch ?? 'detached').padEnd(24))} ${detail}`);
    }
  }
}

/**
 * `agents devices ps` — list tasks dispatched to devices (`agents run --device
 * <name> --no-follow`). Heals any 'running' record whose local follower died
 * (dropped connection, laptop sleep) against the remote `.exit` before listing,
 * so a finished run never shows stuck at 'running'.
 */
async function doDeviceTaskPs(json: boolean): Promise<void> {
  const tasks = reconcileRunningTasks(listTasks());
  if (json) {
    console.log(JSON.stringify(tasks, null, 2));
    return;
  }
  if (tasks.length === 0) {
    console.log(chalk.gray('No dispatched tasks yet. Dispatch one: agents run <agent> "<task>" --device <name> --no-follow'));
    return;
  }
  const cols = terminalWidth();
  console.log(chalk.bold('ID').padEnd(11) + chalk.bold('NAME').padEnd(16) + chalk.bold('DEVICE').padEnd(16) + chalk.bold('AGENT').padEnd(10) + chalk.bold('STATUS').padEnd(11) + chalk.bold('PROMPT'));
  for (const t of tasks) {
    const status = t.status === 'completed' ? chalk.green(t.status) : t.status === 'failed' ? chalk.red(t.status) : chalk.yellow(t.status);
    const nameCol = truncateToWidth(t.name ?? chalk.gray('-'), 15).padEnd(16);
    const promptCol = truncateToWidth(t.prompt, Math.max(12, cols - (11 + 16 + 16 + 10 + 11)));
    console.log(t.id.padEnd(11) + nameCol + t.host.padEnd(16) + t.agent.padEnd(10) + status.padEnd(11) + promptCol);
  }
}

/** `agents devices stop <id>` — terminate a running dispatched task from the origin machine. */
async function doDeviceTaskStop(ref: string): Promise<void> {
  // Heal first so we don't try to kill a process that already exited.
  const current = resolveTaskRef(ref);
  if (!current) {
    console.log(chalk.red(`Unknown task "${ref}".`));
    process.exitCode = 1;
    return;
  }
  const task = reconcileRunningTasks([current])[0] ?? current;
  if (task.status !== 'running') {
    console.log(chalk.gray(`Task ${task.id} is already ${task.status}` + (task.exitCode !== undefined ? ` (exit ${task.exitCode})` : '') + '.'));
    return;
  }
  try {
    const stopped = stopDispatchedTask(task);
    const statusColor = stopped.status === 'completed' ? chalk.green : chalk.yellow;
    const exitNote =
      stopped.exitCode === 143
        ? 'exit 143 / SIGTERM'
        : stopped.exitCode !== undefined
          ? `exit ${stopped.exitCode}`
          : stopped.status;
    console.log(
      chalk.green(`Stopped ${stopped.id}`) +
        chalk.gray(` on ${stopped.host}`) +
        '  ' + statusColor(stopped.status) +
        chalk.gray(` (${exitNote})`),
    );
    console.log(chalk.gray(`Logs: agents logs ${stopped.id}`));
  } catch (err: any) {
    console.error(chalk.red(err?.message ?? err));
    process.exitCode = 1;
  }
}

/** Register the `agents ssh` smart wrapper. */
function registerSshWrapper(program: Command): void {
  const sshCmd = program
    .command('ssh <name> [cmd...]')
    .description('Connect to a registered device. Preflights reachability, picks the right shell, and authenticates (key or password-from-bundle).')
    .allowUnknownOption()
    .addHelpText('after', `
Examples:
  agents ssh yosemite-s0                     # interactive login (mirrors your project dir)
  agents ssh win-mini                        # interactive login
  agents ssh win-mini hostname               # run a command (PowerShell on Windows)
  agents ssh yosemite-s0 uptime              # run a command (POSIX)
  agents ssh auto                            # affinity-pick a device (same engine as 'agents run --device auto')

Devices come from 'agents devices'. Password auth pulls the secret from a
secrets bundle via an askpass shim — the password never touches argv.
'auto' picks a remote device by 14-day usage; a pick landing on this machine
is refused with a clear message instead of self-dialing.

An interactive login with no command mirrors the home-relative directory you
launched from — 'agents ssh yosemite-s0' from ~/src/app lands in ~/src/app on
the target when it exists, else the remote home. Same portable-cwd rule as
'agents run --device'. Passing a command keeps the remote home.

An 'agents browser …', 'ag browser …', or standalone 'browser …' command is
stamped AGENTS_FLEET_REMOTE so the target's browser.remote-control consent
gate applies, same as 'agents browser <verb> --device <name>'.
`)
    .action(async (name: string, cmd: string[]) => {
      // Hidden askpass bridge: ssh execs the shim, which re-invokes us here.
      if (name === '__askpass') {
        await runAskpass();
        return;
      }
      // `auto` is the same affinity sentinel `agents run --device auto` resolves
      // (RUSH-2185) — pick the concrete device up front via the SAME engine
      // (resolveDeviceAffinity), rather than leaning on matchHost's generic
      // self-resolution (../lib/hosts/registry.js): `agents ssh` connects OUT to
      // a remote device, so a pick that lands on THIS machine is refused with a
      // clear message instead of self-SSHing — which also holds when this
      // machine was never itself enrolled as a device (matchHost would have
      // nothing to resolve "self" to, and mis-report the pick as "Unknown
      // device").
      let target = name;
      if (isDeviceInteractive(name)) {
        const pinned = resolveInteractiveDevice();
        if (!pinned) {
          console.error(chalk.red(interactiveUnsetError()));
          process.exit(1);
        }
        process.stderr.write(chalk.gray(`[agents] device=interactive → ${pinned}\n`));
        target = pinned;
      }
      if (isDeviceAuto(name)) {
        const plan = resolveDeviceAffinity({});
        if (!plan.host) {
          console.error(chalk.red(`'auto' picked this machine — 'agents ssh' connects to a remote device. Pass a device name; see 'agents devices list'.`));
          process.exit(1);
        }
        process.stderr.write(chalk.gray(`[agents] device=auto → ${plan.host}\n`));
        target = plan.host;
      }
      // Accept the full fleet target grammar: a registered `name`, a
      // `user@device` (same device, login user overridden — dialed via its
      // Tailscale route, not LAN DNS), or an ad-hoc `user@host`/`host` literal.
      // A bare unregistered alias still errors as "Unknown device".
      const resolvedTarget = await resolveDeviceTarget(target);
      if (!resolvedTarget) {
        // Not a registered device — it may be a leased crabbox box slug. ssh into
        // it directly (crabbox@<tailnet|ip>:2222) before giving up.
        trySshLeasedBox(target, cmd); // exits the process on a match
        console.error(chalk.red(`Unknown device '${target}'. See 'agents devices list'.`));
        process.exit(1);
      }
      // The effective profile: central config (ssh.*/platform/user) overlaid on
      // the discovery record.
      const device = resolveDeviceProfile(resolvedTarget);

      // Preflight: a device Tailscale last saw offline would otherwise hang
      // for the full ConnectTimeout. Fail fast with a clear message instead.
      if (device.tailscale && !device.tailscale.online) {
        console.error(chalk.red(`Device '${device.name}' is offline (Tailscale last saw it ${device.tailscale.lastSeen ?? 'a while ago'}).`));
        console.error(chalk.gray("Run 'agents devices sync' to refresh reachability."));
        process.exit(1);
      }
      if (device.tailscale?.online && !device.tailscale.direct) {
        console.error(chalk.yellow(`Note: connection to '${device.name}' is relayed (DERP ${device.tailscale.relay ?? '?'}) — expect higher latency.`));
      }

      try {
        const shim = writeAskpassShim();
        // Pin the host key on first connect and verify strictly thereafter: the
        // managed known_hosts store must exist before ssh writes the learned key
        // into it, and a host already recorded there is checked with
        // StrictHostKeyChecking=yes (RUSH-1767).
        ensureManagedKnownHostsDir();
        const addr = hostNameFor(device);
        const pinned = addr ? isHostPinned(addr) : false;
        // Interactive login (no cmd): mirror the caller's project directory on
        // the target when the same home-relative checkout exists there, matching
        // `agents run --device` (deriveMirroredCwd). Best-effort — a missing dir
        // falls back to the remote home. An explicit `cmd` keeps its cwd (RUSH-2412).
        const mirrorCwd = cmd.length === 0 ? deriveMirroredCwd(process.cwd()) : undefined;
        const { args, env } = buildSshInvocation(device, cmd, shim, { pinned }, { interactiveCwd: mirrorCwd });

        // Interactive login: make the local terminal's terminfo (e.g.
        // xterm-ghostty) available on the remote so backspace/colors/clear work.
        // Best-effort + cached per host — never blocks the login (see terminfo.ts).
        if (cmd.length === 0 && shouldSyncTerminfo({ term: process.env.TERM, shell: device.shell, interactive: process.stdout.isTTY ?? false })) {
          const { args: tinfoArgs, env: tinfoEnv } = buildSshInvocation(device, ['tic', '-x', '-'], shim, { pinned });
          syncTerminfoToDevice({ device, host: terminfoHostKey(device, addr), term: process.env.TERM, sshArgs: tinfoArgs, sshEnv: tinfoEnv });
        }

        const res = spawnSync('ssh', args, {
          stdio: 'inherit',
          env: { ...process.env, ...env },
        });
        process.exit(res.status ?? 1);
      } catch (err: any) {
        console.error(chalk.red(err.message));
        process.exit(1);
      }
    });

  // Keep the hidden askpass invocation out of help.
  void sshCmd;
}

/**
 * The askpass side of password auth. Invoked by the shim (which ssh execs with
 * SSH_ASKPASS): read the target bundle/key from the environment the wrapper
 * set, resolve it through the existing Keychain path, and print the password
 * to stdout for ssh to consume.
 */
async function runAskpass(): Promise<void> {
  const bundle = process.env[ASKPASS_BUNDLE_ENV];
  const key = process.env[ASKPASS_KEY_ENV] ?? 'password';
  if (!bundle) {
    console.error(`askpass: ${ASKPASS_BUNDLE_ENV} not set`);
    process.exit(1);
  }
  // A read-only stats probe sets ASKPASS_AGENT_ONLY_ENV to force a broker-only
  // resolve even under a TTY — so `agents devices` never pops Touch ID just to
  // render load/mem for an uncached password-auth device (RUSH-1970).
  const agentOnly = true;
  try {
    const { env } = await readAndResolveBundleEnv(bundle, { caller: 'agents ssh', keys: [key], keyMode: 'storage', agentOnly });
    const value = env[key];
    if (value === undefined) {
      console.error(`askpass: key '${key}' not found in bundle '${bundle}'`);
      process.exit(1);
    }
    process.stdout.write(value);
  } catch (err: any) {
    console.error(`askpass: ${err?.message ?? err}`);
    process.exit(1);
  }
}

/** Register both `agents ssh` and `agents devices`. */
export function registerSshCommands(program: Command): void {
  registerSshWrapper(program);
  registerDevicesCommands(program);
}
