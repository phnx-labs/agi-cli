/** Read-only run history over the `computer.action` event ledger (canonical, RUSH-2432) plus the
 * longer-lived `computer_sessions` table (RUSH-2549). Metadata only: typed text is never stored
 * (only `textLength`); `run --task` capped at TASK_PREVIEW_MAX_CHARS. Grouped by `invocationId`. */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { getCacheDir } from '../state.js';
import { machineId } from '../machine-id.js';
import { query, truncate, type EventRecord } from '../feed/events.js';
import { formatRelativeTime } from '../session/relative-time.js';
import type { SessionMeta } from '@phnx-labs/sessions-cli/reader';
import { getSessionById, listComputerSessionRecords, pruneToolSessions } from '../session/db.js';
import { sessionHeadline } from '../session/title.js';
import {
  buildLaunchSessionIndex,
  resolveLaunchSession,
} from '../browser/sessions-list.js';

/** Max chars of a `run --task` description persisted to the ledger — see the
 *  module docblock's retention/privacy note. */
export const TASK_PREVIEW_MAX_CHARS = 200;

/** Cap on how many raw ledger rows a single read scans/returns. `query()`
 *  already reads newest-first and stops at this cutoff mid-scan, so raising
 *  it only ever costs as much as the history actually holds. */
const DEFAULT_ACTION_LIMIT = 5000;

/** One `computer.action` ledger entry, narrowed to the fields this module
 *  renders or groups by. */
export interface ComputerAction {
  /** CLI verb: `click`, `type`, `screenshot`, … or `run` for the task marker
   *  `registerRunCommand` emits before entering the model loop. */
  verb: string;
  ts: string;
  tsMs: number;
  /** The emitting CLI process's own pid — the run/task grouping key. */
  pid: number;
  /** Unique for the emitting CLI process; absent only on legacy ledger rows. */
  invocationId?: string;
  /** The driven app's pid, when resolved. */
  targetPid?: number;
  bundle?: string;
  /** `--device <device>` target when this action drove a remote daemon. */
  host?: string;
  /** Truncated `--task` text; only ever present on a `verb: 'run'` marker. */
  task?: string;
  sessionId?: string;
  launchId?: string;
  agent?: string;
  machineId?: string;
  hostname?: string;
  /** The file a successful `screenshot` wrote, recorded by the engine only after the write
   * succeeded, so a path is never derived from the verb. Older actions without it report no
   * capture rather than a guess. */
  capture?: { path: string; kind: 'screenshot'; name: string; bytes?: number };
}

/** A capture record, accepted only when the producer gave a real path + name. */
function parseActionCapture(value: unknown): ComputerAction['capture'] | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const record = value as Record<string, unknown>;
  if (typeof record.path !== 'string' || !record.path) return undefined;
  const name = typeof record.name === 'string' && record.name ? record.name : path.basename(record.path);
  return {
    path: record.path,
    kind: 'screenshot',
    name,
    ...(typeof record.bytes === 'number' ? { bytes: record.bytes } : {}),
  };
}

function recordToAction(r: EventRecord): ComputerAction | null {
  if (typeof r.command !== 'string' || typeof r.pid !== 'number') return null;
  const tsMs = Date.parse(r.ts);
  if (Number.isNaN(tsMs)) return null;
  return {
    verb: r.command,
    ts: r.ts,
    tsMs,
    pid: r.pid,
    invocationId: typeof r.invocationId === 'string' ? r.invocationId : undefined,
    targetPid: typeof r.targetPid === 'number' ? r.targetPid : undefined,
    bundle: typeof r.bundle === 'string' ? r.bundle : undefined,
    host: typeof r.host === 'string' ? r.host : undefined,
    task: typeof r.task === 'string' ? r.task : undefined,
    sessionId: typeof r.sessionId === 'string' ? r.sessionId : undefined,
    launchId: typeof r.launchId === 'string' ? r.launchId : undefined,
    agent: typeof r.agent === 'string' ? r.agent : undefined,
    machineId: typeof r.machineId === 'string' ? r.machineId : undefined,
    hostname: typeof r.hostname === 'string' ? r.hostname : undefined,
    capture: parseActionCapture(r.capture),
  };
}

/** The standalone engine's own action ledger: it always appends every action to
 * `<cache>/computer/actions/<day>.jsonl` (PHNX-4075), even when agents-cli was not involved. A
 * `computer` command run directly appears only here. */
export function standaloneComputerActionsDir(): string {
  return path.join(getCacheDir(), 'computer', 'actions');
}

/** One line of the standalone ledger as a ComputerAction: the same `computer.action` event the
 * engine reports on fd 4. A record lacking `command` or a parseable timestamp is skipped, never
 * defaulted (another process may be mid-append). */
function standaloneLineToAction(line: string, observer: string): ComputerAction | null {
  let parsed: unknown;
  try { parsed = JSON.parse(line); } catch { return null; }
  if (!parsed || typeof parsed !== 'object') return null;
  const record = parsed as Record<string, unknown>;
  const verb = typeof record.command === 'string' ? record.command : undefined;
  const ts = typeof record.ts === 'string' ? record.ts : undefined;
  if (!verb || !ts) return null;
  const tsMs = Date.parse(ts);
  if (Number.isNaN(tsMs)) return null;
  const text = (key: string): string | undefined => (typeof record[key] === 'string' ? record[key] as string : undefined);
  const num = (key: string): number | undefined => (typeof record[key] === 'number' ? record[key] as number : undefined);
  // The producer names the driven host only for a remote run, so default `hostname`/`machineId` to
  // the observing machine here: without it local actions got `machine: 'unknown'` and vanished
  // under any device filter. The ledger is per-machine; an explicit `host` still wins.
  return {
    verb, ts, tsMs,
    // The engine's pid is its own; a record without one still groups by
    // invocationId, which is the identity that actually matters here.
    pid: num('pid') ?? 0,
    invocationId: text('invocationId'),
    targetPid: num('targetPid'),
    bundle: text('bundle'),
    host: text('host'),
    task: text('task'),
    sessionId: text('sessionId'),
    launchId: text('launchId'),
    agent: text('agent'),
    machineId: text('machineId'),
    hostname: text('hostname') ?? observer,
    capture: parseActionCapture(record.capture),
  };
}

/** Read the standalone ledger newest day first, bounded by `limit` actions; stops once the budget
 * is met, so months of history cost the same as one day. */
export function listStandaloneComputerActions(opts: { limit?: number; dir?: string; observer?: string } = {}): ComputerAction[] {
  const dir = opts.dir ?? standaloneComputerActionsDir();
  const limit = opts.limit ?? DEFAULT_ACTION_LIMIT;
  // This ledger is per-machine by construction, so "who ran it" is this machine
  // unless the record names a driven remote host.
  const observer = opts.observer ?? machineId();
  let days: string[];
  try {
    days = fs.readdirSync(dir).filter((name) => name.endsWith('.jsonl')).sort().reverse();
  } catch {
    return []; // The engine has never run here, or is not installed.
  }
  const out: ComputerAction[] = [];
  for (const day of days) {
    if (out.length >= limit) break;
    let lines: string[];
    try { lines = fs.readFileSync(path.join(dir, day), 'utf8').split('\n'); }
    catch { continue; /* rotated or removed mid-read */ }
    // Newest last within a day, and the budget favours the newest actions.
    for (let index = lines.length - 1; index >= 0 && out.length < limit; index--) {
      const line = lines[index]!;
      if (!line) continue;
      const action = standaloneLineToAction(line, observer);
      if (action) out.push(action);
    }
  }
  out.sort((a, b) => b.tsMs - a.tsMs);
  return out;
}

/** Union the two ledgers, preferring the standalone record for runs in both. Dedupe on the
 * engine-minted `invocationId`, since forwarding rewrites `ts` and `pid`. A legacy record with no
 * invocationId is kept. */
export function mergeComputerActionSources(standalone: ComputerAction[], legacy: ComputerAction[]): ComputerAction[] {
  const standaloneRuns = new Set<string>();
  for (const action of standalone) if (action.invocationId) standaloneRuns.add(action.invocationId);
  const merged = [...standalone];
  for (const action of legacy) {
    if (action.invocationId && standaloneRuns.has(action.invocationId)) continue;
    merged.push(action);
  }
  merged.sort((a, b) => b.tsMs - a.tsMs);
  return merged;
}

/** Read `computer.action` events from the durable event ledger, newest first, bounded by `limit`.
 * Malformed or legacy records are skipped, not thrown (the file may be mid-write or mid-rotate). */
export function listComputerActions(opts: { limit?: number } = {}): ComputerAction[] {
  const records = query({ eventTypes: ['computer.action'], limit: opts.limit ?? DEFAULT_ACTION_LIMIT });
  const out: ComputerAction[] = [];
  for (const r of records) {
    const a = recordToAction(r);
    if (a) out.push(a);
  }
  return out;
}

/** Why a row carries no session digest: `linked` resolved one, `unresolved`
 *  has a sessionId/launchId but no matching indexed session, `unlinked` has
 *  neither (a bare terminal invocation with no agent session env at all). */
export type ComputerRunLinkStatus = 'linked' | 'unresolved' | 'unlinked';

/** One task-first row: every `computer.action` emitted by one CLI process
 *  (see the module docblock's "Grouping key" note), plus the agent session
 *  it links to when resolvable. */
export interface ComputerRunRow {
  /** Invoking CLI process's pid. Absent on a run recovered from the DB after
   *  the ledger pruned — that process is long gone and its pid unknowable. */
  pid?: number;
  invocationId?: string;
  /** Total actions for a run recovered from the DB after the ledger pruned its actions. Set only on
   * such rows, where `actions`/`counts` are empty because the per-verb detail is gone. */
  recoveredActionCount?: number;
  /** Truncated task description — present only for a `computer run --task`
   *  invocation; a bare verb call has none. */
  task?: string;
  /** Invoking machine's hostname — the CLI's own machine, not necessarily
   *  the driven one (see `remoteHost`). */
  machine: string;
  machineId?: string;
  /** `--device <device>` target when the run drove a remote (Windows) daemon. */
  remoteHost?: string;
  /** Best-known target app bundle across the run's actions. */
  bundle?: string;
  agent?: string;
  sessionId?: string;
  launchId?: string;
  linkStatus: ComputerRunLinkStatus;
  linkedSession?: SessionMeta;
  /** Newest first; excludes the `run` task marker itself. */
  actions: ComputerAction[];
  /** Per-verb counts over `actions` (never includes the `run` marker). */
  counts: Record<string, number>;
  /** Oldest action's mtime — the row's start. */
  startMs: number;
  /** Newest action's mtime — the row's sort/age key. */
  endMs: number;
}

/** Group flat ledger actions into task-first rows, newest first. Pure: session resolvers are passed
 * in (see buildComputerSessionRows for the impure caller). */
export function groupIntoComputerRuns(
  actions: ComputerAction[],
  resolveSession?: (sessionId: string) => SessionMeta | null,
  resolveLaunch?: (launchId: string) => SessionMeta | null,
): ComputerRunRow[] {
  const byInvocation = new Map<string, ComputerAction[]>();
  for (const [index, a] of actions.entries()) {
    // Legacy rows have no trustworthy process identity. Pids are recyclable,
    // so preserve each event separately instead of inventing a relationship.
    const key = a.invocationId ?? `legacy:${a.pid}:${a.tsMs}:${index}`;
    const list = byInvocation.get(key) ?? [];
    list.push(a);
    byInvocation.set(key, list);
  }

  const rows: ComputerRunRow[] = [];
  for (const group of byInvocation.values()) {
    const pid = group[0].pid;
    group.sort((a, b) => b.tsMs - a.tsMs); // newest first

    const marker = group.find((a) => a.verb === 'run');
    const driving = group.filter((a) => a.verb !== 'run');
    const counts: Record<string, number> = {};
    for (const a of driving) counts[a.verb] = (counts[a.verb] ?? 0) + 1;

    const bundle = group.find((a) => a.bundle)?.bundle;
    const remoteHost = group.find((a) => a.host)?.host;
    const identity = group.find((a) => a.sessionId || a.launchId) ?? group[0];
    const machine = group.find((a) => a.hostname)?.hostname ?? 'unknown';
    const machineId = group.find((a) => a.machineId)?.machineId;

    let linkedSession: SessionMeta | null = null;
    if (identity.sessionId) linkedSession = resolveSession?.(identity.sessionId) ?? null;
    if (!linkedSession && identity.launchId) linkedSession = resolveLaunch?.(identity.launchId) ?? null;

    const times = group.map((a) => a.tsMs);
    rows.push({
      pid,
      invocationId: group[0].invocationId,
      task: marker?.task,
      machine,
      machineId,
      remoteHost,
      bundle,
      agent: identity.agent,
      sessionId: identity.sessionId,
      launchId: identity.launchId,
      linkStatus: linkedSession ? 'linked' : (identity.sessionId || identity.launchId) ? 'unresolved' : 'unlinked',
      linkedSession: linkedSession ?? undefined,
      actions: driving,
      counts,
      startMs: Math.min(...times),
      endMs: Math.max(...times),
    });
  }

  rows.sort((a, b) => b.endMs - a.endMs);
  return rows;
}

/** Add runs the ledger no longer holds from the durable `computer_sessions` table (RUSH-2549); the
 * ledger prunes at 7 days / 50 MiB and runs used to vanish on day 8. A recovered row has identity,
 * timing and action COUNT but an empty `actions` list, never fabricated. */
function appendPrunedRunsFromDb(rows: ComputerRunRow[], limit?: number): void {
  const seen = new Set(rows.map((r) => r.invocationId));
  // Ask the DB only for what the ledger cannot hold: rows older than the oldest ledger action.
  // Reading the newest N is self-defeating (they are what `seen` discards), so history would
  // vanish past the ledger window again.
  const startedBeforeMs = rows.length > 0
    ? Math.min(...rows.map((r) => r.startMs))
    : undefined;
  for (const record of listComputerSessionRecords({ limit, startedBeforeMs })) {
    // The dedup is load-bearing, not redundant with the WHERE clause: a DB `started_at` is the
    // true start while the ledger `startMs` is its oldest retained action, so a long run that
    // began before the window is selected by SQL yet already present as a ledger row.
    if (seen.has(record.invocationId)) continue;
    const linked = record.sessionId ? getSessionById(record.sessionId) : null;
    rows.push({
      // No pid: the process is long gone and the ledger entry that knew it has
      // been pruned. Fabricating `0` rendered rows labelled "pid 0" (see the
      // label fallbacks in this file and computer-sessions-picker.ts).
      pid: undefined,
      invocationId: record.invocationId,
      task: record.taskPreview,
      // The DB stores the normalized machineId ("zion") while the ledger records the raw hostname
      // ("Zion.local"); setting both from the one value keeps `--machine` substring filtering
      // working on either (see events.ts).
      machine: record.machine,
      machineId: record.machine,
      bundle: undefined,
      remoteHost: undefined,
      agent: undefined,
      sessionId: record.sessionId,
      launchId: record.launchId,
      linkStatus: linked ? 'linked' : (record.sessionId || record.launchId) ? 'unresolved' : 'unlinked',
      linkedSession: linked ?? undefined,
      // The per-verb breakdown is gone and never reconstructed; the total survives and is reported
      // explicitly so a 40-action run does not render like one that did nothing.
      actions: [],
      counts: {},
      recoveredActionCount: record.actionCount,
      startMs: record.startedAt,
      endMs: record.lastActivity ?? record.startedAt,
    });
  }
}

/** Build task-first rows from the real ledger, resolving each row's session against live indexes;
 * data source for the picker and flat/`--json` printer. `machine` filters by hostname, machineId
 * or `--device` substring. */
export function buildComputerSessionRows(opts: { limit?: number; machine?: string; observer?: string } = {}): ComputerRunRow[] {
  const actions = mergeComputerActionSources(
    // `observer` is threaded from the caller's scope so a row's device and the
    // scope that reported it can never name the same box differently.
    listStandaloneComputerActions({ limit: opts.limit, ...(opts.observer ? { observer: opts.observer } : {}) }),
    listComputerActions({ limit: opts.limit }),
  );
  const index = buildLaunchSessionIndex();
  const rows = groupIntoComputerRuns(
    actions,
    (sessionId) => getSessionById(sessionId),
    (launchId) => resolveLaunchSession(index, launchId),
  );
  // Retention runs here, on the listing path, never on the action hot path:
  // one row per `agents computer` CLI process means the table would otherwise
  // grow without bound. Best-effort — a read-only DB must not break a listing.
  try { pruneToolSessions(); } catch { /* listing must not fail on retention */ }
  appendPrunedRunsFromDb(rows, opts.limit);
  rows.sort((a, b) => b.endMs - a.endMs);
  if (!opts.machine) return rows;
  const q = opts.machine.toLowerCase();
  return rows.filter(
    (r) =>
      r.machine.toLowerCase().includes(q) ||
      r.remoteHost?.toLowerCase().includes(q) ||
      r.machineId?.toLowerCase().includes(q),
  );
}

/** Search predicate for the interactive picker: task text, machine/host, target bundle, the linked
 * session's agent/topic/label, or any driven verb. */
export function matchesComputerSessionRow(row: ComputerRunRow, queryText: string): boolean {
  const q = queryText.trim().toLowerCase();
  if (!q) return true;
  if (row.task?.toLowerCase().includes(q)) return true;
  if (row.machine.toLowerCase().includes(q)) return true;
  if (row.remoteHost?.toLowerCase().includes(q)) return true;
  if (row.bundle?.toLowerCase().includes(q)) return true;
  const s = row.linkedSession;
  if (s && (s.agent.toLowerCase().includes(q) || s.topic?.toLowerCase().includes(q) || s.label?.toLowerCase().includes(q))) {
    return true;
  }
  return row.actions.some((a) => a.verb.toLowerCase().includes(q));
}

/** Human one-line summary of a row's per-verb action counts, most frequent
 *  first — shared by the flat table and the interactive picker's label. */
/** One row's action summary, the single renderer for every surface. A DB-recovered run has only a
 * total; the per-verb formatter printed "(no actions)", so say plainly that the breakdown is gone. */
export function formatRowActions(row: ComputerRunRow): string {
  if (row.recoveredActionCount !== undefined) {
    const n = row.recoveredActionCount;
    return `${n} action${n === 1 ? '' : 's'} (per-verb detail pruned from the event log)`;
  }
  return formatActionCounts(row.counts);
}

export function formatActionCounts(counts: Record<string, number>): string {
  const parts = Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .map(([verb, n]) => `${verb} ${n}`);
  return parts.join(', ') || '(no actions)';
}

/** Human table for the CLI. Returns lines (no trailing newline). */
export function renderComputerSessionRows(rows: ComputerRunRow[]): string {
  if (rows.length === 0) return 'No computer actions recorded.';
  const lines: string[] = [];
  for (const r of rows) {
    const when = formatRelativeTime(new Date(r.endMs).toISOString());
    const where = r.remoteHost ? `${r.machine} -> ${r.remoteHost}` : r.machine;
    const label = r.task ? truncate(r.task, 60) : (r.bundle ?? `pid ${r.pid}`);
    const link =
      r.linkStatus === 'linked' && r.linkedSession
        ? `${r.linkedSession.agent} — ${sessionHeadline(r.linkedSession) || r.linkedSession.shortId}`
        : r.linkStatus === 'unresolved'
          ? 'unresolved (session not indexed here)'
          : 'unlinked';
    lines.push(`${when.padEnd(12)}  ${where.padEnd(24)}  ${String(label ?? '').padEnd(40)}  ${link}`);
    lines.push(`  ${formatRowActions(r)}`);
  }
  return lines.join('\n');
}

/** Default row cap for the flat table. A computer row is fine-grained (mostly one verb per
 * invocation), so an unbounded dump is hundreds of rows. The searchable picker is uncapped;
 * `--limit` overrides. */
export const DEFAULT_ROW_DISPLAY_LIMIT = 50;

/** Slice `rows` to at most `limit` (newest first, rows are already sorted),
 *  and report how many were dropped — pure, so the cap arithmetic and the
 *  trailer condition are unit-testable without a console spy. */
export function applyRowDisplayLimit(
  rows: ComputerRunRow[],
  limit: number = DEFAULT_ROW_DISPLAY_LIMIT,
): { shown: ComputerRunRow[]; more: number } {
  const shown = rows.slice(0, limit);
  return { shown, more: rows.length - shown.length };
}

/** Shared CLI action for `agents computer sessions` and `agents sessions --computer`.
 * Non-interactive; interactive routing lives in `commands/computer-sessions-picker.ts`, mirroring
 * the browser split. */
export function runComputerSessions(opts: { machine?: string; json?: boolean; limit?: number }): void {
  const rows = buildComputerSessionRows({ machine: opts.machine });
  printComputerSessionRows(rows, opts);
}

/** Print already-collected rows. Fleet callers use this after merging local and
 * remote JSON so text, limits, and JSON keep exactly one renderer. */
export function printComputerSessionRows(
  rows: ComputerRunRow[],
  opts: { json?: boolean; limit?: number },
): void {
  if (opts.json) {
    console.log(JSON.stringify(rows, null, 2));
    return;
  }
  const { shown, more } = applyRowDisplayLimit(rows, opts.limit ?? DEFAULT_ROW_DISPLAY_LIMIT);
  console.log(renderComputerSessionRows(shown));
  if (more > 0) console.log(`\n… (${more} more; --limit ${rows.length} or --json to see all, --machine to narrow)`);
}
