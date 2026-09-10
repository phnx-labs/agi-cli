/**
 * Post-reconcile repair — the shared "make it whole" pass `agents sync` runs
 * after its prune+write, so sync is a true superset of the old `doctor --fix`.
 *
 * `syncResourcesToVersion` reconciles resource FILES (and, with a caller
 * selection, prunes orphans). It does NOT: fill live-home gaps the staleness
 * manifest can't see, generate/repair the managed hook runtime shims, or re-wire
 * a present-but-unwired hook into settings.json. `doctor --fix` used to do all of
 * that; now sync does, by calling this one routine at the tail of every reconcile.
 * (The destructive stale-CLI purge `doctor --fix` also ran is NOT automatic here
 * — it runs only via the explicit `agents sync --prune-clis`, see `pruneClis`.)
 *
 * Ordering matters: sync's own prune+write happens FIRST (unchanged), THEN this
 * repair pass. Prune stays sync's job; heal only FILLS and FIXES (never deletes),
 * so the two never fight. Pure of stdout — returns a structured report;
 * `renderRepairAfterSync` prints it only when the caller is neither `--json` nor
 * `--quiet`.
 */
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

// Claude-family agents whose native hook wiring `checkVersionHookWiring` can
// verify (and `registerHooksToSettings` re-wire).
const HOOK_WIRING_FIX_AGENTS: AgentId[] = ['claude', 'droid'];

// ─── result shapes ─────────────────────────────────────────────────────────

export interface HookRewireResult {
  agent: AgentId;
  version: string;
  /** Hooks newly wired into settings.json by this pass. */
  rewired: number;
  /** Hooks still unwired after re-registering (source/home mismatch). */
  remaining: number;
  /** Stable failure class; never expose a generated temporary shim pathname. */
  failure?: 'register-failed';
}

export interface RepairAfterSyncReport {
  heal: HealResult;
  hookRewire: HookRewireResult[];
  hookRuntimeRepair: HookRuntimeRepairReport;
  /** Only populated on the umbrella (no-agent) path; null otherwise. */
  staleInstallPurge: RemediateStaleInstallsResult | null;
  /**
   * Account slots re-projected from their harness's default version home
   * (PHNX-3940): one entry per slot, with the artifacts pruned because the
   * source no longer carries them. Errors are per-harness sentences.
   */
  slotProjection: SlotProjection[];
  slotProjectionErrors: string[];
}

/**
 * Test/override hook that scopes the destructive stale-CLI purge to injected
 * paths so it NEVER touches real machine installs. `findAgentsCliInstalls`
 * hard-codes `/usr/local/lib/node_modules` et al. when `globalNodeModulesDirs` is
 * absent, so a purge is unsafe to run unscoped in a test — inject sandbox paths.
 */
export interface PurgeInjection {
  runningRoot?: string;
  runningVersion?: string;
  pathEnv?: string;
  findOpts?: FindAgentsCliInstallsOptions;
  dryRun?: boolean;
}

export interface RepairAfterSyncOptions {
  /** Scope the repair to one agent; omit for the umbrella sweep across all
   *  installed agents. (The purge is NOT tied to this — see `pruneClis`.) */
  agent?: AgentId;
  /** The versions of `agent` the sync just reconciled. Passing them scopes
   *  heal + rewire + runtime-repair to exactly those homes; omitting lets heal
   *  apply its own non-isolated sweep. */
  versions?: string[];
  /** Resolution cwd for heal's diff. Defaults to heal's neutral home dir. */
  cwd?: string;
  /** Run the DESTRUCTIVE machine-wide stale-CLI purge (`fs.rmSync`s other
   *  agents-cli installs). Default false — the purge is NEVER automatic; it runs
   *  only on the umbrella (no-agent) path AND only when the caller passed
   *  `agents sync --prune-clis`. */
  pruneClis?: boolean;
  /** Scope the purge scan+delete to injected paths (tests only). */
  purgeInjection?: PurgeInjection;
}

// ─── hook re-wire (files reconciled but not referenced in settings.json) ─────

/**
 * Re-wire hooks that reconcile as files but are absent from settings.json.
 *
 * heal() only re-syncs resources the diff flags missing/diff; a hook whose file
 * is byte-identical to source but never referenced in settings.json is neither,
 * so heal walks past it. registerHooksToSettings (the same call `agents sync`
 * makes at versions.ts) regenerates the wiring, so run it for any Claude-family
 * version this repair targets that has unwired hooks. Only claude/droid — the
 * set checkVersionHookWiring can verify.
 */
function rewireUnwiredHooks(agent: AgentId | undefined, versions: string[] | undefined): HookRewireResult[] {
  const out: HookRewireResult[] = [];
  const agents = agent
    ? (HOOK_WIRING_FIX_AGENTS.includes(agent) ? [agent] : [])
    : HOOK_WIRING_FIX_AGENTS;
  for (const a of agents) {
    // Explicit versions (the sync's reconcile targets) are honoured as-is; a
    // sweep excludes isolated copies, mirroring heal().
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
        // A shim write can fail before the native config writer returns its own
        // errors. Record the same stable class and keep the repair moving to the
        // one bounded runtime repair pass below.
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
  // A single concrete target narrows to that version. Broad selectors (@all,
  // agent-only) still make one bounded repair pass for that harness.
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
      // resolveRunningPackageRoot walks up until package.json names this package.
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

// ─── public entrypoint ────────────────────────────────────────────────────────

/**
 * Run the post-reconcile repair pass over the agents/versions a sync just
 * touched: heal live-home gaps (mode 'full', matching the old `doctor --fix`),
 * re-wire hooks the diff-driven heal leaves behind, run one bounded managed-hook
 * runtime repair, and — ONLY when `pruneClis` is set on the umbrella (no-agent)
 * path — purge stale/legacy agents-cli copies. The purge is never automatic.
 * Returns a full account; never writes to stdout.
 */
export async function repairAfterSync(opts: RepairAfterSyncOptions): Promise<RepairAfterSyncReport> {
  const healResult = await heal({
    mode: 'full',
    agent: opts.agent,
    versions: opts.agent ? opts.versions : undefined,
    ...(opts.cwd ? { cwd: opts.cwd } : {}),
  });

  // Re-wire hooks the diff-driven heal leaves behind (present file, not wired).
  const hookRewire = rewireUnwiredHooks(opts.agent, opts.versions);

  // One inspect→generate→verify pass after resource + native-wiring repair have
  // settled. This routine never calls sync/register and never retries.
  const hookRuntimeRepair = repairManagedHookRuntimeArtifacts({
    filter: runtimeRepairFilter(opts.agent, opts.versions),
  });

  // The stale-CLI purge is DESTRUCTIVE and NEVER automatic: it runs only on the
  // umbrella (no-agent) path AND only when the caller opted in via
  // `agents sync --prune-clis`. Drift-fixers above always run; this does not.
  const staleInstallPurge = (!opts.agent && opts.pruneClis === true)
    ? purgeStaleAgentsCliCopies(opts.purgeInjection)
    : null;

  // Account slots follow the version home (PHNX-3940). `agents accounts add`
  // projects a slot once; without this every later sync would update the
  // version home and leave each slot on the resources it was cloned with.
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

/** True when the repair pass changed (or attempted to change) anything. */
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

/**
 * True when the RECONCILE repair left a per-version problem a human must fix — an
 * unresolvable managed hook runtime shim, or a hook that could not be re-wired.
 * These gate a sync's `ok`/exit code (the yosemite-s1 class the old
 * `doctor --fix` surfaced).
 *
 * The machine-wide stale-CLI purge is deliberately EXCLUDED: a purge that could
 * not delete a system-wide install (typically `EACCES` on `/usr/local/...`, which
 * needs sudo) is a hygiene issue unrelated to whether the reconcile succeeded, so
 * it must not flip a fleet peer's `agents sync --json` to `ok: false`. Purge
 * failures stay fully visible — in the JSON `repair.staleInstallPurge.failed` and
 * the rendered `hold`/`manual` lines.
 */
export function repairHadFailures(report: RepairAfterSyncReport): boolean {
  return (
    report.hookRewire.some((r) => r.failure !== undefined) ||
    report.hookRuntimeRepair.needsAttention.length > 0
  );
}

/**
 * Serialize the repair pass for a `--json` sync payload — the machine surface the
 * deleted `doctor --fix --json` used to carry (heal detail + hook rewire + hook
 * runtime repair + the umbrella stale-CLI purge). Attached under the `repair` key
 * so fleet fan-out sees what the reconcile fixed and whether anything still needs
 * a human (mirror `repairHadFailures`).
 */
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

// ─── rendering (human output; sync calls this only when !json && !quiet) ─────

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

/**
 * Print the repair pass's human-readable detail. Sync calls this only on the
 * interactive / non-json path; the header is emitted only when something actually
 * changed, so a clean sync stays quiet.
 */
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
