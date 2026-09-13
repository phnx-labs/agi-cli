/**
 * Ingest events produced OUTSIDE this process — the writer behind
 * `agents events emit`.
 *
 * Why this exists: `emit()` (lib/events.ts) and `appendActivityEvent()`
 * (lib/activity.ts) are in-process APIs, but the producers that most need to
 * record events are not agents-cli processes at all — the Factory VS Code
 * extension host, a shell guard, any external tool. They shell out instead, and
 * this module is the one place that turns their JSONL into real records.
 *
 * It deliberately does NOT reuse `feed post`: that surface hardcodes the
 * `status.posted` kind, infers identity by walking the pid-registry ancestor
 * chain (wrong for a process that is not a descendant of an agent), throws when
 * that inference fails, and fires the configured broadcast sinks. A telemetry
 * path must do none of those things.
 *
 * Pure except for the two writers it calls, so the routing and validation rules
 * below are unit-testable against a temp events path + activity root.
 */
import {
  emit,
  isEventType,
  type EventPayload,
  type EventType,
} from './feed/events.js';
import {
  appendActivityEvent,
  tierForEvent,
  type ActivityEvent,
} from './feed/activity.js';

/** Envelope keys an incoming line may set directly; everything else is payload. */
const ENVELOPE_KEYS = [
  'event', 'ts', 'sessionId', 'mailboxId', 'terminalId', 'launchId', 'tmuxPane',
  'host', 'runtime', 'agent', 'tool', 'detail', 'url', 'project', 'cwd',
] as const;

const ENVELOPE_KEY_SET: ReadonlySet<string> = new Set<string>(ENVELOPE_KEYS);

interface IngestReject {
  /** 1-based index of the offending line within the batch. */
  line: number;
  reason: string;
}

interface IngestResult {
  written: number;
  rejected: IngestReject[];
  /** Per-store counts, so a caller/test can assert routing without reading files. */
  routed: { operational: number; activity: number };
}

interface IngestOptions {
  /**
   * Producer name, stamped as `module` on operational records so
   * `agents events --module <source>` filters to this producer. Required: an
   * unattributed external event is not auditable.
   */
  source: string;
  /** Validate and report without writing either store. */
  dryRun?: boolean;
  /** Override the activity root (tests). */
  activityRoot?: string;
}

/** ISO-8601 with at least seconds. Rejects "now", epoch ints, and garbage. */
function isIsoTimestamp(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(value)) return false;
  return !Number.isNaN(Date.parse(value));
}

/**
 * A session id must be non-empty AND survive the activity writer's filename
 * sanitizer — `activityPath` throws on an id that reduces to nothing, and that
 * throw would abort a whole batch mid-write. Check it here so the line is
 * rejected cleanly and its siblings still land.
 */
function isUsableSessionId(value: unknown): value is string {
  return typeof value === 'string' && value.replace(/[^A-Za-z0-9._-]/g, '-').replace(/-+/g, '') !== '';
}

/**
 * Route one already-validated line.
 *
 * The rule is forced by the stores, not chosen:
 *   - The activity store is keyed by session id ON DISK (one file per session),
 *     so an event with no session has nowhere to live there.
 *   - Activity records are read back with `module: 'activity'` hardcoded, so
 *     anything that must stay filterable by its producer has to be operational.
 * Therefore: milestone + usable sessionId -> activity; everything else -> ops.
 * `readUnifiedEvents` merges the two at read time, so `agents events` sees both.
 */
export function routeFor(event: string, sessionId: unknown): 'activity' | 'operational' {
  return tierForEvent(event) === 'milestone' && isUsableSessionId(sessionId) ? 'activity' : 'operational';
}

interface ParsedLine {
  line: number;
  event: EventType;
  ts?: string;
  envelope: Record<string, unknown>;
  payload: Record<string, unknown>;
}

/** Validate one raw JSONL line. Returns either a parsed line or a rejection. */
function parseLine(raw: string, lineNo: number): ParsedLine | IngestReject {
  let obj: unknown;
  try {
    obj = JSON.parse(raw);
  } catch {
    return { line: lineNo, reason: 'not valid JSON' };
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    return { line: lineNo, reason: 'not a JSON object' };
  }
  const rec = obj as Record<string, unknown>;

  const event = rec.event;
  if (typeof event !== 'string' || event === '') {
    return { line: lineNo, reason: 'missing "event"' };
  }
  if (!isEventType(event)) {
    return { line: lineNo, reason: `unknown event kind: ${event}` };
  }

  if (rec.ts !== undefined && !isIsoTimestamp(rec.ts)) {
    return { line: lineNo, reason: `invalid "ts" (want ISO-8601): ${String(rec.ts)}` };
  }

  // A milestone with no usable session id is REJECTED, not quietly demoted to
  // the operational store. Silently writing it somewhere else would look like
  // success while the event never appears in the activity lane the producer
  // asked for -- exactly the "wrong path that looks like success" this codebase
  // forbids at a boundary.
  if (tierForEvent(event) === 'milestone' && !isUsableSessionId(rec.sessionId)) {
    return {
      line: lineNo,
      reason: `"${event}" is a milestone and needs a non-empty "sessionId" (the activity log is keyed by it)`,
    };
  }

  const envelope: Record<string, unknown> = {};
  const payload: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(rec)) {
    if (key === 'event' || key === 'ts') continue;
    if (ENVELOPE_KEY_SET.has(key)) envelope[key] = value;
    else payload[key] = value;
  }

  return { line: lineNo, event, ts: rec.ts as string | undefined, envelope, payload };
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

/**
 * Ingest a JSONL batch.
 *
 * Rejection is PER LINE and lossless: a single bad line never discards the rest
 * of the batch. One typo in a 100-event flush must not silently drop 99 real
 * events, and the caller still learns exactly which line failed and why.
 */
export function ingestBatch(input: string, opts: IngestOptions): IngestResult {
  const source = opts.source.trim();
  if (!source) throw new Error('events emit: --source is required (it names the producer)');

  const result: IngestResult = { written: 0, rejected: [], routed: { operational: 0, activity: 0 } };

  const rawLines = input.split('\n');
  let lineNo = 0;
  for (const raw of rawLines) {
    lineNo += 1;
    if (raw.trim() === '') continue;

    const parsed = parseLine(raw, lineNo);
    if ('reason' in parsed) {
      result.rejected.push(parsed);
      continue;
    }

    const route = routeFor(parsed.event, parsed.envelope.sessionId);
    result.routed[route] += 1;
    if (opts.dryRun) {
      result.written += 1;
      continue;
    }

    if (route === 'activity') {
      const sessionId = parsed.envelope.sessionId as string;
      const ev: Omit<ActivityEvent, 'v' | 'tier'> = {
        ts: parsed.ts ?? new Date().toISOString(),
        event: parsed.event,
        sessionId,
        mailboxId: str(parsed.envelope.mailboxId) ?? sessionId,
        host: str(parsed.envelope.host) ?? '',
        runtime: str(parsed.envelope.runtime) ?? source,
        ...(str(parsed.envelope.cwd) ? { cwd: parsed.envelope.cwd as string } : {}),
        ...(str(parsed.envelope.project) ? { project: parsed.envelope.project as string } : {}),
        ...(str(parsed.envelope.agent) ? { agent: parsed.envelope.agent as string } : {}),
        ...(str(parsed.envelope.tool) ? { tool: parsed.envelope.tool as string } : {}),
        ...(str(parsed.envelope.detail) ? { detail: parsed.envelope.detail as string } : {}),
        ...(str(parsed.envelope.url) ? { url: parsed.envelope.url as string } : {}),
        ...(str(parsed.envelope.launchId) ? { launchId: parsed.envelope.launchId as string } : {}),
        ...(str(parsed.envelope.terminalId) ? { terminalId: parsed.envelope.terminalId as string } : {}),
        ...(str(parsed.envelope.tmuxPane) ? { tmuxPane: parsed.envelope.tmuxPane as string } : {}),
      };
      appendActivityEvent(ev, opts.activityRoot);
      result.written += 1;
      continue;
    }

    // Operational. `module: source` is what makes `--module factory` work;
    // the envelope fields that have no EventPayload home ride along as payload
    // keys, where sanitizePayload still applies its redaction rules.
    const payload: EventPayload = {
      module: source,
      ...parsed.payload,
      ...(str(parsed.envelope.sessionId) ? { sessionId: parsed.envelope.sessionId as string } : {}),
      ...(str(parsed.envelope.agent) ? { agent: parsed.envelope.agent as string } : {}),
      ...(str(parsed.envelope.cwd) ? { cwd: parsed.envelope.cwd as string } : {}),
      ...(str(parsed.envelope.project) ? { project: parsed.envelope.project as string } : {}),
      ...(str(parsed.envelope.detail) ? { detail: parsed.envelope.detail as string } : {}),
      ...(str(parsed.envelope.url) ? { url: parsed.envelope.url as string } : {}),
      ...(str(parsed.envelope.terminalId) ? { terminalId: parsed.envelope.terminalId as string } : {}),
      ...(str(parsed.envelope.launchId) ? { launchId: parsed.envelope.launchId as string } : {}),
      ...(str(parsed.envelope.host) ? { sourceHost: parsed.envelope.host as string } : {}),
      ...(str(parsed.envelope.runtime) ? { runtime: parsed.envelope.runtime as string } : {}),
      ...(str(parsed.envelope.tool) ? { tool: parsed.envelope.tool as string } : {}),
    } as EventPayload;

    emit(parsed.event, payload, parsed.ts ? { ts: parsed.ts } : {});
    result.written += 1;
  }

  return result;
}
