import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as readline from 'node:readline';
import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { linearIssueUrl } from '@phnx-labs/sessions-cli/reader';
import { listProjectDefsCached, projectNameForCwd, resolveDefinedProjectPath, type ProjectDef } from '../projects.js';
import {
  LeadTurnParser, shouldRotate, summarize,
  type LeadEngine, type LeadEvent, type LeadTiming, type TurnResult,
} from './events.js';
import { extractRefs, enrichTickets } from './refs.js';
import { mintConfirm, sweepExpiredConfirms } from './confirm.js';
import { FeedRoster, filterProject, formatRosterRow, rosterDelta, type RosterRow, type RosterSnapshot } from './roster.js';
import {
  agentsMdDigest, briefSummary, buildBrief, composeTurnMessage, fetchOpenTickets, fetchRecentPrs, fleetLine,
  linearTeamKey, projectRepo,
  type BriefInputs, type BriefPr, type BriefTicket,
} from './brief.js';
import {
  appendHistory, clearSessionState, readMemory, readSessionState, writeMemory, writeSessionState,
  type LeadHistoryTool, type LeadSessionState,
} from './store.js';
import { ensureLeadDir, type LeadPaths } from './paths.js';
import {
  LEAD_ALLOWED_TOOLS, leadChildEnv, leadRunArgs, writeAgentsShim, writeLeadSettings,
  type Launch, type LeadSessionStart,
} from './harness.js';

export const LEAD_IDLE_EXIT_MS = 4 * 60 * 60 * 1000;
export const ROSTER_WAIT_MS = 4_000;
export const CONFIRM_SWEEP_MS = 5 * 60 * 1000;
const CHILD_STOP_GRACE_MS = 5_000;
const FEED_BACKOFF_MIN_MS = 2_000;
const FEED_BACKOFF_MAX_MS = 60_000;
const STDERR_TAIL_CHARS = 4_000;
const RESUME_MISSING_RE = /No session matching|No conversation found/i;

export const MEMORY_PROMPT =
  'Your context is about to be rotated. Write the memory your successor Lead needs, as a short Markdown list (at most 25 lines): ' +
  'standing owner preferences, what was dispatched to whom (ticket ids, session titles), open threads and pending confirms. ' +
  'Facts only, no greeting. Reply with the list and nothing else.';

export type LeadHostState = 'warm' | 'cold' | 'stopped';

export interface LeadStatus {
  project: string;
  state: LeadHostState;
  session: string | null;
  engine: LeadEngine | null;
  model: string;
  host: string;
  brief: string[];
  memory: string[];
  tools: string[];
  pid: number | null;
  version: string | null;
  busy: boolean;
  queued: number;
  turns: number;
  contextPct: number | null;
  lastTurnAt: string | null;
}

export type LeadRequest =
  | { op: 'ask'; text: string; voice?: number }
  | { op: 'status' }
  | { op: 'stop' }
  | { op: 'roster'; project?: string }
  | { op: 'resolve'; session: string }
  | { op: 'hold-stop'; session: string };

export interface LeadHostRecord {
  pid: number;
  project: string;
  version: string;
  model: string;
  startedAtMs: number;
}

export interface LeadHostOptions {
  project: string;
  def: ProjectDef;
  paths: LeadPaths;
  model: string;
  version: string;
  harness: (args: string[]) => Launch;
  feed: Launch | null;
  childEnv?: NodeJS.ProcessEnv;
  fetchTickets?: (def: ProjectDef) => Promise<BriefTicket[]>;
  fetchPrs?: (def: ProjectDef) => Promise<BriefPr[]>;
  teamKey?: string;
  idleExitMs?: number;
  log?: (line: string) => void;
}

interface ActiveTurn {
  emit: (e: LeadEvent) => void;
  onItem: (msg: Record<string, unknown>) => void;
  onExit: (code: number | null, signal: NodeJS.Signals | null) => void;
}

class ChildGone extends Error {
  constructor(readonly sawInit: boolean, readonly stderr: string, message: string) { super(message); }
}

function secs(ms: number): number {
  return Math.round(ms / 10) / 100;
}

function newTurnId(): string {
  return `t_${randomBytes(6).toString('hex')}`;
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export function readHostRecord(paths: LeadPaths): LeadHostRecord | null {
  try {
    return JSON.parse(fs.readFileSync(paths.host, 'utf-8')) as LeadHostRecord;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

export function acquireHostLock(paths: LeadPaths): void {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      fs.writeFileSync(paths.lock, String(process.pid), { flag: 'wx', mode: 0o600 });
      return;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      const holder = Number.parseInt(fs.readFileSync(paths.lock, 'utf-8'), 10);
      if (Number.isInteger(holder) && holder !== process.pid && pidAlive(holder)) {
        throw new Error(`Another Lead host (pid ${holder}) holds ${paths.lock}.`);
      }
      fs.rmSync(paths.lock, { force: true });
    }
  }
  throw new Error(`Could not take ${paths.lock}.`);
}

export function statusFromFiles(project: string, paths: LeadPaths, model: string): LeadStatus {
  const state = readSessionState(paths);
  return {
    project,
    state: 'stopped',
    session: state?.sessionId ?? null,
    engine: state?.lastEngine ?? null,
    model: state?.model ?? model,
    host: os.hostname(),
    brief: state?.brief ?? [],
    memory: readMemory(paths).split('\n').filter((l) => l.trim().length > 0),
    tools: [...LEAD_ALLOWED_TOOLS],
    pid: null,
    version: null,
    busy: false,
    queued: 0,
    turns: state?.turns ?? 0,
    contextPct: state?.contextTokens && state.contextWindow
      ? Math.round((state.contextTokens / state.contextWindow) * 1000) / 10
      : null,
    lastTurnAt: state?.lastTurnAtMs ? new Date(state.lastTurnAtMs).toISOString() : null,
  };
}

export class LeadHost {
  private server: net.Server | null = null;
  private child: ChildProcess | null = null;
  private childSessionId: string | null = null;
  private childStderr = '';
  private active: ActiveTurn | null = null;
  private queue: Promise<void> = Promise.resolve();
  private queued = 0;
  private busy = false;
  private stopping = false;
  private readonly roster = new FeedRoster();
  private feedChild: ChildProcess | null = null;
  private feedBackoffMs = FEED_BACKOFF_MIN_MS;
  private timers: NodeJS.Timeout[] = [];
  private idleTimer: NodeJS.Timeout | null = null;
  private readonly ticketCache = new Map<string, BriefTicket>();
  private readonly knownPrs = new Set<number>();
  private readonly ticketPrefixes = new Set<string>();
  private rotatedFrom: string | undefined;
  private resolveClosed!: () => void;
  readonly closed = new Promise<void>((resolve) => { this.resolveClosed = resolve; });

  constructor(private readonly opts: LeadHostOptions) {
    const key = opts.teamKey ?? linearTeamKey(os.homedir());
    if (key) this.ticketPrefixes.add(key);
  }

  private log(line: string): void {
    this.opts.log?.(`${new Date().toISOString()} ${line}`);
  }

  async start(): Promise<void> {
    const paths = ensureLeadDir(this.opts.project);
    acquireHostLock(paths);
    try {
      await this.claimSocket();
      this.server = net.createServer((socket) => this.onConnection(socket));
      await new Promise<void>((resolve, reject) => {
        this.server!.once('error', reject);
        this.server!.listen(paths.endpoint, () => resolve());
      });
    } catch (err) {
      fs.rmSync(paths.lock, { force: true });
      throw err;
    }
    if (process.platform !== 'win32') fs.chmodSync(paths.socket, 0o600);
    writeLeadSettings(paths);
    writeAgentsShim(paths);
    const record: LeadHostRecord = {
      pid: process.pid, project: this.opts.project, version: this.opts.version, model: this.opts.model, startedAtMs: Date.now(),
    };
    fs.writeFileSync(paths.host, JSON.stringify(record));
    this.startFeed();
    this.armIdle();
    const sweep = setInterval(() => {
      const removed = sweepExpiredConfirms();
      if (removed > 0) this.log(`swept ${removed} expired confirm tokens`);
    }, CONFIRM_SWEEP_MS);
    sweep.unref();
    this.timers.push(sweep);
    void this.refreshRefData();
    this.log(`host listening for ${this.opts.project} (pid ${process.pid}, version ${this.opts.version}, model ${this.opts.model})`);
  }

  private async claimSocket(): Promise<void> {
    const live = await new Promise<boolean>((resolve) => {
      const probe = net.connect(this.opts.paths.endpoint);
      probe.once('connect', () => { probe.destroy(); resolve(true); });
      probe.once('error', () => resolve(false));
    });
    if (live) throw new Error(`A Lead host for '${this.opts.project}' is already listening on ${this.opts.paths.socket}.`);
    if (process.platform !== 'win32') fs.rmSync(this.opts.paths.socket, { force: true });
  }

  private armIdle(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      if (this.busy || this.queued > 0) { this.armIdle(); return; }
      this.log('idle limit reached; shutting down');
      void this.shutdown();
    }, this.opts.idleExitMs ?? LEAD_IDLE_EXIT_MS);
  }

  private startFeed(): void {
    if (!this.opts.feed || this.stopping) return;
    const feed = spawn(this.opts.feed.command, this.opts.feed.args, { stdio: ['ignore', 'pipe', 'pipe'] });
    this.feedChild = feed;
    readline.createInterface({ input: feed.stdout! }).on('line', (line) => {
      if (!line.trim()) return;
      let envelope: Record<string, unknown>;
      try {
        envelope = JSON.parse(line) as Record<string, unknown>;
      } catch {
        this.log(`feed: unparseable line dropped (${line.slice(0, 80)})`);
        return;
      }
      this.feedBackoffMs = FEED_BACKOFF_MIN_MS;
      this.roster.apply(envelope);
    });
    feed.stderr!.on('data', (d: Buffer) => this.log(`feed stderr: ${d.toString().trim().slice(0, 300)}`));
    feed.on('exit', (code, signal) => {
      this.feedChild = null;
      if (this.stopping) return;
      this.log(`feed watch exited (${code ?? signal}); restarting in ${this.feedBackoffMs}ms`);
      const t = setTimeout(() => this.startFeed(), this.feedBackoffMs);
      t.unref();
      this.timers.push(t);
      this.feedBackoffMs = Math.min(this.feedBackoffMs * 2, FEED_BACKOFF_MAX_MS);
    });
  }

  private isSelf(row: RosterRow): boolean {
    return row.id === this.childSessionId || row.title === `lead-${this.opts.project}`;
  }

  private liveRows(): RosterRow[] {
    return Object.values(this.roster.snapshot()).filter((r) => !this.isSelf(r));
  }

  private projectRoster(project = this.opts.project): RosterSnapshot {
    const defs = listProjectDefsCached();
    const others: RosterSnapshot = Object.fromEntries(this.liveRows().map((r) => [r.id, r]));
    return filterProject(others, project, (cwd) => projectNameForCwd(cwd, defs));
  }

  private fleetSummary(): string {
    const all = Object.values(this.roster.snapshot());
    const others = all.filter((r) => !this.isSelf(r));
    return fleetLine(others, all.length - others.length);
  }

  private findRow(ref: string, rows: RosterRow[]): RosterRow | undefined {
    const exact = rows.find((r) => r.id === ref);
    if (exact) return exact;
    const prefixed = rows.filter((r) => r.id.startsWith(ref));
    return prefixed.length === 1 ? prefixed[0] : undefined;
  }

  private onConnection(socket: net.Socket): void {
    socket.on('error', () => {});
    const rl = readline.createInterface({ input: socket });
    rl.once('line', (line) => {
      rl.close();
      let req: LeadRequest;
      try {
        req = JSON.parse(line) as LeadRequest;
      } catch {
        socket.end(`${JSON.stringify({ type: 'error', message: 'unparseable request' })}\n`);
        return;
      }
      const emit = (event: unknown) => { if (!socket.destroyed) socket.write(`${JSON.stringify(event)}\n`); };
      const reply = (event: unknown) => { emit(event); socket.end(); };
      if (req.op === 'ask') {
        this.armIdle();
        void this.enqueue(req.text, req.voice, emit).finally(() => socket.end());
        return;
      }
      try {
        if (req.op === 'status') reply(this.status());
        else if (req.op === 'stop') {
          void this.queue.then(async () => {
            reply({ type: 'stopped', project: this.opts.project });
            await this.shutdown();
          });
        } else if (req.op === 'roster') reply(this.rosterReply(req.project ?? this.opts.project));
        else if (req.op === 'resolve') reply(this.resolveReply(req.session));
        else if (req.op === 'hold-stop') reply(this.holdStop(req.session));
        else reply({ type: 'error', message: `unknown op ${(req as { op?: string }).op}` });
      } catch (err) {
        reply({ type: 'error', message: err instanceof Error ? err.message : String(err) });
      }
    });
  }

  private rosterReply(project: string): { type: 'roster'; text: string } {
    if (!this.roster.ready) throw new Error('The live feed is not connected yet; try again in a few seconds.');
    const rows = Object.values(this.projectRoster(project));
    const lines = rows.length ? rows.map(formatRosterRow) : [`No live sessions for ${project}.`];
    return { type: 'roster', text: [`Live sessions for ${project} (${rows.length}):`, ...lines, this.fleetSummary()].join('\n') };
  }

  private resolveReply(session: string): { type: 'session'; id: string; title: string } {
    const row = this.findRow(session, Object.values(this.projectRoster()));
    if (!row) throw new Error(`No live session '${session}' in ${this.opts.project}; check the roster tool.`);
    return { type: 'session', id: row.id, title: row.title };
  }

  private holdStop(session: string): { type: 'held'; token: string; label: string; sessionId: string } {
    const row = this.findRow(session, this.liveRows());
    const record = mintConfirm({
      project: this.opts.project,
      action: 'stop',
      sessionId: row?.id ?? session,
      label: row ? `Stop “${row.title}”` : `Stop session ${session}`,
    });
    this.active?.emit({ type: 'confirm', token: record.token, action: 'stop', sessionId: record.sessionId, label: record.label });
    this.log(`held stop of ${record.sessionId} as ${record.token}`);
    return { type: 'held', token: record.token, label: record.label, sessionId: record.sessionId };
  }

  status(): LeadStatus {
    const base = statusFromFiles(this.opts.project, this.opts.paths, this.opts.model);
    return {
      ...base,
      state: this.child ? 'warm' : 'cold',
      session: this.childSessionId ?? base.session,
      model: this.opts.model,
      pid: process.pid,
      version: this.opts.version,
      busy: this.busy,
      queued: this.queued,
    };
  }

  private schedule(job: () => Promise<void>): Promise<void> {
    const next = this.queue.then(job);
    this.queue = next.catch(() => {});
    return next;
  }

  enqueue(text: string, voice: number | undefined, emit: (e: LeadEvent) => void): Promise<void> {
    this.queued++;
    return this.schedule(async () => {
      this.queued--;
      this.busy = true;
      let rotate: LeadSessionState | null = null;
      try {
        rotate = await this.runTurn(text, voice, emit);
      } catch (err) {
        emit({ type: 'error', message: err instanceof Error ? err.message : String(err) });
      } finally {
        this.busy = false;
        this.armIdle();
      }
      if (rotate) {
        const state = rotate;
        void this.schedule(async () => {
          this.busy = true;
          try {
            await this.rotate(state);
          } catch (err) {
            this.log(`rotation failed: ${err instanceof Error ? err.message : String(err)}`);
          } finally {
            this.busy = false;
          }
        });
      }
    });
  }

  private spawnChild(start: LeadSessionStart): void {
    const { paths, project } = this.opts;
    const launch = this.opts.harness(leadRunArgs(project, this.opts.model, start, paths));
    this.log(`spawn ${start.mode} ${start.sessionId}`);
    const env = this.opts.childEnv ?? leadChildEnv(project, paths);
    const child = spawn(launch.command, launch.args, { cwd: paths.dir, stdio: ['pipe', 'pipe', 'pipe'], env });
    this.child = child;
    this.childSessionId = start.sessionId;
    this.childStderr = '';
    child.stdin!.on('error', (err) => this.log(`child stdin: ${err.message}`));
    readline.createInterface({ input: child.stdout! }).on('line', (line) => {
      if (!line.trim()) return;
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(line) as Record<string, unknown>;
      } catch {
        this.log(`child stdout (non-JSON): ${line.slice(0, 200)}`);
        return;
      }
      this.active?.onItem(msg);
    });
    child.stderr!.on('data', (d: Buffer) => {
      const text = d.toString();
      this.childStderr = (this.childStderr + text).slice(-STDERR_TAIL_CHARS);
      this.log(`child stderr: ${text.trim().slice(0, 500)}`);
    });
    child.on('exit', (code, signal) => {
      this.log(`child exited (${code ?? signal})`);
      if (this.child === child) {
        this.child = null;
        this.childSessionId = null;
      }
      this.active?.onExit(code, signal);
    });
  }

  private async refreshRefData(): Promise<{ tickets: BriefTicket[] | { error: string }; prs: BriefPr[] | { error: string } }> {
    const { def } = this.opts;
    const root = resolveDefinedProjectPath(def, undefined, false);
    const fetchTickets = this.opts.fetchTickets ?? ((d: ProjectDef) => fetchOpenTickets(d, root));
    const fetchPrs = this.opts.fetchPrs ?? ((d: ProjectDef) => fetchRecentPrs(projectRepo(d), root));
    const asError = (err: unknown) => ({ error: err instanceof Error ? err.message : String(err) });
    const [tickets, prs] = await Promise.all([fetchTickets(def).catch(asError), fetchPrs(def).catch(asError)]);
    if (Array.isArray(tickets)) {
      for (const t of tickets) {
        this.ticketCache.set(t.id, t);
        this.ticketPrefixes.add(t.id.split('-')[0]);
      }
    } else this.log(`tickets unavailable: ${tickets.error}`);
    if (Array.isArray(prs)) for (const p of prs) this.knownPrs.add(p.number);
    else this.log(`PRs unavailable: ${prs.error}`);
    return { tickets, prs };
  }

  private async gatherBrief(): Promise<BriefInputs> {
    const { def, project } = this.opts;
    const [{ tickets, prs }] = await Promise.all([
      this.refreshRefData(),
      this.roster.whenReady(this.opts.feed ? ROSTER_WAIT_MS : 0),
    ]);
    return {
      project, def,
      agentsDigest: agentsMdDigest(resolveDefinedProjectPath(def, undefined, false)),
      roster: this.projectRoster(),
      fleet: this.fleetSummary(),
      tickets, prs,
      memory: readMemory(this.opts.paths),
    };
  }

  private async exchange(message: string, emit: (e: LeadEvent) => void, turnId: string): Promise<{ result: TurnResult; parser: LeadTurnParser; initAtMs: number | null; tools: LeadHistoryTool[] }> {
    const child = this.child;
    if (!child) throw new Error('Lead process is not running');
    const parser = new LeadTurnParser();
    const tools = new Map<string, LeadHistoryTool>();
    let initAtMs: number | null = null;
    const result = await new Promise<TurnResult>((resolve, reject) => {
      this.active = {
        emit,
        onItem: (msg) => {
          for (const item of parser.feed(msg, Date.now())) {
            if (item.kind === 'init') initAtMs = Date.now();
            else if (item.kind === 'result') resolve(item.result);
            else {
              const ev = item.event;
              if (ev.type === 'tool') {
                if (ev.state === 'run') tools.set(ev.id, { label: ev.label, cmd: ev.cmd, state: 'run', secs: 0 });
                else {
                  const t = tools.get(ev.id);
                  if (t) { t.state = ev.state; t.secs = ev.secs; }
                }
              }
              emit(ev);
            }
          }
        },
        onExit: (code, signal) => reject(new ChildGone(initAtMs !== null, this.childStderr, `Lead process exited (${code ?? signal}) during turn ${turnId}`)),
      };
      child.stdin!.write(`${JSON.stringify({ type: 'user', message: { role: 'user', content: message } })}\n`);
    }).finally(() => { this.active = null; });
    return { result, parser, initAtMs, tools: [...tools.values()] };
  }

  private async runTurn(text: string, voice: number | undefined, emit: (e: LeadEvent) => void): Promise<LeadSessionState | null> {
    const turnId = newTurnId();
    const startedAt = Date.now();
    let state = readSessionState(this.opts.paths);
    let engine = 'warm' as LeadEngine;
    let briefText: string | undefined;
    let bootStart: number | null = null;
    const coldStart = async (forceFresh: boolean) => {
      engine = 'cold';
      bootStart = Date.now();
      if (state && state.briefed && !forceFresh) {
        this.spawnChild({ mode: 'resume', sessionId: state.sessionId });
        emit({ type: 'turn', turn: turnId, project: this.opts.project, session: state.sessionId, engine });
        emit({ type: 'status', state: 'booting' });
        briefText = undefined;
        return;
      }
      const sessionId = randomUUID();
      this.spawnChild({ mode: 'fresh', sessionId });
      emit({ type: 'turn', turn: turnId, project: this.opts.project, session: sessionId, engine });
      emit({ type: 'status', state: 'booting' });
      const inputs = await this.gatherBrief();
      briefText = buildBrief(inputs);
      state = {
        sessionId,
        model: this.opts.model,
        startedAtMs: Date.now(),
        turns: 0,
        briefed: false,
        brief: briefSummary(inputs),
        rotatedFrom: this.rotatedFrom,
        roster: inputs.roster,
      };
      this.rotatedFrom = undefined;
    };

    if (this.child && state && this.childSessionId === state.sessionId) {
      emit({ type: 'turn', turn: turnId, project: this.opts.project, session: state.sessionId, engine });
      emit({ type: 'status', state: 'thinking' });
    } else {
      if (this.child) await this.stopChild();
      await coldStart(false);
    }

    const feedLive = () => this.roster.ready || !this.opts.feed;
    let roster = briefText || !feedLive() ? state?.roster ?? {} : this.projectRoster();
    const delta = () => {
      if (briefText) return [];
      if (!feedLive()) return ['Live feed not connected yet; the roster tool will say when it is.'];
      const projectLines = rosterDelta(state?.roster ?? null, roster);
      return [...(projectLines.length ? projectLines : ['No changes to this project\'s sessions.']), this.fleetSummary()];
    };
    const message = () => composeTurnMessage({ brief: briefText, delta: delta(), text, voiceSecs: voice });
    const sent = Date.now();
    let outcome: Awaited<ReturnType<LeadHost['exchange']>>;
    try {
      outcome = await this.exchange(message(), emit, turnId);
    } catch (err) {
      const resumeMissing = err instanceof ChildGone && !err.sawInit && engine === 'cold' && !briefText && RESUME_MISSING_RE.test(err.stderr);
      if (!resumeMissing) {
        if (err instanceof ChildGone && err.stderr.trim()) {
          throw new Error(`${err.message}: ${err.stderr.trim().split('\n').pop()}`);
        }
        throw err;
      }
      this.log(`session ${state?.sessionId} is gone; starting a fresh session from the brief`);
      clearSessionState(this.opts.paths);
      state = null;
      await coldStart(true);
      roster = state!.roster ?? {};
      outcome = await this.exchange(message(), emit, turnId);
    }

    const { result, parser, initAtMs, tools } = outcome;
    const finished = Date.now();
    const toolSecs = parser.toolSeconds();
    const bootSecs = bootStart !== null ? secs((initAtMs ?? sent) - bootStart) : 0;
    const timing: LeadTiming = {
      boot: bootSecs,
      tools: toolSecs,
      model: Math.max(0, Math.round((secs(finished - startedAt) - bootSecs - toolSecs) * 100) / 100),
    };
    const next: LeadSessionState = {
      ...state!,
      briefed: true,
      turns: state!.turns + 1,
      lastTurnAtMs: finished,
      lastEngine: engine,
      roster: briefText ? state!.roster : roster,
      contextTokens: result.usage?.tokens ?? state!.contextTokens,
      contextWindow: result.usage?.window ?? state!.contextWindow,
    };
    writeSessionState(this.opts.paths, next);

    if (result.isError) {
      emit({ type: 'error', message: result.text || 'the Lead turn ended with an error' });
      return null;
    }
    const refs = enrichTickets(
      extractRefs(result.text, {
        ticketPrefixes: this.ticketPrefixes,
        repo: projectRepo(this.opts.def),
        knownPrs: this.knownPrs,
        sessions: this.liveRows(),
      }),
      { cached: (id) => this.ticketCache.get(id), urlFor: (id) => linearIssueUrl(id) },
    );
    const summary = summarize(result.text);
    emit({ type: 'done', turn: turnId, text: result.text, summary, refs, timing });
    appendHistory(this.opts.paths, {
      turn: turnId,
      at: new Date(startedAt).toISOString(),
      ask: text,
      ...(voice !== undefined ? { voice } : {}),
      text: result.text,
      summary,
      refs,
      tools,
      session: next.sessionId,
      timing,
    });
    return shouldRotate(result.usage) ? next : null;
  }

  private async rotate(state: LeadSessionState): Promise<void> {
    this.log(`rotating ${state.sessionId} at ${state.contextTokens}/${state.contextWindow} tokens`);
    const { result } = await this.exchange(MEMORY_PROMPT, () => {}, 'rotation');
    if (result.isError || !result.text.trim()) {
      throw new Error(`context rotation could not write memory.md: ${result.text || 'empty reply'}`);
    }
    writeMemory(this.opts.paths, result.text.trim());
    await this.stopChild();
    clearSessionState(this.opts.paths);
    this.rotatedFrom = state.sessionId;
    this.log(`rotated ${state.sessionId}; memory.md written, next turn starts fresh`);
  }

  private async stopChild(): Promise<void> {
    const child = this.child;
    if (!child) return;
    const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
    child.stdin!.end();
    const timer = setTimeout(() => child.kill('SIGTERM'), CHILD_STOP_GRACE_MS);
    const hard = setTimeout(() => child.kill('SIGKILL'), CHILD_STOP_GRACE_MS * 2);
    await exited;
    clearTimeout(timer);
    clearTimeout(hard);
  }

  async shutdown(): Promise<void> {
    if (this.stopping) return;
    this.stopping = true;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    for (const t of this.timers) clearTimeout(t);
    this.feedChild?.kill('SIGTERM');
    await this.stopChild();
    await new Promise<void>((resolve) => (this.server ? this.server.close(() => resolve()) : resolve()));
    fs.rmSync(this.opts.paths.host, { force: true });
    fs.rmSync(this.opts.paths.lock, { force: true });
    if (process.platform !== 'win32') fs.rmSync(this.opts.paths.socket, { force: true });
    this.log('host stopped');
    this.resolveClosed();
  }
}
