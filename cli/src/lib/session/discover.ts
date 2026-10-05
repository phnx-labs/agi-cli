
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';
import * as readline from 'readline';
import { execFile } from 'child_process';
import { promisify } from 'util';
import Database from '../sqlite.js';
import { getAgentsDir, getUserAgentsDir, getHistoryDir, getRunsDir } from '../state.js';
import { parseTimeFilter } from './relative-time.js';

const execFileAsync = promisify(execFile);
import type { SessionAgentId, SessionEvent, SessionMeta, TodoProgress } from '@phnx-labs/sessions-cli/reader';
import type { AgentId } from '../types.js';
import { AGENTS, agentConfigDirName, getCliVersion, resolveOpenCodeAccountId } from '../agents.js';
import { walkForFilesWithStat } from '../fs-walk.js';
import { hasCommand } from '../cli-resources.js';
import { execFileShellSpec } from '../platform/exec.js';
import { getConfigSymlinkVersion } from '../installations/shims.js';
import { SESSION_AGENTS } from '@phnx-labs/sessions-cli/reader';
import { deriveShortId } from './short-id.js';
import { buildClaudeAccountIndex, resolveClaudeAccount, type ClaudeAccountIndex } from './claude-accounts.js';
import { cleanFirstUserMessage, extractSessionTopic, extractSlashCommandName, extractSlashCommandFromToolInput, cleanGeneratedSessionLabel } from '@phnx-labs/sessions-cli/reader';
import { isBackgroundShellStart, isSkillInvocation, extractSkills, extractSlashCommands, isSubAgentTool } from '@phnx-labs/sessions-cli/reader';
import { claudeSubagentFiles, resolvedSubAgentCount } from './glance-files.js';
import { parseAntigravity, parseCursor, splitSessionFilePath } from '@phnx-labs/sessions-cli/reader';
import { extractPrUrl, detectWorktree, detectTicket, isPrCreateCommand, detectSpawnedTeam, isTicketCreateTool, extractCreatedTicket, extractRecentDirectoriesTouched, extractTodoProgressFromEvents } from '@phnx-labs/sessions-cli/reader';
import { costOfUsage, costOfUsageNoCache } from '../pricing/index.js';
import { machineId } from './sync/config.js';
import { isSelfHost } from '../devices/self-host.js';
import { readSessionActorRecord } from './actor-sidecar.js';
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
  getSessionById,
  tryClaimScan,
  releaseScan,
  scanInProgressByLivePid,
  cacheLinearProject,
  CONTENT_INDEX_VERSION,
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
} from '@phnx-labs/sessions-cli/reader';
import { purgeMissingToolCallsInDirectory } from './tool-store.js';

const HOME = os.homedir();
const VERSIONS_ROOTS = [getHistoryDir(), getAgentsDir()];
const RUSH_SESSIONS_DIR = path.join(HOME, '.rush', 'sessions');
const HERMES_SESSIONS_DIR = path.join(HOME, '.hermes', 'sessions');
const MUSE_SESSIONS_DIR = path.join(HOME, '.local', 'share', 'muse', 'sessions');

const OPENCLAW_TTL_MS = 60_000;
const ACTIVE_APPEND_RESCAN_DEBOUNCE_MS = 5_000;
const SESSION_JSONL_LINE_MAX_BYTES = 1024 * 1024;

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

const HOT_FILE_WINDOW_MS = 600_000;

function dirLedgerDisabled(): boolean {
  const v = process.env.AGENTS_SESSIONS_NO_DIR_LEDGER;
  return v === '1' || v === 'true';
}

let cachedOpenClawWorkspaces: Map<string, string> | null = null;

export interface DiscoverOptions {
  agent?: SessionAgentId;
  includeUnmanaged?: boolean;
  onHiddenUnmanaged?: (count: number) => void;
  version?: string;
  project?: string;
  all?: boolean;
  cwd?: string;
  cwdPrefix?: string;
  limit?: number;
  unbounded?: boolean;
  since?: string;
  until?: string;
  excludeTeamOrigin?: boolean;
  onlyTeamOrigin?: boolean;
  origin?: 'cli' | 'routine';
  sortBy?: 'timestamp' | 'cost' | 'duration';
  skipExistenceCheck?: boolean;
  onProgress?: (progress: ScanProgress) => void;
  skill?: string;
  plugin?: string;
  idExact?: string;
  idPrefix?: string;
  waitForScan?: boolean;
}

const WAIT_FOR_SCAN_TIMEOUT_MS = 2_000;
const WAIT_FOR_SCAN_POLL_MS = 100;

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export interface ScanProgress {
  agent: SessionAgentId;
  parsed: number;
  total: number;
}

interface ClaudeSessionScan {
  timestamp?: string;
  cwd?: string;
  gitBranch?: string;
  version?: string;
  model?: string;
  topic?: string;
  firstUserMessage?: string;
  label?: string;
  messageCount: number;
  tokenCount?: number;
  outputTokens?: number;
  inputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  costUsd?: number;
  costUsdNoCache?: number;
  durationMs?: number;
  lastActivity?: string;
  toolCallCount?: number;
  entrypoint?: string;
  contentText?: string;
  assistantText?: string;
  prUrl?: string;
  prNumber?: number;
  worktreeSlug?: string;
  ticketId?: string;
  createdTickets?: string[];
  spawnedTeam?: string;
  plan?: string;
  todos?: TodoProgress;
  recentDirectoriesTouched?: string[];
  skillsUsed?: Array<{ name: string; count: number }>;
  subAgentCount?: number;
  backgroundShellCount?: number;
  slashCommandsUsed?: Array<{ name: string; count: number }>;
}

interface CodexSessionScan {
  sessionId?: string;
  timestamp?: string;
  cwd?: string;
  gitBranch?: string;
  version?: string;
  model?: string;
  topic?: string;
  firstUserMessage?: string;
  messageCount: number;
  tokenCount?: number;
  outputTokens?: number;
  inputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  costUsd?: number;
  costUsdNoCache?: number;
  durationMs?: number;
  lastActivity?: string;
  contentText?: string;
  assistantText?: string;
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

interface ScanEntry {
  meta: SessionMeta;
  content: string;
  assistantContent?: string;
  scan: ScanStamp;
  events?: SessionEvent[];
  parserState?: string;
  contentText?: string;
  toolCalls?: IndexedToolCall[];
  toolIndexMode?: 'replace' | 'append';
}

export async function discoverSessions(options?: DiscoverOptions): Promise<SessionMeta[]> {
  const { claimed } = await scanSessionsIncremental({
    agent: options?.agent,
    onProgress: options?.onProgress,
  });

  if (!claimed && options?.waitForScan) {
    await waitForScanToSettle();
  }

  return queryIndexedSessions(options, {
    skipExistenceCheck: options?.skipExistenceCheck ?? false,
  });
}

export async function findLocalSessionTranscripts(selector: string, agent?: SessionAgentId): Promise<SessionMeta[]> {
  const matches = new Map<string, SessionMeta>();
  const seen = new Set<string>();
  for (const harness of ['claude', 'codex'] as const) {
    if (agent && agent !== harness) continue;
    const subdir = harness === 'claude' ? 'projects' : 'sessions';
    const roots = [...getAgentSessionDirs(harness, subdir), ...getRoutineArchiveSessionDirs(harness, subdir)];
    for (const root of roots) {
      for (const file of walkForFilesWithStat(root, '.jsonl', Number.MAX_SAFE_INTEGER)) {
        const name = path.basename(file.path, '.jsonl');
        const id = harness === 'claude' ? name : name.match(/([0-9a-f]{8}-[0-9a-f-]{27})$/i)?.[1];
        if (!id?.toLowerCase().startsWith(selector.toLowerCase())) continue;
        const real = fs.realpathSync(file.path);
        if (seen.has(real)) continue;
        seen.add(real);
        const result = harness === 'claude'
          ? await readClaudeMeta(real, id, { fileMtimeMs: Math.floor(file.mtimeMs), fileSize: file.size }, undefined)
          : await readCodexMeta(real);
        if (!result?.meta.id.toLowerCase().startsWith(selector.toLowerCase()) || !result.meta.messageCount) continue;
        const sidecar = readSessionActorRecord(result.meta.id);
        const row = {
          ...result.meta, accountId: sidecar?.accountId, mode: sidecar?.mode,
          actor: sidecar?.actor, initiatedBy: sidecar?.initiatedBy,
          phoenixId: sidecar?.phoenixId, harness: sidecar?.harness ?? result.meta.harness,
          machine: machineForSessionFile(real, harness),
        };
        if (!matches.has(row.id)) matches.set(row.id, row);
      }
    }
  }
  return [...matches.values()];
}

export async function hydrateSessionTranscript(session: SessionMeta): Promise<SessionMeta> {
  const accountId = session.accountId ?? readSessionActorRecord(session.id)?.accountId;
  if (accountId && !session.accountId) session = { ...session, accountId };
  const file = splitSessionFilePath(session.filePath).container;
  try {
    if (file && fs.statSync(file).isFile() && fs.statSync(file).size > 0) return session;
  } catch {  }
  if (session.machine && !isSelfHost(session.machine)) return session;
  if (session.agent === 'claude' || session.agent === 'codex') {
    const local = (await findLocalSessionTranscripts(session.id, session.agent)).find(row => row.id === session.id);
    return local ? { ...session, ...local, accountId: session.accountId ?? local.accountId } : session;
  }
  let { claimed } = await scanSessionsIncremental({ agent: session.agent });
  if (!claimed) {
    if (!await waitForScanToSettle()) throw new Error(`Transcript verification for ${session.shortId} is incomplete: another index scan is still running. Retry when it finishes.`);
    ({ claimed } = await scanSessionsIncremental({ agent: session.agent }));
    if (!claimed) throw new Error(`Transcript verification for ${session.shortId} is incomplete: the index is busy. Retry shortly.`);
  }
  const indexed = getSessionById(session.id);
  return indexed ? { ...session, ...indexed, accountId: session.accountId ?? indexed.accountId } : session;
}

interface IncrementalScanResult {
  claimed: boolean;
  scanned: number;
}

export async function scanSessionsIncremental(options?: {
  agent?: SessionAgentId;
  onProgress?: (p: ScanProgress) => void;
}): Promise<IncrementalScanResult> {
  getDB();

  const agents = options?.agent ? [options.agent] : SESSION_AGENTS;
  const onProgress = options?.onProgress;

  if (!tryClaimScan(process.pid)) return { claimed: false, scanned: 0 };

  const parsedByPhaseAgent = new Map<string, number>();
  const track = (phase: string) => (p: ScanProgress) => {
    parsedByPhaseAgent.set(`${phase}\0${p.agent}`, p.parsed);
    onProgress?.(p);
  };

  try {
    await scanAgentsBounded(agents, agent => dispatchAgentScan(agent, track('dotfiles')));
    await scanAgentsBounded(agents, agent => scanRoutineArchivesIncremental(agent, track('routines')));
    seedLabelsFromNames(buildRunNameMap());
  } finally {
    releaseScan(process.pid);
  }

  let scanned = 0;
  for (const n of parsedByPhaseAgent.values()) scanned += n;
  return { claimed: true, scanned };
}

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
    if (s.filePath || !s.machine?.trim()) s.machine = machineForSessionFile(s.filePath, s.agent);
  }
  return scopeToManaged(sessions, agents, options);
}

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
      } catch {  }
    }
  }
  return false;
}

export const DOTFILE_SCAN_CONCURRENCY = 2;
const DOTFILE_SCAN_STAGGER_MS = 15;

export function scanAgentsBounded<T>(
  items: readonly T[],
  run: (item: T) => Promise<void>,
): Promise<void[]> {
  return mapBounded(items, run, {
    concurrency: DOTFILE_SCAN_CONCURRENCY,
    staggerMs: DOTFILE_SCAN_STAGGER_MS,
  });
}

function dispatchAgentScan(
  agent: SessionAgentId,
  onProgress?: (p: ScanProgress) => void,
): Promise<void> {
  switch (agent) {
    case 'claude': return scanClaudeIncremental(onProgress);
    case 'codex': return scanCodexIncremental(onProgress);
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


export function isManagedSessionFile(filePath: string): boolean {
  if (!filePath || !path.isAbsolute(filePath)) return true;

  if (splitSessionFilePath(filePath).fragment !== undefined) return true;

  const roots = [
    ...VERSIONS_ROOTS.map((root) => path.join(root, 'versions')),
    path.join(getHistoryDir(), 'backups'),
    path.join(getUserAgentsDir(), '.codex-homes'),
    path.join(getHistoryDir(), 'accounts'),
    getRunsDir(),
  ];

  const real = safeRealpathSync(filePath) || filePath;
  return roots.some((root) => {
    if (filePath.startsWith(root + path.sep)) return true;
    const realRoot = safeRealpathSync(root);
    return !!realRoot && real.startsWith(realRoot + path.sep);
  });
}



export function countSessionsInScope(options: DiscoverOptions): number {
  const agents = options.agent ? [options.agent] : SESSION_AGENTS;
  return countSessions(buildQueryOptions(options, agents, { includeLimit: false }));
}

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

export function _normalizeCwdForTest(cwd?: string): string {
  return normalizeCwd(cwd);
}

function normalizeCwd(cwd?: string): string {
  if (!cwd) return '';
  if (process.platform === 'win32' && /^\//.test(cwd) && !/^[a-zA-Z]:/.test(cwd)) {
    return stripTrailingSep(path.posix.normalize(cwd));
  }
  if (process.platform !== 'win32' && /^([a-zA-Z]:[\\/]|\\\\)/.test(cwd)) {
    return stripTrailingSep(path.win32.normalize(cwd));
  }
  const normalized = path.isAbsolute(cwd) ? stripTrailingSep(path.normalize(cwd)) : path.resolve(cwd);
  return safeRealpathSync(normalized) || normalized;
}

function stripTrailingSep(p: string): string {
  const stripped = p.replace(/[\\/]+$/, '');
  return stripped.length > 0 && !/^[a-zA-Z]:$/.test(stripped) ? stripped : p;
}

const UUID_36 = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SESSION_UUID_PREFIX = /^session_/;
const SES_ULID = /^ses_[0-9a-z]{26}$/;

export function isCompleteSessionId(query: string): boolean {
  const q = query.trim().toLowerCase();
  return UUID_36.test(q.replace(SESSION_UUID_PREFIX, '')) || SES_ULID.test(q);
}

export function looksLikeSessionId(query: string): boolean {
  const trimmed = query.trim();
  return /^[0-9a-f-]{6,}$/i.test(trimmed) || isCompleteSessionId(trimmed);
}

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
    const session = byId.get(hit.sessionId) ?? getSessionById(hit.sessionId);
    if (!session) continue;
    result.set(hit.sessionId, {
      ...session,
      _matchedTerms: hit.matchedTerms,
      _bm25Score: hit.score,
      snippet: hit.snippet,
    });
  }
  return result;
}


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

interface PreStatEntry {
  filePath: string;
  fileMtimeMs: number;
  fileSize: number;
}

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
    const contentIndexStale = prev?.extractorVersion !== CONTENT_INDEX_VERSION;
    if (prev && prev.fileMtimeMs === scan.fileMtimeMs && prev.fileSize === scan.fileSize && !contentIndexStale) {
      continue;
    }
    if (prev && !contentIndexStale && shouldDeferRecentAppend(prev, scan, now)) {
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


interface LeafDir {
  dirPath: string;
  isLiveRoot: boolean;
}

interface LeafDirScan {
  changed: Array<{ filePath: string; scan: ScanStamp }>;
  allFiles: Array<{ filePath: string; isLiveRoot: boolean }>;
}

function collectChangedFilesInLeafDirs(
  leafDirs: LeafDir[],
  ext: string,
): LeafDirScan {
  const disabled = dirLedgerDisabled();
  const dirStamps = disabled ? new Map<string, DirStamp>() : getDirLedgerForPaths(leafDirs.map(d => d.dirPath));
  const now = Date.now();

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
      const stamps = isLiveRoot ? null : getScanStampsForPaths(files);
      for (const filePath of files) {
        let hot = isLiveRoot;
        if (!hot && stamps) {
          const s = stamps.get(filePath);
          hot = s?.extractorVersion !== CONTENT_INDEX_VERSION
            || (s?.scannedAt !== undefined && now - s.scannedAt <= HOT_FILE_WINDOW_MS);
        }
        if (!hot) continue;
        const stat = safeStatSync(filePath);
        if (!stat) continue;
        toCompare.push({ filePath, fileMtimeMs: stat.mtimeMs, fileSize: stat.size });
      }
    } else {
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

  const configDirName = agent in AGENTS ? agentConfigDirName(agent as AgentId) : `.${agent}`;

  addDir(path.join(HOME, configDirName, subdir));

  for (const root of VERSIONS_ROOTS) {
    const versionsBase = path.join(root, 'versions', agent);
    if (!fs.existsSync(versionsBase)) continue;
    try {
      for (const version of fs.readdirSync(versionsBase)) {
        addDir(path.join(versionsBase, version, 'home', configDirName, subdir));
      }
    } catch {  }
  }

  if (agent === 'codex') {
    const codexHomesBase = path.join(getUserAgentsDir(), '.codex-homes');
    try {
      for (const key of fs.readdirSync(codexHomesBase)) {
        addDir(path.join(codexHomesBase, key, '.codex', subdir));
      }
    } catch {  }
  }

  const accountsBase = path.join(getHistoryDir(), 'accounts', agent);
  try {
    for (const accountId of fs.readdirSync(accountsBase)) {
      addDir(path.join(accountsBase, accountId, configDirName, subdir));
    }
  } catch {  }

  const backupsBase = path.join(getHistoryDir(), 'backups', agent);
  if (fs.existsSync(backupsBase)) {
    try {
      for (const ts of fs.readdirSync(backupsBase)) {
        addDir(path.join(backupsBase, ts, subdir));
      }
    } catch {  }
  }

  return dirs;
}

const SESSION_ROOT_SPECS: ReadonlyArray<{ agent: SessionAgentId; subdir: string }> = [
  { agent: 'claude', subdir: 'projects' },
  { agent: 'codex', subdir: 'sessions' },
  { agent: 'antigravity', subdir: 'conversations' },
  { agent: 'droid', subdir: 'sessions' },
  { agent: 'kimi', subdir: 'sessions' },
  { agent: 'grok', subdir: 'sessions' },
  { agent: 'cursor', subdir: 'projects' },
];

function sessionRootSubdir(agent: SessionAgentId): string | null {
  return SESSION_ROOT_SPECS.find((spec) => spec.agent === agent)?.subdir ?? null;
}

interface SessionRoots {
  agent: SessionAgentId;
  dirs: string[];
}

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
  assistantContent?: string;
  events?: SessionEvent[];
  toolCalls?: IndexedToolCall[];
  toolIndexMode?: 'replace' | 'append';
} | null> {
  const info = routineArchiveInfo(filePath);
  if (!info) return null;

  if (agent === 'claude') {
    const sessionId = path.basename(filePath).replace(/\.jsonl$/, '');
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

  const ext = '.jsonl';
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
        assistantContent: result.assistantContent,
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


let cachedClaudeAccountIndex: ClaudeAccountIndex | undefined;

function claudeAccountIndex(refresh = false): ClaudeAccountIndex {
  if (refresh || !cachedClaudeAccountIndex) cachedClaudeAccountIndex = buildClaudeAccountIndex();
  return cachedClaudeAccountIndex;
}


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
    } catch {  }
  }

  const out = new Map<string, string | null>();
  for (const [sid, { label }] of map) out.set(sid, label);
  return out;
}

async function scanClaudeIncremental(onProgress?: (p: ScanProgress) => void): Promise<void> {
  claudeAccountIndex(true);
  const labelMap = buildClaudeLabelMap();

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
  const sessionIdOf = (fp: string) => path.basename(fp).replace('.jsonl', '');
  const winnerBySession = new Map<string, string>();

  for (const { filePath } of allFiles) {
    const id = sessionIdOf(filePath);
    if (!winnerBySession.has(id)) winnerBySession.set(id, filePath);
  }
  const changed = changedAll.filter(e => winnerBySession.get(sessionIdOf(e.filePath)) === e.filePath);

  if (changed.length > 0) {
    onProgress?.({ agent: 'claude', parsed: 0, total: changed.length });

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
            assistantContent: result.assistantContent,
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

  if (labelMap.size > 0) syncLabels(labelMap);
}

async function readClaudeMeta(
  filePath: string,
  sessionId: string,
  scanStamp: ScanStamp,
  priorRow: { parserState: string | null; fileMtimeMs: number; extractorVersion?: number | null } | undefined,
  label?: string,
): Promise<{
  meta: SessionMeta;
  content: string;
  assistantContent: string;
  parserState: string;
  contentText?: string;
  toolCalls?: IndexedToolCall[];
  toolIndexMode: 'replace' | 'append';
} | null> {
  const prior = priorRow?.extractorVersion === CONTENT_INDEX_VERSION ? parsePriorClaudeState(priorRow) : null;
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
  const acct = resolveClaudeAccount(claudeAccountIndex(), filePath, scan.version, readSessionActorRecord(sessionId)?.accountId);

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
      firstUserMessage: scan.firstUserMessage,
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
      subAgentCount: scan.subAgentCount,
      backgroundShellCount: scan.backgroundShellCount,
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
      topic: scan.topic,
      firstUserMessage: scan.firstUserMessage,
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
      subAgentCount: scan.subAgentCount,
      backgroundShellCount: scan.backgroundShellCount,
      slashCommandsUsed: scan.slashCommandsUsed,
    };
  }

  return {
    meta,
    content: scan.contentText || '',
    assistantContent: scan.assistantText || '',
    parserState: JSON.stringify(newState),
    contentText: newState.contentText,
    toolCalls,
    toolIndexMode: mode === 'full' ? 'replace' : 'append',
  };
}


let cachedCodexAccount: string | undefined;

let codexAccountResolveCount = 0;

export function decodeJwtEmail(idToken: string): string | undefined {
  const parts = idToken.split('.');
  if (parts.length < 2) return undefined;
  try {
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf-8'));
    return typeof payload.email === 'string' ? payload.email : undefined;
  } catch {
    return undefined;
  }
}

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
    } catch {  }
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
    } catch {  }
  }

  cachedCodexAccount = '';
  return undefined;
}

export function __codexAccountResolveCountForTest(): number {
  return codexAccountResolveCount;
}

export function __resetCodexAccountCacheForTest(): void {
  cachedCodexAccount = undefined;
  codexAccountResolveCount = 0;
}


async function scanCodexIncremental(onProgress?: (p: ScanProgress) => void): Promise<void> {
  const currentVersion = await getCurrentAgentVersion('codex');

  const prestat: PreStatEntry[] = [];
  for (const sessionsDir of getAgentSessionDirs('codex', 'sessions')) {
    for (const f of walkForFilesWithStat(sessionsDir, '.jsonl', 100_000)) {
      prestat.push({ filePath: f.path, fileMtimeMs: f.mtimeMs, fileSize: f.size });
    }
  }

  const changed = filterChangedEntries(prestat);

  const titleIndex = diffCodexTitleIndexes();

  if (changed.length === 0 && !titleIndex.changed) return;

  const titles = readCodexThreadNames();

  if (changed.length === 0) {
    syncTopics(titles);
    recordScans(titleIndex.stamps);
    return;
  }

  onProgress?.({ agent: 'codex', parsed: 0, total: changed.length });

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
        const title = titles.get(result.meta.id);
        if (title) result.meta.topic = title;
        entries.push({
          meta: result.meta,
          content: result.content,
          assistantContent: result.assistantContent,
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
  if (titleIndex.changed) syncTopics(titles);
  recordScans(titleIndex.stamps);
}

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
    }
  }
  return titles;
}

function diffCodexTitleIndexes(): {
  stamps: Array<{ filePath: string; scan: ScanStamp }>;
  changed: boolean;
} {
  const stamps: Array<{ filePath: string; scan: ScanStamp }> = [];
  let changed = false;
  for (const sessionsDir of getAgentSessionDirs('codex', 'sessions')) {
    const indexPath = path.join(path.dirname(sessionsDir), 'session_index.jsonl');
    const stat = safeStatSync(indexPath);
    if (!stat) continue;
    const scan: ScanStamp = { fileMtimeMs: Math.floor(stat.mtimeMs), fileSize: stat.size };
    const prev = getScanStampByPath(indexPath);
    if (!prev || prev.fileMtimeMs !== scan.fileMtimeMs || prev.fileSize !== scan.fileSize) {
      changed = true;
    }
    stamps.push({ filePath: indexPath, scan });
  }
  return { stamps, changed };
}

function readCodexThreadNames(): Map<string, string> {
  const titles = new Map<string, string>();
  for (const sessionsDir of getAgentSessionDirs('codex', 'sessions')) {
    const indexPath = path.join(path.dirname(sessionsDir), 'session_index.jsonl');
    let raw: string;
    try {
      raw = fs.readFileSync(indexPath, 'utf-8');
    } catch {
      continue;
    }
    for (const [id, name] of parseCodexThreadNameIndex(raw)) titles.set(id, name);
  }
  return titles;
}

export async function readCodexMeta(
  filePath: string,
  resolveAccount?: () => string | undefined,
  currentVersion?: string,
  scanStamp?: ScanStamp,
  priorRow?: { parserState: string | null; fileMtimeMs: number; extractorVersion?: number | null },
): Promise<{
  meta: SessionMeta;
  content: string;
  assistantContent: string;
  parserState?: string;
  contentText?: string;
  toolCalls?: IndexedToolCall[];
  toolIndexMode: 'replace' | 'append';
} | null> {
  let scan: CodexSessionScan;
  let newState: CodexParserState | undefined;
  let newOffset = 0;
  let toolCalls: IndexedToolCall[] | undefined;
  let toolIndexMode: 'replace' | 'append' = 'replace';
  if (scanStamp) {
    const prior = priorRow?.extractorVersion === CONTENT_INDEX_VERSION ? parsePriorCodexState(priorRow) : null;
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
    timestamp: pickLatestCodexTimestamp(scan.timestamp, filePath),
    lastActivity: scan.lastActivity,
    project: cwd ? path.basename(cwd) : undefined,
    cwd,
    filePath,
    gitBranch: scan.gitBranch,
    version: resolveSessionVersion('codex', filePath, scan.version, currentVersion),
    model: scan.model,
    topic: scan.topic,
    firstUserMessage: scan.firstUserMessage,
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
    assistantContent: scan.assistantText || '',
    parserState: newState ? JSON.stringify(newState) : undefined,
    contentText: newState?.contentText,
    toolCalls,
    toolIndexMode,
  };
}

function pickLatestCodexTimestamp(metaTimestamp: string | undefined, filePath: string): string {
  const fallback = new Date().toISOString();
  let mtimeIso: string | null = null;
  try {
    mtimeIso = fs.statSync(filePath).mtime.toISOString();
  } catch {
  }

  const candidates = [metaTimestamp, mtimeIso].filter((v): v is string => !!v);
  if (candidates.length === 0) return fallback;

  return candidates.reduce((best, cur) => (cur > best ? cur : best));
}


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

function readAntigravityMeta(
  filePath: string,
  currentVersion?: string,
): { meta: SessionMeta; content: string; events: SessionEvent[] } | null {
  const sessionId = path.basename(filePath).replace(/\.db$/, '');
  if (!sessionId) return null;

  const events = parseAntigravity(filePath);

  let cwd: string | undefined;
  const contentParts: string[] = [];
  for (const e of events) {
    if (!cwd && typeof e.args?.Cwd === 'string' && e.args.Cwd) cwd = e.args.Cwd;
    if (e.content) contentParts.push(e.content);
  }
  const normalizedCwd = cwd ? normalizeCwd(cwd) : undefined;

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


const OPENCODE_DB = path.join(HOME, '.local', 'share', 'opencode', 'opencode.db');

let cachedOpenCodeAccount: string | undefined;

function getOpenCodeAccount(): string | undefined {
  if (cachedOpenCodeAccount !== undefined) return cachedOpenCodeAccount || undefined;
  cachedOpenCodeAccount = resolveOpenCodeAccountId(HOME) ?? '';
  return cachedOpenCodeAccount || undefined;
}

function openCodeSessionStamp(
  times: { timeUpdated: number; timeCreated: number; lastMessageAt: number; lastPartAt: number },
  bytes: { messageBytes: number; partBytes: number },
  dbScan: ScanStamp,
): ScanStamp {
  const known = [times.timeUpdated, times.lastMessageAt, times.lastPartAt, times.timeCreated]
    .filter(t => Number.isFinite(t) && t > 0);
  const size = (Number.isFinite(bytes.messageBytes) ? bytes.messageBytes : 0)
    + (Number.isFinite(bytes.partBytes) ? bytes.partBytes : 0);
  if (known.length === 0 && size === 0) return dbScan;
  return { fileMtimeMs: known.length === 0 ? 0 : Math.floor(Math.max(...known)), fileSize: size };
}

async function scanOpenCodeIncremental(onProgress?: (p: ScanProgress) => void): Promise<void> {
  if (!fs.existsSync(OPENCODE_DB)) return;

  const stat = safeStatSync(OPENCODE_DB);
  if (!stat) return;

  const currentScan: ScanStamp = {
    fileMtimeMs: Math.floor(stat.mtimeMs),
    fileSize: stat.size,
  };
  const prev = getScanStampByPath(OPENCODE_DB);
  const extractorUpgrade = prev != null && prev.extractorVersion !== CONTENT_INDEX_VERSION;
  if (
    prev &&
    prev.fileMtimeMs === currentScan.fileMtimeMs &&
    prev.fileSize === currentScan.fileSize &&
    prev.extractorVersion === CONTENT_INDEX_VERSION
  ) {
    return;
  }

  const currentVersion = await getCurrentAgentVersion('opencode');

  let db: Database.Database | undefined;
  try {
    db = new Database(OPENCODE_DB);
    const sessionCols = new Set(
      (db.prepare('PRAGMA table_info(session);').all() as Array<{ name?: unknown }>)
        .map(c => (typeof c.name === 'string' ? c.name : '')),
    );
    const costExpr = sessionCols.has('cost') ? 's.cost' : 'NULL';
    const modelExpr = sessionCols.has('model') ? 's.model' : 'NULL';
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
      ${extractorUpgrade ? '' : 'LIMIT 1000'};
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
        || prevStamp.fileSize !== c.scan.fileSize
        || prevStamp.extractorVersion !== CONTENT_INDEX_VERSION;
    });

    const firstUserStmt = db.prepare(`
      SELECT json_extract(p.data, '$.text') AS text
      FROM part p
      WHERE p.message_id = (
        SELECT m.id FROM message m
        WHERE m.session_id = ?
          AND json_valid(m.data) AND json_extract(m.data, '$.role') = 'user'
        ORDER BY m.time_created ASC
        LIMIT 1
      )
      AND json_valid(p.data) AND json_extract(p.data, '$.type') = 'text'
      ORDER BY p.time_created ASC
    `);

    const entries: ScanEntry[] = [];
    for (const { row, id, filePath, scan } of changed) {
      const title = typeof row.title === 'string' ? row.title : '';
      const firstUserMessage = (firstUserStmt.all(id) as Array<{ text: unknown }>)
        .map((part) => (typeof part.text === 'string' ? part.text : ''))
        .join('')
        .trim() || undefined;
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
      const lastActivity = Number.isNaN(timeUpdated) ? timestamp : new Date(timeUpdated).toISOString();
      const topic = title || undefined;

      const durationMs =
        Number.isFinite(timeCreated) && Number.isFinite(timeUpdated) && timeUpdated > timeCreated
          ? timeUpdated - timeCreated
          : undefined;
      let model: string | undefined;
      if (typeof row.model === 'string' && row.model.trim()) {
        try {
          const parsed = JSON.parse(row.model) as { id?: unknown };
          if (typeof parsed?.id === 'string' && parsed.id.trim()) model = parsed.id;
        } catch {  }
      }
      const costUsd = typeof row.cost === 'number' ? row.cost : undefined;

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
        firstUserMessage,
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
    onProgress?.({ agent: 'opencode', parsed: entries.length, total: entries.length });
    recordScans([{ filePath: OPENCODE_DB, scan: currentScan }]);
  } catch (err: any) {
    if (process.stderr.isTTY) {
      console.error(`Warning: Could not query OpenCode sessions: ${err.message}`);
    }
  } finally {
    try { db?.close(); } catch {  }
  }
}


async function scanOpenClawIncremental(onProgress?: (p: ScanProgress) => void): Promise<void> {
  if (!hasCommand('openclaw')) return;

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
  }

  upsertSessionsBatch(entries);
  db.prepare(`INSERT OR REPLACE INTO meta (key, value) VALUES ('openclaw_last_scan_ms', ?)`).run(String(Date.now()));
}


interface RushSessionScan {
  timestamp?: string;
  topic?: string;
  firstUserMessage?: string;
  agentId?: string;
  messageCount: number;
  contentText?: string;
  assistantText?: string;
}

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
        entries.push({ meta: result.meta, content: result.content, assistantContent: result.assistantContent, scan });
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

async function readRushMeta(
  filePath: string,
  sessionId: string,
): Promise<{ meta: SessionMeta; content: string; assistantContent: string } | null> {
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
    firstUserMessage: scan.firstUserMessage,
    messageCount: scan.messageCount,
  };

  return { meta, content: scan.contentText || '', assistantContent: scan.assistantText || '' };
}

async function scanRushSession(filePath: string): Promise<RushSessionScan> {
  const stream = fs.createReadStream(filePath, { encoding: 'utf-8' });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

  let timestamp: string | undefined;
  let topic: string | undefined;
  let firstUserMessage: string | undefined;
  let agentId: string | undefined;
  let messageCount = 0;
  const userTexts: string[] = [];
  const assistantTexts: string[] = [];

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
        if (!firstUserMessage) firstUserMessage = cleanFirstUserMessage(cleaned);
        if (!topic) topic = extractSessionTopic(cleaned);
      } else if (parsed.role === 'assistant') {
        assistantTexts.push(cleaned);
      }
    }
  } finally {
    rl.close();
    stream.destroy();
  }

  return {
    timestamp,
    topic,
    firstUserMessage,
    agentId,
    messageCount,
    contentText: userTexts.length > 0 ? userTexts.join('\n') : undefined,
    assistantText: assistantTexts.length > 0 ? assistantTexts.join('\n') : undefined,
  };
}


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
        scanEntries.push({ meta: result.meta, content: result.content, assistantContent: result.assistantContent, scan });
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

function readHermesMeta(filePath: string): { meta: SessionMeta; content: string; assistantContent: string } | null {
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
  const assistantTexts: string[] = [];
  let topic: string | undefined;
  let firstUserMessage: string | undefined;
  let messageCount = 0;
  for (const msg of messages) {
    const text = extractHermesMessageText(msg?.content);
    if (!text) continue;
    messageCount++;
    if (msg?.role === 'user') {
      userTexts.push(text);
      if (!firstUserMessage) firstUserMessage = cleanFirstUserMessage(text);
      if (!topic) topic = extractSessionTopic(text);
    } else if (msg?.role === 'assistant') {
      assistantTexts.push(text);
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
    firstUserMessage,
    messageCount: messageCount || (typeof session.message_count === 'number' ? session.message_count : undefined),
  };

  return { meta, content: userTexts.join('\n'), assistantContent: assistantTexts.join('\n') };
}

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
        scanEntries.push({ meta: result.meta, content: result.content, assistantContent: result.assistantContent, scan });
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

function readMuseMeta(filePath: string): { meta: SessionMeta; content: string; assistantContent: string } | null {
  const sessionId = path.basename(path.dirname(filePath));
  if (!/^[0-9a-f-]{36}$/i.test(sessionId)) return null;

  let content: string;
  try {
    content = fs.readFileSync(filePath, 'utf-8');
  } catch {
    return null;
  }

  const userTexts: string[] = [];
  const assistantTexts: string[] = [];
  let topic: string | undefined;
  let firstUserMessage: string | undefined;
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
        if (!firstUserMessage) firstUserMessage = cleanFirstUserMessage(cmd.prompt.trim());
        if (!topic) topic = extractSessionTopic(cmd.prompt.trim());
      }
    }

    const event = payload?.event ?? payload;
    if (event?.kind === 'assistant_message_committed' && typeof event.text === 'string') {
      messageCount++;
      const text = event.text.trim();
      if (text) assistantTexts.push(text);
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
    firstUserMessage,
    messageCount: messageCount || undefined,
  };

  return { meta, content: userTexts.join('\n'), assistantContent: assistantTexts.join('\n') };
}

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


interface DroidSessionScan {
  sessionId?: string;
  timestamp?: string;
  cwd?: string;
  topic?: string;
  firstUserMessage?: string;
  model?: string;
  messageCount: number;
  durationMs?: number;
  lastActivity?: string;
  contentText?: string;
  assistantText?: string;
}

async function scanDroidIncremental(onProgress?: (p: ScanProgress) => void): Promise<void> {
  const currentVersion = await getCurrentAgentVersion('droid');

  const prestat: PreStatEntry[] = [];
  for (const sessionsDir of getAgentSessionDirs('droid', 'sessions')) {
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
        entries.push({ meta: result.meta, content: result.content, assistantContent: result.assistantContent, scan });
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

async function readDroidMeta(
  filePath: string,
  currentVersion?: string,
): Promise<{ meta: SessionMeta; content: string; assistantContent: string } | null> {
  const scan = await scanDroidSession(filePath);
  const sessionId = path.basename(filePath).replace(/\.jsonl$/, '') || scan.sessionId || '';
  if (!sessionId) return null;

  const settings = readDroidSettings(filePath.replace(/\.jsonl$/, '.settings.json'));
  const model = settings.model || scan.model;
  const tokenCount = settings.tokenCount;
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
    firstUserMessage: scan.firstUserMessage,
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
  return { meta, content: scan.contentText || '', assistantContent: scan.assistantText || '' };
}

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

async function scanDroidSession(filePath: string): Promise<DroidSessionScan> {
  const stream = fs.createReadStream(filePath, { encoding: 'utf-8' });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

  let sessionId: string | undefined;
  let timestamp: string | undefined;
  let cwd: string | undefined;
  let title: string | undefined;
  let sessionTitle: string | undefined;
  let firstUserTopic: string | undefined;
  let firstUserMessage: string | undefined;
  let model: string | undefined;
  let messageCount = 0;
  let firstTsMs: number | undefined;
  let lastTsMs: number | undefined;
  const userTexts: string[] = [];
  const assistantTexts: string[] = [];

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
        if (typeof parsed.sessionTitle === 'string' && parsed.sessionTitle.trim()) {
          sessionTitle = parsed.sessionTitle.trim();
        }
        if (typeof parsed.title === 'string' && parsed.title.trim()) {
          title = parsed.title.trim();
        }
        continue;
      }

      if (parsed.type !== 'message') continue;

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
        if (!firstUserMessage) firstUserMessage = cleanFirstUserMessage(text);
        if (!firstUserTopic) firstUserTopic = extractSessionTopic(text);
      } else if (msg.role === 'assistant') {
        assistantTexts.push(text);
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
    topic: sessionTitle || title || firstUserTopic,
    firstUserMessage,
    model,
    messageCount,
    durationMs,
    lastActivity: lastTsMs !== undefined ? new Date(lastTsMs).toISOString() : undefined,
    contentText: userTexts.length > 0 ? userTexts.join('\n') : undefined,
    assistantText: assistantTexts.length > 0 ? assistantTexts.join('\n') : undefined,
  };
}

function extractDroidMessageText(content: any): string {
  if (typeof content === 'string') return content.trim();
  if (!Array.isArray(content)) return '';
  return content
    .map((part: any) => (typeof part?.text === 'string' && part.type === 'text' ? part.text : ''))
    .filter((text: string) => text.trim() && !text.trim().startsWith('<system-reminder>'))
    .join('\n')
    .trim();
}

interface ClaudeParseState {
  timestamp?: string;
  cwd?: string;
  gitBranch?: string;
  version?: string;
  model?: string;
  topic?: string;
  firstUserMessage?: string;
  customTitle?: string;
  aiTitle?: string;
  entrypoint?: string;
  messageCount: number;
  toolCallCount: number;
  tokenCount: number;
  outputTokens: number;
  inputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  sawTokenCount: boolean;
  costUsd: number;
  costUsdNoCache: number;
  sawCost: boolean;
  firstTsMs?: number;
  lastTsMs?: number;
  seenAssistantIds: Set<string>;
  userTexts: string[];
  assistantTexts: string[];
  sawPrCreate: boolean;
  prUrl?: string;
  prNumber?: number;
  createdTickets: Set<string>;
  pendingTicketTools: Set<string>;
  spawnedTeam?: string;
  plan?: string;
  checklistEvents: SessionEvent[];
  recentDirectoriesTouched: string[];
  toolCollector: ToolCallCollector;
  skillEvents: SessionEvent[];
  slashCommandEvents: SessionEvent[];
  subAgents: number;
  backgroundShells: number | undefined;
}

export function initClaudeParseState(): ClaudeParseState {
  return {
    subAgents: 0,
    backgroundShells: 0,
    timestamp: undefined,
    cwd: undefined,
    gitBranch: undefined,
    version: undefined,
    model: undefined,
    topic: undefined,
    firstUserMessage: undefined,
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
    assistantTexts: [],
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
    subAgents?: number;
    backgroundShells?: number;
    cwd?: string;
  },
  event: SessionEvent,
): void {
  if (CHECKLIST_TOOLS.has(event.tool ?? '')) state.checklistEvents.push(event);
  if (isSkillInvocation(event)) state.skillEvents.push(event);
  if (state.subAgents !== undefined && isSubAgentTool(event.tool ?? '', event.command ?? '')) {
    state.subAgents += 1;
  }
  if (state.backgroundShells !== undefined && isBackgroundShellStart(event)) {
    state.backgroundShells += 1;
  }
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

export function applyClaudeLine(state: ClaudeParseState, parsed: any): void {
  collectClaudeToolCalls(state.toolCollector, parsed);
  if (!state.entrypoint && typeof parsed.entrypoint === 'string') {
    state.entrypoint = parsed.entrypoint;
  }

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
      if (!state.firstUserMessage) state.firstUserMessage = cleanFirstUserMessage(text);
      state.messageCount++;
      state.userTexts.push(text);
      if (!state.topic) state.topic = extractSessionTopic(text);
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

  const assistantText = extractClaudeAssistantText(parsed);
  if (assistantText) state.assistantTexts.push(assistantText);

  const usageObj = parsed.message?.usage || parsed.usage;
  const usage = getClaudeUsageTotal(usageObj);
  if (usage !== null) {
    state.tokenCount += usage;
    state.sawTokenCount = true;
  }
  if (typeof usageObj?.output_tokens === 'number') state.outputTokens += usageObj.output_tokens;
  if (usageObj && typeof usageObj === 'object') {
    if (typeof usageObj.input_tokens === 'number') state.inputTokens += usageObj.input_tokens;
    if (typeof usageObj.cache_read_input_tokens === 'number') state.cacheReadTokens += usageObj.cache_read_input_tokens;
    if (typeof usageObj.cache_creation_input_tokens === 'number') state.cacheWriteTokens += usageObj.cache_creation_input_tokens;
  }
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
      state.costUsdNoCache += costOfUsageNoCache(usageForCost);
      state.sawCost = true;
    }
  }
}

export function finalizeClaudeScan(state: ClaudeParseState, sessionFile?: string): ClaudeSessionScan {
  const durationMs =
    state.firstTsMs !== undefined && state.lastTsMs !== undefined && state.lastTsMs > state.firstTsMs
      ? state.lastTsMs - state.firstTsMs
      : undefined;

  const label = state.customTitle || cleanGeneratedSessionLabel(state.aiTitle);
  const worktree = detectWorktree(state.cwd, state.gitBranch);
  const ticket = detectTicket(state.userTexts.join('\n') || undefined, state.gitBranch);

  return {
    timestamp: state.timestamp,
    cwd: state.cwd,
    gitBranch: state.gitBranch,
    version: state.version,
    model: state.model,
    topic: state.topic,
    firstUserMessage: state.firstUserMessage,
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
    assistantText: state.assistantTexts.length > 0 ? state.assistantTexts.join('\n') : undefined,
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
    subAgentCount: resolvedSubAgentCount(sessionFile ? claudeSubagentFiles(sessionFile) : undefined, state.subAgents),
    backgroundShellCount: state.backgroundShells,
  };
}

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

  return finalizeClaudeScan(state, filePath);
}

export interface ClaudeParserState {
  v: 6;
  subAgents: number;
  backgroundShells: number | undefined;
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
  firstUserMessage?: string;
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
  assistantContentText?: string;
  checklistEvents: SessionEvent[];
  recentDirectoriesTouched: string[];
  toolCalls: ToolCallCollectorSnapshot;
  skillEvents: SessionEvent[];
  slashCommandEvents: SessionEvent[];
}

const SEEN_IDS_RECENT_CAP = 256;

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
    v: 6,
    subAgents: state.subAgents,
    backgroundShells: state.backgroundShells,
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
    firstUserMessage: state.firstUserMessage,
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
    ticketId: ticket?.id,
    contentText: state.userTexts.length > 0 ? state.userTexts.join('\n') : undefined,
    assistantContentText: state.assistantTexts.length > 0 ? state.assistantTexts.join('\n') : undefined,
    checklistEvents: state.checklistEvents,
    recentDirectoriesTouched: state.recentDirectoriesTouched,
    toolCalls: state.toolCollector.snapshot(),
    skillEvents: state.skillEvents,
    slashCommandEvents: state.slashCommandEvents,
  };
}

export function hydrateClaudeParseState(prior: ClaudeParserState): ClaudeParseState {
  const seen = new Set<string>(prior.seenIdsRecent);
  let pad = 0;
  while (seen.size < prior.seenIdsSize) {
    seen.add(` pad:${pad++}`);
  }
  return {
    subAgents: prior.subAgents,
    backgroundShells: prior.backgroundShells,
    timestamp: prior.timestamp,
    cwd: prior.cwd,
    gitBranch: prior.gitBranch,
    version: prior.version,
    model: prior.model,
    topic: prior.topic,
    firstUserMessage: prior.firstUserMessage,
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
    assistantTexts: prior.assistantContentText !== undefined && prior.assistantContentText.length > 0
      ? [prior.assistantContentText]
      : [],
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

export async function scanClaudeSessionIncremental(
  filePath: string,
  fromOffset: number,
  prior: ClaudeParserState,
): Promise<{ scan: ClaudeSessionScan; newState: ClaudeParserState; newOffset: number; toolCalls: IndexedToolCall[] }> {
  const state = hydrateClaudeParseState(prior);

  const append = await applyJsonlAppend(
    filePath,
    fromOffset,
    prior.jsonlDroppingOversizedLine === true,
    (parsed) => applyClaudeLine(state, parsed),
  );
  if (append.skippedOversizedLine) state.toolCollector.recordIndexLimit();

  const newOffset = fromOffset + append.consumedBytes;
  const scan = finalizeClaudeScan(state, filePath);
  const toolCalls = state.toolCollector.drainChanged();
  return {
    scan,
    newState: serializeClaudeParserState(state, newOffset, append.droppingOversizedLine),
    newOffset,
    toolCalls,
  };
}

function freshClaudeParserState(): ClaudeParserState {
  return serializeClaudeParserState(initClaudeParseState(), 0);
}

export async function scanClaudeSessionResumable(
  filePath: string,
  prior: ClaudeParserState | null,
  currentFileMtimeMs: number,
  currentFileSize: number,
  priorFileMtimeMs?: number,
): Promise<{ scan: ClaudeSessionScan; newState: ClaudeParserState; newOffset: number; toolCalls: IndexedToolCall[]; mode: 'full' | 'incremental' }> {
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

function parsePriorClaudeState(row: { parserState: string | null } | undefined): ClaudeParserState | null {
  if (!row?.parserState) return null;
  try {
    const parsed = JSON.parse(row.parserState) as ClaudeParserState;
    if (parsed?.v !== 6 || typeof parsed.offset !== 'number' || parsed.toolCalls?.v !== 1) return null;
    return parsed;
  } catch {
    return null;
  }
}

let claudeIncrementalScanCount = 0;
let claudeFullScanCount = 0;

export function __claudeScanBranchCountsForTest(): { incremental: number; full: number } {
  return { incremental: claudeIncrementalScanCount, full: claudeFullScanCount };
}

export function __resetClaudeScanBranchCountsForTest(): void {
  claudeIncrementalScanCount = 0;
  claudeFullScanCount = 0;
}

interface CodexParseState {
  sessionId?: string;
  timestamp?: string;
  cwd?: string;
  gitBranch?: string;
  version?: string;
  model?: string;
  topic?: string;
  firstUserMessage?: string;
  messageCount: number;
  tokenCount?: number;
  lastTotalTokenUsage?: any;
  firstTsMs?: number;
  lastTsMs?: number;
  userTexts: string[];
  assistantTexts: string[];
  sawPrCreate: boolean;
  prUrl?: string;
  prNumber?: number;
  createdTickets: Set<string>;
  pendingTicketTools: Set<string>;
  spawnedTeam?: string;
  checklistEvents: SessionEvent[];
  recentDirectoriesTouched: string[];
  toolCollector: ToolCallCollector;
  skillEvents: SessionEvent[];
  slashCommandEvents: SessionEvent[];
}

export function initCodexParseState(): CodexParseState {
  return {
    sessionId: undefined,
    timestamp: undefined,
    cwd: undefined,
    gitBranch: undefined,
    version: undefined,
    model: undefined,
    topic: undefined,
    firstUserMessage: undefined,
    messageCount: 0,
    tokenCount: undefined,
    lastTotalTokenUsage: undefined,
    firstTsMs: undefined,
    lastTsMs: undefined,
    userTexts: [],
    assistantTexts: [],
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

function applyCodexLine(state: CodexParseState, parsed: any): void {
  collectCodexToolCalls(state.toolCollector, parsed);
  if (parsed.type === 'response_item') {
    const p = parsed.payload || {};
    if (p.type === 'function_call') {
      let cmd = '';
      let args: Record<string, any> = {};
      try {
        args = typeof p.arguments === 'string' ? JSON.parse(p.arguments) : (p.arguments || {});
        cmd = String(args.command || args.cmd || '');
      } catch {  }
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

  if (typeof parsed.timestamp === 'string') {
    const ms = new Date(parsed.timestamp).getTime();
    if (!Number.isNaN(ms)) {
      if (state.firstTsMs === undefined || ms < state.firstTsMs) state.firstTsMs = ms;
      if (state.lastTsMs === undefined || ms > state.lastTsMs) state.lastTsMs = ms;
    }
  }

  if (parsed.type === 'session_meta') {
    const payload = parsed.payload || {};
    if (state.sessionId || typeof payload.id !== 'string' || !payload.id.trim()) return;
    state.sessionId = payload.id;
    state.timestamp = payload.timestamp || parsed.timestamp || state.timestamp;
    state.cwd = payload.cwd || state.cwd;
    state.gitBranch = payload.git?.branch || state.gitBranch;
    state.version = payload.cli_version || payload.version || state.version;
    state.model = payload.model || state.model;
    return;
  }

  if (parsed.type === 'turn_context') {
    const payload = parsed.payload || {};
    if (!state.model && typeof payload.model === 'string') state.model = payload.model;
    if (!state.cwd && typeof payload.cwd === 'string') state.cwd = payload.cwd;
    return;
  }

  if (parsed.type === 'response_item' && parsed.payload?.type === 'message') {
    const payloadRole = parsed.payload.role;
    const role = payloadRole === 'user' || payloadRole === 'developer'
      ? 'user'
      : 'assistant';
    const text = extractCodexMessageText(parsed.payload.content, role);
    if (!text) return;
    state.messageCount++;
    if (role === 'user') {
      const genuine = cleanFirstUserMessage(text);
      if (!genuine) return;
      state.userTexts.push(genuine);
      if (payloadRole === 'user' && !state.firstUserMessage) state.firstUserMessage = genuine;
      if (!state.topic) state.topic = extractSessionTopic(genuine);
    } else {
      state.assistantTexts.push(text);
    }
    return;
  }

  if (parsed.type === 'event_msg' && parsed.payload?.type === 'token_count') {
    const totalUsage = parsed.payload.info?.total_token_usage;
    const total = getCodexTokenCount(totalUsage);
    if (total !== null) state.tokenCount = total;
    if (totalUsage && typeof totalUsage === 'object') state.lastTotalTokenUsage = totalUsage;
    if (!state.model && typeof parsed.payload.info?.model === 'string') state.model = parsed.payload.info.model;
  }
}

function finalizeCodexScan(state: CodexParseState): CodexSessionScan {
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
    firstUserMessage: state.firstUserMessage,
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
    assistantText: state.assistantTexts.length > 0 ? state.assistantTexts.join('\n') : undefined,
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

export interface CodexParserState {
  v: 4;
  offset: number;
  jsonlDroppingOversizedLine?: boolean;
  sessionId?: string;
  timestamp?: string;
  cwd?: string;
  gitBranch?: string;
  version?: string;
  model?: string;
  topic?: string;
  firstUserMessage?: string;
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
  assistantContentText?: string;
  checklistEvents: SessionEvent[];
  recentDirectoriesTouched: string[];
  toolCalls: ToolCallCollectorSnapshot;
}

export function serializeCodexParserState(
  state: CodexParseState,
  offset: number,
  jsonlDroppingOversizedLine = false,
): CodexParserState {
  const ticket = detectTicket(state.userTexts.join('\n') || undefined, state.gitBranch);
  return {
    v: 4,
    offset,
    jsonlDroppingOversizedLine: jsonlDroppingOversizedLine || undefined,
    sessionId: state.sessionId,
    timestamp: state.timestamp,
    cwd: state.cwd,
    gitBranch: state.gitBranch,
    version: state.version,
    model: state.model,
    topic: state.topic,
    firstUserMessage: state.firstUserMessage,
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
    ticketId: ticket?.id,
    contentText: state.userTexts.length > 0 ? state.userTexts.join('\n') : undefined,
    assistantContentText: state.assistantTexts.length > 0 ? state.assistantTexts.join('\n') : undefined,
    checklistEvents: state.checklistEvents,
    recentDirectoriesTouched: state.recentDirectoriesTouched,
    toolCalls: state.toolCollector.snapshot(),
  };
}

function hydrateCodexParseState(prior: CodexParserState): CodexParseState {
  return {
    sessionId: prior.sessionId,
    timestamp: prior.timestamp,
    cwd: prior.cwd,
    gitBranch: prior.gitBranch,
    version: prior.version,
    model: prior.model,
    topic: prior.topic,
    firstUserMessage: prior.firstUserMessage,
    messageCount: prior.messageCount,
    tokenCount: prior.tokenCount,
    lastTotalTokenUsage: prior.lastTotalTokenUsage,
    firstTsMs: prior.firstTsMs,
    lastTsMs: prior.lastTsMs,
    userTexts: prior.contentText !== undefined && prior.contentText.length > 0 ? [prior.contentText] : [],
    assistantTexts: prior.assistantContentText !== undefined && prior.assistantContentText.length > 0
      ? [prior.assistantContentText]
      : [],
    sawPrCreate: prior.sawPrCreate,
    prUrl: prior.prUrl,
    prNumber: prior.prNumber,
    createdTickets: new Set<string>(prior.createdTickets),
    pendingTicketTools: new Set<string>(prior.pendingTicketTools),
    spawnedTeam: prior.spawnedTeam,
    checklistEvents: prior.checklistEvents ?? [],
    recentDirectoriesTouched: prior.recentDirectoriesTouched ?? [],
    toolCollector: new ToolCallCollector(prior.toolCalls),
    skillEvents: [],
    slashCommandEvents: [],
  };
}

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

function freshCodexParserState(): CodexParserState {
  return serializeCodexParserState(initCodexParseState(), 0);
}

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

export async function scanCodexSessionResumable(
  filePath: string,
  prior: CodexParserState | null,
  currentFileMtimeMs: number,
  currentFileSize: number,
  priorFileMtimeMs?: number,
): Promise<{ scan: CodexSessionScan; newState: CodexParserState; newOffset: number; toolCalls: IndexedToolCall[]; mode: 'full' | 'incremental' }> {
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

function parsePriorCodexState(row: { parserState: string | null } | undefined): CodexParserState | null {
  if (!row?.parserState) return null;
  try {
    const parsed = JSON.parse(row.parserState) as CodexParserState;
    if (parsed?.v !== 4 || typeof parsed.offset !== 'number' || parsed.toolCalls?.v !== 1) return null;
    return parsed;
  } catch {
    return null;
  }
}

let codexIncrementalScanCount = 0;
let codexFullScanCount = 0;

export function __codexScanBranchCountsForTest(): { incremental: number; full: number } {
  return { incremental: codexIncrementalScanCount, full: codexFullScanCount };
}

export function __resetCodexScanBranchCountsForTest(): void {
  codexIncrementalScanCount = 0;
  codexFullScanCount = 0;
}

function getOpenClawSessionCwd(agentId?: string): string {
  const workspace = agentId ? getOpenClawWorkspaceMap().get(agentId) : undefined;
  if (workspace) return workspace;

  const configDir = AGENTS.openclaw.configDir;
  return safeRealpathSync(configDir) || configDir;
}

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
  }

  cachedOpenClawWorkspaces = workspaces;
  return workspaces;
}


function sha256(input: string): string {
  return crypto.createHash('sha256').update(input).digest('hex');
}

function safeStatSync(p: string): fs.Stats | null {
  try {
    return fs.statSync(p);
  } catch {
    return null;
  }
}

function safeRealpathSync(p: string): string | null {
  try {
    return fs.realpathSync(p);
  } catch {
    return null;
  }
}

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

function isLocalCommandMessage(text: string): boolean {
  return /<local-command-caveat>|<bash-(input|stdout|stderr)>/i.test(text);
}

function extractClaudeAssistantText(parsed: any): string | undefined {
  const content = parsed.message?.content;
  if (typeof content === 'string') {
    const text = content.trim();
    return text && !text.startsWith('[Request interrupted') ? text : undefined;
  }
  if (!Array.isArray(content)) return undefined;

  const text = content
    .filter((block: any) => block.type === 'text')
    .map((block: any) => String(block.text || '').trim())
    .filter((value: string) => value && !value.startsWith('[Request interrupted'))
    .join('\n');

  return text || undefined;
}

function getClaudeUsageTotal(usage: any): number | null {
  if (!usage || typeof usage !== 'object') return null;
  return sumKnownNumbers([
    usage.input_tokens,
    usage.output_tokens,
    usage.cache_creation_input_tokens,
    usage.cache_read_input_tokens,
  ]);
}

function extractCodexMessageText(contentBlocks: any, role: 'user' | 'assistant'): string | undefined {
  if (!Array.isArray(contentBlocks)) return undefined;

  const matches = role === 'user'
    ? contentBlocks.filter((block: any) => block.type === 'input_text')
    : contentBlocks.filter((block: any) => block.type === 'output_text');

  const text = matches
    .map((block: any) => String(block.text || '').trim())
    .find((value: string) => !!value);

  return text || undefined;
}

function normalizeVersion(version?: string | null): string | undefined {
  const trimmed = version?.trim();
  return trimmed ? trimmed : undefined;
}

export function extractVersionFromManagedPath(agent: SessionAgentId, sourcePath?: string): string | undefined {
  if (!sourcePath) return undefined;

  const candidates = [sourcePath, safeRealpathSync(sourcePath) || ''];
  const markers = [`/.agents/versions/${agent}/`, `/.agents-system/versions/${agent}/`];
  if (agent === 'codex') markers.push('/.agents/.codex-homes/');

  for (const candidate of candidates) {
    if (!candidate) continue;
    const normalized = candidate.split(path.sep).join('/');
    for (const marker of markers) {
      const start = normalized.indexOf(marker);
      if (start === -1) continue;
      const version = normalized.slice(start + marker.length).split('/')[0];
      if (version && !(marker.endsWith('/.codex-homes/') && version.startsWith('a-'))) return version;
    }
  }

  return undefined;
}

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

function getCodexTokenCount(totalTokenUsage: any): number | null {
  if (!totalTokenUsage || typeof totalTokenUsage !== 'object') return null;
  return sumKnownNumbers([
    totalTokenUsage.input_tokens,
    totalTokenUsage.cached_input_tokens,
    totalTokenUsage.output_tokens,
    totalTokenUsage.reasoning_output_tokens,
  ]);
}

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
        entries.push({ meta: result.meta, content: result.content, assistantContent: result.assistantContent, scan, events: result.events });
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
    }
  }
  return undefined;
}

export function readCursorMeta(
  filePath: string,
  currentVersion?: string,
): { meta: SessionMeta; content: string; assistantContent: string; events: SessionEvent[] } | null {
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
  const assistantTexts = events
    .filter((event) => event.type === 'message' && event.role === 'assistant' && event.content)
    .map((event) => event.content!);
  const firstUserText = userTexts[0];
  const title = typeof chatMeta?.title === 'string'
    ? cleanGeneratedSessionLabel(chatMeta.title)
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

  return { meta, content: userTexts.join('\n'), assistantContent: assistantTexts.join('\n'), events };
}


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
  const stat = safeStatSync(filePath);
  const timestamp = updatedAt || createdAt
    || (stat ? stat.mtime.toISOString() : new Date().toISOString());

  const shortId = deriveShortId(sessionId, /^session_/);

  const workDirName = path.basename(path.dirname(sessionDir));
  let project: string | undefined;
  if (workDirName.startsWith('wd_')) {
    const parts = workDirName.slice(3).split('_');
    if (parts.length >= 2) {
      project = parts.slice(0, -1).join('/');
    }
  }

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
    firstUserMessage: newState.firstUserMessage,
    messageCount,
    tokenCount: tokenCount > 0 ? tokenCount : undefined,
    outputTokens: outputTokens > 0 ? outputTokens : undefined,
  };

  return { meta, content: lastPrompt || '', parserState: JSON.stringify(newState) };
}

export interface KimiParserState {
  v: 2;
  offset: number;
  messageCount: number;
  tokenCount: number;
  outputTokens: number;
  firstUserMessage?: string;
}

function kimiWireUserText(event: any): string | undefined {
  if (event?.type !== 'context.append_message' || event?.message?.role !== 'user') return undefined;
  const content = event.message.content;
  const raw = typeof content === 'string'
    ? content
    : Array.isArray(content)
      ? content.map((part: any) => typeof part === 'string' ? part : typeof part?.text === 'string' ? part.text : '').join('\n')
      : '';
  return cleanFirstUserMessage(raw);
}

function applyKimiWireEvent(
  acc: { messageCount: number; tokenCount: number; outputTokens: number; firstUserMessage?: string },
  event: any,
): void {
  if (event.type === 'context.append_message') {
    acc.messageCount++;
    if (!acc.firstUserMessage) acc.firstUserMessage = kimiWireUserText(event);
  } else if (event.type === 'usage.record' && event.usage) {
    const u = event.usage;
    acc.tokenCount += (u.inputOther || 0) + (u.output || 0) + (u.inputCacheRead || 0) + (u.inputCacheCreation || 0);
    acc.outputTokens += (u.output || 0);
  }
}

export function parseKimiWireMetricsIncremental(
  sessionDir: string,
  prior: KimiParserState | null,
): { messageCount: number; tokenCount: number; outputTokens: number; newState: KimiParserState } {
  const wirePath = path.join(sessionDir, 'agents', 'main', 'wire.jsonl');

  const stat = safeStatSync(wirePath);
  if (!stat) {
    return { messageCount: 0, tokenCount: 0, outputTokens: 0, newState: { v: 2, offset: 0, messageCount: 0, tokenCount: 0, outputTokens: 0 } };
  }

  const canIncrement = prior !== null && stat.size > prior.offset;
  const fromOffset = canIncrement ? prior!.offset : 0;
  const acc = canIncrement
    ? { messageCount: prior!.messageCount, tokenCount: prior!.tokenCount, outputTokens: prior!.outputTokens, firstUserMessage: prior!.firstUserMessage }
    : { messageCount: 0, tokenCount: 0, outputTokens: 0, firstUserMessage: undefined as string | undefined };

  let consumedBytes = 0;
  let fd: number | undefined;
  try {
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
      const lastNl = chunk.lastIndexOf(0x0a);
      consumedBytes = lastNl === -1 ? 0 : lastNl + 1;
      if (consumedBytes > 0) {
        for (const line of chunk.subarray(0, consumedBytes).toString('utf-8').split('\n')) {
          if (!line.trim()) continue;
          try {
            applyKimiWireEvent(acc, JSON.parse(line));
          } catch {
          }
        }
      }
    }
  } catch {
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch {  }
    }
  }

  return {
    messageCount: acc.messageCount,
    tokenCount: acc.tokenCount,
    outputTokens: acc.outputTokens,
    newState: { v: 2, offset: fromOffset + consumedBytes, messageCount: acc.messageCount, tokenCount: acc.tokenCount, outputTokens: acc.outputTokens, firstUserMessage: acc.firstUserMessage },
  };
}

function parsePriorKimiState(row: { parserState: string | null } | undefined): KimiParserState | null {
  if (!row?.parserState) return null;
  try {
    const parsed = JSON.parse(row.parserState) as KimiParserState;
    if (parsed?.v !== 2 || typeof parsed.offset !== 'number') return null;
    return parsed;
  } catch {
    return null;
  }
}

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

function readGrokFirstUserMessage(sessionDir: string, maxBytes = 262_144): string | undefined {
  const historyPath = path.join(sessionDir, 'chat_history.jsonl');
  let fd: number | undefined;
  try {
    const stat = safeStatSync(historyPath);
    if (!stat) return undefined;
    const bytesToRead = Math.min(maxBytes, stat.size);
    if (bytesToRead <= 0) return undefined;
    const buf = Buffer.allocUnsafe(bytesToRead);
    fd = fs.openSync(historyPath, 'r');
    let read = 0;
    while (read < bytesToRead) {
      const n = fs.readSync(fd, buf, read, bytesToRead - read, read);
      if (n <= 0) break;
      read += n;
    }
    const chunk = buf.subarray(0, read).toString('utf-8');
    const lastNl = chunk.lastIndexOf('\n');
    const complete = lastNl === -1 ? chunk : chunk.slice(0, lastNl);
    let firstGenuine: string | undefined;
    for (const line of complete.split('\n')) {
      if (!line.trim()) continue;
      let msg: any;
      try { msg = JSON.parse(line); } catch { continue; }
      if (msg?.type !== 'user') continue;
      if (msg.synthetic_reason) continue;
      const raw = msg.content;
      const text = typeof raw === 'string'
        ? raw
        : Array.isArray(raw)
          ? raw.map((p: any) => (typeof p?.text === 'string' ? p.text : '')).join('')
          : '';
      const genuine = cleanFirstUserMessage(text);
      if (!genuine) continue;
      if (msg.prompt_index != null) return genuine;
      if (!firstGenuine) firstGenuine = genuine;
    }
    return firstGenuine;
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) { try { fs.closeSync(fd); } catch {  } }
  }
}

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
  const sessionId =
    (typeof summary?.info?.id === 'string' && summary.info.id) || path.basename(sessionDir);
  if (!sessionId) return null;

  const cwd = normalizeCwd(typeof summary?.info?.cwd === 'string' ? summary.info.cwd : '');
  const topic =
    (typeof summary?.generated_title === 'string' && summary.generated_title.trim()) ||
    (typeof summary?.session_summary === 'string' && summary.session_summary.trim()) ||
    undefined;

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
    firstUserMessage: readGrokFirstUserMessage(sessionDir),
    messageCount,
  };

  return { meta, content: topic || '' };
}

export { parseTimeFilter } from './relative-time.js';
