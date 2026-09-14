import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { addWorkerRefusal } from './accounts/add.js';
import { setConfiguredDeviceRole } from './device-config.js';
import { ambientClaudeToken, fixFor, formatSignInBadge, loginHint, shouldCheckLoginBeforeLaunch } from './signin-badge.js';
import type { AccountInfo } from './agents.js';

// Strip ANSI so assertions read against text, not color codes.
const plain = (s: string): string => s.replace(/\[[0-9;]*m/g, '');

const acct = (over: Partial<AccountInfo>): Pick<AccountInfo, 'signedIn' | 'email' | 'accountId'> => ({
  signedIn: false,
  email: null,
  accountId: null,
  ...over,
});

describe('loginHint', () => {
  // The whole point of the warning is telling the user the RIGHT command — a
  // wrong hint sends them down the wrong path, so pin the per-agent overrides.
  it('uses the correct login command per agent', () => {
    expect(loginHint('codex')).toBe('codex login');
    expect(loginHint('grok')).toBe('grok login --device-auth');
    expect(loginHint('opencode')).toBe('opencode auth login');
    expect(loginHint('claude')).toBe('claude, then /login');
    // Warp Agent CLI has no `login` subcommand — bare `warp` opens sign-in.
    expect(loginHint('warp')).toBe('warp');
  });

  it('falls back to the bare cli command for device/oauth-on-launch agents', () => {
    // kimi/gemini start their flow on launch — no subcommand.
    expect(loginHint('kimi')).toBe('kimi');
    expect(loginHint('gemini')).toBe('gemini');
  });
});

describe('fixFor', () => {
  const DEVICE = `fixfor-role-${process.pid}`;
  let prevMachineId: string | undefined;

  beforeEach(() => {
    prevMachineId = process.env.AGENTS_SYNC_MACHINE_ID;
    process.env.AGENTS_SYNC_MACHINE_ID = DEVICE;
    setConfiguredDeviceRole(DEVICE, 'personal');
  });

  afterEach(() => {
    setConfiguredDeviceRole(DEVICE, undefined);
    if (prevMachineId === undefined) delete process.env.AGENTS_SYNC_MACHINE_ID;
    else process.env.AGENTS_SYNC_MACHINE_ID = prevMachineId;
  });

  it('targets named accounts through login <harness>#<name> — the taught re-auth verb', () => {
    expect(fixFor({ agent: 'claude', name: 'work', verdict: 'expired' }))
      .toBe('agents accounts login claude#work');
    expect(fixFor({ agent: 'codex', name: 'cxpersonal', verdict: 'revoked' }))
      .toBe('agents accounts login codex#cxpersonal');
  });

  it('teaches accounts add for a known account with no slot on a headed device', () => {
    expect(fixFor({ agent: 'claude', name: 'work', verdict: 'missing', hasSlot: false }))
      .toBe('agents accounts add claude work');
  });

  it('uses add.ts worker-refusal wording on a worker, never an interactive login', () => {
    setConfiguredDeviceRole(DEVICE, 'worker');
    expect(fixFor({ agent: 'claude', name: 'work', verdict: 'expired' }))
      .toBe(addWorkerRefusal('claude', 'work'));
    expect(fixFor({ agent: 'claude', name: 'work', verdict: 'missing', hasSlot: false }))
      .toBe(addWorkerRefusal('claude', 'work'));
  });

  it('uses the same exact per-version login commands doctor teaches for legacy homes', () => {
    expect(fixFor({ agent: 'claude', version: '2.1.220', verdict: 'revoked' }))
      .toBe('agents run claude@2.1.220, then /login');
    expect(fixFor({ agent: 'codex', version: '0.146.0', verdict: 'missing' }))
      .toBe('agents run codex@0.146.0 -- login');
    // grok's wired login is the device-code flow — the fix must carry the flag.
    expect(fixFor({ agent: 'grok', version: '0.2.118', verdict: 'missing' }))
      .toBe('agents run grok@0.2.118 -- login --device-auth');
    // cursor signs in on launch — no `--` subcommand, same as `agents doctor`.
    expect(fixFor({ agent: 'cursor', version: '9.9.9', verdict: 'missing' }))
      .toBe('agents run cursor@9.9.9');
  });

  it('emits no repair for unverified — an unconfirmed probe is not an actionable failure', () => {
    // A worker whose setup-token lacks the usage scope reads UNVERIFIED; there
    // is nothing to fix, and a fake `accounts sync` hint would be unrunnable.
    expect(fixFor({ agent: 'claude', name: 'work', verdict: 'unverified' })).toBeNull();
    expect(fixFor({ agent: 'claude', verdict: 'unverified' })).toBeNull();
  });

  it('emits no repair for healthy states, even on per-device harnesses', () => {
    expect(fixFor({ agent: 'claude', name: 'work', verdict: 'live' })).toBeNull();
    expect(fixFor({ agent: 'claude', name: 'work', verdict: 'rate_limited' })).toBeNull();
    expect(fixFor({ agent: 'claude', name: 'openrouter-work', verdict: 'ready' })).toBeNull();
    expect(fixFor({ agent: 'kimi', name: 'work', verdict: 'live', provisioning: 'per-device' })).toBeNull();
  });

  it('uses the real fleet device-login command for per-device harnesses needing attention', () => {
    expect(fixFor({ agent: 'kimi', name: 'work', verdict: 'per-device', provisioning: 'per-device' }))
      .toBe('agents devices login --agents kimi');
    expect(fixFor({ agent: 'antigravity', verdict: 'missing', provisioning: 'per-device' }))
      .toBe('agents devices login --agents antigravity');
  });
});

describe('formatSignInBadge', () => {
  it('renders logged out for a missing or unsigned account', () => {
    expect(plain(formatSignInBadge(null))).toBe('✗ logged out');
    expect(plain(formatSignInBadge(acct({ signedIn: false, email: 'x@y.com' })))).toBe('✗ logged out');
  });

  it('renders signed in with the email when present', () => {
    expect(plain(formatSignInBadge(acct({ signedIn: true, email: 'muqsit@gmail.com' })))).toBe(
      '✓ signed in muqsit@gmail.com',
    );
  });

  it('falls back to an account id when signed in without an email', () => {
    expect(plain(formatSignInBadge(acct({ signedIn: true, accountId: 'abc123' })))).toBe('✓ signed in id:abc123');
  });

  it('renders a bare signed-in badge for opaque credentials (no email, no id)', () => {
    // Kimi / Antigravity: signed in but no surfaceable identity.
    expect(plain(formatSignInBadge(acct({ signedIn: true })))).toBe('✓ signed in');
  });
});

describe('shouldCheckLoginBeforeLaunch', () => {
  it('fires on a bare interactive launch (no prompt, not headless)', () => {
    expect(shouldCheckLoginBeforeLaunch({ hasPrompt: false })).toBe(true);
  });

  it('does NOT fire on a headless run (prompt present)', () => {
    expect(shouldCheckLoginBeforeLaunch({ hasPrompt: true })).toBe(false);
    expect(shouldCheckLoginBeforeLaunch({ hasPrompt: false, headless: true })).toBe(false);
  });

  it('fires on a forced-interactive resume even though the prompt was rewritten to /continue', () => {
    // The finding-1 regression: `agents run kimi --resume` sets forceInteractive
    // AND rewrites the prompt, so hasPrompt is true — but the TUI still opens.
    expect(shouldCheckLoginBeforeLaunch({ hasPrompt: true, forceInteractive: true })).toBe(true);
  });

  it('fires on explicit --interactive even with a prompt', () => {
    expect(shouldCheckLoginBeforeLaunch({ hasPrompt: true, interactive: true })).toBe(true);
  });

  it('is suppressed by --json / --quiet / disabled / rotation, even on an interactive launch', () => {
    const base = { hasPrompt: false as const };
    expect(shouldCheckLoginBeforeLaunch({ ...base, json: true })).toBe(false);
    expect(shouldCheckLoginBeforeLaunch({ ...base, quiet: true })).toBe(false);
    expect(shouldCheckLoginBeforeLaunch({ ...base, authCheckDisabled: true })).toBe(false);
    expect(shouldCheckLoginBeforeLaunch({ ...base, rotated: true })).toBe(false);
    // A suppressor wins even when forceInteractive is set.
    expect(shouldCheckLoginBeforeLaunch({ ...base, forceInteractive: true, rotated: true })).toBe(false);
  });
});

describe('ambientClaudeToken', () => {
  it('flags a claude box whose environment carries a token', () => {
    expect(ambientClaudeToken('claude', { CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-test' })).toBe(true);
  });

  it('is false with no token, an empty token, or whitespace', () => {
    expect(ambientClaudeToken('claude', {})).toBe(false);
    expect(ambientClaudeToken('claude', { CLAUDE_CODE_OAUTH_TOKEN: '' })).toBe(false);
    expect(ambientClaudeToken('claude', { CLAUDE_CODE_OAUTH_TOKEN: '   ' })).toBe(false);
  });

  it('never claims an ambient token for another agent', () => {
    // The var is claude-specific; codex/kimi read their own credential files, so
    // a stray value must not relabel their badge.
    expect(ambientClaudeToken('codex', { CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-test' })).toBe(false);
  });
});
