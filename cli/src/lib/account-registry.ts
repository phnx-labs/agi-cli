import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import * as yaml from 'yaml';
import chalk from 'chalk';
import { atomicWriteFileSync } from './fs-atomic.js';
import { getUserAgentsDir, readMeta, updateMeta } from './state.js';
import { isAgentId, type AgentId, type Meta, type NativeAccountRecord } from './types.js';
import {
  bundleExistsSync,
  deleteBundleSync,
  deleteKeychainTokenSync,
  getKeychainTokenSync,
  hasKeychainTokenSync,
  listBundlesSync,
  readAndResolveBundleEnvSync,
  readBundleSync,
  renameBundleSync,
  writeBundleWithItemsSync,
} from './secrets-client.js';
import { getAccountProvider, type AccountAuthKind } from './account-provider-registry.js';
import { accountSecretItem, buildAccountBundle, parseAccountBundle, secretVarFor, type AccountSchemaRecord } from './account-schema.js';
import { readClaudeHomeConfig } from './agent-spec/agents.js';
import { getVersionHomePath, listInstalledVersions } from './installations/store.js';

export interface CredentialAccount {
  id: string;
  name: string;
  provider: string;
  auth: AccountAuthKind;
  secretRef: string;
  baseUrl?: string;
}

export interface AccountRegistryDocument { version: 2; accounts: Record<string, CredentialAccount> }
interface ResolvedCredentialAccount { id: string; name: string; provider: string; auth: AccountAuthKind; env: Record<string, string> }
export interface NativeAccount extends NativeAccountRecord {
  kind: 'native';
}

export { recordSlot, readSlots, dropSlots } from './accounts/slots.js';
export { registeredNativeAccountForEmail, parseNativeIdentityKey } from './native-accounts.js';
export type UnifiedAccount = (CredentialAccount & { kind: 'provider' }) | NativeAccount;

const NAME = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;
const NATIVE_LABEL = /^[a-zA-Z0-9][a-zA-Z0-9@._+-]*$/;
const AUTH_KINDS: readonly AccountAuthKind[] = ['api-key', 'setup-token', 'bearer-token'];

function accountRegistryPath(base = getUserAgentsDir()): string { return path.join(base, 'accounts.yaml'); }

function assertName(name: string): void {
  if (!NAME.test(name)) throw new Error('Account name must start with a letter or number and contain only letters, numbers, dot, underscore, or dash.');
}

function assertNativeLabel(label: string): void {
  if (!NATIVE_LABEL.test(label)) throw new Error('Account label must start with a letter or number and contain only letters, numbers, @, dot, underscore, plus, or dash.');
}

function isAccountAuthKind(value: unknown): value is AccountAuthKind {
  return typeof value === 'string' && AUTH_KINDS.includes(value as AccountAuthKind);
}

function toCredentialAccount(record: AccountSchemaRecord): CredentialAccount {
  return {
    id: record.id,
    name: record.name,
    provider: record.provider,
    auth: record.auth,
    secretRef: accountSecretItem(record.name, record.auth),
    baseUrl: record.baseUrl,
  };
}

function readAccountBundles(): CredentialAccount[] {
  const out: CredentialAccount[] = [];
  for (const bundle of listBundlesSync()) {
    const record = parseAccountBundle(bundle);
    if (record) out.push(toCredentialAccount(record));
  }
  return out;
}

function migrateLegacyRegistryFile(base: string): void {
  // Credential accounts live in policy-never bundles; AccountRegistryDocument is only a compatibility projection.
  // Migration writes all bundles first, skips identical retry writes, and removes legacy data only after total success.
  const file = accountRegistryPath(base);
  if (!fs.existsSync(file)) return;
  const raw = yaml.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown> | null;
  if (!raw || Array.isArray(raw)) throw new Error(`Account registry corrupted at ${file}: expected a YAML map.`);

  if (raw.version === undefined && raw.labels !== undefined) {
    archiveLegacyFile(file, 'accounts.legacy-labels.yaml');
    return;
  }
  if (raw.version !== 2) throw new Error(`Unsupported account registry version '${String(raw.version)}' at ${file}.`);

  const legacyAccounts = (raw.accounts && typeof raw.accounts === 'object' && !Array.isArray(raw.accounts))
    ? raw.accounts as Record<string, Record<string, unknown>>
    : {};
  const retiredSecretItems: string[] = [];
  for (const [key, value] of Object.entries(legacyAccounts)) {
    const item = value ?? {};
    const auth = item.auth;
    if (!isAccountAuthKind(auth)) throw new Error(`Account '${key}' has unsupported auth kind '${String(auth)}'.`);
    const id = String(item.id ?? key);
    const name = String(item.name ?? '');
    assertName(name);
    const provider = String(item.provider ?? '');
    const legacySecretRef = String(item.secretRef ?? `agents-cli.accounts.${id}.credential`);
    retiredSecretItems.push(legacySecretRef);
    if (bundleExistsSync(name)) {
      const existing = parseAccountBundle(readBundleSync(name));
      if (!existing || existing.id !== id) {
        throw new Error(`Cannot migrate account '${name}': a different secrets bundle already uses that name.`);
      }
      continue;
    }
    const baseUrl = item.baseUrl ? String(item.baseUrl) : undefined;
    const record: AccountSchemaRecord = { id, name, provider, auth, baseUrl };
    const secret = hasKeychainTokenSync(legacySecretRef) ? getKeychainTokenSync(legacySecretRef) : '';
    const { bundle, items } = buildAccountBundle(record, secret || 'x');
    if (!secret) items.clear();
    writeBundleWithItemsSync(bundle, items);
  }

  archiveLegacyFile(file, 'accounts.migrated.yaml');
  for (const legacyItem of retiredSecretItems) deleteKeychainTokenSync(legacyItem);
}

function archiveLegacyFile(file: string, archiveName: string): void {
  const archived = path.join(path.dirname(file), archiveName);
  if (fs.existsSync(archived)) fs.rmSync(archived, { force: true });
  fs.renameSync(file, archived);
}

export function readAccountRegistry(base = getUserAgentsDir()): AccountRegistryDocument {
  migrateLegacyRegistryFile(base);
  const accounts: Record<string, CredentialAccount> = {};
  for (const account of readAccountBundles()) accounts[account.id] = account;
  return { version: 2, accounts };
}

export function findAccount(name: string, doc = readAccountRegistry()): CredentialAccount | null {
  return doc.accounts[name] ?? Object.values(doc.accounts).find(account => account.name === name) ?? null;
}

// Device-scoped native identities live only in this box's device doc; that slice wins an id collision with central state.
export function listNativeAccounts(meta: Pick<Meta, 'accounts' | 'deviceAccounts'>): NativeAccount[] {
  const merged = { ...meta.accounts?.native, ...meta.deviceAccounts?.native };
  return Object.values(merged).map(account => ({ ...account, kind: 'native' as const }));
}

export function findNativeAccountByIdentity(
  meta: Pick<Meta, 'accounts' | 'deviceAccounts'>,
  agent: AgentId,
  info: { accountKey?: string | null; email?: string | null } | null | undefined,
): NativeAccount | null {
  // Stable accountKey must win; normalized email is only the key-less fallback shared by view, inventory, and statusline.
  const identityKey = info?.accountKey ?? info?.email?.toLowerCase();
  if (!identityKey) return null;
  return listNativeAccounts(meta).find(account => account.agent === agent && account.identityKey === identityKey) ?? null;
}

export function findUnifiedAccount(
  nameOrId: string,
  meta: Pick<Meta, 'accounts' | 'deviceAccounts'>,
  doc?: AccountRegistryDocument,
  preferAgent?: AgentId,
): UnifiedAccount | null {
  // Native matches return before bundle/keychain reads; preferAgent resolves shared labels for the launched harness.
  const needle = nameOrId.toLowerCase();
  const matches = listNativeAccounts(meta).filter(account =>
    account.id === nameOrId || account.name.toLowerCase() === needle || account.identityLabel?.toLowerCase() === needle,
  );
  const native = matches.find(account => account.agent === preferAgent) ?? matches[0];
  if (native) return native;
  const provider = findAccount(nameOrId, doc ?? readAccountRegistry());
  return provider ? { ...provider, kind: 'provider' } : null;
}

function nativeIdentityRows(meta: Pick<Meta, 'accounts' | 'deviceAccounts'>, agent: AgentId, identityKey: string): NativeAccount[] {
  return listNativeAccounts(meta).filter(account => account.agent === agent && account.identityKey === identityKey);
}

// A bare native label may match several harnesses; `<harness>#<name>` pins management to one.
export function parseAccountSelector(input: string): { agent?: AgentId; name: string } {
  const hash = input.indexOf('#');
  if (hash < 0) return { name: input };
  const agentRaw = input.slice(0, hash);
  const name = input.slice(hash + 1).trim();
  if (!isAgentId(agentRaw)) throw new Error(`Unknown agent '${agentRaw}'.`);
  if (!name) throw new Error('Select an account after #.');
  return { agent: agentRaw, name };
}

export function assertUnambiguousNativeAccount(
  meta: Pick<Meta, 'accounts' | 'deviceAccounts'>,
  name: string,
  agent?: AgentId,
): void {
  const matches = listNativeAccounts(meta).filter(account =>
    (agent === undefined || account.agent === agent) && (account.id === name || account.name === name),
  );
  const harnesses = [...new Set(matches.map(account => account.agent))].sort();
  if (harnesses.length > 1) {
    throw new Error(
      `Account '${name}' exists for several harnesses (${harnesses.join(', ')}). `
      + `Pick one with <harness>#${name}, e.g. ${harnesses[0]}#${name}.`,
    );
  }
}

function nativeRowsForNameOrId(meta: Pick<Meta, 'accounts' | 'deviceAccounts'>, name: string, agent?: AgentId): NativeAccount[] {
  assertUnambiguousNativeAccount(meta, name, agent);
  const matches = listNativeAccounts(meta).filter(account =>
    (agent === undefined || account.agent === agent) && (account.id === name || account.name === name),
  );
  const found = matches[0];
  if (!found) return [];
  return nativeIdentityRows(meta, found.agent, found.identityKey);
}

// Native labels are unique per harness; provider-account labels remain globally unique.
function assertUniqueUnifiedName(
  name: string,
  meta: Pick<Meta, 'accounts' | 'deviceAccounts'>,
  doc?: AccountRegistryDocument,
  exceptIds?: ReadonlySet<string>,
  agent?: AgentId,
): void {
  const needle = name.toLowerCase();
  const nativeHits = listNativeAccounts(meta).filter(account =>
    (agent === undefined || account.agent === agent)
    && (account.id === name || account.name.toLowerCase() === needle || account.identityLabel?.toLowerCase() === needle),
  );
  if (nativeHits.some(account => !exceptIds?.has(account.id))) {
    throw new Error(
      agent === undefined
        ? `Account '${name}' already exists.`
        : `Account '${name}' already exists for the ${agent} harness.`,
    );
  }
  if (nativeHits.length > 0) return;
  const provider = findAccount(name, doc ?? readAccountRegistry());
  if (provider && !exceptIds?.has(provider.id)) throw new Error(`Account '${name}' already exists.`);
}

export function assertNativeAccountNameAvailable(name: string, agent: AgentId): void {
  assertNativeLabel(name);
  assertUniqueUnifiedName(name, readMeta(), undefined, undefined, agent);
}

export function addNativeAccount(
  name: string,
  agent: AgentId,
  identityKey: string,
  identityLabel: string | undefined,
  scope: 'version' | 'device',
): NativeAccount {
  // Device-scoped identity belongs in the device document and must not propagate through central metadata.
  assertNativeLabel(name);
  const meta = readMeta();
  assertUniqueUnifiedName(name, meta, undefined, undefined, agent);
  const duplicate = listNativeAccounts(meta).find(account => account.agent === agent && account.identityKey === identityKey);
  if (duplicate) throw new Error(`This ${agent} login is already named '${duplicate.name}'.`);
  const account: NativeAccount = { id: crypto.randomUUID(), name, kind: 'native', agent, identityKey, identityLabel, scope };
  const entry = { id: account.id, name, agent, identityKey, identityLabel, scope };
  if (scope === 'device') {
    updateMeta(current => ({
      ...current,
      deviceAccounts: {
        ...current.deviceAccounts,
        native: { ...current.deviceAccounts?.native, [account.id]: entry },
      },
    }));
  } else {
    updateMeta(current => ({
      ...current,
      accounts: {
        ...current.accounts,
        native: { ...current.accounts?.native, [account.id]: entry },
      },
    }));
  }
  return account;
}

export function labelNativeAccount(
  agent: AgentId,
  identityKey: string,
  identityLabel: string | undefined,
  label: string | undefined,
  scope: 'version' | 'device',
): NativeAccount {
  const resolvedLabel = label ?? identityLabel;
  if (!resolvedLabel) throw new Error(`${agent} does not expose an email; pass a manual label.`);
  assertNativeLabel(resolvedLabel);
  const meta = readMeta();
  const matches = nativeIdentityRows(meta, agent, identityKey);
  assertUniqueUnifiedName(resolvedLabel, meta, undefined, new Set(matches.map(account => account.id)), agent);
  if (matches.length === 0) return addNativeAccount(resolvedLabel, agent, identityKey, identityLabel, scope);
  const rowScope = matches[0]!.scope;
  updateMeta(current => {
    if (rowScope === 'device') {
      const native = { ...current.deviceAccounts?.native };
      for (const row of matches) native[row.id] = { ...native[row.id]!, name: resolvedLabel, identityLabel, scope: rowScope };
      return { ...current, deviceAccounts: { ...current.deviceAccounts, native } };
    }
    const native = { ...current.accounts?.native };
    for (const row of matches) native[row.id] = { ...native[row.id]!, name: resolvedLabel, identityLabel, scope: rowScope };
    return { ...current, accounts: { ...current.accounts, native } };
  });
  return { ...matches[0]!, name: resolvedLabel, identityLabel, scope: rowScope };
}

export function nativeAccountHome(accountId: string, meta: Pick<Meta, 'deviceAccounts'>): string | null {
  return meta.deviceAccounts?.homes?.[accountId] ?? null;
}

export function setDefaultAccountIfAbsent(agent: AgentId, name: string): boolean {
  // Compare-and-set preserves concurrent and legacy defaults.
  let set = false;
  updateMeta(current => {
    if (current.accounts?.defaults?.[agent]) return current;
    if (current.agents?.[agent] || current.isolatedAgents?.[agent]) return current;
    set = true;
    return {
      ...current,
      accounts: { ...current.accounts, defaults: { ...current.accounts?.defaults, [agent]: name } },
    };
  });
  return set;
}

export function bindAccount(nameOrId: string, target: string, preferAgent?: AgentId): UnifiedAccount {
  const meta = readMeta();
  // Resolve in the caller's harness; bindings to device-scoped identities remain machine-local.
  const account = findUnifiedAccount(nameOrId, meta, undefined, preferAgent);
  if (!account) throw new Error(`Unknown account '${nameOrId}'.`);
  if (account.kind === 'native' && account.scope === 'device') {
    updateMeta(current => ({
      ...current,
      deviceAccounts: { ...current.deviceAccounts, bindings: { ...current.deviceAccounts?.bindings, [target]: account.id } },
    }));
  } else {
    updateMeta(current => ({
      ...current,
      accounts: { ...current.accounts, bindings: { ...current.accounts?.bindings, [target]: account.id } },
    }));
  }
  return account;
}

export function unbindAccount(nameOrId: string, target: string, preferAgent?: AgentId): void {
  const meta = readMeta();
  const account = findUnifiedAccount(nameOrId, meta, undefined, preferAgent);
  if (!account) throw new Error(`Unknown account '${nameOrId}'.`);
  const inCentral = meta.accounts?.bindings?.[target] === account.id;
  const inDevice = meta.deviceAccounts?.bindings?.[target] === account.id;
  if (!inCentral && !inDevice) throw new Error(`Account '${account.name}' is not attached to '${target}'.`);
  updateMeta(current => {
    let next = current;
    if (current.accounts?.bindings?.[target] === account.id) {
      const bindings = { ...current.accounts?.bindings };
      delete bindings[target];
      next = { ...next, accounts: { ...next.accounts, bindings } };
    }
    if (current.deviceAccounts?.bindings?.[target] === account.id) {
      const bindings = { ...current.deviceAccounts?.bindings };
      delete bindings[target];
      next = { ...next, deviceAccounts: { ...next.deviceAccounts, bindings } };
    }
    return next;
  });
}

export function accountBindings(accountId: string, meta: Pick<Meta, 'accounts' | 'deviceAccounts'>): string[] {
  const merged = { ...meta.accounts?.bindings, ...meta.deviceAccounts?.bindings };
  return Object.entries(merged).filter(([, id]) => id === accountId).map(([target]) => target).sort();
}

interface AccountSelection { id: string; source: 'explicit' | 'binding' | 'default' }

export function resolveAccountSelection(
  explicit: string | undefined,
  agent: AgentId,
  meta: Pick<Meta, 'accounts' | 'deviceAccounts'>,
  opts: { useDefault?: boolean; target?: string } = {},
): AccountSelection | undefined {
  // Device bindings override central bindings; missing explicit/bound accounts fail loud, while a stale default returns to balanced rotation.
  if (explicit) return { id: explicit, source: 'explicit' };
  const bindings = { ...meta.accounts?.bindings, ...meta.deviceAccounts?.bindings };
  const bound = opts.target ? bindings[opts.target] : undefined;
  if (bound) return { id: bound, source: 'binding' };
  const deviceScoped = bindings[agent];
  if (deviceScoped) return { id: deviceScoped, source: 'binding' };
  const defaulted = opts.useDefault === false ? undefined : meta.accounts?.defaults?.[agent];
  return defaulted ? { id: defaulted, source: 'default' } : undefined;
}

function profileConsumers(name: string, base: string): string[] {
  const dir = path.join(base, 'profiles');
  if (!fs.existsSync(dir)) return [];
  const consumers: string[] = [];
  for (const file of fs.readdirSync(dir).filter(value => /\.ya?ml$/.test(value))) {
    const raw = yaml.parse(fs.readFileSync(path.join(dir, file), 'utf8')) as Record<string, unknown> | null;
    if (raw?.account === name) consumers.push(file.replace(/\.ya?ml$/, ''));
  }
  return consumers.sort();
}

function renameProfileConsumers(oldName: string, newName: string, base: string): void {
  const dir = path.join(base, 'profiles');
  for (const profile of profileConsumers(oldName, base)) {
    const file = path.join(dir, `${profile}.yml`);
    const yamlFile = fs.existsSync(file) ? file : path.join(dir, `${profile}.yaml`);
    const raw = yaml.parse(fs.readFileSync(yamlFile, 'utf8')) as Record<string, unknown>;
    raw.account = newName;
    atomicWriteFileSync(yamlFile, yaml.stringify(raw));
  }
}

interface AddAccountOptions { baseUrl?: string }

export function addAccount(name: string, provider: string, auth: AccountAuthKind, secret: string, base = getUserAgentsDir(), opts: AddAccountOptions = {}): CredentialAccount {
  assertName(name);
  assertUniqueUnifiedName(name, readMeta(), readAccountRegistry(base));
  const adapter = getAccountProvider(provider);
  adapter.validate(auth, secret);
  if (bundleExistsSync(name)) throw new Error(`Secrets bundle '${name}' already exists. Choose a different account name.`);
  const record: AccountSchemaRecord = { id: crypto.randomUUID(), name, provider: adapter.provider, auth, baseUrl: opts.baseUrl };
  const { bundle, items } = buildAccountBundle(record, secret);
  writeBundleWithItemsSync(bundle, items);
  return toCredentialAccount(record);
}

export function setAccountSecret(name: string, secret: string, base = getUserAgentsDir()): void {
  const account = findAccount(name, readAccountRegistry(base));
  if (!account) throw new Error(`Unknown account '${name}'.`);
  getAccountProvider(account.provider).validate(account.auth, secret);
  const record: AccountSchemaRecord = { id: account.id, name: account.name, provider: account.provider, auth: account.auth, baseUrl: account.baseUrl };
  const { bundle, items } = buildAccountBundle(record, secret);
  // Secret rotation changes the value, not the bundle's creation provenance.
  bundle.created_at = readBundleSync(account.name).created_at;
  writeBundleWithItemsSync(bundle, items);
}

export function renameAccount(oldSelector: string, newName: string, base = getUserAgentsDir()): void {
  assertName(newName);
  const meta = readMeta();
  const selector = parseAccountSelector(oldSelector);
  const rows = nativeRowsForNameOrId(meta, selector.name, selector.agent);
  if (rows.length) {
    // Sweep every identity row in its owning store; bare-name defaults rewrite only within this harness, while ids are global.
    assertUniqueUnifiedName(newName, meta, undefined, new Set(rows.map(account => account.id)), rows[0]!.agent);
    const rowScope = rows[0]!.scope;
    const renamedAgent = rows[0]!.agent;
    const renamedIds = new Set(rows.map(row => row.id));
    updateMeta(current => {
      const defaults = { ...(current.accounts?.defaults as Record<string, string> | undefined) };
      for (const [agent, value] of Object.entries(defaults)) {
        if (renamedIds.has(value) || (agent === renamedAgent && value === selector.name)) defaults[agent] = newName;
      }
      const next: Meta = { ...current, accounts: { ...current.accounts, defaults } };
      if (rowScope === 'device') {
        const native = { ...current.deviceAccounts?.native };
        for (const row of rows) native[row.id] = { ...native[row.id]!, name: newName };
        next.deviceAccounts = { ...current.deviceAccounts, native };
      } else {
        const native = { ...current.accounts?.native };
        for (const row of rows) native[row.id] = { ...native[row.id]!, name: newName };
        next.accounts = { ...next.accounts, native };
      }
      return next;
    });
    return;
  }
  if (selector.agent) throw new Error(`Unknown ${selector.agent} account '${selector.name}'.`);
  const doc = readAccountRegistry(base);
  const account = findAccount(selector.name, doc);
  if (!account) throw new Error(`Unknown account '${selector.name}'.`);
  assertUniqueUnifiedName(newName, meta, doc);
  const idsToRename = new Set([account.name, account.id]);
  updateMeta(current => {
    const defaults = { ...(current.accounts?.defaults as Record<string, string> | undefined) };
    for (const [agent, value] of Object.entries(defaults)) {
      if (idsToRename.has(value)) defaults[agent] = newName;
    }
    return { ...current, accounts: { ...current.accounts, defaults } };
  });
  renameBundleSync(account.name, newName);
  renameProfileConsumers(account.name, newName, base);
}

export function removeAccount(selector: string, base = getUserAgentsDir()): void {
  const meta = readMeta();
  const parsed = parseAccountSelector(selector);
  const rows = nativeRowsForNameOrId(meta, parsed.name, parsed.agent);
  if (rows.length) {
    const bindings = [...new Set(rows.flatMap(row => accountBindings(row.id, meta)))].sort();
    if (bindings.length) throw new Error(`Account '${rows[0]!.name}' is attached to: ${bindings.join(', ')}. Detach it before removing it.`);
    const ids = new Set(rows.map(row => row.id));
    const rowScope = rows[0]!.scope;
    updateMeta(current => {
      const homes = { ...current.deviceAccounts?.homes };
      const slots = { ...current.deviceAccounts?.slots };
      for (const id of ids) {
        delete homes[id];
        delete slots[id];
      }
      if (rowScope === 'device') {
        const accounts = { ...current.deviceAccounts?.native };
        for (const id of ids) delete accounts[id];
        return { ...current, deviceAccounts: { ...current.deviceAccounts, native: accounts, homes, slots } };
      }
      const accounts = { ...current.accounts?.native };
      for (const id of ids) delete accounts[id];
      return { ...current, accounts: { ...current.accounts, native: accounts }, deviceAccounts: { ...current.deviceAccounts, homes, slots } };
    });
    return;
  }
  if (parsed.agent) throw new Error(`Unknown ${parsed.agent} account '${parsed.name}'.`);
  const name = parsed.name;
  const account = findAccount(name, readAccountRegistry(base));
  if (!account) throw new Error(`Unknown account '${name}'.`);
  const bindings = accountBindings(account.id, meta);
  const defaults = Object.entries(meta.accounts?.defaults ?? {}).filter(([, value]) => value === account.id || value === account.name).map(([agent]) => agent);
  if (bindings.length || defaults.length) {
    const refs = [...bindings.map(target => `binding ${target}`), ...defaults.map(agent => `default ${agent}`)];
    throw new Error(`Account '${account.name}' is still referenced by: ${refs.join(', ')}. Detach or clear those references before removing it.`);
  }
  const consumers = [...new Set([...profileConsumers(account.name, base), ...profileConsumers(account.id, base)])].sort();
  if (consumers.length) throw new Error(`Account '${account.name}' is used by harness${consumers.length === 1 ? '' : 'es'}: ${consumers.join(', ')}. Reassign them before removing it.`);
  deleteKeychainTokenSync(account.secretRef);
  deleteBundleSync(account.name);
}

export function inspectAccount(name: string, base = getUserAgentsDir()): CredentialAccount & { secretPresent: boolean; policy: 'never' } {
  const account = findAccount(name, readAccountRegistry(base));
  if (!account) throw new Error(`Unknown account '${name}'.`);
  const bundle = readBundleSync(account.name);
  if (bundle.policy !== 'never') throw new Error(`Account bundle '${account.name}' must use secrets policy 'never'.`);
  return { ...account, secretPresent: hasKeychainTokenSync(account.secretRef), policy: bundle.policy };
}

export function resolveCredentialAccount(name: string, host: AgentId, expectedProvider?: string, base = getUserAgentsDir()): ResolvedCredentialAccount {
  const account = findAccount(name, readAccountRegistry(base));
  if (!account) throw new Error(`Unknown account '${name}'.`);
  if (expectedProvider && account.provider !== expectedProvider) throw new Error(`Account '${account.name}' uses provider '${account.provider}', but this harness requires '${expectedProvider}'.`);
  const adapter = getAccountProvider(account.provider);
  if (account.auth === 'setup-token' && (account.provider !== 'anthropic' || host !== 'claude')) {
    throw new Error(`Provider '${account.provider}' cannot use a setup-token with the ${host} harness.`);
  }
  const envVar = account.auth === 'setup-token' ? 'CLAUDE_CODE_OAUTH_TOKEN' : adapter.envFor(host, account.auth);
  if (!hasKeychainTokenSync(account.secretRef)) throw new Error(`Credential for account '${account.name}' is missing on this device. Add it with 'agents accounts set-key ${account.name}'.`);
  const secretVar = secretVarFor(account.auth);
  // Resolve through the policy-never bundle path so headless reads carry its silentNoAcl attestation instead of looking biometric-gated.
  const secret = readAndResolveBundleEnvSync(account.name, {
    keys: [secretVar],
    keyMode: 'storage',
    agentOnly: true,
    caller: 'accounts resolve',
  }).env[secretVar];
  const connectionEnv = { ...adapter.connectionEnvFor(host) };
  if (account.baseUrl) {
    const baseUrlEnv = adapter.baseUrlEnvFor(host);
    if (!baseUrlEnv) throw new Error(`Account '${account.name}' has a base URL override, but provider '${account.provider}' cannot apply it to the ${host} harness.`);
    connectionEnv[baseUrlEnv] = account.baseUrl;
  }
  return {
    id: account.id,
    name: account.name,
    provider: account.provider,
    auth: account.auth,
    env: { ...connectionEnv, [envVar]: secret },
  };
}

export type SpawnAccount =
  | { kind: 'provider'; id: string; name: string; agent: AgentId; env: Record<string, string> }
  | { kind: 'native'; id: string; name: string; agent: AgentId; identityKey: string; scope: 'version' | 'device' };

// Compatibility fallback for native homes created before account registration existed.
function discoverUnregisteredNativeAccount(
  email: string,
  agent: AgentId,
): NativeAccount | null {
  if (agent !== 'claude') return null;
  const needle = email.toLowerCase();
  for (const label of listInstalledVersions(agent)) {
    const home = getVersionHomePath(agent, label);
    if (!fs.existsSync(home)) continue;
    const config = readClaudeHomeConfig(home);
    if (!config?.identity?.email) continue;
    if (config.identity.email.toLowerCase() === needle) {
      return {
        kind: 'native',
        id: email,
        name: email,
        agent,
        identityKey: config.identity.accountKey ?? email.toLowerCase(),
        scope: 'version',
      };
    }
  }
  return null;
}

/**
 * Resolve the account a run should launch under, following the binding order
 * (explicit → exact `agent@version` → device-scoped `agent` → per-harness
 * default) and classifying the result:
 *
 * - **provider** → the injected env is resolved here (fails closed when the
 *   credential is absent or the provider cannot authenticate the host).
 * - **native** → returns the identity the caller must confirm is live on the
 *   execution device; **no secret or env is produced**, because a native login
 *   is owned by the harness and read from its own home. The caller validates the
 *   live fingerprint against the installed version before spawn.
 *
 * A native account bound to a different harness than the one being launched
 * fails loudly (EXEC-ACCOUNT-4). Returns null when nothing is selected.
 */
export function resolveSpawnAccount(
  explicit: string | undefined,
  agent: AgentId,
  version: string | undefined,
  meta: Pick<Meta, 'accounts' | 'deviceAccounts'>,
  opts: { useDefault?: boolean; provider?: string; base?: string; target?: string } = {},
): SpawnAccount | null {
  // Any provider-backed custom harness rejects native credentials because provider auth would still be injected.
  const target = opts.target ?? (version ? `${agent}@${version}` : agent);
  const selection = resolveAccountSelection(explicit, agent, meta, { useDefault: opts.useDefault, target });
  if (!selection) return null;
  let unified = findUnifiedAccount(selection.id, meta, undefined, agent);
  if (!unified && selection.source === 'explicit' && selection.id.includes('@')) {
    unified = discoverUnregisteredNativeAccount(selection.id, agent);
  }
  if (!unified) {
    if (selection.source === 'default') {
      process.stderr.write(chalk.yellow(
        `[agents] default account '${selection.id}' for ${agent} no longer exists on this machine; falling back to balanced selection. Clear the stale default with: agents accounts clear-default ${agent}\n`,
      ));
      return null;
    }
    const remedy = selection.source === 'binding'
      ? `The binding for ${target} points at an account that no longer exists.`
      : `Add an account named '${selection.id}' with: agents accounts add ${agent} ${selection.id}`;
    throw new Error(`Unknown account '${selection.id}' for ${agent} harness. ${remedy}`);
  }
  if (unified.kind === 'native') {
    if (unified.agent !== agent) {
      throw new Error(`Account '${unified.name}' is a ${unified.agent} login and cannot authenticate the ${agent} harness.`);
    }
    if (opts.provider) {
      throw new Error(`Account '${unified.name}' is a native ${unified.agent} login and cannot run under a provider-backed harness (${opts.provider}); the harness's ${opts.provider} credentials would still be injected. Use a matching provider account.`);
    }
    return { kind: 'native', id: unified.id, name: unified.name, agent, identityKey: unified.identityKey, scope: unified.scope };
  }
  const resolved = resolveCredentialAccount(unified.name, agent, opts.provider, opts.base ?? getUserAgentsDir());
  return { kind: 'provider', id: resolved.id, name: resolved.name, agent, env: resolved.env };
}
