// Check every installed version: hook wiring/runtime and source-behind are drift even with fresh manifests; orphans stay informational.
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
  divergence?: string[];
  unwiredHooks?: number;
  brokenHookRuntime?: number;
}

export interface OrphanRow {
  agent: AgentId;
  version: string;
  commands: number;
  skills: number;
  hooks: number;
}

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
        const report = diffVersionResources(agent, version, { cwd, excludeProject: true });
        divergence.push(...divergenceLines(report));
      }
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
  for (const { agent, version } of iterHooksCapableVersions()) {
    const dead = listUnmanagedHooksInVersionHome(agent, version);
    if (dead.length > 0) ensure(agent, version).hooks = dead.length;
  }

  return Array.from(byKey.values()).filter((r) => r.commands + r.skills + r.hooks > 0);
}

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
  staleCount: number;
  neverSyncedCount: number;
  orphanVersionCount: number;
  unwiredHookVersions: number;
  brokenHookRuntimeVersions: number;
  sourceBehind: SourceLayerBehind[];
  hasDrift: boolean;
}

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
