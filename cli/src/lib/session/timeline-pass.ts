
import * as fs from 'fs';
import type { ActiveSession } from './active.js';
import { readSessionTimelineEntry, writeSessionTimeline, type SessionTimelineCacheRow, type SessionTimelineEntry } from './db.js';
import { parseClaudeContent, parseCodexItemsContent, parseSession } from '@phnx-labs/sessions-cli/reader';
import { toolEvidenceSourcePath } from './tool-store.js';
import type { SessionAgentId, SessionEvent } from '@phnx-labs/sessions-cli/reader';
import {
  compactTimelineState,
  emptyTimelineState,
  foldTimeline,
  projectGlance,
  projectSessionFiles,
  projectTimeline,
  unavailableTimeline,
  TIMELINE_EXTRACTOR_VERSION,
  type TimelineState,
} from '@phnx-labs/sessions-cli/reader';
import { appendInlineImage, dropOpenInlineImage, finishInlineImage, hasOpenInlineImage, materializeInlineImages, readSessionSubagents, takePendingImagePaths } from './glance-files.js';

const TIMELINE_PASS_MAX_PER_TICK = 8;

export const TIMELINE_PASS_MAX_BYTES_PER_SESSION = 4 * 1024 * 1024;

// Bound bytes actually read by the whole tick so cold/full-file folds cannot stall the daemon.
const TIMELINE_PASS_MAX_BYTES_PER_TICK = 8 * 1024 * 1024;

export const TIMELINE_PASS_MAX_WHOLE_FILE_BYTES = 16 * 1024 * 1024;

const TIMELINE_PASS_MAX_EVENTS = 20_000;

export const TIMELINE_PASS_NON_RESUMABLE_MIN_INTERVAL_MS = 60_000;

function isResumableTimelineSource(agent: string): agent is 'claude' | 'codex' {
  return agent === 'claude' || agent === 'codex';
}

const NO_TRANSCRIPT_REASON: Partial<Record<SessionAgentId, string>> = {
  openclaw: 'OpenClaw writes no parseable transcript, so there are no steps to fold',
};

interface TimelinePassResult {
  computed: number;
  reused: number;
  skipped: number;
}

interface TimelinePassOptions {
  sessions?: ActiveSession[];
  budget?: number;
  maxBytes?: number;
  requireReader?: boolean;
  nowMs?: number;
  signal?: AbortSignal;
  statFile?: (path: string) => { mtimeMs: number; size: number };
}

const MAX_PARTIAL_TEXT = 256 * 1024;

function utf8Cut(buffer: Buffer, length: number): number {
  let i = length - 1;
  while (i >= 0 && i >= length - 4 && (buffer[i] & 0xc0) === 0x80) i--;
  if (i < 0 || i < length - 4) return length;
  const byte = buffer[i];
  const need = byte < 0x80 ? 1 : byte < 0xe0 ? 2 : byte < 0xf0 ? 3 : 4;
  return length - i < need ? i : length;
}

// Advance offsets only through newline-terminated records; short EOF tails remain unread.
function readCompleteLines(
  filePath: string,
  start: number,
  end: number,
  maxBytes: number,
  allowPartial: boolean,
): { text: string; offset: number; partial: boolean } {
  const stop = Math.min(end, start + maxBytes);
  if (stop <= start) return { text: '', offset: start, partial: false };
  const fd = fs.openSync(filePath, 'r');
  try {
    const buffer = Buffer.alloc(stop - start);
    const read = fs.readSync(fd, buffer, 0, buffer.length, start);
    const lastNewline = buffer.lastIndexOf(0x0a, read - 1);
    if (lastNewline >= 0) {
      return {
        text: buffer.toString('utf8', 0, lastNewline + 1),
        offset: start + lastNewline + 1,
        partial: false,
      };
    }
    const atEof = start + read >= end;
    if (!allowPartial || atEof || read < stop - start) return { text: '', offset: start, partial: false };
    const cut = utf8Cut(buffer, read);
    if (cut <= 0) return { text: '', offset: start, partial: false };
    return {
      text: buffer.toString('utf8', 0, cut),
      offset: start + cut,
      partial: true,
    };
  } finally {
    fs.closeSync(fd);
  }
}

interface PartialResume {
  text: string;
  skippingData: boolean;
  discarded?: boolean;
}

// Carry oversized records across reads while eliding inline image bytes from cached state.
function resumePartialLine(
  prior: PartialResume | undefined,
  chunk: string,
  sessionId: string | undefined,
  captureImages: boolean,
): { lines: string[]; partial?: PartialResume } {
  let text = prior?.text ?? '';
  let skipping = prior?.skippingData ?? false;
  let discarded = prior?.discarded === true;
  const lines: string[] = [];
  let i = 0;

  const lostImage = skipping && captureImages && !!sessionId && !hasOpenInlineImage(sessionId);
  if (skipping) {
    const quote = chunk.indexOf('"');
    if (quote < 0) {
      if (captureImages && sessionId && !lostImage) appendInlineImage(sessionId, chunk, 'image/png');
      return { lines, partial: { text, skippingData: true, ...(discarded ? { discarded: true } : {}) } };
    }
    if (captureImages && sessionId && !lostImage) {
      appendInlineImage(sessionId, chunk.slice(0, quote), mediaTypeOf(text));
      finishInlineImage(sessionId);
    }
    text += '"';
    skipping = false;
    i = quote + 1;
  }

  while (i < chunk.length) {
    if (discarded) {
      const nl = chunk.indexOf('\n', i);
      if (sessionId) dropOpenInlineImage(sessionId);
      if (nl < 0) return { lines, partial: { text: '', skippingData: false, discarded: true } };
      discarded = false;
      text = '';
      i = nl + 1;
      continue;
    }
    const nl = chunk.indexOf('\n', i);
    const regionEnd = nl < 0 ? chunk.length : nl;
    const region = chunk.slice(i, regionEnd);
    const tail = text.slice(-32);
    const hay = tail + region;
    const marker = hay.match(/"data"\s*:\s*"/);
    const markerAt = marker?.index ?? -1;
    const markerEnd = marker ? markerAt + marker[0].length : -1;
    if (marker && markerEnd >= tail.length && isImageData(hay.slice(0, markerAt))) {
      const dataStart = markerEnd - tail.length;
      const rest = dataStart < 0 ? region : region.slice(dataStart);
      if (dataStart > 0) text += region.slice(0, dataStart);
      const quote = rest.indexOf('"');
      if (quote < 0) {
        if (captureImages && sessionId) appendInlineImage(sessionId, rest, mediaTypeOf(text));
        const next = capped(text, true);
        if (next.discarded && sessionId) dropOpenInlineImage(sessionId);
        return { lines, partial: next };
      }
      if (captureImages && sessionId) {
        appendInlineImage(sessionId, rest.slice(0, quote), mediaTypeOf(text));
        finishInlineImage(sessionId);
      }
      text += '"';
      i += (dataStart < 0 ? 0 : dataStart) + quote + 1;
      continue;
    }
    if (nl < 0) {
      text += region;
      if (text.length > MAX_PARTIAL_TEXT) {
        if (sessionId) dropOpenInlineImage(sessionId);
        return { lines, partial: { text: '', skippingData: false, discarded: true } };
      }
      return { lines, partial: text ? { text, skippingData: false } : undefined };
    }
    text += region;
    if (text.trim()) lines.push(text);
    text = '';
    i = nl + 1;
  }
  return { lines, partial: undefined };
}

function capped(text: string, skippingData: boolean): PartialResume {
  if (text.length <= MAX_PARTIAL_TEXT) return { text, skippingData };
  return { text: '', skippingData: false, discarded: true };
}

function mediaTypeOf(text: string): string {
  return text.match(/"media_type"\s*:\s*"(image\/(?:png|jpeg|gif|webp))"/)?.[1] ?? 'image/png';
}

function isImageData(before: string): boolean {
  return before.slice(-180).includes('base64');
}

// Codex folds item_completed only; including response_item would double-count each turn.
function eventsForChunk(agent: SessionAgentId, text: string): SessionEvent[] {
  if (agent === 'claude') {
    return parseClaudeContent(text, { includeInterrupts: true, includeFileHistory: true, includeInlineImages: true });
  }
  return parseCodexItemsContent(text);
}

export function parseTimelineEvents(filePath: string, agent: SessionAgentId): SessionEvent[] {
  if (isResumableTimelineSource(agent)) {
    return eventsForChunk(agent, fs.readFileSync(filePath, 'utf8'));
  }
  return parseSession(filePath, agent, { includeInterrupts: true, includeFileHistory: true, includeInlineImages: true });
}

interface SessionTimelineFold {
  entry: SessionTimelineEntry;
  bytesRead: number;
}

function mib(bytes: number): number {
  return Math.round((bytes / (1024 * 1024)) * 10) / 10;
}

// Non-resumable harnesses reparse a fresh whole file, rate-limited and bounded, charging actual bytes read.
function foldSessionTimeline(
  session: ActiveSession,
  filePath: string,
  fileSize: number,
  prior: SessionTimelineCacheRow | undefined,
  nowMs: number = Date.now(),
  byteBudget: number = TIMELINE_PASS_MAX_BYTES_PER_TICK,
): SessionTimelineFold | undefined {
  const agent = (session.kind ?? 'claude') as SessionAgentId;
  const settledAt = (): TimelineState => ({ ...emptyTimelineState(), offset: fileSize });
  const unavailable = NO_TRANSCRIPT_REASON[agent];
  if (unavailable) {
    return { entry: { timeline: unavailableTimeline(unavailable), state: settledAt() }, bytesRead: 0 };
  }

  let state: TimelineState;
  let events: SessionEvent[];
  let offset: number;
  let bytesRead: number;

  let partial: PartialResume | undefined;
  if (isResumableTimelineSource(agent)) {
    const resumable = prior?.state
      && prior.state.version === TIMELINE_EXTRACTOR_VERSION
      && prior.state.offset <= fileSize;
    state = resumable ? prior!.state : emptyTimelineState();
    if (!resumable && session.sessionId) dropOpenInlineImage(session.sessionId);
    const start = resumable ? state.offset : 0;
    const maxBytes = Math.min(byteBudget, TIMELINE_PASS_MAX_BYTES_PER_SESSION);
    const chunk = readCompleteLines(filePath, start, fileSize, maxBytes, maxBytes === TIMELINE_PASS_MAX_BYTES_PER_SESSION);
    if (!chunk.text && chunk.offset === start) return undefined;
    const resumed = resumePartialLine(resumable ? state.partialLine : undefined, chunk.text, session.sessionId, agent === 'claude');
    partial = chunk.partial ? resumed.partial : undefined;
    if (!chunk.partial && session.sessionId && resumed.partial?.discarded) dropOpenInlineImage(session.sessionId);
    events = resumed.lines.length ? eventsForChunk(agent, resumed.lines.map(line => line + '\n').join('')) : [];
    offset = chunk.offset;
    bytesRead = chunk.offset - start;
    if (agent === 'claude' && session.sessionId && !partial) {
      const paths = takePendingImagePaths(session.sessionId);
      for (const event of events) {
        if (event.type !== 'attachment' || event.path || !paths.length) continue;
        const cached = paths.shift()!;
        event.path = cached.path;
        event.sizeBytes = cached.size;
      }
    }
  } else {
    if (prior && nowMs - prior.computedAt < TIMELINE_PASS_NON_RESUMABLE_MIN_INTERVAL_MS) return undefined;
    if (fileSize > TIMELINE_PASS_MAX_WHOLE_FILE_BYTES) {
      return {
        entry: {
          timeline: unavailableTimeline(
            `transcript is larger than the ${Math.round(TIMELINE_PASS_MAX_WHOLE_FILE_BYTES / (1024 * 1024))} MiB whole-file fold limit for ${agent}`,
          ),
          state: settledAt(),
        },
        bytesRead: 0,
      };
    }
    const wholeFileAllowance = Math.min(byteBudget, TIMELINE_PASS_MAX_WHOLE_FILE_BYTES);
    if (fileSize > wholeFileAllowance) {
      return {
        entry: {
          timeline: {
            ...unavailableTimeline(
              `a ${mib(fileSize)} MiB ${agent} transcript needs a whole-file fold, and this tick had ${mib(wholeFileAllowance)} MiB of budget left`,
            ),
            state: 'partial',
          },
          state: emptyTimelineState(),
        },
        bytesRead: 0,
      };
    }
    state = emptyTimelineState();
    events = parseTimelineEvents(filePath, agent);
    offset = fileSize;
    bytesRead = fileSize;
  }

  if (agent === 'claude' && session.sessionId) materializeInlineImages(events, session.sessionId);
  const folded = compactTimelineState(
    foldTimeline(events, state, {
      attachments: session.attachments,
      maxEvents: isResumableTimelineSource(agent) ? undefined : TIMELINE_PASS_MAX_EVENTS,
      offset,
    }),
  );
  if (partial) folded.partialLine = partial;
  else delete folded.partialLine;
  const files = projectSessionFiles(folded);
  const glance = projectGlance(folded.glance);
  if (offset < fileSize) delete glance.activityHistogram;
  const subagents = agent === 'claude'
    ? readSessionSubagents(filePath, session.pidAlive === true, folded.glance.failedAgentCalls, nowMs)
    : undefined;
  return {
    entry: {
      ...glance,
      ...(subagents?.length ? { subagents } : {}),
      timeline: projectTimeline(folded, session.activity),
      ...(folded.request ? { request: folded.request } : {}),
      ...(files ? { files } : {}),
      state: folded,
    },
    bytesRead,
  };
}

export async function runTimelinePass(opts: TimelinePassOptions = {}): Promise<TimelinePassResult> {
  const { readActiveSessionsCache, isActiveSessionsJournalReaderRecent } = await import('./session-cache.js');
  const now = opts.nowMs ?? Date.now();

  let sessions = opts.sessions;
  if (!sessions) {
    if (opts.requireReader !== false && !isActiveSessionsJournalReaderRecent(now)) {
      return { computed: 0, reused: 0, skipped: 0 };
    }
    sessions = readActiveSessionsCache('local')?.sessions ?? [];
  }
  return runTimelinePassSync({ ...opts, sessions });
}

// Stamp the source the parser reads, not the wrapper path, so split-file growth cannot appear unchanged.
export function runTimelinePassSync(
  opts: TimelinePassOptions & { sessions: ActiveSession[] },
): TimelinePassResult {
  const result: TimelinePassResult = { computed: 0, reused: 0, skipped: 0 };
  const sessions = opts.sessions;

  const now = opts.nowMs ?? Date.now();
  const stat = opts.statFile ?? ((p: string) => {
    const s = fs.statSync(p);
    return { mtimeMs: s.mtimeMs, size: s.size };
  });

  let budget = opts.budget ?? TIMELINE_PASS_MAX_PER_TICK;
  let byteBudget = opts.maxBytes ?? TIMELINE_PASS_MAX_BYTES_PER_TICK;
  for (const session of sessions) {
    if (opts.signal?.aborted) break;
    if (budget <= 0 || byteBudget <= 0) break;
    const id = session.sessionId;
    const file = session.sessionFile;
    if (!id || !file) continue;
    const source = toolEvidenceSourcePath(file, (session.kind ?? 'claude'));

    let stamp: { fileMtimeMs: number; fileSize: number };
    try {
      const st = stat(source);
      stamp = { fileMtimeMs: Math.round(st.mtimeMs), fileSize: st.size };
    } catch {
      result.skipped++;
      continue;
    }

    const prior = readSessionTimelineEntry(id);
    if (prior && prior.state.version === TIMELINE_EXTRACTOR_VERSION && prior.state.offset === stamp.fileSize) {
      result.reused++;
      continue;
    }

    budget--;
    let fold: SessionTimelineFold | undefined;
    try {
      fold = foldSessionTimeline(session, file, stamp.fileSize, prior, now, byteBudget);
    } catch (err) {
      console.log(`timeline pass: fold failed for ${id} (${session.kind ?? 'claude'}): ${(err as Error).message}`);
      result.skipped++;
      continue;
    }
    if (!fold) {
      result.reused++;
      continue;
    }
    byteBudget -= fold.bytesRead;
    writeSessionTimeline({ id, ...stamp, timeline: fold.entry, computedAtMs: now });
    result.computed++;
  }

  return result;
}
