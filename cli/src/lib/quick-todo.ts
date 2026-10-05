/**
 * Quick to-dos for AGI Menu's Home: `agents projects todo add|list|done|undo`.
 *
 * Linear is the record; nothing is stored here. `add` turns one typed line into a
 * Linear issue with `linear create` (the active cycle, status Todo, no milestone, no
 * delegate), reading `#project`, a day word and `!`/`!!` from the text unless an
 * option names that field. The issue description carries
 * {@link QUICK_TODO_MARKER}, which is how `list` tells a quick to-do from any other
 * issue (the team has no "todo" label, and taxonomy is not ours to add). `list`
 * shows the caller's open quick to-dos plus anything assigned to them that is due
 * today or overdue. `done` closes one; `undo` reopens a closed one, or cancels a
 * quick to-do created moments ago (linear-cli has no issue archive; Canceled is
 * the workflow's own discard state).
 */

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
export const ADD_PRIORITIES = ['urgent', 'high', 'medium', 'low', 'none'] as const;
export type AddPriority = (typeof ADD_PRIORITIES)[number];
export const TITLE_MIN = 3;
export const TITLE_MAX = 120;
export const DESCRIPTION_MAX = 10_000;

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

export function localDay(date: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}`;
}

export function resolveDayWord(word: string, now: Date): string {
  const w = word.toLowerCase();
  const day = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  if (w === 'tomorrow') day.setDate(day.getDate() + 1);
  else if (w !== 'today') day.setDate(day.getDate() + ((DAYS.indexOf(w.slice(0, 3)) - day.getDay() + 7) % 7));
  return localDay(day);
}

const TAG = /^#([\p{L}\p{N}_.-]+)$/u;
const BANGS = /^!+$/;
const clean = (token: string) => token.replace(/[,.;:]+$/, '');

// Shared AGI Menu grammar: first #project anywhere; day/priority only in the trailing suffix.
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

export function linearProjectFor(token: string, defs: readonly ProjectDef[]): string {
  const def = defs.find((d) => d.name.toLowerCase() === token.toLowerCase() || d.linear?.name?.toLowerCase() === token.toLowerCase());
  if (!def) return token;
  if (!def.linear?.name && !def.linear?.projectId) {
    throw new Error(`Project "${def.name}" has no Linear project; bind one with: agents projects link ${def.name}`);
  }
  return def.linear.name ?? def.linear.projectId!;
}

export interface QuickTodo {
  identifier: string;
  url: string | null;
  title: string;
  project: string | null;
  due: string | null;
  priority: number;
  /** The workflow state's name (Todo, Doing, Done, …). */
  state: string;
  createdAt: string;
  quick: boolean;
}

export type LinearExec = (args: string[]) => Promise<{ stdout: string; stderr: string }>;

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

export interface AddOptions {
  project?: string;
  description?: string;
  assignee?: string;
  due?: string;
  priority?: AddPriority;
  defs: readonly ProjectDef[];
  now: Date;
}

export function addRefusal(title: string, opts: AddOptions): string | null {
  const length = [...title].length;
  if (length === 0) return 'The to-do has no words besides its #project, day and priority.';
  if (length < TITLE_MIN) return `The title needs at least ${TITLE_MIN} characters.`;
  if (length > TITLE_MAX) return `The title is ${length} characters; the limit is ${TITLE_MAX}. Put the rest in the description.`;
  if (opts.description && [...opts.description].length > DESCRIPTION_MAX) {
    return `The description is over ${DESCRIPTION_MAX.toLocaleString('en-US')} characters.`;
  }
  if (opts.due !== undefined) {
    const m = opts.due.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    const date = m && new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
    if (!date || localDay(date) !== opts.due) return `Expected a due date like 2026-10-09, got "${opts.due}".`;
    if (opts.due < localDay(opts.now)) return `The due date ${opts.due} is in the past.`;
  }
  if (opts.priority !== undefined && !ADD_PRIORITIES.includes(opts.priority)) {
    return `Expected a priority of ${ADD_PRIORITIES.join(', ')}, got "${opts.priority}".`;
  }
  return null;
}

/**
 * Create a quick to-do from a typed line and the options. Nothing is created
 * when {@link addRefusal} names a reason.
 */
export async function addQuickTodo(text: string, opts: AddOptions, linear: LinearExec = linearExec): Promise<TodoResult> {
  const parsed = parseQuickTodo(text, opts.now);
  const due = opts.due ?? parsed.due;
  const priority = opts.priority ?? parsed.priority ?? 'none';
  const refusal = addRefusal(parsed.title, opts);
  if (refusal) return { ok: false, todo: null, message: refusal };
  const description = opts.description?.trim() ? `${opts.description.trim()}\n\n${QUICK_TODO_MARKER}` : QUICK_TODO_MARKER;
  const token = opts.project ?? parsed.project ?? null;
  const args = ['create', '--description', description, '--status', 'Todo', '--cycle', 'active',
    '--skip-milestone', '--priority', priority];
  try {
    if (token) args.push('--project', linearProjectFor(token, opts.defs));
  } catch (err) {
    return { ok: false, todo: null, message: (err as Error).message };
  }
  if (due) args.push('--due-date', due);
  const assignee = opts.assignee?.trim();
  if (assignee && assignee.toLowerCase() !== 'me') args.push('--assign', assignee);
  // The title goes after `--`, so one that starts with "-" is never read as a flag.
  args.push('--', parsed.title);
  let out: { stdout: string; stderr: string };
  try {
    out = await linear(args);
  } catch (err) {
    return { ok: false, todo: null, message: linearFailure(err) };
  }
  // linear may report Error: on stderr despite exit zero; success requires a stdout issue ID.
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
      identifier: id, url: null, title: parsed.title, project: null, due,
      priority: Math.max(0, ['none', 'urgent', 'high', 'medium', 'low'].indexOf(priority)), state: 'Todo', createdAt: '', quick: true,
    };
    return { ok: true, todo, message: `Created ${id}; reading it back failed: ${linearFailure(err)}` };
  }
}

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

export const DONE_PROOF = 'Checked off in AGI Menu';

async function readStates(linear: LinearExec): Promise<Array<{ name?: string; type?: string }>> {
  return JSON.parse((await linear(['states', '--json'])).stdout) as Array<{ name?: string; type?: string }>;
}

export async function completeTodo(id: string, linear: LinearExec = linearExec): Promise<TodoResult> {
  try {
    const update = await linear(['update', id, '--done', '--proof', DONE_PROOF]);
    // Read back completion because queued/rate-limited updates may exit zero before state changes.
    const [raw, states] = await Promise.all([readIssue(id, linear), readStates(linear)]);
    const todo = toQuickTodo(raw);
    if (states.find((s) => s.name === todo.state)?.type === 'completed') return { ok: true, todo, message: `${id} marked Done` };
    const said = update.stdout.trim().split('\n').at(-1) || `${id} is still ${todo.state}`;
    return { ok: false, todo, message: `Not closed yet: ${said}` };
  } catch (err) {
    return { ok: false, todo: null, message: linearFailure(err) };
  }
}

/**
 * Undo the last menu action on an issue: a completed one goes back to Todo; a
 * quick to-do still open and created within {@link UNDO_CREATE_WINDOW_MS} is
 * canceled (moved to the team's canceled state). Anything else is refused, so an
 * Undo never silently does nothing.
 */
export async function undoTodo(id: string, now: Date, linear: LinearExec = linearExec): Promise<TodoResult> {
  let issue: QuickTodo;
  let states: Array<{ name?: string; type?: string }>;
  try {
    const [raw, read] = await Promise.all([readIssue(id, linear), readStates(linear)]);
    issue = toQuickTodo(raw);
    states = read;
  } catch (err) {
    return { ok: false, todo: null, message: linearFailure(err) };
  }
  // Map state name to workflow type and allow bounded negative age for clock skew.
  const type = states.find((s) => s.name === issue.state)?.type;
  try {
    if (type === 'completed') {
      await linear(['update', id, '--todo']);
      return { ok: true, todo: toQuickTodo(await readIssue(id, linear)), message: `${id} back to Todo` };
    }
    const age = now.getTime() - Date.parse(issue.createdAt);
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
