import * as fs from 'fs';
import * as path from 'path';
import * as TOML from 'smol-toml';
import * as yaml from 'yaml';
import type { AgentId } from '../../types.js';
import { capableAgents } from '../../capabilities.js';
import {
  discoverPermissionGroups,
  buildPermissionsFromGroups,
  CODEX_RULES_FILENAME,
} from '../../permissions.js';
import type { ResourceDetector, DetectArgs } from './types.js';
import { lazyAgentMap } from '../writers/lazy-map.js';

function buildClaudeDetector(): ResourceDetector {
  return {
    kind: 'permissions',
    agent: 'claude',
    list({ versionHome }: DetectArgs): string[] {
      const settingsPath = path.join(versionHome, '.claude', 'settings.json');
      if (!fs.existsSync(settingsPath)) return [];
      try {
        const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
        const allowRules: string[] = settings.permissions?.allow || [];
        const denyRules: string[] = settings.permissions?.deny || [];
        if (allowRules.length === 0 && denyRules.length === 0) return [];

        // Claude retains concrete rules, so provenance can be reconstructed by intersection.
        const groups = discoverPermissionGroups();
        const applied: string[] = [];
        for (const group of groups) {
          const built = buildPermissionsFromGroups([group.name]);
          if (built.allow.length === 0 && (!built.deny || built.deny.length === 0)) {
            applied.push(group.name);
            continue;
          }
          const hasAllow = built.allow.some(r => allowRules.includes(r));
          const hasDeny = built.deny?.some(r => denyRules.includes(r)) || false;
          if (hasAllow || hasDeny) applied.push(group.name);
        }
        return applied;
      } catch {
        return [];
      }
    },
  };
}

function buildCodexDetector(): ResourceDetector {
  // Native formats below lose group identity; once an artifact exists they must
  // report all known groups rather than invent lossy per-group provenance.
  return {
    kind: 'permissions',
    agent: 'codex',
    list({ versionHome }: DetectArgs): string[] {
      const codexConfigPath = path.join(versionHome, '.codex', 'config.toml');
      const codexRulesPath = path.join(versionHome, '.codex', 'rules', CODEX_RULES_FILENAME);
      const hasConfig = fs.existsSync(codexConfigPath);
      const hasRules = fs.existsSync(codexRulesPath);
      if (!hasConfig && !hasRules) return [];
      try {
        let hasPermKeys = false;
        if (hasConfig) {
          const config = TOML.parse(fs.readFileSync(codexConfigPath, 'utf-8')) as Record<string, unknown>;
          hasPermKeys = !!(config.approval_policy || config.sandbox_mode || config.sandbox_workspace_write);
        }
        if (hasPermKeys || hasRules) {
          return discoverPermissionGroups().map(g => g.name);
        }
      } catch {  }
      return [];
    },
  };
}

function buildOpenCodeDetector(): ResourceDetector {
  return {
    kind: 'permissions',
    agent: 'opencode',
    list({ versionHome }: DetectArgs): string[] {
      const opencodeConfigPath = path.join(versionHome, '.config', 'opencode', 'opencode.jsonc');
      if (!fs.existsSync(opencodeConfigPath)) return [];
      try {
        const content = fs.readFileSync(opencodeConfigPath, 'utf-8');
        const stripped = content.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
        const config = JSON.parse(stripped);
        if (config.permission && Object.keys(config.permission.bash || {}).length > 0) {
          return discoverPermissionGroups().map(g => g.name);
        }
      } catch {  }
      return [];
    },
  };
}

function buildAntigravityDetector(): ResourceDetector {
  return {
    kind: 'permissions',
    agent: 'antigravity',
    list({ versionHome }: DetectArgs): string[] {
      const settingsPath = path.join(versionHome, '.gemini', 'antigravity-cli', 'settings.json');
      if (!fs.existsSync(settingsPath)) return [];
      try {
        const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
        const perms = settings?.permissions;
        const hasAllow = Array.isArray(perms?.allow) && perms.allow.length > 0;
        const hasDeny = Array.isArray(perms?.deny) && perms.deny.length > 0;
        if (hasAllow || hasDeny) {
          return discoverPermissionGroups().map(g => g.name);
        }
      } catch {  }
      return [];
    },
  };
}

function buildGrokDetector(): ResourceDetector {
  return {
    kind: 'permissions',
    agent: 'grok',
    list({ versionHome }: DetectArgs): string[] {
      const configPath = path.join(versionHome, '.grok', 'config.toml');
      if (!fs.existsSync(configPath)) return [];
      try {
        const config = TOML.parse(fs.readFileSync(configPath, 'utf-8')) as Record<string, unknown>;
        const perm = config.permission as { rules?: unknown[] } | undefined;
        if (perm && Array.isArray(perm.rules) && perm.rules.length > 0) {
          return discoverPermissionGroups().map(g => g.name);
        }
      } catch {  }
      return [];
    },
  };
}


function buildKimiDetector(): ResourceDetector {
  return {
    kind: 'permissions',
    agent: 'kimi',
    list({ versionHome }: DetectArgs): string[] {
      const configPath = path.join(versionHome, '.kimi-code', 'config.toml');
      if (!fs.existsSync(configPath)) return [];
      try {
        const config = TOML.parse(fs.readFileSync(configPath, 'utf-8')) as Record<string, unknown>;
        const perm = config.permission as { rules?: unknown[] } | undefined;
        if (perm && Array.isArray(perm.rules) && perm.rules.length > 0) {
          return discoverPermissionGroups().map(g => g.name);
        }
      } catch {  }
      return [];
    },
  };
}

function buildCursorDetector(): ResourceDetector {
  return {
    kind: 'permissions',
    agent: 'cursor',
    list({ versionHome }: DetectArgs): string[] {
      const configPath = path.join(versionHome, '.cursor', 'cli-config.json');
      if (!fs.existsSync(configPath)) return [];
      try {
        const config = JSON.parse(fs.readFileSync(configPath, 'utf-8')) as {
          permissions?: { allow?: string[]; deny?: string[] };
        };
        const allow = config.permissions?.allow?.length ?? 0;
        const deny = config.permissions?.deny?.length ?? 0;
        if (allow + deny > 0) return discoverPermissionGroups().map(g => g.name);
      } catch {  }
      return [];
    },
  };
}

function buildDroidDetector(): ResourceDetector {
  return {
    kind: 'permissions',
    agent: 'droid',
    list({ versionHome }: DetectArgs): string[] {
      const settingsPath = path.join(versionHome, '.factory', 'settings.json');
      if (!fs.existsSync(settingsPath)) return [];
      try {
        const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
        const hasAllow = Array.isArray(settings.commandAllowlist) && settings.commandAllowlist.length > 0;
        const hasDeny = Array.isArray(settings.commandDenylist) && settings.commandDenylist.length > 0;
        if (hasAllow || hasDeny) return discoverPermissionGroups().map(g => g.name);
      } catch {  }
      return [];
    },
  };
}

function buildOpenClawDetector(): ResourceDetector {
  return {
    kind: 'permissions',
    agent: 'openclaw',
    list({ versionHome }: DetectArgs): string[] {
      const configPath = path.join(versionHome, '.openclaw', 'openclaw.json');
      if (!fs.existsSync(configPath)) return [];
      try {
        const config = JSON.parse(fs.readFileSync(configPath, 'utf-8')) as {
          tools?: { alsoAllow?: unknown[]; deny?: unknown[] };
        };
        const tools = config.tools;
        const hasAllow = Array.isArray(tools?.alsoAllow) && tools.alsoAllow.length > 0;
        const hasDeny = Array.isArray(tools?.deny) && tools.deny.length > 0;
        if (hasAllow || hasDeny) {
          return discoverPermissionGroups().map(g => g.name);
        }
      } catch {  }
      return [];
    },
  };
}

function buildCopilotDetector(): ResourceDetector {
  return {
    kind: 'permissions',
    agent: 'copilot',
    list({ versionHome, cwd }: DetectArgs): string[] {
      const configPath = path.join(versionHome, '.copilot', 'permissions-config.json');
      if (!fs.existsSync(configPath)) return [];
      try {
        const config = JSON.parse(fs.readFileSync(configPath, 'utf-8')) as {
          locations?: Record<string, { tool_approvals?: unknown[]; allowed_directories?: unknown[] }>;
        };
        const locations = config.locations && typeof config.locations === 'object' && !Array.isArray(config.locations)
          ? config.locations
          : {};
        const location = locations[path.resolve(cwd)];
        const hasApprovals = Array.isArray(location?.tool_approvals) && location.tool_approvals.length > 0;
        const hasDirectories = Array.isArray(location?.allowed_directories) && location.allowed_directories.length > 0;
        if (hasApprovals || hasDirectories) return discoverPermissionGroups().map(g => g.name);
      } catch {  }
      return [];
    },
  };
}

function buildHermesDetector(): ResourceDetector {
  return {
    kind: 'permissions',
    agent: 'hermes',
    list({ versionHome }: DetectArgs): string[] {
      const configPath = path.join(versionHome, '.hermes', 'config.yaml');
      if (!fs.existsSync(configPath)) return [];
      try {
        const config = yaml.parse(fs.readFileSync(configPath, 'utf-8')) as {
          command_allowlist?: unknown[];
          approvals?: { deny?: unknown[] };
        } | null;
        const hasAllow = Array.isArray(config?.command_allowlist) && config.command_allowlist.length > 0;
        const hasDeny = Array.isArray(config?.approvals?.deny) && config.approvals.deny.length > 0;
        if (hasAllow || hasDeny) return discoverPermissionGroups().map(g => g.name);
      } catch {  }
      return [];
    },
  };
}

const handlers: Partial<Record<AgentId, () => ResourceDetector>> = {
  claude: buildClaudeDetector,
  codex: buildCodexDetector,
  opencode: buildOpenCodeDetector,
  antigravity: buildAntigravityDetector,
  grok: buildGrokDetector,
  kimi: buildKimiDetector,
  cursor: buildCursorDetector,
  droid: buildDroidDetector,
  openclaw: buildOpenClawDetector,
  copilot: buildCopilotDetector,
  hermes: buildHermesDetector,
};

export const permissionsDetectors = lazyAgentMap<ResourceDetector>(() => {
  const m: Partial<Record<AgentId, ResourceDetector>> = {};
  for (const agent of capableAgents('allowlist')) {
    const f = handlers[agent];
    if (f) m[agent] = f();
  }
  return m;
});
