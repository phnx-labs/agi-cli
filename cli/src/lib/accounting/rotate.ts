/** Account rotation across agent versions: detects installed versions with expired credentials and
 * rotates tokens so sessions stay active across version switches. */

import * as fs from 'fs';
import * as path from 'path';
import { isAgentId, type AgentId, type RunStrategy } from '../types.js';
import type { FallbackEntry } from '../exec.js';
import { PROJECTION_HORIZON_MIN, capacityWeight } from './capacity.js';
import {
  accountDisplayLabel,
  getAccountInfo,
  credentialPresence,
  ALL_AGENT_IDS,
  type AccountInfo,
  type CredentialPresence,
} from '../agents.js';
import { readMeta, getHelpersDir } from '../state.js';
import { resolveConfiguredModel } from '../models.js';
import { isTierToken, resolveTier } from '../model-tiers.js';
import { listInstalledVersions, getVersionHomePath, resolveVersion } from '../installations/versions.js';
import { resolveManagedInstallation } from '../installations/store.js';
import { listNativeAccounts } from '../account-registry.js';
import { resolveNativeSpawnHome } from '../exec-account-home.js';
import { getProjectRunConfigs } from '../run-config.js';
import { emit, type EventPayload } from '../feed/events.js';
import {
  getUsageInfoByIdentity,
  getUsageLookupKey,
  deriveUsageStatusFromSnapshot,
  getClaudeModelRefusal,
  claudeModelRefusalKey,
  type UsageSnapshot,
} from './usage.js';
import { readAccountHeadroom } from '../fleet-cache.js';
import { machineId } from '../machine-id.js';
import { AUTH_PROBE_MAX_AGE_MS, readAuthHealthCache, authCacheKey, slotAuthVersionKey, isDeadVerdict, type AuthVerdict } from '../auth-health.js';

function getRotateDir(): string {
  const dir = path.join(getHelpersDir(), 'rotate');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export interface RotateCandidate {
  agent: AgentId;
  version: string;
  accountKey: string | null;
  accountLabel: string;
  email: string | null;
  /** Per-org usage/quota key (e.g. `claude:org=<orgUuid>`), the unit rate limits are measured in
   * and so the dedup boundary; null when no usage identity is available, then email is used. */
  usageKey: string | null;
  usageStatus: AccountInfo['usageStatus'];
  usageSnapshot: UsageSnapshot | null;
  usageError: string | null;
  /** Projected minutes until the 5-hour session window caps, from the daemon's burn-rate refresher;
   * null when unknown. Balanced routing deprioritizes an account projected to cap soon (see
   * capacityWeight). */
  usageMinutesToLimit: number | null;
  plan: string | null;
  signedIn: boolean;
  /** Live auth-health verdict from the daemon's probe cache, or null with no probe row. `signedIn`
   * cannot tell a revoked-but-unexpired token, so eligibility excludes `revoked`; any other or
   * null verdict does not block. */
  authVerdict: AuthVerdict | null;
  /** Epoch milliseconds of the auth probe behind authVerdict, when present. */
  authCheckedAt?: number | null;
  lastActive: Date | null;
  /** Set only for a candidate from a provider account bundle (RUSH-3182): the account name injected
   * via `--account` (`resolveSpawnAccount`). Undefined for a native login, whose credential is in
   * `version`'s home. */
  providerAccount?: string;
  /** Native account name when this candidate is a slot (PHNX-3940 T5), used by the picker and
   * `#name` selector; `version` is the binary, no longer the account identity. */
  nativeAccount?: string;
  /** Stable registry id for {@link nativeAccount}; never inferred from version. */
  nativeAccountId?: string;
  providerAccountId?: string;
  /** Slot dir when this candidate is a slot — the spawn HOME. */
  slotDir?: string;
  /** True when this row came from `deviceAccounts.slots`, not a version home. */
  fromSlot?: boolean;
}

export interface RotateResult {
  /** The version picked for this run. */
  picked: RotateCandidate;
  /** Candidates that were considered healthy (including the picked one). */
  healthy: RotateCandidate[];
  /** Candidates excluded (not signed in, or out of credits). */
  excluded: RotateCandidate[];
  /** True when the picked candidate's usage could not be verified fresh, so the route was decided
   * blind. Callers surface it, including a stale pick from a mixed pool. */
  usageUnverified?: boolean;
  /** True when no candidate has a fresh snapshot and at least one has a stale one (PHNX-2526). The
   * initial route must not launch it: interactive diverts to the picker, unattended fails with
   * NO_VERIFIED_USAGE. A blind pool (RUSH-2392) stays false. */
  noVerifiedUsage?: boolean;
}

export const RUN_STRATEGIES: RunStrategy[] = ['pinned', 'available', 'balanced'];

/** Return a run strategy when the input is valid, otherwise null. `'rotate'` is a deprecated alias
 * for `'balanced'` so old yaml configs and `--strategy rotate` keep working. */
export function normalizeRunStrategy(value: unknown): RunStrategy | null {
  if (typeof value !== 'string') return null;
  if (value === 'rotate') return 'balanced';
  return RUN_STRATEGIES.includes(value as RunStrategy) ? value as RunStrategy : null;
}

/** Read project-local run strategy from the nearest agents.yaml, if present. */
function getProjectRunStrategy(agent: AgentId, startPath: string): RunStrategy | null {
  for (const runConfig of getProjectRunConfigs(startPath)) {
    const strategy = normalizeRunStrategy(runConfig[agent]?.strategy);
    if (strategy) return strategy;
  }

  return null;
}

/** Resolve the configured strategy: project-local agents.yaml, then ~/.agents/.system/agents.yaml,
 * else `balanced` (weighted-random by headroom, skipping rate-limited accounts) so a bare `agents
 * run` spreads load instead of sticking to a maxed pinned default. */
export function getConfiguredRunStrategy(agent: AgentId, startPath: string = process.cwd()): RunStrategy {
  return getProjectRunStrategy(agent, startPath)
    ?? normalizeRunStrategy(readMeta().run?.[agent]?.strategy)
    ?? 'balanced';
}

/** Whether an account may be rotated into now. Defined via readinessFromCandidate so the router's
 * pick and the pre-flight warning cannot disagree: eligible iff ready (signed in, not revoked, not
 * out of usage). */
/** Slot verdicts balanced/available will launch (PHNX-3940 T5). */
const LAUNCHABLE_SLOT_VERDICTS: ReadonlySet<AuthVerdict> = new Set(['live', 'unverified']);

function isLaunchableSlotVerdict(verdict: AuthVerdict | null): boolean {
  return verdict !== null && LAUNCHABLE_SLOT_VERDICTS.has(verdict);
}

function isRotationEligible(candidate: RotateCandidate, nowMs: number = Date.now(), model?: string): boolean {
  if (candidate.fromSlot && !isLaunchableSlotVerdict(candidate.authVerdict)) return false;
  return readinessFromCandidate(candidate, nowMs, model).ready;
}

/** Whether a version home can authenticate a launch. `getAccountInfo` falls back to the
 * active/global HOME, but launches isolate config per version, so an inheriting home dies on "Not
 * signed in". With a `knownLocation`, require the credential there. */
export function isLaunchableSignedIn(
  signedIn: boolean,
  presence: Pick<CredentialPresence, 'knownLocation' | 'perVersion'>,
): boolean {
  if (!signedIn) return false;
  if (!presence.knownLocation) return true;
  return presence.perVersion;
}

/** Launchable-signed-in verdict for ONE specific version on THIS device. */
interface VersionLaunchState {
  /** True iff this exact version home can spawn a signed-in agent right now. */
  launchable: boolean;
  /** The version home's account email when launchable, else null. */
  email: string | null;
}

/** Whether a specific installed version is launchable-signed-in here, plus its email. Mirrors the
 * per-version check in collectRunCandidates so the `run.launch` event reports the router's verdict
 * (yosemite-m3 2.1.219 incident: logged out, excluded, yet launched). Callers wrap it best-effort. */
export async function isVersionLaunchableHere(
  agent: AgentId,
  version: string,
): Promise<VersionLaunchState> {
  const home = getVersionHomePath(agent, version);
  const info = await getAccountInfo(agent, home);
  const launchable = isLaunchableSignedIn(info.signedIn, credentialPresence(agent, home));
  return { launchable, email: launchable ? info.email : null };
}

/** How old a usage snapshot may be and still settle a routing decision. A display may show an older
 * bar, but routing on one costs the run: yosemite-s1's 26h-2.7d snapshots read 48% while at the
 * weekly cap. */
export const USAGE_DECISION_MAX_AGE_MS = 5 * 60 * 1000;

/** How old a synced snapshot (from the account's poller via the fleet store) may be and still
 * settle a routing decision; matches the usage-sync tick. Local captures keep
 * USAGE_DECISION_MAX_AGE_MS. */
export const USAGE_SYNC_TRUST_MS = 15 * 60 * 1000;

/** Snapshot age past which routing refuses to run (NO_VERIFIED_USAGE), versus the 5-min bar for
 * weighting. Idle accounts are legitimately 10-30 min old because the daemon paces refreshes; 40
 * min clears that yet stays far below a broken refresh's hours-old readings. */
export const USAGE_STALE_REFUSAL_MAX_AGE_MS = 40 * 60 * 1000;

/** Max age at which this candidate's usage number is trusted. A missing or window-less (plan-only)
 * snapshot is never verified: a meterless harness (Grok) would otherwise pin the most recently
 * logged account. */
export function usageVerifiedMaxAgeMs(snapshot: UsageSnapshot | null | undefined): number {
  // D8: a row that arrived via sync from the account's own poller is trusted
  // for the sync cadence. A locally captured row (poll / statusline / unset)
  // keeps the 5-minute bar — the poller is on this box and can refresh it.
  return snapshot?.freshness?.source === 'sync' ? USAGE_SYNC_TRUST_MS : USAGE_DECISION_MAX_AGE_MS;
}

export function isUsageVerified(candidate: RotateCandidate, nowMs: number = Date.now()): boolean {
  const snapshot = candidate.usageSnapshot;
  const capturedAt = snapshot?.capturedAt;
  if (!capturedAt || !snapshot?.windows.length) return false;
  return nowMs - capturedAt.getTime() <= usageVerifiedMaxAgeMs(snapshot);
}

/** Whether the candidate holds a genuinely stale number: windows present and older than the 40-min
 * refusal bar. Narrower than not-verified: a blind or meterless candidate has no number to be
 * misled by (RUSH-2392, PHNX-3392), so it never refuses. */
export function hasStaleUsage(candidate: RotateCandidate, nowMs: number = Date.now()): boolean {
  const snapshot = candidate.usageSnapshot;
  const capturedAt = snapshot?.capturedAt;
  if (!capturedAt || !snapshot?.windows.length) return false;
  // A synced row (PHNX-4116) cannot be refreshed here; its poller is on the publishing device. Its
  // age is shown, never used to refuse: a blind pool takes a floor-weight pick and failover
  // handles a real 429 (GWT-E5d).
  if (snapshot.freshness?.source === 'sync') return false;
  return nowMs - capturedAt.getTime() > USAGE_STALE_REFUSAL_MAX_AGE_MS;
}

function hasUsageAvailable(candidate: RotateCandidate, now: number = Date.now()): boolean {
  const snapshot = candidate.usageSnapshot;
  if (snapshot) {
    // Eligibility mirrors the `agents view` throttle badge: an account maxed on any blocking
    // window, session included, must not be picked. Weighting still uses weekly headroom; this
    // only decides can-it-run-now.
    const status = deriveUsageStatusFromSnapshot(snapshot, now);
    if (status !== null) return status !== 'rate_limited';
  }

  // No live snapshot: fall back to the coarse cached status.
  if (candidate.usageStatus === 'out_of_credits' || candidate.usageStatus === 'rate_limited') {
    return false;
  }

  return true;
}

/** Whether an account can serve a run now, and why not. `revoked` is a token the server rejected
 * (live auth-health probe); used to pre-warn on a version-pinned teammate that rotation won't
 * route around. */
export type AccountReadiness =
  | { ready: true }
  | {
      ready: false;
      reason: 'rate_limited' | 'out_of_credits' | 'signed_out' | 'revoked' | 'model_limited';
      email: string | null;
    };

/** Pure decision reusing the router's own eligibility (`isRotationEligible`) so a pre-flight
 * warning never disagrees with rotation. A live snapshot wins over cached status. `model` also
 * checks a per-(account, model) refusal keyed on the native account id, never the org usageKey. */
export function readinessFromCandidate(
  candidate: RotateCandidate,
  now: number = Date.now(),
  model?: string,
): AccountReadiness {
  if (!candidate.signedIn) {
    return { ready: false, reason: 'signed_out', email: candidate.email };
  }
  // A token the live probe saw rejected (401/403, `revoked`) fails auth at spawn regardless of
  // headroom, so exclude it before the usage check. Any other or null verdict does not block.
  const authFresh = candidate.authCheckedAt == null
    || now - candidate.authCheckedAt <= AUTH_PROBE_MAX_AGE_MS;
  if (authFresh && candidate.authVerdict !== null && isDeadVerdict(candidate.authVerdict)) {
    return { ready: false, reason: 'revoked', email: candidate.email };
  }
  const modelKey = claudeModelRefusalKey(candidate.nativeAccountId ?? candidate.providerAccountId, candidate.providerAccount ? undefined : candidate.slotDir ?? getVersionHomePath(candidate.agent, candidate.version));
  if (candidate.agent === 'claude' && modelKey) {
    const requested = model ?? resolveConfiguredModel(candidate.agent, candidate.version, candidate.slotDir)?.model;
    const concrete = requested && isTierToken(requested)
      ? resolveTier(candidate.agent, candidate.version, requested).model
      : requested;
    if (concrete && getClaudeModelRefusal(modelKey, concrete, now)) {
      return { ready: false, reason: 'model_limited', email: candidate.email };
    }
  }
  if (hasUsageAvailable(candidate, now)) {
    return { ready: true };
  }
  const snap = candidate.usageSnapshot;
  const snapRateLimited =
    !!snap && snap.windows.length > 0 && deriveUsageStatusFromSnapshot(snap, now) === 'rate_limited';
  const reason: 'rate_limited' | 'out_of_credits' =
    !snapRateLimited && candidate.usageStatus === 'out_of_credits' ? 'out_of_credits' : 'rate_limited';
  return { ready: false, reason, email: candidate.email };
}

/** Whether signing in can clear this exclusion. `signed_out`/`revoked` are recoverable: the
 * harness's TUI is the login surface (RUSH-2334). `rate_limited`/`out_of_credits` are not;
 * launching hammers an exhausted account (the loop RUSH-2132's fail-loud guard stops). */
export function isSignInRecoverable(readiness: AccountReadiness): boolean {
  return !readiness.ready && (readiness.reason === 'signed_out' || readiness.reason === 'revoked');
}

/** The subset of an `exhausted` set a sign-in would clear, so an interactive caller can offer
 * login. Empty means every account is throttled and the caller keeps failing loud. */
export function signInRecoverableCandidates(candidates: RotateCandidate[]): RotateCandidate[] {
  return candidates.filter((c) => isSignInRecoverable(readinessFromCandidate(c)));
}

/** Readiness for a specific installed (agent, version); `{ ready: true }` when it isn't among the
 * candidates (absence is the caller's concern). Meaningful only for a version-pinned target: bare
 * targets rotate and profiles inject their own auth. */
export async function checkRunAccountReadiness(agent: AgentId, version: string): Promise<AccountReadiness> {
  const candidates = await collectRunCandidates(agent);
  const candidate = candidates.find((c) => c.version === version);
  if (!candidate) return { ready: true };
  return readinessFromCandidate(candidate);
}

function getRoutingUsedPercent(snapshot: UsageSnapshot | null | undefined): number | null {
  if (!snapshot || snapshot.windows.length === 0) return null;
  const routingWindows = snapshot.windows.filter((window) => window.key !== 'session');
  const windows = routingWindows.length > 0 ? routingWindows : snapshot.windows;
  return Math.max(...windows.map((window) => window.usedPercent));
}

function compareCandidates(a: RotateCandidate, b: RotateCandidate): number {
  const au = getRoutingUsedPercent(a.usageSnapshot);
  const bu = getRoutingUsedPercent(b.usageSnapshot);

  if (au !== null || bu !== null) {
    if (au === null) return 1;
    if (bu === null) return -1;
    if (au !== bu) return au - bu;
  }

  const ta = a.lastActive ? a.lastActive.getTime() : 0;
  const tb = b.lastActive ? b.lastActive.getTime() : 0;
  if (ta !== tb) return ta - tb;
  return Math.random() - 0.5;
}

/** Identity a candidate dedups on. Quota is per-org, so versions sharing an org collapse while two
 * orgs under one email stay distinct. Prefer the org usage key; fall back to email only without a
 * usage identity. */
export function candidateAccountKey(c: RotateCandidate): string {
  if (c.nativeAccountId) return `native:${c.nativeAccountId}`;
  if (c.providerAccount) return `provider:${c.providerAccount}`;
  return c.usageKey ?? c.accountKey ?? c.email ?? `${c.agent}:unregistered:${c.accountLabel || c.version}`;
}

function dedupeAndSortCandidates(candidates: RotateCandidate[]): RotateCandidate[] {
  const byIdentity = new Map<string, RotateCandidate>();
  for (const c of candidates) {
    const id = candidateAccountKey(c);
    const existing = byIdentity.get(id);
    if (!existing) {
      byIdentity.set(id, c);
      continue;
    }
    if (compareCandidates(c, existing) < 0) byIdentity.set(id, c);
  }

  return [...byIdentity.values()].sort(compareCandidates);
}

/** Pick a healthy candidate by weighted random on weekly headroom, weight max(1, 100 -
 * usedPercent). Eligible: signed in, no window at 100%. Dedupes shared identities (org key over
 * email). Null if none eligible (caller uses pinned). `model` also excludes a per-model refusal. */
export function pickBalancedCandidate(
  candidates: RotateCandidate[],
  nowMs: number = Date.now(),
  model?: string,
): RotateResult | null {
  const healthy: RotateCandidate[] = [];
  const excluded: RotateCandidate[] = [];
  for (const c of candidates) {
    if (!isRotationEligible(c, nowMs, model)) {
      excluded.push(c);
      continue;
    }
    healthy.push(c);
  }

  if (healthy.length === 0) return null;

  const sorted = dedupeAndSortCandidates(healthy);
  const deduped = new Set(sorted);
  for (const c of healthy) {
    if (!deduped.has(c)) excluded.push(c);
  }

  const { picked, usageUnverified, noVerifiedUsage } = preferVerified(
    sorted,
    nowMs,
    (from) => weightedRandomByCapacity(from, nowMs),
    'representative',
  );
  return { picked, healthy: sorted, excluded, usageUnverified, noVerifiedUsage };
}

/** Choose from verified candidates when they are at least half the pool, else the whole pool:
 * narrowing to a verified minority pins one account when the usage endpoint 429-throttles
 * (2026-08-20). Deterministic choosers use `'any-verified'`; `healthy` keeps all for failover. */
function preferVerified(
  pool: RotateCandidate[],
  nowMs: number,
  choose: (from: RotateCandidate[]) => RotateCandidate,
  narrowing: 'any-verified' | 'representative' = 'any-verified',
): { picked: RotateCandidate; usageUnverified: boolean; noVerifiedUsage: boolean } {
  const verified = pool.filter((c) => isUsageVerified(c, nowMs));
  const narrow =
    verified.length > 0 &&
    (narrowing === 'any-verified' || verified.length >= Math.ceil(pool.length / 2));
  const picked = choose(narrow ? verified : pool);
  // Entirely-stale means zero verified and at least one stale-but-present number. A blind pool
  // does not trip this (see hasStaleUsage). `picked` is still returned so `healthy` stays whole
  // for failover; the initial selection acts on this flag instead of launching the stale pick.
  const noVerifiedUsage = verified.length === 0 && pool.some((c) => hasStaleUsage(c, nowMs));
  return {
    picked,
    usageUnverified: !isUsageVerified(picked, nowMs),
    noVerifiedUsage,
  };
}

// capacityWeight and PROJECTION_HORIZON_MIN live in ./capacity.js, a dependency-free module;
// re-exported here so existing importers keep resolving them.
export { PROJECTION_HORIZON_MIN, capacityWeight };

/** Pick one candidate from `sorted` with weights proportional to remaining capacity (see
 * capacityWeight), floored at 1 so a near-exhausted but eligible candidate can still be picked. */
function weightedRandomByCapacity(
  sorted: RotateCandidate[],
  nowMs: number = Date.now(),
): RotateCandidate {
  const weights = sorted.map((c) =>
    capacityWeight(
      // An unverified snapshot weights as the floor, not by its frozen usedPercent; otherwise a
      // day-old 45% used outweighed a verified account and balanced launched into a capped one
      // (PHNX-3479).
      isUsageVerified(c, nowMs) ? getRoutingUsedPercent(c.usageSnapshot) : null,
      c.usageMinutesToLimit,
    ),
  );
  const total = weights.reduce((sum, w) => sum + w, 0);
  if (total <= 0) return sorted[0];
  let roll = Math.random() * total;
  for (let i = 0; i < sorted.length; i++) {
    roll -= weights[i];
    if (roll <= 0) return sorted[i];
  }
  return sorted[sorted.length - 1];
}

/** Pick an available candidate: the configured pinned version when it has usage available, else the
 * candidate with the most usage headroom. */
export function pickAvailableCandidate(
  candidates: RotateCandidate[],
  preferredVersion?: string | null,
  nowMs: number = Date.now(),
  model?: string,
): RotateResult | null {
  const healthy: RotateCandidate[] = [];
  const excluded: RotateCandidate[] = [];
  for (const c of candidates) {
    if (!isRotationEligible(c, nowMs, model)) {
      excluded.push(c);
      continue;
    }
    healthy.push(c);
  }

  if (healthy.length === 0) return null;

  const sorted = dedupeAndSortCandidates(healthy);
  const deduped = new Set(sorted);
  for (const c of healthy) {
    if (!deduped.has(c)) excluded.push(c);
  }

  // `available` takes the front of the headroom sort, so an unconfirmed 48% used would outrank an
  // accurate 90% used, as under `balanced`. It routes on the same cache, so confirmed headroom
  // comes first.
  const { picked: bestVerified, usageUnverified, noVerifiedUsage } = preferVerified(sorted, nowMs, (from) => from[0]);
  // An explicit version preference is an instruction, not a ranking signal, so it
  // still wins — but only while that version is actually eligible.
  const preferred = preferredVersion
    ? sorted.find((candidate) => candidate.version === preferredVersion)
    : undefined;
  // `noVerifiedUsage` rides along even when `preferred` resolves: an all-stale pool makes
  // `preferred` stale too, and auto-selecting the pin on a stale number is what PHNX-2526 refuses.
  // resolveRunVersion acts on it.
  return { picked: preferred ?? bestVerified, healthy: sorted, excluded, usageUnverified, noVerifiedUsage };
}

/** Per-harness routing summary for `agents run auto`, the cross-harness layer above the per-harness
 * `pickBalancedCandidate`. */
interface HarnessSummary {
  agent: AgentId;
  /** Every installed account slot probed for this harness. */
  candidates: RotateCandidate[];
  /** Healthy accounts after identity dedupe, sorted by headroom. */
  healthy: RotateCandidate[];
  /** The account this harness would route to (best verified headroom). Null when the harness is excluded. */
  best: RotateCandidate | null;
  /** Routing used% of `best` (max across non-session windows); null when unknown. */
  bestUsedPercent: number | null;
  /** Why the harness was excluded, e.g. ['2 rate_limited', '1 signed_out']. Empty when healthy. */
  exclusionReasons: string[];
}

interface HarnessPickResult {
  /** The harness picked for this run. */
  picked: HarnessSummary;
  /** Harnesses with ≥1 healthy account (including the picked one). */
  healthy: HarnessSummary[];
  /** Harnesses with zero healthy accounts — excluded, not down-weighted. */
  excluded: HarnessSummary[];
}

/** Classify each harness's candidates into healthy (with a best account) vs excluded (with
 * per-reason counts). Pure, so the pick and the zero-healthy error cannot disagree. Uses
 * `isRotationEligible` and `preferVerified`, the account layer's own rules. */
export function classifyHarnessCandidates(
  byHarness: ReadonlyMap<AgentId, RotateCandidate[]>,
  nowMs: number = Date.now(),
): HarnessSummary[] {
  const summaries: HarnessSummary[] = [];
  for (const [agent, candidates] of byHarness) {
    const eligible = candidates.filter((c) => isRotationEligible(c, nowMs));
    if (eligible.length === 0) {
      const counts = new Map<string, number>();
      for (const c of candidates) {
        const readiness = readinessFromCandidate(c, nowMs);
        const reason = readiness.ready ? 'ineligible' : readiness.reason;
        counts.set(reason, (counts.get(reason) ?? 0) + 1);
      }
      summaries.push({
        agent,
        candidates,
        healthy: [],
        best: null,
        bestUsedPercent: null,
        exclusionReasons: [...counts.entries()].map(([reason, n]) => `${n} ${reason}`),
      });
      continue;
    }
    const sorted = dedupeAndSortCandidates(eligible);
    const { picked: best } = preferVerified(sorted, nowMs, (from) => from[0]);
    summaries.push({
      agent,
      candidates,
      healthy: sorted,
      best,
      bestUsedPercent: getRoutingUsedPercent(best.usageSnapshot),
      exclusionReasons: [],
    });
  }
  return summaries;
}

/** Pick a harness for `agents run auto` by weighted random on best-account headroom, `100 -
 * min(used%)` (RUSH-2132). Reuses `weightedRandomByCapacity`; harnesses with no healthy account
 * are excluded, not down-weighted. Null when none is healthy. */
export function pickHarnessWeighted(
  byHarness: ReadonlyMap<AgentId, RotateCandidate[]>,
  nowMs: number = Date.now(),
): HarnessPickResult | null {
  const summaries = classifyHarnessCandidates(byHarness, nowMs);
  const healthy = summaries.filter((s) => s.best !== null);
  const excluded = summaries.filter((s) => s.best === null);
  if (healthy.length === 0) return null;
  const pickedBest = weightedRandomByCapacity(healthy.map((s) => s.best!), nowMs);
  const picked = healthy.find((s) => s.best === pickedBest)!;
  return { picked, healthy, excluded };
}

/** One-line banner naming the auto-picked harness and why (headroom). */
export function formatHarnessPickBanner(result: HarnessPickResult): string {
  const { picked, healthy, excluded } = result;
  const headroom = picked.bestUsedPercent === null
    ? 'best account headroom unknown'
    : `best account ${Math.max(0, Math.round(100 - picked.bestUsedPercent))}% headroom`;
  const ratio = `${healthy.length} of ${healthy.length + excluded.length} harnesses healthy`;
  return `[agents] auto picked ${picked.agent} (${headroom}, ${ratio})`;
}

/** The earliest future window reset across these snapshots, i.e. when the first exhausted account
 * is usable again. Null when no snapshot carries a reset timestamp. */
export function earliestResetAcross(candidates: RotateCandidate[], nowMs: number = Date.now()): Date | null {
  let earliest: number | null = null;
  for (const c of candidates) {
    for (const window of c.usageSnapshot?.windows ?? []) {
      const t = window.resetsAt?.getTime();
      if (t != null && t > nowMs && (earliest === null || t < earliest)) {
        earliest = t;
      }
    }
  }
  return earliest === null ? null : new Date(earliest);
}

/** The `resets <summary>` fragment both zero-healthy errors share: ISO 8601 so a watchdog can parse
 * the cooldown, `unknown` when no snapshot has a reset. */
function formatResetSummary(reset: Date | null): string {
  return reset ? reset.toISOString() : 'unknown (no reset timestamps in any snapshot)';
}

/** The zero-healthy-account error (RUSH-2132). Exact contract: the Factory watchdog tail-detects
 * the literal `no healthy` and `resets <time>` (parsed for the rotate cooldown). Do not deviate. */
export function formatNoHealthyAccountError(
  agent: AgentId,
  strategy: RunStrategy,
  excluded: RotateCandidate[],
  nowMs: number = Date.now(),
): string {
  const excludedStr = excluded.length === 0
    ? 'no installed versions'
    : excluded.map((c) => {
        const readiness = readinessFromCandidate(c, nowMs);
        const reason = readiness.ready ? 'ineligible' : readiness.reason;
        return `${c.version} (${reason})`;
      }).join(', ');
  const resetSummary = formatResetSummary(earliestResetAcross(excluded, nowMs));
  return `agents: no healthy ${agent} account under strategy '${strategy}' — excluded: ${excludedStr}; earliest window resets ${resetSummary}. Use --strategy pinned to force the default.`;
}

/** How old this candidate's usage snapshot is, in whole minutes, or null when blind. Used only to
 * explain why a route was refused as unverified, never to route on. */
function snapshotAgeMinutes(candidate: RotateCandidate, nowMs: number): number | null {
  const capturedAt = candidate.usageSnapshot?.capturedAt;
  if (!capturedAt || !candidate.usageSnapshot?.windows.length) return null;
  return Math.max(0, Math.round((nowMs - capturedAt.getTime()) / 60_000));
}

/** The all-stale-usage error (PHNX-2526) an unattended `balanced`/`available` run fails with. It
 * must contain the literal `NO_VERIFIED_USAGE`, distinct from the `no healthy` throttle error, so
 * the Factory watchdog can detect it. Names each candidate's staleness. */
export function formatNoVerifiedUsageError(
  agent: AgentId,
  strategy: RunStrategy,
  candidates: RotateCandidate[],
  nowMs: number = Date.now(),
): string {
  const detail = candidates.length === 0
    ? 'no signed-in accounts'
    : candidates.map((c) => {
        const age = snapshotAgeMinutes(c, nowMs);
        // A synced row's age never drives a refusal (see hasStaleUsage), so name
        // it as synced rather than letting the operator read it as the culprit.
        const synced = c.usageSnapshot?.freshness?.source === 'sync';
        const staleness = age === null
          ? 'no usage snapshot'
          : `usage ${age}m old${synced ? ', synced' : ''}`;
        return `${c.version} (${staleness})`;
      }).join(', ');
  const maxAgeMin = Math.round(USAGE_STALE_REFUSAL_MAX_AGE_MS / 60_000);
  return `agents: NO_VERIFIED_USAGE — no signed-in ${agent} account has usage newer than ${maxAgeMin}m under strategy '${strategy}', so routing refuses to guess on a stale number: ${detail}. Refresh usage (agents view ${agent}) or pin the default with --strategy pinned.`;
}

/** The zero-healthy-harness error for `agents run auto`: each harness's exclusion reason plus the
 * earliest reset across all snapshots. */
export function formatNoHealthyHarnessError(
  summaries: HarnessSummary[],
  nowMs: number = Date.now(),
): string {
  const excludedStr = summaries.length === 0
    ? 'no installed harnesses'
    : summaries.map((s) => {
        const n = s.candidates.length;
        const detail = s.exclusionReasons.length > 0 ? s.exclusionReasons.join(', ') : 'no accounts signed in';
        return `${s.agent} (${n} account${n === 1 ? '' : 's'}: ${detail})`;
      }).join(', ');
  const resetSummary = formatResetSummary(earliestResetAcross(summaries.flatMap((s) => s.candidates), nowMs));
  return `agents: no healthy harness for 'run auto' — excluded: ${excludedStr}; earliest window resets ${resetSummary}. Sign in an account or wait for a window to reset.`;
}

export async function collectRunCandidates(agent: AgentId): Promise<RotateCandidate[]> {
  const versions = listInstalledVersions(agent);
  // Read the local auth-health probe cache once (cache-only, no network; the daemon is the sole
  // writer). A `revoked` verdict excludes that (host, agent, version); a missing row is fail-open.
  const authCache = readAuthHealthCache();
  const localHost = machineId();
  const meta = readMeta();
  const binaryLabel = resolveManagedInstallation(agent)?.label ?? versions[0];

  type CandidateRow = {
    agent: AgentId;
    version: string;
    home: string;
    info: AccountInfo;
    accountKey: string | null;
    accountLabel: string;
    email: string | null;
    usageStatus: AccountInfo['usageStatus'];
    plan: string | null;
    signedIn: boolean;
    authVerdict: AuthVerdict | null;
    authCheckedAt: number | null;
    lastActive: Date | null;
    nativeAccount?: string;
    nativeAccountId?: string;
    providerAccountId?: string;
    slotDir?: string;
    fromSlot?: boolean;
  };

  const slotRows: CandidateRow[] = [];
  const slotDirs = new Set<string>();
  if (binaryLabel) {
    const natives = listNativeAccounts(meta).filter((row) => row.agent === agent);
    const probed = await Promise.all(natives.map(async (account) => {
      const resolved = await resolveNativeSpawnHome(agent, account, meta, { readOnly: true }).catch(() => null);
      if (!resolved) return null;
      const slot = resolved.slot;
      const home = resolved.execHome;
      const version = resolved.label ?? binaryLabel;
      const cachedHealth = authCache[authCacheKey(localHost, agent, slot ? slotAuthVersionKey(account.id) : version)];
      const authHealth = cachedHealth && Date.now() - cachedHealth.checkedAt <= AUTH_PROBE_MAX_AGE_MS ? cachedHealth : undefined;
      const effectiveVerdict = authHealth?.verdict ?? slot?.verdict ?? null;
      const info = await getAccountInfo(agent, home);
      const launchable = isLaunchableSignedIn(info.signedIn, credentialPresence(agent, home));
      const slotOk = !slot || isLaunchableSlotVerdict(effectiveVerdict);
      return {
        agent,
        version,
        home,
        info,
        accountKey: launchable ? info.accountKey : null,
        accountLabel: account.name || (launchable ? accountDisplayLabel(info) : ''),
        email: launchable ? info.email : null,
        usageStatus: launchable ? info.usageStatus : null,
        plan: launchable ? info.plan : null,
        signedIn: launchable && slotOk,
        authVerdict: effectiveVerdict,
        authCheckedAt: (() => {
          if (authHealth) return authHealth.checkedAt;
          const ts = slot?.checkedAt ? Date.parse(slot.checkedAt) : NaN;
          return Number.isFinite(ts) ? ts : null;
        })(),
        lastActive: info.lastActive,
        nativeAccount: account.name,
        nativeAccountId: account.id,
        slotDir: home,
        fromSlot: !!slot,
      };
    }));
    for (const row of probed) {
      if (!row) continue;
      slotRows.push(row);
      slotDirs.add(fs.realpathSync(row.home));
    }
  }

  // Legacy per-account installations (`acct-*` homes) until T7 migrates them.
  const versionRows: Array<CandidateRow | null> = await Promise.all(
    versions.map(async (version): Promise<CandidateRow | null> => {
      const home = getVersionHomePath(agent, version);
      if (fs.existsSync(home) && slotDirs.has(fs.realpathSync(home))) return null;
      const info = await getAccountInfo(agent, home);
      // Do not call isClaudeAuthValid(home): its keychain item has Claude Code in the ACL, so
      // every probe pops a macOS authorization sheet per version. Require a real per-version
      // credential (isLaunchableSignedIn), or empty homes look healthy.
      const launchable = isLaunchableSignedIn(info.signedIn, credentialPresence(agent, home));
      const authHealth = authCache[authCacheKey(localHost, agent, version)];
      const authVerdict = authHealth?.verdict ?? null;
      return {
        agent,
        version,
        home,
        info,
        accountKey: launchable ? info.accountKey : null,
        accountLabel: launchable ? accountDisplayLabel(info) : '',
        email: launchable ? info.email : null,
        usageStatus: launchable ? info.usageStatus : null,
        plan: launchable ? info.plan : null,
        signedIn: launchable,
        authVerdict,
        authCheckedAt: authHealth?.checkedAt ?? null,
        lastActive: info.lastActive,
      };
    })
  );

  const rows: CandidateRow[] = [...slotRows, ...versionRows.filter((row): row is CandidateRow => row !== null)];

  // Cache-only (`readOnly`) because it feeds routing on the `agents run` hot path and must not
  // block on live provider fetches. Staleness is enforced by `isUsageVerified`; the daemon
  // (`runUsageRefresh`) keeps the cache fresh. A stale or absent snapshot routes as unverified.
  const { usageByKey } = await getUsageInfoByIdentity(
    rows.map(({ home, info, version }) => ({
      agentId: agent,
      home,
      cliVersion: version,
      info,
    })),
  );

  return rows.map(({ home: _home, info, ...candidate }) => {
    const usageKey = getUsageLookupKey(info);
    const usage = usageKey ? usageByKey.get(usageKey) : undefined;
    // Projected headroom is a separate cache-only read (also off the network) —
    // the daemon publishes minutesToLimit; a cold cache yields null and routing
    // falls back to snapshot-only weighting.
    const headroom = usageKey ? readAccountHeadroom(usageKey) : null;
    return {
      ...candidate,
      usageKey,
      usageSnapshot: usage?.snapshot ?? null,
      usageError: usage?.error ?? null,
      usageMinutesToLimit: headroom?.minutesToLimit ?? null,
    };
  });
}

/** Collect run candidates for every harness with at least one installed version, the probe `agents
 * run auto` routes on. Harnesses with nothing installed are absent from the map, not excluded. */
export async function collectHarnessCandidates(
  agentIds: AgentId[] = ALL_AGENT_IDS,
): Promise<Map<AgentId, RotateCandidate[]>> {
  const entries = await Promise.all(
    agentIds.map(async (agent) => {
      if (listInstalledVersions(agent).length === 0) return null;
      return [agent, await collectRunCandidates(agent)] as const;
    }),
  );
  const byHarness = new Map<AgentId, RotateCandidate[]>();
  for (const entry of entries) {
    if (entry) byHarness.set(entry[0], entry[1]);
  }
  return byHarness;
}

/** Resolve an account identity to the installed version slot holding it, over an already-collected
 * list. Pure. Matches `email` or `accountKey` case-insensitively and returns only a signed-in
 * slot, else null. */
export function matchAccountCandidate(
  candidates: RotateCandidate[],
  account: string,
  preferredLabel?: string | null,
): RotateCandidate | null {
  const needle = account.trim().toLowerCase();
  if (!needle) return null;
  const matching = candidates.filter(
    (c) =>
      c.signedIn &&
      (c.email?.toLowerCase() === needle
        || c.accountKey?.toLowerCase() === needle
        || c.nativeAccount?.toLowerCase() === needle
        || c.nativeAccountId?.toLowerCase() === needle
        || c.providerAccount?.toLowerCase() === needle),
  );
  return matching.find(candidate => candidate.version === preferredLabel) ?? matching[0] ?? null;
}

export function matchAccountVersion(
  candidates: RotateCandidate[],
  account: string,
  preferredLabel?: string | null,
): string | null {
  return matchAccountCandidate(candidates, account, preferredLabel)?.version ?? null;
}

/** Resolve a routine's `account:` pin (email, account key, or native name) to its current
 * candidate. Pinning a routine to a distinct account cures the shared refresh-token revocation
 * storm (RUSH-1957), and `nativeAccount` disambiguates two slots on one managed install. */
export async function resolveAccountCandidate(
  agent: AgentId,
  account: string,
  preferredLabel?: string | null,
): Promise<RotateCandidate | null> {
  const candidates = await collectRunCandidates(agent);
  return matchAccountCandidate(candidates, account, preferredLabel);
}

export async function resolveAccountVersion(
  agent: AgentId,
  account: string,
  preferredLabel?: string | null,
): Promise<string | null> {
  return (await resolveAccountCandidate(agent, account, preferredLabel))?.version ?? null;
}

/** Pick a healthy version for `agent` by weighted random on remaining capacity (see
 * pickBalancedCandidate). Stateless: health and capacity come from per-version AccountInfo. Null if
 * none eligible; callers fall back to the global default, never refusing to run. */
export async function selectBalancedVersion(agent: AgentId): Promise<RotateResult | null> {
  return pickBalancedCandidate(await collectRunCandidates(agent));
}

/** Record a rotation pick so parallel callers see it as recently used. A torn write only yields a
 * stale timestamp, so no locking. */
function recordRotationPick(agent: AgentId, version: string): void {
  const stampPath = path.join(getRotateDir(), `stamp-${agent}.json`);
  try {
    fs.writeFileSync(stampPath, JSON.stringify({ version, ts: Date.now() }), 'utf-8');
  } catch { /* best effort — doesn't block the run */ }
}

/** Read the most recent rotation pick for an agent; null if there is no stamp or it is over 60
 * seconds old. */
function readRotationStamp(agent: AgentId): string | null {
  const stampPath = path.join(getRotateDir(), `stamp-${agent}.json`);
  try {
    const raw = JSON.parse(fs.readFileSync(stampPath, 'utf-8')) as { version: string; ts: number };
    if (Date.now() - raw.ts < 60_000) return raw.version;
  } catch { /* missing or corrupt — treat as no stamp */ }
  return null;
}

/** Cap on candidates serialized into a rotation decision event. Emitted as a keyed object, not an
 * array, so the sink's `sanitizeNested` does not truncate to its 10-element cap (feed/events.ts). */
const ROTATION_EVENT_CANDIDATE_CAP = 32;

/** Compact descriptor of one candidate as the router saw it, for the
 * `rotation.resolved`/`unresolved` event. `usageKey` is the only identity joining an account
 * across devices; `tier` is verified/stale/blind; verified with large `ageMs` means clock skew. */
function describeRotationCandidate(c: RotateCandidate, nowMs: number): Record<string, unknown> {
  const snap = c.usageSnapshot;
  const capturedAtMs = snap?.capturedAt ? snap.capturedAt.getTime() : null;
  const tier = isUsageVerified(c, nowMs) ? 'verified' : hasStaleUsage(c, nowMs) ? 'stale' : 'blind';
  const readiness = readinessFromCandidate(c);
  return {
    usageKey: c.usageKey,
    // A RUSH-3182 provider account has a null usageKey and shares its `version` with the native
    // login and siblings, so `accountKey` plus `providerAccount` keep same-version rows distinct.
    accountKey: c.accountKey,
    providerAccount: c.providerAccount ?? null,
    email: c.email,
    version: c.version,
    signedIn: c.signedIn,
    // Not `authVerdict`: the event sink redacts any payload key matching /auth/i (feed/events.ts
    // SENSITIVE_PAYLOAD_KEY), which would blank this field. `credentialVerdict` carries the same
    // value.
    credentialVerdict: c.authVerdict,
    usageStatus: c.usageStatus,
    tier,
    source: snap?.source ?? null,
    sourceLabel: snap?.sourceLabel ?? null,
    captureSource: snap?.freshness?.source ?? null,
    pollerDevice: snap?.freshness?.poller ?? null,
    capturedAt: snap?.capturedAt ? snap.capturedAt.toISOString() : null,
    ageMs: capturedAtMs === null ? null : nowMs - capturedAtMs,
    windows: (snap?.windows ?? []).map((w) => ({ key: w.key, usedPercent: Math.round(w.usedPercent) })),
    unavailable: snap?.unavailable?.reason ?? null,
    eligible: readiness.ready,
    excludedReason: readiness.ready ? null : readiness.reason,
  };
}

/** Build the `rotation.resolved`/`unresolved` payload: the full candidate pool, the pick and why,
 * and a freshness tally. Replaces the counts-only shape that could not tell a blind draw from a
 * refused-stale route. All candidates share one `nowMs` so `tier`/`ageMs` are consistent. */
export function buildRotationDecisionEvent(
  rotation: RotateResult,
  agent: AgentId,
  strategy: RunStrategy,
): EventPayload {
  const nowMs = Date.now();
  const tally = { verified: 0, stale: 0, blind: 0 };
  for (const c of rotation.healthy) {
    const t = isUsageVerified(c, nowMs) ? 'verified' : hasStaleUsage(c, nowMs) ? 'stale' : 'blind';
    tally[t] += 1;
  }
  const pickedTier = isUsageVerified(rotation.picked, nowMs)
    ? 'verified'
    : hasStaleUsage(rotation.picked, nowMs)
      ? 'stale'
      : 'blind';
  // WHY the pick: verified-weighted draw is the healthy path, `unverified-*-draw` names the forced
  // fallback, and `refused-no-verified` is the fail-closed exit. Read from the result's own flags
  // so it cannot disagree.
  const pickReason = rotation.noVerifiedUsage
    ? 'refused-no-verified'
    : rotation.usageUnverified
      ? `unverified-${pickedTier}-draw`
      : 'verified-weighted';
  const pool = [...rotation.healthy, ...rotation.excluded];
  return {
    module: 'rotate',
    agent,
    strategy,
    version: rotation.picked.version,
    picked: {
      usageKey: rotation.picked.usageKey,
      email: rotation.picked.email,
      version: rotation.picked.version,
      tier: pickedTier,
    },
    pickReason,
    healthy: rotation.healthy.length,
    excluded: rotation.excluded.length,
    freshness: tally,
    // An object, not an array, so the sink cannot truncate to 10 (ROTATION_EVENT_CANDIDATE_CAP).
    // Keyed by pool index because provider-account candidates share `version` and a null
    // `usageKey` (RUSH-3182); `candidatesTotal` reveals cap overflow.
    candidates: Object.fromEntries(
      pool.slice(0, ROTATION_EVENT_CANDIDATE_CAP).map((c, i) => [String(i), describeRotationCandidate(c, nowMs)]),
    ),
    candidatesTotal: pool.length,
  };
}

/** Build and emit a rotation decision event without letting an observability bug crash a live
 * route: the payload argument is evaluated before `emit`, so a null-deref in
 * describeRotationCandidate would abort the launch. Worst case is a lost log line. */
function emitRotationDecision(
  event: 'rotation.resolved' | 'rotation.unresolved',
  rotation: RotateResult,
  agent: AgentId,
  strategy: RunStrategy,
  extra: EventPayload = {},
): void {
  try {
    emit(event, { ...buildRotationDecisionEvent(rotation, agent, strategy), ...extra });
  } catch {
    /* observability must never break a route */
  }
}

/** Resolve the version `agents run` uses when no `@version` is pinned. `pinned` prefers the default
 * but must not launch a logged-out or revoked one when a signed-in version exists (PHNX-2685); a
 * rate-limited pin is still honoured. Nothing healthy sets `exhausted`. */
export async function resolveRunVersion(
  agent: AgentId,
  strategy: RunStrategy,
  cwd: string = process.cwd(),
  collect: (agent: AgentId) => Promise<RotateCandidate[]> = collectRunCandidates,
  model?: string,
): Promise<{
  version: string | null;
  rotation: RotateResult | null;
  /** Set when a strategy found zero healthy candidates: the full excluded set, so callers fail loud
   * with per-account reasons (RUSH-2132). Also set for `pinned` with a logged-out or revoked
   * default and no signed-in alternative (PHNX-2685). Undefined otherwise. */
  exhausted?: RotateCandidate[];
  /** Set (with `version: null`) for `balanced`/`available` when every eligible account is stale and
   * none verified (PHNX-2526): must not auto-launch. Interactive callers divert to the picker,
   * unattended fail NO_VERIFIED_USAGE. `rotation.healthy` is for failover only, never the pick. */
  noVerifiedUsage?: boolean;
}> {
  const fallback = resolveVersion(agent, cwd);
  const candidates = await collect(agent);

  // Entirely stale usage (PHNX-2526): every eligible account has a stale number and none is
  // verified, so refuse to auto-pick. `version` is null so the caller diverts (picker, or
  // NO_VERIFIED_USAGE); `rotation` keeps `healthy` for bounded failover.
  const refuseStaleUsage = (
    rotation: RotateResult,
  ): { version: string | null; rotation: RotateResult; noVerifiedUsage: true } => {
    emitRotationDecision('rotation.unresolved', rotation, agent, strategy, {
      reason: 'no_verified_usage',
    });
    return { version: null, rotation, noVerifiedUsage: true };
  };

  if (strategy === 'pinned') {
    const pinnedCandidate = fallback
      ? candidates.find((c) => c.version === fallback)
      : undefined;
    // Auth-blocked pin: the home cannot authenticate, so launching it is a
    // guaranteed miss. Prefer a signed-in sibling on this device.
    if (pinnedCandidate && isSignInRecoverable(readinessFromCandidate(pinnedCandidate))) {
      const rotation = pickAvailableCandidate(candidates, fallback, undefined, model);
      // The auth-blocked pin rotates to a sibling, an initial selection, so it gets the same
      // verified-only rule as balanced/available; otherwise a revoked pin with stale siblings
      // launched blind (PR #3295 review).
      if (rotation && rotation.noVerifiedUsage) return refuseStaleUsage(rotation);
      if (rotation) {
        emitRotationDecision('rotation.resolved', rotation, agent, strategy);
        return { version: rotation.picked.version, rotation };
      }
      return {
        version: fallback,
        rotation: null,
        exhausted: candidates.length > 0 ? candidates : undefined,
      };
    }
    return { version: fallback, rotation: null };
  }

  const rotation = strategy === 'available'
    ? pickAvailableCandidate(candidates, fallback, undefined, model)
    : pickBalancedCandidate(candidates, undefined, model);

  if (rotation && rotation.noVerifiedUsage) return refuseStaleUsage(rotation);

  if (rotation) {
    // `available` sticks to the pinned default when healthy; the 60s anti-collision stamp nudges
    // parallel callers off the same version. `balanced` already spreads through its weighted
    // random roll.
    if (strategy === 'available') {
      const recentPick = readRotationStamp(agent);
      if (recentPick === rotation.picked.version && rotation.healthy.length > 1) {
        const alt = rotation.healthy.find(c => c.version !== recentPick);
        if (alt) rotation.picked = alt;
      }
      recordRotationPick(agent, rotation.picked.version);
    }
    emitRotationDecision('rotation.resolved', rotation, agent, strategy);
    return { version: rotation.picked.version, rotation };
  }

  return { version: fallback, rotation: null, exhausted: candidates.length > 0 ? candidates : undefined };
}

/** Cap on healthy accounts a run re-dispatches through after a mid-run rate limit, so one 429
 * cannot become an unbounded retry cascade on a many-account machine. */
export const DEFAULT_ROTATION_FAILOVER_LIMIT = 3;

/** Synthesize a same-agent cross-account fallback chain from a pre-flight rotation result (issue
 * #348): other healthy candidates become `FallbackEntry`s in `rotation.healthy` order, so
 * runWithFallback retries on the next account on a 429. [] without rotation. */
export function rotationFailoverChain(
  rotation: RotateResult | null,
  pickedVersion: string,
  limit: number = DEFAULT_ROTATION_FAILOVER_LIMIT,
): FallbackEntry[] {
  if (!rotation || limit <= 0) return [];
  const chain: FallbackEntry[] = [];
  for (const candidate of rotation.healthy) {
    if (candidate.version === pickedVersion) continue; // the primary account
    chain.push({ agent: candidate.agent, version: candidate.version });
    if (chain.length >= limit) break;
  }
  return chain;
}

/** Whether a run shape may take the preflight harness handoff, which consumes the `--fallback`
 * entry before validation rejects interactive/`--acp`/`--loop`/`--resume-checkpoint`; handing off
 * first would bypass that. `resume` and `workflowScoped` (claude-only sandbox) are excluded. Pure. */
export interface PreflightHandoffContext {
  hasPrompt: boolean;
  interactive: boolean;
  acp: boolean;
  loop: boolean;
  resumeCheckpoint: boolean;
  resume: boolean;
  workflowScoped: boolean;
}

export function preflightHandoffEligible(ctx: PreflightHandoffContext): boolean {
  return (
    ctx.hasPrompt &&
    !ctx.interactive &&
    !ctx.acp &&
    !ctx.loop &&
    !ctx.resumeCheckpoint &&
    !ctx.resume &&
    !ctx.workflowScoped
  );
}

/** The alternate harness to launch when every primary account is exhausted at preflight (PHNX-3999
 * F19), plus the rest of the `--fallback` spec. Not a second parser: any inexact entry or the
 * primary nulls the whole spec. Null too when the primary is merely signed out (log in instead). */
export function preflightFallbackHandoff(
  spec: string | undefined,
  primary: AgentId,
  exhausted: RotateCandidate[],
): { agent: AgentId; version?: string; remainingSpec?: string } | null {
  if (!spec) return null;
  if (exhausted.length === 0) return null;
  if (signInRecoverableCandidates(exhausted).length > 0) return null;
  const entries = spec.split(',').map((e) => e.trim()).filter(Boolean);
  if (entries.length === 0) return null;
  const parsed = entries.map((entry) => entry.split('@'));
  // Every entry has to be exactly resolvable, or this defers entirely.
  if (parsed.some(([name]) => !isAgentId(name) || name === primary)) return null;
  const [name, version] = parsed[0];
  const remaining = entries.slice(1);
  return {
    agent: name as AgentId,
    version: version || undefined,
    remainingSpec: remaining.length > 0 ? remaining.join(',') : undefined,
  };
}

/** Whether a run may arm mid-run rate-limit failover (issue #348). It must not arm for shapes that
 * reject a non-empty `fallback` chain (`acp`, `loop`, `resumeCheckpoint`, interactive, no prompt)
 * or without a rotation. An explicit `--fallback` does not disarm it. Pure. */
export interface FailoverArmingContext {
  hasRotation: boolean;
  hasVersion: boolean;
  hasPrompt: boolean;
  interactive: boolean;
  acp: boolean;
  loop: boolean;
  resumeCheckpoint: boolean;
}

export function shouldArmRotationFailover(ctx: FailoverArmingContext): boolean {
  return (
    ctx.hasRotation &&
    ctx.hasVersion &&
    ctx.hasPrompt &&
    !ctx.interactive &&
    !ctx.acp &&
    !ctx.loop &&
    !ctx.resumeCheckpoint
  );
}
