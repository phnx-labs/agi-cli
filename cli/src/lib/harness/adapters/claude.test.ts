import { describe, expect, it } from 'vitest';
import { claudeAdapter, claudeWorkerLoginTrapPreflight } from './claude.js';
import type { ExecConfigEnvCtx } from '../adapter.js';
import type { ConfiguredDeviceRole } from '../../device-config.js';

/**
 * The credential decision in `claudeAdapter.applyExecConfigEnv` — which account a
 * Claude run authenticates as — is a function of DEVICE ROLE alone, not run mode
 * (RUSH-2395, PHNX-3502). This exercises the whole matrix directly against the
 * adapter (no config/keychain), because getting it wrong silently reroutes a run
 * onto the wrong account: a headless run on the user's laptop hijacking their
 * login, or a worker run — interactive or headless — failing to pick up its
 * setup-token and landing on Claude Code's login screen instead.
 */
describe('claudeAdapter.applyExecConfigEnv — role-aware CLAUDE_CODE_OAUTH_TOKEN', () => {
  const VERSION_HOME = '/tmp/rush-2395-version-home';
  const OWN_TOKEN = 'sk-ant-oat01-own-account';
  const FOREIGN_TOKEN = 'sk-ant-oat01-someone-else';

  /**
   * Run the adapter with a stubbed setup-token resolver and return the token the
   * run would end up authenticating with (undefined = defers to the per-version
   * login). `ambient` seeds an already-present CLAUDE_CODE_OAUTH_TOKEN, standing
   * in for a value inherited from a parent shell (sanitizeProcessEnv keeps it).
   */
  function resolvedToken(opts: {
    interactive: boolean;
    deviceRole?: ConfiguredDeviceRole;
    setupToken: string | null;
    ambient?: string;
  }): string | undefined {
    const result: NodeJS.ProcessEnv = {};
    if (opts.ambient !== undefined) result.CLAUDE_CODE_OAUTH_TOKEN = opts.ambient;
    const ctx: ExecConfigEnvCtx = {
      agent: 'claude',
      version: 'test',
      versionHome: VERSION_HOME,
      interactive: opts.interactive,
      deviceRole: opts.deviceRole,
      resolveClaudeSetupToken: () => opts.setupToken,
    };
    claudeAdapter.applyExecConfigEnv!(result, ctx);
    return result.CLAUDE_CODE_OAUTH_TOKEN;
  }

  describe('worker device (or unmarked) — headless runs use the setup-token', () => {
    it('injects the per-account setup-token on a headless worker run', () => {
      expect(resolvedToken({ interactive: false, deviceRole: 'worker', setupToken: OWN_TOKEN }))
        .toBe(OWN_TOKEN);
    });

    it('the setup-token wins over an ambient inherited value (worker headless)', () => {
      expect(resolvedToken({
        interactive: false,
        deviceRole: 'worker',
        setupToken: OWN_TOKEN,
        ambient: 'sk-ant-oat01-shared-must-not-win',
      })).toBe(OWN_TOKEN);
    });

    it('strips an ambient token when NO setup-token resolves (provisioned-box leak)', () => {
      expect(resolvedToken({
        interactive: false,
        deviceRole: 'worker',
        setupToken: null,
        ambient: 'sk-ant-oat01-shared-rotating',
      })).toBeUndefined();
    });

    it('treats an UNMARKED device (undefined role) as a worker — still injects on headless', () => {
      expect(resolvedToken({ interactive: false, deviceRole: undefined, setupToken: OWN_TOKEN }))
        .toBe(OWN_TOKEN);
    });
  });

  describe('worker device — INTERACTIVE runs also use the setup-token (PHNX-3502)', () => {
    it('injects the per-account setup-token on an interactive worker run', () => {
      // `agents run claude --interactive --device <worker>`: a remotely dispatched
      // TUI, not a human at that box's own Keychain-trusted session — there is no
      // per-version login to defer to, so this must behave exactly like headless.
      expect(resolvedToken({ interactive: true, deviceRole: 'worker', setupToken: OWN_TOKEN }))
        .toBe(OWN_TOKEN);
    });

    it('the setup-token wins over an ambient inherited value (worker interactive)', () => {
      expect(resolvedToken({
        interactive: true,
        deviceRole: 'worker',
        setupToken: OWN_TOKEN,
        ambient: 'sk-ant-oat01-shared-must-not-win',
      })).toBe(OWN_TOKEN);
    });

    it('strips an ambient token when NO setup-token resolves (interactive worker)', () => {
      expect(resolvedToken({
        interactive: true,
        deviceRole: 'worker',
        setupToken: null,
        ambient: 'sk-ant-oat01-shared-rotating',
      })).toBeUndefined();
    });

    it('treats an UNMARKED device (undefined role) as a worker — still injects on interactive', () => {
      expect(resolvedToken({ interactive: true, deviceRole: undefined, setupToken: OWN_TOKEN }))
        .toBe(OWN_TOKEN);
    });
  });

  describe('personal device — every run defers to the per-version login', () => {
    it('a HEADLESS run on a personal box does NOT inject the setup-token (the RUSH-2395 fix)', () => {
      // `agents run claude "fix the bug"` on the laptop: prompt present -> headless,
      // but role personal -> must stay on the login, not the setup-token.
      expect(resolvedToken({ interactive: false, deviceRole: 'personal', setupToken: OWN_TOKEN }))
        .toBeUndefined();
    });

    it('strips an inherited copy of OUR OWN setup-token so the login wins (headless personal)', () => {
      expect(resolvedToken({
        interactive: false,
        deviceRole: 'personal',
        setupToken: OWN_TOKEN,
        ambient: OWN_TOKEN,
      })).toBeUndefined();
    });

    it('leaves a DIFFERENT ambient token alone — a deliberately-exported value survives (#2383)', () => {
      expect(resolvedToken({
        interactive: false,
        deviceRole: 'personal',
        setupToken: OWN_TOKEN,
        ambient: FOREIGN_TOKEN,
      })).toBe(FOREIGN_TOKEN);
    });

    it('an INTERACTIVE run on a personal box also defers to the login', () => {
      expect(resolvedToken({ interactive: true, deviceRole: 'personal', setupToken: OWN_TOKEN }))
        .toBeUndefined();
    });

    it('a desktop box is in the same headed bucket — a headless run defers to the login too', () => {
      // desktop (a headed always-on Mac) holds a real per-version login just like
      // personal, so it must never fall back to the worker setup-token.
      expect(resolvedToken({ interactive: false, deviceRole: 'desktop', setupToken: OWN_TOKEN }))
        .toBeUndefined();
    });
  });

  describe('interactive runs on a HEADED device still defer to the login', () => {
    it('interactive on personal/desktop is unaffected by the worker fix', () => {
      expect(resolvedToken({ interactive: true, deviceRole: 'personal', setupToken: OWN_TOKEN }))
        .toBeUndefined();
      expect(resolvedToken({ interactive: true, deviceRole: 'desktop', setupToken: OWN_TOKEN }))
        .toBeUndefined();
    });
  });
});

/**
 * The worker login-screen trap: an interactive Claude run dispatched to a worker
 * (`agents run claude --interactive --device auto/<worker>`) whose selected
 * account has no synced setup-token used to fall through to Claude Code's own
 * "Select login method" screen — an interactive OAuth on a headless box that
 * never persists (the 10-minute re-login loop). `claudeWorkerLoginTrapPreflight`
 * refuses that run before spawn with the real fix. This pins the exact matrix.
 */
describe('claudeWorkerLoginTrapPreflight — refuse the worker login-screen trap', () => {
  it('refuses an interactive worker run with NO setup-token (the bug)', () => {
    const msg = claudeWorkerLoginTrapPreflight({
      agent: 'claude',
      interactive: true,
      deviceRole: 'worker',
      hasSetupToken: false,
      machine: 'yosemite-m5',
    });
    expect(msg).toBeTruthy();
    // Names the box, and hands the operator the real fix — never "log in here".
    expect(msg).toContain("yosemite-m5");
    expect(msg).toContain('agents accounts default claude');
    expect(msg).toContain('agents run claude#');
    expect(msg).not.toMatch(/log ?in here/i);
    // The message is returned as spawn stderr, which runWithFallback scans with
    // RATE_LIMIT_PATTERNS — a stray rate-limit/quota phrase would spuriously
    // trigger an account-rotation fallback. Keep it clear of every such token.
    expect(msg).not.toMatch(
      /rate[\s-]?limit|usage[\s-]?limit|quota\s*(exceeded|reached|limit)|\b429\b|5[\s-]?hour[\s-]?limit|too many requests|overloaded|spend[\s-]?limit|out of (?:usage )?credits/i,
    );
  });

  it('treats an UNMARKED device (undefined role) as a worker — still refuses', () => {
    expect(
      claudeWorkerLoginTrapPreflight({
        agent: 'claude',
        interactive: true,
        deviceRole: undefined,
        hasSetupToken: false,
      }),
    ).toBeTruthy();
  });

  it('allows the run when a durable setup-token DID resolve on the worker', () => {
    expect(
      claudeWorkerLoginTrapPreflight({
        agent: 'claude',
        interactive: true,
        deviceRole: 'worker',
        hasSetupToken: true,
      }),
    ).toBeNull();
  });

  it('does NOT gate a headless worker run — the 401 is already loud', () => {
    expect(
      claudeWorkerLoginTrapPreflight({
        agent: 'claude',
        interactive: false,
        deviceRole: 'worker',
        hasSetupToken: false,
      }),
    ).toBeNull();
  });

  it('does NOT gate a headed box — its native login prompt is the correct flow', () => {
    for (const deviceRole of ['personal', 'desktop'] as const) {
      expect(
        claudeWorkerLoginTrapPreflight({
          agent: 'claude',
          interactive: true,
          deviceRole,
          hasSetupToken: false,
        }),
      ).toBeNull();
    }
  });

  it('only applies to claude — another harness is never gated here', () => {
    expect(
      claudeWorkerLoginTrapPreflight({
        agent: 'codex',
        interactive: true,
        deviceRole: 'worker',
        hasSetupToken: false,
      }),
    ).toBeNull();
  });
});
