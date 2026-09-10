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
import { keychainRef, secretsKeychainItem, writeBundleWithItemsSync } from './secrets-client.js';
import type { SecretsBundle } from './secrets-types.js';
import { useFreshSecretsHome } from '../../tests/secrets-standalone.js';
import { claudeAccountTokenKey } from './claude-account-token.js';

// RUSH-2215: do not skip the whole file on win32 — Windows-specific suites
// (e.g. resolveShimSpawn .cmd) and pure string/auth detectors must run.
// Only tmux / multiplex-style suites are POSIX-process oriented.
const describePosix = process.platform === 'win32' ? describe.skip : describe;

// Real logged-out Claude stream-json tail, captured from an actual failed
// routine run on disk (drain-linear-cli, 2026-07-27). Ground truth: `terminal_reason`
// is "completed", so only the `error:"authentication_failed"` marker and the
// `result`+`is_error` text can classify it.
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

// Entire stdout from a real logged-out Cursor 2026.07.23 routine run. Cursor
// exits before stream-json initialization, so raw-text classification is the
// only available signal.
const LOGGED_OUT_CURSOR_LOG =
  "Error: Authentication required. Please run 'agent login' first, or set CURSOR_API_KEY environment variable.";

// A COMPLETED run whose report text merely mentions the phrase "Not logged in"
// (e.g. a routine summarizing an auth doc). Must NOT be classified as an auth
// failure — the structural signal is is_error:false.
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
    expect(detectAuthFailureEvent(LOGGED_OUT_CLAUDE_LOG, 'gemini')).toBe(false);
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
    // Structural marker is authoritative even on a clean (exit 0) process.
    expect(isAuthFailureFromLog(LOGGED_OUT_CLAUDE_LOG, 'claude', { processFailed: false })).toBe(true);
    expect(isAuthFailureFromLog(LOGGED_OUT_CLAUDE_LOG, 'claude', { processFailed: true })).toBe(true);
  });

  it('does NOT classify a completed run that merely mentions an auth phrase (the false-positive bug)', () => {
    // is_error:false → structural false; and processFailed:false → raw text is
    // not consulted. This is the exact case that used to suppress a good report.
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
    // The log contains both "Failed to authenticate" and "OAuth access token has
    // been revoked"; the more specific revoked phrase is preferred (pattern order).
    expect(authFailureReason(LOGGED_OUT_CLAUDE_LOG)).toBe('OAuth access token has been revoked');
  });

  it('returns null when no user-visible phrase is present', () => {
    expect(authFailureReason('all good here')).toBeNull();
  });
});

/** Minimal ExecOptions with required fields, overridable per test. */
function execOpts(over: Partial<ExecOptions> & { agent: ExecOptions['agent'] }): ExecOptions {
  return { mode: 'plan', effort: 'auto', ...over } as ExecOptions;
}

/** Find the index of the first occurrence of `tok` in argv (-1 if absent). */
function idx(cmd: string[], tok: string): number {
  return cmd.indexOf(tok);
}

/**
 * Run `fn` with `keys` absent from `process.env`, restoring whatever was
 * there afterwards. `buildExecEnv` starts from `{...process.env}` and only
 * conditionally overwrites a handful of keys (AGENT_SESSION_ID,
 * AGENTS_MAILBOX_DIR, DISABLE_AUTOUPDATER, ...) — a test asserting one of
 * those is `undefined` for a case that doesn't set it is really asserting
 * "buildExecEnv doesn't inject a value on top of nothing", which only holds
 * when the process actually started with nothing there. This test suite runs
 * inside real `agents run`-launched sessions (including this very repo's own
 * dev loop), which carry every one of these vars in their own environment —
 * so an un-isolated assertion here passes on a clean CI runner and fails the
 * moment it runs inside a live agent session (RUSH-2749).
 */
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
    // Session id is exported so agent tools (`agents feed post`) auto-attribute.
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

describe('buildExecEnv — custom harness identity (PHNX-2935)', () => {
  it('stamps AGENTS_AGENT_NAME with the profile name, not the host CLI', () => {
    // The bug: `agents run deepseek` resolved the host to claude and then
    // stamped AGENTS_AGENT_NAME=claude, so feed posts and sessions could not
    // tell a deepseek run from a native claude run.
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

describe('buildExecEnv — Claude Code auto-updater suppression for pinned managed installs', () => {
  it('injects DISABLE_AUTOUPDATER=1 for a managed (pinned) claude version', () => {
    // Pinned per-version installs must never self-mutate: Claude Code's own
    // background auto-updater would rewrite the pinned binary in place.
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
  it('opencode and gemini do not (they fall back to /continue replay)', () => {
    expect(nativeResume('opencode')).toBe(false);
    expect(nativeResume('gemini')).toBe(false);
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

  // state.ts caches HOME at module load, so set HOME then re-import exec.js fresh.
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

  // Regression for `spawn kimi@0.19.2 ENOENT`: when a specific version is requested
  // and no versioned shim exists on disk, we must resolve the version's REAL binary
  // — never leave the bare `<agent>@<version>` literal as argv[0] (it's not on PATH).
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
    // Only skip may bypass approvals/sandbox — edit resumes stay sandboxed.
    expect(cmd).not.toContain('--dangerously-bypass-approvals-and-sandbox');
    expect(cmd).toContain('default_permissions="agents-edit"');
    expect(cmd.join(' ')).toContain('extends = ":workspace"');
    expect(cmd.join(' ')).toContain('network = { enabled = true, allow_local_binding = true }');
    expect(idx(cmd, 'xyz-9')).toBeGreaterThan(idx(cmd, 'resume'));
    expect(idx(cmd, 'go')).toBeGreaterThan(idx(cmd, 'xyz-9'));
    // codex's `exec resume` does NOT accept --sandbox; it must not leak through.
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
    const cmd = buildExecCommand(execOpts({ agent: 'gemini', resume: true, sessionId: 'qqq', headless: true, prompt: 'go' }));
    expect(cmd).not.toContain('--resume');
    expect(cmd).not.toContain('qqq');
  });
});

describe('shouldTapStdout (budget live-watcher attach gating, #346 FIX 3)', () => {
  // The regression FIX 3 fixes: a headless run AT A TERMINAL (piped=false) with
  // caps active used to leave stdout 'inherit', so child.stdout was null and the
  // live hard-cap kill never engaged. The watcher must now attach there too.
  it('TAPS a non-interactive run at a TTY when caps are active (the FIX 3 case)', () => {
    expect(shouldTapStdout(/*interactive*/ false, /*piped*/ false, /*capsActive*/ true)).toBe(true);
  });

  it('does NOT tap a non-interactive run at a TTY when no caps are configured', () => {
    // Zero-overhead for budget non-users: no watcher, no pipe, stdout stays inherit.
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

  // Fallback chains need a stdout tail: Claude prints billing refusals (spend
  // limit / out of credits) to stdout, so a stderr-only scan never cascades.
  it('taps when a fallback chain requests a stdout tail, even at a TTY with no caps', () => {
    expect(shouldTapStdout(false, false, false, /*captureTail*/ true)).toBe(true);
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
    // No unescaped args array left for Node to concatenate: the command is the
    // whole quoted line and args is empty.
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
    // The injection/splitting surface: a multi-word prompt and cmd metacharacters
    // must survive as ONE argument to the child, not be split or interpreted.
    const r = resolveShimSpawn('win32', 'C:\\bin\\claude.cmd', ['-p', 'review my code & ship']);
    expect(r.command).toBe('C:\\bin\\claude.cmd -p "review my code & ship"');
    expect(r.args).toEqual([]);
    expect(r.shell).toBe(true);
  });
});

describePosix('resolveTmuxWrap (interactive spawn-wrap gate)', () => {
  /** The wrap-eligible baseline: interactive, macOS, not nested, no opt-out, tmux present. */
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
    // The config opt-out is independent of the per-run ones: it holds even when
    // tmux is installed and no flag/env was passed.
    expect(resolveTmuxWrap({ ...base, configEnabled: false, tmuxAvailable: true, raw: false }).kind).toBe('bare');
  });

  // PHNX-3316: tmux.enabled=false means NO wrap, local or remote. A followed
  // --device run left bare is protected by reconnect-and-resume (hosts/
  // reconnect.ts), not by a pane. The RUSH-3125 forced wrap conflated
  // durability with an ergonomics preference and wrapped boxes whose operator
  // had explicitly left tmux off.
  it('does NOT wrap a followed REMOTE-dispatched run when this device set tmux.enabled=false', () => {
    expect(resolveTmuxWrap({ ...base, configEnabled: false, remoteDispatch: true }).kind).toBe('bare');
    // …even when tmux is missing — nothing requested the wrap, so there is
    // nothing to refuse.
    expect(resolveTmuxWrap({ ...base, configEnabled: false, remoteDispatch: true, tmuxAvailable: false }).kind).toBe('bare');
  });

  it('refuses a remote-dispatched run that WANTS the wrap when tmux is missing, instead of spawning something a blink would kill', () => {
    expect(resolveTmuxWrap({ ...base, remoteDispatch: true, tmuxAvailable: false }).kind).toBe('undurable');
    // A LOCAL run with no tmux is merely unwrapped — nothing about it needs to
    // outlive a network link, so it must not be refused.
    expect(resolveTmuxWrap({ ...base, remoteDispatch: false, tmuxAvailable: false }).kind).toBe('bare');
  });

  it('does not wrap a LOCAL interactive run with no TTY (piped tests must not leak panes)', () => {
    expect(resolveTmuxWrap({ ...base, hasTty: false }).kind).toBe('bare');
  });

  it('still wraps a followed REMOTE run whose launcher has no TTY, even with tmux.enabled=false (the pane is its only interface)', () => {
    // A launcher without a TTY (CI, scripts, another agent) gives the peer
    // nothing to attach to, so the pane is infrastructure, not ergonomics —
    // the config toggle does not reach this case.
    expect(resolveTmuxWrap({ ...base, hasTty: false, remoteDispatch: true }).kind).toBe('wrap');
    expect(resolveTmuxWrap({ ...base, hasTty: false, remoteDispatch: true, configEnabled: false }).kind).toBe('wrap');
    // …and with no tmux on the peer there is no pane to hold it: refuse.
    expect(resolveTmuxWrap({ ...base, hasTty: false, remoteDispatch: true, configEnabled: false, tmuxAvailable: false }).kind).toBe('undurable');
  });

  it('lets the explicit per-run opt-outs beat the durability rule', () => {
    // --raw / AGENTS_NO_TMUX must keep working on a remote box: an escape hatch
    // that silently stops applying over --device is worse than an undurable run
    // the user explicitly asked for.
    expect(resolveTmuxWrap({ ...base, remoteDispatch: true, raw: true }).kind).toBe('bare');
    expect(resolveTmuxWrap({ ...base, remoteDispatch: true, noTmuxEnv: true }).kind).toBe('bare');
    // …and an opted-out remote run with no tmux is 'bare', never 'undurable'.
    expect(resolveTmuxWrap({ ...base, remoteDispatch: true, raw: true, tmuxAvailable: false }).kind).toBe('bare');
  });
});

describePosix('formatPaneTail (dead-pane failure recap)', () => {
  it('keeps the last N non-empty lines, right-stripped, in order', () => {
    const raw = 'a  \n\n b\nc\t\n\n';
    expect(formatPaneTail(raw, 2)).toBe(' b\nc');
  });

  it('surfaces the real ENOENT crash a fast-failing agent leaves in the pane', () => {
    // The exact class of output that used to be swallowed by the bare [detached].
    const raw = [
      'Error: spawn /Users/x/.agents/.history/versions/codex/0.116.0/node_modules/@openai/codex-darwin-arm64/vendor/aarch64-apple-darwin/codex/codex ENOENT',
      "    at ChildProcess._handle.onexit (node:internal/child_process:285:19)",
      '',
      'Pane is dead (status 1, Tue Jul  7 07:06:21 2026)',
    ].join('\n');
    const out = formatPaneTail(raw);
    expect(out).toContain('ENOENT');
    expect(out).toContain('Pane is dead (status 1');
    expect(out).not.toMatch(/\n\n/); // blank lines dropped
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
    // Safe values (only [A-Za-z0-9_./:=@%+-]) pass through shellQuote unquoted.
    expect(cmd).toContain('CLAUDE_CONFIG_DIR=/home/me/.agents/versions/claude/2.1/home/.claude');
    expect(cmd).toContain('PATH=/usr/bin:/bin');
    // The agent + its args land after the env prefix.
    expect(cmd).toMatch(/ claude --permission-mode plan$/);
  });

  it('quotes a value containing spaces and single quotes safely', () => {
    const cmd = buildTmuxAgentCommand('claude', ["it's a test"], { FOO: "a b'c" });
    // shellQuote wraps in single quotes and escapes embedded ones — no unquoted breakout.
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
    // Key names + agent command survive for provenance…
    expect(cmd).toContain('ANTHROPIC_API_KEY=<redacted>');
    expect(cmd).toContain('PATH=<redacted>');
    expect(cmd).toMatch(/ claude --permission-mode plan$/);
    // …but no real value leaks into the (persisted) string.
    expect(cmd).not.toContain('sk-ant-supersecret');
    expect(cmd).not.toContain('/usr/bin:/bin');
  });
});

// resolveLaunchId is the one place that decides AGENT_LAUNCH_ID for a run. A
// `--device` launcher forwards an id it controls so ONE correlation key spans the
// SSH hop (RUSH-2034); every local run passes none and gets a fresh mint. The
// adopt-vs-mint decision is what lets the launcher resolve a non-Claude agent's
// real remote session id from the hook record afterwards.
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

// ─────────────────────────────────────────────────────────────────────────────
// runInTmux exit-classification (RUSH-2185 / EXEC-23a)
//
// Three scenarios that must produce the right action.  The functions
// shouldRecapDeadPane and isPaneKnownAliveFromQueryResult are pure extractions
// of the decision logic inside runInTmux — testable without a real tmux process.
// ─────────────────────────────────────────────────────────────────────────────
describePosix('shouldRecapDeadPane', () => {
  // (a) Interactive exit-0 fast-fail — the harness exited cleanly without ever
  // opening a REPL.  The user sees only a bare `[detached]`; we must surface a
  // failure banner even though the exit code is 0.
  it('(a) interactive exit-0 → true (harness never opened a REPL, surface a failure)', () => {
    expect(shouldRecapDeadPane(0, true)).toBe(true);
  });

  it('(a) interactive exit-undefined (treated as 0) → true', () => {
    expect(shouldRecapDeadPane(undefined, true)).toBe(true);
  });

  // (b) Nonzero exit (headless or interactive) — always recap, same as before.
  it('(b) nonzero exit, headless → true (crash, must surface)', () => {
    expect(shouldRecapDeadPane(1, false)).toBe(true);
  });

  it('(b) nonzero exit, interactive → true', () => {
    expect(shouldRecapDeadPane(2, true)).toBe(true);
  });

  // Clean exit in a headless run — not a failure; stay quiet.
  it('exit-0, headless → false (completed successfully before attach)', () => {
    expect(shouldRecapDeadPane(0, false)).toBe(false);
  });

  it('exit-undefined, headless → false', () => {
    expect(shouldRecapDeadPane(undefined, false)).toBe(false);
  });
});

describePosix('isPaneKnownAliveFromQueryResult', () => {
  // (c) Positive proof the pane is alive — tmux returned exactly "0".
  it('(c) code=0 stdout="0" → true (pane is definitively alive)', () => {
    expect(isPaneKnownAliveFromQueryResult(0, '0')).toBe(true);
  });

  it('(c) code=0 stdout="0\\n" → true (trailing newline is trimmed)', () => {
    expect(isPaneKnownAliveFromQueryResult(0, '0\n')).toBe(true);
  });

  // Query failed (race with pane-died hook) — must NOT be treated as alive.
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

// EXEC-23b. The bug: an interactive run whose tmux server died mid-work returned
// exitCode 0. `agents run codex --interactive --device <box>` printed a failure
// banner ("[server exited unexpectedly]", codex stranded at an approval prompt)
// and still handed its caller a success code, so anything scripting `agents run`
// counted a killed run as a clean finish.
describePosix('tmuxRunExitCode — an unknown outcome is never success', () => {
  it('reports the real status when tmux read one off a dead pane', () => {
    expect(tmuxRunExitCode({ dead: true, status: 0 }, false)).toBe(0);
    expect(tmuxRunExitCode({ dead: true, status: 3 }, false)).toBe(3);
    expect(tmuxRunExitCode({ dead: true, status: 137 }, false)).toBe(137);
  });

  it('a confirmed-alive pane is a clean user detach → 0', () => {
    expect(tmuxRunExitCode({ dead: false }, true)).toBe(0);
  });

  // The regression: both of these returned 0 before, via `status ?? 0`.
  it('an unreadable pane (server/session gone) is NOT success', () => {
    // What paneExitStatus returns when tmux cannot answer at all.
    expect(tmuxRunExitCode({ dead: false }, false)).toBe(UNKNOWN_OUTCOME_EXIT_CODE);
    expect(UNKNOWN_OUTCOME_EXIT_CODE).not.toBe(0);
  });

  it('a dead pane with no status reported is NOT success', () => {
    expect(tmuxRunExitCode({ dead: true, status: undefined }, false)).toBe(UNKNOWN_OUTCOME_EXIT_CODE);
  });

  // The banner at that branch prints `exit ${status ?? 1}` while the old code
  // returned `status ?? 0` — message and exit code disagreed in exactly the
  // unknown case. They are one computation now.
  it('agrees with the failure banner shouldRecapDeadPane fires for', () => {
    const status = undefined;
    expect(shouldRecapDeadPane(status, true)).toBe(true);
    expect(tmuxRunExitCode({ dead: true, status }, false)).toBe(1);
  });
});

// The unknown-outcome input above is a real tmux state, not a hypothetical:
// a server that goes away leaves paneExitStatus unable to answer. Proven
// against real tmux — no mocking. Skipped whole when tmux is absent, matching
// tmux/session.test.ts:37 — this is the first tmux-server-spawning suite in
// this file, so a bare image would otherwise fail here where its sibling skips.
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
      // Alive: tmux answers, and the run would resolve to a clean detach.
      const alive = await paneExitStatus(pane, socket);
      expect(alive.found).toBe(true);
      expect(alive.dead).toBe(false);

      // Server gone — exactly the "[server exited unexpectedly]" case.
      await killAll(socket);
      const orphaned = await paneExitStatus(pane, socket);
      expect(orphaned.found).toBe(false);
      expect(orphaned.dead).toBe(false);
      expect(orphaned.status).toBeUndefined();
      // That state MUST NOT resolve to success.
      expect(tmuxRunExitCode(orphaned, false)).not.toBe(0);
    } finally {
      await killAll(socket).catch(() => {});
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  // The resume-attach path had the same defect: it returned a hardcoded 0
  // without ever asking tmux. It can only ask if prepareSessionForResume hands
  // back the pane it resolved, so that handle is the fix's load-bearing part.
  it('prepareSessionForResume returns the pane a resume-attach must query', async () => {
    const { createSession, killAll, prepareSessionForResume, paneExitStatus } = await import('./tmux/session.js');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tmux-resume-'));
    const socket = path.join(dir, 'srv.sock');
    try {
      const meta = await createSession({ name: 'ag-resume-probe', cmd: 'sleep 30', socket, source: 'cli' });
      const prep = await prepareSessionForResume('ag-resume-probe', socket);
      expect(prep.decision).toBe('attach');
      // The handle must be real and usable — a resume-attach reads THIS pane.
      const pane = prep.decision === 'attach' ? prep.pane : undefined;
      expect(pane).toBe(meta.pane);
      expect(pane).toMatch(/^%\d+$/);

      // And once the server is gone under that resumed session, the outcome is
      // unknown — the resume path must not report success either.
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
    // The whole point: `ps` shows the file path, never a value.
    expect(cmd).not.toContain(SECRET);
    expect(cmd).not.toContain('df83ec4b-token');
    expect(cmd).toContain('/run/agents/tmux-env/x.env');
    // Still execs the agent as the pane leaf, and unlinks before it does.
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
    // A file that exists and sources with a non-zero result (the trailing
    // `false`), the RUSH-2100 strand case: the old `. f || exit 1; rm -f f`
    // took the `exit` before the `rm`, leaving the plaintext secrets on disk.
    fs.writeFileSync(file, 'FOO=bar\nfalse\n', { mode: 0o600 });
    const cmd = buildTmuxAgentCommand('true', [], {}, { envFile: file });
    let exitCode = 0;
    try {
      execFileSync('sh', ['-c', cmd], { stdio: 'ignore' });
    } catch (err) {
      exitCode = (err as { status?: number }).status ?? 1;
    }
    // Aborted (didn't launch half-configured) AND the secrets file is gone.
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
    // Round-trip through a real shell — the file must be sourceable, not just text.
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

// RUSH-2339: `agents run <agent>` on a machine without that harness used to exec a
// nonexistent binary and die with `sh: 1: exec: cursor-agent: not found` (exit 127),
// after a "looks logged out" banner that was also wrong. commands/exec.ts probes
// resolveLaunchBinary before spawning, so this resolver is the whole gate.
//
// Driven in a subprocess with a planted temp HOME: the state paths (versions dir,
// shims dir) are module-eval constants read from process.env.HOME, so an in-process
// override cannot move them. Same pattern as versions.isolation.integration.test.ts.
// No mocks — real files on a real PATH.
describePosix('resolveLaunchBinary — is the harness actually on this machine (RUSH-2339)', () => {
  let home: string;
  let pathDir: string;

  /** Plant an executable stub at `file`. */
  function plantExecutable(file: string): void {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '#!/bin/sh\nexit 0\n');
    fs.chmodSync(file, 0o755);
  }

  // Absolute path so the subprocess can be launched with a PATH that deliberately
  // holds only the planted dir — putting bun's own dir on PATH would smuggle in
  // whatever else lives beside it.
  const bunBin = execFileSync('sh', ['-c', 'command -v bun'], { encoding: 'utf-8' }).trim();
  // Anchor on this file, not process.cwd() — vitest inherits the invoking shell's
  // cwd, so a run started from the repo root would resolve neither path.
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

  // (a) The managed case: agents-cli owns a version home for this agent.
  it('resolves the version home binary for a managed install, with nothing on PATH', () => {
    const binary = path.join(home, '.agents', '.history', 'versions', 'claude', '9.9.9', 'node_modules', '.bin', 'claude');
    plantExecutable(binary);

    expect(probe('claude', '9.9.9')).toBe(binary);
  });

  // (b) The self-installed case: Homebrew / `curl | sh` / a distro package put the
  // harness on PATH and agents-cli manages no version home for it. This is a
  // SUPPORTED state — a naive `listInstalledVersions(agent).length === 0` guard
  // would break it, so it must still resolve.
  it('resolves a manual PATH install that has no version home at all', () => {
    const binary = path.join(pathDir, 'cursor-agent');
    plantExecutable(binary);
    expect(fs.existsSync(path.join(home, '.agents', '.history', 'versions', 'cursor'))).toBe(false);

    expect(probe('cursor')).toBe(fs.realpathSync(binary));
  });

  // (c) The bug: nothing installed anywhere. Must be null so the caller fails loud
  // instead of spawning a name that does not resolve and exiting 127.
  it('returns null when the harness is installed neither as a version home nor on PATH', () => {
    expect(probe('cursor')).toBeNull();
    expect(probe('claude')).toBeNull();
  });

  // (c') A version pinned whose version home is empty is equally not installed —
  // buildExecCommand would spawn the literal `claude@9.9.9`, which is on no PATH.
  it('returns null for a pinned version whose version home holds no binary', () => {
    fs.mkdirSync(path.join(home, '.agents', '.history', 'versions', 'claude', '9.9.9'), { recursive: true });

    expect(probe('claude', '9.9.9')).toBeNull();
  });

  // (c'') The exact repro shape: the ONLY `cursor-agent` on PATH is our own
  // dispatcher shim (or a link into the shims dir), and agents-cli owns no
  // version of the agent. That shim is a dead end — counting it re-creates the 127.
  it('does not count our own dispatcher shim as an install when no version is managed', () => {
    const shim = path.join(home, '.agents', '.cache', 'shims', 'cursor-agent');
    plantExecutable(shim);
    fs.symlinkSync(shim, path.join(pathDir, 'cursor-agent'));

    expect(probe('cursor')).toBeNull();
  });

  // The other half of that rule, and a regression this fix originally introduced:
  // a managed version exists but no default is PINNED, so resolveVersion returns
  // null. The shim launches fine here — it resolves the version itself and prints
  // its own `no default set … agents use` guidance — so calling this "not
  // installed" would name the wrong fix (`agents add`) on a machine that already
  // has the harness.
  it('counts the shim as an install when a managed version exists but none is pinned', () => {
    const shim = path.join(home, '.agents', '.cache', 'shims', 'opencode');
    plantExecutable(shim);
    fs.symlinkSync(shim, path.join(pathDir, 'opencode'));
    plantExecutable(path.join(home, '.agents', '.history', 'versions', 'opencode', '1.16.0', 'node_modules', '.bin', 'opencode'));

    expect(probe('opencode')).toBe(fs.realpathSync(shim));
  });

  // The version-pinned branch mirrors buildExecCommand, which prefers the
  // versioned shim over the version home's binary.
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

  // The reserved `auth` bundle lives behind the standalone `secrets` CLI; each
  // test gets an empty state root (tests/setup.ts pins no-broker + passphrase).
  useFreshSecretsHome();
  beforeEach(() => {
    versionDirs = [];
    prevClaudeToken = process.env.CLAUDE_CODE_OAUTH_TOKEN;
    prevMachineId = process.env.AGENTS_SYNC_MACHINE_ID;
    // These cases assert WORKER (headless) credential semantics. Pin the self
    // device id to a name that carries no role mark so selfConfiguredDeviceRole()
    // resolves undefined (worker-equivalent) — otherwise, run on a machine marked
    // `config.role: personal` (e.g. zion), the personal-device gate would defer to
    // the login and these assertions would flip (RUSH-2395).
    process.env.AGENTS_SYNC_MACHINE_ID = 'rush-2360-worker-fixture';
  });

  afterEach(() => {
    if (prevClaudeToken === undefined) delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    else process.env.CLAUDE_CODE_OAUTH_TOKEN = prevClaudeToken;
    if (prevMachineId === undefined) delete process.env.AGENTS_SYNC_MACHINE_ID;
    else process.env.AGENTS_SYNC_MACHINE_ID = prevMachineId;
    for (const dir of versionDirs) fs.rmSync(dir, { recursive: true, force: true });
  });

  /** A version home signed into `email`, without any `auth` bundle so no setup-token resolves. */
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
    // A provisioned box's launcher exports a shared, rotating CLAUDE_CODE_OAUTH_TOKEN;
    // `agents run claude "<prompt>"` inherits it via sanitizeProcessEnv(process.env).
    // No `auth` bundle is written, so no per-account setup-token resolves — the token
    // MUST be stripped so the run authenticates against this home's own login, not the
    // shared token that caused the RUSH-1822 fleet-wide logout.
    const { version } = makeVersionHome('alpha@example.com');
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'sk-ant-oat01-shared-rotating-must-be-stripped';

    const env = buildExecEnv(execOpts({ agent: 'claude', version, prompt: 'do the thing' }));

    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
  });

  it('still injects a resolved per-account setup-token on a non-interactive run (no regression)', () => {
    // When the `auth` bundle DOES carry this account's setup-token, it is injected and
    // wins over the ambient shared value — the existing behavior the strip must not break.
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
    // A pure rate limit must NOT be classified as out-of-credits, or it would
    // wrongly become clock-less and never recover.
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
});

describe('classifyCodexRunRefusal (PHNX-3859 — codex account marked so rotation stops re-picking it)', () => {
  // The exact string a headless `agents run codex` prints when its account is
  // over its weekly limit — reproduced 2026-09-06 on yosemite-s1.
  const REAL =
    "ERROR: You've hit your usage limit. Visit https://chatgpt.com/codex/settings/usage " +
    'to purchase more credits or try again at Sep 12th, 2026 8:32 AM.';

  it("codex's usage-limit reset parses to a future Date (ordinal suffix stripped)", () => {
    const now = Date.parse('2026-09-06T00:00:00Z');
    const reset = parseCodexUsageLimitReset(REAL, now);
    expect(reset).toBeInstanceOf(Date);
    // Sep 12 2026, well after the Sep 6 "now".
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
    // captureStdoutTail feeds a 16KB tail of the codex transcript, which streams
    // the whole session — a run that discusses billing/quota code prints "usage
    // limit" without being the CLI's own refusal. Only "hit your usage limit"
    // triggers, so a healthy account is never wrongly excluded.
    const transcript =
      'Looking at the usage limit handling in billing.ts — the docs say try again at Sep 12th, 2026 8:32 AM if exceeded.';
    expect(parseCodexUsageLimitReset(transcript)).toBeNull();
    expect(classifyCodexRunRefusal(transcript, 1)).toEqual({ action: 'none' });
  });

  it('a reset already in the past is not noted (window recovered), never rolled to a clock', () => {
    const now = Date.parse('2026-09-20T00:00:00Z'); // after REAL's Sep 12 reset
    expect(parseCodexUsageLimitReset(REAL, now)).toBeNull();
    expect(classifyCodexRunRefusal(REAL, 1, now)).toEqual({ action: 'none' });
  });

  it('a usage limit with no parseable reset is left untouched, never persisted as unexpirable', () => {
    // Without a "try again at <when>", persisting a clock-less marker would
    // deadlock the account (excluded, so it can never get the successful run that
    // clears it). Leave it to the cascade (detectRateLimit) instead.
    expect(classifyCodexRunRefusal("You've hit your usage limit.", 1)).toEqual({ action: 'none' });
    expect(parseCodexUsageLimitReset("You've hit your usage limit.")).toBeNull();
  });

  it('an unrelated non-zero exit leaves the marker untouched', () => {
    expect(classifyCodexRunRefusal('some unrelated error', 1)).toEqual({ action: 'none' });
    expect(parseCodexUsageLimitReset('some unrelated error')).toBeNull();
  });
});
