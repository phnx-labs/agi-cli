
import { ALL_AGENT_IDS } from './agents.js';
import type { AgentId } from './types.js';
import {
  syncResourcesToVersion,
  listInstalledVersions,
  isVersionIsolated,
  getVersionHomePath,
  getActuallySyncedResources,
  compareVersions,
  type ResourceSelection,
} from './installations/versions.js';
import {
  diffVersionResources,
  type DoctorKind,
  type DiffStatus,
  type ResourceDiff,
} from './doctor-diff.js';
import {
  discoverPlugins,
  updatePlugin,
  readPluginSourceInfo,
  getUpstreamManifestVersion,
} from './plugins/plugins.js';
import { repairPluginManifestFile } from './plugins/plugin-marketplace.js';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';


export interface HealedResource {
  kind: DoctorKind;
  name: string;
  was: DiffStatus;
}

export interface SkippedResource {
  kind: DoctorKind;
  name: string;
  reason: 'drift' | 'unreconcilable';
}

export interface VersionHealResult {
  agent: AgentId;
  version: string;
  healed: HealedResource[];
  skipped: SkippedResource[];
}

export interface ManifestRepairResult {
  plugin: string;
  droppedFields: string[];
}

export interface PluginRefreshResult {
  plugin: string;
  from: string;
  to: string;
}

export interface PluginRefreshSkip {
  plugin: string;
  from: string;
  upstream: string;
  reason: 'modified' | 'no-baseline';
}

export interface HealResult {
  versions: VersionHealResult[];
  repairedManifests: ManifestRepairResult[];
  refreshedPlugins: PluginRefreshResult[];
  skippedPlugins: PluginRefreshSkip[];
}

interface HealOptions {
  mode: 'full' | 'safe';
  cwd?: string;
  agent?: AgentId;
  versions?: string[];
  dryRun?: boolean;
}


const KIND_TO_SELECTION: Partial<Record<DoctorKind, keyof ResourceSelection>> = {
  commands: 'commands',
  skills: 'skills',
  hooks: 'hooks',
  mcp: 'mcp',
  permissions: 'permissions',
  subagents: 'subagents',
  plugins: 'plugins',
  workflows: 'workflows',
};

function totalHealed(r: HealResult): number {
  return r.versions.reduce((n, v) => n + v.healed.length, 0);
}

export function healChangedAnything(r: HealResult): boolean {
  return (
    totalHealed(r) > 0 ||
    r.repairedManifests.length > 0 ||
    r.refreshedPlugins.length > 0
  );
}


function repairCentralPluginManifests(dryRun = false): ManifestRepairResult[] {
  const out: ManifestRepairResult[] = [];
  for (const p of discoverPlugins()) {
    const manifestPath = path.join(p.root, '.claude-plugin', 'plugin.json');
    const dropped = repairPluginManifestFile(manifestPath, { dryRun });
    if (dropped.length > 0) out.push({ plugin: p.name, droppedFields: dropped });
  }
  return out;
}

async function refreshStaleCentralPlugins(opts: {
  dryRun?: boolean;
  allowModified: boolean;
}): Promise<{ refreshed: PluginRefreshResult[]; skipped: PluginRefreshSkip[] }> {
  const refreshed: PluginRefreshResult[] = [];
  const skipped: PluginRefreshSkip[] = [];

  for (const p of discoverPlugins()) {
    const info = readPluginSourceInfo(p.root);
    if (!info) continue;
    const upstream = getUpstreamManifestVersion(info);
    if (!upstream) continue;
    const central = p.manifest.version;
    if (compareVersions(upstream, central) <= 0) continue;

    const baselineKnown = info.version !== undefined;
    const modified = baselineKnown && info.version !== central;

    if (!opts.allowModified) {
      if (modified) {
        skipped.push({ plugin: p.name, from: central, upstream, reason: 'modified' });
        continue;
      }
      if (!baselineKnown) {
        skipped.push({ plugin: p.name, from: central, upstream, reason: 'no-baseline' });
        continue;
      }
    }

    if (opts.dryRun) {
      refreshed.push({ plugin: p.name, from: central, to: upstream });
      continue;
    }
    const r = await updatePlugin(p.name);
    if (r.success) refreshed.push({ plugin: p.name, from: central, to: upstream });
  }

  return { refreshed, skipped };
}


function healVersion(
  agent: AgentId,
  version: string,
  opts: { cwd: string; includeDrift: boolean; changedPlugins: Set<string>; dryRun?: boolean },
): VersionHealResult {
  const result: VersionHealResult = { agent, version, healed: [], skipped: [] };

  const home = getVersionHomePath(agent, version);
  if (!fs.existsSync(home)) return result;

  // Compare live non-project homes; rules and memory intentionally share whole-memory sync.
  const diffOpts = { cwd: opts.cwd, excludeProject: true } as const;
  const report = diffVersionResources(agent, version, diffOpts);
  const selection: ResourceSelection = {};
  const attempted: HealedResource[] = [];

  for (const rows of Object.values(report.kinds)) {
    for (const row of rows as ResourceDiff[]) {
      const isMissing = row.status === 'missing';
      const isDrift = row.status === 'diff';
      if (!isMissing && !isDrift) continue;
      if (isDrift && !opts.includeDrift) {
        result.skipped.push({ kind: row.kind, name: row.name, reason: 'drift' });
        continue;
      }
      if (row.kind === 'rules' || row.kind === 'memory') {
        selection.memory = 'all';
        attempted.push({ kind: row.kind, name: row.name, was: row.status });
        continue;
      }
      const key = KIND_TO_SELECTION[row.kind];
      if (!key) continue;
      ((selection[key] ??= []) as string[]).push(row.name);
      attempted.push({ kind: row.kind, name: row.name, was: row.status });
    }
  }

  // Re-push changed plugins only where they are already installed.
  const pluginHealed: HealedResource[] = [];
  if (opts.changedPlugins.size > 0) {
    const synced = new Set(getActuallySyncedResources(agent, version, diffOpts).plugins);
    const already = new Set((selection.plugins as string[] | undefined) ?? []);
    for (const name of opts.changedPlugins) {
      if (!synced.has(name) || already.has(name)) continue;
      ((selection.plugins ??= []) as string[]).push(name);
      pluginHealed.push({ kind: 'plugins', name, was: 'diff' });
    }
  }

  const hasWork = Object.keys(selection).length > 0;
  if (!hasWork) return result;

  if (opts.dryRun) {
    result.healed.push(...attempted, ...pluginHealed);
    return result;
  }

  syncResourcesToVersion(agent, version, selection, { cwd: opts.cwd });
  result.healed.push(...pluginHealed);

  // Re-diff before claiming that a repair succeeded.
  const post = diffVersionResources(agent, version, diffOpts);
  const stillBad = new Set<string>();
  for (const rows of Object.values(post.kinds)) {
    for (const row of rows as ResourceDiff[]) {
      if (row.status === 'missing' || row.status === 'diff') stillBad.add(`${row.kind}:${row.name}`);
    }
  }
  for (const a of attempted) {
    if (stillBad.has(`${a.kind}:${a.name}`)) {
      result.skipped.push({ kind: a.kind, name: a.name, reason: 'unreconcilable' });
    } else {
      result.healed.push(a);
    }
  }

  return result;
}


export async function heal(opts: HealOptions): Promise<HealResult> {
  const cwd = opts.cwd ?? os.homedir();
  // Full sync may overwrite drift; unattended safe heal fills unambiguous gaps and never deletes.
  const full = opts.mode === 'full';

  const repairedManifests = repairCentralPluginManifests(opts.dryRun);
  const { refreshed, skipped: skippedPlugins } = await refreshStaleCentralPlugins({
    dryRun: opts.dryRun,
    allowModified: full,
  });
  const changedPlugins = new Set<string>([
    ...repairedManifests.map((r) => r.plugin),
    ...refreshed.map((r) => r.plugin),
  ]);

  // Sweeps exclude isolated versions; explicitly naming a version is operator consent.
  const sweep = (a: AgentId) => listInstalledVersions(a).filter((v) => !isVersionIsolated(a, v));
  const targets: Array<{ agent: AgentId; versions: string[] }> = opts.agent
    ? [{ agent: opts.agent, versions: opts.versions ?? sweep(opts.agent) }]
    : ALL_AGENT_IDS.map((a) => ({ agent: a, versions: sweep(a) }));

  const versions: VersionHealResult[] = [];
  for (const t of targets) {
    for (const v of t.versions) {
      versions.push(
        healVersion(t.agent, v, { cwd, includeDrift: full, changedPlugins, dryRun: opts.dryRun }),
      );
    }
  }

  return { versions, repairedManifests, refreshedPlugins: refreshed, skippedPlugins };
}
