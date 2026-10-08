
import { Command } from 'commander';
import { forwardsHelp, registerCommandGroups, setHelpSections } from '../lib/help.js';
import { buildBrowserContext } from '../lib/browser/context.js';
import { recordBrowserAction } from '../lib/browser/record.js';
import {
  isBrowserClientError,
  resolveBrowserBin,
  runBrowser,
} from '../lib/browser-client.js';

const BROWSER_HELP_GROUPS = [
  { title: 'Session lifecycle', names: ['use', 'start', 'done', 'status', 'prune'] },
  { title: 'Fast action loop', names: ['stream'] },
  { title: 'Drive the page', names: ['navigate', 'tabs', 'screenshot', 'evaluate', 'click', 'type', 'press', 'wait'] },
  { title: 'Capture evidence', names: ['console', 'errors', 'requests', 'responsebody', 'record', 'pdf', 'logs'] },
  { title: 'History and discovery', names: ['sessions', 'history', 'refs'] },
  { title: 'Other', names: ['profiles', 'remote-control', 'stop', 'show', 'tab', 'ps', 'tasks', 'hover', 'scroll', 'upload', 'set', 'devices', 'download', 'waitdownload'] },
] as const;

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
  { name: 'sessions', description: 'Browse captured screenshots, PDFs, recordings and downloads, grouped by task' },
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

export function peekDevice(argv: string[]): string | undefined {
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--device') return argv[i + 1];
    if (arg.startsWith('--device=')) return arg.slice('--device='.length);
  }
  return undefined;
}

async function forwardToBrowser(opts: {
  argv: string[];
  device?: string;
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

async function forwardAndExit(opts: Parameters<typeof forwardToBrowser>[0]): Promise<void> {
  const { exitCode } = await forwardToBrowser(opts);
  if (exitCode !== 0) process.exit(exitCode);
}

function registerPassthroughVerbs(program: Command): void {
  for (const verb of BROWSER_PASSTHROUGH_VERBS) {
    forwardsHelp(program
      .command(verb.name)
      .description(verb.description)
      .allowUnknownOption(true)
      .allowExcessArguments(true)
      .action(async (_opts: unknown, cmd: Command) => {
        const argv = [verb.name, ...cmd.args];
        const device = verb.name === 'start' ? peekDevice(cmd.args) : undefined;
        await forwardAndExit({ argv, device });
      }));
  }
}

export function registerBrowserCommand(program: Command): void {
  const browser = program
    .command('browser')
    .description('Drive a real browser (Chrome/Brave/Edge/Firefox/Arc) over CDP/BiDi — navigate, screenshot, click, capture; --device to drive a remote box');

  registerPassthroughVerbs(browser);
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
      agent-session link on the feed. Per-verb flags are the engine's — \`agents browser
      screenshot --help\` asks it directly.

      \`--device\` is bound once at \`start\`; page verbs run against the task's bound
      device. \`--device local\` forces this machine.

      Another fleet machine may drive this browser only after \`agents browser
      remote-control on\` here (device-local, never synced; default off).

      \`agents browser sessions\` is the engine's own task and capture history
      (\`browser sessions --help\`); the feed stream reads the same rows.
    `,
  });
}
