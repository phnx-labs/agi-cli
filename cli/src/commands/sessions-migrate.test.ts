import { describe, it, expect } from 'vitest';
import { effectiveMode, rehydrateCommand, buildMigrateResumeCommands } from './sessions-migrate.js';
import { buildResumeCommand } from './sessions.js';
import { AGENTS } from '../lib/agents.js';
import type { AgentId } from '../lib/types.js';
import { SESSION_AGENTS, type SessionMeta, type SessionAgentId } from '@phnx-labs/sessions-cli/reader';

/** Minimal SessionMeta with a resolvable version, for the harness-parity gate. */
function meta(agent: SessionAgentId): SessionMeta {
  return {
    id: '2026-07-31T00-00-00-000Z',
    shortId: 'abcd1234',
    agent,
    timestamp: '2026-07-31T00:00:00.000Z',
    filePath: `/tmp/${agent}.jsonl`,
    version: '1.0.0',
    cwd: '/tmp',
  };
}

describe('effectiveMode — harness parity gate', () => {
  it('keeps resume for agents buildResumeCommand can resume (claude, codex, opencode)', () => {
    for (const agent of ['claude', 'codex', 'opencode'] as SessionAgentId[]) {
      const r = effectiveMode(meta(agent), 'resume');
      expect(r).toEqual({ mode: 'resume', downgraded: false });
    }
  });

  it('downgrades resume→rehydrate for every non-resumable agent (no silent skip)', () => {
    const nonResumable: SessionAgentId[] = ['gemini', 'antigravity', 'openclaw', 'rush', 'hermes', 'grok', 'kimi', 'droid', 'cursor'];
    for (const agent of nonResumable) {
      const r = effectiveMode(meta(agent), 'resume');
      expect(r).toEqual({ mode: 'rehydrate', downgraded: true });
    }
  });

  it('honors an explicit rehydrate request for a resumable agent (no forced downgrade flag)', () => {
    const r = effectiveMode(meta('claude'), 'rehydrate');
    expect(r).toEqual({ mode: 'rehydrate', downgraded: false });
  });

  it('rehydrateCommand uses each agent\'s real binary (cliCommand), not the session-agent id', () => {
    // antigravity's executable is `agy`, not `antigravity` — launching the raw id
    // on the target would fail with a shell error instead of rehydrating.
    expect(rehydrateCommand(meta('antigravity'))[0]).toBe('agy');
    expect(rehydrateCommand(meta('claude'))[0]).toBe('claude');
    // Pin the whole set to the registry so a renamed binary can't drift silently.
    for (const agent of SESSION_AGENTS) {
      const expected = AGENTS[agent as AgentId]?.cliCommand ?? agent;
      expect(rehydrateCommand(meta(agent))[0]).toBe(expected);
    }
  });

  it('stays in lockstep with buildResumeCommand for EVERY session agent (the parity invariant)', () => {
    // The gate must downgrade exactly when buildResumeCommand returns null — if a
    // new agent gains/loses resume support, this pins the two together.
    for (const agent of SESSION_AGENTS) {
      const m = meta(agent);
      const resumable = buildResumeCommand(m) !== null;
      const { mode, downgraded } = effectiveMode(m, 'resume');
      if (resumable) {
        expect(mode).toBe('resume');
        expect(downgraded).toBe(false);
      } else {
        expect(mode).toBe('rehydrate');
        expect(downgraded).toBe(true);
      }
    }
  });
});

describe('buildMigrateResumeCommands — the migrated session must land on the AGENTS socket (RUSH-2521)', () => {
  const base = { sessionName: 'migrate-abcd1234', homeRelSocketPath: '.agents/.cache/helpers/tmux/server.sock', inner: 'exec claude' };

  it('every tmux invocation in the launch command carries -S <agents socket>, never bare `tmux`', () => {
    const { launchCmd } = buildMigrateResumeCommands(base);
    // The old bug: `tmux set-option ...` with no -S landed the session on
    // tmux's own default OS socket — invisible to readAllPaneOwners, so the
    // reaper's next tick killed the migrated agent's helpers as
    // 'tmux-session-gone'. Assert that exact bare-invocation shape is absent
    // (the mkdir path also contains the substring "tmux", so this checks the
    // COMMAND shape, not a bare substring match).
    expect(launchCmd).not.toContain('tmux set-option');
    expect(launchCmd).toContain('tmux -S "$HOME/.agents/.cache/helpers/tmux/server.sock" set-option');
  });

  it('$HOME is left as a literal, unresolved token for the REMOTE shell to expand', () => {
    const { launchCmd, probeCmd } = buildMigrateResumeCommands(base);
    // Must never be pre-resolved to a LOCAL absolute path (the local and
    // remote HOME can differ — different user, different OS).
    expect(launchCmd).toContain('$HOME/');
    expect(probeCmd).toContain('$HOME/');
  });

  it('creates the socket parent directory before tmux tries to bind there', () => {
    const { launchCmd } = buildMigrateResumeCommands(base);
    const mkdirIdx = launchCmd.indexOf('mkdir -p');
    const tmuxIdx = launchCmd.indexOf('tmux -S');
    expect(mkdirIdx).toBeGreaterThanOrEqual(0);
    expect(mkdirIdx).toBeLessThan(tmuxIdx);
    expect(launchCmd).toContain('mkdir -p "$HOME/.agents/.cache/helpers/tmux"');
  });

  it('the liveness probe queries has-session and list-panes on the SAME agents socket as the launch', () => {
    const { launchCmd, probeCmd, socketFlag } = buildMigrateResumeCommands(base);
    expect(launchCmd).toContain(socketFlag);
    expect(probeCmd).toContain(`tmux ${socketFlag} has-session`);
    expect(probeCmd).toContain(`tmux ${socketFlag} list-panes`);
  });

  it('threads a custom remote cwd into the new-session invocation', () => {
    const { launchCmd } = buildMigrateResumeCommands({ ...base, cwd: '/home/worker/repo' });
    expect(launchCmd).toContain('-c /home/worker/repo');
  });
});
