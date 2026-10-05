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

type ResolvedLaunchAccountKind = 'native' | 'provider' | 'legacy-native';

interface ResolvedLaunchAccount {
  kind: ResolvedLaunchAccountKind;
  id: string;
  name: string;
  selector: string;
  key: string;
}

export interface ResolvedLocalAccountLaunch {
  agent: AgentId;
  // Selects the binary only; account identity is resolved independently below.
  executableVersion: string;
  account: ResolvedLaunchAccount | null;
  execHome?: string;
  configVersion?: string;
  env: Record<string, string>;
  signedIn: boolean | null;
  email: string | null;
}

interface ResolveLocalAccountLaunchOptions {
  agent: AgentId;
  executableVersion: string;
  candidate?: RotateCandidate;
  selector?: string;
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

  if (selected && !selector) {
    // Legacy labels locate an exact local home; they are not rediscovered identities.
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
