
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

interface DriftSyncOptions {
  cwd?: string;
  yes?: boolean;
  status?: UnifiedSyncStatus;
  quiet?: boolean;
}

interface DriftSyncResult {
  systemBehindBefore: number;
  systemPulled: boolean;
  healed: VersionHealResult[];
  cancelled: boolean;
  nothingToDo: boolean;
}

const agentName = (id: AgentId): string => AGENTS[id]?.name ?? id;

function versionLine(v: AgentVersionStatus): string {
  const bits: string[] = [];
  if (v.counts.drifted) bits.push(`${v.counts.drifted} drifted`);
  if (v.counts.missing) bits.push(`${v.counts.missing} missing`);
  const label = `${agentName(v.agent)}@${v.version}`;
  return `  ${label.padEnd(28)} ${chalk.yellow(bits.join(' · '))}`;
}

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

  if (opts.yes || !isInteractiveTerminal()) {
    if (!opts.yes) {
      console.log(chalk.gray('\nRun `agents sync status --yes` to sync, or `agents sync status` in a terminal to choose.'));
      return base;
    }
    const systemPulled = await pullSystem(status);
    const healed = await healVersions(groupNeeding(needing), cwd);
    reportHealed(healed);
    return { ...base, systemPulled, healed };
  }

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
