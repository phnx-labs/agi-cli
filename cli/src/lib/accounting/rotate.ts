/**
 * Account rotation across agent versions.
 *
 * Detects which installed versions have expired credentials and rotates
 * authentication tokens so users maintain active sessions across version switches.
 */

import * as fs from 'fs';
import * as path from 'path';
import type { AgentId, RunStrategy } from '../types.js';
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
import { readMeta, writeMeta, getHelpersDir } from '../state.js';
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
  /**
   * Per-org usage/quota key (e.g. `claude:org=<orgUuid>`) — the unit rate
   * limits are actually measured in. Distinct orgs signed in under the same
   * email have distinct keys, so this is the correct dedup boundary; null when
   * no usage identity is available (then we fall back to email).
   */
  usageKey: string | null;
  usageStatus: AccountInfo['usageStatus'];
  usageSnapshot: UsageSnapshot | null;
  usageError: string | null;
  /**
   * Projected minutes until this account's 5-hour session window caps, as
   * computed by the daemon's burn-rate refresher and read from the headroom
   * cache. `null` when unknown (cold cache, idle, or not burning up). Balanced
   * routing deprioritizes an account projected to cap soon — see
   * {@link capacityWeight} — so a launch avoids an account racing toward its
   * limit, not just one already 100%-maxed.
   */
  usageMinutesToLimit: number | null;
  plan: string | null;
  signedIn: boolean;
  /**
   * Live auth-health verdict for this (agent, version) from the daemon's probe
   * cache (`auth-health.ts`), or null when no probe row exists (cold cache, or a
   * harness with no live-probe endpoint). `signedIn` only means "a credential
   * file is present and its email decodes" — it cannot tell a good token from a
   * revoked-but-unexpired one, so a server-rejected account reads
   * `signedIn: true` but `authVerdict: 'revoked'`. Eligibility excludes a
   * revoked account so rotation never launches into a doomed auth (see
   * {@link readinessFromCandidate}). Fail-open: any non-revoked or null verdict
   * does not gate — a stale/absent probe never blocks a launch.
   */
  authVerdict: AuthVerdict | null;
  /** Epoch milliseconds of the auth probe behind authVerdict, when present. */
  authCheckedAt?: number | null;
  lastActive: Date | null;
  /**
   * Set only for a candidate that comes from a provider account bundle rather
   * than a native version-home login (RUSH-3182): the account name to inject via
   * the `--account` spawn path (`resolveSpawnAccount` → `accountEnv`). Undefined
   * for a native login, whose credential already lives in `version`'s home. The
   * run path routes on this so a balanced pick of a setup-token / API-key account
   * authenticates through the existing provider-account injection.
   */
  providerAccount?: string;
  /**
   * Native account name when this candidate is a slot (PHNX-3940 T5). The
   * picker and `--account` / `#name` selector use this; `version` is the
   * binary (managed install) and is no longer the account identity.
   */
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
  /**
   * True when the PICKED candidate's usage could not be verified fresh, so the
   * route was decided on an unverified snapshot. Callers surface it — routing
   * blind is a fact the operator needs, not an internal detail. (Previously
   * this only reported the all-stale case; a stale pick out of a mixed pool
   * was silently reported as verified.)
   */
  usageUnverified?: boolean;
  /**
   * True when NO candidate carries a fresh usage snapshot AND at least one
   * carries a STALE-but-present one — the "entirely stale usage" case
   * (PHNX-2526). The INITIAL route MUST NOT be decided on a stale number that
   * looks plausible but is wrong (the yosemite-s1 incident: 26h–2.7d-old
   * snapshots read 48% while the account was at its weekly cap). `picked` is
   * still populated (a stale candidate) so `healthy` stays intact for BOUNDED
   * post-rejection failover, but a caller doing the initial selection MUST NOT
   * launch it — it diverts to the account picker (interactive) or fails loud
   * with NO_VERIFIED_USAGE (unattended). Distinct from a BLIND pool with no
   * snapshot at all (a worker box whose usage endpoint 403s, RUSH-2392): that
   * carries no misleading number, so it still draws a pick and this stays
   * false.
   */
  noVerifiedUsage?: boolean;
}

export const RUN_STRATEGIES: RunStrategy[] = ['pinned', 'available', 'balanced'];

/**
 * Return a run strategy when the input is valid, otherwise null.
 *
 * `'rotate'` is accepted as a deprecated alias for `'balanced'` so old yaml
 * configs and `--strategy rotate` invocations keep working. The legacy alias
 * normalizes to `'balanced'` and uses the weighted-random algorithm.
 */
export function normalizeRunStrategy(value: unknown): RunStrategy | null {
  if (typeof value !== 'string') return null;
  if (value === 'rotate') return 'balanced';
  return RUN_STRATEGIES.includes(value as RunStrategy) ? value as RunStrategy : null;
}

/** Read project-local run strategy from the nearest agents.yaml, if present. */
export function getProjectRunStrategy(agent: AgentId, startPath: string): RunStrategy | null {
  for (const runConfig of getProjectRunConfigs(startPath)) {
    const strategy = normalizeRunStrategy(runConfig[agent]?.strategy);
    if (strategy) return strategy;
  }

  return null;
}

/**
 * Resolve the configured strategy. Lookup order:
 *   1. project-local agents.yaml (nearest to `startPath`)
 *   2. ~/.agents/.system/agents.yaml
 *   3. default: `balanced` (weighted-random across all healthy accounts by
 *      remaining headroom, skipping any that are currently rate-limited). A
 *      bare `agents run <agent>` — e.g. every new terminal the extension spawns
 *      — should spread load and never launch into a throttled account, rather
 *      than stick to the pinned default even when it's maxed.
 */
export function getConfiguredRunStrategy(agent: AgentId, startPath: string = process.cwd()): RunStrategy {
  return getProjectRunStrategy(agent, startPath)
    ?? normalizeRunStrategy(readMeta().run?.[agent]?.strategy)
    ?? 'balanced';
}

/** Persist the global run strategy used by bare `agents run <agent>`. */
export function setGlobalRunStrategy(agent: AgentId, strategy: RunStrategy): void {
  const meta = readMeta();
  if (!meta.run) meta.run = {};
  meta.run[agent] = { ...(meta.run[agent] ?? {}), strategy };
  writeMeta(meta);
}

/**
 * Whether an account may be rotated INTO right now. Defined in terms of
 * {@link readinessFromCandidate} so the router's pick gate and the pre-flight
 * warning can never disagree: an account is eligible iff its readiness is
 * `ready` — signed in, not server-revoked, and not out of usage.
 */
/** Slot verdicts balanced/available will launch (PHNX-3940 T5). */
const LAUNCHABLE_SLOT_VERDICTS: ReadonlySet<AuthVerdict> = new Set(['live', 'unverified']);

function isLaunchableSlotVerdict(verdict: AuthVerdict | null): boolean {
  return verdict !== null && LAUNCHABLE_SLOT_VERDICTS.has(verdict);
}

function isRotationEligible(candidate: RotateCandidate, nowMs: number = Date.now(), model?: string): boolean {
  if (candidate.fromSlot && !isLaunchableSlotVerdict(candidate.authVerdict)) return false;
  return readinessFromCandidate(candidate, nowMs, model).ready;
}

/**
 * Whether a version home can actually authenticate a launch.
 *
 * `getAccountInfo` falls back to the active/global HOME when a version home has
 * no credential of its own, so `agents view` still shows who is logged in. Launch
 * paths isolate config (GROK_HOME, CODEX_HOME, KIMI_CODE_HOME, CLAUDE_CONFIG_DIR,
 * …) to the per-version home, so a home that only "inherits" the active login
 * cannot spawn a signed-in agent — balanced kept picking those empty homes and
 * the run died on "Not signed in".
 *
 * When we know where the credential lives (`knownLocation`), require it under
 * THIS version home. When we don't (keychain-only / unmapped agents), trust the
 * existing `signedIn` signal.
 */
export function isLaunchableSignedIn(
  signedIn: boolean,
  presence: Pick<CredentialPresence, 'knownLocation' | 'perVersion'>,
): boolean {
  if (!signedIn) return false;
  if (!presence.knownLocation) return true;
  return presence.perVersion;
}

/** Launchable-signed-in verdict for ONE specific version on THIS device. */
export interface VersionLaunchState {
  /** True iff this exact version home can spawn a signed-in agent right now. */
  launchable: boolean;
  /** The version home's account email when launchable, else null. */
  email: string | null;
}

/**
 * Whether a SPECIFIC installed version is launchable-signed-in on THIS device,
 * plus the account email when it is. Mirrors EXACTLY the per-version gate
 * {@link collectRunCandidates} applies (getVersionHomePath -> getAccountInfo ->
 * {@link isLaunchableSignedIn} over {@link credentialPresence}), so the
 * pre-launch `run.launch` event can report the same signed-in verdict the
 * balanced router computes for that version.
 *
 * The point is to make a launch into a logged-out version VISIBLE at spawn time:
 * `--device auto` only guarantees SOME account is ready on the device, not that
 * the specific version launched is signed in there (the yosemite-m3 2.1.219
 * incident — 2.1.219 was logged out, the router correctly excluded it, yet it
 * launched). Non-fatal by construction: callers wrap it best-effort.
 */
export async function isVersionLaunchableHere(
  agent: AgentId,
  version: string,
): Promise<VersionLaunchState> {
  const home = getVersionHomePath(agent, version);
  const info = await getAccountInfo(agent, home);
  const launchable = isLaunchableSignedIn(info.signedIn, credentialPresence(agent, home));
  return { launchable, email: launchable ? info.email : null };
}

/**
 * How old a usage snapshot may be and still settle a routing DECISION.
 *
 * A display may show an older cached bar, but the router choosing an account
 * from one costs the whole run. Measured case: `yosemite-s1` held snapshots 26
 * hours to 2.7 days old
 * with a failing refresh, so balanced read `muqsit@getrush.ai` as 48% used and
 * launched into it while the account was actually at its weekly cap.
 */
export const USAGE_DECISION_MAX_AGE_MS = 5 * 60 * 1000;

/**
 * How old a usage snapshot may be before routing REFUSES to run at all
 * (NO_VERIFIED_USAGE), as opposed to merely declining to *weight* by its number.
 *
 * These are two different risks and now two different bars. Weighting on a
 * slightly-old number is cheap to get wrong (a floored weight, {@link
 * USAGE_DECISION_MAX_AGE_MS} = 5 min); refusing to launch at all is expensive to
 * get wrong — it fails the user's `agents run` outright. The daemon's usage
 * refresher paces proactive fetches under a fixed per-provider budget
 * (`usage-refresh.ts`, PROVIDER_HOURLY_BUDGET), so on a multi-account fleet an
 * IDLE account is deliberately refreshed on a stretched round-robin cadence
 * (bounded at N × spacing — ~16 min at 8 accounts, ~32 min at 16) rather than
 * every 5 min, which would 429 the endpoint and park it for up to an hour. A
 * budget-paced idle reading of 10–30 min is NOT the failure this refusal exists
 * to catch. That failure is the `yosemite-s1` case: a box whose refresh is
 * genuinely BROKEN, holding readings 26 h – 2.7 d old. 40 min sits comfortably
 * above the worst-case budget cadence and still an order of magnitude below the
 * multi-hour staleness of a broken box — and actively-used accounts refresh for
 * free via the statusline ingest, so a *busy* account is never even this old.
 */
export const USAGE_STALE_REFUSAL_MAX_AGE_MS = 40 * 60 * 1000;

/**
 * Whether this candidate's usage number is recent enough to route on. A missing
 * snapshot is unverified by definition — there is no number to trust.
 *
 * A snapshot with NO windows is unverified for the same reason, however fresh
 * it is: it carries a subscription plan and no utilization, so there is still
 * no number. Freshness alone would make a meterless harness (Grok reports a
 * tier and no meters) verify against nothing — and since `preferVerified`
 * narrows the pool to verified candidates, the one account whose billing log
 * was touched most recently would win every draw, then win again because
 * running it refreshes that log. That self-reinforcing pin is exactly what the
 * narrowing rule below exists to prevent.
 */
export function isUsageVerified(candidate: RotateCandidate, nowMs: number = Date.now()): boolean {
  const snapshot = candidate.usageSnapshot;
  const capturedAt = snapshot?.capturedAt;
  if (!capturedAt || !snapshot?.windows.length) return false;
  return nowMs - capturedAt.getTime() <= USAGE_DECISION_MAX_AGE_MS;
}

/**
 * Whether this candidate carries a GENUINELY-STALE usage number: a snapshot with
 * windows whose capture time is older than {@link USAGE_STALE_REFUSAL_MAX_AGE_MS}.
 *
 * This is the misleading case the initial route must refuse — the number reads
 * "48% used" with the same confidence whether captured a minute or three days
 * ago, and a box whose refresh is failing stays wrong indefinitely. Two things
 * make it NARROWER than "not verified":
 *   1. It uses the wider REFUSAL bar, not the 5-min weighting bar. A merely
 *      budget-paced idle account (10–30 min old) is not-verified — so it weights
 *      at the floor, conservatively — but it is NOT "stale" and must not, on its
 *      own, drive the whole provider to a NO_VERIFIED_USAGE refusal. Only a
 *      genuinely broken refresh (hours old) trips this.
 *   2. A BLIND candidate with no snapshot (or a plan-only meterless one with no
 *      windows) carries no number to be misled by — a worker box whose usage
 *      endpoint 403s (RUSH-2392), or a meterless Grok login — so it is not
 *      "stale", and an entirely-blind pool still draws a pick (PHNX-3392) rather
 *      than fail loud with NO_VERIFIED_USAGE.
 */
export function hasStaleUsage(candidate: RotateCandidate, nowMs: number = Date.now()): boolean {
  const snapshot = candidate.usageSnapshot;
  const capturedAt = snapshot?.capturedAt;
  if (!capturedAt || !snapshot?.windows.length) return false;
  return nowMs - capturedAt.getTime() > USAGE_STALE_REFUSAL_MAX_AGE_MS;
}

function hasUsageAvailable(candidate: RotateCandidate): boolean {
  const snapshot = candidate.usageSnapshot;
  if (snapshot) {
    // Eligibility mirrors the `agents view` throttle badge exactly
    // (deriveUsageStatusFromSnapshot): an account maxed on ANY blocking window —
    // including the 5-hour session window — cannot serve the next request, so it
    // must not be picked. Previously this checked only non-session windows
    // (getRoutingUsedPercent), so a session-maxed account with weekly headroom
    // stayed "eligible" and the router kept launching into it while `ag view`
    // showed it rate-limited. Capacity *weighting* still ranks eligible accounts
    // by weekly headroom; this gate only decides can-it-run-right-now.
    const status = deriveUsageStatusFromSnapshot(snapshot);
    if (status !== null) return status !== 'rate_limited';
  }

  // No live snapshot: fall back to the coarse cached status.
  if (candidate.usageStatus === 'out_of_credits' || candidate.usageStatus === 'rate_limited') {
    return false;
  }

  return true;
}

/**
 * Whether a specific account can serve a run right now, and — when it can't —
 * why. `signed_out` covers a missing usable credential; `revoked` is a token the
 * server has actually rejected (401/403, from the live auth-health probe);
 * `rate_limited` and `out_of_credits` name the throttle. Used to pre-warn on a
 * version-pinned teammate whose account rotation won't route around (a pin IS
 * the target).
 */
export type AccountReadiness =
  | { ready: true }
  | {
      ready: false;
      reason: 'rate_limited' | 'out_of_credits' | 'signed_out' | 'revoked' | 'model_limited';
      email: string | null;
    };

/**
 * Pure decision reusing the router's own eligibility gate (`hasUsageAvailable`
 * + canonical signed-in state, i.e. `isRotationEligible`), so a pre-flight warning can NEVER
 * disagree with what rotation would actually do. The `reason` combines the two
 * signals `hasUsageAvailable` reads: the live snapshot (session-inclusive
 * rate-limit) and the coarse cached `usageStatus` (out-of-credits, which a
 * snapshot never carries). When a live snapshot exists it wins over the cached
 * status — matching the gate — so a stale `out_of_credits` cache is not
 * reported while the account is actually serving requests.
 *
 * `model`, when supplied, additionally consults a per-(account, model)
 * refusal Claude can surface on ONE model family ("You've reached your Fable
 * limit…") while the account's other models and its global usage windows stay
 * healthy — a global rate_limited/out_of_credits marker would wrongly exclude
 * the whole account for an unrelated model. Keyed on the candidate's stable
 * native account id (never the org-shared usageKey) via
 * {@link candidateAccountKey}, so a model-only limit on one login can never
 * poison a sibling account that merely shares the same org usage bucket.
 * Omitting `model` (every existing caller) leaves generic account status
 * completely unaffected — the model check runs only when a caller opts in.
 */
export function readinessFromCandidate(
  candidate: RotateCandidate,
  now: number = Date.now(),
  model?: string,
): AccountReadiness {
  if (!candidate.signedIn) {
    return { ready: false, reason: 'signed_out', email: candidate.email };
  }
  // A token the daemon's live probe saw rejected (401/403 -> `revoked`) will fail
  // auth at spawn no matter how much usage headroom it has. Exclude it BEFORE the
  // usage gate so rotation never routes into a doomed login. Fail-open: any other
  // (or null) verdict does not gate — see `RotateCandidate.authVerdict`.
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
  if (hasUsageAvailable(candidate)) {
    return { ready: true };
  }
  const snap = candidate.usageSnapshot;
  const snapRateLimited =
    !!snap && snap.windows.length > 0 && deriveUsageStatusFromSnapshot(snap) === 'rate_limited';
  const reason: 'rate_limited' | 'out_of_credits' =
    !snapRateLimited && candidate.usageStatus === 'out_of_credits' ? 'out_of_credits' : 'rate_limited';
  return { ready: false, reason, email: candidate.email };
}

/**
 * Whether a human sitting at a terminal can clear this exclusion by launching
 * the agent and signing in. The two unhealthy classes are opposites, and the
 * zero-healthy callers MUST NOT treat them alike:
 *
 * - `signed_out` / `revoked` — recoverable. There is no credential (or the
 *   server rejected it), and the harness's own TUI is the login surface, so
 *   launching it is exactly the fix. Refusing to launch strands the user with
 *   no way to authenticate through agents-cli at all (RUSH-2334).
 * - `rate_limited` / `out_of_credits` — NOT recoverable. The account is signed
 *   in and throttled; launching it just hammers an exhausted account, which is
 *   precisely the loop RUSH-2132's fail-loud guard exists to stop. Only a
 *   window reset clears these.
 */
export function isSignInRecoverable(readiness: AccountReadiness): boolean {
  return !readiness.ready && (readiness.reason === 'signed_out' || readiness.reason === 'revoked');
}

/**
 * The subset of an `exhausted` set whose exclusion a sign-in would clear, so an
 * interactive caller can offer the login instead of dead-ending. Empty means
 * every account is throttled — nothing a human can fix right now, so the caller
 * keeps failing loud.
 */
export function signInRecoverableCandidates(candidates: RotateCandidate[]): RotateCandidate[] {
  return candidates.filter((c) => isSignInRecoverable(readinessFromCandidate(c)));
}

/**
 * Readiness for a specific installed (agent, version). Returns `{ ready: true }`
 * when the version isn't among the collected candidates — absence is the
 * caller's `isVersionInstalled` concern, not ours; don't cry wolf. Only
 * meaningful for a version-pinned target: a bare target rotates to a healthy
 * account on its own, and a profile injects its own auth (a different account
 * than the version home carries), so neither is checkable here.
 */
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

/**
 * Identity a candidate dedups on. Quota is tracked per-org, so two versions
 * that share an org are the same rate-limit bucket and must collapse — but two
 * orgs under the same email (e.g. Enterprise + Personal on one Google identity)
 * are genuinely separate buckets and must stay distinct. Prefer the org usage
 * key; fall back to email only when no usage identity is available.
 */
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

/**
 * Pick a healthy candidate using weighted random by remaining capacity.
 *
 * Each healthy candidate gets weight = max(1, 100 - usedPercent) where
 * usedPercent is the highest-utilized non-session window (week / sonnet_week
 * for Claude). An account at 10% used gets weight 90; one at 90% used gets
 * weight 10 — so the fresher account is 9× more likely to be picked. Over N
 * calls, traffic distributes across healthy accounts proportional to their
 * headroom, with no stampede on the lowest-usage one. Stateless — parallel
 * callers naturally fan out via the random roll.
 *
 * Eligibility: signed in according to AccountInfo and not currently
 * rate-limited — no blocking window (session OR weekly) at 100%, matching the
 * `agents view` badge; or the local cached status is usable when no live
 * snapshot exists. Note the split: eligibility considers the session window
 * (a session-maxed account can't run now), but the capacity *weight* above is
 * driven by weekly headroom so a brief session spike doesn't distort routing.
 *
 * Dedupe: when multiple versions share a usage/account identity, collapse to
 * one candidate (the least-recently-active version). The org-scoped usage key
 * wins over email so same-email personal and Team accounts remain distinct.
 *
 * Returns null if no candidate is eligible — callers fall back to the pinned
 * version so behavior stays predictable.
 *
 * `model`, when supplied, additionally excludes an account carrying a live
 * per-model refusal for that exact model (see {@link readinessFromCandidate}).
 * Omitted (every pre-existing caller), eligibility is unchanged.
 */
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

/**
 * Choose from the VERIFIED candidates when they are a representative share of
 * the pool (at least half), else from the whole pool.
 *
 * An eligible account whose usage we could not confirm is a guess, not a green
 * light: the snapshot reads "48% used" with equal confidence whether it was
 * captured a minute or three days ago, and a box whose refresh is failing stays
 * wrong indefinitely. Confirmed headroom therefore beats apparent headroom, even
 * when the unconfirmed number looks better.
 *
 * But narrowing to a verified MINORITY inverts the safety. When the usage
 * endpoint 429-throttles a machine, each refresh cycle confirms roughly one
 * account before backing off — so "verified" is a singleton, `choose` runs over
 * a one-element list, and every launch lands on the same account. Launching
 * into it refreshes that account's snapshot again, so it stays the only
 * verified candidate while the rest are never picked and never probed: the
 * rotation degrades to a fixed pin that burns one account to its weekly cap
 * while its siblings idle (observed 2026-08-20 across yosemite-s0/s1 — the
 * "same version every time under --strategy balanced" incident).
 *
 * The two failure modes belong to different CHOOSERS, so `narrowing` is picked
 * per caller: `'representative'` (the weighted-random balanced path) narrows to
 * verified only when they cover at least half the pool — below that the whole
 * pool competes, fresh candidates keep their confirmed weights, stale/unknown
 * ones get the full default weight `capacityWeight` assigns to "no signal", and
 * the random roll spreads the load. `'any-verified'` (deterministic `from[0]`
 * choosers: `--strategy available`, run-auto harness classification) keeps the
 * original rule — narrow whenever ANY verified candidate exists — because a
 * deterministic pick over the whole pool would hand the front slot back to an
 * unconfirmed "48% used" over an accurate "90% used", the exact yosemite-s1
 * inversion above, and a deterministic chooser cannot spread load anyway, so
 * the singleton-collapse concern does not apply to it.
 *
 * `healthy` deliberately keeps every eligible candidate rather than just the
 * verified ones. Declining to *pick* an account on stale data and declining to
 * *fail over to* it after the primary has already hit a 429 are different risks:
 * by then the alternative is not launching at all, so the failover chain
 * (rotationFailoverChain, which reads `healthy`) keeps its full safety net —
 * exactly on the machines this guard is protecting.
 */
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
  // Entirely-stale = zero verified AND at least one stale-but-present number. A
  // BLIND pool (no snapshots at all) does NOT trip this — it carries no
  // misleading figure, so it still draws a pick (see {@link hasStaleUsage}). The
  // chosen `picked` is still returned so `healthy` (which includes it) stays
  // whole for bounded post-rejection failover; the INITIAL selection acts on
  // this flag instead of launching that stale pick.
  const noVerifiedUsage = verified.length === 0 && pool.some((c) => hasStaleUsage(c, nowMs));
  return {
    picked,
    usageUnverified: !isUsageVerified(picked, nowMs),
    noVerifiedUsage,
  };
}

// capacityWeight + PROJECTION_HORIZON_MIN moved to ./capacity.js (a pure,
// dependency-free module the account pool can import without this file's heavy
// graph). Imported at the top for internal use; re-exported here so existing
// importers keep resolving them from rotate.
export { PROJECTION_HORIZON_MIN, capacityWeight };

/**
 * Pick one candidate from `sorted` using weights proportional to remaining
 * routing capacity (see {@link capacityWeight}). Floor each weight at 1 so a
 * near-exhausted-but-still-eligible candidate can still be picked occasionally.
 */
function weightedRandomByCapacity(
  sorted: RotateCandidate[],
  nowMs: number = Date.now(),
): RotateCandidate {
  const weights = sorted.map((c) =>
    capacityWeight(
      // An unverified (stale or absent) snapshot carries no trustworthy number,
      // so it weights as UNVERIFIED_WEIGHT (the floor) instead of by its frozen
      // usedPercent. Otherwise a day-old "45% used" competes as if it were live
      // headroom and can win the draw over a verified-healthy account — which is
      // exactly how balanced launched into an account already at its weekly cap
      // on a worker whose usage refresh had stalled (PHNX-3479). A verified
      // snapshot keeps its real remaining-headroom weight.
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

/**
 * Pick an available candidate. Prefers the configured pinned version when that
 * version has usage available; otherwise routes to the candidate with the most
 * usage headroom.
 */
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

  // `available` sorts by apparent headroom and takes the front of the list, so an
  // unconfirmed "48% used" outranks an accurate "90% used" — the same inversion
  // that put a launch on an exhausted account under `balanced`. It routes on the
  // same cache, so it gets the same rule: confirmed headroom first.
  const { picked: bestVerified, usageUnverified, noVerifiedUsage } = preferVerified(sorted, nowMs, (from) => from[0]);
  // An explicit version preference is an instruction, not a ranking signal, so it
  // still wins — but only while that version is actually eligible.
  const preferred = preferredVersion
    ? sorted.find((candidate) => candidate.version === preferredVersion)
    : undefined;
  // `noVerifiedUsage` rides along even when a `preferred` default resolves: an
  // all-stale pool can only make `preferred` a stale pick too (a verified
  // preferred would make verified.length > 0), and auto-selecting the default
  // pin on a stale number is the very thing PHNX-2526 refuses. The initial
  // route (resolveRunVersion) acts on the flag; the failover chain keeps
  // `healthy` regardless.
  return { picked: preferred ?? bestVerified, healthy: sorted, excluded, usageUnverified, noVerifiedUsage };
}

/**
 * Per-harness routing summary for `agents run auto` — the cross-harness layer
 * that sits above `pickBalancedCandidate` (which is strictly per-harness).
 */
export interface HarnessSummary {
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

export interface HarnessPickResult {
  /** The harness picked for this run. */
  picked: HarnessSummary;
  /** Harnesses with ≥1 healthy account (including the picked one). */
  healthy: HarnessSummary[];
  /** Harnesses with zero healthy accounts — excluded, not down-weighted. */
  excluded: HarnessSummary[];
}

/**
 * Classify every harness's candidates into healthy (with a representative
 * best account) vs excluded (with per-reason counts). Pure — the pick and the
 * zero-healthy error message both read this, so they can never disagree.
 *
 * Health uses the exact account-layer gate (`isRotationEligible`: signed in
 * AND not maxed on ANY blocking window, weekly included). The representative
 * best account honors `preferVerified`: confirmed headroom beats apparent
 * headroom, the same freshness rule the account layer routes on.
 */
export function classifyHarnessCandidates(
  byHarness: ReadonlyMap<AgentId, RotateCandidate[]>,
  nowMs: number = Date.now(),
): HarnessSummary[] {
  const summaries: HarnessSummary[] = [];
  for (const [agent, candidates] of byHarness) {
    const eligible = candidates.filter((c) => isRotationEligible(c));
    if (eligible.length === 0) {
      const counts = new Map<string, number>();
      for (const c of candidates) {
        const readiness = readinessFromCandidate(c);
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

/**
 * Pick a harness for `agents run auto` using weighted random by best-account
 * headroom (RUSH-2132).
 *
 * A harness's capacity is `100 − min(routingUsed% across its healthy accounts)`
 * — its best account's headroom. The pick reuses `weightedRandomByCapacity` on
 * the representative best accounts, so host/harness/account layers all share
 * one sampling behavior. Harnesses with zero healthy accounts are EXCLUDED,
 * not down-weighted. Returns null when no harness has any healthy account;
 * call `classifyHarnessCandidates` for the exclusion detail to message with.
 */
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

/**
 * The earliest FUTURE window reset across these candidates' usage snapshots —
 * when the first exhausted account becomes usable again. Null when no snapshot
 * carries a reset timestamp.
 */
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

/**
 * The `resets <summary>` fragment both zero-healthy errors share. ISO 8601 so
 * a watchdog can parse the cooldown straight off the line; `unknown` when no
 * snapshot carries a reset (a parser falls back to its default cooldown).
 */
function formatResetSummary(reset: Date | null): string {
  return reset ? reset.toISOString() : 'unknown (no reset timestamps in any snapshot)';
}

/**
 * The zero-healthy-account error (RUSH-2132). EXACT contract — the Factory
 * watchdog tail-detects this text: it must contain the literal `no healthy`
 * and `resets <time>` (parsed for the rotate cooldown). Do not deviate.
 */
export function formatNoHealthyAccountError(
  agent: AgentId,
  strategy: RunStrategy,
  excluded: RotateCandidate[],
  nowMs: number = Date.now(),
): string {
  const excludedStr = excluded.length === 0
    ? 'no installed versions'
    : excluded.map((c) => {
        const readiness = readinessFromCandidate(c);
        const reason = readiness.ready ? 'ineligible' : readiness.reason;
        return `${c.version} (${reason})`;
      }).join(', ');
  const resetSummary = formatResetSummary(earliestResetAcross(excluded, nowMs));
  return `agents: no healthy ${agent} account under strategy '${strategy}' — excluded: ${excludedStr}; earliest window resets ${resetSummary}. Use --strategy pinned to force the default.`;
}

/**
 * How old this candidate's usage snapshot is, in whole minutes, or null when it
 * carries no dated snapshot (a blind account). Used only to explain WHY a route
 * was refused as unverified — never to route on.
 */
function snapshotAgeMinutes(candidate: RotateCandidate, nowMs: number): number | null {
  const capturedAt = candidate.usageSnapshot?.capturedAt;
  if (!capturedAt || !candidate.usageSnapshot?.windows.length) return null;
  return Math.max(0, Math.round((nowMs - capturedAt.getTime()) / 60_000));
}

/**
 * The all-stale-usage error (PHNX-2526) an UNATTENDED `balanced`/`available`
 * run fails loud with when no account's usage is fresh enough to route on. EXACT
 * contract — it MUST contain the literal `NO_VERIFIED_USAGE` so a machine caller
 * (and the Factory watchdog) can tail-detect it distinctly from the
 * `no healthy` throttle error, which is a different condition (throttled vs
 * merely stale). Names each candidate with how stale its snapshot is, so the
 * operator can see the failing-refresh box rather than guess.
 */
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
        const staleness = age === null ? 'no usage snapshot' : `usage ${age}m old`;
        return `${c.version} (${staleness})`;
      }).join(', ');
  const maxAgeMin = Math.round(USAGE_STALE_REFUSAL_MAX_AGE_MS / 60_000);
  return `agents: NO_VERIFIED_USAGE — no signed-in ${agent} account has usage newer than ${maxAgeMin}m under strategy '${strategy}', so routing refuses to guess on a stale number: ${detail}. Refresh usage (agents view ${agent}) or pin the default with --strategy pinned.`;
}

/**
 * The zero-healthy-harness error for `agents run auto` — names each harness's
 * exclusion reason plus the earliest reset across all snapshots.
 */
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
  // Read the local auth-health probe cache once (cache-only, no network — the
  // daemon is the sole writer). A `revoked` verdict for a (host, agent, version)
  // excludes that account from the pick; a missing row is fail-open. Keyed by the
  // LOCAL host — routing decides which local version to launch.
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
      // We used to additionally call isClaudeAuthValid(home), which reads
      // "Claude Code-credentials-<hash>" from the system keychain. That item is
      // written by Claude Code itself with its own process in the ACL, so our
      // helper triggers a macOS keychain-authorization sheet on every probe —
      // one per installed version, every time `agents run` cold-starts. If
      // claude's stored token has actually expired, the spawned agent detects
      // it at its own startup and re-auths; that's the correct UX.
      //
      // Gate signedIn on a real per-version credential when we know where it
      // lives — see isLaunchableSignedIn. Do not reuse the active-home fallback
      // identity for routing, or empty version homes look healthy and die at spawn.
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

  // These candidates feed a routing decision on the `agents run` hot path, so
  // this read is CACHE-ONLY (`readOnly`): it never blocks on a live provider
  // fetch. A snapshot older than USAGE_DECISION_MAX_AGE_MS is not trusted for
  // the pick — but the guard that enforces that is `isUsageVerified` below, not
  // a blocking refresh here. Keeping the cache fresh is the daemon's job
  // (`runUsageRefresh`, adaptive + rate-capped, sole-writer per local account),
  // so a cold `agents run` reads the last daemon-written snapshot instead of
  // stalling on N parallel HTTP round trips (the measured cold-start stall this
  // removes). A stale-or-absent snapshot routes as unverified, exactly as a
  // failed live read did before.
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

/**
 * Collect run candidates for every harness with ≥1 installed version — the
 * probe `agents run auto` routes on (the same per-harness account probe
 * `agents view` aggregates). Harnesses with nothing installed are absent from
 * the map: not a candidate at all, rather than an excluded one.
 */
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

/**
 * Resolve an account identity to the installed version slot that holds it, over
 * an already-collected candidate list. Pure — no I/O — so it is unit-tested
 * directly. Matches, case-insensitively, against a candidate's login `email`
 * (the usual form) or its `accountKey`, and only ever returns a signed-in slot.
 * Returns null when nothing matches, so the caller can fall back and warn.
 */
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

/**
 * Resolve a routine's `account:` pin (login email, account key, or native
 * account name) to the candidate currently holding that account. Thin I/O
 * wrapper over {@link collectRunCandidates} + {@link matchAccountCandidate};
 * returns null when no signed-in candidate matches. Pinning a routine to a
 * distinct account is the durable cure for the shared-single-use-refresh-token
 * revocation storm (RUSH-1957): the pinned run never rotates and never lands
 * on another routine's credential. Post-T5 the candidate's `nativeAccount`
 * (not just `version`) is what disambiguates two slots on one managed install.
 */
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

/**
 * Pick a healthy version for `agent` using weighted random by remaining
 * capacity. See `pickBalancedCandidate` for algorithm details.
 *
 * No external state — health and capacity are both read off per-version
 * AccountInfo (same data `agents view` surfaces). The weighted random roll
 * keeps parallel callers fanned out without rotation files or locks.
 *
 * Returns null if no installed version is eligible. Callers fall back to the
 * global default so behavior stays predictable — we never refuse to run.
 */
export async function selectBalancedVersion(agent: AgentId): Promise<RotateResult | null> {
  return pickBalancedCandidate(await collectRunCandidates(agent));
}

/** Select the configured version if available, otherwise another available version. */
export async function selectAvailableVersion(
  agent: AgentId,
  preferredVersion?: string | null,
): Promise<RotateResult | null> {
  return pickAvailableCandidate(await collectRunCandidates(agent), preferredVersion);
}

/**
 * Record a rotation pick so parallel callers see it as recently-used.
 * Writes a stamp file per agent — lightweight, no locking needed since
 * a torn write just means the next reader sees a stale timestamp (harmless).
 */
function recordRotationPick(agent: AgentId, version: string): void {
  const stampPath = path.join(getRotateDir(), `stamp-${agent}.json`);
  try {
    fs.writeFileSync(stampPath, JSON.stringify({ version, ts: Date.now() }), 'utf-8');
  } catch { /* best effort — doesn't block the run */ }
}

/**
 * Read the most recent rotation pick for an agent. Returns null if no stamp
 * or stamp is older than 60 seconds (stale).
 */
function readRotationStamp(agent: AgentId): string | null {
  const stampPath = path.join(getRotateDir(), `stamp-${agent}.json`);
  try {
    const raw = JSON.parse(fs.readFileSync(stampPath, 'utf-8')) as { version: string; ts: number };
    if (Date.now() - raw.ts < 60_000) return raw.version;
  } catch { /* missing or corrupt — treat as no stamp */ }
  return null;
}

/** Cap on candidates serialized into a rotation decision event — a pathological
 *  backstop on the log line; a real fleet is ~19 accounts, well under it. The
 *  candidates are emitted as a keyed OBJECT (not an array) so the event sink's
 *  generic `sanitizeNested` does not truncate them to its 10-element array cap
 *  (feed/events.ts) — an object is recursed uncapped, so the whole pool up to
 *  this bound survives. */
const ROTATION_EVENT_CANDIDATE_CAP = 32;

/**
 * Compact, queryable descriptor of ONE candidate exactly as the router saw it,
 * for the `rotation.resolved`/`rotation.unresolved` event. These are the fields
 * that disambiguate WHY a route landed on a bad account, so a post-mortem reads
 * them from `agents events` instead of guessing:
 *
 * - `usageKey` is the per-org quota key — the ONLY identity that joins the same
 *   account across devices (version numbers are device-local and meaningless
 *   across the fleet).
 * - `tier` is the freshness class the weighting actually used: `verified`
 *   (fresh windowed → routed at real headroom), `stale` (windowed but past the
 *   {@link USAGE_DECISION_MAX_AGE_MS} decision window → floored weight), `blind`
 *   (no snapshot at all — a worker whose usage endpoint 403s, or a never-synced
 *   network:false harness → still drawn at floor weight).
 * - `source`/`ageMs`/`capturedAt` expose staleness and provenance: a `last_seen`
 *   snapshot showing `tier: verified` with a large `ageMs` is the cross-host
 *   clock-skew failure (capturedAt is stamped by the reading host's clock, this
 *   `ageMs` by the routing host's — they disagree under skew).
 */
function describeRotationCandidate(c: RotateCandidate, nowMs: number): Record<string, unknown> {
  const snap = c.usageSnapshot;
  const capturedAtMs = snap?.capturedAt ? snap.capturedAt.getTime() : null;
  const tier = isUsageVerified(c, nowMs) ? 'verified' : hasStaleUsage(c, nowMs) ? 'stale' : 'blind';
  const readiness = readinessFromCandidate(c);
  return {
    usageKey: c.usageKey,
    // A RUSH-3182 provider/setup-token account carries a null usageKey and
    // shares its `version` with the native login and every sibling provider
    // account, so neither is a unique identity here. `accountKey` is the pool's
    // own dedup boundary (foldRegistryCandidates), and `providerAccount` names
    // the injected account — together they keep same-version rows distinct.
    accountKey: c.accountKey,
    providerAccount: c.providerAccount ?? null,
    email: c.email,
    version: c.version,
    signedIn: c.signedIn,
    // NOT `authVerdict`: the event sink's generic sanitizer redacts any payload
    // key matching /auth/i to "[REDACTED]" (feed/events.ts SENSITIVE_PAYLOAD_KEY),
    // which would silently blank this field on every row. `credentialVerdict`
    // carries the same value ('revoked'/null/…) past the redaction.
    credentialVerdict: c.authVerdict,
    usageStatus: c.usageStatus,
    tier,
    source: snap?.source ?? null,
    sourceLabel: snap?.sourceLabel ?? null,
    capturedAt: snap?.capturedAt ? snap.capturedAt.toISOString() : null,
    ageMs: capturedAtMs === null ? null : nowMs - capturedAtMs,
    windows: (snap?.windows ?? []).map((w) => ({ key: w.key, usedPercent: Math.round(w.usedPercent) })),
    unavailable: snap?.unavailable?.reason ?? null,
    eligible: readiness.ready,
    excludedReason: readiness.ready ? null : readiness.reason,
  };
}

/**
 * Build the enriched `rotation.resolved`/`rotation.unresolved` event payload:
 * the full candidate pool as the router saw it, the pick and WHY, and a
 * freshness tally. Replaces the old `{ version, healthy: <n>, excluded: <n> }`
 * shape, which recorded only counts and a device-local version and so could not
 * tell a blind-pool draw from a skewed-verified pick from a refused-stale route
 * — the exact ambiguity that keeps a bad pick undebuggable from the log. All
 * candidates share ONE `nowMs` so their `tier`/`ageMs` are mutually consistent.
 */
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
  // WHY the pick: a verified-weighted draw is the healthy path; an
  // `unverified-*-draw` names the fallback the router was forced into (a blind
  // worker pool, or a stale-but-plausible number); `refused-no-verified` is the
  // fail-closed exit where no version launches. Read straight from the result's
  // own `usageUnverified`/`noVerifiedUsage`, so the event can never disagree
  // with what rotation actually did.
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
    // An OBJECT (not an array), so the sink cannot truncate it to 10 entries
    // (see ROTATION_EVENT_CANDIDATE_CAP). Keyed by POOL INDEX, not by version or
    // usageKey: a RUSH-3182 provider-account pool has multiple candidates
    // sharing one `version` AND a null `usageKey` (foldRegistryCandidates), so
    // either would collide and silently drop rows via Object.fromEntries. The
    // index is structural only; each row's identity is its `accountKey` /
    // `usageKey` / `providerAccount`. `candidatesTotal` reveals cap overflow.
    candidates: Object.fromEntries(
      pool.slice(0, ROTATION_EVENT_CANDIDATE_CAP).map((c, i) => [String(i), describeRotationCandidate(c, nowMs)]),
    ),
    candidatesTotal: pool.length,
  };
}

/**
 * Build AND emit a rotation decision event without ever letting an observability
 * bug crash a live route. `emit` swallows its own IO errors, but the payload
 * ARGUMENT is evaluated before `emit` is called, so a future null-deref inside
 * `describeRotationCandidate` would otherwise propagate into `resolveRunVersion`
 * and abort the launch. This wraps both build and emit, so the worst case is a
 * lost log line, never a failed run.
 */
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

/**
 * Resolve the version `agents run` should use when the caller did not pin
 * one with `@version`. The caller supplies the effective strategy.
 *
 * `pinned` still prefers the workspace/global default, but it MUST NOT launch
 * a logged-out (or revoked) default when the same device holds a signed-in
 * version that can run — that was a silent 1-second death on fleet workers
 * whose default home had no credential (PHNX-2685). A rate-limited pin is
 * still honoured: `--strategy pinned` remains the escape hatch to force the
 * default through a throttle. When the default is auth-blocked and nothing
 * else is healthy, `exhausted` is set so the caller fails loud instead of
 * spawning into a credential-less home.
 */
export async function resolveRunVersion(
  agent: AgentId,
  strategy: RunStrategy,
  cwd: string = process.cwd(),
  collect: (agent: AgentId) => Promise<RotateCandidate[]> = collectRunCandidates,
  model?: string,
): Promise<{
  version: string | null;
  rotation: RotateResult | null;
  /**
   * Set when a strategy found ZERO healthy candidates among the installed
   * versions: the full excluded set, so callers fail loud with per-account
   * reasons instead of launching the exhausted pinned default (RUSH-2132).
   * Also set for `pinned` when the default is logged out / revoked and no
   * signed-in alternative exists (PHNX-2685). Undefined for successful picks
   * and when no version is installed at all (the pre-existing not-installed
   * path — there is no account to be "unhealthy").
   */
  exhausted?: RotateCandidate[];
  /**
   * Set (with `version: null`) for a `balanced`/`available` route when EVERY
   * eligible account's usage is stale and none is verified (PHNX-2526). The
   * initial selection MUST NOT auto-launch on a stale number: an interactive
   * caller diverts to the account picker, an unattended one fails loud with
   * NO_VERIFIED_USAGE (`formatNoVerifiedUsageError`). `rotation` is still
   * returned — its `healthy` set (the stale candidates) is preserved ONLY for
   * bounded post-rejection failover, never the initial pick. Undefined when a
   * verified account exists, when the pool is entirely blind (no snapshots —
   * the worker-box case still draws a pick), for `pinned`, and for the
   * zero-healthy `exhausted` case.
   */
  noVerifiedUsage?: boolean;
}> {
  const fallback = resolveVersion(agent, cwd);
  const candidates = await collect(agent);

  // Entirely stale usage (PHNX-2526): every eligible account carries a
  // stale-but-present number and none is verified. Refuse to auto-pick on a
  // number that looks plausible but is wrong. `rotation` is returned so its
  // `healthy` set survives for BOUNDED post-rejection failover, but `version`
  // is null so the caller diverts — interactive to the account picker,
  // unattended to a loud NO_VERIFIED_USAGE exit. Shared across BOTH rotating
  // paths (the pinned auth-blocked-pin fallback AND balanced/available), since
  // both reuse `pickAvailableCandidate`/`pickBalancedCandidate` and neither may
  // launch a stale pick.
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
      // The auth-blocked pin rotates to a sibling — an initial selection, so it
      // gets the same verified-only gate as balanced/available. Without this, a
      // revoked pin with only stale siblings launched one blind (the yosemite-s1
      // trap through the pinned path — PR #3295 review).
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
    // `available` is sticky to the pinned default when healthy. Use the 60s
    // anti-collision stamp to nudge parallel callers off the same version.
    // `balanced` doesn't need this — its weighted random roll already
    // distributes naturally across healthy accounts.
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

/**
 * Cap on the number of healthy accounts a single run will re-dispatch through
 * after a mid-run rate limit. Bounds the synthesized chain so a machine signed
 * into many accounts can't turn one 429 into an unbounded cascade of retries.
 */
export const DEFAULT_ROTATION_FAILOVER_LIMIT = 3;

/**
 * Synthesize a same-agent, cross-account fallback chain from a pre-flight
 * rotation result (issue #348: mid-run rate-limit failover).
 *
 * The account rotation picks ONE version pre-spawn; today a 429 mid-run kills
 * the run with no recovery. `runWithFallback` + `detectRateLimit` already
 * re-dispatch to the NEXT chain entry on a rate limit and hand off the session
 * via `/continue <id>` — but only for explicit `--fallback` chains. This turns
 * the OTHER healthy rotation candidates (every account except the one already
 * picked as the primary) into `FallbackEntry`s so that SAME machinery re-runs
 * the task on the next healthy account of the same agent when the primary 429s.
 *
 * Each account is a distinct installed version (its own home/auth), so the
 * entries are same-agent, different-version — exactly what runWithFallback
 * spawns and what buildFallbackPrompt continues (claude→claude via `/continue`).
 * Candidates are consumed in `rotation.healthy` order, which is sorted by
 * remaining capacity (most headroom first, see compareCandidates), so failover
 * prefers the freshest account.
 *
 * Returns `[]` when there is no rotation (pinned strategy) or the picked account
 * is the only healthy one — so single-account users and non-rotation runs are
 * completely unchanged.
 */
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

/**
 * Whether a run is eligible to have a mid-run rate-limit failover chain armed
 * (issue #348). Failover injects synthesized `FallbackEntry`s into the same
 * `fallback` array that `--fallback` uses — so it must NOT arm for run shapes
 * that reject a non-empty fallback chain, or the run hard-exits on a flag the
 * user never passed. Specifically:
 *
 * - `acp` and `loop` runs bail with "not compatible with --fallback yet" the
 *   moment `fallback.length > 0` (src/commands/exec.ts), so arming failover
 *   would break a previously-working `agents run … --loop` / `--acp`.
 * - `resumeCheckpoint` runs take the loop path (same guard).
 * - `interactive` / no-prompt runs can't be re-dispatched headlessly.
 * - `hasRotation`/`hasVersion` gate on an actual pre-flight rotation having
 *   picked an account, so pinned and non-rotation runs are untouched.
 *
 * An explicit `--fallback` chain does NOT disarm rotation failover: the
 * synthesized same-agent entries are unshifted AHEAD of the user's cross-agent
 * entries, so a rate limit exhausts the other accounts of the same agent
 * before cascading to a different CLI. Profile fallbacks never reach here —
 * strategy resolution is skipped for profiles, so hasRotation is false.
 *
 * Pure so the arming matrix is unit-testable without invoking the run command.
 */
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
