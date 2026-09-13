/**
 * Derived session trajectory model — the one genuinely new computation behind
 * `agents sessions trace`.
 *
 * Nothing in the session pipeline records a per-step DURATION: the indexed tool
 * call (`tool-calls.ts`) keeps only a start timestamp, and `SessionEvent`
 * (`types.ts:46`) carries a `tool_use` and its `tool_result` as two separate
 * events. This module pairs them by `callId` to recover how long each call took,
 * flags the idle gaps between events (stalls), and rolls the per-tool time up
 * into a "where the time went" share — all DERIVED from the normalized event
 * stream, never persisted onto `SessionEvent` or the SQLite `tool_calls` index.
 *
 * Pure and framework-free: it takes the parsed `SessionEvent[]` and the session
 * metadata and returns a plain object the three renderers (HTML / text / JSON)
 * project. Redaction reuses the same `redactSecrets` path as `render`/`share`
 * (`redact.ts`), applied to the derived one-line labels; the label is the only
 * place raw command/argument text reaches the model.
 *
 * The types (`SessionTrajectory`, `TrajectoryStep`) are shaped to also carry the
 * later compare + lineage layouts (a stats block, gaps, and time-share per
 * session), even though this PR renders only the single-session layout.
 */
import { redactSecrets } from '../redact.js';
import { computeSummaryStats, type SessionStats } from './render.js';
import { extractShellPrograms, isShellExecTool } from './shell-programs.js';
import type { SessionEvent, SessionMeta } from './types.js';

/** One drawable step on a session's trajectory — a tool call or a thinking block. */
export interface TrajectoryStep {
  /** 1-based position among drawn steps, stable for `--errors-only` and step refs. */
  ordinal: number;
  kind: 'tool' | 'thinking';
  /** Tool name for `kind === 'tool'` (e.g. `Bash`, `Read`, `Task`). */
  tool?: string;
  /** The waterfall row this draws on — the tool name, or `think` for reasoning. */
  lane: string;
  /** Milliseconds from session start (the earliest event) to this step's start. */
  startMs: number;
  /**
   * Duration in ms. Measured by pairing this `tool_use` with its `tool_result`
   * on `callId`; when no paired result exists (or the harness omits `callId`),
   * falls back to the delta to the next event and sets `durationEstimated`.
   */
  durationMs: number;
  /** True when `durationMs` is the next-event fallback, not a measured pairing. */
  durationEstimated: boolean;
  /** Structured harness outcome from the paired result; never inferred from text. */
  outcome?: 'ok' | 'error' | 'unknown';
  /** Redacted one-line summary (command / path / subagent / pattern). */
  label: string;
  /** Redacted, bounded output/evidence snippet from the paired result. */
  detail?: string;
  /** An inline `Task`/`Agent` sub-agent branch (a cross-session teammate is lineage). */
  delegation?: 'inline-task' | 'teammate';
  /** Output tokens attributed from the nearest following usage event. */
  outputTokens?: number;
  /** Harness-native call identity, when present. */
  callId?: string;
  /**
   * For a shell tool call (`Bash`), the effective program the command actually
   * ran — `git`, `gh`, `agents`, `bun`, `sed`… — extracted by the shared shell
   * parser (`extractShellPrograms`, wrappers like `timeout`/`sudo`/`agents ssh`
   * unwrapped). Lets a Bash-dominated trajectory read by what it DID, not a wall
   * of "Bash". Undefined for non-shell tools or an unparseable command.
   */
  program?: string;
  /** Process exit code from the paired result (or the tool_use event), when the harness recorded one. */
  exitCode?: number;
}

/** An idle stall between two events — a candidate "where did it hang" marker. */
export interface TrajectoryGap {
  /** Milliseconds from session start to where the gap begins. */
  startMs: number;
  /** How long nothing happened, in ms. */
  durationMs: number;
  /** Ordinal of the last step before the gap (0 when the gap precedes step 1). */
  afterOrdinal: number;
}

/** The derived trajectory of one session. */
export interface SessionTrajectory {
  session: SessionMeta;
  /** Wall-clock span of the session in ms (last event − first event). */
  spanMs: number;
  steps: TrajectoryStep[];
  gaps: TrajectoryGap[];
  /**
   * Fraction of measured tool time per effective program, summing to ~1 (empty if
   * no time). Keyed by the same tag the step list and badges use — a shell call's
   * effective program (`git`, `bun`, `gh`), else the raw tool — so a Bash-heavy
   * session reads as `git / bun / gh`, never a single opaque `Bash`. The single
   * source both the HTML and text "where the time went" panels read.
   */
  programTimeShare: Record<string, number>;
  /**
   * Failed steps — steps whose paired result carried `outcome: 'error'`. Distinct
   * from `stats.errorCount`, which counts only standalone `type: 'error'` events;
   * a tool that failed via a `tool_result` outcome is invisible there but counted
   * here, so this is the truthful "how many calls failed" for the trajectory view.
   */
  errorCount: number;
  /** True when derived labels/details were secret-redacted (false under `--no-redact`). */
  redacted: boolean;
  /** Reused wholesale from `computeSummaryStats` — turns, tools, tokens, span. */
  stats: SessionStats;
  /** Steps dropped by the `maxSteps` cap, surfaced so truncation is never silent. */
  truncatedSteps: number;
}

interface BuildTrajectoryOptions {
  /** Redact derived labels/details (default true; `--no-redact` is local-only). */
  redact?: boolean;
  /** Known secret values to mask, from `knownSecretValuesFromEnv()`. */
  knownSecrets?: readonly string[];
  /** A gap longer than this (ms) is recorded as an idle stall. Default 120000. */
  idleThresholdMs?: number;
  /** Cap on drawn steps; the tail is dropped and counted. Default 5000. */
  maxSteps?: number;
}

const DEFAULT_IDLE_THRESHOLD_MS = 120_000;
const DEFAULT_MAX_STEPS = 5000;
const LABEL_MAX = 140;
const DETAIL_MAX = 400;

/** Tools that spawn an inline sub-agent inside THIS transcript (a `tool_use` row). */
const INLINE_TASK_TOOLS = new Set(['Task', 'Agent']);

/**
 * Shell builtins/assignments that are rarely the POINT of a command — the action
 * is whatever runs after them (`export X=Y; git push` → `git`, `cd dir && bun test`
 * → `bun`). Skipped when a real program follows so a Bash row reads by what it did.
 */
const SHELL_NOISE_PROGRAMS = new Set(['export', 'cd', 'set', 'source', '.', 'unset', 'local', 'eval']);

/**
 * The effective program a shell command ran, via the shared shell parser
 * (`extractShellPrograms` — which unwraps the wrappers it knows: `env`, `sudo`,
 * `agents ssh`; note `timeout` is deliberately NOT a wrapper there, per SES-37,
 * so `timeout 30 npm test` resolves to `timeout`). On top of that this skips
 * bare builtins/assignments (`cd`, `export`, …) when a real program follows. For
 * a pipeline it takes the LEFTMOST effective program (`cat f | grep x` → `cat`),
 * matching how the parser orders occurrences. Undefined when nothing static is
 * identifiable. Never executes anything.
 */
export function effectiveProgram(command: string | undefined): string | undefined {
  if (!command) return undefined;
  const { occurrences, programs } = extractShellPrograms(command);
  const effective = occurrences.filter((o) => o.role === 'effective').map((o) => o.program);
  const meaningful = effective.find((p) => !SHELL_NOISE_PROGRAMS.has(p))
    ?? programs.find((p) => !SHELL_NOISE_PROGRAMS.has(p));
  return meaningful ?? effective[0] ?? programs[0];
}

function toMs(timestamp: string): number {
  const ms = new Date(timestamp).getTime();
  return Number.isNaN(ms) ? NaN : ms;
}

function firstLine(text: string): string {
  const nl = text.indexOf('\n');
  return nl === -1 ? text : text.slice(0, nl);
}

function clip(text: string, max: number): string {
  const collapsed = firstLine(text).replace(/\s+/g, ' ').trim();
  return collapsed.length <= max ? collapsed : `${collapsed.slice(0, max - 1)}…`;
}

function stringArg(args: Record<string, any> | undefined, ...keys: string[]): string | undefined {
  if (!args) return undefined;
  for (const key of keys) {
    const value = args[key];
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return undefined;
}

/**
 * Strip a shell command's leading throwaway statements so its label reads by what
 * it DID, not by its setup. Real agent commands overwhelmingly open with a
 * `cd <repo> &&` (or a multi-line script whose first line is `cd <repo>`), plus the
 * occasional `export X=Y;`, `set -e`, `source …`, or bare `VAR=val` assignment —
 * exactly the {@link SHELL_NOISE_PROGRAMS} the badge already skips when resolving
 * the effective program. Without this, every `cd /long/path && git …` row renders
 * an identical `cd /long/path` and the trajectory is unreadable; here we drop that
 * prefix so the label agrees with the badge (`git …`, `gh …`, `bun …`).
 *
 * Conservative on purpose: only a LEADING run of noise statements separated by
 * `&&`, `;`, or a newline is removed (an assignment PREFIX like `VAR=val cmd` too),
 * pipelines (`|`) are left intact, and a command that is nothing but noise (a lone
 * `cd dir`) is returned unchanged rather than emptied. The separator match is a
 * plain negated class, not a shell tokenizer, so a separator INSIDE a quoted arg
 * (`cd "a; b" && x`) would cut mid-quote — guarded by refusing any strip that
 * leaves the label with unbalanced quotes and falling back to the whole command.
 * Display-only — the value is still clipped and secret-redacted downstream.
 */
function quotesBalanced(text: string): boolean {
  const dq = (text.match(/(?<!\\)"/g) ?? []).length;
  const sq = (text.match(/(?<!\\)'/g) ?? []).length;
  return dq % 2 === 0 && sq % 2 === 0;
}

function stripLeadingShellNoise(command: string): string {
  // A leading `cd`/`export`/`set`/`source`/`unset`/`local`/`eval` statement, or an
  // assignment, terminated by a statement separator (`&&`, `;`, or newline).
  const noiseStatement = /^\s*(?:cd|export|set|source|unset|local|eval)\b[^\n&;|]*(?:&&|;|\n)+/i;
  // A bare `VAR=val` — either a full statement (with a separator) or a prefix
  // (followed by whitespace before the real program: `FOO=bar git push`).
  const assignment = /^\s*[A-Za-z_][A-Za-z0-9_]*=[^\s&;|]*(?:\s*(?:&&|;|\n)+|\s+)/;
  let cmd = command;
  let prev = '';
  while (cmd !== prev) {
    prev = cmd;
    cmd = cmd.replace(noiseStatement, '').replace(assignment, '');
  }
  const trimmed = cmd.trim();
  if (trimmed.length === 0) return command.trim();
  // A strip that severed a quoted argument (a separator lived inside quotes) leaves
  // a dangling quote — keep the whole command rather than show a mangled fragment.
  if (!quotesBalanced(trimmed) && quotesBalanced(command)) return command.trim();
  return trimmed;
}

/**
 * A redacted one-line label for a tool call, derived from the raw arguments.
 *
 * This is the single place unredacted command/argument text enters the model, so
 * it runs through the same `redactSecrets` pass `render`/`share` use. `--no-redact`
 * (local only) skips that pass; the caller passes `redact: false`.
 */
function toolLabel(
  tool: string,
  args: Record<string, any> | undefined,
  command: string | undefined,
  redact: boolean,
  knownSecrets: readonly string[] | undefined,
): string {
  let raw: string | undefined;
  const lower = tool.toLowerCase();
  if (isShellExecTool(tool)) {
    const cmd = command ?? stringArg(args, 'command', 'cmd', 'script');
    raw = cmd ? stripLeadingShellNoise(cmd) : cmd;
  } else if (lower === 'read' || lower === 'edit' || lower === 'write' || lower === 'notebookedit' || lower === 'multiedit') {
    raw = stringArg(args, 'file_path', 'path', 'notebook_path', 'filePath');
  } else if (lower === 'grep' || lower === 'glob' || lower === 'search' || lower === 'codebase_search') {
    raw = stringArg(args, 'pattern', 'query', 'q');
  } else if (lower === 'task' || lower === 'agent') {
    const subagent = stringArg(args, 'subagent_type', 'agentType', 'subagent');
    const description = stringArg(args, 'description', 'prompt');
    raw = subagent ? (description ? `${subagent}: ${description}` : subagent) : description;
  } else if (lower === 'webfetch' || lower === 'websearch' || lower === 'web_search') {
    raw = stringArg(args, 'url', 'query', 'q');
  } else {
    raw = stringArg(args, 'command', 'cmd', 'file_path', 'path', 'query', 'pattern', 'url', 'description');
  }
  const base = raw && raw.trim().length > 0 ? clip(raw, LABEL_MAX) : tool;
  return redact ? redactSecrets(base, knownSecrets) : base;
}

function resultOutcome(event: SessionEvent): 'ok' | 'error' | 'unknown' {
  if (event.outcome === 'ok' || event.outcome === 'error' || event.outcome === 'unknown') return event.outcome;
  if (event.success === true) return 'ok';
  if (event.success === false) return 'error';
  if (event.type === 'error') return 'error';
  return 'unknown';
}

function resultDetail(
  event: SessionEvent,
  redact: boolean,
  knownSecrets: readonly string[] | undefined,
): string | undefined {
  const text = event.output ?? event.content;
  if (!text || text.trim().length === 0) return undefined;
  const clipped = clip(text, DETAIL_MAX);
  return redact ? redactSecrets(clipped, knownSecrets) : clipped;
}

/**
 * One paired step: the drawn {@link TrajectoryStep}, the index of its originating
 * `tool_use`/`thinking` event, and — once pairing completes — the index of the
 * `tool_result`/`error` event that answered it. `buildSessionDetailV2` reads these
 * triples (step, useEvent, resultEvent) to populate the schema-2 per-tool shapes
 * WITHOUT re-running the callId pairing loop.
 */
export interface StepDraft {
  step: TrajectoryStep;
  eventIndex: number;
  callId?: string;
  resultEventIndex?: number;
}

/** Absolute ms per event index (NaN when the timestamp is unparseable). */
export function eventTimestampsMs(events: SessionEvent[]): number[] {
  return events.map((e) => toMs(e.timestamp));
}

/**
 * Draw a step for each thinking block and each non-local tool_use, in order, and
 * pair each `tool_use` with its `tool_result`/`error` on `callId` (FIFO within a
 * reused id — never across ids, and never by arrival order for concurrent calls,
 * matching `ToolCallCollector.takePending`'s refusal to guess, `tool-calls.ts:509`).
 *
 * `_local` tool calls (Claude `!`-prefixed shell) are excluded to match the
 * header's tool count (`computeSummaryStats` skips them, `render.ts:224`).
 *
 * The single source of the pairing: both {@link buildTrajectory} and
 * `buildSessionDetailV2` consume the returned drafts (each draft's `eventIndex` +
 * `resultEventIndex` are the use/result event indices) so the schema-2 producer
 * never re-implements the loop. Durations/outcomes are still resolved by the
 * caller — this only draws and pairs.
 */
export function pairSteps(
  events: SessionEvent[],
  eventMs: number[],
  firstTs: number,
  redact: boolean,
  knownSecrets: readonly string[] | undefined,
): StepDraft[] {
  const drafts: StepDraft[] = [];
  const pendingByCallId = new Map<string, number[]>();
  for (let i = 0; i < events.length; i++) {
    const e = events[i];
    if (e.type === 'thinking') {
      drafts.push({
        step: {
          ordinal: 0,
          kind: 'thinking',
          lane: 'think',
          startMs: Number.isNaN(eventMs[i]) ? 0 : Math.max(0, eventMs[i] - firstTs),
          durationMs: 0,
          durationEstimated: true,
          label: 'thinking',
        },
        eventIndex: i,
      });
    } else if (e.type === 'tool_use' && !e._local) {
      const tool = e.tool || 'unknown';
      const draftIndex = drafts.length;
      drafts.push({
        step: {
          ordinal: 0,
          kind: 'tool',
          tool,
          lane: tool,
          startMs: Number.isNaN(eventMs[i]) ? 0 : Math.max(0, eventMs[i] - firstTs),
          durationMs: 0,
          durationEstimated: true,
          outcome: 'unknown',
          label: toolLabel(tool, e.args, e.command, redact, knownSecrets),
          delegation: INLINE_TASK_TOOLS.has(tool) ? 'inline-task' : undefined,
          callId: e.callId,
          program: isShellExecTool(tool) ? effectiveProgram(e.command ?? (typeof e.args?.command === 'string' ? e.args.command : undefined)) : undefined,
          exitCode: typeof e.exitCode === 'number' ? e.exitCode : undefined,
        },
        eventIndex: i,
        callId: e.callId,
      });
      if (e.callId) {
        const queue = pendingByCallId.get(e.callId);
        if (queue) queue.push(draftIndex);
        else pendingByCallId.set(e.callId, [draftIndex]);
      }
    } else if ((e.type === 'tool_result' || e.type === 'error') && e.callId) {
      // Pair strictly by callId, FIFO within a reused id — never across ids.
      const queue = pendingByCallId.get(e.callId);
      if (queue && queue.length > 0) {
        const draftIndex = queue.shift() as number;
        drafts[draftIndex].resultEventIndex = i;
      }
    }
  }
  return drafts;
}

/**
 * Build the derived trajectory for one session's normalized events.
 *
 * Pairs each `tool_use` with its `tool_result`/`error` on `callId` (FIFO within a
 * reused id — never across ids, and never by arrival order for concurrent calls,
 * matching `ToolCallCollector.takePending`'s refusal to guess, `tool-calls.ts:509`).
 * A harness with no parseable transcript (OpenClaw, `parse.ts:186`) yields an empty
 * event array and therefore an empty trajectory — never a crash or a fabricated one.
 */
export function buildTrajectory(
  events: SessionEvent[],
  meta: SessionMeta,
  options: BuildTrajectoryOptions = {},
): SessionTrajectory {
  const redact = options.redact !== false;
  const knownSecrets = options.knownSecrets;
  const idleThreshold = options.idleThresholdMs ?? DEFAULT_IDLE_THRESHOLD_MS;
  const maxSteps = options.maxSteps ?? DEFAULT_MAX_STEPS;

  const stats = computeSummaryStats(events);
  const firstTs = stats.firstTs;
  const spanMs = stats.lastTs > stats.firstTs ? stats.lastTs - stats.firstTs : 0;

  const eventMs = eventTimestampsMs(events);
  // The next event index (after i) that carries a valid timestamp — the anchor
  // for the next-event duration fallback and for idle-gap detection.
  const nextValidTs: number[] = new Array(events.length).fill(NaN);
  for (let i = events.length - 1, later = NaN; i >= 0; i--) {
    nextValidTs[i] = later;
    if (!Number.isNaN(eventMs[i])) later = eventMs[i];
  }

  const drafts = pairSteps(events, eventMs, firstTs, redact, knownSecrets);

  // Resolve durations, outcomes, and detail now that pairing is complete.
  for (const draft of drafts) {
    const { step } = draft;
    const startAbs = Number.isNaN(eventMs[draft.eventIndex]) ? NaN : eventMs[draft.eventIndex];
    if (draft.resultEventIndex !== undefined) {
      const resultEvent = events[draft.resultEventIndex];
      const resultAbs = eventMs[draft.resultEventIndex];
      if (!Number.isNaN(startAbs) && !Number.isNaN(resultAbs)) {
        step.durationMs = Math.max(0, resultAbs - startAbs);
        step.durationEstimated = false;
      }
      step.outcome = resultOutcome(resultEvent);
      // Prefer the exit code recorded on the paired result; keep the tool_use
      // event's code (set at draft time) only when the result carries none.
      if (typeof resultEvent.exitCode === 'number') step.exitCode = resultEvent.exitCode;
      const detail = resultDetail(resultEvent, redact, knownSecrets);
      if (detail) step.detail = detail;
    } else {
      // No paired result — fall back to the delta to the next timestamped event.
      const nextAbs = nextValidTs[draft.eventIndex];
      if (!Number.isNaN(startAbs) && !Number.isNaN(nextAbs)) {
        step.durationMs = Math.max(0, nextAbs - startAbs);
      }
      step.durationEstimated = true;
    }
  }

  // Attribute output tokens: each usage event lands on the most recent tool step
  // (the nearest following usage from that step's point of view).
  let lastToolDraft: StepDraft | undefined;
  const draftByEventIndex = new Map<number, StepDraft>();
  for (const draft of drafts) draftByEventIndex.set(draft.eventIndex, draft);
  for (let i = 0; i < events.length; i++) {
    const draft = draftByEventIndex.get(i);
    if (draft && draft.step.kind === 'tool') lastToolDraft = draft;
    else if (events[i].type === 'usage' && lastToolDraft) {
      const out = events[i].outputTokens ?? 0;
      if (out > 0) lastToolDraft.step.outputTokens = (lastToolDraft.step.outputTokens ?? 0) + out;
    }
  }

  // Number the steps and apply the cap (tail dropped, counted — never silent).
  let steps = drafts.map((d) => d.step);
  let truncatedSteps = 0;
  if (steps.length > maxSteps) {
    truncatedSteps = steps.length - maxSteps;
    steps = steps.slice(0, maxSteps);
  }
  steps.forEach((step, index) => { step.ordinal = index + 1; });

  // Idle gaps: a long delta between consecutive timestamped events. `afterOrdinal`
  // is the last step whose event index precedes the gap.
  const gaps: TrajectoryGap[] = [];
  const orderedTs: Array<{ index: number; ms: number }> = [];
  for (let i = 0; i < events.length; i++) {
    if (!Number.isNaN(eventMs[i])) orderedTs.push({ index: i, ms: eventMs[i] });
  }
  const stepOrdinalAtOrBefore = (eventIndex: number): number => {
    let ordinal = 0;
    for (const d of drafts) {
      if (d.eventIndex <= eventIndex && d.step.ordinal > 0) ordinal = d.step.ordinal;
      else if (d.eventIndex > eventIndex) break;
    }
    return ordinal;
  };
  for (let k = 1; k < orderedTs.length; k++) {
    // A span that OPENS on a `tool_use` is that tool executing (waiting on its
    // own result), not the agent sitting idle — so it is not a stall. Counting
    // it double-reports a long `bun test` as both its step duration and a fake
    // "idle" gap. Only spans that open after a completed boundary are idle.
    if (events[orderedTs[k - 1].index].type === 'tool_use') continue;
    const delta = orderedTs[k].ms - orderedTs[k - 1].ms;
    if (delta > idleThreshold) {
      gaps.push({
        startMs: Math.max(0, orderedTs[k - 1].ms - firstTs),
        durationMs: delta,
        afterOrdinal: stepOrdinalAtOrBefore(orderedTs[k - 1].index),
      });
    }
  }

  // Where the time went — measured tool duration share per tool.
  // Sum tool time by the EFFECTIVE PROGRAM (a shell call's `git`/`bun`/`gh`, else
  // the raw tool) — the same tag the step list and badges show — so both renderers
  // read one program-keyed source instead of each re-bucketing the steps.
  const perProgram: Record<string, number> = {};
  let totalToolMs = 0;
  for (const step of steps) {
    if (step.kind !== 'tool') continue;
    const tag = step.program ?? step.tool;
    if (!tag) continue;
    perProgram[tag] = (perProgram[tag] ?? 0) + step.durationMs;
    totalToolMs += step.durationMs;
  }
  const programTimeShare: Record<string, number> = {};
  if (totalToolMs > 0) {
    for (const [tag, ms] of Object.entries(perProgram)) {
      if (ms > 0) programTimeShare[tag] = ms / totalToolMs;
    }
  }

  const errorCount = steps.reduce((n, s) => (s.outcome === 'error' ? n + 1 : n), 0);

  return { session: meta, spanMs, steps, gaps, programTimeShare, errorCount, redacted: redact, stats, truncatedSteps };
}
