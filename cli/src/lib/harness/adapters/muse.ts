import * as path from 'path';
import type { HarnessAdapter } from '../adapter.js';
import { stripForeignConfigDir, slotAwareConfigEnvBash } from '../adapter.js';

export const museAdapter: HarnessAdapter = {
  id: 'muse',

  // Muse has no MUSE_CONFIG_DIR. Config is XDG-based:
  //   $XDG_CONFIG_HOME/muse  (settings, skills, hooks, auth)
  //   $XDG_DATA_HOME/muse    (sessions, plugins)
  // Pin both into the version home so multi-version isolation matches
  // Claude's CLAUDE_CONFIG_DIR / Codex's CODEX_HOME, and so Muse never
  // resolves through the adopt-time ~/.config/muse symlink (SymlinkOrReparse).
  applyExecConfigEnv(result, ctx) {
    if (ctx.versionHome) {
      result.XDG_CONFIG_HOME = path.join(ctx.versionHome, '.config');
      result.XDG_DATA_HOME = path.join(ctx.versionHome, '.local', 'share');
    }
    stripForeignConfigDir(result, ['XDG_CONFIG_HOME', 'XDG_DATA_HOME']);
  },

  shimConfigEnvBash() {
    return `
# Muse Code has no MUSE_CONFIG_DIR. It resolves config via XDG:
#   $XDG_CONFIG_HOME/muse  (settings, skills, hooks, auth)
#   $XDG_DATA_HOME/muse    (sessions, plugins)
# Pin XDG into the version home so managed runs never walk the adopt-time
# ~/.config/muse -> version-home symlink — Muse refuses agent-definition
# sources that are SymlinkOrReparse (exit 1). Same idea as CLAUDE_CONFIG_DIR.
# An account-slot launch has already chosen the home (AGENTS_EXEC_HOME); the pins
# yield to it — see slotAwareConfigEnvBash.
${slotAwareConfigEnvBash([{ env: 'XDG_CONFIG_HOME', rel: '.config' }, { env: 'XDG_DATA_HOME', rel: '.local/share' }], '$VERSION_DIR/home')}
`;
  },

  // muse exec: plan ≈ no non-shell writes; auto skips approval prompts but
  // keeps the OS sandbox; skip is --yolo (no approval, no sandbox, trust).
  routineModeArgs(cmd, ctx) {
    if (ctx.mode === 'plan') {
      cmd.push('--disable-write');
    } else if (ctx.mode === 'auto') {
      cmd.push('--disable-approval');
    } else if (ctx.mode === 'skip') {
      cmd.push('--yolo');
    }
    // edit: default on-request approval + sandbox
  },
};
