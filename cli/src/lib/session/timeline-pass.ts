/**
 * The daemon's incremental timeline pass (PHNX-3939).
 *
 * Runs inside the existing `SessionStateService` tick, which is already
 * reader-gated — no watcher, no work — and already visits every live session.
 * This adds the one thing the tick did not do: fold each live transcript's
 * NEW BYTES into its cached {@link TimelineState} and store the bounded
 * projection a session row merges.
 *
 * Three properties keep it off the request path and off the CPU:
 *   - **Reader-gated and budgeted.** Nothing runs unless a `sessions watch`
 *     consumer is attached, and at most `budget` sessions are folded per tick.
 *   - **Appended bytes only.** For the resumable harnesses (Claude and Codex,
 *     line-delimited JSON) a fold reads `size - offset` bytes, not the file.
 *     The same resume rule the tool index already uses (`tool-index.ts`).
 *   - **Complete records only.** Only newline-terminated lines are folded and
 *     the offset advances past those alone, so the 973,963-byte record in one
 *     live transcript on this fleet cannot be folded half-written; the next tick
 *     picks it up whole.
 */

import * as fs from 'fs';
import type { ActiveSession } from './active.js';
import { readSessionTimelineEntry, writeSessionTimeline, type SessionTimelineCacheRow, type SessionTimelineEntry } from './db.js';
import { parseClaudeContent, parseCodexItemsContent, parseSession } from './parse.js';
import { toolEvidenceSourcePath } from './tool-store.js';
import type { SessionAgentId, SessionEvent } from './types.js';
import {
  compactTimelineState,
  emptyTimelineState,
  foldTimeline,
  projectSessionFiles,
  projectTimeline,
  unavailableTimeline,
  TIMELINE_EXTRACTOR_VERSION,
  type TimelineState,
} from './timeline.js';

/** Sessions folded per tick. The tick's own deadline is 30 s; this stays well inside it. */
const TIMELINE_PASS_MAX_PER_TICK = 8;

/** Bytes one session may consume in one tick. A bigger backlog catches up over ticks. */
export const TIMELINE_PASS_MAX_BYTES_PER_SESSION = 4 * 1024 * 1024;

/**
 * Bytes the whole pass may consume in one tick, across every session.
 *
 * The per-session cap alone is not a bound on the TICK: on a cold cache eight
 * live sessions each fold from offset 0, and eight multi-megabyte transcripts
 * parsed back to back is what blew the 30 s `session-state` deadline and parked
 * the service on this fleet (observed 2026-09-06). A tick budget makes a cold
 * start catch up over a few ticks instead of stalling one.
 */
const TIMELINE_PASS_MAX_BYTES_PER_TICK = 8 * 1024 * 1024;

/**
 * Ceiling on a whole-file re-parse for a harness with no resumable reader.
 * Beyond it the timeline is reported `partial` rather than wedging the tick —
 * the same honesty rule the tool index applies at its own in-memory limit.
 */
export const TIMELINE_PASS_MAX_WHOLE_FILE_BYTES = 16 * 1024 * 1024;

/** Events folded from one non-resumable whole-file parse before reporting `partial`. */
const TIMELINE_PASS_MAX_EVENTS = 20_000;

/**
 * How long a non-resumable harness's timeline may go stale before the pass
 * re-parses its transcript whole.
 *
 * Kimi and Grok expose no byte offset to resume from, so their only option is a
 * full parse — and a full parse of a large, actively-appended transcript wedges
 * the Node event loop for seconds (the PHNX-3411 incident, which is why the tool
 * index deferred those two harnesses to their own budgeted pass). Re-parsing
 * every 15 s would reproduce it. One re-parse per minute keeps such a session's
 * timeline current enough for a card that moves about once a minute, at a
 * quarter of the cost.
 */
export const TIMELINE_PASS_NON_RESUMABLE_MIN_INTERVAL_MS = 60_000;

/**
 * Harnesses whose transcript is append-only line-delimited JSON that the fold
 * can resume from a byte offset. Everything else is re-parsed whole (bounded)
 * because its parser exposes no offset — the same split as
 * `isResumableToolSource` in `tool-index.ts`.
 */
function isResumableTimelineSource(agent: string): agent is 'claude' | 'codex' {
  return agent === 'claude' || agent === 'codex';
}

/** Harnesses that write no parseable transcript at all — stated, never faked as empty. */
const NO_TRANSCRIPT_REASON: Partial<Record<SessionAgentId, string>> = {
  openclaw: 'OpenClaw writes no parseable transcript, so there are no steps to fold',
};

interface TimelinePassResult {
  /** Sessions whose timeline was folded and written this tick. */
  computed: number;
  /** Sessions whose cached timeline already matched the transcript bytes. */
  reused: number;
  /** Sessions skipped: unreadable transcript, no id/file, or no parseable transcript. */
  skipped: number;
}

interface TimelinePassOptions {
  /** Live rows to fold. Defaults to the local active-sessions cache. */
  sessions?: ActiveSession[];
  budget?: number;
  /** Bytes the whole pass may read this tick, across every session. */
  maxBytes?: number;
  /** Set false only in tests: the pass is reader-gated exactly like the warm tick. */
  requireReader?: boolean;
  nowMs?: number;
  signal?: AbortSignal;
  statFile?: (path: string) => { mtimeMs: number; size: number };
}

/** Read `[start, end)` of a file, keeping only complete newline-terminated lines. */
function readCompleteLines(
  filePath: string,
  start: number,
  end: number,
  maxBytes: number,
): { text: string; offset: number } {
  const stop = Math.min(end, start + maxBytes);
  if (stop <= start) return { text: '', offset: start };
  const fd = fs.openSync(filePath, 'r');
  try {
    const buffer = Buffer.alloc(stop - start);
    const read = fs.readSync(fd, buffer, 0, buffer.length, start);
    const lastNewline = buffer.lastIndexOf(0x0a, read - 1);
    // Nothing complete in this window: leave the offset where it was so the
    // record is folded whole once its closing newline lands.
    if (lastNewline < 0) return { text: '', offset: start };
    return {
      text: buffer.toString('utf8', 0, lastNewline + 1),
      offset: start + lastNewline + 1,
    };
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Normalize one transcript chunk into the events the fold consumes.
 *
 * Interrupts are user steps in the timeline and the harness file ledger is the
 * Files card, so both are opted in — the published stream every OTHER consumer
 * reads stays unchanged. Codex reads its typed `item_completed` stream, NOT the
 * `response_item` records `parseCodexContent` reads: the two describe the same
 * turn, so folding both would double-count every call (see
 * `parseCodexItemsContent`).
 */
function eventsForChunk(agent: SessionAgentId, text: string): SessionEvent[] {
  if (agent === 'claude') {
    return parseClaudeContent(text, { includeInterrupts: true, includeFileHistory: true });
  }
  return parseCodexItemsContent(text);
}

/**
 * Every event of one transcript, read the way the timeline fold needs them.
 *
 * The single source of truth for "which reader does this harness's timeline
 * use", shared by the daemon pass's non-resumable branch and
 * `agents sessions trace --steps` — so the CLI door and the cached row can never
 * fold two different event streams for the same session.
 */
export function parseTimelineEvents(filePath: string, agent: SessionAgentId): SessionEvent[] {
  if (isResumableTimelineSource(agent)) {
    return eventsForChunk(agent, fs.readFileSync(filePath, 'utf8'));
  }
  return parseSession(filePath, agent, { includeInterrupts: true, includeFileHistory: true });
}

/** One session's fold: the entry to cache, and what it actually cost to produce. */
interface SessionTimelineFold {
  entry: SessionTimelineEntry;
  /**
   * Bytes this fold READ off disk — what the tick's byte budget is debited by.
   *
   * Not the transcript's growth delta: a non-resumable harness re-parses the
   * WHOLE file every time, so eight 3 MiB sessions grown by 10 KB each read
   * 24 MiB, not 80 KB. Charging the delta is what let a tick overrun its budget
   * by an order of magnitude.
   */
  bytesRead: number;
}

/** MiB, for the human-readable reasons a row carries. */
function mib(bytes: number): number {
  return Math.round((bytes / (1024 * 1024)) * 10) / 10;
}

/**
 * Fold one session's new transcript bytes and return the entry to cache.
 * Exported for tests: this is where the resume decision and the whole-file
 * fallback live, and both are worth pinning without a daemon.
 *
 * `byteBudget` is the TICK's remaining allowance. Each branch derives its own
 * ceiling from it — the resumable chunk read is additionally capped per session,
 * while a whole-file re-parse is gated on a budget that can actually reach a
 * real transcript. A session that genuinely does not fit gets a `partial` row
 * stating why, never silence.
 */
function foldSessionTimeline(
  session: ActiveSession,
  filePath: string,
  fileSize: number,
  prior: SessionTimelineCacheRow | undefined,
  nowMs: number = Date.now(),
  byteBudget: number = TIMELINE_PASS_MAX_BYTES_PER_TICK,
): SessionTimelineFold | undefined {
  const agent = (session.kind ?? 'claude') as SessionAgentId;
  // A settled state stamped at the file's current size, so an unavailable or
  // over-limit session is recognized as up to date next tick instead of being
  // re-decided every 15 s.
  const settledAt = (): TimelineState => ({ ...emptyTimelineState(), offset: fileSize });
  const unavailable = NO_TRANSCRIPT_REASON[agent];
  if (unavailable) {
    return { entry: { timeline: unavailableTimeline(unavailable), state: settledAt() }, bytesRead: 0 };
  }

  let state: TimelineState;
  let events: SessionEvent[];
  let offset: number;
  let bytesRead: number;

  if (isResumableTimelineSource(agent)) {
    const resumable = prior?.state
      && prior.state.version === TIMELINE_EXTRACTOR_VERSION
      && prior.state.offset <= fileSize;
    state = resumable ? prior!.state : emptyTimelineState();
    const start = resumable ? state.offset : 0;
    const maxBytes = Math.min(byteBudget, TIMELINE_PASS_MAX_BYTES_PER_SESSION);
    const chunk = readCompleteLines(filePath, start, fileSize, maxBytes);
    // Nothing COMPLETE in the window this tick could read — a record still being
    // written, or a byte budget too small to reach the next newline. Leave the
    // cached row and its offset alone; writing here would stamp an empty fold
    // over a real one and move the resume point past bytes never folded.
    if (!chunk.text && chunk.offset === start) return undefined;
    events = eventsForChunk(agent, chunk.text);
    offset = chunk.offset;
    bytesRead = chunk.offset - start;
  } else {
    // No resumable reader for this harness: re-parse whole, bounded, from a
    // FRESH state — a partial re-fold onto a prior state would double-count.
    // Rate-limited so an actively-appended large transcript is not re-parsed on
    // every 15 s tick (see TIMELINE_PASS_NON_RESUMABLE_MIN_INTERVAL_MS).
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
    // Eligibility is the smaller of what the tick has left and what a whole-file
    // fold is allowed to cost — NOT the per-session allowance, which is capped
    // at 4 MiB and so could never reach a transcript in (4 MiB, 16 MiB] however
    // idle the tick was. That gap left every such session on kimi/grok/gemini/
    // cursor/opencode/droid/warp/forge/copilot/goose/antigravity with no row at
    // all, silently counted `reused`.
    const wholeFileAllowance = Math.min(byteBudget, TIMELINE_PASS_MAX_WHOLE_FILE_BYTES);
    if (fileSize > wholeFileAllowance) {
      // It does not fit THIS tick. Say so on the row rather than write nothing:
      // the state is left at offset 0, so a tick with more budget upgrades it to
      // a real fold instead of the session staying invisible forever.
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
    // The whole file was read, not the delta — charge the tick for all of it.
    bytesRead = fileSize;
  }

  const folded = compactTimelineState(
    foldTimeline(events, state, {
      attachments: session.attachments,
      maxEvents: isResumableTimelineSource(agent) ? undefined : TIMELINE_PASS_MAX_EVENTS,
      offset,
    }),
  );
  const files = projectSessionFiles(folded);
  return {
    entry: {
      timeline: projectTimeline(folded, session.activity),
      ...(folded.request ? { request: folded.request } : {}),
      ...(files ? { files } : {}),
      state: folded,
    },
    bytesRead,
  };
}

/**
 * Fold the timelines of the live local sessions, bounded, once per tick.
 * Returns what it did so the daemon tick can log it like every other pass.
 *
 * Async only because resolving the session list needs the session-cache module,
 * which is loaded lazily to keep this off the CLI's startup graph. When the
 * caller already HAS the rows (the daemon tick does — it just gathered them),
 * {@link runTimelinePassSync} is the same work with no dynamic import.
 */
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

/** {@link runTimelinePass} over an explicit row list. Pure of the session cache. */
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
    // Stamp on the file the PARSER reads, not the row's `sessionFile`: Kimi's row
    // points at `state.json` while its content is in a sibling `wire.jsonl`, and
    // Grok's at `summary.json` beside `chat_history.jsonl`. Stamping the wrong
    // file makes an actively-growing session look unchanged forever. Same helper
    // the tool index uses, so the two agree on what a session's bytes are.
    const source = toolEvidenceSourcePath(file, (session.kind ?? 'claude'));

    let stamp: { fileMtimeMs: number; fileSize: number };
    try {
      const st = stat(source);
      stamp = { fileMtimeMs: Math.round(st.mtimeMs), fileSize: st.size };
    } catch {
      result.skipped++;
      continue; // transcript unreadable this tick — try again next time
    }

    const prior = readSessionTimelineEntry(id);
    // Cached against these exact bytes: nothing was appended, nothing to fold.
    if (prior && prior.state.offset === stamp.fileSize) {
      result.reused++;
      continue;
    }

    budget--;
    let fold: SessionTimelineFold | undefined;
    try {
      fold = foldSessionTimeline(session, file, stamp.fileSize, prior, now, byteBudget);
    } catch (err) {
      // A novel record shape, or a transcript rotated between the stat and the
      // read. That is a real failure, not "nothing new" — say so and count it a
      // skip, or it retries forever behind a healthy-looking log line.
      console.log(`timeline pass: fold failed for ${id} (${session.kind ?? 'claude'}): ${(err as Error).message}`);
      result.skipped++;
      continue;
    }
    if (!fold) {
      // Nothing complete to fold yet, or a non-resumable harness inside its
      // re-parse interval — the cached row stays current, so this is not a skip.
      result.reused++;
      continue;
    }
    // Debited by the bytes actually read, so the tick's bound is real: a
    // whole-file re-parse charges the whole file, and a session that read
    // nothing (over budget, unavailable harness) charges nothing.
    byteBudget -= fold.bytesRead;
    writeSessionTimeline({ id, ...stamp, timeline: fold.entry, computedAtMs: now });
    result.computed++;
  }

  return result;
}
