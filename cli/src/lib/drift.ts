/** Shared drift-detection internals for `agents doctor` (overview) and `agents doctor --check` (the
 * scriptable gate): the single source of truth for "is the install out of sync?" (per-version sync
 * status and orphan census). */
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

// Lines naming exactly what is out of sync for a version, plugins first: each divergent plugin
// gets a line with specifics (stale mirror version, invalid manifest, bundled skills/commands
// missing from the mirror). Other kinds collapse to compact counts so the readout stays scannable.
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
  // Every installed version, not just the default: a stale non-default version silently serves
  // outdated or invalid resources and is what `--fix` heals; hiding it let that bug class go
  // unnoticed.
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
      // Hook wiring is independent of manifest staleness: a hook file can match source yet be
      // absent from settings.json and never fire. Surface it for every version, fresh or stale, so
      // the overview and `doctor --check` flag it (claude/droid; others report unsupported).
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
  // Orphan hooks are scripts in the version home that no agents.yaml/hooks.yaml entry registers,
  // so they never fire. Distinct from the source-diff `diffVersionHooks().orphans`, which
  // false-flags valid system-sourced registered hooks.
  for (const { agent, version } of iterHooksCapableVersions()) {
    const dead = listUnmanagedHooksInVersionHome(agent, version);
    if (dead.length > 0) ensure(agent, version).hooks = dead.length;
  }

  return Array.from(byKey.values()).filter((r) => r.commands + r.skills + r.hooks > 0);
}

/** Probe each source layer (user, system, enabled extras) for how far it trails upstream, from the
 * last-fetched remote-tracking ref (no network). A layer behind origin means homes are reconciled
 * against stale truth, a drift signal `agents doctor --check` must fail on. */
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
  /** True when the install is out of sync: any version is stale, never-synced, has unwired hooks or
   * a broken hook runtime, or a source layer is behind origin. `agents doctor` says "run `agents
   * sync status`"; `--check` exits non-zero. Orphans are a `prune` concern and never set it. */
  hasDrift: boolean;
}

/** Compute the same drift/divergence diagnostic `agents doctor` prints, reduced to a summary with
 * one `hasDrift` boolean: the check `doctor --check` maps to an exit code; the full readout is
 * `agents doctor`. */
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
