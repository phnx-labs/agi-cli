import { describe, it, expect } from 'vitest';
import { foldHostLink, type ActiveSession } from './active';
import { isAwaitingUser } from '../../commands/ps-roster.js';
import { HOST_HEARTBEAT_STALE_MS } from './host-link';

const staleWindow = Date.now() - HOST_HEARTBEAT_STALE_MS - 1;
const freshWindow = Date.now() - 30_000;

function row(over: Partial<ActiveSession>): ActiveSession {
  return { context: 'terminal', kind: 'claude', status: 'idle', ...over };
}

/** `foldHostLink` changes what the status column shows when a host is lost, so these tests are
 * about precedence: new statuses replace exactly what they improve on. Over-reporting would make
 * the feature worthless: if every headless run says "orphan", users ignore the word. */
describe('foldHostLink status precedence', () => {
  it('turns a dead agent under a dead window into `crashed` instead of a bare `closed`', () => {
    const rows = [row({ status: 'closed', windowHeartbeatMs: staleWindow })];
    foldHostLink(rows);
    expect(rows[0].status).toBe('crashed');
    expect(rows[0].hostLink).toBe('host-gone');
  });

  it('leaves an ordinary close as `closed` — the window is alive and just had not republished', () => {
    const rows = [row({ status: 'closed', windowHeartbeatMs: freshWindow })];
    foldHostLink(rows);
    expect(rows[0].status).toBe('closed');
  });

  it('turns an idle session with nothing attached into `orphaned`', () => {
    const rows = [row({ status: 'idle', tmuxClients: 0 })];
    foldHostLink(rows);
    expect(rows[0].status).toBe('orphaned');
    expect(rows[0].hostLink).toBe('no-client');
  });

  it('turns a session WAITING on input with nothing attached into `orphaned` — nobody is coming', () => {
    const rows = [row({ status: 'input_required', tmuxClients: 0 })];
    foldHostLink(rows);
    expect(rows[0].status).toBe('orphaned');
  });

  it('leaves a WORKING session alone with zero tmux clients — a detached remote pane is normal', () => {
    // SES-18a: a running row is not promoted on client absence alone. RUSH-3125 wraps every remote
    // interactive run in a detached pane, so zero clients is the normal steady state; promoting it
    // was the false positive reverted in 6d973b823. Only a lost WINDOW promotes a running agent.
    const rows = [row({ status: 'running', tmuxClients: 0 })];
    foldHostLink(rows);
    expect(rows[0].status).toBe('running');
    // The link is still recorded, so a consumer can see it; only the status is untouched.
    expect(rows[0].hostLink).toBe('no-client');
  });

  it('promotes a WORKING session to `orphaned` when its owning window was LOST', () => {
    // PHNX-3183: the genuinely stranded case: an IDE window that was republishing its heartbeat
    // went stale (crash, reboot, SSH drop) while the agent outlived it in tmux. A client was
    // expected and is gone, so it is flagged.
    const rows = [row({ status: 'running', windowHeartbeatMs: staleWindow })];
    foldHostLink(rows);
    expect(rows[0].status).toBe('orphaned');
    expect(rows[0].hostLink).toBe('no-client');
  });

  it('leaves a WORKING session alone while its owning window is still fresh', () => {
    // A live window republishing its slice is positive evidence of a client —
    // `connected`, never orphaned, even with no tmux count.
    const rows = [row({ status: 'running', windowHeartbeatMs: freshWindow })];
    foldHostLink(rows);
    expect(rows[0].status).toBe('running');
    expect(rows[0].hostLink).toBe('connected');
  });

  it('leaves a blind WORKING session as `running` — no signal is not a loss', () => {
    // No window heartbeat and no tmux count -> `unknown`. A running agent with no
    // observer (a bare terminal, a --device pane on another box) must stay
    // running, never orphaned by default.
    const rows = [row({ status: 'running' })];
    foldHostLink(rows);
    expect(rows[0].status).toBe('running');
    expect(rows[0].hostLink).toBe('unknown');
  });

  it('does not orphan a deliberately-detached running session even when its window is stale', () => {
    // A backgrounded session is supposed to have no window driving it; a stale
    // heartbeat there is expected, not a loss. `hostWindowLost` excludes it.
    const rows = [row({ status: 'running', windowHeartbeatMs: staleWindow, presence: 'background' })];
    foldHostLink(rows);
    expect(rows[0].status).toBe('running');
    expect(rows[0].hostLink).toBe('connected');
  });

  it('does not promote anything when the link is merely unknown', () => {
    // No window heartbeat and no tmux client count -> `unknown`, which is not a
    // loss signal and must never move a status.
    const rows = [row({ context: 'terminal', status: 'idle' })];
    foldHostLink(rows);
    expect(rows[0].status).toBe('idle');
    expect(rows[0].hostLink).toBe('unknown');
  });

  it('keeps a derived `attached` presence when the link is merely unknown', () => {
    // A bare terminal the user is sitting in has neither input, so it classifies
    // `unknown`. Clearing presence there would strip the marker from every
    // plain-terminal session — only a POSITIVE loss signal may do that.
    const rows = [row({ context: 'terminal', status: 'running', presence: 'attached' })];
    foldHostLink(rows);
    expect(rows[0].presence).toBe('attached');
  });

  it('leaves a deliberately detached session alone — no client is the point of detaching', () => {
    const rows = [row({ status: 'idle', tmuxClients: 0, presence: 'background' })];
    foldHostLink(rows);
    expect(rows[0].status).toBe('idle');
    expect(rows[0].hostLink).toBe('connected');
  });

  it('lets `abandoned` win outright and claims no host link for it', () => {
    const rows = [row({ status: 'abandoned', tmuxClients: 0, windowHeartbeatMs: staleWindow })];
    foldHostLink(rows);
    expect(rows[0].status).toBe('abandoned');
    expect(rows[0].hostLink).toBeUndefined();
  });

  it('skips cloud rows — they have no local pid, window, or tmux server to lose', () => {
    const rows = [row({ context: 'cloud', status: 'idle' })];
    foldHostLink(rows);
    expect(rows[0].status).toBe('idle');
    expect(rows[0].hostLink).toBeUndefined();
  });

  it('leaves a healthy attached session untouched', () => {
    const rows = [row({ status: 'idle', tmuxClients: 1, windowHeartbeatMs: freshWindow })];
    foldHostLink(rows);
    expect(rows[0].status).toBe('idle');
    expect(rows[0].hostLink).toBe('connected');
  });
});

describe('foldHostLink presence honesty', () => {
  it('drops the derived `attached` presence when the host is gone — nobody is watching it', () => {
    const rows = [row({ status: 'closed', windowHeartbeatMs: staleWindow, presence: 'attached' })];
    foldHostLink(rows);
    expect(rows[0].status).toBe('crashed');
    expect(rows[0].presence).toBeUndefined();
  });

  it('keeps a STORED detach record intact — only the derived `attached` is cleared', () => {
    const rows = [row({ status: 'idle', tmuxClients: 0, presence: 'parked' })];
    foldHostLink(rows);
    expect(rows[0].presence).toBe('parked');
  });
});

/** `foldHostLink` rewrites `input_required` to `orphaned`, which hid the session from consumers
 * keyed on that status (`--waiting`, its exit code). A session waiting on a question with nobody
 * watching is what they exist for, so the predicate reads `activity`. */
describe('a lost host does not hide a session that needs a human', () => {
  it('still counts as awaiting after the fold turns it orphaned', () => {
    const rows = [row({ status: 'input_required', activity: 'waiting_input', tmuxClients: 0 })];
    foldHostLink(rows);
    expect(rows[0].status).toBe('orphaned');
    expect(isAwaitingUser(rows[0])).toBe(true);
  });

  it('a plain waiting session is unaffected', () => {
    const rows = [row({ status: 'input_required', activity: 'waiting_input', tmuxClients: 1 })];
    foldHostLink(rows);
    expect(rows[0].status).toBe('input_required');
    expect(isAwaitingUser(rows[0])).toBe(true);
  });

  it('a DEAD session that died mid-question is not awaiting — it needs a relaunch, not an answer', () => {
    // `activity` is never rewritten, so a session that crashed while asking keeps
    // `waiting_input` forever. `--waiting` is a scriptable "does anything need
    // me?" gate; answering a corpse is not something a human can do.
    const rows = [row({ status: 'closed', activity: 'waiting_input', windowHeartbeatMs: staleWindow })];
    foldHostLink(rows);
    expect(rows[0].status).toBe('crashed');
    expect(isAwaitingUser(rows[0])).toBe(false);
  });

  // `abandoned` fires on transcript staleness BEFORE the liveness check, so it
  // is the one dangling status that can still be a live, answerable process.
  it('still counts a LIVE abandoned session that is mid-question — forgotten, not gone', () => {
    const rows = [row({ status: 'abandoned', activity: 'waiting_input', pidAlive: true })];
    foldHostLink(rows);
    expect(isAwaitingUser(rows[0])).toBe(true);
  });

  it('does not count an abandoned session whose process is gone', () => {
    const rows = [row({ status: 'abandoned', activity: 'waiting_input', pidAlive: false })];
    foldHostLink(rows);
    expect(isAwaitingUser(rows[0])).toBe(false);
  });

  it('does not count an abandoned session of unknown liveness — no invented human', () => {
    // An older peer sends no `pidAlive`; claiming someone can answer would be a
    // guess, and this gate drives a non-zero exit.
    const rows = [row({ status: 'abandoned', activity: 'waiting_input' })];
    foldHostLink(rows);
    expect(isAwaitingUser(rows[0])).toBe(false);
  });

  it('an orphaned IDLE session is not awaiting — it is stranded, not blocked on you', () => {
    const rows = [row({ status: 'idle', activity: 'idle', tmuxClients: 0 })];
    foldHostLink(rows);
    expect(rows[0].status).toBe('orphaned');
    expect(isAwaitingUser(rows[0])).toBe(false);
  });
});
