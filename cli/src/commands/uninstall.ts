import type { Command } from 'commander';
import chalk from 'chalk';
import { confirm } from '@inquirer/prompts';

import { setHelpSections } from '../lib/help.js';
import { planUninstall, executeUninstall, type UninstallPlan, type UninstallResult } from '../lib/uninstall.js';
import { isInteractiveTerminal, isPromptCancelled } from './utils.js';

interface UninstallOptions {
  purge?: boolean;
  dryRun?: boolean;
  yes?: boolean;
}

function printPlan(plan: UninstallPlan, purge: boolean): void {
  const restores = plan.configs.filter((c) => c.kind === 'restore-backup' || c.kind === 'restore-version-home');
  const dangling = plan.configs.filter((c) => c.kind === 'remove-dangling');
  const untouched = plan.configs.filter((c) => c.kind === 'leave-real' || c.kind === 'leave-foreign');

  console.log(chalk.bold('\nagents uninstall — planned changes\n'));

  if (restores.length > 0) {
    console.log(chalk.green('Restore your original config (adopted by agents-cli):'));
    for (const c of restores) {
      const how = c.kind === 'restore-backup' ? 'from backup' : 'from version home';
      console.log(chalk.gray(`  ${c.realPath}  ${chalk.dim(`(${how})`)}`));
    }
  }
  if (dangling.length > 0) {
    console.log(chalk.yellow('Remove dangling symlink (no original found to restore):'));
    for (const c of dangling) console.log(chalk.gray(`  ${c.realPath}`));
  }
  if (untouched.length > 0) {
    console.log(chalk.cyan('Left untouched (real, un-adopted configs — never modified):'));
    for (const c of untouched) console.log(chalk.gray(`  ${c.realPath}`));
  }
  if (plan.homeFiles.length > 0) {
    console.log(chalk.green('Restore home files:'));
    for (const hf of plan.homeFiles) console.log(chalk.gray(`  ${hf.realPath}`));
  }
  if (plan.launchers.length > 0) {
    console.log(chalk.green('Release adopted launchers (restore native binaries on PATH):'));
    console.log(chalk.gray(`  ${plan.launchers.join(', ')}`));
  }
  if (plan.rcFiles.length > 0) {
    console.log(chalk.green('Remove the shim directory from PATH in:'));
    for (const rc of plan.rcFiles) console.log(chalk.gray(`  ${rc}`));
  }

  console.log(chalk.bold('\nData:'));
  if (purge) {
    console.log(chalk.red(`  Permanently delete ${plan.agentsDir} (installed versions, session history, secrets metadata).`));
    if (plan.legacySymlink) console.log(chalk.red(`  Permanently delete ${plan.legacySymlink}.`));
  } else {
    console.log(chalk.gray(`  Move ${plan.agentsDir} aside to ${plan.agentsDir}.removed-<timestamp> (recoverable).`));
    if (plan.legacySymlink) console.log(chalk.gray(`  Remove the legacy symlink ${plan.legacySymlink}.`));
    console.log(chalk.gray('  Use --purge to hard-delete instead.'));
  }
  console.log();
}

function printResult(result: UninstallResult, cleanedPath: boolean): void {
  for (const r of result.restoredConfigs) console.log(chalk.green(`Restored ${r.realPath}`));
  for (const r of result.removedDanglingConfigs) console.log(chalk.yellow(`Removed dangling symlink ${r.realPath}`));
  for (const f of result.restoredHomeFiles) console.log(chalk.green(`Restored ${f}`));
  if (result.releasedLaunchers.length > 0) console.log(chalk.green(`Released launchers: ${result.releasedLaunchers.join(', ')}`));
  for (const rc of result.cleanedRcFiles) console.log(chalk.green(`Cleaned shim PATH entry from ${rc}`));

  if (result.agentsDir.disposition === 'moved') {
    console.log(chalk.gray(`Moved ${result.agentsDir.path} to ${result.agentsDir.movedTo}`));
  } else if (result.agentsDir.disposition === 'purged') {
    console.log(chalk.gray(`Deleted ${result.agentsDir.path}`));
  }

  for (const e of result.errors) console.log(chalk.red(`  ! ${e}`));

  if (result.purgeDowngraded) {
    console.log(
      chalk.yellow(
        `\n--purge was downgraded to move-aside because a restore step errored — ${result.agentsDir.path} was kept so nothing is lost. Resolve the errors above, then delete ${result.agentsDir.movedTo} manually.`,
      ),
    );
  }

  console.log(chalk.bold('\nFinish by removing the CLI package:'));
  console.log(chalk.gray('  npm uninstall -g @phnx-labs/agents-cli    # or: bun remove -g @phnx-labs/agents-cli'));
  if (cleanedPath) {
    console.log(chalk.gray('Open a new shell (or re-source your rc file) so the removed PATH entry takes effect.'));
  }
  if (result.agentsDir.disposition === 'moved') {
    console.log(chalk.gray(`Your data is still at ${result.agentsDir.movedTo} — delete it once you are sure.`));
  }
}

export function registerUninstallCommands(program: Command): void {
  const cmd = program
    .command('uninstall')
    .description('Completely remove agents-cli and restore your original agent configs. Reverses `agents setup`.')
    .option('--purge', 'Hard-delete ~/.agents (installed versions, sessions, secrets metadata) instead of moving it aside')
    .option('--dry-run', 'Show exactly what would change without modifying anything')
    .option('-y, --yes', 'Skip the confirmation prompt (required to run non-interactively)');

  setHelpSections(cmd, {
    examples: `
      # Preview everything that would change, without touching anything
      agents uninstall --dry-run

      # Restore your configs and move ~/.agents aside (recoverable)
      agents uninstall

      # Same, but hard-delete ~/.agents (no recovery)
      agents uninstall --purge
    `,
    notes: `
      - Restores every ~/.<agent> that agents-cli adopted; a real config it never adopted is left untouched.
      - Releases adopted launchers and strips the shim directory from your shell PATH.
      - Without --purge, ~/.agents is moved to ~/.agents.removed-<timestamp> so nothing is lost.
      - The CLI cannot delete its own running binary; it prints the final 'npm uninstall -g' step for you.
    `,
  });

  cmd.action(async (options: UninstallOptions) => {
    // Disable the memoized sink before moving ~/.agents or a late emit recreates it.
    process.env.AGENTS_DISABLE_EVENT_LOG = '1';

    const plan = planUninstall();

    if (!plan.isInstalled) {
      console.log(chalk.gray('agents-cli is not set up (no ~/.agents directory) — nothing to uninstall.'));
      return;
    }

    printPlan(plan, !!options.purge);

    if (options.dryRun) {
      console.log(chalk.gray('Dry run — nothing was changed.'));
      return;
    }

    if (!options.yes) {
      if (!isInteractiveTerminal()) {
        console.log(chalk.red('Refusing to uninstall non-interactively. Re-run with --yes to confirm.'));
        return;
      }
      try {
        const ok = await confirm({
          message: options.purge
            ? 'Permanently remove agents-cli and restore your original configs?'
            : 'Remove agents-cli (data moved to a recoverable directory) and restore your original configs?',
          default: false,
        });
        if (!ok) {
          console.log(chalk.gray('Cancelled.'));
          return;
        }
      } catch (err) {
        if (isPromptCancelled(err)) {
          console.log(chalk.gray('Cancelled.'));
          return;
        }
        throw err;
      }
    }

    const result = executeUninstall(plan, { purge: options.purge, timestamp: Date.now() });
    printResult(result, result.cleanedRcFiles.length > 0);
  });
}
