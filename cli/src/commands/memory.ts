/**
 * `agents memory` — first-class knowledge/facts resource (not rules).
 *
 * Mirrors the skills surface at list / add / remove / view / sync scale.
 * Canonical storage: ~/.agents/memory/ (project > user > system layering).
 */

import type { Command } from 'commander';
import { withAliases } from '../lib/verbs.js';
import chalk from 'chalk';
import * as fs from 'fs';
import {
  listMemoryFacts,
  addMemoryFact,
  removeMemoryFact,
  readMemoryFact,
  getUserMemoryDir,
  syncMemoryToVersionHome,
} from '../lib/memory.js';
import { capableAgents } from '../lib/capabilities.js';
import { ALL_AGENT_IDS } from '../lib/agents.js';
import type { AgentId } from '../lib/types.js';
import {
  listInstalledVersions,
  getVersionHomePath,
} from '../lib/installations/versions.js';
import { supports } from '../lib/capabilities.js';
import { setHelpSections } from '../lib/help.js';

/** Register the `agents memory` command tree. */
export function registerMemoryCommands(program: Command): void {
  const memoryCmd = program
    .command('memory')
    .description('Manage portable agent memory (facts, preferences, project knowledge)');

  setHelpSections(memoryCmd, {
    examples: `
      # List all memory facts (project > user > system)
      agents memory list

      # Add a fact
      agents memory add preferred-editor --body "User prefers vim keybindings"

      # View a fact
      agents memory view preferred-editor

      # Remove a fact from the user layer
      agents memory remove preferred-editor

      # Fan out to all capable installed agent versions
      agents sync --memory
    `,
    notes: `
      Memory is the knowledge store (learned facts), distinct from rules
      (instructions / AGENTS.md persona). Stored under ~/.agents/memory/ and
      synced into capable agents' version homes (claude/codex/openclaw/grok).

      Format: MEMORY.md index + one <slug>.md file per fact.
    `,
  });

  withAliases(memoryCmd
    .command('list'), 'list')
    .description('List memory facts from project, user, and system layers')
    .option('--json', 'Emit machine-readable JSON')
    .action((options: { json?: boolean }) => {
      const facts = listMemoryFacts(process.cwd());
      if (options.json) {
        process.stdout.write(JSON.stringify(facts, null, 2) + '\n');
        return;
      }
      if (facts.length === 0) {
        console.log(chalk.gray('No memory facts yet.'));
        console.log(chalk.gray(`  Add one: agents memory add <name> --body "..."`));
        console.log(chalk.gray(`  Dir:     ${getUserMemoryDir()}`));
        return;
      }
      console.log(chalk.bold(`Memory (${facts.length})`));
      for (const f of facts) {
        const layer = chalk.dim(`[${f.layer}]`);
        console.log(`  ${chalk.cyan(f.name)} ${layer}  ${f.summary}`);
      }
      const capable = capableAgents('memory');
      if (capable.length > 0) {
        console.log(chalk.gray(`\nCapable agents: ${capable.join(', ')}`));
      }
    });

  memoryCmd
    .command('add <name>')
    .description('Add or overwrite a user-layer memory fact')
    .requiredOption('--body <text>', 'Fact body (markdown)')
    .option('--sync', 'Immediately sync to all capable installed versions')
    .action((name: string, options: { body: string; sync?: boolean }) => {
      const filePath = addMemoryFact(name, options.body);
      console.log(chalk.green(`Added memory fact: ${name}`));
      console.log(chalk.gray(`  ${filePath}`));
      if (options.sync) {
        for (const r of syncAllMemory(process.cwd())) {
          console.log(chalk.gray(`  synced ${r.agent}@${r.version} (${r.facts.length} facts)`));
        }
      } else {
        console.log(chalk.gray('  Run: agents sync --memory to fan out'));
      }
    });

  withAliases(memoryCmd
    .command('remove <name>'), 'remove')
    .description('Remove a user-layer memory fact')
    .action((name: string) => {
      if (removeMemoryFact(name)) {
        console.log(chalk.green(`Removed memory fact: ${name}`));
      } else {
        console.error(chalk.red(`No user-layer fact named "${name}"`));
        process.exit(1);
      }
    });

  withAliases(memoryCmd
    .command('view <name>'), 'view')
    .description('Print a memory fact (winning layer)')
    .action((name: string) => {
      const fact = readMemoryFact(name, process.cwd());
      if (!fact) {
        console.error(chalk.red(`No memory fact named "${name}"`));
        process.exit(1);
      }
      console.log(chalk.dim(`# ${fact.name}  [${fact.layer}]  ${fact.path}`));
      console.log(fs.readFileSync(fact.path, 'utf-8'));
    });

}

function syncAllMemory(cwd: string): { agent: AgentId; version: string; facts: string[] }[] {
  const out: { agent: AgentId; version: string; facts: string[] }[] = [];
  for (const agent of ALL_AGENT_IDS) {
    if (!supports(agent, 'memory').ok) continue;
    for (const version of listInstalledVersions(agent)) {
      const home = getVersionHomePath(agent, version);
      out.push({ agent, version, facts: syncMemoryToVersionHome(agent, home, cwd) });
    }
  }
  return out;
}
