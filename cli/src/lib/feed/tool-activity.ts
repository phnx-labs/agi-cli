/** Event-driven tool-activity collector: gets `tools.ts` rows onto the feed stream without polling
 * `agents browser/computer sessions --json` (1,200 spawns/hour at 10 devices). Watches the roots,
 * emits only diffs; if watchers can't arm it says so via `armed` and sweeps. */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { getBrowserRuntimeDir } from '../state.js';
import { getEventsDir } from './events.js';
import { buildBrowserSessionRows, type BrowserSessionRow } from '../browser/sessions-list.js';
import { buildComputerSessionRows, standaloneComputerActionsDir, type ComputerRunRow } from '../computer/sessions-list.js';
import type { LiveBrowserTask, ToolTab } from './tools.js';
import { boundBrowserRow, projectBrowserToolRow, projectComputerToolRow, sortToolRows, type ToolRow } from './tools.js';

/** Re-projection cadence used only while no directory watcher could arm. */
export const TOOL_SWEEP_MS = 5_000;
/** Computer ledger rows read per projection. Bounds the newest-first window. */
const TOOL_COMPUTER_LIMIT = 500;

/** What one re-projection changed. Empty on both sides means nothing moved. */
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

/** One projection attempt; `complete` is false when any source threw. Load-bearing: a transient
 * read failure (tasks.json rewrite, rotating ledger, EMFILE) used to yield an empty list that
 * the differ published as a remove for every row. */
export interface ToolSnapshot {
  rows: ToolRow[];
  complete: boolean;
}

/** Projects every browser task and computer run this machine knows into canonical tool rows,
 * newest first. The three readers are injectable so tests drive real temp stores. */
export function collectToolRows(scope: string, sources: ToolSources = {}): ToolSnapshot {
  let complete = true;
  const read = <T>(source: () => T, empty: T): T => {
    try { return source(); } catch { complete = false; return empty; }
  };

  // Task-to-device binding is browser-cli's now (bound at `start`, PHNX-4101), so agents-cli keeps
  // no binding index. Cross-device tasks are driven from THIS box, so their `tasks.json` is local.
  // The `bindings` source stays a test seam.
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
  // `tasks.json` is the live authority (and the only source of tabs); the task index also routes a
  // task whose browser runs on another device. A task bound a second ago is live with no capture,
  // so deriving rows from captures alone hid it.
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

/** Holds the last projected row set and answers what changed. Identity is the projection's
 * `rowKey`: a task gaining a capture upserts under the same key, and a task gone from both
 * index and captures is a remove. */
export class ToolRowSet {
  private readonly rows = new Map<string, string>();

  /** The diff from the current set to `next`, and adopt `next` as current. */
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

  /** Adopt `rows` as the current set without emitting a diff (a reset). */
  reset(rows: ToolRow[]): void {
    this.rows.clear();
    for (const row of rows) this.rows.set(row.rowKey, JSON.stringify(row));
  }
}

interface ToolWatchOptions {
  scope: string;
  signal: AbortSignal;
  /** Called with every non-empty diff. */
  onDiff: (diff: ToolDiff) => void;
  /** Re-projection cadence while no watcher is armed. */
  sweepMs?: number;
  /** Roots to watch (tests pass temp dirs). */
  roots?: string[];
  /** Row sources, forwarded to {@link collectToolRows}. */
  sources?: ToolSources;
  /** Seed the set so the first diff reports only later changes. */
  initial?: ToolRow[];
}

/** The directory roots backing tool rows. The standalone computer ledger is its own root: the
 * engine writes there without going through agents-cli, so omitting it meant manual `computer`
 * runs were only noticed on a sweep from unrelated activity. */
export function toolWatchRoots(): string[] {
  return [getBrowserRuntimeDir(), getEventsDir(), standaloneComputerActionsDir()];
}

/** One profile's live task records with their tabs. Throws on an untrusted read: absent
 * `tasks.json` returns nothing, but EACCES, EMFILE or bad JSON must not look like "all closed"
 * (which removed every live row); failing lets collectToolRows keep the rows it has. */
function readLiveTasksFor(profileDir: string): LiveBrowserTask[] {
  const file = path.join(profileDir, 'tasks.json');
  let raw: string;
  try { raw = fs.readFileSync(file, 'utf8'); }
  catch (error) {
    // Only "it isn't there" is benign. Anything else is a read we cannot trust.
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  let parsed: unknown;
  try { parsed = JSON.parse(raw); }
  catch (error) {
    // A JSON error is NOT benign: the browser rewrites this file in place, so a
    // parse failure usually means we caught a write in progress — and the tasks
    // are still very much alive.
    throw new Error(`unreadable live task state at ${file}: ${(error as Error).message}`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`unexpected live task state at ${file}: expected an object of tasks`);
  }
  const out: LiveBrowserTask[] = [];
  for (const [name, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (!value || typeof value !== 'object') continue;
    const record = value as Record<string, unknown>;
    // `tabs` maps the task's SHORT id -> the engine's target id. The short id is
    // what `browser tab focus` takes and what stays stable across a reconnect,
    // so it is the id published; the target id is never surfaced.
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
      // The persisted schema is `createdAt` + `lastActionAt` (`browser/types.ts` Task). An earlier
      // revision read `startedAt` (a service.ts DTO field `tasks.json` never carries), so
      // zero-capture tasks had no start time and sorted last.
      ...(typeof record.createdAt === 'number' ? { startedAtMs: record.createdAt } : {}),
      // `lastActionAt` is refreshed by every task-scoped action, making it the honest freshness key
      // for a task with no capture yet. Tasks written before RUSH-2622 carry none; `createdAt` is
      // the fallback the browser's own reader uses.
      ...(typeof record.lastActionAt === 'number' ? { lastActionAtMs: record.lastActionAt }
        : typeof record.createdAt === 'number' ? { lastActionAtMs: record.createdAt } : {}),
      ...(typeof record.sessionId === 'string' ? { sessionId: record.sessionId } : {}),
      ...(typeof record.launchId === 'string' ? { launchId: record.launchId } : {}),
      ...(typeof record.actor === 'string' ? { actor: record.actor } : {}),
    });
  }
  return out;
}

/** Every live browser task on this machine across profile runtime dirs. THROWS like
 * readLiveTasksFor: a missing runtime dir means no tasks, but other readdir failures (EACCES,
 * EMFILE) must not return `[]`, which would tell the differ every task closed. */
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

/** Watches the tool roots and reports diffs until `signal` aborts. `armed()` is a function, not
 * a setup-time flag: a watcher can die later (directory recreated, inotify limit), and a frozen
 * `armed: true` let ticks short-circuit on `!dirty` and miss changes permanently. */
export function watchToolActivity(options: ToolWatchOptions): { armed: () => boolean; stop: () => void } {
  const roots = options.roots ?? toolWatchRoots();
  const set = new ToolRowSet();
  if (options.initial) set.reset(options.initial);
  let dirty = false;
  let stopped = false;
  /** One entry per root; `undefined` means that root needs re-arming. */
  const watchers = new Map<string, fs.FSWatcher | undefined>(roots.map((root) => [root, undefined]));
  const armRoot = (root: string): void => {
    if (stopped || watchers.get(root)) return;
    try {
      // A root that does not exist yet (no browser has ever run here) cannot be
      // watched, and would never be retried. Creating it arms the watcher now.
      fs.mkdirSync(root, { recursive: true });
      // Recursive: a capture lands in <root>/<profile>/sessions/<task>/, several
      // levels below the root, and a non-recursive watch never sees it.
      const watcher = fs.watch(root, { recursive: true }, () => { dirty = true; });
      watcher.on('error', () => {
        watcher.close();
        // Release the slot AND mark dirty: the events this watcher dropped
        // between failing and being replaced have to be picked up by a sweep,
        // or a change that landed inside that gap is lost for good.
        if (watchers.get(root) === watcher) watchers.set(root, undefined);
        dirty = true;
      });
      watchers.set(root, watcher);
    } catch { /* reported by armed(); the sweep covers it until it arms */ }
  };
  for (const root of roots) armRoot(root);
  const armed = () => [...watchers.values()].every((watcher) => watcher !== undefined);
  const reproject = () => {
    const snapshot = collectToolRows(options.scope, options.sources);
    // An incomplete read is not evidence a task closed. Keep the rows we have and
    // stay dirty so the next tick retries — publishing removes here is what made
    // live rows flicker out on a transient failure.
    if (!snapshot.complete) { dirty = true; return; }
    const diff = set.diff(snapshot.rows);
    if (diff.upserts.length > 0 || diff.removes.length > 0) options.onDiff(diff);
  };
  const timer = setInterval(() => {
    for (const root of roots) armRoot(root);
    // Fully-armed watchers mean a tick with nothing reported does NOTHING — no
    // directory read, no projection. That is the warm-idle guarantee, and it is
    // conditional on every root actually being watched right now.
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
