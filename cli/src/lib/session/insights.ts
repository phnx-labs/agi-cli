/**
 * Behavioural facets of a coding session, and the cross-session rollup built from them.
 *
 * This is the engine behind `agents insights`. It answers "how do you work" rather than
 * "what did you spend" (`agents insights cost`) or "what shipped" (`agents insights output`), and it is
 * the only surface that splits any of it by the account that produced the work.
 *
 * Everything here is a pure function of a parsed `SessionEvent[]`, so it is testable
 * without a database and cheap to re-run. The expensive part is parsing the transcript,
 * which is why results are cached per session in `session_insights` and recomputed only
 * when the file's (mtime, size) changes — the same staleness contract as `scan_ledger`.
 *
 * Prior art: Claude Code's own `/insights`, which computes a comparable set from
 * `~/.claude/projects` alone. Two deliberate differences:
 *
 *   - It sees ONE account's directory. This reads every indexed session, across every
 *     Claude account and every other harness, and reports them apart.
 *   - It collapses conversation branches before counting. agents-cli is file-per-session
 *     throughout (`discover.ts` keys on the transcript's basename), so session counts
 *     here will read slightly higher than `/insights` on the same machine. Reported as
 *     the raw file count rather than quietly differing.
 */

import type { SessionEvent } from './types.js';
import { computeSummaryStats, shortenModel } from './render.js';
import { classifyFileChanges, EDIT_TOOLS, WRITE_TOOLS } from './digest.js';
import { bucketKey } from './bash-command.js';

/** File extension → language label. Mirrors the set `/insights` attributes by. */
const LANGUAGE_BY_EXT: Record<string, string> = {
  '.ts': 'TypeScript', '.tsx': 'TypeScript', '.mts': 'TypeScript', '.cts': 'TypeScript',
  '.js': 'JavaScript', '.jsx': 'JavaScript', '.mjs': 'JavaScript', '.cjs': 'JavaScript',
  '.py': 'Python', '.go': 'Go', '.rs': 'Rust', '.rb': 'Ruby', '.java': 'Java',
  '.kt': 'Kotlin', '.swift': 'Swift', '.c': 'C', '.h': 'C', '.cc': 'C++', '.cpp': 'C++',
  '.hpp': 'C++', '.cs': 'C#', '.php': 'PHP', '.sh': 'Shell', '.bash': 'Shell',
  '.zsh': 'Shell', '.fish': 'Shell', '.sql': 'SQL', '.css': 'CSS', '.scss': 'CSS',
  '.html': 'HTML', '.vue': 'Vue', '.svelte': 'Svelte', '.md': 'Markdown',
  '.json': 'JSON', '.yaml': 'YAML', '.yml': 'YAML', '.toml': 'TOML',
};

/**
 * Tool-failure categories, matched in order against the result text (lowercased).
 * Substring rules, not judgement calls — the same shape `/insights` uses, so the
 * buckets stay comparable. First match wins; anything unmatched is "Other".
 */
const ERROR_CATEGORIES: ReadonlyArray<readonly [readonly string[], string]> = [
  [['string to replace not found', 'no changes to make'], 'Edit Failed'],
  [['has been modified since', 'modified since read'], 'File Changed'],
  [['exceeds maximum', 'too large', 'too long'], 'File Too Large'],
  [['file not found', 'does not exist', 'no such file'], 'File Not Found'],
  [['rejected', "doesn't want to proceed", 'user doesn’t want'], 'User Rejected'],
  [['exit code', 'command failed', 'error:'], 'Command Failed'],
];

/**
 * Gaps longer than this leave the reply-latency percentiles (someone left for
 * lunch / overnight). They still count as silent stalls when the assistant
 * was the last speaker — the agent had already stopped before the user left.
 */
const GAP_CEILING_SECONDS = 3600;

/**
 * Minimum quiet time after the assistant's last event before a user message
 * is classified as an **agent silent stall**: the model went quiet on its own
 * and sat idle until the human resumed. Shorter gaps are normal turn-taking.
 * 5 minutes is long enough to exclude "user typing the next instruction" and
 * short enough to catch "went silent mid-task until I said continue."
 */
const SILENT_STALL_SECONDS = 300;

/** Response-gap buckets, in ascending order. Upper bound is exclusive. */
const GAP_BUCKETS: ReadonlyArray<readonly [string, number]> = [
  ['<10s', 10], ['10-30s', 30], ['30s-1m', 60], ['1-2m', 120],
  ['2-5m', 300], ['5-15m', 900], ['15-60m', Infinity],
];

/** Silent-stall duration buckets (agent idle after its last event). */
const SILENT_STALL_BUCKETS: ReadonlyArray<readonly [string, number, number]> = [
  // label, min inclusive, max exclusive (Infinity = open)
  ['silent stall: 5-15m', 300, 900],
  ['silent stall: 15-60m', 900, 3600],
  ['silent stall: 1h+', 3600, Infinity],
];

/** Behavioural facets of one session. Serialized as JSON into `session_insights`. */
export interface InsightFacets {
  toolCounts: Record<string, number>;
  /** Per-model assistant turn counts. `/insights` has no model dimension at all. */
  models: Record<string, number>;
  /**
   * Silent stalls attributed to the model that last spoke before the idle gap
   * (from the nearest preceding `usage`/message model tag). Some models go
   * quiet more often — this is the laziness split. Key = shortened model id.
   */
  silentStallsByModel: Record<string, number>;
  languages: Record<string, number>;
  /** Slash commands the user invoked, by name. */
  slashCommands: Record<string, number>;
  errorCategories: Record<string, number>;
  /** Times the user cut a turn short — the `interrupt` event from parse.ts. */
  interruptions: number;
  /** Seconds between an assistant's last event and the user's next message. */
  responseGaps: number[];
  /** Gaps excluded for exceeding the ceiling — reported, never silently dropped. */
  gapsOverCeiling: number;
  /**
   * Lines in the BEFORE and AFTER text of every edit and write — "lines touched", not
   * a diff. An Edit whose old_string is three unchanged context lines counts them in
   * both; git counts them zero times. Measured against a real commit the added figure
   * ran 19% high and the removed figure 475% high, so this must never be rendered as
   * a diffstat. Computing a true delta needs a line-level diff per edit, which is a
   * different feature.
   */
  linesTouchedBefore: number;
  linesTouchedAfter: number;
  /**
   * Edit/write calls in a vocabulary we recognise. NOT a proxy for measurability:
   * codex renames `apply_patch` to `Edit` but carries no line-bearing arguments, so it
   * reports edit calls with zero lines. Callers decide "measurable" from the line
   * totals themselves.
   */
  editingToolCalls: number;
  filesCreated: number;
  filesModified: number;
  filesDeleted: number;
  gitCommits: number;
  gitPushes: number;
  /**
   * Tool calls that carried an actual command string to search. Not every harness
   * populates one: the codex parser sets `command` for `exec_command` but not for
   * plain `exec`, its dominant tool, so git activity is structurally invisible there.
   * 0 means the commit counts are unmeasurable, not observed-zero.
   */
  shellCommandsSeen: number;
  /** 24 slots, local time, indexed by hour of the user's messages. */
  messageHours: number[];
  userTurns: number;
  assistantTurns: number;
  toolCount: number;
  errorCount: number;
  /**
   * Shell invocations bucketed by the actual executable + first subcommand token, not
   * lumped under the harness tool name. `bucketKey` collapses each command to
   * `git commit`, `gh pr`, `agents ssh`, `find`, `ssh→git pull`, … so the tool mix says
   * which binary ran, not just that `Bash` did. Cross-harness: keyed on `e.command`,
   * which the codex parser sets for `exec_command` too, so it is not Claude-`Bash`-only.
   */
  bashCommands: Record<string, number>;
  /**
   * Same bucketing for the shell command that was running when a tool call failed —
   * turns one `failed tool loop: Bash` line into per-binary failure counts
   * (`git reconcile`, `find`, `gh`) so the friction is attributable to a command.
   */
  bashCommandFailures: Record<string, number>;
  /** Deterministic evidence buckets used by the actions-forward report. */
  frictionSignals: Record<string, number>;
  correctionSignals: Record<string, number>;
  automationSignals: Record<string, number>;
}

function emptyFacets(): InsightFacets {
  return {
    toolCounts: {}, models: {}, silentStallsByModel: {}, languages: {},
    slashCommands: {}, errorCategories: {},
    interruptions: 0, responseGaps: [], gapsOverCeiling: 0,
    linesTouchedBefore: 0, linesTouchedAfter: 0, editingToolCalls: 0,
    filesCreated: 0, filesModified: 0, filesDeleted: 0, gitCommits: 0, gitPushes: 0,
    shellCommandsSeen: 0,
    messageHours: new Array(24).fill(0), userTurns: 0, assistantTurns: 0,
    toolCount: 0, errorCount: 0,
    bashCommands: {}, bashCommandFailures: {},
    frictionSignals: {}, correctionSignals: {}, automationSignals: {},
  };
}

function bump(map: Record<string, number>, key: string, by = 1): void {
  map[key] = (map[key] ?? 0) + by;
}

/**
 * Lines in a string, 0 for empty. A trailing newline terminates the last line rather
 * than starting a new one, so `"a\nb\n"` is 2 — `split('\n').length` would say 3 and
 * over-count every newline-terminated Write by one.
 */
function lineCount(text: unknown): number {
  if (typeof text !== 'string' || text === '') return 0;
  const trimmed = text.endsWith('\n') ? text.slice(0, -1) : text;
  return trimmed.split('\n').length;
}

function categorizeError(text: string): string {
  const lower = text.toLowerCase();
  for (const [needles, label] of ERROR_CATEGORIES) {
    if (needles.some((n) => lower.includes(n))) return label;
  }
  return 'Other';
}

/**
 * Count invocations of a git subcommand in a shell command line.
 *
 * Matches `git commit`, `git -C /repo commit`, and the same again after a `&&`, `||`
 * or `;`, without trying to parse shell. The subcommand must be its own whitespace-
 * separated token, so `git-commit` (a different binary) does not count.
 *
 * Known limitation, shared with the `/insights` implementation this mirrors: a git
 * command quoted inside another command (`echo "run git commit later"`) still counts.
 * Distinguishing that needs a real shell parse, which is not worth it for a rollup.
 */
function countGitOp(command: string, op: string): number {
  const re = new RegExp(`(?:^|[\\s&|;(])git(?:\\s+[^\\s&|;]+)*?\\s+${op}\\b`, 'g');
  return (command.match(re) ?? []).length;
}

/**
 * Compute every behavioural facet of one session from its parsed events.
 *
 * Pure: no I/O, no clock, no filesystem. `timezoneOffsetMinutes` is injected rather
 * than read from the environment so the hour histogram is deterministic in tests and
 * can be re-bucketed for a different display timezone without re-parsing.
 */
export function computeInsightFacets(
  events: SessionEvent[],
  timezoneOffsetMinutes = new Date().getTimezoneOffset(),
): InsightFacets {
  const f = emptyFacets();
  const stats = computeSummaryStats(events);
  f.toolCounts = stats.toolCounts;
  f.userTurns = stats.userTurns;
  f.assistantTurns = stats.assistantTurns;
  f.toolCount = stats.toolCount;
  f.errorCount = stats.errorCount;

  const changes = classifyFileChanges(events);
  for (const c of changes) {
    if (c.op === 'created') f.filesCreated++;
    else if (c.op === 'modified') f.filesModified++;
    else f.filesDeleted++;
    const dot = c.path.lastIndexOf('.');
    if (dot > 0) {
      const lang = LANGUAGE_BY_EXT[c.path.slice(dot).toLowerCase()];
      if (lang) bump(f.languages, lang);
    }
  }

  // Response gap: assistant goes quiet, user speaks again.
  //
  // No lower bound. /insights drops gaps under 2s, which sounds harmless and is not:
  // measured over 782 real transcripts it censors 28.4% of the sample and inflates the
  // reported p50 by 63% (143s against a true 88s), because fast replies are common and
  // dropping them all shifts the median right. A 0-second reply is a real reply.
  //
  // The upper bound stays for *percentiles only*: past an hour the user often left the
  // desk, which is not "reply latency." Those gaps still feed silent-stall classification
  // (the agent had already stopped). `gapsOverCeiling` reports how many so percentiles
  // are never quietly truncated.
  //
  // Silent stall (agent idle): when the gap after the assistant's last event is long
  // enough that the model clearly stopped mid-session and waited for a human nudge
  // ("continue", "keep going", or any later message after minutes of silence). This is
  // the inverse framing of reply latency: same timestamps, attributed to the agent.
  let lastAssistantTs: number | null = null;
  /** Shortened model id of the last assistant activity (for stall attribution). */
  let lastAssistantModel: string | null = null;
  let lastFailedTool: string | null = null;
  // Most recent shell command seen per tool, so an `error` event (which carries the
  // failing tool name but not its command) can attribute the failure to a binary.
  const lastCommandByTool: Record<string, string> = {};

  for (const e of events) {
    const ts = new Date(e.timestamp).getTime();
    const hasTs = !Number.isNaN(ts);

    switch (e.type) {
      case 'interrupt':
        f.interruptions++;
        break;

      case 'usage':
        // shortenModel so the label matches `agents sessions <id>` and `insights mix`
        // rather than printing the raw id beside their shortened one.
        if (e.model) {
          const m = shortenModel(e.model);
          bump(f.models, m);
          // Usage rows are the reliable model tag for Claude turns; keep as
          // "last model" even when the timestamp is missing so a following
          // tool_use still attributes a stall correctly.
          lastAssistantModel = m;
        }
        break;

      case 'error': {
        bump(f.errorCategories, categorizeError(e.content ?? e.output ?? ''));
        if (e.tool && e.tool === lastFailedTool) bump(f.frictionSignals, `failed tool loop: ${e.tool}`);
        // Attribute the failure to the binary of that tool's most recent command,
        // so `Bash` failures split into `git reconcile`/`find`/`gh` rather than one lump.
        const failedCmd = e.tool ? lastCommandByTool[e.tool] : undefined;
        if (failedCmd) bump(f.bashCommandFailures, bucketKey(failedCmd));
        lastFailedTool = e.tool ?? null;
        classifyFriction(e.content ?? e.output ?? '', f.frictionSignals);
        break;
      }

      case 'tool_result':
        if (e.success !== false && e.outcome !== 'error') {
          lastFailedTool = null;
          // Drop the succeeded tool's remembered command so a later failing call that
          // carries no command of its own is not misattributed to this stale binary.
          if (e.tool) delete lastCommandByTool[e.tool];
        }
        break;

      case 'message':
        if (e.role === 'assistant') {
          if (hasTs) lastAssistantTs = ts;
          if (e.model) lastAssistantModel = shortenModel(e.model);
          break;
        }
        if (e.role !== 'user') break;
        // Synthetic user rows (stop-hook feedback, injected meta) are not a human
        // resume — skip correction/stall classification and leave lastAssistantTs so
        // the next real user message still measures the full idle gap.
        if (e._synthetic) break;
        classifyCorrection(e.content ?? '', f.correctionSignals);
        if (hasTs) {
          // Local-time hour. parse.ts falls back to `new Date()` for a record with no
          // timestamp; those are indistinguishable here, but they are rare and would
          // only smear the histogram toward the scan time, never invent a session.
          const local = new Date(ts - timezoneOffsetMinutes * 60_000);
          f.messageHours[local.getUTCHours()]++;
          if (lastAssistantTs !== null) {
            const gap = (ts - lastAssistantTs) / 1000;
            // >= 0 because clock skew between records can produce a negative gap
            // (one of -8.662s in a real corpus). Removing the old 2s floor removed
            // this guard with it; a negative reply latency is not a data point.
            if (gap >= 0 && gap < GAP_CEILING_SECONDS) f.responseGaps.push(gap);
            else if (gap >= GAP_CEILING_SECONDS) f.gapsOverCeiling++;
            // Agent silent stall: model stopped; session sat idle until this message.
            if (gap >= SILENT_STALL_SECONDS) {
              classifySilentStall(gap, e.content ?? '', f.frictionSignals, f.correctionSignals);
              bump(f.silentStallsByModel, lastAssistantModel ?? 'unknown');
            }
          }
        }
        lastAssistantTs = null;
        if (e.slashCommand) bump(f.slashCommands, e.slashCommand);
        break;

      case 'tool_use': {
        if (e._local) break;
        if (hasTs) lastAssistantTs = ts;
        if (e.model) lastAssistantModel = shortenModel(e.model);
        const args = e.args ?? {};
        const toolName = e.tool ?? '';
        if (/askuserquestion/i.test(toolName)) classifyAskStall(args, f.correctionSignals);
        // Keyed on the SHARED cross-harness vocabulary, not Claude's literals. Keying
        // on 'Edit'|'MultiEdit'|'Write' meant codex (whose vocabulary is exec /
        // exec_command / write_stdin) reported 5,197 tool calls and exactly zero lines
        // touched, rendered under the same column heading as a real number.
        if (EDIT_TOOLS.has(toolName)) {
          f.linesTouchedBefore += lineCount(args.old_string);
          f.linesTouchedAfter += lineCount(args.new_string);
          for (const edit of Array.isArray(args.edits) ? args.edits : []) {
            f.linesTouchedBefore += lineCount(edit?.old_string);
            f.linesTouchedAfter += lineCount(edit?.new_string);
          }
          f.editingToolCalls++;
        } else if (WRITE_TOOLS.has(toolName)) {
          f.linesTouchedAfter += lineCount(args.content);
          f.editingToolCalls++;
        }
        if (e.command) {
          f.shellCommandsSeen++;
          f.gitCommits += countGitOp(e.command, 'commit');
          f.gitPushes += countGitOp(e.command, 'push');
          classifyAutomation(e.command, f.automationSignals);
          bump(f.bashCommands, bucketKey(e.command));
          if (toolName) lastCommandByTool[toolName] = e.command;
        }
        break;
      }

      default:
        if (hasTs && e.role === 'assistant') lastAssistantTs = ts;
    }
  }

  return f;
}

const FRICTION_PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
  [/blocked by|guard(?:rail)? (?:blocked|denied)|permission denied/i, 'blocked guard'],
  [/\b(?:ci|check|workflow)\b.*\b(?:red|fail(?:ed|ure)?)\b|\b(?:red|failed)\b.*\bci\b/i, 'CI red loop'],
  [/merge conflict|conflict in |CONFLICT \(/i, 'merge conflict'],
];

const CORRECTION_PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
  [/\b(?:continue|keep going|don'?t stop)\b/i, 'continue / keep going'],
  [/\b(?:yes|go ahead|do it|merge it)\b/i, 'approval repeated'],
  [/\b(?:are we done|done end.to.end|what(?:'s| is) left)\b/i, 'done end-to-end?'],
  [/\b(?:did you merge|merged\??)\b/i, 'did you merge?'],
  [/\bwhat(?:'s| is) next\??\b/i, "what's next?"],
  [/\b(?:check now|check again|try now|did it work)\b/i, 'check now'],
  [/\b(?:don'?t ask|just do it|run what)\b/i, "don't ask / just do it"],
];

/** User text that is a pure resume nudge after the agent went silent. */
const RESUME_NUDGE_PATTERN =
  /\b(?:continue|keep going|don'?t stop|resume|pick up|you stopped|still there|wake up|hello\??|are you (?:there|stuck)|go on)\b/i;

/**
 * Classify a long quiet gap after the assistant's last event as an agent silent stall.
 * Optionally also marks an explicit resume nudge ("continue", …) after that silence.
 */
function classifySilentStall(
  gapSeconds: number,
  userText: string,
  friction: Record<string, number>,
  corrections: Record<string, number>,
): void {
  for (const [label, min, max] of SILENT_STALL_BUCKETS) {
    if (gapSeconds >= min && gapSeconds < max) {
      bump(friction, label);
      break;
    }
  }
  const normalized = userText.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  if (normalized && RESUME_NUDGE_PATTERN.test(normalized)) {
    bump(corrections, 'resume after silent stall');
  }
}

const AUTOMATION_PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
  [/\bgh pr (?:checks|view|merge)\b/i, 'PR babysitting'],
  [/\bagents secrets (?:list|exec|unlock|export)\b/i, 'secrets unlock dance'],
  [/\bgit (?:fetch|rebase|merge|push)\b/i, 'git reconcile recipe'],
  [/\b(?:scp|rsync|agents ssh)\b/i, 'fleet file transfer'],
  [/\b(?:release\.sh|deploy\.sh|npm publish)\b/i, 'release / deploy recipe'],
];

function classifyFriction(text: string, counts: Record<string, number>): void {
  for (const [pattern, label] of FRICTION_PATTERNS) if (pattern.test(text)) bump(counts, label);
}

function classifyCorrection(text: string, counts: Record<string, number>): void {
  const normalized = text.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  for (const [pattern, label] of CORRECTION_PATTERNS) if (pattern.test(normalized)) bump(counts, label);
}

function classifyAskStall(args: Record<string, unknown>, counts: Record<string, number>): void {
  const text = JSON.stringify(args).toLowerCase();
  const categories: ReadonlyArray<readonly [RegExp, string]> = [
    [/release|ship|deploy|publish/, 'Ask stall: release / ship / deploy'],
    [/what'?s next|next step|next move/, "Ask stall: what's next?"],
    [/merge|reconcile|rebase/, 'Ask stall: merge / reconcile'],
    [/direction|approach|implementation/, 'Ask stall: direction / approach'],
  ];
  for (const [pattern, label] of categories) {
    if (pattern.test(text)) { bump(counts, label); return; }
  }
  bump(counts, 'AskUserQuestion');
}

function classifyAutomation(command: string, counts: Record<string, number>): void {
  for (const [pattern, label] of AUTOMATION_PATTERNS) if (pattern.test(command)) bump(counts, label);
}

/** Percentile of a numeric sample, nearest-rank. Returns 0 for an empty sample. */
export function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}

/** Bucket response gaps for display. Returns every bucket, including empty ones. */
export function bucketGaps(gaps: number[]): Array<{ bucket: string; count: number }> {
  const out = GAP_BUCKETS.map(([bucket]) => ({ bucket, count: 0 }));
  for (const g of gaps) {
    for (let i = 0; i < GAP_BUCKETS.length; i++) {
      if (g < GAP_BUCKETS[i][1]) { out[i].count++; break; }
    }
  }
  return out;
}

/** A session's time span, for overlap detection. */
export interface SessionSpan {
  id: string;
  accountKey: string;
  startMs: number;
  endMs: number;
}

/** How much work ran concurrently, and how much of it straddled two accounts. */
interface OverlapReport {
  /** Pairs of sessions whose spans intersect. */
  overlappingPairs: number;
  /** Of those, pairs belonging to DIFFERENT accounts. */
  crossAccountPairs: number;
  /** Distinct sessions involved in any overlap. */
  sessionsInvolved: number;
}

/**
 * Detect concurrent sessions by interval intersection.
 *
 * This is the metric that makes the account split legible rather than academic: a
 * cross-account overlap is `balanced` rotation actively running two orgs' quota at the
 * same moment. `/insights` has a comparable "multi-clauding" count, but with one
 * account it can only ever report the same-account case.
 *
 * Sweep in start order, keeping only spans that could still intersect, so this is
 * O(n log n + pairs) rather than O(n^2) over ~3k sessions.
 */
export function detectOverlap(spans: SessionSpan[]): OverlapReport {
  const usable = spans
    .filter((s) => Number.isFinite(s.startMs) && Number.isFinite(s.endMs) && s.endMs > s.startMs)
    .sort((a, b) => a.startMs - b.startMs);

  let overlappingPairs = 0;
  let crossAccountPairs = 0;
  const involved = new Set<string>();
  const active: SessionSpan[] = [];

  for (const span of usable) {
    // Drop spans that ended before this one started; they cannot intersect it or
    // anything after it.
    for (let i = active.length - 1; i >= 0; i--) {
      if (active[i].endMs <= span.startMs) active.splice(i, 1);
    }
    for (const other of active) {
      overlappingPairs++;
      if (other.accountKey !== span.accountKey) crossAccountPairs++;
      involved.add(other.id);
      involved.add(span.id);
    }
    active.push(span);
  }

  return { overlappingPairs, crossAccountPairs, sessionsInvolved: involved.size };
}

/** Merge a session's facets into a running total. */
export function mergeFacets(into: InsightFacets, add: InsightFacets): void {
  for (const [k, v] of Object.entries(add.toolCounts)) bump(into.toolCounts, k, v);
  for (const [k, v] of Object.entries(add.models)) bump(into.models, k, v);
  for (const [k, v] of Object.entries(add.silentStallsByModel ?? {})) bump(into.silentStallsByModel, k, v);
  for (const [k, v] of Object.entries(add.languages)) bump(into.languages, k, v);
  for (const [k, v] of Object.entries(add.slashCommands)) bump(into.slashCommands, k, v);
  for (const [k, v] of Object.entries(add.errorCategories)) bump(into.errorCategories, k, v);
  for (const [k, v] of Object.entries(add.bashCommands ?? {})) bump(into.bashCommands, k, v);
  for (const [k, v] of Object.entries(add.bashCommandFailures ?? {})) bump(into.bashCommandFailures, k, v);
  for (const [k, v] of Object.entries(add.frictionSignals ?? {})) bump(into.frictionSignals, k, v);
  for (const [k, v] of Object.entries(add.correctionSignals ?? {})) bump(into.correctionSignals, k, v);
  for (const [k, v] of Object.entries(add.automationSignals ?? {})) bump(into.automationSignals, k, v);
  into.interruptions += add.interruptions;
  into.responseGaps.push(...add.responseGaps);
  into.gapsOverCeiling += add.gapsOverCeiling;
  into.linesTouchedBefore += add.linesTouchedBefore;
  into.linesTouchedAfter += add.linesTouchedAfter;
  into.editingToolCalls += add.editingToolCalls;
  into.filesCreated += add.filesCreated;
  into.filesModified += add.filesModified;
  into.filesDeleted += add.filesDeleted;
  into.gitCommits += add.gitCommits;
  into.gitPushes += add.gitPushes;
  into.shellCommandsSeen += add.shellCommandsSeen;
  into.userTurns += add.userTurns;
  into.assistantTurns += add.assistantTurns;
  into.toolCount += add.toolCount;
  into.errorCount += add.errorCount;
  for (let i = 0; i < 24; i++) into.messageHours[i] += add.messageHours[i];
}

/** A fresh zeroed accumulator, for callers folding many sessions together. */
export function newFacetAccumulator(): InsightFacets {
  return emptyFacets();
}

/** Top-N entries of a count map, highest first, ties broken by name for determinism. */
export function topEntries(
  counts: Record<string, number>,
  limit: number,
): Array<{ name: string; count: number }> {
  return Object.entries(counts)
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
    .slice(0, limit);
}

export type InsightActionCategory = 'rule' | 'skill' | 'automation' | 'product';

export interface InsightAction {
  priority: 'high' | 'medium' | 'low';
  category: InsightActionCategory;
  action: string;
  evidenceCount: number;
  sampleSessionIds: string[];
}

interface SessionFacetEvidence {
  id: string;
  facets: InsightFacets;
}

/** Build a stable, evidence-backed action list without exposing transcript text. */
export function buildInsightActions(sessions: SessionFacetEvidence[]): InsightAction[] {
  const specs: Array<{
    source: keyof Pick<InsightFacets, 'frictionSignals' | 'correctionSignals' | 'automationSignals'>;
    label: string;
    category: InsightActionCategory;
    action: string;
  }> = [
    { source: 'correctionSignals', label: 'continue / keep going', category: 'rule', action: 'Keep working through the delivery chain without waiting for another “continue”.' },
    { source: 'correctionSignals', label: 'resume after silent stall', category: 'rule', action: 'Never stop mid-task waiting for a human ping — finish the current goal or park with an explicit blocker; keep driving CI/review/merge without going idle.' },
    { source: 'correctionSignals', label: 'approval repeated', category: 'rule', action: 'Treat the original build or ship request as authorization for routine follow-through.' },
    { source: 'correctionSignals', label: 'done end-to-end?', category: 'rule', action: 'Verify the user-visible outcome before declaring the task complete.' },
    { source: 'correctionSignals', label: 'did you merge?', category: 'automation', action: 'Automate PR review, CI watching, and merge-on-green as one durable workflow.' },
    { source: 'correctionSignals', label: "what's next?", category: 'rule', action: 'State and execute the next in-scope step instead of asking the owner to steer implementation.' },
    { source: 'correctionSignals', label: 'check now', category: 'automation', action: 'Add bounded status polling with a terminal success or failure signal.' },
    { source: 'correctionSignals', label: "don't ask / just do it", category: 'rule', action: 'Reserve questions for genuine product or scope choices.' },
    { source: 'correctionSignals', label: 'Ask stall: release / ship / deploy', category: 'skill', action: 'Teach release workflows to carry publish, tag, rollout, and live verification as one chain.' },
    { source: 'correctionSignals', label: "Ask stall: what's next?", category: 'rule', action: 'Remove workflow-stall “what next?” prompts from agent guidance.' },
    { source: 'correctionSignals', label: 'Ask stall: merge / reconcile', category: 'skill', action: 'Encode the safe merge and reconcile path in the git workflow skill.' },
    { source: 'correctionSignals', label: 'Ask stall: direction / approach', category: 'rule', action: 'Let agents choose implementation details after scope is clear.' },
    { source: 'frictionSignals', label: 'silent stall: 5-15m', category: 'rule', action: 'Stop ending turns while work remains open — after a tool batch, take the next step or schedule a real background wait that re-invokes you; do not sit idle until the user says continue.' },
    { source: 'frictionSignals', label: 'silent stall: 15-60m', category: 'rule', action: 'Long idle after the assistant last spoke is an agent stop, not a user pause — drive open PRs/CI/todos to completion or name a true external blocker instead of going silent.' },
    { source: 'frictionSignals', label: 'silent stall: 1h+', category: 'rule', action: 'Sessions that sit idle for an hour+ after the model stops are stranded work — use stop-gates, background watches, and queue drain so a human is not the only resume signal.' },
    { source: 'frictionSignals', label: 'blocked guard', category: 'product', action: 'Make guard failures return the safe next command and exact blocked operation.' },
    { source: 'frictionSignals', label: 'CI red loop', category: 'automation', action: 'Deduplicate CI watchers and turn repeated red checks into one stateful wait.' },
    { source: 'frictionSignals', label: 'merge conflict', category: 'skill', action: 'Standardize conflict diagnosis and fix-forward reconciliation.' },
    { source: 'automationSignals', label: 'PR babysitting', category: 'automation', action: 'Bundle PR checks, review collection, comment handling, and merge-on-green.' },
    { source: 'automationSignals', label: 'secrets unlock dance', category: 'product', action: 'Provide one headless secrets-backed command path for repeated credential operations.' },
    { source: 'automationSignals', label: 'git reconcile recipe', category: 'skill', action: 'Promote repeated git reconciliation commands into the canonical workflow.' },
    { source: 'automationSignals', label: 'fleet file transfer', category: 'product', action: 'Add a first-class fleet file transfer command with host/path validation.' },
    { source: 'automationSignals', label: 'release / deploy recipe', category: 'automation', action: 'Turn repeated release shell recipes into a checked-in release script.' },
  ];

  const actions: InsightAction[] = [];
  for (const spec of specs) {
    let evidenceCount = 0;
    const ids: string[] = [];
    for (const session of sessions) {
      const count = session.facets[spec.source]?.[spec.label] ?? 0;
      if (count <= 0) continue;
      evidenceCount += count;
      if (ids.length < 3) ids.push(session.id.slice(0, 8));
    }
    if (evidenceCount === 0) continue;
    actions.push({
      priority: evidenceCount >= 10 ? 'high' : evidenceCount >= 3 ? 'medium' : 'low',
      category: spec.category,
      action: spec.action,
      evidenceCount,
      sampleSessionIds: ids,
    });
  }
  let failedLoopCount = 0;
  const failedLoopIds: string[] = [];
  for (const session of sessions) {
    const count = Object.entries(session.facets.frictionSignals ?? {})
      .filter(([label]) => label.startsWith('failed tool loop:'))
      .reduce((sum, [, value]) => sum + value, 0);
    if (count <= 0) continue;
    failedLoopCount += count;
    if (failedLoopIds.length < 3) failedLoopIds.push(session.id.slice(0, 8));
  }
  if (failedLoopCount > 0) {
    actions.push({
      priority: failedLoopCount >= 10 ? 'high' : failedLoopCount >= 3 ? 'medium' : 'low',
      category: 'automation',
      action: 'Detect repeated failures of the same tool and stop the retry loop with a different recovery path.',
      evidenceCount: failedLoopCount,
      sampleSessionIds: failedLoopIds,
    });
  }
  return actions.sort((a, b) => b.evidenceCount - a.evidenceCount || a.action.localeCompare(b.action));
}
