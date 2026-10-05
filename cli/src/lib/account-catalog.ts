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
import * as fs from 'fs';
import * as path from 'path';
import { authCacheKey, formatAuthFact, readAuthHealthCache, slotAuthVersionKey, type AuthHealth, type AuthVerdict } from './auth-health.js';
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
  usageErrorForDisplay,
  viewUsageSummaryOptions,
} from './accounting/usage.js';
import type { UsageInfo, UsageSnapshot } from './accounting/usage.js';
import { padToWidth, stringWidth } from './text/width.js';

export { applyUsageHonesty };
import chalk from 'chalk';

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

interface NativeAccountCatalogEntry {
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

export async function discoverNativeAccounts(): Promise<NativeAccountCatalogEntry[]> {
  const rows = await collectNativeHomeRows();
  return groupNativeAccountRows(rows.map(r => ({ agent: r.agent, version: r.label, accountKey: r.accountKey, email: r.email, signedIn: r.signedIn })));
}


export interface AccountHome {
  label: string;
  releaseVersion: string | null;
  signedIn: boolean;
}

export type AccountConnectionState = 'connected' | 'reconnect-needed';

export interface NativeAccountCatalogRow {
  kind: 'native';
  agent: AgentId;
  identityKey: string;
  name: string | null;
  id: string | null;
  email: string | null;
  display: string;
  home: string | null;
  installations: AccountHome[];
  isDefault: boolean;
  state: AccountConnectionState;
  identityLabel: string;
  provisioning: AccountProvisioning;
  verdict: AccountVerdict;
  checkedAt: string | null;
  devices: AccountDeviceVerdict[];
  usage: QuotaSummary | null;
  usageSnapshot?: UsageSnapshot | null;
  usageError?: string | null;
  /**
   * The token FACT for this account ON THIS BOX (PHNX-4116): the credential kind
   * plus its file date — `sk-ant-oat01 (Sep 16)` for a Claude slot's
   * `.claude/.oauth_token`, `api key (present)` for a provider-key harness — or
   * `no token` when the credential file is absent. A fact, never a verdict word.
   */
  token: string;
  lastAuth: string;
  fix: string | null;
}

export interface AccountDeviceVerdict {
  device: string;
  authMode: 'native' | 'durable' | 'per-device';
  verdict: Exclude<AccountVerdict, 'per-device'>;
  checkedAt?: string;
}

export interface ProviderAccountCatalogRow {
  kind: 'provider';
  name: string;
  id: string;
  provider: string;
  auth: string;
  baseUrl?: string;
  harnesses: AgentId[];
  defaultFor: AgentId[];
  identityLabel: string;
  verdict: Extract<AccountVerdict, 'ready' | 'missing'>;
  fix: string | null;
}

interface AccountCatalog {
  native: NativeAccountCatalogRow[];
  provider: ProviderAccountCatalogRow[];
  secretsUnavailable?: { code: string; message: string };
}

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
    // Degrade only standalone-secrets transport failures; data errors fail loud with no embedded fallback.
    if (isSecretsTransportError(err)) return { rows: [], error: err };
    throw err;
  }
}

export interface AccountListEntryJson {
  kind: 'native' | 'provider';
  id: string;
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
  usageSnapshot?: UsageSnapshot | null;
  usageError?: string | null;
  token: string;
  lastAuth: string;
  fix: string | null;
}

interface AccountListJson {
  version: 2;
  accounts: AccountListEntryJson[];
}

export interface NativeHomeRow {
  agent: AgentId;
  label: string;
  releaseVersion: string | null;
  accountKey: string | null;
  email: string | null;
  signedIn: boolean;
}

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
        signedIn: isLaunchableSignedIn(agent, home, info),
      });
    }
  }
  return rows;
}

type CatalogMeta = Pick<Meta, 'accounts' | 'deviceAccounts'>;

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

  for (const row of rows) {
    const identity = row.accountKey ?? row.email?.toLowerCase();
    if (!identity) continue;
    const key = keyOf(row.agent, identity);
    const group = groups.get(key) ?? { agent: row.agent, identityKey: identity, email: null, homes: [] };
    group.email ??= row.email;
    group.homes.push({ label: row.label, releaseVersion: row.releaseVersion, signedIn: row.signedIn });
    groups.set(key, group);
  }

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

    const defaultRef = defaults[group.agent];
    let isDefault: boolean;
    if (defaultRef !== undefined) {
      isDefault = !!account && (account.name === defaultRef || account.id === defaultRef);
    } else {
      const gd = globalDefault(group.agent);
      isDefault = !!gd && homes.some(h => h.label === gd);
    }

    const recordedHome = account ? (meta.deviceAccounts?.homes?.[account.id] ?? null) : null;
    const home = (recordedHome && homes.some(h => h.label === recordedHome))
      ? recordedHome
      : (homes.find(h => h.signedIn)?.label ?? homes[0]?.label ?? null);

    // Credential presence without a probe is no_evidence, never claimed verification.
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
      verdict: signedIn ? 'no_evidence' : 'missing',
      checkedAt: null,
      devices: [],
      usage: null,
      usageSnapshot: null,
      usageError: null,
      token: 'no token',
      lastAuth: 'not used on this box yet',
      fix: fixFor({
        agent: group.agent,
        verdict: signedIn ? 'no_evidence' : 'missing',
        name: account?.name,
        version: home,
        provisioning: provisioningFor(group.agent),
      }),
    });
  }
  return out.sort((a, b) =>
    a.agent.localeCompare(b.agent)
    || Number(!!b.name) - Number(!!a.name)
    || Number(b.isDefault) - Number(a.isDefault)
    || a.display.localeCompare(b.display));
}

function provisioningFor(agent: AgentId): AccountProvisioning {
  return harnessWorkerIsPerDevice(agent) ? 'per-device' : 'portable';
}

const TOKEN_FACT_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function tokenFileDate(mtimeMs: number): string {
  const d = new Date(mtimeMs);
  return `${TOKEN_FACT_MONTHS[d.getMonth()]} ${d.getDate()}`;
}

function safeTokenPrefix(raw: string): string {
  // Expose fixed public scheme names only; never return token body bytes.
  const value = raw.trim();
  if (value.startsWith('sk-ant-oat01')) return 'sk-ant-oat01';
  if (value.startsWith('sk-ant')) return 'sk-ant';
  return 'token';
}

/**
 * The token FACT for a Claude account ON THIS BOX (PHNX-4116): the slot/home
 * `.claude/.oauth_token` scheme prefix + its file date, else a present native
 * credential, else `no token`. For non-Claude native rows it reports credential
 * presence generically. `dir` is the slot dir when the account has one, else the
 * local version home. A fact, never a verdict.
 */
export function readTokenFact(agent: AgentId, dir: string | null): string {
  if (!dir) return 'no token';
  if (agent === 'claude') {
    const oauth = path.join(dir, '.claude', '.oauth_token');
    try {
      const stat = fs.statSync(oauth);
      const prefix = safeTokenPrefix(fs.readFileSync(oauth, 'utf-8'));
      return `${prefix} (${tokenFileDate(stat.mtimeMs)})`;
    } catch {  }
    try {
      const creds = path.join(dir, '.claude', '.credentials.json');
      const stat = fs.statSync(creds);
      return `native login (${tokenFileDate(stat.mtimeMs)})`;
    } catch {  }
    return 'no token';
  }
  return credentialPresence(agent, dir).perVersion ? 'credential present' : 'no token';
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
    // Slot credential truth comes from slotDir and cache key slot:<id>;
    // version-home state is only the no-slot fallback.
    const slot = row.id ? localSlots[row.id] : undefined;
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
    const fromFleet = row.id
      ? (shared.get(`${row.agent}:${row.id}`) ?? [])
      : (shared.get(`label:${row.agent}:${row.identityLabel}`) ?? []);
    row.devices = mergeDeviceVerdicts(fromFleet, local);
    const localQuota = localHome ? (inventoryByHome.get(`${row.agent}:${localHome.label}`)?.quota ?? null) : null;
    row.verdict = aggregateAccountVerdict(row.provisioning, row.devices, localQuota);
    row.checkedAt = newestCheckedAt(row.devices);
    const honest = applyUsageHonesty(row.verdict, localQuota);
    row.verdict = honest.verdict;
    row.usage = honest.usage;
    const inv = localHome ? inventoryByHome.get(`${row.agent}:${localHome.label}`) : undefined;
    row.usageSnapshot = inv?.snapshot ?? null;
    row.usageError = inv?.usageError ?? null;
    const credentialDir = slot?.slotDir ?? (localHome ? getVersionHomePath(row.agent, localHome.label) : null);
    row.token = readTokenFact(row.agent, credentialDir);
    row.lastAuth = formatAuthFact((cached as AuthHealth | undefined) ?? null);
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
    token: row.verdict === 'ready' ? 'api key (present)' : 'no key',
    lastAuth: 'not used on this box yet',
    fix: row.fix,
  };
}

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
        ...((() => { const v = usageErrorForDisplay(row.usageError); return v ? { usageError: v } : {}; })()),
        token: row.token,
        lastAuth: row.lastAuth,
        fix: row.fix,
      })),
      ...providers.flatMap((row) => providerJsonEntries(row, harness)),
    ],
  };
}

function verdictNote(verdict: AccountVerdict): string | null {
  if (verdict === 'rate_limited') return chalk.yellow('rate-limited');
  if (verdict === 'expired' || verdict === 'revoked' || verdict === 'missing') {
    return chalk.red(verdict);
  }
  return null;
}

export function coverageNote(row: NativeAccountCatalogRow, localDevice: string): string | null {
  const names = [...new Set(row.devices.map((device) => device.device))];
  if (names.length === 1 && names[0] === localDevice) return null;
  if (row.provisioning === 'per-device') {
    const absent = row.devices.filter((device) => device.verdict === 'missing').map((device) => device.device);
    return absent.length > 0 && absent.length < row.devices.length ? `not on ${absent.join(', ')}` : null;
  }
  const provisioned = row.devices.filter((device) => device.verdict !== 'missing').length;
  const usable = row.devices.filter((device) => device.verdict === 'live' || device.verdict === 'rate_limited' || device.verdict === 'unverified' || device.verdict === 'no_evidence').length;
  if (usable === 0 || usable === provisioned) return null;
  return `usable on ${usable} of ${provisioned} boxes`;
}

export const OVERVIEW_MAX_USAGE_WINDOWS = 2;

export const ACCOUNT_LISTING_LEGEND =
  '* stale usage · a healthy account carries no state · identity + per-box state: agents accounts list --fleet';

function usageOriginSuffix(snapshot: UsageSnapshot | null | undefined): string {
  const poller = snapshot?.freshness?.source === 'sync' ? snapshot.freshness.poller : undefined;
  return poller ? ` ${chalk.gray(`(from ${poller})`)}` : '';
}

function usageText(row: NativeAccountCatalogRow, maxWindows?: number): string {
  if (row.usageSnapshot) {
    const usageInfo: UsageInfo = { snapshot: row.usageSnapshot, error: row.usageError ?? null };
    return formatUsageSummary(
      null,
      usageInfo.snapshot,
      3,
      viewUsageSummaryOptions(row.agent, row.state === 'connected', usageInfo, maxWindows),
    ) + usageOriginSuffix(row.usageSnapshot);
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
  notes: string[];
  usage: string;
  isDefault: boolean;
}

export function authFactNote(lastAuth: string): string {
  if (lastAuth.startsWith('last used ok')) return chalk.green(lastAuth);
  if (lastAuth.startsWith('last auth failure')) return chalk.red(lastAuth);
  if (lastAuth.startsWith('rate-limited')) return chalk.yellow(lastAuth);
  return chalk.gray(lastAuth);
}

function nativeLine(row: NativeAccountCatalogRow, localDevice: string, maxWindows?: number): ListingLine {
  return {
    name: row.name ?? row.identityLabel,
    notes: [
      chalk.gray(row.token),
      authFactNote(row.lastAuth),
      row.verdict === 'missing' ? chalk.red('signed out') : null,
      coverageNote(row, localDevice),
      row.fix ? chalk.gray(`fix: ${row.fix}`) : null,
    ].filter((note): note is string => !!note),
    usage: usageText(row, maxWindows),
    isDefault: row.isDefault,
  };
}

function providerLine(row: ProviderAccountCatalogRow, harness?: AgentId): ListingLine {
  return {
    name: row.name,
    notes: [
      verdictNote(row.verdict),
      row.fix ? chalk.gray(`fix: ${row.fix}`) : null,
    ].filter((note): note is string => !!note),
    usage: '',
    isDefault: harness ? row.defaultFor.includes(harness) : false,
  };
}

function formatListingLine(line: ListingLine, nameW: number, usageW: number): string {
  const marker = line.isDefault ? '*' : ' ';
  return (
    `  ${chalk.green(marker)} ${chalk.cyan(line.name.padEnd(nameW))}  `
    + `${padToWidth(line.usage, usageW)}  `
    + line.notes.join(chalk.gray(' · '))
  ).trimEnd();
}

function pushGroup(
  out: string[],
  title: string,
  lines: ListingLine[],
  widths: { nameW: number; usageW: number },
  harnessHeadings: boolean,
): void {
  if (lines.length === 0) return;
  if (harnessHeadings) out.push(chalk.bold(title));
  for (const line of lines) {
    out.push(formatListingLine(line, widths.nameW, widths.usageW));
  }
  out.push('');
}

export function renderAccountRows(
  rows: NativeAccountCatalogRow[],
  opts: {
    heading?: boolean;
    footer?: boolean;
    harnessHeadings?: boolean;
    providers?: ProviderAccountCatalogRow[];
    harness?: AgentId;
    maxUsageWindows?: number;
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
      usageW: Math.max(5, ...allLines.map((line) => stringWidth(line.usage))),
    };
    for (const [harness, lines] of grouped) {
      pushGroup(out, harness, lines, widths, harnessHeadings);
    }
    if (orphans.length > 0) pushGroup(out, 'Other accounts', orphans, widths, true);
  }
  if (footer) {
    const count = visibleNative.filter((row) => !!row.fix).length
      + visibleProviders.filter((row) => !!row.fix).length;
    out.push(chalk.gray(`${count} accounts need you · add: agents accounts add <harness>`));
    out.push(chalk.gray(ACCOUNT_LISTING_LEGEND));
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
      if (!['live', 'expired', 'revoked', 'rate_limited', 'unverified', 'no_evidence', 'missing'].includes(row.verdict)) continue;
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
  if (verdict === 'unconfigured') return signedIn ? 'no_evidence' : 'missing';
  if (verdict === 'error') return signedIn ? 'no_evidence' : 'missing';
  return verdict ?? (signedIn ? 'no_evidence' : 'missing');
}

interface LocalSlotObservation {
  authMode: AccountDeviceVerdict['authMode'];
  verdict: AuthVerdict;
  checkedAt?: string;
}

export function resolveLocalAccountObservation(
  slot: LocalSlotObservation | undefined,
  cached: { verdict: AuthVerdict; checkedAt: number } | undefined,
  signedIn: boolean,
): {
  verdict: AccountDeviceVerdict['verdict'];
  authMode?: AccountDeviceVerdict['authMode'];
  checkedAt?: string;
} {
  // The slot store and daemon cache are concurrent writers; newest timestamp wins.
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

export function aggregateAccountVerdict(
  provisioning: AccountProvisioning,
  devices: AccountDeviceVerdict[],
  localQuota?: QuotaSummary | null,
): AccountVerdict {
  const verdicts = devices.map((row) => row.verdict);
  if (verdicts.includes('revoked')) return 'revoked';
  if (verdicts.includes('expired')) return 'expired';
  const hasLocalSnapshot = !!localQuota && localQuota.usedPercent !== null && localQuota.usedPercent !== undefined;
  if (!hasLocalSnapshot && verdicts.includes('rate_limited')) return 'rate_limited';
  if (verdicts.includes('live')) return 'live';
  if (verdicts.includes('unverified')) return 'unverified';
  if (verdicts.includes('no_evidence')) return 'no_evidence';
  return provisioning === 'per-device' ? 'per-device' : 'missing';
}

function newestCheckedAt(devices: AccountDeviceVerdict[]): string | null {
  return devices
    .map((row) => row.checkedAt)
    .filter((value): value is string => !!value)
    .sort((a, b) => Date.parse(b) - Date.parse(a))[0] ?? null;
}
