import * as path from 'path';
import type { HarnessAdapter } from '../adapter.js';
import { stripForeignConfigDir, slotAwareConfigEnvBash } from '../adapter.js';

export const kimiAdapter: HarnessAdapter = {
  id: 'kimi',

  // Kimi honors KIMI_CODE_HOME (relocates ~/.kimi-code, including config,
  // skills, hooks, sessions). Pin it at the per-version home.
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
    // kimi's headless prompt mode (`-p`/`--prompt`) is self-contained and REFUSES
    // to be combined with any startup-mode flag: `--plan`, `--auto`, and `--yolo`
    // all abort with "Cannot combine --prompt with --X" (verified against the live
    // kimi CLI). The write-capable modes (edit/auto/skip) all collapse to kimi's
    // default `-p` behavior, which already auto-approves tool calls, so we emit no
    // mode flag. An interactive kimi run defers to the generic modeFlags path.
    if (ctx.interactive) return undefined;
    // Plan can't reach here headless — resolveHeadlessMode already downgraded it to
    // auto (kimi's headlessPlan:false); this asserts that invariant so a plan-mode
    // run can never silently mutate the workspace.
    if (ctx.resolvedMode === 'plan') {
      throw new Error(
        `Internal error: kimi reached headless command build with resolved mode 'plan'; ` +
          `resolveHeadlessMode should have downgraded it to auto (capabilities.headlessPlan is false).`,
      );
    }
    // edit/auto/skip: emit no mode flag — `kimi -p` auto-runs.
    return [];
  },

  routineModeArgs(_cmd, ctx) {
    // kimi daemon jobs always run headless via `--prompt`, which cannot be
    // combined with any startup-mode flag (--plan/--auto/--yolo all abort with
    // "Cannot combine --prompt with --X"). edit/auto/skip reduce to kimi's default
    // headless auto-run, so emit no flag. plan has no headless read-only
    // equivalent, so resolveHeadlessMode downgrades a plan request to auto with a
    // stderr warning (kimi's headlessPlan is false) — routines run headless, so
    // interactive is always false here. The returned mode carries no flag either.
    ctx.resolveHeadlessMode('kimi', ctx.mode, false);
  },
};
