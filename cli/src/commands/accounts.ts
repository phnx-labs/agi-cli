import type { Command } from 'commander';
import * as fs from 'fs';
import * as path from 'path';
import chalk from 'chalk';
import { password, select } from '@inquirer/prompts';
import { readClaudeAccountEmail, resolveClaudeSetupToken, resolveClaudeSetupTokenForEmail, seedClaudeWorkerHomeIdentity } from '../lib/claude-account-token.js';
import { setHelpSections } from '../lib/help.js';
import { readMeta, updateMeta } from '../lib/state.js';
import { machineId } from '../lib/machine-id.js';
import type { AgentId } from '../lib/types.js';
import { ALL_AGENT_IDS, getAccountInfo, resolveAgentName } from '../lib/agents.js';
import { getGlobalDefault, getVersionHomePath, listInstalledVersions } from '../lib/installations/versions.js';
import { assertNativeAccountNameable, nativeAccountCapability, nativeIdentityKey } from '../lib/account-capabilities.js';
import { collectRunCandidates, type RotateCandidate } from '../lib/accounting/rotate.js';
import { isInteractiveTerminal, isPromptCancelled, requireInteractiveSelection } from './utils.js';
import { buildSwitchAccountChoices, formatAccountLimits, pickSwitchAccount, type SwitchAccountRow } from './run-account-picker.js';
import { profileExists, readProfile, type Profile } from '../lib/profiles.js';
import { assertCredentialTransportHostPinned, resolveHostSshTarget } from '../lib/hosts/credential-transport.js';
import { resolveRemoteOsSync } from '../lib/hosts/remote-os.js';
import { renderAccountFleetMatrix } from '../lib/devices/harness-inventory.js';
import {
  accountListJson,
  collectNativeHomeRows,
  discoverNativeAccounts,
  listDevicesWithoutAccountVerdicts,
  loadAccountCatalog,
  renderAccountRows,
  secretsUnavailableNote,
  type NativeAccountCatalogRow,
  type ProviderAccountCatalogRow,
} from '../lib/account-catalog.js';
import { addRefusal, addSupported, runAdd, runLogin, supportedAddHarnesses, type AddResult } from '../lib/accounts/add.js';
import { applyAccountMigration, formatMigrationPlan, planAccountMigration } from '../lib/accounts/migrate.js';
import { isSymlinkAdoptedHarness } from '../lib/installations/shims.js';
import { ensureAdoptedDefaultRepoint } from '../lib/exec-account-home.js';
import { acquireAuthOperationLock } from '../lib/accounts/auth-operation-lock.js';
import { isSecretsClientError, pushBundleToHost, readAndResolveBundleEnv, readBundle } from '../lib/secrets-client.js';
import { getAccountProvider, listAccountProviders, providerAuthenticatesHarness, type AccountAuthKind } from '../lib/account-provider-registry.js';
import { accountBindings, addAccount, addNativeAccount, assertUnambiguousNativeAccount, bindAccount, findAccount, findUnifiedAccount, inspectAccount, labelNativeAccount, listNativeAccounts, nativeAccountHome, parseAccountSelector, readAccountRegistry, removeAccount, renameAccount, setAccountSecret, unbindAccount, type UnifiedAccount } from '../lib/account-registry.js';
import { registerMintCommand } from './auth-mint.js';

/** Comma-joined list of harnesses `accounts add` can drive today. */
function addSupportedList(): string {
  return supportedAddHarnesses().join(', ');
}

/**
 * Legacy-verb retirement: the command is created with `{ hidden: true }` (help
 * no longer lists it) and this hook prints the pointer to its replacement when
 * it runs. Verbs keep executing for one release.
 */
function retireVerb(cmd: Command, pointer: string): void {
  cmd.hook('preAction', () => {
    console.error(chalk.gray(`'agents accounts ${cmd.name()}' is replaced by '${pointer}' — still works this release.`));
  });
}

/** Shared result printer for `accounts add` / `accounts login` / hidden `connect`. */
function printAddResult(result: AddResult, json: boolean): void {
  if (json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  const who = result.email ?? result.identityKey;
  const verb = result.mode === 'reconnect' ? 'Re-authenticated' : 'Added';
  console.log(chalk.green(`${verb} ${result.agent}#${result.name} (${who}).`));
  const credentialLine: Record<AddResult['workerCredential'], string> = {
    minted: 'worker credential minted for workers',
    stored: 'worker credential stored for workers',
    kept: 'worker credential unchanged',
    skipped: 'no worker credential — runs on this device only',
    'per-device': 'per-device login — each box signs in for itself',
  };
  console.log(chalk.gray(`  ${credentialLine[result.workerCredential]} · provisioning: ${result.provisioning}`));
  if (result.becameDefault) console.log(chalk.gray(`  Default account for ${result.agent} (first one added).`));
  for (const warning of result.warnings) console.log(chalk.yellow(`  warning: ${warning}`));
  console.log(chalk.gray(`  The native OAuth login stays owned by the harness in its slot; nothing was copied.`));
  console.log(chalk.gray(`  Run: agents run ${result.agent}#${result.name}`));
}

function cleanCommandError(command: Command, err: unknown): never {
  command.error(err instanceof Error ? err.message : String(err), { exitCode: 1, code: 'accounts.error' });
}

/** Turn a thrown user-facing Error into commander's clean CLI error instead of Node's stack dump. */
async function runAccountsAction(command: Command, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (err) {
    if (isPromptCancelled(err)) process.exit(130);
    cleanCommandError(command, err);
  }
}

function parseInstallation(raw: string): { agent: AgentId; version: string } {
  const at = raw.lastIndexOf('@');
  if (at < 1 || at === raw.length - 1) throw new Error(`Expected <agent>@<version>, got '${raw}'.`);
  const agent = resolveAgentName(raw.slice(0, at));
  if (!agent) throw new Error(`Unknown agent '${raw.slice(0, at)}'.`);
  return { agent, version: raw.slice(at + 1) };
}

export async function nativeIdentityFromSource(raw: string): Promise<{ agent: AgentId; version: string; identityKey: string; identityLabel?: string; scope: 'version' | 'device' }> {
  const parsed = parseInstallation(raw);
  const capability = nativeAccountCapability(parsed.agent);
  assertNativeAccountNameable(parsed.agent);
  if (!listInstalledVersions(parsed.agent).includes(parsed.version)) throw new Error(`${raw} is not installed.`);
  const info = await getAccountInfo(parsed.agent, getVersionHomePath(parsed.agent, parsed.version));
  const identityKey = nativeIdentityKey(info, capability);
  if (!identityKey) throw new Error(`${raw} has no stable signed-in identity. Run it and complete its normal login first.`);
  return { agent: parsed.agent, version: parsed.version, identityKey, identityLabel: info.email ?? undefined, scope: capability.scope as 'version' | 'device' };
}

type AttachTarget =
  | { kind: 'installation'; agent: AgentId; version: string }
  | { kind: 'device-agent'; agent: AgentId }
  | { kind: 'profile'; profile: Profile };

/**
 * Classify + validate an attach target, rejecting a typo BEFORE any binding is
 * written: it must be an existing custom-harness profile, an installed
 * `agent@version`, or a known harness id.
 */
export function classifyAttachTarget(target: string): AttachTarget {
  if (profileExists(target)) return { kind: 'profile', profile: readProfile(target) };
  if (target.includes('@')) {
    const at = target.lastIndexOf('@');
    const agent = resolveAgentName(target.slice(0, at));
    const version = target.slice(at + 1);
    if (!agent) throw new Error(`Unknown harness '${target.slice(0, at)}' in target '${target}'.`);
    if (!version) throw new Error(`Target '${target}' is missing a version.`);
    if (!listInstalledVersions(agent).includes(version)) throw new Error(`${agent}@${version} is not installed.`);
    return { kind: 'installation', agent, version };
  }
  const agent = resolveAgentName(target);
  if (agent) return { kind: 'device-agent', agent };
  throw new Error(`Unknown attach target '${target}'. Expected an installed <agent>@<version>, a harness id, or an existing custom harness profile.`);
}

/**
 * Persist the attached setup-token to a per-version `.oauth_token` file so an
 * INTERACTIVE Claude launch on a keychain-less Linux worker can authenticate from it.
 * Headless runs inject the token via `buildExecEnv`. Since PHNX-3502 an interactive
 * launch on a worker-role device ALSO injects it through `claudeAdapter.applyExecConfigEnv`
 * (only a headed `personal`/`desktop` device defers to its per-version native login), and
 * the shim's Linux fallback (`claudeAdapter.shimConfigEnvBash`) reads exactly this file —
 * so writing it is what makes a freshly-attached setup-token visible to that shim fallback
 * on a worker. macOS keeps the credential in the keychain, so `resolveClaudeSetupToken`
 * returns null there and this is a no-op off Linux.
 */
export function writeClaudeInteractiveOauthToken(target: AttachTarget, targetAgent: AgentId, email?: string): void {
  if (process.platform !== 'linux' || targetAgent !== 'claude' || target.kind !== 'installation') return;
  const versionHome = getVersionHomePath('claude', target.version);
  const tokenPath = path.join(versionHome, '.claude', '.oauth_token');
  // Resolve by the attached account's email when known (a freshly-seeded worker
  // home the `.claude.json` read below could not key on yet), else by the home's
  // own recorded identity for a re-point/detach.
  const token = email
    ? resolveClaudeSetupTokenForEmail(email, versionHome)
    : resolveClaudeSetupToken(versionHome);
  // A re-point (attach B over A, or a detach) can leave no setup-token resolving for
  // this version — B's may not be minted yet. A leftover file from the previous binding
  // would silently authenticate interactive runs as the OLD account (the shim's Linux
  // fallback reads it), so clear it rather than leave it stale.
  if (!token) {
    fs.rmSync(tokenPath, { force: true });
    return;
  }
  fs.mkdirSync(path.dirname(tokenPath), { recursive: true });
  fs.writeFileSync(tokenPath, token, { mode: 0o600 });
}

export function parseBundleKey(raw: string): { bundle: string; key: string } {
  const colon = raw.indexOf(':');
  if (colon < 1 || colon === raw.length - 1) throw new Error(`Expected bundle:key, got '${raw}'.`);
  return { bundle: raw.slice(0, colon), key: raw.slice(colon + 1) };
}

/**
 * Copy one value out of an `agents secrets` bundle for `--from-secrets`. The
 * standalone reports failures only as codes, so the bundle, the key, and the
 * repair are named here — and existence is checked first, because a
 * prompt-free (`agentOnly`) read of a bundle that does not exist reports
 * LOCKED rather than NOT_FOUND.
 */
async function secretFromBundle(raw: string): Promise<string> {
  const { bundle, key } = parseBundleKey(raw);
  let vars: Record<string, unknown>;
  try {
    vars = (await readBundle(bundle)).vars;
  } catch (err) {
    if (!isSecretsClientError(err, 'NOT_FOUND')) throw err;
    throw new Error(`Secrets bundle '${bundle}' not found. List bundles with 'agents secrets list'.`);
  }
  if (!(key in vars)) {
    const available = Object.keys(vars).join(', ') || '(none)';
    throw new Error(`Secrets bundle '${bundle}' has no key '${key}'. Available: ${available}.`);
  }
  try {
    const { env } = await readAndResolveBundleEnv(bundle, { keys: [key], keyMode: 'storage', agentOnly: true, caller: 'accounts import' });
    return env[key];
  } catch (err) {
    if (!isSecretsClientError(err, 'LOCKED')) throw err;
    throw new Error(
      `Secrets bundle '${bundle}' is not unlocked for a prompt-free read. ` +
      `Unlock it first with 'agents secrets unlock ${bundle}', then retry.`,
    );
  }
}

/** Interactive secret entry for add/set-key. Ctrl+C must not become accounts.error. */
async function promptAccountSecret(message: string): Promise<string | null> {
  try {
    return await password({ message });
  } catch (err) {
    if (isPromptCancelled(err)) return null;
    throw err;
  }
}

function publicAccount(account: ReturnType<typeof inspectAccount>) {
  return { kind: 'provider' as const, id: account.id, name: account.name, provider: account.provider, auth: account.auth, baseUrl: account.baseUrl, policy: account.policy, secretPresent: account.secretPresent };
}

async function printAccounts(json: boolean, fleet = false, harnessRaw?: string): Promise<void> {
  const harness = harnessRaw ? parseHarness(harnessRaw) : undefined;
  const catalog = await loadAccountCatalog();
  const note = secretsUnavailableNote(catalog);
  if (note) console.error(chalk.yellow(note)); // stderr — never corrupts --json stdout
  const native = harness ? catalog.native.filter((row) => row.agent === harness) : catalog.native;
  const providers = harness
    ? catalog.provider.filter((row) => row.harnesses.includes(harness))
    : catalog.provider;
  if (json) {
    console.log(JSON.stringify(accountListJson(native, providers, harness), null, 2));
    return;
  }
  if (fleet) {
    const matrixRows = native.map((row) => ({
      harness: row.agent,
      name: row.name,
      identityLabel: row.identityLabel,
      devices: row.devices,
    }));
    const covered = new Set(matrixRows.flatMap((row) => row.devices.map((device) => device.device)));
    const uncoveredDevices = listDevicesWithoutAccountVerdicts().filter((device) => !covered.has(device));
    console.log(renderAccountFleetMatrix(matrixRows, { uncoveredDevices }).join('\n'));
    return;
  }
  console.log(renderAccountRows(native, { providers, harness, localDevice: machineId() }));
}

/** Compatibility export for tests/consumers; the canonical renderer is shared with view. */
export function renderAccountList(
  native: NativeAccountCatalogRow[],
  providers: ProviderAccountCatalogRow[] = [],
  opts: { harness?: AgentId; localDevice?: string } = {},
): string {
  return renderAccountRows(native, { providers, localDevice: '', ...opts });
}

function parseAuth(raw: string): AccountAuthKind {
  if (raw === 'api-key' || raw === 'setup-token' || raw === 'bearer-token') return raw;
  throw new Error(`Unsupported auth type '${raw}'. Use api-key, setup-token, or bearer-token.`);
}

function parseHarness(agentRaw: string): AgentId {
  if (!ALL_AGENT_IDS.includes(agentRaw as AgentId)) throw new Error(`Unknown agent '${agentRaw}'.`);
  return agentRaw as AgentId;
}

/** One labelable signed-in identity, folded across every version it is signed into. */
export interface LabelIdentity {
  identityKey: string;
  email: string | null;
  versions: string[];
  isDefault: boolean;
}

/**
 * Fold signed-in run candidates into distinct identities — the unit a label
 * binds to. The same account signed into several versions is ONE row, so a
 * multi-version single-account harness never demands a selector. Candidates
 * with no stable identity (no accountKey, no email) are dropped: there is
 * nothing durable for a label to bind to. Default-version identity first.
 */
export function groupLabelIdentities(
  candidates: Pick<RotateCandidate, 'version' | 'email' | 'accountKey'>[],
  defaultVersion: string | null,
): LabelIdentity[] {
  const byKey = new Map<string, LabelIdentity>();
  for (const candidate of candidates) {
    const key = candidate.accountKey ?? candidate.email?.toLowerCase();
    if (!key) continue;
    const row = byKey.get(key) ?? { identityKey: key, email: null, versions: [], isDefault: false };
    row.email ??= candidate.email;
    row.versions.push(candidate.version);
    if (candidate.version === defaultVersion) row.isDefault = true;
    byKey.set(key, row);
  }
  return [...byKey.values()].sort((a, b) =>
    a.isDefault !== b.isDefault ? (a.isDefault ? -1 : 1) : (a.email ?? a.identityKey).localeCompare(b.email ?? b.identityKey));
}

export type LabelSelection =
  | { kind: 'selected'; identity: LabelIdentity }
  | { kind: 'ambiguous'; identities: LabelIdentity[] };

/**
 * Resolve which signed-in login a bare-harness `accounts label` call means.
 * `collect` is injectable (the `resolveRunVersion` pattern) so tests drive the
 * real selection path against fixture candidates.
 */
export async function resolveLabelIdentity(
  agent: AgentId,
  accountSelector: string | undefined,
  collect: typeof collectRunCandidates = collectRunCandidates,
): Promise<LabelSelection> {
  const candidates = (await collect(agent)).filter(candidate => candidate.signedIn);
  const identities = groupLabelIdentities(candidates, getGlobalDefault(agent));
  if (identities.length === 0) throw new Error(`No signed-in ${agent} account with a stable identity. Run the harness and complete its login first.`);
  const needle = accountSelector?.toLowerCase();
  if (needle) {
    const match = identities.find(identity => identity.email?.toLowerCase() === needle || identity.identityKey.toLowerCase() === needle);
    if (!match) throw new Error(`Unknown ${agent} account '${accountSelector}'.`);
    return { kind: 'selected', identity: match };
  }
  if (identities.length === 1) return { kind: 'selected', identity: identities[0] };
  return { kind: 'ambiguous', identities };
}

/**
 * Body of `accounts label`, exported with the injectable candidate collector
 * so tests exercise everything but the TTY prompt itself.
 */
export async function runAccountsLabel(
  source: string,
  label: string | undefined,
  opts: { account?: string },
  collect: typeof collectRunCandidates = collectRunCandidates,
): Promise<void> {
  if (source.includes('@')) {
    // <harness>@<version> pins the login by where it is signed in, so a
    // second selector can only contradict it.
    if (opts.account) throw new Error(`'${source}' already selects one login; drop --account.`);
    const identity = await nativeIdentityFromSource(source);
    const account = labelNativeAccount(identity.agent, identity.identityKey, identity.identityLabel, label, identity.scope);
    console.log(chalk.green(`Labeled ${identity.agent} account ${identity.identityLabel ?? identity.identityKey} as '${account.name}'.`));
    return;
  }
  const agent = parseHarness(source);
  assertNativeAccountNameable(agent);
  const selection = await resolveLabelIdentity(agent, opts.account, collect);
  let selected: LabelIdentity;
  if (selection.kind === 'selected') {
    selected = selection.identity;
  } else {
    if (!isInteractiveTerminal()) {
      requireInteractiveSelection(`Selecting the ${agent} login to label`, [
        `agents accounts label ${agent} ${label ?? '<label>'} --account <email|id>`,
        `agents accounts label ${agent}@<version> ${label ?? '<label>'}`,
      ]);
    }
    const picked = await pickLabelIdentity(agent, selection.identities);
    if (!picked) return;
    selected = picked;
  }
  const account = labelNativeAccount(agent, selected.identityKey, selected.email ?? undefined, label, nativeAccountCapability(agent).scope as 'version' | 'device');
  console.log(chalk.green(`Labeled ${agent} account ${selected.email ?? selected.identityKey} as '${account.name}'.`));
}

/** Prompt for the login a label should bind to. A cancelled picker writes nothing. */
async function pickLabelIdentity(agent: AgentId, identities: LabelIdentity[]): Promise<LabelIdentity | null> {
  const idW = Math.max(0, ...identities.map(identity => (identity.email ?? identity.identityKey).length));
  const choices = identities.map(identity => ({
    name: [
      (identity.email ?? identity.identityKey).padEnd(idW),
      identity.isDefault ? chalk.green('default') : '       ',
      chalk.gray(identity.versions.join(', ')),
    ].join('  '),
    value: identity.identityKey,
  }));
  try {
    const key = await select({ message: `Select the ${agent} login to label:`, choices, loop: false });
    return identities.find(identity => identity.identityKey === key) ?? null;
  } catch (err) {
    if (isPromptCancelled(err)) return null;
    throw err;
  }
}

/** Every account (native + provider) registered/usable for this harness, oldest-first by name. */
function accountsForHarness(agent: AgentId): UnifiedAccount[] {
  const meta = readMeta();
  const native = listNativeAccounts(meta).filter(account => account.agent === agent);
  const providers: UnifiedAccount[] = Object.values(readAccountRegistry().accounts)
    .filter(account => providerAuthenticatesHarness(account.provider, account.auth, agent))
    .map(account => ({ ...account, kind: 'provider' as const }));
  return [...native, ...providers].sort((a, b) => a.name.localeCompare(b.name));
}

/** Named accounts that `set-default` / `switch` can pin for this harness. */
export async function listSwitchableAccounts(agent: AgentId): Promise<UnifiedAccount[]> {
  return accountsForHarness(agent);
}

/**
 * Pin the per-harness default. Shared by `accounts set-default` and `accounts switch`.
 * Provider accounts must authenticate the harness; native accounts must belong to it.
 */
export function setDefaultAccount(agentRaw: string, name: string): { agent: AgentId; account: UnifiedAccount } {
  const agent = parseHarness(agentRaw);
  // Scope to the harness this default is FOR: a bare identity (`<email>`) matches
  // every harness that identity is signed into, so an un-scoped lookup resolved
  // the wrong row and then rejected it as "is a <other> login" just below.
  const account = findUnifiedAccount(name, readMeta(), undefined, agent);
  if (!account) throw new Error(`Unknown account '${name}'.`);
  if (account.kind === 'provider') {
    getAccountProvider(account.provider).envFor(agent, account.auth);
  } else {
    if (account.agent !== agent) {
      throw new Error(`Account '${account.name}' is a ${account.agent} login and cannot be the default for ${agent}.`);
    }
    // Adopted harnesses isolate by slot + symlink, not a version home, so the
    // nameable-by-version-home gate does not apply to `accounts default`.
    if (!isSymlinkAdoptedHarness(agent)) assertNativeAccountNameable(account.agent);
  }
  // Reference by NAME, not id: defaults sync fleet-wide with `agents repo push/pull`
  // while account ids are minted per-device, so an id ref breaks on every other
  // machine ("Unknown account '<uuid>'"). Names are the portable handle — the
  // registry resolves both, and existing uuid entries still resolve.
  // Repoint first: a written default whose symlink still points at another
  // account is a wrong home that looks like success.
  if (account.kind === 'native') ensureAdoptedDefaultRepoint(agent, account, readMeta());
  updateMeta(meta => ({ ...meta, accounts: { ...meta.accounts, defaults: { ...meta.accounts?.defaults, [agent]: account.name } } }));
  return { agent, account };
}

async function switchAccountRows(agent: AgentId): Promise<SwitchAccountRow[]> {
  const accounts = await listSwitchableAccounts(agent);
  const candidates = await collectRunCandidates(agent);
  const defaultValue = readMeta().accounts?.defaults?.[agent];
  return accounts.map(account => {
    const candidate = account.kind === 'native'
      ? candidates.find(row => row.accountKey === account.identityKey) ?? null
      : null;
    return {
      accountName: account.name,
      kind: account.kind,
      detail: account.kind === 'provider' ? account.provider : (account.identityLabel ?? account.identityKey),
      current: account.id === defaultValue || account.name === defaultValue,
      candidate,
    };
  });
}

export async function runAccountsSwitch(
  harness: string,
  accountName: string | undefined,
  opts: { json: boolean },
): Promise<void> {
  const agent = parseHarness(harness);
  const rows = await switchAccountRows(agent);
  if (accountName) {
    const { account } = setDefaultAccount(agent, accountName);
    if (opts.json) {
      console.log(JSON.stringify({ harness: agent, account: account.name, id: account.id }, null, 2));
      return;
    }
    console.log(chalk.green(`${agent} now uses account '${account.name}' unless --account overrides it.`));
    return;
  }
  if (opts.json) {
    const choices = buildSwitchAccountChoices(rows);
    console.log(JSON.stringify({
      harness: agent,
      default: rows.find(row => row.current)?.accountName ?? null,
      accounts: rows.map((row, i) => ({
        name: row.accountName,
        kind: row.kind,
        detail: row.detail,
        current: row.current,
        ready: choices[i].ready,
        limits: row.candidate ? formatAccountLimits(row.candidate) : 'limits unavailable',
      })),
    }, null, 2));
    return;
  }
  if (!isInteractiveTerminal()) {
    throw new Error(
      `Selecting a ${agent} account requires an interactive terminal.\nUse: agents accounts default ${agent} <account>`,
    );
  }
  const selected = await pickSwitchAccount(agent, rows);
  if (!selected) return;
  const { account } = setDefaultAccount(agent, selected);
  console.log(chalk.green(`${agent} now uses account '${account.name}' unless --account overrides it.`));
}

/**
 * Parse a `logout` target into its parts (pure). Supports `<harness>`,
 * `<harness>@<label>`, `<harness>#<account>`, and a bare account name (no
 * harness). `#` binds tighter than `@` so a `<harness>#<label>` selector is
 * never mis-split on a `@` inside the selector.
 */
export function parseLogoutTarget(target: string): { agentRaw: string; installationLabel?: string; identitySelector?: string } {
  const hash = target.indexOf('#');
  if (hash > 0) {
    if (!target.slice(hash + 1).trim()) throw new Error('Select an account after #.');
    return { agentRaw: target.slice(0, hash), identitySelector: target.slice(hash + 1) };
  }
  const at = target.indexOf('@');
  if (at > 0) {
    if (!target.slice(at + 1).trim()) throw new Error('Select an installation after @.');
    return { agentRaw: target.slice(0, at), installationLabel: target.slice(at + 1) };
  }
  return { agentRaw: target };
}

/** Explicit account logout must never fall back to another account's home. */
async function resolveAccountHomeLabel(account: UnifiedAccount & { kind: 'native' }): Promise<string> {
  const rows = await collectNativeHomeRows();
  const homes = rows
    .filter(r => r.signedIn && (r.accountKey ?? r.email))
    .map(r => ({ agent: r.agent, identityKey: (r.accountKey ?? r.email!.toLowerCase()), label: r.label }));
  const deviceHome = nativeAccountHome(account.id, readMeta());
  const matching = homes.filter(home => home.agent === account.agent && home.identityKey === account.identityKey);
  const label = matching.find(home => home.label === deviceHome)?.label ?? matching[0]?.label;
  if (!label || !listInstalledVersions(account.agent).includes(label)) {
    throw new Error(`Account '${account.name}' has no installed ${account.agent} home to sign out of.`);
  }
  return label;
}

/**
 * Resolve a `logout` target to the exact `(agent, installed label)` whose home
 * should be signed out — honoring a passed `@label` or `#account` selector
 * instead of always selecting the global default (PHNX-3940).
 */
export async function resolveLogoutTarget(target: string): Promise<{ agent: AgentId; version: string }> {
  const parsed = parseLogoutTarget(target);
  const meta = readMeta();
  if (ALL_AGENT_IDS.includes(parsed.agentRaw as AgentId)) {
    const agent = parsed.agentRaw as AgentId;
    if (parsed.installationLabel) {
      if (!listInstalledVersions(agent).includes(parsed.installationLabel)) {
        throw new Error(`${agent}@${parsed.installationLabel} is not installed.`);
      }
      return { agent, version: parsed.installationLabel };
    }
    if (parsed.identitySelector) {
      const account = findUnifiedAccount(parsed.identitySelector, meta, undefined, agent);
      if (!account || account.kind !== 'native' || account.agent !== agent) {
        throw new Error(`No ${agent} account '${parsed.identitySelector}'.`);
      }
      return { agent, version: await resolveAccountHomeLabel(account) };
    }
    const configuredDefault = meta.accounts?.defaults?.[agent];
    if (configuredDefault) {
      const account = findUnifiedAccount(configuredDefault, meta, undefined, agent);
      if (!account || account.kind !== 'native') {
        throw new Error(`${agent}'s default is not a locally connected native account. Select the native account to sign out explicitly.`);
      }
      return { agent, version: await resolveAccountHomeLabel(account) };
    }
    const installed = listInstalledVersions(agent);
    const version = getGlobalDefault(agent) ?? installed[installed.length - 1];
    if (!version) throw new Error(`No installed version of ${agent}. Install one with: agents add ${agent}`);
    return { agent, version };
  }
  // A bare, non-harness target may be a native account name.
  const account = findUnifiedAccount(target, meta);
  if (account?.kind === 'native') {
    return { agent: account.agent, version: await resolveAccountHomeLabel(account) };
  }
  throw new Error(
    `Unknown target '${target}'. Pass a native harness (claude, codex, …), <harness>@<label>, <harness>#<account>, or a native account name. Provider API-key accounts use \`agents accounts remove\`.`,
  );
}

export function registerAccountsCommand(program: Command): void {
  const accounts = program.command('accounts').description('Browse and manage harness accounts')
    .option('--json', 'Machine-readable account metadata')
    .option('--fleet', 'Show accounts as rows and devices as columns')
    .action(async (o: { json?: boolean; fleet?: boolean }, command: Command) => {
      await runAccountsAction(command, () => printAccounts(!!o.json, !!o.fleet));
    });
  const listCmd = accounts.command('list [harness]')
    .description('List accounts as name + usage, with the state and repair command only when one is needed')
    .option('--json', 'Machine-readable account metadata')
    .option('--fleet', 'Show accounts as rows and devices as columns')
    .action(async (harness: string | undefined, o: { json?: boolean; fleet?: boolean }, command: Command) => {
      const globals = command.optsWithGlobals() as { json?: boolean; fleet?: boolean };
      await runAccountsAction(command, () => printAccounts(!!(o.json || globals.json), !!(o.fleet || globals.fleet), harness));
    });
  setHelpSections(listCmd, {
    examples: `agents accounts list
agents accounts list claude
agents accounts list --json
agents accounts list --fleet`,
    notes: 'One row per account per harness: the account name, its usage bars (`*` stale), then nothing at all when the account is healthy. A state worth acting on trails the row — `rate-limited` (the usage snapshot via `deriveUsageStatusFromSnapshot`/`applyUsageHonesty`, never a probe 429), `expired`/`revoked`/`missing`, partial fleet coverage (`usable on 3 of 5 boxes`), then the exact repair command. `live`, `unverified`, `ready` and `per-device` are the ordinary cases and print nothing. For the identity behind an account use `agents accounts view <name>`; for per-device state use `--fleet`; for everything use `--json`. Reserved credential stores are not listed here; `agents secrets` is the place those show.',
  });

  registerMintCommand(accounts, undefined, { hidden: true });

  const addCmd = accounts.command('add <target> [name]')
    .description('Add an account. Harness form: add <harness> [name] runs the native login in a fresh credential slot and provisions workers. Provider form: add <name> --provider <p> --auth <t> stores a durable credential.')
    .option('--api-key <key>', 'Worker credential for api-key harnesses (codex/grok/cursor/opencode); prompted when omitted')
    .option('--per-device', 'codex: ChatGPT-plan account — no API key stored; workers log in per box')
    .option('--no-worker-token', 'Skip minting/collecting the worker credential (this device only)')
    .option('--provider <provider>', `Provider form: credential provider (${listAccountProviders().join(', ')})`)
    .option('--auth <type>', 'Provider form: api-key | setup-token | bearer-token')
    .option('--base-url <url>', 'Provider form: optional endpoint override stored with the account')
    .option('--from-secrets <bundle:key>', 'Provider form: import from an existing agents secrets entry')
    .option('--json', 'Machine-readable result (never includes a credential)')
    .action(async (target: string, name: string | undefined, o: {
      apiKey?: string; perDevice?: boolean; workerToken?: boolean;
      provider?: string; auth?: string; baseUrl?: string; fromSecrets?: string; json?: boolean;
    }, command: Command) => {
      await runAccountsAction(command, async () => {
        const json = !!(o.json || command.optsWithGlobals().json);
        const agent = resolveAgentName(target);
        const providerFlags = o.provider !== undefined || o.auth !== undefined || o.baseUrl !== undefined || o.fromSecrets !== undefined;
        if (agent) {
          // Harness form: an account is a credential slot, not a bundle.
          if (providerFlags) {
            throw new Error(
              `'${target}' is a harness id — mixing the harness and provider forms is ambiguous. `
              + `Harness form: agents accounts add ${agent} [name]. `
              + `Provider form: agents accounts add <non-harness-name> --provider <p> --auth <t>.`,
            );
          }
          const reason = addRefusal(agent);
          if (reason) throw new Error(reason);
          const result = await runAdd(agent, name, {
            meta: readMeta(),
            onProgress: (m: string) => { if (!json) console.log(chalk.gray(`  ${m}`)); },
            apiKey: o.apiKey,
            noWorkerToken: o.workerToken === false,
            perDevice: o.perDevice,
          });
          printAddResult(result, json);
          return;
        }
        // Provider form (the pre-v2 `accounts add <name> --provider …`).
        if (o.apiKey !== undefined || o.perDevice || o.workerToken === false) {
          throw new Error(`'${target}' is not a harness id — --api-key/--per-device/--no-worker-token belong to the harness form: agents accounts add <harness> [name].`);
        }
        if (!o.provider || !o.auth) {
          throw new Error(
            `'${target}' is not a harness id. Store a provider credential with: agents accounts add ${target} --provider <provider> --auth <type>. `
            + `Add a harness login with: agents accounts add <harness> [name].`,
          );
        }
        const auth = parseAuth(o.auth);
        const provider = getAccountProvider(o.provider);
        if (!provider.authKinds.includes(auth)) throw new Error(`Provider '${provider.provider}' does not support ${auth}. Supported: ${provider.authKinds.join(', ')}.`);
        const secret = o.fromSecrets
          ? await secretFromBundle(o.fromSecrets)
          : await promptAccountSecret(`Enter ${provider.provider} ${auth} for '${target}':`);
        if (secret === null) {
          process.exit(130);
          return;
        }
        const account = addAccount(target, provider.provider, auth, secret, undefined, { baseUrl: o.baseUrl });
        console.log(chalk.green(`Added ${account.provider} ${account.auth} account '${account.name}'.`));
        console.log(chalk.gray(`Secret bundle '${account.name}' is the account and uses policy never, so agent launches never request Touch ID.`));
      });
    });
  setHelpSections(addCmd, {
    examples: `agents accounts add claude work
agents accounts add codex personal --api-key sk-…   # or omit --api-key to be prompted
agents accounts add codex gmail --per-device        # ChatGPT-plan seat; workers log in per box
agents accounts add claude                          # name derived from the login's email
agents accounts add work --provider anthropic --auth setup-token   # provider form (non-harness name)
agents run claude#work`,
    notes: `Headed devices only: on a worker, add refuses before any slot, install, or browser — workers are provisioned automatically from the durable credential the add mints (claude: a setup-token; codex/grok/cursor/opencode: an API key via --api-key or a prompt; codex also accepts --per-device for a ChatGPT-plan seat; kimi/antigravity log in per box). An account is a credential SLOT, not a second installation: the harness has one managed install and each account is a HOME-shaped slot with its own native OAuth login (never copied, never fleet-synced). Re-running add for an already-added identity points at 'agents accounts login <harness>#<name>'. Supported: ${addSupportedList()}; other harnesses fail with the reason. An ambient CLAUDE_CODE_OAUTH_TOKEN in your shell refuses the mint (unset it or pass --no-worker-token).`,
  });

  const loginCmd = accounts.command('login <account>')
    .description('Re-authenticate an account into its slot on this device (<harness>#<name>); re-mints and re-syncs the worker credential')
    .option('--api-key <key>', 'Rotate the stored worker API key (api-key harnesses)')
    .option('--no-worker-token', 'Skip re-minting the worker credential')
    .option('--json', 'Machine-readable result (never includes a credential)')
    .action(async (selector: string, o: { apiKey?: string; workerToken?: boolean; json?: boolean }, command: Command) => {
      await runAccountsAction(command, async () => {
        const json = !!(o.json || command.optsWithGlobals().json);
        const parsed = parseAccountSelector(selector);
        if (!parsed.agent) {
          throw new Error(`Use the harness-qualified form: agents accounts login <harness>#<name> (e.g. claude#work).`);
        }
        const result = await runLogin(parsed.agent, parsed.name, {
          meta: readMeta(),
          onProgress: (m: string) => { if (!json) console.log(chalk.gray(`  ${m}`)); },
          apiKey: o.apiKey,
          noWorkerToken: o.workerToken === false,
        });
        printAddResult(result, json);
      });
    });
  setHelpSections(loginCmd, {
    examples: `agents accounts login claude#work
agents accounts login codex#personal --api-key sk-…   # rotate the worker key
agents accounts login kimi#main                       # per-device: logs THIS box in`,
    notes: 'Re-runs the native login into the SAME slot (never a new home) and fails closed when the completed login is a different identity than the account. Headed devices only for harnesses with a portable worker credential; a per-device harness (kimi) may log in on any box — that is how that box gets its login. The daemon re-syncs the account row and worker credential after a successful login.',
  });

  const defaultCmd = accounts.command('default <harness> [name]')
    .description('Set the fleet-wide default account for a harness (picker when no name)')
    .option('--json', 'Machine-readable account list or the resulting default')
    .action(async (harness: string, name: string | undefined, o: { json?: boolean }, command: Command) => {
      await runAccountsAction(command, () => runAccountsSwitch(harness, name, { json: !!(o.json || command.optsWithGlobals().json) }));
    });
  setHelpSections(defaultCmd, {
    examples: `agents accounts default claude
agents accounts default claude work
agents accounts default claude --json`,
    notes: 'The one write path for the per-harness default (the hidden set-default/switch share it). Pass a name to skip the picker. Rotation already honors the default.',
  });

  const migrateCmd = accounts.command('migrate')
    .description('Fold leftover per-account installations into 1 harness install + N credential slots')
    .option('--dry-run', 'Print the plan and touch nothing (default)')
    .option('--apply', 'Execute the plan: move homes into slots, trash empties/duplicates, re-index sessions')
    .option('--json', 'Machine-readable plan or apply result')
    .option('--device <name>', 'Run the migration on a fleet device over SSH')
    .action(async (o: { dryRun?: boolean; apply?: boolean; json?: boolean; device?: string }, command: Command) => {
      await runAccountsAction(command, async () => {
        const json = !!(o.json || command.optsWithGlobals().json);
        if (o.dryRun && o.apply) {
          throw new Error('Pass only one of --dry-run or --apply.');
        }
        const apply = !!o.apply;
        if (o.device) {
          const { isSelfHost } = await import('../lib/devices/self-host.js');
          if (!isSelfHost(o.device)) {
            const { resolveHost } = await import('../lib/hosts/registry.js');
            const { streamAgentsOnHost } = await import('../lib/hosts/passthrough.js');
            const host = await resolveHost(o.device);
            if (!host) throw new Error(`Unknown device '${o.device}'.`);
            const flags = [apply ? '--apply' : '--dry-run'];
            if (json) flags.push('--json');
            const code = streamAgentsOnHost(host, ['accounts', 'migrate', ...flags], { interactive: false });
            process.exit(code);
            return;
          }
        }
        if (!apply) {
          const plan = await planAccountMigration();
          if (json) {
            console.log(JSON.stringify(plan, null, 2));
            return;
          }
          console.log(formatMigrationPlan(plan));
          if (plan.totals.slots + plan.totals.trash + plan.totals.deferred > 0) {
            console.log();
            console.log('Dry-run: nothing written. Re-run with --apply to execute.');
            console.log('Restore a trashed install with: agents trash restore <agent>@<label>');
          }
          return;
        }
        const result = await applyAccountMigration();
        if (json) {
          console.log(JSON.stringify({
            manifestPath: result.manifestPath,
            sessionsReindexed: result.sessionsReindexed,
            plan: result.plan,
            manifest: result.manifest,
          }, null, 2));
          return;
        }
        console.log(formatMigrationPlan(result.plan));
        console.log();
        console.log(`Wrote manifest: ${result.manifestPath}`);
        console.log(`Re-indexed ${result.sessionsReindexed} session path${result.sessionsReindexed === 1 ? '' : 's'}.`);
        console.log('Restore a trashed install with: agents trash restore <agent>@<label>');
      });
    });
  setHelpSections(migrateCmd, {
    examples: `agents accounts migrate --dry-run
agents accounts migrate --apply
agents accounts migrate --dry-run --device worker-1`,
    notes: 'Folds leftover per-account installations (the old connect homes) into one managed install plus a HOME-shaped slot per identity. Empty logged-out homes and duplicate identities go to trash (agents trash restore reverses). A busy home is deferred, never moved. --apply is required to write; this upgrade only prints the dry-run report. Native OAuth files stay on this device inside the moved home.',
  });

  // Hidden legacy verb: connect is the old spelling of add.
  const connectCmd = accounts.command('connect <harness> [name]', { hidden: true })
    .description('Legacy alias of accounts add')
    .option('--json', 'Machine-readable result')
    .action(async (harness: string, name: string | undefined, o: { json?: boolean }, command: Command) => {
      await runAccountsAction(command, async () => {
        const agent = parseHarness(harness);
        const reason = addRefusal(agent);
        if (reason) throw new Error(reason);
        const result = await runAdd(agent, name, {
          meta: readMeta(),
          onProgress: (m: string) => console.log(chalk.gray(`  ${m}`)),
        });
        printAddResult(result, !!(o.json || command.optsWithGlobals().json));
      });
    });
  retireVerb(connectCmd, 'agents accounts add <harness> [name]');

  accounts.command('set-key <name>')
    .description('Rotate an account credential without changing its identity')
    .option('--from-secrets <bundle:key>', 'Import from an existing agents secrets entry')
    .action(async (name: string, o: { fromSecrets?: string }, command: Command) => {
      await runAccountsAction(command, async () => {
        const account = findAccount(name);
        if (!account) throw new Error(`Unknown provider account '${name}'.`);
        const secret = o.fromSecrets
          ? await secretFromBundle(o.fromSecrets)
          : await promptAccountSecret(`Enter new ${account.provider} ${account.auth} for '${name}':`);
        if (secret === null) {
          process.exit(130);
          return;
        }
        setAccountSecret(name, secret);
        console.log(chalk.green(`Updated credential for account '${name}'.`));
      });
    });

  const viewCmd = accounts.command('view <name>')
    .alias('inspect')
    .description('Show safe account metadata, custody, and attachments. Target may be <harness>#<name> when the name exists for several harnesses')
    .option('--json', 'Machine-readable output')
    .action(async (name: string, o: { json?: boolean }, command: Command) => {
      await runAccountsAction(command, async () => {
        const meta = readMeta();
        const selector = parseAccountSelector(name);
        assertUnambiguousNativeAccount(meta, selector.name, selector.agent);
        const unified = findUnifiedAccount(selector.name, meta, undefined, selector.agent);
        if (!unified) throw new Error(`Unknown account '${name}'.`);
        if (selector.agent && unified.kind === 'native' && unified.agent !== selector.agent) {
          throw new Error(`Unknown ${selector.agent} account '${selector.name}'.`);
        }
        const account = unified.kind === 'provider'
          ? { ...publicAccount(inspectAccount(unified.name)), custody: 'agents secrets (policy never)', attached: accountBindings(unified.id, meta) }
          : { ...unified, custody: `${unified.agent} (not stored by agents-cli)`, attached: accountBindings(unified.id, meta) };
        if (o.json || command.optsWithGlobals().json) return console.log(JSON.stringify(account, null, 2));
        console.log(chalk.bold(account.name));
        console.log(`  kind: ${account.kind}`);
        console.log(`  id: ${account.id}`);
        console.log(`  custody: ${account.custody}`);
        if (account.kind === 'provider') {
          console.log(`  provider: ${account.provider}`);
          console.log(`  auth: ${account.auth}`);
          console.log(`  credential: ${account.secretPresent ? 'present on this device' : 'missing on this device'}`);
        } else {
          console.log(`  identity: ${account.identityLabel ?? account.identityKey}`);
          console.log(`  scope: ${account.scope}`);
        }
        console.log(`  attached: ${account.attached.length ? account.attached.join(', ') : 'none'}`);
      });
    });
  setHelpSections(viewCmd, {
    examples: `agents accounts view work --json
agents accounts view codex#icloud`,
    notes: 'Native names are unique per harness. A bare name that exists for several harnesses is refused — pick one with <harness>#<name>.',
  });

  retireVerb(accounts.command('name <source> <name>', { hidden: true })
    .description('Name a signed-in native installation without copying its OAuth credentials')
    .action(async (source: string, name: string, _o: unknown, command: Command) => {
      await runAccountsAction(command, async () => {
        const identity = await nativeIdentityFromSource(source);
        const account = addNativeAccount(name, identity.agent, identity.identityKey, identity.identityLabel, identity.scope);
        console.log(chalk.green(`Named ${source} as ${account.name}.`));
        if (account.scope === 'device') console.log(chalk.gray(`${identity.agent} authentication is device-scoped; attach '${account.name}' to '${identity.agent}', not an individual version.`));
      });
    }), 'agents accounts add <harness> <name> (names are chosen at add time)');

  const labelCmd = accounts.command('label <source> [label]', { hidden: true })
    .description('Label a native login by harness or <harness>@<version>; the label binds to the account identity, not the version')
    .option('--account <email-or-id>', 'Native identity to label when the harness has multiple logins')
    .action(async (source: string, label: string | undefined, o: { account?: string }, command: Command) => {
      await runAccountsAction(command, () => runAccountsLabel(source, label, o));
    });
  retireVerb(labelCmd, 'agents accounts add <harness> <name> (rename: agents accounts rename <harness>#<old> <new>)');
  setHelpSections(labelCmd, {
    examples: `agents accounts label codex work
agents accounts label codex@0.146.0 personal
agents accounts label codex work --account you@example.com
agents run codex#work`,
    notes: 'The label binds to the signed-in account identity, not the version — codex#work keeps selecting that account after it moves to a newer install. Labels live on the central account rows in agents.yaml, which `agents repo push/pull` already syncs fleet-wide, keyed by (agent, identityKey). One signed-in login needs no selector; with several, an interactive terminal opens a picker, while scripts pass --account or <harness>@<version>.',
  });

  retireVerb(accounts.command('attach <account> <target>', { hidden: true })
    .description('Attach a named account to a native installation or custom harness')
    .action(async (name: string, target: string, _o: unknown, command: Command) => {
      await runAccountsAction(command, async () => {
        const meta = readMeta();
        // Validate the target exists before mutating any binding — and resolve it
        // FIRST so the account lookup can be scoped to the harness being attached
        // to. `identityLabel` defaults to the login's email, so a bare identity
        // (`muqsitnawaz@gmail.com`) matches every harness that identity is signed
        // into; un-scoped this resolved whichever row the store ordered first and
        // then rejected it below as "is a <other> login".
        const t = classifyAttachTarget(target);
        const targetAgent = t.kind === 'profile' ? t.profile.host.agent : t.agent;
        const account = findUnifiedAccount(name, meta, undefined, targetAgent);
        if (!account) throw new Error(`Unknown account '${name}'.`);
        if (account.kind === 'native') assertNativeAccountNameable(account.agent);
        if (account.kind === 'native') {
          // A provider-backed profile injects provider env at spawn, which would run
          // under a different credential than the native identity claims — refuse it.
          if (t.kind === 'profile' && t.profile.provider) {
            throw new Error(`Custom harness '${target}' is provider-backed (${t.profile.provider}); it cannot host the native login account '${account.name}'. Attach a matching provider account instead.`);
          }
          if (targetAgent !== account.agent) throw new Error(`Account '${account.name}' is a ${account.agent} login; '${target}' runs ${targetAgent}.`);
          if (account.scope === 'device') {
            if (t.kind !== 'device-agent') throw new Error(`${account.agent} authentication is device-scoped. Attach it with 'agents accounts attach ${account.name} ${account.agent}'.`);
          } else {
            if (t.kind !== 'installation') throw new Error(`${account.agent} authentication is per-version. Attach '${account.name}' to a specific ${account.agent}@<version>.`);
            const versionHome = getVersionHomePath(t.agent, t.version);
            // The literal email keys the account's `auth`-bundle setup-token. It lives
            // in `identityLabel` — `identityKey` is a synthetic composite
            // (`claude:account=<uuid>:org=<uuid>`, agents.ts nativeIdentityKey), never
            // the address, so it must NOT be used to derive the token key.
            const accountEmail = account.identityLabel;
            // Headless-worker bootstrap: a keychain-less Linux worker home never had
            // an interactive login, so its `.claude.json` carries no identity and
            // `nativeIdentityFromSource` would reject the attach — yet the account's
            // non-rotating setup-token is already fleet-synced in the `auth` bundle.
            // Seed the identity (email only, no rotating credential) so the token
            // resolves; `writeClaudeInteractiveOauthToken` then writes `.oauth_token`.
            if (
              process.platform === 'linux' &&
              account.agent === 'claude' &&
              accountEmail &&
              !readClaudeAccountEmail(versionHome) &&
              resolveClaudeSetupTokenForEmail(accountEmail)
            ) {
              seedClaudeWorkerHomeIdentity(versionHome, accountEmail);
            } else {
              const identity = await nativeIdentityFromSource(target);
              if (identity.identityKey !== account.identityKey) throw new Error(`'${target}' is signed in to a different identity than account '${account.name}'.`);
            }
          }
        } else {
          // Provider account: it must be able to authenticate the target's harness.
          getAccountProvider(account.provider).envFor(targetAgent, account.auth);
        }
        bindAccount(name, target, targetAgent);
        writeClaudeInteractiveOauthToken(t, targetAgent, account.kind === 'native' && account.agent === 'claude' ? account.identityLabel : undefined);
        console.log(chalk.green(`Attached ${account.name} to ${target}.`));
      });
    }), 'agents run <harness>#<name> (accounts select by name; installation bindings are legacy)');

  retireVerb(accounts.command('detach <account> <target>', { hidden: true })
    .description('Remove one account attachment')
    .action(async (name: string, target: string, _o: unknown, command: Command) => {
      await runAccountsAction(command, () => {
        // Classify the target first so the unbind is scoped to the right harness
        // for a colliding identity selector (same as the attach path).
        let targetAgent: AgentId | undefined;
        try {
          const t = classifyAttachTarget(target);
          targetAgent = t.kind === 'profile' ? t.profile.host.agent : t.agent;
        } catch { /* an unresolvable target still unbinds by whatever row matches */ }
        unbindAccount(name, target, targetAgent);
        // With the binding gone, no setup-token resolves for this version home, so this
        // clears any .oauth_token the attach left behind (else interactive runs would keep
        // authenticating as the just-detached account).
        try {
          const t = classifyAttachTarget(target);
          writeClaudeInteractiveOauthToken(t, t.kind === 'profile' ? t.profile.host.agent : t.agent);
        } catch { /* an unresolvable target has no version home to clean */ }
        console.log(chalk.green(`Detached ${name} from ${target}.`));
      });
    }), 'agents run <harness>#<name> (accounts select by name; installation bindings are legacy)');

  const renameCmd = accounts.command('rename <old> <new>')
    .description('Rename an account without changing its stable id. Target may be <harness>#<name> when the name exists for several harnesses')
    .action(async (oldName: string, newName: string, _o: unknown, command: Command) => {
      await runAccountsAction(command, () => { renameAccount(oldName, newName); });
    });
  setHelpSections(renameCmd, {
    examples: `agents accounts rename cxicloud icloud
agents accounts rename codex#icloud cloud`,
    notes: 'Native names are unique per harness. A bare name that exists for several harnesses is refused — pick one with <harness>#<name>.',
  });
  const removeCmd = accounts.command('remove <name>')
    .description('Remove an account and its device-local credential. Target may be <harness>#<name> when the name exists for several harnesses')
    .action(async (name: string, _o: unknown, command: Command) => {
      await runAccountsAction(command, () => { removeAccount(name); });
    });
  setHelpSections(removeCmd, {
    examples: `agents accounts remove claude#icloud`,
    notes: 'Native names are unique per harness. A bare name that exists for several harnesses is refused — pick one with <harness>#<name>.',
  });

  retireVerb(accounts.command('set-default <agent> <name>', { hidden: true })
    .description('Use this account for a harness when --account is omitted')
    .action(async (agentRaw: string, name: string, _o: unknown, command: Command) => {
      await runAccountsAction(command, () => {
        const { agent, account } = setDefaultAccount(agentRaw, name);
        console.log(chalk.green(`${agent} now uses account '${account.name}' unless --account overrides it.`));
      });
    }), 'agents accounts default <harness> <name>');

  const switchCmd = accounts.command('switch <harness> [account]', { hidden: true })
    .description('Pick the default account for a harness')
    .option('--json', 'Machine-readable account list or the resulting default')
    .action(async (harness: string, account: string | undefined, o: { json?: boolean }, command: Command) => {
      await runAccountsAction(command, () => runAccountsSwitch(harness, account, { json: !!(o.json || command.optsWithGlobals().json) }));
    });
  retireVerb(switchCmd, 'agents accounts default <harness> [name]');

  accounts.command('clear-default <agent>')
    .description('Return a harness to native login or balanced account selection')
    .action(async (agentRaw: string, _o: unknown, command: Command) => {
      await runAccountsAction(command, () => {
        parseHarness(agentRaw);
        updateMeta(meta => {
          const defaults = { ...meta.accounts?.defaults };
          delete defaults[agentRaw as AgentId];
          return { ...meta, accounts: { ...meta.accounts, defaults } };
        });
        console.log(chalk.green(`Cleared the default account for ${agentRaw}.`));
      });
    });

  accounts.command('logout <target>')
    .description('Sign out a harness-native OAuth login by <harness>, <harness>@<label>, <harness>#<account>, or account name. API-key / setup-token / bearer accounts use `accounts remove` instead.')
    .action(async (target: string, _o: unknown, command: Command) => {
      await runAccountsAction(command, async () => {
        const provider = findAccount(target);
        if (provider) {
          throw new Error(
            `Account '${provider.name}' uses ${provider.auth}, not OAuth. Remove it with: agents accounts remove ${provider.name}`,
          );
        }
        const { agent } = await resolveLogoutTarget(target);
        // Acquire the per-harness auth-operation mutex before logout — a concurrent
        // connect for the same harness could allocate and install into the same home
        // while this logout is in-flight, leaving the home in an ambiguous state.
        const lock = acquireAuthOperationLock(agent);
        try {
          const resolved = await resolveLogoutTarget(target);
          if (resolved.agent !== agent) throw new Error('Account selection changed; retry sign-out.');
          const { version } = resolved;
          const { runNativeAccountCommand } = await import('../lib/installations/native-command.js');
          const { getVersionHomePath } = await import('../lib/installations/versions.js');
          const { buildExecEnv } = await import('../lib/exec.js');
          // Pin the harness's own config-dir env (CLAUDE_CONFIG_DIR / CODEX_HOME) to
          // the resolved home so `logout` signs out THAT account's home — not
          // whichever the global default happens to be. HOME alone was insufficient
          // for a config-dir-env harness, which is why a passed @label was ignored.
          const env = buildExecEnv({ agent, version, configVersion: version, interactive: true, mode: 'auto', effort: 'auto', cwd: process.cwd() });
          env.HOME = getVersionHomePath(agent, version);
          lock.assertHeld();
          const result = await runNativeAccountCommand(agent, version, agent === 'claude' ? ['auth', 'logout'] : ['logout'], env, lock.signal);
          lock.assertHeld();
          if ((result.code ?? 1) !== 0) {
            throw new Error(
              `${agent} logout exited ${result.code ?? 'null'}. If this harness has no logout verb, sign out from its own UI.`,
            );
          }
          console.log(chalk.green(`Signed out native ${agent} login (${agent}@${version}).`));
        } finally {
          lock.release();
        }
      });
    });

  accounts.command('sync <name> [device]')
    .description('Copy one provider account bundle to a worker device')
    .option('--device <device>', 'Deprecated destination form; use the positional device')
    .option('--force', 'Replace matching keys on the destination')
    .action(async (name: string, deviceArg: string | undefined, o: { device?: string; force?: boolean }, command: Command) => {
      await runAccountsAction(command, async () => {
        const device = deviceArg ?? o.device;
        if (!device) throw new Error('Missing destination device. Usage: agents accounts sync <account> <device>.');
        const account = findAccount(name);
        if (!account) throw new Error(`Unknown provider account '${name}'.`);
        const sshTarget = await resolveHostSshTarget(device);
        assertCredentialTransportHostPinned(sshTarget);
        const remoteBackend = resolveRemoteOsSync(device) === 'win32' ? 'keychain' : 'file';
        const literalValues = {
          ACCOUNT_ID: account.id,
          PROVIDER: account.provider,
          AUTH_TYPE: account.auth,
          ...(account.baseUrl ? { BASE_URL: account.baseUrl } : {}),
        };
        const result = await pushBundleToHost(account.name, device, {
          remoteBackend,
          force: o.force,
          operation: 'accounts sync',
          policyNever: true,
          agentOnly: false,
          literalValues,
        });
        if (!result.ok) throw new Error(`${result.message}\nRetry: agents accounts sync ${account.name} ${device}${o.force ? ' --force' : ''}`);
        console.log(chalk.green(`${account.name} synced to ${device} (${result.keyCount} keys, ${remoteBackend} backend, policy never).`));
      });
    });

  setHelpSections(switchCmd, {
    examples: `agents accounts switch claude
agents accounts switch claude work
agents accounts switch claude --json
agents run claude`,
    notes: 'Switch writes the existing per-harness default (same binding as set-default). Rotation already honors it. Pass an account name to skip the picker. Native name/attach is only for harnesses agents-cli can isolate (claude, codex, grok); provider add is unrestricted.',
  });

  setHelpSections(accounts, {
    examples: `agents accounts add claude work
agents accounts add codex personal --api-key sk-…
agents accounts login claude#work
agents accounts default claude work
agents accounts add work --provider anthropic --auth setup-token
agents accounts add openrouter-work --provider openrouter --auth api-key --from-secrets openrouter.ai:OPENROUTER_API_KEY
agents accounts set-key work
agents accounts view work --json
agents accounts view codex#icloud
agents accounts sync openrouter-work yosemite-s0
agents run claude#work
agents accounts logout claude
agents accounts migrate --dry-run
agents accounts migrate --apply`,
    notes: 'An account is a credential SLOT, not an installation: `accounts add <harness> [name]` runs the native login in a fresh HOME-shaped slot of the one managed install, registers the fleet-wide row, and mints the durable worker credential (claude: setup-token; codex/grok/cursor/opencode: --api-key or a prompt) in one step. Headed devices only — workers are provisioned automatically. `accounts login <harness>#<name>` re-auths into the same slot and re-mints; `accounts default <harness> [name]` is the one default write path. Native account records contain metadata only; harness-owned OAuth credentials are never copied. Provider accounts are explicit portable bundles with policy never. Harness-native OAuth sign-out is `agents accounts logout <harness>` (API-key accounts use `accounts remove`). Leftover per-account installations fold with `agents accounts migrate --dry-run|--apply`. Synced vault unlock is `agents secrets vault unlock`. The legacy connect/name/label/mint/attach/detach/switch/set-default verbs still work this release and print their replacement.',
  });
}
