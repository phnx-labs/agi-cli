import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { SessionMeta } from '@phnx-labs/sessions-cli/reader';
import { getActivityDir, getBrowserRuntimeDir, getCacheDir } from '../state.js';
import { getEventsDir } from './events.js';
import { span, spanSync } from '../daemon/diagnostics.js';
import { invocation as browserInvocation, resolveBrowserBin } from '../browser-client.js';
import { invocation as computerInvocation, resolveComputerBin } from '../computer-client.js';
import { getSessionById } from '../session/db.js';
import { loadHookSessionIndex } from '../session/hook-sessions.js';
import { listPidSessionEntries } from '../session/pid-registry.js';
import type { BrowserSessionRow, ComputerRunRow, LiveBrowserTask, ToolTab } from './tools.js';
import { boundBrowserRow, projectBrowserToolRow, projectComputerToolRow, sortToolRows, type ToolKind, type ToolRow } from './tools.js';

export const TOOL_SWEEP_MS = 5_000;
const TOOL_COMPUTER_LIMIT = 500;
const TOOL_JSON_MAX_BYTES = 64 * 1024 * 1024;
const TOOL_JSON_TIMEOUT_MS = 30_000;

type StandaloneTool = 'browser' | 'computer';

export class ToolNotInstalledError extends Error {}

function resolveTool(tool: StandaloneTool): { command: string; prefix: string[] } {
  let bin: string;
  try { bin = tool === 'browser' ? resolveBrowserBin() : resolveComputerBin(); }
  catch (error) {
    throw new ToolNotInstalledError(`${(error as Error).message}\nRun \`agents setup tools\` to install the pinned \`${tool}\` CLI.`);
  }
  return tool === 'browser' ? browserInvocation(bin) : computerInvocation(bin);
}

/** Runs a standalone tool's `--json` listing; any failure rejects so the snapshot is reported incomplete. */
export async function readToolJson(tool: StandaloneTool, argv: string[]): Promise<unknown[]> {
  const { command, prefix } = resolveTool(tool);
  const label = `\`${tool} ${argv.join(' ')}\``;
  return new Promise((resolve, reject) => {
    const child = spawn(command, [...prefix, ...argv], { stdio: ['ignore', 'pipe', 'pipe'] });
    const stdout: Buffer[] = [];
    let stdoutBytes = 0;
    let stderr = '';
    let failure: Error | undefined;
    const fail = (error: Error) => { failure ??= error; child.kill('SIGKILL'); };
    const timer = setTimeout(() => fail(new Error(`${label} did not finish within ${TOOL_JSON_TIMEOUT_MS / 1000}s`)), TOOL_JSON_TIMEOUT_MS);
    child.stdout.on('data', (chunk: Buffer) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > TOOL_JSON_MAX_BYTES) fail(new Error(`${label} printed more than ${TOOL_JSON_MAX_BYTES} bytes`));
      else stdout.push(chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => { if (stderr.length < 4096) stderr += chunk.toString('utf8'); });
    child.on('error', (error) => fail(new Error(`${label} failed: ${error.message}`)));
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      if (failure) return reject(failure);
      if (code !== 0) return reject(new Error(`${label} exited ${code ?? signal}: ${stderr.trim().slice(0, 500)}`));
      let value: unknown;
      try { value = JSON.parse(Buffer.concat(stdout).toString('utf8')); }
      catch (error) { return reject(new Error(`${label} printed unparseable JSON: ${(error as Error).message}`)); }
      if (!Array.isArray(value)) return reject(new Error(`${label} printed ${typeof value}, expected an array of rows`));
      resolve(value);
    });
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export async function readStandaloneBrowserRows(): Promise<BrowserSessionRow[]> {
  return (await readToolJson('browser', ['sessions', '--tasks', '--json', '--no-interactive'])).map((row, index) => {
    if (!isRecord(row) || typeof row.profile !== 'string' || !Array.isArray(row.artifacts)
      || !isRecord(row.counts) || typeof row.latestMtimeMs !== 'number') {
      throw new Error(`\`browser sessions --json\` row ${index} lacks profile, artifacts, counts or latestMtimeMs`);
    }
    return row as unknown as BrowserSessionRow;
  });
}

export async function readStandaloneComputerRows(): Promise<ComputerRunRow[]> {
  return (await readToolJson('computer', ['sessions', '--json', '--no-interactive', '--limit', String(TOOL_COMPUTER_LIMIT)])).map((row, index) => {
    if (!isRecord(row) || typeof row.machine !== 'string' || !Array.isArray(row.actions)
      || !isRecord(row.counts) || typeof row.startMs !== 'number' || typeof row.endMs !== 'number') {
      throw new Error(`\`computer sessions --json\` row ${index} lacks machine, actions, counts or startMs/endMs`);
    }
    return row as unknown as ComputerRunRow;
  });
}

export const TOOL_LINK_TTL_MS = 60_000;
export const TOOL_LINK_MISS_TTL_MS = 10_000;
const LINK_YIELD_EVERY = 64;
const ACTIVITY_LAUNCH_TAIL_BYTES = 64 * 1024;

interface ToolLinkCache {
  metas: Map<string, { meta: SessionMeta | null; expiresAt: number }>;
  launches: Map<string, string>;
  indexBuiltAt: number;
  activity: Map<string, { stamp: string; pairs: Map<string, { sessionId: string; atMs: number }> }>;
  refreshing?: Promise<void>;
}

const linkCache: ToolLinkCache = { metas: new Map(), launches: new Map(), indexBuiltAt: -Infinity, activity: new Map() };

export function _resetToolLinkCacheForTest(): void {
  linkCache.metas.clear();
  linkCache.launches = new Map();
  linkCache.activity.clear();
  linkCache.indexBuiltAt = -Infinity;
}

const yieldToLoop = () => new Promise<void>((resolve) => setImmediate(resolve));

function expiryJitterMs(id: string): number {
  let hash = 0;
  for (let i = 0; i < id.length; i++) hash = (hash * 31 + id.charCodeAt(i)) >>> 0;
  return hash % TOOL_LINK_TTL_MS;
}

type LaunchPairs = Map<string, { sessionId: string; atMs: number }>;

function keepEarliest(into: LaunchPairs, launchId: string, sessionId: string, atMs: number): void {
  const prior = into.get(launchId);
  if (!prior || atMs < prior.atMs) into.set(launchId, { sessionId, atMs });
}

async function readLaunchPairs(file: string): Promise<LaunchPairs> {
  const handle = await fs.promises.open(file, 'r');
  try {
    const { size } = await handle.stat();
    const start = Math.max(0, size - ACTIVITY_LAUNCH_TAIL_BYTES);
    const buf = Buffer.alloc(size - start);
    await handle.read(buf, 0, buf.length, start);
    const pairs: LaunchPairs = new Map();
    for (const line of buf.toString('utf8').split('\n')) {
      if (!line.includes('"launchId"')) continue;
      let event: { launchId?: unknown; sessionId?: unknown; event?: unknown; ts?: unknown };
      try { event = JSON.parse(line) as typeof event; } catch { continue; }
      if (typeof event.launchId !== 'string' || !event.launchId || typeof event.sessionId !== 'string' || !event.sessionId) continue;
      if (!event.event || typeof event.ts !== 'string') continue;
      const atMs = Date.parse(event.ts);
      if (Number.isFinite(atMs)) keepEarliest(pairs, event.launchId, event.sessionId, atMs);
    }
    return pairs;
  } finally {
    await handle.close();
  }
}

async function refreshLaunchIndex(nowMs: number): Promise<void> {
  const dir = getActivityDir();
  let names: string[];
  try {
    names = (await fs.promises.readdir(dir)).filter((name) => name.endsWith('.jsonl'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    names = [];
  }
  const present = new Set(names);
  for (const name of linkCache.activity.keys()) if (!present.has(name)) linkCache.activity.delete(name);
  for (const name of names) {
    const file = path.join(dir, name);
    let stat: fs.Stats;
    try { stat = await fs.promises.stat(file); } catch { linkCache.activity.delete(name); continue; }
    const stamp = `${stat.size}:${stat.mtimeMs}`;
    if (linkCache.activity.get(name)?.stamp === stamp) continue;
    linkCache.activity.set(name, { stamp, pairs: await readLaunchPairs(file) });
  }
  const earliest: LaunchPairs = new Map();
  for (const { pairs } of linkCache.activity.values()) {
    for (const [launchId, { sessionId, atMs }] of pairs) keepEarliest(earliest, launchId, sessionId, atMs);
  }
  const next = new Map<string, string>();
  for (const [launchId, { sessionId }] of earliest) next.set(launchId, sessionId);
  spanSync('feed.tools.launch-index.local', () => {
    for (const [launchId, record] of loadHookSessionIndex().byLaunchId) {
      if (record.session_id) next.set(launchId, record.session_id);
    }
    for (const entry of listPidSessionEntries()) {
      if (entry.launchId && entry.sessionId) next.set(entry.launchId, entry.sessionId);
    }
  });
  linkCache.launches = next;
  linkCache.indexBuiltAt = nowMs;
}

export function linkToolSessions<T extends { sessionId?: string; launchId?: string; linkedSession?: SessionMeta }>(rows: T[], nowMs = Date.now()): Promise<T[]> {
  return span('feed.tools.link-sessions', () => linkToolSessionsNow(rows, nowMs), () => ({ rows: rows.length }));
}

async function linkToolSessionsNow<T extends { sessionId?: string; launchId?: string; linkedSession?: SessionMeta }>(rows: T[], nowMs: number): Promise<T[]> {
  for (const [id, entry] of linkCache.metas) if (entry.expiresAt <= nowMs) linkCache.metas.delete(id);
  if (rows.some((row) => row.launchId) && nowMs - linkCache.indexBuiltAt >= TOOL_LINK_TTL_MS) {
    linkCache.refreshing ??= span('feed.tools.launch-index', () => refreshLaunchIndex(nowMs))
      .finally(() => { linkCache.refreshing = undefined; });
    await linkCache.refreshing;
  }
  let lookups = 0;
  const sessionFor = async (id: string): Promise<SessionMeta | null> => {
    const hit = linkCache.metas.get(id);
    if (hit) return hit.meta;
    if (++lookups % LINK_YIELD_EVERY === 0) await yieldToLoop();
    const meta = getSessionById(id);
    linkCache.metas.set(id, { meta, expiresAt: nowMs + (meta ? TOOL_LINK_TTL_MS + expiryJitterMs(id) : TOOL_LINK_MISS_TTL_MS) });
    return meta;
  };
  const out: T[] = [];
  for (const row of rows) {
    let linked = row.sessionId ? await sessionFor(row.sessionId) : null;
    if (!linked && row.launchId) {
      const sessionId = linkCache.launches.get(row.launchId);
      linked = sessionId ? await sessionFor(sessionId) : null;
    }
    out.push(linked ? { ...row, linkedSession: linked } : row);
  }
  return out;
}

export interface ToolDiff {
  upserts: ToolRow[];
  removes: string[];
}

interface ToolSources {
  browserRows?: () => BrowserSessionRow[] | Promise<BrowserSessionRow[]>;
  computerRows?: () => ComputerRunRow[] | Promise<ComputerRunRow[]>;
  bindings?: () => Array<{ name: string; device?: string; profile?: string; url?: string; createdAt?: number; sessionId?: string; launchId?: string }>;
  liveTasks?: () => LiveBrowserTask[];
}

export interface ToolSnapshot {
  rows: ToolRow[];
  incomplete: ToolKind[];
  // An absent tool is a stable state; only a failed read of an installed one is worth retrying.
  retry: boolean;
}

export async function collectToolRows(scope: string, sources: ToolSources = {}): Promise<ToolSnapshot> {
  const incomplete = new Set<ToolKind>();
  let retry = false;
  const read = async <T>(kind: ToolKind, source: () => T | Promise<T>, empty: T): Promise<T> => {
    try { return await source(); } catch (error) {
      incomplete.add(kind);
      if (!(error instanceof ToolNotInstalledError)) retry = true;
      return empty;
    }
  };

  const [bindingList, liveTaskList, browserRows, computerRows] = await Promise.all([
    read('browser', sources.bindings ?? (() => []), []),
    read('browser', sources.liveTasks ?? (() => spanSync('feed.tools.live-tasks', () => readLiveBrowserTasks())), []),
    read('browser', sources.browserRows ?? (async () => linkToolSessions(await readStandaloneBrowserRows())), [] as BrowserSessionRow[]),
    read('computer', sources.computerRows ?? (async () => linkToolSessions(await readStandaloneComputerRows())), [] as ComputerRunRow[]),
  ]);
  const bindings = new Map<string, { device?: string; profile?: string; url?: string; createdAt?: number; sessionId?: string; launchId?: string }>();
  for (const binding of bindingList) bindings.set(binding.name, binding);
  const liveTasks = new Map<string, LiveBrowserTask>();
  for (const task of liveTaskList) liveTasks.set(task.task, task);

  const rows: ToolRow[] = [];
  const captured = new Set<string>();
  for (const row of browserRows) {
    if (row.task) captured.add(row.task);
    rows.push(projectBrowserToolRow(scope, row, row.task ? bindings.get(row.task) : undefined, row.task ? liveTasks.get(row.task) : undefined));
  }
  for (const task of new Set([...liveTasks.keys(), ...bindings.keys()])) {
    if (captured.has(task)) continue;
    const binding = bindings.get(task);
    const live = liveTasks.get(task);
    rows.push(projectBrowserToolRow(scope, boundBrowserRow(task, live ?? binding ?? {}), binding, live));
  }
  for (const row of computerRows) rows.push(projectComputerToolRow(scope, row));
  return { rows: sortToolRows(rows.filter((row) => !incomplete.has(row.kind))), incomplete: [...incomplete], retry };
}

export class ToolRowSet {
  private readonly rows = new Map<string, { kind: ToolKind; serialized: string }>();

  // A kind whose read failed keeps the rows it last published: a failed read is not "every task closed".
  diff(next: ToolRow[], unreadKinds: readonly ToolKind[] = []): ToolDiff {
    const upserts: ToolRow[] = [];
    const seen = new Set<string>();
    for (const row of next) {
      seen.add(row.rowKey);
      const serialized = JSON.stringify(row);
      if (this.rows.get(row.rowKey)?.serialized === serialized) continue;
      this.rows.set(row.rowKey, { kind: row.kind, serialized });
      upserts.push(row);
    }
    const removes: string[] = [];
    for (const [key, { kind }] of [...this.rows]) {
      if (seen.has(key) || unreadKinds.includes(kind)) continue;
      this.rows.delete(key);
      removes.push(key);
    }
    return { upserts, removes };
  }

  reset(rows: ToolRow[]): void {
    this.rows.clear();
    for (const row of rows) this.rows.set(row.rowKey, { kind: row.kind, serialized: JSON.stringify(row) });
  }
}

interface ToolWatchOptions {
  scope: string;
  signal: AbortSignal;
  onDiff: (diff: ToolDiff) => void;
  sweepMs?: number;
  roots?: string[];
  sources?: ToolSources;
  initial?: ToolRow[];
}

// Only roots the tools append to while they act: their history databases are
// written by the very listings this watcher runs, so watching those would loop.
function toolWatchRoots(): string[] {
  return [getBrowserRuntimeDir(), getEventsDir(), path.join(getCacheDir(), 'computer', 'actions')];
}

function readLiveTasksFor(profileDir: string): LiveBrowserTask[] {
  const file = path.join(profileDir, 'tasks.json');
  let raw: string;
  try { raw = fs.readFileSync(file, 'utf8'); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  let parsed: unknown;
  try { parsed = JSON.parse(raw); }
  catch (error) {
    throw new Error(`unreadable live task state at ${file}: ${(error as Error).message}`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`unexpected live task state at ${file}: expected an object of tasks`);
  }
  const out: LiveBrowserTask[] = [];
  for (const [name, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (!value || typeof value !== 'object') continue;
    const record = value as Record<string, unknown>;
    const borrowed = new Set(Array.isArray(record.borrowedTabs) ? record.borrowedTabs.filter((id): id is string => typeof id === 'string') : []);
    const tabs: ToolTab[] = [];
    if (record.tabs && typeof record.tabs === 'object') {
      for (const id of Object.keys(record.tabs as Record<string, unknown>)) {
        tabs.push({ id, ...(record.currentTabId === id ? { current: true } : {}), ...(borrowed.has(id) ? { borrowed: true } : {}) });
      }
    }
    out.push({
      task: typeof record.name === 'string' ? record.name : name,
      ...(typeof record.profile === 'string' ? { profile: record.profile } : {}),
      ...(typeof record.label === 'string' ? { label: record.label } : {}),
      tabs,
      ...(typeof record.createdAt === 'number' ? { startedAtMs: record.createdAt } : {}),
      ...(typeof record.lastActionAt === 'number' ? { lastActionAtMs: record.lastActionAt }
        : typeof record.createdAt === 'number' ? { lastActionAtMs: record.createdAt } : {}),
      ...(typeof record.sessionId === 'string' ? { sessionId: record.sessionId } : {}),
      ...(typeof record.launchId === 'string' ? { launchId: record.launchId } : {}),
      ...(typeof record.actor === 'string' ? { actor: record.actor } : {}),
    });
  }
  return out;
}

export function readLiveBrowserTasks(root = getBrowserRuntimeDir()): LiveBrowserTask[] {
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(root, { withFileTypes: true }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  const out: LiveBrowserTask[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name === 'sessions') continue;
    out.push(...readLiveTasksFor(path.join(root, entry.name)));
  }
  return out;
}

export function watchToolActivity(options: ToolWatchOptions): { armed: () => boolean; stop: () => void } {
  const roots = options.roots ?? toolWatchRoots();
  const set = new ToolRowSet();
  if (options.initial) set.reset(options.initial);
  let dirty = false;
  let stopped = false;
  const watchers = new Map<string, fs.FSWatcher | undefined>(roots.map((root) => [root, undefined]));
  const armRoot = (root: string): void => {
    if (stopped || watchers.get(root)) return;
    try {
      fs.mkdirSync(root, { recursive: true, mode: 0o700 });
      const watcher = fs.watch(root, { recursive: true }, (_event, file) => {
        if (!String(file ?? '').endsWith('-shm')) dirty = true;
      });
      watcher.on('error', () => {
        watcher.close();
        if (watchers.get(root) === watcher) watchers.set(root, undefined);
        dirty = true;
      });
      watchers.set(root, watcher);
    } catch {  }
  };
  for (const root of roots) armRoot(root);

  const armed = () => [...watchers.values()].every((watcher) => watcher !== undefined);
  let projecting = false;
  const reproject = async () => {
    projecting = true;
    try {
      const snapshot = await span('feed.tools.collect', () => collectToolRows(options.scope, options.sources));
      if (stopped) return;
      if (snapshot.retry) dirty = true;
      const diff = spanSync('feed.tools.diff', () => set.diff(snapshot.rows, snapshot.incomplete), () => ({ rows: snapshot.rows.length }));
      if (diff.upserts.length > 0 || diff.removes.length > 0) options.onDiff(diff);
    } finally { projecting = false; }
  };
  const timer = setInterval(() => {
    for (const root of roots) armRoot(root);
    if (projecting || (armed() && !dirty)) return;
    dirty = false;
    void reproject();
  }, options.sweepMs ?? TOOL_SWEEP_MS);
  if (!options.initial) void reproject();
  const stop = () => {
    stopped = true;
    clearInterval(timer);
    for (const watcher of watchers.values()) watcher?.close();
    watchers.clear();
  };
  options.signal.addEventListener('abort', stop, { once: true });
  return { armed, stop };
}
