import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { isAgentId } from '../types.js';
import { getCliLaunch } from '../cli-entry.js';
import { loadProjectDef, type ProjectDef } from '../projects.js';
import { atomicWriteFileSync } from '../fs-atomic.js';
import { connectHost, sendRequest } from './client.js';
import { ensureLeadDir, type LeadPaths } from './paths.js';
import { readMemory } from './store.js';

export const MAX_TASK_CHARS = 4_000;
export const MAX_NOTE_CHARS = 500;
export const MAX_MEMORY_LINES = 60;
export const MAX_TASKS_LIMIT = 50;
export const LINEAR_STATUSES = ['open', 'todo', 'progress', 'backlog', 'done'] as const;
const TICKET_RE = /^[A-Z][A-Z0-9]{1,9}-\d{1,6}$/;
const SESSION_RE = /^[0-9a-f][0-9a-f-]{7,35}$/;
const LINEAR_TIMEOUT_MS = 20_000;

export class LeadToolError extends Error {}

export interface LeadToolContext {
  project: string;
  def: ProjectDef;
  paths: LeadPaths;
}

export function leadToolContext(env: NodeJS.ProcessEnv = process.env): LeadToolContext {
  const project = env.AGENTS_LEAD_PROJECT;
  if (!project) throw new LeadToolError('agents lead tool runs only inside a Lead (AGENTS_LEAD_PROJECT is not set).');
  const def = loadProjectDef(project);
  if (!def) throw new LeadToolError(`Unknown project '${project}'.`);
  return { project, def, paths: ensureLeadDir(project) };
}

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

export function assertSendText(text: string): string {
  const body = assertTask(text);
  if (body.startsWith('/')) throw new LeadToolError('Refusing to send a slash command into a session.');
  return body;
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

function runLinear(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('linear', args, { timeout: LINEAR_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new LeadToolError(`linear ${args[0]} failed: ${String(stderr || err.message).trim().split('\n').pop()}`));
      else resolve(stdout);
    });
  });
}

function spawnDetachedRun(paths: LeadPaths, argv: string[], agent: string): string {
  fs.mkdirSync(paths.runs, { recursive: true, mode: 0o700 });
  const log = path.join(paths.runs, `${new Date().toISOString().replace(/[:.]/g, '-')}-${agent}.log`);
  const fd = fs.openSync(log, 'a');
  const launch = getCliLaunch(argv);
  const child = spawn(launch.command, launch.args, { detached: true, stdio: ['ignore', fd, fd] });
  fs.closeSync(fd);
  child.unref();
  return log;
}

async function hostRequest(project: string, req: Record<string, unknown>): Promise<Record<string, unknown>> {
  const socket = await connectHost(project);
  if (!socket) throw new LeadToolError(`The Lead host for '${project}' is not running.`);
  let reply: Record<string, unknown> | null = null;
  await sendRequest(socket, req as never, (obj) => { reply = obj; });
  if (!reply) throw new LeadToolError('The Lead host closed without a reply.');
  if ((reply as { type?: string }).type === 'error') throw new LeadToolError(String((reply as { message?: string }).message));
  return reply;
}

export async function toolRoster(ctx: LeadToolContext, project?: string): Promise<string> {
  const reply = await hostRequest(ctx.project, { op: 'roster', project: project ?? ctx.project });
  return String(reply.text);
}

interface LinearIssue { identifier: string; title: string; state?: { name?: string }; url?: string; description?: string }

export async function toolDispatch(ctx: LeadToolContext, ticket: string, agent: string): Promise<string> {
  assertTicketId(ticket);
  assertAgent(agent);
  const issue = JSON.parse(await runLinear(linearViewArgv(ticket))) as LinearIssue;
  const argv = runArgv(agent, dispatchPrompt(issue.identifier, issue.title), ctx.project);
  await runLinear(linearPickupArgv(issue.identifier, agent));
  const log = spawnDetachedRun(ctx.paths, argv, agent);
  return `Dispatched ${agent} on ${issue.identifier}: ${issue.title}. ${issue.identifier} is In Progress, delegated to ${agent}. Log: ${log}`;
}

export async function toolStart(ctx: LeadToolContext, agent: string, task: string): Promise<string> {
  const argv = runArgv(agent, task, ctx.project);
  const log = spawnDetachedRun(ctx.paths, argv, agent);
  return `Started ${agent} on: ${assertTask(task).slice(0, 120)}. Log: ${log}`;
}

export async function toolSend(ctx: LeadToolContext, session: string, text: string): Promise<string> {
  assertSessionId(session);
  assertSendText(text);
  const reply = await hostRequest(ctx.project, { op: 'resolve', session });
  const id = String(reply.id);
  const argv = sendArgv(id, text);
  const launch = getCliLaunch(argv);
  await new Promise<void>((resolve, reject) => {
    execFile(launch.command, launch.args, { timeout: 60_000 }, (err, _stdout, stderr) => {
      if (err) reject(new LeadToolError(`agents send failed: ${String(stderr || err.message).trim().split('\n').pop()}`));
      else resolve();
    });
  });
  return `Sent to “${String(reply.title)}” (${id.slice(0, 8)}).`;
}

export async function toolStop(ctx: LeadToolContext, session: string): Promise<string> {
  assertSessionId(session);
  const reply = await hostRequest(ctx.project, { op: 'hold-stop', session });
  return `Held for the owner's Confirm: ${String(reply.label)}. Nothing was stopped. Do not retry.`;
}

export async function toolLinearTasks(ctx: LeadToolContext, status: string, limit: number): Promise<string> {
  const raw = JSON.parse(await runLinear(linearTasksArgv(ctx.def, status, limit))) as { issues?: LinearIssue[] };
  const issues = raw.issues ?? [];
  if (issues.length === 0) return `No ${status} tickets.`;
  return issues.map((i) => `${i.identifier} ${i.title}${i.state?.name ? ` (${i.state.name})` : ''}`).join('\n');
}

export async function toolLinearView(id: string): Promise<string> {
  const i = JSON.parse(await runLinear(linearViewArgv(id))) as LinearIssue;
  const desc = (i.description ?? '').slice(0, 1_500);
  return [`${i.identifier} ${i.title}${i.state?.name ? ` (${i.state.name})` : ''}`, desc].filter(Boolean).join('\n');
}

export async function toolLinearCreate(ctx: LeadToolContext, title: string, description?: string): Promise<string> {
  const out = await runLinear(linearCreateArgv(ctx.def, title, description));
  return out.trim().split('\n').slice(-3).join('\n');
}

export function toolRemember(ctx: LeadToolContext, note: string): string {
  atomicWriteFileSync(ctx.paths.memory, appendNote(readMemory(ctx.paths), note));
  return 'Noted.';
}
