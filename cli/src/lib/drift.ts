/**
 * Shared drift-detection internals for `agents doctor` (overview mode) and
 * `agents doctor --check` (the scriptable, CI-friendly gate).
 *
 * This is the single source of truth for "is the install out of sync?": the
 * per-version sync status (fresh / stale / never-synced) and the orphan census.
 * `agents doctor` renders it as a human report; `agents doctor --check` reduces it
 * to an exit code. Neither reimplements the diagnostic — both call `computeDrift`.
 */
import type { AgentId } from './types.js';
import { ALL_AGENT_IDS } from './agents.js';
import { getGlobalDefault, listInstalledVersions } from './installations/versions.js';
import { loadManifest, isStale } from './staleness/index.js';
import { diffVersionResources, type VersionResourceReport, type SourceLayerBehind } from './doctor-diff.js';
import { diffVersionCommands, iterCommandsCapableVersions } from './commands.js';
import { diffVersionSkills, iterSkillsCapableVersions } from './plugins/skills.js';
import { iterHooksCapableVersions, listUnmanagedHooksInVersionHome, checkVersionHookWiring } from './hooks/install.js';
import { commitsBehindUpstream } from './git.js';
import { getUserAgentsDir, getSystemAgentsDir, getEnabledExtraRepos } from './state.js';

export interface SyncStatusRow {
  agent: AgentId;
  version: string;
  status: 'fresh' | 'stale' | 'never-synced';
  isDefault: boolean;
  /** For stale rows: prioritized lines naming exactly what diverged (plugins first).
   *  Also carries hook-wiring divergence for a version whose hooks are present but
   *  not wired into settings.json — independent of manifest staleness. */
  divergence?: string[];
  /** Count of hooks present on disk but NOT wired into the version's settings.json
   *  (claude/droid). A non-zero value makes the version out-of-sync even when the
   *  manifest reads fresh — the yosemite-s1 blind spot the CI gate must catch. */
  unwiredHooks?: number;
  /** Generated hooks whose shared runtime wrapper is missing or unusable. */
  brokenHookRuntime?: number;
}

export interface OrphanRow {
  agent: AgentId;
  version: string;
  commands: number;
  skills: number;
  hooks: number;
}

// Lines naming exactly what's out of sync for a version, plugins prioritized:
// each divergent plugin gets its own line with specifics (stale mirror version,
// invalid manifest, or the bundled skills/commands missing from the mirror —
// the system-repo plugin content that matters most). Other kinds collapse to
// compact counts so the readout stays scannable.
function divergenceLines(report: VersionResourceReport): string[] {
  const lines: string[] = [];
  for (const p of report.kinds.plugins) {
    if (p.status === 'missing') lines.push(`plugin ${p.name} — not installed`);
    else if (p.status === 'diff') lines.push(`plugin ${p.name} — ${p.detail ?? 'mirror drifted'}`);
  }
  for (const kind of ['commands', 'skills', 'hooks', 'rules', 'mcp', 'permissions', 'subagents'] as const) {
    const rows = report.kinds[kind];
    const miss = rows.filter((r) => r.status === 'missing').length;
    const dif = rows.filter((r) => r.status === 'diff').length;
    const bits: string[] = [];
    if (miss) bits.push(`${miss} missing`);
    if (dif) bits.push(`${dif} drifted`);
    if (bits.length) lines.push(`${kind.padEnd(11)} ${bits.join(' · ')}`);
  }
  return lines;
}

export function checkSyncStatus(cwd: string): SyncStatusRow[] {
  const rows: SyncStatusRow[] = [];
  // Every installed version, not just the default — a stale NON-default version
  // (e.g. one you launched from yesterday) is exactly the rot that silently
  // serves outdated/invalid resources and that `--fix` now heals. Hiding it here
  // is why that class of bug went unnoticed.
  for (const agent of ALL_AGENT_IDS) {
    const def = getGlobalDefault(agent);
    for (const version of listInstalledVersions(agent)) {
      const manifest = loadManifest(agent, version);
      const status: SyncStatusRow['status'] = !manifest
        ? 'never-synced'
        : isStale(manifest, agent, version, cwd) ? 'stale' : 'fresh';
      const row: SyncStatusRow = { agent, version, status, isDefault: version === def };
      const divergence: string[] = [];
      if (status === 'stale') {
        // Resolve the specifics against non-project layers (the global home is
        // never reconciled against per-cwd project resources).
        const report = diffVersionResources(agent, version, { cwd, excludeProject: true });
        divergence.push(...divergenceLines(report));
      }
      // Hook WIRING is independent of manifest staleness: a hook file can be
      // byte-identical to source (fresh) yet absent from settings.json, so it
      // never fires. Surface that for every version, fresh or stale, so overview
      // AND `agents doctor --check` flag it (claude/droid; other agents report unsupported).
      const wiring = checkVersionHookWiring(agent, version);
      if (wiring.runtimeBroken.length > 0) {
        row.brokenHookRuntime = wiring.runtimeBroken.length;
        const names = wiring.runtimeBroken.map((issue) => issue.name);
        const shown = names.slice(0, 3).join(', ');
        divergence.push(`hooks       ${names.length} generated wrapper${names.length === 1 ? '' : 's'} broken (${shown}${names.length > 3 ? ', …' : ''})`);
      }
      if (wiring.supported) {
        const expected = wiring.expected ?? 0;
        if (wiring.settingsMissing && expected > 0) {
          row.unwiredHooks = expected;
          divergence.push(`hooks       settings.json missing — ${expected} declared hook(s) never fire`);
        } else if (wiring.settingsUnparseable) {
          row.unwiredHooks = Math.max(1, expected);
          divergence.push(`hooks       settings.json unparseable — wiring cannot be verified`);
        } else if (wiring.unwired.length > 0) {
          row.unwiredHooks = wiring.unwired.length;
          const names = wiring.unwired.map((u) => u.name);
          const shown = names.slice(0, 3).join(', ');
          divergence.push(`hooks       ${wiring.unwired.length} unwired (${shown}${names.length > 3 ? ', …' : ''})`);
        }
      }
      if (divergence.length) row.divergence = divergence;
      rows.push(row);
    }
  }
  return rows;
}

export function countOrphans(): OrphanRow[] {
  const byKey = new Map<string, OrphanRow>();

  const ensure = (agent: AgentId, version: string): OrphanRow => {
    const key = `${agent}@${version}`;
    let row = byKey.get(key);
    if (!row) {
      row = { agent, version, commands: 0, skills: 0, hooks: 0 };
      byKey.set(key, row);
    }
    return row;
  };

  for (const { agent, version } of iterCommandsCapableVersions()) {
    const diff = diffVersionCommands(agent, version);
    if (diff.orphans.length > 0) ensure(agent, version).commands = diff.orphans.length;
  }
  for (const { agent, version } of iterSkillsCapableVersions()) {
    const diff = diffVersionSkills(agent, version);
    if (diff.orphans.length > 0) ensure(agent, version).skills = diff.orphans.length;
  }
  // Orphan hooks are scripts in the version home that no agents.yaml/hooks.yaml
  // entry registers — so the registrar never wires them to an event and they
  // never fire. (Distinct from the source-diff `diffVersionHooks().orphans`,
  // which false-flags valid system-sourced registered hooks.)
  for (const { agent, version } of iterHooksCapableVersions()) {
    const dead = listUnmanagedHooksInVersionHome(agent, version);
    if (dead.length > 0) ensure(agent, version).hooks = dead.length;
  }

  return Array.from(byKey.values()).filter((r) => r.commands + r.skills + r.hooks > 0);
}

/**
 * Probe each source layer (user, system, enabled extras) for how far it trails
 * its upstream, from the LAST-FETCHED remote-tracking ref (no network). A layer
 * behind origin means every version home is reconciled against stale truth — a
 * drift signal `agents doctor --check` must fail on, not a buried preamble. Returns
 * only the behind layers. Canonical home for both `agents doctor` and `agents doctor --check`.
 */
export function computeSourceBehind(): SourceLayerBehind[] {
  const out: SourceLayerBehind[] = [];
  const probe = (layer: SourceLayerBehind['layer'], dir: string, label: string, alias: string): void => {
    const r = commitsBehindUpstream(dir);
    if (r && r.behind > 0) out.push({ layer, label, alias, behind: r.behind, branch: r.branch });
  };
  probe('user', getUserAgentsDir(), '~/.agents', 'user');
  probe('system', getSystemAgentsDir(), '~/.agents/.system', 'system');
  for (const e of getEnabledExtraRepos()) probe('extra', e.dir, e.alias, e.alias);
  return out;
}

interface DriftSummary {
  syncRows: SyncStatusRow[];
  orphanRows: OrphanRow[];
  /** Versions whose sources changed since last sync. */
  staleCount: number;
  /** Versions installed but never synced. */
  neverSyncedCount: number;
  /** Versions carrying orphan resources (informational — not a drift signal). */
  orphanVersionCount: number;
  /** Versions with hooks present on disk but not wired into settings.json. */
  unwiredHookVersions: number;
  /** Versions with at least one broken generated hook-runtime wrapper. */
  brokenHookRuntimeVersions: number;
  /** Source layers behind their upstream (reconciled against stale truth). */
  sourceBehind: SourceLayerBehind[];
  /**
   * True when the install is out of sync: any installed version is stale,
   * never-synced, carries unwired hooks, or has a broken generated hook runtime,
   * OR a source layer is behind origin.
   * `agents doctor` surfaces it as "run `agents sync status`"; `agents doctor --check`
   * maps it to a non-zero exit. Orphans are a `prune` concern, not sync drift, so they do
   * NOT set this flag (mirrors the sync-status engine: an orphan alone never
   * flags needsSync).
   */
  hasDrift: boolean;
}

/**
 * Compute the same drift/divergence diagnostic `agents doctor` prints, reduced
 * to a summary with a single `hasDrift` boolean. The gate `agents doctor --check`
 * maps to an exit code; the readout `agents doctor` renders in full.
 */
export function computeDrift(cwd: string): DriftSummary {
  const syncRows = checkSyncStatus(cwd);
  const orphanRows = countOrphans();
  const staleCount = syncRows.filter((r) => r.status === 'stale').length;
  const neverSyncedCount = syncRows.filter((r) => r.status === 'never-synced').length;
  const unwiredHookVersions = syncRows.filter((r) => (r.unwiredHooks ?? 0) > 0).length;
  const brokenHookRuntimeVersions = syncRows.filter((r) => (r.brokenHookRuntime ?? 0) > 0).length;
  const sourceBehind = computeSourceBehind();
  return {
    syncRows,
    orphanRows,
    staleCount,
    neverSyncedCount,
    orphanVersionCount: orphanRows.length,
    unwiredHookVersions,
    brokenHookRuntimeVersions,
    sourceBehind,
    hasDrift:
      syncRows.some((r) => r.status !== 'fresh') ||
      unwiredHookVersions > 0 ||
      brokenHookRuntimeVersions > 0 ||
      sourceBehind.length > 0,
  };
}
