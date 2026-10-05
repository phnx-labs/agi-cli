
import * as os from 'os';
import { spawnSync } from 'child_process';
import chalk from 'chalk';
import ora from 'ora';
import { confirm } from '@inquirer/prompts';
import type { Command } from 'commander';
import type { AgentId } from '../lib/types.js';
import { AGENTS, agentLabel, resolveAgentName } from '../lib/agents.js';
import {
  installVersion,
  listInstalledVersions,
  resolveAgentVersionTargets,
  resolveInstalledAgentTargets,
  VersionNotInstalledError,
  type InstalledAgentTargetResult,
  type VersionSelectionResult,
} from '../lib/installations/versions.js';
import { resolveListFilter, AgentSpecError } from '../lib/agent-spec/index.js';

export function resolveListFilterOrExit(agent: AgentId, qualifier: string | undefined | null): string | undefined {
  try {
    return resolveListFilter(agent, qualifier);
  } catch (e) {
    if (e instanceof AgentSpecError) {
      console.error(chalk.red(e.message));
      process.exit(1);
    }
    throw e;
  }
}

import { isPromptCancelled, isInteractiveTerminal, parseCommaSeparatedList } from '../lib/format.js';
export { isPromptCancelled, isInteractiveTerminal, parseCommaSeparatedList };

export interface Surface {
  json: boolean;
  assumeYes: boolean;
  quiet: boolean;
  interactive: boolean;
}

export function resolveSurface(cmd: Command): Surface {

  const opts = cmd.optsWithGlobals() as { json?: boolean; yes?: boolean; quiet?: boolean };
  const tty = isInteractiveTerminal();
  const json = opts.json === true;
  return {
    json,
    assumeYes: opts.yes === true || !tty,
    quiet: opts.quiet === true,
    interactive: tty && !json,
  };
}

export function normalizeSingleDeviceOption(value: string | string[] | undefined, commandLabel: string): string | undefined {

  const list = value == null ? [] : Array.isArray(value) ? value : [value];
  const hosts = list.map((v) => String(v).trim()).filter((v) => v.length > 0);
  if (hosts.length === 0) return undefined;
  if (hosts.length > 1) {
    throw new Error(`${commandLabel} targets a single device, but --device named ${hosts.length}: ${hosts.join(', ')}.`);
  }
  return hosts[0];
}

export function requireInteractiveSelection(action: string, alternatives: string[]): never {
  console.error(chalk.red(`${action} requires an interactive terminal.`));
  if (alternatives.length > 0) {
    console.error(chalk.gray('Run one of these non-interactive forms instead:'));
    for (const alternative of alternatives) {
      console.error(chalk.cyan(`  ${alternative}`));
    }
  }
  process.exit(1);
}

export function requireDestructiveArg(opts: {
  argName: string;
  command: string;
  itemNoun: string;
  available: string[];
  emptyHint?: string;
}): never {

  const { argName, command, itemNoun, available, emptyHint } = opts;
  console.error(chalk.red(`Missing required argument: ${argName.toUpperCase()}`));
  console.error('');
  if (available.length === 0) {
    console.error(chalk.gray(emptyHint || `No ${itemNoun}s to choose from.`));
  } else {
    const label = available.length === 1 ? itemNoun : `${itemNoun}s`;
    console.error(chalk.gray(`Available ${label}:`));
    for (const name of available) {
      console.error(`  ${chalk.cyan(name)}`);
    }
    console.error('');
    console.error(chalk.gray(`Re-run with the ${itemNoun} you want:`));
    console.error(chalk.cyan(`  ${command} ${available[0]}`));
  }
  console.error('');
  console.error(
    chalk.gray(`Tip: this is a destructive command, so you have to type the ${itemNoun} name explicitly.`)
  );
  process.exit(2);
}

export function printWithPager(output: string, lineCount: number): void {
  if (!isInteractiveTerminal() || lineCount <= 40) {
    process.stdout.write(output.endsWith('\n') ? output : `${output}\n`);
    return;
  }

  const less = spawnSync('less', ['-R'], {
    input: output,
    stdio: ['pipe', 'inherit', 'inherit'],
  });

  if (less.status !== 0) {
    process.stdout.write(output.endsWith('\n') ? output : `${output}\n`);
  }
}

export interface RemovalTarget {
  agent: string;
  version: string;
  label: string;
}

export async function promptRemovalTargets(
  resourceName: string,
  targets: RemovalTarget[],
  options?: { skipPrompt?: boolean }
): Promise<RemovalTarget[]> {
  if (targets.length === 0) return [];
  if (targets.length === 1 || options?.skipPrompt) return targets;

  if (!isInteractiveTerminal()) {
    return targets;
  }

  const { checkbox } = await import('@inquirer/prompts');

  try {
    const selected = await checkbox({
      message: `Select targets to remove '${resourceName}' from`,
      choices: targets.map((t) => ({
        value: t,
        name: t.label,
        checked: true,
      })),
    });
    return selected;
  } catch (err) {
    if (isPromptCancelled(err)) {
      return [];
    }
    throw err;
  }
}

export function formatPath(fullPath: string, cwd?: string): string {
  const home = os.homedir();
  if (fullPath.startsWith(home)) {
    return '~' + fullPath.slice(home.length);
  }
  const currentDir = cwd || process.cwd();
  if (fullPath.startsWith(currentDir + '/')) {
    return fullPath.slice(currentDir.length + 1);
  }
  return fullPath;
}

function collectMissingVersions(
  value: string,
  availableAgents: readonly AgentId[]
): Array<{ agentId: AgentId; version: string }> {
  const missing: Array<{ agentId: AgentId; version: string }> = [];
  const seen = new Set<string>();

  for (const raw of value.split(',').map((s) => s.trim()).filter(Boolean)) {
    if (raw === 'all' || raw === 'all@all') continue;

    const atIndex = raw.indexOf('@');
    if (atIndex === -1) continue;

    const agentToken = raw.slice(0, atIndex).trim();
    const versionToken = raw.slice(atIndex + 1).trim();

    if (!versionToken || versionToken === 'default' || versionToken === 'all') continue;

    const agentId = resolveAgentName(agentToken);
    if (!agentId || !availableAgents.includes(agentId)) continue;

    const installed = listInstalledVersions(agentId);
    if (installed.includes(versionToken)) continue;

    const key = `${agentId}@${versionToken}`;
    if (seen.has(key)) continue;
    seen.add(key);
    missing.push({ agentId, version: versionToken });
  }

  return missing;
}

async function installMissingVersions(
  missing: ReadonlyArray<{ agentId: AgentId; version: string }>
): Promise<void> {
  for (const { agentId, version } of missing) {
    const label = `${agentLabel(agentId)}@${version}`;
    const spinner = ora(`Installing ${label}...`).start();
    try {
      const result = await installVersion(agentId, version, (msg) => {
        spinner.text = msg;
      });
      if (!result.success) {
        spinner.fail(`Failed to install ${label}: ${result.error ?? 'unknown error'}`);
        process.exit(1);
      }
      spinner.succeed(`Installed ${label}`);
    } catch (err) {
      spinner.fail(`Failed to install ${label}: ${(err as Error).message}`);
      process.exit(1);
    }
  }
}

export async function ensureAgentVersionsInstalled(
  value: string,
  availableAgents: readonly AgentId[],
  options: { yes?: boolean } = {}
): Promise<boolean> {
  const missing = collectMissingVersions(value, availableAgents);
  if (missing.length === 0) return true;

  const summary = missing.map((m) => `${agentLabel(m.agentId)}@${m.version}`).join(', ');

  if (!options.yes) {
    if (!isInteractiveTerminal()) {
      console.error(chalk.red(`Missing agent version(s): ${summary}`));
      console.error(chalk.gray('In a scripted shell, opt in to auto-install:'));
      console.error(chalk.cyan(`  rerun with --yes`));
      console.error(chalk.gray('Or pre-install:'));
      for (const m of missing) {
        console.error(chalk.cyan(`  agents add ${m.agentId}@${m.version}`));
      }
      process.exit(1);
    }

    console.log(chalk.yellow(`\nThe following agent version(s) are not installed:`));
    for (const m of missing) {
      console.log(`  ${chalk.cyan(`${agentLabel(m.agentId)}@${m.version}`)}`);
    }

    let proceed: boolean;
    try {
      proceed = await confirm({
        message: `Install ${missing.length} missing version${missing.length === 1 ? '' : 's'}?`,
        default: true,
      });
    } catch (err) {
      if (isPromptCancelled(err)) return false;
      throw err;
    }
    if (!proceed) return false;
  }

  await installMissingVersions(missing);
  return true;
}

export async function resolveAgentTargetsAutoInstalling(
  value: string,
  availableAgents: readonly AgentId[],
  options: { yes?: boolean; allVersions?: boolean } = {}
): Promise<VersionSelectionResult | null> {
  const ok = await ensureAgentVersionsInstalled(value, availableAgents, options);
  if (!ok) return null;
  return resolveAgentVersionTargets(value, availableAgents, { allVersions: options.allVersions });
}

export async function resolveInstalledAgentTargetsAutoInstalling(
  value: string,
  availableAgents: readonly AgentId[],
  options: { yes?: boolean; allVersions?: boolean } = {}
): Promise<InstalledAgentTargetResult | null> {
  const ok = await ensureAgentVersionsInstalled(value, availableAgents, options);
  if (!ok) return null;
  return resolveInstalledAgentTargets(value, availableAgents, { allVersions: options.allVersions });
}

export { VersionNotInstalledError } from '../lib/installations/versions.js';
