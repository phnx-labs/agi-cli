/**
 * Shared utilities for command implementations.
 *
 * Small helpers used across multiple commands: prompt cancellation detection,
 * table formatting, spinner management, and platform-specific workarounds.
 */

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

/**
 * Resolve a read/list command's `@version` filter through the agent-spec engine,
 * exiting cleanly on a bad spec. Drop-in for the old
 * `resolveVersionAlias(agent, parts[1])`:
 *   undefined → show all · @default/@pinned → the default version ·
 *   @latest/@oldest/@x.y.z → concrete.
 */
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

// Defined in lib/format.ts so `lib/` callers don't have to import upward into
// the command layer; re-exported here for the ~50 command-layer consumers.
import { isPromptCancelled, isInteractiveTerminal, parseCommaSeparatedList } from '../lib/format.js';
export { isPromptCancelled, isInteractiveTerminal, parseCommaSeparatedList };

/** The resolved I/O surface for one command invocation — the human/agent split. */
export interface Surface {
  /** Machine-readable output was requested (`--json`). */
  json: boolean;
  /** Skip confirmation prompts — explicit `--yes`/`-y`, or a non-interactive shell. */
  assumeYes: boolean;
  /** Suppress non-essential human chrome (`--quiet`). */
  quiet: boolean;
  /**
   * Safe to show an interactive picker/prompt: a real terminal AND not asking for
   * `--json` (a JSON consumer is a machine and never wants a picker).
   */
  interactive: boolean;
}

/**
 * Compute a command's I/O surface once, in one place, instead of each command
 * re-deriving the human-vs-agent split (and raw-sniffing `process.std*.isTTY`
 * with inconsistent stream choices — the audit's R4). Reads the merged option
 * set via `optsWithGlobals()`, so it sees the command's own flags and any
 * inherited global ones, and folds in the terminal state:
 *
 *   - `assumeYes` = explicit `--yes` OR a non-interactive shell (no one to prompt).
 *   - `interactive` = a real TTY AND not `--json`.
 *
 * Adopt incrementally: a command switches its ad-hoc `isTTY`/`options.yes` checks
 * to a single `const s = resolveSurface(cmd)` without changing its flag surface.
 */
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

/**
 * Coerce a `--device` value that may arrive as a scalar or an array to a single
 * host string. A subcommand whose own `--device` collides in name with an
 * ancestor's variadic `-D, --device <target...>` (e.g. `sessions inject`,
 * `sessions resume` under the parent `sessions` command) can receive an array
 * even when the command only ever targets one device — fail loud on more than
 * one rather than guessing the first (PHNX-3688, PHNX-3940).
 */
export function normalizeSingleDeviceOption(value: string | string[] | undefined, commandLabel: string): string | undefined {
  const list = value == null ? [] : Array.isArray(value) ? value : [value];
  const hosts = list.map((v) => String(v).trim()).filter((v) => v.length > 0);
  if (hosts.length === 0) return undefined;
  if (hosts.length > 1) {
    throw new Error(`${commandLabel} targets a single device, but --device named ${hosts.length}: ${hosts.join(', ')}.`);
  }
  return hosts[0];
}

/**
 * Exit with a clean message when a picker would be required in a non-interactive shell.
 */
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

/**
 * Print a properly-cased "missing argument" error for destructive commands and
 * exit. Destructive commands (remove, disband, disable) deliberately do NOT
 * fall back to an interactive picker — typing the name is the safety check.
 *
 * Lists available items so the user can copy-paste, but never auto-selects.
 */
export function requireDestructiveArg(opts: {
  argName: string;       // e.g. 'team', 'name', 'agent'
  command: string;       // e.g. 'agents teams disband'
  itemNoun: string;      // e.g. 'team', 'plugin' — used for grammar
  available: string[];   // names to list
  emptyHint?: string;    // shown when no items exist
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

/**
 * Print long content directly in non-interactive shells, use a pager only for real terminals.
 */
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

/**
 * A target for resource removal: agent + version.
 */
export interface RemovalTarget {
  agent: string;
  version: string;
  label: string;
}

/**
 * Prompt user to select which agent/version targets to remove a resource from.
 * If only one target, returns it without prompting. If multiple, shows checkbox.
 * Returns empty array if user cancels or selects nothing.
 */
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

/**
 * Format a path for display, using ~ for home directory
 */
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

/**
 * Parse a --agents selector and collect every (agentId, specificVersion) pair
 * the user requested where the version is a concrete x.y.z (not `default`,
 * not `all`, not `latest`) and is NOT currently installed.
 *
 * This is the lookahead the auto-install wrappers use to decide whether to
 * prompt + install before delegating to resolveAgentVersionTargets.
 */
function collectMissingVersions(
  value: string,
  availableAgents: readonly AgentId[]
): Array<{ agentId: AgentId; version: string }> {
  const missing: Array<{ agentId: AgentId; version: string }> = [];
  const seen = new Set<string>();

  for (const raw of value.split(',').map((s) => s.trim()).filter(Boolean)) {
    // Literal `all` / `all@all` expand to per-agent — never missing.
    if (raw === 'all' || raw === 'all@all') continue;

    const atIndex = raw.indexOf('@');
    if (atIndex === -1) continue; // bare agent → resolves to default; never missing in this sense

    const agentToken = raw.slice(0, atIndex).trim();
    const versionToken = raw.slice(atIndex + 1).trim();

    // Non-specific selectors handled by the underlying resolver.
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

/**
 * Sequentially install every requested missing version with a per-version
 * spinner. Aborts via process.exit(1) on the first failure — the user
 * already approved the install so a partial-install outcome is worse than
 * a hard stop.
 */
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

/**
 * Make sure every specific `agent@x.y.z` the user typed is installed before
 * the caller resolves targets. Returns true if the caller should continue,
 * false if the user declined the prompt. Exported so non-standard caller
 * shapes (e.g. mcp.ts's manifest-shaped parser) can run the pre-flight
 * without going through resolveAgentVersionTargets first.
 */
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

/**
 * Resolve a `--agents` selector and, if any requested `agent@version` isn't
 * installed yet, prompt to install it (or auto-install with --yes) before
 * delegating to resolveAgentVersionTargets. Returns null when the user
 * declines the install prompt — callers should treat that as a clean cancel.
 */
export async function resolveAgentTargetsAutoInstalling(
  value: string,
  availableAgents: readonly AgentId[],
  options: { yes?: boolean; allVersions?: boolean } = {}
): Promise<VersionSelectionResult | null> {
  const ok = await ensureAgentVersionsInstalled(value, availableAgents, options);
  if (!ok) return null;
  return resolveAgentVersionTargets(value, availableAgents, { allVersions: options.allVersions });
}

/**
 * Same as resolveAgentTargetsAutoInstalling but returns the broader
 * InstalledAgentTargetResult that includes `directAgents` (for paths like
 * `agents install` and `sync --mcp` that fall through to unmanaged homes
 * when no managed version is installed).
 */
export async function resolveInstalledAgentTargetsAutoInstalling(
  value: string,
  availableAgents: readonly AgentId[],
  options: { yes?: boolean; allVersions?: boolean } = {}
): Promise<InstalledAgentTargetResult | null> {
  const ok = await ensureAgentVersionsInstalled(value, availableAgents, options);
  if (!ok) return null;
  return resolveInstalledAgentTargets(value, availableAgents, { allVersions: options.allVersions });
}

// Re-export so callers can `catch (err) { if (err instanceof VersionNotInstalledError) … }`
// without reaching into ../lib/versions directly.
export { VersionNotInstalledError } from '../lib/installations/versions.js';
