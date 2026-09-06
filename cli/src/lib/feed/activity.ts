/**
 * Activity log -- an append-only, per-session stream of agent-semantic events
 * (plan created, PR opened, worktree created, sub-agent spawned, file edited).
 *
 * This is the counterpart to the feed block store: the block store is
 * last-writer-wins STATE ("this agent is waiting on you"), while the activity
 * log is an append-only EVENT stream ("this agent did X at T"). Together they
 * let `agents feed` show both open decisions and a running activity lane
 * without ever re-parsing session transcripts -- events are emitted at hook
 * time by `11-activity-log.py` and read back by tailing the log.
 *
 * Layout: <activityDir>/<sessionId>.jsonl  (one append-only file per session)
 *   Each line is one {@link ActivityEvent}. Files are keyed by session so a
 *   plain O_APPEND write is race-free (a session has a single writer process).
 *
 * Event tiers:
 *   - `milestone` -- recognizable deliverables, always surfaced individually.
 *   - `activity`  -- routine work (file edits), collapsed to counts by readers.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'yaml';
import { stringifyDoc } from '../yaml-io.js';
import chalk from 'chalk';
import { relTime, truncate } from '../format.js';
import { getActivityDir, getUserAgentsDir } from '../state.js';
import { normalizeHost } from '../machine-id.js';
import { projectKeyFromCwd } from '../project-key.js';
import { stampProvenance } from '../event-provenance.js';
import type { ActorKind } from '../actor.js';
// Type-only import: no runtime dependency on events.ts, so no import cycle
// (events.ts / event-stream.ts import THIS module at runtime).
import type { EventRecord } from './events.js';
import {
  pythonToolRegistryLiteral,
  pythonValueFlagsLiteral,
} from '../session/bash-command.js';

/** Recognizable milestone events, ordered first in any activity lane. */
export type MilestoneEvent =
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
  /** Bash-driven deliverables detected by command parsing. */
  | 'video.rendered'
  | 'video.converted'
  | 'image.upscaled'
  | 'metadata.edited'
  /** Deliberate agent-authored progress post (`agents feed post`). */
  | 'status.posted'
  /**
   * An agent terminal spawned from AGI EXT, the VS Code extension. A milestone
   * because it is the BIRTH of a session — it carries the sessionId and the
   * terminalId that every later event on that session joins through, the same
   * way `subagent.spawned` roots a sub-agent. Written out of process by
   * `agents events emit`; the other factory.* kinds are operational-only.
   */
  | 'factory.launch'
  /**
   * The same post, but the agent is STUCK (`agents feed post --blocked`).
   *
   * A distinct event rather than a flag on `status.posted` because it is a
   * different kind of thing in the stream: a benign update is history the
   * moment it lands, while a blocked post stays open until someone answers it.
   * Readers that show "what needs a human" select on this; readers that show
   * "what happened" get both.
   */
  | 'status.blocked';

/** Routine activity events, collapsed to counts by readers. */
export type ActivityKind = 'file.edited' | 'bash.executed';

export type ActivityEventKind = MilestoneEvent | ActivityKind;

export type ActivityTier = 'milestone' | 'activity';

/** Well-known attachment kinds; the field is an open string, not an enum. */
export type AttachmentKind = 'link' | 'file' | 'image' | 'audio' | 'video';

/**
 * A generic artifact carried by a progress update — a rendered plan, an audio
 * take, a preview URL. Deliberately domain-agnostic: `kind` is an open string,
 * and `meta` is an open bag (duration, width, …) so any producer can attach
 * anything without a schema change.
 */
export interface Attachment {
  /** Coarse kind for glyph/rendering; open string, not a closed enum. */
  kind: AttachmentKind | string;
  /** https:// URL, an absolute path, or a history-relative path. */
  href: string;
  /** Display name (defaults to basename(href) at render time). */
  name?: string;
  /** MIME type when known (e.g. `audio/wav`). */
  mediaType?: string;
  /** Size in bytes for local files, when stat succeeded. */
  bytes?: number;
  /** Open bag for kind-specific facts (duration, width, height, …). */
  meta?: Record<string, string | number>;
}

/** The set of milestone events, for tier classification and ordering. */
export const MILESTONE_EVENTS: readonly MilestoneEvent[] = [
  'plan.created',
  'pr.opened',
  'pr.merged',
  'worktree.created',
  'worktree.removed',
  'commit.created',
  'pushed',
  'subagent.spawned',
  'artifact.created',
  'task.completed',
  'checklist.created',
  'video.rendered',
  'video.converted',
  'image.upscaled',
  'metadata.edited',
  'status.posted',
  // NOTE: intentionally absent from the Python hook's own MILESTONE_EVENTS copy
  // (see ACTIVITY_LOG_HOOK_SCRIPT below) — that set only classifies events the
  // hook itself writes from PreToolUse/PostToolUse, and the hook never writes
  // this one. activity.test.ts pins the difference so the divergence stays
  // deliberate rather than becoming drift.
  'factory.launch',
  'status.blocked',
];

const MILESTONE_SET = new Set<string>(MILESTONE_EVENTS);

export function tierForEvent(event: string): ActivityTier {
  return MILESTONE_SET.has(event) ? 'milestone' : 'activity';
}

export interface ActivityEvent {
  /** Schema version, for forward-compatible readers. */
  v: number;
  /** ISO-8601 timestamp of the event. */
  ts: string;
  /** Event kind (see {@link ActivityEventKind}). */
  event: ActivityEventKind | string;
  /** Coarse importance tier -- stamped by the writer, recomputed if absent. */
  tier: ActivityTier;
  /** Owning session id. */
  sessionId: string;
  /** Mailbox id for routing/joins (falls back to sessionId). */
  mailboxId: string;
  /** Short, normalized hostname the event fired on. */
  host: string;
  /** Runtime label (headless, tmux, cloud, ...). */
  runtime: string;
  /** Working directory at event time -- the join key to a project/git repo. */
  cwd?: string;
  /**
   * Project/repo name stamped by the writer (basename of cwd, worktree-aware),
   * so a progress post carries its project even without a live-session join.
   * Read-time enrichment ({@link enrichActivityEvents}) still fills it for
   * hook-written events that lack it.
   */
  project?: string;
  /** Agent that produced the event (claude, codex, ...). */
  agent?: string;
  /** Resolved actor id shared with the operational event stream. */
  actor?: string;
  /** Resolved actor kind shared with the operational event stream. */
  kind?: ActorKind | 'unknown';
  /** Tool that triggered the event (Bash, Task, ExitPlanMode, feed.post, ...). */
  tool?: string;
  /** One-line human summary (plan title, PR command, sub-agent role, status text). */
  detail?: string;
  /**
   * Short subject for deliberate status posts (`feed post --title`). Phone
   * broadcasts put this on the first line; `detail` is the body. Optional on
   * older events that only carried `detail`.
   */
  title?: string;
  /** Extracted URL when the event has one (e.g. the opened PR). */
  url?: string;
  /** Auto-stamped process identity for deliberate posts (from pid registry / env). */
  pid?: number;
  /** Spawn-time join key (`AGENT_LAUNCH_ID`) when known. */
  launchId?: string;
  /** Session that spawned this session (`AGENTS_PARENT_SESSION_ID`) when known. */
  parentSessionId?: string;
  /** Factory terminal id when the launch inherited one. */
  terminalId?: string;
  /** `$TMUX_PANE` at launch when recorded. */
  tmuxPane?: string;
  /** Bash command taxonomy (set for bash.executed events). */
  category?: string;
  bashTool?: string;
  bashAction?: string;
  /** Generic artifacts attached to a deliberate progress post. */
  attachments?: Attachment[];
}

/**
 * Coerce an unknown value into a clean {@link Attachment}[] — a fail-open reader
 * over user/agent-written JSON. Drops entries without a usable `href`, clamps
 * `kind` to a string, and keeps only primitive `meta` values.
 */
export function sanitizeAttachments(value: unknown): Attachment[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out: Attachment[] = [];
  for (const raw of value) {
    if (!raw || typeof raw !== 'object') continue;
    const a = raw as Record<string, unknown>;
    const href = typeof a.href === 'string' ? a.href.trim() : '';
    if (!href) continue;
    const att: Attachment = {
      kind: typeof a.kind === 'string' && a.kind.trim() ? a.kind.trim() : 'link',
      href,
    };
    if (typeof a.name === 'string' && a.name.trim()) att.name = a.name.trim();
    if (typeof a.mediaType === 'string' && a.mediaType.trim()) att.mediaType = a.mediaType.trim();
    if (typeof a.bytes === 'number' && Number.isFinite(a.bytes) && a.bytes >= 0) att.bytes = a.bytes;
    if (a.meta && typeof a.meta === 'object' && !Array.isArray(a.meta)) {
      const meta: Record<string, string | number> = {};
      for (const [k, v] of Object.entries(a.meta as Record<string, unknown>)) {
        if (typeof v === 'string' || typeof v === 'number') meta[k] = v;
      }
      if (Object.keys(meta).length > 0) att.meta = meta;
    }
    out.push(att);
  }
  return out.length > 0 ? out : undefined;
}

function activityPath(root: string, sessionId: string): string {
  const safe = sessionId.replace(/[^A-Za-z0-9._-]/g, '-');
  if (!safe) throw new Error(`Invalid activity session id: ${sessionId}`);
  return path.join(root, `${safe}.jsonl`);
}

/**
 * Append one event to a session's activity log. Primarily the Python hook
 * writes these at runtime; this TS writer exists for tests and any in-process
 * emitter. Uses O_APPEND so concurrent appends never interleave a line.
 */
export function appendActivityEvent(
  event: Omit<ActivityEvent, 'v' | 'tier'> & { v?: number; tier?: ActivityTier },
  root?: string,
): void {
  const dir = root ?? getActivityDir();
  fs.mkdirSync(dir, { recursive: true });
  const record: ActivityEvent = {
    ...stampProvenance(),
    v: event.v ?? 1,
    tier: event.tier ?? tierForEvent(event.event),
    ...event,
  } as ActivityEvent;
  fs.appendFileSync(activityPath(dir, event.sessionId), `${JSON.stringify(record)}\n`, { mode: 0o644 });
}

/**
 * Parse one activity log line. Tolerant by design: a blank, corrupt, or
 * half-written line is skipped rather than failing the whole read.
 */
export function parseActivityLine(line: string): ActivityEvent | undefined {
  const trimmed = line.trim();
  if (!trimmed) return undefined;
  try {
    const parsed = JSON.parse(trimmed) as Partial<ActivityEvent>;
    if (!parsed.event || !parsed.sessionId || !parsed.ts) return undefined;
    return {
      v: parsed.v ?? 1,
      ts: parsed.ts,
      event: parsed.event,
      tier: parsed.tier ?? tierForEvent(parsed.event),
      sessionId: parsed.sessionId,
      mailboxId: parsed.mailboxId ?? parsed.sessionId,
      host: parsed.host ?? 'unknown',
      runtime: parsed.runtime ?? 'headless',
      cwd: parsed.cwd,
      project: parsed.project,
      agent: parsed.agent,
      actor: parsed.actor,
      kind: parsed.kind,
      tool: parsed.tool,
      detail: parsed.detail,
      title: typeof parsed.title === 'string' ? parsed.title : undefined,
      url: parsed.url,
      pid: typeof parsed.pid === 'number' ? parsed.pid : undefined,
      launchId: parsed.launchId,
      parentSessionId: parsed.parentSessionId,
      terminalId: parsed.terminalId,
      tmuxPane: parsed.tmuxPane,
      category: typeof parsed.category === 'string' ? parsed.category : undefined,
      bashTool: typeof parsed.bashTool === 'string' ? parsed.bashTool : undefined,
      bashAction: typeof parsed.bashAction === 'string' ? parsed.bashAction : undefined,
      attachments: sanitizeAttachments(parsed.attachments),
    };
  } catch {
    return undefined; // skip corrupt / partial lines (fail-open reader)
  }
}

/** Per-session byte budget for a bounded tail read of an activity log. */
export const ACTIVITY_TAIL_BYTES = 256 * 1024;

/** Read the tail of a file as UTF-8, bounded to the last `maxBytes`. */
function readTail(file: string, maxBytes: number): string | undefined {
  let fd: number | undefined;
  try {
    fd = fs.openSync(file, 'r');
    const size = fs.fstatSync(fd).size;
    const start = size > maxBytes ? size - maxBytes : 0;
    const len = size - start;
    if (len <= 0) return '';
    const buf = Buffer.allocUnsafe(len);
    fs.readSync(fd, buf, 0, len, start);
    let text = buf.toString('utf-8');
    // Drop a leading partial line when we started mid-file.
    if (start > 0) {
      const nl = text.indexOf('\n');
      text = nl >= 0 ? text.slice(nl + 1) : '';
    }
    return text;
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

// Process-local tail cache: bounded independently of the number of historical
// sessions or directories a long-lived consumer visits. Never expose cached
// objects: callers enrich and mutate returned events (including nested values).
const ACTIVITY_CACHE_BYTES = 32 * 1024 * 1024;
interface ActivityTail {
  stamp: string;
  events?: ActivityEvent[];
  newestMs: number;
  weight: number;
}
const activityTails = new Map<string, ActivityTail>();
// A separate LRU of payload references lets pressure release parsed events
// without repeatedly walking thousands of summaries that cannot shrink.
const activityTailPayloads = new Map<string, ActivityTail>();
let activityTailBytes = 0;
let activityTailReads = 0;

/** Read-only process-local diagnostics; no event content or file paths. */
export function getActivityCacheStats(): { entries: number; parsedTails: number; bytes: number; maxBytes: number; tailReads: number } {
  return {
    entries: activityTails.size,
    parsedTails: activityTailPayloads.size,
    bytes: activityTailBytes,
    maxBytes: ACTIVITY_CACHE_BYTES,
    tailReads: activityTailReads,
  };
}

function forgetActivityTail(key: string): void {
  const old = activityTails.get(key);
  if (old) activityTailBytes -= old.weight;
  activityTails.delete(key);
  activityTailPayloads.delete(key);
}

function activitySummaryWeight(key: string, stamp: string): number {
  return (key.length + stamp.length) * 2 + 256;
}

function retainActivityTail(key: string, result: ActivityTail, sinceMs: number): void {
  const summaryWeight = activitySummaryWeight(key, result.stamp);
  // Even metadata is byte-bounded. A tail whose summary cannot fit still
  // returns normally, but must not evict the cache or be retained over budget.
  if (summaryWeight > ACTIVITY_CACHE_BYTES) return;
  const retained = { ...result };
  if (result.newestMs < sinceMs || result.weight > ACTIVITY_CACHE_BYTES / 2) {
    retained.events = undefined;
    retained.weight = summaryWeight;
  }
  // Prefer compact history over payloads, retaining all summaries that fit
  // instead of imposing a file-count cap that thrashes on each directory scan.
  for (const [oldKey, old] of activityTailPayloads) {
    if (activityTailBytes + retained.weight <= ACTIVITY_CACHE_BYTES) break;
    const weight = activitySummaryWeight(oldKey, old.stamp);
    activityTailBytes -= old.weight - weight;
    old.events = undefined;
    old.weight = weight;
    activityTailPayloads.delete(oldKey);
  }
  // If all existing entries are summaries, sacrifice the incoming payload
  // before evicting history. The current caller still receives result.events.
  if (activityTailBytes + retained.weight > ACTIVITY_CACHE_BYTES) {
    retained.events = undefined;
    retained.weight = summaryWeight;
  }
  while (activityTailBytes + retained.weight > ACTIVITY_CACHE_BYTES) {
    forgetActivityTail(activityTails.keys().next().value!);
  }
  activityTails.set(key, retained);
  if (retained.events) activityTailPayloads.set(key, retained);
  activityTailBytes += retained.weight;
}

function activityStamp(file: string): string {
  // ctime catches same-size rewrites even when a producer restores mtime;
  // device/inode catches atomic replacement. Nanoseconds avoid rounding away
  // changes made between consecutive polls on high-resolution filesystems.
  const st = fs.statSync(file, { bigint: true });
  return `${st.dev}:${st.ino}:${st.size}:${st.mtimeNs}:${st.ctimeNs}`;
}

function readActivityTail(file: string, maxBytes: number, sinceMs = -Infinity): ActivityTail {
  const key = `${path.resolve(file)}\0${maxBytes}`;
  let stamp: string;
  try { stamp = activityStamp(file); } catch {
    forgetActivityTail(key);
    return { stamp: '', events: [], newestMs: -Infinity, weight: 0 };
  }
  const cached = activityTails.get(key);
  if (cached?.stamp === stamp && (cached.events || cached.newestMs < sinceMs)) {
    activityTails.delete(key);
    activityTails.set(key, cached);
    if (cached.events) {
      activityTailPayloads.delete(key);
      activityTailPayloads.set(key, cached);
    }
    return cached;
  }
  forgetActivityTail(key);
  activityTailReads++;
  const text = readTail(file, maxBytes);
  // Transient I/O failure is not an empty file snapshot; retry next read.
  if (text === undefined) return { stamp, events: [], newestMs: -Infinity, weight: 0 };
  const events: ActivityEvent[] = [];
  let newestMs = -Infinity;
  for (const line of text.split('\n')) {
    const event = parseActivityLine(line);
    if (!event) continue;
    events.push(event);
    try {
      const ms = Date.parse(event.ts);
      if (Number.isFinite(ms)) newestMs = Math.max(newestMs, ms);
    } catch {
      // The tolerant parser historically accepts truthy non-string values.
      // Do not introduce a conversion error before the caller's event filters
      // (or into session reads, which never converted timestamps at all).
      newestMs = Infinity;
    }
  }
  // Bound retained source-derived strings, objects, and entry overhead. Large
  // one-off tails still read normally, but cannot displace the entire cache.
  const weight = text.length * 2 + events.length * 1024 + activitySummaryWeight(key, stamp);
  const result = { stamp, events, newestMs, weight };
  try {
    // A writer racing the read must not pin a mixed snapshot as unchanged.
    if (activityStamp(file) === stamp) {
      retainActivityTail(key, result, sinceMs);
    }
  } catch { /* Deleted during the read: return this snapshot without caching. */ }
  return result;
}

/** Read all events for one session (bounded tail). */
export function readSessionActivity(sessionId: string, root?: string, maxBytes = ACTIVITY_TAIL_BYTES): ActivityEvent[] {
  const dir = root ?? getActivityDir();
  return structuredClone(readActivityTail(activityPath(dir, sessionId), maxBytes).events ?? []);
}

/** List session ids that have an activity log. */
export function listActivitySessions(root?: string): string[] {
  const dir = root ?? getActivityDir();
  try {
    return fs.readdirSync(dir).filter(n => n.endsWith('.jsonl')).map(n => n.slice(0, -'.jsonl'.length));
  } catch {
    return [];
  }
}

export interface RecentActivityOptions {
  /** Only include events at or after this epoch-ms. */
  sinceMs?: number;
  /** Cap the number of returned events (most recent first). */
  limit?: number;
  /** Override the activity dir (tests). */
  root?: string;
  /** Per-session tail budget in bytes. */
  maxBytesPerSession?: number;
  /**
   * Only include these event names. Applied BEFORE `limit`, so asking for a
   * rare event (a deliberate `status.posted`) returns that many of it instead
   * of however many survive a slice dominated by routine `file.edited` churn.
   */
  events?: string[];
  /** Only include events in these tiers. Applied BEFORE `limit`, as `events` is. */
  tier?: ActivityTier;
}

/**
 * Merge recent events across every session's log, newest first. Reads only the
 * tail of each file, so cost scales with active sessions, not transcript size.
 */
export function readRecentActivity(opts: RecentActivityOptions = {}): ActivityEvent[] {
  const dir = opts.root ?? getActivityDir();
  const sinceMs = opts.sinceMs ?? 0;
  const wanted = opts.events && opts.events.length > 0 ? new Set(opts.events) : null;
  const all: ActivityEvent[] = [];
  for (const sessionId of listActivitySessions(dir)) {
    const tail = readActivityTail(activityPath(dir, sessionId), opts.maxBytesPerSession ?? ACTIVITY_TAIL_BYTES, sinceMs);
    if (tail.newestMs < sinceMs) continue;
    for (const ev of tail.events ?? []) {
      if (wanted && !wanted.has(ev.event)) continue;
      if (opts.tier && ev.tier !== opts.tier) continue;
      const t = Date.parse(ev.ts);
      if (Number.isFinite(t) && t >= sinceMs) all.push(ev);
    }
  }
  all.sort((a, b) => Date.parse(b.ts) - Date.parse(a.ts));
  return structuredClone(typeof opts.limit === 'number' ? all.slice(0, opts.limit) : all);
}

export interface CollapsedActivity {
  /** Milestone events, individually preserved, newest first. */
  milestones: ActivityEvent[];
  /** Routine events rolled up to counts, e.g. { 'file.edited': 12 }. */
  counts: Record<string, number>;
  /** Number of sub-agents spawned across the collapsed set. */
  subagentCount: number;
}

/**
 * Split a chronological event list into individual milestones plus a
 * count map for the routine (tier-2) events, so a reader shows recognizable
 * deliverables in full and collapses the noise.
 */
export function collapseActivity(events: ActivityEvent[]): CollapsedActivity {
  const milestones: ActivityEvent[] = [];
  const counts: Record<string, number> = {};
  let subagentCount = 0;
  for (const ev of events) {
    if (tierForEvent(ev.event) === 'milestone') {
      milestones.push(ev);
      if (ev.event === 'subagent.spawned') subagentCount += 1;
    } else {
      counts[ev.event] = (counts[ev.event] ?? 0) + 1;
    }
  }
  return { milestones, counts, subagentCount };
}

// ---------------------------------------------------------------------------
// Bridge into the unified event stream (lib/event-stream.ts)
// ---------------------------------------------------------------------------

/**
 * Normalize one activity event into the shared {@link EventRecord} shape so the
 * agent-semantic stream reads through the same reader as operational events.
 * `module` is stamped `activity` so `--module` filters partition the two cleanly.
 */
export function activityEventToRecord(ev: ActivityEvent): EventRecord {
  return {
    ts: ev.ts,
    tz: '',
    tzName: '',
    hostname: ev.host,
    platform: process.platform,
    arch: process.arch,
    pid: ev.pid ?? 0,
    ppid: 0,
    event: ev.event as EventRecord['event'],
    level: 'info',
    caller: ev.tool === 'feed.post' ? 'agent' : 'hook',
    session: ev.sessionId,
    osUser: 'unknown',
    transport: 'local',
    // payload
    agent: ev.agent,
    actor: ev.actor ?? 'unknown',
    kind: ev.kind ?? 'unknown',
    sessionId: ev.sessionId,
    cwd: ev.cwd,
    module: 'activity',
    tool: ev.tool,
    detail: ev.detail,
    url: ev.url,
    tier: ev.tier,
    ...(ev.project ? { project: ev.project } : {}),
    ...(ev.launchId ? { launchId: ev.launchId } : {}),
    ...(ev.parentSessionId ? { parentSessionId: ev.parentSessionId } : {}),
    ...(ev.terminalId ? { terminalId: ev.terminalId } : {}),
    ...(ev.tmuxPane ? { tmuxPane: ev.tmuxPane } : {}),
    ...(ev.attachments?.length ? { attachments: ev.attachments } : {}),
  } as EventRecord;
}

/** Read recent activity across sessions as unified {@link EventRecord}s. */
export function readActivityAsEventRecords(opts: RecentActivityOptions = {}): EventRecord[] {
  return readRecentActivity(opts).map(activityEventToRecord);
}

// ---------------------------------------------------------------------------
// Rendering (shared by the feed activity lane and `agents feed --filter updates`)
// ---------------------------------------------------------------------------

/** Glyph + color + human label per event, so the lane reads at a glance. */
export const EVENT_STYLE: Record<string, { glyph: string; color: (s: string) => string; label: string }> = {
  'plan.created': { glyph: '◆', color: chalk.cyan, label: 'plan created' },
  'pr.opened': { glyph: '⇡', color: chalk.green, label: 'PR opened' },
  'pr.merged': { glyph: '✔', color: chalk.green, label: 'PR merged' },
  'worktree.created': { glyph: '⌥', color: chalk.blue, label: 'worktree created' },
  'worktree.removed': { glyph: '⌦', color: chalk.gray, label: 'worktree removed' },
  'commit.created': { glyph: '●', color: chalk.yellow, label: 'commit' },
  'pushed': { glyph: '↥', color: chalk.yellow, label: 'pushed' },
  'subagent.spawned': { glyph: '⑂', color: chalk.magenta, label: 'sub-agent spawned' },
  'artifact.created': { glyph: '▤', color: chalk.cyan, label: 'artifact' },
  'task.completed': { glyph: '✓', color: chalk.green, label: 'task completed' },
  'checklist.created': { glyph: '☐', color: chalk.cyan, label: 'checklist created' },
  'status.posted': { glyph: '▸', color: chalk.white, label: 'status' },
  'file.edited': { glyph: '·', color: chalk.gray, label: 'file edited' },
  'factory.launch': { glyph: '⌁', color: chalk.cyan, label: 'factory launch' },
  'bash.executed': { glyph: '$', color: chalk.gray, label: 'command run' },
};

export function styleForEvent(event: string) {
  return EVENT_STYLE[event] ?? { glyph: '•', color: chalk.white, label: event };
}

/** One rendered activity line: `  <rel>  [host] <glyph label> detail url`. */
export function formatActivityLine(ev: ActivityEvent, opts: { showHost?: boolean } = {}): string {
  const s = styleForEvent(ev.event);
  const host = opts.showHost && ev.host && ev.host !== 'unknown' ? chalk.gray(`[${ev.host}] `) : '';
  const label = s.color(`${s.glyph} ${s.label}`);
  // Status posts are the message; allow a longer snippet than tool-derived detail.
  const detailLimit = ev.event === 'status.posted' ? 100 : 60;
  const detail = ev.detail ? ` ${truncate(ev.detail, detailLimit)}` : '';
  const url = ev.url ? chalk.gray(` ${ev.url}`) : '';
  const agent = ev.event === 'status.posted' && ev.agent ? chalk.gray(` · ${ev.agent}`) : '';
  const when = chalk.gray(relTime(ev.ts).padStart(7));
  return `  ${when}  ${host}${label}${detail}${agent}${url}`;
}

// ---------------------------------------------------------------------------
// Rich progress render (RUSH-2014): `status.posted` posts are the deliberate,
// operator-facing announcements — a single truncated line under-serves them.
// `formatProgressUpdate` renders each as a multi-line row with full identity
// chips (agent · session · host · project) and any attached artifacts.
// ---------------------------------------------------------------------------

/** Glyph per attachment kind, so an artifact row reads at a glance. */
export const ATTACHMENT_GLYPH: Record<string, string> = {
  image: '🖼',
  audio: '♪',
  video: '▶',
  file: '📎',
  link: '↗',
};

export function attachmentGlyph(kind: string): string {
  return ATTACHMENT_GLYPH[kind] ?? '📎';
}

/** Display name for an attachment: its `name`, else the basename of its href. */
export function attachmentName(att: Attachment): string {
  if (att.name && att.name.trim()) return att.name.trim();
  const href = att.href.replace(/[/\\]+$/, '');
  const slash = Math.max(href.lastIndexOf('/'), href.lastIndexOf('\\'));
  const base = slash >= 0 ? href.slice(slash + 1) : href;
  return base || href;
}

/**
 * Short session id for a chip: strip a known prefix (`session_`, `ses_`) then
 * take the first 8 chars — enough to disambiguate, matching `ag sessions`.
 */
export function shortSessionId(sessionId: string): string {
  const stripped = sessionId.replace(/^(session_|ses_)/, '');
  return stripped.slice(0, 8) || sessionId.slice(0, 8);
}

/** Extra identity resolved at display time by joining the session index. */
export interface ProgressJoin {
  ticketId?: string;
  prUrl?: string;
  label?: string;
}

/**
 * Render a deliberate progress update (`status.posted`) as an operator-facing,
 * multi-line row with full identity — not a 60-char one-liner. Shape:
 *
 * ```
 *   ▸ update · 3m ago
 *     grok · 0108441e · yosemite-s1 · agents
 *     "CHANGELOG pushed; watching CI"
 *     ♪ draft.wav   🖼 cover.png
 *     ↳ ag focus 0108441e · ag sessions 0108441e
 * ```
 *
 * Chips (agent, short session id, host, project, optional joined ticket/label)
 * are shown only when known. Non-progress milestones keep {@link formatActivityLine}.
 */
export function formatProgressUpdate(ev: ActivityEvent, opts: { joined?: ProgressJoin } = {}): string {
  const shortId = shortSessionId(ev.sessionId);
  const lines: string[] = [];

  lines.push(`  ${chalk.white('▸ update')} ${chalk.gray(`· ${relTime(ev.ts)}`)}`);

  const chips = [
    ev.agent,
    shortId,
    ev.host && ev.host !== 'unknown' ? ev.host : undefined,
    ev.project,
    opts.joined?.ticketId,
    opts.joined?.label,
  ].filter((c): c is string => Boolean(c));
  if (chips.length > 0) lines.push(`    ${chalk.gray(chips.join(' · '))}`);

  if (ev.title) lines.push(`    ${chalk.white.bold(ev.title)}`);
  if (ev.detail) lines.push(`    ${chalk.white(`"${ev.detail}"`)}`);

  if (ev.attachments?.length) {
    const parts = ev.attachments.map((a) => `${attachmentGlyph(a.kind)} ${chalk.cyan(attachmentName(a))}`);
    lines.push(`    ${parts.join('   ')}`);
  }
  if (opts.joined?.prUrl) lines.push(`    ${chalk.gray(opts.joined.prUrl)}`);

  lines.push(`    ${chalk.dim(`↳ ag focus ${shortId} · ag sessions ${shortId}`)}`);
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Fleet fan-out, session enrichment, grouping (the "activity bar")
//
// The activity stream is a mergeable per-host payload, so a feed-style fan-out
// (`gatherRemoteAgentsJson`) collects every peer's own stream and merges them
// host-tagged. Each item is then enriched by JOINING to live
// sessions (project / ticket / execution host) — NOT by re-parsing transcripts
// — and can be grouped by project, device, or agent so progress reads at a
// glance across the whole fleet.
// ---------------------------------------------------------------------------

/** An activity event with the session-derived facts joined on at read time. */
export interface EnrichedActivityEvent extends ActivityEvent {
  /** Resolved project/repo name (from cwd or the session join), not the raw path. */
  project?: string;
  /** Tracker ticket the owning session is tied to (e.g. `RUSH-1234`). */
  ticket?: string;
  /** Machine the event actually ran on — session `provenance.host`, else `host`. */
  executionHost?: string;
}

/**
 * Facts pulled off a live session to enrich its activity events. Keyed by
 * `sessionId`; every field optional so callers pass whatever they resolved.
 */
export interface ActivitySessionHint {
  sessionId?: string | null;
  /** Tracker ticket id (from `ActiveSession.ticket`). */
  ticket?: string | null;
  /** Machine the session executes on (`provenance.host` / `machine`). */
  executionHost?: string | null;
  /** Resolved project/repo slug from the session cwd. */
  project?: string | null;
}

/**
 * Resolve a stable project/repo name from a working directory — the same fold
 * the `agents sessions` overview groups by ({@link projectKeyFromCwd}), so a
 * project reads identically in both views.
 */
export function projectFromCwd(cwd?: string | null): string | undefined {
  return projectKeyFromCwd(cwd);
}

/**
 * Join session facts (ticket / project / execution host) onto each event by
 * `sessionId`. A hint wins; otherwise a CANONICAL def match (`canonicalProject`)
 * upgrades whatever the event carries; otherwise pre-baked enriched fields (from
 * a remote peer that already enriched its own stream) are preserved, and
 * project/host fall back to what the event itself carries (`cwd`, `host`).
 *
 * The def match ranks above the pre-baked stamp because the stamp may be stale
 * (posted before the def existed) or skewed (a peer whose defs haven't synced);
 * the match is pure prefix compare against local defs, so a different-home
 * peer's path simply doesn't match and its stamp is honored as before.
 *
 * `resolveProject` is how a caller reading its OWN machine's logs upgrades the
 * cwd fold to real repository detection ({@link resolveProjectKey}); it defaults
 * to the pure {@link projectFromCwd}, which is all a path from another machine
 * can be resolved with. Pure given pure resolvers.
 */
export function enrichActivityEvents(
  events: EnrichedActivityEvent[],
  hints: ActivitySessionHint[],
  resolveProject: (cwd?: string | null) => string | undefined = projectFromCwd,
  canonicalProject?: (cwd?: string | null) => string | undefined,
): EnrichedActivityEvent[] {
  const bySession = new Map<string, ActivitySessionHint>();
  for (const h of hints) if (h.sessionId) bySession.set(h.sessionId, h);
  return events.map((ev) => {
    const hint = ev.sessionId ? bySession.get(ev.sessionId) : undefined;
    const project = hint?.project ?? canonicalProject?.(ev.cwd) ?? ev.project ?? resolveProject(ev.cwd);
    const ticket = hint?.ticket ?? ev.ticket ?? undefined;
    const executionHost = hint?.executionHost ?? ev.executionHost
      ?? (ev.host && ev.host !== 'unknown' ? ev.host : undefined);
    return {
      ...ev,
      ...(project ? { project } : {}),
      ...(ticket ? { ticket } : {}),
      ...(executionHost ? { executionHost } : {}),
    };
  });
}

/**
 * Validate + host-tag one peer's `activity --json` payload for the fan-out
 * merge. Mirrors {@link parseLine}: skip anything missing `event`/`sessionId`/
 * `ts`, drop corrupt items. The event's own `host` is the execution host and is
 * authoritative; only fall back to the dialed peer's `machine` when it's absent.
 * Enriched fields the peer stamped (project/ticket/executionHost) ride through.
 */
export function parseActivityPayload(stdout: string, machine: string): EnrichedActivityEvent[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const out: EnrichedActivityEvent[] = [];
  for (const item of parsed) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const ev = item as Partial<EnrichedActivityEvent>;
    if (!ev.event || !ev.sessionId || !ev.ts) continue;
    const host = ev.host && ev.host !== 'unknown' ? ev.host : machine;
    out.push({ ...(ev as EnrichedActivityEvent), host });
  }
  return out;
}

/**
 * Merge local + remote event lists, keeping the first copy of a given
 * host/session/ts/event and sorting newest first. Cross-machine activity dirs
 * can sync in a peer's own events, so the identity key dedupes those (mirrors
 * `mergeFeedBlocks`).
 */
export function mergeActivityEvents(...groups: EnrichedActivityEvent[][]): EnrichedActivityEvent[] {
  const byKey = new Map<string, EnrichedActivityEvent>();
  for (const ev of groups.flat()) {
    const key = `${normalizeHost(ev.host)}\0${ev.sessionId}\0${ev.ts}\0${ev.event}`;
    if (!byKey.has(key)) byKey.set(key, ev);
  }
  return [...byKey.values()].sort((a, b) => Date.parse(b.ts) - Date.parse(a.ts));
}

/**
 * Apply `--limit` to the events a reader will actually SHOW.
 *
 * The default view collapses routine work (`file.edited`) to a count and shows
 * milestones individually, so a plain `slice(limit)` spends the whole budget on
 * churn: one busy machine editing 40 files hid every other device's PRs behind
 * a single `file edited ×40` line. Milestones therefore carry the cap, and the
 * routine events that ride along are the ones newer than the last milestone
 * kept — so the collapsed counts describe exactly the window on screen.
 *
 * With `all` (routine shown inline) every event is displayed, so the cap is the
 * plain slice again. Input must be newest-first; output preserves that order.
 */
export function capActivityEvents(
  events: EnrichedActivityEvent[],
  limit: number,
  opts: { all?: boolean } = {},
): EnrichedActivityEvent[] {
  if (!Number.isFinite(limit) || limit <= 0) return [];
  if (opts.all) return events.slice(0, limit);
  const out: EnrichedActivityEvent[] = [];
  let milestones = 0;
  let lastMilestoneIdx = -1;
  for (const ev of events) {
    if (tierForEvent(ev.event) === 'milestone') {
      if (milestones >= limit) {
        // The cap is reached: the window ends at the oldest milestone kept, so
        // trailing routine events (older than it) are outside it.
        return out.slice(0, lastMilestoneIdx + 1);
      }
      milestones += 1;
      lastMilestoneIdx = out.length;
    }
    out.push(ev);
  }
  return out;
}

export type ActivityGroupBy = 'project' | 'device' | 'agent';

/** One bucket of the grouped view. */
export interface ActivityGroup {
  /** Grouping value; empty string for the "unknown" bucket. */
  key: string;
  /** Display label. */
  label: string;
  events: EnrichedActivityEvent[];
}

/** The (key, label) an event sorts under for a given grouping dimension. */
export function activityGroupKey(ev: EnrichedActivityEvent, by: ActivityGroupBy): { key: string; label: string } {
  if (by === 'project') {
    const p = ev.project ?? projectFromCwd(ev.cwd);
    return p ? { key: p, label: p } : { key: '', label: 'unknown project' };
  }
  if (by === 'device') {
    const h = ev.executionHost ?? (ev.host && ev.host !== 'unknown' ? ev.host : undefined);
    return h ? { key: h, label: h } : { key: '', label: 'unknown device' };
  }
  const a = ev.agent;
  return a ? { key: a, label: a } : { key: '', label: 'unknown agent' };
}

/**
 * Bucket events by project, device, or agent. Groups are ordered by event count
 * (desc) then label; the "unknown" bucket always sorts last. Input order is
 * preserved within a group, so newest-first survives when the input is sorted.
 */
export function groupActivity(events: EnrichedActivityEvent[], by: ActivityGroupBy): ActivityGroup[] {
  const byKey = new Map<string, ActivityGroup>();
  for (const ev of events) {
    const { key, label } = activityGroupKey(ev, by);
    const g = byKey.get(key);
    if (g) g.events.push(ev);
    else byKey.set(key, { key, label, events: [ev] });
  }
  return [...byKey.values()].sort((a, b) => {
    if (!a.key && b.key) return 1;
    if (!b.key && a.key) return -1;
    if (b.events.length !== a.events.length) return b.events.length - a.events.length;
    return a.label.localeCompare(b.label);
  });
}

/**
 * Narrow events to those whose project, device/host, agent, event kind, or
 * ticket contains `filter` (case-insensitive substring). An empty filter is a
 * no-op. Pure.
 */
export function filterActivityEvents(events: EnrichedActivityEvent[], filter: string): EnrichedActivityEvent[] {
  const needle = filter.trim().toLowerCase();
  if (!needle) return events;
  return events.filter((ev) => {
    const fields = [ev.project, ev.executionHost, ev.host, ev.agent, ev.event, ev.ticket];
    return fields.some((f) => typeof f === 'string' && f.toLowerCase().includes(needle));
  });
}

/**
 * Narrow events to one resolved project, exact match on the enriched label
 * (unlike {@link filterActivityEvents}'s cross-field substring). This is the
 * `--project` flag: the label is canonical (a defined project's name) once the
 * reader's resolver has run, so a multi-repo project matches as one bucket. Pure.
 */
export function filterActivityByProject(events: EnrichedActivityEvent[], project: string): EnrichedActivityEvent[] {
  const name = project.trim();
  if (!name) return events;
  return events.filter((ev) => ev.project === name);
}

/** One rendered enriched line: the base activity line + `· project · ticket` tags. */
export function formatEnrichedActivityLine(
  ev: EnrichedActivityEvent,
  opts: { showHost?: boolean; showProject?: boolean; indent?: string } = {},
): string {
  const base = formatActivityLine(ev, { showHost: opts.showHost });
  const tags: string[] = [];
  if (opts.showProject && ev.project) tags.push(ev.project);
  if (ev.ticket) tags.push(ev.ticket);
  const suffix = tags.length > 0 ? chalk.gray(`  · ${tags.join(' · ')}`) : '';
  return `${opts.indent ?? ''}${base}${suffix}`;
}

/** Max device names named in a group header before the rest collapse to `+N`. */
export const GROUP_HEADER_DEVICE_LIMIT = 3;

/**
 * The distinct machines a group's events ran on, most-active first then
 * alphabetical — so a project header can say WHERE the work happened without
 * sub-grouping the timeline. Prefers the session-joined `executionHost` (where
 * the process really lives) over the raw emitting `host`. Pure.
 */
export function activityGroupDevices(events: EnrichedActivityEvent[]): string[] {
  const counts = new Map<string, number>();
  for (const ev of events) {
    const host = ev.executionHost ?? (ev.host && ev.host !== 'unknown' ? ev.host : undefined);
    if (!host) continue;
    counts.set(host, (counts.get(host) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => (b[1] !== a[1] ? b[1] - a[1] : a[0].localeCompare(b[0])))
    .map(([host]) => host);
}

/**
 * The trailing facts for one grouped bucket: `N events · M milestones`, plus
 * the machines the work ran on when `showDevices` is set (redundant when the
 * grouping dimension IS the device, so the caller decides). The device list is
 * capped at {@link GROUP_HEADER_DEVICE_LIMIT} with a `+N` tail, so a project
 * touched by a dozen boxes stays one scannable line. Separate from the label so
 * a renderer can color the two differently without re-splitting a string.
 */
export function formatActivityGroupMeta(
  group: ActivityGroup,
  opts: { showDevices?: boolean } = {},
): string {
  const { milestones } = collapseActivity(group.events);
  const n = group.events.length;
  const m = milestones.length;
  const parts = [`${n} event${n === 1 ? '' : 's'}`];
  if (m > 0) parts.push(`${m} milestone${m === 1 ? '' : 's'}`);
  if (opts.showDevices) {
    const devices = activityGroupDevices(group.events);
    if (devices.length > 0) {
      const named = devices.slice(0, GROUP_HEADER_DEVICE_LIMIT);
      const rest = devices.length - named.length;
      parts.push(rest > 0 ? `${named.join(', ')} +${rest}` : named.join(', '));
    }
  }
  return parts.join(' · ');
}

// ---------------------------------------------------------------------------
// Hook installation
// ---------------------------------------------------------------------------

/**
 * The activity-log hook (Python), sibling to 10-feed-publish.py. Classifies
 * PreToolUse/PostToolUse payloads into activity events and appends one JSONL
 * line per event to ~/.agents/.history/activity/<sessionId>.jsonl.
 *
 * Matcher-gated to mutating/milestone tools (Bash|Task|ExitPlanMode|Write|
 * Edit|MultiEdit|TodoWrite|update_plan|TaskUpdate|todo_write|TaskCreate) so
 * read-only tools never pay the hook cost. Fail-open: any error is swallowed so
 * a logging hiccup never blocks a tool call.
 */
export const ACTIVITY_LOG_HOOK_SCRIPT = String.raw`#!/usr/bin/env python3
"""Append agent-activity events for 'agents feed'.

Bound to PreToolUse (ExitPlanMode, Task) and PostToolUse (Bash, Write, Edit,
MultiEdit, TodoWrite, update_plan, TaskUpdate, todo_write, TaskCreate). One
append-only file per session; read-only tools never trigger it because the
manifest matcher excludes them.

Sub-agent gate: when the payload carries 'agent_type', this is a Task/Agent
sub-agent -- skip so only the top-level agent logs its own activity.

Fail-open: ANY error is swallowed so a logging hiccup never blocks a tool call.
"""
import os
import re
import sys
import json
import shlex
import socket
from datetime import datetime, timezone

MAX_LOG_BYTES = 5 * 1024 * 1024  # cap a pathological session's log
MILESTONE_EVENTS = {
    "plan.created", "pr.opened", "pr.merged", "worktree.created",
    "worktree.removed", "commit.created", "pushed", "subagent.spawned",
    "artifact.created", "task.completed", "checklist.created",
    "video.rendered", "video.converted", "image.upscaled", "metadata.edited",
    "status.posted",
}

# Deliverable file types + locations -- a Write here is a recognizable artifact
# (an HTML plan, a PDF report, a rendered image), not a routine code edit.
ARTIFACT_EXTS = {
    ".html", ".htm", ".pdf", ".png", ".jpg", ".jpeg", ".gif", ".svg",
    ".webp", ".mp4", ".mov", ".webm", ".csv", ".xlsx", ".pptx", ".docx",
}
ARTIFACT_DIR_HINTS = ("/tmp/", "/downloads/", "/.agents/artifacts/")

# Checklist tools across harnesses. The value is the key that holds the item list.
CHECKLIST_TOOLS = {
    "TodoWrite": "todos",
    "todo_write": "todos",
    "TaskUpdate": "tasks",
    "update_plan": "plan",
}


def is_artifact(file_path):
    low = (file_path or "").lower()
    if os.path.splitext(low)[1] in ARTIFACT_EXTS:
        return True
    return any(hint in low for hint in ARTIFACT_DIR_HINTS)


def first_line(text, limit=140):
    for raw in (text or "").splitlines():
        s = raw.strip().lstrip("#").strip()
        if s:
            return s[:limit]
    return ""


# Canonical command taxonomy for Bash tool calls, generated from the single
# source of truth in lib/session/bash-command.ts's TOOL_REGISTRY (#1889) so the
# two can no longer drift — this hook runs standalone under python3 and can't
# import that module, so the literal below is generated, not hand-duplicated.
BASH_TOOL_REGISTRY = {
${pythonToolRegistryLiteral()}
}

# Two-level tools mapped to the flags that consume the following token as their
# value, per tool; the subcommand scan skips both. Generated from VALUE_FLAGS in
# lib/session/bash-command.ts (#1889) — TWO_LEVEL_TOOLS is derived from its keys.
VALUE_FLAGS = {
${pythonValueFlagsLiteral()}
}

TWO_LEVEL_TOOLS = set(VALUE_FLAGS.keys())


def _unwrap_command(cmd):
    """Strip wrapper prefixes so the real executable is classified.

    Mirrors unwrapCommand() in lib/session/bash-command.ts — keep the shapes
    aligned when extending either side (#1889).
    """
    s = (cmd or "").strip()
    ssh = re.match(r'^ssh\s+\S+\s+["\']?(.+?)["\']?\s*(?:\|.*)?$', s)
    if ssh:
        return _unwrap_command(ssh.group(1))
    # VAR=value prefix (value may be a single- or double-quoted string with spaces)
    env = re.match(r'^([A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|' + r"'[^']*'" + r'|\S+)\s+)+(.+)$', s)
    if env:
        return _unwrap_command(env.group(2))
    # export VAR=value && command / export A=1 B=2; command
    export_prefix = re.match(
        r'^export\s+(?:[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|' + r"'[^']*'" + r'|\S+)\s+)*'
        r'[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|' + r"'[^']*'" + r'|\S+)\s*(?:&&|;|\n)\s*([\s\S]+)$',
        s,
    )
    if export_prefix:
        return _unwrap_command(export_prefix.group(1))
    # sudo / time prefix (value-taking flags such as -u user consume their argument)
    prefix = re.match(r'^(?:sudo|time)(?:\s+(?:-[uUgGhpCrtDR]\s+\S+|-\S+))*\s+(.+)$', s)
    if prefix:
        return _unwrap_command(prefix.group(1))
    # set -euo pipefail && command / set -x; command
    set_prefix = re.match(r'^set\s+[^&;\n]+?(?:&&|;|\n)\s*([\s\S]+)$', s)
    if set_prefix:
        return _unwrap_command(set_prefix.group(1))
    # cd foo && command  (also ; and newline separators)
    cd = re.match(r'^cd\s+\S+\s*(?:&&|;|\n)\s*([\s\S]+)$', s)
    if cd:
        return _unwrap_command(cd.group(1))
    npx = re.match(r'^(?:npx|bunx)\s+(?:-\S+\s+)*(.+)$', s)
    if npx:
        return _unwrap_command(npx.group(1))
    for_loop = re.match(r'^for\s+[\s\S]+?\bdo\b\s*([\s\S]+?)\s*;?\s*done\b[\s\S]*$', s)
    if for_loop:
        return _unwrap_command(for_loop.group(1))
    until_loop = re.match(r'^until\s+[\s\S]+?\bdo\b\s*([\s\S]+?)\s*;?\s*done\b[\s\S]*$', s)
    if until_loop:
        return _unwrap_command(until_loop.group(1))
    if_cond = re.match(
        r'^if\s+[\s\S]+?\bthen\b\s*([\s\S]+?)\s*;?\s*(?:elif\b|else\b|fi\b)[\s\S]*$',
        s,
    )
    if if_cond:
        return _unwrap_command(if_cond.group(1))
    subshell = re.match(r'^\(\s*([\s\S]+?)\s*\)\s*(?:&&|;|\|\|)[\s\S]*$', s) or re.match(
        r'^\(\s*([\s\S]+?)\s*\)\s*$', s
    )
    if subshell:
        return _unwrap_command(subshell.group(1))
    return s


def _split_on_operators(cmd):
    """Split a command on && || | ; while respecting quotes and escapes."""
    parts = []
    current = ""
    quote = None
    escaped = False
    i = 0
    while i < len(cmd):
        ch = cmd[i]
        if escaped:
            current += ch
            escaped = False
            i += 1
            continue
        if ch == "\\":
            current += ch
            escaped = True
            i += 1
            continue
        if quote:
            current += ch
            if ch == quote:
                quote = None
            i += 1
            continue
        if ch in ('"', "'"):
            current += ch
            quote = ch
            i += 1
            continue
        if cmd[i:i+2] in ("&&", "||"):
            if current.strip():
                parts.append(current.strip())
            current = ""
            i += 2
            continue
        if ch in ("|", ";"):
            if current.strip():
                parts.append(current.strip())
            current = ""
            i += 1
            continue
        current += ch
        i += 1
    if current.strip():
        parts.append(current.strip())
    return parts


def _tokenize_bash(command):
    """Return a list of token lists, one per simple command."""
    unwrapped = _unwrap_command(command)
    segments = _split_on_operators(unwrapped)
    out = []
    for seg in segments:
        try:
            tokens = shlex.split(seg)
        except Exception:
            tokens = seg.split()
        if tokens:
            out.append(tokens)
    return out


def _scan_subcommand(tokens, tool):
    """First non-flag token after the executable, skipping flags and the argument
    of a value-taking flag for that tool. Mirrors scanSubcommand in bash-command.ts."""
    value_flags = VALUE_FLAGS.get(tool, set())
    i = 1
    while i < len(tokens):
        t = tokens[i]
        if t.startswith("-"):
            i += 2 if t in value_flags else 1
            continue
        return t.lower()
    return ""


def classify_bash_command(command):
    """Return {tool, category, subcommand, action, summary} for the first simple command."""
    simple_commands = _tokenize_bash(command)
    if not simple_commands:
        return {"tool": "other", "category": "other", "subcommand": "", "action": "running command", "summary": ""}
    tokens = simple_commands[0]
    if not tokens:
        return {"tool": "other", "category": "other", "subcommand": "", "action": "running command", "summary": ""}

    first = tokens[0]
    base = re.sub(r'^[./]+', '', first).lower()
    if base.endswith(".exe"):
        base = base[:-4]
    info = BASH_TOOL_REGISTRY.get(base)
    if not info:
        # Known two-level tool absent from the registry (docker/kubectl/rush/
        # openclaw) still surfaces its subcommand; category stays 'other'.
        sub = _scan_subcommand(tokens, base) if base in TWO_LEVEL_TOOLS else ""
        summary = "{} {}".format(base, sub) if sub else first
        return {"tool": first, "category": "other", "subcommand": sub, "action": "running command", "summary": summary}

    subcommand = _scan_subcommand(tokens, base) if base in TWO_LEVEL_TOOLS else ""

    summary = "{} {}".format(base, subcommand) if subcommand else base
    return {
        "tool": base,
        "category": info["category"],
        "subcommand": subcommand,
        "action": info["action"],
        "summary": summary,
    }


def detect_bash_milestone(command):
    """Return (event, detail) for high-signal Bash commands, else None."""
    info = classify_bash_command(command)
    lower = (command or "").lower()

    if info["category"] == "upscaling":
        return "image.upscaled", info["action"]

    if info["tool"] == "ffmpeg":
        has_output = re.search(r'\s+\S+\.\w{2,5}\s*$', command or "")
        if has_output or "-c:v" in lower or "-codec" in lower or "libx264" in lower:
            return "video.rendered", "ffmpeg render"
        return "video.converted", "ffmpeg"

    if info["category"] == "metadata":
        return "metadata.edited", info["action"]

    if info["tool"] == "git":
        if info["subcommand"] == "commit":
            return "commit.created", "git commit"
        if info["subcommand"] == "push":
            return "pushed", "git push"
        if info["subcommand"] == "worktree":
            if "worktree add" in lower:
                return "worktree.created", "git worktree add"
            if "worktree remove" in lower:
                return "worktree.removed", "git worktree remove"

    if info["tool"] == "gh" and info["subcommand"] == "pr":
        if "pr create" in lower:
            return "pr.opened", "gh pr create"
        if "pr merge" in lower:
            return "pr.merged", "gh pr merge"

    return None


def first_line_of_command(command):
    """First non-empty line of a command, trimmed."""
    for raw in (command or "").splitlines():
        s = raw.strip()
        if s:
            return s[:140]
    return ""


def extract_url(tool_response):
    """Pull the first https URL out of a Bash tool response (stdout)."""
    text = ""
    if isinstance(tool_response, dict):
        text = str(tool_response.get("stdout") or tool_response.get("output") or "")
    elif isinstance(tool_response, str):
        text = tool_response
    m = re.search(r"https?://\S+", text)
    return m.group(0).rstrip(").,") if m else None


def _checklist_items(tool_input, kind):
    """Extract normalized checklist items from tool input."""
    if not isinstance(tool_input, dict):
        return []
    if kind == "todos":
        arr = tool_input.get("todos") or []
    elif kind == "tasks":
        arr = tool_input.get("tasks") or []
        if not arr and "taskId" in tool_input:
            arr = [tool_input]
    elif kind == "plan":
        arr = tool_input.get("plan") or []
    else:
        return []
    if not isinstance(arr, list):
        return []

    items = []
    for t in arr:
        if not isinstance(t, dict):
            continue
        subject = (
            t.get("content") or
            t.get("text") or
            t.get("step") or
            t.get("title") or
            t.get("description") or
            t.get("activeForm") or
            ""
        )
        if not isinstance(subject, str):
            subject = str(subject)
        subject = subject.strip()
        item_id = t.get("id") or t.get("taskId") or subject
        if not item_id:
            continue
        status = str(t.get("status", "") or "").lower()
        items.append({"id": item_id, "subject": subject, "status": status})
    return items


def _read_transcript_checklists(transcript_path, current_tool, current_items):
    """Tail-read the session transcript and return the previous checklist state.

    The most recent checklist entry is assumed to be the current tool call if
    it carries the same ids; skip that one and return the next older checklist
    state (or None if there isn't one).
    """
    if not transcript_path or not os.path.exists(transcript_path):
        return None
    try:
        size = os.path.getsize(transcript_path)
        start = max(0, size - 512 * 1024)
        with open(transcript_path, "r", encoding="utf-8", errors="ignore") as f:
            f.seek(start)
            if start > 0:
                f.readline()  # drop a leading partial line
            lines = f.readlines()
    except Exception:
        return None

    current_ids = {str(item.get("id")) for item in current_items if item.get("id")}
    skipped_current = False
    for line in reversed(lines):
        line = line.strip()
        if not line:
            continue
        try:
            record = json.loads(line)
        except Exception:
            continue
        if not isinstance(record, dict):
            continue

        tool_uses = []
        if isinstance(record.get("tool_use"), list):
            tool_uses = record["tool_use"]
        elif record.get("name"):
            tool_uses = [record]
        elif record.get("tool_name"):
            tool_uses = [record]

        for tu in reversed(tool_uses):
            if not isinstance(tu, dict):
                continue
            name = tu.get("name") or tu.get("tool_name") or ""
            if name not in CHECKLIST_TOOLS:
                continue
            kind = CHECKLIST_TOOLS[name]
            args = tu.get("input") or tu.get("tool_input") or tu.get("arguments") or {}
            if isinstance(args, str):
                try:
                    args = json.loads(args)
                except Exception:
                    continue
            items = _checklist_items(args, kind)
            if not items:
                continue
            ids = {str(item.get("id")) for item in items if item.get("id")}
            # Skip the most recent matching checklist entry once; that is the
            # current call already reflected in the transcript.
            if not skipped_current and name == current_tool and ids == current_ids:
                skipped_current = True
                continue
            return items
    return None


def _has_previous_task_create(transcript_path, current_tool_use_id=""):
    """Return True if the transcript contains a TaskCreate before the current one."""
    if not transcript_path or not os.path.exists(transcript_path):
        return False
    try:
        with open(transcript_path, "r", encoding="utf-8", errors="ignore") as f:
            lines = f.readlines()
    except Exception:
        return False

    for line in reversed(lines):
        line = line.strip()
        if not line:
            continue
        try:
            record = json.loads(line)
        except Exception:
            continue
        if not isinstance(record, dict):
            continue

        tool_uses = []
        msg = record.get("message", {})
        if isinstance(msg, dict) and isinstance(msg.get("content"), list):
            tool_uses = [
                c for c in msg["content"]
                if isinstance(c, dict) and c.get("type") == "tool_use"
            ]
        elif isinstance(record.get("tool_use"), list):
            tool_uses = record["tool_use"]
        elif record.get("name"):
            tool_uses = [record]

        for tu in reversed(tool_uses):
            if not isinstance(tu, dict):
                continue
            if (tu.get("name") or tu.get("tool_name")) == "TaskCreate":
                if tu.get("id") != current_tool_use_id:
                    return True
    return False


def _claude_task_state(transcript_path, exclude_task_id=None):
    """Fold Claude TaskCreate/TaskUpdate calls into a task id -> subject/status map.

    TaskCreate provides the subject (and id via toolUseResult); TaskUpdate
    provides the status. If exclude_task_id is given, the last TaskUpdate for
    that id is skipped (it is the current call already reflected in the
    transcript).
    """
    state = {}
    if not transcript_path or not os.path.exists(transcript_path):
        return state
    try:
        with open(transcript_path, "r", encoding="utf-8", errors="ignore") as f:
            lines = f.readlines()
    except Exception:
        return state

    updates = []  # (task_id, status, line_index)
    for idx, line in enumerate(lines):
        line = line.strip()
        if not line:
            continue
        try:
            record = json.loads(line)
        except Exception:
            continue
        if not isinstance(record, dict):
            continue

        tool_uses = []
        msg = record.get("message", {})
        if isinstance(msg, dict) and isinstance(msg.get("content"), list):
            tool_uses = [
                c for c in msg["content"]
                if isinstance(c, dict) and c.get("type") == "tool_use"
            ]
        elif isinstance(record.get("tool_use"), list):
            tool_uses = record["tool_use"]
        elif record.get("name"):
            tool_uses = [record]

        for tu in tool_uses:
            if not isinstance(tu, dict):
                continue
            name = tu.get("name") or ""
            args = tu.get("input") or tu.get("tool_input") or {}
            if isinstance(args, str):
                try:
                    args = json.loads(args)
                except Exception:
                    continue
            if name == "TaskCreate":
                subject = (
                    args.get("subject") or
                    args.get("description") or
                    args.get("title") or
                    ""
                )
                if subject:
                    # Link subject to the tool_use id so the result can map it.
                    tool_id = tu.get("id")
                    if tool_id:
                        state.setdefault("__pending_subject", {})[tool_id] = subject

        tool_result = record.get("toolUseResult") or {}
        if not isinstance(tool_result, dict):
            continue
        task = tool_result.get("task")
        if isinstance(task, dict):
            task_id = str(task.get("id") or task.get("taskId") or "")
            if task_id:
                state.setdefault(task_id, {})
                if task.get("subject"):
                    state[task_id]["subject"] = task["subject"]
                if task.get("status"):
                    state[task_id]["status"] = str(task.get("status")).lower()
                # Link any pending subject from the matching tool_use id.
                tool_use_id = record.get("tool_use_id") or ""
                pending = state.get("__pending_subject", {})
                if tool_use_id and tool_use_id in pending:
                    state[task_id]["subject"] = pending[tool_use_id]
        task_id = str(tool_result.get("taskId") or "")
        status_change = tool_result.get("statusChange") or {}
        status = status_change.get("to") or tool_result.get("status")
        if task_id and status:
            state.setdefault(task_id, {})
            state[task_id]["status"] = str(status).lower()
            updates.append((task_id, str(status).lower(), idx))

    if exclude_task_id and updates:
        for i in range(len(updates) - 1, -1, -1):
            if updates[i][0] == exclude_task_id:
                del updates[i]
                break
        # Rebuild statuses from remaining updates.
        for task_id in list(state.keys()):
            if task_id.startswith("__"):
                continue
            if "subject" not in state[task_id]:
                del state[task_id]
            else:
                state[task_id].pop("status", None)
        for task_id, status, _ in updates:
            if task_id in state:
                state[task_id]["status"] = status

    # Drop tasks removed from the checklist (deleted/cancelled): they are gone
    # from the user-visible list, so they must not count toward the N/M total.
    for task_id in list(state.keys()):
        if task_id.startswith("__"):
            continue
        if state[task_id].get("status") in ("deleted", "cancelled", "canceled", "removed"):
            del state[task_id]

    # Drop internal bookkeeping.
    state.pop("__pending_subject", None)
    return state


def _checklist_events(payload, hook_event):
    """Return a list of (event, detail) tuples for checklist tool calls."""
    if hook_event != "PostToolUse":
        return []
    tool_name = payload.get("tool_name", "")
    tool_input = payload.get("tool_input", {}) or {}

    if tool_name == "TaskCreate":
        subject = (
            tool_input.get("subject") or
            tool_input.get("description") or
            tool_input.get("title") or
            "task"
        )
        # Only announce the checklist on the very first task creation.
        current_tool_use_id = payload.get("tool_use_id", "")
        transcript_path = payload.get("transcript_path")
        if _has_previous_task_create(transcript_path, current_tool_use_id):
            return []
        return [("checklist.created", subject)]

    if tool_name not in CHECKLIST_TOOLS:
        return []

    kind = CHECKLIST_TOOLS[tool_name]
    items = _checklist_items(tool_input, kind)
    if not items:
        return []

    # Full-list tools (TodoWrite, update_plan) send the whole checklist every
    # time. Per-task update tools (TaskUpdate) send only the changed item, so
    # totals and subject must be resolved from the previous full-list state.
    list_key = {"todos": "todos", "tasks": "tasks", "plan": "plan"}.get(kind)
    is_full_list = list_key is not None and list_key in tool_input

    previous = _read_transcript_checklists(
        payload.get("transcript_path"), tool_name, items
    )

    if not is_full_list and previous:
        total = len(previous)
        previous_done = {
            str(i.get("id")) for i in previous
            if i.get("status") == "completed" and i.get("id")
        }
        done_count = len(previous_done)
        events = []
        for item in items:
            if item.get("status") != "completed":
                continue
            item_id = str(item.get("id"))
            if item_id in previous_done:
                continue
            subject = item.get("subject")
            if not subject:
                for p in previous:
                    if str(p.get("id")) == item_id and p.get("subject"):
                        subject = p["subject"]
                        break
            if not subject:
                subject = "task"
            done_count += 1
            events.append(("task.completed", f"{subject} {done_count}/{total} done"))
        return events

    # For TaskUpdate without a previous full-list state, fold the Claude
    # TaskCreate/TaskUpdate history to resolve subject and N/M.
    if tool_name == "TaskUpdate" and previous is None:
        task_id = str(items[0].get("id")) if items else ""
        task_state = _claude_task_state(
            payload.get("transcript_path"), exclude_task_id=task_id
        )
        if task_state:
            total = len(task_state)
            previous_done = {
                tid for tid, info in task_state.items()
                if info.get("status") == "completed"
            }
            done_count = len(previous_done)
            if task_id in task_state and items[0].get("status") == "completed" and task_id not in previous_done:
                subject = task_state[task_id].get("subject") or "task"
                return [("task.completed", f"{subject} {done_count + 1}/{total} done")]
            return []

    total = len(items)
    completed = [i for i in items if i.get("status") == "completed"]

    if previous is None:
        # First checklist call in this session.
        events = []
        events.append(("checklist.created", f"{total} task{'s' if total != 1 else ''}"))
        for item in completed:
            events.append((
                "task.completed",
                f"{item['subject']} {len(completed)}/{total} done",
            ))
        return events

    previous_done = {
        str(i.get("id")) for i in previous
        if i.get("status") == "completed" and i.get("id")
    }
    newly_completed = [
        i for i in completed
        if str(i.get("id")) not in previous_done
    ]
    if not newly_completed:
        return []

    done_count = len(completed)
    events = []
    for item in newly_completed:
        events.append((
            "task.completed",
            f"{item['subject']} {done_count}/{total} done",
        ))
    return events


def _make_record(event, detail, tool_name):
    tier = "milestone" if event in MILESTONE_EVENTS else "activity"
    record = {
        "v": 1,
        "ts": datetime.now(timezone.utc).isoformat(),
        "event": event,
        "tier": tier,
    }
    if detail:
        record["detail"] = detail
    record["tool"] = tool_name
    return record


def build_event(payload, hook_event):
    tool_name = payload.get("tool_name", "")
    tool_input = payload.get("tool_input", {}) or {}
    tool_response = payload.get("tool_response", {})

    # Checklist completions first -- cheap guard above already filtered tool name.
    checklist = _checklist_events(payload, hook_event)
    if checklist:
        return [_make_record(event, detail, tool_name) for event, detail in checklist], tool_name

    event = None
    detail = None
    url = None

    if hook_event == "PreToolUse":
        if tool_name == "ExitPlanMode":
            event = "plan.created"
            detail = first_line(tool_input.get("plan", "")) or "plan presented"
        elif tool_name == "Task":
            event = "subagent.spawned"
            role = tool_input.get("subagent_type") or "agent"
            desc = tool_input.get("description") or tool_input.get("prompt") or ""
            detail = (role + ": " + first_line(desc)).strip(": ").strip()
    elif hook_event == "PostToolUse":
        if tool_name == "Bash":
            cmd = tool_input.get("command", "")
            info = classify_bash_command(cmd)
            records = []
            # Always emit a structured bash.executed activity event.
            bash_record = _make_record("bash.executed", info.get("summary") or first_line_of_command(cmd), tool_name)
            bash_record["category"] = info.get("category")
            bash_record["bashTool"] = info.get("tool")
            bash_record["bashAction"] = info.get("action")
            records.append(bash_record)
            milestone = detect_bash_milestone(cmd)
            if milestone:
                event, detail = milestone
                milestone_record = _make_record(event, detail, tool_name)
                url = extract_url(tool_response)
                if url:
                    milestone_record["url"] = url
                records.append(milestone_record)
            return records, tool_name
        elif tool_name in ("Write", "Edit", "MultiEdit"):
            fp = tool_input.get("file_path") or tool_input.get("path") or ""
            # A freshly-written deliverable is a milestone; edits and code
            # writes stay routine and collapse to a count.
            if tool_name == "Write" and is_artifact(fp):
                event = "artifact.created"
            else:
                event = "file.edited"
            detail = os.path.basename(fp) if fp else tool_name

    if not event:
        return [], tool_name

    record = _make_record(event, detail, tool_name)
    if url:
        record["url"] = url
    return [record], tool_name


def main():
    raw = sys.stdin.read()
    try:
        payload = json.loads(raw) if raw.strip() else {}
    except Exception:
        return

    # Sub-agent gate -- only the top-level agent logs.
    if payload.get("agent_type"):
        return

    session_id = payload.get("session_id", "")
    if not session_id:
        return

    hook_event = payload.get("hook_event_name", "")
    records, tool_name = build_event(payload, hook_event)
    if not records:
        return

    safe_session = re.sub(r"[^A-Za-z0-9._-]", "-", session_id) or "unknown"
    home = os.environ.get("HOME") or os.path.expanduser("~")
    activity_dir = os.path.join(home, ".agents", ".history", "activity")
    target = os.path.join(activity_dir, safe_session + ".jsonl")

    # Identity (mirrors 10-feed-publish.py).
    mailbox_id = os.path.basename(
        os.environ.get("AGENTS_MAILBOX_DIR", "").rstrip("/")
    ) or session_id
    hostname = os.environ.get("AGENTS_SYNC_MACHINE_ID") or socket.gethostname()
    host = re.sub(r"[^a-z0-9_-]", "-", hostname.split(".")[0].strip().lower()) or "unknown"

    for record in records:
        record["sessionId"] = session_id
        record["mailboxId"] = mailbox_id
        record["host"] = host
        record["runtime"] = os.environ.get("AGENTS_RUNTIME", "headless")
        cwd = payload.get("cwd") or os.environ.get("AGENTS_CWD")
        if cwd:
            record["cwd"] = cwd
        agent = os.environ.get("AGENTS_AGENT_NAME") or "unknown"
        record["agent"] = agent
        record["actor"] = os.environ.get("AGENTS_ACTOR") or "unknown"
        actor_kind = os.environ.get("AGENTS_ACTOR_KIND")
        record["kind"] = actor_kind if actor_kind in ("human", "agent") else "unknown"
        launch_id = os.environ.get("AGENT_LAUNCH_ID")
        if launch_id:
            record["launchId"] = launch_id
        parent_session_id = os.environ.get("AGENTS_PARENT_SESSION_ID")
        if parent_session_id:
            record["parentSessionId"] = parent_session_id

    try:
        os.makedirs(activity_dir, exist_ok=True)
        # Cap growth: once over the size limit, keep only milestones.
        try:
            over_limit = os.path.getsize(target) > MAX_LOG_BYTES
        except OSError:
            over_limit = False
        with open(target, "a") as f:
            for record in records:
                if over_limit and record.get("tier") != "milestone":
                    continue
                f.write(json.dumps(record) + "\n")
    except Exception:
        pass  # fail open


if __name__ == "__main__":
    try:
        main()
    except Exception:
        pass  # fail open
`;

/** Hook manifest entries (agents.yaml shape) for the activity-log hook. */
export const ACTIVITY_HOOK_DEFINITIONS: Record<string, Record<string, unknown>> = {
  'activity-log-intent': {
    agents: ['claude'],
    events: ['PreToolUse'],
    matcher: 'ExitPlanMode|Task',
    script: '11-activity-log.py',
    timeout: 5,
  },
  'activity-log-result': {
    agents: ['claude'],
    events: ['PostToolUse'],
    matcher: 'Bash|Write|Edit|MultiEdit|TodoWrite|update_plan|TaskUpdate|todo_write|TaskCreate',
    script: '11-activity-log.py',
    timeout: 5,
  },
};

/**
 * Install the activity-log hook script into the user hooks dir and add its
 * manifest entries to the user agents.yaml. Mirrors {@link ensureFeedPublishHook}
 * in feed.ts -- idempotent, and never writes the read-only system repo.
 */
export function ensureActivityLogHook(userAgentsDir: string = getUserAgentsDir()): { installed: boolean; error?: string } {
  try {
    const hooksDir = path.join(userAgentsDir, 'hooks');
    const scriptPath = path.join(hooksDir, '11-activity-log.py');

    fs.mkdirSync(hooksDir, { recursive: true });
    let installed = false;
    if (!fs.existsSync(scriptPath) || fs.readFileSync(scriptPath, 'utf-8') !== ACTIVITY_LOG_HOOK_SCRIPT) {
      const tmpScript = `${scriptPath}.${process.pid}.tmp`;
      fs.writeFileSync(tmpScript, ACTIVITY_LOG_HOOK_SCRIPT, { mode: 0o755 });
      fs.renameSync(tmpScript, scriptPath);
      installed = true;
    }

    const agentsYamlPath = path.join(userAgentsDir, 'agents.yaml');
    const yamlDoc = fs.existsSync(agentsYamlPath)
      ? yaml.parseDocument(fs.readFileSync(agentsYamlPath, 'utf-8'))
      : new yaml.Document({});
    if (yamlDoc.errors.length > 0) {
      throw new Error(`Cannot install activity hook: ${agentsYamlPath} is invalid YAML`);
    }
    for (const [name, definition] of Object.entries(ACTIVITY_HOOK_DEFINITIONS)) {
      if (!yamlDoc.getIn(['hooks', name])) {
        yamlDoc.setIn(['hooks', name], definition);
        installed = true;
      }
    }
    if (installed) {
      const tmpYaml = `${agentsYamlPath}.${process.pid}.tmp`;
      // `flowCollectionPadding: false` matches the committed formatting — see the
      // twin `ensureFeedPublishHook` in feed.ts. Without it, re-emitting a
      // committed flow node (`[a, b]` -> `[ a, b ]`) leaves the git-backed
      // `~/.agents` tree permanently dirty and blocks `agents repo pull`
      // fleet-wide (RUSH-2505). This writer runs back-to-back with the feed one
      // on the `agents feed` path, so both must round-trip cleanly.
      fs.writeFileSync(tmpYaml, stringifyDoc(yamlDoc));
      fs.renameSync(tmpYaml, agentsYamlPath);
    }

    return { installed };
  } catch (err) {
    return { installed: false, error: (err as Error).message };
  }
}
