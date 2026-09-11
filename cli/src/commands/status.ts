/**
 * `agents sync status` — the unified sync-status surface.
 *
 * Nested under `sync` because this is sync drift, not a separate noun (RUSH-2864).
 * One command that answers "is my fleet in sync?" the same way every other
 * surface does, because it reads the same engine (computeSyncStatus). Human mode
 * renders the summary and, when a TTY finds drift, offers the interactive
 * "sync now?" flow (promptDriftSync). `--json` emits the stable UnifiedSyncStatus
 * contract the menu-bar and Agency consume. `--yes` reconciles everything with no
 * prompts (the "kick it" path, safe in scripts).
 */

import { Command } from 'commander';
import chalk from 'chalk';
import { AGENTS } from '../lib/agents.js';
import { AgentId } from '../lib/types.js';
import { setHelpSections } from '../lib/help.js';
import { addHostOption } from '../lib/hosts/option.js';
import { computeSyncStatus, type AgentVersionStatus, formatDriftRows } from '../lib/sync-status.js';
import { promptDriftSync } from '../lib/drift-sync.js';
import { resolveConfiguredModel } from '../lib/models.js';
import { resolveSurface } from './utils.js';

interface StatusOptions {
  json?: boolean;
  yes?: boolean;
  cwd?: string;
}

const agentName = (id: AgentId): string => AGENTS[id]?.name ?? id;

function versionSummary(v: AgentVersionStatus): string {
  if (!v.everSynced) return chalk.gray('never synced');
  if (v.needsSync) {
    const bits: string[] = [];
    if (v.counts.drifted) bits.push(`${v.counts.drifted} drifted`);
    if (v.counts.missing) bits.push(`${v.counts.missing} missing`);
    return chalk.yellow(bits.join(' · '));
  }
  return chalk.green('in sync');
}

/** Attach `status` under the `sync` group. The former top-level `agents status` is retired. */
export function registerStatusCommand(syncCmd: Command): void {
  const cmd = addHostOption(
    syncCmd
      .command('status')
      .description('Unified sync status across the fleet — what is drifted, missing, or behind, with an option to sync it.'),
  )
    .option('--json', 'Output the machine-readable UnifiedSyncStatus contract')
    .option('--yes', 'Reconcile everything detected (pull .system if behind + sync drifted/missing resources) without prompting')
    .option('--cwd <path>', 'Resolution cwd for project layer detection (default: process.cwd())');

  setHelpSections(cmd, {
    examples: `
      # Show what's out of sync; offer to fix it (interactive)
      agents sync status

      # Machine-readable status for the menu-bar / Agency
      agents sync status --json

      # Reconcile everything with no prompts (CI / scripts / the "kick it" path)
      agents sync status --yes
    `,
  });

  cmd.action(async (opts: StatusOptions, command: Command) => {
    // Centralized surface read (the human/agent split in one place). Note we still
    // pass the *raw* `opts.yes` to promptDriftSync below — it distinguishes an
    // explicit `--yes` (act) from a non-TTY shell (report only), so `surface.assumeYes`
    // (which conflates the two) would wrongly auto-reconcile in a plain pipe.
    const surface = resolveSurface(command);
    const cwd = opts.cwd ?? process.cwd();

    if (surface.json) {
      const status = await computeSyncStatus({ cwd });
      console.log(JSON.stringify(status, null, 2));
      return;
    }

    const status = await computeSyncStatus({ cwd });

    // Human summary header (always) — the per-version readout.
    console.log(chalk.bold('Fleet sync status'));
    if (status.system.unknown) {
      console.log(`  ${'.system repo'.padEnd(28)} ${chalk.gray('freshness unknown (no upstream)')}`);
    } else if (status.system.behind > 0) {
      console.log(
        `  ${'.system repo'.padEnd(28)} ${chalk.yellow(`${status.system.behind} behind`)}`,
      );
    } else {
      console.log(`  ${'.system repo'.padEnd(28)} ${chalk.green('up to date')}`);
    }
    // A non-git / partial ~/.agents is its own drift state, not a per-agent
    // "N missing" — surface it distinctly so the real problem isn't buried (PHNX-3301).
    if (status.user.notGitRepo) {
      console.log(
        `  ${'~/.agents (user repo)'.padEnd(28)} ${chalk.yellow('not a git repo — will adopt on next `agents sync` (or `agents repo sync user`)')}`,
      );
    }
    if (status.agents.length === 0) {
      console.log(chalk.gray('  (no installed agent versions)'));
    }
    for (const v of status.agents) {
      // Model sits right beside the version, same priority (no label).
      const model = resolveConfiguredModel(v.agent, v.version)?.model;
      const defaultTag = v.isDefault ? ' (default)' : '';
      const plain = `${agentName(v.agent)}@${v.version}${model ? ` · ${model}` : ''}${defaultTag}`;
      const shown = `${agentName(v.agent)}@${v.version}`
        + (model ? ` ${chalk.gray('·')} ${chalk.yellow(model)}` : '')
        + (v.isDefault ? chalk.gray(' (default)') : '');
      const pad = ' '.repeat(Math.max(1, 34 - plain.length));
      console.log(`  ${shown}${pad}${versionSummary(v)}`);
      for (const line of formatDriftRows(v)) console.log(chalk.gray(`      ${line}`));
    }
    if (status.totals.orphan > 0) {
      console.log(
        chalk.gray(`  (${status.totals.orphan} orphan${status.totals.orphan === 1 ? '' : 's'} — run \`agents prune cleanup\`)`),
      );
    }

    // Config drift is its OWN class, not a per-agent "N missing": a box that has
    // not folded its device-scoped state still carries a stale top-level header or
    // a lingering central fleet/hosts/accounts/browser block. Surface it distinctly
    // so an un-drained box is SEEN here instead of via a mystery pull conflict
    // (PHNX-3315).
    if (status.config.staleHeader || status.config.centralLeaks.length > 0) {
      console.log(
        `  ${'config (device-scoped)'.padEnd(28)} ${chalk.yellow('not drained — folds automatically on normal `agents` use here (idempotent)')}`,
      );
      if (status.config.staleHeader) {
        console.log(chalk.gray('    · top-level agents.yaml header is stale (pre-rename)'));
      }
      for (const leak of status.config.centralLeaks) {
        console.log(chalk.gray(`    · central ${leak} should be device-scoped`));
      }
    }

    // Hand off to the shared interactive/apply flow (summary already printed above).
    await promptDriftSync({ cwd, yes: opts.yes, status, quiet: true });
  });
}
