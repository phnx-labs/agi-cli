/**
 * Live auth-health: does an agent account's stored credential actually complete
 * an authenticated request right now?
 *
 * The rest of the CLI reports "signed in" from a local heuristic — a credential
 * file is present and its email decodes — which cannot distinguish a good token
 * from a revoked-but-unexpired one. This module completes a real request per
 * (agent, account) and records the verdict in a small cache that `agents view`
 * (per-version chip), `agents fleet status` (the per-host Auth column, via
 * {@link summarizeHostAuth}), and the run rotation all read. The writers are
 * the daemon (a periodic local refresh) and `agents fleet ping` (which also
 * fans out to write remote hosts' rows into the local cache); everyone else
 * reads.
 *
 * The network probes themselves live in lib/usage.ts (where the per-provider
 * token loaders + endpoints already are); this module classifies their result,
 * covers the best-effort (non-networked) providers, and owns the cache.
 */
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

/**
 * - `live`        — completed an authenticated request (200).
 * - `revoked`     — the server rejected the token (401/403), except Claude
 *                   setup-token `user:profile` scope denials (those are
 *                   `unverified` via `reason: 'usage_scope'` — RUSH-2392).
 * - `expired`     — locally-detected expiry; not network-verified (no refresh on the read path).
 * - `rate_limited`— the account is throttled per its usage snapshot
 *                   ({@link deriveUsageStatusFromSnapshot} / {@link applyUsageHonesty}),
 *                   not per a probe HTTP 429. A 429 from the usage endpoint is
 *                   probe throttling and never produces `rate_limited`: it keeps
 *                   the previous real verdict when one exists within
 *                   {@link AUTH_PROBE_MAX_AGE_MS}, otherwise `unverified` with
 *                   detail `probe throttled (HTTP 429)` (PHNX-4051).
 * - `unverified`  — credential present, not locally expired, but this agent has
 *                   no in-repo probe endpoint (codex/grok), OR the probe
 *                   endpoint cannot prove live for a known non-revocation
 *                   reason (Claude setup-token usage-scope gap — RUSH-2392),
 *                   OR a throttled probe with no fresh previous verdict (PHNX-4051).
 * - `unconfigured`— no usable credential on disk.
 * - `error`       — network/other failure; verdict indeterminate (keep the last known one).
 */
export type AuthVerdict =
  | 'live'
  | 'revoked'
  | 'expired'
  | 'rate_limited'
  | 'unverified'
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
  // 429 is probe throttling, not an account throttle — the account's real
  // throttle state comes from the usage snapshot (deriveUsageStatusFromSnapshot).
  // Treating it as `rate_limited` let a burst-throttled endpoint mark every
  // account LIMITED. See mergeAuthHealthEntries for the keep-or-unverified path.
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
    case 'unconfigured': return '—';
    case 'error': return '?';
  }
}

/** Roll a set of verdicts (one host×agent's installs) into counts for a matrix cell. */
export interface VerdictSummary {
  live: number;
  /**
   * unverified — signed in, but this agent has no in-repo live-probe endpoint
   * (codex/grok). A benign, neutral state: the account is present and usable, we
   * just can't complete a 2xx to prove it. It must NOT be lumped with the soft
   * `warn` bucket, or a fully-logged-in codex/grok fleet reads as half-degraded
   * (the exact "cry wolf" the ping matrix used to produce).
   */
  present: number;
  /** revoked — the server rejected the token (401/403). Genuinely needs re-login. */
  bad: number;
  /**
   * expired / rate_limited / error — degraded or unknown, but NOT "re-login now".
   * `expired` is soft for kimi/droid (their CLIs refresh the token on next launch;
   * we don't refresh on the read path), so it must not be lumped with revoked or
   * we'd cry wolf on a self-healing token.
   */
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
    else if (v === 'unverified') present++;
    else if (v === 'revoked') bad++;
    else warn++;
  }
  return { live, present, bad, warn, total: verdicts.length };
}

/** A resolved display color; the caller maps it to chalk. Pure, so it's unit-tested. */
export type AuthCellColor = 'green' | 'yellow' | 'red' | 'gray' | 'dim';

/**
 * Color for a single verdict in the per-account (`--verbose`) breakdown. This is
 * the one source of truth shared with {@link authCellColor} so the matrix and the
 * account list can never drift — they did: the matrix painted `expired` yellow
 * while the verbose list painted it *red* (lumped with revoked), directly against
 * the {@link VerdictSummary} contract. Red is reserved for `revoked` (the only
 * "re-login now"); `unverified` is a neutral signed-in state (gray);
 * `expired`/`rate_limited`/`error` are soft (yellow).
 */
export function verdictColor(verdict: AuthVerdict): AuthCellColor {
  switch (verdict) {
    case 'live': return 'green';
    case 'revoked': return 'red';
    case 'unverified': return 'gray';
    case 'unconfigured': return 'dim';
    default: return 'yellow'; // expired / rate_limited / error — soft, self-healing/indeterminate
  }
}

/**
 * Color for a matrix cell that rolls up several accounts. Red only when a token
 * was genuinely rejected (`revoked`); yellow for soft/expired; green when at least
 * one account is live-verified and none are soft/revoked; gray when accounts are
 * present but unverifiable (codex/grok) — never the alarming yellow the old
 * renderer used, which made a fully-logged-in fleet read as half-broken.
 */
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

/**
 * Roll every cached (agent, version) row for one host into a {@link HostAuthSummary}
 * plus the age of its stalest entry. Pure — reads the map the caller already
 * loaded via {@link readAuthHealthCache}, so `fleet status` renders the Auth
 * column without any network probe. A host with no cached rows yields an empty
 * summary (total 0), which the renderer shows as "—".
 *
 * Keys are `host:agent:version` ({@link authCacheKey}); we match on the `host:`
 * prefix so agent/version segments can never be mistaken for a host.
 */
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

/**
 * Human account label for display (email, else id). NOT used in the cache key —
 * two installs on one host can hold the same account with independently valid
 * tokens, so the key is keyed by version (below), not account.
 */
export function authAccountLabel(
  info: Pick<AccountInfo, 'email' | 'accountId' | 'userId'> | null | undefined,
): string | undefined {
  return info?.email || info?.accountId || info?.userId || undefined;
}

/** Cache key: one entry per install — (host, agent, version). Unique per token. */
export function authCacheKey(host: string, agent: AgentId | string, version: string): string {
  return `${host}:${agent}:${version}`;
}

/**
 * Host-independent identity of one probe target — the (agent, version) pair
 * {@link authCacheKey} is keyed by. The separator cannot appear in either half,
 * so an agent id can never run into a version the way a `:` join allows.
 */
export function authTargetKey(agent: AgentId | string, version: string): string {
  return `${agent}@${version}`;
}

/**
 * The `version` slot an account SLOT occupies in the auth cache and the probe
 * rows: `slot:<accountId>`. A slot is a HOME-shaped dir, not an installed
 * version, so it needs its own key or its verdict would collide with (or be
 * silently dropped in favor of) whichever version home the account's label
 * happened to match.
 */
export function slotAuthVersionKey(accountId: string): string {
  return `slot:${accountId}`;
}

/** One account slot on this device that the auth probe must cover. */
export interface SlotAuthInstall extends FleetAuthInstall {
  home: string;
  accountId: string;
}

/**
 * Every registered account's slot on this device (PHNX-3940 T1), as probe
 * targets. Before this the probe walked `listInstalledVersions` only, so a
 * slot's verdict was never re-derived after `accounts add/login` wrote it —
 * a slot re-materialized as `unconfigured` while the device doc was unreadable
 * stayed MISSING forever even though its login was live. A slot whose dir is
 * gone is skipped: there is nothing to probe and the row would only say so.
 */
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
export interface LocalAuthInstall extends FleetAuthInstall {
  home: string;
  accountId?: string;
}

/**
 * Every (agent, version) home the local auth probe covers on this device —
 * installed version homes plus account slots. {@link probeLocalFleetAuth} probes
 * exactly this set, so it is also the answer to "which cached rows are still
 * backed by something on disk" (PHNX-4051).
 */
export function enumerateLocalAuthInstalls(
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

/**
 * {@link authTargetKey} for every local probe target — what a cached row must
 * match to still be about this device. A row outside it is an ORPHAN: its home
 * was uninstalled, so nothing will ever re-probe it and its `checkedAt` is
 * frozen at whatever the last probe left (PHNX-4051).
 */
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

/**
 * Split a cache key back into the install it names, for one host. Returns null
 * for a key that belongs to another host or does not name a known agent — the
 * one place the `host:agent:version` join is undone.
 */
export function parseAuthCacheKey(key: string, host: string): { agent: AgentId; version: string } | null {
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

/**
 * Merge entries into the cache. An incoming `error` verdict (a network blip,
 * not a server rejection) is indeterminate, so it must NOT clobber a prior
 * known verdict — otherwise one 8s timeout flips a `live` chip to `error`,
 * exactly the "cry wolf" the verdict model avoids for `expired`. This is the
 * behaviour promised by the `error` doc on AuthVerdict ("keep the last known
 * one"). A probe-throttled 429 (detail `probe throttled (HTTP 429)`) keeps the
 * previous real verdict when one exists within {@link AUTH_PROBE_MAX_AGE_MS},
 * otherwise becomes `unverified` (PHNX-4051). Pure, so it's unit-tested directly. */
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

/**
 * Merge one or more entries into the cache (best-effort write).
 *
 * `drop` removes entries the writer knows are gone — it runs on the PRE-merge
 * cache, so an incoming row always wins over a drop of the same key and the two
 * can never fight. Only a writer that knows the full truth for the keys it drops
 * may pass one (see {@link writeFleetAuthRows}).
 */
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

/**
 * A usage snapshot this recent is live proof the account's shared setup-token
 * works: the snapshot only exists because an authenticated `/oauth/usage`
 * request succeeded. Matches the periodic tick's own probe window
 * (AUTH_PROBE_MAX_AGE_MS in daemon-ticks.ts — not imported to avoid a cycle;
 * a drift here only widens/narrows evidence freshness, never correctness).
 */
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
    /**
     * Skip the derived-from-usage shortcut and fire a real network probe
     * (RUSH-3036). Set by `agents devices ping [--strict]`, whose contract is
     * a genuinely live request that surfaces `revoked` immediately.
     */
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

/**
 * A set of installs that share one provider account and MUST be probed once.
 * The live probe runs against `probe` (the representative home); every entry in
 * `members` — the representative included — then receives that one verdict.
 */
export interface FleetAuthProbeGroup<T extends FleetAuthInstall> {
  probe: T;
  members: T[];
}

/**
 * Collapse installs so a live auth probe fires ONCE per (agent, account) rather
 * than once per version home.
 *
 * Several version homes signed into the same provider account share one OAuth
 * rate limit, so probing each of them concurrently — which the daemon did every
 * three minutes across every installed home (RUSH-2111) — raced that limit into
 * a 429 storm that then parked the whole box behind a `Retry-After` penalty (the
 * incident {@link file:./usage-backoff.ts} was written to survive; this removes
 * its cause). Grouping by account means N homes on one account issue ONE request.
 *
 * `isMergeable` scopes the dedup to the installs it actually helps: only agents
 * that make a network probe ({@link LIVE_PROBE_AGENTS}) can 429, so only they are
 * merged. A best-effort agent (its verdict is a cheap local file read, no rate
 * limit) is left per-install — collapsing it would gain nothing and could
 * silently override one home's local `signedIn` verdict with another's. Installs
 * with no resolvable account label, or that `isMergeable` rejects, are never
 * merged: each becomes its own group keyed by version, preserving the old
 * per-install probe (also the `unconfigured` case dropped downstream). Pure: no
 * fs, no network, so the dedup decision is unit-tested directly.
 */
/** Small fixed delay between live probes so one box no longer fires 16 requests in 4s (PHNX-4051). */
export const AUTH_PROBE_SPACING_MS = 150;

export function groupFleetAuthInstalls<T extends FleetAuthInstall>(
  installs: readonly T[],
  isMergeable: (install: T) => boolean = () => true,
): FleetAuthProbeGroup<T>[] {
  const groups = new Map<string, FleetAuthProbeGroup<T>>();
  for (const inst of installs) {
    // Prefer stable accountId (identity) — a version home and its slot share the
    // same id, so they collapse to ONE probe per identity (PHNX-4051). Fallback
    // to the display label when no id is known. The `id:`/`acct:`/`ver:` tokens
    // keep the three branches disjoint.
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

/**
 * Enumerate every installed (agent, version) on THIS host and return one row per
 * install (installs with no credential at all are dropped). Shared by
 * `agents fleet ping --local` and the daemon refresh.
 *
 * The live network probe is deduped by account: homes sharing one provider
 * account are probed ONCE and the verdict is fanned out to each home's row, so
 * the daemon's every-3-minute refresh can no longer fire concurrent same-account
 * requests and self-inflict a 429 (RUSH-2111). Each home still gets its own cache
 * row (the cache key is per-version by design — see {@link authCacheKey}).
 */
export async function probeLocalFleetAuth(opts?: {
  cliVersion?: string | null;
  agents?: readonly AgentId[];
  /** Fire real network probes even when fresh usage evidence exists (RUSH-3036) — the `devices ping [--strict]` contract. */
  forceLive?: boolean;
  /**
   * Deadline signal from the daemon's supervised auth tick (PHNX-3608). Aborts
   * the probe's in-flight network work when the tick deadline elapses so it
   * unwinds instead of leaking a runaway await; on-demand CLI callers omit it.
   */
  signal?: AbortSignal;
}): Promise<AuthProbeRow[]> {
  const agentIds = opts?.agents ?? ALL_AGENT_IDS;

  interface LocalInstall extends LocalAuthInstall {
    info: AccountInfo | null;
  }

  // Enumerate every install AND every account slot on this device, then resolve
  // each one's account label. getAccountInfo is a local credential-file read
  // (no network), so this fan-out is cheap and cannot contribute to the rate
  // limit the probe grouping below exists to avoid.
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

  // Probe once per (agent, identity) — but only for the network-probing agents
  // that can actually 429; best-effort agents stay per-install (see
  // groupFleetAuthInstalls). Groups are probed SEQUENTIALLY with a small fixed
  // delay between them (PHNX-4051) so one box no longer fires 16 requests in
  // 4s; they target distinct identities, so no same-account concurrency remains.
  const groups = groupFleetAuthInstalls(installs, (inst) => LIVE_PROBE_AGENTS.has(inst.agent));
  const perGroup: AuthProbeRow[][] = [];
  for (let idx = 0; idx < groups.length; idx++) {
    const group = groups[idx];
    const rep = group.probe;
    const health = await probeAuthHealth(rep.agent, rep.home, { cliVersion: opts?.cliVersion, info: rep.info, forceLive: opts?.forceLive, signal: opts?.signal });
    health.account = authAccountLabel(rep.info);
    health.accountId = rep.accountId;
    if (health.verdict === 'unconfigured') {
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

/**
 * Persist a host's probed rows into the cache (keyed by host+agent+version).
 *
 * `installed` — the {@link authTargetKey} set of homes that still exist on
 * `host` ({@link localAuthTargetKeys}) — prunes this host's ORPHAN entries: rows
 * for a version that has since been uninstalled. Nothing re-probes those, so
 * they never age out on their own; they froze the reuse window permanently false
 * and kept surfacing in `agents view` / fleet status (PHNX-4051). Only a caller
 * that enumerated `host`'s real installs may pass it — the `fleet ping` fan-out
 * writes a PEER's rows and cannot enumerate that box's homes, so it omits it and
 * merges as before.
 */
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
