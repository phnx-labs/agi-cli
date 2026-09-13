/**
 * `agents sessions inject <sessionId> <text>` — deliver text into the terminal a
 * running session lives in. The CLI face of the Terminal Engine's Gap 2 primitive
 * (`injectIntoTerminal`, src/lib/terminal/inject.ts), so a native watchdog
 * (RUSH-1415) can shell out to nudge a stalled agent with "continue".
 *
 * Resolution: find the active session by id, then resolve its exact split through
 * the SAME canonical resolver the watchdog uses — `resolveInjectTargetForSession`
 * (lib/terminal/resolve.ts), precedence tmux > iterm > vscodium > pty. Sharing one
 * resolver keeps the manual unblock path and the watchdog in agreement on which
 * sessions are addressable (a prior duplicate resolver read only `provenance.reply`
 * and could not address a VSCodium/Cursor terminal the watchdog handled fine).
 * `--pane`/`--pty` target a backend directly when the handle is already known.
 */

import type { Command } from 'commander';
import chalk from 'chalk';
import { getActiveSessions, shortIdFromName, type ActiveSession } from '../lib/session/active.js';
import { injectIntoTerminal, resolveInjectTargetForSession, type InjectTarget } from '../lib/terminal/index.js';
import { sshExec, shellQuote } from '../lib/ssh-exec.js';
import { resolveHost } from '../lib/hosts/registry.js';
import { sshTargetFor } from '../lib/hosts/types.js';
import { setHelpSections } from '../lib/help.js';
import { normalizeSingleDeviceOption } from './utils.js';

interface InjectOptions {
  pane?: string;
  socket?: string;
  pty?: string;
  /**
   * The remote device. A single `--device box` arrives here as `['box']` because
   * the parent `sessions` command's variadic `-D, --device <target...>` shadows
   * this subcommand's scalar option under `optsWithGlobals()` — normalize it with
   * {@link normalizeInjectDevice} before use (PHNX-3688).
   */
  device?: string | string[];
  enter?: boolean;
  combined?: boolean;
  json?: boolean;
}

/**
 * Whether an active session is the one `sessions inject <token>` means. Matches
 * a resolvable session id (exact or unique prefix) AND — for a tmux-hosted row
 * whose full id never resolved (`sessionId` absent) — the `ag-<agent>-<shortid>`
 * tmux name's `shortid` suffix (exact or prefix), the full tmux name, and the
 * pane id. Those are the only selectors an id-less remote tmux row exposes, so
 * without this an operator has no tool-native way to nudge it (PHNX-3688).
 */
export function matchInjectSelector(session: ActiveSession, token: string): boolean {
  if (!token) return false;
  const sid = session.sessionId;
  if (sid && (sid === token || sid.startsWith(token))) return true;
  const short = session.tmuxName ? shortIdFromName(session.tmuxName) : undefined;
  if (short && (short === token || short.startsWith(token))) return true;
  if (session.tmuxName && session.tmuxName === token) return true;
  if (session.paneId && session.paneId === token) return true;
  return false;
}

/**
 * The `--device` selector, normalized to a single host string. `optsWithGlobals()`
 * merges the parent `sessions` command's variadic `-D, --device <target...>` over
 * this subcommand's scalar `--device`, so a single `--device box` arrives as
 * `['box']` — which flowed straight into `sshExec` and crashed on
 * `host.startsWith` (PHNX-3688). Delegates to the shared
 * {@link normalizeSingleDeviceOption} (also used by `sessions resume`,
 * PHNX-3940) rather than re-implementing the array/scalar coercion here.
 */
export function normalizeInjectDevice(value: string | string[] | undefined): string | undefined {
  return normalizeSingleDeviceOption(value, 'sessions inject');
}

/**
 * The `agents sessions inject` argv to re-run ON a device (its tmux panes live
 * there, so resolution must happen there). Every flag rides along EXCEPT
 * `--device`: the command runs on the device, resolving locally. Pure so the
 * forwarded invocation is asserted without an SSH hop (PHNX-3688).
 */
export function buildRemoteInjectArgv(sessionId: string, text: string, options: InjectOptions): string[] {
  const argv = ['agents', 'sessions', 'inject', sessionId, text];
  if (options.enter === false) argv.push('--no-enter');
  if (options.combined) argv.push('--combined');
  if (options.socket) argv.push('--socket', options.socket);
  if (options.pty) argv.push('--pty', options.pty);
  if (options.pane) argv.push('--pane', options.pane);
  if (options.json) argv.push('--json');
  return argv;
}

/**
 * Resolve `device` (registry alias or `user@host`) to an ssh target and re-run
 * `agents sessions inject` there, so a bare session id + `--device` resolves on
 * the box that actually holds the session's tmux panes. The tool-native form of
 * the `agents ssh <device> "agents sessions inject <id> …"` workaround (PHNX-3688).
 */
/**
 * Resolve `--device` to an ssh target. A registered device becomes its
 * `user@dnsName`; a bare unknown name (an ad-hoc `user@host` or ssh_config alias)
 * is handed to ssh verbatim (`resolveHost` returns null for it). A registered
 * device we CANNOT dial — password-auth, addressless — throws its typed error and
 * is NOT degraded to the raw name, which could ssh a coincidentally-matching but
 * unrelated `~/.ssh/config` Host (PHNX-3688 review).
 */
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

/** Resolve a session id (short or full) to an addressable terminal target, via the
 * same resolver the watchdog uses so both agree on what is reachable. */
async function resolveTarget(sessionId: string): Promise<{ target: InjectTarget | null; reason?: string; hint?: string }> {
  const sessions = await getActiveSessions();
  const match = sessions.find((s) => matchInjectSelector(s, sessionId));
  if (!match) return { target: null, reason: `No active session matches "${sessionId}".` };
  const resolution = resolveInjectTargetForSession(match);
  if (!resolution.addressable) {
    // Surface the resolver's precise reason (host/rail), not a generic "not tmux".
    return {
      target: null,
      reason: `Session "${sessionId}": ${resolution.reason}`,
      hint: resolution.hint,
    };
  }
  return { target: resolution.target };
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

  // Direct-target shortcuts skip the session lookup — the watchdog often already
  // holds the pane id or pty session it wants to type into. The pane's exact
  // address is known, so it composes with --device (tmux send-keys over SSH).
  let target: InjectTarget | null = null;
  if (options.pty) {
    target = { backend: 'pty', id: options.pty };
  } else if (options.pane) {
    target = { backend: 'tmux', pane: options.pane, socket: options.socket };
  } else if (device) {
    // A bare session id + a device: the session's tmux panes live ON that device,
    // so getActiveSessions here can't see them. Resolve + deliver THERE by re-running
    // inject over SSH (the same command, minus --device) — PHNX-3688.
    return injectOnDevice(sessionId, text, options, device);
  } else {
    const resolved = await resolveTarget(sessionId);
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

/** Attach the `inject` subcommand to an existing `sessions` command. */
export function registerSessionsInjectCommand(sessionsCmd: Command): void {
  const injectCmd = sessionsCmd
    .command('inject <sessionId> <text>')
    .description('Deliver text (+ Enter) into the terminal a running session lives in — nudge a stalled agent.')
    .option('--pane <id>', 'Target a tmux pane id directly (e.g. %3), skipping session lookup')
    .option('--pty <id>', 'Target an agents-pty session id directly, skipping session lookup')
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

      # Type into an agents-pty session without submitting
      agents sessions inject _ "ls" --pty $SID --no-enter

      # Nudge a live session on another box (resolved on the device)
      agents sessions inject 214edaae "continue" --device yosemite-s0

      # Address a known remote pane directly (skips lookup, sends over SSH)
      agents sessions inject _ "continue" --pane %122 --socket $SOCK --device yosemite-s0
    `,
    notes: `
      - Ink-TUI Enter semantics: by default the text and Enter are two separate
        writes, which is what Claude's Ink TUI needs. --combined fuses them.
      - A session is addressable by id when it resolves to a precise split —
        tmux, iTerm, a VSCodium/Cursor/VS Code integrated terminal, or a pty
        (resolveInjectTargetForSession). Use --pane/--pty for direct targeting.
      - The id may be the session id (short or full) OR the '<shortid>' suffix of
        a tmux target (ag-<agent>-<shortid>) — the only selector a live tmux
        session whose id column shows '-' exposes.
      - Built on the Terminal Engine (src/lib/terminal): with --pane, --device
        runs the tmux send-keys spec over SSH; with a bare id, --device re-runs
        the lookup on that box (its tmux panes live there, not here).
    `,
  });

  // The parent `sessions` command also defines --json, so it binds there;
  // optsWithGlobals() merges parent + subcommand options so --json is honored.
  injectCmd.action(async (sessionId: string, text: string, _options: InjectOptions, command: Command) => {
    await runInject(sessionId, text, command.optsWithGlobals() as InjectOptions);
  });
}
