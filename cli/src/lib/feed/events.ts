
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

function recordPerfTiming(payload: {
  label: string;
  durationMs: number;
  status?: string;
  agent?: string;
  version?: string;
  sessionId?: string;
  cwd?: string;
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
  }
}


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

export function getEventsDir(): string {
  return eventsDir();
}

const DEFAULT_RETENTION_DAYS = 7;

const DEFAULT_MAX_STORAGE_BYTES = 50 * 1024 * 1024;

const PRUNE_MARKER = '.last-prune';

const DEFAULT_TRUNCATE_LENGTH = 500;

const GZIP_ROTATION_BYTES = 10 * 1024 * 1024;

const DISABLE_ENV_VAR = 'AGENTS_DISABLE_EVENT_LOG';

function isDisabled(): boolean {
  const val = process.env[DISABLE_ENV_VAR];
  return val === '1' || val === 'true';
}

const DIR_MODE = 0o700;

const FILE_MODE = 0o600;


export type EventLevel = 'audit' | 'warn' | 'info' | 'debug';

export type EventType =
  | 'agent.run.start'
  | 'agent.run.end'
  | 'agent.spawn.start'
  | 'agent.spawn.end'
  | 'run.dispatched'
  | 'run.launch'
  | 'daemon.start'
  | 'daemon.stop'
  | 'daemon.error'
  | 'daemon.info'
  | 'routine.start'
  | 'routine.end'
  | 'watchdog.action'
  | 'version.install'
  | 'version.switch'
  | 'version.remove'
  | 'skill.install'
  | 'skill.remove'
  | 'browser.launch'
  | 'browser.close'
  | 'browser.navigate'
  | 'browser.screenshot'
  | 'computer.action'
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
  | 'cloud.dispatch'
  | 'cloud.complete'
  | 'cloud.cancel'
  | 'cloud.message'
  | 'teams.create'
  | 'teams.add'
  | 'teams.start'
  | 'teams.complete'
  | 'teams.disband'
  | 'hook.fire'
  | 'hook.complete'
  | 'hook.error'
  | 'mcp.add'
  | 'mcp.remove'
  | 'mcp.register'
  | 'resource.sync'
  | 'rotation.resolved'
  | 'rotation.unresolved'
  | 'command.start'
  | 'command.end'
  | 'perf.timing'
  | 'session.start'
  | 'session.end'
  | 'webhook.received'
  | 'webhook.authorized'
  | 'webhook.rejected'
  | 'webhook.matched'
  | 'webhook.fired'
  | 'webhook.failed'
  | 'webhook.handler.start'
  | 'webhook.handler.end'
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
  | 'factory.command'
  | 'factory.action'
  | 'factory.uri'
  | 'factory.launch'
  | 'friction'
  | 'error'
  | 'warn'
  | 'info'
  | 'debug';

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

export const EVENT_TYPES: readonly EventType[] = Object.keys(EVENT_TYPE_TABLE) as EventType[];

const EVENT_TYPE_SET: ReadonlySet<string> = new Set<string>(EVENT_TYPES);

export function isEventType(value: string): value is EventType {
  return EVENT_TYPE_SET.has(value);
}

const AUDIT_EVENTS: ReadonlySet<string> = new Set([
  'command.start', 'command.end',
  'run.dispatched',
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
  'daemon.start', 'daemon.stop', 'daemon.error',
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
  actor?: string;
  kind?: ActorKind | 'unknown';
}

export interface EventPayload {
  agent?: string;
  version?: string;
  sessionId?: string;
  launchId?: string;
  parentSessionId?: string;

  cwd?: string;
  module?: string;
  command?: string;
  args?: string[];

  input?: string;
  output?: string;

  prompt_length?: number;
  prompt_sha256?: string;

  durationMs?: number;
  startupMs?: number;

  exitCode?: number;
  status?: string;
  error?: string;
  errorStack?: string;

  [key: string]: unknown;
}

export type EventRecord = EventMeta & EventPayload;


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
  eventsPath();
  migrateLegacyEventLogs();
  if (!fs.existsSync(eventsDir())) {
    fs.mkdirSync(eventsDir(), { recursive: true, mode: DIR_MODE });
  } else {
    try {
      fs.chmodSync(eventsDir(), DIR_MODE);
    } catch {
    }
  }
}

function migrateLegacyEventLogs(userDir: string = userAgentsDir()): number {
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
          } catch {  }
        }
        return moved;
      });
    });
  } catch {
    _legacyMigrationChecked = false;
    return 0;
  }
}


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


export function truncate(
  str: string | null | undefined,
  maxLength: number = DEFAULT_TRUNCATE_LENGTH
): string | undefined {
  if (str == null) return undefined;
  if (str.length <= maxLength) return str;
  return str.slice(0, maxLength - 3) + '...';
}

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


export interface CallerIdentity {
  kind: string;
  session?: string;
}

const TERMINAL_CALLERS: Readonly<Record<string, string>> = {
  cc: 'claude', cl: 'claude',
  cx: 'codex',
  cr: 'cursor',
  oc: 'opencode',
  sh: 'shell',
  ag: 'antigravity',
  gk: 'grok',
};

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


function prepareEventWrite(event: EventType, payload: EventPayload, overrides: { ts?: string }): { logPath: string; line: string; isNew: boolean } | null {
  if (isDisabled()) return null;
  ensureLogsDir();
  const caller = detectCaller();
  const safePayload = sanitizePayload(payload);
  const record: EventRecord = {
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

function appendEventLocked(logPath: string, line: string, isNew: boolean): void {
  fs.appendFileSync(logPath, line, { mode: FILE_MODE });
  if (isNew || logPath !== _chmoddedPath) {
    _chmoddedPath = logPath;
    try {
      fs.chmodSync(logPath, FILE_MODE);
    } catch {
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
  }
}

export async function emitAsync(event: EventType, payload: EventPayload = {}, overrides: { ts?: string } = {}): Promise<void> {
  try {
    const prepared = prepareEventWrite(event, payload, overrides);
    if (!prepared) return;
    await withFileLockAsync(prepared.logPath, () => appendEventLocked(prepared.logPath, prepared.line, prepared.isNew));
  } catch {
  }
}

let _chmoddedPath: string | undefined;

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

export async function emitRoutineEndAsync(meta: RoutineEndMeta): Promise<void> {
  await emitAsync('routine.end', routineEndPayload(meta));
}


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


export function emitCommand(
  command: string,
  args: string[] = [],
  payload: EventPayload = {}
): (endPayload?: EventPayload) => void {
  return emitStart('command.start', {
    ...payload,
    command,
    args: args.slice(0, 20),
    cwd: process.cwd(),
  });
}

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
    try { fs.unlinkSync(tmpArchive); } catch {  }
    throw err;
  }
}


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
    } catch {  }
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
    try { if (fs.readdirSync(dir).length === 0) fs.rmdirSync(dir); } catch {  }
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
    } catch {  }
  }
}

interface RotationResult {
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
    } catch {  }
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
    } catch {  }
  }

  removeEmptyDayDirectories();
  return result;
}

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
  try { fs.writeFileSync(marker, '', { mode: FILE_MODE }); } catch {  }
}


export function query(options: {
  startDate?: Date;
  endDate?: Date;
  eventTypes?: EventType[];
  level?: EventLevel;
  agent?: string;
  sessionId?: string;
  caller?: string;
  command?: string;
  module?: string;
  bundle?: string;
  limit?: number;
}): EventRecord[] {
  const { startDate, endDate = new Date(), eventTypes, level, agent, sessionId, caller, command, module, bundle, limit } = options;
  const results: EventRecord[] = [];

  eventsPath();
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
        if (bundle && record.bundle !== bundle) continue;

        results.push(record);

        if (limit && results.length >= limit) {
          return results;
        }
      } catch {
      }
    }
  }

  return results;
}

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

  let remaining = sessionIds.size * 2;

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
      }
    }
  }

  return result;
}


interface EventStats {
  totalEvents: number;
  byLevel: Record<string, number>;
  byEvent: Record<string, number>;
  byModule: Record<string, number>;
  byUser: Record<string, number>;
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
  } catch {  }

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
