import * as fs from 'fs';
import * as path from 'path';
import type { AgentId } from '../../types.js';
import { AGENTS, MANAGED_AGENT_IDS, agentConfigDirName } from '../../agents.js';
import {
  listCommandSkillsInVersion,
  shouldInstallCommandAsSkill,
} from '../../command-skills.js';
import type { ResourceDetector, DetectArgs } from './types.js';
import { lazyAgentMap } from '../writers/lazy-map.js';

function buildCommandsDetector(agent: AgentId): ResourceDetector {
  return {
    kind: 'commands',
    agent,
    list({ version, versionHome }: DetectArgs): string[] {
      const agentConfig = AGENTS[agent];
      const agentDir = path.join(versionHome, agentConfigDirName(agent));



      if (shouldInstallCommandAsSkill(agent, version)) {
        return listCommandSkillsInVersion(agentDir);
      }
      const commandsDir = path.join(agentDir, agentConfig.commandsSubdir);
      if (!fs.existsSync(commandsDir)) return [];
      const ext = agentConfig.format === 'toml' ? '.toml' : '.md';
      const nativeCommands = fs.readdirSync(commandsDir)
        .filter(f => f.endsWith(ext))
        .map(f => f.replace(new RegExp(`\\${ext}$`), ''));
      return nativeCommands;
    },
  };
}

export const commandsDetectors = lazyAgentMap<ResourceDetector>(() => {

  const m: Partial<Record<AgentId, ResourceDetector>> = {};
  for (const id of MANAGED_AGENT_IDS) {
    const cfg = AGENTS[id];
    if (cfg.capabilities.commands === false && (!cfg.commandsSubdir || cfg.commandsSubdir === '') && cfg.nativeCommandRuntime) continue;
    const hasCommands = cfg.capabilities.commands !== false;
    const hasSkills = cfg.capabilities.skills !== false;
    if (hasCommands || hasSkills) m[id] = buildCommandsDetector(id);
  }
  return m;
});
