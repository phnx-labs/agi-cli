import type { HarnessAdapter } from '../adapter.js';
import { stripForeignConfigDir } from '../adapter.js';

export const cursorAdapter: HarnessAdapter = {
  id: 'cursor',

  // Cursor defaults to one machine-global OS-keychain login on macOS, which
  // ignores XDG_CONFIG_HOME. Select the file credential store; Cursor writes
  // that store to HOME-relative ~/.cursor/auth.json, and buildExecEnv already
  // swaps HOME to the selected version home. Existing keychain credentials
  // remain untouched.
  applyExecConfigEnv(result, ctx) {
    if (ctx.versionHome) {
      result.AGENTS_REAL_HOME ||= result.HOME;
      result.HOME = ctx.versionHome;
      result.AGENT_CLI_CREDENTIAL_STORE = 'file';
    }
    stripForeignConfigDir(result);
  },

  execPreModeArgs(ctx) {
    // A configured headless run is the workspace trust decision, in plan mode
    // too: an untrusted cwd otherwise stops on Cursor's trust prompt with no one
    // to answer it. Keep this narrower than --yolo/-f, which skip already passes
    // and which also bypasses permission checks.
    return ctx.resolvedMode !== 'skip' && !ctx.interactive ? ['--trust'] : undefined;
  },

  routineModeArgs(cmd, ctx) {
    if (ctx.mode === 'plan') {
      cmd.push('--plan', '--trust');
    } else if (ctx.mode === 'skip') {
      cmd.push('-f');
    } else {
      // The configured cwd is the user's workspace trust decision. --trust is
      // narrower than --yolo/-f because it does not bypass tool permissions.
      cmd.push('--trust');
    }
  },
};
