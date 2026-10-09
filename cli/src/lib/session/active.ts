import { writerProcessView } from './process-view.js';
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
import { latestSessionFileForCwd, indexedSessionIdForFile, findSessionsByShortIds, findSessionMachinesByIds, getSessionById } from './db.js';
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

export const LSOF_CONCURRENCY = 4;
const LSOF_STAGGER_MS = 10;

const LSOF_TIMEOUT_MS = 5_000;
const PS_SNAPSHOT_TIMEOUT_MS = 10_000;

export const PROCESS_TABLE_FRESH_MS = 5_000;

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

export function attributedSetLostPids(prev: Set<number>, next: Set<number>): boolean {
  for (const p of prev) {
    if (!next.has(p)) return true;
  }
  return false;
}

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

export type SessionPhase = 'running' | 'waiting' | 'failed' | 'done' | 'idle';

export type RecapSource = 'label' | 'generated' | 'prompt';

export type ImportantMessageKind = 'question' | 'needs_you' | 'activity';

export interface SessionImportantMessage {
  text: string;
  kind: ImportantMessageKind;
}

export interface PrCheckItem {
  name: string;
  state: 'passed' | 'failed' | 'running' | 'skipped';
  url?: string;
}

export type SessionPr = DetectedPr & {
  headSha?: string;
  title?: string;
  checkItems?: PrCheckItem[];
};

export type WatchSubagent = import('@phnx-labs/sessions-cli/reader').SessionSubagent & { model?: string; prompt?: string };

export interface ActiveSession {
  context: ActiveContext;
  kind: string;
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
  lastUserMessage?: string;
  generatedTitle?: string;
  title?: string;
  recapSource?: RecapSource;
  userPromptClean?: string;
  userPromptKind?: UserPromptKind;
  lastAgentLine?: string;
  preview?: string;
  importantMessage?: SessionImportantMessage;
  activity?: SessionActivity;
  model?: string;
  failures?: import('@phnx-labs/sessions-cli/reader').SessionFailure[];
  activityHistogram?: import('@phnx-labs/sessions-cli/reader').SessionActivityHistogram;
  userTurns?: import('@phnx-labs/sessions-cli/reader').SessionUserTurn[];
  subagents?: WatchSubagent[];
  tokPerSec?: number;
  awaitingReason?: AwaitingReason;
  question?: StructuredQuestion;
  plan?: string;
  todos?: TodoProgress;
  tail?: string[];
  pr?: SessionPr;
  worktree?: DetectedWorktree;
  ticket?: DetectedTicket;
  rateLimited?: boolean;
  createdTickets?: string[];
  spawnedTeam?: string;
  attachments?: SessionAttachment[];
  request?: SessionRequest;
  timeline?: SessionTimeline;
  files?: SessionFiles;
  tokenCount?: number;
  durationMs?: number;
  subAgentCount?: number;
  artifacts?: import('@phnx-labs/sessions-cli/reader').ProducedArtifact[];
  planFile?: string;
  sessionFile?: string;
  startedAtMs?: number;
  version?: string;
  account?: string;
  accountLabel?: string;
  lastActivityMs?: number;
  lastEventMs?: number;
  status: ActiveStatus;
  phase?: SessionPhase;
  origin?: 'cli' | 'routine';
  routineName?: string;
  presence?: Presence;
  hostLink?: HostLink;
  pidAlive?: boolean;
  tmuxClients?: number;
  windowHeartbeatMs?: number;
  pidCount?: number;
  provenance?: SessionProvenance;
  owner?: string;
  machine?: string;
  offloadedFrom?: string;
  teamName?: string;
  orchestratorSessionId?: string;
  orchestratorLabel?: string;
  assignedTask?: string;
  agentId?: string;
  cloudProvider?: string;
  cloudTaskId?: string;
  cloudStatus?: string;
  windowId?: string;
  workspaceDir?: string;
  tty?: string;
  ghosttyTab?: number;
  tmuxTarget?: string;
  viewingIn?: { app: string; tab?: number };
  terminalId?: string;
  originTerminal?: import('../launch-identity.js').LaunchOrigin;
  tabIndex?: number;
  launchId?: string;
  paneId?: string;
  tmuxName?: string;
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
  localOnly?: boolean;
}

const LIVE_TERMINALS_FILE = path.join(getTerminalsDir(), 'live-terminals.json');

const ACTIVE_MTIME_WINDOW_MS = 2 * 60_000;

const TMUX_LIST_PANES_TIMEOUT_MS = 5_000;

export class TmuxDiscoveryDegradedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TmuxDiscoveryDegradedError';
  }
}

const ACTIVE_SESSION_STALE_MS = 24 * 60 * 60_000;

export const ABANDONED_STALE_MS = 2 * 24 * 60 * 60_000;

const TMUX_FIELD_SEP = ':';

const EXTRA_SESSION_AGENT_COMMS: Partial<Record<SessionAgentId, string[]>> = {
  rush: ['rush'],
};

export function sessionAgentComms(id: SessionAgentId): string[] {
  const comms = new Set<string>();
  const cli = (AGENTS as Record<string, { cliCommand?: string }>)[id]?.cliCommand;
  if (cli) comms.add(cli);
  for (const extra of EXTRA_SESSION_AGENT_COMMS[id] ?? []) comms.add(extra);
  return [...comms];
}

const AGENT_CLI_NAMES: Record<string, SessionAgentId> = (() => {
  const map: Record<string, SessionAgentId> = {};
  for (const id of SESSION_AGENTS) {
    for (const comm of sessionAgentComms(id)) map[comm] = id;
  }
  return map;
})();

export function agentKindFromComm(commRaw: string): string | undefined {
  if (commRaw.includes('.app/Contents/')) return undefined;
  const base = path.basename(commRaw);
  const stripped = base.replace(/\.exe$/i, '');
  const key = stripped === base ? base : stripped.toLowerCase();
  return AGENT_CLI_NAMES[key];
}

const AG_NAME_RE = AG_TMUX_NAME_RE;

export function agentKindFromName(sessName: string): string | undefined {
  const m = AG_NAME_RE.exec(sessName);
  return m ? m[1].toLowerCase() : undefined;
}

export function shortIdFromName(sessName: string): string | undefined {
  const m = AG_NAME_RE.exec(sessName);
  return m ? m[2].toLowerCase() : undefined;
}

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

const PID_REUSE_TOLERANCE_MS = 60_000;

export const PROCESS_START_CACHE_TTL_MS = 30_000;
const processStartCache = new Map<number, { ms: number | null; at: number }>();

export function processStartMs(pid: number, now: number = Date.now()): number | null {
  if (process.platform === 'win32') return null;
  const hit = processStartCache.get(pid);
  if (hit && now - hit.at < PROCESS_START_CACHE_TTL_MS) return hit.ms;
  let ms: number | null = null;
  try {
    const out = execFileSync('ps', ['-o', 'lstart=', '-p', String(pid)], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    const parsed = out ? Date.parse(out) : NaN;
    ms = Number.isFinite(parsed) ? parsed : null;
  } catch {
    ms = null;
  }
  if (processStartCache.size > 2048) {
    for (const [key, entry] of processStartCache) {
      if (now - entry.at >= PROCESS_START_CACHE_TTL_MS) processStartCache.delete(key);
    }
  }
  processStartCache.set(pid, { ms, at: now });
  return ms;
}

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
  sessionId?: string | '';
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
      const key = e?.sessionId || (e?.terminalId ? `terminal\0${e.terminalId}` : undefined);
      if (!key) continue;
      const alive = isPidAlive(e.pid, e.startedAtMs);
      if (!alive && !windowGone) continue;
      const entry: LiveTerminalEntry = { ...e, sessionId: e.sessionId || undefined, windowId, windowHeartbeatMs, pidDead: !alive };
      const prev = merged.get(key);
      if (prev && !prev.pidDead && !alive) continue;
      merged.set(key, entry);
    }
  }
  return Array.from(merged.values());
}

const CLAUDE_SESSION_FILE_CACHE_MAX = 256;
const claudeSessionFileCache = new Map<string, string>();

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

export function sessionFileTimes(sessionFile: string | undefined): { birthtimeMs?: number; mtimeMs?: number } {
  if (!sessionFile) return {};
  try {
    const st = fs.statSync(sessionFile);
    return { birthtimeMs: st.birthtimeMs || undefined, mtimeMs: st.mtimeMs || undefined };
  } catch {
    return {};
  }
}

export function lifecycleStatus(
  pidAlive: boolean,
  mtimeMs: number | undefined,
  nowMs: number = Date.now(),
): ActiveStatus | undefined {
  if (mtimeMs !== undefined && nowMs - mtimeMs >= ABANDONED_STALE_MS) return 'abandoned';
  if (!pidAlive) return 'closed';
  return undefined;
}

export function resolveFallbackStatus(
  sessionFile: string | undefined,
  pidAlive: boolean,
  nowMs: number = Date.now(),
): ActiveStatus {
  const { mtimeMs } = sessionFileTimes(sessionFile);
  return lifecycleStatus(pidAlive, mtimeMs, nowMs) ?? 'running';
}

export function findSessionFileForKind(kind: string, cwd?: string, sessionId?: string): string | undefined {
  if (!cwd) return undefined;
  if (kind === 'claude') return findClaudeSessionFile(cwd, sessionId);
  if (!isSessionTrackedAgent(kind)) return undefined;
  if (sessionId) return indexedSessionFileForId(kind, sessionId);
  return latestSessionFileForCwd(kind, cwd, { maxAgeMs: ACTIVE_SESSION_STALE_MS });
}

function indexedSessionFileForId(kind: string, sessionId: string): string | undefined {
  const row = getSessionById(sessionId);
  if (!row || row.agent !== kind) return undefined;
  return row.filePath || undefined;
}

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
export function sessionIdFromFile(kind: string, file?: string): string | undefined {
  if (!file) return undefined;
  if (kind === 'claude') return path.basename(file).match(UUID_RE)?.[0];
  return indexedSessionIdForFile(kind, file);
}

interface LiveSignals {
  state?: SessionState;
  tokPerSec?: number;
}

const LIVE_STATE_MAX_EVENTS = 80;

function parseTailEventsForKind(agent: SessionAgentId, sessionFile: string): SessionEvent[] {
  let events: SessionEvent[];
  try {
    events = parseSession(sessionFile, agent);
  } catch {
    return [];
  }
  return events.length > LIVE_STATE_MAX_EVENTS ? events.slice(-LIVE_STATE_MAX_EVENTS) : events;
}

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

function parseLiveTail(kind: string, sessionFile: string, mtimeMs: number | undefined): LiveTail {
  if (kind === 'claude' || kind === 'codex') {
    const { events, content } = readSessionTailWithRaw(sessionFile, kind);
    const tokPerSec = events.length > 0 ? computeTokPerSec(content, kind) : 0;
    return { mtimeMs, events, tokPerSec: tokPerSec > 0 ? tokPerSec : undefined };
  }
  if (isSessionTrackedAgent(kind)) return { mtimeMs, events: parseTailEventsForKind(kind, sessionFile) };
  return { mtimeMs, events: [] };
}

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

function applyState(base: Omit<ActiveSession, 'status'>, state: SessionState | undefined, fallbackFile: string | undefined, pidAlive: boolean): ActiveSession {
  if (!state) return { ...base, pidAlive, status: resolveFallbackStatus(fallbackFile, pidAlive) };
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

export function summarizeMission(prompt: string | null | undefined): string | undefined {
  if (!prompt) return undefined;
  const firstLine = prompt.split('\n').map((l) => l.trim()).find(Boolean);
  if (!firstLine) return undefined;
  const cleaned = firstLine.replace(/^(MISSION|CONTEXT|TASK|GOAL|OBJECTIVE)\s*[:\-—]\s*/i, '').trim();
  if (!cleaned) return undefined;
  return cleaned.length > 80 ? `${cleaned.slice(0, 79)}…` : cleaned;
}

export async function listTeamsActive(opts: { localOnly?: boolean } = {}): Promise<ActiveSession[]> {
  const mgr = new AgentManager(undefined, undefined, undefined, undefined, undefined, opts.localOnly ?? false);
  const running = await mgr.listRunning();
  const self = machineId();
  return running.map((a): ActiveSession => {
    const ownSessionId = a.remoteSessionId ?? undefined;
    const sessionFile = findSessionFileForKind(a.agentType, a.cwd ?? undefined, ownSessionId);
    const topic = sessionFile ? quickExtractTopic(sessionFile) : undefined;
    const pidAlive = a.pid ? isPidAlive(a.pid) : true;
    const { state, tokPerSec } = computeLiveSignals(a.agentType, sessionFile, a.cwd ?? undefined, pidAlive);
    const resolvedId = ownSessionId ?? sessionIdFromFile(a.agentType, sessionFile);
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

  return entries.flatMap((t): ActiveSession[] => {
    const directEntry = readPidSessionEntry(t.pid, procByPid.get(t.pid)?.startTime);
    const candidate = directEntry?.sessionId ? directEntry
      : (!t.pidDead ? terminalDescendantEntry(t.pid, procByPid, children) : undefined) ?? directEntry;
    const pidEntry = candidate && (!isSessionTrackedAgent(t.kind) || candidate.agent === t.kind) ? candidate : undefined;
    const resolvedId = pidEntry?.sessionId ?? t.sessionId;
    const cwd = pidEntry?.cwd ?? t.cwd ?? undefined;
    const sessionKind = pidEntry?.agent ?? t.kind;
    if (!resolvedId && !isSessionTrackedAgent(sessionKind)) return [];
    const sessionFile = resolvedId ? findSessionFileForKind(sessionKind, cwd, resolvedId) : undefined;
    const label = t.label ?? (resolvedId ? labelMap.get(resolvedId) : undefined) ?? undefined;
    const name = resolvedId ? runNameMap.get(resolvedId) ?? undefined : undefined;
    const topic = sessionFile ? quickExtractTopic(sessionFile) : undefined;
    const pidAlive = isPidAlive(t.pid, t.startedAtMs);
    const { state, tokPerSec } = computeLiveSignals(sessionKind, sessionFile, cwd, pidAlive);
    return [applyState({
      context: 'terminal',
      kind: sessionKind,
      harness: pidEntry?.harness,
      host: detectHost(t.pid, procByPid),
      tty: procByPid.get(t.pid)?.tty,
      pid: t.pid,
      sessionId: resolvedId ?? sessionIdFromFile(sessionKind, sessionFile),
      launchId: pidEntry?.launchId,
      terminalId: pidEntry?.terminalId ?? t.terminalId,
      originTerminal: pidEntry?.originTerminal,
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
      workspaceDir: t.cwd ?? undefined,
      windowHeartbeatMs: t.windowHeartbeatMs,
      owner: resolveOwner(pidEntry?.actor, resolvedId),
    }, state, sessionFile, pidAlive)];
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

export function resolveCwds(
  pids: number[],
  probe: (pid: number) => Promise<string | undefined> = getCwdForPid,
): Promise<(string | undefined)[]> {
  return mapBounded(pids, probe, { concurrency: LSOF_CONCURRENCY, staggerMs: LSOF_STAGGER_MS });
}

async function getCwdForPid(pid: number): Promise<string | undefined> {
  if (process.platform === 'win32') return undefined;
  if (process.platform === 'linux') return fs.promises.readlink(`/proc/${pid}/cwd`).catch(() => undefined);
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

  let hookIndex: HookSessionIndex | undefined;
  let children: Map<number, number[]> | undefined;
  const runNameMap = buildRunNameMap();
  const ensureChildren = (): Map<number, number[]> => children ??= childrenByParent(ppidMap);

  const out: ActiveSession[] = [];
  for (let i = 0; i < kept.length; i++) {
    const { pid, kind } = kept[i];
    const entry = readPidSessionEntry(pid) ?? readAncestorSessionEntry(pid, ppidMap, kind);
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
    const resolvedId = exactId ?? sessionIdFromFile(kind, sessionFile);
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
      originTerminal: entry?.originTerminal,
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

export function resolvePaneIdentity(
  pane: string,
  sessName: string,
  meta: { labels?: Record<string, string>; source?: string; pane?: string } | null,
  liveEntry: PidSessionEntry | undefined,
  getHookIndex: () => HookSessionIndex,
  nameToFullId: Map<string, string>,
): PaneIdentity | undefined {
  if (meta?.source === 'teams') return undefined;
  const nameAgent = agentKindFromName(sessName);
  const nameSessionId = nameToFullId.get(sessName);
  if (liveEntry) {
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
  const agent = meta?.labels?.agent;
  const sessionId = meta?.labels?.sessionId;
  if (agent && sessionId && (meta?.pane == null || meta.pane === pane)) return { agent, sessionId };
  if (nameAgent) return { agent: nameAgent, sessionId: nameSessionId };
  return undefined;
}

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
    const sessionFile = id.sessionId ? findSessionFileForKind(id.agent, cwd, id.sessionId) : undefined;
    const topic = sessionFile ? quickExtractTopic(sessionFile) : undefined;
    const paneDead = paneDeadRaw === '1';
    const pidAlive = !paneDead && (pid ? isPidAlive(pid, liveEntry?.startedAtMs) : true);
    const { state, tokPerSec } = computeLiveSignals(id.agent, sessionFile, cwd, pidAlive);
    const { birthtimeMs, mtimeMs } = sessionFileTimes(sessionFile);
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
      sessionId: id.sessionId ?? sessionIdFromFile(id.agent, sessionFile),
      cwd,
      topic,
      tokPerSec,
      sessionFile,
      startedAtMs: liveEntry?.startedAtMs ?? birthtimeMs,
      lastActivityMs: mtimeMs,
      provenance,
      owner: resolveOwner(liveEntry?.actor, id.sessionId ?? sessionIdFromFile(id.agent, sessionFile)),
      launchId: liveEntry?.launchId,
      terminalId: liveEntry?.terminalId,
      originTerminal: liveEntry?.originTerminal,
      paneId: id.sessionId ?? sessionIdFromFile(id.agent, sessionFile) ? undefined : pane,
      tmuxName: sessName,
    }, state, sessionFile, pidAlive));
  }
  return out;
}

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

export async function describeActiveDiscoveryHealth(): Promise<ActiveDiscoveryHealth> {
  const degradedSources: string[] = [];
  try {
    await listTmuxAgentSessions();
  } catch (err) {
    if (err instanceof TmuxDiscoveryDegradedError) degradedSources.push('tmux');
  }
  return { degradedSources };
}

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

export function sessionProcessIsLocal(s: Pick<ActiveSession, 'machine' | 'offloadedFrom'>, self: string): boolean {
  if (s.offloadedFrom) return s.offloadedFrom === self;
  return !s.machine || s.machine === self;
}

export function sessionProcessHost(
  s: Pick<ActiveSession, 'machine' | 'offloadedFrom'>,
  self: string,
): string | undefined {
  if (sessionProcessIsLocal(s, self)) return undefined;
  return s.offloadedFrom ?? s.machine;
}

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
    if ((link === 'no-client' || link === 'host-gone') && s.presence === 'attached') {
      s.presence = undefined;
    }
    if (link === 'host-gone' && s.status === 'closed') s.status = 'crashed';
    else if (link === 'no-client' && (s.status === 'idle' || s.status === 'input_required')) {
      s.status = 'orphaned';
    }
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

function foldPresence(rows: ActiveSession[]): void {
  for (const s of rows) {
    if (!s.sessionId) continue;
    const stored = presenceFromStore(s.sessionId);
    if (stored) s.presence = stored;
    else if (s.context === 'terminal') s.presence = 'attached';
  }
}

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

function anonymousWorkerKey(s: ActiveSession): string | undefined {
  if (!s.cwd) return undefined;
  return `anon\0${s.kind}\0${s.context}\0${s.cwd}`;
}

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
