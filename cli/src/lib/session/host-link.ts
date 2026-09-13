/**
 * Host link — whether anything is still on the other end of a live session.
 *
 * Every liveness signal the scan already has answers "is the AGENT process
 * alive". None of them answer "is anyone still driving it", and those come apart
 * in exactly the two ways a user notices:
 *
 *   - **The host program died and took the agent with it.** VS Code / the editor
 *     window crashes or the SSH connection drops, so the agent process dies with
 *     its parent, but the window never got to run its teardown — its slice of
 *     `live-terminals.json` is left behind, stale, still naming a dead pid. Today
 *     that entry is filtered out at read time, so the session simply VANISHES
 *     from `--active` instead of reporting that it fell over. That is `host-gone`.
 *
 *   - **The host program died and the agent survived it.** The agent was hosted
 *     in tmux (or otherwise reparented), so it keeps running with zero clients
 *     attached: still burning tokens, or sitting on a question nobody will ever
 *     answer, with no window anywhere showing it. That is `no-client`.
 *
 * Both are DERIVED, never asserted — from the agent pid, the owning window's
 * keepalive, and tmux's own attached-client count. A deliberately backgrounded
 * session (`agents sessions detach`) is excluded by construction: it is supposed
 * to have no client, so calling it orphaned would be a false alarm on the one
 * case the user asked for.
 */

/** How a session is connected to the client that should be driving it. */
export type HostLink =
  /** A client is attached — positively established, not assumed. */
  | 'connected'
  /** Alive, but nothing is viewing it — the host window is gone and the agent outlived it. */
  | 'no-client'
  /** The host window is gone AND the agent process died with it — an unclean exit. */
  | 'host-gone'
  /**
   * Alive, and we have NO usable signal either way — no window owns it and it is
   * not tmux-hosted, so neither input this function keys on exists.
   *
   * This case used to return `connected`, which reads as "verified fine" when the
   * truth is "nobody looked". That is the wrong default for a detector: the rows
   * it silently blesses are precisely the ones with no observer — a bare terminal,
   * a team spawn, a cloud task, or any session whose pane lives on another
   * machine (this function's inputs are all local, so a `--device` session is
   * structurally unobservable from the launching box).
   *
   * Callers MUST NOT render this as healthy. It means the question is open.
   */
  | 'unknown';

/**
 * How long an IDE window's registry slice may go without a refresh before we
 * treat that window as gone. AGI EXT force-republishes its slice
 * every 4 minutes (`KEEPALIVE_FORCE_MS` in `apps/ext/src/vscode/foreman.registry.ts`)
 * and on every terminal open/close, so a slice this old means the window is no
 * longer running — it is not merely quiet. Deliberately the same 10 minutes the
 * extension itself uses to garbage-collect a peer window's slice, so the CLI and
 * the extension agree on when a window is dead.
 */
export const HOST_HEARTBEAT_STALE_MS = 10 * 60_000;

interface HostLinkInput {
  /** The agent process is still alive (already pid-reuse-checked by the caller). */
  pidAlive: boolean;
  /**
   * When the owning IDE window last refreshed its slice of the live-terminals
   * registry. Absent for a session no IDE window owns (a bare terminal, a team
   * spawn, a cloud task) — those have no window whose death we could observe.
   */
  windowHeartbeatMs?: number;
  /**
   * Clients attached to this session's tmux session (`#{session_attached}`).
   * Absent when the session is not tmux-hosted, which is NOT the same as zero:
   * zero is a positive "nobody is looking", absent is "we cannot tell".
   */
  tmuxClients?: number;
  /** The session was deliberately backgrounded — `presence` is `background`/`parked`. */
  deliberatelyDetached?: boolean;
  nowMs?: number;
}

/**
 * Did the session's owning IDE window stop republishing its registry slice? A
 * window republishes every 4 minutes (`HOST_HEARTBEAT_STALE_MS` is 10), so a
 * slice this old means the window is gone, not merely quiet. Shared by
 * {@link classifyHostLink} and {@link hostWindowLost} so the staleness rule has
 * exactly one definition.
 */
function windowGone(input: HostLinkInput): boolean {
  const now = input.nowMs ?? Date.now();
  return input.windowHeartbeatMs !== undefined && now - input.windowHeartbeatMs >= HOST_HEARTBEAT_STALE_MS;
}

/**
 * Classify a live row's host link. Pure — every signal is passed in, so the
 * whole decision table is unit-testable without a process table, a tmux server,
 * or a running editor.
 */
export function classifyHostLink(input: HostLinkInput): HostLink {
  // A session detached on purpose has no client BY DESIGN. It is the one case
  // that looks identical to an orphan from the outside, so it is excluded first —
  // otherwise every `agents sessions detach` would raise a false alarm.
  if (input.deliberatelyDetached) return 'connected';

  const stale = windowGone(input);

  // The host window stopped keeping its registry slice alive AND the agent it
  // owned is dead: the pair went down together without teardown.
  if (stale && !input.pidAlive) return 'host-gone';

  if (!input.pidAlive) return 'connected'; // a plain dead pid is `closed`, not an orphan

  // Alive with tmux reporting zero attached clients: nobody is watching it. This
  // is the authoritative signal — tmux knows exactly how many clients it has.
  if (input.tmuxClients === 0) return 'no-client';

  // Alive, not tmux-hosted (or tmux says someone is attached), but the window
  // that owned it is gone. The agent outlived its editor.
  if (stale) return 'no-client';

  // Positive evidence of a client: tmux counted at least one attached client, or
  // a window is refreshing its registry slice. Either is a real observation.
  if (input.tmuxClients !== undefined || input.windowHeartbeatMs !== undefined) return 'connected';

  // Neither input exists, so nothing here observed anything. Say so rather than
  // reporting the healthy answer by default — see {@link HostLink}'s `unknown`.
  return 'unknown';
}

/**
 * Did the owning IDE window die while the agent kept RUNNING? This is the ONE
 * host-link loss that promotes a still-`running` session to `orphaned`
 * (PHNX-3183): a window that WAS republishing its heartbeat every 4 min went
 * stale for {@link HOST_HEARTBEAT_STALE_MS}, so it died uncleanly (a crash,
 * reboot, or dropped SSH) and the agent it hosted outlived it — genuinely
 * stranded, the "my remote agent is still alive after the laptop rebooted" case.
 *
 * Deliberately NARROWER than `no-client`. A tmux attached-client count of zero
 * is also `no-client`, but for a detached remote pane (`agents run --device`,
 * which RUSH-3125 wraps in a detached tmux session) that is the NORMAL steady
 * state between check-ins — launch, detach, return with `agents focus` — not a
 * loss. Promoting on it would relabel every unattended remote agent as
 * `orphaned`, the over-reporting that makes the word worthless. Only a lost
 * WINDOW is a positive "a client was expected and is now gone" for a running
 * agent; mere absence is not.
 *
 * A deliberately-backgrounded session is excluded exactly as
 * {@link classifyHostLink} excludes it: no client is the point of detaching.
 * Pure — same injected signals as the classifier.
 */
export function hostWindowLost(input: HostLinkInput): boolean {
  if (input.deliberatelyDetached) return false;
  return input.pidAlive && windowGone(input);
}
