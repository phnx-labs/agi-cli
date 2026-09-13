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
import { getBrowserRuntimeDir } from '../state.js';
import { getEventsDir } from './events.js';
import { listTaskBindings } from '../browser/task-index.js';
import { buildBrowserSessionRows, type BrowserSessionRow } from '../browser/sessions-list.js';
import { buildComputerSessionRows, type ComputerRunRow } from '../computer/sessions-list.js';
import { projectBrowserToolRow, projectComputerToolRow, sortToolRows, type ToolRow } from './tools.js';

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
  bindings?: () => Array<{ name: string; device?: string; url?: string; createdAt?: number }>;
}

/**
 * Project every browser task and computer run this machine knows about into
 * canonical tool rows, newest first. Impure by design — the three readers are
 * injectable so a test drives real temp stores rather than a mocked service.
 */
export function collectToolRows(scope: string, sources: ToolSources = {}): ToolRow[] {
  const bindings = new Map<string, { device?: string; url?: string; createdAt?: number }>();
  try {
    for (const binding of (sources.bindings ?? listTaskBindings)()) bindings.set(binding.name, binding);
  } catch { /* a machine with no browser runtime dir simply has no live tasks */ }
  const rows: ToolRow[] = [];
  let browserRows: BrowserSessionRow[] = [];
  try { browserRows = (sources.browserRows ?? (() => buildBrowserSessionRows()))(); } catch { browserRows = []; }
  for (const row of browserRows) {
    rows.push(projectBrowserToolRow(scope, row, row.task ? bindings.get(row.task) : undefined));
  }
  let computerRows: ComputerRunRow[] = [];
  try { computerRows = (sources.computerRows ?? (() => buildComputerSessionRows({ limit: TOOL_COMPUTER_LIMIT })))(); } catch { computerRows = []; }
  for (const row of computerRows) rows.push(projectComputerToolRow(scope, row));
  return sortToolRows(rows);
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

/** The two directory roots whose contents back the tool rows. */
export function toolWatchRoots(): string[] {
  return [getBrowserRuntimeDir(), getEventsDir()];
}

/**
 * Watch the tool roots and report diffs until `signal` aborts. Resolves when
 * the watch stops. `armed` on the returned handle is false when no root could
 * be watched, which is the case the sweep cadence covers.
 */
export function watchToolActivity(options: ToolWatchOptions): { armed: boolean; stop: () => void } {
  const roots = options.roots ?? toolWatchRoots();
  const set = new ToolRowSet();
  if (options.initial) set.reset(options.initial);
  let dirty = false;
  const watchers: fs.FSWatcher[] = [];
  for (const root of roots) {
    try {
      // A root that does not exist yet (no browser has ever run here) cannot be
      // watched, and would never be retried. Creating it arms the watcher now.
      fs.mkdirSync(root, { recursive: true });
      // Recursive: a capture lands in <root>/<profile>/sessions/<task>/, several
      // levels below the root, and a non-recursive watch never sees it.
      const watcher = fs.watch(root, { recursive: true }, () => { dirty = true; });
      watcher.on('error', () => watcher.close());
      watchers.push(watcher);
    } catch { /* counted by `armed` below; the sweep covers it */ }
  }
  const armed = watchers.length === roots.length;
  const reproject = () => {
    const diff = set.diff(collectToolRows(options.scope, options.sources));
    if (diff.upserts.length > 0 || diff.removes.length > 0) options.onDiff(diff);
  };
  const timer = setInterval(() => {
    // Armed watchers mean a tick with nothing reported does NOTHING — no
    // directory read, no projection. That is the warm-idle guarantee.
    if (armed && !dirty) return;
    dirty = false;
    reproject();
  }, options.sweepMs ?? TOOL_SWEEP_MS);
  const stop = () => {
    clearInterval(timer);
    for (const watcher of watchers) watcher.close();
  };
  options.signal.addEventListener('abort', stop, { once: true });
  return { armed, stop };
}
