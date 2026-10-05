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

const ENVELOPE_KEYS = [
  'event', 'ts', 'sessionId', 'mailboxId', 'terminalId', 'launchId', 'tmuxPane',
  'host', 'runtime', 'agent', 'tool', 'detail', 'url', 'project', 'cwd',
] as const;

const ENVELOPE_KEY_SET: ReadonlySet<string> = new Set<string>(ENVELOPE_KEYS);

interface IngestReject {
  line: number;
  reason: string;
}

interface IngestResult {
  written: number;
  rejected: IngestReject[];
  routed: { operational: number; activity: number };
}

interface IngestOptions {
  source: string;
  dryRun?: boolean;
  activityRoot?: string;
}

function isIsoTimestamp(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(value)) return false;
  return !Number.isNaN(Date.parse(value));
}

function isUsableSessionId(value: unknown): value is string {
  return typeof value === 'string' && value.replace(/[^A-Za-z0-9._-]/g, '-').replace(/-+/g, '') !== '';
}

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
