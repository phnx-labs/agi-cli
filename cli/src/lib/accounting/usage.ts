/**
 * Usage and rate-limit tracking for Claude, Codex, Kimi, Droid, Grok, Cursor,
 * and Antigravity agents.
 *
 * Fetches live usage data from each agent's usage API (Anthropic OAuth for
 * Claude, Kimi Code /usages, Factory billing limits for Droid, Google Code
 * Assist :retrieveUserQuota for Antigravity) or parses rate-limit events from
 * Codex session logs. Results are normalized into a common UsageSnapshot
 * shape, cached to disk, and rendered as terminal progress bars for the
 * `agents view` command.
 */
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
import { atomicWriteFileSync, ensureLockTarget, withFileLock } from '../fs-atomic.js';
import { withRefreshLease } from '../refresh-coordinator.js';
import { padToWidth } from '../session/width.js';

const execFileAsync = promisify(execFile);

const CLAUDE_USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
const CLAUDE_TOKEN_URL = 'https://platform.claude.com/v1/oauth/token';
const CLAUDE_CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
const CLAUDE_OAUTH_BETA_HEADER = 'oauth-2025-04-20';
const CLAUDE_REFRESH_LEEWAY_MS = 5 * 60 * 1000;

/**
 * Why a usage read produced no snapshot, when the cause is the credential or the
 * server rather than the payload. Every provider used to return `error: null`
 * for all three, which made an account nobody can read indistinguishable from a
 * healthy one: the caller fell back to whatever was in the SWR cache and
 * rendered its bars as fact. On `yosemite-s1` that hid five Claude accounts
 * whose stored access token had expired — one of them eleven days earlier —
 * behind a cache frozen for 26h, and balanced routing launched into an account
 * that was actually at its weekly cap.
 *
 * No usage read ever refreshes a token (RUSH-1822 for Claude; the same rule for
 * Kimi/Droid/Cursor, whose own CLIs rotate on their next launch), so an expired
 * credential cannot heal on its own — the account stays unreadable until that
 * agent actually runs, or a long-lived token is provisioned for it.
 *
 * Shared across all four networked providers on purpose: the failure shape is
 * identical, and wiring only Claude would leave `agents view --refresh`
 * reporting Claude accounts while silently presenting stale Kimi, Droid, and
 * Cursor readings as confirmed.
 */
export function usageNoCredentialError(agent: string): string {
  return `No readable ${agent} credential — sign in, or provision a long-lived token for this account.`;
}
export function usageExpiredCredentialError(agent: string): string {
  return `${agent} credential expired — re-auth this account (a usage read never refreshes it).`;
}

/**
 * Kimi-specific expired-credential wording. A normal Kimi launch refreshes its
 * own OAuth access token, so the recovery action for an expired Kimi credential
 * is to run Kimi once — not to re-auth through agents-cli (RUSH-3198).
 */
export function usageExpiredKimiCredentialError(): string {
  return `Kimi credential expired — run Kimi once to refresh it (a usage read never refreshes it).`;
}
export function usageRejectedError(agent: string, status: number): string {
  return status === 429
    ? `${agent} is rate-limiting the usage endpoint for this machine (HTTP 429).`
    : `${agent} rejected the usage read (HTTP ${status}).`;
}

/**
 * Canonical phrase for the Anthropic setup-token scope gap (RUSH-2392).
 * `claude setup-token` mints `user:inference` only; the usage endpoint requires
 * `user:profile`. The account can still run; usage bars cannot populate via
 * that token. Callers detect this string with {@link isUsageHeadlessScopeError}
 * so the UI can render it distinctly from a generic "unverified" failure.
 */
export const USAGE_HEADLESS_SCOPE_MARKER = 'usage unavailable (headless)';

/**
 * Distinct error when Claude's usage API returns 403 because the setup-token
 * lacks `user:profile` (RUSH-2392). Not a revocation, not a missing mint —
 * a permanent tradeoff of the headless credential.
 */
export function usageHeadlessScopeError(agent = 'Claude'): string {
  return `${agent} ${USAGE_HEADLESS_SCOPE_MARKER} — setup-token lacks user:profile; account can still run.`;
}

/** True when an error string is the setup-token scope gap (RUSH-2392). */
export function isUsageHeadlessScopeError(error: string | null | undefined): boolean {
  return typeof error === 'string' && error.includes(USAGE_HEADLESS_SCOPE_MARKER);
}

/**
 * Canonical phrase for a Claude account the usage reader holds no usable
 * credential for. Distinct from {@link USAGE_HEADLESS_SCOPE_MARKER}, which
 * means a setup-token WAS read and the endpoint refused its scope.
 */
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

/** True when an error string is the Claude no-usage-credential state (#2987). */
export function isUsageNoUsageCredentialError(error: string | null | undefined): boolean {
  return typeof error === 'string' && error.includes(USAGE_NO_USAGE_CREDENTIAL_MARKER);
}

/**
 * Detect Anthropic's usage-endpoint scope denial: HTTP 403 whose body names
 * `user:profile` (or "scope requirement"). A bare 403 without that body stays
 * classified as a real rejection — only the known setup-token shape is special
 * (RUSH-2392).
 */
export function isClaudeUsageScopeDenied(
  status: number,
  bodyText: string | null | undefined,
): boolean {
  if (status !== 403) return false;
  if (!bodyText) return false;
  const lower = bodyText.toLowerCase();
  return lower.includes('user:profile') || lower.includes('scope requirement');
}

/**
 * The read threw rather than answering — a timeout, DNS/TLS failure, a payload
 * that would not parse, a credential that would not decrypt. Every provider
 * swallowed these into `error: null`, which is the same silence as an expired
 * token: the caller renders a stale snapshot as confirmed. The cause is carried
 * verbatim because these are the failures a user cannot otherwise see.
 */
/**
 * The provider told us to back off and we are still inside that window, so this
 * read made no request at all. Distinct from `usageRejectedError(agent, 429)`,
 * which is the 429 itself: this one says we are *honouring* it.
 */
export function usageThrottledError(agent: string, untilMs: number): string {
  return `${agent} rate-limited this machine — not retrying for ${formatBackoffRemaining(untilMs)}.`;
}
export function usageUnreachableError(agent: string, cause?: unknown): string {
  const detail = cause instanceof Error ? cause.message : typeof cause === 'string' ? cause : '';
  return detail
    ? `${agent} usage read failed: ${detail}`
    : `${agent} usage read failed.`;
}

/**
 * Marker for a log-based (`network: false`) provider — Codex, Grok — that has
 * simply never recorded a rate-limit event on this machine yet: no session
 * log exists, or no session in it carries usage data. Distinct on purpose from
 * `usageUnreachableError`: that one means the local log COULDN'T be read (a
 * real failure worth surfacing distinctly); this one means there is nothing to
 * read because the account has not run here, which is expected for a fresh
 * install and should render as a benign state, not an error (RUSH-3040).
 */
export const USAGE_NO_RECENT_USAGE_MARKER = 'no usage recorded yet';
export const USAGE_BENIGN_STATE: unique symbol = Symbol('usageBenignState');
export type UsageBenignState = 'no-recent-usage';

/**
 * Sentinel `UsageInfo.error` for a read-only lookup whose cache held nothing
 * (`getUsageInfoForIdentity`). No request was made and nothing failed — the
 * daemon simply has not collected this account yet. It was an unclassified
 * literal, so `classifyUsageErrorKind` fell through to `'rejected'` and
 * `agents view` printed the generic "usage unavailable" for a cold cache,
 * which reads as a failure the operator should chase (#2987). The string value
 * is unchanged; callers that already compare against `'stale'` keep working.
 */
export const USAGE_NOT_COLLECTED_MARKER = 'stale';

/**
 * Human-facing form of a `UsageInfo.error` for a machine/JSON consumer
 * (`agents view --json`'s `usageError`). Every error string this module
 * constructs is already a full human sentence EXCEPT the internal
 * {@link USAGE_NOT_COLLECTED_MARKER} (`'stale'`) sentinel, which a read-only
 * lookup returns for a never-cached account when `--refresh` was not passed. That
 * value is an internal cache signal, not an error message, and leaking it verbatim
 * contradicts the field's "human-readable" contract (PHNX-3348). Map it to a
 * plain-language, actionable string and pass every genuine error through
 * unchanged. Returns `null` when there is no error.
 */
export function usageErrorForDisplay(error: string | null | undefined): string | null {
  if (!error) return null;
  if (error === USAGE_NOT_COLLECTED_MARKER) {
    return 'Usage not collected yet — run `agents view --refresh` to fetch it.';
  }
  return error;
}

/**
 * Shared error-classification + 429 backoff for a networked usage fetch whose
 * only signal is an HTTP status (or none at all, on a network failure) —
 * Antigravity's :retrieveUserQuota and Muse's Meta Model API probe are both
 * this shape. They were added to `USAGE_SOURCES` after the four original
 * `usageXError` constructors and did not get their own scheme (usage.ts's
 * error handling was written for "four networked providers"; RUSH-3040).
 * Route every no-snapshot outcome for either through this one function so a
 * future entry cannot be added second-class again — it owns noting the 429
 * backoff, so callers must NOT also call {@link noteUsageRateLimited} for the
 * same response.
 */
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

/**
 * The specific cause behind a `UsageInfo.error`, so a renderer can name the
 * exact state instead of a generic "usage unavailable" for one of several
 * distinct causes (RUSH-3040). Matched against the canonical strings this file
 * constructs — never re-derive these prefixes at a call site.
 */
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

/**
 * True when a Claude OAuth access token is within the refresh leeway of expiry
 * (or already expired) — i.e. it "would need a refresh" before the next use.
 *
 * Single source of truth for the expiry gate, shared by the two callers that
 * must agree on it but act differently: the run/usage hot path
 * (`getClaudeAccessToken`) refreshes when this is true; the health probe
 * (`probeClaudeStatus`) must NOT refresh and instead reports the non-fatal
 * `expired` state (RUSH-1822). A missing `expiresAt` is treated as "still
 * fresh" (never force a refresh on a token with no known expiry).
 */
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

/**
 * Test seam for the usage cache path, mirroring `setUsageBackoffDirForTest`.
 * `getCacheDir()` resolves from a module-level constant captured at import, so
 * overriding `HOME` in a test does NOT redirect this cache — it would write into
 * the developer's real `~/.agents/.cache/`. Point it at a tmpdir instead.
 */
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
// A window we EXPECTED but have no reading for \u2014 e.g. Claude's 5h "session"
// window when the account has no usage in the current rolling window, so the
// usage API returns five_hour.utilization = null and no session bar is written.
// It must read as neither 0% (EMPTY '\u2591') nor 100% (FULL '\u2588') \u2014 a full block was
// alarming and looked maxed-out \u2014 so use a dashed row that says "no data".
const NO_DATA = '\u2504';

/** Discriminator for usage window types. */
export type UsageWindowKey = 'session' | 'week' | 'sonnet_week' | 'month';

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
  /**
   * Last-known windows the freshness gate DROPPED from `windows` — expired by
   * `resetsAt`/`windowMinutes`, or from a rolled-over billing period. VIEW-ONLY:
   * `agents view` renders these with a staleness age ("30% · 6h old") so the
   * user always sees the last number instead of a bare "unavailable". Routing
   * MUST NEVER read this field — `isUsageVerified`/`hasStaleUsage`/
   * `hasUsageAvailable`/`deriveUsageStatusFromSnapshot` consult only `windows`,
   * so a stale number rendered here can never make a stale account read as
   * verified or eligible (the RUSH-2858 property). Not a serialized key of its
   * own, and dropped from `--json` (which projects `windows` explicitly) — but
   * the READINGS it holds do round-trip through the on-disk cache:
   * `serializeClaudeUsageSnapshot` persists the union of `windows` and
   * `staleWindows`, and `deserializeClaudeUsageSnapshot` re-runs the freshness
   * gate on read to re-partition them (so a collector like Grok that pre-splits
   * an ended-period reading onto `staleWindows` still survives the round-trip).
   */
  staleWindows?: UsageWindow[];
  // Subscription tier, when the usage source also reports it in the same
  // response (Kimi's /usages returns membership.level). Account-level plan
  // otherwise comes from the local auth file via AccountInfo.plan; this field
  // lets a network usage fetch surface a plan the local credential can't.
  plan?: string | null;
  /** Action that makes an event-fed source emit a current reading. */
  refreshHint?: string | null;
  /**
   * A refusal observed from a real harness run, independent of API windows.
   * `session_limit` recovers on a clock (`resetsAt`). `out_of_credits` is a
   * tokens/balance exhaustion that does NOT reset on a clock — it has no
   * `resetsAt` and is cleared only by a later successful run on the account
   * (clearClaudeAccountRefusal). Both exclude the account from rotation while set.
   */
  unavailable?: {
    reason: 'session_limit' | 'out_of_credits';
    resetsAt?: Date;
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
export function usageNoRecentUsageInfo(): UsageInfo {
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
  /**
   * The account's usage key (`claude:org=…`, `kimi:user=…`, …) when the caller
   * knows which account this fetch is for. Scopes the 429 backoff to that
   * account (RUSH-3036) so one throttled account cannot park its siblings;
   * absent, the backoff stays provider-wide.
   */
  usageScope?: string | null;
  /**
   * Caller-supplied abort signal (the daemon tick's deadline). Combined with each
   * provider fetch's own timeout so a hung refresh is bounded by BOTH the
   * per-fetch timeout and the supervisor deadline (PHNX-3608).
   */
  signal?: AbortSignal;
  /**
   * When true, never open the ACL-bound OS keychain item (macOS Touch ID).
   * Daemon usage refresh sets this so a background tick cannot pop biometrics.
   * Credentials come from the no-ACL access-token cache, a file-based
   * setup-token, or `<home>/.claude/.credentials.json` only.
   */
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
}

/** Canonical input for a single usage fetch operation. */
export interface UsageFetchInput {
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

/**
 * Combine a caller-supplied abort signal (the daemon tick deadline) with a
 * per-fetch timeout, so a provider fetch is bounded by whichever fires first
 * (PHNX-3608). With no caller signal it degrades to the timeout alone —
 * byte-identical to the previous `AbortSignal.timeout(ms)` behaviour.
 */
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

/**
 * Deduplicate identity inputs into canonical (most-recently-active) accounts
 * and build the corresponding fetch inputs for each unique usage key.
 */
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

/**
 * Whether an agent exposes usage/limit data we can render — Claude/Kimi/Droid/
 * Cursor/Antigravity via a live API, Codex/Grok via local session logs.
 * Everything else has no usage concept, so callers use this to decide whether
 * a missing snapshot is worth flagging as "usage unavailable" (a signed-in
 * Claude account with no data) versus simply not applicable (OpenCode).
 */
export function agentReportsUsage(agentId: AgentId): boolean {
  return getUsageSource(agentId) !== undefined;
}

/**
 * Whether an agent's usage source makes a live NETWORK call (Claude/Kimi/Droid/
 * Cursor/Antigravity) versus reading local session logs (Codex/Grok). Both
 * kinds publish through the shared cache; callers use this only to distinguish
 * provider I/O from local collection.
 */
export function agentUsesNetworkUsage(agentId: AgentId): boolean {
  return getUsageSource(agentId)?.network === true;
}

/**
 * Concurrent live usage fetches for a single `agents view` / rotation pass.
 * High enough to finish a multi-account refresh in one round-trip window; low
 * enough that a cold cache of 10+ accounts cannot open 10+ HTTP calls at once
 * (and cannot stack behind delayed responses until the process is pegged).
 */
export const USAGE_FETCH_CONCURRENCY = 3;

/**
 * Unified entry for every multi-account usage lookup (`agents view`, rotation,
 * JSON export). Deduplicates by usage identity and reads the shared snapshot.
 * Only an explicit `forceRefresh` call may collect provider or local-log state.
 */
export interface UsageLookupOptions {
  forceRefresh?: boolean;
  fileOnly?: boolean;
  /** Daemon tick deadline signal, combined with each provider fetch's own timeout (PHNX-3608). */
  signal?: AbortSignal;
  /**
   * Permit a foreground personal-device usage read to fall through to the
   * interactive login when no setup-token exists (USAGE-READ-2). Set ONLY by
   * `agents view` when `selfConfiguredDeviceRole() === 'personal'` and the
   * output is a human TTY (not `--json`). Threads into `getClaudeUsageInfo` →
   * `loadClaudeOauth`. Unset for every other lookup.
   */
  allowInteractiveLogin?: boolean;
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

/**
 * In-process dedup complements the device-wide lease. It avoids lock contention
 * when several callers in one process explicitly request the same refresh.
 */
const inFlightLiveFetches = new Map<string, Promise<UsageInfo>>();

/**
 * Fetch usage for one identity. Ordinary callers always read the shared cache;
 * the daemon and explicit `--refresh` calls collect through one device lease.
 */
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

  // The on-disk cache is shared for both provider and local-log sources and is
  // keyed by usageKey, which is namespaced per agent (`claude:org=…`,
  // `kimi:user=…`, `droid:org=…`, `cursor:user=…`, `antigravity:sub=…`), so one
  // cache file holds every account without collision.
  if (!usageKey) {
    if (readOnly) return { snapshot: null, error: USAGE_NOT_COLLECTED_MARKER };
    return getUsageInfo(input.agentId, {
      home: input.home,
      cliVersion: input.cliVersion,
      organizationId: input.info.organizationId,
      fileOnly: opts?.fileOnly,
      allowInteractiveLogin: opts?.allowInteractiveLogin,
      signal: opts?.signal,
    });
  }

  const cached = readClaudeUsageCache(usageKey);
  // `readOnly` (the `agents run` routing hot path): serve the cache and NEVER
  // touch the network — not even a background refresh. `collectRunCandidates`
  // used to pass a 5-minute `maxAgeMs`, which made a snapshot older than that
  // fall through to the blocking live fetch below (getUsageInfo → provider HTTP),
  // adding one round trip per account to `agents run` cold-start on a box whose
  // cache had gone stale. The daemon now owns keeping this cache fresh
  // (`runUsageRefresh`, adaptive + rate-capped), so the router only ever reads
  // it. A stale-or-absent snapshot is handled downstream by the router's own
  // freshness guard (`isUsageVerified` in rotate.ts), which routes around a
  // number it can't confirm rather than trusting an old one — so returning a
  // stale snapshot here is safe, and an absent one reports
  // {@link USAGE_NOT_COLLECTED_MARKER}.
  if (readOnly) {
    // A row carries a CONFIRMED reading when it has a fresh window, a
    // subscription plan (meterless-healthy, e.g. Grok's tier), or a live refusal
    // (out_of_credits / session_limit). Those report `usageError: null`.
    if (cached && (cached.windows.length > 0 || cached.plan || cached.unavailable)) {
      return { snapshot: cached, error: null };
    }
    // A row whose ONLY content is last-known stale readings — the all-expired
    // Claude case, its windows moved to `staleWindows` (view-only) so the
    // TERMINAL view still renders the number with its age — must NOT read as a
    // healthy account. `staleWindows` is deliberately excluded from `--json`
    // (which projects only `windows`), so keep `usageError` non-null: a consumer
    // polling `agents view --json` must still see the staleness signal, the exact
    // RUSH-2858 weeks-stale case this marker exists for. The snapshot is still
    // returned, so the human view is unaffected.
    if (cached) return { snapshot: cached, error: USAGE_NOT_COLLECTED_MARKER };
    return { snapshot: null, error: USAGE_NOT_COLLECTED_MARKER };
  }

  // Explicit refresh: block on the shared device collector.
  return fetchLiveUsageDeduped(input, usageKey, cached, opts?.fileOnly === true, {
    allowInteractiveLogin: opts?.allowInteractiveLogin === true,
    signal: opts?.signal,
  });
}

/**
 * Single-flight live usage fetch per usage key. Concurrent callers (view +
 * rotation, or two rows sharing an account) await the same promise rather than
 * opening duplicate HTTP requests that then time out and pile up.
 */
async function fetchLiveUsageDeduped(
  input: UsageIdentityInput,
  usageKey: string,
  cached: UsageSnapshot | null,
  fileOnly: boolean,
  opts?: { allowInteractiveLogin?: boolean; signal?: AbortSignal },
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

/**
 * Pick which usage windows to render in a compact one-line summary.
 *
 * Overview rows (`agents view` all agents) must stay narrow enough that one
 * multi-window agent (Antigravity's four model quotas, Droid's three buckets)
 * does not force every other row to pad to ~200 columns and wrap. Prefer the
 * canonical session + week windows when present; otherwise take the highest
 * utilization remaining. Returns the full set when `maxWindows` is unset.
 */
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
  /**
   * Setup-token lacks `user:profile` so usage cannot be read headlessly
   * (RUSH-2392). Distinct from generic `unverified` (cache unconfirmed) —
   * minting again will not help; the account still runs.
   */
  headless?: boolean;
  /**
   * Cap how many usage windows render on one line. Overview (`agents view`
   * with no agent filter) passes 2 so multi-window agents cannot blow out
   * column width; single-agent and detail views leave this unset.
   */
  maxWindows?: number;
  /** Windows that must keep a visible slot even when the provider omits one. */
  expectedWindows?: Array<{ key: string; shortLabel: string }>;
  /**
   * The classified cause of `usageInfo.error` (RUSH-3040), from
   * {@link classifyUsageErrorKind}. Lets the no-bars branch below name the
   * SPECIFIC reason ('re-auth for usage', 'sign in / provision a long-lived
   * token', 'rate-limited (retry ~12m)') instead of
   * the generic 'usage unavailable' that used to cover ~6 distinct causes.
   * Only consulted when `unavailable` is set — a snapshot WITH bars still
   * renders 'unverified'/`headless` as before. `--json` output is unaffected:
   * `UsageInfo.error` keeps carrying the full message; this only changes the
   * short human string rendered here.
   */
  errorKind?: UsageErrorKind | null;
  /**
   * The raw `UsageInfo.error` string, read only to pull the retry-time hint
   * out of a `rate-limited` classification (the exact duration lives in the
   * message text, not the kind).
   */
  errorDetail?: string | null;
  /** Benign state from {@link getUsageBenignState}; never sourced from `UsageInfo.error`. */
  benignState?: UsageBenignState | null;
  /** Provider-specific replacement for the generic no-local-event marker. */
  noRecentUsageLabel?: string | null;
}

/**
 * Shared builder for {@link formatUsageSummary} options in `agents view` and
 * account-catalog rows. One builder, no copy — captures `headless`,
 * `unverified`, `expectedWindows`, `errorKind`, `benignState`, and the grok
 * `noRecentUsageLabel` consistently.
 */
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
    // Both of these are permanent for the account as configured, and both used
    // to render as the generic bucket — which reads as a transient failure and
    // sends operators back to `claude setup-token` for a remedy that cannot
    // work (#2987). Name the state instead.
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
    if (snapshot.unavailable?.reason === 'out_of_credits') {
      parts.push(chalk.red('out of credits'));
    } else if (snapshot.unavailable?.reason === 'session_limit' && snapshot.unavailable.resetsAt) {
      parts.push(chalk.yellow(`session-limited (${formatResetHint(snapshot.unavailable.resetsAt)})`));
    }
    // Compact rows show BLOCKING windows — the same set
    // deriveUsageStatusFromSnapshot uses for the rate-limited badge — so an
    // account throttled by its month window (Droid meters on 5h/week/month)
    // shows the bar that explains why. Claude's Sonnet week is a per-model
    // sub-limit, not a blocking window; it renders only in the full
    // per-version usage section. Each window reads "S: ███░░ 58% (3d)" — the
    // gauge, the exact percentage, and a compact hint of when it resets.
    //
    // Overview caps the window count (see pickCompactUsageWindows) so one
    // multi-meter agent cannot force the whole table to wrap.
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
    // The bars came from the cache and the live read that should have confirmed
    // them failed, so they are the last thing we saw — not the current state.
    // Drawing them unmarked is what let a 26h-old "48% used" read as fact.
    // Headless-scope (RUSH-2392) is a known permanent gap, not a flaky cache:
    // prefer that label over the generic "unverified" so operators do not re-mint.
    if (opts?.headless) {
      parts.push(chalk.dim(USAGE_HEADLESS_SCOPE_MARKER));
    } else if (opts?.unverified) {
      parts.push(chalk.yellow('unverified'));
    }
  } else if (opts?.headless) {
    // No bars at all: still name the scope gap so "usage pending" is not
    // mistaken for a missing setup-token or seeding failure (RUSH-2392).
    parts.push(chalk.dim(USAGE_HEADLESS_SCOPE_MARKER));
  } else if (opts?.benignState === 'no-recent-usage') {
    parts.push(chalk.dim(opts.noRecentUsageLabel || USAGE_NO_RECENT_USAGE_MARKER));
  } else if (opts?.unavailable) {
    // Signed-in account we could NOT fetch usage for (no live token in a reachable
    // home / org mismatch / fetch error). Say so explicitly instead of drawing a
    // blank gauge that reads like "0% used" — and name the SPECIFIC cause when
    // the caller passed one, rather than the generic bucket that used to cover
    // ~6 different failures (RUSH-3040).
    parts.push(chalk.dim(formatUsageErrorKindLabel(opts.errorKind, opts.errorDetail)));
  }

  return parts.join('  ');
}

/**
 * Derive an account's real throttle state from its live usage windows — the
 * single signal both the `agents view` badge and run-rotation eligibility share
 * (`hasUsageAvailable` in rotate.ts treats a `rate_limited` verdict here as
 * ineligible). A window at 100% utilization means the account is throttled until
 * that window resets. Rotation *weighting* still ranks eligible accounts by
 * weekly headroom (`getRoutingUsedPercent`); this function is the yes/no gate.
 *
 * Returns `null` when there is no snapshot, so callers render no badge rather
 * than a misleading one. This deliberately never consults
 * `cachedExtraUsageDisabledReason`: that field describes why pay-as-you-go
 * overage is disabled (`out_of_credits` = no overage credits purchased,
 * `org_level_disabled` = an admin turned overage off), NOT whether the account
 * can do work right now. A Pro account at 5% weekly usage with overage disabled
 * is fully usable, yet that flag would mislabel it "out of credits".
 *
 * The model-specific `sonnet_week` sub-limit is excluded: hitting it throttles
 * one model, not the account, so it shouldn't flip the whole row to throttled.
 */
export function deriveUsageStatusFromSnapshot(
  snapshot: UsageSnapshot | null | undefined
): 'available' | 'rate_limited' | null {
  if (!snapshot) return null;
  if (snapshot.unavailable) {
    // out_of_credits has no clock — it stays blocking until a successful run
    // clears it. session_limit blocks only until its reset time.
    if (snapshot.unavailable.reason === 'out_of_credits') return 'rate_limited';
    if (snapshot.unavailable.resetsAt && snapshot.unavailable.resetsAt.getTime() > Date.now()) {
      return 'rate_limited';
    }
  }
  if (snapshot.windows.length === 0) return null;
  const blocking = snapshot.windows.filter((window) => window.key !== 'sonnet_week');
  const windows = blocking.length > 0 ? blocking : snapshot.windows;
  const maxUsed = Math.max(...windows.map((window) => window.usedPercent));
  return maxUsed >= 100 ? 'rate_limited' : 'available';
}

/** A prior sample of one window's utilization, for burn-rate projection. */
export interface UsagePriorSample {
  /** Epoch ms the prior snapshot was captured. */
  capturedAt: number;
  /** The session window's `usedPercent` in that prior snapshot. */
  usedPercent: number;
}

/**
 * An account's throttle state PLUS how long until it caps, projected from the
 * burn rate on its 5-hour `session` window — the window that throttles the next
 * request soonest. `deriveUsageStatusFromSnapshot` answers only "maxed right
 * now (100%)?"; this answers "and how close is it getting?", so routing can
 * deprioritize an account burning toward its cap before it actually hits it,
 * instead of treating 85%-and-climbing the same as 85%-and-idle.
 *
 * `minutesToLimit`:
 *   - `0`      — already rate-limited (a blocking window at 100%).
 *   - `n > 0`  — projected minutes until the session window reaches 100%, from
 *                `(100 - used) / burnRatePerMinute`, where the burn rate is
 *                measured between `prev` and this snapshot.
 *   - `null`   — unknown: no snapshot, no session window, no prior sample, or
 *                usage flat/falling since `prev` (a reset or an idle account is
 *                not "projected to cap", so it is NOT deprioritized).
 *
 * Pure: the daemon's refresher supplies `prev` from the last snapshot it stored
 * (`usage-refresh.ts`); the routing hot path reads the daemon-computed result
 * from the headroom cache rather than recomputing (it has no `prev`).
 */
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

/**
 * Compact colored badge for the account's overall usage status. Renders only
 * when the account is throttled — `available` and `null` return ''.
 *
 * - `out_of_credits` → red "out of credits" (terminal account, all buckets dry)
 * - `rate_limited`   → yellow "rate-limited" (transient throttling)
 *
 * The badge sits between the usage bars and `lastActive` in `agents view`, so
 * a glance at the row tells the user whether the version can do useful work.
 * The same signal is exposed as `usageStatus` in `agents view --json` for
 * programmatic consumers (e.g. the swarmify panel's "resume in healthy agent").
 *
 * The switch is exhaustive on purpose — adding a new `AccountInfo.usageStatus`
 * value without updating the cases here is a build error at `_exhaustive`,
 * which is exactly the bug class this PR is fixing.
 */
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
    // Codex usage is read from on-disk session transcripts, which carry no
    // account identity and are not removed on logout. To keep the bar scoped to
    // the account signed in NOW, floor the scan at the current login time: the
    // id_token's `auth_time` claim — the OIDC time-of-authentication. A session
    // written before that login belongs to whoever was signed in before (e.g.
    // after `codex logout` + login into a different account), and showing its
    // rate_limits is the "wrong usage after switch" bug.
    //
    // `auth_time` — not the auth.json file mtime — is the correct floor: Codex
    // rewrites auth.json on every token refresh (advancing its mtime), but a
    // refresh_token grant does not re-authenticate the user, so `auth_time`
    // stays at the real login. Flooring on mtime would blank the bar after each
    // background refresh; flooring on `auth_time` does not. No readable
    // credential means the version is signed out — report no usage. A credential
    // that carries no `auth_time` falls back to no floor (prior behavior) rather
    // than hide a signed-in account's usage.
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

      // Same freshness filter Grok already applies (RUSH-3040): a window whose
      // reset time or windowMinutes-derived expiry has passed is a STALE read,
      // not a current one — rendering it as-is is how a codex bar kept showing
      // "100% used" past its own reset. Try the next-older session file rather
      // than surfacing a stale bar.
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

    // No session ever recorded a rate-limit event on this machine (or none of
    // the ones found were still fresh) — a benign "nothing to show yet", not a
    // failure (RUSH-3040). Distinct from the outer catch below, which is a
    // genuine read/parse failure.
    return usageNoRecentUsageInfo();
  } catch (err) {
    return { snapshot: null, error: usageUnreachableError('Codex', err) };
  }
}

/**
 * The access token to use for a READ-ONLY Claude usage fetch, or null when the
 * stored token is within the refresh leeway.
 *
 * Returns null instead of refreshing on purpose. Claude's refresh token is
 * single-use and rotates server-side on every refresh; with one account signed
 * into several machines, refreshing here would stampede that one token and
 * silently invalidate every other holder — the RUSH-1822 failure, except in the
 * usage path (fired in the background by the SWR cache and by `agents run`'s
 * default "balanced" rotation on every unpinned run) rather than the health
 * probe. So a usage read must never rotate: a near-expiry token yields "no usage
 * right now" instead of a fleet-wide logout. Mirrors {@link probeClaudeStatus};
 * the single legitimate refresh belongs to the actual claude run, never a read.
 * Pure — unit-tested.
 */
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
    // accessTokenCache: this is the every-60s watchdog hot path and usage needs
    // only the access token, so it reads ONLY the file-based setup-token and never
    // the interactive login (reading that ACL-bound token and firing it at the
    // usage API is what got it revoked — RUSH-1822). No setup-token => null =>
    // "usage pending". fileOnly additionally forbids the ACL keychain path.
    //
    // allowInteractiveLogin is the one sanctioned exception (USAGE-READ-1/2): a
    // foreground human `agents view` on a `personal` device MAY fall through to
    // the interactive login when no setup-token exists, because that login is the
    // only credential carrying the `user:profile` scope the usage endpoint
    // requires (the setup-token is user:inference → 403, RUSH-2392). It is unset
    // for every background caller, so the RUSH-1822 guarantee is untouched there.
    const oauth = await loadClaudeOauth(options?.home, {
      accessTokenCache: true,
      fileOnly: options?.fileOnly === true,
      allowInteractiveLogin: options?.allowInteractiveLogin === true,
    });
    if (!oauth?.accessToken) {
      // NOT the shared no-credential message: "sign in" is not a remedy here.
      // The account this reads for is usually signed in already — the reader is
      // forbidden from touching that login (RUSH-1822) — so the shared wording
      // asked the operator to redo the one thing they had already done (#2987).
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

/**
 * Resolve Kimi's OAuth credential file. Sign-in is account-global but each
 * installed version has an isolated home; the file physically lives only in the
 * home the user logged in under. Check the per-version home first, then the
 * active location under the real HOME — mirrors resolveAccountCredentialPath in
 * agents.ts so every version reflects the true account state.
 */
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

/**
 * Live auth probes — the same authenticated GET the usage fetchers above do,
 * but surfacing the raw HTTP status instead of swallowing 401/expired to null.
 * These back `agents fleet ping` and the fleet auth-health cache: completing a
 * real request is the only proof a token is accepted. The local "signed in"
 * flag cannot tell a revoked-but-unexpired token from a good one. Classification
 * of the returned status into a verdict lives in lib/auth-health.ts (kept there
 * so it stays pure/testable and to avoid an import cycle).
 */
export interface ProviderProbe {
  /** HTTP status of the probe request, or null when no request was made (missing/expired token) or the request threw. */
  status: number | null;
  /** Local credential state observed before the request. */
  token: 'present' | 'missing' | 'expired';
  /** Network/parse error message when status is null but a token was present. */
  error?: string;
  /**
   * Known non-revocation cause for a non-2xx status.
   * `usage_scope` — Anthropic returned 403 because the setup-token lacks
   * `user:profile` (RUSH-2392). Token is valid for inference; usage is unreadable.
   * Auth-health MUST NOT map this to `revoked`.
   */
  reason?: 'usage_scope';
}

/** Probe Claude's OAuth token against the usage endpoint. Never refreshes — reports `expired` for a near-expiry token; see the comment below (RUSH-1822). */
export async function probeClaudeStatus(home?: string, cliVersion?: string | null, usageScope?: string | null, signal?: AbortSignal): Promise<ProviderProbe> {
  // accessTokenCache: the daemon warms this probe every ~3 min per account, so it
  // reads ONLY the file-based setup-token and never the interactive login —
  // transmitting that ACL-bound token to the usage API from a background loop is
  // what got it revoked (RUSH-1822). No setup-token => token 'missing' below.
  const oauth = await loadClaudeOauth(home, { accessTokenCache: true });
  const accessToken = oauth?.accessToken?.trim();
  if (!accessToken) return { status: null, token: 'missing' };
  // Never refresh from a health probe. Claude's refresh token is single-use and
  // rotates on every refresh; with one account signed into several machines the
  // daemon's every-3-min fleet-cache warm (probeLocalFleetAuth -> here) would
  // stampede that one rotating token and silently invalidate every other
  // holder, dropping the fleet to "run /login" (RUSH-1822). Mirror the sibling
  // Kimi/Droid probes, which never refresh: if the stored token is within the
  // refresh leeway of expiry, report the non-fatal `expired` state ("would need
  // a refresh") instead of rotating it, and leave the single legitimate refresh
  // to the run/usage hot path (getClaudeAccessToken).
  if (claudeAccessTokenNeedsRefresh(oauth?.expiresAt ?? null)) {
    return { status: null, token: 'expired' };
  }
  // A probe is a request like any other: while the provider's Retry-After
  // window is open, report the throttle from the recorded state instead of
  // firing again and re-arming it (usage-backoff.ts). This 3-min-cadence
  // probe is what created the loop it now respects.
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
  // A probe is a request like any other: while the provider's Retry-After
  // window is open, report the throttle from the recorded state instead of
  // firing again and re-arming it (usage-backoff.ts). This 3-min-cadence probe
  // is what created the loop it now respects. It sits AFTER the local
  // missing/expired checks — as in probeClaudeStatus and probeDroidStatus — so
  // a genuinely broken credential is never misreported as merely throttled.
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
  // A probe is a request like any other: while the provider's Retry-After
  // window is open, report the throttle from the recorded state instead of
  // firing again and re-arming it (usage-backoff.ts). This 3-min-cadence
  // probe is what created the loop it now respects.
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

/**
 * Normalize the Factory billing-limits payload into the common UsageWindow
 * shape. Orgs on the legacy (non token-rate-limit) billing model have no
 * meaningful windows, so they render nothing — mirrors droid's own gate on
 * `usesTokenRateLimitsBilling` before it reads `limits.standard`.
 */
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

/**
 * Collect Codex JSONL session files sorted newest-first.
 *
 * `sinceMs` drops files modified before it. Codex session transcripts are not
 * tagged with the account that wrote them, so this mtime floor is how usage is
 * kept account-scoped: a session older than the current login belongs to a
 * prior account (see {@link getCodexUsageInfo}).
 */
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

/**
 * Parse a wrapped Claude OAuth payload — the `{ claudeAiOauth, organizationUuid }`
 * shape written by BOTH the macOS Keychain item and the Linux `.credentials.json`
 * file — into our credential struct. Returns null when there is no usable access
 * token. Never throws (malformed JSON => null).
 */
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

// ── Stale no-ACL Claude OAuth cache eviction (retired subsystem) ──
//
// Earlier versions cached Claude's OAuth ACCESS token in a device-local no-ACL
// keychain item so a read-only usage/probe read wouldn't pop the macOS Touch ID
// prompt that the ACL-bound source item (`Claude Code-credentials-<hash>`) forces.
// That cache is retired: read-only probes now authenticate ONLY with a file-based
// setup-token and never read the interactive login (see loadClaudeOauth), so
// nothing populates the cache anymore. deleteCachedClaudeOauth remains — a
// credential rotation still evicts a stale item an earlier version may have
// written, so an old no-ACL copy of the interactive token can't linger.
const CLAUDE_OAUTH_CACHE_PREFIX = 'agents-cli.claude-oauth-cache.';

/** The no-ACL cache item name for a Claude keychain service (hashed to stay tidy). */
function claudeOauthCacheItem(service: string): string {
  const hash = createHash('sha256').update(service).digest('hex').slice(0, 16);
  return `${CLAUDE_OAUTH_CACHE_PREFIX}${hash}`;
}

/**
 * Evict any no-ACL access-token cache item so a source rotation or sign-out is
 * reflected immediately. The cache itself is retired — read-only probes no longer
 * read or write it (loadClaudeOauth returns a file-based setup-token or nothing) —
 * but this eviction remains so a credential rotation still clears a stale cache
 * item that an earlier agents-cli version may have written no-ACL.
 */
function deleteCachedClaudeOauth(service: string): void {
  try {
    deleteKeychainTokenSync(claudeOauthCacheItem(service));
  } catch {
    /* best-effort — cache is an optimization */
  }
}

/**
 * Load a version home's Claude OAuth credential from the two stores Claude Code
 * uses, tried in order:
 *
 *  1. The OS keychain (`getKeychainToken`). Canonical on macOS — Claude Code
 *     writes the token to the login keychain and we read it via `/usr/bin/security`.
 *  2. `<home>/.claude/.credentials.json`. On a headless Linux box (the
 *     `agents view --device <linux>` case) there is no reachable Secret Service, so
 *     the Claude CLI stores its OAuth token in this plaintext file instead. The
 *     keychain read above finds nothing on that platform, so we fall back to the
 *     file. Same wrapped `{ claudeAiOauth }` shape, so one parser handles both.
 *
 * Without step 2 the live usage fetch got no token on Linux, so `agents view`
 * (run remotely over SSH by `--device`) rendered no usage bars even though the
 * account + plan — read from the plaintext `.claude.json` — showed fine.
 *
 * `opts.accessTokenCache` marks a read-only, access-token-only consumer (the
 * usage fetch and the auth-health probe). Such a caller authenticates ONLY with
 * a file-based setup-token and, when none is provisioned, gets `null` — it never
 * reads Claude Code's interactive login (transmitting that ACL-bound OAuth token
 * to Anthropic's API is what gets it revoked; see the branch body and
 * docs/secrets.md). It is OFF by default so full-credential
 * callers that refresh (`isClaudeAuthValid` -> `getClaudeAccessToken`) still
 * read the interactive login. Rush Cloud dispatch does not call this helper
 * at all (SING-1b: the account manifest is email-only; RUSH-2359 removed the
 * leftover blob reader that used to send the interactive login).
 *
 * `opts.fileOnly` skips the ACL keychain read entirely — setup-token and
 * `.credentials.json` only. Used by the daemon usage refresher so a background
 * tick can never pop Touch ID.
 */
export async function loadClaudeOauth(
  home?: string,
  opts?: { accessTokenCache?: boolean; fileOnly?: boolean; allowInteractiveLogin?: boolean }
): Promise<ClaudeOauthCredentials | null> {
  // Read-only usage/probe callers (accessTokenCache) authenticate ONLY with a
  // file-based setup-token from the `auth` bundle — never Claude Code's
  // interactive login. The usage endpoint accepts any sk-ant-oat01 bearer, and
  // the file-based token never pops Touch ID. When no setup-token is provisioned
  // the probe reports unprovisioned rather than reading the interactive
  // credential (see below) — that is the whole point of this branch.
  if (opts?.accessTokenCache === true) {
    const setupToken = resolveClaudeSetupToken(home);
    if (setupToken) {
      // No expiresAt: a setup-token is long-lived and non-rotating, and a null
      // expiry reads as "still fresh" (claudeAccessTokenNeedsRefresh) so the
      // probe never reports it expired or tries to refresh it. The endpoint is
      // the source of truth if it has actually been revoked.
      return { accessToken: setupToken };
    }
    // No provisioned setup-token. A read-only usage/health probe MUST NOT fall
    // through to Claude Code's interactive login credential. The daemon's usage
    // (~60s) and auth-health (~3min) warms would otherwise read the ACL-bound
    // OAuth token and transmit it to api.anthropic.com/api/oauth/usage — an
    // interactive credential used programmatically, which Anthropic flags and
    // revokes (the fleet-wide-logout class, RUSH-1822), and which violates the
    // invariant that the interactive/rotating login is untouchable
    // (docs/secrets.md). Report unprovisioned (-> probe
    // token 'missing' -> auth-health 'unconfigured', benign for rotation); seed a
    // setup-token via the mint-auth path to restore usage/probe for the account.
    //
    // The single sanctioned exception (USAGE-READ-1/2): a foreground human
    // `agents view` on a headed device (personal or desktop) sets allowInteractiveLogin, and only
    // then do we fall through to the interactive-login read below — the one
    // credential carrying `user:profile`, which the usage endpoint requires. This
    // is a human running one command, not an unattended loop, so it is not the
    // revocation risk RUSH-1822 fixed. Every background caller leaves the flag
    // unset and still returns null here.
    if (opts?.allowInteractiveLogin !== true) {
      return null;
    }
  }

  // Full-credential callers (isClaudeAuthValid -> getClaudeAccessToken)
  // legitimately read the interactive login to run/refresh Claude. Rush Cloud
  // dispatch does not (SING-1b / RUSH-2359). The OS keychain/keyring step is
  // macOS/Linux-only; Windows and any
  // fileOnly caller skip to the .credentials.json read below (the Claude CLI
  // stores its OAuth token in that file too).
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

/**
 * Save Claude OAuth credentials to the system keychain/keyring.
 * Reads the existing payload, merges the new OAuth fields, and writes back.
 * Exported for regression tests; not part of the public command surface.
 */
export async function saveClaudeOauth(
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

/**
 * Derive the Keychain service name for a Claude home directory.
 * Managed (non-default) homes get a hash suffix for isolation.
 */
export function getClaudeKeychainService(home?: string): string {
  if (!home) {
    return CLAUDE_KEYCHAIN_SERVICE;
  }

  const configDir = path.join(home, '.claude').normalize('NFC');
  const hash = createHash('sha256').update(configDir).digest('hex').slice(0, 8);
  return `${CLAUDE_KEYCHAIN_SERVICE}-${hash}`;
}

/**
 * Check whether a requested org ID matches the live OAuth org ID.
 * Returns true when either is absent (no filtering) or when they match.
 */
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
      cache[usageKey] = serializeClaudeUsageSnapshot({
        ...snapshot,
        unavailable: carryForwardUnavailable(prior?.unavailable, snapshot.unavailable),
      });
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
      cache[usageKey] = serializeClaudeUsageSnapshot({
        ...snapshot,
        windows: [...windows.values()],
        plan: snapshot.plan ?? priorSnapshot?.plan ?? null,
        unavailable: carryForwardUnavailable(prior?.unavailable, snapshot.unavailable),
      });
      atomicWriteFileSync(cachePath, JSON.stringify(cache, null, 2), 'utf-8');
    });
  } catch {
    /* best-effort cache write — lock busy or disk full */
  }
}

/**
 * Export the local usage cache rows worth publishing to fleet peers (PHNX-3392
 * usage-sync). Returns the raw serialized rows keyed by usage identity, filtered
 * to those carrying at least one window — an empty row has nothing to teach a
 * worker. The transport is the on-disk cache form, so there is no Date round-trip.
 */
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

/**
 * Merge usage rows received from a fleet peer into the local cache, NEWEST-WINS
 * per identity by `capturedAt` (PHNX-3392 usage-sync). A worker has no local
 * usage writer, so an incoming row is almost always the freshest it will get; the
 * timestamp guard exists so a stale push from one headed peer can never overwrite
 * a fresher row another peer (or, on a headed receiver, the local status-line)
 * already wrote. An incoming row with no `capturedAt` cannot prove it is newer, so
 * it never displaces an existing timestamped row. Returns the count updated.
 * Locked + atomic like every other cache writer.
 *
 * Deliberately NOT role-gated on the receiver. "Consume only on worker/unmarked"
 * is a SENDER-side optimization (don't waste a push on a headed peer that reads
 * its own usage), not a safety invariant — the actual safety property is this
 * newest-wins guard. Receiving on a headed box is harmless (its fresher local
 * status-line row survives) or helpful (an account it is signed into but never
 * runs now shows a usage bar), so gating here on the receiver's own — laggier —
 * view of its role would only reject legitimate data.
 */
export function ingestPeerClaudeUsageRows(
  rows: Record<string, CachedUsageSnapshot>,
  cachePath = getClaudeUsageCachePath(),
): number {
  const incoming = Object.entries(rows).filter(
    ([, row]) => row && Array.isArray(row.windows) && row.windows.length > 0,
  );
  if (incoming.length === 0) return 0;
  let merged = 0;
  try {
    ensureLockTarget(cachePath, '{}');
    withFileLock(cachePath, () => {
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
  // Persist the union of fresh `windows` and last-known `staleWindows`.
  // `deserializeClaudeUsageSnapshot` re-runs the freshness gate on read and
  // re-partitions the serialized windows into fresh vs. stale, so what matters
  // is that every last-known reading reaches disk. Claude's collector returns
  // raw windows (no `staleWindows`) and relies on that read-side partition. But
  // Grok's collector pre-partitions in the fetch, moving an ended-period reading
  // onto `staleWindows` — serializing only `windows` dropped it, so the very
  // number a daemon `--refresh` just captured was gone from the next cached
  // `agents view grok`, which rendered the plan alone (no bar). Include the
  // stale windows here so the round-trip preserves them for any collector.
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
  };
}

/**
 * Deserialize a cached snapshot, dropping windows whose reset time has passed.
 *
 * An expired window is UNKNOWN, not 0%: the counter reset, and anything may
 * have burned since. Zeroing-but-keeping it (the previous behavior) rendered a
 * weeks-frozen cache as "S: 0% (now)" with `deriveUsageStatusFromSnapshot` →
 * 'available', so a genuinely rate-limited account read as an idle dispatch
 * candidate (RUSH-2858). Dropping keeps them out of `windows` (routing stays
 * blind), but they are preserved on `staleWindows` so the view can render the
 * last-known number with its age instead of a bare "unavailable" — a row that
 * carries only stale windows therefore survives (it is worth showing), and only
 * a row with NOTHING to show — no fresh window, no stale window, no plan, no
 * refusal — deserializes to null so `readClaudeUsageCache` deletes it.
 *
 * A row that carries a plan survives even with no fresh windows: the plan is a
 * truthful reading in its own right, and losing it is what made the cached view
 * contradict the refreshed one for meterless harnesses. See the guard below.
 */
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
  // The dropped windows are still the LAST reading we saw for those meters —
  // routing must not trust them (they stay out of `windows`), but the view
  // renders them with an age suffix rather than a bare "unavailable" (see
  // UsageSnapshot.staleWindows). Skip any meter that already has a fresh row.
  const freshKeys = new Set(windows.map((window) => window.key));
  const staleWindows = deserialized.filter(
    (window) => !freshKeys.has(window.key) && !isCachedUsageWindowFresh(window, capturedAt, now),
  );

  const unavailable = deserializeUnavailable(snapshot.unavailable, now);

  // A windowless row is not automatically worthless. Grok's collector reports
  // the subscription tier and no meters at all, so treating "no fresh windows"
  // as "nothing cached" deleted the only truthful thing we knew about the
  // account: `--refresh` wrote {plan: 'SuperGrok Heavy', windows: []}, the very
  // next plain `agents view` deserialized it to null, `readClaudeUsageCache`
  // pruned the row, and the row rendered "usage unavailable" one read after a
  // successful refresh. Keep a plan-bearing row — it renders as the plan alone,
  // and `deriveUsageStatusFromSnapshot` still returns null for zero windows, so
  // it can never read as a 0% bar or an "available" badge (the RUSH-2858
  // property that made expired windows drop in the first place).
  if (
    windows.length === 0 &&
    staleWindows.length === 0 &&
    !unavailable &&
    !snapshot.plan &&
    !snapshot.refreshHint
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
  };
}

/**
 * Carry a prior refusal marker forward across a daemon usage refresh, and drop
 * an expired one. A live `snapshot.unavailable` (a refusal just observed) wins.
 * `out_of_credits` survives refreshes with no reset — only a successful run
 * clears it (clearClaudeAccountRefusal). A `session_limit` survives only while
 * its reset time is still in the future.
 */
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

/**
 * Deserialize a cached `unavailable` marker, dropping an expired session_limit
 * but keeping a clock-less out_of_credits.
 */
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

/**
 * Persist a Claude tokens/credits exhaustion (`out of usage credits` / `monthly
 * spend limit`) from a real run. Unlike a rate/session limit this does NOT reset
 * on a clock, so no reset time is stored — rotation excludes the account until a
 * later successful run clears it via {@link clearClaudeAccountRefusal}.
 */
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

/**
 * Clear any persisted refusal marker for an account after a run SUCCEEDS on it.
 * This is the recovery path for `out_of_credits` (which has no clock) and also
 * proactively clears a stale `session_limit` the moment the account serves again.
 */
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

/**
 * Persist a Claude session-limit refusal from a real run until its stated reset.
 * This quota is not part of Anthropic's five-hour/weekly usage response.
 */
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

/**
 * Check whether the Claude OAuth credentials for a given home are usable.
 * Attempts a token refresh if the access token is expired.
 * Returns true only when a valid access token can be obtained.
 */
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

/**
 * Compact "time until reset" hint for the inline usage bars: "5m", "2h", "3d",
 * or "now" once elapsed. Deliberately coarse (single unit, whole numbers) so it
 * fits after a bar without wrapping the row — the detailed section
 * (`formatResetAt`) carries the precise clock time.
 */
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

/**
 * Compact elapsed-time label for a stale reading's age: "30m", "6h", "2d".
 * Coarse single-unit like {@link formatResetHint}, floored at "1m" so a
 * just-expired window never reads "0m".
 */
function formatAgeShort(diffMs: number): string {
  const mins = Math.max(1, Math.round(diffMs / 60000));
  if (mins < 60) return `${mins}m`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.round(hours / 24);
  return `${days}d`;
}

/**
 * Staleness suffix for a last-known window the freshness gate dropped. A window
 * whose reset/period boundary passed while the sample itself is still inside its
 * `windowMinutes` rolled OVER — the number describes a period that is done, so
 * name it ("period ended 1h ago", e.g. Grok's weekly billing period). A window
 * that aged past its own `windowMinutes` (Claude's 5h session read never
 * refreshed in time) is a stale sample of a still-rolling window, so report the
 * capture age ("6h old"). Falls back to the reset age, then a bare "stale".
 */
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
    return `stale (period ended ${formatAgeShort(now.getTime() - window.resetsAt!.getTime())} ago)`;
  }
  if (capturedAt) return `${formatAgeShort(now.getTime() - capturedAt.getTime())} old`;
  if (resetPassed) return `stale (period ended ${formatAgeShort(now.getTime() - window.resetsAt!.getTime())} ago)`;
  return 'stale';
}

/**
 * Render a dropped-but-last-known window as "S: ▍░░░░ 30% · 6h old": the gauge
 * and percentage exactly as a live bar, then a dim staleness suffix so the
 * number is always visible and unmistakably not current. VIEW-ONLY — these
 * windows are never in `snapshot.windows`, so routing never sees them.
 */
function renderStaleUsageWindow(
  window: UsageWindow,
  capturedAt: Date | null,
  shortLabel: string,
  now: Date,
): string {
  const bar = renderCompactUsageBar(window.usedPercent);
  const pct = colorUsage(`${Math.round(window.usedPercent)}%`, window.usedPercent);
  const suffix = formatStaleWindowSuffix(window, capturedAt, now);
  return `${chalk.gray(`${shortLabel}:`)} ${bar} ${pct} ${chalk.dim(`· ${suffix}`)}`;
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

/**
 * Resolve the Grok billing log to read usage from.
 *
 * `agents view grok` reads usage per INSTALLED VERSION, passing each version's
 * isolated home (`~/.agents/.history/versions/grok/<ver>`). Grok writes
 * `unified.jsonl` only to the shared real home `~/.grok/logs/unified.jsonl`
 * even though GROK_HOME isolates auth/config/models per version. A per-version
 * log, if one ever appears, still wins; otherwise we return the shared path
 * marked `shared: true` so the caller can attribute it to at most one identity.
 * Grok accounts are version-scoped (`NATIVE_ACCOUNT_CAPABILITIES.grok.scope ===
 * 'version'`) — the shared file has no owner, so it must not be stamped onto
 * every version home.
 */
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

/**
 * Identity extracted from Grok `auth.json` or (rarely) a billing line.
 * Live `billing: fetched credits config` lines carry no user/email — only
 * `creditUsagePercent` + `subscriptionTier` — so shared-log attribution
 * falls through to {@link sharedGrokLogAppliesToHome}.
 */
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

/**
 * Whether the shared `~/.grok` billing log may be attached to this home.
 * Grok logins are per version home; the shared last line is one account's
 * meter. Fail loud: never copy it onto every installed identity.
 */
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
    // Grok has no live usage API (`network: false`) — bars are last-seen from
    // this machine's unified.jsonl only. Drop windows whose billing period has
    // already ended so a stale 100% does not paint "rate-limited" after reset,
    // and so an expired 92% on one box cannot disagree with a fresh reading on
    // another. Missing `creditUsagePercent` never reaches here as a 0% bar
    // (see readLatestGrokBilling).
    const now = new Date();
    const windows = match.windows.filter((window) =>
      isCachedUsageWindowFresh(window, match.capturedAt, now)
    );
    // A window from an ended billing period is the LAST reading we saw — routing
    // must not trust it (kept out of `windows`), but the view renders it with a
    // "period ended Xh ago" suffix instead of the bare refresh hint. Only when
    // there is nothing at all to show does the refresh hint stand alone.
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

/**
 * Muse Code usage.
 *
 * Prefer live Meta Model API rate-limit headers when a key is available
 * (META_API_KEY / MODEL_API_KEY / ~/.config/muse/auth.json). Fall back to
 * aggregating `model_completed.usage` from local session.jsonl logs under
 * ~/.local/share/muse/sessions for a last-7-days token window.
 */
async function getMuseUsageInfo(options?: UsageOptions): Promise<UsageInfo> {
  try {
    const base = options?.home || os.homedir();

    // Honour a live Retry-After rather than re-arming the penalty (see
    // usage-backoff.ts). The local log fallback still works while the live
    // probe is throttled — only report the throttle when there is truly
    // nothing else to show.
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

/**
 * Probe Meta Model API for rate-limit headers. Uses GET /v1/models (no token
 * spend). The 429 backoff is noted by the CALLER via
 * {@link classifyUsageFetchFailure}, not here, so a throttled read is recorded
 * exactly once regardless of which branch of `getMuseUsageInfo` observes it.
 */
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

/**
 * Aggregate Muse session token usage from local session.jsonl files for the
 * last 7 days. Scales the bar against 10M tokens (soft visibility scale — Meta
 * is pay-as-you-go with no hard local cap).
 */
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
            // `creditUsagePercent` is Grok's weekly credit consumption (0-100);
            // the billing period's `end` is when that window resets.
            // Do NOT coerce a missing percent to 0 — a new period often lands a
            // billing line before the gauge is populated, and inventing 0% makes
            // `agents view` disagree across devices (and looks like a fresh week).
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
export interface CursorUsageResponse {
  /** The premium ("fast request") bucket the plan meters. */
  'gpt-4'?: CursorUsageModel | null;
  /** ISO timestamp the monthly request window resets from. */
  startOfMonth?: string | null;
  [model: string]: CursorUsageModel | string | null | undefined;
}

/**
 * Normalize Cursor's /api/usage payload into the common UsageWindow shape.
 *
 * Only free / legacy request-capped plans carry a `maxRequestUsage` on the
 * premium ("gpt-4") bucket — that's the fast-request cap the plan meters, and it
 * maps cleanly to a monthly window. Usage-based plans report `maxRequestUsage:
 * null` (no request cap — spend is metered in dollars instead), so they have no
 * bar to draw here and return no windows rather than a misleading empty gauge.
 */
export function normalizeCursorUsage(data: CursorUsageResponse): UsageWindow[] {
  const premium = data['gpt-4'];
  if (!premium || typeof premium !== 'object') return [];
  const max = premium.maxRequestUsage;
  if (typeof max !== 'number' || !Number.isFinite(max) || max <= 0) return [];
  const used = typeof premium.numRequests === 'number' ? premium.numRequests : 0;

  const startOfMonth =
    typeof data.startOfMonth === 'string' ? parseDateValue(data.startOfMonth) : null;
  // The request quota resets one calendar month after the period start. Guard the
  // month-end overflow: setMonth on a day the target month lacks (Jan 31 -> Feb 31)
  // rolls forward into the month after (Mar 3), so clamp back to the intended
  // month's last day.
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
export interface CursorPeriodUsageResponse {
  planUsage?: CursorPlanUsage | null;
  /** ISO timestamp, or a unix-ms string, marking the end of the current billing cycle. */
  billingCycleEnd?: string | number | null;
}

/** Response shape from Cursor's usage-summary endpoint (subset we render). */
export interface CursorUsageSummaryResponse {
  /** True on a plan with no consumption cap; only tiered self-serve plans populate the percent fields. */
  isUnlimited?: boolean | null;
  individualUsage?: {
    plan?: CursorPlanUsage | null;
  } | null;
  billingCycleEnd?: string | number | null;
}

/**
 * Normalize a single Cursor percent-based window (auto/api/total), or null when
 * the percent is not a finite number — the "no empty gauges" rule.
 * `windowMinutes` stays null: every window shares one billing-cycle reset
 * (`resetsAt`, from the explicit `billingCycleEnd`), not an inferred cadence, so
 * inferring one from the (repurposed) `session`/`week`/`month` key would let the
 * SWR cache zero the bar out long before the real reset.
 */
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

/**
 * Normalize Cursor's dashboard `get-current-period-usage` payload — the
 * primary usage source, giving the same Auto+Composer / API / Total breakdown
 * the web dashboard shows.
 */
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

/**
 * Normalize Cursor's `usage-summary` fallback payload — the same Auto/API/Total
 * breakdown nested under `individualUsage.plan`, used when the primary
 * dashboard endpoint returns no usable `planUsage` (seen on some
 * enterprise/team accounts). An unlimited plan (`isUnlimited: true`) with no
 * usable percent has nothing to draw and returns no windows, rather than a
 * misleading empty gauge.
 */
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

/**
 * Resolve the OAuth subject Cursor expects in the `WorkosCursorSessionToken`
 * cookie: the access token's own JWT `sub` claim first (the subject that
 * actually signed the token in hand), falling back to the subject
 * `cli-config.json` recorded at login when the token carries no usable `sub`.
 */
function resolveCursorSubject(accessToken: string, cfgSub: string | null): string | null {
  const jwtSub = normalizeString(decodeJwtPayload(accessToken)?.sub);
  return jwtSub || cfgSub;
}

/**
 * POST the dashboard current-period-usage endpoint and normalize its windows.
 * Returns null on any network/auth failure so the caller falls through to the
 * next source — only a genuine empty-windows response distinguishes "no usage
 * to report" from "couldn't reach this source".
 */
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

/**
 * GET the usage-summary fallback endpoint and normalize its windows. Same
 * null-on-failure contract as {@link fetchCursorPeriodWindows}.
 */
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

/**
 * Fetch Cursor usage. Cursor authenticates every one of these requests with a
 * `WorkosCursorSessionToken` cookie of the form `<oauth-subject>::<access-token>`
 * (the same pair the web dashboard sends), not a bearer header, so all three
 * sources below share one resolved cookie.
 *
 * Three sources, tried in order, because no single endpoint carries usable data
 * for every plan shape:
 *
 *  1. `get-current-period-usage` — the primary source, and the richest: the
 *     Auto+Composer / API / Total percent breakdown the dashboard itself shows.
 *  2. `usage-summary` — some enterprise/team accounts return no usable
 *     `planUsage` from (1); this nests the same three percentages under
 *     `individualUsage.plan` instead.
 *  3. The legacy `/api/usage` request-cap endpoint — the original source,
 *     kept as the final fallback for free/legacy plans that predate the
 *     percent-based breakdown above and only ever exposed a monthly request cap.
 *
 * The first source to yield a non-empty window list wins; a source that errors
 * or returns no usable numbers falls through to the next rather than surfacing
 * an error — only the last resort's own response/error is surfaced when every
 * source comes up empty, so a plan enrolled in exactly one billing model still
 * renders instead of reporting three swallowed failures.
 */
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
// The public installed-app OAuth client the released `agy` binary itself
// ships (Google installed-app clients are non-confidential by design — the
// same client community tooling uses). Needed because a Google token refresh
// requires the client id/secret pair the login was minted under.
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
export interface AntigravityQuotaBucket {
  modelId?: string | null;
  tokenType?: string | null;
  remainingFraction?: number | null;
  resetTime?: string | null;
}

/** Response shape from the Code Assist :retrieveUserQuota endpoint. */
export interface AntigravityQuotaResponse {
  buckets?: AntigravityQuotaBucket[] | null;
}

/**
 * Parse a stored `agy` OAuth payload into its token. Handles both on-disk
 * shapes: the raw `{ token: {…} }` JSON (Linux file fallback) and the
 * `go-keyring-base64:<base64>` wrapper zalando/go-keyring writes into the
 * macOS Keychain item (service `gemini`, account `antigravity`). Never throws
 * (malformed input => null).
 */
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

/**
 * True when the stored access token is expired (or inside the refresh leeway).
 * A missing/unparseable expiry is treated as still-fresh — the quota call
 * below is the source of truth if the token is actually dead (401 => render
 * nothing), and we never want to force a refresh without evidence.
 */
export function antigravityTokenNeedsRefresh(
  expiry: string | null | undefined,
  nowMs: number = Date.now(),
): boolean {
  if (!expiry) return false;
  const ms = Date.parse(expiry);
  if (Number.isNaN(ms)) return false;
  return nowMs + ANTIGRAVITY_REFRESH_LEEWAY_MS >= ms;
}

/**
 * Resolve the `agy` OAuth credential file. agy is a self-updating global
 * install (no per-version homes), but check the passed home first and then the
 * active location under the real HOME — mirrors resolveKimiCredentialPath.
 * Present only on Linux without a Secret Service daemon; macOS logins live in
 * the Keychain instead.
 */
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

/**
 * Load the stored `agy` OAuth token: the file fallback first, then the OS
 * keyring (macOS Keychain / Linux Secret Service — go-keyring's two stores;
 * the probe command pair mirrors antigravityOsKeyringProbe in agents.ts, with
 * `-w` on macOS to read the secret value, not just metadata). Returns null on
 * Windows or when no readable credential exists. Honors the
 * AGENTS_NO_KEYCHAIN_PROBE=1 test guard.
 */
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

/**
 * Refresh an `agy` access token against Google's token endpoint. This is safe
 * from a read path in a way Claude/WorkOS refreshes are NOT: Google's OAuth
 * refresh tokens are stable and non-rotating — a refresh mints a new access
 * token and leaves the refresh token (and every other live access token)
 * valid, so refreshing here cannot invalidate a concurrently running `agy`.
 * We still never write the refreshed token back: `agy` rewrites its own
 * keychain item on launch, and a read-only usage fetch must not mutate the
 * user's credential.
 */
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

/**
 * POST :retrieveUserQuota against the Code Assist endpoints in order, returning
 * the first successful bucket list. `buckets: null` when every endpoint rejects
 * (expired token, no quota API for the account) or the network fails — `status`
 * carries the LAST rejection's HTTP status (or null when every attempt threw)
 * so the caller can classify the failure instead of it reading as silence.
 */
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

/**
 * Normalize the per-model quota buckets into the common UsageWindow shape —
 * one window per model (`gemini-3.1-pro`, `gemini-2.5-flash`, …), keyed
 * `session` since each bucket is a short-cycle quota with its own reset time.
 * Duplicate buckets for one model keep the LOWEST remaining fraction (the
 * most conservative read). Sorted most-used first so the bar closest to
 * throttling leads the row. `windowMinutes` stays null: the API reports only
 * the reset timestamp, not the window length, and an inferred 5h session
 * length would wrongly zero the SWR cache between resets.
 */
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

/**
 * Fetch Antigravity usage via Google Code Assist's :retrieveUserQuota — the
 * quota API `agy` itself talks to (its log shows the sibling :loadCodeAssist
 * and :fetchAvailableModels calls on the same host). Auth is the stored `agy`
 * OAuth token (OS keyring on macOS, file fallback on Linux), refreshed
 * in-memory when expired — safe because Google's refresh tokens are
 * non-rotating (see refreshAntigravityAccessToken).
 */
async function getAntigravityUsageInfo(options?: UsageOptions): Promise<UsageInfo> {
  try {
    const token = await loadAntigravityOauth(options?.home);
    if (!token) return { snapshot: null, error: usageNoCredentialError('Antigravity') };

    let accessToken = normalizeString(token.access_token);
    if ((!accessToken || antigravityTokenNeedsRefresh(token.expiry)) && token.refresh_token) {
      accessToken = await refreshAntigravityAccessToken(token.refresh_token);
    }
    if (!accessToken) return { snapshot: null, error: usageExpiredCredentialError('Antigravity') };

    // Honour a live Retry-After rather than re-arming the penalty (see
    // usage-backoff.ts). No request at all while the window is open. Antigravity
    // previously had NO rate-limit backoff at all (RUSH-3040) — every refresh
    // re-hit a throttled endpoint.
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
