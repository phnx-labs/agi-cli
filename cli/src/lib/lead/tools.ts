import { loadProjectDef, type ProjectDef } from '../projects.js';
import { atomicWriteFileSync } from '../fs-atomic.js';
import { connectHost, sendRequest } from './client.js';
import { runAgents, runLinear } from './act.js';
import type { HeldAction } from './confirm.js';
import { ago, type LeadAttention } from './roster.js';
import {
  LeadToolError, answerArgv, appendNote, assertAgent, assertPrNumber, assertRepo, assertSessionId, assertTask, assertTicketId,
  dispatchPrompt, linearCreateArgv, linearPickupArgv, linearTasksArgv, linearViewArgv, prArgv, prFailureArgv, prReadArgv,
  prsListArgv, runArgv, sendArgv, type AnswerValue, type PrVerb,
} from './shapes.js';
import { ensureLeadDir, type LeadPaths } from './paths.js';
import { readMemory } from './store.js';
import { execFile } from 'node:child_process';
import { invocation, resolveSessionsBin } from '../sessions-client.js';
import { machineId, normalizeHost } from '../machine-id.js';

export * from './shapes.js';

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

async function hostRequest(project: string, req: Record<string, unknown>): Promise<Record<string, unknown>> {
  const socket = await connectHost(project);
  if (!socket) throw new LeadToolError(`The Lead host for '${project}' is not running.`);
  let reply: Record<string, unknown> | null = null;
  await sendRequest(socket, req as never, (obj) => { reply = obj; });
  if (!reply) throw new LeadToolError('The Lead host closed without a reply.');
  if ((reply as { type?: string }).type === 'error') throw new LeadToolError(String((reply as { message?: string }).message));
  return reply;
}

async function hold(ctx: LeadToolContext, held: Omit<HeldAction, 'project'>): Promise<string> {
  const reply = await hostRequest(ctx.project, { op: 'hold', held });
  return `Queued for the owner's Confirm: ${String(reply.label)}. Nothing has happened yet. Say what you queued and ask once; do not queue it again.`;
}

export async function toolRoster(ctx: LeadToolContext, project?: string): Promise<string> {
  const reply = await hostRequest(ctx.project, { op: 'roster', project: project ?? ctx.project });
  return String(reply.text);
}

const SESSION_TURNS_CHARS = 12_000;

/** One session's last two turns of conversation (the owner's and the agent's words, no tool calls). */
export async function toolRosterSession(ctx: LeadToolContext, session: string): Promise<string> {
  assertSessionId(session);
  const reply = await hostRequest(ctx.project, { op: 'resolve', session });
  const id = String(reply.id);
  const host = String(reply.host ?? '');
  const remote = host && normalizeHost(host) !== machineId() ? ['-H', host] : [];
  const { command, prefix } = invocation(resolveSessionsBin());
  const text = await new Promise<string>((resolve, reject) => {
    execFile(command, [...prefix, id, '--include', 'user,assistant', '--last', '2', '--markdown', ...remote],
      { timeout: 30_000, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
        if (err) reject(new LeadToolError(`sessions ${id.slice(0, 8)} failed: ${(stderr || err.message).trim().slice(0, 300)}`));
        else resolve(stdout);
      });
  });
  const body = text.length > SESSION_TURNS_CHARS ? `…${text.slice(-SESSION_TURNS_CHARS)}` : text;
  return `Last two turns of “${String(reply.title)}” (${id.slice(0, 8)}):\n${body}`;
}

export async function toolAttention(ctx: LeadToolContext): Promise<string> {
  const reply = await hostRequest(ctx.project, { op: 'attention' });
  return String(reply.text);
}

interface LinearIssue { identifier: string; title: string; state?: { name?: string }; url?: string; description?: string; updatedAt?: string }

export async function toolDispatch(ctx: LeadToolContext, ticket: string, agent: string): Promise<string> {
  assertTicketId(ticket);
  assertAgent(agent);
  const issue = JSON.parse(await runLinear(linearViewArgv(ticket))) as LinearIssue;
  const prompt = dispatchPrompt(issue.identifier, issue.title);
  return hold(ctx, {
    action: 'dispatch',
    argv: runArgv(agent, prompt, ctx.project),
    linearArgv: linearPickupArgv(issue.identifier, agent),
    label: `Dispatch ${agent} on ${issue.identifier}: ${issue.title}`,
    detail: prompt,
  });
}

export async function toolStart(ctx: LeadToolContext, agent: string, task: string): Promise<string> {
  const argv = runArgv(agent, task, ctx.project);
  return hold(ctx, { action: 'start', argv, label: `Start ${agent} on: ${argv[2].slice(0, 80)}`, detail: argv[2] });
}

export async function toolSend(ctx: LeadToolContext, session: string, text: string): Promise<string> {
  assertSessionId(session);
  const argv = sendArgv(session, text);
  const reply = await hostRequest(ctx.project, { op: 'resolve', session });
  const id = String(reply.id);
  return hold(ctx, { action: 'send', argv: sendArgv(id, text), sessionId: id, label: `Send to “${String(reply.title)}”`, detail: argv[6] });
}

export async function toolAnswer(ctx: LeadToolContext, key: string, value: AnswerValue): Promise<string> {
  const argv = answerArgv(key, value);
  const reply = await hostRequest(ctx.project, { op: 'attention-item', key });
  const ask = reply.ask as LeadAttention;
  let detail: string;
  if ('choice' in value) {
    const choice = ask.choices.find((c) => c.id === value.choice);
    if (!choice) {
      const known = ask.choices.map((c) => `${c.id}=${c.label}`).join(', ');
      throw new LeadToolError(`'${value.choice}' is not a choice of this ask (${known || 'it takes a free-text answer'}).`);
    }
    detail = choice.label;
  } else detail = argv[4];
  return hold(ctx, { action: 'answer', argv, sessionId: ask.sessionId, label: `Answer “${String(reply.title)}”`, detail });
}

export async function toolStop(ctx: LeadToolContext, session: string): Promise<string> {
  assertSessionId(session);
  const reply = await hostRequest(ctx.project, { op: 'hold-stop', session });
  return `Queued for the owner's Confirm: ${String(reply.label)}. Nothing was stopped. Do not retry.`;
}

interface ListedPr { number: number; title: string; isDraft?: boolean; headSha?: string; url?: string; updatedAt?: string }
interface PrsEnvelope { repositories: Array<{ slug: string; error?: string; pullRequests: ListedPr[] }> }

export async function toolPrsList(ctx: LeadToolContext, repo?: string): Promise<string> {
  const envelope = JSON.parse(await runAgents(prsListArgv(ctx.project, repo))) as PrsEnvelope;
  const lines: string[] = [];
  for (const r of envelope.repositories) {
    if (r.error) { lines.push(`${r.slug}: could not be read (${r.error})`); continue; }
    for (const pr of r.pullRequests) lines.push(`${r.slug}#${pr.number}${pr.isDraft ? ' [draft]' : ''} ${pr.title}${pr.updatedAt ? ` · updated ${ago(pr.updatedAt, Date.now())}` : ''}`);
  }
  return lines.length ? lines.join('\n') : `No open PRs for ${ctx.project}.`;
}

async function readPr(ctx: LeadToolContext, repo: string, number: number): Promise<ListedPr> {
  const envelope = JSON.parse(await runAgents(prReadArgv(ctx.project, repo, number))) as PrsEnvelope;
  const pr = envelope.repositories.flatMap((r) => r.pullRequests).find((p) => p.number === number);
  if (!pr) throw new LeadToolError(`${repo}#${number} is not an open PR of ${ctx.project}.`);
  return pr;
}

async function failingRunIds(ctx: LeadToolContext, repo: string, sha: string): Promise<number[]> {
  const report = JSON.parse(await runAgents(prFailureArgv(ctx.project, repo, sha))) as { checks: Array<{ runId: number | null }>; error?: string };
  if (report.error) throw new LeadToolError(`Could not read the failing checks: ${report.error}`);
  return [...new Set(report.checks.flatMap((c) => (c.runId === null ? [] : [c.runId])))];
}

const PR_LABEL: Record<PrVerb, string> = { merge: 'Merge', comment: 'Comment on', ready: 'Mark ready', rerun: 'Re-run failed CI of', close: 'Close' };

export async function toolPrAct(
  ctx: LeadToolContext,
  verb: PrVerb,
  opts: { repo: string; number: string; sha?: string; body?: string; runId?: string },
): Promise<string> {
  const repo = assertRepo(opts.repo);
  const number = assertPrNumber(opts.number);
  if (opts.body !== undefined && verb !== 'comment') throw new LeadToolError('--body applies only to prs comment.');
  if (opts.runId !== undefined && verb !== 'rerun') throw new LeadToolError('--run-id applies only to prs rerun.');
  if (verb === 'comment') assertTask(opts.body ?? '');
  const pr = await readPr(ctx, repo, number);
  const sha = opts.sha ?? (verb === 'merge' || verb === 'rerun' ? pr.headSha : undefined);
  if ((verb === 'merge' || verb === 'rerun') && !sha) throw new LeadToolError(`${repo}#${number} has no head commit to pin; pass --sha.`);
  let runId: number | undefined;
  if (verb === 'rerun') {
    const runs = await failingRunIds(ctx, repo, sha!);
    runId = opts.runId !== undefined ? assertPrNumber(opts.runId) : runs.length === 1 ? runs[0] : undefined;
    if (runId === undefined) {
      throw new LeadToolError(runs.length === 0
        ? `${repo}#${number} has no failing GitHub Actions run at ${sha!.slice(0, 7)}.`
        : `${repo}#${number} has ${runs.length} failing runs (${runs.join(', ')}); pass --run-id <id>.`);
    }
    if (!runs.includes(runId)) throw new LeadToolError(`Run ${runId} is not a failing run of ${repo}#${number}.`);
  }
  const argv = prArgv(ctx.project, verb, { repo, number, sha: verb === 'rerun' ? undefined : sha, body: opts.body, runId });
  return hold(ctx, {
    action: 'pr',
    argv,
    label: `${PR_LABEL[verb]} ${repo}#${number} “${pr.title}”`,
    detail: verb === 'comment' ? argv[argv.indexOf('--body') + 1] : pr.title,
  });
}

export async function toolLinearTasks(ctx: LeadToolContext, status: string, limit: number): Promise<string> {
  const raw = JSON.parse(await runLinear(linearTasksArgv(ctx.def, status, limit))) as { issues?: LinearIssue[] };
  return formatLinearTasks(raw.issues ?? [], status, limit, Date.now());
}

export function formatLinearTasks(issues: LinearIssue[], status: string, limit: number, nowMs: number): string {
  if (issues.length === 0) return `No ${status} tickets.`;
  const when = (i: LinearIssue) => (i.updatedAt ? Date.parse(i.updatedAt) || 0 : 0);
  const shown = [...issues].sort((a, b) => when(b) - when(a)).slice(0, limit);
  const lines = shown.map((i) => `${i.identifier} ${i.title}${i.state?.name ? ` (${i.state.name})` : ''}${i.updatedAt ? ` · updated ${ago(i.updatedAt, nowMs)}` : ''}`);
  if (issues.length > shown.length) lines.push(`(${issues.length - shown.length} older ${status} tickets not shown)`);
  return lines.join('\n');
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
