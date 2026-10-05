/**
 * Read-only task/run history over the `computer.action` event ledger
 * (`~/.agents/.history/events/YYYY-MM-DD/events.jsonl`, see `../events.ts`) —
 * the durable, already-existing audit log every `agents computer <verb>`
 * invocation writes through `computer/record.ts`'s `recordComputerAction()`,
 * fed by the action events the standalone engine streams back (PHNX-4075).
 * Backs both `agents computer sessions` and the
 * `agents sessions --computer` alias.
 *
 * There is no separate capture directory the way browser tasks have
 * `.cache/browser/<profile>/sessions/<task>/` — a computer action drives a
 * live GUI in place and leaves no artifact of its own, so the event ledger
 * IS the canonical execution source for this history (RUSH-2432, the
 * computer counterpart of `../browser/sessions-list.ts`'s RUSH-2407
 * task-first grouping).
 *
 * Retention/privacy: `events.ts` bounds and prunes the LEDGER
 * (`DEFAULT_RETENTION_DAYS` / `DEFAULT_MAX_STORAGE_BYTES` — 7 days / 50 MiB
 * by default, gzip-rotated at 10 MiB) and nothing here changes that policy or
 * re-prunes that log. The durable `computer_sessions` table added in RUSH-2549
 * is a SECOND store with its OWN, much longer bound
 * (`TOOL_SESSION_MAX_AGE_DAYS`, swept by `pruneToolSessions` from the listing
 * path below) — that is deliberate, since the table exists precisely to outlive
 * the ledger's 7 days, and one row per CLI process would otherwise grow without
 * limit. It is metadata only. Nothing sensitive is persisted: `type` /
 * `type-text` events already carry only `textLength`, never the typed text
 * (see `computer/record.ts` `recordComputerAction`) — the
 * mission this module fulfils changes NONE of that. A `run --task`
 * description is the agent's OWN instruction, not typed-into-a-target-app
 * content (the same class of thing `agents sessions` already stores
 * unredacted as a session prompt) — it is kept, but bounded to
 * {@link TASK_PREVIEW_MAX_CHARS} via `events.ts`'s `truncate()` before it is
 * ever written (see `computer.ts` `registerRunCommand`), never the full
 * unbounded text, and it is not the wire-shape `prompt` field so it is a
 * deliberate exception to (not a bypass of) the automatic prompt-redaction
 * path in `events.ts` `sanitizePayload`.
 *
 * Grouping key: `recordComputerAction()` stamps one random `invocationId` for
 * the lifetime of the emitting CLI process. The event's own `pid` field is the emitting
 * CLI PROCESS's pid, never the target app's (that's `targetPid` — see
 * `computer/record.ts` `recordComputerAction`, and its `#11` test guarding
 * this). One `agents computer <verb>` invocation is one process, and
 * `computer run`'s whole embedded observe/act/verify loop is ALSO one
 * process. Grouping by `invocationId` gives exactly one row per CLI invocation without
 * conflating unrelated processes when the OS later reuses a pid: a
 * single explicit verb collapses to a one-action row, and a `run --task`
 * loop collapses to one row holding every verb the model drove. That row is
 * the "run" a task-first view groups by.
 *
 * Session identity: unlike a browser task (which only ever learns its
 * `launchId`, requiring the join `buildLaunchSessionIndex`/
 * `resolveLaunchSession` perform), a `computer.action` event is emitted
 * IN-PROCESS by the CLI invocation itself, so `stampProvenance()`
 * (`../event-provenance.ts`) already stamps its own `sessionId` directly
 * onto the record — no join needed for the common case. This module still
 * falls back to the shared launchId join — imported from
 * `../browser/sessions-list.ts`, never duplicated — for the case where
 * `sessionId` doesn't resolve (a rotated/unindexed session) but `launchId`
 * still does via the more authoritative pid registry.
 */
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

export const TASK_PREVIEW_MAX_CHARS = 200;

const DEFAULT_ACTION_LIMIT = 5000;

export interface ComputerAction {
  verb: string;
  ts: string;
  tsMs: number;
  pid: number;
  invocationId?: string;
  targetPid?: number;
  bundle?: string;
  host?: string;
  task?: string;
  sessionId?: string;
  launchId?: string;
  agent?: string;
  machineId?: string;
  hostname?: string;
  capture?: { path: string; kind: 'screenshot'; name: string; bytes?: number };
}

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

export function standaloneComputerActionsDir(): string {
  return path.join(getCacheDir(), 'computer', 'actions');
}

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
  return {
    verb, ts, tsMs,
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
    // Attribute to the observer only when the engine omitted its source machine.
    hostname: text('hostname') ?? observer,
    capture: parseActionCapture(record.capture),
  };
}

export function listStandaloneComputerActions(opts: { limit?: number; dir?: string; observer?: string } = {}): ComputerAction[] {
  const dir = opts.dir ?? standaloneComputerActionsDir();
  const limit = opts.limit ?? DEFAULT_ACTION_LIMIT;
  const observer = opts.observer ?? machineId();
  let days: string[];
  try {
    days = fs.readdirSync(dir).filter((name) => name.endsWith('.jsonl')).sort().reverse();
  } catch {
    return [];
  }
  const out: ComputerAction[] = [];
  for (const day of days) {
    if (out.length >= limit) break;
    let lines: string[];
    try { lines = fs.readFileSync(path.join(dir, day), 'utf8').split('\n'); }
    catch { continue;  }
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

export function listComputerActions(opts: { limit?: number } = {}): ComputerAction[] {
  const records = query({ eventTypes: ['computer.action'], limit: opts.limit ?? DEFAULT_ACTION_LIMIT });
  const out: ComputerAction[] = [];
  for (const r of records) {
    const a = recordToAction(r);
    if (a) out.push(a);
  }
  return out;
}

export type ComputerRunLinkStatus = 'linked' | 'unresolved' | 'unlinked';

export interface ComputerRunRow {
  pid?: number;
  invocationId?: string;
  recoveredActionCount?: number;
  task?: string;
  machine: string;
  machineId?: string;
  remoteHost?: string;
  bundle?: string;
  agent?: string;
  sessionId?: string;
  launchId?: string;
  linkStatus: ComputerRunLinkStatus;
  linkedSession?: SessionMeta;
  actions: ComputerAction[];
  counts: Record<string, number>;
  startMs: number;
  endMs: number;
}

export function groupIntoComputerRuns(
  actions: ComputerAction[],
  resolveSession?: (sessionId: string) => SessionMeta | null,
  resolveLaunch?: (launchId: string) => SessionMeta | null,
): ComputerRunRow[] {
  const byInvocation = new Map<string, ComputerAction[]>();
  for (const [index, a] of actions.entries()) {
    const key = a.invocationId ?? `legacy:${a.pid}:${a.tsMs}:${index}`;
    const list = byInvocation.get(key) ?? [];
    list.push(a);
    byInvocation.set(key, list);
  }

  const rows: ComputerRunRow[] = [];
  for (const group of byInvocation.values()) {
    const pid = group[0].pid;
    group.sort((a, b) => b.tsMs - a.tsMs);

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

function appendPrunedRunsFromDb(rows: ComputerRunRow[], limit?: number): void {
  const seen = new Set(rows.map((r) => r.invocationId));
  const startedBeforeMs = rows.length > 0
    ? Math.min(...rows.map((r) => r.startMs))
    : undefined;
  for (const record of listComputerSessionRecords({ limit, startedBeforeMs })) {
    if (seen.has(record.invocationId)) continue;
    const linked = record.sessionId ? getSessionById(record.sessionId) : null;
    rows.push({
      pid: undefined,
      invocationId: record.invocationId,
      task: record.taskPreview,
      machine: record.machine,
      machineId: record.machine,
      bundle: undefined,
      remoteHost: undefined,
      agent: undefined,
      sessionId: record.sessionId,
      launchId: record.launchId,
      linkStatus: linked ? 'linked' : (record.sessionId || record.launchId) ? 'unresolved' : 'unlinked',
      linkedSession: linked ?? undefined,
      actions: [],
      counts: {},
      recoveredActionCount: record.actionCount,
      startMs: record.startedAt,
      endMs: record.lastActivity ?? record.startedAt,
    });
  }
}

export function buildComputerSessionRows(opts: { limit?: number; machine?: string; observer?: string } = {}): ComputerRunRow[] {
  const actions = mergeComputerActionSources(
    listStandaloneComputerActions({ limit: opts.limit, ...(opts.observer ? { observer: opts.observer } : {}) }),
    listComputerActions({ limit: opts.limit }),
  );
  const index = buildLaunchSessionIndex();
  const rows = groupIntoComputerRuns(
    actions,
    (sessionId) => getSessionById(sessionId),
    (launchId) => resolveLaunchSession(index, launchId),
  );
  try { pruneToolSessions(); } catch {  }
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

export const DEFAULT_ROW_DISPLAY_LIMIT = 50;

export function applyRowDisplayLimit(
  rows: ComputerRunRow[],
  limit: number = DEFAULT_ROW_DISPLAY_LIMIT,
): { shown: ComputerRunRow[]; more: number } {
  const shown = rows.slice(0, limit);
  return { shown, more: rows.length - shown.length };
}

export function runComputerSessions(opts: { machine?: string; json?: boolean; limit?: number }): void {
  const rows = buildComputerSessionRows({ machine: opts.machine });
  printComputerSessionRows(rows, opts);
}

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
