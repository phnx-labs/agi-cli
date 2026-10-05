import * as fs from 'fs';
import * as path from 'path';

import { ALL_AGENT_IDS, getAccountInfo, type AccountInfo } from './agents.js';
import { listNativeAccounts } from './account-registry.js';
import { readSlots } from './accounts/slots.js';
import { getCacheDir, readMeta } from './state.js';
import type { AgentId, Meta } from './types.js';
import {
  probeClaudeStatus,
  probeDroidStatus,
  probeKimiStatus,
  USAGE_HEADLESS_SCOPE_MARKER,
  type ProviderProbe,
  readClaudeUsageCache,
} from './accounting/usage.js';
import { getVersionHomePath, listInstalledVersions } from './installations/versions.js';
import { atomicWriteFileSync, ensureLockTarget, withFileLock } from './fs-atomic.js';
import { selfConfiguredDeviceRole } from './device-config.js';
import { mayIssueUsageEndpointProbe, trySpendUsageApiCall } from './usage-refresh.js';
import { machineId } from './machine-id.js';

export type AuthVerdict =
  | 'live'
  | 'revoked'
  | 'expired'
  | 'rate_limited'
  | 'unverified'
  | 'no_evidence'
  | 'unconfigured'
  | 'error';

export interface AuthHealth {
  verdict: AuthVerdict;
  checkedAt: number;
  detail?: string;
  account?: string;
  accountId?: string;
  source?: 'probe' | 'run';
}

export const AUTH_PROBE_MAX_AGE_MS = 20 * 60_000;

export const LIVE_PROBE_AGENTS: ReadonlySet<AgentId> = new Set<AgentId>(['claude', 'kimi', 'droid']);


export function classifyHttpStatus(status: number): AuthVerdict {
  if (status >= 200 && status < 300) return 'live';
  if (status === 401 || status === 403) return 'revoked';
  if (status === 429) return 'error';
  return 'error';
}

export function verdictFromProbe(probe: ProviderProbe): AuthVerdict {
  if (probe.token === 'missing') return 'unconfigured';
  if (probe.token === 'expired') return 'expired';
  if (probe.reason === 'usage_scope') return 'unverified';
  if (probe.status == null) return 'error';
  return classifyHttpStatus(probe.status);
}

export function probeDetail(probe: ProviderProbe): string | undefined {
  if (probe.reason === 'usage_scope') {
    return probe.error ?? USAGE_HEADLESS_SCOPE_MARKER;
  }
  if (probe.status === 429) return 'probe throttled (HTTP 429)';
  if (probe.status != null && (probe.status < 200 || probe.status >= 300)) return `HTTP ${probe.status}`;
  if (probe.error) return probe.error;
  return undefined;
}

const VERDICT_GLYPHS: Record<AuthVerdict, string> = {
  live: '●',
  revoked: '○',
  expired: '○',
  rate_limited: '◐',
  unverified: '◐',
  no_evidence: '◌',
  unconfigured: '·',
  error: '·',
};

export function verdictGlyph(verdict: AuthVerdict): string {
  return VERDICT_GLYPHS[verdict] ?? '·';
}

export function verdictLabel(verdict: AuthVerdict): string {
  switch (verdict) {
    case 'live': return 'live';
    case 'revoked': return 'revoked';
    case 'expired': return 'expired';
    case 'rate_limited': return 'limited';
    case 'unverified': return 'unverified';
    case 'no_evidence': return 'no evidence';
    case 'unconfigured': return '—';
    case 'error': return '?';
  }
}

export interface VerdictSummary {
  live: number;
  present: number;
  bad: number;
  warn: number;
  total: number;
}

export function summarizeVerdicts(verdicts: AuthVerdict[]): VerdictSummary {
  let live = 0;
  let present = 0;
  let bad = 0;
  let warn = 0;
  for (const v of verdicts) {
    if (v === 'live') live++;
    else if (v === 'unverified' || v === 'no_evidence') present++;
    else if (v === 'revoked') bad++;
    else warn++;
  }
  return { live, present, bad, warn, total: verdicts.length };
}

export type AuthCellColor = 'green' | 'yellow' | 'red' | 'gray' | 'dim';

export function verdictColor(verdict: AuthVerdict): AuthCellColor {
  switch (verdict) {
    case 'live': return 'green';
    case 'revoked': return 'red';
    case 'unverified': return 'gray';
    case 'no_evidence': return 'gray';
    case 'unconfigured': return 'dim';
    default: return 'yellow';
  }
}

export function authCellColor(summary: VerdictSummary): AuthCellColor {
  if (summary.total === 0) return 'dim';
  if (summary.bad > 0) return 'red';
  if (summary.warn > 0) return 'yellow';
  if (summary.live > 0) return 'green';
  return 'gray';
}

export function isDeadVerdict(verdict: AuthVerdict): boolean {
  return verdict === 'revoked';
}

/**
 * A host's rolled-up auth state for the `fleet status` Auth column.
 *
 * The four display buckets are deliberately finer-grained than
 * {@link VerdictSummary}'s live/bad/warn: they separate "present but this agent
 * has no live probe" (`unverified`) and "soft, self-healing expiry"
 * (`expired`/`rate_limited`) from a genuine server rejection (`revoked`). The
 * old three-bucket rollup lumped all of those into `warn` and the column painted
 * them one alarming yellow — so a fleet of perfectly logged-in accounts on
 * codex/grok/etc (which can NEVER be probed live) read as half-degraded. These
 * buckets let the renderer show `unverified` as neutral and reserve red for the
 * only verdict that actually means "re-login now" ({@link isDeadVerdict}).
 */
export interface HostAuthSummary {
  live: number;
  present: number;
  degraded: number;
  revoked: number;
  total: number;
  oldestCheckedAt: number | null;
}

export function summarizeHostAuth(
  cache: Record<string, AuthHealth>,
  host: string,
): HostAuthSummary {
  const prefix = `${host}:`;
  let live = 0, present = 0, degraded = 0, revoked = 0, total = 0;
  let oldest: number | null = null;
  for (const [key, health] of Object.entries(cache)) {
    if (!key.startsWith(prefix)) continue;
    if (health.verdict === 'unconfigured') continue;
    total++;
    switch (health.verdict) {
      case 'live': live++; break;
      case 'unverified': present++; break;
      case 'no_evidence': present++; break;
      case 'revoked': revoked++; break;
      default: degraded++; break;
    }
    if (oldest === null || health.checkedAt < oldest) oldest = health.checkedAt;
  }
  return { live, present, degraded, revoked, total, oldestCheckedAt: oldest };
}

export function formatCheckedAge(checkedAt: number, now: number = Date.now()): string {
  const secs = Math.max(0, Math.round((now - checkedAt) / 1000));
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}


export function authAccountLabel(
  info: Pick<AccountInfo, 'email' | 'accountId' | 'userId'> | null | undefined,
): string | undefined {
  return info?.email || info?.accountId || info?.userId || undefined;
}

export function authCacheKey(host: string, agent: AgentId | string, version: string): string {
  return `${host}:${agent}:${version}`;
}

export function authTargetKey(agent: AgentId | string, version: string): string {
  return `${agent}@${version}`;
}

export function slotAuthVersionKey(accountId: string): string {
  return `slot:${accountId}`;
}

interface SlotAuthInstall extends FleetAuthInstall {
  home: string;
  accountId: string;
}

export function enumerateSlotInstalls(
  meta: Pick<Meta, 'accounts' | 'deviceAccounts'>,
  agentIds: readonly AgentId[],
): SlotAuthInstall[] {
  const byId = new Map(listNativeAccounts(meta).map((account) => [account.id, account]));
  const out: SlotAuthInstall[] = [];
  for (const [accountId, slot] of Object.entries(readSlots(meta))) {
    const account = byId.get(accountId);
    if (!account || !agentIds.includes(account.agent)) continue;
    if (!fs.existsSync(slot.slotDir)) continue;
    out.push({ agent: account.agent, version: slotAuthVersionKey(accountId), home: slot.slotDir, account: undefined, accountId });
  }
  return out;
}

interface LocalAuthInstall extends FleetAuthInstall {
  home: string;
  accountId?: string;
}

function enumerateLocalAuthInstalls(
  meta: Pick<Meta, 'accounts' | 'deviceAccounts'>,
  agentIds: readonly AgentId[],
): LocalAuthInstall[] {
  const installs: LocalAuthInstall[] = [];
  for (const agent of agentIds) {
    for (const version of listInstalledVersions(agent)) {
      installs.push({ agent, version, home: getVersionHomePath(agent, version), account: undefined });
    }
  }
  for (const slot of enumerateSlotInstalls(meta, agentIds)) installs.push(slot);
  return installs;
}

export function localAuthTargetKeys(agentIds: readonly AgentId[] = ALL_AGENT_IDS): Set<string> {
  return new Set(enumerateLocalAuthInstalls(readMeta(), agentIds).map((i) => authTargetKey(i.agent, i.version)));
}

interface AuthHealthCacheFile {
  version: 1;
  entries: Record<string, AuthHealth>;
}

function cacheFilePath(): string {
  return path.join(getCacheDir(), '.auth-health.json');
}

export function readAuthHealthCache(): Record<string, AuthHealth> {
  try {
    const parsed = JSON.parse(fs.readFileSync(cacheFilePath(), 'utf-8')) as AuthHealthCacheFile;
    if (parsed && parsed.entries && typeof parsed.entries === 'object') return parsed.entries;
  } catch {
  }
  return {};
}

export function readAuthHealth(host: string, agent: AgentId | string, version: string): AuthHealth | null {
  return readAuthHealthCache()[authCacheKey(host, agent, version)] ?? null;
}

function parseAuthCacheKey(key: string, host: string): { agent: AgentId; version: string } | null {
  const prefix = `${host}:`;
  if (!key.startsWith(prefix)) return null;
  const identity = key.slice(prefix.length);
  const separator = identity.indexOf(':');
  if (separator <= 0) return null;
  const agent = identity.slice(0, separator);
  if (!ALL_AGENT_IDS.includes(agent as AgentId)) return null;
  return { agent: agent as AgentId, version: identity.slice(separator + 1) };
}

export function readFleetAuthRows(host: string): AuthProbeRow[] {
  const rows: AuthProbeRow[] = [];
  for (const [key, health] of Object.entries(readAuthHealthCache())) {
    const install = parseAuthCacheKey(key, host);
    if (!install) continue;
    rows.push({
      agent: install.agent,
      version: install.version,
      account: health.account,
      accountId: health.accountId,
      health,
    });
  }
  return rows;
}

export function mergeAuthHealthEntries(
  current: Record<string, AuthHealth>,
  incoming: Record<string, AuthHealth>,
): Record<string, AuthHealth> {
  const merged: Record<string, AuthHealth> = { ...current };
  for (const [key, health] of Object.entries(incoming)) {
    const isProbeThrottled = health.detail === 'probe throttled (HTTP 429)';
    if (isProbeThrottled) {
      const prev = merged[key];
      const fresh = !!prev && prev.verdict !== 'error' && prev.verdict !== 'unconfigured'
        && (health.checkedAt - prev.checkedAt < AUTH_PROBE_MAX_AGE_MS);
      if (fresh) continue;
      merged[key] = { ...health, verdict: 'unverified' };
      continue;
    }
    if (health.verdict === 'error' && merged[key]) continue;
    merged[key] = health;
  }
  return merged;
}

export function writeAuthHealthEntries(
  entries: Record<string, AuthHealth>,
  drop?: (key: string) => boolean,
): void {
  try {
    const target = cacheFilePath();
    ensureLockTarget(target, JSON.stringify({ version: 1, entries: {} }));
    withFileLock(target, () => {
      let current = readAuthHealthCache();
      if (drop) {
        current = Object.fromEntries(Object.entries(current).filter(([key]) => !drop(key)));
      }
      const merged: AuthHealthCacheFile = {
        version: 1,
        entries: mergeAuthHealthEntries(current, entries),
      };
      atomicWriteFileSync(target, JSON.stringify(merged, null, 2));
    });
  } catch {
  }
}


const FRESH_USAGE_VERDICT_MAX_AGE_MS = 20 * 60_000;

/**
 * A `live` verdict derived from the account's usage cache instead of a second
 * network request (RUSH-3036). The auth probe and the usage fetch hit the SAME
 * rate-limited endpoint with the SAME fleet-shared setup-token, so a fresh
 * successful usage snapshot already proves everything the probe would: paying a
 * second request per account per box was half the fleet's endpoint load.
 *
 * Two guards keep the evidence honest (both review findings on the first cut):
 * the caller must assert this box holds a LOCAL credential for the account
 * (`signedIn`) — a fleet-imported snapshot proves the shared token works, not
 * that THIS box can authenticate, so an unsigned home never derives `live`;
 * and a `forceLive` caller (`agents devices ping --strict`) skips derivation
 * entirely, because its contract is a real request that can surface `revoked`
 * within seconds, not minutes. Returns null when there is no admissible fresh
 * evidence — the caller then live-probes as before.
 */
function verdictFromFreshUsage(
  usageKey: string | null | undefined,
  signedIn: boolean,
  now: number,
): AuthHealth | null {
  if (!usageKey || !signedIn) return null;
  const snapshot = readClaudeUsageCache(usageKey);
  const capturedAt = snapshot?.capturedAt?.getTime();
  if (!capturedAt || now - capturedAt >= FRESH_USAGE_VERDICT_MAX_AGE_MS) return null;
  if (snapshot?.freshness?.source === 'sync') return null;
  const ageMin = Math.max(1, Math.round((now - capturedAt) / 60_000));
  return { verdict: 'live', checkedAt: now, detail: `token proven live by a usage fetch ${ageMin}m ago` };
}

/**
 * Complete a live auth probe for one (agent, home). For claude/kimi/droid this
 * hits the provider — unless the account's usage cache already holds a fresh
 * successful fetch, which is the same authenticated request and proves the
 * token live without spending a second one (RUSH-3036). For everyone else it
 * reports a best-effort local verdict (`unverified` when a credential is
 * present, `unconfigured` otherwise) — never masquerading as `live`.
 */
export async function probeAuthHealth(
  agent: AgentId,
  home: string | undefined,
  opts?: {
    cliVersion?: string | null;
    info?: AccountInfo | null;
    forceLive?: boolean;
    signal?: AbortSignal;
  },
): Promise<AuthHealth> {
  const checkedAt = Date.now();
  if (LIVE_PROBE_AGENTS.has(agent)) {
    const usageScope = opts?.info?.usageKey ?? null;
    if (opts?.forceLive !== true) {
      const derived = verdictFromFreshUsage(usageScope, opts?.info?.signedIn === true, checkedAt);
      if (derived) return derived;
    }
    if (!mayIssueUsageEndpointProbe({
      role: selfConfiguredDeviceRole(),
      forceLive: opts?.forceLive,
    })) {
      return {
        verdict: 'no_evidence',
        checkedAt,
        detail: 'setup-token box does not probe the usage endpoint',
      };
    }
    if (opts?.forceLive !== true && usageScope && !trySpendUsageApiCall(usageScope, agent, checkedAt)) {
      return {
        verdict: 'no_evidence',
        checkedAt,
        detail: 'usage-endpoint budget already spent this hour',
      };
    }
    let probe: ProviderProbe;
    if (agent === 'claude') probe = await probeClaudeStatus(home, opts?.cliVersion, usageScope, opts?.signal);
    else if (agent === 'kimi') probe = await probeKimiStatus(home, usageScope, opts?.signal);
    else probe = await probeDroidStatus(home, usageScope, opts?.signal);
    return { verdict: verdictFromProbe(probe), checkedAt, detail: probeDetail(probe) };
  }
  const info = opts?.info !== undefined ? opts.info : await getAccountInfo(agent, home).catch(() => null);
  return { verdict: info?.signedIn ? 'unverified' : 'unconfigured', checkedAt };
}

export interface AuthProbeRow {
  agent: AgentId;
  version: string;
  account?: string;
  accountId?: string;
  health: AuthHealth;
}

export interface FleetAuthInstall {
  agent: AgentId;
  version: string;
  account: string | undefined;
  accountId?: string | undefined;
}

interface FleetAuthProbeGroup<T extends FleetAuthInstall> {
  probe: T;
  members: T[];
}

const AUTH_PROBE_SPACING_MS = 150;

export function groupFleetAuthInstalls<T extends FleetAuthInstall>(
  installs: readonly T[],
  isMergeable: (install: T) => boolean = () => true,
): FleetAuthProbeGroup<T>[] {
  const groups = new Map<string, FleetAuthProbeGroup<T>>();
  for (const inst of installs) {
    const mergeKey = (inst as FleetAuthInstall).accountId
      ? `id:${(inst as FleetAuthInstall).accountId}`
      : inst.account
        ? `acct:${inst.account}`
        : null;
    const key = mergeKey && isMergeable(inst)
      ? `${inst.agent} ${mergeKey}`
      : `${inst.agent} ver:${inst.version}`;
    const existing = groups.get(key);
    if (existing) existing.members.push(inst);
    else groups.set(key, { probe: inst, members: [inst] });
  }
  return [...groups.values()];
}

export async function probeLocalFleetAuth(opts?: {
  cliVersion?: string | null;
  agents?: readonly AgentId[];
  forceLive?: boolean;
  signal?: AbortSignal;
}): Promise<AuthProbeRow[]> {
  const agentIds = opts?.agents ?? ALL_AGENT_IDS;

  interface LocalInstall extends LocalAuthInstall {
    info: AccountInfo | null;
  }

  const { findNativeAccountByIdentity } = await import('./account-registry.js');
  const meta = readMeta();
  const installs: LocalInstall[] = enumerateLocalAuthInstalls(meta, agentIds).map((inst) => ({ ...inst, info: null }));
  await Promise.all(
    installs.map(async (inst) => {
      inst.info = await getAccountInfo(inst.agent, inst.home).catch(() => null);
      inst.account = authAccountLabel(inst.info);
    }),
  );
  for (const inst of installs) {
    inst.accountId ??= findNativeAccountByIdentity(meta, inst.agent, inst.info)?.id;
  }

  const groups = groupFleetAuthInstalls(installs, (inst) => LIVE_PROBE_AGENTS.has(inst.agent));
  const perGroup: AuthProbeRow[][] = [];
  for (let idx = 0; idx < groups.length; idx++) {
    const group = groups[idx];
    const rep = group.probe;
    const health = await probeAuthHealth(rep.agent, rep.home, { cliVersion: opts?.cliVersion, info: rep.info, forceLive: opts?.forceLive, signal: opts?.signal });
    health.account = authAccountLabel(rep.info);
    health.accountId = rep.accountId;
    health.source = 'probe';
    if (health.verdict === 'unconfigured' || health.verdict === 'no_evidence') {
      perGroup.push([]);
    } else {
      perGroup.push(group.members.map((inst) => ({
        agent: inst.agent,
        version: inst.version,
        account: health.account,
        accountId: inst.accountId ?? health.accountId,
        health: { ...health },
      })));
    }
    if (idx < groups.length - 1 && !opts?.signal?.aborted) {
      await new Promise<void>((resolve) => setTimeout(resolve, AUTH_PROBE_SPACING_MS));
    }
  }
  return perGroup.flat();
}

export function writeFleetAuthRows(host: string, rows: AuthProbeRow[], installed?: ReadonlySet<string>): void {
  const entries: Record<string, AuthHealth> = {};
  for (const row of rows) {
    entries[authCacheKey(host, row.agent, row.version)] = row.health;
  }
  const drop = installed
    ? (key: string) => {
      const install = parseAuthCacheKey(key, host);
      return install != null && !installed.has(authTargetKey(install.agent, install.version));
    }
    : undefined;
  writeAuthHealthEntries(entries, drop);
}


export function runOutcomeVersionKey(opts: { version?: string | null; home?: string | null }): string | null {
  if (opts.version) return opts.version;
  if (opts.home) {
    const label = path.basename(path.dirname(opts.home));
    if (label && label !== '.' && label !== path.sep) return label;
  }
  return null;
}

export type RunAuthOutcome =
  | { ok: true }
  | { ok: false; verdict: 'revoked' | 'expired' | 'rate_limited' | 'error'; detail?: string; resetsAt?: number | null };

export function recordRunAuthOutcome(opts: {
  agent: AgentId | string;
  accountId?: string | null;
  version?: string | null;
  home?: string | null;
  account?: string;
  outcome: RunAuthOutcome;
  host?: string;
  now?: number;
}): void {
  const slotKey = opts.accountId && readSlots(readMeta())[opts.accountId]
    ? slotAuthVersionKey(opts.accountId)
    : null;
  const versionKey = slotKey
    ?? runOutcomeVersionKey(opts)
    ?? (opts.accountId ? slotAuthVersionKey(opts.accountId) : null);
  if (!versionKey) return;
  const checkedAt = opts.now ?? Date.now();
  const host = opts.host ?? machineId();
  let detail: string | undefined;
  if (opts.outcome.ok) {
    detail = 'run ok';
  } else if (opts.outcome.verdict === 'rate_limited' && opts.outcome.resetsAt) {
    detail = `until ${factClock(opts.outcome.resetsAt)}`;
  } else {
    detail = opts.outcome.detail;
  }
  const health: AuthHealth = {
    verdict: opts.outcome.ok ? 'live' : opts.outcome.verdict,
    checkedAt,
    source: 'run',
    ...(detail ? { detail } : {}),
    ...(opts.account ? { account: opts.account } : {}),
    ...(opts.accountId ? { accountId: opts.accountId } : {}),
  };
  writeAuthHealthEntries({ [authCacheKey(host, opts.agent, versionKey)]: health });
}

const FACT_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function factClock(ms: number): string {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

export function factTimestamp(ms: number): string {
  const d = new Date(ms);
  return `${FACT_MONTHS[d.getMonth()]} ${d.getDate()} ${factClock(ms)}`;
}

/**
 * The auth FACT `agents view` / `agents accounts` render per account per box
 * (PHNX-4116): what actually happened here, with its time — never a word that
 * means "we did not look". A `live` row (a recorded run OR a real probe) reads
 * `last used ok <age>`; a server rejection reads `last auth failure <detail>
 * <time>`; a throttle reads `rate-limited <detail> (<time>)`; anything with no
 * usable evidence — including `no_evidence`/`unverified` — reads `not used on
 * this box yet`.
 */
export function formatAuthFact(health: AuthHealth | null | undefined, now: number = Date.now()): string {
  if (!health) return 'not used on this box yet';
  switch (health.verdict) {
    case 'live':
      return `last used ok ${formatCheckedAge(health.checkedAt, now)}`;
    case 'revoked':
    case 'expired':
      return `last auth failure${health.detail ? ` ${health.detail}` : ''} ${factTimestamp(health.checkedAt)}`;
    case 'rate_limited':
      return `rate-limited${health.detail ? ` ${health.detail}` : ''} (${factTimestamp(health.checkedAt)})`;
    default:
      return 'not used on this box yet';
  }
}
