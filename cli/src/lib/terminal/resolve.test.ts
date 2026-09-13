/**
 * Tests for the inject-target resolver (RUSH-1415) — the safety choke point.
 *
 * `resolveInjectTargetForSession` is PURE (takes an ActiveSession, returns a
 * resolution), so the whole tmux > iterm > vscodium precedence and the
 * Ghostty refusal are asserted here without touching the process table. The
 * fixtures mirror what active.ts produces: provenance (env-derived rails) + host
 * (detectHost) + sessionId.
 */
import { describe, it, expect } from 'vitest';
import type { ActiveSession } from '../session/active.js';
import type { SessionProvenance, ReplyRail, MuxLocation } from '../session/provenance.js';
import { resolveInjectTargetForSession, addressabilityRecoveryHint } from './resolve.js';

/** Minimal ActiveSession with the fields the resolver reads. */
function session(over: {
  sessionId?: string;
  host?: string;
  mux?: MuxLocation;
  reply?: ReplyRail;
}): ActiveSession {
  const provenance: SessionProvenance = {
    host: 'zion',
    transport: 'local',
    mux: over.mux,
    reply: over.reply ?? null,
  };
  return {
    context: 'terminal',
    kind: 'claude',
    host: over.host,
    sessionId: over.sessionId,
    status: 'idle',
    provenance,
  };
}

describe('resolveInjectTargetForSession — tmux (highest precedence)', () => {
  it('resolves a tmux pane regardless of host app', () => {
    const r = resolveInjectTargetForSession(
      session({ host: 'iterm', mux: { kind: 'tmux', pane: '%3', socket: '/tmp/s' }, reply: { rail: 'tmux', target: '%3', socket: '/tmp/s' } }),
    );
    expect(r).toEqual({ addressable: true, rail: 'tmux', target: { backend: 'tmux', pane: '%3', socket: '/tmp/s' } });
  });

  it('tmux wins even when the session is IDE-hosted (works inside VS Code)', () => {
    const r = resolveInjectTargetForSession(
      session({ host: 'codium', sessionId: 'abc', mux: { kind: 'tmux', pane: '%1' }, reply: { rail: 'tmux', target: '%1' } }),
    );
    expect(r.addressable).toBe(true);
    if (r.addressable) expect(r.rail).toBe('tmux');
  });
});

describe('resolveInjectTargetForSession — iterm', () => {
  it('resolves the exact iTerm split by session UUID from the env rail', () => {
    const r = resolveInjectTargetForSession(session({ host: 'iterm', reply: { rail: 'iterm', session: 'UUID-1' } }));
    expect(r).toEqual({ addressable: true, rail: 'iterm', target: { backend: 'iterm', session: 'UUID-1' } });
  });
});

describe('resolveInjectTargetForSession — vscodium', () => {
  it('resolves a codium integrated terminal to the editor CLI + scheme, id = sessionId', () => {
    const r = resolveInjectTargetForSession(session({ host: 'codium', sessionId: 'sess-9' }));
    expect(r).toEqual({
      addressable: true,
      rail: 'vscodium',
      target: { backend: 'vscodium', terminalId: 'sess-9', cli: 'codium', scheme: 'vscodium' },
    });
  });

  it('maps cursor and code hosts to their CLI/scheme', () => {
    const cur = resolveInjectTargetForSession(session({ host: 'cursor', sessionId: 's' }));
    const code = resolveInjectTargetForSession(session({ host: 'code', sessionId: 's' }));
    expect(cur.addressable && cur.target).toMatchObject({ cli: 'cursor', scheme: 'cursor' });
    expect(code.addressable && code.target).toMatchObject({ cli: 'code', scheme: 'vscode' });
  });

  it('refuses an IDE terminal with no session id (nothing to address) rather than guessing', () => {
    const r = resolveInjectTargetForSession(session({ host: 'codium' }));
    expect(r.addressable).toBe(false);
    if (!r.addressable) expect(r.reason).toContain('no session id');
  });
});

describe('resolveInjectTargetForSession — ghostty (honest degradation)', () => {
  it('refuses a Ghostty session with no tmux by default (watchdog skips)', () => {
    const r = resolveInjectTargetForSession(session({ host: 'ghostty', sessionId: 's' }));
    expect(r.addressable).toBe(false);
    if (!r.addressable) expect(r.reason).toContain('un-addressable (ghostty');
  });

  it('emits the coarse window path only under the explicit opt-in, with a not-precise note', () => {
    const r = resolveInjectTargetForSession(session({ host: 'ghostty', sessionId: 's' }), { allowGhosttyFocus: true });
    expect(r.addressable).toBe(true);
    if (r.addressable) {
      expect(r.rail).toBe('ghostty');
      expect(r.target).toEqual({ backend: 'ghostty' });
      expect(r.note).toContain('not split-precise');
    }
  });

  it('a Ghostty session INSIDE tmux is still tmux-addressable (tmux precedence beats the refusal)', () => {
    const r = resolveInjectTargetForSession(
      session({ host: 'ghostty', mux: { kind: 'tmux', pane: '%2' }, reply: { rail: 'tmux', target: '%2' } }),
    );
    expect(r.addressable).toBe(true);
    if (r.addressable) expect(r.rail).toBe('tmux');
  });
});

describe('resolveInjectTargetForSession — refusals', () => {
  it('refuses with an honest reason when no rail exists', () => {
    const r = resolveInjectTargetForSession(session({ host: undefined }));
    expect(r.addressable).toBe(false);
    if (!r.addressable) expect(r.reason).toContain('not inside tmux');
  });

  it('names an unrecognised host in the refusal reason', () => {
    const r = resolveInjectTargetForSession(session({ host: 'warp' }));
    expect(r.addressable).toBe(false);
    if (!r.addressable) expect(r.reason).toContain('warp');
  });

  it('includes a recovery hint on every refusal', () => {
    const r = resolveInjectTargetForSession(session({ host: undefined }));
    expect(r.addressable).toBe(false);
    if (!r.addressable) {
      expect(r.hint).toContain('agents sessions resume');
      expect(r.hint).toContain('tmux');
    }
  });
});

describe('addressabilityRecoveryHint', () => {
  it('suggests tmux wrapping and resume for an interactive Ghostty session', () => {
    const s = session({ host: 'ghostty', sessionId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' }) as ActiveSession;
    s.context = 'terminal';
    const hint = addressabilityRecoveryHint(s);
    expect(hint).toContain('Ghostty');
    expect(hint).toContain('agents sessions resume aaaaaaaa');
    expect(hint).toContain('tmux');
  });

  it('suggests resume only for a headless session with no rail', () => {
    const s = session({ host: undefined, sessionId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' }) as ActiveSession;
    s.context = 'headless';
    s.tty = undefined;
    const hint = addressabilityRecoveryHint(s);
    expect(hint).toContain('agents sessions resume aaaaaaaa');
    expect(hint).not.toContain('Enable tmux');
  });

  it('tells an IDE terminal without a session id to wait or resume', () => {
    const s = session({ host: 'codium' }) as ActiveSession;
    s.context = 'terminal';
    const hint = addressabilityRecoveryHint(s);
    expect(hint).toContain('IDE terminal');
    expect(hint).toContain('session id');
    expect(hint).toContain('agents sessions resume');
  });

  it('renders the real id from the fallback when the live session id is absent (PHNX-3070)', () => {
    // The `focus` case: the live row has no sessionId, but the caller knows the
    // real id (meta.id). Without the fallback the hint printed the useless
    // `agents sessions resume <id>` placeholder.
    const s = session({ host: 'codium', sessionId: undefined }) as ActiveSession;
    s.context = 'terminal';
    const hint = addressabilityRecoveryHint(s, 'ffffffff-1111-2222-3333-444444444444');
    expect(hint).toContain('agents sessions resume ffffffff');
    expect(hint).not.toContain('resume <id>');
  });

  it('falls back to the <id> placeholder only when neither a live id nor a fallback exists', () => {
    const s = session({ host: undefined, sessionId: undefined }) as ActiveSession;
    s.context = 'headless';
    s.tty = undefined;
    const hint = addressabilityRecoveryHint(s);
    expect(hint).toContain('agents sessions resume <id>');
  });
});

