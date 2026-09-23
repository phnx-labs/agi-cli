/**
 * Credential accounts, stored as canonical `agents secrets` bundles (RUSH-2470).
 *
 * One account IS one bundle: the bundle label is the account name, its vars
 * carry the identity (ACCOUNT_ID / PROVIDER / AUTH_TYPE / optional BASE_URL)
 * and the secret (API_KEY or TOKEN), and it uses the `never` prompt policy so
 * it reads headlessly and syncs across the fleet with no Touch ID. The bundle
 * shape lives in [[account-schema]]; this module owns the CRUD, resolution,
 * and the one-time migration off the legacy `accounts.yaml`.
 *
 * `readAccountRegistry()` still returns the historical
 * `{ version: 2, accounts }` view so existing consumers (harness, profiles,
 * exec) keep working — it is now a projection over the account bundles, not a
 * file read. Native OAuth logins are NOT accounts here; they stay native and
 * surface through unified discovery in [[account-catalog]]. Labels bind to
 * `(agent, identityKey)` on the central `accounts.native` rows in agents.yaml,
 * which `agents repo push/pull` already syncs fleet-wide.
 */
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

/** Every account bundle currently on this device, keyed by stable id. */
function readAccountBundles(): CredentialAccount[] {
  const out: CredentialAccount[] = [];
  for (const bundle of listBundlesSync()) {
    const record = parseAccountBundle(bundle);
    if (record) out.push(toCredentialAccount(record));
  }
  return out;
}

/**
 * Fold a legacy `accounts.yaml` into account bundles, then archive it.
 * Transactional: every bundle is written first, and the file is archived (and
 * the old per-account keychain items dropped) ONLY after all writes succeed —
 * so an interrupted migration leaves the file in place and the next read
 * retries, skipping accounts that already landed as a bundle.
 */
function migrateLegacyRegistryFile(base: string): void {
  const file = accountRegistryPath(base);
  if (!fs.existsSync(file)) return;
  const raw = yaml.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown> | null;
  if (!raw || Array.isArray(raw)) throw new Error(`Account registry corrupted at ${file}: expected a YAML map.`);

  // Legacy version-bound labels (pre-credential-accounts) are not credentials —
  // archive them so they are never resurrected as fake accounts.
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
      continue; // already migrated on an earlier, interrupted run
    }
    const baseUrl = item.baseUrl ? String(item.baseUrl) : undefined;
    const record: AccountSchemaRecord = { id, name, provider, auth, baseUrl };
    const secret = hasKeychainTokenSync(legacySecretRef) ? getKeychainTokenSync(legacySecretRef) : '';
    const { bundle, items } = buildAccountBundle(record, secret || 'x');
    if (!secret) items.clear(); // no device-local secret: write metadata only
    writeBundleWithItemsSync(bundle, items);
  }

  // Success: the file's accounts all exist as bundles now. Archive it and drop
  // the superseded per-account keychain items.
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

/**
 * Effective native accounts: the fleet-shared central store (version-scoped
 * identities) merged with THIS box's own device doc (device-scoped identities).
 * A native login is machine-local — its home follows its scope (PHNX-3315), so
 * a `scope:'device'` identity is read from this box's device doc and never the
 * shared central agents.yaml (which is where its email/identityKey PII used to
 * accumulate). On an id collision the device slice wins.
 */
export function listNativeAccounts(meta: Pick<Meta, 'accounts' | 'deviceAccounts'>): NativeAccount[] {
  const merged = { ...meta.accounts?.native, ...meta.deviceAccounts?.native };
  return Object.values(merged).map(account => ({ ...account, kind: 'native' as const }));
}

/**
 * The native account registered for one harness login, or null when that login
 * is unnamed. `info` is the login's identity as `getAccountInfo` /
 * `readClaudeHomeConfig` report it; the match key is the same value every
 * catalog and inventory groups a home on — the stable `accountKey`, else the
 * lowercased email. The one lookup behind `agents view`, the device
 * inventories, and the Claude status line.
 */
export function findNativeAccountByIdentity(
  meta: Pick<Meta, 'accounts' | 'deviceAccounts'>,
  agent: AgentId,
  info: { accountKey?: string | null; email?: string | null } | null | undefined,
): NativeAccount | null {
  const identityKey = info?.accountKey ?? info?.email?.toLowerCase();
  if (!identityKey) return null;
  return listNativeAccounts(meta).find(account => account.agent === agent && account.identityKey === identityKey) ?? null;
}

/**
 * Resolve one account by name or id across both stores, native first.
 *
 * `doc` is optional and read LAZILY: a native match returns without ever reading
 * the provider bundle registry — so a native view/attach/run never triggers a
 * bundle read, legacy-`accounts.yaml` migration, or a keychain decrypt (which
 * would surface a Touch ID prompt or crash on an undecryptable legacy item). A
 * default-evaluated `doc = readAccountRegistry()` argument would defeat this by
 * running before the body, so callers that only need a native lookup must be
 * able to omit it.
 */
export function findUnifiedAccount(
  nameOrId: string,
  meta: Pick<Meta, 'accounts' | 'deviceAccounts'>,
  doc?: AccountRegistryDocument,
  preferAgent?: AgentId,
): UnifiedAccount | null {
  const needle = nameOrId.toLowerCase();
  const matches = listNativeAccounts(meta).filter(account =>
    account.id === nameOrId || account.name.toLowerCase() === needle || account.identityLabel?.toLowerCase() === needle,
  );
  // `identityLabel` defaults to the login's own identifier (the email), so ONE
  // selector legitimately matches several harnesses: `muqsitnawaz@gmail.com` is a
  // claude login AND a codex login. Un-scoped, `.find()` returned whichever row the
  // merged store happened to order first, so `agents run claude#<email>` died with
  // "Account 'personal' is a codex login and cannot authenticate the claude harness"
  // while that identity's own claude login sat right there. Prefer the harness being
  // launched; fall back to the first match when the caller has no harness in hand.
  // rename/remove/view refuse an ambiguous *name* via assertUnambiguousNativeAccount
  // before they get here — this fallback is for identityLabel collisions.
  const native = matches.find(account => account.agent === preferAgent) ?? matches[0];
  if (native) return native;
  const provider = findAccount(nameOrId, doc ?? readAccountRegistry());
  return provider ? { ...provider, kind: 'provider' } : null;
}

function nativeIdentityRows(meta: Pick<Meta, 'accounts' | 'deviceAccounts'>, agent: AgentId, identityKey: string): NativeAccount[] {
  return listNativeAccounts(meta).filter(account => account.agent === agent && account.identityKey === identityKey);
}

/**
 * Split a management selector into its harness and name. `<harness>#<name>`
 * pins the harness; a bare name (or row id) carries none. Native names are
 * unique per harness (PHNX-3887), so a bare name alone can legitimately match a
 * claude row AND a codex row — the selector is how rename/remove say which.
 */
export function parseAccountSelector(input: string): { agent?: AgentId; name: string } {
  const hash = input.indexOf('#');
  if (hash < 0) return { name: input };
  const agentRaw = input.slice(0, hash);
  const name = input.slice(hash + 1).trim();
  if (!isAgentId(agentRaw)) throw new Error(`Unknown agent '${agentRaw}'.`);
  if (!name) throw new Error('Select an account after #.');
  return { agent: agentRaw, name };
}

/**
 * Refuse a bare name that native rows in several harnesses share. A
 * harness-qualified selector (`agent` set) never hits this — uniqueness is
 * per harness. Ids are unique so they never collide either. Shared by
 * rename/remove/view so the message stays one string.
 */
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

/** Every row (central + this box's device store) for the identity that `name`
 * (id or account name) resolves to. With `agent` set only that harness's rows
 * are considered; without it, a name owned by rows in several harnesses is
 * refused rather than resolved to whichever the store ordered first. */
function nativeRowsForNameOrId(meta: Pick<Meta, 'accounts' | 'deviceAccounts'>, name: string, agent?: AgentId): NativeAccount[] {
  assertUnambiguousNativeAccount(meta, name, agent);
  const matches = listNativeAccounts(meta).filter(account =>
    (agent === undefined || account.agent === agent) && (account.id === name || account.name === name),
  );
  const found = matches[0];
  if (!found) return [];
  return nativeIdentityRows(meta, found.agent, found.identityKey);
}

/**
 * Native label names are unique per HARNESS, not globally (PHNX-3887).
 *
 * One human identity is commonly signed into several harnesses —
 * `muqsitnawaz@icloud.com` is a claude login AND a codex login AND a grok login.
 * A global namespace let whichever harness was labelled first squat the good
 * name, forcing prefixed junk (`cxicloud`, `gkicloud`) on the rest. Nothing is
 * actually ambiguous at the point of use: the selector is `<harness>#<label>`,
 * and `findUnifiedAccount` already disambiguates via `preferAgent`.
 *
 * Pass `agent` to scope the check to that harness. Every native path has one
 * in hand — connect/label from the caller, rename from the row being renamed —
 * so the un-scoped form is only for provider accounts.
 *
 * Provider (non-native) accounts stay globally unique — they are selected by
 * bare name via `--account`, with no harness to scope them by.
 */
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
  // Same laziness as findUnifiedAccount: a native row that already owns this
  // name (even one we are mutating) means we never open the provider store.
  if (nativeHits.length > 0) return;
  const provider = findAccount(name, doc ?? readAccountRegistry());
  if (provider && !exceptIds?.has(provider.id)) throw new Error(`Account '${name}' already exists.`);
}

/**
 * Validate a native account NAME (charset + per-harness uniqueness) WITHOUT a
 * known identity — the pre-flight `agents accounts add` runs before it
 * installs a home and drives a login, so a bad/colliding name fails before any
 * side effect instead of orphaning a freshly-minted home (PHNX-3940).
 */
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
  assertNativeLabel(name);
  const meta = readMeta();
  assertUniqueUnifiedName(name, meta, undefined, undefined, agent);
  const duplicate = listNativeAccounts(meta).find(account => account.agent === agent && account.identityKey === identityKey);
  if (duplicate) throw new Error(`This ${agent} login is already named '${duplicate.name}'.`);
  const account: NativeAccount = { id: crypto.randomUUID(), name, kind: 'native', agent, identityKey, identityLabel, scope };
  const entry = { id: account.id, name, agent, identityKey, identityLabel, scope };
  // A native login's home follows its scope (PHNX-3315): a device-scoped
  // identity lands in THIS box's device doc (its PII never touches the shared
  // central agents.yaml); a version-scoped one stays in the fleet-shared store.
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

/** Create or replace the version-independent label for one native identity. */
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
  // Sweep every row for this identity (PHNX-3206), routing the whole sweep to the
  // store that owns them: all rows for one identityKey share a scope (same agent),
  // so a device-scoped login lands in this box's device doc, a version-scoped one
  // in central (PHNX-3315).
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

/**
 * This box's recorded home LABEL for an account, or null.
 * Reads the leftover device-scoped `homes` map so legacy `acct-*` installation
 * labels still resolve (T5/T7); spawn-time HOME is {@link readSlots}[id].slotDir.
 */
export function nativeAccountHome(accountId: string, meta: Pick<Meta, 'deviceAccounts'>): string | null {
  return meta.deviceAccounts?.homes?.[accountId] ?? null;
}

/**
 * Set the per-harness default account by NAME only when none is configured
 * (PHNX-3940). Never overrides an existing choice — a first connect selecting a
 * default is a convenience, not a takeover. Returns whether it set the default.
 *
 * The check-then-write is performed INSIDE the `updateMeta` callback so two
 * concurrent callers (concurrent Promises or back-to-back calls on an async
 * boundary) cannot both observe "no default" and then both set themselves. Only
 * the first write wins; the second callback sees the first's write and returns
 * the current state unchanged.
 */
export function setDefaultAccountIfAbsent(agent: AgentId, name: string): boolean {
  let set = false;
  updateMeta(current => {
    if (current.accounts?.defaults?.[agent]) return current; // already set — no-op
    if (current.agents?.[agent] || current.isolatedAgents?.[agent]) return current; // preserve a legacy home default
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
  // Scope to the harness being bound to: a bare identity selector matches every
  // harness it is signed into, so without this the binding could persist against
  // a different harness's row than the caller validated (the attach command
  // resolves `targetAgent` and passes it here).
  const account = findUnifiedAccount(nameOrId, meta, undefined, preferAgent);
  if (!account) throw new Error(`Unknown account '${nameOrId}'.`);
  // A binding follows its account: one that targets a device-scoped native login
  // is itself machine-local and lands in this box's device doc (PHNX-3315);
  // every other binding stays fleet-shared in central.
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
  // Same scoping as bindAccount: detach the row on the harness the caller means,
  // not whichever the store happened to order first for a colliding identity.
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

/** Every target bound to `accountId`: this box's device-doc bindings merged over
 * the fleet-shared central bindings (PHNX-3315). */
export function accountBindings(accountId: string, meta: Pick<Meta, 'accounts' | 'deviceAccounts'>): string[] {
  const merged = { ...meta.accounts?.bindings, ...meta.deviceAccounts?.bindings };
  return Object.entries(merged).filter(([, id]) => id === accountId).map(([target]) => target).sort();
}

interface AccountSelection { id: string; source: 'explicit' | 'binding' | 'default' }

/** Explicit selection wins over a configured per-harness default. */
export function resolveAccountSelection(
  explicit: string | undefined,
  agent: AgentId,
  meta: Pick<Meta, 'accounts' | 'deviceAccounts'>,
  opts: { useDefault?: boolean; target?: string } = {},
): AccountSelection | undefined {
  if (explicit) return { id: explicit, source: 'explicit' };
  // This box's device-doc bindings win over the fleet-shared central bindings
  // (PHNX-3315), so a per-box account attachment resolves without touching the
  // shared file. Defaults are genuinely fleet-shared and stay central.
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
  bundle.created_at = readBundleSync(account.name).created_at; // rotate the secret, keep the bundle's birth time
  writeBundleWithItemsSync(bundle, items);
}

/**
 * `oldSelector` is a bare name, a row id, or `<harness>#<name>`. A native row
 * carries its harness, so the new name only has to be free within THAT harness
 * (PHNX-3887 / PHNX-3988): renaming codex's `cxicloud` to `icloud` is fine
 * while claude's `icloud` stays untouched. Provider accounts have no harness
 * and stay globally unique.
 */
export function renameAccount(oldSelector: string, newName: string, base = getUserAgentsDir()): void {
  assertName(newName);
  const meta = readMeta();
  const selector = parseAccountSelector(oldSelector);
  const rows = nativeRowsForNameOrId(meta, selector.name, selector.agent);
  if (rows.length) {
    assertUniqueUnifiedName(newName, meta, undefined, new Set(rows.map(account => account.id)), rows[0]!.agent);
    // Sweep every row for the identity (PHNX-3206) in its owning store (PHNX-3315)
    // and any per-harness default that points to the old name or row ids.
    const rowScope = rows[0]!.scope;
    const renamedAgent = rows[0]!.agent;
    const renamedIds = new Set(rows.map(row => row.id));
    updateMeta(current => {
      const defaults = { ...(current.accounts?.defaults as Record<string, string> | undefined) };
      for (const [agent, value] of Object.entries(defaults)) {
        // Ids are unique so an id match may rewrite any harness's default. A
        // bare-name match must only rewrite THIS harness — two harnesses may
        // legitimately share the same native name (PHNX-3988).
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
  renameBundleSync(account.name, newName); // moves metadata + secret, preserves ACCOUNT_ID
  renameProfileConsumers(account.name, newName, base);
}

/** `selector` is a bare name, a row id, or `<harness>#<name>` (see {@link renameAccount}). */
export function removeAccount(selector: string, base = getUserAgentsDir()): void {
  const meta = readMeta();
  const parsed = parseAccountSelector(selector);
  const rows = nativeRowsForNameOrId(meta, parsed.name, parsed.agent);
  if (rows.length) {
    const bindings = [...new Set(rows.flatMap(row => accountBindings(row.id, meta)))].sort();
    if (bindings.length) throw new Error(`Account '${rows[0]!.name}' is attached to: ${bindings.join(', ')}. Detach it before removing it.`);
    const ids = new Set(rows.map(row => row.id));
    // Sweep every row for the identity (PHNX-3206) from its owning store (PHNX-3315).
    const rowScope = rows[0]!.scope;
    updateMeta(current => {
      // Drop this box's connect-home and slot records for the removed account (PHNX-3940).
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
  // Account bundles are policy `never`, so their value items carry no biometry
  // ACL. Resolve through the bundle path that verifies that policy and attests
  // `silentNoAcl` to the headless keychain guard. Calling getKeychainTokenSync()
  // directly makes a headless --account launch reject the prompt-free item as
  // if it required Touch ID before the helper ever reads it (PHNX-2939).
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

/** The account a spawn should launch under, classified for the exec path. */
export type SpawnAccount =
  | { kind: 'provider'; id: string; name: string; agent: AgentId; env: Record<string, string> }
  | { kind: 'native'; id: string; name: string; agent: AgentId; identityKey: string; scope: 'version' | 'device' };

/**
 * Sync fallback: scan installed version homes to discover a native identity
 * that matches the given email, for accounts that predate the registration
 * system (empty `accounts.native`). Returns a synthetic SpawnAccount or null.
 */
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
  // The binding lookup key. A custom harness passes its own profile/harness name
  // (a run of `deepseek` must find a binding on `deepseek`, not `claude@x`); a
  // native/global run keys on the exact `agent@version` installation.
  const target = opts.target ?? (version ? `${agent}@${version}` : agent);
  const selection = resolveAccountSelection(explicit, agent, meta, { useDefault: opts.useDefault, target });
  if (!selection) return null;
  // Scope the lookup to the harness being launched: a bare identity selector
  // (`claude#muqsitnawaz@gmail.com`) matches every harness that identity is signed
  // into, and only this one can authenticate the spawn.
  let unified = findUnifiedAccount(selection.id, meta, undefined, agent);
  if (!unified && selection.source === 'explicit' && selection.id.includes('@')) {
    unified = discoverUnregisteredNativeAccount(selection.id, agent);
  }
  if (!unified) {
    // A stale per-harness default is a preference, not a hard requirement: the
    // machine stays runnable by falling back to balanced rotation. Bindings and
    // explicit --account are intentional, so they still fail loud.
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
    // A provider-backed custom harness still injects its provider auth env, so a
    // native identity claim over it is incoherent — reject before spawn even when
    // the account is chosen explicitly with --account (which bypasses `attach`).
    if (opts.provider) {
      throw new Error(`Account '${unified.name}' is a native ${unified.agent} login and cannot run under a provider-backed harness (${opts.provider}); the harness's ${opts.provider} credentials would still be injected. Use a matching provider account.`);
    }
    return { kind: 'native', id: unified.id, name: unified.name, agent, identityKey: unified.identityKey, scope: unified.scope };
  }
  const resolved = resolveCredentialAccount(unified.name, agent, opts.provider, opts.base ?? getUserAgentsDir());
  return { kind: 'provider', id: resolved.id, name: resolved.name, agent, env: resolved.env };
}
