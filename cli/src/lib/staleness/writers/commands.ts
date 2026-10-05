import * as fs from 'fs';
import * as path from 'path';
import type { AgentId } from '../../types.js';
import { AGENTS, MANAGED_AGENT_IDS, agentConfigDirName } from '../../agents.js';
import { supports } from '../../capabilities.js';
import { safeJoin } from '../../paths.js';
import { markdownToToml } from '../../convert.js';
import { commandAppliesTo, parseCommandMetadata } from '../../commands.js';
import {
  commandSkillName,
  installCommandSkillToVersion,
  listCommandSkillsInVersion,
  removeCommandSkillFromVersion,
  shouldAlsoInstallCommandAsSkill,
  shouldInstallCommandAsSkill,
} from '../../command-skills.js';
import {
  installGooseCommandToVersion,
  listGooseCommandsInVersion,
  removeGooseCommandFromVersion,
} from '../../goose-commands.js';
import type { ResourceWriter, WriteArgs, WriteResult, RemoveArgs, RemoveResult } from './types.js';
import { resolveCommandSource, trustedSkillRoots } from './sources.js';
import { lazyAgentMap } from './lazy-map.js';

function buildCommandsWriter(agent: AgentId): ResourceWriter<string[]> {
  return {
    kind: 'commands',
    agent,
    write({ version, versionHome, selection }: WriteArgs<string[]>): WriteResult {
      const agentConfig = AGENTS[agent];
      const agentDir = path.join(versionHome, agentConfigDirName(agent));
      const commandsAsSkills = shouldInstallCommandAsSkill(agent, version);
      const commandsAlsoAsSkills = shouldAlsoInstallCommandAsSkill(agent, version);
      const supportsCommands = supports(agent, 'commands', version).ok;

      if (!commandsAsSkills && !supportsCommands) {
        return { synced: [] };
      }

      const skillRoots = trustedSkillRoots();
      const commandsTarget = path.join(agentDir, agentConfig.commandsSubdir);
      if (!commandsAsSkills) {
        fs.mkdirSync(commandsTarget, { recursive: true });
      }

      const synced: string[] = [];
      const paths: string[] = [];
      for (const cmd of selection) {
        const srcFile = resolveCommandSource(cmd);
        if (!srcFile) continue;

        const metadata = parseCommandMetadata(srcFile);
        if (!commandAppliesTo(agent, version, metadata).ok) continue;

        if (commandsAsSkills || commandsAlsoAsSkills) {
          const installed = installCommandSkillToVersion(agentDir, cmd, srcFile, skillRoots);
          if (!installed.success) continue;
          if (!installed.skipped) {
            paths.push(safeJoin(path.join(agentDir, 'skills'), commandSkillName(cmd)));
          }
        }

        if (supportsCommands && agent === 'goose') {
          const installed = installGooseCommandToVersion(versionHome, cmd, srcFile);
          if (!installed.success) continue;
        } else if (supportsCommands && agentConfig.format === 'toml') {
          const content = fs.readFileSync(srcFile, 'utf-8');
          const tomlContent = markdownToToml(cmd, content);
          const dest = safeJoin(commandsTarget, `${cmd}.toml`);
          fs.writeFileSync(dest, tomlContent);
          paths.push(dest);
        } else if (supportsCommands) {
          const dest = safeJoin(commandsTarget, `${cmd}.md`);
          fs.copyFileSync(srcFile, dest);
          paths.push(dest);
        }
        synced.push(cmd);
      }
      return { synced, paths };
    },
    remove({ versionHome, name }: RemoveArgs): RemoveResult {
      const agentConfig = AGENTS[agent];
      const agentDir = path.join(versionHome, agentConfigDirName(agent));
      let removed = false;

      if (agentConfig.commandsSubdir) {
        const ext = agentConfig.format === 'toml' ? '.toml' : '.md';
        const nativeFile = safeJoin(path.join(agentDir, agentConfig.commandsSubdir), `${name}${ext}`);
        try {
          if (fs.existsSync(nativeFile) && fs.lstatSync(nativeFile).isFile()) {
            fs.unlinkSync(nativeFile);
            removed = true;
          }
        } catch {  }
      }

      if (listCommandSkillsInVersion(agentDir).includes(name)) {
        if (removeCommandSkillFromVersion(agentDir, name).success) removed = true;
      }

      if (agent === 'goose' && listGooseCommandsInVersion(versionHome).includes(name)) {
        if (removeGooseCommandFromVersion(versionHome, name).success) removed = true;
      }

      return { removed };
    },
  };
}

export const commandsWriters = lazyAgentMap<ResourceWriter<string[]>>(() => {
  const m: Partial<Record<AgentId, ResourceWriter<string[]>>> = {};
  for (const id of MANAGED_AGENT_IDS) {
    const cfg = AGENTS[id];
    if (cfg.capabilities.commands === false && (!cfg.skillsDir || cfg.skillsDir === '')) continue;
    if (cfg.capabilities.commands === false && (!cfg.commandsSubdir || cfg.commandsSubdir === '')) {
      if (cfg.nativeCommandRuntime) continue;
    }
    const hasCommands = cfg.capabilities.commands !== false;
    const hasSkills = cfg.capabilities.skills !== false;
    if (hasCommands || hasSkills) {
      m[id] = buildCommandsWriter(id);
    }
  }
  return m;
});
