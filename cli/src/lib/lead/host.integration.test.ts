import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LeadHost, type LeadStatus } from './host.js';
import { connectHost, runConfirm, sendRequest } from './client.js';
import { ensureLeadDir } from './paths.js';
import { ConfirmError } from './confirm.js';
import { readHistory, readSessionState } from './store.js';
import type { LeadEvent } from './events.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const FAKE_CLAUDE = path.join(here, 'testdata', 'fake-claude.mjs');
const FAKE_FEED = path.join(here, 'testdata', 'fake-feed.mjs');
const PROJECT = 'demo';
const ROW_ID = 'abcd1234-0000-4000-8000-000000000001';

let host: LeadHost;
let logFile: string;

function harnessLog(): Array<{ argv?: string[]; input?: string }> {
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
    process.env.FAKE_LEAD_LOG = logFile;
    const paths = ensureLeadDir(PROJECT);
    host = new LeadHost({
      project: PROJECT,
      def: { name: PROJECT, repo: 'acme/demo', linear: { name: 'Demo' }, goals: [{ objective: 'Ship the demo' }] },
      paths,
      model: 'sonnet',
      harness: (args) => ({ command: process.execPath, args: [FAKE_CLAUDE, ...args] }),
      feed: { command: process.execPath, args: [FAKE_FEED] },
      fetchTickets: async () => [{ id: 'PHNX-4365', title: 'Rush MCP server', url: 'https://linear.app/acme/issue/PHNX-4365' }],
      fetchPrs: async () => [{ number: 3607, title: 'Lead CLI', url: 'https://github.com/acme/demo/pull/3607', draft: false }],
    });
    await host.start();
  });

  afterAll(async () => {
    delete process.env.FAKE_LEAD_LOG;
    delete process.env.FAKE_LEAD_FAIL_RESUME;
    await host.shutdown();
  });

  it('cold-starts with the brief, streams text, and finishes with refs, summary and history', async () => {
    const events = await ask('hello there', 3.2);
    const turn = turnEvent(events);
    expect(turn).toMatchObject({ project: PROJECT, engine: 'cold' });
    expect(events[1]).toEqual({ type: 'status', state: 'booting' });
    expect(events.filter((e) => e.type === 'text').map((e) => (e as { delta: string }).delta).join('')).toContain('Turn 1.');
    const d = done(events);
    expect(d.turn).toBe(turn.turn);
    expect(d.summary).toBe('Turn 1.');
    expect(d.refs).toEqual(expect.arrayContaining([
      { kind: 'ticket', id: 'PHNX-4365', url: 'https://linear.app/acme/issue/PHNX-4365', title: 'Rush MCP server' },
      { kind: 'pr', repo: 'acme/demo', number: 3607, url: 'https://github.com/acme/demo/pull/3607' },
      { kind: 'session', id: ROW_ID, title: 'Fix the flaky login test', host: 'box-a' },
    ]));
    expect(d.timing.boot).toBeGreaterThan(0);

    const log = harnessLog();
    const argv = log[0].argv!;
    expect(argv.slice(0, 4)).toEqual(['run', 'claude', '--headless', '--quiet']);
    expect(argv).toContain('--session-id');
    expect(argv[argv.indexOf('--session-id') + 1]).toBe(turn.session);
    expect(argv).toEqual(expect.arrayContaining(['--effort', 'low', '--input-format', 'stream-json', '--permission-mode', 'dontAsk', 'Bash(agents ps stop:*)']));
    const first = log[1].input!;
    expect(first).toContain('# Lead brief: demo');
    expect(first).toContain('Goal: Ship the demo');
    expect(first).toContain('## Live sessions (1)');
    expect(first).toContain('“Fix the flaky login test” running on box-a');
    expect(first).not.toContain('Other project work');
    expect(first).toContain('Fleet: 2 live sessions on 1 device: 2 running.');
    expect(first).toContain('- PHNX-4365 Rush MCP server');
    expect(first).toContain('[Dictated by voice, 3.2s');

    const history = readHistory(ensureLeadDir(PROJECT));
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({ turn: turn.turn, ask: 'hello there', voice: 3.2, summary: 'Turn 1.' });
    expect(readSessionState(ensureLeadDir(PROJECT))).toMatchObject({ sessionId: turn.session, briefed: true, turns: 1 });
  });

  it('reuses the warm process, prefixes a state delta, and reports tool rows', async () => {
    const before = harnessLog().length;
    const events = await ask('TOOL check');
    expect(turnEvent(events).engine).toBe('warm');
    const tools = events.filter((e) => e.type === 'tool');
    expect(tools[0]).toMatchObject({ id: 'toolu_ps', label: 'agents ps', cmd: 'agents ps --json --local', state: 'run' });
    expect(tools[1]).toMatchObject({ id: 'toolu_ps', label: 'agents ps', state: 'ok' });
    expect(done(events).timing.tools).toBeGreaterThan(0);
    const log = harnessLog().slice(before);
    expect(log.every((l) => l.argv === undefined)).toBe(true);
    expect(log[0].input!.startsWith("[State delta]\nNo changes to this project's sessions.\nFleet: 2 live sessions on 1 device: 2 running.\n")).toBe(true);
    expect(readHistory(ensureLeadDir(PROJECT)).at(-1)!.tools).toEqual([
      expect.objectContaining({ label: 'agents ps', cmd: 'agents ps --json --local', state: 'ok' }),
    ]);
  });

  it('holds a stop for a single-use confirm token instead of running it', async () => {
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
    expect(confirmEvents.map((e) => e.type)).toEqual(['tool', 'tool', 'done']);
    expect(done(confirmEvents).text).toBe('Stopped “Fix the flaky login test”.');
    await expect(runConfirm(token, () => {})).rejects.toBeInstanceOf(ConfirmError);
  });

  it('recovers a dead process with --resume and no second brief', async () => {
    const session = readSessionState(ensureLeadDir(PROJECT))!.sessionId;
    const crashed = await ask('CRASH now');
    expect(crashed.at(-1)).toMatchObject({ type: 'error' });
    const before = harnessLog().length;
    const events = await ask('are you back?');
    expect(turnEvent(events)).toMatchObject({ engine: 'cold', session });
    done(events);
    const log = harnessLog().slice(before);
    expect(log[0].argv).toEqual(expect.arrayContaining(['--resume', session]));
    expect(log[1].input).not.toContain('# Lead brief');
    expect(log[1].input!.startsWith('[State delta]')).toBe(true);
  });

  it('starts fresh from the brief when the resume itself fails', async () => {
    const old = readSessionState(ensureLeadDir(PROJECT))!.sessionId;
    await ask('CRASH again');
    process.env.FAKE_LEAD_FAIL_RESUME = '1';
    try {
      const events = await ask('still there?');
      const turns = events.filter((e) => e.type === 'turn');
      expect(turns.at(-1)).toMatchObject({ engine: 'cold' });
      expect((turns.at(-1) as { session: string }).session).not.toBe(old);
      done(events);
      expect(harnessLog().at(-1)!.input).toContain('# Lead brief: demo');
    } finally {
      delete process.env.FAKE_LEAD_FAIL_RESUME;
    }
  });

  it('rotates past 60% context: writes memory.md and starts the next turn fresh with it', async () => {
    const paths = ensureLeadDir(PROJECT);
    const old = readSessionState(paths)!.sessionId;
    done(await ask('BIG question'));
    expect(fs.readFileSync(paths.memory, 'utf-8')).toContain('remembered: PHNX-1 goes to Claude');
    expect(readSessionState(paths)).toBeNull();
    const events = await ask('after rotation');
    const turn = turnEvent(events);
    expect(turn.engine).toBe('cold');
    expect(turn.session).not.toBe(old);
    expect(readSessionState(paths)).toMatchObject({ sessionId: turn.session, rotatedFrom: old });
    const input = harnessLog().at(-1)!.input!;
    expect(input).toContain('# Lead brief: demo');
    expect(input).toContain('remembered: PHNX-1 goes to Claude');
  });

  it('answers status over the socket', async () => {
    const socket = await connectHost(PROJECT);
    let status: LeadStatus | null = null;
    await sendRequest(socket!, { op: 'status' }, (s) => { status = s as unknown as LeadStatus; });
    expect(status).toMatchObject({ project: PROJECT, state: 'warm', model: 'sonnet', busy: false });
    expect(status!.tools).toContain('Bash(linear:*)');
    expect(status!.memory[0]).toContain('remembered');
    expect(status!.brief[0]).toBe('project demo (Linear: Demo)');
  });
});
