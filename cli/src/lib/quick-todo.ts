/** Quick to-dos for AGI Menu's Home (`agents projects todo add|list|done|undo`). Linear is the
 * record; nothing is stored here. `add` makes a Linear issue reading `#project`, a day word and
 * `!`/`!!`; its description carries {@link QUICK_TODO_MARKER} so `list` can find them. */

import { execFile } from 'child_process';
import { promisify } from 'util';
import type { ProjectDef } from './projects.js';

const execFileAsync = promisify(execFile);

/** The description line every quick to-do carries. */
export const QUICK_TODO_MARKER = 'Created from AGI Menu';
/** How many to-dos `list` returns. */
export const TODO_LIST_LIMIT = 6;
/** How long after creation `undo` may cancel a quick to-do instead of refusing. */
export const UNDO_CREATE_WINDOW_MS = 30_000;
/** How far this machine's clock may run behind Linear's for the undo window. */
const CLOCK_SKEW_MS = 5_000;

export type TodoPriority = 'urgent' | 'high';

/** One typed line, read. */
export interface ParsedTodo {
  title: string;
  /** The `#project` token as typed, without `#`; null when none. */
  project: string | null;
  /** `YYYY-MM-DD` in local time; null when no day word was typed. */
  due: string | null;
  priority: TodoPriority | null;
}

const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const DAY_WORD = /^(today|tomorrow|sun(?:day)?|mon(?:day)?|tue(?:s|sday)?|wed(?:nesday)?|thu(?:rs|rsday)?|fri(?:day)?|sat(?:urday)?)$/i;

/** `YYYY-MM-DD` of a local date. */
export function localDay(date: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}`;
}

/** The date a day word names: today, tomorrow, or the next such weekday (today included). */
export function resolveDayWord(word: string, now: Date): string {
  const w = word.toLowerCase();
  const day = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  if (w === 'tomorrow') day.setDate(day.getDate() + 1);
  else if (w !== 'today') day.setDate(day.getDate() + ((DAYS.indexOf(w.slice(0, 3)) - day.getDay() + 7) % 7));
  return localDay(day);
}

const TAG = /^#([\p{L}\p{N}_.-]+)$/u;
const BANGS = /^!+$/;
/** A trailing token's punctuation, as typed in "call back tomorrow," or "#AGI.". */
const clean = (token: string) => token.replace(/[,.;:]+$/, '');

/** Read a typed line: the first `#project` anywhere; a day word and a run of `!` (one: high, two+:
 * urgent) only from tokens ending the line, so "Fix the today view bug" keeps its words. Tokens
 * must stand alone; AGI Menu's chips mirror this (QuickTodoParse). */
export function parseQuickTodo(text: string, now: Date): ParsedTodo {
  let project: string | null = null;
  let due: string | null = null;
  let priority: TodoPriority | null = null;
  const tokens = text.trim().split(/\s+/).filter(Boolean);
  let end = tokens.length;
  while (end > 0) {
    const t = clean(tokens[end - 1]);
    if (!(DAY_WORD.test(t) || BANGS.test(t) || TAG.test(t))) break;
    end--;
  }
  const words: string[] = [];
  tokens.forEach((token, i) => {
    const t = i >= end ? clean(token) : token;
    const tag = t.match(TAG);
    if (tag && project === null) project = tag[1];
    else if (i >= end && DAY_WORD.test(t) && due === null) due = resolveDayWord(t, now);
    else if (i >= end && BANGS.test(t) && priority === null) priority = t.length >= 2 ? 'urgent' : 'high';
    else words.push(token);
  });
  return { title: words.join(' '), project, due, priority };
}

/** The Linear project a `#token` or `--project` names: an `agents projects` definition's Linear project, else the token as Linear knows it. */
export function linearProjectFor(token: string, defs: readonly ProjectDef[]): string {
  const def = defs.find((d) => d.name.toLowerCase() === token.toLowerCase() || d.linear?.name?.toLowerCase() === token.toLowerCase());
  if (!def) return token;
  if (!def.linear?.name && !def.linear?.projectId) {
    throw new Error(`Project "${def.name}" has no Linear project; bind one with: agents projects link ${def.name}`);
  }
  return def.linear.name ?? def.linear.projectId!;
}

/** One to-do as AGI Menu renders it. */
export interface QuickTodo {
  identifier: string;
  url: string | null;
  title: string;
  /** The Linear project name; null when none. */
  project: string | null;
  /** `YYYY-MM-DD`; null when none. */
  due: string | null;
  /** Linear's priority number: 0 none, 1 urgent, 2 high, 3 medium, 4 low. */
  priority: number;
  /** The workflow state's name (Todo, Doing, Done, …). */
  state: string;
  createdAt: string;
  /** True when it was created as a quick to-do (carries {@link QUICK_TODO_MARKER}). */
  quick: boolean;
}

/** The `linear` runner; tests inject recorded answers. Resolves stdout and stderr, rejects on a non-zero exit. */
export type LinearExec = (args: string[]) => Promise<{ stdout: string; stderr: string }>;

/** `linear <args>` with a 30 s timeout; the failure carries linear's stderr. */
export const linearExec: LinearExec = async (args) => {
  try {
    const { stdout, stderr } = await execFileAsync('linear', args, { timeout: 30_000, maxBuffer: 32 * 1024 * 1024, encoding: 'utf-8' });
    return { stdout, stderr };
  } catch (err) {
    if ((err as { code?: unknown })?.code === 'ENOENT') {
      throw Object.assign(new Error('The linear CLI is not on PATH; install linear-cli and run linear setup.'), { stderr: '' });
    }
    throw err;
  }
};

/** linear's own words for a failure: its last `Error:` line, else the first stderr line (the reason; usage hints follow it). */
export function linearFailure(err: unknown): string {
  const stderr = String((err as { stderr?: unknown })?.stderr ?? '').trim();
  const lines = stderr.split('\n').map((l) => l.trim()).filter(Boolean);
  const line = [...lines].reverse().find((l) => /^Error:/i.test(l)) ?? lines[0];
  if (line) return line.replace(/^Error:\s*/i, '');
  if ((err as { killed?: boolean })?.killed) return 'linear did not answer within 30 s';
  return err instanceof Error ? err.message : String(err);
}

type RawIssue = {
  identifier?: string; url?: string; title?: string; description?: string | null; dueDate?: string | null;
  priority?: number; createdAt?: string; project?: { name?: string } | null; state?: { name?: string } | null;
};

/** A `linear tasks --json` issue as a {@link QuickTodo}. */
export function toQuickTodo(issue: RawIssue): QuickTodo {
  return {
    identifier: String(issue.identifier ?? ''),
    url: issue.url || null,
    title: String(issue.title ?? ''),
    project: issue.project?.name || null,
    due: issue.dueDate || null,
    priority: typeof issue.priority === 'number' ? issue.priority : 0,
    state: issue.state?.name ?? '',
    createdAt: String(issue.createdAt ?? ''),
    quick: (issue.description ?? '').split('\n').some((l) => l.trim() === QUICK_TODO_MARKER),
  };
}

async function readIssue(id: string, linear: LinearExec): Promise<RawIssue> {
  return JSON.parse((await linear(['tasks', id, '--json'])).stdout) as RawIssue;
}

/** The outcome of one to-do verb. `todo` is the issue afterwards; null when the verb failed before reading it. */
export interface TodoResult {
  ok: boolean;
  todo: QuickTodo | null;
  message: string;
}

/** Create a quick to-do. `project` (`--project`) applies when the text names none; nothing is
 * created from a line that is only tokens. */
export async function addQuickTodo(
  text: string,
  opts: { project?: string; defs: readonly ProjectDef[]; now: Date },
  linear: LinearExec = linearExec,
): Promise<TodoResult> {
  const parsed = parseQuickTodo(text, opts.now);
  if (!parsed.title) return { ok: false, todo: null, message: 'The to-do has no words besides its #project, day and priority.' };
  const token = parsed.project ?? opts.project ?? null;
  const args = ['create', '--description', QUICK_TODO_MARKER, '--status', 'Todo', '--cycle', 'active',
    '--skip-milestone', '--priority', parsed.priority ?? 'none'];
  try {
    if (token) args.push('--project', linearProjectFor(token, opts.defs));
  } catch (err) {
    return { ok: false, todo: null, message: (err as Error).message };
  }
  if (parsed.due) args.push('--due-date', parsed.due);
  // The title goes after `--`, so one that starts with "-" is never read as a flag.
  args.push('--', parsed.title);
  let out: { stdout: string; stderr: string };
  try {
    out = await linear(args);
  } catch (err) {
    return { ok: false, todo: null, message: linearFailure(err) };
  }
  // linear prints "Created PHNX-123: <title>  [cycle | assignee]". Some refusals exit 0
  // with only an "Error:" line on stderr; that line is the message.
  const id = out.stdout.match(/^Created ([A-Z][A-Z0-9]*-\d+):/m)?.[1];
  if (!id) {
    const error = out.stderr.split('\n').map((l) => l.trim()).reverse().find((l) => /^Error:/i.test(l));
    return { ok: false, todo: null, message: error ? error.replace(/^Error:\s*/i, '') : 'linear create did not report an issue' };
  }
  try {
    return { ok: true, todo: toQuickTodo(await readIssue(id, linear)), message: `Created ${id}` };
  } catch (err) {
    // The issue exists: report it created (a retry would duplicate it) with what is known.
    const todo: QuickTodo = {
      identifier: id, url: null, title: parsed.title, project: null, due: parsed.due,
      priority: parsed.priority === 'urgent' ? 1 : parsed.priority === 'high' ? 2 : 0, state: 'Todo', createdAt: '', quick: true,
    };
    return { ok: true, todo, message: `Created ${id}; reading it back failed: ${linearFailure(err)}` };
  }
}

/** The caller's to-dos: open quick to-dos plus open assigned issues due today or earlier, due ones
 * first (earliest due), then newest quick to-dos, at most {@link TODO_LIST_LIMIT}; `total` counts
 * all. */
export async function listQuickTodos(now: Date, linear: LinearExec = linearExec): Promise<{ todos: QuickTodo[]; total: number }> {
  const parsed = JSON.parse((await linear(['tasks', '--assignee', 'me', '--status', 'open', '--cycle', 'all', '--all', '--json'])).stdout) as { issues?: RawIssue[] };
  const today = localDay(now);
  const due = (t: QuickTodo) => t.due !== null && t.due <= today;
  const all = (parsed.issues ?? []).map(toQuickTodo).filter((t) => t.quick || due(t));
  all.sort((a, b) => {
    if (due(a) !== due(b)) return due(a) ? -1 : 1;
    if (due(a) && a.due !== b.due) return a.due! < b.due! ? -1 : 1;
    return b.createdAt.localeCompare(a.createdAt);
  });
  return { todos: all.slice(0, TODO_LIST_LIMIT), total: all.length };
}

/** The proof `linear update --done` requires: what the person did. */
export const DONE_PROOF = 'Checked off in AGI Menu';

/** The team's workflow states; an issue read names its state but not the state's type. */
async function readStates(linear: LinearExec): Promise<Array<{ name?: string; type?: string }>> {
  return JSON.parse((await linear(['states', '--json'])).stdout) as Array<{ name?: string; type?: string }>;
}

/** Mark one issue Done and confirm it: linear queues a close it couldn't make (rate limit) and still
 * exits 0, so the issue is read back and only a completed state counts. */
export async function completeTodo(id: string, linear: LinearExec = linearExec): Promise<TodoResult> {
  try {
    const update = await linear(['update', id, '--done', '--proof', DONE_PROOF]);
    const [raw, states] = await Promise.all([readIssue(id, linear), readStates(linear)]);
    const todo = toQuickTodo(raw);
    if (states.find((s) => s.name === todo.state)?.type === 'completed') return { ok: true, todo, message: `${id} marked Done` };
    const said = update.stdout.trim().split('\n').at(-1) || `${id} is still ${todo.state}`;
    return { ok: false, todo, message: `Not closed yet: ${said}` };
  } catch (err) {
    return { ok: false, todo: null, message: linearFailure(err) };
  }
}

/** Undo the last menu action: a completed issue goes back to Todo; a still-open quick to-do created
 * within {@link UNDO_CREATE_WINDOW_MS} is canceled. Anything else is refused so Undo never silently
 * does nothing. */
export async function undoTodo(id: string, now: Date, linear: LinearExec = linearExec): Promise<TodoResult> {
  let issue: QuickTodo;
  let states: Array<{ name?: string; type?: string }>;
  try {
    // An issue read names its state but not the state's type; the team's states map one to the other.
    const [raw, read] = await Promise.all([readIssue(id, linear), readStates(linear)]);
    issue = toQuickTodo(raw);
    states = read;
  } catch (err) {
    return { ok: false, todo: null, message: linearFailure(err) };
  }
  const type = states.find((s) => s.name === issue.state)?.type;
  try {
    if (type === 'completed') {
      await linear(['update', id, '--todo']);
      return { ok: true, todo: toQuickTodo(await readIssue(id, linear)), message: `${id} back to Todo` };
    }
    const age = now.getTime() - Date.parse(issue.createdAt);
    // A few seconds of clock skew against Linear's createdAt still counts as just created.
    if (issue.quick && type !== 'canceled' && age >= -CLOCK_SKEW_MS && age <= UNDO_CREATE_WINDOW_MS) {
      const canceled = states.find((s) => s.type === 'canceled')?.name;
      if (!canceled) return { ok: false, todo: issue, message: 'The team has no canceled state to undo into' };
      await linear(['update', id, '--status', canceled]);
      return { ok: true, todo: toQuickTodo(await readIssue(id, linear)), message: `${id} canceled` };
    }
  } catch (err) {
    return { ok: false, todo: issue, message: linearFailure(err) };
  }
  return { ok: false, todo: issue, message: `${id} is ${issue.state || 'open'} and was not just created here; change it in Linear` };
}
