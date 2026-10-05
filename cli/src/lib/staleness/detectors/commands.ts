/** Commands detector, mirroring command dispatch in versions.ts: inspects the version home and
 * returns command names. */
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
      // For a dual-write target the native file is the authoritative record that the command
      // synced; the skill copy is derived and installCommandSkillToVersion writes none when a real
      // skill owns the name.
      return nativeCommands;
    },
  };
}

// Detector registration mirrors writers/commands.ts — skills-capable agents
// with no native command-file dir convert commands to skills by default; only
// agents with their own slash-command runtime (nativeCommandRuntime) opt out.
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
