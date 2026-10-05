import * as path from 'path';
import type { AgentId } from '../../types.js';
import type { HarnessAdapter } from '../adapter.js';
import { slotAwareConfigEnvBash, stripForeignConfigDir } from '../adapter.js';
import { isHeadedDeviceRole, type ConfiguredDeviceRole } from '../../device-config.js';

export const claudeAdapter: HarnessAdapter = {
  id: 'claude',

  applyExecConfigEnv(result, ctx) {
    const { versionHome } = ctx;
    const setupToken = versionHome ? ctx.resolveClaudeSetupToken(versionHome) : null;
    if (versionHome) {
      result.CLAUDE_CONFIG_DIR = path.join(versionHome, '.claude');
      if (result.DISABLE_AUTOUPDATER === undefined) {
        result.DISABLE_AUTOUPDATER = '1';
      }
    }
    // Credentials follow device role, not run mode: headed devices keep native OAuth;
    // workers receive only their setup-token, and inherited ambient tokens are stripped.
    const headedDevice = isHeadedDeviceRole(ctx.deviceRole);
    if (headedDevice) {
      if (setupToken && result.CLAUDE_CODE_OAUTH_TOKEN === setupToken) {
        delete result.CLAUDE_CODE_OAUTH_TOKEN;
      }
    } else {
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

/**
 * Fail-loud preflight for the worker login-screen trap — the sibling of the
 * PHNX-3502 fix. On an EXPLICIT `role: worker` device every Claude run
 * authenticates from the synced `setup-token`, never an interactive login (owner
 * rule / credential-management invariant 7). When NO setup-token resolves for the
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
  hasWorkerCredential: boolean;
  machine?: string;
}): string | null {
  if (args.agent !== 'claude') return null;
  if (!args.interactive) return null;
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
