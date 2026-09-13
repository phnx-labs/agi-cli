/**
 * Auto-reconnect for an interactive `agents run --device` session whose SSH link
 * dropped. ssh exit 255 triggers bounded-backoff re-attaches via the peer's own
 * `agents sessions focus <id> --local`, which joins a surviving tmux pane or
 * resumes the session in place. The retry window bounds unproductive streaks,
 * resetting when an attach reaches the host and holds the pane.
 *
 * A remote interactive session MUST be tmux-wrapped: with the wrap on, the agent
 * runs in a DETACHED tmux pane on the peer, so a blink kills only the ssh client
 * and the reattach rejoins the live pane; with it off, the agent is a child of
 * the sshd session and a blink SIGHUPs it, losing the in-flight turn (the
 * reattach then resumes the harness from disk). See lib/exec.ts `runInTmux`.
 */
import { sshExec, sshStream, shellQuote, SSH_CONN_FAILURE_CODE } from '../ssh-exec.js';
import { hostIdentityArgs, sshTargetFor, type Host } from './types.js';
import { RUN_AUTO_KEYWORD } from '../types.js';

/** ssh's connection-layer failure code — re-exported from ssh-exec.ts. */
export const SSH_CONN_FAILURE = SSH_CONN_FAILURE_CODE;

/**
 * ssh returns 255 for BOTH "couldn't connect" and "connected then dropped", so a
 * remote-origin 255 (the focus command's own exit) is remapped to 254 before the
 * reconnect loop sees it — inside the loop, 255 therefore always means a network
 * drop, never a code the remote command chose.
 */
export const REMOTE_EXIT_255_REMAPPED = 254;

/**
 * Wall-clock window bounding unproductive reconnect streaks, not the total
 * session. A reattach that reaches the host and holds resets the budget.
 */
export const RECONNECT_WINDOW_MS = 15 * 60_000;

/** Backoff curve: 2s, 4s, 8s, 16s, 30s, then 30s until the window closes. */
const BASE_BACKOFF_MS = 2_000;
const MAX_BACKOFF_MS = 30_000;

/**
 * A genuine reconnection must hold the remote pane this long before refilling
 * the retry budget. It is the minimum time to clear TTY negotiation and confirm
 * a working session, distinguishing that from an attach that reconnects and
 * immediately re-drops; otherwise a flapping link would retry forever.
 */
export const MIN_HOLD_MS = 10_000;

export interface ReconnectState {
  /** Consecutive unproductive reattaches since the last genuine reconnection. */
  attempt: number;
  /** Ms burned on the current unproductive streak; compared to the window. */
  unproductiveMs: number;
}

export interface ReconnectOutcome {
  /** Exit code of the run or last re-attach. */
  code: number;
  /** Whether the ssh handshake completed (preflight probe succeeded). */
  connected: boolean;
  /** How long the interactive attach held after the probe returned. */
  heldMs: number;
}

type ReconnectDecision =
  | { action: 'stop'; code: number }
  | { action: 'retry'; waitMs: number; state: ReconnectState; remainingMs: number };

export function initialReconnectState(): ReconnectState {
  return { attempt: 0, unproductiveMs: 0 };
}

/** Exponential backoff capped at {@link MAX_BACKOFF_MS}: 2s, 4s, 8s, 16s, 30s… */
export function backoffMs(attempt: number): number {
  return Math.min(BASE_BACKOFF_MS * 2 ** attempt, MAX_BACKOFF_MS);
}

/** True when the attempt both connected and held long enough to refill the budget. */
export function refillsBudget(outcome: ReconnectOutcome): boolean {
  return outcome.connected && outcome.heldMs >= MIN_HOLD_MS;
}

/**
 * Decide the next action from a run/re-attach outcome. Non-255 exits stop and
 * surface that code; 255 retries until the unproductive window is spent.
 */
export function reconnectStep(state: ReconnectState, outcome: ReconnectOutcome): ReconnectDecision {
  if (outcome.code !== SSH_CONN_FAILURE) return { action: 'stop', code: outcome.code };
  const productive = refillsBudget(outcome);
  const attempts = productive ? 0 : state.attempt;
  // The attach's own duration counts against the window.
  const burned = productive ? 0 : state.unproductiveMs + outcome.heldMs;
  if (burned >= RECONNECT_WINDOW_MS) return { action: 'stop', code: SSH_CONN_FAILURE };
  const waitMs = backoffMs(attempts);
  return {
    action: 'retry',
    waitMs,
    state: { attempt: attempts + 1, unproductiveMs: burned + waitMs },
    remainingMs: Math.max(0, RECONNECT_WINDOW_MS - (burned + waitMs)),
  };
}

/** "14m51s", "51s" — a duration a waiting human can read at a glance. */
export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const m = Math.floor(total / 60);
  const sec = total % 60;
  return m > 0 ? `${m}m${String(sec).padStart(2, '0')}s` : `${sec}s`;
}

/** Notice shown before each reconnect wait. */
export function reconnectNotice(target: ReconnectTarget, host: string, attempt: number, waitMs: number, remainingMs: number): string {
  const secs = Math.round(waitMs / 1000);
  const when = secs <= 1 ? 'now' : `in ${secs}s`;
  // A tmux-wrapped run is still live; a bare run was SIGHUPed and focus will
  // resume it from disk. This wording is truthful for either peer configuration.
  return `\nConnection to ${host} dropped — reconnecting to ${targetLabel(target)}.`
    + `\n  Reconnecting ${when} · ${formatDuration(remainingMs)} left · attempt ${attempt} · Ctrl-C to stop\n`;
}

/** Notice shown once the retry budget is spent on an unreachable host. */
export function exhaustedNotice(target: ReconnectTarget, host: string): string {
  return `\nCouldn't reconnect to ${host} after ${formatDuration(RECONNECT_WINDOW_MS)}. The agent may still be running — get back in when the network is back:\n${recoveryHint(target, host)}`;
}

/** Notice shown when the host reconnects but drops again within {@link MIN_HOLD_MS}. */
export function unstableNotice(target: ReconnectTarget, host: string): string {
  const secs = Math.round(MIN_HOLD_MS / 1000);
  return `\nGave up reconnecting to ${host} after ${formatDuration(RECONNECT_WINDOW_MS)} — it kept dropping again within ${secs} seconds of getting back in. The agent may still be running there; reconnect once the link is stable:\n${recoveryHint(target, host)}`;
}

/** Notice shown when a reattach ends with a remapped remote-side exit. */
export function remoteExitNotice(target: ReconnectTarget, host: string): string {
  return `\nReattach to ${targetLabel(target)} on ${host} ended (not a network drop) — get back in, or check whether it's still live:\n${recoveryHint(target, host)}`;
}

/** Notice shown when the user stops the wait with Ctrl-C. */
export function interruptedNotice(target: ReconnectTarget, host: string): string {
  return `\nStopped reconnecting to ${targetLabel(target)} on ${host}. Recover it when the link is stable:\n${recoveryHint(target, host)}`;
}

/**
 * Wrap `cmd` in `bash -lc` with an exit-code remap: 255 becomes
 * {@link REMOTE_EXIT_255_REMAPPED} so a remote-origin 255 cannot pass as ssh drop.
 */
export function wrapRemoteExitCode(cmd: string): string {
  const guarded = `${cmd}; rc=$?; [ "$rc" = "${SSH_CONN_FAILURE}" ] && rc=${REMOTE_EXIT_255_REMAPPED}; exit "$rc"`;
  return `bash -lc ${shellQuote(guarded)}`;
}

/**
 * How a dropped run is named when we go back for it.
 * `launch` ids are minted locally before the connection exists, so they survive a drop.
 */
export type ReconnectTarget =
  | { kind: 'session'; id: string }
  | { kind: 'launch'; id: string };

/** The short form shown to a human. Both kinds are uuid-shaped, so 8 chars reads the same. */
function targetLabel(target: ReconnectTarget): string {
  return target.id.slice(0, 8);
}

/**
 * The command a user can run to re-enter a session after reconnect gives up.
 * The full id is printed on its own line so it remains copyable after a drop.
 */
export function recoveryHint(target: ReconnectTarget, host: string): string {
  if (target.kind === 'session') {
    return `  Session ${target.id}\n  Resume:  agents sessions resume ${target.id}\n`;
  }
  return `  Launch ${target.id}\n  agents ssh ${host} 'agents sessions focus --launch-id ${target.id} --local'\n`
    + `  or pick it:  agents sessions --active\n`;
}

/**
 * Notice shown when an interactive remote connection ends and no auto-reconnect
 * follows. Prints the session id/handle so the user can get back in.
 */
export function connectionEndedNotice(
  target: ReconnectTarget,
  host: string,
  opts: { dropped?: boolean } = {},
): string {
  const verb = opts.dropped ? 'dropped' : 'closed';
  return `\nConnection to ${host} ${verb}.\n${recoveryHint(target, host)}`;
}

/**
 * Banner printed as an interactive `--device` run takes the TTY, so the id is
 * visible in scrollback while the connection exists.
 */
export function connectionStartedNotice(target: ReconnectTarget, host: string): string | undefined {
  if (target.kind !== 'session') return undefined;
  return `Session ${target.id} on ${host}\n  Resume later:  agents sessions resume ${target.id}\n`;
}

/**
 * The id to print as an interactive `--device` stream starts. `run auto` is
 * excluded because its forwarded id is only real when the remote picks Claude.
 */
export function startConnectionTarget(opts: {
  agent: string;
  hostSessionId?: string;
  resumeId?: string;
}): ReconnectTarget | undefined {
  if (opts.agent === RUN_AUTO_KEYWORD) return undefined;
  const id = opts.hostSessionId ?? opts.resumeId;
  return id ? { kind: 'session', id } : undefined;
}

/**
 * Decide what happens after an interactive `--device` stream returns. Auto-
 * reconnect fires on 255 unless `--raw` opted out; otherwise print recovery info.
 */
export function afterInteractiveRemoteExit(opts: {
  target?: ReconnectTarget;
  host: string;
  exitCode: number;
  /** True when auto-reconnect will take over (tmux-hosted, not `--raw`). */
  willReconnect: boolean;
}): { reconnect: boolean; notice: string | undefined } {
  if (!opts.target) return { reconnect: false, notice: undefined };
  if (opts.willReconnect) return { reconnect: true, notice: undefined };
  return {
    reconnect: false,
    notice: connectionEndedNotice(opts.target, opts.host, {
      dropped: opts.exitCode === SSH_CONN_FAILURE,
    }),
  };
}

/** Inputs the launcher has once its interactive stream has returned. */
interface ReconnectTargetInputs {
  agent: string;
  sessionId?: string;
  resolvedId?: string;
  resumeId?: string;
  launchId?: string;
}

/**
 * Choose how to name the dropped run. `launchId` is last because it is minted
 * locally before the connection exists, so it survives the drop.
 */
export function pickReconnectTarget(inputs: ReconnectTargetInputs): ReconnectTarget | undefined {
  const { agent, sessionId, resolvedId, resumeId, launchId } = inputs;
  const preferred = agent === RUN_AUTO_KEYWORD
    ? resolvedId ?? sessionId
    : sessionId ?? resolvedId;
  const id = preferred ?? resumeId;
  if (id) return { kind: 'session', id };
  return launchId ? { kind: 'launch', id: launchId } : undefined;
}

/**
 * The peer's recovery verb wrapped so a remote-origin 255 cannot masquerade as
 * a network drop. No `--attach-only`: focus resumes in place when no pane survived.
 */
export function reattachRemoteCommand(target: ReconnectTarget): string {
  const selector = target.kind === 'launch'
    ? ['--launch-id', target.id]
    : [target.id];
  const inner = ['agents', 'sessions', 'focus', ...selector, '--local', '--reconnect-reattach']
    .map(shellQuote)
    .join(' ');
  return wrapRemoteExitCode(inner);
}

/**
 * Re-attach the live remote pane by driving the peer's `agents sessions focus`.
 * A fast preflight probe decides reachability; only then do we run the
 * interactive attach/resume. Returns the exit code, connected bit, and hold time.
 */
function reattachRemoteSession(host: Host, target: ReconnectTarget): ReconnectOutcome {
  const sshTarget = sshTargetFor(host);
  const extraSshArgs = hostIdentityArgs(host);
  // Fresh (non-multiplexed) reachability probe: only a completed handshake is
  // counted as connected.
  const probe = sshExec(sshTarget, 'true', { multiplex: false, extraSshArgs });
  if (probe.code !== 0) return { code: SSH_CONN_FAILURE, connected: false, heldMs: 0 };
  // Timed from after the probe returns, so this measures only the attach itself.
  const startedAt = Date.now();
  const code = sshStream(sshTarget, reattachRemoteCommand(target), { tty: true, extraSshArgs });
  return { code, connected: true, heldMs: Date.now() - startedAt };
}

/**
 * Wait `ms`, but return early if the user interrupts.
 *
 * Installs a SIGINT handler only for the wait so Ctrl-C gives a graceful
 * "agent still running" message instead of killing the local process silently.
 */
async function waitOrInterrupt(ms: number): Promise<'elapsed' | 'interrupted'> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (how: 'elapsed' | 'interrupted') => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      process.removeListener('SIGINT', onSigint);
      resolve(how);
    };
    const onSigint = () => finish('interrupted');
    const timer = setTimeout(() => finish('elapsed'), ms);
    process.on('SIGINT', onSigint);
  });
}

interface ReconnectLoopOpts {
  host: Host;
  target: ReconnectTarget;
  /** Exit code from the initial interactive run (treated as connected). */
  initialExit: number;
  /** Test seams for the re-attach and wait. */
  reattach?: (host: Host, target: ReconnectTarget) => ReconnectOutcome;
  wait?: (ms: number) => Promise<'elapsed' | 'interrupted'>;
  write?: (s: string) => void;
}

/** Drive the reconnect loop from the initial run's outcome to a terminal code. */
export async function reconnectInteractiveSession(opts: ReconnectLoopOpts): Promise<number> {
  const write = opts.write ?? ((s: string) => process.stderr.write(s));
  const wait = opts.wait ?? waitOrInterrupt;
  const reattach = opts.reattach ?? reattachRemoteSession;

  let state = initialReconnectState();
  // The initial run connected; its hold duration doesn't matter at attempt 0.
  let outcome: ReconnectOutcome = { code: opts.initialExit, connected: true, heldMs: 0 };
  for (;;) {
    const decision = reconnectStep(state, outcome);
    if (decision.action === 'stop') {
      // Spent budget: unreachable host vs. unstable link need different messages.
      if (decision.code === SSH_CONN_FAILURE) {
        write(outcome.connected
          ? unstableNotice(opts.target, opts.host.name)
          : exhaustedNotice(opts.target, opts.host.name));
      } else if (decision.code === REMOTE_EXIT_255_REMAPPED) {
        write(remoteExitNotice(opts.target, opts.host.name));
      } else {
        // Clean detach / agent exit: still print the session handle.
        write(connectionEndedNotice(opts.target, opts.host.name));
      }
      return decision.code;
    }
    write(reconnectNotice(opts.target, opts.host.name, decision.state.attempt, decision.waitMs, decision.remainingMs));
    if (await wait(decision.waitMs) === 'interrupted') {
      // User interrupted; the agent is still running on the peer.
      write(interruptedNotice(opts.target, opts.host.name));
      return 130;
    }
    state = decision.state;
    outcome = reattach(opts.host, opts.target);
  }
}
