import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { SessionMeta } from '@phnx-labs/sessions-cli/reader';
import { getBrowserRuntimeDir, getCacheDir } from '../state.js';
import { getEventsDir } from './events.js';
import { readRecentActivity } from './activity.js';
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

function buildLaunchSessionIndex(): Map<string, string> {
  return spanSync('feed.tools.launch-index', buildLaunchSessionIndexNow);
}

function buildLaunchSessionIndexNow(): Map<string, string> {
  const byLaunchId = new Map<string, string>();
  for (const event of readRecentActivity({ maxBytesPerSession: 64 * 1024 })) {
    if (event.launchId && event.sessionId) byLaunchId.set(event.launchId, event.sessionId);
  }
  for (const [launchId, record] of loadHookSessionIndex().byLaunchId) {
    if (record.session_id) byLaunchId.set(launchId, record.session_id);
  }
  for (const entry of listPidSessionEntries()) {
    if (entry.launchId && entry.sessionId) byLaunchId.set(entry.launchId, entry.sessionId);
  }
  return byLaunchId;
}

/** The tools record a session or launch id; only agents-cli's index can say which agent session that was. */
export function linkToolSessions<T extends { sessionId?: string; launchId?: string; linkedSession?: SessionMeta }>(rows: T[]): T[] {
  return spanSync('feed.tools.link-sessions', () => linkToolSessionsNow(rows), () => ({ rows: rows.length }));
}

function linkToolSessionsNow<T extends { sessionId?: string; launchId?: string; linkedSession?: SessionMeta }>(rows: T[]): T[] {
  let byLaunchId: Map<string, string> | undefined;
  return rows.map((row) => {
    let linked = row.sessionId ? getSessionById(row.sessionId) : null;
    if (!linked && row.launchId) {
      byLaunchId ??= buildLaunchSessionIndex();
      const sessionId = byLaunchId.get(row.launchId);
      linked = sessionId ? getSessionById(sessionId) : null;
    }
    return linked ? { ...row, linkedSession: linked } : row;
  });
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
