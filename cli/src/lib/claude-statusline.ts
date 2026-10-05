import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';

import {
  accountDisplayLabel,
  readClaudeHomeConfig,
  type ClaudeHomeIdentity,
} from './agent-spec/agents.js';
import { findNativeAccountByIdentity, type NativeAccount } from './account-registry.js';
import { atomicWriteFileSync } from './fs-atomic.js';
import { mergeClaudeUsageCacheWindows, type UsageWindow } from './accounting/usage.js';
import { loadReminders, pickReminderForSession } from './reminders.js';
import { readMeta } from './state.js';
import { machineId } from './machine-id.js';
import { recordRunAuthOutcome } from './auth-health.js';

export const CLAUDE_STATUSLINE_COMMAND = 'agents __claude-statusline';
const DELEGATE_FILE = path.join('.agents', 'claude-statusline-delegate');

// Match the private `__claude-statusline` subcommand, not the exact `agents ...` string: any
// binary name or path delegating to it recurses without bound (e.g. `agents-dev` fork-bombed the
// machine).
const STATUSLINE_SUBCOMMAND = '__claude-statusline';

// Set on the child env when spawning a delegate; if present we refuse to delegate again, a depth-1
// backstop if a self-reference slips past isStatusLineSelfReference().
const DELEGATE_GUARD_ENV = 'AGENTS_CLAUDE_STATUSLINE_DELEGATED';

// A hung or slow delegate must never pin a status-line render open — the render
// is re-invoked on every refresh, so an unbounded delegate accumulates processes.
const DELEGATE_TIMEOUT_MS = 5_000;

/** True when `command` re-invokes this status-line producer under any binary name or path. Both
 * read and write sides treat it as not a real external producer, since delegating to it is the
 * fork bomb. */
export function isStatusLineSelfReference(command: string): boolean {
  const trimmed = command.trim();
  if (!trimmed) return false;
  if (trimmed === CLAUDE_STATUSLINE_COMMAND) return true;
  return new RegExp(`(^|\\s)${STATUSLINE_SUBCOMMAND}(\\s|$)`).test(trimmed);
}

interface ClaudeStatusLinePayload {
  cwd?: string;
  session_id?: string;
  workspace?: { current_dir?: string };
  model?: { display_name?: string; id?: string };
  rate_limits?: {
    five_hour?: { used_percentage?: number; resets_at?: number };
    seven_day?: { used_percentage?: number; resets_at?: number };
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function versionHomeFromEnv(env: NodeJS.ProcessEnv): string | null {
  const configDir = env.CLAUDE_CONFIG_DIR?.trim();
  return configDir ? path.dirname(configDir) : null;
}

function windowFromNative(
  key: 'session' | 'week',
  value: { used_percentage?: number; resets_at?: number } | undefined,
): UsageWindow | null {
  if (!value || !Number.isFinite(value.used_percentage)) return null;
  const resetSeconds = value.resets_at;
  return {
    key,
    label: key === 'session' ? 'Current session' : 'Current week',
    shortLabel: key === 'session' ? 'S' : 'W',
    usedPercent: Math.max(0, Math.min(100, value.used_percentage!)),
    resetsAt: Number.isFinite(resetSeconds) ? new Date(resetSeconds! * 1000) : null,
    windowMinutes: key === 'session' ? 300 : 10_080,
  };
}

export function ingestClaudeStatusLineUsage(
  payload: ClaudeStatusLinePayload,
  identity: ClaudeHomeIdentity | null,
  versionHome?: string | null,
): boolean {
  if (!identity?.usageKey || !payload.rate_limits) return false;
  const windows = [
    windowFromNative('session', payload.rate_limits.five_hour),
    windowFromNative('week', payload.rate_limits.seven_day),
  ].filter((value): value is UsageWindow => value !== null);
  if (windows.length === 0) return false;
  mergeClaudeUsageCacheWindows(identity.usageKey, {
    source: 'live',
    sourceLabel: 'Claude response rate limits',
    capturedAt: new Date(),
    windows,
    freshness: { source: 'statusline', poller: machineId() },
  });
  // A status-line payload with rate_limits IS a real inference response — the
  // token authenticated moments ago. Record that as the per-account auth FACT
  // (`last used ok`), keyed to the account this box actually ran (PHNX-4116).
  recordRunAuthOutcome({
    agent: 'claude',
    accountId: resolveNativeAccount(identity)?.id ?? null,
    home: versionHome ?? null,
    outcome: { ok: true },
  });
  // Keep this box's own state file current so the next placement probe or
  // usage-sync fan-out carries this reading; the file is local, no transport.
  void import('./accounting/usage-sync.js')
    .then((mod) => mod.publishUsageSnapshotToSharedStore())
    .catch(() => { /* best-effort own-state refresh */ });
  return true;
}

/** Where the running Claude keeps its config: the version home if the shim set CLAUDE_CONFIG_DIR,
 * else the real HOME, matching Claude Code's own resolution. */
export function claudeHomeFromEnv(env: NodeJS.ProcessEnv): string {
  return versionHomeFromEnv(env) ?? os.homedir();
}

/** Identity of the running Claude, read once per render from its home's `.claude.json`; null if
 * never signed in. Sync and file-only because it runs on every refresh. */
export function readClaudeIdentity(claudeHome: string): ClaudeHomeIdentity | null {
  return readClaudeHomeConfig(claudeHome)?.identity ?? null;
}

/** The registered native account (`agents accounts`) for the running Claude, or null if unnamed. */
export function resolveNativeAccount(identity: ClaudeHomeIdentity | null): NativeAccount | null {
  return identity ? findNativeAccountByIdentity(readMeta(), 'claude', identity) : null;
}

/** Format the signed-in account as a statusline part ('' if never signed in): a named login shows
 * its registered name; an unnamed one shows the email plus org name for Team/Enterprise seats. */
export function formatAccountPart(
  identity: ClaudeHomeIdentity | null,
  account: NativeAccount | null,
): string {
  if (!identity) return '';
  if (account) return account.name;
  return accountDisplayLabel({ ...identity, signedIn: true });
}

function delegatePath(versionHome: string): string {
  return path.join(versionHome, DELEGATE_FILE);
}

export function renderDelegate(payload: string, versionHome: string): string {
  // Already running as a delegate hop — never spawn another. Hard recursion stop.
  if (process.env[DELEGATE_GUARD_ENV]) return '';
  let command = '';
  try { command = fs.readFileSync(delegatePath(versionHome), 'utf8').trim(); } catch { return ''; }
  if (!command || isStatusLineSelfReference(command)) return '';
  const result = spawnSync(command, {
    shell: true,
    input: payload,
    encoding: 'utf8',
    env: { ...process.env, [DELEGATE_GUARD_ENV]: '1' },
    timeout: DELEGATE_TIMEOUT_MS,
  });
  return result.status === 0 ? result.stdout.trim() : '';
}

/** Format a reminder as a dimmed statusline part (empty when none); a diamond marks it. */
export function formatReminderPart(short: string | undefined): string {
  const text = short?.trim();
  return text ? `\x1b[2m◆ ${text}\x1b[22m` : '';
}

export function renderClaudeStatusLine(
  payload: ClaudeStatusLinePayload,
  host = os.hostname().split('.')[0] || os.hostname(),
  delegated = '',
  reminder = '',
  account = '',
): string {
  const model = payload.model?.display_name?.trim() || payload.model?.id?.trim() || 'model pending';
  // host · account · model: who is running, as which account, on which model —
  // the account sits before the model so a glance answers "whose quota is this".
  const parts = [host];
  if (account) parts.push(account);
  parts.push(model);
  if (delegated) parts.push(delegated);
  const fiveHour = payload.rate_limits?.five_hour?.used_percentage;
  const sevenDay = payload.rate_limits?.seven_day?.used_percentage;
  if (Number.isFinite(fiveHour)) parts.push(`5h ${Math.round(fiveHour!)}%`);
  if (Number.isFinite(sevenDay)) parts.push(`7d ${Math.round(sevenDay!)}%`);
  if (reminder) parts.push(reminder);
  return parts.join(' · ');
}

/** Resolve the per-session reminder, or ''. A malformed reminders file is swallowed on purpose (a
 * broken prompt is worse than none); `agents reminders` surfaces it. */
export function resolveReminderPart(sessionId?: string): string {
  try {
    return formatReminderPart(pickReminderForSession(loadReminders(), sessionId)?.short);
  } catch {
    return '';
  }
}

export async function runClaudeStatusLine(): Promise<number> {
  const raw = await new Promise<string>((resolve, reject) => {
    let input = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => { input += chunk; });
    process.stdin.on('end', () => resolve(input));
    process.stdin.on('error', reject);
  });
  let payload: ClaudeStatusLinePayload;
  try {
    const parsed: unknown = JSON.parse(raw);
    payload = isRecord(parsed) ? parsed as ClaudeStatusLinePayload : {};
  } catch {
    payload = {};
  }
  const versionHome = versionHomeFromEnv(process.env);
  const identity = readClaudeIdentity(claudeHomeFromEnv(process.env));
  if (versionHome) ingestClaudeStatusLineUsage(payload, identity, versionHome);
  process.stdout.write(renderClaudeStatusLine(
    payload,
    undefined,
    versionHome ? renderDelegate(raw, versionHome) : '',
    resolveReminderPart(payload.session_id),
    formatAccountPart(identity, resolveNativeAccount(identity)),
  ));
  return 0;
}

export function installClaudeStatusLine(versionHome: string): { changed: boolean; error?: string } {
  const settingsPath = path.join(versionHome, '.claude', 'settings.json');
  try {
    let settings: Record<string, unknown> = {};
    if (fs.existsSync(settingsPath)) {
      const parsed: unknown = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
      if (!isRecord(parsed)) return { changed: false, error: 'settings.json is not an object' };
      settings = parsed;
    }
    const priorStatusLine = isRecord(settings.statusLine) ? settings.statusLine : {};
    const existing = typeof priorStatusLine.command === 'string'
      ? priorStatusLine.command.trim()
      : '';
    if (existing === CLAUDE_STATUSLINE_COMMAND) return { changed: false };
    if (existing && !isStatusLineSelfReference(existing)) {
      // A genuine third-party status-line command → preserve it as a delegate.
      fs.mkdirSync(path.dirname(delegatePath(versionHome)), { recursive: true });
      atomicWriteFileSync(delegatePath(versionHome), `${existing}\n`);
    } else {
      // Empty, or our own subcommand under a different binary name
      // (`agents-dev __claude-statusline`, an absolute path, …). Saving that as a
      // delegate is the fork bomb — never persist it. Drop any prior delegate.
      fs.rmSync(delegatePath(versionHome), { force: true });
    }
    settings.statusLine = {
      ...priorStatusLine,
      type: 'command',
      command: CLAUDE_STATUSLINE_COMMAND,
    };
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    atomicWriteFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`);
    return { changed: true };
  } catch (error) {
    return { changed: false, error: error instanceof Error ? error.message : String(error) };
  }
}
