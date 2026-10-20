import { describe, it, expect } from 'vitest';
import type { ActiveSession } from '../session/active.js';
import type { SessionProvenance, ReplyRail, MuxLocation } from '../session/provenance.js';
import { resolveInjectTargetForSession, addressabilityRecoveryHint, typedByEditorTab } from './resolve.js';

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

describe('resolveInjectTargetForSession — editor tabs', () => {
  it('leaves an editor tab to the AGI EXT window that binds it: no CLI rail', () => {
    for (const host of ['codium', 'cursor', 'code']) {
      const r = resolveInjectTargetForSession(session({ host, sessionId: 'sess-9' }));
      expect(r.addressable).toBe(false);
      if (!r.addressable) expect(r.reason).toContain('the AGI EXT window that binds the session types into it');
    }
  });

  it('says an IDE terminal with no session id has nothing to address', () => {
    const r = resolveInjectTargetForSession(session({ host: 'codium' }));
    expect(r.addressable).toBe(false);
    if (!r.addressable) expect(r.reason).toContain('no session id');
  });

  it('typedByEditorTab: an editor tab or an unseen host, never Ghostty, headless or a session with no id', () => {
    expect(typedByEditorTab(session({ host: 'codium', sessionId: 's' }))).toBe(true);
    expect(typedByEditorTab(session({ host: undefined, sessionId: 's' }))).toBe(true);
    expect(typedByEditorTab(session({ host: 'ghostty', sessionId: 's' }))).toBe(false);
    expect(typedByEditorTab({ ...session({ host: 'codium', sessionId: 's' }), context: 'headless' })).toBe(false);
    expect(typedByEditorTab({ ...session({ host: 'codium' }), sessionId: undefined })).toBe(false);
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
      expect(r.hint).toContain('agents run auto --resume');
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
    expect(hint).toContain('agents run auto --resume aaaaaaaa');
    expect(hint).toContain('tmux');
  });

  it('suggests resume only for a headless session with no rail', () => {
    const s = session({ host: undefined, sessionId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' }) as ActiveSession;
    s.context = 'headless';
    s.tty = undefined;
    const hint = addressabilityRecoveryHint(s);
    expect(hint).toContain('agents run auto --resume aaaaaaaa');
    expect(hint).not.toContain('Enable tmux');
  });

  it('tells an IDE terminal without a session id to wait or resume', () => {
    const s = session({ host: 'codium' }) as ActiveSession;
    s.context = 'terminal';
    const hint = addressabilityRecoveryHint(s);
    expect(hint).toContain('IDE terminal');
    expect(hint).toContain('session id');
    expect(hint).toContain('agents run auto --resume');
  });

  it('renders the real id from the fallback when the live session id is absent (PHNX-3070)', () => {
    const s = session({ host: 'codium', sessionId: undefined }) as ActiveSession;
    s.context = 'terminal';
    const hint = addressabilityRecoveryHint(s, 'ffffffff-1111-2222-3333-444444444444');
    expect(hint).toContain('agents run auto --resume ffffffff');
    expect(hint).not.toContain('resume <id>');
  });

  it('falls back to the <id> placeholder only when neither a live id nor a fallback exists', () => {
    const s = session({ host: undefined, sessionId: undefined }) as ActiveSession;
    s.context = 'headless';
    s.tty = undefined;
    const hint = addressabilityRecoveryHint(s);
    expect(hint).toContain('agents run auto --resume <id>');
  });
});
