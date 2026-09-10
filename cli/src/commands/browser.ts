import { Command, Option } from 'commander';
import chalk from 'chalk';
import { spawnSync } from 'node:child_process';
import * as fs from 'fs';
import * as path from 'path';
import {
  listProfiles,
  getProfile,
  createProfile,
  deleteProfile,
  getConfiguredDefaultProfileName,
  resolveProfileRef,
  resolveProfileRefForStart,
  getProfileRuntimeDir,
  extractConfiguredPort,
  findFreeProfilePort,
  getEndpointPresets,
  formatProfilesTable,
  type BrowserProfile,
  editProfile,
  renameProfile,
  assertRegistrableProfileName,
  isProfileLaunchableHere,
  isAttachOnlyProfile,
  resolveProfileDataDir,
  normalizeDataDir,
  persistDiscoveredProfile,
  type EditableProfileFields,
} from '../lib/browser/profiles.js';
import { declaringDevices, migrateCentralBrowserProfiles, profileKind } from '../lib/browser/registry.js';
import type { BrowserProfileConfig } from '../lib/types.js';
import { resolveActor } from '../lib/actor.js';
import {
  loginsForProfile,
  profilesLoggedInto,
  serviceForUrl,
  loginsWithAccountsForProfile,
  accountsForProfile,
  credKeysForService,
  AUTH_SIGNATURES,
} from '../lib/browser/login-detection.js';
import { parseSecretRef } from '../lib/browser/secret-ref.js';
import { readAndResolveBundleEnv, bundleExists, readBundle } from '../lib/secrets-client.js';
import { findBrowserPath, getPortOccupant, getProcessUserDataDir, isLauncherScript, listInstalledBrowsers } from '../lib/browser/chrome.js';
import {
  listProfileCacheDirs,
  removeProfileCache,
  listAllProfileSnapshots,
  buildProfilePrunePlan,
  pruneProfiles,
  PRUNE_REASON_TEXT,
  identityLoopbackMismatch,
} from '../lib/browser/runtime-state.js';
import { DEFAULT_VIEWPORT, parseWindowSize, parseWindowPosition } from '../lib/browser/devices.js';
import { runBrowserSessionsCommand } from './browser-sessions-picker.js';
import { discoverBrowserWsUrl, verifyBrowserIdentity } from '../lib/browser/cdp.js';
import { parseTargetFilter } from '../lib/browser/service.js';
import {
  BrowserServiceNotRunningError,
  formatBrowserServiceNotRunningError,
  sendIPCRequest as sendRawIPCRequest,
  stopBrowserService,
} from '../lib/browser/ipc.js';
import type { IPCRequest, IPCResponse } from '../lib/browser/types.js';
import {
  bindTask,
  getTaskBinding,
  honorScreenshotOutput,
  isTerminalBrowserVerb,
  REJECT_DEVICE_MESSAGE,
  resolveTaskRoute,
  unbindTask,
  unbindTasksForProfile,
  updateTaskBinding,
} from '../lib/browser/task-index.js';
import { callerIdentityEnv, resolveCallerIdentity } from '../lib/browser/caller-identity.js';
import { isSelfHost } from '../lib/devices/self-host.js';
import { resolveHost } from '../lib/hosts/registry.js';
import { sshTargetFor } from '../lib/hosts/types.js';
import { withActorEnv } from '../lib/hosts/dispatch.js';
import {
  streamAgentsOnHost,
  passthroughSshOptions,
} from '../lib/hosts/passthrough.js';
import {
  buildRemoteAgentsInvocation,
  HOST_ROUTING_SPECS,
  stripRoutingFlags,
} from '../lib/hosts/remote-cmd.js';
import { resolveRemoteOsSync } from '../lib/hosts/remote-os.js';
import { sshExec, SSH_OPTS } from '../lib/ssh-exec.js';
import { flagValue } from '../lib/hosts/routing-flag.js';
import { browserTaskPicker, type BrowserTask } from './browser-picker.js';
import { assertRemoteControlAllowed, isFleetRemoteInvocation } from '../lib/browser/remote-control.js';
import { getConfigValue, setConfigValue, unsetConfigValue } from '../lib/device-config.js';
import { isInteractiveTerminal } from './utils.js';
import { registerCommandGroups, setHelpSections } from '../lib/help.js';
import { buildHar } from '../lib/browser/har.js';
import { getCliVersion } from '../lib/version.js';
import { runBrowserIPCStream } from '../lib/browser/stream.js';
import { machineId } from '../lib/machine-id.js';
import { isArcRunning } from '../lib/browser/drivers/arc.js';
import { resolveBrowserTarget } from '../lib/browser/resolve-target.js';

/**
 * Task name inferred from the local task→device index when `--task` was
 * omitted and this session owns exactly one open task. Set by the page-verb
 * preAction hook; consumed by {@link resolveTaskName}.
 */
let inferredTaskName: string | undefined;

/**
 * Resolve which browser task a command targets. Order:
 *   1. `--task <name>` flag (explicit per-command override)
 *   2. `$AGENTS_BROWSER_TASK` (optional shell default)
 *   3. the local task-index match for this session (exactly one)
 *   4. `undefined` — the daemon resolves from the caller's identity
 *
 * `--device` on a page verb is rejected here so commander-parsed flags cannot
 * silently re-route a later verb. Bind the device at `start`.
 *
 * `undefined` is valid: page verbs create a task when none resolves, and
 * done/stop report "nothing to close". Agents no longer need to type a handle
 * in the common case.
 */
function resolveTaskName(opts: { task?: string; device?: string }): string | undefined {
  if (opts.device) {
    const route = resolveTaskRoute({ device: opts.device });
    console.error(route.kind === 'reject-device' ? route.message : REJECT_DEVICE_MESSAGE);
    process.exit(1);
  }
  if (opts.task) return opts.task;
  const fromEnv = process.env.AGENTS_BROWSER_TASK;
  if (fromEnv) return fromEnv;
  return inferredTaskName;
}

// `-t` is taken by `--tab` on most commands, so `--task` is long-form only.
// The daemon resolves from caller identity when omitted.
const TASK_OPTION_FLAG = '--task <name>';
const TASK_OPTION_DESC =
  'Task name (defaults to $AGENTS_BROWSER_TASK, else the caller\'s live task)';
const DEVICE_ON_PAGE_VERB_FLAG = '--device <name>';
const DEVICE_ON_PAGE_VERB_DESC =
  'Not valid here — bind the device at `agents browser start --device`';

const TASK_ROUTED_COMMANDS = new Set([
  'stream',
  'done',
  'stop',
  'navigate',
  'goto',
  'tab',
  'tabs',
  'screenshot',
  'pdf',
  'evaluate',
  'refs',
  'click',
  'type',
  'press',
  'hover',
  'scroll',
  'upload',
  'set',
  'console',
  'errors',
  'requests',
  'logs',
  'responsebody',
  'wait',
  'download',
  'record',
  'waitdownload',
]);

function commandPath(actionCommand: Command): string[] {
  const parts: string[] = [];
  let current: Command | null = actionCommand;
  while (current) {
    const name = current.name();
    if (name === 'agents' || name === 'browser') break;
    parts.unshift(name);
    current = current.parent ?? null;
  }
  return parts;
}

function callerSessionId(): string | undefined {
  return process.env.AGENT_SESSION_ID || process.env.AGENTS_SESSION_ID;
}

function callerLaunchId(): string | undefined {
  return process.env.AGENT_LAUNCH_ID;
}

function browserForwardedArgv(): string[] {
  const raw = process.argv.slice(2);
  const withCommand = raw[0] === 'browser' ? raw : ['browser', ...raw];
  return stripRoutingFlags(withCommand, HOST_ROUTING_SPECS);
}

async function dispatchBrowserToDevice(
  device: string,
  forwardedArgs: string[],
  mode: 'stream' | 'capture',
): Promise<{ code: number; stdout: string; stderr: string }> {
  const host = await resolveHost(device);
  if (!host) {
    throw new Error(
      `Unknown device "${device}". Next: agents devices list`,
    );
  }
  const target = sshTargetFor(host);
  const remoteOs = resolveRemoteOsSync(host.name);
  // Forward the caller's identity so the HUB resolves the same session/launch id
  // the worker would stamp locally. Without it the forwarded verb lands blank on
  // the hub and its no-identity task bucket collides with unrelated tasks — the
  // surface-parity gap the run --device path already closes (caller-identity.ts).
  const identityEnv = callerIdentityEnv(resolveCallerIdentity());
  const env = withActorEnv({ ...identityEnv, AGENTS_FLEET_REMOTE: '1' });
  const remoteCmd = buildRemoteAgentsInvocation(forwardedArgs, undefined, remoteOs, env);
  if (mode === 'stream') {
    const code = streamAgentsOnHost(host, forwardedArgs, {
      interactive: !!process.stdout.isTTY && !process.argv.includes('--no-tty'),
      extraEnv: { ...identityEnv, AGENTS_FLEET_REMOTE: '1' },
      remoteOs,
      target,
    });
    return { code, stdout: '', stderr: '' };
  }
  const sshOpts = passthroughSshOptions(host, false);
  const result = sshExec(target, remoteCmd, {
    multiplex: sshOpts.multiplex,
    extraSshArgs: sshOpts.extraSshArgs,
  });
  return {
    code: result.code ?? 1,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

export function remoteStartTaskName(stdout: string, explicit?: string): string | undefined {
  if (explicit) return explicit;
  const trimmed = stdout.trim();
  if (!trimmed) return undefined;
  try {
    const decoded = JSON.parse(trimmed) as { task?: unknown };
    if (typeof decoded.task === 'string' && decoded.task.length > 0) return decoded.task;
  } catch {
    // Human output is one task name on the first non-empty line.
  }
  return trimmed.split('\n').map((line) => line.trim()).find(Boolean);
}

async function pullRemoteFile(device: string, remotePath: string, localPath: string): Promise<void> {
  const host = await resolveHost(device);
  if (!host) {
    throw new Error(`Unknown device "${device}". Next: agents devices list`);
  }
  const target = sshTargetFor(host);
  fs.mkdirSync(path.dirname(path.resolve(localPath)), { recursive: true });
  const sshOpts = passthroughSshOptions(host, false);
  const copied = spawnSync(
    'scp',
    [...sshOpts.extraSshArgs, ...SSH_OPTS, `${target}:${remotePath}`, path.resolve(localPath)],
    { encoding: 'utf8' },
  );
  if (copied.status !== 0) {
    throw new Error(
      `Failed to copy screenshot from ${device}:${remotePath}: ${(copied.stderr || copied.stdout || '').trim()}`,
    );
  }
}

function syncTaskIndex(request: IPCRequest, response: IPCResponse): void {
  if (!response.ok) return;
  if (request.action === 'stop' && request.profile && !request.task) {
    unbindTasksForProfile(request.profile);
    return;
  }
  if (request.action === 'gc') {
    if (!request.dryRun) {
      for (const closed of response.reaped?.closed ?? []) {
        unbindTask(closed.task);
      }
    }
    return;
  }
  const name = response.task ?? request.task ?? request.taskName;
  if (!name) return;
  if (request.action === 'done' || (request.action === 'stop' && request.task)) {
    unbindTask(name);
    return;
  }
  if (request.action === 'start') {
    const existing = getTaskBinding(name);
    if (!existing) {
      bindTask(name, {
        device: machineId(),
        profile: request.profile,
        url: request.url,
        sessionId: request.sessionId ?? callerSessionId(),
        launchId: request.launchId ?? callerLaunchId(),
        createdAt: Date.now(),
      });
    } else if (request.url) {
      updateTaskBinding(name, { url: request.url });
    }
    return;
  }
  if (request.url) {
    const existing = getTaskBinding(name);
    if (existing) {
      updateTaskBinding(name, { url: request.url });
    } else {
      bindTask(name, {
        device: machineId(),
        profile: request.profile,
        url: request.url,
        sessionId: request.sessionId ?? callerSessionId(),
        launchId: request.launchId ?? callerLaunchId(),
        createdAt: Date.now(),
      });
    }
    return;
  }
  if (!getTaskBinding(name)) {
    bindTask(name, {
      device: machineId(),
      profile: request.profile,
      sessionId: request.sessionId ?? callerSessionId(),
      launchId: request.launchId ?? callerLaunchId(),
      createdAt: Date.now(),
    });
  }
}

async function sendIPCRequest(
  request: IPCRequest,
  opts?: { autoStartDaemon?: boolean },
): Promise<IPCResponse> {
  const response = await sendRawIPCRequest(request, opts);
  syncTaskIndex(request, response);
  return response;
}

function assertDeviceDeclaresProfile(device: string, profileName: string): void {
  const declared = declaringDevices(profileName);
  if (declared.includes(device)) return;
  const where =
    declared.length > 0
      ? `Declared on: ${declared.join(', ')}.`
      : 'No device declares that profile.';
  throw new Error(
    `Device "${device}" does not declare browser profile "${profileName}". ${where}\n` +
      `Next: run \`agents browser profiles add ${profileName} --browser <b>\` on ${device}.`,
  );
}

/**
 * The fleet browser hub this box drives by default (`browser.device`), or
 * undefined to drive locally. It is one fleet-synced value in the central
 * agents.yaml, so every box reads the same hub name — but the hub itself resolves
 * to a self-host, and a fleet-dispatched invocation is already ON its target, so
 * both return undefined. That self short-circuit is what lets a single synced
 * value be safe: only the boxes that are NOT the hub forward to it, and the hub
 * never forwards to itself.
 */
export function defaultBrowserHub(): string | undefined {
  if (isFleetRemoteInvocation()) return undefined;
  const hub = getConfigValue('browser.device').value as string | undefined;
  if (!hub || isSelfHost(hub)) return undefined;
  return hub;
}

// Help groups — surfaces the actual mental model an agent follows
// ("open a session / drive the page / capture evidence / rare extras")
// instead of an alphabetical dump. Everything not listed falls into a
// trailing "Other commands" section automatically.
const BROWSER_HELP_GROUPS = [
  { title: 'Session lifecycle', names: ['use', 'start', 'done', 'status', 'prune'] },
  { title: 'Fast action loop', names: ['stream'] },
  {
    title: 'Drive the page',
    names: ['navigate', 'tabs', 'screenshot', 'evaluate', 'click', 'type', 'press', 'wait'],
  },
  {
    title: 'Capture evidence',
    names: ['console', 'errors', 'requests', 'responsebody', 'record', 'pdf', 'logs'],
  },
  { title: 'History and discovery', names: ['sessions', 'history', 'refs'] },
] as const;

export function registerBrowserCommand(program: Command): void {
  const browser = program
    .command('browser')
    .description('Launch and drive browser profiles via the Chrome DevTools Protocol. Power-tool for the `browser` skill.');

  setHelpSections(browser, {
    examples: `
      # List configured browser profiles
      agents browser profiles list

      # Create a Chrome profile pointed at a CDP endpoint
      agents browser profiles create work --browser chrome --endpoint http://localhost:9222

      # Start a session on this machine's default browser (set it once with: agents browser use)
      agents browser start

      # Or pin to a specific profile
      agents browser start --profile work

      # Drive the page (no start / --task needed — identity resolves the task)
      agents browser navigate https://example.com
      agents browser screenshot

      # Keep one process and browser-service socket warm for repeated actions
      agents browser stream --task "$AGENTS_BROWSER_TASK"

      # Bind a device at start; later verbs resolve it from the task
      agents browser start --task post --device zion --url https://x.com/
      agents browser type --task post --ref @e3 "hello"
      agents browser screenshot --task post

      # Browse a task-heavy profile's captures: one row per task, not per file
      agents browser sessions

      # Allow / deny other fleet machines driving THIS machine's browser
      agents browser remote-control on

      # End the session when done
      agents browser done

      # Close tabs the daemon's own reaper would have caught on its next 5-min tick
      agents browser prune --dry-run

      # Recover browser IPC without interrupting routines, usage, or secrets:
      # stop only the browser service, then start it clean
      agents browser stop --service
      agents browser start
    `,
    notes: `
      Most agent workflows should use the 'browser' skill instead of raw subcommands.
      The skill wraps profile selection, snapshotting, and tunneling.

      Browser support: Chromium-family only (Chrome, Comet, Chromium, Brave, Edge, Arc).
      Safari and Firefox are not supported — they don't speak the Chrome DevTools
      Protocol the way agents browser expects. On Windows, Edge is the default
      because it's preinstalled. On macOS and Linux, Chrome is preferred when
      installed; otherwise the first Chromium-family binary on disk wins.
    `,
  });

  registerBrowserUseCommand(browser);
  registerProfilesCommands(browser);
  registerTaskCommands(browser);
  registerCommandGroups(browser, BROWSER_HELP_GROUPS);
}

export function registerBrowserSubcommands(program: Command): void {
  registerBrowserUseCommand(program);
  registerProfilesCommands(program);
  registerTaskCommands(program);
  registerCommandGroups(program, BROWSER_HELP_GROUPS);
}

interface BrowserUseOptions {
  unset?: boolean;
}

interface BrowserUseChoice {
  name: string;
  value: { name: string; installed?: ReturnType<typeof listInstalledBrowsers>[number] };
}

export function buildBrowserUseChoices(
  profiles: BrowserProfile[],
  installed: ReturnType<typeof listInstalledBrowsers>,
  current?: string,
): BrowserUseChoice[] {
  const choices: BrowserUseChoice[] = profiles.map((profile) => ({
    name: `${profile.name}${profile.name === current ? ' (current)' : ''}`,
    value: { name: profile.name },
  }));
  const known = new Set(profiles.map((profile) => profile.name));
  for (const browser of installed) {
    const name = `${browser.browserType}-local`;
    if (!known.has(name)) {
      choices.push({ name: `${name} (installed ${browser.browserType})`, value: { name, installed: browser } });
    }
  }
  return choices;
}

export async function runBrowserUse(
  name: string | undefined,
  opts: BrowserUseOptions,
  interactive = isInteractiveTerminal(),
): Promise<boolean> {
  if (opts.unset || name === 'auto') {
    unsetConfigValue('browser.profile');
    console.log('Default browser profile cleared. Pick one with `agents browser use <name>` (or `agents setup`); until then `agents browser start` has no default to launch here.');
    return true;
  }

  let selectedName = name;
  if (!selectedName) {
    const current = getConfiguredDefaultProfileName();
    if (!interactive) {
      console.log(current
        ? `Default browser profile (this machine): ${current}`
        : 'Default browser profile (this machine): none — pick one with `agents browser use <name>`');
      const hub = getConfigValue('browser.device').value as string | undefined;
      if (hub) {
        console.log(
          isSelfHost(hub)
            ? `Browser hub (browser.device): ${hub} — this machine, so drives locally`
            : `Browser hub (browser.device): ${hub} — bare \`agents browser start\` drives ${hub}'s browser`,
        );
      }
      console.log('Usage: agents browser use <name>  (or --unset)');
      console.log('Fleet hub: agents config set browser.device <device>  (drive that box\'s browser from every machine)');
      return true;
    }

    const choices = buildBrowserUseChoices(await listProfiles(), listInstalledBrowsers(), current);
    if (choices.length === 0) {
      console.error('No configured profiles or supported installed browsers found.');
      console.error('Create one with: agents browser profiles create <name> --browser chrome');
      return false;
    }
    const { select } = await import('@inquirer/prompts');
    const selected = await select({ message: 'Select default browser profile:', choices });
    selectedName = selected.name;
    if (selected.installed) {
      const freePort = await findFreeProfilePort();
      await createProfile({
        name: selected.name,
        description: `Seeded ${selected.installed.browserType} profile`,
        browser: selected.installed.browserType,
        binary: selected.installed.binary,
        endpoints: [`cdp://127.0.0.1:${freePort}`],
        viewport: { width: DEFAULT_VIEWPORT.width, height: DEFAULT_VIEWPORT.height },
      });
    }
  }

  const target = await getProfile(selectedName);
  if (!target) {
    console.error(`Profile "${selectedName}" not found.`);
    const all = await listProfiles();
    if (all.length > 0) console.error(`Available profiles: ${all.map((profile) => profile.name).join(', ')}`);
    return false;
  }
  await persistDiscoveredProfile(selectedName);
  setConfigValue('browser.profile', selectedName);
  const endpoint = Object.values(getEndpointPresets(target))[0]?.target ?? '';
  console.log(`Default browser profile (this machine) is now "${selectedName}" (${target.browser}${endpoint ? `, ${endpoint}` : ''}).`);
  console.log('Bare `agents browser start` and `--profile default` will use it.');
  return true;
}

function configureBrowserUseCommand(command: Command, deprecated = false): void {
  command
    .description('Pick the profile `agents browser start` uses when no --profile is passed. No name opens a picker on a TTY or prints the current default headlessly.')
    .option('--unset', 'Clear the configured default (leaves this machine with no default until you pick one)')
    .action(async (name: string | undefined, opts: BrowserUseOptions) => {
      if (deprecated) {
        console.warn(chalk.yellow('Deprecation: `agents browser profiles set-default` is replaced by `agents browser use`.'));
      }
      if (!await runBrowserUse(name, opts)) process.exitCode = 1;
    });
}

function registerBrowserUseCommand(browser: Command): void {
  configureBrowserUseCommand(browser.command('use [name]'));
}

/**
 * Whether a profile's secrets bundle holds login creds for `service`
 * (`<PREFIX>_USERNAME` + `<PREFIX>_PASSWORD`). Reads bundle METADATA only (key
 * names, never values) so it doesn't decrypt. Returns the bundle name when both
 * keys exist, '-' when not, or '(unknown)' if the metadata read would prompt or
 * fails — the view must never block on Touch ID.
 */
async function credAvailability(bundleName: string | undefined, service: string): Promise<string> {
  if (!bundleName) return '-';
  const keys = credKeysForService(service);
  if (!keys) return '-';
  try {
    if (!(await bundleExists(bundleName))) return '-';
    const present = new Set(Object.keys((await readBundle(bundleName)).vars));
    return present.has(keys.user) && present.has(keys.pass) ? bundleName : '-';
  } catch {
    return '(unknown)';
  }
}

function registerProfilesCommands(browser: Command): void {
  const profiles = browser
    .command('profiles')
    .description('Manage browser profiles');

  profiles
    .command('list')
    .alias('ls')
    .description('List all browser profiles and the devices declaring each one (WHERE)')
    .option('--json', 'Output machine-readable JSON (includes devices + kind)')
    .action(async (opts: { json?: boolean }) => {
      const allProfiles = await listProfiles();
      const configuredDefault = getConfiguredDefaultProfileName();

      if (opts.json) {
        console.log(JSON.stringify(
          allProfiles.map((profile) => ({
            ...profile,
            devices: profile.devices,
            kind: profile.arc || profile.firefox ? 'identity' : profileKind(profile.name),
            isConfiguredDefault: profile.name === configuredDefault,
          })),
          null,
          2,
        ));
        return;
      }

      if (allProfiles.length === 0) {
        console.log('No browser profiles configured.');
        console.log('Create one with: agents browser profiles create <name> --browser chrome');
        return;
      }

      // Rendering lives in lib/browser/profiles.ts so the column widths and the
      // default-marking rules are unit-tested rather than eyeballed (RUSH-2710).
      for (const line of formatProfilesTable(allProfiles, configuredDefault)) console.log(line);
    });

  profiles
    .command('seed')
    .description('Create a machine-local profile for each installed browser (named <browser>-local), so you can pick or use one instead of hand-crafting each. Idempotent — existing profiles are left untouched.')
    .action(async () => {
      const installed = listInstalledBrowsers();
      if (installed.length === 0) {
        console.error('No supported browser found to seed a profile for.');
        process.exit(1);
      }
      for (const { browserType, binary } of installed) {
        const name = `${browserType}-local`;
        if (await getProfile(name)) {
          console.log(`= ${name} (already exists)`);
          continue;
        }
        const freePort = await findFreeProfilePort();
        await createProfile({
          name,
          description: `Seeded ${browserType} profile`,
          browser: browserType,
          binary,
          endpoints: [`cdp://127.0.0.1:${freePort}`],
          viewport: { width: DEFAULT_VIEWPORT.width, height: DEFAULT_VIEWPORT.height },
        });
        console.log(`+ ${name} (${browserType})`);
      }
      console.log('Pick your default with: agents browser use <name>');
    });

  profiles
    .command('claim [name]')
    .description(
      'Move leftover central browser: profiles into this device\'s declaration file. Only profiles this machine can host are claimed; the rest stay central. Run on the machine that actually has the browser.',
    )
    .option('--json', 'Output machine-readable JSON')
    .action(async (name: string | undefined, opts: { json?: boolean }) => {
      const canHostHere = (config: BrowserProfileConfig): boolean =>
        isProfileLaunchableHere({
          name: '_',
          browser: config.browser,
          binary: config.binary,
          endpoints: config.endpoints,
        });

      let result;
      try {
        result = migrateCentralBrowserProfiles(canHostHere, name);
      } catch (err) {
        console.error(err instanceof Error ? err.message : String(err));
        process.exit(1);
      }

      if (opts.json) {
        console.log(JSON.stringify({ ...result, device: machineId() }, null, 2));
        return;
      }

      if (result.claimed.length === 0 && result.skipped.length === 0) {
        console.log('No leftover central browser profiles to claim.');
        return;
      }
      for (const claimed of result.claimed) {
        console.log(`Claimed ${claimed} on ${machineId()}`);
      }
      for (const skipped of result.skipped) {
        console.log(
          `Skipped ${skipped}: this machine cannot host it (browser/binary isn't installed here). ` +
            `Run \`agents browser profiles claim ${skipped}\` on the machine that has that browser.`,
        );
      }
      if (result.claimed.length === 0) {
        console.log('No leftover central profiles this machine can host.');
      }
    });

  configureBrowserUseCommand(profiles.command('use [name]'));
  configureBrowserUseCommand(profiles.command('set-default [name]', { hidden: true }), true);

  profiles
    .command('logins')
    .description('Show which login-gated services each profile has a live session for, the account signed in, and whether login creds are available in the profile\'s secrets bundle (reads cookie/username presence only, never decrypts).')
    .action(async () => {
      const allProfiles = await listProfiles();
      if (allProfiles.length === 0) {
        console.log('No browser profiles configured.');
        return;
      }
      console.log('PROFILE'.padEnd(20) + 'SERVICE'.padEnd(12) + 'ACCOUNT'.padEnd(32) + 'CREDS');
      console.log('-'.repeat(80));
      for (const p of allProfiles) {
        const rows = await loginsWithAccountsForProfile(p.name);
        if (rows.length === 0) {
          console.log(p.name.padEnd(20) + '(none detected)');
          continue;
        }
        let first = true;
        for (const r of rows) {
          const name = first ? p.name : '';
          console.log(
            name.padEnd(20) +
              r.service.padEnd(12) +
              (r.username ?? '(unknown)').padEnd(32) +
              (await credAvailability(p.secrets, r.service)),
          );
          first = false;
        }
      }
    });

  const VALID_BROWSERS = ['chrome', 'comet', 'chromium', 'brave', 'edge', 'arc', 'custom'];

  profiles
    .command('create <name>')
    .alias('add')
    .description('Create a new browser profile on this device')
    .requiredOption('-b, --browser <type>', `Browser type: ${VALID_BROWSERS.join(', ')}`)
    .option('-e, --endpoint <url>', 'CDP endpoint URL (repeatable; auto-assigned if omitted)', collect, [])
    .option('-s, --secrets <bundle>', 'Secrets bundle to inject')
    .option('-d, --description <text>', 'Profile description')
    .option('--headless', 'Run in headless mode')
    .option('--window <WxH>', `Window size in CSS pixels (default: ${DEFAULT_VIEWPORT.width}x${DEFAULT_VIEWPORT.height}, MacBook Pro 14")`)
    .option('--position <X,Y>', 'Window position on screen, e.g. 80,80')
    .option('--binary <path>', 'Absolute path to the browser/app binary (required with --browser custom)')
    .option(
      '--electron',
      'Treat this profile as an Electron desktop app: never call Target.createTarget; bind to the visible window using --target-filter or the skip-invisible heuristic'
    )
    .option(
      '--target-filter <expr>',
      'Pick the existing CDP page target to drive (Electron apps, and Arc — which reuses an open tab / Space rather than creating one). Format: url:<substring> or title:<substring>'
    )
    .option(
      '--attach-only',
      'Never spawn a rival window: attach to a browser you already started with remote debugging, else fail loud with a relaunch hint (PHNX-3967). The model for a canonical signed-in Comet; Arc is always attach-only. Pairs with a durable --user-data-dir.'
    )
    .option(
      '--user-data-dir <path>',
      "Absolute durable --user-data-dir for this profile's browser. Default for attach-only: ~/.agents/.history/browser-profiles/<name>/chrome-data (outside .cache, so a one-time sign-in survives relaunch)."
    )
    .action(async (name: string, opts) => {
      try {
        assertRegistrableProfileName(name);
      } catch (err) {
        console.error(err instanceof Error ? err.message : String(err));
        process.exit(1);
      }

      if (!VALID_BROWSERS.includes(opts.browser)) {
        console.error(`Invalid browser type. Must be one of: ${VALID_BROWSERS.join(', ')}`);
        process.exit(1);
      }

      if (opts.browser === 'custom' && !opts.binary) {
        console.error('--browser custom requires --binary <path>');
        process.exit(1);
      }

      if (opts.targetFilter) {
        // Route through the same parser the runtime uses so the CLI gate matches
        // the runtime contract — `url:` (empty value) and `url: foo` (leading
        // whitespace) both pass a naive `kind` check but produce a silent
        // heuristic fallback at runtime.
        const parsed = parseTargetFilter(String(opts.targetFilter));
        if (!parsed) {
          console.error('--target-filter must be url:<substring> or title:<substring> (non-empty value, no leading whitespace)');
          process.exit(1);
        }
        // The filter picks WHICH existing page target to drive without ever
        // calling Target.createTarget — the two profiles that do that are
        // Electron apps and Arc (which crashes on tab creation, so it drives an
        // existing tab / Space, PHNX-2399). Any other browser opens its own tab
        // and never consults the filter, so requiring it there would be a lie.
        if (!opts.electron && opts.browser !== 'arc') {
          console.error('--target-filter requires --electron or --browser arc (the filter is only consulted on profiles that reuse an existing tab)');
          process.exit(1);
        }
      }

      // Auto-assign a free port if no endpoint was provided
      let endpoints: string[] = opts.endpoint;
      if (endpoints.length === 0) {
        const freePort = await findFreeProfilePort();
        endpoints = [`cdp://127.0.0.1:${freePort}`];
      }

      // Viewport is mandatory — default to MacBook Pro 14" (1512x982) if
      // --window is not provided. See lib/browser/devices.ts DEFAULT_VIEWPORT.
      let viewport: { width: number; height: number; x?: number; y?: number } = {
        width: DEFAULT_VIEWPORT.width,
        height: DEFAULT_VIEWPORT.height,
      };
      if (opts.window) {
        const size = parseWindowSize(String(opts.window));
        if (!size) {
          console.error(`--window must be WxH, e.g. ${DEFAULT_VIEWPORT.width}x${DEFAULT_VIEWPORT.height}`);
          process.exit(1);
        }
        viewport.width = size.width;
        viewport.height = size.height;
      }
      if (opts.position) {
        const pos = parseWindowPosition(String(opts.position));
        if (!pos) {
          console.error('--position must be X,Y, e.g. 80,80');
          process.exit(1);
        }
        viewport.x = pos.x;
        viewport.y = pos.y;
      }

      if (opts.userDataDir && !path.isAbsolute(String(opts.userDataDir))) {
        console.error('--user-data-dir must be an absolute path');
        process.exit(1);
      }

      const profile: BrowserProfile = {
        name,
        description: opts.description,
        browser: opts.browser,
        binary: opts.binary,
        electron: opts.electron || undefined,
        targetFilter: opts.targetFilter,
        endpoints,
        launchPolicy: opts.attachOnly ? 'attach-only' : undefined,
        userDataDir: opts.userDataDir ? String(opts.userDataDir) : undefined,
        secrets: opts.secrets,
        chrome: opts.headless ? { headless: true } : undefined,
        viewport,
      };

      await createProfile(profile);
      const port = extractConfiguredPort(profile);
      console.log(
        port !== undefined
          ? `Added "${name}" on ${machineId()} (port ${port}).`
          : `Added "${name}" on ${machineId()}.`,
      );
      // Attach-only profiles never launch a browser — tell the user the one-time
      // relaunch that makes their canonical instance attachable, pinned to the
      // durable data dir so the sign-in persists (PHNX-3967).
      if (isAttachOnlyProfile(profile) && profile.browser !== 'arc' && port !== undefined) {
        const app = profile.browser === 'comet' ? 'Comet' : profile.browser;
        console.log(
          `attach-only: agents will not spawn ${app}. Start the canonical one once with:\n` +
            `  open -a ${app} --args --remote-debugging-port=${port} --user-data-dir=${resolveProfileDataDir(profile)}\n` +
            `Sign in in that window; the data dir is durable so the login survives quit+relaunch.`,
        );
      }
      // Warn (don't fail) if the declared secrets bundle doesn't exist yet — it
      // may be created later, but a typo should surface now.
      if (opts.secrets && !(await bundleExists(opts.secrets))) {
        console.error(
          `warning: secrets bundle "${opts.secrets}" does not exist yet. Create it with: agents secrets create ${opts.secrets}`,
        );
      }
    });

  profiles
    .command('edit <name>')
    .description('Edit an existing profile in place (stays in the store it already lives in)')
    // Declared only so the action can explain WHY the browser type is not
    // editable. Without it commander rejects `-b` as an unknown option before
    // the action runs, and the delete-and-recreate guidance never reaches anyone.
    .option('-b, --browser <type>', 'Not editable — see the error for the delete-and-recreate path')
    .option('-d, --description <text>', "Profile description (pass '' to clear)")
    .option('-e, --endpoint <url>', 'Replace the endpoint list (repeatable)', collect, [])
    .option('-s, --secrets <bundle>', 'Secrets bundle to inject')
    .option('--headless', 'Run in headless mode')
    .option('--no-headless', 'Run headed')
    .option('--window <WxH>', 'Window size in CSS pixels')
    .option('--position <X,Y>', 'Window position on screen, e.g. 80,80')
    .option('--binary <path>', 'Absolute path to the browser/app binary')
    .option('--electron', 'Treat this profile as an Electron desktop app')
    .option('--no-electron', 'Stop treating it as an Electron app')
    .option('--target-filter <expr>', "url:<substring> or title:<substring>; consulted on Electron and Arc profiles (pass '' to clear)")
    .option('--attach-only', 'Make this profile attach-only (never spawn a rival window) — PHNX-3967')
    .option('--launch', 'Undo attach-only: let agents launch the browser when nothing is serving CDP on the port')
    .option('--user-data-dir <path>', "Absolute durable --user-data-dir (pass '' to clear back to the default durable dir)")
    .option('--json', 'Output machine-readable JSON')
    .action(async (name: string, opts) => {
      // The browser type and the name are identity, not settings: both key the
      // on-disk runtime dir and any live `<name>@<endpoint>` connection, so
      // changing either orphans the cached browser data (and its logins).
      if (opts.browser) {
        console.error(
          'browser type is not editable — it keys the on-disk profile cache. ' +
            `Remove and recreate instead: agents browser profiles remove ${name} && agents browser profiles create ${name} -b <type>`
        );
        process.exit(1);
      }

      if (opts.targetFilter) {
        const parsed = parseTargetFilter(String(opts.targetFilter));
        if (!parsed) {
          console.error('--target-filter must be url:<substring> or title:<substring> (non-empty value, no leading whitespace)');
          process.exit(1);
        }
      }

      if (opts.attachOnly && opts.launch) {
        console.error('Pass either --attach-only or --launch, not both.');
        process.exit(1);
      }
      if (opts.userDataDir && !path.isAbsolute(String(opts.userDataDir))) {
        console.error('--user-data-dir must be an absolute path');
        process.exit(1);
      }

      const patch: EditableProfileFields = {};
      if (opts.description !== undefined) patch.description = opts.description || undefined;
      if (opts.endpoint && opts.endpoint.length > 0) patch.endpoints = opts.endpoint;
      if (opts.secrets !== undefined) patch.secrets = opts.secrets;
      if (opts.binary !== undefined) patch.binary = opts.binary;
      if (opts.targetFilter !== undefined) patch.targetFilter = opts.targetFilter || undefined;
      // launchPolicy toggle: --attach-only sets it, --launch clears it (back to
      // the default launch behavior). commander leaves each undefined when unset.
      if (opts.attachOnly) patch.launchPolicy = 'attach-only';
      else if (opts.launch) patch.launchPolicy = undefined;
      // '' clears back to the default durable dir; any other value pins it.
      if (opts.userDataDir !== undefined) patch.userDataDir = opts.userDataDir || undefined;
      // commander maps --electron/--no-electron and --headless/--no-headless onto
      // one boolean each, and leaves it undefined when neither was passed.
      if (opts.electron !== undefined) patch.electron = opts.electron || undefined;

      if (opts.headless !== undefined || opts.window || opts.position) {
        const current = await getProfile(name);
        if (!current) {
          console.error(`Profile "${name}" does not exist`);
          process.exit(1);
        }
        if (opts.headless !== undefined) {
          const chrome = { ...current.chrome };
          if (opts.headless) chrome.headless = true;
          else delete chrome.headless;
          // `{ headless: undefined }` is truthy, so profileToConfig would persist
          // a bare `chrome: {}` into the YAML and the change-detector would report
          // a phantom edit on an already-headed profile. Drop the key entirely.
          patch.chrome = Object.keys(chrome).length > 0 ? chrome : undefined;
        }
        if (opts.window || opts.position) {
          const viewport = { ...(current.viewport ?? { width: DEFAULT_VIEWPORT.width, height: DEFAULT_VIEWPORT.height }) };
          if (opts.window) {
            const size = parseWindowSize(String(opts.window));
            if (!size) {
              console.error('--window must be WxH, e.g. 1512x982');
              process.exit(1);
            }
            viewport.width = size.width;
            viewport.height = size.height;
          }
          if (opts.position) {
            const pos = parseWindowPosition(String(opts.position));
            if (!pos) {
              console.error('--position must be X,Y, e.g. 80,80');
              process.exit(1);
            }
            viewport.x = pos.x;
            viewport.y = pos.y;
          }
          patch.viewport = viewport;
        }
      }

      if (Object.keys(patch).length === 0) {
        console.error('Nothing to edit. Pass at least one field, e.g. -d "<description>".');
        process.exit(1);
      }

      let result;
      try {
        result = await editProfile(name, patch);
      } catch (err) {
        console.error(err instanceof Error ? err.message : String(err));
        process.exit(1);
      }

      if (opts.json) {
        console.log(JSON.stringify({ ...result.profile, devices: result.devices, changed: result.changed }, null, 2));
      } else if (result.changed.length === 0) {
        console.log(`No change: ${name} already had those values.`);
      } else {
        console.log(`Updated ${name} on ${machineId()}: ${result.changed.join(', ')}`);
      }
      if (patch.secrets && !(await bundleExists(patch.secrets))) {
        console.error(
          `warning: secrets bundle "${patch.secrets}" does not exist yet. Create it with: agents secrets create ${patch.secrets}`,
        );
      }
    });

  profiles
    .command('rename <from> <to>')
    .description("Rename a profile, moving its browser data with it (logins survive)")
    .option('--json', 'Output machine-readable JSON')
    .action(async (from: string, to: string, opts: { json?: boolean }) => {
      let res;
      try {
        res = await renameProfile(from, to);
      } catch (err) {
        console.error(err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
      if (opts.json) {
        console.log(JSON.stringify({ from, to, ...res }, null, 2));
        return;
      }
      console.log(`Renamed ${from} -> ${to} on ${machineId()}`);
      if (res.movedDirs.length > 0) {
        console.log(`  moved ${res.movedDirs.length} browser data dir${res.movedDirs.length === 1 ? '' : 's'} — logins preserved`);
      }
      if (res.repointedDefault) {
        console.log(`  browser.profile now points at ${to}`);
      }
      if (res.repointedViewer) {
        console.log(`  browser.viewer now points at ${to}`);
      }
      if (res.stalePins.length > 0) {
        const devices = [...new Set(res.stalePins.map((p) => p.device))];
        const one = devices.length === 1;
        console.error(
          `warning: ${devices.join(', ')} still ${one ? 'pins' : 'pin'} "${from}" in ` +
            `${one ? 'its' : 'their'} own device config. Fix with:`,
        );
        for (const pin of res.stalePins) {
          console.error(`  agents config set ${pin.key} ${to} --device ${pin.device}`);
        }
      }
    });

  profiles
    .command('show <name>')
    .description('Show profile details')
    .option('--json', 'Output machine-readable JSON')
    .action(async (name: string, opts) => {
      const profile = await getProfile(name);
      if (!profile) {
        if (opts.json) {
          console.log(JSON.stringify({ ok: false, error: `Profile "${name}" not found` }));
        } else {
          console.error(`Profile "${name}" not found`);
        }
        process.exit(1);
      }

      if (opts.json) {
        console.log(JSON.stringify(profile, null, 2));
        return;
      }

      console.log(`Name: ${profile.name}`);
      console.log(`Browser: ${profile.browser}`);
      if (getConfiguredDefaultProfileName() === profile.name) {
        console.log('Default: yes (this machine — used by `agents browser start`)');
      }
      if (profile.binary) console.log(`Binary: ${profile.binary}`);
      if (profile.electron) console.log(`Electron: true`);
      if (isAttachOnlyProfile(profile)) {
        const why = profile.browser === 'arc' ? ' (Arc is always attach-only)' : '';
        console.log(`Launch policy: attach-only${why} — agents attach, never spawn a rival window`);
        if (profile.browser !== 'arc') {
          console.log(`User-data-dir: ${resolveProfileDataDir(profile)} (durable)`);
        }
      }
      if (profile.targetFilter) console.log(`Target filter: ${profile.targetFilter}`);
      if (profile.description) console.log(`Description: ${profile.description}`);
      if (profile.arc) {
        console.log(`Arc Space: ${profile.arc.spaceTitle} (${profile.arc.spaceId})`);
        console.log(`Arc profile: ${profile.arc.profileName} (${profile.arc.profileId})`);
      }
      if (profile.firefox) {
        console.log(`Firefox profile: ${profile.firefox.profileName}${profile.firefox.isDefault ? ' (default)' : ''}`);
        if (profile.userDataDir) console.log(`Profile directory: ${profile.userDataDir}`);
      }
      const presets = getEndpointPresets(profile);
      const defaultName = profile.defaultEndpoint && presets[profile.defaultEndpoint]
        ? profile.defaultEndpoint
        : Object.keys(presets)[0];
      console.log('Endpoints:');
      for (const [presetName, preset] of Object.entries(presets)) {
        const marker = presetName === defaultName ? ' (default)' : '';
        const isLegacy = presetName.startsWith('endpoint-');
        console.log(`  - ${isLegacy ? preset.target : `${presetName}: ${preset.target}`}${marker}`);
        if (preset.binary) console.log(`      binary: ${preset.binary}`);
        if (preset.targetFilter) console.log(`      targetFilter: ${preset.targetFilter}`);
      }
      if (profile.viewport) {
        const v = profile.viewport;
        const pos = v.x !== undefined && v.y !== undefined ? ` @ ${v.x},${v.y}` : '';
        console.log(`Viewport: ${v.width}×${v.height}${pos}`);
      }
      if (profile.secrets) console.log(`Secrets: ${profile.secrets}`);
      if (profile.chrome?.headless) console.log(`Headless: true`);

      // Login state per known service: live session + account identity + whether
      // login creds are declared in the profile's secrets bundle.
      if (profile.arc || profile.firefox) return;
      const active = await loginsForProfile(profile.name);
      const accounts = await accountsForProfile(profile.name);
      const lines: string[] = [];
      for (const service of Object.keys(AUTH_SIGNATURES)) {
        const isActive = active.includes(service);
        const creds = await credAvailability(profile.secrets, service);
        if (!isActive && creds === '-') continue; // nothing interesting to show
        const status = isActive
          ? `logged in${accounts[service] ? ` as ${accounts[service]}` : ''}`
          : 'logged out';
        const credNote = creds !== '-' ? `  creds: ${creds}` : '';
        lines.push(`  ${service.padEnd(10)} ${status}${credNote}`);
      }
      if (lines.length > 0) {
        console.log('Logins:');
        for (const l of lines) console.log(l);
      }
    });

  profiles
    .command('remove <name>')
    .alias('delete')
    .description('Remove the agents-cli profile alias and cached runtime dirs (never deletes native Arc data)')
    .option('--keep-cache', "Leave ~/.agents/.cache/browser/<name>* dirs in place (don't wipe chrome-data)")
    .action(async (name: string, opts: { keepCache?: boolean }) => {
      await deleteProfile(name);
      // The composite naming change introduced multiple cache dirs per
      // profile (`<name>`, `<name>@endpoint-0`, …). Sweep them all unless
      // the user explicitly wants the chrome-data preserved (e.g. for
      // re-import into a freshly-created profile of the same name).
      let removed = 0;
      if (!opts.keepCache) {
        const cacheDirs = listProfileCacheDirs(name);
        removed = cacheDirs.length;
        for (const dir of cacheDirs) {
          // `removeProfileCache` operates by profile-name; for the
          // composite dirs we already have the absolute path. Use rmSync
          // directly so we don't depend on naming round-trips.
          try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
        }
        // The canonical wipe also covers the legacy dir if present.
        removeProfileCache(name);
      }
      console.log(
        `Deleted profile: ${name}` +
          (removed > 0 ? ` (and ${removed} cache dir${removed === 1 ? '' : 's'})` : '')
      );
      if (getConfiguredDefaultProfileName() === name) {
        console.error(
          `warning: "${name}" was this machine's default browser profile; ` +
          `\`agents browser start\` has no default here until you run: agents browser use <name>`
        );
      }
    });

  profiles
    .command('prune')
    .description('Remove dead profiles this device declares: browser not installed here, or never started')
    .option('-n, --dry-run', 'Print what would be removed and exit without changing anything')
    .option('--json', 'Output machine-readable JSON')
    .action(async (opts: { dryRun?: boolean; json?: boolean }) => {
      const plan = await buildProfilePrunePlan();

      if (!opts.dryRun) await pruneProfiles(plan);

      if (opts.json) {
        console.log(JSON.stringify({ dryRun: !!opts.dryRun, ...plan }, null, 2));
        return;
      }

      // A misfiled profile is never a prune candidate — the entry belongs to the
      // device that declared it, not to this one — so without this it would only
      // ever surface in --json. It is the one kept-reason a user has to act on.
      const misfiled = plan.kept.filter((k) => k.misfiled);
      const reportMisfiled = (): void => {
        if (misfiled.length === 0) return;
        console.log('');
        console.log(
          `${misfiled.length} profile${misfiled.length === 1 ? '' : 's'} ${misfiled.length === 1 ? 'is' : 'are'} misfiled — ` +
            `declared on another device but bound to a loopback port, so the name resolves to ` +
            `this machine's own browser rather than the declaring device's:`
        );
        for (const k of misfiled) {
          console.log(`  ${k.name} — ${k.why}`);
        }
        console.log(
          'Re-declare each on the machine that owns the browser. Nothing was moved for you.'
        );
        console.log('(Prune never deletes these — the declaring device owns the entry.)');
      };

      if (plan.candidates.length === 0) {
        console.log('Nothing to prune — every profile is in use, healthy, or protected.');
        if (plan.kept.length > 0) {
          for (const k of plan.kept) console.log(`  kept ${k.name} (${k.scope}) — ${k.why}`);
        }
        reportMisfiled();
        return;
      }

      const verb = opts.dryRun ? 'Would remove' : 'Removed';
      console.log(`${verb} ${plan.candidates.length} profile${plan.candidates.length === 1 ? '' : 's'}:`);
      for (const c of plan.candidates) {
        const cache = c.cacheDirs.length > 0
          ? ` + ${c.cacheDirs.length} cache dir${c.cacheDirs.length === 1 ? '' : 's'}`
          : '';
        console.log(`  ${c.name} (${c.scope}) — ${PRUNE_REASON_TEXT[c.reason]}${cache}`);
      }
      reportMisfiled();
      if (opts.dryRun) {
        console.log('');
        console.log('Nothing was changed. Re-run without --dry-run to apply.');
      }
    });

  setHelpSections(profiles, {
    examples: `
      # WHERE is the devices whose own file declares the name
      agents browser profiles list

      # Create one on this device
      agents browser profiles add work --browser chrome
      agents browser profiles create work --browser chrome

      # Claim leftover central profiles on the machine that hosts the browser
      agents browser profiles claim
      agents browser profiles claim comet-local

      # Clean up dead ones this device declares: check first, then apply
      agents browser profiles prune --dry-run
      agents browser profiles prune

      # Make one the machine's default for a bare \`agents browser start\`
      agents browser use work
    `,
    notes: `
      A device declares its own browsers in its own \`devices/<machine>/agents.yaml\`.
      A name declared by exactly one device is identity-bearing; a name declared
      by several is fungible. Leftover central \`browser:\` entries are claimed
      with \`agents browser profiles claim\` on the machine that hosts the browser.

      In \`list\`, the \`*\` marker means "this machine's configured default"
      (\`agents browser start\` with no --profile). A profile a setup wizard pins
      is named \`auto-chrome\`; \`default\` is only an ALIAS for whichever profile
      this machine is configured to use, resolved the same way by every command.

      \`prune\` only considers profiles this device declares. It never removes a
      profile that is in use, the configured default, or the \`auto-chrome\`
      profile a setup wizard created.

      On a Mac with Arc, every Arc Space is listed as a profile (arc-gmail,
      arc-work, ...) discovered read-only from Arc's own metadata — a Space
      already carries its Arc profile's logins, so it IS the browser profile.
      Agents attach to the running Arc through Apple Events and never launch or
      relaunch it. Comet's own profiles are listed the same way (comet-work, ...),
      pinned to Comet's real user-data dir, so agents and you share one Comet
      window per profile: agents attach when it is running with remote debugging,
      launch it on your store when it is not running, and fail loud with the
      relaunch command when it runs without a port. The daemon publishes every
      discovered profile into this device's declaration, so other fleet boxes list
      it with WHERE=<this device> and route to it. Point agents at Comet when a workflow needs screenshots,
      downloads, network capture, or trusted input:
        agents browser profiles create agents-comet --browser comet --attach-only
      A CDP \`--attach-only\` profile attaches to a browser you
      already started with remote debugging and fails loud with the relaunch
      command otherwise, pinned to a durable --user-data-dir so the sign-in
      survives quit+relaunch. A foreign browser squatting the canonical port is
      rejected, not driven — \`agents browser profiles doctor <name>\` flags it.
    `,
  });

  profiles
    .command('doctor <name>')
    .description('Diagnose a browser profile: where it is declared, binary, port, user-data-dir, onboarding state')
    .action(async (name: string) => {
      const profile = await getProfile(name);
      if (!profile) {
        console.error(`Profile "${name}" not found`);
        process.exit(1);
      }

      if ((profile.arc || profile.firefox) && !isFleetRemoteInvocation()) {
        const routed = resolveBrowserTarget(profile.name);
        if (!routed.local && routed.commandDispatch) {
          const result = await dispatchBrowserToDevice(
            routed.device,
            ['browser', 'profiles', 'doctor', name],
            'capture',
          );
          process.stdout.write(result.stdout);
          process.stderr.write(result.stderr);
          if (result.code !== 0) process.exit(result.code);
          return;
        }
      }

      const checks: Array<{ label: string; ok: boolean; detail: string }> = [];

      // 0. Declaration topology. An identity-bearing profile declared by a
      //    different device cannot be diagnosed through a loopback CDP endpoint
      //    on this one — that is the original comet-local bug. Checked first
      //    because it invalidates every local check.
      const misfiled = identityLoopbackMismatch(profile);
      const kind = profileKind(profile.name);
      const where = profile.devices.length > 0 ? profile.devices.join(', ') : 'no device';
      checks.push(
        misfiled.misfiled
          ? { label: 'where', ok: false, detail: misfiled.why }
          : {
              label: 'where',
              ok: true,
              detail: kind
                ? `${kind}, declared on ${where}`
                : `declared on ${where}`,
            }
      );

      if (misfiled.misfiled) {
        for (const c of checks) {
          const marker = c.ok ? 'OK  ' : 'FAIL';
          console.log(`${marker}  ${c.label.padEnd(15)} ${c.detail}`);
        }
        process.exit(1);
      }

      if (profile.arc) {
        checks.push({
          label: 'space',
          ok: true,
          detail: `${profile.arc.spaceTitle} (${profile.arc.spaceId})`,
        });
        checks.push({
          label: 'arc-profile',
          ok: true,
          detail: `${profile.arc.profileName} (${profile.arc.profileId})`,
        });
        const running = await isArcRunning();
        checks.push({
          label: 'Arc process',
          ok: running,
          detail: running ? 'running; native automation attaches without launching or restarting Arc' : 'not running — start Arc normally',
        });
        const allOk = checks.every((check) => check.ok);
        for (const check of checks) {
          console.log(`${check.ok ? 'OK  ' : 'FAIL'}  ${check.label.padEnd(15)} ${check.detail}`);
        }
        if (!allOk) process.exit(1);
        return;
      }

      // 1. Binary exists for declared browser type, and is a real executable we
      //    can drive — not a distro launcher script. findBrowserPath already
      //    unwraps the known Chromium wrappers to their ELF; if it still hands
      //    back a shebang script we couldn't resolve, `start` would fail with
      //    `CDP connection closed` (the wrapper re-execs the browser as a child,
      //    breaking the --remote-debugging-pipe transport — issue #229). Flag it
      //    here instead of letting launch fail opaquely.
      try {
        const binPath = findBrowserPath(profile.browser, profile.binary);
        if (isLauncherScript(binPath)) {
          checks.push({
            label: 'binary',
            ok: false,
            detail:
              `${binPath} is a launcher script, not the browser executable — ` +
              `agents browser drives the browser over --remote-debugging-pipe and ` +
              `can't attach to a wrapper that re-execs it. Point the profile at the ` +
              `real binary (\`--binary /path/to/browser\`) or reinstall the standard package.`,
          });
        } else {
          checks.push({ label: 'binary', ok: true, detail: binPath });
        }
      } catch (err) {
        checks.push({
          label: 'binary',
          ok: false,
          detail: err instanceof Error ? err.message : String(err),
        });
      }

      // 2. Configured port. For local cdp:// we check the local port. For
      //    ssh:// the port lives on a remote host — doctor's previous
      //    behavior was to lsof the LOCAL port number, which was both
      //    misleading and arbitrary (after the SSH-binds-locally change
      //    the local port now matches the remote, so a positive answer
      //    is plausible; but doctor still shouldn't report on remote
      //    state without an --remote-probe explicitly).
      const port = extractConfiguredPort(profile);
      let attachingToExistingBrowser = false;
      const firstEndpointTarget = (() => {
        const presets = getEndpointPresets(profile);
        const first = Object.keys(presets)[0];
        return first ? presets[first].target : undefined;
      })();
      const isSshEndpoint = firstEndpointTarget?.startsWith('ssh://') ?? false;
      if (port === undefined) {
        checks.push({ label: 'port', ok: true, detail: 'no port in endpoint' });
      } else if (isSshEndpoint) {
        checks.push({
          label: 'port',
          ok: true,
          detail: `${port} (remote on ${firstEndpointTarget}) — skipping local check`,
        });
      } else {
        const occupant = getPortOccupant(port);
        if (!occupant) {
          // A free port doesn't mean "ready to launch here": for a local
          // profile we self-launch over an internal --remote-debugging-pipe and
          // never bind this port. The port is consulted only to attach to a
          // browser someone already started on it. Say so, so a green doctor
          // can't be read as "the port is what launch depends on" (#229).
          checks.push({
            label: 'port',
            ok: true,
            detail: `${port} free — will self-launch over an internal pipe (port used only to attach to an already-running browser)`,
          });
        } else {
          try {
            const { browser } = await discoverBrowserWsUrl(port, 'localhost', profile.name);
            verifyBrowserIdentity(browser, profile.browser, port);
            // Port-squat check (PHNX-3967): for an attach-only profile, a browser
            // of the right FAMILY on the canonical port is not enough — confirm
            // its --user-data-dir is this profile's durable dir. A logged-out
            // /tmp Comet answering CDP here would otherwise pass as ready and get
            // driven as if it were the credentialed browser.
            const expectedDir = resolveProfileDataDir(profile);
            const ownershipChecked = isAttachOnlyProfile(profile) && profile.browser !== 'arc';
            const runningDir = ownershipChecked ? getProcessUserDataDir(occupant.pid) : null;
            if (runningDir && normalizeDataDir(runningDir) !== normalizeDataDir(expectedDir)) {
              checks.push({
                label: 'port',
                ok: false,
                detail:
                  `${port} serving ${browser} (pid ${occupant.pid}) but from a FOREIGN ` +
                  `user-data-dir ${runningDir} (expected ${expectedDir}). This is a ` +
                  `port-squatter, not this profile's browser — agents will refuse to drive ` +
                  `it. Close it (\`kill ${occupant.pid}\`) and relaunch the canonical browser ` +
                  `with --user-data-dir=${expectedDir}.`,
              });
            } else if (ownershipChecked && !runningDir) {
              // Attach-only, an occupant is serving CDP, but its --user-data-dir
              // couldn't be read — ownership is UNVERIFIED. Surface it rather than
              // report a silent green, matching the runtime guard which refuses to
              // attach to an unverifiable instance (PHNX-3967).
              checks.push({
                label: 'port',
                ok: false,
                detail:
                  `${port} serving ${browser} (pid ${occupant.pid}) but its --user-data-dir ` +
                  `could not be read, so ownership can't be confirmed. agents will refuse to ` +
                  `attach to an unverified instance. Relaunch the canonical browser with ` +
                  `--user-data-dir=${expectedDir} so the attach-only guard can verify it.`,
              });
            } else {
              checks.push({
                label: 'port',
                ok: true,
                detail: `${port} serving ${browser} (pid ${occupant.pid})`,
              });
              attachingToExistingBrowser = true;
            }
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            checks.push({
              label: 'port',
              ok: false,
              detail: `${port} taken by ${occupant.command} (pid ${occupant.pid}) — ${msg}`,
            });
          }
        }
      }

      // 3. User-data-dir exists and is writable. An attach-only profile's login
      //    lives in the DURABLE dir (outside .cache) the canonical browser is
      //    launched with; a launch-policy profile uses the managed cache dir.
      const userDataDir = isAttachOnlyProfile(profile) && profile.browser !== 'arc'
        ? resolveProfileDataDir(profile)
        : path.join(getProfileRuntimeDir(name), 'chrome-data');
      try {
        if (!fs.existsSync(userDataDir)) {
          checks.push({
            label: 'user-data-dir',
            ok: true,
            detail: `will be created at ${userDataDir}`,
          });
        } else {
          fs.accessSync(userDataDir, fs.constants.W_OK);
          checks.push({ label: 'user-data-dir', ok: true, detail: userDataDir });
        }
      } catch (err) {
        checks.push({
          label: 'user-data-dir',
          ok: false,
          detail: `${userDataDir} not writable: ${err instanceof Error ? err.message : err}`,
        });
      }

      // 4. Onboarding heuristic — only meaningful when WE will launch the
      // browser. When the configured port is already serving a debuggable
      // browser, that browser owns its own user-data-dir and the priming
      // status of our managed dir is irrelevant.
      if (attachingToExistingBrowser) {
        checks.push({
          label: 'onboarding',
          ok: true,
          detail: 'n/a (attaching to existing browser)',
        });
      } else {
        const localStatePath = path.join(userDataDir, 'Local State');
        if (fs.existsSync(localStatePath)) {
          const size = fs.statSync(localStatePath).size;
          if (size > 0) {
            checks.push({ label: 'onboarding', ok: true, detail: 'Local State present' });
          } else {
            checks.push({
              label: 'onboarding',
              ok: false,
              detail:
                'Local State is empty — run `agents browser start --profile ' +
                name +
                '` and finish any first-run screens before automating',
            });
          }
        } else {
          checks.push({
            label: 'onboarding',
            ok: false,
            detail:
              'Not initialized yet — run `agents browser start --profile ' +
              name +
              '` and finish any first-run screens before automating',
          });
        }
      }

      const allOk = checks.every((c) => c.ok);
      for (const c of checks) {
        const marker = c.ok ? 'OK  ' : 'FAIL';
        console.log(`${marker}  ${c.label.padEnd(15)} ${c.detail}`);
      }
      if (!allOk) process.exit(1);
    });

}

function registerTaskCommands(browser: Command): void {
  browser.hook('preAction', async (_thisCommand, actionCommand) => {
    inferredTaskName = undefined;
    if (isFleetRemoteInvocation()) return;

    const pathNames = commandPath(actionCommand);
    const top = pathNames[0];
    if (!top || !TASK_ROUTED_COMMANDS.has(top)) return;
    if (pathNames.length === 1 && top === 'start') return;

    const opts = actionCommand.opts() as { task?: string; device?: string; profile?: string };
    const deviceFlag = opts.device ?? flagValue(process.argv.slice(2), 'device', 'D');
    const taskFlag = opts.task ?? flagValue(process.argv.slice(2), 'task');

    // Reject --device on every later verb, including `stop --profile`.
    if (deviceFlag) {
      console.error(REJECT_DEVICE_MESSAGE);
      process.exit(1);
    }

    if (top === 'stop' && opts.profile && !taskFlag) return;

    // A native Arc endpoint cannot be represented by an SSH-forwarded socket.
    // For a cold profile-scoped page verb, create the task on the declaring
    // owner first and bind that owner locally; the ordinary task router below
    // then forwards this complete verb and every subsequent verb to that host.
    if (!taskFlag && opts.profile) {
      try {
        const profileName = (await resolveProfileRef(opts.profile)) ?? opts.profile;
        const target = resolveBrowserTarget(profileName);
        if (!target.local && target.commandDispatch) {
          const started = await dispatchBrowserToDevice(
            target.device,
            ['browser', 'start', '--profile', profileName, '--json'],
            'capture',
          );
          if (started.code !== 0) {
            process.stdout.write(started.stdout);
            process.stderr.write(started.stderr);
            process.exit(started.code);
          }
          const task = remoteStartTaskName(started.stdout);
          if (!task) throw new Error(`Remote start on ${target.device} produced no task name.`);
          bindTask(task, {
            device: target.device,
            profile: profileName,
            sessionId: callerSessionId(),
            launchId: callerLaunchId(),
            createdAt: Date.now(),
          });
          inferredTaskName = task;
        }
      } catch (err) {
        console.error(err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
    }

    const route = resolveTaskRoute({
      task: inferredTaskName ?? taskFlag ?? process.env.AGENTS_BROWSER_TASK,
      sessionId: callerSessionId(),
      launchId: callerLaunchId(),
      hub: defaultBrowserHub(),
    });
    if (route.kind !== 'proceed') {
      console.error(route.message);
      process.exit(1);
    }

    inferredTaskName = route.task;
    // A cold page verb (no bound task) whose route is the fleet hub still
    // forwards: `route.task` is undefined but `route.device` is a peer, so the
    // `--task` push below is skipped and the hub's daemon creates the caller's
    // OWN task (keyed to the identity `dispatchBrowserToDevice` now forwards).
    // Only a self-host route runs locally.
    if (isSelfHost(route.device)) return;
    // ...but a cold CLOSE verb (done/stop) must NOT forward: with no task it
    // would target a browsing context this session never opened. It stays local
    // (its historic no-task behaviour) unless an explicit --task/local binding
    // routes it — a taskless `done` must never blindly stop a hub task.
    if (!route.task && isTerminalBrowserVerb(top)) return;

    const forwarded = browserForwardedArgv();
    if (route.task && !forwarded.includes('--task')) {
      forwarded.push('--task', route.task);
    }

    const outputPath =
      top === 'screenshot'
        ? (actionCommand.opts() as { output?: string }).output ??
          flagValue(process.argv.slice(2), 'output', 'o')
        : undefined;

    if (top === 'screenshot' && outputPath) {
      const withoutOutput = stripRoutingFlags(forwarded, [
        { long: 'output', short: 'o', takesValue: true },
      ]);
      const captured = await dispatchBrowserToDevice(route.device, withoutOutput, 'capture');
      if (captured.code !== 0) {
        process.stderr.write(captured.stderr);
        process.exit(captured.code);
      }
      const remotePath = captured.stdout
        .split('\n')
        .map((line) => line.trim())
        .find((line) => line.length > 0);
      if (!remotePath) {
        console.error(`Remote screenshot on ${route.device} produced no path.`);
        process.exit(1);
      }
      try {
        await pullRemoteFile(route.device, remotePath, outputPath);
      } catch (err) {
        console.error(err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
      const saved = path.resolve(outputPath);
      console.log(saved);
      process.exit(0);
    }

    const result = await dispatchBrowserToDevice(route.device, forwarded, 'stream');
    if (result.code === 0 && (top === 'done' || top === 'stop') && route.task) {
      unbindTask(route.task);
    }
    process.exit(result.code);
  });

  browser
    .command('remote-control [state]')
    .description(
      "Allow or deny other fleet machines driving THIS machine's browser over `browser --device` or `agents ssh …` (`agents browser` / `ag browser` / standalone `browser`). " +
        '`on`/`off` to set (device-local, never synced); no argument prints the current value. Default off.',
    )
    .option('--json', 'Output as JSON')
    .action((state: string | undefined, opts: { json?: boolean }) => {
      const KEY = 'browser.remote-control';
      if (state === undefined) {
        const cur = getConfigValue(KEY).value === true;
        if (opts.json) {
          console.log(JSON.stringify({ remoteControl: cur }));
          return;
        }
        console.log(`Remote browser control (this machine): ${cur ? 'on' : 'off'}`);
        if (!cur) console.log('Enable with: agents browser remote-control on');
        return;
      }
      const norm = state.toLowerCase();
      const onWords = ['on', 'true', 'yes', 'allow', 'enable'];
      const offWords = ['off', 'false', 'no', 'deny', 'disable'];
      if (!onWords.includes(norm) && !offWords.includes(norm)) {
        console.error(`Expected "on" or "off", got "${state}".`);
        process.exit(1);
      }
      const value = onWords.includes(norm);
      setConfigValue(KEY, value);
      if (opts.json) {
        console.log(JSON.stringify({ remoteControl: value }));
        return;
      }
      console.log(`Remote browser control (this machine) is now ${value ? 'on' : 'off'}.`);
      console.log(
        value
          ? 'Other fleet machines can now drive this browser via `browser --device <this-device>`.'
          : 'Cross-machine `browser --device` drives to this machine are refused.',
      );
    });

  const stream = browser
    .command('stream')
    .description('Keep one process and daemon IPC socket open; read NDJSON requests from stdin and write NDJSON responses')
    .option(TASK_OPTION_FLAG, 'Default task for requests that omit `task` (defaults to $AGENTS_BROWSER_TASK)')
    .option(DEVICE_ON_PAGE_VERB_FLAG, DEVICE_ON_PAGE_VERB_DESC)
    .action(async (opts: { task?: string; device?: string }) => {
      await runBrowserIPCStream({
        input: process.stdin,
        output: process.stdout,
        task: opts.task ?? process.env.AGENTS_BROWSER_TASK,
        actor: resolveActor().id,
        launchId: process.env.AGENT_LAUNCH_ID,
        sessionId: process.env.AGENT_SESSION_ID || process.env.AGENTS_SESSION_ID,
      });
    });

  setHelpSections(stream, {
    examples: `
      # Batch two warm actions through one process and one browser-service connection
      printf '%s\\n' \\
        '{"action":"screenshot","path":"/tmp/page.jpg"}' \\
        '{"action":"click","atX":320,"atY":540}' \\
        | agents browser stream --task "$AGENTS_BROWSER_TASK"

      # Keep the command open and send one JSON object per line from a long-lived shell
      agents browser stream --task "$AGENTS_BROWSER_TASK"
    `,
    notes: `
      stdout is protocol-only: one compact JSON response for each non-empty input line.
      Malformed JSON returns an error response without closing the stream.
      The first start response becomes the default task for later lines in the same stream.
    `,
  });

  browser
    .command('start')
    .description('Start a browser task. Pass --profile <name>; omit to use your configured default (set it with `agents browser use <name>` or `agents setup`). Page verbs (navigate/screenshot/…) create a task implicitly when none exists — start is for --profile/--url/--record/--title.')
    .option('-p, --profile <name>', 'Browser profile to use (omit to use this machine\'s configured default; set it with `agents browser use <name>`)')
    .option(TASK_OPTION_FLAG, 'Task name (auto-generated short id if omitted)')
    .option('--title <label>', 'Human label shown in `browser status` (defaults to first navigated host)')
    .option('-e, --endpoint <name>', 'Endpoint preset (defaults to the profile\'s default)')
    .option('-u, --url <url>', 'Open URL in first tab')
    .option('--device <name>', 'Device that hosts this task (defaults to the browser.device hub when set; use `local` to force this machine). Later verbs resolve it from --task; not valid on page verbs')
    .option('--fresh', 'Always open a new tab, skipping the reclaim of a tab an abandoned task is holding on that URL')
    .option('--no-skills', 'Skip auto-discovery of site-specific SKILL.md from ~/.agents/skills/browser/domain-skills/')
    .option('--record', 'Start recording right after the tab opens (shorthand for `agents browser record start` as a follow-up)')
    .option('--fps <n>', 'Recording frames per second (with --record; 1–30, default 5)', (v) => parseInt(v, 10))
    .option('--duration <sec>', 'Recording duration cap in seconds (with --record; default 60)', (v) => parseInt(v, 10))
    .option('--max-mb <mb>', 'Recording size cap in MB (with --record; default 25)', (v) => parseInt(v, 10))
    .option('--json', 'Output machine-readable JSON (task handle + tabId + reused/message)')
    .action(async (opts) => {
      // Fast-fail copy of the consent gate, so a refused start never resolves or
      // auto-creates a profile. The AUTHORITATIVE gate is in the daemon
      // (BrowserService.start / resolveOrCreateTask, via
      // assertRemoteControlAllowedForRequest) — it has to be, because the page
      // verbs create a browser implicitly and never reach this command.
      try {
        assertRemoteControlAllowed();
      } catch (err) {
        console.error(err instanceof Error ? err.message : String(err));
        process.exit(1);
      }

      // Thin-client hub (PHNX-2010): when this box has a fleet browser hub
      // (`browser.device`) and the caller gave no explicit --device, forward the
      // WHOLE start there — bare OR --profile — and skip the local profile/browser
      // resolution below. The hub owns its profiles, browser, and consent, so this
      // box needs no local browser and need not carry the named profile; forwarding
      // the local pre-checks here would reject a profile that lives only on the hub.
      // Later page verbs follow the task to the hub via the task→device index bound
      // here. `--device local`/`--device self` (below) force a local run instead;
      // `defaultBrowserHub()` is undefined on the hub itself and on a fleet-remote
      // re-exec, so neither forwards to itself.
      if (!opts.device) {
        const hub = defaultBrowserHub();
        if (hub) {
          // No local profile validation: the hub is the authority on its own
          // profiles (including fleet-scoped ones this box can't see in
          // `declaringDevices`), so a bad `--profile` is caught by the hub's own
          // start and streamed back with its exit code, rather than second-guessed
          // here against a registry that doesn't carry the hub's profiles.
          try {
            const result = await dispatchBrowserToDevice(hub, browserForwardedArgv(), 'capture');
            process.stdout.write(result.stdout);
            process.stderr.write(result.stderr);
            if (result.code !== 0) process.exit(result.code);
            const taskName = remoteStartTaskName(result.stdout, opts.task);
            if (!taskName) {
              console.error(`Remote start on ${hub} produced no task name.`);
              process.exit(1);
            }
            bindTask(taskName, {
              device: hub,
              // Only what the caller named; the hub's own default (bare start) is
              // opaque here. Name-based `done`/`stop --task` and the post-stop
              // unbind GC these regardless.
              profile: opts.profile,
              url: opts.url,
              sessionId: callerSessionId(),
              launchId: callerLaunchId(),
              createdAt: Date.now(),
            });
          } catch (err) {
            console.error(err instanceof Error ? err.message : String(err));
            process.exit(1);
          }
          return;
        }
      }

      // Resolve an EXPLICIT --device BEFORE any local profile/browser
      // resolution (PHNX-3289). The task lives on the TARGET device, so its
      // browser binary and profile must resolve THERE. Resolving locally first
      // made a browserless box fail with a misleading "No supported browser
      // found" (bare start) or "Profile <x> not found" (a profile that lives
      // only on the target) before the start ever routed to --device. This
      // mirrors the hub path above: the target is the authority on its own
      // profiles, so forward the whole start and let it validate. `local`/`self`
      // force a local run; a fleet-remote re-exec is already ON the target and
      // falls through to the local launch below.
      const deviceName: string | undefined =
        opts.device === 'local' || opts.device === 'self' ? undefined : opts.device;
      if (deviceName) {
        const lowered = deviceName.toLowerCase();
        if (lowered === 'all' || lowered === 'auto') {
          console.error(
            `--device ${deviceName} is not valid on \`agents browser start\`: a task lives on one device.\n` +
              `Next: agents browser start --task <name> --device <device>`,
          );
          process.exit(1);
        }
        if (!isSelfHost(deviceName) && !isFleetRemoteInvocation()) {
          // Resolve the profile NAME (never a local browser auto-pick) so a
          // named profile can still be validated against the target's
          // declarations before we round-trip. A bare start carries no name to
          // validate — the target picks its own default — so it forwards
          // straight through, which is exactly what unblocks a browserless box.
          // Only resolve when the caller actually named a profile: passing an
          // undefined ref would let `resolveProfileRef` fall back to THIS box's
          // configured/auto-detected default (matching the ~4 other call sites
          // in this file), and validating that local name against the target
          // re-introduces the exact false failure this reorder fixes.
          const forwardProfile = opts.profile ? await resolveProfileRef(opts.profile) : undefined;
          if (forwardProfile) {
            try {
              assertDeviceDeclaresProfile(deviceName, forwardProfile);
            } catch (err) {
              console.error(err instanceof Error ? err.message : String(err));
              process.exit(1);
            }
          }
          try {
            const result = await dispatchBrowserToDevice(deviceName, browserForwardedArgv(), 'capture');
            process.stdout.write(result.stdout);
            process.stderr.write(result.stderr);
            if (result.code !== 0) process.exit(result.code);
            const taskName = remoteStartTaskName(result.stdout, opts.task);
            if (!taskName) {
              console.error(`Remote start on ${deviceName} produced no task name.`);
              process.exit(1);
            }
            bindTask(taskName, {
              device: deviceName,
              // Only the caller-named profile; the target's own default (bare
              // start) is opaque here, exactly as in the hub path.
              profile: forwardProfile ?? opts.profile,
              url: opts.url,
              sessionId: callerSessionId(),
              launchId: callerLaunchId(),
              createdAt: Date.now(),
            });
            if (!result.stderr.includes(`started on ${deviceName}`)) {
              console.error(`Task "${taskName}" started on ${deviceName}.`);
            }
          } catch (err) {
            console.error(err instanceof Error ? err.message : String(err));
            process.exit(1);
          }
          return;
        }
      }

      // One resolution order for every command (RUSH-2709): `--profile default`
      // means the same profile here as it does in stop / status / navigate.
      // `start` is the one command that LAUNCHES, so its implicit path goes
      // through ensureDefaultBrowserProfile, which additionally verifies the
      // resolved default can launch on THIS machine and, when nothing launchable
      // resolves, throws an actionable "pick a browser in `agents setup`" error
      // (PHNX-3296 — it no longer silently mints an auto-chrome). A filter-only
      // command must not warn about the config, so that check lives only here.
      let profileName: string;
      try {
        profileName = await resolveProfileRefForStart(opts.profile);
      } catch (err) {
        console.error(err instanceof Error ? err.message : String(err));
        process.exit(1);
      }

      // Pre-check the profile locally so we fail fast with a helpful error
      // instead of round-tripping a generic "Profile not found" through the daemon.
      const profile = await getProfile(profileName);
      if (!profile) {
        console.error(`Profile "${profileName}" not found.`);
        const all = await listProfiles();
        if (all.length > 0) {
          console.error(`Available profiles: ${all.map((p) => p.name).join(', ')}`);
        }
        console.error(
          `Create one with: agents browser profiles create ${profileName} --browser <chrome|comet|chromium|brave|edge|arc|custom>`
        );
        process.exit(1);
      }

      // Discovery is read-only for list/show/doctor. Starting is the explicit
      // adoption point: persist only the agents-cli alias/native identity, never
      // mutate Arc's own profile or Space data.
      await persistDiscoveredProfile(profileName);

      // A native endpoint is not CDP and cannot be tunnelled. Re-exec the
      // complete command on the declaring owner, then bind its returned task
      // locally so every later verb follows the same owner from task-index.
      if (!isFleetRemoteInvocation()) {
        let routed;
        try {
          routed = resolveBrowserTarget(profileName, { endpointName: opts.endpoint });
        } catch (err) {
          console.error(err instanceof Error ? err.message : String(err));
          process.exit(1);
        }
        if (!routed.local && routed.commandDispatch) {
          const result = await dispatchBrowserToDevice(routed.device, browserForwardedArgv(), 'capture');
          process.stdout.write(result.stdout);
          process.stderr.write(result.stderr);
          if (result.code !== 0) process.exit(result.code);
          const taskName = remoteStartTaskName(result.stdout, opts.task);
          if (!taskName) {
            console.error(`Remote start on ${routed.device} produced no task name.`);
            process.exit(1);
          }
          bindTask(taskName, {
            device: routed.device,
            profile: profileName,
            url: opts.url,
            sessionId: callerSessionId(),
            launchId: callerLaunchId(),
            createdAt: Date.now(),
          });
          return;
        }
      }

      // Pre-check the endpoint name too — same fail-fast rationale.
      if (opts.endpoint) {
        const presets = getEndpointPresets(profile);
        if (!presets[opts.endpoint]) {
          console.error(
            `Endpoint "${opts.endpoint}" not found on profile "${profileName}". ` +
              `Available: ${Object.keys(presets).join(', ')}`
          );
          process.exit(1);
        }
      }

      // Only the LOCAL launch reaches here — an explicit remote --device already
      // forwarded and returned above. A residual `deviceName` means an explicit
      // self target (or a fleet-remote re-exec on the target); its profile
      // resolved locally, so verify this box actually declares it (the
      // `profiles claim` hint lives in `assertDeviceDeclaresProfile`).
      if (deviceName) {
        try {
          assertDeviceDeclaresProfile(deviceName, profileName);
        } catch (err) {
          console.error(err instanceof Error ? err.message : String(err));
          process.exit(1);
        }
      }

      // Grounded login guardrail: if the opening URL is a known login-gated
      // service and the resolved profile has no session for it, say so on stderr
      // and name a profile that IS logged in. Reads the profile's real cookie DB
      // (presence only) — never blocks or slows start; any failure is silent.
      if (opts.url) {
        try {
          const service = serviceForUrl(opts.url);
          if (service) {
            const here = await loginsForProfile(profileName);
            if (!here.includes(service)) {
              const elsewhere = (await profilesLoggedInto(service)).filter((p) => p !== profileName);
              const hint = elsewhere.length
                ? `logged in elsewhere: ${elsewhere.join(', ')}. try: --profile ${elsewhere[0]}`
                : `no profile on this machine has a ${service} session.`;
              console.error(`warning: profile "${profileName}" (${profile.browser}) has no ${service} session. ${hint}`);
            }
          }
        } catch { /* login detection is best-effort; never block start */ }
      }

      // Identity is stamped inside sendIPCRequest; no need to pass it here.
      const response = await sendIPCRequest({
        action: 'start',
        profile: profileName,
        taskName: opts.task,
        url: opts.url,
        endpoint: opts.endpoint,
        skipDomainSkill: opts.skills === false,
        fresh: opts.fresh === true,
        title: opts.title,
      });

      if (!response.ok) {
        console.error(response.error);
        process.exit(1);
      }

      const boundDevice = deviceName && isSelfHost(deviceName) ? deviceName : machineId();
      if (response.task) {
        bindTask(response.task, {
          device: boundDevice,
          profile: profileName,
          url: opts.url,
          sessionId: callerSessionId(),
          launchId: callerLaunchId(),
          createdAt: Date.now(),
        });
      }

      // --json: machine-readable, still task-handle-first for callers that parse it.
      if (opts.json) {
        console.log(JSON.stringify({
          ok: true,
          task: response.task,
          tabId: response.tabId,
          device: boundDevice,
          profile: profileName,
          // `reused` is task-level; `created`/`refreshed` describe the page op.
          reused: response.reused === true,
          created: response.created,
          refreshed: response.refreshed,
          message: response.message,
        }, null, 2));
        return;
      }

      // stdout: just the resolved name, one line, no decoration. Lets callers do:
      //   export AGENTS_BROWSER_TASK=$(agents browser start --profile work)
      console.log(response.task);

      // stderr: human-friendly commentary so a TTY user still sees what happened.
      // Shell substitution captures stdout only, so $(...) stays clean. A same-name
      // retry reused the TASK — key on `reused`, not the page-level `refreshed`
      // (a no-URL retry reuses the task without reloading anything).
      const startVerb = response.reused ? 'reused' : 'started';
      console.error(`Task "${response.task}" ${startVerb} on ${boundDevice} (profile: ${profileName}).`);
      if (response.message) console.error(response.message);
      if (opts.url && response.tabId) {
        console.error(`Tab ${response.tabId}`);
      }
      console.error('Tip: page verbs resolve this task from --task; --device is only valid on start.');
      console.error('Try: agents browser screenshot | agents browser console --level error');

      // Surface the matched domain-skill (if any) so an agent driving the
      // task picks up site-specific selectors and gotchas before it starts
      // clicking. Header is recognizable so an agent parsing the stream can
      // extract the skill content; suffix repeats the skill name for greps.
      if (response.skill) {
        console.error('');
        console.error(`--- domain-skill: ${response.skill.name} (${response.skill.hostname}) ---`);
        console.error(response.skill.content);
        console.error(`--- end domain-skill: ${response.skill.name} ---`);
      }

      // --record convenience: fire record-start right after the tab opens so
      // the user gets a single-command capture flow. Failures here are
      // reported but don't fail the start — the task is already running.
      if (opts.record) {
        const recordResponse = await sendIPCRequest({
          action: 'record-start',
          task: response.task,
          tabId: response.tabId,
          fps: opts.fps,
          duration: opts.duration,
          maxMb: opts.maxMb,
        });
        if (!recordResponse.ok) {
          console.error(`Recording failed to start: ${recordResponse.error}`);
        } else {
          console.error(
            `Recording at ${recordResponse.fps} fps (cap ${recordResponse.durationCapSec}s / ${recordResponse.maxMb} MB) -> ${recordResponse.path}`
          );
          console.error('Stop with: agents browser record stop');
        }
      }
    });

  browser
    .command('done')
    .description('Complete a task and close its tabs (resolves from caller identity when --task is omitted)')
    .option(TASK_OPTION_FLAG, TASK_OPTION_DESC)
    .option(DEVICE_ON_PAGE_VERB_FLAG, DEVICE_ON_PAGE_VERB_DESC)
    .action(async (opts) => {
      const task = resolveTaskName(opts);
      const response = await sendIPCRequest({
        action: 'done',
        task,
      });

      if (!response.ok) {
        console.error(response.error);
        process.exit(1);
      }

      if (response.message === 'nothing to close' || !response.task) {
        console.log('nothing to close');
        return;
      }
      console.log(`Completed task: ${response.task}`);
    });

  browser
    .command('stop')
    .description('Stop a browser task and close its tabs; with --profile, detach the whole profile; with --service, stop only browser IPC while the shared daemon stays up')
    .option(TASK_OPTION_FLAG, TASK_OPTION_DESC)
    .option(DEVICE_ON_PAGE_VERB_FLAG, DEVICE_ON_PAGE_VERB_DESC)
    .option('-p, --profile <name>', 'Detach the whole profile (incl. composite "name@endpoint") instead of stopping a single task')
    .option('--service', 'Stop only the browser-ipc service and clear a stale/wedged socket; the shared daemon and its other services stay up')
    .addOption(new Option('--daemon').hideHelp())
    .action(async (opts) => {
      if (opts.service || opts.daemon) {
        if (opts.profile || opts.task) {
          console.error('--service stops browser IPC; do not combine it with --profile or --task.');
          process.exit(1);
        }
        if (opts.daemon) {
          console.error('`--daemon` now means the browser service only; use `--service`. The shared daemon will not be stopped.');
        }
        try {
          const result = await stopBrowserService();
          const parts: string[] = [];
          parts.push(result.wasRunning ? 'Stopped browser service' : 'Browser service was not running');
          if (result.socketCleared) parts.push('cleared stale socket');
          parts.push(result.daemonRunning ? 'shared daemon is still running' : 'shared daemon was already stopped');
          console.log(`${parts.join('; ')}. Browser IPC starts again on the next browser action that requires it.`);
        } catch (err) {
          console.error(err instanceof Error ? err.message : String(err));
          process.exit(1);
        }
        return;
      }

      if (opts.profile) {
        const profile = (await resolveProfileRef(opts.profile)) ?? opts.profile;
        const response = await sendIPCRequest({
          action: 'stop',
          profile,
        });
        if (!response.ok) {
          console.error(response.error);
          process.exit(1);
        }
        console.log(`Stopped profile: ${profile}`);
        return;
      }

      const task = resolveTaskName(opts);
      const response = await sendIPCRequest({
        action: 'stop',
        task,
      });

      if (!response.ok) {
        console.error(response.error);
        process.exit(1);
      }

      if (response.message === 'nothing to close' || !response.task) {
        console.log('nothing to close');
        return;
      }
      console.log(`Stopped task: ${response.task}`);
    });

  browser
    .command('prune')
    .alias('gc')
    .description(
      'Close tabs for abandoned tasks — owning agent session exited, or idle past the window — and mark them done. ' +
        'The same reaper the daemon already runs every 5 minutes; use this to run it now.'
    )
    .option('--dry-run', 'List what would be closed without closing anything')
    .option(
      '--idle-minutes <n>',
      'Override the idle window in minutes (default: this device\'s browser.task-idle-minutes, or 30). ' +
        '0 disables idle-only closing for this run; session-dead tasks are still closed.',
      (v) => parseInt(v, 10)
    )
    .option('--json', 'Output machine-readable JSON')
    .action(async (opts) => {
      const response = await sendIPCRequest({
        action: 'gc',
        dryRun: opts.dryRun,
        idleMinutes: opts.idleMinutes,
      });

      if (!response.ok) {
        if (opts.json) {
          console.log(JSON.stringify({ ok: false, error: response.error }));
        } else {
          console.error(response.error);
        }
        process.exit(1);
      }

      const reaped = response.reaped ?? { closed: [], skipped: 0 };
      if (opts.json) {
        console.log(JSON.stringify(reaped, null, 2));
        return;
      }

      if (reaped.closed.length === 0) {
        console.log(`No abandoned tasks${opts.dryRun ? ' (dry run)' : ''}; ${reaped.skipped} task(s) still active.`);
        return;
      }

      const verb = opts.dryRun ? 'Would close' : 'Closed';
      console.log(`${verb} ${reaped.closed.length} task(s), left ${reaped.skipped} alone:`);
      for (const c of reaped.closed) {
        console.log(`  ${c.task}  (${c.profile}, ${c.reason})`);
      }
    });

  browser
    .command('show <url>')
    .description('Open a URL for a human to read: goes to browser.viewer (default: browser.profile), and binds no task')
    .option('--os-browser', 'Use the OS default handler instead of the configured viewer')
    .option('--json', 'Output machine-readable JSON')
    .action(async (url: string, opts: { osBrowser?: boolean; json?: boolean }) => {
      // The entry point external tools need. `navigate` binds a task, which the
      // abandoned-task reaper closes when the calling session ends — wrong for a
      // page a person is reading. This does not.
      const { showUrl, showFile } = await import('../lib/open-url.js');
      // `+` not `*` on the scheme body: `[a-z][a-z0-9+.-]*:` matches a Windows
      // drive letter (`C:\Users\me\plan.html`), so a real path was treated as a
      // URL. A scheme is at least two characters.
      const isLocalFile = !/^[a-z][a-z0-9+.-]+:/i.test(url);
      const outcome = isLocalFile
        ? await showFile(path.resolve(url), { osBrowser: opts.osBrowser })
        : await showUrl(url, { osBrowser: opts.osBrowser });

      if (opts.json) {
        console.log(JSON.stringify(outcome, null, 2));
      } else if (outcome.via === 'none') {
        console.error(`Could not open a browser — open this yourself:\n  ${url}`);
      } else if (outcome.via === 'profile') {
        console.log(`Shown in ${outcome.profile}: ${url}`);
      } else {
        console.log(`Opened in the OS default browser: ${url}`);
      }
      if (outcome.via === 'none') process.exit(1);
    });

  browser
    .command('navigate [url]')
    .alias('goto')
    .description('Navigate current tab to URL (creates a task and tab when none exist)')
    .option(TASK_OPTION_FLAG, TASK_OPTION_DESC)
    .option(DEVICE_ON_PAGE_VERB_FLAG, DEVICE_ON_PAGE_VERB_DESC)
    .option('-u, --url <url>', 'URL to navigate to (or pass it positionally)')
    .option('-p, --profile <name>', 'Browser profile (optional if task is unique)')
    .option('--json', 'Output machine-readable JSON')
    .action(async (urlPos: string | undefined, opts: { task?: string; url?: string; profile?: string; json?: boolean }) => {
      const url = urlPos || opts.url;
      if (!url) {
        console.error('URL required. Usage: agents browser navigate <url>');
        process.exit(1);
      }
      const task = resolveTaskName(opts);
      const response = await sendIPCRequest({
        action: 'navigate',
        task,
        url,
        profile: opts.profile ? await resolveProfileRef(opts.profile) : undefined,
      });

      if (!response.ok) {
        if (opts.json) console.log(JSON.stringify({ ok: false, error: response.error }));
        else console.error(response.error);
        process.exit(1);
      }

      if (opts.json) {
        console.log(JSON.stringify({
          ok: true,
          task: response.task,
          tabId: response.tabId,
          url,
          created: response.created ?? false,
          refreshed: response.refreshed ?? false,
          message: response.message,
        }, null, 2));
        return;
      }

      if (response.task) {
        console.error(`task ${response.task}`);
      }
      // Honest human output: a same-task reopen reloaded the SAME tab rather than
      // navigating a fresh one (PHNX-2399). Any picked-device / reopen note rides
      // stderr so stdout stays the one-line result.
      if (response.message) console.error(response.message);
      const verb = response.refreshed ? 'Refreshed' : 'Navigated';
      console.log(`${verb} ${response.tabId} to ${url}`);
    });

  // Tab subcommand group
  const tab = browser.command('tab').description('Manage tabs');

  tab
    .command('add')
    .description('Open URL in new tab (becomes current)')
    .option(TASK_OPTION_FLAG, TASK_OPTION_DESC)
    .option(DEVICE_ON_PAGE_VERB_FLAG, DEVICE_ON_PAGE_VERB_DESC)
    .requiredOption('--url <url>', 'URL to open in the new tab')
    .option('-p, --profile <name>', 'Browser profile')
    .option('--json', 'Output machine-readable JSON')
    .action(async (opts) => {
      const task = resolveTaskName(opts);
      const response = await sendIPCRequest({
        action: 'tab-add',
        task,
        url: opts.url,
        profile: opts.profile ? await resolveProfileRef(opts.profile) : undefined,
      });

      if (!response.ok) {
        if (opts.json) console.log(JSON.stringify({ ok: false, error: response.error }));
        else console.error(response.error);
        process.exit(1);
      }

      if (opts.json) {
        console.log(JSON.stringify({
          ok: true,
          task: response.task,
          tabId: response.tabId,
          url: opts.url,
          created: response.created ?? false,
          refreshed: response.refreshed ?? false,
          message: response.message,
        }, null, 2));
        return;
      }

      // A reopen of a URL already in an owned tab refreshes that tab in place
      // rather than opening a duplicate (PHNX-2399).
      if (response.refreshed) {
        if (response.message) console.error(response.message);
        console.log(`Refreshed tab ${response.tabId}: ${opts.url}`);
      } else {
        console.log(`Opened tab ${response.tabId}: ${opts.url}`);
      }
    });

  tab
    .command('focus <tabId>')
    .description('Switch to tab (by ID, prefix, or URL substring)')
    .option(TASK_OPTION_FLAG, TASK_OPTION_DESC)
    .option(DEVICE_ON_PAGE_VERB_FLAG, DEVICE_ON_PAGE_VERB_DESC)
    .action(async (tabId: string, opts) => {
      const task = resolveTaskName(opts);
      const response = await sendIPCRequest({
        action: 'tab-focus',
        task,
        tabId,
      });

      if (!response.ok) {
        console.error(response.error);
        process.exit(1);
      }

      console.log(`Focused tab ${response.tabId}`);
    });

  tab
    .command('close [tabId]')
    .description('Close tab(s) — omit tabId to close all')
    .option(TASK_OPTION_FLAG, TASK_OPTION_DESC)
    .option(DEVICE_ON_PAGE_VERB_FLAG, DEVICE_ON_PAGE_VERB_DESC)
    .action(async (tabId: string | undefined, opts) => {
      const task = resolveTaskName(opts);
      const response = await sendIPCRequest({
        action: 'tab-close',
        task,
        tabId,
      });

      if (!response.ok) {
        console.error(response.error);
        process.exit(1);
      }

      console.log(tabId ? `Closed tab ${tabId}` : `Closed all tabs for ${task}`);
    });

  browser
    .command('tabs')
    .description('List tabs open for the current task; --all shows every tab open in the profile browser, yours included')
    .option(TASK_OPTION_FLAG, TASK_OPTION_DESC)
    .option(DEVICE_ON_PAGE_VERB_FLAG, DEVICE_ON_PAGE_VERB_DESC)
    .option('--all', "Every tab open in the profile browser, not only this task's: OWNER names the owning task, or \"you\" for a tab no task owns")
    .option('--json', 'Output machine-readable JSON')
    .action(async (opts) => {
      const task = resolveTaskName(opts);
      const response = await sendIPCRequest({
        action: 'tab-list',
        task,
        ...(opts.all ? { all: true } : {}),
      });

      if (!response.ok) {
        if (opts.json) {
          console.log(JSON.stringify({ ok: false, error: response.error }));
        } else {
          console.error(response.error);
        }
        process.exit(1);
      }

      if (opts.json) {
        console.log(JSON.stringify(response.tabs ?? [], null, 2));
        return;
      }

      if (!response.tabs || response.tabs.length === 0) {
        console.log('No tabs open');
        return;
      }

      if (opts.all) {
        console.log('TAB'.padEnd(12) + 'OWNER'.padEnd(18) + 'URL');
        console.log('-'.repeat(88));
        for (const t of response.tabs) {
          const owner = t.task ?? 'you';
          const current = t.current ? ' *' : '';
          console.log(t.id.slice(0, 11).padEnd(12) + owner.slice(0, 17).padEnd(18) + t.url.slice(0, 55) + current);
        }
        return;
      }
      console.log('TAB'.padEnd(12) + 'URL');
      console.log('-'.repeat(70));
      for (const t of response.tabs) {
        const current = (t as { id: string; url: string; current?: boolean }).current ? ' *' : '';
        console.log(t.id.padEnd(12) + t.url.slice(0, 55) + current);
      }
    });


  browser
    .command('screenshot')
    .description('Take a screenshot — auto-saved per task; --output only needed when you want a specific path')
    .option(TASK_OPTION_FLAG, TASK_OPTION_DESC)
    .option(DEVICE_ON_PAGE_VERB_FLAG, DEVICE_ON_PAGE_VERB_DESC)
    .option('-t, --tab <tabId>', 'Tab ID (defaults to current)')
    .option('-o, --output <path>', 'Specific output path (otherwise auto-saved under sessions/<task>/)')
    .option(
      '-q, --quality <mode>',
      'compressed (JPEG, capped at ~100 KB — default) or raw (PNG, pixel-faithful)',
      'compressed'
    )
    .action(async (opts) => {
      const task = resolveTaskName(opts);
      if (opts.quality !== 'compressed' && opts.quality !== 'raw') {
        console.error('--quality must be "compressed" or "raw"');
        process.exit(1);
      }
      const response = await sendIPCRequest({
        action: 'screenshot',
        task,
        tabId: opts.tab,
        path: opts.output,
        quality: opts.quality,
      });

      if (!response.ok) {
        console.error(response.error);
        process.exit(1);
      }

      // RUSH-3086: the daemon sandboxes writes to the runtime dir and silently
      // ignores `-o` outside it. Honor the requested path here.
      const savedPath = response.path
        ? honorScreenshotOutput(opts.output, response.path)
        : response.path;

      // stdout: just the path, so `P=$(agents browser screenshot)` works.
      console.log(savedPath);

      // stderr: human commentary with size + dimensions, so an agent can
      // see at a glance what was captured without `ls -l && file` round-trips.
      const size = humanizeBytes(response.bytes);
      const dims = response.width && response.height ? `${response.width}×${response.height}` : 'unknown size';
      console.error(`Saved screenshot to ${savedPath} (${size}, ${dims})`);

      // When auto-saving (no --output), surface the directory once so the
      // agent doesn't have to dirname() the path or guess where files land.
      if (!opts.output && savedPath) {
        const dir = path.dirname(savedPath);
        console.error(`Tip: auto-saving to ${dir}. Pass --output <path> to choose a path.`);
      }
    });

  browser
    .command('pdf [output]')
    .description('Export the current tab as PDF via CDP Page.printToPDF — auto-saved under sessions/<task>/ when [output] is omitted')
    .option(TASK_OPTION_FLAG, TASK_OPTION_DESC)
    .option(DEVICE_ON_PAGE_VERB_FLAG, DEVICE_ON_PAGE_VERB_DESC)
    .option('-t, --tab <tabId>', 'Tab ID (defaults to current)')
    .action(async (output: string | undefined, opts) => {
      const task = resolveTaskName(opts);
      const response = await sendIPCRequest({
        action: 'pdf',
        task,
        tabId: opts.tab,
        path: output,
      });

      if (!response.ok) {
        console.error(response.error);
        process.exit(1);
      }

      console.log(response.path);
      const size = humanizeBytes(response.bytes);
      console.error(`Saved PDF to ${response.path} (${size})`);

      if (!output && response.path) {
        const dir = path.dirname(response.path);
        console.error(`Tip: auto-saving to ${dir}. Pass a path argument to choose one.`);
      }
    });

  browser
    .command('evaluate [expression]')
    .alias('eval')
    .description('Evaluate JavaScript in current tab')
    .option(TASK_OPTION_FLAG, TASK_OPTION_DESC)
    .option(DEVICE_ON_PAGE_VERB_FLAG, DEVICE_ON_PAGE_VERB_DESC)
    .option('-t, --tab <tabId>', 'Tab ID (defaults to current)')
    .option('-e, --expression <js>', 'JavaScript expression to evaluate (or pass it positionally)')
    .option('-f, --file <path>', 'Path to a .js file whose contents will be evaluated')
    .action(async (exprPos: string | undefined, opts: { task?: string; tab?: string; expression?: string; file?: string }) => {
      const task = resolveTaskName(opts);
      const flagExpr = opts.expression || exprPos;
      if (flagExpr && opts.file) {
        console.error('Pass exactly one of an expression or --file');
        process.exit(1);
      }
      let expression: string;
      if (opts.file) {
        try {
          expression = fs.readFileSync(opts.file, 'utf8');
        } catch (err) {
          console.error(`Cannot read --file ${opts.file}: ${(err as Error).message}`);
          process.exit(1);
        }
      } else if (flagExpr) {
        expression = flagExpr;
      } else {
        console.error('Pass an expression positionally, -e <js>, or --file <path>');
        process.exit(1);
      }
      const response = await sendIPCRequest({
        action: 'evaluate',
        task,
        tabId: opts.tab,
        expr: expression,
      });

      if (!response.ok) {
        console.error(response.error);
        process.exit(1);
      }

      console.log(JSON.stringify(response.result, null, 2));
    });

  browser
    .command('ps')
    .description('List every browser/electron/tunnel process agents has tracked (alive or stale) — works without the daemon')
    .option('--json', 'Output machine-readable JSON')
    .action((opts: { json?: boolean }) => {
      const snapshots = listAllProfileSnapshots();
      // Cross-check against what's actually listening locally so we can
      // surface "port claimed by us but nothing is listening" (= leaked
      // cache file) and "port listening but not in our records" (= someone
      // else owns it; a new profile pointing here would collide).
      const portOwners = new Map<number, { pid: number; command: string }>();
      const conflicts: string[] = [];
      for (const s of snapshots) {
        const port = s.meta?.port;
        if (!port) continue;
        const occupant = getPortOccupant(port);
        if (!occupant) {
          if (s.pidAlive || s.tunnelAlive) {
            conflicts.push(`${s.name}: port ${port} marked active but nothing is listening`);
          }
          continue;
        }
        const ourPid = s.meta?.tunnelPid && s.meta.kind === 'tunnel'
          ? s.meta.tunnelPid
          : s.meta?.pid;
        if (ourPid && occupant.pid !== ourPid) {
          conflicts.push(
            `${s.name}: port ${port} listened on by ${occupant.command} (pid ${occupant.pid}) but our record says pid ${ourPid}`
          );
        }
        portOwners.set(port, occupant);
      }

      if (opts.json) {
        console.log(JSON.stringify({ snapshots, conflicts }, null, 2));
        return;
      }

      if (snapshots.length === 0) {
        console.log('No tracked browser state. Run `agents browser start --profile <name>` to spawn one.');
        return;
      }

      console.log('PROFILE                                  KIND      PID    TUNNEL  PORT   ALIVE  TASKS  OWNER');
      console.log('-----------------------------------------------------------------------------------------------');
      for (const s of snapshots) {
        const kind = s.meta?.kind ?? '-';
        const pid = s.meta?.pid ?? '-';
        const tunnelPid = s.meta?.tunnelPid ?? '-';
        const port = s.meta?.port ?? '-';
        const alive = aliveLabel(s);
        const owner = s.meta?.daemonPid
          ? `daemon${s.daemonAlive ? '' : '(dead)'}=${s.meta.daemonPid}`
          : '-';
        console.log(
          `${s.name.padEnd(40)} ${String(kind).padEnd(9)} ${String(pid).padEnd(6)} ${String(tunnelPid).padEnd(7)} ${String(port).padEnd(6)} ${alive.padEnd(6)} ${String(s.taskCount).padEnd(6)} ${owner}`
        );
      }

      if (conflicts.length > 0) {
        console.log('');
        console.log('Conflicts / leaks detected:');
        for (const c of conflicts) console.log(`  - ${c}`);
        console.log('');
        console.log('Run `agents browser stop --profile <name>` to clean up a specific profile, or restart the daemon to trigger the orphan reaper.');
      }
    });

  function aliveLabel(s: { pidAlive: boolean; tunnelAlive: boolean; meta: { kind?: string } | null }): string {
    const k = s.meta?.kind;
    if (k === 'tunnel') return s.tunnelAlive ? 'yes' : 'stale';
    return s.pidAlive ? 'yes' : 'stale';
  }

  browser
    .command('status')
    .description('Show browser service state and running browser tasks')
    .option('-p, --profile <name>', 'Filter by profile')
    .option('--json', 'Output machine-readable JSON')
    .action(async (opts) => {
      let response;
      try {
        response = await sendIPCRequest({
          action: 'status',
          profile: opts.profile ? await resolveProfileRef(opts.profile) : undefined,
        }, { autoStartDaemon: false });
      } catch (err) {
        if (err instanceof BrowserServiceNotRunningError) {
          const message = formatBrowserServiceNotRunningError();
          if (opts.json) {
            console.log(JSON.stringify({ ok: false, service: { id: 'browser-ipc', state: 'stopped' }, error: message }));
          } else {
            console.error(message);
          }
          process.exit(1);
        }
        throw err;
      }

      if (!response.ok) {
        if (opts.json) {
          console.log(JSON.stringify({ ok: false, error: response.error }));
        } else {
          console.error(response.error);
        }
        process.exit(1);
      }

      if (opts.json) {
        console.log(JSON.stringify(response.profiles ?? [], null, 2));
        return;
      }

      console.log(chalk.gray('Browser service: running (shared daemon unchanged)'));

      // Build flat list of tasks with profile context
      const allTasks: BrowserTask[] = [];
      for (const profile of response.profiles || []) {
        for (const task of profile.tasks) {
          allTasks.push({ task, profile });
        }
      }

      if (allTasks.length === 0) {
        // Show recent history instead
        const historyResponse = await sendIPCRequest({ action: 'history', limit: 5 });
        if (historyResponse.ok && historyResponse.history && historyResponse.history.length > 0) {
          console.log('No active tasks. Recent history:\n');
          console.log('PROFILE'.padEnd(15) + 'TASK'.padEnd(18) + 'DOMAINS'.padEnd(22) + 'DURATION'.padEnd(10) + 'ENDED');
          console.log('-'.repeat(75));
          for (const h of historyResponse.history) {
            const domains = h.domains?.slice(0, 2).join(', ') || '-';
            const duration = formatDuration(h.endedAt - h.createdAt);
            const ended = formatAge(h.endedAt);
            console.log(
              h.profile.padEnd(15) +
                h.name.padEnd(18) +
                domains.slice(0, 20).padEnd(22) +
                duration.padEnd(10) +
                ended
            );
          }
          console.log('\nRun `browser history` for more.');
        } else {
          console.log('No browser tasks running');
        }
        return;
      }

      // Interactive picker for TTY, plain output otherwise
      if (isInteractiveTerminal()) {
        const picked = await browserTaskPicker({
          message: 'Browser tasks:',
          tasks: allTasks,
        });
        if (picked) {
          // Show tab list for the selected task
          const tabResponse = await sendIPCRequest({
            action: 'tab-list',
            task: picked.task.task.name,
          });
          if (tabResponse.ok && tabResponse.tabs) {
            console.log(`\nTabs for ${picked.task.task.name}:`);
            for (const tab of tabResponse.tabs) {
              console.log(`  ${tab.id}  ${tab.url}`);
            }
          }
        }
      } else {
        // Non-interactive: simple table output
        for (const profile of response.profiles || []) {
          const portLabel =
            profile.configuredPort && profile.configuredPort !== profile.port
              ? `port ${profile.port} (configured ${profile.configuredPort})`
              : `port ${profile.port}`;
          // pid 0 means the daemon attached to a browser we didn't launch — no
          // tracked pid. Render it as "attached" rather than the literal 0.
          const pidLabel = profile.pid ? `pid ${profile.pid}` : 'attached';
          // `profile.name` is the BARE profile; the endpoint is its own field,
          // so the row reads `comet-local (endpoint: endpoint-0, port …)`
          // instead of the raw `comet-local@endpoint-0` key (RUSH-2709).
          const endpointLabel = profile.endpoint ? `endpoint: ${profile.endpoint}, ` : '';
          console.log(`\n${profile.name} (${endpointLabel}${portLabel}, ${pidLabel})`);
          if (profile.tasks.length === 0) {
            console.log('  No active tasks');
          } else {
            console.log(
              '  ' +
                'ID'.padEnd(12) +
                'LABEL'.padEnd(20) +
                'TABS'.padEnd(6) +
                'DOMAINS'.padEnd(22) +
                'CREATED',
            );
            for (const task of profile.tasks) {
              const age = formatAge(task.createdAt);
              const id = (task.name || task.id).slice(0, 10);
              const label = (task.label || task.name || task.id).slice(0, 18);
              const domains = task.domains?.slice(0, 2).join(', ') || '-';
              console.log(
                '  ' +
                  id.padEnd(12) +
                  label.padEnd(20) +
                  String(task.tabCount).padEnd(6) +
                  domains.slice(0, 20).padEnd(22) +
                  age
              );
            }
          }
        }
      }
    });

  browser
    .command('tasks')
    .description('List all browser tasks')
    .option('-p, --profile <name>', 'Filter by profile')
    .option('--json', 'Output machine-readable JSON')
    .action(async (opts) => {
      const response = await sendIPCRequest({
        action: 'status',
        profile: opts.profile ? await resolveProfileRef(opts.profile) : undefined,
      });

      if (!response.ok) {
        if (opts.json) {
          console.log(JSON.stringify({ ok: false, error: response.error }));
        } else {
          console.error(response.error);
        }
        process.exit(1);
      }

      const allTasks: Array<{ profile: string; name: string; tabs: number; domains: string[]; created: number }> = [];
      for (const profile of response.profiles || []) {
        for (const task of profile.tasks) {
          allTasks.push({
            profile: profile.name,
            name: task.name || task.id,
            tabs: task.tabCount,
            domains: task.domains || [],
            created: task.createdAt,
          });
        }
      }

      if (opts.json) {
        console.log(JSON.stringify(allTasks, null, 2));
        return;
      }

      if (allTasks.length === 0) {
        // Show recent history instead
        const historyResponse = await sendIPCRequest({ action: 'history', limit: 5 });
        if (historyResponse.ok && historyResponse.history && historyResponse.history.length > 0) {
          console.log('No active tasks. Recent history:\n');
          console.log('PROFILE'.padEnd(15) + 'TASK'.padEnd(18) + 'DOMAINS'.padEnd(22) + 'DURATION'.padEnd(10) + 'ENDED');
          console.log('-'.repeat(75));
          for (const h of historyResponse.history) {
            const domains = h.domains?.slice(0, 2).join(', ') || '-';
            const duration = formatDuration(h.endedAt - h.createdAt);
            const ended = formatAge(h.endedAt);
            console.log(
              h.profile.padEnd(15) +
                h.name.padEnd(18) +
                domains.slice(0, 20).padEnd(22) +
                duration.padEnd(10) +
                ended
            );
          }
        } else {
          console.log('No active tasks');
        }
        return;
      }

      console.log('PROFILE'.padEnd(15) + 'TASK'.padEnd(18) + 'TABS'.padEnd(6) + 'DOMAINS'.padEnd(22) + 'CREATED');
      console.log('-'.repeat(70));
      for (const t of allTasks) {
        const domains = t.domains.slice(0, 2).join(', ') || '-';
        console.log(
          t.profile.padEnd(15) +
            t.name.padEnd(18) +
            String(t.tabs).padEnd(6) +
            domains.slice(0, 20).padEnd(22) +
            formatAge(t.created)
        );
      }
    });

  browser
    .command('history')
    .description('Show recent browser task history')
    .option('-l, --limit <n>', 'Number of entries (default 10)', '10')
    .option('--json', 'Output machine-readable JSON')
    .action(async (opts) => {
      const response = await sendIPCRequest({
        action: 'history',
        limit: parseInt(opts.limit, 10),
      });

      if (!response.ok) {
        if (opts.json) {
          console.log(JSON.stringify({ ok: false, error: response.error }));
        } else {
          console.error(response.error);
        }
        process.exit(1);
      }

      if (opts.json) {
        console.log(JSON.stringify(response.history ?? [], null, 2));
        return;
      }

      if (!response.history || response.history.length === 0) {
        console.log('No browser task history');
        return;
      }

      console.log('PROFILE'.padEnd(15) + 'TASK'.padEnd(18) + 'DOMAINS'.padEnd(22) + 'DURATION'.padEnd(10) + 'ENDED');
      console.log('-'.repeat(75));
      for (const h of response.history) {
        const domains = h.domains?.slice(0, 2).join(', ') || '-';
        const duration = formatDuration(h.endedAt - h.createdAt);
        const ended = formatAge(h.endedAt);
        console.log(
          h.profile.padEnd(15) +
            h.name.padEnd(18) +
            domains.slice(0, 20).padEnd(22) +
            duration.padEnd(10) +
            ended
        );
      }
    });

  browser
    .command('refs')
    .description('Get DOM refs for interactive elements')
    .option(TASK_OPTION_FLAG, TASK_OPTION_DESC)
    .option(DEVICE_ON_PAGE_VERB_FLAG, DEVICE_ON_PAGE_VERB_DESC)
    .option('-t, --tab <tabId>', 'Tab ID (defaults to current)')
    .option('--all', 'Include non-interactive elements')
    .option('-l, --limit <n>', 'Max elements (default 500)', '500')
    .option('--json', 'Output machine-readable JSON')
    .action(async (opts) => {
      const task = resolveTaskName(opts);
      const response = await sendIPCRequest({
        action: 'refs',
        task,
        tabId: opts.tab,
        interactive: !opts.all,
        limit: parseInt(opts.limit, 10),
      });

      if (!response.ok) {
        if (opts.json) {
          console.log(JSON.stringify({ ok: false, error: response.error }));
        } else {
          console.error(response.error);
        }
        process.exit(1);
      }

      // Warn (on stderr, so it never corrupts --json stdout) when the a11y tree
      // exposed nothing to click — the caller should fall back to a screenshot
      // plus coordinate click.
      const count = response.nodes?.length ?? 0;
      if (count === 0) {
        const scope = opts.all ? 'elements' : 'interactive elements';
        console.error(
          `No ${scope} found. The page may render its UI on a canvas or in a custom widget ` +
            `the accessibility tree doesn't expose. Take a screenshot ` +
            `(\`browser screenshot\`) and click by position with \`browser click --at X,Y\`.`
        );
      }

      if (opts.json) {
        console.log(JSON.stringify(response.nodes ?? [], null, 2));
        return;
      }

      console.log(response.refs);
    });

  browser
    .command('click [ref]')
    .description('Click an element by ref, or raw coordinates with --at X,Y')
    .option(TASK_OPTION_FLAG, TASK_OPTION_DESC)
    .option(DEVICE_ON_PAGE_VERB_FLAG, DEVICE_ON_PAGE_VERB_DESC)
    .option('-t, --tab <tabId>', 'Tab ID (defaults to current)')
    .option('--at <x,y>', 'Click viewport coordinates (e.g. --at 320,540), bypassing ref resolution')
    .action(async (ref: string | undefined, opts) => {
      const task = resolveTaskName(opts);

      let requestExtra: { ref?: number; atX?: number; atY?: number };
      if (opts.at !== undefined) {
        const parts = String(opts.at).split(',').map((s) => Number(s.trim()));
        if (parts.length !== 2 || parts.some((n) => !Number.isFinite(n))) {
          console.error(`Invalid --at value "${opts.at}". Expected X,Y (e.g. --at 320,540).`);
          process.exit(1);
        }
        requestExtra = { atX: parts[0], atY: parts[1] };
      } else if (ref !== undefined) {
        const parsed = parseInt(ref, 10);
        if (!Number.isFinite(parsed)) {
          console.error(`Invalid ref "${ref}". Pass an integer ref or use --at X,Y.`);
          process.exit(1);
        }
        requestExtra = { ref: parsed };
      } else {
        console.error('Provide a ref (e.g. `click 5`) or coordinates (`click --at X,Y`).');
        process.exit(1);
        return;
      }

      const response = await sendIPCRequest({
        action: 'click',
        task,
        tabId: opts.tab,
        ...requestExtra,
      });

      if (!response.ok) {
        console.error(response.error);
        process.exit(1);
      }

      console.log(response.message ? `Clicked (${response.message})` : 'Clicked');
    });

  browser
    .command('type <ref>')
    .description('Type text into an element by ref')
    .option(TASK_OPTION_FLAG, TASK_OPTION_DESC)
    .option(DEVICE_ON_PAGE_VERB_FLAG, DEVICE_ON_PAGE_VERB_DESC)
    .option('-t, --tab <tabId>', 'Tab ID (defaults to current)')
    .option('--text <text>', 'Text to type (use quotes for spaces/special chars)')
    .option('--secret <ref>', 'Resolve <bundle>/<KEY> from `agents secrets` and type the value. The secret is resolved in-process and never printed to stdout or the transcript. Alternative to --text.')
    .option('--clear', 'Clear editor content before typing')
    .action(async (ref: string, opts) => {
      const task = resolveTaskName(opts);
      const refNum = parseInt(ref, 10);
      if (!Number.isFinite(refNum)) {
        console.error(`<ref> must be an integer, got: ${ref}`);
        process.exit(1);
      }

      // Resolve the text to type: literal --text, or a --secret <bundle>/<KEY>
      // reference resolved in-process so the value never crosses stdout/transcript.
      let text: string | undefined = opts.text;
      if (opts.secret) {
        if (opts.text !== undefined) {
          console.error('Pass either --text or --secret, not both.');
          process.exit(1);
        }
        const parsed = parseSecretRef(opts.secret);
        if (!parsed) {
          console.error(`--secret must be <bundle>/<KEY>, got: ${opts.secret}`);
          process.exit(1);
        }
        if (!(await bundleExists(parsed.bundle))) {
          console.error(`Secrets bundle "${parsed.bundle}" not found.`);
          process.exit(1);
        }
        try {
          const { env } = await readAndResolveBundleEnv(parsed.bundle, { caller: 'browser type', keys: [parsed.key], keyMode: 'storage', agentOnly: true });
          if (!(parsed.key in env)) {
            console.error(`Key "${parsed.key}" not in bundle "${parsed.bundle}".`);
            process.exit(1);
          }
          text = env[parsed.key];
        } catch (err) {
          console.error((err as Error).message);
          process.exit(1);
        }
      }
      if (text === undefined) {
        console.error('Provide --text <text> or --secret <bundle>/<KEY>.');
        process.exit(1);
      }

      const response = await sendIPCRequest({
        action: 'type',
        task,
        tabId: opts.tab,
        ref: refNum,
        text,
        clear: opts.clear,
      });

      if (!response.ok) {
        console.error(response.error);
        process.exit(1);
      }

      // Never echo the typed text — with --secret it would leak the credential.
      console.log('Typed');
    });

  browser
    .command('press <key>')
    .description('Press a key (Enter, Tab, Escape, etc)')
    .option(TASK_OPTION_FLAG, TASK_OPTION_DESC)
    .option(DEVICE_ON_PAGE_VERB_FLAG, DEVICE_ON_PAGE_VERB_DESC)
    .option('-t, --tab <tabId>', 'Tab ID (defaults to current)')
    .action(async (key: string, opts) => {
      const task = resolveTaskName(opts);
      const response = await sendIPCRequest({
        action: 'press',
        task,
        tabId: opts.tab,
        key,
      });

      if (!response.ok) {
        console.error(response.error);
        process.exit(1);
      }

      console.log('Pressed');
    });

  browser
    .command('hover <ref>')
    .description('Hover over an element by ref')
    .option(TASK_OPTION_FLAG, TASK_OPTION_DESC)
    .option(DEVICE_ON_PAGE_VERB_FLAG, DEVICE_ON_PAGE_VERB_DESC)
    .option('-t, --tab <tabId>', 'Tab ID (defaults to current)')
    .action(async (ref: string, opts) => {
      const task = resolveTaskName(opts);
      const response = await sendIPCRequest({
        action: 'hover',
        task,
        tabId: opts.tab,
        ref: parseInt(ref, 10),
      });

      if (!response.ok) {
        console.error(response.error);
        process.exit(1);
      }

      console.log('Hovered');
    });

  browser
    .command('scroll')
    .description('Scroll the page by pixel amount (negatives scroll up/left)')
    .option(TASK_OPTION_FLAG, TASK_OPTION_DESC)
    .option(DEVICE_ON_PAGE_VERB_FLAG, DEVICE_ON_PAGE_VERB_DESC)
    .option('-t, --tab <tabId>', 'Tab ID (defaults to current)')
    .option('--dx <n>', 'Horizontal pixels (negative = left)', (v) => parseInt(v, 10), 0)
    .option('--dy <n>', 'Vertical pixels (negative = up)', (v) => parseInt(v, 10), 0)
    .option('-x, --at-x <x>', 'X coordinate to dispatch scroll from (default 0)', parseInt)
    .option('-y, --at-y <y>', 'Y coordinate to dispatch scroll from (default 0)', parseInt)
    .action(async (opts) => {
      const task = resolveTaskName(opts);
      if (!Number.isFinite(opts.dx) || !Number.isFinite(opts.dy)) {
        console.error('--dx and --dy must be integers');
        process.exit(1);
      }
      if (opts.dx === 0 && opts.dy === 0) {
        console.error('Pass --dx and/or --dy (at least one must be non-zero)');
        process.exit(1);
      }
      const response = await sendIPCRequest({
        action: 'scroll',
        task,
        tabId: opts.tab,
        scrollX: opts.dx,
        scrollY: opts.dy,
        scrollAtX: opts.atX,
        scrollAtY: opts.atY,
      });

      if (!response.ok) {
        console.error(response.error);
        process.exit(1);
      }

      console.log('Scrolled');
    });

  browser
    .command('upload')
    .description('Upload file(s) — supports hidden file inputs, drag-drop targets, and OS chooser interception')
    .option(TASK_OPTION_FLAG, TASK_OPTION_DESC)
    .option(DEVICE_ON_PAGE_VERB_FLAG, DEVICE_ON_PAGE_VERB_DESC)
    .option('-t, --tab <tabId>', 'Tab ID (defaults to current)')
    .option('-r, --ref <n>', 'Ref of the upload target element (file input or drop zone)', (v) => parseInt(v, 10))
    .option('--trigger <n>', 'Ref of a button that opens the OS file chooser (Pattern C)', (v) => parseInt(v, 10))
    .option('-f, --file <path...>', 'Absolute path(s) to file(s) to upload (repeatable)')
    .option('--drop', 'Force drag-drop pattern even if ref is an <input type=file>')
    .option('--input', 'Force file-input pattern (DOM.setFileInputFiles)')
    .option('--timeout <ms>', 'Timeout for chooser interception (Pattern C)', (v) => parseInt(v, 10))
    .action(async (opts) => {
      const task = resolveTaskName(opts);
      const files: string[] = opts.file ?? [];
      if (files.length === 0) {
        console.error('--file <path> is required (repeat for multiple files)');
        process.exit(1);
      }
      if (opts.ref === undefined && opts.trigger === undefined) {
        console.error('--ref <n> or --trigger <n> is required');
        process.exit(1);
      }
      if (opts.drop && opts.input) {
        console.error('--drop and --input are mutually exclusive');
        process.exit(1);
      }

      let mode: 'auto' | 'input' | 'drop' | 'chooser' = 'auto';
      if (opts.trigger !== undefined) mode = 'chooser';
      else if (opts.drop) mode = 'drop';
      else if (opts.input) mode = 'input';

      const response = await sendIPCRequest({
        action: 'upload',
        task,
        tabId: opts.tab,
        ref: opts.ref,
        trigger: opts.trigger,
        files,
        uploadMode: mode,
        timeout: opts.timeout,
      });

      if (!response.ok) {
        console.error(response.error);
        process.exit(1);
      }

      console.log(`Uploaded ${files.length} file${files.length === 1 ? '' : 's'} (${response.uploadMode})`);
    });

  // ─── Viewport & Device ───────────────────────────────────────────────────────

  const setCmd = browser.command('set').description('Set browser emulation options');

  setCmd
    .command('viewport <width> <height>')
    .description('Set viewport size')
    .option(TASK_OPTION_FLAG, TASK_OPTION_DESC)
    .option(DEVICE_ON_PAGE_VERB_FLAG, DEVICE_ON_PAGE_VERB_DESC)
    .option('-t, --tab <tabId>', 'Tab ID (defaults to current)')
    .option('-m, --mobile', 'Enable mobile emulation')
    .option('-s, --scale <factor>', 'Device scale factor', parseFloat)
    .action(async (width: string, height: string, opts) => {
      const task = resolveTaskName(opts);
      const response = await sendIPCRequest({
        action: 'set-viewport',
        task,
        tabId: opts.tab,
        width: parseInt(width, 10),
        height: parseInt(height, 10),
        mobile: opts.mobile,
        deviceScaleFactor: opts.scale,
      });

      if (!response.ok) {
        console.error(response.error);
        process.exit(1);
      }

      console.log(`Viewport set to ${width}x${height}${opts.mobile ? ' (mobile)' : ''}`);
    });

  setCmd
    .command('device <device-name>')
    .description('Emulate a device (iPhone 14, iPad, MacBook Pro)')
    .option(TASK_OPTION_FLAG, TASK_OPTION_DESC)
    .option(DEVICE_ON_PAGE_VERB_FLAG, DEVICE_ON_PAGE_VERB_DESC)
    .option('-t, --tab <tabId>', 'Tab ID (defaults to current)')
    .action(async (deviceName: string, opts) => {
      const task = resolveTaskName(opts);
      const response = await sendIPCRequest({
        action: 'set-device',
        task,
        tabId: opts.tab,
        deviceName,
      });

      if (!response.ok) {
        console.error(response.error);
        process.exit(1);
      }

      console.log(`Device set to ${deviceName}`);
    });

  browser
    .command('devices')
    .description('List available device presets')
    .action(async () => {
      const { DEVICES } = await import('../lib/browser/devices.js');
      console.log('Available devices:');
      for (const [name, desc] of Object.entries(DEVICES)) {
        console.log(`  ${name.padEnd(16)} ${desc.width}x${desc.height} @${desc.deviceScaleFactor}x${desc.mobile ? ' (mobile)' : ''}`);
      }
    });

  // ─── Console & Errors ────────────────────────────────────────────────────────

  browser
    .command('console')
    .description('Read console logs from a tab')
    .option(TASK_OPTION_FLAG, TASK_OPTION_DESC)
    .option(DEVICE_ON_PAGE_VERB_FLAG, DEVICE_ON_PAGE_VERB_DESC)
    .option('-t, --tab <tabId>', 'Tab ID (defaults to current)')
    .option('-l, --level <level>', 'Filter by level (log, info, warn, error)')
    .option('--clear', 'Clear logs after reading')
    .action(async (opts) => {
      const task = resolveTaskName(opts);
      const response = await sendIPCRequest({
        action: 'console',
        task,
        tabId: opts.tab,
        level: opts.level,
        clear: opts.clear,
      });

      if (!response.ok) {
        console.error(response.error);
        process.exit(1);
      }

      if (!response.logs || response.logs.length === 0) {
        console.log('No console logs');
        return;
      }

      for (const log of response.logs) {
        const prefix = `[${log.level.toUpperCase()}]`.padEnd(8);
        const loc = log.url ? ` (${log.url}${log.line ? `:${log.line}` : ''})` : '';
        console.log(`${prefix} ${log.text}${loc}`);
      }
    });

  browser
    .command('errors')
    .description('Read page errors from a tab')
    .option(TASK_OPTION_FLAG, TASK_OPTION_DESC)
    .option(DEVICE_ON_PAGE_VERB_FLAG, DEVICE_ON_PAGE_VERB_DESC)
    .option('-t, --tab <tabId>', 'Tab ID (defaults to current)')
    .option('--clear', 'Clear errors after reading')
    .action(async (opts) => {
      const task = resolveTaskName(opts);
      const response = await sendIPCRequest({
        action: 'errors',
        task,
        tabId: opts.tab,
        clear: opts.clear,
      });

      if (!response.ok) {
        console.error(response.error);
        process.exit(1);
      }

      if (!response.errors || response.errors.length === 0) {
        console.log('No errors');
        return;
      }

      for (const err of response.errors) {
        console.log(`[ERROR] ${err.message}`);
        if (err.stack) console.log(err.stack);
        if (err.url) console.log(`  at ${err.url}${err.line ? `:${err.line}` : ''}`);
        console.log();
      }
    });

  // ─── Network ─────────────────────────────────────────────────────────────────

  browser
    .command('requests')
    .description('Read captured network requests. --format har emits a HAR 1.2 JSON document.')
    .option(TASK_OPTION_FLAG, TASK_OPTION_DESC)
    .option(DEVICE_ON_PAGE_VERB_FLAG, DEVICE_ON_PAGE_VERB_DESC)
    .option('-t, --tab <tabId>', 'Tab ID (defaults to current)')
    .option('-f, --filter <text>', 'Filter URLs containing text')
    .option('--clear', 'Clear requests after reading')
    .option('--format <format>', 'Output format: table (default) or har', 'table')
    .action(async (opts) => {
      const task = resolveTaskName(opts);
      if (opts.format !== 'table' && opts.format !== 'har') {
        console.error('--format must be "table" or "har"');
        process.exit(1);
      }
      const response = await sendIPCRequest({
        action: 'requests',
        task,
        tabId: opts.tab,
        filter: opts.filter,
        clear: opts.clear,
      });

      if (!response.ok) {
        console.error(response.error);
        process.exit(1);
      }

      const requests = response.requests ?? [];

      if (opts.format === 'har') {
        const har = buildHar(requests, {
          creatorName: 'agents-cli',
          creatorVersion: getCliVersion(),
        });
        console.log(JSON.stringify(har, null, 2));
        return;
      }

      if (requests.length === 0) {
        console.log('No requests captured');
        return;
      }

      console.log('METHOD'.padEnd(8) + 'STATUS'.padEnd(8) + 'URL');
      console.log('-'.repeat(72));
      for (const req of requests) {
        const status = req.status ? String(req.status) : '...';
        console.log(`${req.method.padEnd(8)}${status.padEnd(8)}${req.url.slice(0, 100)}`);
      }
    });

  browser
    .command('logs')
    .description('Read merged rush-app + rush-cli JSONL logs for a task')
    .option(TASK_OPTION_FLAG, TASK_OPTION_DESC)
    .option(DEVICE_ON_PAGE_VERB_FLAG, DEVICE_ON_PAGE_VERB_DESC)
    .option('--source <name>', 'Source to scope to: rush-app or rush-cli (default both)')
    .option('--lines <n>', 'Tail N entries (default 200; ignored when --since)', (v) => parseInt(v, 10))
    .option('--since <when>', 'Absolute timestamp or relative offset (e.g. 5m, 2h, 1d)')
    .option('--until <when>', 'Absolute timestamp or relative offset (e.g. 5m, 2h, 1d)')
    .option('--level <level>', 'Filter entries by level field')
    .option('--message <name>', 'Filter entries by exact message field')
    .option('--filter <text>', 'Filter entries whose JSON contains this substring')
    .option('-f, --follow', 'Follow mode (not yet implemented)')
    .action(async (opts: {
      task?: string;
      source?: string;
      lines?: number;
      since?: string;
      until?: string;
      level?: string;
      message?: string;
      filter?: string;
      follow?: boolean;
    }) => {
      if (opts.follow) {
        process.stderr.write('follow mode not yet implemented; coming next pass\n');
        process.exit(1);
      }
      const task = resolveTaskName(opts);
      const response = await sendIPCRequest({
        action: 'getAppLogs',
        task,
        source: opts.source,
        lines: opts.lines,
        since: opts.since,
        until: opts.until,
        appLevel: opts.level,
        message: opts.message,
        filter: opts.filter,
      });

      if (!response.ok) {
        console.error(response.error);
        process.exit(1);
      }

      const entries = response.appLogs ?? [];
      for (const entry of entries) {
        console.log(JSON.stringify(entry));
      }
    });

  browser
    .command('responsebody <url-pattern>')
    .description('Wait for and read a response body by URL pattern')
    .option(TASK_OPTION_FLAG, TASK_OPTION_DESC)
    .option(DEVICE_ON_PAGE_VERB_FLAG, DEVICE_ON_PAGE_VERB_DESC)
    .option('-t, --tab <tabId>', 'Tab ID (defaults to current)')
    .option('--timeout <ms>', 'Timeout in milliseconds', parseInt)
    .option('--max-chars <n>', 'Max characters to return', parseInt)
    .action(async (urlPattern: string, opts) => {
      const task = resolveTaskName(opts);
      const response = await sendIPCRequest({
        action: 'response-body',
        task,
        tabId: opts.tab,
        urlPattern,
        timeout: opts.timeout,
        maxChars: opts.maxChars,
      });

      if (!response.ok) {
        console.error(response.error);
        process.exit(1);
      }

      console.log(response.body);
    });

  // ─── Wait ────────────────────────────────────────────────────────────────────

  browser
    .command('wait')
    .description('Wait for a condition')
    .option(TASK_OPTION_FLAG, TASK_OPTION_DESC)
    .option(DEVICE_ON_PAGE_VERB_FLAG, DEVICE_ON_PAGE_VERB_DESC)
    .option('-t, --tab <tabId>', 'Tab ID (defaults to current)')
    .option('--time <ms>', 'Wait for milliseconds')
    .option('--selector <css>', 'Wait for CSS selector to appear')
    .option('--url <pattern>', 'Wait for URL to match pattern')
    .option('--fn <js>', 'Wait for JS expression to return truthy')
    .option('--state <state>', 'Wait for load state (domcontentloaded, load, networkidle)')
    .option('--timeout <ms>', 'Timeout in milliseconds', parseInt)
    .action(async (opts) => {
      const task = resolveTaskName(opts);
      let waitType: 'time' | 'selector' | 'url' | 'function' | 'load';
      let waitValue: string | number;

      if (opts.time) {
        waitType = 'time';
        waitValue = parseInt(opts.time, 10);
      } else if (opts.selector) {
        waitType = 'selector';
        waitValue = opts.selector;
      } else if (opts.url) {
        waitType = 'url';
        waitValue = opts.url;
      } else if (opts.fn) {
        waitType = 'function';
        waitValue = opts.fn;
      } else if (opts.state) {
        waitType = 'load';
        waitValue = opts.state;
      } else {
        console.error('One of --time, --selector, --url, --fn, or --state required');
        process.exit(1);
      }

      const response = await sendIPCRequest({
        action: 'wait',
        task,
        tabId: opts.tab,
        waitType,
        waitValue,
        timeout: opts.timeout,
      });

      if (!response.ok) {
        console.error(response.error);
        process.exit(1);
      }

      console.log('Wait condition met');
    });

  // ─── Downloads ───────────────────────────────────────────────────────────────

  browser
    .command('download')
    .description("Set the download directory for a task (defaults to the profile's downloads dir)")
    .option(TASK_OPTION_FLAG, TASK_OPTION_DESC)
    .option(DEVICE_ON_PAGE_VERB_FLAG, DEVICE_ON_PAGE_VERB_DESC)
    .option('-t, --tab <tabId>', 'Tab ID (defaults to current)')
    .option('-p, --path <dir>', "Download directory path (default: the profile's downloads dir)")
    .action(async (opts) => {
      const task = resolveTaskName(opts);
      const response = await sendIPCRequest({
        action: 'set-download-path',
        task,
        tabId: opts.tab,
        downloadPath: opts.path,
      });

      if (!response.ok) {
        console.error(response.error);
        process.exit(1);
      }

      console.log(response.downloadPath ? `Download path set to ${response.downloadPath}` : 'Download path set');
    });

  browser
    .command('sessions')
    .description('Browse a profile\'s captured screenshots, PDFs, recordings, and downloads, grouped by task')
    .option('--profile <name>', 'Only this profile (default: all profiles with captures)')
    .option('--open [selector]', "Open a capture in the OS default app: 'latest' or a filename")
    .option('--json', 'Emit machine-readable JSON')
    .option('--no-interactive', 'Print the flat listing instead of opening the interactive task browser')
    .action(async (opts) => {
      await runBrowserSessionsCommand({ profile: opts.profile, open: opts.open, json: opts.json, interactive: opts.interactive });
    });

  // ─── Recording ─────────────────────────────────────────────────────────────

  const record = browser.command('record').description('Record a video of the page');

  record
    .command('start')
    .description('Start recording — auto-saved under sessions/<task>/recordings/. Bounded by --fps, --duration, --max-mb.')
    .option(TASK_OPTION_FLAG, TASK_OPTION_DESC)
    .option(DEVICE_ON_PAGE_VERB_FLAG, DEVICE_ON_PAGE_VERB_DESC)
    .option('-t, --tab <tabId>', 'Tab ID (defaults to current)')
    .option('--fps <n>', 'Frames per second (1–30, default 5)', (v) => parseInt(v, 10))
    .option('--duration <sec>', 'Hard duration cap in seconds (default 60)', (v) => parseInt(v, 10))
    .option('--max-mb <mb>', 'Stop when output exceeds this many MB (default 25)', (v) => parseInt(v, 10))
    .action(async (opts) => {
      const task = resolveTaskName(opts);
      const response = await sendIPCRequest({
        action: 'record-start',
        task,
        tabId: opts.tab,
        fps: opts.fps,
        duration: opts.duration,
        maxMb: opts.maxMb,
      });
      if (!response.ok) {
        console.error(response.error);
        process.exit(1);
      }
      // stdout: path (for capture into a variable). stderr: human commentary.
      console.log(response.path);
      console.error(
        `Recording task "${task}" at ${response.fps} fps (cap ${response.durationCapSec}s / ${response.maxMb} MB) → ${response.path}`
      );
      console.error('Stop with: agents browser record stop');
    });

  record
    .command('stop')
    .description('Stop an in-progress recording')
    .option(TASK_OPTION_FLAG, TASK_OPTION_DESC)
    .option(DEVICE_ON_PAGE_VERB_FLAG, DEVICE_ON_PAGE_VERB_DESC)
    .action(async (opts) => {
      const task = resolveTaskName(opts);
      const response = await sendIPCRequest({ action: 'record-stop', task });
      if (!response.ok) {
        console.error(response.error);
        process.exit(1);
      }
      console.log(response.path);
      const size = humanizeBytes(response.bytes);
      const seconds = ((response.durationMs ?? 0) / 1000).toFixed(1);
      console.error(`Saved recording to ${response.path} (${size}, ${seconds}s, stopped: ${response.stopReason})`);
    });

  browser
    .command('waitdownload')
    .description('Wait for a download to complete')
    .option(TASK_OPTION_FLAG, TASK_OPTION_DESC)
    .option(DEVICE_ON_PAGE_VERB_FLAG, DEVICE_ON_PAGE_VERB_DESC)
    .option('--timeout <ms>', 'Timeout in milliseconds', parseInt)
    .action(async (opts) => {
      const task = resolveTaskName(opts);
      const response = await sendIPCRequest({
        action: 'wait-download',
        task,
        timeout: opts.timeout,
      });

      if (!response.ok) {
        console.error(response.error);
        process.exit(1);
      }

      console.log(`Downloaded: ${response.downloadPath}`);
    });
}

function collect(val: string, memo: string[]): string[] {
  memo.push(val);
  return memo;
}

function formatAge(timestamp: number): string {
  const seconds = Math.floor((Date.now() - timestamp) / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ago`;
}

function humanizeBytes(n: number | undefined): string {
  if (n === undefined) return 'unknown size';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function formatDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const mm = minutes % 60;
  return mm ? `${hours}h ${mm}m` : `${hours}h`;
}
