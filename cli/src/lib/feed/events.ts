/**
 * Centralized event logging for agents-cli.
 *
 * Structured JSONL audit logs at ~/.agents/.history/events/YYYY-MM-DD/events.jsonl with
 * lossless numbered gzip rotation at 10 MiB and bounded retention.
 *
 * Features:
 * - Rich metadata: hostname, platform, arch, pid, timezone
 * - Timing helpers: measure operation duration automatically
 * - Truncation: long inputs/outputs are trimmed with ellipsis
 * - Permissions: logs dir is 0700, files are 0600 (owner-only)
 * - Performance tracking: withTiming() wrapper for any async function
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { createHash } from 'node:crypto';
import { gzipSync, gunzipSync } from 'node:zlib';
import { ensureLockTarget, withFileLock, withFileLockAsync } from '../fs-atomic.js';
import { getUserAgentsDir } from '../state.js';
import { stampProvenance, resetEventProvenanceForTest } from '../event-provenance.js';
import type { ActorKind } from '../actor.js';
import { recordSample } from '../perf/spool.js';

/**
 * Perf warehouse write. SYNCHRONOUS by design (PHNX-3497): `recordSample` is an
 * `appendFileSync` that never opens SQLite (see perf/spool.ts), so calling it
 * directly costs one file append and lands the row before this function returns.
 * It MUST NOT be deferred behind a `void import().then(...)`: the `agent.run`
 * timer ends at the very tail of `agents run`, and the CLI process exits before
 * any deferred microtask runs — so a fire-and-forget spool write was silently
 * lost on every foreground run, leaving the PHNX-3468 startup-phase surface with
 * no data. (Hooks were unaffected only because their shim appends the spool line
 * synchronously in bash.)
 */
function recordPerfTiming(payload: {
  label: string;
  durationMs: number;
  status?: string;
  agent?: string;
  version?: string;
  sessionId?: string;
  cwd?: string;
  /** Sub-phase timings (e.g. { startup: 42 } from createTimer marks). Persisted
   *  in the sample's meta_json so a break-out like agent.run's `startup` cost is
   *  trackable across the fleet, not just the total durationMs (PHNX-3468). */
  phases?: Record<string, number>;
}): void {
  try {
    const phases = payload.phases && Object.keys(payload.phases).length > 0 ? payload.phases : undefined;
    const metaJson = phases ? JSON.stringify({ phases }) : undefined;
    recordSample({
      kind: 'perf.timing',
      label: payload.label,
      durationMs: payload.durationMs,
      status: payload.status,
      agent: payload.agent,
      agentVersion: payload.version,
      sessionId: payload.sessionId,
      cwd: payload.cwd,
      metaJson,
    });
  } catch {
    // fail soft
  }
}

// ─── Constants ────────────────────────────────────────────────────────────────

// Resolved lazily: events.ts is imported transitively by most CLI surfaces, and
// import itself must stay side-effect free. Tests may override the exact path.
// AGENTS_EVENTS_PATH redirects the sink — a test seam like AGENTS_SECRETS_AGENT_DIR:
// unlike _resetForTest it survives a bare reset AND propagates to CLI subprocesses
// a test spawns, so fixture events can never land in the user's real log (#910).
let _eventsPath: string | undefined;
let _eventsPathOverride = false;
let _legacyMigrationChecked = false;
let _userAgentsDirOverride: string | undefined;
function userAgentsDir(): string {
  return _userAgentsDirOverride ?? getUserAgentsDir();
}
function localDateKey(date: Date = new Date()): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function eventsRoot(): string {
  if (_eventsPathOverride && _eventsPath) return path.dirname(_eventsPath);
  return path.join(userAgentsDir(), '.history', 'events');
}

function eventsPath(date: Date = new Date()): string {
  if (_eventsPathOverride && _eventsPath) return _eventsPath;
  const override = _userAgentsDirOverride ? undefined : process.env.AGENTS_EVENTS_PATH;
  if (override) {
    _eventsPathOverride = true;
    return (_eventsPath = override);
  }
  return path.join(eventsRoot(), localDateKey(date), 'events.jsonl');
}

function eventsDir(date: Date = new Date()): string {
  return path.dirname(eventsPath(date));
}

/** Default retention period in days. */
const DEFAULT_RETENTION_DAYS = 7;

/** Default total footprint for the active log plus gzip archives (50 MiB). */
const DEFAULT_MAX_STORAGE_BYTES = 50 * 1024 * 1024;

/** Cross-process marker used to avoid a full archive scan on every append. */
const PRUNE_MARKER = '.last-prune';

/** Default max length for truncated strings. */
const DEFAULT_TRUNCATE_LENGTH = 500;

/** Gzip rotation threshold in bytes (10 MB). */
const GZIP_ROTATION_BYTES = 10 * 1024 * 1024;

/** Environment variable to disable event logging. */
const DISABLE_ENV_VAR = 'AGENTS_DISABLE_EVENT_LOG';

/** Check if audit logging is disabled via environment variable. */
function isDisabled(): boolean {
  const val = process.env[DISABLE_ENV_VAR];
  return val === '1' || val === 'true';
}

/** Directory permissions (owner read/write/execute only). */
const DIR_MODE = 0o700;

/** File permissions (owner read/write only). */
const FILE_MODE = 0o600;

// ─── Types ────────────────────────────────────────────────────────────────────

export type EventLevel = 'audit' | 'warn' | 'info' | 'debug';

export type EventType =
  // Agent lifecycle
  | 'agent.run.start'
  | 'agent.run.end'
  | 'agent.spawn.start'
  | 'agent.spawn.end'
  // Run-dispatch outcome (single chokepoint in exec — replaces the separate
  // hash-chained audit/log.jsonl product; readable via --include runs)
  | 'run.dispatched'
  // Pre-launch marker emitted RIGHT BEFORE the harness child is spawned, on the
  // device that will run it — unlike `run.dispatched` (which fires only at
  // FINALIZE, post-exit), this records a launch that then sits stuck at a login
  // screen and never finalizes. Carries `launchedLoggedOut` so a launch into a
  // logged-out version is visible instead of silent (the yosemite-m3 2.1.219
  // incident). See spawnAgent in lib/exec.ts.
  | 'run.launch'
  // Daemon lifecycle (always-on process: secrets broker, browser IPC, scheduler)
  | 'daemon.start'
  | 'daemon.stop'
  | 'daemon.error'
  | 'daemon.info'
  // Routines (scheduler fires from the daemon — first-class, not log-mirror)
  | 'routine.start'
  | 'routine.end'
  // Watchdog (stalled-session nudge pass; structured counts)
  | 'watchdog.action'
  // Version management
  | 'version.install'
  | 'version.switch'
  | 'version.remove'
  // Skills
  | 'skill.install'
  | 'skill.remove'
  // Browser
  | 'browser.launch'
  | 'browser.close'
  | 'browser.navigate'
  | 'browser.screenshot'
  // Computer (native desktop automation via the computer-helper daemon)
  | 'computer.action'
  // Secrets (no values logged) — the value-free lifecycle vocabulary the
  // in-repo secrets engine used to funnel through its own emitSecretAudit
  // chokepoint. That engine (and its audit emission) moved out of this repo
  // entirely with the standalone `secrets` engine (PHNX-3989); this vocabulary
  // stays as the stable event-name union other callers may still use.
  | 'secrets.get'
  | 'secrets.unlocked'
  | 'secrets.create'
  | 'secrets.import'
  | 'secrets.export'
  | 'secrets.view'
  | 'secrets.lease-denied'
  | 'secrets.lease-expire'
  | 'secrets.set'
  | 'secrets.delete'
  | 'secrets.rename'
  // Cloud dispatch
  | 'cloud.dispatch'
  | 'cloud.complete'
  | 'cloud.cancel'
  | 'cloud.message'
  // Teams
  | 'teams.create'
  | 'teams.add'
  | 'teams.start'
  | 'teams.complete'
  | 'teams.disband'
  // Hooks
  | 'hook.fire'
  | 'hook.complete'
  | 'hook.error'
  // MCP
  | 'mcp.add'
  | 'mcp.remove'
  | 'mcp.register'
  // Resources
  | 'resource.sync'
  // Rotation (account/credential). `rotation.resolved` = a version was picked;
  // `rotation.unresolved` = the route was refused (e.g. entirely stale usage,
  // PHNX-2526) and the caller diverted to a picker or a loud exit.
  | 'rotation.resolved'
  | 'rotation.unresolved'
  // Commands (CLI entry points)
  | 'command.start'
  | 'command.end'
  // Performance
  | 'perf.timing'
  // Sessions
  | 'session.start'
  | 'session.end'
  // Webhooks
  | 'webhook.received'
  | 'webhook.authorized'
  | 'webhook.rejected'
  | 'webhook.matched'
  | 'webhook.fired'
  // Settling an already-acked delivery failed. The 202 ack (RUSH-2548) means no
  // HTTP status can carry this, so it is the only durable record of the failure.
  | 'webhook.failed'
  | 'webhook.handler.start'
  | 'webhook.handler.end'
  // Agent activity (emitted at hook time; see lib/activity.ts). These share the
  // one event vocabulary so operational and agent-semantic events read as a
  // single stream via lib/event-stream.ts.
  | 'plan.created'
  | 'pr.opened'
  | 'pr.merged'
  | 'worktree.created'
  | 'worktree.removed'
  | 'commit.created'
  | 'pushed'
  | 'subagent.spawned'
  | 'artifact.created'
  | 'task.completed'
  | 'checklist.created'
  | 'status.posted'
  | 'file.edited'
  // Factory (the VS Code extension). Emitted OUT OF PROCESS via
  // `agents events emit` — the extension host is not an agents-cli process, so
  // it cannot call emit() directly. See commands/events.ts.
  | 'factory.command'
  | 'factory.action'
  | 'factory.uri'
  | 'factory.launch'
  // Generic
  | 'friction'
  | 'error'
  | 'warn'
  | 'info'
  | 'debug';

/**
 * Every {@link EventType}, as a runtime-checkable table.
 *
 * Typed `Record<EventType, true>` on purpose: the object literal is
 * exhaustiveness-checked at COMPILE time, so adding a member to the union
 * without adding it here fails `tsc`. That is what keeps the runtime validator
 * (`isEventType`, used by `agents events emit` to reject an unknown kind from an
 * out-of-process producer) from silently drifting behind the union.
 */
const EVENT_TYPE_TABLE: Record<EventType, true> = {
  'agent.run.start': true, 'agent.run.end': true, 'agent.spawn.start': true, 'agent.spawn.end': true,
  'run.dispatched': true,
  'run.launch': true,
  'daemon.start': true, 'daemon.stop': true, 'daemon.error': true, 'daemon.info': true,
  'routine.start': true, 'routine.end': true,
  'watchdog.action': true,
  'version.install': true, 'version.switch': true, 'version.remove': true,
  'skill.install': true, 'skill.remove': true,
  'browser.launch': true, 'browser.close': true, 'browser.navigate': true, 'browser.screenshot': true,
  'computer.action': true,
  'secrets.get': true, 'secrets.unlocked': true, 'secrets.create': true, 'secrets.import': true, 'secrets.export': true, 'secrets.view': true, 'secrets.lease-denied': true, 'secrets.lease-expire': true, 'secrets.set': true, 'secrets.delete': true, 'secrets.rename': true,
  'cloud.dispatch': true, 'cloud.complete': true, 'cloud.cancel': true, 'cloud.message': true,
  'teams.create': true, 'teams.add': true, 'teams.start': true, 'teams.complete': true, 'teams.disband': true,
  'hook.fire': true, 'hook.complete': true, 'hook.error': true,
  'mcp.add': true, 'mcp.remove': true, 'mcp.register': true,
  'resource.sync': true,
  'rotation.resolved': true,
  'rotation.unresolved': true,
  'command.start': true, 'command.end': true,
  'perf.timing': true,
  'session.start': true, 'session.end': true,
  'webhook.received': true, 'webhook.authorized': true, 'webhook.rejected': true, 'webhook.matched': true,
  'webhook.fired': true, 'webhook.failed': true, 'webhook.handler.start': true, 'webhook.handler.end': true,
  'plan.created': true, 'pr.opened': true, 'pr.merged': true, 'worktree.created': true,
  'worktree.removed': true, 'commit.created': true, 'pushed': true, 'subagent.spawned': true,
  'artifact.created': true, 'task.completed': true, 'checklist.created': true, 'status.posted': true,
  'file.edited': true,
  'factory.command': true, 'factory.action': true, 'factory.uri': true, 'factory.launch': true,
  'friction': true, 'error': true, 'warn': true, 'info': true, 'debug': true,
};

/** Every known event kind. Derived from {@link EVENT_TYPE_TABLE}, never hand-listed. */
export const EVENT_TYPES: readonly EventType[] = Object.keys(EVENT_TYPE_TABLE) as EventType[];

const EVENT_TYPE_SET: ReadonlySet<string> = new Set<string>(EVENT_TYPES);

/** Runtime guard for an event kind arriving from outside this process. */
export function isEventType(value: string): value is EventType {
  return EVENT_TYPE_SET.has(value);
}

const AUDIT_EVENTS: ReadonlySet<string> = new Set([
  'command.start', 'command.end',
  'run.dispatched',
  // Sibling of run.dispatched, and the MORE reliable signal for a stuck /
  // logged-out launch (it fires pre-spawn, before an agent can hang at a login
  // screen and never finalize). Must surface under --level audit --include runs.
  'run.launch',
  'secrets.get', 'secrets.unlocked', 'secrets.create', 'secrets.import', 'secrets.export', 'secrets.view', 'secrets.lease-denied', 'secrets.lease-expire',
  'secrets.set', 'secrets.delete', 'secrets.rename',
  'teams.create', 'teams.add', 'teams.start', 'teams.complete', 'teams.disband',
  'cloud.dispatch', 'cloud.complete', 'cloud.cancel', 'cloud.message',
  'version.install', 'version.switch', 'version.remove',
  'skill.install', 'skill.remove',
  'mcp.add', 'mcp.remove', 'mcp.register',
  'rotation.resolved', 'rotation.unresolved',
  'session.start', 'session.end',
  // Daemon lifecycle (always-on process start/stop/error is audit-relevant).
  // browser.* / computer.action stay info — they are already on the event stream;
  // elevating them to audit would flood the security lane (see events.test.ts).
  'daemon.start', 'daemon.stop', 'daemon.error',
  // An external process reaching into the user's editor (the CLI's
  // vscodium-agent backend driving `/spawn` / `/inject` / `/focus`) is a
  // "who reached in from outside" fact, which is what the audit lane answers.
  // The other factory.* kinds are ordinary info — a palette press is not audit.
  'factory.uri',
]);

export function levelFor(event: EventType): EventLevel {
  if (event === 'warn') return 'warn';
  if (event === 'debug') return 'debug';
  if (AUDIT_EVENTS.has(event)) return 'audit';
  return 'info';
}

export interface EventMeta {
  ts: string;
  tz: string;
  tzName: string;
  hostname: string;
  /**
   * Normalized, joinable device id (`machine-id.ts::machineId()`) — the same key
   * `agents devices`/session-sync use, so an event can be matched to a device.
   * `hostname` is the raw `os.hostname()`; `machineId` is `zion` for `Zion.local`.
   * Optional on the type so legacy records (pre-provenance-floor) and the activity
   * stream still parse; `emit()` always stamps it on the operational log.
   */
  machineId?: string;
  platform: NodeJS.Platform;
  arch: string;
  pid: number;
  ppid: number;
  event: EventType;
  level: EventLevel;
  caller: string;
  session?: string;
  osUser: string;
  transport: 'local' | 'ssh';
  sshClientIp?: string;
  /** Resolved actor id — which human/agent is behind this event (RUSH-2020). */
  actor?: string;
  /** Actor kind (`human`/`agent`). */
  kind?: ActorKind | 'unknown';
}

export interface EventPayload {
  // Identity
  agent?: string;
  version?: string;
  sessionId?: string;
  /** Spawn-time join key (AGENT_LAUNCH_ID) mapping this action to its launch. */
  launchId?: string;
  /** The session that spawned this one (AGENTS_PARENT_SESSION_ID) — lineage edge. */
  parentSessionId?: string;

  // Context
  cwd?: string;
  /** Top-level command group, e.g. 'teams', 'secrets' — the audit filter key. */
  module?: string;
  /** Full command path, e.g. 'teams create', 'secrets get'. */
  command?: string;
  args?: string[];

  // Input/Output (truncated)
  input?: string;
  output?: string;

  // Prompt is NEVER persisted in raw form — only length + hash.
  // Users paste secrets into prompts; raw retention is a leak.
  prompt_length?: number;
  prompt_sha256?: string;

  // Timing
  durationMs?: number;
  startupMs?: number;

  // Result
  exitCode?: number;
  status?: string;
  error?: string;
  errorStack?: string;

  // Extensible
  [key: string]: unknown;
}

export type EventRecord = EventMeta & EventPayload;

// ─── Helpers ──────────────────────────────────────────────────────────────────

function getTimezoneOffset(): string {
  const offset = new Date().getTimezoneOffset();
  const sign = offset <= 0 ? '+' : '-';
  const hours = String(Math.floor(Math.abs(offset) / 60)).padStart(2, '0');
  const mins = String(Math.abs(offset) % 60).padStart(2, '0');
  return `${sign}${hours}:${mins}`;
}

function getTimezoneName(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch {
    return 'Unknown';
  }
}

function ensureLogsDir(): void {
  eventsPath(); // Resolve an explicit AGENTS_EVENTS_PATH before migration checks.
  migrateLegacyEventLogs();
  if (!fs.existsSync(eventsDir())) {
    fs.mkdirSync(eventsDir(), { recursive: true, mode: DIR_MODE });
  } else {
    // Ensure permissions are correct on existing dir
    try {
      fs.chmodSync(eventsDir(), DIR_MODE);
    } catch {
      // May fail if not owner
    }
  }
}

/**
 * Move root-level and interim flat-history event families into dated directories.
 *
 * The common case is a whole-family rename into an empty destination. A
 * Each segment is assigned to the local calendar day of its filesystem mtime;
 * new writes are split by day at source. A partially completed migration keeps
 * the destination active file authoritative and assigns a fresh archive number,
 * so no record is overwritten or silently discarded. The legacy active-file
 * lock serializes this with older installed processes that still append there.
 */
export function migrateLegacyEventLogs(userDir: string = userAgentsDir()): number {
  if (_eventsPathOverride || _legacyMigrationChecked) return 0;
  _legacyMigrationChecked = true;

  const destinationRoot = path.join(userDir, '.history', 'events');
  const legacyActive = path.join(userDir, 'events.jsonl');
  const interimActive = path.join(destinationRoot, 'events.jsonl');
  const listArchives = (dir: string): Array<{ file: string; number: number }> => {
    try {
      return fs.readdirSync(dir)
      .map((file) => ({ file, match: file.match(/^events\.(\d+)\.jsonl\.gz$/) }))
      .filter((entry): entry is { file: string; match: RegExpMatchArray } => entry.match !== null)
      .map((entry) => ({ file: entry.file, number: Number(entry.match[1]) }))
      .sort((a, b) => a.number - b.number);
    } catch {
      return [];
    }
  };
  const hasSourceFiles = fs.existsSync(legacyActive) || fs.existsSync(interimActive) ||
    listArchives(userDir).length > 0 || listArchives(destinationRoot).length > 0;

  if (!hasSourceFiles) return 0;

  try {
    fs.mkdirSync(destinationRoot, { recursive: true, mode: DIR_MODE });
    ensureLockTarget(legacyActive, '', DIR_MODE);
    return withFileLock(legacyActive, () => {
      ensureLockTarget(interimActive, '', DIR_MODE);
      return withFileLock(interimActive, () => {
        const sourceFamilies = [
          { dir: userDir, active: legacyActive, archives: listArchives(userDir) },
          { dir: destinationRoot, active: interimActive, archives: listArchives(destinationRoot) },
        ];
        let moved = 0;

        const nextArchiveNumber = (dir: string): number => {
          const numbers = fs.readdirSync(dir)
            .map((file) => file.match(/^events\.(\d+)\.jsonl\.gz$/))
            .filter((match): match is RegExpMatchArray => match !== null)
            .map((match) => Number(match[1]));
          return (numbers.length ? Math.max(...numbers) : 0) + 1;
        };
        const withDestinationLock = <T>(dayDir: string, fn: () => T): T => {
          const destinationActive = path.join(dayDir, 'events.jsonl');
          fs.mkdirSync(dayDir, { recursive: true, mode: DIR_MODE });
          ensureLockTarget(destinationActive, '', DIR_MODE);
          return withFileLock(destinationActive, fn);
        };

        for (const family of sourceFamilies) {
          const activeBytes = fs.existsSync(family.active) ? fs.statSync(family.active).size : 0;
          if (activeBytes > 0) {
            const activeStat = fs.statSync(family.active);
            const dayDir = path.join(destinationRoot, localDateKey(activeStat.mtime));
            withDestinationLock(dayDir, () => {
              const archivePath = path.join(dayDir, `events.${nextArchiveNumber(dayDir)}.jsonl.gz`);
              fs.writeFileSync(archivePath, gzipSync(fs.readFileSync(family.active)), { mode: FILE_MODE });
              fs.utimesSync(archivePath, activeStat.atime, activeStat.mtime);
              fs.truncateSync(family.active, 0);
            });
            moved++;
          }

          for (const archive of family.archives) {
            const source = path.join(family.dir, archive.file);
            const dayDir = path.join(destinationRoot, localDateKey(fs.statSync(source).mtime));
            withDestinationLock(dayDir, () => {
              const destination = path.join(dayDir, `events.${nextArchiveNumber(dayDir)}.jsonl.gz`);
              fs.renameSync(source, destination);
            });
            moved++;
          }

          try {
            if (fs.existsSync(family.active) && fs.statSync(family.active).size === 0) fs.unlinkSync(family.active);
          } catch { /* an older process may have reopened it */ }
        }
        return moved;
      });
    });
  } catch {
    // Audit logging must remain fail-soft. Files stay at the legacy path and a
    // later process retries because this guard is process-local.
    _legacyMigrationChecked = false;
    return 0;
  }
}

// ─── Redaction ────────────────────────────────────────────────────────────────

/**
 * Replace a prompt string with length + short SHA so we can correlate runs
 * without persisting the raw text. Returns the fields to spread into a payload.
 */
export function redactPrompt(prompt: string | null | undefined): { prompt_length?: number; prompt_sha256?: string } {
  if (prompt == null) return {};
  return {
    prompt_length: prompt.length,
    prompt_sha256: createHash('sha256').update(prompt).digest('hex').slice(0, 16),
  };
}

const TOKEN_LIKE = /(sk_(?:live|test)_|pk_(?:live|test)_|ghp_|gho_|ghu_|ghs_|xox[bpars]-|AKIA|ASIA|AIza|Bearer\s+|eyJ[A-Za-z0-9_-]+\.)/i;
const SECRET_PATH = /\/(secrets|credentials|\.env|user\.yaml)\b/i;
const SENSITIVE_ARG_NAME = /password|secret|token|key|api[-_]?key|auth/i;
const SENSITIVE_PAYLOAD_KEY = /password|secret|token|api[-_]?key|auth/i;
const RESERVED_META_KEYS = new Set([
  'ts', 'tz', 'tzName', 'hostname', 'machineId', 'platform', 'arch', 'pid', 'ppid',
  'event', 'level', 'caller', 'session', 'osUser', 'transport', 'sshClientIp',
  'actor', 'kind',
]);

function promptMarker(value: string): string {
  const { prompt_length, prompt_sha256 } = redactPrompt(value);
  return `[REDACTED prompt length=${prompt_length} sha256=${prompt_sha256}]`;
}

/**
 * Mask argv entries that look like tokens or secret paths. Preserves structure
 * for debugging but drops the sensitive substring.
 */
export function redactArgs(args: string[] | undefined): string[] | undefined {
  if (!args) return undefined;
  const result: string[] = [];
  let redactNext = false;
  let promptNext = false;

  for (const arg of args) {
    if (redactNext) {
      if (arg.startsWith('-')) {
        redactNext = false;
      } else {
        result.push('[REDACTED]');
        redactNext = false;
        continue;
      }
    }
    if (promptNext) {
      if (arg.startsWith('-')) {
        promptNext = false;
      } else {
        result.push(arg.length > 200 ? promptMarker(arg) :
          TOKEN_LIKE.test(arg) || SECRET_PATH.test(arg) ? '[REDACTED]' : arg);
        promptNext = false;
        continue;
      }
    }

    const equals = arg.indexOf('=');
    const flag = equals >= 0 ? arg.slice(0, equals) : arg;
    const value = equals >= 0 ? arg.slice(equals + 1) : undefined;
    if (flag.startsWith('-') && SENSITIVE_ARG_NAME.test(flag)) {
      result.push(value === undefined ? flag : `${flag}=[REDACTED]`);
      redactNext = value === undefined;
      continue;
    }
    if (flag === '--body' || flag === '--value') {
      result.push(value === undefined ? flag : `${flag}=[REDACTED]`);
      redactNext = value === undefined;
      continue;
    }
    if (flag === '--prompt') {
      if (value === undefined) {
        result.push(flag);
        promptNext = true;
      } else {
        const safe = value.length > 200 ? promptMarker(value) :
          TOKEN_LIKE.test(value) || SECRET_PATH.test(value) ? '[REDACTED]' : value;
        result.push(`${flag}=${safe}`);
      }
      continue;
    }
    result.push(TOKEN_LIKE.test(arg) || SECRET_PATH.test(arg) ? '[REDACTED]' : arg);
  }
  return result;
}

// ─── Truncation ───────────────────────────────────────────────────────────────

/**
 * Truncate a string to maxLength, adding ellipsis if truncated.
 * Returns undefined for null/undefined input.
 */
export function truncate(
  str: string | null | undefined,
  maxLength: number = DEFAULT_TRUNCATE_LENGTH
): string | undefined {
  if (str == null) return undefined;
  if (str.length <= maxLength) return str;
  return str.slice(0, maxLength - 3) + '...';
}

/**
 * Truncate all string values in a payload object.
 */
function sanitizeNested(value: unknown, key: string, maxLength: number): unknown {
  if (SENSITIVE_PAYLOAD_KEY.test(key)) return '[REDACTED]';
  if (typeof value === 'string') {
    if (TOKEN_LIKE.test(value) || SECRET_PATH.test(value)) return '[REDACTED]';
    return truncate(value, maxLength);
  }
  if (Array.isArray(value)) {
    return value.slice(0, 10).map((item) => sanitizeNested(item, '', maxLength));
  }
  if (value && typeof value === 'object') {
    const result: Record<string, unknown> = {};
    for (const [nestedKey, nestedValue] of Object.entries(value as Record<string, unknown>)) {
      result[nestedKey] = sanitizeNested(nestedValue, nestedKey, maxLength);
    }
    return result;
  }
  return value;
}

function sanitizePayload(payload: EventPayload, maxLength: number = DEFAULT_TRUNCATE_LENGTH): EventPayload {
  const result: EventPayload = {};
  for (const [key, value] of Object.entries(payload)) {
    if (RESERVED_META_KEYS.has(key)) continue;
    if (key === 'args' && Array.isArray(value)) {
      result.args = redactArgs(value.filter((item): item is string => typeof item === 'string'));
      continue;
    }
    if (key.toLowerCase() === 'prompt' && typeof value === 'string') {
      Object.assign(result, redactPrompt(value));
      continue;
    }
    result[key] = sanitizeNested(value, key, maxLength);
  }
  return result;
}

// ─── Caller detection ────────────────────────────────────────────────────────

export interface CallerIdentity {
  kind: string;
  session?: string;
}

const TERMINAL_CALLERS: Readonly<Record<string, string>> = {
  cc: 'claude', cl: 'claude',
  cx: 'codex',
  gx: 'gemini', gm: 'gemini',
  cr: 'cursor',
  oc: 'opencode',
  sh: 'shell',
  ag: 'antigravity',
  gk: 'grok',
};

/** Identify the environment that invoked agents-cli, not the source callsite. */
export function detectCaller(
  env: NodeJS.ProcessEnv = process.env,
  stdoutIsTTY: boolean = Boolean(process.stdout.isTTY),
): CallerIdentity {
  const session = env.AGENT_SESSION_ID?.slice(0, 8) || undefined;
  if (env.CLAUDECODE === '1') return { kind: 'claude-code', ...(session ? { session } : {}) };

  const terminalId = env.AGENT_TERMINAL_ID;
  if (terminalId) {
    const prefix = terminalId.split('-')[0].toLowerCase();
    return { kind: TERMINAL_CALLERS[prefix] ?? 'agent', ...(session ? { session } : {}) };
  }

  return { kind: stdoutIsTTY ? 'terminal' : 'script' };
}

// ─── Core API ─────────────────────────────────────────────────────────────────

/**
 * Emit a structured event to the append-only audit log.
 *
 * @param event - The event type
 * @param payload - Event-specific data (agent, version, cwd, etc.)
 * @param overrides - Envelope fields the CALLER owns rather than the writer.
 *   Only `ts` today: a batched out-of-process producer (`agents events emit`)
 *   records when each event HAPPENED, but flushes them together later, so
 *   stamping write-time would collapse a whole batch onto the flush instant and
 *   corrupt every `--since` boundary. `ts` stays in RESERVED_META_KEYS so a
 *   *payload* still cannot inject it — this explicit channel is the only way in.
 */
/** Build the JSONL line + target path for an event, or null when logging is disabled. Shared by {@link emit} and {@link emitAsync}. */
function prepareEventWrite(event: EventType, payload: EventPayload, overrides: { ts?: string }): { logPath: string; line: string; isNew: boolean } | null {
  if (isDisabled()) return null;
  ensureLogsDir();
  const caller = detectCaller();
  const safePayload = sanitizePayload(payload);
  const record: EventRecord = {
    // Provenance floor first: env-sourced defaults an explicit payload overrides.
    ...stampProvenance(),
    ...safePayload,
    ts: overrides.ts ?? new Date().toISOString(),
    tz: getTimezoneOffset(),
    tzName: getTimezoneName(),
    hostname: os.hostname(),
    platform: os.platform(),
    arch: os.arch(),
    pid: process.pid,
    ppid: process.ppid,
    event,
    level: levelFor(event),
    caller: caller.kind,
    ...(caller.session ? { session: caller.session } : {}),
  };
  const line = JSON.stringify(record) + '\n';
  const logPath = eventsPath();
  const isNew = !fs.existsSync(logPath);
  ensureLockTarget(logPath, '', DIR_MODE);
  return { logPath, line, isNew };
}

/** The under-lock append + chmod + rotate/prune. Tiny local writes (µs), safe inside either the sync or async lock. */
function appendEventLocked(logPath: string, line: string, isNew: boolean): void {
  fs.appendFileSync(logPath, line, { mode: FILE_MODE });
  if (isNew || logPath !== _chmoddedPath) {
    _chmoddedPath = logPath;
    try {
      fs.chmodSync(logPath, FILE_MODE);
    } catch {
      // May fail if not owner
    }
  }
  const rotated = maybeGzipRotateLocked(logPath);
  maybePruneLocked(rotated);
}

export function emit(event: EventType, payload: EventPayload = {}, overrides: { ts?: string } = {}): void {
  try {
    const prepared = prepareEventWrite(event, payload, overrides);
    if (!prepared) return;
    withFileLock(prepared.logPath, () => appendEventLocked(prepared.logPath, prepared.line, prepared.isNew));
  } catch {
    // Silent failure - logging should never break the CLI
  }
}

/**
 * Async, non-blocking counterpart of {@link emit} for callers on the daemon's
 * shared event loop (PHNX-3695). `emit` acquires the event-log lock with
 * `withFileLock` → `sleepSync` (`Atomics.wait`), which HALTS the loop for up to
 * 30s under contention (a peer appending to the same log). `emitAsync` acquires
 * it with `withFileLockAsync`, so the loop keeps turning. The under-lock body is
 * identical (a µs-scale append + a rare rotate). Best-effort like `emit`: never
 * throws; a caller on a tick fires it and moves on.
 */
export async function emitAsync(event: EventType, payload: EventPayload = {}, overrides: { ts?: string } = {}): Promise<void> {
  try {
    const prepared = prepareEventWrite(event, payload, overrides);
    if (!prepared) return;
    await withFileLockAsync(prepared.logPath, () => appendEventLocked(prepared.logPath, prepared.line, prepared.isNew));
  } catch {
    // Silent failure - logging should never break the CLI
  }
}

/** Last log path this process chmod'd — avoids a redundant chmod per append. */
let _chmoddedPath: string | undefined;

/**
 * Convenience wrapper for timed operations.
 * Returns a function to call when the operation completes.
 *
 * @example
 * const done = emitStart('agent.run.start', { agent: 'claude' });
 * // ... do work ...
 * done({ exitCode: 0 }); // emits agent.run.end with durationMs
 */
export function emitStart(
  startEvent: EventType,
  payload: EventPayload = {}
): (endPayload?: EventPayload) => void {
  const startTime = Date.now();
  emit(startEvent, payload);

  return (endPayload: EventPayload = {}) => {
    emit(
      startEvent.replace('.start', '.end') as EventType,
      { ...payload, ...endPayload, durationMs: Date.now() - startTime }
    );
  };
}

interface RoutineEndMeta {
  jobName: string;
  runId?: string;
  status: string;
  duration?: number;
  exitCode?: number | null;
  detail?: string;
}

function routineEndPayload(meta: RoutineEndMeta): EventPayload {
  return {
    module: 'routine',
    name: meta.jobName,
    status: meta.status,
    ...(meta.runId ? { runId: meta.runId } : {}),
    ...(meta.duration != null ? { durationMs: meta.duration } : {}),
    ...(meta.exitCode != null ? { exitCode: meta.exitCode } : {}),
    ...(meta.detail ? { detail: meta.detail } : {}),
  };
}

export function emitRoutineEnd(meta: RoutineEndMeta): void {
  emit('routine.end', routineEndPayload(meta));
}

/**
 * Async, non-blocking `routine.end` for the daemon heartbeat tick (PHNX-3695):
 * the reaper (`reapExitedRunningJobs`) runs on the shared event loop, so it emits
 * through {@link emitAsync} rather than the `sleepSync`-locked {@link emit}.
 */
export async function emitRoutineEndAsync(meta: RoutineEndMeta): Promise<void> {
  await emitAsync('routine.end', routineEndPayload(meta));
}

// ─── Timing Utilities ─────────────────────────────────────────────────────────

/**
 * Measure execution time of a synchronous function.
 * Emits a perf.timing event with the duration.
 *
 * @example
 * const result = time('parse-config', () => parseConfig(path));
 */
export function time<T>(label: string, fn: () => T, payload: EventPayload = {}): T {
  const start = Date.now();
  try {
    const result = fn();
    const durationMs = Date.now() - start;
    emit('perf.timing', {
      ...payload,
      label,
      durationMs,
      status: 'success',
    });
    recordPerfTiming({
      label,
      durationMs,
      status: 'success',
      agent: payload.agent,
      version: payload.version,
      sessionId: payload.sessionId,
      cwd: payload.cwd,
    });
    return result;
  } catch (err) {
    const durationMs = Date.now() - start;
    emit('perf.timing', {
      ...payload,
      label,
      durationMs,
      status: 'error',
      error: err instanceof Error ? err.message : String(err),
    });
    recordPerfTiming({
      label,
      durationMs,
      status: 'error',
      agent: payload.agent,
      version: payload.version,
      sessionId: payload.sessionId,
      cwd: payload.cwd,
    });
    throw err;
  }
}

/**
 * Measure execution time of an async function.
 * Emits a perf.timing event with the duration.
 *
 * @example
 * const result = await timeAsync('fetch-data', () => fetchData(url));
 */
export async function timeAsync<T>(
  label: string,
  fn: () => Promise<T>,
  payload: EventPayload = {}
): Promise<T> {
  const start = Date.now();
  try {
    const result = await fn();
    const durationMs = Date.now() - start;
    emit('perf.timing', {
      ...payload,
      label,
      durationMs,
      status: 'success',
    });
    recordPerfTiming({
      label,
      durationMs,
      status: 'success',
      agent: payload.agent,
      version: payload.version,
      sessionId: payload.sessionId,
      cwd: payload.cwd,
    });
    return result;
  } catch (err) {
    const durationMs = Date.now() - start;
    emit('perf.timing', {
      ...payload,
      label,
      durationMs,
      status: 'error',
      error: err instanceof Error ? err.message : String(err),
    });
    recordPerfTiming({
      label,
      durationMs,
      status: 'error',
      agent: payload.agent,
      version: payload.version,
      sessionId: payload.sessionId,
      cwd: payload.cwd,
    });
    throw err;
  }
}

/**
 * Create a timing context for measuring multiple phases of an operation.
 * Useful for tracking startup time vs execution time.
 *
 * @example
 * const timer = createTimer('agent.run', { agent: 'claude' });
 * // ... setup work ...
 * timer.mark('startup'); // records startup time
 * // ... main work ...
 * timer.end({ exitCode: 0 }); // records total time and emits event
 */
export function createTimer(label: string, payload: EventPayload = {}): {
  mark: (phase: string) => number;
  end: (endPayload?: EventPayload) => void;
  elapsed: () => number;
} {
  const start = Date.now();
  const marks: Record<string, number> = {};

  return {
    mark(phase: string): number {
      const elapsed = Date.now() - start;
      marks[phase] = elapsed;
      return elapsed;
    },
    elapsed(): number {
      return Date.now() - start;
    },
    end(endPayload: EventPayload = {}): void {
      const durationMs = Date.now() - start;
      const merged = { ...payload, ...endPayload };
      emit('perf.timing', {
        ...merged,
        label,
        durationMs,
        phases: marks,
      });
      recordPerfTiming({
        label,
        durationMs,
        status: typeof merged.status === 'string' ? merged.status : undefined,
        agent: merged.agent,
        version: merged.version,
        sessionId: merged.sessionId,
        cwd: merged.cwd,
        phases: marks,
      });
    },
  };
}

/**
 * Higher-order function that wraps an async function with timing.
 * The wrapper emits start/end events automatically.
 *
 * @example
 * const timedFetch = withTiming('fetch', fetchData, { service: 'api' });
 * const result = await timedFetch(url);
 */
export function withTiming<Args extends unknown[], R>(
  label: string,
  fn: (...args: Args) => Promise<R>,
  basePayload: EventPayload = {}
): (...args: Args) => Promise<R> {
  return async (...args: Args): Promise<R> => {
    const start = Date.now();
    try {
      const result = await fn(...args);
      const durationMs = Date.now() - start;
      emit('perf.timing', {
        ...basePayload,
        label,
        durationMs,
        status: 'success',
      });
      recordPerfTiming({
        label,
        durationMs,
        status: 'success',
        agent: basePayload.agent,
        version: basePayload.version,
        sessionId: basePayload.sessionId,
        cwd: basePayload.cwd,
      });
      return result;
    } catch (err) {
      const durationMs = Date.now() - start;
      emit('perf.timing', {
        ...basePayload,
        label,
        durationMs,
        status: 'error',
        error: err instanceof Error ? err.message : String(err),
      });
      recordPerfTiming({
        label,
        durationMs,
        status: 'error',
        agent: basePayload.agent,
        version: basePayload.version,
        sessionId: basePayload.sessionId,
        cwd: basePayload.cwd,
      });
      throw err;
    }
  };
}

// ─── Command Tracking ─────────────────────────────────────────────────────────

/**
 * Emit a command.start event with CLI args.
 * Returns a done() function to emit command.end with duration.
 *
 * @example
 * // At CLI entry point:
 * const done = emitCommand('run', process.argv.slice(2));
 * // ... execute command ...
 * done({ exitCode: 0 });
 */
export function emitCommand(
  command: string,
  args: string[] = [],
  payload: EventPayload = {}
): (endPayload?: EventPayload) => void {
  return emitStart('command.start', {
    ...payload,
    command,
    args: args.slice(0, 20), // Limit args to first 20
    cwd: process.cwd(),
  });
}

// ─── Error Tracking ───────────────────────────────────────────────────────────

/**
 * Emit an error event with full details.
 */
export function emitError(
  err: Error | string,
  payload: EventPayload = {}
): void {
  const error = err instanceof Error ? err : new Error(err);
  emit('error', {
    ...payload,
    error: error.message,
    errorStack: truncate(error.stack, 1000),
  });
}

/**
 * Emit a friction event — a structured, point-of-use record of a failure or
 * block the CLI just hit. `surface` is the subsystem (teams, browser, secrets,
 * guard, …); `failureId` is a stable slug that lets the nightly routine group
 * the same failure across sessions (e.g. 'remote-cwd-on-add', 'not-installed').
 */
export function emitFriction(
  surface: string,
  failureId: string,
  payload: EventPayload = {}
): void {
  emit('friction', {
    ...payload,
    surface,
    failureId,
  });
}

// ─── Gzip rotation ──────────────────────────────────────────────────────────

/** Rotate the active file while its append lock is held. */
function maybeGzipRotateLocked(logPath: string): boolean {
  const stat = fs.statSync(logPath);
  if (stat.size < GZIP_ROTATION_BYTES) return false;

  const raw = fs.readFileSync(logPath);
  const tmpArchive = path.join(eventsDir(), `.events.1.jsonl.gz.${process.pid}.tmp`);
  fs.writeFileSync(tmpArchive, gzipSync(raw), { mode: FILE_MODE });

  try {
    const archives = fs.readdirSync(eventsDir())
      .map((file) => ({ file, match: file.match(/^events\.(\d+)\.jsonl\.gz$/) }))
      .filter((entry): entry is { file: string; match: RegExpMatchArray } => entry.match !== null)
      .map((entry) => ({ file: entry.file, number: Number(entry.match[1]) }))
      .sort((a, b) => b.number - a.number);

    for (const archive of archives) {
      fs.renameSync(
        path.join(eventsDir(), archive.file),
        path.join(eventsDir(), `events.${archive.number + 1}.jsonl.gz`),
      );
    }
    fs.renameSync(tmpArchive, path.join(eventsDir(), 'events.1.jsonl.gz'));
    fs.truncateSync(logPath, 0);
    return true;
  } catch (err) {
    try { fs.unlinkSync(tmpArchive); } catch { /* best-effort cleanup */ }
    throw err;
  }
}

// ─── Rotation ─────────────────────────────────────────────────────────────────

interface EventLogFile {
  path: string;
  gzip: boolean;
  currentActive: boolean;
  mtimeMs: number;
  size: number;
}

function listEventLogFiles(): EventLogFile[] {
  const current = eventsPath();
  const files: EventLogFile[] = [];
  const addFile = (filePath: string, gzip: boolean) => {
    try {
      const stat = fs.statSync(filePath);
      files.push({
        path: filePath,
        gzip,
        currentActive: filePath === current,
        mtimeMs: stat.mtimeMs,
        size: stat.size,
      });
    } catch { /* file may rotate while an unlocked reader enumerates */ }
  };
  const addDirectory = (dir: string) => {
    let names: string[] = [];
    try { names = fs.readdirSync(dir); } catch { return; }
    for (const name of names) {
      if (name !== 'events.jsonl' && !/^events\.\d+\.jsonl\.gz$/.test(name)) continue;
      addFile(path.join(dir, name), name.endsWith('.gz'));
    }
  };

  if (_eventsPathOverride) {
    if (path.basename(current) !== 'events.jsonl') {
      addFile(current, false);
      let names: string[] = [];
      try { names = fs.readdirSync(eventsDir()); } catch { return files; }
      for (const name of names) {
        if (/^events\.\d+\.jsonl\.gz$/.test(name)) addFile(path.join(eventsDir(), name), true);
      }
      return files;
    }
    addDirectory(eventsDir());
    return files;
  }

  let days: string[] = [];
  try { days = fs.readdirSync(eventsRoot()).filter((name) => /^\d{4}-\d{2}-\d{2}$/.test(name)); } catch { return files; }
  for (const day of days) addDirectory(path.join(eventsRoot(), day));
  return files;
}

function removeEmptyDayDirectories(): void {
  if (_eventsPathOverride) return;
  let days: string[] = [];
  try { days = fs.readdirSync(eventsRoot()).filter((name) => /^\d{4}-\d{2}-\d{2}$/.test(name)); } catch { return; }
  for (const day of days) {
    const dir = path.join(eventsRoot(), day);
    try { if (fs.readdirSync(dir).length === 0) fs.rmdirSync(dir); } catch { /* best effort */ }
  }
}

function finalizePastDayLogs(): void {
  if (_eventsPathOverride) return;
  const currentDay = localDateKey();
  for (const file of listEventLogFiles()) {
    if (path.basename(file.path) !== 'events.jsonl') continue;
    if (path.basename(path.dirname(file.path)) === currentDay) continue;
    try {
      withFileLock(file.path, () => {
        const dir = path.dirname(file.path);
        const numbers = fs.readdirSync(dir)
          .map((name) => name.match(/^events\.(\d+)\.jsonl\.gz$/))
          .filter((match): match is RegExpMatchArray => match !== null)
          .map((match) => Number(match[1]));
        const next = (numbers.length ? Math.max(...numbers) : 0) + 1;
        const target = path.join(dir, `events.${next}.jsonl.gz`);
        const sourceStat = fs.statSync(file.path);
        fs.writeFileSync(target, gzipSync(fs.readFileSync(file.path)), { mode: FILE_MODE });
        fs.utimesSync(target, sourceStat.atime, sourceStat.mtime);
        fs.unlinkSync(file.path);
      });
    } catch { /* retry on the next prune */ }
  }
}

export interface RotationResult {
  removedByAge: number;
  removedBySize: number;
  bytesReclaimed: number;
}

function pruneEventLogsLocked(
  retentionDays: number = DEFAULT_RETENTION_DAYS,
  maxStorageBytes: number = DEFAULT_MAX_STORAGE_BYTES,
): RotationResult {
  finalizePastDayLogs();
  const result: RotationResult = { removedByAge: 0, removedBySize: 0, bytesReclaimed: 0 };
  const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
  let files = listEventLogFiles();

  for (const file of files) {
    if (file.currentActive || file.mtimeMs >= cutoff) continue;
    try {
      fs.unlinkSync(file.path);
      result.removedByAge++;
      result.bytesReclaimed += file.size;
    } catch { /* another process may already have removed it */ }
  }

  files = listEventLogFiles();
  let totalBytes = files.reduce((sum, file) => sum + file.size, 0);
  const oldestFirst = files
    .filter((file) => !file.currentActive)
    .sort((a, b) => a.mtimeMs - b.mtimeMs || a.path.localeCompare(b.path));
  for (const file of oldestFirst) {
    if (totalBytes <= maxStorageBytes) break;
    try {
      fs.unlinkSync(file.path);
      totalBytes -= file.size;
      result.removedBySize++;
      result.bytesReclaimed += file.size;
    } catch { /* another process may already have removed it */ }
  }

  removeEmptyDayDirectories();
  return result;
}

/** Apply age retention and the total-size ceiling immediately. */
export function rotate(
  retentionDays: number = DEFAULT_RETENTION_DAYS,
  maxStorageBytes: number = DEFAULT_MAX_STORAGE_BYTES,
): RotationResult {
  try {
    ensureLogsDir();
    const active = eventsPath();
    ensureLockTarget(active, '', DIR_MODE);
    return withFileLock(active, () => pruneEventLogsLocked(retentionDays, maxStorageBytes));
  } catch {
    return { removedByAge: 0, removedBySize: 0, bytesReclaimed: 0 };
  }
}

/** Prune daily across processes, and immediately after a size rotation. */
function maybePruneLocked(force: boolean): void {
  const marker = path.join(eventsRoot(), PRUNE_MARKER);
  const oneDayMs = 24 * 60 * 60 * 1000;
  let due = force;
  try { due ||= Date.now() - fs.statSync(marker).mtimeMs > oneDayMs; } catch { due = true; }
  if (!due) return;

  const maxBytes = force
    ? DEFAULT_MAX_STORAGE_BYTES - GZIP_ROTATION_BYTES
    : DEFAULT_MAX_STORAGE_BYTES;
  pruneEventLogsLocked(DEFAULT_RETENTION_DAYS, maxBytes);
  try { fs.writeFileSync(marker, '', { mode: FILE_MODE }); } catch { /* retry next append */ }
}

// ─── Query ────────────────────────────────────────────────────────────────────

/**
 * Read events from log files within a date range.
 *
 * @param options - Query options
 * @returns Array of event records
 */
export function query(options: {
  startDate?: Date;
  endDate?: Date;
  eventTypes?: EventType[];
  level?: EventLevel;
  agent?: string;
  /** Only events stamped with this session id (payload `sessionId`, the provenance floor). */
  sessionId?: string;
  caller?: string;
  command?: string;
  module?: string;
  /** Only events carrying this bundle name in their payload (e.g. secrets events). */
  bundle?: string;
  limit?: number;
}): EventRecord[] {
  const { startDate, endDate = new Date(), eventTypes, level, agent, sessionId, caller, command, module, bundle, limit } = options;
  const results: EventRecord[] = [];

  eventsPath(); // Resolve AGENTS_EVENTS_PATH before deciding whether to migrate.
  migrateLegacyEventLogs();
  const files = listEventLogFiles().sort((a, b) =>
    Number(b.currentActive) - Number(a.currentActive) || b.mtimeMs - a.mtimeMs || b.path.localeCompare(a.path)
  );

  const startMs = startDate?.getTime();
  const endMs = endDate?.getTime();

  for (const file of files) {
    let content: string;
    if (file.gzip) {
      try {
        content = gunzipSync(fs.readFileSync(file.path)).toString('utf-8');
      } catch {
        continue;
      }
    } else {
      content = fs.readFileSync(file.path, 'utf-8');
    }
    const lines = content.trim().split('\n').filter(Boolean);

    for (const line of lines.reverse()) {
      try {
        const record = JSON.parse(line) as EventRecord;

        const recMs = Date.parse(record.ts);
        if (startMs !== undefined && !isNaN(recMs) && recMs < startMs) continue;
        if (endMs !== undefined && !isNaN(recMs) && recMs > endMs) continue;

        if (eventTypes && !eventTypes.includes(record.event)) continue;
        if (level && (record.level ?? levelFor(record.event as EventType)) !== level) continue;
        if (agent && record.agent !== agent) continue;
        if (sessionId && record.sessionId !== sessionId) continue;
        if (caller && record.caller !== caller) continue;
        if (command && record.command !== command &&
            !(typeof record.command === 'string' && record.command.startsWith(command + ' '))) continue;
        if (module && record.module !== module) continue;
        // Filter bundle in the SAME scan, before the limit cutoff — a post-filter
        // on the already-capped result silently drops matching-bundle records that
        // fell outside the newest-`limit` window (a data-loss bug for an audit query).
        if (bundle && record.bundle !== bundle) continue;

        results.push(record);

        if (limit && results.length >= limit) {
          return results;
        }
      } catch {
        // Skip malformed lines
      }
    }
  }

  return results;
}

/**
 * Scan event logs once for a set of session IDs and return browser/computer
 * usage flags for each. O(files) instead of O(N × files) — safe to call
 * outside a SQLite write transaction.
 */
export function queryToolUsageForSessions(
  sessionIds: ReadonlySet<string>,
): Map<string, { usedBrowser: boolean; usedComputer: boolean }> {
  const result = new Map<string, { usedBrowser: boolean; usedComputer: boolean }>();
  if (sessionIds.size === 0) return result;

  for (const id of sessionIds) {
    result.set(id, { usedBrowser: false, usedComputer: false });
  }

  const BROWSER_EVENTS = new Set(['browser.navigate', 'browser.screenshot']);
  const COMPUTER_EVENTS = new Set(['computer.action']);

  eventsPath();
  migrateLegacyEventLogs();
  const files = listEventLogFiles().sort((a, b) =>
    Number(b.currentActive) - Number(a.currentActive) || b.mtimeMs - a.mtimeMs || b.path.localeCompare(a.path)
  );

  let remaining = sessionIds.size * 2; // each session needs up to 2 flags set

  for (const file of files) {
    if (remaining <= 0) break;

    let content: string;
    if (file.gzip) {
      try {
        content = gunzipSync(fs.readFileSync(file.path)).toString('utf-8');
      } catch {
        continue;
      }
    } else {
      content = fs.readFileSync(file.path, 'utf-8');
    }

    for (const line of content.trim().split('\n')) {
      if (!line) continue;
      try {
        const record = JSON.parse(line) as EventRecord;
        const sid = record.sessionId;
        if (!sid || !result.has(sid)) continue;

        const entry = result.get(sid)!;
        if (BROWSER_EVENTS.has(record.event as string) && !entry.usedBrowser) {
          entry.usedBrowser = true;
          remaining--;
        } else if (COMPUTER_EVENTS.has(record.event as string) && !entry.usedComputer) {
          entry.usedComputer = true;
          remaining--;
        }
      } catch {
        // skip malformed lines
      }
    }
  }

  return result;
}

// ─── Stats ────────────────────────────────────────────────────────────────────

/**
 * Get performance stats for a specific label.
 */
export function getTimingStats(label: string, options: { days?: number } = {}): {
  count: number;
  avgMs: number;
  minMs: number;
  maxMs: number;
  p50Ms: number;
  p95Ms: number;
} | null {
  const days = options.days ?? 7;
  const startDate = new Date();
  startDate.setDate(startDate.getDate() - days);

  const events = query({
    startDate,
    eventTypes: ['perf.timing'],
  }).filter(e => e.label === label && typeof e.durationMs === 'number');

  if (events.length === 0) return null;

  const durations = events.map(e => e.durationMs as number).sort((a, b) => a - b);
  const sum = durations.reduce((a, b) => a + b, 0);

  return {
    count: durations.length,
    avgMs: Math.round(sum / durations.length),
    minMs: durations[0],
    maxMs: durations[durations.length - 1],
    p50Ms: durations[Math.floor(durations.length * 0.5)],
    p95Ms: durations[Math.floor(durations.length * 0.95)],
  };
}

// ─── Stats ───────────────────────────────────────────────────────────────────

export interface EventStats {
  totalEvents: number;
  byLevel: Record<string, number>;
  byEvent: Record<string, number>;
  byModule: Record<string, number>;
  byUser: Record<string, number>;
  /** Event counts grouped by resolved actor id (the human/agent behind them). */
  byActor: Record<string, number>;
  fileCount: number;
  totalBytes: number;
}

export function stats(options: { days?: number } = {}): EventStats {
  const days = options.days ?? 7;
  const startDate = new Date();
  startDate.setDate(startDate.getDate() - days);

  const records = query({ startDate, limit: 100_000 });

  const byLevel: Record<string, number> = {};
  const byEvent: Record<string, number> = {};
  const byModule: Record<string, number> = {};
  const byUser: Record<string, number> = {};
  const byActor: Record<string, number> = {};

  for (const r of records) {
    const lvl = r.level ?? levelFor(r.event as EventType);
    byLevel[lvl] = (byLevel[lvl] ?? 0) + 1;
    byEvent[r.event] = (byEvent[r.event] ?? 0) + 1;
    if (r.module) byModule[r.module] = (byModule[r.module] ?? 0) + 1;
    const user = `${r.osUser ?? '?'}@${r.hostname}`;
    byUser[user] = (byUser[user] ?? 0) + 1;
    if (r.actor) byActor[r.actor] = (byActor[r.actor] ?? 0) + 1;
  }

  let fileCount = 0;
  let totalBytes = 0;
  try {
    const files = listEventLogFiles();
    fileCount = files.length;
    totalBytes = files.reduce((sum, file) => sum + file.size, 0);
  } catch { /* skip */ }

  return {
    totalEvents: records.length,
    byLevel,
    byEvent,
    byModule,
    byUser,
    byActor,
    fileCount,
    totalBytes,
  };
}

// ─── Exports ──────────────────────────────────────────────────────────────────

export function getLogsPath(): string {
  return eventsPath();
}

export function _resetForTest(overrideEventsPath?: string, overrideUserAgentsDir?: string): void {
  _eventsPath = overrideEventsPath;
  _eventsPathOverride = Boolean(overrideEventsPath);
  _userAgentsDirOverride = overrideUserAgentsDir;
  _legacyMigrationChecked = false;
  resetEventProvenanceForTest();
  _chmoddedPath = undefined;
}
