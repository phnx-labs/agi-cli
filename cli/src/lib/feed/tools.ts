/**
 * Canonical tool activity on the feed stream — browser tasks and computer runs
 * projected into one row contract, alongside the agent and attention rows.
 *
 * WHY A PROJECTION AND NOT A NEW STORE. Both sources already exist and already
 * have an owner: `agents browser sessions` groups a profile's captures into
 * task-first rows (`browser/sessions-list.ts`), and `agents computer sessions`
 * groups `computer.action` ledger entries into run rows
 * (`computer/sessions-list.ts`). A menu-bar or Fleet view that wanted the same
 * information had only one way to get it: shell out to those two commands, per
 * tool, per device, on a timer. That is the per-tool polling this module
 * removes — the rows ride the ONE stream `agents feed watch --json` already
 * holds open, so a consumer switching its All/Agents/Browser/Computer filter
 * spawns zero commands.
 *
 * WHAT IS DELIBERATELY DIFFERENT BETWEEN THE TWO KINDS. A browser task is a
 * LIVE resource: it is bound in the task index while it exists, it can be
 * driven, and it can be closed (`agents browser done --task <name>`). A
 * computer run is a LEDGER ENTRY: the actions already happened, the CLI process
 * that performed them has exited, and there is nothing to stop. So
 * {@link ComputerToolRow} pins `live: false` and carries no close/stop command
 * at all — inventing one would offer an operator a control that cannot work.
 *
 * PRIVACY. Rows carry capture PATHS and names, never contents, and a task URL
 * is redacted ({@link redactToolUrl}) before it leaves this process: userinfo
 * is stripped and credential-shaped query parameters are replaced. The feed is
 * read by the menu bar, the extension, and any `--json` consumer; a bearer
 * token in a `?access_token=` is exactly the value that must not ride it.
 */
import { createHash } from 'node:crypto';
import { normalizeHost } from '../machine-id.js';
import { sessionHeadline } from '../session/title.js';
import type { SessionMeta } from '../session/types.js';
import type { BrowserSessionRow, ArtifactKind } from '../browser/sessions-list.js';
import type { ComputerRunRow } from '../computer/sessions-list.js';

/** Newest captures retained per row. A task with hundreds of screenshots must
 *  not turn one stream envelope into a megabyte. */
export const TOOL_CAPTURE_LIMIT = 20;
/** Newest actions retained per computer row, for the same reason. */
export const TOOL_ACTION_LIMIT = 50;

export type ToolKind = 'browser' | 'computer';

/** Why a row carries no owning session: `linked` resolved one, `unresolved` has
 *  an id that no indexed session matches, `unlinked` never had one. Mirrors the
 *  status both source modules already publish. */
export type ToolLinkStatus = 'linked' | 'unresolved' | 'unlinked';

/** One artifact a tool produced. Path only — never contents. */
export interface ToolCapture {
  kind: ArtifactKind;
  name: string;
  /**
   * Absolute path ON {@link ToolCapture.host}. A capture lives on the machine
   * whose browser produced it, so a fleet reader on another box must not treat
   * this as a local path — it has to open it through that host. Carrying the host
   * per capture is what makes the path meaningful off-box at all.
   */
  path: string;
  /** The device that holds this file. */
  host: string;
  bytes?: number;
  atMs: number;
}

/**
 * One tab a browser task has open, with the id the task itself addresses it by.
 *
 * `id` is the task's SHORT tab id (the key of `Task.tabs`), not the underlying
 * CDP target id: the short id is what `agents browser show --tab <id>` accepts
 * and what stays stable for the life of the tab, while the target id is an
 * engine-internal handle that a reconnect can change.
 */
export interface ToolTab {
  id: string;
  url?: string;
  title?: string;
  /** The tab URL-less verbs act on. */
  current?: boolean;
  /**
   * The task drives this tab but did not open it, so no close path touches it.
   * Surfaced so a UI does not offer to close someone else's tab.
   */
  borrowed?: boolean;
}

/**
 * An argv a consumer may run verbatim, plus the device it must run ON.
 *
 * `runOn` is load-bearing and is NOT a `--device` flag. A browser task is bound
 * to its device at `start`, and every later verb resolves that binding from the
 * local task index — `agents browser done --task x --device y` is explicitly
 * REJECTED (`browser/task-index.ts` `REJECT_DEVICE_MESSAGE`). So the way to act
 * on a task observed from another box is to run the plain argv on the host that
 * holds the binding, which is what this names.
 */
export interface ToolCommand {
  command: 'agents';
  args: string[];
  runOn: string;
}

/** The agent session that drove the tool, as a click-through target. */
export interface ToolOwner {
  sessionId: string;
  device: string;
  label?: string;
  agent?: string;
}

interface ToolRowBase {
  kind: ToolKind;
  /** Opaque, stable identity for this row within one device scope. */
  rowKey: string;
  /** The observing device that reported the row. */
  scope: string;
  /** The DRIVEN machine — for `--device` runs this differs from `scope`. */
  device: string;
  /** Is this a resource that still exists and can be acted on? */
  live: boolean;
  task?: string;
  sessionId?: string;
  launchId?: string;
  agent?: string;
  owner?: ToolOwner;
  linkStatus: ToolLinkStatus;
  startedAtMs: number;
  updatedAtMs: number;
  /** Newest first, bounded by {@link TOOL_CAPTURE_LIMIT}. */
  captures: ToolCapture[];
  captureCounts: Record<string, number>;
}

export interface BrowserToolRow extends ToolRowBase {
  kind: 'browser';
  profile: string;
  /** Redacted by {@link redactToolUrl}; absent when the binding recorded none. */
  url?: string;
  /**
   * Tabs the task has open, newest-known first. Absent — not empty — when this
   * host holds no live task record to read them from (a task bound to another
   * device, or one whose run already ended leaving only captures). Absent means
   * "unknown here", `[]` means "genuinely none".
   */
  tabs?: ToolTab[];
  /**
   * Focus one of this task's tabs. Present only while `live` and only for a tab
   * the task actually owns.
   */
  showCommand?: ToolCommand;
  /**
   * The command that closes this task. Present ONLY while `live` — a task the
   * index no longer binds has nothing left to close, and offering the command
   * anyway would fail loud at the operator instead of at this boundary.
   */
  closeCommand?: ToolCommand;
}

export interface ComputerToolRow extends ToolRowBase {
  kind: 'computer';
  /** Always false: see the module docblock. A run is history, not a session. */
  live: false;
  bundle?: string;
  /** Newest first, bounded by {@link TOOL_ACTION_LIMIT}. */
  actions: { verb: string; atMs: number; host?: string; bundle?: string }[];
  actionCounts: Record<string, number>;
  /** Total actions for a row whose per-verb detail the ledger already pruned. */
  recoveredActionCount?: number;
}

export type ToolRow = BrowserToolRow | ComputerToolRow;

/**
 * A task the local browser holds LIVE state for, read from its `tasks.json`.
 *
 * This is the only authority on a task's tabs: `tasks.json` is rewritten from
 * the live task map, so an entry here means the task exists right now, and its
 * `tabs` map is what `agents browser show --tab` addresses. A task whose run has
 * ended is absent even though its captures remain, which is exactly the
 * distinction `live` on a row reports.
 */
export interface LiveBrowserTask {
  task: string;
  profile?: string;
  label?: string;
  tabs?: ToolTab[];
  startedAtMs?: number;
  sessionId?: string;
  launchId?: string;
}

/** Stable identity for one tool row within one device scope. */
export function toolRowKey(scope: string, kind: ToolKind, identity: string): string {
  return createHash('sha256').update(`${scope}\0${kind}\0${identity}`).digest('base64url').slice(0, 22);
}

/** Query parameters whose value is a credential, not a locator. */
const CREDENTIAL_PARAM = /(token|secret|password|passwd|pwd|api[-_]?key|auth|session|signature|sig|code)/i;
const REDACTED = '<redacted>';

/**
 * A task URL safe to publish: userinfo removed and credential-shaped query
 * parameters replaced. A string that does not parse as a URL is dropped
 * entirely rather than published unexamined — it cannot be redacted safely.
 */
export function redactToolUrl(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  let url: URL;
  try { url = new URL(raw); } catch { return undefined; }
  url.username = '';
  url.password = '';
  for (const key of [...url.searchParams.keys()]) {
    if (CREDENTIAL_PARAM.test(key)) url.searchParams.set(key, REDACTED);
  }
  // A fragment is where OAuth implicit flows put the token, and nothing on a
  // status row needs it.
  if (url.hash) url.hash = '';
  return url.toString();
}

function ownerOf(row: { sessionId?: string; linkedSession?: SessionMeta | null }, scope: string): ToolOwner | undefined {
  if (!row.sessionId) return undefined;
  const session = row.linkedSession ?? undefined;
  // One headline ladder for the whole CLI (SES-14c): a row's own `label`, then the
  // daemon-generated title, then the first-prompt topic. Re-deriving it here would
  // silently drop the generated-title rung and show a different name for the same
  // session than `agents sessions` does.
  const label = session ? sessionHeadline(session) : undefined;
  return {
    sessionId: row.sessionId,
    device: normalizeHost(session?.machine ?? scope),
    ...(label ? { label } : {}),
    ...(session?.agent ? { agent: session.agent } : {}),
  };
}

function countBy<T>(items: T[], key: (item: T) => string): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const item of items) counts[key(item)] = (counts[key(item)] ?? 0) + 1;
  return counts;
}

/**
 * A browser task the task index binds but that has produced no capture yet.
 *
 * `buildBrowserSessionRows` derives its rows from captures on disk, so a task
 * that was just opened — bound, live, drivable, closable — had no row at all
 * until its first screenshot landed. That is the window an operator most wants
 * to see, and it is exactly when a Sessions pane showed nothing. This
 * synthesizes the zero-capture row so it goes through the SAME projection rather
 * than a second parallel one.
 */
export function boundBrowserRow(task: string, binding: { profile?: string }): BrowserSessionRow {
  return {
    kind: 'task', task, profile: binding.profile ?? '',
    linkStatus: 'unlinked', artifacts: [],
    counts: { screenshot: 0, pdf: 0, recording: 0, download: 0 },
    latestMtimeMs: 0,
  };
}

/**
 * One browser task (or a profile's downloads bucket) as a tool row. Pure: the
 * liveness verdict is passed in, because only the machine running the browser
 * daemon holds the task index that answers it.
 */
export function projectBrowserToolRow(
  scope: string,
  row: BrowserSessionRow,
  binding?: { device?: string; profile?: string; url?: string; createdAt?: number; sessionId?: string; launchId?: string },
  live?: LiveBrowserTask,
): BrowserToolRow {
  const host = normalizeHost(scope);
  // Live means the task still EXISTS: either this host's browser holds a live
  // record for it, or the task index still routes it (which is the case for a
  // task whose browser runs on another device).
  const isLive = Boolean(row.task) && (live !== undefined || binding !== undefined);
  const captures = row.artifacts.slice(0, TOOL_CAPTURE_LIMIT).map((artifact) => ({
    kind: artifact.kind, name: artifact.name, path: artifact.path, host, bytes: artifact.bytes, atMs: artifact.mtimeMs,
  }));
  const oldest = row.artifacts.length > 0 ? row.artifacts[row.artifacts.length - 1]!.mtimeMs : row.latestMtimeMs;
  const url = redactToolUrl(binding?.url);
  const owner = ownerOf(row, host);
  // Tabs are only knowable from a LIVE task record on THIS host; a row projected
  // from captures alone, or from a binding pointing at another device, genuinely
  // does not know them and says so by omitting the field.
  const tabs = live?.tabs;
  const showTab = tabs?.find((tab) => tab.current && !tab.borrowed)?.id
    ?? tabs?.find((tab) => !tab.borrowed)?.id;
  const startedAtMs = live?.startedAtMs ?? binding?.createdAt ?? oldest;
  // A task with no captures has no capture mtime to sort by; its own start is
  // the only honest age it has. Reporting 0 would sort a brand-new live task to
  // the very bottom of a newest-first list.
  const updatedAtMs = row.latestMtimeMs || startedAtMs;
  return {
    kind: 'browser',
    // Keyed on the TASK, never on the profile. A task with no captures yet is
    // discovered from the task index, where the profile may not be recorded, so
    // folding the profile into the identity would give the same task two
    // different keys and render it twice the moment its first capture landed.
    // Task names are unique within a machine's task index, which is the scope
    // this key is already qualified by. The downloads bucket has no task, so it
    // keys on its profile — one such row per profile, which is what it is.
    rowKey: toolRowKey(host, 'browser', row.task ? `task\0${row.task}` : `downloads\0${row.profile}`),
    scope: host,
    device: normalizeHost(binding?.device ?? host),
    live: isLive,
    ...(row.task ? { task: row.task } : {}),
    ...(row.sessionId ?? live?.sessionId ?? binding?.sessionId ? { sessionId: row.sessionId ?? live?.sessionId ?? binding?.sessionId } : {}),
    ...(row.launchId ?? live?.launchId ?? binding?.launchId ? { launchId: row.launchId ?? live?.launchId ?? binding?.launchId } : {}),
    ...(row.linkedSession?.agent ? { agent: row.linkedSession.agent } : {}),
    ...(owner ? { owner } : {}),
    linkStatus: row.linkStatus,
    startedAtMs,
    updatedAtMs,
    captures,
    captureCounts: countBy(row.artifacts, (artifact) => artifact.kind),
    profile: row.profile || live?.profile || '',
    ...(url ? { url } : {}),
    ...(tabs ? { tabs } : {}),
    // `runOn` is the OBSERVING host, not `device`: the binding that resolves the
    // task's device lives here, and passing `--device` to a later verb is
    // refused outright. See {@link ToolCommand}.
    ...(isLive && showTab ? { showCommand: { command: 'agents' as const, args: ['browser', 'show', '--task', row.task!, '--tab', showTab], runOn: host } } : {}),
    ...(isLive ? { closeCommand: { command: 'agents' as const, args: ['browser', 'done', '--task', row.task!], runOn: host } } : {}),
  };
}

/**
 * One computer run as a tool row. `live` is pinned false and no close/stop
 * command is produced: the emitting CLI process is already gone.
 */
export function projectComputerToolRow(scope: string, row: ComputerRunRow): ComputerToolRow {
  const host = normalizeHost(scope);
  const owner = ownerOf(row, host);
  const agent = row.agent ?? row.linkedSession?.agent;
  // Captures come ONLY from a `capture` the producer recorded after the file was
  // written. A screenshot action from before the producer carried that field has
  // no path to report, and this deliberately reports none rather than guessing one
  // from an output flag — a fabricated path is worse than an honest absence.
  const captures: ToolCapture[] = [];
  const captureCounts: Record<string, number> = {};
  for (const action of row.actions) {
    if (!action.capture) continue;
    captureCounts[action.capture.kind] = (captureCounts[action.capture.kind] ?? 0) + 1;
    if (captures.length >= TOOL_CAPTURE_LIMIT) continue;
    captures.push({
      kind: action.capture.kind, name: action.capture.name, path: action.capture.path,
      host: normalizeHost(row.remoteHost ?? row.machine ?? scope),
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
    device: normalizeHost(row.remoteHost ?? row.machine ?? host),
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

/** Newest first across both kinds — the order a consumer renders. */
export function sortToolRows(rows: ToolRow[]): ToolRow[] {
  return [...rows].sort((a, b) => b.updatedAtMs - a.updatedAtMs);
}
