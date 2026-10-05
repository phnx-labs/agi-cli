
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
  usageKey: string | null;
  usageStatus: AccountInfo['usageStatus'];
  usageSnapshot: UsageSnapshot | null;
  usageError: string | null;
  usageMinutesToLimit: number | null;
  plan: string | null;
  signedIn: boolean;
  authVerdict: AuthVerdict | null;
  authCheckedAt?: number | null;
  lastActive: Date | null;
  providerAccount?: string;
  nativeAccount?: string;
  nativeAccountId?: string;
  providerAccountId?: string;
  slotDir?: string;
  fromSlot?: boolean;
}

export interface RotateResult {
  picked: RotateCandidate;
  healthy: RotateCandidate[];
  excluded: RotateCandidate[];
  usageUnverified?: boolean;
  noVerifiedUsage?: boolean;
}

export const RUN_STRATEGIES: RunStrategy[] = ['pinned', 'available', 'balanced'];

export function normalizeRunStrategy(value: unknown): RunStrategy | null {
  if (typeof value !== 'string') return null;
  if (value === 'rotate') return 'balanced';
  return RUN_STRATEGIES.includes(value as RunStrategy) ? value as RunStrategy : null;
}

function getProjectRunStrategy(agent: AgentId, startPath: string): RunStrategy | null {
  for (const runConfig of getProjectRunConfigs(startPath)) {
    const strategy = normalizeRunStrategy(runConfig[agent]?.strategy);
    if (strategy) return strategy;
  }

  return null;
}

export function getConfiguredRunStrategy(agent: AgentId, startPath: string = process.cwd()): RunStrategy {
  return getProjectRunStrategy(agent, startPath)
    ?? normalizeRunStrategy(readMeta().run?.[agent]?.strategy)
    ?? 'balanced';
}

const LAUNCHABLE_SLOT_VERDICTS: ReadonlySet<AuthVerdict> = new Set(['live', 'unverified']);

function isLaunchableSlotVerdict(verdict: AuthVerdict | null): boolean {
  return verdict !== null && LAUNCHABLE_SLOT_VERDICTS.has(verdict);
}

function isRotationEligible(candidate: RotateCandidate, nowMs: number = Date.now(), model?: string): boolean {
  if (candidate.fromSlot && !isLaunchableSlotVerdict(candidate.authVerdict)) return false;
  return readinessFromCandidate(candidate, nowMs, model).ready;
}

export function isLaunchableSignedIn(
  signedIn: boolean,
  presence: Pick<CredentialPresence, 'knownLocation' | 'perVersion'>,
): boolean {
  // An empty known-location version home cannot borrow the global/active login.
  if (!signedIn) return false;
  if (!presence.knownLocation) return true;
  return presence.perVersion;
}

interface VersionLaunchState {
  launchable: boolean;
  email: string | null;
}

export async function isVersionLaunchableHere(
  agent: AgentId,
  version: string,
): Promise<VersionLaunchState> {
  const home = getVersionHomePath(agent, version);
  const info = await getAccountInfo(agent, home);
  const launchable = isLaunchableSignedIn(info.signedIn, credentialPresence(agent, home));
  return { launchable, email: launchable ? info.email : null };
}

// Separate clocks govern weighting, synced trust, and hard stale refusal.
export const USAGE_DECISION_MAX_AGE_MS = 5 * 60 * 1000;

export const USAGE_SYNC_TRUST_MS = 15 * 60 * 1000;

export const USAGE_STALE_REFUSAL_MAX_AGE_MS = 40 * 60 * 1000;

export function usageVerifiedMaxAgeMs(snapshot: UsageSnapshot | null | undefined): number {
  return snapshot?.freshness?.source === 'sync' ? USAGE_SYNC_TRUST_MS : USAGE_DECISION_MAX_AGE_MS;
}

export function isUsageVerified(candidate: RotateCandidate, nowMs: number = Date.now()): boolean {
  const snapshot = candidate.usageSnapshot;
  const capturedAt = snapshot?.capturedAt;
  if (!capturedAt || !snapshot?.windows.length) return false;
  return nowMs - capturedAt.getTime() <= usageVerifiedMaxAgeMs(snapshot);
}

export function hasStaleUsage(candidate: RotateCandidate, nowMs: number = Date.now()): boolean {
  const snapshot = candidate.usageSnapshot;
  const capturedAt = snapshot?.capturedAt;
  // Missing/meterless candidates are blind, while synced rows never trigger refusal.
  if (!capturedAt || !snapshot?.windows.length) return false;
  if (snapshot.freshness?.source === 'sync') return false;
  return nowMs - capturedAt.getTime() > USAGE_STALE_REFUSAL_MAX_AGE_MS;
}

function hasUsageAvailable(candidate: RotateCandidate, now: number = Date.now()): boolean {
  // Every blocking window, including a session window, governs eligibility.
  const snapshot = candidate.usageSnapshot;
  if (snapshot) {
    const status = deriveUsageStatusFromSnapshot(snapshot, now);
    if (status !== null) return status !== 'rate_limited';
  }

  if (candidate.usageStatus === 'out_of_credits' || candidate.usageStatus === 'rate_limited') {
    return false;
  }

  return true;
}

export type AccountReadiness =
  | { ready: true }
  | {
      ready: false;
      reason: 'rate_limited' | 'out_of_credits' | 'signed_out' | 'revoked' | 'model_limited';
      email: string | null;
    };

export function readinessFromCandidate(
  candidate: RotateCandidate,
  now: number = Date.now(),
  model?: string,
): AccountReadiness {
  if (!candidate.signedIn) {
    return { ready: false, reason: 'signed_out', email: candidate.email };
  }
  // Absent or stale auth probes fail open; only a fresh dead verdict excludes.
  const authFresh = candidate.authCheckedAt == null
    || now - candidate.authCheckedAt <= AUTH_PROBE_MAX_AGE_MS;
  if (authFresh && candidate.authVerdict !== null && isDeadVerdict(candidate.authVerdict)) {
    return { ready: false, reason: 'revoked', email: candidate.email };
  }
  // Model refusals bind to the stable account id, never an organization usage id.
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

export function isSignInRecoverable(readiness: AccountReadiness): boolean {
  return !readiness.ready && (readiness.reason === 'signed_out' || readiness.reason === 'revoked');
}

export function signInRecoverableCandidates(candidates: RotateCandidate[]): RotateCandidate[] {
  return candidates.filter((c) => isSignInRecoverable(readinessFromCandidate(c)));
}

export async function checkRunAccountReadiness(agent: AgentId, version: string): Promise<AccountReadiness> {
  const candidates = await collectRunCandidates(agent);
  const candidate = candidates.find((c) => c.version === version);
  if (!candidate) return { ready: true };
  return readinessFromCandidate(candidate);
}

function getRoutingUsedPercent(snapshot: UsageSnapshot | null | undefined): number | null {
  if (!snapshot || snapshot.windows.length === 0) return null;
  // Session windows block eligibility; longer-term windows rank healthy accounts.
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

export function candidateAccountKey(c: RotateCandidate): string {
  // Registered native/provider identities win dedupe over usage-derived keys.
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

function preferVerified(
  pool: RotateCandidate[],
  nowMs: number,
  choose: (from: RotateCandidate[]) => RotateCandidate,
  narrowing: 'any-verified' | 'representative' = 'any-verified',
): { picked: RotateCandidate; usageUnverified: boolean; noVerifiedUsage: boolean } {
  // Balanced narrows only for a representative set; available narrows on any proof.
  const verified = pool.filter((c) => isUsageVerified(c, nowMs));
  const narrow =
    verified.length > 0 &&
    (narrowing === 'any-verified' || verified.length >= Math.ceil(pool.length / 2));
  const picked = choose(narrow ? verified : pool);
  const noVerifiedUsage = verified.length === 0 && pool.some((c) => hasStaleUsage(c, nowMs));
  return {
    picked,
    usageUnverified: !isUsageVerified(picked, nowMs),
    noVerifiedUsage,
  };
}

export { PROJECTION_HORIZON_MIN, capacityWeight };

function weightedRandomByCapacity(
  sorted: RotateCandidate[],
  nowMs: number = Date.now(),
): RotateCandidate {
  // Blind candidates remain in the healthy pool for bounded post-rejection failover.
  const weights = sorted.map((c) =>
    capacityWeight(
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

  const { picked: bestVerified, usageUnverified, noVerifiedUsage } = preferVerified(sorted, nowMs, (from) => from[0]);
  const preferred = preferredVersion
    ? sorted.find((candidate) => candidate.version === preferredVersion)
    : undefined;
  return { picked: preferred ?? bestVerified, healthy: sorted, excluded, usageUnverified, noVerifiedUsage };
}

interface HarnessSummary {
  agent: AgentId;
  candidates: RotateCandidate[];
  healthy: RotateCandidate[];
  best: RotateCandidate | null;
  bestUsedPercent: number | null;
  exclusionReasons: string[];
}

interface HarnessPickResult {
  picked: HarnessSummary;
  healthy: HarnessSummary[];
  excluded: HarnessSummary[];
}

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

export function formatHarnessPickBanner(result: HarnessPickResult): string {
  const { picked, healthy, excluded } = result;
  const headroom = picked.bestUsedPercent === null
    ? 'best account headroom unknown'
    : `best account ${Math.max(0, Math.round(100 - picked.bestUsedPercent))}% headroom`;
  const ratio = `${healthy.length} of ${healthy.length + excluded.length} harnesses healthy`;
  return `[agents] auto picked ${picked.agent} (${headroom}, ${ratio})`;
}

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

function formatResetSummary(reset: Date | null): string {
  return reset ? reset.toISOString() : 'unknown (no reset timestamps in any snapshot)';
}

export function formatNoHealthyAccountError(
  agent: AgentId,
  strategy: RunStrategy,
  excluded: RotateCandidate[],
  nowMs: number = Date.now(),
): string {
  // Watchdogs parse the literal "no healthy" and "resets" tokens below.
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

function snapshotAgeMinutes(candidate: RotateCandidate, nowMs: number): number | null {
  const capturedAt = candidate.usageSnapshot?.capturedAt;
  if (!capturedAt || !candidate.usageSnapshot?.windows.length) return null;
  return Math.max(0, Math.round((nowMs - capturedAt.getTime()) / 60_000));
}

export function formatNoVerifiedUsageError(
  agent: AgentId,
  strategy: RunStrategy,
  candidates: RotateCandidate[],
  nowMs: number = Date.now(),
): string {
  // NO_VERIFIED_USAGE is a machine-consumed refusal marker.
  const detail = candidates.length === 0
    ? 'no signed-in accounts'
    : candidates.map((c) => {
        const age = snapshotAgeMinutes(c, nowMs);
        const synced = c.usageSnapshot?.freshness?.source === 'sync';
        const staleness = age === null
          ? 'no usage snapshot'
          : `usage ${age}m old${synced ? ', synced' : ''}`;
        return `${c.version} (${staleness})`;
      }).join(', ');
  const maxAgeMin = Math.round(USAGE_STALE_REFUSAL_MAX_AGE_MS / 60_000);
  return `agents: NO_VERIFIED_USAGE — no signed-in ${agent} account has usage newer than ${maxAgeMin}m under strategy '${strategy}', so routing refuses to guess on a stale number: ${detail}. Refresh usage (agents view ${agent}) or pin the default with --strategy pinned.`;
}

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
  // The hot path reads only this host's auth cache; it never probes credentials.
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
      // Real paths prevent the same slot/version home entering the pool twice.
      slotDirs.add(fs.realpathSync(row.home));
    }
  }

  const versionRows: Array<CandidateRow | null> = await Promise.all(
    versions.map(async (version): Promise<CandidateRow | null> => {
      const home = getVersionHomePath(agent, version);
      if (fs.existsSync(home) && slotDirs.has(fs.realpathSync(home))) return null;
      // In particular, do not validate Claude through Keychain: it can prompt.
      const info = await getAccountInfo(agent, home);
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

  // Usage/headroom collection is cache-only, avoiding one network call per account.
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

export async function selectBalancedVersion(agent: AgentId): Promise<RotateResult | null> {
  return pickBalancedCandidate(await collectRunCandidates(agent));
}

function recordRotationPick(agent: AgentId, version: string): void {
  const stampPath = path.join(getRotateDir(), `stamp-${agent}.json`);
  try {
    fs.writeFileSync(stampPath, JSON.stringify({ version, ts: Date.now() }), 'utf-8');
  } catch {  }
}

function readRotationStamp(agent: AgentId): string | null {
  const stampPath = path.join(getRotateDir(), `stamp-${agent}.json`);
  try {
    const raw = JSON.parse(fs.readFileSync(stampPath, 'utf-8')) as { version: string; ts: number };
    if (Date.now() - raw.ts < 60_000) return raw.version;
  } catch {  }
  return null;
}

// Index-keyed objects avoid sink array caps and identity-key collisions.
const ROTATION_EVENT_CANDIDATE_CAP = 32;

function describeRotationCandidate(c: RotateCandidate, nowMs: number): Record<string, unknown> {
  const snap = c.usageSnapshot;
  const capturedAtMs = snap?.capturedAt ? snap.capturedAt.getTime() : null;
  const tier = isUsageVerified(c, nowMs) ? 'verified' : hasStaleUsage(c, nowMs) ? 'stale' : 'blind';
  const readiness = readinessFromCandidate(c);
  return {
    usageKey: c.usageKey,
    accountKey: c.accountKey,
    providerAccount: c.providerAccount ?? null,
    email: c.email,
    version: c.version,
    signedIn: c.signedIn,
    // Avoid an `auth` field name: event redaction treats it as credential material.
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
    candidates: Object.fromEntries(
      pool.slice(0, ROTATION_EVENT_CANDIDATE_CAP).map((c, i) => [String(i), describeRotationCandidate(c, nowMs)]),
    ),
    candidatesTotal: pool.length,
  };
}

function emitRotationDecision(
  event: 'rotation.resolved' | 'rotation.unresolved',
  rotation: RotateResult,
  agent: AgentId,
  strategy: RunStrategy,
  extra: EventPayload = {},
): void {
  // Telemetry construction and emission must never break routing.
  try {
    emit(event, { ...buildRotationDecisionEvent(rotation, agent, strategy), ...extra });
  } catch {
  }
}

export async function resolveRunVersion(
  agent: AgentId,
  strategy: RunStrategy,
  cwd: string = process.cwd(),
  collect: (agent: AgentId) => Promise<RotateCandidate[]> = collectRunCandidates,
  model?: string,
): Promise<{
  version: string | null;
  rotation: RotateResult | null;
  exhausted?: RotateCandidate[];
  noVerifiedUsage?: boolean;
}> {
  // Pinned throttling is forceable, but an auth-dead pin rotates to recovery.
  const fallback = resolveVersion(agent, cwd);
  const candidates = await collect(agent);

  const refuseStaleUsage = (
    rotation: RotateResult,
  ): { version: string | null; rotation: RotateResult; noVerifiedUsage: true } => {
    // Stale usage refuses the initial route but remains available to bounded failover.
    emitRotationDecision('rotation.unresolved', rotation, agent, strategy, {
      reason: 'no_verified_usage',
    });
    return { version: null, rotation, noVerifiedUsage: true };
  };

  if (strategy === 'pinned') {
    const pinnedCandidate = fallback
      ? candidates.find((c) => c.version === fallback)
      : undefined;
    if (pinnedCandidate && isSignInRecoverable(readinessFromCandidate(pinnedCandidate))) {
      const rotation = pickAvailableCandidate(candidates, fallback, undefined, model);
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

export const DEFAULT_ROTATION_FAILOVER_LIMIT = 3;

export function rotationFailoverChain(
  rotation: RotateResult | null,
  pickedVersion: string,
  limit: number = DEFAULT_ROTATION_FAILOVER_LIMIT,
): FallbackEntry[] {
  if (!rotation || limit <= 0) return [];
  const chain: FallbackEntry[] = [];
  for (const candidate of rotation.healthy) {
    if (candidate.version === pickedVersion) continue;
    chain.push({ agent: candidate.agent, version: candidate.version });
    if (chain.length >= limit) break;
  }
  return chain;
}

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
  // Handoff is forbidden for interactive, ACP, loop, resume, and workflow runs.
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
  // Validate the whole canonical spec before consuming its first fallback entry.
  const parsed = entries.map((entry) => entry.split('@'));
  if (parsed.some(([name]) => !isAgentId(name) || name === primary)) return null;
  const [name, version] = parsed[0];
  const remaining = entries.slice(1);
  return {
    agent: name as AgentId,
    version: version || undefined,
    remainingSpec: remaining.length > 0 ? remaining.join(',') : undefined,
  };
}

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
