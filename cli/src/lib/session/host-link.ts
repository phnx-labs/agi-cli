/** Host link: whether anything is still on the other end of a live session. Agent-alive signals
 * miss `host-gone` (the editor or SSH host died, leaving a stale `live-terminals.json` slice) and
 * `no-client` (the agent survived in tmux with zero clients). Both are DERIVED. */

/** How a session is connected to the client that should be driving it. */
export type HostLink =
  /** A client is attached — positively established, not assumed. */
  | 'connected'
  /** Alive, but nothing is viewing it — the host window is gone and the agent outlived it. */
  | 'no-client'
  /** The host window is gone AND the agent process died with it — an unclean exit. */
  | 'host-gone'
  /** Alive, but NO usable signal: no window owns it and it is not tmux-hosted. This used to return
   * `connected`, reading as "verified fine" when nobody looked. Bare terminals, team spawns, cloud
   * tasks and `--device` sessions land here. Callers MUST NOT render it as healthy. */
  | 'unknown';

/** How long an IDE window's registry slice may go without a refresh before it counts as gone. AGI
 * EXT republishes every 4 minutes (`KEEPALIVE_FORCE_MS`, apps/ext/src/vscode/foreman.registry.ts);
 * 10 minutes matches the extension's own GC of a peer slice. */
export const HOST_HEARTBEAT_STALE_MS = 10 * 60_000;

interface HostLinkInput {
  /** The agent process is still alive (already pid-reuse-checked by the caller). */
  pidAlive: boolean;
  /** When the owning IDE window last refreshed its live-terminals registry slice. Absent for a
   * session no IDE window owns (bare terminal, team spawn, cloud task), whose window death we
   * cannot observe. */
  windowHeartbeatMs?: number;
  /** Clients attached to this session's tmux session (`#{session_attached}`). Absent when not
   * tmux-hosted, which is NOT zero: zero means "nobody is looking", absent means "we cannot tell". */
  tmuxClients?: number;
  /** The session was deliberately backgrounded — `presence` is `background`/`parked`. */
  deliberatelyDetached?: boolean;
  nowMs?: number;
}

/** Did the owning IDE window stop republishing its registry slice? A window republishes every 4
 * minutes and `HOST_HEARTBEAT_STALE_MS` is 10, so a stale slice means gone. Shared by {@link
 * classifyHostLink} and {@link hostWindowLost} so the staleness rule has one definition. */
function windowGone(input: HostLinkInput): boolean {
  const now = input.nowMs ?? Date.now();
  return input.windowHeartbeatMs !== undefined && now - input.windowHeartbeatMs >= HOST_HEARTBEAT_STALE_MS;
}

/** Classify a live row's host link. Pure: every signal is passed in, so the decision table is
 * unit-testable without a process table, tmux server or editor. */
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

/** Did the owning IDE window die while the agent kept RUNNING? The ONE host-link loss that promotes
 * `running` to `orphaned` (PHNX-3183): a heartbeating window went stale. Narrower than
 * `no-client`: zero tmux clients is NORMAL for a detached remote pane (RUSH-3125). */
export function hostWindowLost(input: HostLinkInput): boolean {
  if (input.deliberatelyDetached) return false;
  return input.pidAlive && windowGone(input);
}
