import type { HarnessAdapter } from '../adapter.js';
import { stripForeignConfigDir } from '../adapter.js';

export const cursorAdapter: HarnessAdapter = {
  id: 'cursor',

  // Cursor defaults to one machine-global OS-keychain login on macOS, ignoring XDG_CONFIG_HOME.
  // Select the file credential store, which Cursor writes to HOME-relative ~/.cursor/auth.json;
  // buildExecEnv already swaps HOME to the version home.
  applyExecConfigEnv(result, ctx) {
    if (ctx.versionHome) {
      result.AGENTS_REAL_HOME ||= result.HOME;
      result.HOME = ctx.versionHome;
      result.AGENT_CLI_CREDENTIAL_STORE = 'file';
    }
    stripForeignConfigDir(result);
  },

  execPreModeArgs(ctx) {
    // A configured headless run is the workspace trust decision, in plan mode too: an untrusted cwd
    // otherwise blocks on Cursor's trust prompt with no one to answer. Kept narrower than
    // --yolo/-f, which skip already passes and which also bypasses permission checks.
    return ctx.resolvedMode !== 'skip' && !ctx.interactive ? ['--trust'] : undefined;
  },

  // Headless read-only runs use ask mode, not --plan: in plan mode Cursor delivers its answer via
  // the createPlan tool, which `-p` text output never prints, so the run exits 0 with empty stdout.
  // Ask mode is equally read-only and prints. Interactive plan keeps --plan.
  execModeArgs(ctx) {
    return ctx.resolvedMode === 'plan' && !ctx.interactive ? ['--mode', 'ask'] : undefined;
  },

  routineModeArgs(cmd, ctx) {
    if (ctx.mode === 'plan') {
      cmd.push('--mode', 'ask', '--trust');
    } else if (ctx.mode === 'skip') {
      cmd.push('-f');
    } else {
      // The configured cwd is the user's workspace trust decision. --trust is
      // narrower than --yolo/-f because it does not bypass tool permissions.
      cmd.push('--trust');
    }
  },
};
