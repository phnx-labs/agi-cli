
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

function deviceSummary(
  d: DeviceProfile,
  isSelf = false,
  stats?: DeviceStats,
  isInteractive = false,
  roles?: Record<string, ConfiguredDeviceRole>,
): string {
  d = resolveDeviceProfile(d);
  const addr = hostNameFor(d) ?? chalk.gray('no address');
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
  const roleMap = roles ?? listConfiguredDeviceRoles([d.name]);
  const interactive = isInteractive && roleMap[d.name] !== 'personal' ? chalk.yellow('  ★ interactive') : '';
  const role = roleTag(d.name, roleMap);
  return `${marker}${name} ${String(d.platform).padEnd(8)} ${(d.user ? d.user + '@' : '') + addr}  ${online}${reach}${here}${interactive}${role}`;
}

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

function pctCell(v: number | undefined, width: number): string {
  if (v === undefined) return chalk.gray('—'.padStart(width));
  const s = `${Math.round(v)}%`.padStart(width);
  if (v < 40) return chalk.green(s);
  if (v < 75) return chalk.yellow(s);
  return chalk.red(s);
}

const SPEC_WIDTH_MIN = 12;

function specText(stats: DeviceStats | undefined): string {
  if (!stats?.ncpu) return '—';
  return `${stats.ncpu}c ${fmtBytes(stats.memTotalBytes)} ${fmtBytes(stats.diskTotalBytes)}`;
}

function specColumnWidth(names: string[], statsMap: Map<string, DeviceStats>): number {
  return Math.max(SPEC_WIDTH_MIN, ...names.map((n) => stringWidth(specText(statsMap.get(n)))));
}

function specCell(stats: DeviceStats | undefined, width: number): string {
  const text = specText(stats);
  return (text === '—' ? chalk.gray : chalk.greenBright)(text.padEnd(width));
}

function listDeviceDescriptions(names: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const n of names) {
    const v = getConfigValue('description', { device: n }).value;
    if (typeof v === 'string' && v.length > 0) out[n] = v;
  }
  return out;
}

function fitDeviceRow(fixed: string, role: string, desc: string, width: number): string {
  const w = (s: string) => stringWidth(stripAnsi(s));
  let over = w(fixed) + w(role) + w(desc) - width;
  if (over > 0 && desc) {
    const text = stripAnsi(desc).slice(2);
    const budget = w(text) - over;
    desc = budget > 0 ? '  ' + chalk.gray(truncateToWidth(text, budget)) : '';
    over = w(fixed) + w(role) + w(desc) - width;
  }
  if (over > 0 && role) role = '';
  return fixed + role + desc;
}

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
    const d = resolveDeviceProfile(reg[name]);
    const isSelf = name === self;
    const marker = isSelf ? chalk.cyan('▸ ') : '  ';
    const label = isSelf ? chalk.bold.cyan(name.padEnd(16)) : chalk.bold(name.padEnd(16));
    const plat = String(d.platform).padEnd(8);
    const stats = statsMap.get(name);
    const role = roleTag(name, deviceRoles);
    const desc = descriptions[name] ? '  ' + chalk.gray(descriptions[name]) : '';
    const offline = deviceOnlineState(d, stats) === 'offline';
    if (offline) {
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

function loadLeasedBoxesSection(): string[] {
  try {
    const boxes = crabboxList({ secretsBundle: process.env.AGENTS_LEASE_SECRETS_BUNDLE, timeoutMs: 5000 });
    return renderLeasedBoxesSection(boxes, Math.floor(Date.now() / 1000));
  } catch {
    return [];
  }
}

export function showLeasedBoxesSection(opts: { all?: boolean; stats?: boolean }): boolean {
  return opts.all === true && opts.stats !== false;
}

function trySshLeasedBox(name: string, cmd: string[]): boolean {
  let box: CrabboxBox | null;
  try {
    box = crabboxFind(name, { secretsBundle: process.env.AGENTS_LEASE_SECRETS_BUNDLE, timeoutMs: 5000 });
  } catch {
    return false;
  }
  if (!box) return false;
  const sshArgv = crabboxSshArgv(name, { secretsBundle: process.env.AGENTS_LEASE_SECRETS_BUNDLE, timeoutMs: 8000 });
  if (!sshArgv) {
    console.error(chalk.red(`Leased box '${name}' is not reachable yet (status: ${boxStatus(box)}).`));
    process.exit(1);
  }
  const remoteCmd = leasedBoxRemoteCmd(cmd);
  const res = spawnSync(sshArgv[0], [...sshArgv.slice(1), ...remoteCmd], { stdio: 'inherit' });
  process.exit(res.status ?? 1);
}

export function leasedBoxRemoteCmd(cmd: string[]): string[] {
  // Browser driving on a lease carries the fleet-remote consent marker.
  return isAgentsBrowserDrive(cmd) ? markFleetRemote(cmd, { shell: 'posix' }) : cmd;
}

async function mustGetDevice(name: string): Promise<DeviceProfile> {
  const d = await getDevice(name);
  if (!d) {
    console.error(chalk.red(`Unknown device '${name}'. See 'agents devices list'.`));
    process.exit(1);
  }
  return d;
}

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
  dialTarget: string;
  extraSshArgs?: string[];
}
// Fleet calls use the live Tailscale dial target, not drift-prone bare ssh aliases.

async function localHealthRow(self: string, stats?: DeviceStats): Promise<FleetHealthRow> {
  return {
    name: self,
    platform: process.platform === 'darwin' ? 'macos' : process.platform,
    version: getCliVersion(),
    stats,
    clis: checkAllClis(),
    sync: checkSyncStatus(process.cwd()),
    orphans: countOrphans(),
    inventory: await collectLocalFleetInventory(process.cwd()),
  };
}

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
    auth: parsed.auth,
    inventory: parsed.fleet,
  };
}

function deviceConfigJson(name: string): Record<string, unknown> | undefined {
  const config: Record<string, unknown> = {};
  for (const entry of listConfig({ device: name })) {
    if (entry.source !== 'device') continue;
    config[entry.spec.yamlKey] = entry.value;
  }
  return Object.keys(config).length > 0 ? config : undefined;
}

async function runFleetStatus(opts: { json?: boolean; strict?: boolean; stats?: boolean; refresh?: boolean; live?: boolean; local?: boolean; verbose?: boolean }): Promise<void> {
  const reg = await loadDevices();
  const self = machineId();
  const forceRefresh = Boolean(opts.refresh || opts.live);

  if (opts.local) {
    const { publishLocalFleetStatus } = await import('../lib/fleet-status.js');
    const row = await publishLocalFleetStatus(self);
    if (opts.json) console.log(JSON.stringify(row, null, 2));
    else console.log(`${self}: ${row.agents.running} running agent(s), ${row.agents.live} live`);
    return;
  }
  const planned = planFleetTargets(reg);
  const probeable = planned.filter((t) => !t.skip).map((t) => t.device);
  const statsMap = opts.stats === false
    ? new Map<string, DeviceStats>()
    : (await loadFleetStats(probeable, { forceRefresh, selfName: self })).stats;

  await writeReachability(collectReachabilityWriteBacks(reg, statsMap)).catch(() => {});

  const rows: FleetHealthRow[] = [await localHealthRow(self, statsMap.get(self))];
  const remoteTargets: FleetStatusTarget[] = remoteFleetTargets(planned, self)
    .map((t) => ({
      name: t.device.name,
      platform: resolveDeviceProfile(t.device).platform,
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

  const authCache = readAuthHealthCache();
  for (const row of rows) {
    if (!row.auth) row.auth = summarizeHostAuth(authCache, row.name);
    const profile = reg[row.name];
    if (profile) {
      row.online = deviceOnlineState(profile, statsMap.get(row.name));
      row.lastSeen = profile.tailscale?.lastSeen ?? profile.reachability?.checkedAt;
    }
  }

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
    for (const line of renderFleetWarnings(report)) console.log(line);
    console.log();
    for (const line of renderFleetMatrix(report)) console.log(line);
  } else {
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

  if (opts.local) {
    const { authRows: rows } = await refreshLocalFleetAuthState({ force: true });
    if (opts.json) {
      const { collectRunCandidates } = await import('../lib/accounting/rotate.js');
      const launchable = (await Promise.all(ALL_AGENT_IDS.map(async (agent) =>
        (await collectRunCandidates(agent)).some((candidate) => candidate.signedIn) ? agent : null,
      ))).filter((agent): agent is AgentId => agent !== null);
      console.log(JSON.stringify({ host: self, rows, launchable }));
    } else {
      for (const line of renderAuthMatrix([{ host: self, rows }], { verbose: opts.verbose })) console.log(line);
    }
    if (opts.strict && rows.some((r) => isDeadVerdict(r.health.verdict))) {
      process.exitCode = 1;
    }
    return;
  }

  const reg = await loadDevices();
  const planned = planFleetTargets(reg);
  const results: FleetPingHostResult[] = [];

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


export interface HarnessInventoryOpts {
  agents?: AgentId[];
  devices?: string[];
  refresh?: boolean;
  json?: boolean;
  local?: boolean;
}

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

const CELL_PAINT: Record<AuthCellColor, (s: string) => string> = {
  green: chalk.green,
  yellow: chalk.yellow,
  red: chalk.red,
  gray: chalk.gray,
  dim: chalk.dim,
};

function authCell(summary: VerdictSummary, width: number): string {
  if (summary.total === 0) return chalk.dim('·'.padEnd(width));
  const ok = summary.live + summary.present;
  const padded = `${ok}/${summary.total}`.padEnd(width);
  return CELL_PAINT[authCellColor(summary)](padded);
}

function renderAuthMatrix(results: FleetPingHostResult[], opts?: { verbose?: boolean }): string[] {
  const present = new Set<string>();
  for (const r of results) for (const row of r.rows) present.add(row.agent);
  const agents = ALL_AGENT_IDS.filter((a) => present.has(a));
  const cellW = 6;
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
        agents devices disable mac-mini                       # leave the auto-placement pool (auto-launch.enabled off)
        agents devices enable mac-mini                        # rejoin it
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
    { title: 'Fleet operations', names: ['update', 'run', 'capture', 'apply', 'worktrees'] },
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

  registerFleetCaptureCommand(devicesCmd);

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
        await removeIgnored(name);
        const d = await upsertDevice(name, nodeToDeviceInput(node));
        setDeviceDiscoveryStatus(name, 'approved');
        clearPendingSentinel(name);
        console.log(chalk.green(`Registered '${name}'`) + chalk.gray(` (${d.platform})`));
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
        clearPendingSentinel(name);
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
      await removeIgnored(name);
      setDeviceDiscoveryStatus(name, undefined);
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

  const deviceConfigEntries = (name: string) =>
    listConfig({ device: name }).filter((e) => e.spec.scope === 'device');

  const entryValueText = (e: ConfigEntry): string => {
    if (e.source === 'default') return chalk.gray('— (default)');
    const tag = e.source === 'fleet' ? chalk.yellow('  (fleet default)') : e.source === 'user' ? chalk.gray('  (user scope)') : '';
    return chalk.cyan(JSON.stringify(e.value)) + tag;
  };

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

  const runDevicesConfig = async (
    name: string | undefined,
    key: string | undefined,
    valueParts: string[],
    opts: { unset?: boolean; json?: boolean; quiet?: boolean; fleet?: boolean },
  ): Promise<void> => {
    const spec = key ? configKeySpec(key) : undefined;

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

    if (opts.json || !isInteractiveTerminal()) {
      printDevicesConfig(name!, Boolean(opts.json));
      return;
    }
    await runDevicesConfigMenu(name!);
  };

  const runDevicesRole = async (
    name: string | undefined,
    role: string | undefined,
    opts: { clear?: boolean; json?: boolean },
  ): Promise<void> => {
    if (!name) {
      if (role) throw new Error('Name a device: agents devices role <name> <worker|personal|desktop>');
      const reg = await loadDevices();
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

    setConfiguredDeviceRole(name, role as ConfiguredDeviceRole);
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
      if (isPromptCancelled(err)) return;
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

      configure, note, set, set-interactive, prefer, and unprefer are deleted;
      use this command directly (auto-launch.preferred, interactive.host, or
      any other key). enable/disable stay as first-class sugar over
      auto-launch.enabled.
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
      const probeable = planFleetTargets(reg)
        .filter((t) => !t.skip)
        .map((t) => t.device);
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
    const ignoredCount = loadIgnoredEntries().length;
    for (const line of renderDeviceTable(reg, names, self, statsMap, opts.full, interactiveHost, { ignoredCount })) console.log(line);
    if (freshness?.servedFromCache && freshness.oldestFetchedAt != null) {
      console.log(chalk.gray(`  updated ${formatCheckedAge(freshness.oldestFetchedAt)} — pass --refresh (--live) for a live probe`));
    }
    if (showLeasedBoxesSection(opts)) {
      for (const line of loadLeasedBoxesSection()) console.log(line);
    }
  };

  devicesCmd.action(runList);

  devicesCmd
    .command('enable <name>')
    .description('Put a device back in the automatic-placement pool (clears auto-launch.enabled)')
    .action(async (name: string) => {
      try {
        await mustGetDevice(name);
        await runDevicesConfig(name, 'auto-launch.enabled', [], { unset: true, quiet: true });
        console.log(chalk.green(`Enabled '${name}'`) + chalk.gray(' for automatic placement.'));
      } catch (err: any) {
        console.error(chalk.red(err.message));
        process.exit(1);
      }
    });

  devicesCmd
    .command('disable <name>')
    .description('Drop a device from every automatic-placement path (sets auto-launch.enabled off)')
    .action(async (name: string) => {
      try {
        await mustGetDevice(name);
        await runDevicesConfig(name, 'auto-launch.enabled', ['off'], { quiet: true });
        console.log(chalk.green(`Disabled '${name}'`) + chalk.gray(' for automatic placement.'));
      } catch (err: any) {
        console.error(chalk.red(err.message));
        process.exit(1);
      }
    });

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
        console.error(err instanceof Error ? err.message : String(err));
        process.exitCode = 1;
        return;
      }
      if (opts.json) {
        console.log(JSON.stringify(plan, null, 2));
        return;
      }
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

async function doDeviceTaskStop(ref: string): Promise<void> {
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

export function parseArgvJson(raw: string, log: (line: string) => void = (line) => console.error(line)): string[] | undefined {
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch (error) {
    log(`--argv is not valid JSON: ${(error as Error).message}`);
    log(`Expected a JSON array of strings, e.g. --argv '["uptime","-p"]'`);
    return undefined;
  }
  if (!Array.isArray(parsed)) {
    log('--argv must be a JSON ARRAY of strings.');
    return undefined;
  }
  const bad = parsed.findIndex((token) => typeof token !== 'string');
  if (bad >= 0) {
    log(`--argv element ${bad} is ${typeof parsed[bad]}, not a string.`);
    log('Every element is one argv token; numbers and objects have no argv meaning.');
    return undefined;
  }
  return parsed as string[];
}

function registerSshWrapper(program: Command): void {
  const sshCmd = program
    .command('ssh <name> [cmd...]')
    .description('Connect to a registered device. Preflights reachability, picks the right shell, and authenticates (key or password-from-bundle).')
    .allowUnknownOption()
    .option('--argv <json>', 'run a JSON array of argv tokens with exact per-token fidelity (no shell splitting)')
    .addHelpText('after', `
Examples:
  agents ssh yosemite-s0                     # interactive login (mirrors your project dir)
  agents ssh win-mini                        # interactive login
  agents ssh win-mini hostname               # run a command (PowerShell on Windows)
  agents ssh yosemite-s0 uptime              # run a command (POSIX)
  agents ssh auto                            # affinity-pick a device (same engine as 'agents run --device auto')
  agents ssh box --argv '["agents","feed","post","--title","two words","a & b"]'
                                             # exact tokens: spaces and metacharacters survive

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

--argv takes a JSON array of strings and delivers each element as exactly ONE
token on the peer, so a token containing a space, '&', '|', '$' or a quote
arrives intact. The positional form keeps its existing semantics — the remote
shell parses it — so the two are mutually exclusive rather than interchangeable.
`)
    .action(async (name: string, cmd: string[], opts: { argv?: string }) => {
      if (opts.argv !== undefined && cmd.length > 0) {
        console.error(chalk.red('Pass either --argv <json> or a positional command, not both.'));
        console.error(chalk.gray('--argv delivers exact tokens; the positional form is parsed by the remote shell.'));
        process.exit(1);
      }
      let argvTokens: string[] | undefined;
      if (opts.argv !== undefined) {
        argvTokens = parseArgvJson(opts.argv);
        if (!argvTokens) process.exit(1);
        if (argvTokens.length === 0) {
          console.error(chalk.red('--argv needs at least one token (the program to run).'));
          process.exit(1);
        }
        cmd = argvTokens;
      }
      if (name === '__askpass') {
        await runAskpass();
        return;
      }
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
      const resolvedTarget = await resolveDeviceTarget(target);
      if (!resolvedTarget) {
        trySshLeasedBox(target, cmd);
        console.error(chalk.red(`Unknown device '${target}'. See 'agents devices list'.`));
        process.exit(1);
      }
      const device = resolveDeviceProfile(resolvedTarget);

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
        ensureManagedKnownHostsDir();
        const addr = hostNameFor(device);
        const pinned = addr ? isHostPinned(addr) : false;
        // First contact may pin once; subsequent calls stay strict-known-hosts.
        const mirrorCwd = cmd.length === 0 ? deriveMirroredCwd(process.cwd()) : undefined;
        const { args, env } = buildSshInvocation(device, cmd, shim, { pinned }, { interactiveCwd: mirrorCwd, ...(argvTokens ? { argv: true } : {}) });

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

  void sshCmd;
}

async function runAskpass(): Promise<void> {
  const bundle = process.env[ASKPASS_BUNDLE_ENV];
  const key = process.env[ASKPASS_KEY_ENV] ?? 'password';
  if (!bundle) {
    console.error(`askpass: ${ASKPASS_BUNDLE_ENV} not set`);
    process.exit(1);
  }
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

export function registerSshCommands(program: Command): void {
  registerSshWrapper(program);
  registerDevicesCommands(program);
}
