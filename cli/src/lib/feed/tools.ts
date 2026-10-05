/** Canonical tool activity on the feed stream: a projection of the existing `agents
 * browser/computer sessions` rows, so consumers spawn zero commands. Computer runs are ledger
 * entries (`live: false`, no stop command). Paths only, never contents; task URLs are redacted. */
import { createHash } from 'node:crypto';
import { normalizeHost } from '../machine-id.js';
import { sessionHeadline } from '../session/title.js';
import type { SessionMeta } from '@phnx-labs/sessions-cli/reader';
import type { BrowserSessionRow, ArtifactKind } from '../browser/sessions-list.js';
import type { ComputerRunRow } from '../computer/sessions-list.js';

export const TOOL_CAPTURE_LIMIT = 20;
export const TOOL_ACTION_LIMIT = 50;

export type ToolKind = 'browser' | 'computer';

export type ToolLinkStatus = 'linked' | 'unresolved' | 'unlinked';

export interface ToolCapture {
  kind: ArtifactKind;
  name: string;
  /** Absolute path on `ToolCapture.host`. A capture lives on the machine whose browser produced
   * it, so a reader on another box must open it through that host. */
  path: string;
  host: string;
  bytes?: number;
  atMs: number;
}

/** One tab a task has open, by the task's short tab id (the key of `Task.tabs`), which `agents
 * browser tab focus` accepts and stays stable, unlike the engine-internal CDP target id that a
 * reconnect can change. */
export interface ToolTab {
  id: string;
  url?: string;
  title?: string;
  current?: boolean;
  /** The task drives this tab but did not open it, so no close path touches it; keeps a UI from
   * offering to close someone else's tab. */
  borrowed?: boolean;
}

/** An argv a consumer may run verbatim, plus the device to run it ON. `runOn` is not a `--device`
 * flag: a browser task is bound to its device at `start` and `--device` is rejected
 * (REJECT_DEVICE_MESSAGE), so run the plain argv on the host holding the binding. */
export interface ToolCommand {
  command: 'agents';
  args: string[];
  runOn: string;
}

export interface ToolOwner {
  sessionId: string;
  device: string;
  label?: string;
  agent?: string;
}

interface ToolRowBase {
  kind: ToolKind;
  rowKey: string;
  scope: string;
  device: string;
  live: boolean;
  task?: string;
  sessionId?: string;
  launchId?: string;
  agent?: string;
  owner?: ToolOwner;
  linkStatus: ToolLinkStatus;
  startedAtMs: number;
  updatedAtMs: number;
  captures: ToolCapture[];
  captureCounts: Record<string, number>;
}

export interface BrowserToolRow extends ToolRowBase {
  kind: 'browser';
  profile: string;
  url?: string;
  /** Tabs the task has open, newest-known first. Absent means unknown here (task bound to
   * another device, or ended leaving only captures); `[]` means genuinely none. */
  tabs?: ToolTab[];
  /** Focuses one of this task's tabs; present only while `live` and only for a tab the task
   * owns. */
  showCommand?: ToolCommand;
  /** The command that closes this task; present only while `live`, since a task the index no
   * longer binds has nothing left to close. */
  closeCommand?: ToolCommand;
}

export interface ComputerToolRow extends ToolRowBase {
  kind: 'computer';
  live: false;
  bundle?: string;
  actions: { verb: string; atMs: number; host?: string; bundle?: string }[];
  actionCounts: Record<string, number>;
  recoveredActionCount?: number;
}

export type ToolRow = BrowserToolRow | ComputerToolRow;

/** A task the local browser holds live state for, read from `tasks.json`: the only authority on
 * a task's tabs, rewritten from the live task map. An ended task is absent even though captures
 * remain, which is the distinction `live` reports. */
export interface LiveBrowserTask {
  task: string;
  profile?: string;
  label?: string;
  tabs?: ToolTab[];
  startedAtMs?: number;
  lastActionAtMs?: number;
  sessionId?: string;
  launchId?: string;
  actor?: string;
}

export function toolRowKey(scope: string, kind: ToolKind, identity: string): string {
  return createHash('sha256').update(`${scope}\0${kind}\0${identity}`).digest('base64url').slice(0, 22);
}

const CREDENTIAL_PARAM = /(token|secret|password|passwd|pwd|api[-_]?key|auth|session|signature|sig|code)/i;
const REDACTED = '<redacted>';

/** A task URL safe to publish: userinfo removed and credential-shaped query parameters replaced.
 * A string that does not parse is dropped, not published unexamined. */
export function redactToolUrl(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  let url: URL;
  try { url = new URL(raw); } catch { return undefined; }
  url.username = '';
  url.password = '';
  for (const key of [...url.searchParams.keys()]) {
    if (CREDENTIAL_PARAM.test(key)) url.searchParams.set(key, REDACTED);
  }
  if (url.hash) url.hash = '';
  return url.toString();
}

/** The owning agent session, or nothing. `sessionId` is the effective identity, not read off the
 * capture row, since a task's session is recorded in the live record, device binding and
 * capture history, and one source alone left some paths ownerless. */
function ownerOf(sessionId: string | undefined, linkedSession: SessionMeta | null | undefined, scope: string): ToolOwner | undefined {
  if (!sessionId) return undefined;
  const session = linkedSession ?? undefined;
  // One headline ladder for the CLI (SES-14c): the row's `label`, then the daemon-generated title,
  // then the first-prompt topic. Re-deriving it would drop the generated-title rung and name the
  // session differently from `agents sessions`.
  const label = session ? sessionHeadline(session) : undefined;
  return {
    sessionId,
    device: normalizeHost(session?.machine ?? scope),
    ...(label ? { label } : {}),
    ...(session?.agent ? { agent: session.agent } : {}),
  };
}

function knownMachine(machine: string | undefined): string | undefined {
  return machine && machine !== 'unknown' ? machine : undefined;
}

function countBy<T>(items: T[], key: (item: T) => string): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const item of items) counts[key(item)] = (counts[key(item)] ?? 0) + 1;
  return counts;
}

/** A browser task the index binds but that has no capture yet. `buildBrowserSessionRows` derives
 * rows from captures, so a just-opened task had no row until its first screenshot. This
 * synthesizes the zero-capture row through the same projection rather than a parallel one. */
export function boundBrowserRow(task: string, binding: { profile?: string }): BrowserSessionRow {
  return {
    kind: 'task', task, profile: binding.profile ?? '',
    linkStatus: 'unlinked', artifacts: [],
    counts: { screenshot: 0, pdf: 0, recording: 0, download: 0 },
    latestMtimeMs: 0,
  };
}

/** One browser task (or a profile's downloads bucket) as a tool row. Pure: liveness is passed
 * in, since only the machine running the browser daemon holds the task index. */
export function projectBrowserToolRow(
  scope: string,
  row: BrowserSessionRow,
  binding?: { device?: string; profile?: string; url?: string; createdAt?: number; sessionId?: string; launchId?: string },
  live?: LiveBrowserTask,
): BrowserToolRow {
  const host = normalizeHost(scope);
  const isLive = Boolean(row.task) && (live !== undefined || binding !== undefined);
  const captures = row.artifacts.slice(0, TOOL_CAPTURE_LIMIT).map((artifact) => ({
    kind: artifact.kind, name: artifact.name, path: artifact.path, host, bytes: artifact.bytes, atMs: artifact.mtimeMs,
  }));
  const oldest = row.artifacts.length > 0 ? row.artifacts[row.artifacts.length - 1]!.mtimeMs : row.latestMtimeMs;
  const url = redactToolUrl(binding?.url);
  const sessionId = row.sessionId ?? live?.sessionId ?? binding?.sessionId;
  const launchId = row.launchId ?? live?.launchId ?? binding?.launchId;
  const owner = ownerOf(sessionId, row.linkedSession, host);
  const tabs = live?.tabs;
  const showTab = tabs?.find((tab) => tab.current && !tab.borrowed)?.id
    ?? tabs?.find((tab) => !tab.borrowed)?.id;
  const startedAtMs = live?.startedAtMs ?? binding?.createdAt ?? oldest;
  // A task with no captures has no capture mtime. `lastActionAt` is refreshed by every task action,
  // so it is the freshness key, with its own start as fallback; reporting 0 would sort a new live
  // task to the bottom.
  const updatedAtMs = Math.max(row.latestMtimeMs, live?.lastActionAtMs ?? 0) || startedAtMs;
  return {
    kind: 'browser',
    // Keyed on the task, never the profile: a capture-less task is discovered from the index where
    // the profile may not be recorded, so folding the profile in would give one task two keys and
    // render it twice after its first capture.
    rowKey: toolRowKey(host, 'browser', row.task ? `task\0${row.task}` : `downloads\0${row.profile}`),
    scope: host,
    device: normalizeHost(binding?.device ?? host),
    live: isLive,
    ...(row.task ? { task: row.task } : {}),
    ...(sessionId ? { sessionId } : {}),
    ...(launchId ? { launchId } : {}),
    ...(row.linkedSession?.agent ? { agent: row.linkedSession.agent } : {}),
    ...(owner ? { owner } : {}),
    linkStatus: row.linkedSession ? 'linked' : sessionId ? 'unresolved' : 'unlinked',
    startedAtMs,
    updatedAtMs,
    captures,
    captureCounts: countBy(row.artifacts, (artifact) => artifact.kind),
    profile: row.profile || live?.profile || '',
    ...(url ? { url } : {}),
    ...(tabs ? { tabs } : {}),
    ...(isLive && showTab ? { showCommand: { command: 'agents' as const, args: ['browser', 'tab', 'focus', showTab, '--task', row.task!], runOn: host } } : {}),
    ...(isLive ? { closeCommand: { command: 'agents' as const, args: ['browser', 'done', '--task', row.task!], runOn: host } } : {}),
  };
}

/** One computer run as a tool row. `live` is pinned false and no close/stop command is produced:
 * the emitting CLI process is gone. */
export function projectComputerToolRow(scope: string, row: ComputerRunRow): ComputerToolRow {
  const host = normalizeHost(scope);
  const owner = ownerOf(row.sessionId, row.linkedSession, host);
  const agent = row.agent ?? row.linkedSession?.agent;
  // Captures come only from a `capture` the producer recorded after writing the file; older
  // screenshot actions report none rather than a guessed path. `host` is the invoking machine,
  // never `remoteHost`: the file is written where the command ran.
  const captures: ToolCapture[] = [];
  const captureCounts: Record<string, number> = {};
  for (const action of row.actions) {
    if (!action.capture) continue;
    captureCounts[action.capture.kind] = (captureCounts[action.capture.kind] ?? 0) + 1;
    if (captures.length >= TOOL_CAPTURE_LIMIT) continue;
    captures.push({
      kind: action.capture.kind, name: action.capture.name, path: action.capture.path,
      host,
      ...(action.capture.bytes !== undefined ? { bytes: action.capture.bytes } : {}),
      atMs: action.tsMs,
    });
  }
  const actions = row.actions.slice(0, TOOL_ACTION_LIMIT).map((action) => ({
    verb: action.verb, atMs: action.tsMs,
    ...(action.host ? { host: action.host } : {}),
    ...(action.bundle ? { bundle: action.bundle } : {}),
  }));
  return {
    kind: 'computer',
    rowKey: toolRowKey(host, 'computer', row.invocationId ?? `${row.machine}\0${row.pid ?? ''}\0${row.startMs}`),
    scope: host,
    // `groupIntoComputerRuns` writes the literal 'unknown' when no record identified a machine, a
    // sentinel and not a device name. Publishing it made local actions unaddressable and hid them
    // under a device filter, so it resolves to the observing host.
    device: normalizeHost(row.remoteHost ?? knownMachine(row.machine) ?? host),
    live: false,
    ...(row.task ? { task: row.task } : {}),
    ...(row.sessionId ? { sessionId: row.sessionId } : {}),
    ...(row.launchId ? { launchId: row.launchId } : {}),
    ...(agent ? { agent } : {}),
    ...(owner ? { owner } : {}),
    linkStatus: row.linkStatus,
    startedAtMs: row.startMs,
    updatedAtMs: row.endMs,
    captures,
    captureCounts,
    ...(row.bundle ? { bundle: row.bundle } : {}),
    actions,
    actionCounts: { ...row.counts },
    ...(row.recoveredActionCount !== undefined ? { recoveredActionCount: row.recoveredActionCount } : {}),
  };
}

export function sortToolRows(rows: ToolRow[]): ToolRow[] {
  return [...rows].sort((a, b) => b.updatedAtMs - a.updatedAtMs);
}
