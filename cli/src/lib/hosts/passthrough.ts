/** Generic `--device` passthrough: the one choke point running an allowlisted `agents <command>`
 * remotely, called from index.ts before commander parses (true = handled). SSH, never a daemon.
 * OWN_HOST_COMMANDS keep their own handling; others get "not supported". */

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
// Leaf import: `session/sync/config.js` re-exports machineId from machine-id.js
// but pulling the re-export path drags secrets/bundles (~140ms cold). Same value,
// 6–7× cheaper graph (RUSH-2374 proposal 2).
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

/** Re-export for callers that historically imported flagValue from this module. */
export { flagValue, hasHostRoutingFlag } from './routing-flag.js';

/** Per-command remote behaviour. Absence from this map = not host-routable here. */
interface RemoteSpec {
  /** Flags appended when running non-interactively (no local TTY / `--no-tty`). */
  nonInteractive?: string[];
  /** Pure read-only render command: forwarded over a plain pipe rather than `ssh -tt`, because
   * PTY teardown on a clean exit wipes the drawn output (PHNX-3583). Color and geometry are
   * forced into the remote env (renderForwardDecision). */
  render?: boolean;
  /** For a render command with a narrow interactive sub-path, true when this argv hits it,
   * keeping the PTY. Absent means the command never prompts and is safe over a pipe. */
  interactiveWhen?: (forwarded: string[]) => boolean;
}

/** First-class groups that run on a remote via SSH when `--device` is present; keep canonical
 * names and aliases. Every key must be a real top-level command (KNOWN_TOP_LEVEL_COMMANDS,
 * asserted in passthrough.test.ts); others are dead because maybeRunOnHost rejects them first. */
export const REMOTE_PASSTHROUGH: Record<string, RemoteSpec> = {
  // inspect — pure read-only renders: forward over a pipe, never a forced PTY
  // (PHNX-3583), so the drawn output persists instead of vanishing on exit.
  view: {
    render: true,
    // Only `--prune` (without --yes/--dry-run) asks a confirm(); that one
    // invocation needs the PTY. Every other `view` is a pure render.
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
  // config / resources
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
  // Installations are per-machine, so updating one on a peer means running it
  // there — the same local/remote shape `add` would need.
  update: {},
  // lifecycle
  teams: {},
  message: {},
  routines: {},
  jobs: {},
  cron: {},
  // misc remote-sensible
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

/** Commands that register and interpret `--device` themselves; they fall through to local
 * commander. Do not add them to REMOTE_PASSTHROUGH. */
export const OWN_HOST_COMMANDS = new Set([
  'run',
  'exec', // deprecated alias of run
  'harness', // `--host <agent>` names the host CLI to run under (not a device routing flag)
  'harnesses',
  'sessions',
  'feed',
  'computer',
  'browser', // `--device` on start binds the task; later verbs resolve it from the task
  'secrets',
  'accounts', // `accounts sync --device` names the destination, not remote routing
  'logs',
  'hosts',
  'ssh',
  'devices',
  'fleet', // alias of devices
  'apply', // `--device` scopes the fleet reconcile to one device (it targets devices itself)
  'monitors', // `--device` names the OWNER machine (pin-to-one), not a routing target
]);

/** `--no-tty` is stripped like the routing flags but carries no value. The plural
 * fleet flags are stripped only when we handle the `all` sentinel ourselves;
 * otherwise they fall through to command-level aggregators. */
const STRIP_SPECS: StripSpec[] = [
  ...HOST_ROUTING_SPECS,
  { long: 'no-tty', takesValue: false },
  { long: 'hosts', takesValue: true },
  { long: 'devices', takesValue: true },
];

/** First non-flag token after `group` in argv (the subcommand, robust to leading flags). */
function firstSubcommand(allArgs: string[], group: string): string | undefined {
  const idx = allArgs.indexOf(group);
  return idx >= 0 ? allArgs.slice(idx + 1).find((a) => !a.startsWith('-')) : undefined;
}

/** Argv forwarded over SSH for a passthrough. `sync` appends `--yes` with no TTY to avoid a
 * picker hang, but `sync status` stays inspect-only unless the caller typed `--yes`, since
 * there it means reconcile (RUSH-2864). */
export function buildPassthroughForwardedArgs(
  command: string,
  allArgs: string[],
  interactive: boolean,
): string[] {
  const spec = REMOTE_PASSTHROUGH[command];
  let forwarded = stripRoutingFlags(allArgs, STRIP_SPECS);
  // Detect the subcommand on the *stripped* argv. On the raw argv,
  // `sync --device peer status` would treat `peer` as the first non-flag
  // token and inherit umbrella `--yes` (RUSH-2864 review).
  const skipInheritedYes = command === 'sync' && firstSubcommand(forwarded, 'sync') === 'status';
  if (!interactive && spec?.nonInteractive && !skipInheritedYes) {
    forwarded = [...forwarded, ...spec.nonInteractive];
  }
  return forwarded;
}

/** Decide whether a passthrough forwards over a plain pipe instead of a PTY, and which
 * color/geometry env to inject (PHNX-3583). Only for a real local terminal; the narrow
 * interactive sub-path keeps the PTY; FORCE_COLOR is withheld under `--json`. */
export function renderForwardDecision(
  command: string,
  allArgs: string[],
  io: { isTTY: boolean; noTty: boolean; columns?: number; rows?: number },
): { noPty: boolean; env?: Record<string, string> } {
  const spec = REMOTE_PASSTHROUGH[command];
  const localTty = io.isTTY && !io.noTty;
  if (!spec?.render || !localTty) return { noPty: false };
  const forwarded = stripRoutingFlags(allArgs, STRIP_SPECS);
  if (spec.interactiveWhen?.(forwarded)) return { noPty: false };
  const env: Record<string, string> = {};
  if (!allArgs.includes('--json')) env.FORCE_COLOR = '1';
  if (io.columns && io.columns > 0) env.COLUMNS = String(io.columns);
  if (io.rows && io.rows > 0) env.LINES = String(io.rows);
  return { noPty: true, env: Object.keys(env).length ? env : undefined };
}

/** Synthesize a `Host` for a raw `user@host` / bare-alias target (not enrolled). */
function syntheticHost(target: string): Host {
  const at = target.indexOf('@');
  if (at !== -1) {
    return { name: target, provider: 'local', source: 'inline', user: target.slice(0, at), address: target.slice(at + 1) };
  }
  // Bare name: ssh resolves it from ~/.ssh/config, or connects to it as a hostname.
  return { name: target, provider: 'local', source: 'ssh-config' };
}

/** Resolve a `--device` value to a Host: enrolled name → capability tag → raw target. */
async function resolveTargetHost(name: string, any: boolean): Promise<Host> {
  const enrolled = await resolveHost(name);
  if (enrolled) return enrolled;
  try {
    return await resolveHostByCap(name, any);
  } catch (e) {
    // "Multiple hosts tagged …" is actionable — surface it. "No host tagged" falls
    // through to treating the value as a literal ssh target.
    if (e instanceof Error && e.message.startsWith('Multiple hosts')) throw e;
  }
  assertValidSshTarget(name); // rejects injection / flag-smuggling before it reaches ssh
  return syntheticHost(name);
}

/** Injectable dependencies for {@link runFleetPassthrough} — used by tests. */
interface FleetPassthroughOptions {
  /** Override the device registry loader (tests). */
  loadDevices?: () => Promise<DeviceRegistry>;
  /** Override the per-device runner (tests). Defaults to `runOnDevice`. */
  runner?: typeof runOnDevice;
  /** Override the local runner for the self device (tests). Defaults to `runLocalCommand`. */
  localRunner?: typeof runLocalCommand;
  /** Override this machine's id (tests). Defaults to `machineId()`. */
  self?: string;
}

interface FleetTargetWithDevice {
  name: string;
  device: DeviceProfile;
  skip?: FleetSkipReason;
}

/** Detect the `all` sentinel on any routing flag. */
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

/** Strip routing flags from the argv and ensure the per-device call emits JSON. */
function buildFleetForwardedArgs(allArgs: string[]): string[] {
  const stripped = stripRoutingFlags(allArgs, STRIP_SPECS);
  if (!stripped.includes('--json')) stripped.push('--json');
  return stripped;
}

/** Parse stdout as JSON; on failure return an object describing the error. */
function safeJsonParse(stdout: string): unknown {
  try {
    // A Windows device relays its `--json` through PowerShell, which can prefix a
    // CLIXML banner ahead of the payload — strip it before parsing (RUSH-2286).
    return JSON.parse(stripClixml(stdout));
  } catch {
    return { parseError: 'invalid JSON', snippet: stdout.trim().slice(0, 200) };
  }
}

/** One-line summary of a per-device `agents view [agent] --json` payload. */
function summarizeViewResult(forwarded: string[], json: unknown): string {
  // After routing flags are stripped, the agent argument is the first token that
  // is not a flag (e.g. `kimi` in `agents view kimi --json`).
  const agentArg = forwarded.find((a, i) => i > 0 && !a.startsWith('-'));
  // `agents view --json` returns an array; `agents view <agent> --json` returns
  // a single object. Normalize to the per-agent shape.
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

/** One-line summary of a per-device `agents insights output --json` payload. */
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

/** Summarize a `sync` payload, surfacing anything the peer refused to write (RUSH-2700), so
 * `agents sync --device all` no longer shows a green row for a box whose config was never
 * written. Handles the umbrella and per-agent `declined` shapes. */
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

/** Best-effort summary of any per-device JSON payload. */
function summarizeResult(command: string, forwarded: string[], json: unknown): string {
  if (command === 'view') return summarizeViewResult(forwarded, json);
  // #2621 nested `output` under `insights`; main added a sync declined tally.
  if (command === 'insights' && forwarded[1] === 'output') return summarizeOutputResult(json);
  if (command === 'sync') return summarizeSyncResult(json);
  return 'ok';
}

const GROUP_ORDER = ['macOS', 'Linux', 'Windows', 'Other'];

/** Render the grouped-by-OS fleet roster from per-device results. */
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

/** Run `agents <command> …` across every registered device and render the roster. */
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
      // Only `browser` reads the fleet-remote marker (its consent gate) and the fan-out has no env
      // channel, so the marker rides the argv; scope the env-prefix to a remote browser drive so
      // other remote argv stay identical and self is never gated.
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

  // Map fan-out results back to typed results with device attached for rendering.
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

/** Route `agents <command> … --device <name>` to a remote when device-routable. Returns false
 * (run locally) for no flag, own handling, self target or placement flags; for a non-routable
 * command prints an error and returns true, avoiding commander's raw `unknown option`. */
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
  // Proceed when any routing flag is present, including the plural fleet flags
  // that may carry the `all` sentinel.
  if (!hostName && !hostsFlag && !devicesFlag) return false;

  // Commands with their own richer --device semantics must reach local commander
  // directly. sessions/feed handle multi-host lists themselves; fall through so
  // those flags reach the local action.
  if (OWN_HOST_COMMANDS.has(command)) return false;

  // Placement, not routing: `teams add`/`create` read `--device`/`--devices`/`--hosts` as where to
  // place a teammate and always run locally, so bail before the generic teams routing; other teams
  // subcommands keep `--device` routing.
  if (command === 'teams') {
    const teamsIdx = allArgs.indexOf('teams');
    const sub = teamsIdx >= 0 ? allArgs.slice(teamsIdx + 1).find((a) => !a.startsWith('-')) : undefined;
    if (sub === 'add' || sub === 'a' || sub === 'create' || sub === 'c' || sub === 'new') {
      return false;
    }
  }

  // `--hosts` / `--devices` are command-level fleet flags unless their value is
  // the `all` sentinel, which this module fans out generically. On `routines`,
  // a non-all `--devices` value is placement (which devices may run the routine).
  if (allArgs.includes('--hosts') && hostsFlag?.toLowerCase() !== 'all') return false; // legacy plural sentinel; prefer --devices
  if (allArgs.includes('--devices')) {
    if (devicesFlag === undefined) return false; // malformed, let commander error
    const isAll = devicesFlag.toLowerCase() === 'all';
    if (!isAll && command !== 'routines') return false;
  }

  // A nonexistent command is an unknown-command error, not a routing error. The router runs before
  // commander, so a typo like `agents session` got "does not support --device"; fall through so
  // commander reports `unknown command` (RUSH-2022).
  if (!isKnownTopLevelCommand(command)) return false;

  const spec = REMOTE_PASSTHROUGH[command];
  if (!spec) {
    // Flag was accepted (no raw commander "unknown option") but this group has
    // no remote semantics — say so clearly instead of falling through.
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

  // Reject duplicate --device flags before either the fleet fan-out
  // or single-target path runs. (Conflict detection: only --device exists now.)
  // No conflict gate needed — a single canonical flag cannot conflict with itself.

  // Generic fleet fan-out for the `all` sentinel — before single-host resolution
  // so `all` is never treated as a literal hostname.
  if (fleetAll) {
    return runFleetPassthrough(command, allArgs, spec, opts);
  }

  // After the bailouts and fleet fan-out above, the only remaining path is a
  // single-target --device. Guard for the type checker: plural non-all
  // flags and bare flags were already handled.
  if (!hostName) return false;

  // `auto` is the affinity sentinel from `run --device auto` (RUSH-2185): resolve it up front so
  // the isSelfHost check below catches a local pick instead of self-SSHing or dialing a nonexistent
  // host named "auto".
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

  // `interactive` is the second affinity sentinel (`interactive.host`), resolved before isSelfHost
  // like `auto`. It never falls back to the local box when unset, since rendering to a screen
  // nobody watches is what it prevents.
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

  // Running against your own machine is a local run, skipping SSH. Match every identity the box
  // answers to (short id, loopback, tailscale dnsName; RUSH-2114) and strip routing flags from
  // process.argv so the local command does not see an unknown `--device`.
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

  // A read-only render must forward over a plain pipe even from a terminal, since `ssh -tt` wipes
  // output on clean exit (PHNX-3583); renderForwardDecision also returns the color/geometry env.
  const { noPty: renderNoPty, env: renderForwardEnv } = renderForwardDecision(command, allArgs, {
    isTTY: !!process.stdout.isTTY,
    noTty: allArgs.includes('--no-tty'),
    columns: process.stdout.columns,
    rows: process.stdout.rows,
  });

  // Interactive only when stdout is a terminal and `--no-tty` is absent; otherwise force the non-
  // interactive path so no half-drawn picker is piped. A no-PTY render is non-interactive by
  // construction.
  const interactive = !!process.stdout.isTTY && !allArgs.includes('--no-tty') && !renderNoPty;

  const forwarded = buildPassthroughForwardedArgs(command, allArgs, interactive);

  // The one long-running case: keep the remote team supervisor alive past a
  // disconnect by dispatching it detached (nohup), still streaming live.
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

  // Doctor probes agent CLIs, and remote POSIX login shells often lack the shim dir on PATH (false
  // "not installed"), so bootstrap PATH first. Skipped on Windows, where single-quoted env values
  // would not expand $HOME/$PATH.
  const isDoctorCommand =
    command === 'doctor' || (command === 'teams' && forwarded[1] === 'doctor');
  const remoteOs = resolveRemoteOsSync(host.name);
  const doctorPath = isDoctorCommand && !/^win/i.test((remoteOs ?? '').trim())
    ? { PATH: '$HOME/.agents/.cache/shims:$HOME/.local/bin:$PATH' }
    : undefined;
  // Merge the doctor PATH bootstrap with the render color/geometry env (doctor is
  // itself a render command, so both can apply). undefined when neither is needed.
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

/** `--device` passthrough for a standalone binary with a fixed command name
 * (`browser`/`computer`), which never enters index.ts. Browser owns `--device`, so argv is left
 * intact and only `--help`/`--version` strip routing flags; others use maybeRunOnHost. */
export async function maybeRunStandaloneOnHost(
  command: string,
  opts?: FleetPassthroughOptions,
): Promise<boolean> {
  const rawArgs = process.argv.slice(2);
  // No routing flag → nothing to route or strip. Leave argv alone so a purely
  // local run keeps every flag it passed.
  if (!hasHostRoutingFlag(rawArgs)) return false;

  // Commands that interpret `--device` themselves (browser start binds the
  // task→device index; later browser verbs reject the flag) must see it.
  // Help/version still strip so `browser --device x --help` parses.
  if (OWN_HOST_COMMANDS.has(command)) {
    const helpOrVersion = rawArgs.some(
      (a) => a === '--help' || a === '-h' || a === '--version' || a === '-V',
    );
    if (helpOrVersion) {
      process.argv = [process.argv[0], process.argv[1], ...stripRoutingFlags(rawArgs, STRIP_SPECS)];
    }
    return false;
  }

  // Keep --help/--version local (docs must work without a reachable host), mirroring
  // index.ts's `helpOrVersionRequested` guard, but still strip the routing flags
  // below so commander doesn't choke on them.
  const helpOrVersion = rawArgs.some(
    (a) => a === '--help' || a === '-h' || a === '--version' || a === '-V',
  );
  if (!helpOrVersion && (await maybeRunOnHost(command, [command, ...rawArgs], opts))) {
    return true;
  }

  // Local / self-host fall-through (maybeRunOnHost may have rewritten process.argv
  // with the synthetic command token). Rebuild argv from the original args minus
  // the routing flags so the standalone program parses cleanly.
  process.argv = [process.argv[0], process.argv[1], ...stripRoutingFlags(rawArgs, STRIP_SPECS)];
  return false;
}

/** Run `agents <forwardedArgs>` on `host` over SSH, streaming output; the single place the SSH
 * hop is built. Forwards actor provenance (RUSH-2028); AGENTS_FLEET_REMOTE marks a fleet
 * dispatch for the browser consent gate (lib/browser/remote-control.ts). */
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
