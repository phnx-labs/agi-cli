/**
 * The narration-anchored session timeline (PHNX-3939) — a pure, resumable fold.
 *
 * A transcript is a flat event stream: the agent says a line, runs six tools,
 * says the next line. A person reading a sidebar wants the LINES, with the tool
 * calls collapsed underneath them. That is the whole model here: one
 * {@link SessionStep} per narration beat, the calls until the next beat folded
 * into counts, failures and milestones.
 *
 * Two properties this module is built around:
 *
 *   - **Deterministic, no model.** The headline is the harness's OWN narration
 *     (Claude assistant text, Codex `AgentMessage` commentary, Gemini thought
 *     subject) and the per-tool label is the harness's own (`description`,
 *     `state.title`, the parsed command). Nothing is invented; the optional
 *     summarizer polishes ON TOP and is never required.
 *   - **Resumable.** {@link foldTimeline} takes the state from the previous fold
 *     and the events that arrived since, so the daemon reads only the bytes a
 *     transcript grew by. Folding the appended tail onto the prior state is
 *     identical to folding the whole file from zero — every piece of mutable
 *     state lives in the serializable {@link TimelineState}, nothing in a
 *     closure.
 *
 * No I/O: the pass (`timeline-pass.ts`) reads bytes and calls this. Same
 * discipline as `digest.ts` and `trajectory.ts`.
 */

import { knownSecretValuesFromEnv, redactSecrets, sanitizeForTerminal } from '../redact.js';
import { classifyBashCommand, detectBashMilestone } from './bash-command.js';
import { firstSentence, tidyRequest } from './prompt.js';
import type {
  SessionEvent,
  SessionFileChange,
  SessionFiles,
  SessionRequest,
  SessionStep,
  SessionTimeline,
  SessionVerbClass,
} from './types.js';

/**
 * Bumped when the fold's OUTPUT changes, so a cached state computed by an older
 * CLI is recomputed rather than rendered. Same role as
 * `SESSION_SUMMARY_EXTRACTOR_VERSION`.
 */
export const TIMELINE_EXTRACTOR_VERSION = 1;

/** Steps carried on the row in full; everything older folds into a counter. */
export const TIMELINE_KEEP_STEPS = 8;

/** File rows carried on the row in full; `total` still reports the real count. */
const TIMELINE_KEEP_FILES = 8;

/**
 * Steps kept in the persisted resume state. A long session narrates for hours,
 * and the state is re-read every tick, so the fold rolls everything past this
 * into {@link TimelineState.dropped} — exact totals, bounded bytes.
 */
const TIMELINE_STATE_MAX_STEPS = 200;

/** Paths kept in the persisted resume state; older ones roll into `filesDropped`. */
const TIMELINE_STATE_MAX_FILES = 200;

/** A narration beat that said nothing and ran nothing merges into the next one within this window. */
const NARRATION_MERGE_MS = 2_000;

/** A thinking block shorter than this is a fragment, not a beat worth showing. */
const MIN_THINKING_CHARS = 20;

/** An open step this busy is a wall of calls: let a thinking block break it up. */
const THINKING_BREAK_TOOLS = 8;

/** Repeated identical user steps inside this window are one turn, not two. */
const USER_STEP_DEDUPE_MS = 10_000;

/** One file the session touched, as accumulated during the fold. */
interface TimelineFileEntry {
  op: SessionFileChange['op'];
  edits: number;
  at: string;
  /** True when a harness file ledger (not a tool argument) recorded this path. */
  harness: boolean;
}

/**
 * Everything the fold needs to continue from where it stopped. Serialized into
 * `session_timelines.state_json`; every field is plain JSON on purpose (`open`
 * and `pending` are indices, not object references) so a resume is exact.
 */
export interface TimelineState {
  version: number;
  /** Byte offset just past the last COMPLETE record folded. */
  offset: number;
  steps: SessionStep[];
  /** Index of the currently open step in {@link steps}, or -1. */
  open: number;
  /** Harness call id → index of the step that owns it, for results that arrive later. */
  pending: Record<string, number>;
  firstMs: number | null;
  lastMs: number | null;
  /** Genuine user turns seen so far. */
  turns: number;
  /** The latest genuine user turn, tidied — the session's operative request. */
  request?: SessionRequest;
  /** The FIRST genuine user turn, kept so history still shows where it started. */
  firstRequest?: SessionRequest;
  /** Path → accumulated change record. */
  files: Record<string, TimelineFileEntry>;
  /** Set when an event cap stopped the fold short: the projection reports `partial`. */
  truncated?: boolean;
  /**
   * Steps rolled out of {@link steps} to keep the persisted state bounded. Their
   * counts still ride the projection's `earlier` block and totals, so folding a
   * compacted state and folding the whole file report the same numbers.
   */
  dropped?: { steps: number; tools: number; failed: number; blocked: number };
  /** Paths rolled out of {@link files} for the same reason; `total` stays exact. */
  filesDropped?: number;
}

/**
 * Roll the oldest steps and file rows out of the state so a session that runs
 * for hours does not grow its cached state without bound. Their tallies survive
 * in {@link TimelineState.dropped} / {@link TimelineState.filesDropped}, which
 * the projection adds back — so this changes the state's SIZE, never its
 * reported numbers.
 */
export function compactTimelineState(
  state: TimelineState,
  maxSteps: number = TIMELINE_STATE_MAX_STEPS,
  maxFiles: number = TIMELINE_STATE_MAX_FILES,
): TimelineState {
  if (state.steps.length > maxSteps) {
    const cut = state.steps.length - maxSteps;
    const removed = state.steps.slice(0, cut);
    const dropped = state.dropped ?? { steps: 0, tools: 0, failed: 0, blocked: 0 };
    for (const step of removed) {
      dropped.steps++;
      dropped.tools += step.tools;
      dropped.failed += step.failed;
      dropped.blocked += step.blocked;
    }
    state.dropped = dropped;
    state.steps = state.steps.slice(cut);
    state.open = state.open >= 0 ? state.open - cut : -1;
    if (state.open < 0) state.open = -1;
    // Pending call ids point at step INDICES, so they shift with the window; a
    // call whose step is gone can no longer be resolved and is dropped rather
    // than left to land on the wrong step.
    const pending: Record<string, number> = {};
    for (const [callId, index] of Object.entries(state.pending)) {
      const shifted = index - cut;
      if (shifted >= 0) pending[callId] = shifted;
    }
    state.pending = pending;
  }
  const paths = Object.keys(state.files);
  if (paths.length > maxFiles) {
    const ordered = paths.sort((a, b) => Date.parse(state.files[b].at) - Date.parse(state.files[a].at));
    for (const stale of ordered.slice(maxFiles)) delete state.files[stale];
    state.filesDropped = (state.filesDropped ?? 0) + (paths.length - maxFiles);
  }
  return state;
}

/** A fresh state for a session nothing has been folded for yet. */
export function emptyTimelineState(): TimelineState {
  return {
    version: TIMELINE_EXTRACTOR_VERSION,
    offset: 0,
    steps: [],
    open: -1,
    pending: {},
    firstMs: null,
    lastMs: null,
    turns: 0,
    files: {},
  };
}

/** Tool names whose verb class is fixed by the name across every harness. */
const TOOL_VERB_CLASSES: Record<string, SessionVerbClass> = {
  read: 'read', Read: 'read', ReadFile: 'read', ReadMediaFile: 'read', read_file: 'read',
  Glob: 'read', glob: 'read', Grep: 'read', grep: 'read', LS: 'read', list: 'read',
  list_dir: 'read', ListDir: 'read', list_files: 'read', search: 'read', NotebookRead: 'read',
  view_image: 'read',
  Edit: 'edit', edit: 'edit', edit_file: 'edit', Write: 'edit', write: 'edit',
  write_file: 'edit', WriteFile: 'edit', StrReplaceFile: 'edit', str_replace: 'edit',
  MultiEdit: 'edit', NotebookEdit: 'edit', apply_patch: 'edit', patch: 'edit',
  Agent: 'agent', Task: 'agent', task: 'agent', AgentSwarm: 'agent',
  WebFetch: 'browser', webfetch: 'browser', FetchURL: 'browser',
  WebSearch: 'browser', websearch: 'browser', SearchWeb: 'browser', web_search: 'browser',
};

/** `detectBashMilestone` event names → the short mark a step renders. */
const MILESTONE_MARKS: Record<string, string> = {
  'commit.created': 'commit',
  pushed: 'pushed',
  'worktree.created': 'worktree created',
  'worktree.removed': 'worktree removed',
  'pr.opened': 'PR opened',
  'pr.merged': 'PR merged',
  'team.spawned': 'team spawned',
  'artifact.rendered': 'artifact rendered',
  'video.rendered': 'video rendered',
  'video.converted': 'video converted',
  'image.upscaled': 'image upscaled',
  'metadata.edited': 'metadata edited',
};

/** How each verb class reads in a derived step's headline. */
const VERB_PHRASES: Record<SessionVerbClass, (n: number) => string> = {
  read: (n) => `read ${n} file${n === 1 ? '' : 's'}`,
  edit: (n) => `edited ${n} file${n === 1 ? '' : 's'}`,
  run: (n) => `ran ${n} command${n === 1 ? '' : 's'}`,
  git: (n) => `ran ${n} git command${n === 1 ? '' : 's'}`,
  test: (n) => `ran ${n} test command${n === 1 ? '' : 's'}`,
  browser: (n) => `made ${n} web call${n === 1 ? '' : 's'}`,
  agent: (n) => `spawned ${n} agent${n === 1 ? '' : 's'}`,
  other: (n) => `made ${n} call${n === 1 ? '' : 's'}`,
};

/** A shell redirection that WRITES a file (`> out`, `| tee f`), not `2>&1` / `>/dev/null`. */
const WRITE_REDIRECT_RE = /(?:^|[^\d&>])>\s*[^&\s]|\btee\b|\bsed\s+-i\b/;

/** Commands whose exit 1 means "no match", not "the work failed". */
const BENIGN_EXIT1_RE = /^\s*(rg|grep|diff|test|\[)\b/;

/**
 * Bucket one Bash command into a verb class, reusing the repo's single command
 * classifier (`classifyBashCommand`) rather than re-deriving a second taxonomy.
 * Its `category` answers most of it; the three things its taxonomy deliberately
 * does not carry — a write redirection, `agents` subcommands, and whether a
 * build tool is running tests — are added on top.
 *
 * Multi-segment commands take the most consequential class present, so
 * `cd x && bun test` is a test, not a `cd`.
 */
export function classifyCommandVerb(command: string | undefined): SessionVerbClass {
  const text = (command ?? '').trim();
  if (!text) return 'other';
  const segments = text.split(/\s*(?:&&|\|\||;|\|)\s*/).filter((s) => s.trim());
  const classes = segments.map((segment) => classifySegmentVerb(segment));
  for (const priority of ['test', 'browser', 'agent', 'git', 'edit'] as const) {
    if (classes.includes(priority)) return priority;
  }
  if (classes.length > 0 && classes.every((verb) => verb === 'read')) return 'read';
  return 'run';
}

function classifySegmentVerb(segment: string): SessionVerbClass {
  const info = classifyBashCommand(segment);
  const lower = segment.toLowerCase();
  if (info.tool === 'agents') {
    if (info.subcommand === 'browser' || info.subcommand === 'computer') return 'browser';
    if (info.subcommand === 'run' || info.subcommand === 'teams') return 'agent';
  }
  switch (info.category) {
    case 'vcs':
      return 'git';
    case 'build-test':
      return /\b(test|vitest|jest|mocha|pytest)\b/.test(lower) ? 'test' : 'run';
    case 'search':
    case 'probe':
    case 'wait':
      return WRITE_REDIRECT_RE.test(segment) ? 'edit' : 'read';
    case 'shell':
      // `sed -n`/`echo`/`awk` READ; `rm`/`mv`/`cp`/`mkdir`/`tee`/`sed -i` WRITE.
      if (/^(rm|mv|cp|mkdir|rmdir|touch|ln|tee)\b/.test(lower)) return 'edit';
      return WRITE_REDIRECT_RE.test(segment) ? 'edit' : 'read';
    default:
      return WRITE_REDIRECT_RE.test(segment) ? 'edit' : 'run';
  }
}

/** The verb class for one tool call: the harness's own if it classified it, else derived. */
export function verbClassForEvent(event: SessionEvent): SessionVerbClass {
  if (event.verbClass) return event.verbClass;
  const byName = event.tool ? TOOL_VERB_CLASSES[event.tool] : undefined;
  if (byName) return byName;
  const command = event.command ?? (typeof event.args?.command === 'string' ? event.args.command : undefined);
  if (command) return classifyCommandVerb(command);
  return 'other';
}

/** The label a now-line shows: the harness's own, else a short tool + target. */
function labelForEvent(event: SessionEvent, verb: SessionVerbClass): string {
  if (event.label) return truncateLabel(event.label);
  const command = event.command ?? (typeof event.args?.command === 'string' ? event.args.command : undefined);
  if (command) return truncateLabel(command.replace(/\s+/g, ' ').trim());
  const target = event.path
    ?? event.args?.file_path ?? event.args?.filePath ?? event.args?.path
    ?? event.args?.pattern ?? event.args?.description ?? event.args?.url ?? event.args?.query ?? '';
  const shown = verb === 'read' || verb === 'edit'
    ? String(target).split(/[\\/]/).pop() ?? ''
    : String(target);
  return truncateLabel(shown ? `${event.tool}: ${shown}` : (event.tool ?? 'tool'));
}

function truncateLabel(text: string, max = 90): string {
  return text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`;
}

function epochMs(timestamp: string | undefined): number | null {
  const parsed = timestamp ? Date.parse(timestamp) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : null;
}

/** Options the fold needs that are not on the events themselves. */
interface FoldTimelineOptions {
  /** Row attachments, so an image the prose never named still rides the request. */
  attachments?: import('./types.js').SessionAttachment[];
  /** Stop after this many events and mark the state `truncated` (the projection reads `partial`). */
  maxEvents?: number;
  /** Byte offset the folded events end at; stored so the next fold resumes there. */
  offset?: number;
}

/**
 * Fold `events` onto `prior` (or a fresh state) and return the new state.
 *
 * Pure: no clock, no filesystem, no database. The rules, in the order they are
 * applied per event, are the plan's fold table — narration opens, thinking opens
 * only when there is nothing open or the open step is already a wall of calls,
 * tools attach, a genuine user turn is its own step, results resolve
 * failed-vs-blocked, and a harness file ledger both marks the step and feeds the
 * files projection.
 */
export function foldTimeline(
  events: SessionEvent[],
  prior?: TimelineState,
  opts: FoldTimelineOptions = {},
): TimelineState {
  const state: TimelineState = prior && prior.version === TIMELINE_EXTRACTOR_VERSION
    ? prior
    : emptyTimelineState();
  const cap = opts.maxEvents ?? Number.POSITIVE_INFINITY;

  let seen = 0;
  for (const event of events) {
    if (seen >= cap) {
      state.truncated = true;
      break;
    }
    seen++;
    const at = epochMs(event.timestamp);
    noteTime(state, at);

    switch (event.type) {
      case 'message': {
        if (event.role === 'assistant') {
          const text = (event.content ?? '').trim();
          if (text) openStep(state, text, event.timestamp, 'narration');
          break;
        }
        if (event.role !== 'user') break;
        const raw = (event.content ?? '').trim();
        if (!raw) break;
        if (raw.startsWith('[Request interrupted')) {
          userStep(state, 'Request interrupted by user', event.timestamp);
          break;
        }
        const request = tidyRequest(raw, { attachments: opts.attachments });
        if (!request) break;
        state.turns++;
        const withTurns: SessionRequest = { ...request, turns: state.turns };
        state.request = withTurns;
        if (!state.firstRequest) state.firstRequest = withTurns;
        userStep(state, request.headline, event.timestamp);
        break;
      }
      case 'interrupt': {
        userStep(state, 'Request interrupted by user', event.timestamp);
        break;
      }
      case 'thinking': {
        const text = (event.content ?? '').trim();
        if (text.length < MIN_THINKING_CHARS) break;
        const open = openStepOf(state);
        if (!open || open.tools >= THINKING_BREAK_TOOLS) openStep(state, text, event.timestamp, 'thinking');
        break;
      }
      case 'tool_use': {
        attachTool(state, event);
        break;
      }
      case 'tool_result':
      case 'error': {
        resolveTool(state, event);
        break;
      }
      case 'file_change': {
        applyFileChanges(state, event);
        break;
      }
      case 'hook': {
        if (event.hookName === 'ContextCompaction') addMark(state, 'context compacted');
        break;
      }
      default:
        break;
    }
  }

  if (opts.offset !== undefined) state.offset = opts.offset;
  return state;
}

function noteTime(state: TimelineState, at: number | null): void {
  if (at === null) return;
  state.firstMs = state.firstMs === null ? at : Math.min(state.firstMs, at);
  state.lastMs = state.lastMs === null ? at : Math.max(state.lastMs, at);
}

function openStepOf(state: TimelineState): SessionStep | undefined {
  return state.open >= 0 ? state.steps[state.open] : undefined;
}

function openStep(
  state: TimelineState,
  text: string,
  timestamp: string,
  source: SessionStep['source'],
): void {
  const open = openStepOf(state);
  // Narration split across two blocks in the same breath is ONE beat: the first
  // said nothing and ran nothing, so it would render as a dangling headline.
  if (
    open && open.tools === 0 && source === 'narration' && open.source === 'narration'
    && withinMs(open.at, timestamp, NARRATION_MERGE_MS)
  ) {
    return;
  }
  state.steps.push({
    text: firstSentence(text),
    at: timestamp,
    endedAt: timestamp,
    source,
    tools: 0,
    failed: 0,
    blocked: 0,
    mix: {},
    marks: [],
  });
  state.open = state.steps.length - 1;
}

function withinMs(a: string | undefined, b: string | undefined, window: number): boolean {
  const first = epochMs(a);
  const second = epochMs(b);
  if (first === null || second === null) return false;
  return Math.abs(second - first) < window;
}

/** A user turn is its own step and closes whatever was open — the agent's turn is over. */
function userStep(state: TimelineState, text: string, timestamp: string): void {
  const headline = firstSentence(text);
  const last = state.steps[state.steps.length - 1];
  // Harnesses re-emit the same turn under two record shapes (a message and a
  // command wrapper); one turn, one step.
  if (last && last.source === 'user' && last.text === headline && withinMs(last.at, timestamp, USER_STEP_DEDUPE_MS)) {
    state.open = -1;
    return;
  }
  state.steps.push({
    text: headline,
    at: timestamp,
    endedAt: timestamp,
    source: 'user',
    tools: 0,
    failed: 0,
    blocked: 0,
  });
  state.open = -1;
}

function attachTool(state: TimelineState, event: SessionEvent): void {
  let step = openStepOf(state);
  if (!step) {
    // Tools with nothing said: a real step, marked `derived`, headlined from the
    // mix once the fold closes (a harness that narrates nothing — Antigravity —
    // renders entirely as these).
    state.steps.push({
      text: '',
      at: event.timestamp,
      endedAt: event.timestamp,
      source: 'derived',
      tools: 0,
      failed: 0,
      blocked: 0,
      mix: {},
      marks: [],
    });
    state.open = state.steps.length - 1;
    step = state.steps[state.open];
  }
  const verb = verbClassForEvent(event);
  step.tools++;
  step.mix = step.mix ?? {};
  step.mix[verb] = (step.mix[verb] ?? 0) + 1;
  step.endedAt = event.timestamp;
  step.now = labelForEvent(event, verb);
  const command = event.command ?? (typeof event.args?.command === 'string' ? event.args.command : undefined);
  if (command) {
    const milestone = detectBashMilestone(command);
    const mark = milestone ? MILESTONE_MARKS[milestone.event] : undefined;
    if (mark) addMarkTo(step, mark);
  }
  recordToolFile(state, event, verb);
  if (event.callId) state.pending[event.callId] = state.open;
}

/** Resolve one call's outcome onto the step that owns it (results can arrive late). */
function resolveTool(state: TimelineState, event: SessionEvent): void {
  const index = event.callId !== undefined ? state.pending[event.callId] : undefined;
  const step = index !== undefined ? state.steps[index] : openStepOf(state);
  if (event.callId !== undefined) delete state.pending[event.callId];
  if (!step) return;
  if (event.blocked) {
    step.blocked++;
    return;
  }
  const failedOutcome = event.type === 'error' || event.outcome === 'error' || event.success === false;
  if (!failedOutcome) return;
  // A search that matched nothing exits 1. It ran, it did its job, and counting
  // it as a failure made every ordinary session look broken.
  const command = event.command ?? (typeof event.args?.command === 'string' ? event.args.command : undefined);
  if (event.exitCode === 1 && command && BENIGN_EXIT1_RE.test(command)) return;
  step.failed++;
}

function addMark(state: TimelineState, mark: string): void {
  const step = openStepOf(state);
  if (step) addMarkTo(step, mark);
}

function addMarkTo(step: SessionStep, mark: string): void {
  step.marks = step.marks ?? [];
  if (!step.marks.includes(mark)) step.marks.push(mark);
}

/** The harness's own file ledger: exact paths, and (for Codex) exact operations. */
function applyFileChanges(state: TimelineState, event: SessionEvent): void {
  const changes = event.changes ?? [];
  if (!changes.length) return;
  for (const change of changes) {
    const prior = state.files[change.path];
    state.files[change.path] = {
      // A `created` claim, once made, survives a later `modified` on the same
      // path: the session did create that file.
      op: prior?.op === 'created' && change.op === 'modified' ? 'created' : change.op,
      edits: (prior?.edits ?? 0) + 1,
      at: event.timestamp,
      harness: true,
    };
  }
  const step = openStepOf(state);
  if (step) {
    addMarkTo(step, `${changes.length} file${changes.length === 1 ? '' : 's'} changed`);
    step.endedAt = event.timestamp;
  }
}

/** Fall back to the tool arguments for a harness that keeps no file ledger. */
function recordToolFile(state: TimelineState, event: SessionEvent, verb: SessionVerbClass): void {
  if (verb !== 'edit') return;
  const target = event.path ?? event.args?.file_path ?? event.args?.filePath ?? event.args?.path;
  if (typeof target !== 'string' || !target.startsWith('/')) return;
  const prior = state.files[target];
  // A create-style tool on a path nothing has touched yet CREATED it; anything
  // after that is a modification of what the session already made.
  const creates = event.tool === 'Write' || event.tool === 'write' || event.tool === 'write_file' || event.tool === 'WriteFile';
  state.files[target] = {
    op: prior?.op ?? (creates ? 'created' : 'modified'),
    edits: (prior?.edits ?? 0) + 1,
    at: event.timestamp,
    harness: prior?.harness ?? false,
  };
}

/** Give every `derived` step a headline from what it actually did. */
function derivedHeadline(step: SessionStep): string {
  const parts = Object.entries(step.mix ?? {})
    .filter(([, count]) => (count ?? 0) > 0)
    .sort((a, b) => (b[1] ?? 0) - (a[1] ?? 0))
    .map(([verb, count]) => VERB_PHRASES[verb as SessionVerbClass](count ?? 0));
  if (!parts.length) return 'Tool calls';
  const joined = parts.join(', ');
  return joined.charAt(0).toUpperCase() + joined.slice(1);
}

/** The activity values that mean the agent is mid-step, so the newest step is live. */
type TimelineActivity = string | undefined;

/** How {@link projectTimeline} scrubs the transcript text it is about to ship. */
interface ProjectTimelineOptions {
  /** Redact secrets from every projected string. Default true — see below. */
  redact?: boolean;
  /** Known credential values to mask verbatim; defaults to {@link knownSecretValuesFromEnv}. */
  knownSecrets?: readonly string[];
}

/**
 * Project the folded state onto the bounded shape that rides a session row.
 *
 * `keep` newest steps travel in full; everything older collapses into
 * `earlier`. The newest step is marked `live` while the session is working —
 * that is what the sidebar renders with the amber now-line, using the `now`
 * label the harness wrote for the call that is running.
 *
 * **This is the single place raw transcript text leaves the fold**, so it is
 * where scrubbing happens — every consumer (the session row, the git-tracked
 * fleet mirror `daemon-state.json`, and `sessions trace --steps`) is covered at
 * the source rather than each remembering to do it. Two passes, and they are
 * not the same thing:
 *
 *   - **Terminal escapes are ALWAYS stripped.** A transcript is untrusted input
 *     and these labels are printed to a terminal; `sanitizeEvents` never runs on
 *     the fold's parse path (only `tail.ts` / `stream-render.ts` call it), so
 *     this is the only place that scrub happens for a timeline.
 *   - **Secrets are redacted unless the caller opts out.** `redact` defaults to
 *     ON; only the local-only `--no-redact` path passes `redact: false`, and it
 *     buys exactly that — not raw control characters.
 */
export function projectTimeline(
  state: TimelineState,
  activity: TimelineActivity,
  keep: number = TIMELINE_KEEP_STEPS,
  options: ProjectTimelineOptions = {},
): SessionTimeline {
  const redact = options.redact !== false;
  // Resolved once per projection, not once per step: the env scan is the same
  // for every step in the fold.
  const knownSecrets = redact ? (options.knownSecrets ?? knownSecretValuesFromEnv()) : undefined;
  const scrub = (text: string): string =>
    sanitizeForTerminal(redact ? redactSecrets(text, knownSecrets) : text);

  // Copy each step, fill a derived headline, and drop the empty bookkeeping the
  // fold carries (`mix: {}`, `marks: []`) so the row payload stays small and a
  // consumer never has to distinguish "empty" from "absent".
  const steps: SessionStep[] = state.steps.map((step) => {
    const projected: SessionStep = {
      ...step,
      text: scrub(step.source === 'derived' && !step.text ? derivedHeadline(step) : step.text),
    };
    if (projected.now) projected.now = scrub(projected.now);
    if (projected.marks?.length) projected.marks = projected.marks.map(scrub);
    if (!projected.mix || Object.keys(projected.mix).length === 0) delete projected.mix;
    if (!projected.marks || projected.marks.length === 0) delete projected.marks;
    return projected;
  });

  const dropped = state.dropped ?? { steps: 0, tools: 0, failed: 0, blocked: 0 };
  const totals = steps.reduce(
    (acc, step) => ({
      tools: acc.tools + step.tools,
      failed: acc.failed + step.failed,
      blocked: acc.blocked + step.blocked,
    }),
    { tools: dropped.tools, failed: dropped.failed, blocked: dropped.blocked },
  );

  const cut = Math.max(0, steps.length - keep);
  const older = steps.slice(0, cut);
  const tail = steps.slice(cut);
  const newest = tail.length ? tail[tail.length - 1] : undefined;
  if (newest && activity === 'working') newest.live = true;
  // `now` is the label of the call RUNNING RIGHT NOW, so it is meaningful only
  // on the live step. `attachTool` sets it on every step as it folds; a finished
  // step keeping it made the sidebar render a now-line on completed work and
  // cost ~700 bytes a row.
  for (const step of tail) {
    if (!step.live || !step.now) delete step.now;
  }

  // A fold that produced no step has nothing to say, and `ready` with an empty
  // list would read as "the session did nothing". Say so instead — the contract
  // is "never an empty step list presented as nothing happened".
  if (!tail.length) {
    return {
      ...unavailableTimeline('no narration folded yet'),
      spanMs: state.firstMs !== null && state.lastMs !== null ? Math.max(0, state.lastMs - state.firstMs) : 0,
      ...(state.truncated ? { state: 'partial' as const, reason: 'transcript larger than one pass could fold' } : {}),
    };
  }

  return {
    steps: tail,
    earlier: {
      steps: older.length + dropped.steps,
      tools: older.reduce((n, step) => n + step.tools, dropped.tools),
      failed: older.reduce((n, step) => n + step.failed, dropped.failed),
    },
    tools: totals.tools,
    failed: totals.failed,
    blocked: totals.blocked,
    spanMs: state.firstMs !== null && state.lastMs !== null ? Math.max(0, state.lastMs - state.firstMs) : 0,
    state: state.truncated ? 'partial' : 'ready',
    ...(state.truncated ? { reason: 'transcript larger than one pass could fold' } : {}),
  };
}

/** The honest empty timeline for a harness that writes no parseable transcript. */
export function unavailableTimeline(reason: string): SessionTimeline {
  return {
    steps: [],
    earlier: { steps: 0, tools: 0, failed: 0 },
    tools: 0,
    failed: 0,
    blocked: 0,
    spanMs: 0,
    state: 'unavailable',
    reason,
  };
}

/**
 * Project the files the session changed. Bounded to `keep` rows, newest first,
 * with `total` reporting the real count.
 *
 * `source` reports where the OPERATIONS came from: `harness` when at least one
 * entry was written by the harness's own ledger (Codex `FileChange` carries
 * add/update/delete per path, OpenCode `patch` and Claude `file-history-delta`
 * carry the path set), `tools` when everything was derived from Edit/Write
 * arguments because the harness records no ledger at all.
 */
export function projectSessionFiles(state: TimelineState, keep: number = TIMELINE_KEEP_FILES): SessionFiles | undefined {
  const entries = Object.entries(state.files);
  if (!entries.length) return undefined;
  const changes: SessionFileChange[] = entries
    .map(([filePath, entry]) => ({ path: filePath, op: entry.op, edits: entry.edits, at: entry.at }))
    .sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
  return {
    changes: changes.slice(0, keep),
    total: changes.length + (state.filesDropped ?? 0),
    source: entries.some(([, entry]) => entry.harness) ? 'harness' : 'tools',
  };
}
