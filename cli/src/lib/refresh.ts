
import * as fs from 'fs';
import * as path from 'path';
import chalk from 'chalk';
import ora from 'ora';
import { select, confirm } from '@inquirer/prompts';
import { capableAgents } from './capabilities.js';
import {
  AGENTS,
  ALL_AGENT_IDS,
  MANAGED_AGENT_IDS,
  getAllCliStates,
  registerMcpToTargets,
  agentLabel,
} from './agents.js';
import { readManifest, MANIFEST_FILENAME } from './manifest.js';
import { getUserAgentsDir } from './state.js';
import type { AgentId } from './types.js';
import {
  installVersion,
  listInstalledVersions,
  isVersionIsolated,
  getGlobalDefault,
  setGlobalDefault,
  getVersionHomePath,
  syncResourcesToVersion,
  getAvailableResources,
  getActuallySyncedResources,
  getNewResources,
  getProjectOnlyResources,
  hasNewResources,
  promptNewResourceSelection,
  promptResourceSelection,
  resolveConfiguredAgentTargets,
  type ResourceSelection,
} from './installations/versions.js';
import {
  listCliStatus,
  installCli,
  describeMethod,
  describeCheck,
  selectInstallMethod,
} from './cli-resources.js';
import {
  ensureShimCurrent,
  ensureGhOverloadShim,
  isShimsInPath,
  addShimsToPath,
  getPathSetupInstructions,
  switchConfigSymlink,
  switchHomeFileSymlinks,
} from './installations/shims.js';
import { parseHookManifest, registerHooksToSettings } from './hooks/install.js';
import { isPromptCancelled } from './format.js';

interface RefreshOptions {
  agentFilter?: AgentId;
  skipPrompts?: boolean;
  skipClis?: boolean;
  quiet?: boolean;
  selection?: ResourceSelection;
  allowExecSurfaces?: boolean;
}

function migratePromptcutsToRoot(agentsDir: string, quiet = false): void {
  const rootPath = path.join(agentsDir, 'promptcuts.yaml');
  if (fs.existsSync(rootPath)) return;

  const agentDirs = ['claude', 'codex', 'cursor', 'opencode'];
  for (const dir of agentDirs) {
    const legacyPath = path.join(agentsDir, dir, 'promptcuts.yaml');
    if (fs.existsSync(legacyPath)) {
      try {
        fs.renameSync(legacyPath, rootPath);
        if (!quiet) console.log(chalk.gray(`Moved ${dir}/promptcuts.yaml → promptcuts.yaml (repo root)`));
        return;
      } catch {
      }
    }
  }
}

interface RefreshResult {
  declined: string[];
  reconciled: Array<{ agent: AgentId; version: string }>;
}

export async function refresh(options: RefreshOptions = {}): Promise<RefreshResult> {
  // Refresh materializes declared state only; repository pulls belong to sync orchestration.
  const {
    agentFilter,
    skipPrompts = false,
    skipClis = false,
    quiet = false,
    selection: requestedSelection,
    allowExecSurfaces = false,
  } = options;
  const agentsDir = getUserAgentsDir();
  // quiet gates every progress line so JSON and fleet stdout remain one object.
  const log = (...args: unknown[]) => { if (!quiet) console.log(...args); };
  const declined: string[] = [];
  const reconciled: Array<{ agent: AgentId; version: string }> = [];

  if (!requestedSelection) migratePromptcutsToRoot(agentsDir, quiet);

  const manifest = readManifest(agentsDir);
  if (!manifest) {
    log(chalk.gray(`No ${MANIFEST_FILENAME} found`));
  }

  if (!skipClis && manifest?.agents) {
    log(chalk.bold('\nCLI Versions:\n'));

    const cliAgents = Object.keys(manifest.agents) as AgentId[];
    for (const agentId of cliAgents) {
      if (agentFilter && agentId !== agentFilter) continue;
      const agent = AGENTS[agentId];
      if (!agent) continue;

      const cliSpinner = ora(`Checking ${agentLabel(agent.id)}...`).start();
      const versions = listInstalledVersions(agentId);
      const targetVersion = manifest.agents[agentId] || 'latest';

      const result = await installVersion(agentId, targetVersion, (msg) => { cliSpinner.text = msg; });
      if (result.success) {
        const isNew = versions.length === 0;
        if (isNew) {
          cliSpinner.succeed(`Installed ${agentLabel(agent.id)}@${result.installedVersion}`);
        } else {
          cliSpinner.succeed(`${agentLabel(agent.id)}@${result.installedVersion}`);
        }
        ensureShimCurrent(agentId);
      } else {
        cliSpinner.warn(`${agentLabel(agent.id)}: ${result.error}`);
      }
    }
  }

  if ((!requestedSelection || requestedSelection.mcp) && manifest?.mcp && Object.keys(manifest.mcp).length > 0) {
    log(chalk.bold('\nMCP Servers:\n'));

    for (const [name, config] of Object.entries(manifest.mcp)) {
      if (Array.isArray(requestedSelection?.mcp) && !requestedSelection.mcp.includes(name)) continue;
      const transport = config.transport || 'stdio';
      const commandOrUrl = transport === 'http' ? config.url : config.command;
      if (!commandOrUrl) {
        log(`  ${chalk.cyan(name)}: ${chalk.yellow(`missing ${transport === 'http' ? 'url' : 'command'}`)}`);
        continue;
      }

      const scopedAgents = (config.agents ? [...config.agents] : [...capableAgents('mcp')]).filter(
        (id) => !agentFilter || id === agentFilter
      );
      const scopedVersions = config.agentVersions
        ? Object.fromEntries(
            Object.entries(config.agentVersions).filter(([agentId]) => !agentFilter || agentId === agentFilter)
          ) as Partial<Record<AgentId, string[]>>
        : undefined;
      const targets = resolveConfiguredAgentTargets(
        scopedAgents,
        scopedVersions,
        capableAgents('mcp')
      );
      const results = await registerMcpToTargets(
        targets,
        name,
        commandOrUrl,
        config.scope || 'user',
        transport
      );

      for (const result of results) {
        if (result.success) {
          const label = result.version
            ? `${agentLabel(result.agentId)}@${result.version}`
            : agentLabel(result.agentId);
          log(`  ${chalk.green('+')} ${name} -> ${label}`);
        }
      }
    }
  }

  const cliStates = await getAllCliStates();
  const agentsToSync = agentFilter ? [agentFilter] : MANAGED_AGENT_IDS;
  const available = getAvailableResources();

  for (const agentId of agentsToSync) {
    const installedVersions = listInstalledVersions(agentId);
    if (!cliStates[agentId]?.installed && installedVersions.length === 0) continue;
    const defaultVer = getGlobalDefault(agentId);
    if (!defaultVer && !requestedSelection) continue;

    // Explicit or unattended reconciliation targets every installed version; interactive full refresh targets the default.
    const versionsToSync = requestedSelection || skipPrompts
      ? installedVersions
      : [defaultVer!];
    if (versionsToSync.length === 0) continue;

    let actuallySynced: ReturnType<typeof getActuallySyncedResources> | undefined;
    let newResources: ReturnType<typeof getNewResources> | undefined;
    let hasAnySynced = false;
    // Skip the installed-content scan when unattended force-full sync makes it irrelevant.
    if (!skipPrompts && !requestedSelection) {
      actuallySynced = getActuallySyncedResources(agentId, defaultVer!);
      newResources = getNewResources(available, actuallySynced, getProjectOnlyResources());
      hasAnySynced = actuallySynced.commands.length > 0 ||
        actuallySynced.skills.length > 0 ||
        actuallySynced.hooks.length > 0 ||
        actuallySynced.memory.length > 0 ||
        actuallySynced.mcp.length > 0 ||
        actuallySynced.permissions.length > 0 ||
        actuallySynced.plugins.length > 0;
    }

    try {
      let selection: ResourceSelection | undefined;
      let forceFullSync = false;

      if (requestedSelection) {
        selection = requestedSelection;
      } else if (skipPrompts) {
        forceFullSync = true;
      } else if (!hasAnySynced) {
        log(chalk.yellow(`\n${agentLabel(agentId)}@${defaultVer!} has no synced resources.`));
        const userSelection = await promptResourceSelection(agentId);
        if (userSelection) selection = userSelection;
      } else if (newResources && hasNewResources(newResources, agentId, defaultVer!)) {
        log(chalk.cyan(`\n${agentLabel(agentId)}@${defaultVer}:`));
        const userSelection = await promptNewResourceSelection(agentId, newResources, defaultVer!);
        if (userSelection) selection = userSelection;
      } else {
        forceFullSync = true;
      }

      if (forceFullSync || (selection && Object.keys(selection).length > 0)) {
        const kinds = new Set<string>();
        for (const ver of versionsToSync) {
          const syncResult = syncResourcesToVersion(
            agentId,
            ver,
            selection,
            {
              available,
              allowExecSurfaces,
              ...(forceFullSync || requestedSelection ? { force: true as const } : {}),
            },
          );
          reconciled.push({ agent: agentId, version: ver });
          if (syncResult.commands) kinds.add('commands');
          if (syncResult.skills) kinds.add('skills');
          if (syncResult.hooks) kinds.add('hooks');
          if (syncResult.memory.length > 0) kinds.add('memory');
          if (syncResult.permissions) kinds.add('permissions');
          if (syncResult.mcp.length > 0) kinds.add('mcp');
          if (syncResult.plugins.length > 0) kinds.add('plugins');
          for (const reason of syncResult.declined) {
            declined.push(`${agentLabel(agentId)}@${ver}: ${reason}`);
          }
        }

        if (kinds.size > 0) {
          const verNote = versionsToSync.length > 1
            ? chalk.gray(` (${versionsToSync.length} versions)`)
            : '';
          log(chalk.green(`  Synced: ${[...kinds].join(', ')}`) + verNote);
        }
      }
    } catch (err) {
      if (isPromptCancelled(err)) {
        log(chalk.gray('Skipped resource selection'));
      } else {
        throw err;
      }
    }
  }

  const hookManifest = requestedSelection ? {} : parseHookManifest();
  if (Object.keys(hookManifest).length > 0) {
    let hookRegistered = 0;
    const hookAgents = new Set(capableAgents('hooks') as readonly AgentId[]);
    for (const agentId of agentsToSync) {
      if (!hookAgents.has(agentId)) continue;
      const versions = listInstalledVersions(agentId);
      const defaultVer = getGlobalDefault(agentId);
      const targetVersions = skipPrompts
        ? versions
        : (defaultVer ? [defaultVer] : versions.slice(-1));

      for (const ver of targetVersions) {
        const home = getVersionHomePath(agentId, ver);
        const result = registerHooksToSettings(agentId, home, hookManifest);
        hookRegistered += result.registered.length;
        for (const error of result.errors) {
          log(chalk.yellow(`  Hook warning: ${error}`));
        }
      }
    }
    if (hookRegistered > 0) {
      log(chalk.green(`\nRegistered ${hookRegistered} hook lifecycle event(s)`));
    }
  }

  if (!requestedSelection) {
    try {
      ensureGhOverloadShim();
    } catch {
    }
    if (!isShimsInPath()) {
      const pathResult = addShimsToPath();
      if (pathResult.success && !pathResult.alreadyPresent) {
        log(chalk.green(`\nAdded shims to ${pathResult.location}`));
        log(chalk.gray(pathResult.reloadHint));
      } else if (!pathResult.success) {
        log(chalk.yellow('\nCould not auto-add shims to PATH:'));
        log(chalk.gray(getPathSetupInstructions()));
      }
    }
  }

  if (!skipPrompts && !requestedSelection) {
    const agentsNeedingDefault: AgentId[] = [];
    for (const agentId of agentsToSync) {
      const versions = listInstalledVersions(agentId);
      if (versions.length > 0 && !getGlobalDefault(agentId)) {
        agentsNeedingDefault.push(agentId);
      }
    }

    const selectedVersions: Array<{ agentId: AgentId; version: string }> = [];

    for (const agentId of agentsNeedingDefault) {
      const versions = listInstalledVersions(agentId).filter((v) => !isVersionIsolated(agentId, v));
      if (versions.length === 0) continue;
      const agent = AGENTS[agentId];

      const shouldSwitch = await select({
        message: `${agentLabel(agent.id)} has no default version. Set one now?`,
        choices: [
          { name: 'Yes, pick a version', value: 'pick' },
          { name: 'Skip for now', value: 'skip' },
        ],
      });

      if (shouldSwitch === 'pick') {
        const selectedVersion = await select({
          message: `Select ${agentLabel(agent.id)} version:`,
          choices: versions.map((v) => ({ name: v, value: v })),
        });

        selectedVersions.push({ agentId, version: selectedVersion });
      }
    }

    for (const { agentId, version } of selectedVersions) {
      const agent = AGENTS[agentId];
      setGlobalDefault(agentId, version);
      const symlinkResult = await switchConfigSymlink(agentId, version);
      if (!symlinkResult.success) {
        log(chalk.yellow(`Warning: ${symlinkResult.error}`));
      } else if (symlinkResult.backupPath) {
        log(chalk.gray(`Backed up existing config to: ${symlinkResult.backupPath}`));
      }
      switchHomeFileSymlinks(agentId, version);
      log(chalk.green(`Set ${agentLabel(agent.id)}@${version} as default`));
    }
  }

  if (!requestedSelection) {
    try {
      const { statuses, errors } = listCliStatus(process.cwd());
      for (const err of errors) {
        log(chalk.yellow(`  CLI manifest parse error: ${err.file}: ${err.reason}`));
      }
      const missing = statuses.filter((s) => !s.installed);
      if (missing.length > 0) {
        log(chalk.bold('\nDeclared CLIs missing from this host:'));
        for (const s of missing) {
          const method = selectInstallMethod(s.manifest);
          const action = method ? describeMethod(method) : chalk.red('no compatible install method');
          log(`  ${chalk.cyan(s.manifest.name.padEnd(20))} ${chalk.gray(action)}`);
        }
        log('');

        if (!skipPrompts) {
          const proceed = await confirm({ message: `Install ${missing.length} missing CLI(s) now?`, default: true });
          if (proceed) {
            for (const s of missing) {
              log(chalk.bold(`\n→ ${s.manifest.name}`));
              const result = installCli(s.manifest);
              if (result.error) {
                log(chalk.red(`  ${result.error}`));
                continue;
              }
              if (result.installed) {
                log(chalk.green(`  installed`));
                if (s.manifest.postInstall) {
                  log(chalk.gray(s.manifest.postInstall.trim().split('\n').map((l) => '  ' + l).join('\n')));
                }
              } else {
                log(chalk.yellow(`  install ran but \`${describeCheck(s.manifest.check)}\` still fails`));
              }
            }
          } else {
            log(chalk.gray(`Skipped. Run 'agents cli install' later.`));
          }
        } else {
          log(chalk.gray(`Run 'agents cli install' to install them.`));
        }
      }
    } catch (err) {
      if (!isPromptCancelled(err)) {
        log(chalk.yellow(`CLI install skipped: ${(err as Error).message}`));
      }
    }
  }

  if (declined.length > 0) {
    log(chalk.yellow('Not written:'));
    for (const reason of declined) log(`  ${chalk.yellow(reason)}`);
  }

  return { declined, reconciled };
}
