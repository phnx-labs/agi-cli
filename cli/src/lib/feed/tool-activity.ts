import * as fs from 'node:fs';
import * as path from 'node:path';
import { getBrowserRuntimeDir } from '../state.js';
import { getEventsDir } from './events.js';
import { buildBrowserSessionRows, type BrowserSessionRow } from '../browser/sessions-list.js';
import { buildComputerSessionRows, standaloneComputerActionsDir, type ComputerRunRow } from '../computer/sessions-list.js';
import type { LiveBrowserTask, ToolTab } from './tools.js';
import { boundBrowserRow, projectBrowserToolRow, projectComputerToolRow, sortToolRows, type ToolRow } from './tools.js';

export const TOOL_SWEEP_MS = 5_000;
const TOOL_COMPUTER_LIMIT = 500;

export interface ToolDiff {
  upserts: ToolRow[];
  removes: string[];
}

interface ToolSources {
  browserRows?: () => BrowserSessionRow[];
  computerRows?: () => ComputerRunRow[];
  bindings?: () => Array<{ name: string; device?: string; profile?: string; url?: string; createdAt?: number; sessionId?: string; launchId?: string }>;
  liveTasks?: () => LiveBrowserTask[];
}

export interface ToolSnapshot {
  rows: ToolRow[];
  complete: boolean;
}

export function collectToolRows(scope: string, sources: ToolSources = {}): ToolSnapshot {

  let complete = true;
  const read = <T>(source: () => T, empty: T): T => {
    try { return source(); } catch { complete = false; return empty; }
  };

  const bindings = new Map<string, { device?: string; profile?: string; url?: string; createdAt?: number; sessionId?: string; launchId?: string }>();
  for (const binding of read(sources.bindings ?? (() => []), [])) bindings.set(binding.name, binding);
  const liveTasks = new Map<string, LiveBrowserTask>();
  for (const task of read(sources.liveTasks ?? (() => readLiveBrowserTasks()), [])) liveTasks.set(task.task, task);

  const rows: ToolRow[] = [];
  const browserRows = read(sources.browserRows ?? (() => buildBrowserSessionRows()), [] as BrowserSessionRow[]);
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
  const computerRows = read(sources.computerRows ?? (() => buildComputerSessionRows({ limit: TOOL_COMPUTER_LIMIT, observer: scope })), [] as ComputerRunRow[]);
  for (const row of computerRows) rows.push(projectComputerToolRow(scope, row));
  return { rows: sortToolRows(rows), complete };
}

export class ToolRowSet {
  private readonly rows = new Map<string, string>();

  diff(next: ToolRow[]): ToolDiff {
    const upserts: ToolRow[] = [];
    const seen = new Set<string>();
    for (const row of next) {
      seen.add(row.rowKey);
      const serialized = JSON.stringify(row);
      if (this.rows.get(row.rowKey) === serialized) continue;
      this.rows.set(row.rowKey, serialized);
      upserts.push(row);
    }
    const removes: string[] = [];
    for (const key of [...this.rows.keys()]) {
      if (seen.has(key)) continue;
      this.rows.delete(key);
      removes.push(key);
    }
    return { upserts, removes };
  }

  reset(rows: ToolRow[]): void {
    this.rows.clear();
    for (const row of rows) this.rows.set(row.rowKey, JSON.stringify(row));
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

export function toolWatchRoots(): string[] {
  return [getBrowserRuntimeDir(), getEventsDir(), standaloneComputerActionsDir()];
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
      fs.mkdirSync(root, { recursive: true });
      const watcher = fs.watch(root, { recursive: true }, () => { dirty = true; });
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
  const reproject = () => {
    const snapshot = collectToolRows(options.scope, options.sources);
    if (!snapshot.complete) { dirty = true; return; }
    const diff = set.diff(snapshot.rows);
    if (diff.upserts.length > 0 || diff.removes.length > 0) options.onDiff(diff);
  };
  const timer = setInterval(() => {
    for (const root of roots) armRoot(root);
    if (armed() && !dirty) return;
    dirty = false;
    reproject();
  }, options.sweepMs ?? TOOL_SWEEP_MS);
  const stop = () => {
    stopped = true;
    clearInterval(timer);
    for (const watcher of watchers.values()) watcher?.close();
    watchers.clear();
  };
  options.signal.addEventListener('abort', stop, { once: true });
  return { armed, stop };
}
