/**
 * Event-driven tool-activity collector — the thing that makes the rows in
 * `tools.ts` reach the feed stream without a poll.
 *
 * THE COST THIS EXISTS TO AVOID. A status surface that wants "which browser
 * tasks and computer runs are there right now" has, until this module, one way
 * to ask: run `agents browser sessions --json` and `agents computer sessions
 * --json`, per device, on a timer. Two subprocesses per tool per device per
 * tick, each paying a full CLI boot, to answer "nothing changed" almost every
 * time. A menu bar at a one-minute cadence over a ten-device fleet is 1,200
 * process spawns an hour for, typically, zero new rows.
 *
 * WHAT REPLACES IT. The two sources are files on the machine that owns them:
 * the browser runtime tree (task index + capture dirs) and the event ledger
 * that `computer.action` appends to. This collector watches those roots, and
 * re-projects ONLY when one of them reports a change. A warm idle does no work
 * at all: no directory read, no subprocess, no emission. When something does
 * change it re-projects and emits the DIFF — the changed rows and the vanished
 * row keys — never a full snapshot, so a single new screenshot costs one
 * `tool.upsert`.
 *
 * WHEN THE WATCHERS CANNOT ARM (an unsupported filesystem, a root that does not
 * exist yet) the collector says so on `armed` and re-projects on the bounded
 * sweep cadence instead. That is a stated degradation, not a silent one: a
 * caller can surface it, and the diff shape is identical either way.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { getBrowserRuntimeDir } from '../state.js';
import { getEventsDir } from './events.js';
import { listTaskBindings } from '../browser/task-index.js';
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

/**
 * One projection attempt. `complete` is false when any source threw.
 *
 * The flag is load-bearing, not diagnostic. A transient read failure — the
 * browser rewriting `tasks.json`, a rotating ledger, an EMFILE — used to yield an
 * EMPTY row list, which the differ then read as "every task closed" and published
 * as a remove for every row. The operator watched their live tasks vanish and
 * come back. An incomplete projection is not evidence of absence, so the caller
 * keeps the state it already had.
 */
export interface ToolSnapshot {
  rows: ToolRow[];
  complete: boolean;
}

/**
 * Project every browser task and computer run this machine knows about into
 * canonical tool rows, newest first. Impure by design — the three readers are
 * injectable so a test drives real temp stores rather than a mocked service.
 */
export function collectToolRows(scope: string, sources: ToolSources = {}): ToolSnapshot {
  let complete = true;
  const read = <T>(source: () => T, empty: T): T => {
    try { return source(); } catch { complete = false; return empty; }
  };

  const bindings = new Map<string, { device?: string; profile?: string; url?: string; createdAt?: number; sessionId?: string; launchId?: string }>();
  for (const binding of read(sources.bindings ?? listTaskBindings, [])) bindings.set(binding.name, binding);
  const liveTasks = new Map<string, LiveBrowserTask>();
  for (const task of read(sources.liveTasks ?? (() => readLiveBrowserTasks()), [])) liveTasks.set(task.task, task);

  const rows: ToolRow[] = [];
  const browserRows = read(sources.browserRows ?? (() => buildBrowserSessionRows()), [] as BrowserSessionRow[]);
  const captured = new Set<string>();
  for (const row of browserRows) {
    if (row.task) captured.add(row.task);
    rows.push(projectBrowserToolRow(scope, row, row.task ? bindings.get(row.task) : undefined, row.task ? liveTasks.get(row.task) : undefined));
  }
  // Neither the capture tree nor the task index alone answers "which tasks exist".
  // `tasks.json` is the live authority (and the only source of tabs); the task
  // index additionally routes a task whose browser runs on ANOTHER device, which
  // has no local live record. A task bound a second ago is live and closable with
  // no capture to its name, and deriving rows from captures alone hid exactly that.
  for (const task of new Set([...liveTasks.keys(), ...bindings.keys()])) {
    if (captured.has(task)) continue;
    const binding = bindings.get(task);
    const live = liveTasks.get(task);
    rows.push(projectBrowserToolRow(scope, boundBrowserRow(task, live ?? binding ?? {}), binding, live));
  }
  const computerRows = read(sources.computerRows ?? (() => buildComputerSessionRows({ limit: TOOL_COMPUTER_LIMIT })), [] as ComputerRunRow[]);
  for (const row of computerRows) rows.push(projectComputerToolRow(scope, row));
  return { rows: sortToolRows(rows), complete };
}

/**
 * Holds the last projected row set and answers "what changed?".
 *
 * Row identity is the projection's own `rowKey`, so a browser task that gains a
 * capture upserts under the same key, and a closed task — gone from both the
 * index and the capture tree — comes back as a remove.
 */
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

/**
 * The directory roots whose contents back the tool rows.
 *
 * The standalone computer ledger is its OWN root: the engine writes there
 * directly, without going through agents-cli, so nothing under the event-ledger
 * or browser roots changes when an operator runs `computer` by hand. Omitting it
 * meant those actions were only ever noticed on a sweep triggered by unrelated
 * activity.
 */
export function toolWatchRoots(): string[] {
  return [getBrowserRuntimeDir(), getEventsDir(), standaloneComputerActionsDir()];
}

/** One profile's live task records, with the tabs each task addresses. */
function readLiveTasksFor(profileDir: string): LiveBrowserTask[] {
  let parsed: unknown;
  try { parsed = JSON.parse(fs.readFileSync(path.join(profileDir, 'tasks.json'), 'utf8')); }
  catch { return []; /* no live browser on this profile */ }
  if (!parsed || typeof parsed !== 'object') return [];
  const out: LiveBrowserTask[] = [];
  for (const [name, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (!value || typeof value !== 'object') continue;
    const record = value as Record<string, unknown>;
    // `tabs` maps the task's SHORT id -> the engine's target id. The short id is
    // what `browser show --tab` takes and what stays stable across a reconnect,
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
      ...(typeof record.startedAt === 'number' ? { startedAtMs: record.startedAt } : {}),
      ...(typeof record.sessionId === 'string' ? { sessionId: record.sessionId } : {}),
      ...(typeof record.launchId === 'string' ? { launchId: record.launchId } : {}),
    });
  }
  return out;
}

/** Every live browser task on this machine, across every profile runtime dir. */
export function readLiveBrowserTasks(root = getBrowserRuntimeDir()): LiveBrowserTask[] {
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(root, { withFileTypes: true }); }
  catch { return []; }
  const out: LiveBrowserTask[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name === 'sessions') continue;
    out.push(...readLiveTasksFor(path.join(root, entry.name)));
  }
  return out;
}

/**
 * Watch the tool roots and report diffs until `signal` aborts.
 *
 * `armed()` reports whether every root currently has a live watcher. It is a
 * FUNCTION, not a flag captured at setup: a watcher can die later (its directory
 * is removed and recreated, an inotify limit is hit), and a frozen `armed: true`
 * meant the tick kept short-circuiting on `!dirty` from a watcher that would
 * never report again — changes were then missed permanently, with the handle
 * still claiming to be armed. Each tick re-arms whatever is missing and sweeps
 * until everything is watched again.
 */
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
