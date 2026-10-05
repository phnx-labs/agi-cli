/** Usage and rate-limit tracking for Claude, Codex, Kimi, Droid, Grok, Cursor and Antigravity.
 * Fetches live usage from each agent's API or parses Codex session logs, normalizes to a
 * UsageSnapshot, caches it to disk, and renders progress bars for `agents view`. */
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

/** Why a usage read produced no snapshot when the cause is the credential or server. Providers
 * returned `error: null`, so unreadable accounts looked healthy. No read refreshes a token
 * (RUSH-1822), so an expired credential stays unreadable until the agent runs. */
export function usageNoCredentialError(agent: string): string {
  return `No readable ${agent} credential — sign in, or provision a long-lived token for this account.`;
}
export function usageExpiredCredentialError(agent: string): string {
  return `${agent} credential expired — re-auth this account (a usage read never refreshes it).`;
}

/** Kimi-specific expired-credential wording: a normal Kimi launch refreshes its own OAuth token, so
 * the fix is to run Kimi once, not re-auth through agents-cli (RUSH-3198). */
export function usageExpiredKimiCredentialError(): string {
  return `Kimi credential expired — run Kimi once to refresh it (a usage read never refreshes it).`;
}
export function usageRejectedError(agent: string, status: number): string {
  return status === 429
    ? `${agent} is rate-limiting the usage endpoint for this machine (HTTP 429).`
    : `${agent} rejected the usage read (HTTP ${status}).`;
}

/** Canonical phrase for the Anthropic setup-token scope gap (RUSH-2392): `claude setup-token` mints
 * only `user:inference` but the usage endpoint needs `user:profile`. The account runs, but bars
 * cannot populate. Detected via isUsageHeadlessScopeError so the UI renders it distinctly. */
export const USAGE_HEADLESS_SCOPE_MARKER = 'usage unavailable (headless)';

/** Error when Claude's usage API returns 403 because the setup-token lacks `user:profile`
 * (RUSH-2392): not a revocation or missing mint, a permanent tradeoff of the headless credential. */
export function usageHeadlessScopeError(agent = 'Claude'): string {
  return `${agent} ${USAGE_HEADLESS_SCOPE_MARKER} — setup-token lacks user:profile; account can still run.`;
}

/** True when an error string is the setup-token scope gap (RUSH-2392). */
export function isUsageHeadlessScopeError(error: string | null | undefined): boolean {
  return typeof error === 'string' && error.includes(USAGE_HEADLESS_SCOPE_MARKER);
}

/** Canonical phrase for a Claude account the usage reader has no usable credential for. Distinct
 * from USAGE_HEADLESS_SCOPE_MARKER, where a setup-token was read and its scope refused. */
export const USAGE_NO_USAGE_CREDENTIAL_MARKER = 'usage unavailable (no usage credential)';

/** Claude's own no-credential message. The shared "sign in" remedy is false for Claude: the usage
 * read never touches the interactive login (RUSH-1822), and `claude setup-token` hits the scope
 * gap (RUSH-2392, #2987). So it states both constraints and that the account still runs. */
export function usageNoClaudeUsageCredentialError(): string {
  return (
    `Claude ${USAGE_NO_USAGE_CREDENTIAL_MARKER} — a usage read never uses your login ` +
    '(RUSH-1822); a setup-token cannot read usage (RUSH-2392). The account still runs.'
  );
}

/** True when an error string is the Claude no-usage-credential state (#2987). */
function isUsageNoUsageCredentialError(error: string | null | undefined): boolean {
  return typeof error === 'string' && error.includes(USAGE_NO_USAGE_CREDENTIAL_MARKER);
}

/** Detect Anthropic's usage-endpoint scope denial: HTTP 403 whose body names `user:profile` (or
 * "scope requirement"). A bare 403 stays a real rejection (RUSH-2392). */
export function isClaudeUsageScopeDenied(
  status: number,
  bodyText: string | null | undefined,
): boolean {
  if (status !== 403) return false;
  if (!bodyText) return false;
  const lower = bodyText.toLowerCase();
  return lower.includes('user:profile') || lower.includes('scope requirement');
}

/** The read threw rather than answering (timeout, DNS/TLS, unparseable payload, undecryptable
 * credential). Providers swallowed these into `error: null`, rendering a stale snapshot as
 * confirmed, so the cause is carried verbatim. */
/** We are still inside the provider's back-off window, so this read made no request. Distinct from
 * `usageRejectedError(agent, 429)`, the 429 itself: this one says we are honouring it. */
export function usageThrottledError(agent: string, untilMs: number): string {
  return `${agent} rate-limited this machine — not retrying for ${formatBackoffRemaining(untilMs)}.`;
}
export function usageUnreachableError(agent: string, cause?: unknown): string {
  const detail = cause instanceof Error ? cause.message : typeof cause === 'string' ? cause : '';
  return detail
    ? `${agent} usage read failed: ${detail}`
    : `${agent} usage read failed.`;
}

/** Marker for a log-based (`network: false`) provider, Codex or Grok, with no rate-limit event
 * recorded here yet. Distinct from `usageUnreachableError` (the log couldn't be read): a fresh
 * install is benign, not an error (RUSH-3040). */
const USAGE_NO_RECENT_USAGE_MARKER = 'no usage recorded yet';
export const USAGE_BENIGN_STATE: unique symbol = Symbol('usageBenignState');
export type UsageBenignState = 'no-recent-usage';

/** Sentinel `UsageInfo.error` for a read-only lookup whose cache was empty: no request made,
 * nothing failed, the daemon just hasn't collected it. It fell through to 'rejected' and printed
 * "usage unavailable" for a cold cache (#2987). `'stale'` is unchanged for callers. */
export const USAGE_NOT_COLLECTED_MARKER = 'stale';

/** Human-facing form of a `UsageInfo.error` for `agents view --json`'s `usageError`. Every error is
 * already a sentence except the internal `'stale'` sentinel (USAGE_NOT_COLLECTED_MARKER), mapped
 * to an actionable string (PHNX-3348). Null when none. */
export function usageErrorForDisplay(error: string | null | undefined): string | null {
  if (!error) return null;
  if (error === USAGE_NOT_COLLECTED_MARKER) {
    return 'Usage not collected yet — run `agents view --refresh` to fetch it.';
  }
  return error;
}

/** Shared error classification and 429 backoff for a usage fetch whose only signal is an HTTP
 * status: Antigravity and Muse (RUSH-3040). Route every no-snapshot outcome through this. It notes
 * the 429 backoff itself, so callers must not also call noteUsageRateLimited. */
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

/** The specific cause behind a `UsageInfo.error`, so a renderer names the exact state instead of a
 * generic "usage unavailable" (RUSH-3040). Matched against this file's canonical strings; never
 * re-derive prefixes. */
export type UsageErrorKind =
  | 'no-credential'
  | 'no-usage-credential'
  | 'expired-credential'
  | 'rate-limited'
  | 'rejected'
  | 'headless-scope'
  | 'unreachable'
  | 'not-collected';

/** Classify a `UsageInfo.error` string into its {@link UsageErrorKind}, or null when there is no error. */
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

/** True when a Claude OAuth access token is within the refresh leeway of expiry or expired. The
 * single source of truth for the run/usage path (refreshes) and the health probe (must not
 * refresh, reports `expired`; RUSH-1822). A missing `expiresAt` counts as fresh. */
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

/** Test seam for the usage cache path. `getCacheDir()` is a module-level constant captured at
 * import, so overriding HOME does not redirect it and a test would write the developer's real
 * ~/.agents/.cache/. */
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
// A window we expected but have no reading for (e.g. Claude's 5h session when utilization is
// null). It must read as neither 0% nor 100% (a full block looked maxed out), so use a dashed "no
// data" row.
const NO_DATA = '\u2504';

/** Discriminator for usage window types. */
export type UsageWindowKey = 'session' | 'week' | 'sonnet_week' | 'month';

/** How this box obtained a usage row (delta-spec D8), distinct from `UsageSnapshot.source` (`live`
 * | `last_seen`), which is how the number was collected from the harness or API. */
export type UsageCaptureSource = 'poll' | 'statusline' | 'sync';

/** A single rate-limit window with utilization percentage and reset time. */
export interface UsageWindow {
  key: UsageWindowKey;
  label: string;
  shortLabel: string;
  usedPercent: number;
  resetsAt: Date | null;
  windowMinutes: number | null;
}

/** A point-in-time collection of usage windows from a single source. */
export interface UsageSnapshot {
  source: 'live' | 'last_seen';
  sourceLabel: string;
  capturedAt: Date | null;
  windows: UsageWindow[];
  /** Last-known windows dropped from `windows` as expired or from a rolled-over period. View-only:
   * routing must never read it (RUSH-2858), so a stale number cannot look verified or eligible.
   * Round-trips through the cache but is omitted from `--json`. */
  staleWindows?: UsageWindow[];
  // Subscription tier when the usage source reports it in the same response (Kimi's
  // membership.level); otherwise the plan comes from the local auth file via AccountInfo.plan.
  plan?: string | null;
  /** Action that makes an event-fed source emit a current reading. */
  refreshHint?: string | null;
  /** A refusal observed from a real harness run, independent of API windows. `session_limit`
   * recovers on a clock (`resetsAt`); `out_of_credits` has no reset and clears only on a later
   * successful run (clearClaudeAccountRefusal). Both exclude the account from rotation while set. */
  unavailable?: {
    reason: 'session_limit' | 'out_of_credits';
    resetsAt?: Date;
  };
  /** D8 freshness provenance. A `sync` row came from the account's poller via the fleet store and
   * is trusted for the sync cadence; `poll` and `statusline` are local captures with the 5-minute
   * decision bar. */
  freshness?: {
    source: UsageCaptureSource;
    /** Device that polled or ingested the authoritative reading. */
    poller?: string;
  };
}

/** Usage data plus any error encountered while fetching. */
export interface UsageInfo {
  snapshot: UsageSnapshot | null;
  error: string | null;
  /** Benign local state, symbol-backed so `--json` keeps its existing shape. */
  [USAGE_BENIGN_STATE]?: UsageBenignState;
}

/** Construct the benign no-local-log result without overloading `error`. */
function usageNoRecentUsageInfo(): UsageInfo {
  return { snapshot: null, error: null, [USAGE_BENIGN_STATE]: 'no-recent-usage' };
}

/** Read a benign state for the human renderer; symbols are omitted by JSON serialization. */
export function getUsageBenignState(info: UsageInfo): UsageBenignState | null {
  return info[USAGE_BENIGN_STATE] ?? null;
}

/** Input needed to identify an account for usage lookup. */
export interface UsageIdentityInput {
  agentId: AgentId;
  info: AccountInfo;
  home?: string;
  cliVersion?: string | null;
}

/** Options for fetching usage data. */
interface UsageOptions {
  home?: string;
  cliVersion?: string | null;
  organizationId?: string | null;
  /** The account's usage key (`claude:org=...`, `kimi:user=...`) when known. Scopes the 429 backoff
   * to that account (RUSH-3036) so a throttled account cannot park its siblings; absent, backoff
   * is provider-wide. */
  usageScope?: string | null;
  /** Caller abort signal (the daemon tick's deadline), combined with each fetch's own timeout so a
   * hung refresh is bounded by both (PHNX-3608). */
  signal?: AbortSignal;
  /** When true, never open the ACL-bound OS keychain item (Touch ID), so a daemon tick cannot pop
   * biometrics. Credentials come only from the no-ACL token cache, a file-based setup-token, or
   * `.credentials.json`. */
  fileOnly?: boolean;
  /** When true, a read with no file-based setup-token may fall through to Claude Code's interactive
   * login, the only credential with `user:profile` that `/api/oauth/usage` needs. Set only by a
   * foreground `agents view` on headed devices (USAGE-READ-2); background loops never (RUSH-1822). */
  allowInteractiveLogin?: boolean;
  /** Headed usage poller: skip the setup-token and ACL keychain and read only
   * `<home>/.claude/.credentials.json` (the native rotating blob). A setup-token 403s on the usage
   * endpoint and the keychain pops Touch ID. */
  nativeFileLogin?: boolean;
}

/** Canonical input for a single usage fetch operation. */
interface UsageFetchInput {
  agentId: AgentId;
  home?: string;
  cliVersion: string | null;
  organizationId: string | null;
}

/** Raw rate-limit window from a Codex session event. */
interface CodexRateLimitWindow {
  used_percent?: number | null;
  window_minutes?: number | null;
  resets_at?: number | string | null;
}

/** Raw rate-limit payload from a Codex token_count event. */
interface CodexRateLimits {
  primary?: CodexRateLimitWindow | null;
  secondary?: CodexRateLimitWindow | null;
}

/** Raw usage window from the Claude OAuth usage API. */
interface ClaudeUsageWindow {
  utilization?: number | null;
  resets_at?: number | string | null;
}

/** Response shape from the Claude OAuth usage endpoint. */
interface ClaudeUsageResponse {
  five_hour?: ClaudeUsageWindow | null;
  seven_day?: ClaudeUsageWindow | null;
  seven_day_sonnet?: ClaudeUsageWindow | null;
}

/** Claude OAuth credentials stored in the macOS Keychain. */
interface ClaudeOauthCredentials {
  accessToken?: string | null;
  refreshToken?: string | null;
  expiresAt?: number | null;
  scopes?: string[] | null;
  subscriptionType?: string | null;
  rateLimitTier?: string | null;
  organizationUuid?: string | null;
}

/** Shape of the Keychain payload for Claude credentials. */
interface ClaudeKeychainPayload {
  organizationUuid?: string | null;
  claudeAiOauth?: ClaudeOauthCredentials | null;
}

/** Response from the Claude OAuth token refresh endpoint. */
interface ClaudeTokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
}

/** Serialized usage window for the on-disk cache. */
interface CachedUsageWindow {
  key: UsageWindowKey;
  label: string;
  shortLabel: string;
  usedPercent: number;
  resetsAt: string | null;
  windowMinutes: number | null;
}

/** A model-specific refusal ("You've reached your Fable limit...") from a real run. Independent of
 * `unavailable`: Claude can block one model family while the account stays healthy, so it must not
 * fold into the account-wide marker. No invented reset: without a clock it sticks until a success. */
interface CachedModelRefusal {
  family?: string;
  resetsAt?: string;
}

/** Serialized usage snapshot for the on-disk cache. */
export interface CachedUsageSnapshot {
  capturedAt: string | null;
  windows: CachedUsageWindow[];
  plan?: string | null;
  refreshHint?: string | null;
  unavailable?: {
    reason: 'session_limit' | 'out_of_credits';
    resetsAt?: string;
  };
  /** Per-model refusal markers keyed by model name, on the account row (accountId-preferring key,
   * see noteClaudeModelRefusal), not the org-shared usage key, so one login's per-model limit
   * cannot block a sibling. */
  modelRefusals?: Record<string, CachedModelRefusal>;
  /** D8: `poll` | `statusline` | `sync`. Survives export → ingest. */
  freshnessSource?: UsageCaptureSource;
  /** D8: device that polled or ingested the authoritative reading. */
  pollerDevice?: string;
}

/** Parsed rate-limit data extracted from a Codex session file. */
interface CodexRateLimitMatch {
  capturedAt: Date | null;
  rateLimits: CodexRateLimits;
}

interface UsageSource {
  fetch: (options?: UsageOptions) => Promise<UsageInfo>;
  network: boolean;
}

/** The single registry of agent usage sources and their transport. */
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

/** Fetch usage info for a given agent through the canonical source registry. */
export async function getUsageInfo(agentId: AgentId, options?: UsageOptions): Promise<UsageInfo> {
  const source = getUsageSource(agentId);
  return source ? source.fetch(options) : { snapshot: null, error: null };
}

/** Combine a caller abort signal (the daemon tick deadline) with a per-fetch timeout so a fetch is
 * bounded by whichever fires first (PHNX-3608). Without a caller signal it is just
 * `AbortSignal.timeout(ms)`. */
function usageFetchSignal(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

/** Derive a stable lookup key from account info for usage deduplication. */
export function getUsageLookupKey(
  info?: Pick<AccountInfo, 'usageKey' | 'accountKey'> | null
): string | null {
  return info?.usageKey || info?.accountKey || null;
}

/** Deduplicate identity inputs into canonical (most-recently-active) accounts and build the fetch
 * inputs for each unique usage key. */
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

/** Whether an agent exposes usage/limit data: Claude/Kimi/Droid/Cursor/Antigravity via a live API,
 * Codex/Grok via local session logs. For others (OpenCode) a missing snapshot is not applicable,
 * not "unavailable". */
export function agentReportsUsage(agentId: AgentId): boolean {
  return getUsageSource(agentId) !== undefined;
}

/** Whether an agent's usage source makes a live network call (Claude/Kimi/Droid/Cursor/Antigravity)
 * versus reading local logs (Codex/Grok). Both publish through the shared cache. */
export function agentUsesNetworkUsage(agentId: AgentId): boolean {
  return getUsageSource(agentId)?.network === true;
}

/** Concurrent live usage fetches per `agents view`/rotation pass: enough to finish a refresh in one
 * round trip, few enough that a cold cache of 10+ accounts cannot open 10+ HTTP calls at once. */
export const USAGE_FETCH_CONCURRENCY = 3;

/** Unified entry for every multi-account usage lookup (`agents view`, rotation, JSON export).
 * Deduplicates by usage identity and reads the shared snapshot; only an explicit `forceRefresh` may
 * collect provider state. */
interface UsageLookupOptions {
  forceRefresh?: boolean;
  fileOnly?: boolean;
  /** Daemon tick deadline signal, combined with each provider fetch's own timeout (PHNX-3608). */
  signal?: AbortSignal;
  /** Permit a foreground personal-device usage read to use the interactive login when no
   * setup-token exists (USAGE-READ-2). Set only by `agents view` when role is 'personal' and
   * output is a human TTY (not `--json`). */
  allowInteractiveLogin?: boolean;
  /** Headed poller: native `.credentials.json` only, never the setup-token. */
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

/** In-process dedup complements the device-wide lease, avoiding lock contention when several
 * callers in one process request the same refresh. */
const inFlightLiveFetches = new Map<string, Promise<UsageInfo>>();

/** Fetch usage for one identity. Ordinary callers read the shared cache; the daemon and explicit
 * `--refresh` collect through one device lease. */
export async function getUsageInfoForIdentity(
  input: UsageIdentityInput,
  opts?: UsageLookupOptions,
): Promise<UsageInfo> {
  const usageKey = getUsageLookupKey(input.info);
  const forceRefresh = opts?.forceRefresh === true;
  // Reading is the default. Only an explicit forceRefresh is authorized to
  // collect provider/local-log state; callers cannot accidentally turn a
  // display or routing path into a collector by omitting an option.
  const readOnly = !forceRefresh;

  // The shared on-disk cache is keyed by usageKey, which is namespaced per agent (`claude:org=...`,
  // `kimi:user=...`), so one file holds every account without collision.
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
  // `readOnly` (the `agents run` routing hot path) serves the cache and never touches the network;
  // a 5-minute `maxAgeMs` used to trigger a blocking live fetch per account at cold start. The
  // daemon (`runUsageRefresh`) keeps the cache fresh.
  if (readOnly) {
    // A row carries a CONFIRMED reading when it has a fresh window, a
    // subscription plan (meterless-healthy, e.g. Grok's tier), or a live refusal
    // (out_of_credits / session_limit). Those report `usageError: null`.
    if (cached && (cached.windows.length > 0 || cached.plan || cached.unavailable)) {
      return { snapshot: cached, error: null };
    }
    // A row holding only last-known stale readings (windows moved to view-only `staleWindows`)
    // must not read as healthy. `--json` projects only `windows`, so keep `usageError` non-null or
    // monitors lose the RUSH-2858 staleness signal.
    if (cached) return { snapshot: cached, error: USAGE_NOT_COLLECTED_MARKER };
    return { snapshot: null, error: USAGE_NOT_COLLECTED_MARKER };
  }

  // Explicit refresh: block on the shared device collector.
  return fetchLiveUsageDeduped(input, usageKey, cached, opts?.fileOnly === true, {
    allowInteractiveLogin: opts?.allowInteractiveLogin === true,
    nativeFileLogin: opts?.nativeFileLogin === true,
    signal: opts?.signal,
  });
}

/** Single-flight live usage fetch per usage key: concurrent callers (view, rotation, or rows
 * sharing an account) await one promise instead of opening duplicate HTTP requests that time out
 * and pile up. */
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
        // Scope this fetch's 429 backoff to the account being fetched, so one
        // throttled account cannot park the whole provider (RUSH-3036).
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

      // Live fetch failed — last-resort fallback to whatever cache we had.
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

/** Pick which usage windows to render in a compact one-line summary. Overview rows must stay
 * narrow, so prefer session + week, else the highest utilization. Returns the full set when
 * `maxWindows` is unset. */
export function pickCompactUsageWindows(
  windows: UsageWindow[],
  maxWindows?: number,
): UsageWindow[] {
  const filtered = windows.filter((window) => window.key !== 'sonnet_week');
  if (maxWindows === undefined || maxWindows <= 0 || filtered.length <= maxWindows) {
    return filtered;
  }

  // Pick by object identity, not by key. Antigravity normalizes every model
  // quota as key: 'session', so a key-set filter would keep only the first and
  // drop the rest even when maxWindows > 1.
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

/** Options for {@link formatUsageSummary}. */
export interface FormatUsageSummaryOpts {
  unavailable?: boolean;
  unverified?: boolean;
  /** Setup-token lacks `user:profile`, so usage cannot be read headlessly (RUSH-2392). Distinct
   * from generic `unverified`; minting again won't help and the account still runs. */
  headless?: boolean;
  /** Cap how many usage windows render on one line. Overview (`agents view` with no agent filter)
   * passes 2 so multi-window agents cannot blow out column width. */
  maxWindows?: number;
  /** Windows that must keep a visible slot even when the provider omits one. */
  expectedWindows?: Array<{ key: string; shortLabel: string }>;
  /** The classified cause of `usageInfo.error` (RUSH-3040), from classifyUsageErrorKind, so the
   * no-bars branch names the specific reason instead of a generic 'usage unavailable'. Consulted
   * only when `unavailable` is set; `--json` still carries the full message. */
  errorKind?: UsageErrorKind | null;
  /** The raw `UsageInfo.error` string, read only to pull the retry-time hint from a `rate-limited`
   * kind. */
  errorDetail?: string | null;
  /** Benign state from {@link getUsageBenignState}; never sourced from `UsageInfo.error`. */
  benignState?: UsageBenignState | null;
  /** Provider-specific replacement for the generic no-local-event marker. */
  noRecentUsageLabel?: string | null;
}

/** Shared builder for formatUsageSummary options in `agents view` and account-catalog rows, so
 * `headless`, `unverified`, `expectedWindows`, `errorKind`, `benignState` and the grok label are
 * set consistently. */
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

/** Human label for a classified usage error, for the no-bars branch of {@link formatUsageSummary}. */
function formatUsageErrorKindLabel(
  kind: UsageErrorKind | null | undefined,
  detail: string | null | undefined,
): string {
  switch (kind) {
    case 'no-credential':
      return 'sign in / provision token';
    // Both are permanent for the account as configured, and rendered as the generic bucket, which
    // reads as transient and sends operators to `claude setup-token` for a remedy that cannot work
    // (#2987).
    case 'no-usage-credential':
      return USAGE_NO_USAGE_CREDENTIAL_MARKER;
    case 'headless-scope':
      return USAGE_HEADLESS_SCOPE_MARKER;
    case 'expired-credential':
      // Kimi refreshes its own credential on a normal launch; the recovery hint
      // is embedded in the error string so the label matches the exact action.
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

/** Format a one-line usage summary with compact bars for inline display. */
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
    // A blocking marker renders AFTER the bars: leading it pushed every gauge
    // out of its column, so one throttled account misaligned the whole table.
    const blocked = snapshot.unavailable?.reason === 'out_of_credits'
      ? chalk.red('out of credits')
      : snapshot.unavailable?.reason === 'session_limit' && snapshot.unavailable.resetsAt
        ? chalk.yellow(`session-limited (${formatResetHint(snapshot.unavailable.resetsAt)})`)
        : null;
    // Compact rows show blocking windows, the set deriveUsageStatusFromSnapshot uses for the
    // rate-limited badge, so a month-throttled Droid account shows the explaining bar. Claude's
    // Sonnet week is a per-model sub-limit and renders only in the full section.
    const selected = pickCompactUsageWindows(snapshot.windows, opts?.maxWindows);
    const hidden = Math.max(
      0,
      snapshot.windows.filter((w) => w.key !== 'sonnet_week').length - selected.length,
    );
    // Last-known windows the freshness gate dropped (see UsageSnapshot.staleWindows).
    // Rendered with an age suffix so a stale reading stays visible instead of a
    // bare "unavailable"; never in `snapshot.windows`, so routing never sees them.
    const now = new Date();
    const staleWindows = snapshot.staleWindows ?? [];
    const staleByKey = new Map(staleWindows.map((w) => [w.key, w]));
    const expected = opts?.expectedWindows;
    const windowsToRender = expected
      ? expected.map(({ key, shortLabel }) => ({ key, window: selected.find((item) => item.key === key), shortLabel }))
      : selected.map((window) => ({ key: window.key, window, shortLabel: window.shortLabel }));
    const windowParts = windowsToRender.map(({ key, window, shortLabel }, index) => {
      if (!window) {
        // A window we expected but have no fresh reading for: render the
        // last-known value with its age if we still have it, else "unavailable".
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
      // No fresh bars, but we have last-known readings (e.g. Grok's weekly bar
      // from an ended billing period): show them with an age suffix rather than
      // the "run once to refresh" hint, which hid a number we actually had.
      const cap = opts?.maxWindows ?? staleWindows.length;
      const rendered = staleWindows
        .slice(0, cap)
        .map((w) => renderStaleUsageWindow(w, snapshot.capturedAt, w.shortLabel, now));
      parts.push(rendered.join('  '));
    } else if (snapshot.refreshHint) {
      parts.push(chalk.dim(snapshot.refreshHint));
    }
    // These bars came from the cache and the live read that should confirm them failed, so they
    // are last-seen, not current; unmarked, a 26h-old "48% used" read as fact. Headless-scope
    // (RUSH-2392) is permanent: prefer that label over "unverified" so operators do not re-mint.
    if (opts?.headless) {
      parts.push(chalk.dim(USAGE_HEADLESS_SCOPE_MARKER));
    } else if (opts?.unverified) {
      parts.push(chalk.yellow('unverified'));
    }
    if (blocked) parts.push(blocked);
  } else if (opts?.headless) {
    // No bars at all: still name the scope gap so "usage pending" is not
    // mistaken for a missing setup-token or seeding failure (RUSH-2392).
    parts.push(chalk.dim(USAGE_HEADLESS_SCOPE_MARKER));
  } else if (opts?.benignState === 'no-recent-usage') {
    parts.push(chalk.dim(opts.noRecentUsageLabel || USAGE_NO_RECENT_USAGE_MARKER));
  } else if (opts?.unavailable) {
    // Signed-in account we could not fetch usage for (no live token, org mismatch, or fetch
    // error): say so instead of a blank gauge that reads 0% used, and name the specific cause when
    // given (RUSH-3040).
    parts.push(chalk.dim(formatUsageErrorKindLabel(opts.errorKind, opts.errorDetail)));
  }

  return parts.join('  ');
}

/** The snapshot's windows still live (reset time not passed). A past-reset window shows the
 * previous period (PHNX-4116), so the throttle verdict and displayed `usedPercent` must both use
 * this set, or a reset account reads `available` beside a stale 99% (#3705). */
export function liveUsageWindows(snapshot: UsageSnapshot, now: number = Date.now()): UsageWindow[] {
  return snapshot.windows.filter((window) => !(window.resetsAt && window.resetsAt.getTime() <= now));
}

/** Derive an account's throttle state from its live usage windows: the one signal shared by the
 * `agents view` badge and rotation eligibility. A window at 100% means throttled until reset. Null
 * with no snapshot. Ignores `cachedExtraUsageDisabledReason` and the per-model `sonnet_week`. */
export function deriveUsageStatusFromSnapshot(
  snapshot: UsageSnapshot | null | undefined,
  now: number = Date.now(),
): 'available' | 'rate_limited' | null {
  if (!snapshot) return null;
  if (snapshot.unavailable) {
    // out_of_credits has no clock — it stays blocking until a successful run
    // clears it. session_limit blocks only until its reset time.
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

/** A prior sample of one window's utilization, for burn-rate projection. */
interface UsagePriorSample {
  /** Epoch ms the prior snapshot was captured. */
  capturedAt: number;
  /** The session window's `usedPercent` in that prior snapshot. */
  usedPercent: number;
}

/** Throttle state plus minutes until the 5-hour `session` window caps, projected from burn rate, so
 * routing can deprioritize an account burning toward its cap. `minutesToLimit`: 0 rate-limited; n
 * > 0 projected; null unknown. Pure: the daemon supplies `prev`. */
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
  // Flat, falling (a window reset), or a zero/negative time delta: no live burn
  // to project from, so this account is not "projected to cap".
  if (deltaPercent <= 0 || deltaMinutes <= 0) return { status, minutesToLimit: null };

  const burnPerMinute = deltaPercent / deltaMinutes;
  const remaining = Math.max(0, 100 - session.usedPercent);
  return { status, minutesToLimit: remaining / burnPerMinute };
}

/** Compact colored badge for the account's usage status, rendered only when throttled
 * (`out_of_credits` red, `rate_limited` yellow); `available` and null return ''. Same signal as
 * `usageStatus` in `agents view --json`. Exhaustive switch: a new status is a build error. */
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

/** Format a multi-line usage section for detailed agent views. */
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

/** Fetch Codex usage by scanning the most recent session files for rate-limit events. */
async function getCodexUsageInfo(options?: UsageOptions): Promise<UsageInfo> {
  try {
    // Codex usage comes from on-disk transcripts that carry no account identity and survive
    // logout, so floor the scan at the current login's `auth_time` to avoid showing a prior
    // account's rate_limits. Not the auth.json mtime (every refresh rewrites it).
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

      // Same freshness filter Grok applies (RUSH-3040): a window past its reset or windowMinutes
      // expiry is a stale read, which is how a codex bar kept showing "100% used". Try the
      // next-older session file instead.
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

    // No session recorded a rate-limit event on this machine, or none was fresh: a benign "nothing
    // to show yet", not a failure (RUSH-3040). Distinct from the outer catch, a genuine read/parse
    // failure.
    return usageNoRecentUsageInfo();
  } catch (err) {
    return { snapshot: null, error: usageUnreachableError('Codex', err) };
  }
}

/** The access token for a read-only Claude usage fetch, or null within the refresh leeway. Never
 * refresh: the refresh token is single-use and rotates, so refreshing here with one account on
 * several machines would invalidate every other holder (RUSH-1822). Pure. */
export function claudeUsageAccessTokenNoRefresh(
  oauth: Pick<ClaudeOauthCredentials, 'accessToken' | 'expiresAt'>,
): string | null {
  if (claudeAccessTokenNeedsRefresh(oauth.expiresAt ?? null)) return null;
  const token = oauth.accessToken?.trim();
  return token ? token : null;
}

/** Fetch Claude usage via the Anthropic OAuth usage API. */
async function getClaudeUsageInfo(options?: UsageOptions): Promise<UsageInfo> {
  try {
    // accessTokenCache: this 60s watchdog path reads only the file-based setup-token, never the
    // interactive login (RUSH-1822); `fileOnly` also forbids the ACL keychain. Exception:
    // allowInteractiveLogin (USAGE-READ-1/2): only that login has `user:profile` (RUSH-2392).
    const oauth = await loadClaudeOauth(options?.home, {
      accessTokenCache: options?.nativeFileLogin !== true,
      fileOnly: options?.fileOnly === true || options?.nativeFileLogin === true,
      allowInteractiveLogin: options?.allowInteractiveLogin === true,
      nativeFileLogin: options?.nativeFileLogin === true,
    });
    if (!oauth?.accessToken) {
      // Not the shared no-credential message: "sign in" is no remedy here. The account is usually
      // already signed in and the reader is forbidden from touching that login (RUSH-1822)
      // (#2987).
      return { snapshot: null, error: usageNoClaudeUsageCredentialError() };
    }

    const requestedOrgId = normalizeString(options?.organizationId);
    const liveOrgId = normalizeString(oauth.organizationUuid);
    if (!isClaudeUsageOrgMatch(requestedOrgId, liveOrgId)) {
      // Not a fault: this home is signed into a different org than the identity
      // being read, so there is nothing to report for it.
      return { snapshot: null, error: null };
    }

    // Read-only: never refresh a single-use token just to read usage (RUSH-1822).
    const accessToken = claudeUsageAccessTokenNoRefresh(oauth);
    if (!accessToken) {
      return { snapshot: null, error: usageExpiredCredentialError('Claude') };
    }

    // Honour a live Retry-After rather than re-arming the penalty (see
    // usage-backoff.ts). No request at all while the window is open.
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
      // Setup-token is user:inference only; usage needs user:profile → 403
      // with a scope-requirement body. Distinct from a real rejection so the
      // UI does not say "unverified" / re-mint (RUSH-2392).
      if (response.status === 403) {
        let bodyText = '';
        try {
          bodyText = await response.text();
        } catch {
          // ignore — fall through to generic rejection
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
    // A thrown request (timeout, DNS, TLS, a malformed payload) is a failed
    // read like any other — staying silent here would hand the caller a stale
    // snapshot to render as confirmed, which is the bug this file just closed.
    return { snapshot: null, error: usageUnreachableError('Claude', err) };
  }
}

/** Raw quota bucket from the Kimi /usages response (numbers arrive as strings). */
interface KimiUsageQuota {
  limit?: string | number | null;
  used?: string | number | null;
  remaining?: string | number | null;
  resetTime?: string | null;
}

/** Response shape from the Kimi Code /usages endpoint (subset we render). */
export interface KimiUsagesResponse {
  user?: { userId?: string | null; membership?: { level?: string | null } | null } | null;
  usage?: KimiUsageQuota | null;
  limits?: Array<{
    window?: { duration?: number | null; timeUnit?: string | null } | null;
    detail?: KimiUsageQuota | null;
  } | null> | null;
  subType?: string | null;
}

/** Resolve Kimi's OAuth credential file. Sign-in is account-global but versions have isolated
 * homes, so check the per-version home first, then the active location under the real HOME (as
 * resolveAccountCredentialPath). */
function resolveKimiCredentialPath(home?: string): string | null {
  const rel = ['.kimi-code', 'credentials', 'kimi-code.json'];
  const perVersion = path.join(home || os.homedir(), ...rel);
  try { if (fs.existsSync(perVersion)) return perVersion; } catch { /* unreadable */ }
  const active = path.join(process.env.AGENTS_REAL_HOME || os.homedir(), ...rel);
  if (active !== perVersion) {
    try { if (fs.existsSync(active)) return active; } catch { /* unreadable */ }
  }
  return null;
}

/** Fetch Kimi usage via the Kimi Code /usages API (the JWT has no email, so it renders quota
 * windows and tier). No token refresh: `agents view` must not rotate the OAuth credential or race
 * a running kimi CLI. If expired, the SWR cache serves the last-seen snapshot. */
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

    // Honour a live Retry-After rather than re-arming the penalty (see
    // usage-backoff.ts). No request at all while the window is open.
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

    // 401/403 => expired token, 404 => no Kimi For Coding subscription. Either
    // way there are no bars to draw, and the status is what tells them apart.
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
    // A thrown request (timeout, DNS, TLS, a malformed payload) is a failed
    // read like any other — staying silent here would hand the caller a stale
    // snapshot to render as confirmed, which is the bug this file just closed.
    return { snapshot: null, error: usageUnreachableError('Kimi', err) };
  }
}

/** Normalize the Kimi /usages payload into the common UsageWindow shape. */
export function normalizeKimiWindows(data: KimiUsagesResponse): UsageWindow[] {
  const windows: UsageWindow[] = [];

  // Per-window rate limit (e.g. a 300-minute bucket) -> "session".
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

  // Rolling account quota -> "week".
  const period = normalizeKimiWindow(data.usage, 'week', 'Current period', 'W', null);
  if (period) windows.push(period);

  return windows;
}

/** Normalize a single Kimi quota bucket (used/limit strings) into a UsageWindow. */
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

/** Parse a numeric field that Kimi serializes as a string (e.g. "100"). */
function kimiNumber(value: string | number | null | undefined): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '' && !Number.isNaN(Number(value))) {
    return Number(value);
  }
  return null;
}

/** Convert a Kimi limit window (duration + timeUnit enum) to minutes. */
function kimiWindowMinutes(
  window: { duration?: number | null; timeUnit?: string | null } | null | undefined
): number | null {
  const duration = typeof window?.duration === 'number' ? window.duration : null;
  if (duration === null || duration <= 0) return null;
  switch (window?.timeUnit) {
    case 'TIME_UNIT_HOUR': return duration * 60;
    case 'TIME_UNIT_SECOND': return duration / 60;
    default: return duration; // TIME_UNIT_MINUTE or unknown -> minutes
  }
}

/** Derive a display plan label from Kimi's membership tier or subscription type. */
export function formatKimiPlan(data: KimiUsagesResponse): string | null {
  const level = data.user?.membership?.level;
  const raw = (typeof level === 'string' && level) || (typeof data.subType === 'string' && data.subType) || '';
  const tail = raw.split('_').pop() || ''; // LEVEL_INTERMEDIATE -> INTERMEDIATE
  if (!tail) return null;
  return tail.charAt(0).toUpperCase() + tail.slice(1).toLowerCase();
}

/** A single Droid token-rate-limit window from /api/billing/limits. */
interface DroidLimitWindow {
  usedPercent?: number | null;
  windowEnd?: string | null;
}

/** Response shape from Factory.ai's billing limits endpoint (subset we render). */
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

/** Fetch Droid usage via Factory.ai's billing limits API, with the WorkOS token from
 * ~/.factory/auth.v2.file. Never refresh: single-use WorkOS refresh tokens would race a running
 * droid and can kill the login chain. If expired, the SWR cache serves the last-seen snapshot. */
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

    // Honour a live Retry-After rather than re-arming the penalty (see
    // usage-backoff.ts). No request at all while the window is open.
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

    // 401 => revoked/expired token. No bars to draw, and the status says why.
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
    // A thrown request (timeout, DNS, TLS, a malformed payload) is a failed
    // read like any other — staying silent here would hand the caller a stale
    // snapshot to render as confirmed, which is the bug this file just closed.
    return { snapshot: null, error: usageUnreachableError('Droid', err) };
  }
}

/** Live auth probes: the same authenticated GET as the usage fetchers, surfacing the raw HTTP
 * status. They back `agents fleet ping` and the auth-health cache, since a completed request is
 * the only proof a token is accepted. Verdict classification lives in lib/auth-health.ts (pure). */
export interface ProviderProbe {
  /** HTTP status of the probe request, or null when no request was made (missing/expired token) or the request threw. */
  status: number | null;
  /** Local credential state observed before the request. */
  token: 'present' | 'missing' | 'expired';
  /** Network/parse error message when status is null but a token was present. */
  error?: string;
  /** Known non-revocation cause for a non-2xx status. `usage_scope`: Anthropic 403 because the
   * setup-token lacks `user:profile` (RUSH-2392); valid for inference. Auth-health must not map it
   * to `revoked`. */
  reason?: 'usage_scope';
}

/** Probe Claude's OAuth token against the usage endpoint. Never refreshes — reports `expired` for a near-expiry token; see the comment below (RUSH-1822). */
export async function probeClaudeStatus(home?: string, cliVersion?: string | null, usageScope?: string | null, signal?: AbortSignal): Promise<ProviderProbe> {
  // accessTokenCache: the daemon warms this probe every ~3 min per account, so read only the
  // file-based setup-token, never the interactive login, which got it revoked (RUSH-1822). No
  // setup-token means 'missing'.
  const oauth = await loadClaudeOauth(home, { accessTokenCache: true });
  const accessToken = oauth?.accessToken?.trim();
  if (!accessToken) return { status: null, token: 'missing' };
  // Never refresh from a health probe: Claude's refresh token is single-use, so the daemon's 3-min
  // fleet-cache warm would stampede it and drop the fleet to "run /login" (RUSH-1822). Report the
  // non-fatal `expired` state; the one legitimate refresh is in getClaudeAccessToken.
  if (claudeAccessTokenNeedsRefresh(oauth?.expiresAt ?? null)) {
    return { status: null, token: 'expired' };
  }
  // While the provider's Retry-After window is open, report the recorded throttle instead of
  // firing again and re-arming it (usage-backoff.ts); this 3-min probe is what created that loop.
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
    // Setup-token is user:inference only; usage needs user:profile → 403.
    // That is NOT a revocation — the account still runs (RUSH-2392).
    if (response.status === 403) {
      let bodyText = '';
      try {
        bodyText = await response.text();
      } catch {
        // Body unreadable: fall through to a bare 403 (classified as revoked).
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

/** Probe Kimi's OAuth token against the /usages endpoint. Never refreshes (single-use rotation — see getKimiUsageInfo). */
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
  // While the Retry-After window is open, report the recorded throttle instead of re-arming it
  // (usage-backoff.ts). It sits after the local missing/expired checks so a broken credential is
  // not misreported as throttled.
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

/** Probe Droid's WorkOS token against the billing-limits endpoint. Never refreshes (single-use rotation — see getDroidUsageInfo). */
export async function probeDroidStatus(home?: string, usageScope?: string | null, signal?: AbortSignal): Promise<ProviderProbe> {
  const cred = decryptDroidAuthPayload(home || os.homedir());
  const accessToken = cred?.access_token;
  if (typeof accessToken !== 'string' || !accessToken) return { status: null, token: 'missing' };
  const exp = decodeJwtPayload(accessToken)?.exp;
  if (typeof exp === 'number' && Date.now() / 1000 >= exp) return { status: null, token: 'expired' };
  // While the provider's Retry-After window is open, report the recorded throttle instead of
  // firing again and re-arming it (usage-backoff.ts); this 3-min probe is what created that loop.
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

/** Normalize the Factory billing-limits payload into UsageWindow. Orgs on the legacy (non
 * token-rate-limit) billing model have no windows, mirroring droid's own check of
 * `usesTokenRateLimitsBilling`. */
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

/** Normalize a single Droid billing-limits window. */
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

/** Collect Codex JSONL session files newest-first. Transcripts carry no account tag, so the
 * `sinceMs` mtime floor keeps usage account-scoped: older sessions belong to a prior account (see
 * getCodexUsageInfo). */
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

/** Stream a Codex JSONL file and return the last rate_limits payload found. */
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
        /* malformed session line */
      }
    });

    rl.on('close', () => resolve(latest));
    rl.on('error', () => resolve(latest));
  });
}

/** Normalize Codex rate-limit windows into the common UsageWindow shape. */
function normalizeCodexWindows(rateLimits: CodexRateLimits): UsageWindow[] {
  return [rateLimits.primary, rateLimits.secondary]
    .map(normalizeCodexWindow)
    .filter((window): window is UsageWindow => window !== null)
    .sort((a, b) => (a.windowMinutes ?? 0) - (b.windowMinutes ?? 0));
}

/** Normalize a single Codex rate-limit window. */
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

/** Codex assigns quota windows to primary/secondary by plan, so duration carries their meaning. */
function classifyCodexWindow(windowMinutes: number | null): Pick<UsageWindow, 'key' | 'label' | 'shortLabel'> {
  if (windowMinutes !== null && windowMinutes >= 28 * 24 * 60) {
    return { key: 'month', label: 'Current month', shortLabel: 'M' };
  }
  if (windowMinutes !== null && windowMinutes >= 7 * 24 * 60) {
    return { key: 'week', label: 'Current week', shortLabel: 'W' };
  }
  return { key: 'session', label: 'Current session', shortLabel: 'S' };
}

/** Normalize Claude API usage windows into the common UsageWindow shape. */
function normalizeClaudeWindows(data: ClaudeUsageResponse): UsageWindow[] {
  const windows = [
    normalizeClaudeWindow(data.five_hour, 'session', 'Current session', 'S'),
    normalizeClaudeWindow(data.seven_day, 'week', 'Current week (all models)', 'W'),
    normalizeClaudeWindow(data.seven_day_sonnet, 'sonnet_week', 'Current week (Sonnet only)', 'So'),
  ];

  return windows.filter((window): window is UsageWindow => window !== null);
}

/** Normalize a single Claude API usage window. */
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

/** Parse a wrapped Claude OAuth payload (`{ claudeAiOauth, organizationUuid }`, from the macOS
 * Keychain item or Linux `.credentials.json`) into our struct. Null when there is no usable access
 * token; never throws. */
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

// Retired subsystem: earlier versions cached Claude's OAuth access token in a no-ACL keychain item
// to avoid Touch ID. Read-only probes now use only a file-based setup-token, so nothing populates
// it, but deleteCachedClaudeOauth still evicts any stale copy on credential rotation.
const CLAUDE_OAUTH_CACHE_PREFIX = 'agents-cli.claude-oauth-cache.';

/** The no-ACL cache item name for a Claude keychain service (hashed to stay tidy). */
function claudeOauthCacheItem(service: string): string {
  const hash = createHash('sha256').update(service).digest('hex').slice(0, 16);
  return `${CLAUDE_OAUTH_CACHE_PREFIX}${hash}`;
}

/** Evict any no-ACL access-token cache item so a rotation or sign-out is reflected immediately. The
 * cache is retired, but an earlier agents-cli version may have written an old no-ACL copy of the
 * token. */
function deleteCachedClaudeOauth(service: string): void {
  try {
    deleteKeychainTokenSync(claudeOauthCacheItem(service));
  } catch {
    /* best-effort — cache is an optimization */
  }
}

/** Load a version home's Claude OAuth credential from the OS keychain (macOS) else
 * `<home>/.claude/.credentials.json` (headless Linux). `accessTokenCache`: setup-token only, never
 * the interactive login (RUSH-1822); Rush Cloud never calls this (RUSH-2359). `fileOnly`: no ACL. */
/** True when `<home>/.claude/.credentials.json` is a native rotating OAuth blob. */
export function claudeHomeHasNativeOauthFile(home?: string): boolean {
  return readClaudeNativeCredentialsFile(home) !== null;
}

function readClaudeNativeCredentialsFile(home?: string): ClaudeOauthCredentials | null {
  const credsPath = path.join(home ?? os.homedir(), '.claude', '.credentials.json');
  try {
    if (!fs.existsSync(credsPath)) return null;
    const parsed = parseClaudeOauthPayload(fs.readFileSync(credsPath, 'utf-8'));
    // A native rotating blob has a refresh token. A setup-token-shaped file
    // (access only) is not a native login and must not be polled as one.
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
  // Headed usage poller: the native rotating blob in `.credentials.json` is
  // the only credential that carries `user:profile` without opening the ACL
  // keychain (Touch ID) or firing a setup-token that 403s on /oauth/usage.
  if (opts?.nativeFileLogin === true) {
    return readClaudeNativeCredentialsFile(home);
  }
  // Read-only usage/probe callers authenticate only with a file-based setup-token from the `auth`
  // bundle, never the interactive login. The endpoint accepts any sk-ant-oat01 bearer and the file
  // token never pops Touch ID. With none provisioned the probe reports unprovisioned.
  if (opts?.accessTokenCache === true) {
    const setupToken = resolveClaudeSetupToken(home);
    if (setupToken) {
      // No expiresAt: a setup-token is long-lived and non-rotating, and a null expiry reads as
      // fresh (claudeAccessTokenNeedsRefresh), so the probe never refreshes it. The endpoint
      // reveals real revocation.
      return { accessToken: setupToken };
    }
    // No setup-token: a read-only probe must not use the interactive login, or the daemon's usage
    // and auth-health warms would send that ACL-bound token to api.anthropic.com and get it
    // revoked (RUSH-1822). Exception: allowInteractiveLogin (USAGE-READ-1/2).
    if (opts?.allowInteractiveLogin !== true) {
      return null;
    }
  }

  // Full-credential callers (isClaudeAuthValid -> getClaudeAccessToken) legitimately read the
  // interactive login to run/refresh Claude; Rush Cloud dispatch does not (SING-1b / RUSH-2359).
  // The keychain step is macOS/Linux only; Windows and `fileOnly` go to `.credentials.json`.
  if (!opts?.fileOnly && (process.platform === 'darwin' || process.platform === 'linux')) {
    const service = getClaudeKeychainService(home);
    try {
      const fromKeychain = parseClaudeOauthPayload(getKeychainTokenSync(service));
      if (fromKeychain) return fromKeychain;
    } catch {
      // No keychain item, or no reachable keyring (headless Linux) — fall through.
    }
  }

  const credsPath = path.join(home ?? os.homedir(), '.claude', '.credentials.json');
  try {
    if (fs.existsSync(credsPath)) {
      return parseClaudeOauthPayload(fs.readFileSync(credsPath, 'utf-8'));
    }
  } catch {
    // Unreadable file — treat as not signed in.
  }
  return null;
}

/** Save Claude OAuth credentials to the system keychain/keyring: read the existing payload, merge
 * the new fields, write back. Exported for regression tests only. */
async function saveClaudeOauth(
  home: string | undefined,
  credentials: ClaudeOauthCredentials
): Promise<boolean> {
  // Windows not yet supported: Claude Code keeps its credential in the file
  // there, so the rotated credential is written by the harness, not here.
  if (process.platform !== 'darwin' && process.platform !== 'linux') {
    return false;
  }

  try {
    const service = getClaudeKeychainService(home);

    // Read existing payload to preserve other fields
    let existingPayload: ClaudeKeychainPayload = {};
    try {
      const stdout = getKeychainTokenSync(service);
      existingPayload = JSON.parse(stdout.trim()) as ClaudeKeychainPayload;
    } catch {
      // No existing entry, start fresh
    }

    // Merge new credentials into existing payload
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

    // Delete existing entry first, then add updated entry
    try {
      await deleteKeychainToken(service);
    } catch {
      // Entry might not exist, ignore
    }

    await setKeychainToken(service, payloadJson);
    // A new credential rotation means any cached access token is stale.
    deleteCachedClaudeOauth(service);
    return true;
  } catch {
    return false;
  }
}

/** Derive the Keychain service name for a Claude home; managed (non-default) homes get a hash
 * suffix. */
export function getClaudeKeychainService(home?: string): string {
  if (!home) {
    return CLAUDE_KEYCHAIN_SERVICE;
  }

  const configDir = path.join(home, '.claude').normalize('NFC');
  const hash = createHash('sha256').update(configDir).digest('hex').slice(0, 8);
  return `${CLAUDE_KEYCHAIN_SERVICE}-${hash}`;
}

/** Whether a requested org ID matches the live OAuth org ID; true when either is absent or they
 * match. */
export function isClaudeUsageOrgMatch(
  requestedOrgId: string | null | undefined,
  liveOrgId: string | null | undefined
): boolean {
  const requested = normalizeString(requestedOrgId);
  const live = normalizeString(liveOrgId);
  return !requested || !live || requested === live;
}

/** Read a cached usage snapshot for a given usage key. Returns null if absent or stale. */
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

/** Delete an expired cache row only if it is still expired under the write lock. */
export function pruneExpiredClaudeUsageCacheEntry(
  usageKey: string,
  cachePath = getClaudeUsageCachePath(),
  now = new Date(),
): void {
  try {
    ensureLockTarget(cachePath, '{}');
    withFileLock(cachePath, () => {
      // The row may have been refreshed after readClaudeUsageCache observed it.
      // Re-read under the lock so stale cleanup cannot erase that newer write.
      const latest = readClaudeUsageCacheFile(cachePath);
      const current = latest[usageKey];
      if (!current || deserializeClaudeUsageSnapshot(current, now)) return;
      delete latest[usageKey];
      atomicWriteFileSync(cachePath, JSON.stringify(latest, null, 2), 'utf-8');
    });
  } catch {
    /* best-effort cache cleanup — lock busy or disk full */
  }
}

/** Write a usage snapshot to the on-disk cache. */
export function writeClaudeUsageCache(
  usageKey: string,
  snapshot: UsageSnapshot,
  cachePath = getClaudeUsageCachePath()
): void {
  try {
    ensureLockTarget(cachePath, '{}');
    withFileLock(cachePath, () => {
      // Re-read under the lock so a concurrent daemon tick / agents view
      // refresh cannot drop another account's row (lost update).
      const cache = readClaudeUsageCacheFile(cachePath);
      const prior = cache[usageKey];
      cache[usageKey] = {
        ...serializeClaudeUsageSnapshot({
          ...snapshot,
          unavailable: carryForwardUnavailable(prior?.unavailable, snapshot.unavailable),
        }),
        // A per-model refusal has its own lifecycle
        // (noteClaudeModelRefusal/clearClaudeModelRefusal), so a global usage write must not drop
        // it, as with `unavailable` above.
        modelRefusals: prior?.modelRefusals,
      };
      atomicWriteFileSync(cachePath, JSON.stringify(cache, null, 2), 'utf-8');
    });
  } catch {
    /* best-effort cache write — lock busy or disk full */
  }
}

/** Atomically merge partial native Claude windows into the current fresh row. */
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
        // See writeClaudeUsageCache: a per-model refusal survives a windows-only merge too.
        modelRefusals: prior?.modelRefusals,
      };
      atomicWriteFileSync(cachePath, JSON.stringify(cache, null, 2), 'utf-8');
    });
  } catch {
    /* best-effort cache write — lock busy or disk full */
  }
}

/** Export the local usage cache rows worth publishing to fleet peers (PHNX-3392): raw serialized
 * rows by usage identity, only those with at least one window. Uses the on-disk form, so no Date
 * round-trip. */
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

/** Merge usage rows from a fleet peer newest-wins by `capturedAt` (PHNX-3392); a row without one
 * never displaces a timestamped row. Locked and atomic via the async lock, since it runs per peer
 * on the daemon tick (PHNX-4116). Not role-gated: newest-wins is the safety property. */
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
          // Keep local unless the incoming row PROVES it is strictly newer.
          if (incomingMs === null) continue;
          if (priorMs !== null && priorMs >= incomingMs) continue;
        }
        cache[key] = row;
        merged += 1;
      }
      if (merged > 0) writeClaudeUsageCacheFile(cache, cachePath);
    });
  } catch {
    /* best-effort cache write — lock busy or disk full */
  }
  return merged;
}

/** Read the entire usage cache file from disk. */
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

/** Write the entire usage cache to disk. Best-effort; failures are silent. */
function writeClaudeUsageCacheFile(
  cache: Record<string, CachedUsageSnapshot>,
  cachePath: string
): void {
  try {
    fs.mkdirSync(path.dirname(cachePath), { recursive: true });
    atomicWriteFileSync(cachePath, JSON.stringify(cache, null, 2), 'utf-8');
  } catch {
    /* best-effort cache write */
  }
}

/** Convert a live UsageSnapshot to its JSON-serializable cached form. */
function serializeClaudeUsageSnapshot(snapshot: UsageSnapshot): CachedUsageSnapshot {
  // Persist the union of `windows` and `staleWindows`: deserialize re-partitions on read. Grok's
  // collector pre-partitions in the fetch, so serializing only `windows` dropped a just-captured
  // ended-period reading and the next cached `agents view grok` showed the plan alone.
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

/** Deserialize a cached snapshot, dropping windows past reset. An expired window is unknown, not
 * 0%: keeping it zeroed rendered a frozen cache as "S: 0%" and 'available' for a rate-limited
 * account (RUSH-2858). Dropped windows stay on `staleWindows`; a row with nothing to show is null. */
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
  // Dropped windows are still the last reading we saw: routing must not trust them (out of
  // `windows`), but the view renders them with an age suffix (see UsageSnapshot.staleWindows).
  // Skip meters that have a fresh row.
  const freshKeys = new Set(windows.map((window) => window.key));
  const staleWindows = deserialized.filter(
    (window) => !freshKeys.has(window.key) && !isCachedUsageWindowFresh(window, capturedAt, now),
  );

  const unavailable = deserializeUnavailable(snapshot.unavailable, now);

  // A windowless row is not worthless: Grok reports a tier and no meters, so treating it as
  // nothing cached pruned `{plan: 'SuperGrok Heavy'}` and rendered "usage unavailable". Keep a
  // plan-bearing row; zero windows yield null status, never a 0% bar (RUSH-2858).
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

/** Carry a prior refusal marker forward across a daemon usage refresh and drop an expired one. A
 * live `snapshot.unavailable` wins. `out_of_credits` survives until a successful run clears it;
 * `session_limit` only while its reset is in the future. */
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

/** Deserialize a cached `unavailable` marker, dropping an expired session_limit but keeping a
 * clock-less out_of_credits. */
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

/** Whether any per-model refusal in the row is still live (not clock-expired). */
function hasLiveModelRefusal(
  modelRefusals: CachedUsageSnapshot['modelRefusals'],
  now: Date,
): boolean {
  if (!modelRefusals) return false;
  return Object.values(modelRefusals).some((entry) => {
    if (!entry.resetsAt) return true; // no clock given — sticky until cleared
    const reset = parseDateValue(entry.resetsAt);
    return !reset || reset.getTime() > now.getTime();
  });
}

/** Persist a Claude tokens/credits exhaustion from a real run. It does not reset on a clock, so no
 * reset time is stored; rotation excludes the account until a later success calls
 * clearClaudeAccountRefusal. */
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
    /* best-effort cache write — lock busy or disk full */
  }
}

/** Clear any persisted refusal marker after a run succeeds on the account. This is the recovery
 * path for `out_of_credits` (no clock) and clears a stale `session_limit` as soon as the account
 * serves again. */
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
    /* best-effort cache write */
  }
}

/** Persist a Claude session-limit refusal from a real run until its stated reset; this quota is not
 * part of Anthropic's five-hour/weekly usage response. */
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
    /* best-effort cache write — lock busy or disk full */
  }
}

/** Persist a Claude model-specific refusal ("You've reached your Fable limit..."), which excludes
 * one model, not the account. `accountKey` must be the native-account key (`candidateAccountKey`),
 * never the org-shared `usageKey`. `resetsAt` only if the text had one; else sticky until cleared. */
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
    /* best-effort cache write — lock busy or disk full */
  }
}

/** Clear a model-refusal marker for exactly one (account, model) after a run succeeds on that pair.
 * Never clears a sibling model, and the caller must have a real completed success, not a detach or
 * unknown outcome. */
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
    /* best-effort cache write */
  }
}

/** Read a live model-refusal marker for (accountKey, model), or null if none or its clock passed. A
 * marker with no `resetsAt` is sticky until clearClaudeModelRefusal observes a real success. */
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

/** Parse Claude's model-specific refusal ("You've reached your Fable limit. Run
 * /usage-credits..."). Narrow on purpose, unlike RATE_LIMIT_PATTERNS, so a session merely
 * discussing `/usage-credits` is not a false positive. Accepts straight and curly apostrophes. */
export function parseClaudeModelRefusal(text: string): { family: string } | null {
  const candidates = [text];
  for (const line of text.split('\n')) {
    try {
      const row = JSON.parse(line);
      if (row.type === 'result' && row.is_error && typeof row.result === 'string') candidates.push(row.result);
      if (row.type === 'assistant' && row.isApiErrorMessage && Array.isArray(row.message?.content)) {
        candidates.push(row.message.content.filter((block: { type?: string }) => block.type === 'text').map((block: { text?: string }) => block.text ?? '').join('\n'));
      }
    } catch { /* Plain terminal output is checked directly. */ }
  }
  for (const candidate of candidates) {
    const match = /(?:^|\n)\s*You['’]ve reached your ([^\n.]+) limit\.\s*Run \/usage-credits to continue or switch models with \/model\./i.exec(candidate);
    if (match) return { family: match[1].trim() };
  }
  return null;
}

/** Parse Claude's `hit your session limit · resets …` refusal. */
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

/** Check whether a cached usage window is still relevant (not expired or reset). */
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

/** Obtain a valid access token, refreshing if expired. Saves refreshed tokens to Keychain. */
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

  // Persist refreshed credentials to Keychain so they survive across runs
  await saveClaudeOauth(home, refreshed);

  return refreshed.accessToken.trim();
}

/** Refresh an expired Claude OAuth access token using the refresh token. */
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

/** Whether the Claude OAuth credentials for a home are usable, refreshing an expired access token.
 * True only when a valid access token can be obtained. */
export async function isClaudeAuthValid(home?: string): Promise<boolean> {
  const oauth = await loadClaudeOauth(home);
  if (!oauth) return false;
  const token = await getClaudeAccessToken(oauth, home);
  return token !== null;
}

/** Build a User-Agent string for Claude API requests. */
function getClaudeUserAgent(cliVersion?: string | null): string {
  return cliVersion ? `claude-code/${cliVersion}` : 'claude-code';
}

/** Clamp a numeric value to 0..100, returning null for non-finite values. */
function normalizePercent(value: number | null | undefined): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return null;
  }
  return Math.max(0, Math.min(100, value));
}

/** Validate and return a positive window duration, or null. */
function normalizeWindowMinutes(value: number | null | undefined): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    return null;
  }
  return value;
}

/** Infer the window duration in minutes from a well-known window key. */
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

/** Parse a date value from a number (epoch seconds or ms) or ISO string. */
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

/** Trim and return a string, or null if empty/non-string. */
function normalizeString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed || null;
}

/** Render a full-width usage bar for detailed views. */
function renderUsageBar(usedPercent: number): string {
  return renderBar(usedPercent, USAGE_BAR_LEN);
}

/** Render a compact usage bar for inline summaries. */
function renderCompactUsageBar(usedPercent: number): string {
  return renderBar(usedPercent, COMPACT_BAR_LEN);
}

/** Render a proportional colored progress bar at one-eighth-cell resolution. */
export function renderBar(usedPercent: number, length: number): string {
  const clamped = Math.max(0, Math.min(100, usedPercent));
  const eighths = Math.round((clamped / 100) * length * 8);
  const filled = Math.floor(eighths / 8);
  const partial = eighths % 8;
  const color = getUsageColor(usedPercent);
  const gauge = FULL.repeat(filled) + PARTIAL_BLOCKS[partial];
  return color(gauge) + chalk.dim(EMPTY.repeat(length - filled - (partial > 0 ? 1 : 0)));
}

/** Apply the appropriate color to a text string based on usage percentage. */
function colorUsage(text: string, usedPercent: number): string {
  return getUsageColor(usedPercent)(text);
}

/** Return a chalk color function based on the usage percentage threshold. */
export function getUsageColor(usedPercent: number): (text: string) => string {
  if (usedPercent >= 100) return chalk.red;
  if (usedPercent >= 80) return chalk.yellow;
  return chalk.cyan;
}

/** Format a percentage value with at most one decimal place. */
function formatPercent(value: number): string {
  const rounded = Math.round(value * 10) / 10;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
}

/** Compact "time until reset" hint for inline bars ("5m", "2h", "3d", "now"). Single-unit and
 * coarse so it fits after a bar; `formatResetAt` carries the precise time. */
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

/** Compact elapsed-time label for a stale reading's age ("30m", "6h", "2d"), floored at "1m" so a
 * just-expired window never reads "0m". */
function formatAgeShort(diffMs: number): string {
  const mins = Math.max(1, Math.round(diffMs / 60000));
  if (mins < 60) return `${mins}m`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.round(hours / 24);
  return `${days}d`;
}

/** Staleness suffix for a last-known window. If the reset boundary passed while the sample is
 * inside its `windowMinutes`, the period rolled over: "period ended 1h". If it aged past
 * `windowMinutes`, report the capture age ("6h old"). Falls back to the reset age, then "stale". */
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

/** Render a dropped last-known window as "S: ▍░░░░ 30%* (6h old)": live-style gauge plus the `*`
 * stale marker and a dim age. View-only; never in `snapshot.windows`, so routing never sees it. */
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

/** Format a reset timestamp as a human-readable relative or absolute time. */
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

/** Safe wrapper around fs.realpathSync that returns null on error. */
function safeRealpathSync(filePath: string): string | null {
  try {
    return fs.realpathSync(filePath);
  } catch {
    return null;
  }
}

/** Safe wrapper around fs.statSync that returns null on error. */
function safeStatSync(filePath: string): fs.Stats | null {
  try {
    return fs.statSync(filePath);
  } catch {
    return null;
  }
}

/** Resolve the Grok billing log. Grok writes `unified.jsonl` only to the shared ~/.grok even though
 * GROK_HOME isolates per-version auth; a per-version log wins if present, else the shared path is
 * returned with `shared: true`. The ownerless shared file must not be stamped on every home. */
function resolveGrokBillingLogPath(home: string | undefined): {
  logPath: string;
  shared: boolean;
} | null {
  const rel = ['.grok', 'logs', 'unified.jsonl'];
  const perVersion = path.join(home || os.homedir(), ...rel);
  try { if (fs.existsSync(perVersion)) return { logPath: perVersion, shared: false }; } catch { /* unreadable */ }
  // `AGENTS_REAL_HOME` is the seam every version-home consumer honors: a
  // daemon/service-manager child's HOME can be baked to something other than
  // the account's real home, so os.homedir() alone is not a reliable stand-in.
  const shared = path.join(process.env.AGENTS_REAL_HOME || os.homedir(), ...rel);
  if (shared !== perVersion) {
    try { if (fs.existsSync(shared)) return { logPath: shared, shared: true }; } catch { /* unreadable */ }
  }
  return null;
}

/** Identity from Grok `auth.json` or, rarely, a billing line. Live billing lines carry no
 * user/email, so shared-log attribution falls through to sharedGrokLogAppliesToHome. */
interface GrokAuthIdentity {
  userId: string | null;
  email: string | null;
}

/** This home's own `.grok/auth.json` only — never the shared-home fallback. */
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

/** Whether the shared `~/.grok` billing log may attach to this home. Logins are per version home
 * and the shared last line is one account's meter, so fail loud rather than copy it onto every
 * identity. */
function sharedGrokLogAppliesToHome(home: string | undefined, match: GrokBillingMatch): boolean {
  const realHome = process.env.AGENTS_REAL_HOME || os.homedir();
  const requestedHome = home || os.homedir();
  const thisId = readGrokAuthIdentity(requestedHome);
  if (match.identity) {
    return grokIdentitiesMatch(match.identity, thisId);
  }
  // No identity on the line (the live Grok shape). Attribute the reading to
  // exactly one canonical identity: the real home itself, or the version home
  // whose own auth.json matches the shared `~/.grok/auth.json`.
  if (sameHomePath(requestedHome, realHome)) return true;
  return grokIdentitiesMatch(thisId, readGrokAuthIdentity(realHome));
}

/** Parse the latest billing info from Grok's unified log. */
async function getGrokUsageInfo(options?: UsageOptions): Promise<UsageInfo> {
  try {
    const resolved = resolveGrokBillingLogPath(options?.home);
    // No log yet: a benign "nothing recorded here", not a failure (RUSH-3040).
    if (!resolved) return usageNoRecentUsageInfo();

    const match = await readLatestGrokBilling(resolved.logPath);
    if (!match) return usageNoRecentUsageInfo();
    if (resolved.shared && !sharedGrokLogAppliesToHome(options?.home, match)) {
      return usageNoRecentUsageInfo();
    }
    // Grok has no live usage API (`network: false`); bars are last-seen from this machine's
    // unified.jsonl. Drop windows whose billing period ended so a stale 100% doesn't paint
    // rate-limited after reset. A missing `creditUsagePercent` never becomes a 0% bar.
    const now = new Date();
    const windows = match.windows.filter((window) =>
      isCachedUsageWindowFresh(window, match.capturedAt, now)
    );
    // A window from an ended billing period is the last reading seen: kept out of `windows` so
    // routing ignores it, but rendered with a "period ended Xh ago" suffix. The refresh hint
    // stands alone only if nothing shows.
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

/** Muse Code usage: prefer live Meta Model API rate-limit headers when a key is available
 * (META_API_KEY / MODEL_API_KEY / ~/.config/muse/auth.json), else aggregate
 * `model_completed.usage` from local session logs over the last 7 days. */
async function getMuseUsageInfo(options?: UsageOptions): Promise<UsageInfo> {
  try {
    const base = options?.home || os.homedir();

    // Honour a live Retry-After rather than re-arming the penalty (usage-backoff.ts). The local
    // log fallback still works while throttled, so report the throttle only when nothing else can
    // be shown.
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

    // No live snapshot and no local log — every source came up empty. Only
    // now does the probe's own outcome become the reported error, mirroring
    // Cursor's "surface the last resort's failure" pattern above.
    if (!probe.hasKey) return { snapshot: null, error: usageNoCredentialError('Muse') };
    if (probe.noHeaders) return usageNoRecentUsageInfo();
    return {
      snapshot: null,
      error: classifyUsageFetchFailure('Muse', 'muse', probe.status, probe.retryAfter, options?.usageScope),
    };
  } catch (err) {
    // A thrown request (timeout, DNS, TLS, a malformed payload) is a failed
    // read like any other — staying silent here would hand the caller a stale
    // snapshot to render as confirmed (RUSH-3040).
    return { snapshot: null, error: usageUnreachableError('Muse', err) };
  }
}

/** Resolve a Muse API key from env or auth.json without logging the value. */
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
    /* unreadable auth */
  }
  return null;
}

/** Result of {@link probeMuseRateLimits} — the live snapshot, or enough of the failure for the caller to classify it. */
interface MuseProbeResult {
  snapshot: UsageSnapshot | null;
  /** False when no API key was resolvable at all (env/auth.json) — a no-credential state, not a fetch failure. */
  hasKey: boolean;
  /** The response's HTTP status when the fetch completed but failed, else null (unauthenticated, or the request threw). */
  status: number | null;
  retryAfter: string | null;
  /** True when the response was 2xx but carried none of the rate-limit headers — not a failure, just nothing to report. */
  noHeaders: boolean;
}

/** Probe Meta Model API for rate-limit headers via GET /v1/models (no token spend). The CALLER
 * notes the 429 backoff via classifyUsageFetchFailure, so a throttled read is recorded once on any
 * branch. */
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

/** Aggregate Muse session token usage from local session.jsonl files for the last 7 days, against a
 * 10M-token soft visibility scale (Meta is pay-as-you-go with no hard local cap). */
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
        /* skip unreadable session */
      }
    }
  };
  walk(root);

  const total = inputTokens + outputTokens + cachedTokens;
  if (total === 0 && files === 0) return null;

  // Soft 10M-token scale for the bar (pay-as-you-go has no hard local cap).
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
  /** Present only when the billing line itself names a user/email. Live Grok lines do not. */
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
            // `creditUsagePercent` is Grok's weekly credit consumption (0-100); the period `end`
            // is the reset. Do not coerce a missing percent to 0: a new period often has a billing
            // line before the gauge, and 0% would make `agents view` disagree across devices.
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
        /* malformed session line */
      }
    });

    rl.on('close', () => resolve(latest));
    rl.on('error', () => resolve(latest));
  });
}

/** Per-model bucket in Cursor's /api/usage response. */
interface CursorUsageModel {
  numRequests?: number | null;
  maxRequestUsage?: number | null;
}

/** Response shape from Cursor's dashboard usage endpoint. */
interface CursorUsageResponse {
  /** The premium ("fast request") bucket the plan meters. */
  'gpt-4'?: CursorUsageModel | null;
  /** ISO timestamp the monthly request window resets from. */
  startOfMonth?: string | null;
  [model: string]: CursorUsageModel | string | null | undefined;
}

/** Normalize Cursor's /api/usage payload to UsageWindow. Only free/legacy plans carry
 * `maxRequestUsage` on the premium bucket (a monthly request cap); usage-based plans report null
 * and return no windows, not an empty gauge. */
export function normalizeCursorUsage(data: CursorUsageResponse): UsageWindow[] {
  const premium = data['gpt-4'];
  if (!premium || typeof premium !== 'object') return [];
  const max = premium.maxRequestUsage;
  if (typeof max !== 'number' || !Number.isFinite(max) || max <= 0) return [];
  const used = typeof premium.numRequests === 'number' ? premium.numRequests : 0;

  const startOfMonth =
    typeof data.startOfMonth === 'string' ? parseDateValue(data.startOfMonth) : null;
  // The request quota resets one calendar month after the period start. Clamp the month-end
  // overflow: setMonth on Jan 31 -> Feb 31 rolls into March, so clamp to the target month's last
  // day.
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

/** Per-window plan usage percentages Cursor's dashboard breaks usage into (Auto+Composer / API / Total). */
interface CursorPlanUsage {
  autoPercentUsed?: number | null;
  apiPercentUsed?: number | null;
  totalPercentUsed?: number | null;
}

/** Response shape from Cursor's dashboard current-period-usage endpoint (subset we render). */
interface CursorPeriodUsageResponse {
  planUsage?: CursorPlanUsage | null;
  /** ISO timestamp, or a unix-ms string, marking the end of the current billing cycle. */
  billingCycleEnd?: string | number | null;
}

/** Response shape from Cursor's usage-summary endpoint (subset we render). */
interface CursorUsageSummaryResponse {
  /** True on a plan with no consumption cap; only tiered self-serve plans populate the percent fields. */
  isUnlimited?: boolean | null;
  individualUsage?: {
    plan?: CursorPlanUsage | null;
  } | null;
  billingCycleEnd?: string | number | null;
}

/** Normalize one Cursor percent window (auto/api/total), or null if the percent is not finite (no
 * empty gauges). `windowMinutes` stays null: all windows share one billing-cycle reset, and
 * inferring a cadence from the repurposed key would let the SWR cache zero the bar early. */
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

/** Normalize Cursor's dashboard `get-current-period-usage` payload, the primary source, giving the
 * same Auto+Composer / API / Total breakdown as the web dashboard. */
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

/** Normalize Cursor's `usage-summary` fallback, the same breakdown under `individualUsage.plan`,
 * for accounts whose primary endpoint has no usable `planUsage`. An unlimited plan with no percent
 * returns no windows. */
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

/** Read Cursor's OAuth access token + config-file subject from the local CLI config/auth files. */
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

/** Resolve the OAuth subject for the `WorkosCursorSessionToken` cookie: the access token's JWT
 * `sub` first, else the subject `cli-config.json` recorded at login. */
function resolveCursorSubject(accessToken: string, cfgSub: string | null): string | null {
  const jwtSub = normalizeString(decodeJwtPayload(accessToken)?.sub);
  return jwtSub || cfgSub;
}

/** POST the dashboard current-period-usage endpoint and normalize its windows. Null on any
 * network/auth failure so the caller tries the next source; only an empty-windows response means
 * "no usage". */
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

/** GET the usage-summary fallback and normalize its windows; same null-on-failure contract as
 * fetchCursorPeriodWindows. */
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

/** Fetch Cursor usage with a `WorkosCursorSessionToken` cookie (`<oauth-subject>::<access-token>`),
 * not a bearer. No endpoint covers every plan, so try in order `get-current-period-usage`,
 * `usage-summary`, then legacy `/api/usage`. The first non-empty window list wins. */
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

    // 401/redirect => revoked/expired session. No bars to draw, and the status
    // says why.
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
    // A thrown request (timeout, DNS, TLS, a malformed payload) is a failed
    // read like any other — staying silent here would hand the caller a stale
    // snapshot to render as confirmed, which is the bug this file just closed.
    return { snapshot: null, error: usageUnreachableError('Cursor', err) };
  }
}

// ---------------------------------------------------------------------------
// Antigravity (`agy`) usage — Google Code Assist per-model quota buckets
// ---------------------------------------------------------------------------

const ANTIGRAVITY_TOKEN_URL = 'https://oauth2.googleapis.com/token';
// Production Code Assist endpoint first; the daily track is where `agy` itself
// points when the account is enrolled in the daily channel (its log shows
// daily-cloudcode-pa), so fall back to it when prod rejects the call.
const ANTIGRAVITY_QUOTA_URLS = [
  'https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuota',
  'https://daily-cloudcode-pa.googleapis.com/v1internal:retrieveUserQuota',
];
// The public installed-app OAuth client the released `agy` binary ships (non-confidential by
// design). Needed because a Google token refresh requires the client id/secret the login was
// minted under.
const ANTIGRAVITY_CLIENT_ID =
  '1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com';
const ANTIGRAVITY_CLIENT_SECRET = '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';
/** Refresh leeway — treat an access token expiring within a minute as expired. */
const ANTIGRAVITY_REFRESH_LEEWAY_MS = 60 * 1000;

/** The OAuth token `agy` stores (inside `{ token: … }`) in the OS keyring or file. */
interface AntigravityOauthToken {
  access_token?: string | null;
  refresh_token?: string | null;
  /** RFC3339 expiry timestamp for the access token. */
  expiry?: string | null;
}

/** One per-model quota bucket from the :retrieveUserQuota response. */
interface AntigravityQuotaBucket {
  modelId?: string | null;
  tokenType?: string | null;
  remainingFraction?: number | null;
  resetTime?: string | null;
}

/** Response shape from the Code Assist :retrieveUserQuota endpoint. */
interface AntigravityQuotaResponse {
  buckets?: AntigravityQuotaBucket[] | null;
}

/** Parse a stored `agy` OAuth payload: raw `{ token: {...} }` JSON (Linux file) or the
 * `go-keyring-base64:<base64>` wrapper in the macOS Keychain (service `gemini`, account
 * `antigravity`). Never throws; malformed input gives null. */
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

/** True when the stored access token is expired or inside the refresh leeway. A missing or
 * unparseable expiry counts as fresh: the quota call decides (401 renders nothing), and we never
 * refresh without evidence. */
export function antigravityTokenNeedsRefresh(
  expiry: string | null | undefined,
  nowMs: number = Date.now(),
): boolean {
  if (!expiry) return false;
  const ms = Date.parse(expiry);
  if (Number.isNaN(ms)) return false;
  return nowMs + ANTIGRAVITY_REFRESH_LEEWAY_MS >= ms;
}

/** Resolve the `agy` OAuth credential file. agy is a global self-updating install, so check the
 * passed home then the active real HOME (like resolveKimiCredentialPath). Linux without Secret
 * Service only; macOS uses Keychain. */
function resolveAntigravityCredentialPath(home?: string): string | null {
  const rel = ['.gemini', 'antigravity-cli', 'antigravity-oauth-token'];
  const perHome = path.join(home || os.homedir(), ...rel);
  try { if (fs.existsSync(perHome)) return perHome; } catch { /* unreadable */ }
  const active = path.join(process.env.AGENTS_REAL_HOME || os.homedir(), ...rel);
  if (active !== perHome) {
    try { if (fs.existsSync(active)) return active; } catch { /* unreadable */ }
  }
  return null;
}

/** Load the stored `agy` OAuth token: file fallback first, then the OS keyring (the probe pair
 * mirrors antigravityOsKeyringProbe in agents.ts, with `-w` on macOS to read the value). Null on
 * Windows or with no readable credential. Honors the AGENTS_NO_KEYCHAIN_PROBE=1 test guard. */
async function loadAntigravityOauth(home?: string): Promise<AntigravityOauthToken | null> {
  const credPath = resolveAntigravityCredentialPath(home);
  if (credPath) {
    try {
      const parsed = parseAntigravityOauthPayload(fs.readFileSync(credPath, 'utf-8'));
      if (parsed) return parsed;
    } catch { /* unreadable file — fall through to the keyring */ }
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

/** Refresh an `agy` access token against Google's endpoint. Safe on a read path, unlike
 * Claude/WorkOS: Google refresh tokens are non-rotating, so it cannot invalidate a running `agy`.
 * Never write the new token back: a usage read must not mutate the credential. */
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

/** Result of {@link fetchAntigravityQuota} — the buckets, or the last non-ok status seen across all endpoints (null on a pure network failure). */
interface AntigravityQuotaFetchResult {
  buckets: AntigravityQuotaBucket[] | null;
  status: number | null;
  retryAfter: string | null;
}

/** POST :retrieveUserQuota against the Code Assist endpoints in order, returning the first bucket
 * list. `buckets: null` when every endpoint rejects or the network fails; `status` is the last
 * rejection's HTTP status (null if all threw) so the caller can classify the failure. */
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

/** Compact model tag for the inline bar — 'gemini-2.5-flash-lite' => '2.5FL'. */
export function antigravityModelShortLabel(modelId: string): string {
  const stripped = modelId.replace(/^gemini-/i, '');
  const parts = stripped.split('-').filter(Boolean);
  if (parts.length === 0) return modelId;
  const [version, ...rest] = parts;
  return version + rest.map((part) => (part[0] ? part[0].toUpperCase() : '')).join('');
}

/** Normalize per-model quota buckets into UsageWindow, one per model keyed `session`. Duplicate
 * buckets keep the lowest remaining fraction; sorted most-used first. `windowMinutes` stays null:
 * the API gives only the reset time, and an inferred 5h length would zero the SWR cache. */
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

/** Fetch Antigravity usage via Google Code Assist's :retrieveUserQuota, the API `agy` itself uses.
 * Auth is the stored `agy` token (macOS keyring, Linux file), refreshed in memory when expired,
 * which is safe because Google's refresh tokens are non-rotating. */
async function getAntigravityUsageInfo(options?: UsageOptions): Promise<UsageInfo> {
  try {
    const token = await loadAntigravityOauth(options?.home);
    if (!token) return { snapshot: null, error: usageNoCredentialError('Antigravity') };

    let accessToken = normalizeString(token.access_token);
    if ((!accessToken || antigravityTokenNeedsRefresh(token.expiry)) && token.refresh_token) {
      accessToken = await refreshAntigravityAccessToken(token.refresh_token);
    }
    if (!accessToken) return { snapshot: null, error: usageExpiredCredentialError('Antigravity') };

    // Honour a live Retry-After rather than re-arming the penalty (usage-backoff.ts); no request
    // while open. Antigravity had no backoff at all before (RUSH-3040), so every refresh re-hit a
    // throttled endpoint.
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
    // A thrown request (timeout, DNS, TLS, a malformed payload) is a failed
    // read like any other — staying silent here would hand the caller a stale
    // snapshot to render as confirmed (RUSH-3040).
    return { snapshot: null, error: usageUnreachableError('Antigravity', err) };
  }
}
