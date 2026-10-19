import { isDeepStrictEqual } from 'node:util';
import { isAgentId } from '../types.js';
import type { ProjectDef } from '../projects.js';
import type { ConfirmAction } from './confirm.js';

export const MAX_TASK_CHARS = 4_000;
export const MAX_NOTE_CHARS = 500;
export const MAX_MEMORY_LINES = 60;
export const MAX_TASKS_LIMIT = 50;
export const LINEAR_STATUSES = ['open', 'todo', 'progress', 'backlog', 'done'] as const;
const TICKET_RE = /^[A-Z][A-Z0-9]{1,9}-\d{1,6}$/;
const SESSION_RE = /^[0-9a-f][0-9a-f-]{7,35}$/;

export class LeadToolError extends Error {}

export function assertTicketId(id: string): string {
  if (!TICKET_RE.test(id)) throw new LeadToolError(`'${id}' is not a ticket id (expected TEAM-123).`);
  return id;
}

export function assertAgent(agent: string): string {
  if (!isAgentId(agent)) throw new LeadToolError(`'${agent}' is not a known agent.`);
  return agent;
}

export function assertSessionId(id: string): string {
  if (!SESSION_RE.test(id)) throw new LeadToolError(`'${id}' is not a session id (a uuid or its first 8+ characters).`);
  return id;
}

export function assertTask(text: string): string {
  const task = text.trim();
  if (!task) throw new LeadToolError('The task text is empty.');
  if (task.length > MAX_TASK_CHARS) throw new LeadToolError(`The task text is over ${MAX_TASK_CHARS} characters.`);
  return task;
}

export const SEND_LABEL = '[Lead] ';
const SEND_LINE_BREAK = /[\r\n\u0085\u2028\u2029]/;
const SEND_CONTROL = /[\u0000-\u001f\u007f-\u009f]/g;
const SEND_SPECIAL_FIRST = /^[/!#]/;

export function assertSendText(text: string): string {
  if (SEND_LINE_BREAK.test(text)) throw new LeadToolError('A message to a session must be one line.');
  const body = assertTask(text.replace(SEND_CONTROL, ''));
  if (SEND_SPECIAL_FIRST.test(body)) {
    throw new LeadToolError('Refusing a message that starts with /, ! or # (a slash command, shell escape or memory note in the session).');
  }
  return `${SEND_LABEL}${body}`;
}

export function linearProjectRef(def: ProjectDef): string {
  const ref = def.linear?.projectId ?? def.linear?.name;
  if (!ref) throw new LeadToolError(`Project '${def.name}' has no Linear project.`);
  return ref;
}

export function dispatchPrompt(id: string, title: string): string {
  return `Work on ${id}: ${title}`;
}

export function runArgv(agent: string, prompt: string, project: string): string[] {
  return ['run', assertAgent(agent), assertTask(prompt), '--headless', '-P', project, '--mode', 'edit'];
}

export function linearPickupArgv(id: string, agent: string): string[] {
  return ['update', assertTicketId(id), '--pickup', '--delegate', assertAgent(agent)];
}

export function sendArgv(sessionId: string, text: string): string[] {
  return ['send', '--channel', 'session', '--to', sessionId, '--text', assertSendText(text)];
}

export function linearTasksArgv(def: ProjectDef, status: string, limit: number): string[] {
  if (!(LINEAR_STATUSES as readonly string[]).includes(status)) {
    throw new LeadToolError(`--status must be one of ${LINEAR_STATUSES.join(', ')}.`);
  }
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_TASKS_LIMIT) {
    throw new LeadToolError(`--limit must be 1-${MAX_TASKS_LIMIT}.`);
  }
  return ['tasks', '--project', linearProjectRef(def), '--status', status, '--limit', String(limit), '--json'];
}

export function linearViewArgv(id: string): string[] {
  return ['tasks', assertTicketId(id), '--json'];
}

export function linearCreateArgv(def: ProjectDef, title: string, description?: string): string[] {
  const t = title.trim();
  if (!t || t.length > 200) throw new LeadToolError('--title must be 1-200 characters.');
  const args = ['create', t, '--project', linearProjectRef(def)];
  if (description !== undefined) args.push('--description', assertTask(description));
  return args;
}

const ATTENTION_KEY_RE = /^\w[^\s/]{0,127}\/[^\s/]{1,128}\/[^\s/]{1,128}$/;
const CHOICE_ID_RE = /^[\w.:-]{1,64}$/;
const REPO_RE = /^[\w.-]+\/[\w.-]+$/;
const SHA_RE = /^[0-9a-f]{7,40}$/i;
export const PR_VERBS = ['merge', 'comment', 'ready', 'rerun', 'close'] as const;
export type PrVerb = typeof PR_VERBS[number];

export function assertAttentionKey(key: string): string {
  if (!ATTENTION_KEY_RE.test(key)) throw new LeadToolError(`'${key}' is not an attention key (expected <host>/<session>/<generation>, from the attention tool).`);
  return key;
}

export function assertAnswerText(text: string): string {
  if (SEND_LINE_BREAK.test(text)) throw new LeadToolError('An answer must be one line.');
  const body = assertTask(text.replace(SEND_CONTROL, ''));
  if (SEND_SPECIAL_FIRST.test(body)) {
    throw new LeadToolError('Refusing an answer that starts with /, ! or # (a slash command, shell escape or memory note in the session).');
  }
  return body;
}

export type AnswerValue = { choice: string } | { text: string };

export function answerArgv(key: string, value: AnswerValue): string[] {
  assertAttentionKey(key);
  if ('choice' in value) {
    if (!CHOICE_ID_RE.test(value.choice)) throw new LeadToolError(`'${value.choice}' is not a choice id.`);
    return ['feed', 'answer', key, '--choice', value.choice, '--json'];
  }
  return ['feed', 'answer', key, '--text', assertAnswerText(value.text), '--json'];
}

export function assertRepo(repo: string): string {
  if (!REPO_RE.test(repo)) throw new LeadToolError(`--repo expects owner/repo, got '${repo}'.`);
  return repo;
}

export function assertPrNumber(raw: string | number): number {
  const n = typeof raw === 'number' ? raw : /^\d+$/.test(raw.trim()) ? Number(raw.trim()) : NaN;
  if (!Number.isSafeInteger(n) || n <= 0) throw new LeadToolError(`--number expects a positive integer, got '${raw}'.`);
  return n;
}

export function assertSha(sha: string): string {
  if (!SHA_RE.test(sha)) throw new LeadToolError(`--sha expects a commit SHA, got '${sha}'.`);
  return sha;
}

export function prsListArgv(project: string, repo?: string): string[] {
  return ['projects', 'prs', 'list', project, '--json', ...(repo !== undefined ? ['--repo', assertRepo(repo)] : [])];
}

export function prReadArgv(project: string, repo: string, number: number): string[] {
  return ['projects', 'prs', 'list', project, '--json', '--repo', assertRepo(repo), '--number', String(assertPrNumber(number))];
}

export function prFailureArgv(project: string, repo: string, sha: string): string[] {
  return ['projects', 'prs', 'failure', project, '--repo', assertRepo(repo), '--sha', assertSha(sha), '--json'];
}

export interface PrAction { repo: string; number: number; sha?: string; body?: string; runId?: number }

export function prArgv(project: string, verb: PrVerb, a: PrAction): string[] {
  const base = ['projects', 'prs', verb, project, '--repo', assertRepo(a.repo)];
  switch (verb) {
    case 'merge':
      if (a.sha === undefined) throw new LeadToolError('A merge is pinned to the head commit; it needs its SHA.');
      return [...base, '--number', String(assertPrNumber(a.number)), '--sha', assertSha(a.sha), '--json'];
    case 'ready':
      return [...base, '--number', String(assertPrNumber(a.number)), ...(a.sha !== undefined ? ['--sha', assertSha(a.sha)] : []), '--json'];
    case 'comment':
      if (a.body === undefined) throw new LeadToolError('A comment needs --body <text>.');
      return [...base, '--number', String(assertPrNumber(a.number)), '--body', assertTask(a.body), '--json'];
    case 'close':
      return [...base, '--number', String(assertPrNumber(a.number)), '--json'];
    case 'rerun':
      if (a.runId === undefined || !Number.isSafeInteger(a.runId) || a.runId <= 0) throw new LeadToolError('A re-run needs a workflow run id.');
      return [...base, '--run-id', String(a.runId), '--json'];
  }
}

function prActionFromArgv(argv: string[]): PrAction {
  const flag = (name: string) => { const i = argv.indexOf(name); return i === -1 ? undefined : argv[i + 1]; };
  const runId = flag('--run-id');
  const number = flag('--number');
  return {
    repo: flag('--repo') ?? '',
    number: number === undefined ? 0 : Number(number),
    sha: flag('--sha'),
    body: flag('--body'),
    runId: runId === undefined ? undefined : Number(runId),
  };
}

export function assertHeldArgv(held: { action: ConfirmAction; project: string; argv: string[]; linearArgv?: string[] }): void {
  const { action, project, argv } = held;
  let rebuilt: string[];
  switch (action) {
    case 'stop':
      rebuilt = ['ps', 'stop', assertSessionId(argv[2] ?? '')];
      break;
    case 'answer':
      rebuilt = answerArgv(argv[2] ?? '', argv[3] === '--choice' ? { choice: argv[4] ?? '' } : { text: argv[4] ?? '' });
      break;
    case 'send':
      if (!(argv[6] ?? '').startsWith(SEND_LABEL)) throw new LeadToolError('A held send has lost its [Lead] label.');
      rebuilt = sendArgv(assertSessionId(argv[4] ?? ''), (argv[6] ?? '').slice(SEND_LABEL.length));
      break;
    case 'start':
    case 'dispatch':
      rebuilt = runArgv(argv[1] ?? '', argv[2] ?? '', project);
      break;
    case 'pr': {
      const verb = argv[2] as PrVerb;
      if (!(PR_VERBS as readonly string[]).includes(verb)) throw new LeadToolError(`'${verb}' is not a PR action the Lead may hold.`);
      rebuilt = prArgv(project, verb, prActionFromArgv(argv));
      break;
    }
  }
  if (!isDeepStrictEqual(argv, rebuilt)) throw new LeadToolError(`The held ${action} is not one of its fixed shapes; nothing was run.`);
  const linear = held.linearArgv;
  if (action === 'dispatch') {
    if (!linear || !isDeepStrictEqual(linear, linearPickupArgv(linear[1] ?? '', linear[4] ?? ''))) {
      throw new LeadToolError('The held dispatch has no valid ticket pickup; nothing was run.');
    }
  } else if (linear !== undefined) {
    throw new LeadToolError(`A held ${action} carries a ticket pickup it never has; nothing was run.`);
  }
}

const MAX_CONTEXT_TABS = 60;
const MAX_CONTEXT_TITLE = 200;
const CONTEXT_SESSION_RE = /^[\w-]{1,64}$/;

export interface EditorTab { sessionId?: string; title?: string; tab?: number }
export interface EditorContext { front?: EditorTab; tabs?: EditorTab[] }

function contextTab(raw: unknown, where: string): EditorTab {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new LeadToolError(`--context: ${where} must be an object.`);
  const out: EditorTab = {};
  for (const [key, value] of Object.entries(raw)) {
    if (key === 'sessionId') {
      if (typeof value !== 'string' || !CONTEXT_SESSION_RE.test(value)) throw new LeadToolError(`--context: ${where}.sessionId must be a session id.`);
      out.sessionId = value;
    } else if (key === 'title') {
      if (typeof value !== 'string') throw new LeadToolError(`--context: ${where}.title must be a string.`);
      const title = value.replace(SEND_CONTROL, ' ').replace(/\s+/g, ' ').trim().slice(0, MAX_CONTEXT_TITLE);
      if (title) out.title = title;
    } else if (key === 'tab') {
      if (!Number.isSafeInteger(value) || (value as number) < 1) throw new LeadToolError(`--context: ${where}.tab must be a positive integer.`);
      out.tab = value as number;
    } else {
      throw new LeadToolError(`--context: ${where} has an unknown field '${key}' (expected sessionId, title, tab).`);
    }
  }
  return out;
}

export function parseEditorContext(raw: string): EditorContext {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new LeadToolError('--context expects a JSON object, e.g. {"front":{"sessionId":"…","title":"…","tab":3}}.');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new LeadToolError('--context expects a JSON object.');
  const out: EditorContext = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (key === 'front') out.front = contextTab(value, 'front');
    else if (key === 'tabs') {
      if (!Array.isArray(value)) throw new LeadToolError('--context: tabs must be an array.');
      if (value.length > MAX_CONTEXT_TABS) throw new LeadToolError(`--context: at most ${MAX_CONTEXT_TABS} tabs.`);
      out.tabs = value.map((t, i) => contextTab(t, `tabs[${i}]`));
    } else throw new LeadToolError(`--context has an unknown field '${key}' (expected front, tabs).`);
  }
  return out;
}

function describeTab(t: EditorTab): string {
  return [
    t.tab !== undefined ? `tab ${t.tab}` : null,
    t.title ? `“${t.title}”` : null,
    t.sessionId ? `(session ${t.sessionId.slice(0, 8)})` : null,
  ].filter(Boolean).join(' ') || 'a tab with no session';
}

export function editorContextLines(ctx: EditorContext): string[] {
  const lines: string[] = [];
  if (ctx.front) lines.push(`Front tab (what "this one" means): ${describeTab(ctx.front)}`);
  if (ctx.tabs?.length) lines.push(`Open tabs: ${ctx.tabs.map(describeTab).join('; ')}`);
  return lines;
}

export function appendNote(memory: string, note: string): string {
  const clean = note.replace(/\s+/g, ' ').trim();
  if (!clean) throw new LeadToolError('The note is empty.');
  if (clean.length > MAX_NOTE_CHARS) throw new LeadToolError(`A note is at most ${MAX_NOTE_CHARS} characters.`);
  const lines = memory.split('\n').filter((l) => l.trim().length > 0);
  lines.push(`- ${clean}`);
  return `${lines.slice(-MAX_MEMORY_LINES).join('\n')}\n`;
}

