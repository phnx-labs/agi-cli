import { ALL_AGENT_IDS, credentialPresence, getAccountInfo, supportsAccountInspection, type AccountInfo } from './agents.js';
import { getGlobalDefault, getVersionHomePath, listInstalledVersions } from './installations/versions.js';
import { readInstallation } from './installations/store.js';
import { readMeta } from './state.js';
import { listNativeAccounts, readAccountRegistry, type CredentialAccount } from './account-registry.js';
import { providerAuthenticatesHarness } from './account-provider-registry.js';
import { readSlots } from './accounts/slots.js';
import { harnessWorkerIsPerDevice } from './harness-auth-capabilities.js';
import { hasKeychainTokenSync, isSecretsTransportError, type SecretsClientError } from './secrets-client.js';
import type { AgentId, Meta } from './types.js';
import { isLaunchableSignedIn as isCredentialLaunchable } from './accounting/rotate.js';
import { authCacheKey, readAuthHealthCache, slotAuthVersionKey, type AuthVerdict } from './auth-health.js';
import { readFleetSharedDeviceStates, type FleetSharedDeviceState } from './fleet-shared-state.js';
import { machineId } from './machine-id.js';
import { isHeadedDeviceRole, selfConfiguredDeviceRole } from './device-config.js';
import {
  applyUsageHonesty,
  collectLocalHarnessInventory,
  type QuotaSummary,
} from './devices/harness-inventory.js';
import {
  fixFor,
  type AccountProvisioning,
  type AccountVerdict,
} from './signin-badge.js';
import {
  formatUsageSummary,
  renderBar,
  viewUsageSummaryOptions,
} from './accounting/usage.js';
import type { UsageInfo, UsageSnapshot } from './accounting/usage.js';
import { padToWidth, stringWidth } from './text/width.js';

export { applyUsageHonesty };
import chalk from 'chalk';

/** Compact usage gauge in the USAGE column — same length as the pre-T3 inline bar. */
const LISTING_USAGE_BAR_LEN = 5;

/**
 * Strict "is this home actually connected?" — a live CREDENTIAL in that exact
 * version home, not just a metadata identity claim (PHNX-3940). A `.claude.json`
 * carrying an `oauthAccount` block with no `.credentials.json`/`.oauth_token`
 * beside it is stale/expired, and must read as `reconnect-needed`, never
 * `connected`. Where agents-cli does not know the credential location
 * (`knownLocation` false), it falls back to the metadata `signedIn` since there
 * is nothing stricter to check.
 */
export function isLaunchableSignedIn(agent: AgentId, versionHome: string, info: Pick<AccountInfo, 'signedIn'>): boolean {
  return isCredentialLaunchable(info.signedIn, credentialPresence(agent, versionHome));
}

export interface NativeAccountCatalogEntry {
  kind: 'native';
  id: string;
  agent: AgentId;
  display: string;
  email: string | null;
  versions: string[];
}

export function groupNativeAccountRows(rows: Array<{ agent: AgentId; version: string; accountKey: string | null; email: string | null; signedIn: boolean }>): NativeAccountCatalogEntry[] {
  const grouped = new Map<string, NativeAccountCatalogEntry>();
  for (const row of rows) {
    if (!row.signedIn) continue;
    const identity = row.accountKey ?? row.email?.toLowerCase();
    if (!identity) continue;
    const key = `${row.agent}:${identity}`;
    const existing = grouped.get(key);
    if (existing) existing.versions.push(row.version);
    else grouped.set(key, {
      kind: 'native',
      id: identity,
      agent: row.agent,
      display: row.email ?? identity,
      email: row.email,
      versions: [row.version],
    });
  }
  return [...grouped.values()].map(entry => ({ ...entry, versions: [...new Set(entry.versions)].sort() }))
    .sort((a, b) => a.agent.localeCompare(b.agent) || a.display.localeCompare(b.display));
}

/** Discover signed-in harness-native identities without copying their auth files. */
export async function discoverNativeAccounts(): Promise<NativeAccountCatalogEntry[]> {
  const rows = await collectNativeHomeRows();
  return groupNativeAccountRows(rows.map(r => ({ agent: r.agent, version: r.label, accountKey: r.accountKey, email: r.email, signedIn: r.signedIn })));
}

// ---------------------------------------------------------------------------
// Account-first read model (PHNX-3940)
//
// `agents accounts` / `agents accounts view` present the ACCOUNT and its
// connection first; the release and home are secondary diagnostics. This model
// is the one place that fold: it groups every installed native home by identity,
// merges the registered account name + connect home, and derives a connection
// state that reflects the LIVE credential rather than the registry label — a
// registered account whose home is signed out reads `reconnect-needed`, never a
// bare `connected`. `view.ts` consumes it so the human list and the per-account
// view share one truth. It is additive; the discovery helpers above stay.
// ---------------------------------------------------------------------------

/** One installed home carrying an identity — the secondary "release/home" facts. */
export interface AccountHome {
  /** The installation label (version-dir basename). */
  label: string;
  /** The vendor release the home currently carries, when the record is present. */
  releaseVersion: string | null;
  /** Whether this exact home currently has a live signed-in credential. */
  signedIn: boolean;
}

/**
 * A live credential state, derived from the homes rather than the registry:
 * - `connected` — at least one home for this identity is signed in.
 * - `reconnect-needed` — the account is registered but no home currently
 *   holds a live credential; the label alone is not a connection.
 *   `agents accounts login <harness>#<name>` re-authenticates it.
 */
export type AccountConnectionState = 'connected' | 'reconnect-needed';

/** Account-first row for a native (harness-owned OAuth) identity. */
export interface NativeAccountCatalogRow {
  kind: 'native';
  agent: AgentId;
  identityKey: string;
  /** Registered account name/label, or null for an unnamed discovered login. */
  name: string | null;
  /** Registered stable account id, or null when unnamed. */
  id: string | null;
  email: string | null;
  display: string;
  /**
   * The LOCAL installation home for this identity on THIS box: the recorded
   * connect home when installed here, else the local home carrying the login.
   * Null when no local home exists (the identity may be connected on another
   * box). Per-host by construction — never a label another box minted.
   */
  home: string | null;
  /** Every installed home carrying this identity (secondary diagnostics). */
  installations: AccountHome[];
  /** Whether the harness's configured default account points at this identity. */
  isDefault: boolean;
  state: AccountConnectionState;
  identityLabel: string;
  provisioning: AccountProvisioning;
  verdict: AccountVerdict;
  checkedAt: string | null;
  devices: AccountDeviceVerdict[];
  usage: QuotaSummary | null;
  /**
   * The live usage snapshot backing `usage`, or null when none was collected.
   * Carried alongside the collapsed `QuotaSummary` so the per-window bars
   * (S: session 5h, W: week 7d, etc.) can render via the canonical
   * `formatUsageSummary` / `pickCompactUsageWindows` path instead of the
   * single max-percent bar. Added non-breaking: JSON clients keep `usage`
   * and may read this when present.
   */
  usageSnapshot?: UsageSnapshot | null;
  /** Raw usage fetch error, for headless/unverified labeling alongside the bars. */
  usageError?: string | null;
  fix: string | null;
}

export interface AccountDeviceVerdict {
  device: string;
  authMode: 'native' | 'durable' | 'per-device';
  verdict: Exclude<AccountVerdict, 'per-device'>;
  checkedAt?: string;
}

/** Account-first row for a durable provider (API-key / token) account. */
export interface ProviderAccountCatalogRow {
  kind: 'provider';
  name: string;
  id: string;
  provider: string;
  auth: string;
  baseUrl?: string;
  /** Harnesses this credential can authenticate. Empty = listed under Other accounts. */
  harnesses: AgentId[];
  /** Harnesses whose configured default points at this account. */
  defaultFor: AgentId[];
  identityLabel: string;
  verdict: Extract<AccountVerdict, 'ready' | 'missing'>;
  fix: string | null;
}

export type AccountCatalogRow = NativeAccountCatalogRow | ProviderAccountCatalogRow;

export interface AccountCatalog {
  native: NativeAccountCatalogRow[];
  provider: ProviderAccountCatalogRow[];
  /**
   * Set when the standalone `secrets` CLI could not be reached to read the
   * provider (durable-credential) accounts — missing, unreachable, or timed out
   * on this box. The native rows (harness OAuth logins, read from config files,
   * not `secrets`) still render; only the provider section is unavailable. A
   * read-only surface (`agents view`, `agents accounts`) surfaces this as one
   * clear line and renders the rest rather than hanging or crashing (PHNX-3989).
   */
  secretsUnavailable?: { code: string; message: string };
}

/**
 * The provider (durable-credential) accounts read through `secrets`, tolerant of
 * an unreachable standalone. Native OAuth logins never touch `secrets`, so a
 * missing/broken standalone must NOT take down the whole account view — the
 * provider section is simply reported unavailable. Only a TRANSPORT-level
 * failure (missing binary, timeout, non-JSON, spawn error) degrades; a genuine
 * data error still throws so it is never silently swallowed. DIST-1 holds: there
 * is no fallback to an embedded engine, the standalone just could not answer.
 */
function readProviderRowsTolerant(meta: Meta): {
  rows: ProviderAccountCatalogRow[];
  error: SecretsClientError | null;
} {
  try {
    const rows = Object.values(readAccountRegistry().accounts)
      .map((account) => toProviderRow(account, meta))
      .sort((a, b) => a.name.localeCompare(b.name));
    return { rows, error: null };
  } catch (err) {
    if (isSecretsTransportError(err)) return { rows: [], error: err };
    throw err;
  }
}

/**
 * One account in the public JSON v2 projection (`accounts list --json`, `view --json`).
 * A provider credential that authenticates several harnesses is one entry per
 * harness (same `id`, each with its own `harness`); an orphan is `harness: null`.
 */
export interface AccountListEntryJson {
  kind: 'native' | 'provider';
  id: string;
  /** Null for a provider credential no harness authenticates. */
  harness: AgentId | null;
  name: string | null;
  identityLabel: string;
  isDefault: boolean;
  provisioning: AccountProvisioning;
  verdict: AccountVerdict;
  checkedAt: string | null;
  devices: Array<{
    device: string;
    authMode: AccountDeviceVerdict['authMode'];
    verdict: AccountDeviceVerdict['verdict'];
  }>;
  usage: QuotaSummary | null;
  /** The live usage snapshot backing `usage`, when available — additive, not breaking. */
  usageSnapshot?: UsageSnapshot | null;
  usageError?: string | null;
  fix: string | null;
}

export interface AccountListJson {
  version: 2;
  accounts: AccountListEntryJson[];
}

/** One installed home probed for its native identity — the raw input to the fold. */
export interface NativeHomeRow {
  agent: AgentId;
  label: string;
  releaseVersion: string | null;
  accountKey: string | null;
  email: string | null;
  signedIn: boolean;
}

/** Probe every installed home of every inspectable harness for its native identity. */
export async function collectNativeHomeRows(): Promise<NativeHomeRow[]> {
  const rows: NativeHomeRow[] = [];
  for (const agent of ALL_AGENT_IDS.filter(supportsAccountInspection)) {
    for (const label of listInstalledVersions(agent)) {
      const home = getVersionHomePath(agent, label);
      const info = await getAccountInfo(agent, home);
      rows.push({
        agent,
        label,
        releaseVersion: readInstallation(agent, label)?.releaseVersion ?? null,
        accountKey: info.accountKey,
        email: info.email,
        // Strict: a live credential in THIS home, not a bare metadata identity.
        signedIn: isLaunchableSignedIn(agent, home, info),
      });
    }
  }
  return rows;
}

/** The subset of Meta the pure builder reads — the registered native accounts + defaults. */
type CatalogMeta = Pick<Meta, 'accounts' | 'deviceAccounts'>;

/**
 * Fold installed homes + the registry into account-first native rows (pure).
 *
 * Every home carrying an identity contributes an `AccountHome`; the identity is
 * the group key. A registered account (name/id/connect home) is merged onto its
 * identity, and — crucially — a registered account whose identity has NO live
 * home still appears, as `reconnect-needed`, so a stale/expired login is never
 * silently dropped from the list nor shown as connected.
 */
export function buildNativeCatalog(
  rows: NativeHomeRow[],
  meta: CatalogMeta,
  globalDefault: (agent: AgentId) => string | null = getGlobalDefault,
): NativeAccountCatalogRow[] {
  const registered = listNativeAccounts(meta);
  const defaults = meta.accounts?.defaults ?? {};

  interface Group {
    agent: AgentId;
    identityKey: string;
    email: string | null;
    homes: AccountHome[];
  }
  const groups = new Map<string, Group>();
  const keyOf = (agent: AgentId, identity: string) => `${agent}:${identity}`;

  // Every installed home that carries a resolvable identity seeds a group.
  for (const row of rows) {
    const identity = row.accountKey ?? row.email?.toLowerCase();
    if (!identity) continue;
    const key = keyOf(row.agent, identity);
    const group = groups.get(key) ?? { agent: row.agent, identityKey: identity, email: null, homes: [] };
    group.email ??= row.email;
    group.homes.push({ label: row.label, releaseVersion: row.releaseVersion, signedIn: row.signedIn });
    groups.set(key, group);
  }

  // A registered account whose identity has no discovered home still belongs in
  // the catalog — it just has nothing live to connect through yet. Its
  // `identityKey` is the same value a home row groups on (a raw accountKey, or
  // an already-lowercased email), so an exact-key check finds the existing group.
  for (const account of registered) {
    const key = keyOf(account.agent, account.identityKey);
    if (!groups.has(key)) {
      groups.set(key, { agent: account.agent, identityKey: account.identityKey, email: account.identityLabel ?? null, homes: [] });
    }
  }

  const out: NativeAccountCatalogRow[] = [];
  for (const group of groups.values()) {
    const account = registered.find(a => a.agent === group.agent && a.identityKey === group.identityKey);
    const email = group.email ?? account?.identityLabel ?? null;
    const homes = [...group.homes].sort((a, b) => a.label.localeCompare(b.label));
    const signedIn = homes.some(h => h.signedIn);

    // The configured per-harness account default is AUTHORITATIVE: when present,
    // only the matching native account is the default — an explicit default that
    // names a provider (or a stale name) never invents a native default. Only
    // when NO account default is configured does the global-default installation
    // home decide (diagnostic fallback).
    const defaultRef = defaults[group.agent];
    let isDefault: boolean;
    if (defaultRef !== undefined) {
      isDefault = !!account && (account.name === defaultRef || account.id === defaultRef);
    } else {
      const gd = globalDefault(group.agent);
      isDefault = !!gd && homes.some(h => h.label === gd);
    }

    // The home is a PER-HOST fact: this box's recorded connect home when it is
    // actually installed here, else the local home carrying the identity. A home
    // label recorded on another box is never assumed to exist locally.
    const recordedHome = account ? (meta.deviceAccounts?.homes?.[account.id] ?? null) : null;
    const home = (recordedHome && homes.some(h => h.label === recordedHome))
      ? recordedHome
      : (homes.find(h => h.signedIn)?.label ?? homes[0]?.label ?? null);

    out.push({
      kind: 'native',
      agent: group.agent,
      identityKey: group.identityKey,
      name: account?.name ?? null,
      id: account?.id ?? null,
      email,
      display: email ?? account?.name ?? group.identityKey,
      home,
      installations: homes,
      isDefault,
      state: signedIn ? 'connected' : 'reconnect-needed',
      identityLabel: email ?? account?.name ?? group.identityKey,
      provisioning: provisioningFor(group.agent),
      verdict: signedIn ? 'unverified' : 'missing',
      checkedAt: null,
      devices: [],
      usage: null,
      usageSnapshot: null,
      usageError: null,
      fix: fixFor({
        agent: group.agent,
        verdict: signedIn ? 'unverified' : 'missing',
        name: account?.name,
        version: home,
        provisioning: provisioningFor(group.agent),
      }),
    });
  }
  // Named accounts first, then default, then a stable display order.
  return out.sort((a, b) =>
    a.agent.localeCompare(b.agent)
    || Number(!!b.name) - Number(!!a.name)
    || Number(b.isDefault) - Number(a.isDefault)
    || a.display.localeCompare(b.display));
}

function provisioningFor(agent: AgentId): AccountProvisioning {
  return harnessWorkerIsPerDevice(agent) ? 'per-device' : 'portable';
}

export function toProviderRow(account: CredentialAccount, meta: Pick<Meta, 'accounts'>): ProviderAccountCatalogRow {
  const harnesses = ALL_AGENT_IDS.filter((agent) =>
    providerAuthenticatesHarness(account.provider, account.auth, agent));
  const defaults = meta.accounts?.defaults ?? {};
  const defaultFor = ALL_AGENT_IDS.filter((agent) => {
    const ref = defaults[agent];
    return ref === account.name || ref === account.id;
  });
  const secretPresent = hasKeychainTokenSync(account.secretRef);
  return {
    kind: 'provider',
    name: account.name,
    id: account.id,
    provider: account.provider,
    auth: account.auth,
    ...(account.baseUrl ? { baseUrl: account.baseUrl } : {}),
    harnesses,
    defaultFor,
    identityLabel: account.provider,
    verdict: secretPresent ? 'ready' : 'missing',
    fix: secretPresent ? null : `agents accounts set-key ${account.name}`,
  };
}

/**
 * Wire the real collectors to the pure builder. This is the canonical
 * account-first read model `view.ts` renders: native identities (account +
 * connection first, release/home secondary) plus durable provider credentials.
 */
export async function loadAccountCatalog(): Promise<AccountCatalog> {
  const meta = readMeta();
  const native = buildNativeCatalog(await collectNativeHomeRows(), meta);
  const host = machineId();
  const auth = readAuthHealthCache();
  const inventory = await collectLocalHarnessInventory();
  const inventoryByHome = new Map(inventory.map((row) => [`${row.agent}:${row.version}`, row]));
  const shared = readSharedAccountVerdicts();
  const headed = isHeadedDeviceRole(selfConfiguredDeviceRole());
  const localSlots = readSlots(meta);

  for (const row of native) {
    const registered = row.id ? listNativeAccounts(meta).find((account) => account.id === row.id) : undefined;
    row.provisioning = registered?.provisioning ?? provisioningFor(row.agent);

    const localHome = row.installations.find((home) => home.label === row.home)
      ?? row.installations.find((home) => home.signedIn)
      ?? row.installations[0];
    const slot = row.id ? localSlots[row.id] : undefined;
    // A slot account's local truth is the SLOT — its own credential file and its
    // own daemon probe row (keyed `slot:<id>`) — never the version home its label
    // happens to match. Reading the version home here is what rendered a
    // signed-in slot MISSING: the slot record held ensureSlot's `unconfigured`
    // default, the daemon never probed the slot, and `signedIn` came from an
    // unrelated home.
    const slotSignedIn = slot
      ? await getAccountInfo(row.agent, slot.slotDir)
          .then((info) => isLaunchableSignedIn(row.agent, slot.slotDir, info))
          .catch(() => false)
      : false;
    const cached = (slot && row.id ? auth[authCacheKey(host, row.agent, slotAuthVersionKey(row.id))] : undefined)
      ?? (localHome ? auth[authCacheKey(host, row.agent, localHome.label)] : undefined);
    const observation = resolveLocalAccountObservation(slot, cached, slot ? slotSignedIn : localHome?.signedIn === true);
    const local: AccountDeviceVerdict = {
      device: host,
      authMode: observation.authMode
        ?? (row.provisioning === 'per-device' ? 'per-device' : (headed ? 'native' : 'durable')),
      verdict: observation.verdict,
      ...(observation.checkedAt ? { checkedAt: observation.checkedAt } : {}),
    };
    // Registered accounts join fleet state on their stable id ONLY — two
    // accounts may share one email label, so a label join would cross-attribute
    // one account's revoked verdict to the other. The label index exists solely
    // for unnamed legacy logins, which have no registry id to key on.
    const fromFleet = row.id
      ? (shared.get(`${row.agent}:${row.id}`) ?? [])
      : (shared.get(`label:${row.agent}:${row.identityLabel}`) ?? []);
    row.devices = mergeDeviceVerdicts(fromFleet, local);
    row.verdict = aggregateAccountVerdict(row.provisioning, row.devices);
    row.checkedAt = newestCheckedAt(row.devices);
    const honest = applyUsageHonesty(
      row.verdict,
      localHome ? (inventoryByHome.get(`${row.agent}:${localHome.label}`)?.quota ?? null) : null,
    );
    row.verdict = honest.verdict;
    row.usage = honest.usage;
    const inv = localHome ? inventoryByHome.get(`${row.agent}:${localHome.label}`) : undefined;
    row.usageSnapshot = inv?.snapshot ?? null;
    row.usageError = inv?.usageError ?? null;
    row.fix = fixFor({
      agent: row.agent,
      verdict: row.verdict,
      name: row.name,
      version: localHome?.label,
      provisioning: row.provisioning,
      hasSlot: slot != null,
    });
  }
  const { rows: provider, error } = readProviderRowsTolerant(meta);
  return error
    ? { native, provider, secretsUnavailable: { code: error.code, message: error.message } }
    : { native, provider };
}

/**
 * The one clear line a read-only surface prints when the provider section could
 * not be read (PHNX-3989) — so a missing/broken standalone is stated plainly
 * while the native rows and the rest of the output still render. Null when the
 * catalog is complete. Printed to stderr by the command so it never corrupts
 * `--json` stdout.
 */
export function secretsUnavailableNote(catalog: Pick<AccountCatalog, 'secretsUnavailable'>): string | null {
  const err = catalog.secretsUnavailable;
  if (!err) return null;
  return `secrets unavailable (${err.code}) — provider accounts not shown; native logins and the rest are current.`;
}

function providerListEntry(
  row: ProviderAccountCatalogRow,
  harness: AgentId | null,
): AccountListEntryJson {
  return {
    kind: 'provider',
    id: row.id,
    harness,
    name: row.name,
    identityLabel: row.identityLabel,
    isDefault: harness ? row.defaultFor.includes(harness) : false,
    provisioning: 'portable',
    verdict: row.verdict,
    checkedAt: null,
    devices: [],
    usage: null,
    fix: row.fix,
  };
}

/**
 * Unfiltered JSON emits one entry per harness the credential authenticates
 * (same `id`, `kind: 'provider'`, each with its own `harness`), plus one
 * `harness: null` entry for an orphan. A harness filter emits only that
 * harness's entry. The v2 field set is otherwise unchanged.
 */
function providerJsonEntries(
  row: ProviderAccountCatalogRow,
  harness?: AgentId,
): AccountListEntryJson[] {
  if (harness) {
    return row.harnesses.includes(harness) ? [providerListEntry(row, harness)] : [];
  }
  if (row.harnesses.length === 0) return [providerListEntry(row, null)];
  return row.harnesses.map((agent) => providerListEntry(row, agent));
}

export function accountListJson(
  native: NativeAccountCatalogRow[],
  providers: ProviderAccountCatalogRow[] = [],
  harness?: AgentId,
): AccountListJson {
  return {
    version: 2,
    accounts: [
      ...native.map((row) => ({
        kind: 'native' as const,
        id: row.id ?? row.identityKey,
        harness: row.agent,
        name: row.name,
        identityLabel: row.identityLabel,
        isDefault: row.isDefault,
        provisioning: row.provisioning,
        verdict: row.verdict,
        checkedAt: row.checkedAt,
        devices: row.devices.map(({ device, authMode, verdict }) => ({ device, authMode, verdict })),
        usage: row.usage,
        ...(row.usageSnapshot ? { usageSnapshot: row.usageSnapshot } : {}),
        ...(row.usageError ? { usageError: row.usageError } : {}),
        fix: row.fix,
      })),
      ...providers.flatMap((row) => providerJsonEntries(row, harness)),
    ],
  };
}

function verdictText(verdict: AccountVerdict): string {
  if (verdict === 'rate_limited') return 'LIMITED';
  return verdict.toUpperCase();
}

function whereText(row: NativeAccountCatalogRow, localDevice: string): string {
  const names = [...new Set(row.devices.map((device) => device.device))];
  // Peers on an older release do not publish slot verdicts, so the only
  // observation is this box — say so rather than a coverage count of +1.
  if (names.length === 1 && names[0] === localDevice) return 'this box';
  const live = row.devices.filter((device) => device.verdict === 'live').length;
  if (live > 0) return `+${live}`;
  if (row.provisioning === 'per-device') {
    const present = row.devices
      .filter((device) => device.verdict !== 'missing')
      .map((device) => device.device);
    return present.join(', ') || 'this box';
  }
  return '—';
}

export const OVERVIEW_MAX_USAGE_WINDOWS = 2;

function usageText(row: NativeAccountCatalogRow, maxWindows?: number): string {
  if (row.usageSnapshot) {
    const usageInfo: UsageInfo = { snapshot: row.usageSnapshot, error: row.usageError ?? null };
    return formatUsageSummary(
      null,
      usageInfo.snapshot,
      3,
      viewUsageSummaryOptions(row.agent, row.state === 'connected', usageInfo, maxWindows),
    );
  }
  if (row.usage?.status === 'rate_limited' && (row.usage.usedPercent === null || row.usage.usedPercent === undefined)) {
    return 'limited';
  }
  if (row.usage?.status === 'out_of_credits') return 'no credits';
  if (row.usage?.usedPercent === null || row.usage?.usedPercent === undefined) return '';
  const percent = `${row.usage.usedPercent}%${row.usage.stale ? '*' : ''}`;
  return `${renderBar(row.usage.usedPercent, LISTING_USAGE_BAR_LEN)} ${percent}`;
}

interface ListingLine {
  name: string;
  identityLabel: string;
  verdict: AccountVerdict;
  where: string;
  fix: string | null;
  usage: string;
  isDefault: boolean;
}

function nativeLine(row: NativeAccountCatalogRow, localDevice: string, maxWindows?: number): ListingLine {
  return {
    name: row.name ?? 'unnamed',
    identityLabel: row.identityLabel,
    verdict: row.verdict,
    where: whereText(row, localDevice),
    fix: row.fix,
    usage: usageText(row, maxWindows),
    isDefault: row.isDefault,
  };
}

function providerLine(row: ProviderAccountCatalogRow, harness?: AgentId): ListingLine {
  return {
    name: row.name,
    identityLabel: row.identityLabel,
    verdict: row.verdict,
    where: '—',
    fix: row.fix,
    usage: '',
    isDefault: harness ? row.defaultFor.includes(harness) : false,
  };
}

function formatListingLine(
  line: ListingLine,
  nameW: number,
  identityW: number,
  stateW: number,
  whereW: number,
  usageW: number,
): string {
  const marker = line.isDefault ? '*' : ' ';
  const fix = line.fix ? `fix: ${line.fix}` : '';
  return (
    `  ${chalk.green(marker)} ${chalk.cyan(line.name.padEnd(nameW))}  `
    + `${line.identityLabel.padEnd(identityW)}  `
    + `${verdictText(line.verdict).padEnd(stateW)}  `
    + `${line.where.padEnd(whereW)}  `
    + `${padToWidth(line.usage, usageW)}  `
    + `${fix ? chalk.gray(fix) : ''}`
  ).trimEnd();
}

function pushGroup(
  out: string[],
  title: string,
  lines: ListingLine[],
  widths: { nameW: number; identityW: number; stateW: number; whereW: number; usageW: number },
  harnessHeadings: boolean,
): void {
  if (lines.length === 0) return;
  if (harnessHeadings) out.push(chalk.bold(title));
  out.push(chalk.gray(
    `  ${'ACCOUNT'.padEnd(widths.nameW + 2)}${'IDENTITY'.padEnd(widths.identityW + 2)}${'STATE'.padEnd(widths.stateW + 2)}${'WHERE'.padEnd(widths.whereW + 2)}${'USAGE'.padEnd(widths.usageW + 2)}FIX`,
  ));
  for (const line of lines) {
    out.push(formatListingLine(line, widths.nameW, widths.identityW, widths.stateW, widths.whereW, widths.usageW));
  }
  out.push('');
}

/** Shared text renderer used by both `accounts list` and account-first `view`. */
export function renderAccountRows(
  rows: NativeAccountCatalogRow[],
  opts: {
    heading?: boolean;
    footer?: boolean;
    harnessHeadings?: boolean;
    providers?: ProviderAccountCatalogRow[];
    /** When set, emit only this harness's group — never a sibling or empty group. */
    harness?: AgentId;
    /**
     * Cap for compact usage windows — overview (no harness filter) passes 2,
     * single-harness view leaves it undefined to show all blocking windows.
     * Mirrors `OVERVIEW_MAX_USAGE_WINDOWS` in view.ts.
     */
    maxUsageWindows?: number;
    /**
     * Device name treated as "this box" in WHERE when it is the only reporter.
     * The command layer passes `machineId()`; this renderer never resolves it.
     */
    localDevice: string;
  },
): string {
  const heading = opts.heading !== false;
  const footer = opts.footer !== false;
  const harnessHeadings = opts.harnessHeadings !== false;
  const providers = opts.providers ?? [];
  const harnessFilter = opts.harness;
  const localDevice = opts.localDevice;
  const out: string[] = [];
  if (heading) out.push(`${chalk.bold('Accounts')}  ${chalk.gray('run: agents run <h>#<name>')}`, '');
  const visibleProviders = harnessFilter
    ? providers.filter((row) => row.harnesses.includes(harnessFilter))
    : providers;
  const visibleNative = harnessFilter
    ? rows.filter((row) => row.agent === harnessFilter)
    : rows;
  if (visibleNative.length === 0 && visibleProviders.length === 0) {
    out.push(chalk.gray('No accounts found. Add one: agents accounts add <harness> [name]'));
  } else {
    const harnesses = new Set<AgentId>();
    for (const row of visibleNative) harnesses.add(row.agent);
    for (const row of visibleProviders) {
      for (const agent of row.harnesses) {
        if (!harnessFilter || agent === harnessFilter) harnesses.add(agent);
      }
    }
    const maxWindows = opts.maxUsageWindows ?? (opts.harness ? undefined : OVERVIEW_MAX_USAGE_WINDOWS);
    const grouped = new Map<AgentId, ListingLine[]>();
    for (const harness of [...harnesses].sort((a, b) => a.localeCompare(b))) {
      const lines = [
        ...visibleNative.filter((row) => row.agent === harness).map((row) => nativeLine(row, localDevice, maxWindows)),
        ...visibleProviders.filter((row) => row.harnesses.includes(harness)).map((row) => providerLine(row, harness)),
      ];
      if (lines.length === 0) continue;
      grouped.set(harness, lines);
    }
    const orphans = harnessFilter
      ? []
      : visibleProviders.filter((row) => row.harnesses.length === 0).map((row) => providerLine(row));
    const allLines = [...grouped.values()].flat().concat(orphans);
    const widths = {
      nameW: Math.max(7, ...allLines.map((line) => line.name.length)),
      identityW: Math.max(8, ...allLines.map((line) => line.identityLabel.length)),
      stateW: Math.max(5, ...allLines.map((line) => verdictText(line.verdict).length)),
      whereW: Math.max(5, ...allLines.map((line) => line.where.length)),
      usageW: Math.max(5, ...allLines.map((line) => stringWidth(line.usage))),
    };
    for (const [harness, lines] of grouped) {
      pushGroup(out, harness, lines, widths, harnessHeadings);
    }
    if (orphans.length > 0) pushGroup(out, 'Other accounts', orphans, widths, true);
  }
  if (footer) {
    // "Need you" is an actionable repair, not an unread usage probe. Unverified
    // (a worker whose token lacks the usage scope) has no fix and must not
    // inflate the count.
    const count = visibleNative.filter((row) => !!row.fix).length
      + visibleProviders.filter((row) => !!row.fix).length;
    out.push(chalk.gray(`${count} accounts need you · add: agents accounts add <harness>`));
  }
  return out.join('\n').trimEnd();
}

interface SharedAccountVerdictRow {
  accountId: string;
  identityLabel?: string;
  harness: AgentId;
  authMode: AccountDeviceVerdict['authMode'];
  verdict: AccountDeviceVerdict['verdict'];
  checkedAt?: string;
}

type AccountStateEnvelope = FleetSharedDeviceState & {
  accounts?: { rows?: SharedAccountVerdictRow[] };
};

export function readSharedAccountVerdicts(
  userAgentsDir?: string,
): Map<string, AccountDeviceVerdict[]> {
  const out = new Map<string, AccountDeviceVerdict[]>();
  for (const state of readFleetSharedDeviceStates(userAgentsDir).states as AccountStateEnvelope[]) {
    for (const row of state.accounts?.rows ?? []) {
      if (!ALL_AGENT_IDS.includes(row.harness)) continue;
      if (!['native', 'durable', 'per-device'].includes(row.authMode)) continue;
      if (!['live', 'expired', 'revoked', 'rate_limited', 'unverified', 'missing'].includes(row.verdict)) continue;
      const key = `${row.harness}:${row.accountId}`;
      const values = out.get(key) ?? [];
      values.push({
        device: state.device,
        authMode: row.authMode,
        verdict: row.verdict,
        ...(row.checkedAt ? { checkedAt: row.checkedAt } : {}),
      });
      out.set(key, values);
      if (row.identityLabel) out.set(`label:${row.harness}:${row.identityLabel}`, values);
    }
  }
  return out;
}

/**
 * Devices whose daemon-state file exists but carries no account verdicts —
 * typically an older release that has not started publishing the T3 envelope.
 * The fleet matrix lists them in a coverage note rather than as blank columns.
 */
export function listDevicesWithoutAccountVerdicts(
  userAgentsDir?: string,
): string[] {
  const out: string[] = [];
  for (const state of readFleetSharedDeviceStates(userAgentsDir).states as AccountStateEnvelope[]) {
    if (!state.accounts?.rows?.length) out.push(state.device);
  }
  return out.sort((a, b) => a.localeCompare(b));
}

function normalizeAuthVerdict(
  verdict: AuthVerdict | undefined,
  signedIn: boolean,
): AccountDeviceVerdict['verdict'] {
  // `unconfigured` is the slot record's DEFAULT (ensureSlot), not a probe
  // result — the daemon never publishes it (probeLocalFleetAuth drops those
  // rows). So it says nothing about the credential on disk; the live signedIn
  // read of the slot decides, exactly as it does when no verdict exists at all.
  if (verdict === 'unconfigured') return signedIn ? 'unverified' : 'missing';
  if (verdict === 'error') return signedIn ? 'unverified' : 'missing';
  return verdict ?? (signedIn ? 'unverified' : 'missing');
}

/** The T1 slot store's per-account observation of the local verdict. */
export interface LocalSlotObservation {
  authMode: AccountDeviceVerdict['authMode'];
  verdict: AuthVerdict;
  checkedAt?: string;
}

/**
 * Merge the two writers of the same local truth — the T1 slot store and the
 * daemon's auth-health cache — by NEWEST observation. A naive `??` chain lets
 * an older slot `live` permanently mask a newer daemon `revoked`, so a revoked
 * account would keep rendering LIVE on its own device. Pure.
 */
export function resolveLocalAccountObservation(
  slot: LocalSlotObservation | undefined,
  cached: { verdict: AuthVerdict; checkedAt: number } | undefined,
  signedIn: boolean,
): {
  verdict: AccountDeviceVerdict['verdict'];
  authMode?: AccountDeviceVerdict['authMode'];
  checkedAt?: string;
} {
  const slotAt = slot?.checkedAt ? Date.parse(slot.checkedAt) : null;
  const cachedAt = cached?.checkedAt ?? null;
  const preferSlot = !!slot && (!cached || (slotAt !== null && (cachedAt === null || slotAt >= cachedAt)));
  return {
    verdict: normalizeAuthVerdict((preferSlot ? slot : cached)?.verdict, signedIn),
    ...(preferSlot && slot?.authMode ? { authMode: slot.authMode } : {}),
    ...(preferSlot && slot?.checkedAt
      ? { checkedAt: slot.checkedAt }
      : !preferSlot && cached ? { checkedAt: new Date(cached.checkedAt).toISOString() } : {}),
  };
}

function mergeDeviceVerdicts(
  fleet: AccountDeviceVerdict[],
  local: AccountDeviceVerdict,
): AccountDeviceVerdict[] {
  const byDevice = new Map(fleet.map((row) => [row.device, row]));
  byDevice.set(local.device, local);
  return [...byDevice.values()].sort((a, b) => a.device.localeCompare(b.device));
}

function aggregateAccountVerdict(
  provisioning: AccountProvisioning,
  devices: AccountDeviceVerdict[],
): AccountVerdict {
  const verdicts = devices.map((row) => row.verdict);
  if (verdicts.includes('revoked')) return 'revoked';
  if (verdicts.includes('expired')) return 'expired';
  if (verdicts.includes('rate_limited')) return 'rate_limited';
  if (verdicts.includes('live')) return 'live';
  if (verdicts.includes('unverified')) return 'unverified';
  return provisioning === 'per-device' ? 'per-device' : 'missing';
}

function newestCheckedAt(devices: AccountDeviceVerdict[]): string | null {
  return devices
    .map((row) => row.checkedAt)
    .filter((value): value is string => !!value)
    .sort((a, b) => Date.parse(b) - Date.parse(a))[0] ?? null;
}
