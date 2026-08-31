/**
 * Active-session detection across every context an agent can run in:
 *
 *   - `terminal` — agents launched from VS Code / Cursor / Codium via the
 *     agents-cli extension. Published to `~/.agents/.cache/terminals/live-terminals.json`
 *     with PID + session UUID per entry.
 *   - `teams`    — agents spawned by `agents teams add`, tracked in
 *     `~/.agents/teams/agents/<id>/meta.json` with a PID the manager polls.
 *   - `cloud`    — dispatched to Rush / Codex Cloud / Factory, tracked in
 *     the SQLite cache at `~/.agents/cloud/tasks.db`.
 *   - `headless` — bare `claude` / `codex` / `gemini` / `cursor-agent` /
 *     `opencode` processes that don't belong to any of the above. Detected
 *     by `ps` minus the PIDs we've already attributed.
 *
 * `running` vs `idle` is a secondary classification within the alive set:
 * the process is holding its session file, but the file's mtime is older
 * than ACTIVE_MTIME_WINDOW_MS, so it's probably waiting on the user.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execFile, execFileSync } from 'child_process';
import { promisify } from 'util';
import { listActiveTasks } from '../cloud/store.js';
import type { CloudTaskStatus } from '../cloud/types.js';
import { AgentManager } from '../teams/agents.js';
import { getTerminalsDir } from '../state.js';
import {
  readPidSessionEntry,
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
import { extractSessionTopic, classifyUserPrompt, type UserPromptKind } from './prompt.js';
import { readSessionTailWithRaw } from './tail.js';
import { parseSession } from './parse.js';
import { computeTokPerSec } from './throughput.js';
import { inferSessionState, type SessionState, type SessionActivity, type AwaitingReason, type StructuredQuestion, type TodoProgress, type DetectedPr, type DetectedWorktree, type DetectedTicket } from './state.js';
import { isSessionTrackedAgent, SESSION_AGENTS, AG_TMUX_NAME_RE, type SessionAgentId, type SessionAttachment, type SessionEvent, type SessionMeta } from './types.js';
import { AGENTS } from '../agents.js';
import { detectProvenance, type SessionProvenance } from './provenance.js';
import { loadDevices, type DeviceRegistry } from '../devices/registry.js';
import { machineId, normalizeHost } from '../machine-id.js';
import { presenceFromStore, type Presence } from './detached.js';
import { classifyHostLink, hostWindowLost, HOST_HEARTBEAT_STALE_MS, type HostLink } from './host-link.js';
import { mapBounded } from '../concurrency.js';
import { linearIssueUrl } from './linear.js';
import { viewingInLabel } from './viewing-in.js';
import { claudeProjectDirName } from '../project-key.js';

const execFileAsync = promisify(execFile);

/** Prefer live actor attribution; the durable sidecar survives actor-less hook rewrites. */
export function resolveOwner(pidActor: string | null | undefined, sessionId: string | undefined): string | undefined {
  return pidActor ?? (sessionId ? readSessionActorRecord(sessionId)?.actor : undefined) ?? undefined;
}

/**
 * Per-PID `lsof` probes run bounded and staggered rather than as one parallel
 * fan-out: a simultaneous system-wide `lsof` burst reads to behavioral EDR
 * (CrowdStrike Falcon) as lateral-movement recon. Results are identical — the
 * cwds are just gathered at a bounded spawn rate instead of a single burst.
 */
export const LSOF_CONCURRENCY = 4;
const LSOF_STAGGER_MS = 10;

/**
 * Hard ceilings on the two syscalls the status path shells out to. Without them
 * a single hung probe (a wedged NFS `lsof`, an EDR that stalls the `ps` snapshot)
 * pins a bounded worker slot forever and silently drops live sessions to a
 * fallback status. On timeout the call rejects, is caught, and the row degrades
 * honestly (unknown / empty table) instead of the sweep hanging.
 */
const LSOF_TIMEOUT_MS = 5_000;
const PS_SNAPSHOT_TIMEOUT_MS = 10_000;

/**
 * Process-local process-table memo (#2047). One `getActiveSessions` scan can
 * call `ps -A` from the terminal path, the headless path, and host ancestry —
 * without this, each is a full process-table snapshot. 5s is well under the
 * ~10–30s menu-bar / `--active` poll so a quiet re-poll usually reuses the
 * snapshot; a brand-new agent pid still appears on the next full refresh.
 */
export const PROCESS_TABLE_FRESH_MS = 5_000;

/**
 * How long {@link listUnattributedActive} may reuse its last full `ps`+`lsof`
 * result (#2047). Between full rescans the previous rows are re-emitted after
 * dropping dead PIDs and PIDs that are now attributed. A *shrinking* attributed
 * set forces a rescan so a process that just left teams/terminals can reappear
 * as headless instead of vanishing until the next cold poll.
 */
export const UNATTRIBUTED_RESCAN_MS = 15_000;

/** Injectable clock for the active-scan memos (tests only). */
let activeScanNow: () => number = () => Date.now();

/** Test seam: override the clock used by process-table / unattributed memos. */
export function setActiveScanClockForTest(fn?: () => number): void {
  activeScanNow = fn ?? (() => Date.now());
}

let processTableCache: { at: number; rows: ProcRow[] } | undefined;
let processTableLiveReads = 0;
let unattributedCache: {
  at: number;
  attributed: Set<number>;
  sessions: ActiveSession[];
} | undefined;
let unattributedFullRescans = 0;

/** Test seam: drop the process-table + unattributed memos and their counters. */
export function clearActiveScanCachesForTest(): void {
  processTableCache = undefined;
  processTableLiveReads = 0;
  unattributedCache = undefined;
  unattributedFullRescans = 0;
  activeScanNow = () => Date.now();
}

/** Test seam: how many times the live `ps` / CIM path actually ran. */
export function processTableLiveReadCountForTest(): number {
  return processTableLiveReads;
}

/** Test seam: how many full unattributed (ps + lsof) rescans ran. */
export function unattributedFullRescanCountForTest(): number {
  return unattributedFullRescans;
}

/**
 * True when any pid in `prev` is absent from `next` — the attributed set
 * shrank, so a process may need to reappear as unattributed. Pure for tests.
 */
export function attributedSetLostPids(prev: Set<number>, next: Set<number>): boolean {
  for (const p of prev) {
    if (!next.has(p)) return true;
  }
  return false;
}

/**
 * Drop rows whose pid is now attributed or no longer alive. Pure over the
 * inputs so the unattributed TTL reuse path is unit-testable without a live
 * process table. `alive` receives the row's `startedAtMs` so callers can apply
 * the same pid-reuse guard {@link isPidAlive} uses elsewhere.
 */
export function filterCachedUnattributed(
  sessions: ActiveSession[],
  attributed: Set<number>,
  alive: (pid: number, startedAtMs?: number) => boolean,
): ActiveSession[] {
  return sessions.filter((s) => {
    if (s.pid == null) return false;
    if (attributed.has(s.pid)) return false;
    return alive(s.pid, s.startedAtMs);
  });
}

type ActiveContext = 'terminal' | 'teams' | 'cloud' | 'headless';

/** The SessionMeta fields the live-row backfill reads — the enrichment a running process cannot report. */
export type BackfillMeta = Pick<SessionMeta,
  'version' | 'account' | 'timestamp' | 'label' | 'ticketId' | 'prUrl' | 'prNumber' | 'origin' | 'routineName' | 'harness' |
  'tokenCount' | 'durationMs' | 'subAgentCount' | 'firstUserMessage'
>;

export function backfillActiveRowsFromMeta(
  sessions: ActiveSession[],
  metaById: Map<string, BackfillMeta>,
): void {
  for (const s of sessions) {
    if (!s.sessionId) continue;
    const m = metaById.get(s.sessionId);
    if (!m) continue;
    if (!s.version && m.version) s.version = m.version;
    if (!s.account && m.account) s.account = m.account;
    if (!s.firstUserMessage && m.firstUserMessage) s.firstUserMessage = m.firstUserMessage;
    if (!s.label && m.label) s.label = m.label;
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
  }
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
    /* enrichment is best-effort — an unavailable DB leaves rows un-backfilled */
  }
  return byId;
}

export function backfillActiveRowsFromIndex(sessions: ActiveSession[]): void {
  backfillActiveRowsFromMeta(sessions, loadBackfillMetaFor(sessions));
}

export function isRunningLiveSession(s: ActiveSession): boolean {
  if (s.status === 'queued' || s.status === 'closed' || s.status === 'crashed') return false;
  if (s.context === 'cloud') return Boolean(s.cloudProvider) && Boolean(s.cloudTaskId);
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
  prLink: string | null;
  viewingIn: string | null;
}> {
  return sessions.map((s) => ({
    ...s,
    ticketId: s.ticket?.id ?? null,
    project: activeSessionProjectKey(s),
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

/**
 * Every status here is COMPUTED by the framework from observable signals — PID
 * liveness and transcript last-write (mtime) — never self-reported by the agent.
 *
 *   - `running` / `idle` / `input_required` — a live process's working / stopped
 *     / waiting-on-you activity, from its transcript (see {@link computeLiveSignals}).
 *   - `queued` — dispatched, work in the pipeline (cloud/headless launch).
 *   - `closed` — the PID is dead. The process has exited; report that, don't
 *     fabricate `idle` ("done, waiting for you") for a process that is simply gone.
 *   - `abandoned` — no transcript write in {@link ABANDONED_STALE_MS} (days): the
 *     session is dangling, whether its PID is dead (long gone) or still alive but
 *     stuck making no progress. A soft signal — it clears the moment it writes again.
 *   - `unknown` — the residual: genuinely NO signal (no PID info AND no file).
 *
 * A LIVE, fresh process is never `unknown` — "the process is alive" is itself a
 * positive signal, so an opaque/unparseable live harness resolves to `running`
 * (its honest floor), and every tracked harness with a locatable, parseable
 * transcript (claude, codex, grok, droid, rush, gemini, kimi, hermes, opencode,
 * antigravity) gets a real working/waiting/idle from its own parser — see
 * {@link computeLiveSignals}, {@link lifecycleStatus} and {@link resolveFallbackStatus}.
 */
export type ActiveStatus =
  | 'running'
  | 'idle'
  | 'queued'
  | 'input_required'
  | 'closed'
  | 'abandoned'
  /** Alive, but no client is attached — the host window died and the agent outlived it. */
  | 'orphaned'
  /** The host window died and took the agent with it — an unclean exit, not a normal close. */
  | 'crashed'
  | 'unknown';

/**
 * Coarse lifecycle bucket a UI groups a row by, projected once at the source from
 * {@link ActiveStatus} so consumers stop re-deriving it (PHNX-2484). The vocabulary
 * is deliberately small — five terminal-agnostic buckets — so the AGI EXT Fleet panel
 * reads `phase` straight off the `sessions watch --json` row instead of mirroring the
 * CLI status word onto its own enum (the ext's `mapStatusToPhase`, now deleted):
 *   `running` — dispatched or actively working;
 *   `waiting` — blocked on the operator (needs-you);
 *   `failed`  — dangling/dead and needing attention (crashed, orphaned, abandoned);
 *   `done`    — the process exited cleanly;
 *   `idle`    — alive but quiet, or an unclassified state.
 */
export type SessionPhase = 'running' | 'waiting' | 'failed' | 'done' | 'idle';

/**
 * Which rung of the recap ladder produced a row's shown {@link ActiveSession.title}
 * (RUSH-3011), best-first:
 *   - `label`  — a `/rename` or harness-set label (incl. an agent-generated
 *                title, which lands in `label`); always wins.
 *   - `last`   — the last assistant line from the transcript tail; agent-derived.
 *   - `prompt` — the first-user-prompt topic; the last-resort fallback.
 */
export type RecapSource = 'label' | 'last' | 'prompt';

export interface ActiveSession {
  context: ActiveContext;
  kind: string;
  /**
   * Custom harness / profile name when this live process was launched via
   * `agents run <profile>` (e.g. `deepseek`). `kind` stays the HOST process
   * (claude) so transcript lookup and live-signal parsers keep working.
   * `sessions --active` displays this when set (PHNX-2935).
   */
  harness?: string;
  /** Specific host app — 'code', 'cursor', 'codium', 'iterm', 'terminal', 'warp', 'tmux', etc. */
  host?: string;
  pid?: number;
  sessionId?: string;
  cwd?: string;
  /** Project/repo key derived from cwd, when known. */
  project?: string | null;
  /** User-given name from /rename command. */
  label?: string;
  /** Durable `agents run --name` launch handle, when the run was named. */
  name?: string;
  /** First meaningful line of the initial prompt (extracted topic). */
  topic?: string;
  /**
   * The row's shown title — WHAT the session is, best-source-wins (RUSH-3011).
   * The ladder ({@link deriveSessionRecap}): a `/rename` or harness `label` →
   * the last agent line (`lastAgentLine`) → the first-prompt `topic`. A session
   * whose agent did work shows an agent-derived line, not the stale first
   * prompt. Folded on at the end of {@link getActiveSessions}; `recapSource`
   * names which rung produced it.
   */
  title?: string;
  /** Which ladder rung produced {@link title}. */
  recapSource?: RecapSource;
  /**
   * The first user turn cleaned for a "You" line — a screenshot path folds to
   * `[image]`, a pasted `$ cmd` to the command, a `/skill` install path to
   * `/<name>`, so path noise never shows. See {@link classifyUserPrompt}.
   */
  userPromptClean?: string;
  /** What kind of first turn {@link userPromptClean} was. */
  userPromptKind?: UserPromptKind;
  /**
   * The full, genuine first user turn — the real opening prompt, raw and
   * untruncated. Distinct from {@link userPromptClean} (display-cleaned) and
   * {@link topic} (a short first-line summary). A running process cannot report
   * it, so like {@link version} / {@link account} it is backfilled from the
   * indexed transcript ({@link SessionMeta.firstUserMessage}); the
   * `sessions watch --json` row (`SessionWatchRow`) carries it so the AGI EXT
   * Sessions "THE ASK" line renders the real prompt with no side-channel
   * transcript fetch (PHNX-3621).
   */
  firstUserMessage?: string;
  /**
   * Marks a SYNTHESIZED durable row projected from the transcript index rather
   * than a live process — the bounded last-7-days / ≤50 resumable "Previous"
   * sessions the `sessions watch` / `feed watch` stream surfaces so a consumer's
   * SessionPicker has recoverable history with no side-channel index fetch
   * (PHNX-3621). Only ever set on a row that has no live process this scan: a
   * live row for the same session id always wins the merge. Never asserted by a
   * live source; set exclusively by {@link buildPreviousRows}.
   */
  previous?: boolean;
  /**
   * The most recent assistant line (from the transcript tail) — the free,
   * always-current signal of what the agent last said/did. Ladder rung 3.
   */
  lastAgentLine?: string;
  /** Live preview: the latest turn (agent message or tool action), from the state engine. */
  preview?: string;
  /** Inferred activity: working / waiting_input / idle (from the transcript tail). */
  activity?: SessionActivity;
  /**
   * Output-token throughput (tokens/sec) over a rolling 60s window, from the
   * transcript tail. The number the Fleet shows next to a running agent;
   * absent when no transcript is resolvable or the agent format reports no usage.
   */
  tokPerSec?: number;
  /** Why the agent is waiting, when activity is waiting_input. */
  awaitingReason?: AwaitingReason;
  /** The structured decision (question/plan/permission + options) the agent is waiting on. */
  question?: StructuredQuestion;
  /**
   * Plan markdown from the last `ExitPlanMode` tool call. Present when the
   * transcript ever entered plan-review; `awaitingReason === 'plan_review'`
   * says whether it is still pending.
   */
  plan?: string;
  /**
   * Live plan progress from the most recent `TodoWrite` (RUSH-1380): the checklist
   * items + a done/total tally + the current step. The Fleet renders this
   * as an N/M pill + checklist for every session — including remote and
   * device-dispatched agents that have no local tool-call stream to parse.
   */
  todos?: TodoProgress;
  /** Last few assistant turns (most-recent last), for at-a-glance context in the UI. */
  tail?: string[];
  /** PR opened during the session. */
  pr?: DetectedPr;
  /** Worktree the session runs in. */
  worktree?: DetectedWorktree;
  /** Tracker ticket the session is tied to. */
  ticket?: DetectedTicket;
  /** Per-session rate/usage limit detected in the transcript (RUSH-1523). */
  rateLimited?: boolean;
  /** Tracker refs the session CREATED (Linear create_issue / gh issue create). */
  createdTickets?: string[];
  /** Team name the session SPAWNED via `agents teams create/add`. */
  spawnedTeam?: string;
  /** Files/screenshots attached to the session prompt. */
  attachments?: SessionAttachment[];
  /** Total tokens and elapsed duration from the indexed transcript. */
  tokenCount?: number;
  durationMs?: number;
  /** Number of subagents launched, persisted by the index scanner. */
  subAgentCount?: number;
  /** Durable documents created in the live transcript tail. */
  artifacts?: import('./highlights.js').ProducedArtifact[];
  /** Created plan document singled out for plan-first consumers. */
  planFile?: string;
  sessionFile?: string;
  startedAtMs?: number;
  /**
   * Agent version (e.g. `2.1.207`) for the row's `agent version` cell. Not a
   * live-scan signal — a running process does not report its own semver — so it
   * is backfilled at render time from the indexed {@link SessionMeta} by session
   * id (RUSH-2205), never asserted by a source.
   */
  version?: string;
  /**
   * Email of the account that produced the session (display-only). Like
   * {@link version}, a running process does not report which account a
   * `--strategy balanced` launch selected, so it is backfilled at render time
   * from the indexed {@link SessionMeta} by session id (PHNX-3184). This is what
   * the AGI EXT status bar renders as the session's account — it reads it off the
   * `sessions watch --json` row instead of spawning a per-tab `agents sessions
   * <id> --device <host> --json` (the 2026-08-25 CPU incident, agi-cli#3019).
   * Never group on this — two orgs can share one email; group on the index's
   * `accountKey`.
   */
  account?: string;
  /**
   * Last-activity epoch — the transcript's last write (mtime). Distinct from
   * {@link startedAtMs} (session START): a session begun 3h ago but last touched
   * 20s ago has an old start and a fresh last-activity. The Floor renders "Xs ago"
   * off this so an idle-but-old session doesn't read as freshly active.
   */
  lastActivityMs?: number;
  status: ActiveStatus;
  /**
   * Coarse lifecycle bucket derived once from {@link status} (see {@link SessionPhase}).
   * Folded on at the end of {@link getActiveSessions} by {@link foldPhase}, AFTER
   * {@link foldHostLink} has finalized `status` — so `orphaned`/`crashed` land in the
   * `failed` bucket rather than being re-derived (and mis-bucketed as `idle`) downstream.
   */
  phase?: SessionPhase;
  /** Indexed launch origin, backfilled by the sessions command for JSON consumers. */
  origin?: 'cli' | 'routine';
  /** Routine definition name when origin is `routine`. */
  routineName?: string;
  /**
   * Foreground/background presence for the detach/attach model:
   *   `attached`   — live interactive TUI you're watching;
   *   `background` — detached: running headless, unattended (via `agents sessions detach`);
   *   `parked`     — the headless continuation has exited; the transcript is durable.
   * Absent for ad-hoc headless runs and cloud/team rows, which aren't on the
   * foreground/background axis. Folded on at the end of {@link getActiveSessions}
   * from the detach store — never asserted by a source.
   */
  presence?: Presence;
  /**
   * Whether anything is still on the other end of this session — folded on at the
   * end of {@link getActiveSessions} by {@link foldHostLink} from the raw signals
   * below, never asserted by a source. Drives the `orphaned` / `crashed` statuses.
   */
  hostLink?: HostLink;
  /**
   * Whether this session's process was alive at scan time — the boolean
   * {@link applyState} already computes, kept rather than thrown away.
   *
   * `status` cannot stand in for it. `abandoned` fires on transcript staleness
   * BEFORE the liveness check, so it covers a live-but-stuck process as well as
   * a long-dead one; only `closed`/`crashed` are unconditionally dead. A consumer
   * that must tell "still there, just quiet" from "gone" needs this, not the
   * status. Absent from cloud rows (no pid) and from a peer running an older CLI.
   */
  pidAlive?: boolean;
  /**
   * Clients attached to this session's tmux session (`#{session_attached}`), for
   * a tmux-hosted row. Absent — NOT zero — when the session is not tmux-hosted:
   * zero means "tmux says nobody is looking", absent means "we cannot tell".
   */
  tmuxClients?: number;
  /**
   * When the owning IDE window last refreshed its slice of the live-terminals
   * registry. Absent for a session no IDE window owns. A stale value means that
   * window is gone — see {@link HOST_HEARTBEAT_STALE_MS}.
   */
  windowHeartbeatMs?: number;
  /** How many live PIDs resolve to this same session (subagents/forks). 1 unless collapsed. */
  pidCount?: number;
  /**
   * Where the process actually lives — machine host, local vs SSH, tmux pane,
   * and whether a rail exists to type back into it. Read from the process env
   * (`/proc/<pid>/environ` on Linux, `ps eww` on macOS) during enrichment.
   * Absent for cloud sessions (no local pid) and any pid whose env is unreadable.
   */
  provenance?: SessionProvenance;
  /**
   * Who initiated this session — the resolved actor id stamped at spawn
   * (`resolveActor().id`, read back from the pid registry / teammate record).
   * A tailnet login/email for a resolved human, `UNRESOLVED@<host>` when it
   * couldn't be determined, absent when the launch predates actor stamping.
   * Surfaced as the owner column in `--active` (RUSH-2018).
   */
  owner?: string;
  /**
   * The machine this session runs on, as a normalized device id (machineId()
   * form). Set when merging cross-machine results so the grouped `--active`
   * view can bucket by computer. Absent for a purely local query (the renderer
   * falls back to provenance.host, then the local machine).
   *
   * For a host-dispatched run this is the EXECUTION host, not the box holding
   * the live shim process — see {@link foldExecutionMachine}.
   */
  machine?: string;
  /**
   * Set only on the dispatching box's own row for a host-dispatched run
   * (`agents run --device <peer>`): the live process here is the ssh/TTY shim,
   * while the agent itself runs on {@link machine}. Names the box the dispatch
   * was issued from, so a merged fleet view can prefer the executing machine's
   * own richer row over this shim (see `dedupeByMachineSession`).
   */
  offloadedFrom?: string;
  teamName?: string;
  /**
   * For a teams teammate: the session id of the ORCHESTRATOR that spawned the
   * team (the agent that ran `agents teams add`, captured from AGENTS_SESSION_ID
   * at spawn). Lets the listing answer "which session spun up this team" and
   * group teammates under their orchestrator. Distinct from `sessionId`, which is
   * the teammate's OWN transcript.
   */
  orchestratorSessionId?: string;
  /** Display label for the orchestrator (its topic/label), resolved when the
   * orchestrator is itself present in the active set. Display-only. */
  orchestratorLabel?: string;
  /**
   * For a teams teammate: a one-line summary of the mission it was spawned with
   * (the `prompt` stored on the teammate record — the team's task/target), so the
   * listing answers "what is this team working on", not just its name. Survives
   * before the teammate has produced any transcript (a pending/staged teammate
   * still shows its target). Distinct from `topic`, which is derived from the
   * teammate's own transcript once it starts.
   */
  assignedTask?: string;
  agentId?: string;
  cloudProvider?: string;
  cloudTaskId?: string;
  cloudStatus?: string;
  /**
   * IDE window that owns this terminal. Source of truth is the per-window
   * slice key in `live-terminals.json` (computeWindowId in the swarmify
   * extension): `${vscode.env.sessionId}-${extension-host pid}`. Lets the
   * renderer cluster terminals that belong to the same IDE window even when
   * two windows have the same cwd open. Only populated for `terminal` context.
   */
  windowId?: string;
  /**
   * Controlling TTY of the agent process (e.g. 'ttys003'), from the `ps -A`
   * read. macOS/Linux terminal sessions only; '??'/none normalized to undefined.
   * A disambiguation bridge (and the basis for future terminal addressing).
   */
  tty?: string;
  /**
   * Ghostty tab index (1-based) the session is shown in, when it can be matched
   * to a Ghostty surface by working directory (+ title). Transient, populated by
   * the renderer just before printing — NOT part of the pure discovery path.
   */
  ghosttyTab?: number;
  /**
   * Resolved tmux attach target (`session:window.pane`) for a tmux-hosted local
   * session, from the pane id via `mapPanesToTargets`. Transient, renderer-set
   * (after the --json/--waiting gates) — NOT emitted on the discovery path.
   */
  tmuxTarget?: string;
  /**
   * Which host app + tab a tmux-hosted session is currently being VIEWED in,
   * resolved from the attached tmux client (its terminal PID -> app via
   * HOST_MATCHERS, its tab via the per-app resolver). `undefined` means no
   * client is attached — the session is running detached. Transient,
   * renderer-set (see src/lib/session/viewing-in.ts) — NOT on the discovery path.
   */
  viewingIn?: { app: string; tab?: number };
  /**
   * The editor tab that launched this agent (`AGENT_TERMINAL_ID`), from the pid
   * registry. This is the one identifier that survives an SSH hop AND a session
   * rotation: a Factory tab offloaded to a device has no local process to inspect,
   * and its spawn-time session id goes stale the moment the agent moves to another
   * session (`/clear`, exit-and-rerun), so `--active --device <device>` joined on
   * this is how that tab re-identifies its own session. Absent for any launch that
   * did not inherit a terminal id.
   */
  terminalId?: string;
  /**
   * tmux pane id (`%N`) when this row was discovered via the tmux source AND its
   * session id could not be resolved (a born-unidentifiable non-Claude pane). It
   * is the dedupe key for such id-less rows, so two anonymous panes in the same
   * cwd render as two distinct rows instead of collapsing onto each other. Unset
   * once a session id resolves (the id is the identity then).
   */
  paneId?: string;
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
  /** Skip the `ps` scan for ad-hoc headless agents. */
  skipHeadless?: boolean;
  /**
   * A `--local` query: this machine only. Never dial a remote-host teammate
   * (one dispatched via `agents teams add --device`) over ssh — report its
   * last-persisted meta.json state instead of polling it. RUSH-2118: without
   * this, `agents sessions --active --local` still fired one ssh round-trip
   * per remote-host teammate (finished or not) on every call.
   */
  localOnly?: boolean;
}

const LIVE_TERMINALS_FILE = path.join(getTerminalsDir(), 'live-terminals.json');

/**
 * A process is classified `running` if its session file was touched in the
 * last 2 minutes. Every Claude/Codex tool-call appends an event, so a
 * healthy session writes several times a minute.
 */
const ACTIVE_MTIME_WINDOW_MS = 2 * 60_000;

/**
 * Bound on the tmux `list-panes` call in {@link listTmuxAgentSessions}. A wedged
 * tmux server would otherwise hang the whole `--active` scan (the other sources
 * can't run past it); on timeout the tmux source throws {@link TmuxDiscoveryDegradedError}.
 */
const TMUX_LIST_PANES_TIMEOUT_MS = 5_000;

/**
 * Thrown by {@link listTmuxAgentSessions} when the socket exists (a server has
 * run) but tmux could not be asked for its truth — spawn failure, timeout, or a
 * nonzero exit. Distinct from a missing socket, which means no server ever ran
 * and is genuinely empty, not degraded. `getActiveSessions` still swallows this
 * to `[]` so its return type stays a plain session array, but
 * {@link describeActiveDiscoveryHealth} re-probes and surfaces it so the empty
 * case a real fleet sweep found (RUSH-2507) reads differently from a clean one.
 */
export class TmuxDiscoveryDegradedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TmuxDiscoveryDegradedError';
  }
}

/**
 * A live process can only borrow an indexed session file if that transcript
 * has been touched recently enough to plausibly belong to the process. This is
 * deliberately wider than ACTIVE_MTIME_WINDOW_MS: an inactive-but-live CLI can
 * be idle for longer than 2 minutes, but it must not attach to a weeks-old
 * transcript just because a GUI app service with the same basename is alive.
 */
const ACTIVE_SESSION_STALE_MS = 24 * 60 * 60_000;

/**
 * A session whose transcript hasn't been written in this long is ABANDONED /
 * dangling — the framework can no longer treat it as live work, whether its PID
 * is dead (long gone) or still alive but making no progress (a hung agent).
 * Two days: past a normal work gap, well short of a session legitimately kept
 * open across a long weekend. Deliberately far wider than
 * {@link ACTIVE_SESSION_STALE_MS} (which bounds transcript-borrowing, a different
 * concern) — this is the lifecycle threshold, not the freshness window.
 */
export const ABANDONED_STALE_MS = 2 * 24 * 60 * 60_000;

/**
 * Field separator for every `tmux list-panes -F` query here.
 *
 * NOT a tab. tmux sanitizes non-printable characters out of format output (3.6a
 * rewrites a literal tab — and any non-ASCII sentinel — to `_`), so a
 * tab-separated format comes back as one unsplittable field.
 * {@link listTmuxAgentSessions} split on `\t`, so on such a tmux every line
 * failed its `sessName` guard and the function returned ZERO rows, silently
 * losing the authoritative tmux source (exact `%pane`, real identities) on every
 * box running a recent tmux.
 *
 * `:` specifically, and not some other printable: tmux itself replaces `:` (and
 * `.`) in a session name with `_`, so the separator provably cannot occur inside
 * the one free-text field that is not last. A path CAN contain `:`, which is why
 * `pane_current_path` is queried last and its tail rejoined rather than
 * destructured. A separator that a session name may contain — `|`, say — would
 * just reintroduce the same class of bug with a lower probability.
 */
const TMUX_FIELD_SEP = ':';

/**
 * Process comm names that are NOT derivable from the AGENTS registry's
 * `cliCommand`. `rush` is a {@link SESSION_AGENTS} member with no AGENTS registry
 * row (it is the Rush app, not a managed harness), so its executable name is
 * mapped explicitly here. Everything else flows from the registry below.
 */
const EXTRA_SESSION_AGENT_COMMS: Partial<Record<SessionAgentId, string[]>> = {
  rush: ['rush'],
};

/**
 * Every process executable ("comm") name that identifies a given session-agent
 * kind in the headless `ps`-scan. Driven off the AGENTS registry's `cliCommand`
 * (the real executable name — e.g. `agy` for antigravity, `cursor-agent` for
 * cursor) plus {@link EXTRA_SESSION_AGENT_COMMS} for members with no registry
 * row. Exported so the completeness test can assert every {@link SESSION_AGENTS}
 * member resolves — the fix for the harness-parity gap where bare-headless
 * grok/kimi/antigravity/openclaw/hermes/rush were silently dropped.
 */
export function sessionAgentComms(id: SessionAgentId): string[] {
  const comms = new Set<string>();
  const cli = (AGENTS as Record<string, { cliCommand?: string }>)[id]?.cliCommand;
  if (cli) comms.add(cli);
  for (const extra of EXTRA_SESSION_AGENT_COMMS[id] ?? []) comms.add(extra);
  return [...comms];
}

/**
 * Executables we recognize as agent CLIs when scanning the process table. Built
 * once from {@link sessionAgentComms} across {@link SESSION_AGENTS} — a single
 * derived source, not a second hand-maintained allowlist that drifts from the
 * discovery surface (the harness-parity code-review rule).
 */
const AGENT_CLI_NAMES: Record<string, SessionAgentId> = (() => {
  const map: Record<string, SessionAgentId> = {};
  for (const id of SESSION_AGENTS) {
    for (const comm of sessionAgentComms(id)) map[comm] = id;
  }
  return map;
})();

/**
 * Resolve an agent kind from a process's reported executable. `comm` may be an
 * absolute path (shim-launched agents), and Windows image names carry an
 * `.exe` suffix (`claude.exe`), so basename + suffix-strip before the lookup.
 */
export function agentKindFromComm(commRaw: string): string | undefined {
  // A GUI desktop app can bundle a binary with the SAME name as an agent CLI: the
  // Codex desktop app ships `/Applications/Codex.app/Contents/Resources/codex` (its
  // `app-server`), whose basename `codex` would otherwise match the codex CLI and
  // surface the app's background server as a phantom agent session — running at cwd
  // '/', so it shows up unattributed in the feed. A real agent CLI is never inside a
  // `.app` bundle, so exclude those. (The Claude desktop app is a separate case,
  // already excluded by name below: its process is 'Claude', not the CLI's 'claude'.)
  if (commRaw.includes('.app/Contents/')) return undefined;
  const base = path.basename(commRaw);
  const stripped = base.replace(/\.exe$/i, '');
  // Windows image names compare case-insensitively; POSIX comms stay exact —
  // macOS's Claude desktop app process is named 'Claude' and must NOT match.
  const key = stripped === base ? base : stripped.toLowerCase();
  return AGENT_CLI_NAMES[key];
}

/**
 * A tmux agent session name is `ag-<agent>-<shortid>` (see src/lib/exec.ts
 * `runInTmux`), where `<agent>` is the agent kind passed to `agents run` (may
 * contain a hyphen, e.g. `cursor-agent`) and `<shortid>` is the first 8 hex chars
 * of the session UUID. Anchored on the 8-hex suffix so the agent part is split
 * unambiguously. The agent part is NOT cross-checked against AGENT_CLI_NAMES (that
 * map is the narrower ps-scan comm set): the panes live on the agent-only socket,
 * and validating there would silently drop grok/kimi/antigravity — the exact
 * harness-parity gap we are fixing.
 */
const AG_NAME_RE = AG_TMUX_NAME_RE;

/** Agent kind from an `ag-<agent>-<shortid>` tmux session name, else undefined. */
export function agentKindFromName(sessName: string): string | undefined {
  const m = AG_NAME_RE.exec(sessName);
  return m ? m[1].toLowerCase() : undefined;
}

/** The 8-char session-id prefix from an `ag-<agent>-<shortid>` name, else undefined. */
export function shortIdFromName(sessName: string): string | undefined {
  const m = AG_NAME_RE.exec(sessName);
  return m ? m[2].toLowerCase() : undefined;
}

/**
 * Map every `ag-<agent>-<shortid>` tmux session name to its full session UUID in
 * ONE batched DB lookup. The live scan calls this once per poll (not per pane),
 * then resolvePaneIdentity reads the map — the recovery that makes a detached
 * agent findable by `focus <id>` even when its durable identity records are gone.
 * `findSessionsByShortIds` is injected so this stays unit-testable without a DB.
 */
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

/**
 * A process that began more than this long AFTER a session's recorded
 * `startedAtMs` cannot be that session's process — the OS handed its pid to
 * something newer. The window absorbs clock granularity (`ps -o lstart=` reports
 * whole seconds) and the gap between a process spawning and the SessionStart
 * hook recording `startedAtMs`; it is far below the minutes-to-hours it takes the
 * pid space to wrap and actually recycle a pid, so it never false-kills a live
 * session.
 */
const PID_REUSE_TOLERANCE_MS = 60_000;

/**
 * Epoch-ms start time of the process at `pid`, or null if unknowable.
 *
 * Distinct from teams/agents.ts's `captureProcessStartTime`, which returns an
 * opaque token only meaningful for equality against a prior capture of the SAME
 * pid. Here we need a value comparable to a session's `startedAtMs`, so we read
 * `ps -o lstart=` — a ctime string on both macOS and Linux — and parse it to
 * epoch ms. Windows and any exec/parse failure return null, so the caller falls
 * back to a bare existence check (never worse than before).
 */
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

/**
 * True when `pid` names a live process AND — when a session's recorded
 * `startedAtMs` is supplied — that process is plausibly the SAME one, not a later
 * process that recycled the pid. The OS reuses pids, so a bare
 * `process.kill(pid, 0)` existence check reports a dead session as alive (a
 * "zombie") once its pid is handed to an unrelated process. A genuine session
 * process starts at or before its own recorded start, so a process that began
 * meaningfully AFTER `startedAtMs` is a reused pid and the session is dead. When
 * the start time can't be read, we keep the existence answer.
 */
export function isPidAlive(pid: number, startedAtMs?: number): boolean {
  if (!pid || pid < 1) return false;
  try {
    process.kill(pid, 0);
  } catch (err: any) {
    // EPERM means the pid exists but is owned by another user — still "alive",
    // fall through to the identity check. Any other error means no such process.
    if (err?.code !== 'EPERM') return false;
  }
  if (startedAtMs && startedAtMs > 0) {
    const procStartMs = processStartMs(pid);
    if (procStartMs !== null && procStartMs > startedAtMs + PID_REUSE_TOLERANCE_MS) {
      return false; // pid recycled by a newer process — this session is gone
    }
  }
  return true;
}

interface LiveTerminalEntry {
  sessionId: string;
  pid: number;
  kind: string;
  label?: string | null;
  cwd?: string | null;
  startedAtMs: number;
  /** Slice key from the registry — the IDE window that owns this terminal. */
  windowId?: string;
  /** The slice's `at` stamp — when that window last republished. See {@link HOST_HEARTBEAT_STALE_MS}. */
  windowHeartbeatMs?: number;
  /** This entry's pid is gone; kept only because its window never tore it down. */
  pidDead?: boolean;
}

/**
 * Keep dead entries only when their window heartbeat also stopped, proving a crash;
 * a live duplicate always wins.
 */
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
      // Dead pid + a window still republishing = an ordinary close mid-debounce.
      // Dead pid + a window that stopped republishing = the crash we must report.
      if (!alive && !windowGone) continue;
      const entry: LiveTerminalEntry = { ...e, windowId, windowHeartbeatMs, pidDead: !alive };
      // A live entry always wins a dead one for the same session (the agent was
      // relaunched into a new window while the crashed window's slice lingers).
      const prev = merged.get(e.sessionId);
      if (prev && !prev.pidDead && !alive) continue;
      merged.set(e.sessionId, entry);
    }
  }
  return Array.from(merged.values());
}

/**
 * Process-local memo for Claude transcript path resolution. Each active-session
 * poll re-walks every Claude version-home `projects/` tree for every live pid
 * (#2047). A resolved path is sticky while the file still exists; a miss or a
 * vanished file re-walks. Cap size so a long-lived process cannot retain every
 * cwd it has ever seen.
 */
const CLAUDE_SESSION_FILE_CACHE_MAX = 256;
const claudeSessionFileCache = new Map<string, string>();

/**
 * Search every version home because the live ~/.claude symlink moves after upgrades
 * while older running sessions keep writing to their original home.
 */
function findClaudeSessionFile(cwd: string, sessionId?: string): string | undefined {
  // Only memoize when the exact session UUID is known. Without an id the
  // resolver picks newest-by-mtime under the project dir; caching that path
  // would stick to an old transcript after a new session starts in the same cwd.
  if (sessionId) {
    const cacheKey = `${cwd}\0${sessionId}`;
    const hit = claudeSessionFileCache.get(cacheKey);
    if (hit !== undefined) {
      try {
        if (fs.existsSync(hit)) return hit;
      } catch { /* re-resolve */ }
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

/**
 * Resolve a Claude transcript for `cwd` across the given project roots, newest
 * mtime winning when the same id/cwd resolves in more than one version home
 * (the actively-written copy is the newest). Pure over `projectRoots`, so it is
 * testable against temp dirs without touching the real home directory.
 */
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

/**
 * Pick a Claude transcript file within a project dir.
 *
 * With a CONCRETE session id: return that id's `<id>.jsonl` or undefined — NEVER a
 * sibling's. Falling back to the newest file here is the bug that made N distinct
 * co-located sessions (e.g. several editor tabs in one cwd, or two worktree siblings)
 * all collapse onto ONE file and render identical preview + topic (they look like
 * duplicate cards). The mtime fallback is only sound when NO id is known.
 *
 * With NO id: return the newest `.jsonl` by mtime (the legitimate single-session
 * heuristic for a directly-launched agent with no registry entry).
 */
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
    } catch { /* file vanished between readdir and stat */ }
  }
  return best?.path;
}

/**
 * One `stat` → the transcript's creation (≈ session start) and last-write (≈ last
 * activity) epochs. Both `undefined` when the file can't be stat'd (vanished /
 * unresolved). `birthtimeMs` can be 0 on filesystems without creation time — coerce
 * that to `undefined` so callers fall through to a real signal instead of epoch 0.
 */
export function sessionFileTimes(sessionFile: string | undefined): { birthtimeMs?: number; mtimeMs?: number } {
  if (!sessionFile) return {};
  try {
    const st = fs.statSync(sessionFile);
    return { birthtimeMs: st.birthtimeMs || undefined, mtimeMs: st.mtimeMs || undefined };
  } catch {
    return {};
  }
}

/**
 * The lifecycle status computed purely from the two hard signals the framework
 * always has — PID liveness and transcript last-write (mtime) — independent of
 * anything the agent self-reports or what its last transcript turn happened to
 * look like. Returns the definitive lifecycle label when one applies, or
 * `undefined` when the process is live and fresh (so the caller uses the richer
 * activity-derived status instead).
 *
 *   - No write in {@link ABANDONED_STALE_MS} ⇒ `abandoned` (dangling): a
 *     days-stale session is not live work, whether its PID is dead (long gone)
 *     or still alive but stuck. Checked first — it outranks a bare `closed`.
 *   - Otherwise, PID dead ⇒ `closed`: the process has exited. This is the fix
 *     for the old "dead PID reports idle" lie — `idle` reads as "done, waiting
 *     for you", but a dead process is done, period.
 *   - Otherwise (alive + fresh) ⇒ `undefined`: defer to the activity engine.
 */
export function lifecycleStatus(
  pidAlive: boolean,
  mtimeMs: number | undefined,
  nowMs: number = Date.now(),
): ActiveStatus | undefined {
  if (mtimeMs !== undefined && nowMs - mtimeMs >= ABANDONED_STALE_MS) return 'abandoned';
  if (!pidAlive) return 'closed';
  return undefined;
}

/**
 * The ONE place a fallback status is decided when no rich transcript state is
 * available — an opaque kind we cannot parse (openclaw), or a transcript
 * whose parse/tail was empty or unreadable. Honest by construction: computed from
 * PID + mtime, never a fabricated `idle`.
 *
 *   - Dead PID, or a days-stale transcript ⇒ {@link lifecycleStatus} (`closed` /
 *     `abandoned`). A dead process is `closed`, not the old fabricated `idle`
 *     (which the UI reads as "done, waiting for you"); a dead process whose file
 *     also vanished is still `closed` (death is a definitive answer, not `unknown`).
 *   - Live + fresh ⇒ `running`. A live process is, at minimum, running: we may
 *     not see WHAT an opaque harness (or an empty tail) is doing, but the process
 *     being alive is a positive signal — never a blank `unknown` (the old blanket
 *     bug for every non-claude/codex live agent) nor a downgraded `idle`.
 */
export function resolveFallbackStatus(
  sessionFile: string | undefined,
  pidAlive: boolean,
  nowMs: number = Date.now(),
): ActiveStatus {
  const { mtimeMs } = sessionFileTimes(sessionFile);
  return lifecycleStatus(pidAlive, mtimeMs, nowMs) ?? 'running';
}

/**
 * Locate the live transcript for an agent process. Claude files are keyed by cwd
 * (+ optional session uuid), so they resolve straight off disk. Every OTHER
 * tracked harness — Codex (date-partitioned), plus grok / droid / rush / gemini /
 * kimi / hermes / opencode / antigravity / cursor (per-session dirs, SQLite, single-JSON)
 * — is resolved through the session index. When the session id is KNOWN, that id
 * selects the transcript. Only an id-less process falls back to the newest indexed
 * transcript for that cwd, bounded by ACTIVE_SESSION_STALE_MS so a live pid never
 * borrows a weeks-old transcript. This is what lets a live NON-claude/codex agent
 * get a real status instead of falling through to `unknown` (the file feeds
 * {@link computeLiveSignals}). An opaque kind we don't track still yields undefined
 * here and degrades honestly to a live `running`.
 *
 * The id branch exists because the cwd fallback is only safe when there is nothing
 * better: it answers `WHERE agent = ? AND cwd = ? ORDER BY last_activity DESC LIMIT 1`
 * (`latestSessionFileForCwd`), so with two same-harness agents in ONE cwd — routine on
 * this fleet — every one of them resolves to whichever transcript was touched last.
 * That is the same "one stranger's transcript" hazard the id-less tmux pane already
 * refuses to guess at (see `listTmuxAgentSessions`), and since RUSH-2682 it reaches
 * further than a status badge: the live row now backs `sessions preview <id>`, so the
 * guess renders session B's digest under session A's header and caches it against A.
 * An id we cannot resolve yields undefined — the honest "not indexed here" render —
 * rather than a neighbour's transcript (RUSH-2691).
 */
export function findSessionFileForKind(kind: string, cwd?: string, sessionId?: string): string | undefined {
  if (!cwd) return undefined;
  if (kind === 'claude') return findClaudeSessionFile(cwd, sessionId);
  if (!isSessionTrackedAgent(kind)) return undefined;
  if (sessionId) return indexedSessionFileForId(kind, sessionId);
  return latestSessionFileForCwd(kind, cwd, { maxAgeMs: ACTIVE_SESSION_STALE_MS });
}

/**
 * The indexed transcript for one exact session id, or undefined when the index has
 * not reached it yet. The `agent` guard rejects a row that belongs to a different
 * harness than the live process claims: those cannot be the same conversation, and
 * returning it would reintroduce the misattribution this function exists to avoid.
 */
function indexedSessionFileForId(kind: string, sessionId: string): string | undefined {
  const row = getSessionById(sessionId);
  if (!row || row.agent !== kind) return undefined;
  return row.filePath || undefined;
}

/** Recover the session UUID from a transcript filename (Claude `<uuid>.jsonl`, Codex `rollout-…-<uuid>.jsonl`). */
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
function sessionIdFromFile(file?: string): string | undefined {
  if (!file) return undefined;
  return path.basename(file).match(UUID_RE)?.[0];
}

/** Live per-session signals derived from one transcript-tail read. */
interface LiveSignals {
  /** Rich inferred state (activity/preview/badges). Undefined when unreadable. */
  state?: SessionState;
  /** Rolling output-token throughput (tokens/sec). Undefined when no usage in the tail. */
  tokPerSec?: number;
}

/** Cap the events fed to state inference for a non-tailable harness — the last
 * turns are all `inferActivity` needs, and a bound keeps a huge transcript cheap. */
const LIVE_STATE_MAX_EVENTS = 80;

/**
 * Parse a NON-claude/codex transcript with that harness's own parser and return
 * its last events for state inference. These formats vary too much for the
 * single-file byte-tail fast path (per-session dirs for grok/kimi, SQLite for
 * opencode/antigravity, single-JSON for gemini/hermes), so parse the whole
 * (size-guarded, via safeReadSessionFile) transcript and keep the tail. A parse
 * failure yields no events, degrading honestly to the live fallback.
 */
function parseTailEventsForKind(agent: SessionAgentId, sessionFile: string): SessionEvent[] {
  let events: SessionEvent[];
  try {
    events = parseSession(sessionFile, agent);
  } catch {
    return [];
  }
  return events.length > LIVE_STATE_MAX_EVENTS ? events.slice(-LIVE_STATE_MAX_EVENTS) : events;
}

/**
 * Process-local memo for {@link computeLiveSignals}. The menu-bar / `--active`
 * poll re-reads every live session on a ~30s tick (#2047). When a transcript's
 * mtime (and pidAlive / kind / cwd) are unchanged, re-parsing the tail yields
 * the same signals — skip the parse. Bound the map so a long-lived daemon that
 * sees thousands of sessions over its life cannot retain them forever.
 */
const LIVE_SIGNALS_CACHE_MAX = 512;
const liveSignalsCache = new Map<string, {
  mtimeMs: number | undefined;
  pidAlive: boolean;
  signals: LiveSignals;
}>();

/** Test seam: drop the in-process live-signals memo. */
export function clearLiveSignalsCacheForTest(): void {
  liveSignalsCache.clear();
}

/**
 * Derive the inferred state (working / waiting / idle + preview/badges) and, for
 * the two harnesses whose raw lines carry it, the output-token throughput.
 *
 * Claude/Codex take the fast bounded byte-tail ({@link readSessionTailWithRaw}) —
 * the hot path, and the only two that also yield throughput (their raw lines
 * carry usage the event model drops). EVERY OTHER tracked harness (grok, droid,
 * rush, gemini, kimi, hermes, opencode, antigravity, cursor) is parsed with its own
 * parser and run through the SAME {@link inferSessionState}, so a live
 * non-claude/codex agent gets a real working/waiting/idle instead of the blanket
 * `unknown` it used to fall through to. An opaque/untracked kind or an
 * unreadable/empty transcript yields an empty signal set, and the caller's
 * {@link resolveFallbackStatus} reports the honest live floor (`running`).
 *
 * Unchanged-mtime hits reuse the previous result (see {@link liveSignalsCache})
 * so a 30s active-session poll does not re-tail every quiet transcript.
 */
export function computeLiveSignals(kind: string, sessionFile: string | undefined, cwd: string | undefined, pidAlive: boolean): LiveSignals {
  if (!sessionFile) return {};
  let mtimeMs: number | undefined;
  try { mtimeMs = fs.statSync(sessionFile).mtimeMs; } catch { /* vanished between calls */ }

  const cacheKey = `${kind}\0${sessionFile}\0${cwd ?? ''}`;
  const cached = liveSignalsCache.get(cacheKey);
  if (cached && cached.mtimeMs === mtimeMs && cached.pidAlive === pidAlive) {
    return cached.signals;
  }

  const ctx = { cwd, pidAlive, mtimeMs, activeWindowMs: ACTIVE_MTIME_WINDOW_MS };
  let signals: LiveSignals = {};

  if (kind === 'claude' || kind === 'codex') {
    const { events, content } = readSessionTailWithRaw(sessionFile, kind);
    if (events.length > 0) {
      const state = inferSessionState(events, ctx);
      const tokPerSec = computeTokPerSec(content, kind);
      signals = { state, tokPerSec: tokPerSec > 0 ? tokPerSec : undefined };
    }
  } else if (isSessionTrackedAgent(kind)) {
    const events = parseTailEventsForKind(kind, sessionFile);
    if (events.length > 0) {
      signals = { state: inferSessionState(events, ctx) };
    }
  }

  if (liveSignalsCache.size >= LIVE_SIGNALS_CACHE_MAX) liveSignalsCache.clear();
  liveSignalsCache.set(cacheKey, { mtimeMs, pidAlive, signals });
  return signals;
}

/** Map inferred activity onto the coarse ActiveStatus used by the renderer and counts. */
function statusFromActivity(activity: SessionActivity): ActiveStatus {
  return activity === 'working' ? 'running' : activity === 'waiting_input' ? 'input_required' : 'idle';
}

/**
 * Fold a computed SessionState onto an active-session row: rich status +
 * preview + PR/worktree/ticket badges. With no state (an opaque/untracked kind,
 * or an unreadable/empty transcript) it degrades to
 * {@link resolveFallbackStatus}, which reports the honest live floor (`running`
 * for an alive process) rather than the old blanket `unknown`.
 */
function applyState(base: Omit<ActiveSession, 'status'>, state: SessionState | undefined, fallbackFile: string | undefined, pidAlive: boolean): ActiveSession {
  if (!state) return { ...base, pidAlive, status: resolveFallbackStatus(fallbackFile, pidAlive) };
  // Lifecycle (closed/abandoned) is computed from PID + mtime and OVERRIDES the
  // activity-derived status: a dead or days-stale process is closed/abandoned no
  // matter what its last parsed transcript turn looked like (a dead session whose
  // tail ended mid-tool-call must not read as `running`). `base.lastActivityMs` is
  // the transcript mtime the row already resolved — reuse it, no extra stat.
  const life = lifecycleStatus(pidAlive, base.lastActivityMs ?? sessionFileTimes(fallbackFile).mtimeMs);
  return {
    ...base,
    pidAlive,
    status: life ?? statusFromActivity(state.activity),
    activity: state.activity,
    awaitingReason: state.awaitingReason,
    question: state.question,
    plan: state.plan,
    todos: state.todos,
    tail: state.tail,
    // Prefer the live preview (latest turn); keep the first-prompt topic as a fallback.
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

/**
 * Extract the first user message's content from a Claude JSONL file.
 * Reads only the first ~50 lines for speed, since the user message is
 * typically near the top (after system/queue events).
 */
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

/**
 * One-line summary of a teammate's spawn prompt — the team's task/target. Takes
 * the first non-empty line, strips a leading `MISSION:`/`CONTEXT:`/`TASK:` label,
 * and truncates. Exported for tests.
 */
export function summarizeMission(prompt: string | null | undefined): string | undefined {
  if (!prompt) return undefined;
  const firstLine = prompt.split('\n').map((l) => l.trim()).find(Boolean);
  if (!firstLine) return undefined;
  const cleaned = firstLine.replace(/^(MISSION|CONTEXT|TASK|GOAL|OBJECTIVE)\s*[:\-—]\s*/i, '').trim();
  if (!cleaned) return undefined;
  return cleaned.length > 80 ? `${cleaned.slice(0, 79)}…` : cleaned;
}

/**
 * Live teams teammates. Reuses AgentManager which already polls PIDs via
 * `kill -0`. `localOnly` (RUSH-2118) skips the ssh round-trip AgentManager
 * would otherwise issue for every distributed (remote-host) teammate.
 */
export async function listTeamsActive(opts: { localOnly?: boolean } = {}): Promise<ActiveSession[]> {
  const mgr = new AgentManager(undefined, undefined, undefined, undefined, undefined, opts.localOnly ?? false);
  const running = await mgr.listRunning();
  const self = machineId();
  return running.map((a): ActiveSession => {
    // The teammate's OWN transcript is `remoteSessionId` (captured from its first
    // stream event). `parentSessionId` is the ORCHESTRATOR that spawned the team
    // (AGENTS_SESSION_ID at spawn) — a link, not this teammate's id. Keying the
    // row off the orchestrator conflated the two (a teammate showed the
    // orchestrator's id/topic and lineage was invisible); resolve the teammate's
    // own session for the row and expose the orchestrator separately.
    const ownSessionId = a.remoteSessionId ?? undefined;
    const sessionFile = findSessionFileForKind(a.agentType, a.cwd ?? undefined, ownSessionId);
    const topic = sessionFile ? quickExtractTopic(sessionFile) : undefined;
    const pidAlive = a.pid ? isPidAlive(a.pid) : true;
    const { state, tokPerSec } = computeLiveSignals(a.agentType, sessionFile, a.cwd ?? undefined, pidAlive);
    const resolvedId = ownSessionId ?? sessionIdFromFile(sessionFile);
    // A remote teams teammate (`teams add --device <peer>`) EXECUTES on that
    // peer, not on this orchestrator box — but it gets no host-dispatch index
    // row, so `foldExecutionMachine` can't reach it and the self-stamp in
    // `commands/sessions.ts` would claim it, listing a peer's teammate under
    // `--device <orchestrator>` (SES-GAP-10). Attribute the row to the execution
    // host and mark the dispatcher, the same shape `run --device` gets: `machine`
    // survives the cross-machine fan-out because `parseRemoteActive` keeps an
    // `offloadedFrom` row's own machine, and `offloadedFrom` is COMPARED to this
    // box by `sessionProcessIsLocal` (never merely tested), so a third box seeing
    // this row over the fan-out reads it as the peer's, not its own. A local
    // teammate (no `hostName`, or pinned to this box) is left unattributed for
    // the self-stamp.
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
      // The frozen actor stamped on the teammate record (RUSH-2028) — who ran
      // this teammate, surfaced as the owner in --active (RUSH-2018); sidecar
      // fallback for a teammate record predating the actor field.
      owner: resolveOwner(a.actor, resolvedId),
    }, state, sessionFile, pidAlive);
  });
}

/** Live editor-terminal agents across every IDE window. */
export async function listTerminalsActive(): Promise<ActiveSession[]> {
  const entries = readLiveTerminals();
  if (entries.length === 0) return [];

  // Walk the shell PIDs through the process table once so we can name the host
  // (code / cursor / codium) per entry rather than a generic 'terminal'.
  const procByPid = new Map<number, ProcRow>();
  for (const r of await readProcessTable()) procByPid.set(r.pid, r);

  // Build label map from Claude's sessions/*.json for /rename support
  const labelMap = buildClaudeLabelMap();
  // Run-name handles (`agents run --name`) keyed by session id, for the same
  // sessionId → handle resolution as labels.
  const runNameMap = buildRunNameMap();

  return entries.map((t): ActiveSession => {
    // The id cached in live-terminals.json goes stale when Claude rotates its
    // transcript uuid on resume/compact, so it often no longer matches any
    // <id>.jsonl. When the pid registry knows this pid's current id, prefer it —
    // the same source the headless path uses. NOTE: live-terminals.json stores the
    // SHELL pid, while the by-pid registry is keyed by the AGENT pid, so for
    // editor-launched terminals this lookup returns undefined today and we fall
    // back to the stale cached id — the duplicate-card fix comes from
    // pickSessionFile no longer borrowing a sibling, not from this lookup. Kept as
    // a forward-looking hook for the cases where the pid does line up.
    const pidEntry = readPidSessionEntry(t.pid);
    const resolvedId = pidEntry?.sessionId ?? t.sessionId;
    const sessionFile = findSessionFileForKind(t.kind, t.cwd ?? undefined, resolvedId);
    // Prefer label from live terminal, fall back to Claude's session label
    const label = t.label ?? (t.sessionId ? labelMap.get(t.sessionId) : undefined) ?? undefined;
    // Durable run name from `agents run --name`, resolved by the run's session id.
    const name = resolvedId ? runNameMap.get(resolvedId) ?? undefined : undefined;
    // Extract topic from session file (first meaningful user message)
    const topic = sessionFile ? quickExtractTopic(sessionFile) : undefined;
    const pidAlive = isPidAlive(t.pid, t.startedAtMs);
    const { state, tokPerSec } = computeLiveSignals(t.kind, sessionFile, t.cwd ?? undefined, pidAlive);
    return applyState({
      context: 'terminal',
      kind: t.kind,
      harness: pidEntry?.harness,
      host: detectHost(t.pid, procByPid),
      tty: procByPid.get(t.pid)?.tty,
      pid: t.pid,
      sessionId: t.sessionId ?? sessionIdFromFile(sessionFile),
      cwd: t.cwd ?? undefined,
      label,
      name,
      topic,
      tokPerSec,
      sessionFile,
      startedAtMs: t.startedAtMs,
      lastActivityMs: sessionFileTimes(sessionFile).mtimeMs,
      windowId: t.windowId,
      windowHeartbeatMs: t.windowHeartbeatMs,
      owner: resolveOwner(pidEntry?.actor, resolvedId),
    }, state, sessionFile, pidAlive);
  });
}

/** Cloud tasks still in a non-terminal state. `tasks.db` may not exist; that's fine. */
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

interface ProcRow { pid: number; ppid: number; tty?: string; comm: string; kind?: string; }

/**
 * Ordered ancestor-process matchers. First match wins (most specific to least),
 * so an IDE renderer is preferred over the terminal-app that launched the IDE,
 * and a terminal-app is preferred over the multiplexer inside it.
 */
const HOST_MATCHERS: Array<{ host: string; tokens: string[] }> = [
  // IDE renderers (Electron helper processes on macOS, image names on Windows)
  { host: 'code',     tokens: ['Code Helper', 'Code - Insiders Helper', 'Code.exe'] },
  { host: 'cursor',   tokens: ['Cursor Helper', 'Cursor.exe'] },
  { host: 'codium',   tokens: ['VSCodium Helper', 'VSCodium.exe'] },
  { host: 'windsurf', tokens: ['Windsurf Helper', 'Windsurf.exe'] },
  // Native terminal apps
  { host: 'iterm',    tokens: ['iTerm2', 'iTermServer', 'iTerm'] },
  { host: 'terminal', tokens: ['Terminal.app', '/Applications/Utilities/Terminal.app', 'WindowsTerminal.exe'] },
  { host: 'warp',     tokens: ['Warp.app', 'stable_'] },
  { host: 'alacritty',tokens: ['alacritty', 'Alacritty'] },
  { host: 'kitty',    tokens: ['kitty'] },
  { host: 'hyper',    tokens: ['Hyper.app', 'Hyper Helper'] },
  { host: 'wezterm',  tokens: ['wezterm', 'WezTerm'] },
  { host: 'ghostty',  tokens: ['ghostty', 'Ghostty'] },
  // Multiplexers (fallback — only if no UI found above them)
  { host: 'tmux',     tokens: ['tmux'] },
  { host: 'screen',   tokens: ['screen'] },
];

/**
 * Snapshot the whole process table in one `ps` call. Includes ppid so we can
 * walk ancestry chains to attribute child processes to their terminal hosts.
 * `comm` may be an absolute path for shim-launched agents, so basename before
 * matching against AGENT_CLI_NAMES.
 *
 * Memoized for {@link PROCESS_TABLE_FRESH_MS} so one active-session scan (and a
 * quiet re-poll within the window) does not re-shell `ps -A` / CIM for every
 * caller — terminal host detection, headless attribution, and `hostFromPid`
 * all share the same snapshot (#2047).
 */
async function readProcessTable(): Promise<ProcRow[]> {
  const now = activeScanNow();
  if (processTableCache && now - processTableCache.at < PROCESS_TABLE_FRESH_MS) {
    return processTableCache.rows;
  }
  const rows = await readProcessTableLive();
  processTableCache = { at: now, rows };
  return rows;
}

/** Uncached process-table snapshot (the live `ps` / CIM path). */
async function readProcessTableLive(): Promise<ProcRow[]> {
  processTableLiveReads += 1;
  if (process.platform === 'win32') return readProcessTableWin32();
  let out: string;
  try {
    ({ stdout: out } = await execFileAsync('ps', ['-A', '-o', 'pid=,ppid=,tty=,comm='], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, timeout: PS_SNAPSHOT_TIMEOUT_MS }));
  } catch {
    return [];
  }
  const rows: ProcRow[] = [];
  for (const line of out.split('\n')) {
    // pid ppid tty comm — tty is a single token ('ttys003', 's003', or '??'/'?'
    // for none); comm stays last so it may contain spaces.
    const m = line.trim().match(/^(\d+)\s+(\d+)\s+(\S+)\s+(.+)$/);
    if (!m) continue;
    const pid = parseInt(m[1], 10);
    const ppid = parseInt(m[2], 10);
    if (!Number.isFinite(pid) || !Number.isFinite(ppid)) continue;
    const ttyRaw = m[3];
    const tty = ttyRaw === '??' || ttyRaw === '?' || ttyRaw === '-' ? undefined : ttyRaw;
    const commRaw = m[4].trim();
    rows.push({ pid, ppid, tty, comm: commRaw, kind: agentKindFromComm(commRaw) });
  }
  return rows;
}

/**
 * Windows process table in one CIM query (`wmic` is removed on current
 * Windows 11, so PowerShell is the stable interface). Same pid/ppid/comm
 * shape as the POSIX `ps` snapshot; `Name` is the image name (`claude.exe`).
 */
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

/** Parse `ConvertTo-Csv` output of Win32_Process rows. Exported for tests. */
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

/**
 * True when any ancestor in pid's parent chain is a known attributed PID.
 * VS Code / Cursor terminals store the *shell* PID in live-terminals.json,
 * while `ps` reports the *child* claude PID, so a direct set lookup misses.
 */
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

/**
 * Resolve every candidate PID's cwd, bounded and staggered so the probes no
 * longer fan out as one simultaneous system-wide `lsof` burst (a behavioral-EDR
 * recon trigger). Order matches the input `pids`. The `probe` seam is injectable
 * for testing the bound; production always uses the real `lsof`-backed probe.
 */
export function resolveCwds(
  pids: number[],
  probe: (pid: number) => Promise<string | undefined> = getCwdForPid,
): Promise<(string | undefined)[]> {
  return mapBounded(pids, probe, { concurrency: LSOF_CONCURRENCY, staggerMs: LSOF_STAGGER_MS });
}

/**
 * Resolve a process's current working directory via `lsof`. The `-a` flag
 * ANDs the filters; without it macOS treats `-p` and `-d` as a union and
 * returns the cwd of every process on the system.
 */
async function getCwdForPid(pid: number): Promise<string | undefined> {
  // No lsof on Windows and no cheap foreign-process cwd API; the pid registry
  // written by `ag run` supplies the cwd for registry-launched agents instead.
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

/**
 * Walk a pid's ancestor chain and return the most specific host app found.
 * Checks each HOST_MATCHERS entry against every ancestor, returns the first
 * host whose tokens match — so IDEs beat terminal apps, terminals beat
 * multiplexers. Returns undefined if nothing is recognised (true headless).
 */
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

/**
 * Resolve the host app for a single pid by walking its process ancestry with the
 * same HOST_MATCHERS logic `detectHost` uses. Reads the whole process table per
 * call, so it's for the low-cardinality renderer path (one tmux client per
 * session), not a hot loop. Returns undefined when nothing above the pid is a
 * recognised UI. Exported for the "viewing in <app>" resolver.
 */
export async function hostFromPid(pid: number): Promise<string | undefined> {
  if (!pid || pid < 1) return undefined;
  const procByPid = new Map<number, ProcRow>();
  for (const r of await readProcessTable()) procByPid.set(r.pid, r);
  return detectHost(pid, procByPid);
}

/** IDE / terminal / multiplexer hosts all count as UI-hosted. Absence = truly headless. */
const UI_HOSTS = new Set<string>([
  'code', 'cursor', 'codium', 'windsurf',
  'iterm', 'terminal', 'warp', 'alacritty', 'kitty', 'hyper', 'wezterm', 'ghostty',
  'tmux', 'screen',
]);

export interface AgentCandidate { pid: number; kind: string; }

/**
 * Find the launch registry entry recorded by a WRAPPER of this process. The
 * shim delegate records the pid it spawned, but on Windows the `.cmd` shell
 * path makes that a cmd.exe intermediary whose child is the real agent binary
 * — so the agent pid itself has no entry and the wrapper one ancestor up does.
 * The nearest entry wins, and only if its agent matches the candidate's kind:
 * a claude session shelling out to codex must not hand codex its identity.
 */
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

/**
 * Collapse agent processes spawned by another live agent process of the same
 * kind onto their nearest kept ancestor. Claude runs subagents, forks, and
 * even its bundled ripgrep as child `claude` processes — on POSIX those
 * children resolve to the parent's cwd and collapse in dedupeBySession, but
 * where no cwd can be recovered (Windows has no lsof) every fork would print
 * as its own headless row. Two exceptions keep their own row: a candidate with
 * its own registry entry — on its pid OR on a wrapper ancestor strictly below
 * the pid it would fold into (the shim's entry lands on the cmd.exe
 * intermediary on Windows) — a child whose live argv carries `--session-id`
 * (RUSH-2384: empty by-pid must not fold a real session into a parent and
 * drop it from the active set) — and a child of a *different* agent kind
 * (claude shelling out to codex is a real second session, not a fork).
 * Returns the kept roots plus, per root pid, how many descendants folded in.
 *
 * `hasLiveSessionId` defaults to reading `--session-id` from the live process
 * argv; tests inject a pure predicate so they do not need real agent pids.
 */
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

  // Own launch identity: a matching-kind registry entry on the candidate or on
  // any wrapper between it and the pid it would fold into (exclusive). Entries
  // above the fold target belong to that ancestor's session, not this one.
  // A live `--session-id` on argv is also own identity (RUSH-2384) — the
  // registry is often empty while the process still names its session.
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
    // Walk up through folded intermediates to the nearest kept same-kind pid.
    let cur = nearestSameKindAncestor(c.pid, c.kind);
    const seen = new Set<number>();
    while (cur !== undefined && !keptPids.has(cur) && !seen.has(cur)) {
      seen.add(cur);
      cur = nearestSameKindAncestor(cur, c.kind);
    }
    // A fold target must itself be a kept row (a ppid cycle from pid reuse
    // can orphan the whole chain) — otherwise keep the row rather than drop it.
    if (cur === undefined || !keptPids.has(cur)) { kept.push(c); continue; }
    foldedByRoot.set(cur, (foldedByRoot.get(cur) ?? 0) + 1);
  }
  return { kept, foldedByRoot };
}

/**
 * Agent processes not attributed to a team or the runtime registry.
 * Classified by walking the ppid chain: any recognised UI ancestor (IDE
 * helper, terminal-app, or multiplexer) means `terminal`; nothing of the
 * sort means `headless` (daemon, launchd-spawned, orphan).
 *
 * Full `ps`+`lsof` rescans are throttled to {@link UNATTRIBUTED_RESCAN_MS}
 * (#2047). Between rescans the previous rows are re-emitted after dropping
 * dead PIDs and PIDs that are now attributed. A shrinking attributed set
 * forces a rescan so a process that just left teams/terminals can reappear
 * as headless.
 */
export async function listUnattributedActive(attributed: Set<number>): Promise<ActiveSession[]> {
  const now = activeScanNow();
  if (
    unattributedCache &&
    now - unattributedCache.at < UNATTRIBUTED_RESCAN_MS &&
    !attributedSetLostPids(unattributedCache.attributed, attributed)
  ) {
    return filterCachedUnattributed(unattributedCache.sessions, attributed, isPidAlive);
  }
  const out = await listUnattributedActiveLive(attributed);
  unattributedCache = { at: now, attributed: new Set(attributed), sessions: out };
  return out;
}

/** Unthrottled headless scan (live process table + cwd probes). */
async function listUnattributedActiveLive(attributed: Set<number>): Promise<ActiveSession[]> {
  unattributedFullRescans += 1;
  const table = await readProcessTable();
  const procByPid = new Map<number, ProcRow>();
  const ppidMap = new Map<number, number>();
  for (const r of table) {
    procByPid.set(r.pid, r);
    ppidMap.set(r.pid, r.ppid);
  }

  // Candidate PIDs first — we only shell out to lsof for these, not the whole table.
  const candidates: AgentCandidate[] = [];
  for (const { pid, kind } of table) {
    if (!kind) continue;
    if (attributed.has(pid)) continue;
    if (hasAttributedAncestor(pid, ppidMap, attributed)) continue;
    candidates.push({ pid, kind });
  }

  // Forks/subagents of a live agent process collapse onto their root before
  // the cwd probes — fewer spawns, and one session stays one row even when
  // cwd-based dedupe is unavailable (Windows).
  const { kept, foldedByRoot } = foldSubordinateAgents(candidates, ppidMap, readPidSessionEntry);

  // Bounded + staggered lsof probes: same cwds, but a trickle of spawns instead
  // of one simultaneous system-wide burst that behavioral EDR flags as recon.
  const cwds = await resolveCwds(kept.map(c => c.pid));

  // The hook state dir is scanned at most ONCE per active-scan, and the ppid map
  // is inverted at most once — both built lazily on the first candidate that
  // lacks an exact launch-time id, so an all-Claude set does neither. The ~3s
  // poll must not re-read the dir (or re-invert the map) per candidate.
  let hookIndex: HookSessionIndex | undefined;
  let childrenByParent: Map<number, number[]> | undefined;
  // Durable `agents run --name` handles keyed by session id — the same source the
  // terminal path uses to name a row. Headless agents have no live-terminals
  // label and no /rename, so without this a `--name`d headless run would surface
  // with only a topic and no tab title. Built once per scan.
  const runNameMap = buildRunNameMap();
  const ensureChildren = (): Map<number, number[]> => {
    if (childrenByParent) return childrenByParent;
    const m = new Map<number, number[]>();
    // The hook records under the agent pid; a wrapper/shell pid we recorded has
    // the agent as a child, so we resolve via a recorded pid's immediate children.
    for (const [childPid, parentPid] of ppidMap) {
      const arr = m.get(parentPid);
      if (arr) arr.push(childPid);
      else m.set(parentPid, [childPid]);
    }
    childrenByParent = m;
    return m;
  };

  const out: ActiveSession[] = [];
  for (let i = 0; i < kept.length; i++) {
    const { pid, kind } = kept[i];
    // The per-pid registry (written by `ag run` and the shim delegate) gives
    // the EXACT session id this pid was launched with — so N agents in one cwd
    // resolve to N distinct sessions instead of all collapsing onto the newest
    // .jsonl. The shim's entry may sit on a wrapper ancestor (Windows .cmd
    // path). Absent entirely (direct launch outside agents-cli) → heuristic.
    const entry = readPidSessionEntry(pid) ?? readAncestorSessionEntry(pid, ppidMap, kind);
    // Exact session id, in priority: (1) the id we recorded at launch (Claude,
    // known up front via --session-id); (2) the live process's own argv
    // `--session-id` (RUSH-2384 — by-pid is often empty mid-run while the
    // process still advertises the id); (3) the agent's OWN SessionStart hook,
    // authoritative for non-Claude and for agents we didn't launch, joined by
    // launchId/terminalId/pid and kind-guarded against a stale reused-pid file;
    // (4) the newest-jsonl heuristic (sessionIdFromFile, below).
    let exactId = entry?.sessionId ?? sessionIdFromLivePid(pid);
    // The hook record (when we fall to it) also carries the SessionStart `ts` — the
    // real session-start epoch. Capture it so terminal/headless rows get a
    // `startedAtMs` instead of rendering "0s ago" (they set none before this).
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
    // RUSH-2501: the hook-sessions index (terminals/sessions/) is populated only
    // by @agents/session-tracker, which is not deployed on most fleet machines.
    // The DEPLOYED SessionStart hook writes to state/sessions/<pid>.json instead.
    // Try that path when the index lookup found nothing, so cursor/grok/kimi/droid
    // agents (which carry no --session-id argv) can be attributed.
    if (!exactId) {
      const stateRec = readStateSessionRecord(pid, entry?.startedAtMs);
      if (stateRec) exactId = stateRec.session_id;
    }
    const cwd = cwds[i] ?? entry?.cwd ?? undefined;
    const sessionFile = findSessionFileForKind(kind, cwd, exactId);
    const topic = sessionFile ? quickExtractTopic(sessionFile) : undefined;
    const host = detectHost(pid, procByPid);
    const context: ActiveContext = host && UI_HOSTS.has(host) ? 'terminal' : 'headless';
    // pidAlive is true by construction: this pid was just enumerated from the
    // live process table, so an opaque (non-parseable) kind resolves to
    // `running`, not a fake `idle` or blanket `unknown`.
    const { state, tokPerSec } = computeLiveSignals(kind, sessionFile, cwd, true);
    const { birthtimeMs, mtimeMs } = sessionFileTimes(sessionFile);
    // Durable run name from `agents run --name`, resolved by the run's session id
    // — the tab-title handle for a run we launched by name. A headless row carries
    // no /rename label and no live-terminals label, so this handle IS its label
    // (mirrors listTeamsActive `label: a.name`). Absent a `--name`, label stays
    // undefined and the display falls back to the topic on its own — no band-aid.
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
      // Session start: the hook's authoritative SessionStart `ts`, else the
      // transcript's creation time. Last activity: the transcript's last write.
      startedAtMs: hookRec?.ts ?? birthtimeMs,
      lastActivityMs: mtimeMs,
      pidCount: 1 + (foldedByRoot.get(pid) ?? 0),
      owner: resolveOwner(entry?.actor, resolvedId),
      terminalId: entry?.terminalId,
    }, state, sessionFile, true));
  }
  // Housekeeping: drop registry files for pids that have since died.
  prunePidSessionRegistry(isPidAlive);
  return out;
}

/** One tmux pane's resolved agent identity for the authoritative source. */
interface PaneIdentity {
  agent: string;
  /** Custom harness/profile name from the launch registry, when set. */
  harness?: string;
  /** Exact session id when resolvable (launch registry, or the hook join). */
  sessionId?: string;
  /** The agent's OS pid from the launch registry (may differ from `pane_pid`). */
  pid?: number;
}

/**
 * Attribute a single tmux pane to the agent actually running in it.
 *
 * The launch registry — written per bare-spawn AND per wrap, each stamped with the
 * `tmuxPane` it targeted (see src/lib/exec.ts) — is the EXACT, per-pane source of
 * truth. So an agent spawned into an EXISTING pane (a split, where `$TMUX` is
 * already set so no new session meta is stamped) is attributed to its OWN launch,
 * not the session's original agent — closing the gap where such an agent was
 * dropped by this source and left to the weaker ps-scan fallback. Session-meta
 * labels remain the fallback for the wrapped origin pane of a session whose
 * registry entry is absent (a failed best-effort write, or a legacy session that
 * predates the registry's `tmuxPane` field) — and ONLY for that origin pane
 * (`meta.pane`), so a split shell pane of a labeled session isn't mis-attributed
 * the wrapped agent. When `meta.pane` is unknown (attach-existing sessions), any
 * labeled pane is accepted and the caller's per-session dedupe keeps one.
 * `source: 'teams'` panes are skipped — teammates are surfaced by listTeamsActive.
 * Pure so it is unit-tested without tmux.
 */
export function resolvePaneIdentity(
  pane: string,
  sessName: string,
  meta: { labels?: Record<string, string>; source?: string; pane?: string } | null,
  liveEntry: PidSessionEntry | undefined,
  getHookIndex: () => HookSessionIndex,
  nameToFullId: Map<string, string>,
): PaneIdentity | undefined {
  if (meta?.source === 'teams') return undefined;
  // The tmux session name encodes the agent kind (100% of ag-* panes) and, for a
  // spawn whose id was known at creation (Claude), the session-id prefix — already
  // resolved to a full UUID in the batch map. It is the last-resort id source when
  // every durable record is missing (the common fleet case: meta/pid-reg/hook all
  // ~3% populated), and would otherwise leave the pane id-less and mis-collapsed.
  const nameAgent = agentKindFromName(sessName);
  const nameSessionId = nameToFullId.get(sessName);
  if (liveEntry) {
    // Exact id: the id recorded at launch (Claude), else the agent's own
    // SessionStart hook joined by launchId/terminalId (non-Claude, or agents we
    // didn't launch) — kind-guarded against a stale reused-pid file — else the id
    // carried in the pane's own tmux name.
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
  // No live-registry entry. Session-meta labels are the wrapped-origin fallback;
  // prefer them, then fall back to the name so a pane with neither a registry
  // entry nor meta labels still resolves (agent from the name, id from the batch
  // map when present) instead of being dropped and mis-attributed by the ps-scan.
  const agent = meta?.labels?.agent;
  const sessionId = meta?.labels?.sessionId;
  if (agent && sessionId && (meta?.pane == null || meta.pane === pane)) return { agent, sessionId };
  if (nameAgent) return { agent: nameAgent, sessionId: nameSessionId };
  return undefined;
}

/**
 * Agents hosted in the shared-socket tmux server — the authoritative source for
 * tmux-hosted interactive spawns (see src/lib/exec.ts `runInTmux`). Enumerates
 * every pane on the shared socket and attributes each to the agent running in it
 * via {@link resolvePaneIdentity}: the per-pane launch registry (exact) first, the
 * session-meta labels as fallback. Because tmux (not a per-window
 * `live-terminals.json`) is the source of truth, a tmux-hosted agent is captured
 * with its exact `%pane` even when the extension registry is stale — INCLUDING an
 * agent bare-spawned into a split of an existing session, which older logic dropped
 * (it kept only the first pane per session meta). `source: 'teams'` is skipped.
 */
export async function listTmuxAgentSessions(): Promise<ActiveSession[]> {
  const { getDefaultSocketPath } = await import('../tmux/paths.js');
  const { readSessionMeta } = await import('../tmux/session.js');
  const { runTmux } = await import('../tmux/binary.js');
  const socket = getDefaultSocketPath();
  // No server has ever run on this socket — genuinely nothing to report, not
  // a degraded read. Distinct from the throws below, which mean tmux truth
  // exists but could not be read (RUSH-2507).
  if (!fs.existsSync(socket)) return [];

  let res;
  try {
    res = await runTmux({
      socket,
      args: ['list-panes', '-a', '-F', ['#{pane_id}', '#{session_name}', '#{pane_pid}', '#{pane_dead}', '#{pane_current_path}'].join(TMUX_FIELD_SEP)],
      throwOnError: false,
      // A wedged tmux server must not hang the whole active-session scan. The
      // catch below turns a timeout into a DEGRADED-tmux-source signal (the
      // other sources still report) rather than a frozen `agents sessions
      // --active` — and, crucially, no longer collapses into the same silent
      // `[]` a genuinely-idle socket returns (RUSH-2507).
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

  // Index live launches by the pane they target, so a pane we did NOT wrap (a
  // split) resolves to its own agent. Newest launch wins a pane (pid reuse), and
  // only live pids count — a dead agent's stale entry can't light up its old pane.
  const liveByPane = new Map<string, PidSessionEntry>();
  for (const e of listPidSessionEntries()) {
    if (!e.tmuxPane || !isPidAlive(e.pid, e.startedAtMs)) continue;
    const prev = liveByPane.get(e.tmuxPane);
    if (!prev || e.startedAtMs > prev.startedAtMs) liveByPane.set(e.tmuxPane, e);
  }
  // Hook index is scanned lazily — only when a live launch lacks a recorded id
  // (a non-Claude split) and needs the SessionStart-hook join.
  let hookIndex: HookSessionIndex | undefined;
  const getHookIndex = (): HookSessionIndex => (hookIndex ??= loadHookSessionIndex());

  // Resolve every `ag-<agent>-<shortid>` pane name to its full session UUID in one
  // batched DB round-trip, so resolvePaneIdentity can recover the id straight from
  // the pane name — the signal present on 100% of ag-* panes when the durable
  // identity stores are empty.
  const nameToFullId = resolveNamesToSessionIds(
    res.stdout.split('\n').map((l) => l.split(TMUX_FIELD_SEP)[1]).filter((n): n is string => !!n),
    { findSessionsByShortIds },
  );

  const out: ActiveSession[] = [];
  const seen = new Set<string>();
  for (const line of res.stdout.split('\n')) {
    if (!line.trim()) continue;
    // The path is the LAST field, so rejoin its tail: a directory containing the
    // separator must not truncate it (the earlier fields cannot contain one).
    const parts = line.split(TMUX_FIELD_SEP);
    const [pane, sessName, pidRaw, paneDeadRaw] = parts;
    const curPath = parts.slice(4).join(TMUX_FIELD_SEP);
    if (!pane || !sessName) continue;
    const meta = readSessionMeta(sessName);
    const liveEntry = liveByPane.get(pane);
    let id = resolvePaneIdentity(pane, sessName, meta, liveEntry, getHookIndex, nameToFullId);
    // Only a genuinely foreign pane — no live entry, no meta labels, and not one
    // of our `ag-*` names — is dropped now; every agent pane survives to be either
    // id-resolved or emitted as its own distinct id-less row.
    if (!id) continue;
    // RUSH-2007 Layer A: a non-Claude tmux session whose id resolved via neither the
    // launch registry (no id minted at spawn) nor the session-tracker index (not
    // deployed on the fleet — its dir is empty) — backfill it from the DEPLOYED
    // hook's own per-pid record at state/sessions/<pid>.json. Targeted single-file
    // reads on the pane leaf pid, then the registry launch pid; freshness-guarded by
    // the launch's known start so a reused-pid graveyard file can't cross sessions.
    // Without this the session surfaces id-less (keyed on the bare pane) and is
    // invisible to `agents sessions focus` — the remaining RUSH-2007 discovery gap.
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
    // Dedupe by resolved session id; an as-yet-unresolved id (a hookless/lagging
    // split) keys on the unique pane so it still surfaces as its own row.
    const dedupKey = id.sessionId ?? pane;
    if (seen.has(dedupKey)) continue;
    seen.add(dedupKey);

    // Prefer the registry pid (the agent), falling back to the pane leaf pid. A
    // pid we emit here goes into getActiveSessions' attributed set, so the ps-scan
    // does NOT also surface this agent as a duplicate headless row.
    const pid = id.pid ?? (parseInt(pidRaw, 10) || undefined);
    const cwd = liveEntry?.cwd ?? meta?.cwd ?? (curPath || undefined);
    // Only resolve a transcript when we KNOW the session id. With no id,
    // findSessionFileForKind falls back to the newest .jsonl in the cwd — which
    // collapses every co-located pane onto one stranger's transcript (the ×N-badge
    // bug). Refuse to guess: an id-less pane surfaces as its own row instead.
    const sessionFile = id.sessionId ? findSessionFileForKind(id.agent, cwd, id.sessionId) : undefined;
    const topic = sessionFile ? quickExtractTopic(sessionFile) : undefined;
    // `remain-on-exit` retains the pane after its child exits. pane_dead is the
    // authoritative signal; a retained pane is diagnostic, not attachable.
    const paneDead = paneDeadRaw === '1';
    const pidAlive = !paneDead && (pid ? isPidAlive(pid, liveEntry?.startedAtMs) : true);
    const { state, tokPerSec } = computeLiveSignals(id.agent, sessionFile, cwd, pidAlive);
    const { birthtimeMs, mtimeMs } = sessionFileTimes(sessionFile);
    // The mux/reply rails are known exactly here (the pane IS a tmux pane), so we
    // stamp them off the pane. `transport:'local'` is only a placeholder: the pane
    // can't reveal how the shell above it was reached. enrichProvenance later reads
    // the pane process's env and upgrades this to 'ssh' (with the real origin) when
    // SSH_CONNECTION is present, while preserving this mux/reply.
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
      // Prefer the launch registry's start when known (more accurate than
      // transcript birth for a resumed/reused file); else transcript times.
      startedAtMs: liveEntry?.startedAtMs ?? birthtimeMs,
      lastActivityMs: mtimeMs,
      provenance,
      owner: resolveOwner(liveEntry?.actor, id.sessionId ?? sessionIdFromFile(sessionFile)),
      // Factory / --active join key: AGENT_TERMINAL_ID stamped on the launch
      // registry and preserved by SessionStart. Without this, Grok/Codex tmux
      // panes never surface terminalId even when by-pid has it (RUSH-2192).
      terminalId: liveEntry?.terminalId,
      // An id-less pane keys its dedupe on the unique pane, so two anonymous
      // co-located panes stay two rows instead of folding into one.
      paneId: id.sessionId ?? sessionIdFromFile(sessionFile) ? undefined : pane,
    }, state, sessionFile, pidAlive));
  }
  return out;
}

/**
 * Union of all sources. Teams and terminals spawn actual CLI processes that
 * also show up in `ps`, so headless attribution runs last with the already-
 * attributed PIDs removed. The tmux source goes FIRST into the dedupe so a
 * tmux-hosted agent's row (which carries the exact `%pane`) wins over a staler
 * terminal/headless row for the same session id.
 */
export async function getActiveSessions(opts: ActiveQueryOptions = {}): Promise<ActiveSession[]> {
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
  // Runs before the row leaves this box so every consumer — local render, the
  // `--json` a peer answers a fan-out with, the browser's device filter — sees
  // the EXECUTION host rather than the dispatcher (RUSH-2479).
  foldExecutionMachine(merged, recordedMachineLookup(merged), machineId());
  annotateOrchestratorLabels(merged);
  // Last: derive the shown title (recap ladder) from label/tail/topic now that
  // every row's live tail + label are resolved (RUSH-3011).
  foldRecap(merged);
  // Project the coarse lifecycle bucket once status is final (foldHostLink above may
  // have promoted a row to orphaned/crashed) so consumers read `phase` off the row
  // instead of re-deriving it (PHNX-2484).
  foldPhase(merged);
  return merged;
}

/** Local discovery sources probed by {@link describeActiveDiscoveryHealth}. */
interface ActiveDiscoveryHealth {
  /** Sources that failed on the probe (currently only `'tmux'`). Empty = nothing degraded locally. */
  degradedSources: string[];
}

/**
 * Cheap post-hoc health probe for the local discovery sources. `getActiveSessions`
 * always swallows a source failure to `[]` so its return type stays a plain
 * session array — this re-probes the same sources and reports which ones threw,
 * so a caller that got an empty list back can tell "genuinely nothing running"
 * apart from "a source errored and got silently folded into empty" (RUSH-2507).
 * Intended for the empty-result branch only, not the hot path — it repeats a
 * `list-panes` call `getActiveSessions` already made.
 */
export async function describeActiveDiscoveryHealth(): Promise<ActiveDiscoveryHealth> {
  const degradedSources: string[] = [];
  try {
    await listTmuxAgentSessions();
  } catch (err) {
    if (err instanceof TmuxDiscoveryDegradedError) degradedSources.push('tmux');
  }
  return { degradedSources };
}

/**
 * True when a live agent process on this host carries `--session-id <id>` in
 * its argv. RUSH-2384 last-resort for `agents message`: getActiveSessions can
 * still miss a row (teams status flap, attributed-ancestor skip), but the
 * process table + argv are ground truth for "this session is alive and
 * mailbox-reachable". Only UUID-shaped ids are accepted so a short prefix
 * never false-matches.
 */
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

/**
 * Fold tmux's attached-client count onto every tmux-hosted row.
 *
 * Keyed off `provenance.mux` — which {@link enrichProvenance} has already stamped
 * on any row whose process env names a tmux pane — rather than off
 * {@link listTmuxAgentSessions}. That source only emits a row when it can resolve
 * the pane's agent IDENTITY (launch registry or session meta), and on a machine
 * where neither resolves it emits nothing at all while the same sessions still
 * arrive through the terminal/headless sources carrying full tmux provenance.
 * Hanging the client count off the identity-resolving source would have made the
 * whole orphan signal silently dead on exactly those machines.
 *
 * One `list-panes` per distinct socket, and only when some row is tmux-hosted —
 * a fleet with no tmux pays nothing. A query failure leaves the count undefined,
 * which the classifier reads as "cannot tell", never as a false zero.
 */
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
        // A tmux too old to report `session_attached` yields NaN — leave the pane
        // unmapped so it stays "cannot tell" rather than becoming a false zero.
        if (Number.isFinite(n)) byPane.set(pane, n);
      }
    } catch {
      continue; // best-effort: no count is honest, a guessed count is not
    }
    for (const s of tmuxRows) {
      if (s.provenance!.mux!.socket !== socket) continue;
      const n = byPane.get(s.provenance!.mux!.pane!);
      if (n !== undefined) s.tmuxClients = n;
    }
  }
}

/**
 * Fold the host link onto each row and, where it changes the answer, onto the
 * status. Runs AFTER {@link foldPresence}, because a deliberately backgrounded
 * session (`presence` `background`/`parked`) is supposed to have no client and
 * must not be reported as an orphan.
 *
 * Precedence is deliberate, and the two new statuses slot in where they add
 * information rather than destroy it:
 *
 *   - `abandoned` wins outright. A days-stale session is already dangling; that
 *     it also lost its window is not the headline, and it keeps a crashed row
 *     from lingering as an alert forever.
 *   - `crashed` REPLACES `closed`. Both mean the process is gone, but `closed`
 *     reads as a normal exit; `crashed` says the host window went down with it
 *     and never cleaned up.
 *   - `orphaned` replaces `idle` / `input_required` on ANY `no-client`, and
 *     `running` ONLY when the owning WINDOW was lost (`hostWindowLost`). A
 *     session still working with merely zero tmux clients is a normal headless
 *     run — since RUSH-3125 a detached remote pane is the steady state — so
 *     flagging every one would bury the real signal (the false positive reverted
 *     in 6d973b823). But a running agent whose IDE window stopped republishing
 *     its heartbeat outlived an unclean host death and is genuinely stranded, so
 *     it IS promoted. A session sitting idle — or worse, waiting on a question —
 *     with no client attached is the same stranded case: nobody is coming.
 */
/**
 * Attribute each live row to the machine the session actually EXECUTES on.
 *
 * A host-dispatched run (`agents run --device <peer>`) leaves a live process on
 * the DISPATCHING box — the ssh/TTY shim — carrying the remote run's session id.
 * Nothing about that local process knows the agent is on the peer, so the row
 * was tagged with THIS machine: `--device <dispatcher>` then claimed a session
 * that is not running here, and its preview dead-ended at "full transcript not
 * indexed here" because the transcript lives on the peer (RUSH-2479).
 *
 * The dispatch already recorded the truth. `registerHostSession` /
 * `registerInteractiveHostSession` write the index row with
 * `machine: normalizeHost(task.host)` (`lib/hosts/session-index.ts:55,134`), so
 * this folds that recorded machine back onto the live row. Every consumer then
 * agrees on one owner: the `--device`/`--device` scope, the browser's device
 * filter, `_remote`/preview routing (`liveSessionToMeta`), and the id resolver.
 *
 * Two rows are deliberately left alone:
 *   - one the cross-machine fan-out already attributed to a peer — that is the
 *     peer's own self-report, which outranks this box's index copy;
 *   - one whose indexed machine IS this box — nothing was offloaded.
 *
 * Pure over the array; `machineOf` is injected so the join is unit-tested
 * without a SQLite index.
 */
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

/**
 * Is the PROCESS behind this row running on this machine?
 *
 * `machine` answers a different question — "where does the agent execute" —
 * which is what a `--device` scope, preview routing, and resume ownership need.
 * For an offloaded run the two answers diverge: {@link foldExecutionMachine}
 * points `machine` at the peer, while the shim process, its tmux pane, and its
 * terminal window are all still HERE. `offloadedFrom` marks exactly that row.
 *
 * Any caller reaching for a LOCAL pid, pane, or window must ask this rather
 * than `machine === self`. A local tmux pane id (`%N`) handed to a peer's tmux
 * server does not fail — pane ids are small per-server integers, so it can
 * resolve against an unrelated pane and attach the user to someone else's
 * session. That is why this predicate exists instead of ten copies of the
 * comparison.
 */
export function sessionProcessIsLocal(s: Pick<ActiveSession, 'machine' | 'offloadedFrom'>, self: string): boolean {
  // `offloadedFrom` names WHICH box holds the shim, so it must be compared, not
  // merely tested. These rows travel: `--active --json` spreads them verbatim
  // and the fan-out preserves their foreign `machine`, so a THIRD box sees
  // `{machine: B, offloadedFrom: A}` — a shim that is emphatically not its own.
  // Answering "local" there sends the caller down the local-tmux path with
  // A's pane id, attaching an unrelated pane on C: the same hazard this
  // predicate exists to prevent, one machine over.
  if (s.offloadedFrom) return s.offloadedFrom === self;
  return !s.machine || s.machine === self;
}

/**
 * The machine to reach for this session's PROCESS — its pid, tmux pane, and
 * window — or `undefined` when that process is right here.
 *
 * Not the same as `machine`, which is where the AGENT executes. For an offloaded
 * run the process lives on the dispatcher (`offloadedFrom`) while the agent runs
 * on the peer, so a caller that ssh'd to `machine` would carry the dispatcher's
 * pane id to a box that never had it.
 */
export function sessionProcessHost(
  s: Pick<ActiveSession, 'machine' | 'offloadedFrom'>,
  self: string,
): string | undefined {
  if (sessionProcessIsLocal(s, self)) return undefined;
  return s.offloadedFrom ?? s.machine;
}

/**
 * The index lookup behind {@link foldExecutionMachine}. One batched query for
 * every live row (`findSessionMachinesByIds`), not a per-row `SELECT *` —
 * `getActiveSessions` is a hot path the daemon, menubar, and watchdog all poll.
 * Best-effort: an unavailable DB yields an empty map, leaving rows attributed
 * to this box rather than failing the whole live view.
 */
function recordedMachineLookup(rows: ActiveSession[]): (sessionId: string) => string | undefined {
  const byId = findSessionMachinesByIds(rows.map((s) => s.sessionId).filter((id): id is string => !!id));
  return (id) => byId.get(id);
}

export function foldHostLink(rows: ActiveSession[]): void {
  for (const s of rows) {
    // Cloud tasks have no local pid, window, or tmux server; there is no host
    // link to classify and no honest answer to give.
    if (s.context === 'cloud') continue;
    // A days-stale row is already `abandoned`; whether its window is also gone
    // adds nothing, and its pid liveness is genuinely unknown from the status
    // (abandoned outranks closed), so claim no host link rather than guess one.
    if (s.status === 'abandoned') continue;
    // `closed` IS the dead-pid status — `lifecycleStatus` assigns it from
    // `!pidAlive` and nothing else — so the status is the pid answer here.
    const signals = {
      pidAlive: s.status !== 'closed',
      windowHeartbeatMs: s.windowHeartbeatMs,
      tmuxClients: s.tmuxClients,
      deliberatelyDetached: s.presence === 'background' || s.presence === 'parked',
    };
    const link = classifyHostLink(signals);
    s.hostLink = link;
    // `foldPresence` gives every terminal row a DERIVED `attached` — "a live
    // interactive TUI you're watching" — which is exactly the claim a lost host
    // disproves. A stored record never yields `attached` (it is background or
    // parked), so clearing only that value drops the derived lie and leaves a
    // real detach record untouched.
    // Only a POSITIVE loss signal disproves a derived `attached`. `unknown` means
    // we never looked — a bare terminal with no IDE window and no tmux has
    // neither input — so it must not clear presence, or every plain-terminal
    // session the user is sitting in would lose its `attached` marker.
    if ((link === 'no-client' || link === 'host-gone') && s.presence === 'attached') {
      s.presence = undefined;
    }
    if (link === 'host-gone' && s.status === 'closed') s.status = 'crashed';
    // A clientless running remote pane is normal; only stopped work can be called orphaned.
    else if (link === 'no-client' && (s.status === 'idle' || s.status === 'input_required')) {
      s.status = 'orphaned';
    }
    // A still-`running` agent is normally a healthy headless run, so 0 tmux
    // clients (a detached remote pane) MUST NOT flag it — that false positive was
    // reverted once already (6d973b823). The ONE exception is a lost WINDOW: its
    // owning IDE window stopped republishing, so it died uncleanly and the agent
    // outlived it — genuinely stranded (PHNX-3183, `hostWindowLost`, SES-18a).
    else if (s.status === 'running' && hostWindowLost(signals)) {
      s.status = 'orphaned';
    }
  }
}

/** One display line, trimmed and capped, or undefined when empty. */
function recapLine(s: string | undefined, max = 120): string | undefined {
  const t = s?.replace(/\s+/g, ' ').trim();
  if (!t) return undefined;
  return t.length > max ? t.slice(0, max - 1).trimEnd() + '…' : t;
}

/** Labels win, then the last assistant line, then the first-prompt topic. */
export function deriveSessionRecap(
  row: Pick<ActiveSession, 'label' | 'topic' | 'tail'>,
): { title?: string; recapSource?: RecapSource; userPromptClean?: string; userPromptKind?: UserPromptKind; lastAgentLine?: string } {
  const lastAgentLine = recapLine(row.tail?.length ? row.tail[row.tail.length - 1] : undefined);
  const { clean: userPromptClean, kind: userPromptKind } = classifyUserPrompt(row.topic ?? '');

  const label = recapLine(row.label);
  const prompt = recapLine(userPromptClean || row.topic);

  let title: string | undefined;
  let recapSource: RecapSource | undefined;
  if (label) { title = label; recapSource = 'label'; }
  else if (lastAgentLine) { title = lastAgentLine; recapSource = 'last'; }
  else if (prompt) { title = prompt; recapSource = 'prompt'; }

  return { title, recapSource, userPromptClean: recapLine(userPromptClean), userPromptKind, lastAgentLine };
}

/** Fold the recap ladder onto every row (see {@link deriveSessionRecap}). */
export function foldRecap(rows: ActiveSession[]): void {
  for (const s of rows) {
    const recap = deriveSessionRecap(s);
    s.title = recap.title;
    s.recapSource = recap.recapSource;
    s.userPromptClean = recap.userPromptClean;
    s.userPromptKind = recap.userPromptKind;
    s.lastAgentLine = recap.lastAgentLine;
  }
}

/**
 * Project a {@link SessionPhase} from the finalized {@link ActiveStatus} (PHNX-2484).
 * This is the single source of truth the AGI EXT previously mirrored as
 * `mapStatusToPhase` — the ext now reads the `phase` field instead of re-deriving it.
 * `queued` counts as `running` (dispatched, in the pipeline); `abandoned`, `orphaned`,
 * and `crashed` all bucket to `failed` (dangling/dead — needs attention), which is the
 * drift this fixes: those three used to fall through a status-only map to `idle` and
 * silently hide a dead agent.
 */
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

/** Fold the coarse lifecycle {@link SessionPhase} onto every row (see {@link derivePhase}). */
export function foldPhase(rows: ActiveSession[]): void {
  for (const s of rows) s.phase = derivePhase(s.status);
}

/** Reap only stale sessions with proven-dead pids; unknown or live processes remain recoverable. */
export function isReapableOrphan(
  row: Pick<ActiveSession, 'status' | 'pidAlive'>,
): boolean {
  return row.status === 'abandoned' && row.pidAlive === false;
}

/**
 * Resolve each teams row's `orchestratorLabel` from the orchestrator's own row,
 * when that orchestrator session is itself in the active set (it usually is — the
 * agent that ran `agents teams add` is running). Falls back to nothing, so the
 * renderer shows the short id. Pure over the array; exported for tests.
 */
export function annotateOrchestratorLabels(sessions: ActiveSession[]): void {
  const byId = new Map<string, ActiveSession>();
  for (const s of sessions) if (s.sessionId) byId.set(s.sessionId, s);
  for (const s of sessions) {
    if (!s.orchestratorSessionId) continue;
    const orch = byId.get(s.orchestratorSessionId);
    if (orch) s.orchestratorLabel = orch.label || orch.topic || undefined;
  }
}

/**
 * Fold detach/attach presence onto each row from the detach store. A stored
 * record wins (`background`/`parked`); otherwise a live terminal session is
 * `attached`. Ad-hoc headless runs and cloud/team rows stay unmarked — they are
 * not on the foreground/background axis.
 */
function foldPresence(rows: ActiveSession[]): void {
  for (const s of rows) {
    if (!s.sessionId) continue;
    const stored = presenceFromStore(s.sessionId);
    if (stored) s.presence = stored;
    else if (s.context === 'terminal') s.presence = 'attached';
  }
}

/**
 * Attach provenance (host / local-vs-SSH / tmux pane / reply rail) to every
 * session that has a live pid. Mutates in place. Runs after dedupe so we probe
 * each session once, not once per fork pid. Probes run in parallel — each is a
 * single /proc read (Linux) or `ps` call (macOS); failures leave `provenance`
 * undefined rather than blocking the listing. The probes use the same bounded
 * concurrency as the adjacent per-PID lsof sweep so large session lists cannot
 * spawn one `ps eww` subprocess per row at once on macOS.
 *
 * A row that already carries provenance (the tmux path, which knows its exact
 * mux/reply from the pane) is not skipped — it is probe-and-MERGED. The tmux
 * path can only stamp a `transport:'local'` placeholder because the pane alone
 * doesn't reveal how the shell above it was reached; the process env does. So we
 * still read the env and fill in the real SSH origin/term, while preserving the
 * authoritative mux/reply the pane already gave us. Skipping this (the old
 * behavior) is exactly why ssh-launched tmux sessions rendered as local.
 */
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
      // Row already carries exact mux/reply (the tmux path). Fill only what a
      // pre-set provenance can't know from the pane alone: the real launch origin.
      if (probed.transport === 'ssh' && !s.provenance.ssh) {
        s.provenance.transport = 'ssh';
        s.provenance.ssh = probed.ssh;
      }
      if (probed.term && !s.provenance.term) s.provenance.term = probed.term;
    },
    { concurrency: LSOF_CONCURRENCY },
  );
}

/**
 * Match an SSH client IP to a registered device (pure — testable with a plain
 * registry object). Returns the device name + ssh login user when the IP is a
 * known device address.
 */
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

/**
 * Resolve the initiating device for every ssh-transport session by matching its
 * `ssh.clientIp` against the device registry. Read-only and best-effort: a
 * registry that can't be loaded, or an IP that matches no device, leaves
 * `origin` undefined (the raw client IP is still on `ssh`). Mutates in place.
 */
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

/**
 * Identity for a row the scan could not tie to a session: a daemon's worker
 * processes (an OpenClaw gateway spawning `codex`, a supervisor pool) have no
 * session id, no transcript file, and no cloud/run handle — nothing tells two of
 * them apart, because nothing distinguishes them. Same binary + same working
 * directory + same context IS the identity, so N indistinguishable workers
 * collapse to one row carrying `pidCount: N`.
 *
 * Returns undefined with no cwd: without it there is no stable identity, and
 * keying on kind alone would fold unrelated agents onto one row.
 */
function anonymousWorkerKey(s: ActiveSession): string | undefined {
  if (!s.cwd) return undefined;
  return `anon\0${s.kind}\0${s.context}\0${s.cwd}`;
}

/**
 * Collapse rows that resolve to the *same* session — a session with many
 * subagent/fork PIDs (all matched to one transcript file) would otherwise print
 * dozens of identical rows. Keyed by session id, falling back to the transcript
 * file, then the cloud/run handle, then {@link anonymousWorkerKey}. The first row
 * wins and carries a `pidCount`.
 */
export function dedupeBySession(sessions: ActiveSession[]): ActiveSession[] {
  const out: ActiveSession[] = [];
  const byKey = new Map<string, ActiveSession>();
  for (const s of sessions) {
    const key = s.sessionId || s.sessionFile || s.cloudTaskId || s.agentId || s.paneId || anonymousWorkerKey(s);
    if (!key) { out.push(s); continue; }
    const existing = byKey.get(key);
    if (existing) {
      // Carry pre-folded fork counts (headless rows arrive with pidCount set).
      existing.pidCount = (existing.pidCount ?? 1) + (s.pidCount ?? 1);
    } else {
      s.pidCount = s.pidCount ?? 1;
      byKey.set(key, s);
      out.push(s);
    }
  }
  return out;
}
