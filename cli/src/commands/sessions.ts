import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawn } from 'child_process';
import { Option, type Command } from 'commander';
import chalk from 'chalk';
import { truncate, padRight, humanDuration, formatBytes } from '../lib/format.js';
import { sanitizeForTerminal } from '../lib/redact.js';
import { resolveProjectKey } from '../lib/project-key.js';
import { listProjectDefs, resolveProjectNameForCwd, type ProjectDef } from '../lib/projects.js';
import ora from 'ora';
import { interruptibleSpinner } from '../lib/spinner.js';
import type { SessionAgentId, SessionMeta, ViewMode } from '@phnx-labs/sessions-cli/reader';
import { SESSION_AGENTS, sessionDisplayAgent } from '@phnx-labs/sessions-cli/reader';
import { discoverArtifacts, readArtifact, resolveArtifact } from '@phnx-labs/sessions-cli/reader';
import { looksLikePath, toComparablePath } from '../lib/platform/index.js';
import { getActiveSessions, describeActiveDiscoveryHealth, sessionProcessIsLocal, backfillActiveRowsFromIndex, backfillActiveRowsFromMeta, isRunningLiveSession, serializeActiveSessionsForJson, serializeSessionsJson, type ActiveSession, type BackfillMeta } from '../lib/session/active.js';
export { activeSessionProjectKey, backfillActiveRowsFromIndex, backfillActiveRowsFromMeta, isRunningLiveSession, serializeActiveSessionsForJson, serializeSessionsJson, type BackfillMeta } from '../lib/session/active.js';
import { enumerateGhosttyTabs, assignGhosttyTabs, type GhosttySurface } from '../lib/session/ghostty-tabs.js';
import { mapPanesToTargets, listClients } from '../lib/tmux/session.js';
import { resolveViewingIn, viewingInLabel } from '../lib/session/viewing-in.js';
import { machineId, normalizeHost } from '../lib/session/sync/config.js';
import { gatherRemoteActive, NO_FANOUT_ENV } from '../lib/session/remote-active.js';
import { loadFleetActiveSessions } from '../lib/session/session-cache.js';
import { gatherRemoteList, runOnPeer, shouldIncludeLocal } from '../lib/session/remote-list.js';
import { stringWidth, truncateToWidth, padToWidth, terminalWidth } from '../lib/session/width.js';
import type { SessionActivity, AwaitingReason } from '@phnx-labs/sessions-cli/reader';
import { discoverSessions, countSessionsInScope, resolveSessionById, looksLikeSessionId, getSessionRoots, type DiscoverOptions, type ScanProgress } from '../lib/session/discover.js';
import { findSessionsById, querySessions, getSessionById } from '../lib/session/db.js';
import { sessionHeadline } from '../lib/session/title.js';
import {
  filterTeamSessions,
  shouldShowTeamSessions,
  safeTeamText,
  groupSessionsByTeam,
  NO_TEAM_GROUP_KEY,
  type TeamSessionGroup,
} from '@phnx-labs/sessions-cli/reader';
import { runRemoteSessions, buildForwardedArgs, ensureWholeIndex } from '../lib/session/remote.js';
import { formatRelativeTime, formatCompactAge, sessionAgeParts } from '../lib/session/relative-time.js';
import { shortenModel, formatTokenCount, type FilterOptions } from '@phnx-labs/sessions-cli/reader';
import { colorAgent } from '../lib/agents.js';
import { listJobs, listJobsWithRuns, listRuns, getRunDir, type RunMeta } from '../lib/scheduling/routines.js';
import { formatUsd } from '../lib/pricing/cost.js';
import { itemPicker } from '../lib/picker.js';
import { isInteractiveTerminal, isPromptCancelled } from './utils.js';
import {
  transcriptOnPeerOf,
  githubRepoUrlFromCwd,
  handlePickedSession,
  pickSessionInteractive,
} from './sessions-picker.js';
import { setHelpSections } from '../lib/help.js';
import {
  gatherActiveSessions,
  indexActiveBySessionId,
  requestedLiveStatuses,
  resolveRoutineName,
  runLiveRoster,
} from './ps-roster.js';
import {
  buildFilterOptions,
  cleanPreview,
  formatTeamHiddenFooter,
  formatTodoCompact,
  hasAnyFilter,
  liveGlyphAndPreview,
  liveStatusCell,
  metaSignals,
  notFoundByIdMessage,
  printSessionTable,
  renderSession,
  resolveViewMode,
  signalBadges,
  timeCell,
  treeSessionRow,
  type TranscriptRenderOptions,
} from '../lib/session/presentation.js';
import { buildResumeCommand } from '../lib/session/resume-command.js';
export {
  buildFilterOptions,
  renderSession,
  renderSessionLog,
  renderSessionLogJson,
  resolveViewMode,
  type TranscriptRenderOptions,
} from '../lib/session/presentation.js';
import {
  applyScopeFilters,
  computeLocalMetadataMatches,
  filterSessionsByQuery,
  fleetCandidatesByQuery,
  isDefinitiveMatch,
  matchesTeam,
  mergeLocalFirst,
  parseAgentFilter,
  parseInstalledAgentVersionQuery,
  resolveSessionMetadataValue,
  resolveSessionQuery,
  scopedContentIndex,
  selectorAllowsEarlyExit,
  serializeResolvedSessionsJson,
  type FleetResolveDeps,
  type FleetSessionCandidate,
  type LiveMetadataDeps,
  type SessionFilterOptions,
  type SessionSearchScope,
} from '../lib/session/selection.js';
import { registerSessionPreviewCommand, renderSessionPreview } from './ps.js';
import { registerSessionsResumeCommand } from './sessions-resume.js';
import { registerSessionsForkCommand } from './fork.js';
import { registerSessionsBookmarkCommand } from './sessions-bookmark.js';
import { listBookmarks } from '../lib/session/bookmarks.js';
import { registerFocusCommand } from './focus.js';
import { registerDetachCommand } from './detach.js';
import { registerSessionsStopCommand } from './sessions-stop.js';
import { registerSessionsInjectCommand } from './sessions-inject.js';
import { registerSessionsExportCommand } from './sessions-export.js';
import { registerSessionsRenderCommand } from './sessions-render.js';
import { registerSessionsTraceCommand } from './sessions-trace.js';
import { registerSessionsShareCommand } from './sessions-share.js';
import { registerSessionsImportCommand } from './sessions-import.js';
import { registerSessionsBackupSetupCommand } from './sessions-backup-setup.js';
import { registerSessionsMigrateCommand, registerSessionsMigrationsCommand } from './sessions-migrate.js';
import { registerSessionsBackfillCommand } from './sessions-backfill.js';
import { registerSessionsStatsCommand } from './sessions-stats.js';
import { registerSessionsInsightsCommand } from './insights.js';
import { registerSessionsOptimizeCommand } from './sessions-optimize.js';
import { registerSessionsWatchCommand } from './sessions-watch.js';

const SESSION_AGENT_FILTER_HELP = `Filter by agent, e.g. claude, codex, claude@2.0.65`;

function collectQueryClause(value: string, previous: string[]): string[] {
  return [...previous, value];
}


interface SessionsOptions extends SessionFilterOptions, TranscriptRenderOptions {
  unmanaged?: boolean;
  query?: string[];
  resolve?: string;
  // Versioned peer seam: older peers must reject rather than return unsafe fields.
  resolveSafeV1?: string;
  resolveLaunchId?: string;
  limit?: string;
  sort?: string;
  artifacts?: boolean;
  artifact?: string;
  active?: boolean;
  roots?: boolean;
  cloud?: boolean;
  host?: string[];
  tree?: boolean;
  flat?: boolean;
  waiting?: boolean;
  working?: boolean;
  idle?: boolean;
  orphan?: boolean;
  orphaned?: boolean;
  crashed?: boolean;
  closed?: boolean;
  abandoned?: boolean;
  queued?: boolean;
  unknown?: boolean;
  bookmarks?: boolean;
  live?: boolean;
  local?: boolean;
  device?: string[];
  devices?: string[];
  claude?: boolean;
  codex?: boolean;
  kimi?: boolean;
  antigravity?: boolean;
  grok?: boolean;
  opencode?: boolean;
  interactive?: boolean;
  printCmd?: boolean;
  preview?: boolean;
  skill?: string;
  plugin?: string;
}

const AGENT_SHORTHANDS = ['claude', 'codex', 'kimi', 'antigravity', 'grok', 'opencode'] as const;

function applyAgentShorthands(options: SessionsOptions): void {
  if (options.agent) return;
  const hit = AGENT_SHORTHANDS.find((name) => (options as Record<string, unknown>)[name] === true);
  if (hit) options.agent = hit;
}


function applyVersionFilters(query: string | undefined, options: SessionsOptions): string | undefined {
  const explicitVersion = options.version ?? options.sessionVersion;
  if (explicitVersion) {
    if (!options.agent) {
      throw new Error('--version requires --agent (for example: --agent claude --version 2.1.181).');
    }
    if (options.agent.includes('@')) {
      throw new Error('Pass the version either in --agent <agent@version> or with --version, not both.');
    }
    options.agent = `${options.agent}@${explicitVersion}`;
  }

  if (!options.agent) {
    const positionalFilter = parseInstalledAgentVersionQuery(query);
    if (positionalFilter) {
      options.agent = positionalFilter;
      return undefined;
    }
  }
  return query;
}

interface ClaudeHistoryEntry {
  sessionId: string;
  display?: string;
  project?: string;
  timestampMs?: number;
  historyPath: string;
}

interface ClaudeResumeMatch {
  session: SessionMeta;
  resumeTimestampMs: number;
  deltaMs: number;
}

const CLAUDE_RESUME_MATCH_WINDOW_MS = 10 * 60_000;

const LOAD_VERBS = ['Loading', 'Scanning', 'Gathering', 'Indexing', 'Reading'];
const FIND_VERBS = ['Finding', 'Searching', 'Locating', 'Matching'];

interface ProgressTracker {
  onProgress: (progress: ScanProgress) => void;
  stop: () => void;
}

function createScanProgressTracker(
  verbs: string[],
  suffix: string,
  spinner: ReturnType<typeof ora> | null,
): ProgressTracker {
  const counts = new Map<SessionAgentId, { parsed: number; total: number }>();
  let verbIndex = 0;

  const render = (): void => {
    if (!spinner) return;
    const verb = verbs[verbIndex % verbs.length];
    const parts: string[] = [];
    for (const agent of SESSION_AGENTS) {
      const c = counts.get(agent);
      if (!c || c.total === 0) continue;
      parts.push(`${agent} ${c.parsed}/${c.total}`);
    }
    const base = `${verb} ${suffix}...`;
    spinner.text = parts.length > 0 ? `${base} (${parts.join(' · ')})` : base;
  };

  const interval = spinner
    ? setInterval(() => {
        verbIndex++;
        render();
      }, 900)
    : null;

  render();

  return {
    onProgress: (progress: ScanProgress) => {
      counts.set(progress.agent, { parsed: progress.parsed, total: progress.total });
      render();
    },
    stop: () => {
      if (interval) clearInterval(interval);
    },
  };
}

const DEFAULT_LIMIT = '50';
const WHOLE_TEAM_POOL_LIMIT = 5000;
const OVERVIEW_ROWS_PER_PROJECT = 5;
const OVERVIEW_POOL_LIMIT = 1000;
const OVERVIEW_MAX_PROJECTS = 12;

function resolvePathFilter(query: string): string {
  const expanded = query.startsWith('~')
    ? path.join(os.homedir(), query.slice(1))
    : query;
  return path.resolve(expanded);
}

async function renderArtifactsForSession(
  session: SessionMeta,
  listAll: boolean,
  name?: string,
): Promise<void> {
  const artifacts = discoverArtifacts(session);

  if (name !== undefined) {
    const artifact = resolveArtifact(artifacts, name);
    if (!artifact) {
      console.error(chalk.red(`No artifact matching "${name}" in session ${session.shortId}.`));
      if (artifacts.length > 0) {
        console.error(chalk.gray('Available artifacts:'));
        for (const a of artifacts) {
          console.error(chalk.gray(`  ${a.path}`));
        }
      }
      process.exit(1);
    }
    if (!artifact.exists) {
      console.error(chalk.red(`Artifact exists in session history but the file is no longer on disk: ${artifact.path}`));
      process.exit(1);
    }
    process.stdout.write(readArtifact(artifact));
    return;
  }

  if (artifacts.length === 0) {
    console.log(chalk.gray('No file-write artifacts found in this session.'));
    return;
  }

  const shown = sessionDisplayAgent(session);
  const agentColor = colorAgent(shown);
  console.log('');
  console.log(
    agentColor(shown) +
    chalk.gray(` · ${session.shortId} · ${formatRelativeTime(session.timestamp)}`)
  );
  console.log(chalk.gray('─'.repeat(72)));

  for (const a of artifacts) {
    const exists = a.exists ? chalk.green('yes') : chalk.red('no');
    const size = a.exists && a.sizeBytes !== undefined ? chalk.cyan(formatBytes(a.sizeBytes)) : chalk.gray('-');
    const tool = chalk.yellow(padRight(a.tool, 10));
    const when = chalk.gray(formatRelativeTime(a.timestamp));
    const p = chalk.white(a.path);
    console.log(`  ${exists}  ${size.padEnd(10)}  ${tool}  ${when.padEnd(16)}  ${p}`);
  }

  console.log(chalk.gray(`\n${artifacts.length} artifact${artifacts.length !== 1 ? 's' : ''}.`));
}

function contextColor(context: ActiveSession['context']): (s: string) => string {
  switch (context) {
    case 'terminal': return chalk.magenta;
    case 'teams': return chalk.cyan;
    case 'cloud': return chalk.blue;
    case 'headless': return chalk.gray;
  }
}

function formatStartedAt(startedAtMs?: number): string {
  if (!startedAtMs) return '-';
  return formatRelativeTime(new Date(startedAtMs).toISOString());
}

interface SessionPickerJsonRow extends SessionMeta {
  state: ActiveSession['status'] | 'inactive';
  resumable: boolean;
  unwatched: boolean;
  viewingIn: string | null;
  sourceDevice: string;
  lastActivityMs: number;
  pid: number | null;
  recovery: { command: 'agents'; args: string[]; cwd?: string } | null;
}

export function serializeSessionPickerRows(
  sessions: SessionMeta[],
  liveSessions: ActiveSession[],
  self: string = machineId(),
): SessionPickerJsonRow[] {
  const liveById = new Map(liveSessions.filter((row) => row.sessionId).map((row) => [row.sessionId!, row]));
  return sessions.map((session) => {
    const live = liveById.get(session.id);
    const sourceDevice = live?.machine ?? session.machine ?? self;
    const viewingIn = live ? viewingInLabel(live) ?? null : null;
    const resumable = buildResumeCommand(session) !== null;
    return {
      ...session,
      state: live?.status ?? 'inactive',
      resumable,
      unwatched: !viewingIn,
      viewingIn,
      sourceDevice,
      lastActivityMs: live?.lastActivityMs ?? Date.parse(session.lastActivity ?? session.timestamp),
      pid: live?.pid ?? null,
      recovery: resumable
        ? { command: 'agents', args: ['sessions', 'resume', session.id, '--device', sourceDevice], ...(session.cwd ? { cwd: session.cwd } : {}) }
        : null,
    };
  });
}




async function runRemoteSessionsJson(hosts: string[]): Promise<void> {
  const forwarded = ensureWholeIndex(buildForwardedArgs(process.argv, new Set(hosts)));
  if (!forwarded.includes('--json')) forwarded.push('--json');
  const { sessions } = await gatherRemoteList(forwarded, hosts);
  process.stdout.write(serializeSessionsJson(sessions));
}

function useInteractiveBrowser(options: SessionsOptions): boolean {
  return options.interactive !== false && !options.json && isInteractiveTerminal();
}

function isBareBrowserListing(options: SessionsOptions, query: string | undefined): boolean {
  return (
    useInteractiveBrowser(options) &&
    process.env.AGENTS_SESSIONS_LOCAL !== '1' &&
    hasNoBrowserDisqualifyingFlags(options, query)
  );
}

export function hasNoBrowserDisqualifyingFlags(
  options: SessionsOptions,
  query: string | undefined
): boolean {
  return (
    !query &&
    (!options.teams || !!options.inTeam) &&
    !options.flat &&
    !options.tree &&
    !options.markdown &&
    !options.until &&
    !options.project &&
    !options.skill &&
    !options.plugin &&
    !options.sort &&
    !options.routine &&
    !options.artifacts &&
    options.artifact === undefined &&
    !options.cloud &&
    (options.host?.length ?? 0) <= 1
  );
}

export interface RoutineRunGroup {
  runId: string;
  timestamp: string;
  sessions: SessionMeta[];
}

interface RoutineChoice {
  name: string;
  lastRunAt: string;
  runCount: number;
  latestRunSessionCount: number;
}

export function buildRoutineRunGroups(sessions: SessionMeta[]): RoutineRunGroup[] {
  const byRun = new Map<string, SessionMeta[]>();
  for (const session of sessions) {
    const runId = session.routineRunId ?? session.timestamp;
    (byRun.get(runId) ?? byRun.set(runId, []).get(runId)!).push(session);
  }
  return [...byRun.entries()]
    .map(([runId, rows]) => ({
      runId,
      timestamp: rows.reduce(
        (latest, row) => (row.lastActivity ?? row.timestamp) > latest ? (row.lastActivity ?? row.timestamp) : latest,
        rows[0].lastActivity ?? rows[0].timestamp,
      ),
      sessions: rows.sort((a, b) => (a.timestamp < b.timestamp ? 1 : -1)),
    }))
    .sort((a, b) => (a.timestamp < b.timestamp ? 1 : a.timestamp > b.timestamp ? -1 : a.runId.localeCompare(b.runId)));
}

export function buildRoutineChoices(sessions: SessionMeta[], runOnlyNames: string[] = []): RoutineChoice[] {
  const byName = new Map<string, SessionMeta[]>();
  for (const session of sessions) {
    if (!session.routineName) continue;
    (byName.get(session.routineName) ?? byName.set(session.routineName, []).get(session.routineName)!).push(session);
  }
  const choices: RoutineChoice[] = [...byName.entries()]
    .map(([name, rows]) => {
      const runs = buildRoutineRunGroups(rows);
      return {
        name,
        lastRunAt: runs[0].timestamp,
        runCount: runs.length,
        latestRunSessionCount: runs[0].sessions.length,
      };
    });
  const seen = new Set(choices.map((c) => c.name));
  for (const name of runOnlyNames) {
    if (seen.has(name)) continue;
    const runs = listRuns(name);
    const latest = runs[runs.length - 1];
    choices.push({
      name,
      lastRunAt: latest?.startedAt ?? '',
      runCount: runs.length,
      latestRunSessionCount: 0,
    });
  }
  return choices.sort((a, b) => (a.lastRunAt < b.lastRunAt ? 1 : a.lastRunAt > b.lastRunAt ? -1 : a.name.localeCompare(b.name)));
}

async function selectRoutineName(sessions: SessionMeta[]): Promise<string | null> {
  const choices = buildRoutineChoices(sessions, safeListJobsWithRuns());
  const picked = await itemPicker<RoutineChoice>({
    message: 'Select a routine:',
    items: choices,
    filter: (query) => {
      const normalized = query.trim().toLowerCase();
      if (!normalized) return choices;
      return choices.filter((choice) => choice.name.toLowerCase().includes(normalized));
    },
    labelFor: (choice) => {
      const runs = `${choice.runCount} run${choice.runCount === 1 ? '' : 's'}`;
      const sessions = `${choice.latestRunSessionCount} session${choice.latestRunSessionCount === 1 ? '' : 's'} in latest`;
      const age = choice.lastRunAt ? ` · ${formatRelativeTime(choice.lastRunAt)}` : '';
      return `${choice.name}  ${chalk.gray(`${runs} · ${sessions}${age}`)}`;
    },
    shortIdFor: (choice) => choice.name,
    emptyMessage: 'No routines match.',
    enterHint: 'show sessions',
  });
  return picked?.item.name ?? null;
}

function safeListJobsWithRuns(): string[] {
  try {
    return [...new Set([...listJobs().map((job) => job.name), ...listJobsWithRuns()])];
  } catch { return []; }
}

async function selectRoutineTarget(
  sessions: SessionMeta[],
  routine: boolean | string,
  interactive: boolean,
): Promise<{ name: string | null } | null> {
  const routineNames = [...new Set([
    ...sessions.map((session) => session.routineName).filter((name): name is string => !!name),
    ...safeListJobsWithRuns(),
  ])].sort((a, b) => a.localeCompare(b));
  if (typeof routine === 'string') {
    const resolved = resolveRoutineName(routine, routineNames);
    if (!resolved) {
      console.error(chalk.red(`No routine matches "${routine}".`));
      if (routineNames.length > 0) console.error(chalk.gray(`Available routines: ${routineNames.join(', ')}`));
      process.exitCode = 1;
      return null;
    }
    return { name: resolved };
  }
  if (interactive) {
    const picked = await selectRoutineName(sessions);
    if (!picked) return null;
    return { name: picked };
  }
  return { name: null };
}

export async function filterSessionsByRoutine(
  sessions: SessionMeta[],
  routine: boolean | string,
  interactive: boolean,
): Promise<SessionMeta[] | null> {
  const target = await selectRoutineTarget(sessions, routine, interactive);
  if (!target) return null;
  return target.name
    ? sessions.filter((session) => session.routineName === target.name)
    : sessions;
}


type RoutineExecutionKind = 'agent' | 'command' | 'workflow';

export function executionKind(meta: RunMeta): RoutineExecutionKind {
  if (meta.workflow) return 'workflow';
  if (meta.agent) return 'agent';
  return 'command';
}

export interface RoutineRunEntry {
  meta: RunMeta;
  sessions: SessionMeta[];
}

export interface RoutineDrilldown {
  name: string;
  runs: RoutineRunEntry[];
  orphanSessions: RoutineRunGroup[];
  runRecordCount: number;
  linkedSessionCount: number;
  isAgentRoutine: boolean;
}

function buildRoutineDrilldown(name: string, sessions: SessionMeta[]): RoutineDrilldown {
  const runs = listRuns(name);
  const forRoutine = sessions.filter((s) => s.routineName === name);
  const byRun = new Map<string, SessionMeta[]>();
  for (const s of forRoutine) {
    const rid = s.routineRunId ?? s.timestamp;
    (byRun.get(rid) ?? byRun.set(rid, []).get(rid)!).push(s);
  }
  const runIds = new Set(runs.map((r) => r.runId));
  const entries: RoutineRunEntry[] = runs
    .map((meta) => ({
      meta,
      sessions: (byRun.get(meta.runId) ?? []).sort((a, b) => (a.timestamp < b.timestamp ? 1 : -1)),
    }))
    .sort((a, b) => {
      const at = a.meta.startedAt || a.meta.runId;
      const bt = b.meta.startedAt || b.meta.runId;
      return at < bt ? 1 : at > bt ? -1 : b.meta.runId.localeCompare(a.meta.runId);
    });
  const orphanSessions = buildRoutineRunGroups(
    forRoutine.filter((s) => !runIds.has(s.routineRunId ?? s.timestamp)),
  );
  return {
    name,
    runs: entries,
    orphanSessions,
    runRecordCount: runs.length,
    linkedSessionCount: forRoutine.length,
    isAgentRoutine: runs.some((r) => executionKind(r) !== 'command') || forRoutine.length > 0,
  };
}

function runStatusCell(status: RunMeta['status']): string {
  switch (status) {
    case 'completed': return `${chalk.green('✓')} ${chalk.green('completed')}`;
    case 'running': return `${chalk.cyan('◍')} ${chalk.cyan('running')}`;
    case 'failed': return `${chalk.red('✗')} ${chalk.red('failed')}`;
    case 'timeout': return `${chalk.red('✗')} ${chalk.red('timeout')}`;
    case 'blocked': return `${chalk.yellow('⚠')} ${chalk.yellow('blocked')}`;
    case 'skipped': return `${chalk.gray('↷')} ${chalk.gray('skipped')}`;
    case 'missed': return `${chalk.gray('·')} ${chalk.gray('missed')}`;
    default: return chalk.gray(status);
  }
}

function runPlacement(meta: RunMeta): string {
  if (meta.host) return `host:${meta.host}`;
  if (meta.cloudProvider) return `cloud:${meta.cloudProvider}`;
  return 'local';
}

function runTrigger(meta: RunMeta): string {
  const kind = meta.triggerKind ?? 'schedule';
  const who = meta.triggeredBy && !meta.triggeredBy.startsWith('UNRESOLVED') ? ` by ${meta.triggeredBy}` : '';
  return `${kind}${who}`;
}

function runOutcomeDetail(meta: RunMeta): string {
  if (meta.status === 'skipped' && meta.skipReason) {
    const ref = meta.activeRunId ? ` → ${meta.activeRunId}` : '';
    return `${meta.skipReason.replace(/_/g, ' ')}${ref}`;
  }
  if (meta.status === 'blocked') {
    return meta.readiness ? `${meta.readiness.code}: ${meta.readiness.message}` : (meta.errorMessage ?? 'not ready');
  }
  if (meta.status === 'missed') return 'daemon down at fire time';
  if (meta.errorMessage) return meta.errorMessage;
  if (typeof meta.exitCode === 'number' && meta.exitCode !== 0) return `exit ${meta.exitCode}`;
  return '';
}

function linkedSessionMeta(session: SessionMeta): string {
  const parts: string[] = [];
  const shown = sessionDisplayAgent(session);
  parts.push(session.version ? `${shown} v${session.version}` : shown);
  if (session.account) parts.push(session.account);
  if (session.model) parts.push(shortenModel(session.model));
  if (typeof session.outputTokens === 'number') parts.push(`${formatTokenCount(session.outputTokens)} out`);
  else if (typeof session.tokenCount === 'number') parts.push(`${formatTokenCount(session.tokenCount)} tok`);
  if (typeof session.costUsd === 'number' && session.costUsd > 0) parts.push(formatUsd(session.costUsd));
  if (typeof session.durationMs === 'number' && session.durationMs > 0) parts.push(humanDuration(session.durationMs));
  if (typeof session.toolCallCount === 'number') parts.push(`${session.toolCallCount} tools`);
  return chalk.gray('      ' + parts.join(' · '));
}

export function printRoutineDrilldown(
  drill: RoutineDrilldown,
  liveIndex?: Map<string, ActiveSession>,
  opts: { hiddenCount?: number; hiddenUnmanaged?: number } = {},
): void {
  const runWord = drill.runRecordCount === 1 ? 'run record' : 'run records';
  const sessWord = drill.linkedSessionCount === 1 ? 'linked session' : 'linked sessions';
  console.log(
    `${chalk.cyan.bold(drill.name)}  ` +
    chalk.gray(`${drill.runRecordCount} ${runWord} · ${drill.linkedSessionCount} ${sessWord}`),
  );
  if (!drill.isAgentRoutine) {
    console.log(chalk.gray('Command routine — runs execute a shell command; no agent session is produced.'));
  }
  console.log();

  if (drill.runs.length === 0 && drill.orphanSessions.length === 0) {
    console.log(chalk.gray('No run records yet for this routine.'));
    return;
  }

  for (const entry of drill.runs) {
    const m = entry.meta;
    console.log(
      `${chalk.cyan('▸')} ${chalk.cyan.bold(m.runId)}  ` +
      `${runStatusCell(m.status)}  ` +
      chalk.gray(`${runTrigger(m)} · ${formatRelativeTime(m.startedAt)}`),
    );
    const kind = executionKind(m);
    const detailParts: string[] = [kind];
    if (typeof m.duration === 'number' && m.duration > 0) detailParts.push(humanDuration(m.duration));
    detailParts.push(runPlacement(m));
    const outcome = runOutcomeDetail(m);
    if (outcome) detailParts.push(outcome);
    console.log(chalk.gray('    ' + detailParts.join(' · ')));
    const runDir = getRunDir(drill.name, m.runId);
    const logHints: string[] = [];
    if (fs.existsSync(path.join(runDir, 'stdout.log'))) logHints.push(`log: ${path.join(runDir, 'stdout.log')}`);
    if (fs.existsSync(path.join(runDir, 'report.md'))) logHints.push(`report: ${path.join(runDir, 'report.md')}`);
    if (logHints.length > 0) console.log(chalk.gray('    ' + logHints.join('  ·  ')));

    if (entry.sessions.length > 0) {
      for (const session of entry.sessions) {
        console.log(treeSessionRow(session, liveIndex?.get(session.id)));
        console.log(linkedSessionMeta(session));
      }
    } else if (kind !== 'command') {
      console.log(chalk.gray('      no agent session archived for this run'));
    }
    console.log();
  }

  if (drill.orphanSessions.length > 0) {
    console.log(chalk.gray('Sessions with no local run record (run archived on another host):'));
    for (const group of drill.orphanSessions) {
      console.log(
        `${chalk.cyan('▸')} ${chalk.cyan.bold(group.runId)}  ` +
        chalk.gray(`${group.sessions.length} session${group.sessions.length === 1 ? '' : 's'} · ${formatRelativeTime(group.timestamp)}`),
      );
      for (const session of group.sessions) {
        console.log(treeSessionRow(session, liveIndex?.get(session.id)));
        console.log(linkedSessionMeta(session));
      }
      console.log();
    }
  }

  console.log(chalk.gray(`Run history from .history/runs/${drill.name}/ · resume a session with agents sessions resume <id>.`));
  if (opts.hiddenCount && opts.hiddenCount > 0) console.log(chalk.gray(formatTeamHiddenFooter(opts.hiddenCount)));
  if (opts.hiddenUnmanaged && opts.hiddenUnmanaged > 0) console.log(chalk.gray(formatUnmanagedHiddenFooter(opts.hiddenUnmanaged)));
}

function canonicalSessionsCommand(query: string | undefined, options: SessionsOptions): string {
  const a = ['sessions'];
  if (options.active) a.push('--active');
  if (options.working) a.push('--working');
  if (options.idle) a.push('--idle');
  if (options.orphan || options.orphaned) a.push('--orphan');
  if (options.crashed) a.push('--crashed');
  if (options.closed) a.push('--closed');
  if (options.abandoned) a.push('--abandoned');
  if (options.queued) a.push('--queued');
  if (options.unknown) a.push('--unknown');
  if (options.teams) a.push('--teams');
  if (options.inTeam) a.push('--in-team', options.inTeam);
  if (options.routine) {
    a.push('--routine');
    if (typeof options.routine === 'string') a.push(options.routine);
  }
  if (options.agent) a.push('-a', options.agent);
  for (const h of options.host ?? []) a.push('--device', h);
  if (options.project) a.push('--project', options.project);
  if (options.skill) a.push('--skill', options.skill);
  if (options.plugin) a.push('--plugin', options.plugin);
  if (options.all) a.push('--all');
  if (options.since) a.push('--since', options.since);
  if (options.until) a.push('--until', options.until);
  if (options.local) a.push('--local');
  if (options.waiting) a.push('--waiting');
  if (options.bookmarks) a.push('--bookmarks');
  const q = (query ?? '').trim();
  if (q) a.push(JSON.stringify(q));
  return 'ag ' + a.join(' ');
}

async function sessionsAction(
  query: string | undefined,
  options: SessionsOptions,
  limitSource?: string
): Promise<void> {
  const liveStatuses = requestedLiveStatuses(options);
  const liveOnly = options.active === true || liveStatuses.length > 0;
  const includesOnlyTools = options.include?.split(',').map((role) => role.trim()).filter(Boolean).join(',') === 'tools';
  const readsOneSession = query !== undefined && looksLikeSessionId(query) && (options.query ?? []).length === 0;
  if (includesOnlyTools && !readsOneSession) {
    console.error(chalk.red('Tool-call search lives in the standalone sessions CLI:'));
    console.error(chalk.gray("  sessions --include tools --query 'program:git' [--count] [--host <device>] [--json]"));
    process.exitCode = 2;
    return;
  }
  const queryClauses = options.query ?? [];
  if (queryClauses.length > 1) {
    console.error(chalk.red('Pass --query once.'));
    process.exitCode = 1;
    return;
  }
  query = query ?? queryClauses[0];

  applyAgentShorthands(options);
  try {
    query = applyVersionFilters(query, options);
  } catch (error) {
    console.error(chalk.red(error instanceof Error ? error.message : String(error)));
    process.exitCode = 1;
    return;
  }
  const rawDeviceTargets = [...(options.device ?? []), ...(options.devices ?? [])];
  const fleetWide = rawDeviceTargets.some(t => t.toLowerCase() === 'all' || t.toLowerCase() === 'fleet');
  const deviceTargets = rawDeviceTargets
    .filter(t => t.toLowerCase() !== 'all' && t.toLowerCase() !== 'fleet');
  if (deviceTargets.length > 0) {
    options.host = [...(options.host ?? []), ...deviceTargets];
  }

  if (options.printCmd) {
    process.stdout.write(canonicalSessionsCommand(query, options) + '\n');
    return;
  }

  if (options.roots) {
    process.stdout.write(JSON.stringify(getSessionRoots(), null, 2) + '\n');
    return;
  }

  if (options.resolveLaunchId !== undefined) {
    if (!options.json) throw new Error('--resolve-launch-id requires --json.');
    const launchId = options.resolveLaunchId.trim();
    if (!launchId) throw new Error('--resolve-launch-id requires a non-empty launch id.');
    const { loadHookSessionIndex } = await import('../lib/session/hook-sessions.js');
    const record = loadHookSessionIndex().byLaunchId.get(launchId);
    process.stdout.write(JSON.stringify({ launchId, sessionId: record?.session_id ?? null }) + '\n');
    return;
  }

  if (options.resolve !== undefined || options.resolveSafeV1 !== undefined) {
    if (options.resolveSafeV1 !== undefined && process.env[NO_FANOUT_ENV] !== '1') {
      console.error(chalk.red('--resolve-safe-v1 is an internal fleet protocol.'));
      process.exit(1);
    }
    if (!options.json) {
      console.error(chalk.red('--resolve requires --json.'));
      process.exit(1);
    }
    const selector = (options.resolveSafeV1 ?? options.resolve ?? '').trim();
    if (!selector) {
      console.error(chalk.red('--resolve requires a non-empty selector.'));
      process.exit(1);
    }
    if (query) {
      console.error(chalk.red('Pass the selector to --resolve, not as a positional query.'));
      process.exit(1);
    }
    if (options.local === true && options.host && !shouldIncludeLocal(options.host, machineId())) {
      console.error(chalk.red('--local and --device name opposite scopes: --local skips the SSH fan-out that --device needs.'));
      process.exit(1);
    }
    await resolveSessionMetadata(selector, {
      agent: options.agent,
      project: options.project,
      local: options.local,
      hosts: options.host,
    });
    return;
  }

  if (options.host && options.host.length > 0 && !liveOnly) {
    if (options.local === true && !shouldIncludeLocal(options.host, machineId())) {
      console.error(
        chalk.red('--local and --device name opposite scopes: --local skips the SSH fan-out that --device needs.')
      );
      console.error(chalk.gray('Drop one — `--device <box>` to read that machine, `--local` to stay on this one.'));
      process.exit(1);
    }
    if (options.json) {
      await runRemoteSessionsJson(options.host);
      return;
    }
    if (!isBareBrowserListing(options, query)) {
      try {
        runRemoteSessions(options.host);
      } catch (err: any) {
        console.error(chalk.red(err.message));
        process.exit(1);
      }
      return;
    }
  }

  if (options.preview) {
    if (!query) {
      console.error(chalk.red('--preview requires a session id or query.'));
      process.exit(1);
    }
    await renderSessionPreview(query, { agent: options.agent, project: options.project, local: options.local, hosts: options.host });
    return;
  }

  if (liveOnly) {
    if (options.inTeam) {
      console.error(chalk.red('--in-team does not apply to --active: the running view carries no team lineage.'));
      console.error(chalk.gray('Drop --active to filter by team, or use `agents teams status <name>` for a live team.'));
      process.exit(1);
    }

    await runLiveRoster(options);
    return;
  }

  if (options.cloud) {
    const { runCloudTranscripts } = await import('./cloud-transcripts.js');
    await runCloudTranscripts(query, options);
    return;
  }

  if (isBareBrowserListing(options, query)) {
    const { runSessionBrowser, bareBrowserSeed } = await import('./sessions-browser.js');
    await runSessionBrowser(
      bareBrowserSeed({
        teams: options.teams,
        agent: options.agent,
        all: options.all,
        since: options.since,
        host: options.host,
        inTeam: options.inTeam,
        bookmarks: options.bookmarks,
        routine: options.routine,
      }),
      { local: options.local === true, hosts: options.host },
    );
    return;
  }

  let filterOpts: FilterOptions;
  try {
    filterOpts = buildFilterOptions(options);
  } catch (err: any) {
    console.error(chalk.red(err.message));
    process.exit(1);
  }

  const { agent, version } = parseAgentFilter(options.agent);

  let pathFilter: string | undefined;
  let searchQuery: string | undefined;
  if (query && looksLikePath(query)) {
    const resolved = resolvePathFilter(query);
    if (!fs.existsSync(resolved)) {
      console.log(chalk.yellow(`Path not found: ${resolved}`));
      console.log(chalk.gray('Did you mean to search? Use quotes: agents sessions "' + query + '"'));
      return;
    }
    pathFilter = fs.realpathSync(resolved);
  } else {
    searchQuery = query;
  }

  if ((options.artifacts || options.artifact !== undefined) && !query) {
    console.error(chalk.red('--artifacts and --artifact require a session ID or query.'));
    process.exit(1);
  }

  const mode = resolveViewMode(options, filterOpts);
  const wantsRender = mode === 'markdown' || hasAnyFilter(filterOpts);

  if ((options.artifacts || options.artifact !== undefined) && searchQuery) {
    await renderArtifactsGlobal(
      searchQuery,
      options.artifacts ?? false,
      options.artifact,
      artifactLookupScope(options.agent, options.project, options.routine),
    );
    return;
  }

  if (searchQuery && looksLikeSessionId(searchQuery)) {
    await renderOneSession(searchQuery, mode, { agent: options.agent, project: options.project, routine: options.routine, filter: filterOpts, redact: options.redact, local: options.local, hosts: options.host });
    return;
  }

  if (wantsRender && searchQuery) {
    await renderOneSession(searchQuery, mode, { agent: options.agent, project: options.project, routine: options.routine, filter: filterOpts, redact: options.redact, local: options.local, hosts: options.host });
    return;
  }

  const isInteractive = !options.json && isInteractiveTerminal();
  const wantsOverview = isInteractive && !searchQuery && !pathFilter && !options.flat && !options.tree;
  const wantsWholeTeam = !!options.inTeam;
  const wantsWholeRoutine = !!options.routine;
  const userSetLimit = limitSource === 'cli' || limitSource === 'env';
  const limit = wantsOverview
    ? OVERVIEW_POOL_LIMIT
    : parseInt(
        userSetLimit ? options.limit! : wantsWholeTeam || wantsWholeRoutine ? String(WHOLE_TEAM_POOL_LIMIT) : DEFAULT_LIMIT,
        10
      );
  const since = wantsOverview
    ? options.since
    : (options.since ?? (isInteractive && !options.all && !wantsWholeTeam && !wantsWholeRoutine ? '30d' : undefined));
  const spinner = options.json ? null : ora().start();
  const tracker = createScanProgressTracker(LOAD_VERBS, 'sessions', spinner);

  try {
    const sortBy: DiscoverOptions['sortBy'] =
      options.sort === 'cost' ? 'cost' : options.sort === 'duration' ? 'duration' : 'timestamp';

    const scope: DiscoverOptions = {
      agent,
      version,
      all: pathFilter ? undefined : options.all || wantsWholeTeam || wantsWholeRoutine,
      cwd: process.cwd(),
      cwdPrefix: pathFilter ?? (wantsOverview && !options.all && !wantsWholeTeam && !wantsWholeRoutine ? process.cwd() : undefined),
      project: options.project,
      since,
      until: options.until,
      sortBy,
      origin: options.routine ? 'routine' : undefined,
      skill: options.skill,
      plugin: options.plugin,
    };

    let hiddenUnmanaged = 0;
    let sessions: SessionMeta[] = await discoverSessions({
      ...scope,
      limit,
      excludeTeamOrigin: !shouldShowTeamSessions(options),
      onProgress: tracker.onProgress,
      includeUnmanaged: options.unmanaged,
      onHiddenUnmanaged: (n) => { hiddenUnmanaged = n; },
    });
    tracker.stop();
    spinner?.stop();

    const { visible: visibleSessions } = filterTeamSessions(sessions, shouldShowTeamSessions(options));
    sessions = visibleSessions;

    if (options.inTeam) sessions = sessions.filter((s) => matchesTeam(s, options.inTeam!));

    if (options.bookmarks) {
      const bookmarks = listBookmarks();
      sessions = sessions.filter((s) => bookmarks.has(s.id));
    }

    const hiddenCount = shouldShowTeamSessions(options) || options.inTeam
      ? 0
      : countSessionsInScope({ ...scope, onlyTeamOrigin: true });

    if (typeof options.routine === 'string') {
      const filteredByRoutine = await filterSessionsByRoutine(sessions, options.routine, false);
      if (!filteredByRoutine) return;
      sessions = filteredByRoutine;
    }

    const answeringJsonSweep = options.json === true && process.env[NO_FANOUT_ENV] === '1';
    if (searchQuery && !answeringJsonSweep) {
      const idMatches = resolveSessionById(sessions, searchQuery);
      if (idMatches.length === 1) {
        await renderSession(idMatches[0], mode, filterOpts, options);
        return;
      }
      if (idMatches.length === 0 && looksLikeSessionId(searchQuery)) {
        await renderOneSession(searchQuery, mode, { agent: options.agent, project: options.project, routine: options.routine, filter: filterOpts, redact: options.redact, local: options.local, hosts: options.host });
        return;
      }
    }

    if (options.json) {
      if (options.routine === true) {
        const filteredByRoutine = await filterSessionsByRoutine(sessions, options.routine, false);
        if (!filteredByRoutine) return;
        sessions = filteredByRoutine;
      }
      let filtered = searchQuery
        ? resolveSessionQuery(sessions, searchQuery, {
            scope: { agent: options.agent, project: options.project, routine: options.routine },
          }).matches
        : sessions;
      const forceLocalJson = options.local === true || process.env[NO_FANOUT_ENV] === '1';
      if (fleetWide && !forceLocalJson) {
        const forwarded = ensureWholeIndex(buildForwardedArgs(process.argv, new Set(options.host ?? [])));
        if (!forwarded.includes('--json')) forwarded.push('--json');
        const fanSpinner = isInteractiveTerminal() ? interruptibleSpinner('Reaching other machines...').start() : null;
        try {
          const { sessions: remoteSessions } = await gatherRemoteList(forwarded, undefined);
          if (remoteSessions.length > 0) {
            filtered = mergeLocalFirst([...filtered, ...remoteSessions], machineId());
          }
        } catch {
        } finally {
          fanSpinner?.stop();
        }
      }
      const live = await gatherActiveSessions({
        local: forceLocalJson,
        hosts: options.host,
      });
      process.stdout.write(serializeSessionsJson(serializeSessionPickerRows(filtered, live.sessions)));
      return;
    }

    const forceLocal = options.local === true || process.env[NO_FANOUT_ENV] === '1';
    if (!forceLocal) {
      const forwarded = buildForwardedArgs(process.argv, new Set(options.host ?? []));
      if (!forwarded.includes('--json')) forwarded.push('--json');
      const fanSpinner = isInteractiveTerminal() ? interruptibleSpinner('Reaching other machines...').start() : null;
      try {
        const { sessions: remoteSessions } = await gatherRemoteList(forwarded, options.host);
        if (remoteSessions.length > 0) {
          sessions = mergeLocalFirst([...sessions, ...remoteSessions], machineId());
        }
      } catch {
      } finally {
        fanSpinner?.stop();
      }
    }

    if (options.routine) {
      const target = await selectRoutineTarget(sessions, options.routine, isInteractive);
      if (!target) return;
      if (target.name) {
        sessions = sessions.filter((s) => s.routineName === target.name);
        if (!searchQuery && !options.flat && !options.tree) {
          const liveIndex = await maybeLiveIndex(options);
          printRoutineDrilldown(buildRoutineDrilldown(target.name, sessions), liveIndex, { hiddenCount, hiddenUnmanaged });
          return;
        }
      }
    }

    if (sessions.length === 0) {
      if (pathFilter) {
        console.log(chalk.gray(`No sessions found for ${pathFilter}.`));
      } else if (options.routine) {
        console.log(chalk.gray('No indexed agent sessions for this routine. Drop --flat/--tree to see its run history.'));
      } else {
        console.log(chalk.gray(formatNoSessionsMessage(options.all, options.project)));
      }
      if (hiddenCount > 0) {
        console.log(chalk.gray(formatTeamHiddenFooter(hiddenCount)));
      }
      if (hiddenUnmanaged > 0) {
        console.log(chalk.gray(formatUnmanagedHiddenFooter(hiddenUnmanaged)));
      }
      return;
    }

    if (options.teams && !options.flat && !options.tree && !searchQuery && !pathFilter) {
      const liveIndex = await maybeLiveIndex(options);
      printTeamsView(sessions, liveIndex, hiddenUnmanaged);
      return;
    }

    if (wantsOverview) {
      const liveIndex = await maybeLiveIndex(options);
      printSessionOverview(sessions, hiddenCount, liveIndex, { perProjectCap: OVERVIEW_ROWS_PER_PROJECT, expand: !!options.all, hiddenUnmanaged });
      return;
    }

    if (isInteractiveTerminal() && !options.tree && !options.flat) {
      const message = pathFilter
        ? `Search sessions (${path.basename(pathFilter)}):`
        : formatSearchMessage(options);
      const picked = await pickSessionInteractive(
        sessions,
        message,
        searchQuery,
        hiddenCount,
        undefined,
        { agent: options.agent, project: options.project, routine: options.routine },
      );
      if (picked) {
        await handlePickedSession(picked);
        return;
      }
      return;
    }

    const filtered = searchQuery
      ? filterSessionsByQuery(sessions, searchQuery, {
          agent: options.agent,
          project: options.project,
          routine: options.routine,
        })
      : sessions;
    const liveIndex = await maybeLiveIndex(options);
    printSessionTable(filtered, hiddenCount, options.tree === true, liveIndex);
    if (hiddenUnmanaged > 0) console.log(chalk.gray(formatUnmanagedHiddenFooter(hiddenUnmanaged)));
  } catch (err: any) {
    tracker.stop();
    spinner?.stop();
    console.error(chalk.red(`Failed to discover sessions: ${err.message}`));
    process.exit(1);
  }
}

export async function maybeLiveIndex(options: SessionsOptions): Promise<Map<string, ActiveSession> | undefined> {
  if (options.live === false || options.json) return undefined;
  try {
    return indexActiveBySessionId(await getActiveSessions({ localOnly: options.local === true }));
  } catch {
    return undefined;
  }
}

export function overviewProjectKey(s: Pick<SessionMeta, 'project' | 'cwd'>, defs?: ProjectDef[]): string {
  const resolved = defs?.length ? resolveProjectNameForCwd(s.cwd, defs) : resolveProjectKey(s.cwd);
  if (resolved) return resolved;
  if (s.project && s.project.trim()) return s.project.trim();
  return '(no project)';
}

interface OverviewGroup {
  key: string;
  total: number;
  shown: SessionMeta[];
  more: number;
  maxTs: string;
}

export function buildOverviewGroups(
  pool: SessionMeta[],
  perProjectCap: number,
  defs?: ProjectDef[],
): { groups: OverviewGroup[]; projectCount: number } {
  const byKey = new Map<string, SessionMeta[]>();
  for (const s of pool) {
    const k = overviewProjectKey(s, defs);
    (byKey.get(k) ?? byKey.set(k, []).get(k)!).push(s);
  }
  const cap = Math.max(1, perProjectCap);
  const groups: OverviewGroup[] = [];
  for (const [key, rows] of byKey) {
    const shown = rows.slice(0, cap);
    groups.push({ key, total: rows.length, shown, more: rows.length - shown.length, maxTs: rows[0].lastActivity ?? rows[0].timestamp });
  }
  groups.sort((a, b) => (a.maxTs < b.maxTs ? 1 : a.maxTs > b.maxTs ? -1 : a.key.localeCompare(b.key)));
  return { groups, projectCount: byKey.size };
}

function printSessionOverview(
  pool: SessionMeta[],
  hiddenCount: number,
  liveIndex: Map<string, ActiveSession> | undefined,
  opts: { perProjectCap: number; expand: boolean; hiddenUnmanaged?: number },
): void {
  const { groups } = buildOverviewGroups(pool, opts.expand ? Infinity : opts.perProjectCap, listProjectDefs());
  const shownGroups = opts.expand ? groups : groups.slice(0, OVERVIEW_MAX_PROJECTS);
  const hiddenProjects = groups.length - shownGroups.length;

  const total = pool.length;
  const projWord = groups.length === 1 ? 'project' : 'projects';
  console.log(chalk.gray(`${total} session${total === 1 ? '' : 's'} · ${groups.length} ${projWord} · recent activity\n`));

  let first = true;
  for (const g of shownGroups) {
    if (!first) console.log();
    first = false;
    const { glyph } = liveGlyphAndPreview(liveIndex?.get(g.shown[0].id));
    const head =
      `${chalk.cyan('▸')} ${chalk.cyan.bold(g.key)}  ${chalk.gray(String(g.total))}` +
      `${glyph ? '  ' + glyph : ''} ${chalk.gray(formatRelativeTime(g.maxTs))}`;
    console.log(head);
    for (const s of g.shown) console.log(treeSessionRow(s, liveIndex?.get(s.id)));
    if (g.more > 0) console.log('  ' + chalk.gray(`· ${g.more} more`));
  }

  console.log();
  const parts = [chalk.gray('newest first (by last activity)')];
  if (hiddenProjects > 0) parts.push(chalk.gray(`+${hiddenProjects} more project${hiddenProjects === 1 ? '' : 's'}`));
  parts.push(chalk.gray('agents sessions --all spans every project on disk · <project> to drill in · --flat for the plain list'));
  console.log(parts.join(chalk.gray('  ·  ')));
  if (hiddenCount > 0) console.log(chalk.gray(formatTeamHiddenFooter(hiddenCount)));
  if (opts.hiddenUnmanaged) console.log(chalk.gray(formatUnmanagedHiddenFooter(opts.hiddenUnmanaged)));
}

const TEAM_MODE_W = 5;
const TEAM_HANDLE_W = 16;

function teamMemberRow(session: SessionMeta, live?: ActiveSession): string {
  const shown = sessionDisplayAgent(session);
  const agentColor = colorAgent(shown);
  const origin = session.teamOrigin;
  const age = sessionAgeParts(session.timestamp, session.lastActivity);
  const handle = safeTeamText(origin?.handle) ?? session.shortId;
  const mode = safeTeamText(origin?.mode) ?? '';
  const { glyph, preview } = liveGlyphAndPreview(live);
  const restingTodo = !live ? formatTodoCompact(session.todos) : '';
  const doing = [restingTodo, preview || session.topic || ''].filter(Boolean).join(' · ');
  const shownHandle = truncateToWidth(handle, TEAM_HANDLE_W);
  const head = doing ? `${shownHandle} · ${doing}` : shownHandle;
  const badges = signalBadges(metaSignals(session));
  const badgeW = badges ? stringWidth(badges) + 1 : 0;
  const { cell: statusCell, width: statusW } = liveStatusCell(live);
  const glyphW = glyph ? 2 : 0;
  const baseTopicW =
    terminalWidth() - (2 + 9 + 8 + (TEAM_MODE_W + 1)) - glyphW - statusW - badgeW - stringWidth(age.last) - 1;
  const when = timeCell(age, baseTopicW);
  const topicW = Math.max(12, baseTopicW - when.extraW);
  return (
    '  ' +
    chalk.dim(padToWidth(session.shortId, 9)) +
    agentColor(padToWidth(truncateToWidth(shown, 7), 8)) +
    chalk.yellow(padToWidth(truncateToWidth(mode || '-', TEAM_MODE_W), TEAM_MODE_W + 1)) +
    (badges ? badges + ' ' : '') +
    (glyph ? glyph + ' ' : '') +
    statusCell +
    padToWidth(chalk.white(truncateToWidth(head, topicW)), topicW) +
    ' ' +
    when.text
  );
}

function teamGroupHeader(g: TeamSessionGroup, glyph: string, labelById: Map<string, string>): string {
  const count = chalk.gray(`(${g.sessions.length})`);
  if (g.kind === 'noTeam') {
    return (
      chalk.magenta('▸') + ' ' + chalk.magenta.bold(NO_TEAM_GROUP_KEY) + '  ' + count +
      '  ' + chalk.gray('team-flagged spawns with no team record (`agents run`, or aged-out teammates)')
    );
  }
  const bits = [chalk.cyan('▸') + ' ' + chalk.cyan.bold(g.key), count];
  if (glyph) bits.push(glyph);
  if (g.spawnerSessionId) {
    const who = labelById.get(g.spawnerSessionId) ?? g.spawnerSessionId.slice(0, 8);
    bits.push(chalk.gray(`by ${who}`));
  }
  bits.push(chalk.gray(`spawned ${formatRelativeTime(g.firstSpawnTs)}`));
  return bits.join('  ');
}

function printTeamsView(
  pool: SessionMeta[],
  liveIndex: Map<string, ActiveSession> | undefined,
  hiddenUnmanaged = 0,
): void {
  const groups = groupSessionsByTeam(pool);
  if (groups.length === 0) {
    console.log(chalk.gray('No team sessions found.'));
    console.log(chalk.gray('Team sessions are spawned by `agents teams` — see `agents teams status`.'));
    return;
  }

  const labelById = new Map<string, string>();
  for (const s of pool) {
    const label = sessionHeadline(s);
    if (label) labelById.set(s.id, cleanPreview(label));
  }

  const total = groups.reduce((n, g) => n + g.sessions.length, 0);
  const teamCount = groups.filter((g) => g.kind === 'team').length;
  const noTeam = groups.find((g) => g.kind === 'noTeam');
  const parts = [
    `${total} team session${total === 1 ? '' : 's'}`,
    `${teamCount} team${teamCount === 1 ? '' : 's'}`,
  ];
  if (noTeam) parts.push(`${noTeam.sessions.length} without a team record`);
  console.log(chalk.gray(parts.join(' · ') + '\n'));

  let first = true;
  for (const g of groups) {
    if (!first) console.log();
    first = false;
    const { glyph } = liveGlyphAndPreview(liveIndex?.get(g.sessions[0].id));
    console.log(teamGroupHeader(g, glyph, labelById));
    for (const s of g.sessions) console.log(teamMemberRow(s, liveIndex?.get(s.id)));
  }

  console.log();
  console.log(chalk.gray('newest-active team first · resume any row with `agents sessions resume <id>`'));
  if (hiddenUnmanaged > 0) console.log(chalk.gray(formatUnmanagedHiddenFooter(hiddenUnmanaged)));
}

function formatSearchMessage(options: SessionFilterOptions): string {
  const filters: string[] = [];
  if (options.agent) filters.push(`agent: ${options.agent}`);
  if (options.project?.trim()) filters.push(`project: ${options.project.trim()}`);
  if (filters.length === 0) return 'Search sessions:';
  return `Search sessions (${filters.join(', ')}):`;
}


function ambiguityHint(byId: boolean, completeId: boolean): string {
  if (completeId) return 'That is already a complete id — these rows share it as a prefix.';
  return byId
    ? 'Pass a longer ID to narrow it down.'
    : 'That matched on text, not an id. Pass a session id, or narrow the search.';
}

export function fleetNotFoundMessage(query: string, deviceCount: number, unreachable: string[]): string[] {
  const id = query.trim();
  if (deviceCount === 0) {
    return [
      chalk.red(`No session with id ${id} on this machine.`),
      chalk.gray('No other reachable devices to search.'),
    ];
  }
  const searched = `${deviceCount} device${deviceCount === 1 ? '' : 's'}`;
  const lines = [chalk.red(`No session with id ${id} on this machine or ${searched} searched.`)];
  if (unreachable.length > 0) {
    lines.push(chalk.gray(`Unreachable (not searched): ${unreachable.join(', ')}`));
  }
  return lines;
}


export function artifactLookupScope(
  agent?: string,
  project?: string,
  routine?: boolean | string,
): SessionSearchScope {
  return { agent, project, routine };
}

async function renderArtifactsGlobal(
  query: string,
  listAll: boolean,
  name: string | undefined,
  scope: { agent?: string; project?: string; routine?: boolean | string },
): Promise<void> {
  const spinner = ora().start();
  const tracker = createScanProgressTracker(FIND_VERBS, 'session', spinner);

  try {
    const discovered = await discoverSessions({
      all: true,
      cwd: process.cwd(),
      limit: 5000,
      onProgress: tracker.onProgress,
    });
    tracker.stop();

    const allSessions = applyScopeFilters(discovered, scope);
    const { matches: queryMatches, byId, completeId } = resolveSessionQuery(allSessions, query, { scope });

    if (queryMatches.length === 0) {
      spinner.stop();
      if (byId) notFoundByIdMessage(query).forEach(l => console.error(l));
      else console.error(chalk.red(`No session found matching: ${query}`));
      process.exit(1);
    }
    if (queryMatches.length > 1) {
      spinner.stop();
      console.error(chalk.red(`Multiple sessions match "${query}":`));
      for (const m of queryMatches.slice(0, 10)) {
        console.error(chalk.cyan(`  ${m.shortId}  ${m.id}  ${sessionHeadline(m) ?? ''}`));
      }
      console.error(chalk.gray(ambiguityHint(byId, completeId)));
      process.exit(1);
    }

    spinner.stop();
    await renderArtifactsForSession(queryMatches[0], listAll, name);
  } catch (err: any) {
    if (isPromptCancelled(err)) return;
    tracker.stop();
    spinner.stop();
    console.error(chalk.red(`Failed to read session: ${err.message}`));
    process.exit(1);
  }
}

async function renderOneSession(
  query: string,
  mode: ViewMode,
  scope: { agent?: string; project?: string; routine?: boolean | string; filter: FilterOptions; redact?: boolean; local?: boolean; hosts?: string[] },
): Promise<void> {
  if (looksLikeSessionId(query)) {
    const outcome = await resolveSessionMetadataValue(query, scope);
    if (outcome.kind === 'partial') {
      const offline = outcome.failedPeers;
      console.error(chalk.yellow(`Warning: ${offline.length} device(s) unreachable, not checked: ${offline.join(', ')}`));
      console.error(chalk.red(`No session matching "${query}" on any reachable device (${offline.length} unreachable, not checked).`));
      console.error(chalk.gray('  If it lives on an offline box, wake it (agents devices) or run there: agents ssh <device>'));
      process.exit(1);
    }
    if (outcome.kind === 'ambiguous') {
      console.error(chalk.red(`Multiple sessions match "${query}" across the fleet:`));
      for (const candidate of outcome.candidates) {
        const match = candidate.hits[0].session;
        const machines = candidate.hits.map(hit => hit.machine).join(', ');
        console.error(chalk.cyan(`  ${match.shortId}  ${match.id}`) + chalk.gray(`  ${machines}  ${match.agent}${match.version ? ` ${match.version}` : ''}`));
      }
      console.error(chalk.gray('Pass the full session ID to narrow it down.'));
      process.exit(1);
    }

    if (outcome.kind === 'resolved') {
      const resolved = outcome.session;
      const transcriptPeer = transcriptOnPeerOf(resolved);
      if (transcriptPeer) {
        const args = ['sessions', resolved.id, '--local'];
        const flag = modeFlag(mode);
        if (flag) args.push(flag);
        if (scope.filter.include?.length) args.push('--include', scope.filter.include.join(','));
        if (scope.filter.exclude?.length) args.push('--exclude', scope.filter.exclude.join(','));
        if (scope.filter.first !== undefined) args.push('--first', String(scope.filter.first));
        if (scope.filter.last !== undefined) args.push('--last', String(scope.filter.last));
        if (scope.redact === false) args.push('--no-redact');
        const rendered = await runOnPeer(args, transcriptPeer);
        if (rendered === 'no-target') {
          console.error(chalk.red(`Session ${resolved.id} is on ${transcriptPeer}, but that device is not reachable.`));
          process.exit(1);
        }
        return;
      }

      await renderSession(resolved, mode, scope.filter, { redact: scope.redact });
      return;
    }
  }

  const spinner = ora().start();
  const tracker = createScanProgressTracker(FIND_VERBS, 'session', spinner);

  try {
    const discovered = await discoverSessions({
      all: true,
      cwd: process.cwd(),
      limit: 5000,
      onProgress: tracker.onProgress,
    });
    tracker.stop();

    const allSessions = applyScopeFilters(discovered, scope);
    let session: SessionMeta | undefined;

    const resolution = resolveSessionQuery(allSessions, query, { scope });
    let queryMatches: SessionMeta[] = resolution.matches;
    let byId = resolution.byId;
    const completeId = resolution.completeId;

    if (queryMatches.length === 0 && !looksLikeSessionId(query)) {
      const contentResults = scopedContentIndex(allSessions, query, scope);
      if (contentResults.size > 0) {
        const matchedSessions = Array.from(contentResults.values())
          .sort((a, b) => (b._bm25Score ?? 0) - (a._bm25Score ?? 0));
        byId = false;
        if (matchedSessions.length === 1) {
          session = matchedSessions[0];
        } else {
          queryMatches = matchedSessions;
        }
      }
    }

    if (queryMatches.length === 0 && !session) {
      spinner.stop();
      const historyEntry = findClaudeHistoryEntry(query);
      if (historyEntry) {
        const resumeMatch = resolveClaudeHistoryEntryToTranscript(historyEntry, allSessions);
        if (resumeMatch) {
          session = resumeMatch.session;
        } else {
          renderClaudeHistoryOnlyId(query, historyEntry, allSessions);
          process.exit(1);
        }
      } else if (byId) {
        if (shouldFanOutForId(query, scope.local)) {
          const outcome = await resolveSessionAcrossFleet(query, mode, scope.hosts);
          if (outcome.kind === 'rendered') return;
          if (outcome.kind === 'conflict') process.exit(1);
          fleetNotFoundMessage(query, outcome.deviceCount, outcome.unreachable).forEach(l => console.error(l));
          process.exit(1);
        }
        notFoundByIdMessage(query).forEach(l => console.error(l));
        process.exit(1);
      } else {
        console.error(chalk.red(`No session found matching: ${query}`));
        console.error(chalk.gray('Run "agents sessions" to browse sessions.'));
        process.exit(1);
      }
    }

    if (!session) {
      if (queryMatches.length > 1) {
        spinner.stop();
        console.error(chalk.red(`Multiple sessions match "${query}":`));
        for (const match of queryMatches.slice(0, 10)) {
          console.error(chalk.cyan(`  ${match.shortId}  ${match.id}  ${sessionHeadline(match) ?? ''}`));
        }
        console.error(chalk.gray(ambiguityHint(byId, completeId)));
        process.exit(1);
      } else {
        session = queryMatches[0];
      }
    }

    if (!session) {
      throw new Error('Session resolution failed');
    }

    spinner.stop();
    await renderSession(session, mode, scope.filter, { redact: scope.redact });
  } catch (err: any) {
    if (isPromptCancelled(err)) return;
    tracker.stop();
    spinner.stop();
    console.error(chalk.red(`Failed to read session: ${err.message}`));
    process.exit(1);
  }
}

function shouldFanOutForId(query: string, local: boolean | undefined): boolean {
  if (local === true) return false;
  if (process.env[NO_FANOUT_ENV] === '1') return false;
  return looksLikeSessionId(query);
}

function modeFlag(mode: ViewMode): string | undefined {
  if (mode === 'markdown') return '--markdown';
  if (mode === 'json') return '--json';
  return undefined;
}

export async function resolveSessionMetadata(
  selector: string,
  scope: { agent?: string; project?: string; local?: boolean; hosts?: string[] },
  deps: Pick<FleetResolveDeps, 'gatherRemoteList'> & LiveMetadataDeps = { gatherRemoteList },
): Promise<void> {
  const localMatches = await computeLocalMetadataMatches(selector, scope, deps);

  if (process.env[NO_FANOUT_ENV] === '1') {
    process.stdout.write(serializeResolvedSessionsJson(localMatches));
    return;
  }

  const outcome = await resolveSessionMetadataValue(selector, scope, deps);
  if (outcome.kind === 'partial') {
    const offline = outcome.failedPeers;
    console.error(chalk.yellow(`Warning: ${offline.length} device(s) unreachable, not checked: ${offline.join(', ')}`));
    console.error(chalk.red(`No session matching "${selector}" on any reachable device (${offline.length} unreachable, not checked).`));
    console.error(chalk.gray('  If it lives on an offline box, wake it (agents devices) or run there: agents ssh <device>'));
    process.exit(1);
  }
  if (outcome.kind === 'not-found') {
    console.error(chalk.red(`No session found matching: ${selector}`));
    process.exit(1);
  }
  if (outcome.kind === 'ambiguous') {
    console.error(chalk.red(`Multiple sessions match "${selector}" across the fleet:`));
    for (const candidate of outcome.candidates) {
      const session = candidate.hits[0].session;
      const machines = candidate.hits.map(hit => hit.machine).join(', ');
      console.error(chalk.cyan(`  ${session.shortId}  ${session.id}`) + chalk.gray(`  ${machines}  ${sessionHeadline(session) ?? ''}`));
    }
    console.error(chalk.gray(looksLikeSessionId(selector) ? 'Pass a longer ID to narrow it down.' : 'Narrow the keywords to one session.'));
    process.exit(1);
  }

  process.stdout.write(serializeResolvedSessionsJson([outcome.session]));
}

type FleetResolveResult =
  | { kind: 'rendered' }
  | { kind: 'conflict' }
  | { kind: 'not-found'; deviceCount: number; unreachable: string[] };

async function resolveSessionAcrossFleet(
  query: string,
  mode: ViewMode,
  hosts?: string[],
  deps: FleetResolveDeps = { gatherRemoteList, runOnPeer },
): Promise<FleetResolveResult> {
  const spinner = isInteractiveTerminal() ? interruptibleSpinner('Searching the fleet...').start() : null;
  let candidates: FleetSessionCandidate[] = [];
  let deviceCount = 0;
  let unreachable: string[] = [];
  try {
    const forwarded = ['sessions', query, '--json', '--all', '--local'];
    const remote = await deps.gatherRemoteList(
      forwarded,
      hosts,
      selectorAllowsEarlyExit(query)
        ? { isDefinitive: (session) => isDefinitiveMatch(session, query) }
        : undefined,
    );
    candidates = fleetCandidatesByQuery(remote.sessions, query);
    deviceCount = remote.deviceCount;
    unreachable = remote.unreachable;
  } catch {
    candidates = [];
  } finally {
    spinner?.stop();
  }

  if (candidates.length === 0) return { kind: 'not-found', deviceCount, unreachable };

  if (candidates.length > 1) {
    console.error(chalk.red(`Multiple sessions match "${query}" across the fleet:`));
    for (const candidate of candidates) {
      const s = candidate.hits[0].session;
      const label = sessionHeadline(s) ?? '';
      const machines = candidate.hits.map(hit => hit.machine).join(', ');
      console.error(chalk.cyan(`  ${s.shortId}  ${s.id}`) + chalk.gray(`  ${machines}  ${s.agent}${s.version ? ` ${s.version}` : ''}  ${label}`));
    }
    console.error(chalk.gray('Pass a longer ID to narrow it down.'));
    return { kind: 'conflict' };
  }

  const candidate = candidates[0];
  const { machine } = candidate.hits[0];
  const peerArgs = ['sessions', candidate.id, '--local'];
  const flag = modeFlag(mode);
  if (flag) peerArgs.push(flag);
  const result = await deps.runOnPeer(peerArgs, machine);
  if (result === 'no-target') {
    console.error(chalk.red(`Session ${candidate.id} is on ${machine}, but it is not a reachable registered device.`));
    console.error(chalk.gray('Register it with `agents devices` or run the command on that machine.'));
    return { kind: 'conflict' };
  }
  return { kind: 'rendered' };
}

export function registerSessionsCommands(program: Command): void {
  const sessionsCmd = program
    .command('sessions')
    .argument('[query]', 'Session ID, search query, or path (., ../, /path) to filter by project')
    .option('--query <text>', 'Search text (same as the positional query)', collectQueryClause, [])
    .option('--resolve <selector>', 'Resolve one full ID, unique prefix, or keyword query to safe session metadata (requires --json; searches the fleet unless --local)')
    .addOption(new Option('--resolve-safe-v1 <selector>').hideHelp())
    .addOption(new Option('--resolve-launch-id <id>').hideHelp())
    .description(
      'Find, browse, and read agent conversation transcripts. Live roster: `agents sessions --active`.',
    )
    .option('-a, --agent <agent>', 'Filter by agent type and version (e.g., claude, codex@0.116.0)')
    .addOption(
      new Option('--session-version <version>', 'Internal spelling for the public sessions --version filter')
        .hideHelp(),
    )
    .option('--claude', 'Shorthand for --agent claude')
    .option('--codex', 'Shorthand for --agent codex')
    .option('--kimi', 'Shorthand for --agent kimi')
    .option('--antigravity', 'Shorthand for --agent antigravity')
    .option('--grok', 'Shorthand for --agent grok')
    .option('--opencode', 'Shorthand for --agent opencode')
    .option('--all', 'Widen every non-status filter to "all": every directory (not just this project) and all time (no window cap). Status filters like --active still compose; -a/--device/--since still narrow their axis.')
    .option('--bookmarks', 'Show only bookmarked sessions — bookmark them with `*` in the browser or `agents sessions bookmark <id>`')
    .option('--unmanaged', "Also show sessions from your own ~/.<agent> installs (hidden once agents-cli manages that agent)")
    .option('--team, --teams', 'Show team-spawned sessions (hidden by default), grouped by team — each team names its spawner and spawn time, teammates show their mode + handle, and team-flagged spawns with no teammate record sink into a (no team) bucket. --flat/--tree keep the plain inline table')
    .option('--in-team <name>', "Only this team: the session that spawned it plus (with --teams) its teammates. Spans every directory and all time, since a team's worktrees and history sit outside the default window.")
    .option('--routines, --routine [name]', 'Show routine-run sessions; omit the name on a TTY to pick one interactively (fuzzy name matching)')
    .option('-p, --project <name>', 'Filter by project name (searches across all directories)')
    .option('--skill <name>', 'Only sessions that invoked this skill (matches a bare name or a namespaced plugin skill\'s short name, e.g. --skill design finds rush:design)')
    .option('--plugin <name>', 'Only sessions that used a skill/command owned by this plugin')
    .option('--since <time>', 'Only sessions newer than this (e.g., 2h, 7d, 4w, or ISO date)')
    .option('--until <time>', 'Only sessions older than this (ISO timestamp)')
    .option('-n, --limit <n>', 'Maximum number of sessions to return', DEFAULT_LIMIT)
    .option('--sort <field>', 'Sort the list by: recent (default), cost, or duration')
    .option('--markdown', 'Render the session as markdown (user, assistant, thinking, tool calls)')
    .option('--no-redact', 'Disable default secret redaction in rendered session output (--markdown and --json)')
    .option('--json', 'Output JSON (session list when browsing, event array when rendering one session)')
    .option('--include <roles>', 'Only include these roles (comma-separated): user, assistant, thinking, tools. "user" is genuine user turns only, not harness-injected scaffolding (bash-input, system-reminder). Tool-call search across sessions is `sessions --include tools`')
    .option('--exclude <roles>', 'Exclude these roles (comma-separated): user, assistant, thinking, tools')
    .option('--first <n>', 'Keep only the first N turns (a turn starts at each genuine user message, not harness-injected scaffolding)')
    .option('--last <n>', 'Keep only the last N turns (a turn starts at each genuine user message, not harness-injected scaffolding)')
    .option('--artifacts', 'List all files written or edited during a session')
    .option('--artifact <name>', 'Read a specific artifact by filename or path (outputs to stdout)')
    .option('--active', 'Show only sessions running right now across terminals, teams, cloud, and headless agents')
    .option('--roots', 'With --json: emit the on-disk directories scanned for session transcripts, per agent (for external watchers)')
    .option('--local', 'Only this machine — skip the cross-machine SSH fan-out (default listing and --active)')
    .option('--working', 'Show live sessions currently doing work (implies --active)')
    .option('--idle', 'Show live sessions that have stopped between turns (implies --active)')
    .option('--waiting', 'Show live sessions waiting on your input; exits non-zero if any (implies --active)')
    .option('--orphan', 'Show live sessions whose process outlived its terminal client (implies --active)')
    .option('--orphaned', 'Alias for --orphan')
    .option('--crashed', 'Show sessions whose terminal disappeared with the process (implies --active)')
    .option('--closed', 'Show recently observed sessions whose process exited normally (implies --active)')
    .option('--abandoned', 'Show sessions with no transcript progress for the abandonment window (implies --active)')
    .option('--queued', 'Show queued sessions that have not started running (implies --active)')
    .option('--unknown', 'Show sessions whose live state cannot be determined (implies --active)')
    .option('--tree', 'Group the listing by directory; drops the id/version columns for readability')
    .option('--flat', 'Plain flat table (one row per session) instead of the grouped project overview')
    .option('--no-live', 'Do not enrich the listing with live status/preview for running sessions')
    .option('--cloud', 'Source sessions from Rush Cloud (captured runs) instead of local disk')
    .option('-D, --device <target...>', 'Run this query on remote machine(s) over SSH (device alias from `agents devices`, user@host, or `all` to search the whole fleet; repeatable)')
    .addOption(new Option('--devices <target...>', 'Plural alias for --device (accepts `all`/`fleet`).').hideHelp())
    .option('--no-interactive', 'Print the listing instead of opening the interactive browser (default on a TTY for the bare listing and --active)')
    .option('--print-cmd', 'Print the canonical `ag sessions …` command for the given flags and exit (the twin of the browser’s `y` hotkey)')
    .option('--preview', 'With a session id/query: print a compact preview and exit (no pager)');

  setHelpSections(sessionsCmd, {
    examples: `
      # Search indexed transcripts by topic, file path, or command
      agents sessions "add auth middleware"

      # Read a session as markdown (user + assistant + thinking + tools)
      agents sessions a1b2c3d4 --markdown

      # Just the user turns — useful for recalling intent
      agents sessions a1b2c3d4 --include user

      # Show only what's running right now (terminals, teams, cloud, headless)
      agents sessions --active

      # Filter the live fleet by the status word shown in the roster
      agents sessions --working
      agents sessions --idle
      agents sessions --orphan
      agents sessions --crashed

      # --- Session lifecycle ---
      # Get back into a session — attaches a live pane, or recovers an ended one
      agents sessions resume a1b2c3d4
      # Same, by the tmux name shown in: agents tmux ls
      agents sessions resume ag-claude-a1b2c3d4
      # Attach only — never fork a copy
      agents sessions resume a1b2c3d4 --attach-only
      # Multi-select history and open each in a tab
      agents sessions resume
      # The other direction: interactive → headless (keep working unattended)
      agents sessions detach a1b2c3d4

      # The interactive list folds in other online machines automatically,
      # labelled by host with this machine first. Stay local with --local:
      agents sessions --local

      # Search across every directory, not just this project
      agents sessions "topic" --all

      # Filter one installed harness version (equivalent forms)
      agents sessions claude@2.1.181
      agents sessions --agent claude --version 2.1.181

      # Team-spawned sessions, grouped by team (spawner + spawn time per team,
      # teammate mode/handle per row; team-flagged spawns with no team record
      # in a trailing (no team) bucket)
      agents sessions --teams

      # Who spawned which team: an orchestrator row carries team:<name>, and a
      # teammate row [<team>/<handle>]. --in-team narrows to one team's lineage.
      agents sessions --in-team redesign --teams

      # Pick a routine across every directory, then open one of its run sessions
      agents sessions --routine
      agents sessions --routine nightly-review
      agents sessions 2026-07-21T10-30-00-000Z

      # Export for analysis
      agents sessions --since 30d --limit 200 --json > sessions.json

      # Populate historical tool rows once on every device (search them with
      # the standalone CLI: sessions --include tools --query 'program:git')
      agents sessions backfill tools --fleet

      # Resolve one historical selector to metadata only, across the fleet
      agents sessions --resolve d3470b57 --json

      # Search another machine's sessions live over SSH (no sync needed)
      agents sessions "auth bug" --last 3 --device yosemite-s1

      # Fan the same query out across several machines
      agents sessions --all "deploy script" --device box-a --device box-b
    `,
    notes: `
      Session lifecycle — ONE verb gets you back in, it detects the state:
        resume <id|alias>       live pane -> attach; headless -> foreground; ended -> recover
        resume <id> --attach-only  attach only; never fork a copy
        resume                  multi-select history -> open tabs
        detach <id>             the other direction: interactive -> headless
      - The interactive listing and every live-status flag fold in your other online machines automatically (live over SSH, no sync) — each row is labelled by host, this machine first. Use --local to skip the fan-out; single-id lookups stay local.
      - --all is not a device flag: it widens historical directory and time filters. Fleet collection is already the default. A status flag (--working/--idle/--waiting/--orphan/--crashed/--closed/--abandoned/--queued/--unknown) implies --active; combine status flags for a union.
      - --version <version> requires --agent and is equivalent to --agent <agent@version>.
      - --device runs the query on the remote's own index over SSH (host alias or user@host); repeat or pass several to fan out. SSH access is the only auth.
      - --in-team matches both ends of the lineage: the session that ran 'agents teams create/add', and (with --teams) that team's teammates. In the interactive list, 't' cycles the same filter over the teams in view.
      - --include and --exclude are mutually exclusive.
      - Tool-call search and --count run in the standalone \`sessions\` CLI (\`sessions --include tools --query <clause>\`). agents indexes the calls: run 'agents sessions backfill tools' once for historical transcripts; normal scans index new and changed sessions.
      - --first and --last are mutually exclusive.
      - A filter flag (--include/--exclude/--first/--last) without --markdown/--json defaults to --markdown output.
      - --cloud sources from Rush Cloud captured runs instead of local disk.
      - --routine [name] spans every directory and shows transcripts archived from routine runs. On a TTY, omit the name to pick a routine; a name accepts exact, substring, or unambiguous typo matches. --routines is an alias. Routine rows also resolve by run id.
      - Without --teams, team-spawned sessions are hidden by default.
    `,
  });

  sessionsCmd.action(async (query: string | undefined, options: SessionsOptions, command: Command) => {
    await sessionsAction(query, options, command.getOptionValueSource('limit'));
  });

  registerSessionPreviewCommand(sessionsCmd, 'sessions');

  registerSessionsResumeCommand(sessionsCmd);
  registerSessionsForkCommand(sessionsCmd);
  registerSessionsBookmarkCommand(sessionsCmd);
  registerFocusCommand(sessionsCmd);
  registerDetachCommand(sessionsCmd);
  registerSessionsStopCommand(sessionsCmd);
  registerSessionsInjectCommand(sessionsCmd);
  registerSessionsExportCommand(sessionsCmd);
  registerSessionsRenderCommand(sessionsCmd);
  registerSessionsTraceCommand(sessionsCmd);
  registerSessionsShareCommand(sessionsCmd);
  registerSessionsImportCommand(sessionsCmd);
  registerSessionsBackupSetupCommand(sessionsCmd);
  registerSessionsMigrateCommand(sessionsCmd);
  registerSessionsMigrationsCommand(sessionsCmd);
  registerSessionsBackfillCommand(sessionsCmd);
  registerSessionsStatsCommand(sessionsCmd);
  registerSessionsInsightsCommand(sessionsCmd);
  registerSessionsOptimizeCommand(sessionsCmd);
  registerSessionsWatchCommand(sessionsCmd);
}

function formatNoSessionsMessage(
  showAll: boolean | undefined,
  project?: string,
): string {
  const projectQuery = project?.trim();
  if (projectQuery) {
    return `No sessions found for project "${projectQuery}".`;
  }
  if (showAll) return 'No sessions found.';
  const command = 'agents sessions --all';
  return `No sessions found for ${process.cwd()}. Run "${command}" to see sessions from every directory.`;
}

function formatUnmanagedHiddenFooter(hiddenCount: number): string {
  const noun = hiddenCount === 1 ? 'session' : 'sessions';
  return `(${hiddenCount} ${noun} from your own unmanaged installs hidden — use --unmanaged to show)`;
}

function findClaudeHistoryEntry(idQuery: string): ClaudeHistoryEntry | null {
  const historyPath = path.join(os.homedir(), '.claude', 'history.jsonl');
  if (!fs.existsSync(historyPath)) return null;

  try {
    const lines = fs.readFileSync(historyPath, 'utf-8').split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i].trim();
      if (!line) continue;

      let parsed: any;
      try {
        parsed = JSON.parse(line);
      } catch {
        continue;
      }

      if (parsed.sessionId !== idQuery) continue;

      const timestampMs = typeof parsed.timestamp === 'number'
        ? parsed.timestamp
        : typeof parsed.timestamp === 'string'
          ? Date.parse(parsed.timestamp)
          : undefined;

      return {
        sessionId: parsed.sessionId,
        display: typeof parsed.display === 'string' ? parsed.display : undefined,
        project: typeof parsed.project === 'string' ? parsed.project : undefined,
        timestampMs: Number.isFinite(timestampMs) ? timestampMs : undefined,
        historyPath,
      };
    }
  } catch {
    return null;
  }

  return null;
}

function renderClaudeHistoryOnlyId(
  idQuery: string,
  historyEntry: ClaudeHistoryEntry,
  allSessions: SessionMeta[],
): void {
  console.error(chalk.red(`No transcript session found matching: ${idQuery}`));
  console.error(chalk.yellow('This ID exists in Claude history, but not as a saved transcript session.'));
  console.error(chalk.gray(`History file: ${historyEntry.historyPath}`));

  if (historyEntry.display) {
    console.error(chalk.gray(`History entry: ${historyEntry.display}`));
  }

  if (historyEntry.project) {
    console.error(chalk.gray(`Project root: ${historyEntry.project}`));
  }

  if (historyEntry.timestampMs) {
    console.error(chalk.gray(`History time: ${new Date(historyEntry.timestampMs).toISOString()}`));
  }

  const relatedSessions = findClaudeSessionsInProject(allSessions, historyEntry);
  if (relatedSessions.length > 0) {
    console.error(chalk.gray('Claude transcript sessions in the same project tree:'));
    for (const session of relatedSessions) {
      console.error(
        chalk.gray(
          `  ${session.shortId}  ${session.id}  ${session.project || '-'}  ${formatRelativeTime(session.timestamp)}`
        )
      );
    }

    console.error(chalk.gray('Use one of the transcript IDs above with "agents sessions <id>".'));
    return;
  }

  if (historyEntry.display === '/resume') {
    console.error(chalk.gray('This looks like a Claude /resume history entry. In this case, the resumed conversation continued under a different transcript session ID.'));
  }

  const projectHint = historyEntry.project ? path.basename(historyEntry.project) : 'the project';
  console.error(chalk.gray(`Try "agents sessions --agent claude --project ${projectHint}" to find the resumed transcript session.`));
}

function findClaudeSessionsInProject(
  sessions: SessionMeta[],
  historyEntry: ClaudeHistoryEntry,
): SessionMeta[] {
  return findClaudeProjectSessions(sessions, historyEntry)
    .sort((a, b) => sessionDistance(a, historyEntry) - sessionDistance(b, historyEntry))
    .slice(0, 3);
}

function findClaudeProjectSessions(
  sessions: SessionMeta[],
  historyEntry: ClaudeHistoryEntry,
): SessionMeta[] {
  if (!historyEntry.project) return [];
  let projectRoot = historyEntry.project;
  try { projectRoot = fs.realpathSync(projectRoot); } catch {  }

  return sessions.filter(session =>
    session.agent === 'claude' &&
    typeof session.cwd === 'string' &&
    isWithinProject(session.cwd, projectRoot)
  );
}

function resolveClaudeHistoryEntryToTranscript(
  historyEntry: ClaudeHistoryEntry,
  sessions: SessionMeta[],
): ClaudeResumeMatch | null {
  if (historyEntry.display !== '/resume') return null;

  const candidates = findClaudeProjectSessions(sessions, historyEntry);
  const matches: ClaudeResumeMatch[] = [];

  for (const session of candidates) {
    const resumeTimestampMs = findClaudeResumeTimestamp(session.filePath, historyEntry.timestampMs);
    if (resumeTimestampMs === null) continue;

    const deltaMs = historyEntry.timestampMs === undefined
      ? 0
      : Math.abs(resumeTimestampMs - historyEntry.timestampMs);

    if (historyEntry.timestampMs !== undefined && deltaMs > CLAUDE_RESUME_MATCH_WINDOW_MS) {
      continue;
    }

    matches.push({ session, resumeTimestampMs, deltaMs });
  }

  if (matches.length === 0) return null;

  matches.sort((a, b) => {
    if (a.deltaMs !== b.deltaMs) return a.deltaMs - b.deltaMs;
    return b.resumeTimestampMs - a.resumeTimestampMs;
  });

  const [best, second] = matches;
  if (second && best.deltaMs === second.deltaMs && best.resumeTimestampMs === second.resumeTimestampMs) {
    return null;
  }

  return best;
}

function findClaudeResumeTimestamp(filePath: string, targetTimestampMs?: number): number | null {
  try {
    const lines = fs.readFileSync(filePath, 'utf-8').split('\n');
    let bestTimestampMs: number | null = null;

    for (const line of lines) {
      if (!line.includes('SessionStart:resume')) continue;

      let parsed: any;
      try {
        parsed = JSON.parse(line);
      } catch {
        continue;
      }

      if (parsed.attachment?.hookName !== 'SessionStart:resume') continue;

      const timestampMs = Date.parse(parsed.timestamp || '');
      if (Number.isNaN(timestampMs)) continue;

      if (targetTimestampMs === undefined) {
        return timestampMs;
      }

      if (bestTimestampMs === null || Math.abs(timestampMs - targetTimestampMs) < Math.abs(bestTimestampMs - targetTimestampMs)) {
        bestTimestampMs = timestampMs;
      }
    }

    return bestTimestampMs;
  } catch {
    return null;
  }
}

function isWithinProject(sessionCwd: string, projectRoot: string): boolean {
  const cwd = toComparablePath(sessionCwd);
  const root = toComparablePath(projectRoot);
  return cwd === root || cwd.startsWith(root + '/');
}

function sessionDistance(session: SessionMeta, historyEntry: ClaudeHistoryEntry): number {
  if (!historyEntry.timestampMs) return Number.MAX_SAFE_INTEGER;
  const sessionTime = new Date(session.timestamp).getTime();
  if (Number.isNaN(sessionTime)) return Number.MAX_SAFE_INTEGER;
  return Math.abs(sessionTime - historyEntry.timestampMs);
}
