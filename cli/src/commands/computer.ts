/**
 * `agents computer` — the consumer surface over the standalone `computer` CLI
 * (PHNX-4075).
 *
 * WHAT THIS FILE IS NOW. Every verb below forwards its arguments verbatim to the
 * standalone engine and propagates its exit code. agents-cli contributes four
 * things the engine cannot know:
 *
 *   1. the permissions allow list, rendered from `Computer(<bundle-id>)` rules
 *      in the agents resource layer (`lib/computer/policy.ts`);
 *   2. the peer allow list, and `--device <name>` resolved against the fleet —
 *      both carried in the fd-3 context (`lib/computer/context.ts`);
 *   3. the acting actor and agent session, likewise on fd 3;
 *   4. a recorder for the action events the engine streams back on fd 4, so
 *      `agents computer sessions` and `agents sessions --computer` keep their
 *      history (`lib/computer/record.ts`).
 *
 * The `ssh -L` tunnel a `--device` invocation needs is opened here too
 * (`lib/computer/remote.ts`); its loopback endpoint reaches the engine on the
 * transport env var the engine already reads, not as a second context field.
 *
 * WHY VERB FLAGS ARE NOT REDECLARED HERE. Each passthrough verb declares only
 * `--device` — the one flag the consumer must intercept — and takes everything
 * else as opaque operands via `allowUnknownOption`. Mirroring the engine's flags
 * would create a second, silently drifting copy of its surface: a flag added
 * upstream would be rejected here as unknown until someone noticed. The engine
 * also owns per-verb `--help` for the same reason. What agents-cli keeps is the
 * verb CATALOG — names, one-line descriptions, help groups — because that is
 * what makes the surface discoverable from `agents computer --help`, and a
 * verb the engine drops should fail loud here rather than silently vanish.
 *
 * `sessions` is the one verb that never reaches the engine: it reads agents-cli's
 * own event ledger.
 */

import { Command } from 'commander';
import { registerCommandGroups, setHelpSections } from '../lib/help.js';
import {
  loadComputerAllowList,
  loadDefaultPeers,
  resolvePeersPath,
  resolvePolicyPath,
  resolveTcpEndpoint,
  resolveVncEndpoint,
  writeComputerPeers,
  writeComputerPolicy,
} from '../lib/computer/policy.js';
import {
  isTunnelAlive,
  readRemoteState,
  startRemoteTunnel,
  stopRemoteTunnel,
} from '../lib/computer/remote.js';
import { buildComputerContext, computerTransportEnv } from '../lib/computer/context.js';
import { recordComputerAction } from '../lib/computer/record.js';
import {
  isComputerClientError,
  resolveComputerBin,
  runComputer,
} from '../lib/computer-client.js';
import { runComputerSessionsCommand } from './computer-sessions-picker.js';

// Help groups — mirror `agents browser` so the mental model carries over.
const COMPUTER_HELP_GROUPS = [
  { title: 'Installation', names: ['setup'] },
  { title: 'Daemon lifecycle', names: ['start', 'stop', 'reload', 'status'] },
  { title: 'Autonomous', names: ['run'] },
  { title: 'Observe', names: ['apps', 'describe', 'screenshot', 'get-text'] },
  { title: 'Interact', names: ['launch', 'raise', 'click', 'right-click', 'type', 'type-text', 'key', 'drag', 'scroll', 'ax-action', 'focus', 'wait'] },
  { title: 'History and discovery', names: ['sessions'] },
] as const;

/**
 * The verb catalog. Descriptions are the consumer's (they appear in
 * `agents computer --help`); flags are the engine's.
 *
 * This list is the contract with the engine: `computer --verbs` must report the
 * same names. `computer.test.ts` pins it so a drift shows up as a failing test
 * rather than a verb that quietly stops existing.
 */
export const COMPUTER_PASSTHROUGH_VERBS: ReadonlyArray<{ name: string; description: string }> = [
  { name: 'run', description: 'Autonomously drive an app from a natural-language task (model loop over the computer verbs)' },
  { name: 'apps', description: 'List running apps the policy allows, with pid and bundle id' },
  { name: 'describe', description: 'Dump an app\'s accessibility tree — the element ids the interact verbs target' },
  { name: 'screenshot', description: 'Capture a window (default: largest), enumerate windows (--list), or the whole display (--display)' },
  { name: 'get-text', description: 'Read the text content of an element or a whole window' },
  { name: 'launch', description: 'Launch an allow-listed app by bundle id and wait for it to be ready' },
  { name: 'raise', description: 'Bring an app to the front' },
  { name: 'click', description: 'Click an element by id, or a coordinate pair' },
  { name: 'right-click', description: 'Right-click an element by id, or a coordinate pair' },
  { name: 'type', description: 'Type into a focused element by id' },
  { name: 'type-text', description: 'Type a literal string at the current focus' },
  { name: 'key', description: 'Send a key or chord (e.g. cmd+s, escape)' },
  { name: 'drag', description: 'Drag from one point or element to another' },
  { name: 'scroll', description: 'Scroll an element or the window under a coordinate' },
  { name: 'ax-action', description: 'Perform a raw accessibility action on an element' },
  { name: 'focus', description: 'Move keyboard focus to an element' },
  { name: 'wait', description: 'Wait for an element or condition to appear before continuing' },
];

// Subcommands that manage the `--device` remote path themselves (tunnel
// lifecycle, or daemon-state reporting that must degrade gracefully when no
// tunnel is recorded). Every other `--device`-bearing subcommand is a plain verb
// that just needs the endpoint resolved into its context before it runs.
const REMOTE_LIFECYCLE = new Set(['setup', 'start', 'stop', 'status', 'reload']);

/**
 * Pure platform gate. The computer subsystem is macOS-only for LOCAL driving
 * (Accessibility / launchctl). It is NOT blocked off macOS when a remote daemon
 * is reachable — either a configured TCP endpoint (COMPUTER_HELPER_TCP, e.g. a
 * Windows daemon over a tunnel) or a `--device <name>` remote invocation. Kept
 * pure so the gating rule is unit-testable without a live command tree.
 */
export function shouldBlockOffPlatform(opts: {
  platform: NodeJS.Platform;
  tcpConfigured: boolean;
  vncConfigured?: boolean;
  device?: string;
}): boolean {
  if (opts.platform === 'darwin') return false;
  if (opts.tcpConfigured) return false; // remote (Windows) daemon over a tunnel
  if (opts.vncConfigured) return false; // RFB/VNC desktop (Linux GUI over the wire)
  if (opts.device) return false; // remote path resolves its own endpoint
  return true;
}

/**
 * Render the policy and peer allow lists the engine's daemon reads.
 *
 * Called before any lifecycle verb that (re)starts or re-reads the daemon, so a
 * permission group edited five seconds ago is in force. The daemon fails safe:
 * a missing or unparseable policy denies everything, which is why this runs
 * BEFORE the engine rather than alongside it.
 */
function renderPolicyFiles(opts: { computerBin?: string; quiet?: boolean } = {}): void {
  const allowed = loadComputerAllowList();
  writeComputerPolicy(allowed);
  const callers = loadDefaultPeers({ computerBin: opts.computerBin });
  writeComputerPeers(callers);
  if (opts.quiet) return;

  console.log(`policy: ${allowed.length} app${allowed.length === 1 ? '' : 's'} allowed (${resolvePolicyPath()})`);
  if (allowed.length > 0) {
    const preview = allowed.slice(0, 5).join(', ');
    const more = allowed.length > 5 ? ` (+${allowed.length - 5} more)` : '';
    console.log(`        ${preview}${more}`);
  } else {
    console.log('        (no Computer(...) patterns found — everything will be denied)');
    console.log('        add to ~/.agents/permissions/groups/<name>.yaml under allow:');
    console.log('          - "Computer(com.apple.finder)"');
  }
  console.log(`peers:  ${callers.length} caller${callers.length === 1 ? '' : 's'} allowed (${resolvePeersPath()})`);
}

/**
 * Forward one invocation to the engine and propagate its exit code.
 *
 * A missing standalone is the one failure agents-cli reports itself, because it
 * is the one the engine cannot: it prints the install line and exits 1. There is
 * no fallback engine to reach for — that is the point of the extraction.
 */
export async function forwardToComputer(opts: {
  argv: string[];
  device?: string;
  tcpOverride?: { host: string; port: number };
  /** Skip recording — lifecycle verbs are not user actions. */
  record?: boolean;
  /** Read the engine's stdout instead of letting it reach the terminal. */
  capture?: boolean;
}): Promise<{ exitCode: number; stdout: string }> {
  let bin: string;
  try {
    bin = resolveComputerBin();
  } catch (err) {
    if (isComputerClientError(err)) {
      console.error(err.message);
      return { exitCode: 1, stdout: '' };
    }
    throw err;
  }

  const context = await buildComputerContext({ device: opts.device, computerBin: bin });

  return runComputer({
    argv: opts.argv,
    context,
    // The engine reads its transport from the environment it inherits. The one
    // value it cannot inherit is the loopback port a `--device` tunnel just
    // landed on, so that is overlaid here.
    env: computerTransportEnv({ device: opts.device, tcpOverride: opts.tcpOverride }),
    capture: opts.capture,
    onEvent: opts.record === false
      ? undefined
      : (event) => recordComputerAction(event, { device: opts.device }),
  });
}

/** Forward, then exit with the engine's status so shells and agents see the truth. */
async function forwardAndExit(opts: Parameters<typeof forwardToComputer>[0]): Promise<void> {
  const { exitCode } = await forwardToComputer(opts);
  if (exitCode !== 0) process.exit(exitCode);
}

export function registerComputerCommand(program: Command): void {
  const computer = program
    .command('computer')
    .description('Drive macOS apps via Accessibility, a Linux GUI desktop with --vnc, or a remote Windows device with --device — screenshot, click, type')
    // A VNC/RFB desktop is driven over the wire (--vnc host:port, e.g. an x11vnc
    // server on a headless Linux box or an LXD container). Set it before the gate.
    .option('--vnc <host:port>', 'Drive a GUI desktop over VNC/RFB (x11vnc/Xvnc; port defaults to 5901) instead of a native helper')
    .option('--vnc-password <password>', 'VNC password for --vnc (or set COMPUTER_HELPER_VNC_PASSWORD)')
    // The whole subsystem is macOS Accessibility / TCC for LOCAL driving. Off
    // macOS it still works against a remote daemon (COMPUTER_HELPER_TCP set, a
    // --vnc desktop, or a `--device <name>` invocation). Fail fast with a clear
    // message only when no remote path is available, instead of a downstream error.
    .hook('preAction', async (_thisCommand, actionCommand) => {
      const globals = actionCommand.optsWithGlobals() as { vnc?: string; vncPassword?: string; device?: string };
      // --vnc selects the RFB transport for every verb under this command.
      if (globals.vnc) {
        process.env.COMPUTER_HELPER_VNC = globals.vnc;
        if (globals.vncPassword) process.env.COMPUTER_HELPER_VNC_PASSWORD = globals.vncPassword;
      }
      const device = globals.device;
      // A plain verb against a device needs a live tunnel; the lifecycle verbs
      // create or report on one, so they handle absence themselves.
      if (device && !REMOTE_LIFECYCLE.has(actionCommand.name())) {
        if (!isTunnelAlive(readRemoteState(device))) {
          console.error(`No active remote tunnel for '${device}'.`);
          console.error(`Run:  agents computer start --device ${device}`);
          process.exit(1);
        }
      }
      if (shouldBlockOffPlatform({
        platform: process.platform,
        tcpConfigured: resolveTcpEndpoint() != null,
        vncConfigured: resolveVncEndpoint() != null,
        device,
      })) {
        console.error('agents computer: macOS only for local driving — it uses the macOS Accessibility API.');
        console.error('For a Linux GUI desktop over VNC: `agents computer --vnc <host:port> screenshot`.');
        console.error('For a remote Windows device: register it with `agents devices`, then use --device (or set COMPUTER_HELPER_TCP).');
        process.exit(1);
      }
    });

  registerComputerSubcommands(computer);
  registerCommandGroups(computer, COMPUTER_HELP_GROUPS);
  setHelpSections(computer, {
    examples: `
      # One-time: install the engine, the helper, and the TCC grants
      npm i -g @phnx-labs/computer-cli
      agents setup computer

      # Allow an app, then reload so the daemon picks it up
      #   ~/.agents/permissions/groups/computer.yaml:  allow: ["Computer(com.apple.notes)"]
      agents computer reload

      # Observe, then act
      agents computer apps --json
      agents computer describe --bundle com.apple.notes
      agents computer click --bundle com.apple.notes --id <element-id>

      # A remote Windows device over the fleet
      agents computer setup --device win-mini
      agents computer start --device win-mini
      agents computer screenshot --device win-mini -o /tmp/win.png
      agents computer stop  --device win-mini
    `,
    notes: `
      The engine is the standalone \`computer\` CLI (npm i -g @phnx-labs/computer-cli);
      agents-cli supplies the permission allow list, --device fleet resolution, and
      the session/feed history. Per-verb flags are the engine's — \`agents computer
      click --help\` asks it directly.

      Apps are deny-by-default: a verb only reaches an app named by a
      Computer(<bundle-id>) rule in ~/.agents/permissions/groups/. Edit a group,
      then \`agents computer reload\`.

      \`agents computer sessions\` (and \`agents sessions --computer\`) reads the
      action history agents-cli records — it never leaves this CLI.
    `,
  });
}

export function registerComputerSubcommands(program: Command): void {
  registerSetupCommand(program);
  registerStartCommand(program);
  registerStopCommand(program);
  registerReloadCommand(program);
  registerStatusCommand(program);
  registerPassthroughVerbs(program);
  registerSessionsCommand(program);
  registerCommandGroups(program, COMPUTER_HELP_GROUPS);
}

/**
 * Register every plain verb as an opaque forwarder.
 *
 * `allowUnknownOption` is what makes this thin: commander stops trying to parse
 * flags it does not own and hands them through in `cmd.args`, so the engine's
 * flag surface can grow without a matching edit here.
 */
function registerPassthroughVerbs(program: Command): void {
  for (const verb of COMPUTER_PASSTHROUGH_VERBS) {
    program
      .command(verb.name)
      .description(verb.description)
      .option('--device <name>', 'Drive a remote device (requires `agents computer start --device <name>` first)')
      .allowUnknownOption(true)
      .allowExcessArguments(true)
      .helpOption(false)
      .action(async (opts: { device?: string }, cmd: Command) => {
        await forwardAndExit({ argv: [verb.name, ...cmd.args], device: opts.device });
      });
  }
}

function registerSetupCommand(program: Command): void {
  program
    .command('setup')
    .alias('install-helper')
    .description('Install the helper — locally to /Applications/ (macOS), or to a remote Windows device with --device')
    .option('--device <name>', 'Provision a remote Windows device (push the exe + register a LOGON task) instead of installing locally')
    .allowUnknownOption(true)
    .allowExcessArguments(true)
    .helpOption(false)
    .action(async (opts: { device?: string }, cmd: Command) => {
      // Render the allow list first: a fresh install should come up with the
      // user's current permissions already in force, not an empty deny-all that
      // needs a second `reload` to fix.
      renderPolicyFiles({ quiet: true });
      await forwardAndExit({ argv: ['setup', ...cmd.args], device: opts.device, record: false });
    });
}

function registerStartCommand(program: Command): void {
  program
    .command('start')
    .description('Activate the helper daemon — local launchd (macOS) or a remote Windows tunnel with --device')
    .option('--device <name>', 'Open a tunnel to the remote Windows daemon and record it for --device verbs')
    .allowUnknownOption(true)
    .allowExcessArguments(true)
    .helpOption(false)
    .action(async (opts: { device?: string }, cmd: Command) => {
      if (opts.device) {
        await startRemote(opts.device);
        return;
      }
      // Policy must be on disk before the daemon boots and reads it.
      renderPolicyFiles();
      await forwardAndExit({ argv: ['start', ...cmd.args], record: false });
    });
}

/**
 * `start --device`: open the tunnel here (fleet), then let the engine prove the
 * daemon answers through it. A refusal rolls the tunnel back rather than leaving
 * a recorded endpoint that every later verb will hang on.
 */
async function startRemote(device: string): Promise<void> {
  let opened: Awaited<ReturnType<typeof startRemoteTunnel>>;
  try {
    opened = await startRemoteTunnel(device);
  } catch (err) {
    console.error(`error: ${(err as Error).message}`);
    process.exit(1);
  }
  const { state, rollback } = opened;
  console.log(`tunnel: 127.0.0.1:${state.localPort} -> ${state.target} (127.0.0.1:${state.remotePort})`);

  const { exitCode } = await forwardToComputer({
    argv: ['status'],
    device,
    tcpOverride: { host: '127.0.0.1', port: state.localPort },
    record: false,
  });
  if (exitCode !== 0) {
    rollback();
    console.error(`tunnel to '${device}' opened but the daemon did not answer.`);
    console.error(`Run:  agents computer setup --device ${device}`);
    process.exit(exitCode);
  }

  console.log(`daemon: answering (ssh pid ${state.tunnelPid})`);
  console.log('');
  console.log(`Drive it:  agents computer apps --device ${device}`);
  console.log(`Stop:      agents computer stop --device ${device}`);
}

function registerStopCommand(program: Command): void {
  program
    .command('stop')
    .description('Deactivate the helper daemon — local launchd (macOS) or a remote Windows tunnel with --device')
    .option('--device <name>', 'Tear down the remote tunnel and unregister the scheduled task')
    .allowUnknownOption(true)
    .allowExcessArguments(true)
    .helpOption(false)
    .action(async (opts: { device?: string }, cmd: Command) => {
      if (opts.device) {
        // The engine unregisters the remote task it registered; the tunnel is
        // ours. Tear the tunnel down either way — a device that has gone offline
        // must not leave a zombie ssh on this machine.
        const { exitCode } = await forwardToComputer({ argv: ['stop', ...cmd.args], device: opts.device, record: false });
        const { tunnelKilled } = stopRemoteTunnel(opts.device);
        console.log(`tunnel: ${tunnelKilled ? 'closed' : 'not running'}`);
        if (exitCode !== 0) {
          console.log('task:   not removed (device offline?)');
          process.exit(exitCode);
        }
        return;
      }
      await forwardAndExit({ argv: ['stop', ...cmd.args], record: false });
    });
}

function registerReloadCommand(program: Command): void {
  program
    .command('reload')
    .description('Reload the allow-list policy (SIGHUP the local daemon) — or restart a remote Windows daemon with --device')
    .option('--device <name>', 'Restart the remote Windows daemon (its scheduled task) instead of SIGHUPing the local one')
    .allowUnknownOption(true)
    .allowExcessArguments(true)
    .helpOption(false)
    .action(async (opts: { device?: string }, cmd: Command) => {
      // Reload EXISTS to re-render the allow list; doing it before the signal is
      // the whole command. The remote daemon enforces no allow list, but the
      // files are cheap and keep one code path.
      renderPolicyFiles();
      await forwardAndExit({ argv: ['reload', ...cmd.args], device: opts.device, record: false });
    });
}

function registerStatusCommand(program: Command): void {
  program
    .command('status')
    .description('Report install state, daemon state, and Accessibility trust — or a remote Windows daemon with --device')
    .option('--device <name>', 'Report the remote Windows daemon (tunnel + liveness) instead of the local helper')
    .allowUnknownOption(true)
    .allowExcessArguments(true)
    .helpOption(false)
    .action(async (opts: { device?: string }, cmd: Command) => {
      const json = cmd.args.includes('--json');
      if (opts.device) {
        const state = readRemoteState(opts.device);
        if (!isTunnelAlive(state)) {
          if (!json) {
            console.log(`device:    ${opts.device}`);
            console.log('tunnel:    none');
            console.log('daemon:    unknown (no tunnel to probe through)');
            console.log('');
            console.log(`Run:  agents computer start --device ${opts.device}`);
          } else {
            console.log(JSON.stringify({ device: opts.device, tunnel: null, daemon: 'unknown' }, null, 2));
          }
          process.exit(1);
        }
        if (!json) {
          console.log(`device:    ${opts.device}`);
          console.log(`tunnel:    127.0.0.1:${state!.localPort} -> ${state!.target} (127.0.0.1:${state!.remotePort})`);
        }
        await forwardAndExit({ argv: ['status', ...cmd.args], device: opts.device, record: false });
        return;
      }

      // The allow list is agents-cli's answer, not the engine's — report it here
      // so `status` stays the one place that tells you why an app is refused.
      if (!json) {
        const allowed = loadComputerAllowList();
        const preview = allowed.slice(0, 5).join(', ');
        const suffix = allowed.length > 5 ? ` (+${allowed.length - 5} more)` : '';
        console.log(`policy:    ${allowed.length} app${allowed.length === 1 ? '' : 's'} allowed${allowed.length > 0 ? `: ${preview}${suffix}` : ''}`);
        console.log(`peers:     ${loadDefaultPeers().length} caller(s) (peer-auth on socket)`);
      }
      await forwardAndExit({ argv: ['status', ...cmd.args], record: false });
    });
}

// sessions — task-first history over the computer.action event ledger (RUSH-2432),
// the computer counterpart of `agents browser sessions` (RUSH-2407). `agents
// sessions --computer` (sessions.ts) routes to the same runComputerSessionsCommand.
// It reads agents-cli's own ledger, so it never reaches the engine.
function registerSessionsCommand(program: Command): void {
  program
    .command('sessions')
    .description('Browse computer-driving history, grouped by run — one row per `agents computer` invocation')
    .option('--machine <name>', 'Only rows invoked from/driving this machine (hostname, machineId, or --device name)')
    .option('--limit <n>', 'Cap the flat/--no-interactive table at this many rows (default 50; --json is unbounded)', (v) => parseInt(v, 10))
    .option('--json', 'Emit machine-readable JSON')
    .option('--no-interactive', 'Print the flat listing instead of opening the interactive run browser')
    .action(async (opts: { machine?: string; limit?: number; json?: boolean; interactive?: boolean }) => {
      await runComputerSessionsCommand({ machine: opts.machine, limit: opts.limit, json: opts.json, interactive: opts.interactive });
    });
}

/**
 * Install the macOS helper through the engine. Used by the `agents setup
 * computer` wizard, which still owns the TCC hand-holding — that is a
 * conversation with the user, not a daemon operation.
 */
export async function installComputerHelperMacLocal(): Promise<void> {
  renderPolicyFiles({ quiet: true });
  const { exitCode } = await forwardToComputer({ argv: ['setup'], record: false });
  if (exitCode !== 0) throw new Error(`\`computer setup\` failed (exit ${exitCode})`);
}

/**
 * Activate the local daemon through the engine and report whether Accessibility
 * trust is granted, so the wizard knows whether to walk the user to System
 * Settings.
 */
export async function activateComputerHelperMacLocal(): Promise<{ trusted: boolean }> {
  renderPolicyFiles();
  const { exitCode } = await forwardToComputer({ argv: ['start'], record: false });
  if (exitCode !== 0) throw new Error(`\`computer start\` failed (exit ${exitCode})`);
  return { trusted: await probeComputerTrust() };
}

/**
 * Read `trusted` out of `computer status --json`.
 *
 * Tolerant by construction: the engine may print a banner line before its JSON,
 * so scan for the first parseable object rather than assuming the whole stream
 * is JSON. Pure, so the parsing contract is testable without a daemon.
 */
export function parseTrustFromStatusJson(stdout: string): boolean {
  const start = stdout.indexOf('{');
  if (start < 0) return false;
  try {
    const parsed = JSON.parse(stdout.slice(start)) as { trusted?: unknown };
    return parsed.trusted === true;
  } catch {
    return false;
  }
}

/**
 * Probe Accessibility trust without re-activating. Returns false (never throws)
 * when the engine is absent, the daemon is down, or the probe errors — the
 * wizard polls this while the user grants permissions in System Settings, and a
 * throw there would abort the very flow that fixes it.
 *
 * This is the ONE place agents-cli reads engine stdout instead of passing it
 * through, because it needs an answer rather than a display.
 */
export async function probeComputerTrust(): Promise<boolean> {
  try {
    const { exitCode, stdout } = await forwardToComputer({
      argv: ['status', '--json'],
      record: false,
      capture: true,
    });
    if (exitCode !== 0) return false;
    return parseTrustFromStatusJson(stdout);
  } catch {
    return false;
  }
}
