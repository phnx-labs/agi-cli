import { writerProcessView } from './process-view.js';
/** Active-session detection across contexts: `terminal` (IDE extension), `teams` (meta.json, polled
 * PID), `cloud` (tasks.db), `headless` (bare agent processes from `ps` minus attributed PIDs).
 * `idle`: the process holds its file but the mtime is past ACTIVE_MTIME_WINDOW_MS. */
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execFile, execFileSync } from 'child_process';
import { promisify } from 'util';
import { listActiveTasks } from '../cloud/store.js';
import type { CloudTaskStatus } from '../cloud/types.js';
import { AgentManager } from '../teams/agents.js';
import { getTerminalsDir, readMeta } from '../state.js';
import { listNativeAccounts } from '../account-registry.js';
import { parseNativeIdentityKey } from '../native-accounts.js';
import {
  readLivePidSessionEntry as readPidSessionEntry,
  listPidSessionEntries,
  prunePidSessionRegistry,
  sessionIdFromLivePid,
  isSessionIdShape,
  type PidSessionEntry,
} from './pid-registry.js';
import { readSessionActorRecord, writeSessionAliasRecord } from './actor-sidecar.js';
import { loadHookSessionIndex, resolveHookSessionRecord, readStateSessionRecord, type HookSessionIndex, type HookSessionRecord } from './hook-sessions.js';
import { buildClaudeLabelMap, getAgentSessionDirs } from './discover.js';
import { buildRunNameMap } from './run-names.js';
import { latestSessionFileForCwd, findSessionsByShortIds, findSessionMachinesByIds, getSessionById } from './db.js';
import { extractSessionTopic, classifyUserPrompt, tidyRequest, type UserPromptKind } from '@phnx-labs/sessions-cli/reader';
import { readSessionTailWithRaw } from '@phnx-labs/sessions-cli/reader';
import { parseSession } from '@phnx-labs/sessions-cli/reader';
import { computeTokPerSec } from './throughput.js';
import { inferSessionState, type SessionState, type SessionActivity, type AwaitingReason, type StructuredQuestion, type TodoProgress, type DetectedPr, type DetectedWorktree, type DetectedTicket } from '@phnx-labs/sessions-cli/reader';
import { isSessionTrackedAgent, SESSION_AGENTS, AG_TMUX_NAME_RE, type SessionAgentId, type SessionAttachment, type SessionEvent, type SessionFiles, type SessionMeta, type SessionRequest, type SessionTimeline } from '@phnx-labs/sessions-cli/reader';
import { AGENTS } from '../agents.js';
import { confirmedProjectForCwd, listProjectDefsCached } from '../projects.js';
import { detectProvenance, type SessionProvenance } from './provenance.js';
import { loadDevices, type DeviceRegistry } from '../devices/registry.js';
import { machineId, normalizeHost } from '../machine-id.js';
import { presenceFromStore, type Presence } from './detached.js';
import { classifyHostLink, hostWindowLost, HOST_HEARTBEAT_STALE_MS, type HostLink } from './host-link.js';
import { mapBounded } from '../concurrency.js';
import { linearIssueUrl } from '@phnx-labs/sessions-cli/reader';
import { viewingInLabel } from './viewing-in.js';
import { claudeProjectDirName } from '../project-key.js';

const execFileAsync = promisify(execFile);

export function resolveOwner(pidActor: string | null | undefined, sessionId: string | undefined): string | undefined {
  return pidActor ?? (sessionId ? readSessionActorRecord(sessionId)?.actor : undefined) ?? undefined;
}

/** Per-PID `lsof` probes run bounded and staggered, not as one fan-out: a simultaneous system-wide
 * `lsof` burst looks like lateral-movement recon to behavioral EDR (CrowdStrike Falcon). Results
 * are identical. */
export const LSOF_CONCURRENCY = 4;
const LSOF_STAGGER_MS = 10;

/** Hard ceilings on the two syscalls the status path shells out to. A hung probe (wedged NFS
 * `lsof`, EDR-stalled `ps`) would pin a worker slot and silently drop sessions; on timeout the row
 * degrades to unknown/empty instead of hanging. */
const LSOF_TIMEOUT_MS = 5_000;
const PS_SNAPSHOT_TIMEOUT_MS = 10_000;

/** Process-local process-table memo (#2047): one `getActiveSessions` scan calls `ps -A` from
 * several paths, each a full snapshot. 5s is under the ~10-30s poll, so a quiet re-poll reuses it;
 * a new agent pid appears on the next refresh. */
export const PROCESS_TABLE_FRESH_MS = 5_000;

/** How long {@link listUnattributedActive} may reuse its last full `ps`+`lsof` result (#2047),
 * dropping dead and newly attributed PIDs. A shrinking attributed set forces a rescan so a process
 * that left teams/terminals can reappear as headless. */
export const UNATTRIBUTED_RESCAN_MS = 15_000;

let activeScanNow: () => number = () => Date.now();

export function setActiveScanClockForTest(fn?: () => number): void {
  activeScanNow = fn ?? (() => Date.now());
}

let processTableCache: { at: number; rows: ProcRow[] } | undefined;
let processTableLiveReads = 0;
let unattributedCache: {
  at: number;
  attributed: Set<number>;
  sessions: ActiveSession[];
  ppidMap: Map<number, number>;
} | undefined;
let unattributedFullRescans = 0;

export function clearActiveScanCachesForTest(): void {
  processTableCache = undefined;
  processTableLiveReads = 0;
  unattributedCache = undefined;
  unattributedFullRescans = 0;
  activeScanNow = () => Date.now();
}

export function processTableLiveReadCountForTest(): number {
  return processTableLiveReads;
}

export function unattributedFullRescanCountForTest(): number {
  return unattributedFullRescans;
}

/** True when any pid in `prev` is absent from `next`: the attributed set shrank, so a process may
 * need to reappear as unattributed. Pure. */
export function attributedSetLostPids(prev: Set<number>, next: Set<number>): boolean {
  for (const p of prev) {
    if (!next.has(p)) return true;
  }
  return false;
}

/** Drop rows whose pid is now attributed or no longer alive. Pure, so the TTL reuse path is
 * testable without a process table; `alive` gets `startedAtMs` for the pid-reuse guard of {@link
 * isPidAlive}. */
export function filterCachedUnattributed(
  sessions: ActiveSession[],
  attributed: Set<number>,
  alive: (pid: number, startedAtMs?: number) => boolean,
  ppidMap?: Map<number, number>,
): ActiveSession[] {
  return sessions.filter((s) => {
    if (s.pid == null) return false;
    if (attributed.has(s.pid) || (ppidMap && hasAttributedAncestor(s.pid, ppidMap, attributed))) return false;
    return alive(s.pid, s.startedAtMs);
  });
}

type ActiveContext = 'terminal' | 'teams' | 'cloud' | 'headless';

export type BackfillMeta = Pick<SessionMeta,
  'version' | 'account' | 'accountId' | 'accountKey' | 'timestamp' | 'label' | 'firstUserMessage' | 'lastUserMessage' | 'generatedTitle' | 'ticketId' | 'prUrl' | 'prNumber' | 'origin' | 'routineName' | 'harness' |
  'tokenCount' | 'durationMs' | 'subAgentCount' | 'lastActivity'
>;

/** Fold index-only enrichment onto live rows, then re-derive the recap for every touched row.
 * Load-bearing: `foldRecap` runs before the index is reached, so an index-only
 * `label`/`generatedTitle` would never reach `title` (PHNX-3797). */
export function backfillActiveRowsFromMeta(
  sessions: ActiveSession[],
  metaById: Map<string, BackfillMeta>,
): void {
  const accounts = listNativeAccounts(readMeta());
  for (const s of sessions) {
    if (!s.sessionId) continue;
    const m = metaById.get(s.sessionId);
    if (!m) continue;
    if (!s.version && m.version) s.version = m.version;
    if (!s.account && m.account) s.account = m.account;
    s.accountLabel ??= sessionAccountLabel(s.kind, m, accounts);
    if (!s.label && m.label) s.label = m.label;
    if (!s.firstUserMessage && m.firstUserMessage) s.firstUserMessage = m.firstUserMessage;
    if (!s.lastUserMessage && m.lastUserMessage) s.lastUserMessage = m.lastUserMessage;
    if (!s.generatedTitle && m.generatedTitle) s.generatedTitle = m.generatedTitle;
    if (!s.ticket && m.ticketId) s.ticket = { id: m.ticketId, url: linearIssueUrl(m.ticketId) };
    if (!s.pr && m.prUrl) s.pr = { url: m.prUrl, number: m.prNumber };
    if (!s.startedAtMs && m.timestamp) {
      const ts = new Date(m.timestamp).getTime();
      if (!Number.isNaN(ts)) s.startedAtMs = ts;
    }
    if (!s.origin && m.origin) s.origin = m.origin;
    if (!s.routineName && m.routineName) s.routineName = m.routineName;
    if (!s.harness && m.harness) s.harness = m.harness;
    if (s.tokenCount == null && m.tokenCount != null) s.tokenCount = m.tokenCount;
    if (s.durationMs == null && m.durationMs != null) s.durationMs = m.durationMs;
    if (s.subAgentCount == null && m.subAgentCount != null) s.subAgentCount = m.subAgentCount;
    if (s.lastActivityMs == null && m.lastActivity) {
      const ts = Date.parse(m.lastActivity);
      if (!Number.isNaN(ts)) s.lastActivityMs = ts;
    }
    applyRecap(s);
  }
}

export function sessionAccountLabel(
  kind: string,
  session: Pick<SessionMeta, 'accountId' | 'accountKey' | 'account'>,
  accounts = listNativeAccounts(readMeta()),
): string | undefined {
  const matches = accounts.filter(account => {
    if (account.agent !== kind) return false;
    if (session.accountId) return account.id === session.accountId;
    if (session.accountKey && !session.accountKey.startsWith('unattributed:')) {
      const indexed = parseNativeIdentityKey(account.agent, session.accountKey);
      const emailMatches = !!session.account && account.identityLabel?.toLowerCase() === session.account.toLowerCase();
      if (!indexed || (!indexed.account && !emailMatches)) return false;
      if (account.identityKey === session.accountKey) return true;
      const registered = parseNativeIdentityKey(account.agent, account.identityKey);
      return !!registered
        && Object.entries(indexed).every(([key, value]) => registered[key] === value)
        && (!session.account || emailMatches);
    }
    return !!session.account && account.identityLabel?.toLowerCase() === session.account.toLowerCase();
  });
  return matches.length === 1 ? matches[0].name : undefined;
}

function loadBackfillMetaFor(sessions: ActiveSession[]): Map<string, BackfillMeta> {
  const byId = new Map<string, BackfillMeta>();
  try {
    for (const s of sessions) {
      if (!s.sessionId || byId.has(s.sessionId)) continue;
      const m = getSessionById(s.sessionId);
      if (m) byId.set(s.sessionId, m);
    }
  } catch {
  }
  return byId;
}

export function backfillActiveRowsFromIndex(sessions: ActiveSession[]): void {
  backfillActiveRowsFromMeta(sessions, loadBackfillMetaFor(sessions));
}

export function isRunningLiveSession(s: ActiveSession): boolean {
  if (s.status === 'queued' || s.status === 'closed' || s.status === 'crashed') return false;
  if (s.context === 'cloud') return Boolean(s.cloudProvider) && Boolean(s.cloudTaskId);
  // Unknown liveness from an older peer is not enough for bare --active.
  return Boolean(s.machine) && typeof s.pid === 'number' && s.pid > 0 && s.pidAlive === true;
}

export function activeSessionProjectKey(s: Pick<ActiveSession, 'cwd' | 'context'>): string {
  if (s.cwd) return path.basename(s.cwd);
  return s.context === 'cloud' ? 'cloud' : 'other';
}

export function serializeActiveSessionsForJson(
  sessions: ActiveSession[],
): Array<Omit<ActiveSession, 'viewingIn'> & {
  ticketId: string | null;
  project: string;
  confirmedProject: string | null;
  prLink: string | null;
  viewingIn: string | null;
}> {
  const defs = listProjectDefsCached();
  return sessions.map((s) => ({
    ...s,
    ticketId: s.ticket?.id ?? null,
    project: activeSessionProjectKey(s),
    // The project a person sees this row under, or null for Uncategorized. `project` above stays
    // the always-present join key (cwd basename or cloud/other bucket); grouping by it filed
    // unbound directories as projects.
    confirmedProject: confirmedProjectForCwd(s.cwd, defs) ?? null,
    prLink: s.pr?.url ?? null,
    viewingIn: viewingInLabel(s) ?? null,
  }));
}

export function serializeSessionsJson(sessions: SessionMeta[]): string {
  const serializable = sessions.map((s) => {
    const { _matchedTerms, _bm25Score, _remote, ...rest } = s;
    return rest;
  });
  return JSON.stringify(serializable, null, 2) + '\n';
}

/** Every status is computed from observable signals (PID liveness, transcript mtime), never
 * self-reported. `closed` means the PID is dead (never fabricate `idle`). `abandoned`: no
 * transcript write in {@link ABANDONED_STALE_MS}. `unknown`: no signal at all. */
export type ActiveStatus =
  | 'running'
  | 'idle'
  | 'queued'
  | 'input_required'
  | 'closed'
  | 'abandoned'
  | 'orphaned'
  | 'crashed'
  | 'unknown';

/** Coarse lifecycle bucket a UI groups rows by, projected once from {@link ActiveStatus} so
 * consumers stop re-deriving it (PHNX-2484). `running`, `waiting` (needs-you), `failed`
 * (crashed/orphaned/abandoned), `done` (exited cleanly), `idle` (alive but quiet or unclassified). */
export type SessionPhase = 'running' | 'waiting' | 'failed' | 'done' | 'idle';

/** Which rung of the recap ladder produced a row's title (RUSH-3011, PHNX-3797), best-first:
 * `label` (a `/rename` or harness label), `generated` (daemon title), `prompt` (first-user-prompt
 * topic). No rung for the agent's last line: it is a rolling monologue, kept as `lastAgentLine`. */
export type RecapSource = 'label' | 'generated' | 'prompt';

/** How urgent a row's secondary line is (PHNX-3797), best-first: `question` (agent parked on an
 * answer), `needs_you` (blocked on the operator), `activity` (nothing blocking). The first two get
 * their own ranked line because a rolling activity preview buries them. */
export type ImportantMessageKind = 'question' | 'needs_you' | 'activity';

/** The most important recent agent message for a row's secondary line (PHNX-3797): what the agent
 * is doing or waiting on now, ranked by {@link deriveImportantMessage} so a blocking question
 * beats generic activity. */
export interface SessionImportantMessage {
  text: string;
  kind: ImportantMessageKind;
}

export interface ActiveSession {
  context: ActiveContext;
  kind: string;
  /** Custom harness/profile name when launched via `agents run <profile>` (e.g. `deepseek`). `kind`
   * stays the host process (claude) so transcript lookup works. Shown by `sessions --active`
   * (PHNX-2935). */
  harness?: string;
  host?: string;
  pid?: number;
  sessionId?: string;
  cwd?: string;
  project?: string | null;
  label?: string;
  name?: string;
  topic?: string;
  firstUserMessage?: string;
  /** The latest genuine user turn, cleaned and backfilled from the index beside {@link
   * firstUserMessage}. {@link deriveSessionRecap} classifies it: a redirected session's real
   * request is the last thing said (PHNX-3939). */
  lastUserMessage?: string;
  /** The daemon-generated session title (PHNX-3797), produced once per session by `session-title`
   * and backfilled by {@link backfillActiveRowsFromMeta}. Rung 2 of the headline ladder; see
   * {@link title}. */
  generatedTitle?: string;
  /** The row's shown title (RUSH-3011, PHNX-3797): `label` -> `generatedTitle` -> classified user
   * prompt (PHNX-3939), via {@link deriveSessionRecap}. A user-anchored name, never the agent's
   * latest turn. Folded on in {@link getActiveSessions}; `recapSource` names the rung. */
  title?: string;
  recapSource?: RecapSource;
  /** The first user turn cleaned for a "You" line: a screenshot path folds to `[image]`, a pasted
   * `$ cmd` to the command, a `/skill` path to `/<name>`. See {@link classifyUserPrompt}. */
  userPromptClean?: string;
  userPromptKind?: UserPromptKind;
  /** The most recent assistant line from the transcript tail: a live-status field beside
   * `preview`/`activity`, deliberately not a rung of the {@link title} ladder (PHNX-3797). */
  lastAgentLine?: string;
  preview?: string;
  /** The row's secondary line (PHNX-3797): a pending question, needs-you block, or current
   * activity, ranked by {@link deriveImportantMessage}. Folded on beside `title` in {@link
   * foldRecap} and carried on the `sessions watch --json` feed. */
  importantMessage?: SessionImportantMessage;
  activity?: SessionActivity;
  model?: string;
  failures?: import('@phnx-labs/sessions-cli/reader').SessionFailure[];
  activityHistogram?: import('@phnx-labs/sessions-cli/reader').SessionActivityHistogram;
  userTurns?: import('@phnx-labs/sessions-cli/reader').SessionUserTurn[];
  subagents?: import('@phnx-labs/sessions-cli/reader').SessionSubagent[];
  /** Output-token throughput (tokens/sec) over a rolling 60s window from the transcript tail;
   * absent when no transcript resolves or the format reports no usage. */
  tokPerSec?: number;
  awaitingReason?: AwaitingReason;
  question?: StructuredQuestion;
  /** Plan markdown from the last `ExitPlanMode` call. Present if the transcript ever entered
   * plan-review; `awaitingReason === 'plan_review'` says whether it is still pending. */
  plan?: string;
  /** Live plan progress from the latest `TodoWrite` (RUSH-1380): checklist items, done/total tally
   * and current step. Works for remote and device-dispatched agents with no local tool-call
   * stream. */
  todos?: TodoProgress;
  tail?: string[];
  pr?: DetectedPr;
  worktree?: DetectedWorktree;
  ticket?: DetectedTicket;
  rateLimited?: boolean;
  createdTickets?: string[];
  spawnedTeam?: string;
  attachments?: SessionAttachment[];
  /** The session's operative request: the latest genuine user turn, tidied but never rewritten
   * (PHNX-3939), separating prose from screenshot paths, clips, `@dir` mentions and terminal echo.
   * Folded by the daemon timeline pass. */
  request?: SessionRequest;
  /** Narration-anchored steps: what the agent has been doing, in its own words (PHNX-3939). Last 8
   * in full plus a fold of older ones. Produced by the daemon's timeline pass, never on the
   * request path. */
  timeline?: SessionTimeline;
  files?: SessionFiles;
  tokenCount?: number;
  durationMs?: number;
  subAgentCount?: number;
  artifacts?: import('@phnx-labs/sessions-cli/reader').ProducedArtifact[];
  planFile?: string;
  sessionFile?: string;
  startedAtMs?: number;
  /** Agent version (e.g. `2.1.207`) for the `agent version` cell. A running process does not report
   * its own semver, so it is backfilled at render time from the indexed {@link SessionMeta}
   * (RUSH-2205). */
  version?: string;
  /** Email of the account that produced the session (display-only), backfilled from the index
   * (PHNX-3184); a running process does not report which account `--strategy balanced` picked.
   * Avoids a per-tab `agents sessions` spawn (agi-cli#3019). Group on `accountKey`, not this. */
  account?: string;
  /** Account-slot name (e.g. `gmail` in `claude#gmail`), display-only, backfilled with {@link
   * account} from the index and account registry. Unknown or ambiguous slots stay undefined. Group
   * on `accountKey`, not this. */
  accountLabel?: string;
  /** Last-activity epoch: the transcript's last write (mtime), distinct from {@link startedAtMs}.
   * The Floor renders "Xs ago" off this so an old but idle session does not look freshly active. */
  lastActivityMs?: number;
  /** The transcript's own cursor: the harness stamp on the last meaningful event ({@link
   * SessionState.lastEventMs}). Unlike {@link lastActivityMs}, hook records do not move it, so the
   * reconciler can tell if the agent worked past a hook prompt (PHNX-3999). */
  lastEventMs?: number;
  status: ActiveStatus;
  /** Coarse lifecycle bucket derived once from {@link status}, folded on by {@link foldPhase} after
   * {@link foldHostLink} finalizes `status`, so `orphaned`/`crashed` land in `failed` instead of
   * being mis-bucketed as `idle`. */
  phase?: SessionPhase;
  origin?: 'cli' | 'routine';
  routineName?: string;
  /** Presence for detach/attach: `attached` (live TUI), `background` (detached headless via `agents
   * sessions detach`), `parked` (headless continuation exited; transcript durable). Absent for
   * ad-hoc headless and cloud/team rows. Folded on from the detach store. */
  presence?: Presence;
  /** Whether anything is still on the other end of this session, folded on by {@link foldHostLink}
   * from the raw signals below, never asserted by a source. Drives the `orphaned`/`crashed`
   * statuses. */
  hostLink?: HostLink;
  /** Whether the process was alive at scan time (the boolean {@link applyState} computes). `status`
   * cannot stand in: `abandoned` fires on staleness before the liveness check, covering both
   * live-but-stuck and long-dead. Absent from cloud rows (no pid) and older peer CLIs. */
  pidAlive?: boolean;
  /** Clients attached to the tmux session (`#{session_attached}`) for a tmux-hosted row. Absent,
   * not zero, when not tmux-hosted: zero means nobody is looking, absent means we cannot tell. */
  tmuxClients?: number;
  /** When the owning IDE window last refreshed its slice of the live-terminals registry. Absent if
   * no IDE window owns the session; a stale value means the window is gone ({@link
   * HOST_HEARTBEAT_STALE_MS}). */
  windowHeartbeatMs?: number;
  pidCount?: number;
  /** Where the process actually lives: host, local vs SSH, tmux pane, and whether a rail exists to
   * type into it. Read from the process env (`/proc/<pid>/environ`, `ps eww` on macOS). Absent for
   * cloud sessions or unreadable env. */
  provenance?: SessionProvenance;
  /** Who initiated this session: the actor id stamped at spawn (`resolveActor().id`). A tailnet
   * login/email, `UNRESOLVED@<host>` if undetermined, absent if the launch predates stamping. The
   * owner column in `--active` (RUSH-2018). */
  owner?: string;
  /** The machine this session runs on, as a normalized device id (machineId() form), set when
   * merging cross-machine results. Absent for a purely local query. For a host-dispatched run this
   * is the execution host, not the shim's box (see {@link foldExecutionMachine}). */
  machine?: string;
  /** Set only on the dispatching box's row for a host-dispatched run (`agents run --device
   * <peer>`): the live process here is the ssh/TTY shim while the agent runs on {@link machine}.
   * Lets a merged fleet view prefer the executing machine's row. */
  offloadedFrom?: string;
  teamName?: string;
  /** For a teams teammate: the session id of the orchestrator that ran `agents teams add` (from
   * AGENTS_SESSION_ID at spawn), to group teammates under it. Distinct from `sessionId`, the
   * teammate's own transcript. */
  orchestratorSessionId?: string;
  orchestratorLabel?: string;
  /** For a teams teammate: a one-line summary of its spawn prompt (the team's task), so the listing
   * shows what the team works on even before any transcript exists. Distinct from `topic`, derived
   * from the transcript. */
  assignedTask?: string;
  agentId?: string;
  cloudProvider?: string;
  cloudTaskId?: string;
  cloudStatus?: string;
  /** IDE window that owns this terminal: the per-window slice key in `live-terminals.json`
   * (`${vscode.env.sessionId}-${extension-host pid}`). Clusters terminals of one window even when
   * two windows share a cwd. `terminal` context only. */
  windowId?: string;
  /** Controlling TTY of the agent process (e.g. 'ttys003') from the `ps -A` read; macOS/Linux
   * terminal sessions only, '??' normalized to undefined. A disambiguation bridge. */
  tty?: string;
  /** Ghostty tab index (1-based) matched by working directory (+ title). Transient: set by the
   * renderer just before printing, not part of pure discovery. */
  ghosttyTab?: number;
  /** Resolved tmux attach target (`session:window.pane`) for a tmux-hosted local session via
   * `mapPanesToTargets`. Transient, renderer-set, not emitted on the discovery path. */
  tmuxTarget?: string;
  /** Host app + tab a tmux-hosted session is being viewed in, resolved from the attached tmux
   * client. `undefined` means no client is attached (running detached). Transient, renderer-set
   * (viewing-in.ts). */
  viewingIn?: { app: string; tab?: number };
  /** The editor tab that launched this agent (`AGENT_TERMINAL_ID`), from the pid registry or
   * terminal entry. It survives an SSH hop and a session rotation, unlike the spawn-time session
   * id, so `--active --device` joins on it. Absent if the launch did not inherit a terminal id. */
  terminalId?: string;
  tabIndex?: number;
  /** The launch id (`AGENT_LAUNCH_ID`) stamped on every agent at spawn: a stable UUID identical
   * locally and across SSH, surviving session-id rotation, and present from the first tick (unlike
   * `sessionId` for non-Claude harnesses). The join key a client uses on the watch stream. */
  launchId?: string;
  /** tmux pane id (`%N`) when the row came from the tmux source and its session id could not be
   * resolved. It is the dedupe key for such id-less rows so two anonymous panes in one cwd stay
   * distinct. Unset once an id resolves. */
  paneId?: string;
  /** The `ag-<agent>-<shortid>` tmux session name the row was found under. Kept even without a full
   * session id, since the `<shortid>` suffix is the only stable selector, used by `--active`
   * output and `agents sessions inject <shortid>` (PHNX-3688). */
  tmuxName?: string;
  /** Daemon-computed 1-2 line goal from the first user turn (PHNX-3939), produced off the request
   * path by `SessionSummarizerService` and merged from the `session_summaries` cache in {@link
   * applyImmutableMemo}. */
  goal?: string;
  checkpoints?: import('@phnx-labs/sessions-cli/reader').SessionCheckpoint[];
  summaryChecklist?: import('@phnx-labs/sessions-cli/reader').SessionChecklistItem[];
  summaryState?: import('@phnx-labs/sessions-cli/reader').SummaryState;
}

export function activeStatusFromCloudStatus(status: CloudTaskStatus): ActiveStatus {
  switch (status) {
    case 'running':
      return 'running';
    case 'idle':
      return 'idle';
    case 'input_required':
      return 'input_required';
    default:
      return 'queued';
  }
}

interface ActiveQueryOptions {
  skipHeadless?: boolean;
  /** A `--local` query: this machine only. Never dial a remote-host teammate over ssh; report its
   * last-persisted meta.json state instead. RUSH-2118: otherwise `--active --local` fired one ssh
   * round-trip per remote teammate. */
  localOnly?: boolean;
}

const LIVE_TERMINALS_FILE = path.join(getTerminalsDir(), 'live-terminals.json');

/** A process is `running` if its session file was touched in the last 2 minutes; every Claude/Codex
 * tool call appends an event, so a healthy session writes several times a minute. */
const ACTIVE_MTIME_WINDOW_MS = 2 * 60_000;

/** Bound on the tmux `list-panes` call in {@link listTmuxAgentSessions}: a wedged tmux server would
 * hang the whole `--active` scan. On timeout it throws {@link TmuxDiscoveryDegradedError}. */
const TMUX_LIST_PANES_TIMEOUT_MS = 5_000;

/** Thrown by {@link listTmuxAgentSessions} when the socket exists but tmux could not be asked
 * (spawn failure, timeout, nonzero exit). A missing socket is genuinely empty, not degraded.
 * `getActiveSessions` swallows it to `[]`; {@link describeActiveDiscoveryHealth} surfaces it. */
export class TmuxDiscoveryDegradedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TmuxDiscoveryDegradedError';
  }
}

/** A live process can only borrow an indexed session file touched recently enough to plausibly be
 * its own. Wider than ACTIVE_MTIME_WINDOW_MS (a live CLI can idle longer) but it must not attach
 * to a weeks-old transcript. */
const ACTIVE_SESSION_STALE_MS = 24 * 60 * 60_000;

/** A session with no transcript write in this long is ABANDONED (dangling), whether its PID is dead
 * or alive but hung. Two days: past a normal work gap, short of a long weekend. Far wider than
 * {@link ACTIVE_SESSION_STALE_MS}: this is the lifecycle threshold, not the freshness window. */
export const ABANDONED_STALE_MS = 2 * 24 * 60 * 60_000;

/** Field separator for every `tmux list-panes -F` query. NOT a tab: tmux 3.6a rewrites a tab to
 * `_`, so {@link listTmuxAgentSessions} got one field and returned zero rows. `:` is safe: tmux
 * replaces `:`/`.` in session names. Paths can contain it, so `pane_current_path` is last. */
const TMUX_FIELD_SEP = ':';

/** Process comm names not derivable from the AGENTS registry's `cliCommand`. `rush` is a {@link
 * SESSION_AGENTS} member with no registry row, so it is mapped here; everything else flows from
 * the registry. */
const EXTRA_SESSION_AGENT_COMMS: Partial<Record<SessionAgentId, string[]>> = {
  rush: ['rush'],
};

/** Every process executable ("comm") name identifying a session-agent kind in the headless
 * `ps`-scan, from the registry's `cliCommand` plus {@link EXTRA_SESSION_AGENT_COMMS}. Exported so
 * the completeness test can assert every {@link SESSION_AGENTS} member resolves. */
export function sessionAgentComms(id: SessionAgentId): string[] {
  const comms = new Set<string>();
  const cli = (AGENTS as Record<string, { cliCommand?: string }>)[id]?.cliCommand;
  if (cli) comms.add(cli);
  for (const extra of EXTRA_SESSION_AGENT_COMMS[id] ?? []) comms.add(extra);
  return [...comms];
}

/** Executables recognized as agent CLIs in the process table, built once from {@link
 * sessionAgentComms}: a single derived source, not a second hand-kept allowlist that drifts from
 * discovery. */
const AGENT_CLI_NAMES: Record<string, SessionAgentId> = (() => {
  const map: Record<string, SessionAgentId> = {};
  for (const id of SESSION_AGENTS) {
    for (const comm of sessionAgentComms(id)) map[comm] = id;
  }
  return map;
})();

/** Resolve an agent kind from a process's executable. `comm` may be an absolute path
 * (shim-launched) or carry `.exe` on Windows, so strip basename and suffix before lookup. */
export function agentKindFromComm(commRaw: string): string | undefined {
  // A GUI app can bundle a binary named like an agent CLI (Codex.app ships `.../Resources/codex`,
  // its `app-server`), which would surface as a phantom agent at cwd '/'. A real agent CLI is
  // never inside a `.app` bundle, so exclude those.
  if (commRaw.includes('.app/Contents/')) return undefined;
  const base = path.basename(commRaw);
  const stripped = base.replace(/\.exe$/i, '');
  const key = stripped === base ? base : stripped.toLowerCase();
  return AGENT_CLI_NAMES[key];
}

/** A tmux agent session name is `ag-<agent>-<shortid>` (exec.ts `runInTmux`); `<agent>` may contain
 * a hyphen, `<shortid>` is 8 hex chars, so anchor on the suffix. Not cross-checked against
 * AGENT_CLI_NAMES (the narrower ps-scan set), or grok/kimi/antigravity panes would be dropped. */
const AG_NAME_RE = AG_TMUX_NAME_RE;

export function agentKindFromName(sessName: string): string | undefined {
  const m = AG_NAME_RE.exec(sessName);
  return m ? m[1].toLowerCase() : undefined;
}

export function shortIdFromName(sessName: string): string | undefined {
  const m = AG_NAME_RE.exec(sessName);
  return m ? m[2].toLowerCase() : undefined;
}

/** Map every `ag-<agent>-<shortid>` tmux session name to its full session UUID in one batched DB
 * lookup per poll, so a detached agent is findable by `focus <id>` without durable identity
 * records. `findSessionsByShortIds` is injected. */
export function resolveNamesToSessionIds(
  sessionNames: string[],
  deps: { findSessionsByShortIds: (shortIds: string[]) => Map<string, { id: string }> },
): Map<string, string> {
  const shortIdToNames = new Map<string, string[]>();
  for (const name of sessionNames) {
    const short = shortIdFromName(name);
    if (!short) continue;
    const arr = shortIdToNames.get(short);
    if (arr) arr.push(name);
    else shortIdToNames.set(short, [name]);
  }
  const out = new Map<string, string>();
  if (shortIdToNames.size === 0) return out;
  const metas = deps.findSessionsByShortIds([...shortIdToNames.keys()]);
  for (const [short, meta] of metas) {
    for (const name of shortIdToNames.get(short) ?? []) out.set(name, meta.id);
  }
  return out;
}

/** A process that began more than this long after a session's recorded `startedAtMs` cannot be that
 * session: the OS recycled its pid. The window absorbs `ps -o lstart=` whole-second granularity
 * and hook delay, yet is far below pid wraparound, so it never false-kills a live session. */
const PID_REUSE_TOLERANCE_MS = 60_000;

/** Epoch-ms start time of the process at `pid`, or null if unknowable. Reads `ps -o lstart=` to be
 * comparable with a session's `startedAtMs`. Windows and failures return null, so the caller falls
 * back to an existence check. */
function processStartMs(pid: number): number | null {
  if (process.platform === 'win32') return null;
  try {
    const out = execFileSync('ps', ['-o', 'lstart=', '-p', String(pid)], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    if (!out) return null;
    const ms = Date.parse(out);
    return Number.isFinite(ms) ? ms : null;
  } catch {
    return null;
  }
}

/** True when `pid` is live and, if `startedAtMs` is given, plausibly the same process. A bare
 * `process.kill(pid, 0)` reports a dead session alive once its pid is recycled. A process starting
 * well after `startedAtMs` is a reused pid; an unreadable start time keeps the existence answer. */
export function isPidAlive(pid: number, startedAtMs?: number): boolean {
  if (!pid || pid < 1) return false;
  try {
    process.kill(pid, 0);
  } catch (err: any) {
    if (err?.code !== 'EPERM') return false;
  }
  if (startedAtMs && startedAtMs > 0) {
    // A live recycled PID must not revive an unrelated dead session.
    const procStartMs = processStartMs(pid);
    if (procStartMs !== null && procStartMs > startedAtMs + PID_REUSE_TOLERANCE_MS) {
      return false;
    }
  }
  return true;
}

interface LiveTerminalEntry {
  sessionId: string;
  terminalId?: string;
  tabIndex?: number;
  pid: number;
  kind: string;
  label?: string | null;
  cwd?: string | null;
  startedAtMs: number;
  windowId?: string;
  windowHeartbeatMs?: number;
  pidDead?: boolean;
}

/** Keep dead entries only when their window heartbeat also stopped, proving a crash; a live
 * duplicate always wins. */
function readLiveTerminals(): LiveTerminalEntry[] {
  let raw: string;
  try {
    raw = fs.readFileSync(LIVE_TERMINALS_FILE, 'utf8');
  } catch {
    return [];
  }
  let parsed: any;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!parsed || typeof parsed !== 'object') return [];

  const now = Date.now();
  const merged = new Map<string, LiveTerminalEntry>();
  for (const [windowId, slice] of Object.entries(parsed) as [string, any][]) {
    const at = Date.parse(slice?.at ?? '');
    const windowHeartbeatMs = Number.isFinite(at) ? at : undefined;
    const windowGone = windowHeartbeatMs !== undefined && now - windowHeartbeatMs >= HOST_HEARTBEAT_STALE_MS;
    for (const e of (slice?.entries ?? []) as LiveTerminalEntry[]) {
      if (!e?.sessionId) continue;
      const alive = isPidAlive(e.pid, e.startedAtMs);
      if (!alive && !windowGone) continue;
      const entry: LiveTerminalEntry = { ...e, windowId, windowHeartbeatMs, pidDead: !alive };
      const prev = merged.get(e.sessionId);
      if (prev && !prev.pidDead && !alive) continue;
      merged.set(e.sessionId, entry);
    }
  }
  return Array.from(merged.values());
}

/** Process-local memo for Claude transcript path resolution: each poll re-walks every version-home
 * `projects/` tree for every live pid (#2047). A path is sticky while the file exists; a miss
 * re-walks. Capped so a long-lived process cannot retain every cwd. */
const CLAUDE_SESSION_FILE_CACHE_MAX = 256;
const claudeSessionFileCache = new Map<string, string>();

/** Search every version home: the live ~/.claude symlink moves after upgrades while older running
 * sessions keep writing to their original home. */
function findClaudeSessionFile(cwd: string, sessionId?: string): string | undefined {
  if (sessionId) {
    const cacheKey = `${cwd}\0${sessionId}`;
    const hit = claudeSessionFileCache.get(cacheKey);
    if (hit !== undefined) {
      try {
        if (fs.existsSync(hit)) return hit;
      } catch {  }
      claudeSessionFileCache.delete(cacheKey);
    }
    const resolved = pickClaudeSessionFileAcrossRoots(getAgentSessionDirs('claude', 'projects'), cwd, sessionId);
    if (resolved) {
      if (claudeSessionFileCache.size >= CLAUDE_SESSION_FILE_CACHE_MAX) claudeSessionFileCache.clear();
      claudeSessionFileCache.set(cacheKey, resolved);
    }
    return resolved;
  }
  return pickClaudeSessionFileAcrossRoots(getAgentSessionDirs('claude', 'projects'), cwd, sessionId);
}

/** Resolve a Claude transcript for `cwd` across the given project roots; newest mtime wins when an
 * id/cwd resolves in several version homes. Pure over `projectRoots`, so testable against temp
 * dirs. */
export function pickClaudeSessionFileAcrossRoots(
  projectRoots: string[],
  cwd: string,
  sessionId?: string,
): string | undefined {
  const enc = claudeProjectDirName(cwd);
  let best: { path: string; mtime: number } | undefined;
  for (const root of projectRoots) {
    const hit = pickSessionFile(path.join(root, enc), sessionId);
    if (!hit) continue;
    let mtime: number;
    try {
      mtime = fs.statSync(hit).mtimeMs;
    } catch {
      continue;
    }
    if (!best || mtime > best.mtime) best = { path: hit, mtime };
  }
  return best?.path;
}

/** Pick a Claude transcript in a project dir. With a concrete session id: that id's `<id>.jsonl` or
 * undefined, never a sibling (the newest-file fallback collapsed co-located sessions onto one
 * preview). With no id: the newest `.jsonl` by mtime. */
export function pickSessionFile(projectDir: string, sessionId?: string): string | undefined {
  if (sessionId) {
    const specific = path.join(projectDir, `${sessionId}.jsonl`);
    return fs.existsSync(specific) ? specific : undefined;
  }

  let files: string[];
  try {
    files = fs.readdirSync(projectDir).filter(f => f.endsWith('.jsonl'));
  } catch {
    return undefined;
  }

  let best: { path: string; mtime: number } | null = null;
  for (const f of files) {
    const p = path.join(projectDir, f);
    try {
      const m = fs.statSync(p).mtimeMs;
      if (!best || m > best.mtime) best = { path: p, mtime: m };
    } catch {  }
  }
  return best?.path;
}

/** One `stat` gives the transcript's creation (about session start) and last-write epochs,
 * `undefined` if it can't be stat'd. `birthtimeMs` can be 0 without creation time; coerce to
 * `undefined`, not epoch 0. */
export function sessionFileTimes(sessionFile: string | undefined): { birthtimeMs?: number; mtimeMs?: number } {
  if (!sessionFile) return {};
  try {
    const st = fs.statSync(sessionFile);
    return { birthtimeMs: st.birthtimeMs || undefined, mtimeMs: st.mtimeMs || undefined };
  } catch {
    return {};
  }
}

/** Lifecycle status from PID liveness and transcript mtime; `undefined` for a live fresh process so
 * the activity-derived status is used. No write in {@link ABANDONED_STALE_MS} => `abandoned`
 * (first). Else dead PID => `closed`, fixing the old "dead PID reports idle" lie. */
export function lifecycleStatus(
  pidAlive: boolean,
  mtimeMs: number | undefined,
  nowMs: number = Date.now(),
): ActiveStatus | undefined {
  if (mtimeMs !== undefined && nowMs - mtimeMs >= ABANDONED_STALE_MS) return 'abandoned';
  if (!pidAlive) return 'closed';
  return undefined;
}

/** The one place a fallback status is decided when no rich transcript state exists (opaque kind, or
 * empty/unreadable tail). Computed from PID + mtime, never a fabricated `idle`. Dead or days-stale
 * => {@link lifecycleStatus}. Live + fresh => `running`, never a blank `unknown`. */
export function resolveFallbackStatus(
  sessionFile: string | undefined,
  pidAlive: boolean,
  nowMs: number = Date.now(),
): ActiveStatus {
  const { mtimeMs } = sessionFileTimes(sessionFile);
  return lifecycleStatus(pidAlive, mtimeMs, nowMs) ?? 'running';
}

/** Locate the live transcript for an agent process: Claude off disk by cwd (+ id), others via the
 * session index. A known id selects it; id-less falls back to the newest indexed one for the cwd.
 * An unresolvable id yields undefined, never a same-cwd neighbour's transcript (RUSH-2691). */
export function findSessionFileForKind(kind: string, cwd?: string, sessionId?: string): string | undefined {
  if (!cwd) return undefined;
  if (kind === 'claude') return findClaudeSessionFile(cwd, sessionId);
  if (!isSessionTrackedAgent(kind)) return undefined;
  if (sessionId) return indexedSessionFileForId(kind, sessionId);
  return latestSessionFileForCwd(kind, cwd, { maxAgeMs: ACTIVE_SESSION_STALE_MS });
}

/** The indexed transcript for one exact session id, or undefined if the index has not reached it.
 * The `agent` guard rejects a row from a different harness than the live process claims, which
 * cannot be the same conversation. */
function indexedSessionFileForId(kind: string, sessionId: string): string | undefined {
  const row = getSessionById(sessionId);
  if (!row || row.agent !== kind) return undefined;
  return row.filePath || undefined;
}

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
function sessionIdFromFile(file?: string): string | undefined {
  if (!file) return undefined;
  return path.basename(file).match(UUID_RE)?.[0];
}

interface LiveSignals {
  state?: SessionState;
  tokPerSec?: number;
}

const LIVE_STATE_MAX_EVENTS = 80;

/** Parse a non-claude/codex transcript with its harness's own parser and return its last events for
 * state inference. These formats cannot use the byte-tail fast path, so parse the whole
 * size-guarded file. A parse failure yields no events. */
function parseTailEventsForKind(agent: SessionAgentId, sessionFile: string): SessionEvent[] {
  let events: SessionEvent[];
  try {
    events = parseSession(sessionFile, agent);
  } catch {
    return [];
  }
  return events.length > LIVE_STATE_MAX_EVENTS ? events.slice(-LIVE_STATE_MAX_EVENTS) : events;
}

/** Process-local memo of the parsed tail for {@link computeLiveSignals} (#2047): parsing is
 * memoized on mtime, but classification re-runs against the current clock and `pidAlive`, so
 * time-based verdicts expire on schedule (PHNX-3999). Bounded for a long-lived daemon. */
const LIVE_TAIL_CACHE_MAX = 512;
interface LiveTail {
  mtimeMs: number | undefined;
  events: SessionEvent[];
  tokPerSec?: number;
}
const liveTailCache = new Map<string, LiveTail>();

export function clearLiveSignalsCacheForTest(): void {
  liveTailCache.clear();
}

/** Parse the transcript tail for one harness. Claude/Codex use the fast bounded byte-tail ({@link
 * readSessionTailWithRaw}), the hot path and the only ones yielding throughput; every other
 * tracked harness uses its own parser. */
function parseLiveTail(kind: string, sessionFile: string, mtimeMs: number | undefined): LiveTail {
  if (kind === 'claude' || kind === 'codex') {
    const { events, content } = readSessionTailWithRaw(sessionFile, kind);
    const tokPerSec = events.length > 0 ? computeTokPerSec(content, kind) : 0;
    return { mtimeMs, events, tokPerSec: tokPerSec > 0 ? tokPerSec : undefined };
  }
  if (isSessionTrackedAgent(kind)) return { mtimeMs, events: parseTailEventsForKind(kind, sessionFile) };
  return { mtimeMs, events: [] };
}

/** Derive inferred state (working/waiting/idle + preview/badges) and, for Claude/Codex,
 * output-token throughput via {@link inferSessionState}. No signals falls back to `running`. An
 * unchanged-mtime call reuses the parsed tail but re-classifies against `nowMs`. */
export function computeLiveSignals(
  kind: string,
  sessionFile: string | undefined,
  cwd: string | undefined,
  pidAlive: boolean,
  nowMs: number = Date.now(),
): LiveSignals {
  if (!sessionFile) return {};
  let mtimeMs: number | undefined;
  try { mtimeMs = fs.statSync(sessionFile).mtimeMs; } catch {  }

  const cacheKey = `${kind}\0${sessionFile}\0${cwd ?? ''}`;
  let tail = liveTailCache.get(cacheKey);
  if (!tail || tail.mtimeMs !== mtimeMs) {
    tail = parseLiveTail(kind, sessionFile, mtimeMs);
    if (liveTailCache.size >= LIVE_TAIL_CACHE_MAX) liveTailCache.clear();
    liveTailCache.set(cacheKey, tail);
  }
  if (tail.events.length === 0) return {};

  const state = inferSessionState(tail.events, { cwd, pidAlive, mtimeMs, activeWindowMs: ACTIVE_MTIME_WINDOW_MS, nowMs });
  return { state, tokPerSec: tail.tokPerSec };
}

function statusFromActivity(activity: SessionActivity): ActiveStatus {
  return activity === 'working' ? 'running' : activity === 'waiting_input' ? 'input_required' : 'idle';
}

/** Fold a computed SessionState onto an active-session row: status, preview, PR/worktree/ticket
 * badges. With no state it degrades to {@link resolveFallbackStatus} (`running` for an alive
 * process), not `unknown`. */
function applyState(base: Omit<ActiveSession, 'status'>, state: SessionState | undefined, fallbackFile: string | undefined, pidAlive: boolean): ActiveSession {
  if (!state) return { ...base, pidAlive, status: resolveFallbackStatus(fallbackFile, pidAlive) };
  // Lifecycle (closed/abandoned) comes from PID + mtime and overrides the activity-derived status:
  // a dead or days-stale process must not read as `running` because its tail ended mid-tool-call.
  // `base.lastActivityMs` is the already-resolved mtime.
  const life = lifecycleStatus(pidAlive, base.lastActivityMs ?? sessionFileTimes(fallbackFile).mtimeMs);
  return {
    ...base,
    pidAlive,
    status: life ?? statusFromActivity(state.activity),
    activity: state.activity,
    model: state.model,
    failures: state.failures,
    userTurns: state.userTurns,
    awaitingReason: state.awaitingReason,
    question: state.question,
    lastEventMs: state.lastEventMs,
    plan: state.plan,
    todos: state.todos,
    tail: state.tail,
    preview: state.preview ?? base.preview,
    pr: state.pr,
    worktree: state.worktree,
    ticket: state.ticket,
    createdTickets: state.createdTickets,
    spawnedTeam: state.spawnedTeam,
    attachments: state.attachments,
    artifacts: state.artifacts,
    planFile: state.planFile,
    rateLimited: state.rateLimited,
  };
}

/** Extract the first user message's content from a Claude JSONL file; reads only the first ~50
 * lines, since it is typically near the top. */
function extractClaudeUserText(parsed: any): string | undefined {
  const msg = parsed.message;
  if (!msg?.content) return undefined;
  const content = Array.isArray(msg.content) ? msg.content : [msg.content];
  const texts: string[] = [];
  for (const block of content) {
    if (typeof block === 'string') texts.push(block);
    else if (block?.type === 'text' && typeof block.text === 'string') texts.push(block.text);
  }
  return texts.join('\n').trim() || undefined;
}

function quickExtractTopic(sessionFile: string): string | undefined {
  let fd: number;
  try {
    fd = fs.openSync(sessionFile, 'r');
  } catch {
    return undefined;
  }

  try {
    const chunkSize = 256 * 1024;
    const maxBytes = 2 * 1024 * 1024;
    let buffer = '';
    let totalRead = 0;
    let linesChecked = 0;
    const maxLines = 30;

    while (totalRead < maxBytes && linesChecked < maxLines) {
      const chunk = Buffer.alloc(chunkSize);
      const bytesRead = fs.readSync(fd, chunk, 0, chunkSize, totalRead);
      if (bytesRead === 0) break;
      totalRead += bytesRead;
      buffer += chunk.toString('utf8', 0, bytesRead);

      let lineStart = 0;
      let lineEnd: number;
      while ((lineEnd = buffer.indexOf('\n', lineStart)) !== -1 && linesChecked < maxLines) {
        const line = buffer.slice(lineStart, lineEnd);
        lineStart = lineEnd + 1;
        linesChecked++;

        if (!line.trim()) continue;

        let parsed: any;
        try {
          parsed = JSON.parse(line);
        } catch {
          continue;
        }

        if (parsed.type === 'user') {
          const text = extractClaudeUserText(parsed);
          if (text) {
            const topic = extractSessionTopic(text);
            if (topic) return topic;
          }
        }
      }
      buffer = buffer.slice(lineStart);
    }
  } finally {
    fs.closeSync(fd);
  }

  return undefined;
}

/** One-line summary of a teammate's spawn prompt (the team's task): first non-empty line, leading
 * `MISSION:`/`CONTEXT:`/`TASK:` label stripped, truncated. Exported for tests. */
export function summarizeMission(prompt: string | null | undefined): string | undefined {
  if (!prompt) return undefined;
  const firstLine = prompt.split('\n').map((l) => l.trim()).find(Boolean);
  if (!firstLine) return undefined;
  const cleaned = firstLine.replace(/^(MISSION|CONTEXT|TASK|GOAL|OBJECTIVE)\s*[:\-—]\s*/i, '').trim();
  if (!cleaned) return undefined;
  return cleaned.length > 80 ? `${cleaned.slice(0, 79)}…` : cleaned;
}

/** Live teams teammates via AgentManager, which polls PIDs with `kill -0`. `localOnly` (RUSH-2118)
 * skips the ssh round-trip AgentManager issues for each remote-host teammate. */
export async function listTeamsActive(opts: { localOnly?: boolean } = {}): Promise<ActiveSession[]> {
  const mgr = new AgentManager(undefined, undefined, undefined, undefined, undefined, opts.localOnly ?? false);
  const running = await mgr.listRunning();
  const self = machineId();
  return running.map((a): ActiveSession => {
    // The teammate's own transcript is `remoteSessionId`; `parentSessionId` is the orchestrator (a
    // link, not its id). Keying the row off the orchestrator showed the orchestrator's id/topic,
    // so resolve the teammate's own session and expose the orchestrator separately.
    const ownSessionId = a.remoteSessionId ?? undefined;
    const sessionFile = findSessionFileForKind(a.agentType, a.cwd ?? undefined, ownSessionId);
    const topic = sessionFile ? quickExtractTopic(sessionFile) : undefined;
    const pidAlive = a.pid ? isPidAlive(a.pid) : true;
    const { state, tokPerSec } = computeLiveSignals(a.agentType, sessionFile, a.cwd ?? undefined, pidAlive);
    const resolvedId = ownSessionId ?? sessionIdFromFile(sessionFile);
    // A remote teammate (`teams add --device <peer>`) executes on the peer but has no
    // host-dispatch index row, so the self-stamp would claim it (SES-GAP-10). Attribute it to the
    // execution host and mark the dispatcher, as `run --device` does.
    const execHost = a.hostName ? normalizeHost(a.hostName) : undefined;
    const offloaded = execHost !== undefined && execHost !== self;
    return applyState({
      context: 'teams',
      kind: a.agentType,
      harness: a.profileName ?? undefined,
      pid: a.pid ?? undefined,
      sessionId: resolvedId,
      machine: offloaded ? execHost : undefined,
      offloadedFrom: offloaded ? self : undefined,
      orchestratorSessionId: a.parentSessionId ?? undefined,
      cwd: a.cwd ?? undefined,
      label: a.name ?? undefined,
      topic,
      tokPerSec,
      sessionFile,
      startedAtMs: a.startedAt.getTime(),
      lastActivityMs: sessionFileTimes(sessionFile).mtimeMs,
      teamName: a.taskName,
      assignedTask: summarizeMission(a.prompt),
      agentId: a.agentId,
      owner: resolveOwner(a.actor, resolvedId),
    }, state, sessionFile, pidAlive);
  });
}

export async function listTerminalsActive(): Promise<ActiveSession[]> {
  const entries = readLiveTerminals();
  if (entries.length === 0) return [];

  const procByPid = new Map<number, ProcRow>();
  for (const r of await readProcessTable()) procByPid.set(r.pid, r);
  const children = childrenByParent(new Map([...procByPid.values()].map(r => [r.pid, r.ppid])));

  const labelMap = buildClaudeLabelMap();
  const runNameMap = buildRunNameMap();

  return entries.map((t): ActiveSession => {
    const directEntry = readPidSessionEntry(t.pid, procByPid.get(t.pid)?.startTime);
    const candidate = directEntry?.sessionId ? directEntry
      : (!t.pidDead ? terminalDescendantEntry(t.pid, procByPid, children) : undefined) ?? directEntry;
    const pidEntry = candidate && (!isSessionTrackedAgent(t.kind) || candidate.agent === t.kind) ? candidate : undefined;
    const resolvedId = pidEntry?.sessionId ?? t.sessionId;
    const cwd = pidEntry?.cwd ?? t.cwd ?? undefined;
    const sessionKind = pidEntry?.agent ?? t.kind;
    const sessionFile = findSessionFileForKind(sessionKind, cwd, resolvedId);
    const label = t.label ?? (resolvedId ? labelMap.get(resolvedId) : undefined) ?? undefined;
    const name = resolvedId ? runNameMap.get(resolvedId) ?? undefined : undefined;
    const topic = sessionFile ? quickExtractTopic(sessionFile) : undefined;
    const pidAlive = isPidAlive(t.pid, t.startedAtMs);
    const { state, tokPerSec } = computeLiveSignals(sessionKind, sessionFile, cwd, pidAlive);
    return applyState({
      context: 'terminal',
      kind: sessionKind,
      harness: pidEntry?.harness,
      host: detectHost(t.pid, procByPid),
      tty: procByPid.get(t.pid)?.tty,
      pid: t.pid,
      sessionId: resolvedId ?? sessionIdFromFile(sessionFile),
      launchId: pidEntry?.launchId,
      terminalId: pidEntry?.terminalId ?? t.terminalId,
      tabIndex: t.tabIndex,
      cwd,
      label,
      name,
      topic,
      tokPerSec,
      sessionFile,
      startedAtMs: pidEntry?.startedAtMs ?? t.startedAtMs,
      lastActivityMs: sessionFileTimes(sessionFile).mtimeMs,
      windowId: t.windowId,
      windowHeartbeatMs: t.windowHeartbeatMs,
      owner: resolveOwner(pidEntry?.actor, resolvedId),
    }, state, sessionFile, pidAlive);
  });
}

function listCloudActive(): ActiveSession[] {
  let tasks;
  try {
    tasks = listActiveTasks();
  } catch {
    return [];
  }
  return tasks.map((t): ActiveSession => ({
    context: 'cloud',
    kind: t.agent || 'cloud',
    label: t.prompt.length > 60 ? t.prompt.slice(0, 57) + '...' : t.prompt,
    startedAtMs: Date.parse(t.createdAt) || undefined,
    status: activeStatusFromCloudStatus(t.status),
    cloudProvider: t.provider,
    cloudTaskId: t.id,
    cloudStatus: t.status,
  }));
}

interface ProcRow { pid: number; ppid: number; tty?: string; comm: string; kind?: string; startTime?: string; }

/** Ordered ancestor-process matchers; first match wins, most specific first: an IDE renderer beats
 * the terminal app that launched it, which beats the multiplexer inside it. */
const HOST_MATCHERS: Array<{ host: string; tokens: string[] }> = [
  { host: 'code',     tokens: ['Code Helper', 'Code - Insiders Helper', 'Code.exe'] },
  { host: 'cursor',   tokens: ['Cursor Helper', 'Cursor.exe'] },
  { host: 'codium',   tokens: ['VSCodium Helper', 'VSCodium.exe'] },
  { host: 'windsurf', tokens: ['Windsurf Helper', 'Windsurf.exe'] },
  { host: 'iterm',    tokens: ['iTerm2', 'iTermServer', 'iTerm'] },
  { host: 'terminal', tokens: ['Terminal.app', '/Applications/Utilities/Terminal.app', 'WindowsTerminal.exe'] },
  { host: 'warp',     tokens: ['Warp.app', 'stable_'] },
  { host: 'alacritty',tokens: ['alacritty', 'Alacritty'] },
  { host: 'kitty',    tokens: ['kitty'] },
  { host: 'hyper',    tokens: ['Hyper.app', 'Hyper Helper'] },
  { host: 'wezterm',  tokens: ['wezterm', 'WezTerm'] },
  { host: 'ghostty',  tokens: ['ghostty', 'Ghostty'] },
  { host: 'tmux',     tokens: ['tmux'] },
  { host: 'screen',   tokens: ['screen'] },
];

/** Snapshot the whole process table in one `ps` call, with ppid for ancestry walks. `comm` may be
 * an absolute path (shim-launched), so basename it. Memoized for {@link PROCESS_TABLE_FRESH_MS} so
 * one scan and quiet re-polls share a snapshot (#2047). */
async function readProcessTable(): Promise<ProcRow[]> {
  const now = activeScanNow();
  if (processTableCache && now - processTableCache.at < PROCESS_TABLE_FRESH_MS) {
    return processTableCache.rows;
  }
  const rows = await readProcessTableLive();
  processTableCache = { at: now, rows };
  return rows;
}

async function readProcessTableLive(): Promise<ProcRow[]> {
  processTableLiveReads += 1;
  if (process.platform === 'win32') return readProcessTableWin32();
  let out: string;
  try {
    ({ stdout: out } = await execFileAsync('ps', ['-A', '-o', 'pid=,ppid=,tty=,lstart=,comm='], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, timeout: PS_SNAPSHOT_TIMEOUT_MS }));
  } catch {
    return [];
  }
  const rows: ProcRow[] = [];
  for (const line of out.split('\n')) {
    const m = line.trim().match(/^(\d+)\s+(\d+)\s+(\S+)\s+(\S+\s+\S+\s+\d+\s+\S+\s+\d+)\s+(.+)$/);
    if (!m) continue;
    const pid = parseInt(m[1], 10);
    const ppid = parseInt(m[2], 10);
    if (!Number.isFinite(pid) || !Number.isFinite(ppid)) continue;
    const ttyRaw = m[3];
    const tty = ttyRaw === '??' || ttyRaw === '?' || ttyRaw === '-' ? undefined : ttyRaw;
    const commRaw = m[5].trim();
    rows.push({ pid, ppid, tty, startTime: m[4], comm: commRaw, kind: agentKindFromComm(commRaw) });
  }
  return rows;
}

/** Windows process table in one CIM query (`wmic` is removed on current Windows 11); same
 * pid/ppid/comm shape as POSIX; `Name` is the image name (`claude.exe`). */
async function readProcessTableWin32(): Promise<ProcRow[]> {
  let out: string;
  try {
    ({ stdout: out } = await execFileAsync('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-Command',
      'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name | ConvertTo-Csv -NoTypeInformation',
    ], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, windowsHide: true, timeout: PS_SNAPSHOT_TIMEOUT_MS }));
  } catch {
    return [];
  }
  return parseWin32ProcessCsv(out);
}

export function parseWin32ProcessCsv(out: string): ProcRow[] {
  const rows: ProcRow[] = [];
  for (const line of out.split(/\r?\n/)) {
    const m = line.trim().match(/^"(\d+)","(\d+)","(.*)"$/);
    if (!m) continue;
    const pid = parseInt(m[1], 10);
    const ppid = parseInt(m[2], 10);
    if (!Number.isFinite(pid) || !Number.isFinite(ppid)) continue;
    const comm = m[3].replace(/""/g, '"');
    rows.push({ pid, ppid, comm, kind: agentKindFromComm(comm) });
  }
  return rows;
}

function childrenByParent(ppidMap: Map<number, number>): Map<number, number[]> {
  const children = new Map<number, number[]>();
  for (const [pid, ppid] of ppidMap) {
    const siblings = children.get(ppid);
    if (siblings) siblings.push(pid);
    else children.set(ppid, [pid]);
  }
  return children;
}

function terminalDescendantEntry(
  pid: number,
  processes: Map<number, ProcRow>,
  children: Map<number, number[]>,
): PidSessionEntry | undefined {
  if (process.platform === 'win32') return undefined;
  let pending = children.get(pid) ?? [];
  const seen = new Set([pid]);
  while (pending.length) {
    const next: number[] = [];
    let recordedAgent = false;
    let newest: PidSessionEntry | undefined;
    for (const child of pending) {
      if (seen.has(child)) continue;
      seen.add(child);
      const entry = readPidSessionEntry(child, processes.get(child)?.startTime);
      const agent = entry?.agent || processes.get(child)?.kind;
      if (!entry || !agent || !isSessionTrackedAgent(agent)) {
        next.push(...(children.get(child) ?? []));
        continue;
      }
      recordedAgent = true;
      if (entry.sessionId && (!newest || entry.startedAtMs > newest.startedAtMs
        || (entry.startedAtMs === newest.startedAtMs && entry.pid > newest.pid))) newest = { ...entry, agent };
    }
    if (recordedAgent) return newest;
    pending = next;
  }
  return undefined;
}

/** True when any ancestor in pid's chain is a known attributed PID: VS Code/Cursor store the shell
 * PID in live-terminals.json while `ps` reports the child claude PID, so a direct lookup misses. */
function hasAttributedAncestor(pid: number, ppidMap: Map<number, number>, attributed: Set<number>): boolean {
  let cur: number | undefined = ppidMap.get(pid);
  const seen = new Set<number>();
  while (cur && cur > 1 && !seen.has(cur)) {
    if (attributed.has(cur)) return true;
    seen.add(cur);
    cur = ppidMap.get(cur);
  }
  return false;
}

/** Resolve every candidate PID's cwd, bounded and staggered so probes are not one system-wide
 * `lsof` burst (a behavioral-EDR recon trigger). Order matches `pids`; `probe` is injectable for
 * testing. */
export function resolveCwds(
  pids: number[],
  probe: (pid: number) => Promise<string | undefined> = getCwdForPid,
): Promise<(string | undefined)[]> {
  return mapBounded(pids, probe, { concurrency: LSOF_CONCURRENCY, staggerMs: LSOF_STAGGER_MS });
}

/** Resolve a process's cwd via `lsof`. `-a` ANDs the filters; without it macOS treats `-p` and `-d`
 * as a union and returns every process's cwd. */
async function getCwdForPid(pid: number): Promise<string | undefined> {
  if (process.platform === 'win32') return undefined;
  let out: string;
  try {
    const res = await execFileAsync('lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn'], {
      encoding: 'utf8',
      timeout: LSOF_TIMEOUT_MS,
    });
    out = res.stdout;
  } catch {
    return undefined;
  }
  for (const line of out.split('\n')) {
    if (line.startsWith('n')) return line.slice(1);
  }
  return undefined;
}

/** Walk a pid's ancestors and return the most specific host app: each HOST_MATCHERS entry is
 * checked in order, so IDEs beat terminal apps beat multiplexers. Undefined means true headless. */
function detectHost(pid: number, procByPid: Map<number, ProcRow>): string | undefined {
  const chain: string[] = [];
  let cur: number | undefined = procByPid.get(pid)?.ppid;
  const seen = new Set<number>();
  while (cur && cur > 1 && !seen.has(cur)) {
    const row = procByPid.get(cur);
    if (!row) break;
    chain.push(row.comm);
    seen.add(cur);
    cur = row.ppid;
  }

  for (const { host, tokens } of HOST_MATCHERS) {
    if (chain.some(c => tokens.some(t => c.includes(t)))) return host;
  }
  return undefined;
}

/** Resolve the host app for one pid by walking ancestry with the `detectHost` logic. Reads the
 * whole process table per call, so use it only on the low-cardinality renderer path. Exported for
 * the "viewing in <app>" resolver. */
export async function hostFromPid(pid: number): Promise<string | undefined> {
  if (!pid || pid < 1) return undefined;
  const procByPid = new Map<number, ProcRow>();
  for (const r of await readProcessTable()) procByPid.set(r.pid, r);
  return detectHost(pid, procByPid);
}

const UI_HOSTS = new Set<string>([
  'code', 'cursor', 'codium', 'windsurf',
  'iterm', 'terminal', 'warp', 'alacritty', 'kitty', 'hyper', 'wezterm', 'ghostty',
  'tmux', 'screen',
]);

export interface AgentCandidate { pid: number; kind: string; }

/** Find the launch registry entry recorded by a wrapper of this process: on Windows the `.cmd` path
 * makes the recorded pid a cmd.exe intermediary, so the entry is one ancestor up. The nearest
 * entry wins only if its agent kind matches (claude shelling out to codex must not lend identity). */
export function readAncestorSessionEntry(
  pid: number,
  ppidMap: Map<number, number>,
  kind: string,
  readEntry: (pid: number) => PidSessionEntry | undefined = readPidSessionEntry,
): PidSessionEntry | undefined {
  let cur = ppidMap.get(pid);
  const seen = new Set<number>();
  while (cur && cur > 1 && !seen.has(cur)) {
    const entry = readEntry(cur);
    if (entry) return entry.agent === kind ? entry : undefined;
    seen.add(cur);
    cur = ppidMap.get(cur);
  }
  return undefined;
}

/** Collapse agent processes spawned by a live agent of the same kind onto their nearest kept
 * ancestor (Claude runs subagents and forks as child `claude` processes). Kept: own registry
 * entry, live `--session-id` argv (RUSH-2384), different agent kind. */
export function foldSubordinateAgents(
  candidates: AgentCandidate[],
  ppidMap: Map<number, number>,
  readEntry: (pid: number) => PidSessionEntry | undefined,
  hasLiveSessionId: (pid: number) => boolean = (pid) => sessionIdFromLivePid(pid) != null,
): { kept: AgentCandidate[]; foldedByRoot: Map<number, number> } {
  const kindByPid = new Map(candidates.map(c => [c.pid, c.kind]));

  const nearestSameKindAncestor = (pid: number, kind: string): number | undefined => {
    let cur = ppidMap.get(pid);
    const seen = new Set<number>();
    while (cur && cur > 1 && !seen.has(cur)) {
      if (kindByPid.get(cur) === kind) return cur;
      seen.add(cur);
      cur = ppidMap.get(cur);
    }
    return undefined;
  };

  // Own launch identity: a matching-kind registry entry on the candidate or a wrapper below the
  // fold target; entries above belong to that ancestor. A live `--session-id` on argv also counts
  // (RUSH-2384): the registry is often empty.
  const hasOwnSession = (c: AgentCandidate, stopPid: number): boolean => {
    if (readEntry(c.pid)?.agent === c.kind) return true;
    if (hasLiveSessionId(c.pid)) return true;
    let cur = ppidMap.get(c.pid);
    const seen = new Set<number>();
    while (cur && cur > 1 && cur !== stopPid && !seen.has(cur)) {
      if (readEntry(cur)?.agent === c.kind) return true;
      seen.add(cur);
      cur = ppidMap.get(cur);
    }
    return false;
  };

  const keptPids = new Set<number>();
  for (const c of candidates) {
    const foldTarget = nearestSameKindAncestor(c.pid, c.kind);
    if (foldTarget === undefined || hasOwnSession(c, foldTarget)) {
      keptPids.add(c.pid);
    }
  }

  const kept: AgentCandidate[] = [];
  const foldedByRoot = new Map<number, number>();
  for (const c of candidates) {
    if (keptPids.has(c.pid)) { kept.push(c); continue; }
    let cur = nearestSameKindAncestor(c.pid, c.kind);
    const seen = new Set<number>();
    while (cur !== undefined && !keptPids.has(cur) && !seen.has(cur)) {
      seen.add(cur);
      cur = nearestSameKindAncestor(cur, c.kind);
    }
    if (cur === undefined || !keptPids.has(cur)) { kept.push(c); continue; }
    foldedByRoot.set(cur, (foldedByRoot.get(cur) ?? 0) + 1);
  }
  return { kept, foldedByRoot };
}

/** Agent processes not attributed to a team or the runtime registry, classified by ppid chain: a
 * recognised UI ancestor means `terminal`, otherwise `headless`. Full `ps`+`lsof` rescans are
 * throttled to {@link UNATTRIBUTED_RESCAN_MS} (#2047); a shrinking attributed set forces a rescan. */
export async function listUnattributedActive(attributed: Set<number>): Promise<ActiveSession[]> {
  const now = activeScanNow();
  if (
    unattributedCache &&
    now - unattributedCache.at < UNATTRIBUTED_RESCAN_MS &&
    !attributedSetLostPids(unattributedCache.attributed, attributed)
  ) {
    return filterCachedUnattributed(unattributedCache.sessions, attributed, isPidAlive, unattributedCache.ppidMap);
  }
  const result = await listUnattributedActiveLive(attributed);
  unattributedCache = { at: now, attributed: new Set(attributed), ...result };
  return result.sessions;
}

async function listUnattributedActiveLive(attributed: Set<number>): Promise<{ sessions: ActiveSession[]; ppidMap: Map<number, number> }> {
  unattributedFullRescans += 1;
  const table = await readProcessTable();
  const procByPid = new Map<number, ProcRow>();
  const ppidMap = new Map<number, number>();
  for (const r of table) {
    procByPid.set(r.pid, r);
    ppidMap.set(r.pid, r.ppid);
  }

  const candidates: AgentCandidate[] = [];
  for (const { pid, kind } of table) {
    if (!kind) continue;
    if (attributed.has(pid)) continue;
    if (hasAttributedAncestor(pid, ppidMap, attributed)) continue;
    candidates.push({ pid, kind });
  }

  const { kept, foldedByRoot } = foldSubordinateAgents(candidates, ppidMap, readPidSessionEntry);

  const cwds = await resolveCwds(kept.map(c => c.pid));

  // Scan the hook state dir at most once per active-scan and invert the ppid map at most once,
  // lazily on the first candidate lacking an exact launch-time id, so the ~3s poll does not redo
  // it per candidate.
  let hookIndex: HookSessionIndex | undefined;
  let children: Map<number, number[]> | undefined;
  // Durable `agents run --name` handles keyed by session id, the same source the terminal path
  // uses for names. Headless agents have no label or /rename, so a `--name`d run would show only a
  // topic. Built once per scan.
  const runNameMap = buildRunNameMap();
  const ensureChildren = (): Map<number, number[]> => children ??= childrenByParent(ppidMap);

  const out: ActiveSession[] = [];
  for (let i = 0; i < kept.length; i++) {
    const { pid, kind } = kept[i];
    // The per-pid registry (from `ag run` and the shim delegate) gives the exact session id, so N
    // agents in one cwd resolve to N sessions instead of collapsing onto the newest .jsonl. The
    // entry may sit on a wrapper ancestor (Windows .cmd); absent entirely means heuristic.
    const entry = readPidSessionEntry(pid) ?? readAncestorSessionEntry(pid, ppidMap, kind);
    // Exact session id, in priority: (1) the id recorded at launch; (2) live argv `--session-id`
    // (RUSH-2384); (3) the agent's own SessionStart hook, kind-guarded against a stale reused-pid
    // file; (4) newest-jsonl heuristic.
    let exactId = entry?.sessionId ?? sessionIdFromLivePid(pid);
    let hookRec: HookSessionRecord | undefined;
    if (!exactId) {
      hookIndex ??= loadHookSessionIndex();
      hookRec = resolveHookSessionRecord(hookIndex, {
        pid,
        kind,
        launchId: entry?.launchId,
        terminalId: entry?.terminalId,
        childPids: ensureChildren().get(pid),
      });
      exactId = hookRec?.session_id;
    }
    // RUSH-2501: the hook-sessions index is populated only by @agents/session-tracker, which most
    // fleet machines lack. The deployed SessionStart hook writes state/sessions/<pid>.json, so try
    // that when the index finds nothing (cursor/grok/kimi/droid have no --session-id argv).
    if (!exactId) {
      const stateRec = readStateSessionRecord(pid, entry?.startedAtMs);
      if (stateRec) exactId = stateRec.session_id;
    }
    const cwd = cwds[i] ?? entry?.cwd ?? undefined;
    const sessionFile = findSessionFileForKind(kind, cwd, exactId);
    const topic = sessionFile ? quickExtractTopic(sessionFile) : undefined;
    const host = detectHost(pid, procByPid);
    const context: ActiveContext = host && UI_HOSTS.has(host) ? 'terminal' : 'headless';
    const { state, tokPerSec } = computeLiveSignals(kind, sessionFile, cwd, true);
    const { birthtimeMs, mtimeMs } = sessionFileTimes(sessionFile);
    // Durable run name from `agents run --name`, resolved by session id: a headless row has no
    // /rename or live-terminals label, so this handle is its label (mirrors listTeamsActive).
    // Without a `--name`, label stays undefined and display uses the topic.
    const resolvedId = exactId ?? sessionIdFromFile(sessionFile);
    const name = resolvedId ? runNameMap.get(resolvedId) ?? undefined : undefined;
    const label = name;
    out.push(applyState({
      context,
      kind,
      harness: entry?.harness,
      host,
      tty: procByPid.get(pid)?.tty,
      pid,
      cwd,
      sessionId: resolvedId,
      label,
      name,
      topic,
      tokPerSec,
      sessionFile,
      startedAtMs: hookRec?.ts ?? birthtimeMs,
      lastActivityMs: mtimeMs,
      pidCount: 1 + (foldedByRoot.get(pid) ?? 0),
      owner: resolveOwner(entry?.actor, resolvedId),
      launchId: entry?.launchId ?? hookRec?.launch_id,
      terminalId: entry?.terminalId ?? hookRec?.terminal_id,
    }, state, sessionFile, true));
  }
  prunePidSessionRegistry(isPidAlive);
  return { sessions: out, ppidMap };
}

interface PaneIdentity {
  agent: string;
  harness?: string;
  sessionId?: string;
  pid?: number;
}

/** Attribute one tmux pane to the agent running in it. The launch registry, stamped with the
 * `tmuxPane` it targeted, is the exact source, so an agent in a split gets its own launch.
 * Session-meta labels are the fallback for the wrapped origin pane only. Pure. */
export function resolvePaneIdentity(
  pane: string,
  sessName: string,
  meta: { labels?: Record<string, string>; source?: string; pane?: string } | null,
  liveEntry: PidSessionEntry | undefined,
  getHookIndex: () => HookSessionIndex,
  nameToFullId: Map<string, string>,
): PaneIdentity | undefined {
  if (meta?.source === 'teams') return undefined;
  // The tmux session name encodes the agent kind (all ag-* panes) and, when the id was known at
  // creation (Claude), the session-id prefix, already resolved to a full UUID in the batch map. It
  // is the last-resort id source when meta/pid-reg/hook are missing (~3% populated fleet-wide).
  const nameAgent = agentKindFromName(sessName);
  const nameSessionId = nameToFullId.get(sessName);
  if (liveEntry) {
    // Exact id: the id recorded at launch (Claude), else the agent's SessionStart hook joined by
    // launchId/terminalId (kind-guarded against a stale reused-pid file), else the id in the
    // pane's tmux name.
    const sessionId = liveEntry.sessionId
      ?? resolveHookSessionRecord(getHookIndex(), {
        pid: liveEntry.pid,
        kind: liveEntry.agent,
        launchId: liveEntry.launchId,
        terminalId: liveEntry.terminalId,
      })?.session_id
      ?? nameSessionId;
    return { agent: liveEntry.agent, harness: liveEntry.harness, sessionId, pid: liveEntry.pid };
  }
  // No live-registry entry: prefer session-meta labels (the wrapped-origin fallback), then the
  // pane name, so a pane with neither still resolves instead of being dropped and mis-attributed
  // by the ps-scan.
  const agent = meta?.labels?.agent;
  const sessionId = meta?.labels?.sessionId;
  if (agent && sessionId && (meta?.pane == null || meta.pane === pane)) return { agent, sessionId };
  if (nameAgent) return { agent: nameAgent, sessionId: nameSessionId };
  return undefined;
}

/** Agents hosted in the shared-socket tmux server, the authoritative source for tmux-hosted spawns.
 * Each pane is attributed via {@link resolvePaneIdentity}: launch registry first, session meta
 * second. The exact `%pane` survives a stale extension registry. */
export async function listTmuxAgentSessions(): Promise<ActiveSession[]> {
  const { getDefaultSocketPath } = await import('../tmux/paths.js');
  const { readSessionMeta } = await import('../tmux/session.js');
  const { runTmux } = await import('../tmux/binary.js');
  const socket = getDefaultSocketPath();
  if (!fs.existsSync(socket)) return [];

  let res;
  try {
    res = await runTmux({
      socket,
      args: ['list-panes', '-a', '-F', ['#{pane_id}', '#{session_name}', '#{pane_pid}', '#{pane_dead}', '#{pane_current_path}'].join(TMUX_FIELD_SEP)],
      throwOnError: false,
      // A wedged tmux server must not hang the whole scan. The catch below turns a timeout into a
      // DEGRADED-tmux signal while other sources still report, instead of collapsing into the same
      // silent `[]` as an idle socket (RUSH-2507).
      timeoutMs: TMUX_LIST_PANES_TIMEOUT_MS,
    });
  } catch (err) {
    throw new TmuxDiscoveryDegradedError(
      `tmux list-panes on ${socket} did not answer: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (res.code !== 0) {
    throw new TmuxDiscoveryDegradedError(
      `tmux list-panes on ${socket} exited ${res.code}: ${res.stderr.trim() || res.stdout.trim()}`,
    );
  }

  const liveByPane = new Map<string, PidSessionEntry>();
  for (const recorded of listPidSessionEntries()) {
    const e = readPidSessionEntry(recorded.pid);
    if (!e?.tmuxPane) continue;
    const prev = liveByPane.get(e.tmuxPane);
    if (!prev || e.startedAtMs > prev.startedAtMs) liveByPane.set(e.tmuxPane, e);
  }
  let hookIndex: HookSessionIndex | undefined;
  const getHookIndex = (): HookSessionIndex => (hookIndex ??= loadHookSessionIndex());

  // Resolve every `ag-<agent>-<shortid>` pane name to its full session UUID in one batched DB
  // round-trip; the pane name is the id signal present on every ag-* pane when durable identity
  // stores are empty.
  const nameToFullId = resolveNamesToSessionIds(
    res.stdout.split('\n').map((l) => l.split(TMUX_FIELD_SEP)[1]).filter((n): n is string => !!n),
    { findSessionsByShortIds },
  );

  const out: ActiveSession[] = [];
  const seen = new Set<string>();
  for (const line of res.stdout.split('\n')) {
    if (!line.trim()) continue;
    const parts = line.split(TMUX_FIELD_SEP);
    const [pane, sessName, pidRaw, paneDeadRaw] = parts;
    const curPath = parts.slice(4).join(TMUX_FIELD_SEP);
    if (!pane || !sessName) continue;
    const meta = readSessionMeta(sessName);
    const liveEntry = liveByPane.get(pane);
    let id = resolvePaneIdentity(pane, sessName, meta, liveEntry, getHookIndex, nameToFullId);
    if (!id) continue;
    // RUSH-2007 Layer A: a non-Claude tmux session whose id came from neither the launch registry
    // nor the undeployed session-tracker is backfilled from the deployed hook's
    // state/sessions/<pid>.json, freshness-guarded against reused pids.
    if (!id.sessionId) {
      const panePid = parseInt(pidRaw, 10) || undefined;
      const backfilled =
        (panePid ? readStateSessionRecord(panePid, liveEntry?.startedAtMs)?.session_id : undefined)
        ?? (liveEntry ? readStateSessionRecord(liveEntry.pid, liveEntry.startedAtMs)?.session_id : undefined);
      if (backfilled) id = { ...id, sessionId: backfilled };
    }
    if (id.sessionId && shortIdFromName(sessName)) {
      writeSessionAliasRecord(id.sessionId, sessName);
    }
    const dedupKey = id.sessionId ?? pane;
    if (seen.has(dedupKey)) continue;
    seen.add(dedupKey);

    const pid = id.pid ?? (parseInt(pidRaw, 10) || undefined);
    const cwd = liveEntry?.cwd ?? meta?.cwd ?? (curPath || undefined);
    // Resolve a transcript only when the session id is known: with no id, findSessionFileForKind
    // falls back to the newest .jsonl in the cwd and collapses co-located panes onto one
    // stranger's transcript (the xN-badge bug). An id-less pane surfaces as its own row.
    const sessionFile = id.sessionId ? findSessionFileForKind(id.agent, cwd, id.sessionId) : undefined;
    const topic = sessionFile ? quickExtractTopic(sessionFile) : undefined;
    const paneDead = paneDeadRaw === '1';
    const pidAlive = !paneDead && (pid ? isPidAlive(pid, liveEntry?.startedAtMs) : true);
    const { state, tokPerSec } = computeLiveSignals(id.agent, sessionFile, cwd, pidAlive);
    const { birthtimeMs, mtimeMs } = sessionFileTimes(sessionFile);
    // The mux/reply rails are known exactly here (the pane is a tmux pane). `transport:'local'` is
    // only a placeholder; enrichProvenance later reads the pane process's env and upgrades it to
    // 'ssh' when SSH_CONNECTION is present, keeping this mux/reply.
    const provenance: SessionProvenance = {
      host: os.hostname(),
      transport: 'local',
      mux: { kind: 'tmux', socket, pane },
      reply: { rail: 'tmux', target: pane, socket },
    };
    out.push(applyState({
      context: 'terminal',
      kind: id.agent,
      harness: id.harness,
      host: 'tmux',
      pid,
      sessionId: id.sessionId ?? sessionIdFromFile(sessionFile),
      cwd,
      topic,
      tokPerSec,
      sessionFile,
      startedAtMs: liveEntry?.startedAtMs ?? birthtimeMs,
      lastActivityMs: mtimeMs,
      provenance,
      owner: resolveOwner(liveEntry?.actor, id.sessionId ?? sessionIdFromFile(sessionFile)),
      launchId: liveEntry?.launchId,
      terminalId: liveEntry?.terminalId,
      paneId: id.sessionId ?? sessionIdFromFile(sessionFile) ? undefined : pane,
      tmuxName: sessName,
    }, state, sessionFile, pidAlive));
  }
  return out;
}

/** Union of all sources. Teams and terminals spawn CLI processes that also show in `ps`, so
 * headless attribution runs last with attributed PIDs removed. The tmux source goes first into the
 * dedupe so its row (exact `%pane`) wins over a staler terminal/headless row. */
export async function getActiveSessions(opts: ActiveQueryOptions = {}): Promise<ActiveSession[]> {
  if (!writerProcessView()) {
    const { loadLocalActiveSessions } = await import('./session-cache.js');
    return (await loadLocalActiveSessions()).sessions;
  }
  const [tmuxAgents, teams, terminals, cloud] = await Promise.all([
    listTmuxAgentSessions().catch(() => [] as ActiveSession[]),
    listTeamsActive({ localOnly: opts.localOnly }).catch(() => [] as ActiveSession[]),
    listTerminalsActive().catch(() => [] as ActiveSession[]),
    Promise.resolve(listCloudActive()),
  ]);

  const knownPids = new Set<number>();
  for (const s of tmuxAgents) if (s.pid) knownPids.add(s.pid);
  for (const s of teams) if (s.pid) knownPids.add(s.pid);
  for (const s of terminals) if (s.pid) knownPids.add(s.pid);

  const unattributed = opts.skipHeadless ? [] : await listUnattributedActive(knownPids);

  const merged = dedupeBySession([...tmuxAgents, ...teams, ...terminals, ...cloud, ...unattributed]);
  await enrichProvenance(merged);
  await resolveOrigins(merged);
  foldPresence(merged);
  await foldTmuxClients(merged);
  foldHostLink(merged);
  foldExecutionMachine(merged, recordedMachineLookup(merged), machineId());
  annotateOrchestratorLabels(merged);
  foldRecap(merged);
  foldPhase(merged);
  return merged;
}

interface ActiveDiscoveryHealth {
  degradedSources: string[];
}

/** Post-hoc health probe for local discovery sources. `getActiveSessions` swallows source failures
 * to `[]`; this re-probes and reports which threw, so an empty result can be told from a failed
 * source (RUSH-2507). Empty-result branch only: it repeats a `list-panes` call. */
export async function describeActiveDiscoveryHealth(): Promise<ActiveDiscoveryHealth> {
  const degradedSources: string[] = [];
  try {
    await listTmuxAgentSessions();
  } catch (err) {
    if (err instanceof TmuxDiscoveryDegradedError) degradedSources.push('tmux');
  }
  return { degradedSources };
}

/** True when a live agent process on this host carries `--session-id <id>` in its argv. RUSH-2384
 * last resort for `agents message`: getActiveSessions can miss a row, but the process table is
 * ground truth. Only UUID-shaped ids are accepted so a prefix never false-matches. */
export async function isSessionIdLiveOnProcessTable(
  sessionId: string,
  deps: {
    readTable?: () => Promise<Array<{ pid: number; kind?: string }>>;
    sessionIdOf?: (pid: number) => string | undefined;
  } = {},
): Promise<boolean> {
  if (!isSessionIdShape(sessionId)) return false;
  const readTable = deps.readTable ?? (async () => readProcessTable());
  const sessionIdOf = deps.sessionIdOf ?? sessionIdFromLivePid;
  for (const row of await readTable()) {
    if (!row.kind) continue;
    if (sessionIdOf(row.pid) === sessionId) return true;
  }
  return false;
}

/** Fold tmux's attached-client count onto every tmux-hosted row, keyed off `provenance.mux`, not
 * {@link listTmuxAgentSessions}, which emits nothing where identity does not resolve. A failed
 * query leaves the count undefined, never zero. */
export async function foldTmuxClients(rows: ActiveSession[]): Promise<void> {
  const tmuxRows = rows.filter((s) => s.provenance?.mux?.kind === 'tmux' && s.provenance.mux.pane);
  if (tmuxRows.length === 0) return;
  const { runTmux } = await import('../tmux/binary.js');
  const sockets = new Set(tmuxRows.map((s) => s.provenance!.mux!.socket));
  for (const socket of sockets) {
    const byPane = new Map<string, number>();
    try {
      const res = await runTmux({
        socket,
        args: ['list-panes', '-a', '-F', `#{pane_id}${TMUX_FIELD_SEP}#{session_attached}`],
        throwOnError: false,
      });
      if (res.code !== 0) continue;
      for (const line of res.stdout.split('\n')) {
        const [pane, attached] = line.split(TMUX_FIELD_SEP);
        if (!pane) continue;
        const n = parseInt(attached ?? '', 10);
        if (Number.isFinite(n)) byPane.set(pane, n);
      }
    } catch {
      continue;
    }
    for (const s of tmuxRows) {
      if (s.provenance!.mux!.socket !== socket) continue;
      const n = byPane.get(s.provenance!.mux!.pane!);
      if (n !== undefined) s.tmuxClients = n;
    }
  }
}

/** Fold the host link onto each row and, where it changes the answer, the status. Runs after {@link
 * foldPresence}: a backgrounded session has no client by design. `abandoned` wins; `crashed`
 * replaces `closed`; `orphaned` replaces idle/input_required; `running` only on `hostWindowLost`. */
/** Attribute each live row to the machine the session executes on (RUSH-2479). A host-dispatched
 * run leaves the ssh/TTY shim on the dispatching box, so the row was tagged with this machine.
 * Folds the index's recorded machine onto the row; peer-attributed rows are left alone. Pure. */
export function foldExecutionMachine(
  rows: ActiveSession[],
  machineOf: (sessionId: string) => string | undefined,
  self: string,
): void {
  for (const s of rows) {
    if (!s.sessionId) continue;
    if (s.machine && s.machine !== self) continue;
    const recorded = machineOf(s.sessionId);
    if (!recorded || recorded === self) continue;
    s.machine = recorded;
    s.offloadedFrom = self;
  }
}

/** Is the process behind this row running on this machine? `machine` is where the agent executes;
 * for an offloaded run the shim, tmux pane and window stay here (`offloadedFrom`). Callers needing
 * a local pid, pane or window must ask this. */
export function sessionProcessIsLocal(s: Pick<ActiveSession, 'machine' | 'offloadedFrom'>, self: string): boolean {
  // `offloadedFrom` names which box holds the shim, so compare it, don't just test it. Rows travel
  // via `--active --json` and the fan-out, so a third box sees `{machine: B, offloadedFrom: A}`;
  // answering "local" would send A's pane id to an unrelated pane on C.
  if (s.offloadedFrom) return s.offloadedFrom === self;
  return !s.machine || s.machine === self;
}

/** The machine to reach for this session's process (pid, tmux pane, window), or `undefined` when it
 * is here. Not `machine`: for an offloaded run the process lives on the dispatcher
 * (`offloadedFrom`), so ssh'ing to `machine` would carry its pane id to a box that never had it. */
export function sessionProcessHost(
  s: Pick<ActiveSession, 'machine' | 'offloadedFrom'>,
  self: string,
): string | undefined {
  if (sessionProcessIsLocal(s, self)) return undefined;
  return s.offloadedFrom ?? s.machine;
}

/** The index lookup behind {@link foldExecutionMachine}: one batched query for every live row
 * (`findSessionMachinesByIds`), since getActiveSessions is polled by the daemon, menubar and
 * watchdog. Best-effort: an unavailable DB yields an empty map. */
function recordedMachineLookup(rows: ActiveSession[]): (sessionId: string) => string | undefined {
  const byId = findSessionMachinesByIds(rows.map((s) => s.sessionId).filter((id): id is string => !!id));
  return (id) => byId.get(id);
}

export function foldHostLink(rows: ActiveSession[]): void {
  for (const s of rows) {
    if (s.context === 'cloud') continue;
    if (s.status === 'abandoned') continue;
    const signals = {
      pidAlive: s.status !== 'closed',
      windowHeartbeatMs: s.windowHeartbeatMs,
      tmuxClients: s.tmuxClients,
      deliberatelyDetached: s.presence === 'background' || s.presence === 'parked',
    };
    const link = classifyHostLink(signals);
    s.hostLink = link;
    // `foldPresence` gives every terminal row a derived `attached`, which a lost host disproves; a
    // stored record is never `attached`, so clearing only that is safe. Only a positive loss
    // signal does so: `unknown` means we never looked and must not clear presence.
    if ((link === 'no-client' || link === 'host-gone') && s.presence === 'attached') {
      s.presence = undefined;
    }
    if (link === 'host-gone' && s.status === 'closed') s.status = 'crashed';
    else if (link === 'no-client' && (s.status === 'idle' || s.status === 'input_required')) {
      s.status = 'orphaned';
    }
    // A still-`running` agent is normally a healthy headless run, so 0 tmux clients must not flag
    // it (false positive reverted in 6d973b823). The one exception is a lost window: its IDE
    // stopped republishing, so it died uncleanly and the agent is stranded (PHNX-3183, SES-18a).
    else if (s.status === 'running' && hostWindowLost(signals)) {
      s.status = 'orphaned';
    }
  }
}

function recapLine(s: string | undefined, max = 120): string | undefined {
  const t = s?.replace(/\s+/g, ' ').trim();
  if (!t) return undefined;
  return t.length > max ? t.slice(0, max - 1).trimEnd() + '…' : t;
}

/** The headline ladder (PHNX-3797): `/rename` label, then daemon-generated title, then the
 * classified user prompt. The prompt rung classifies the raw latest user turn, not the collapsed
 * `topic` (PHNX-3939). The agent's last line is deliberately not a rung. */
export function deriveSessionRecap(
  row: Pick<ActiveSession, 'label' | 'generatedTitle' | 'topic' | 'tail' | 'firstUserMessage' | 'lastUserMessage' | 'attachments' | 'request'>,
): {
  title?: string;
  recapSource?: RecapSource;
  userPromptClean?: string;
  userPromptKind?: UserPromptKind;
  lastAgentLine?: string;
  request?: SessionRequest;
} {
  const lastAgentLine = recapLine(row.tail?.length ? row.tail[row.tail.length - 1] : undefined);
  const raw = row.lastUserMessage ?? row.firstUserMessage ?? row.topic ?? '';
  const tidied = row.request ?? tidyRequest(raw, { attachments: row.attachments });
  const fallback = tidied ? undefined : classifyUserPrompt(row.topic ?? '', {
    hasImageAttachment: row.attachments?.some((a) => a.mediaType?.startsWith('image/')),
  });
  const userPromptClean = tidied?.headline ?? fallback?.clean;
  const userPromptKind = tidied?.kind ?? fallback?.kind;

  const label = recapLine(row.label);
  const generated = recapLine(row.generatedTitle);
  const prompt = recapLine(userPromptClean || row.topic);

  let title: string | undefined;
  let recapSource: RecapSource | undefined;
  if (label) { title = label; recapSource = 'label'; }
  else if (generated) { title = generated; recapSource = 'generated'; }
  else if (prompt) { title = prompt; recapSource = 'prompt'; }

  return {
    title,
    recapSource,
    userPromptClean: recapLine(userPromptClean),
    userPromptKind,
    lastAgentLine,
    ...(tidied ? { request: tidied } : {}),
  };
}

/** The row's secondary line (PHNX-3797): the most important recent agent message, ranked pending
 * question, then needs-you wait, then current activity. `undefined` only when nothing recent
 * exists. Pure; folded on by {@link applyRecap}. */
export function deriveImportantMessage(
  row: Pick<ActiveSession, 'status' | 'activity' | 'awaitingReason' | 'question' | 'preview' | 'lastAgentLine'>,
): SessionImportantMessage | undefined {
  const recent = recapLine(row.preview) ?? row.lastAgentLine;

  if (row.awaitingReason === 'question' || row.question) {
    const text = recapLine(row.question?.text) ?? recent;
    if (text) return { text, kind: 'question' };
  }

  const needsYou = row.awaitingReason === 'plan_review'
    || row.awaitingReason === 'permission'
    || row.status === 'input_required'
    || row.activity === 'waiting_input';
  if (needsYou) {
    const fallback = row.awaitingReason === 'plan_review'
      ? 'Waiting on plan review'
      : row.awaitingReason === 'permission'
        ? 'Waiting on a permission decision'
        : 'Waiting for you';
    return { text: recent ?? fallback, kind: 'needs_you' };
  }

  if (recent) return { text: recent, kind: 'activity' };
  return undefined;
}

function applyRecap(s: ActiveSession): void {
  const recap = deriveSessionRecap(s);
  s.title = recap.title;
  s.recapSource = recap.recapSource;
  s.userPromptClean = recap.userPromptClean;
  s.userPromptKind = recap.userPromptKind;
  s.lastAgentLine = recap.lastAgentLine;
  if (recap.request) s.request = recap.request;
  s.importantMessage = deriveImportantMessage(s);
}

export function foldRecap(rows: ActiveSession[]): void {
  for (const s of rows) applyRecap(s);
}

/** Project a {@link SessionPhase} from the finalized {@link ActiveStatus} (PHNX-2484), the single
 * source AGI EXT used to mirror. `queued` is `running`. `abandoned`, `orphaned` and `crashed`
 * bucket to `failed`; a status-only map sent them to `idle` and hid a dead agent. */
export function derivePhase(status: ActiveStatus | undefined): SessionPhase {
  switch (status) {
    case 'running':
    case 'queued':
      return 'running';
    case 'input_required':
      return 'waiting';
    case 'abandoned':
    case 'orphaned':
    case 'crashed':
      return 'failed';
    case 'closed':
      return 'done';
    case 'idle':
    case 'unknown':
    default:
      return 'idle';
  }
}

export function foldPhase(rows: ActiveSession[]): void {
  for (const s of rows) s.phase = derivePhase(s.status);
}

export function isReapableOrphan(
  row: Pick<ActiveSession, 'status' | 'pidAlive'>,
): boolean {
  return row.status === 'abandoned' && row.pidAlive === false;
}

/** Resolve each teams row's `orchestratorLabel` from the orchestrator's own row when it is in the
 * active set; otherwise nothing, so the renderer shows the short id. Pure; exported for tests. */
export function annotateOrchestratorLabels(sessions: ActiveSession[]): void {
  const byId = new Map<string, ActiveSession>();
  for (const s of sessions) if (s.sessionId) byId.set(s.sessionId, s);
  for (const s of sessions) {
    if (!s.orchestratorSessionId) continue;
    const orch = byId.get(s.orchestratorSessionId);
    // ladder-exempt: pre-index team label, not a headline render.
    if (orch) s.orchestratorLabel = orch.label || orch.topic || undefined;
  }
}

/** Fold detach/attach presence from the detach store. A stored record wins (`background`/`parked`);
 * otherwise a live terminal session is `attached`. Ad-hoc headless and cloud/team rows stay
 * unmarked. */
function foldPresence(rows: ActiveSession[]): void {
  for (const s of rows) {
    if (!s.sessionId) continue;
    const stored = presenceFromStore(s.sessionId);
    if (stored) s.presence = stored;
    else if (s.context === 'terminal') s.presence = 'attached';
  }
}

/** Attach provenance (host, local-vs-SSH, tmux pane, reply rail) to every session with a live pid,
 * in place, after dedupe, at bounded concurrency. A row that already has provenance (tmux path) is
 * probe-and-merged: only the process env reveals the real SSH origin. */
export async function enrichProvenance(
  sessions: ActiveSession[],
  probe: (pid: number) => Promise<SessionProvenance | undefined> = detectProvenance,
): Promise<void> {
  await mapBounded(
    sessions,
    async (s) => {
      if (!s.pid) return;
      const probed = await probe(s.pid);
      if (!probed) return;
      if (!s.provenance) {
        s.provenance = probed;
        return;
      }
      if (probed.transport === 'ssh' && !s.provenance.ssh) {
        s.provenance.transport = 'ssh';
        s.provenance.ssh = probed.ssh;
      }
      if (probed.term && !s.provenance.term) s.provenance.term = probed.term;
    },
    { concurrency: LSOF_CONCURRENCY },
  );
}

/** Match an SSH client IP to a registered device (pure, testable with a plain registry object);
 * returns the device name and ssh login user for a known address. */
export function matchOriginDevice(
  clientIp: string,
  reg: DeviceRegistry,
): { device: string; user?: string } | undefined {
  for (const d of Object.values(reg)) {
    if (d.address?.ip && d.address.ip === clientIp) {
      return { device: d.name, ...(d.user ? { user: d.user } : {}) };
    }
  }
  return undefined;
}

/** Resolve the initiating device for every ssh-transport session by matching `ssh.clientIp` against
 * the device registry. Read-only, best-effort: an unloadable registry or unmatched IP leaves
 * `origin` undefined. Mutates in place. */
async function resolveOrigins(sessions: ActiveSession[]): Promise<void> {
  const needing = sessions.filter((s) => s.provenance?.ssh && !s.provenance.origin);
  if (needing.length === 0) return;
  let reg: DeviceRegistry;
  try {
    reg = await loadDevices();
  } catch {
    return;
  }
  for (const s of needing) {
    const match = matchOriginDevice(s.provenance!.ssh!.clientIp, reg);
    if (match) s.provenance!.origin = match;
  }
}

/** Identity for a row the scan could not tie to a session (daemon workers, e.g. an OpenClaw gateway
 * spawning `codex`): same binary + cwd + context, so N workers collapse to one row with `pidCount:
 * N`. Undefined without a cwd; keying on kind alone would fold unrelated agents. */
function anonymousWorkerKey(s: ActiveSession): string | undefined {
  if (!s.cwd) return undefined;
  return `anon\0${s.kind}\0${s.context}\0${s.cwd}`;
}

/** Collapse rows resolving to the same session (many subagent/fork PIDs on one transcript would
 * print dozens of identical rows). Keyed by session id, then transcript file, then cloud/run
 * handle, then {@link anonymousWorkerKey}. The first row wins and carries `pidCount`. */
export function dedupeBySession(sessions: ActiveSession[]): ActiveSession[] {
  const out: ActiveSession[] = [];
  const byKey = new Map<string, ActiveSession>();
  for (const s of sessions) {
    const key = s.sessionId || s.sessionFile || s.cloudTaskId || s.agentId || s.paneId || anonymousWorkerKey(s);
    if (!key) { out.push(s); continue; }
    const existing = byKey.get(key);
    if (existing) {
      existing.pidCount = (existing.pidCount ?? 1) + (s.pidCount ?? 1);
    } else {
      s.pidCount = s.pidCount ?? 1;
      byKey.set(key, s);
      out.push(s);
    }
  }
  return out;
}
