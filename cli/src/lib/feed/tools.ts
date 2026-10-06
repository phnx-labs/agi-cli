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
 * driven, and it can be closed (`browser done --task <name>`). A
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
  path: string;
  host: string;
  bytes?: number;
  atMs: number;
}

export interface ToolTab {
  id: string;
  url?: string;
  title?: string;
  current?: boolean;
  borrowed?: boolean;
}

export interface ToolCommand {
  command: 'browser';
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
  machine?: string;
  captureDir?: string;
  capturesRemote?: string;
  url?: string;
  tabs?: ToolTab[];
  showCommand?: ToolCommand;
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

function ownerOf(sessionId: string | undefined, linkedSession: SessionMeta | null | undefined, scope: string): ToolOwner | undefined {
  if (!sessionId) return undefined;
  const session = linkedSession ?? undefined;
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

export function boundBrowserRow(task: string, binding: { profile?: string }): BrowserSessionRow {
  return {
    kind: 'task', task, profile: binding.profile ?? '',
    linkStatus: 'unlinked', artifacts: [],
    counts: { screenshot: 0, pdf: 0, recording: 0, download: 0 },
    latestMtimeMs: 0,
  };
}

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
  const startedAtMs = live?.startedAtMs ?? binding?.createdAt ?? row.startedAt ?? oldest;
  const updatedAtMs = Math.max(row.latestMtimeMs, live?.lastActionAtMs ?? 0) || startedAtMs;
  return {
    kind: 'browser',
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
    captureCounts: Object.fromEntries(Object.entries(row.counts).filter(([, n]) => n > 0)),
    profile: row.profile || live?.profile || '',
    ...(row.machine ? { machine: row.machine } : {}),
    ...(row.captureDir ? { captureDir: row.captureDir } : {}),
    ...(row.capturesRemote ? { capturesRemote: row.capturesRemote } : {}),
    ...(url ? { url } : {}),
    ...(tabs ? { tabs } : {}),
    ...(isLive && showTab ? { showCommand: { command: 'browser' as const, args: ['tab', 'focus', showTab, '--task', row.task!], runOn: host } } : {}),
    ...(isLive ? { closeCommand: { command: 'browser' as const, args: ['done', '--task', row.task!], runOn: host } } : {}),
  };
}

export function projectComputerToolRow(scope: string, row: ComputerRunRow): ComputerToolRow {
  const host = normalizeHost(scope);
  const owner = ownerOf(row.sessionId, row.linkedSession, host);
  const agent = row.agent ?? row.linkedSession?.agent;
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
