
export type FleetResourceKind =
  | 'commands'
  | 'skills'
  | 'hooks'
  | 'rules'
  | 'mcp'
  | 'permissions'
  | 'subagents'
  | 'plugins'
  | 'promptcuts'
  | 'workflows';

export const FLEET_RESOURCE_KINDS: FleetResourceKind[] = [
  'commands',
  'skills',
  'hooks',
  'rules',
  'mcp',
  'permissions',
  'subagents',
  'plugins',
  'promptcuts',
  'workflows',
];

export interface RepoState {
  branch: string | null;
  head: string | null;
  dirty: boolean;
}

export interface FleetVersionSignIn {
  version: string;
  signedIn: boolean;
  account: string | null;
  provable: boolean;
}

export const FLEET_HOOK_RUNTIME_STATES = ['healthy', 'broken', 'not-applicable'] as const;
export type FleetHookRuntimeState = typeof FLEET_HOOK_RUNTIME_STATES[number];

export interface FleetInventory {
  resources: Record<FleetResourceKind, string[]>;
  agentVersions: Record<string, string[]>;
  repos: {
    agents: RepoState | null;
    system: RepoState | null;
  };
  signIn?: Record<string, FleetVersionSignIn[]>;
  hookRuntime?: Record<string, Record<string, FleetHookRuntimeState>>;
}

export interface DeviceInventory {
  name: string;
  inventory: FleetInventory | null;
}

export type FleetDivergenceKind =
  | 'resource-missing-remote'
  | 'resource-missing-local'
  | 'agent-version-missing-remote'
  | 'agent-version-missing-local'
  | 'repo-drift';

export interface FleetDivergence {
  kind: FleetDivergenceKind;
  device: string;
  category: string;
  name: string;
  message: string;
}

interface FleetDivergenceReport {
  baseline: string;
  divergences: FleetDivergence[];
  comparedDevices: string[];
  skippedDevices: string[];
  hasDivergence: boolean;
}

function sortedUnique(list: string[]): string[] {
  return Array.from(new Set(list)).sort();
}

function repoLabel(repo: 'agents' | 'system'): string {
  return repo === 'agents' ? '.agents' : '.system';
}

interface RepoDrift {
  detail: string;
  blame: 'remote' | 'local';
}

function describeRepoDrift(local: RepoState, remote: RepoState): RepoDrift | null {
  if (local.head && remote.head && local.head !== remote.head) {
    return { detail: `repo diverged: HEAD ${remote.head} != local ${local.head}`, blame: 'remote' };
  }
  if (local.branch !== remote.branch) {
    return {
      detail: `repo diverged: branch ${remote.branch ?? 'detached'} != local ${local.branch ?? 'detached'}`,
      blame: 'remote',
    };
  }
  if (remote.dirty !== local.dirty) {
    return remote.dirty
      ? { detail: 'tree has uncommitted changes', blame: 'remote' }
      : { detail: 'tree has uncommitted changes', blame: 'local' };
  }
  return null;
}

export function compareFleetInventories(
  devices: DeviceInventory[],
  baselineName: string,
): FleetDivergenceReport {
  const baseline = devices.find((d) => d.name === baselineName)?.inventory ?? null;
  const remotes = devices.filter((d) => d.name !== baselineName);
  const comparedDevices: string[] = [];
  const skippedDevices: string[] = [];
  const divergences: FleetDivergence[] = [];
  const localBlamed = new Set<'agents' | 'system'>();

  if (!baseline) {
    for (const d of remotes) skippedDevices.push(d.name);
    return {
      baseline: baselineName,
      divergences: [],
      comparedDevices: [],
      skippedDevices: skippedDevices.sort(),
      hasDivergence: false,
    };
  }

  for (const remote of remotes) {
    if (!remote.inventory) {
      skippedDevices.push(remote.name);
      continue;
    }
    comparedDevices.push(remote.name);
    const inv = remote.inventory;

    for (const kind of FLEET_RESOURCE_KINDS) {
      const localSet = new Set(baseline.resources[kind] ?? []);
      const remoteSet = new Set(inv.resources[kind] ?? []);
      for (const name of sortedUnique(baseline.resources[kind] ?? [])) {
        if (!remoteSet.has(name)) {
          divergences.push({
            kind: 'resource-missing-remote',
            device: remote.name,
            category: kind,
            name,
            message: `${remote.name} is missing ${kind.replace(/s$/, '')} '${name}' (present on ${baselineName})`,
          });
        }
      }
      for (const name of sortedUnique(inv.resources[kind] ?? [])) {
        if (!localSet.has(name)) {
          divergences.push({
            kind: 'resource-missing-local',
            device: remote.name,
            category: kind,
            name,
            message: `${baselineName} is missing ${kind.replace(/s$/, '')} '${name}' (present on ${remote.name})`,
          });
        }
      }
    }

    const agentIds = sortedUnique([
      ...Object.keys(baseline.agentVersions),
      ...Object.keys(inv.agentVersions),
    ]);
    for (const agent of agentIds) {
      const localVers = new Set(baseline.agentVersions[agent] ?? []);
      const remoteVers = new Set(inv.agentVersions[agent] ?? []);
      for (const v of sortedUnique(baseline.agentVersions[agent] ?? [])) {
        if (!remoteVers.has(v)) {
          divergences.push({
            kind: 'agent-version-missing-remote',
            device: remote.name,
            category: agent,
            name: v,
            message: `${remote.name} is missing ${agent}@${v} (installed on ${baselineName})`,
          });
        }
      }
      for (const v of sortedUnique(inv.agentVersions[agent] ?? [])) {
        if (!localVers.has(v)) {
          divergences.push({
            kind: 'agent-version-missing-local',
            device: remote.name,
            category: agent,
            name: v,
            message: `${baselineName} is missing ${agent}@${v} (installed on ${remote.name})`,
          });
        }
      }
    }

    for (const repo of ['agents', 'system'] as const) {
      const localRepo = baseline.repos[repo];
      const remoteRepo = inv.repos[repo];
      if (!localRepo || !remoteRepo) continue;
      const drift = describeRepoDrift(localRepo, remoteRepo);
      if (!drift) continue;
      if (drift.blame === 'local') {
        if (localBlamed.has(repo)) continue;
        localBlamed.add(repo);
        divergences.push({
          kind: 'repo-drift',
          device: baselineName,
          category: repo,
          name: repoLabel(repo),
          message: `${baselineName} ${repoLabel(repo)} ${drift.detail}`,
        });
        continue;
      }
      divergences.push({
        kind: 'repo-drift',
        device: remote.name,
        category: repo,
        name: repoLabel(repo),
        message: `${remote.name} ${repoLabel(repo)} ${drift.detail}`,
      });
    }
  }

  divergences.sort(
    (a, b) =>
      a.device.localeCompare(b.device) ||
      a.kind.localeCompare(b.kind) ||
      a.category.localeCompare(b.category) ||
      a.name.localeCompare(b.name),
  );

  return {
    baseline: baselineName,
    divergences,
    comparedDevices: comparedDevices.sort(),
    skippedDevices: skippedDevices.sort(),
    hasDivergence: divergences.length > 0,
  };
}
