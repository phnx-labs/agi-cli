import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as os from 'node:os';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { shouldTapStdout, resolveInteractive, inferredInteractiveWithoutTty, buildExecCommand, nativeResume, resolveShimSpawn, buildExecEnv, ensureVendorHomeDir, stampedAgentName, customHarnessName, resolveTmuxWrap, buildTmuxAgentCommand, writeTmuxEnvFile, formatPaneTail, detectRateLimit, detectOutOfCredits, classifyClaudeRunRefusal, classifyCodexRunRefusal, parseCodexUsageLimitReset, detectAuthFailure, detectAuthFailureEvent, authFailureReason, isAuthFailureFromLog, resolveLaunchId, shouldRecapDeadPane, isPaneKnownAliveFromQueryResult, tmuxRunExitCode, UNKNOWN_OUTCOME_EXIT_CODE, type TmuxWrapContext } from './exec.js';
import type { ExecOptions } from './exec.js';
import { isTmuxInstalled } from './tmux/binary.js';
import { mailboxDir } from './mailbox.js';
import { getVersionHomePath } from './installations/versions.js';
import { getUserAgentsDir } from './state.js';
import { keychainRef, secretsKeychainItem, writeBundleWithItemsSync } from './secrets-client.js';
import type { SecretsBundle } from './secrets-types.js';
import { useFreshSecretsHome } from '../../tests/secrets-standalone.js';
import { claudeAccountTokenKey } from './claude-account-token.js';

const describePosix = process.platform === 'win32' ? describe.skip : describe;

const LOGGED_OUT_CLAUDE_LOG = [
  '{"type":"system","subtype":"init","session_id":"x"}',
  '{"type":"system","subtype":"api_retry","attempt":1,"max_retries":10,"error_status":401,"error":"authentication_failed","session_id":"x"}',
  '{"type":"assistant","message":{"content":[{"type":"text","text":""}]},"error":"authentication_failed","session_id":"x"}',
  '{"type":"result","subtype":"success","is_error":true,"api_error_status":401,"terminal_reason":"completed","result":"Failed to authenticate. API Error: 401 OAuth access token has been revoked.","num_turns":1}',
].join('\n');

const RATE_LIMITED_CLAUDE_LOG = [
  '{"type":"system","subtype":"init","session_id":"x"}',
  '{"type":"result","subtype":"error","is_error":true,"result":"You have hit your 5-hour limit. Try again later.","num_turns":1}',
].join('\n');

const LOGGED_OUT_CURSOR_LOG =
  "Error: Authentication required. Please run 'agent login' first, or set CURSOR_API_KEY environment variable.";

const HEALTHY_LOG_MENTIONING_LOGIN = [
  '{"type":"assistant","message":{"content":[{"type":"text","text":"The onboarding doc explains what to do when Not logged in appears."}]},"session_id":"x"}',
  '{"type":"result","subtype":"success","is_error":false,"terminal_reason":"completed","result":"Documented the Not logged in flow. Please run /login is covered.","num_turns":3}',
].join('\n');

describe('detectAuthFailure — user-visible auth strings', () => {
  it('matches every observed corpus phrase', () => {
    for (const s of [
      'Failed to authenticate. API Error: 401 OAuth access token has been revoked.',
      'Not logged in · Please run /login',
      'API Error: 401 Invalid authentication credentials',
      'OAuth session expired and could not be refreshed',
      "Your organization has disabled Claude subscription access",
      LOGGED_OUT_CURSOR_LOG,
    ]) {
      expect(detectAuthFailure(s)).toBe(true);
    }
  });

  it('does not match ordinary text or a bare 401 without an auth keyword', () => {
    expect(detectAuthFailure('the server returned 401 rows from the query')).toBe(false);
    expect(detectAuthFailure('completed the refactor, all tests pass')).toBe(false);
  });

  it('does not match rate-limit text (kept a separate class)', () => {
    expect(detectAuthFailure('You have hit your 5-hour limit')).toBe(false);
  });
});

describe('detectAuthFailureEvent — Claude-compatible stream-json structural signal', () => {
  it('is true for a real logged-out Claude log', () => {
    expect(detectAuthFailureEvent(LOGGED_OUT_CLAUDE_LOG, 'claude')).toBe(true);
  });

  it('does not invent a structural event for Cursor plain-text auth output', () => {
    expect(detectAuthFailureEvent(LOGGED_OUT_CURSOR_LOG, 'cursor')).toBe(false);
  });

  it('is false for a completed run that merely mentions the phrase', () => {
    expect(detectAuthFailureEvent(HEALTHY_LOG_MENTIONING_LOGIN, 'claude')).toBe(false);
  });

  it('is false for a rate-limit failure', () => {
    expect(detectAuthFailureEvent(RATE_LIMITED_CLAUDE_LOG, 'claude')).toBe(false);
  });

  it('is false for agents that do not emit these markers', () => {
    expect(detectAuthFailureEvent(LOGGED_OUT_CLAUDE_LOG, 'codex')).toBe(false);
    expect(detectAuthFailureEvent(LOGGED_OUT_CLAUDE_LOG, 'antigravity')).toBe(false);
  });
});

describe('rate-limit vs auth precedence', () => {
  it('a rate-limited log is rate-limit true, auth false — failover, not an auth failure', () => {
    expect(detectRateLimit(RATE_LIMITED_CLAUDE_LOG)).toBe(true);
    expect(detectAuthFailureEvent(RATE_LIMITED_CLAUDE_LOG, 'claude')).toBe(false);
    expect(detectAuthFailure(RATE_LIMITED_CLAUDE_LOG)).toBe(false);
  });

  it('a logged-out log is auth true, rate-limit false', () => {
    expect(detectAuthFailureEvent(LOGGED_OUT_CLAUDE_LOG, 'claude')).toBe(true);
    expect(detectRateLimit(LOGGED_OUT_CLAUDE_LOG)).toBe(false);
  });
});

describe('isAuthFailureFromLog — the shared foreground/detached decision', () => {
  it('classifies a real Cursor plain-text auth failure after a failed process', () => {
    expect(isAuthFailureFromLog(LOGGED_OUT_CURSOR_LOG, 'cursor', { processFailed: true })).toBe(true);
  });
  it('classifies a real logged-out log regardless of process exit code', () => {
    expect(isAuthFailureFromLog(LOGGED_OUT_CLAUDE_LOG, 'claude', { processFailed: false })).toBe(true);
    expect(isAuthFailureFromLog(LOGGED_OUT_CLAUDE_LOG, 'claude', { processFailed: true })).toBe(true);
  });

  it('does NOT classify a completed run that merely mentions an auth phrase (the false-positive bug)', () => {
    expect(isAuthFailureFromLog(HEALTHY_LOG_MENTIONING_LOGIN, 'claude', { processFailed: false })).toBe(false);
  });

  it('falls back to raw text ONLY when the process actually failed (died mid-stream, no result event)', () => {
    const midStreamDeath = '{"type":"assistant","message":{"content":[{"type":"text","text":"Failed to authenticate. API Error: 401 OAuth access token has been revoked."}]}}';
    expect(isAuthFailureFromLog(midStreamDeath, 'claude', { processFailed: false })).toBe(false);
    expect(isAuthFailureFromLog(midStreamDeath, 'claude', { processFailed: true })).toBe(true);
  });

  it('never classifies a rate-limit failure as auth', () => {
    expect(isAuthFailureFromLog(RATE_LIMITED_CLAUDE_LOG, 'claude', { processFailed: true })).toBe(false);
  });
});

describe('authFailureReason', () => {
  it('extracts a short human phrase from the log (most specific match wins)', () => {
    expect(authFailureReason(LOGGED_OUT_CLAUDE_LOG)).toBe('OAuth access token has been revoked');
  });

  it('returns null when no user-visible phrase is present', () => {
    expect(authFailureReason('all good here')).toBeNull();
  });
});

function execOpts(over: Partial<ExecOptions> & { agent: ExecOptions['agent'] }): ExecOptions {
  return { mode: 'plan', effort: 'auto', ...over } as ExecOptions;
}

function idx(cmd: string[], tok: string): number {
  return cmd.indexOf(tok);
}

function withClearedEnv<T>(keys: string[], fn: () => T): T {
  const prev = new Map(keys.map((key) => [key, process.env[key]]));
  for (const key of keys) delete process.env[key];
  try {
    return fn();
  } finally {
    for (const key of keys) {
      const value = prev.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

describe('buildExecEnv — AGENTS_MAILBOX_DIR wiring (mailbox loop-closer)', () => {
  it('points the agent at its own box, keyed by sessionId', () => {
    const sid = '96aa7271-0c8f-4ed7-8811-1ad1d305e46e';
    const env = buildExecEnv(execOpts({ agent: 'claude', sessionId: sid }));
    expect(env.AGENTS_MAILBOX_DIR).toBe(mailboxDir(sid));
    expect(env.AGENT_SESSION_ID).toBe(sid);
    expect(env.AGENTS_SESSION_ID).toBe(sid);
    expect(env.AGENTS_AGENT_NAME).toBe('claude');
  });

  it('sets nothing when there is no session id (nothing to key a box on)', () => {
    withClearedEnv(['AGENT_SESSION_ID', 'AGENTS_SESSION_ID', 'AGENTS_MAILBOX_DIR'], () => {
      const env = buildExecEnv(execOpts({ agent: 'claude' }));
      expect(env.AGENTS_MAILBOX_DIR).toBeUndefined();
      expect(env.AGENT_SESSION_ID).toBeUndefined();
    });
  });

  it('lets a caller override the box via options.env (how the loop pins the run-level box)', () => {
    const runBox = mailboxDir('loop-1782947000000-abc123');
    const env = buildExecEnv(execOpts({
      agent: 'claude',
      sessionId: 'per-iteration-uuid-aaaa',
      env: { AGENTS_MAILBOX_DIR: runBox },
    }));
    expect(env.AGENTS_MAILBOX_DIR).toBe(runBox);
  });
});

describe('buildExecEnv — AGENTS_EXEC_HOME (account-slot launch marker)', () => {
  it('stamps the slot dir for a slot launch so the versioned alias yields its config-dir pin', () => {
    const slot = path.join(os.tmpdir(), 'agents-exec-home-slot');
    const env = buildExecEnv(execOpts({ agent: 'claude', execHome: slot }));
    expect(env.AGENTS_EXEC_HOME).toBe(slot);
    expect(env.CLAUDE_CONFIG_DIR).toBe(path.join(slot, '.claude'));
  });

  it('clears an inherited marker for a launch without a slot (a nested run never borrows its parent slot)', () => {
    const prev = process.env.AGENTS_EXEC_HOME;
    process.env.AGENTS_EXEC_HOME = '/parent/slot';
    try {
      const env = buildExecEnv(execOpts({ agent: 'claude' }));
      expect(env.AGENTS_EXEC_HOME).toBeUndefined();
    } finally {
      if (prev === undefined) delete process.env.AGENTS_EXEC_HOME; else process.env.AGENTS_EXEC_HOME = prev;
    }
  });
});

describe('buildExecEnv — AGENTS_RUN_ACCOUNT_ID (PHNX-3940 model-refusal tracking)', () => {
  it('stamps the run account id when the launch resolved one', () => {
    const env = buildExecEnv(execOpts({ agent: 'claude', accountId: 'acct-123' }));
    expect(env.AGENTS_RUN_ACCOUNT_ID).toBe('acct-123');
  });

  it('clears an inherited marker for a launch with no resolved account id', () => {
    const prev = process.env.AGENTS_RUN_ACCOUNT_ID;
    process.env.AGENTS_RUN_ACCOUNT_ID = 'parent-acct';
    try {
      const env = buildExecEnv(execOpts({ agent: 'claude' }));
      expect(env.AGENTS_RUN_ACCOUNT_ID).toBeUndefined();
    } finally {
      if (prev === undefined) delete process.env.AGENTS_RUN_ACCOUNT_ID; else process.env.AGENTS_RUN_ACCOUNT_ID = prev;
    }
  });
});

describe('buildExecEnv — custom harness identity (PHNX-2935)', () => {
  it('stamps AGENTS_AGENT_NAME with the profile name, not the host CLI', () => {
    const env = buildExecEnv(execOpts({ agent: 'claude', harnessName: 'deepseek' }));
    expect(env.AGENTS_AGENT_NAME).toBe('deepseek');
  });

  it('keeps AGENTS_AGENT_NAME as the host for a native run', () => {
    expect(buildExecEnv(execOpts({ agent: 'claude' })).AGENTS_AGENT_NAME).toBe('claude');
  });

  it('stampedAgentName prefers a non-empty harness name', () => {
    expect(stampedAgentName({ agent: 'claude', harnessName: 'deepseek' })).toBe('deepseek');
    expect(stampedAgentName({ agent: 'claude' })).toBe('claude');
    expect(stampedAgentName({ agent: 'claude', harnessName: '  ' })).toBe('claude');
  });

  it('customHarnessName is sparse — only set when the profile differs from the host', () => {
    expect(customHarnessName({ agent: 'claude', harnessName: 'deepseek' })).toBe('deepseek');
    expect(customHarnessName({ agent: 'claude' })).toBeUndefined();
    expect(customHarnessName({ agent: 'claude', harnessName: 'claude' })).toBeUndefined();
  });
});

describe('buildExecEnv — outbound feed runtime identity', () => {
  it('labels interactive runs as terminal and prompt runs as headless', () => {
    expect(buildExecEnv(execOpts({ agent: 'claude' })).AGENTS_RUNTIME).toBe('terminal');
    expect(buildExecEnv(execOpts({ agent: 'claude', prompt: 'work' })).AGENTS_RUNTIME).toBe('headless');
  });

  it('lets orchestrators override the runtime identity', () => {
    const env = buildExecEnv(execOpts({
      agent: 'claude',
      prompt: 'team task',
      env: { AGENTS_RUNTIME: 'teams' },
    }));
    expect(env.AGENTS_RUNTIME).toBe('teams');
  });
});

describe('buildExecEnv — the agent shares the secrets store agents-cli reads for it', () => {
  it('points a bare `secrets` inside the agent at the user agents dir, like buildServeEnv', () => {
    const prev = process.env.SECRETS_HOME;
    delete process.env.SECRETS_HOME;
    try {
      expect(buildExecEnv(execOpts({ agent: 'claude' })).SECRETS_HOME).toBe(getUserAgentsDir());
    } finally {
      if (prev === undefined) delete process.env.SECRETS_HOME; else process.env.SECRETS_HOME = prev;
    }
  });

  it('keeps an explicit SECRETS_HOME from the launching environment', () => {
    const prev = process.env.SECRETS_HOME;
    process.env.SECRETS_HOME = '/tmp/explicit-secrets-home';
    try {
      expect(buildExecEnv(execOpts({ agent: 'claude' })).SECRETS_HOME).toBe('/tmp/explicit-secrets-home');
    } finally {
      if (prev === undefined) delete process.env.SECRETS_HOME; else process.env.SECRETS_HOME = prev;
    }
  });
});

describe('buildExecEnv — Claude Code auto-updater suppression for pinned managed installs', () => {
  it('injects DISABLE_AUTOUPDATER=1 for a managed (pinned) claude version', () => {
    const env = buildExecEnv(execOpts({ agent: 'claude', version: '2.1.196' }));
    expect(env.DISABLE_AUTOUPDATER).toBe('1');
  });

  it('does not clobber a DISABLE_AUTOUPDATER already in the environment (the guard)', () => {
    const prev = process.env.DISABLE_AUTOUPDATER;
    process.env.DISABLE_AUTOUPDATER = '0';
    try {
      const env = buildExecEnv(execOpts({ agent: 'claude', version: '2.1.196' }));
      expect(env.DISABLE_AUTOUPDATER).toBe('0');
    } finally {
      if (prev === undefined) delete process.env.DISABLE_AUTOUPDATER;
      else process.env.DISABLE_AUTOUPDATER = prev;
    }
  });

  it('lets a caller override the value via options.env', () => {
    const env = buildExecEnv(execOpts({
      agent: 'claude', version: '2.1.196', env: { DISABLE_AUTOUPDATER: '0' },
    }));
    expect(env.DISABLE_AUTOUPDATER).toBe('0');
  });

  it('leaves codex untouched — no DISABLE_AUTOUPDATER injected', () => {
    withClearedEnv(['DISABLE_AUTOUPDATER'], () => {
      const env = buildExecEnv(execOpts({ agent: 'codex', version: '0.20.0' }));
      expect(env.DISABLE_AUTOUPDATER).toBeUndefined();
    });
  });
});

describe('buildExecEnv — Cursor per-account file-store isolation', () => {
  it('pins Cursor to the version-local file credential store', () => {
    const env = buildExecEnv(execOpts({ agent: 'cursor', version: '2026.08.04' }));
    expect(env.HOME).toBe(getVersionHomePath('cursor', '2026.08.04'));
    expect(env.AGENT_CLI_CREDENTIAL_STORE).toBe('file');
  });

  it('a different pinned Cursor version resolves to a different config home (real multi-account)', () => {
    const a = buildExecEnv(execOpts({ agent: 'cursor', version: '2026.08.04' }));
    const b = buildExecEnv(execOpts({ agent: 'cursor', version: '2026.07.23' }));
    expect(getVersionHomePath('cursor', '2026.08.04')).not.toBe(getVersionHomePath('cursor', '2026.07.23'));
  });

  it('overlays a labeled account config home without changing the binary version', () => {
    const env = buildExecEnv({ agent: 'cursor', version: '2026.8.1', configVersion: '2026.7.23', mode: 'edit', effort: 'auto' });
    expect(env.HOME).toContain('/cursor/2026.7.23/home');
    expect(env.HOME).not.toContain('/cursor/2026.8.1/');
  });

  it('does not overwrite a caller-provided XDG_CONFIG_HOME', () => {
    const env = buildExecEnv(execOpts({ agent: 'cursor', version: '2026.08.04', env: { XDG_CONFIG_HOME: '/custom/xdg' } }));
    expect(env.XDG_CONFIG_HOME).toBe('/custom/xdg');
  });

  it('lets an explicit caller override the credential store', () => {
    const env = buildExecEnv(execOpts({
      agent: 'cursor',
      version: '2026.08.04',
      env: { AGENT_CLI_CREDENTIAL_STORE: 'keychain' },
    }));
    expect(env.AGENT_CLI_CREDENTIAL_STORE).toBe('keychain');
  });
});

describe('buildExecEnv — Grok labeled-account overlay', () => {
  it('points GROK_HOME at the account slot while retaining the requested binary version', () => {
    const env = buildExecEnv(execOpts({ agent: 'grok', version: '0.3.0', configVersion: '0.2.9' }));
    expect(env.GROK_HOME).toBe(path.join(getVersionHomePath('grok', '0.2.9'), '.grok'));
    expect(env.GROK_HOME).not.toContain(path.join('grok', '0.3.0'));
  });
});

describe('ensureVendorHomeDir — fresh local spawn roots (PHNX-3943)', () => {
  it.each([
    ['cursor', '.cursor'],
    ['grok', '.grok'],
    ['copilot', '.copilot'],
  ] as const)('creates %s vendor home recursively', (agent, configDir) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), `agents-${agent}-home-`));
    const versionHome = path.join(root, 'missing', 'home');
    try {
      expect(ensureVendorHomeDir(agent, versionHome)).toBe(path.join(versionHome, configDir));
      expect(fs.statSync(path.join(versionHome, configDir)).isDirectory()).toBe(true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('does not create a vendor directory for unrelated harnesses', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-claude-home-'));
    try {
      expect(ensureVendorHomeDir('claude', path.join(root, 'home'))).toBeNull();
      expect(fs.existsSync(path.join(root, 'home'))).toBe(false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('nativeResume (Tier-1 capability derives from the command template)', () => {
  it('claude and codex resume natively', () => {
    expect(nativeResume('claude')).toBe(true);
    expect(nativeResume('codex')).toBe(true);
  });
  it('opencode does not (it falls back to /continue replay)', () => {
    expect(nativeResume('opencode')).toBe(false);
  });
  it('gates newly verified harnesses by the exact installed-version threshold', () => {
    expect(nativeResume('grok', '0.2.90')).toBe(false);
    expect(nativeResume('grok', '0.2.91')).toBe(true);
    expect(nativeResume('kimi', '0.19.2')).toBe(true);
    expect(nativeResume('droid', '0.186.0')).toBe(true);
    expect(nativeResume('cursor', '2026.7.23')).toBe(true);
    expect(nativeResume('cursor')).toBe(false);
  });
});

describe('buildExecCommand — versioned launch target (no unspawnable literal)', () => {
  let tmpHome: string;
  let origHome: string | undefined;

  beforeEach(() => {
    origHome = process.env.HOME;
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'exec-ver-'));
    process.env.HOME = tmpHome;
    vi.resetModules();
  });
  afterEach(() => {
    if (origHome === undefined) delete process.env.HOME; else process.env.HOME = origHome;
    fs.rmSync(tmpHome, { recursive: true, force: true });
    vi.resetModules();
  });

  it('resolves the version binary when no versioned shim exists', async () => {
    const binDir = path.join(tmpHome, '.agents', '.history', 'versions', 'kimi', '0.19.2', 'node_modules', '.bin');
    fs.mkdirSync(binDir, { recursive: true });
    const realBin = path.join(binDir, 'kimi');
    fs.writeFileSync(realBin, '#!/bin/sh\n', { mode: 0o755 });

    const { buildExecCommand: build } = await import('./exec.js');
    const cmd = build(execOpts({ agent: 'kimi', version: '0.19.2', interactive: true }));
    expect(cmd[0]).toBe(realBin);
    expect(cmd[0]).not.toBe('kimi@0.19.2');
  });

  it('falls back to the bare versioned name only when no binary exists at all', async () => {
    const { buildExecCommand: build } = await import('./exec.js');
    const cmd = build(execOpts({ agent: 'kimi', version: '0.19.2', interactive: true }));
    expect(cmd[0]).toBe('kimi@0.19.2');
  });
});

describe('buildExecCommand — native resume wiring', () => {
  it('claude headless: emits --resume <id> alongside the prompt, not --session-id', () => {
    const cmd = buildExecCommand(execOpts({
      agent: 'claude', resume: true, sessionId: 'abc-123', headless: true, prompt: 'keep going',
    }));
    expect(cmd).toContain('--resume');
    expect(cmd[idx(cmd, '--resume') + 1]).toBe('abc-123');
    expect(cmd).not.toContain('--session-id');
    expect(cmd[idx(cmd, '-p') + 1]).toBe('keep going');
    expect(cmd).toContain('--print');
  });

  it('claude interactive (no prompt): bare --resume <id>, no --print', () => {
    const cmd = buildExecCommand(execOpts({ agent: 'claude', resume: true, sessionId: 'abc-123', interactive: true }));
    expect(cmd[idx(cmd, '--resume') + 1]).toBe('abc-123');
    expect(cmd).not.toContain('--print');
  });

  it('claude interactive prompt is positional instead of the -p print flag', () => {
    const prompt = '/continue abc-123';
    const cmd = buildExecCommand(execOpts({ agent: 'claude', prompt, interactive: true }));
    expect(cmd).toContain(prompt);
    expect(cmd).not.toContain('-p');
    expect(cmd).not.toContain('--print');
  });

  it('legacy --session-id (no resume) still CREATES with the fixed id', () => {
    const cmd = buildExecCommand(execOpts({ agent: 'claude', sessionId: 'abc-123', headless: true, prompt: 'hi' }));
    expect(cmd).toContain('--session-id');
    expect(cmd[idx(cmd, '--session-id') + 1]).toBe('abc-123');
    expect(cmd).not.toContain('--resume');
  });

  it('codex headless edit resume: `codex exec resume <id> <prompt>` sandboxed via -c, no bypass', () => {
    const cmd = buildExecCommand(execOpts({
      agent: 'codex', mode: 'edit', resume: true, sessionId: 'xyz-9', headless: true, prompt: 'go',
    }));
    expect(cmd.slice(0, 3)).toEqual(['codex', 'exec', 'resume']);
    expect(cmd).not.toContain('--dangerously-bypass-approvals-and-sandbox');
    expect(cmd).toContain('default_permissions="agents-edit"');
    expect(cmd.join(' ')).toContain('extends = ":workspace"');
    expect(cmd.join(' ')).toContain('network = { enabled = true, allow_local_binding = true }');
    expect(idx(cmd, 'xyz-9')).toBeGreaterThan(idx(cmd, 'resume'));
    expect(idx(cmd, 'go')).toBeGreaterThan(idx(cmd, 'xyz-9'));
    expect(cmd).not.toContain('--sandbox');
  });

  it('codex headless skip resume passes the bypass flag', () => {
    const cmd = buildExecCommand(execOpts({
      agent: 'codex', mode: 'skip', resume: true, sessionId: 'xyz-9', headless: true, prompt: 'go',
    }));
    expect(cmd.slice(0, 3)).toEqual(['codex', 'exec', 'resume']);
    expect(cmd).toContain('--dangerously-bypass-approvals-and-sandbox');
    expect(cmd).not.toContain('--sandbox');
  });

  it('codex interactive resume drops `exec` and carries the read-only network profile', () => {
    const cmd = buildExecCommand(execOpts({ agent: 'codex', mode: 'plan', resume: true, sessionId: 'xyz-9', interactive: true }));
    expect(cmd.slice(0, 2)).toEqual(['codex', 'resume']);
    expect(cmd).toContain('default_permissions="agents-plan"');
    expect(cmd.join(' ')).toContain('extends = ":read-only"');
    expect(cmd.join(' ')).toContain('network = { enabled = true, allow_local_binding = true }');
    expect(cmd.at(-1)).toBe('xyz-9');
  });

  it('codex plan-mode headless resume passes no bypass (read-only via -c sandbox_mode)', () => {
    const cmd = buildExecCommand(execOpts({ agent: 'codex', mode: 'plan', resume: true, sessionId: 'xyz-9', headless: true, prompt: 'go' }));
    expect(cmd).not.toContain('--dangerously-bypass-approvals-and-sandbox');
    expect(cmd).toContain('default_permissions="agents-plan"');
    expect(cmd.join(' ')).toContain('extends = ":read-only"');
  });

  it.each([
    ['grok', '0.2.91', true, '--resume'],
    ['grok', '0.2.91', false, '--resume'],
    ['kimi', '0.19.2', true, '--session'],
    ['kimi', '0.19.2', false, '--session'],
    ['cursor', '2026.7.23', true, '--resume'],
    ['cursor', '2026.7.23', false, '--resume'],
    ['droid', '0.186.0', true, '--resume'],
    ['droid', '0.186.0', false, '--session-id'],
  ] as const)('%s %s %s uses %s for native resume', (agent, version, interactive, flag) => {
    const cmd = buildExecCommand(execOpts({
      agent,
      version,
      mode: 'edit',
      resume: true,
      sessionId: 'session-1',
      interactive,
      headless: !interactive,
      prompt: interactive ? undefined : 'continue',
    }));
    expect(cmd[idx(cmd, flag) + 1]).toBe('session-1');
  });

  it('non-native agent ignores resume in the arg builder (Tier-2 handles it via the prompt)', () => {
    const cmd = buildExecCommand(execOpts({ agent: 'opencode', resume: true, sessionId: 'qqq', headless: true, prompt: 'go' }));
    expect(cmd).not.toContain('--resume');
    expect(cmd).not.toContain('qqq');
  });
});

describe('shouldTapStdout (budget live-watcher attach gating, #346 FIX 3)', () => {
  it('TAPS a non-interactive run at a TTY when caps are active (the FIX 3 case)', () => {
    expect(shouldTapStdout( false,  false,  true)).toBe(true);
  });

  it('does NOT tap a non-interactive run at a TTY when no caps are configured', () => {
    expect(shouldTapStdout(false, false, false)).toBe(false);
  });

  it('still taps a piped non-interactive run regardless of caps (preserve compose path)', () => {
    expect(shouldTapStdout(false, true, false)).toBe(true);
    expect(shouldTapStdout(false, true, true)).toBe(true);
  });

  it('NEVER taps an interactive session even with caps active (human owns the TTY)', () => {
    expect(shouldTapStdout(true, false, true)).toBe(false);
    expect(shouldTapStdout(true, true, true)).toBe(false);
  });

  it('taps when a fallback chain requests a stdout tail, even at a TTY with no caps', () => {
    expect(shouldTapStdout(false, false, false,  true)).toBe(true);
  });

  it('captureTail never overrides the interactive guard', () => {
    expect(shouldTapStdout(true, false, false, true)).toBe(false);
  });
});

describe('resolveInteractive (sanity for the gating inputs above)', () => {
  it('a prompt-bearing run is non-interactive (headless), so it is eligible to tap', () => {
    expect(resolveInteractive({ prompt: 'hi' })).toBe(false);
  });
  it('a prompt-less run is interactive (never tapped)', () => {
    expect(resolveInteractive({ prompt: undefined })).toBe(true);
  });
  it('--headless forces non-interactive even without a prompt', () => {
    expect(resolveInteractive({ headless: true, prompt: undefined })).toBe(false);
  });
});

describe('inferredInteractiveWithoutTty (RUSH-1829 no-TTY REPL guard)', () => {
  it('blocks a prompt-less run in a non-TTY shell (the footgun: would hang on dead stdin)', () => {
    expect(inferredInteractiveWithoutTty({ prompt: undefined }, false)).toBe(true);
  });
  it('allows a prompt-less run at a real terminal (a normal interactive launch)', () => {
    expect(inferredInteractiveWithoutTty({ prompt: undefined }, true)).toBe(false);
  });
  it('never blocks a headless run — it has no prompt-less REPL to attach', () => {
    expect(inferredInteractiveWithoutTty({ prompt: 'do the thing' }, false)).toBe(false);
    expect(inferredInteractiveWithoutTty({ headless: true, prompt: undefined }, false)).toBe(false);
  });
  it('honors an explicit --interactive even without a TTY (caller may drive a PTY we can\'t detect)', () => {
    expect(inferredInteractiveWithoutTty({ interactive: true, prompt: undefined }, false)).toBe(false);
  });
});

describe('resolveShimSpawn (Windows .cmd shim exec, #shims)', () => {
  it('POSIX execs the binary directly, no shell', () => {
    const r = resolveShimSpawn('linux', '/home/u/.agents/.../claude', ['--help']);
    expect(r).toEqual({ command: '/home/u/.agents/.../claude', args: ['--help'], shell: false });
  });

  it('win32 .cmd path goes through the shell as ONE composed line with empty args (DEP0190-safe)', () => {
    const r = resolveShimSpawn('win32', 'C:\\bin\\claude.cmd', ['run']);
    expect(r.command).toBe('C:\\bin\\claude.cmd run');
    expect(r.args).toEqual([]);
    expect(r.shell).toBe(true);
  });

  it('win32 sends a bare (non-absolute) name to the shell for PATHEXT resolution', () => {
    const r = resolveShimSpawn('win32', 'claude', []);
    expect(r.command).toBe('claude');
    expect(r.args).toEqual([]);
    expect(r.shell).toBe(true);
  });

  it('win32 quotes prompt args with spaces/metachars into the composed line', () => {
    const r = resolveShimSpawn('win32', 'C:\\bin\\claude.cmd', ['-p', 'review my code & ship']);
    expect(r.command).toBe('C:\\bin\\claude.cmd -p "review my code & ship"');
    expect(r.args).toEqual([]);
    expect(r.shell).toBe(true);
  });
});

describePosix('resolveTmuxWrap (interactive spawn-wrap gate)', () => {
  const base: TmuxWrapContext = {
    interactive: true,
    platform: 'darwin',
    inTmux: false,
    raw: false,
    noTmuxEnv: false,
    configEnabled: true,
    remoteDispatch: false,
    tmuxAvailable: true,
    hasTty: true,
  };

  it('wraps an interactive macOS/Linux run when tmux is available and nothing opts out', () => {
    expect(resolveTmuxWrap(base).kind).toBe('wrap');
    expect(resolveTmuxWrap({ ...base, platform: 'linux' }).kind).toBe('wrap');
  });

  it('never wraps a headless run (no TTY to attach)', () => {
    expect(resolveTmuxWrap({ ...base, interactive: false }).kind).toBe('bare');
  });

  it('never wraps on Windows', () => {
    expect(resolveTmuxWrap({ ...base, platform: 'win32' }).kind).toBe('bare');
  });

  it('never double-wraps when already inside tmux', () => {
    expect(resolveTmuxWrap({ ...base, inTmux: true }).kind).toBe('bare');
  });

  it('respects the --raw and AGENTS_NO_TMUX escape hatches', () => {
    expect(resolveTmuxWrap({ ...base, raw: true }).kind).toBe('bare');
    expect(resolveTmuxWrap({ ...base, noTmuxEnv: true }).kind).toBe('bare');
  });

  it('does not wrap when tmux is not installed', () => {
    expect(resolveTmuxWrap({ ...base, tmuxAvailable: false }).kind).toBe('bare');
  });

  it('does not wrap a LOCAL run when this device set tmux.enabled=false', () => {
    expect(resolveTmuxWrap({ ...base, configEnabled: false }).kind).toBe('bare');
    expect(resolveTmuxWrap({ ...base, configEnabled: false, tmuxAvailable: true, raw: false }).kind).toBe('bare');
  });

  it('does NOT wrap a followed REMOTE-dispatched run when this device set tmux.enabled=false', () => {
    expect(resolveTmuxWrap({ ...base, configEnabled: false, remoteDispatch: true }).kind).toBe('bare');
    expect(resolveTmuxWrap({ ...base, configEnabled: false, remoteDispatch: true, tmuxAvailable: false }).kind).toBe('bare');
  });

  it('refuses a remote-dispatched run that WANTS the wrap when tmux is missing, instead of spawning something a blink would kill', () => {
    expect(resolveTmuxWrap({ ...base, remoteDispatch: true, tmuxAvailable: false }).kind).toBe('undurable');
    expect(resolveTmuxWrap({ ...base, remoteDispatch: false, tmuxAvailable: false }).kind).toBe('bare');
  });

  it('does not wrap a LOCAL interactive run with no TTY (piped tests must not leak panes)', () => {
    expect(resolveTmuxWrap({ ...base, hasTty: false }).kind).toBe('bare');
  });

  it('still wraps a followed REMOTE run whose launcher has no TTY, even with tmux.enabled=false (the pane is its only interface)', () => {
    expect(resolveTmuxWrap({ ...base, hasTty: false, remoteDispatch: true }).kind).toBe('wrap');
    expect(resolveTmuxWrap({ ...base, hasTty: false, remoteDispatch: true, configEnabled: false }).kind).toBe('wrap');
    expect(resolveTmuxWrap({ ...base, hasTty: false, remoteDispatch: true, configEnabled: false, tmuxAvailable: false }).kind).toBe('undurable');
  });

  it('lets the explicit per-run opt-outs beat the durability rule', () => {
    expect(resolveTmuxWrap({ ...base, remoteDispatch: true, raw: true }).kind).toBe('bare');
    expect(resolveTmuxWrap({ ...base, remoteDispatch: true, noTmuxEnv: true }).kind).toBe('bare');
    expect(resolveTmuxWrap({ ...base, remoteDispatch: true, raw: true, tmuxAvailable: false }).kind).toBe('bare');
  });
});

describePosix('formatPaneTail (dead-pane failure recap)', () => {
  it('keeps the last N non-empty lines, right-stripped, in order', () => {
    const raw = 'a  \n\n b\nc\t\n\n';
    expect(formatPaneTail(raw, 2)).toBe(' b\nc');
  });

  it('surfaces the real ENOENT crash a fast-failing agent leaves in the pane', () => {
    const raw = [
      'Error: spawn /Users/x/.agents/.history/versions/codex/0.116.0/node_modules/@openai/codex-darwin-arm64/vendor/aarch64-apple-darwin/codex/codex ENOENT',
      "    at ChildProcess._handle.onexit (node:internal/child_process:285:19)",
      '',
      'Pane is dead (status 1, Tue Jul  7 07:06:21 2026)',
    ].join('\n');
    const out = formatPaneTail(raw);
    expect(out).toContain('ENOENT');
    expect(out).toContain('Pane is dead (status 1');
    expect(out).not.toMatch(/\n\n/);
  });

  it('returns empty string for an all-whitespace capture', () => {
    expect(formatPaneTail('  \n\n\t\n')).toBe('');
  });
});

describePosix('buildTmuxAgentCommand (env-preserving pane command)', () => {
  it('execs the agent with a full env prefix (bare values need no quoting)', () => {
    const cmd = buildTmuxAgentCommand('claude', ['--permission-mode', 'plan'], {
      CLAUDE_CONFIG_DIR: '/home/me/.agents/versions/claude/2.1/home/.claude',
      PATH: '/usr/bin:/bin',
    });
    expect(cmd.startsWith('exec env ')).toBe(true);
    expect(cmd).toContain('CLAUDE_CONFIG_DIR=/home/me/.agents/versions/claude/2.1/home/.claude');
    expect(cmd).toContain('PATH=/usr/bin:/bin');
    expect(cmd).toMatch(/ claude --permission-mode plan$/);
  });

  it('quotes a value containing spaces and single quotes safely', () => {
    const cmd = buildTmuxAgentCommand('claude', ["it's a test"], { FOO: "a b'c" });
    expect(cmd).toContain("FOO='a b'\\''c'");
    expect(cmd).toContain("'it'\\''s a test'");
  });

  it('drops non-identifier keys so `env` does not choke on exported shell functions', () => {
    const cmd = buildTmuxAgentCommand('claude', [], {
      GOOD_KEY: '1',
      'BASH_FUNC_foo%%': '() { echo hi; }',
    });
    expect(cmd).toContain('GOOD_KEY=');
    expect(cmd).not.toContain('BASH_FUNC_foo');
  });

  it('does not forward undefined env values', () => {
    const cmd = buildTmuxAgentCommand('claude', [], { SET: 'x', UNSET: undefined });
    expect(cmd).toContain('SET=');
    expect(cmd).not.toContain('UNSET');
  });

  it('redacts secret VALUES but keeps KEY names when redactEnvValues is set (RUSH-1758)', () => {
    const cmd = buildTmuxAgentCommand(
      'claude',
      ['--permission-mode', 'plan'],
      { ANTHROPIC_API_KEY: 'sk-ant-supersecret', PATH: '/usr/bin:/bin' },
      { redactEnvValues: true },
    );
    expect(cmd).toContain('ANTHROPIC_API_KEY=<redacted>');
    expect(cmd).toContain('PATH=<redacted>');
    expect(cmd).toMatch(/ claude --permission-mode plan$/);
    expect(cmd).not.toContain('sk-ant-supersecret');
    expect(cmd).not.toContain('/usr/bin:/bin');
  });
});

describePosix('resolveLaunchId', () => {
  it('adopts a launcher-forwarded id verbatim (the cross-hop correlation key)', () => {
    expect(resolveLaunchId('LID-from-host-42')).toBe('LID-from-host-42');
  });

  it('mints a fresh uuid when no id was forwarded (every local run)', () => {
    expect(resolveLaunchId(undefined)).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('mints rather than adopt an empty/whitespace id — the key must be real', () => {
    expect(resolveLaunchId('')).toMatch(/^[0-9a-f-]{36}$/);
    expect(resolveLaunchId('   ')).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('trims a forwarded id so a stray newline never desyncs the join', () => {
    expect(resolveLaunchId('  LID-x  \n')).toBe('LID-x');
  });

  it('mints a DISTINCT id each call when none is forwarded', () => {
    expect(resolveLaunchId(undefined)).not.toBe(resolveLaunchId(undefined));
  });
});

describePosix('shouldRecapDeadPane', () => {
  it('(a) interactive exit-0 → true (harness never opened a REPL, surface a failure)', () => {
    expect(shouldRecapDeadPane(0, true)).toBe(true);
  });

  it('(a) interactive exit-undefined (treated as 0) → true', () => {
    expect(shouldRecapDeadPane(undefined, true)).toBe(true);
  });

  it('(b) nonzero exit, headless → true (crash, must surface)', () => {
    expect(shouldRecapDeadPane(1, false)).toBe(true);
  });

  it('(b) nonzero exit, interactive → true', () => {
    expect(shouldRecapDeadPane(2, true)).toBe(true);
  });

  it('exit-0, headless → false (completed successfully before attach)', () => {
    expect(shouldRecapDeadPane(0, false)).toBe(false);
  });

  it('exit-undefined, headless → false', () => {
    expect(shouldRecapDeadPane(undefined, false)).toBe(false);
  });
});

describePosix('isPaneKnownAliveFromQueryResult', () => {
  it('(c) code=0 stdout="0" → true (pane is definitively alive)', () => {
    expect(isPaneKnownAliveFromQueryResult(0, '0')).toBe(true);
  });

  it('(c) code=0 stdout="0\\n" → true (trailing newline is trimmed)', () => {
    expect(isPaneKnownAliveFromQueryResult(0, '0\n')).toBe(true);
  });

  it('(c) code=1 → false (query failed, treat as unreadable/dead — no orphan)', () => {
    expect(isPaneKnownAliveFromQueryResult(1, '')).toBe(false);
  });

  it('(c) code=0 stdout="1" → false (pane_dead=1, pane is dead)', () => {
    expect(isPaneKnownAliveFromQueryResult(0, '1')).toBe(false);
  });

  it('(c) code=0 stdout="" → false (empty output, inconclusive)', () => {
    expect(isPaneKnownAliveFromQueryResult(0, '')).toBe(false);
  });
});

describePosix('tmuxRunExitCode — an unknown outcome is never success', () => {
  it('reports the real status when tmux read one off a dead pane', () => {
    expect(tmuxRunExitCode({ dead: true, status: 0 }, false)).toBe(0);
    expect(tmuxRunExitCode({ dead: true, status: 3 }, false)).toBe(3);
    expect(tmuxRunExitCode({ dead: true, status: 137 }, false)).toBe(137);
  });

  it('a confirmed-alive pane is a clean user detach → 0', () => {
    expect(tmuxRunExitCode({ dead: false }, true)).toBe(0);
  });

  it('an unreadable pane (server/session gone) is NOT success', () => {
    expect(tmuxRunExitCode({ dead: false }, false)).toBe(UNKNOWN_OUTCOME_EXIT_CODE);
    expect(UNKNOWN_OUTCOME_EXIT_CODE).not.toBe(0);
  });

  it('a dead pane with no status reported is NOT success', () => {
    expect(tmuxRunExitCode({ dead: true, status: undefined }, false)).toBe(UNKNOWN_OUTCOME_EXIT_CODE);
  });

  it('agrees with the failure banner shouldRecapDeadPane fires for', () => {
    const status = undefined;
    expect(shouldRecapDeadPane(status, true)).toBe(true);
    expect(tmuxRunExitCode({ dead: true, status }, false)).toBe(1);
  });
});

const tmuxSkipReason = isTmuxInstalled() ? null : 'tmux not installed';
describePosix.skipIf(tmuxSkipReason)('paneExitStatus against a real tmux server that went away', () => {
  it('cannot read a pane whose server is gone → {found:false, dead:false}', async () => {
    const { createSession, killAll, paneExitStatus } = await import('./tmux/session.js');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tmux-exitcode-'));
    const socket = path.join(dir, 'srv.sock');
    try {
      const meta = await createSession({ name: 'ag-exitcode-probe', cmd: 'sleep 30', socket, source: 'cli' });
      const pane = meta.pane!;
      expect(pane).toMatch(/^%\d+$/);
      const alive = await paneExitStatus(pane, socket);
      expect(alive.found).toBe(true);
      expect(alive.dead).toBe(false);

      await killAll(socket);
      const orphaned = await paneExitStatus(pane, socket);
      expect(orphaned.found).toBe(false);
      expect(orphaned.dead).toBe(false);
      expect(orphaned.status).toBeUndefined();
      expect(tmuxRunExitCode(orphaned, false)).not.toBe(0);
    } finally {
      await killAll(socket).catch(() => {});
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('prepareSessionForResume returns the pane a resume-attach must query', async () => {
    const { createSession, killAll, prepareSessionForResume, paneExitStatus } = await import('./tmux/session.js');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tmux-resume-'));
    const socket = path.join(dir, 'srv.sock');
    try {
      const meta = await createSession({ name: 'ag-resume-probe', cmd: 'sleep 30', socket, source: 'cli' });
      const prep = await prepareSessionForResume('ag-resume-probe', socket);
      expect(prep.decision).toBe('attach');
      const pane = prep.decision === 'attach' ? prep.pane : undefined;
      expect(pane).toBe(meta.pane);
      expect(pane).toMatch(/^%\d+$/);

      await killAll(socket);
      const orphaned = await paneExitStatus(pane!, socket);
      expect(orphaned.found).toBe(false);
      expect(tmuxRunExitCode(orphaned, false)).not.toBe(0);
    } finally {
      await killAll(socket).catch(() => {});
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describePosix('tmux env file (no secret VALUE in the process table, RUSH-2100)', () => {
  const SECRET = 'a4d66e0acc150218-master-passphrase';

  it('keeps every value out of the pane command when envFile is set', () => {
    const cmd = buildTmuxAgentCommand('claude', ['--permission-mode', 'plan'], {
      AGENTS_SECRETS_PASSPHRASE: SECRET,
      ATTIO_API_KEY: 'df83ec4b-token',
      PATH: '/usr/bin:/bin',
    }, { envFile: '/run/agents/tmux-env/x.env' });
    expect(cmd).not.toContain(SECRET);
    expect(cmd).not.toContain('df83ec4b-token');
    expect(cmd).toContain('/run/agents/tmux-env/x.env');
    expect(cmd).toMatch(/exec claude --permission-mode plan$/);
    expect(cmd).toContain('rm -f ');
  });

  it('aborts the pane when the env file is missing rather than launching half-configured', () => {
    const cmd = buildTmuxAgentCommand('claude', [], {}, { envFile: '/nope.env' });
    expect(cmd).toContain('|| exit 1');
  });

  it('unlinks the env file even when sourcing fails, so secrets never strand on disk', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tmux-envfile-fail-'));
    const file = path.join(dir, 'pane.env');
    fs.writeFileSync(file, 'FOO=bar\nfalse\n', { mode: 0o600 });
    const cmd = buildTmuxAgentCommand('true', [], {}, { envFile: file });
    let exitCode = 0;
    try {
      execFileSync('sh', ['-c', cmd], { stdio: 'ignore' });
    } catch (err) {
      exitCode = (err as { status?: number }).status ?? 1;
    }
    expect(exitCode).not.toBe(0);
    expect(fs.existsSync(file)).toBe(false);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('writes a 0600 file a shell can source back to the exact values', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tmux-envfile-'));
    const file = path.join(dir, 'pane.env');
    writeTmuxEnvFile({
      AGENTS_SECRETS_PASSPHRASE: SECRET,
      TRICKY: "a b'c",
      UNSET: undefined,
      'BASH_FUNC_foo%%': '() { echo hi; }',
    }, file);

    expect((fs.statSync(file).mode & 0o777).toString(8)).toBe('600');
    const out = execFileSync('sh', ['-c', `set -a; . ${file}; printf '%s|%s' "$AGENTS_SECRETS_PASSPHRASE" "$TRICKY"`], { encoding: 'utf-8' });
    expect(out).toBe(`${SECRET}|a b'c`);
    const body = fs.readFileSync(file, 'utf-8');
    expect(body).not.toContain('UNSET');
    expect(body).not.toContain('BASH_FUNC_foo');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('refuses to reuse an existing path, so it cannot inherit a looser mode', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tmux-envfile-'));
    const file = path.join(dir, 'pane.env');
    fs.writeFileSync(file, 'PRE=1\n', { mode: 0o644 });
    expect(() => writeTmuxEnvFile({ A: '1' }, file)).toThrow(/EEXIST/);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describePosix('resolveLaunchBinary — is the harness actually on this machine (RUSH-2339)', () => {
  let home: string;
  let pathDir: string;

  function plantExecutable(file: string): void {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '#!/bin/sh\nexit 0\n');
    fs.chmodSync(file, 0o755);
  }

  const bunBin = execFileSync('sh', ['-c', 'command -v bun'], { encoding: 'utf-8' }).trim();
  const here = path.dirname(new URL(import.meta.url).pathname);
  const appRoot = path.resolve(here, '..', '..');

  function probe(agent: string, version?: string): string | null {
    const execPath = path.join(here, 'exec.ts');
    const script = `
      import { resolveLaunchBinary } from ${JSON.stringify(execPath)};
      const r = resolveLaunchBinary(${JSON.stringify(agent)}, ${JSON.stringify(version ?? null)} ?? undefined);
      console.log('__RESULT__' + JSON.stringify(r));
    `;
    const out = execFileSync(bunBin, ['-e', script], {
      cwd: appRoot,
      env: { ...process.env, HOME: home, PATH: [pathDir, '/usr/bin', '/bin'].join(path.delimiter) },
      stdio: ['ignore', 'pipe', 'inherit'],
    }).toString('utf-8');
    return JSON.parse(out.split('__RESULT__')[1]);
  }

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'launch-binary-home-'));
    pathDir = fs.mkdtempSync(path.join(os.tmpdir(), 'launch-binary-path-'));
    fs.mkdirSync(path.join(home, '.agents'), { recursive: true });
  });
  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(pathDir, { recursive: true, force: true });
  });

  it('resolves the version home binary for a managed install, with nothing on PATH', () => {
    const binary = path.join(home, '.agents', '.history', 'versions', 'claude', '9.9.9', 'node_modules', '.bin', 'claude');
    plantExecutable(binary);

    expect(probe('claude', '9.9.9')).toBe(binary);
  });

  it('resolves a manual PATH install that has no version home at all', () => {
    const binary = path.join(pathDir, 'cursor-agent');
    plantExecutable(binary);
    expect(fs.existsSync(path.join(home, '.agents', '.history', 'versions', 'cursor'))).toBe(false);

    expect(probe('cursor')).toBe(fs.realpathSync(binary));
  });

  it('returns null when the harness is installed neither as a version home nor on PATH', () => {
    expect(probe('cursor')).toBeNull();
    expect(probe('claude')).toBeNull();
  });

  it('returns null for a pinned version whose version home holds no binary', () => {
    fs.mkdirSync(path.join(home, '.agents', '.history', 'versions', 'claude', '9.9.9'), { recursive: true });

    expect(probe('claude', '9.9.9')).toBeNull();
  });

  it('does not count our own dispatcher shim as an install when no version is managed', () => {
    const shim = path.join(home, '.agents', '.cache', 'shims', 'cursor-agent');
    plantExecutable(shim);
    fs.symlinkSync(shim, path.join(pathDir, 'cursor-agent'));

    expect(probe('cursor')).toBeNull();
  });

  it('counts the shim as an install when a managed version exists but none is pinned', () => {
    const shim = path.join(home, '.agents', '.cache', 'shims', 'opencode');
    plantExecutable(shim);
    fs.symlinkSync(shim, path.join(pathDir, 'opencode'));
    plantExecutable(path.join(home, '.agents', '.history', 'versions', 'opencode', '1.16.0', 'node_modules', '.bin', 'opencode'));

    expect(probe('opencode')).toBe(fs.realpathSync(shim));
  });

  it('prefers the versioned shim over the version home binary, matching buildExecCommand', () => {
    const versionedShim = path.join(home, '.agents', '.cache', 'shims', 'claude@9.9.9');
    plantExecutable(versionedShim);
    plantExecutable(path.join(home, '.agents', '.history', 'versions', 'claude', '9.9.9', 'node_modules', '.bin', 'claude'));

    expect(probe('claude', '9.9.9')).toBe(versionedShim);
  });
});

describe('buildExecEnv — Claude ambient CLAUDE_CODE_OAUTH_TOKEN handling (RUSH-2360)', () => {
  let versionDirs: string[] = [];
  let prevClaudeToken: string | undefined;
  let prevMachineId: string | undefined;

  useFreshSecretsHome();
  beforeEach(() => {
    versionDirs = [];
    prevClaudeToken = process.env.CLAUDE_CODE_OAUTH_TOKEN;
    prevMachineId = process.env.AGENTS_SYNC_MACHINE_ID;
    process.env.AGENTS_SYNC_MACHINE_ID = 'rush-2360-worker-fixture';
  });

  afterEach(() => {
    if (prevClaudeToken === undefined) delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    else process.env.CLAUDE_CODE_OAUTH_TOKEN = prevClaudeToken;
    if (prevMachineId === undefined) delete process.env.AGENTS_SYNC_MACHINE_ID;
    else process.env.AGENTS_SYNC_MACHINE_ID = prevMachineId;
    for (const dir of versionDirs) fs.rmSync(dir, { recursive: true, force: true });
  });

  function makeVersionHome(email: string): { version: string; configDir: string } {
    const version = `rush-2360-exec-test-${process.pid}-${versionDirs.length}`;
    const versionHome = getVersionHomePath('claude', version);
    versionDirs.push(path.dirname(versionHome));
    const configDir = path.join(versionHome, '.claude');
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(
      path.join(configDir, '.claude.json'),
      JSON.stringify({ oauthAccount: { emailAddress: email } }),
    );
    return { version, configDir };
  }

  function writeAuthBundle(values: Record<string, string>): void {
    const bundle: SecretsBundle = { name: 'auth', backend: 'file', policy: 'never', vars: {} };
    const items = new Map<string, string>();
    for (const [key, value] of Object.entries(values)) {
      items.set(secretsKeychainItem('auth', key), value);
      bundle.vars[key] = keychainRef(key);
    }
    writeBundleWithItemsSync(bundle, items);
  }

  it('strips an ambient inherited CLAUDE_CODE_OAUTH_TOKEN when NO setup-token resolves (the provisioned-box leak)', () => {
    const { version } = makeVersionHome('alpha@example.com');
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'sk-ant-oat01-shared-rotating-must-be-stripped';

    const env = buildExecEnv(execOpts({ agent: 'claude', version, prompt: 'do the thing' }));

    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
  });

  it('still injects a resolved per-account setup-token on a non-interactive run (no regression)', () => {
    const { version } = makeVersionHome('alpha@example.com');
    writeAuthBundle({ [claudeAccountTokenKey('alpha@example.com')]: 'sk-ant-oat01-alpha' });
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'sk-ant-oat01-shared-must-not-win';

    const env = buildExecEnv(execOpts({ agent: 'claude', version, prompt: 'do the thing' }));

    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe('sk-ant-oat01-alpha');
  });
});


describe('classifyClaudeRunRefusal (RUSH-3018 — persist/clear decision on the real path)', () => {
  it('detectOutOfCredits matches billing exhaustion but NOT a time-window rate limit', () => {
    expect(detectOutOfCredits("You're out of usage credits")).toBe(true);
    expect(detectOutOfCredits("hit your org's monthly spend limit")).toBe(true);
    expect(detectOutOfCredits('You have hit your session limit · resets 11:20pm')).toBe(false);
    expect(detectOutOfCredits('rate limit exceeded, try again')).toBe(false);
  });

  it('a session-limit refusal wins and carries its reset clock', () => {
    const r = classifyClaudeRunRefusal('You have hit your session limit · resets 11:20pm', 1);
    expect(r.action).toBe('note_session');
    if (r.action === 'note_session') expect(r.resetsAt).toBeInstanceOf(Date);
  });

  it('a billing exhaustion is note_out_of_credits (no clock)', () => {
    expect(classifyClaudeRunRefusal("You're out of usage credits", 1)).toEqual({ action: 'note_out_of_credits' });
    expect(classifyClaudeRunRefusal('monthly spend limit reached', 1)).toEqual({ action: 'note_out_of_credits' });
  });

  it('a clean run (exit 0, no refusal) clears any stale marker', () => {
    expect(classifyClaudeRunRefusal('all good, done', 0)).toEqual({ action: 'clear' });
  });

  it('a non-zero exit with no recognized refusal leaves the marker untouched', () => {
    expect(classifyClaudeRunRefusal('some unrelated error', 1)).toEqual({ action: 'none' });
  });

  it('the exact real Fable refusal is a distinct model-limit action, not a global clear', () => {
    const text = "You've reached your Fable limit. Run /usage-credits to continue or switch models with /model.";
    expect(classifyClaudeRunRefusal(text, 0, 'claude-fable-5-1')).toEqual({
      action: 'note_model_limit',
      model: 'claude-fable-5-1',
      family: 'Fable',
    });
    expect(classifyClaudeRunRefusal(text, 1, 'claude-fable-5-1')).toEqual({
      action: 'note_model_limit',
      model: 'claude-fable-5-1',
      family: 'Fable',
    });
  });

  it('a model-limit refusal is never classified as note_out_of_credits', () => {
    const text = "You've reached your Fable limit. Run /usage-credits to continue or switch models with /model.";
    const r = classifyClaudeRunRefusal(text, 1, 'claude-fable-5-1');
    expect(r.action).not.toBe('note_out_of_credits');
    expect(r.action).not.toBe('clear');
  });

  it('falls back to the parsed family name as the model key when no model was supplied', () => {
    const text = "You've reached your Fable limit. Run /usage-credits to continue or switch models with /model.";
    expect(classifyClaudeRunRefusal(text, 0)).toEqual({
      action: 'note_model_limit',
      model: 'Fable',
      family: 'Fable',
    });
  });
});

describe('classifyCodexRunRefusal (PHNX-3859 — codex account marked so rotation stops re-picking it)', () => {
  const REAL =
    "ERROR: You've hit your usage limit. Visit https://chatgpt.com/codex/settings/usage " +
    'to purchase more credits or try again at Sep 12th, 2026 8:32 AM.';

  it("codex's usage-limit reset parses to a future Date (ordinal suffix stripped)", () => {
    const now = Date.parse('2026-09-06T00:00:00Z');
    const reset = parseCodexUsageLimitReset(REAL, now);
    expect(reset).toBeInstanceOf(Date);
    expect(reset!.getTime()).toBeGreaterThan(now);
    expect(reset!.getTime()).toBe(Date.parse('Sep 12, 2026 8:32 AM'));
  });

  it('a time-only reset resolves against today/tomorrow', () => {
    const now = Date.parse('2026-09-06T08:00:00Z');
    const reset = parseCodexUsageLimitReset(
      "You've hit your usage limit. try again at 8:32 AM.",
      now,
    );
    expect(reset).toBeInstanceOf(Date);
    expect(reset!.getTime()).toBeGreaterThan(now);
  });

  it('the real usage-limit run is note_session with its reset clock — NOT sticky out_of_credits', () => {
    const now = Date.parse('2026-09-06T00:00:00Z');
    const r = classifyCodexRunRefusal(REAL, 1, now);
    expect(r.action).toBe('note_session');
    if (r.action === 'note_session') expect(r.resetsAt.getTime()).toBeGreaterThan(now);
  });

  it('a clock-less credit/quota exhaustion is note_out_of_credits', () => {
    expect(classifyCodexRunRefusal("You're out of usage credits", 1)).toEqual({
      action: 'note_out_of_credits',
    });
  });

  it('a clean run (exit 0) clears any stale marker', () => {
    expect(classifyCodexRunRefusal('done: `main`', 0)).toEqual({ action: 'clear' });
  });

  it('does NOT fire on transcript content that merely mentions "usage limit" (false-positive guard)', () => {
    const transcript =
      'Looking at the usage limit handling in billing.ts — the docs say try again at Sep 12th, 2026 8:32 AM if exceeded.';
    expect(parseCodexUsageLimitReset(transcript)).toBeNull();
    expect(classifyCodexRunRefusal(transcript, 1)).toEqual({ action: 'none' });
  });

  it('a reset already in the past is not noted (window recovered), never rolled to a clock', () => {
    const now = Date.parse('2026-09-20T00:00:00Z');
    expect(parseCodexUsageLimitReset(REAL, now)).toBeNull();
    expect(classifyCodexRunRefusal(REAL, 1, now)).toEqual({ action: 'none' });
  });

  it('a usage limit with no parseable reset is left untouched, never persisted as unexpirable', () => {
    expect(classifyCodexRunRefusal("You've hit your usage limit.", 1)).toEqual({ action: 'none' });
    expect(parseCodexUsageLimitReset("You've hit your usage limit.")).toBeNull();
  });

  it('an unrelated non-zero exit leaves the marker untouched', () => {
    expect(classifyCodexRunRefusal('some unrelated error', 1)).toEqual({ action: 'none' });
    expect(parseCodexUsageLimitReset('some unrelated error')).toBeNull();
  });
});
