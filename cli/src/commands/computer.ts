/** `agents computer` is the consumer surface over the standalone `computer` CLI (PHNX-4075): every
 * verb forwards verbatim and propagates the exit code. agents-cli adds the permissions and peer
 * allow lists, `--device`, fd-3 context and an fd-4 recorder. Verb flags are not redeclared. */

import { Command } from 'commander';
import { registerCommandGroups, setHelpSections } from '../lib/help.js';
import {
  loadComputerAllowList,
  loadDefaultPeers,
  resolveTcpEndpoint,
  resolveVncEndpoint,
} from '../lib/computer/policy.js';
import { buildComputerContext, type ComputerTargetContext } from '../lib/computer/context.js';
import { recordComputerAction } from '../lib/computer/record.js';
import { resolveRemoteDevice } from '../lib/ssh-tunnel.js';
import { getConfigValue } from '../lib/device-config.js';
import { parseAddress, sshTarget } from '../lib/address.js';
import {
  isComputerClientError,
  resolveComputerBin,
  runComputer,
} from '../lib/computer-client.js';
import { runComputerSessionsCommand } from './computer-sessions-picker.js';

const COMPUTER_HELP_GROUPS = [
  { title: 'Installation', names: ['setup'] },
  { title: 'Daemon lifecycle', names: ['start', 'stop', 'reload', 'status'] },
  { title: 'Autonomous', names: ['run'] },
  { title: 'Observe', names: ['apps', 'describe', 'screenshot', 'get-text'] },
  { title: 'Interact', names: ['launch', 'raise', 'click', 'right-click', 'type', 'type-text', 'key', 'drag', 'scroll', 'ax-action', 'focus', 'wait'] },
  { title: 'History and discovery', names: ['sessions'] },
] as const;

/** The verb catalog: descriptions are the consumer's, flags are the engine's. This list is the
 * contract with the engine (`computer --verbs` must report the same names), pinned by
 * `computer.test.ts` so drift fails a test. */
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

/** Pure platform gate. Computer is macOS-only for local driving (Accessibility/launchctl) but not
 * blocked off macOS when a remote daemon is reachable: a configured COMPUTER_HELPER_TCP endpoint
 * or a `--device <name>` invocation. */
export function shouldBlockOffPlatform(opts: {
  platform: NodeJS.Platform;
  tcpConfigured: boolean;
  vncConfigured?: boolean;
  device?: string;
}): boolean {
  if (opts.platform === 'darwin') return false;
  if (opts.tcpConfigured) return false;
  if (opts.vncConfigured) return false;
  if (opts.device) return false;
  return true;
}

/** Put `--host <address>` on the engine argv: commander consumes `--device`, so a verb reading only
 * `opts.device` forwarded no remote selector and ran locally. Re-insert it right after the verb
 * (variadic operands can't swallow it); a caller-typed `--host` always wins (PHNX-4090). */
export function withHostFlag(argv: string[], host?: string): string[] {
  if (!host) return argv;
  if (argv.some((arg) => arg === '--host' || arg.startsWith('--host='))) return argv;
  const [verb, ...rest] = argv;
  return [verb, '--host', host, ...rest];
}

/** Resolve `--device <name>` to the `--host <address>` the engine speaks (PHNX-4090). A device's
 * `computer.host` config wins when set (`vnc://`/`tcp://` carry no ssh identity, `ssh://` still
 * resolves one); otherwise fall back to the fleet's ssh identity (Windows-only). */
export async function resolveDeviceHost(device: string): Promise<{ host: string; target: ComputerTargetContext }> {
  const configured = getConfigValue('computer.host', { device }).value as string | undefined;
  if (configured) {
    const addr = parseAddress(configured);
    if (addr.scheme === 'vnc' || addr.scheme === 'tcp') {
      return { host: configured, target: { alias: device, host: addr.host, user: addr.user ?? '', hostname: addr.host, platform: addr.scheme, sshArgs: [] } };
    }
    // The configured address is the connection target: an ssh:// override naming a different
    // host/user/port than the registry must take effect. Only the ssh identity comes from the
    // fleet.
    const resolved = await resolveRemoteDevice(device, {});
    const target = sshTarget(addr);
    return {
      host: configured,
      target: { alias: device, host: target, user: addr.user ?? resolved.user, hostname: addr.host, platform: resolved.device.platform, sshArgs: resolved.identityArgs },
    };
  }
  const resolved = await resolveRemoteDevice(device, {
    expectPlatform: 'windows',
    forWhat: '`agents computer --device` drives the Windows computer-helper daemon, so it',
  });
  return {
    host: `ssh://${resolved.target}`,
    target: { alias: device, host: resolved.target, user: resolved.user, hostname: resolved.host, platform: resolved.device.platform, sshArgs: resolved.identityArgs },
  };
}

/** Forward one invocation to the engine and propagate its exit code. A missing standalone is the
 * one failure agents-cli reports itself (install line, exit 1); there is no fallback engine. */
async function forwardToComputer(opts: {
  argv: string[];
  device?: string;
  record?: boolean;
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

  const hostFlag = opts.argv.findIndex(arg => arg === '--host' || arg.startsWith('--host='));
  let host = hostFlag < 0 ? undefined : (opts.argv[hostFlag].includes('=') ? opts.argv[hostFlag].slice(7) : opts.argv[hostFlag + 1]);
  let target: ComputerTargetContext | undefined;
  if (!host && opts.device) {
    const resolved = await resolveDeviceHost(opts.device);
    host = resolved.host;
    target = resolved.target;
  }
  const context = await buildComputerContext({ device: opts.device, host, target, computerBin: bin });

  return runComputer({
    argv: withHostFlag(opts.argv, host),
    context,
    capture: opts.capture,
    onEvent: opts.record === false
      ? undefined
      : (event) => recordComputerAction(event, { device: opts.device }),
  });
}

async function forwardAndExit(opts: Parameters<typeof forwardToComputer>[0]): Promise<void> {
  const { exitCode } = await forwardToComputer(opts);
  if (exitCode !== 0) process.exit(exitCode);
}

export function registerComputerCommand(program: Command): void {
  const computer = program
    .command('computer')
    .description('Drive macOS apps via Accessibility, a Linux GUI desktop with --vnc, or a remote Windows device with --device — screenshot, click, type')
    .option('--vnc <host:port>', 'Drive a GUI desktop over VNC/RFB (x11vnc/Xvnc; port defaults to 5901) instead of a native helper')
    .option('--vnc-password <password>', 'VNC password for --vnc (or set COMPUTER_HELPER_VNC_PASSWORD)')
    // The subsystem is macOS Accessibility/TCC for local driving. Off macOS it works against a
    // remote daemon (COMPUTER_HELPER_TCP, a --vnc desktop, or `--device`); fail fast with a clear
    // message only when no remote path is available.
    .hook('preAction', async (_thisCommand, actionCommand) => {
      const globals = actionCommand.optsWithGlobals() as { vnc?: string; vncPassword?: string; device?: string };
      if (globals.vnc) {
        process.env.COMPUTER_HELPER_VNC = globals.vnc;
        if (globals.vncPassword) process.env.COMPUTER_HELPER_VNC_PASSWORD = globals.vncPassword;
      }
      const device = globals.device;
      if (shouldBlockOffPlatform({
        platform: process.platform,
        tcpConfigured: resolveTcpEndpoint() != null,
        vncConfigured: resolveVncEndpoint() != null,
        device: device || (actionCommand.args.some(arg => arg === '--host' || arg.startsWith('--host=')) ? 'direct-host' : undefined),
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

function registerComputerSubcommands(program: Command): void {
  registerSetupCommand(program);
  registerStartCommand(program);
  registerStopCommand(program);
  registerReloadCommand(program);
  registerStatusCommand(program);
  registerPassthroughVerbs(program);
  registerSessionsCommand(program);
  registerCommandGroups(program, COMPUTER_HELP_GROUPS);
}

/** Register every plain verb as an opaque forwarder: `allowUnknownOption` hands unowned flags
 * through in `cmd.args`, so the engine's flag surface can grow without an edit here. */
function registerPassthroughVerbs(program: Command): void {
  for (const verb of COMPUTER_PASSTHROUGH_VERBS) {
    program
      .command(verb.name)
      .description(verb.description)
      .option('--device <name>', 'Drive a remote Windows device registered with `agents devices` (the engine connects or provisions it on demand)')
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
      await forwardAndExit({ argv: ['setup', ...cmd.args], device: opts.device, record: false });
    });
}

function registerStartCommand(program: Command): void {
  program
    .command('start')
    .description('Activate the helper daemon — local launchd (macOS) or a remote Windows tunnel with --device')
    .option('--device <name>', 'Start the remote Windows daemon and its tunnel instead of the local launchd service')
    .allowUnknownOption(true)
    .allowExcessArguments(true)
    .helpOption(false)
    .action(async (opts: { device?: string }, cmd: Command) => {
      await forwardAndExit({ argv: ['start', ...cmd.args], device: opts.device, record: false });
    });
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
      await forwardAndExit({ argv: ['stop', ...cmd.args], device: opts.device, record: false });
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
      // Reload exists to re-render the allow list, so do it before the signal. A `--device` reload
      // bounces the remote daemon, which enforces no allow list, so rendering this machine's would
      // claim a policy that device never reads.
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
      // The allow list is agents-cli's answer, not the engine's, so `status` reports it here as
      // the one place that says why an app is refused. It governs the local helper only; the
      // Windows daemon enforces none.
      if (!json && !opts.device) {
        const allowed = loadComputerAllowList();
        const preview = allowed.slice(0, 5).join(', ');
        const suffix = allowed.length > 5 ? ` (+${allowed.length - 5} more)` : '';
        console.log(`policy:    ${allowed.length} app${allowed.length === 1 ? '' : 's'} allowed${allowed.length > 0 ? `: ${preview}${suffix}` : ''}`);
        console.log(`peers:     ${loadDefaultPeers().length} caller(s) (peer-auth on socket)`);
      }
      await forwardAndExit({ argv: ['status', ...cmd.args], device: opts.device, record: false });
    });
}

// sessions: task-first history over the computer.action event ledger (RUSH-2432), the counterpart
// of `agents browser sessions`. It reads agents-cli's own ledger and never reaches the engine;
// `agents sessions --computer` routes to the same runComputerSessionsCommand.
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

/** Install the macOS helper through the engine, for the `agents setup computer` wizard, which still
 * owns the TCC hand-holding (a conversation with the user, not a daemon operation). */
export async function installComputerHelperMacLocal(): Promise<void> {
  const { exitCode } = await forwardToComputer({ argv: ['setup'], record: false });
  if (exitCode !== 0) throw new Error(`\`computer setup\` failed (exit ${exitCode})`);
}

/** Activate the local daemon through the engine and report whether Accessibility trust is granted,
 * so the wizard knows whether to walk the user to System Settings. */
export async function activateComputerHelperMacLocal(): Promise<{ trusted: boolean }> {
  const { exitCode } = await forwardToComputer({ argv: ['start'], record: false });
  if (exitCode !== 0) throw new Error(`\`computer start\` failed (exit ${exitCode})`);
  return { trusted: await probeComputerTrust() };
}

/** Read `trusted` out of `computer status --json`. Tolerant by construction: the engine may print a
 * banner before the JSON, so scan for the first parseable object. Pure, so testable without a
 * daemon. */
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

/** Probe Accessibility trust without re-activating. Returns false when the engine is absent, the
 * daemon is down or the probe errors, since a throw would abort the wizard flow that polls this
 * while the user grants permissions. */
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
