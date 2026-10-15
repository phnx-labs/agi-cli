import { execFile } from 'node:child_process';
import { getCliLaunch } from '../cli-entry.js';
import { loadProjectDef, type ProjectDef } from '../projects.js';
import { linearSpawnEnv } from '../linear-projects.js';
import { atomicWriteFileSync } from '../fs-atomic.js';
import { connectHost, sendRequest } from './client.js';
import {
  LeadToolError, appendNote, assertAgent, assertSendText, assertSessionId, assertTask, assertTicketId, dispatchPrompt,
  linearCreateArgv, linearPickupArgv, linearTasksArgv, linearViewArgv, runArgv, sendArgv,
} from './shapes.js';
import { ensureLeadDir, type LeadPaths } from './paths.js';
import { readMemory } from './store.js';

export * from './shapes.js';

const LINEAR_TIMEOUT_MS = 20_000;

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

function runLinear(def: ProjectDef, args: string[]): Promise<string> {
  const env = linearSpawnEnv(def.linear?.profile);
  return new Promise((resolve, reject) => {
    execFile('linear', args, { timeout: LINEAR_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024, env }, (err, stdout, stderr) => {
      if (err) reject(new LeadToolError(`linear ${args[0]} failed: ${String(stderr || err.message).trim().split('\n').pop()}`));
      else resolve(stdout);
    });
  });
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

async function spawnWorker(ctx: LeadToolContext, agent: string, prompt: string): Promise<string> {
  const reply = await hostRequest(ctx.project, { op: 'spawn', agent, prompt });
  return String(reply.log);
}

export async function toolRoster(ctx: LeadToolContext, project?: string): Promise<string> {
  const reply = await hostRequest(ctx.project, { op: 'roster', project: project ?? ctx.project });
  return String(reply.text);
}

interface LinearIssue { identifier: string; title: string; state?: { name?: string }; url?: string; description?: string }

export async function toolDispatch(ctx: LeadToolContext, ticket: string, agent: string): Promise<string> {
  assertTicketId(ticket);
  assertAgent(agent);
  const issue = JSON.parse(await runLinear(ctx.def, linearViewArgv(ticket))) as LinearIssue;
  const prompt = dispatchPrompt(issue.identifier, issue.title);
  runArgv(agent, prompt, ctx.project);
  await runLinear(ctx.def, linearPickupArgv(issue.identifier, agent));
  const log = await spawnWorker(ctx, agent, prompt);
  return `Dispatched ${agent} on ${issue.identifier}: ${issue.title}. ${issue.identifier} is In Progress, delegated to ${agent}. Log: ${log}`;
}

export async function toolStart(ctx: LeadToolContext, agent: string, task: string): Promise<string> {
  runArgv(agent, task, ctx.project);
  const log = await spawnWorker(ctx, agent, task);
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
  const raw = JSON.parse(await runLinear(ctx.def, linearTasksArgv(ctx.def, status, limit))) as { issues?: LinearIssue[] };
  const issues = raw.issues ?? [];
  if (issues.length === 0) return `No ${status} tickets.`;
  return issues.map((i) => `${i.identifier} ${i.title}${i.state?.name ? ` (${i.state.name})` : ''}`).join('\n');
}

export async function toolLinearView(ctx: LeadToolContext, id: string): Promise<string> {
  const i = JSON.parse(await runLinear(ctx.def, linearViewArgv(id))) as LinearIssue;
  const desc = (i.description ?? '').slice(0, 1_500);
  return [`${i.identifier} ${i.title}${i.state?.name ? ` (${i.state.name})` : ''}`, desc].filter(Boolean).join('\n');
}

export async function toolLinearCreate(ctx: LeadToolContext, title: string, description?: string): Promise<string> {
  const out = await runLinear(ctx.def, linearCreateArgv(ctx.def, title, description));
  return out.trim().split('\n').slice(-3).join('\n');
}

export function toolRemember(ctx: LeadToolContext, note: string): string {
  atomicWriteFileSync(ctx.paths.memory, appendNote(readMemory(ctx.paths), note));
  return 'Noted.';
}
