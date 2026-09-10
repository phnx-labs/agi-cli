/**
 * Session state inference.
 *
 * Turns a chronological slice of normalized `SessionEvent`s (typically the tail
 * of a transcript) plus lightweight context (file mtime, cwd, branch, whether
 * the owning process is alive) into a `SessionState`: is the agent working,
 * waiting on the user, or idle — and did it open a PR, is it in a worktree, is
 * it tied to a tracker ticket. Pure functions, no I/O, so the whole thing is
 * unit-testable and shared by both the live `--active` path and the incremental
 * scanner (which persists the durable signals to the index).
 *
 * Structural signals are preferred over prose heuristics: Claude's
 * `ExitPlanMode` / `AskUserQuestion` tool calls are exact "waiting on you"
 * markers. Codex has no such tools, so it falls back to last-role + question
 * shape + mtime — same function, driven off the normalized events.
 */

import * as path from 'path';
import type { SessionAttachment, SessionEvent, TodoItem, TodoProgress } from './types.js';
import { isCompletedTodoStatus, SNAPSHOT_TODO_TOOLS, summarizeToolUse } from './parse.js';
import { isShellExecTool } from './shell-programs.js';
import { classifyFileChanges } from './digest.js';
import { extractArtifacts, type ProducedArtifact } from './highlights.js';
import { LINEAR_KEY_DENYLIST, linearIssueKeys } from './linear.js';

// TodoItem / TodoProgress moved to ./types.ts so SessionMeta can carry `todos`
// without a state↔types import cycle; re-exported here for existing importers.
export type { TodoItem, TodoProgress };

export type SessionActivity = 'working' | 'waiting_input' | 'idle';
/**
 * Why a session is `waiting_input`. The state engine produces `question` and
 * `plan_review` from transcript structure. `permission` is NOT inferred from a
 * transcript any more (PHNX-3999): a tool call with no result looks the same
 * whether the tool is still running or a permission dialog is up, and only the
 * harness's own `permission_prompt` hook event (the feed block) can tell them
 * apart. The value stays in the union because a row from a peer running an older
 * CLI can still carry it; the attention reconciler treats such a row as an
 * unverified claim, never as an approvable request.
 */
export type AwaitingReason = 'question' | 'plan_review' | 'permission';

/** One discrete choice the agent offered the user. */
export interface QuestionOption {
  /** The choice label — also what a free-text reply channel sends back. */
  label: string;
  /** Optional longer description shown under the label. */
  description?: string;
  /**
   * Selection keystroke for an interactive TUI prompt (AskUserQuestion / plan /
   * permission are select-lists, not text inputs): a digit ('1'), or 'esc' to
   * cancel/deny. Absent for a plain prose question, which takes free text.
   */
  key?: string;
}

/**
 * The decision an agent handed back to the user, extracted at the SOURCE so every
 * consumer (Factory panel, teams, cloud) gets the real question + options instead
 * of re-deriving them from a truncated preview line. `reason` mirrors
 * {@link AwaitingReason}; `options` is present when the agent offered discrete choices.
 */
export interface StructuredQuestion {
  text: string;
  reason: AwaitingReason;
  options?: QuestionOption[];
}

export interface DetectedPr {
  url: string;
  number?: number;
}
export interface DetectedWorktree {
  /** Absolute worktree path (the session cwd). */
  path: string;
  /** The `<slug>` under `.agents/worktrees/`. */
  slug: string;
  branch?: string;
}
export interface DetectedTicket {
  /** Tracker key, e.g. `RUSH-1234`. */
  id: string;
  url?: string;
}

/**
 * Detect per-session rate-limit / usage-limit signals in assistant or error
 * text (RUSH-1523). Matches the same shapes the ext's prewarm detectBlockingPrompt
 * uses, plus common Claude/Codex/Gemini limit strings.
 */
export function detectRateLimited(text?: string): boolean {
  if (!text) return false;
  const t = text.toLowerCase();
  return (
    /\brate[- ]?limit(ed|s)?\b/.test(t) ||
    /\btoo many requests\b/.test(t) ||
    /\b429\b/.test(t) ||
    /\busage[- ]?limit(ed)?\b/.test(t) ||
    /\bhit your (usage |rate )?limit\b/.test(t) ||
    /\byou('ve| have) (hit|reached|exceeded) (your |the )?(rate |usage )?limit\b/.test(t) ||
    /\bout of (credits|quota)\b/.test(t) ||
    /\bquota exceeded\b/.test(t) ||
    /\btry again (in|later|after)\b/.test(t) && /\b(limit|rate|quota|throttl)\b/.test(t)
  );
}

export interface SessionState {
  activity: SessionActivity;
  awaitingReason?: AwaitingReason;
  lastRole?: 'user' | 'assistant';
  lastEventKind?: SessionEvent['type'];
  /** Single-line description of the latest turn (message text or tool action). */
  preview?: string;
  /**
   * True when the transcript shows the session is rate/usage limited (RUSH-1523).
   * Distinct from account-level usageStatus — this is per-session evidence.
   */
  rateLimited?: boolean;
  /**
   * The structured decision the agent is waiting on (question / plan / permission),
   * with its options when it offered any. Set only when activity is waiting_input.
   */
  question?: StructuredQuestion;
  /**
   * The plan markdown from the most recent `ExitPlanMode` tool call, surfaced
   * when `awaitingReason === 'plan_review'`. The state engine detects the
   * handoff off the same tool event; carrying the plan text alongside it lets
   * consumers (the Factory NEEDS-YOU panel, `agents sessions <id> --json`)
   * render the actual plan without re-parsing the transcript.
   */
  plan?: string;
  /**
   * Live plan progress from the most recent `TodoWrite` (RUSH-1380). Present when
   * the session has written a todo list; drives the Fleet N/M pill +
   * checklist, notably for remote/device-dispatched agents with no local stream.
   */
  todos?: TodoProgress;
  /** Durable documents created in the bounded transcript slice. */
  artifacts?: ProducedArtifact[];
  /** First created plan document, for consumers that give plans special treatment. */
  planFile?: string;
  /** Last few assistant turns (most-recent last), one line each — panel context. */
  tail?: string[];
  lastActivityMs?: number;
  /**
   * Timestamp (ms) of the last meaningful transcript event — a message, tool
   * call, tool result, thinking block, or error — when the harness stamped one
   * (PHNX-3999). This is the transcript's own cursor: unlike the file mtime it does
   * not move when the harness appends a hook-firing record or other bookkeeping
   * line, so it is the evidence that the agent did (or did not) work past a given
   * moment — what the attention reconciler compares a hook-raised prompt against.
   */
  lastEventMs?: number;
  pr?: DetectedPr;
  worktree?: DetectedWorktree;
  ticket?: DetectedTicket;
  /** Tracker refs this session CREATED (Linear create_issue / gh issue create). */
  createdTickets?: string[];
  /** Team name this session SPAWNED via `agents teams create/add`. */
  spawnedTeam?: string;
  /** Displayable files/screenshots attached to the session prompt. */
  attachments?: SessionAttachment[];
}

export interface StateContext {
  /** Session file mtime; drives running-vs-stale. */
  mtimeMs?: number;
  cwd?: string;
  gitBranch?: string;
  /** Whether the owning OS process is alive (from the active scanner). */
  pidAlive?: boolean;
  /** Override the running window (defaults to 2 min, matching active.ts). */
  activeWindowMs?: number;
  /**
   * The clock every elapsed-time signal is measured against (default `Date.now()`).
   * Injected so a cached parse can be re-classified against the CURRENT time — a
   * time-based verdict (the prose-question decay) must expire even when the
   * transcript bytes have not changed (PHNX-3999).
   */
  nowMs?: number;
}

/** A healthy live session writes several times a minute; 2 min ⇒ "recently active". */
const ACTIVE_WINDOW_MS = 2 * 60_000;

/**
 * A prose trailing question ("…?") is a HEURISTIC, so it decays: past this long
 * with no session writes it stops classifying as waiting_input — otherwise a
 * finished session that signed off with "anything else?" reads as needing input
 * forever (RUSH-1522). The structural ExitPlanMode / AskUserQuestion signals are
 * exempt: they are precise, still-unanswered decisions.
 */
const PROSE_QUESTION_FRESH_MS = 30 * 60_000;

/** Claude tool names that structurally mean "the agent handed control back to you". */
const PLAN_TOOL = 'ExitPlanMode';
const ASK_TOOL = 'AskUserQuestion';

const TASK_CREATE_TOOL = 'TaskCreate';
const TASK_UPDATE_TOOL = 'TaskUpdate';

/**
 * Derive live plan progress from a checklist tool call's args. Accepts Claude's
 * `TodoWrite` (`todos: [{content,status,activeForm}]`), Kimi's `TodoList`
 * (`todos: [{title,status}]`, where finished is `done` rather than `completed`)
 * and Codex's `update_plan` (`plan: [{step,status}]`) shapes, so the CLI is the
 * single source of checklist state for every agent. Returns undefined when there
 * is no usable list, so a session with no plan carries no `todos` field.
 */
export function extractTodoProgress(args?: Record<string, any>): TodoProgress | undefined {
  const input = args?.input && typeof args.input === 'object' ? args.input : args;
  const raw = Array.isArray(input?.todos)
    ? input.todos
    : Array.isArray(input?.plan)
      ? input.plan
      : undefined;
  if (!Array.isArray(raw) || raw.length === 0) return undefined;
  const items: TodoItem[] = [];
  for (const t of raw) {
    const activeForm = typeof t?.activeForm === 'string' && t.activeForm ? t.activeForm : undefined;
    const content =
      typeof t?.content === 'string' && t.content
        ? t.content
        : typeof t?.text === 'string' && t.text
          ? t.text
          : typeof t?.step === 'string' && t.step
            ? t.step
            : typeof t?.title === 'string' && t.title
              ? t.title
              : activeForm ?? '';
    if (!content) continue;
    const status: TodoItem['status'] = isCompletedTodoStatus(t?.status)
      ? 'completed'
      : t?.status === 'in_progress'
        ? 'in_progress'
        : 'pending';
    const description = typeof t?.description === 'string' && t.description ? t.description : undefined;
    items.push({ content, status, ...(description ? { description } : {}), ...(activeForm ? { activeForm } : {}) });
  }
  if (items.length === 0) return undefined;
  const done = items.filter(i => i.status === 'completed').length;
  const inProgress = items.find(i => i.status === 'in_progress');
  return {
    items,
    done,
    total: items.length,
    activeForm: inProgress ? inProgress.activeForm ?? inProgress.content : undefined,
  };
}

/** Fold snapshot checklist tools and Claude TaskCreate/TaskUpdate event logs. */
export function extractTodoProgressFromEvents(events: SessionEvent[]): TodoProgress | undefined {
  let items: Array<Record<string, any>> = [];
  let nextTaskId = 1;
  let sawChecklist = false;
  for (const event of events) {
    if (event.type !== 'tool_use') continue;
    const args = event.args ?? {};
    if (SNAPSHOT_TODO_TOOLS.has(event.tool ?? '')) {
      const input = args.input && typeof args.input === 'object' ? args.input : args;
      const raw = Array.isArray(input.todos) ? input.todos : Array.isArray(input.plan) ? input.plan : undefined;
      if (raw) {
        items = raw.map((item: any) => ({ ...item }));
        sawChecklist = true;
      }
      continue;
    }
    if (event.tool === TASK_CREATE_TOOL) {
      const content = args.subject || args.description;
      if (typeof content !== 'string' || !content.trim()) continue;
      items.push({
        taskId: String(nextTaskId++),
        content: content.trim(),
        description: typeof args.description === 'string' ? args.description : undefined,
        activeForm: typeof args.activeForm === 'string' ? args.activeForm : undefined,
        status: 'pending',
      });
      sawChecklist = true;
      continue;
    }
    if (event.tool === TASK_UPDATE_TOOL) {
      const taskId = String(args.taskId ?? args.task_id ?? '');
      const index = items.findIndex(item => String(item.taskId ?? '') === taskId);
      if (index < 0) continue;
      if (args.status === 'deleted') {
        items.splice(index, 1);
        continue;
      }
      const prior = items[index];
      items[index] = {
        ...prior,
        ...(typeof args.subject === 'string' ? { content: args.subject } : {}),
        ...(typeof args.description === 'string' ? { description: args.description } : {}),
        ...(typeof args.activeForm === 'string' ? { activeForm: args.activeForm } : {}),
        ...(typeof args.status === 'string' ? { status: args.status } : {}),
      };
    }
  }
  return sawChecklist ? extractTodoProgress({ todos: items }) : undefined;
}

/** Derive a recency-ordered, de-duplicated list of directories touched by tools. */
export function extractRecentDirectoriesTouched(events: SessionEvent[], cwd?: string): string[] | undefined {
  const dirs: string[] = [];
  const add = (value: unknown, file = false) => {
    if (typeof value !== 'string' || !value.trim()) return;
    const resolved = path.isAbsolute(value) ? value : path.resolve(cwd || process.cwd(), value);
    const dir = file ? path.dirname(resolved) : resolved;
    const old = dirs.indexOf(dir);
    if (old >= 0) dirs.splice(old, 1);
    dirs.push(dir);
  };
  for (const event of events) {
    if (event.type !== 'tool_use') continue;
    const tool = event.tool ?? '';
    const args = event.args ?? {};
    if (['Edit', 'Write', 'edit_file', 'write_file', 'create_file', 'edit', 'write'].includes(tool)) {
      add(args.file_path ?? args.filePath ?? args.path ?? event.path, true);
    } else if (isShellExecTool(tool)) {
      add(args.cwd ?? args.Cwd ?? args.workdir ?? args.working_directory ?? cwd);
    }
  }
  return dirs.length ? dirs.slice(-10) : undefined;
}

/** Trailing '?' or a leading interrogative — a question aimed at the user. */
const QUESTION_TRAILING = /\?["'”)\]]?\s*$/;
const QUESTION_PHRASE =
  /\b(shall i|should i|do you want|would you like|which (?:one|option|approach|of)|can you (?:confirm|clarify)|please (?:confirm|clarify|advise)|let me know|are you (?:ok|okay|sure)|proceed\?)\b/i;

/**
 * Linear/Jira-style ref detection reuses the canonical key matcher +
 * {@link LINEAR_KEY_DENYLIST} from `./linear.js`, so the transcript detector and
 * the owner-ping linkifier agree on what a real key is (no second copy to drift).
 */
/** Lowercase branch form (Linear branch names): muqsit/rush-1234-fix. */
const TICKET_BRANCH_RE = /(?:^|[/_-])([a-z]{2,6})-(\d{2,6})(?=[/_-]|$)/;

const PR_URL_RE = /https:\/\/github\.com\/[^\s"'()<>]+\/pull\/(\d+)/;
// Either separator: a Windows session cwd is `…\.agents\worktrees\<slug>`, and a
// forward-slash-only pattern silently derived no slug there (the RUSH-2358
// worktree_slug parity test is red on the Windows CI leg for exactly this).
export const WORKTREE_RE = /[\\/]\.agents[\\/]worktrees[\\/]([^\\/]+)/;
/** gh invocations that create/open a PR. */
const GH_PR_CREATE_RE = /\bgh\s+pr\s+(?:create|new)\b/;
/** gh invocation that opens an issue — the created number is read from its result. */
const GH_ISSUE_CREATE_RE = /\bgh\s+issue\s+create\b/;
/** A created GitHub issue URL (…/issues/123) in tool-result output. */
const GH_ISSUE_URL_RE = /https:\/\/github\.com\/[^\s"'()<>]+\/issues\/(\d+)/;
/**
 * Flags of `teams create` / `teams add` that take a value, so the value is not
 * mistaken for the positional team name. Mirrors their value-taking flags in
 * `commands/teams.ts` — most are `.option('… <x>')` registrations, but
 * `--device` comes from `addHostOption`, so auditing this list against
 * `.option(` alone would wrongly drop it. A flag missing here degrades to "no
 * team detected", never to a wrong one.
 */
const TEAM_VALUE_FLAGS = [
  '-d', '--description', '--use-worktree', '--devices', '--hosts', '--repo',
  '-n', '--name', '-m', '--mode', '-e', '--effort', '--model', '--env',
  '--cwd', '--worktree', '--after', '--task-type', '--cloud', '--branch',
  '--device',
];

/**
 * One flag value: a quoted string or a bare token. `-d "sessions lineage"` is the
 * common shape — `--description` is usually a phrase — and a value pattern of
 * `\S+` alone stops at the first space, leaving the rest of the phrase to be read
 * as the positional team name (`… -d "sessions lineage" my-team` detected
 * `lineage`). Quotes are matched as a unit so the whole value is consumed.
 *
 * A value containing an ESCAPED quote (`-d "say \"hi\" now"`) stops the quoted
 * branch early and the match then fails outright — which is the intended failure
 * direction: no team detected rather than a wrong one.
 */
const FLAG_VALUE = String.raw`(?:"[^"\n]*"|'[^'\n]*'|\S+)`;

/**
 * `agents teams create <name>` / `agents teams add <team> …` (also the `ag` alias).
 * The team NAME is the first bareword after the sub-verb, skipping any flags. This
 * is the structural signal that a session SPAWNED a team (vs. was spawned by one).
 *
 * The separators are spaces/tabs, never `\s`: a command string routinely embeds
 * documentation and quoted output, and `\s` let the flag-skip run across newlines
 * to capture a word from a completely different line (a real scan produced
 * `team:installed` from a heredoc). For the same reason the flag-skip is bounded
 * rather than unlimited — a real invocation carries a handful of flags before the
 * name, not dozens.
 */
const TEAMS_SPAWN_RE = new RegExp(
  // Start of an actually-executed command: string start, a newline, or a shell
  // separator. Without this, a backticked mention inside prose or tool output
  // ("… and `agents teams add --device auto`") reads as a spawn.
  String.raw`(?:^|[\n;&|(]|&&|\|\|)[ \t]*` +
    String.raw`ag(?:ents)?[ \t]+teams?[ \t]+(?:create|add)[ \t]+` +
    // Flags before the positional name. A value-taking flag must swallow its
    // value, or `--device auto` leaves `auto` looking like the team name — and
    // the generic branch must exclude those flags, or it swallows the flag alone
    // and hands the value back as the name.
    String.raw`(?:(?:${TEAM_VALUE_FLAGS.join('|')})[= \t]${FLAG_VALUE}[ \t]+` +
    String.raw`|(?!(?:${TEAM_VALUE_FLAGS.join('|')})[= \t])--?[a-z][\w-]*(?:=\S+)?[ \t]+){0,6}` +
    // A team name may start with a digit — `createTeam` validates nothing, and
    // `2fa-migration` is a legal name — so the class stays [A-Za-z0-9]. The
    // all-digits case is rejected in the guard below instead.
    String.raw`([A-Za-z0-9][\w-]*)`
);

/**
 * Sub-verbs that can follow `teams create|add` in prose ("teams add a teammate")
 * but are never a team name. Guards the common case where the match came from a
 * sentence rather than an executed command.
 */
const NON_TEAM_WORDS = new Set(['a', 'an', 'the', 'to', 'for', 'with', 'and', 'this', 'your', 'my', 'it']);

/** Collapse to a single trimmed line for a one-row preview cell. */
function oneLine(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

/** Detect a worktree from the session cwd, per the `.agents/worktrees/<slug>/` convention. */
export function detectWorktree(cwd?: string, branch?: string): DetectedWorktree | undefined {
  if (!cwd) return undefined;
  const m = cwd.match(WORKTREE_RE);
  if (!m) return undefined;
  return { path: cwd, slug: m[1], branch: branch || undefined };
}

/** Detect a tracker ticket from free text (prompt/topic) then a branch name. */
export function detectTicket(text?: string, branch?: string): DetectedTicket | undefined {
  if (text) {
    const key = linearIssueKeys(text)[0];
    if (key) return { id: key };
  }
  if (branch) {
    const m = branch.match(TICKET_BRANCH_RE);
    if (m) {
      const key = m[1].toUpperCase();
      if (!LINEAR_KEY_DENYLIST.has(key)) return { id: `${key}-${m[2]}` };
    }
  }
  return undefined;
}

/** Pull a PR URL + number out of tool-result output text. */
export function extractPrUrl(output?: string): DetectedPr | undefined {
  if (!output) return undefined;
  const m = output.match(PR_URL_RE);
  if (!m) return undefined;
  return { url: m[0], number: Number.parseInt(m[1], 10) };
}

/** True when a Bash/exec command string is a `gh pr create`. */
export function isPrCreateCommand(command?: string): boolean {
  return !!command && GH_PR_CREATE_RE.test(command);
}

/**
 * The team a session SPAWNED, from an `agents teams create/add <name>` command.
 * Returns the team name, or undefined if the command isn't a team spawn. Note this
 * is the opposite of `isTeamOrigin` (which marks sessions spawned BY a team).
 */
export function detectSpawnedTeam(command?: string): string | undefined {
  if (!command) return undefined;
  const m = command.match(TEAMS_SPAWN_RE);
  if (!m) return undefined;
  const name = m[1];
  // A single character is a doc placeholder (`agents teams create t --device <box>`)
  // far more often than a real team, and an English article is prose. Both used to
  // land in the index as a team name, and now that the name is rendered on the row
  // a wrong one is worse than none.
  // A single character is a doc placeholder (`agents teams create t --device <name>`)
  // far more often than a real team; an all-digits token is a flag value or a list
  // index that leaked through, never a name someone typed. Both had reached the
  // index, and now that the name is rendered a wrong one is worse than none.
  if (name.length < 2 || /^\d+$/.test(name) || NON_TEAM_WORDS.has(name.toLowerCase())) return undefined;
  return name;
}

/**
 * True when a tool_use call CREATES a tracker ticket — a Linear MCP `create_issue`
 * tool, or a Bash `gh issue create`. The created id is then read from the matching
 * tool_result via {@link extractCreatedTicket}.
 */
export function isTicketCreateTool(name?: string, command?: string): boolean {
  if (typeof name === 'string' && /linear/i.test(name) && /create[_-]?issue/i.test(name)) return true;
  // Any shell tool (Bash / shell / local_shell) running `gh issue create`.
  if (!!command && GH_ISSUE_CREATE_RE.test(command)) return true;
  return false;
}

/**
 * Pull a created ticket ref out of a create-issue tool_result. Linear returns a
 * key like `RUSH-1234`; `gh issue create` returns the issue URL, from which we
 * take `#<number>`. Returns undefined when neither shape is present.
 */
export function extractCreatedTicket(text?: string): string | undefined {
  if (!text) return undefined;
  const lin = linearIssueKeys(text)[0];
  if (lin) return lin;
  const gh = text.match(GH_ISSUE_URL_RE);
  if (gh) return `#${gh[1]}`;
  return undefined;
}

/**
 * Pull the plan markdown out of an `ExitPlanMode` tool_use event's args. The
 * Claude tool schema is `{ plan: string }`; the transcript parser already
 * lifts `input` onto `event.args`. Returns undefined for a missing/empty plan
 * so consumers can rely on `plan?: string` truthiness.
 */
export function extractPlanText(args?: Record<string, any>): string | undefined {
  const plan = args?.plan;
  if (typeof plan !== 'string') return undefined;
  const trimmed = plan.trim();
  return trimmed ? plan : undefined;
}

/**
 * Structured question from a Claude `AskUserQuestion` tool call. Its input is
 * `{ questions: [{ question, header, options: [{label, description}] }] }` and the
 * whole thing is already parsed onto `event.args` by the transcript parser — this
 * surfaces the first question + its options (instead of collapsing to a generic
 * "Asked you a question"). The prompt is a select-list, so each option carries its
 * 1-based selection digit as `key`.
 */
export function structuredQuestionFromAsk(args?: Record<string, any>): StructuredQuestion | undefined {
  const q = Array.isArray(args?.questions) ? args!.questions[0] : undefined;
  if (!q) return undefined;
  const text = oneLine(String(q.question ?? q.header ?? '')) || 'Asked you a question';
  const raw = Array.isArray(q.options) ? q.options : [];
  const options: QuestionOption[] = [];
  for (const o of raw) {
    const label = typeof o === 'string' ? oneLine(o) : o?.label != null ? oneLine(String(o.label)) : '';
    if (!label) continue;
    const description = typeof o === 'object' && o?.description != null ? oneLine(String(o.description)) : undefined;
    options.push({ label, description, key: String(options.length + 1) });
  }
  return { text, reason: 'question', options: options.length ? options : undefined };
}

/**
 * Canonical approve/send-back choices for Claude's plan-review dialog, which
 * carries no agent-supplied option list. Approve is reliably option 1; keep-planning
 * maps to ESC, which cancels the prompt in every variant (2- or 3-option) — safer
 * than guessing a digit that could differ.
 */
function planReviewQuestion(): StructuredQuestion {
  return {
    text: 'Plan ready — review it',
    reason: 'plan_review',
    options: [
      { label: 'Approve plan', key: '1' },
      { label: 'Keep planning', key: 'esc' },
    ],
  };
}

/**
 * The harness's own stamp on an event, as ms — or undefined when the event carries
 * none. A stamp LATER than the file's last write cannot have come from the
 * transcript (a parser that finds no stamp fills the field with its own parse
 * time), so it is rejected rather than read as "just happened": the mtime is the
 * physical upper bound on when any transcript line was written.
 */
function eventStampMs(e: SessionEvent | undefined, mtimeMs?: number): number | undefined {
  if (!e?.timestamp) return undefined;
  const ms = Date.parse(e.timestamp);
  if (!Number.isFinite(ms)) return undefined;
  if (mtimeMs != null && ms > mtimeMs) return undefined;
  return ms;
}

/** Does an assistant message read as a question directed at the user? */
function looksLikeQuestion(text: string): boolean {
  const t = text.trim();
  if (!t) return false;
  // Only weigh the final line — a long answer that ends with a question is a question.
  const lastLine = t.split('\n').filter(Boolean).pop() ?? t;
  return QUESTION_TRAILING.test(lastLine) || QUESTION_PHRASE.test(lastLine);
}

/** Human-readable one-liner for the latest event (message text or tool action). */
function describeEvent(e: SessionEvent): string | undefined {
  if (e.type === 'message' && e.content) return oneLine(e.content);
  if (e.type === 'tool_use' && e.tool) return oneLine(summarizeToolUse(e.tool, e.args));
  if (e.type === 'thinking') return 'thinking…';
  if (e.type === 'tool_result') return e.tool ? `↳ ${e.tool}` : undefined;
  if (e.type === 'error') return oneLine(e.content || 'error');
  return e.content ? oneLine(e.content) : undefined;
}

/** Last event of a given type, scanning from the end. */
function lastOf(events: SessionEvent[], pred: (e: SessionEvent) => boolean): SessionEvent | undefined {
  for (let i = events.length - 1; i >= 0; i--) if (pred(events[i])) return events[i];
  return undefined;
}

/**
 * Infer live activity + a preview from a chronological event slice. `pr` /
 * `ticket` / `worktree` are attached by `inferSessionState`; this focuses on the
 * running-vs-waiting-vs-idle decision and the preview line.
 */
export function inferActivity(events: SessionEvent[], ctx: StateContext = {}): SessionState {
  const windowMs = ctx.activeWindowMs ?? ACTIVE_WINDOW_MS;
  const nowMs = ctx.nowMs ?? Date.now();
  const fresh = ctx.mtimeMs != null && nowMs - ctx.mtimeMs < windowMs;
  // A non-live process (pidAlive === false) can never be "working"; the strongest
  // it gets is "waiting on you" (a dangling question) or "idle".
  const canWork = ctx.pidAlive !== false && (ctx.pidAlive === true || fresh);

  const meaningful = events.filter(
    e => e.type === 'message' || e.type === 'tool_use' || e.type === 'tool_result' || e.type === 'thinking' || e.type === 'error',
  );
  const last = meaningful[meaningful.length - 1];
  const lastMsg = lastOf(meaningful, e => e.type === 'message');
  const lastToolUse = lastOf(meaningful, e => e.type === 'tool_use');

  // The most informative recent line: a message or tool call as-is, but for a
  // trailing tool_result/thinking show the tool *call* that produced it (its
  // command), or — failing that — the last assistant message, rather than a bare
  // "↳ Bash" or a content-free "thinking…". This is what stops a trailing thinking
  // block from masking the real turn (the defect behind the "Thinking…" panel).
  const previewSource = !last
    ? undefined
    : last.type === 'message' || last.type === 'tool_use'
      ? last
      : (lastToolUse ?? lastMsg ?? last);

  // Last few assistant turns, most-recent last — context for the decision panel.
  const tail = meaningful
    .filter(e => e.type === 'message' && e.role === 'assistant' && e.content)
    .slice(-3)
    .map(e => oneLine(e.content ?? ''))
    .filter(Boolean);

  // Live plan progress: snapshot checklist tools or the folded Task* event log. Attached
  // to `base` so every return path below carries it — a working, waiting, or idle
  // session all keep showing how far the plan got.
  const todos = extractTodoProgressFromEvents(meaningful);

  const base: SessionState = {
    activity: 'idle',
    lastRole: lastMsg?.role,
    lastEventKind: last?.type,
    lastActivityMs: ctx.mtimeMs,
    lastEventMs: eventStampMs(last, ctx.mtimeMs),
    preview: previewSource ? describeEvent(previewSource) : undefined,
    todos,
    tail: tail.length ? tail : undefined,
  };

  if (!last) return base;

  // Structural "waiting on you" — Claude handed control back via a plan/question
  // tool and nothing has come after it.
  const lastPlanOrAsk = lastOf(
    meaningful,
    e => e.type === 'tool_use' && (e.tool === PLAN_TOOL || e.tool === ASK_TOOL),
  );
  if (lastPlanOrAsk && meaningful.indexOf(lastPlanOrAsk) === meaningful.length - 1) {
    if (lastPlanOrAsk.tool === PLAN_TOOL) {
      const question = planReviewQuestion();
      const plan = extractPlanText(lastPlanOrAsk.args);
      return { ...base, activity: 'waiting_input', awaitingReason: 'plan_review', preview: question.text, question, plan };
    }
    // AskUserQuestion: surface the real question + options (they're on `args`),
    // not the generic "Asked you a question" that discarded them.
    const question = structuredQuestionFromAsk(lastPlanOrAsk.args) ?? { text: 'Asked you a question', reason: 'question' as const };
    return { ...base, activity: 'waiting_input', awaitingReason: 'question', preview: question.text, question };
  }

  // Pending tool call (tool_use with no following tool_result): the call is in
  // flight for as long as the process is alive. A command that has run for ten
  // minutes and a permission dialog that has sat for ten minutes leave the SAME
  // transcript — a tool_use with no result and a quiet file — so elapsed time is
  // not evidence of a request, and this engine never labels one `permission`
  // (PHNX-3999: the "is the user idle?" reminder and the two-minute mark were both
  // being rendered with Approve/Deny). The harness's own `permission_prompt` hook
  // event, carried by the feed block, is the only evidence a dialog is up; the
  // attention reconciler confirms it against `lastEventMs`.
  if (last.type === 'tool_use') {
    return { ...base, activity: canWork ? 'working' : 'idle' };
  }

  // Thinking or a tool result just landed → agent is mid-turn if recently active.
  if (last.type === 'thinking' || last.type === 'tool_result' || last.type === 'error') {
    return { ...base, activity: canWork && fresh ? 'working' : 'idle' };
  }

  // Last event is a message.
  if (last.type === 'message') {
    if (last.role === 'user') {
      // User spoke last; the agent owes a reply → working if it's alive/fresh.
      return { ...base, activity: canWork ? 'working' : 'idle' };
    }
    // Assistant spoke last and stopped. A trailing question → waiting; else idle.
    // A prose question takes a free-text reply (no select-list), so no options/keys.
    // Unlike the structural plan/ask signals above, the prose heuristic DECAYS: a
    // question nobody answered within PROSE_QUESTION_FRESH_MS is a session that
    // ended, not one that needs you (RUSH-1522). The question's age is the
    // assistant message's own stamp when the harness wrote one — the exact moment
    // it was asked — and the file's last write when it did not; the age is measured
    // against `ctx.nowMs`, never a clock frozen at parse time, so the verdict
    // expires on schedule even while the bytes sit still (PHNX-3999). With no age
    // evidence at all the heuristic must not fire (an unknown-age prose question is
    // a session that ended, closing RUSH-1522's null-mtime hole where a null mtime
    // kept the question forever).
    const askedAtMs = eventStampMs(last, ctx.mtimeMs) ?? ctx.mtimeMs;
    const questionFresh = askedAtMs != null && nowMs - askedAtMs < PROSE_QUESTION_FRESH_MS;
    if (questionFresh && looksLikeQuestion(last.content ?? '')) {
      const text = oneLine(last.content ?? '');
      return { ...base, activity: 'waiting_input', awaitingReason: 'question', question: { text, reason: 'question' } };
    }
    return { ...base, activity: 'idle' };
  }

  return base;
}

/**
 * Scan an event slice for the durable signals that aren't about the cwd: the PR
 * opened, the injected ticket, plus the artifacts the session PRODUCED — tracker
 * refs it created and any team it spawned. Each `gh pr create` / create-issue tool
 * call is correlated with the nearest following tool_result; the team name comes
 * straight off the `agents teams create/add` command.
 */
export function detectDurableSignals(events: SessionEvent[]): {
  pr?: DetectedPr;
  ticket?: DetectedTicket;
  createdTickets?: string[];
  spawnedTeam?: string;
  attachments?: SessionAttachment[];
} {
  let pr: DetectedPr | undefined;
  let sawPrCreate = false;
  let ticket: DetectedTicket | undefined;
  let sawTicketCreate = false;
  let spawnedTeam: string | undefined;
  const createdTickets = new Set<string>();
  const attachments: SessionAttachment[] = [];
  const seenAttachments = new Set<string>();

  for (const e of events) {
    // Structural PR signal: a real `gh pr create` tool call, then the pull URL
    // from a following tool_result — never a bare URL mentioned in prose.
    if (e.type === 'tool_use' && isPrCreateCommand(e.command)) sawPrCreate = true;
    if (sawPrCreate && e.type === 'tool_result') {
      const found = extractPrUrl(e.output);
      if (found) { pr = found; sawPrCreate = false; }
    }
    // Produced artifacts: a team spawn is read off the command; a created ticket
    // is a create-issue tool call whose following tool_result carries the new ref.
    if (e.type === 'tool_use') {
      if (!spawnedTeam) {
        const team = detectSpawnedTeam(e.command);
        if (team) spawnedTeam = team;
      }
      if (isTicketCreateTool(e.tool, e.command)) sawTicketCreate = true;
    }
    if (sawTicketCreate && e.type === 'tool_result') {
      const t = extractCreatedTicket(e.output);
      if (t) createdTickets.add(t);
      sawTicketCreate = false;
    }
    if (!ticket && e.type === 'message' && e.role === 'user') {
      ticket = detectTicket(e.content);
    }
    if (e.type === 'attachment') {
      const mediaType = e.mediaType || 'application/octet-stream';
      const key = e.path || e.name || `${mediaType}:${e.sizeBytes ?? 0}:${e.timestamp}`;
      if (key && !seenAttachments.has(key)) {
        seenAttachments.add(key);
        attachments.push({
          path: e.path,
          name: e.name,
          mediaType,
          sizeBytes: e.sizeBytes,
        });
      }
    }
  }
  return {
    pr,
    ticket,
    createdTickets: createdTickets.size > 0 ? [...createdTickets] : undefined,
    spawnedTeam,
    attachments: attachments.length > 0 ? attachments : undefined,
  };
}

/** Full inference: activity + preview + durable signals + worktree/ticket from ctx. */
export function inferSessionState(events: SessionEvent[], ctx: StateContext = {}): SessionState {
  const state = inferActivity(events, ctx);
  const { pr, ticket, createdTickets, spawnedTeam, attachments } = detectDurableSignals(events);
  const worktree = detectWorktree(ctx.cwd, ctx.gitBranch);
  const artifacts = extractArtifacts(classifyFileChanges(events));
  const planFile = artifacts.find((artifact) => artifact.bucket === 'plans')?.path;
  // Rate-limit: scan the most recent assistant messages + tool errors (tail-first).
  let rateLimited = false;
  for (let i = events.length - 1; i >= 0 && i >= events.length - 12; i--) {
    const e = events[i];
    if (!e) continue;
    if (e.type === 'message' && e.role === 'assistant' && detectRateLimited(e.content)) {
      rateLimited = true;
      break;
    }
    if (e.type === 'tool_result' && detectRateLimited(e.output)) {
      rateLimited = true;
      break;
    }
  }
  if (!rateLimited && detectRateLimited(state.preview)) rateLimited = true;
  return {
    ...state,
    pr: pr ?? state.pr,
    worktree: worktree ?? state.worktree,
    ticket: ticket ?? detectTicket(undefined, ctx.gitBranch) ?? state.ticket,
    createdTickets,
    spawnedTeam,
    attachments,
    artifacts: artifacts.length > 0 ? artifacts : undefined,
    planFile,
    rateLimited: rateLimited || undefined,
  };
}
