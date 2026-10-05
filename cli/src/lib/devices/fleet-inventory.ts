/** Build the self-reported harness inventory a device emits in `doctor --json` for divergence
 * detection (RUSH-2027). Separate from the pure {@link ../devices/fleet-divergence.js} because it
 * reads the live install; one {@link FleetInventory} serves the baseline and every remote box. */

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

/** Probe every installed version's sign-in per agent via its own home's account. A logout is
 * provable only for inspectable agents (`supportsAccountInspection`); a version sharing the global
 * login (`active`) is signed in. Pure reads, no network or keychain prompt. */
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
          // Provable logout: the agent is inspectable and the credential is absent from both the
          // version home and the active/global HOME. Opaque/keychain-only agents and shared global
          // logins never qualify.
          let provable = false;
          // Logout is provable only when known locations lack credentials in both version and active/global homes.
          if (!signedIn && supportsAccountInspection(agent)) {
            const presence = credentialPresence(agent, home);
            // `knownLocation` is load-bearing: an agent can be inspectable yet have no credential
            // path (cursor), so both probes are false only because there is nothing to look for.
            // Treating that as a provable logout prints a CRITICAL for a signed-in version.
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

/** Collect this machine's inventory: installed resources per kind, version ids per agent,
 * `.agents`/`.system` repo state, and per-version sign-in. Pure reads. `promptcuts` (one
 * present/absent bit) is surfaced as a one-element list so it compares like any named resource. */
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
