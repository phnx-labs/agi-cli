import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawn, type ChildProcess } from 'child_process';
import { Option, type Command } from 'commander';
import chalk from 'chalk';
import { truncate, padRight, humanDuration, formatBytes } from '../lib/format.js';
import { sanitizeForTerminal, redactSecrets } from '../lib/redact.js';
import { resolveProjectKey } from '../lib/project-key.js';
import { listProjectDefs, resolveProjectNameForCwd, type ProjectDef } from '../lib/projects.js';
import ora from 'ora';
import { interruptibleSpinner } from '../lib/spinner.js';
import type { AgentId } from '../lib/types.js';
import type { SessionAgentId, SessionEvent, SessionMeta, ViewMode } from '@phnx-labs/sessions-cli/reader';
import { SESSION_AGENTS, isAgentTmuxAlias, sessionDisplayAgent } from '@phnx-labs/sessions-cli/reader';
import { discoverArtifacts, readArtifact, resolveArtifact } from '@phnx-labs/sessions-cli/reader';
import { looksLikePath, toComparablePath, homeDir, needsWindowsShell, composeWin32CommandLine } from '../lib/platform/index.js';
import { getActiveSessions, describeActiveDiscoveryHealth, sessionProcessIsLocal, backfillActiveRowsFromIndex, backfillActiveRowsFromMeta, isRunningLiveSession, serializeActiveSessionsForJson, serializeSessionsJson, shortIdFromName, type ActiveSession, type BackfillMeta } from '../lib/session/active.js';
export { activeSessionProjectKey, backfillActiveRowsFromIndex, backfillActiveRowsFromMeta, isRunningLiveSession, serializeActiveSessionsForJson, serializeSessionsJson, type BackfillMeta } from '../lib/session/active.js';
import { enumerateGhosttyTabs, assignGhosttyTabs, type GhosttySurface } from '../lib/session/ghostty-tabs.js';
import { mapPanesToTargets, listClients } from '../lib/tmux/session.js';
import { resolveViewingIn, viewingInLabel } from '../lib/session/viewing-in.js';
import { machineId, normalizeHost } from '../lib/session/sync/config.js';
import { gatherRemoteActive, NO_FANOUT_ENV } from '../lib/session/remote-active.js';
import {
  loadFleetActiveSessions,
  loadLocalActiveSessions,
  readActiveSessionsCache,
} from '../lib/session/session-cache.js';
import { gatherRemoteList, gatherRemoteToolProgramCounts, gatherRemoteToolSearch, runOnPeer } from '../lib/session/remote-list.js';
import { gatherRemoteAgentsJson, type RemoteAgentsJsonParseResult } from '../lib/remote-agents-json.js';
import { stringWidth, truncateToWidth, padToWidth, terminalWidth } from '../lib/session/width.js';
import type { SessionActivity, AwaitingReason } from '@phnx-labs/sessions-cli/reader';
import { inferSessionState } from '@phnx-labs/sessions-cli/reader';
import { discoverSessions, queryIndexedSessions, countSessionsInScope, resolveSessionById, isCompleteSessionId, looksLikeSessionId, searchContentIndex, parseTimeFilter, getSessionRoots, scopeToManaged, type DiscoverOptions, type ScanProgress } from '../lib/session/discover.js';
import { findSessionsById, querySessions, getSessionById, readSessionContent, readArchivedSessionPreview, readSessionTimelineAny } from '../lib/session/db.js';
import { foldTimeline, emptyTimelineState, projectTimeline, projectSessionFiles } from '@phnx-labs/sessions-cli/reader';
import { readSessionTail } from '@phnx-labs/sessions-cli/reader';
import { liveSessionMetas, fleetExecutionMachineById, reconcileLiveMetaMachine } from '../lib/session/live-metadata.js';
import { sessionHeadline } from '../lib/session/title.js';
import {
  filterTeamSessions,
  shouldShowTeamSessions,
  safeTeamText,
  groupSessionsByTeam,
  NO_TEAM_GROUP_KEY,
  type TeamSessionGroup,
} from '@phnx-labs/sessions-cli/reader';
import { parseSession } from '@phnx-labs/sessions-cli/reader';
import { runRemoteSessions, buildForwardedArgs, ensureWholeIndex } from '../lib/session/remote.js';
import { formatRelativeTime, formatCompactAge, sessionAgeParts, type SessionAgeParts } from '../lib/session/relative-time.js';
import { renderConversationMarkdown, renderSummary, renderSummaryHeader, computeSummaryStats, renderJson, filterEvents, parseRoleList, linkPath, linkUrl, shortenModel, formatTokenCount, type FilterOptions } from '@phnx-labs/sessions-cli/reader';
import { linearIssueUrl } from '@phnx-labs/sessions-cli/reader';
import { sessionOwnerDevice, RESUME_PINNED_ENV } from '../lib/session/resume-owner.js';
import { renderMarkdown } from '../lib/markdown.js';
import { AGENTS, colorAgent, resolveAgentName } from '../lib/agents.js';
import { getShimsDir } from '../lib/state.js';
import { listJobs, listJobsWithRuns, listRuns, getRunDir, type RunMeta } from '../lib/scheduling/routines.js';
import { formatUsd } from '../lib/pricing/cost.js';
import { fuzzyMatch, FUZZY_PRESETS } from '../lib/fuzzy.js';
import { itemPicker } from '../lib/picker.js';
import { resolveSessionAlias } from '../lib/session/actor-sidecar.js';
import { listInstalledVersions, resolveVersionAliasLoose } from '../lib/installations/versions.js';
import { getAgentsInvocation } from '../lib/daemon/daemon.js';
import { sessionAgentSupportsResume, sessionRecoveryRunArgs } from '../lib/session/recovery.js';
import { isInteractiveTerminal, isPromptCancelled } from './utils.js';
import {
  sessionPicker,
  buildPreview,
  loadSessionPreviewDigest,
  transcriptOnPeerOf,
  formatTodoCompact,
  githubRepoUrlFromCwd,
  type PickedSession,
  type SessionPreviewDigest,
} from './sessions-picker.js';
import { setHelpSections } from '../lib/help.js';
import { registerSessionsTailCommand } from './sessions-tail.js';
import { registerSessionsResumeCommand } from './sessions-resume.js';
import { registerSessionsForkCommand } from './fork.js';
import { registerSessionsBookmarkCommand } from './sessions-bookmark.js';
import { isBookmarked, listBookmarks } from '../lib/session/bookmarks.js';
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
import { runBrowserSessionsCommand } from './browser-sessions-picker.js';
import { runComputerSessionsCommand } from './computer-sessions-picker.js';
import { buildComputerSessionRows, type ComputerRunRow } from '../lib/computer/sessions-list.js';
import {
  countToolProgramOccurrences,
  parseToolProgramCountClause,
  readToolIndexCoverage,
  searchToolCalls,
  TOOL_QUERY_MAX_CLAUSE_BYTES,
  TOOL_QUERY_MAX_CLAUSES,
  TOOL_QUERY_MAX_RESULT_SESSIONS,
  serializeToolSearchEnvelope,
  toolSearchRemoteReceiveBudget,
  type ToolSearchEnvelope,
  type ToolProgramCountEnvelope,
} from '../lib/session/tool-index.js';

const SESSION_AGENT_FILTER_HELP = `Filter by agent, e.g. claude, codex, claude@2.0.65`;

function collectQueryClause(value: string, previous: string[]): string[] {
  return [...previous, value];
}

interface SessionFilterOptions {
  agent?: string;
  version?: string;
  sessionVersion?: string;
  project?: string;
  all?: boolean;
  teams?: boolean;
  inTeam?: string;
  routine?: boolean | string;
  since?: string;
  until?: string;
}

interface SessionsOptions extends SessionFilterOptions {
  unmanaged?: boolean;
  query?: string[];
  resolve?: string;
  // Versioned peer seam: older peers must reject rather than return unsafe fields.
  resolveSafeV1?: string;
  resolveLaunchId?: string;
  limit?: string;
  sort?: string;
  json?: boolean;
  markdown?: boolean;
  redact?: boolean;
  include?: string;
  exclude?: string;
  first?: string;
  last?: string;
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
  fleet?: boolean;
  count?: boolean;
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

type InstalledVersionsForAgent = (agent: SessionAgentId) => string[];

export function parseInstalledAgentVersionQuery(
  query: string | undefined,
  installedVersions: InstalledVersionsForAgent = (agent) => (
    agent in AGENTS ? listInstalledVersions(agent as AgentId) : []
  ),
): string | undefined {
  const trimmed = query?.trim();
  if (!trimmed) return undefined;
  const at = trimmed.indexOf('@');
  if (at <= 0 || at !== trimmed.lastIndexOf('@') || at === trimmed.length - 1) return undefined;

  const agentName = trimmed.slice(0, at).toLowerCase();
  if (!SESSION_AGENTS.includes(agentName as SessionAgentId)) return undefined;
  const agent = agentName as SessionAgentId;
  const version = trimmed.slice(at + 1);
  return installedVersions(agent).includes(version) ? `${agent}@${version}` : undefined;
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

const PICKER_RECENT_COUNT = 15;
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

function statusColor(status: ActiveSession['status']): (s: string) => string {
  switch (status) {
    case 'running': return chalk.green;
    case 'idle': return chalk.gray;
    case 'queued': return chalk.blue;
    case 'input_required': return chalk.yellow;
    case 'closed': return chalk.dim;
    case 'abandoned': return chalk.red;
    case 'crashed': return chalk.redBright;
    case 'orphaned': return chalk.yellow;
    case 'unknown': return chalk.magenta;
  }
}

function contextColor(context: ActiveSession['context']): (s: string) => string {
  switch (context) {
    case 'terminal': return chalk.magenta;
    case 'teams': return chalk.cyan;
    case 'cloud': return chalk.blue;
    case 'headless': return chalk.gray;
  }
}

function shortCwd(cwd?: string): string {
  if (!cwd) return '-';
  const home = homeDir();
  return toComparablePath(cwd).startsWith(toComparablePath(home))
    ? '~' + cwd.slice(home.length)
    : cwd;
}

function formatStartedAt(startedAtMs?: number): string {
  if (!startedAtMs) return '-';
  return formatRelativeTime(new Date(startedAtMs).toISOString());
}

export function cleanPreview(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')
    .replace(/<\/?(?:local-command-stdout|command-name|command-message|command-args|task-notification|system-reminder)>/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function buildSessionDescription(s: ActiveSession): string {
  const todo = formatTodoCompact(s.todos);
  if (s.context === 'cloud') {
    const base = s.preview || `${s.cloudProvider ?? ''}${s.cloudTaskId ? ` · ${s.cloudTaskId.slice(0, 12)}` : ''}`;
    return cleanPreview([todo, base].filter(Boolean).join(' · '));
  }
  if (s.context === 'teams') {
    const parts = [s.teamName];
    if (s.label && s.label !== s.teamName) parts.push(s.label);
    const orch = s.orchestratorLabel || (s.orchestratorSessionId ? s.orchestratorSessionId.slice(0, 8) : '');
    if (orch) parts.push(`by ${orch}`);
    if (todo) parts.push(todo);
    const target = s.preview || s.assignedTask || s.topic;
    if (target) parts.push(target);
    return cleanPreview(parts.filter(Boolean).join(' · '));
  }
  // ladder-exempt: compact live preview base, not the row's headline.
  const base = s.preview || s.label || s.topic || '';
  return cleanPreview([todo, base].filter(Boolean).join(' · '));
}

export function formatActiveRowDescription(s: ActiveSession): string {
  const parts: string[] = [];
  const pushText = (t?: string) => {
    const c = t ? cleanPreview(t) : '';
    if (c) parts.push(c);
  };
  if (s.context === 'teams' && s.teamName) pushText(s.teamName);
  if (s.label) pushText(s.label);
  const project = s.cwd ? path.basename(s.cwd) : '';
  if (project && project !== s.label && project !== s.teamName) {
    const label = cleanPreview(project);
    const repoUrl = githubRepoUrlFromCwd(s.cwd);
    parts.push(repoUrl ? linkUrl(repoUrl, label) : label);
  }
  const todo = formatTodoCompact(s.todos);
  if (todo) parts.push(todo);

  if (s.preview) {
    pushText(s.preview);
  } else if (!s.label && s.topic) {
    pushText(s.topic);
  }
  return parts.filter(Boolean).join(' · ');
}

function activityLabel(s: ActiveSession): string {
  if (s.status === 'closed' || s.status === 'abandoned') return s.status;
  if (s.status === 'crashed') return 'crashed';
  if (s.status === 'orphaned') return 'orphan';
  if (s.activity === 'waiting_input') return 'waiting';
  if (s.activity === 'working') return 'working';
  if (s.activity === 'idle') return 'idle';
  return s.status === 'input_required' ? 'waiting' : s.status;
}

export function indexActiveBySessionId(active: ActiveSession[]): Map<string, ActiveSession> {
  const byId = new Map<string, ActiveSession>();
  for (const a of active) {
    if (a.sessionId) byId.set(a.sessionId, a);
  }
  return byId;
}


export function liveGlyphAndPreview(a: ActiveSession | undefined): { glyph: string; preview: string } {
  if (!a) return { glyph: '', preview: '' };
  if (a.status === 'abandoned') return { glyph: statusColor(a.status)('⊘'), preview: buildSessionDescription(a) };
  if (a.status === 'closed') return { glyph: statusColor(a.status)('×'), preview: buildSessionDescription(a) };
  if (a.status === 'crashed') return { glyph: statusColor(a.status)('✗'), preview: buildSessionDescription(a) };
  if (a.status === 'orphaned') return { glyph: statusColor(a.status)('◍'), preview: buildSessionDescription(a) };

  const waiting = a.status === 'input_required' || a.activity === 'waiting_input';
  const running = a.status === 'running' || a.activity === 'working';
  const unknown = a.status === 'unknown';
  const shape =
    waiting ? '◐'
      : running ? '●'
        : unknown ? '◌'
          : '○';
  return { glyph: statusColor(a.status)(shape), preview: buildSessionDescription(a) };
}

export function liveStatusWord(a: ActiveSession | undefined): string {
  if (!a) return '';
  if (a.status === 'closed' || a.status === 'abandoned') return a.status;
  if (a.status === 'crashed') return 'crashed';
  if (a.status === 'orphaned') return 'orphan';
  if (a.status === 'input_required' || a.activity === 'waiting_input') return 'waiting';
  if (a.status === 'running' || a.activity === 'working') return 'working';
  if (a.status === 'idle' || a.activity === 'idle') return 'idle';
  if (a.status === 'queued') return 'queued';
  return '';
}

export function isAwaitingUser(s: ActiveSession): boolean {
  if (s.status === 'crashed' || s.status === 'closed') return false;
  // Orphans can still await input; dead abandoned rows need relaunch, not an answer.
  if (s.status === 'abandoned' && s.pidAlive !== true) return false;
  return s.status === 'input_required' || s.activity === 'waiting_input';
}


const LIVE_STATUS_W = 8;

function liveStatusCell(live: ActiveSession | undefined): { cell: string; width: number } {
  const word = liveStatusWord(live);
  if (!word || !live) return { cell: '', width: 0 };
  return { cell: statusColor(live.status)(padToWidth(word, LIVE_STATUS_W)), width: LIVE_STATUS_W };
}

export function ticketLabel(s: Pick<SessionMeta, 'ticketId' | 'prNumber'>): string {
  return s.ticketId ?? (s.prNumber ? `PR#${s.prNumber}` : '');
}

function ticketUrl(s: Pick<SessionMeta, 'ticketId' | 'prNumber' | 'prUrl'>): string | undefined {
  if (s.ticketId) return linearIssueUrl(s.ticketId);
  return s.prNumber ? s.prUrl : undefined;
}

export function linkTicketCell(s: Pick<SessionMeta, 'ticketId' | 'prNumber' | 'prUrl'>, label: string): string {
  const url = ticketUrl(s);
  return url && label.trim() !== '-' ? linkUrl(url, label) : label;
}

export function linkCwdCell(s: Pick<SessionMeta, 'cwd' | '_remote'>, label: string): string {
  return s.cwd && !s._remote ? linkPath(s.cwd, label) : label;
}

function modelLabel(model?: string): string {
  return model ? shortenModel(model) : '-';
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

function signalBadges(s: Pick<ActiveSession, 'awaitingReason' | 'pr' | 'worktree' | 'ticket'>): string {
  const parts: string[] = [];
  if (s.awaitingReason === 'plan_review') parts.push(chalk.yellow('plan'));
  else if (s.awaitingReason === 'question') parts.push(chalk.yellow('ask'));
  else if (s.awaitingReason === 'permission') parts.push(chalk.yellow('perm'));
  if (s.ticket) {
    const url = linearIssueUrl(s.ticket.id);
    parts.push(chalk.cyan(url ? linkUrl(url, s.ticket.id) : s.ticket.id));
  }
  if (s.pr) {
    const label = `PR#${s.pr.number ?? '?'}`;
    parts.push(chalk.blue(s.pr.url ? linkUrl(s.pr.url, label) : label));
  }
  if (s.worktree) parts.push(chalk.magenta(`wt:${s.worktree.slug}`));
  return parts.join(' ');
}

function locatorBadge(s: ActiveSession): string {
  const p = s.provenance;
  const parts: string[] = [];
  if (p?.transport === 'ssh') parts.push(chalk.red(p.origin ? `ssh←${p.origin.device}` : 'ssh'));
  if (p?.mux?.kind === 'tmux' && (s.tmuxTarget || p.mux.pane)) {
    parts.push(chalk.green(s.tmuxTarget ?? p.mux.pane!));
    const label = viewingInLabel(s);
    if (label) parts.push(chalk.gray(label === 'detached' ? label : `viewing in ${label}`));
  } else if (p?.mux?.kind === 'screen') {
    parts.push(chalk.green('screen'));
  }
  if (s.ghosttyTab != null) parts.push(chalk.green(`tab ${s.ghosttyTab}`));
  if (s.context === 'cloud') {
    const bits = [s.cloudProvider, s.cloudTaskId ? s.cloudTaskId.slice(0, 12) : undefined].filter(Boolean);
    if (bits.length) parts.push(chalk.dim(bits.join(' · ')));
  } else if (typeof s.pid === 'number' && s.pid > 0) {
    parts.push(chalk.dim(`${s.machine ? `${s.machine}:` : ''}pid ${s.pid}`));
  }
  return parts.join(' ');
}

function activeTimeCell(s: ActiveSession): string {
  const parts: string[] = [];
  if (s.startedAtMs) parts.push(`created ${formatCompactAge(new Date(s.startedAtMs).toISOString())}`);
  if (s.lastActivityMs) parts.push(`idle ${formatCompactAge(new Date(s.lastActivityMs).toISOString())}`);
  return parts.join(' · ');
}

const ROW_ID_W = 9;
const ROW_AGENT_W = 8;
const ROW_VERSION_W = 8;
const ROW_STATUS_W = 9;
const ROW_OWNER_W = 9;

function fitCell(content: string, room: number): string {
  if (room <= 0) return '';
  return stringWidth(content) <= room ? content : truncateToWidth(content, room);
}

export function renderActiveRowLines(s: ActiveSession, indent: string, termW: number): string[] {
  const idCol = chalk.dim(padToWidth((s.sessionId?.slice(0, 8)) ?? '-', ROW_ID_W));
  const shownKind = sessionDisplayAgent({ agent: s.kind, harness: s.harness });
  const kindCol = colorAgent(shownKind)(padToWidth(truncateToWidth(shownKind, ROW_AGENT_W), ROW_AGENT_W + 1));
  const versionCol = chalk.gray(padToWidth(truncateToWidth(s.version ?? '', ROW_VERSION_W), ROW_VERSION_W + 1));
  const statusCol = statusColor(s.status)(padToWidth(truncateToWidth(activityLabel(s), ROW_STATUS_W - 1), ROW_STATUS_W));
  const ownerCol = chalk.cyan(padToWidth(truncateToWidth(ownerLabel(s), ROW_OWNER_W - 1), ROW_OWNER_W));
  const fixedCols = idCol + kindCol + versionCol + statusCol + ownerCol;
  const fixedW = stringWidth(indent) + ROW_ID_W + (ROW_AGENT_W + 1) + (ROW_VERSION_W + 1) + ROW_STATUS_W + ROW_OWNER_W;
  const remaining = Math.max(0, termW - fixedW - 1);

  const fork = s.pidCount && s.pidCount > 1 ? chalk.dim(`×${s.pidCount} `) : '';
  const badgesCell = fitCell(fork + signalBadges(s), remaining);
  const badgesW = stringWidth(badgesCell);
  const timeRoom = Math.max(0, remaining - (badgesW ? badgesW + 2 : 0));
  const timeCell = chalk.gray(truncateToWidth(activeTimeCell(s), timeRoom));
  let right = timeCell;
  if (badgesCell) right += (stringWidth(timeCell) ? '  ' : '') + badgesCell;
  let line1 = indent + fixedCols + right;
  if (stringWidth(line1) > termW) line1 = truncateToWidth(line1, termW);
  const lines = [line1];

  const contIndent = indent + ' '.repeat(ROW_ID_W);
  const desc = formatActiveRowDescription(s);
  const loc = locatorBadge(s);
  if (desc || loc) {
    const room2 = Math.max(0, termW - stringWidth(contIndent) - 2);
    const locCell = fitCell(loc, room2);
    const locW = stringWidth(locCell);
    const descRoom = Math.max(0, room2 - (locW ? locW + 2 : 0));
    const descCell = chalk.white(fitCell(desc || '-', descRoom));
    let line2 = contIndent + chalk.dim('└ ') + descCell;
    if (locCell) line2 += '  ' + locCell;
    if (stringWidth(line2) > termW) line2 = truncateToWidth(line2, termW);
    lines.push(line2);
  }

  const important = s.importantMessage;
  if (important && (important.kind === 'question' || important.kind === 'needs_you')) {
    const glyph = important.kind === 'question' ? '? ' : '! ';
    const room3 = Math.max(0, termW - stringWidth(contIndent) - 2 - glyph.length);
    const msgCell = fitCell(cleanPreview(important.text), room3);
    if (msgCell) {
      let line3 = contIndent + chalk.dim(glyph + msgCell);
      if (stringWidth(line3) > termW) line3 = truncateToWidth(line3, termW);
      lines.push(line3);
    }
  }
  return lines;
}

function printActiveRow(s: ActiveSession, indent: string): void {
  for (const line of renderActiveRowLines(s, indent, terminalWidth())) console.log(line);
}

export function ownerLabel(s: ActiveSession): string {
  const owner = s.owner;
  if (!owner || owner.startsWith('UNRESOLVED@')) return '-';
  const at = owner.indexOf('@');
  return at > 0 ? owner.slice(0, at) : owner;
}

function shortWindowLabel(windowId: string): string {
  const m = windowId.match(/-(\d+)$/);
  return m ? `ext-pid ${m[1]}` : `win ${windowId.slice(0, 8)}`;
}

interface ActiveSessionsLayout {
  workspaces: Array<{
    key: string;
    total: number;
    windows: Array<{ windowId: string; sessions: ActiveSession[] }>;
    flat: ActiveSession[];
  }>;
}

export function groupActiveSessions(sessions: ActiveSession[]): ActiveSessionsLayout {
  const byWorkspace = new Map<string, ActiveSession[]>();
  for (const s of sessions) {
    const key = s.cwd ?? (s.context === 'cloud' ? '__cloud__' : '__unknown__');
    const list = byWorkspace.get(key) || [];
    list.push(s);
    byWorkspace.set(key, list);
  }
  const sortedKeys = Array.from(byWorkspace.keys()).sort((a, b) => {
    const aCount = byWorkspace.get(a)!.length;
    const bCount = byWorkspace.get(b)!.length;
    if (aCount !== bCount) return bCount - aCount;
    return a.localeCompare(b);
  });
  const workspaces = sortedKeys.map((key) => {
    const group = byWorkspace.get(key)!;
    const windowedSessions: ActiveSession[] = [];
    const flat: ActiveSession[] = [];
    for (const s of group) {
      if (s.context === 'terminal' && s.windowId) windowedSessions.push(s);
      else flat.push(s);
    }
    const byWindow = new Map<string, ActiveSession[]>();
    for (const s of windowedSessions) {
      const list = byWindow.get(s.windowId!) || [];
      list.push(s);
      byWindow.set(s.windowId!, list);
    }
    const windowKeys = Array.from(byWindow.keys()).sort((a, b) => {
      const aStart = Math.min(...byWindow.get(a)!.map(s => s.startedAtMs ?? Infinity));
      const bStart = Math.min(...byWindow.get(b)!.map(s => s.startedAtMs ?? Infinity));
      return aStart - bStart;
    });
    return {
      key,
      total: group.length,
      windows: windowKeys.map((wid) => ({ windowId: wid, sessions: byWindow.get(wid)! })),
      flat,
    };
  });
  return { workspaces };
}

interface MachineGroup {
  machine: string;
  isLocal: boolean;
  total: number;
  layout: ActiveSessionsLayout;
}

interface MachineGroupedLayout {
  machines: MachineGroup[];
}

const CLOUD_MACHINE_KEY = 'cloud';

function machineKeyFor(s: ActiveSession, localMachine: string): string {
  if (s.context === 'cloud') return CLOUD_MACHINE_KEY;
  if (s.machine) return s.machine;
  if (s.provenance?.host) return normalizeHost(s.provenance.host);
  return localMachine;
}

export function groupSessionsByMachine(sessions: ActiveSession[], localMachine: string): MachineGroupedLayout {
  const byMachine = new Map<string, ActiveSession[]>();
  for (const s of sessions) {
    const key = machineKeyFor(s, localMachine);
    (byMachine.get(key) ?? byMachine.set(key, []).get(key)!).push(s);
  }
  const keys = Array.from(byMachine.keys()).sort((a, b) => {
    if (a === localMachine) return -1;
    if (b === localMachine) return 1;
    if (a === CLOUD_MACHINE_KEY) return 1;
    if (b === CLOUD_MACHINE_KEY) return -1;
    const ac = byMachine.get(a)!.length, bc = byMachine.get(b)!.length;
    if (ac !== bc) return bc - ac;
    return a.localeCompare(b);
  });
  const machines = keys.map((machine) => ({
    machine,
    isLocal: machine === localMachine,
    total: byMachine.get(machine)!.length,
    layout: groupActiveSessions(byMachine.get(machine)!),
  }));
  return { machines };
}

export function dedupeByMachineSession(sessions: ActiveSession[]): ActiveSession[] {
  const seen = new Map<string, number>();
  const out: ActiveSession[] = [];
  for (const s of sessions) {
    if (!s.sessionId) { out.push(s); continue; }
    const key = `${s.machine ?? ''}:${s.sessionId}`;
    const at = seen.get(key);
    if (at === undefined) {
      seen.set(key, out.length);
      out.push(s);
      continue;
    }
    if (out[at].offloadedFrom && !s.offloadedFrom) out[at] = s;
  }
  return out;
}

export function filterActiveSessionsByHostScope(
  sessions: ActiveSession[],
  hosts: string[] | undefined,
  self: string,
): ActiveSession[] {
  if (!hosts || hosts.length === 0) return sessions;
  const wanted = new Set(hosts.map(hostToken));
  return sessions.filter((s) => wanted.has(s.machine ?? self));
}

export function mergeLocalFirst(sessions: SessionMeta[], localMachine: string): SessionMeta[] {
  const byMachine = new Map<string, SessionMeta[]>();
  const seen = new Set<string>();
  for (const s of sessions) {
    const machine = s.machine || localMachine;
    if (s.id) {
      const dedupeKey = `${machine}:${s.id}`;
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);
    }
    (byMachine.get(machine) ?? byMachine.set(machine, []).get(machine)!).push(s);
  }
  const keys = Array.from(byMachine.keys()).sort((a, b) => {
    if (a === localMachine) return -1;
    if (b === localMachine) return 1;
    const ac = byMachine.get(a)!.length, bc = byMachine.get(b)!.length;
    if (ac !== bc) return bc - ac;
    return a.localeCompare(b);
  });
  return keys.flatMap((k) => byMachine.get(k)!);
}


// Peer resolution exposes launch identity only; paths, plans, costs, and content stay local.
export function serializeResolvedSessionsJson(sessions: SessionMeta[]): string {
  const safe = sessions.map((session) => ({
    id: session.id,
    shortId: session.shortId,
    agent: session.agent,
    harness: session.harness,
    origin: session.origin,
    timestamp: session.timestamp,
    lastActivity: session.lastActivity,
    project: session.project,
    version: session.version,
    mode: session.mode,
    label: session.label,
    topic: session.topic,
    machine: session.machine,
  }));
  return JSON.stringify(safe, null, 2) + '\n';
}

async function runRemoteSessionsJson(hosts: string[]): Promise<void> {
  const forwarded = ensureWholeIndex(buildForwardedArgs(process.argv, new Set(hosts)));
  if (!forwarded.includes('--json')) forwarded.push('--json');
  const { sessions } = await gatherRemoteList(forwarded, hosts);
  process.stdout.write(serializeSessionsJson(sessions));
}

export function parseRemoteComputerSessionRows(
  stdout: string,
  machine: string,
): RemoteAgentsJsonParseResult<ComputerRunRow> {
  try {
    const value: unknown = JSON.parse(stdout);
    if (!Array.isArray(value)) return { items: [], valid: false };
    const items = value
      .filter((row): row is ComputerRunRow => Boolean(row && typeof row === 'object' && !Array.isArray(row)))
      .map((row) => ({ ...row, machine: row.machine || machine }));
    return { items, valid: true };
  } catch {
    return { items: [], valid: false };
  }
}

async function gatherRemoteComputerSessionRows(hosts?: string[]): Promise<ComputerRunRow[]> {
  const hostSet = new Set(hosts ?? []);
  const forwarded = buildForwardedArgs(process.argv, hostSet);
  if (!forwarded.includes('--json')) forwarded.push('--json');
  if (!forwarded.includes('--no-interactive')) forwarded.push('--no-interactive');
  const result = await gatherRemoteAgentsJson<ComputerRunRow>({
    args: forwarded,
    noFanoutEnv: NO_FANOUT_ENV,
    hosts,
    parse: parseRemoteComputerSessionRows,
  });
  return result.items;
}

function groupTally(sessions: ActiveSession[]): string {
  const running = sessions.filter(s => s.status === 'running').length;
  const idle = sessions.filter(s => s.status === 'idle').length;
  const waiting = sessions.filter(s => s.status === 'input_required').length;
  const queued = sessions.filter(s => s.status === 'queued').length;
  const closed = sessions.filter(s => s.status === 'closed').length;
  const abandoned = sessions.filter(s => s.status === 'abandoned').length;
  const orphaned = sessions.filter(s => s.status === 'orphaned').length;
  const crashed = sessions.filter(s => s.status === 'crashed').length;
  const unknown = sessions.filter(s => s.status === 'unknown').length;
  const parts: string[] = [];
  if (running) parts.push(`${running} running`);
  if (idle) parts.push(`${idle} idle`);
  if (waiting) parts.push(`${waiting} waiting`);
  if (queued) parts.push(`${queued} queued`);
  if (closed) parts.push(`${closed} closed`);
  if (abandoned) parts.push(`${abandoned} abandoned`);
  if (orphaned) parts.push(`${orphaned} orphaned`);
  if (crashed) parts.push(`${crashed} crashed`);
  if (unknown) parts.push(`${unknown} unknown`);
  return parts.join(' · ');
}

function renderWorkspaceLayout(layout: ActiveSessionsLayout, base: string, machineKey?: string): void {
  let first = true;
  for (const ws of layout.workspaces) {
    if (!first) console.log();
    first = false;

    const redundantCloud = ws.key === '__cloud__' && machineKey === CLOUD_MACHINE_KEY;
    const rowBase = redundantCloud ? base : base + '  ';
    if (!redundantCloud) {
      const header = ws.key === '__cloud__'
        ? chalk.magenta.bold('cloud')
        : ws.key === '__unknown__'
          ? chalk.gray.bold('unknown')
          : chalk.cyan.bold(shortCwd(ws.key));
      const wsSessions = [...ws.windows.flatMap(w => w.sessions), ...ws.flat];
      const tally = groupTally(wsSessions);
      console.log(`${base}${header} ${chalk.gray(`(${ws.total})`)}${tally ? chalk.gray(`  ${tally}`) : ''}`);
    }

    for (const win of ws.windows) {
      const host = win.sessions.find((s) => s.host)?.host ?? 'terminal';
      const winHeader = `${chalk.gray(host)} ${chalk.gray('·')} ${chalk.gray(shortWindowLabel(win.windowId))} ${chalk.gray(`(${win.sessions.length})`)}`;
      console.log(rowBase + winHeader);
      for (const s of win.sessions) printActiveRow(s, rowBase + '  ');
    }

    for (const s of ws.flat) printActiveRow(s, rowBase);
  }
}

function printMachineHeader(mg: MachineGroup): void {
  const isCloud = mg.machine === CLOUD_MACHINE_KEY;
  const marker = mg.isLocal ? chalk.cyan('▸ ') : isCloud ? chalk.magenta('▸ ') : chalk.gray('▸ ');
  const name = mg.isLocal ? chalk.bold.cyan(mg.machine) : isCloud ? chalk.bold.magenta(mg.machine) : chalk.bold(mg.machine);
  const here = mg.isLocal ? chalk.cyan('  ← this machine') : '';
  console.log(`${marker}${name} ${chalk.gray(`(${mg.total})`)}${here}`);
}

async function enrichLocalLocators(local: ActiveSession[]): Promise<void> {
  try {
    const ghostty = local.filter(s => s.host === 'ghostty' && s.provenance?.transport !== 'ssh');
    if (ghostty.length > 0) {
      const surfaces = await enumerateGhosttyTabs();
      for (const [sess, tab] of assignGhosttyTabs(ghostty, surfaces)) sess.ghosttyTab = tab;
    }
  } catch {  }

  await enrichTmuxLocators(local, await enumerateGhosttyTabsQuietly());
}

async function enumerateGhosttyTabsQuietly(): Promise<GhosttySurface[]> {
  try {
    return await enumerateGhosttyTabs();
  } catch {
    return [];
  }
}

async function enrichTmuxLocators(local: ActiveSession[], surfaces: GhosttySurface[] = []): Promise<void> {
  try {
    const tmux = local.filter(s => s.provenance?.mux?.kind === 'tmux' && s.provenance.mux.pane);
    if (tmux.length > 0) {
      const sockets = new Set(tmux.map(s => s.provenance!.mux!.socket));
      for (const socket of sockets) {
        const paneMap = await mapPanesToTargets(socket);
        if (paneMap.size === 0) continue;
        const clients = await listClients(socket);
        for (const s of tmux) {
          if (s.provenance!.mux!.socket !== socket) continue;
          const target = paneMap.get(s.provenance!.mux!.pane!);
          if (target) s.tmuxTarget = target;
          s.viewingIn = await resolveViewingIn(s, clients, { paneToTarget: paneMap, ghosttySurfaces: surfaces });
        }
      }
    }
  } catch {  }
}

function hostToken(h: string): string {
  return normalizeHost(h.split('@').pop() || h);
}

export function shouldIncludeLocal(hosts: string[] | undefined, self: string): boolean {
  if (!hosts || hosts.length === 0) return true;
  return hosts.some(h => hostToken(h) === self);
}

export function remoteHostsToDial(hosts: string[] | undefined, self: string): string[] | undefined {
  if (!hosts || hosts.length === 0) return undefined;
  return hosts.filter(h => hostToken(h) !== self);
}

export async function gatherActiveSessions(
  opts: { local?: boolean; hosts?: string[]; forceRefresh?: boolean } = {},
): Promise<{
  sessions: ActiveSession[];
  remoteDeviceCount: number;
  remoteSkipped?: string[];
  remoteDiscoveryFailed?: boolean;
}> {
  const forceRefresh = opts.forceRefresh === true
    || process.env.AGENTS_SESSIONS_FORCE_REFRESH === '1';
  const scoped = (opts.hosts?.length ?? 0) > 0;

  if (opts.local && !scoped) {
    const loaded = await loadLocalActiveSessions({
      forceRefresh,
      gather: async () => {
        const rows = await getActiveSessions({ localOnly: true });
        const self = machineId();
        for (const s of rows) if (!s.machine) s.machine = self;
        return rows;
      },
    });
    return { sessions: loaded.sessions, remoteDeviceCount: 0 };
  }

  if (!opts.local && !scoped) {
    const loaded = await loadFleetActiveSessions({
      forceRefresh,
      gather: () => gatherActiveSessionsLive({ local: false }),
    });
    return {
      sessions: loaded.sessions,
      remoteDeviceCount: loaded.remoteDeviceCount,
      remoteSkipped: loaded.remoteSkipped,
      remoteDiscoveryFailed: loaded.remoteDiscoveryFailed,
    };
  }

  return gatherActiveSessionsLive(opts);
}

async function gatherActiveSessionsLive(
  opts: { local?: boolean; hosts?: string[] } = {},
): Promise<{
  sessions: ActiveSession[];
  remoteDeviceCount: number;
  remoteSkipped: string[];
  remoteDiscoveryFailed: boolean;
}> {
  const self = machineId();
  const local = shouldIncludeLocal(opts.hosts, self)
    ? await getActiveSessions({ localOnly: opts.local })
    : [];
  for (const s of local) if (!s.machine) s.machine = self;

  let remoteDeviceCount = 0;
  let remoteSkipped: string[] = [];
  let remoteDiscoveryFailed = false;
  let merged = local;
  if (!opts.local) {
    const remoteHosts = remoteHostsToDial(opts.hosts, self);
    if (!opts.hosts?.length || (remoteHosts && remoteHosts.length > 0)) {
      const remote = await gatherRemoteActive(remoteHosts);
      remoteDeviceCount = remote.deviceCount;
      remoteSkipped = remote.skipped;
      remoteDiscoveryFailed = remote.discoveryFailed;
      merged = dedupeByMachineSession([...local, ...remote.sessions]);
    }
  }
  return {
    sessions: filterActiveSessionsByHostScope(merged, opts.hosts, self),
    remoteDeviceCount,
    remoteSkipped,
    remoteDiscoveryFailed,
  };
}

async function describeEmptyActiveDiscovery(
  opts: { local?: boolean; hosts?: string[] },
  remoteSkipped: string[] | undefined,
  remoteDiscoveryFailed: boolean | undefined,
): Promise<string> {
  const parts: string[] = [];
  if (!opts.hosts?.length || opts.local) {
    const health = await describeActiveDiscoveryHealth();
    if (health.degradedSources.length > 0) {
      parts.push(`local discovery is degraded (${health.degradedSources.join(', ')} unreachable) — sessions may be hidden, run \`agents doctor\` to diagnose`);
    }
  }
  if (remoteDiscoveryFailed) {
    parts.push('the device list could not be loaded — no peer was reachable to sweep');
  } else if (remoteSkipped && remoteSkipped.length > 0) {
    parts.push(`${remoteSkipped.length} peer(s) went unheard (${remoteSkipped.join(', ')}) — sessions there may be hidden`);
  }
  if (parts.length === 0) return 'No active agent sessions.';
  return `No active agent sessions found, but discovery was degraded: ${parts.join('; ')}.`;
}

async function renderActiveSessions(
  asJson: boolean,
  waitingOnly = false,
  opts: {
    local?: boolean;
    hosts?: string[];
    bookmarksOnly?: boolean;
    statuses?: LiveStatusFilter[];
    routine?: boolean | string;
  } = {},
): Promise<void> {
  const self = machineId();
  const gathered = await gatherActiveSessions(opts);
  const { remoteDeviceCount, remoteSkipped, remoteDiscoveryFailed } = gathered;
  backfillActiveRowsFromIndex(gathered.sessions);
  const merged = opts.bookmarksOnly
    ? gathered.sessions.filter((s) => !!s.sessionId && listBookmarks().has(s.sessionId))
    : gathered.sessions;
  const routineFiltered = filterActiveSessionsByRoutine(merged, opts.routine);

  const statusFiltered = opts.statuses?.length
    ? routineFiltered.filter((session) => opts.statuses!.some((status) => matchesLiveStatus(session, status)))
    : routineFiltered.filter(isRunningLiveSession);
  const sessions = statusFiltered;

  if (asJson) {
    await enrichTmuxLocators(sessions.filter(s => sessionProcessIsLocal(s, self)));
    process.stdout.write(JSON.stringify(serializeActiveSessionsForJson(sessions), null, 2) + '\n');
    if (waitingOnly && sessions.some(isAwaitingUser)) process.exitCode = 1;
    return;
  }

  if (sessions.length === 0) {
    if (waitingOnly) {
      console.log(chalk.gray('No sessions waiting on input.'));
      return;
    }
    console.log(chalk.gray(await describeEmptyActiveDiscovery(opts, remoteSkipped, remoteDiscoveryFailed)));
    if (!opts.local && !opts.hosts?.length && remoteDeviceCount === 0) printCrossMachineTip();
    return;
  }

  await enrichLocalLocators(sessions.filter(s => sessionProcessIsLocal(s, self)));

  const grouped = groupSessionsByMachine(sessions, self);
  let firstMachine = true;
  for (const mg of grouped.machines) {
    if (!firstMachine) console.log();
    firstMachine = false;
    printMachineHeader(mg);
    renderWorkspaceLayout(mg.layout, '  ', mg.machine);
  }

  const parts = groupTally(sessions).split(' · ').filter(Boolean);
  const realMachines = grouped.machines.filter((m) => m.machine !== CLOUD_MACHINE_KEY).length;
  const hasCloud = grouped.machines.some((m) => m.machine === CLOUD_MACHINE_KEY);
  const machineWord = realMachines === 1 ? 'machine' : 'machines';
  const cloudNote = hasCloud ? ' + cloud' : '';
  console.log(chalk.gray(`\n${sessions.length} active (${parts.join(', ')}) across ${realMachines} ${machineWord}${cloudNote}.`));

  if (!opts.local && !opts.hosts?.length && remoteDeviceCount === 0) printCrossMachineTip();

  if (waitingOnly && sessions.some(isAwaitingUser)) process.exitCode = 1;
}

export function filterActiveSessionsByRoutine(
  sessions: ActiveSession[],
  routine: boolean | string | undefined,
): ActiveSession[] {
  if (!routine) return sessions;
  const routineSessions = sessions.filter((session) =>
    session.origin === 'routine' || !!session.routineName,
  );
  if (typeof routine !== 'string') return routineSessions;
  const names = [...new Set(
    routineSessions.map((session) => session.routineName).filter((name): name is string => !!name),
  )];
  const selected = resolveRoutineName(routine, names);
  return selected
    ? routineSessions.filter((session) => session.routineName === selected)
    : [];
}

export type LiveStatusFilter =
  | 'working'
  | 'idle'
  | 'waiting'
  | 'orphaned'
  | 'crashed'
  | 'closed'
  | 'abandoned'
  | 'queued'
  | 'unknown';

export function matchesLiveStatus(session: ActiveSession, status: LiveStatusFilter): boolean {
  if (status === 'working') return session.activity === 'working' || (!session.activity && session.status === 'running');
  if (status === 'waiting') return isAwaitingUser(session);
  return session.status === status;
}

export function requestedLiveStatuses(options: SessionsOptions): LiveStatusFilter[] {
  const statuses: LiveStatusFilter[] = [];
  if (options.working) statuses.push('working');
  if (options.idle) statuses.push('idle');
  if (options.waiting) statuses.push('waiting');
  if (options.orphan || options.orphaned) statuses.push('orphaned');
  if (options.crashed) statuses.push('crashed');
  if (options.closed) statuses.push('closed');
  if (options.abandoned) statuses.push('abandoned');
  if (options.queued) statuses.push('queued');
  if (options.unknown) statuses.push('unknown');
  return [...new Set(statuses)];
}

function printCrossMachineTip(): void {
  console.log(chalk.gray(
    "\nTip: include sessions from your other machines — register them with 'ag devices sync', then rerun. Use --local to skip.",
  ));
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

export function resolveRoutineName(query: string, names: readonly string[]): string | null {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return null;
  const exact = names.find((name) => name.toLowerCase() === normalized);
  if (exact) return exact;
  const containing = names.filter((name) => name.toLowerCase().includes(normalized));
  if (containing.length === 1) return containing[0];
  return fuzzyMatch(query, names, FUZZY_PRESETS.dynamic);
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

const SESSION_DETAIL_MAX_MESSAGES = 8;
const SESSION_DETAIL_MESSAGE_MAX_CHARS = 4_000;

export interface SessionDetailMessage {
  role: 'user' | 'assistant';
  text: string;
  at: string | null;
}

function sessionTranscriptStamp(session: SessionMeta): { fileMtimeMs: number; fileSize: number } | undefined {
  try {
    if (!session.filePath) return undefined;
    const stat = fs.statSync(session.filePath);
    return { fileMtimeMs: stat.mtimeMs, fileSize: stat.size };
  } catch { return undefined; }
}

export function buildSessionDetailBlock(
  session: SessionMeta,
  digest: SessionPreviewDigest | undefined,
  events: SessionEvent[],
  sourceStamp?: { fileMtimeMs: number; fileSize: number },
): {
  request: unknown;
  timeline: unknown;
  files: unknown;
  messages: SessionDetailMessage[];
  sourceRevision: string | null;
  partial: boolean;
  reason: string | null;
} {
  const bound = (text: string): string => redactSecrets(sanitizeForTerminal(text)).slice(0, SESSION_DETAIL_MESSAGE_MAX_CHARS);
  const stamp = sourceStamp ?? sessionTranscriptStamp(session);
  const canDateEvents = sourceStamp !== undefined || events.length === 0;
  const daemonProjection = stamp ? readSessionTimelineAny(session.id, stamp) : undefined;

  let foldEvents = events;
  if (foldEvents.length === 0 && session.filePath) {
    foldEvents = readSessionTail(session.filePath, session.agent as SessionAgentId);
  }

  let projection: { request?: unknown; timeline: unknown; files?: unknown } | undefined = daemonProjection;
  let onDemand = false;
  if (!projection && foldEvents.length > 0) {
    const state = foldTimeline(foldEvents, emptyTimelineState());
    projection = {
      request: state.request,
      timeline: projectTimeline(state, undefined),
      files: projectSessionFiles(state),
    };
    onDemand = true;
  }

  let messages: SessionDetailMessage[];
  if (foldEvents.length > 0) {
    messages = foldEvents
      .filter((e): e is SessionEvent & { role: 'user' | 'assistant'; content: string } =>
        e.type === 'message' && !e._synthetic && Boolean(e.content) && (e.role === 'user' || e.role === 'assistant'))
      .slice(-SESSION_DETAIL_MAX_MESSAGES)
      .map(e => ({ role: e.role, text: bound(e.content), at: e.timestamp ?? null }));
  } else {
    messages = [];
    if (digest?.firstUser) messages.push({ role: 'user', text: bound(digest.firstUser), at: session.timestamp ?? null });
    if (digest?.lastAssistant) messages.push({ role: 'assistant', text: bound(digest.lastAssistant), at: session.lastActivity ?? null });
  }

  const endStamp = sessionTranscriptStamp(session);
  const unchanged = canDateEvents && stamp !== undefined && endStamp !== undefined
    && stamp.fileMtimeMs === endStamp.fileMtimeMs && stamp.fileSize === endStamp.fileSize;
  const partial = Boolean(digest?.partial) || !daemonProjection || !unchanged;
  const reason = digest?.partialReason
    ?? (onDemand
      ? 'background timeline pass has not reached this session yet; request/timeline/files below are an on-demand bounded fold, not the full-history daemon projection'
      : (!projection ? 'no transcript available to fold request/timeline/files for this session' : null));

  return {
    request: projection?.request ?? null,
    timeline: projection?.timeline ?? null,
    files: projection?.files ?? null,
    messages,
    sourceRevision: unchanged ? new Date(stamp.fileMtimeMs).toISOString() : null,
    partial,
    reason,
  };
}

export async function renderSessionPreview(
  query: string,
  scope: { agent?: string; project?: string; local?: boolean; hosts?: string[]; json?: boolean; refresh?: boolean; revision?: string },
): Promise<void> {
  if (scope.json && !scope.local && scope.hosts?.length === 1
    && scope.hosts[0] !== machineId() && isCompleteSessionId(query.trim())) {
    const { getRemoteSessionPreview } = await import('../lib/session/remote-preview-cache.js');
    const result = await getRemoteSessionPreview(query.trim(), scope.hosts[0], {
      refresh: scope.refresh,
      revision: scope.revision,
    });
    const envelope = result.envelope as {
      session?: unknown; active?: unknown; preview?: unknown; error?: unknown; details?: unknown;
    } | undefined;
    console.log(JSON.stringify({
      schemaVersion: 1,
      session: envelope?.session ?? null,
      active: result.cache.source === 'live' ? (envelope?.active ?? null) : null,
      preview: envelope?.preview ?? null,
      error: envelope?.error ?? (envelope ? null : result.cache.reason),
      details: envelope?.details ?? null,
      cache: result.cache,
    }));
    return;
  }

  let outcome = await resolveSessionMetadataValue(query, scope);
  if (outcome.kind !== 'resolved'
    && (!scope.hosts?.length || shouldIncludeLocal(scope.hosts, machineId()))) {
    const discovered = applyScopeFilters(
      await discoverSessions({ all: true, cwd: process.cwd(), limit: 5000, waitForScan: true }),
      scope,
    );
    const localMatches = resolveSessionQuery(discovered, query, { indexFallback: false, scope }).matches
      .map(session => ({ ...session, machine: session.machine || machineId() }));
    const exact = localMatches.find(session => selectorAllowsEarlyExit(query)
      && session.id.toLowerCase() === query.trim().toLowerCase());
    if (exact) outcome = { kind: 'resolved', session: exact };
    else if (outcome.kind === 'not-found' && localMatches.length > 0) {
      outcome = metadataResolveOutcome(localMatches, { sessions: [], unreachable: [] }, query);
    }
  }
  if (outcome.kind === 'partial') {
    const offline = outcome.failedPeers;
    console.error(chalk.yellow(`Warning: ${offline.length} device(s) unreachable, not checked: ${offline.join(', ')}`));
    console.error(chalk.red(`No session matching "${query}" on any reachable device (${offline.length} unreachable, not checked).`));
    console.error(chalk.gray('  If it lives on an offline box, wake it (agents devices) or run there: agents ssh <device>'));
    process.exitCode = 1;
    return;
  }
  if (outcome.kind === 'not-found') {
    notFoundByIdMessage(query).forEach(l => console.error(l));
    process.exitCode = 1;
    return;
  }
  if (outcome.kind === 'ambiguous') {
    console.error(chalk.red(`Multiple sessions match "${query}" across the fleet:`));
    for (const candidate of outcome.candidates) {
      const match = candidate.hits[0].session;
      const machines = candidate.hits.map(hit => hit.machine).join(', ');
      console.error(chalk.cyan(`  ${match.shortId}  ${match.id}`) + chalk.gray(`  ${machines}  ${match.agent}${match.version ? ` ${match.version}` : ''}`));
    }
    console.error(chalk.gray('Pass the full session ID to narrow it down.'));
    process.exitCode = 1;
    return;
  }

  const session = outcome.session;
  const transcriptPeer = transcriptOnPeerOf(session);
  if (transcriptPeer) {
    const args = ['sessions', 'preview', session.id, '--local'];
    if (scope.json) args.push('--json');
    const rendered = await runOnPeer(args, transcriptPeer);
    if (rendered === 'no-target') {
      console.error(chalk.red(`Session ${session.id} is on ${transcriptPeer}, but that device is not reachable.`));
      process.exitCode = 1;
    }
    return;
  }

  let live: ActiveSession | undefined;
  try {
    const loaded = await loadLocalActiveSessions();
    live = indexActiveBySessionId(loaded.sessions).get(session.id);
  } catch {  }
  if (scope.json) {
    const sourceStamp = sessionTranscriptStamp(session);
    const { digest, error, events } = loadSessionPreviewDigest(session);
    console.log(JSON.stringify({
      schemaVersion: 1,
      session: {
        id: session.id,
        shortId: session.shortId,
        agent: session.agent,
        version: session.version,
        model: session.model,
        account: session.account,
        machine: session.machine ?? machineId(),
        cwd: session.cwd,
        project: session.project,
        gitBranch: session.gitBranch,
        createdAt: session.timestamp,
        lastActivity: session.lastActivity,
        durationMs: session.durationMs,
        messageCount: session.messageCount,
        tokenCount: session.tokenCount,
        costUsd: session.costUsd,
        label: session.label,
        topic: session.topic,
        ticketId: session.ticketId,
        prUrl: session.prUrl,
      },
      active: live ? {
        status: live.status,
        activity: live.activity,
        awaitingReason: live.awaitingReason,
        lastActivityMs: live.lastActivityMs,
        startedAtMs: live.startedAtMs,
        pid: live.pid,
        host: live.host,
      } : null,
      preview: digest ?? null,
      error: error ?? null,
      details: buildSessionDetailBlock(session, digest, events, sourceStamp),
    }));
    return;
  }
  const headline = formatLiveStatusHeadline(live, isBookmarked(session.id));
  if (headline) console.log(headline);
  console.log(buildPreview(session));
}

export function formatLiveStatusHeadline(live: ActiveSession | undefined, bookmarked = false): string {
  const star = bookmarked ? chalk.yellow('★ ') : '';
  if (!live) return bookmarked ? chalk.yellow('★ bookmarked') : '';
  const { glyph } = liveGlyphAndPreview(live);
  const word = liveStatusWord(live) || live.status;
  const needsYou = isAwaitingUser(live);
  const reason = live.awaitingReason ? ` (${live.awaitingReason.replace('_', ' ')})` : '';
  let suffix = needsYou ? chalk.yellow(`  ← needs you${reason}`) : '';
  if (live.status === 'crashed') {
    suffix = chalk.redBright('  ← the host app or connection went away and took the agent with it');
  } else if (live.status === 'orphaned') {
    suffix = needsYou
      ? chalk.yellow(`  ← waiting on you${reason}, and no client is attached to answer it`)
      : chalk.yellow('  ← still running, but no client is attached — nothing is showing it');
  }
  return `${star}${glyph} ${statusColor(live.status)(word)}${suffix}`;
}

export function mergeToolSearchEnvelopes(
  local: ToolSearchEnvelope,
  remotes: ToolSearchEnvelope[],
): ToolSearchEnvelope {
  const all = [local, ...remotes];
  const sessions = new Map<string, ToolSearchEnvelope['sessions'][number]>();
  for (const envelope of all) {
    for (const session of envelope.sessions) {
      sessions.set(`${session.machine ?? 'local'}\0${session.id}`, session);
    }
  }
  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    query: local.query,
    coverage: {
      indexedFiles: all.reduce((n, envelope) => n + envelope.coverage.indexedFiles, 0),
      indexedCalls: all.reduce((n, envelope) => n + envelope.coverage.indexedCalls, 0),
      skippedFiles: all.reduce((n, envelope) => n + envelope.coverage.skippedFiles, 0),
      limitedFiles: all.reduce((n, envelope) => n + envelope.coverage.limitedFiles, 0),
      remainingFiles: all.reduce((n, envelope) => n + envelope.coverage.remainingFiles, 0),
      complete: all.every((envelope) => envelope.coverage.complete),
    },
    sessions: [...sessions.values()].sort((a, b) => b.timestamp.localeCompare(a.timestamp)),
  };
}

export function mergeToolProgramCountEnvelopes(
  local: ToolProgramCountEnvelope,
  remotes: ToolProgramCountEnvelope[],
): ToolProgramCountEnvelope {
  const all = [local, ...remotes];
  return {
    schemaVersion: 1,
    kind: 'tool-program-count',
    generatedAt: new Date().toISOString(),
    query: local.query,
    coverage: {
      indexedFiles: all.reduce((sum, envelope) => sum + envelope.coverage.indexedFiles, 0),
      indexedCalls: all.reduce((sum, envelope) => sum + envelope.coverage.indexedCalls, 0),
      skippedFiles: all.reduce((sum, envelope) => sum + envelope.coverage.skippedFiles, 0),
      limitedFiles: all.reduce((sum, envelope) => sum + envelope.coverage.limitedFiles, 0),
      remainingFiles: all.reduce((sum, envelope) => sum + envelope.coverage.remainingFiles, 0),
      complete: all.every((envelope) => envelope.coverage.complete),
    },
    totals: {
      occurrences: all.reduce((sum, envelope) => sum + envelope.totals.occurrences, 0),
      toolCalls: all.reduce((sum, envelope) => sum + envelope.totals.toolCalls, 0),
      sessions: all.reduce((sum, envelope) => sum + envelope.totals.sessions, 0),
    },
    machines: all.flatMap((envelope) => envelope.machines),
  };
}

export function toolOriginSessions(
  sessions: SessionMeta[],
  machine: string,
  originOnly: boolean,
): SessionMeta[] {
  return originOnly
    ? sessions.filter((session) => (session.machine ?? machine) === machine)
    : sessions;
}

function printToolProgramCount(envelope: ToolProgramCountEnvelope): void {
  const { totals } = envelope;
  const qualifier = envelope.coverage.complete ? '' : 'at least ';
  console.log(
    `${envelope.query.program}: ${qualifier}${totals.occurrences.toLocaleString()} static occurrence${totals.occurrences === 1 ? '' : 's'} `
    + `in ${totals.toolCalls.toLocaleString()} tool call${totals.toolCalls === 1 ? '' : 's'} `
    + `across ${totals.sessions.toLocaleString()} session${totals.sessions === 1 ? '' : 's'}.`,
  );
  if (!envelope.coverage.complete) {
    console.log(chalk.yellow(
      `Partial tool index: ${envelope.coverage.remainingFiles.toLocaleString()} transcript${envelope.coverage.remainingFiles === 1 ? '' : 's'} still need `
      + '`agents sessions backfill tools`.',
    ));
  }
}

export function toolSearchFleetSortError(sort: string | undefined, spansDevices: boolean): string | undefined {
  if (!spansDevices || !sort || sort === 'recent') return undefined;
  return 'Tool search across devices supports only --sort recent; cost and duration are local-only.';
}

function printToolSearch(envelope: ToolSearchEnvelope): void {
  for (const session of envelope.sessions) {
    const machineName = session.machine
      ? truncate(sanitizeForTerminal(session.machine).replace(/\s+/g, ' '), 80)
      : '';
    const machine = machineName ? ` @ ${machineName}` : '';
    const rawHeading = sessionHeadline(session) || session.project || session.shortId;
    const heading = truncate(
      sanitizeForTerminal(rawHeading).replace(/\s+/g, ' '),
      Math.max(30, terminalWidth() - 20),
    );
    console.log(`${chalk.cyan(session.shortId)}${chalk.gray(machine)}  ${heading}`);
    for (const call of session.calls) {
      const tool = truncate(sanitizeForTerminal(call.tool).replace(/\s+/g, ' '), 80);
      const safePrograms = call.programs.map((program) =>
        truncate(sanitizeForTerminal(program).replace(/\s+/g, ' '), 80));
      const programs = safePrograms.length > 0 ? ` [${safePrograms.join(', ')}]` : '';
      const status = call.outcome === 'unknown' ? '' : ` ${call.outcome}`;
      const input = truncate(
        sanitizeForTerminal(call.input).replace(/\s+/g, ' '),
        Math.max(30, terminalWidth() - 26),
      );
      console.log(`  ${chalk.gray(`#${call.ordinal + 1}`)} ${tool}${programs}${status}  ${input}`);
      const snippet = call.error || call.output;
      if (snippet) {
        console.log(`     ${chalk.gray(truncate(
          sanitizeForTerminal(snippet).replace(/\s+/g, ' '),
          Math.max(30, terminalWidth() - 8),
        ))}`);
      }
    }
    console.log();
  }
  const count = envelope.sessions.length;
  console.log(chalk.gray(`${count} matching session${count === 1 ? '' : 's'}.`));
  if (!envelope.coverage.complete) {
    const skipped = envelope.coverage.skippedFiles > 0
      ? ` ${envelope.coverage.skippedFiles} transcript${envelope.coverage.skippedFiles === 1 ? ' was' : 's were'} skipped.`
      : '';
    const limited = envelope.coverage.limitedFiles > 0
      ? ` ${envelope.coverage.limitedFiles} transcript${envelope.coverage.limitedFiles === 1 ? ' has' : 's have'} incomplete evidence because a safety limit was reached.`
      : '';
    const retry = envelope.coverage.remainingFiles > 0
      ? ' Run `agents sessions backfill tools` to index historical transcripts.'
      : '';
    console.log(chalk.yellow(
      `Tool index coverage is partial: ${envelope.coverage.remainingFiles} transcript${envelope.coverage.remainingFiles === 1 ? '' : 's'} remain.${skipped}${limited}${retry}`,
    ));
  }
}

async function sessionsAction(
  query: string | undefined,
  options: SessionsOptions,
  limitSource?: string
): Promise<void> {
  const queryClauses = options.query ?? [];
  const liveStatuses = requestedLiveStatuses(options);
  const liveOnly = options.active === true || liveStatuses.length > 0;
  const toolOnly = options.include?.split(',').map((role) => role.trim()).filter(Boolean).join(',') === 'tools';
  const toolEvidenceMode = toolOnly;
  if (options.count && !toolOnly) {
    console.error(chalk.red('--count requires --include tools.'));
    process.exitCode = 1;
    return;
  }
  if (!toolEvidenceMode) {
    if (queryClauses.length > 1) {
      console.error(chalk.red('Repeated --query clauses require --include tools.'));
      process.exitCode = 1;
      return;
    }
    query = query ?? queryClauses[0];
  }
  if (options.fleet && !toolEvidenceMode) {
    console.error(chalk.red('--fleet applies to tool-call queries: add --include tools.'));
    process.exitCode = 1;
    return;
  }
  if (toolEvidenceMode && (options.markdown || options.redact === false)) {
    const incompatible = [
      options.markdown ? '--markdown' : undefined,
      options.redact === false ? '--no-redact' : undefined,
    ].filter((flag): flag is string => flag !== undefined);
    console.error(chalk.red(`${incompatible.join(' and ')} cannot be used with --include tools.`));
    console.error(chalk.gray('Tool evidence is always redacted and byte-bounded; drop the conflicting render flag.'));
    process.exitCode = 1;
    return;
  }
  if (toolEvidenceMode && queryClauses.length > TOOL_QUERY_MAX_CLAUSES) {
    console.error(chalk.red(`Tool search accepts at most ${TOOL_QUERY_MAX_CLAUSES} --query clauses.`));
    process.exitCode = 1;
    return;
  }
  if (toolEvidenceMode && queryClauses.some((clause) => Buffer.byteLength(clause) > TOOL_QUERY_MAX_CLAUSE_BYTES)) {
    console.error(chalk.red(`Each tool --query clause is limited to ${TOOL_QUERY_MAX_CLAUSE_BYTES} bytes.`));
    process.exitCode = 1;
    return;
  }
  if (options.count && (queryClauses.length !== 1 || query !== undefined)) {
    console.error(chalk.red('--count requires exactly one --query program:<name> clause and no positional query.'));
    process.exitCode = 1;
    return;
  }
  if (options.count && (limitSource === 'cli' || limitSource === 'env')) {
    console.error(chalk.red('--count covers the complete filtered scope and cannot be combined with --limit.'));
    process.exitCode = 1;
    return;
  }
  let countProgram: string | undefined;
  if (options.count) {
    try {
      countProgram = parseToolProgramCountClause(queryClauses[0]);
    } catch (error) {
      console.error(chalk.red(error instanceof Error ? error.message : String(error)));
      process.exitCode = 1;
      return;
    }
  }

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

  if (toolEvidenceMode && options.local === true
    && options.host && !shouldIncludeLocal(options.host, machineId())) {
    console.error(chalk.red('--local and --device name opposite scopes: --local skips the SSH fan-out that --device needs.'));
    console.error(chalk.gray('Drop one — `--device <box>` to read that machine, `--local` to stay on this one.'));
    process.exit(1);
  }

  if (options.host && options.host.length > 0 && !liveOnly && !toolEvidenceMode) {
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

    if (
      useInteractiveBrowser(options) &&
      liveStatuses.length === 0 &&
      !options.until &&
      !options.project &&
      !options.sort &&
      (options.host?.length ?? 0) <= 1 &&
      process.env.AGENTS_SESSIONS_LOCAL !== '1'
    ) {
      const { runSessionBrowser, activeBrowserSeed } = await import('./sessions-browser.js');
      await runSessionBrowser(
        activeBrowserSeed({
          teams: options.teams,
          agent: options.agent,
          host: options.host,
          since: options.since,
          all: options.all,
          bookmarks: options.bookmarks,
          routine: options.routine,
        }),
        { local: options.local === true, hosts: options.host },
      );
      return;
    }
    const forceLocal = options.local === true || process.env.AGENTS_SESSIONS_LOCAL === '1';
    await renderActiveSessions(options.json === true, options.waiting === true, {
      local: forceLocal,
      hosts: options.host,
      bookmarksOnly: options.bookmarks === true,
      statuses: liveStatuses,
      routine: options.routine,
    });
    return;
  }

  if (options.cloud) {
    await runCloudSessions(query, options);
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
  const wantsRender = !toolEvidenceMode && (mode === 'markdown' || hasAnyFilter(filterOpts));

  if ((options.artifacts || options.artifact !== undefined) && searchQuery) {
    await renderArtifactsGlobal(
      searchQuery,
      options.artifacts ?? false,
      options.artifact,
      artifactLookupScope(options.agent, options.project, options.routine),
    );
    return;
  }

  if (!toolEvidenceMode && searchQuery && looksLikeSessionId(searchQuery)) {
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
  if (toolEvidenceMode && (!Number.isSafeInteger(limit) || limit < 1 || limit > TOOL_QUERY_MAX_RESULT_SESSIONS)) {
    console.error(chalk.red(`Tool search --limit must be from 1 to ${TOOL_QUERY_MAX_RESULT_SESSIONS}.`));
    process.exitCode = 1;
    return;
  }
  const since = wantsOverview
    ? options.since
    : (options.since ?? (isInteractive && !options.all && !wantsWholeTeam && !wantsWholeRoutine ? '30d' : undefined));
  const toolSpansDevices = toolEvidenceMode
    && (options.fleet || (options.host?.length ?? 0) > 0);
  const toolSortError = toolSearchFleetSortError(options.sort, toolSpansDevices);
  if (toolSortError) {
    console.error(chalk.red(toolSortError));
    process.exitCode = 1;
    return;
  }
  const spinner = options.json ? null : ora().start();
  const tracker = createScanProgressTracker(LOAD_VERBS, 'sessions', spinner);

  try {
    const sortBy: DiscoverOptions['sortBy'] =
      options.sort === 'cost' ? 'cost' : options.sort === 'duration' ? 'duration' : 'timestamp';

    const scope: DiscoverOptions = {
      agent,
      version,
      all: pathFilter ? undefined : options.all || wantsWholeTeam || wantsWholeRoutine || toolSpansDevices,
      cwd: process.cwd(),
      cwdPrefix: pathFilter ?? (wantsOverview && !options.all && !wantsWholeTeam && !wantsWholeRoutine && !toolSpansDevices ? process.cwd() : undefined),
      project: options.project,
      since,
      until: options.until,
      sortBy,
      origin: options.routine ? 'routine' : undefined,
      skipExistenceCheck: toolEvidenceMode,
      unbounded: toolEvidenceMode,
      skill: options.skill,
      plugin: options.plugin,
    };

    let hiddenUnmanaged = 0;
    const toolSelf = toolEvidenceMode ? machineId() : undefined;
    const toolIncludesLocal = !toolEvidenceMode
      || process.env[NO_FANOUT_ENV] === '1'
      || shouldIncludeLocal(options.host, toolSelf!);
    const indexedIdMatches = toolIncludesLocal && toolEvidenceMode && searchQuery && looksLikeSessionId(searchQuery)
      ? scopeToManaged(
          findSessionsById(searchQuery, { agent, version, project: options.project }),
          agent ? [agent] : SESSION_AGENTS,
          { agent, includeUnmanaged: options.unmanaged },
        )
      : [];
    let sessions: SessionMeta[];
    if (!toolIncludesLocal) {
      sessions = [];
    } else if (indexedIdMatches.length > 0) {
      sessions = indexedIdMatches.map((session) => ({
        ...session,
        machine: session.machine ?? toolSelf,
      }));
    } else {
      const readOptions: DiscoverOptions = {
        ...scope,
        limit,
        excludeTeamOrigin: !shouldShowTeamSessions(options),
        onProgress: tracker.onProgress,
        includeUnmanaged: options.unmanaged,
        onHiddenUnmanaged: (n) => { hiddenUnmanaged = n; },
      };
      sessions = toolEvidenceMode
        ? await queryIndexedSessions(readOptions, { resolveLinear: false })
        : await discoverSessions(readOptions);
    }

    tracker.stop();
    spinner?.stop();

    const { visible: visibleSessions } = filterTeamSessions(sessions, shouldShowTeamSessions(options));
    sessions = visibleSessions;

    if (options.inTeam) sessions = sessions.filter((s) => matchesTeam(s, options.inTeam!));

    if (options.bookmarks) {
      const bookmarks = listBookmarks();
      sessions = sessions.filter((s) => bookmarks.has(s.id));
    }

    if (toolEvidenceMode) {
      const self = toolSelf!;
      const selectedSessions = searchQuery
        ? filterSessionsByQuery(sessions, searchQuery, {
            agent: options.agent,
            project: options.project,
            routine: options.routine,
          })
        : sessions;
      const localSessions = selectedSessions;
      const mayFanOut = options.local !== true && process.env[NO_FANOUT_ENV] !== '1';
      const hosts = remoteHostsToDial(options.host, self);
      const originOnly = process.env[NO_FANOUT_ENV] === '1'
        || (mayFanOut && (options.fleet || (options.host?.length ?? 0) > 0));
      const querySessions = toolOriginSessions(localSessions, self, originOnly);

      if (countProgram) {
        const countCoverage = readToolIndexCoverage(querySessions);
        let countEnvelope = countToolProgramOccurrences(querySessions, countProgram, countCoverage, self);
        if (!toolIncludesLocal) countEnvelope.machines = [];
        if (mayFanOut && (options.fleet || (options.host?.length ?? 0) > 0)
          && (!options.host?.length || (hosts && hosts.length > 0))) {
          const stripped = toolSearchForwardedArgs(process.argv, options.host ?? []);
          const remote = await gatherRemoteToolProgramCounts(
            stripped,
            options.host?.length ? hosts : undefined,
            countProgram,
          );
          countEnvelope = mergeToolProgramCountEnvelopes(
            countEnvelope,
            remote.envelopes.map((item) => item.envelope),
          );
          if (remote.unreachable.length > 0) countEnvelope.coverage.complete = false;
        }
        if (options.json) process.stdout.write(JSON.stringify(countEnvelope, null, 2) + '\n');
        else printToolProgramCount(countEnvelope);
        return;
      }

      const coverage = readToolIndexCoverage(querySessions);
      let envelope = searchToolCalls(querySessions, queryClauses, coverage, limit);

      if (mayFanOut && (options.fleet || (options.host?.length ?? 0) > 0)) {
        if (!options.host?.length || (hosts && hosts.length > 0)) {
          const stripped = toolSearchForwardedArgs(process.argv, options.host ?? []);
          const remote = await gatherRemoteToolSearch(
            stripped,
            options.host?.length ? hosts : undefined,
            toolSearchRemoteReceiveBudget(envelope),
            queryClauses,
          );
          envelope = mergeToolSearchEnvelopes(envelope, remote.envelopes.map((item) => item.envelope));
          if (remote.truncated.length > 0 || remote.unreachable.length > 0) {
            envelope.coverage.complete = false;
          }
        }
      }

      envelope.sessions = envelope.sessions.slice(0, limit);

      const serializedEnvelope = serializeToolSearchEnvelope(envelope);
      if (options.json) {
        process.stdout.write(serializedEnvelope);
      } else {
        printToolSearch(envelope);
      }
      return;
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

function teamTag(session: SessionMeta): string {
  const origin = session.teamOrigin;
  if (!origin) return '';
  const handle = safeTeamText(origin.handle);
  const team = safeTeamText(origin.team);
  if (team) return `[${team}${handle ? `/${handle}` : ''}] `;
  return handle ? `[${handle}] ` : '[team] ';
}

export function matchesTeam(session: SessionMeta, team: string): boolean {
  const want = safeTeamText(team)?.trim().toLowerCase();
  if (!want) return true;
  return (
    safeTeamText(session.spawnedTeam)?.toLowerCase() === want ||
    safeTeamText(session.teamOrigin?.team)?.toLowerCase() === want
  );
}

const TEAM_BADGE_MAX = 10;

export function teamBadge(session: SessionMeta): { plain: string; width: number } {
  const team = safeTeamText(session.spawnedTeam);
  if (!team) return { plain: '', width: 0 };
  const plain = `team:${truncate(team, TEAM_BADGE_MAX)} `;
  return { plain, width: stringWidth(plain) };
}

function originTag(session: SessionMeta): string {
  if (session.origin !== 'routine') return '';
  return `[routine${session.routineName ? ` · ${session.routineName}` : ''}] `;
}

function metaSignals(s: SessionMeta): Parameters<typeof signalBadges>[0] {
  return {
    pr: s.prUrl ? { url: s.prUrl, number: s.prNumber } : undefined,
    worktree: s.worktreeSlug ? { path: s.cwd ?? '', slug: s.worktreeSlug } : undefined,
    ticket: s.ticketId ? { id: s.ticketId } : undefined,
  };
}

const MIN_TOPIC_W = 16;

function timeCell(age: SessionAgeParts, topicSlack: number): { plain: string; text: string; extraW: number } {
  const lastOnly = { plain: age.last, text: chalk.gray(age.last), extraW: 0 };
  if (!age.created) return lastOnly;
  const prefix = `${age.created} → `;
  const extraW = stringWidth(prefix);
  if (topicSlack - extraW < MIN_TOPIC_W) return lastOnly;
  return { plain: prefix + age.last, text: chalk.dim(prefix) + chalk.gray(age.last), extraW };
}

export function flatSessionRow(
  session: SessionMeta,
  live?: ActiveSession,
  showTicket = false,
  cols: PickerColumns = {},
  bookmarked = false,
): string {
  const shown = sessionDisplayAgent(session);
  const agentColor = colorAgent(shown);
  const age = sessionAgeParts(session.timestamp, session.lastActivity);
  const project = session.project || '-';
  const tag = originTag(session) || teamTag(session);
  const label = (session as any).label;
  const { glyph, preview } = liveGlyphAndPreview(live);
  const restingTodo = !live ? formatTodoCompact(session.todos) : '';
  const topicBase = tag ? `${tag}${session.topic ?? ''}` : session.topic;
  const doing = [restingTodo, preview || topicBase].filter(Boolean).join(' · ') || undefined;
  const wt = session.worktreeSlug ? chalk.magenta(`wt:${session.worktreeSlug}`) : '';
  const team = teamBadge(session);
  const teamSeg = team.plain ? chalk.green(team.plain) : '';

  const machineColW = cols.machineWidth ?? PICKER_MACHINE_W;
  const machineCell = cols.showMachine
    ? chalk.gray(padToWidth(truncateToWidth((cols.machineLabel?.(session.machine ?? '') ?? session.machine ?? '') || '-', machineColW - 1), machineColW))
    : '';

  const TICKET_W = 10;
  const ticketCell = showTicket
    ? chalk.blue(linkTicketCell(session, padToWidth(truncateToWidth(ticketLabel(session) || '-', TICKET_W), TICKET_W + 1)))
    : '';
  const { cell: statusCell, width: statusW } = liveStatusCell(live);
  const glyphW = glyph ? 2 : 0;
  const machineW = cols.showMachine ? machineColW : 0;
  const ticketW = showTicket ? TICKET_W + 1 : 0;
  const wtW = wt ? stringWidth(wt) + 1 : 0;
  const width = terminalWidth();
  const requestedModelW = cols.showModel ? (cols.modelWidth ?? PICKER_MODEL_MAX) : 0;
  const bookmarkW = cols.showBookmark ? 2 : 0;
  const bookmarkCell = cols.showBookmark ? (bookmarked ? chalk.yellow('★ ') : '  ') : '';
  const fixedW = bookmarkW + (10 + 9 + 8 + 16) + glyphW + statusW + machineW + ticketW + wtW + team.width + stringWidth(age.last) + 1;
  const modelSlack = width - fixedW - MIN_TOPIC_W;
  const modelW = requestedModelW <= modelSlack
    ? requestedModelW
    : modelSlack >= PICKER_MODEL_MIN ? modelSlack : 0;
  const when = timeCell(age, width - fixedW - modelW);
  const topicW = Math.max(MIN_TOPIC_W, width - fixedW - modelW - when.extraW);

  return (
    bookmarkCell +
    chalk.white(padToWidth(truncateToWidth(session.shortId, 9), 10)) +
    agentColor(padToWidth(truncateToWidth(shown, 8), 9)) +
    chalk.yellow(padToWidth(truncateToWidth(session.version || '-', 7), 8)) +
    (modelW ? chalk.yellow(padToWidth(truncateToWidth(modelLabel(session.model), modelW - 1), modelW)) : '') +
    machineCell +
    chalk.cyan(linkCwdCell(session, padToWidth(truncateToWidth(project, 14), 16))) +
    (glyph ? glyph + ' ' : '') +
    statusCell +
    teamSeg +
    renderTopicCell(label, doing, '', topicW, topicW) +
    ticketCell +
    (wt ? wt + ' ' : '') +
    when.text
  );
}

function treeSessionRow(session: SessionMeta, live?: ActiveSession): string {
  const shown = sessionDisplayAgent(session);
  const agentColor = colorAgent(shown);
  const age = sessionAgeParts(session.timestamp, session.lastActivity);
  const tag = originTag(session) || teamTag(session);
  const label = (session as any).label;
  const { glyph, preview } = liveGlyphAndPreview(live);
  const restingTodo = !live ? formatTodoCompact(session.todos) : '';
  const topicBase = preview || (tag ? `${tag}${session.topic ?? ''}` : session.topic);
  const topic = [restingTodo, topicBase].filter(Boolean).join(' · ') || '-';
  const badges = signalBadges(metaSignals(session));
  const badgeW = badges ? stringWidth(badges) + 1 : 0;
  const team = teamBadge(session);
  const teamSeg = team.plain ? chalk.green(team.plain) : '';
  const head = label ? `${label} · ${topic}` : topic;
  const { cell: statusCell, width: statusW } = liveStatusCell(live);
  const glyphW = glyph ? 2 : 0;
  const baseTopicW = terminalWidth() - (2 + 9 + 8) - glyphW - statusW - badgeW - team.width - stringWidth(age.last) - 1;
  const when = timeCell(age, baseTopicW);
  const topicW = Math.max(12, baseTopicW - when.extraW);

  return (
    '  ' +
    chalk.dim(padToWidth(session.shortId, 9)) +
    agentColor(padToWidth(truncateToWidth(shown, 7), 8)) +
    (badges ? badges + ' ' : '') +
    (glyph ? glyph + ' ' : '') +
    statusCell +
    teamSeg +
    padToWidth(chalk.white(truncateToWidth(head, topicW)), topicW) +
    ' ' + when.text
  );
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

function printSessionTable(sessions: SessionMeta[], hiddenCount = 0, tree = false, liveIndex?: Map<string, ActiveSession>): void {
  if (tree) {
    const byDir = new Map<string, SessionMeta[]>();
    for (const s of sessions) {
      const key = s.cwd || s.project || 'unknown';
      (byDir.get(key) ?? byDir.set(key, []).get(key)!).push(s);
    }
    const keys = [...byDir.keys()].sort((a, b) => {
      const d = byDir.get(b)!.length - byDir.get(a)!.length;
      return d !== 0 ? d : a.localeCompare(b);
    });
    let first = true;
    for (const key of keys) {
      if (!first) console.log();
      first = false;
      const group = byDir.get(key)!;
      const cwd = group.find((s) => s.cwd && !s._remote)?.cwd;
      const header = cwd ? linkPath(cwd, shortCwd(key)) : shortCwd(key);
      console.log(`${chalk.cyan.bold(header)} ${chalk.gray(`(${group.length})`)}`);
      for (const s of group) console.log(treeSessionRow(s, liveIndex?.get(s.id)));
    }
    const dirWord = keys.length === 1 ? 'directory' : 'directories';
    console.log(chalk.gray(`\n${sessions.length} session${sessions.length === 1 ? '' : 's'} across ${keys.length} ${dirWord}.`));
    if (hiddenCount > 0) console.log(chalk.gray(formatTeamHiddenFooter(hiddenCount)));
    return;
  }

  const showTicket = sessions.some((s) => ticketLabel(s) !== '');
  const cols = pickerColumnsFor(sessions);
  const bookmarks = listBookmarks();
  for (const session of sessions) {
    console.log(flatSessionRow(session, liveIndex?.get(session.id), showTicket, cols, bookmarks.has(session.id)));
  }

  const countLine = `${sessions.length} session${sessions.length === 1 ? '' : 's'}.`;
  console.log(chalk.gray(`\n${countLine}`));
  if (hiddenCount > 0) {
    console.log(chalk.gray(formatTeamHiddenFooter(hiddenCount)));
  }
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

function buildFilterOptions(options: SessionsOptions): FilterOptions {
  const opts: FilterOptions = {};
  if (options.include) opts.include = parseRoleList(options.include, '--include');
  if (options.exclude) opts.exclude = parseRoleList(options.exclude, '--exclude');
  if (opts.include && opts.exclude) {
    throw new Error('--include and --exclude are mutually exclusive');
  }
  const parseCount = (raw: string, flag: string): number => {
    const n = Number(raw);
    if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) {
      throw new Error(`${flag} expects a positive integer, got "${raw}"`);
    }
    return n;
  };
  if (options.first !== undefined) opts.first = parseCount(options.first, '--first');
  if (options.last !== undefined) opts.last = parseCount(options.last, '--last');
  if (opts.first !== undefined && opts.last !== undefined) {
    throw new Error('--first and --last are mutually exclusive');
  }
  return opts;
}

function hasAnyFilter(opts: FilterOptions): boolean {
  return !!(opts.include?.length || opts.exclude?.length || opts.first !== undefined || opts.last !== undefined);
}

function resolveViewMode(options: SessionsOptions, filters: FilterOptions): ViewMode {
  if (options.markdown) return 'markdown';
  if (options.json) return 'json';
  if (hasAnyFilter(filters)) return 'markdown';
  return 'summary';
}

export async function renderSessionLog(session: SessionMeta, mode: ViewMode = 'summary'): Promise<void> {
  await renderSession(session, mode, {});
}

export async function renderSessionLogJson(session: SessionMeta): Promise<void> {
  await renderSession(session, 'json', {});
}

function renderArchivedSession(
  session: SessionMeta,
  mode: ViewMode,
  options: { redact?: boolean } = {},
): void {
  const redact = (text: string): string => options.redact !== false ? redactSecrets(text) : text;
  const content = redact((readSessionContent(session.id) ?? '').trim());
  const digestRaw = readArchivedSessionPreview<SessionPreviewDigest>(session.id);
  const digest = digestRaw
    ? { ...digestRaw, lastAssistant: redact(digestRaw.lastAssistant ?? '') }
    : undefined;
  if (mode === 'json') {
    console.log(JSON.stringify({
      session: {
        ...session,
        topic: session.topic != null ? redact(session.topic) : session.topic,
        label: session.label != null ? redact(session.label) : session.label,
        plan: session.plan != null ? redact(session.plan) : session.plan,
        archived: true,
      },
      archived: true,
      userContent: content,
      preview: digest ?? null,
    }, null, 2));
    return;
  }
  const shown = sessionDisplayAgent(session);
  const agentColor = colorAgent(shown);
  const absTime = formatAbsoluteTime(session.timestamp);
  const title = sessionHeadline(session);
  console.log('');
  if (title) console.log(chalk.bold.white(title));
  console.log(
    agentColor(shown) +
    (session.version ? chalk.yellow(` ${session.version}`) : '') +
    (session.project ? chalk.cyan(`  ${session.project}`) : '') +
    chalk.gray(`  ${absTime} (${formatRelativeTime(session.timestamp)})`) +
    (session.account ? chalk.gray(` · ${session.account}`) : '')
  );
  console.log(chalk.yellow('archived — transcript file removed; user turns served from the local DB'));
  console.log(chalk.gray('─'.repeat(60)));
  console.log(chalk.cyan('User:'));
  console.log(content);
  if (digest?.lastAssistant?.trim()) {
    console.log('');
    console.log(chalk.magenta('Last assistant:'));
    console.log(digest.lastAssistant.trim());
  }
}

async function renderSession(
  session: SessionMeta,
  mode: ViewMode,
  filters: FilterOptions,
  options: { redact?: boolean } = {},
): Promise<void> {
  const { hydrateSessionTranscript, findLocalSessionTranscripts } = await import('../lib/session/discover.js');
  session = await hydrateSessionTranscript(session);
  const realPath = session.filePath.split('#')[0];
  if (!fs.existsSync(realPath)) {
    const archivedContent = readSessionContent(session.id);
    if (archivedContent && archivedContent.trim() !== '') {
      renderArchivedSession(session, mode, options);
      return;
    }
    process.exitCode = 1;
    console.log(chalk.yellow('Session transcript is unavailable after checking its recorded home and the session index.'));
    console.log(chalk.gray(`Path: ${session.filePath}`));
    if (session.version) console.log(chalk.gray(`Version: ${sessionDisplayAgent(session)} ${session.version}`));
    if (session.project) console.log(chalk.gray(`Project: ${session.project}`));
    if (session.account) console.log(chalk.gray(`Account: ${session.account}`));
    console.log(chalk.gray(`Time: ${session.timestamp}`));
    return;
  }

  const spinner = ora(`Parsing ${sessionDisplayAgent(session)} session...`).start();
  const parsedEvents = parseSession(session.filePath, session.agent);
  spinner.stop();

  let events = filterEvents(parsedEvents, filters);

  const shown = sessionDisplayAgent(session);
  const agentColor = colorAgent(shown);
  console.log('');

  if (mode === 'summary') {
    const stats = computeSummaryStats(events);
    const modelStr = stats.models.length > 0 ? chalk.yellow(`  ${stats.models.join(', ')}`) : '';
    const branchStr = session.gitBranch ? chalk.gray(` (${session.gitBranch})`) : '';
    const absTime = formatAbsoluteTime(session.timestamp);

    const title = sessionHeadline(session);
    if (title) {
      const badges = signalBadges(metaSignals(session));
      console.log(chalk.bold.white(title) + (badges ? '  ' + badges : ''));
    }
    console.log(
      agentColor(shown) +
      (session.version ? chalk.yellow(` ${session.version}`) : '') +
      modelStr +
      (session.project ? chalk.cyan(`  ${session.project}`) + branchStr : branchStr) +
      chalk.gray(`  ${absTime} (${formatRelativeTime(session.timestamp)})`) +
      (session.account ? chalk.gray(` · ${session.account}`) : '')
    );
    const statsLine = renderSummaryHeader(stats);
    if (statsLine) console.log(chalk.gray(statsLine));
    console.log(chalk.gray('─'.repeat(60)));

    process.stdout.write(renderSummary(events, session.cwd));
    return;
  }

  if (mode === 'markdown') {
    console.log(
      agentColor(shown) +
      (session.version ? chalk.yellow(` ${session.version}`) : '') +
      (session.project ? chalk.cyan(` ${session.project}`) : '') +
      chalk.gray(` ${formatRelativeTime(session.timestamp)}`) +
      (session.account ? chalk.gray(` (${session.account})`) : '')
    );
    console.log(chalk.gray('─'.repeat(60)));
    process.stdout.write(renderMarkdown(renderConversationMarkdown(events, { redact: options.redact !== false })));
    return;
  }

  const todos = inferSessionState(parsedEvents, { cwd: session.cwd }).todos;
  process.stdout.write(
    renderJson(events, todos ? { ...session, todos } : session, { redact: options.redact !== false }),
  );
}

function renderTopicCell(
  label: string | undefined | null,
  topic: string | undefined | null,
  query: string,
  visibleWidth: number,
  paddedWidth: number,
): string {
  const lbl = (label ?? '').trim();
  const tpc = (topic ?? '').trim();
  const sep = ' · ';
  const raw = lbl && tpc ? `${lbl}${sep}${tpc}` : (lbl || tpc);
  const visible = truncateToWidth(raw, visibleWidth);
  const padding = ' '.repeat(Math.max(0, paddedWidth - stringWidth(visible)));
  const labelEnd = lbl ? Math.min(lbl.length, visible.length) : 0;

  let matchStart = -1, matchEnd = -1;
  const q = query.trim().toLowerCase();
  if (q) {
    const lower = visible.toLowerCase();
    for (const term of q.split(/\s+/).filter(Boolean)) {
      const idx = lower.indexOf(term);
      if (idx !== -1) { matchStart = idx; matchEnd = idx + term.length; break; }
    }
  }

  const cuts = new Set<number>([0, labelEnd, visible.length]);
  if (matchStart >= 0) { cuts.add(matchStart); cuts.add(matchEnd); }
  const boundaries = [...cuts].sort((a, b) => a - b);

  let out = '';
  for (let i = 0; i < boundaries.length - 1; i++) {
    const s = boundaries[i], e = boundaries[i + 1];
    if (s >= e) continue;
    const text = visible.slice(s, e);
    const isLabel = s < labelEnd;
    const isMatch = matchStart >= 0 && s >= matchStart && e <= matchEnd;
    out += (isMatch || isLabel) ? chalk.bold.white(text) : chalk.white(text);
  }
  return out + padding;
}

export interface SshOriginTag {
  device?: string;
}

export interface PickerColumns {
  showMachine?: boolean;
  machineLabel?: (m: string) => string;
  machineWidth?: number;
  showModel?: boolean;
  modelWidth?: number;
  showTicket?: boolean;
  showHost?: boolean;
  showBookmark?: boolean;
  showStatus?: boolean;
  gutter?: number;
}

const PICKER_MACHINE_W = 11;
const PICKER_MACHINE_MIN = 8;
const PICKER_MACHINE_MAX = 18;
const PICKER_MODEL_MIN = 6;
const PICKER_MODEL_MAX = 13;

function machineColumnWidth(machines: string[], label: (m: string) => string): number {
  const widest = machines.reduce((w, m) => Math.max(w, stringWidth(label(m))), 0);
  return Math.min(PICKER_MACHINE_MAX, Math.max(PICKER_MACHINE_MIN, widest + 1));
}

function modelColumnWidth(sessions: SessionMeta[]): number {
  const widest = sessions.reduce((width, session) => (
    Math.max(width, session.model ? stringWidth(modelLabel(session.model)) : 0)
  ), 0);
  return Math.min(PICKER_MODEL_MAX, Math.max(PICKER_MODEL_MIN, widest + 1));
}

export function machineLabeler(machines: string[]): (m: string) => string {
  const uniq = [...new Set(machines.filter(Boolean))];
  if (uniq.length < 2) return (m) => m;
  const parts = uniq.map((m) => m.split('-'));
  const min = Math.min(...parts.map((p) => p.length));
  let shared = 0;
  while (shared < min - 1 && parts.every((p) => p[shared] === parts[0][shared])) shared++;
  if (shared === 0) return (m) => m;
  return (m) => {
    const p = m.split('-');
    return p.length > shared ? p.slice(shared).join('-') : m;
  };
}

export function pickerColumnsFor(sessions: SessionMeta[]): PickerColumns {
  const machines = sessions.map((s) => s.machine).filter((m): m is string => !!m);
  const distinct = [...new Set(machines)];
  const machineLabel = machineLabeler(machines);
  return {
    showMachine: distinct.length > 1,
    machineLabel,
    machineWidth: machineColumnWidth(distinct, machineLabel),
    showModel: sessions.some((s) => !!s.model),
    modelWidth: modelColumnWidth(sessions),
    showTicket: sessions.some((s) => ticketLabel(s) !== ''),
    showBookmark: (() => {
      const bookmarks = listBookmarks();
      return bookmarks.size > 0 && sessions.some((s) => bookmarks.has(s.id));
    })(),
  };
}

const PICKER_HOST_W = 14;

export function liveHostLabel(a: ActiveSession | undefined): string {
  if (!a?.host) return '';
  const viewer = a.viewingIn?.app;
  return viewer && viewer !== a.host ? `${a.host}→${viewer}` : a.host;
}

export function formatPickerLabel(
  s: SessionMeta,
  query: string,
  cols: PickerColumns = {},
  ssh?: SshOriginTag,
  host = '',
  bookmarked = false,
  live?: ActiveSession,
): string {
  const shown = sessionDisplayAgent(s);
  const agentColor = colorAgent(shown);
  const age = sessionAgeParts(s.timestamp, s.lastActivity);
  const project = s.project || '-';
  const sshPlain = ssh ? (ssh.device ? `ssh←${ssh.device} ` : 'ssh ') : '';
  const sshSeg = sshPlain ? chalk.red(sshPlain) : '';
  const sshW = sshPlain ? stringWidth(sshPlain) : 0;
  const team = teamBadge(s);
  const teamSeg = team.plain ? chalk.green(team.plain) : '';
  const tag = originTag(s) || teamTag(s);
  const label = (s as any).label;
  const topic = tag ? `${tag}${s.topic ?? ''}` : s.topic;
  const versionStr = s.version || '-';
  const wt = s.worktreeSlug ? chalk.magenta(`wt:${s.worktreeSlug}`) : '';

  const machineW = cols.machineWidth ?? PICKER_MACHINE_W;
  const machineCell = cols.showMachine
    ? chalk.gray(padRight(truncate((cols.machineLabel?.(s.machine ?? '') ?? s.machine ?? '') || '-', machineW - 1), machineW))
    : '';

  const TICKET_W = 10;
  const ticketCell = cols.showTicket
    ? chalk.blue(padRight(truncate(ticketLabel(s) || '-', TICKET_W), TICKET_W + 1))
    : '';

  const hostCell = cols.showHost
    ? chalk.gray(padRight(truncate(host || '-', PICKER_HOST_W - 1), PICKER_HOST_W))
    : '';

  const gutter = cols.gutter ?? 2;
  const machineColW = cols.showMachine ? machineW : 0;
  const ticketW = cols.showTicket ? TICKET_W + 1 : 0;
  const hostW = cols.showHost ? PICKER_HOST_W : 0;
  const wtW = wt ? stringWidth(wt) + 1 : 0;
  const bookmarkW = cols.showBookmark ? 2 : 0;
  const bookmarkCell = cols.showBookmark ? (bookmarked ? chalk.yellow('★ ') : '  ') : '';
  const status = cols.showStatus ? liveStatusCell(live) : { cell: '', width: 0 };
  const statusW = cols.showStatus ? LIVE_STATUS_W : 0;
  const statusCell = cols.showStatus ? (status.cell || ' '.repeat(LIVE_STATUS_W)) : '';
  const baseTopicW =
    terminalWidth() - gutter - bookmarkW - statusW - (10 + 9 + 8 + 16) - machineColW - hostW - ticketW - wtW - sshW - team.width - stringWidth(age.last) - 1;
  const when = timeCell(age, baseTopicW);
  const topicW = Math.max(MIN_TOPIC_W, baseTopicW - when.extraW);

  return (
    bookmarkCell +
    chalk.white(padRight(truncate(s.shortId, 9), 10)) +
    agentColor(padRight(truncate(shown, 8), 9)) +
    chalk.yellow(padRight(truncate(versionStr, 7), 8)) +
    machineCell +
    hostCell +
    chalk.cyan(padRight(truncate(project, 14), 16)) +
    statusCell +
    sshSeg +
    teamSeg +
    renderTopicCell(label, topic, query, topicW, topicW) +
    ticketCell +
    (wt ? wt + ' ' : '') +
    when.text
  );
}

const PICKER_TIPS: string[] = [
  'Tip: narrow with -a/--agent (e.g. -a codex), or --project <name> for another folder.',
  "Tip: --all searches every directory; -D/--device <machine> folds in another box's sessions.",
  'Tip: just type to fuzzy-search prompts and responses; press space to preview a session.',
  'Tip: --since 2d / --until <date> bound the time window; pass a session id to open it directly.',
];

export function formatPickerTip(sessions: SessionMeta[]): string {
  return chalk.gray(PICKER_TIPS[sessions.length % PICKER_TIPS.length]);
}

export async function pickSessionInteractive(
  sessions: SessionMeta[],
  message = 'Search sessions:',
  initialSearch?: string,
  hiddenCount = 0,
  enterHint?: string,
  scope?: SessionSearchScope,
): Promise<PickedSession | null> {
  let linesAbovePrompt = 0;
  if (hiddenCount > 0) {
    console.log(chalk.gray(formatTeamHiddenFooter(hiddenCount)));
    linesAbovePrompt += 1;
  }
  const cols = pickerColumnsFor(sessions);
  try {
    return await sessionPicker({
      message,
      subtitle: formatPickerTip(sessions),
      sessions,
      filter: (query: string) => {
        if (!query.trim()) return sessions;
        return filterSessionsByQuery(sessions, query, scope);
      },
      labelFor: (s: SessionMeta, query: string) => formatPickerLabel(s, query, cols),
      pageSize: PICKER_RECENT_COUNT,
      initialSearch,
      enterHint,
      linesAbovePrompt,
    });
  } catch (err) {
    if (isPromptCancelled(err)) return null;
    throw err;
  }
}

function warnNoPeerTarget(machine: string, session: SessionMeta): void {
  console.log(chalk.yellow(`Session ${session.shortId} lives on ${machine}, which isn't a reachable device right now.`));
  console.log(chalk.gray(`Register/wake it (ag devices), or run there: agents ssh ${machine}`));
}

export const LIVE_ROW_PREFIX = 'live:';

function isIdlessLiveRow(s: SessionMeta): boolean {
  return s.id.startsWith(LIVE_ROW_PREFIX);
}

export async function handlePickedSession(picked: PickedSession): Promise<void> {
  if (isIdlessLiveRow(picked.session)) {
    const where = picked.session.machine ? ` on ${picked.session.machine}` : '';
    console.log(chalk.yellow(`This session hasn't reported a session id yet — nothing to open${where}.`));
    console.log(chalk.gray(`Watch for it with: agents sessions --active${picked.session.machine ? ` --device ${picked.session.machine}` : ''}`));
    return;
  }
  if (picked.action === 'view') {
    const readFrom = transcriptOnPeerOf(picked.session);
    if (readFrom) {
      const rc = await runOnPeer(['sessions', picked.session.shortId, '--markdown'], readFrom);
      if (rc === 'no-target') warnNoPeerTarget(readFrom, picked.session);
      return;
    }
    await renderSession(picked.session, 'summary', {});
    return;
  }

  if (await resumeOnOwnerIfRemote(picked.session)) return;
  await resumeSessionInPlace(picked.session);
}

async function resumeOnOwnerIfRemote(session: SessionMeta): Promise<boolean> {
  const owner = sessionOwnerDevice(session);
  if (!owner) return false;
  console.log(chalk.gray(`Resuming ${session.shortId} on ${owner} over SSH...`));
  const rc = await runOnPeer(['sessions', 'resume', session.id], owner, {
    tty: true,
    env: { [RESUME_PINNED_ENV]: '1' },
    sessionId: session.id,
  });
  if (rc === 'no-target') warnNoPeerTarget(owner, session);
  return true;
}

export async function resumeSessionInPlace(session: SessionMeta): Promise<void> {
  const owner = sessionOwnerDevice(session);
  if (owner) {
    console.error(chalk.red(`Session ${session.shortId} belongs to ${owner} — it cannot resume on this machine.`));
    console.error(chalk.gray(`  Resume it there: agents sessions resume ${session.id}`));
    process.exitCode = 1;
    return;
  }

  const cwd = session.cwd && fs.existsSync(session.cwd)
    ? session.cwd
    : process.cwd();

  const resume = buildSessionRecoveryCommand(session);

  console.log(chalk.gray(`Resuming: ${resume.join(' ')} (cwd: ${cwd})`));

  await spawnResumeCommand(resume, cwd);
}

export function buildSessionRecoveryCommand(session: Pick<SessionMeta, 'id'>, portable = false): string[] {
  const args = sessionRecoveryRunArgs(session);
  if (portable) return ['agents', ...args];
  const invocation = getAgentsInvocation(args);
  return [invocation.command, ...invocation.args];
}

export function resumeSpawnInvocation(
  cmd: string[],
  platform: NodeJS.Platform = process.platform,
): { command: string; args: string[]; shell: boolean } {
  const shell = needsWindowsShell(cmd[0], platform);
  if (shell) {
    return {
      command: composeWin32CommandLine(cmd[0], cmd.slice(1)),
      args: [],
      shell: true,
    };
  }
  return { command: cmd[0], args: cmd.slice(1), shell: false };
}

function spawnResumeCommand(cmd: string[], cwd: string): Promise<void> {
  return new Promise<void>((resolve) => {
    let child: ChildProcess;
    try {
      const { command, args, shell } = resumeSpawnInvocation(cmd);
      child = spawn(command, args, {
        cwd,
        stdio: 'inherit',
        shell,
      });
    } catch (err: any) {
      console.error(chalk.red(`Failed to launch ${cmd[0]}: ${err.message}`));
      resolve();
      return;
    }
    child.on('error', (err: any) => {
      console.error(chalk.red(`Failed to launch ${cmd[0]}: ${err.message}`));
      if (err.code === 'ENOENT') {
        console.error(chalk.gray(`Make sure '${cmd[0]}' is on your PATH.`));
      }
      resolve();
    });
    child.on('close', () => resolve());
  });
}

function resumeArgv(agent: SessionMeta['agent'], id: string, launcher: string): string[] | null {
  switch (agent) {
    case 'claude': return [launcher, '--resume', id];
    case 'codex': return [launcher, 'resume', id];
    case 'opencode': return [launcher, '--session', id];
    case 'muse': return [launcher, 'resume', id];
    default: return null;
  }
}

function versionedAliasIfPresent(agent: SessionMeta['agent'], version: string): string | null {
  const cli = AGENTS[agent as AgentId]?.cliCommand ?? agent;
  const base = path.join(getShimsDir(), `${cli}@${version}`);
  if (process.platform === 'win32' && fs.existsSync(`${base}.cmd`)) return `${base}.cmd`;
  if (fs.existsSync(base)) return base;
  return null;
}

export function buildResumeCommand(session: SessionMeta): string[] | null {
  if (!sessionAgentSupportsResume(session.agent)) return null;
  switch (session.agent) {
    case 'opencode':
      return resumeArgv('opencode', session.id, 'opencode');

    case 'claude':
    case 'codex':
    case 'muse': {
      const cli = AGENTS[session.agent as AgentId]?.cliCommand ?? session.agent;
      if (session.version) {
        const alias = versionedAliasIfPresent(session.agent, session.version);
        return resumeArgv(session.agent, session.id, alias ?? `${cli}@${session.version}`);
      }
      return resumeArgv(session.agent, session.id, cli);
    }
    default:
      return null;
  }
}



async function runCloudSessions(query: string | undefined, options: SessionsOptions): Promise<void> {
  const { discoverCloudSessions, ensureCloudSessionCached } = await import('../lib/session/cloud.js');

  let filterOpts: FilterOptions;
  try {
    filterOpts = buildFilterOptions(options);
  } catch (err: any) {
    console.error(chalk.red(err.message));
    process.exit(1);
  }

  const mode = resolveViewMode(options, filterOpts);
  const spinner = options.json ? null : interruptibleSpinner('Loading cloud sessions...').start();

  let sessions: SessionMeta[];
  try {
    sessions = await discoverCloudSessions({ limit: parseInt(options.limit || '50', 10) });
  } catch (err: any) {
    spinner?.stop();
    console.error(chalk.red(`Failed to list cloud sessions: ${err?.message || err}`));
    process.exit(1);
  }
  spinner?.stop();

  if (!query) {
    if (options.json) {
      process.stdout.write(JSON.stringify(sessions, null, 2) + '\n');
      return;
    }
    if (sessions.length === 0) {
      console.log(chalk.gray('No cloud sessions captured yet.'));
      return;
    }
    printSessionTable(sessions);
    return;
  }

  const matches = sessions.filter(
    (s) => s.id === query || s.shortId === query || s.id.startsWith(query),
  );
  if (matches.length === 0) {
    console.error(chalk.red(`No cloud session matching: ${query}`));
    process.exit(1);
  }
  if (matches.length > 1) {
    console.error(chalk.red(`Multiple cloud sessions match "${query}":`));
    for (const m of matches.slice(0, 10)) {
      console.error(chalk.cyan(`  ${m.shortId}  ${m.id}`));
    }
    process.exit(1);
  }

  const meta = matches[0];
  const cachedSpinner = options.json ? null : interruptibleSpinner('Fetching session...').start();
  let cachedPath: string;
  try {
    cachedPath = await ensureCloudSessionCached(meta.id);
  } catch (err: any) {
    cachedSpinner?.stop();
    console.error(chalk.red(`Failed to fetch session: ${err?.message || err}`));
    process.exit(1);
  }
  cachedSpinner?.stop();

  await renderSession({ ...meta, filePath: cachedPath }, mode, filterOpts, options);
}


interface AgentFilter {
  agent?: SessionAgentId;
  version?: string;
}

export function resolveSessionAgentName(name: string): SessionAgentId | null {
  const normalized = name.toLowerCase();
  if (SESSION_AGENTS.includes(normalized as SessionAgentId)) {
    return normalized as SessionAgentId;
  }
  const resolved = resolveAgentName(normalized);
  if (resolved && SESSION_AGENTS.includes(resolved as SessionAgentId)) {
    return resolved as SessionAgentId;
  }
  return fuzzyMatch(normalized, SESSION_AGENTS, FUZZY_PRESETS.agents);
}

export function parseAgentFilter(agentName?: string): AgentFilter {
  if (!agentName) return {};
  const [name, version] = agentName.split('@', 2);
  const agent = resolveSessionAgentName(name);
  if (!agent) {
    console.error(chalk.red(`Unknown agent: ${name}. Use: ${SESSION_AGENTS.join(', ')}`));
    process.exit(1);
  }
  return { agent, version };
}

function formatSearchMessage(options: SessionFilterOptions): string {
  const filters: string[] = [];
  if (options.agent) filters.push(`agent: ${options.agent}`);
  if (options.project?.trim()) filters.push(`project: ${options.project.trim()}`);
  if (filters.length === 0) return 'Search sessions:';
  return `Search sessions (${filters.join(', ')}):`;
}

type SessionSearchScope = {
  agent?: string;
  project?: string;
  routine?: boolean | string;
};

interface SessionQueryResolution {
  matches: SessionMeta[];
  byId: boolean;
  completeId: boolean;
}

export function resolveSessionQuery(
  pool: SessionMeta[],
  query: string,
  options: { indexFallback?: boolean; scope?: SessionSearchScope } = {},
): SessionQueryResolution {
  const normalized = query.trim();
  const completeId = isCompleteSessionId(normalized);
  const byIdMatches = resolveSessionById(pool, normalized);
  if (byIdMatches.length > 0) return { matches: byIdMatches, byId: true, completeId };

  if (looksLikeSessionId(normalized)) {
    const matches = options.indexFallback === false ? [] : findSessionsById(normalized);
    return { matches, byId: true, completeId };
  }
  return { matches: filterSessionsByQuery(pool, normalized, options.scope), byId: false, completeId };
}

function ambiguityHint(byId: boolean, completeId: boolean): string {
  if (completeId) return 'That is already a complete id — these rows share it as a prefix.';
  return byId
    ? 'Pass a longer ID to narrow it down.'
    : 'That matched on text, not an id. Pass a session id, or narrow the search.';
}

function notFoundByIdMessage(query: string): string[] {
  return [chalk.red(`No session with id ${query.trim()} on this machine.`)];
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

export function filterSessionsByQuery(
  sessions: SessionMeta[],
  query: string | undefined,
  scope?: SessionSearchScope,
): SessionMeta[] {
  const trimmed = query?.trim().toLowerCase() || '';
  if (!trimmed) return sessions;

  const installedAgentVersion = parseInstalledAgentVersionQuery(trimmed);
  if (installedAgentVersion) {
    const { agent, version } = parseAgentFilter(installedAgentVersion);
    return sessions.filter((session) => session.agent === agent && session.version === version);
  }

  const terms = trimmed.split(/\s+/).filter(Boolean);
  const contentIndex = scopedContentIndex(sessions, trimmed, scope);

  const EXACT_LABEL_SCORE = 1_000_000;
  const exactLabelHits = [...contentIndex.values()].filter(
    s => (s._bm25Score ?? 0) >= EXACT_LABEL_SCORE,
  );
  if (exactLabelHits.length > 0) {
    return exactLabelHits.sort(
      (a, b) => (b._bm25Score ?? 0) - (a._bm25Score ?? 0),
    );
  }

  const poolById = new Map(sessions.map(s => [s.id, s]));
  for (const [id, hit] of contentIndex) {
    if (!poolById.has(id)) poolById.set(id, hit);
  }

  return [...poolById.values()]
    .map(session => ({ session, score: scoreSessionQuery(session, terms) }))
    .filter(entry => {
      if (entry.score > 0) return true;
      const contentMatch = contentIndex.get(entry.session.id);
      if (contentMatch && contentMatch._matchedTerms && contentMatch._matchedTerms.length > 0) {
        return true;
      }
      return false;
    })
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      const cmA = contentIndex.get(a.session.id);
      const cmB = contentIndex.get(b.session.id);
      const bmA = cmA?._bm25Score ?? 0;
      const bmB = cmB?._bm25Score ?? 0;
      if (bmB !== bmA) return bmB - bmA;
      return new Date(b.session.timestamp).getTime() - new Date(a.session.timestamp).getTime();
    })
    .map(entry => {
      const cm = contentIndex.get(entry.session.id);
      if (cm && cm._matchedTerms) {
        return { ...cm };
      }
      return entry.session;
    });
}

function scoreSessionQuery(session: SessionMeta, terms: string[]): number {
  let score = 0;

  for (const term of terms) {
    const exactId = session.id.toLowerCase() === term || session.shortId.toLowerCase() === term;
    const prefixId = session.id.toLowerCase().startsWith(term) || session.shortId.toLowerCase().startsWith(term);
    const topic = session.topic?.toLowerCase() || '';
    const project = session.project?.toLowerCase() || '';
    const account = session.account?.toLowerCase() || '';
    const cwd = session.cwd?.toLowerCase() || '';
    const agent = session.agent.toLowerCase();
    const version = session.version?.toLowerCase() || '';

    let termScore = 0;
    if (exactId) termScore = 1000;
    else if (prefixId) termScore = 900;
    else if (topic.startsWith(term)) termScore = 700;
    else if (project.startsWith(term)) termScore = 600;
    else if (account.startsWith(term)) termScore = 550;
    else if (agent.startsWith(term) || version.startsWith(term)) termScore = 500;
    else if (topic.includes(term)) termScore = 400;
    else if (project.includes(term)) termScore = 300;
    else if (account.includes(term)) termScore = 250;
    else if (cwd.includes(term)) termScore = 200;
    else if (version.includes(term) || agent.includes(term)) termScore = 150;
    else return 0;

    score += termScore;
  }

  return score;
}

export function applyScopeFilters(
  sessions: SessionMeta[],
  scope: SessionSearchScope,
): SessionMeta[] {
  let filtered = sessions;

  if (scope.project) {
    const projectQuery = scope.project.toLowerCase();
    filtered = filtered.filter((s) => {
      const project = (s.project || '').toLowerCase();
      const cwd = (s.cwd || '').toLowerCase();
      return project.includes(projectQuery) || cwd.includes(projectQuery);
    });
  }

  if (scope.agent) {
    const [wantAgent, rawVersion] = scope.agent.split('@');
    const resolvedAgent = resolveAgentName(wantAgent);
    const wantVersion = resolvedAgent ? resolveVersionAliasLoose(resolvedAgent, rawVersion) : rawVersion;
    filtered = filtered.filter((s) => {
      if (s.agent !== wantAgent) return false;
      if (wantVersion && s.version !== wantVersion) return false;
      return true;
    });
  }

  if (scope.routine) {
    filtered = filtered.filter((session) => session.origin === 'routine');
    if (typeof scope.routine === 'string') {
      const names = [...new Set(
        filtered.map((session) => session.routineName).filter((name): name is string => !!name),
      )];
      const selected = resolveRoutineName(scope.routine, names);
      filtered = selected
        ? filtered.filter((session) => session.routineName === selected)
        : [];
    }
  }

  return filtered;
}

function scopedContentIndex(
  sessions: SessionMeta[],
  query: string,
  scope?: SessionSearchScope,
): Map<string, SessionMeta> {
  const hits = searchContentIndex(sessions, query);
  if (!scope || (!scope.agent && !scope.project && !scope.routine)) return hits;
  const kept = new Map<string, SessionMeta>();
  for (const [id, session] of hits) {
    if (applyScopeFilters([session], scope).length > 0) kept.set(id, session);
  }
  return kept;
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

interface FleetResolveDeps {
  gatherRemoteList: typeof gatherRemoteList;
  runOnPeer: typeof runOnPeer;
}

interface FleetHit {
  machine: string;
  session: SessionMeta;
}

interface FleetSessionCandidate {
  id: string;
  hits: FleetHit[];
}

type MetadataResolveOutcome =
  | { kind: 'resolved'; session: SessionMeta }
  | { kind: 'not-found' }
  | { kind: 'ambiguous'; candidates: FleetSessionCandidate[] }
  | { kind: 'partial'; failedPeers: string[] };

const FULL_SESSION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const SHORT_SESSION_ID_RE = /^[0-9a-f]{8}$/i;


export function isDefinitiveMatch(session: SessionMeta, selector: string): boolean {
  const trimmed = selector.trim();
  if (FULL_SESSION_ID_RE.test(trimmed)) {
    return session.id.toLowerCase() === trimmed.toLowerCase();
  }
  const shortId = shortIdFromName(trimmed) ?? (SHORT_SESSION_ID_RE.test(trimmed) ? trimmed : undefined);
  return !!shortId && session.shortId.toLowerCase() === shortId.toLowerCase();
}

export function selectorAllowsEarlyExit(selector: string): boolean {
  const trimmed = selector.trim();
  return FULL_SESSION_ID_RE.test(trimmed) || isAgentTmuxAlias(trimmed) || SHORT_SESSION_ID_RE.test(trimmed);
}

export function fleetCandidatesByQuery(rows: SessionMeta[], query: string, trustResolvedRows = false): FleetSessionCandidate[] {
  const matched = !trustResolvedRows && looksLikeSessionId(query)
    ? resolveSessionQuery(rows, query, { indexFallback: false }).matches
    : rows;
  const byId = new Map<string, Map<string, SessionMeta>>();
  for (const session of matched) {
    const machine = session.machine;
    if (!machine) continue;
    const logicalId = session.id.toLowerCase();
    let byMachine = byId.get(logicalId);
    if (!byMachine) {
      byMachine = new Map();
      byId.set(logicalId, byMachine);
    }
    if (!byMachine.has(machine)) byMachine.set(machine, session);
  }

  return Array.from(byId.values()).map(byMachine => {
    const hits = Array.from(byMachine.entries()).map(([machine, session]) => ({ machine, session }));
    return { id: hits[0].session.id, hits };
  });
}

function resolveIndexedMetadataRows(
  indexed: SessionMeta[],
  selector: string,
  scope?: SessionSearchScope,
): SessionMeta[] {
  const alias = resolveSessionAlias(selector);
  if (alias.kind === 'resolved') {
    return resolveSessionQuery(indexed, alias.sessionId, { indexFallback: false, scope }).matches;
  }
  if (alias.kind === 'ambiguous') {
    const ids = new Set(alias.sessionIds.map(id => id.toLowerCase()));
    return indexed.filter(session => ids.has(session.id.toLowerCase()));
  }
  return resolveSessionQuery(indexed, selector, { indexFallback: false, scope }).matches;
}

function indexedRowsForSelector(
  selector: string,
  scope: { agent?: string; project?: string },
): SessionMeta[] {
  const indexed = looksLikeSessionId(selector)
    ? findSessionsById(selector)
    : querySessions();
  return applyScopeFilters(indexed, scope);
}

export function metadataResolveForwardedArgs(
  selector: string,
  scope: Pick<SessionFilterOptions, 'agent' | 'project'>,
): string[] {
  const args = ['sessions', '--resolve-safe-v1', selector, '--json', '--all', '--local'];
  if (scope.agent) args.push('--agent', scope.agent);
  if (scope.project) args.push('--project', scope.project);
  return args;
}

export function toolSearchForwardedArgs(argv: string[], hosts: string[]): string[] {
  const args = ensureWholeIndex(
    buildForwardedArgs(argv, new Set(hosts)).filter((arg) => arg !== '--fleet'),
  );
  if (!args.includes('--json')) args.push('--json');
  if (!args.includes('--local')) args.push('--local');
  return args;
}

const SHORT_SESSION_ID_WIDTH = 8;

export function isUniqueEnoughSelector(selector: string): boolean {
  const trimmed = selector.trim();
  if (isCompleteSessionId(trimmed)) return true;
  return /^[0-9a-f-]+$/i.test(trimmed)
    && trimmed.replace(/-/g, '').length >= SHORT_SESSION_ID_WIDTH;
}

export function metadataResolveOutcome(
  localMatches: SessionMeta[],
  remote: { sessions: SessionMeta[]; unreachable: string[] },
  selector: string,
): MetadataResolveOutcome {
  const candidates = fleetCandidatesByQuery([...localMatches, ...remote.sessions], selector, true);
  if (isUniqueEnoughSelector(selector) && candidates.length === 1) {
    return { kind: 'resolved', session: candidates[0].hits[0].session };
  }
  if (remote.unreachable.length > 0) return { kind: 'partial', failedPeers: remote.unreachable };
  if (candidates.length === 0) return { kind: 'not-found' };
  if (candidates.length > 1) return { kind: 'ambiguous', candidates };
  return { kind: 'resolved', session: candidates[0].hits[0].session };
}

export function isLocallyDefinitiveMatch(session: SessionMeta, self: string): boolean {
  if (session.filePath) return true;
  return !!session.machine && session.machine !== self;
}

export function preferOwnerAttribution(
  localMatches: SessionMeta[],
  remoteSessions: SessionMeta[],
  self: string,
): SessionMeta[] {
  if (remoteSessions.length === 0) return localMatches;
  const answeredByPeer = new Set(remoteSessions.map(session => session.id.toLowerCase()));
  return localMatches.filter(session =>
    isLocallyDefinitiveMatch(session, self) || !answeredByPeer.has(session.id.toLowerCase()));
}

type LiveMetadataDeps = {
  loadActive?: typeof loadLocalActiveSessions;
  loadFleetActive?: () => ActiveSession[];
};

export async function computeLocalMetadataMatches(
  selector: string,
  scope: { agent?: string; project?: string; local?: boolean; hosts?: string[] },
  deps: LiveMetadataDeps = {},
): Promise<SessionMeta[]> {
  const localMachine = machineId();
  const includeLocal = !scope.hosts?.length || shouldIncludeLocal(scope.hosts, localMachine);
  if (!includeLocal) return [];

  let indexed = resolveIndexedMetadataRows(indexedRowsForSelector(selector, scope), selector, scope);
  if (!looksLikeSessionId(selector)) {
    return indexed.map(session => ({ ...session, machine: session.machine || localMachine }));
  }
  const { hydrateSessionTranscript, findLocalSessionTranscripts } = await import('../lib/session/discover.js');
  if (indexed.length === 0) {
    const disk = await findLocalSessionTranscripts(selector, scope.agent as SessionMeta['agent'] | undefined);
    const live = disk.length ? [] : await liveMetadataMatches(selector, scope, localMachine, deps);
    if (disk.length > 0) indexed = resolveIndexedMetadataRows(disk, selector, scope);
    else if (live.length > 0) indexed = live;
    else if (scope.agent !== 'claude' && scope.agent !== 'codex') {
      const { scanSessionsIncremental, waitForScanToSettle } = await import('../lib/session/discover.js');
      const { claimed } = await scanSessionsIncremental({ agent: scope.agent as SessionMeta['agent'] | undefined });
      if (!claimed) {
        if (!await waitForScanToSettle()) throw new Error('Session lookup is incomplete: another index scan is still running. Retry when it finishes.');
        const retry = await scanSessionsIncremental({ agent: scope.agent as SessionMeta['agent'] | undefined });
        if (!retry.claimed) throw new Error('Session lookup is incomplete: the session index is busy. Retry when the scan finishes.');
      }
      indexed = resolveIndexedMetadataRows(indexedRowsForSelector(selector, scope), selector, scope);
    }
  }
  const hydrated: SessionMeta[] = [];
  for (const session of indexed) {
    hydrated.push(await hydrateSessionTranscript({ ...session, machine: session.machine || localMachine }));
  }
  return hydrated;
}

export async function liveMetadataMatches(
  selector: string,
  scope: { agent?: string; project?: string },
  self: string,
  deps: LiveMetadataDeps = {},
): Promise<SessionMeta[]> {
  const load = deps.loadActive ?? loadLocalActiveSessions;
  const loadFleet = deps.loadFleetActive ?? (() => readActiveSessionsCache('fleet')?.sessions ?? []);
  let fleetExecMachine: Map<string, string>;
  try {
    fleetExecMachine = fleetExecutionMachineById(loadFleet());
  } catch {
    fleetExecMachine = new Map();
  }
  const match = (metas: SessionMeta[]): SessionMeta[] =>
    resolveIndexedMetadataRows(
      applyScopeFilters(reconcileLiveMetaMachine(metas, fleetExecMachine, self), scope),
      selector,
      scope,
    );
  try {
    const cached = liveSessionMetas((await load()).sessions, self, Date.now());
    const hit = match(cached);
    if (hit.length > 0) return hit;
    const fresh = liveSessionMetas((await load({ forceRefresh: true })).sessions, self, Date.now());
    return match(fresh);
  } catch {
    return [];
  }
}

export async function resolveSessionMetadataValue(
  selector: string,
  scope: { agent?: string; project?: string; local?: boolean; hosts?: string[] } = {},
  deps: Pick<FleetResolveDeps, 'gatherRemoteList'> & LiveMetadataDeps = { gatherRemoteList },
): Promise<MetadataResolveOutcome> {
  const localMatches = await computeLocalMetadataMatches(selector, scope, deps);
  const localMachine = machineId();

  if (FULL_SESSION_ID_RE.test(selector)) {
    const localOutcome = metadataResolveOutcome(localMatches, { sessions: [], unreachable: [] }, selector);
    if (localOutcome.kind === 'resolved' && isLocallyDefinitiveMatch(localOutcome.session, localMachine)) {
      return localOutcome;
    }
  }

  if (scope.local === true) return metadataResolveOutcome(localMatches, { sessions: [], unreachable: [] }, selector);

  try {
    const forwarded = metadataResolveForwardedArgs(selector, scope);
    const remote = await deps.gatherRemoteList(
      forwarded,
      scope.hosts,
      selectorAllowsEarlyExit(selector)
        ? { isDefinitive: (session) => isDefinitiveMatch(session, selector) }
        : undefined,
    );
    return metadataResolveOutcome(
      preferOwnerAttribution(localMatches, remote.sessions, localMachine),
      remote,
      selector,
    );
  } catch (error: any) {
    return metadataResolveOutcome(localMatches, { sessions: [], unreachable: [error?.message ?? 'fleet fan-out'] }, selector);
  }
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
    .option('--query <clause>', 'Search text; repeat with --include tools to require distinct matching calls', collectQueryClause, [])
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
    .option('--include <roles>', 'Only include these roles (comma-separated): user, assistant, thinking, tools. "user" is genuine user turns only, not harness-injected scaffolding (bash-input, system-reminder)')
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
    .option('--fleet', 'With --include tools: query every registered online compute device and merge compact matches')
    .option('--count', 'With one program:<name> tool query: count static occurrences, containing calls, and sessions')
    .option('--browser', 'List browser-profile captures (screenshots, PDFs, recordings, downloads) instead of agent transcripts — alias of `agents browser sessions`')
    .option('--computer', 'List computer-driving history, grouped by run, instead of agent transcripts — alias of `agents computer sessions`')
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

      # List indexed tool calls in recent Codex sessions on one device
      agents sessions --include tools --agent codex --device mac-mini --since 7d

      # Each repeated clause must match a different call in the same session
      agents sessions --include tools --query 'program:git input:merge' --query 'program:gh output:CONFLICT' --fleet --json

      # Count every pre-indexed static git site without reparsing transcripts
      agents sessions --include tools --query 'program:git' --count --fleet --json

      # Explicitly populate historical tool rows once on every device
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
      - With --include tools, repeat --query for same-session AND across distinct calls. Fields: tool, program, input, output, status, exit, error.
      - --count accepts exactly one program:<name> clause and reports static source occurrences, containing tool calls, and sessions.
      - Tool queries read SQLite only. Run 'agents sessions backfill tools' once for historical transcripts; normal scans index new and changed sessions.
      - Tool evidence is redacted and bounded before it reaches SQLite. --markdown and --no-redact conflict with --include tools.
      - Tool queries accept 32 clauses (4 KiB each), --limit 1–1,000, and at most 8 MiB of materialized evidence.
      - --first and --last are mutually exclusive.
      - A filter flag (--include/--exclude/--first/--last) without --markdown/--json defaults to --markdown output.
      - --cloud sources from Rush Cloud captured runs instead of local disk.
      - --routine [name] spans every directory and shows transcripts archived from routine runs. On a TTY, omit the name to pick a routine; a name accepts exact, substring, or unambiguous typo matches. --routines is an alias. Routine rows also resolve by run id.
      - Without --teams, team-spawned sessions are hidden by default.
    `,
  });

  sessionsCmd.action(async (query: string | undefined, options: SessionsOptions, command: Command) => {
    if ((options as { browser?: boolean }).browser) {
      await runBrowserSessionsCommand({ profile: query, json: options.json, interactive: options.interactive });
      return;
    }
    if ((options as { computer?: boolean }).computer) {
      const limit = options.limit === undefined ? undefined : Number.parseInt(options.limit, 10);
      const deviceArgs = [...(options.device ?? []), ...(options.devices ?? [])];
      const allFleet = deviceArgs.some((host) => ['all', 'fleet'].includes(host.toLowerCase()));
      const hosts = [...(options.host ?? []), ...deviceArgs]
        .filter((host) => !['all', 'fleet'].includes(host.toLowerCase()));
      if (hosts.length > 0 || allFleet) {
        const remoteRows = await gatherRemoteComputerSessionRows(allFleet ? undefined : hosts);
        const rows = allFleet
          ? [...buildComputerSessionRows({ machine: query }), ...remoteRows]
          : remoteRows;
        rows.sort((a, b) => b.endMs - a.endMs);
        await runComputerSessionsCommand({ rows, machine: query, limit, json: options.json, interactive: options.interactive });
        return;
      }
      await runComputerSessionsCommand({ machine: query, limit, json: options.json, interactive: options.interactive });
      return;
    }
    await sessionsAction(query, options, command.getOptionValueSource('limit'));
  });

  const previewCmd = sessionsCmd
    .command('preview')
    .argument('<id>', 'Full session ID or displayed 8-character short ID')
    .description('Show one rich session card without rendering the full transcript')
    .option('-a, --agent <agent>', 'Narrow the ID to one agent type/version')
    .option('-p, --project <name>', 'Narrow the ID to one project')
    .option('--local', 'Only this machine; do not resolve the ID across the fleet')
    .option('-D, --device <target...>', 'Resolve only on the named device(s)')
    .option('--json', 'Output the session preview as JSON')
    .option('--refresh', 'Bypass the durable remote-preview cache and negative backoff for one bounded fetch (full ID + single --device only)')
    .option('--revision <cursor>', 'Opaque caller-owned activity cursor (any stable value YOU track, e.g. your own feed\'s lastActivityMs) -- passing the SAME value as your last call confirms nothing changed and serves the cache with zero SSH indefinitely; a different value fetches once, still subject to backoff unless --refresh is also set (full ID + single --device only)');

  setHelpSections(previewCmd, {
    examples: `
      # Preview by the 8-character ID shown in agents sessions
      agents sessions preview 407b8dd5

      # A full UUID resolves on the first device that owns it
      agents sessions preview c70ecdea-6210-4039-9845-246a3a7a9942

      # Stay on this machine or restrict the authoritative lookup to one peer
      agents sessions preview 407b8dd5 --local
      agents sessions preview 407b8dd5 --device zion

      # Full ID + one --device: durable-cached fast path (PHNX-3999); force a fresh fetch
      agents sessions preview c70ecdea-6210-4039-9845-246a3a7a9942 --device zion --json --refresh
    `,
    notes: `
      - Full UUIDs are globally unique and may stop the fleet lookup at the first exact hit.
      - Short IDs wait for every selected device so ambiguity is never hidden.
      - Active status is refreshed through the bounded live-state TTL; transcript-derived details use the durable session index.
      - A full UUID with exactly one --device and --json is served from a local durable cache (~45s fresh window); the JSON envelope's "cache" field reports fresh/stale/offline state. --refresh forces one bounded re-fetch.
    `,
  });

  previewCmd.action(async (id: string) => {
    const options = previewCmd.optsWithGlobals() as {
    agent?: string;
    project?: string;
    local?: boolean;
    host?: string[];
    device?: string[];
    json?: boolean;
    refresh?: boolean;
    revision?: string;
    };
    const hosts = [...(options.host ?? []), ...(options.device ?? [])];
    await renderSessionPreview(id, {
      agent: options.agent,
      project: options.project,
      local: options.local,
      hosts: hosts.length > 0 ? hosts : undefined,
      json: options.json,
      refresh: options.refresh,
      revision: options.revision,
    });
  });

  registerSessionsTailCommand(sessionsCmd);
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

function formatTeamHiddenFooter(hiddenCount: number): string {
  const noun = hiddenCount === 1 ? 'team session' : 'team sessions';
  return `(${hiddenCount} ${noun} hidden — use --teams to show, or \`agents teams status\`)`;
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


function formatAbsoluteTime(isoTimestamp: string): string {
  const d = new Date(isoTimestamp);
  if (isNaN(d.getTime())) return isoTimestamp;
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${months[d.getMonth()]} ${d.getDate()} ${hh}:${mm}`;
}
