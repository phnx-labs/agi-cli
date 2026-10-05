/** Fleet distribution of per-session preview metadata (PHNX-3792): each box mirrors its digests
 * into `~/.agents/devices/<device>/daemon-state.json`, carried to peers by usage-sync (PHNX-4116).
 * No transcript is shipped. Every box publishes; all but marked workers fold peer digests in. */
import { selfConfiguredDeviceRole, type ConfiguredDeviceRole } from '../device-config.js';
import {
  readFleetSharedDeviceStates,
  updateFleetSharedDeviceStateAsync,
  type SessionMirrorRow,
} from '../fleet-shared-state.js';
import { getUserAgentsDir } from '../state.js';
import type { SessionFileChange, SessionFiles, SessionRequest, SessionStep, SessionTimeline, SessionVerbClass } from '@phnx-labs/sessions-cli/reader';
import { machineId, normalizeHost } from './sync/config.js';
import {
  pruneMirrorSessions,
  queryLocalOriginSessionsForMirror,
  upsertMirrorSession,
} from './db.js';

/** Cap on sessions published per device — the payload stays what a picker shows. */
const SESSION_MIRROR_MAX_ROWS = 200;
/** First-user-message snippet ceiling; the full turn stays on the owning box. */
const SESSION_MIRROR_SNIPPET_MAX = 280;
/** Mirror rows older than this since their last sync are pruned (staleness/size ceiling). */
export const SESSION_MIRROR_MAX_AGE_MS = 14 * 24 * 60 * 60_000;

/** Caps for the timeline block on a published mirror row. */
export const SESSION_MIRROR_MAX_STEPS = 8;
export const SESSION_MIRROR_STEP_TEXT_MAX = 160;
export const SESSION_MIRROR_REQUEST_MAX = 2_000;
export const SESSION_MIRROR_MAX_FILES = 8;

function cap(value: string, max: number): string {
  return value.length > max ? value.slice(0, max) : value;
}

/** Bound the tidied request: prose capped, chips capped, never re-derived. */
function boundedRequest(request: SessionRequest): SessionRequest {
  return {
    ...request,
    text: cap(request.text, SESSION_MIRROR_REQUEST_MAX),
    headline: cap(request.headline, SESSION_MIRROR_STEP_TEXT_MAX),
    ...(request.command ? { command: cap(request.command, 120) } : {}),
    attachments: request.attachments.slice(0, SESSION_MIRROR_MAX_FILES)
      .map((a) => ({ kind: a.kind, name: cap(a.name, 120) })),
  };
}

/** Bound the step list. Counters are kept exact — only text is truncated. */
function boundedTimeline(timeline: SessionTimeline): SessionTimeline {
  const steps = timeline.steps.slice(-SESSION_MIRROR_MAX_STEPS).map((step) => ({
    ...step,
    text: cap(step.text, SESSION_MIRROR_STEP_TEXT_MAX),
    ...(step.now ? { now: cap(step.now, SESSION_MIRROR_STEP_TEXT_MAX) } : {}),
    ...(step.marks ? { marks: step.marks.slice(0, 4).map((mark) => cap(mark, 40)) } : {}),
  }));
  return { ...timeline, steps, ...(timeline.reason ? { reason: cap(timeline.reason, 200) } : {}) };
}

/** Bound the file rows; `total` still reports the real count. */
function boundedFiles(files: SessionFiles): SessionFiles {
  return {
    ...files,
    changes: files.changes.slice(0, SESSION_MIRROR_MAX_FILES)
      .map((change) => ({ ...change, path: cap(change.path, 400) })),
  };
}

interface PublishSessionMirrorOptions {
  userAgentsDir?: string;
  device?: string;
  limit?: number;
}

interface PublishSessionMirrorResult {
  published: boolean;
  changed: boolean;
  count: number;
  skipped: string | null;
  error: string | null;
  path: string | null;
}

function snippet(value: string | null | undefined, max = SESSION_MIRROR_SNIPPET_MAX): string | undefined {
  if (!value) return undefined;
  const trimmed = value.replace(/\s+/g, ' ').trim();
  if (!trimmed) return undefined;
  return trimmed.length > max ? `${trimmed.slice(0, max - 1)}…` : trimmed;
}

/** Publish this device's most-recent local sessions into its owned shared-state file. */
export async function publishSessionMirrorToSharedStore(
  options: PublishSessionMirrorOptions = {},
): Promise<PublishSessionMirrorResult> {
  const result: PublishSessionMirrorResult = {
    published: false, changed: false, count: 0, skipped: null, error: null, path: null,
  };
  const device = options.device ?? machineId();
  const self = normalizeHost(device);
  const limit = options.limit ?? SESSION_MIRROR_MAX_ROWS;
  const capturedAt = Date.now();
  const sources = queryLocalOriginSessionsForMirror(self, limit);
  const rows: SessionMirrorRow[] = sources.map((s) => ({
    id: s.id,
    shortId: s.shortId,
    agent: s.agent,
    ...(s.version ? { version: s.version } : {}),
    machine: s.machine?.trim() || self,
    ...(s.cwd ? { cwd: s.cwd } : {}),
    ...(snippet(s.topic, 200) ? { topic: snippet(s.topic, 200) } : {}),
    ...(s.label ? { label: s.label } : {}),
    ...(snippet(s.generatedTitle, 200) ? { title: snippet(s.generatedTitle, 200) } : {}),
    ...(snippet(s.firstUserMessage) ? { firstUser: snippet(s.firstUserMessage) } : {}),
    ...(s.lastActivity ? { lastActivity: s.lastActivity } : {}),
    timestamp: s.timestamp,
    ...(s.ticketId ? { ticketId: s.ticketId } : {}),
    ...(s.prUrl ? { prUrl: s.prUrl } : {}),
    // Ride the daemon-computed summary (PHNX-3939) so a peer renders the goal /
    // checkpoints / checklist inline — still no transcript, keeping the mirror light.
    ...(s.summary?.goal ? { goal: snippet(s.summary.goal, 400) } : {}),
    // Bound on publish exactly as toMirrorSummary bounds on consume (50/100 items,
    // 400-char text, 40-char `at`) so this box's own model output can't ride raw
    // into the git-synced fleet state file — matching the snippet() cap on goal above.
    ...(s.summary?.checkpoints
      ? {
          checkpoints: s.summary.checkpoints
            .slice(0, 50)
            .map((c) => ({ text: String(c.text).slice(0, 400), at: String(c.at).slice(0, 40) })),
        }
      : {}),
    ...(s.summary?.summaryChecklist
      ? {
          summaryChecklist: s.summary.summaryChecklist
            .slice(0, 100)
            .map((c) => ({ text: String(c.text).slice(0, 400), done: Boolean(c.done) })),
        }
      : {}),
    ...(s.summary?.summaryState ? { summaryState: s.summary.summaryState } : {}),
    // Same bound-on-publish discipline as the summary above: the fleet state file
    // is git-synced, so the request text, the step list, and the file rows are
    // capped here rather than shipped raw (PHNX-3939).
    ...(s.timeline?.request ? { request: boundedRequest(s.timeline.request) } : {}),
    ...(s.timeline?.timeline ? { timeline: boundedTimeline(s.timeline.timeline) } : {}),
    ...(s.timeline?.files ? { files: boundedFiles(s.timeline.files) } : {}),
    capturedAt,
  }));
  try {
    const write = await updateFleetSharedDeviceStateAsync(
      device,
      { sessions: { rows } },
      options.userAgentsDir ?? getUserAgentsDir(),
    );
    result.published = true;
    result.changed = write.changed;
    result.count = rows.length;
    result.path = write.path;
  } catch (err) {
    result.error = (err as Error).message;
  }
  return result;
}

interface ConsumeSessionMirrorOptions {
  userAgentsDir?: string;
  device?: string;
  role?: ConfiguredDeviceRole;
  now?: number;
  maxAgeMs?: number;
}

interface ConsumeSessionMirrorResult {
  sources: string[];
  merged: number;
  pruned: number;
  skipped: string | null;
  errors: Array<{ device: string; message: string }>;
}

function isString(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0;
}

/** Validate one untrusted peer row into an upsert, or null if a load-bearing field is missing.
 * Terminal-escape scrubbing is left to the render path (`sanitizeMeta`); this enforces only shape
 * and bounds. */
function toUpsert(raw: unknown): {
  id: string; shortId: string; agent: string; version?: string; machine: string;
  cwd?: string; topic?: string; firstUser?: string; label?: string; generatedTitle?: string;
  lastActivity?: string; timestamp: string; ticketId?: string; prUrl?: string;
  summary?: import('./db.js').SessionSummaryEntry;
  timeline?: import('./db.js').SessionTimelineProjection;
} | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (!isString(r.id) || !isString(r.agent) || !isString(r.machine)) return null;
  const timestamp = isString(r.timestamp) ? r.timestamp : (isString(r.lastActivity) ? r.lastActivity : null);
  if (!timestamp) return null;
  const shortId = isString(r.shortId) ? r.shortId : r.id.slice(0, 8);
  const cap = (v: unknown, max: number): string | undefined =>
    isString(v) ? (v.length > max ? v.slice(0, max) : v) : undefined;
  return {
    id: r.id,
    shortId,
    agent: r.agent,
    version: cap(r.version, 64),
    machine: r.machine,
    cwd: cap(r.cwd, 1024),
    topic: cap(r.topic, 400),
    firstUser: cap(r.firstUser, SESSION_MIRROR_SNIPPET_MAX),
    label: cap(r.label, 400),
    generatedTitle: cap(r.title, 200),
    lastActivity: isString(r.lastActivity) ? r.lastActivity : undefined,
    timestamp,
    ticketId: cap(r.ticketId, 64),
    prUrl: cap(r.prUrl, 512),
    summary: toMirrorSummary(r),
    timeline: toMirrorTimeline(r),
  };
}

/** Validate an untrusted peer's request/timeline/files into the bounded local projection
 * (PHNX-3939). A malformed timeline drops the row whole rather than being partially trusted. */
function toMirrorTimeline(r: Record<string, unknown>): import('./db.js').SessionTimelineProjection | undefined {
  const timeline = toMirrorTimelineBlock(r.timeline);
  if (!timeline) return undefined;
  return {
    timeline,
    ...(toMirrorRequest(r.request) ? { request: toMirrorRequest(r.request)! } : {}),
    ...(toMirrorFiles(r.files) ? { files: toMirrorFiles(r.files)! } : {}),
  };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return Boolean(v) && typeof v === 'object' && !Array.isArray(v);
}

function count(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0;
}

/** The verb keys a peer's `mix` may carry — anything else is dropped, not trusted. */
const MIRROR_VERB_CLASSES: readonly SessionVerbClass[] = [
  'read', 'edit', 'run', 'git', 'test', 'browser', 'agent', 'other',
];

/** A peer's per-verb breakdown, whitelisted by key and clamped by value. */
function toMirrorMix(raw: unknown): SessionStep['mix'] | undefined {
  if (!isRecord(raw)) return undefined;
  const mix: Partial<Record<SessionVerbClass, number>> = {};
  for (const verb of MIRROR_VERB_CLASSES) {
    const n = count(raw[verb]);
    if (n > 0) mix[verb] = n;
  }
  return Object.keys(mix).length ? mix : undefined;
}

function toMirrorTimelineBlock(raw: unknown): SessionTimeline | undefined {
  if (!isRecord(raw)) return undefined;
  const state = raw.state;
  if (state !== 'ready' && state !== 'partial' && state !== 'unavailable') return undefined;
  const steps = (Array.isArray(raw.steps) ? raw.steps : [])
    .filter(isRecord)
    .filter((step) => isString(step.text) && isString(step.at))
    .slice(0, SESSION_MIRROR_MAX_STEPS)
    .map((step) => ({
      text: String(step.text).slice(0, SESSION_MIRROR_STEP_TEXT_MAX),
      at: String(step.at).slice(0, 40),
      ...(isString(step.endedAt) ? { endedAt: step.endedAt.slice(0, 40) } : {}),
      source: (step.source === 'thinking' || step.source === 'derived' || step.source === 'user'
        ? step.source : 'narration') as SessionStep['source'],
      tools: count(step.tools),
      failed: count(step.failed),
      blocked: count(step.blocked),
      ...(isString(step.now) ? { now: step.now.slice(0, SESSION_MIRROR_STEP_TEXT_MAX) } : {}),
      // `mix` and `live` render a step in the sidebar; dropping them made remote rows disagree
      // with local ones, so they are whitelisted like other fields.
      ...(step.live === true ? { live: true as const } : {}),
      ...((): { mix?: SessionStep['mix'] } => {
        const mix = toMirrorMix(step.mix);
        return mix ? { mix } : {};
      })(),
      ...(Array.isArray(step.marks)
        ? { marks: step.marks.filter(isString).slice(0, 4).map((mark) => mark.slice(0, 40)) }
        : {}),
    }));
  const earlier = isRecord(raw.earlier) ? raw.earlier : {};
  return {
    steps,
    earlier: { steps: count(earlier.steps), tools: count(earlier.tools), failed: count(earlier.failed) },
    tools: count(raw.tools),
    failed: count(raw.failed),
    blocked: count(raw.blocked),
    spanMs: count(raw.spanMs),
    state,
    ...(isString(raw.reason) ? { reason: raw.reason.slice(0, 200) } : {}),
  };
}

function toMirrorRequest(raw: unknown): SessionRequest | undefined {
  if (!isRecord(raw) || !isString(raw.headline)) return undefined;
  const kind = raw.kind;
  return {
    text: isString(raw.text) ? raw.text.slice(0, SESSION_MIRROR_REQUEST_MAX) : '',
    headline: raw.headline.slice(0, SESSION_MIRROR_STEP_TEXT_MAX),
    kind: kind === 'image' || kind === 'command' || kind === 'skill' ? kind : 'text',
    ...(isString(raw.command) ? { command: raw.command.slice(0, 120) } : {}),
    attachments: (Array.isArray(raw.attachments) ? raw.attachments : [])
      .filter(isRecord)
      .filter((a) => isString(a.name))
      .slice(0, SESSION_MIRROR_MAX_FILES)
      .map((a) => ({
        kind: a.kind === 'image' || a.kind === 'dir' ? a.kind : 'file' as const,
        name: String(a.name).slice(0, 120),
      })),
    pastedLines: count(raw.pastedLines),
    ...(typeof raw.turns === 'number' ? { turns: count(raw.turns) } : {}),
  };
}

function toMirrorFiles(raw: unknown): SessionFiles | undefined {
  if (!isRecord(raw)) return undefined;
  const changes = (Array.isArray(raw.changes) ? raw.changes : [])
    .filter(isRecord)
    .filter((change) => isString(change.path))
    .slice(0, SESSION_MIRROR_MAX_FILES)
    .map((change) => ({
      path: String(change.path).slice(0, 400),
      op: (change.op === 'created' || change.op === 'deleted' ? change.op : 'modified') as SessionFileChange['op'],
      edits: count(change.edits),
      at: isString(change.at) ? change.at.slice(0, 40) : '',
    }));
  if (!changes.length) return undefined;
  return { changes, total: count(raw.total) || changes.length, source: raw.source === 'harness' ? 'harness' : 'tools' };
}

/** One published summary state, validated back into the union or undefined. */
function toSummaryState(v: unknown): 'pending' | 'ready' | 'skipped' | undefined {
  return v === 'pending' || v === 'ready' || v === 'skipped' ? v : undefined;
}

/** Validate an untrusted peer's summary fields into a bounded SessionSummaryEntry (PHNX-3939),
 * or undefined if none; only rows with a resolvable `summaryState` are kept. */
function toMirrorSummary(r: Record<string, unknown>): import('./db.js').SessionSummaryEntry | undefined {
  const summaryState = toSummaryState(r.summaryState);
  if (!summaryState) return undefined;
  const goal = isString(r.goal) ? r.goal.slice(0, 400) : undefined;
  const checkpoints = Array.isArray(r.checkpoints)
    ? r.checkpoints
        .filter((c): c is Record<string, unknown> => Boolean(c) && typeof c === 'object' && !Array.isArray(c))
        .filter((c) => isString((c as any).text) && isString((c as any).at))
        .slice(0, 50)
        .map((c) => ({ text: String((c as any).text).slice(0, 400), at: String((c as any).at).slice(0, 40) }))
    : undefined;
  const summaryChecklist = Array.isArray(r.summaryChecklist)
    ? r.summaryChecklist
        .filter((c): c is Record<string, unknown> => Boolean(c) && typeof c === 'object' && !Array.isArray(c))
        .filter((c) => isString((c as any).text))
        .slice(0, 100)
        .map((c) => ({ text: String((c as any).text).slice(0, 400), done: Boolean((c as any).done) }))
    : undefined;
  return {
    summaryState,
    ...(goal ? { goal } : {}),
    ...(checkpoints && checkpoints.length ? { checkpoints } : {}),
    ...(summaryChecklist && summaryChecklist.length ? { summaryChecklist } : {}),
  };
}

/** Fold peers' session digests into the local `sessions` index as mirror rows and prune stale ones,
 * reading only the local checkout (no network). Workers skip: they never render the picker. */
export function consumeSessionMirrorFromSharedStore(
  options: ConsumeSessionMirrorOptions = {},
): ConsumeSessionMirrorResult {
  const result: ConsumeSessionMirrorResult = { sources: [], merged: 0, pruned: 0, skipped: null, errors: [] };
  const role = options.role ?? selfConfiguredDeviceRole();
  const now = options.now ?? Date.now();
  if (role === 'worker') {
    // A worker never consumes digests, but a formerly non-worker box may hold mirror rows it will
    // never refresh. Prune them all (cutoff = now) so a demoted box's index does not stay bloated
    // (PHNX-3792).
    result.pruned = pruneMirrorSessions(now);
    result.skipped = 'this device is a worker; the session mirror feeds the interactive picker';
    return result;
  }
  const read = readFleetSharedDeviceStates(options.userAgentsDir ?? getUserAgentsDir());
  result.errors.push(...read.errors);
  const self = normalizeHost(options.device ?? machineId());
  for (const state of read.states) {
    if (normalizeHost(state.device) === self || !state.sessions?.rows) continue;
    let mergedForDevice = 0;
    for (const raw of state.sessions.rows) {
      const row = toUpsert(raw);
      if (!row) continue;
      if (upsertMirrorSession(row, state.device, now)) mergedForDevice++;
    }
    if (mergedForDevice > 0) {
      result.sources.push(state.device);
      result.merged += mergedForDevice;
    }
  }
  result.sources.sort();
  result.pruned = pruneMirrorSessions(now - (options.maxAgeMs ?? SESSION_MIRROR_MAX_AGE_MS));
  return result;
}
