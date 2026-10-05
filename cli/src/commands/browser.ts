/** `agents browser` is the consumer surface over the standalone `browser` CLI (PHNX-4101): every
 * verb forwards its arguments verbatim and propagates the exit code. agents-cli supplies the fd-3
 * context and records fd-4 actions. Verb flags are not redeclared: a mirror would drift. */

import { Command } from 'commander';
import { registerCommandGroups, setHelpSections } from '../lib/help.js';
import { buildBrowserContext } from '../lib/browser/context.js';
import { recordBrowserAction } from '../lib/browser/record.js';
import {
  isBrowserClientError,
  resolveBrowserBin,
  runBrowser,
} from '../lib/browser-client.js';
import { runBrowserSessionsCommand } from './browser-sessions-picker.js';

// Help groups — mirror the standalone `browser --help` so the mental model
// carries over, and mirror `agents computer` where the two surfaces overlap.
const BROWSER_HELP_GROUPS = [
  { title: 'Session lifecycle', names: ['use', 'start', 'done', 'status', 'prune'] },
  { title: 'Fast action loop', names: ['stream'] },
  { title: 'Drive the page', names: ['navigate', 'tabs', 'screenshot', 'evaluate', 'click', 'type', 'press', 'wait'] },
  { title: 'Capture evidence', names: ['console', 'errors', 'requests', 'responsebody', 'record', 'pdf', 'logs'] },
  { title: 'History and discovery', names: ['sessions', 'history', 'refs'] },
  { title: 'Other', names: ['profiles', 'remote-control', 'stop', 'show', 'tab', 'ps', 'tasks', 'hover', 'scroll', 'upload', 'set', 'devices', 'download', 'waitdownload'] },
] as const;

/** The verb catalog: descriptions are the consumer's, flags are the engine's. This list is the
 * contract with the engine, pinned by `browser.test.ts` so a drift fails a test. `sessions` is not
 * in it. */
export const BROWSER_PASSTHROUGH_VERBS: ReadonlyArray<{ name: string; description: string }> = [
  { name: 'use', description: 'Pick the profile `agents browser start` uses when no --profile is passed' },
  { name: 'start', description: 'Start a browser task — --profile/--url/--record/--title, and --device <name> to bind a remote box' },
  { name: 'done', description: 'Complete a task and close its tabs (resolves from caller identity when --task is omitted)' },
  { name: 'status', description: 'Show browser service state and running browser tasks' },
  { name: 'prune', description: 'Close tabs for abandoned tasks and mark them done — the reaper the daemon runs, on demand' },
  { name: 'stream', description: 'Keep one process + IPC socket open; read NDJSON requests from stdin, write NDJSON responses' },
  { name: 'navigate', description: 'Navigate the current tab to a URL (creates a task and tab when none exist)' },
  { name: 'tabs', description: 'List tabs open for the current task; --all shows every tab in the profile browser' },
  { name: 'screenshot', description: 'Take a screenshot — auto-saved per task; --output only to pick a specific path' },
  { name: 'evaluate', description: 'Evaluate JavaScript in the current tab' },
  { name: 'click', description: 'Click an element by ref, or raw coordinates with --at X,Y' },
  { name: 'type', description: 'Type text into an element by ref' },
  { name: 'press', description: 'Press a key (Enter, Tab, Escape, …)' },
  { name: 'wait', description: 'Wait for a condition' },
  { name: 'console', description: 'Read console logs from a tab' },
  { name: 'errors', description: 'Read page errors from a tab' },
  { name: 'requests', description: 'Read captured network requests; --format har emits a HAR 1.2 document' },
  { name: 'responsebody', description: 'Wait for and read a response body by URL pattern' },
  { name: 'record', description: 'Record a video of the page (record start / record stop)' },
  { name: 'pdf', description: 'Export the current tab as PDF via CDP — auto-saved under sessions/<task>/ when omitted' },
  { name: 'logs', description: 'Read merged rush-app + rush-cli logs for a task' },
  { name: 'history', description: 'Show recent browser task history' },
  { name: 'refs', description: 'Get DOM refs for interactive elements' },
  { name: 'profiles', description: 'Manage browser profiles (create / list / edit / rename / show / remove / use / …)' },
  { name: 'remote-control', description: 'Allow or deny other fleet machines driving THIS machine\'s browser (on/off; default off)' },
  { name: 'stop', description: 'Stop a task and close its tabs; --profile detaches the profile; --service stops the IPC service' },
  { name: 'show', description: 'Open a URL for a human to read (goes to browser.viewer; binds no task)' },
  { name: 'tab', description: 'Manage tabs (tab add / tab focus <id> / tab close [id])' },
  { name: 'ps', description: 'List every browser/electron/tunnel process agents has tracked — works without the daemon' },
  { name: 'tasks', description: 'List all browser tasks' },
  { name: 'hover', description: 'Hover over an element by ref' },
  { name: 'scroll', description: 'Scroll the page by a pixel amount (negatives scroll up/left)' },
  { name: 'upload', description: 'Upload file(s) — hidden inputs, drag-drop targets, and OS chooser interception' },
  { name: 'set', description: 'Set browser emulation options (set viewport / set device / set devices)' },
  { name: 'devices', description: 'List available device emulation presets' },
  { name: 'download', description: 'Set the download directory for a task' },
  { name: 'waitdownload', description: 'Wait for a download to complete' },
];

/** Peek `--device <name>` (or `--device=name`) out of a raw argv without consuming it: the flag is
 * forwarded verbatim and only read here to resolve the fleet target for the fd-3 context. Pure, so
 * unit-testable. */
export function peekDevice(argv: string[]): string | undefined {
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--device') return argv[i + 1];
    if (arg.startsWith('--device=')) return arg.slice('--device='.length);
  }
  return undefined;
}

/** Forward one invocation to the engine and propagate its exit code. A missing standalone is the
 * one failure agents-cli reports itself (install line, exit 1); there is no fallback engine. */
async function forwardToBrowser(opts: {
  argv: string[];
  /** `--device <name>`, resolved to the fd-3 target. Only `start` sets it. */
  device?: string;
  /** Read the engine's stdout instead of letting it reach the terminal. */
  capture?: boolean;
}): Promise<{ exitCode: number; stdout: string }> {
  try {
    resolveBrowserBin();
  } catch (err) {
    if (isBrowserClientError(err)) {
      console.error(err.message);
      return { exitCode: 1, stdout: '' };
    }
    throw err;
  }

  const context = await buildBrowserContext({ device: opts.device });

  return runBrowser({
    argv: opts.argv,
    context,
    capture: opts.capture,
    onEvent: (event) => recordBrowserAction(event, { device: opts.device }),
  });
}

/** Forward, then exit with the engine's status so shells and agents see the truth. */
async function forwardAndExit(opts: Parameters<typeof forwardToBrowser>[0]): Promise<void> {
  const { exitCode } = await forwardToBrowser(opts);
  if (exitCode !== 0) process.exit(exitCode);
}

/** Register every plain verb as an opaque forwarder. `allowUnknownOption` hands unowned flags
 * through in `cmd.args`, so the engine's flag surface can grow without an edit here. `start`
 * resolves `--device` from raw args; other verbs forward it and let the engine reject a stray one. */
function registerPassthroughVerbs(program: Command): void {
  for (const verb of BROWSER_PASSTHROUGH_VERBS) {
    program
      .command(verb.name)
      .description(verb.description)
      .allowUnknownOption(true)
      .allowExcessArguments(true)
      .helpOption(false)
      .action(async (_opts: unknown, cmd: Command) => {
        const argv = [verb.name, ...cmd.args];
        const device = verb.name === 'start' ? peekDevice(cmd.args) : undefined;
        await forwardAndExit({ argv, device });
      });
  }
}

// sessions: task-first history over the on-disk captures and `browser_sessions` rows (RUSH-2407),
// the counterpart of `agents computer sessions`. It reads agents-cli's own store and never reaches
// the engine; `agents sessions --browser` routes to the same runBrowserSessionsCommand.
function registerSessionsCommand(program: Command): void {
  program
    .command('sessions')
    .description('Browse a profile\'s captured screenshots, PDFs, recordings, and downloads, grouped by task')
    .option('--profile <name>', 'Only this profile (default: all profiles with captures)')
    .option('--open [selector]', "Open a capture in the OS default app: 'latest' or a filename")
    .option('--json', 'Emit machine-readable JSON')
    .option('--no-interactive', 'Print the flat listing instead of opening the interactive task browser')
    .action(async (opts: { profile?: string; open?: string | boolean; json?: boolean; interactive?: boolean }) => {
      await runBrowserSessionsCommand({ profile: opts.profile, open: opts.open, json: opts.json, interactive: opts.interactive });
    });
}

export function registerBrowserCommand(program: Command): void {
  const browser = program
    .command('browser')
    .description('Drive a real browser (Chrome/Brave/Edge/Firefox/Arc) over CDP/BiDi — navigate, screenshot, click, capture; --device to drive a remote box');

  registerPassthroughVerbs(browser);
  registerSessionsCommand(browser);
  registerCommandGroups(browser, BROWSER_HELP_GROUPS);
  setHelpSections(browser, {
    examples: `
      # One-time: install the engine, then pick a profile
      npm i -g @phnx-labs/browser-cli
      agents browser profiles create work --browser chromium
      agents browser use work

      # Start a task, drive it, capture, close
      agents browser start --profile work
      agents browser navigate https://example.com
      agents browser screenshot -o /tmp/shot.png
      agents browser done

      # A remote box over the fleet (device bound at start)
      agents browser start --device box --profile work
      agents browser navigate https://example.com
      agents browser done
    `,
    notes: `
      The engine is the standalone \`browser\` CLI (npm i -g @phnx-labs/browser-cli);
      agents-cli supplies --device fleet resolution, remote-control consent, and the
      session/feed history. Per-verb flags are the engine's — \`agents browser
      screenshot --help\` asks it directly.

      \`--device\` is bound once at \`start\`; page verbs run against the task's bound
      device. \`--device local\` forces this machine.

      Another fleet machine may drive this browser only after \`agents browser
      remote-control on\` here (device-local, never synced; default off).

      \`agents browser sessions\` (and \`agents sessions --browser\`) reads the capture
      and task history agents-cli records — it never leaves this CLI.
    `,
  });
}
