
import { getAvailableResources, getVersionHomePath, isVersionIsolated, listInstalledVersions } from '../installations/versions.js';
import { supports } from '../capabilities.js';
import { checkVersionHookWiring } from '../hooks/install.js';
import { getUserAgentsDir, getSystemAgentsDir, readMeta } from '../state.js';
import { findNativeAccountByIdentity } from '../account-registry.js';
import { readRepoState } from '../git.js';
import {
  ALL_AGENT_IDS,
  accountDisplayLabel,
  credentialPresence,
  getAccountInfo,
  supportsAccountInspection,
} from '../agents.js';
import type { AgentId } from '../types.js';
import {
  FLEET_RESOURCE_KINDS,
  type FleetHookRuntimeState,
  type FleetInventory,
  type FleetVersionSignIn,
  type RepoState,
} from './fleet-divergence.js';

function toRepoState(snap: ReturnType<typeof readRepoState>): RepoState | null {
  if (!snap) return null;
  return { branch: snap.branch, head: snap.head, dirty: snap.dirty };
}

export async function collectLocalFleetSignIn(): Promise<Record<string, FleetVersionSignIn[]>> {
  const out: Record<string, FleetVersionSignIn[]> = {};
  await Promise.all(
    ALL_AGENT_IDS.map(async (agent: AgentId) => {
      const versions = listInstalledVersions(agent);
      if (versions.length === 0) return;
      const rows = await Promise.all(
        versions.map(async (version): Promise<FleetVersionSignIn> => {
          const home = getVersionHomePath(agent, version);
          let signedIn = false;
          let account: string | null = null;
          try {
            const info = await getAccountInfo(agent, home);
            signedIn = info.signedIn;
            const display = accountDisplayLabel(info);
            const saved = findNativeAccountByIdentity(readMeta(), agent, info);
            account = (saved ? `${saved.name} · ${display || saved.identityLabel || saved.identityKey}` : display) || null;
          } catch {
          }
          let provable = false;

          if (!signedIn && supportsAccountInspection(agent)) {
            const presence = credentialPresence(agent, home);
            provable = presence.knownLocation && !presence.perVersion && !presence.active;
          }
          return { version, signedIn, account, provable };
        }),
      );
      out[agent] = rows;
    }),
  );
  return out;
}

export async function collectLocalFleetInventory(cwd: string = process.cwd()): Promise<FleetInventory> {
  const available = getAvailableResources(cwd);
  const resources = {} as Record<(typeof FLEET_RESOURCE_KINDS)[number], string[]>;
  for (const kind of FLEET_RESOURCE_KINDS) {
    if (kind === 'promptcuts') {
      resources[kind] = available.promptcuts ? ['promptcuts.yaml'] : [];
    } else if (kind === 'rules') {
      resources[kind] = [...available.memory].sort();
    } else {
      resources[kind] = [...(available[kind] ?? [])].sort();
    }
  }

  const agentVersions: Record<string, string[]> = {};
  const hookRuntime: Record<string, Record<string, FleetHookRuntimeState>> = {};
  for (const agent of ALL_AGENT_IDS) {
    const versions = listInstalledVersions(agent);
    if (versions.length > 0) {
      agentVersions[agent] = [...versions].sort();
      hookRuntime[agent] = Object.fromEntries(versions.map((version) => {
        const eligible = supports(agent, 'hooks', version).ok && !isVersionIsolated(agent, version);
        if (!eligible) return [version, 'not-applicable'];
        const state: FleetHookRuntimeState = checkVersionHookWiring(agent, version).runtimeBroken.length > 0
          ? 'broken'
          : 'healthy';
        return [version, state];
      }));
    }
  }

  return {
    resources,
    agentVersions,
    repos: {
      agents: toRepoState(readRepoState(getUserAgentsDir())),
      system: toRepoState(readRepoState(getSystemAgentsDir())),
    },
    signIn: await collectLocalFleetSignIn(),
    hookRuntime,
  };
}
