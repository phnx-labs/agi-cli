import * as fs from 'node:fs';
import * as net from 'node:net';
import * as readline from 'node:readline';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { getCliLaunch } from '../cli-entry.js';
import { loadProjectDef } from '../projects.js';
import { ensureLeadDir, leadPaths, type LeadPaths } from './paths.js';
import { LeadHost, type LeadRequest } from './host.js';
import { agentsCliLaunch, leadModel, type Launch } from './harness.js';
import { claimConfirm } from './confirm.js';
import { summarize, type LeadEvent, type LeadRef } from './events.js';
import { appendHistory } from './store.js';

export const HOST_START_TIMEOUT_MS = 15_000;
const HOST_POLL_MS = 100;

export function requireProjectDef(project: string) {
  const def = loadProjectDef(project);
  if (!def) throw new Error(`Unknown project '${project}'. Run 'agents projects list' for the names.`);
  return def;
}

function connect(paths: LeadPaths): Promise<net.Socket | null> {
  return new Promise((resolve) => {
    const socket = net.connect(paths.endpoint);
    socket.once('connect', () => resolve(socket));
    socket.once('error', () => resolve(null));
  });
}

export async function connectHost(project: string): Promise<net.Socket | null> {
  return connect(leadPaths(project));
}

export async function ensureHost(project: string): Promise<net.Socket> {
  const paths = ensureLeadDir(project);
  const existing = await connect(paths);
  if (existing) return existing;
  const launch = getCliLaunch(['__lead-host', project]);
  const logFd = fs.openSync(paths.log, 'a');
  const child = spawn(launch.command, launch.args, { detached: true, stdio: ['ignore', logFd, logFd] });
  fs.closeSync(logFd);
  let exited: number | null = null;
  child.once('exit', (code) => { exited = code ?? -1; });
  child.unref();
  const deadline = Date.now() + HOST_START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const socket = await connect(paths);
    if (socket) return socket;
    if (exited !== null) {
      const raced = await connect(paths);
      if (raced) return raced;
      throw new Error(`The Lead host for '${project}' exited with code ${exited} before listening; see ${paths.log}`);
    }
    await new Promise((r) => setTimeout(r, HOST_POLL_MS));
  }
  throw new Error(`The Lead host for '${project}' did not start listening within ${HOST_START_TIMEOUT_MS / 1000}s; see ${paths.log}`);
}

export async function sendRequest(socket: net.Socket, req: LeadRequest, onLine: (obj: Record<string, unknown>) => void): Promise<void> {
  socket.write(`${JSON.stringify(req)}\n`);
  const rl = readline.createInterface({ input: socket });
  await new Promise<void>((resolve, reject) => {
    rl.on('line', (line) => {
      if (!line.trim()) return;
      onLine(JSON.parse(line) as Record<string, unknown>);
    });
    socket.once('error', reject);
    rl.once('close', () => resolve());
  });
}

export async function runLeadHost(project: string): Promise<number> {
  const def = requireProjectDef(project);
  const paths = ensureLeadDir(project);
  const log = (line: string) => process.stdout.write(`${line}\n`);
  const host = new LeadHost({
    project,
    def,
    paths,
    model: leadModel(),
    harness: agentsCliLaunch,
    feed: agentsCliLaunch(['feed', 'watch', '--json']),
    log,
  });
  try {
    await host.start();
  } catch (err) {
    log(`host start failed: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
  const stop = () => { void host.shutdown(); };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
  process.on('SIGHUP', () => {});
  await host.closed;
  return 0;
}

export async function runConfirm(
  token: string,
  emit: (e: LeadEvent) => void,
  launch: (args: string[]) => Launch = agentsCliLaunch,
): Promise<boolean> {
  const record = claimConfirm(token);
  const paths = ensureLeadDir(record.project);
  const turn = `t_${randomBytes(6).toString('hex')}`;
  const startedAt = Date.now();
  const args = ['ps', 'stop', record.sessionId];
  const cmd = `agents ${args.join(' ')}`;
  const toolId = `confirm_${record.token}`;
  emit({ type: 'tool', id: toolId, label: 'agents ps stop', cmd, state: 'run' });
  const l = launch(args);
  const { code, output } = await new Promise<{ code: number; output: string }>((resolve) => {
    const child = spawn(l.command, l.args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout!.on('data', (d: Buffer) => { output += d.toString(); });
    child.stderr!.on('data', (d: Buffer) => { output += d.toString(); });
    child.on('error', (err) => resolve({ code: -1, output: err.message }));
    child.on('exit', (c) => resolve({ code: c ?? -1, output }));
  });
  const secs = Math.round((Date.now() - startedAt) / 10) / 100;
  const ok = code === 0;
  emit({ type: 'tool', id: toolId, label: 'agents ps stop', state: ok ? 'ok' : 'fail', secs });
  const title = record.label.replace(/^Stop\s+/, '');
  const text = ok
    ? `Stopped ${title}.`
    : `Could not stop ${title}: ${output.trim().split('\n').pop() ?? `exit ${code}`}`;
  if (!ok) {
    emit({ type: 'error', message: text });
    return false;
  }
  const refs: LeadRef[] = [{ kind: 'session', id: record.sessionId, title: title.replace(/^“|”$/g, '') }];
  const timing = { boot: 0, model: 0, tools: secs };
  const summary = summarize(text);
  emit({ type: 'done', turn, text, summary, refs, timing });
  appendHistory(paths, {
    turn,
    at: new Date(startedAt).toISOString(),
    ask: `confirm ${record.token}: ${record.label}`,
    text,
    summary,
    refs,
    tools: [{ label: 'agents ps stop', cmd, state: 'ok', secs }],
    session: record.sessionId,
    timing,
  });
  return true;
}
