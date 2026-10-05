/** Resource heal engine: closes the gap between what DotAgents repos define and what is valid in
 * each installed agent home, from the live-home diff (not the staleness manifest). `agents sync`
 * uses mode 'full'; the daemon uses 'safe' (drift reported, not clobbered). Never deletes. */

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

// ─── result shapes ─────────────────────────────────────────────────────────

export interface HealedResource {
  kind: DoctorKind;
  name: string;
  /** Why it was healed: 'missing' (filled) or 'diff' (overwritten / re-pushed). */
  was: DiffStatus;
}

export interface SkippedResource {
  kind: DoctorKind;
  name: string;
  /** 'drift': hand-edited content left untouched in 'safe' mode. 'unreconcilable': heal wrote it
   * but the diff still flags it (a source/home asymmetry, e.g. a hook sidecar the installer
   * omits), surfaced honestly instead of "fixed" every pass. */
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
  /** Bare-name fields stripped from the source plugin.json (e.g. ["skills"]). */
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
  /** 'modified': central diverged from baseline. 'no-baseline': pre-tracking install. */
  reason: 'modified' | 'no-baseline';
}

export interface HealResult {
  versions: VersionHealResult[];
  repairedManifests: ManifestRepairResult[];
  refreshedPlugins: PluginRefreshResult[];
  skippedPlugins: PluginRefreshSkip[];
}

interface HealOptions {
  /** 'full' (agents sync): fix drift + refresh unknown-baseline plugins.
   *  'safe' (daemon): missing + invalid-manifest + unmodified refresh only. */
  mode: 'full' | 'safe';
  /** Resolution cwd. Defaults to the home dir so no project layer is ever
   *  resolved — heal targets the GLOBAL install, never a project. Tests override. */
  cwd?: string;
  /** Scope to one agent; omit to heal every installed agent. */
  agent?: AgentId;
  /** Scope to specific versions of `agent`; omit for all installed versions. */
  versions?: string[];
  /** Compute the plan without writing anything. */
  dryRun?: boolean;
}

// ─── diff → selection mapping ────────────────────────────────────────────────

// Which ResourceSelection key each healable diff kind writes through. `rules`
// re-syncs via the whole-memory channel (not name-scoped); `promptcuts` is not
// version-synced at all, so it is never healed here.
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

/** True when a heal pass made (or would make) any change at all. */
export function healChangedAnything(r: HealResult): boolean {
  return (
    totalHealed(r) > 0 ||
    r.repairedManifests.length > 0 ||
    r.refreshedPlugins.length > 0
  );
}

// ─── central plugin layer (version-independent, runs once per heal) ──────────

/** Strips Claude-invalid bare-name `skills`/`commands` fields from every central plugin's source
 * plugin.json. Safe since Claude auto-discovers both from directories, and a precondition for
 * loading. */
function repairCentralPluginManifests(dryRun = false): ManifestRepairResult[] {
  const out: ManifestRepairResult[] = [];
  for (const p of discoverPlugins()) {
    const manifestPath = path.join(p.root, '.claude-plugin', 'plugin.json');
    const dropped = repairPluginManifestFile(manifestPath, { dryRun });
    if (dropped.length > 0) out.push({ plugin: p.name, droppedFields: dropped });
  }
  return out;
}

/** Fast-forwards central plugins whose `.source` upstream ships a newer version. `allowModified`
 * (full mode) re-pulls regardless; safe mode refreshes only a provably untouched mirror
 * (baseline version equals current) and reports the rest. */
async function refreshStaleCentralPlugins(opts: {
  dryRun?: boolean;
  allowModified: boolean;
}): Promise<{ refreshed: PluginRefreshResult[]; skipped: PluginRefreshSkip[] }> {
  const refreshed: PluginRefreshResult[] = [];
  const skipped: PluginRefreshSkip[] = [];

  for (const p of discoverPlugins()) {
    const info = readPluginSourceInfo(p.root);
    if (!info) continue;
    const upstream = getUpstreamManifestVersion(info); // null for git sources
    if (!upstream) continue;
    const central = p.manifest.version;
    if (compareVersions(upstream, central) <= 0) continue; // central already current

    const baselineKnown = info.version !== undefined;
    const modified = baselineKnown && info.version !== central;

    if (!opts.allowModified) {
      // Safe mode never overwrites a copy it can't prove is pristine.
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

// ─── per-version heal ────────────────────────────────────────────────────────

function healVersion(
  agent: AgentId,
  version: string,
  opts: { cwd: string; includeDrift: boolean; changedPlugins: Set<string>; dryRun?: boolean },
): VersionHealResult {
  const result: VersionHealResult = { agent, version, healed: [], skipped: [] };

  const home = getVersionHomePath(agent, version);
  if (!fs.existsSync(home)) return result;

  // Always resolve against non-project layers: the global version home is never
  // reconciled against per-cwd project resources (they layer in at launch).
  const diffOpts = { cwd: opts.cwd, excludeProject: true } as const;
  const report = diffVersionResources(agent, version, diffOpts);
  const selection: ResourceSelection = {};
  // Resources we attempt to write, tracked so the post-write re-diff can tell
  // "actually fixed" from "writer couldn't satisfy the diff" (no false claims).
  const attempted: HealedResource[] = [];

  for (const rows of Object.values(report.kinds)) {
    for (const row of rows as ResourceDiff[]) {
      const isMissing = row.status === 'missing';
      const isDrift = row.status === 'diff';
      if (!isMissing && !isDrift) continue;
      if (isDrift && !opts.includeDrift) {
        // Ambiguous content drift — could be a deliberate hand-edit. Report it
        // (the daemon notifies); never silently overwrite in safe mode.
        result.skipped.push({ kind: row.kind, name: row.name, reason: 'drift' });
        continue;
      }
      // Rules and knowledge memory are both repaired by a sync of this version: rules via the
      // preset re-composition `selection.memory` drives, memory facts via the unconditional
      // `syncMemoryToVersionHome` fan-out, so memory drift is fixed the same pass (PHNX-3504).
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

  // Plugins are presence-only in the diff, so a stale-but-present mirror never shows as 'diff', yet
  // its central source just changed.
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
    // No write — report the intended fixes as-is.
    result.healed.push(...attempted, ...pluginHealed);
    return result;
  }

  // Explicit selection => bypasses the manifest fast-guard and writes exactly
  // these names (additive; no orphan-sweep), so nothing outside the gap moves.
  syncResourcesToVersion(agent, version, selection, { cwd: opts.cwd });
  result.healed.push(...pluginHealed);

  // Verify: re-diff and only claim resources that actually flipped to ok. Ones
  // still flagged are reported as 'unreconcilable' so repeated runs converge in
  // messaging instead of "fixing" the same item forever.
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

// ─── public entrypoint ────────────────────────────────────────────────────────

/** Runs a heal pass: repairs the central plugin layer once (manifest plus stale refresh), then
 * reconciles every targeted (agent, version) home against its live diff. Returns a full account
 * of what changed, or would under dryRun. */
export async function heal(opts: HealOptions): Promise<HealResult> {
  const cwd = opts.cwd ?? os.homedir();
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

  // Isolated copies are excluded from every sweep: `agents add --isolated` promises no settings
  // carry-over or resource sync, and this engine runs unattended (~30s after daemon start, then
  // every ~6h).
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
