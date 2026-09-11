/**
 * Interactive drift-sync flow — the single "we detected drift, want to fix it?"
 * action, shared by `agents sync status`, `agents doctor`, and the menu-bar "NEEDS
 * SYNC" row.
 *
 * It composes existing pieces, re-implementing nothing:
 *   - computeSyncStatus()          — the unified detection engine (sync-status.ts)
 *   - pullRepo()                   — fast-forward the `.system` repo (git.ts)
 *   - promptAgentVersionSelection() — the "which agent types / versions?" picker
 *   - repairAfterSync()            — the shared post-reconcile repair pass
 *                                    `agents sync` runs (heal + hook rewire +
 *                                    managed hook runtime shim repair)
 *
 * Combined flow (one confirmation): if `.system` is behind AND resources drifted,
 * a single "Sync all detected" both pulls `.system` and reconciles the chosen
 * version homes. The security posture is preserved — the `.system` pull only ever
 * happens on an explicit user choice here, never silently (see auto-pull-worker.ts
 * for why system auto-pull is off by default).
 */

import chalk from 'chalk';
import { select, confirm } from '@inquirer/prompts';
import { AgentId } from './types.js';
import { AGENTS } from './agents.js';
import { pullRepo } from './git.js';
import { type VersionHealResult } from './heal.js';
import { repairAfterSync, renderRepairAfterSync } from './reconcile-and-repair.js';
import { promptAgentVersionSelection } from './installations/versions.js';
import { isInteractiveTerminal, isPromptCancelled } from './format.js';
import {
  computeSyncStatus,
  type UnifiedSyncStatus,
  type AgentVersionStatus, formatDriftRows } from './sync-status.js';

export interface DriftSyncOptions {
  cwd?: string;
  /** Reconcile everything detected with no prompts — the "kick it" path, also the
   * non-TTY / menu-bar-launched-with-flag behavior. Pulls `.system` if behind. */
  yes?: boolean;
  /** Pre-computed status, to avoid a second scan when the caller already has one. */
  status?: UnifiedSyncStatus;
  /** Skip the drift summary — set by callers that already printed their own. */
  quiet?: boolean;
}

export interface DriftSyncResult {
  systemBehindBefore: number;
  systemPulled: boolean;
  healed: VersionHealResult[];
  /** True when the user declined at the prompt (nothing was changed). */
  cancelled: boolean;
  /** True when there was no drift to act on in the first place. */
  nothingToDo: boolean;
}

const agentName = (id: AgentId): string => AGENTS[id]?.name ?? id;

/** "claude@2.1.170  2 drifted · 1 missing" for one version. */
function versionLine(v: AgentVersionStatus): string {
  const bits: string[] = [];
  if (v.counts.drifted) bits.push(`${v.counts.drifted} drifted`);
  if (v.counts.missing) bits.push(`${v.counts.missing} missing`);
  const label = `${agentName(v.agent)}@${v.version}`;
  return `  ${label.padEnd(28)} ${chalk.yellow(bits.join(' · '))}`;
}

/** Render the drift summary (system freshness + each version owed a sync). */
function renderSummary(status: UnifiedSyncStatus, needing: AgentVersionStatus[]): void {
  console.log(chalk.bold('\nSync status'));
  if (status.system.behind > 0) {
    console.log(
      `  ${'.system repo'.padEnd(28)} ${chalk.yellow(
        `${status.system.behind} commit${status.system.behind === 1 ? '' : 's'} behind`,
      )} ${chalk.gray('— pull recommended')}`,
    );
  }
  for (const v of needing) {
    console.log(versionLine(v));
    for (const line of formatDriftRows(v)) console.log(chalk.gray(`      ${line}`));
  }
  if (status.totals.orphan > 0) {
    console.log(
      chalk.gray(`  (${status.totals.orphan} orphan${status.totals.orphan === 1 ? '' : 's'} — run \`agents prune cleanup\`)`),
    );
  }
}

/** Fast-forward the `.system` repo. Returns whether it actually moved. */
async function pullSystem(status: UnifiedSyncStatus): Promise<boolean> {
  if (status.system.behind <= 0) return false;
  const res = await pullRepo(status.system.dir);
  if (res.success) {
    console.log(chalk.green(`Pulled .system (+${status.system.behind}).`));
    return true;
  }
  console.log(chalk.red(`Could not pull .system: ${res.error ?? 'unknown error'}`));
  return false;
}

/**
 * Reconcile a set of versions grouped by agent through the SHARED post-reconcile
 * repair pass (`repairAfterSync`) — the same superset the three `agents sync`
 * handlers run. Beyond the resources `heal()` fills, this also re-wires hooks
 * left unwired and repairs broken managed hook runtime shims, so drift-sync is
 * not a third orchestrator that silently skips shim repair. Renders each pass's
 * rewire / shim-repair detail; the heal rollup is printed separately by the
 * caller via `reportHealed`.
 */
async function healVersions(
  versionsByAgent: Map<AgentId, string[]>,
  cwd: string,
): Promise<VersionHealResult[]> {
  const out: VersionHealResult[] = [];
  for (const [agent, versions] of versionsByAgent) {
    if (versions.length === 0) continue;
    const repair = await repairAfterSync({ agent, versions, cwd });
    out.push(...repair.heal.versions);
    renderRepairAfterSync(repair, (line) => console.log(line));
  }
  return out;
}

/** Report which agents received what after a heal. */
function reportHealed(healed: VersionHealResult[]): void {
  const touched = healed.filter((v) => v.healed.length > 0);
  if (touched.length === 0) {
    console.log(chalk.gray('Nothing to reconcile — homes already matched sources.'));
    return;
  }
  const total = touched.reduce((n, v) => n + v.healed.length, 0);
  const agents = [...new Set(touched.map((v) => agentName(v.agent)))].join(', ');
  console.log(chalk.green(`Synced ${total} resource${total === 1 ? '' : 's'} to ${agents}.`));
}

function groupNeeding(needing: AgentVersionStatus[]): Map<AgentId, string[]> {
  const m = new Map<AgentId, string[]>();
  for (const v of needing) {
    const list = m.get(v.agent) ?? [];
    list.push(v.version);
    m.set(v.agent, list);
  }
  return m;
}

/**
 * The unified "drift detected — sync now?" flow. Returns a structured result so
 * callers (menu-bar, doctor) can report without re-scanning.
 */
export async function promptDriftSync(opts: DriftSyncOptions = {}): Promise<DriftSyncResult> {
  const cwd = opts.cwd ?? process.cwd();
  const status = opts.status ?? (await computeSyncStatus({ cwd }));
  const needing = status.agents.filter((a) => a.needsSync);
  const systemBehind = status.system.behind;

  const base: DriftSyncResult = {
    systemBehindBefore: systemBehind,
    systemPulled: false,
    healed: [],
    cancelled: false,
    nothingToDo: false,
  };

  if (systemBehind <= 0 && needing.length === 0) {
    console.log(chalk.green('Everything is in sync.'));
    return { ...base, nothingToDo: true };
  }

  if (!opts.quiet) renderSummary(status, needing);

  // Non-interactive OR explicit --yes: reconcile everything detected.
  if (opts.yes || !isInteractiveTerminal()) {
    if (!opts.yes) {
      // Non-TTY without --yes: report, don't act, don't throw.
      console.log(chalk.gray('\nRun `agents sync status --yes` to sync, or `agents sync status` in a terminal to choose.'));
      return base;
    }
    const systemPulled = await pullSystem(status);
    const healed = await healVersions(groupNeeding(needing), cwd);
    reportHealed(healed);
    return { ...base, systemPulled, healed };
  }

  // Interactive gate.
  let choice: 'all' | 'choose' | 'no';
  try {
    choice = await select<'all' | 'choose' | 'no'>({
      message: 'Sync now?',
      choices: [
        { name: 'Sync all detected', value: 'all' },
        { name: 'Choose agents & resources', value: 'choose' },
        { name: 'No', value: 'no' },
      ],
      default: 'all',
    });
  } catch (err) {
    if (isPromptCancelled(err)) return { ...base, cancelled: true };
    throw err;
  }

  if (choice === 'no') return { ...base, cancelled: true };

  if (choice === 'all') {
    const systemPulled = await pullSystem(status);
    const healed = await healVersions(groupNeeding(needing), cwd);
    reportHealed(healed);
    return { ...base, systemPulled, healed };
  }

  // choice === 'choose': optional .system pull, then per-agent/version selection.
  let systemPulled = false;
  if (systemBehind > 0) {
    try {
      const pull = await confirm({ message: `Pull .system (${systemBehind} behind) first?`, default: true });
      if (pull) systemPulled = await pullSystem(status);
    } catch (err) {
      if (!isPromptCancelled(err)) throw err;
      return { ...base, systemPulled, cancelled: true };
    }
  }

  const needingAgents = [...new Set(needing.map((a) => a.agent))];
  let selection;
  try {
    selection = await promptAgentVersionSelection(needingAgents);
  } catch (err) {
    if (isPromptCancelled(err)) return { ...base, systemPulled, cancelled: true };
    throw err;
  }

  const healed = await healVersions(selection.versionSelections, cwd);
  reportHealed(healed);
  return { ...base, systemPulled, healed };
}
