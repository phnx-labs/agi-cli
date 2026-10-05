

import type { Command } from 'commander';
import chalk from 'chalk';
import { injectIntoTerminal, type InjectTarget } from '../lib/terminal/index.js';
import { resolveLiveInjectTarget } from '../lib/session/inject-target.js';
import { sshExec, shellQuote } from '../lib/ssh-exec.js';
import { resolveHost } from '../lib/hosts/registry.js';
import { sshTargetFor } from '../lib/hosts/types.js';
import { setHelpSections } from '../lib/help.js';
import { normalizeSingleDeviceOption } from './utils.js';

interface InjectOptions {
  pane?: string;
  socket?: string;

  device?: string | string[];
  enter?: boolean;
  combined?: boolean;
  json?: boolean;
}


export function normalizeInjectDevice(value: string | string[] | undefined): string | undefined {
  return normalizeSingleDeviceOption(value, 'sessions inject');
}


export function buildRemoteInjectArgv(sessionId: string, text: string, options: InjectOptions): string[] {
  const argv = ['agents', 'sessions', 'inject', sessionId, text];
  if (options.enter === false) argv.push('--no-enter');
  if (options.combined) argv.push('--combined');
  if (options.socket) argv.push('--socket', options.socket);
  if (options.pane) argv.push('--pane', options.pane);
  if (options.json) argv.push('--json');
  return argv;
}



export async function resolveInjectSshTarget(device: string): Promise<string> {
  const host = await resolveHost(device);
  return host ? sshTargetFor(host) : device;
}

async function injectOnDevice(sessionId: string, text: string, options: InjectOptions, device: string): Promise<void> {
  let target: string;
  try {
    target = await resolveInjectSshTarget(device);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (options.json) console.log(JSON.stringify({ ok: false, error: message }));
    else console.error(chalk.red(message));
    process.exit(1);
  }
  const remoteCmd = buildRemoteInjectArgv(sessionId, text, options).map(shellQuote).join(' ');
  const res = sshExec(target, remoteCmd, { multiplex: true });
  if (res.stdout) process.stdout.write(res.stdout);
  if (res.stderr) process.stderr.write(res.stderr);
  if (res.code !== 0) process.exit(res.code ?? 1);
}

async function runInject(sessionId: string, text: string, options: InjectOptions): Promise<void> {
  let device: string | undefined;
  try {
    device = normalizeInjectDevice(options.device);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (options.json) console.log(JSON.stringify({ ok: false, error: message }));
    else console.error(chalk.red(message));
    process.exit(1);
  }




  let target: InjectTarget | null = null;
  if (options.pane) {
    target = { backend: 'tmux', pane: options.pane, socket: options.socket };
  } else if (device) {



    return injectOnDevice(sessionId, text, options, device);
  } else {
    const resolved = await resolveLiveInjectTarget(sessionId);
    if (!resolved.target) {
      const message = resolved.hint ? `${resolved.reason}\n${resolved.hint}` : resolved.reason;
      if (options.json) console.log(JSON.stringify({ ok: false, error: message }));
      else console.error(chalk.red(message));
      process.exit(1);
    }
    target = resolved.target;
  }

  const res = await injectIntoTerminal(target, text, {
    enter: options.enter !== false,
    combined: options.combined,
    socket: options.socket,
    host: device,
  });

  if (options.json) {
    console.log(JSON.stringify(res));
  } else if (res.ok) {
    console.log(chalk.green(`Injected into ${res.backend} (${res.writes} write${res.writes === 1 ? '' : 's'}).`));
  } else {
    console.error(chalk.red(res.error ?? 'injection failed'));
  }
  if (!res.ok) process.exit(1);
}


export function registerSessionsInjectCommand(sessionsCmd: Command): void {
  const injectCmd = sessionsCmd
    .command('inject <sessionId> <text>')
    .description('Deliver text (+ Enter) into the terminal a running session lives in — nudge a stalled agent.')
    .option('--pane <id>', 'Target a tmux pane id directly (e.g. %3), skipping session lookup')
    .option('--socket <path>', 'tmux socket path (defaults to the session/shared socket)')
    .option('--device <target>', 'Deliver on a remote device over SSH. With a bare session id, the session is resolved ON that device; with --pane, the pane is addressed there directly.')
    .option('--no-enter', 'Send only the text, without a trailing Enter')
    .option('--combined', 'Fuse text + Enter into ONE write (default: two writes, Ink-TUI safe)')
    .option('--json', 'Output the InjectResult as JSON');

  setHelpSections(injectCmd, {
    examples: `
      # Nudge a stalled agent by session id (resolves its tmux pane)
      agents sessions inject a1b2c3d4 "continue"

      # Target a tmux pane directly (what a watchdog already holds)
      agents sessions inject _ "continue" --pane %3 --socket /tmp/agents/tmux.sock

      # Nudge a live session on another box (resolved on the device)
      agents sessions inject 214edaae "continue" --device yosemite-s0

      # Address a known remote pane directly (skips lookup, sends over SSH)
      agents sessions inject _ "continue" --pane %122 --socket $SOCK --device yosemite-s0
    `,
    notes: `
      - Ink-TUI Enter semantics: by default the text and Enter are two separate
        writes, which is what Claude's Ink TUI needs. --combined fuses them.
      - A session is addressable by id when it resolves to a precise split —
        tmux, iTerm, or a VSCodium/Cursor/VS Code integrated terminal
        (resolveInjectTargetForSession). Use --pane for direct targeting.
      - The id may be the session id (short or full) OR the '<shortid>' suffix of
        a tmux target (ag-<agent>-<shortid>) — the only selector a live tmux
        session whose id column shows '-' exposes.
      - Built on the Terminal Engine (src/lib/terminal): with --pane, --device
        runs the tmux send-keys spec over SSH; with a bare id, --device re-runs
        the lookup on that box (its tmux panes live there, not here).
    `,
  });



  injectCmd.action(async (sessionId: string, text: string, _options: InjectOptions, command: Command) => {
    await runInject(sessionId, text, command.optsWithGlobals() as InjectOptions);
  });
}
