/**
 * Session discovery across Claude, Codex, Gemini, OpenCode, and OpenClaw.
 *
 * Performs incremental scans: each agent's session files are stat'd and compared
 * to a scan-stamp ledger in SQLite. Only files whose mtime or size changed since
 * the last run are re-parsed. All metadata is upserted into the sessions DB so
 * subsequent queries are served entirely from the cache.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';
import * as readline from 'readline';
import { execFile } from 'child_process';
import { promisify } from 'util';
import Database from '../sqlite.js';
import { getAgentsDir, getUserAgentsDir, getHistoryDir, getRunsDir } from '../state.js';
import { shortCodexHome } from '../codex-home.js';
import { parseTimeFilter } from './relative-time.js';

const execFileAsync = promisify(execFile);
import type { SessionAgentId, SessionEvent, SessionMeta, TodoProgress } from './types.js';
import type { AgentId } from '../types.js';
import { AGENTS, agentConfigDirName, getCliVersion, resolveOpenCodeAccountId } from '../agents.js';
import { walkForFilesWithStat } from '../fs-walk.js';
import { hasCommand } from '../cli-resources.js';
import { execFileShellSpec } from '../platform/exec.js';
import { getConfigSymlinkVersion } from '../installations/shims.js';
import { SESSION_AGENTS } from './types.js';
import { deriveShortId } from './short-id.js';
import { buildClaudeAccountIndex, resolveClaudeAccount, type ClaudeAccountIndex } from './claude-accounts.js';
import { extractSessionTopic, extractSlashCommandName, extractSlashCommandFromToolInput } from './prompt.js';
import { isSkillInvocation, extractSkills, extractSlashCommands } from './highlights.js';
import { parseAntigravity, parseCursor, splitSessionFilePath } from './parse.js';
import { extractPrUrl, detectWorktree, detectTicket, isPrCreateCommand, detectSpawnedTeam, isTicketCreateTool, extractCreatedTicket, extractRecentDirectoriesTouched, extractTodoProgressFromEvents } from './state.js';
import { costOfUsage, costOfUsageNoCache } from '../pricing/index.js';
import { machineId } from './sync/config.js';
import { machineForSessionFile } from './origin-machine.js';
export { machineForSessionFile } from './origin-machine.js';
import { mapBounded } from '../concurrency.js';
import {
  getDB,
  getScanStampByPath,
  getScanStampsForPaths,
  getParserStatesForPaths,
  getDirLedgerForPaths,
  recordDirScans,
  recordScans,
  syncLabels,
  seedLabelsFromNames,
  syncTopics,
  upsertSessionsBatch,
  querySessions,
  countSessions,
  ftsSearch,
  tryClaimScan,
  releaseScan,
  scanInProgressByLivePid,
  cacheLinearProject,
  type ScanStamp,
  type DirStamp,
  type QueryOptions,
} from './db.js';
import { buildRunNameMap } from './run-names.js';
import { resolveLinearApiKey } from '../linear-cache.js';
import {
  ToolCallCollector,
  collectClaudeToolCalls,
  collectCodexToolCalls,
  type IndexedToolCall,
  type ToolCallCollectorSnapshot,
} from './tool-calls.js';
import { purgeMissingToolCallsInDirectory } from './tool-store.js';

const HOME = os.homedir();
// Versions can live under either repo: the user repo (current canonical
// location, ~/.agents/.history/versions/) or the system repo (legacy / npm-shipped,
// ~/.agents-system/versions/). Both must be scanned — sessions written by
// any installed version end up in that version's projects/ dir, and the user
// can be running one repo's version while another repo holds older versions
// whose JSONLs the user still wants to search.
const VERSIONS_ROOTS = [getHistoryDir(), getAgentsDir()];
const RUSH_SESSIONS_DIR = path.join(HOME, '.rush', 'sessions');
const HERMES_SESSIONS_DIR = path.join(HOME, '.hermes', 'sessions');
/** Muse Code sessions: ~/.local/share/muse/sessions/YYYY/MM/DD/<uuid>/session.jsonl */
const MUSE_SESSIONS_DIR = path.join(HOME, '.local', 'share', 'muse', 'sessions');

/** How long OpenClaw channel/cron snapshots stay valid before we re-shell-out. */
const OPENCLAW_TTL_MS = 60_000;
const ACTIVE_APPEND_RESCAN_DEBOUNCE_MS = 5_000;
/** One JSONL record may not force an unbounded string allocation. */
const SESSION_JSONL_LINE_MAX_BYTES = 1024 * 1024;

/**
 * Stream one appended JSONL range, applying only newline-terminated records.
 * Memory is bounded to one record. An ordinary unterminated tail remains for the
 * next scan. Once a record exceeds the cap, its consumed offset and a one-bit
 * dropping state advance together so later scans never reread the growing tail.
 */
async function applyJsonlAppend(
  filePath: string,
  fromOffset: number,
  wasDroppingOversizedLine: boolean,
  apply: (parsed: any) => void,
): Promise<{ consumedBytes: number; droppingOversizedLine: boolean; skippedOversizedLine: boolean }> {
  let pending = Buffer.alloc(0);
  let droppingOversizedLine = wasDroppingOversizedLine;
  let bytesBeforeChunk = 0;
  let consumedBytes = 0;
  let skippedOversizedLine = false;
  const stream = fs.createReadStream(filePath, { start: fromOffset });
  try {
    for await (const rawChunk of stream) {
      const chunk = typeof rawChunk === 'string' ? Buffer.from(rawChunk, 'utf-8') : rawChunk as Buffer;
      let cursor = 0;
      for (;;) {
        const newline = chunk.indexOf(0x0a, cursor);
        if (newline === -1) {
          if (!droppingOversizedLine) {
            const tail = chunk.subarray(cursor);
            if (pending.length + tail.length > SESSION_JSONL_LINE_MAX_BYTES) {
              pending = Buffer.alloc(0);
              droppingOversizedLine = true;
              skippedOversizedLine = true;
            } else if (tail.length > 0) {
              pending = pending.length > 0 ? Buffer.concat([pending, tail]) : Buffer.from(tail);
            }
          }
          if (droppingOversizedLine) consumedBytes = bytesBeforeChunk + chunk.length;
          break;
        }

        if (!droppingOversizedLine) {
          const segment = chunk.subarray(cursor, newline);
          if (pending.length + segment.length <= SESSION_JSONL_LINE_MAX_BYTES) {
            const line = (pending.length > 0 ? Buffer.concat([pending, segment]) : segment).toString('utf-8');
            if (line.trim()) {
              try {
                apply(JSON.parse(line));
              } catch {
                // One malformed line never aborts the session scan.
              }
            }
          } else {
            skippedOversizedLine = true;
          }
        }
        pending = Buffer.alloc(0);
        droppingOversizedLine = false;
        consumedBytes = bytesBeforeChunk + newline + 1;
        cursor = newline + 1;
      }
      bytesBeforeChunk += chunk.length;
    }
  } finally {
    stream.destroy();
  }
  return { consumedBytes, droppingOversizedLine, skippedOversizedLine };
}

/**
 * How recently a file must have been scanned to be treated as "hot" — a
 * candidate for an in-place append even when its parent dir's mtime hasn't
 * moved. A dir-ledger match lets us skip the per-file stat of everything in a
 * leaf dir EXCEPT its hot set; a file is hot if it lives under the agent's live
 * `~/.<agent>` root (the only tree an agent appends to live) or was scanned
 * within this window. 10 minutes comfortably covers a session that paused
 * between `agents sessions` calls but is still being written to.
 */
const HOT_FILE_WINDOW_MS = 600_000;

/**
 * Kill-switch: set `AGENTS_SESSIONS_NO_DIR_LEDGER=1` to force the old full-walk
 * path (readdir + per-file stat every dir, every run — the pre-A-2 behavior),
 * skipping the dir_ledger short-circuit entirely. One env var reverts a field
 * regression to today's behavior.
 */
function dirLedgerDisabled(): boolean {
  const v = process.env.AGENTS_SESSIONS_NO_DIR_LEDGER;
  return v === '1' || v === 'true';
}

let cachedOpenClawWorkspaces: Map<string, string> | null = null;

/** Options controlling which sessions to discover and how to report progress. */
export interface DiscoverOptions {
  agent?: SessionAgentId;
  /**
   * Include sessions from the user's own (unmanaged) `~/.<agent>` alongside managed
   * version homes. Defaults to true only when the agent has no managed versions, so
   * a user who has never run `agents add` sees exactly what they see today.
   */
  includeUnmanaged?: boolean;
  /** Called with how many rows the managed-only default hid, so callers can say so. */
  onHiddenUnmanaged?: (count: number) => void;
  version?: string;
  project?: string;
  all?: boolean;
  cwd?: string;
  /** Match any session whose cwd equals this or is a descendant. Overrides `cwd`. */
  cwdPrefix?: string;
  limit?: number;
  /** Internal indexed-query path: return every row in scope instead of the default page. */
  unbounded?: boolean;
  /** Filter sessions newer than this (ISO timestamp or "7d", "30d", "90d") */
  since?: string;
  /** Filter sessions older than this (ISO timestamp) */
  until?: string;
  /** Drop team-spawned sessions at the DB level, before LIMIT. */
  excludeTeamOrigin?: boolean;
  /** Keep only team-spawned sessions (used for hidden-count queries). */
  onlyTeamOrigin?: boolean;
  /** Keep only sessions from this source. */
  origin?: 'cli' | 'routine';
  /** Column to order results by (all descending): 'timestamp' (default), 'cost', or 'duration'. */
  sortBy?: 'timestamp' | 'cost' | 'duration';
  /** Trust scan-ledger rows without stat'ing every returned transcript. */
  skipExistenceCheck?: boolean;
  /** Called as each agent makes parsing progress. Totals count only files that need re-parsing (cache misses). */
  onProgress?: (progress: ScanProgress) => void;
  /** Only sessions that invoked this skill (#12) — see QueryOptions.skill in session/db.ts. */
  skill?: string;
  /** Only sessions that used a skill/command owned by this plugin (#12) — see QueryOptions.plugin. */
  plugin?: string;
  /** Exact session id — a targeted indexed lookup with no scan (RUSH-2477). */
  idExact?: string;
  /** Session id prefix — a targeted indexed lookup with no scan (RUSH-2477). */
  idPrefix?: string;
  /**
   * Cold-miss repair: when another live process already holds the scan claim,
   * wait (bounded) for that in-flight scan to finish before reading the index,
   * instead of returning the pre-scan snapshot (RUSH-2682). A caller repairing a
   * "not indexed yet" miss wants the fresh result the concurrent scan is about to
   * write, not the stale read that just missed. Ignored when THIS process wins
   * the claim (it scans itself) or no scan is in progress.
   */
  waitForScan?: boolean;
}

/** Max time a `waitForScan` repair waits for a concurrent scan to settle. */
const WAIT_FOR_SCAN_TIMEOUT_MS = 2_000;
const WAIT_FOR_SCAN_POLL_MS = 100;

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/** Progress report emitted during incremental scanning. */
export interface ScanProgress {
  agent: SessionAgentId;
  parsed: number;
  total: number;
}

/** Lightweight metadata extracted from a Claude JSONL file during incremental scan. */
interface ClaudeSessionScan {
  timestamp?: string;
  cwd?: string;
  gitBranch?: string;
  version?: string;
  model?: string;
  topic?: string;
  /** Harness-owned session name (`/rename` or Claude's generated `ai-title`). */
  label?: string;
  messageCount: number;
  tokenCount?: number;
  /** Real generated (output) tokens, excluding cache-read/-write context. */
  outputTokens?: number;
  /** Burn split — uncached input / cache-read / cache-write tokens (RUSH-2287). */
  inputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  /** Total USD cost accumulated from per-(model, direction) token usage. */
  costUsd?: number;
  /** USD cost with cache read/write repriced at the input rate (RUSH-2287). */
  costUsdNoCache?: number;
  /** Wall-clock duration in ms between the first and last timestamped event. */
  durationMs?: number;
  /** ISO time of the last timestamped event — the session's last activity. */
  lastActivity?: string;
  toolCallCount?: number;
  /**
   * Value of the JSONL `entrypoint` field on the first event that carries it.
   * 'cli' for real interactive sessions, 'sdk-cli' for team-spawned ones.
   */
  entrypoint?: string;
  /** Concatenated user message text, ready to hand to FTS5. */
  contentText?: string;
  /** Durable state signals persisted to the index by the session-state engine. */
  prUrl?: string;
  prNumber?: number;
  worktreeSlug?: string;
  ticketId?: string;
  /** Tracker refs the session CREATED (Linear create_issue / gh issue create). */
  createdTickets?: string[];
  /** Team name this session SPAWNED via `agents teams create/add` (not team-of-origin). */
  spawnedTeam?: string;
  /** Plan markdown from the last ExitPlanMode tool call (Claude sessions only). */
  plan?: string;
  todos?: TodoProgress;
  recentDirectoriesTouched?: string[];
  /** Skills invoked (#12) — see SessionMeta.skillsUsed. */
  skillsUsed?: Array<{ name: string; count: number }>;
  /** Slash commands invoked (#12) — see SessionMeta.slashCommandsUsed. */
  slashCommandsUsed?: Array<{ name: string; count: number }>;
}

/** Lightweight metadata extracted from a Codex JSONL file during incremental scan. */
interface CodexSessionScan {
  sessionId?: string;
  timestamp?: string;
  cwd?: string;
  gitBranch?: string;
  version?: string;
  model?: string;
  topic?: string;
  messageCount: number;
  tokenCount?: number;
  /** Real generated (output) tokens, excluding cache-read/-write context. */
  outputTokens?: number;
  /** Burn split — uncached input / cache-read tokens (Codex has no cache-write) (RUSH-2287). */
  inputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  costUsd?: number;
  /** USD cost with cache read repriced at the input rate (RUSH-2287). */
  costUsdNoCache?: number;
  durationMs?: number;
  lastActivity?: string;
  contentText?: string;
  prUrl?: string;
  prNumber?: number;
  worktreeSlug?: string;
  ticketId?: string;
  createdTickets?: string[];
  spawnedTeam?: string;
  todos?: TodoProgress;
  recentDirectoriesTouched?: string[];
}

const cachedAgentVersions = new Map<SessionAgentId, Promise<string | undefined>>();

/** A session ready for batch upsert: metadata, searchable text, and file stamp. */
interface ScanEntry {
  meta: SessionMeta;
  content: string;
  scan: ScanStamp;
  /** Normalized events already produced while scanning; avoids reopening the transcript in the DB sink. */
  events?: SessionEvent[];
  /**
   * Serialized {@link ClaudeParserState} continuation to persist in
   * scan_ledger.parser_state (Claude only). Carries the offset + accumulator so
   * the NEXT scan of this file resumes from where this parse stopped. Absent for
   * non-Claude scanners, which leave the column NULL.
   */
  parserState?: string;
  /** Accumulated user doc to persist in scan_ledger.content_text for the next hydrate (Claude only). */
  contentText?: string;
  toolCalls?: IndexedToolCall[];
  toolIndexMode?: 'replace' | 'append';
}

/**
 * Discover sessions. Scans only files whose (mtime, size) have changed since
 * the last run; everything else is served from the SQLite cache.
 *
 * Only one process runs the incremental scan at a time. When many agents boot
 * simultaneously (e.g. after a restart), the first to claim the scan slot does
 * the work; the rest skip parsing entirely and serve from the DB. The claim is
 * stored in the `meta` table — crash-safe via dead-PID detection and a 2-min
 * TTL, no external lock files needed.
 */
export async function discoverSessions(options?: DiscoverOptions): Promise<SessionMeta[]> {
  const { claimed } = await scanSessionsIncremental({
    agent: options?.agent,
    onProgress: options?.onProgress,
  });

  if (!claimed && options?.waitForScan) {
    // Lost the single-flight claim to another live process (a foreground
    // `agents sessions*` or the daemon's index warm). Rather than return the
    // pre-scan snapshot that just missed, wait (bounded) for that scan to finish
    // so the read below reflects what it wrote (RUSH-2682 cold-miss repair).
    await waitForScanToSettle();
  }

  return queryIndexedSessions(options, {
    skipExistenceCheck: options?.skipExistenceCheck ?? false,
  });
}

/** What one incremental scan actually did. */
interface IncrementalScanResult {
  /** True when this process won the single-flight claim and ran the scan. */
  claimed: boolean;
  /**
   * Transcripts parsed this scan — i.e. those whose (mtime, size) changed. Zero
   * is the steady state on an idle box and does NOT mean the scan was skipped;
   * read `claimed` for that.
   *
   * Twelve of the 13 SESSION_AGENTS contribute, including OpenCode, whose
   * scanner filters to sessions whose own per-session stamp changed and reports
   * that batch — so a tick whose only changed sessions live there no longer
   * reports 0 (RUSH-2691). OpenClaw is the exception and contributes nothing:
   * its scanner has no change detection to report (a TTL gate, a fresh stamp
   * every run, and an entry list rebuilt as the current inventory), so counting
   * it would overstate rather than measure. See `scanOpenClawIncremental`.
   */
  scanned: number;
}

/**
 * The write half of {@link discoverSessions}: claim the single-flight scan slot,
 * incrementally index this host's transcript dirs, and report what was parsed.
 *
 * Split out so a caller that only wants the index refreshed — the daemon's warm
 * tick — can run it WITHOUT the listing query `discoverSessions` ends with. That
 * query is not free: it applies a cwd filter, runs the `archived_at`-writing
 * existence check, and can issue a Linear fetch, none of which index anything
 * (RUSH-2691). Keeping one implementation here is also what stops the tick and
 * the foreground path from drifting apart.
 */
export async function scanSessionsIncremental(options?: {
  agent?: SessionAgentId;
  onProgress?: (p: ScanProgress) => void;
}): Promise<IncrementalScanResult> {
  // Touch the DB so the schema is ready and connection is cached for this run.
  getDB();

  const agents = options?.agent ? [options.agent] : SESSION_AGENTS;
  const onProgress = options?.onProgress;

  if (!tryClaimScan(process.pid)) return { claimed: false, scanned: 0 };

  // `parsed` climbs monotonically within one scanner run, so the last value per
  // (phase, agent) is that scanner's total. Phase-keyed because the dotfile scan
  // and the routine-archive scan both report under the same agent id.
  const parsedByPhaseAgent = new Map<string, number>();
  const track = (phase: string) => (p: ScanProgress) => {
    parsedByPhaseAgent.set(`${phase}\0${p.agent}`, p.parsed);
    onProgress?.(p);
  };

  try {
    // Bounded + staggered instead of a single Promise.all: scanning every
    // agent's dotfile dir (~/.claude, ~/.codex, ~/.gemini, …) simultaneously
    // reads to behavioral EDR (CrowdStrike Falcon) as a ransomware-style bulk
    // file-enumeration sweep. Same dirs, same results — just not all at once.
    await scanAgentsBounded(agents, agent => dispatchAgentScan(agent, track('dotfiles')));
    await scanAgentsBounded(agents, agent => scanRoutineArchivesIncremental(agent, track('routines')));
    // Seed labels from `agents run --name` handles onto the freshly-scanned
    // rows by id. Runs AFTER the per-agent scans (which applied agent-generated
    // titles via syncLabels), so a real title always wins and the seed only
    // backfills sessions that would otherwise be unnamed.
    seedLabelsFromNames(buildRunNameMap());
  } finally {
    releaseScan(process.pid);
  }

  let scanned = 0;
  for (const n of parsedByPhaseAgent.values()) scanned += n;
  return { claimed: true, scanned };
}

/**
 * Poll until no live process holds the scan claim, or the bound elapses
 * (RUSH-2682). Bounded so a wedged/slow scan can never hang a foreground preview.
 * Exported for the cold-miss repair test.
 */
export async function waitForScanToSettle(
  timeoutMs: number = WAIT_FOR_SCAN_TIMEOUT_MS,
  pollMs: number = WAIT_FOR_SCAN_POLL_MS,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (scanInProgressByLivePid()) {
    if (Date.now() >= deadline) return false;
    await sleep(pollMs);
  }
  return true;
}

/** Read the current SQLite snapshot without scanning or parsing transcript files. */
export async function queryIndexedSessions(
  options?: DiscoverOptions,
  indexedOptions: { resolveLinear?: boolean; skipExistenceCheck?: boolean } = {},
): Promise<SessionMeta[]> {
  getDB();
  const agents = options?.agent ? [options.agent] : SESSION_AGENTS;
  const sessions = querySessions(buildQueryOptions(
    { ...options, skipExistenceCheck: indexedOptions.skipExistenceCheck ?? true },
    agents,
    { includeLimit: true },
  ));
  if (indexedOptions.resolveLinear !== false) await resolveLinearProjects(sessions);
  for (const s of sessions) {
    // A non-empty transcript path is authoritative for origin (a live-home file
    // is this box; `backups/<agent>/<machine>/…` names that peer), so derive
    // there. An EMPTY file_path carries no such signal — `machineForSessionFile`
    // falls back to THIS box — so keep the machine the row was recorded with
    // instead: a host dispatch stamps the EXECUTION host on its empty-file index
    // row (`registerHostSession`), and re-deriving re-attributed the dispatcher's
    // own pool row to itself, splitting it from the executing peer's fan-out row
    // and making resume-by-id read as "ambiguous (2 sessions)" (RUSH-2486 /
    // RUSH-2479 criterion 2). A recorded-less empty-file row still falls back.
    if (s.filePath || !s.machine?.trim()) s.machine = machineForSessionFile(s.filePath, s.agent);
  }
  return scopeToManaged(sessions, agents, options);
}

/**
 * Resolve a full-or-partial session id against the LOCAL SQLite index only.
 *
 * A plain WAL read through `queryIndexedSessions` — same origin-machine
 * attribution and managed scoping every indexed read gets — with NO incremental
 * discovery scan (so none of `tryClaimScan`/`releaseScan`'s `BEGIN IMMEDIATE`
 * writer lock) and NO fleet SSH fan-out. This is the crash-restart storm path
 * (RUSH-2477): dozens of `sessions resume <id>` at once for a known local id must
 * each be a cheap read, never a writer-lock contender or a dial into the
 * not-yet-up tailnet. Exact id first, then prefix (matching `findSessionsById`),
 * so a complete id never also drags in its prefix siblings. Returns `[]` on a
 * genuine local miss, leaving the caller to fall back to the fleet resolver.
 *
 * The existence check is left ON (`skipExistenceCheck: false`), exactly as the old
 * `discoverSessions` path and `findSessionsById` do (RUSH-2436): it KEEPS a
 * file-gone session whose user turns still live in `session_text` (flagged
 * archived) and SUPPRESSES a contentless phantom — so a phantom id misses here and
 * falls through to the fleet resolver, instead of resolving to a row with no real
 * transcript to resume. For a present transcript — the storm's actual case, since
 * the crashed tabs' files are on disk — the check does no writes, so the lock-free
 * guarantee holds; it only writes to (un)archive a genuinely missing or resurrected
 * file, which is not the 20-at-once resume path.
 */
export async function resolveIndexedSessionById(idQuery: string): Promise<SessionMeta[]> {
  const q = idQuery.trim();
  if (!q) return [];
  const exact = await queryIndexedSessions(
    { all: true, unbounded: true, idExact: q },
    { resolveLinear: false, skipExistenceCheck: false },
  );
  if (exact.length > 0) return exact;
  return queryIndexedSessions(
    { all: true, unbounded: true, idPrefix: q },
    { resolveLinear: false, skipExistenceCheck: false },
  );
}

const linearProjectCache = new Map<string, { name: string; url: string } | null>();

async function resolveLinearProjects(sessions: SessionMeta[]): Promise<void> {
  const apiKey = resolveLinearApiKey();
  if (!apiKey) return;
  await Promise.all(sessions.map(async session => {
    if (!session.ticketId || session.linearProject) return;
    let project = linearProjectCache.get(session.ticketId);
    if (project === undefined) {
      try {
        const response = await fetch('https://api.linear.app/graphql', {
          method: 'POST',
          signal: AbortSignal.timeout(3_000),
          headers: { Authorization: apiKey, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            query: `query($id:String!){ issue(id:$id){ project{ name url } } }`,
            variables: { id: session.ticketId },
          }),
        });
        if (!response.ok) throw new Error(String(response.status));
        const body = await response.json() as { data?: { issue?: { project?: { name?: string; url?: string } | null } } };
        const node = body.data?.issue?.project;
        project = node?.name && node?.url ? { name: node.name, url: node.url } : null;
      } catch {
        project = null;
      }
      linearProjectCache.set(session.ticketId, project);
    }
    if (!project) return;
    session.linearProject = project.name;
    session.linearProjectUrl = project.url;
    cacheLinearProject(session.id, project.name, project.url);
  }));
}

/**
 * Drop unmanaged rows for agents that HAVE managed versions.
 *
 * Scoping happens here, at query time, rather than by narrowing the scan: the index
 * stays complete, so `--unmanaged` needs no re-scan and every other consumer of the
 * DB (watchdog, the Factory watcher, `--roots`) is unaffected.
 *
 * An agent with no managed versions is left alone entirely — someone who has never
 * run `agents add` sees exactly what they saw before.
 */
export function scopeToManaged(
  sessions: SessionMeta[],
  agents: readonly SessionAgentId[],
  options?: DiscoverOptions,
): SessionMeta[] {
  if (options?.includeUnmanaged) return sessions;
  if (!anyManagedVersions()) return sessions;

  const kept = sessions.filter((s) => isManagedSessionFile(s.filePath));
  const hidden = sessions.length - kept.length;
  if (hidden > 0) options?.onHiddenUnmanaged?.(hidden);
  return kept;
}

/**
 * True once agents-cli manages ANY agent version. Until then it manages nothing, so
 * scoping to "managed only" would leave the listing empty for a user who has never
 * run `agents add` — the browser is most of the tool's value before you install
 * anything through it.
 */
function anyManagedVersions(): boolean {
  for (const root of VERSIONS_ROOTS) {
    const base = path.join(root, 'versions');
    let agentDirs: fs.Dirent[];
    try {
      agentDirs = fs.readdirSync(base, { withFileTypes: true });
    } catch { continue; }
    for (const a of agentDirs) {
      if (!a.isDirectory()) continue;
      try {
        if (fs.readdirSync(path.join(base, a.name), { withFileTypes: true }).some((e) => e.isDirectory())) return true;
      } catch { /* unreadable */ }
    }
  }
  return false;
}

/**
 * How many agents' dotfile dirs we scan at once, and the minimum spacing between
 * successive scan starts. A small bound + stagger turns a simultaneous bulk
 * multi-dotfile sweep (a behavioral-EDR file-enumeration trigger) into a trickle.
 */
export const DOTFILE_SCAN_CONCURRENCY = 2;
const DOTFILE_SCAN_STAGGER_MS = 15;

/** Run each agent's incremental scan, bounded + staggered. Order is irrelevant (each scan writes its own rows). */
export function scanAgentsBounded<T>(
  items: readonly T[],
  run: (item: T) => Promise<void>,
): Promise<void[]> {
  return mapBounded(items, run, {
    concurrency: DOTFILE_SCAN_CONCURRENCY,
    staggerMs: DOTFILE_SCAN_STAGGER_MS,
  });
}

/** Dispatch a single agent's incremental dotfile scan. */
function dispatchAgentScan(
  agent: SessionAgentId,
  onProgress?: (p: ScanProgress) => void,
): Promise<void> {
  switch (agent) {
    case 'claude': return scanClaudeIncremental(onProgress);
    case 'codex': return scanCodexIncremental(onProgress);
    case 'gemini': return scanGeminiIncremental(onProgress);
    case 'antigravity': return scanAntigravityIncremental(onProgress);
    case 'opencode': return scanOpenCodeIncremental(onProgress);
    case 'openclaw': return scanOpenClawIncremental(onProgress);
    case 'rush': return scanRushIncremental(onProgress);
    case 'hermes': return scanHermesIncremental(onProgress);
    case 'kimi': return scanKimiIncremental(onProgress);
    case 'droid': return scanDroidIncremental(onProgress);
    case 'grok': return scanGrokIncremental(onProgress);
    case 'cursor': return scanCursorIncremental(onProgress);
    case 'muse': return scanMuseIncremental(onProgress);
    default: return Promise.resolve();
  }
}


/**
 * The machine a discovered session originated on. Cross-machine sync mirrors a
 * remote transcript to backups/<agent>/<machine>/<subdir>/… (see mirrorPath in
 * sync/agents.ts); every other transcript is a live-home file on this box. So:
 * when the path sits under the agent's backups root, the first segment below it
 * is the origin machine id; otherwise it's the local machine.
 */
/**
 * True when this transcript belongs to a version agents-cli manages — i.e. it lives
 * under a version home (or a backup mirror of one) rather than in the user's own
 * `~/.<agent>`.
 *
 * `agents sessions` scans both, which is right for indexing: the DB stays a complete
 * picture and `--unmanaged` can surface everything without a re-scan. But listing
 * *by default* is a different question. Once you have managed versions, an unmanaged
 * install's history is not really agents-cli's to show — most visibly after
 * `agents add --isolated`, where the whole point was to keep the two apart.
 */
export function isManagedSessionFile(filePath: string): boolean {
  // Synthetic rows (OpenClaw workspace sessions, cloud/remote entries) have no local
  // transcript to classify. They are produced BY agents-cli rather than read out of
  // someone's dotfile dir, so scoping must not silently swallow them.
  if (!filePath || !path.isAbsolute(filePath)) return true;

  // A composite file_path (`<container>#<id>`) names a row inside a single shared
  // DB the scanner reads from one fixed location (OpenCode's `opencode.db`) — that
  // store is never a per-install dotfile under a version home, so the managed-vs-
  // unmanaged split does not apply: there is exactly one store, not a "your own"
  // copy to hide. Classifying it as unmanaged hid every OpenCode row from default
  // listings once any agent was managed (RUSH-2357). Keyed off the composite FORM,
  // so any future single-DB harness inherits this.
  if (splitSessionFilePath(filePath).fragment !== undefined) return true;

  const roots = [
    ...VERSIONS_ROOTS.map((root) => path.join(root, 'versions')),
    path.join(getHistoryDir(), 'backups'),
    // Codex's managed home is not always under versions/. On macOS the versioned path
    // overflows SUN_LEN for codex's control socket, so the shim relocates it to
    // `<agentsUserDir>/.codex-homes/<version>/` (lib/codex-home.ts).
    path.join(getUserAgentsDir(), '.codex-homes'),
    // Routine archives are agents-cli's OWN run output — managed by definition.
    getRunsDir(),
  ];

  // Compare realpaths as well as the literal roots. A transcript's stored path is
  // resolved, so on macOS (`/var` -> `/private/var`) a temp-dir HOME yields
  // `/private/var/...` for the file and `/var/...` for the root, and a plain prefix
  // test silently classifies every managed session as the user's own.
  const real = safeRealpathSync(filePath) || filePath;
  return roots.some((root) => {
    if (filePath.startsWith(root + path.sep)) return true;
    const realRoot = safeRealpathSync(root);
    return !!realRoot && real.startsWith(realRoot + path.sep);
  });
}



/**
 * Count sessions in scope without running an incremental scan. Assumes the DB
 * is already fresh (typically true because `discoverSessions` ran first this
 * turn). Uses the exact same filter shape as the discover query.
 */
export function countSessionsInScope(options: DiscoverOptions): number {
  const agents = options.agent ? [options.agent] : SESSION_AGENTS;
  return countSessions(buildQueryOptions(options, agents, { includeLimit: false }));
}

/** Translate DiscoverOptions into the QueryOptions shape expected by the DB layer. */
function buildQueryOptions(
  options: DiscoverOptions | undefined,
  agents: SessionAgentId[],
  opts: { includeLimit: boolean },
): QueryOptions {
  const projectQuery = options?.project?.trim();
  const sinceMs = options?.since ? parseTimeFilter(options.since) : undefined;
  const untilMs = options?.until ? new Date(options.until).getTime() : undefined;

  let cwdFilter: string | undefined;
  let cwdPrefixFilter: string | undefined;
  if (options?.cwdPrefix) {
    cwdPrefixFilter = normalizeCwd(options.cwdPrefix);
  } else if (!options?.all && !projectQuery && options?.agent !== 'rush' && options?.agent !== 'hermes') {
    // Rush and Hermes sessions are cloud/gateway-bound and have no cwd — skip
    // cwd filtering when the user explicitly asked for them.
    cwdFilter = normalizeCwd(options?.cwd || process.cwd());
  }

  return {
    agent: options?.agent,
    agents: options?.agent ? undefined : agents,
    version: options?.version,
    cwd: cwdFilter,
    cwdPrefix: cwdPrefixFilter,
    project: projectQuery,
    sinceMs,
    untilMs: Number.isFinite(untilMs as number) ? untilMs : undefined,
    limit: opts.includeLimit && !options?.unbounded ? (options?.limit ?? 50) : undefined,
    excludeTeamOrigin: options?.excludeTeamOrigin,
    onlyTeamOrigin: options?.onlyTeamOrigin,
    origin: options?.origin,
    sortBy: options?.sortBy,
    skipExistenceCheck: options?.skipExistenceCheck,
    skill: options?.skill,
    plugin: options?.plugin,
    idExact: options?.idExact,
    idPrefix: options?.idPrefix,
  };
}

/**
 * Canonicalize a working directory path (follows symlinks when it is local).
 *
 * Most callers pass a cwd RECORDED in a transcript, which may name a directory
 * on another machine — a POSIX path read on a Windows host, say. `path.resolve()`
 * rebases such a path onto the current drive (`/Users/me` -> `D:\Users\me`),
 * inventing a location that never existed. So an absolute path is normalized but
 * never rebased; only a genuinely relative one resolves against the process cwd.
 *
 * `path.normalize()` still runs on every branch: it collapses `.`, `..`, and
 * duplicate separators, and folds separators on Windows. Both sides of the cwd
 * filter in `db.ts` (`cwd = ?` and `cwd LIKE ? || path.sep || '%'`) come through
 * here, so dropping that would leave a trailing slash or a `..` segment in one
 * side and match nothing.
 *
 * Realpath is attempted only for a path that is absolute in THIS platform's
 * terms. A POSIX-rooted path on Windows is drive-relative to `fs.realpathSync`,
 * which would resolve `/Users/me` against the current drive and reintroduce the
 * graft for any path that happens to exist locally.
 */
export function _normalizeCwdForTest(cwd?: string): string {
  return normalizeCwd(cwd);
}

function normalizeCwd(cwd?: string): string {
  if (!cwd) return '';
  // A POSIX-rooted path on Windows belongs to another machine. Normalize it with
  // POSIX rules so its separators survive — path.win32.normalize would fold them
  // to backslashes, mangling the very path we are trying to preserve — and never
  // realpath it, since fs.realpathSync would resolve it against the current drive.
  if (process.platform === 'win32' && /^\//.test(cwd) && !/^[a-zA-Z]:/.test(cwd)) {
    return stripTrailingSep(path.posix.normalize(cwd));
  }
  // The mirror case (RUSH-2358): a Windows-rooted path (`C:\...`, `C:/...`, or a
  // UNC `\\server\share\...`) read on POSIX belongs to another machine too, but
  // `path.isAbsolute()` here uses POSIX rules and doesn't recognize a drive
  // letter — without this branch such a cwd falls into the `path.resolve()` arm
  // below and gets silently prefixed with THIS process's own cwd, corrupting the
  // path (and, via WORKTREE_RE, can misattribute the worktree slug to whatever
  // worktree the reading process happens to be running in). Normalize with
  // win32 rules so separators survive; never realpath it, for the same
  // cross-drive reason as the mirror branch above.
  if (process.platform !== 'win32' && /^([a-zA-Z]:[\\/]|\\\\)/.test(cwd)) {
    return stripTrailingSep(path.win32.normalize(cwd));
  }
  const normalized = path.isAbsolute(cwd) ? stripTrailingSep(path.normalize(cwd)) : path.resolve(cwd);
  return safeRealpathSync(normalized) || normalized;
}

/** Drop a trailing separator so `cwd = ?` and the `cwd LIKE ? + sep` subdir
 *  wildcard agree; a root path (`/`, `C:\`) keeps its separator. */
function stripTrailingSep(p: string): string {
  const stripped = p.replace(/[\\/]+$/, '');
  return stripped.length > 0 && !/^[a-zA-Z]:$/.test(stripped) ? stripped : p;
}

/** Canonical 8-4-4-4-12 hex UUID (covers both v4 and the v7 ids newer harnesses mint). */
const UUID_36 = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** kimi and rush mint `session_` + a UUID. */
const SESSION_UUID_PREFIX = /^session_/;
/** opencode mints `ses_` + a 26-char ULID — NOT a UUID, so it needs its own shape. */
const SES_ULID = /^ses_[0-9a-z]{26}$/;

/**
 * Whether a query is a session id in full, rather than an id prefix or a search
 * phrase.
 *
 * Callers use this to decide that an id lookup is the ONLY admissible
 * interpretation: a complete id is unique, so when it misses there is nothing
 * left to widen to. Without the check, `sessions <uuid>` fell through to the
 * FTS content search, which tokenizes the UUID and matches every transcript that
 * merely mentions it — surfacing unrelated sessions as if they were id matches.
 *
 * The accepted shapes are the ones the index actually holds, measured over a
 * 12,507-row index: a bare UUID (11,116 rows), `session_` + UUID (1,360 — kimi
 * and rush), and `ses_` + ULID (15 — opencode). Deliberately NOT covered, so a
 * miss keeps today's search behavior rather than gaining a wrong error: routine
 * run ids (ISO timestamps, matched via `routineRunId` below) and cloud execution
 * ids, whose charset is too permissive to distinguish from a search phrase.
 */
export function isCompleteSessionId(query: string): boolean {
  const q = query.trim().toLowerCase();
  return UUID_36.test(q.replace(SESSION_UUID_PREFIX, '')) || SES_ULID.test(q);
}

/**
 * Whether a query should be treated as a session id rather than a search phrase
 * — the one canonical id-shaped test, shared by every session-id resolver.
 *
 * True for a complete id (`isCompleteSessionId`) AND for a bare hex short-id or
 * prefix (`d3470b57`), which the complete-id check rejects. Any id-shaped query
 * resolves by id ONLY (exact -> prefix -> `findSessionsById` index) and must
 * never fall back to fuzzy content search: a short id like `d3470b57` otherwise
 * surfaces every transcript that merely MENTIONS the string (a resume prompt
 * echoes the parent id into the body of many later sessions). The hex test
 * catches the bare short-id/prefix; `isCompleteSessionId` additionally catches
 * the prefixed whole ids (`session_…`, `ses_…`) that the hex test rejects.
 */
export function looksLikeSessionId(query: string): boolean {
  const trimmed = query.trim();
  return /^[0-9a-f-]{6,}$/i.test(trimmed) || isCompleteSessionId(trimmed);
}

/**
 * Resolve a session by full or short ID. Accepts a pre-loaded session list
 * (fast path from discoverSessions) and falls back to a DB lookup for the
 * "I only know the id" case.
 */
export function resolveSessionById(sessions: SessionMeta[], idQuery: string): SessionMeta[] {
  const query = idQuery.toLowerCase();
  const exact = sessions.filter(s =>
    s.id.toLowerCase() === query ||
    s.shortId.toLowerCase() === query ||
    s.routineRunId?.toLowerCase() === query,
  );
  if (exact.length > 0) return exact;
  return sessions.filter(s =>
    s.id.toLowerCase().startsWith(query) ||
    s.shortId.toLowerCase().startsWith(query) ||
    s.routineRunId?.toLowerCase().startsWith(query),
  );
}

// ---------------------------------------------------------------------------
// Content-index search (FTS5-backed)
// ---------------------------------------------------------------------------

/**
 * Run an FTS5 search over the DB and intersect with the given session list,
 * preserving the existing SessionMeta[] contract so sessions.ts is unchanged.
 */
export function searchContentIndex(
  sessions: SessionMeta[],
  query: string,
): Map<string, SessionMeta> {
  if (!query.trim()) return new Map();
  const hits = ftsSearch(query);
  if (hits.length === 0) return new Map();

  const byId = new Map(sessions.map(s => [s.id, s]));
  const result = new Map<string, SessionMeta>();
  for (const hit of hits) {
    const session = byId.get(hit.sessionId);
    if (!session) continue;
    result.set(hit.sessionId, {
      ...session,
      _matchedTerms: hit.matchedTerms,
      _bm25Score: hit.score,
    });
  }
  return result;
}

// ---------------------------------------------------------------------------
// Incremental scan orchestration
// ---------------------------------------------------------------------------

/**
 * For a list of files, stat each, compare to the DB ledger, and return only
 * the ones that need rescanning. One bulk DB query for the whole list.
 *
 * Actively running agents append to their JSONL every few seconds. Without a
 * small debounce, repeated `agents sessions` invocations stream-parse the same
 * growing transcript over and over. The cached row is good enough for a few
 * seconds; once writes settle or the debounce expires, the file is parsed once.
 */
export function filterChangedFiles(
  filePaths: string[],
): Array<{ filePath: string; scan: ScanStamp }> {
  const entries: PreStatEntry[] = [];
  for (const filePath of filePaths) {
    const stat = safeStatSync(filePath);
    if (!stat) continue;
    entries.push({ filePath, fileMtimeMs: stat.mtimeMs, fileSize: stat.size });
  }
  return filterChangedEntries(entries);
}

/** A path already stat'd by the walk — mtime is the raw (unfloored) fs value. */
interface PreStatEntry {
  filePath: string;
  fileMtimeMs: number;
  fileSize: number;
}

/**
 * Ledger-compare pre-stat'd entries (from the walk's own stat) without a second
 * stat. Same debounce and change-detection as filterChangedFiles; the raw
 * mtime is floored here so warm files match the ledger exactly as the stat path
 * does (Math.floor(stat.mtimeMs)).
 */
export function filterChangedEntries(
  entries: PreStatEntry[],
): Array<{ filePath: string; scan: ScanStamp }> {
  const ledger = getScanStampsForPaths(entries.map(e => e.filePath));
  const out: Array<{ filePath: string; scan: ScanStamp }> = [];
  const now = Date.now();
  for (const entry of entries) {
    const scan: ScanStamp = {
      fileMtimeMs: Math.floor(entry.fileMtimeMs),
      fileSize: entry.fileSize,
    };
    const prev = ledger.get(entry.filePath);
    if (prev && prev.fileMtimeMs === scan.fileMtimeMs && prev.fileSize === scan.fileSize) {
      continue;
    }
    if (prev && shouldDeferRecentAppend(prev, scan, now)) {
      continue;
    }
    out.push({ filePath: entry.filePath, scan });
  }
  return out;
}

export function shouldDeferRecentAppend(
  prev: ScanStamp,
  current: ScanStamp,
  nowMs: number,
  debounceMs = ACTIVE_APPEND_RESCAN_DEBOUNCE_MS,
): boolean {
  if (prev.scannedAt === undefined) return false;
  if (current.fileSize <= prev.fileSize) return false;
  if (current.fileMtimeMs < prev.fileMtimeMs) return false;
  return nowMs - prev.scannedAt < debounceMs;
}

// ---------------------------------------------------------------------------
// Directory-ledger short-circuit (A-2)
// ---------------------------------------------------------------------------

/** One leaf directory of transcripts to change-detect, plus its live-root flag. */
interface LeafDir {
  /** Absolute path to the directory that directly holds transcript files. */
  dirPath: string;
  /**
   * True if this dir is under the agent's LIVE `~/.<agent>` root — the only tree
   * an agent process appends to live. Every file in such a dir is treated as
   * hot (always re-stat'd), so an in-place append is never missed there.
   */
  isLiveRoot: boolean;
}

/** The changed files a leaf-dir walk surfaced, ready to parse + upsert. */
interface LeafDirScan {
  /** Files whose (mtime, size) changed vs the ledger — the parse set. */
  changed: Array<{ filePath: string; scan: ScanStamp }>;
  /**
   * Every transcript file seen across all leaf dirs (changed or not), in
   * live-root-first order, each tagged with whether its dir is a live root.
   * Lets a caller restore cross-root, session-id precedence (prefer the live
   * copy of a session over a frozen backup copy) independent of which copy
   * happened to be flagged "changed" this run.
   */
  allFiles: Array<{ filePath: string; isLiveRoot: boolean }>;
}

/**
 * Walk a set of leaf transcript directories and return the files that changed,
 * skipping the per-file `stat` of directories whose (mtime, entry_count) matches
 * the dir_ledger.
 *
 * Per leaf dir:
 *   - `stat` the dir once and `readdir` it (one cheap syscall) to get the entry
 *     count and the file list.
 *   - If the dir matches the dir_ledger (floored mtime AND entry_count), no file
 *     was created / deleted / renamed since we last walked it. We then stat ONLY
 *     the hot files (live-root files, or files scanned within HOT_FILE_WINDOW_MS)
 *     and run just those through the ledger compare — so an in-place append to a
 *     still-live session is still caught, while immutable backup/version dirs
 *     collapse to a single dir stat and zero per-file stats.
 *   - Else (changed dir, or no ledger row) we stat every file (today's full
 *     walk) and record the fresh dir stamp so the next run can short-circuit.
 *
 * The kill-switch (`AGENTS_SESSIONS_NO_DIR_LEDGER=1`) forces the full-walk branch
 * for every dir and never consults or records the dir_ledger.
 */
function collectChangedFilesInLeafDirs(
  leafDirs: LeafDir[],
  ext: string,
): LeafDirScan {
  const disabled = dirLedgerDisabled();
  const dirStamps = disabled ? new Map<string, DirStamp>() : getDirLedgerForPaths(leafDirs.map(d => d.dirPath));
  const now = Date.now();

  // Files whose per-file stat we still need to ledger-compare this run.
  const toCompare: PreStatEntry[] = [];
  const allFiles: Array<{ filePath: string; isLiveRoot: boolean }> = [];
  const dirScansToRecord: Array<{ dirPath: string; dirMtimeMs: number; entryCount: number }> = [];

  for (const { dirPath, isLiveRoot } of leafDirs) {
    const dirStat = safeStatSync(dirPath);
    if (!dirStat?.isDirectory()) continue;

    let names: string[];
    try {
      names = fs.readdirSync(dirPath).filter(f => f.endsWith(ext));
    } catch {
      continue;
    }
    const files = names.map(f => path.join(dirPath, f));
    for (const filePath of files) allFiles.push({ filePath, isLiveRoot });

    const dirMtimeMs = Math.floor(dirStat.mtimeMs);
    const entryCount = names.length;
    const prevDir = dirStamps.get(dirPath);
    const dirUnchanged =
      !disabled && prevDir !== undefined && prevDir.dirMtimeMs === dirMtimeMs && prevDir.entryCount === entryCount;

    if (dirUnchanged) {
      // Contents did not change (no create/delete/rename). Stat only the hot
      // files; the rest are served from the DB with no stat. An immutable backup
      // dir (not a live root, nothing recently scanned) does zero per-file stats.
      //
      // A live-root dir treats every file as hot — that is the tree an agent
      // appends to live, and an append does NOT bump the parent-dir mtime, so
      // without this a growing session would be silently skipped. A non-live
      // file is hot only if it was scanned within HOT_FILE_WINDOW_MS (bulk ledger
      // lookup), covering a session under a version/backup path that is somehow
      // still being written.
      const stamps = isLiveRoot ? null : getScanStampsForPaths(files);
      for (const filePath of files) {
        let hot = isLiveRoot;
        if (!hot && stamps) {
          const s = stamps.get(filePath);
          hot = s?.scannedAt !== undefined && now - s.scannedAt <= HOT_FILE_WINDOW_MS;
        }
        if (!hot) continue;
        const stat = safeStatSync(filePath);
        if (!stat) continue;
        toCompare.push({ filePath, fileMtimeMs: stat.mtimeMs, fileSize: stat.size });
      }
      // No dir stamp to record — nothing about the dir changed.
    } else {
      // Changed dir (or cold ledger): full per-file stat, exactly as today.
      for (const filePath of files) {
        const stat = safeStatSync(filePath);
        if (!stat) continue;
        toCompare.push({ filePath, fileMtimeMs: stat.mtimeMs, fileSize: stat.size });
      }
      purgeMissingToolCallsInDirectory(getDB(), dirPath, files);
      if (!disabled) dirScansToRecord.push({ dirPath, dirMtimeMs, entryCount });
    }
  }

  const changed = filterChangedEntries(toCompare);
  if (dirScansToRecord.length > 0) recordDirScans(dirScansToRecord);
  return { changed, allFiles };
}

// ---------------------------------------------------------------------------
// Multi-version directory scanning
// ---------------------------------------------------------------------------

/**
 * Collect all directories to scan for an agent's sessions. Deduplicates by
 * realpath to avoid double-counting symlinked version homes.
 */
export function getAgentSessionDirs(agent: string, subdir: string): string[] {
  const resolved = new Set<string>();
  const dirs: string[] = [];

  function addDir(dir: string): void {
    if (!fs.existsSync(dir)) return;
    const real = safeRealpathSync(dir);
    const key = real || dir;
    if (resolved.has(key)) return;
    resolved.add(key);
    dirs.push(dir);
  }

  // Config-dir name relative to home — handles nested layouts (antigravity →
  // .gemini/antigravity-cli) and ~/.config agents (amp, goose) as well as kimi
  // (.kimi-code). Falls back to `.${agent}` for ids not in the registry.
  const configDirName = agent in AGENTS ? agentConfigDirName(agent as AgentId) : `.${agent}`;

  addDir(path.join(HOME, configDirName, subdir));

  for (const root of VERSIONS_ROOTS) {
    const versionsBase = path.join(root, 'versions', agent);
    if (!fs.existsSync(versionsBase)) continue;
    try {
      for (const version of fs.readdirSync(versionsBase)) {
        addDir(path.join(versionsBase, version, 'home', configDirName, subdir));
        // Codex's managed home is not always where the version layout says. On macOS
        // the versioned path overflows SUN_LEN (104 bytes) for codex's control
        // socket, so the shim relocates the home to
        // `<agentsUserDir>/.codex-homes/<version>/.codex` (lib/codex-home.ts). Every
        // transcript an isolated codex writes lands there, and nothing scanned it —
        // `agents sessions --roots` listed only the user's own ~/.codex, so a managed
        // copy's own history was invisible. addDir skips what does not exist, so this
        // is inert on Linux and for versions that never needed relocating.
        if (agent === 'codex') {
          addDir(path.join(shortCodexHome(getUserAgentsDir(), version), subdir));
        }
      }
    } catch { /* dir unreadable */ }
  }

  const backupsBase = path.join(getHistoryDir(), 'backups', agent);
  if (fs.existsSync(backupsBase)) {
    try {
      for (const ts of fs.readdirSync(backupsBase)) {
        addDir(path.join(backupsBase, ts, subdir));
      }
    } catch { /* dir unreadable */ }
  }

  return dirs;
}

/**
 * The (agent, subdir) pairs `discoverSessions` walks for JSONL transcripts —
 * the single source of truth for which directories hold live session files.
 * `getSessionRoots` expands each pair to its concrete directories so a consumer
 * (AGI EXT's fs.watch, see issue #741) can configure its watcher
 * from the CLI instead of hardcoding `~/.claude|.codex|.gemini`. Adding a new
 * on-disk agent here makes every consumer watch it automatically.
 */
const SESSION_ROOT_SPECS: ReadonlyArray<{ agent: SessionAgentId; subdir: string }> = [
  { agent: 'claude', subdir: 'projects' },
  { agent: 'codex', subdir: 'sessions' },
  { agent: 'gemini', subdir: 'tmp' },
  { agent: 'antigravity', subdir: 'conversations' },
  { agent: 'droid', subdir: 'sessions' },
  { agent: 'kimi', subdir: 'sessions' },
  { agent: 'grok', subdir: 'sessions' },
  { agent: 'cursor', subdir: 'projects' },
];

function sessionRootSubdir(agent: SessionAgentId): string | null {
  return SESSION_ROOT_SPECS.find((spec) => spec.agent === agent)?.subdir ?? null;
}

/** A session-agent's on-disk watch roots (every version home + backup mirror). */
interface SessionRoots {
  agent: SessionAgentId;
  /** Absolute directories that hold this agent's transcripts, existing right now. */
  dirs: string[];
}

/**
 * The directories `agents sessions` scans for each on-disk session agent,
 * resolved to what exists on this machine. Emitted by `agents sessions --roots
 * --json` so external watchers stay in lockstep with the CLI's discovery paths.
 * Agents with no directories present are omitted.
 */
export function getSessionRoots(): SessionRoots[] {
  const out: SessionRoots[] = [];
  for (const { agent, subdir } of SESSION_ROOT_SPECS) {
    const dirs = getAgentSessionDirs(agent, subdir);
    dirs.push(...getRoutineArchiveSessionDirs(agent, subdir));
    if (dirs.length > 0) out.push({ agent, dirs });
  }
  return out;
}

function getRoutineArchiveSessionDirs(agent: SessionAgentId, subdir: string): string[] {
  const runsDir = getRunsDir();
  if (!fs.existsSync(runsDir)) return [];
  const dirs: string[] = [];

  let jobDirs: fs.Dirent[];
  try {
    jobDirs = fs.readdirSync(runsDir, { withFileTypes: true });
  } catch {
    return dirs;
  }

  for (const jobDir of jobDirs) {
    if (!jobDir.isDirectory()) continue;
    const jobRunsDir = path.join(runsDir, jobDir.name);
    let runDirs: fs.Dirent[];
    try {
      runDirs = fs.readdirSync(jobRunsDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const runDir of runDirs) {
      if (!runDir.isDirectory()) continue;
      const dir = path.join(jobRunsDir, runDir.name, 'sessions', agent, subdir);
      if (fs.existsSync(dir)) dirs.push(dir);
    }
  }

  return dirs;
}

function routineArchiveInfo(filePath: string): { jobName: string; runId: string } | null {
  const rel = path.relative(getRunsDir(), filePath);
  if (rel.startsWith('..') || path.isAbsolute(rel)) return null;
  const parts = rel.split(path.sep);
  if (parts.length < 6 || parts[2] !== 'sessions') return null;
  return { jobName: parts[0], runId: parts[1] };
}

function decorateRoutineSession(
  meta: SessionMeta,
  info: { jobName: string; runId: string },
): SessionMeta {
  return {
    ...meta,
    origin: 'routine',
    routineName: info.jobName,
    routineRunId: info.runId,
    project: info.jobName,
    label: info.jobName,
  };
}

async function readRoutineArchiveMeta(
  agent: SessionAgentId,
  filePath: string,
): Promise<{
  meta: SessionMeta;
  content: string;
  events?: SessionEvent[];
  toolCalls?: IndexedToolCall[];
  toolIndexMode?: 'replace' | 'append';
} | null> {
  const info = routineArchiveInfo(filePath);
  if (!info) return null;

  if (agent === 'claude') {
    const sessionId = path.basename(filePath).replace(/\.jsonl$/, '');
    // Routine archives are finalized, immutable transcripts — no live append, so
    // no continuation to resume. A FULL parse (undefined prior) is correct here;
    // the returned continuation is unused by this archive path.
    const stat = safeStatSync(filePath);
    if (!stat) return null;
    const scanStamp: ScanStamp = { fileMtimeMs: Math.floor(stat.mtimeMs), fileSize: stat.size };
    const result = await readClaudeMeta(filePath, sessionId, scanStamp, undefined);
    return result ? { ...result, meta: decorateRoutineSession(result.meta, info) } : null;
  }

  if (agent === 'codex') {
    const result = await readCodexMeta(filePath);
    return result ? { ...result, meta: decorateRoutineSession(result.meta, info) } : null;
  }

  if (agent === 'cursor') {
    // PR #1723 archives Cursor routine transcripts; preserve version resolution
    // when this reader consumes those archives.
    const currentVersion = await getCurrentAgentVersion('cursor');
    const result = readCursorMeta(filePath, currentVersion);
    return result ? { ...result, meta: decorateRoutineSession(result.meta, info) } : null;
  }

  return null;
}

async function scanRoutineArchivesIncremental(
  agent: SessionAgentId,
  onProgress?: (p: ScanProgress) => void,
): Promise<void> {
  const subdir = sessionRootSubdir(agent);
  if (!subdir) return;

  const ext = agent === 'gemini' ? '.json' : '.jsonl';
  const prestat: PreStatEntry[] = [];
  for (const sessionsDir of getRoutineArchiveSessionDirs(agent, subdir)) {
    for (const f of walkForFilesWithStat(sessionsDir, ext, 100_000)) {
      prestat.push({ filePath: f.path, fileMtimeMs: f.mtimeMs, fileSize: f.size });
    }
  }

  const changed = filterChangedEntries(prestat);
  if (changed.length === 0) return;

  onProgress?.({ agent, parsed: 0, total: changed.length });

  const entries: ScanEntry[] = [];
  const touched: Array<{ filePath: string; scan: ScanStamp }> = [];
  let parsed = 0;
  for (const { filePath, scan } of changed) {
    try {
      const result = await readRoutineArchiveMeta(agent, filePath);
      if (result) entries.push({
        meta: result.meta,
        content: result.content,
        scan,
        events: result.events,
        toolCalls: result.toolCalls,
        toolIndexMode: result.toolIndexMode,
      });
      else touched.push({ filePath, scan });
    } catch {
      touched.push({ filePath, scan });
    }
    parsed++;
    onProgress?.({ agent, parsed, total: changed.length });
  }

  upsertSessionsBatch(entries);
  recordScans(touched);
}

// ---------------------------------------------------------------------------
// Claude account info
// ---------------------------------------------------------------------------

let cachedClaudeAccountIndex: ClaudeAccountIndex | undefined;

/**
 * The account-attribution index, built at most once per scan pass.
 *
 * Rebuilt when `refresh` is set — `scanClaudeIncremental` does that at the start of
 * each pass so a long-lived process (the daemon) picks up an `agents use` switch or a
 * fresh login instead of attributing later sessions to a stale set of homes. Per-file
 * resolution then reads the cached index, because rebuilding it per transcript would
 * re-read every home's `.claude.json` thousands of times.
 */
function claudeAccountIndex(refresh = false): ClaudeAccountIndex {
  if (refresh || !cachedClaudeAccountIndex) cachedClaudeAccountIndex = buildClaudeAccountIndex();
  return cachedClaudeAccountIndex;
}

// ---------------------------------------------------------------------------
// Claude
// ---------------------------------------------------------------------------

/**
 * Build a map of Claude sessionId -> user-given label from ~/.claude/sessions/*.json.
 * Each JSON has shape { pid, sessionId, cwd, startedAt, name?, ... }. The
 * `name` field only exists if the user ran /rename in that session.
 * For sessionId collisions (re-resume of the same session), prefer the most
 * recent startedAt.
 */
export function buildClaudeLabelMap(): Map<string, string | null> {
  const map = new Map<string, { label: string | null; startedAt: number }>();
  const dir = path.join(HOME, '.claude', 'sessions');
  if (!fs.existsSync(dir)) return new Map();

  let files: string[];
  try {
    files = fs.readdirSync(dir).filter(f => f.endsWith('.json'));
  } catch {
    return new Map();
  }

  for (const f of files) {
    try {
      const data = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf-8'));
      if (typeof data.sessionId !== 'string') continue;
      const name = typeof data.name === 'string' && data.name.trim() ? data.name.trim() : null;
      const startedAt = typeof data.startedAt === 'number' ? data.startedAt : 0;
      const existing = map.get(data.sessionId);
      if (!existing || startedAt > existing.startedAt) {
        map.set(data.sessionId, { label: name, startedAt });
      }
    } catch { /* unreadable session metadata file */ }
  }

  const out = new Map<string, string | null>();
  for (const [sid, { label }] of map) out.set(sid, label);
  return out;
}

/** Incrementally re-scan changed Claude session files and upsert into the DB. */
async function scanClaudeIncremental(onProgress?: (p: ScanProgress) => void): Promise<void> {
  // Rebuild once per pass; readClaudeMeta resolves each transcript against it.
  claudeAccountIndex(true);
  const labelMap = buildClaudeLabelMap();

  // Enumerate every leaf project dir across all Claude roots. The FIRST root
  // returned by getAgentSessionDirs is the agent's live `~/.claude/projects` —
  // the only tree Claude appends to in place, so its project dirs are live roots
  // (every file hot). Version-home + backup roots are immutable: their dirs
  // short-circuit to a single dir stat when unchanged.
  const roots = getAgentSessionDirs('claude', 'projects');
  const leafDirs: LeafDir[] = [];
  const seenLeaf = new Set<string>();
  roots.forEach((projectsDir, rootIdx) => {
    const isLiveRoot = rootIdx === 0;
    let projectDirs: string[];
    try {
      projectDirs = fs.readdirSync(projectsDir);
    } catch {
      return;
    }
    for (const dirName of projectDirs) {
      const dirPath = path.join(projectsDir, dirName);
      const key = safeRealpathSync(dirPath) || dirPath;
      if (seenLeaf.has(key)) continue;
      seenLeaf.add(key);
      leafDirs.push({ dirPath, isLiveRoot });
    }
  });

  const { changed: changedAll, allFiles } = collectChangedFilesInLeafDirs(leafDirs, '.jsonl');
  // Restore the pre-A-2 cross-root precedence: a session id present in multiple
  // roots is ALWAYS served from its live path, never a frozen backup/version
  // copy. Pre-A-2, dedup happened at enumeration time via a live-first `seen`
  // set, so a non-live copy was never even stat'd when a live copy existed. This
  // PR must not regress that to "whichever copy changed this run wins" — a cold
  // (unchanged) live copy paired with a freshly-written backup snapshot would
  // otherwise flip the row's file_path to the backup path.
  //
  // allFiles is every transcript file across all roots in live-first order, so
  // the FIRST occurrence of each session id is its live (or highest-precedence)
  // path — the durable winner, independent of which copy was flagged changed.
  const sessionIdOf = (fp: string) => path.basename(fp).replace('.jsonl', '');
  const winnerBySession = new Map<string, string>();
  for (const { filePath } of allFiles) {
    const id = sessionIdOf(filePath);
    if (!winnerBySession.has(id)) winnerBySession.set(id, filePath);
  }
  // Keep a changed entry only if it is its session's winner. A changed non-live
  // copy is dropped whenever a live copy exists anywhere; the winning path is
  // parsed only when it itself changed (a cold winner needs no re-parse — its DB
  // row already points at the live path).
  const changed = changedAll.filter(e => winnerBySession.get(sessionIdOf(e.filePath)) === e.filePath);

  if (changed.length > 0) {
    onProgress?.({ agent: 'claude', parsed: 0, total: changed.length });

    // Bulk-fetch each changed file's prior resumable continuation. A file with a
    // usable prior state + growth goes incremental (re-parse only the appended
    // bytes); everything else does a FULL from-offset-0 parse. The decision + the
    // parse both live in scanClaudeSessionResumable so full and incremental share
    // one reducer and produce identical rows.
    const priorStates = getParserStatesForPaths(changed.map(c => c.filePath));

    const entries: ScanEntry[] = [];
    const touched: Array<{ filePath: string; scan: ScanStamp }> = [];
    let parsed = 0;
    for (const { filePath, scan } of changed) {
      try {
        const sessionId = path.basename(filePath).replace('.jsonl', '');
        const label = labelMap.get(sessionId) ?? undefined;
        const priorRow = priorStates.get(filePath);
        const result = await readClaudeMeta(filePath, sessionId, scan, priorRow, label);
        if (result) {
          entries.push({
            meta: result.meta,
            content: result.content,
            scan,
            parserState: result.parserState,
            contentText: result.contentText,
            toolCalls: result.toolCalls,
            toolIndexMode: result.toolIndexMode,
          });
        } else {
          touched.push({ filePath, scan });
        }
      } catch {
        touched.push({ filePath, scan });
      }
      parsed++;
      onProgress?.({ agent: 'claude', parsed, total: changed.length });
    }

    upsertSessionsBatch(entries);
    recordScans(touched);
  }

  // Pick up /rename changes on sessions whose JSONL didn't change.
  // Only bother for sessions we actually have a Claude row for.
  if (labelMap.size > 0) syncLabels(labelMap);
}

/**
 * Stream-parse a single Claude JSONL file to extract session metadata, resuming
 * from the persisted continuation when the file merely grew (see
 * {@link scanClaudeSessionResumable}). Returns the row's meta + FTS content plus
 * the serialized continuation (parser_state + content_text) to persist for the
 * next scan.
 */
async function readClaudeMeta(
  filePath: string,
  sessionId: string,
  scanStamp: ScanStamp,
  priorRow: { parserState: string | null; fileMtimeMs: number } | undefined,
  label?: string,
): Promise<{
  meta: SessionMeta;
  content: string;
  parserState: string;
  contentText?: string;
  toolCalls?: IndexedToolCall[];
  toolIndexMode: 'replace' | 'append';
} | null> {
  const prior = parsePriorClaudeState(priorRow);
  const { scan, newState, toolCalls, mode } = await scanClaudeSessionResumable(
    filePath,
    prior,
    scanStamp.fileMtimeMs,
    scanStamp.fileSize,
    priorRow?.fileMtimeMs,
  );
  if (mode === 'incremental') claudeIncrementalScanCount++;
  else claudeFullScanCount++;
  const isTeamOrigin = scan.entrypoint === 'sdk-cli';
  // Which account produced this transcript. Resolved from the path plus the version
  // recorded inside the file, so rows under the mutable ~/.claude symlink are
  // attributed to the version that actually wrote them. See claude-accounts.ts.
  const acct = resolveClaudeAccount(claudeAccountIndex(), filePath, scan.version);

  let meta: SessionMeta;
  if (scan.timestamp) {
    const cwd = normalizeCwd(scan.cwd || '');
    meta = {
      id: sessionId,
      shortId: deriveShortId(sessionId),
      agent: 'claude',
      timestamp: scan.timestamp,
      lastActivity: scan.lastActivity,
      project: cwd ? path.basename(cwd) : undefined,
      cwd,
      filePath,
      gitBranch: scan.gitBranch,
      version: scan.version,
      model: scan.model,
      account: acct.email ?? undefined,
      accountKey: acct.key,
      accountOrg: acct.orgName ?? undefined,
      topic: scan.topic,
      // The live sessions metadata file contains only user `/rename` values;
      // prefer it when present, then fall back to the title parsed from JSONL.
      label: label || scan.label,
      messageCount: scan.messageCount,
      toolCallCount: scan.toolCallCount,
      tokenCount: scan.tokenCount,
      outputTokens: scan.outputTokens,
      inputTokens: scan.inputTokens,
      cacheReadTokens: scan.cacheReadTokens,
      cacheWriteTokens: scan.cacheWriteTokens,
      costUsd: scan.costUsd,
      costUsdNoCache: scan.costUsdNoCache,
      durationMs: scan.durationMs,
      isTeamOrigin,
      prUrl: scan.prUrl,
      prNumber: scan.prNumber,
      worktreeSlug: scan.worktreeSlug,
      ticketId: scan.ticketId,
      createdTickets: scan.createdTickets,
      spawnedTeam: scan.spawnedTeam,
      plan: scan.plan,
      todos: scan.todos,
      recentDirectoriesTouched: scan.recentDirectoriesTouched,
      skillsUsed: scan.skillsUsed,
      slashCommandsUsed: scan.slashCommandsUsed,
    };
  } else {
    const stat = safeStatSync(filePath);
    meta = {
      id: sessionId,
      shortId: deriveShortId(sessionId),
      agent: 'claude',
      timestamp: stat ? stat.mtime.toISOString() : new Date().toISOString(),
      lastActivity: scan.lastActivity,
      filePath,
      account: acct.email ?? undefined,
      accountKey: acct.key,
      accountOrg: acct.orgName ?? undefined,
      model: scan.model,
      label,
      messageCount: scan.messageCount,
      toolCallCount: scan.toolCallCount,
      tokenCount: scan.tokenCount,
      outputTokens: scan.outputTokens,
      inputTokens: scan.inputTokens,
      cacheReadTokens: scan.cacheReadTokens,
      cacheWriteTokens: scan.cacheWriteTokens,
      costUsd: scan.costUsd,
      costUsdNoCache: scan.costUsdNoCache,
      durationMs: scan.durationMs,
      topic: scan.topic,
      isTeamOrigin,
      prUrl: scan.prUrl,
      prNumber: scan.prNumber,
      worktreeSlug: scan.worktreeSlug,
      ticketId: scan.ticketId,
      createdTickets: scan.createdTickets,
      spawnedTeam: scan.spawnedTeam,
      plan: scan.plan,
      todos: scan.todos,
      recentDirectoriesTouched: scan.recentDirectoriesTouched,
      skillsUsed: scan.skillsUsed,
      slashCommandsUsed: scan.slashCommandsUsed,
    };
  }

  return {
    meta,
    content: scan.contentText || '',
    // Persist the continuation so the next scan of this file can resume from the
    // offset instead of a full reparse. content_text is the same accumulated user
    // doc, cached so the resume can hydrate userTexts without re-reading the file.
    parserState: JSON.stringify(newState),
    contentText: newState.contentText,
    toolCalls,
    toolIndexMode: mode === 'full' ? 'replace' : 'append',
  };
}

// ---------------------------------------------------------------------------
// Codex account info
// ---------------------------------------------------------------------------

let cachedCodexAccount: string | undefined;

/** Number of times the auth.json JWT was actually base64-decoded. Test seam for the lazy-decode contract. */
let codexAccountResolveCount = 0;

/**
 * Base64url-decode a JWT and return its `email` claim, if present. Split out so
 * the decode is a single, testable step — and so it only runs when someone
 * actually reads the Codex account (see the lazy resolution below).
 */
export function decodeJwtEmail(idToken: string): string | undefined {
  const parts = idToken.split('.');
  if (parts.length < 2) return undefined;
  try {
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf-8'));
    return typeof payload.email === 'string' ? payload.email : undefined;
  } catch {
    return undefined; // malformed JWT
  }
}

/**
 * Extract the Codex account email from the JWT id_token in auth.json.
 *
 * Memoized and resolved LAZILY: the credential-harvesting-shaped JWT decode
 * (base64-decoding ~/.codex/auth.json) only runs when the account is actually
 * needed to build a session's metadata — never eagerly during the bulk scan.
 * A scan with no changed Codex files never touches the auth file.
 */
function getCodexAccount(): string | undefined {
  if (cachedCodexAccount !== undefined) return cachedCodexAccount || undefined;
  codexAccountResolveCount++;

  const candidates = [path.join(HOME, '.codex', 'auth.json')];

  for (const root of VERSIONS_ROOTS) {
    const versionsBase = path.join(root, 'versions', 'codex');
    if (!fs.existsSync(versionsBase)) continue;
    try {
      for (const version of fs.readdirSync(versionsBase)) {
        candidates.push(path.join(versionsBase, version, 'home', '.codex', 'auth.json'));
      }
    } catch { /* versions dir unreadable */ }
  }

  for (const candidate of candidates) {
    try {
      if (!fs.existsSync(candidate)) continue;
      const data = JSON.parse(fs.readFileSync(candidate, 'utf-8'));
      const idToken = data.tokens?.id_token;
      if (idToken) {
        const email = decodeJwtEmail(idToken);
        if (email) {
          cachedCodexAccount = email;
          return email;
        }
      }
    } catch { /* auth file malformed */ }
  }

  cachedCodexAccount = '';
  return undefined;
}

/** Test seam: how many times getCodexAccount has actually resolved (decoded) since the last reset. */
export function __codexAccountResolveCountForTest(): number {
  return codexAccountResolveCount;
}

/** Test seam: clear the memoized account + resolve counter so laziness can be observed from a clean slate. */
export function __resetCodexAccountCacheForTest(): void {
  cachedCodexAccount = undefined;
  codexAccountResolveCount = 0;
}

// ---------------------------------------------------------------------------
// Codex
// ---------------------------------------------------------------------------

/** Incrementally re-scan changed Codex session files and upsert into the DB. */
async function scanCodexIncremental(onProgress?: (p: ScanProgress) => void): Promise<void> {
  // Lazy: getCodexAccount (the auth.json JWT decode) is only resolved by
  // readCodexMeta when a changed session actually needs it — never eagerly here,
  // so a no-op scan (changed.length === 0) never touches the credential file.
  const currentVersion = await getCurrentAgentVersion('codex');

  const prestat: PreStatEntry[] = [];
  for (const sessionsDir of getAgentSessionDirs('codex', 'sessions')) {
    // High limit: the walk stats each file once here; parsing is gated by the
    // ledger match below, which reuses that stat instead of re-stat'ing.
    for (const f of walkForFilesWithStat(sessionsDir, '.jsonl', 100_000)) {
      prestat.push({ filePath: f.path, fileMtimeMs: f.mtimeMs, fileSize: f.size });
    }
  }

  const changed = filterChangedEntries(prestat);

  // Codex keeps human-readable titles (`thread_name`) in `session_index.jsonl`,
  // which updates independently of the rollout files. Stat each index against the
  // ledger *without reading it*; only read + re-apply titles when the index (or a
  // rollout) actually changed. On a fully unchanged scan this collapses to a
  // couple of stat() calls instead of a full read + a `syncTopics` DB pass.
  const titleIndex = diffCodexTitleIndexes();

  if (changed.length === 0 && !titleIndex.changed) return;

  const titles = readCodexThreadNames();

  if (changed.length === 0) {
    // No rollouts changed, but the title index did — apply the new titles.
    syncTopics(titles);
    recordScans(titleIndex.stamps);
    return;
  }

  onProgress?.({ agent: 'codex', parsed: 0, total: changed.length });

  // Bulk-fetch each changed rollout's prior resumable continuation. A file with
  // a usable prior state + growth goes incremental (re-parse only the appended
  // bytes); everything else does a FULL from-offset-0 parse. The decision + the
  // parse both live in scanCodexSessionResumable so full and incremental share
  // one reducer and produce identical rows.
  const priorStates = getParserStatesForPaths(changed.map(c => c.filePath));

  const entries: ScanEntry[] = [];
  const touched: Array<{ filePath: string; scan: ScanStamp }> = [];
  const seen = new Set<string>();
  let parsed = 0;
  for (const { filePath, scan } of changed) {
    try {
      const priorRow = priorStates.get(filePath);
      const result = await readCodexMeta(filePath, getCodexAccount, currentVersion, scan, priorRow);
      if (result && !seen.has(result.meta.id)) {
        seen.add(result.meta.id);
        // Prefer the Codex-generated title over the first-prompt fallback.
        const title = titles.get(result.meta.id);
        if (title) result.meta.topic = title;
        entries.push({
          meta: result.meta,
          content: result.content,
          scan,
          parserState: result.parserState,
          contentText: result.contentText,
          toolCalls: result.toolCalls,
          toolIndexMode: result.toolIndexMode,
        });
      } else {
        touched.push({ filePath, scan });
      }
    } catch {
      touched.push({ filePath, scan });
    }
    parsed++;
    onProgress?.({ agent: 'codex', parsed, total: changed.length });
  }

  upsertSessionsBatch(entries);
  recordScans(touched);
  // Only when the title index changed can an *unchanged* rollout have gained a
  // title since the last scan; the inline titles applied above already cover
  // every changed session, so skip the extra sync when the index is untouched.
  if (titleIndex.changed) syncTopics(titles);
  recordScans(titleIndex.stamps);
}

/** Parse the lines of a Codex `session_index.jsonl` into a session id -> title map. */
export function parseCodexThreadNameIndex(raw: string): Map<string, string> {
  const titles = new Map<string, string>();
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line);
      const id = typeof entry.id === 'string' ? entry.id : '';
      const name = typeof entry.thread_name === 'string' ? entry.thread_name.trim() : '';
      if (id && name) titles.set(id, name);
    } catch {
      // skip malformed line
    }
  }
  return titles;
}

/**
 * Stat every Codex `session_index.jsonl` and diff it against the scan ledger
 * *without reading it*. Returns the fresh stamps (persisted only after a
 * successful title sync) and whether any index changed since the last scan — the
 * signal that lets a no-op scan skip the file read + `syncTopics` entirely.
 *
 * The index path is a sibling of `sessions/` (never inside it), so it is never
 * walked as a rollout and its ledger row can't collide with a transcript's.
 */
function diffCodexTitleIndexes(): {
  stamps: Array<{ filePath: string; scan: ScanStamp }>;
  changed: boolean;
} {
  const stamps: Array<{ filePath: string; scan: ScanStamp }> = [];
  let changed = false;
  for (const sessionsDir of getAgentSessionDirs('codex', 'sessions')) {
    const indexPath = path.join(path.dirname(sessionsDir), 'session_index.jsonl');
    const stat = safeStatSync(indexPath);
    if (!stat) continue; // no index in this home
    const scan: ScanStamp = { fileMtimeMs: Math.floor(stat.mtimeMs), fileSize: stat.size };
    const prev = getScanStampByPath(indexPath);
    if (!prev || prev.fileMtimeMs !== scan.fileMtimeMs || prev.fileSize !== scan.fileSize) {
      changed = true;
    }
    stamps.push({ filePath: indexPath, scan });
  }
  return { stamps, changed };
}

/**
 * Read Codex session titles across every Codex home (live + versioned). The
 * `session_index.jsonl` file sits beside each `sessions/` rollout tree.
 */
function readCodexThreadNames(): Map<string, string> {
  const titles = new Map<string, string>();
  for (const sessionsDir of getAgentSessionDirs('codex', 'sessions')) {
    const indexPath = path.join(path.dirname(sessionsDir), 'session_index.jsonl');
    let raw: string;
    try {
      raw = fs.readFileSync(indexPath, 'utf-8');
    } catch {
      continue; // no index in this home
    }
    for (const [id, name] of parseCodexThreadNameIndex(raw)) titles.set(id, name);
  }
  return titles;
}

/**
 * Stream-parse a single Codex JSONL file to extract session metadata.
 *
 * `resolveAccount` is a lazy thunk (not a resolved string): the JWT decode it
 * performs is deferred until we know this file is a real session worth building
 * metadata for, and only then — never during the file walk / stat phase.
 */
export async function readCodexMeta(
  filePath: string,
  resolveAccount?: () => string | undefined,
  currentVersion?: string,
  scanStamp?: ScanStamp,
  priorRow?: { parserState: string | null; fileMtimeMs: number },
): Promise<{
  meta: SessionMeta;
  content: string;
  parserState?: string;
  contentText?: string;
  toolCalls?: IndexedToolCall[];
  toolIndexMode: 'replace' | 'append';
} | null> {
  // Resume from the persisted continuation when the file merely grew; otherwise
  // full-parse from byte 0. Both branches share one reducer, so an append yields
  // a row identical to a from-scratch reparse. When no stamp is supplied (a
  // caller outside the live scan path), fall back to a plain full parse with no
  // continuation to persist.
  let scan: CodexSessionScan;
  let newState: CodexParserState | undefined;
  let newOffset = 0;
  let toolCalls: IndexedToolCall[] | undefined;
  let toolIndexMode: 'replace' | 'append' = 'replace';
  if (scanStamp) {
    const prior = parsePriorCodexState(priorRow);
    const result = await scanCodexSessionResumable(
      filePath,
      prior,
      scanStamp.fileMtimeMs,
      scanStamp.fileSize,
      priorRow?.fileMtimeMs,
    );
    if (result.mode === 'incremental') codexIncrementalScanCount++;
    else codexFullScanCount++;
    scan = result.scan;
    newState = result.newState;
    newOffset = result.newOffset;
    toolCalls = result.toolCalls;
    toolIndexMode = result.mode === 'full' ? 'replace' : 'append';
  } else {
    scan = await scanCodexSession(filePath);
  }

  const sessionId = scan.sessionId || '';
  if (!sessionId) return null;

  const cwd = normalizeCwd(scan.cwd || '');
  const meta: SessionMeta = {
    id: sessionId,
    shortId: deriveShortId(sessionId),
    agent: 'codex',
    // Codex `session_meta` only carries the start time; use file mtime when
    // it's newer so long-running sessions register as recently active.
    timestamp: pickLatestCodexTimestamp(scan.timestamp, filePath),
    lastActivity: scan.lastActivity,
    project: cwd ? path.basename(cwd) : undefined,
    cwd,
    filePath,
    gitBranch: scan.gitBranch,
    version: resolveSessionVersion('codex', filePath, scan.version, currentVersion),
    model: scan.model,
    topic: scan.topic,
    messageCount: scan.messageCount,
    tokenCount: scan.tokenCount,
    outputTokens: scan.outputTokens,
    inputTokens: scan.inputTokens,
    cacheReadTokens: scan.cacheReadTokens,
    cacheWriteTokens: scan.cacheWriteTokens,
    costUsd: scan.costUsd,
    costUsdNoCache: scan.costUsdNoCache,
    durationMs: scan.durationMs,
    account: resolveAccount?.(),
    prUrl: scan.prUrl,
    prNumber: scan.prNumber,
    worktreeSlug: scan.worktreeSlug,
    ticketId: scan.ticketId,
    createdTickets: scan.createdTickets,
    spawnedTeam: scan.spawnedTeam,
    todos: scan.todos,
    recentDirectoriesTouched: scan.recentDirectoriesTouched,
  };
  return {
    meta,
    content: scan.contentText || '',
    // Persist the continuation so the next scan of this rollout resumes from the
    // offset instead of a full reparse; content_text caches the accumulated user
    // doc for the resume's hydrate. Absent when no stamp was supplied.
    parserState: newState ? JSON.stringify(newState) : undefined,
    contentText: newState?.contentText,
    toolCalls,
    toolIndexMode,
  };
}

/**
 * Codex writes `session_meta` (with the start timestamp) on the first line of a
 * rollout and never updates it. For long-running sessions that's stale by
 * hours — `--since 2h` would drop a session still being actively written.
 * Compare against the file's mtime and use whichever is newer.
 */
function pickLatestCodexTimestamp(metaTimestamp: string | undefined, filePath: string): string {
  const fallback = new Date().toISOString();
  let mtimeIso: string | null = null;
  try {
    mtimeIso = fs.statSync(filePath).mtime.toISOString();
  } catch {
    /* file vanished between scan and stat */
  }

  const candidates = [metaTimestamp, mtimeIso].filter((v): v is string => !!v);
  if (candidates.length === 0) return fallback;

  return candidates.reduce((best, cur) => (cur > best ? cur : best));
}

// ---------------------------------------------------------------------------
// Gemini
// ---------------------------------------------------------------------------

/** Incrementally re-scan changed Gemini session files and upsert into the DB. */
async function scanGeminiIncremental(onProgress?: (p: ScanProgress) => void): Promise<void> {
  const currentVersion = await getCurrentAgentVersion('gemini');
  const projectMap = buildGeminiProjectMap();

  // Each `<tmpDir>/<hashDir>/chats` is a leaf dir of Gemini transcripts. The
  // FIRST tmp root is the live `~/.gemini/tmp` — its chats dirs are live roots;
  // version-home + backup roots are immutable and short-circuit when unchanged.
  const tmpRoots = getAgentSessionDirs('gemini', 'tmp');
  const leafDirs: LeafDir[] = [];
  const seenLeaf = new Set<string>();
  tmpRoots.forEach((tmpDir, rootIdx) => {
    const isLiveRoot = rootIdx === 0;
    let hashDirs: string[];
    try {
      hashDirs = fs.readdirSync(tmpDir);
    } catch {
      return;
    }
    for (const hashDir of hashDirs) {
      const chatsDir = path.join(tmpDir, hashDir, 'chats');
      if (!fs.existsSync(chatsDir)) continue;
      const key = safeRealpathSync(chatsDir) || chatsDir;
      if (seenLeaf.has(key)) continue;
      seenLeaf.add(key);
      leafDirs.push({ dirPath: chatsDir, isLiveRoot });
    }
  });

  const { changed } = collectChangedFilesInLeafDirs(leafDirs, '.json');
  const changedByPath = new Map(changed.map(c => [c.filePath, c.scan]));
  if (changedByPath.size === 0) return;

  onProgress?.({ agent: 'gemini', parsed: 0, total: changedByPath.size });

  const entries: ScanEntry[] = [];
  const touched: Array<{ filePath: string; scan: ScanStamp }> = [];
  const seen = new Set<string>();
  let parsed = 0;
  for (const { filePath, scan } of changed) {
    // The hashDir is the directory two levels up: <hashDir>/chats/<file>.json.
    const hashDir = path.basename(path.dirname(path.dirname(filePath)));
    try {
      const result = readGeminiMeta(filePath, hashDir, projectMap, currentVersion);
      if (result && !seen.has(result.meta.id)) {
        seen.add(result.meta.id);
        entries.push({ meta: result.meta, content: result.content, scan });
      } else {
        // Gemini file without a sessionId — record scan so we don't re-parse it next run.
        touched.push({ filePath, scan });
      }
    } catch {
      touched.push({ filePath, scan });
    }
    parsed++;
    onProgress?.({ agent: 'gemini', parsed, total: changedByPath.size });
  }

  upsertSessionsBatch(entries);
  recordScans(touched);
}

/** Parse a single Gemini JSON session file to extract session metadata. */
function readGeminiMeta(
  filePath: string,
  hashDir: string,
  projectMap: Map<string, { name: string; path: string }>,
  currentVersion?: string,
): { meta: SessionMeta; content: string } | null {
  let session: any;
  try {
    session = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch {
    return null;
  }

  const sessionId = typeof session.sessionId === 'string' ? session.sessionId : '';
  const startTime = typeof session.startTime === 'string' ? session.startTime : '';
  const projectHash = typeof session.projectHash === 'string' ? session.projectHash : '';
  const embeddedVersion = typeof session.version === 'string'
    ? session.version
    : typeof session.cliVersion === 'string'
      ? session.cliVersion
      : undefined;
  if (!sessionId) return null;

  const projectInfo = projectMap.get(projectHash || hashDir);
  const project = projectInfo?.name || hashDir.slice(0, 12);
  const cwd = projectInfo?.path ? normalizeCwd(projectInfo.path) : undefined;

  const stat = safeStatSync(filePath);

  const messages = Array.isArray(session.messages) ? session.messages : [];
  const sessionModel = typeof session.model === 'string' ? session.model : undefined;
  let topic: string | undefined;
  let messageCount = 0;
  let tokenCount = 0;
  let outputTokens = 0;
  let inputTokens = 0;
  let cacheReadTokens = 0;
  let sawTokenCount = false;
  let costUsd = 0;
  let costUsdNoCache = 0;
  let sawCost = false;
  let firstTsMs: number | undefined;
  let lastTsMs: number | undefined;
  const userTexts: string[] = [];

  for (const message of messages) {
    if (message.type === 'user') {
      const text = extractGeminiMessageText(message.content);
      if (text) {
        messageCount++;
        userTexts.push(text);
        if (!topic) topic = extractSessionTopic(text);
      }
    } else if (message.type === 'gemini') {
      if (extractGeminiMessageText(message.content)) {
        messageCount++;
      }
    }

    // Duration: messages carry a `timestamp` on most Gemini CLI versions.
    const tsRaw = message.timestamp ?? message.time;
    if (typeof tsRaw === 'string' || typeof tsRaw === 'number') {
      const ms = new Date(tsRaw).getTime();
      if (!Number.isNaN(ms)) {
        if (firstTsMs === undefined || ms < firstTsMs) firstTsMs = ms;
        if (lastTsMs === undefined || ms > lastTsMs) lastTsMs = ms;
      }
    }

    const total = getGeminiTokenCount(message.tokens);
    if (total !== null) {
      tokenCount += total;
      sawTokenCount = true;
    }
    // Output tokens: sum directional generation fields per message (output +
    // thoughts + tool), mirroring the cost path — never `tokens.total`, which
    // may be cumulative and would double-count when summed.
    const gtk = message.tokens;
    if (gtk && typeof gtk === 'object') {
      outputTokens +=
        (typeof gtk.output === 'number' ? gtk.output : 0) +
        (typeof gtk.thoughts === 'number' ? gtk.thoughts : 0) +
        (typeof gtk.tool === 'number' ? gtk.tool : 0);
      // Burn split (RUSH-2287): Gemini has uncached input + cache-read, no cache-write.
      if (typeof gtk.input === 'number') inputTokens += gtk.input;
      if (typeof gtk.cached === 'number') cacheReadTokens += gtk.cached;
    }

    // Per-message cost: directional tokens × this message's model price.
    const msgModel = (typeof message.model === 'string' ? message.model : undefined) || sessionModel;
    const tk = message.tokens;
    if (msgModel && tk && typeof tk === 'object') {
      const usage = {
        model: msgModel,
        inputTokens: typeof tk.input === 'number' ? tk.input : undefined,
        outputTokens:
          (typeof tk.output === 'number' ? tk.output : 0) +
          (typeof tk.thoughts === 'number' ? tk.thoughts : 0) +
          (typeof tk.tool === 'number' ? tk.tool : 0),
        cacheReadTokens: typeof tk.cached === 'number' ? tk.cached : undefined,
      };
      const c = costOfUsage(usage);
      if (c > 0) {
        costUsd += c;
        costUsdNoCache += costOfUsageNoCache(usage);
        sawCost = true;
      }
    }
  }

  const durationMs =
    firstTsMs !== undefined && lastTsMs !== undefined && lastTsMs > firstTsMs
      ? lastTsMs - firstTsMs
      : undefined;

  const meta: SessionMeta = {
    id: sessionId,
    shortId: deriveShortId(sessionId),
    agent: 'gemini',
    timestamp: startTime || (stat ? stat.mtime.toISOString() : new Date().toISOString()),
    lastActivity: lastTsMs !== undefined ? new Date(lastTsMs).toISOString() : undefined,
    project,
    cwd,
    filePath,
    version: resolveSessionVersion('gemini', filePath, embeddedVersion, currentVersion),
    model: sessionModel,
    topic,
    messageCount,
    tokenCount: sawTokenCount ? tokenCount : undefined,
    outputTokens: sawTokenCount ? outputTokens : undefined,
    inputTokens: sawTokenCount ? inputTokens : undefined,
    cacheReadTokens: sawTokenCount ? cacheReadTokens : undefined,
    costUsd: sawCost ? costUsd : undefined,
    costUsdNoCache: sawCost ? costUsdNoCache : undefined,
    durationMs,
  };
  return { meta, content: userTexts.join('\n') };
}

/** Build a hash-to-project mapping from Gemini's projects.json and history directories. */
function buildGeminiProjectMap(): Map<string, { name: string; path: string }> {
  const map = new Map<string, { name: string; path: string }>();
  const projectsJsonPath = path.join(HOME, '.gemini', 'projects.json');

  if (fs.existsSync(projectsJsonPath)) {
    try {
      const data = JSON.parse(fs.readFileSync(projectsJsonPath, 'utf-8'));
      const projects = data.projects;

      if (typeof projects === 'object' && projects !== null) {
        if (Array.isArray(projects)) {
          for (const p of projects) {
            if (typeof p === 'string') {
              const hash = sha256(p);
              map.set(hash, { name: path.basename(p), path: p });
              map.set(p, { name: path.basename(p), path: p });
            }
          }
        } else {
          for (const [p, name] of Object.entries(projects)) {
            const hash = sha256(p);
            map.set(hash, { name: String(name), path: p });
          }
        }
      }
    } catch { /* projects.json missing or malformed */ }
  }

  const historyDir = path.join(HOME, '.gemini', 'history');
  if (fs.existsSync(historyDir)) {
    try {
      for (const name of fs.readdirSync(historyDir)) {
        const rootFile = path.join(historyDir, name, '.project_root');
        if (fs.existsSync(rootFile)) {
          try {
            const projectPath = fs.readFileSync(rootFile, 'utf-8').trim();
            if (projectPath) {
              const hash = sha256(projectPath);
              map.set(hash, { name, path: projectPath });
            }
          } catch { /* history entry unreadable */ }
        }
      }
    } catch { /* history entry unreadable */ }
  }

  return map;
}

// ---------------------------------------------------------------------------
// Antigravity
//
// Antigravity stores one SQLite DB per conversation at
// ~/.gemini/antigravity-cli/conversations/<trajectory-uuid>.db. The filename
// (minus .db) is the canonical session id. Each DB is stat'd against the ledger;
// only changed DBs are re-parsed (via parseAntigravity, which shells out to
// sqlite3). Tool count doubles as the message count; the toolSummary of the
// first tool call becomes the topic, and any run_command's Cwd fills in cwd.
// ---------------------------------------------------------------------------

/** Incrementally re-scan changed Antigravity conversation DBs and upsert into the DB. */
async function scanAntigravityIncremental(onProgress?: (p: ScanProgress) => void): Promise<void> {
  const currentVersion = await getCurrentAgentVersion('antigravity');

  const filePaths: string[] = [];
  const seenPaths = new Set<string>();
  for (const conversationsDir of getAgentSessionDirs('antigravity', 'conversations')) {
    let files: string[];
    try {
      files = fs.readdirSync(conversationsDir).filter(f => f.endsWith('.db'));
    } catch {
      continue;
    }
    for (const file of files) {
      const fp = path.join(conversationsDir, file);
      if (seenPaths.has(fp)) continue;
      seenPaths.add(fp);
      filePaths.push(fp);
    }
  }

  const changed = filterChangedFiles(filePaths);
  if (changed.length === 0) return;

  onProgress?.({ agent: 'antigravity', parsed: 0, total: changed.length });

  const entries: ScanEntry[] = [];
  const touched: Array<{ filePath: string; scan: ScanStamp }> = [];
  const seen = new Set<string>();
  let parsed = 0;
  for (const { filePath, scan } of changed) {
    try {
      const result = readAntigravityMeta(filePath, currentVersion);
      if (result && !seen.has(result.meta.id)) {
        seen.add(result.meta.id);
        entries.push({ meta: result.meta, content: result.content, scan, events: result.events });
      } else {
        touched.push({ filePath, scan });
      }
    } catch {
      touched.push({ filePath, scan });
    }
    parsed++;
    onProgress?.({ agent: 'antigravity', parsed, total: changed.length });
  }

  upsertSessionsBatch(entries);
  recordScans(touched);
}

/** Parse a single Antigravity conversation DB to extract session metadata. */
function readAntigravityMeta(
  filePath: string,
  currentVersion?: string,
): { meta: SessionMeta; content: string; events: SessionEvent[] } | null {
  const sessionId = path.basename(filePath).replace(/\.db$/, '');
  if (!sessionId) return null;

  const events = parseAntigravity(filePath);

  // cwd: first run_command carries the working directory in its Cwd arg.
  let cwd: string | undefined;
  const contentParts: string[] = [];
  for (const e of events) {
    if (!cwd && typeof e.args?.Cwd === 'string' && e.args.Cwd) cwd = e.args.Cwd;
    if (e.content) contentParts.push(e.content);
  }
  const normalizedCwd = cwd ? normalizeCwd(cwd) : undefined;

  // Topic: the first tool's human summary is a decent one-line label.
  const topic = events.find(e => e.content)?.content;

  const stat = safeStatSync(filePath);
  const meta: SessionMeta = {
    id: sessionId,
    shortId: deriveShortId(sessionId),
    agent: 'antigravity',
    timestamp: stat ? stat.mtime.toISOString() : new Date().toISOString(),
    project: normalizedCwd ? path.basename(normalizedCwd) : undefined,
    cwd: normalizedCwd,
    filePath,
    version: resolveSessionVersion('antigravity', filePath, undefined, currentVersion),
    topic: topic ? topic.slice(0, 120) : undefined,
    messageCount: events.length,
  };
  return { meta, content: contentParts.join('\n'), events };
}

// ---------------------------------------------------------------------------
// OpenCode
// ---------------------------------------------------------------------------

const OPENCODE_DB = path.join(HOME, '.local', 'share', 'opencode', 'opencode.db');

let cachedOpenCodeAccount: string | undefined;

/**
 * The active OpenCode account: the provider ids with a valid credential in
 * `auth.json`, joined (e.g. `"anthropic+muse-spark"`) — see
 * `resolveOpenCodeAccountId` in `../agents.js`, the single source of truth
 * `agents view`/`agents doctor` also read.
 *
 * OpenCode's `opencode.db` also carries `account`/`account_state`/
 * `control_account` tables that look like the obvious source, but on a real,
 * actively-used install (yosemite-s1, 1.16.0, 35 applied migrations) all
 * three are permanently empty — no migration populates them and no session
 * has ever written a row. Querying them (the pre-fix behavior here) always
 * returned undefined, credential or not; `auth.json` is what OpenCode
 * actually reads at runtime.
 */
function getOpenCodeAccount(): string | undefined {
  if (cachedOpenCodeAccount !== undefined) return cachedOpenCodeAccount || undefined;
  cachedOpenCodeAccount = resolveOpenCodeAccountId(HOME) ?? '';
  return cachedOpenCodeAccount || undefined;
}

/**
 * The per-session ledger stamp for an OpenCode row: the newest write time across
 * the session's own row, its messages, and its parts, paired with the total byte
 * length of that session's message + part payloads.
 *
 * OpenCode keeps every session in ONE shared SQLite file, so that file's
 * mtime/size changes whenever *any* session is written. Stamping each session
 * with the whole-DB stat therefore invalidated every indexed session on every
 * scan: up to `LIMIT 1000` sessions were re-emitted into `upsertSessionsBatch`,
 * and its enrichment step re-opened `opencode.db` once per re-emitted entry via
 * `parseSession` (RUSH-2210).
 *
 * `s.time_updated` alone is NOT that session's change signal, which is the trap
 * this shape exists to avoid. On a real database, parts land long after the
 * session row was last touched — e.g. `ses_3955202dfffe…` carried
 * `time_updated = 1771316403087` with its newest part at `1771331512162`, over
 * four hours later. So the stamp maxes `time_updated` with the newest message
 * and part times, and pairs it with a byte total that also moves when an
 * existing part's `data` is rewritten in place (a streaming turn) without any
 * new row or timestamp.
 *
 * The byte total is a REAL size, not a repurposed counter, because
 * `sessions.file_size` is read back as bytes elsewhere: `ensureToolIndex` uses
 * it as the tool-backfill byte budget and `toolCallsForBackfill` as the 16 MiB
 * in-memory parser cap (`tool-index.ts`). A message/part byte total is the
 * honest cost of parsing that session — strictly better than the whole-DB size
 * this column used to hold for every OpenCode row.
 *
 * The size is `LENGTH(CAST(data AS BLOB))`, not `LENGTH(data)`: SQLite's
 * `LENGTH()` on a TEXT column counts CHARACTERS, so a CJK/emoji-heavy transcript
 * would under-report its real size by up to 4x — and this number is a byte
 * budget downstream.
 *
 * A degenerate row — nothing but zeros/NaN for every time AND no payload at all
 * — falls back to the whole-DB stat, keeping the pre-RUSH-2210 always-rescan
 * behavior for exactly those rows rather than pinning them to a stamp that never
 * changes.
 */
function openCodeSessionStamp(
  times: { timeUpdated: number; timeCreated: number; lastMessageAt: number; lastPartAt: number },
  bytes: { messageBytes: number; partBytes: number },
  dbScan: ScanStamp,
): ScanStamp {
  // A positive time, not merely a finite one: the SQL COALESCEs the aggregates
  // to 0, so `Number.isFinite` alone would accept a row that told us nothing and
  // this branch could never fire.
  const known = [times.timeUpdated, times.lastMessageAt, times.lastPartAt, times.timeCreated]
    .filter(t => Number.isFinite(t) && t > 0);
  const size = (Number.isFinite(bytes.messageBytes) ? bytes.messageBytes : 0)
    + (Number.isFinite(bytes.partBytes) ? bytes.partBytes : 0);
  if (known.length === 0 && size === 0) return dbScan;
  return { fileMtimeMs: known.length === 0 ? 0 : Math.floor(Math.max(...known)), fileSize: size };
}

/** Scan OpenCode sessions from its SQLite database when the DB file has changed. */
async function scanOpenCodeIncremental(onProgress?: (p: ScanProgress) => void): Promise<void> {
  if (!fs.existsSync(OPENCODE_DB)) return;

  const stat = safeStatSync(OPENCODE_DB);
  if (!stat) return;

  // OpenCode is one big DB. Its mtime/size is the cheap "did ANYTHING change"
  // short-circuit for the whole harness — not the per-session stamp, which each
  // row carries itself (see openCodeSessionStamp, RUSH-2210).
  const currentScan: ScanStamp = {
    fileMtimeMs: Math.floor(stat.mtimeMs),
    fileSize: stat.size,
  };
  const prev = getScanStampByPath(OPENCODE_DB);
  if (prev && prev.fileMtimeMs === currentScan.fileMtimeMs && prev.fileSize === currentScan.fileSize) {
    return;
  }

  const currentVersion = await getCurrentAgentVersion('opencode');

  // Read through the node/bun SQLite wrapper (not the `sqlite3` CLI) so this
  // works on every OS — the CLI is absent on Windows.
  let db: Database.Database | undefined;
  try {
    db = new Database(OPENCODE_DB);
    // OpenCode's `session` schema varies by version: `cost` and `model` are newer
    // columns. Probe once and select NULL where absent, so an older opencode.db
    // still scans instead of throwing "no such column" and dropping every session.
    const sessionCols = new Set(
      (db.prepare('PRAGMA table_info(session);').all() as Array<{ name?: unknown }>)
        .map(c => (typeof c.name === 'string' ? c.name : '')),
    );
    const costExpr = sessionCols.has('cost') ? 's.cost' : 'NULL';
    const modelExpr = sessionCols.has('model') ? 's.model' : 'NULL';
    // Every `json_extract` / `json_type` below is guarded by `json_valid`.
    // SQLite raises "malformed JSON" on a non-JSON value, and that aborts the
    // WHOLE query — so a single unparseable `part`/`message` row anywhere in the
    // shared DB would drop EVERY OpenCode session from the index, silently in a
    // non-TTY run (the handler below only prints when stderr is a TTY). A
    // poisoned row must cost that row, not the harness.
    const query = `
      SELECT
        s.id AS id,
        s.title AS title,
        s.directory AS directory,
        s.version AS version,
        ${costExpr} AS cost,
        ${modelExpr} AS model,
        s.time_created AS time_created,
        s.time_updated AS time_updated,
        COALESCE(stats.message_count, 0) AS message_count,
        COALESCE(stats.last_message_at, 0) AS last_message_at,
        COALESCE(stats.message_bytes, 0) AS message_bytes,
        COALESCE(parts.last_part_at, 0) AS last_part_at,
        COALESCE(parts.part_bytes, 0) AS part_bytes,
        COALESCE(parts.tool_call_count, 0) AS tool_call_count,
        stats.token_count AS token_count,
        stats.output_tokens AS output_tokens,
        stats.input_tokens AS input_tokens,
        stats.cache_read_tokens AS cache_read_tokens,
        stats.cache_write_tokens AS cache_write_tokens,
        COALESCE(stats.has_token_data, 0) AS has_token_data
      FROM session s
      LEFT JOIN (
        SELECT
          session_id,
          MAX(time_created) AS last_part_at,
          SUM(LENGTH(CAST(data AS BLOB))) AS part_bytes,
          SUM(CASE WHEN json_valid(data) AND json_extract(data, '$.type') = 'tool' THEN 1 ELSE 0 END) AS tool_call_count
        FROM part
        GROUP BY session_id
      ) parts ON parts.session_id = s.id
      LEFT JOIN (
        SELECT
          session_id,
          COUNT(*) AS message_count,
          MAX(time_created) AS last_message_at,
          SUM(LENGTH(CAST(data AS BLOB))) AS message_bytes,
          SUM(CASE WHEN json_valid(data) THEN
            COALESCE(json_extract(data, '$.tokens.input'), 0) +
            COALESCE(json_extract(data, '$.tokens.output'), 0) +
            COALESCE(json_extract(data, '$.tokens.reasoning'), 0) +
            COALESCE(json_extract(data, '$.tokens.cache.read'), 0) +
            COALESCE(json_extract(data, '$.tokens.cache.write'), 0)
          ELSE 0 END) AS token_count,
          SUM(CASE WHEN json_valid(data) THEN COALESCE(json_extract(data, '$.tokens.output'), 0) ELSE 0 END) AS output_tokens,
          SUM(CASE WHEN json_valid(data) THEN COALESCE(json_extract(data, '$.tokens.input'), 0) ELSE 0 END) AS input_tokens,
          SUM(CASE WHEN json_valid(data) THEN COALESCE(json_extract(data, '$.tokens.cache.read'), 0) ELSE 0 END) AS cache_read_tokens,
          SUM(CASE WHEN json_valid(data) THEN COALESCE(json_extract(data, '$.tokens.cache.write'), 0) ELSE 0 END) AS cache_write_tokens,
          MAX(CASE WHEN json_valid(data) AND json_type(data, '$.tokens') IS NOT NULL THEN 1 ELSE 0 END) AS has_token_data
        FROM message
        GROUP BY session_id
      ) stats ON stats.session_id = s.id
      WHERE s.parent_id IS NULL
      ORDER BY time_created DESC
      LIMIT 1000;
    `.replace(/\n/g, ' ');

    const account = getOpenCodeAccount();
    const rows = db.prepare(query).all() as Array<{
      id: unknown;
      title: unknown;
      directory: unknown;
      version: unknown;
      cost: unknown;
      model: unknown;
      time_created: unknown;
      time_updated: unknown;
      message_count: unknown;
      last_message_at: unknown;
      message_bytes: unknown;
      last_part_at: unknown;
      part_bytes: unknown;
      tool_call_count: unknown;
      token_count: unknown;
      output_tokens: unknown;
      input_tokens: unknown;
      cache_read_tokens: unknown;
      cache_write_tokens: unknown;
      has_token_data: unknown;
    }>;

    // Two passes. First derive each row's identity + per-session stamp, then
    // bulk-load the prior stamps in ONE query and keep only the rows that
    // actually changed. Skipped rows never reach upsertSessionsBatch, so they
    // never pay its per-entry `parseSession` re-open of this same DB.
    const asInt = (v: unknown): number =>
      typeof v === 'number' ? v : parseInt(String(v), 10);
    const candidates = rows.flatMap(row => {
      const id = typeof row.id === 'string' ? row.id : '';
      if (!id) return [];
      const filePath = `${OPENCODE_DB}#${id}`;
      return [{
        row,
        id,
        filePath,
        scan: openCodeSessionStamp(
          {
            timeUpdated: asInt(row.time_updated),
            timeCreated: asInt(row.time_created),
            lastMessageAt: asInt(row.last_message_at),
            lastPartAt: asInt(row.last_part_at),
          },
          { messageBytes: asInt(row.message_bytes), partBytes: asInt(row.part_bytes) },
          currentScan,
        ),
      }];
    });
    const priorStamps = getScanStampsForPaths(candidates.map(c => c.filePath));
    const changed = candidates.filter(c => {
      const prevStamp = priorStamps.get(c.filePath);
      return !prevStamp
        || prevStamp.fileMtimeMs !== c.scan.fileMtimeMs
        || prevStamp.fileSize !== c.scan.fileSize;
    });

    const entries: ScanEntry[] = [];
    for (const { row, id, filePath, scan } of changed) {
      const title = typeof row.title === 'string' ? row.title : '';
      const directory = typeof row.directory === 'string' ? row.directory : '';
      const version = typeof row.version === 'string' ? row.version : '';

      const timeCreated = asInt(row.time_created);
      const timeUpdated = asInt(row.time_updated);
      const messageCount = asInt(row.message_count);
      const tokenCount = asInt(row.token_count);
      const outputTokens = asInt(row.output_tokens);
      const inputTokens = asInt(row.input_tokens);
      const cacheReadTokens = asInt(row.cache_read_tokens);
      const cacheWriteTokens = asInt(row.cache_write_tokens);
      const hasTokenData = asInt(row.has_token_data) === 1;
      const toolCallCount = asInt(row.tool_call_count);
      const timestamp = isNaN(timeCreated) ? new Date().toISOString() : new Date(timeCreated).toISOString();
      // OpenCode is one shared DB, not one file per session — its row carries a
      // per-session updated time. Set lastActivity explicitly (falling back to
      // creation, never the whole-DB mtime the ScanStamp would otherwise supply).
      const lastActivity = Number.isNaN(timeUpdated) ? timestamp : new Date(timeUpdated).toISOString();
      const topic = title || undefined;

      // Duration is the session-row span; a missing/degenerate pair yields no value
      // rather than a negative or NaN.
      const durationMs =
        Number.isFinite(timeCreated) && Number.isFinite(timeUpdated) && timeUpdated > timeCreated
          ? timeUpdated - timeCreated
          : undefined;
      // OpenCode stores the model as JSON (`{"id":"…","providerID":"…"}`); the
      // index tracks the model id.
      let model: string | undefined;
      if (typeof row.model === 'string' && row.model.trim()) {
        try {
          const parsed = JSON.parse(row.model) as { id?: unknown };
          if (typeof parsed?.id === 'string' && parsed.id.trim()) model = parsed.id;
        } catch { /* non-JSON model string — leave unset */ }
      }
      // `cost` is a REAL rollup OpenCode maintains on the session row (0 for a
      // zero-priced provider, which is a real value, not "unknown").
      const costUsd = typeof row.cost === 'number' ? row.cost : undefined;

      // Worktree slug is a pure function of cwd (`.agents/worktrees/<slug>/`),
      // so it derives for OpenCode exactly as it does for every other harness.
      const cwd = directory ? normalizeCwd(directory) : undefined;
      const worktreeSlug = detectWorktree(cwd)?.slug;

      const meta: SessionMeta = {
        id,
        shortId: deriveShortId(id, /^ses_/),
        agent: 'opencode',
        timestamp,
        lastActivity,
        project: directory ? path.basename(directory) : undefined,
        cwd,
        filePath,
        version: resolveSessionVersion('opencode', OPENCODE_DB, version || undefined, currentVersion),
        account,
        topic,
        model,
        costUsd,
        durationMs,
        worktreeSlug,
        toolCallCount: Number.isNaN(toolCallCount) ? undefined : toolCallCount,
        messageCount: Number.isNaN(messageCount) ? undefined : messageCount,
        tokenCount: hasTokenData && !Number.isNaN(tokenCount) ? tokenCount : undefined,
        outputTokens: hasTokenData && !Number.isNaN(outputTokens) ? outputTokens : undefined,
        inputTokens: hasTokenData && !Number.isNaN(inputTokens) ? inputTokens : undefined,
        cacheReadTokens: hasTokenData && !Number.isNaN(cacheReadTokens) ? cacheReadTokens : undefined,
        cacheWriteTokens: hasTokenData && !Number.isNaN(cacheWriteTokens) ? cacheWriteTokens : undefined,
      };

      entries.push({ meta, content: topic || '', scan });
    }

    upsertSessionsBatch(entries);
    // Report what this scan indexed. OpenCode is one SQLite DB rather than N
    // transcript files, so the whole batch lands as a single progress emit —
    // enough for the daemon's warm tick to count it (RUSH-2691); without it a
    // tick whose only changed sessions were OpenCode's reported 0 and logged
    // nothing, the same silent-success class this tick exists to remove.
    onProgress?.({ agent: 'opencode', parsed: entries.length, total: entries.length });
    // Stamp the OpenCode DB itself so we can short-circuit on the next run.
    recordScans([{ filePath: OPENCODE_DB, scan: currentScan }]);
  } catch (err: any) {
    if (process.stderr.isTTY) {
      console.error(`Warning: Could not query OpenCode sessions: ${err.message}`);
    }
  } finally {
    try { db?.close(); } catch { /* best-effort close */ }
  }
}

// ---------------------------------------------------------------------------
// OpenClaw
// ---------------------------------------------------------------------------

/** Scan active OpenClaw channels and cron jobs via the openclaw CLI. */
async function scanOpenClawIncremental(onProgress?: (p: ScanProgress) => void): Promise<void> {
  // Check if openclaw is installed — silently skip if not. `which` is POSIX-only
  // (Windows resolves PATH with `where`), so a bare `which` throws ENOENT on every
  // Windows run and silently disabled the entire OpenClaw scan there — its sessions
  // never reached the index (RUSH-2286). hasCommand() probes cross-platform.
  if (!hasCommand('openclaw')) return;

  // TTL cache: skip subprocess calls if we scanned recently. Stored in the
  // meta table so we skip even when no channels/cron exist to produce rows.
  const db = getDB();
  const row = db.prepare(`SELECT value FROM meta WHERE key = 'openclaw_last_scan_ms'`).get() as { value: string } | undefined;
  const lastScanMs = row ? parseInt(row.value, 10) : 0;
  if (lastScanMs && Date.now() - lastScanMs < OPENCLAW_TTL_MS) {
    return;
  }

  const currentVersion = await getCurrentAgentVersion('openclaw');
  const now = Date.now();
  const scan: ScanStamp = { fileMtimeMs: now, fileSize: 0 };
  const entries: ScanEntry[] = [];

  try {
    // On Windows `openclaw` resolves to a .cmd/.ps1 shim that execFile can't launch
    // directly; execFileShellSpec composes a shell-safe invocation there and is a
    // no-op passthrough on POSIX (RUSH-2286).
    const channelsSpec = execFileShellSpec('openclaw', ['channels', 'status']);
    const { stdout: output } = await execFileAsync(channelsSpec.command, channelsSpec.args, {
      encoding: 'utf-8',
      shell: channelsSpec.shell,
    });

    for (const line of output.split('\n')) {
      const match = line.match(/^-\s+\w+\s+(\S+)\s+\((\w+)\):\s*(.+)/);
      if (!match) continue;
      const [, agentId, name, statusStr] = match;
      if (!statusStr.includes('running')) continue;

      entries.push({
        meta: {
          id: `openclaw-${agentId}`,
          shortId: deriveShortId(agentId),
          agent: 'openclaw',
          timestamp: new Date().toISOString(),
          project: name,
          cwd: getOpenClawSessionCwd(agentId),
          version: currentVersion,
          filePath: '',
        },
        content: `${name} ${agentId}`,
        scan,
      });
    }
  } catch {
    /* channels command failed */
  }

  try {
    const cronSpec = execFileShellSpec('openclaw', ['cron', 'list']);
    const { stdout: output } = await execFileAsync(cronSpec.command, cronSpec.args, {
      encoding: 'utf-8',
      shell: cronSpec.shell,
    });

    const lines = output.split('\n');
    for (let i = 1; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line) continue;

      const headMatch = line.match(/^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\s+(\S+)/);
      if (!headMatch) continue;
      const jobId = headMatch[1];
      const jobName = headMatch[2];

      const rest = line.slice(headMatch[0].length).trim();
      const cols = rest.split(/\s{2,}/);
      const agentId = cols[4] || '';

      entries.push({
        meta: {
          id: `openclaw-cron-${jobId}`,
          shortId: deriveShortId(jobId),
          agent: 'openclaw',
          timestamp: new Date().toISOString(),
          project: `${jobName} (${agentId || 'unknown'})`,
          cwd: getOpenClawSessionCwd(agentId),
          version: currentVersion,
          filePath: '',
        },
        content: `${jobName} ${agentId}`,
        scan,
      });
    }
  } catch {
    /* cron command failed */
  }

  upsertSessionsBatch(entries);
  // Deliberately NO onProgress emit, unlike every other scanner (RUSH-2691).
  // This one cannot report a delta: its gate is a 60s TTL (not a store stamp),
  // `scan` above stamps a fresh `now` on every entry every run, and `entries` is
  // the CURRENT INVENTORY — running channels plus cron jobs — rebuilt from
  // scratch each pass. Emitting entries.length would report "how many openclaw
  // things exist", re-counted every 60s forever, which is a worse lie than
  // silence: the warm tick's number means "transcripts parsed this scan". Giving
  // OpenClaw a real per-entry stamp is tracked separately; until then it
  // contributes 0 and the docblock on IncrementalScanResult says so.
  db.prepare(`INSERT OR REPLACE INTO meta (key, value) VALUES ('openclaw_last_scan_ms', ?)`).run(String(Date.now()));
}

// ---------------------------------------------------------------------------
// Rush
//
// Rush sessions live at ~/.rush/sessions/<session-id>/messages.jsonl.
// Each line is { id, session_id, agent_id, role, type, content, created_at, ... }.
// The directory name is the canonical session id. Rush sessions are cloud-bound
// (not tied to a local cwd), so cwd is left unset.
// ---------------------------------------------------------------------------

interface RushSessionScan {
  timestamp?: string;
  topic?: string;
  agentId?: string;
  messageCount: number;
  contentText?: string;
}

/** Incrementally re-scan changed Rush session files and upsert into the DB. */
async function scanRushIncremental(onProgress?: (p: ScanProgress) => void): Promise<void> {
  if (!fs.existsSync(RUSH_SESSIONS_DIR)) return;

  const filePaths: string[] = [];
  let dirNames: string[];
  try {
    dirNames = fs.readdirSync(RUSH_SESSIONS_DIR);
  } catch {
    return;
  }

  for (const dirName of dirNames) {
    const sessionDir = path.join(RUSH_SESSIONS_DIR, dirName);
    const stat = safeStatSync(sessionDir);
    if (!stat?.isDirectory()) continue;
    const messagesPath = path.join(sessionDir, 'messages.jsonl');
    if (!fs.existsSync(messagesPath)) continue;
    filePaths.push(messagesPath);
  }

  const changed = filterChangedFiles(filePaths);
  if (changed.length === 0) return;

  onProgress?.({ agent: 'rush', parsed: 0, total: changed.length });

  const entries: ScanEntry[] = [];
  const touched: Array<{ filePath: string; scan: ScanStamp }> = [];
  let parsed = 0;
  for (const { filePath, scan } of changed) {
    try {
      const sessionId = path.basename(path.dirname(filePath));
      const result = await readRushMeta(filePath, sessionId);
      if (result) {
        entries.push({ meta: result.meta, content: result.content, scan });
      } else {
        touched.push({ filePath, scan });
      }
    } catch {
      touched.push({ filePath, scan });
    }
    parsed++;
    onProgress?.({ agent: 'rush', parsed, total: changed.length });
  }

  upsertSessionsBatch(entries);
  recordScans(touched);
}

/** Stream-parse a single Rush messages.jsonl file to extract session metadata. */
async function readRushMeta(
  filePath: string,
  sessionId: string,
): Promise<{ meta: SessionMeta; content: string } | null> {
  const scan = await scanRushSession(filePath);

  const stat = safeStatSync(filePath);
  const timestamp = scan.timestamp
    || (stat ? stat.mtime.toISOString() : new Date().toISOString());

  const shortId = deriveShortId(sessionId, /^session_/);

  const meta: SessionMeta = {
    id: sessionId,
    shortId,
    agent: 'rush',
    timestamp,
    project: scan.agentId,
    filePath,
    topic: scan.topic,
    messageCount: scan.messageCount,
  };

  return { meta, content: scan.contentText || '' };
}

/** Stream a Rush messages.jsonl file and extract scan-level metadata. */
async function scanRushSession(filePath: string): Promise<RushSessionScan> {
  const stream = fs.createReadStream(filePath, { encoding: 'utf-8' });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

  let timestamp: string | undefined;
  let topic: string | undefined;
  let agentId: string | undefined;
  let messageCount = 0;
  const userTexts: string[] = [];

  try {
    for await (const line of rl) {
      if (!line.trim()) continue;

      let parsed: any;
      try {
        parsed = JSON.parse(line);
      } catch {
        continue;
      }

      if (!timestamp && typeof parsed.created_at === 'string') {
        timestamp = parsed.created_at;
      }
      if (!agentId && typeof parsed.agent_id === 'string') {
        agentId = parsed.agent_id;
      }

      if (parsed.type !== 'message') continue;
      const text = typeof parsed.content?.text === 'string' ? parsed.content.text.trim() : '';
      if (!text) continue;

      const cleaned = text
        .replace(/^<user_input>/, '')
        .replace(/<\/user_input>$/, '')
        .trim();
      if (!cleaned) continue;
      if (parsed.role === 'system' && cleaned === 'execution_start') continue;

      messageCount++;
      if (parsed.role === 'user') {
        userTexts.push(cleaned);
        if (!topic) topic = extractSessionTopic(cleaned);
      }
    }
  } finally {
    rl.close();
    stream.destroy();
  }

  return {
    timestamp,
    topic,
    agentId,
    messageCount,
    contentText: userTexts.length > 0 ? userTexts.join('\n') : undefined,
  };
}

// ---------------------------------------------------------------------------
// Hermes
//
// Hermes sessions live at ~/.hermes/sessions/session_<id>.json (one JSON
// file per session). Shape:
//   { session_id, model, platform, session_start, last_updated,
//     system_prompt, message_count, messages: [{role, content}, ...] }
// request_dump_*.json files in the same dir are per-turn debug dumps — skip.
// Hermes is a gateway/API agent, so cwd is left unset.
// ---------------------------------------------------------------------------

/** Incrementally re-scan changed Hermes session files and upsert into the DB. */
async function scanHermesIncremental(onProgress?: (p: ScanProgress) => void): Promise<void> {
  if (!fs.existsSync(HERMES_SESSIONS_DIR)) return;

  let entries: string[];
  try {
    entries = fs.readdirSync(HERMES_SESSIONS_DIR);
  } catch {
    return;
  }

  const filePaths: string[] = [];
  for (const name of entries) {
    if (!name.startsWith('session_') || !name.endsWith('.json')) continue;
    filePaths.push(path.join(HERMES_SESSIONS_DIR, name));
  }

  const changed = filterChangedFiles(filePaths);
  if (changed.length === 0) return;

  onProgress?.({ agent: 'hermes', parsed: 0, total: changed.length });

  const scanEntries: ScanEntry[] = [];
  const touched: Array<{ filePath: string; scan: ScanStamp }> = [];
  const seen = new Set<string>();
  let parsed = 0;
  for (const { filePath, scan } of changed) {
    try {
      const result = readHermesMeta(filePath);
      if (result && !seen.has(result.meta.id)) {
        seen.add(result.meta.id);
        scanEntries.push({ meta: result.meta, content: result.content, scan });
      } else {
        touched.push({ filePath, scan });
      }
    } catch {
      touched.push({ filePath, scan });
    }
    parsed++;
    onProgress?.({ agent: 'hermes', parsed, total: changed.length });
  }

  upsertSessionsBatch(scanEntries);
  recordScans(touched);
}

/** Parse a single Hermes session JSON file to extract session metadata. */
function readHermesMeta(filePath: string): { meta: SessionMeta; content: string } | null {
  let session: any;
  try {
    session = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch {
    return null;
  }

  const sessionId = typeof session.session_id === 'string' ? session.session_id : '';
  if (!sessionId) return null;

  const messages = Array.isArray(session.messages) ? session.messages : [];
  const userTexts: string[] = [];
  let topic: string | undefined;
  let messageCount = 0;
  for (const msg of messages) {
    const text = extractHermesMessageText(msg?.content);
    if (!text) continue;
    messageCount++;
    if (msg?.role === 'user') {
      userTexts.push(text);
      if (!topic) topic = extractSessionTopic(text);
    }
  }

  const stat = safeStatSync(filePath);
  const timestamp = typeof session.last_updated === 'string'
    ? session.last_updated
    : typeof session.session_start === 'string'
      ? session.session_start
      : stat ? stat.mtime.toISOString() : new Date().toISOString();

  const shortId = deriveShortId(sessionId, /^api-/);
  const model = typeof session.model === 'string' ? session.model : undefined;
  const platform = typeof session.platform === 'string' ? session.platform : undefined;

  const meta: SessionMeta = {
    id: sessionId,
    shortId,
    agent: 'hermes',
    timestamp,
    project: platform,
    filePath,
    version: model,
    model,
    topic,
    messageCount: messageCount || (typeof session.message_count === 'number' ? session.message_count : undefined),
  };

  return { meta, content: userTexts.join('\n') };
}

/**
 * Muse Code stores one session per directory under
 * ~/.local/share/muse/sessions/YYYY/MM/DD/<uuid>/session.jsonl (event-sourced
 * JSONL). Walk the tree for session.jsonl files and index each one.
 *
 * Also scan version homes (`versions/muse/<v>/home/.local/share/muse/sessions`)
 * so managed/isolated runs that rewrite HOME still show up in `agents sessions`.
 */
function scanMuseIncremental(onProgress?: (p: ScanProgress) => void): Promise<void> {
  const roots: string[] = [];
  if (fs.existsSync(MUSE_SESSIONS_DIR)) roots.push(MUSE_SESSIONS_DIR);
  for (const root of VERSIONS_ROOTS) {
    const versionsBase = path.join(root, 'versions', 'muse');
    if (!fs.existsSync(versionsBase)) continue;
    try {
      for (const version of fs.readdirSync(versionsBase)) {
        const dir = path.join(versionsBase, version, 'home', '.local', 'share', 'muse', 'sessions');
        if (fs.existsSync(dir)) roots.push(dir);
      }
    } catch {
      /* unreadable */
    }
  }
  if (roots.length === 0) return Promise.resolve();

  const filePaths: string[] = [];
  const walk = (dir: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        // Skip subagent child sessions — nested under subagent/<id>/
        if (ent.name === 'subagent') continue;
        walk(full);
      } else if (ent.name === 'session.jsonl') {
        filePaths.push(full);
      }
    }
  };
  for (const root of roots) walk(root);

  const changed = filterChangedFiles(filePaths);
  if (changed.length === 0) return Promise.resolve();

  onProgress?.({ agent: 'muse', parsed: 0, total: changed.length });

  const scanEntries: ScanEntry[] = [];
  const touched: Array<{ filePath: string; scan: ScanStamp }> = [];
  const seen = new Set<string>();
  let parsed = 0;
  for (const { filePath, scan } of changed) {
    try {
      const result = readMuseMeta(filePath);
      if (result && !seen.has(result.meta.id)) {
        seen.add(result.meta.id);
        scanEntries.push({ meta: result.meta, content: result.content, scan });
      } else {
        touched.push({ filePath, scan });
      }
    } catch {
      touched.push({ filePath, scan });
    }
    parsed++;
    onProgress?.({ agent: 'muse', parsed, total: changed.length });
  }

  upsertSessionsBatch(scanEntries);
  recordScans(touched);
  return Promise.resolve();
}

/** Parse a Muse session.jsonl for session metadata + first user prompt text. */
function readMuseMeta(filePath: string): { meta: SessionMeta; content: string } | null {
  // Path shape: .../sessions/YYYY/MM/DD/<uuid>/session.jsonl
  const sessionId = path.basename(path.dirname(filePath));
  if (!/^[0-9a-f-]{36}$/i.test(sessionId)) return null;

  let content: string;
  try {
    content = fs.readFileSync(filePath, 'utf-8');
  } catch {
    return null;
  }

  const userTexts: string[] = [];
  let topic: string | undefined;
  let messageCount = 0;
  let model: string | undefined;
  let project: string | undefined;
  let firstTs: string | undefined;
  let lastTs: string | undefined;

  for (const line of content.split('\n')) {
    if (!line.trim()) continue;
    let raw: any;
    try {
      raw = JSON.parse(line);
    } catch {
      continue;
    }

    if (typeof raw.recorded_at === 'number') {
      const v = raw.recorded_at as number;
      // Muse logs use microseconds; values < 1e14 are treated as milliseconds.
      const ms = v > 1e14 ? Math.floor(v / 1000) : v;
      const ts = new Date(ms).toISOString();
      if (!firstTs) firstTs = ts;
      lastTs = ts;
    }

    const payloadType = raw.payload_type as string | undefined;
    const payload = raw.payload;

    if (payloadType === 'runtime.session.metadata') {
      const record = payload?.record;
      if (typeof record?.workspace_root === 'string') project = record.workspace_root;
    }

    if (payloadType === 'runtime.command_intake.received') {
      const cmd = payload?.record?.command;
      if (cmd?.kind === 'turn_submit' && typeof cmd.prompt === 'string' && cmd.prompt.trim()) {
        messageCount++;
        userTexts.push(cmd.prompt.trim());
        if (!topic) topic = extractSessionTopic(cmd.prompt.trim());
      }
    }

    const event = payload?.event ?? payload;
    if (event?.kind === 'assistant_message_committed' && typeof event.text === 'string') {
      messageCount++;
    }
    if (event?.kind === 'model_request_configured' && typeof event.model === 'string') {
      model = event.model;
    }
    if (typeof event?.model === 'string' && !model) model = event.model;
  }

  const stat = safeStatSync(filePath);
  const timestamp = lastTs
    || firstTs
    || (stat ? stat.mtime.toISOString() : new Date().toISOString());

  const shortId = deriveShortId(sessionId);
  const meta: SessionMeta = {
    id: sessionId,
    shortId,
    agent: 'muse',
    timestamp,
    project,
    filePath,
    model,
    topic,
    messageCount: messageCount || undefined,
  };

  return { meta, content: userTexts.join('\n') };
}

/** Extract plain text from a Hermes message content field (string or list of parts). */
function extractHermesMessageText(content: any): string {
  if (typeof content === 'string') return content.trim();
  if (!Array.isArray(content)) return '';
  return content
    .map((part: any) => {
      if (typeof part === 'string') return part;
      if (typeof part?.text === 'string') return part.text;
      return '';
    })
    .join('\n')
    .trim();
}

// ---------------------------------------------------------------------------
// Droid (Factory)
// ---------------------------------------------------------------------------

/** Lightweight metadata extracted from a Droid JSONL file during incremental scan. */
interface DroidSessionScan {
  sessionId?: string;
  timestamp?: string;
  cwd?: string;
  topic?: string;
  model?: string;
  messageCount: number;
  durationMs?: number;
  lastActivity?: string;
  contentText?: string;
}

/**
 * Incrementally re-scan changed Droid (Factory) session files and upsert into
 * the DB. Droid writes one `<uuid>.jsonl` transcript plus a sibling
 * `<uuid>.settings.json` (model + token usage) under
 * `~/.factory/sessions/<encoded-cwd>/`.
 */
async function scanDroidIncremental(onProgress?: (p: ScanProgress) => void): Promise<void> {
  const currentVersion = await getCurrentAgentVersion('droid');

  const prestat: PreStatEntry[] = [];
  for (const sessionsDir of getAgentSessionDirs('droid', 'sessions')) {
    // High limit: the walk stats each file once here; parsing is gated by the
    // ledger match below, which reuses that stat instead of re-stat'ing.
    for (const f of walkForFilesWithStat(sessionsDir, '.jsonl', 100_000)) {
      prestat.push({ filePath: f.path, fileMtimeMs: f.mtimeMs, fileSize: f.size });
    }
  }

  const changed = filterChangedEntries(prestat);
  if (changed.length === 0) return;

  onProgress?.({ agent: 'droid', parsed: 0, total: changed.length });

  const entries: ScanEntry[] = [];
  const touched: Array<{ filePath: string; scan: ScanStamp }> = [];
  const seen = new Set<string>();
  let parsed = 0;
  for (const { filePath, scan } of changed) {
    try {
      const result = await readDroidMeta(filePath, currentVersion);
      if (result && !seen.has(result.meta.id)) {
        seen.add(result.meta.id);
        entries.push({ meta: result.meta, content: result.content, scan });
      } else {
        touched.push({ filePath, scan });
      }
    } catch {
      touched.push({ filePath, scan });
    }
    parsed++;
    onProgress?.({ agent: 'droid', parsed, total: changed.length });
  }

  upsertSessionsBatch(entries);
  recordScans(touched);
}

/** Stream-parse a single Droid JSONL file (+ sibling settings) into session metadata. */
async function readDroidMeta(
  filePath: string,
  currentVersion?: string,
): Promise<{ meta: SessionMeta; content: string } | null> {
  const scan = await scanDroidSession(filePath);
  // The filename is the canonical session id; fall back to the session_start id.
  const sessionId = path.basename(filePath).replace(/\.jsonl$/, '') || scan.sessionId || '';
  if (!sessionId) return null;

  // Token usage and cost live only in the sibling `<uuid>.settings.json`.
  const settings = readDroidSettings(filePath.replace(/\.jsonl$/, '.settings.json'));
  const model = settings.model || scan.model;
  const tokenCount = settings.tokenCount;
  // Droid records a full split (input / cache-read / cache-write / output) in its
  // settings sidecar, so both the actual and no-cache cost are derivable (RUSH-2287).
  const usageForCost = model && settings.usage
    ? {
        model,
        inputTokens: settings.usage.inputTokens,
        outputTokens: settings.usage.outputTokens,
        cacheReadTokens: settings.usage.cacheReadTokens,
        cacheCreationTokens: settings.usage.cacheCreationTokens,
      }
    : undefined;
  const costUsd = usageForCost ? costOfUsage(usageForCost) : 0;
  const costUsdNoCache = usageForCost ? costOfUsageNoCache(usageForCost) : 0;

  const stat = safeStatSync(filePath);
  const cwd = normalizeCwd(scan.cwd || '');
  const meta: SessionMeta = {
    id: sessionId,
    shortId: deriveShortId(sessionId),
    agent: 'droid',
    timestamp: scan.timestamp || (stat ? stat.mtime.toISOString() : new Date().toISOString()),
    lastActivity: scan.lastActivity,
    project: cwd ? path.basename(cwd) : undefined,
    cwd,
    filePath,
    version: resolveSessionVersion('droid', filePath, undefined, currentVersion),
    model,
    topic: scan.topic,
    messageCount: scan.messageCount,
    tokenCount,
    outputTokens: settings.usage?.outputTokens,
    inputTokens: settings.usage?.inputTokens,
    cacheReadTokens: settings.usage?.cacheReadTokens,
    cacheWriteTokens: settings.usage?.cacheCreationTokens,
    costUsd: costUsd > 0 ? costUsd : undefined,
    costUsdNoCache: costUsd > 0 ? costUsdNoCache : undefined,
    durationMs: scan.durationMs,
  };
  return { meta, content: scan.contentText || '' };
}

/** Read model + token usage from a Droid `<uuid>.settings.json` sidecar. */
function readDroidSettings(settingsPath: string): {
  model?: string;
  tokenCount?: number;
  usage?: { inputTokens?: number; outputTokens?: number; cacheReadTokens?: number; cacheCreationTokens?: number };
} {
  try {
    const data = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
    const model = typeof data.model === 'string' ? data.model : undefined;
    const u = data.tokenUsage;
    if (!u || typeof u !== 'object') return { model };
    const usage = {
      inputTokens: u.inputTokens,
      outputTokens: u.outputTokens,
      cacheReadTokens: u.cacheReadTokens,
      cacheCreationTokens: u.cacheCreationTokens,
    };
    const tokenCount = sumKnownNumbers([
      u.inputTokens,
      u.outputTokens,
      u.cacheCreationTokens,
      u.cacheReadTokens,
    ]) ?? undefined;
    return { model, tokenCount, usage };
  } catch {
    return {};
  }
}

/** Stream a Droid JSONL file and extract scan-level metadata (id, cwd, topic, model, duration). */
async function scanDroidSession(filePath: string): Promise<DroidSessionScan> {
  const stream = fs.createReadStream(filePath, { encoding: 'utf-8' });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

  let sessionId: string | undefined;
  let timestamp: string | undefined;
  let cwd: string | undefined;
  let title: string | undefined;
  let sessionTitle: string | undefined;
  let firstUserTopic: string | undefined;
  let model: string | undefined;
  let messageCount = 0;
  let firstTsMs: number | undefined;
  let lastTsMs: number | undefined;
  const userTexts: string[] = [];

  try {
    for await (const line of rl) {
      if (!line.trim()) continue;

      let parsed: any;
      try {
        parsed = JSON.parse(line);
      } catch {
        continue;
      }

      if (parsed.type === 'session_start') {
        sessionId = typeof parsed.id === 'string' ? parsed.id : sessionId;
        cwd = typeof parsed.cwd === 'string' ? parsed.cwd : cwd;
        // Droid auto-generates `sessionTitle`; `title` is the raw first prompt.
        if (typeof parsed.sessionTitle === 'string' && parsed.sessionTitle.trim()) {
          sessionTitle = parsed.sessionTitle.trim();
        }
        if (typeof parsed.title === 'string' && parsed.title.trim()) {
          title = parsed.title.trim();
        }
        continue;
      }

      if (parsed.type !== 'message') continue;

      // Track duration across every timestamped message.
      if (typeof parsed.timestamp === 'string') {
        const ms = new Date(parsed.timestamp).getTime();
        if (!Number.isNaN(ms)) {
          if (firstTsMs === undefined || ms < firstTsMs) firstTsMs = ms;
          if (lastTsMs === undefined || ms > lastTsMs) lastTsMs = ms;
        }
      }
      if (!timestamp && typeof parsed.timestamp === 'string') timestamp = parsed.timestamp;

      const msg = parsed.message || {};
      if (typeof msg.modelId === 'string') model = msg.modelId;

      const text = extractDroidMessageText(msg.content);
      if (!text) continue;
      messageCount++;
      if (msg.role === 'user') {
        userTexts.push(text);
        if (!firstUserTopic) firstUserTopic = extractSessionTopic(text);
      }
    }
  } finally {
    rl.close();
    stream.destroy();
  }

  const durationMs =
    firstTsMs !== undefined && lastTsMs !== undefined && lastTsMs > firstTsMs
      ? lastTsMs - firstTsMs
      : undefined;

  return {
    sessionId,
    timestamp,
    cwd,
    // Prefer Droid's auto-title, then the raw first-prompt title, then the
    // derived first-user-message topic.
    topic: sessionTitle || title || firstUserTopic,
    model,
    messageCount,
    durationMs,
    lastActivity: lastTsMs !== undefined ? new Date(lastTsMs).toISOString() : undefined,
    contentText: userTexts.length > 0 ? userTexts.join('\n') : undefined,
  };
}

/** Extract plain text from a Droid message content field (Anthropic-shaped blocks). */
function extractDroidMessageText(content: any): string {
  if (typeof content === 'string') return content.trim();
  if (!Array.isArray(content)) return '';
  return content
    .map((part: any) => (typeof part?.text === 'string' && part.type === 'text' ? part.text : ''))
    // Droid front-loads injected context (date, skills list) as <system-reminder>
    // text blocks on the first user turn — drop them so topic/content stay clean.
    .filter((text: string) => text.trim() && !text.trim().startsWith('<system-reminder>'))
    .join('\n')
    .trim();
}

/**
 * Mutable accumulator for the Claude transcript reducer. One field per local
 * that {@link scanClaudeSession} previously declared inline — the reducer
 * mutates `state.*` instead of closure locals so the exact same logic can drive
 * both a full parse and a resumable incremental parse (see
 * {@link scanClaudeSessionIncremental}).
 */
interface ClaudeParseState {
  timestamp?: string;
  cwd?: string;
  gitBranch?: string;
  version?: string;
  model?: string;
  topic?: string;
  // Explicit session titles: `/rename` writes a `custom-title` event; Claude
  // auto-generates an `ai-title`. Both can repeat across the file — last wins.
  customTitle?: string;
  aiTitle?: string;
  entrypoint?: string;
  messageCount: number;
  toolCallCount: number;
  tokenCount: number;
  outputTokens: number;
  // Burn split accumulators (RUSH-2287): uncached input / cache-read / cache-write.
  inputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  sawTokenCount: boolean;
  costUsd: number;
  // Same session cost with cache read/write repriced at the input rate.
  costUsdNoCache: number;
  sawCost: boolean;
  // Track the first and last timestamped event to derive wall-clock duration.
  firstTsMs?: number;
  lastTsMs?: number;
  seenAssistantIds: Set<string>;
  userTexts: string[];
  // Durable PR signal: set only when an actual `gh pr create` Bash *command*
  // runs (structural — the command field, not any prose mentioning it), then
  // capture the pull URL from a later tool_result's output.
  sawPrCreate: boolean;
  prUrl?: string;
  prNumber?: number;
  // Artifacts the session PRODUCED: tracker refs it created and any team it spawned.
  // Ticket creation spans two events — a create_issue tool_use, then the tool_result
  // carrying the new id — so we hold the pending tool_use ids until their result lands.
  createdTickets: Set<string>;
  pendingTicketTools: Set<string>;
  spawnedTeam?: string;
  // The LAST ExitPlanMode plan wins so a re-planned session surfaces its most
  // recent plan, matching the semantic the extension's re-parser relied on.
  plan?: string;
  checklistEvents: SessionEvent[];
  recentDirectoriesTouched: string[];
  toolCollector: ToolCallCollector;
  /** Skill-invocation tool_use events, held for extractSkills() at finalize (#12). */
  skillEvents: SessionEvent[];
  /** Slash-command events (user-typed <command-name> wrapper OR a SlashCommand
   *  tool_use), held for extractSlashCommands() at finalize (#12). */
  slashCommandEvents: SessionEvent[];
}

/** Zero-value accumulator for a fresh (from-byte-0) Claude parse. */
export function initClaudeParseState(): ClaudeParseState {
  return {
    timestamp: undefined,
    cwd: undefined,
    gitBranch: undefined,
    version: undefined,
    model: undefined,
    topic: undefined,
    customTitle: undefined,
    aiTitle: undefined,
    entrypoint: undefined,
    messageCount: 0,
    toolCallCount: 0,
    tokenCount: 0,
    outputTokens: 0,
    inputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    sawTokenCount: false,
    costUsd: 0,
    costUsdNoCache: 0,
    sawCost: false,
    firstTsMs: undefined,
    lastTsMs: undefined,
    seenAssistantIds: new Set<string>(),
    userTexts: [],
    sawPrCreate: false,
    prUrl: undefined,
    prNumber: undefined,
    createdTickets: new Set<string>(),
    pendingTicketTools: new Set<string>(),
    spawnedTeam: undefined,
    plan: undefined,
    checklistEvents: [],
    recentDirectoriesTouched: [],
    toolCollector: new ToolCallCollector(),
    skillEvents: [],
    slashCommandEvents: [],
  };
}

const CHECKLIST_TOOLS = new Set(['TodoWrite', 'todo_write', 'update_plan', 'TaskCreate', 'TaskUpdate']);
const DIRECTORY_TOOLS = new Set(['Edit', 'Write', 'edit_file', 'write_file', 'create_file', 'edit', 'write', 'Bash', 'exec_command', 'run_shell_command', 'shell', 'Execute']);

function foldDerivedToolState(
  state: {
    checklistEvents: SessionEvent[];
    recentDirectoriesTouched: string[];
    skillEvents: SessionEvent[];
    slashCommandEvents: SessionEvent[];
    cwd?: string;
  },
  event: SessionEvent,
): void {
  if (CHECKLIST_TOOLS.has(event.tool ?? '')) state.checklistEvents.push(event);
  // #12: skill/slash-command usage, held here instead of re-parsed later — the
  // same reason checklistEvents is folded incrementally rather than recomputed
  // from a full re-parse (see session/db.ts's writeResourceUsage doc comment).
  if (isSkillInvocation(event)) state.skillEvents.push(event);
  if (event.tool === 'SlashCommand') {
    const slashCommand = extractSlashCommandFromToolInput(event.args);
    if (slashCommand) state.slashCommandEvents.push({ ...event, slashCommand });
  }
  if (!DIRECTORY_TOOLS.has(event.tool ?? '')) return;
  const next = extractRecentDirectoriesTouched([event], state.cwd);
  for (const dir of next ?? []) {
    const old = state.recentDirectoriesTouched.indexOf(dir);
    if (old >= 0) state.recentDirectoriesTouched.splice(old, 1);
    state.recentDirectoriesTouched.push(dir);
  }
  if (state.recentDirectoriesTouched.length > 10) state.recentDirectoriesTouched.splice(0, state.recentDirectoriesTouched.length - 10);
}

/**
 * Fold one parsed transcript line into the accumulator. This is the exact loop
 * body {@link scanClaudeSession} used to run inline — extracted verbatim,
 * mutating `state.*` in place. `parsed` is the already-`JSON.parse`d line (the
 * malformed-line skip happens in the caller, as before).
 */
export function applyClaudeLine(state: ClaudeParseState, parsed: any): void {
  collectClaudeToolCalls(state.toolCollector, parsed);
  // entrypoint ships on the first envelope event (attachment/user/assistant)
  // and is the clean structural signal for "was this a team spawn?"
  if (!state.entrypoint && typeof parsed.entrypoint === 'string') {
    state.entrypoint = parsed.entrypoint;
  }

  // Produced-artifact signals, structurally (independent of the PR gate below):
  //   - a Bash `agents teams create/add` command → the team it spawned
  //   - a Linear create_issue / `gh issue create` tool_use → its result carries
  //     the new ticket ref, read from the matching tool_result.
  if (parsed.type === 'assistant' && Array.isArray(parsed.message?.content)) {
    for (const b of parsed.message.content) {
      if (b?.type !== 'tool_use') continue;
      state.toolCallCount++;
      if (!state.spawnedTeam && typeof b?.input?.command === 'string') {
        const team = detectSpawnedTeam(b.input.command);
        if (team) state.spawnedTeam = team;
      }
      if (typeof b?.id === 'string' && isTicketCreateTool(b?.name, b?.input?.command)) {
        state.pendingTicketTools.add(b.id);
      }
      // ExitPlanMode plan markdown — last one wins so a re-planned session
      // reports its most recent plan.
      if (b?.name === 'ExitPlanMode' && typeof b?.input?.plan === 'string') {
        const p = b.input.plan.trim();
        if (p) state.plan = b.input.plan;
      }
      foldDerivedToolState(state, {
        type: 'tool_use', agent: 'claude', timestamp: parsed.timestamp || '', tool: b?.name, args: b?.input || {},
        path: b?.input?.file_path || b?.input?.path, command: b?.input?.command,
      });
    }
  }
  if (state.pendingTicketTools.size > 0 && parsed.type === 'user' && Array.isArray(parsed.message?.content)) {
    for (const b of parsed.message.content) {
      if (b?.type !== 'tool_result' || typeof b?.tool_use_id !== 'string') continue;
      if (!state.pendingTicketTools.has(b.tool_use_id)) continue;
      state.pendingTicketTools.delete(b.tool_use_id);
      const text = typeof b.content === 'string'
        ? b.content
        : Array.isArray(b.content) ? b.content.map((c: any) => c?.text || '').join('\n') : '';
      const t = extractCreatedTicket(text);
      if (t) state.createdTickets.add(t);
    }
  }

  // PR signal, structurally: a Bash tool_use whose command is `gh pr create`
  // marks intent; the pull URL is then read from a tool_result's output.
  if (!state.prUrl) {
    if (!state.sawPrCreate && parsed.type === 'assistant' && Array.isArray(parsed.message?.content)) {
      for (const b of parsed.message.content) {
        if (b?.type === 'tool_use' && typeof b?.input?.command === 'string' && isPrCreateCommand(b.input.command)) {
          state.sawPrCreate = true;
        }
      }
    }
    if (state.sawPrCreate && parsed.type === 'user' && Array.isArray(parsed.message?.content)) {
      for (const b of parsed.message.content) {
        if (b?.type !== 'tool_result') continue;
        const text = typeof b.content === 'string'
          ? b.content
          : Array.isArray(b.content) ? b.content.map((c: any) => c?.text || '').join('\n') : '';
        const pr = extractPrUrl(text);
        if (pr) { state.prUrl = pr.url; state.prNumber = pr.number; }
      }
    }
  }

  // Track duration across every timestamped event, not just the first.
  if (typeof parsed.timestamp === 'string') {
    const ms = new Date(parsed.timestamp).getTime();
    if (!Number.isNaN(ms)) {
      if (state.firstTsMs === undefined || ms < state.firstTsMs) state.firstTsMs = ms;
      if (state.lastTsMs === undefined || ms > state.lastTsMs) state.lastTsMs = ms;
    }
  }

  if (!state.timestamp && (parsed.type === 'user' || parsed.type === 'assistant') && parsed.timestamp) {
    state.timestamp = parsed.timestamp;
    state.cwd = parsed.cwd || '';
    state.gitBranch = parsed.gitBranch || undefined;
    state.version = parsed.version || undefined;
  }

  if (parsed.type === 'custom-title') {
    const t = typeof parsed.customTitle === 'string' ? parsed.customTitle.trim() : '';
    if (t) state.customTitle = t;
    return;
  }
  if (parsed.type === 'ai-title') {
    const t = typeof parsed.aiTitle === 'string' ? parsed.aiTitle.trim() : '';
    if (t) state.aiTitle = t;
    return;
  }

  if (parsed.type === 'user') {
    const text = extractClaudeUserText(parsed);
    if (text) {
      state.messageCount++;
      state.userTexts.push(text);
      if (!state.topic) state.topic = extractSessionTopic(text);
      // #12: the USER typing a slash command — Claude injects a <command-name>
      // wrapper as the message content (extractClaudeUserText returns it
      // un-stripped; isLocalCommandMessage only filters bash-echo wrappers).
      const slashCommand = extractSlashCommandName(text);
      if (slashCommand) {
        state.slashCommandEvents.push({
          type: 'message', agent: 'claude', timestamp: parsed.timestamp || '', role: 'user', content: text, slashCommand,
        });
      }
    }
    return;
  }

  if (parsed.type !== 'assistant') return;

  const assistantId = typeof parsed.message?.id === 'string'
    ? parsed.message.id
    : typeof parsed.uuid === 'string'
      ? parsed.uuid
      : undefined;

  const logicalId = assistantId || `${parsed.timestamp || ''}:${state.seenAssistantIds.size}`;
  if (state.seenAssistantIds.has(logicalId)) return;
  state.seenAssistantIds.add(logicalId);
  state.messageCount++;

  const usageObj = parsed.message?.usage || parsed.usage;
  const usage = getClaudeUsageTotal(usageObj);
  if (usage !== null) {
    state.tokenCount += usage;
    state.sawTokenCount = true;
  }
  if (typeof usageObj?.output_tokens === 'number') state.outputTokens += usageObj.output_tokens;
  // Burn split (RUSH-2287): accumulate the raw directional counts so `agents
  // output` can report uncached-input / cache-read / cache-write separately.
  if (usageObj && typeof usageObj === 'object') {
    if (typeof usageObj.input_tokens === 'number') state.inputTokens += usageObj.input_tokens;
    if (typeof usageObj.cache_read_input_tokens === 'number') state.cacheReadTokens += usageObj.cache_read_input_tokens;
    if (typeof usageObj.cache_creation_input_tokens === 'number') state.cacheWriteTokens += usageObj.cache_creation_input_tokens;
  }
  // Per-assistant-message cost: each event carries its own model, so we
  // multiply that event's raw token directions by that model's price.
  const model = parsed.message?.model;
  if (typeof model === 'string' && model) state.model = model;
  if (model && usageObj && typeof usageObj === 'object') {
    const usageForCost = {
      model,
      inputTokens: usageObj.input_tokens,
      outputTokens: usageObj.output_tokens,
      cacheReadTokens: usageObj.cache_read_input_tokens,
      cacheCreationTokens: usageObj.cache_creation_input_tokens,
    };
    const eventCost = costOfUsage(usageForCost);
    if (eventCost > 0) {
      state.costUsd += eventCost;
      // No-cache scenario: reprice this same event's cache tokens at the input rate.
      state.costUsdNoCache += costOfUsageNoCache(usageForCost);
      state.sawCost = true;
    }
  }
}

/**
 * Build the {@link ClaudeSessionScan} return object from an accumulator. This is
 * the exact return-building {@link scanClaudeSession} used to run inline.
 */
export function finalizeClaudeScan(state: ClaudeParseState): ClaudeSessionScan {
  const durationMs =
    state.firstTsMs !== undefined && state.lastTsMs !== undefined && state.lastTsMs > state.firstTsMs
      ? state.lastTsMs - state.firstTsMs
      : undefined;

  // A topic is the first meaningful prompt. Harness-owned names travel in the
  // separate label field so consumers can replace an early topic once Claude's
  // generated title (or a later `/rename`) arrives.
  const label = state.customTitle || state.aiTitle;
  const worktree = detectWorktree(state.cwd, state.gitBranch);
  const ticket = detectTicket(state.userTexts.join('\n') || undefined, state.gitBranch);

  return {
    timestamp: state.timestamp,
    cwd: state.cwd,
    gitBranch: state.gitBranch,
    version: state.version,
    model: state.model,
    topic: state.topic,
    label,
    entrypoint: state.entrypoint,
    messageCount: state.messageCount,
    toolCallCount: state.toolCallCount,
    tokenCount: state.sawTokenCount ? state.tokenCount : undefined,
    outputTokens: state.sawTokenCount ? state.outputTokens : undefined,
    inputTokens: state.sawTokenCount ? state.inputTokens : undefined,
    cacheReadTokens: state.sawTokenCount ? state.cacheReadTokens : undefined,
    cacheWriteTokens: state.sawTokenCount ? state.cacheWriteTokens : undefined,
    costUsd: state.sawCost ? state.costUsd : undefined,
    costUsdNoCache: state.sawCost ? state.costUsdNoCache : undefined,
    durationMs,
    lastActivity: state.lastTsMs !== undefined ? new Date(state.lastTsMs).toISOString() : undefined,
    contentText: state.userTexts.length > 0 ? state.userTexts.join('\n') : undefined,
    prUrl: state.prUrl,
    prNumber: state.prNumber,
    worktreeSlug: worktree?.slug,
    ticketId: ticket?.id,
    createdTickets: state.createdTickets.size > 0 ? [...state.createdTickets] : undefined,
    spawnedTeam: state.spawnedTeam,
    plan: state.plan,
    todos: extractTodoProgressFromEvents(state.checklistEvents),
    recentDirectoriesTouched: state.recentDirectoriesTouched.length ? state.recentDirectoriesTouched : undefined,
    skillsUsed: state.skillEvents.length ? extractSkills(state.skillEvents) : undefined,
    slashCommandsUsed: state.slashCommandEvents.length ? extractSlashCommands(state.slashCommandEvents) : undefined,
  };
}

/** Stream a Claude JSONL file and extract scan-level metadata (timestamp, cwd, topic, tokens). */
export async function scanClaudeSession(filePath: string): Promise<ClaudeSessionScan> {
  const stream = fs.createReadStream(filePath, { encoding: 'utf-8' });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

  const state = initClaudeParseState();

  try {
    for await (const line of rl) {
      if (!line.trim()) continue;

      let parsed: any;
      try {
        parsed = JSON.parse(line);
      } catch {
        continue;
      }

      applyClaudeLine(state, parsed);
    }
  } finally {
    rl.close();
    stream.destroy();
  }

  return finalizeClaudeScan(state);
}

/**
 * SERIALIZED continuation blob persisted in `scan_ledger.parser_state`. Carries
 * everything {@link hydrateClaudeParseState} needs to resume a parse from
 * `offset` such that resuming + applying the appended lines is byte-for-byte
 * identical to a full parse of the whole file.
 *
 * `seenAssistantIds` is persisted as a size counter plus a bounded FIFO window
 * of the most-recent ids: the fallback logical id `${ts}:${seenAssistantIds.size}`
 * (see {@link applyClaudeLine}) depends on the set's *size*, so the size must be
 * exact even when the recent window is smaller than the true count.
 */
export interface ClaudeParserState {
  // v3 (RUSH-2287): added the burn-split accumulators + no-cache cost. A stale v2
  // blob is rejected by the `!== 3` guard and the session is re-parsed from byte 0,
  // which populates the new split correctly rather than resuming without it.
  v: 3;
  offset: number;
  jsonlDroppingOversizedLine?: boolean;
  timestamp?: string;
  cwd?: string;
  gitBranch?: string;
  version?: string;
  model?: string;
  entrypoint?: string;
  firstTsMs?: number;
  topic?: string;
  customTitle?: string;
  aiTitle?: string;
  plan?: string;
  lastTsMs?: number;
  messageCount: number;
  toolCallCount: number;
  tokenCount: number;
  outputTokens: number;
  inputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  sawTokenCount: boolean;
  sawCost: boolean;
  costUsd: number;
  costUsdNoCache: number;
  seenIdsSize: number;
  seenIdsRecent: string[];
  sawPrCreate: boolean;
  prUrl?: string;
  prNumber?: number;
  pendingTicketTools: string[];
  createdTickets: string[];
  spawnedTeam?: string;
  ticketId?: string;
  contentText?: string;
  checklistEvents: SessionEvent[];
  recentDirectoriesTouched: string[];
  toolCalls: ToolCallCollectorSnapshot;
  /** #12: see ClaudeParseState.skillEvents/slashCommandEvents. */
  skillEvents: SessionEvent[];
  slashCommandEvents: SessionEvent[];
}

/** Cap on the FIFO window of recent assistant ids persisted in the continuation. */
const SEEN_IDS_RECENT_CAP = 256;

/**
 * Snapshot a live {@link ClaudeParseState} into its serializable form at
 * `offset` bytes consumed. Round-trips through {@link hydrateClaudeParseState}
 * so incremental replay equals a full parse.
 */
export function serializeClaudeParserState(
  state: ClaudeParseState,
  offset: number,
  jsonlDroppingOversizedLine = false,
): ClaudeParserState {
  const allIds = [...state.seenAssistantIds];
  const seenIdsRecent = allIds.length > SEEN_IDS_RECENT_CAP
    ? allIds.slice(allIds.length - SEEN_IDS_RECENT_CAP)
    : allIds;
  const ticket = detectTicket(state.userTexts.join('\n') || undefined, state.gitBranch);
  return {
    v: 3,
    offset,
    jsonlDroppingOversizedLine: jsonlDroppingOversizedLine || undefined,
    timestamp: state.timestamp,
    cwd: state.cwd,
    gitBranch: state.gitBranch,
    version: state.version,
    model: state.model,
    entrypoint: state.entrypoint,
    firstTsMs: state.firstTsMs,
    topic: state.topic,
    customTitle: state.customTitle,
    aiTitle: state.aiTitle,
    plan: state.plan,
    lastTsMs: state.lastTsMs,
    messageCount: state.messageCount,
    toolCallCount: state.toolCallCount,
    tokenCount: state.tokenCount,
    outputTokens: state.outputTokens,
    inputTokens: state.inputTokens,
    cacheReadTokens: state.cacheReadTokens,
    cacheWriteTokens: state.cacheWriteTokens,
    sawTokenCount: state.sawTokenCount,
    sawCost: state.sawCost,
    costUsd: state.costUsd,
    costUsdNoCache: state.costUsdNoCache,
    seenIdsSize: state.seenAssistantIds.size,
    seenIdsRecent,
    sawPrCreate: state.sawPrCreate,
    prUrl: state.prUrl,
    prNumber: state.prNumber,
    pendingTicketTools: [...state.pendingTicketTools],
    createdTickets: [...state.createdTickets],
    spawnedTeam: state.spawnedTeam,
    // ticketId is derived at finalize time; persist it (and content_text) so a
    // consumer (B-2) can rebuild the row + FTS doc on append without re-reading
    // the whole file. worktreeSlug is re-derived from cwd/gitBranch, so it need
    // not be persisted.
    ticketId: ticket?.id,
    contentText: state.userTexts.length > 0 ? state.userTexts.join('\n') : undefined,
    checklistEvents: state.checklistEvents,
    recentDirectoriesTouched: state.recentDirectoriesTouched,
    toolCalls: state.toolCollector.snapshot(),
    skillEvents: state.skillEvents,
    slashCommandEvents: state.slashCommandEvents,
  };
}

/**
 * Rebuild a live {@link ClaudeParseState} from a persisted continuation so that
 * applying the appended lines yields the same accumulator a full parse would.
 *
 * `seenAssistantIds` is rehydrated from the recent-id FIFO window, then padded
 * with unique sentinel entries so its `.size` matches the true prior count
 * (`seenIdsSize`) — the fallback id `${ts}:${size}` must line up with the full
 * parse even when the window dropped older ids. Padding sentinels can never
 * collide with a real logical id (real ids are message ids/uuids or
 * `${ts}:${n}`; the sentinel prefix is not JSON-line-derived).
 *
 * `userTexts` is rehydrated as a single joined blob from `contentText`: only
 * `userTexts.join('\n')` (detectTicket + contentText) and `userTexts.length > 0`
 * are ever read downstream, and both are preserved by a one-element array
 * holding the joined content.
 */
export function hydrateClaudeParseState(prior: ClaudeParserState): ClaudeParseState {
  const seen = new Set<string>(prior.seenIdsRecent);
  // Pad to the true prior size so `seenAssistantIds.size` (which feeds the
  // fallback logical id) is exact even when older ids fell out of the window.
  let pad = 0;
  while (seen.size < prior.seenIdsSize) {
    seen.add(` pad:${pad++}`);
  }
  return {
    timestamp: prior.timestamp,
    cwd: prior.cwd,
    gitBranch: prior.gitBranch,
    version: prior.version,
    model: prior.model,
    topic: prior.topic,
    customTitle: prior.customTitle,
    aiTitle: prior.aiTitle,
    entrypoint: prior.entrypoint,
    messageCount: prior.messageCount,
    toolCallCount: prior.toolCallCount ?? 0,
    tokenCount: prior.tokenCount,
    outputTokens: prior.outputTokens,
    inputTokens: prior.inputTokens ?? 0,
    cacheReadTokens: prior.cacheReadTokens ?? 0,
    cacheWriteTokens: prior.cacheWriteTokens ?? 0,
    sawTokenCount: prior.sawTokenCount,
    costUsd: prior.costUsd,
    costUsdNoCache: prior.costUsdNoCache ?? 0,
    sawCost: prior.sawCost,
    firstTsMs: prior.firstTsMs,
    lastTsMs: prior.lastTsMs,
    seenAssistantIds: seen,
    userTexts: prior.contentText !== undefined && prior.contentText.length > 0 ? [prior.contentText] : [],
    sawPrCreate: prior.sawPrCreate,
    prUrl: prior.prUrl,
    prNumber: prior.prNumber,
    createdTickets: new Set<string>(prior.createdTickets),
    pendingTicketTools: new Set<string>(prior.pendingTicketTools),
    spawnedTeam: prior.spawnedTeam,
    plan: prior.plan,
    checklistEvents: prior.checklistEvents ?? [],
    recentDirectoriesTouched: prior.recentDirectoriesTouched ?? [],
    toolCollector: new ToolCallCollector(prior.toolCalls),
    skillEvents: prior.skillEvents ?? [],
    slashCommandEvents: prior.slashCommandEvents ?? [],
  };
}

/**
 * Resume a Claude parse from `fromOffset` bytes into the file, folding only the
 * newly-appended lines into `prior`. Returns the finalized scan, the next
 * serialized continuation, and the byte offset to resume from next time —
 * `newOffset` stops at the last `'\n'` seen so a half-written trailing record is
 * re-read (not lost) on the next append.
 *
 * NOT wired into the live scan path yet (that is B-2); {@link scanClaudeSession}
 * remains the only caller-facing entry point. This exists so the parity harness
 * can prove full === hydrate(state@k) + apply(k+1..n).
 */
export async function scanClaudeSessionIncremental(
  filePath: string,
  fromOffset: number,
  prior: ClaudeParserState,
): Promise<{ scan: ClaudeSessionScan; newState: ClaudeParserState; newOffset: number; toolCalls: IndexedToolCall[] }> {
  const state = hydrateClaudeParseState(prior);

  // Read the appended byte range and apply ONLY newline-terminated lines. The
  // applied lines and `newOffset` MUST stay consistent: readline (like the full
  // parse) would emit a trailing UNTERMINATED final line at EOF, but `newOffset`
  // stops before it — so the next pass, after that record's '\n' is flushed,
  // would re-read and re-apply the same line and double-count it (user events
  // have no dedup, unlike assistant `seenAssistantIds`). A record written
  // non-atomically — bytes first, then '\n' in a second write — is exactly this
  // case. So we slice at the last '\n' ourselves: everything up to and including
  // it is a run of complete lines we apply and commit. An ordinary tail after
  // it is deferred until its '\n' lands; after a tail exceeds 1 MiB, its offset
  // advances with a persisted discard-until-newline bit.
  const append = await applyJsonlAppend(
    filePath,
    fromOffset,
    prior.jsonlDroppingOversizedLine === true,
    (parsed) => applyClaudeLine(state, parsed),
  );
  if (append.skippedOversizedLine) state.toolCollector.recordIndexLimit();

  const newOffset = fromOffset + append.consumedBytes;
  const scan = finalizeClaudeScan(state);
  const toolCalls = state.toolCollector.drainChanged();
  return {
    scan,
    newState: serializeClaudeParserState(state, newOffset, append.droppingOversizedLine),
    newOffset,
    toolCalls,
  };
}

/** Serialized zero-value continuation: a fresh accumulator at offset 0, used to drive a FULL parse from the start through the same resumable path. */
function freshClaudeParserState(): ClaudeParserState {
  return serializeClaudeParserState(initClaudeParseState(), 0);
}

/**
 * Decide full-vs-incremental for one Claude file and parse it uniformly, always
 * returning a finalized scan plus the continuation to persist. Both branches run
 * through the SAME reducer (via {@link scanClaudeSessionIncremental}), so the row
 * an append produces is identical to a from-scratch full reparse by construction
 * (the B-1 parity harness proves this at the function level).
 *
 * INCREMENTAL when a prior continuation exists AND the file grew past the
 * persisted offset AND its mtime did not go backwards — an in-place append.
 * FULL (from byte 0, fresh state) otherwise: cold start (no prior), truncation /
 * rewrite (size shrank to at or below the offset), or a clock rewind / restore
 * (mtime older than the last parse). A FULL parse still produces a continuation,
 * so the file's very next append can go incremental.
 *
 * `mode` is returned so the caller (and tests) can confirm which branch ran.
 */
export async function scanClaudeSessionResumable(
  filePath: string,
  prior: ClaudeParserState | null,
  currentFileMtimeMs: number,
  currentFileSize: number,
  priorFileMtimeMs?: number,
): Promise<{ scan: ClaudeSessionScan; newState: ClaudeParserState; newOffset: number; toolCalls: IndexedToolCall[]; mode: 'full' | 'incremental' }> {
  // File size + mtime cannot distinguish an APPEND from an in-place rewrite or a
  // restore that dropped DIFFERENT, larger content at the same path: both grow
  // the file and move mtime forward. Resuming from the stored offset across that
  // boundary would fold the new file's bytes into an accumulator hydrated from
  // the OLD session, so the persisted row silently diverges from a full reparse.
  // So the metadata gate below only makes a file ELIGIBLE; before trusting the
  // offset we re-read the transcript's first user/assistant timestamp and require
  // it to still match the prior continuation's. An append keeps that identity
  // byte-for-byte; a rewrite/restore of a different session changes it. A
  // mismatch — or an identity we cannot derive — falls back to a FULL parse,
  // which is always correct. (A shrink is already handled: currentFileSize is not
  // > prior.offset, so it takes the FULL branch.)
  let canIncrement = false;
  if (
    prior !== null &&
    currentFileSize > prior.offset &&
    (priorFileMtimeMs === undefined || currentFileMtimeMs >= priorFileMtimeMs) &&
    prior.timestamp !== undefined
  ) {
    canIncrement = (await claudeSessionIdentityAt(filePath)) === prior.timestamp;
  }

  if (canIncrement && prior !== null) {
    const result = await scanClaudeSessionIncremental(filePath, prior.offset, prior);
    return { ...result, mode: 'incremental' };
  }

  const result = await scanClaudeSessionIncremental(filePath, 0, freshClaudeParserState());
  return { ...result, mode: 'full' };
}

/**
 * Cheaply derive a Claude transcript's session identity — the first
 * user/assistant event `timestamp` — by streaming only the START of the file
 * (at most `maxBytes`) and stopping at the first such event. Used by
 * {@link scanClaudeSessionResumable} to confirm a grown file is still the SAME
 * session before resuming from a stored parse offset. Returns undefined when no
 * user/assistant event appears within the budget, which forces a FULL parse.
 */
async function claudeSessionIdentityAt(filePath: string, maxBytes = 1_048_576): Promise<string | undefined> {
  const state = initClaudeParseState();
  const stream = fs.createReadStream(filePath, { start: 0, end: maxBytes - 1, encoding: 'utf-8' });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of rl) {
      if (!line.trim()) continue;
      let parsed: any;
      try {
        parsed = JSON.parse(line);
      } catch {
        continue;
      }
      applyClaudeLine(state, parsed);
      if (state.timestamp !== undefined) break;
    }
  } finally {
    rl.close();
    stream.destroy();
  }
  return state.timestamp;
}

/**
 * Parse the prior continuation blob for a changed file into a usable
 * {@link ClaudeParserState}, or null when there is none / it is unusable. A blob
 * from a different serialization version is treated as absent so the file falls
 * back to a clean FULL parse rather than resuming against a stale shape.
 */
function parsePriorClaudeState(row: { parserState: string | null } | undefined): ClaudeParserState | null {
  if (!row?.parserState) return null;
  try {
    const parsed = JSON.parse(row.parserState) as ClaudeParserState;
    if (parsed?.v !== 3 || typeof parsed.offset !== 'number' || parsed.toolCalls?.v !== 1) return null;
    return parsed;
  } catch {
    return null;
  }
}

/** Test seam: how many times the incremental (append-resume) branch was taken since the last reset. */
let claudeIncrementalScanCount = 0;
/** Test seam: how many times a full (from-offset-0) Claude parse ran since the last reset. */
let claudeFullScanCount = 0;

/** Test seam: read the (incremental, full) Claude parse counters. */
export function __claudeScanBranchCountsForTest(): { incremental: number; full: number } {
  return { incremental: claudeIncrementalScanCount, full: claudeFullScanCount };
}

/** Test seam: reset the Claude parse-branch counters to observe a scan from a clean slate. */
export function __resetClaudeScanBranchCountsForTest(): void {
  claudeIncrementalScanCount = 0;
  claudeFullScanCount = 0;
}

/**
 * Live (in-memory) accumulator for a Codex parse — the mutable state
 * {@link scanCodexSession} used to hold in local `let`s, extracted so the same
 * fold ({@link applyCodexLine}) runs for both a full parse and an incremental
 * resume. Mirrors {@link ClaudeParseState}.
 */
interface CodexParseState {
  // First-wins session_meta fields.
  sessionId?: string;
  timestamp?: string;
  cwd?: string;
  gitBranch?: string;
  version?: string;
  model?: string;
  topic?: string;
  // Additive across every counted message (user + assistant).
  messageCount: number;
  // LAST-WINS cumulative token snapshots: Codex's token_count events carry a
  // running total, so the final one wins (not a sum).
  tokenCount?: number;
  lastTotalTokenUsage?: any;
  // Duration bounds across every timestamped event.
  firstTsMs?: number;
  lastTsMs?: number;
  userTexts: string[];
  // Straddle state: a `gh pr create` function_call marks intent; the pull URL
  // arrives in a later function_call_output.
  sawPrCreate: boolean;
  prUrl?: string;
  prNumber?: number;
  // Ticket creation straddles a create_issue function_call and its output ref.
  createdTickets: Set<string>;
  pendingTicketTools: Set<string>;
  spawnedTeam?: string;
  checklistEvents: SessionEvent[];
  recentDirectoriesTouched: string[];
  toolCollector: ToolCallCollector;
  /** #12: see ClaudeParseState.skillEvents. Empty in practice today — no
   *  verified Codex skill-invocation tool name — but wired for parity so a
   *  future confirmed tool name (or a literal 'SlashCommand' function_call)
   *  is picked up with no further plumbing. */
  skillEvents: SessionEvent[];
  slashCommandEvents: SessionEvent[];
}

/** Zero-value accumulator for a fresh (from-byte-0) Codex parse. */
export function initCodexParseState(): CodexParseState {
  return {
    sessionId: undefined,
    timestamp: undefined,
    cwd: undefined,
    gitBranch: undefined,
    version: undefined,
    model: undefined,
    topic: undefined,
    messageCount: 0,
    tokenCount: undefined,
    lastTotalTokenUsage: undefined,
    firstTsMs: undefined,
    lastTsMs: undefined,
    userTexts: [],
    sawPrCreate: false,
    prUrl: undefined,
    prNumber: undefined,
    createdTickets: new Set<string>(),
    pendingTicketTools: new Set<string>(),
    spawnedTeam: undefined,
    checklistEvents: [],
    recentDirectoriesTouched: [],
    toolCollector: new ToolCallCollector(),
    skillEvents: [],
    slashCommandEvents: [],
  };
}

/**
 * Fold one parsed Codex line into the accumulator — the exact loop body
 * {@link scanCodexSession} used to run inline, extracted verbatim and mutating
 * `state.*` in place. `parsed` is the already-`JSON.parse`d line (the
 * malformed-line skip happens in the caller, as before).
 */
function applyCodexLine(state: CodexParseState, parsed: any): void {
  collectCodexToolCalls(state.toolCollector, parsed);
  // PR signal, structurally: a Codex `function_call` whose command is
  // `gh pr create`, then the pull URL from a `function_call_output`.
  if (parsed.type === 'response_item') {
    const p = parsed.payload || {};
    if (p.type === 'function_call') {
      let cmd = '';
      let args: Record<string, any> = {};
      try {
        args = typeof p.arguments === 'string' ? JSON.parse(p.arguments) : (p.arguments || {});
        cmd = String(args.command || args.cmd || '');
      } catch { /* non-JSON args */ }
      foldDerivedToolState(state, {
        type: 'tool_use', agent: 'codex', timestamp: parsed.timestamp || '', tool: p.name, args,
        path: args.file_path || args.path, command: cmd || undefined,
      });
      if (!state.prUrl && !state.sawPrCreate && isPrCreateCommand(cmd)) state.sawPrCreate = true;
      if (!state.spawnedTeam) {
        const team = detectSpawnedTeam(cmd);
        if (team) state.spawnedTeam = team;
      }
      if (typeof p.call_id === 'string' && isTicketCreateTool(p.name, cmd)) {
        state.pendingTicketTools.add(p.call_id);
      }
    }
    if (p.type === 'function_call_output') {
      if (!state.prUrl && state.sawPrCreate) {
        const pr = extractPrUrl(String(p.output || ''));
        if (pr) { state.prUrl = pr.url; state.prNumber = pr.number; }
      }
      if (typeof p.call_id === 'string' && state.pendingTicketTools.has(p.call_id)) {
        state.pendingTicketTools.delete(p.call_id);
        const t = extractCreatedTicket(String(p.output || ''));
        if (t) state.createdTickets.add(t);
      }
    }
  }

  // Track duration across every timestamped event.
  if (typeof parsed.timestamp === 'string') {
    const ms = new Date(parsed.timestamp).getTime();
    if (!Number.isNaN(ms)) {
      if (state.firstTsMs === undefined || ms < state.firstTsMs) state.firstTsMs = ms;
      if (state.lastTsMs === undefined || ms > state.lastTsMs) state.lastTsMs = ms;
    }
  }

  if (parsed.type === 'session_meta') {
    const payload = parsed.payload || {};
    state.sessionId = payload.id || state.sessionId;
    state.timestamp = payload.timestamp || parsed.timestamp || state.timestamp;
    state.cwd = payload.cwd || state.cwd;
    state.gitBranch = payload.git?.branch || state.gitBranch;
    state.version = payload.cli_version || payload.version || state.version;
    state.model = payload.model || state.model;
    return;
  }

  // Codex rollouts put per-turn metadata (including the model) on
  // `turn_context` events. Use them as a fallback when session_meta itself
  // does not carry the field, otherwise `agents sessions` shows blank model
  // info for Codex.
  if (parsed.type === 'turn_context') {
    const payload = parsed.payload || {};
    if (!state.model && typeof payload.model === 'string') state.model = payload.model;
    if (!state.cwd && typeof payload.cwd === 'string') state.cwd = payload.cwd;
    return;
  }

  if (parsed.type === 'response_item' && parsed.payload?.type === 'message') {
    const role = parsed.payload.role === 'user' || parsed.payload.role === 'developer'
      ? 'user'
      : 'assistant';
    const text = extractCodexMessageText(parsed.payload.content, role);
    if (!text) return;
    state.messageCount++;
    if (role === 'user') {
      state.userTexts.push(text);
      if (!state.topic) state.topic = extractSessionTopic(text);
    }
    return;
  }

  if (parsed.type === 'event_msg' && parsed.payload?.type === 'token_count') {
    const totalUsage = parsed.payload.info?.total_token_usage;
    const total = getCodexTokenCount(totalUsage);
    if (total !== null) state.tokenCount = total;
    // token_count is cumulative — keep the latest snapshot and price it once
    // after the stream, so we don't double-count across intermediate events.
    if (totalUsage && typeof totalUsage === 'object') state.lastTotalTokenUsage = totalUsage;
    // Codex also stamps the model on the rate_limits/token_count payload on
    // some versions; prefer session_meta but fall back to it.
    if (!state.model && typeof parsed.payload.info?.model === 'string') state.model = parsed.payload.info.model;
  }
}

/**
 * Build the {@link CodexSessionScan} return object from an accumulator — the
 * exact return-building {@link scanCodexSession} used to run inline.
 */
function finalizeCodexScan(state: CodexParseState): CodexSessionScan {
  // Codex reports one cumulative snapshot: uncached input, cached (cache-read)
  // input, and output+reasoning. It has no cache-write bucket. Derive the burn
  // split and both costs (actual + no-cache) from that final snapshot (RUSH-2287).
  const snap = state.lastTotalTokenUsage;
  const outputTokens = snap
    ? (snap.output_tokens ?? 0) + (snap.reasoning_output_tokens ?? 0)
    : undefined;
  let costUsd: number | undefined;
  let costUsdNoCache: number | undefined;
  let inputTokens: number | undefined;
  let cacheReadTokens: number | undefined;
  if (snap) {
    inputTokens = typeof snap.input_tokens === 'number' ? snap.input_tokens : undefined;
    cacheReadTokens = typeof snap.cached_input_tokens === 'number' ? snap.cached_input_tokens : undefined;
  }
  // Price the final cumulative token snapshot once, against the session model.
  if (state.model && snap) {
    const usage = {
      model: state.model,
      inputTokens: snap.input_tokens,
      outputTokens,
      cacheReadTokens: snap.cached_input_tokens,
    };
    const c = costOfUsage(usage);
    if (c > 0) {
      costUsd = c;
      costUsdNoCache = costOfUsageNoCache(usage);
    }
  }

  const durationMs =
    state.firstTsMs !== undefined && state.lastTsMs !== undefined && state.lastTsMs > state.firstTsMs
      ? state.lastTsMs - state.firstTsMs
      : undefined;

  const worktree = detectWorktree(state.cwd, state.gitBranch);
  const ticket = detectTicket(state.userTexts.join('\n') || undefined, state.gitBranch);

  return {
    sessionId: state.sessionId,
    timestamp: state.timestamp,
    cwd: state.cwd,
    gitBranch: state.gitBranch,
    version: state.version,
    model: state.model,
    topic: state.topic,
    messageCount: state.messageCount,
    tokenCount: state.tokenCount,
    outputTokens,
    inputTokens,
    cacheReadTokens,
    cacheWriteTokens: undefined,
    costUsd,
    costUsdNoCache,
    durationMs,
    lastActivity: state.lastTsMs !== undefined ? new Date(state.lastTsMs).toISOString() : undefined,
    contentText: state.userTexts.length > 0 ? state.userTexts.join('\n') : undefined,
    prUrl: state.prUrl,
    prNumber: state.prNumber,
    worktreeSlug: worktree?.slug,
    ticketId: ticket?.id,
    createdTickets: state.createdTickets.size > 0 ? [...state.createdTickets] : undefined,
    spawnedTeam: state.spawnedTeam,
    todos: extractTodoProgressFromEvents(state.checklistEvents),
    recentDirectoriesTouched: state.recentDirectoriesTouched.length ? state.recentDirectoriesTouched : undefined,
  };
}

/** Stream a Codex JSONL file and extract scan-level metadata (session ID, cwd, topic, tokens). */
async function scanCodexSession(filePath: string): Promise<CodexSessionScan> {
  const stream = fs.createReadStream(filePath, { encoding: 'utf-8' });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

  const state = initCodexParseState();

  try {
    for await (const line of rl) {
      if (!line.trim()) continue;

      let parsed: any;
      try {
        parsed = JSON.parse(line);
      } catch {
        continue;
      }

      applyCodexLine(state, parsed);
    }
  } finally {
    rl.close();
    stream.destroy();
  }

  return finalizeCodexScan(state);
}

/**
 * SERIALIZED continuation blob persisted in `scan_ledger.parser_state` for a
 * Codex rollout. Carries everything {@link hydrateCodexParseState} needs to
 * resume a parse from `offset` such that resuming + applying the appended lines
 * is byte-for-byte identical to a full parse of the whole file.
 *
 * Unlike Claude, Codex has NO per-message dedup set, so `messageCount` is a
 * plain additive base with no recent-id window to persist. The `lastTotalTokenUsage`
 * object is round-tripped whole so the last-wins cost/output-token pricing at
 * finalize is identical after a resume.
 */
export interface CodexParserState {
  v: 2;
  offset: number;
  jsonlDroppingOversizedLine?: boolean;
  sessionId?: string;
  timestamp?: string;
  cwd?: string;
  gitBranch?: string;
  version?: string;
  model?: string;
  topic?: string;
  messageCount: number;
  tokenCount?: number;
  lastTotalTokenUsage?: any;
  firstTsMs?: number;
  lastTsMs?: number;
  sawPrCreate: boolean;
  prUrl?: string;
  prNumber?: number;
  pendingTicketTools: string[];
  createdTickets: string[];
  spawnedTeam?: string;
  ticketId?: string;
  contentText?: string;
  checklistEvents: SessionEvent[];
  recentDirectoriesTouched: string[];
  toolCalls: ToolCallCollectorSnapshot;
}

/**
 * Snapshot a live {@link CodexParseState} into its serializable form at `offset`
 * bytes consumed. Round-trips through {@link hydrateCodexParseState} so
 * incremental replay equals a full parse.
 */
export function serializeCodexParserState(
  state: CodexParseState,
  offset: number,
  jsonlDroppingOversizedLine = false,
): CodexParserState {
  const ticket = detectTicket(state.userTexts.join('\n') || undefined, state.gitBranch);
  return {
    v: 2,
    offset,
    jsonlDroppingOversizedLine: jsonlDroppingOversizedLine || undefined,
    sessionId: state.sessionId,
    timestamp: state.timestamp,
    cwd: state.cwd,
    gitBranch: state.gitBranch,
    version: state.version,
    model: state.model,
    topic: state.topic,
    messageCount: state.messageCount,
    tokenCount: state.tokenCount,
    lastTotalTokenUsage: state.lastTotalTokenUsage,
    firstTsMs: state.firstTsMs,
    lastTsMs: state.lastTsMs,
    sawPrCreate: state.sawPrCreate,
    prUrl: state.prUrl,
    prNumber: state.prNumber,
    pendingTicketTools: [...state.pendingTicketTools],
    createdTickets: [...state.createdTickets],
    spawnedTeam: state.spawnedTeam,
    // ticketId is derived at finalize time; persist it (and content_text) so a
    // consumer can rebuild the row + FTS doc on append without re-reading the
    // whole file. worktreeSlug is re-derived from cwd/gitBranch, so it need not
    // be persisted.
    ticketId: ticket?.id,
    contentText: state.userTexts.length > 0 ? state.userTexts.join('\n') : undefined,
    checklistEvents: state.checklistEvents,
    recentDirectoriesTouched: state.recentDirectoriesTouched,
    toolCalls: state.toolCollector.snapshot(),
  };
}

/**
 * Rebuild a live {@link CodexParseState} from a persisted continuation so that
 * applying the appended lines yields the same accumulator a full parse would.
 *
 * `userTexts` is rehydrated as a single joined blob from `contentText`: only
 * `userTexts.join('\n')` (detectTicket + contentText) and `userTexts.length > 0`
 * are ever read downstream, and both are preserved by a one-element array
 * holding the joined content. Topic is first-wins and already persisted, so a
 * collapsed userTexts never changes it.
 */
function hydrateCodexParseState(prior: CodexParserState): CodexParseState {
  return {
    sessionId: prior.sessionId,
    timestamp: prior.timestamp,
    cwd: prior.cwd,
    gitBranch: prior.gitBranch,
    version: prior.version,
    model: prior.model,
    topic: prior.topic,
    messageCount: prior.messageCount,
    tokenCount: prior.tokenCount,
    lastTotalTokenUsage: prior.lastTotalTokenUsage,
    firstTsMs: prior.firstTsMs,
    lastTsMs: prior.lastTsMs,
    userTexts: prior.contentText !== undefined && prior.contentText.length > 0 ? [prior.contentText] : [],
    sawPrCreate: prior.sawPrCreate,
    prUrl: prior.prUrl,
    prNumber: prior.prNumber,
    createdTickets: new Set<string>(prior.createdTickets),
    pendingTicketTools: new Set<string>(prior.pendingTicketTools),
    spawnedTeam: prior.spawnedTeam,
    checklistEvents: prior.checklistEvents ?? [],
    recentDirectoriesTouched: prior.recentDirectoriesTouched ?? [],
    toolCollector: new ToolCallCollector(prior.toolCalls),
    // Not persisted in CodexParserState (always empty for Codex today — see
    // CodexParseState.skillEvents) — a resume starts fresh rather than
    // round-tripping an always-empty array through the continuation blob.
    skillEvents: [],
    slashCommandEvents: [],
  };
}

/**
 * Resume a Codex parse from `fromOffset` bytes into the file, folding only the
 * newly-appended lines into `prior`. Returns the finalized scan, the next
 * serialized continuation, and the byte offset to resume from next time.
 *
 * Same trailing-line discipline as {@link scanClaudeSessionIncremental}: apply
 * ONLY the run of newline-terminated lines (slice at the last `'\n'`), and set
 * `newOffset = fromOffset + consumedBytes`. An ordinary tail after the last
 * `'\n'` is deferred; an oversized one advances under a persisted discard bit.
 * Codex `messageCount` is additive with
 * NO dedup, so re-reading a still-unterminated complete line would double-count
 * it; deferring prevents that (the bug class prix-cloud caught for Claude).
 */
export async function scanCodexSessionIncremental(
  filePath: string,
  fromOffset: number,
  prior: CodexParserState,
): Promise<{ scan: CodexSessionScan; newState: CodexParserState; newOffset: number; toolCalls: IndexedToolCall[] }> {
  const state = hydrateCodexParseState(prior);

  const append = await applyJsonlAppend(
    filePath,
    fromOffset,
    prior.jsonlDroppingOversizedLine === true,
    (parsed) => applyCodexLine(state, parsed),
  );
  if (append.skippedOversizedLine) state.toolCollector.recordIndexLimit();

  const newOffset = fromOffset + append.consumedBytes;
  const scan = finalizeCodexScan(state);
  const toolCalls = state.toolCollector.drainChanged();
  return {
    scan,
    newState: serializeCodexParserState(state, newOffset, append.droppingOversizedLine),
    newOffset,
    toolCalls,
  };
}

/** Serialized zero-value continuation: a fresh accumulator at offset 0, used to drive a FULL parse from the start through the same resumable path. */
function freshCodexParserState(): CodexParserState {
  return serializeCodexParserState(initCodexParseState(), 0);
}

/**
 * Cheaply derive a Codex rollout's session identity — the `session_meta` id — by
 * streaming only the START of the file (at most `maxBytes`) and stopping once the
 * id is known. Mirrors {@link claudeSessionIdentityAt}: used by
 * {@link scanCodexSessionResumable} to confirm a grown file is still the SAME
 * session before resuming from a stored parse offset. Codex writes `session_meta`
 * (carrying the durable session UUID) on the first line of every rollout, so the
 * id is reached almost immediately. Returns undefined when no id appears within
 * the budget, which forces a FULL parse.
 */
async function codexSessionIdentityAt(filePath: string, maxBytes = 1_048_576): Promise<string | undefined> {
  const state = initCodexParseState();
  const stream = fs.createReadStream(filePath, { start: 0, end: maxBytes - 1, encoding: 'utf-8' });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of rl) {
      if (!line.trim()) continue;
      let parsed: any;
      try {
        parsed = JSON.parse(line);
      } catch {
        continue;
      }
      applyCodexLine(state, parsed);
      if (state.sessionId !== undefined) break;
    }
  } finally {
    rl.close();
    stream.destroy();
  }
  return state.sessionId;
}

/**
 * Decide full-vs-incremental for one Codex rollout and parse it uniformly,
 * always returning a finalized scan plus the continuation to persist. Both
 * branches run through the SAME reducer (via {@link scanCodexSessionIncremental}),
 * so an append produces a row identical to a from-scratch full reparse by
 * construction. INCREMENTAL when a prior continuation exists AND the file grew
 * past the persisted offset AND its mtime did not go backwards; FULL (from byte
 * 0, fresh state) otherwise (cold start, truncation/rewrite, clock rewind).
 */
export async function scanCodexSessionResumable(
  filePath: string,
  prior: CodexParserState | null,
  currentFileMtimeMs: number,
  currentFileSize: number,
  priorFileMtimeMs?: number,
): Promise<{ scan: CodexSessionScan; newState: CodexParserState; newOffset: number; toolCalls: IndexedToolCall[]; mode: 'full' | 'incremental' }> {
  // File size + mtime cannot distinguish an APPEND from an in-place rewrite or a
  // restore that dropped a DIFFERENT, larger rollout at the same path: both grow
  // the file and move mtime forward. Resuming from the stored offset across that
  // boundary would fold the new session's bytes into an accumulator hydrated from
  // the OLD session, so the persisted row silently diverges from a full reparse.
  // So the metadata gate below only makes a file ELIGIBLE; before trusting the
  // offset we re-read the rollout's `session_meta` id and require it to still
  // match the prior continuation's. An append keeps that id; a rewrite/restore of
  // a different session changes it. A mismatch — or an id we cannot derive —
  // falls back to a FULL parse, which is always correct. (A shrink is already
  // handled: currentFileSize is not > prior.offset, so it takes the FULL branch.)
  let canIncrement = false;
  if (
    prior !== null &&
    currentFileSize > prior.offset &&
    (priorFileMtimeMs === undefined || currentFileMtimeMs >= priorFileMtimeMs) &&
    prior.sessionId !== undefined
  ) {
    canIncrement = (await codexSessionIdentityAt(filePath)) === prior.sessionId;
  }

  if (canIncrement && prior !== null) {
    const result = await scanCodexSessionIncremental(filePath, prior.offset, prior);
    return { ...result, mode: 'incremental' };
  }

  const result = await scanCodexSessionIncremental(filePath, 0, freshCodexParserState());
  return { ...result, mode: 'full' };
}

/**
 * Parse the prior continuation blob for a changed Codex file into a usable
 * {@link CodexParserState}, or null when there is none / it is unusable. A blob
 * from a different serialization version is treated as absent so the file falls
 * back to a clean FULL parse rather than resuming against a stale shape.
 */
function parsePriorCodexState(row: { parserState: string | null } | undefined): CodexParserState | null {
  if (!row?.parserState) return null;
  try {
    const parsed = JSON.parse(row.parserState) as CodexParserState;
    if (parsed?.v !== 2 || typeof parsed.offset !== 'number' || parsed.toolCalls?.v !== 1) return null;
    return parsed;
  } catch {
    return null;
  }
}

/** Test seam: how many times the incremental (append-resume) branch was taken since the last reset. */
let codexIncrementalScanCount = 0;
/** Test seam: how many times a full (from-offset-0) Codex parse ran since the last reset. */
let codexFullScanCount = 0;

/** Test seam: read the (incremental, full) Codex parse counters. */
export function __codexScanBranchCountsForTest(): { incremental: number; full: number } {
  return { incremental: codexIncrementalScanCount, full: codexFullScanCount };
}

/** Test seam: reset the Codex parse-branch counters to observe a scan from a clean slate. */
export function __resetCodexScanBranchCountsForTest(): void {
  codexIncrementalScanCount = 0;
  codexFullScanCount = 0;
}

/** Resolve the working directory for an OpenClaw agent from its workspace config. */
function getOpenClawSessionCwd(agentId?: string): string {
  const workspace = agentId ? getOpenClawWorkspaceMap().get(agentId) : undefined;
  if (workspace) return workspace;

  const configDir = AGENTS.openclaw.configDir;
  return safeRealpathSync(configDir) || configDir;
}

/** Build a cached map of OpenClaw agent ID to workspace path from openclaw.json. */
function getOpenClawWorkspaceMap(): Map<string, string> {
  if (cachedOpenClawWorkspaces) return cachedOpenClawWorkspaces;

  const workspaces = new Map<string, string>();
  const configPath = path.join(AGENTS.openclaw.configDir, 'openclaw.json');
  if (!fs.existsSync(configPath)) {
    cachedOpenClawWorkspaces = workspaces;
    return workspaces;
  }

  try {
    const config = JSON.parse(fs.readFileSync(configPath, 'utf-8')) as {
      agents?: { list?: Array<{ id?: string; workspace?: string }> };
    };

    for (const agent of config.agents?.list || []) {
      if (!agent.id || !agent.workspace) continue;
      workspaces.set(agent.id, safeRealpathSync(agent.workspace) || agent.workspace);
    }
  } catch {
    // Ignore invalid OpenClaw config and fall back to ~/.openclaw.
  }

  cachedOpenClawWorkspaces = workspaces;
  return workspaces;
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

/** Compute the SHA-256 hex digest of a string. */
function sha256(input: string): string {
  return crypto.createHash('sha256').update(input).digest('hex');
}

/** Stat a path, returning null on any error. */
function safeStatSync(p: string): fs.Stats | null {
  try {
    return fs.statSync(p);
  } catch {
    return null;
  }
}

/** Resolve a path to its real path, returning null on any error. */
function safeRealpathSync(p: string): string | null {
  try {
    return fs.realpathSync(p);
  } catch {
    return null;
  }
}

/** Extract meaningful user text from a Claude JSONL user event, skipping meta and local-command messages. */
function extractClaudeUserText(parsed: any): string | undefined {
  if (parsed.isMeta === true) return undefined;

  const content = parsed.message?.content;
  if (typeof content === 'string') {
    const text = content.trim();
    return isLocalCommandMessage(text) ? undefined : text || undefined;
  }

  if (!Array.isArray(content)) return undefined;

  const text = content
    .filter((block: any) => block.type === 'text')
    .map((block: any) => String(block.text || '').trim())
    .find((value: string) => value && !value.startsWith('[Request interrupted'));

  if (!text || isLocalCommandMessage(text)) return undefined;
  return text;
}

/** Check whether a message is a local-command wrapper rather than real user input. */
function isLocalCommandMessage(text: string): boolean {
  return /<local-command-caveat>|<bash-(input|stdout|stderr)>/i.test(text);
}

/** Sum all token usage fields from a Claude assistant message's usage object. */
function getClaudeUsageTotal(usage: any): number | null {
  if (!usage || typeof usage !== 'object') return null;
  return sumKnownNumbers([
    usage.input_tokens,
    usage.output_tokens,
    usage.cache_creation_input_tokens,
    usage.cache_read_input_tokens,
  ]);
}

/** Extract text from Codex message content blocks, filtering out system instructions for user messages. */
function extractCodexMessageText(contentBlocks: any, role: 'user' | 'assistant'): string | undefined {
  if (!Array.isArray(contentBlocks)) return undefined;

  const matches = role === 'user'
    ? contentBlocks.filter((block: any) => block.type === 'input_text')
    : contentBlocks.filter((block: any) => block.type === 'output_text');

  const text = matches
    .map((block: any) => String(block.text || '').trim())
    .find((value: string) => {
      if (!value) return false;
      if (role === 'user' && (value.length >= 2000 || value.includes('<permissions instructions>') || value.startsWith('# AGENTS.md instructions'))) {
        return false;
      }
      return true;
    });

  return text || undefined;
}

/** Trim and normalize a version string, returning undefined for empty values. */
function normalizeVersion(version?: string | null): string | undefined {
  const trimmed = version?.trim();
  return trimmed ? trimmed : undefined;
}

/** Extract the version number from a managed versions/<agent>/<version>/... path under either repo. */
function extractVersionFromManagedPath(agent: SessionAgentId, sourcePath?: string): string | undefined {
  if (!sourcePath) return undefined;

  const candidates = [sourcePath, safeRealpathSync(sourcePath) || ''];
  const markers = [`/.agents/versions/${agent}/`, `/.agents-system/versions/${agent}/`];

  for (const candidate of candidates) {
    if (!candidate) continue;
    const normalized = candidate.split(path.sep).join('/');
    for (const marker of markers) {
      const start = normalized.indexOf(marker);
      if (start === -1) continue;
      const version = normalized.slice(start + marker.length).split('/')[0];
      if (version) return version;
    }
  }

  return undefined;
}

/** Resolve the current version of an agent CLI (symlink version or live CLI output, cached). */
async function getCurrentAgentVersion(agent: SessionAgentId): Promise<string | undefined> {
  const cached = cachedAgentVersions.get(agent);
  if (cached) return cached;

  const promise = (async () => {
    const symlinkVersion = normalizeVersion(getConfigSymlinkVersion(agent as AgentId));
    if (symlinkVersion) return symlinkVersion;
    return normalizeVersion(await getCliVersion(agent as AgentId));
  })();

  cachedAgentVersions.set(agent, promise);
  return promise;
}

/** Resolve a session's version: embedded in file > extracted from managed path > current CLI version. */
function resolveSessionVersion(
  agent: SessionAgentId,
  sourcePath: string | undefined,
  embeddedVersion?: string,
  currentVersion?: string,
): string | undefined {
  return normalizeVersion(embeddedVersion)
    || extractVersionFromManagedPath(agent, sourcePath)
    || normalizeVersion(currentVersion);
}

/** Sum all token usage fields from a Codex total_token_usage object. */
function getCodexTokenCount(totalTokenUsage: any): number | null {
  if (!totalTokenUsage || typeof totalTokenUsage !== 'object') return null;
  return sumKnownNumbers([
    totalTokenUsage.input_tokens,
    totalTokenUsage.cached_input_tokens,
    totalTokenUsage.output_tokens,
    totalTokenUsage.reasoning_output_tokens,
  ]);
}

/** Extract text from a Gemini message content field (string or array of parts). */
function extractGeminiMessageText(content: any): string {
  if (typeof content === 'string') return content.trim();
  if (Array.isArray(content)) {
    return content
      .map((part: any) => {
        if (typeof part === 'string') return part;
        if (typeof part?.text === 'string') return part.text;
        return '';
      })
      .join('\n')
      .trim();
  }
  return '';
}

/** Extract the total token count from a Gemini message's tokens object. */
function getGeminiTokenCount(tokens: any): number | null {
  if (!tokens || typeof tokens !== 'object') return null;
  if (typeof tokens.total === 'number') return tokens.total;
  return sumKnownNumbers([
    tokens.input,
    tokens.output,
    tokens.cached,
    tokens.thoughts,
    tokens.tool,
  ]);
}

/** Sum all numeric values in an array, returning null if none are valid numbers. */
function sumKnownNumbers(values: unknown[]): number | null {
  let total = 0;
  let found = false;

  for (const value of values) {
    if (typeof value !== 'number' || Number.isNaN(value)) continue;
    total += value;
    found = true;
  }

  return found ? total : null;
}

// ---------------------------------------------------------------------------
// Time range parsing
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Cursor
// ---------------------------------------------------------------------------
// Cursor writes the conversation to
// projects/<encoded-cwd>/agent-transcripts/<uuid>/<uuid>.jsonl and metadata to
// chats/<workspace-hash>/<uuid>/meta.json. Discovery deliberately starts from
// transcripts, then joins metadata by UUID: chat directories with no transcript
// are empty or abandoned sessions and must not become broken zero-event rows.
// Routine archives may contain only the transcript; those remain browsable with
// file timestamps and without guessed cwd/title metadata.

/** Incrementally re-scan changed Cursor transcript files and upsert into the DB. */
async function scanCursorIncremental(onProgress?: (p: ScanProgress) => void): Promise<void> {
  const currentVersion = await getCurrentAgentVersion('cursor');
  const prestat: PreStatEntry[] = [];

  for (const projectsDir of getAgentSessionDirs('cursor', 'projects')) {
    collectCursorTranscripts(projectsDir, prestat);
  }

  const changed = filterChangedEntries(prestat);
  if (changed.length === 0) return;

  onProgress?.({ agent: 'cursor', parsed: 0, total: changed.length });

  const entries: ScanEntry[] = [];
  const touched: Array<{ filePath: string; scan: ScanStamp }> = [];
  const seen = new Set<string>();
  let parsed = 0;
  for (const { filePath, scan } of changed) {
    try {
      const result = readCursorMeta(filePath, currentVersion);
      if (result && !seen.has(result.meta.id)) {
        seen.add(result.meta.id);
        entries.push({ meta: result.meta, content: result.content, scan, events: result.events });
      } else {
        touched.push({ filePath, scan });
      }
    } catch {
      touched.push({ filePath, scan });
    }
    parsed++;
    onProgress?.({ agent: 'cursor', parsed, total: changed.length });
  }

  upsertSessionsBatch(entries);
  recordScans(touched);
}

function collectCursorTranscripts(projectsDir: string, out: PreStatEntry[]): void {
  let projectNames: string[];
  try {
    projectNames = fs.readdirSync(projectsDir);
  } catch {
    return;
  }

  for (const projectName of projectNames) {
    const transcriptsDir = path.join(projectsDir, projectName, 'agent-transcripts');
    for (const f of walkForFilesWithStat(transcriptsDir, '.jsonl', 100_000)) {
      const sessionId = path.basename(path.dirname(f.path));
      if (path.basename(f.path) !== `${sessionId}.jsonl`) continue;
      out.push({ filePath: f.path, fileMtimeMs: f.mtimeMs, fileSize: f.size });
    }
  }
}

function readCursorChatMeta(filePath: string, sessionId: string): any | undefined {
  const projectDir = path.dirname(path.dirname(path.dirname(filePath)));
  const projectsDir = path.dirname(projectDir);
  const chatsDir = path.join(path.dirname(projectsDir), 'chats');
  let workspaceHashes: string[];
  try {
    workspaceHashes = fs.readdirSync(chatsDir);
  } catch {
    return undefined;
  }

  for (const workspaceHash of workspaceHashes) {
    const metaPath = path.join(chatsDir, workspaceHash, sessionId, 'meta.json');
    try {
      return JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
    } catch {
      // This workspace hash does not own the session, or its metadata is unreadable.
    }
  }
  return undefined;
}

/** Parse one Cursor transcript and enrich it with the matching chat meta.json. */
export function readCursorMeta(
  filePath: string,
  currentVersion?: string,
): { meta: SessionMeta; content: string; events: SessionEvent[] } | null {
  const sessionId = path.basename(filePath).replace(/\.jsonl$/, '');
  if (!sessionId || path.basename(path.dirname(filePath)) !== sessionId) return null;

  const events = parseCursor(filePath);
  if (events.length === 0) return null;

  const chatMeta = readCursorChatMeta(filePath, sessionId);
  const stat = safeStatSync(filePath);
  const createdAtMs = typeof chatMeta?.createdAtMs === 'number' ? chatMeta.createdAtMs : undefined;
  const updatedAtMs = typeof chatMeta?.updatedAtMs === 'number' ? chatMeta.updatedAtMs : undefined;
  const timestamp = createdAtMs !== undefined
    ? new Date(createdAtMs).toISOString()
    : stat ? stat.mtime.toISOString() : new Date().toISOString();
  const lastActivity = updatedAtMs !== undefined
    ? new Date(updatedAtMs).toISOString()
    : stat ? stat.mtime.toISOString() : timestamp;
  const cwd = normalizeCwd(typeof chatMeta?.cwd === 'string' ? chatMeta.cwd : '');
  const userTexts = events
    .filter((event) => event.type === 'message' && event.role === 'user' && event.content)
    .map((event) => event.content!);
  const firstUserText = userTexts[0];
  const title = typeof chatMeta?.title === 'string' && chatMeta.title.trim()
    ? chatMeta.title.trim()
    : undefined;

  const meta: SessionMeta = {
    id: sessionId,
    shortId: deriveShortId(sessionId),
    agent: 'cursor',
    timestamp,
    lastActivity,
    project: cwd ? path.basename(cwd) : undefined,
    cwd,
    filePath,
    version: resolveSessionVersion('cursor', filePath, undefined, currentVersion),
    topic: firstUserText ? extractSessionTopic(firstUserText) : undefined,
    label: title,
    messageCount: events.filter((event) => event.type === 'message').length,
    todos: extractTodoProgressFromEvents(events),
  };

  return { meta, content: userTexts.join('\n'), events };
}

// ---------------------------------------------------------------------------
// Kimi
// ---------------------------------------------------------------------------
// Kimi stores sessions under ~/.kimi-code/sessions/<workdir_hash>/session_<uuid>/.
// Each session has state.json (metadata) and agents/main/wire.jsonl (conversation).
// A session_index.jsonl at ~/.kimi-code/ maps session IDs to directories.

/** Incrementally re-scan changed Kimi session state.json files and upsert into the DB. */
async function scanKimiIncremental(onProgress?: (p: ScanProgress) => void): Promise<void> {
  const filePaths: string[] = [];
  for (const sessionsDir of getAgentSessionDirs('kimi', 'sessions')) {
    if (!fs.existsSync(sessionsDir)) continue;
    let workDirNames: string[];
    try {
      workDirNames = fs.readdirSync(sessionsDir);
    } catch {
      continue;
    }
    for (const workDirName of workDirNames) {
      const workDir = path.join(sessionsDir, workDirName);
      const stat = safeStatSync(workDir);
      if (!stat?.isDirectory()) continue;
      let sessionNames: string[];
      try {
        sessionNames = fs.readdirSync(workDir);
      } catch {
        continue;
      }
      for (const sessionName of sessionNames) {
        if (!sessionName.startsWith('session_')) continue;
        const statePath = path.join(workDir, sessionName, 'state.json');
        if (!fs.existsSync(statePath)) continue;
        filePaths.push(statePath);
      }
    }
  }

  const changed = filterChangedFiles(filePaths);
  if (changed.length === 0) return;

  onProgress?.({ agent: 'kimi', parsed: 0, total: changed.length });

  // Bulk-fetch each changed session's prior wire-parse continuation (offset +
  // counter bases). A session whose wire.jsonl grew resumes from the offset;
  // everything else (cold start, truncation) full-parses from byte 0.
  const priorStates = getParserStatesForPaths(changed.map(c => c.filePath));

  const scanEntries: ScanEntry[] = [];
  const touched: Array<{ filePath: string; scan: ScanStamp }> = [];
  const seen = new Set<string>();
  let parsed = 0;
  for (const { filePath, scan } of changed) {
    try {
      const result = readKimiMeta(filePath, priorStates.get(filePath));
      if (result && !seen.has(result.meta.id)) {
        seen.add(result.meta.id);
        scanEntries.push({ meta: result.meta, content: result.content, scan, parserState: result.parserState });
      } else {
        touched.push({ filePath, scan });
      }
    } catch {
      touched.push({ filePath, scan });
    }
    parsed++;
    onProgress?.({ agent: 'kimi', parsed, total: changed.length });
  }

  upsertSessionsBatch(scanEntries);
  recordScans(touched);
}

/** Parse a single Kimi session state.json file to extract session metadata. */
export function readKimiMeta(
  filePath: string,
  priorRow?: { parserState: string | null },
): { meta: SessionMeta; content: string; parserState?: string } | null {
  let state: any;
  try {
    state = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch {
    return null;
  }

  const sessionDir = path.dirname(filePath);
  const sessionId = path.basename(sessionDir);
  if (!sessionId.startsWith('session_')) return null;

  const title = typeof state.title === 'string' ? state.title : undefined;
  const lastPrompt = typeof state.lastPrompt === 'string' ? state.lastPrompt : undefined;
  const topic = title || lastPrompt || undefined;

  const createdAt = typeof state.createdAt === 'string' ? state.createdAt : undefined;
  const updatedAt = typeof state.updatedAt === 'string' ? state.updatedAt : undefined;
  // Coerce to never-null, the same way every other parser does (Rush/Hermes/Droid/…):
  // a real createdAt/updatedAt still wins; otherwise fall back to the state.json mtime.
  // Kimi was the lone parser that could yield `undefined`, which binds NULL into
  // `timestamp TEXT NOT NULL` and aborts the whole batch index. mtime also matches how
  // the listing already ranks Kimi (last_activity resolves to the file mtime).
  const stat = safeStatSync(filePath);
  const timestamp = updatedAt || createdAt
    || (stat ? stat.mtime.toISOString() : new Date().toISOString());

  const shortId = deriveShortId(sessionId, /^session_/);

  // Try to infer project from session directory path
  // ~/.kimi-code/sessions/<workdir_hash>/session_<uuid>/
  const workDirName = path.basename(path.dirname(sessionDir));
  let project: string | undefined;
  if (workDirName.startsWith('wd_')) {
    const parts = workDirName.slice(3).split('_');
    if (parts.length >= 2) {
      project = parts.slice(0, -1).join('/');
    }
  }

  // Parse wire.jsonl incrementally: resume from the persisted offset + counter
  // bases when the wire grew, else full-parse from byte 0. The continuation is
  // persisted on this session's state.json ledger row.
  const prior = parsePriorKimiState(priorRow);
  const { messageCount, tokenCount, outputTokens, newState } = parseKimiWireMetricsIncremental(sessionDir, prior);

  const meta: SessionMeta = {
    id: sessionId,
    shortId,
    agent: 'kimi',
    timestamp,
    project,
    filePath,
    topic,
    messageCount,
    tokenCount: tokenCount > 0 ? tokenCount : undefined,
    outputTokens: outputTokens > 0 ? outputTokens : undefined,
  };

  return { meta, content: lastPrompt || '', parserState: JSON.stringify(newState) };
}

/**
 * Kimi wire metrics are pure additive counters (messageCount, tokenCount,
 * outputTokens) with NO straddle/dedup state, so the continuation is just those
 * three bases plus the byte `offset` already consumed from wire.jsonl. Resuming
 * from `offset` + adding the appended tail's deltas equals a full parse.
 */
export interface KimiParserState {
  v: 1;
  offset: number;
  messageCount: number;
  tokenCount: number;
  outputTokens: number;
}

/** Fold one parsed Kimi wire event into the additive counters, in place. */
function applyKimiWireEvent(
  acc: { messageCount: number; tokenCount: number; outputTokens: number },
  event: any,
): void {
  if (event.type === 'context.append_message') {
    acc.messageCount++;
  } else if (event.type === 'usage.record' && event.usage) {
    // Kimi usage structure: inputOther + output + inputCacheRead + inputCacheCreation
    const u = event.usage;
    acc.tokenCount += (u.inputOther || 0) + (u.output || 0) + (u.inputCacheRead || 0) + (u.inputCacheCreation || 0);
    acc.outputTokens += (u.output || 0);
  }
}

/**
 * Incrementally parse Kimi's wire.jsonl for message-count and token counters,
 * resuming from a persisted continuation instead of re-reading from byte 0 every
 * scan. Returns the finalized counters and the next {@link KimiParserState} to
 * persist (offset + the three counter bases).
 *
 * Same trailing-line discipline as {@link scanClaudeSessionIncremental}: read
 * only the appended byte range from `prior.offset`, apply ONLY the run of
 * newline-terminated lines (slice at the last `'\n'`), and advance the offset to
 * `prior.offset + consumedBytes`. A complete-but-not-yet-terminated last record
 * is DEFERRED to the next pass; because these counters are additive with no
 * dedup, re-reading such a line would double-count it. FULL parse from byte 0
 * (fresh counters) when there is no prior OR the file shrank below the stored
 * offset (truncation/rewrite).
 */
export function parseKimiWireMetricsIncremental(
  sessionDir: string,
  prior: KimiParserState | null,
): { messageCount: number; tokenCount: number; outputTokens: number; newState: KimiParserState } {
  const wirePath = path.join(sessionDir, 'agents', 'main', 'wire.jsonl');

  const stat = safeStatSync(wirePath);
  if (!stat) {
    // No wire.jsonl (yet): zero counters, offset 0 so a later append is a clean
    // full parse.
    return { messageCount: 0, tokenCount: 0, outputTokens: 0, newState: { v: 1, offset: 0, messageCount: 0, tokenCount: 0, outputTokens: 0 } };
  }

  // INCREMENTAL only when a usable prior exists AND the file grew past its
  // offset; otherwise FULL from byte 0 with fresh counters (cold start OR the
  // file shrank to/below the offset — a truncation/rewrite).
  //
  // No session-identity re-check is needed here (unlike Claude's
  // claudeSessionIdentityAt / Codex's codexSessionIdentityAt, which guard against
  // an in-place rewrite dropping a DIFFERENT session at the same path). A Kimi
  // wire.jsonl is uniquely keyed by its session dir — `.../session_<uuid>/agents/
  // main/wire.jsonl` (see readKimiMeta: sessionId is `session_<uuid>` and must
  // start with `session_`) — and Kimi only ever APPENDS to that per-session log.
  // The path therefore cannot host a different session's transcript, so a
  // size-grew wire.jsonl is always the same session's append. (A truncation/
  // rewrite — the only way its bytes could diverge — already shrinks it to/below
  // the offset and takes the FULL branch above.)
  const canIncrement = prior !== null && stat.size > prior.offset;
  const fromOffset = canIncrement ? prior!.offset : 0;
  const acc = canIncrement
    ? { messageCount: prior!.messageCount, tokenCount: prior!.tokenCount, outputTokens: prior!.outputTokens }
    : { messageCount: 0, tokenCount: 0, outputTokens: 0 };

  let consumedBytes = 0;
  let fd: number | undefined;
  try {
    // Read ONLY the appended byte range [fromOffset, stat.size) — not the whole
    // file. readSync from an explicit position keeps this function synchronous
    // (its callers are sync) while making the disk read + allocation scale with
    // the appended delta, not total file size, matching scanCodexSessionIncremental
    // / scanClaudeSessionIncremental. Bytes past the stat'd size are a concurrent
    // append and are deferred to the next scan.
    const bytesToRead = Math.max(0, stat.size - fromOffset);
    const appended = Buffer.allocUnsafe(bytesToRead);
    if (bytesToRead > 0) {
      fd = fs.openSync(wirePath, 'r');
      let read = 0;
      while (read < bytesToRead) {
        const n = fs.readSync(fd, appended, read, bytesToRead - read, fromOffset + read);
        if (n <= 0) break;
        read += n;
      }
      const chunk = read === bytesToRead ? appended : appended.subarray(0, read);
      // Bytes up to AND INCLUDING the last '\n' are the committed, complete-line run.
      const lastNl = chunk.lastIndexOf(0x0a);
      consumedBytes = lastNl === -1 ? 0 : lastNl + 1;
      if (consumedBytes > 0) {
        for (const line of chunk.subarray(0, consumedBytes).toString('utf-8').split('\n')) {
          if (!line.trim()) continue;
          try {
            applyKimiWireEvent(acc, JSON.parse(line));
          } catch {
            // Malformed line, skip
          }
        }
      }
    }
  } catch {
    // If wire.jsonl can't be read, keep the accumulated counters (0s on a cold
    // parse) — graceful degradation, matching the pre-incremental behavior.
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch { /* already closed / gone */ }
    }
  }

  return {
    messageCount: acc.messageCount,
    tokenCount: acc.tokenCount,
    outputTokens: acc.outputTokens,
    newState: { v: 1, offset: fromOffset + consumedBytes, messageCount: acc.messageCount, tokenCount: acc.tokenCount, outputTokens: acc.outputTokens },
  };
}

/**
 * Parse the prior continuation blob for a changed Kimi session into a usable
 * {@link KimiParserState}, or null when there is none / it is unusable. A blob
 * from a different serialization version is treated as absent so the wire parse
 * falls back to a clean FULL parse rather than resuming against a stale shape.
 */
function parsePriorKimiState(row: { parserState: string | null } | undefined): KimiParserState | null {
  if (!row?.parserState) return null;
  try {
    const parsed = JSON.parse(row.parserState) as KimiParserState;
    if (parsed?.v !== 1 || typeof parsed.offset !== 'number') return null;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Scan Grok sessions. Grok stores one directory per session under
 * ~/.grok/sessions/<url-encoded-cwd>/<uuid>/, each holding a summary.json with
 * structured metadata (id, cwd, title, timestamps, message count). Same
 * dir-per-session (L3) shape as Kimi, so it walks two levels and gates the
 * summary.json read through the scan ledger. Before this, Grok had a type slot
 * and a placeholder parser but no scanner, so `agents sessions` never indexed it.
 */
async function scanGrokIncremental(onProgress?: (p: ScanProgress) => void): Promise<void> {
  const currentVersion = await getCurrentAgentVersion('grok');

  const filePaths: string[] = [];
  for (const sessionsDir of getAgentSessionDirs('grok', 'sessions')) {
    if (!fs.existsSync(sessionsDir)) continue;
    let cwdDirNames: string[];
    try {
      cwdDirNames = fs.readdirSync(sessionsDir);
    } catch {
      continue;
    }
    for (const cwdDirName of cwdDirNames) {
      const cwdDir = path.join(sessionsDir, cwdDirName);
      const stat = safeStatSync(cwdDir);
      if (!stat?.isDirectory()) continue;
      let sessionNames: string[];
      try {
        sessionNames = fs.readdirSync(cwdDir);
      } catch {
        continue;
      }
      for (const sessionName of sessionNames) {
        const summaryPath = path.join(cwdDir, sessionName, 'summary.json');
        if (!fs.existsSync(summaryPath)) continue;
        filePaths.push(summaryPath);
      }
    }
  }

  const changed = filterChangedFiles(filePaths);
  if (changed.length === 0) return;

  onProgress?.({ agent: 'grok', parsed: 0, total: changed.length });

  const scanEntries: ScanEntry[] = [];
  const touched: Array<{ filePath: string; scan: ScanStamp }> = [];
  const seen = new Set<string>();
  let parsed = 0;
  for (const { filePath, scan } of changed) {
    try {
      const result = readGrokMeta(filePath, currentVersion);
      if (result && !seen.has(result.meta.id)) {
        seen.add(result.meta.id);
        scanEntries.push({ meta: result.meta, content: result.content, scan });
      } else {
        touched.push({ filePath, scan });
      }
    } catch {
      touched.push({ filePath, scan });
    }
    parsed++;
    onProgress?.({ agent: 'grok', parsed, total: changed.length });
  }

  upsertSessionsBatch(scanEntries);
  recordScans(touched);
}

/** Parse a single Grok session summary.json into session metadata. */
export function readGrokMeta(
  filePath: string,
  currentVersion?: string,
): { meta: SessionMeta; content: string } | null {
  let summary: any;
  try {
    summary = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch {
    return null;
  }

  const sessionDir = path.dirname(filePath);
  // The uuid directory name is the canonical id; summary.info.id mirrors it.
  const sessionId =
    (typeof summary?.info?.id === 'string' && summary.info.id) || path.basename(sessionDir);
  if (!sessionId) return null;

  const cwd = normalizeCwd(typeof summary?.info?.cwd === 'string' ? summary.info.cwd : '');
  const topic =
    (typeof summary?.generated_title === 'string' && summary.generated_title.trim()) ||
    (typeof summary?.session_summary === 'string' && summary.session_summary.trim()) ||
    undefined;

  // created_at is the session start; last_active_at/updated_at is the latest
  // activity. Coerce timestamp to never-null (NOT NULL column) via the file mtime,
  // matching how the other dir-per-session parsers (Kimi) fall back.
  const createdAt = typeof summary?.created_at === 'string' ? summary.created_at : undefined;
  const lastActivity =
    (typeof summary?.last_active_at === 'string' && summary.last_active_at) ||
    (typeof summary?.updated_at === 'string' && summary.updated_at) ||
    undefined;
  const stat = safeStatSync(filePath);
  const timestamp =
    createdAt || lastActivity || (stat ? stat.mtime.toISOString() : new Date().toISOString());

  const messageCount =
    typeof summary?.num_chat_messages === 'number'
      ? summary.num_chat_messages
      : typeof summary?.num_messages === 'number'
        ? summary.num_messages
        : undefined;

  // Grok records its managed home in summary.grok_home
  // (…/versions/grok/<version>/home/.grok) — recover the version from it. The
  // value is written by the Grok CLI in the writing host's native separators, so
  // a Windows-authored summary is backslash-separated; normalize to `/` before
  // matching or the version never resolves on Windows (RUSH-2286).
  let embeddedVersion: string | undefined;
  if (typeof summary?.grok_home === 'string') {
    embeddedVersion = summary.grok_home.replace(/\\/g, '/').match(/versions\/grok\/([^/]+)\//)?.[1];
  }

  const meta: SessionMeta = {
    id: sessionId,
    shortId: deriveShortId(sessionId),
    agent: 'grok',
    timestamp,
    lastActivity,
    project: cwd ? path.basename(cwd) : undefined,
    cwd: cwd || undefined,
    filePath,
    version: resolveSessionVersion('grok', filePath, embeddedVersion, currentVersion),
    topic,
    messageCount,
  };

  return { meta, content: topic || '' };
}

// parseTimeFilter moved to ./relative-time.js — a leaf module — so a caller that
// only needs the duration parser does not pull this file's `../sqlite.js` import
// (and Node's SQLite ExperimentalWarning on stderr) into its module graph.
// Re-exported so every existing importer keeps working unchanged. Imported too,
// because a bare re-export does not bind the name for this file's own callers.
export { parseTimeFilter } from './relative-time.js';
