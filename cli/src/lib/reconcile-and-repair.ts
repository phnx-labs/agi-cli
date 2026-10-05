import type { AgentId } from './types.js';
import { AGENTS, ALL_AGENT_IDS } from './agents.js';
import chalk from 'chalk';
import { heal, healChangedAnything, type HealResult } from './heal.js';
import { projectAccountSlots, type SlotProjection } from './accounts/slots.js';
import {
  checkVersionHookWiring,
  registerHooksToSettings,
  repairManagedHookRuntimeArtifacts,
  type HookRuntimeRepairReport,
} from './hooks/install.js';
import {
  getVersionHomePath,
  listInstalledVersions,
  isVersionIsolated,
} from './installations/versions.js';
import { invalidateDoctorOverviewCache } from './devices/doctor-overview-cache.js';
import {
  remediateStaleAgentsCliInstalls,
  resolveRunningPackageRoot,
  type RemediateStaleInstallsResult,
  type FindAgentsCliInstallsOptions,
} from './self-update.js';
import { getCliVersion } from './version.js';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __moduleDirname = path.dirname(fileURLToPath(import.meta.url));

const AGENT_NAMES: Record<string, string> = Object.fromEntries(
  ALL_AGENT_IDS.map((id) => [id, AGENTS[id].name]),
);

const HOOK_WIRING_FIX_AGENTS: AgentId[] = ['claude', 'droid'];


interface HookRewireResult {
  agent: AgentId;
  version: string;
  rewired: number;
  remaining: number;
  failure?: 'register-failed';
}

interface RepairAfterSyncReport {
  heal: HealResult;
  hookRewire: HookRewireResult[];
  hookRuntimeRepair: HookRuntimeRepairReport;
  staleInstallPurge: RemediateStaleInstallsResult | null;
  slotProjection: SlotProjection[];
  slotProjectionErrors: string[];
}

interface PurgeInjection {
  runningRoot?: string;
  runningVersion?: string;
  pathEnv?: string;
  findOpts?: FindAgentsCliInstallsOptions;
  dryRun?: boolean;
}

interface RepairAfterSyncOptions {
  agent?: AgentId;
  versions?: string[];
  cwd?: string;
  pruneClis?: boolean;
  purgeInjection?: PurgeInjection;
}


function rewireUnwiredHooks(agent: AgentId | undefined, versions: string[] | undefined): HookRewireResult[] {
  // Repair only missing wiring in the supported set; never delete user hook entries.
  const out: HookRewireResult[] = [];
  const agents = agent
    ? (HOOK_WIRING_FIX_AGENTS.includes(agent) ? [agent] : [])
    : HOOK_WIRING_FIX_AGENTS;
  for (const a of agents) {
    const vers = agent && versions && versions.length > 0
      ? versions
      : listInstalledVersions(a).filter((v) => !isVersionIsolated(a, v));
    for (const version of vers) {
      const before = checkVersionHookWiring(a, version);
      if (!before.supported) continue;
      const need = before.unwired.length + (before.settingsMissing ? (before.expected ?? 0) : 0);
      if (need === 0) continue;
      try {
        const registration = registerHooksToSettings(a, getVersionHomePath(a, version));
        if (registration.errors.length > 0) {
          out.push({ agent: a, version, rewired: 0, remaining: need, failure: 'register-failed' });
          continue;
        }
        const after = checkVersionHookWiring(a, version);
        const remaining = after.unwired.length + (after.settingsMissing ? (after.expected ?? 0) : 0);
        out.push({ agent: a, version, rewired: Math.max(0, need - remaining), remaining });
      } catch {
        out.push({ agent: a, version, rewired: 0, remaining: need, failure: 'register-failed' });
      }
    }
  }
  return out;
}

function runtimeRepairFilter(
  agent: AgentId | undefined,
  versions: string[] | undefined,
): { agent?: AgentId; version?: string } | undefined {
  if (!agent) return undefined;
  return {
    agent,
    ...(versions && versions.length === 1 ? { version: versions[0] } : {}),
  };
}

/**
 * RUSH-2415: delete npx-cache / unsafe-legacy / pre-1.22.30 agents-cli copies
 * when a fixed peer already exists. DESTRUCTIVE (`fs.rmSync`), so it is never
 * automatic — it runs only via `agents sync --prune-clis`. `injection` scopes the
 * scan+delete to sandbox paths in tests so it can never touch a real install.
 */
function purgeStaleAgentsCliCopies(injection?: PurgeInjection): RemediateStaleInstallsResult | null {
  let runningRoot = injection?.runningRoot;
  if (!runningRoot) {
    try {
      runningRoot = resolveRunningPackageRoot(__moduleDirname);
    } catch {
      return null;
    }
  }
  return remediateStaleAgentsCliInstalls({
    runningRoot,
    runningVersion: injection?.runningVersion ?? getCliVersion(),
    ...(injection?.pathEnv !== undefined ? { pathEnv: injection.pathEnv } : {}),
    ...(injection?.findOpts ? { findOpts: injection.findOpts } : {}),
    ...(injection?.dryRun ? { dryRun: injection.dryRun } : {}),
  });
}


export async function repairAfterSync(opts: RepairAfterSyncOptions): Promise<RepairAfterSyncReport> {
  // Reconcile canonical resources before targeted fill/fix repairs.
  const healResult = await heal({
    mode: 'full',
    agent: opts.agent,
    versions: opts.agent ? opts.versions : undefined,
    ...(opts.cwd ? { cwd: opts.cwd } : {}),
  });

  const hookRewire = rewireUnwiredHooks(opts.agent, opts.versions);

  // One requested version is scoped exactly; multiple versions use one harness-wide repair pass.
  const hookRuntimeRepair = repairManagedHookRuntimeArtifacts({
    filter: runtimeRepairFilter(opts.agent, opts.versions),
  });

  const staleInstallPurge = (!opts.agent && opts.pruneClis === true)
    ? purgeStaleAgentsCliCopies(opts.purgeInjection)
    : null;

  // Reproject account slots after sync so native homes cannot retain stale assignments.
  const slotProjection: SlotProjection[] = [];
  const slotProjectionErrors: string[] = [];
  const slotAgents = opts.agent ? [opts.agent] : ALL_AGENT_IDS.filter((a) => listInstalledVersions(a).length > 0);
  for (const agent of slotAgents) {
    try {
      slotProjection.push(...projectAccountSlots(agent));
    } catch (err) {
      slotProjectionErrors.push(`${agent}: ${(err as Error).message}`);
    }
  }

  const report: RepairAfterSyncReport = {
    heal: healResult,
    hookRewire,
    hookRuntimeRepair,
    staleInstallPurge,
    slotProjection,
    slotProjectionErrors,
  };

  if (repairChangedAnything(report)) invalidateDoctorOverviewCache();
  return report;
}

export function repairChangedAnything(report: RepairAfterSyncReport): boolean {
  return (
    healChangedAnything(report.heal) ||
    report.hookRewire.some((r) => r.rewired > 0 || r.remaining > 0 || r.failure !== undefined) ||
    report.hookRuntimeRepair.attempts.length > 0 ||
    (report.staleInstallPurge !== null &&
      (report.staleInstallPurge.removed.length > 0 || report.staleInstallPurge.failed.length > 0)) ||
    report.slotProjection.length > 0 ||
    report.slotProjectionErrors.length > 0
  );
}

export function repairHadFailures(report: RepairAfterSyncReport): boolean {
  // Stale-install purge failures are reported separately, not as reconcile failure status.
  return (
    report.hookRewire.some((r) => r.failure !== undefined) ||
    report.hookRuntimeRepair.needsAttention.length > 0
  );
}

export function repairAfterSyncJson(report: RepairAfterSyncReport): Record<string, unknown> {
  return {
    heal: report.heal,
    hookRewire: report.hookRewire,
    hookRuntimeRepair: report.hookRuntimeRepair,
    staleInstallPurge: report.staleInstallPurge,
    slotProjection: report.slotProjection,
    slotProjectionErrors: report.slotProjectionErrors,
    hadFailures: repairHadFailures(report),
  };
}


function renderHealText(result: HealResult, log: (s: string) => void): void {
  for (const r of result.repairedManifests) {
    log(`  ${chalk.green('repair')}  plugin ${chalk.bold(r.plugin)} ${chalk.gray(`— dropped invalid ${r.droppedFields.join(', ')} field`)}`);
  }
  for (const r of result.refreshedPlugins) {
    log(`  ${chalk.green('refresh')} plugin ${chalk.bold(r.plugin)}  ${chalk.gray(`${r.from} → ${r.to}`)}`);
  }
  for (const s of result.skippedPlugins) {
    const why = s.reason === 'modified'
      ? `locally modified — left as-is (run \`agents plugins update ${s.plugin}\` to force)`
      : `no baseline recorded — left as-is (run \`agents plugins update ${s.plugin}\` to adopt)`;
    log(`  ${chalk.yellow('hold  ')} plugin ${chalk.bold(s.plugin)}  ${chalk.gray(`${s.from} → ${s.upstream} available; ${why}`)}`);
  }

  for (const v of result.versions) {
    const label = `${AGENT_NAMES[v.agent] || v.agent}@${v.version}`;
    if (v.healed.length === 0 && v.skipped.length === 0) continue;
    const byKind = new Map<string, number>();
    for (const h of v.healed) byKind.set(h.kind, (byKind.get(h.kind) ?? 0) + 1);
    const parts = Array.from(byKind, ([k, n]) => `${n} ${k}`);
    if (v.healed.length > 0) {
      log(`  ${chalk.green('fixed ')}  ${label}  ${chalk.gray(parts.join(', '))}`);
    }
    const drift = v.skipped.filter((s) => s.reason === 'drift');
    const unres = v.skipped.filter((s) => s.reason === 'unreconcilable');
    if (drift.length > 0) {
      log(`  ${chalk.yellow('drift ')}  ${label}  ${chalk.gray(`${drift.length} hand-edited — left as-is (use \`--diff\` to inspect)`)}`);
    }
    if (unres.length > 0) {
      const names = unres.map((s) => `${s.kind}/${s.name}`).join(', ');
      log(`  ${chalk.yellow('hold  ')}  ${label}  ${chalk.gray(`${unres.length} couldn't reconcile (${names}) — source/home mismatch the writer can't satisfy`)}`);
    }
  }
}

function renderHookRewireText(rewired: HookRewireResult[], log: (s: string) => void): void {
  for (const r of rewired) {
    const label = `${AGENT_NAMES[r.agent] || r.agent}@${r.version}`;
    if (r.failure) {
      log(`  ${chalk.red('hold  ')} ${label}  ${chalk.gray('native hook wiring could not be updated')}`);
    } else if (r.remaining === 0) {
      log(`  ${chalk.green('rewired')} ${label}  ${chalk.gray(`${r.rewired} hook${r.rewired === 1 ? '' : 's'} wired into settings.json`)}`);
    } else {
      log(`  ${chalk.yellow('hold  ')} ${label}  ${chalk.gray(`${r.remaining} hook${r.remaining === 1 ? '' : 's'} still unwired — run \`agents sync ${r.agent}@${r.version} --yes\``)}`);
    }
  }
}

function renderHookRuntimeRepairText(repair: HookRuntimeRepairReport, log: (s: string) => void): void {
  for (const fixed of repair.fixed) {
    log(`  ${chalk.green('fixed ')}  ${chalk.gray(fixed)}`);
  }
  for (const unresolved of repair.needsAttention) {
    log(`  ${chalk.red('hold  ')}  ${chalk.gray(unresolved)}`);
  }
}

function renderStaleInstallPurgeText(purge: RemediateStaleInstallsResult, log: (s: string) => void): void {
  if (purge.removed.length === 0 && purge.failed.length === 0 && purge.unresolved.length === 0) return;
  log(chalk.bold('\nStale agents-cli installs'));
  for (const r of purge.removed) {
    const why = r.reasons.join(', ');
    log(`  ${chalk.green('purged')} ${chalk.gray(`${r.packageRoot}  ${r.version}  (${why})`)}`);
  }
  for (const f of purge.failed) {
    log(`  ${chalk.red('hold  ')} ${chalk.gray(`${f.packageRoot}  ${f.version}  — ${f.error}`)}`);
  }
  for (const u of purge.unresolved) {
    log(`  ${chalk.yellow('manual')} ${chalk.gray(`${u.packageRoot}  ${u.version}  — remove it with:`)}`);
    log(`         ${chalk.bold(u.manualRemoveCommand)}`);
  }
}

export function renderRepairAfterSync(
  report: RepairAfterSyncReport,
  log: (s: string) => void = (s) => console.log(s),
): void {
  if (!repairChangedAnything(report)) return;
  renderHealText(report.heal, log);
  renderHookRewireText(report.hookRewire, log);
  renderHookRuntimeRepairText(report.hookRuntimeRepair, log);
  if (report.staleInstallPurge) renderStaleInstallPurgeText(report.staleInstallPurge, log);
  renderSlotProjectionText(report, log);
}

function renderSlotProjectionText(report: RepairAfterSyncReport, log: (s: string) => void): void {
  for (const slot of report.slotProjection) {
    const pruned = slot.pruned.length > 0 ? chalk.gray(` — removed ${slot.pruned.join(', ')}`) : '';
    log(`  ${chalk.green('slot')}    account ${chalk.bold(slot.name)} ${chalk.gray(`← ${slot.from}`)}${pruned}`);
  }
  for (const err of report.slotProjectionErrors) {
    log(`  ${chalk.yellow('slot')}    ${err}`);
  }
}
