import * as path from 'path';
import type { HarnessAdapter } from '../adapter.js';
import { stripForeignConfigDir, slotAwareConfigEnvBash } from '../adapter.js';

export const kimiAdapter: HarnessAdapter = {
  id: 'kimi',

  applyExecConfigEnv(result, ctx) {
    if (ctx.versionHome) {
      result.KIMI_CODE_HOME = path.join(ctx.versionHome, '.kimi-code');
    }
    stripForeignConfigDir(result, ['KIMI_CODE_HOME']);
  },

  shimConfigEnvBash(ctx) {
    return `
# Kimi Code CLI honors KIMI_CODE_HOME to relocate ~/.kimi-code (config.toml,
# mcp.json, sessions, skills, hooks). Point it at the versioned home.
# An account-slot launch has already chosen the home (AGENTS_EXEC_HOME); the pin
# yields to it — see slotAwareConfigEnvBash.
${slotAwareConfigEnvBash([{ env: 'KIMI_CODE_HOME', rel: ctx.configDirName }], '$VERSION_DIR/home')}
`;
  },

  execModeArgs(ctx) {
    // kimi's headless `-p`/`--prompt` mode refuses any startup-mode flag (`--plan`, `--auto`,
    // `--yolo` abort with "Cannot combine --prompt with --X"; verified live).
    if (ctx.interactive) return undefined;
    if (ctx.resolvedMode === 'plan') {
      throw new Error(
        `Internal error: kimi reached headless command build with resolved mode 'plan'; ` +
          `resolveHeadlessMode should have downgraded it to auto (capabilities.headlessPlan is false).`,
      );
    }
    return [];
  },

  routineModeArgs(_cmd, ctx) {
    // kimi daemon jobs always run headless via `--prompt`, which cannot combine with
    // --plan/--auto/--yolo. edit/auto/skip reduce to the default auto-run, so no flag; plan is
    // downgraded to auto with a stderr warning (no headless read-only equivalent).
    ctx.resolveHeadlessMode('kimi', ctx.mode, false);
  },
};
