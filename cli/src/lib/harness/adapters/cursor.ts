import type { HarnessAdapter } from '../adapter.js';
import { stripForeignConfigDir } from '../adapter.js';

export const cursorAdapter: HarnessAdapter = {
  id: 'cursor',

  applyExecConfigEnv(result, ctx) {
    if (ctx.versionHome) {
      result.AGENTS_REAL_HOME ||= result.HOME;
      result.HOME = ctx.versionHome;
      result.AGENT_CLI_CREDENTIAL_STORE = 'file';
    }
    stripForeignConfigDir(result);
  },

  execPreModeArgs(ctx) {
    return ctx.resolvedMode !== 'skip' && !ctx.interactive ? ['--trust'] : undefined;
  },

  execModeArgs(ctx) {
    return ctx.resolvedMode === 'plan' && !ctx.interactive ? ['--mode', 'ask'] : undefined;
  },

  routineModeArgs(cmd, ctx) {
    if (ctx.mode === 'plan') {
      cmd.push('--mode', 'ask', '--trust');
    } else if (ctx.mode === 'skip') {
      cmd.push('-f');
    } else {
      cmd.push('--trust');
    }
  },
};
