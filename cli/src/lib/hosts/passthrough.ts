
import chalk from 'chalk';
import { assertValidSshTarget, sshStream } from '../ssh-exec.js';
import { resolveHost, resolveHostByCap } from './registry.js';
import { sshTargetFor, hostIdentityArgs, type Host } from './types.js';
import { dispatchAgentsCommand, withActorEnv } from './dispatch.js';
import {
  stripRoutingFlags,
  buildRemoteAgentsInvocation,
  stripClixml,
  HOST_ROUTING_SPECS,
  type StripSpec,
} from './remote-cmd.js';
import { resolveRemoteOsSync } from './remote-os.js';
import { machineId } from '../machine-id.js';
import { isDeviceAuto, resolveDeviceAffinity } from '../smart-launch.js';
import {
  isDeviceInteractive,
  resolveInteractiveDevice,
  interactiveUnsetError,
} from '../devices/interactive-host.js';
import { flagValue, hasHostRoutingFlag } from './routing-flag.js';
import { loadDevices, type DeviceProfile, type DeviceRegistry } from '../devices/registry.js';
import { isSelfHost } from '../devices/self-host.js';
import { markFleetRemote } from '../devices/connect.js';
import {
  fanOutDevices,
  planFleetTargets,
  runLocalCommand,
  runOnDevice,
  type FleetSkipReason,
  type FanOutDeviceResult,
} from '../devices/fleet.js';
import { platformGroupLabel } from '../devices/health-report.js';
import { isKnownTopLevelCommand } from '../startup/command-registry.js';

export { flagValue, hasHostRoutingFlag } from './routing-flag.js';

interface RemoteSpec {
  nonInteractive?: string[];
  render?: boolean;
  interactiveWhen?: (forwarded: string[]) => boolean;
}

export const REMOTE_PASSTHROUGH: Record<string, RemoteSpec> = {
  view: {
    render: true,
    interactiveWhen: (f) =>
      f.includes('--prune') &&
      !f.includes('--dry-run') &&
      !f.includes('--yes') &&
      !f.includes('-y'),
  },
  inspect: { render: true },
  doctor: { render: true },
  check: {},
  list: {},
  usage: {},
  insights: { render: true },
  config: {},
  sync: { nonInteractive: ['--yes'] },
  pull: {},
  push: {},
  repo: {},
  repos: {},
  plugins: {},
  skills: {},
  hooks: {},
  commands: {},
  rules: {},
  memory: {},
  permissions: {},
  perms: {},
  mcp: {},
  subagents: {},
  workflows: {},
  models: {},
  defaults: {},
  update: {},
  teams: {},
  message: {},
  // `send --channel session --to <id>` types into a session that runs on that box.
  send: {},
  routines: {},
  jobs: {},
  cron: {},
  prune: {},
  trash: {},
  restore: {},
  worktree: {},
  events: {},
  feedback: {},
  tmux: {},
  watchdog: {},
  factory: {},
};

export const OWN_HOST_COMMANDS = new Set([
  // These commands interpret --device as their destination/owner, not generic CLI passthrough.
  'run',
  'exec',
  'harness',
  'harnesses',
  'sessions',
  'ps', // fans out to the named devices itself (old peers answer `sessions --active`)
  'feed',
  'computer',
  'browser',
  'secrets',
  'accounts',
  'logs',
  'hosts',
  'ssh',
  'devices',
  'fleet',
  'apply',
  'monitors',
]);

const STRIP_SPECS: StripSpec[] = [
  ...HOST_ROUTING_SPECS,
  { long: 'no-tty', takesValue: false },
  { long: 'hosts', takesValue: true },
  { long: 'devices', takesValue: true },
];

function firstSubcommand(allArgs: string[], group: string): string | undefined {
  const idx = allArgs.indexOf(group);
  return idx >= 0 ? allArgs.slice(idx + 1).find((a) => !a.startsWith('-')) : undefined;
}

export function buildPassthroughForwardedArgs(
  command: string,
  allArgs: string[],
  interactive: boolean,
): string[] {
  const spec = REMOTE_PASSTHROUGH[command];
  let forwarded = stripRoutingFlags(allArgs, STRIP_SPECS);
  // Read-only sync status must not inherit the mutating non-interactive --yes flag.
  const skipInheritedYes = command === 'sync' && firstSubcommand(forwarded, 'sync') === 'status';
  if (!interactive && spec?.nonInteractive && !skipInheritedYes) {
    forwarded = [...forwarded, ...spec.nonInteractive];
  }
  return forwarded;
}

export function renderForwardDecision(
  command: string,
  allArgs: string[],
  io: { isTTY: boolean; noTty: boolean; columns?: number; rows?: number },
): { noPty: boolean; env?: Record<string, string> } {
  const spec = REMOTE_PASSTHROUGH[command];
  const localTty = io.isTTY && !io.noTty;
  // Pure renders use a pipe; interactive subpaths keep a PTY and JSON suppresses forced color.
  if (!spec?.render || !localTty) return { noPty: false };
  const forwarded = stripRoutingFlags(allArgs, STRIP_SPECS);
  if (spec.interactiveWhen?.(forwarded)) return { noPty: false };
  const env: Record<string, string> = {};
  if (!allArgs.includes('--json')) env.FORCE_COLOR = '1';
  if (io.columns && io.columns > 0) env.COLUMNS = String(io.columns);
  if (io.rows && io.rows > 0) env.LINES = String(io.rows);
  return { noPty: true, env: Object.keys(env).length ? env : undefined };
}

function syntheticHost(target: string): Host {
  const at = target.indexOf('@');
  if (at !== -1) {
    return { name: target, provider: 'local', source: 'inline', user: target.slice(0, at), address: target.slice(at + 1) };
  }
  return { name: target, provider: 'local', source: 'ssh-config' };
}

async function resolveTargetHost(name: string, any: boolean): Promise<Host> {
  const enrolled = await resolveHost(name);
  if (enrolled) return enrolled;
  try {
    return await resolveHostByCap(name, any);
  } catch (e) {
    if (e instanceof Error && e.message.startsWith('Multiple hosts')) throw e;
  }
  assertValidSshTarget(name);
  return syntheticHost(name);
}

interface FleetPassthroughOptions {
  loadDevices?: () => Promise<DeviceRegistry>;
  runner?: typeof runOnDevice;
  localRunner?: typeof runLocalCommand;
  self?: string;
}

interface FleetTargetWithDevice {
  name: string;
  device: DeviceProfile;
  skip?: FleetSkipReason;
}

function isFleetAllSentinel(
  hostFlag: string | undefined,
  deviceFlag: string | undefined,
  hostsFlag: string | undefined,
  devicesFlag: string | undefined,
): boolean {
  return (
    hostFlag?.toLowerCase() === 'all' ||
    deviceFlag?.toLowerCase() === 'all' ||
    hostsFlag?.toLowerCase() === 'all' ||
    devicesFlag?.toLowerCase() === 'all'
  );
}

function buildFleetForwardedArgs(allArgs: string[]): string[] {
  const stripped = stripRoutingFlags(allArgs, STRIP_SPECS);
  if (!stripped.includes('--json')) stripped.push('--json');
  return stripped;
}

function safeJsonParse(stdout: string): unknown {
  try {
    return JSON.parse(stripClixml(stdout));
  } catch {
    return { parseError: 'invalid JSON', snippet: stdout.trim().slice(0, 200) };
  }
}

function summarizeViewResult(forwarded: string[], json: unknown): string {
  const agentArg = forwarded.find((a, i) => i > 0 && !a.startsWith('-'));
  const agent = agentArg
    ? (Array.isArray(json) ? (json[0] as any) : (json as any))
    : undefined;
  if (!agentArg) {
    const rows = Array.isArray(json) ? json : [];
    const count = rows.reduce((n, r: any) => n + (r.versions?.length ?? 0), 0);
    return count === 0 ? 'no agents installed' : `${count} version${count === 1 ? '' : 's'}`;
  }
  if (!agent || !Array.isArray(agent.versions) || agent.versions.length === 0) {
    return 'not installed';
  }
  const v = agent.versions.find((x: any) => x.isDefault) ?? agent.versions[0];
  const parts: string[] = [chalk.cyan(String(v.version))];
  if (v.signedIn) {
    parts.push(chalk.green('active'));
    if (v.email) parts.push(chalk.gray(String(v.email)));
  } else {
    parts.push(chalk.gray('signed out'));
  }
  return parts.join(' · ');
}

function formatCompactUsd(usd: number): string {
  if (usd >= 1000) return `$${(usd / 1000).toFixed(1)}k`;
  if (usd >= 1) return `$${usd.toFixed(2)}`;
  return `$${usd.toFixed(3)}`;
}

function formatCompactTokens(n: number): string {
  const abs = Math.abs(n);
  if (abs >= 1e9) return `${(n / 1e9).toFixed(1)}B`;
  if (abs >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (abs >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return String(n);
}

function summarizeOutputResult(json: unknown): string {
  const p = json as any;
  const burn = p?.burn;
  if (!burn || typeof burn !== 'object') return 'ok';
  const parts: string[] = [];
  if (typeof burn.costUsd === 'number') parts.push(`${formatCompactUsd(burn.costUsd)} burned`);
  if (typeof burn.outputTokens === 'number') parts.push(`${formatCompactTokens(burn.outputTokens)} output tokens`);
  const commits = p?.output?.commits;
  if (typeof commits === 'number' && commits > 0) parts.push(`${commits} commits`);
  return parts.length ? parts.join(' · ') : 'ok';
}

function summarizeSyncResult(json: unknown): string {
  const p = json as { declined?: unknown; versions?: Array<{ declined?: unknown }> } | null;
  const flat = Array.isArray(p?.declined) ? p!.declined as unknown[] : [];
  const perVersion = Array.isArray(p?.versions)
    ? p!.versions.flatMap((v) => (Array.isArray(v?.declined) ? v.declined as unknown[] : []))
    : [];
  const declined = [...flat, ...perVersion];
  if (declined.length === 0) return 'ok';
  return `${declined.length} not written`;
}

function summarizeResult(command: string, forwarded: string[], json: unknown): string {
  if (command === 'view') return summarizeViewResult(forwarded, json);
  if (command === 'insights' && forwarded[1] === 'output') return summarizeOutputResult(json);
  if (command === 'sync') return summarizeSyncResult(json);
  return 'ok';
}

const GROUP_ORDER = ['macOS', 'Linux', 'Windows', 'Other'];

function renderFleetRoster(
  command: string,
  forwarded: string[],
  results: Array<FanOutDeviceResult<unknown> & { device: DeviceProfile }>,
  self: string,
): void {
  const agentArg = forwarded[1];
  const installed = results.filter((r) => r.status === 'ok').length;
  const skipped = results.filter((r) => r.status === 'skipped').length;
  const failed = results.filter((r) => r.status === 'failed').length;

  const title = agentArg ? `${command} ${agentArg}` : command;
  const summaryParts: string[] = [];
  if (installed) summaryParts.push(`${installed} installed`);
  if (failed) summaryParts.push(`${failed} unreachable`);
  if (skipped) summaryParts.push(`${skipped} skipped`);
  console.log(chalk.bold(title) + chalk.gray(` · ${results.length} device${results.length === 1 ? '' : 's'}`));
  console.log('');

  const nameW = Math.max(6, ...results.map((r) => r.name.length));
  const grouped = new Map<string, Array<FanOutDeviceResult<unknown> & { device: DeviceProfile }>>();
  for (const r of results) {
    const g = platformGroupLabel(r.device.platform);
    (grouped.get(g) ?? grouped.set(g, []).get(g)!).push(r);
  }

  for (const group of GROUP_ORDER) {
    const members = grouped.get(group);
    if (!members || members.length === 0) continue;
    members.sort((a, b) => {
      const aSelf = a.name.toLowerCase() === self.toLowerCase();
      const bSelf = b.name.toLowerCase() === self.toLowerCase();
      return (aSelf ? -1 : bSelf ? 1 : 0) || a.name.localeCompare(b.name);
    });
    console.log(chalk.bold(group));
    for (const r of members) {
      const isSelf = r.name.toLowerCase() === self.toLowerCase();
      const prefix = isSelf ? chalk.cyan('▸') : ' ';
      let glyph: string;
      let text: string;
      if (r.status === 'skipped') {
        glyph = chalk.gray('○');
        text = chalk.gray(String(r.reason ?? 'skipped'));
      } else if (r.status === 'failed') {
        glyph = chalk.red('✕');
        text = chalk.red(String(r.error ?? 'unreachable').split('\n')[0].slice(0, 80));
      } else {
        glyph = chalk.green('●');
        text = summarizeResult(command, forwarded, r.value);
      }
      const selfNote = isSelf ? chalk.cyan('   ← this machine') : '';
      console.log(` ${prefix} ${r.name.padEnd(nameW)}  ${glyph}  ${text}${selfNote}`);
    }
    console.log('');
  }

  if (summaryParts.length) {
    console.log(chalk.gray(summaryParts.join(' · ')));
  }
}

export async function runFleetPassthrough(
  command: string,
  allArgs: string[],
  spec: RemoteSpec,
  opts: FleetPassthroughOptions = {},
): Promise<boolean> {
  const self = opts.self ?? machineId();
  const registry = await (opts.loadDevices ?? loadDevices)();
  const planned = planFleetTargets(registry);
  const targets: FleetTargetWithDevice[] = planned.map((t) => ({
    name: t.device.name,
    device: t.device,
    skip: t.skip,
  }));

  const forwarded = buildFleetForwardedArgs(allArgs);
  const runner = opts.runner ?? runOnDevice;
  const localRunner = opts.localRunner ?? runLocalCommand;

  const results = await fanOutDevices<unknown, FleetTargetWithDevice>(
    targets,
    async (target) => {
      const cmd = ['agents', ...forwarded];
      const isSelf = target.device.name.toLowerCase() === self.toLowerCase() || isSelfHost(target.device.name);
      const remoteCmd =
        !isSelf && command === 'browser' ? markFleetRemote(cmd, target.device) : cmd;
      const res = isSelf ? localRunner(cmd) : runner(target.device, remoteCmd);
      if (res.code !== 0) {
        const detail = (res.stderr || res.stdout || 'unreachable').trim().slice(0, 200);
        throw new Error(detail || 'unreachable');
      }
      return safeJsonParse(res.stdout);
    },
    { perDeviceTimeoutMs: 120_000 },
  );

  const typedResults: Array<FanOutDeviceResult<unknown> & { device: DeviceProfile }> = results.map((r, i) => ({
    ...r,
    device: targets[i].device,
  }));

  if (allArgs.includes('--json')) {
    const out: Record<string, unknown> = {};
    for (const r of typedResults) {
      out[r.name] = r.status === 'ok' ? r.value : { error: r.error ?? r.reason ?? 'unknown' };
    }
    console.log(JSON.stringify(out, null, 2));
  } else {
    renderFleetRoster(command, forwarded, typedResults, self);
  }

  const anyFailed = typedResults.some((r) => r.status === 'failed');
  process.exitCode = anyFailed ? 1 : 0;
  return true;
}

export async function maybeRunOnHost(
  command: string,
  allArgs: string[],
  opts?: FleetPassthroughOptions,
): Promise<boolean> {
  const deviceFlag = flagValue(allArgs, 'device', 'D');
  const hostsFlag = flagValue(allArgs, 'hosts');
  const devicesFlag = flagValue(allArgs, 'devices');
  let hostName = deviceFlag;
  const fleetAll = isFleetAllSentinel(undefined, deviceFlag, hostsFlag, devicesFlag);
  if (!hostName && !hostsFlag && !devicesFlag) return false;

  if (OWN_HOST_COMMANDS.has(command)) return false;

  if (command === 'teams') {
    // Team membership/creation and routine placement remain owned by the orchestrator.
    const teamsIdx = allArgs.indexOf('teams');
    const sub = teamsIdx >= 0 ? allArgs.slice(teamsIdx + 1).find((a) => !a.startsWith('-')) : undefined;
    if (sub === 'add' || sub === 'a' || sub === 'create' || sub === 'c' || sub === 'new') {
      return false;
    }
  }

  if (allArgs.includes('--hosts') && hostsFlag?.toLowerCase() !== 'all') return false;
  if (allArgs.includes('--devices')) {
    if (devicesFlag === undefined) return false;
    const isAll = devicesFlag.toLowerCase() === 'all';
    if (!isAll && command !== 'routines') return false;
  }

  if (!isKnownTopLevelCommand(command)) return false;

  const spec = REMOTE_PASSTHROUGH[command];
  if (!spec) {
    console.error(
      chalk.red(
        `\`agents ${command}\` does not support --device (no remote interpretation).`,
      ) +
        chalk.gray(
          ' Run without the flag, or use a device-routable group (repos, view, sync, teams, doctor, …).',
        ),
    );
    process.exitCode = 1;
    return true;
  }


  if (fleetAll) {
    return runFleetPassthrough(command, allArgs, spec, opts);
  }

  if (!hostName) return false;

  // Auto/self resolution that lands here runs locally after routing flags are stripped.
  if (isDeviceAuto(hostName)) {
    const plan = resolveDeviceAffinity({});
    if (!plan.host) {
      const stripped = stripRoutingFlags(allArgs, STRIP_SPECS);
      process.argv = [process.argv[0], process.argv[1], ...stripped];
      return false;
    }
    process.stderr.write(chalk.gray(`[agents] device=auto → ${plan.host}\n`));
    hostName = plan.host;
  }

  if (isDeviceInteractive(hostName)) {
    const pinned = resolveInteractiveDevice();
    if (!pinned) {
      process.stderr.write(`${interactiveUnsetError()}\n`);
      process.exitCode = 1;
      return true;
    }
    process.stderr.write(chalk.gray(`[agents] device=interactive → ${pinned}\n`));
    hostName = pinned;
  }

  if (isSelfHost(hostName)) {
    const stripped = stripRoutingFlags(allArgs, STRIP_SPECS);
    process.argv = [process.argv[0], process.argv[1], ...stripped];
    return false;
  }

  const remoteCwd = flagValue(allArgs, 'remote-cwd');
  const any = allArgs.includes('--any');

  let host: Host;
  try {
    host = await resolveTargetHost(hostName, any);
  } catch (e) {
    console.error(chalk.red(e instanceof Error ? e.message : String(e)));
    process.exitCode = 1;
    return true;
  }
  const target = sshTargetFor(host);

  const { noPty: renderNoPty, env: renderForwardEnv } = renderForwardDecision(command, allArgs, {
    isTTY: !!process.stdout.isTTY,
    noTty: allArgs.includes('--no-tty'),
    columns: process.stdout.columns,
    rows: process.stdout.rows,
  });

  const interactive = !!process.stdout.isTTY && !allArgs.includes('--no-tty') && !renderNoPty;

  const forwarded = buildPassthroughForwardedArgs(command, allArgs, interactive);

  const isWatchedTeamStart = command === 'teams' && forwarded[1] === 'start' && forwarded.includes('--watch');
  if (isWatchedTeamStart) {
    try {
      const { exitCode } = await dispatchAgentsCommand(host, { forwardedArgs: forwarded, remoteCwd });
      process.exitCode = exitCode && exitCode > 0 ? exitCode : 0;
    } catch (e) {
      console.error(chalk.red(e instanceof Error ? e.message : String(e)));
      process.exitCode = 1;
    }
    return true;
  }

  const isDoctorCommand =
    command === 'doctor' || (command === 'teams' && forwarded[1] === 'doctor');
  const remoteOs = resolveRemoteOsSync(host.name);
  const doctorPath = isDoctorCommand && !/^win/i.test((remoteOs ?? '').trim())
    ? { PATH: '$HOME/.agents/.cache/shims:$HOME/.local/bin:$PATH' }
    : undefined;
  const extraEnv =
    doctorPath || renderForwardEnv ? { ...doctorPath, ...renderForwardEnv } : undefined;
  process.exitCode = streamAgentsOnHost(host, forwarded, {
    remoteCwd,
    interactive,
    extraEnv,
    remoteOs,
    target,
  });
  return true;
}

export async function maybeRunStandaloneOnHost(
  command: string,
  opts?: FleetPassthroughOptions,
): Promise<boolean> {
  const rawArgs = process.argv.slice(2);
  if (!hasHostRoutingFlag(rawArgs)) return false;

  if (OWN_HOST_COMMANDS.has(command)) {
    const helpOrVersion = rawArgs.some(
      (a) => a === '--help' || a === '-h' || a === '--version' || a === '-V',
    );
    if (helpOrVersion) {
      process.argv = [process.argv[0], process.argv[1], ...stripRoutingFlags(rawArgs, STRIP_SPECS)];
    }
    return false;
  }

  const helpOrVersion = rawArgs.some(
    (a) => a === '--help' || a === '-h' || a === '--version' || a === '-V',
  );
  if (!helpOrVersion && (await maybeRunOnHost(command, [command, ...rawArgs], opts))) {
    return true;
  }

  process.argv = [process.argv[0], process.argv[1], ...stripRoutingFlags(rawArgs, STRIP_SPECS)];
  return false;
}

export function streamAgentsOnHost(
  host: Host,
  forwardedArgs: string[],
  opts: {
    remoteCwd?: string;
    interactive?: boolean;
    extraEnv?: Record<string, string>;
    remoteOs?: string;
    target?: string;
  } = {},
): number {
  const target = opts.target ?? sshTargetFor(host);
  const remoteOs = opts.remoteOs ?? resolveRemoteOsSync(host.name);
  const env = withActorEnv({ ...opts.extraEnv, AGENTS_FLEET_REMOTE: '1' });
  const remoteCmd = buildRemoteAgentsInvocation(forwardedArgs, opts.remoteCwd, remoteOs, env);
  const code = sshStream(target, remoteCmd, passthroughSshOptions(host, !!opts.interactive));
  if (code === 255) {
    console.error(
      chalk.red(`${host.name}: unreachable over SSH (asleep, offline, or host key changed?).`) +
        chalk.gray(' Check: agents devices status'),
    );
  }
  return code;
}

export function passthroughSshOptions(host: Host, interactive: boolean): {
  tty: boolean;
  multiplex: true;
  extraSshArgs: string[];
} {
  return { tty: interactive, multiplex: true, extraSshArgs: hostIdentityArgs(host) };
}
