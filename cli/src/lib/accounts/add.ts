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

/**
 * `agents accounts add <harness> [name]` / `agents accounts login <harness>#<name>`
 * — the account onboarding front door (PHNX-3940, track T4; successor of the
 * `connect` module, kept as the `runConnect` alias for one release).
 *
 * An account is a credential SLOT, not an installation: the harness has ONE
 * managed installation (`ensureHarnessInstallation`, label `main`); every
 * account gets a HOME-shaped slot under `~/.agents/.history/accounts/<harness>/<id>/`
 * with no binary in it. The native login runs with HOME = slot (plus the
 * harness's `slotEnv` pin), so the OAuth credential is minted directly into the
 * slot and never copied.
 *
 * Headed devices only for harnesses with a portable worker credential
 * (credential-management.md invariant 7): a worker is refused before any slot,
 * install, or browser login. Per-device harnesses (worker `none`, e.g. kimi)
 * may `accounts login` on any box — they are logged in per box by design.
 *
 * The worker credential is minted/collected per account id into the reserved
 * `__<harness>__` store (claude: `setup-token` drive; api-key harnesses:
 * `--api-key` or an interactive prompt — never derived from OAuth). The account
 * row carries only the `{bundle, key}` pointer, never the secret.
 */

/**
 * Ambient provider-credential env vars stripped before a native login spawn, so
 * the OAuth flow authenticates as the human's identity rather than being
 * short-circuited by an injected API key / setup-token that would impersonate a
 * different account into the fresh slot. The target harness's own
 * `api-key:<ENV>` worker env (from HARNESS_AUTH) is stripped on top of this.
 */
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

/** The env var an api-key worker credential injects as, from HARNESS_AUTH. */
export function workerApiKeyEnv(agent: AgentId): string | null {
  for (const kind of harnessWorkerKinds(agent)) {
    if (!kind.startsWith('api-key:')) continue;
    const env = kind.slice('api-key:'.length);
    if (env !== 'provider') return env;
    // opencode keys are provider-specific; the provider registry's own adapter
    // names the harness's default env (opencode → OPENCODE_API_KEY).
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

/** Whether `accounts add` can drive this harness (nameable, version-scoped, a real login command). */
export function addSupported(agent: AgentId): boolean {
  const cap = nativeAccountCapability(agent);
  return cap.scope === 'version' && harnessAuth(agent).login !== null;
}

/** One-line description of how a harness's workers get their credential. */
export function workerProvisioningHint(agent: AgentId): string {
  const parts: string[] = [];
  for (const kind of harnessWorkerKinds(agent)) {
    if (kind === 'setup-token') parts.push('a setup-token minted during add');
    else if (kind.startsWith('api-key:')) {
      const env = kind.slice('api-key:'.length);
      parts.push(env === 'provider' ? 'a provider API key collected by add (--api-key)' : `the ${env} collected by add (--api-key)`);
    } else if (kind.startsWith('per-device')) {
      parts.push(`per-device login on each worker (--per-device / agents fleet login ${agent})`);
    }
  }
  if (parts.length === 0) return `${agent} has no portable credential — it logs in per box (agents fleet login ${agent})`;
  return parts.join(', or ');
}

/**
 * Named reason `accounts add` refuses a harness, or null when supported.
 * Distinguishes "cannot isolate/name this login" (capability) from "no finite
 * native login command" so the message is honest about which limit was hit.
 */
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

/**
 * Named reason add/login refuses on a non-headed device, or null when this box
 * may run an interactive login. Workers never mint a native OAuth login
 * (credential-management.md invariant 7 + Provisioning model).
 */
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

/**
 * Refuse to mint a Claude setup-token while an ambient CLAUDE_CODE_OAUTH_TOKEN
 * is set in this shell — the ambient token is ONE account, so minting under it
 * would collapse every slot to that account (signin-badge.ts `ambientClaudeToken`).
 */
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

/** The observed identity of a completed login. */
export interface ObservedIdentity {
  identityKey: string | null;
  email: string | null;
  releaseVersion: string | null;
  /** Live credential presence — proof of sign-in, not just a metadata identity claim. */
  signedIn: boolean;
}

/**
 * Fail-closed identity check after the login completes (pure).
 *
 * - Not signed in (no live credential) → the login did not complete; a metadata
 *   identity key alone is NOT proof, so `signedIn` is required.
 * - A re-auth (`existing`) whose completed identity differs from the account's
 *   → REFUSE: the account keeps pointing at its original identity.
 * A new add accepts whatever identity signed in (that is the account being
 * created); the caller registers it.
 */
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

/** Resolve the existing native account a name refers to for a harness. */
export function findAddAccount(agent: AgentId, name: string | undefined, meta: Pick<Meta, 'accounts' | 'deviceAccounts'>): NativeAccount | null {
  if (!name) return null;
  const needle = name.toLowerCase();
  return listNativeAccounts(meta).find(a =>
    a.agent === agent && (a.id === name || a.name.toLowerCase() === needle || a.identityLabel?.toLowerCase() === needle),
  ) ?? null;
}

/**
 * Side-effecting operations add/login need, injected so the planning and
 * verification path is unit-testable with real meta on a real filesystem
 * without a network install, a browser, or a TTY.
 */
export interface AddRunners {
  /** Ensure the harness's ONE managed installation exists; resolves with its label. */
  ensureInstallation(agent: AgentId, onProgress?: (m: string) => void): Promise<{ label: string }>;
  /** Launch the harness's native login with HOME = `home` (+ slotEnv); resolves on exit. */
  launchLogin(agent: AgentId, ctx: { home: string; args: string[]; email?: string; signal?: AbortSignal }): Promise<{ code: number | null }>;
  observeIdentity(agent: AgentId, home: string): Promise<ObservedIdentity>;
  /** Claude: drive `claude setup-token` in the slot and return the captured token. */
  mintSetupToken?(agent: AgentId, ctx: { home: string }): Promise<string>;
  /** Interactive api-key collection; null = user cancelled. Absent = non-interactive. */
  promptApiKey?(agent: AgentId, env: string): Promise<string | null>;
  /** Ask the daemon for one auth-sync reconcile (the daemon owns the tick). */
  requestReconcile?(): void | Promise<void>;
}

export interface AddOptions {
  meta: Pick<Meta, 'accounts' | 'deviceAccounts'>;
  onProgress?: (m: string) => void;
  /** Test-only: override the runtime-state dir for the auth-operation mutex. */
  stateDir?: string;
  /** Worker credential for api-key harnesses; otherwise prompted interactively. */
  apiKey?: string;
  /** Skip the worker-credential step (doctor-style warning is printed). */
  noWorkerToken?: boolean;
  /** codex: a ChatGPT-plan account — no API key; workers log in per box. */
  perDevice?: boolean;
  /** Overridable env for the ambient-token guard (tests). */
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
  /** True when this add became the harness's default (only set if none was configured). */
  becameDefault: boolean;
  provisioning: 'portable' | 'per-device';
  workerCredential: WorkerCredentialOutcome;
  workerCredentialRef?: { bundle: string; key: string };
  warnings: string[];
}

/** Write account-model-v2 fields onto the just-registered row (central or device-scoped store). */
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

/** Derive the account name for an unnamed add from the login's email local-part. */
function deriveAccountName(email: string | null): string | null {
  if (!email) return null;
  const local = email.split('@')[0]!.trim().toLowerCase().replace(/[^a-z0-9._-]/g, '-');
  return local || null;
}

function removeSlotDir(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true });
}

/**
 * Mint or collect the worker credential for a freshly-registered account and
 * record the `{bundle, key}` pointer on its row. Claude drives `setup-token` in
 * the slot; api-key harnesses take `--api-key` or an interactive prompt (never
 * derived from OAuth). Returns the outcome + provisioning for the result.
 */
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
    if (!kinds.some((k) => k.startsWith('per-device'))) {
      throw new Error(`--per-device is only valid for a harness with a per-device worker path (codex); ${agent} is provisioned from ${workerProvisioningHint(agent)}.`);
    }
    return { outcome: 'per-device', provisioning: 'per-device' };
  }

  const {
    seedReservedStoreKey,
    seedReservedAuthToken,
    workerCredentialStoreKey,
  } = await import('../auth-mint.js');

  if (kinds.includes('setup-token')) {
    // Claude: a second browser grant, driven in the slot so the token is minted
    // under the account's own identity.
    const refusal = ambientTokenRefusal(agent, opts.env ?? process.env);
    if (refusal) throw new Error(refusal);
    if (!runners.mintSetupToken) throw new Error(`No setup-token mint driver available for ${agent}.`);
    const token = await runners.mintSetupToken(agent, { home });
    const key = workerCredentialStoreKey(agent, account.id);
    const ref = seedReservedStoreKey(agent, 'setup-token', key, token);
    // Legacy `auth` bundle key for this release, so the pre-v2 usage/probe and
    // worker-inject readers keep resolving the account.
    if (account.identityLabel) seedReservedAuthToken(account.identityLabel, token);
    return { outcome: 'minted', ref, provisioning: 'portable' };
  }

  const env = workerApiKeyEnv(agent);
  if (env && kinds.some((k) => k.startsWith('api-key:'))) {
    let value = opts.apiKey?.trim();
    if (!value) {
      if (!runners.promptApiKey) {
        throw new Error(
          `${agent}'s worker credential is an ${env} API key. Pass --api-key <key> (or --no-worker-token to skip, --per-device for a codex ChatGPT-plan account).`,
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

  // worker: none (kimi/antigravity shape) — nothing portable exists.
  return { outcome: 'per-device', provisioning: 'per-device' };
}

/**
 * Drive one `agents accounts add <harness> [name]`: headed gate → one managed
 * installation → fresh slot → native login in the slot → register the row →
 * mint/collect the worker credential → request a daemon reconcile.
 */
export async function runAdd(
  agent: AgentId,
  name: string | undefined,
  opts: AddOptions,
  runners?: AddRunners,
): Promise<AddResult> {
  assertAddSupported(agent);
  // Owner rule (invariant 7): a worker NEVER runs an interactive login. Refuse
  // before the lock, slot, install, or browser — no side effects on a worker.
  assertAddAllowedOnThisDevice(agent, name);
  const kinds = harnessWorkerKinds(agent);
  if (opts.perDevice && !kinds.some((k) => k.startsWith('per-device'))) {
    throw new Error(`--per-device is only valid for a harness with a per-device worker path (codex); ${agent} is provisioned from ${workerProvisioningHint(agent)}.`);
  }
  // The ambient-token refusal is checked up front (not at the mint step) so the
  // user doesn't complete a browser login only to be refused at the end.
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

  // Re-read meta AFTER acquiring the lock so a concurrent add committed before
  // we were serialized past it is visible (`opts.meta` is a pre-lock snapshot).
  const meta = readMeta();

  // Idempotency: a name that already resolves to an account of this harness is
  // a re-auth, not an add.
  const existing = findAddAccount(agent, name, meta);
  if (existing) {
    throw new Error(`${agent}#${existing.name} is already added. Re-auth with: agents accounts login ${agent}#${existing.name}`);
  }
  // Validate the requested NAME before any install, slot, or login — a bad or
  // colliding name never mints an orphan slot and drives a login that can't be
  // recorded.
  if (name) registry.assertNativeAccountNameAvailable(name, agent);

  opts.onProgress?.(`Ensuring the ${agent} installation…`);
  await run.ensureInstallation(agent, opts.onProgress);
  lock.assertHeld();

  // The slot is keyed by the account id, which only exists after registration —
  // mint a pending id, then rename the dir onto the real id once the row lands.
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

  // The completed login may be an identity already registered under another
  // name — adding it again would split one identity across two slots.
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
  // Select this account as the harness default ONLY if none is configured.
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

/**
 * Drive one `agents accounts login <harness>#<name>`: re-auth into the SAME
 * slot (re-running add's steps 4–8), re-minting the worker credential and
 * re-syncing. On a per-device harness (worker `none`) any box may run it —
 * that IS how such a box logs in.
 */
export async function runLogin(
  agent: AgentId,
  name: string,
  opts: AddOptions,
  runners?: AddRunners,
): Promise<AddResult> {
  // A harness with a portable worker credential authenticates workers from that
  // credential, so the interactive re-login stays headed-only. A per-device
  // harness (kimi) is logged in per box BY DESIGN — any role may run this.
  if (hasPortableWorkerKind(agent)) assertAddAllowedOnThisDevice(agent, name);
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

  const meta = readMeta();
  const account = findAddAccount(agent, name, meta);
  if (!account) {
    throw new Error(`No ${agent} account '${name}'. Add it on your personal device: agents accounts add ${agent} ${name}`);
  }

  await run.ensureInstallation(agent, opts.onProgress);
  lock.assertHeld();

  // The SAME slot: the recorded one, adopted (legacy account with none yet) or
  // re-materialized if the dir is gone from disk.
  const recorded = readSlots(meta)[account.id];
  const home = recorded?.slotDir ?? slotDir(agent, account.id);
  if (!recorded || !fs.existsSync(home)) {
    const slot = ensureSlot(agent, account.id);
    recordSlot(account.id, {
      ...slot,
      authMode: hasPortableWorkerKind(agent) ? 'native' : 'per-device',
    });
  }

  // Pre-launch guard: refuse to launch a login into a slot signed in as a
  // DIFFERENT identity — that would overwrite some other login's home.
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
    // No finite login command (kimi): launch the bare harness in the slot; the
    // human completes the in-TUI login (`kimi`, then /login).
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
  let provisioning: 'portable' | 'per-device' = account.provisioning ?? (hasPortableWorkerKind(agent) ? 'portable' : 'per-device');
  if (hasPortableWorkerKind(agent)) {
    if (opts.apiKey && workerApiKeyEnv(agent)) {
      // Explicit rotation of the stored API key.
      const minted = await mintWorkerCredential(agent, account, home, opts, run, warnings);
      outcome = minted.outcome; ref = minted.ref; provisioning = minted.provisioning;
    } else if (!account.workerCredential || harnessWorkerKinds(agent).includes('setup-token')) {
      // Claude re-mints (the setup-token drive can always mint fresh from the
      // live login); an api-key harness with a stored key keeps it unless
      // --api-key rotates it.
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
    authMode: hasPortableWorkerKind(agent) ? 'native' : 'per-device',
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

/** Back-compat alias for the retired `connect` module surface (one release). */
export const runConnect = runAdd;
export const connectSupported = addSupported;
export const connectRefusal = addRefusal;
export const connectWorkerRefusal = addWorkerRefusal;

/** Real runners: the install engine, an inherited-stdio login spawn, identity read, and the mint drive. */
async function defaultAddRunners(): Promise<AddRunners> {
  const [store, agentsMod, execMod] = await Promise.all([
    import('../installations/store.js'),
    import('../agents.js'),
    import('../exec.js'),
  ]);
  const { ensureHarnessInstallation, getBinaryPath, readInstallation } = store;
  const { getAccountInfo } = agentsMod;
  const { buildExecEnv } = execMod;
  const { runNativeAccountCommand } = await import('../installations/native-command.js');

  const loginEnv = (agent: AgentId, installLabel: string, home: string): NodeJS.ProcessEnv => {
    const env = buildExecEnv({ agent, version: installLabel, execHome: home, interactive: true, mode: 'auto', effort: 'auto', cwd: process.cwd() });
    // `execHome` routes through the harness adapter, including OpenCode/Muse's
    // distinct XDG config/data roots; HOME still gives HOME-only harnesses the
    // same account-owned destination.
    env.HOME = home;
    // Strip any ambient provider API-key / setup-token env so the native login
    // authenticates as the human's OAuth identity, not an injected credential
    // that would impersonate a different account into this slot.
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
        // Strict: a live credential in THIS slot, not a bare metadata identity.
        signedIn: isLaunchableSignedIn(agent, home, info),
      };
    },
    mintSetupToken: async (agent, { home }) => {
      const { MINT_FLOWS, buildMintCommand, driveSetupTokenMint } = await import('../auth-mint.js');
      const flow = MINT_FLOWS[agent];
      if (!flow || flow.auth !== 'setup-token') throw new Error(`No setup-token mint flow for ${agent}.`);
      const install = await ensureHarnessInstallation(agent, {});
      // Pin the harness config-dir env (CLAUDE_CONFIG_DIR / …) to the slot
      // through the same adapter `buildExecEnv` uses for a slot launch, so the
      // mint writes into the account slot rather than the version home.
      const slotEnv = harnessAuth(agent).slotEnv;
      const execEnv = buildExecEnv({ agent, version: install.installation.label, execHome: home, interactive: true, mode: 'auto', effort: 'auto', cwd: process.cwd() });
      const command = buildMintCommand(flow, getBinaryPath(agent, install.installation.label), home, {
        ...(slotEnv && execEnv[slotEnv] ? { [slotEnv]: execEnv[slotEnv]! } : {}),
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
      // The daemon owns the tick; this queues a one-shot auth-sync restart so
      // the reconcile runs now instead of at the next 15-minute cadence. A
      // stopped daemon is fine — its next boot reconciles.
      try {
        const [{ isDaemonRunning, signalDaemonReload }, { queueDaemonServiceRestart }] = await Promise.all([
          import('../daemon/daemon.js'),
          import('../daemon-services.js'),
        ]);
        if (!isDaemonRunning()) return;
        queueDaemonServiceRestart('auth-sync');
        signalDaemonReload();
      } catch {
        // Best-effort request: the reconcile also happens on the regular cadence.
      }
    },
  };
}
