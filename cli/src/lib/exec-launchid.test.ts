import { describe, it, expect, afterEach } from 'vitest';
import { spawnSync } from 'child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildExecEnv, buildTmuxAgentCommand, writeTmuxEnvFile, isHarnessKnownSessionId } from './exec.js';
import { launchIdentityEnv } from './launch-identity.js';

describe('launch editor ownership', () => {
  const saved = { ...process.env };
  afterEach(() => {
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
  });

  it.skipIf(process.platform === 'win32')('clears stale tmux-server identity in both launch forms while keeping terminal plumbing', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'launch-identity-'));
    try {
      for (const fileMode of [false, true]) {
        const env = { PATH: process.env.PATH, AGENT_LAUNCH_ID: 'new-launch' };
        const envFile = fileMode ? path.join(dir, 'env') : undefined;
        if (envFile) writeTmuxEnvFile(env, envFile);
        const cmd = buildTmuxAgentCommand(process.execPath, ['-e', 'console.log(JSON.stringify({terminal:process.env.AGENT_TERMINAL_ID,session:process.env.AGENT_SESSION_ID,launch:process.env.AGENT_LAUNCH_ID,tmux:process.env.TMUX}))'], env, { envFile });
        const child = spawnSync('sh', ['-c', cmd], { encoding: 'utf8', env: { ...process.env, AGENT_TERMINAL_ID: 'stale-tab', AGENT_SESSION_ID: 'stale-session', TMUX: 'server-socket' } });
        expect(child.status, child.stderr).toBe(0);
        expect(JSON.parse(child.stdout)).toEqual({ launch: 'new-launch', tmux: 'server-socket' });
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it.each(['terminal', 'headless', 'teams'])('keeps an initial editor session distinct from its %s descendant launch', runtime => {
    delete process.env.AGENTS_RUNTIME;
    delete process.env.AGENTS_PARENT_SESSION_ID;
    process.env.AGENT_TERMINAL_ID = 'editor-tab';
    process.env.AGENT_SESSION_ID = 'parent-session';
    expect(launchIdentityEnv().AGENT_TERMINAL_ID).toBe('editor-tab');
    const initial = buildExecEnv({ agent: 'codex', mode: 'auto', effort: 'auto' });
    expect(initial.AGENT_TERMINAL_ID).toBe('editor-tab');
    expect(initial.AGENTS_PARENT_SESSION_ID).toBeUndefined();
    process.env.AGENTS_RUNTIME = runtime;
    process.env.AGENT_LAUNCH_ID = 'parent-launch';
    process.env.AGENTS_PARENT_LAUNCH_ID = 'grandparent-launch';
    process.env.AGENTS_PARENT_SESSION_ID = 'grandparent-session';
    delete process.env.AGENTS_SESSION_ID;
    const env = buildExecEnv({ agent: 'codex', mode: 'auto', effort: 'auto', prompt: 'child task', env: { AGENT_LAUNCH_ID: 'child-launch' } });
    const child = spawnSync(process.execPath, ['-e', 'console.log(JSON.stringify(Object.fromEntries(Object.entries(process.env).filter(([k]) => /^(AGENT_|AGENTS_PARENT|AGENTS_ORIGIN)/.test(k)))))'], { env, encoding: 'utf8' });
    expect(child.status).toBe(0);
    const delivered = JSON.parse(child.stdout);
    expect(delivered.AGENT_TERMINAL_ID).toBeUndefined();
    expect(delivered.AGENT_SESSION_ID).toBeUndefined();
    expect(env.AGENTS_SESSION_ID).toBeUndefined();
    expect(delivered).toMatchObject({ AGENT_LAUNCH_ID: 'child-launch', AGENTS_PARENT_LAUNCH_ID: 'parent-launch', AGENTS_PARENT_SESSION_ID: 'parent-session', AGENTS_ORIGIN_TERMINAL_ID: 'editor-tab' });
  });
});

// The launchId join only works if AGENT_LAUNCH_ID actually reaches the agent
// process (so its SessionStart hook records the same id). spawnAgent injects it
// into options.env before every env build; buildExecEnv must therefore carry it
// through into the child's environment — for BOTH the bare spawn and the tmux
// `env KEY=VAL` prefix (which is built from this same map). This exercises the
// real cross-process delivery, not a mock.
describe('AGENT_LAUNCH_ID propagation', () => {
  it('carries options.env.AGENT_LAUNCH_ID into a spawned child', () => {
    const env = buildExecEnv({
      agent: 'codex',
      cwd: process.cwd(),
      mode: 'auto',
      effort: 'auto',
      env: { AGENT_LAUNCH_ID: 'LID-test-abc' },
    });
    const r = spawnSync(
      process.execPath,
      ['-e', 'process.stdout.write(process.env.AGENT_LAUNCH_ID || "MISSING")'],
      { env, encoding: 'utf8' },
    );
    expect(r.stdout).toBe('LID-test-abc');
  });
});

// A session id is only a real handle when the HARNESS received it. The launcher
// pre-assigns one for claude and generates a throwaway for the tmux wrapper
// name otherwise, and both look like 8 hex characters in a status bar.
describe('isHarnessKnownSessionId', () => {
  it('accepts claude, which is created with --session-id', () => {
    expect(isHarnessKnownSessionId('claude', 'abc-123', false)).toBe(true);
  });

  it('accepts a native resume on any harness with a resume spec', () => {
    // codex resumes by positional id, so a resumed id IS the harness's own.
    expect(isHarnessKnownSessionId('codex', 'abc-123', true)).toBe(true);
  });

  it('rejects a fresh non-claude launch, whose real id only arrives later', () => {
    // `agents run codex --session-id X` never puts X on codex's command line;
    // publishing it would show a handle `ag focus` rejects.
    expect(isHarnessKnownSessionId('codex', 'abc-123', false)).toBe(false);
  });

  it('rejects an absent id', () => {
    expect(isHarnessKnownSessionId('claude', undefined, false)).toBe(false);
    expect(isHarnessKnownSessionId('codex', undefined, true)).toBe(false);
  });
});
