/**
 * Session discovery, search, and rendering commands.
 *
 * Implements `agents sessions` -- the unified interface for finding, browsing,
 * and reading agent conversation transcripts across Claude, Codex, Gemini,
 * and OpenCode. Supports interactive picker mode, text/path search, markdown
 * and JSON rendering, role/turn filtering, artifact inspection, and session
 * resume via agent-native CLI flags.
 */
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
import type { AgentId } from '../lib/types.js';
import type { SessionAgentId, SessionMeta, ViewMode } from '../lib/session/types.js';
import { SESSION_AGENTS, isAgentTmuxAlias, sessionDisplayAgent } from '../lib/session/types.js';
import { discoverArtifacts, readArtifact, resolveArtifact } from '../lib/session/artifacts.js';
import { isResumableHarness } from '../lib/session/resume-capability.js';
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
} from '../lib/session/session-cache.js';
import { gatherRemoteList, gatherRemoteToolProgramCounts, gatherRemoteToolSearch, runOnPeer } from '../lib/session/remote-list.js';
import { gatherRemoteAgentsJson, type RemoteAgentsJsonParseResult } from '../lib/remote-agents-json.js';
import { stringWidth, truncateToWidth, padToWidth, terminalWidth } from '../lib/session/width.js';
import type { SessionActivity, AwaitingReason } from '../lib/session/state.js';
import { inferSessionState } from '../lib/session/state.js';
import { discoverSessions, queryIndexedSessions, countSessionsInScope, resolveSessionById, isCompleteSessionId, looksLikeSessionId, searchContentIndex, parseTimeFilter, getSessionRoots, scopeToManaged, type DiscoverOptions, type ScanProgress } from '../lib/session/discover.js';
import { findSessionsById, querySessions, getSessionById, readSessionContent, readArchivedSessionPreview } from '../lib/session/db.js';
import { liveSessionMetas } from '../lib/session/live-metadata.js';
import {
  filterTeamSessions,
  shouldShowTeamSessions,
  safeTeamText,
  groupSessionsByTeam,
  NO_TEAM_GROUP_KEY,
  type TeamSessionGroup,
} from '../lib/session/team-filter.js';
import { parseSession } from '../lib/session/parse.js';
import { runRemoteSessions, buildForwardedArgs, ensureWholeIndex } from '../lib/session/remote.js';
import { formatRelativeTime, formatCompactAge, sessionAgeParts, type SessionAgeParts } from '../lib/session/relative-time.js';
import { renderConversationMarkdown, renderSummary, renderSummaryHeader, computeSummaryStats, renderJson, filterEvents, parseRoleList, linkPath, linkUrl, shortenModel, formatTokenCount, type FilterOptions } from '../lib/session/render.js';
import { linearIssueUrl } from '../lib/session/linear.js';
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
import { sessionRecoveryRunArgs } from '../lib/session/recovery.js';
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
import { registerGoCommand } from './go.js';
import { registerFocusCommand } from './focus.js';
import { registerReconnectCommand } from './reconnect.js';
import { registerDetachCommand } from './detach.js';
import { registerSessionsStopCommand } from './sessions-stop.js';
import { registerAttachCommand } from './attach.js';
import { registerSessionsInjectCommand } from './sessions-inject.js';
import { registerSessionsExportCommand } from './sessions-export.js';
import { registerSessionsRenderCommand } from './sessions-render.js';
import { registerSessionsTraceCommand } from './sessions-trace.js';
import { registerSessionsShareCommand } from './sessions-share.js';
import { registerSessionsImportCommand } from './sessions-import.js';
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
  /** Internal Commander spelling after index.ts disambiguates root --version. */
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
  /** Also list sessions from the user's own unmanaged ~/.<agent> installs. */
  unmanaged?: boolean;
  query?: string[];
  /** Resolve one historical selector to metadata only (requires --json). */
  resolve?: string;
  /** Versioned internal peer protocol; old/unsafe peers must reject it. */
  resolveSafeV1?: string;
  limit?: string;
  sort?: string;
  json?: boolean;
  markdown?: boolean;
  /** Commander populates this from `--no-redact`: true by default, false when the flag is passed. */
  redact?: boolean;
  include?: string;
  exclude?: string;
  first?: string;
  last?: string;
  artifacts?: boolean;
  artifact?: string;
  active?: boolean;
  /** Emit the on-disk session-scan directories (requires --json); for watchers. */
  roots?: boolean;
  cloud?: boolean;
  host?: string[];
  /** Group the listing by directory and drop the id/version columns. */
  tree?: boolean;
  /** Force the plain flat table instead of the grouped default overview. */
  flat?: boolean;
  /** With --active: show only sessions waiting on user input; exit 1 if any. */
  waiting?: boolean;
  /** Live-state shorthand filters. Any one implies --active; several compose as OR. */
  working?: boolean;
  idle?: boolean;
  orphan?: boolean;
  orphaned?: boolean;
  crashed?: boolean;
  closed?: boolean;
  abandoned?: boolean;
  queued?: boolean;
  unknown?: boolean;
  /** Show only bookmarked sessions — the `b` key's flag twin. */
  bookmarks?: boolean;
  /** Enrich the listing with live glyphs/preview for running rows. Default on;
   * `--no-live` sets this false. Commander's `--no-` convention. */
  live?: boolean;
  /** Force local-only: skip the cross-machine SSH fan-out (both the default
   * listing and --active). */
  local?: boolean;
  /** --device <target...> — values from the `--device` flag; resolves against the device registry. */
  device?: string[];
  /** --devices <target...> — plural alias for --device; a bare `all`/`fleet` value
   * means "search the whole fleet" (already the default), so it never errors. */
  devices?: string[];
  /** Query every registered online compute device and merge tool evidence. */
  fleet?: boolean;
  /** Aggregate static program sites instead of returning matching call evidence. */
  count?: boolean;
  /** Per-agent shorthands: aliases for `--agent <name>` (prioritized harnesses). */
  claude?: boolean;
  codex?: boolean;
  kimi?: boolean;
  antigravity?: boolean;
  grok?: boolean;
  opencode?: boolean;
  /** Force the printed listing even on a TTY. Commander's `--no-` convention:
   * `--no-interactive` sets this false, opting out of the interactive browser. */
  interactive?: boolean;
  /** Print the canonical `ag sessions …` command for the given flags and exit —
   * the non-interactive twin of the browser's `y` hotkey. */
  printCmd?: boolean;
  /** Print a compact preview of the matched session and exit (no pager). */
  preview?: boolean;
  /** Only sessions that invoked this skill (#12) — matches a bare name or a
   * namespaced plugin skill's short name (`--skill design` finds `rush:design`). */
  skill?: string;
  /** Only sessions that used a skill/command owned by this plugin (#12). */
  plugin?: string;
}

/**
 * The prioritized harnesses that get a boolean shorthand flag (e.g. `--claude`
 * === `--agent claude`). The rest stay reachable via `--agent <name>`, which
 * also carries version pins like `codex@0.116.0`.
 */
const AGENT_SHORTHANDS = ['claude', 'codex', 'kimi', 'antigravity', 'grok', 'opencode'] as const;

/**
 * Resolve a per-agent shorthand (`--claude`, `--kimi`, …) into `options.agent`.
 * An explicit `--agent` wins; if two shorthands are passed we take the first and
 * ignore the rest (commander gives no ordering, so this is a best-effort alias).
 */
function applyAgentShorthands(options: SessionsOptions): void {
  if (options.agent) return;
  const hit = AGENT_SHORTHANDS.find((name) => (options as Record<string, unknown>)[name] === true);
  if (hit) options.agent = hit;
}

type InstalledVersionsForAgent = (agent: SessionAgentId) => string[];

/**
 * Treat a positional `agent@version` as a structured filter only when it names
 * a real installed version. Everything else remains ordinary free-text search.
 */
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

/** Build a spinner-backed progress tracker that cycles through verbs while scanning sessions. */
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
/**
 * The `--limit` default, shared with its `.option()` registration. Commander fills
 * the default in, so `options.limit` is never falsy — code that wants to know
 * whether the USER set a limit has to compare against this rather than test
 * truthiness.
 */
const DEFAULT_LIMIT = '50';
/** Pool size for `--in-team`: one team's rows can sit anywhere in the history. */
const WHOLE_TEAM_POOL_LIMIT = 5000;
// The grouped default view ("overview"): fetch a generous recency-ordered pool
// for accurate per-project totals, show each project's most-recent rows grouped
// by project, newest-active project first.
const OVERVIEW_ROWS_PER_PROJECT = 5; // recent rows shown per project before "· N more"
const OVERVIEW_POOL_LIMIT = 1000; // fetch cap — accurate per-project totals up to this
const OVERVIEW_MAX_PROJECTS = 12; // project groups shown before "+N more projects"

/**
 * Resolve a path-like query to an absolute directory path.
 */
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
    // Dead process: dimmed so it recedes from the live rows without being mistaken
    // for the gray `idle` (which reads as "done, waiting for you" — a live state).
    case 'closed': return chalk.dim;
    // Days-stale / dangling: red so a session nobody is driving stands out.
    case 'abandoned': return chalk.red;
    // The host window died and took the agent with it — an unclean exit, not the
    // dimmed `closed` of a normal one. Red-bright so a crash reads as an event.
    case 'crashed': return chalk.redBright;
    // Alive with nobody attached. Yellow, like `input_required`: both mean the
    // session is stuck waiting on a human, and this one has no human to wait for.
    case 'orphaned': return chalk.yellow;
    // Alive but un-introspectable (a harness whose transcript we can't parse).
    // Magenta so it never reads as the gray "idle" it used to be faked as.
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
  // Compare in normalized form so the `~` shorthand also lands on Windows
  // (case-insensitive, backslash paths); on POSIX this is byte-identical to the
  // previous `cwd.startsWith(home)`. The displayed tail keeps original casing.
  return toComparablePath(cwd).startsWith(toComparablePath(home))
    ? '~' + cwd.slice(home.length)
    : cwd;
}

function formatStartedAt(startedAtMs?: number): string {
  if (!startedAtMs) return '-';
  return formatRelativeTime(new Date(startedAtMs).toISOString());
}

/**
 * Strip terminal/harness noise from a preview so the column stays a single line
 * of plain prose: OSC title escapes, CSI/SGR ANSI, and the harness wrapper tags
 * (`<local-command-stdout>`, `<task-notification>`, `<command-*>`) that leak from
 * a captured transcript tail. Collapses runs of whitespace.
 */
export function cleanPreview(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')        // OSC (title) sequences
    .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')                    // CSI / SGR ANSI
    .replace(/<\/?(?:local-command-stdout|command-name|command-message|command-args|task-notification|system-reminder)>/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Build the live description for an active session: checklist progress (when
 * present) plus the state engine's preview (the latest turn), a user label, or
 * the first-prompt topic. Used by both the flat listing's `doing` cell and as
 * the snippet half of the --active row (identity is layered on in printActiveRow).
 *
 * Covers every ActiveSession context: terminal (interactive), headless, teams,
 * cloud, and sub-agent rows that share the same ActiveSession.todos field.
 */
export function buildSessionDescription(s: ActiveSession): string {
  const todo = formatTodoCompact(s.todos);
  if (s.context === 'cloud') {
    const base = s.preview || `${s.cloudProvider ?? ''}${s.cloudTaskId ? ` · ${s.cloudTaskId.slice(0, 12)}` : ''}`;
    return cleanPreview([todo, base].filter(Boolean).join(' · '));
  }
  if (s.context === 'teams') {
    // A teams row identifies its TEAM, then the teammate within it, then who
    // spun it up, then what it's working on — so several teams from one
    // orchestrator stay distinct and each shows its target, not just its slug.
    const parts = [s.teamName];
    // Teammate name (distinct from the team slug) — which member this row is.
    if (s.label && s.label !== s.teamName) parts.push(s.label);
    // Lineage: which orchestrator spun up this team. Prefer the resolved label,
    // else the short session id, so "by whom" is answerable at a glance.
    const orch = s.orchestratorLabel || (s.orchestratorSessionId ? s.orchestratorSessionId.slice(0, 8) : '');
    if (orch) parts.push(`by ${orch}`);
    if (todo) parts.push(todo);
    // Target: the live latest turn if working, else the assigned mission (the
    // team's task/target, shown even before the teammate has a transcript), else
    // the transcript topic.
    const target = s.preview || s.assignedTask || s.topic;
    if (target) parts.push(target);
    return cleanPreview(parts.filter(Boolean).join(' · '));
  }
  // Terminal, headless, or sub-agent: todos + live preview, then label, then topic.
  const base = s.preview || s.label || s.topic || '';
  return cleanPreview([todo, base].filter(Boolean).join(' · '));
}

/**
 * Identity + checklist + live snippet for an --active / cross-machine row.
 * Surfaces agent-adjacent identity the flat table already has (label, project)
 * with a clickable project when a GitHub URL is resolvable, then the checklist
 * tally and the latest-turn snippet.
 *
 * Free-text fields are cleaned individually; OSC 8 hyperlinks are applied
 * *after* cleaning so `cleanPreview` does not strip the clickable targets
 * (RUSH-2045 review). Ticket is clickable via {@link signalBadges}, not here,
 * so the id is not printed twice.
 */
export function formatActiveRowDescription(s: ActiveSession): string {
  const parts: string[] = [];
  const pushText = (t?: string) => {
    const c = t ? cleanPreview(t) : '';
    if (c) parts.push(c);
  };
  if (s.context === 'teams' && s.teamName) pushText(s.teamName);
  if (s.label) pushText(s.label);
  // Project = basename(cwd), same derivation as serializeActiveSessionsForJson.
  const project = s.cwd ? path.basename(s.cwd) : '';
  if (project && project !== s.label && project !== s.teamName) {
    const label = cleanPreview(project);
    const repoUrl = githubRepoUrlFromCwd(s.cwd);
    parts.push(repoUrl ? linkUrl(repoUrl, label) : label);
  }
  const todo = formatTodoCompact(s.todos);
  if (todo) parts.push(todo);

  // Latest-turn snippet — avoid repeating label/topic when already used as identity.
  // A cloud row with no preview yet says nothing here; its provider + task id
  // ride the locator badge instead (RUSH-2336), not duplicated on this line.
  if (s.preview) {
    pushText(s.preview);
  } else if (!s.label && s.topic) {
    pushText(s.topic);
  }
  return parts.filter(Boolean).join(' · ');
}

/** Short human word for a session's activity (falls back to the coarse status). */
function activityLabel(s: ActiveSession): string {
  // Lifecycle status wins over any residual parsed activity — a dead/dangling
  // session must read `closed`/`abandoned`, not the `idle` its stale tail infers.
  // `crashed`/`orphaned` are the same kind of claim about the session as a whole,
  // and both outrank the `idle` its last parsed turn would otherwise show.
  if (s.status === 'closed' || s.status === 'abandoned') return s.status;
  if (s.status === 'crashed') return 'crashed';
  if (s.status === 'orphaned') return 'orphan';
  if (s.activity === 'waiting_input') return 'waiting';
  if (s.activity === 'working') return 'working';
  if (s.activity === 'idle') return 'idle';
  return s.status === 'input_required' ? 'waiting' : s.status;
}

/**
 * Index live sessions by their full session UUID so a historical `SessionMeta`
 * row (`meta.id`) can be matched to the session that is still running now.
 * Rows without a sessionId (some cloud/headless probes) are skipped — they
 * can't be correlated back to a transcript on disk.
 */
export function indexActiveBySessionId(active: ActiveSession[]): Map<string, ActiveSession> {
  const byId = new Map<string, ActiveSession>();
  for (const a of active) {
    if (a.sessionId) byId.set(a.sessionId, a);
  }
  return byId;
}


/**
 * The live decoration for a listing row: a status glyph and the latest-turn
 * preview, when the session is still running. `●` running / `◐` waiting on the
 * user / `○` idle, colored by the same `statusColor` the --active view uses.
 * Returns empty strings when there is no live match, so callers render the
 * plain historical row unchanged.
 */
export function liveGlyphAndPreview(a: ActiveSession | undefined): { glyph: string; preview: string } {
  if (!a) return { glyph: '', preview: '' };
  // `◌` (dotted) = alive but un-introspectable — visually distinct from `○` idle
  // so an opaque harness is never mistaken for a finished one. `⊘` = abandoned /
  // dangling; `×` = closed (dead pid) — both distinct from the `○` idle a live,
  // stopped session shows, so a gone session never masquerades as a resting one.
  // `✗` = crashed (died WITH its host window, uncleanly) — deliberately louder
  // than the `×` of a clean close. `◍` = orphaned (alive, nothing attached): a
  // filled ring, so it reads as "still burning" unlike the hollow `○` idle.
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

/**
 * The one-word live status for a listing row — `working` / `waiting` / `idle`,
 * the same three states the `--active` column shows, so the default list is no
 * longer just a glyph. `waiting` is the actionable "needs you" case (a question /
 * permission / plan-review), kept distinct from `idle` (stopped) and `working`.
 * Empty for a not-live row, and for the rare no-signal `unknown`. Pure +
 * exported for the row tests.
 */
export function liveStatusWord(a: ActiveSession | undefined): string {
  if (!a) return '';
  // Lifecycle status is definitive — surface it ahead of any parsed activity.
  if (a.status === 'closed' || a.status === 'abandoned') return a.status;
  // Same rank: a lost host is a fact about the session, not about its last turn.
  if (a.status === 'crashed') return 'crashed';
  if (a.status === 'orphaned') return 'orphan';
  if (a.status === 'input_required' || a.activity === 'waiting_input') return 'waiting';
  if (a.status === 'running' || a.activity === 'working') return 'working';
  if (a.status === 'idle' || a.activity === 'idle') return 'idle';
  if (a.status === 'queued') return 'queued';
  return '';
}

/**
 * True when a session is blocked on a human — the `--waiting` contract.
 *
 * NOT `status === 'input_required'`. `foldHostLink` rewrites that status to
 * `orphaned` when nothing is attached, and a session waiting on a question with
 * NOBODY watching is the most acute case `--waiting` exists to surface, not one
 * it should drop. The underlying `activity` is never rewritten, so it is the
 * honest signal here.
 *
 * But `activity` is never rewritten for a DEAD session either: one that died
 * mid-question keeps `waiting_input` forever, and answering it is not a thing a
 * human can do — it needs a relaunch. `--waiting` is a scriptable gate ("does
 * anything need me?"), so a corpse must not trip it.
 *
 * `closed` and `crashed` are unconditionally dead, so they are excluded outright.
 * `abandoned` is NOT: it fires on transcript staleness before the liveness check,
 * so it also covers the live-but-forgotten case — an interactive session that
 * asked a question and sat untouched over a long weekend is still answerable, and
 * is exactly what this gate exists for. It is excluded only when we positively
 * know its process is gone; unknown liveness (an older peer, a row with no pid)
 * stays excluded rather than inventing a human who can answer.
 */
export function isAwaitingUser(s: ActiveSession): boolean {
  if (s.status === 'crashed' || s.status === 'closed') return false;
  if (s.status === 'abandoned' && s.pidAlive !== true) return false;
  return s.status === 'input_required' || s.activity === 'waiting_input';
}

/**
 * Whether a row belongs in an unqualified `--active` view (RUSH-2336) — the
 * ONE canonical selector every bare-active surface shares: the CLI's grouped
 * table and `--json` (`renderActiveSessions`), the interactive browser's
 * `--active` filter ({@link applyFilters} in `sessions-browser.ts`), `focus`'s
 * attach gate (`isAttachableLiveSession`), and the menubar snapshot
 * ({@link computeMenubarSnapshot}).
 *
 * The live registry deliberately retains terminally-dead AND not-yet-started
 * rows long enough for `--closed` / `--crashed` / `--queued` and recovery to
 * find them. Presence in that registry therefore is not, by itself, evidence
 * that a session is CURRENTLY active. Explicit lifecycle filters bypass this
 * predicate and select those retained rows through {@link matchesLiveStatus}
 * instead — this function only decides the unqualified default.
 *
 *   - `queued` / `closed` / `crashed` are never active here: queued hasn't
 *     started yet, closed/crashed are unconditionally dead. All three stay
 *     reachable through their explicit filter.
 *   - A cloud row carries no local pid at all — it is active on the
 *     provider's own word (`cloudProvider` + `cloudTaskId`), never a
 *     fabricated pid.
 *   - Every other row is a real OS process (terminal/tmux/headless/team). It
 *     is active only when the row names the machine it runs on, carries a
 *     positive pid, AND has POSITIVELY verified that pid is alive
 *     (`pidAlive === true` — not merely "not known dead"). A live orphaned
 *     row, or a live-but-stuck abandoned row, still qualifies this way since
 *     both carry a genuinely alive pid; unknown liveness (an older peer's
 *     row, or a pid that could never be resolved) does not.
 */

/** Width of the live status column — `crashed` is the longest word it renders. */
const LIVE_STATUS_W = 8;

/** The colored, space-padded status cell for a listing row (empty when not live). */
function liveStatusCell(live: ActiveSession | undefined): { cell: string; width: number } {
  const word = liveStatusWord(live);
  if (!word || !live) return { cell: '', width: 0 };
  return { cell: statusColor(live.status)(padToWidth(word, LIVE_STATUS_W)), width: LIVE_STATUS_W };
}

/**
 * The tracker/PR ref for a session's dedicated column: the ticket id when known,
 * else `PR#<n>`, else empty. Pulled out of the trailing badge blob so refs align
 * into a scannable column instead of jamming against a truncated topic.
 */
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

/**
 * The single project/group key for an active session row (RUSH-2688). It is the
 * ONE derivation every project-grouped consumer of `--active`/the menubar snapshot
 * shares, so a session is bucketed the same way everywhere:
 *
 *   - A real working dir → its `basename` — the same key SessionMeta derives (see
 *     discover.ts), so the active view and the history view join identically on
 *     (ticketId + project).
 *   - A row with NO local cwd (a cloud task, a provider-run job) → an explicit
 *     bucket keyed by context: `cloud` for a cloud row, else `other`.
 *
 * It never falls back to `kind` (the harness — 'codex', 'claude') or `machine`
 * (the box it runs on): neither is a project, and letting either stand in for the
 * key is exactly what leaked a Codex cloud task under a 'codex' group and a bogus
 * machine label in the menubar. No fallback chain — one explicit bucket.
 */
/**
 * The row shape `agents sessions --active --json` emits. RUSH-1981: a watcher
 * joins active sessions on ticketId + project, but the raw ActiveSession nests
 * the ticket (`ticket.id`) and carries no `project` at all — so a naive join
 * silently drops every row. Emit both as flat, always-present top-level keys
 * alongside the raw fields, so every active row is joinable. `project` is the
 * canonical {@link activeSessionProjectKey} — basename(cwd), or an explicit
 * `cloud`/`other` bucket for a row with no local cwd, never the harness/machine.
 *
 * `viewingIn` flattens to the same display string the row renderer prints —
 * `'codium tab 3'` / `'detached'` / null — so a consumer can tell a watched
 * session from an orphaned one (its terminal died, the agent is still running)
 * without re-implementing the tmux client lookup.
 */

export interface SessionPickerJsonRow extends SessionMeta {
  state: ActiveSession['status'] | 'inactive';
  resumable: boolean;
  unwatched: boolean;
  viewingIn: string | null;
  sourceDevice: string;
  lastActivityMs: number;
  pid: number | null;
  recovery: { command: 'agents'; args: string[]; cwd?: string } | null;
}

/** Canonical JSON row consumed by resume pickers and other session UIs. */
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

/**
 * Compact, colour-coded badges for the durable/awaiting signals. Text-only (no
 * emoji, per repo convention): `plan` / `ask` / `perm` for why it's waiting,
 * `PR#N`, `wt:slug`, `TICKET-123`.
 */
function signalBadges(s: Pick<ActiveSession, 'awaitingReason' | 'pr' | 'worktree' | 'ticket'>): string {
  const parts: string[] = [];
  if (s.awaitingReason === 'plan_review') parts.push(chalk.yellow('plan'));
  else if (s.awaitingReason === 'question') parts.push(chalk.yellow('ask'));
  else if (s.awaitingReason === 'permission') parts.push(chalk.yellow('perm'));
  if (s.ticket) {
    // Clickable when Linear workspace is resolvable (same helper as the picker header).
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

/**
 * Compact locator badge: how to JUMP to the session, not what it's doing.
 * `ssh` flags a remote host. For tmux, prefer the resolved `session:window.pane`
 * (a real `tmux attach -t <session:window>` target) over the raw `%pane` id. For
 * a local Ghostty session we know the tab, show `tab N`. Local, unlocatable
 * sessions add nothing (the common case).
 *
 * RUSH-2336: every row also carries its raw process/provider handle — a
 * `machine:pid` for a real OS process (terminal/tmux/headless/team), or
 * `provider · taskId` for a cloud row with no local pid — so the human view
 * exposes the same locator `--json` now guarantees on every active row.
 */
function locatorBadge(s: ActiveSession): string {
  const p = s.provenance;
  const parts: string[] = [];
  // An ssh-launched session shows where it was launched FROM when the client IP
  // resolves to a registered device (`ssh←zion`); bare `ssh` when it doesn't.
  if (p?.transport === 'ssh') parts.push(chalk.red(p.origin ? `ssh←${p.origin.device}` : 'ssh'));
  if (p?.mux?.kind === 'tmux' && (s.tmuxTarget || p.mux.pane)) {
    parts.push(chalk.green(s.tmuxTarget ?? p.mux.pane!));
    // For a tmux-hosted session, say which app+tab is looking at it right now
    // (or that it's running detached). Only meaningful for tmux (the pane is the
    // durable handle; the viewer is transient).
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

/**
 * The `created X · idle Y` time cell for a live row (RUSH-2205). `created` is the
 * age of the session start ({@link ActiveSession.startedAtMs}); `idle` is the age
 * of the last transcript write ({@link ActiveSession.lastActivityMs}) — i.e. how
 * long it has been quiet. Compact ("6d", "3h", "now") so the row stays width-safe;
 * either half is omitted when its epoch is unknown.
 */
function activeTimeCell(s: ActiveSession): string {
  const parts: string[] = [];
  if (s.startedAtMs) parts.push(`created ${formatCompactAge(new Date(s.startedAtMs).toISOString())}`);
  if (s.lastActivityMs) parts.push(`idle ${formatCompactAge(new Date(s.lastActivityMs).toISOString())}`);
  return parts.join(' · ');
}

/** Column widths for line 1 of an active row (id · agent · version · status · owner). */
const ROW_ID_W = 9;
const ROW_AGENT_W = 8;
const ROW_VERSION_W = 8;
const ROW_STATUS_W = 9;
const ROW_OWNER_W = 9;

/**
 * Fit pre-styled content (which may carry SGR colour AND OSC-8 hyperlinks — the
 * clickable ticket/PR/project badges) into `room` display cells. Returns it raw
 * when it already fits, preserving colour and clickable links; otherwise falls
 * back to a width-safe truncation. `truncateToWidth` strips OSC-8 before cutting
 * (see width.ts), so a too-narrow cell drops the hyperlink cleanly rather than
 * slicing a hyperlink escape in half and corrupting the terminal (RUSH-2205
 * review). Never run pre-linked content through `truncateToWidth` directly — that
 * strips its links even when it fits; go through this helper.
 */
function fitCell(content: string, room: number): string {
  if (room <= 0) return '';
  return stringWidth(content) <= room ? content : truncateToWidth(content, room);
}

/**
 * Build the (one or two) rendered lines for a single active-session row.
 * Indent is the leading whitespace (2 spaces for flat groups, 4 inside a window
 * sub-group). Sized to `termW` so no line ever wraps under tmux/SSH (RUSH-2205):
 *
 *   line 1: id · agent version · status · owner · created X · idle Y · ticket/PR
 *   line 2: └ label/topic (+ checklist) · jump locator (ssh/tmux/detached)
 *
 * The label/topic gets its own line so it is no longer buried in a truncated grey
 * snippet, and the actionable ticket/PR badges ride line 1. Version and the
 * ticket/PR/label are backfilled onto the {@link ActiveSession} from the indexed
 * SessionMeta before this renders (a live process reports none of them). Pure +
 * exported so the row layout is unit-tested for content and width without a
 * captured stdout.
 */
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

  // Line 1 right side: created/idle time + actionable badges (fork count,
  // plan/ask/perm, ticket, PR, worktree). Badges are the jump-to-work signal, so
  // they win the width fight — fitCell keeps them raw+clickable when they fit and
  // drops the link cleanly when narrow; the time cell takes whatever is left.
  const fork = s.pidCount && s.pidCount > 1 ? chalk.dim(`×${s.pidCount} `) : '';
  const badgesCell = fitCell(fork + signalBadges(s), remaining);
  const badgesW = stringWidth(badgesCell);
  const timeRoom = Math.max(0, remaining - (badgesW ? badgesW + 2 : 0));
  const timeCell = chalk.gray(truncateToWidth(activeTimeCell(s), timeRoom));
  let right = timeCell;
  if (badgesCell) right += (stringWidth(timeCell) ? '  ' : '') + badgesCell;
  // right's visible width is <= remaining by construction, so the assembled line
  // is <= termW-1 whenever the fixed columns fit; the clamp only bites a terminal
  // narrower than the fixed columns (where right is empty — no link to corrupt).
  let line1 = indent + fixedCols + right;
  if (stringWidth(line1) > termW) line1 = truncateToWidth(line1, termW);
  const lines = [line1];

  // Line 2: label/topic + checklist (the identity, no longer buried) then the
  // jump locator. Skipped entirely when there is nothing to say. desc may carry a
  // clickable project link, so it also goes through fitCell.
  const desc = formatActiveRowDescription(s);
  const loc = locatorBadge(s);
  if (!desc && !loc) return lines;
  const contIndent = indent + ' '.repeat(ROW_ID_W);
  const room2 = Math.max(0, termW - stringWidth(contIndent) - 2);
  const locCell = fitCell(loc, room2);
  const locW = stringWidth(locCell);
  const descRoom = Math.max(0, room2 - (locW ? locW + 2 : 0));
  const descCell = chalk.white(fitCell(desc || '-', descRoom));
  let line2 = contIndent + chalk.dim('└ ') + descCell;
  if (locCell) line2 += '  ' + locCell;
  if (stringWidth(line2) > termW) line2 = truncateToWidth(line2, termW);
  lines.push(line2);
  return lines;
}

/** Render a single agent-session row inside an already-printed group header. */
function printActiveRow(s: ActiveSession, indent: string): void {
  for (const line of renderActiveRowLines(s, indent, terminalWidth())) console.log(line);
}

/**
 * Compact owner display for the `--active` owner column: the local-part of a
 * resolved actor email/login (`muqsit@getrush.ai` -> `muqsit`), the id as-is
 * when it has no `@`, and `-` when the actor is unresolved (`UNRESOLVED@<host>`)
 * or absent (a launch predating actor stamping). Honest by design — an
 * unresolved local run shows no owner rather than inventing one.
 */
export function ownerLabel(s: ActiveSession): string {
  const owner = s.owner;
  if (!owner || owner.startsWith('UNRESOLVED@')) return '-';
  const at = owner.indexOf('@');
  return at > 0 ? owner.slice(0, at) : owner;
}

/**
 * Short label for an IDE window. The slice key in live-terminals.json is
 * `${vscode.env.sessionId}-${ext-host pid}`; the trailing pid is the cheap
 * stable disambiguator. We surface it as `ext-pid` so two windows on the
 * same repo are visibly different.
 */
function shortWindowLabel(windowId: string): string {
  const m = windowId.match(/-(\d+)$/);
  return m ? `ext-pid ${m[1]}` : `win ${windowId.slice(0, 8)}`;
}

/** Grouped + sorted view of active sessions for the --active renderer. */
export interface ActiveSessionsLayout {
  workspaces: Array<{
    /** Internal grouping key — `__cloud__`, `__unknown__`, or the cwd. */
    key: string;
    /** Sessions in this workspace, both windowed and flat (preserves total count). */
    total: number;
    /** Terminals grouped by IDE window (sorted by oldest startedAtMs). */
    windows: Array<{ windowId: string; sessions: ActiveSession[] }>;
    /** Everything else in this workspace: cloud, teams, headless, terminals without a windowId. */
    flat: ActiveSession[];
  }>;
}

/**
 * Group sessions by workspace, then split each workspace into IDE-window
 * sub-groups + a flat bucket. Pure function — no I/O — so the renderer's
 * grouping rules can be tested without mocking the session scanner.
 *
 * Sort order:
 *   - workspaces: by session count descending, then key ascending
 *   - windows within a workspace: by oldest startedAtMs ascending
 *   - sessions within a window/flat bucket: input order preserved
 */
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

/** One machine's active sessions, keeping the within-machine workspace layout. */
export interface MachineGroup {
  /** Normalized device id (machineId() form). */
  machine: string;
  /** The machine this command is running on — pinned first and marked. */
  isLocal: boolean;
  total: number;
  layout: ActiveSessionsLayout;
}

/** Active sessions grouped by the machine they run on. */
export interface MachineGroupedLayout {
  machines: MachineGroup[];
}

/**
 * The machine a session belongs to: an explicit tag (set when merging
 * cross-machine results) wins; else the process's provenance host (normalized
 * to the same id form); else the local machine. Never keys off `ActiveSession.host`
 * — that is the terminal *app* (code/tmux), not the computer.
 */
/** Synthetic top-level group key for provider-sandboxed cloud tasks. */
const CLOUD_MACHINE_KEY = 'cloud';

function machineKeyFor(s: ActiveSession, localMachine: string): string {
  // Cloud tasks run in a provider sandbox, not on the machine they're attributed
  // to for reply routing (s.machine = the querier). Surface them as their own
  // top-level "cloud" group instead of nested under the local device.
  if (s.context === 'cloud') return CLOUD_MACHINE_KEY;
  if (s.machine) return s.machine;
  if (s.provenance?.host) return normalizeHost(s.provenance.host);
  return localMachine;
}

/**
 * Group active sessions by machine, then delegate each machine's sessions to the
 * existing workspace/window grouping. Local machine is pinned first and flagged;
 * the rest sort by session count descending, then name. Pure — `localMachine` is
 * injected so the function stays testable without reading os.hostname().
 */
export function groupSessionsByMachine(sessions: ActiveSession[], localMachine: string): MachineGroupedLayout {
  const byMachine = new Map<string, ActiveSession[]>();
  for (const s of sessions) {
    const key = machineKeyFor(s, localMachine);
    (byMachine.get(key) ?? byMachine.set(key, []).get(key)!).push(s);
  }
  const keys = Array.from(byMachine.keys()).sort((a, b) => {
    if (a === localMachine) return -1;
    if (b === localMachine) return 1;
    // The synthetic "cloud" category sorts after all real machines.
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

/**
 * Collapse duplicate sessions after a cross-machine merge. Two rows collapse
 * only when they share both machine and session UUID (the same host listed
 * twice, or a local/remote overlap); rows without a sessionId can't be
 * correlated, so they're all kept.
 */
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
    // Both rows now describe the same session on the same machine, so the tie is
    // between the EXECUTING box's own row and the dispatcher's shim row for a
    // host-dispatched run (they only started colliding once foldExecutionMachine
    // attributed both to the executing host — RUSH-2479). The shim carries no
    // transcript and a `[host/<peer>]` placeholder label, so keeping it first
    // would strip a real preview off the merged fleet view. Prefer the row that
    // is not an offload shim; otherwise the first one still wins.
    if (out[at].offloadedFrom && !s.offloadedFrom) out[at] = s;
  }
  return out;
}

/**
 * Narrow a gathered live set to the machines an explicit `--device`
 * scope named. The gather picks which boxes to ASK; this asserts what the answer
 * may contain, and the two are not the same question: a host-dispatched run is
 * reported by the box that dispatched it while executing somewhere else, so
 * `--device <dispatcher>` used to list sessions that were not running there at
 * all (RUSH-2479). No scope → unchanged. Pure; exported for unit testing.
 */
export function filterActiveSessionsByHostScope(
  sessions: ActiveSession[],
  hosts: string[] | undefined,
  self: string,
): ActiveSession[] {
  if (!hosts || hosts.length === 0) return sessions;
  const wanted = new Set(hosts.map(hostToken));
  return sessions.filter((s) => wanted.has(s.machine ?? self));
}

/**
 * Order a merged listing so the local machine's sessions come first, then each
 * remote machine as a contiguous block (more sessions first, then name), with
 * every machine keeping its incoming order (timestamp) within the block. Also
 * dedupes: a session present both locally (a synced mirror copy) and via live
 * fan-out collapses to one, keyed by machine + session id. Rows are keyed by
 * `machine` (discover tags local rows with the local id; fan-out tags remote
 * rows with the peer id) falling back to `localMachine` when untagged. Pure —
 * `localMachine` is injected so the ordering is testable without os.hostname().
 */
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

/**
 * Serialize a `SessionMeta[]` to the clean JSON shape the `--json` listing
 * emits: strip the internal-only scoring/provenance fields (`_matchedTerms`,
 * `_bm25Score`, `_remote`) that are search/fan-out bookkeeping, never part of
 * the public record, then pretty-print as a 2-space array with a trailing
 * newline. The single seam shared by the local `--json` path and the
 * `--json --host` remote fan-out so both emit byte-identical row shapes.
 */

/** The intentionally small metadata contract emitted by `sessions --resolve`.
 * It includes only launch identity needed to route/resume. Transcript paths,
 * extracted plans, costs, and content stay on the machine that owns them. */
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

/**
 * `agents sessions --json --host <h>` — fan the RECENT (non-active) listing out
 * to the named host(s) and emit ONE clean merged `SessionMeta[]` JSON array,
 * the same shape the local `--json` path emits. Reuses `gatherRemoteList` (the
 * exact SSH fan-out the interactive cross-machine listing already uses) and
 * serializes the merged, machine-tagged rows — instead of `runRemoteSessions`,
 * which streams each remote's raw stdout under a per-host banner and so can
 * never be JSON.parsed. A dead host contributes `[]` (with a stderr note from
 * the fan-out), so stdout is always a valid array and the exit stays 0.
 */
async function runRemoteSessionsJson(hosts: string[]): Promise<void> {
  // Forward the caller's own filters (query, --limit, --since, …) minus --host,
  // and guarantee --json so each peer answers with a parseable array. Force
  // whole-index scope: an explicit --host means "that box's index", not the
  // slice that happens to sit under the peer's SSH-login home dir.
  const forwarded = ensureWholeIndex(buildForwardedArgs(process.argv, new Set(hosts)));
  if (!forwarded.includes('--json')) forwarded.push('--json');
  const { sessions } = await gatherRemoteList(forwarded, hosts);
  process.stdout.write(serializeSessionsJson(sessions));
}

/** Parse one peer's computer-run array without accepting banners or partial
 * JSON. The fan-out boundary supplies the machine name when an older peer row
 * omitted it. */
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

/** Collect computer history from named peers, or every automatic peer when
 * hosts is omitted. Every peer is forced to JSON and receives the recursion
 * guard through the shared fleet transport. */
export async function gatherRemoteComputerSessionRows(hosts?: string[]): Promise<ComputerRunRow[]> {
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

/**
 * `running N · idle N · waiting N · queued N · closed N · abandoned N · unknown N`
 * for a bucket of sessions (zero buckets omitted). Same bucketing as the summary so
 * per-group counts reconcile with the `(total)` beside the header — the `unknown`
 * bucket is what keeps an alive-but-opaque row from silently vanishing from the
 * tally. Empty when nothing.
 */
function groupTally(sessions: ActiveSession[]): string {
  const running = sessions.filter(s => s.status === 'running').length;
  const idle = sessions.filter(s => s.status === 'idle').length;
  const waiting = sessions.filter(s => s.status === 'input_required').length;
  // Counted by status, deliberately: an orphaned session gets its own bucket
  // below, so counting it here too would double-count it in the tally.
  const queued = sessions.filter(s => s.status === 'queued').length;
  const closed = sessions.filter(s => s.status === 'closed').length;
  const abandoned = sessions.filter(s => s.status === 'abandoned').length;
  // Without these two the tally silently loses rows: every status must have a
  // bucket or "N active (…)" stops adding up to what the list shows.
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

/** Print one machine's workspace tree, indented under its machine header. */
function renderWorkspaceLayout(layout: ActiveSessionsLayout, base: string, machineKey?: string): void {
  let first = true;
  for (const ws of layout.workspaces) {
    if (!first) console.log();
    first = false;

    // Under the top-level "cloud" machine group the __cloud__ workspace header is
    // redundant ("▸ cloud" then "cloud") — render its rows flat under the machine
    // header instead. Row indent collapses by one level to match.
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
      // Host is per-process, but every terminal in the same IDE window shares
      // an ancestor — take the first non-empty host as the window's label.
      const host = win.sessions.find((s) => s.host)?.host ?? 'terminal';
      const winHeader = `${chalk.gray(host)} ${chalk.gray('·')} ${chalk.gray(shortWindowLabel(win.windowId))} ${chalk.gray(`(${win.sessions.length})`)}`;
      console.log(rowBase + winHeader);
      for (const s of win.sessions) printActiveRow(s, rowBase + '  ');
    }

    for (const s of ws.flat) printActiveRow(s, rowBase);
  }
}

/** Machine header: `▸ <name> ← this machine` for the local box (cyan), matching
 * the `ag devices list` treatment; a plain `▸ <name>` for remotes. */
function printMachineHeader(mg: MachineGroup): void {
  // The synthetic "cloud" group isn't a device — tint it magenta (matching the
  // cloud row/label styling) so it reads as a category, not a machine.
  const isCloud = mg.machine === CLOUD_MACHINE_KEY;
  const marker = mg.isLocal ? chalk.cyan('▸ ') : isCloud ? chalk.magenta('▸ ') : chalk.gray('▸ ');
  const name = mg.isLocal ? chalk.bold.cyan(mg.machine) : isCloud ? chalk.bold.magenta(mg.machine) : chalk.bold(mg.machine);
  const here = mg.isLocal ? chalk.cyan('  ← this machine') : '';
  console.log(`${marker}${name} ${chalk.gray(`(${mg.total})`)}${here}`);
}

/**
 * Attach display-only jump locators onto LOCAL sessions: the Ghostty tab number
 * (one batched read-only osascript, only when a local ghostty session exists)
 * and the tmux `session:window.pane` target (one `list-panes -a` per socket).
 * Every step is best-effort and swallowed — a failure just leaves the raw pane
 * id / no tab number, and the rows render as before. Mutates the sessions.
 */
async function enrichLocalLocators(local: ActiveSession[]): Promise<void> {
  // Ghostty tab numbers.
  try {
    const ghostty = local.filter(s => s.host === 'ghostty' && s.provenance?.transport !== 'ssh');
    if (ghostty.length > 0) {
      const surfaces = await enumerateGhosttyTabs();
      for (const [sess, tab] of assignGhosttyTabs(ghostty, surfaces)) sess.ghosttyTab = tab;
    }
  } catch { /* non-fatal */ }

  // One Ghostty enumeration shared across every socket's viewing-in resolve
  // (a tmux client can be attached from a Ghostty tab).
  await enrichTmuxLocators(local, await enumerateGhosttyTabsQuietly());
}

/** {@link enumerateGhosttyTabs}, best-effort — an osascript failure yields no surfaces. */
async function enumerateGhosttyTabsQuietly(): Promise<GhosttySurface[]> {
  try {
    return await enumerateGhosttyTabs();
  } catch {
    return [];
  }
}

/**
 * The tmux half of {@link enrichLocalLocators}: the `session:window.pane` attach
 * target and "viewing in <app> tab N" / detached, one batched query per socket.
 *
 * Split out because it is the only locator the `--json` path can afford. It costs
 * tmux queries and a `ps` read — no osascript — so scriptable output stays cheap
 * while still answering the question a consumer actually needs: is anyone looking
 * at this session, or is it running orphaned? Without `surfaces`, a Ghostty-attached
 * client still resolves as attached, just without its tab number.
 */
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
  } catch { /* non-fatal */ }
}

/** Normalize a `--device` token (`alias`, `user@host`, `host.domain`)
 * to the machine id the fan-out and registry key off. */
function hostToken(h: string): string {
  return normalizeHost(h.split('@').pop() || h);
}

/**
 * Whether the local machine's sessions belong in an `--active` view. Local is
 * included by default; an explicit `--device` list scopes the view to
 * exactly those machines, so local is dropped unless it is itself named (by
 * alias or `user@host`, matched on the normalized machine id). Exported for
 * unit testing without touching SSH or the live process table.
 */
export function shouldIncludeLocal(hosts: string[] | undefined, self: string): boolean {
  if (!hosts || hosts.length === 0) return true;
  return hosts.some(h => hostToken(h) === self);
}

/**
 * The peers to dial for an `--active` view. No `--device` → `undefined`, which
 * tells `gatherRemoteActive` to sweep the registered online devices. An
 * explicit list → exactly those, minus this machine (its sessions come from the
 * local seed, so dialing self would be a wasted SSH and a spurious "unreachable"
 * note). Returns `[]` when the only named host is self — the caller then skips
 * the remote fan-out entirely rather than letting `[]` trigger the sweep.
 * Exported for unit testing.
 */
export function remoteHostsToDial(hosts: string[] | undefined, self: string): string[] | undefined {
  if (!hosts || hosts.length === 0) return undefined;
  return hosts.filter(h => hostToken(h) !== self);
}

/**
 * The fleet-wide live-session set behind every `--active` surface. Local sessions
 * come from `getActiveSessions()` and (unless `--local`) the registered online
 * devices from `ag devices` are folded in over SSH. An explicit `--device`
 * list SCOPES the sweep to exactly those machines — the local machine is included
 * only when it is itself named — so `--device` is a filter, not an addition.
 *
 * This is the single gather: the static renderer AND the interactive browser both
 * call it, so the browser can never disagree with `--active --json` about which
 * sessions are live (it used to call the local-only `getActiveSessions()` directly
 * and silently hid every remote session).
 *
 * RUSH-2062: default path is cache-first against the daemon-warmed shared
 * snapshot (`session-cache.ts`). Menubar / Factory / watchdog / CLI share one
 * warm result instead of each re-running the full SSH fan-out. `forceRefresh`
 * (or `AGENTS_SESSIONS_FORCE_REFRESH=1`) re-gathers live; scoped `--device` lists
 * always gather live so a filter never returns a wrong unscoped snapshot.
 */
export async function gatherActiveSessions(
  opts: { local?: boolean; hosts?: string[]; forceRefresh?: boolean } = {},
): Promise<{
  sessions: ActiveSession[];
  remoteDeviceCount: number;
  /** Peer names that went unheard on this gather (RUSH-2507). Undefined when unknown (e.g. a cache hit). */
  remoteSkipped?: string[];
  remoteDiscoveryFailed?: boolean;
}> {
  const forceRefresh = opts.forceRefresh === true
    || process.env.AGENTS_SESSIONS_FORCE_REFRESH === '1';
  // Scoped host lists are not represented in the unscoped fleet/local snapshot
  // — always gather live so a filter cannot return the wrong set.
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

/**
 * Live (uncached) gather — the work the daemon / force-refresh path pays once
 * so other surfaces can share the snapshot. Kept separate so the cache layer
 * never recursively re-enters itself.
 */
async function gatherActiveSessionsLive(
  opts: { local?: boolean; hosts?: string[] } = {},
): Promise<{
  sessions: ActiveSession[];
  remoteDeviceCount: number;
  remoteSkipped: string[];
  remoteDiscoveryFailed: boolean;
}> {
  const self = machineId();
  // An explicit --host/--device list scopes the view: seed local sessions only
  // when no hosts are named, or when this machine is one of the named targets.
  // `localOnly: opts.local` (RUSH-2118) keeps a `--local` query from dialing a
  // remote-host teammate over ssh even for this machine's OWN local gather —
  // "this machine only" must mean zero ssh, not just "skip the cross-machine
  // device fan-out below".
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
    // An explicit list naming only self leaves nothing remote to dial — skip the
    // fan-out rather than let an empty list fall through to the device sweep.
    if (!opts.hosts?.length || (remoteHosts && remoteHosts.length > 0)) {
      const remote = await gatherRemoteActive(remoteHosts);
      remoteDeviceCount = remote.deviceCount;
      remoteSkipped = remote.skipped;
      remoteDiscoveryFailed = remote.discoveryFailed;
      merged = dedupeByMachineSession([...local, ...remote.sessions]);
    }
  }
  // Asking a box is not the same as a session running there: a host-dispatched
  // run is reported by its dispatcher while executing on the peer. Scope on the
  // machine the session runs on so `--device X` never lists someone else's work
  // (RUSH-2479). Applied here, in the single gather, so the interactive browser
  // gets the same answer as `--active --json`.
  return {
    sessions: filterActiveSessionsByHostScope(merged, opts.hosts, self),
    remoteDeviceCount,
    remoteSkipped,
    remoteDiscoveryFailed,
  };
}

/**
 * Explain an empty `--active` result instead of the old flat
 * "No active agent sessions." either way (RUSH-2507: a live fleet sweep found
 * ~41 running agents while this printed the same line as a genuinely idle
 * fleet). Re-probes local tmux health only now, on the empty path, and names
 * any remote peer that went unheard rather than silently folding it into
 * "nothing running".
 */
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

/**
 * Render the unified active-session view, grouped by machine. Scoping and the
 * fleet sweep live in {@link gatherActiveSessions}; this owns the presentation
 * (the `--waiting` gate, JSON, and the grouped table). A tip is shown when there
 * are no other machines to include.
 */
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
  // Backfill agent version, refs, created time, and routine provenance from the
  // historical index. Routine filtering needs that provenance before it narrows
  // the live pool; doing it here also enriches both JSON and human output.
  backfillActiveRowsFromIndex(gathered.sessions);
  // --bookmarks narrows the live view too. Applied HERE, not only in the
  // browser: the browser is skipped for --json, --waiting, a pipe, a multi-host
  // scope, and an SSH-fanout peer, and the flag silently did nothing on every
  // one of those paths — including `--active --bookmarks --json`, which is
  // exactly what the browser's own `y` copy-cmd hands to an agent.
  const merged = opts.bookmarksOnly
    ? gathered.sessions.filter((s) => !!s.sessionId && listBookmarks().has(s.sessionId))
    : gathered.sessions;
  const routineFiltered = filterActiveSessionsByRoutine(merged, opts.routine);

  // Status flags form a union. --waiting additionally retains its scriptable
  // gate: exit non-zero when the union contains a session awaiting the user.
  const statusFiltered = opts.statuses?.length
    ? routineFiltered.filter((session) => opts.statuses!.some((status) => matchesLiveStatus(session, status)))
    : routineFiltered.filter(isRunningLiveSession);
  const sessions = statusFiltered;

  if (asJson) {
    // Resolve who is watching each local tmux pane before serializing: `viewingIn`
    // is how a consumer distinguishes a session someone is looking at from one
    // running orphaned after its terminal died. tmux-only (no osascript) so the
    // scriptable path stays cheap — see enrichTmuxLocators.
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

  // Enrich LOCAL sessions with jump locators (display-only, after the --json /
  // --waiting gates so scriptable output stays osascript-free). Remote sessions
  // keep their raw pane id — their tmux/Ghostty live on the other machine.
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
  // The synthetic "cloud" group is a category, not a machine — exclude it from the
  // machine count and note it separately so the tally stays truthful.
  const realMachines = grouped.machines.filter((m) => m.machine !== CLOUD_MACHINE_KEY).length;
  const hasCloud = grouped.machines.some((m) => m.machine === CLOUD_MACHINE_KEY);
  const machineWord = realMachines === 1 ? 'machine' : 'machines';
  const cloudNote = hasCloud ? ' + cloud' : '';
  console.log(chalk.gray(`\n${sessions.length} active (${parts.join(', ')}) across ${realMachines} ${machineWord}${cloudNote}.`));

  // Tip only when nothing else could be included and the user didn't opt out.
  if (!opts.local && !opts.hosts?.length && remoteDeviceCount === 0) printCrossMachineTip();

  // Scriptable gate: a non-zero exit when anything is waiting on the user.
  if (waitingOnly && sessions.some(isAwaitingUser)) process.exitCode = 1;
}

/** Apply the routine selector to enriched live rows for every non-browser active view. */
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

/** Match the status words users see, preserving activity's richer working signal. */
export function matchesLiveStatus(session: ActiveSession, status: LiveStatusFilter): boolean {
  if (status === 'working') return session.activity === 'working' || (!session.activity && session.status === 'running');
  if (status === 'waiting') return isAwaitingUser(session);
  return session.status === status;
}

/** Resolve convenience flags once. Multiple flags intentionally form a union. */
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

/** Nudge shown when `--active` has no other machines to fold in. */
function printCrossMachineTip(): void {
  console.log(chalk.gray(
    "\nTip: include sessions from your other machines — register them with 'ag devices sync', then rerun. Use --local to skip.",
  ));
}

/**
 * True when the interactive session browser should open instead of a printed
 * listing: a real TTY, no `--json`, and `--no-interactive` not set. The bare
 * listing and `--active` both default to it; scripts/pipes/agents fall through
 * to the existing printed/JSON paths.
 */
function useInteractiveBrowser(options: SessionsOptions): boolean {
  return options.interactive !== false && !options.json && isInteractiveTerminal();
}

/**
 * A bare interactive fleet listing — no query, no render/filter flag — that the
 * `runSessionBrowser` picker can represent. The single predicate shared by the
 * bare-browser branch and the `--device` early-return guard so they can't drift:
 * when this holds, an explicit `--device` scope is folded into the
 * browser (preview-rich, selectable) instead of the legacy per-host raw stream.
 */
export function isBareBrowserListing(options: SessionsOptions, query: string | undefined): boolean {
  return (
    useInteractiveBrowser(options) &&
    // A peer answering a fan-out must never open a TUI. It has no TTY either, so
    // this is the explicit half of a guard that otherwise rests on the implicit
    // invariant that peers are always dialed with --json (see remote-list.ts).
    process.env.AGENTS_SESSIONS_LOCAL !== '1' &&
    hasNoBrowserDisqualifyingFlags(options, query)
  );
}

/**
 * Pure flag-gate half of {@link isBareBrowserListing} (TTY-independent, so it is
 * unit-testable): true when no query, render, or filter flag is present that the
 * `runSessionBrowser` picker cannot represent.
 */
export function hasNoBrowserDisqualifyingFlags(
  options: SessionsOptions,
  query: string | undefined
): boolean {
  return (
    !query &&
    // A named team view is a flat selectable pool; the bare --teams report
    // stays grouped and printed because the browser cannot preserve its shape.
    (!options.teams || !!options.inTeam) &&
    !options.flat &&
    !options.tree &&
    !options.markdown &&
    !options.until &&
    !options.project &&
    // The interactive browser picker is a fuzzy-search TUI over the discovered
    // pool, not a SQL-filtered listing — it cannot represent a skill/plugin
    // scope. Falling through to it here would silently drop the filter and
    // show the unfiltered pool instead (same reasoning as --project/--sort).
    !options.skill &&
    !options.plugin &&
    !options.sort &&
    // --routine without a name owns a two-stage picker (routine -> run ->
    // session), and a named routine owns the run-grouped overview. The generic
    // browser can only flatten routine sessions into its ordinary row list, so
    // routing this flag there silently bypasses both routine-specific views.
    !options.routine &&
    !options.artifacts &&
    options.artifact === undefined &&
    // --cloud lists a provider's tasks, not the transcript index, and
    // runCloudSessions has no host scope — letting a `--device X --cloud` fall
    // through to the browser gate would silently drop the X the user asked for.
    !options.cloud &&
    // The browser carries ONE device in its filter and `y` copies back exactly
    // one --device, so a multi-host scope can't round-trip. Those stay on the
    // legacy per-host stream, which prints each peer under its own banner.
    (options.host?.length ?? 0) <= 1
  );
}

/** Resolve a typed routine selector by exact name, substring, or one unambiguous typo. */
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

export interface RoutineChoice {
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
  // Routines whose only attempts are pre-session (blocked/skipped/failed-before-
  // spawn) have run records but no transcript. Surface them so the picker is
  // built from definitions+runs, never only transcripts — otherwise a routine
  // that has never produced a session reads as "No routines match" (the plan).
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

/** `listJobsWithRuns` but never throws into the sessions reader (best-effort). */
function safeListJobsWithRuns(): string[] {
  try {
    return [...new Set([...listJobs().map((job) => job.name), ...listJobsWithRuns()])];
  } catch { return []; }
}

/**
 * Resolve which routine the user is targeting for `--routine`. Returns `null` to
 * ABORT the command (a bad `--routine <name>` printed an error, or the user
 * cancelled the interactive pick). `{ name: null }` means "no routine was
 * selected, don't filter" — the degenerate bare `--routine` piped to a
 * non-interactive sink. `{ name }` is a chosen routine.
 *
 * The name universe is transcripts UNION every routine with a definition or a
 * run record (`safeListJobsWithRuns`), so a command-only or never-ran routine —
 * which produces no `SessionMeta` — still resolves and drills down.
 */
export async function selectRoutineTarget(
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

// ── Routine drilldown ────────────────────────────────────────────────────────
// The run/session seam: a routine's canonical history is its run records
// (`.history/runs/<name>/<runId>/`, read by `listRuns`), NOT the session index.
// Command/blocked/skipped/missed attempts produce a run record with no
// transcript, so a picker built only from `SessionMeta` dead-ends on them. The
// drilldown renders run records first and links each to the indexed agent
// sessions archived under the same `routineRunId` — never synthesizing a fake
// session row for an attempt that produced none.

/** How a run executed — decides whether an agent session is even expected. */
export type RoutineExecutionKind = 'agent' | 'command' | 'workflow';

export function executionKind(meta: RunMeta): RoutineExecutionKind {
  if (meta.workflow) return 'workflow';
  if (meta.agent) return 'agent';
  return 'command';
}

/** One canonical run record plus the indexed sessions linked to it by run id. */
export interface RoutineRunEntry {
  meta: RunMeta;
  sessions: SessionMeta[];
}

export interface RoutineDrilldown {
  name: string;
  /** Canonical run records (newest first), each with its linked sessions. */
  runs: RoutineRunEntry[];
  /** Sessions whose `routineRunId` matches no local run record — e.g. archived
   *  on another host whose run dir this box has not synced. Grouped by run id so
   *  they are still shown, honestly separated from the canonical run history. */
  orphanSessions: RoutineRunGroup[];
  /** Count of canonical run records (any status, incl. missed/blocked/skipped). */
  runRecordCount: number;
  /** Count of linked indexed sessions across all runs (+ orphans). */
  linkedSessionCount: number;
  /** True when any run ran an agent or any session is linked — i.e. an agent
   *  routine. False for a pure command routine, where no session is expected. */
  isAgentRoutine: boolean;
}

/**
 * Reconcile a routine's canonical run records (`listRuns`, local disk) with the
 * indexed sessions for that routine (fleet-wide, keyed by `routineRunId`).
 */
export function buildRoutineDrilldown(name: string, sessions: SessionMeta[]): RoutineDrilldown {
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
    // Newest run first: `startedAt`, then run id (an ISO-derived slot) as a tie-break.
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
    // "Agent routine" = anything that isn't purely command runs. A workflow run
    // carries no `agent` field but still expects a session, so key off
    // executionKind, not `agent` alone.
    isAgentRoutine: runs.some((r) => executionKind(r) !== 'command') || forRoutine.length > 0,
  };
}

/** Glyph + word for a run's terminal status. */
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

/** Where a run's body executed: a host, a cloud provider, or this machine. */
function runPlacement(meta: RunMeta): string {
  if (meta.host) return `host:${meta.host}`;
  if (meta.cloudProvider) return `cloud:${meta.cloudProvider}`;
  return 'local';
}

/** The trigger clause: kind + who triggered it (dropping the noisy UNRESOLVED). */
function runTrigger(meta: RunMeta): string {
  const kind = meta.triggerKind ?? 'schedule';
  const who = meta.triggeredBy && !meta.triggeredBy.startsWith('UNRESOLVED') ? ` by ${meta.triggeredBy}` : '';
  return `${kind}${who}`;
}

/** The tail clause explaining a run's outcome (exit code / error / skip reason). */
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
  // A clean `exit 0` is already implied by the green "completed" status — only a
  // non-zero code carries information worth a tail clause.
  if (typeof meta.exitCode === 'number' && meta.exitCode !== 0) return `exit ${meta.exitCode}`;
  return '';
}

/** Compact per-session metadata line under a linked session row. */
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

/**
 * Render the routine drilldown: canonical run history first, each run linked to
 * its indexed agent session(s). This is the run/session seam made visible — a
 * command routine shows its runs and states plainly that no session is expected;
 * an agent routine shows the same runs plus each run's session metadata.
 */
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
  // A routine with no session ever produced is a command routine — say so up
  // front so the empty session column reads as expected, not as missing data.
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
    // Log/report access — both are children of the run dir that a pre-execution
    // terminal (blocked/skipped/missed) never wrote, so gate each on existence
    // rather than pointing at a file that isn't there.
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
      // An agent run that produced no session — say why (the run terminal
      // explains it), never fake a session row.
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
  // Every listing path must say what it dropped (sessions.ts invariant). Under
  // --routine team-origin sessions are shown (hiddenCount is 0), but unmanaged
  // installs may still be hidden — surface both footers when non-zero.
  if (opts.hiddenCount && opts.hiddenCount > 0) console.log(chalk.gray(formatTeamHiddenFooter(opts.hiddenCount)));
  if (opts.hiddenUnmanaged && opts.hiddenUnmanaged > 0) console.log(chalk.gray(formatUnmanagedHiddenFooter(opts.hiddenUnmanaged)));
}

/** The canonical `ag sessions …` command for a set of flags — the twin of the
 * browser's `y` hotkey (see --print-cmd). Normalizes to the stable flag form. */
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

/** Resolve a session by id/query globally and print its compact preview (no pager).
 * Backs `--preview` — the fast path for the "peek before resume" hot loop. */
export async function renderSessionPreview(
  query: string,
  scope: { agent?: string; project?: string; local?: boolean; hosts?: string[]; json?: boolean },
): Promise<void> {
  let outcome = await resolveSessionMetadataValue(query, scope);
  // resolveSessionMetadataValue already consults the live registry for a running
  // session with no transcript row (RUSH-2682), so a live session resolves above.
  // This block still repairs the residual case — a session whose transcript is on
  // disk but not yet indexed (e.g. one that just ended). `waitForScan` makes the
  // repair honest: when another process holds the scan claim it waits for that
  // scan instead of returning the stale read. Also preserves Claude history-alias
  // discovery.
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
    // RUSH-2492: an unreachable peer is a warning, not a hard failure. The
    // resolver already resolves an id found on the reachable fleet (SES-9a),
    // so reaching here means the session was not found on any device we COULD
    // reach — it may live on an unreachable peer, which we could not check.
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

  // Lead with the live status when the session is still running, so the preview
  // says working / waiting / idle up front — not just the historical transcript.
  // The shared snapshot is accepted for at most 15 seconds. The durable preview
  // below contains no live status, so a long-lived process can never keep a
  // stale working/waiting headline in its transcript cache.
  let live: ActiveSession | undefined;
  try {
    const loaded = await loadLocalActiveSessions();
    live = indexActiveBySessionId(loaded.sessions).get(session.id);
  } catch { /* plain preview on any probe failure */ }
  if (scope.json) {
    const { digest, error } = loadSessionPreviewDigest(session);
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
    }));
    return;
  }
  const headline = formatLiveStatusHeadline(live, isBookmarked(session.id));
  if (headline) console.log(headline);
  console.log(buildPreview(session));
}

/**
 * The one-line live status banner shown above a session preview: the glyph, the
 * status word, and — when the session needs a human or has LOST one — a plain
 * sentence saying so. Shared by `--preview` and the interactive browser's preview
 * pane so both explain a state the same way.
 *
 * `crashed` and `orphaned` are the states a glyph alone cannot carry: nobody
 * reads "orphan" and knows it means "still running in tmux with no window
 * attached", so those two spell it out.
 */
export function formatLiveStatusHeadline(live: ActiveSession | undefined, bookmarked = false): string {
  const star = bookmarked ? chalk.yellow('★ ') : '';
  // With no live row there is no status to lead with, so the star has to say
  // what it means on its own — a bare `★` above a preview reads as noise.
  if (!live) return bookmarked ? chalk.yellow('★ bookmarked') : '';
  const { glyph } = liveGlyphAndPreview(live);
  const word = liveStatusWord(live) || live.status;
  // One definition, shared with `--waiting`. A second local copy drifted: the
  // preview said "needs you" for a dead session that `--waiting` had (rightly)
  // stopped counting, so the human and the script disagreed about the same row.
  const needsYou = isAwaitingUser(live);
  const reason = live.awaitingReason ? ` (${live.awaitingReason.replace('_', ' ')})` : '';
  let suffix = needsYou ? chalk.yellow(`  ← needs you${reason}`) : '';
  if (live.status === 'crashed') {
    suffix = chalk.redBright('  ← the host app or connection went away and took the agent with it');
  } else if (live.status === 'orphaned') {
    // Keep the needs-you half. A session sitting on a real question with nobody
    // attached is strictly worse than either fact alone, and replacing the
    // question with the generic orphan line undersells exactly that case.
    suffix = needsYou
      ? chalk.yellow(`  ← waiting on you${reason}, and no client is attached to answer it`)
      : chalk.yellow('  ← still running, but no client is attached — nothing is showing it');
  }
  return `${star}${glyph} ${statusColor(live.status)(word)}${suffix}`;
}

/** Merge local and peer envelopes without changing the versioned JSON shape. */
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

/** Partition a fleet query by transcript origin so synced mirrors cannot duplicate results. */
export function toolOriginSessions(
  sessions: SessionMeta[],
  machine: string,
  originOnly: boolean,
): SessionMeta[] {
  return originOnly
    ? sessions.filter((session) => (session.machine ?? machine) === machine)
    : sessions;
}

export function printToolProgramCount(envelope: ToolProgramCountEnvelope): void {
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

/** Compact grouped evidence for humans; JSON retains every bounded field. */
export function printToolSearch(envelope: ToolSearchEnvelope): void {
  for (const session of envelope.sessions) {
    const machineName = session.machine
      ? truncate(sanitizeForTerminal(session.machine).replace(/\s+/g, ' '), 80)
      : '';
    const machine = machineName ? ` @ ${machineName}` : '';
    const rawHeading = session.label || session.topic || session.project || session.shortId;
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

/** Main action handler for `agents sessions`. Routes to picker, table, or single-session render. */
async function sessionsAction(
  query: string | undefined,
  options: SessionsOptions,
  /**
   * Where commander got `--limit` from: 'cli'/'env' when the user supplied it,
   * 'default' when it filled in its own. Truthiness can't tell those apart,
   * because the default arrives as a string like any typed value.
   */
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
    // Outside tool evidence mode, --query retains its original positional-search
    // meaning. The collector only makes it repeatable for tool clauses.
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

  // Normalize convenience flags before any routing reads them: per-agent
  // shorthands fold into --agent; --device and --devices (both
  // resolve against the same device registry).
  applyAgentShorthands(options);
  try {
    query = applyVersionFilters(query, options);
  } catch (error) {
    console.error(chalk.red(error instanceof Error ? error.message : String(error)));
    process.exitCode = 1;
    return;
  }
  // --device / --devices values are merged into options.host for internal routing. A bare `all` / `fleet` sentinel means
  // "search every peer" — which is already the default for `--active` and the
  // interactive listing — so it resolves to no explicit host set rather than
  // erroring on a device literally named "all".
  const rawDeviceTargets = [...(options.device ?? []), ...(options.devices ?? [])];
  // But the HISTORICAL `--json` listing does NOT fan out by default (it stays a
  // deterministic local slice for scripts), so the sentinel would otherwise be
  // silently dropped and the fleet never reached (PHNX-2673). Remember it so that
  // path can sweep every peer, exactly as the interactive listing already does.
  const fleetWide = rawDeviceTargets.some(t => t.toLowerCase() === 'all' || t.toLowerCase() === 'fleet');
  const deviceTargets = rawDeviceTargets
    .filter(t => t.toLowerCase() !== 'all' && t.toLowerCase() !== 'fleet');
  if (deviceTargets.length > 0) {
    options.host = [...(options.host ?? []), ...deviceTargets];
  }

  // --print-cmd: echo the canonical `ag sessions …` for the given flags and exit.
  // The non-interactive twin of the browser's `y` hotkey — lets an agent compose
  // (or a human copy) the exact command a view maps to.
  if (options.printCmd) {
    process.stdout.write(canonicalSessionsCommand(query, options) + '\n');
    return;
  }

  // --roots: emit the local session-scan directories, per agent, as JSON. A pure
  // machine-readable query (no listing/render) — external watchers (the Factory
  // extension's fs.watch) read it to track the same dirs the CLI scans, instead
  // of hardcoding `~/.claude|.codex|.gemini`. Always local; ignores other flags.
  if (options.roots) {
    process.stdout.write(JSON.stringify(getSessionRoots(), null, 2) + '\n');
    return;
  }

  // --resolve is the metadata-only contract for downstream context workflows.
  // It reads indexed SessionMeta rows and never calls renderSession, buildPreview,
  // parseSession, or any other transcript renderer/parser.
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

  // --host WITHOUT --active. `--json` fans the recent listing out and emits ONE
  // clean merged SessionMeta[] array (same shape as the local --json path), for
  // scripts/extensions that JSON.parse a remote's history. Without --json it
  // keeps the legacy per-host stream (each remote's raw stdout under a
  // `── host ──` banner). With --active, the hosts are folded into the merged
  // machine-grouped view instead (handled below).
  if (options.host && options.host.length > 0 && !liveOnly && !toolEvidenceMode) {
    // --local means "skip the SSH fan-out"; --host means "look only over there".
    // Together they ask for a peer's sessions without dialing the peer, which can
    // only ever be empty — so say that instead of rendering a blank list.
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
    // A bare interactive `--device`/`--device <box>` listing falls through to the
    // fleet browser below, which folds the named host(s) into the same merged,
    // preview-rich, selectable view as the local listing (via gatherRemoteList).
    // A query, a render/filter flag, or a non-interactive caller keeps the legacy
    // per-host raw stream under a `── host ──` banner.
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

  // --preview <id/query>: resolve one session and print its compact preview, then
  // exit — checked before --active so `--active --preview <id>` peeks the id
  // rather than being swallowed by the active listing.
  if (options.preview) {
    if (!query) {
      console.error(chalk.red('--preview requires a session id or query.'));
      process.exit(1);
    }
    await renderSessionPreview(query, { agent: options.agent, project: options.project, local: options.local, hosts: options.host });
    return;
  }

  if (liveOnly) {
    // The running view is built from the live scan, which carries no team lineage
    // (that comes off the transcript index and the teams meta dir), so --in-team
    // has nothing to match on here. Say so rather than ignoring the flag.
    if (options.inTeam) {
      console.error(chalk.red('--in-team does not apply to --active: the running view carries no team lineage.'));
      console.error(chalk.gray('Drop --active to filter by team, or use `agents teams status <name>` for a live team.'));
      process.exit(1);
    }

    // On a TTY (and not a scripting path), open the interactive browser seeded to
    // running-only. --json / --waiting / --no-interactive / a peer fan-out keep the
    // static dump untouched, so scripts and agents are unaffected. An explicit
    // --since seeds the window; --until / --project (no browser field) or a
    // multi-host scope fall through to the static dump that already honors them.
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
    // AGENTS_SESSIONS_LOCAL is set by a parent fan-out invocation (see
    // remote-active.ts) so a peer answers for itself without recursing.
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

  // Bare interactive listing → the interactive fleet browser (humans). A query,
  // a render/filter flag, --flat/--tree, --json, --until, --project (a named-project
  // filter the browser can't represent), or --no-interactive keep the existing
  // printed/render paths (agents and scripts unaffected). An explicit --since seeds
  // the browser's window so the flag is honored, not swallowed.
  //
  // Bare `--teams` still diverts to the printed team-grouped report because the
  // flat picker cannot preserve that shape. `--in-team <name> --teams` is one
  // flat lineage, so it qualifies through hasNoBrowserDisqualifyingFlags.
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

  // Path-like queries filter by project directory instead of text search.
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

  // Artifact flags require a session query.
  if ((options.artifacts || options.artifact !== undefined) && !query) {
    console.error(chalk.red('--artifacts and --artifact require a session ID or query.'));
    process.exit(1);
  }

  const mode = resolveViewMode(options, filterOpts);
  // --markdown or any filter flag forces single-session render.
  const wantsRender = !toolEvidenceMode && (mode === 'markdown' || hasAnyFilter(filterOpts));

  // Artifact-list or artifact-read paths: widen scope and resolve session globally.
  if ((options.artifacts || options.artifact !== undefined) && searchQuery) {
    await renderArtifactsGlobal(
      searchQuery,
      options.artifacts ?? false,
      options.artifact,
      artifactLookupScope(options.agent, options.project, options.routine),
    );
    return;
  }

  // A supplied ID is already the lookup key. Resolve it directly from SQLite
  // and, when needed, the peer indexes before any broad transcript discovery.
  if (!toolEvidenceMode && searchQuery && looksLikeSessionId(searchQuery)) {
    await renderOneSession(searchQuery, mode, { agent: options.agent, project: options.project, routine: options.routine, filter: filterOpts, redact: options.redact, local: options.local, hosts: options.host });
    return;
  }

  // When the user explicitly asks to render (via mode flag), resolve the
  // query globally so sessions outside the default cwd/30d window are found.
  if (wantsRender && searchQuery) {
    await renderOneSession(searchQuery, mode, { agent: options.agent, project: options.project, routine: options.routine, filter: filterOpts, redact: options.redact, local: options.local, hosts: options.host });
    return;
  }

  // Interactive picker loads a deep pool but shows only recent sessions
  // until the user starts typing. Non-interactive/JSON uses the explicit limit.
  const isInteractive = !options.json && isInteractiveTerminal();
  // The grouped project overview is the default for a bare interactive listing:
  // no query, no path drill-in, not explicitly --flat/--tree. It drops the silent
  // cwd-scope + 50-cap + 30-day window that hide most of a large index.
  const wantsOverview = isInteractive && !searchQuery && !pathFilter && !options.flat && !options.tree;
  // --in-team asks for ONE team's whole lineage, which is a handful of rows that
  // can sit anywhere in history. Bounding it by the default top-50 / 30-day window
  // silently returns nothing for any team older than that — so the flag widens its
  // own scope, the way --all does, unless the caller set an explicit --limit.
  const wantsWholeTeam = !!options.inTeam;
  // A routine is not tied to the shell's cwd: its archived sessions retain the
  // working directory in which the scheduled agent actually ran. Scope the
  // routine catalog across directories so invoking it from ~/.agents/.system,
  // a project repo, or $HOME yields the same routine history.
  const wantsWholeRoutine = !!options.routine;
  // `--limit` has a commander default, so an untouched flag still arrives as a
  // string and truthiness can't tell it from a typed one. Commander records where
  // each value came from, which is the only signal that distinguishes an explicit
  // `--limit 50` from no flag at all — a script asking for 50 must get 50, not the
  // whole-team pool.
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
  // Overview: recency order across the whole index, no default window; an explicit
  // --since still narrows. Non-overview keeps the prior interactive-30d default.
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
    // Team-origin filter is pushed down to SQL so the LIMIT applies AFTER it.
    // Without this, a dev dir with heavy SDK spawn activity (Task subagents,
    // `agents run`, team agents) can fill the top-N window entirely with
    // hidden rows and make real CLI sessions appear to vanish.
    // 'recent' is the user-facing alias for the default timestamp sort.
    const sortBy: DiscoverOptions['sortBy'] =
      options.sort === 'cost' ? 'cost' : options.sort === 'duration' ? 'duration' : 'timestamp';

    const scope: DiscoverOptions = {
      agent,
      version,
      // --in-team spans directories by construction: a team's teammates run in
      // their own worktrees, so scoping to the current cwd hides most of the
      // lineage the flag exists to show.
      all: pathFilter ? undefined : options.all || wantsWholeTeam || wantsWholeRoutine || toolSpansDevices,
      cwd: process.cwd(),
      // Default overview scopes to the current repo SUBTREE (prefix match), so a
      // monorepo shows its sub-projects grouped instead of collapsing to the one
      // exact-cwd project. `--all` clears the prefix and spans the whole index.
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

    // Version filter is pushed down to SQL via scope.version above; no
    // post-filter needed. Defensive: the team-origin SQL filter covers the
    // ~100% case, but classifyTeamSession also recognizes sessions with a
    // meta.json in ~/.agents/teams/agents whose is_team_origin flag was
    // never set (legacy rows). Keep the in-memory pass so those are still
    // enriched/hidden.
    const { visible: visibleSessions } = filterTeamSessions(sessions, shouldShowTeamSessions(options));
    sessions = visibleSessions;

    // --in-team spans both ends of the lineage, so it can't be one SQL predicate:
    // the orchestrator matches on the scan-derived `spawnedTeam` column, while a
    // teammate only knows its team from the meta.json filterTeamSessions just
    // read. Match either, after that pass has populated `teamOrigin`.
    if (options.inTeam) sessions = sessions.filter((s) => matchesTeam(s, options.inTeam!));

    // --bookmarks narrows to the bookmarked set. Applied here, before the JSON
    // emit, so `--bookmarks --json` is the machine-readable twin of the `b` key.
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

    // Under --in-team the visible list is one team, so the whole-index team-origin
    // count would be a non-sequitur next to it.
    const hiddenCount = shouldShowTeamSessions(options) || options.inTeam
      ? 0
      : countSessionsInScope({ ...scope, onlyTeamOrigin: true });

    // A typed routine scope must apply before smart ID routing. Otherwise an ID
    // from another routine resolves and renders before the routine filter below.
    if (typeof options.routine === 'string') {
      const filteredByRoutine = await filterSessionsByRoutine(sessions, options.routine, false);
      if (!filteredByRoutine) return;
      sessions = filteredByRoutine;
    }

    // Smart ID routing: a bare query that resolves to one session renders
    // directly. If nothing matches in the scoped window and the query looks
    // like a session ID, widen to global scope (incl. Claude /resume history).
    //
    // Exception: a PEER answering a parent's `--json` locate sweep
    // (AGENTS_SESSIONS_LOCAL=1) must return the SessionMeta[] ROW for the id, not
    // render its transcript — the sweep parses an array (parseRemoteList). So when
    // we are that peer and --json is set, skip the single-session short-circuit and
    // fall through to the array-emitting --json block below.
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
      // An id-shaped query resolves by id ONLY — the same rule the render path
      // uses (resolveSessionQuery). Without this a `--json <uuid>` (as issued by
      // the fleet locate sweep, which runs `sessions <uuid> --json --local` on
      // each peer) would fall to FTS content search and return every transcript
      // that merely MENTIONS the id, defeating exact remote resolution. A genuine
      // search phrase keeps the ranked metadata+content path.
      let filtered = searchQuery
        ? resolveSessionQuery(sessions, searchQuery, {
            scope: { agent: options.agent, project: options.project, routine: options.routine },
          }).matches
        : sessions;
      // `--device all`/`--fleet` on a historical `--json` query fans out to every
      // peer and merges their rows in — the SAME SSH sweep the interactive listing
      // below uses, and the whole-fleet twin of the explicit `--device <host>
      // --json` path (`runRemoteSessionsJson`). Without this the documented
      // "search the whole fleet" flag returned local rows only (PHNX-2673). Guarded
      // to the sentinel so a bare `--json` stays a deterministic local slice for
      // scripts, and skipped under `--local`/the peer recursion guard. Dead peers
      // are skipped by the fan-out, never fatal — enrichment, not a dependency.
      const forceLocalJson = options.local === true || process.env[NO_FANOUT_ENV] === '1';
      if (fleetWide && !forceLocalJson) {
        const forwarded = ensureWholeIndex(buildForwardedArgs(process.argv, new Set(options.host ?? [])));
        if (!forwarded.includes('--json')) forwarded.push('--json');
        const fanSpinner = isInteractiveTerminal() ? ora('Reaching other machines...').start() : null;
        try {
          const { sessions: remoteSessions } = await gatherRemoteList(forwarded, undefined);
          if (remoteSessions.length > 0) {
            filtered = mergeLocalFirst([...filtered, ...remoteSessions], machineId());
          }
        } catch {
          // fan-out is an enrichment, never a hard dependency
        } finally {
          fanSpinner?.stop();
        }
      }
      // JSON is the canonical picker contract: enrich the durable rows once
      // from the shared live cache so every consumer gets lifecycle/recovery
      // metadata without performing its own join or transcript scan.
      const live = await gatherActiveSessions({
        local: forceLocalJson,
        hosts: options.host,
      });
      process.stdout.write(serializeSessionsJson(serializeSessionPickerRows(filtered, live.sessions)));
      return;
    }

    // Cross-machine fan-out: unless --local (or we ARE a peer answering a
    // parent's sweep), fold in other online machines' sessions live over SSH so
    // the list spans the fleet without any sync — each remote row carries the
    // machine it came from, and the picker/table label + group by it. Only the
    // interactive picker and the printed table get this; --json and single-id
    // resolution above stay local (a peer answers for itself; scripts get a
    // deterministic local slice). Best-effort: a fan-out failure leaves the
    // local list intact rather than erroring the whole command.
    const forceLocal = options.local === true || process.env[NO_FANOUT_ENV] === '1';
    if (!forceLocal) {
      // Pass the hosts set so a variadic `--host a b` never leaks a host as a
      // query (defensive: the --host-without-active early return above already
      // means we only get here in auto-discovery mode, with no --host in argv).
      const forwarded = buildForwardedArgs(process.argv, new Set(options.host ?? []));
      if (!forwarded.includes('--json')) forwarded.push('--json');
      const fanSpinner = isInteractiveTerminal() ? ora('Reaching other machines...').start() : null;
      try {
        const { sessions: remoteSessions } = await gatherRemoteList(forwarded, options.host);
        if (remoteSessions.length > 0) {
          sessions = mergeLocalFirst([...sessions, ...remoteSessions], machineId());
        }
      } catch {
        // fan-out is an enrichment, never a hard dependency
      } finally {
        fanSpinner?.stop();
      }
    }

    if (options.routine) {
      const target = await selectRoutineTarget(sessions, options.routine, isInteractive);
      if (!target) return; // bad --routine <name> or cancelled pick (message printed)
      if (target.name) {
        sessions = sessions.filter((s) => s.routineName === target.name);
        // A routine browse renders the run-first drilldown — canonical run history
        // plus each run's linked session — instead of dead-ending a
        // command/pre-session routine into the generic empty copy. An explicit
        // --flat/--tree or a search query keeps the scoped session listing/picker,
        // so `--routine x --flat` prints the plain table and `--routine x <id>`
        // resolves a specific session within the routine.
        if (!searchQuery && !options.flat && !options.tree) {
          const liveIndex = await maybeLiveIndex(options);
          printRoutineDrilldown(buildRoutineDrilldown(target.name, sessions), liveIndex, { hiddenCount, hiddenUnmanaged });
          return;
        }
      }
      // target.name === null: bare `--routine` piped to a non-interactive sink —
      // no routine chosen, fall through to the normal listing unfiltered.
    }

    if (sessions.length === 0) {
      if (pathFilter) {
        console.log(chalk.gray(`No sessions found for ${pathFilter}.`));
      } else if (options.routine) {
        // A routine scoped to a flat/tree/query listing with no matching session
        // (e.g. a command routine has none) — say so in routine terms, not the
        // generic cwd/--all copy, and point at the run-history drilldown.
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

    // `--teams` prints the team-grouped report: teammates under their team (with
    // spawner + spawn time), bare SDK spawns in their own bucket. --flat/--tree
    // keep their inline table rendering; a search query keeps the picker. Placed
    // before the project overview and picker so it wins the bare `--teams` case.
    if (options.teams && !options.flat && !options.tree && !searchQuery && !pathFilter) {
      const liveIndex = await maybeLiveIndex(options);
      printTeamsView(sessions, liveIndex, hiddenUnmanaged);
      return;
    }

    // The grouped project overview is the bare interactive default: a scannable
    // dashboard of the whole fleet grouped by project, newest-active first.
    // Interact/resume via `agents sessions <project>` or `agents sessions resume`.
    if (wantsOverview) {
      const liveIndex = await maybeLiveIndex(options);
      // Per-project row cap is fixed (--limit carries a default of 50 and drives
      // the fetch pool, not the display); `--all` expands every group instead.
      printSessionOverview(sessions, hiddenCount, liveIndex, { perProjectCap: OVERVIEW_ROWS_PER_PROJECT, expand: !!options.all, hiddenUnmanaged });
      return;
    }

    // --tree / --flat are printed listings, not an interactive pick — render them
    // directly even in a TTY. A search query keeps the interactive picker.
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

    // Non-interactive fallback (piped output) or --flat/--tree.
    const filtered = searchQuery
      ? filterSessionsByQuery(sessions, searchQuery, {
          agent: options.agent,
          project: options.project,
          routine: options.routine,
        })
      : sessions;
    const liveIndex = await maybeLiveIndex(options);
    printSessionTable(filtered, hiddenCount, options.tree === true, liveIndex);
    // Every listing path must say what it dropped — a hidden default that stays
    // silent in one render mode is the failure this footer exists to prevent.
    if (hiddenUnmanaged > 0) console.log(chalk.gray(formatUnmanagedHiddenFooter(hiddenUnmanaged)));
  } catch (err: any) {
    tracker.stop();
    spinner?.stop();
    console.error(chalk.red(`Failed to discover sessions: ${err.message}`));
    process.exit(1);
  }
}

/**
 * Prefix marking a row as somebody's teammate: `[<team>/<handle>] `, falling back
 * to the handle alone when the record predates team-name capture. The mode is
 * deliberately dropped here (it survives in the preview pane) — this tag is
 * folded into the topic cell, whose floor is 16 columns, so every character it
 * takes is one the actual prompt loses.
 */
function teamTag(session: SessionMeta): string {
  const origin = session.teamOrigin;
  if (!origin) return '';
  const handle = safeTeamText(origin.handle);
  const team = safeTeamText(origin.team);
  if (team) return `[${team}${handle ? `/${handle}` : ''}] `;
  return handle ? `[${handle}] ` : '[team] ';
}

/**
 * Whether a session belongs to `team`, from either end: it spawned the team, or
 * it is one of the team's teammates. Case-insensitive, matching the SQL
 * predicate behind `querySessions({ spawnedTeam })`.
 */
export function matchesTeam(session: SessionMeta, team: string): boolean {
  // The needle is peer-derived in the browser: `f.team` comes off the team cycle,
  // which is built from rows another machine sent. Guard it the same way as the
  // fields it is compared against, so a non-string can't throw out of a filter
  // that runs over every row.
  const want = safeTeamText(team)?.trim().toLowerCase();
  if (!want) return true;
  return (
    safeTeamText(session.spawnedTeam)?.toLowerCase() === want ||
    safeTeamText(session.teamOrigin?.team)?.toLowerCase() === want
  );
}

/** Longest team name rendered in the `team:` row badge before truncation. */
const TEAM_BADGE_MAX = 10;

/**
 * The `team:<name>` badge for a session that SPAWNED a team — the orchestrator
 * end of the lineage, from the scan-derived `spawnedTeam`. Returned as a plain
 * (uncolored) string plus its display width so callers can reserve the width
 * from the topic budget and color it as their own segment: folding it into the
 * topic string would lose the color, since renderTopicCell strips ANSI and
 * re-whitens every slice.
 */
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

/** Adapt a SessionMeta's persisted signals to the badge renderer's shape. */
function metaSignals(s: SessionMeta): Parameters<typeof signalBadges>[0] {
  return {
    pr: s.prUrl ? { url: s.prUrl, number: s.prNumber } : undefined,
    worktree: s.worktreeSlug ? { path: s.cwd ?? '', slug: s.worktreeSlug } : undefined,
    ticket: s.ticketId ? { id: s.ticketId } : undefined,
  };
}

/**
 * Narrowest topic a row is willing to render. The time cell drops its creation
 * field rather than squeeze the topic past this — a row that wraps is worse than
 * a row missing one field.
 */
const MIN_TOPIC_W = 16;

/**
 * The trailing time cell, as two fields: `3d → 2 hours ago` — when the session
 * was created, then when it was last active. One label answers neither "is this
 * the old session I'm looking for" nor "how long did it run", since a session
 * touched an hour ago may have started last week.
 *
 * Collapses to last-activity alone when the session ran under a minute (both
 * halves would name the same moment) or when `topicSlack` — the columns the row
 * has left for its topic — cannot spare the extra width. `extraW` is what the
 * creation field cost, for the caller to take off the topic budget.
 */
function timeCell(age: SessionAgeParts, topicSlack: number): { plain: string; text: string; extraW: number } {
  const lastOnly = { plain: age.last, text: chalk.gray(age.last), extraW: 0 };
  if (!age.created) return lastOnly;
  const prefix = `${age.created} → `;
  const extraW = stringWidth(prefix);
  if (topicSlack - extraW < MIN_TOPIC_W) return lastOnly;
  return { plain: prefix + age.last, text: chalk.dim(prefix) + chalk.gray(age.last), extraW };
}

/** One flat table row:
 *   shortId · agent · version · model · project · [glyph] label·doing · [ticket] · [wt] · time
 * `doing` is the live preview when running, else the topic. The `ticket` column
 * (tracker/PR ref, pulled out of the badge blob so refs align) is only rendered
 * when `showTicket` — otherwise a listing with no refs would waste a column of
 * dashes and needlessly truncate the topic. Worktree stays a trailing badge. */
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
  // A running session's live preview (via liveGlyphAndPreview → buildSessionDescription)
  // already folds in ActiveSession.todos. For resting / not-live rows, surface
  // SessionMeta.todos when the scan attached it.
  const restingTodo = !live ? formatTodoCompact(session.todos) : '';
  const topicBase = tag ? `${tag}${session.topic ?? ''}` : session.topic;
  const doing = [restingTodo, preview || topicBase].filter(Boolean).join(' · ') || undefined;
  const wt = session.worktreeSlug ? chalk.magenta(`wt:${session.worktreeSlug}`) : '';
  const team = teamBadge(session);
  const teamSeg = team.plain ? chalk.green(team.plain) : '';

  // The machine column only earns its width when the listing spans more than one
  // box (i.e. the cross-machine fan-out folded remotes in) — same rule and
  // pool-derived width as the picker.
  const machineColW = cols.machineWidth ?? PICKER_MACHINE_W;
  const machineCell = cols.showMachine
    ? chalk.gray(padToWidth(truncateToWidth((cols.machineLabel?.(session.machine ?? '') ?? session.machine ?? '') || '-', machineColW - 1), machineColW))
    : '';

  const TICKET_W = 10;
  const ticketCell = showTicket
    ? chalk.blue(linkTicketCell(session, padToWidth(truncateToWidth(ticketLabel(session) || '-', TICKET_W), TICKET_W + 1)))
    : '';
  // Live status word (working / waiting / idle) next to the glyph — the default
  // list is no longer a bare glyph. Empty (zero width) for resting rows.
  const { cell: statusCell, width: statusW } = liveStatusCell(live);
  const glyphW = glyph ? 2 : 0;
  const machineW = cols.showMachine ? machineColW : 0;
  const ticketW = showTicket ? TICKET_W + 1 : 0;
  const wtW = wt ? stringWidth(wt) + 1 : 0;
  const width = terminalWidth();
  const requestedModelW = cols.showModel ? (cols.modelWidth ?? PICKER_MODEL_MAX) : 0;
  // Same conditional 2 cells as the picker's marker, for the same reason.
  const bookmarkW = cols.showBookmark ? 2 : 0;
  const bookmarkCell = cols.showBookmark ? (bookmarked ? chalk.yellow('★ ') : '  ') : '';
  // Sized against the last-activity label alone, so the creation field is an
  // additive decision the row makes only once it knows what space is left.
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

/** One tree-mode row (grouped under a dir header): id · agent · badges · topic · time. No version/project column. */
function treeSessionRow(session: SessionMeta, live?: ActiveSession): string {
  const shown = sessionDisplayAgent(session);
  const agentColor = colorAgent(shown);
  const age = sessionAgeParts(session.timestamp, session.lastActivity);
  const tag = originTag(session) || teamTag(session);
  const label = (session as any).label;
  const { glyph, preview } = liveGlyphAndPreview(live);
  // Match flatSessionRow: live preview already folds ActiveSession.todos; resting
  // rows surface SessionMeta.todos when present (RUSH-2045).
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

/**
 * Live-session index for enriching the default listing, or undefined when
 * enrichment is off (`--no-live`) or irrelevant (`--json`, which serializes
 * SessionMeta). Full detection (incl. the headless `ps` scan) is deliberate:
 * bare-CLI and tmux agents are the common case here, and skipping them would
 * leave the glyph almost never showing. The listing is a one-shot user action,
 * not a hot loop, so the `ps`/`lsof` cost is acceptable; `--no-live` is the
 * escape hatch. Never throws — a probe failure just yields a plain listing.
 */
export async function maybeLiveIndex(options: SessionsOptions): Promise<Map<string, ActiveSession> | undefined> {
  if (options.live === false || options.json) return undefined;
  try {
    // `--local` promises "this machine only" for the default listing too (see
    // the `--local` help text), so it must gate the live-enrichment probe the
    // same way `--active --local` does — never dial a remote-host teammate
    // over ssh here either (RUSH-2118).
    return indexActiveBySessionId(await getActiveSessions({ localOnly: options.local === true }));
  } catch {
    return undefined;
  }
}

/**
 * Group key for the overview: resolve the cwd through the same canonical
 * resolver the `agents feed` timeline groups by — a defined project's name
 * when `defs` contains the cwd (multi-repo projects read as one group), else
 * the repo-level key, so a monorepo subdir (`<repo>/apps/cli`) reads as
 * `<repo>` in both views. Falls back to the indexed project name (stamped at
 * scan time) when the cwd carries nothing usable, e.g. a remote path this
 * machine cannot see still folds by basename through the same resolver.
 */
export function overviewProjectKey(s: Pick<SessionMeta, 'project' | 'cwd'>, defs?: ProjectDef[]): string {
  const resolved = defs?.length ? resolveProjectNameForCwd(s.cwd, defs) : resolveProjectKey(s.cwd);
  if (resolved) return resolved;
  if (s.project && s.project.trim()) return s.project.trim();
  return '(no project)';
}

export interface OverviewGroup {
  key: string;
  total: number; // total sessions for this project in the fetched pool
  shown: SessionMeta[]; // the recent slice that fell within the display budget
  more: number; // total - shown.length
  maxTs: string; // most-recent timestamp in the group
}

/**
 * Turn a recency-descending pool into project groups: each group shows its
 * `perProjectCap` most-recent sessions (the rest become `· N more`), and groups
 * are ordered by their most-recent session so the newest-active project leads.
 * `perProjectCap = Infinity` expands every group. Pure — unit-tested.
 */
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
    const shown = rows.slice(0, cap); // rows are recency-desc (pool was sorted)
    groups.push({ key, total: rows.length, shown, more: rows.length - shown.length, maxTs: rows[0].lastActivity ?? rows[0].timestamp });
  }
  groups.sort((a, b) => (a.maxTs < b.maxTs ? 1 : a.maxTs > b.maxTs ? -1 : a.key.localeCompare(b.key)));
  return { groups, projectCount: byKey.size };
}

/**
 * The grouped project overview — the bare interactive default. Shows the latest
 * sessions grouped under their project, newest-active project first, with a
 * `· N more` per project and a `+N more projects` when the list is capped.
 */
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
    // Group by directory; drop the id/version columns from view. The short id
    // stays as each row's leading handle (the address to read/resume it).
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

  // Only show the ticket column when at least one row carries a ref — otherwise
  // it's a column of dashes that steals width from every topic. The machine
  // column (and its compact labels) is computed the same way the picker does it.
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

/** Width of the mode cell (plan/edit/auto/skip) in a team-member row. */
const TEAM_MODE_W = 5;
/** Longest teammate handle folded into a team-member row before it truncates. */
const TEAM_HANDLE_W = 16;

/**
 * One row under a team group: `shortId · agent · mode · handle · doing · time`.
 * Unlike {@link flatSessionRow}/{@link treeSessionRow} it drops the
 * `[team/handle]` topic prefix — the group header already names the team — and
 * promotes the teammate's mode and handle to their own cells, the richer
 * identity the `--teams` view exists to show (RUSH-1997).
 */
function teamMemberRow(session: SessionMeta, live?: ActiveSession): string {
  const shown = sessionDisplayAgent(session);
  const agentColor = colorAgent(shown);
  const origin = session.teamOrigin;
  const age = sessionAgeParts(session.timestamp, session.lastActivity);
  const handle = safeTeamText(origin?.handle) ?? session.shortId;
  const mode = safeTeamText(origin?.mode) ?? '';
  const { glyph, preview } = liveGlyphAndPreview(live);
  // Match flatSessionRow: a live preview already folds ActiveSession.todos; a
  // resting row surfaces SessionMeta.todos when the scan attached it.
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

/** The header line for one team group (or the residual no-team bucket). */
function teamGroupHeader(g: TeamSessionGroup, glyph: string, labelById: Map<string, string>): string {
  const count = chalk.gray(`(${g.sessions.length})`);
  if (g.kind === 'noTeam') {
    // These carry the isTeamOrigin flag but no teammate meta.json — a Task
    // sub-agent's transcript is never indexed, so in practice this bucket is
    // headless `agents run` spawns or teammates whose meta aged out. Named
    // honestly rather than claimed as real teammates.
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

/**
 * The `agents sessions --teams` view: team-origin sessions grouped by team, the
 * richer display RUSH-1997 asks for. Each named team names its spawner (the
 * orchestrator session that created it) and spawn time, with its teammates'
 * mode + handle under it; team-flagged spawns that carry no teammate record fall
 * into a trailing no-team bucket, so a real teammate and a bare spawn are never
 * conflated. A printed report like `--tree`, not an interactive pick.
 */
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

  // Resolve a spawner session id to its human label from the pool. The
  // orchestrator may or may not be in view; fall back to the short id, the same
  // degradation the --active teams rows use (active.ts resolveOrchestratorLabels).
  const labelById = new Map<string, string>();
  for (const s of pool) {
    const label = (s as any).label || s.topic;
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

/**
 * Default is summary. Any explicit format flag wins. When filters are present
 * without a format, default to markdown since summary is an aggregate view
 * that filters don't meaningfully narrow.
 */
function resolveViewMode(options: SessionsOptions, filters: FilterOptions): ViewMode {
  if (options.markdown) return 'markdown';
  if (options.json) return 'json';
  if (hasAnyFilter(filters)) return 'markdown';
  return 'summary';
}

/**
 * Render a resolved session to stdout — the non-follow view behind
 * `agents logs <sessionId>`. Defaults to the concise `summary` digest (same as
 * `agents sessions <id>`); pass `'markdown'` for the full transcript
 * (`agents logs <id> --full`). Reuses the shared `renderSession` renderer.
 */
export async function renderSessionLog(session: SessionMeta, mode: ViewMode = 'summary'): Promise<void> {
  await renderSession(session, mode, {});
}

/**
 * Emit one session exactly as `agents sessions <id> --json` does — the same
 * redact-by-default `{ session, events }` shape — so `agents logs <id> --json`
 * shares one machine-readable session contract instead of inventing another.
 */
export async function renderSessionLogJson(session: SessionMeta): Promise<void> {
  await renderSession(session, 'json', {});
}

/**
 * Render a file-gone (archived) session from the local DB (RUSH-2436). The
 * transcript file is deleted, but the user turns survive in session_text and the
 * last-computed digest in session_preview_cache — serve those so `agents sessions
 * <id>` still shows the prompts instead of an empty metadata dump. User-turn text
 * is the durable content every harness stores; assistant text survives only as
 * the cached digest's `lastAssistant` snippet, shown when present.
 */
function renderArchivedSession(
  session: SessionMeta,
  mode: ViewMode,
  options: { redact?: boolean } = {},
): void {
  // Redact by default, mirroring the live render path (render.ts renderConversationMarkdown):
  // session_text stores raw user text, so masking is render-time. `--no-redact`
  // opts out, same as the live path.
  const redact = (text: string): string => options.redact !== false ? redactSecrets(text) : text;
  const content = redact((readSessionContent(session.id) ?? '').trim());
  const digestRaw = readArchivedSessionPreview<SessionPreviewDigest>(session.id);
  const digest = digestRaw
    ? { ...digestRaw, lastAssistant: redact(digestRaw.lastAssistant ?? '') }
    : undefined;
  if (mode === 'json') {
    // Minimal machine shape for a file-gone session: the durable user content
    // plus the cached preview digest, tagged archived. Deliberately NOT the full
    // { session, events } contract — there are no events to parse. Redact the
    // first-message-excerpt meta fields (topic/label/plan) too, matching the live
    // single-session --json (render.ts redactJson), so `--json` masks them unless
    // --no-redact is passed.
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
  const title = (session as any).label || session.topic;
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
  // OpenCode stores sessions in SQLite; filePath is "db_path#session_id"
  const realPath = session.filePath.split('#')[0];
  if (!fs.existsSync(realPath)) {
    // The transcript file is gone, but the session's user turns are stored
    // durably in the local DB (session_text), so serve those instead of a bare
    // metadata dump (RUSH-2436). This is what makes an archived session still
    // render its prompts after `agents remove` / rm / a box reimage.
    const archivedContent = readSessionContent(session.id);
    if (archivedContent && archivedContent.trim() !== '') {
      renderArchivedSession(session, mode, options);
      return;
    }
    console.log(chalk.yellow('Session transcript not available (file no longer exists).'));
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

    // Auto-inferred title headline (user /rename > Claude ai-title > first-prompt
    // topic) — the fastest way to recognize which task this session is.
    const title = (session as any).label || session.topic;
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

  // json — normalized events plus the durable session signals from the state
  // engine (plan text, PR, worktree, ticket). Pre-1.20.51 emitted a bare event
  // array; consumers that JSON.parse this now read `output.events` for the
  // array. See issue #743 (plan surfaced) and CHANGELOG for the shape change.
  // `todos` (RUSH-1503) is computed from the UNFILTERED transcript so the
  // checklist reflects true session state regardless of any `--include` filter;
  // it lets the Factory panel read the CLI's checklist instead of re-parsing.
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
  // Width-aware: measure/truncate/pad by display cells, not String.length, so
  // ANSI escapes and wide (CJK/emoji) glyphs don't drift the column.
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

/** Column-visibility flags for the picker row, computed once over the whole pool. */
/** The SSH-launch origin for a picker row, resolved from the live session's
 * provenance (transport 'ssh'). `device` is set when the client IP matched a
 * registered device; absent for an unresolved IP (renders a bare `ssh`). */
export interface SshOriginTag {
  device?: string;
}

export interface PickerColumns {
  /** Render the machine column (only when the pool spans more than one machine). */
  showMachine?: boolean;
  /** Map a full machine id to its compact display form (shared prefix stripped). */
  machineLabel?: (m: string) => string;
  /** Total width of the machine column, sized to the widest compacted hostname
   * in the pool (capped). Falls back to PICKER_MACHINE_W when absent. */
  machineWidth?: number;
  /** Render the model column only when at least one row carries a model. */
  showModel?: boolean;
  /** Pool-sized model column width, including one trailing separator cell. */
  modelWidth?: number;
  /** Render the ticket/PR column (only when at least one row carries a ref). */
  showTicket?: boolean;
  /**
   * Render the host-program column — which terminal/editor the session is running
   * in (`ghostty`, `codium`, `tmux→ghostty`, …). Live-only: it comes from the
   * active-session scan, so it is set by the running-filtered browser and stays
   * off for a plain transcript listing, where no row has a host.
   */
  showHost?: boolean;
  /**
   * Render the bookmark marker column. Like every other conditional column here,
   * it earns its 2 cells only when some row in the pool is actually starred — a
   * user who has never bookmarked anything pays nothing for the feature.
   */
  showBookmark?: boolean;
  /**
   * Render the live status column (`working` / `waiting` / `orphan` / `crashed`).
   * Live-only, gated the same way as {@link showHost}: it comes from the
   * active-session scan, so the running-filtered browser sets it and a plain
   * transcript listing — where no row has a status — leaves it off.
   */
  showStatus?: boolean;
  /**
   * Cells the picker prepends before each row: 2 for the single-select cursor
   * ('> '), 6 for the multi-select cursor + checkbox ('> [x] '). Reserved from
   * the topic width so rows never wrap. Defaults to 2.
   */
  gutter?: number;
}

/** Fallback machine-column width when a pool-derived width isn't supplied.
 * `pickerColumnsFor` normally computes `machineWidth` sized to the actual
 * hostnames, floored/capped by these bounds so common ids like `yosemite-s0`
 * (11) fit whole while a pathological hostname can't devour the topic column. */
const PICKER_MACHINE_W = 11;
const PICKER_MACHINE_MIN = 8;
const PICKER_MACHINE_MAX = 18;
const PICKER_MODEL_MIN = 6;
const PICKER_MODEL_MAX = 13;

/** Column width that shows every compacted hostname in `machines` whole (one
 * trailing space for separation), bounded by MIN/MAX. */
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

/**
 * Compact display form for machine ids: strip the longest shared dash-delimited
 * prefix so "yosemite-s0"/"yosemite-s1" read as "s0"/"s1" while unrelated ids
 * ("zion", "mac-mini") stay whole. Stripping a *common* prefix can't collide,
 * and at least one segment is always kept.
 */
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

/**
 * Column flags for a picker, computed once over the whole pool so every row
 * aligns: the machine column only earns its width when the listing spans more
 * than one box, the ticket column only when some row carries a PR/ticket ref.
 */
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
      // One read of the store per pool, not one per row.
      const bookmarks = listBookmarks();
      return bookmarks.size > 0 && sessions.some((s) => bookmarks.has(s.id));
    })(),
  };
}

/** Width of the host-program column (`tmux→ghostty` is the long realistic case). */
const PICKER_HOST_W = 14;

/**
 * Which program a live session is running in, for the picker's host column: the
 * immediate host app (`codium`, `ghostty`, `tmux`, `iterm`, …) and — when a tmux
 * session is currently being watched through a different app — the app it is
 * viewed in, as `tmux→ghostty`. A tmux session with no attached client stays a
 * bare `tmux`, which is exactly "running detached". Empty when the session has no
 * resolvable host (cloud rows, an unreadable process env).
 */
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
  // SSH-launch origin (live rows only): mirrors the flat listing's `ssh←<device>`
  // badge. Rendered as its OWN red segment before the topic cell — folding it into
  // the topic string loses the colour, because renderTopicCell strips ANSI and
  // re-whitens every slice. Its width is reserved from the topic budget below
  // (exactly like `wt`), so the fixed-width columns stay aligned.
  const sshPlain = ssh ? (ssh.device ? `ssh←${ssh.device} ` : 'ssh ') : '';
  const sshSeg = sshPlain ? chalk.red(sshPlain) : '';
  const sshW = sshPlain ? stringWidth(sshPlain) : 0;
  // Orchestrator badge — same own-segment treatment as `ssh` above, for the same
  // reason: renderTopicCell would strip its colour if it rode inside the topic.
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

  // Which terminal/editor the session runs in — a tab in Ghostty vs a VS Code
  // panel vs a detached tmux pane is the thing you need to know to go find it.
  const hostCell = cols.showHost
    ? chalk.gray(padRight(truncate(host || '-', PICKER_HOST_W - 1), PICKER_HOST_W))
    : '';

  // The picker prepends a gutter (cursor, plus a checkbox in multi-select mode);
  // reserve it, plus the conditional columns, so the topic shrinks to fit and
  // rows never wrap.
  const gutter = cols.gutter ?? 2;
  const machineColW = cols.showMachine ? machineW : 0;
  const ticketW = cols.showTicket ? TICKET_W + 1 : 0;
  const hostW = cols.showHost ? PICKER_HOST_W : 0;
  const wtW = wt ? stringWidth(wt) + 1 : 0;
  // Within a pool that HAS bookmarked rows the marker holds its 2 cells whether
  // this row is bookmarked or not, so the columns after it never jog; a pool
  // with none drops the column entirely (`showBookmark`) and costs nothing.
  const bookmarkW = cols.showBookmark ? 2 : 0;
  const bookmarkCell = cols.showBookmark ? (bookmarked ? chalk.yellow('★ ') : '  ') : '';
  // The same status word the flat listing shows, so a session that is `orphan`
  // or `crashed` reads that way in the browser too — not only in its preview.
  // Constant width whenever the column is on. `liveStatusCell` already pads its
  // word to LIVE_STATUS_W but returns an EMPTY cell (width 0) for a row with no
  // live match — blanks fill in for those, so the topic column does not jog on
  // exactly the rows that are not running.
  const status = cols.showStatus ? liveStatusCell(live) : { cell: '', width: 0 };
  const statusW = cols.showStatus ? LIVE_STATUS_W : 0;
  const statusCell = cols.showStatus ? (status.cell || ' '.repeat(LIVE_STATUS_W)) : '';
  // Sized against the last-activity label alone; the creation field is then an
  // additive decision made against whatever width is left (see the flat listing).
  const baseTopicW =
    terminalWidth() - gutter - bookmarkW - statusW - (10 + 9 + 8 + 16) - machineColW - hostW - ticketW - wtW - sshW - team.width - stringWidth(age.last) - 1;
  const when = timeCell(age, baseTopicW);
  const topicW = Math.max(MIN_TOPIC_W, baseTopicW - when.extraW);

  return (
    bookmarkCell +
    // Truncated, not just padded: an indexed shortId is always 8 chars, but a
    // live row with no session id is named by its pid or cloud task, which can
    // run past the column and shunt every later column out of alignment.
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

/** Hints rotated above the picker so the flags/features stay discoverable. */
const PICKER_TIPS: string[] = [
  'Tip: narrow with -a/--agent (e.g. -a codex), or --project <name> for another folder.',
  "Tip: --all searches every directory; -D/--device <machine> folds in another box's sessions.",
  'Tip: just type to fuzzy-search prompts and responses; press space to preview a session.',
  'Tip: --since 2d / --until <date> bound the time window; pass a session id to open it directly.',
];

/**
 * Pick a hint to show above the picker. Deterministic (keys off the pool size)
 * so it stays fixed across the picker's re-renders within a single run.
 */
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
  // The hidden-session footer is console.log'd above the Inquirer prompt, so it
  // scrolls the viewport the picker can't measure; tell the picker to reserve for
  // it (see pickerPageSize) so the preview and the footer stay on screen together.
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
        // No query: show the full pool (picker viewport still paginates via pageSize).
        // Typing: search the full pool.
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

/** True when the peer wasn't a dialable device; prints one clear line so a
 * remote pick never dead-ends silently. */
function warnNoPeerTarget(machine: string, session: SessionMeta): void {
  console.log(chalk.yellow(`Session ${session.shortId} lives on ${machine}, which isn't a reachable device right now.`));
  console.log(chalk.gray(`Register/wake it (ag devices), or run there: agents ssh ${machine}`));
}

/**
 * Row-id prefix for a live session whose agent has not reported a session id yet
 * (a booting harness, a queued teammate). The browser lists these so nothing live
 * is hidden, but they address no transcript — {@link isIdlessLiveRow} is what the
 * pick handler checks before trying to read or resume one.
 */
export const LIVE_ROW_PREFIX = 'live:';

export function isIdlessLiveRow(s: SessionMeta): boolean {
  return s.id.startsWith(LIVE_ROW_PREFIX);
}

export async function handlePickedSession(picked: PickedSession): Promise<void> {
  // A live row with no session id has no transcript to open and no id to resume
  // by; say where the process is instead of dead-ending on an unreadable path.
  if (isIdlessLiveRow(picked.session)) {
    const where = picked.session.machine ? ` on ${picked.session.machine}` : '';
    console.log(chalk.yellow(`This session hasn't reported a session id yet — nothing to open${where}.`));
    console.log(chalk.gray(`Watch for it with: agents sessions --active${picked.session.machine ? ` --device ${picked.session.machine}` : ''}`));
    return;
  }
  // Reading and resuming are on DIFFERENT machines' terms, and conflating them
  // is what RUSH-2022 was. Reading follows the FILE: a synced mirror sits on
  // this disk, so a peer-owned row with no readable local transcript has to be
  // read on the peer. Resuming follows the HARNESS STATE, which is on the
  // owning machine whatever the transcript's location — a mirror included.
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

/**
 * Resume `session` on the machine that owns it, when that is not this one.
 * Returns true when it handled the resume (hopped, or reported an unreachable
 * owner), false when the session is local and the caller should take over here.
 *
 * The one hop for a foreground, one-session-at-a-time resume — shared by the
 * `agents sessions` picker and by `sessions resume`'s no-tab-backend path, which
 * would otherwise reach `resumeSessionInPlace` and be refused (RUSH-2022).
 */
export async function resumeOnOwnerIfRemote(session: SessionMeta): Promise<boolean> {
  const owner = sessionOwnerDevice(session);
  if (!owner) return false;
  console.log(chalk.gray(`Resuming ${session.shortId} on ${owner} over SSH...`));
  // `agents sessions resume <id>` is the strict single-session path — one pick, one
  // resume.
  const rc = await runOnPeer(['sessions', 'resume', session.id], owner, {
    tty: true,
    env: { [RESUME_PINNED_ENV]: '1' },
    sessionId: session.id,
  });
  if (rc === 'no-target') warnNoPeerTarget(owner, session);
  return true;
}

/**
 * Resume a session in the current terminal — a foreground takeover of this
 * process. Used by the single-select picker and by `sessions resume` when the
 * chosen destination is "in place" (unknown emulator / off-macOS, single pick).
 * Falls back to the same resume invocation against the current version when the
 * version-pinned launcher is genuinely missing.
 */
export async function resumeSessionInPlace(session: SessionMeta): Promise<void> {
  // This function is the LOCAL takeover, and every caller is responsible for
  // routing a peer-owned session before it gets here (the picker above,
  // `agents sessions resume`, `sessions attach`). Reaching it with one anyway means a
  // caller skipped that step, so refuse rather than start the harness against
  // state this box does not have — the `fs.existsSync(session.cwd)` fallback
  // just below is exactly how that used to pass unnoticed, quietly swapping in
  // `process.cwd()` when the recorded directory was a peer's path (RUSH-2022).
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

/**
 * Relaunch this CLI's one recovery path. The owning device resolves account
 * health and either performs exact-home native resume or same-harness
 * `/continue`; callers never guess which version home can see the transcript.
 * `portable` is for an SSH/terminal-engine command that executes on a peer.
 */
export function buildSessionRecoveryCommand(session: Pick<SessionMeta, 'id'>, portable = false): string[] {
  const args = sessionRecoveryRunArgs(session);
  if (portable) return ['agents', ...args];
  const invocation = getAgentsInvocation(args);
  return [invocation.command, ...invocation.args];
}

/**
 * Map a resume argv to the spawn(command, args, {shell}) triple.
 *
 * On Windows the agent launcher is a `.cmd`/PATHEXT shim and needs shell:true.
 * With shell:true, Node concatenates args into the cmd.exe line unescaped
 * (DEP0190 + injection). A session.id derived from a filename can carry
 * metacharacters (`&|<>`); compose a fully-quoted line and pass an EMPTY args
 * array so cmd.exe cannot reparse them (RUSH-1753). See composeWin32CommandLine.
 *
 * `platform` is injectable so the win32 shell path is unit-testable on any host.
 */
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

/**
 * Spawn a resume command as a foreground takeover (inherited stdio), resolving
 * when it exits. On Windows the agent launcher is a `.cmd`/PATHEXT shim that
 * `spawn` can't exec directly — a bare-name `shell:false` spawn throws
 * `EFTYPE`/`ENOENT` there — so we go through the shell via `needsWindowsShell`.
 * When shell:true, argv is composed via resumeSpawnInvocation (quoted line +
 * empty args) so an untrusted session.id cannot inject through cmd.exe.
 * The spawn is guarded because such a failure can be thrown synchronously;
 * without the guard it would surface under an unrelated "Failed to discover
 * sessions" catch upstream instead of a truthful launch error.
 */
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

/**
 * Build the shell command that resumes a picked session.
 *
 * When the session's originating version is known, uses the version-pinned
 * binary (e.g. `claude@2.1.138`) so the resume always runs in the same
 * isolated HOME where the JSONL was written — regardless of which version is
 * currently the default. Falls back to the bare shim when version is unknown.
 *
 */
/**
 * The agent's own resume invocation, given whichever launcher we resolved.
 * Keeping the verb in one place is what lets the version-pinned and fallback
 * paths stay in agreement — they previously drifted into `/continue`, which is
 * not a command either CLI has.
 */
function resumeArgv(agent: SessionMeta['agent'], id: string, launcher: string): string[] | null {
  switch (agent) {
    case 'claude': return [launcher, '--resume', id];
    case 'codex': return [launcher, 'resume', id];
    case 'opencode': return [launcher, '--session', id];
    // Muse interactive resume is a subcommand: `muse resume <uuid>`.
    case 'muse': return [launcher, 'resume', id];
    default: return null;
  }
}

/**
 * Absolute path of the on-disk versioned alias, or null when it isn't there.
 *
 * Resume must not resolve `<cli>@<version>` by bare name. The shims directory is
 * deliberately absent from PATH for an isolated install — that is precisely what
 * `--isolated` promises — so a PATH lookup can never find the alias, and resume
 * degraded to the fallback 100% of the time for isolated copies. Mirrors the
 * resolution `buildExecCommand` already does for `agents run`.
 */
function versionedAliasIfPresent(agent: SessionMeta['agent'], version: string): string | null {
  const cli = AGENTS[agent as AgentId]?.cliCommand ?? agent;
  const base = path.join(getShimsDir(), `${cli}@${version}`);
  if (process.platform === 'win32' && fs.existsSync(`${base}.cmd`)) return `${base}.cmd`;
  if (fs.existsSync(base)) return base;
  return null;
}

export function buildResumeCommand(session: SessionMeta): string[] | null {
  // Captured-only harnesses (gemini/antigravity/openclaw/rush/hermes/grok/kimi/
  // droid/cursor) have no native resume path — one authority, RESUMABLE_HARNESSES,
  // decides this for the picker, this builder, and the watch Previous set alike.
  if (!isResumableHarness(session.agent)) return null;
  switch (session.agent) {
    // opencode sessions are shared across versions, so resume is deliberately NOT
    // version-pinned — it always goes through the plain launcher.
    case 'opencode':
      return resumeArgv('opencode', session.id, 'opencode');

    case 'claude':
    case 'codex':
    case 'muse': {
      const cli = AGENTS[session.agent as AgentId]?.cliCommand ?? session.agent;
      if (session.version) {
        const alias = versionedAliasIfPresent(session.agent, session.version);
        // Absolute path when the alias exists; otherwise the bare versioned name,
        // which still resolves for a non-isolated install whose shims are on PATH.
        return resumeArgv(session.agent, session.id, alias ?? `${cli}@${session.version}`);
      }
      return resumeArgv(session.agent, session.id, cli);
    }
  }
  return null;
}


// ---------------------------------------------------------------------------
// Cloud session source (--cloud)
// ---------------------------------------------------------------------------

/**
 * Handle `agents sessions --cloud [id] [filters]`.
 * - Without id: list captured cloud-runs, optionally as JSON.
 * - With id: fetch the jsonl, parse with the recorded format, render via
 *   the same pipeline as local sessions (summary / markdown / json).
 */
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
  const spinner = options.json ? null : ora('Loading cloud sessions...').start();

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
  const cachedSpinner = options.json ? null : ora('Fetching session...').start();
  let cachedPath: string;
  try {
    cachedPath = await ensureCloudSessionCached(meta.id);
  } catch (err: any) {
    cachedSpinner?.stop();
    console.error(chalk.red(`Failed to fetch session: ${err?.message || err}`));
    process.exit(1);
  }
  cachedSpinner?.stop();

  // Ensure the SessionMeta points at the local cache path for renderSession.
  await renderSession({ ...meta, filePath: cachedPath }, mode, filterOpts, options);
}


interface AgentFilter {
  agent?: SessionAgentId;
  version?: string;
}

/** Resolve the harness portion of a sessions selector with the CLI's canonical
 * alias and single-typo rules. Kept pure so focus and the browser cannot drift. */
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

/**
 * Explicit `--agent` / `--project` / `--routine` flags. Distinct from the
 * listing pool (cwd-scoped, default-capped) that PHNX-2767 hydrates past:
 * these flags MUST still exclude FTS hits after that union.
 */
export type SessionSearchScope = {
  agent?: string;
  project?: string;
  routine?: boolean | string;
};

/**
 * How a `sessions <query>` argument was resolved against the pool.
 *
 * `byId` records that the rows came from an id lookup, so only then does an
 * ambiguous result mean "your id prefix is too short". `completeId` records that
 * the query was a whole session id: it is unique by construction, so a miss is
 * final and must NOT widen into a text/content search.
 */
export interface SessionQueryResolution {
  matches: SessionMeta[];
  byId: boolean;
  completeId: boolean;
}

/**
 * The single entry point for turning a `sessions <query>` argument into rows.
 *
 * An id-shaped query — a complete id OR a hex short-id/prefix (looksLikeSessionId)
 * — resolves by id alone, through the index, and never falls back to content
 * search (a bare id must not surface every transcript that merely mentions it).
 * A genuine search phrase keeps the ranked metadata+content search.
 */
export function resolveSessionQuery(
  pool: SessionMeta[],
  query: string,
  options: { indexFallback?: boolean; scope?: SessionSearchScope } = {},
): SessionQueryResolution {
  // Normalize ONCE here. isCompleteSessionId trims but resolveSessionById does
  // not, so a padded id ("<uuid> ", e.g. pasted from a terminal) would classify
  // as complete and then miss the id lookup — reporting a session that IS on
  // this machine as absent.
  const normalized = query.trim();
  const completeId = isCompleteSessionId(normalized);
  const byIdMatches = resolveSessionById(pool, normalized);
  if (byIdMatches.length > 0) return { matches: byIdMatches, byId: true, completeId };

  if (looksLikeSessionId(normalized)) {
    // Any id-shaped query — a complete id OR a bare hex short-id/prefix —
    // resolves by id ONLY, never by content. The pool is a minority of the
    // index (measured: 2,798 of 7,614 rows) because it re-reads live agent homes
    // and skips whole classes of indexed session, so a pool miss isn't absence:
    // ask the index directly, the same authoritative lookup `fork` and `exec`
    // use. And an id that resolves to nothing must report "no session with that
    // id" — NOT fall back to fuzzy content search. A short id like "d3470b57"
    // otherwise surfaces every transcript that merely MENTIONS the string (a
    // resume prompt echoes the parent id into the body of many later sessions).
    const matches = options.indexFallback === false ? [] : findSessionsById(normalized);
    return { matches, byId: true, completeId };
  }
  return { matches: filterSessionsByQuery(pool, normalized, options.scope), byId: false, completeId };
}

/** Explain an ambiguous resolution. Only a short id can be lengthened: a complete
 * id is already maximal, and a search phrase was never an id to begin with. */
function ambiguityHint(byId: boolean, completeId: boolean): string {
  if (completeId) return 'That is already a complete id — these rows share it as a prefix.';
  return byId
    ? 'Pass a longer ID to narrow it down.'
    : 'That matched on text, not an id. Pass a session id, or narrow the search.';
}

/** Explain a complete-id miss, which no local rephrasing can fix. Echoes the
 * normalized id so a pasted, padded argument doesn't produce an unrunnable hint.
 * Used only where NO fleet sweep ran (a `--local` lookup, an `--artifacts`
 * listing, or a peer answering a parent's sweep) — the fleet-swept miss uses
 * {@link fleetNotFoundMessage}. Never tells the user to pass `--device`: fleet
 * search is already the default, so a device flag can't find what the id missed. */
function notFoundByIdMessage(query: string): string[] {
  return [chalk.red(`No session with id ${query.trim()} on this machine.`)];
}

/** Honest result of a fleet sweep that found nothing: it says what the sweep
 * actually did — how many peers answered, which were unreachable — instead of
 * dead-ending on "search with --device <host>" after the search already ran. */
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

/** Filter and rank sessions by a multi-term search query across metadata and content. */
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
  // Hydrate FTS hits missing from the pool (PHNX-2767), then drop hits that
  // fail --project/--agent/--routine so those flags are not undone by the union.
  const contentIndex = scopedContentIndex(sessions, trimmed, scope);

  // If the query exactly matches a session label, short-circuit the structural
  // scorer (which would otherwise surface every session whose topic happens to
  // contain the same words) and return only the label hits.
  const EXACT_LABEL_SCORE = 1_000_000;
  const exactLabelHits = [...contentIndex.values()].filter(
    s => (s._bm25Score ?? 0) >= EXACT_LABEL_SCORE,
  );
  if (exactLabelHits.length > 0) {
    return exactLabelHits.sort(
      (a, b) => (b._bm25Score ?? 0) - (a._bm25Score ?? 0),
    );
  }

  // The listing pool is a page of the index. FTS hits the whole index. Union
  // so a grep-visible transcript is returned even when it missed the page
  // (PHNX-2767).
  const poolById = new Map(sessions.map(s => [s.id, s]));
  for (const [id, hit] of contentIndex) {
    if (!poolById.has(id)) poolById.set(id, hit);
  }

  return [...poolById.values()]
    .map(session => ({ session, score: scoreSessionQuery(session, terms) }))
    .filter(entry => {
      // Include if scored by topic/project/etc, or matched by content search
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
      // Attach content match terms for highlighting
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

/**
 * Narrow a session list by --project and --agent before search resolution.
 * Without this, a query like "scoped search" could match sessions in BOTH
 * the project you specified AND elsewhere, producing an ambiguity error
 * even though the user already pointed at the correct scope.
 *
 * PHNX-2767 hydrates FTS hits missing from the listing pool *after* this
 * runs, so callers that search must also pass the same scope into
 * `filterSessionsByQuery` / `scopedContentIndex` or the union
 * reintroduces the rows this function just dropped.
 */
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
    // Accept "claude" or "claude@2.1.112" / "claude@default" / "claude@latest". Version suffix narrows further.
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

/**
 * PHNX-2767 hydrates FTS hits missing from the listing pool. That union is
 * unscoped on purpose (cwd/limit are a page of the index, not a filter).
 * `--project` / `--agent` / `--routine` ARE filters: drop hydrated hits that
 * fail them so content search cannot undo a scope the user already set.
 */
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
        console.error(chalk.cyan(`  ${m.shortId}  ${m.id}  ${(m as any).label ?? m.topic ?? ''}`));
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
      // RUSH-2492: an unreachable peer is a warning, not a hard failure. The
      // resolver already resolves an id found on the reachable fleet (SES-9a),
      // so reaching here means the session was not found on any device we
      // COULD reach — it may live on an unreachable peer we could not check.
      const offline = outcome.failedPeers;
      console.error(chalk.yellow(`Warning: ${offline.length} device(s) unreachable, not checked: ${offline.join(', ')}`));
      console.error(chalk.red(`No session matching "${query}" on any reachable device (${offline.length} unreachable, not checked).`));
      console.error(chalk.gray('  If it lives on an offline box, wake it (agents devices) or run there: agents ssh <device>'));
      process.exit(1);
    }
    // An index miss can be a transcript created since the last incremental
    // scan, or a Claude history alias. Fall through to the established
    // discovery/history resolver below only on that cold miss.
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

    // Widen to the transcript content index only for a genuine search phrase.
    // ANY id-shaped query (a complete id OR a hex short-id/prefix) names a
    // specific session; widening could only surface a DIFFERENT session that
    // happens to MENTION the id — which is what made `sessions <uuid>` render an
    // unrelated transcript and `sessions <shortid>` list every session that
    // echoes the id in a resume prompt. Gate on looksLikeSessionId, not just
    // completeId, so a short id resolves to "no match" rather than fuzzy content.
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
        // Not on this machine. A UUID names ONE session, so before giving up ask
        // the fleet — the session may live only on a peer (the whole point of
        // RUSH-2024). Skip the sweep when the caller pinned --local, or when we
        // are ourselves a peer answering a parent's sweep (AGENTS_SESSIONS_LOCAL),
        // so a locate never recurses. On a single remote hit we hand rendering to
        // that peer; a multi-host hit surfaces the conflict; a miss keeps the
        // local not-found message. No FTS fallback either way.
        if (shouldFanOutForId(query, scope.local)) {
          const outcome = await resolveSessionAcrossFleet(query, mode, scope.hosts);
          if (outcome.kind === 'rendered') return;
          if (outcome.kind === 'conflict') process.exit(1);
          // The fleet sweep already ran and found nothing — report what actually
          // happened, never "search with --device <host>" (fleet search is the
          // default, so a device flag would only re-run the same miss).
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
          console.error(chalk.cyan(`  ${match.shortId}  ${match.id}  ${(match as any).label ?? match.topic ?? ''}`));
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

/**
 * Whether a missed local id lookup should widen to a cross-machine sweep.
 *
 * Gate (all must hold):
 *   - the query is id-shaped (`looksLikeSessionId`) — only an identifier resolves
 *     across the fleet; a search phrase never does.
 *   - not `--local` — the caller opted out of cross-machine lookup (deterministic
 *     local behavior for scripts, RUSH-2024 acceptance: "--local still restricts").
 *   - `AGENTS_SESSIONS_LOCAL` is unset — we are not ourselves a peer answering a
 *     parent's sweep, so a locate can never recurse (RUSH-2024: avoid double-fan-out).
 *
 * Pure + exported so the gate is unit-tested without driving discovery / SSH.
 */
export function shouldFanOutForId(query: string, local: boolean | undefined): boolean {
  if (local === true) return false;
  if (process.env[NO_FANOUT_ENV] === '1') return false;
  return looksLikeSessionId(query);
}

/** The render-mode flag a peer's `agents sessions <id>` must carry so the remote
 * summary matches the mode the user asked for. `summary` is the peer's default,
 * so it needs no flag; the others map 1:1 to a CLI flag. */
function modeFlag(mode: ViewMode): string | undefined {
  if (mode === 'markdown') return '--markdown';
  if (mode === 'json') return '--json';
  return undefined; // summary — the peer's default render
}

/** Injectable SSH/peer boundary so the fleet-resolve logic is unit-testable
 * without a live tailnet. Production wires these to the real remote-list infra. */
export interface FleetResolveDeps {
  gatherRemoteList: typeof gatherRemoteList;
  runOnPeer: typeof runOnPeer;
}

/** One distinct machine that reported a logical session, plus its winning row. */
interface FleetHit {
  machine: string;
  session: SessionMeta;
}

/** One logical session returned by the fleet, including every machine holding a copy. */
export interface FleetSessionCandidate {
  id: string;
  hits: FleetHit[];
}

export type MetadataResolveOutcome =
  | { kind: 'resolved'; session: SessionMeta }
  | { kind: 'not-found' }
  | { kind: 'ambiguous'; candidates: FleetSessionCandidate[] }
  | { kind: 'partial'; failedPeers: string[] };

const FULL_SESSION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Width of `SessionMeta.shortId` / the hex a tmux alias embeds (`deriveShortId`). */
const SHORT_SESSION_ID_RE = /^[0-9a-f]{8}$/i;


/**
 * A match unique enough to resolve on the FIRST peer that returns it and cancel
 * the rest of the fleet sweep: a full session UUID (globally unique), a live
 * tmux alias, or a bare 8-hex short id — all three name at most one session PER
 * ANSWERING peer, so the first reachable hit is enough (PHNX-3292: the alias/
 * short-id case is exactly what `agents tmux ls` prints, and it used to stay
 * all-settle right alongside a genuine keyword search).
 *
 * A session **label** is deliberately NOT definitive here even on an exact
 * match: labels are free-form and can collide, so a distinct session may carry
 * the same label on a peer that has not answered yet — early-exiting on the
 * first would silently, and nondeterministically, resume the wrong session
 * (whichever peer replied first). Labels therefore stay all-settle so a
 * cross-machine label conflict surfaces as an ambiguity, and a short-id PREFIX
 * *shorter* than the full 8-hex width stays all-settle for the same reason
 * (RUSH-2203).
 *
 * This is about cancelling a sweep that is still IN FLIGHT, where a peer that
 * has not answered yet is still expected to. It is deliberately stricter than
 * `isUniqueEnoughSelector`, which decides what to do once the sweep is OVER and
 * a peer has definitively not answered — see SES-9a. A collision between two
 * peers that BOTH answer before the abort lands is still caught by the ordinary
 * uniqueness gate in `metadataResolveOutcome`/`fleetCandidatesByQuery`; only a
 * peer that has not answered yet, at the moment of the FIRST hit, is the
 * accepted risk (documented in the PHNX-3292 plan).
 */
export function isDefinitiveMatch(session: SessionMeta, selector: string): boolean {
  const trimmed = selector.trim();
  if (FULL_SESSION_ID_RE.test(trimmed)) {
    return session.id.toLowerCase() === trimmed.toLowerCase();
  }
  const shortId = shortIdFromName(trimmed) ?? (SHORT_SESSION_ID_RE.test(trimmed) ? trimmed : undefined);
  return !!shortId && session.shortId.toLowerCase() === shortId.toLowerCase();
}

/**
 * Whether a selector may enable early-exit on the cancellable fan-out: a full
 * UUID, a tmux alias, or an exact 8-hex short id — every shape that is globally
 * unique enough for the first hit to be the only hit worth waiting for. Labels,
 * keywords, and short-id prefixes narrower than 8 hex stay all-settle: their
 * uniqueness (or conflict) is only knowable once every peer has answered. See
 * {@link isDefinitiveMatch}.
 */
export function selectorAllowsEarlyExit(selector: string): boolean {
  const trimmed = selector.trim();
  return FULL_SESSION_ID_RE.test(trimmed) || isAgentTmuxAlias(trimmed) || SHORT_SESSION_ID_RE.test(trimmed);
}

/** Resolve a fleet sweep through the same canonical full-id / prefix resolver as
 * local lookups, then group copies by logical session id. Synced mirrors of one
 * session therefore stay one candidate even when several machines report them;
 * distinct ids sharing a prefix remain distinct ambiguity candidates. */
export function fleetCandidatesByQuery(rows: SessionMeta[], query: string, trustResolvedRows = false): FleetSessionCandidate[] {
  // An id selector must still be prefix-filtered defensively against older peers
  // returning content mentioners. Keyword rows, however, were already matched by
  // each peer's own FTS index; the parent does not own that transcript/index and
  // must not re-run metadata-only filtering that could discard a content hit.
  const matched = !trustResolvedRows && looksLikeSessionId(query)
    ? resolveSessionQuery(rows, query, { indexFallback: false }).matches
    : rows;
  const byId = new Map<string, Map<string, SessionMeta>>();
  for (const session of matched) {
    const machine = session.machine;
    if (!machine) continue; // an untagged row can't be routed back to a peer
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

/** Resolve through the canonical metadata+content union used by keyword search. */
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

/**
 * ID-shaped selectors go straight to SQLite's primary-key/short-id lookup.
 * Keyword and label selectors still need the broader metadata pool.
 */
function indexedRowsForSelector(
  selector: string,
  scope: { agent?: string; project?: string },
): SessionMeta[] {
  const indexed = looksLikeSessionId(selector)
    ? findSessionsById(selector)
    : querySessions();
  return applyScopeFilters(indexed, scope);
}

/** Fixed peer argv for the metadata resolver. Scope flags compose identically on
 * every host; `--all` removes the SSH login cwd/time window, not agent/project filters. */
export function metadataResolveForwardedArgs(
  selector: string,
  scope: Pick<SessionFilterOptions, 'agent' | 'project'>,
): string[] {
  const args = ['sessions', '--resolve-safe-v1', selector, '--json', '--all', '--local'];
  if (scope.agent) args.push('--agent', scope.agent);
  if (scope.project) args.push('--project', scope.project);
  return args;
}

/** Build the local-only peer argv for a distributed tool search. */
export function toolSearchForwardedArgs(argv: string[], hosts: string[]): string[] {
  const args = ensureWholeIndex(
    buildForwardedArgs(argv, new Set(hosts)).filter((arg) => arg !== '--fleet'),
  );
  if (!args.includes('--json')) args.push('--json');
  if (!args.includes('--local')) args.push('--local');
  return args;
}

/** Width of the short id the CLI prints everywhere (`SessionMeta.shortId`):
 * 8 hex chars / 32 bits. A selector shorter than this is treated as a keyword,
 * not an identifier. */
const SHORT_SESSION_ID_WIDTH = 8;

/**
 * Whether a selector names ONE session precisely enough to resolve from the
 * reachable fleet alone when some peer did not answer (SES-9a).
 *
 * Deliberately stricter than `looksLikeSessionId`, which accepts any 6+ char
 * `[0-9a-f-]` run and so matches ordinary words (`facade`, `decade`, `beaded`).
 * Those are keywords a user typed as a search, not identifiers, and they must
 * keep waiting for every peer.
 */
export function isUniqueEnoughSelector(selector: string): boolean {
  const trimmed = selector.trim();
  if (isCompleteSessionId(trimmed)) return true;
  return /^[0-9a-f-]+$/i.test(trimmed)
    && trimmed.replace(/-/g, '').length >= SHORT_SESSION_ID_WIDTH;
}

/** Resolution fails closed for keywords and labels when a peer did not answer.
 * An id-shaped selector at least `SHORT_SESSION_ID_WIDTH` hex chars wide (or a
 * complete id) resolves from a single reachable hit even when an unrelated
 * registered device is offline — see SES-9a for the accepted collision risk. */
export function metadataResolveOutcome(
  localMatches: SessionMeta[],
  remote: { sessions: SessionMeta[]; unreachable: string[] },
  selector: string,
): MetadataResolveOutcome {
  // Every peer answered through --resolve-safe-v1, so its native-id row is
  // already the result of resolving the original selector. Re-filtering by the
  // selector would discard alias suffixes such as c1f3d813 because the native
  // UUID intentionally has a different prefix.
  const candidates = fleetCandidatesByQuery([...localMatches, ...remote.sessions], selector, true);
  // One hit on the REACHABLE fleet resolves a precise-enough id selector even
  // when a peer is offline (SES-9a). This is a deliberate, bounded trade, not a
  // claim that prefixes cannot collide — they can, which is why the `ambiguous`
  // branch below still exists for peers that DID answer:
  //   - refusing costs 100% of lookups on any fleet with a permanently offline
  //     device (9 of them here), to avoid a prefix collision that ALSO has to
  //     land on the one box that did not answer. Rate depends on the id type:
  //     a UUIDv4 short id is unique in practice, while a time-ordered
  //     UUIDv7/ULID prefix is largely a timestamp and collides much more
  //     readily (see deriveShortId in session/db.ts);
  //   - `isUniqueEnoughSelector` keeps this off keyword-shaped queries, so a
  //     6-char word like `facade` or `decade` is not treated as an identifier.
  // A label stays fail-closed at any length: labels are free-form and collide by
  // design, so one hit there really is a guess.
  // (RUSH-2203's early-exit — see isDefinitiveMatch — cancels the sweep
  // mid-flight, where a peer that has not answered YET is still expected to
  // answer, so it stays narrower than this post-sweep gate even though
  // PHNX-3292 widened it past UUID to alias/8-hex too. Here the sweep is
  // already over.)
  if (isUniqueEnoughSelector(selector) && candidates.length === 1) {
    return { kind: 'resolved', session: candidates[0].hits[0].session };
  }
  if (remote.unreachable.length > 0) return { kind: 'partial', failedPeers: remote.unreachable };
  if (candidates.length === 0) return { kind: 'not-found' };
  if (candidates.length > 1) return { kind: 'ambiguous', candidates };
  return { kind: 'resolved', session: candidates[0].hits[0].session };
}

/** Injectable dependency for the live-registry cold-miss fallback (RUSH-2682). */
export type LiveMetadataDeps = { loadActive?: typeof loadLocalActiveSessions };

/**
 * Local metadata candidates for a selector: the indexed SQLite rows, plus — when
 * an id-shaped selector misses the index entirely — the live-session registry
 * (RUSH-2682).
 *
 * Indexing is lazy (it only runs inside `discoverSessions`), so a session THIS
 * box just started is "running" in `agents sessions --active` minutes before its
 * transcript reaches the local index. Every id resolver (`preview`, `resume`,
 * `focus`, and the fan-out peer that answers `--resolve-safe-v1`) therefore
 * consults the SAME live registry `--active` reads before declaring a running
 * session non-existent. It reshapes process state the registry already computed;
 * it parses no transcript and renders nothing. The live path is entered ONLY on a
 * cold id miss, so an indexed hit keeps its richer row and keyword resolution is
 * unchanged.
 */
export async function computeLocalMetadataMatches(
  selector: string,
  scope: { agent?: string; project?: string; local?: boolean; hosts?: string[] },
  deps: LiveMetadataDeps = {},
): Promise<SessionMeta[]> {
  const localMachine = machineId();
  const includeLocal = !scope.hosts?.length || shouldIncludeLocal(scope.hosts, localMachine);
  if (!includeLocal) return [];

  const indexed = resolveIndexedMetadataRows(indexedRowsForSelector(selector, scope), selector, scope);
  if (indexed.length > 0 || !looksLikeSessionId(selector)) {
    return indexed.map(session => ({ ...session, machine: session.machine || localMachine }));
  }

  const live = await liveMetadataMatches(selector, scope, localMachine, deps);
  return live.map(session => ({ ...session, machine: session.machine || localMachine }));
}

/**
 * Resolve an id-shaped selector against the local live-session registry
 * (RUSH-2682). Reads the daemon-warmed active snapshot first (cheap); if that
 * snapshot predates a just-started session and misses, it forces ONE fresh
 * gather before conceding, so a session started seconds ago resolves
 * synchronously. Never throws — a degraded registry read yields no candidates,
 * so the caller falls through to the ordinary not-found path.
 */
export async function liveMetadataMatches(
  selector: string,
  scope: { agent?: string; project?: string },
  self: string,
  deps: LiveMetadataDeps = {},
): Promise<SessionMeta[]> {
  const load = deps.loadActive ?? loadLocalActiveSessions;
  const match = (metas: SessionMeta[]): SessionMeta[] =>
    resolveIndexedMetadataRows(applyScopeFilters(metas, scope), selector, scope);
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

/** Reusable local-first resolver for `agents run --resume` and `agents sessions resume`.
 * Full UUIDs hit the local SQLite index without any SSH fan-out. */
export async function resolveSessionMetadataValue(
  selector: string,
  scope: { agent?: string; project?: string; local?: boolean; hosts?: string[] } = {},
  deps: Pick<FleetResolveDeps, 'gatherRemoteList'> & LiveMetadataDeps = { gatherRemoteList },
): Promise<MetadataResolveOutcome> {
  const localMatches = await computeLocalMetadataMatches(selector, scope, deps);

  // A full-UUID local hit resolves with ZERO SSH: a UUID is globally unique, so
  // finding it locally is the whole answer and no peer is dialed. (A label is
  // NOT resolved local-only here — it can collide with a same-label session on a
  // peer, so it must consult the fleet; see isDefinitiveMatch, RUSH-2203.) The
  // local index lookup is synchronous and completes before any fan-out spawns,
  // so this local hit never waits on a peer.
  if (FULL_SESSION_ID_RE.test(selector)) {
    const localOutcome = metadataResolveOutcome(localMatches, { sessions: [], unreachable: [] }, selector);
    if (localOutcome.kind === 'resolved') return localOutcome;
  }

  if (scope.local === true) return metadataResolveOutcome(localMatches, { sessions: [], unreachable: [] }, selector);

  try {
    const forwarded = metadataResolveForwardedArgs(selector, scope);
    // Definitive lookups (full UUID / exact label) opt into early-exit: the
    // first peer holding the match resolves the sweep and SIGTERMs the rest, so
    // a fast peer's hit is not bounded by the slowest/unreachable peer. Short-id
    // prefixes stay all-settle (ambiguity is only known once every peer answers).
    const remote = await deps.gatherRemoteList(
      forwarded,
      scope.hosts,
      selectorAllowsEarlyExit(selector)
        ? { isDefinitive: (session) => isDefinitiveMatch(session, selector) }
        : undefined,
    );
    return metadataResolveOutcome(localMatches, remote, selector);
  } catch (error: any) {
    return metadataResolveOutcome(localMatches, { sessions: [], unreachable: [error?.message ?? 'fleet fan-out'] }, selector);
  }
}

/** Resolve one selector to indexed metadata across the fleet without reading or
 * rendering transcript events. A peer answering the parent sweep returns every
 * local candidate; the parent performs the one logical-session uniqueness gate.
 * Backs `agents sessions --resolve <selector> --json`. Exported (deps already
 * injectable) so tests can drive this real call site against a fake fan-out
 * instead of only the pure resolver it wraps. */
export async function resolveSessionMetadata(
  selector: string,
  scope: { agent?: string; project?: string; local?: boolean; hosts?: string[] },
  deps: Pick<FleetResolveDeps, 'gatherRemoteList'> & LiveMetadataDeps = { gatherRemoteList },
): Promise<void> {
  // Same local candidate set as resolveSessionMetadataValue, so the peer
  // answering a fan-out (`--resolve-safe-v1`, NO_FANOUT) surfaces a running
  // session its own index has not caught yet — the cross-device half of the
  // RUSH-2682 fix, since the parent's fan-out reads this box's answer.
  const localMatches = await computeLocalMetadataMatches(selector, scope, deps);

  // A peer is already inside gatherRemoteList. Return all local candidates so
  // the parent can distinguish a fleet-wide unique match from an ambiguity.
  if (process.env[NO_FANOUT_ENV] === '1') {
    process.stdout.write(serializeResolvedSessionsJson(localMatches));
    return;
  }

  const outcome = await resolveSessionMetadataValue(selector, scope, deps);
  if (outcome.kind === 'partial') {
    // RUSH-2492: an unreachable peer is a warning, not a hard failure. The
    // resolver already resolves an id found on the reachable fleet (SES-9a),
    // so reaching here means the session was not found on any device we
    // COULD reach — it may live on an unreachable peer we could not check.
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
      console.error(chalk.cyan(`  ${session.shortId}  ${session.id}`) + chalk.gray(`  ${machines}  ${(session as any).label ?? session.topic ?? ''}`));
    }
    console.error(chalk.gray(looksLikeSessionId(selector) ? 'Pass a longer ID to narrow it down.' : 'Narrow the keywords to one session.'));
    process.exit(1);
  }

  process.stdout.write(serializeResolvedSessionsJson([outcome.session]));
}

/**
 * Locate a full session id or short id prefix across the online fleet and render it from the machine
 * that holds it. The local disk already missed; this fans `sessions <id> --json
 * --all` out to every registered online peer (or the explicit `hosts` set),
 * groups the rows to distinct machines, then:
 *
 *   - exactly one logical session → delegate rendering to one peer via `runOnPeer`
 *     (its transcript and agent binary live there — a local `--device` hop would
 *     re-discover locally and dead-end), returning `'rendered'`.
 *   - more than one logical session → print every full-id candidate with its
 *     machine labels, returning `{ kind: 'conflict' }`.
 *   - none                 → `{ kind: 'not-found', deviceCount, unreachable }`,
 *     letting the caller print an honest sweep-aware message.
 *
 * A full-UUID query opts into early-exit: the first peer holding it resolves the
 * sweep and cancels the rest, so a fast peer is not bounded by the slowest one.
 * A short-id prefix stays all-settle — its ambiguity is only known once every
 * peer has answered, so it must wait to surface a conflict.
 *
 * No fuzzy/content fallback: the sweep forwards the id selector and every result
 * is resolved through `resolveSessionQuery`, the same id-only resolver used locally.
 */
export type FleetResolveResult =
  | { kind: 'rendered' }
  | { kind: 'conflict' }
  | { kind: 'not-found'; deviceCount: number; unreachable: string[] };

export async function resolveSessionAcrossFleet(
  query: string,
  mode: ViewMode,
  hosts?: string[],
  deps: FleetResolveDeps = { gatherRemoteList, runOnPeer },
): Promise<FleetResolveResult> {
  const spinner = isInteractiveTerminal() ? ora('Searching the fleet...').start() : null;
  let candidates: FleetSessionCandidate[] = [];
  let deviceCount = 0;
  let unreachable: string[] = [];
  try {
    // Force whole-index scope (--all): the peer runs in its SSH-login home dir,
    // whose cwd would otherwise silently narrow the lookup and hide the row.
    // --json so each peer answers a parseable array; --local so it answers for
    // itself and never re-fans-out (belt-and-suspenders with the parent's
    // AGENTS_SESSIONS_LOCAL, which remote-list also sets on the peer).
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
    // A fan-out failure is not an exact resolution — treat as not-found so the
    // caller prints the honest message rather than a half-answer.
    candidates = [];
  } finally {
    spinner?.stop();
  }

  if (candidates.length === 0) return { kind: 'not-found', deviceCount, unreachable };

  if (candidates.length > 1) {
    console.error(chalk.red(`Multiple sessions match "${query}" across the fleet:`));
    for (const candidate of candidates) {
      const s = candidate.hits[0].session;
      const label = (s as any).label ?? s.topic ?? '';
      const machines = candidate.hits.map(hit => hit.machine).join(', ');
      console.error(chalk.cyan(`  ${s.shortId}  ${s.id}`) + chalk.gray(`  ${machines}  ${s.agent}${s.version ? ` ${s.version}` : ''}  ${label}`));
    }
    console.error(chalk.gray('Pass a longer ID to narrow it down.'));
    return { kind: 'conflict' };
  }

  const candidate = candidates[0];
  const { machine } = candidate.hits[0];
  // Render the remote summary by re-running `sessions <id>` ON the peer. --local
  // keeps that render on the peer (it owns the transcript); the mode flag matches
  // the mode the user asked for. No TTY: a summary/markdown/json render is a
  // one-shot capture, not an interactive resume.
  const peerArgs = ['sessions', candidate.id, '--local'];
  const flag = modeFlag(mode);
  if (flag) peerArgs.push(flag);
  const result = await deps.runOnPeer(peerArgs, machine);
  if (result === 'no-target') {
    console.error(chalk.red(`Session ${candidate.id} is on ${machine}, but it is not a reachable registered device.`));
    console.error(chalk.gray('Register it with `agents devices` or run the command on that machine.'));
    return { kind: 'conflict' }; // a definitive answer (found, un-renderable) — do NOT fall to the local not-found line
  }
  return { kind: 'rendered' };
}

/** Register the `agents sessions` command with all its options and help text. */
export function registerSessionsCommands(program: Command): void {
  const sessionsCmd = program
    .command('sessions')
    .argument('[query]', 'Session ID, search query, or path (., ../, /path) to filter by project')
    .option('--query <clause>', 'Search text; repeat with --include tools to require distinct matching calls', collectQueryClause, [])
    .option('--resolve <selector>', 'Resolve one full ID, unique prefix, or keyword query to safe session metadata (requires --json; searches the fleet unless --local)')
    .addOption(new Option('--resolve-safe-v1 <selector>').hideHelp())
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
        (retired, still working for one release: sessions attach, sessions go, reconnect)
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
      // Alias for `agents browser sessions`: a profile positional narrows to one
      // profile. `--no-interactive` is already a top-level sessionsCmd option
      // (options.interactive), so it carries through for free.
      await runBrowserSessionsCommand({ profile: query, json: options.json, interactive: options.interactive });
      return;
    }
    if ((options as { computer?: boolean }).computer) {
      // Alias for `agents computer sessions`: a machine positional narrows to
      // one machine. `--no-interactive` carries through the same way.
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
    .option('--json', 'Output the session preview as JSON');

  setHelpSections(previewCmd, {
    examples: `
      # Preview by the 8-character ID shown in agents sessions
      agents sessions preview 407b8dd5

      # A full UUID resolves on the first device that owns it
      agents sessions preview c70ecdea-6210-4039-9845-246a3a7a9942

      # Stay on this machine or restrict the authoritative lookup to one peer
      agents sessions preview 407b8dd5 --local
      agents sessions preview 407b8dd5 --device zion
    `,
    notes: `
      - Full UUIDs are globally unique and may stop the fleet lookup at the first exact hit.
      - Short IDs wait for every selected device so ambiguity is never hidden.
      - Active status is refreshed through the bounded live-state TTL; transcript-derived details use the durable session index.
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
    };
    const hosts = [...(options.host ?? []), ...(options.device ?? [])];
    await renderSessionPreview(id, {
      agent: options.agent,
      project: options.project,
      local: options.local,
      hosts: hosts.length > 0 ? hosts : undefined,
      json: options.json,
    });
  });

  registerSessionsTailCommand(sessionsCmd);
  registerSessionsResumeCommand(sessionsCmd);
  registerSessionsForkCommand(sessionsCmd);
  registerSessionsBookmarkCommand(sessionsCmd);
  registerGoCommand(sessionsCmd);
  registerFocusCommand(sessionsCmd);
  registerReconnectCommand(sessionsCmd);
  registerDetachCommand(sessionsCmd);
  registerSessionsStopCommand(sessionsCmd);
  registerAttachCommand(sessionsCmd);
  registerSessionsInjectCommand(sessionsCmd);
  registerSessionsExportCommand(sessionsCmd);
  registerSessionsRenderCommand(sessionsCmd);
  registerSessionsTraceCommand(sessionsCmd);
  registerSessionsShareCommand(sessionsCmd);
  registerSessionsImportCommand(sessionsCmd);
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
  // Resolve symlinks (e.g. macOS /var -> /private/var) so we match sessions
  // whose cwd was canonicalized at scan time.
  let projectRoot = historyEntry.project;
  try { projectRoot = fs.realpathSync(projectRoot); } catch { /* dir gone */ }

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
  // Compare separator- and case-normalized (Windows folds `\`→`/` and lowercases)
  // so a backslash session cwd matches a forward-slash project root and vice versa.
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

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

function formatAbsoluteTime(isoTimestamp: string): string {
  const d = new Date(isoTimestamp);
  if (isNaN(d.getTime())) return isoTimestamp;
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${months[d.getMonth()]} ${d.getDate()} ${hh}:${mm}`;
}
