import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  reconcilePresence,
  actionFor,
  observedFromActive,
  loadPresence,
  savePresence,
  presenceFilePath,
  PRESENCE_TTL_MS,
  type ObservedSession,
  type PresenceRecord,
} from './presence.js';

const obs = (o: Partial<ObservedSession> & { sessionId: string }): ObservedSession => ({
  agent: 'codex',
  location: 'ssh',
  device: 'yosemite-s0',
  transport: 'ssh',
  interactive: true,
  ...o,
});

const rec = (r: Partial<PresenceRecord> & { sessionId: string }): PresenceRecord => ({
  agent: 'codex',
  location: 'ssh',
  device: 'yosemite-s0',
  transport: 'ssh',
  interactive: true,
  lastSeenMs: 1_000,
  status: 'connected',
  ...r,
});

describe('reconcilePresence (RUSH-2007 Layer C state machine)', () => {
  it('marks an observed session connected and stamps lastSeen = now', () => {
    const { next, transitions } = reconcilePresence({}, [obs({ sessionId: 'a' })], 5_000);
    expect(next.a.status).toBe('connected');
    expect(next.a.lastSeenMs).toBe(5_000);
    expect(transitions).toHaveLength(0);
  });

  it('flips a tracked-but-absent session to disconnected and emits the transition', () => {
    const prev = { a: rec({ sessionId: 'a', lastSeenMs: 4_000, status: 'connected' }) };
    const { next, transitions } = reconcilePresence(prev, [], 5_000);
    expect(next.a.status).toBe('disconnected');
    expect(next.a.lastSeenMs).toBe(4_000);
    expect(transitions).toEqual([
      expect.objectContaining({ from: 'connected', to: 'disconnected', action: 'reconnect-nudge' }),
    ]);
  });

  it('does NOT re-emit a transition for a session already disconnected last tick', () => {
    const prev = { a: rec({ sessionId: 'a', lastSeenMs: 4_000, status: 'disconnected' }) };
    const { next, transitions } = reconcilePresence(prev, [], 5_000);
    expect(next.a.status).toBe('disconnected');
    expect(transitions).toHaveLength(0);
  });

  it('interactive drop -> reconnect-nudge; headless remote drop -> keep-alive; local headless -> none', () => {
    const prev = {
      i: rec({ sessionId: 'i', interactive: true, location: 'ssh' }),
      h: rec({ sessionId: 'h', interactive: false, location: 'ssh' }),
      l: rec({ sessionId: 'l', interactive: false, location: 'local' }),
    };
    const { transitions } = reconcilePresence(prev, [], 5_000);
    const byId = Object.fromEntries(transitions.map((t) => [t.record.sessionId, t.action]));
    expect(byId).toEqual({ i: 'reconnect-nudge', h: 'keep-alive', l: 'none' });
  });

  it('re-observing a disconnected session flips it back to connected', () => {
    const prev = { a: rec({ sessionId: 'a', lastSeenMs: 4_000, status: 'disconnected' }) };
    const { next, transitions } = reconcilePresence(prev, [obs({ sessionId: 'a' })], 9_000);
    expect(next.a.status).toBe('connected');
    expect(next.a.lastSeenMs).toBe(9_000);
    expect(transitions).toEqual([
      expect.objectContaining({ from: 'disconnected', to: 'connected', action: 'none' }),
    ]);
  });

  it('prunes a disconnected record once it is older than the TTL', () => {
    const prev = { a: rec({ sessionId: 'a', lastSeenMs: 1_000, status: 'disconnected' }) };
    const now = 1_000 + PRESENCE_TTL_MS + 1;
    const { next, transitions } = reconcilePresence(prev, [], now);
    expect(next.a).toBeUndefined();
    expect(transitions).toHaveLength(0);
  });

  it('keeps a disconnected record that is still within the TTL', () => {
    const prev = { a: rec({ sessionId: 'a', lastSeenMs: 1_000, status: 'disconnected' }) };
    const now = 1_000 + PRESENCE_TTL_MS - 1;
    const { next } = reconcilePresence(prev, [], now);
    expect(next.a.status).toBe('disconnected');
  });

  it('actionFor never acts on a connected record', () => {
    expect(actionFor(rec({ sessionId: 'a', status: 'connected', interactive: true }))).toBe('none');
  });
});

describe('observedFromActive (ActiveSession -> ObservedSession adapter)', () => {
  it('maps a peer session to ssh/location=device and a local one to local/self', () => {
    const got = observedFromActive(
      [
        { sessionId: 'r', kind: 'codex', context: 'terminal', machine: 'yosemite-s0', provenance: { transport: 'ssh' } },
        { sessionId: 'l', kind: 'claude', context: 'terminal' },
      ],
      'this-box',
    );
    expect(got).toEqual([
      { sessionId: 'r', agent: 'codex', location: 'ssh', device: 'yosemite-s0', transport: 'ssh', interactive: true },
      { sessionId: 'l', agent: 'claude', location: 'local', device: 'this-box', transport: 'local', interactive: true },
    ]);
  });

  it('marks only terminal context interactive; headless is not', () => {
    const got = observedFromActive(
      [
        { sessionId: 't', kind: 'codex', context: 'terminal' },
        { sessionId: 'h', kind: 'codex', context: 'headless' },
      ],
      'box',
    );
    expect(got.map((o) => [o.sessionId, o.interactive])).toEqual([['t', true], ['h', false]]);
  });

  it('skips sessions with no id (unaddressable)', () => {
    expect(observedFromActive([{ kind: 'codex', context: 'terminal' }], 'box')).toEqual([]);
  });

  it('falls back transport to location when provenance is absent', () => {
    const [o] = observedFromActive([{ sessionId: 'x', kind: 'codex', context: 'terminal', machine: 'peer' }], 'box');
    expect(o.transport).toBe('ssh');
  });
});

describe('presence store (real filesystem round-trip)', () => {
  afterEach(() => {
    try { fs.unlinkSync(presenceFilePath()); } catch {  }
  });

  it('round-trips a record through save/load', () => {
    const map = { a: rec({ sessionId: 'a', status: 'disconnected', lastSeenMs: 7 }) };
    savePresence(map);
    expect(loadPresence()).toEqual(map);
  });

  it('degrades to an empty store when the file is corrupt', () => {
    fs.mkdirSync(path.dirname(presenceFilePath()), { recursive: true });
    fs.writeFileSync(presenceFilePath(), '{not json', 'utf8');
    expect(loadPresence()).toEqual({});
  });

  it('returns an empty store when the file is absent', () => {
    try { fs.unlinkSync(presenceFilePath()); } catch {  }
    expect(loadPresence()).toEqual({});
  });
});
