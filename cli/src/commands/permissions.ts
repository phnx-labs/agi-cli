/** `agents permissions`: list, add, remove and view permission sets (allow/deny rules for bash,
 * tools, filesystem), with import from agent configs, GitHub or YAML, merge/replace semantics and
 * multi-version targeting. */
import type { Command } from 'commander';
import { withAliases } from '../lib/verbs.js';
import chalk from 'chalk';
import ora from 'ora';
import { terminalWidth, truncateToWidth, stringWidth } from '../lib/session/width.js';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { confirm, checkbox } from '@inquirer/prompts';

import {
  AGENTS,
  resolveAgentName,
  formatAgentError,
  agentLabel,
} from '../lib/agents.js';
import type { AgentId, PermissionSet } from '../lib/types.js';
import { cloneRepo } from '../lib/git.js';
import { capableAgents, isCapable } from '../lib/capabilities.js';
import {
  listInstalledPermissions,
  discoverPermissionsFromRepo,
  installPermissionSet,
  removePermissionSet,
  applyPermissionsToVersion,
  readAgentPermissions,
  exportPermissionsFromPath,
  detectPermissionAgentFromPath,
  getDefaultPermissionSet,
  computePermissionsDiff,
  mergePermissionSets,
  saveDefaultPermissionSet,
  containsBroadGrants,
} from '../lib/permissions.js';
import {
  listInstalledVersions,
  getGlobalDefault,
  getVersionHomePath,
  promptAgentVersionSelection,
  resolveAgentVersionTargets,
} from '../lib/installations/versions.js';
import { recordVersionResources } from '../lib/state.js';
import {
  isPromptCancelled,
  isInteractiveTerminal,
  parseCommaSeparatedList,
  printWithPager,
  requireInteractiveSelection,
  resolveAgentTargetsAutoInstalling,
  resolveListFilterOrExit,
} from './utils.js';

export function shouldRefuseBroadPermissions(
  permissions: ReturnType<typeof discoverPermissionsFromRepo>,
  allowBroadPermissions: boolean
): boolean {
  return !allowBroadPermissions && permissions.some((perm) => containsBroadGrants(perm.set) !== null);
}

export function registerPermissionsCommands(program: Command): void {
  const permissionsCmd = program
    .command('permissions')
    .description('Control what agents can access with allow/deny rules for bash, tools, and filesystem')
    .addHelpText('after', `
Permissions define the boundary of what an agent can touch. Rules are organized into named sets stored in ~/.agents/permissions/ as YAML files. Apply sets to specific agent versions to reduce permission prompts or lock down behavior.

Examples:
  # List permission sets in central storage
  agents permissions list

  # Check active permissions for an agent
  agents permissions list claude@2.1.112

  # Import permissions from an existing agent config
  agents permissions add ~/.claude/settings.json --agents claude

  # Install a permission set from GitHub
  agents permissions add gh:team/permissions --agents codex,claude

  # Apply a stored set to multiple versions
  agents permissions add --names default --agents claude@2.1.112,codex@0.116.0

When to use:
  - Reducing prompts: extract your allow list with 'agents permissions add ~/.claude/settings.json'
  - Team sync: share permission sets via 'agents permissions add gh:team/perms'
  - Version isolation: apply stricter permissions to experimental versions
`);

  withAliases(permissionsCmd
    .command('list [agent]'), 'list')
    .description('Show permission sets in storage or active permissions for an agent version')
    .option('-s, --scope <scope>', 'user (global) or project (repo-specific)', 'user')
    .action(async (agentArg, options) => {
      const cwd = process.cwd();

      // Helper to render permissions for a specific version
      /** Print one harness's permission block. claude/opencode/codex keep native renderings (Codex
       * has no rule list, so its sandbox mode is shown); every other allowlist-capable harness
       * renders the canonical allow/deny that `PERMISSION_TARGETS` reads back (RUSH-2676). */
      const renderPermissionBody = (agentId: AgentId, perms: unknown) => {
        if (agentId === 'claude') {
          const claudePerms = perms as { permissions: { allow: string[]; deny: string[] } };
          if (claudePerms.permissions.allow.length > 0) {
            console.log(chalk.green('    Allow:'));
            for (const p of claudePerms.permissions.allow) {
              console.log(`      ${chalk.cyan(p)}`);
            }
          }
          if (claudePerms.permissions.deny.length > 0) {
            console.log(chalk.red('    Deny:'));
            for (const p of claudePerms.permissions.deny) {
              console.log(`      ${chalk.yellow(p)}`);
            }
          }
        } else if (agentId === 'opencode') {
          const ocPerms = perms as { permission: { bash: Record<string, string> } };
          console.log(chalk.gray('    Bash commands:'));
          for (const [pattern, action] of Object.entries(ocPerms.permission.bash)) {
            const color = action === 'allow' ? chalk.green : action === 'deny' ? chalk.red : chalk.yellow;
            console.log(`      ${chalk.cyan(pattern)}: ${color(action)}`);
          }
        } else if (agentId === 'codex') {
          const codexPerms = perms as {
            approval_policy?: string;
            sandbox_mode?: string;
            sandbox_workspace_write?: { network_access?: boolean; writable_roots?: string[] };
          };
          if (codexPerms.approval_policy) {
            console.log(`    ${chalk.gray('approval_policy:')} ${chalk.cyan(codexPerms.approval_policy)}`);
          }
          if (codexPerms.sandbox_mode) {
            console.log(`    ${chalk.gray('sandbox_mode:')} ${chalk.cyan(codexPerms.sandbox_mode)}`);
          }
          if (codexPerms.sandbox_workspace_write) {
            const sw = codexPerms.sandbox_workspace_write;
            if (sw.network_access !== undefined) {
              console.log(`    ${chalk.gray('network_access:')} ${chalk.cyan(String(sw.network_access))}`);
            }
            if (sw.writable_roots && sw.writable_roots.length > 0) {
              console.log(`    ${chalk.gray('writable_roots:')}`);
              for (const r of sw.writable_roots) {
                console.log(`      ${chalk.cyan(r)}`);
              }
            }
          }
        } else {
          const set = perms as PermissionSet;
          if (set.allow?.length) {
            console.log(chalk.green('    Allow:'));
            for (const p of set.allow) console.log(`      ${chalk.cyan(p)}`);
          }
          if (set.deny?.length) {
            console.log(chalk.red('    Deny:'));
            for (const p of set.deny) console.log(`      ${chalk.yellow(p)}`);
          }
        }
        console.log();
      };

      const renderVersionPermissions = (
        agentId: AgentId,
        version: string,
        isDefault: boolean,
        home: string,
        scope: 'user' | 'project'
      ) => {
        const agent = AGENTS[agentId];
        const defaultLabel = isDefault ? ' default' : '';
        const versionStr = chalk.gray(` (${version}${defaultLabel})`);

        const perms = readAgentPermissions(agentId, scope, cwd, { home });
        if (!perms) {
          console.log(`  ${chalk.bold(agentLabel(agent.id))}${versionStr}: ${chalk.gray('none')}`);
          console.log();
          return;
        }

        console.log(`  ${chalk.bold(agentLabel(agent.id))}${versionStr}:`);
        renderPermissionBody(agentId, perms);
      };

      if (agentArg) {
        const parts = agentArg.split('@');
        const agentName = parts[0];

        const agentId = resolveAgentName(agentName);
        if (!agentId) {
          console.log(chalk.red(formatAgentError(agentName, capableAgents('allowlist'))));
          process.exit(1);
        }
        const requestedVersion = resolveListFilterOrExit(agentId, parts[1]) ?? null;

        if (!isCapable(agentId, 'allowlist')) {
          console.log(chalk.yellow(`${AGENTS[agentId].name} does not support fine-grained permissions`));
          return;
        }

        const agent = AGENTS[agentId];
        const installedVersions = listInstalledVersions(agentId);
        const defaultVer = getGlobalDefault(agentId);

        console.log(chalk.bold(`Installed Permissions for ${agentLabel(agent.id)} (${options.scope}):\n`));

        if (installedVersions.length === 0) {
          const perms = readAgentPermissions(agentId, options.scope, cwd);
          if (!perms) {
            console.log(chalk.gray(`  No permissions configured`));
            return;
          }

          console.log(`  ${chalk.bold(agentLabel(agent.id))}:`);
          renderPermissionBody(agentId, perms);
          return;
        }

        let versionsToShow: string[];
        if (requestedVersion === 'default') {
          if (!defaultVer) {
            console.log(chalk.yellow(`  No default version set for ${agentLabel(agent.id)}. Run: agents use ${agentId}@<version>`));
            return;
          }
          versionsToShow = [defaultVer];
        } else if (requestedVersion) {
          if (!installedVersions.includes(requestedVersion)) {
            console.log(chalk.red(`  Version ${requestedVersion} not installed for ${agentLabel(agent.id)}.`));
            console.log(chalk.gray(`  Installed versions: ${installedVersions.join(', ')}`));
            return;
          }
          versionsToShow = [requestedVersion];
        } else {
          versionsToShow = [...installedVersions].sort((a, b) => {
            if (a === defaultVer) return -1;
            if (b === defaultVer) return 1;
            return 0;
          });
        }

        for (const version of versionsToShow) {
          const home = getVersionHomePath(agentId, version);
          renderVersionPermissions(agentId, version, version === defaultVer, home, options.scope);
        }
      } else {
        const sets = listInstalledPermissions();

        if (sets.length === 0) {
          console.log(chalk.gray('No permission sets installed.'));
          console.log(chalk.gray('Use `agents permissions add <source>` to add permission sets.'));
          return;
        }

        console.log(chalk.bold('Installed Permission Sets:\n'));
        const permCols = terminalWidth();
        for (const perm of sets) {
          const prefix = `  ${chalk.cyan(perm.name)}`;
          const budget = permCols - stringWidth(prefix) - 3;
          const desc = perm.set.description && budget > 3
            ? ` - ${chalk.gray(truncateToWidth(perm.set.description, budget))}`
            : '';
          console.log(`${prefix}${desc}`);
          console.log(`    ${chalk.gray(`${perm.set.allow.length} allow, ${perm.set.deny?.length || 0} deny rules`)}`);
        }
      }
    });

  permissionsCmd
    .command('add [source]')
    .description('Import permissions from an agent config, YAML, or GitHub, then apply to versions')
    .option('-a, --agents <list>', 'Targets: claude, codex@0.116.0, or antigravity@default')
    .option('--names <list>', 'Permission set names from ~/.agents/permissions/ (comma-separated)')
    .option('--all', 'Apply to all installed versions instead of just defaults')
    .option('--replace', 'Replace managed permission block instead of merging (drops rules no longer in the set)')
    .option('--allow-broad-permissions', 'Allow permission packs that significantly weaken sandboxing')
    .option('-y, --yes', 'Skip all prompts and confirmations')
    .addHelpText('after', `
Examples:
  # Import from an existing agent config (merges into default.yml)
  agents permissions add ~/.claude/settings.json --agents claude

  # Install permission YAML from GitHub
  agents permissions add gh:team/permissions --agents codex,claude

  # Apply a stored set to specific versions
  agents permissions add --names default --agents claude@2.1.112,codex@0.116.0

  # Apply to all installed versions non-interactively
  agents permissions add --names default --all --yes

  # Replace (don't merge) — drop rules no longer in the central set
  agents permissions add --names default --agents claude@default --replace --yes
`)
    .action(async (source: string | undefined, options) => {
      try {
        const skipPrompts = options.yes || !isInteractiveTerminal();

        if (!source) {
          const installedSets = listInstalledPermissions();
          if (installedSets.length === 0) {
            console.log(chalk.yellow('No permission sets in ~/.agents/permissions/'));
            console.log(chalk.gray('\nTo add permissions from a file or repo:'));
            console.log(chalk.cyan('  agents permissions add ~/.claude/settings.json'));
            console.log(chalk.cyan('  agents permissions add gh:user/repo'));
            return;
          }

          const availableSetNames = installedSets.map((set) => set.name);
          const requestedNames = parseCommaSeparatedList(options.names);
          let selectedNames: string[];

          if (requestedNames.length > 0) {
            const missing = requestedNames.filter((name) => !availableSetNames.includes(name));
            if (missing.length > 0) {
              console.log(chalk.red(`Unknown permission set(s): ${missing.join(', ')}`));
              console.log(chalk.gray(`Available: ${availableSetNames.join(', ')}`));
              process.exit(1);
            }
            selectedNames = requestedNames;
          } else {
            if (!isInteractiveTerminal()) {
              requireInteractiveSelection('Selecting permission sets from ~/.agents/permissions/', [
                'agents permissions add --names default --agents codex',
                'agents permissions add ./permissions/default.yml --agents codex',
              ]);
            }

            const choices = installedSets.map((installed) => ({
              value: installed.name,
              name: installed.set.description
                ? `${installed.name}  ${chalk.gray(installed.set.description.slice(0, 40))}`
                : `${installed.name}  ${chalk.gray(`${installed.set.allow.length} allow, ${installed.set.deny?.length || 0} deny`)}`,
            }));

            const selected = await checkbox({
              message: 'Select permission sets to apply',
              choices: [
                { value: '__all__', name: chalk.bold('Select All') },
                ...choices,
              ],
            });

            if (selected.length === 0) {
              console.log(chalk.gray('No permission sets selected.'));
              return;
            }

            selectedNames = selected.includes('__all__')
              ? availableSetNames
              : selected.filter((s) => s !== '__all__');
          }

          let selectedAgents: AgentId[];
          let versionSelections: Map<AgentId, string[]>;

          if (options.agents) {
            const result = await resolveAgentTargetsAutoInstalling(options.agents, capableAgents('allowlist'), {
              yes: options.yes,
              allVersions: options.all,
            });
            if (!result) {
              console.log(chalk.gray('Cancelled.'));
              return;
            }
            selectedAgents = result.selectedAgents;
            versionSelections = result.versionSelections;
          } else if (options.all) {
            selectedAgents = [...capableAgents('allowlist')];
            versionSelections = new Map();
            for (const agentId of selectedAgents) {
              const versions = listInstalledVersions(agentId);
              if (versions.length > 0) {
                versionSelections.set(agentId, [...versions]);
              }
            }
          } else {
            const result = await promptAgentVersionSelection(
              capableAgents('allowlist'),
              { skipPrompts: options.yes }
            );
            selectedAgents = result.selectedAgents;
            versionSelections = result.versionSelections;
          }

          if (selectedAgents.length === 0) {
            console.log(chalk.yellow('\nNo agents selected.'));
            return;
          }

          let applied = 0;
          for (const setName of selectedNames) {
            const installed = installedSets.find((s) => s.name === setName);
            if (!installed) continue;

            for (const [agentId, versions] of versionSelections) {
              for (const version of versions) {
                const versionHome = getVersionHomePath(agentId, version);
                const applyResult = applyPermissionsToVersion(agentId, installed.set, versionHome, !options.replace);
                if (applyResult.success) {
                  console.log(chalk.green(`  Applied ${setName} to ${agentLabel(agentId)}@${version}`));
                  recordVersionResources(agentId, version, 'permissions', [setName]);
                  applied++;
                } else {
                  console.log(chalk.red(`  Failed: ${agentLabel(agentId)}@${version}: ${applyResult.error}`));
                }
              }
            }
          }

          console.log(chalk.green(`\nApplied permissions to ${applied} version(s).`));
          return;
        }

        const spinner = ora('Fetching permissions...').start();

        const isGitRepo = source.startsWith('gh:') || source.startsWith('git:') ||
                          source.startsWith('ssh:') || source.startsWith('https://') ||
                          source.startsWith('http://');

        let localPath: string;

        if (isGitRepo) {
          const result = await cloneRepo(source);
          localPath = result.localPath;
          spinner.succeed('Repository cloned');
        } else {
          localPath = source.startsWith('~')
            ? path.join(os.homedir(), source.slice(1))
            : path.resolve(source);

          if (!fs.existsSync(localPath)) {
            spinner.fail(`Path not found: ${localPath}`);
            return;
          }
          spinner.succeed('Using local path');
        }

        // Is this a harness config agents-cli can read? It hardcoded `.json`/`.jsonc`/`.toml` plus
        // `.claude`/`.opencode`/`.codex` substrings, excluding ten other harnesses (hermes' config
        // is YAML). The registry already matches each harness's declared path (RUSH-2676).
        const isAgentConfig = detectPermissionAgentFromPath(localPath) !== null;

        if (isAgentConfig) {
          const incoming = exportPermissionsFromPath(localPath);

          if (!incoming || (incoming.allow.length === 0 && (!incoming.deny || incoming.deny.length === 0))) {
            console.log(chalk.yellow(`\nNo permissions found in ${localPath}`));
            return;
          }

          const existing = getDefaultPermissionSet();

          const diff = computePermissionsDiff(existing, incoming);
          const totalNew = diff.allow.added.length + diff.deny.added.length;
          const totalExisting = diff.allow.existing.length + diff.deny.existing.length;

          if (totalNew === 0) {
            console.log(chalk.gray('\nAll permissions already exist in central storage.'));
            return;
          }

          console.log(chalk.bold('\nPermissions to add:\n'));

          if (diff.allow.added.length > 0) {
            console.log(chalk.green('  New allow rules:'));
            for (const rule of diff.allow.added.slice(0, 20)) {
              console.log(chalk.green(`    + ${rule}`));
            }
            if (diff.allow.added.length > 20) {
              console.log(chalk.green(`    ... and ${diff.allow.added.length - 20} more`));
            }
          }

          if (diff.deny.added.length > 0) {
            console.log(chalk.red('\n  New deny rules:'));
            for (const rule of diff.deny.added) {
              console.log(chalk.red(`    + ${rule}`));
            }
          }

          if (totalExisting > 0) {
            console.log(chalk.gray(`\n  (${totalExisting} rules already exist, will be skipped)`));
          }

          console.log();

          if (!skipPrompts) {
            const proceed = await confirm({
              message: `Add ${totalNew} new permission rule${totalNew === 1 ? '' : 's'}?`,
              default: true,
            });
            if (!proceed) {
              console.log(chalk.gray('Cancelled.'));
              return;
            }
          }

          const merged = mergePermissionSets(existing, incoming);
          const result = saveDefaultPermissionSet(merged);

          if (!result.success) {
            console.log(chalk.red(`Failed to save: ${result.error}`));
            return;
          }

          console.log(chalk.green(`Added ${totalNew} permission${totalNew === 1 ? '' : 's'} to ~/.agents/permissions/default.yml`));

          let selectedAgents: AgentId[];
          let versionSelections: Map<AgentId, string[]>;

          if (options.agents) {
            const result = await resolveAgentTargetsAutoInstalling(options.agents, capableAgents('allowlist'), {
              yes: options.yes,
              allVersions: options.all,
            });
            if (!result) {
              console.log(chalk.gray('Cancelled.'));
              return;
            }
            selectedAgents = result.selectedAgents;
            versionSelections = result.versionSelections;
          } else if (options.all) {
            selectedAgents = [...capableAgents('allowlist')];
            versionSelections = new Map();
            for (const agentId of selectedAgents) {
              const versions = listInstalledVersions(agentId);
              if (versions.length > 0) {
                versionSelections.set(agentId, [...versions]);
              }
            }
          } else if (!skipPrompts) {
            const applyNow = await confirm({
              message: 'Apply permissions to agent versions now?',
              default: true,
            });

            if (applyNow) {
              const result = await promptAgentVersionSelection(
                capableAgents('allowlist'),
                { skipPrompts: false }
              );
              selectedAgents = result.selectedAgents;
              versionSelections = result.versionSelections;
            } else {
              selectedAgents = [];
              versionSelections = new Map();
            }
          } else {
            selectedAgents = [];
            versionSelections = new Map();
          }

          if (selectedAgents.length > 0) {
            let applied = 0;
            for (const [agentId, versions] of versionSelections) {
              for (const version of versions) {
                const versionHome = getVersionHomePath(agentId, version);
                const applyResult = applyPermissionsToVersion(agentId, merged, versionHome, !options.replace);
                if (applyResult.success) {
                  console.log(chalk.green(`  Applied to ${agentLabel(agentId)}@${version}`));
                  recordVersionResources(agentId, version, 'permissions', [merged.name || 'default']);
                  applied++;
                } else {
                  console.log(chalk.red(`  Failed: ${agentLabel(agentId)}@${version}: ${applyResult.error}`));
                }
              }
            }
            console.log(chalk.gray(`\nApplied permissions to ${applied} version(s).`));
          }
        } else {
          let permissions: ReturnType<typeof discoverPermissionsFromRepo>;

          if (localPath.endsWith('.yml') || localPath.endsWith('.yaml')) {
            const { parsePermissionSet } = await import('../lib/permissions.js');
            const set = parsePermissionSet(localPath);
            if (set) {
              permissions = [{ name: set.name, path: localPath, set }];
            } else {
              console.log(chalk.red('Invalid permission file'));
              return;
            }
          } else {
            permissions = discoverPermissionsFromRepo(localPath);
          }

          if (permissions.length === 0) {
            console.log(chalk.yellow('\nNo permission sets found'));
            return;
          }

          console.log(chalk.bold(`\nFound ${permissions.length} permission set(s):`));
          for (const perm of permissions) {
            const desc = perm.set.description ? ` - ${perm.set.description}` : '';
            console.log(`  ${chalk.cyan(perm.name)}${desc}`);
            console.log(`    ${chalk.gray(`${perm.set.allow.length} allow, ${perm.set.deny?.length || 0} deny rules`)}`);
          }

          const broadGrants = permissions
            .map((perm) => ({ name: perm.name, grants: containsBroadGrants(perm.set) }))
            .filter((entry): entry is { name: string; grants: { broad: string[]; reason: string } } => entry.grants !== null);

          if (broadGrants.length > 0) {
            console.error(chalk.yellow('\nWARNING: this permission pack contains broad grants that significantly weaken agent sandboxing:'));
            for (const entry of broadGrants) {
              for (const rule of entry.grants.broad) {
                console.error(`  ${entry.name}: ${rule}: ${entry.grants.reason}`);
              }
            }
            if (shouldRefuseBroadPermissions(permissions, options.allowBroadPermissions === true)) {
              console.error(chalk.red('Refusing to install. Re-run with --allow-broad-permissions if you trust this permission pack.'));
              process.exit(1);
            }
          }

          if (!skipPrompts) {
            const proceed = await confirm({
              message: 'Install these permission sets?',
              default: true,
            });
            if (!proceed) {
              console.log(chalk.gray('Cancelled.'));
              return;
            }
          }

          const installSpinner = ora('Installing permission sets...').start();
          let installed = 0;

          for (const perm of permissions) {
            const result = installPermissionSet(perm.path, perm.name);
            if (result.success) {
              installed++;
            } else {
              installSpinner.stop();
              console.log(chalk.red(`  Failed to install ${perm.name}: ${result.error}`));
              installSpinner.start();
            }
          }

          installSpinner.succeed(`Installed ${installed} permission set(s) to ~/.agents/permissions/`);

          let selectedAgents: AgentId[];
          let versionSelections: Map<AgentId, string[]>;

          if (options.agents) {
            const result = await resolveAgentTargetsAutoInstalling(options.agents, capableAgents('allowlist'), {
              yes: options.yes,
              allVersions: options.all,
            });
            if (!result) {
              console.log(chalk.gray('Cancelled.'));
              return;
            }
            selectedAgents = result.selectedAgents;
            versionSelections = result.versionSelections;
          } else if (options.all) {
            selectedAgents = [...capableAgents('allowlist')];
            versionSelections = new Map();
            for (const agentId of selectedAgents) {
              const versions = listInstalledVersions(agentId);
              if (versions.length > 0) {
                versionSelections.set(agentId, [...versions]);
              }
            }
          } else if (!skipPrompts) {
            const applyNow = await confirm({
              message: 'Apply these permissions to agent versions now?',
              default: true,
            });

            if (applyNow) {
              const result = await promptAgentVersionSelection(
                capableAgents('allowlist'),
                { skipPrompts: false }
              );
              selectedAgents = result.selectedAgents;
              versionSelections = result.versionSelections;
            } else {
              selectedAgents = [];
              versionSelections = new Map();
            }
          } else {
            selectedAgents = [];
            versionSelections = new Map();
          }

          if (selectedAgents.length > 0) {
            let applied = 0;
            for (const perm of permissions) {
              for (const [agentId, versions] of versionSelections) {
                for (const version of versions) {
                  const versionHome = getVersionHomePath(agentId, version);
                  const applyResult = applyPermissionsToVersion(agentId, perm.set, versionHome, !options.replace);
                  if (applyResult.success) {
                    console.log(chalk.green(`  Applied ${perm.name} to ${agentLabel(agentId)}@${version}`));
                    recordVersionResources(agentId, version, 'permissions', [perm.name]);
                    applied++;
                  } else {
                    console.log(chalk.red(`  Failed: ${agentLabel(agentId)}@${version}: ${applyResult.error}`));
                  }
                }
              }
            }
            console.log(chalk.gray(`\nApplied permissions to ${applied} version(s).`));
          }
        }
      } catch (err) {
        if (isPromptCancelled(err)) {
          console.log(chalk.gray('\nCancelled.'));
          return;
        }
        console.error(chalk.red(`Error: ${(err as Error).message}`));
      }
    });

  withAliases(permissionsCmd
    .command('remove [name]'), 'remove')
    .description('Delete a permission set from ~/.agents/permissions/ (interactive picker if no name given)')
    .addHelpText('after', `
Examples:
  # Remove a set by name
  agents permissions remove default

  # Interactive picker
  agents permissions remove
`)
    .action(async (name?: string) => {
      let setsToRemove: string[];

      if (name) {
        setsToRemove = [name];
      } else {
        const installedSets = listInstalledPermissions();
        if (installedSets.length === 0) {
          console.log(chalk.yellow('No permission sets installed.'));
          return;
        }

        if (!isInteractiveTerminal()) {
          requireInteractiveSelection('Selecting permission sets to remove', [
            'agents permissions remove default',
          ]);
        }

        try {
          const selected = await checkbox({
            message: 'Select permission sets to remove',
            choices: installedSets.map((perm) => ({
              value: perm.name,
              name: perm.set.description
                ? `${perm.name} - ${perm.set.description}`
                : perm.name,
            })),
          });

          if (selected.length === 0) {
            console.log(chalk.gray('No permission sets selected.'));
            return;
          }

          setsToRemove = selected;
        } catch (err) {
          if (isPromptCancelled(err)) {
            console.log(chalk.gray('Cancelled'));
            return;
          }
          throw err;
        }
      }

      for (const setName of setsToRemove) {
        const result = removePermissionSet(setName);
        if (result.success) {
          console.log(chalk.green(`Removed permission set '${setName}'`));
        } else {
          console.log(chalk.red(result.error));
        }
      }
    });

  withAliases(permissionsCmd
    .command('view [name]'), 'view')
    .description('Read the allow and deny rules for a stored permission set')
    .addHelpText('after', `
Examples:
  # View a specific permission set
  agents permissions view default

  # Interactive picker
  agents permissions view
`)
    .action(async (name?: string) => {
      const installedSets = listInstalledPermissions();
      if (installedSets.length === 0) {
        console.log(chalk.yellow('No permission sets installed'));
        return;
      }

      if (!name) {
        if (!isInteractiveTerminal()) {
          requireInteractiveSelection('Selecting a permission set to view', [
            'agents permissions view default',
          ]);
        }
        try {
          const { select } = await import('@inquirer/prompts');
          name = await select({
            message: 'Select a permission set to view',
            choices: installedSets.map((perm) => ({
              value: perm.name,
              name: perm.set.description
                ? `${perm.name} - ${perm.set.description}`
                : perm.name,
            })),
          });
        } catch (err) {
          if (isPromptCancelled(err)) {
            console.log(chalk.gray('Cancelled'));
            return;
          }
          throw err;
        }
      }

      const perm = installedSets.find((p) => p.name === name);
      if (!perm) {
        console.log(chalk.yellow(`Permission set '${name}' not found`));
        return;
      }

      const lines: string[] = [];
      lines.push(chalk.bold(`\n${perm.name}\n`));
      if (perm.set.description) {
        lines.push(`  ${perm.set.description}`);
      }
      lines.push('');

      if (perm.set.allow.length > 0) {
        lines.push(chalk.green('  Allow rules:'));
        for (const rule of perm.set.allow) {
          lines.push(`    ${chalk.cyan(rule)}`);
        }
      }

      if (perm.set.deny && perm.set.deny.length > 0) {
        lines.push(chalk.red('\n  Deny rules:'));
        for (const rule of perm.set.deny) {
          lines.push(`    ${chalk.yellow(rule)}`);
        }
      }
      lines.push('');

      const output = lines.join('\n');
      printWithPager(output, lines.length);
    });

}
