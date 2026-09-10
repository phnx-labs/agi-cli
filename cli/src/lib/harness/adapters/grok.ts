import * as path from 'path';
import type { HarnessAdapter } from '../adapter.js';
import { stripForeignConfigDir, slotAwareConfigEnvBash } from '../adapter.js';

export const grokAdapter: HarnessAdapter = {
  id: 'grok',

  applyExecConfigEnv(result, ctx) {
    if (ctx.versionHome) {
      result.GROK_HOME = path.join(ctx.versionHome, '.grok');
    }
    stripForeignConfigDir(result, ['GROK_HOME']);
  },

  shimConfigEnvBash() {
    return `
# Grok Build uses GROK_HOME to isolate its entire configuration tree
# (skills, hooks, plugins, agents, memory, sessions, config.toml, MCP, etc.).
# This gives agents-cli full versioned isolation + resource sync for grok.
# An account-slot launch has already chosen the home (AGENTS_EXEC_HOME); the pin
# yields to it — see slotAwareConfigEnvBash.
${slotAwareConfigEnvBash([{ env: 'GROK_HOME', rel: '.grok' }], '$VERSION_DIR/home')}
`;
  },
};
