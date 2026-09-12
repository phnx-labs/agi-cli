import * as path from 'path';
import type { AgentId } from '../../types.js';
import type { HarnessAdapter } from '../adapter.js';
import { slotAwareConfigEnvBash, stripForeignConfigDir } from '../adapter.js';
import { isHeadedDeviceRole, type ConfiguredDeviceRole } from '../../device-config.js';

export const claudeAdapter: HarnessAdapter = {
  id: 'claude',

  applyExecConfigEnv(result, ctx) {
    const { versionHome } = ctx;
    // The per-account `claude setup-token` only resolves when there is a version
    // home to key it to; version===null (claude unresolved / not installed) yields
    // null, exactly as the routines path treats it (`runner.ts:1017-1021`). The
    // token decision below runs even then, so an ambient inherited value is stripped
    // on the routines/provisioned path regardless of whether a version resolved.
    // resolveClaudeSetupToken is injected (see ExecConfigEnvCtx) to keep this
    // adapter import-leaf — importing claude-account-token here would drag the
    // secrets/sqlite graph into shims.ts.
    const setupToken = versionHome ? ctx.resolveClaudeSetupToken(versionHome) : null;
    if (versionHome) {
      result.CLAUDE_CONFIG_DIR = path.join(versionHome, '.claude');
      // A managed pin lives in a per-version dir; Claude Code's own background
      // auto-updater would rewrite that pinned binary in place (and has left it
      // half-swapped and broken). Disable it so a pin stays a pin. Honor an
      // explicit user value — from process.env (already in result) or from
      // options.env (spread over result below).
      if (result.DISABLE_AUTOUPDATER === undefined) {
        result.DISABLE_AUTOUPDATER = '1';
      }
    }
    // The `auth` bundle's setup-token exists so a run with NO human present
    // authenticates without the Touch-ID-gated login item — usage probes,
    // routines, dispatched runs (claude-account-token.ts). It is a WORKER
    // credential. Exactly one kind of run defers to the per-version login
    // instead: ANY run on a `personal`/`desktop` (headed) device — the user's
    // own interactive box (zion), marked `config.role: personal`. That box
    // holds a real per-version login and is the single origin of it, so every
    // run there — interactive TUI OR a headless one-shot like `agents run
    // claude "fix the bug"` — MUST use that login, not the setup-token. Keying
    // the credential on DEVICE ROLE, not run mode, is RUSH-2395's fix: gating on
    // `ctx.interactive` alone sent a headless run on the laptop onto the
    // setup-token and hijacked the login.
    //
    // A WORKER device carries no such login regardless of interactive/headless:
    // an interactive run there is a remotely dispatched TUI (`agents run claude
    // --interactive --device <worker>`), not a human sitting at that box's own
    // Keychain-trusted session — the same worker credential headless runs use is
    // the only credential that exists to authenticate it. Treating `interactive`
    // as "defer to native login" regardless of device role left a keychain-less
    // worker with NO injected token and a per-version `.credentials.json` that
    // was never written, so the run landed on Claude Code's login screen instead
    // of authenticating (PHNX-3502).
    //
    // macOS cannot cheaply confirm a home's login first (probing the Keychain
    // raises an authorization sheet per installed version on the `agents run` hot
    // path — agents.ts `isClaudeCredentialFileBlank`), so the headed-device path
    // defers to Claude Code, which reads its own ACL-trusted login item without a
    // prompt and asks a present human to log in only if the login is missing.
    const headedDevice = isHeadedDeviceRole(ctx.deviceRole);
    if (headedDevice) {
      // Drop an INHERITED copy of OUR OWN setup-token: a launch from inside a
      // headless agent's shell inherits that agent's injected value via
      // sanitizeProcessEnv(process.env) and would keep authenticating as it,
      // overriding the login this branch is protecting. Matched by VALUE, so a
      // token the user exported deliberately is a different string and is left
      // alone (#2383). This is NARROWER than the worker path below, which
      // overwrites-or-deletes unconditionally and never inspects the inherited
      // value — a DIFFERENT account's inherited setup-token passing through this
      // equality check is the adjacent hole RUSH-2360 leaves as follow-up (it does
      // not silently run on a *shared, rotating* token, which is what caused the
      // RUSH-1822 logout storm).
      if (setupToken && result.CLAUDE_CODE_OAUTH_TOKEN === setupToken) {
        delete result.CLAUDE_CODE_OAUTH_TOKEN;
      }
    } else {
      // Any run on a NON-personal device (worker, dispatched, provisioned box) —
      // interactive OR headless: mirror the routines path (`runner.ts`)
      // UNCONDITIONALLY. Inject the per-account setup-token when one resolves —
      // it replaces any ambient shared value inherited from the launcher. When
      // NONE resolves, STRIP the ambient CLAUDE_CODE_OAUTH_TOKEN so a run on a
      // provisioned box can never silently authenticate as the shared, rotating
      // token an earlier version of this path let through — the RUSH-1822
      // fleet-wide-logout hazard, tracked by RUSH-2360. A missing login then
      // fails loud (401) against this home's own credential instead of quietly
      // borrowing another's. options.env still wins below for an explicit
      // caller override.
      if (setupToken) {
        result.CLAUDE_CODE_OAUTH_TOKEN = setupToken;
      } else {
        delete result.CLAUDE_CODE_OAUTH_TOKEN;
      }
    }
    stripForeignConfigDir(result, ['CLAUDE_CONFIG_DIR']);
  },

  shimConfigEnvBash(ctx) {
    return `
# Claude stores OAuth credentials in the macOS keychain. Scope them to the
# selected version's config directory so switching versions also switches the
# live Claude account. An account-slot launch (PHNX-3940 T5) has already chosen
# the config dir (AGENTS_EXEC_HOME) and the pin yields to it — see
# slotAwareConfigEnvBash.
${slotAwareConfigEnvBash([{ env: 'CLAUDE_CONFIG_DIR', rel: ctx.configDirName }], '$VERSION_DIR/home')}
# Managed installs are pinned in a per-version dir; Claude Code's background
# auto-updater would rewrite the pinned binary in place. Disable it so a pin
# stays a pin. An explicit user value always wins.
export DISABLE_AUTOUPDATER="\${DISABLE_AUTOUPDATER:-1}"
# On Linux sandboxes (no keychain), fall back to a per-version token file.
# The env var always wins if already set; no-op on macOS.
if [ "\$(uname -s)" = "Linux" ] && [ -z "\${CLAUDE_CODE_OAUTH_TOKEN:-}" ] && [ -f "\$CLAUDE_CONFIG_DIR/.oauth_token" ]; then
  CLAUDE_CODE_OAUTH_TOKEN=\$(cat "\$CLAUDE_CONFIG_DIR/.oauth_token")
  export CLAUDE_CODE_OAUTH_TOKEN
fi
`;
  },

  // NOTE: the worker branch above strips the token and returns; a MISSING worker
  // credential is caught before spawn by claudeWorkerLoginTrapPreflight (below),
  // which fails loud for an interactive run instead of letting Claude Code fall
  // through to its "Select login method" screen. A headless run keeps the
  // strip-and-401 behavior.

  routineModeArgs(cmd, ctx) {
    const mode = ctx.mode;
    if (mode === 'edit') {
      const planIndex = cmd.indexOf('plan');
      if (planIndex !== -1) cmd[planIndex] = 'acceptEdits';
    } else if (mode === 'auto') {
      const planIndex = cmd.indexOf('plan');
      if (planIndex !== -1) cmd[planIndex] = 'auto';
    } else if (mode === 'skip') {
      // Replace --permission-mode plan with --dangerously-skip-permissions
      const pmIndex = cmd.indexOf('--permission-mode');
      if (pmIndex !== -1) cmd.splice(pmIndex, 2, '--dangerously-skip-permissions');
    }
  },
};

/**
 * Fail-loud preflight for the worker login-screen trap — the sibling of the
 * PHNX-3502 fix. On a worker (non-headed) device every Claude run authenticates
 * from the synced `setup-token`, never an interactive login (owner rule /
 * credential-management invariant 7). When NO setup-token resolves for the
 * account this run selected, `applyExecConfigEnv` strips any ambient token and
 * the harness launches with no credential. A HEADLESS run then fails loud with a
 * 401 — but an INTERACTIVE dispatched TUI (`agents run claude --interactive
 * --device <worker>`, the usual `--device auto` landing) instead drops to Claude
 * Code's own "Select login method" screen. Answering it does an interactive OAuth
 * on a headless box, minting a native login the worker path never reads and never
 * syncs; Anthropic later expires it and the next run repeats the prompt — the
 * 10-minute re-login loop the operator sees.
 *
 * This gate refuses that run BEFORE spawn with the real fix (pin or mint a
 * durable account) instead of the useless login prompt. It is interactive-only
 * because the headless 401 is already loud. Pure: the caller (spawnAgentLeased)
 * resolves the inputs and renders the returned message, exactly like
 * codexSandboxPreflight. Returns null when the run may proceed.
 */
export function claudeWorkerLoginTrapPreflight(args: {
  agent: AgentId;
  interactive: boolean;
  deviceRole?: ConfiguredDeviceRole;
  hasSetupToken: boolean;
  machine?: string;
}): string | null {
  if (args.agent !== 'claude') return null;
  // A headless run with no token fails loud with a 401 already; only an
  // interactive run falls through to Claude Code's login screen.
  if (!args.interactive) return null;
  // A headed box (personal/desktop) authenticates from its own native login, so
  // Claude Code's login prompt there is the correct, expected first-run flow.
  if (isHeadedDeviceRole(args.deviceRole)) return null;
  // A durable worker credential resolved for the selected account — proceed.
  if (args.hasSetupToken) return null;

  const where = args.machine ? `worker '${args.machine}'` : 'this worker';
  return [
    `No Claude worker credential is available on ${where} for the account this run selected.`,
    `A worker authenticates from a synced setup-token, never an interactive login — so`,
    `Claude Code's "Select login method" screen here would not persist (it is the source`,
    `of the repeated re-login). Do one of these instead:`,
    ``,
    `  • Pin a live account for this run:   agents run claude#<name> …   (e.g. claude#work)`,
    `  • Or set the fleet-wide default:     agents accounts default claude <name>`,
    `  • If that account has no token yet, mint it on a HEADED box (e.g. your laptop):`,
    `        agents accounts login claude#<name>`,
    ``,
    // NB: keep this text clear of RATE_LIMIT_PATTERNS (exec.ts) — this string is
    // returned as spawn stderr, which runWithFallback scans; a stray "rate limit"
    // / "quota" phrase here would spuriously trigger an account-rotation fallback.
    `See which accounts are LIVE (signed in, with headroom) with:  agents accounts list`,
  ].join('\n');
}
