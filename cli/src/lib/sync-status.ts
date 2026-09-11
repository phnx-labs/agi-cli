/**
 * Unified sync-status engine — the SINGLE source of truth for "is this resource
 * synced to this agent version?" consumed by `agents doctor`, `agents view`, the
 * menu-bar app, and any Agency surface.
 *
 * Why this exists: before this module there were four different notions of
 * "synced" living in four files:
 *   - doctor:  isStale() vs .sync-manifest.json  — catches SOURCE drift only.
 *   - view:    git working-tree state of ~/.agents/ — a resource can show green
 *              while its installed copy is stale/deleted/corrupted (false positive).
 *   - lists:   file-exists-in-home — never reports content drift at all.
 *   - menubar: read doctor --json (so it inherited doctor's source-only blind spot).
 *
 * The reliable signal is diffVersionResources() (src/lib/doctor-diff.ts): it reads
 * the ACTUAL version home and compares it to the resolved sources, so it catches
 * every drift class — source-side changes AND home-side rot (deleted / corrupted /
 * hand-edited installed copies) AND orphans. This module wraps it once, maps its
 * per-resource DiffStatus onto one stable enum, folds in `.system` repo freshness,
 * and lets every surface render the same warnings instead of re-deriving them.
 */

import simpleGit from 'simple-git';
import { AgentId } from './types.js';
import { ALL_AGENT_IDS } from './agents.js';
import {
  diffVersionResources,
  type VersionResourceReport,
  type ResourceDiff,
  type DoctorKind,
  type DiffStatus,
} from './doctor-diff.js';
import { listInstalledVersions, getGlobalDefault } from './installations/versions.js';
import { loadManifest } from './staleness/index.js';
import { getSystemAgentsDir, getUserAgentsDir } from './state.js';
import * as fs from 'fs';
import { isGitRepo, readOriginUrl } from './git.js';
import { detectConfigDrift, type ConfigDrift } from './config-drift.js';

/**
 * One stable status per resource, unified across every surface.
 *  - `synced`  — installed copy matches the resolved source (DiffStatus 'ok').
 *  - `drifted` — installed copy exists but differs from source (DiffStatus 'diff').
 *  - `missing` — source exists, nothing installed in the version home ('missing').
 *  - `orphan`  — installed in the home with no source ('extra'); prune's job, not sync's.
 */
export type ResourceSyncStatus = 'synced' | 'drifted' | 'missing' | 'orphan';

export interface ResourceStatusRow {
  agent: AgentId;
  version: string;
  kind: DoctorKind;
  name: string;
  status: ResourceSyncStatus;
  /** Human-readable specifics for a drifted row (e.g. plugin version delta). */
  detail?: string;
}

export interface AgentVersionStatus {
  agent: AgentId;
  version: string;
  isDefault: boolean;
  /** False = no .sync-manifest.json: this version was never synced (cold). */
  everSynced: boolean;
  counts: { synced: number; drifted: number; missing: number; orphan: number };
  /** drifted + missing > 0 — a real reconcile is owed. Orphans do NOT set this
   * (heal never deletes; orphan removal is `agents prune cleanup`). */
  needsSync: boolean;
  resources: ResourceStatusRow[];
}

export interface SystemRepoStatus {
  dir: string;
  /** Commits the local `.system` checkout is behind its tracking branch, as of
   * the last background fetch (no network is performed here). 0 = up to date. */
  behind: number;
  ahead: number;
  branch: string | null;
  /** True when the dir isn't a git repo or has no upstream — behind is unknown. */
  unknown: boolean;
}

export interface UserRepoStatus {
  dir: string;
  /**
   * True when `~/.agents` exists but is not a git repo (or is a repo with no
   * `origin`) — a partial install `agents repo sync user` will adopt in place
   * (PHNX-3301). A DISTINCT drift state, not a per-agent "N missing" count.
   */
  notGitRepo: boolean;
}

export interface UnifiedSyncStatus {
  system: SystemRepoStatus;
  user: UserRepoStatus;
  /** Config drift: has this box drained its device-scoped state, or is it still
   *  carrying per-box state in the shared top-level agents.yaml? (PHNX-3315) */
  config: ConfigDrift;
  agents: AgentVersionStatus[];
  totals: {
    drifted: number;
    missing: number;
    orphan: number;
    /** Versions with a manifest that are behind on content. */
    versionsNeedingSync: number;
    /** Versions that were never synced at all. */
    versionsNeverSynced: number;
    /** Distinct agent ids that own at least one version needing sync. */
    agentsNeedingSync: number;
  };
}

/**
 * Residual drift for a single (agent, version) after a reconcile — the drifted
 * and missing rows that a sync claimed to fix but did not. `orphan` rows are
 * deliberately excluded: sync never removes them (that is `agents prune`'s job),
 * so they are not "unfinished sync". Empty `drifted`+`missing` ⇒ converged.
 */
export interface ResidualDrift {
  agent: AgentId;
  version: string;
  rows: ResourceStatusRow[];
}

/**
 * Re-check that a version's home now matches its resolved sources after a
 * reconcile. This is the post-write verification the `agents sync` success line
 * depends on (PHNX-3186): the exit line must not read "reconciled" while drift
 * it was asked to fix stays put. Resolves against non-project layers only
 * (`excludeProject: true`), mirroring what the sync writer targets. Returns null
 * when the version converged (no drifted/missing), else the residual rows.
 */
export function verifyVersionConverged(
  agent: AgentId,
  version: string,
  cwd: string = process.cwd(),
): ResidualDrift | null {
  const report = diffVersionResources(agent, version, { cwd, excludeProject: true });
  const rows = rowsFromReport(agent, version, report)
    .filter((r) => r.status === 'drifted' || r.status === 'missing');
  if (rows.length === 0) return null;
  return { agent, version, rows };
}

/** One-line-per-resource description of residual drift, for the sync exit line. */
export function formatResidualDrift(residual: ResidualDrift[]): string[] {
  const lines: string[] = [];
  for (const r of residual) {
    for (const row of r.rows) {
      const detail = row.detail ? ` (${row.detail})` : '';
      lines.push(`${r.agent}@${r.version}: ${row.status} ${row.kind} '${row.name}'${detail}`);
    }
  }
  return lines;
}

/**
 * The rows behind a "N drifted" count, one line each, for the human renderers.
 * A count alone cannot be acted on; the name says which skill or hook to look
 * at, and `detail` says what differs when the differ knows.
 */
export function formatDriftRows(v: AgentVersionStatus): string[] {
  return v.resources
    .filter((r) => r.status === 'drifted' || r.status === 'missing')
    .sort((a, b) => a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name))
    .map((r) => `${r.status.padEnd(7)} ${r.kind}/${r.name}${r.detail ? ` (${r.detail})` : ''}`);
}

const STATUS_MAP: Record<DiffStatus, ResourceSyncStatus> = {
  ok: 'synced',
  diff: 'drifted',
  missing: 'missing',
  extra: 'orphan',
};

function rowsFromReport(
  agent: AgentId,
  version: string,
  report: VersionResourceReport,
): ResourceStatusRow[] {
  const out: ResourceStatusRow[] = [];
  for (const list of Object.values(report.kinds) as ResourceDiff[][]) {
    for (const r of list) {
      out.push({
        agent,
        version,
        kind: r.kind,
        name: r.name,
        status: STATUS_MAP[r.status],
        ...(r.detail ? { detail: r.detail } : {}),
      });
    }
  }
  return out;
}

export interface SyncStatusOptions {
  cwd?: string;
  /** Restrict to specific agent ids; undefined = every supported agent. */
  agents?: AgentId[];
  /** Restrict to specific resource kinds; undefined = all. */
  kinds?: DoctorKind[];
}

/**
 * Read `.system` repo freshness WITHOUT touching the network. `git status`
 * reports ahead/behind against the remote-tracking ref, which the detached
 * auto-pull worker keeps warm via periodic `git fetch`. This is the same number
 * the menu-bar surfaces; we read it once, here, so every surface agrees.
 */
export async function getSystemRepoStatus(): Promise<SystemRepoStatus> {
  const dir = getSystemAgentsDir();
  const base: SystemRepoStatus = { dir, behind: 0, ahead: 0, branch: null, unknown: true };
  if (!isGitRepo(dir)) return base;
  try {
    const status = await simpleGit(dir).status();
    return {
      dir,
      behind: status.behind ?? 0,
      ahead: status.ahead ?? 0,
      branch: status.tracking ?? status.current ?? null,
      // Without a tracking branch there's no upstream to compare against.
      unknown: !status.tracking,
    };
  } catch {
    return base;
  }
}

/**
 * Detect whether `~/.agents` (the user config layer) is git-backed. A partial
 * install — runtime state present but no `.git` (or no `origin`) — is a distinct
 * drift state that `agents repo sync user` heals by adopting in place (PHNX-3301),
 * surfaced separately from per-version resource gaps. Purely local; no network.
 */
export async function getUserRepoStatus(): Promise<UserRepoStatus> {
  const dir = getUserAgentsDir();
  if (!fs.existsSync(dir)) return { dir, notGitRepo: false };
  if (!isGitRepo(dir)) return { dir, notGitRepo: true };
  // A repo with no `origin` is just as partial for adopt's purposes — reuse the
  // single origin-URL reader rather than a second remote check.
  return { dir, notGitRepo: readOriginUrl(dir) === null };
}

/**
 * Compute unified sync status across the fleet. Resolves against non-project
 * layers only (`excludeProject: true`) — the GLOBAL version home is never
 * reconciled against per-cwd `<cwd>/.agents/` resources, so counting them as
 * "missing" there would be a false gap (matches doctor's overview semantics).
 */
export async function computeSyncStatus(
  options: SyncStatusOptions = {},
): Promise<UnifiedSyncStatus> {
  const cwd = options.cwd ?? process.cwd();
  const agentIds = options.agents ?? ALL_AGENT_IDS;

  const agents: AgentVersionStatus[] = [];
  for (const agent of agentIds) {
    const def = getGlobalDefault(agent);
    for (const version of listInstalledVersions(agent)) {
      const report = diffVersionResources(agent, version, {
        cwd,
        excludeProject: true,
        ...(options.kinds ? { kinds: options.kinds } : {}),
      });
      const resources = rowsFromReport(agent, version, report);
      const counts = { synced: 0, drifted: 0, missing: 0, orphan: 0 };
      for (const r of resources) counts[r.status]++;
      agents.push({
        agent,
        version,
        isDefault: version === def,
        everSynced: loadManifest(agent, version) !== null,
        counts,
        needsSync: counts.drifted + counts.missing > 0,
        resources,
      });
    }
  }

  const system = await getSystemRepoStatus();
  const user = await getUserRepoStatus();
  const config = detectConfigDrift();

  const agentsNeedingSync = new Set<AgentId>();
  let drifted = 0, missing = 0, orphan = 0, versionsNeedingSync = 0, versionsNeverSynced = 0;
  for (const v of agents) {
    drifted += v.counts.drifted;
    missing += v.counts.missing;
    orphan += v.counts.orphan;
    if (!v.everSynced) versionsNeverSynced++;
    if (v.needsSync) {
      versionsNeedingSync++;
      agentsNeedingSync.add(v.agent);
    }
  }

  return {
    system,
    user,
    config,
    agents,
    totals: {
      drifted,
      missing,
      orphan,
      versionsNeedingSync,
      versionsNeverSynced,
      agentsNeedingSync: agentsNeedingSync.size,
    },
  };
}
