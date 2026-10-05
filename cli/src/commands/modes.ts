/** `agents modes` lists the permission modes a harness accepts for `agents run` / `teams add`,
 * mirroring `agents models`. Modes are per-agent, not version-gated; `agent@version` also shows
 * the configured run.defaults mode. */

import type { Command } from 'commander';
import chalk from 'chalk';
import {
  AGENTS,
  ALL_AGENT_IDS,
  agentLabel,
  formatAgentError,
  resolveAgentName,
} from '../lib/agents.js';
import {
  formatModeFlags,
  getAgentModesCatalog,
  type AgentModesCatalog,
} from '../lib/agent-modes.js';
import { setHelpSections } from '../lib/help.js';
import type { AgentId } from '../lib/types.js';
import { getGlobalDefault, listInstalledVersions, resolveVersion, resolveVersionAlias } from '../lib/installations/versions.js';

/** Agents that show in the no-arg overview (skip hard-deprecated). */
const MODE_AGENTS: AgentId[] = ALL_AGENT_IDS.filter((id) => !AGENTS[id].deprecated?.hard);

interface Target {
  agent: AgentId;
  version: string | null;
  isDefault: boolean;
}

/** Register `agents modes [agent[@version]]`. */
export function registerModesCommand(program: Command): void {
  const modes = program
    .command('modes [agentSpec]')
    .description(
      'Show which permission modes (--mode plan|edit|auto|skip) a harness supports for agents run / teams add',
    )
    .option('--json', 'Output machine-readable JSON')
    .action((agentSpec: string | undefined, options: { json?: boolean }) => {
      const targets = resolveTargets(agentSpec);
      if (targets.length === 0) process.exit(1);

      if (options.json) {
        const out = targets.map(({ agent, version }) => {
          const catalog = getAgentModesCatalog(agent, version);
          return {
            agent,
            version,
            defaultMode: catalog.defaultMode,
            configuredMode: catalog.configuredMode,
            configuredModeSource: catalog.configuredModeSource,
            headlessPlan: catalog.headlessPlan,
            modes: catalog.modes.map((m) => ({
              mode: m.mode,
              flags: m.flags,
              description: m.description,
              isDefault: m.isDefault,
            })),
            unsupported: catalog.unsupported,
            notes: catalog.notes,
          };
        });
        console.log(JSON.stringify(out, null, 2));
        return;
      }

      let printed = 0;
      for (const { agent, version, isDefault } of targets) {
        if (printed > 0) console.log();
        printCatalog(getAgentModesCatalog(agent, version), version, isDefault);
        printed++;
      }
      if (!agentSpec) {
        console.log(
          chalk.gray(
            '\n  `agents modes <agent>` for one harness · `agents modes claude@2.1.219` for a version\'s run default',
          ),
        );
        console.log(chalk.gray('  Pass --mode on `agents run` / `agents teams add`. Models: `agents models <agent>`.'));
      }
    });

  setHelpSections(modes, {
    examples: `
      agents modes
      agents modes claude
      agents modes claude@2.1.219
      agents modes cursor --json
    `,
    notes: `
      Permission modes control how much the agent can do (not which LLM model
      runs — that is --model / agents models). Supported modes come from each
      harness's capabilities table; unsupported requests degrade (auto→edit,
      plan→safest native) or error (skip when missing).
      'full' is a silent alias for skip.
      agent@version is accepted so any configured run.defaults mode for that
      version is shown; the mode list itself is per-agent today.
    `,
  });
}

function resolveTargets(agentSpec: string | undefined): Target[] {
  if (!agentSpec) {
    const targets: Target[] = [];
    for (const agent of MODE_AGENTS) {
      const version = getGlobalDefault(agent) || listInstalledVersions(agent)[0] || null;
      targets.push({ agent, version, isDefault: true });
    }
    return targets;
  }

  const [agentName, versionSpec] = agentSpec.split('@');
  const agent = resolveAgentName(agentName);
  if (!agent) {
    console.error(chalk.red(formatAgentError(agentName, MODE_AGENTS)));
    return [];
  }
  if (AGENTS[agent].deprecated?.hard) {
    console.error(chalk.yellow(`${agent} is deprecated and no longer supports run modes.`));
    return [];
  }

  if (versionSpec === 'all') {
    const installed = listInstalledVersions(agent);
    if (installed.length === 0) {
      return [{ agent, version: null, isDefault: true }];
    }
    return installed.map((v) => ({
      agent,
      version: v,
      isDefault: v === getGlobalDefault(agent),
    }));
  }

  if (versionSpec) {
    // resolveVersionAlias exits process if the concrete version is not installed.
    const version = resolveVersionAlias(agent, versionSpec) ?? null;
    return [{ agent, version, isDefault: version === getGlobalDefault(agent) }];
  }

  const version = resolveVersion(agent, process.cwd()) || getGlobalDefault(agent) || null;
  return [{ agent, version, isDefault: true }];
}

function printCatalog(catalog: AgentModesCatalog, version: string | null, isDefault: boolean): void {
  const tag = version
    ? ` ${chalk.bold(version)}${isDefault ? chalk.gray(' (default)') : ''}`
    : chalk.gray(' (not installed)');
  console.log(`${agentLabel(catalog.agent)}${tag}`);

  console.log(chalk.gray('  modes:'));
  for (const entry of catalog.modes) {
    const star = entry.isDefault ? chalk.cyan('*') : ' ';
    const flags = chalk.gray(formatModeFlags(entry.flags));
    console.log(
      `  ${star} ${chalk.cyan(entry.mode.padEnd(6))} ${chalk.bold(entry.description)}  ${flags}`,
    );
  }

  if (catalog.unsupported.length > 0) {
    console.log(chalk.gray(`  unsupported: ${catalog.unsupported.join(', ')}`));
  }

  const defaultBits: string[] = [`native default ${chalk.white(catalog.defaultMode)}`];
  if (catalog.configuredMode) {
    const src = catalog.configuredModeSource ? chalk.gray(` (${catalog.configuredModeSource})`) : '';
    defaultBits.push(`run default ${chalk.white(catalog.configuredMode)}${src}`);
  }
  console.log(chalk.gray(`  ${defaultBits.join(' · ')}`));

  if (!catalog.headlessPlan && catalog.modes.some((m) => m.mode === 'plan')) {
    console.log(chalk.yellow('  headless plan: not supported (interactive plan still works)'));
  }

  for (const note of catalog.notes) {
    // Keep the full-alias note quiet; surface degrades more visibly.
    if (note.startsWith("'full'")) continue;
    console.log(chalk.gray(`  note: ${note}`));
  }
}
