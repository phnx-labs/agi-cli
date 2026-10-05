import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { AgentId, Meta, NativeAccountWorkerCredential } from '../types.js';
import { AGENT_IDS } from '../types.js';
import { nativeAccountCapability, nativeAccountNamingRefusal, nativeIdentityKey } from '../account-capabilities.js';
import { getAccountProvider } from '../account-provider-registry.js';
import { listNativeAccounts, type NativeAccount } from '../account-registry.js';
import { harnessAuth, harnessWorkerKinds, LOGIN_INVOCATIONS, type LoginInvocation } from '../harness-auth-capabilities.js';
import { isHeadedDeviceRole, selfConfiguredDeviceRole } from '../device-config.js';
import { machineId } from '../machine-id.js';
import { readMeta, updateMeta } from '../state.js';
import { ambientClaudeToken, loginHint } from '../signin-badge.js';
import { acquireAuthOperationLock, type AuthOperationLock } from './auth-operation-lock.js';
import { ensureSlot, readSlots, recordSlot, slotDir, type DeviceAccountSlot } from './slots.js';

export type { LoginInvocation };
export { LOGIN_INVOCATIONS };


const PROVIDER_AUTH_ENV_KEYS = [
  'ANTHROPIC_API_KEY',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'ANTHROPIC_AUTH_TOKEN',
  'OPENAI_API_KEY',
  'CODEX_API_KEY',
  'XAI_API_KEY',
  'CURSOR_API_KEY',
  'FACTORY_API_KEY',
] as const;

export function workerApiKeyEnv(agent: AgentId): string | null {
  for (const kind of harnessWorkerKinds(agent)) {
    if (!kind.startsWith('api-key:')) continue;
    const env = kind.slice('api-key:'.length);
    if (env !== 'provider') return env;
    try {
      return getAccountProvider(agent).envFor(agent, 'api-key');
    } catch {
      return null;
    }
  }
  return null;
}

function hasPortableWorkerKind(agent: AgentId): boolean {
  return harnessWorkerKinds(agent).some((k) => k === 'setup-token' || k.startsWith('api-key:'));
}

function hasPerDeviceWorkerKind(agent: AgentId): boolean {
  return harnessWorkerKinds(agent).some((k) => k.startsWith('per-device'));
}

function perDeviceRefusal(agent: AgentId): string {
  return `--per-device is only valid for a harness with a per-device worker path; ${agent} is provisioned from ${workerProvisioningHint(agent)}.`;
}

export function addSupported(agent: AgentId): boolean {
  const cap = nativeAccountCapability(agent);
  return cap.scope === 'version' && harnessAuth(agent).login !== null;
}

export function workerProvisioningHint(agent: AgentId): string {
  const parts: string[] = [];
  for (const kind of harnessWorkerKinds(agent)) {
    if (kind === 'setup-token') parts.push('a setup-token minted during add');
    else if (kind.startsWith('api-key:')) {
      const env = kind.slice('api-key:'.length);
      parts.push(env === 'provider' ? 'a provider API key collected by add (--api-key)' : `the ${env} collected by add (--api-key)`);
    } else if (kind.startsWith('per-device')) {
      parts.push(`per-device login on each worker (--per-device; run \`agents run ${agent} --device <box>\` there and complete its native login)`);
    }
  }
  if (parts.length === 0) return `${agent} has no portable credential — it logs in per box (run \`agents run ${agent} --device <box>\` on the worker and complete its native login)`;
  return parts.join(', or ');
}

export function addRefusal(agent: AgentId): string | null {
  const capabilityRefusal = nativeAccountNamingRefusal(agent);
  if (capabilityRefusal) return capabilityRefusal;
  const cap = nativeAccountCapability(agent);
  if (cap.scope !== 'version') {
    return `${agent} authentication is ${cap.scope}-scoped; accounts add creates per-account slots, which needs a version-scoped login.`;
  }
  if (!harnessAuth(agent).login) {
    const supported = supportedAddHarnesses().join(', ');
    return `${agent} has no finite login command — ${workerProvisioningHint(agent)}. accounts add drives: ${supported}.`;
  }
  return null;
}

export function supportedAddHarnesses(): AgentId[] {
  return AGENT_IDS.filter(addSupported).sort();
}

export function assertAddSupported(agent: AgentId): void {
  const reason = addRefusal(agent);
  if (reason) throw new Error(reason);
}

export function addWorkerRefusal(agent: AgentId, name?: string): string | null {
  const role = selfConfiguredDeviceRole();
  if (isHeadedDeviceRole(role)) return null;
  const device = machineId();
  const roleLabel = role ?? 'unmarked';
  const selector = name ? `${agent}#${name}` : agent;
  const addCmd = name ? `agents accounts add ${agent} ${name}` : `agents accounts add ${agent} <name>`;
  return `${selector}: this device is a worker (role ${roleLabel}) and never runs an interactive login. `
    + `Add the account on your personal device with \`${addCmd}\`; `
    + `workers are provisioned from the durable credential automatically `
    + `(${agent}: ${workerProvisioningHint(agent)}). `
    + `To mark this box as your interactive seat: agents devices role ${device} personal.`;
}

function assertAddAllowedOnThisDevice(agent: AgentId, name?: string): void {
  const reason = addWorkerRefusal(agent, name);
  if (reason) throw new Error(reason);
}

export function ambientTokenRefusal(agent: AgentId, env: NodeJS.ProcessEnv = process.env): string | null {
  if (!ambientClaudeToken(agent, env)) return null;
  return 'An ambient CLAUDE_CODE_OAUTH_TOKEN is set in this shell; minting under it would collapse every slot to that one account. '
    + 'Unset it and re-run, or pass --no-worker-token to skip minting.';
}

export function loginInvocation(agent: AgentId): LoginInvocation {
  const invocation = LOGIN_INVOCATIONS[agent];
  if (invocation) return invocation;
  const login = harnessAuth(agent).login;
  if (!login) throw new Error(`No native login command is wired for ${agent}.`);
  return { args: login };
}

export interface ObservedIdentity {
  identityKey: string | null;
  email: string | null;
  releaseVersion: string | null;
  signedIn: boolean;
}

export function verifyConnectedIdentity(
  ctx: { agent: AgentId; home: string; existing?: NativeAccount | null },
  observed: Pick<ObservedIdentity, 'identityKey' | 'signedIn'>,
): void {
  if (!observed.signedIn || !observed.identityKey) {
    throw new Error(`No ${ctx.agent} login completed in the slot (no live credential). Nothing was registered.`);
  }
  if (ctx.existing && observed.identityKey !== ctx.existing.identityKey) {
    throw new Error(
      `The ${ctx.agent} login that just completed is a different identity `
      + `(${observed.identityKey}) than account '${ctx.existing.name}' (${ctx.existing.identityKey}). `
      + `Account '${ctx.existing.name}' still points at its original identity; nothing was changed. `,
    );
  }
}

export function findAddAccount(agent: AgentId, name: string | undefined, meta: Pick<Meta, 'accounts' | 'deviceAccounts'>): NativeAccount | null {
  if (!name) return null;
  const needle = name.toLowerCase();
  return listNativeAccounts(meta).find(a =>
    a.agent === agent && (a.id === name || a.name.toLowerCase() === needle || a.identityLabel?.toLowerCase() === needle),
  ) ?? null;
}

export interface AddRunners {
  ensureInstallation(agent: AgentId, onProgress?: (m: string) => void): Promise<{ label: string }>;
  launchLogin(agent: AgentId, ctx: { home: string; args: string[]; email?: string; signal?: AbortSignal }): Promise<{ code: number | null }>;
  observeIdentity(agent: AgentId, home: string): Promise<ObservedIdentity>;
  mintSetupToken?(agent: AgentId, ctx: { home: string }): Promise<string>;
  promptApiKey?(agent: AgentId, env: string): Promise<string | null>;
  requestReconcile?(): void | Promise<void>;
}

export interface AddOptions {
  meta: Pick<Meta, 'accounts' | 'deviceAccounts'>;
  onProgress?: (m: string) => void;
  stateDir?: string;
  apiKey?: string;
  noWorkerToken?: boolean;
  perDevice?: boolean;
  env?: NodeJS.ProcessEnv;
}

export type WorkerCredentialOutcome = 'minted' | 'stored' | 'kept' | 'per-device' | 'skipped';

export interface AddResult {
  mode: 'new' | 'reconnect';
  agent: AgentId;
  accountId: string;
  name: string;
  identityKey: string;
  email: string | null;
  slotDir: string;
  releaseVersion: string | null;
  becameDefault: boolean;
  provisioning: 'portable' | 'per-device';
  workerCredential: WorkerCredentialOutcome;
  workerCredentialRef?: { bundle: string; key: string };
  warnings: string[];
}

function patchNativeAccountRow(accountId: string, patch: Partial<Pick<NativeAccount, 'provisioning' | 'createdOn' | 'workerCredential'>>): void {
  updateMeta((current) => {
    if (current.accounts?.native?.[accountId]) {
      const native = { ...current.accounts.native, [accountId]: { ...current.accounts.native[accountId]!, ...patch } };
      return { ...current, accounts: { ...current.accounts, native } };
    }
    if (current.deviceAccounts?.native?.[accountId]) {
      const native = { ...current.deviceAccounts.native, [accountId]: { ...current.deviceAccounts.native[accountId]!, ...patch } };
      return { ...current, deviceAccounts: { ...current.deviceAccounts, native } };
    }
    throw new Error(`Account row '${accountId}' vanished before v2 fields could be recorded.`);
  });
}

function deriveAccountName(email: string | null): string | null {
  if (!email) return null;
  const local = email.split('@')[0]!.trim().toLowerCase().replace(/[^a-z0-9._-]/g, '-');
  return local || null;
}

function removeSlotDir(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true });
}

async function mintWorkerCredential(
  agent: AgentId,
  account: { id: string; name: string; identityLabel?: string },
  home: string,
  opts: AddOptions,
  runners: AddRunners,
  warnings: string[],
): Promise<{ outcome: WorkerCredentialOutcome; ref?: { bundle: string; key: string }; provisioning: 'portable' | 'per-device' }> {
  const kinds = harnessWorkerKinds(agent);

  if (opts.noWorkerToken) {
    warnings.push(
      `No worker credential minted for ${agent}#${account.name}: workers can't run this account until one exists `
      + `(agents accounts login ${agent}#${account.name} re-mints). The account works on this device now.`,
    );
    return { outcome: 'skipped', provisioning: 'per-device' };
  }
  if (opts.perDevice) {
    if (!hasPerDeviceWorkerKind(agent)) throw new Error(perDeviceRefusal(agent));
    return { outcome: 'per-device', provisioning: 'per-device' };
  }

  const {
    seedReservedStoreKey,
    seedReservedAuthToken,
    workerCredentialStoreKey,
  } = await import('../auth-mint.js');

  if (kinds.includes('setup-token')) {
    const refusal = ambientTokenRefusal(agent, opts.env ?? process.env);
    if (refusal) throw new Error(refusal);
    if (!runners.mintSetupToken) throw new Error(`No setup-token mint driver available for ${agent}.`);
    const token = await runners.mintSetupToken(agent, { home });
    const key = workerCredentialStoreKey(agent, account.id);
    const ref = seedReservedStoreKey(agent, 'setup-token', key, token);
    if (account.identityLabel) seedReservedAuthToken(account.identityLabel, token);
    return { outcome: 'minted', ref, provisioning: 'portable' };
  }

  const env = workerApiKeyEnv(agent);
  if (env && kinds.some((k) => k.startsWith('api-key:'))) {
    let value = opts.apiKey?.trim();
    if (!value) {
      if (!runners.promptApiKey) {
        throw new Error(
          `${agent}'s worker credential is an ${env} API key. Pass --api-key <key> (or --no-worker-token to skip, or --per-device for a subscription seat when the harness has one).`,
        );
      }
      const entered = await runners.promptApiKey(agent, env);
      if (entered === null) {
        warnings.push(
          `No ${env} collected for ${agent}#${account.name}: workers can't run this account until one is stored `
          + `(agents accounts login ${agent}#${account.name} --api-key <key>). The account works on this device now.`,
        );
        return { outcome: 'skipped', provisioning: 'per-device' };
      }
      value = entered.trim();
    }
    if (!value) throw new Error(`${env} cannot be empty.`);
    const key = workerCredentialStoreKey(agent, account.id);
    const ref = seedReservedStoreKey(agent, 'api-key', key, value);
    return { outcome: 'stored', ref, provisioning: 'portable' };
  }

  return { outcome: 'per-device', provisioning: 'per-device' };
}

export async function runAdd(
  agent: AgentId,
  name: string | undefined,
  opts: AddOptions,
  runners?: AddRunners,
): Promise<AddResult> {


  assertAddSupported(agent);
  assertAddAllowedOnThisDevice(agent, name);
  const kinds = harnessWorkerKinds(agent);
  if (opts.perDevice && !hasPerDeviceWorkerKind(agent)) {
    throw new Error(perDeviceRefusal(agent));
  }
  if (!opts.noWorkerToken && !opts.perDevice && kinds.includes('setup-token')) {
    const refusal = ambientTokenRefusal(agent, opts.env ?? process.env);
    if (refusal) throw new Error(refusal);
  }

  const lock = acquireAuthOperationLock(agent, opts.stateDir);
  try {
    return await _runAddLocked(agent, name, opts, lock, runners);
  } finally {
    lock.release();
  }
}

async function _runAddLocked(
  agent: AgentId,
  name: string | undefined,
  opts: AddOptions,
  lock: AuthOperationLock,
  runners?: AddRunners,
): Promise<AddResult> {
  const run = runners ?? await defaultAddRunners();
  const registry = await import('../account-registry.js');
  lock.assertHeld();

  const meta = readMeta();

  const existing = findAddAccount(agent, name, meta);
  if (existing) {
    throw new Error(`${agent}#${existing.name} is already added. Re-auth with: agents accounts login ${agent}#${existing.name}`);
  }
  if (name) registry.assertNativeAccountNameAvailable(name, agent);

  opts.onProgress?.(`Ensuring the ${agent} installation…`);
  await run.ensureInstallation(agent, opts.onProgress);
  lock.assertHeld();

  const pendingId = crypto.randomUUID();
  const slot = ensureSlot(agent, pendingId);

  const fail = (err: Error): never => {
    removeSlotDir(slot.slotDir);
    throw err;
  };

  const invocation = loginInvocation(agent);
  if (invocation.hint) opts.onProgress?.(invocation.hint);
  const login = await run.launchLogin(agent, { home: slot.slotDir, args: invocation.args, signal: lock.signal });
  lock.assertHeld();
  if (login.code !== 0) {
    fail(new Error(`${agent} login did not complete (exit ${login.code ?? 'null'}). The slot was removed; re-run to try again.`));
  }

  const observed = await run.observeIdentity(agent, slot.slotDir);
  lock.assertHeld();
  try {
    verifyConnectedIdentity({ agent, home: slot.slotDir }, observed);
  } catch (err) {
    fail(err as Error);
  }
  const identityKey = observed.identityKey!;

  const duplicate = listNativeAccounts(readMeta()).find(a => a.agent === agent && a.identityKey === identityKey);
  if (duplicate) {
    fail(new Error(`This ${agent} login is already added as '${duplicate.name}'. Re-auth with: agents accounts login ${agent}#${duplicate.name}`));
  }

  const resolvedName = name ?? deriveAccountName(observed.email);
  if (!resolvedName) {
    fail(new Error(
      `Signed in, but ${agent} exposed no email to derive an account name from. `
      + `Re-run with an explicit name: agents accounts add ${agent} <name>`,
    ));
  }
  if (!name) registry.assertNativeAccountNameAvailable(resolvedName!, agent);

  const account = registry.addNativeAccount(resolvedName!, agent, identityKey, observed.email ?? undefined, 'version');
  const finalDir = slotDir(agent, account.id);
  fs.renameSync(slot.slotDir, finalDir);
  const record: DeviceAccountSlot = {
    accountId: account.id,
    slotDir: finalDir,
    authMode: hasPortableWorkerKind(agent) ? 'native' : 'per-device',
    verdict: 'live',
    checkedAt: new Date().toISOString(),
  };
  recordSlot(account.id, record);
  const becameDefault = registry.setDefaultAccountIfAbsent(agent, account.name);

  const warnings: string[] = [];
  const minted = await mintWorkerCredential(agent, account, finalDir, opts, run, warnings);
  patchNativeAccountRow(account.id, {
    provisioning: minted.provisioning,
    createdOn: machineId(),
    ...(minted.ref
      ? { workerCredential: { ...minted.ref, kind: harnessWorkerKinds(agent).includes('setup-token') ? 'setup-token' : 'api-key', mintedAt: new Date().toISOString() } satisfies NativeAccountWorkerCredential }
      : {}),
  });

  await run.requestReconcile?.();

  return {
    mode: 'new',
    agent,
    accountId: account.id,
    name: account.name,
    identityKey,
    email: observed.email,
    slotDir: finalDir,
    releaseVersion: observed.releaseVersion,
    becameDefault,
    provisioning: minted.provisioning,
    workerCredential: minted.outcome,
    workerCredentialRef: minted.ref,
    warnings,
  };
}

export async function runLogin(
  agent: AgentId,
  name: string,
  opts: AddOptions,
  runners?: AddRunners,
): Promise<AddResult> {
  if (opts.perDevice && !hasPerDeviceWorkerKind(agent)) throw new Error(perDeviceRefusal(agent));
  if (hasPortableWorkerKind(agent) && !opts.perDevice) assertAddAllowedOnThisDevice(agent, name);
  if (!opts.noWorkerToken && harnessWorkerKinds(agent).includes('setup-token')) {
    const refusal = ambientTokenRefusal(agent, opts.env ?? process.env);
    if (refusal) throw new Error(refusal);
  }
  const namingRefusal = nativeAccountNamingRefusal(agent);
  if (namingRefusal) throw new Error(namingRefusal);

  const lock = acquireAuthOperationLock(agent, opts.stateDir);
  try {
    return await _runLoginLocked(agent, name, opts, lock, runners);
  } finally {
    lock.release();
  }
}

async function _runLoginLocked(
  agent: AgentId,
  name: string,
  opts: AddOptions,
  lock: AuthOperationLock,
  runners?: AddRunners,
): Promise<AddResult> {
  const run = runners ?? await defaultAddRunners();
  lock.assertHeld();
  const perDevice = !!opts.perDevice || !hasPortableWorkerKind(agent);

  const meta = readMeta();
  const account = findAddAccount(agent, name, meta);
  if (!account) {
    throw new Error(`No ${agent} account '${name}'. Add it on your personal device: agents accounts add ${agent} ${name}`);
  }

  await run.ensureInstallation(agent, opts.onProgress);
  lock.assertHeld();

  const recorded = readSlots(meta)[account.id];
  const home = recorded?.slotDir ?? slotDir(agent, account.id);
  if (!recorded || !fs.existsSync(home)) {
    const slot = ensureSlot(agent, account.id);
    recordSlot(account.id, {
      ...slot,
      authMode: perDevice ? 'per-device' : 'native',
    });
  }

  const current = fs.existsSync(home) ? await run.observeIdentity(agent, home) : null;
  lock.assertHeld();
  if (current?.signedIn && current.identityKey && current.identityKey !== account.identityKey) {
    throw new Error(
      `The ${agent} slot for '${account.name}' is currently signed in as ${current.identityKey} `
      + `(not ${account.identityKey}). Refusing to launch a login that would overwrite it.`,
    );
  }

  const cap = harnessAuth(agent);
  const args = cap.login ?? [];
  if (args.length === 0) {
    opts.onProgress?.(`Launching ${loginHint(agent)} — complete the login there.`);
  }
  const login = await run.launchLogin(agent, { home, args, email: account.identityLabel, signal: lock.signal });
  lock.assertHeld();
  if (login.code !== 0) {
    throw new Error(`${agent} login did not complete (exit ${login.code ?? 'null'}). The account is unchanged; re-run to retry.`);
  }

  const observed = await run.observeIdentity(agent, home);
  lock.assertHeld();
  verifyConnectedIdentity({ agent, home, existing: account }, observed);

  const warnings: string[] = [];
  let outcome: WorkerCredentialOutcome = 'per-device';
  let ref: { bundle: string; key: string } | undefined;
  let provisioning: 'portable' | 'per-device' = perDevice ? 'per-device' : (account.provisioning ?? 'portable');
  if (!perDevice) {
    if (opts.apiKey && workerApiKeyEnv(agent)) {
      const minted = await mintWorkerCredential(agent, account, home, opts, run, warnings);
      outcome = minted.outcome; ref = minted.ref; provisioning = minted.provisioning;
    } else if (!account.workerCredential || harnessWorkerKinds(agent).includes('setup-token')) {
      const minted = await mintWorkerCredential(agent, account, home, opts, run, warnings);
      outcome = minted.outcome; ref = minted.ref; provisioning = minted.provisioning;
    } else {
      outcome = 'kept';
      ref = account.workerCredential ? { bundle: account.workerCredential.bundle, key: account.workerCredential.key } : undefined;
    }
  }
  if (ref) {
    patchNativeAccountRow(account.id, {
      provisioning,
      workerCredential: {
        ...ref,
        kind: harnessWorkerKinds(agent).includes('setup-token') ? 'setup-token' : 'api-key',
        mintedAt: new Date().toISOString(),
      },
    });
  } else {
    patchNativeAccountRow(account.id, { provisioning });
  }
  recordSlot(account.id, {
    accountId: account.id,
    slotDir: home,
    authMode: perDevice ? 'per-device' : 'native',
    verdict: 'live',
    checkedAt: new Date().toISOString(),
  });

  await run.requestReconcile?.();

  return {
    mode: 'reconnect',
    agent,
    accountId: account.id,
    name: account.name,
    identityKey: account.identityKey,
    email: observed.email,
    slotDir: home,
    releaseVersion: observed.releaseVersion,
    becameDefault: false,
    provisioning,
    workerCredential: outcome,
    workerCredentialRef: ref,
    warnings,
  };
}

async function defaultAddRunners(): Promise<AddRunners> {
  const [store, agentsMod, execMod] = await Promise.all([
    import('../installations/store.js'),
    import('../agents.js'),
    import('../exec.js'),
  ]);
  const { ensureHarnessInstallation, getBinaryPath, readInstallation } = store;
  const { agentConfigDirName, getAccountInfo } = agentsMod;
  const { buildExecEnv } = execMod;
  const { runNativeAccountCommand } = await import('../installations/native-command.js');

  const slotConfigDir = (agent: AgentId, home: string): string => path.join(home, agentConfigDirName(agent));

  const loginEnv = (agent: AgentId, installLabel: string, home: string): NodeJS.ProcessEnv => {
    const env = buildExecEnv({ agent, version: installLabel, configVersion: installLabel, interactive: true, mode: 'auto', effort: 'auto', cwd: process.cwd() });
    env.HOME = home;
    const pin = harnessAuth(agent).slotEnv;
    if (pin) env[pin] = slotConfigDir(agent, home);
    for (const key of PROVIDER_AUTH_ENV_KEYS) delete env[key];
    const workerEnv = workerApiKeyEnv(agent);
    if (workerEnv) delete env[workerEnv];
    return env;
  };

  return {
    ensureInstallation: async (agent, onProgress) => {
      const result = await ensureHarnessInstallation(agent, { onProgress });
      return { label: result.installation.label };
    },
    launchLogin: async (agent, { home, args, email, signal }) => {
      const install = await ensureHarnessInstallation(agent, {});
      const invocation = LOGIN_INVOCATIONS[agent];
      const finalArgs = email && invocation?.emailFlag ? [...args, invocation.emailFlag, email] : args;
      return runNativeAccountCommand(agent, install.installation.label, finalArgs, loginEnv(agent, install.installation.label, home), signal);
    },
    observeIdentity: async (agent, home) => {
      const info = await getAccountInfo(agent, home);
      const { isLaunchableSignedIn } = await import('../account-catalog.js');
      return {
        identityKey: nativeIdentityKey(info, nativeAccountCapability(agent)),
        email: info.email,
        releaseVersion: readInstallation(agent, (await ensureHarnessInstallation(agent, {})).installation.label)?.releaseVersion ?? null,
        signedIn: isLaunchableSignedIn(agent, home, info),
      };
    },
    mintSetupToken: async (agent, { home }) => {
      const { MINT_FLOWS, buildMintCommand, driveSetupTokenMint } = await import('../auth-mint.js');
      const flow = MINT_FLOWS[agent];
      if (!flow || flow.auth !== 'setup-token') throw new Error(`No setup-token mint flow for ${agent}.`);
      const install = await ensureHarnessInstallation(agent, {});
      const command = buildMintCommand(flow, getBinaryPath(agent, install.installation.label), home, {
        ...(harnessAuth(agent).slotEnv ? { [harnessAuth(agent).slotEnv!]: slotConfigDir(agent, home) } : {}),
      });
      const driven = await driveSetupTokenMint(command, flow, {
        readCode: async () => {
          const { input } = await import('@inquirer/prompts');
          return input({ message: 'Paste the authorization code from the browser' });
        },
      });
      return driven.token;
    },
    promptApiKey: async (_agent, env) => {
      const { password } = await import('@inquirer/prompts');
      try {
        return await password({ message: `Enter the ${env} API key (stored as this account's worker credential):` });
      } catch (err) {
        const { isPromptCancelled } = await import('../../commands/utils.js');
        if (isPromptCancelled(err)) return null;
        throw err;
      }
    },
    requestReconcile: async () => {
      try {
        const [{ isDaemonRunning, signalDaemonReload }, { queueDaemonServiceRestart }] = await Promise.all([
          import('../daemon/daemon.js'),
          import('../daemon-services.js'),
        ]);
        if (!isDaemonRunning()) return;
        queueDaemonServiceRestart('auth-sync');
        signalDaemonReload();
      } catch {
      }
    },
  };
}
