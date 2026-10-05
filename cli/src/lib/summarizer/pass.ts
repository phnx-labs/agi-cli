
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

const SUMMARIZER_MAX_PER_TICK = 8;

const SUMMARIZER_STEP_INPUT = 12;

interface SummarizerPassOptions {
  now?: number;
  config?: SummarizerConfig;
  sessions?: ActiveSession[];
  summarizeImpl?: typeof defaultSummarize;
  signal?: AbortSignal;
  maxPerTick?: number;
  statFile?: (p: string) => { mtimeMs: number; size: number };
  requireReader?: boolean;
}

interface SummarizerPassResult {
  disabled: boolean;
  computed: number;
  reused: number;
  skipped: number;
}

function stampCheckpoints(
  texts: string[],
  prior: SessionCheckpoint[] | undefined,
  nowIso: string,
): SessionCheckpoint[] {
  const priorAt = new Map((prior ?? []).map((c) => [c.text, c.at]));
  return texts.map((text) => ({ text, at: priorAt.get(text) ?? nowIso }));
}

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
      continue;
    }

    if (readSessionSummary(id, stamp)) {
      result.reused++;
      continue;
    }

    budget--;
    const prompt = (s.firstUserMessage ?? s.topic ?? '').trim();
    const prior = readSessionSummaryAny(id);
    if (!prompt) {
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
