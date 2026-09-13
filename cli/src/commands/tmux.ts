/**
 * `agents tmux` — terminal multiplexer integration.
 *
 * Why this exists: the swarmify VS Code extension was hand-rolling tmux
 * commands with brittle shell escaping (`extension/src/vscode/tmux.ts`).
 * Lifting the orchestration into the CLI gives one source of truth that the
 * extension, raw shells, `agents teams`, routines, and the Swarm MCP can all
 * call into.
 *
 * Surface mirrors the standalone `term` CLI's:
 *   agents tmux check
 *   agents tmux new <name>     [--cmd ...] [--cwd DIR] [--replace] [--attach-existing] [--source S]
 *   agents tmux attach <name>
 *   agents tmux list [--json]
 *   agents tmux has <name>
 *   agents tmux split <name> <h|v> [--cmd ...] [--cwd DIR]
 *   agents tmux send <name>[:pane] <keys> [--no-enter] [--raw]
 *   agents tmux capture <name>[:pane] [--lines N] [--ansi]
 *   agents tmux info <name>    [--json]
 *   agents tmux kill [name]    no name → picker with live pane preview
 *   agents tmux kill-all       [--yes]
 */

import type { Command } from 'commander';
import chalk from 'chalk';
import { truncate, isInteractiveTerminal, isPromptCancelled } from '../lib/format.js';
import * as path from 'path';
import { setHelpSections } from '../lib/help.js';
import { multiItemPicker } from '../lib/picker.js';
import {
  assertTmuxAvailable,
  attachTmux,
  capturePane,
  createSession,
  ensureSessionHookRepaired,
  getDefaultSocketPath,
  getTmuxVersion,
  hasSession,
  isTmuxInstalled,
  isTmuxVersionSupported,
  killAll,
  killSession,
  teardownIfAgentExited,
  listSessions,
  MIN_TMUX_VERSION,
  readSessionMeta,
  sendKeys,
  splitPane,
  TmuxCommandError,
  TmuxSessionError,
  TmuxUnavailableError,
  type ListedSession,
  type SessionMeta,
} from '../lib/tmux/index.js';

/** Register the `agents tmux` command tree. */
export function registerTmuxCommands(program: Command): void {
  const tmux = program
    .command('tmux')
    .description('Persistent terminal-multiplexer sessions for agents. Survive editor restarts, share with other tools.');

  setHelpSections(tmux, {
    examples: `
      # Verify tmux is installed
      agents tmux check

      # Start a detached agent session
      agents tmux new claude-debug --cmd "agents run claude" --cwd ~/code/myrepo

      # Attach (replaces this shell with the tmux client)
      agents tmux attach claude-debug

      # Inspect remotely without attaching
      agents tmux capture claude-debug --lines 200

      # Send a slash command from a script
      agents tmux send claude-debug "/clear"

      # Clean up one by name, or pick from a list that shows each pane's last lines
      agents tmux kill claude-debug
      agents tmux kill
    `,
    notes: `
      Storage:
        Shared server socket: ~/.agents/.cache/helpers/tmux/server.sock
        Per-session meta:     ~/.agents/.cache/helpers/tmux/<name>.json

      Session names accept [A-Za-z0-9_-] up to 64 characters. tmux disallows
      '.' and ':' in names since those address windows and panes.

      Existing tmux sessions you started outside of agents-cli are NOT
      visible here unless you point them at the same socket via --socket.
    `,
  });

  // ─── check ──────────────────────────────────────────────────────────────────

  const checkCmd = tmux
    .command('check')
    .description('Check whether tmux is installed and report its version.')
    .option('--json', 'Output as JSON');

  checkCmd.action((opts) => {
    const installed = isTmuxInstalled();
    const version = installed ? getTmuxVersion() : null;
    const supported = isTmuxVersionSupported(version);
    if (opts.json) {
      console.log(JSON.stringify({ installed, supported, version, minimumVersion: MIN_TMUX_VERSION, socket: getDefaultSocketPath() }));
      if (installed && !supported) process.exitCode = 1;
      return;
    }
    if (installed && supported) {
      console.log(chalk.green('tmux:'), version ?? '(version unknown)');
      console.log(chalk.gray(`socket: ${getDefaultSocketPath()}`));
    } else if (installed) {
      console.log(chalk.yellow('tmux:'), `${version ?? '(version unknown)'} — unsupported`);
      console.log(chalk.gray(`  agents requires tmux ${MIN_TMUX_VERSION} or newer.`));
      process.exitCode = 1;
    } else {
      console.log(chalk.yellow('tmux is not installed.'));
      console.log(chalk.gray(process.platform === 'darwin'
        ? '  Install with: brew install tmux'
        : '  Install with: apt install tmux (or your distro equivalent)'));
      process.exit(1);
    }
  });

  // ─── new ────────────────────────────────────────────────────────────────────

  const newCmd = tmux
    .command('new <name>')
    .description('Start a detached tmux session running a command. The session persists until killed.')
    .option('-c, --cmd <command>', 'Command to launch in the first pane (sh -c). Omit for an empty shell.')
    .option('-d, --cwd <dir>', 'Working directory for the first pane')
    .option('-w, --width <n>', 'Initial window width in columns (tmux clamps to client size on attach)')
    .option('-h, --height <n>', 'Initial window height in rows')
    .option('-s, --source <source>', 'Provenance label: cli|extension|teams|external', 'cli')
    .option('--label <k=v...>', 'Free-form labels (repeatable)', collectLabel, {} as Record<string, string>)
    .option('--socket <path>', 'Use a custom socket (default: shared server)')
    .option('--replace', 'Kill any existing session with the same name first')
    .option('--attach-existing', 'Return the existing session if one with this name already exists')
    .option('--json', 'Output session meta as JSON');

  setHelpSections(newCmd, {
    examples: `
      # Detached agent session
      agents tmux new claude-debug --cmd "agents run claude"

      # Reuse the session if it already exists (idempotent)
      agents tmux new pair --cmd "agents run claude" --attach-existing

      # Replace a stale session
      agents tmux new pair --cmd "agents run claude" --replace
    `,
  });

  newCmd.action(async (name, opts) => {
    await guardTmux(async () => {
      const meta = await createSession({
        name,
        cmd: opts.cmd,
        cwd: opts.cwd ? path.resolve(opts.cwd) : undefined,
        width: opts.width ? parseInt(opts.width, 10) : undefined,
        height: opts.height ? parseInt(opts.height, 10) : undefined,
        source: validateSource(opts.source),
        labels: Object.keys(opts.label).length > 0 ? opts.label : undefined,
        socket: opts.socket,
        replace: !!opts.replace,
        attachExisting: !!opts.attachExisting,
      });
      if (opts.json) {
        console.log(JSON.stringify(meta));
      } else {
        console.log(meta.name);
      }
    });
  });

  // ─── attach ─────────────────────────────────────────────────────────────────

  const attachCmd = tmux
    .command('attach <name>')
    .description('Attach to a running session. Replaces this shell with the tmux client until you detach (Ctrl-b d) or the agent exits (session is then torn down).')
    .option('--socket <path>', 'Use a custom socket (default: shared server)');

  attachCmd.action(async (name, opts) => {
    await guardTmux(async () => {
      const socket = opts.socket ?? getDefaultSocketPath();
      if (!(await hasSession(name, socket))) {
        console.error(chalk.red(`No tmux session named "${name}".`));
        process.exit(1);
      }
      if (!process.stdout.isTTY) {
        console.error(chalk.red('attach requires a TTY. Run this from an interactive shell.'));
        process.exit(1);
      }
      // Repair a legacy/stale pane-died hook before handing the session to an
      // attach client — the 5-min daemon reconcile that used to cover this was
      // deleted; attach-time repair is what closes the gap now (RUSH-2435).
      await ensureSessionHookRepaired(name, socket);
      const code = await attachTmux({ socket, args: ['attach-session', '-t', `=${name}`] });
      // The v6 pane-died hook only detach-clients when a client is attached
      // (so runInTmux can read the exit status). Attach verbs must kill the
      // husk themselves — otherwise `tmux ls` still lists the session after
      // the agent exits (PHNX-3293).
      await teardownIfAgentExited(name, socket);
      process.exit(code);
    });
  });

  // ─── list ───────────────────────────────────────────────────────────────────

  const listCmd = tmux
    .command('list')
    .alias('ls')
    .description('List live tmux sessions on the shared server (name, age, last screen line). Prunes stale meta files as a side effect.')
    .option('--socket <path>', 'Use a custom socket (default: shared server)')
    .option('--json', 'Output as JSON');

  listCmd.action(async (opts) => {
    await guardTmux(async () => {
      const sessions = await listSessions({ socket: opts.socket });
      if (sessions.length === 0) {
        if (opts.json) {
          console.log('[]');
          return;
        }
        console.log(chalk.gray('No tmux sessions.'));
        return;
      }
      const screens = await captureScreens(sessions, opts.socket);
      if (opts.json) {
        console.log(JSON.stringify(sessions.map((s) => ({
          ...s,
          preview: tmuxScreenSnippet(screens.get(s.name) ?? ''),
        }))));
        return;
      }
      for (const s of sessions) {
        const age = formatAge(Date.now() / 1000 - s.createdAtTmux);
        const attached = s.attached ? chalk.green(' [attached]') : '';
        const snippet = tmuxScreenSnippet(screens.get(s.name) ?? '');
        const preview = snippet ? chalk.gray(`  ${snippet}`) : '';
        console.log(`  ${chalk.bold(s.name)}  ${s.windows}w  ${age}${attached}${preview}`);
      }
    });
  });

  // ─── has ────────────────────────────────────────────────────────────────────

  tmux
    .command('has <name>')
    .description('Exit 0 if a session with this name exists, 1 otherwise. Useful in shell scripts.')
    .option('--socket <path>', 'Use a custom socket (default: shared server)')
    .action(async (name, opts) => {
      await guardTmux(async () => {
        const exists = await hasSession(name, opts.socket);
        process.exit(exists ? 0 : 1);
      });
    });

  // ─── split ──────────────────────────────────────────────────────────────────

  const splitCmd = tmux
    .command('split <name> <direction>')
    .description('Split the active pane of a session. Direction: h (left/right) or v (top/bottom).')
    .option('-c, --cmd <command>', 'Command to launch in the new pane')
    .option('-d, --cwd <dir>', 'Working directory for the new pane')
    .option('--socket <path>', 'Use a custom socket (default: shared server)')
    .option('--json', 'Output as JSON (returns new pane id like %3)');

  setHelpSections(splitCmd, {
    examples: `
      # Split horizontally (panes side-by-side) and start a second agent
      agents tmux split team h --cmd "agents run codex"

      # Split vertically (panes stacked) — empty shell
      agents tmux split team v
    `,
  });

  splitCmd.action(async (name, direction, opts) => {
    await guardTmux(async () => {
      if (direction !== 'h' && direction !== 'v') {
        console.error(chalk.red(`Invalid direction "${direction}". Use h or v.`));
        process.exit(1);
      }
      const paneId = await splitPane({
        name,
        direction,
        cmd: opts.cmd,
        cwd: opts.cwd ? path.resolve(opts.cwd) : undefined,
        socket: opts.socket,
      });
      if (opts.json) {
        console.log(JSON.stringify({ paneId }));
      } else {
        console.log(paneId);
      }
    });
  });

  // ─── send ───────────────────────────────────────────────────────────────────

  const sendCmd = tmux
    .command('send <target> <keys>')
    .description('Send keystrokes to a session. Target is "name" or "name:pane" (e.g. team:%2 or team:1).')
    .option('--no-enter', 'Do not append Enter after the keys')
    .option('--raw', 'Send literally (-l) without tmux key-name interpretation (C-c, Enter, etc.)')
    .option('--socket <path>', 'Use a custom socket (default: shared server)');

  setHelpSections(sendCmd, {
    examples: `
      # Type a command into the session and press Enter
      agents tmux send team "echo hello"

      # Send Ctrl-C to interrupt
      agents tmux send team "C-c"

      # Send literal text (no key-name interpretation)
      agents tmux send team "C-c" --raw

      # Target a specific pane
      agents tmux send team:%2 "ls -la"
    `,
  });

  sendCmd.action(async (target, keys, opts) => {
    await guardTmux(async () => {
      const { name, pane } = splitTarget(target);
      await sendKeys({
        name,
        pane,
        keys,
        noEnter: !opts.enter,
        raw: !!opts.raw,
        socket: opts.socket,
      });
    });
  });

  // ─── capture ────────────────────────────────────────────────────────────────

  const captureCmd = tmux
    .command('capture <target>')
    .description('Print the contents of a pane. Target is "name" or "name:pane".')
    .option('-l, --lines <n>', 'Include this many extra history lines above the visible screen')
    .option('--ansi', 'Keep ANSI escape codes (default strips them)')
    .option('--socket <path>', 'Use a custom socket (default: shared server)');

  setHelpSections(captureCmd, {
    examples: `
      # See current screen
      agents tmux capture team

      # Include the last 500 history lines
      agents tmux capture team --lines 500

      # Target a specific pane
      agents tmux capture team:%3
    `,
  });

  captureCmd.action(async (target, opts) => {
    await guardTmux(async () => {
      const { name, pane } = splitTarget(target);
      const text = await capturePane({
        name,
        pane,
        lines: opts.lines ? parseInt(opts.lines, 10) : undefined,
        ansi: !!opts.ansi,
        socket: opts.socket,
      });
      process.stdout.write(text);
      if (!text.endsWith('\n')) process.stdout.write('\n');
    });
  });

  // ─── info ───────────────────────────────────────────────────────────────────

  const infoCmd = tmux
    .command('info <name>')
    .description('Show provenance for a session (cmd, cwd, created_at, source, labels).')
    .option('--json', 'Output as JSON');

  infoCmd.action(async (name, opts) => {
    const meta = readSessionMeta(name);
    if (!meta) {
      console.error(chalk.yellow(`No meta for "${name}" (session may exist but wasn't created via agents tmux).`));
      process.exit(1);
    }
    if (opts.json) {
      console.log(JSON.stringify(meta, null, 2));
      return;
    }
    printMeta(meta);
  });

  // ─── kill ───────────────────────────────────────────────────────────────────

  const killCmd = tmux
    .command('kill [name]')
    .description('Kill one tmux session, or pick from a list that shows each pane\'s last screen. Idempotent.')
    .option('--socket <path>', 'Use a custom socket (default: shared server)');

  setHelpSections(killCmd, {
    examples: `
      # Kill by name
      agents tmux kill ag-claude-04a1307c

      # Pick from live panes — preview shows the last lines on screen
      # (trust-folder stall, weekly-limit dialog, real work)
      agents tmux kill
    `,
    notes: `
      With no name, the picker captures each pane so you can tell a leaked
      first-run dialog from an agent that is still working. Space multi-selects;
      enter kills the checked rows (or the highlighted one if none are checked).
      Ctrl-b d still keeps a live session; exiting the agent tears it down.
    `,
  });

  killCmd.action(async (name: string | undefined, opts) => {
    await guardTmux(async () => {
      if (name) {
        const killed = await killSession(name, opts.socket);
        if (!killed) {
          console.log(chalk.gray(`No session "${name}" — nothing to do.`));
        }
        return;
      }
      await pickAndKillSessions(opts.socket);
    });
  });

  // ─── kill-all ───────────────────────────────────────────────────────────────

  const killAllCmd = tmux
    .command('kill-all')
    .description('Kill every session on the shared server and remove the socket. Requires --yes.')
    .option('--yes', 'Confirm — required, no interactive prompt')
    .option('--socket <path>', 'Use a custom socket (default: shared server)');

  killAllCmd.action(async (opts) => {
    await guardTmux(async () => {
      if (!opts.yes) {
        console.error(chalk.red('Refusing to kill-all without --yes.'));
        process.exit(1);
      }
      const n = await killAll(opts.socket);
      console.log(chalk.gray(`Killed ${n} session${n === 1 ? '' : 's'}.`));
    });
  });
}

// ─── helpers ──────────────────────────────────────────────────────────────────

/** Wrap a command action so tmux-specific errors render cleanly instead of throwing. */
async function guardTmux(fn: () => Promise<void>): Promise<void> {
  try {
    assertTmuxAvailable();
    await fn();
  } catch (err) {
    if (err instanceof TmuxUnavailableError) {
      console.error(chalk.red(err.message));
      process.exit(127);
    }
    if (err instanceof TmuxSessionError) {
      console.error(chalk.red(err.message));
      process.exit(1);
    }
    if (err instanceof TmuxCommandError) {
      console.error(chalk.red(err.message));
      process.exit(err.code ?? 1);
    }
    throw err;
  }
}

/** Parse `name` or `name:pane` (pane may be `%id` or a numeric index). */
function splitTarget(target: string): { name: string; pane?: string } {
  const idx = target.indexOf(':');
  if (idx === -1) return { name: target };
  return { name: target.slice(0, idx), pane: target.slice(idx + 1) || undefined };
}

function validateSource(s: string): SessionMeta['source'] {
  if (s === 'cli' || s === 'extension' || s === 'teams' || s === 'external') return s;
  return 'cli';
}

function collectLabel(value: string, acc: Record<string, string>): Record<string, string> {
  const eq = value.indexOf('=');
  if (eq === -1) return acc;
  acc[value.slice(0, eq)] = value.slice(eq + 1);
  return acc;
}

/** Last useful line of a pane capture — what `tmux ls` shows so a name isn't a black box. */
export function tmuxScreenSnippet(raw: string, max = 72): string {
  const lines = raw
    .split('\n')
    .map((l) => l.replace(/\s+/g, ' ').trim())
    .filter((l) => l.length > 0 && !/^[─═│┃┌┐└┘╰╯╭╮\s|-]+$/.test(l) && !/enter to confirm|esc to cancel|tab:next/i.test(l));
  const tail = lines.slice(-8);
  const preferred = [...tail].reverse().find((l) =>
    /[?❯]|trust this folder|weekly limit|needs.you|waiting/i.test(l),
  );
  return truncate(preferred ?? tail[tail.length - 1] ?? '', max);
}

/** Last non-empty lines of a pane capture, for the kill-picker preview. */
export function tmuxScreenPreview(raw: string, maxLines = 16): string {
  return raw
    .split('\n')
    .map((l) => l.replace(/\s+$/, ''))
    .filter((l) => l.length > 0)
    .slice(-maxLines)
    .join('\n');
}

export function formatTmuxKillLabel(s: ListedSession, snippet: string, nowMs = Date.now()): string {
  const age = formatAge(nowMs / 1000 - s.createdAtTmux);
  const agent = s.meta?.labels?.agent;
  const bits = [s.name, age];
  if (agent) bits.push(agent);
  if (snippet) bits.push(snippet);
  return bits.join('  ');
}

export function formatTmuxKillPreview(s: ListedSession, raw: string, nowMs = Date.now()): string {
  const age = formatAge(nowMs / 1000 - s.createdAtTmux);
  const agent = s.meta?.labels?.agent;
  const header = [
    chalk.bold(s.name),
    agent ? chalk.cyan(agent) : '',
    chalk.gray(age),
    s.attached ? chalk.green('attached') : chalk.gray('detached'),
  ].filter(Boolean).join('  ');
  const meta = [
    s.meta?.cwd ? `cwd  ${s.meta.cwd}` : '',
    s.meta?.cmd ? `cmd  ${truncate(s.meta.cmd, 80)}` : '',
  ].filter(Boolean).join('\n');
  const body = tmuxScreenPreview(raw) || chalk.gray('(empty pane)');
  return [header, meta, '', chalk.gray('── last screen ──'), body].filter((line) => line !== '').join('\n');
}

async function captureScreens(sessions: ListedSession[], socket?: string): Promise<Map<string, string>> {
  const rows = await Promise.all(sessions.map(async (s) => {
    try {
      const raw = await capturePane({ name: s.name, socket, lines: 40 });
      return [s.name, raw] as const;
    } catch {
      return [s.name, ''] as const;
    }
  }));
  return new Map(rows);
}

async function pickAndKillSessions(socket?: string): Promise<void> {
  if (!isInteractiveTerminal()) {
    console.error(chalk.red('Pass a session name, or run from a TTY to pick from a list with pane previews.'));
    console.error(chalk.gray('  agents tmux ls          # names + last screen line'));
    console.error(chalk.gray('  agents tmux kill <name>'));
    process.exitCode = 1;
    return;
  }
  const sessions = await listSessions({ socket });
  if (sessions.length === 0) {
    console.log(chalk.gray('No tmux sessions.'));
    return;
  }
  const screens = await captureScreens(sessions, socket);
  let chosen: ListedSession[] | null;
  try {
    chosen = await multiItemPicker<ListedSession>({
      message: 'Kill which tmux sessions?',
      items: sessions,
      filter: (q) => {
        const needle = q.trim().toLowerCase();
        if (!needle) return sessions;
        return sessions.filter((s) => {
          const hay = [
            s.name,
            s.meta?.labels?.agent,
            s.meta?.cwd,
            s.meta?.cmd,
            screens.get(s.name),
          ].join(' ').toLowerCase();
          return hay.includes(needle);
        });
      },
      labelFor: (s) => formatTmuxKillLabel(s, tmuxScreenSnippet(screens.get(s.name) ?? '')),
      keyFor: (s) => s.name,
      buildPreview: (s) => formatTmuxKillPreview(s, screens.get(s.name) ?? ''),
      pageSize: 12,
      emptyMessage: 'No sessions match.',
      enterHint: 'kill',
    });
  } catch (err) {
    if (isPromptCancelled(err)) return;
    throw err;
  }
  if (!chosen || chosen.length === 0) return;
  for (const s of chosen) {
    const killed = await killSession(s.name, socket);
    if (killed) console.log(chalk.gray(`Killed ${s.name}`));
    else console.log(chalk.gray(`No session "${s.name}" — already gone.`));
  }
}

function formatAge(secs: number): string {
  if (secs < 60) return `${Math.max(0, Math.floor(secs))}s`;
  const m = Math.floor(secs / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}


function printMeta(m: SessionMeta): void {
  console.log(`  ${chalk.bold('name')}       ${m.name}`);
  console.log(`  ${chalk.bold('socket')}     ${m.socket}`);
  console.log(`  ${chalk.bold('createdAt')}  ${new Date(m.createdAt).toISOString()}`);
  console.log(`  ${chalk.bold('source')}     ${m.source}`);
  if (m.cwd) console.log(`  ${chalk.bold('cwd')}        ${m.cwd}`);
  if (m.cmd) console.log(`  ${chalk.bold('cmd')}        ${m.cmd}`);
  if (m.labels) {
    for (const [k, v] of Object.entries(m.labels)) {
      console.log(`  ${chalk.bold('label')}      ${k}=${v}`);
    }
  }
}
