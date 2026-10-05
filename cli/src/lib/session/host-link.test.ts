import { describe, expect, it } from 'vitest';
import { classifyHostLink, hostWindowLost, HOST_HEARTBEAT_STALE_MS } from './host-link.js';

const NOW = 1_700_000_000_000;
const fresh = NOW - 30_000;
const stale = NOW - HOST_HEARTBEAT_STALE_MS - 1;

/** The decision table behind the `crashed` / `orphaned` statuses. Each case is a real user
 * scenario; the classifier must never cry wolf on a healthy session nor stay silent on one that
 * lost its human. */
describe('classifyHostLink', () => {
  it('reports a healthy session as connected', () => {
    expect(classifyHostLink({ pidAlive: true, windowHeartbeatMs: fresh, nowMs: NOW })).toBe('connected');
    expect(classifyHostLink({ pidAlive: true, tmuxClients: 1, nowMs: NOW })).toBe('connected');
  });

  it('calls a dead agent under a dead window `host-gone` — VS Code crashed and took it down', () => {
    expect(classifyHostLink({ pidAlive: false, windowHeartbeatMs: stale, nowMs: NOW })).toBe('host-gone');
  });

  it('does NOT call an ordinary close a crash — the window is still alive and republishing', () => {
    expect(classifyHostLink({ pidAlive: false, windowHeartbeatMs: fresh, nowMs: NOW })).toBe('connected');
    // No window at all (a bare terminal / team spawn): a dead pid is just closed.
    expect(classifyHostLink({ pidAlive: false, nowMs: NOW })).toBe('connected');
  });

  it('calls a live agent with zero tmux clients `no-client`', () => {
    expect(classifyHostLink({ pidAlive: true, tmuxClients: 0, nowMs: NOW })).toBe('no-client');
  });

  it('calls a live agent whose owning window stopped republishing `no-client`', () => {
    expect(classifyHostLink({ pidAlive: true, windowHeartbeatMs: stale, nowMs: NOW })).toBe('no-client');
  });

  it('never flags a deliberately detached session — it is supposed to have no client', () => {
    expect(
      classifyHostLink({ pidAlive: true, tmuxClients: 0, deliberatelyDetached: true, nowMs: NOW }),
    ).toBe('connected');
    expect(
      classifyHostLink({ pidAlive: false, windowHeartbeatMs: stale, deliberatelyDetached: true, nowMs: NOW }),
    ).toBe('connected');
  });

  it('treats an unknown client count as unknown, not as zero', () => {
    // A tmux server too old to report `session_attached` (or a parse miss) must not read as
    // "nobody is attached" and orphan every tmux session; an absent count is never `no-client`.
    // RUSH-3125: the non-orphan case is `unknown`, not `connected`.
    const link = classifyHostLink({ pidAlive: true, tmuxClients: undefined, nowMs: NOW });
    expect(link).not.toBe('no-client');
    expect(link).toBe('unknown');
  });

  // RUSH-3125. This case used to return `connected`, reading as "verified fine" when nobody
  // looked. No signal exists for a bare terminal, team spawn, cloud task or a session whose pane
  // lives on another machine; every input here is local.
  it('says `unknown` when it has no signal at all, rather than defaulting to healthy', () => {
    expect(classifyHostLink({ pidAlive: true, nowMs: NOW })).toBe('unknown');
  });

  it('still says `connected` on POSITIVE evidence, not on absence', () => {
    // A counted client, or a window that is republishing, is a real observation.
    expect(classifyHostLink({ pidAlive: true, tmuxClients: 2, nowMs: NOW })).toBe('connected');
    expect(classifyHostLink({ pidAlive: true, windowHeartbeatMs: fresh, nowMs: NOW })).toBe('connected');
  });

  it('a deliberate detach still wins over `unknown` — no signal is not a false alarm either way', () => {
    expect(classifyHostLink({ pidAlive: true, deliberatelyDetached: true, nowMs: NOW })).toBe('connected');
  });

  it('holds at the exact staleness boundary', () => {
    const atBoundary = NOW - HOST_HEARTBEAT_STALE_MS;
    expect(classifyHostLink({ pidAlive: true, windowHeartbeatMs: atBoundary, nowMs: NOW })).toBe('no-client');
    expect(classifyHostLink({ pidAlive: true, windowHeartbeatMs: atBoundary + 1, nowMs: NOW })).toBe('connected');
  });
});

/** `hostWindowLost` is the NARROW promotion signal (PHNX-3183): true only when a running agent's
 * owning window went stale, never on mere client absence, so a running orphan is flagged without
 * the reverted zero-clients false positive. */
describe('hostWindowLost', () => {
  it('is true only when a live agent lost a window that WAS republishing', () => {
    expect(hostWindowLost({ pidAlive: true, windowHeartbeatMs: stale, nowMs: NOW })).toBe(true);
  });

  it('is false while the window is still fresh', () => {
    expect(hostWindowLost({ pidAlive: true, windowHeartbeatMs: fresh, nowMs: NOW })).toBe(false);
  });

  it('is false on client ABSENCE — zero tmux clients is a detached pane, not a lost window', () => {
    expect(hostWindowLost({ pidAlive: true, tmuxClients: 0, nowMs: NOW })).toBe(false);
    // No window and no client count at all: blind, not lost.
    expect(hostWindowLost({ pidAlive: true, nowMs: NOW })).toBe(false);
  });

  it('is false for a dead agent — that is host-gone/crashed, not a running orphan', () => {
    expect(hostWindowLost({ pidAlive: false, windowHeartbeatMs: stale, nowMs: NOW })).toBe(false);
  });

  it('is false for a deliberately detached session — no window is the point of detaching', () => {
    expect(
      hostWindowLost({ pidAlive: true, windowHeartbeatMs: stale, deliberatelyDetached: true, nowMs: NOW }),
    ).toBe(false);
  });

  it('holds at the exact staleness boundary', () => {
    const atBoundary = NOW - HOST_HEARTBEAT_STALE_MS;
    expect(hostWindowLost({ pidAlive: true, windowHeartbeatMs: atBoundary, nowMs: NOW })).toBe(true);
    expect(hostWindowLost({ pidAlive: true, windowHeartbeatMs: atBoundary + 1, nowMs: NOW })).toBe(false);
  });
});
