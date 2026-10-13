import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFile } from 'node:child_process';
import type { ProjectDef } from '../projects.js';
import { formatRosterRow, type RosterSnapshot } from './roster.js';

export const BRIEF_FETCH_TIMEOUT_MS = 8_000;
const DIGEST_MAX_CHARS = 2_500;

export interface BriefTicket { id: string; title: string; state?: string; url?: string }
export interface BriefPr { number: number; title: string; url: string; draft: boolean }

export interface BriefInputs {
  project: string;
  def: ProjectDef;
  agentsDigest: string | null;
  roster: RosterSnapshot;
  fleet: string;
  tickets: BriefTicket[] | { error: string };
  prs: BriefPr[] | { error: string };
  memory: string;
}

export const LEAD_RULES = [
  'You are the Lead for this project: one long-lived agent the owner talks or types to. You dispatch and manage coding agents through CLIs; you never edit files yourself.',
  'Your shell may run only agents ps|send|run|feed, sessions, artifacts list, linear and jq. Pipe JSON through jq to keep it small; do not add 2>&1 or other redirects, which get the command denied.',
  'Answer from tool output only. When you do not know, run the command that tells you (agents ps --json, agents feed, linear tasks, sessions). Never guess.',
  'Name ticket ids (PHNX-1234), PR numbers (#3607) and session titles plainly, exactly as written, because the clients turn them into links.',
  'Be short and dispatch-first: one or two sentences, lead with what you did or found. No preamble, no headings.',
  'Never speak: you have no voice channel; the client shows your text.',
  'Dispatch ("put Claude on PHNX-4365") is two commands: `linear update <id> --state Doing --delegate <Agent>`, then `agents run <agent> "Work on <id>: <title>" --headless -P <project>`.',
  'Stopping or killing a session needs the owner\'s Confirm. Run `agents ps stop <id>` once: it is held for the Confirm button and not executed by you. Do not retry it, do not use kill, and say that it is waiting for Confirm.',
  'Each later message starts with a [State delta] block: what changed in this project\'s live sessions since your last turn, then a fleet line counting every live session by status. Both come from the live session feed and count as tool output: answer "what is running" from them and the Live sessions list. Run `agents ps --json` (about 12 s across the fleet; add --local or -D <device> to narrow it) only for detail they lack.',
];

function run(command: string, args: string[], cwd: string | undefined): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(command, args, { cwd, timeout: BRIEF_FETCH_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        const detail = String(stderr || err.message).trim().split('\n')[0];
        reject(new Error(`${command} ${args.slice(0, 2).join(' ')} failed: ${detail}`));
        return;
      }
      resolve(stdout);
    });
  });
}

export function agentsMdDigest(root: string | undefined): string | null {
  if (!root) return null;
  let text: string;
  try {
    text = fs.readFileSync(path.join(root, 'AGENTS.md'), 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
  const lines = text.split('\n');
  const title = lines.find((l) => l.startsWith('# ')) ?? '';
  const firstPara: string[] = [];
  let started = false;
  for (const line of lines) {
    if (line.startsWith('#')) { if (started) break; continue; }
    if (!line.trim()) { if (started) break; continue; }
    started = true;
    firstPara.push(line.trim());
  }
  const headings = lines.filter((l) => /^##\s/.test(l)).map((l) => l.replace(/^##\s+/, ''));
  const digest = [title, firstPara.join(' '), headings.length ? `Sections: ${headings.join(' · ')}` : '']
    .filter(Boolean)
    .join('\n');
  return digest.length > DIGEST_MAX_CHARS ? `${digest.slice(0, DIGEST_MAX_CHARS - 1)}…` : digest;
}

export async function fetchOpenTickets(def: ProjectDef, cwd: string | undefined): Promise<BriefTicket[]> {
  const linearProject = def.linear?.projectId ?? def.linear?.name;
  if (!linearProject) throw new Error(`project '${def.name}' has no linear binding`);
  const raw = JSON.parse(await run('linear', ['tasks', '--project', linearProject, '--status', 'open', '--limit', '20', '--json'], cwd)) as {
    issues?: Array<{ identifier: string; title: string; state?: { name?: string }; url?: string }>;
  };
  return (raw.issues ?? []).map((i) => ({ id: i.identifier, title: i.title, state: i.state?.name, url: i.url }));
}

export async function fetchOpenPrs(repo: string | undefined, cwd: string | undefined): Promise<BriefPr[]> {
  if (!repo) throw new Error('project has no GitHub repo');
  const raw = JSON.parse(await run('gh', ['api', `repos/${repo}/pulls?state=open&per_page=20`], cwd)) as Array<{
    number: number; title: string; html_url: string; draft?: boolean;
  }>;
  return raw.map((p) => ({ number: p.number, title: p.title, url: p.html_url, draft: p.draft === true }));
}

export function projectRepo(def: ProjectDef): string | undefined {
  return def.repo ?? def.repos?.[0]?.slug;
}

export function buildBrief(inputs: BriefInputs): string {
  const { def } = inputs;
  const out: string[] = [];
  out.push(`# Lead brief: ${inputs.project}`);
  if (def.description) out.push(def.description);
  const goal = def.goals?.map((g) => g.objective).join('; ');
  out.push(`Linear project: ${def.linear?.name ?? '(none)'}${goal ? ` · Goal: ${goal}` : ''}`);
  const repo = projectRepo(def);
  if (repo) out.push(`Repository: ${repo}`);
  out.push('', '## Rules', ...LEAD_RULES.map((r) => `- ${r}`));
  if (inputs.agentsDigest) out.push('', '## AGENTS.md digest', inputs.agentsDigest);
  const rows = Object.values(inputs.roster);
  out.push('', `## Live sessions (${rows.length})`, ...(rows.length ? rows.map(formatRosterRow) : ['None.']), inputs.fleet);
  out.push('', '## Open tickets');
  if ('error' in inputs.tickets) out.push(`Unavailable: ${inputs.tickets.error}`);
  else if (inputs.tickets.length === 0) out.push('None.');
  else out.push(...inputs.tickets.map((t) => `- ${t.id} ${t.title}${t.state ? ` (${t.state})` : ''}`));
  out.push('', '## Open PRs');
  if ('error' in inputs.prs) out.push(`Unavailable: ${inputs.prs.error}`);
  else if (inputs.prs.length === 0) out.push('None.');
  else out.push(...inputs.prs.map((p) => `- #${p.number} ${p.title}${p.draft ? ' (draft)' : ''}`));
  out.push('', '## Memory from earlier Lead sessions', inputs.memory.trim() || 'None yet.');
  return out.join('\n');
}

export function briefSummary(inputs: BriefInputs): string[] {
  const count = (v: unknown[] | { error: string }, noun: string) =>
    Array.isArray(v) ? `${v.length} ${noun}` : `${noun} unavailable`;
  return [
    `project ${inputs.project}${inputs.def.linear?.name ? ` (Linear: ${inputs.def.linear.name})` : ''}`,
    `${Object.keys(inputs.roster).length} live sessions`,
    count(inputs.tickets, 'open tickets'),
    count(inputs.prs, 'open PRs'),
    inputs.agentsDigest ? 'AGENTS.md digest' : 'no AGENTS.md',
    inputs.memory.trim() ? 'memory.md carried over' : 'no memory yet',
  ];
}

export function fleetLine(rows: Array<{ status: string; host: string }>, selfExcluded: number): string {
  const byStatus = new Map<string, number>();
  for (const r of rows) byStatus.set(r.status, (byStatus.get(r.status) ?? 0) + 1);
  const parts = [...byStatus.entries()].sort((a, b) => b[1] - a[1]).map(([status, n]) => `${n} ${status}`);
  const hosts = new Set(rows.map((r) => r.host)).size;
  const self = selfExcluded > 0 ? ' (not counting you)' : '';
  const plural = (n: number, noun: string) => `${n} ${noun}${n === 1 ? '' : 's'}`;
  return `Fleet: ${plural(rows.length, 'live session')} on ${plural(hosts, 'device')}${self}${parts.length ? `: ${parts.join(', ')}` : ''}.`;
}

export function composeTurnMessage(opts: {
  brief?: string;
  delta: string[];
  text: string;
  voiceSecs?: number;
}): string {
  const parts: string[] = [];
  if (opts.brief) parts.push(opts.brief, '');
  if (opts.delta.length) parts.push('[State delta]', ...opts.delta, '');
  if (opts.voiceSecs !== undefined) {
    parts.push(`[Dictated by voice, ${opts.voiceSecs}s; the transcript may contain recognition errors]`);
  }
  parts.push(opts.text);
  return parts.join('\n');
}
