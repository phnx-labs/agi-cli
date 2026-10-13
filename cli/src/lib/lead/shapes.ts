import { isAgentId } from '../types.js';
import type { ProjectDef } from '../projects.js';

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

export function appendNote(memory: string, note: string): string {
  const clean = note.replace(/\s+/g, ' ').trim();
  if (!clean) throw new LeadToolError('The note is empty.');
  if (clean.length > MAX_NOTE_CHARS) throw new LeadToolError(`A note is at most ${MAX_NOTE_CHARS} characters.`);
  const lines = memory.split('\n').filter((l) => l.trim().length > 0);
  lines.push(`- ${clean}`);
  return `${lines.slice(-MAX_MEMORY_LINES).join('\n')}\n`;
}

