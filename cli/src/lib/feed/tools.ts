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
  path: string;
  bytes?: number;
  atMs: number;
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
   * The command that closes this task. Present ONLY while `live` — a task the
   * index no longer binds has nothing left to close, and offering the command
   * anyway would fail loud at the operator instead of at this boundary.
   */
  closeCommand?: { command: 'agents'; args: string[] };
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
 * One browser task (or a profile's downloads bucket) as a tool row. Pure: the
 * liveness verdict is passed in, because only the machine running the browser
 * daemon holds the task index that answers it.
 */
export function projectBrowserToolRow(
  scope: string,
  row: BrowserSessionRow,
  binding?: { device?: string; url?: string; createdAt?: number },
): BrowserToolRow {
  const host = normalizeHost(scope);
  const live = Boolean(row.task) && binding !== undefined;
  const captures = row.artifacts.slice(0, TOOL_CAPTURE_LIMIT).map((artifact) => ({
    kind: artifact.kind, name: artifact.name, path: artifact.path, bytes: artifact.bytes, atMs: artifact.mtimeMs,
  }));
  const oldest = row.artifacts.length > 0 ? row.artifacts[row.artifacts.length - 1]!.mtimeMs : row.latestMtimeMs;
  const url = redactToolUrl(binding?.url);
  const owner = ownerOf(row, host);
  return {
    kind: 'browser',
    rowKey: toolRowKey(host, 'browser', `${row.profile}\0${row.kind}\0${row.task ?? ''}`),
    scope: host,
    device: normalizeHost(binding?.device ?? host),
    live,
    ...(row.task ? { task: row.task } : {}),
    ...(row.sessionId ? { sessionId: row.sessionId } : {}),
    ...(row.launchId ? { launchId: row.launchId } : {}),
    ...(row.linkedSession?.agent ? { agent: row.linkedSession.agent } : {}),
    ...(owner ? { owner } : {}),
    linkStatus: row.linkStatus,
    startedAtMs: binding?.createdAt ?? oldest,
    updatedAtMs: row.latestMtimeMs,
    captures,
    captureCounts: countBy(row.artifacts, (artifact) => artifact.kind),
    profile: row.profile,
    ...(url ? { url } : {}),
    ...(live ? { closeCommand: { command: 'agents' as const, args: ['browser', 'done', '--task', row.task!] } } : {}),
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
    // A computer run's artifacts live in the engine's own output paths, which
    // the ledger does not record; screenshots taken through `agents computer`
    // land under the browser capture tree only when a task requested a file.
    // Left empty rather than guessed — a wrong path is worse than none.
    captures: [],
    captureCounts: {},
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
