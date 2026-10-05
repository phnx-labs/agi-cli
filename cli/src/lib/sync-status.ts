
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

type ResourceSyncStatus = 'synced' | 'drifted' | 'missing' | 'orphan';

export interface ResourceStatusRow {
  agent: AgentId;
  version: string;
  kind: DoctorKind;
  name: string;
  status: ResourceSyncStatus;
  detail?: string;
}

export interface AgentVersionStatus {
  agent: AgentId;
  version: string;
  isDefault: boolean;
  everSynced: boolean;
  counts: { synced: number; drifted: number; missing: number; orphan: number };
  needsSync: boolean;
  resources: ResourceStatusRow[];
}

export interface SystemRepoStatus {
  dir: string;
  behind: number;
  ahead: number;
  branch: string | null;
  unknown: boolean;
}

export interface UserRepoStatus {
  dir: string;
  notGitRepo: boolean;
}

export interface UnifiedSyncStatus {
  system: SystemRepoStatus;
  user: UserRepoStatus;
  config: ConfigDrift;
  agents: AgentVersionStatus[];
  totals: {
    drifted: number;
    missing: number;
    orphan: number;
    versionsNeedingSync: number;
    versionsNeverSynced: number;
    agentsNeedingSync: number;
  };
}

export interface ResidualDrift {
  agent: AgentId;
  version: string;
  rows: ResourceStatusRow[];
}

export function verifyVersionConverged(
  agent: AgentId,
  version: string,
  cwd: string = process.cwd(),
): ResidualDrift | null {
  // Convergence comes from a post-write live-home diff, not manifest or file-presence claims.
  const report = diffVersionResources(agent, version, { cwd, excludeProject: true });
  const rows = rowsFromReport(agent, version, report)
    .filter((r) => r.status === 'drifted' || r.status === 'missing');
  if (rows.length === 0) return null;
  return { agent, version, rows };
}

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

interface SyncStatusOptions {
  cwd?: string;
  agents?: AgentId[];
  kinds?: DoctorKind[];
}

async function getSystemRepoStatus(): Promise<SystemRepoStatus> {
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
      unknown: !status.tracking,
    };
  } catch {
    return base;
  }
}

async function getUserRepoStatus(): Promise<UserRepoStatus> {
  const dir = getUserAgentsDir();
  if (!fs.existsSync(dir)) return { dir, notGitRepo: false };
  if (!isGitRepo(dir)) return { dir, notGitRepo: true };
  return { dir, notGitRepo: readOriginUrl(dir) === null };
}

export async function computeSyncStatus(
  options: SyncStatusOptions = {},
): Promise<UnifiedSyncStatus> {
  const cwd = options.cwd ?? process.cwd();
  const agentIds = options.agents ?? ALL_AGENT_IDS;

  const agents: AgentVersionStatus[] = [];
  for (const agent of agentIds) {
    const def = getGlobalDefault(agent);
    for (const version of listInstalledVersions(agent)) {
      // The actual non-project version-home diff is the source of truth.
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
        // Orphans are prune-owned; only drift and missing resources request sync.
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
