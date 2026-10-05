/** Live auth-health: does an account's stored credential complete an authenticated request now?
 * Local "signed in" can't tell a revoked-but-unexpired token. Records a per-(agent, account)
 * verdict in a cache read by `agents view`, `agents fleet status` and rotation. */
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

/** Verdicts: `live` (200); `revoked` (401/403, except the Claude setup-token usage_scope gap,
 * RUSH-2392); `expired` (local, no refresh); `rate_limited` (per usage snapshot, never a probe
 * 429, PHNX-4051); `unverified`; `no_evidence` (PHNX-4116); `unconfigured`; `error` (keep last). */
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
  /** epoch ms of the probe. */
  checkedAt: number;
  /** optional short human detail (e.g. "HTTP 401", a network error). */
  detail?: string;
  /** account label for display (email / id), when known. Never part of the key. */
  account?: string;
  /** Stable registered account id. Display labels are never used as identity. */
  accountId?: string;
  /** How this row was observed (PHNX-4116): `probe` (default) is a daemon network probe; `run` is a
   * real run outcome recorded on exit (success `live`, or an auth failure). `agents view` states
   * token usability from this as evidence (`last used ok 12m ago`), not a stale usage file. */
  source?: 'probe' | 'run';
}

/** Maximum age of an auth verdict used for automatic routing decisions. */
export const AUTH_PROBE_MAX_AGE_MS = 20 * 60_000;

/** Agents with a live network probe wired up today. The rest are best-effort. */
export const LIVE_PROBE_AGENTS: ReadonlySet<AgentId> = new Set<AgentId>(['claude', 'kimi', 'droid']);

// ---------------------------------------------------------------------------
// Pure classifiers / render (unit-tested; no network, no fs)
// ---------------------------------------------------------------------------

/** Map an HTTP status from a live probe to a verdict. Probe 429 never yields `rate_limited` (PHNX-4051). */
export function classifyHttpStatus(status: number): AuthVerdict {
  if (status >= 200 && status < 300) return 'live';
  if (status === 401 || status === 403) return 'revoked';
  // 429 is probe throttling, not an account throttle; real throttle state comes from the usage
  // snapshot (deriveUsageStatusFromSnapshot). Treating it as `rate_limited` let a burst-throttled
  // endpoint mark every account LIMITED. See mergeAuthHealthEntries.
  if (status === 429) return 'error';
  return 'error';
}

/** Turn a raw provider probe (from usage.ts) into a verdict. */
export function verdictFromProbe(probe: ProviderProbe): AuthVerdict {
  if (probe.token === 'missing') return 'unconfigured';
  if (probe.token === 'expired') return 'expired';
  // Setup-token can run inference but cannot read usage (RUSH-2392). That 403
  // is NOT a revocation — classifying it as revoked made the best-provisioned
  // headless accounts look the least healthy on `agents view` / fleet ping.
  if (probe.reason === 'usage_scope') return 'unverified';
  if (probe.status == null) return 'error';
  return classifyHttpStatus(probe.status);
}

/** A short human detail line for a probe result (rendered under --verbose). */
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
  live: '●', // ●
  revoked: '○', // ○
  expired: '○', // ○
  rate_limited: '◐', // ◐
  unverified: '◐', // ◐
  no_evidence: '◌', // ◌ — credential present, no evidence either way
  unconfigured: '·', // ·
  error: '·', // ·
};

/** Uncolored glyph for a verdict (color is applied by the caller). */
export function verdictGlyph(verdict: AuthVerdict): string {
  return VERDICT_GLYPHS[verdict] ?? '·';
}

/** One-word label for matrices/verbose output. */
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

/** Roll a set of verdicts (one host×agent's installs) into counts for a matrix cell. */
export interface VerdictSummary {
  live: number;
  /** unverified: signed in, but no in-repo live-probe endpoint (codex/grok). Benign and neutral;
   * must not join the soft `warn` bucket, or a fully-logged-in codex/grok fleet reads as
   * half-degraded (the old ping matrix). */
  present: number;
  /** revoked — the server rejected the token (401/403). Genuinely needs re-login. */
  bad: number;
  /** expired / rate_limited / error: degraded or unknown, but not "re-login now". `expired` is soft
   * for kimi/droid (their CLIs refresh on next launch), so lumping it with revoked would cry wolf. */
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

/** A resolved display color; the caller maps it to chalk. Pure, so it's unit-tested. */
export type AuthCellColor = 'green' | 'yellow' | 'red' | 'gray' | 'dim';

/** Color for one verdict in the per-account (`--verbose`) breakdown, shared with authCellColor so
 * the matrix and list can't drift (they did: expired was yellow in one, red in the other). Red
 * only for `revoked`; `unverified` gray; `expired`/`rate_limited`/`error` yellow. */
export function verdictColor(verdict: AuthVerdict): AuthCellColor {
  switch (verdict) {
    case 'live': return 'green';
    case 'revoked': return 'red';
    case 'unverified': return 'gray';
    case 'no_evidence': return 'gray';
    case 'unconfigured': return 'dim';
    default: return 'yellow'; // expired / rate_limited / error — soft, self-healing/indeterminate
  }
}

/** Color for a matrix cell rolling up several accounts: red only on a genuine `revoked`; yellow for
 * soft or expired; green when one is live-verified and none soft/revoked; gray when unverifiable
 * (codex/grok), never the old alarming yellow that made a logged-in fleet read as half-broken. */
export function authCellColor(summary: VerdictSummary): AuthCellColor {
  if (summary.total === 0) return 'dim';
  if (summary.bad > 0) return 'red';
  if (summary.warn > 0) return 'yellow';
  if (summary.live > 0) return 'green';
  return 'gray'; // all present/unverifiable — signed in, neutral
}

/** Verdicts that mean "this token was rejected by the server — re-login required". */
export function isDeadVerdict(verdict: AuthVerdict): boolean {
  return verdict === 'revoked';
}

/** A host's rolled-up auth state for the `fleet status` Auth column. Four buckets, finer than
 * VerdictSummary: `unverified` (no live probe) and soft self-healing expiry are split from
 * `revoked`, since the old rollup painted codex/grok fleets, which can't be probed, as degraded. */
export interface HostAuthSummary {
  /** Live-verified accounts (a real 2xx). */
  live: number;
  /** Signed in but this agent has no live-probe endpoint — benign, neutral. */
  present: number;
  /** Soft/degraded: expired (self-healing) / rate_limited / error. Mild warning. */
  degraded: number;
  /** Server rejected the token — genuinely needs re-login. */
  revoked: number;
  /** Total cached rows for this host (0 → the renderer shows "—"). */
  total: number;
  /** Oldest `checkedAt` (epoch ms) among this host's cached rows, or null when none. */
  oldestCheckedAt: number | null;
}

/** Roll every cached (agent, version) row for one host into a HostAuthSummary plus the stalest
 * entry's age. Pure over the map from readAuthHealthCache, so `fleet status` needs no probe; no
 * rows gives total 0. Matches the `host:` key prefix so segments can't be mistaken for a host. */
export function summarizeHostAuth(
  cache: Record<string, AuthHealth>,
  host: string,
): HostAuthSummary {
  const prefix = `${host}:`;
  let live = 0, present = 0, degraded = 0, revoked = 0, total = 0;
  let oldest: number | null = null;
  for (const [key, health] of Object.entries(cache)) {
    if (!key.startsWith(prefix)) continue;
    // `unconfigured` = no credential at all — not a probed account. Writers
    // already drop these before they reach the cache; skip here too so a stray
    // one never counts toward total or the freshness age (belt-and-suspenders).
    if (health.verdict === 'unconfigured') continue;
    total++;
    switch (health.verdict) {
      case 'live': live++; break;
      case 'unverified': present++; break;      // signed in, no probe — benign
      case 'no_evidence': present++; break;     // credential present, no evidence — benign
      case 'revoked': revoked++; break;          // server said no — re-login
      default: degraded++; break;                // expired / rate_limited / error — soft
    }
    if (oldest === null || health.checkedAt < oldest) oldest = health.checkedAt;
  }
  return { live, present, degraded, revoked, total, oldestCheckedAt: oldest };
}

/** Human "3m ago" style age for a checkedAt timestamp. */
export function formatCheckedAge(checkedAt: number, now: number = Date.now()): string {
  const secs = Math.max(0, Math.round((now - checkedAt) / 1000));
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

// ---------------------------------------------------------------------------
// Cache identity + IO (single source of truth read by view/fleet/rotation)
// ---------------------------------------------------------------------------

/** Human account label for display (email, else id). Not in the cache key: two installs on one host
 * can hold the same account with independently valid tokens, so the key is per version. */
export function authAccountLabel(
  info: Pick<AccountInfo, 'email' | 'accountId' | 'userId'> | null | undefined,
): string | undefined {
  return info?.email || info?.accountId || info?.userId || undefined;
}

/** Cache key: one entry per install — (host, agent, version). Unique per token. */
export function authCacheKey(host: string, agent: AgentId | string, version: string): string {
  return `${host}:${agent}:${version}`;
}

/** Host-independent identity of one probe target, the (agent, version) pair authCacheKey keys on.
 * The separator can't appear in either half, unlike a `:` join. */
export function authTargetKey(agent: AgentId | string, version: string): string {
  return `${agent}@${version}`;
}

/** The `version` slot an account slot occupies in the auth cache and probe rows:
 * `slot:<accountId>`. A slot is a HOME-shaped dir, not an installed version, so it needs its own
 * key or its verdict would collide with a version home sharing the account's label. */
export function slotAuthVersionKey(accountId: string): string {
  return `slot:${accountId}`;
}

/** One account slot on this device that the auth probe must cover. */
interface SlotAuthInstall extends FleetAuthInstall {
  home: string;
  accountId: string;
}

/** Every registered account's slot on this device (PHNX-3940 T1) as probe targets. Before, the
 * probe walked only `listInstalledVersions`, so a slot re-materialized as `unconfigured` stayed
 * missing though its login was live. A slot whose dir is gone is skipped. */
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

/** One probe target on this device: an installed version home, or an account slot. */
interface LocalAuthInstall extends FleetAuthInstall {
  home: string;
  accountId?: string;
}

/** Every (agent, version) home the local auth probe covers: installed version homes plus account
 * slots. probeLocalFleetAuth probes exactly this set, so it also says which cached rows are still
 * backed (PHNX-4051). */
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

/** authTargetKey for every local probe target: what a cached row must match to be about this
 * device. A row outside it is an orphan (home uninstalled, `checkedAt` frozen, nothing re-probes
 * it; PHNX-4051). */
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

/** Read the whole cache (best-effort; a corrupt/missing file yields an empty map). */
export function readAuthHealthCache(): Record<string, AuthHealth> {
  try {
    const parsed = JSON.parse(fs.readFileSync(cacheFilePath(), 'utf-8')) as AuthHealthCacheFile;
    if (parsed && parsed.entries && typeof parsed.entries === 'object') return parsed.entries;
  } catch {
    // missing or corrupt — treat as empty
  }
  return {};
}

/** Read one entry, or null. */
export function readAuthHealth(host: string, agent: AgentId | string, version: string): AuthHealth | null {
  return readAuthHealthCache()[authCacheKey(host, agent, version)] ?? null;
}

/** Split a cache key back into the install it names for one host; null for another host's key or an
 * unknown agent. The one place the `host:agent:version` join is undone. */
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

/** Reconstruct one host's published probe rows for a lease waiter/CLI reader. */
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

/** Merge entries into the cache. An incoming `error` (network blip) must not clobber a known
 * verdict, or one 8s timeout flips `live` to `error`. A probe-throttled 429 keeps the previous
 * real verdict within AUTH_PROBE_MAX_AGE_MS, else becomes `unverified` (PHNX-4051). Pure. */
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
      if (fresh) continue; // keep previous real verdict
      merged[key] = { ...health, verdict: 'unverified' };
      continue;
    }
    if (health.verdict === 'error' && merged[key]) continue; // keep last known
    merged[key] = health;
  }
  return merged;
}

/** Merge entries into the cache (best-effort write). `drop` removes known-gone entries on the
 * pre-merge cache, so an incoming row always wins over a drop of the same key. Only a writer that
 * knows the full truth for the keys it drops may pass one (see writeFleetAuthRows). */
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
    // best-effort; a failed write just means the next reader falls back to heuristics
  }
}

// ---------------------------------------------------------------------------
// The probe (writer side)
// ---------------------------------------------------------------------------

/** A usage snapshot this recent is live proof the shared setup-token works, since it exists only
 * because an authenticated `/oauth/usage` request succeeded. Matches AUTH_PROBE_MAX_AGE_MS in
 * daemon-ticks.ts (not imported, to avoid a cycle; drift only shifts evidence freshness). */
const FRESH_USAGE_VERDICT_MAX_AGE_MS = 20 * 60_000;

/** A `live` verdict derived from the usage cache instead of a second request (RUSH-3036): the probe
 * and usage fetch hit the same rate-limited endpoint with the same shared setup-token. This box
 * must hold a local credential (`signedIn`); `forceLive` skips derivation. Null means probe live. */
function verdictFromFreshUsage(
  usageKey: string | null | undefined,
  signedIn: boolean,
  now: number,
): AuthHealth | null {
  if (!usageKey || !signedIn) return null;
  const snapshot = readClaudeUsageCache(usageKey);
  const capturedAt = snapshot?.capturedAt?.getTime();
  if (!capturedAt || now - capturedAt >= FRESH_USAGE_VERDICT_MAX_AGE_MS) return null;
  // A `sync` snapshot came from another box's poller: it proves the shared token works somewhere,
  // not that this box can authenticate (PHNX-4116). Only a reading this box captured itself
  // (statusline/poll) is admissible live evidence.
  if (snapshot?.freshness?.source === 'sync') return null;
  const ageMin = Math.max(1, Math.round((now - capturedAt) / 60_000));
  return { verdict: 'live', checkedAt: now, detail: `token proven live by a usage fetch ${ageMin}m ago` };
}

/** Complete a live auth probe for one (agent, home). For claude/kimi/droid this hits the provider,
 * unless the usage cache holds a fresh successful fetch, which proves the token live without a
 * second request (RUSH-3036). Others get a local verdict, never `live`. */
export async function probeAuthHealth(
  agent: AgentId,
  home: string | undefined,
  opts?: {
    cliVersion?: string | null;
    info?: AccountInfo | null;
    /** Skip the derived-from-usage shortcut and fire a real probe (RUSH-3036). Set by `agents
     * devices ping [--strict]`, whose contract is a live request that surfaces `revoked`
     * immediately. */
    forceLive?: boolean;
    /** Daemon tick deadline signal, combined with each probe fetch's own timeout (PHNX-3608). */
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
      // A worker's setup-token can't read the usage endpoint (RUSH-2392), so there is no probe
      // evidence: "we did not look here", not `unverified`. A worker never publishes it; facts
      // come from token presence plus recorded run outcomes (PHNX-4116).
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

/** One probed install on a host. */
export interface AuthProbeRow {
  agent: AgentId;
  version: string;
  account?: string;
  accountId?: string;
  health: AuthHealth;
}

/** One installed (agent, version) home, tagged with its resolved account label. */
export interface FleetAuthInstall {
  agent: AgentId;
  version: string;
  /** Human account label from {@link authAccountLabel}, or undefined when none resolves. */
  account: string | undefined;
  /** Stable account id when known (slot or resolved via registry) — preferred dedup key. */
  accountId?: string | undefined;
}

/** A set of installs sharing one provider account that must be probed once. The live probe runs
 * against `probe` (the representative home); every entry in `members`, representative included,
 * gets that verdict. */
interface FleetAuthProbeGroup<T extends FleetAuthInstall> {
  probe: T;
  members: T[];
}

/** Collapse installs so a live auth probe fires once per (agent, account), not per version home.
 * Homes on one account share an OAuth rate limit; concurrent probes every three minutes raced it
 * into a 429 storm and a `Retry-After` penalty (RUSH-2111). Only LIVE_PROBE_AGENTS dedup. Pure. */
/** Small fixed delay between live probes so one box no longer fires 16 requests in 4s (PHNX-4051). */
const AUTH_PROBE_SPACING_MS = 150;

export function groupFleetAuthInstalls<T extends FleetAuthInstall>(
  installs: readonly T[],
  isMergeable: (install: T) => boolean = () => true,
): FleetAuthProbeGroup<T>[] {
  const groups = new Map<string, FleetAuthProbeGroup<T>>();
  for (const inst of installs) {
    // Prefer the stable accountId: a version home and its slot share it, so they collapse to one
    // probe per identity (PHNX-4051). Fall back to the display label; the `id:`/`acct:`/`ver:`
    // tokens keep branches disjoint.
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

/** Enumerate every installed (agent, version) on this host and return one row per install (no
 * credential at all is dropped). Shared by `agents fleet ping --local` and the daemon refresh. The
 * live probe is deduped by account, so refresh can't self-inflict a 429 (RUSH-2111). */
export async function probeLocalFleetAuth(opts?: {
  cliVersion?: string | null;
  agents?: readonly AgentId[];
  /** Fire real network probes even when fresh usage evidence exists (RUSH-3036) — the `devices ping [--strict]` contract. */
  forceLive?: boolean;
  /** Deadline signal from the daemon's supervised auth tick (PHNX-3608). It aborts in-flight probe
   * work when the deadline elapses; on-demand CLI callers omit it. */
  signal?: AbortSignal;
}): Promise<AuthProbeRow[]> {
  const agentIds = opts?.agents ?? ALL_AGENT_IDS;

  interface LocalInstall extends LocalAuthInstall {
    info: AccountInfo | null;
  }

  // Enumerate every install and account slot on this device and resolve each account label.
  // getAccountInfo is a local file read (no network), so this fan-out is cheap and doesn't add to
  // the rate limit the grouping avoids.
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
    // A slot already knows its account; a version home is joined by identity.
    inst.accountId ??= findNativeAccountByIdentity(meta, inst.agent, inst.info)?.id;
  }

  // Probe once per (agent, identity), only for network-probing agents that can 429; best-effort
  // agents stay per-install. Groups run sequentially with a small delay (PHNX-4051) so one box no
  // longer fires 16 requests in 4s; distinct identities mean no same-account concurrency.
  const groups = groupFleetAuthInstalls(installs, (inst) => LIVE_PROBE_AGENTS.has(inst.agent));
  const perGroup: AuthProbeRow[][] = [];
  for (let idx = 0; idx < groups.length; idx++) {
    const group = groups[idx];
    const rep = group.probe;
    const health = await probeAuthHealth(rep.agent, rep.home, { cliVersion: opts?.cliVersion, info: rep.info, forceLive: opts?.forceLive, signal: opts?.signal });
    health.account = authAccountLabel(rep.info);
    health.accountId = rep.accountId;
    health.source = 'probe';
    // `unconfigured` and `no_evidence` both write no row: one has nothing to say, the other only
    // "we did not look", not a fleet-publishable verdict; facts come from token presence and run
    // outcomes (PHNX-4116).
    if (health.verdict === 'unconfigured' || health.verdict === 'no_evidence') {
      perGroup.push([]);
    } else {
      perGroup.push(group.members.map((inst) => ({
        agent: inst.agent,
        version: inst.version,
        account: health.account,
        accountId: inst.accountId ?? health.accountId,
        // A distinct object per row so a later mutation of one can't bleed across.
        health: { ...health },
      })));
    }
    // Space probes; not after the last group and not if the tick is being aborted.
    if (idx < groups.length - 1 && !opts?.signal?.aborted) {
      await new Promise<void>((resolve) => setTimeout(resolve, AUTH_PROBE_SPACING_MS));
    }
  }
  return perGroup.flat();
}

/** Persist a host's probed rows into the cache. `installed` (the localAuthTargetKeys set) prunes
 * that host's orphan rows for uninstalled versions, which nothing re-probes and which froze the
 * reuse window false (PHNX-4051). Only a caller that enumerated installs sets it. */
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

// Run-outcome recording and auth-fact rendering (PHNX-4116). A worker never probes, so honest
// evidence is a real run: a success (`live`) or auth failure, written with `source: 'run'` and
// read back as a fact (`last used ok 12m ago`) instead of a misleading verdict word.

/** The version label a run outcome falls back to when the account has no slot here: the explicit
 * `version`, else the label from `home` (a version home is `<versionDir>/home`, so its parent's
 * basename). Null if neither resolves. Pure. */
export function runOutcomeVersionKey(opts: { version?: string | null; home?: string | null }): string | null {
  if (opts.version) return opts.version;
  if (opts.home) {
    const label = path.basename(path.dirname(opts.home));
    if (label && label !== '.' && label !== path.sep) return label;
  }
  return null;
}

/** A real agent-run outcome — the evidence behind `last used ok` / `last auth failure`. */
export type RunAuthOutcome =
  | { ok: true }
  | { ok: false; verdict: 'revoked' | 'expired' | 'rate_limited' | 'error'; detail?: string; resetsAt?: number | null };

/** Record a real run's auth outcome into the auth-health cache with `source: 'run'`. Best-effort,
 * never throws: an unattributable run writes nothing. Keyed as the catalog reads, so the fact
 * lands on the same row. */
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
  // Key as the account catalog reads (slot key, then version label) so the fact lands on the row:
  // the slot key only when a slot dir exists for this account here (workers), else the installed
  // version label (headed logins have no slot). A last-resort slot key keeps the run recorded.
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

/** `HH:MM` local clock — used for a throttle reset time. */
function factClock(ms: number): string {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/** `Sep 20 14:02` — the fact timestamp for an auth failure. */
export function factTimestamp(ms: number): string {
  const d = new Date(ms);
  return `${FACT_MONTHS[d.getMonth()]} ${d.getDate()} ${factClock(ms)}`;
}

/** The auth fact `agents view`/`agents accounts` render per account per box (PHNX-4116): what
 * happened here, with its time. `live` reads `last used ok <age>`; a rejection `last auth failure
 * <detail> <time>`; a throttle `rate-limited ...`; no usable evidence `not used on this box yet`. */
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
