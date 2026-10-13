import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LeadHost, isLeadRow, readHostRecord, type LeadStatus } from './host.js';
import { connectHost, runConfirm, sendRequest } from './client.js';
import { ensureLeadDir, leadRoot, type LeadPaths } from './paths.js';
import { ConfirmError } from './confirm.js';
import { readHistory, readSessionState } from './store.js';
import { toolRoster, toolStop } from './tools.js';
import type { LeadEvent } from './events.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const FAKE_CLAUDE = path.join(here, 'testdata', 'fake-claude.mjs');
const FAKE_FEED = path.join(here, 'testdata', 'fake-feed.mjs');
const PROJECT = 'demo';
const ROW_ID = 'abcd1234-0000-4000-8000-000000000001';
const DEF = { name: PROJECT, repo: 'acme/demo', linear: { name: 'Demo' }, goals: [{ objective: 'Ship the demo' }] };

let host: LeadHost;
let paths: LeadPaths;
let logFile: string;
let workerDump: string;
const childEnv: NodeJS.ProcessEnv = {};

function harnessLog(): Array<{ argv?: string[]; cwd?: string; input?: string }> {
  return fs.readFileSync(logFile, 'utf-8').trim().split('\n').map((l) => JSON.parse(l));
}

async function ask(text: string, voice?: number): Promise<LeadEvent[]> {
  const socket = await connectHost(PROJECT);
  if (!socket) throw new Error('host not listening');
  const events: LeadEvent[] = [];
  await sendRequest(socket, { op: 'ask', text, ...(voice !== undefined ? { voice } : {}) }, (e) => events.push(e as unknown as LeadEvent));
  return events;
}

function done(events: LeadEvent[]): Extract<LeadEvent, { type: 'done' }> {
  const d = events.find((e) => e.type === 'done');
  if (!d || d.type !== 'done') throw new Error(`no done event in ${JSON.stringify(events)}`);
  return d;
}

function turnEvent(events: LeadEvent[]): Extract<LeadEvent, { type: 'turn' }> {
  const t = events[0];
  if (t?.type !== 'turn') throw new Error(`first event is not turn: ${JSON.stringify(events[0])}`);
  return t;
}

describe('Lead host over a fake stream-json harness', () => {
  beforeAll(async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lead-it-'));
    logFile = path.join(tmp, 'harness.ndjson');
    workerDump = path.join(tmp, 'worker.json');
    paths = ensureLeadDir(PROJECT);
    Object.assign(childEnv, { PATH: process.env.PATH, HOME: process.env.HOME, FAKE_LEAD_LOG: logFile, FAKE_LEAD_SOCKET: paths.socket });
    host = new LeadHost({
      project: PROJECT,
      def: DEF,
      paths,
      model: 'sonnet',
      version: '9.9.9-test',
      harness: (args) => ({ command: process.execPath, args: [FAKE_CLAUDE, ...args] }),
      feed: { command: process.execPath, args: [FAKE_FEED] },
      childEnv,
      workerLaunch: (args) => ({
        command: process.execPath,
        args: ['-e', `require('fs').writeFileSync(${JSON.stringify(workerDump)}, JSON.stringify({ argv: process.argv.slice(1), env: process.env }))`, ...args],
      }),
      teamKey: 'PHNX',
      fetchTickets: async () => [{ id: 'PHNX-4365', title: 'Rush MCP server', url: 'https://linear.app/acme/issue/PHNX-4365' }],
      fetchPrs: async () => [{ number: 3607, title: 'Lead CLI', url: 'https://github.com/acme/demo/pull/3607', draft: false, open: true }],
    });
    await host.start();
  });

  afterAll(async () => {
    await host.shutdown();
  });

  it('records version and model, locks the host, and keeps the socket private', () => {
    expect(readHostRecord(paths)).toMatchObject({ pid: process.pid, version: '9.9.9-test', model: 'sonnet', project: PROJECT });
    expect(fs.readFileSync(paths.lock, 'utf-8')).toBe(String(process.pid));
    expect(fs.statSync(paths.socket).mode & 0o777).toBe(0o600);
    const settings = JSON.parse(fs.readFileSync(paths.settings, 'utf-8'));
    expect(settings.permissions.allow).toEqual(expect.arrayContaining(['Bash(agents lead tool roster:*)', 'Bash(agents lead tool stop:*)']));
    expect(JSON.stringify(settings.permissions.allow)).not.toMatch(/Bash\((agents ps|agents run|agents send|linear|jq)[ :]/);
  });

  it('cold-starts isolated, with the brief, and finishes with gated refs, summary and history', async () => {
    const events = await ask('hello there', 3.2);
    const turn = turnEvent(events);
    expect(turn).toMatchObject({ project: PROJECT, engine: 'cold' });
    expect(events[1]).toEqual({ type: 'status', state: 'booting' });
    const d = done(events);
    expect(d.summary).toBe('Turn 1.');
    expect(d.refs).toEqual([
      { kind: 'ticket', id: 'PHNX-4365', url: 'https://linear.app/acme/issue/PHNX-4365', title: 'Rush MCP server' },
      { kind: 'pr', repo: 'acme/demo', number: 3607, url: 'https://github.com/acme/demo/pull/3607' },
      { kind: 'session', id: ROW_ID, title: 'Fix the flaky login test', host: 'box-a' },
    ]);
    expect(d.timing.boot).toBeGreaterThan(0);

    const log = harnessLog();
    const argv = log[0].argv!;
    expect(log[0].cwd).toBe(fs.realpathSync(paths.dir));
    expect(argv.slice(0, 4)).toEqual(['run', 'claude', '--headless', '--quiet']);
    expect(argv).not.toContain('-P');
    expect(argv[argv.indexOf('--cwd') + 1]).toBe(paths.dir);
    expect(argv[argv.indexOf('--session-id') + 1]).toBe(turn.session);
    expect(argv).toEqual(expect.arrayContaining(['--setting-sources', 'local', '--settings', paths.settings, '--strict-mcp-config', '--permission-mode', 'dontAsk']));
    const first = log[1].input!;
    expect(first).toContain('# Lead brief: demo');
    expect(first).toContain('## Live sessions (1)');
    expect(first).not.toContain('Other project work');
    expect(first).not.toContain('lead-demo');
    expect(first).toContain('Fleet: 2 live sessions on 1 device (not counting you): 2 running.');
    expect(first).toContain('[Dictated by voice, 3.2s');

    expect(readHistory(paths)).toEqual([expect.objectContaining({ turn: turn.turn, ask: 'hello there', voice: 3.2, summary: 'Turn 1.' })]);
  });

  it('reuses the warm process with a state delta and serves the roster tool from the feed', async () => {
    const before = harnessLog().length;
    const events = await ask('ROSTER please');
    expect(turnEvent(events).engine).toBe('warm');
    const tools = events.filter((e) => e.type === 'tool');
    expect(tools[0]).toMatchObject({ id: 'toolu_roster', label: 'roster', cmd: 'agents lead tool roster', state: 'run' });
    expect(tools[1]).toMatchObject({ id: 'toolu_roster', state: 'ok' });
    const log = harnessLog().slice(before);
    expect(log.every((l) => l.argv === undefined)).toBe(true);
    expect(log[0].input!.startsWith("[State delta]\nNo changes to this project's sessions.\nFleet: 2 live sessions")).toBe(true);
    const roster = await toolRoster({ project: PROJECT, def: DEF, paths });
    expect(roster).toContain('Live sessions for demo (1):');
    expect(roster).toContain('abcd1234 “Fix the flaky login test” running on box-a');
    expect(roster).not.toContain('lead-demo');
  });

  it('turns the stop tool into a single-use confirm, never a stop', async () => {
    const events = await ask('STOP abcd1234');
    const confirm = events.find((e) => e.type === 'confirm');
    expect(confirm).toMatchObject({ action: 'stop', sessionId: ROW_ID, label: 'Stop “Fix the flaky login test”' });
    expect(events.some((e) => e.type === 'tool')).toBe(false);
    const token = (confirm as { token: string }).token;

    const ran: string[][] = [];
    const confirmEvents: LeadEvent[] = [];
    const ok = await runConfirm(token, (e) => confirmEvents.push(e), (args) => {
      ran.push(args);
      return { command: process.execPath, args: ['-e', 'process.exit(0)'] };
    });
    expect(ok).toBe(true);
    expect(ran).toEqual([['ps', 'stop', ROW_ID]]);
    expect(done(confirmEvents).text).toBe('Stopped “Fix the flaky login test”.');
    await expect(runConfirm(token, () => {})).rejects.toBeInstanceOf(ConfirmError);

    const unknown = await toolStop({ project: PROJECT, def: DEF, paths }, 'deadbeef');
    expect(unknown).toContain('Stop session deadbeef');
  });

  it('recovers a dead process with --resume and no second brief', async () => {
    const session = readSessionState(paths)!.sessionId;
    expect((await ask('CRASH now')).at(-1)).toMatchObject({ type: 'error' });
    const before = harnessLog().length;
    const events = await ask('are you back?');
    expect(turnEvent(events)).toMatchObject({ engine: 'cold', session });
    done(events);
    const log = harnessLog().slice(before);
    expect(log[0].argv).toEqual(expect.arrayContaining(['--resume', session]));
    expect(log[1].input!.startsWith('[State delta]')).toBe(true);
  });

  it('keeps the session and errors when a resume fails for another reason', async () => {
    const session = readSessionState(paths)!.sessionId;
    await ask('CRASH again');
    childEnv.FAKE_LEAD_RESUME_ERROR = 'API Error: 429 rate_limit_error';
    try {
      const events = await ask('still there?');
      expect(events.at(-1)).toMatchObject({ type: 'error', message: expect.stringContaining('429') });
      expect(readSessionState(paths)!.sessionId).toBe(session);
    } finally {
      delete childEnv.FAKE_LEAD_RESUME_ERROR;
    }
  });

  it('starts fresh from the brief only when the session is gone', async () => {
    const old = readSessionState(paths)!.sessionId;
    childEnv.FAKE_LEAD_RESUME_ERROR = 'No conversation found with session ID: x';
    childEnv.FAKE_LEAD_RESUME_DELAY_MS = '400';
    try {
      const events = await ask('still there?');
      const turns = events.filter((e) => e.type === 'turn');
      expect((turns.at(-1) as { session: string }).session).not.toBe(old);
      const d = done(events);
      expect(d.timing.boot).toBeGreaterThanOrEqual(0.4);
      expect(d.timing.model).toBeLessThan(0.4);
      expect(harnessLog().at(-1)!.input).toContain('# Lead brief: demo');
    } finally {
      delete childEnv.FAKE_LEAD_RESUME_ERROR;
      delete childEnv.FAKE_LEAD_RESUME_DELAY_MS;
    }
  });

  it('rotates past 60% after closing the stream, then starts fresh with quoted memory', async () => {
    const old = readSessionState(paths)!.sessionId;
    done(await ask('BIG question'));
    const events = await ask('after rotation');
    const turn = turnEvent(events);
    expect(turn.engine).toBe('cold');
    expect(turn.session).not.toBe(old);
    expect(fs.readFileSync(paths.memory, 'utf-8')).toContain('remembered: PHNX-1 goes to Claude');
    expect(readSessionState(paths)).toMatchObject({ sessionId: turn.session, rotatedFrom: old });
    expect(harnessLog().at(-1)!.input).toContain('> - remembered: PHNX-1 goes to Claude');
  });

  it('spawns dispatched workers through the host with the caller env and no Lead markers', async () => {
    const socket = await connectHost(PROJECT);
    await sendRequest(socket!, {
      op: 'ask', text: 'hello', env: { SSH_AUTH_SOCK: '/run/agent.sock', GH_TOKEN: 'gh', AGENTS_LEAD_PROJECT: 'evil', PATH: `${paths.bin}:/usr/bin` },
    }, () => {});
    let reply: Record<string, unknown> = {};
    await sendRequest((await connectHost(PROJECT))!, { op: 'spawn', agent: 'codex', prompt: 'Work on PHNX-9: x' }, (r) => { reply = r; });
    expect(reply.type).toBe('spawned');
    for (let i = 0; i < 50 && !fs.existsSync(workerDump); i++) await new Promise((r) => setTimeout(r, 50));
    const dump = JSON.parse(fs.readFileSync(workerDump, 'utf-8'));
    expect(dump.argv).toEqual(['run', 'codex', 'Work on PHNX-9: x', '--headless', '-P', PROJECT, '--mode', 'edit']);
    expect(dump.env).toMatchObject({ SSH_AUTH_SOCK: '/run/agent.sock', GH_TOKEN: 'gh', PATH: '/usr/bin' });
    expect(dump.env.AGENTS_LEAD_PROJECT).toBeUndefined();
    expect(dump.env.FAKE_LEAD_LOG).toBeUndefined();
    let bad: Record<string, unknown> = {};
    await sendRequest((await connectHost(PROJECT))!, { op: 'spawn', agent: 'sh -c', prompt: 'x' }, (r) => { bad = r; });
    expect(bad).toMatchObject({ type: 'error', message: expect.stringContaining('not a known agent') });
  });

  it('recognizes Lead sessions by title or by a cwd under the Lead root', () => {
    expect(isLeadRow({ title: 'lead-rush' })).toBe(true);
    expect(isLeadRow({ title: 'This is a test', cwd: path.join(leadRoot(), 'agi') })).toBe(true);
    expect(isLeadRow({ title: 'Fix login', cwd: '/home/u/src/app' })).toBe(false);
    expect(isLeadRow({ title: 'Fix login', cwd: `${leadRoot()}-other` })).toBe(false);
  });

  it('answers status over the socket', async () => {
    const socket = await connectHost(PROJECT);
    let status: LeadStatus | null = null;
    await sendRequest(socket!, { op: 'status' }, (s) => { status = s as unknown as LeadStatus; });
    expect(status).toMatchObject({ project: PROJECT, state: 'warm', model: 'sonnet', version: '9.9.9-test', busy: false });
    expect(status!.tools).toContain('Bash(agents lead tool dispatch:*)');
    expect(status!.memory[0]).toContain('remembered');
  });
});
