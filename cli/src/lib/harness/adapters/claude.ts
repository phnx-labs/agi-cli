import * as path from 'path';
import type { AgentId } from '../../types.js';
import type { HarnessAdapter } from '../adapter.js';
import { slotAwareConfigEnvBash, stripForeignConfigDir } from '../adapter.js';
import { isHeadedDeviceRole, type ConfiguredDeviceRole } from '../../device-config.js';

export const claudeAdapter: HarnessAdapter = {
  id: 'claude',

  applyExecConfigEnv(result, ctx) {
    const { versionHome } = ctx;
    // The per-account `claude setup-token` resolves only with a version home; version===null yields
    // null, as in the routines path (`runner.ts:1017-1021`).
    const setupToken = versionHome ? ctx.resolveClaudeSetupToken(versionHome) : null;
    if (versionHome) {
      result.CLAUDE_CONFIG_DIR = path.join(versionHome, '.claude');
      // A managed pin lives in a per-version dir, and Claude Code's background auto-updater would
      // rewrite the pinned binary in place (it has left it half-swapped). Disable it so a pin stays
      // a pin, honoring an explicit user value from process.env or options.env.
      if (result.DISABLE_AUTOUPDATER === undefined) {
        result.DISABLE_AUTOUPDATER = '1';
      }
    }
    // The `auth` bundle's setup-token is a worker credential for runs with no human present.
    // Any run on a headed (personal/desktop) device uses its native login: credential keys on
    // device role, not run mode (RUSH-2395). Worker runs, even interactive, use it (PHNX-3502).
    const headedDevice = isHeadedDeviceRole(ctx.deviceRole);
    if (headedDevice) {
      // Drop an inherited copy of our own setup-token: a launch inside a headless agent's shell
      // inherits its injected value and would keep authenticating as it. Matched by value, so a
      // user-exported token is left alone (#2383). Another account's token passing is RUSH-2360.
      if (setupToken && result.CLAUDE_CODE_OAUTH_TOKEN === setupToken) {
        delete result.CLAUDE_CODE_OAUTH_TOKEN;
      }
    } else {
      // Any run on a non-personal device, interactive or headless, mirrors `runner.ts`: inject
      // the per-account setup-token if one resolves, else strip ambient CLAUDE_CODE_OAUTH_TOKEN so
      // it never uses the shared rotating token (RUSH-1822, RUSH-2360). Missing login fails loud.
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

  // The worker branch strips the token and returns; a missing worker credential is caught before
  // spawn by claudeWorkerLoginTrapPreflight, which fails loud for interactive runs instead of
  // dropping to "Select login method". A headless run keeps strip-and-401.

  routineModeArgs(cmd, ctx) {
    const mode = ctx.mode;
    if (mode === 'edit') {
      const planIndex = cmd.indexOf('plan');
      if (planIndex !== -1) cmd[planIndex] = 'acceptEdits';
    } else if (mode === 'auto') {
      const planIndex = cmd.indexOf('plan');
      if (planIndex !== -1) cmd[planIndex] = 'auto';
    } else if (mode === 'skip') {
      const pmIndex = cmd.indexOf('--permission-mode');
      if (pmIndex !== -1) cmd.splice(pmIndex, 2, '--dangerously-skip-permissions');
    }
  },
};

/** Fail-loud preflight for the worker login-screen trap (sibling of PHNX-3502). On an explicit
 * `role: worker` device with no setup-token, an interactive run would hit Claude's login screen
 * and mint an unsynced login; refuse before spawn. Pure; returns null when the run may proceed. */
export function claudeWorkerLoginTrapPreflight(args: {
  agent: AgentId;
  interactive: boolean;
  deviceRole?: ConfiguredDeviceRole;
  /** Will a Claude credential reach the child at spawn? The caller ORs the worker setup-token
   * with an explicit `--env CLAUDE_CODE_OAUTH_TOKEN=...`; buildExecEnv merges options.env last,
   * so it wins even the worker strip. */
  hasWorkerCredential: boolean;
  machine?: string;
}): string | null {
  if (args.agent !== 'claude') return null;
  if (!args.interactive) return null;
  // Gate only an explicit `role: worker` box, not headed or unmarked ones. A real worker holds no
  // native login (owner rule), so no token means a login screen with nothing behind it. Unmarked
  // boxes get no synced token and usually have a native login, so gating them would false-refuse.
  if (args.deviceRole !== 'worker') return null;
  if (args.hasWorkerCredential) return null;

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
    `See which accounts are LIVE (signed in, with headroom) with:  agents accounts list`,
  ].join('\n');
}
