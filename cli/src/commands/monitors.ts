
import type { Command } from 'commander';
import chalk from 'chalk';
import { withAliases } from '../lib/verbs.js';
import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'yaml';

import {
  isDaemonRunning,
  signalDaemonReload,
  startDaemon,
  RedirectedHomeDaemonError,
} from '../lib/daemon/daemon.js';
import { findDuplicateMonitor, monitorFingerprint } from '../lib/monitors/fingerprint.js';
import { gatherFleetMonitors, NO_MONITOR_FANOUT_ENV, type RemoteMonitor, type RemoteMonitorDisplay } from '../lib/monitors/remote.js';
import {
  listMonitors,
  readMonitor,
  writeMonitor,
  deleteMonitor,
  setMonitorEnabled,
  getMonitorPath,
  validateMonitor,
  monitorRunsOnThisDevice,
  requiresSingleOwner,
  monitorSharedInputOwner,
  parseInterval,
  type MonitorConfig,
  type MonitorSource,
  type MonitorSourceType,
  type MonitorCondition,
  type ActionConfig,
  type MonitorWebhookSource,
} from '../lib/monitors/config.js';
import { formatRelativeTime } from '../lib/session/relative-time.js';
import { evaluateMonitorOnce, POLL_SOURCE_TYPES } from '../lib/monitors/engine.js';
import { listFires, readState, readLiveness, resolveFireOutcome, getMonitorHistoryDir, type MonitorLiveness } from '../lib/monitors/state.js';
import { listRuns, getLatestRun, getRunDir } from '../lib/scheduling/routines.js';
import { getMonitorsDir } from '../lib/state.js';
import { IS_WINDOWS } from '../lib/platform/index.js';
import { safeJoin } from '../lib/paths.js';
import { machineId, normalizeHost } from '../lib/machine-id.js';
import { loadDevices } from '../lib/devices/registry.js';
import { assertDaemonEnabled } from '../lib/device-config.js';
import { setHelpSections } from '../lib/help.js';
import { isPidAlive } from '../lib/session/active.js';
import { PID_WATCH_EXITED_TOKEN, pidLivenessCommand } from '../lib/monitors/pid-watch.js';
import { isInteractiveTerminal, requireInteractiveSelection } from './utils.js';

function stdoutJson(payload: unknown): void {
  process.stdout.write(JSON.stringify(payload) + '\n');
}

function stderrLine(message: string): void {
  process.stderr.write(message + '\n');
}

function sourceLabel(source: MonitorSource): string {
  switch (source.type) {
    case 'command':
    case 'poll':
      return `${source.type}: ${source.command ?? ''}${source.interval ? ` @${source.interval}` : ''}`;
    case 'poll-http':
      return `poll-http: ${source.url ?? ''} @${source.interval ?? ''}`;
    case 'ws':
      return `ws: ${source.wsUrl ?? ''}`;
    case 'file':
      return `file: ${source.path ?? ''}`;
    case 'device':
      return `device: ${source.device ?? ''}`;
    case 'webhook':
      return `on ${source.webhook?.source}:${source.webhook?.event}`;
    default:
      return source.type;
  }
}

function warnMissingPostcondition(action: ActionConfig): void {
  if ((action.type === 'run' || action.type === 'routine') && !action.postcondition) {
    stderrLine(chalk.yellow(
      `  Note: ${action.type} has no --postcondition — a completed agent that did nothing will still record as ok. Add --postcondition '<cmd>' that exits 0 when the intended effect happened.`,
    ));
  }
}

function fireOutcomeDisplay(name: string, f: ReturnType<typeof listFires>[number]): { label: string; note: string } {
  const rec = resolveFireOutcome(name, f);
  if (rec.ok) return { label: chalk.green('ok'), note: '' };
  if (rec.effect === 'none') {
    const note = rec.error ? chalk.gray(`    ${rec.error}`) : '';
    return { label: chalk.yellow('no effect'), note };
  }
  const corrected = f.ok !== false && rec.runStatus
    ? chalk.yellow(` (run ${rec.runStatus})`)
    : '';
  return { label: chalk.red('failed') + corrected, note: '' };
}

function actionLabel(action: ActionConfig): string {
  switch (action.type) {
    case 'run':
      return `run ${action.agent ?? ''}`;
    case 'routine':
      return `routine ${action.routine ?? ''}`;
    case 'notify':
      return `notify ${action.notifyChannel ?? 'owner'}`;
    case 'webhook-out':
      return `webhook-out ${action.url ?? ''}`;
    default:
      return action.type;
  }
}

function ownerLabel(monitor: MonitorConfig): string {
  if (monitor.device) return monitor.device;
  if (monitor.devices && monitor.devices.length > 0) return monitor.devices.join(',');
  if (requiresSingleOwner(monitor)) {
    const owner = monitorSharedInputOwner();
    return owner ? `${owner} (owner)` : 'unowned — set interactive.host';
  }
  return 'all';
}

function builtinTag(monitor: Pick<MonitorConfig, 'scope'>): string {
  return monitor.scope === 'system' ? chalk.gray(' (built-in)') : '';
}

function remoteLivenessNote(d?: RemoteMonitorDisplay): string {
  if (!d) return chalk.gray('—');
  if (d.enabled === false) return chalk.gray('paused');
  if (d.stalled) return chalk.red('STALLED');
  if (d.lastActionFailed) return chalk.red('ACTION FAILED');
  if (d.lastFiredAt) return chalk.green(`fired ${formatRelativeTime(d.lastFiredAt)}`);
  if (typeof d.checkCount === 'number' && d.checkCount > 0) return chalk.gray(`checked ${d.checkCount}x`);
  if (d.lastCheckedAt) return chalk.gray(`checked ${formatRelativeTime(d.lastCheckedAt)}`);
  return chalk.yellow('never polled');
}

function fleetReachNote(fleet: { discoveryFailed: boolean; skipped: string[] }): void {
  if (fleet.discoveryFailed) {
    stderrLine(chalk.yellow('  Note: could not reach the device registry — the fleet was not checked, only this device is shown.'));
  } else if (fleet.skipped.length > 0) {
    stderrLine(chalk.yellow(`  Note: could not reach ${fleet.skipped.length} device(s): ${fleet.skipped.join(', ')} — their monitors are not shown.`));
  }
}

function remoteMonitorJsonRow(r: RemoteMonitor): Record<string, unknown> {
  const d = r.display;
  return {
    machine: r.machine,
    name: r.monitor.name,
    enabled: d?.enabled ?? null,
    source: r.monitor.source,
    condition: r.monitor.condition,
    action: r.monitor.action,
    owner: d?.owner ?? null,
    scope: d?.scope ?? null,
    builtin: d?.scope === 'system',
    runsHere: false,
    lastSeenAt: null,
    lastFiredAt: d?.lastFiredAt ?? null,
    lastCheckedAt: d?.lastCheckedAt ?? null,
    checkCount: d?.checkCount ?? 0,
    lastError: null,
    consecutiveErrors: 0,
    stalled: d?.stalled ?? false,
    lastActionStatus: null,
    lastActionFailed: d?.lastActionFailed ?? false,
  };
}

function monitorIntervalMs(monitor: MonitorConfig): number {
  if (monitor.source.interval) return parseInterval(monitor.source.interval) ?? 60_000;
  return 60_000;
}

function isStalled(monitor: MonitorConfig, liveness: MonitorLiveness | null): boolean {
  if (!monitor.enabled || !monitorRunsOnThisDevice(monitor)) return false;
  if (!liveness) return false;
  const staleAfter = Math.max(monitorIntervalMs(monitor) * 3, 90_000);
  return Date.now() - new Date(liveness.lastCheckedAt).getTime() > staleAfter;
}

function livenessLabel(monitor: MonitorConfig, state: ReturnType<typeof readState>, liveness: MonitorLiveness | null): string {
  const here = monitorRunsOnThisDevice(monitor);
  if (!monitor.enabled) return chalk.gray('paused');
  if (!here) {
    return state?.lastFiredAt ? chalk.gray(`fired ${formatRelativeTime(state.lastFiredAt)}`) : chalk.gray('owned elsewhere');
  }
  if (!liveness) return chalk.yellow('never polled');
  if (isStalled(monitor, liveness)) {
    return chalk.red(`STALLED — last poll ${formatRelativeTime(liveness.lastCheckedAt)}`);
  }
  const checkedAgo = formatRelativeTime(liveness.lastCheckedAt);
  if (liveness.lastError) {
    return chalk.red(`checked ${liveness.checkCount}x · error: ${liveness.lastError.replace(/\s+/g, ' ').slice(0, 60)}`);
  }
  const latestFire = listFires(monitor.name).at(-1);
  if (latestFire) {
    const outcome = resolveFireOutcome(monitor.name, latestFire);
    if (!outcome.ok) {
      return chalk.red(`ACTION FAILED ${formatRelativeTime(latestFire.firedAt)}`) + chalk.gray(` · checked ${liveness.checkCount}x`);
    }
  }
  if (state?.lastFiredAt) {
    return chalk.green(`fired ${formatRelativeTime(state.lastFiredAt)}`) + chalk.gray(` · checked ${liveness.checkCount}x`);
  }
  return chalk.gray(`checked ${liveness.checkCount}x · last ${checkedAgo} · no match yet`);
}

function ensureDaemonRunning(): boolean {
  try {
    assertDaemonEnabled();
  } catch (err) {
    stderrLine(chalk.yellow((err as Error).message));
    return false;
  }
  if (isDaemonRunning()) {
    signalDaemonReload();
    stderrLine(chalk.gray('Daemon reloaded'));
    return true;
  }
  let result: { pid: number | null; method: string };
  try {
    result = startDaemon();
  } catch (err) {
    if (err instanceof RedirectedHomeDaemonError) {
      stderrLine(chalk.yellow((err as Error).message));
      return true;
    }
    throw err;
  }
  if (result.pid) {
    console.log(chalk.green(`Daemon started (PID: ${result.pid}). It will watch monitors in the background.`));
    console.log(chalk.gray('Disable only monitor polling with: agents daemon services disable monitors'));
  } else {
    stderrLine(chalk.yellow('Could not start the daemon. Start it manually with: agents daemon start'));
  }
  return true;
}

async function assertEnginePickup(monitor: MonitorConfig): Promise<void> {
  const pollSource = POLL_SOURCE_TYPES.has(monitor.source.type);
  if (!monitor.enabled || !monitorRunsOnThisDevice(monitor) || !pollSource) return;
  const before = readLiveness(monitor.name);
  const baseline = before?.checkCount ?? 0;
  const deadline = Date.now() + 12_000;
  stderrLine(chalk.gray('  waiting for the engine to poll it…'));
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 500));
    const now = readLiveness(monitor.name);
    if (now && now.checkCount > baseline) {
      console.log(chalk.green(`  engine picked it up — first poll ${formatRelativeTime(now.lastCheckedAt)}`));
      if (now.lastError) {
        stderrLine(chalk.yellow(`  note: that poll errored — ${now.lastError.replace(/\s+/g, ' ').slice(0, 80)}`));
      }
      return;
    }
  }
  stderrLine(chalk.yellow(`  the engine has not polled '${monitor.name}' yet.`));
  stderrLine(chalk.yellow(`  confirm the daemon is running (agents routines status) and re-check with: agents monitors view ${monitor.name}`));
}

async function validateDevice(name: string): Promise<string> {
  const normalized = normalizeHost(name.trim());
  if (!normalized) {
    stderrLine(chalk.red('device name must be non-empty'));
    process.exit(1);
  }
  const registry = await loadDevices();
  const registered = new Set(Object.keys(registry).map((k) => normalizeHost(k)));
  if (!registered.has(normalized)) {
    stderrLine(chalk.red(`Unknown device: ${normalized}`));
    stderrLine(chalk.gray(`Registered: ${[...registered].sort().join(', ') || '(none)'}`));
    stderrLine(chalk.gray('Enroll devices with: agents devices sync'));
    process.exit(1);
  }
  return normalized;
}

function buildSource(options: Record<string, any>, name: string): MonitorSource {
  const chosen: Array<{ type: MonitorSourceType; source: MonitorSource }> = [];
  if (options.watch) chosen.push({ type: 'command', source: { type: 'command', command: options.watch } });
  if (options.watchPid) {
    const pid = Number(options.watchPid);
    if (!Number.isInteger(pid) || pid < 1) {
      stderrLine(chalk.red(`--watch-pid must be a positive integer pid, got '${options.watchPid}'`));
      process.exit(1);
    }
    if (!isPidAlive(pid) && !options.force) {
      stderrLine(chalk.red(`Process ${pid} is not running — there is nothing to watch.`));
      stderrLine(chalk.gray('Pass --force to arm it anyway (e.g. the pid is about to be spawned by a concurrent step).'));
      process.exit(1);
    }
    const seenRunningMarkerPath = path.join(getMonitorHistoryDir(name), 'pid-watch-seen-running');
    chosen.push({ type: 'command', source: { type: 'command', command: pidLivenessCommand(pid, seenRunningMarkerPath) } });
  }
  if (options.poll) {
    chosen.push({ type: 'poll', source: { type: 'poll', command: options.poll[0], interval: options.poll[1] } });
  }
  if (options.pollHttp) {
    chosen.push({
      type: 'poll-http',
      source: { type: 'poll-http', url: options.pollHttp[0], interval: options.pollHttp[1] },
    });
  }
  if (options.ws) chosen.push({ type: 'ws', source: { type: 'ws', wsUrl: options.ws } });
  if (options.watchFile) chosen.push({ type: 'file', source: { type: 'file', path: options.watchFile } });
  if (options.watchDevice) {
    chosen.push({ type: 'device', source: { type: 'device', device: options.watchDevice } });
  }
  if (options.on) {
    const raw = String(options.on);
    const [src, event] = raw.includes(':') ? raw.split(':', 2) : ['github', raw];
    if (src !== 'github' && src !== 'linear') {
      stderrLine(chalk.red('--on source must be github or linear'));
      process.exit(1);
    }
    const webhook: MonitorWebhookSource = { source: src, event };
    if (options.repo) webhook.repo = options.repo;
    if (options.branch) webhook.branch = options.branch;
    if (options.action) webhook.action = options.action;
    if (options.teamKey) webhook.teamKey = options.teamKey;
    if (options.label) webhook.label = options.label;
    chosen.push({ type: 'webhook', source: { type: 'webhook', webhook } });
  }

  if (chosen.length === 0) {
    stderrLine(chalk.red('A source is required: --watch, --watch-pid, --poll, --poll-http, --ws, --watch-file, --watch-device, or --on'));
    process.exit(1);
  }
  if (chosen.length > 1) {
    stderrLine(chalk.red(`Exactly one source is allowed; got ${chosen.map((c) => c.type).join(', ')}`));
    process.exit(1);
  }
  return chosen[0].source;
}

function buildCondition(options: Record<string, any>): MonitorCondition {
  const modes: Array<MonitorCondition['mode']> = [];
  if (options.onChange) modes.push('on-change');
  if (options.match) modes.push('match');
  if (options.every) modes.push('every');
  if (modes.length > 1) {
    stderrLine(chalk.red('--on-change, --match, and --every are mutually exclusive'));
    process.exit(1);
  }
  if (options.watchPid && modes.length === 0) {
    return { mode: 'match', match: PID_WATCH_EXITED_TOKEN };
  }
  const mode: MonitorCondition['mode'] = modes[0] ?? (options.match ? 'match' : 'on-change');
  const condition: MonitorCondition = { mode };
  if (options.match) condition.match = options.match;
  if (options.dedupeKey) condition.dedupeKey = options.dedupeKey;
  return condition;
}

function buildAction(options: Record<string, any>): ActionConfig {
  const chosen: ActionConfig[] = [];
  if (options.run) {
    const action: ActionConfig = { type: 'run', agent: options.run, prompt: options.prompt };
    if (options.mode) action.mode = options.mode;
    if (options.effort) action.effort = options.effort;
    if (options.actionTimeout) action.timeout = options.actionTimeout;
    if (options.postcondition) action.postcondition = options.postcondition;
    chosen.push(action);
  }
  if (options.routine) {
    const action: ActionConfig = { type: 'routine', routine: options.routine };
    if (options.postcondition) action.postcondition = options.postcondition;
    chosen.push(action);
  }
  if (options.notify !== undefined) {
    const channel = typeof options.notify === 'string' ? options.notify : undefined;
    chosen.push({ type: 'notify', ...(channel ? { notifyChannel: channel } : {}) });
  }
  if (options.webhookOut) chosen.push({ type: 'webhook-out', url: options.webhookOut });

  if (chosen.length === 0) {
    stderrLine(chalk.red('An action is required: --run <agent> --prompt, --routine, --notify, or --webhook-out'));
    process.exit(1);
  }
  if (chosen.length > 1) {
    stderrLine(chalk.red(`Exactly one action is allowed; got ${chosen.map((c) => c.type).join(', ')}`));
    process.exit(1);
  }
  if (options.postcondition && chosen[0].type !== 'run' && chosen[0].type !== 'routine') {
    stderrLine(chalk.red('--postcondition only applies to --run or --routine'));
    process.exit(1);
  }
  return chosen[0];
}

async function pickMonitor(message: string, alternatives: string[] = []): Promise<string | null> {
  const monitors = listMonitors();
  if (monitors.length === 0) {
    stderrLine(chalk.yellow('No monitors configured'));
    return null;
  }
  if (!isInteractiveTerminal()) {
    requireInteractiveSelection(message.replace(/:$/, ''), alternatives);
  }
  try {
    const { select } = await import('@inquirer/prompts');
    return await select({
      message,
      choices: monitors.map((m) => ({
        value: m.name,
        name: `${m.name} ${chalk.gray(`(${sourceLabel(m.source)} → ${actionLabel(m.action)})`)}`,
      })),
    });
  } catch (err) {
    if (err instanceof Error && (err.name === 'ExitPromptError' || err.message.includes('User force closed'))) {
      stderrLine(chalk.gray('Cancelled'));
      return null;
    }
    throw err;
  }
}

async function guardAgainstDuplicateMonitor(config: MonitorConfig, force: boolean): Promise<void> {
  if (force) return;
  const existing = listMonitors();
  const sameName = existing.find((m) => m.name === config.name);
  if (sameName) {
    stderrLine(chalk.red(`Monitor '${config.name}' already exists — adding would overwrite it.`));
    stderrLine(chalk.gray(`  Inspect it:   agents monitors view ${config.name}`));
    stderrLine(chalk.gray(`  Replace it:   agents monitors add ${config.name} ... --force`));
    process.exit(1);
  }
  const duplicate = findDuplicateMonitor(config, existing);
  if (duplicate) {
    stderrLine(chalk.red(`Monitor '${duplicate}' already watches this exact source and fires the same action.`));
    stderrLine(chalk.gray('  Adding it again would fire the same trigger twice.'));
    stderrLine(chalk.gray(`  Inspect it:   agents monitors view ${duplicate}`));
    stderrLine(chalk.gray(`  Add anyway:   agents monitors add ${config.name} ... --force`));
    process.exit(1);
  }

  if (process.env[NO_MONITOR_FANOUT_ENV]) return;
  const mine = monitorFingerprint(config);
  const fleet = await gatherFleetMonitors({ againstFingerprint: mine });
  const clash = fleet.monitors.find((r) => monitorFingerprint(r.monitor) === mine);
  if (clash) {
    stderrLine(chalk.red(`Monitor '${clash.monitor.name}' on ${chalk.bold(clash.machine)} already watches this exact source and fires the same action.`));
    stderrLine(chalk.gray('  Two boxes watching one work item is a double trigger.'));
    stderrLine(chalk.gray(`  Inspect it:   agents ssh ${clash.machine} 'agents monitors view ${clash.monitor.name}'`));
    stderrLine(chalk.gray(`  Add anyway:   agents monitors add ${config.name} ... --force`));
    process.exit(1);
  }
  if (fleet.discoveryFailed) {
    stderrLine(chalk.yellow('  Note: could not reach the device registry — the fleet was not checked for duplicates.'));
  } else if (fleet.skipped.length > 0) {
    stderrLine(chalk.yellow(`  Note: could not check ${fleet.skipped.join(', ')} — a duplicate there would not have been caught.`));
  }
}

export function registerMonitorsCommands(program: Command): void {
  const monitorsCmd = program
    .command('monitors')
    .description('Durable event-triggered watchers: watch a source, detect a change, fire an action. The daemon auto-starts on first add unless daemon.enabled is false.');

  setHelpSections(monitorsCmd, {
    examples: `
      # CI went red → triage it (poll a command, diff, fire an agent)
      agents monitors add ci-red \\
        --poll 'gh pr checks 1119 --json name,bucket' 30s --match 'fail' \\
        --run claude --prompt 'CI failed on #1119: {event}. Diagnose and fix.' \\
        --device yosemite-s0

      # Merge-on-green: the fire is ok only if the PR actually merged
      agents monitors add merge-1682 \\
        --poll 'gh pr view 1682 --json state --jq .state' 2m --match OPEN \\
        --run claude --prompt 'Rebase-merge #1682: {event}' \\
        --postcondition 'gh pr view 1682 --json state --jq .state | grep -qx MERGED'

      # SSL cert issued → notify (poll an HTTPS endpoint every 8h)
      agents monitors add cert-issued \\
        --poll-http 'https://secure.ssl.com/team/.../co-ec1l5dgjofa' 8h \\
        --match 'issued' --notify --device zion

      # Dry-run: evaluate the source once and show what it would emit (no action)
      agents monitors test ci-red

      # A fleet box going loaded → spin up an agent
      agents monitors add box-loaded --watch-device yosemite-s0 --match loaded \\
        --run claude --prompt 'yosemite-s0 is loaded: {event}. Investigate.'

      # A backgrounded shell that will never exit on its own (a watch loop, gh pr
      # checks --watch, a long sleep) — arm a REAL watcher instead of trusting the
      # harness's own exit hook (which only fires when the process dies):
      agents monitors add pr-checks-1234 --watch-pid 48213 \\
        --run claude --prompt 'PID 48213 exited: {event}. Resume and check the result.'
    `,
    notes: `
      A monitor is a routine whose trigger is a watched SOURCE instead of a clock.
      It has three parts:
        - SOURCE    (--watch, --watch-pid, --poll, --poll-http, --ws, --watch-file, --watch-device, --on)
        - CONDITION (--on-change [default], --match <re>, --every; --dedupe-key)
        - ACTION    (--run <agent> --prompt, --routine, --notify, --webhook-out)
                    --postcondition <cmd> on --run/--routine asserts the effect
                    happened (exit 0) after the agent settles; otherwise the
                    fire records as "no effect", not ok.

      The fired event is injected into a run/routine prompt as {event}.
      Pin the single OWNER device with --device (exactly-once). The daemon (shared
      with routines) auto-starts on first add unless daemon.enabled is false on this
      device; manage it with 'agents daemon start|stop' (or 'agents routines start|stop').

      v1 evaluates poll sources (command, poll, poll-http, file, device). Push
      sources (ws, webhook) are accepted but delivered through a receiver wired in
      a follow-up.

      --watch-pid <pid> refuses to arm (fails loud) when the pid is already dead —
      a "will re-invoke me" watcher pointed at a corpse never fires. It defaults
      the condition to fire on exit, unlike a raw --watch which defaults to
      on-change.
    `,
  });

  monitorsCmd
    .command('add [nameOrPath]')
    .description('Create a monitor from inline flags or a YAML file. Auto-starts the daemon unless daemon.enabled is false.')
    .option('--watch <cmd>', 'Run a shell command; its stdout is the observation')
    .option('--watch-pid <pid>', 'Watch a backgrounded process for exit — a reliable, daemon-polled alternative to a harness exit hook. Fails loud if the pid is already gone. Defaults to firing on exit')
    .option('--poll <cmd...>', 'Re-run a command every interval: --poll "<cmd>" <interval> (e.g. 30s)')
    .option('--poll-http <url...>', 'GET a URL every interval: --poll-http <url> <interval> (e.g. 15m)')
    .option('--on <source:event>', 'Webhook trigger source: github:pull_request or linear:Issue')
    .option('--ws <url>', 'WebSocket; each frame is an observation')
    .option('--watch-file <path>', 'Watch a file or directory for changes')
    .option('--watch-device <name>', 'A fleet device becomes the source (health/reachability)')
    .option('--repo <owner/name>', 'GitHub repo filter for --on github:<event>')
    .option('--branch <name>', 'GitHub branch filter for --on github:<event>')
    .option('--action <name>', 'Linear action filter for --on linear:<event>')
    .option('--team-key <key>', 'Linear team key filter for --on linear:<event>')
    .option('--label <name>', 'Linear issue label filter for --on linear:Issue')
    .option('--on-change', 'Fire when the observation differs from last-seen (the default)')
    .option('--match <regex>', 'Fire when the observation matches this regex')
    .option('--dedupe-key <expr>', 'Regex whose first match is the "same event" signature (default: full output)')
    .option('--every', 'Fire on every observation (no dedupe) — rate-limit this')
    .option('--run <agent>', 'Spawn an agent (claude, codex, ..., or a custom harness from agents harness list) with the prompt on fire')
    .option('--prompt <prompt>', 'Prompt for --run; {event} is replaced with the fired event')
    .option('--mode <mode>', 'Execution mode for --run: plan, edit, auto, or skip')
    .option('--effort <effort>', 'Reasoning effort for --run: low | medium | high | xhigh | max | auto')
    .option('--action-timeout <t>', 'Kill the --run action if it runs longer than this (e.g. 10m)')
    .option('--postcondition <cmd>', 'Shell command that must exit 0 after a --run/--routine action settles; otherwise the fire records as no-effect, not ok. {event} is replaced with the fired event summary')
    .option('--routine <name>', 'Fire an existing routine on change')
    .option('--notify [channel]', 'Notify every normal-policy owner channel; [channel] selects one channel')
    .option('--webhook-out <url>', 'POST the event to this URL')
    .option('--device <name>', 'OWNER (not body placement) — the single machine that evaluates + fires (exactly-once). See docs/concepts.md#placement.')
    .option('--devices <list>', 'Allowlist (comma-separated): each device fires independently')
    .option('--run-on <host>', 'BODY placement — execute the ACTION on this machine over SSH (same idea as run --where device:<host>)')
    .option('--cwd <path>', "Working directory for --run, home-relative or ~/… (default: the execution target's home)")
    .option('--rate-limit <spec>', 'Auto-pause if it fires more than N/<interval> (e.g. 5/1m)')
    .option('--disabled', 'Create the monitor paused (enable later with resume)')
    .option('--force', 'Overwrite a same-named monitor, or add one that duplicates an existing watcher')
    .action(async (nameOrPath: string | undefined, options: Record<string, any>) => {
      const hasSourceFlag = Boolean(
        options.watch || options.watchPid || options.poll || options.pollHttp || options.on || options.ws || options.watchFile || options.watchDevice,
      );
      if (!hasSourceFlag && nameOrPath && /\.ya?ml$/.test(nameOrPath) && fs.existsSync(path.resolve(nameOrPath))) {
        const resolved = path.resolve(nameOrPath);
        let parsed: any;
        try {
          parsed = yaml.parse(fs.readFileSync(resolved, 'utf-8'));
        } catch (err) {
          stderrLine(chalk.red(`Invalid YAML: ${(err as Error).message}`));
          process.exit(1);
        }
        const name = parsed?.name || path.basename(resolved).replace(/\.ya?ml$/, '');
        const config: MonitorConfig = { enabled: true, ...parsed, name } as MonitorConfig;
        const errors = validateMonitor(config);
        if (errors.length > 0) {
          stderrLine(chalk.red('Validation errors:'));
          for (const err of errors) stderrLine(chalk.red(`  - ${err}`));
          process.exit(1);
        }
        await guardAgainstDuplicateMonitor(config, options.force === true);
        writeMonitor(config);
        console.log(chalk.green(`Monitor '${name}' added`));
        warnMissingPostcondition(config.action);
        if (ensureDaemonRunning()) await assertEnginePickup(config);
        return;
      }

      if (!nameOrPath) {
        stderrLine(chalk.red('Monitor name is required'));
        stderrLine(chalk.gray('Usage: agents monitors add <name> --poll "<cmd>" 30s --match fail --run claude --prompt "..."'));
        process.exit(1);
      }

      const source = buildSource(options, nameOrPath);
      if (source.type === 'device' && source.device) {
        source.device = await validateDevice(source.device);
      }
      const condition = buildCondition(options);
      const action = buildAction(options);

      let device: string | undefined;
      let devices: string[] | undefined;
      if (options.device && options.devices) {
        stderrLine(chalk.red('--device (single owner) and --devices (allowlist) are mutually exclusive'));
        process.exit(1);
      }
      if (options.device) device = await validateDevice(options.device);
      if (options.devices) {
        devices = [];
        for (const d of String(options.devices).split(',').map((s) => s.trim()).filter(Boolean)) {
          devices.push(await validateDevice(d));
        }
      }
      if (options.runOn && !device && !devices) {
        device = machineId();
        stderrLine(chalk.gray(`--run-on set with no --device/--devices: pinned owner to this machine (${device}).`));
      }

      let rateLimit: MonitorConfig['rateLimit'];
      if (options.rateLimit) {
        const m = String(options.rateLimit).match(/^(\d+)\/(.+)$/);
        if (!m) {
          stderrLine(chalk.red('--rate-limit must be N/<interval>, e.g. 5/1m'));
          process.exit(1);
        }
        rateLimit = { max: parseInt(m[1], 10), per: m[2] };
      }

      const config: MonitorConfig = {
        name: nameOrPath,
        enabled: !options.disabled,
        source,
        condition,
        action,
        ...(device ? { device } : {}),
        ...(devices ? { devices } : {}),
        ...(options.runOn ? { runOn: options.runOn } : {}),
        ...(options.cwd ? { cwd: options.cwd } : {}),
        ...(rateLimit ? { rateLimit } : {}),
      };

      const errors = validateMonitor(config);
      if (errors.length > 0) {
        stderrLine(chalk.red('Validation errors:'));
        for (const err of errors) stderrLine(chalk.red(`  - ${err}`));
        process.exit(1);
      }

      if (condition.mode === 'match' && condition.match && /^(issued|success|ok|pass(ed)?|done|ready)$/i.test(condition.match)) {
        stderrLine(chalk.yellow(`  Note: --match '${condition.match}' only fires on success — it stays silent if the source breaks or never matches.`));
      }

      await guardAgainstDuplicateMonitor(config, options.force === true);

      writeMonitor(config);
      console.log(chalk.green(`Monitor '${nameOrPath}' added`));
      console.log(chalk.gray(`  ${sourceLabel(source)} → [${condition.mode}] → ${actionLabel(action)} · owner: ${ownerLabel(config)}`));
      warnMissingPostcondition(action);
      if (ensureDaemonRunning()) await assertEnginePickup(config);
    });

  monitorsCmd
    .command('list')
    .description('See all monitors across the fleet: source, condition, action, owner, last fire, and the box each lives on.')
    .option('--json', 'Emit machine-readable JSON')
    .option('--local', 'This device only — skip the fleet fan-out')
    .action(async (options: { json?: boolean; local?: boolean }) => {
      const self = machineId();
      const monitors = listMonitors();
      const peerMode = !!process.env[NO_MONITOR_FANOUT_ENV];
      const localOnly = peerMode || options.local === true;

      let fleet: Awaited<ReturnType<typeof gatherFleetMonitors>> | null = null;
      if (!localOnly) {
        fleet = await gatherFleetMonitors();
      }
      const remote = (fleet?.monitors ?? []).filter((r) => normalizeHost(r.machine) !== self);

      if (options.json) {
        const localRows = monitors.map((m) => {
          const state = readState(m.name);
          const liveness = readLiveness(m.name);
          const latestFire = listFires(m.name).at(-1);
          const latestOutcome = latestFire ? resolveFireOutcome(m.name, latestFire) : null;
          return {
            machine: self,
            name: m.name,
            enabled: m.enabled,
            source: m.source,
            condition: m.condition,
            action: m.action,
            owner: ownerLabel(m),
            scope: m.scope ?? 'user',
            builtin: m.scope === 'system',
            runsHere: monitorRunsOnThisDevice(m),
            lastSeenAt: state?.lastSeenAt ?? null,
            lastFiredAt: state?.lastFiredAt ?? null,
            lastCheckedAt: liveness?.lastCheckedAt ?? null,
            checkCount: liveness?.checkCount ?? 0,
            lastError: liveness?.lastError ?? null,
            consecutiveErrors: liveness?.consecutiveErrors ?? 0,
            stalled: isStalled(m, liveness),
            lastActionStatus: latestOutcome?.runStatus ?? null,
            lastActionFailed: latestOutcome ? !latestOutcome.ok : false,
          };
        });
        stdoutJson([...localRows, ...remote.map(remoteMonitorJsonRow)]);
        return;
      }

      if (monitors.length === 0 && remote.length === 0) {
        console.log(chalk.gray('No monitors configured'));
        console.log(chalk.gray('  Add one: agents monitors add <name> --poll "<cmd>" 30s --match fail --run claude --prompt "..."'));
        if (fleet && (fleet.discoveryFailed || fleet.skipped.length > 0)) fleetReachNote(fleet);
        return;
      }

      console.log(chalk.bold('Monitors\n'));
      if (monitors.length > 0) {
        if (remote.length > 0) console.log(chalk.gray(`  ${self} (this device)`));
        for (const m of monitors) {
          const state = readState(m.name);
          const liveness = readLiveness(m.name);
          const enabled = m.enabled ? chalk.green('on') : chalk.gray('off');
          const here = monitorRunsOnThisDevice(m);
          const owner = here ? ownerLabel(m) : chalk.gray(ownerLabel(m));
          console.log(`  ${chalk.cyan(m.name.padEnd(22))} ${enabled.padEnd(3)} ${sourceLabel(m.source)}${builtinTag(m)}`);
          console.log(`  ${' '.repeat(22)}     ${chalk.gray(`[${m.condition.mode}]`)} → ${actionLabel(m.action)}  ${chalk.gray(`owner: ${owner}`)}  ${livenessLabel(m, state, liveness)}`);
        }
      }
      const byMachine = new Map<string, RemoteMonitor[]>();
      for (const r of remote) {
        const key = r.machine;
        (byMachine.get(key) ?? byMachine.set(key, []).get(key)!).push(r);
      }
      for (const machine of [...byMachine.keys()].sort()) {
        console.log(chalk.gray(`\n  ${machine}`));
        for (const r of byMachine.get(machine)!) {
          const m = r.monitor;
          const enabled = r.display?.enabled === false ? chalk.gray('off') : chalk.green('on');
          console.log(`  ${chalk.cyan(m.name.padEnd(22))} ${enabled.padEnd(3)} ${sourceLabel(m.source)}${builtinTag({ scope: r.display?.scope })}`);
          console.log(`  ${' '.repeat(22)}     ${chalk.gray(`[${m.condition.mode}]`)} → ${actionLabel(m.action)}  ${chalk.gray(`owner: ${r.display?.owner ?? machine}`)}  ${remoteLivenessNote(r.display)}`);
        }
      }
      if (fleet && (fleet.discoveryFailed || fleet.skipped.length > 0)) fleetReachNote(fleet);
      console.log();
    });

  monitorsCmd
    .command('view [name]')
    .description('Show a monitor’s full YAML config plus its current watched-state and recent fires.')
    .option('--json', 'Emit machine-readable JSON')
    .action(async (name: string | undefined, options: { json?: boolean }) => {
      if (!name) {
        name = (await pickMonitor('Select monitor to view', ['agents monitors view <name>'])) ?? undefined;
        if (!name) return;
      }
      const monitor = readMonitor(name);
      if (!monitor) {
        stderrLine(chalk.red(`Monitor '${name}' not found`));
        process.exit(1);
      }
      const state = readState(name);
      const liveness = readLiveness(name);
      const recentFires = listFires(name).slice(-5);
      if (options.json) {
        stdoutJson({
          name,
          monitor,
          owner: ownerLabel(monitor),
          runsHere: monitorRunsOnThisDevice(monitor),
          state,
          liveness,
          stalled: isStalled(monitor, liveness),
          recentFires: recentFires.map((f) => ({ ...f, reconciled: resolveFireOutcome(name, f) })),
        });
        return;
      }
      console.log(chalk.bold(`Monitor: ${name}\n`));
      console.log(yaml.stringify(monitor));
      console.log(chalk.bold('Liveness'));
      console.log(`  ${livenessLabel(monitor, state, liveness)}`);
      if (liveness) {
        console.log(chalk.gray(`  last checked: ${liveness.lastCheckedAt} (${formatRelativeTime(liveness.lastCheckedAt)})`));
        console.log(chalk.gray(`  checks:       ${liveness.checkCount}`));
        if (liveness.lastError) {
          console.log(chalk.red(`  last error:   ${liveness.lastError.replace(/\s+/g, ' ').slice(0, 200)} (${liveness.consecutiveErrors} in a row)`));
        }
      } else if (monitor.enabled && monitorRunsOnThisDevice(monitor)) {
        console.log(chalk.yellow('  The engine has not polled this monitor yet. If this persists, the daemon may not have picked it up — check: agents routines status'));
      }
      if (state) {
        console.log(chalk.bold('\nWatched state'));
        console.log(chalk.gray(`  last seen:  ${state.lastSeenAt}`));
        if (state.lastFiredAt) console.log(chalk.gray(`  last fired: ${state.lastFiredAt}`));
        console.log(chalk.gray(`  last value: ${state.lastValue.replace(/\s+/g, ' ').slice(0, 120)}`));
      }
      if (recentFires.length > 0) {
        console.log(chalk.bold('\nRecent fires'));
        for (const f of recentFires) {
          const { label, note } = fireOutcomeDisplay(name, f);
          console.log(`  ${chalk.gray(f.firedAt)}  ${f.action ?? '?'}  ${label}`);
          if (note) console.log(note);
        }
      }
    });

  monitorsCmd
    .command('test [name]')
    .description('DRY-RUN: evaluate the source once and print the emitted event + whether it would fire. No action is taken.')
    .option('--json', 'Emit machine-readable JSON')
    .action(async (name: string | undefined, options: { json?: boolean }) => {
      if (!name) {
        name = (await pickMonitor('Select monitor to test', ['agents monitors test <name>'])) ?? undefined;
        if (!name) return;
      }
      const monitor = readMonitor(name);
      if (!monitor) {
        stderrLine(chalk.red(`Monitor '${name}' not found`));
        process.exit(1);
      }
      const { observation, decision } = await evaluateMonitorOnce(monitor);
      const wouldFire = Boolean(decision?.fire);
      if (options.json) {
        stdoutJson({
          name,
          dryRun: true,
          monitor,
          observation,
          decision,
          wouldFire,
        });
        return;
      }
      console.log(chalk.bold(`Dry-run: ${name}\n`));
      console.log(chalk.gray(`  ${sourceLabel(monitor.source)}  ·  [${monitor.condition.mode}]  ·  ${actionLabel(monitor.action)}\n`));

      if (!observation) {
        console.log(chalk.yellow('No observation — this source is push-only (ws/webhook) or produced nothing this tick.'));
        return;
      }
      console.log(chalk.bold('Observation'));
      console.log(observation.raw.split('\n').slice(0, 20).map((l) => `  ${l}`).join('\n'));
      if (observation.meta) console.log(chalk.gray(`  meta: ${JSON.stringify(observation.meta)}`));
      if (observation.failed) {
        console.log(chalk.yellow(`  poll failed (${observation.failureReason ?? 'observation failure'}) — not a value change; skipped`));
      }

      console.log('');
      console.log(`Would fire: ${wouldFire ? chalk.green('yes') : chalk.gray('no')}`);
      if (decision?.event) {
        console.log(chalk.bold('\nEmitted event'));
        console.log(`  summary: ${decision.event.summary}`);
        console.log(chalk.gray(`  → would ${actionLabel(monitor.action)}`));
      } else if (!wouldFire && monitor.condition.mode === 'on-change' && !readState(name)) {
        console.log(chalk.gray('  (first observation establishes a baseline; a later change fires)'));
      }
      console.log(chalk.gray('\n(dry run — no action taken, no state written)'));
    });

  monitorsCmd
    .command('edit [name]')
    .description('Open a monitor’s YAML in $EDITOR.')
    .action(async (name: string | undefined) => {
      if (!name) {
        name = (await pickMonitor('Select monitor to edit', ['agents monitors edit <name>'])) ?? undefined;
        if (!name) return;
      }
      let monitorPath = getMonitorPath(name);
      if (!monitorPath) {
        const dir = getMonitorsDir();
        fs.mkdirSync(dir, { recursive: true });
        monitorPath = safeJoin(dir, `${name}.yml`);
        const builtIn = readMonitor(name);
        if (builtIn) {
          writeMonitor(builtIn);
          console.log(chalk.gray(`Editing a copy of built-in monitor '${name}' in your user dir: ${monitorPath}`));
        } else {
          const template = yaml.stringify({
            name,
            source: { type: 'poll', command: 'echo hello', interval: '1m' },
            condition: { mode: 'on-change' },
            action: { type: 'notify' },
          });
          fs.writeFileSync(monitorPath, template, 'utf-8');
          console.log(chalk.gray(`Created new monitor file: ${monitorPath}`));
        }
      }
      const editor = process.env.EDITOR || process.env.VISUAL || (IS_WINDOWS ? 'notepad' : 'vi');
      const parts = editor.split(/\s+/).filter(Boolean);
      const { spawn } = await import('child_process');
      const child = spawn(parts[0], [...parts.slice(1), monitorPath], { stdio: 'inherit' });
      child.on('close', (code) => {
        if (code !== 0) return;
        const monitor = readMonitor(name!);
        if (!monitor) return;
        const errors = validateMonitor(monitor);
        if (errors.length > 0) {
          stderrLine(chalk.yellow('\nWarning: monitor has validation errors:'));
          for (const err of errors) stderrLine(chalk.yellow(`  - ${err}`));
        } else {
          console.log(chalk.green(`\nMonitor '${name}' saved`));
          if (isDaemonRunning()) {
            signalDaemonReload();
            stderrLine(chalk.gray('Daemon reloaded'));
          }
        }
      });
    });

  monitorsCmd
    .command('logs [name]')
    .description('Show the latest action run’s status + report. --run for a specific run, --full for raw stdout.')
    .option('-r, --run <runId>', 'Show a specific action run instead of the latest')
    .option('-m, --full', 'Show the full raw stdout stream')
    .action(async (name: string | undefined, options: { run?: string; full?: boolean }) => {
      if (!name) {
        name = (await pickMonitor('Select monitor to view logs', ['agents monitors logs <name>'])) ?? undefined;
        if (!name) return;
      }
      const run = options.run ? listRuns(name).find((r) => r.runId === options.run) : getLatestRun(name);
      if (!run) {
        stderrLine(chalk.yellow(`No action runs found for monitor '${name}'`));
        stderrLine(chalk.gray('  (notify / webhook-out actions have no run log — see: agents monitors runs)'));
        return;
      }
      const logPath = path.join(getRunDir(name, run.runId), 'stdout.log');
      if (options.full) {
        if (!fs.existsSync(logPath)) {
          stderrLine(chalk.yellow(`Log not found: ${logPath}`));
          return;
        }
        console.log(chalk.gray(`Run: ${run.runId}\n`));
        console.log(fs.readFileSync(logPath, 'utf-8'));
        return;
      }
      const statusColor = run.status === 'completed' ? chalk.green : run.status === 'running' ? chalk.yellow : chalk.red;
      console.log(chalk.bold(name) + chalk.gray(`  run ${run.runId}`));
      console.log(statusColor(run.status) + chalk.gray(`  ${run.startedAt}`));
      console.log(chalk.gray('─'.repeat(60)));
      const reportPath = path.join(getRunDir(name, run.runId), 'report.md');
      if (fs.existsSync(reportPath)) {
        console.log(fs.readFileSync(reportPath, 'utf-8').trimEnd());
      } else if (fs.existsSync(logPath)) {
        console.log(fs.readFileSync(logPath, 'utf-8').split('\n').slice(-40).join('\n').trimEnd());
      } else {
        console.log(chalk.gray('(no output captured)'));
      }
    });

  monitorsCmd
    .command('runs [name]')
    .description('See a monitor’s fire history: when it fired, the action, and the outcome.')
    .action(async (name: string | undefined) => {
      if (!name) {
        name = (await pickMonitor('Select monitor to view fires', ['agents monitors runs <name>'])) ?? undefined;
        if (!name) return;
      }
      const fires = listFires(name);
      if (fires.length === 0) {
        stderrLine(chalk.yellow(`No fires recorded for monitor '${name}'`));
        return;
      }
      console.log(chalk.bold(`Fire history: ${name}\n`));
      for (const f of fires.slice(-20)) {
        const { label, note } = fireOutcomeDisplay(name, f);
        const runRef = f.runId ? chalk.gray(`  run ${f.runId}`) : '';
        console.log(`  ${f.firedAt}  ${(f.action ?? '?').padEnd(12)} ${label}${runRef}`);
        console.log(chalk.gray(`    ${f.summary.slice(0, 100)}`));
        if (note) console.log(note);
      }
    });

  monitorsCmd
    .command('pause [name]')
    .description('Temporarily disable a monitor. Stops watching until resumed.')
    .action(async (name: string | undefined) => {
      if (!name) {
        name = (await pickMonitor('Select monitor to pause', ['agents monitors pause <name>'])) ?? undefined;
        if (!name) return;
      }
      try {
        setMonitorEnabled(name, false);
        console.log(chalk.green(`Monitor '${name}' paused`));
        if (isDaemonRunning()) signalDaemonReload();
      } catch (err) {
        stderrLine(chalk.red((err as Error).message));
        process.exit(1);
      }
    });

  monitorsCmd
    .command('resume [name]')
    .description('Re-enable a paused monitor so the daemon watches it again.')
    .action(async (name: string | undefined) => {
      if (!name) {
        name = (await pickMonitor('Select monitor to resume', ['agents monitors resume <name>'])) ?? undefined;
        if (!name) return;
      }
      try {
        setMonitorEnabled(name, true);
        console.log(chalk.green(`Monitor '${name}' resumed`));
        if (isDaemonRunning()) signalDaemonReload();
      } catch (err) {
        stderrLine(chalk.red((err as Error).message));
        process.exit(1);
      }
    });

  monitorsCmd
    .command('device [name]')
    .description('View or (re)pin the OWNER device — the single machine that evaluates + fires (exactly-once).')
    .option('--set <name>', 'Pin the owner to this device (strict fleet validation)')
    .option('--clear', 'Remove the owner pin so the monitor runs on every device')
    .action(async (name: string | undefined, options: { set?: string; clear?: boolean }) => {
      if (options.set !== undefined && options.clear) {
        stderrLine(chalk.red('--set and --clear are mutually exclusive'));
        process.exit(1);
      }
      if (!name) {
        name = (await pickMonitor('Select monitor', ['agents monitors device <name> --set X'])) ?? undefined;
        if (!name) return;
      }
      const monitor = readMonitor(name);
      if (!monitor) {
        stderrLine(chalk.red(`Monitor '${name}' not found`));
        process.exit(1);
      }
      if (options.clear) {
        monitor.device = undefined;
        monitor.devices = undefined;
        writeMonitor(monitor);
        console.log(chalk.green(`Owner cleared for '${name}' — evaluates on every device`));
        if (isDaemonRunning()) signalDaemonReload();
        return;
      }
      if (options.set !== undefined) {
        const device = await validateDevice(options.set);
        monitor.device = device;
        monitor.devices = undefined;
        writeMonitor(monitor);
        console.log(chalk.green(`Owner for '${name}' set to: ${device}`));
        if (isDaemonRunning()) signalDaemonReload();
        return;
      }
      console.log(`Owner for '${name}': ${chalk.cyan(ownerLabel(monitor))}`);
      console.log(chalk.gray('  Re-pin with: agents monitors device ' + name + ' --set <device>'));
    });

  withAliases(monitorsCmd
    .command('remove [name]'), 'remove')
    .description('Delete a monitor. Stops watching; past fire history remains on disk.')
    .action(async (name: string | undefined) => {
      if (!name) {
        name = (await pickMonitor('Select monitor to remove', ['agents monitors remove <name>'])) ?? undefined;
        if (!name) return;
      }
      if (deleteMonitor(name)) {
        console.log(chalk.green(`Monitor '${name}' removed`));
        if (isDaemonRunning()) {
          signalDaemonReload();
          stderrLine(chalk.gray('Daemon reloaded'));
        }
      } else if (readMonitor(name)) {
        stderrLine(chalk.red(`Monitor '${name}' is a built-in and can't be removed; pause it with: agents monitors pause ${name}`));
        process.exit(1);
      } else {
        stderrLine(chalk.red(`Monitor '${name}' not found`));
        process.exit(1);
      }
    });
}
