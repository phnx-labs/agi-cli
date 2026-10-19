import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { claimConfirm, type ConfirmRecord } from './confirm.js';
import { summarize, type LeadEvent, type LeadRef } from './events.js';
import { agentsCliLaunch, workerEnv, type Launch } from './harness.js';
import { ensureLeadDir, leadRoot, type LeadPaths } from './paths.js';
import { LeadToolError, assertHeldArgv } from './shapes.js';
import { appendHistory } from './store.js';

const LINEAR_TIMEOUT_MS = 20_000;
const AGENTS_TIMEOUT_MS = 60_000;

function lastLine(text: string, fallback: string): string {
  return text.trim().split('\n').pop()?.trim() || fallback;
}

export function runLinear(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('linear', args, { timeout: LINEAR_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new LeadToolError(`linear ${args[0]} failed: ${lastLine(String(stderr || err.message), 'no output')}`));
      else resolve(stdout);
    });
  });
}

export function runAgents(args: string[], launch: (args: string[]) => Launch = agentsCliLaunch): Promise<string> {
  const l = launch(args);
  return new Promise((resolve, reject) => {
    execFile(l.command, l.args, { timeout: AGENTS_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new LeadToolError(`agents ${args.slice(0, 3).join(' ')} failed: ${lastLine(String(stderr || stdout || err.message), 'no output')}`));
      else resolve(stdout);
    });
  });
}

export function spawnLeadWorker(paths: LeadPaths, argv: string[], launch: (args: string[]) => Launch): { log: string; pid: number | undefined } {
  fs.mkdirSync(paths.runs, { recursive: true, mode: 0o700 });
  const log = path.join(paths.runs, `${new Date().toISOString().replace(/[:.]/g, '-')}-${argv[1]}.log`);
  const fd = fs.openSync(log, 'a');
  const l = launch(argv);
  const child = spawn(l.command, l.args, {
    detached: true,
    stdio: ['ignore', fd, fd],
    env: workerEnv(process.env, leadRoot()),
    cwd: os.homedir(),
  });
  fs.closeSync(fd);
  child.unref();
  return { log, pid: child.pid };
}

const CONFIRM_LABEL_WORDS: Record<ConfirmRecord['action'], number> = { stop: 2, answer: 2, send: 1, start: 1, dispatch: 1, pr: 3 };

interface Outcome { ok: boolean; text: string }

async function perform(record: ConfirmRecord, paths: LeadPaths, launch: (args: string[]) => Launch): Promise<Outcome> {
  const failed = (err: unknown) => ({ ok: false, text: `Could not ${record.label.charAt(0).toLowerCase()}${record.label.slice(1)}: ${err instanceof Error ? err.message : String(err)}` });
  if (record.action === 'start' || record.action === 'dispatch') {
    try {
      if (record.linearArgv) await runLinear(record.linearArgv);
      const { log } = spawnLeadWorker(paths, record.argv, launch);
      const ticket = record.linearArgv ? ` ${record.linearArgv[1]} is In Progress, delegated to ${record.argv[1]}.` : '';
      return { ok: true, text: `Started ${record.argv[1]} on: ${record.argv[2].slice(0, 120)}.${ticket} Log: ${log}` };
    } catch (err) {
      return failed(err);
    }
  }
  const l = launch(record.argv);
  const { code, output } = await new Promise<{ code: number; output: string }>((resolve) => {
    const child = spawn(l.command, l.args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout!.on('data', (d: Buffer) => { output += d.toString(); });
    child.stderr!.on('data', (d: Buffer) => { output += d.toString(); });
    child.on('error', (err) => resolve({ code: -1, output: err.message }));
    child.on('exit', (c) => resolve({ code: c ?? -1, output }));
  });
  if (code !== 0) return failed(new Error(lastLine(output, `exit ${code}`)));
  if (record.action === 'stop') return { ok: true, text: `Stopped ${record.label.replace(/^Stop\s+/, '')}.` };
  return { ok: true, text: `Done: ${record.label}.` };
}

export async function runConfirm(
  token: string,
  emit: (e: LeadEvent) => void,
  launch: (args: string[]) => Launch = agentsCliLaunch,
): Promise<boolean> {
  const record = claimConfirm(token);
  if (!Array.isArray(record.argv)) throw new LeadToolError(`Confirm token ${token} was minted by an older agents version; ask the Lead again.`);
  assertHeldArgv(record);
  const paths = ensureLeadDir(record.project);
  const turn = `t_${randomBytes(6).toString('hex')}`;
  const startedAt = Date.now();
  const cmd = `agents ${record.argv.join(' ')}`;
  const label = `agents ${record.argv.slice(0, CONFIRM_LABEL_WORDS[record.action]).join(' ')}`;
  const toolId = `confirm_${record.token}`;
  emit({ type: 'tool', id: toolId, label, cmd, state: 'run' });
  const outcome = await perform(record, paths, launch);
  const secs = Math.round((Date.now() - startedAt) / 10) / 100;
  emit({ type: 'tool', id: toolId, label, state: outcome.ok ? 'ok' : 'fail', secs });
  if (!outcome.ok) {
    emit({ type: 'error', message: outcome.text });
    return false;
  }
  const quoted = /“([^”]+)”/.exec(record.label)?.[1];
  const refs: LeadRef[] = record.sessionId ? [{ kind: 'session', id: record.sessionId, title: quoted ?? record.sessionId.slice(0, 8) }] : [];
  const timing = { boot: 0, model: 0, tools: secs };
  const summary = summarize(outcome.text);
  emit({ type: 'done', turn, text: outcome.text, summary, refs, timing });
  appendHistory(paths, {
    turn,
    at: new Date(startedAt).toISOString(),
    ask: `confirm ${record.token}: ${record.label}`,
    text: outcome.text,
    summary,
    refs,
    tools: [{ label, cmd, state: 'ok', secs }],
    session: record.sessionId ?? '',
    timing,
  });
  return true;
}
