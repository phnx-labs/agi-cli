import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RotateCandidate } from '../lib/accounting/rotate.js';
import type { UsageSnapshot, UsageWindowKey } from '../lib/accounting/usage.js';
import { buildRunAccountChoices, buildSwitchAccountChoices, formatAccountLimits, noVerifiedUsageDecision, pickSignInLaunchCandidate, signInLaunchDecision } from './run-account-picker.js';

function snapshot(windows: Array<[UsageWindowKey, number]>, plan: string | null = null): UsageSnapshot {
  return {
    source: 'live',
    sourceLabel: 'live',
    capturedAt: null,
    plan,
    windows: windows.map(([key, usedPercent]) => ({
      key,
      label: key,
      shortLabel: key,
      usedPercent,
      resetsAt: null,
      windowMinutes: null,
    })),
  };
}

function candidate(overrides: Partial<RotateCandidate> = {}): RotateCandidate {
  return {
    agent: 'claude',
    version: '2.1.0',
    accountKey: 'claude:account=one',
    accountLabel: 'one@example.com',
    email: 'one@example.com',
    usageKey: 'claude:org=one',
    usageStatus: 'available',
    usageSnapshot: snapshot([['session', 25], ['week', 60], ['month', 90]]),
    usageError: null,
    usageMinutesToLimit: null,
    plan: 'Max',
    signedIn: true,
    authVerdict: null,
    lastActive: null,
    ...overrides,
  };
}

describe('formatAccountLimits', () => {
  it('shows remaining session, weekly, and monthly capacity in human terms', () => {
    expect(formatAccountLimits(candidate())).toBe(
      'Session 75% left · Week 40% left · Month 10% left',
    );
  });

  it('states when signed-in usage data is unavailable instead of implying zero use', () => {
    expect(formatAccountLimits(candidate({ usageSnapshot: null, usageError: 'unavailable' })))
      .toBe('limits unavailable');
  });
});

describe('buildRunAccountChoices', () => {
  it('puts usable accounts first and shows account, verdict, and usage (no version column)', () => {
    const choices = buildRunAccountChoices([
      candidate({
        version: '2.0.0',
        accountLabel: '',
        email: null,
        signedIn: false,
        usageSnapshot: null,
      }),
      candidate({ version: '2.1.0' }),
    ], '2.1.0');

    expect(choices[0].ready).toBe(true);
    expect(choices[0].name).toContain('one@example.com (default)');
    expect(choices[0].name).toContain('live');
    expect(choices[0].name).toContain('Session 75% left');
    expect(choices[0].name).not.toContain('2.1.0 (default)');
    expect(choices[1]).toMatchObject({ ready: false, signInRequired: true });
    expect(choices[1].disabled).toBeUndefined();
    expect(choices[1].name).toContain('logged out');
  });

  it('renders a slot candidate as account · verdict · usage without a version column', () => {
    const choices = buildRunAccountChoices([
      candidate({
        version: 'main',
        nativeAccount: 'work',
        accountLabel: 'work@example.com',
        fromSlot: true,
        authVerdict: 'live',
      }),
    ], 'main');
    expect(choices[0].value).toBe('work');
    expect(choices[0].name).toContain('work');
    expect(choices[0].name).toContain('live');
    expect(choices[0].name).not.toMatch(/\bmain\b/);
  });

  it('keeps a logged-out account SELECTABLE so the launch can carry you into the login (RUSH-2334)', () => {
    const [choice] = buildRunAccountChoices([
      candidate({ signedIn: false, usageSnapshot: null }),
    ], null);
    // Disabling this row is what left a fully logged-out harness unreachable.
    expect(choice.disabled).toBeUndefined();
    expect(choice).toMatchObject({ ready: false, signInRequired: true });
    expect(choice.name).toContain('launch to sign in');
  });

  it('orders ready > needs-sign-in > throttled, so the actionable row beats the hopeless one', () => {
    const choices = buildRunAccountChoices([
      candidate({ version: '1.0.0', usageSnapshot: snapshot([['session', 100], ['week', 100]]) }),
      candidate({ version: '2.0.0', signedIn: false, usageSnapshot: null }),
      candidate({ version: '3.0.0' }),
    ], null);
    expect(choices.map((c) => c.value)).toEqual(['3.0.0', '2.0.0', '1.0.0']);
    expect(choices.map((c) => !!c.disabled)).toEqual([false, false, true]);
  });

  it('disables exhausted accounts with the exact blocking windows', () => {
    const [choice] = buildRunAccountChoices([
      candidate({ usageSnapshot: snapshot([['session', 100], ['week', 100]]) }),
    ], null);
    expect(choice).toMatchObject({
      ready: false,
      disabled: 'Session and Week limits reached',
    });
    expect(choice.name).toContain('Session exhausted');
    expect(choice.name).toContain('Week exhausted');
  });

  it('marks a server-revoked account (token rejected) as needing re-login, but keeps it pickable', () => {
    const [choice] = buildRunAccountChoices([
      candidate({ authVerdict: 'revoked', usageSnapshot: snapshot([['session', 0], ['week', 0]]) }),
    ], null);
    expect(choice).toMatchObject({ ready: false, signInRequired: true });
    expect(choice.disabled).toBeUndefined();
    expect(choice.name).toContain('needs re-login');
    expect(choice.name).toContain('launch to re-authenticate');
  });

  it('keeps a signed-in account selectable when quota data is unavailable', () => {
    const [choice] = buildRunAccountChoices([
      candidate({ usageSnapshot: null, usageError: 'network unavailable' }),
    ], null);
    expect(choice.ready).toBe(true);
    expect(choice.disabled).toBeUndefined();
    expect(choice.name).toContain('limits unavailable');
  });

  it('does not disable a usable account solely because the Sonnet sub-limit is exhausted', () => {
    const [choice] = buildRunAccountChoices([
      candidate({ usageSnapshot: snapshot([['session', 20], ['week', 30], ['sonnet_week', 100]]) }),
    ], null);
    expect(choice.ready).toBe(true);
    expect(choice.name).toContain('Sonnet week exhausted');
  });

  it('shows usage even when the credential has no plan claim', () => {
    const [choice] = buildRunAccountChoices([
      candidate({ plan: null, usageSnapshot: snapshot([['session', 10]], 'Team') }),
    ], null);
    expect(choice.name).toContain('Session 90% left');
  });
});

describe('buildSwitchAccountChoices', () => {
  it('marks the current default and shows native usage next to provider credentials', () => {
    const choices = buildSwitchAccountChoices([
      {
        accountName: 'work',
        kind: 'provider',
        detail: 'anthropic',
        current: true,
        candidate: null,
      },
      {
        accountName: 'personal',
        kind: 'native',
        detail: 'one@example.com',
        current: false,
        candidate: candidate({ usageSnapshot: snapshot([['session', 25], ['week', 60]]) }),
      },
    ]);
    expect(choices[0]).toMatchObject({ value: 'work', ready: true });
    expect(choices[0].name).toContain('work (default)');
    expect(choices[0].name).toContain('provider · anthropic');
    expect(choices[0].name).toContain('credential');
    expect(choices[1].value).toBe('personal');
    expect(choices[1].name).toContain('native · one@example.com');
    expect(choices[1].name).toContain('Session 75% left');
  });

  it('keeps a rate-limited native account selectable — switch sets a default, it does not launch', () => {
    const [choice] = buildSwitchAccountChoices([
      {
        accountName: 'maxed',
        kind: 'native',
        detail: 'one@example.com',
        current: false,
        candidate: candidate({ usageSnapshot: snapshot([['session', 100], ['week', 100]]) }),
      },
    ]);
    expect(choice.disabled).toBeUndefined();
    expect(choice.ready).toBe(false);
    expect(choice.name).toContain('rate limited');
    expect(choice.name).toContain('Session exhausted');
  });
});

describe('pickSignInLaunchCandidate (RUSH-2334, PHNX-3940)', () => {
  afterEach(() => vi.restoreAllMocks());

  function captureStderr(): { lines: () => string } {
    const chunks: string[] = [];
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
      chunks.push(String(chunk));
      return true;
    });
    return { lines: () => chunks.join('') };
  }

  it('a single logged-out account returns the CANDIDATE (not a bare version) so the caller launches its own home', async () => {
    const stderr = captureStderr();
    const picked = await pickSignInLaunchCandidate(
      'claude',
      [candidate({ version: '2.1.0', signedIn: false, usageSnapshot: null })],
    );
    expect(picked?.version).toBe('2.1.0');
    expect(stderr.lines()).toContain('launching claude@2.1.0 so you can sign in');
    // The message must name the actual login command, not just say "logged out".
    expect(stderr.lines()).toContain('claude, then /login');
  });

  it('a single revoked account says the token was rejected, not that you are logged out', async () => {
    const stderr = captureStderr();
    const picked = await pickSignInLaunchCandidate(
      'claude',
      [candidate({ version: '2.1.0', authVerdict: 'revoked' })],
    );
    expect(picked?.version).toBe('2.1.0');
    expect(stderr.lines()).toContain('the server rejected its token');
  });

  it('--quiet returns the same candidate but prints nothing', async () => {
    const stderr = captureStderr();
    const picked = await pickSignInLaunchCandidate(
      'claude',
      [candidate({ version: '2.1.0', signedIn: false, usageSnapshot: null })],
      true,
    );
    expect(picked?.version).toBe('2.1.0');
    expect(stderr.lines()).toBe('');
  });

  it('no recoverable candidate returns null so the caller falls back to failing loud', async () => {
    expect(await pickSignInLaunchCandidate('claude', [])).toBeNull();
  });
});

describe('signInLaunchDecision (RUSH-2334)', () => {
  const base = { recoverable: 1, tty: true, json: false };

  it('launches when a human is present and an account only needs a login', () => {
    expect(signInLaunchDecision(base)).toBe('launch');
  });

  it('--json NEVER launches, even on a real terminal — a machine consumer must not get a picker or a TUI', () => {
    expect(signInLaunchDecision({ ...base, json: true })).toBe('fail-loud');
  });

  it('off a TTY it fails loud — nobody is there to complete a login', () => {
    expect(signInLaunchDecision({ ...base, tty: false })).toBe('fail-loud');
  });

  it('an all-throttled exhausted set fails loud even for a present human (RUSH-2132)', () => {
    expect(signInLaunchDecision({ ...base, recoverable: 0 })).toBe('fail-loud');
  });
});

describe('noVerifiedUsageDecision (PHNX-2526 — entirely-stale usage divert)', () => {
  const base = { tty: true, json: false, headless: false };

  it('shows the account picker when a human is present at a real terminal', () => {
    expect(noVerifiedUsageDecision(base)).toBe('picker');
  });

  it('off a TTY it fails loud with NO_VERIFIED_USAGE — no human to answer a picker', () => {
    expect(noVerifiedUsageDecision({ ...base, tty: false })).toBe('fail-loud');
  });

  it('--json NEVER opens a picker — a machine consumer gets the parseable error', () => {
    expect(noVerifiedUsageDecision({ ...base, json: true })).toBe('fail-loud');
  });

  it('--headless fails loud even on a TTY — an unattended dispatch has no one to choose', () => {
    expect(noVerifiedUsageDecision({ ...base, headless: true })).toBe('fail-loud');
  });
});
