/**
 * `agents watchdog` — the watchdog CONSUMER (RUSH-1415).
 *
 * Runs the tick loop that ties the merged pieces together: list active sessions,
 * classify stalls, read the tail, decide (deterministic promise-without-toolcall
 * by default), run the resolver safety gate, and inject "Continue." into the EXACT
 * split — all without the Swift menu-bar. See src/lib/watchdog/runner.ts.
 *
 *   agents watchdog                    one tick, dry — prints what it WOULD nudge/skip and why
 *   agents watchdog --nudge            one tick, actually injects (explicit opt-in)
 *   agents watchdog --watch            manual poll loop (dry unless --nudge)
 *   agents watchdog --json             machine-readable tick output (for the menu-bar)
 *   agents watchdog enable|disable             turn the device-local daemon pass on/off
 *   agents watchdog policy <id> <p>    per-session policy: off | keep | handsoff
 *
 * The agents daemon is the sole automatic watchdog scheduler. The menu bar reads
 * persisted state; it never runs a tick.
 */

import type { Command } from 'commander';
import chalk from 'chalk';
import * as path from 'path';
import { setHelpSections } from '../lib/help.js';
import { parseDuration } from '../lib/hooks/cache.js';
import { getRuntimeStateDir } from '../lib/state.js';
import { getConfigValue, setConfigValue } from '../lib/device-config.js';
import type { ActiveSession } from '../lib/session/active.js';
import {
  writePolicySentinel,
  DEFAULT_THRESHOLDS,
  type WatchdogPolicy,
  type WatchdogThresholds,
  type WatchdogTickResult,
  type SessionOutcome,
} from '../lib/watchdog/runner.js';
import { isWatchdogRotateEnabled, listRotateStates, setWatchdogRotateEnabled } from '../lib/watchdog/rotate.js';
import { loadWatchdogSessions, runWatchdogPass } from '../lib/watchdog/service.js';
import { readWatchdogEvents, WATCHDOG_LOG_PATH } from '../lib/watchdog/log.js';
import { selectWatchdogHistory } from '../lib/watchdog/history.js';
import { sessionHeadline } from '../lib/session/title.js';

/** Default state dir the runner and these subcommands share. */
function stateDir(): string {
  return path.join(getRuntimeStateDir(), 'watchdog');
}

/**
 * (Re)load the daemon so a just-changed routine takes effect without a restart.
 * Best-effort: enabling starts the daemon if it is not running, then SIGHUPs it.
 * Dynamic import keeps daemon.ts's heavy deps off the watchdog command's load path.
 */
async function reloadDaemonForRoutine(startIfStopped: boolean): Promise<void> {
  const { isDaemonRunning, ensureDaemonStarted, signalDaemonReload } = await import('../lib/daemon/daemon.js');
  if (isDaemonRunning()) {
    signalDaemonReload();
    return;
  }
  if (startIfStopped) ensureDaemonStarted();
}

/** Parse a duration flag ("60s", "5m", "1h") to ms, or fall back to `fallbackMs`. */
function durationMsOr(raw: string | undefined, fallbackMs: number): number {
  if (raw === undefined) return fallbackMs;
  const secs = parseDuration(raw);
  return secs === null ? fallbackMs : secs * 1000;
}

function humanMs(ms: number): string {
  if (ms >= 3600_000) return `${Math.round(ms / 3600_000)}h`;
  if (ms >= 60_000) return `${Math.round(ms / 60_000)}m`;
  return `${Math.round(ms / 1000)}s`;
}

/** Render one tick's outcomes as a human status block. */
function elapsedLabel(atMs: number, eventMs: number): string {
  const seconds = Math.max(0, Math.round((atMs - eventMs) / 1000));
  if (seconds < 60) return `${seconds} second${seconds === 1 ? '' : 's'} ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'} ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  const days = Math.round(hours / 24);
  return `${days} day${days === 1 ? '' : 's'} ago`;
}

function isAttentionOutcome(outcome: SessionOutcome): boolean {
  return !outcome.sessionId
    || outcome.lastActivityMs === undefined
    || outcome.stall === 'stalled'
    || outcome.decision !== 'skip'
    || outcome.injected === true
    || outcome.addressable === false
    || outcome.rotatePhase === 'failed';
}

export function formatWatchdogTickLines(
  result: WatchdogTickResult,
  willInject: boolean,
  verbose = false,
): string[] {
  const { counts } = result;
  const mode = willInject ? 'nudge' : 'dry';
  const lines = [
    `watchdog ${mode} · checked ${new Date(result.atMs).toLocaleString()} · ` +
      `${counts.total} live · ${counts.stalled} stalled · ` +
      `${counts.nudged} nudged · ${counts.unaddressable} un-addressable` +
      (counts.rotating > 0 ? ` · ${counts.rotating} rotating` : ''),
  ];
  const visible = verbose ? result.outcomes : result.outcomes.filter(isAttentionOutcome);
  for (const o of visible) {
    const tag =
      o.injected ? 'NUDGED'
      : o.decision === 'rotate' ? (o.rotatePhase === 'failed' ? 'ROTATE-FAIL' : 'ROTATE')
      : o.addressable === false ? 'FLAGGED'
      : o.decision === 'nudge' ? 'WOULD-NUDGE'
      : 'skip';
    const id = o.sessionId?.slice(0, 8) ?? 'no-session-id';
    // `name` is the `agents run --name` launch handle — a user-given name, so it
    // ranks with the label; everything below it is the shared headline ladder.
    const title = o.label || o.name || sessionHeadline(o);
    lines.push(`  ${tag.padEnd(11)} ${id}${title ? ` · ${title}` : ''}`);
    const metadata = [
      o.kind,
      o.host,
      o.machine ?? 'local',
      o.project ?? (o.cwd ? path.basename(o.cwd) : undefined),
      o.activity ?? o.status,
      o.origin === 'routine' ? `routine ${o.routineName ?? 'unknown'}` : undefined,
      o.owner ? `owner ${o.owner}` : undefined,
      o.startedAtMs ? `started ${elapsedLabel(result.atMs, o.startedAtMs)}` : undefined,
      o.lastActivityMs ? `activity ${elapsedLabel(result.atMs, o.lastActivityMs)}` : undefined,
      o.rail ? `rail ${o.rail}` : undefined,
    ].filter((value): value is string => Boolean(value));
    lines.push(`    ${metadata.join(' · ')}`);
    if (o.cwd) lines.push(`    cwd ${o.cwd}`);
    if (o.preview) lines.push(`    latest ${o.preview.replace(/\s+/g, ' ').slice(0, 140)}`);
    lines.push(`    reason ${o.reason}`);
  }
  const omitted = result.outcomes.length - visible.length;
  if (omitted > 0) lines.push(`  ${omitted} healthy/non-actionable session${omitted === 1 ? '' : 's'} omitted · use --verbose or --json to inspect all`);
  return lines;
}

function printTick(result: WatchdogTickResult, willInject: boolean, verbose: boolean): void {
  for (const line of formatWatchdogTickLines(result, willInject, verbose)) console.log(line);
}

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Register the `agents watchdog` command tree. */
export function registerWatchdogCommand(program: Command): void {
  const cmd = program
    .command('watchdog')
    .description('Auto-nudge stalled agent terminals: detect stalls, resolve the exact split, inject "Continue." — no menu-bar needed.')
    .option('--nudge', 'Actually inject (default is a dry run that only reports what it would do)')
    .option('--watch', 'Manual poll loop: run a tick every --interval (dry unless --nudge; the always-on path is `watchdog enable`)')
    .option('--interval <dur>', 'Poll interval in --watch mode (e.g. 30s, 1m)', '30s')
    .option('--stall <dur>', 'Idle time before a session counts as stalled', humanMs(DEFAULT_THRESHOLDS.stallMs))
    .option('--cooldown <dur>', 'Minimum time between nudges to the same session', humanMs(DEFAULT_THRESHOLDS.cooldownMs))
    .option('--dormant <dur>', 'Idle time after which a session is left alone (dormant)', humanMs(DEFAULT_THRESHOLDS.dormantMs))
    .option('--text <text>', 'Nudge text delivered into the terminal', 'Continue.')
    .option('--smart-agent <agent>', 'Agent the watchdog decider runs as', 'claude')
    .option('--allow-ghostty-focus', 'Permit the coarse, focus-stealing Ghostty path (off by default)')
    .option('--verbose', 'Show healthy and non-actionable session inspections too')
    .option('--json', 'Emit the tick result as JSON (for the menu-bar / scripts)')
    .action(async (opts) => {
      const thresholds: WatchdogThresholds = {
        stallMs: durationMsOr(opts.stall, DEFAULT_THRESHOLDS.stallMs),
        cooldownMs: durationMsOr(opts.cooldown, DEFAULT_THRESHOLDS.cooldownMs),
        dormantMs: durationMsOr(opts.dormant, DEFAULT_THRESHOLDS.dormantMs),
      };
      // Injection gate: --nudge is the explicit opt-in to actually inject. Bare
      // `agents watchdog` (and `--watch` without `--nudge`) is dry. The always-on
      // path is the daemon-owned pass. Device config is its on/off switch; this
      // explicit command still requires --nudge before it can inject.
      const computeWillInject = (): boolean => opts.nudge === true;

      const tickOnce = async (willInject: boolean, sessions: ActiveSession[]): Promise<WatchdogTickResult> =>
        runWatchdogPass({
          nudge: willInject,
          nudgeText: opts.text,
          smartAgent: opts.smartAgent,
          thresholds,
          allowGhosttyFocus: opts.allowGhosttyFocus === true,
          sessions,
        });

      // RUSH-2062: share the daemon-warmed local active-session snapshot with
      // menubar/CLI/Factory instead of re-running a full gather every tick.
      if (!opts.watch) {
        const willInject = computeWillInject();
        const sessions = await loadWatchdogSessions();
        const result = await tickOnce(willInject, sessions);
        if (opts.json) console.log(JSON.stringify(result, null, 2));
        else printTick(result, willInject, opts.verbose === true);
        return;
      }

      // Manual poll loop for ad-hoc use; the daemon owns the automatic cadence.
      const intervalMs = durationMsOr(opts.interval, 30_000);
      if (!computeWillInject() && !opts.json) {
        console.log(chalk.yellow(
          `watchdog --watch is DETECT-ONLY. Pass --nudge to inject, ` +
          `or run 'agents watchdog enable' for the daemon-owned pass.`,
        ));
      }
      // eslint-disable-next-line no-constant-condition
      while (true) {
        // Re-evaluated each tick: picks up enable/disable flips mid-run.
        const willInject = computeWillInject();
        const sessions = await loadWatchdogSessions();
        const result = await tickOnce(willInject, sessions);
        if (opts.json) console.log(JSON.stringify(result));
        else printTick(result, willInject, opts.verbose === true);
        await sleep(intervalMs);
      }
    });

  setHelpSections(cmd, {
    examples: `
      # One tick, dry — see what it WOULD nudge and why (safe, no injection)
      agents watchdog

      # One tick, actually inject "Continue." into stalled+addressable splits
      agents watchdog --nudge

      # Manual watch loop every 30s, tighter stall threshold (ad-hoc; dry unless --nudge)
      agents watchdog --watch --nudge --interval 30s --stall 60s --cooldown 5m

      # Machine-readable for the menu-bar
      agents watchdog --json

      # Turn on the daemon-owned watchdog pass (every three minutes)
      agents watchdog enable

      # Show device enablement, rotate config, and in-flight rotates
      agents watchdog status

      # Show what Watchdog decided and acted on during the last day
      agents watchdog history --since 24h

      # Follow one session's Watchdog decisions
      agents watchdog history <sessionId>

      # Leave one session detected-but-untouched
      agents watchdog policy <sessionId> handsoff

      # Opt out of in-place rotate only (nudging stays on)
      agents watchdog rotate off
    `,
    notes: `
      Decision path: the watchdog is an AGENT, not a heuristic script. Every idle
      session on this machine (its task + transcript tail) is handed to ONE
      'agents run --mode plan' call per tick, which judges each: idle-but-unfinished
      (was given a task, went quiet, not finished/handed off) -> NUDGE that drives
      it to finish; idle-and-done or genuinely-needs-human -> SKIP. The agent is a
      customizable 'watchdog' workflow (drop a WORKFLOW.md in project/user
      workflows/ to override the prompt + model); absent one, the built-in prompt
      runs. Nothing is nudged when nothing is idle (no agent is spawned).

      Delivery (answer-router): a running agent is steered via its mailbox; a
      parked-on-question agent is answered into its EXACT split -- tmux / iTerm /
      an IDE integrated terminal (VS Codium / Cursor / VS Code) -- or re-entered
      via resume when headless. A parked agent with no addressable rail (e.g.
      Ghostty with no tmux) is flagged for the menu-bar and SKIPPED -- never a
      guessed or frontmost target.

      Rotate: a stalled session whose tail shows a HARD account limit ("You've
      hit your weekly limit - resets ...") is ROTATED IN PLACE instead of nudged:
      the tick gates on the same healthy-account selection 'agents run auto'
      makes (zero healthy -> one skip event per cooldown window, terminal
      untouched), injects the harness's exit sequence, relaunches
      'agents run auto --interactive --session-id <uuid>' in the SAME tab, waits
      (bounded, 60s) for the new TUI, then injects the resume replay for the old
      session. On timeout the session is flagged and never blind-typed into; the
      flag says the terminal may sit at a bare shell and needs a manual
      'agents run auto'. A failed rotate is suppressed for 15m before retry.
      Default ON; disable with 'agents watchdog rotate off' (writes
      'watchdog.rotate: off' to ~/.agents/agents.yaml; nudging stays on).
      State machine: ~/.agents/.cache/state/watchdog/rotate/<sessionId>.json.

      Always-on: 'agents watchdog enable' enables one daemon-owned pass every three
      minutes on this device and reloads the daemon; 'off' disables it here.
      Defaults OFF. Per-session policy: off (ignore), keep (default), handsoff
      (detect + flag).

      State (tray-readable): ${path.join('~/.agents/.cache/state/watchdog', '{nudges,flags,last-tick}.json')}
    `,
  });

  // --- always-on enable/disable/status (backed by the daemon routine) --------

  const turnOn = async (): Promise<void> => {
      setConfigValue('watchdog.enabled', true);
      await reloadDaemonForRoutine(true);
      console.log(chalk.green('watchdog: ON on this device (every 3 minutes)'));
  };
  const turnOff = async (): Promise<void> => {
      setConfigValue('watchdog.enabled', false);
      await reloadDaemonForRoutine(false);
      console.log(chalk.yellow('watchdog: OFF on this device'));
  };

  cmd.command('enable')
    .alias('on')
    .description('Enable the daemon watchdog pass on this device.')
    .action(async () => {
      await turnOn();
    });

  cmd.command('disable')
    .alias('off')
    .description('Disable the daemon watchdog pass on this device.')
    .action(async () => {
      await turnOff();
    });

  cmd.command('rotate <state>')
    .description(
      'Turn in-place rotate of rate-limited sessions on|off (watchdog.rotate in agents.yaml). ' +
      'Rotate-only: nudging stays on — unlike `watchdog disable`, which disables the whole watchdog on this device.',
    )
    .action((state: string) => {
      const s = state.toLowerCase();
      if (s !== 'on' && s !== 'off') {
        console.error(chalk.red(`invalid state '${state}'. Use: on | off`));
        process.exitCode = 1;
        return;
      }
      setWatchdogRotateEnabled(s === 'on');
      console.log(
        `watchdog: rotate ${s === 'on' ? chalk.green('ON') : chalk.yellow('OFF')} ` +
        chalk.dim(`(watchdog.rotate: ${s} in agents.yaml)`),
      );
    });

  cmd.command('status')
    .description('Show whether the daemon watchdog pass is enabled and where state is written.')
    .option('--json', 'Emit status as JSON (for the menu-bar / scripts)')
    .action((_opts, command) => {
      // The parent `watchdog` command also declares --json and greedily parses it
      // before dispatching here, so `watchdog status --json` lands the flag on the
      // parent, not this subcommand. optsWithGlobals() merges both levels, so we
      // read it correctly regardless of which command commander bound it to.
      const json = command.optsWithGlobals().json === true;
      const on = getConfigValue('watchdog.enabled').value === true;
      const rotate = isWatchdogRotateEnabled() ? 'on' : 'off';
      const rotates = listRotateStates(stateDir());
      const inflight = rotates.filter((r) => r.phase !== 'done' && r.phase !== 'failed');
      if (json) {
        console.log(JSON.stringify({
          enabled: on,
          cadenceMs: 180_000,
          stateDir: stateDir(),
          rotate,
          rotates: rotates.map((r) => ({
            sessionId: r.sessionId,
            newSessionId: r.newSessionId,
            agent: r.agent,
            phase: r.phase,
            updatedAtMs: r.updatedAtMs,
            error: r.error,
          })),
        }));
        return;
      }
      console.log(`always-on watchdog: ${on ? chalk.green('ON') : chalk.dim('off')} (every 3 minutes on this device)`);
      console.log(`rotate: ${rotate === 'on' ? chalk.green('on') : chalk.yellow('off')} (watchdog.rotate in agents.yaml) · ${inflight.length} in-flight`);
      for (const r of inflight) {
        console.log(`  ${chalk.magenta(r.phase.padEnd(12))} ${chalk.bold(r.sessionId.slice(0, 8))} → ${r.newSessionId.slice(0, 8)}${r.error ? chalk.red(`  ${r.error}`) : ''}`);
      }
      console.log(`state dir: ${chalk.dim(stateDir())}`);
      console.log(`history: ${chalk.dim('agents watchdog history')}`);
    });

  cmd.command('history [sessionId]')
    .description('Show persisted Watchdog decisions and actions, newest first.')
    .option('--limit <count>', 'Maximum events to show', '50')
    .option('--since <duration>', 'Only events within a duration such as 2h or 7d')
    .option('--all', 'Include heartbeat tick events')
    .option('--json', 'Emit safe structured history (transcript content is excluded)')
    .action((sessionId: string | undefined, opts, command) => {
      const globals = command.optsWithGlobals();
      const limit = Number.parseInt(opts.limit, 10);
      if (!Number.isInteger(limit) || limit < 1) {
        throw new Error('--limit must be a positive integer');
      }
      const sinceSeconds = opts.since === undefined ? undefined : parseDuration(opts.since);
      if (sinceSeconds !== undefined && (sinceSeconds === null || sinceSeconds <= 0)) {
        throw new Error('--since must be a positive duration such as 2h or 7d');
      }
      const sinceMs = sinceSeconds == null ? undefined : sinceSeconds * 1000;
      const entries = selectWatchdogHistory(readWatchdogEvents(), {
        limit,
        sinceMs,
        sessionId,
        includeTicks: opts.all === true,
      });
      if (globals.json === true) {
        console.log(JSON.stringify({ logPath: WATCHDOG_LOG_PATH, events: entries }, null, 2));
        return;
      }
      if (entries.length === 0) {
        console.log(chalk.dim(`No Watchdog events found in ${WATCHDOG_LOG_PATH}`));
        return;
      }
      for (const entry of entries) {
        const when = new Date(entry.ts).toLocaleString();
        const session = entry.sessionId ? entry.sessionId.slice(0, 8) : '-';
        const reason = entry.reason ? ` · ${entry.reason}` : '';
        console.log(`${chalk.dim(when)}  ${entry.kind.padEnd(8)}  ${chalk.bold(session)}  ${entry.agent ?? '-'}  ${entry.message}${reason}`);
      }
      console.log(chalk.dim(`${entries.length} event${entries.length === 1 ? '' : 's'} · ${WATCHDOG_LOG_PATH}`));
    });

  // --- per-session policy ----------------------------------------------------

  cmd.command('policy <sessionId> <policy>')
    .description('Set per-session policy: off (ignore) | keep (default) | handsoff (detect + flag, never inject).')
    .action((sessionId: string, policy: string) => {
      const p = policy.toLowerCase();
      if (p !== 'off' && p !== 'keep' && p !== 'handsoff') {
        console.error(chalk.red(`invalid policy '${policy}'. Use: off | keep | handsoff`));
        process.exitCode = 1;
        return;
      }
      writePolicySentinel(stateDir(), sessionId, p as WatchdogPolicy);
      console.log(`watchdog: session ${chalk.bold(sessionId.slice(0, 8))} policy = ${chalk.cyan(p)}`);
    });
}
