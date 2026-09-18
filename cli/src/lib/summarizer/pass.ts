/**
 * One session-summarizer pass (PHNX-3939) — the work the background
 * SessionSummarizerService does per tick, factored out so it is testable with an
 * injected model stub and no daemon scaffolding.
 *
 * Off the request path by construction: it reads THIS box's already-published
 * live sessions (the warm cache the session-state service writes — never a fresh
 * gather) and, per session, reuses the transcript-keyed `session_summaries` row
 * until the transcript bytes change, so an unchanged session costs one indexed
 * read and zero model calls. When the summarizer is disabled or has no endpoint,
 * the pass does nothing at all.
 */

import * as fs from 'node:fs';

import type { ActiveSession } from '../session/active.js';
import type { SessionCheckpoint } from '@phnx-labs/sessions-cli/reader';
import {
  readSessionSummary,
  readSessionSummaryAny,
  writeSessionSummary,
  type SessionSummaryEntry,
} from '../session/db.js';
import {
  isActiveSessionsJournalReaderRecent,
  readActiveSessionsCache,
} from '../session/session-cache.js';
import { resolveSummarizerConfig, isSummarizerRunnable, type SummarizerConfig } from './config.js';
import { summarize as defaultSummarize } from './summarize.js';

/** Max sessions summarized per tick — a debounce ceiling on local-model calls. */
const SUMMARIZER_MAX_PER_TICK = 8;

/** Narration headlines handed to the model per session — the recent tail, not the history. */
const SUMMARIZER_STEP_INPUT = 12;

interface SummarizerPassOptions {
  now?: number;
  config?: SummarizerConfig;
  /** Live sessions to consider; default = this box's warm local-session cache. */
  sessions?: ActiveSession[];
  /** Injectable model call (tests stub the endpoint here). */
  summarizeImpl?: typeof defaultSummarize;
  signal?: AbortSignal;
  maxPerTick?: number;
  /** Injectable stat for tests; defaults to fs.statSync. */
  statFile?: (p: string) => { mtimeMs: number; size: number };
  /** Skip the reader-recency gate (tests pass sessions directly). */
  requireReader?: boolean;
}

interface SummarizerPassResult {
  disabled: boolean;
  computed: number;
  reused: number;
  skipped: number;
}

/**
 * Merge model checkpoint TEXTS with any prior stored checkpoints so a line that
 * already existed keeps its original `at`, and only genuinely new lines get
 * stamped `now`. Order follows the model output (newest last).
 */
function stampCheckpoints(
  texts: string[],
  prior: SessionCheckpoint[] | undefined,
  nowIso: string,
): SessionCheckpoint[] {
  const priorAt = new Map((prior ?? []).map((c) => [c.text, c.at]));
  return texts.map((text) => ({ text, at: priorAt.get(text) ?? nowIso }));
}

/**
 * Run one pass. Returns per-outcome counts. Never throws — a per-session failure
 * is isolated so one bad transcript can't stall the whole tick.
 */
export async function runSummarizerPass(opts: SummarizerPassOptions = {}): Promise<SummarizerPassResult> {
  const now = opts.now ?? Date.now();
  const config = opts.config ?? resolveSummarizerConfig();
  const result: SummarizerPassResult = { disabled: false, computed: 0, reused: 0, skipped: 0 };
  if (!isSummarizerRunnable(config)) {
    result.disabled = true;
    return result;
  }

  let sessions = opts.sessions;
  if (!sessions) {
    // Reader-gated like the active-sessions warm tick: no watcher, no work.
    if (opts.requireReader !== false && !isActiveSessionsJournalReaderRecent(now)) return result;
    sessions = readActiveSessionsCache('local')?.sessions ?? [];
  }

  const stat = opts.statFile ?? ((p: string) => {
    const s = fs.statSync(p);
    return { mtimeMs: s.mtimeMs, size: s.size };
  });
  const runSummarize = opts.summarizeImpl ?? defaultSummarize;
  const maxPerTick = opts.maxPerTick ?? SUMMARIZER_MAX_PER_TICK;
  const nowIso = new Date(now).toISOString();

  let budget = maxPerTick;
  for (const s of sessions) {
    if (opts.signal?.aborted) break;
    if (budget <= 0) break;
    const id = s.sessionId;
    const file = s.sessionFile;
    if (!id || !file) continue;

    let stamp: { fileMtimeMs: number; fileSize: number };
    try {
      const st = stat(file);
      stamp = { fileMtimeMs: Math.round(st.mtimeMs), fileSize: st.size };
    } catch {
      continue; // transcript unreadable this tick — try again next time
    }

    // Cached for these exact bytes → never recompute (the core "blazing fast" rule).
    if (readSessionSummary(id, stamp)) {
      result.reused++;
      continue;
    }

    budget--;
    const prompt = (s.firstUserMessage ?? s.topic ?? '').trim();
    const prior = readSessionSummaryAny(id);
    if (!prompt) {
      // No extractable intent yet — cache a skip against these bytes so we don't
      // re-attempt every tick; a later transcript write (new bytes) retries.
      writeSessionSummary({ id, ...stamp, summary: { summaryState: 'skipped' } });
      result.skipped++;
      continue;
    }

    let computed;
    try {
      computed = await runSummarize(
        prompt,
        {
          todos: s.todos,
          plan: s.plan,
          phase: s.phase,
          // The agent's own narration headlines, when the timeline pass has
          // folded them (PHNX-3939) — the model's progress input was previously
          // only the checklist, which many sessions never write. Optional by
          // construction: a row with no timeline passes nothing extra.
          ...(s.timeline?.steps.length
            ? { steps: s.timeline.steps.slice(-SUMMARIZER_STEP_INPUT).map((step) => step.text) }
            : {}),
        },
        { baseUrl: config.baseUrl!, model: config.model!, ...(opts.signal ? { signal: opts.signal } : {}) },
      );
    } catch {
      computed = undefined;
    }

    if (!computed) {
      writeSessionSummary({ id, ...stamp, summary: { summaryState: 'skipped' } });
      result.skipped++;
      continue;
    }

    const entry: SessionSummaryEntry = {
      // Goal is computed ONCE at first sight — a prior goal is kept across
      // progress deltas so it stays stable while checkpoints/checklist refresh.
      goal: prior?.goal ?? computed.goal,
      checkpoints: stampCheckpoints(computed.checkpoints, prior?.checkpoints, nowIso),
      summaryChecklist: computed.checklist,
      summaryState: 'ready',
    };
    writeSessionSummary({ id, ...stamp, summary: entry });
    result.computed++;
  }

  return result;
}
