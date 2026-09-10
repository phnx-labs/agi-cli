/**
 * Canonical target-local account launch resolution (PHNX-3940).
 *
 * Callers may carry a selector or a {@link RotateCandidate} across a routing
 * boundary. This module resolves that intent on the machine that will spawn the
 * harness, where account slots and credential stores actually live. The result
 * is deliberately local-only: `execHome` and `env` must never cross SSH or be
 * written to events.
 */
import * as fs from 'node:fs';
import { resolveSpawnAccount, type SpawnAccount } from '../account-registry.js';
import {
  adoptedConfigPointsAtHome,
  adoptedSymlinkMismatchError,
  durableSlotEnv,
  isSymlinkAdoptedHarness,
  resolveNativeSpawnHome,
  symlinkAdoptedAccountError,
} from '../exec-account-home.js';
import { getVersionHomePath } from '../installations/versions.js';
import { readMeta } from '../state.js';
import type { AgentId, Meta } from '../types.js';
import { candidateAccountKey, type RotateCandidate } from './rotate.js';

export type ResolvedLaunchAccountKind = 'native' | 'provider' | 'legacy-native';

/** Safe account identity that may be passed between launch consumers. */
export interface ResolvedLaunchAccount {
  kind: ResolvedLaunchAccountKind;
  /** Stable registry id, or the durable identity key for an unmigrated login. */
  id: string;
  /** User-facing account name, falling back to the durable identity label. */
  name: string;
  /** Selector another device may resolve against its own registry. */
  selector: string;
  /** Stable anti-collision/failover key; never derived from the binary label. */
  key: string;
}

/**
 * One fully-resolved spawn attempt. `env` may contain credential material and
 * `execHome` is a device-local path, so this type is confined to the local exec
 * boundary. Events and remote callers use {@link ResolvedLaunchAccount} only.
 */
export interface ResolvedLocalAccountLaunch {
  agent: AgentId;
  executableVersion: string;
  account: ResolvedLaunchAccount | null;
  execHome?: string;
  /** Compatibility label for an explicitly recorded, unmigrated home. */
  configVersion?: string;
  env: Record<string, string>;
  signedIn: boolean | null;
  email: string | null;
}

export interface ResolveLocalAccountLaunchOptions {
  agent: AgentId;
  /** Selects the executable only. It never chooses account state. */
  executableVersion: string;
  /** Exact account candidate selected by strategy/picker/readiness. */
  candidate?: RotateCandidate;
  /** Explicit account name/id (`--account`, `#name`, or a consumer intent). */
  selector?: string;
  /** Resolve the harness default when no explicit selector/candidate exists. */
  useDefault?: boolean;
  provider?: string;
  target?: string;
  meta?: Pick<Meta, 'accounts' | 'deviceAccounts'>;
}

function launchAccountFromSpawn(account: SpawnAccount): ResolvedLaunchAccount {
  return {
    kind: account.kind,
    id: account.id,
    name: account.name,
    selector: account.name,
    key: `${account.kind}:${account.id}`,
  };
}

function candidateSelector(candidate: RotateCandidate): string | undefined {
  return candidate.nativeAccount ?? candidate.providerAccount;
}

function legacyAccount(candidate: RotateCandidate): ResolvedLaunchAccount {
  const key = candidateAccountKey(candidate);
  const name = candidate.accountLabel || candidate.email || key;
  return {
    kind: 'legacy-native',
    id: candidate.accountKey ?? candidate.email ?? key,
    name,
    selector: candidate.email ?? candidate.accountKey ?? name,
    key,
  };
}

/**
 * Resolve one account-specific attempt at the local spawn boundary.
 *
 * Native selections resolve the registered slot and harness-specific home;
 * provider selections materialize their credential env exactly here. An
 * unmigrated version-home candidate remains a compatibility case, but it is
 * never rediscovered by scanning homes for identity.
 */
export async function resolveLocalAccountLaunch(
  options: ResolveLocalAccountLaunchOptions,
): Promise<ResolvedLocalAccountLaunch> {
  const meta = options.meta ?? readMeta();
  const selected = options.candidate;
  const selector = options.selector ?? (selected ? candidateSelector(selected) : undefined);

  // Compatibility for a candidate already discovered in an unmigrated home.
  // The candidate is the identity decision; the label only locates that exact
  // local config home and never participates in account comparison.
  if (selected && !selector) {
    const execHome = getVersionHomePath(options.agent, selected.version);
    if (!fs.existsSync(execHome)) {
      throw new Error(`${selected.accountLabel || options.agent} has no local account home at ${execHome}.`);
    }
    return {
      agent: options.agent,
      executableVersion: options.executableVersion,
      account: legacyAccount(selected),
      execHome,
      configVersion: selected.version,
      env: {},
      signedIn: selected.signedIn,
      email: selected.email,
    };
  }

  const spawnAccount = resolveSpawnAccount(
    selector,
    options.agent,
    options.executableVersion,
    meta,
    {
      useDefault: options.useDefault,
      provider: options.provider,
      target: options.target,
    },
  );
  if (!spawnAccount) {
    return {
      agent: options.agent,
      executableVersion: options.executableVersion,
      account: null,
      env: {},
      signedIn: selected?.signedIn ?? null,
      email: selected?.email ?? null,
    };
  }

  const account = launchAccountFromSpawn(spawnAccount);
  if (spawnAccount.kind === 'provider') {
    return {
      agent: options.agent,
      executableVersion: options.executableVersion,
      account,
      env: spawnAccount.env,
      signedIn: selected?.signedIn ?? true,
      email: selected?.email ?? null,
    };
  }

  if (isSymlinkAdoptedHarness(options.agent)) {
    const defaultName = meta.accounts?.defaults?.[options.agent];
    if (spawnAccount.name !== defaultName) {
      throw new Error(symlinkAdoptedAccountError(options.agent, spawnAccount.name, defaultName));
    }
  }
  const home = await resolveNativeSpawnHome(options.agent, spawnAccount, meta);
  if (isSymlinkAdoptedHarness(options.agent)
      && !adoptedConfigPointsAtHome(options.agent, home.execHome)) {
    throw new Error(adoptedSymlinkMismatchError(options.agent, spawnAccount.name, home.execHome));
  }
  return {
    agent: options.agent,
    executableVersion: options.executableVersion,
    account,
    execHome: home.execHome,
    configVersion: home.source === 'legacy-home' ? home.label : undefined,
    env: durableSlotEnv(options.agent, spawnAccount, home, meta),
    signedIn: selected?.signedIn ?? null,
    email: selected?.email ?? null,
  };
}
