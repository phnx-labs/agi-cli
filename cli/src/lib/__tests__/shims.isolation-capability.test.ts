import { describe, it, expect } from 'vitest';

import {
  CONFIG_ENV_ISOLATED_AGENTS,
  supportsIsolatedInstall,
  generateVersionedAliasScript,
} from '../installations/shims.js';
import { ALL_AGENT_IDS } from '../agents.js';
import type { AgentId } from '../types.js';

const CONFIG_ENV_BY_AGENT: Record<(typeof CONFIG_ENV_ISOLATED_AGENTS)[number], string> = {
  claude: 'CLAUDE_CONFIG_DIR',
  codex: 'CODEX_HOME',
  copilot: 'COPILOT_HOME',
  grok: 'GROK_HOME',
  kimi: 'KIMI_CODE_HOME',
  opencode: 'OPENCODE_CONFIG_DIR',
  muse: 'XDG_CONFIG_HOME',
  cursor: 'AGENT_CLI_CREDENTIAL_STORE',
};
const ALL_CONFIG_ENVS = Object.values(CONFIG_ENV_BY_AGENT);

const V = '1.0.0';

describe('isolated-install capability', () => {
  it('supportsIsolatedInstall matches the CONFIG_ENV_ISOLATED_AGENTS set', () => {
    for (const agent of ALL_AGENT_IDS) {
      expect(supportsIsolatedInstall(agent)).toBe(CONFIG_ENV_ISOLATED_AGENTS.includes(agent));
    }
  });

  it('every isolation-capable agent exports its config-dir env var in the versioned alias', () => {
    for (const agent of CONFIG_ENV_ISOLATED_AGENTS) {
      const script = generateVersionedAliasScript(agent, V);
      expect(script).toContain(`export ${CONFIG_ENV_BY_AGENT[agent]}=`);
    }
  });

  it('Cursor aliases force the file credential store instead of the global macOS keychain', () => {
    const script = generateVersionedAliasScript('cursor', V);
    expect(script).toContain('export AGENT_CLI_CREDENTIAL_STORE="file"');
  });

  it('the alias generator and the capability list stay in sync', () => {
    for (const agent of ALL_AGENT_IDS) {
      const script = generateVersionedAliasScript(agent, V);
      const emitsConfigEnv = ALL_CONFIG_ENVS.some((env) => script.includes(`export ${env}=`));
      expect(emitsConfigEnv).toBe(supportsIsolatedInstall(agent));
    }
  });

  it('agents without an env var export none in the versioned alias', () => {
    const unsupported: AgentId[] = ALL_AGENT_IDS.filter((a) => !supportsIsolatedInstall(a));
    for (const agent of unsupported) {
      const script = generateVersionedAliasScript(agent, V);
      for (const env of ALL_CONFIG_ENVS) {
        expect(script).not.toContain(`export ${env}=`);
      }
    }
  });
});
