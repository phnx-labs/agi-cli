import * as path from 'path';
import type { HarnessAdapter } from '../adapter.js';
import { stripForeignConfigDir, slotAwareConfigEnvBash } from '../adapter.js';

export const copilotAdapter: HarnessAdapter = {
  id: 'copilot',

  // Copilot honors COPILOT_HOME (relocates ~/.copilot, including settings,
  // mcp-config.json, sessions, logs). Pin it at the per-version home so
  // version switches isolate MCP servers, auth, and session history.
  applyExecConfigEnv(result, ctx) {
    if (ctx.versionHome) {
      result.COPILOT_HOME = path.join(ctx.versionHome, '.copilot');
    }
    stripForeignConfigDir(result, ['COPILOT_HOME']);
  },

  shimConfigEnvBash(ctx) {
    return `
# GitHub Copilot CLI honors COPILOT_HOME to relocate its config and state
# (settings.json, mcp-config.json, session-state/, logs/, plugins/). Point
# it at the versioned home so MCP servers, custom agents, and session
# history are isolated per copilot version.
# An account-slot launch has already chosen the home (AGENTS_EXEC_HOME); the pin
# yields to it — see slotAwareConfigEnvBash.
${slotAwareConfigEnvBash([{ env: 'COPILOT_HOME', rel: ctx.configDirName }], '$VERSION_DIR/home')}
`;
  },
};
