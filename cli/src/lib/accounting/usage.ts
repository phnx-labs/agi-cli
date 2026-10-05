import { execFile } from 'child_process';
import { createHash } from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as readline from 'readline';
import { promisify } from 'util';
import chalk from 'chalk';

import { decodeJwtPayload, decryptDroidAuthPayload, type AccountInfo } from '../agents.js';
import { walkForFiles } from '../fs-walk.js';
import {
  deleteKeychainToken,
  deleteKeychainTokenSync,
  getKeychainTokenSync,
  setKeychainToken,
} from '../secrets-client.js';
import { resolveClaudeSetupToken } from '../claude-account-token.js';
import {
  formatBackoffRemaining,
  noteUsageRateLimited,
  usageRateLimitedUntil,
} from '../usage-backoff.js';
import { getCacheDir } from '../state.js';
import type { AgentId } from '../types.js';
import { mapBounded } from '../concurrency.js';
import { atomicWriteFileSync, ensureLockTarget, withFileLock, withFileLockAsync } from '../fs-atomic.js';
import { withRefreshLease } from '../refresh-coordinator.js';
import { padToWidth } from '../session/width.js';

const execFileAsync = promisify(execFile);

const CLAUDE_USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
const CLAUDE_TOKEN_URL = 'https://platform.claude.com/v1/oauth/token';
const CLAUDE_CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
const CLAUDE_OAUTH_BETA_HEADER = 'oauth-2025-04-20';
const CLAUDE_REFRESH_LEEWAY_MS = 5 * 60 * 1000;

export function usageNoCredentialError(agent: string): string {
  return `No readable ${agent} credential — sign in, or provision a long-lived token for this account.`;
}
export function usageExpiredCredentialError(agent: string): string {
  return `${agent} credential expired — re-auth this account (a usage read never refreshes it).`;
}

export function usageExpiredKimiCredentialError(): string {
  return `Kimi credential expired — run Kimi once to refresh it (a usage read never refreshes it).`;
}
export function usageRejectedError(agent: string, status: number): string {
  return status === 429
    ? `${agent} is rate-limiting the usage endpoint for this machine (HTTP 429).`
    : `${agent} rejected the usage read (HTTP ${status}).`;
}

export const USAGE_HEADLESS_SCOPE_MARKER = 'usage unavailable (headless)';

export function usageHeadlessScopeError(agent = 'Claude'): string {
  return `${agent} ${USAGE_HEADLESS_SCOPE_MARKER} — setup-token lacks user:profile; account can still run.`;
}

export function isUsageHeadlessScopeError(error: string | null | undefined): boolean {
  return typeof error === 'string' && error.includes(USAGE_HEADLESS_SCOPE_MARKER);
}

export const USAGE_NO_USAGE_CREDENTIAL_MARKER = 'usage unavailable (no usage credential)';

/**
 * Claude's own no-credential message. The shared
 * {@link usageNoCredentialError} offers "sign in" as the remedy, which holds
 * for Kimi/Droid/Cursor — their CLIs rotate a readable token on the next launch
 * — and is false for Claude: the usage read deliberately never touches the
 * interactive login (RUSH-1822), so an account that IS signed in reads as
 * unreadable here and signing in again changes nothing. Naming only the second
 * remedy would send the operator to `claude setup-token`, whose token then hits
 * the `user:profile` scope gap (RUSH-2392) — the loop reported in #2987 — so
 * this message states both constraints and that the account still runs.
 */
export function usageNoClaudeUsageCredentialError(): string {
  return (
    `Claude ${USAGE_NO_USAGE_CREDENTIAL_MARKER} — a usage read never uses your login ` +
    '(RUSH-1822); a setup-token cannot read usage (RUSH-2392). The account still runs.'
  );
}

function isUsageNoUsageCredentialError(error: string | null | undefined): boolean {
  return typeof error === 'string' && error.includes(USAGE_NO_USAGE_CREDENTIAL_MARKER);
}

export function isClaudeUsageScopeDenied(
  status: number,
  bodyText: string | null | undefined,
): boolean {
  if (status !== 403) return false;
  if (!bodyText) return false;
  const lower = bodyText.toLowerCase();
  return lower.includes('user:profile') || lower.includes('scope requirement');
}

export function usageThrottledError(agent: string, untilMs: number): string {
  return `${agent} rate-limited this machine — not retrying for ${formatBackoffRemaining(untilMs)}.`;
}
export function usageUnreachableError(agent: string, cause?: unknown): string {
  const detail = cause instanceof Error ? cause.message : typeof cause === 'string' ? cause : '';
  return detail
    ? `${agent} usage read failed: ${detail}`
    : `${agent} usage read failed.`;
}

const USAGE_NO_RECENT_USAGE_MARKER = 'no usage recorded yet';
export const USAGE_BENIGN_STATE: unique symbol = Symbol('usageBenignState');
export type UsageBenignState = 'no-recent-usage';

export const USAGE_NOT_COLLECTED_MARKER = 'stale';

export function usageErrorForDisplay(error: string | null | undefined): string | null {
  if (!error) return null;
  if (error === USAGE_NOT_COLLECTED_MARKER) {
    return 'Usage not collected yet — run `agents view --refresh` to fetch it.';
  }
  return error;
}

export function classifyUsageFetchFailure(
  agent: string,
  agentId: 'antigravity' | 'muse',
  status: number | null,
  retryAfterHeader: string | null | undefined,
  usageScope?: string | null,
): string {
  if (status === 429) {
    noteUsageRateLimited(agentId, retryAfterHeader ?? null, { account: usageScope });
    return usageRejectedError(agent, 429);
  }
  if (status !== null) return usageRejectedError(agent, status);
  return usageUnreachableError(agent);
}

export type UsageErrorKind =
  | 'no-credential'
  | 'no-usage-credential'
  | 'expired-credential'
  | 'rate-limited'
  | 'rejected'
  | 'headless-scope'
  | 'unreachable'
  | 'not-collected';

export function classifyUsageErrorKind(error: string | null | undefined): UsageErrorKind | null {
  if (!error) return null;
  if (error === USAGE_NOT_COLLECTED_MARKER) return 'not-collected';
  if (isUsageHeadlessScopeError(error)) return 'headless-scope';
  if (isUsageNoUsageCredentialError(error)) return 'no-usage-credential';
  if (error.startsWith('No readable ')) return 'no-credential';
  if (error.includes('credential expired')) return 'expired-credential';
  if (error.includes('rate-limited this machine') || error.includes('is rate-limiting the usage endpoint')) {
    return 'rate-limited';
  }
  if (error.includes('rejected the usage read')) return 'rejected';
  if (error.includes('usage read failed')) return 'unreachable';
  return 'rejected';
}

export function claudeAccessTokenNeedsRefresh(
  expiresAt: number | null | undefined,
  nowMs: number = Date.now(),
): boolean {
  if (expiresAt == null) return false;
  return nowMs + CLAUDE_REFRESH_LEEWAY_MS >= expiresAt;
}
const CLAUDE_SCOPES = [
  'user:profile',
  'user:inference',
  'user:sessions:claude_code',
  'user:mcp_servers',
  'user:file_upload',
];
const CLAUDE_KEYCHAIN_SERVICE = 'Claude Code-credentials';

let claudeUsageCachePathOverride: string | null = null;
export function setClaudeUsageCachePathForTest(cachePath: string | null): string | null {
  const prev = claudeUsageCachePathOverride;
  claudeUsageCachePathOverride = cachePath;
  return prev;
}
const getClaudeUsageCachePath = () => claudeUsageCachePathOverride ?? path.join(getCacheDir(), 'claude-usage.json');
const CACHED_CLAUDE_USAGE_SOURCE_LABEL = 'last seen live account data';

const KIMI_USAGES_URL = 'https://api.kimi.com/coding/v1/usages';

const DROID_USAGE_URL = 'https://api.factory.ai/api/billing/limits';

const CURSOR_USAGE_URL = 'https://cursor.com/api/usage';
const CURSOR_PERIOD_USAGE_URL = 'https://cursor.com/api/dashboard/get-current-period-usage';
const CURSOR_USAGE_SUMMARY_URL = 'https://cursor.com/api/usage-summary';

const COMPACT_BAR_LEN = 5;
const USAGE_BAR_LEN = 10;
const FULL = '\u2588';
const EMPTY = '\u2591';
const PARTIAL_BLOCKS = ['', '\u258F', '\u258E', '\u258D', '\u258C', '\u258B', '\u258A', '\u2589'];
const NO_DATA = '\u2504';

export type UsageWindowKey = 'session' | 'week' | 'sonnet_week' | 'month';

export type UsageCaptureSource = 'poll' | 'statusline' | 'sync';

export interface UsageWindow {
  key: UsageWindowKey;
  label: string;
  shortLabel: string;
  usedPercent: number;
  resetsAt: Date | null;
  windowMinutes: number | null;
}

export interface UsageSnapshot {
  source: 'live' | 'last_seen';
  sourceLabel: string;
  capturedAt: Date | null;
  windows: UsageWindow[];
  staleWindows?: UsageWindow[];
  plan?: string | null;
  refreshHint?: string | null;
  unavailable?: {
    reason: 'session_limit' | 'out_of_credits';
    resetsAt?: Date;
  };
  freshness?: {
    source: UsageCaptureSource;
    poller?: string;
  };
}

export interface UsageInfo {
  snapshot: UsageSnapshot | null;
  error: string | null;
  [USAGE_BENIGN_STATE]?: UsageBenignState;
}

function usageNoRecentUsageInfo(): UsageInfo {
  return { snapshot: null, error: null, [USAGE_BENIGN_STATE]: 'no-recent-usage' };
}

export function getUsageBenignState(info: UsageInfo): UsageBenignState | null {
  return info[USAGE_BENIGN_STATE] ?? null;
}

export interface UsageIdentityInput {
  agentId: AgentId;
  info: AccountInfo;
  home?: string;
  cliVersion?: string | null;
}

interface UsageOptions {
  home?: string;
  cliVersion?: string | null;
  organizationId?: string | null;
  usageScope?: string | null;
  signal?: AbortSignal;
  fileOnly?: boolean;
  /**
   * When true, a read that finds no file-based setup-token MAY fall through to
   * Claude Code's interactive OAuth login (the only credential carrying
   * `user:profile`, which `/api/oauth/usage` requires). OFF by default and set
   * ONLY by a foreground human `agents view` on a headed device (personal or
   * desktop; see USAGE-READ-2). Every background caller — daemon usage warm, auth-health
   * probe, watchdog — leaves it unset, preserving the RUSH-1822 guarantee that
   * an unattended loop never transmits the interactive login to Anthropic.
   */
  allowInteractiveLogin?: boolean;
  nativeFileLogin?: boolean;
}

interface UsageFetchInput {
  agentId: AgentId;
  home?: string;
  cliVersion: string | null;
  organizationId: string | null;
}

interface CodexRateLimitWindow {
  used_percent?: number | null;
  window_minutes?: number | null;
  resets_at?: number | string | null;
}

interface CodexRateLimits {
  primary?: CodexRateLimitWindow | null;
  secondary?: CodexRateLimitWindow | null;
}

interface ClaudeUsageWindow {
  utilization?: number | null;
  resets_at?: number | string | null;
}

interface ClaudeUsageResponse {
  five_hour?: ClaudeUsageWindow | null;
  seven_day?: ClaudeUsageWindow | null;
  seven_day_sonnet?: ClaudeUsageWindow | null;
}

interface ClaudeOauthCredentials {
  accessToken?: string | null;
  refreshToken?: string | null;
  expiresAt?: number | null;
  scopes?: string[] | null;
  subscriptionType?: string | null;
  rateLimitTier?: string | null;
  organizationUuid?: string | null;
}

interface ClaudeKeychainPayload {
  organizationUuid?: string | null;
  claudeAiOauth?: ClaudeOauthCredentials | null;
}

interface ClaudeTokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
}

interface CachedUsageWindow {
  key: UsageWindowKey;
  label: string;
  shortLabel: string;
  usedPercent: number;
  resetsAt: string | null;
  windowMinutes: number | null;
}

interface CachedModelRefusal {
  family?: string;
  resetsAt?: string;
}

export interface CachedUsageSnapshot {
  capturedAt: string | null;
  windows: CachedUsageWindow[];
  plan?: string | null;
  refreshHint?: string | null;
  unavailable?: {
    reason: 'session_limit' | 'out_of_credits';
    resetsAt?: string;
  };
  modelRefusals?: Record<string, CachedModelRefusal>;
  freshnessSource?: UsageCaptureSource;
  pollerDevice?: string;
}

interface CodexRateLimitMatch {
  capturedAt: Date | null;
  rateLimits: CodexRateLimits;
}

interface UsageSource {
  fetch: (options?: UsageOptions) => Promise<UsageInfo>;
  network: boolean;
}

const USAGE_SOURCES = {
  claude: { fetch: getClaudeUsageInfo, network: true },
  codex: { fetch: getCodexUsageInfo, network: false },
  kimi: { fetch: getKimiUsageInfo, network: true },
  droid: { fetch: getDroidUsageInfo, network: true },
  grok: { fetch: getGrokUsageInfo, network: false },
  cursor: { fetch: getCursorUsageInfo, network: true },
  antigravity: { fetch: getAntigravityUsageInfo, network: true },
  muse: { fetch: getMuseUsageInfo, network: true },
} as const satisfies Partial<Record<AgentId, UsageSource>>;

export const USAGE_SOURCE_AGENT_IDS = Object.keys(USAGE_SOURCES) as (keyof typeof USAGE_SOURCES)[];

function getUsageSource(agentId: AgentId): UsageSource | undefined {
  return USAGE_SOURCES[agentId as keyof typeof USAGE_SOURCES];
}

export async function getUsageInfo(agentId: AgentId, options?: UsageOptions): Promise<UsageInfo> {
  const source = getUsageSource(agentId);
  return source ? source.fetch(options) : { snapshot: null, error: null };
}

function usageFetchSignal(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

export function getUsageLookupKey(
  info?: Pick<AccountInfo, 'usageKey' | 'accountKey'> | null
): string | null {
  return info?.usageKey || info?.accountKey || null;
}

export function buildCanonicalUsageContext(inputs: UsageIdentityInput[]): {
  canonicalByUsageKey: Map<string, AccountInfo>;
  usageFetchInputs: Map<string, UsageFetchInput>;
} {
  const canonicalByUsageKey = new Map<string, AccountInfo>();
  const usageFetchInputs = new Map<string, UsageFetchInput>();

  for (const input of inputs) {
    const key = getUsageLookupKey(input.info);
    if (!key) continue;

    const existing = canonicalByUsageKey.get(key);
    const existingMs = existing?.lastActive?.getTime() ?? -1;
    const currentMs = input.info.lastActive?.getTime() ?? -1;
    if (existing && existingMs >= currentMs) {
      continue;
    }

    canonicalByUsageKey.set(key, input.info);
    usageFetchInputs.set(key, {
      agentId: input.agentId,
      home: input.home,
      cliVersion: input.cliVersion || null,
      organizationId: input.info.organizationId,
    });
  }

  return { canonicalByUsageKey, usageFetchInputs };
}

export function agentReportsUsage(agentId: AgentId): boolean {
  return getUsageSource(agentId) !== undefined;
}

export function agentUsesNetworkUsage(agentId: AgentId): boolean {
  return getUsageSource(agentId)?.network === true;
}

export const USAGE_FETCH_CONCURRENCY = 3;

interface UsageLookupOptions {
  forceRefresh?: boolean;
  fileOnly?: boolean;
  signal?: AbortSignal;
  allowInteractiveLogin?: boolean;
  nativeFileLogin?: boolean;
}

export async function getUsageInfoByIdentity(
  inputs: UsageIdentityInput[],
  opts?: UsageLookupOptions,
): Promise<{
  canonicalByUsageKey: Map<string, AccountInfo>;
  usageByKey: Map<string, UsageInfo>;
}> {
  const { canonicalByUsageKey, usageFetchInputs } = buildCanonicalUsageContext(inputs);
  const entries = [...usageFetchInputs.entries()];
  const usageResults = await mapBounded(
    entries,
    async ([key, input]) => ({
      key,
      usage: await getUsageInfoForIdentity({
        agentId: input.agentId,
        home: input.home,
        cliVersion: input.cliVersion,
        info: canonicalByUsageKey.get(key)!,
      }, opts),
    }),
    { concurrency: USAGE_FETCH_CONCURRENCY },
  );

  return {
    canonicalByUsageKey,
    usageByKey: new Map(usageResults.map(({ key, usage }) => [key, usage])),
  };
}

const inFlightLiveFetches = new Map<string, Promise<UsageInfo>>();

export async function getUsageInfoForIdentity(
  input: UsageIdentityInput,
  opts?: UsageLookupOptions,
): Promise<UsageInfo> {
  const usageKey = getUsageLookupKey(input.info);
  const forceRefresh = opts?.forceRefresh === true;
  const readOnly = !forceRefresh;

  if (!usageKey) {
    if (readOnly) return { snapshot: null, error: USAGE_NOT_COLLECTED_MARKER };
    return getUsageInfo(input.agentId, {
      home: input.home,
      cliVersion: input.cliVersion,
      organizationId: input.info.organizationId,
      fileOnly: opts?.fileOnly,
      allowInteractiveLogin: opts?.allowInteractiveLogin,
      nativeFileLogin: opts?.nativeFileLogin,
      signal: opts?.signal,
    });
  }

  const cached = readClaudeUsageCache(usageKey);
  if (readOnly) {
    if (cached && (cached.windows.length > 0 || cached.plan || cached.unavailable)) {
      return { snapshot: cached, error: null };
    }
    if (cached) return { snapshot: cached, error: USAGE_NOT_COLLECTED_MARKER };
    return { snapshot: null, error: USAGE_NOT_COLLECTED_MARKER };
  }

  return fetchLiveUsageDeduped(input, usageKey, cached, opts?.fileOnly === true, {
    allowInteractiveLogin: opts?.allowInteractiveLogin === true,
    nativeFileLogin: opts?.nativeFileLogin === true,
    signal: opts?.signal,
  });
}

async function fetchLiveUsageDeduped(
  input: UsageIdentityInput,
  usageKey: string,
  cached: UsageSnapshot | null,
  fileOnly: boolean,
  opts?: { allowInteractiveLogin?: boolean; nativeFileLogin?: boolean; signal?: AbortSignal },
): Promise<UsageInfo> {
  const existing = inFlightLiveFetches.get(usageKey);
  if (existing) return existing;

  const previousCapturedAt = cached?.capturedAt?.getTime() ?? 0;
  const promise = withRefreshLease<UsageInfo>({
    scope: 'usage',
    key: usageKey,
    readCompleted: () => {
      const snapshot = readClaudeUsageCache(usageKey);
      return snapshot ? { snapshot, error: null } : null;
    },
    isCompleted: (value) => (value.snapshot?.capturedAt?.getTime() ?? 0) > previousCapturedAt,
    refresh: async (): Promise<UsageInfo> => {
      const latestCached = readClaudeUsageCache(usageKey) ?? cached;
      const usage = await getUsageInfo(input.agentId, {
        home: input.home,
        cliVersion: input.cliVersion,
        organizationId: input.info.organizationId,
        usageScope: usageKey,
        fileOnly,
        allowInteractiveLogin: opts?.allowInteractiveLogin === true,
        nativeFileLogin: opts?.nativeFileLogin === true,
        signal: opts?.signal,
      });

      if (usage.snapshot) {
        if (!usage.snapshot.capturedAt || usage.snapshot.capturedAt.getTime() <= previousCapturedAt) {
          usage.snapshot.capturedAt = new Date(previousCapturedAt + 1);
        }
        writeClaudeUsageCache(usageKey, usage.snapshot);
        return usage;
      }

      if (latestCached) return { snapshot: latestCached, error: usage.error };
      return usage;
    },
  });

  inFlightLiveFetches.set(usageKey, promise);
  try {
    return await promise;
  } finally {
    inFlightLiveFetches.delete(usageKey);
  }
}

export function pickCompactUsageWindows(
  windows: UsageWindow[],
  maxWindows?: number,
): UsageWindow[] {
  const filtered = windows.filter((window) => window.key !== 'sonnet_week');
  if (maxWindows === undefined || maxWindows <= 0 || filtered.length <= maxWindows) {
    return filtered;
  }

  const chosen: UsageWindow[] = [];
  const take = (w: UsageWindow | undefined): void => {
    if (!w || chosen.includes(w) || chosen.length >= maxWindows) return;
    chosen.push(w);
  };

  take(filtered.find((w) => w.key === 'session'));
  take(filtered.find((w) => w.key === 'week'));

  const rest = filtered
    .filter((w) => !chosen.includes(w))
    .sort((a, b) => b.usedPercent - a.usedPercent);
  for (const w of rest) {
    if (chosen.length >= maxWindows) break;
    chosen.push(w);
  }
  return chosen;
}

export interface FormatUsageSummaryOpts {
  unavailable?: boolean;
  unverified?: boolean;
  headless?: boolean;
  maxWindows?: number;
  expectedWindows?: Array<{ key: string; shortLabel: string }>;
  errorKind?: UsageErrorKind | null;
  errorDetail?: string | null;
  benignState?: UsageBenignState | null;
  noRecentUsageLabel?: string | null;
}

export function viewUsageSummaryOptions(
  agentId: AgentId,
  signedIn: boolean,
  usageInfo: UsageInfo | undefined,
  maxWindows: number | undefined,
  version?: string,
): FormatUsageSummaryOpts {
  const headless = isUsageHeadlessScopeError(usageInfo?.error);
  const benignState = usageInfo ? getUsageBenignState(usageInfo) : null;
  return {
    unavailable: agentReportsUsage(agentId) && signedIn && !usageInfo?.snapshot && !headless && !benignState,
    unverified: !headless && !!usageInfo?.snapshot && !!usageInfo.error,
    headless,
    maxWindows,
    expectedWindows: agentId === 'claude'
      ? [{ key: 'session', shortLabel: 'S' }, { key: 'week', shortLabel: 'W' }]
      : undefined,
    errorKind: classifyUsageErrorKind(usageInfo?.error),
    errorDetail: usageInfo?.error ?? null,
    benignState,
    noRecentUsageLabel: agentId === 'grok'
      ? `run grok${version ? `@${version}` : ''} once to refresh usage`
      : null,
  };
}

function formatUsageErrorKindLabel(
  kind: UsageErrorKind | null | undefined,
  detail: string | null | undefined,
): string {
  switch (kind) {
    case 'no-credential':
      return 'sign in / provision token';
    case 'no-usage-credential':
      return USAGE_NO_USAGE_CREDENTIAL_MARKER;
    case 'headless-scope':
      return USAGE_HEADLESS_SCOPE_MARKER;
    case 'expired-credential':
      if (detail?.includes('run Kimi once')) return 'run Kimi once';
      return 're-auth for usage';
    case 'not-collected':
      return 'usage pending';
    case 'rate-limited': {
      const retryHint = detail?.match(/not retrying for (.+)\.$/)?.[1] ?? null;
      return retryHint ? `rate-limited (retry ~${retryHint})` : 'rate-limited';
    }
    case 'rejected':
    case 'unreachable':
    case null:
    case undefined:
    default:
      return 'usage unavailable';
  }
}

export function formatUsageSummary(
  plan: string | null,
  snapshot: UsageSnapshot | null,
  planWidth = 3,
  opts?: FormatUsageSummaryOpts
): string {
  const parts: string[] = [];

  if (plan) {
    parts.push(chalk.gray(plan.padEnd(planWidth)));
  }

  if (snapshot) {
    const blocked = snapshot.unavailable?.reason === 'out_of_credits'
      ? chalk.red('out of credits')
      : snapshot.unavailable?.reason === 'session_limit' && snapshot.unavailable.resetsAt
        ? chalk.yellow(`session-limited (${formatResetHint(snapshot.unavailable.resetsAt)})`)
        : null;
    const selected = pickCompactUsageWindows(snapshot.windows, opts?.maxWindows);
    const hidden = Math.max(
      0,
      snapshot.windows.filter((w) => w.key !== 'sonnet_week').length - selected.length,
    );
    const now = new Date();
    const staleWindows = snapshot.staleWindows ?? [];
    const staleByKey = new Map(staleWindows.map((w) => [w.key, w]));
    const expected = opts?.expectedWindows;
    const windowsToRender = expected
      ? expected.map(({ key, shortLabel }) => ({ key, window: selected.find((item) => item.key === key), shortLabel }))
      : selected.map((window) => ({ key: window.key, window, shortLabel: window.shortLabel }));
    const windowParts = windowsToRender.map(({ key, window, shortLabel }, index) => {
      if (!window) {
        const stale = staleByKey.get(key as UsageWindowKey);
        const rendered = stale
          ? renderStaleUsageWindow(stale, snapshot.capturedAt, shortLabel, now)
          : chalk.dim(`${shortLabel}: ${NO_DATA.repeat(COMPACT_BAR_LEN)} unavailable`);
        return index < windowsToRender.length - 1 ? padToWidth(rendered, 20) : rendered;
      }
      const bar = renderCompactUsageBar(window.usedPercent);
      const pct = colorUsage(`${Math.round(window.usedPercent)}%`, window.usedPercent);
      const reset = window.resetsAt ? chalk.dim(` (${formatResetHint(window.resetsAt)})`) : '';
      const rendered = `${chalk.gray(`${shortLabel}:`)} ${bar} ${pct}${reset}`;
      return index < windowsToRender.length - 1 ? padToWidth(rendered, 20) : rendered;
    });
    if (hidden > 0) {
      windowParts.push(chalk.dim(`+${hidden}`));
    }
    if (windowParts.length > 0) {
      parts.push(windowParts.join('  '));
    } else if (staleWindows.length > 0) {
      const cap = opts?.maxWindows ?? staleWindows.length;
      const rendered = staleWindows
        .slice(0, cap)
        .map((w) => renderStaleUsageWindow(w, snapshot.capturedAt, w.shortLabel, now));
      parts.push(rendered.join('  '));
    } else if (snapshot.refreshHint) {
      parts.push(chalk.dim(snapshot.refreshHint));
    }
    if (opts?.headless) {
      parts.push(chalk.dim(USAGE_HEADLESS_SCOPE_MARKER));
    } else if (opts?.unverified) {
      parts.push(chalk.yellow('unverified'));
    }
    if (blocked) parts.push(blocked);
  } else if (opts?.headless) {
    parts.push(chalk.dim(USAGE_HEADLESS_SCOPE_MARKER));
  } else if (opts?.benignState === 'no-recent-usage') {
    parts.push(chalk.dim(opts.noRecentUsageLabel || USAGE_NO_RECENT_USAGE_MARKER));
  } else if (opts?.unavailable) {
    parts.push(chalk.dim(formatUsageErrorKindLabel(opts.errorKind, opts.errorDetail)));
  }

  return parts.join('  ');
}

export function liveUsageWindows(snapshot: UsageSnapshot, now: number = Date.now()): UsageWindow[] {
  return snapshot.windows.filter((window) => !(window.resetsAt && window.resetsAt.getTime() <= now));
}

export function deriveUsageStatusFromSnapshot(
  snapshot: UsageSnapshot | null | undefined,
  now: number = Date.now(),
): 'available' | 'rate_limited' | null {
  if (!snapshot) return null;
  if (snapshot.unavailable) {
    if (snapshot.unavailable.reason === 'out_of_credits') return 'rate_limited';
    if (snapshot.unavailable.resetsAt && snapshot.unavailable.resetsAt.getTime() > now) {
      return 'rate_limited';
    }
  }
  if (snapshot.windows.length === 0) return null;
  const live = liveUsageWindows(snapshot, now);
  if (live.length === 0) return 'available';
  const blocking = live.filter((window) => window.key !== 'sonnet_week');
  const windows = blocking.length > 0 ? blocking : live;
  const maxUsed = Math.max(...windows.map((window) => window.usedPercent));
  return maxUsed >= 100 ? 'rate_limited' : 'available';
}

interface UsagePriorSample {
  capturedAt: number;
  usedPercent: number;
}

export interface UsageHeadroom {
  status: 'available' | 'rate_limited' | null;
  minutesToLimit: number | null;
}

export function deriveUsageHeadroom(
  snapshot: UsageSnapshot | null | undefined,
  prev?: UsagePriorSample | null,
): UsageHeadroom {
  const status = deriveUsageStatusFromSnapshot(snapshot);
  if (!snapshot || status === null) return { status, minutesToLimit: null };
  if (status === 'rate_limited') return { status, minutesToLimit: 0 };

  const session = snapshot.windows.find((window) => window.key === 'session');
  const capturedAt = snapshot.capturedAt?.getTime();
  if (!session || capturedAt === undefined || !prev) {
    return { status, minutesToLimit: null };
  }

  const deltaPercent = session.usedPercent - prev.usedPercent;
  const deltaMinutes = (capturedAt - prev.capturedAt) / 60_000;
  if (deltaPercent <= 0 || deltaMinutes <= 0) return { status, minutesToLimit: null };

  const burnPerMinute = deltaPercent / deltaMinutes;
  const remaining = Math.max(0, 100 - session.usedPercent);
  return { status, minutesToLimit: remaining / burnPerMinute };
}

export function formatUsageStatusBadge(
  usageStatus: 'available' | 'rate_limited' | 'out_of_credits' | null | undefined
): string {
  if (usageStatus === null || usageStatus === undefined) return '';
  switch (usageStatus) {
    case 'available':       return '';
    case 'out_of_credits':  return chalk.red('out of credits');
    case 'rate_limited':    return chalk.yellow('rate-limited');
    default: {
      const _exhaustive: never = usageStatus;
      void _exhaustive;
      return '';
    }
  }
}

export function formatUsageSection(usage: UsageInfo): string[] {
  if (!usage.snapshot && !usage.error) {
    return [];
  }

  const lines = ['  Usage', ''];

  if (!usage.snapshot) {
    lines.push(`    ${chalk.dim(usage.error || 'Usage data unavailable right now.')}`);
    return lines;
  }

  const labelWidth = usage.snapshot.windows.reduce((max, window) => Math.max(max, window.label.length), 0);
  for (const window of usage.snapshot.windows) {
    const bar = renderUsageBar(window.usedPercent);
    lines.push(`    ${chalk.bold(window.label.padEnd(labelWidth))}  ${bar} ${formatPercent(window.usedPercent)}% used`);
    if (window.resetsAt) {
      lines.push(`    ${chalk.dim(`Resets ${formatResetAt(window.resetsAt)}`)}`);
    }
    lines.push('');
  }

  if (lines[lines.length - 1] === '') {
    lines.pop();
  }
  lines.push(`    ${chalk.dim(`Source: ${usage.snapshot.sourceLabel}`)}`);
  return lines;
}

async function getCodexUsageInfo(options?: UsageOptions): Promise<UsageInfo> {
  try {
    const base = options?.home || os.homedir();
    let sinceMs: number | undefined;
    try {
      const tokens = (
        JSON.parse(fs.readFileSync(path.join(base, '.codex', 'auth.json'), 'utf-8')) as {
          tokens?: { id_token?: string; access_token?: string };
        }
      ).tokens;
      const authTime = decodeJwtPayload(tokens?.id_token || tokens?.access_token || '')?.auth_time;
      if (typeof authTime === 'number' && authTime > 0) sinceMs = authTime * 1000;
    } catch {
      return { snapshot: null, error: null };
    }

    const files = collectCodexSessionFiles(options?.home, sinceMs);
    const now = new Date();
    for (const filePath of files) {
      const match = await readLatestCodexRateLimits(filePath);
      if (!match) continue;

      const windows = normalizeCodexWindows(match.rateLimits).filter((window) =>
        isCachedUsageWindowFresh(window, match.capturedAt, now)
      );
      if (windows.length === 0) continue;

      return {
        snapshot: {
          source: 'last_seen',
          sourceLabel: 'last seen in latest Codex session',
          capturedAt: match.capturedAt,
          windows,
        },
        error: null,
      };
    }

    return usageNoRecentUsageInfo();
  } catch (err) {
    return { snapshot: null, error: usageUnreachableError('Codex', err) };
  }
}

export function claudeUsageAccessTokenNoRefresh(
  oauth: Pick<ClaudeOauthCredentials, 'accessToken' | 'expiresAt'>,
): string | null {
  if (claudeAccessTokenNeedsRefresh(oauth.expiresAt ?? null)) return null;
  const token = oauth.accessToken?.trim();
  return token ? token : null;
}

async function getClaudeUsageInfo(options?: UsageOptions): Promise<UsageInfo> {
  try {
    const oauth = await loadClaudeOauth(options?.home, {
      accessTokenCache: options?.nativeFileLogin !== true,
      fileOnly: options?.fileOnly === true || options?.nativeFileLogin === true,
      allowInteractiveLogin: options?.allowInteractiveLogin === true,
      nativeFileLogin: options?.nativeFileLogin === true,
    });
    if (!oauth?.accessToken) {
      return { snapshot: null, error: usageNoClaudeUsageCredentialError() };
    }

    const requestedOrgId = normalizeString(options?.organizationId);
    const liveOrgId = normalizeString(oauth.organizationUuid);
    if (!isClaudeUsageOrgMatch(requestedOrgId, liveOrgId)) {
      return { snapshot: null, error: null };
    }

    const accessToken = claudeUsageAccessTokenNoRefresh(oauth);
    if (!accessToken) {
      return { snapshot: null, error: usageExpiredCredentialError('Claude') };
    }

    const throttledUntil = usageRateLimitedUntil('claude', Date.now(), options?.usageScope);
    if (throttledUntil) {
      return { snapshot: null, error: usageThrottledError('Claude', throttledUntil) };
    }

    const response = await fetch(CLAUDE_USAGE_URL, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        'anthropic-beta': CLAUDE_OAUTH_BETA_HEADER,
        'User-Agent': getClaudeUserAgent(options?.cliVersion),
      },
      signal: usageFetchSignal(options?.signal, 5000),
    });

    if (!response.ok) {
      if (response.status === 429) {
        noteUsageRateLimited('claude', response.headers.get('retry-after'), { account: options?.usageScope });
      }
      if (response.status === 403) {
        let bodyText = '';
        try {
          bodyText = await response.text();
        } catch {
        }
        if (isClaudeUsageScopeDenied(response.status, bodyText)) {
          return { snapshot: null, error: usageHeadlessScopeError('Claude') };
        }
      }
      return { snapshot: null, error: usageRejectedError('Claude', response.status) };
    }
    const data = await response.json() as ClaudeUsageResponse;
    const windows = normalizeClaudeWindows(data);
    if (windows.length === 0) {
      return { snapshot: null, error: null };
    }

    return {
      snapshot: {
        source: 'live',
        sourceLabel: 'live account data',
        capturedAt: new Date(),
        windows,
      },
      error: null,
    };
  } catch (err) {
    return { snapshot: null, error: usageUnreachableError('Claude', err) };
  }
}

interface KimiUsageQuota {
  limit?: string | number | null;
  used?: string | number | null;
  remaining?: string | number | null;
  resetTime?: string | null;
}

export interface KimiUsagesResponse {
  user?: { userId?: string | null; membership?: { level?: string | null } | null } | null;
  usage?: KimiUsageQuota | null;
  limits?: Array<{
    window?: { duration?: number | null; timeUnit?: string | null } | null;
    detail?: KimiUsageQuota | null;
  } | null> | null;
  subType?: string | null;
}

function resolveKimiCredentialPath(home?: string): string | null {
  const rel = ['.kimi-code', 'credentials', 'kimi-code.json'];
  const perVersion = path.join(home || os.homedir(), ...rel);
  try { if (fs.existsSync(perVersion)) return perVersion; } catch {  }
  const active = path.join(process.env.AGENTS_REAL_HOME || os.homedir(), ...rel);
  if (active !== perVersion) {
    try { if (fs.existsSync(active)) return active; } catch {  }
  }
  return null;
}

/**
 * Fetch Kimi usage via the Kimi Code /usages API. Kimi's JWT has no email
 * claim, so the account row can't show an address — but /usages returns quota
 * windows and the membership tier, which is what we render.
 *
 * Deliberately NO token refresh: `agents view` is a read/inspect command and
 * must not rotate the user's Kimi OAuth credential (rewriting the file,
 * invalidating the old refresh token, racing a concurrently-running kimi CLI).
 * The kimi CLI refreshes on its own launch; if the stored token is expired we
 * skip the live fetch and let the SWR cache serve the last-seen snapshot.
 */
async function getKimiUsageInfo(options?: UsageOptions): Promise<UsageInfo> {
  try {
    const credPath = resolveKimiCredentialPath(options?.home);
    if (!credPath) return { snapshot: null, error: usageNoCredentialError('Kimi') };

    const cred = JSON.parse(fs.readFileSync(credPath, 'utf-8'));
    const accessToken = cred?.access_token;
    if (typeof accessToken !== 'string' || !accessToken) {
      return { snapshot: null, error: usageNoCredentialError('Kimi') };
    }

    const expiresAt = typeof cred?.expires_at === 'number' ? cred.expires_at : null;
    if (expiresAt !== null && Date.now() / 1000 >= expiresAt) {
      return { snapshot: null, error: usageExpiredKimiCredentialError() };
    }

    const throttledUntil = usageRateLimitedUntil('kimi', Date.now(), options?.usageScope);
    if (throttledUntil) {
      return { snapshot: null, error: usageThrottledError('Kimi', throttledUntil) };
    }

    const response = await fetch(KIMI_USAGES_URL, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: 'application/json',
      },
      signal: usageFetchSignal(options?.signal, 5000),
    });

    if (!response.ok) {
      if (response.status === 429) {
        noteUsageRateLimited('kimi', response.headers.get('retry-after'), { account: options?.usageScope });
      }
      return { snapshot: null, error: usageRejectedError('Kimi', response.status) };
    }
    const data = await response.json() as KimiUsagesResponse;
    const windows = normalizeKimiWindows(data);
    if (windows.length === 0) {
      return { snapshot: null, error: null };
    }

    return {
      snapshot: {
        source: 'live',
        sourceLabel: 'live account data',
        capturedAt: new Date(),
        windows,
        plan: formatKimiPlan(data),
      },
      error: null,
    };
  } catch (err) {
    return { snapshot: null, error: usageUnreachableError('Kimi', err) };
  }
}

export function normalizeKimiWindows(data: KimiUsagesResponse): UsageWindow[] {
  const windows: UsageWindow[] = [];

  const shortLimit = Array.isArray(data.limits)
    ? data.limits.find((entry) => entry?.detail)
    : null;
  const session = normalizeKimiWindow(
    shortLimit?.detail,
    'session',
    'Current session',
    'S',
    kimiWindowMinutes(shortLimit?.window)
  );
  if (session) windows.push(session);

  const period = normalizeKimiWindow(data.usage, 'week', 'Current period', 'W', null);
  if (period) windows.push(period);

  return windows;
}

function normalizeKimiWindow(
  quota: KimiUsageQuota | null | undefined,
  key: UsageWindowKey,
  label: string,
  shortLabel: string,
  windowMinutes: number | null
): UsageWindow | null {
  const limit = kimiNumber(quota?.limit);
  const used = kimiNumber(quota?.used);
  if (limit === null || used === null || limit <= 0) return null;

  const usedPercent = normalizePercent((used / limit) * 100);
  if (usedPercent === null) return null;

  return {
    key,
    label,
    shortLabel,
    usedPercent,
    resetsAt: parseDateValue(quota?.resetTime),
    windowMinutes: windowMinutes ?? inferWindowMinutes(key),
  };
}

function kimiNumber(value: string | number | null | undefined): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '' && !Number.isNaN(Number(value))) {
    return Number(value);
  }
  return null;
}

function kimiWindowMinutes(
  window: { duration?: number | null; timeUnit?: string | null } | null | undefined
): number | null {
  const duration = typeof window?.duration === 'number' ? window.duration : null;
  if (duration === null || duration <= 0) return null;
  switch (window?.timeUnit) {
    case 'TIME_UNIT_HOUR': return duration * 60;
    case 'TIME_UNIT_SECOND': return duration / 60;
    default: return duration;
  }
}

export function formatKimiPlan(data: KimiUsagesResponse): string | null {
  const level = data.user?.membership?.level;
  const raw = (typeof level === 'string' && level) || (typeof data.subType === 'string' && data.subType) || '';
  const tail = raw.split('_').pop() || '';
  if (!tail) return null;
  return tail.charAt(0).toUpperCase() + tail.slice(1).toLowerCase();
}

interface DroidLimitWindow {
  usedPercent?: number | null;
  windowEnd?: string | null;
}

export interface DroidBillingLimitsResponse {
  usesTokenRateLimitsBilling?: boolean | null;
  limits?: {
    standard?: {
      fiveHour?: DroidLimitWindow | null;
      weekly?: DroidLimitWindow | null;
      monthly?: DroidLimitWindow | null;
    } | null;
  } | null;
}

/**
 * Fetch Droid usage via Factory.ai's billing limits API — the same endpoint the
 * droid CLI polls for its token-limit banner. The WorkOS access token comes
 * from the locally decrypted ~/.factory/auth.v2.file (the same credential
 * account identity in agents.ts reads).
 *
 * Deliberately NO token refresh, for a sharper reason than Kimi's: WorkOS
 * refresh tokens are single-use and rotate on every exchange, so refreshing
 * here would race a concurrently running droid session and can permanently
 * invalidate the user's login chain. Droid refreshes its own credential when
 * it runs; if the stored token is expired we skip the live fetch and let the
 * SWR cache serve the last-seen snapshot. This same single-use-rotation property
 * is why `agents apply` refuses to propagate droid credentials across machines
 * (see `isCredentialSafeToPropagate` in `../fleet/auth-sync.ts`).
 */
async function getDroidUsageInfo(options?: UsageOptions): Promise<UsageInfo> {
  try {
    const cred = decryptDroidAuthPayload(options?.home || os.homedir());
    const accessToken = cred?.access_token;
    if (typeof accessToken !== 'string' || !accessToken) {
      return { snapshot: null, error: usageNoCredentialError('Droid') };
    }

    const exp = decodeJwtPayload(accessToken)?.exp;
    if (typeof exp === 'number' && Date.now() / 1000 >= exp) {
      return { snapshot: null, error: usageExpiredCredentialError('Droid') };
    }

    const throttledUntil = usageRateLimitedUntil('droid', Date.now(), options?.usageScope);
    if (throttledUntil) {
      return { snapshot: null, error: usageThrottledError('Droid', throttledUntil) };
    }

    const response = await fetch(DROID_USAGE_URL, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: 'application/json',
      },
      signal: usageFetchSignal(options?.signal, 5000),
    });

    if (!response.ok) {
      if (response.status === 429) {
        noteUsageRateLimited('droid', response.headers.get('retry-after'), { account: options?.usageScope });
      }
      return { snapshot: null, error: usageRejectedError('Droid', response.status) };
    }
    const data = await response.json() as DroidBillingLimitsResponse;
    const windows = normalizeDroidWindows(data);
    if (windows.length === 0) {
      return { snapshot: null, error: null };
    }

    return {
      snapshot: {
        source: 'live',
        sourceLabel: 'live account data',
        capturedAt: new Date(),
        windows,
      },
      error: null,
    };
  } catch (err) {
    return { snapshot: null, error: usageUnreachableError('Droid', err) };
  }
}

export interface ProviderProbe {
  status: number | null;
  token: 'present' | 'missing' | 'expired';
  error?: string;
  /**
   * Known non-revocation cause for a non-2xx status.
   * `usage_scope` — Anthropic returned 403 because the setup-token lacks
   * `user:profile` (RUSH-2392). Token is valid for inference; usage is unreadable.
   * Auth-health MUST NOT map this to `revoked`.
   */
  reason?: 'usage_scope';
}

export async function probeClaudeStatus(home?: string, cliVersion?: string | null, usageScope?: string | null, signal?: AbortSignal): Promise<ProviderProbe> {
  const oauth = await loadClaudeOauth(home, { accessTokenCache: true });
  const accessToken = oauth?.accessToken?.trim();
  if (!accessToken) return { status: null, token: 'missing' };
  if (claudeAccessTokenNeedsRefresh(oauth?.expiresAt ?? null)) {
    return { status: null, token: 'expired' };
  }
  if (usageRateLimitedUntil('claude', Date.now(), usageScope)) return { status: 429, token: 'present' };
  try {
    const response = await fetch(CLAUDE_USAGE_URL, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        'anthropic-beta': CLAUDE_OAUTH_BETA_HEADER,
        'User-Agent': getClaudeUserAgent(cliVersion),
      },
      signal: usageFetchSignal(signal, 8000),
    });
    if (response.status === 429) {
      noteUsageRateLimited('claude', response.headers.get('retry-after'), { account: usageScope });
    }
    if (response.status === 403) {
      let bodyText = '';
      try {
        bodyText = await response.text();
      } catch {
      }
      if (isClaudeUsageScopeDenied(response.status, bodyText)) {
        return {
          status: 403,
          token: 'present',
          reason: 'usage_scope',
          error: USAGE_HEADLESS_SCOPE_MARKER,
        };
      }
    }
    return { status: response.status, token: 'present' };
  } catch (err) {
    return { status: null, token: 'present', error: err instanceof Error ? err.message : String(err) };
  }
}

export async function probeKimiStatus(home?: string, usageScope?: string | null, signal?: AbortSignal): Promise<ProviderProbe> {
  const credPath = resolveKimiCredentialPath(home);
  if (!credPath) return { status: null, token: 'missing' };
  let accessToken: string | undefined;
  let expiresAt: number | null = null;
  try {
    const cred = JSON.parse(fs.readFileSync(credPath, 'utf-8'));
    accessToken = typeof cred?.access_token === 'string' ? cred.access_token : undefined;
    expiresAt = typeof cred?.expires_at === 'number' ? cred.expires_at : null;
  } catch {
    return { status: null, token: 'missing' };
  }
  if (!accessToken) return { status: null, token: 'missing' };
  if (expiresAt !== null && Date.now() / 1000 >= expiresAt) return { status: null, token: 'expired' };
  if (usageRateLimitedUntil('kimi', Date.now(), usageScope)) return { status: 429, token: 'present' };
  try {
    const response = await fetch(KIMI_USAGES_URL, {
      method: 'GET',
      headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
      signal: usageFetchSignal(signal, 8000),
    });
    if (response.status === 429) {
      noteUsageRateLimited('kimi', response.headers.get('retry-after'), { account: usageScope });
    }
    return { status: response.status, token: 'present' };
  } catch (err) {
    return { status: null, token: 'present', error: err instanceof Error ? err.message : String(err) };
  }
}

export async function probeDroidStatus(home?: string, usageScope?: string | null, signal?: AbortSignal): Promise<ProviderProbe> {
  const cred = decryptDroidAuthPayload(home || os.homedir());
  const accessToken = cred?.access_token;
  if (typeof accessToken !== 'string' || !accessToken) return { status: null, token: 'missing' };
  const exp = decodeJwtPayload(accessToken)?.exp;
  if (typeof exp === 'number' && Date.now() / 1000 >= exp) return { status: null, token: 'expired' };
  if (usageRateLimitedUntil('droid', Date.now(), usageScope)) return { status: 429, token: 'present' };
  try {
    const response = await fetch(DROID_USAGE_URL, {
      method: 'GET',
      headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
      signal: usageFetchSignal(signal, 8000),
    });
    if (response.status === 429) {
      noteUsageRateLimited('droid', response.headers.get('retry-after'), { account: usageScope });
    }
    return { status: response.status, token: 'present' };
  } catch (err) {
    return { status: null, token: 'present', error: err instanceof Error ? err.message : String(err) };
  }
}

export function normalizeDroidWindows(data: DroidBillingLimitsResponse): UsageWindow[] {
  if (data.usesTokenRateLimitsBilling !== true) return [];
  const standard = data.limits?.standard;
  if (!standard) return [];

  const windows = [
    normalizeDroidWindow(standard.fiveHour, 'session', 'Current session', 'S'),
    normalizeDroidWindow(standard.weekly, 'week', 'Current week', 'W'),
    normalizeDroidWindow(standard.monthly, 'month', 'Current month', 'M'),
  ];

  return windows.filter((window): window is UsageWindow => window !== null);
}

function normalizeDroidWindow(
  window: DroidLimitWindow | null | undefined,
  key: UsageWindowKey,
  label: string,
  shortLabel: string
): UsageWindow | null {
  const usedPercent = normalizePercent(window?.usedPercent);
  if (usedPercent === null) return null;

  return {
    key,
    label,
    shortLabel,
    usedPercent,
    resetsAt: parseDateValue(window?.windowEnd),
    windowMinutes: inferWindowMinutes(key),
  };
}

function collectCodexSessionFiles(home?: string, sinceMs?: number): string[] {
  const base = home || os.homedir();
  const dir = path.join(base, '.codex', 'sessions');
  if (!fs.existsSync(dir)) return [];

  const seenFiles = new Set<string>();
  const files: Array<{ path: string; mtime: number }> = [];
  for (const filePath of walkForFiles(dir, '.jsonl', 20)) {
    const real = safeRealpathSync(filePath) || filePath;
    if (seenFiles.has(real)) continue;
    seenFiles.add(real);
    const stat = safeStatSync(filePath);
    if (!stat) continue;
    if (sinceMs !== undefined && stat.mtimeMs < sinceMs) continue;
    files.push({ path: filePath, mtime: stat.mtimeMs });
  }

  files.sort((a, b) => b.mtime - a.mtime);
  return files.map((file) => file.path);
}

async function readLatestCodexRateLimits(filePath: string): Promise<CodexRateLimitMatch | null> {
  return new Promise((resolve) => {
    let latest: CodexRateLimitMatch | null = null;
    const stream = fs.createReadStream(filePath, { encoding: 'utf-8' });
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

    rl.on('line', (line) => {
      if (!line.trim()) return;
      try {
        const parsed = JSON.parse(line);
        if (parsed.type !== 'event_msg' || parsed.payload?.type !== 'token_count' || !parsed.payload?.rate_limits) {
          return;
        }

        latest = {
          capturedAt: parseDateValue(parsed.timestamp),
          rateLimits: parsed.payload.rate_limits as CodexRateLimits,
        };
      } catch {
      }
    });

    rl.on('close', () => resolve(latest));
    rl.on('error', () => resolve(latest));
  });
}

function normalizeCodexWindows(rateLimits: CodexRateLimits): UsageWindow[] {
  return [rateLimits.primary, rateLimits.secondary]
    .map(normalizeCodexWindow)
    .filter((window): window is UsageWindow => window !== null)
    .sort((a, b) => (a.windowMinutes ?? 0) - (b.windowMinutes ?? 0));
}

function normalizeCodexWindow(window: CodexRateLimitWindow | null | undefined): UsageWindow | null {
  const usedPercent = normalizePercent(window?.used_percent);
  if (usedPercent === null) return null;

  const windowMinutes = normalizeWindowMinutes(window?.window_minutes);
  const { key, label, shortLabel } = classifyCodexWindow(windowMinutes);

  return {
    key,
    label,
    shortLabel,
    usedPercent,
    resetsAt: parseDateValue(window?.resets_at),
    windowMinutes,
  };
}

function classifyCodexWindow(windowMinutes: number | null): Pick<UsageWindow, 'key' | 'label' | 'shortLabel'> {
  if (windowMinutes !== null && windowMinutes >= 28 * 24 * 60) {
    return { key: 'month', label: 'Current month', shortLabel: 'M' };
  }
  if (windowMinutes !== null && windowMinutes >= 7 * 24 * 60) {
    return { key: 'week', label: 'Current week', shortLabel: 'W' };
  }
  return { key: 'session', label: 'Current session', shortLabel: 'S' };
}

function normalizeClaudeWindows(data: ClaudeUsageResponse): UsageWindow[] {
  const windows = [
    normalizeClaudeWindow(data.five_hour, 'session', 'Current session', 'S'),
    normalizeClaudeWindow(data.seven_day, 'week', 'Current week (all models)', 'W'),
    normalizeClaudeWindow(data.seven_day_sonnet, 'sonnet_week', 'Current week (Sonnet only)', 'So'),
  ];

  return windows.filter((window): window is UsageWindow => window !== null);
}

function normalizeClaudeWindow(
  window: ClaudeUsageWindow | null | undefined,
  key: UsageWindowKey,
  label: string,
  shortLabel: string
): UsageWindow | null {
  const usedPercent = normalizePercent(window?.utilization);
  if (usedPercent === null) return null;

  return {
    key,
    label,
    shortLabel,
    usedPercent,
    resetsAt: parseDateValue(window?.resets_at),
    windowMinutes: inferWindowMinutes(key),
  };
}

function parseClaudeOauthPayload(raw: string): ClaudeOauthCredentials | null {
  try {
    const payload = JSON.parse(raw.trim()) as ClaudeKeychainPayload;
    if (!payload?.claudeAiOauth || typeof payload.claudeAiOauth.accessToken !== 'string') {
      return null;
    }
    return {
      ...payload.claudeAiOauth,
      organizationUuid: normalizeString(payload.organizationUuid),
    };
  } catch {
    return null;
  }
}

const CLAUDE_OAUTH_CACHE_PREFIX = 'agents-cli.claude-oauth-cache.';

function claudeOauthCacheItem(service: string): string {
  const hash = createHash('sha256').update(service).digest('hex').slice(0, 16);
  return `${CLAUDE_OAUTH_CACHE_PREFIX}${hash}`;
}

function deleteCachedClaudeOauth(service: string): void {
  try {
    deleteKeychainTokenSync(claudeOauthCacheItem(service));
  } catch {
  }
}

export function claudeHomeHasNativeOauthFile(home?: string): boolean {
  return readClaudeNativeCredentialsFile(home) !== null;
}

function readClaudeNativeCredentialsFile(home?: string): ClaudeOauthCredentials | null {
  const credsPath = path.join(home ?? os.homedir(), '.claude', '.credentials.json');
  try {
    if (!fs.existsSync(credsPath)) return null;
    const parsed = parseClaudeOauthPayload(fs.readFileSync(credsPath, 'utf-8'));
    if (!parsed?.accessToken?.trim() || !parsed.refreshToken?.trim()) return null;
    return parsed;
  } catch {
    return null;
  }
}

export async function loadClaudeOauth(
  home?: string,
  opts?: { accessTokenCache?: boolean; fileOnly?: boolean; allowInteractiveLogin?: boolean; nativeFileLogin?: boolean }
): Promise<ClaudeOauthCredentials | null> {
  if (opts?.nativeFileLogin === true) {
    return readClaudeNativeCredentialsFile(home);
  }
  if (opts?.accessTokenCache === true) {
    const setupToken = resolveClaudeSetupToken(home);
    if (setupToken) {
      return { accessToken: setupToken };
    }
    if (opts?.allowInteractiveLogin !== true) {
      return null;
    }
  }

  if (!opts?.fileOnly && (process.platform === 'darwin' || process.platform === 'linux')) {
    const service = getClaudeKeychainService(home);
    try {
      const fromKeychain = parseClaudeOauthPayload(getKeychainTokenSync(service));
      if (fromKeychain) return fromKeychain;
    } catch {
    }
  }

  const credsPath = path.join(home ?? os.homedir(), '.claude', '.credentials.json');
  try {
    if (fs.existsSync(credsPath)) {
      return parseClaudeOauthPayload(fs.readFileSync(credsPath, 'utf-8'));
    }
  } catch {
  }
  return null;
}

async function saveClaudeOauth(
  home: string | undefined,
  credentials: ClaudeOauthCredentials
): Promise<boolean> {
  if (process.platform !== 'darwin' && process.platform !== 'linux') {
    return false;
  }

  try {
    const service = getClaudeKeychainService(home);

    let existingPayload: ClaudeKeychainPayload = {};
    try {
      const stdout = getKeychainTokenSync(service);
      existingPayload = JSON.parse(stdout.trim()) as ClaudeKeychainPayload;
    } catch {
    }

    const newPayload: ClaudeKeychainPayload = {
      ...existingPayload,
      claudeAiOauth: {
        ...existingPayload.claudeAiOauth,
        accessToken: credentials.accessToken,
        refreshToken: credentials.refreshToken,
        expiresAt: credentials.expiresAt,
        scopes: credentials.scopes ?? existingPayload.claudeAiOauth?.scopes,
      },
    };

    const payloadJson = JSON.stringify(newPayload);

    try {
      await deleteKeychainToken(service);
    } catch {
    }

    await setKeychainToken(service, payloadJson);
    deleteCachedClaudeOauth(service);
    return true;
  } catch {
    return false;
  }
}

export function getClaudeKeychainService(home?: string): string {
  if (!home) {
    return CLAUDE_KEYCHAIN_SERVICE;
  }

  const configDir = path.join(home, '.claude').normalize('NFC');
  const hash = createHash('sha256').update(configDir).digest('hex').slice(0, 8);
  return `${CLAUDE_KEYCHAIN_SERVICE}-${hash}`;
}

export function isClaudeUsageOrgMatch(
  requestedOrgId: string | null | undefined,
  liveOrgId: string | null | undefined
): boolean {
  const requested = normalizeString(requestedOrgId);
  const live = normalizeString(liveOrgId);
  return !requested || !live || requested === live;
}

export function readClaudeUsageCache(
  usageKey: string,
  cachePath = getClaudeUsageCachePath(),
  now = new Date()
): UsageSnapshot | null {
  const cache = readClaudeUsageCacheFile(cachePath);
  const cached = cache[usageKey];
  if (!cached) {
    return null;
  }

  const snapshot = deserializeClaudeUsageSnapshot(cached, now);
  if (!snapshot) {
    pruneExpiredClaudeUsageCacheEntry(usageKey, cachePath, now);
  }
  return snapshot;
}

export function pruneExpiredClaudeUsageCacheEntry(
  usageKey: string,
  cachePath = getClaudeUsageCachePath(),
  now = new Date(),
): void {
  try {
    ensureLockTarget(cachePath, '{}');
    withFileLock(cachePath, () => {
      const latest = readClaudeUsageCacheFile(cachePath);
      const current = latest[usageKey];
      if (!current || deserializeClaudeUsageSnapshot(current, now)) return;
      delete latest[usageKey];
      atomicWriteFileSync(cachePath, JSON.stringify(latest, null, 2), 'utf-8');
    });
  } catch {
  }
}

export function writeClaudeUsageCache(
  usageKey: string,
  snapshot: UsageSnapshot,
  cachePath = getClaudeUsageCachePath()
): void {
  try {
    ensureLockTarget(cachePath, '{}');
    withFileLock(cachePath, () => {
      const cache = readClaudeUsageCacheFile(cachePath);
      const prior = cache[usageKey];
      cache[usageKey] = {
        ...serializeClaudeUsageSnapshot({
          ...snapshot,
          unavailable: carryForwardUnavailable(prior?.unavailable, snapshot.unavailable),
        }),
        modelRefusals: prior?.modelRefusals,
      };
      atomicWriteFileSync(cachePath, JSON.stringify(cache, null, 2), 'utf-8');
    });
  } catch {
  }
}

export function mergeClaudeUsageCacheWindows(
  usageKey: string,
  snapshot: UsageSnapshot,
  cachePath = getClaudeUsageCachePath(),
): void {
  try {
    ensureLockTarget(cachePath, '{}');
    withFileLock(cachePath, () => {
      const cache = readClaudeUsageCacheFile(cachePath);
      const prior = cache[usageKey];
      const priorSnapshot = prior
        ? deserializeClaudeUsageSnapshot(prior, snapshot.capturedAt ?? new Date())
        : null;
      const windows = new Map(
        priorSnapshot?.windows.map((window) => [window.key, window]) ?? [],
      );
      for (const window of snapshot.windows) windows.set(window.key, window);
      cache[usageKey] = {
        ...serializeClaudeUsageSnapshot({
          ...snapshot,
          windows: [...windows.values()],
          plan: snapshot.plan ?? priorSnapshot?.plan ?? null,
          unavailable: carryForwardUnavailable(prior?.unavailable, snapshot.unavailable),
        }),
        modelRefusals: prior?.modelRefusals,
      };
      atomicWriteFileSync(cachePath, JSON.stringify(cache, null, 2), 'utf-8');
    });
  } catch {
  }
}

export function exportClaudeUsageCacheRows(
  cachePath = getClaudeUsageCachePath(),
): Record<string, CachedUsageSnapshot> {
  const cache = readClaudeUsageCacheFile(cachePath);
  const out: Record<string, CachedUsageSnapshot> = {};
  for (const [key, row] of Object.entries(cache)) {
    if (row && Array.isArray(row.windows) && row.windows.length > 0) out[key] = row;
  }
  return out;
}

function parseCapturedAtMs(capturedAt: string | null | undefined): number | null {
  if (!capturedAt) return null;
  const ms = Date.parse(capturedAt);
  return Number.isFinite(ms) ? ms : null;
}

export async function ingestPeerClaudeUsageRows(
  rows: Record<string, CachedUsageSnapshot>,
  cachePath = getClaudeUsageCachePath(),
): Promise<number> {
  const incoming = Object.entries(rows).filter(
    ([, row]) => row && Array.isArray(row.windows) && row.windows.length > 0,
  );
  if (incoming.length === 0) return 0;
  let merged = 0;
  try {
    ensureLockTarget(cachePath, '{}');
    await withFileLockAsync(cachePath, () => {
      const cache = readClaudeUsageCacheFile(cachePath);
      for (const [key, row] of incoming) {
        const prior = cache[key];
        if (prior) {
          const priorMs = parseCapturedAtMs(prior.capturedAt);
          const incomingMs = parseCapturedAtMs(row.capturedAt);
          if (incomingMs === null) continue;
          if (priorMs !== null && priorMs >= incomingMs) continue;
        }
        cache[key] = row;
        merged += 1;
      }
      if (merged > 0) writeClaudeUsageCacheFile(cache, cachePath);
    });
  } catch {
  }
  return merged;
}

function readClaudeUsageCacheFile(cachePath: string): Record<string, CachedUsageSnapshot> {
  if (!fs.existsSync(cachePath)) {
    return {};
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(cachePath, 'utf-8')) as Record<string, CachedUsageSnapshot>;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function writeClaudeUsageCacheFile(
  cache: Record<string, CachedUsageSnapshot>,
  cachePath: string
): void {
  try {
    fs.mkdirSync(path.dirname(cachePath), { recursive: true });
    atomicWriteFileSync(cachePath, JSON.stringify(cache, null, 2), 'utf-8');
  } catch {
  }
}

function serializeClaudeUsageSnapshot(snapshot: UsageSnapshot): CachedUsageSnapshot {
  const persistedWindows = [...snapshot.windows, ...(snapshot.staleWindows ?? [])];
  return {
    capturedAt: snapshot.capturedAt?.toISOString() || null,
    plan: snapshot.plan ?? null,
    refreshHint: snapshot.refreshHint ?? null,
    unavailable: snapshot.unavailable
      ? {
          reason: snapshot.unavailable.reason,
          resetsAt: snapshot.unavailable.resetsAt?.toISOString(),
        }
      : undefined,
    windows: persistedWindows.map((window) => ({
      key: window.key,
      label: window.label,
      shortLabel: window.shortLabel,
      usedPercent: window.usedPercent,
      resetsAt: window.resetsAt?.toISOString() || null,
      windowMinutes: window.windowMinutes,
    })),
    freshnessSource: snapshot.freshness?.source,
    pollerDevice: snapshot.freshness?.poller,
  };
}

function deserializeClaudeUsageSnapshot(
  snapshot: CachedUsageSnapshot,
  now: Date
): UsageSnapshot | null {
  const capturedAt = parseDateValue(snapshot.capturedAt);
  const deserialized = snapshot.windows.map((window) => ({
    key: window.key,
    label: window.label,
    shortLabel: window.shortLabel,
    usedPercent: window.usedPercent,
    resetsAt: parseDateValue(window.resetsAt),
    windowMinutes: window.windowMinutes,
  }));
  const windows = deserialized.filter((window) => isCachedUsageWindowFresh(window, capturedAt, now));
  const freshKeys = new Set(windows.map((window) => window.key));
  const staleWindows = deserialized.filter(
    (window) => !freshKeys.has(window.key) && !isCachedUsageWindowFresh(window, capturedAt, now),
  );

  const unavailable = deserializeUnavailable(snapshot.unavailable, now);

  if (
    windows.length === 0 &&
    staleWindows.length === 0 &&
    !unavailable &&
    !snapshot.plan &&
    !snapshot.refreshHint &&
    !hasLiveModelRefusal(snapshot.modelRefusals, now)
  ) {
    return null;
  }

  return {
    source: 'last_seen',
    sourceLabel: CACHED_CLAUDE_USAGE_SOURCE_LABEL,
    capturedAt,
    windows,
    staleWindows: staleWindows.length > 0 ? staleWindows : undefined,
    plan: snapshot.plan ?? null,
    refreshHint: snapshot.refreshHint ?? null,
    unavailable,
    freshness: snapshot.freshnessSource
      ? { source: snapshot.freshnessSource, poller: snapshot.pollerDevice }
      : undefined,
  };
}

function carryForwardUnavailable(
  prior: CachedUsageSnapshot['unavailable'],
  live: UsageSnapshot['unavailable'],
): UsageSnapshot['unavailable'] {
  if (live) return live;
  if (!prior) return undefined;
  if (prior.reason === 'out_of_credits') return { reason: 'out_of_credits' };
  const reset = parseDateValue(prior.resetsAt);
  return reset && reset.getTime() > Date.now()
    ? { reason: 'session_limit', resetsAt: reset }
    : undefined;
}

function deserializeUnavailable(
  cached: CachedUsageSnapshot['unavailable'],
  now: Date,
): UsageSnapshot['unavailable'] {
  if (!cached) return undefined;
  if (cached.reason === 'out_of_credits') return { reason: 'out_of_credits' };
  const reset = parseDateValue(cached.resetsAt);
  return reset && reset.getTime() > now.getTime()
    ? { reason: 'session_limit', resetsAt: reset }
    : undefined;
}

function hasLiveModelRefusal(
  modelRefusals: CachedUsageSnapshot['modelRefusals'],
  now: Date,
): boolean {
  if (!modelRefusals) return false;
  return Object.values(modelRefusals).some((entry) => {
    if (!entry.resetsAt) return true;
    const reset = parseDateValue(entry.resetsAt);
    return !reset || reset.getTime() > now.getTime();
  });
}

export function noteClaudeOutOfCredits(
  usageKey: string,
  cachePath = getClaudeUsageCachePath(),
): void {
  try {
    ensureLockTarget(cachePath, '{}');
    withFileLock(cachePath, () => {
      const cache = readClaudeUsageCacheFile(cachePath);
      const existing = cache[usageKey] ?? { capturedAt: null, windows: [] };
      cache[usageKey] = { ...existing, unavailable: { reason: 'out_of_credits' } };
      atomicWriteFileSync(cachePath, JSON.stringify(cache, null, 2), 'utf-8');
    });
  } catch {
  }
}

export function clearClaudeAccountRefusal(
  usageKey: string,
  cachePath = getClaudeUsageCachePath(),
): void {
  try {
    if (!fs.existsSync(cachePath)) return;
    withFileLock(cachePath, () => {
      const cache = readClaudeUsageCacheFile(cachePath);
      const existing = cache[usageKey];
      if (!existing?.unavailable) return;
      const { unavailable: _drop, ...rest } = existing;
      cache[usageKey] = rest;
      atomicWriteFileSync(cachePath, JSON.stringify(cache, null, 2), 'utf-8');
    });
  } catch {
  }
}

export function noteClaudeSessionLimit(
  usageKey: string,
  resetsAt: Date,
  cachePath = getClaudeUsageCachePath(),
): void {
  try {
    ensureLockTarget(cachePath, '{}');
    withFileLock(cachePath, () => {
      const cache = readClaudeUsageCacheFile(cachePath);
      const existing = cache[usageKey] ?? { capturedAt: null, windows: [] };
      cache[usageKey] = {
        ...existing,
        unavailable: { reason: 'session_limit', resetsAt: resetsAt.toISOString() },
      };
      atomicWriteFileSync(cachePath, JSON.stringify(cache, null, 2), 'utf-8');
    });
  } catch {
  }
}

export function claudeModelRefusalKey(accountId?: string | null, home?: string | null): string | undefined {
  if (accountId) return `account:${accountId}`;
  if (!home) return undefined;
  try { return `context:${fs.realpathSync(home)}`; } catch { return undefined; }
}

function modelFamily(model: string): string {
  const normalized = model.trim().toLowerCase();
  return /(?:^|[-\s])(fable|sonnet|opus|haiku)(?:$|[-\s\d])/.exec(normalized)?.[1] ?? normalized;
}

export function noteClaudeModelRefusal(
  accountKey: string,
  model: string,
  refusal: { family?: string; resetsAt?: Date },
  cachePath = getClaudeUsageCachePath(),
): void {
  try {
    ensureLockTarget(cachePath, '{}');
    withFileLock(cachePath, () => {
      const cache = readClaudeUsageCacheFile(cachePath);
      const existing = cache[accountKey] ?? { capturedAt: null, windows: [] };
      const modelRefusals = { ...(existing.modelRefusals ?? {}) };
      modelRefusals[modelFamily(refusal.family ?? model)] = {
        family: refusal.family,
        resetsAt: refusal.resetsAt?.toISOString(),
      };
      cache[accountKey] = { ...existing, modelRefusals };
      atomicWriteFileSync(cachePath, JSON.stringify(cache, null, 2), 'utf-8');
    });
  } catch {
  }
}

export function clearClaudeModelRefusal(
  accountKey: string,
  model: string,
  cachePath = getClaudeUsageCachePath(),
): void {
  model = modelFamily(model);
  try {
    if (!fs.existsSync(cachePath)) return;
    withFileLock(cachePath, () => {
      const cache = readClaudeUsageCacheFile(cachePath);
      const existing = cache[accountKey];
      if (!existing?.modelRefusals?.[model]) return;
      const modelRefusals = { ...existing.modelRefusals };
      delete modelRefusals[model];
      const rest: CachedUsageSnapshot = { ...existing, modelRefusals };
      if (Object.keys(modelRefusals).length === 0) delete rest.modelRefusals;
      cache[accountKey] = rest;
      atomicWriteFileSync(cachePath, JSON.stringify(cache, null, 2), 'utf-8');
    });
  } catch {
  }
}

export function getClaudeModelRefusal(
  accountKey: string,
  model: string,
  nowMs: number = Date.now(),
  cachePath = getClaudeUsageCachePath(),
): { family?: string; resetsAt: Date | null } | null {
  const cache = readClaudeUsageCacheFile(cachePath);
  const entry = cache[accountKey]?.modelRefusals?.[modelFamily(model)];
  if (!entry) return null;
  if (entry.resetsAt) {
    const reset = parseDateValue(entry.resetsAt);
    if (reset && reset.getTime() <= nowMs) return null;
    return { family: entry.family, resetsAt: reset };
  }
  return { family: entry.family, resetsAt: null };
}

export function parseClaudeModelRefusal(text: string): { family: string } | null {
  const candidates = [text];
  for (const line of text.split('\n')) {
    try {
      const row = JSON.parse(line);
      if (row.type === 'result' && row.is_error && typeof row.result === 'string') candidates.push(row.result);
      if (row.type === 'assistant' && row.isApiErrorMessage && Array.isArray(row.message?.content)) {
        candidates.push(row.message.content.filter((block: { type?: string }) => block.type === 'text').map((block: { text?: string }) => block.text ?? '').join('\n'));
      }
    } catch {  }
  }
  for (const candidate of candidates) {
    const match = /(?:^|\n)\s*You['’]ve reached your ([^\n.]+) limit\.\s*Run \/usage-credits to continue or switch models with \/model\./i.exec(candidate);
    if (match) return { family: match[1].trim() };
  }
  return null;
}

export function parseClaudeSessionLimitReset(text: string, nowMs = Date.now()): Date | null {
  if (!/hit your session limit/i.test(text)) return null;
  const match = /resets\s+([^.;!\n]+)/i.exec(text);
  if (!match) return null;
  const segment = match[1].trim();
  const timeZone = /\(([A-Za-z_]+\/[A-Za-z_]+)\)/.exec(segment)?.[1];
  const timePart = segment.replace(/\([A-Za-z_]+\/[A-Za-z_]+\)/, '').trim();
  const absolute = Date.parse(timePart);
  if (!Number.isNaN(absolute) && absolute > nowMs) return new Date(absolute);
  const clock = /(\d{1,2})(?::(\d{2}))?\s*(am|pm)/i.exec(timePart);
  if (!clock) return null;
  let hour = Number(clock[1]) % 12;
  if (clock[3].toLowerCase() === 'pm') hour += 12;
  const minute = clock[2] ? Number(clock[2]) : 0;
  try {
    if (!timeZone) {
      const result = new Date(nowMs);
      result.setHours(hour, minute, 0, 0);
      if (result.getTime() <= nowMs) result.setDate(result.getDate() + 1);
      return result;
    }
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone, hour12: false, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
    }).formatToParts(new Date(nowMs));
    const part = (type: string) => Number(parts.find((item) => item.type === type)?.value ?? 0);
    const wallNow = Date.UTC(part('year'), part('month') - 1, part('day'), part('hour') % 24, part('minute'));
    const offset = wallNow - nowMs;
    let result = Date.UTC(part('year'), part('month') - 1, part('day'), hour, minute) - offset;
    if (result <= nowMs) result += 24 * 60 * 60 * 1000;
    return new Date(result);
  } catch {
    return null;
  }
}

function isCachedUsageWindowFresh(
  window: UsageWindow,
  capturedAt: Date | null,
  now: Date
): boolean {
  if (window.resetsAt && window.resetsAt.getTime() <= now.getTime()) {
    return false;
  }
  if (capturedAt && window.windowMinutes !== null) {
    const expiresAt = capturedAt.getTime() + window.windowMinutes * 60 * 1000;
    if (expiresAt <= now.getTime()) {
      return false;
    }
  }
  return true;
}

async function getClaudeAccessToken(oauth: ClaudeOauthCredentials, home?: string): Promise<string | null> {
  const accessToken = oauth.accessToken?.trim();
  if (!accessToken) {
    return null;
  }

  if (!claudeAccessTokenNeedsRefresh(oauth.expiresAt ?? null)) {
    return accessToken;
  }

  if (!oauth.refreshToken) {
    return null;
  }

  const refreshed = await refreshClaudeToken(oauth);
  if (!refreshed?.accessToken) {
    return null;
  }

  await saveClaudeOauth(home, refreshed);

  return refreshed.accessToken.trim();
}

async function refreshClaudeToken(oauth: ClaudeOauthCredentials): Promise<ClaudeOauthCredentials | null> {
  const response = await fetch(CLAUDE_TOKEN_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      grant_type: 'refresh_token',
      refresh_token: oauth.refreshToken,
      client_id: CLAUDE_CLIENT_ID,
      scope: (oauth.scopes?.length ? oauth.scopes : CLAUDE_SCOPES).join(' '),
    }),
    signal: AbortSignal.timeout(15000),
  });

  if (!response.ok) {
    return null;
  }

  const data = await response.json() as ClaudeTokenResponse;
  if (!data.access_token || !data.expires_in) {
    return null;
  }

  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token || oauth.refreshToken || null,
    expiresAt: Date.now() + data.expires_in * 1000,
    scopes: data.scope ? data.scope.split(/\s+/).filter(Boolean) : (oauth.scopes || CLAUDE_SCOPES),
  };
}

export async function isClaudeAuthValid(home?: string): Promise<boolean> {
  const oauth = await loadClaudeOauth(home);
  if (!oauth) return false;
  const token = await getClaudeAccessToken(oauth, home);
  return token !== null;
}

function getClaudeUserAgent(cliVersion?: string | null): string {
  return cliVersion ? `claude-code/${cliVersion}` : 'claude-code';
}

function normalizePercent(value: number | null | undefined): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return null;
  }
  return Math.max(0, Math.min(100, value));
}

function normalizeWindowMinutes(value: number | null | undefined): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    return null;
  }
  return value;
}

function inferWindowMinutes(key: UsageWindowKey): number | null {
  switch (key) {
    case 'session':
      return 300;
    case 'week':
    case 'sonnet_week':
      return 10080;
    case 'month':
      return 43200;
  }
}

function parseDateValue(value: unknown): Date | null {
  if (value === null || value === undefined || value === '') {
    return null;
  }

  if (typeof value === 'number' && Number.isFinite(value)) {
    return new Date(value < 1e12 ? value * 1000 : value);
  }

  if (typeof value === 'string') {
    const numeric = Number(value);
    if (!Number.isNaN(numeric)) {
      return parseDateValue(numeric);
    }
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
  }

  return null;
}

function normalizeString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed || null;
}

function renderUsageBar(usedPercent: number): string {
  return renderBar(usedPercent, USAGE_BAR_LEN);
}

function renderCompactUsageBar(usedPercent: number): string {
  return renderBar(usedPercent, COMPACT_BAR_LEN);
}

export function renderBar(usedPercent: number, length: number): string {
  const clamped = Math.max(0, Math.min(100, usedPercent));
  const eighths = Math.round((clamped / 100) * length * 8);
  const filled = Math.floor(eighths / 8);
  const partial = eighths % 8;
  const color = getUsageColor(usedPercent);
  const gauge = FULL.repeat(filled) + PARTIAL_BLOCKS[partial];
  return color(gauge) + chalk.dim(EMPTY.repeat(length - filled - (partial > 0 ? 1 : 0)));
}

function colorUsage(text: string, usedPercent: number): string {
  return getUsageColor(usedPercent)(text);
}

export function getUsageColor(usedPercent: number): (text: string) => string {
  if (usedPercent >= 100) return chalk.red;
  if (usedPercent >= 80) return chalk.yellow;
  return chalk.cyan;
}

function formatPercent(value: number): string {
  const rounded = Math.round(value * 10) / 10;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
}

function formatResetHint(date: Date): string {
  const diffMs = date.getTime() - Date.now();
  if (diffMs <= 0) return 'now';
  const mins = Math.round(diffMs / 60000);
  if (mins < 60) return `${Math.max(1, mins)}m`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.round(hours / 24);
  return `${days}d`;
}

function formatAgeShort(diffMs: number): string {
  const mins = Math.max(1, Math.round(diffMs / 60000));
  if (mins < 60) return `${mins}m`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.round(hours / 24);
  return `${days}d`;
}

function formatStaleWindowSuffix(
  window: UsageWindow,
  capturedAt: Date | null,
  now: Date,
): string {
  const resetPassed = !!window.resetsAt && window.resetsAt.getTime() <= now.getTime();
  const captureExpired =
    !!capturedAt &&
    window.windowMinutes !== null &&
    capturedAt.getTime() + window.windowMinutes * 60 * 1000 <= now.getTime();
  if (resetPassed && !captureExpired) {
    return `period ended ${formatAgeShort(now.getTime() - window.resetsAt!.getTime())}`;
  }
  if (capturedAt) return `${formatAgeShort(now.getTime() - capturedAt.getTime())} old`;
  if (resetPassed) return `period ended ${formatAgeShort(now.getTime() - window.resetsAt!.getTime())}`;
  return 'stale';
}

function renderStaleUsageWindow(
  window: UsageWindow,
  capturedAt: Date | null,
  shortLabel: string,
  now: Date,
): string {
  const bar = renderCompactUsageBar(window.usedPercent);
  const pct = colorUsage(`${Math.round(window.usedPercent)}%`, window.usedPercent);
  const suffix = formatStaleWindowSuffix(window, capturedAt, now);
  return `${chalk.gray(`${shortLabel}:`)} ${bar} ${pct}${chalk.dim('*')} ${chalk.dim(`(${suffix})`)}`;
}

function formatResetAt(date: Date): string {
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const now = new Date();
  const isWithinDay = (date.getTime() - now.getTime()) / 3600000 <= 24;
  const minutes = date.getMinutes();

  if (isWithinDay) {
    return `${date.toLocaleTimeString('en-US', {
      hour: 'numeric',
      minute: minutes === 0 ? undefined : '2-digit',
      hour12: true,
    })} (${timezone})`;
  }

  const options: Intl.DateTimeFormatOptions = {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: minutes === 0 ? undefined : '2-digit',
    hour12: true,
  };

  if (date.getFullYear() !== now.getFullYear()) {
    options.year = 'numeric';
  }

  return `${date.toLocaleString('en-US', options)} (${timezone})`;
}

function safeRealpathSync(filePath: string): string | null {
  try {
    return fs.realpathSync(filePath);
  } catch {
    return null;
  }
}

function safeStatSync(filePath: string): fs.Stats | null {
  try {
    return fs.statSync(filePath);
  } catch {
    return null;
  }
}

function resolveGrokBillingLogPath(home: string | undefined): {
  logPath: string;
  shared: boolean;
} | null {
  const rel = ['.grok', 'logs', 'unified.jsonl'];
  const perVersion = path.join(home || os.homedir(), ...rel);
  try { if (fs.existsSync(perVersion)) return { logPath: perVersion, shared: false }; } catch {  }
  const shared = path.join(process.env.AGENTS_REAL_HOME || os.homedir(), ...rel);
  if (shared !== perVersion) {
    try { if (fs.existsSync(shared)) return { logPath: shared, shared: true }; } catch {  }
  }
  return null;
}

interface GrokAuthIdentity {
  userId: string | null;
  email: string | null;
}

function readGrokAuthIdentity(home: string): GrokAuthIdentity | null {
  const authPath = path.join(home, '.grok', 'auth.json');
  try {
    if (!fs.existsSync(authPath)) return null;
    const data = JSON.parse(fs.readFileSync(authPath, 'utf-8')) as unknown;
    const records = (data && typeof data === 'object' ? [data, ...Object.values(data as object)] : [])
      .filter((r): r is Record<string, unknown> => !!r && typeof r === 'object' && !Array.isArray(r));
    const account = records
      .filter((r) => typeof r.refresh_token === 'string' || typeof r.email === 'string' || typeof r.user_id === 'string')
      .sort((a, b) => String(b.create_time || '').localeCompare(String(a.create_time || '')))[0];
    if (!account) return null;
    const userRaw = account.user_id ?? account.principal_id;
    const userId = typeof userRaw === 'string' && userRaw.trim() ? userRaw.trim() : null;
    const email = typeof account.email === 'string' && account.email.trim()
      ? account.email.trim().toLowerCase()
      : null;
    if (!userId && !email) return null;
    return { userId, email };
  } catch {
    return null;
  }
}

function grokIdentitiesMatch(a: GrokAuthIdentity | null, b: GrokAuthIdentity | null): boolean {
  if (!a || !b) return false;
  if (a.userId && b.userId) return a.userId === b.userId;
  if (a.email && b.email) return a.email === b.email;
  return false;
}

function grokIdentityFromBillingPayload(parsed: Record<string, unknown>): GrokAuthIdentity | null {
  const ctx = parsed.ctx && typeof parsed.ctx === 'object' && !Array.isArray(parsed.ctx)
    ? parsed.ctx as Record<string, unknown>
    : null;
  const config = ctx?.config && typeof ctx.config === 'object' && !Array.isArray(ctx.config)
    ? ctx.config as Record<string, unknown>
    : null;
  const pick = (...cands: unknown[]): string | null => {
    for (const c of cands) {
      if (typeof c === 'string' && c.trim()) return c.trim();
    }
    return null;
  };
  const userId = pick(ctx?.user_id, ctx?.userId, ctx?.principal_id, config?.user_id, parsed.user_id);
  const emailRaw = pick(ctx?.email, config?.email, parsed.email);
  if (!userId && !emailRaw) return null;
  return { userId, email: emailRaw ? emailRaw.toLowerCase() : null };
}

function sameHomePath(a: string, b: string): boolean {
  return (safeRealpathSync(a) ?? path.resolve(a)) === (safeRealpathSync(b) ?? path.resolve(b));
}

function sharedGrokLogAppliesToHome(home: string | undefined, match: GrokBillingMatch): boolean {
  const realHome = process.env.AGENTS_REAL_HOME || os.homedir();
  const requestedHome = home || os.homedir();
  const thisId = readGrokAuthIdentity(requestedHome);
  if (match.identity) {
    return grokIdentitiesMatch(match.identity, thisId);
  }
  if (sameHomePath(requestedHome, realHome)) return true;
  return grokIdentitiesMatch(thisId, readGrokAuthIdentity(realHome));
}

async function getGrokUsageInfo(options?: UsageOptions): Promise<UsageInfo> {
  try {
    const resolved = resolveGrokBillingLogPath(options?.home);
    if (!resolved) return usageNoRecentUsageInfo();

    const match = await readLatestGrokBilling(resolved.logPath);
    if (!match) return usageNoRecentUsageInfo();
    if (resolved.shared && !sharedGrokLogAppliesToHome(options?.home, match)) {
      return usageNoRecentUsageInfo();
    }
    const now = new Date();
    const windows = match.windows.filter((window) =>
      isCachedUsageWindowFresh(window, match.capturedAt, now)
    );
    const staleWindows = match.windows.filter(
      (window) => !isCachedUsageWindowFresh(window, match.capturedAt, now),
    );
    const version = options?.cliVersion;
    const refreshHint = windows.length === 0 && staleWindows.length === 0
      ? `run grok${version ? `@${version}` : ''} once to refresh usage`
      : null;

    return {
      snapshot: {
        source: 'last_seen',
        sourceLabel: 'last seen in Grok logs',
        capturedAt: match.capturedAt,
        windows,
        staleWindows: staleWindows.length > 0 ? staleWindows : undefined,
        plan: match.subscriptionTier,
        refreshHint,
      },
      error: null,
    };
  } catch (err) {
    return { snapshot: null, error: usageUnreachableError('Grok', err) };
  }
}

async function getMuseUsageInfo(options?: UsageOptions): Promise<UsageInfo> {
  try {
    const base = options?.home || os.homedir();

    const throttledUntil = usageRateLimitedUntil('muse', Date.now(), options?.usageScope);
    if (throttledUntil) {
      const local = await readMuseLocalSessionUsage(base);
      if (local) return { snapshot: local, error: null };
      return { snapshot: null, error: usageThrottledError('Muse', throttledUntil) };
    }

    const probe = await probeMuseRateLimits(base);
    if (probe.snapshot) return { snapshot: probe.snapshot, error: null };

    const local = await readMuseLocalSessionUsage(base);
    if (local) return { snapshot: local, error: null };

    if (!probe.hasKey) return { snapshot: null, error: usageNoCredentialError('Muse') };
    if (probe.noHeaders) return usageNoRecentUsageInfo();
    return {
      snapshot: null,
      error: classifyUsageFetchFailure('Muse', 'muse', probe.status, probe.retryAfter, options?.usageScope),
    };
  } catch (err) {
    return { snapshot: null, error: usageUnreachableError('Muse', err) };
  }
}

function resolveMuseApiKey(base: string): string | null {
  const envKey = process.env.META_API_KEY?.trim() || process.env.MODEL_API_KEY?.trim();
  if (envKey) return envKey;
  const authPath = path.join(base, '.config', 'muse', 'auth.json');
  try {
    if (!fs.existsSync(authPath)) return null;
    const data = JSON.parse(fs.readFileSync(authPath, 'utf-8')) as Record<string, unknown>;
    if (typeof data.access_token === 'string' && data.access_token) return data.access_token;
    if (typeof data.api_key === 'string' && data.api_key) return data.api_key;
    for (const slot of Object.values(data)) {
      if (!slot || typeof slot !== 'object' || Array.isArray(slot)) continue;
      const entry = slot as Record<string, unknown>;
      if (typeof entry.access_token === 'string' && entry.access_token) return entry.access_token;
      if (typeof entry.api_key === 'string' && entry.api_key) return entry.api_key;
    }
  } catch {
  }
  return null;
}

interface MuseProbeResult {
  snapshot: UsageSnapshot | null;
  hasKey: boolean;
  status: number | null;
  retryAfter: string | null;
  noHeaders: boolean;
}

async function probeMuseRateLimits(base: string): Promise<MuseProbeResult> {
  const key = resolveMuseApiKey(base);
  if (!key) return { snapshot: null, hasKey: false, status: null, retryAfter: null, noHeaders: false };
  try {
    const response = await fetch('https://api.meta.ai/v1/models', {
      headers: { Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(8_000),
    });
    if (!response.ok) {
      return {
        snapshot: null,
        hasKey: true,
        status: response.status,
        retryAfter: response.headers.get('retry-after'),
        noHeaders: false,
      };
    }

    const limitTokens = headerNumber(response.headers, 'x-ratelimit-limit-tokens');
    const remainingTokens = headerNumber(response.headers, 'x-ratelimit-remaining-tokens');
    const limitRequests = headerNumber(response.headers, 'x-ratelimit-limit-requests');
    const remainingRequests = headerNumber(response.headers, 'x-ratelimit-remaining-requests');

    const windows: UsageWindow[] = [];
    if (limitTokens !== null && remainingTokens !== null && limitTokens > 0) {
      const used = Math.max(0, Math.min(100, ((limitTokens - remainingTokens) / limitTokens) * 100));
      windows.push({
        key: 'session',
        label: 'Tokens (current window)',
        shortLabel: 'Tok',
        usedPercent: used,
        resetsAt: null,
        windowMinutes: 1,
      });
    }
    if (limitRequests !== null && remainingRequests !== null && limitRequests > 0) {
      const used = Math.max(0, Math.min(100, ((limitRequests - remainingRequests) / limitRequests) * 100));
      windows.push({
        key: 'session',
        label: 'Requests (current window)',
        shortLabel: 'Req',
        usedPercent: used,
        resetsAt: null,
        windowMinutes: 1,
      });
    }
    if (windows.length === 0) {
      return { snapshot: null, hasKey: true, status: response.status, retryAfter: null, noHeaders: true };
    }
    return {
      snapshot: {
        source: 'live',
        sourceLabel: 'Meta Model API rate limits',
        capturedAt: new Date(),
        windows,
        plan: 'Meta Model API',
      },
      hasKey: true,
      status: response.status,
      retryAfter: null,
      noHeaders: false,
    };
  } catch {
    return { snapshot: null, hasKey: true, status: null, retryAfter: null, noHeaders: false };
  }
}

function headerNumber(headers: Headers, name: string): number | null {
  const raw = headers.get(name);
  if (raw === null || raw === '') return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

async function readMuseLocalSessionUsage(base: string): Promise<UsageSnapshot | null> {
  const root = path.join(base, '.local', 'share', 'muse', 'sessions');
  if (!fs.existsSync(root)) return null;

  const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
  let inputTokens = 0;
  let outputTokens = 0;
  let cachedTokens = 0;
  let latestAt: Date | null = null;
  let files = 0;

  const walk = (dir: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        walk(full);
        continue;
      }
      if (ent.name !== 'session.jsonl') continue;
      try {
        const st = fs.statSync(full);
        if (st.mtimeMs < cutoff) continue;
        files++;
        if (!latestAt || st.mtime > latestAt) latestAt = st.mtime;
        const content = fs.readFileSync(full, 'utf-8');
        for (const line of content.split('\n')) {
          if (!line.trim()) continue;
          let raw: any;
          try {
            raw = JSON.parse(line);
          } catch {
            continue;
          }
          const event = raw?.payload?.event ?? raw?.payload;
          if (!event || event.kind !== 'model_completed') continue;
          const usage = event.usage;
          if (!usage || typeof usage !== 'object') continue;
          if (typeof usage.input_tokens === 'number') inputTokens += usage.input_tokens;
          if (typeof usage.output_tokens === 'number') outputTokens += usage.output_tokens;
          if (typeof usage.cached_tokens === 'number') cachedTokens += usage.cached_tokens;
        }
      } catch {
      }
    }
  };
  walk(root);

  const total = inputTokens + outputTokens + cachedTokens;
  if (total === 0 && files === 0) return null;

  const softCap = 10_000_000;
  const usedPercent = Math.max(0, Math.min(100, (total / softCap) * 100));
  const formatK = (n: number): string =>
    n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);

  return {
    source: 'last_seen',
    sourceLabel: `local Muse sessions · ${formatK(total)} tokens (7d)`,
    capturedAt: latestAt,
    windows: [
      {
        key: 'week',
        label: 'Local tokens (7d)',
        shortLabel: '7d',
        usedPercent,
        resetsAt: null,
        windowMinutes: 7 * 24 * 60,
      },
    ],
    plan: 'Meta Model API',
  };
}

interface GrokBillingMatch {
  capturedAt: Date | null;
  subscriptionTier?: string | null;
  windows: UsageWindow[];
  identity: GrokAuthIdentity | null;
}

async function readLatestGrokBilling(filePath: string): Promise<GrokBillingMatch | null> {
  return new Promise((resolve) => {
    let latest: GrokBillingMatch | null = null;
    const stream = fs.createReadStream(filePath, { encoding: 'utf-8' });
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

    rl.on('line', (line) => {
      if (!line.trim()) return;
      try {
        const parsed = JSON.parse(line) as Record<string, unknown>;
        const ctx = parsed.ctx && typeof parsed.ctx === 'object' && !Array.isArray(parsed.ctx)
          ? parsed.ctx as Record<string, unknown>
          : null;
        if (parsed.msg === 'billing: fetched credits config' && ctx?.config) {
          const config = ctx.config as Record<string, unknown>;
          const windows: UsageWindow[] = [];

          const currentPeriod = config.currentPeriod && typeof config.currentPeriod === 'object'
            ? config.currentPeriod as Record<string, unknown>
            : null;
          if (currentPeriod?.end && typeof config.creditUsagePercent === 'number') {
            const rawPercent = config.creditUsagePercent;
            windows.push({
              key: 'week',
              label: 'Current week',
              shortLabel: 'W',
              usedPercent: Math.max(0, Math.min(100, rawPercent)),
              resetsAt: parseDateValue(currentPeriod.end),
              windowMinutes: inferWindowMinutes('week'),
            });
          }

          latest = {
            capturedAt: parseDateValue(parsed.ts),
            subscriptionTier: typeof ctx.subscriptionTier === 'string' ? ctx.subscriptionTier : null,
            windows,
            identity: grokIdentityFromBillingPayload(parsed),
          };
        }
      } catch {
      }
    });

    rl.on('close', () => resolve(latest));
    rl.on('error', () => resolve(latest));
  });
}

interface CursorUsageModel {
  numRequests?: number | null;
  maxRequestUsage?: number | null;
}

interface CursorUsageResponse {
  'gpt-4'?: CursorUsageModel | null;
  startOfMonth?: string | null;
  [model: string]: CursorUsageModel | string | null | undefined;
}

export function normalizeCursorUsage(data: CursorUsageResponse): UsageWindow[] {
  const premium = data['gpt-4'];
  if (!premium || typeof premium !== 'object') return [];
  const max = premium.maxRequestUsage;
  if (typeof max !== 'number' || !Number.isFinite(max) || max <= 0) return [];
  const used = typeof premium.numRequests === 'number' ? premium.numRequests : 0;

  const startOfMonth =
    typeof data.startOfMonth === 'string' ? parseDateValue(data.startOfMonth) : null;
  let resetsAt: Date | null = null;
  if (startOfMonth) {
    resetsAt = new Date(startOfMonth);
    const intendedMonth = (resetsAt.getMonth() + 1) % 12;
    resetsAt.setMonth(resetsAt.getMonth() + 1);
    if (resetsAt.getMonth() !== intendedMonth) resetsAt.setDate(0);
  }

  return [
    {
      key: 'month',
      label: 'Current month',
      shortLabel: 'M',
      usedPercent: Math.max(0, Math.min(100, (used / max) * 100)),
      resetsAt,
      windowMinutes: inferWindowMinutes('month'),
    },
  ];
}

interface CursorPlanUsage {
  autoPercentUsed?: number | null;
  apiPercentUsed?: number | null;
  totalPercentUsed?: number | null;
}

interface CursorPeriodUsageResponse {
  planUsage?: CursorPlanUsage | null;
  billingCycleEnd?: string | number | null;
}

interface CursorUsageSummaryResponse {
  isUnlimited?: boolean | null;
  individualUsage?: {
    plan?: CursorPlanUsage | null;
  } | null;
  billingCycleEnd?: string | number | null;
}

function normalizeCursorPercentWindow(
  percent: number | null | undefined,
  key: UsageWindowKey,
  label: string,
  shortLabel: string,
  resetsAt: Date | null,
): UsageWindow | null {
  const usedPercent = normalizePercent(percent);
  if (usedPercent === null) return null;
  return { key, label, shortLabel, usedPercent, resetsAt, windowMinutes: null };
}

export function normalizeCursorPeriodUsage(data: CursorPeriodUsageResponse): UsageWindow[] {
  const resetsAt = parseDateValue(data.billingCycleEnd);
  const plan = data.planUsage;
  const windows = [
    normalizeCursorPercentWindow(plan?.autoPercentUsed, 'session', 'Auto + Composer', 'A', resetsAt),
    normalizeCursorPercentWindow(plan?.apiPercentUsed, 'week', 'API', 'API', resetsAt),
    normalizeCursorPercentWindow(plan?.totalPercentUsed, 'month', 'Total', 'T', resetsAt),
  ];
  return windows.filter((window): window is UsageWindow => window !== null);
}

export function normalizeCursorUsageSummary(data: CursorUsageSummaryResponse): UsageWindow[] {
  const resetsAt = parseDateValue(data.billingCycleEnd);
  const plan = data.individualUsage?.plan;
  const windows = [
    normalizeCursorPercentWindow(plan?.autoPercentUsed, 'session', 'Auto + Composer', 'A', resetsAt),
    normalizeCursorPercentWindow(plan?.apiPercentUsed, 'week', 'API', 'API', resetsAt),
    normalizeCursorPercentWindow(plan?.totalPercentUsed, 'month', 'Total', 'T', resetsAt),
  ];
  return windows.filter((window): window is UsageWindow => window !== null);
}

function readCursorCredentials(base: string): { cfgSub: string | null; accessToken: string } | null {
  try {
    const cfgPath = path.join(base, '.cursor', 'cli-config.json');
    const authPath = path.join(base, '.cursor', 'auth.json');
    if (!fs.existsSync(cfgPath) || !fs.existsSync(authPath)) return null;
    const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf-8'));
    const cfgSub = typeof cfg?.authInfo?.authId === 'string' ? cfg.authInfo.authId : null;
    const auth = JSON.parse(fs.readFileSync(authPath, 'utf-8'));
    const accessToken = auth?.accessToken;
    if (typeof accessToken !== 'string' || !accessToken) return null;
    return { cfgSub, accessToken };
  } catch {
    return null;
  }
}

function resolveCursorSubject(accessToken: string, cfgSub: string | null): string | null {
  const jwtSub = normalizeString(decodeJwtPayload(accessToken)?.sub);
  return jwtSub || cfgSub;
}

async function fetchCursorPeriodWindows(cookie: string): Promise<UsageWindow[] | null> {
  try {
    const response = await fetch(CURSOR_PERIOD_USAGE_URL, {
      method: 'POST',
      headers: {
        Cookie: cookie,
        Origin: 'https://cursor.com',
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: '{}',
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) {
      if (response.status === 429) {
        noteUsageRateLimited('cursor', response.headers.get('retry-after'));
      }
      return null;
    }
    const data = (await response.json()) as CursorPeriodUsageResponse;
    return normalizeCursorPeriodUsage(data);
  } catch {
    return null;
  }
}

async function fetchCursorUsageSummaryWindows(cookie: string): Promise<UsageWindow[] | null> {
  try {
    const response = await fetch(CURSOR_USAGE_SUMMARY_URL, {
      method: 'GET',
      headers: {
        Cookie: cookie,
        Accept: 'application/json',
      },
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) {
      if (response.status === 429) {
        noteUsageRateLimited('cursor', response.headers.get('retry-after'));
      }
      return null;
    }
    const data = (await response.json()) as CursorUsageSummaryResponse;
    return normalizeCursorUsageSummary(data);
  } catch {
    return null;
  }
}

async function getCursorUsageInfo(options?: UsageOptions): Promise<UsageInfo> {
  try {
    const base = options?.home || os.homedir();
    const creds = readCursorCredentials(base);
    if (!creds) return { snapshot: null, error: usageNoCredentialError('Cursor') };

    const exp = decodeJwtPayload(creds.accessToken)?.exp;
    if (typeof exp === 'number' && Date.now() / 1000 >= exp) {
      return { snapshot: null, error: usageExpiredCredentialError('Cursor') };
    }

    const sub = resolveCursorSubject(creds.accessToken, creds.cfgSub);
    if (!sub) return { snapshot: null, error: usageNoCredentialError('Cursor') };

    const throttledUntil = usageRateLimitedUntil('cursor');
    if (throttledUntil) {
      return { snapshot: null, error: usageThrottledError('Cursor', throttledUntil) };
    }

    const cookie = `WorkosCursorSessionToken=${sub}%3A%3A${creds.accessToken}`;

    const periodWindows = await fetchCursorPeriodWindows(cookie);
    if (periodWindows && periodWindows.length > 0) {
      return {
        snapshot: { source: 'live', sourceLabel: 'live account data', capturedAt: new Date(), windows: periodWindows },
        error: null,
      };
    }

    const summaryWindows = await fetchCursorUsageSummaryWindows(cookie);
    if (summaryWindows && summaryWindows.length > 0) {
      return {
        snapshot: { source: 'live', sourceLabel: 'live account data', capturedAt: new Date(), windows: summaryWindows },
        error: null,
      };
    }

    const url = `${CURSOR_USAGE_URL}?user=${encodeURIComponent(sub)}`;
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        Cookie: cookie,
        Accept: 'application/json',
      },
      signal: usageFetchSignal(options?.signal, 5000),
    });

    if (!response.ok) {
      if (response.status === 429) {
        noteUsageRateLimited('cursor', response.headers.get('retry-after'));
      }
      return { snapshot: null, error: usageRejectedError('Cursor', response.status) };
    }

    const data = (await response.json()) as CursorUsageResponse;
    return {
      snapshot: {
        source: 'live',
        sourceLabel: 'live account data',
        capturedAt: new Date(),
        windows: normalizeCursorUsage(data),
      },
      error: null,
    };
  } catch (err) {
    return { snapshot: null, error: usageUnreachableError('Cursor', err) };
  }
}


const ANTIGRAVITY_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const ANTIGRAVITY_QUOTA_URLS = [
  'https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuota',
  'https://daily-cloudcode-pa.googleapis.com/v1internal:retrieveUserQuota',
];
const ANTIGRAVITY_CLIENT_ID =
  '1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com';
const ANTIGRAVITY_CLIENT_SECRET = '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';
const ANTIGRAVITY_REFRESH_LEEWAY_MS = 60 * 1000;

interface AntigravityOauthToken {
  access_token?: string | null;
  refresh_token?: string | null;
  expiry?: string | null;
}

interface AntigravityQuotaBucket {
  modelId?: string | null;
  tokenType?: string | null;
  remainingFraction?: number | null;
  resetTime?: string | null;
}

interface AntigravityQuotaResponse {
  buckets?: AntigravityQuotaBucket[] | null;
}

export function parseAntigravityOauthPayload(raw: string): AntigravityOauthToken | null {
  try {
    let text = raw.trim();
    if (text.startsWith('go-keyring-base64:')) {
      text = Buffer.from(text.slice('go-keyring-base64:'.length), 'base64').toString('utf-8');
    }
    const token = JSON.parse(text)?.token;
    if (!token || typeof token !== 'object') return null;
    if (typeof token.access_token !== 'string' && typeof token.refresh_token !== 'string') {
      return null;
    }
    return token as AntigravityOauthToken;
  } catch {
    return null;
  }
}

export function antigravityTokenNeedsRefresh(
  expiry: string | null | undefined,
  nowMs: number = Date.now(),
): boolean {
  if (!expiry) return false;
  const ms = Date.parse(expiry);
  if (Number.isNaN(ms)) return false;
  return nowMs + ANTIGRAVITY_REFRESH_LEEWAY_MS >= ms;
}

function resolveAntigravityCredentialPath(home?: string): string | null {
  const rel = ['.gemini', 'antigravity-cli', 'antigravity-oauth-token'];
  const perHome = path.join(home || os.homedir(), ...rel);
  try { if (fs.existsSync(perHome)) return perHome; } catch {  }
  const active = path.join(process.env.AGENTS_REAL_HOME || os.homedir(), ...rel);
  if (active !== perHome) {
    try { if (fs.existsSync(active)) return active; } catch {  }
  }
  return null;
}

async function loadAntigravityOauth(home?: string): Promise<AntigravityOauthToken | null> {
  const credPath = resolveAntigravityCredentialPath(home);
  if (credPath) {
    try {
      const parsed = parseAntigravityOauthPayload(fs.readFileSync(credPath, 'utf-8'));
      if (parsed) return parsed;
    } catch {  }
  }

  if (process.env.AGENTS_NO_KEYCHAIN_PROBE === '1') return null;
  const probe =
    process.platform === 'darwin'
      ? { cmd: 'security', args: ['find-generic-password', '-w', '-s', 'gemini', '-a', 'antigravity'] }
      : process.platform === 'linux'
        ? { cmd: 'secret-tool', args: ['lookup', 'service', 'gemini', 'username', 'antigravity'] }
        : null;
  if (!probe) return null;
  try {
    const { stdout } = await execFileAsync(probe.cmd, probe.args, { timeout: 5000 });
    return parseAntigravityOauthPayload(stdout);
  } catch {
    return null;
  }
}

async function refreshAntigravityAccessToken(refreshToken: string): Promise<string | null> {
  try {
    const response = await fetch(ANTIGRAVITY_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: ANTIGRAVITY_CLIENT_ID,
        client_secret: ANTIGRAVITY_CLIENT_SECRET,
        refresh_token: refreshToken,
        grant_type: 'refresh_token',
      }).toString(),
      signal: AbortSignal.timeout(8000),
    });
    if (!response.ok) return null;
    const data = (await response.json()) as { access_token?: string };
    return typeof data.access_token === 'string' && data.access_token ? data.access_token : null;
  } catch {
    return null;
  }
}

interface AntigravityQuotaFetchResult {
  buckets: AntigravityQuotaBucket[] | null;
  status: number | null;
  retryAfter: string | null;
}

async function fetchAntigravityQuota(accessToken: string): Promise<AntigravityQuotaFetchResult> {
  let lastStatus: number | null = null;
  let lastRetryAfter: string | null = null;
  for (const url of ANTIGRAVITY_QUOTA_URLS) {
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: '{}',
        signal: AbortSignal.timeout(5000),
      });
      if (!response.ok) {
        lastStatus = response.status;
        lastRetryAfter = response.headers.get('retry-after');
        continue;
      }
      const data = (await response.json()) as AntigravityQuotaResponse;
      return { buckets: Array.isArray(data?.buckets) ? data.buckets : [], status: response.status, retryAfter: null };
    } catch {
      continue;
    }
  }
  return { buckets: null, status: lastStatus, retryAfter: lastRetryAfter };
}

export function antigravityModelShortLabel(modelId: string): string {
  const stripped = modelId.replace(/^gemini-/i, '');
  const parts = stripped.split('-').filter(Boolean);
  if (parts.length === 0) return modelId;
  const [version, ...rest] = parts;
  return version + rest.map((part) => (part[0] ? part[0].toUpperCase() : '')).join('');
}

export function normalizeAntigravityWindows(buckets: AntigravityQuotaBucket[]): UsageWindow[] {
  const byModel = new Map<string, { bucket: AntigravityQuotaBucket; remaining: number }>();
  for (const bucket of buckets) {
    const modelId = normalizeString(bucket?.modelId);
    const remaining = bucket?.remainingFraction;
    if (!modelId || typeof remaining !== 'number' || !Number.isFinite(remaining)) continue;
    const existing = byModel.get(modelId);
    if (!existing || remaining < existing.remaining) {
      byModel.set(modelId, { bucket, remaining });
    }
  }

  const windows: UsageWindow[] = [];
  for (const [modelId, { bucket, remaining }] of byModel) {
    const usedPercent = normalizePercent((1 - remaining) * 100);
    if (usedPercent === null) continue;
    windows.push({
      key: 'session',
      label: modelId,
      shortLabel: antigravityModelShortLabel(modelId),
      usedPercent,
      resetsAt: parseDateValue(bucket.resetTime),
      windowMinutes: null,
    });
  }
  windows.sort((a, b) => b.usedPercent - a.usedPercent);
  return windows;
}

async function getAntigravityUsageInfo(options?: UsageOptions): Promise<UsageInfo> {
  try {
    const token = await loadAntigravityOauth(options?.home);
    if (!token) return { snapshot: null, error: usageNoCredentialError('Antigravity') };

    let accessToken = normalizeString(token.access_token);
    if ((!accessToken || antigravityTokenNeedsRefresh(token.expiry)) && token.refresh_token) {
      accessToken = await refreshAntigravityAccessToken(token.refresh_token);
    }
    if (!accessToken) return { snapshot: null, error: usageExpiredCredentialError('Antigravity') };

    const throttledUntil = usageRateLimitedUntil('antigravity', Date.now(), options?.usageScope);
    if (throttledUntil) {
      return { snapshot: null, error: usageThrottledError('Antigravity', throttledUntil) };
    }

    const { buckets, status, retryAfter } = await fetchAntigravityQuota(accessToken);
    if (!buckets) {
      return {
        snapshot: null,
        error: classifyUsageFetchFailure('Antigravity', 'antigravity', status, retryAfter, options?.usageScope),
      };
    }

    const windows = normalizeAntigravityWindows(buckets);
    if (windows.length === 0) return { snapshot: null, error: null };

    return {
      snapshot: {
        source: 'live',
        sourceLabel: 'live account data',
        capturedAt: new Date(),
        windows,
      },
      error: null,
    };
  } catch (err) {
    return { snapshot: null, error: usageUnreachableError('Antigravity', err) };
  }
}
