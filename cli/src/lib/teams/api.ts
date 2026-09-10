/**
 * Testable API handlers for `agents teams`.
 * These functions can be called directly in tests with a custom AgentManager.
 */
import * as path from 'path';
import * as fs from 'fs/promises';

import { AgentManager, AgentStatus, resolveMode, type TaskType, type TeammateFailure } from './agents.js';
import { AgentType } from './parsers.js';
import { getDelta } from './summarizer.js';
import { debug } from './debug.js';
import { buildClaudeLabelMap } from '../session/discover.js';
import { resolveTeammateDelivery } from './delivery.js';
import { hasUncommittedChanges } from './worktree.js';

/**
 * Truncate a bash command for status output.
 * Handles heredocs specially - shows the redirect target instead of contents.
 */
function truncateBashCommand(cmd: string, maxLen: number = 120): string {
  // Detect heredoc patterns: cat <<'EOF' > path or cat << EOF > path
  const heredocMatch = cmd.match(/cat\s+<<['"]?(\w+)['"]?\s*>\s*([^\s]+)/);
  if (heredocMatch) {
    return `cat <<${heredocMatch[1]} > ${heredocMatch[2]}`;
  }

  // For regular commands, just truncate
  if (cmd.length <= maxLen) return cmd;
  return cmd.substring(0, maxLen - 3) + '...';
}

function eventToolName(event: any): string | null {
  const eventType = event.type || '';
  if (eventType === 'bash') return 'Bash';
  if (eventType === 'file_write') return 'Write';
  if (eventType === 'file_create') return 'Create';
  if (eventType === 'file_read') return 'Read';
  if (eventType === 'file_delete') return 'Delete';
  if (eventType === 'directory_list') return 'List';
  if (eventType === 'tool_use') return event.tool || 'Tool';
  return null;
}

function eventToolSummary(event: any): string {
  const value =
    event.command ||
    event.path ||
    event.args?.command ||
    event.args?.path ||
    event.input?.command ||
    event.input?.path ||
    '';
  return truncateBashCommand(String(value || eventToolName(event) || 'tool call'));
}

export interface ToolCallDetail {
  tool: string;
  summary: string;
  timestamp: string | null;
}

function recentToolCalls(events: any[], max = 10): ToolCallDetail[] {
  return events
    .filter((event) => eventToolName(event))
    .slice(-max)
    .map((event) => ({
      tool: eventToolName(event) || 'Tool',
      summary: eventToolSummary(event),
      timestamp: typeof event.timestamp === 'string' ? event.timestamp : null,
    }));
}

/** Result returned after spawning a new teammate. */
export interface SpawnResult {
  task_name: string;
  agent_id: string;
  agent_type: string;
  status: string;
  started_at: string;
  version?: string | null;
  profile_name?: string | null;
  account?: string | null;
  remote_session_id?: string | null;
  name?: string | null;
  after?: string[];
  task_type?: TaskType | null;
  cloud_provider?: string | null;
  cloud_session_id?: string | null;
  /** Device name the teammate runs on for a distributed (--on) teammate; null for local. */
  host?: string | null;
  /** Sanitized evidence observed at the lifecycle boundary that failed. */
  failure?: TeammateFailure | null;
}

/** Detailed status of a single teammate, including file ops, commands, and a cursor for delta polling. */
export interface AgentStatusDetail {
  agent_id: string;
  agent_type: string;
  status: string;
  prompt: string;
  started_at: string;
  completed_at: string | null;
  duration: string | null;
  files_created: string[];
  files_modified: string[];
  files_read: string[];
  files_deleted: string[];
  bash_commands: string[];
  recent_tool_calls: ToolCallDetail[];
  last_messages: string[];
  tool_count: number;
  has_errors: boolean;
  cursor: string;  // ISO timestamp - send back in next request for delta
  mode?: string;
  cloud_session_id?: string | null;
  cloud_provider?: string | null;
  pr_url?: string | null;
  /**
   * Delivery postcondition (RUSH-2380), distinct from process `status`.
   * `pr_open` when the process completed but left an unmerged PR — orchestrators
   * must not treat that as "work landed on main".
   */
  delivery?: string;
  version?: string | null;
  remote_session_id?: string | null;
  session_label?: string | null;
  name?: string | null;
  after?: string[];
  task_type?: TaskType | null;
  /** Device name the teammate runs on for a distributed (--on) teammate; null for local. */
  host?: string | null;
  /** Absolute path to the teammate's worktree, when known. */
  workspace_dir?: string | null;
  /** Sanitized evidence observed at the lifecycle boundary that failed. */
  failure?: TeammateFailure | null;
}

/** Aggregated status of all teammates in a task, with per-status counts and a global cursor. */
export interface TaskStatusResult {
  task_name: string;
  agents: AgentStatusDetail[];
  summary: { pending: number; running: number; completed: number; stranded: number; failed: number; stopped: number };
  cursor: string;  // ISO timestamp - max across all agents
}

/**
 * Compact per-teammate snapshot for the default `teams status` view.
 *
 * The detail shape (`AgentStatusDetail`) carries the full prompt (often many
 * KB), every absolute path the agent has touched, and uncapped message
 * bodies. That's the right shape for programmatic consumers, but it makes
 * `teams status` unreadable for orchestrators who only need: what state are
 * you in, what did you just do, what files have you touched.
 *
 * Use {@link toAgentStatusSummary} to derive this from a detail record.
 */
export interface AgentStatusSummary {
  agent_id: string;
  name: string | null;
  agent_type: string;
  status: string;
  /** Delivery postcondition — see {@link AgentStatusDetail.delivery}. */
  delivery?: string;
  duration: string | null;
  tool_count: number;
  has_errors: boolean;
  pr_url: string | null;
  files: {
    /** Count of files modified since the cursor (delta), plus basenames. */
    modified: { count: number; names: string[] };
    created:  { count: number; names: string[] };
    deleted:  { count: number; names: string[] };
    /** Read is noisy (per-Read events fire constantly); only emit a count. */
    read:     { count: number };
  };
  /** Already capped at 15 × 120 chars by the detail builder. */
  bash_commands: string[];
  /** Last 3 messages, each body trimmed to ~400 chars. */
  last_messages: string[];
  /** Device name for a distributed (--on) teammate; null for local. */
  host: string | null;
  failure: TeammateFailure | null;
  /** Absolute path to the teammate's worktree, when known. */
  workspace_dir?: string | null;
  /** ISO timestamp — feed back via --since for delta polling. */
  cursor: string;
}

/** Compact aggregated result; mirrors {@link TaskStatusResult} but agents[] is the summary shape. */
export interface TaskStatusSummaryResult {
  task_name: string;
  agents: AgentStatusSummary[];
  summary: { pending: number; running: number; completed: number; stranded: number; failed: number; stopped: number };
  cursor: string;
}

/** Max files to name per category in the summary. Counts are always exact. */
const SUMMARY_MAX_FILE_NAMES = 6;
/** Max messages in the summary. */
const SUMMARY_MAX_MESSAGES = 3;
/** Max chars per message body in the summary. */
const SUMMARY_MESSAGE_MAX_CHARS = 400;

/**
 * Reduce a file path to just its basename for compact rendering. Keeps the
 * orchestrator oriented ("you touched types.ts") without dumping the full
 * absolute path every time. The full paths are still in `AgentStatusDetail`
 * for the verbose path.
 */
function basenameOf(p: string): string {
  const ix = p.lastIndexOf('/');
  return ix < 0 ? p : p.slice(ix + 1);
}

/**
 * Trim long assistant messages to a fixed budget. We collapse leading
 * whitespace so the budget covers actual content, not indent.
 */
function trimMessage(msg: string, max = SUMMARY_MESSAGE_MAX_CHARS): string {
  const s = msg.replace(/^\s+/, '');
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + '…';
}

/** Pull at most `max` basenames out of a path list, preserving order. */
function compactFileList(paths: string[], max = SUMMARY_MAX_FILE_NAMES): { count: number; names: string[] } {
  const seen = new Set<string>();
  const names: string[] = [];
  for (const p of paths) {
    const base = basenameOf(p);
    if (seen.has(base)) continue;
    seen.add(base);
    names.push(base);
    if (names.length >= max) break;
  }
  return { count: paths.length, names };
}

/**
 * Project a full AgentStatusDetail down to a compact AgentStatusSummary.
 * Drops `prompt` entirely (caller knows what they queued), folds file lists
 * to basenames + counts, caps `last_messages` to 3 × {@link SUMMARY_MESSAGE_MAX_CHARS}.
 */
export function toAgentStatusSummary(detail: AgentStatusDetail): AgentStatusSummary {
  return {
    agent_id: detail.agent_id,
    name: detail.name ?? null,
    agent_type: detail.agent_type,
    status: detail.status,
    delivery:
      detail.delivery ??
      resolveTeammateDelivery({ status: detail.status, prUrl: detail.pr_url }),
    duration: detail.duration,
    tool_count: detail.tool_count,
    has_errors: detail.has_errors,
    pr_url: detail.pr_url ?? null,
    files: {
      modified: compactFileList(detail.files_modified),
      created:  compactFileList(detail.files_created),
      deleted:  compactFileList(detail.files_deleted),
      read:     { count: detail.files_read.length },
    },
    bash_commands: detail.bash_commands,
    last_messages: detail.last_messages
      .slice(-SUMMARY_MAX_MESSAGES)
      .map((m) => trimMessage(m)),
    host: detail.host ?? null,
    failure: detail.failure ?? null,
    workspace_dir: detail.workspace_dir ?? null,
    cursor: detail.cursor,
  };
}

/** Project a full TaskStatusResult down to the compact summary shape. */
export function toTaskStatusSummary(result: TaskStatusResult): TaskStatusSummaryResult {
  return {
    task_name: result.task_name,
    agents: result.agents.map(toAgentStatusSummary),
    summary: result.summary,
    cursor: result.cursor,
  };
}

/** Result of stopping one or more teammates. */
export interface StopResult {
  task_name: string;
  stopped: string[];
  already_stopped: string[];
  not_found: string[];
}

/** Summary metadata for a single task (team), including agent counts by status and timestamps. */
export interface TaskInfo {
  task_name: string;
  agent_count: number;
  pending: number;
  running: number;
  completed: number;
  /** Completed teammates with uncommitted work and no PR (PHNX-2951). */
  stranded: number;
  failed: number;
  stopped: number;
  workspace_dir: string | null;
  created_at: string;   // Earliest agent start time
  modified_at: string;  // Latest agent activity (completion or current time if running)
}

/** Paginated list of tasks sorted by most recent activity. */
export interface TasksResult {
  tasks: TaskInfo[];
}

/** Spawn a new teammate in a task and return its initial metadata. */
export async function handleSpawn(
  manager: AgentManager,
  taskName: string,
  agentType: AgentType,
  prompt: string,
  cwd: string | null,
  mode: string | null,
  effort: 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'auto' | null = 'medium',
  parentSessionId: string | null = null,
  workspaceDir: string | null = null,
  version: string | null = null,
  name: string | null = null,
  after: string[] = [],
  model: string | null = null,
  envOverrides: Record<string, string> | null = null,
  taskType: TaskType | null = null,
  cloudProvider: string | null = null,
  cloudSessionId: string | null = null,
  cloudRepo: string | null = null,
  cloudBranch: string | null = null,
  worktreeName: string | null = null,
  worktreePath: string | null = null,
  profileName: string | null = null,
  hostName: string | null = null,
  hostTarget: string | null = null,
  repoPath: string | null = null,
  /** The team's `--project`; grants resolve from it at launch. */
  project: string | null = null,
  account: string | null = null,
): Promise<SpawnResult> {
  const defaultMode = manager.getDefaultMode();
  const resolvedMode = resolveMode(mode, defaultMode);
  const resolvedEffort = effort ?? 'medium';

  debug(
    `[spawn] Spawning ${agentType} agent for task "${taskName}" [${resolvedMode}] effort=${resolvedEffort}${profileName ? ` profile=${profileName}` : ''}...`
  );

  // Budget pre-flight gate (issue #346). Teammates inherit the project's caps:
  // before launching one, project its estimated cost onto current spend and
  // refuse when on_exceed:block would be breached. Cross-vendor by construction
  // — a Claude teammate and a Codex teammate draw down the same per_project /
  // per_day pool. Dormant (no-op) when no caps are configured.
  {
    const gateCwd = cwd || workspaceDir || worktreePath || process.cwd();
    const { runPreflightGate } = await import('../budget/preflight.js');
    const gate = runPreflightGate({
      agent: agentType,
      model: model ?? `${agentType}-default`,
      mode: resolvedMode,
      prompt,
      project: gateCwd,
      cwd: gateCwd,
    });
    if (!gate.dormant && !gate.decision.allow) {
      throw new Error(`[budget] BLOCKED teammate "${taskName}" (${agentType}): ${gate.decision.reason}`);
    }
  }

  const agent = await manager.spawn(
    taskName,
    agentType,
    prompt,
    cwd,
    resolvedMode,
    resolvedEffort,
    parentSessionId,
    workspaceDir,
    version,
    name,
    after,
    model,
    envOverrides,
    taskType,
    cloudProvider,
    cloudSessionId,
    cloudRepo,
    cloudBranch,
    worktreeName,
    worktreePath,
    profileName,
    hostName,
    hostTarget,
    repoPath,
    project,
    account,
  );

  debug(`[spawn] Spawned ${agentType} agent ${agent.agentId} for task "${taskName}"`);

  return {
    task_name: taskName,
    agent_id: agent.agentId,
    agent_type: agent.agentType,
    status: agent.status,
    started_at: agent.startedAt.toISOString(),
    version: agent.version,
    profile_name: agent.profileName,
    account: agent.account,
    remote_session_id: agent.remoteSessionId,
    name: agent.name,
    after: agent.after,
    task_type: agent.taskType,
    cloud_provider: agent.cloudProvider,
    cloud_session_id: agent.cloudSessionId,
    host: agent.hostName,
  };
}

/** Retrieve the current status of all teammates in a task, with optional timestamp-based delta filtering. */
export async function handleStatus(
  manager: AgentManager,
  taskName: string | null | undefined,
  filter?: string,
  since?: string,  // Optional ISO timestamp - return only events after this time
  parentSessionId?: string | null
): Promise<TaskStatusResult> {
  // Default to 'all' so callers see completed/failed agents unless they opt to filter
  const effectiveFilter = filter || 'all';
  const normalizedTaskName = taskName?.trim() || '';
  const normalizedParentSessionId = parentSessionId?.trim() || '';

  if (!normalizedTaskName && !normalizedParentSessionId) {
    throw new Error('task_name is required when parent_session_id is not provided');
  }

  const lookupLabel = normalizedParentSessionId && !normalizedTaskName
    ? `parent_session_id "${normalizedParentSessionId}"`
    : `task "${normalizedTaskName}"`;

  debug(`[status] Getting status for agents in ${lookupLabel} (filter=${effectiveFilter})...`);

  const allAgents = normalizedParentSessionId && !normalizedTaskName
    ? await manager.listByParentSession(normalizedParentSessionId)
    : await manager.listByTask(normalizedTaskName);

  // Filter agents by status ('all' shows everything)
  const agents = effectiveFilter === 'all'
    ? allAgents
    : allAgents.filter((a) => a.status === effectiveFilter);

  const agentStatuses: AgentStatusDetail[] = [];
  const counts = { pending: 0, running: 0, completed: 0, stranded: 0, failed: 0, stopped: 0 };

  // Count ALL agents for summary (not just filtered)
  for (const agent of allAgents) {
    if (agent.status === AgentStatus.PENDING) counts.pending++;
    else if (agent.status === AgentStatus.RUNNING) counts.running++;
    else if (agent.status === AgentStatus.COMPLETED) counts.completed++;
    else if (agent.status === AgentStatus.FAILED) counts.failed++;
    else if (agent.status === AgentStatus.STOPPED) counts.stopped++;
  }

  // Stranded count is computed over ALL agents, not the filter-narrowed view,
  // so a `--filter running` status still reports teammates that completed dirty.
  // Cache the probe result so we can reuse it when building details for the
  // filtered subset without probing the worktree twice.
  const uncommittedCache = new Map<string, boolean>();
  for (const agent of allAgents) {
    if (agent.status !== AgentStatus.COMPLETED) continue;
    const shouldProbeWorktree =
      !agent.prUrl?.trim() &&
      !agent.hostName &&
      Boolean(agent.workspaceDir);
    const hasUncommitted = shouldProbeWorktree
      ? await hasUncommittedChanges(agent.workspaceDir!)
      : false;
    uncommittedCache.set(agent.agentId, hasUncommitted);

    const delivery = resolveTeammateDelivery({
      status: agent.status,
      prUrl: agent.prUrl,
      hasUncommittedChanges: hasUncommitted,
    });
    if (delivery === 'stranded') {
      counts.stranded++;
    }
  }

  // Build details only for filtered agents
  let maxTimestamp = since || new Date(0).toISOString();  // Track max timestamp for cursor
  const claudeLabels = allAgents.some((agent) => agent.agentType === 'claude')
    ? buildClaudeLabelMap()
    : new Map<string, string | null>();

  for (const agent of agents) {
    await agent.readNewEvents();
    const events = agent.events;

    // Use getDelta to filter events by timestamp (or get all if no since)
    const delta = getDelta(
      agent.agentId,
      agent.agentType,
      agent.status,
      events,
      since
    );

    // Find latest timestamp from this agent's events
    const latestEvent = events[events.length - 1];
    const agentTimestamp = latestEvent?.timestamp || new Date().toISOString();
    if (agentTimestamp > maxTimestamp) {
      maxTimestamp = agentTimestamp;
    }

    const hasUncommitted = uncommittedCache.get(agent.agentId) ?? false;

    const delivery = resolveTeammateDelivery({
      status: agent.status,
      prUrl: agent.prUrl,
      hasUncommittedChanges: hasUncommitted,
    });

    const detail: AgentStatusDetail = {
      agent_id: agent.agentId,
      agent_type: agent.agentType,
      status: agent.status,
      prompt: agent.prompt,
      started_at: agent.startedAt.toISOString(),
      completed_at: agent.completedAt?.toISOString() ?? null,
      duration: agent.duration(),
      version: agent.version,
      remote_session_id: agent.remoteSessionId,
      session_label: agent.remoteSessionId
        ? claudeLabels.get(agent.remoteSessionId) ?? null
        : null,
      name: agent.name,
      after: agent.after,
      task_type: agent.taskType,
      host: agent.hostName,
      workspace_dir: agent.workspaceDir,
      failure: agent.failure,
      mode: agent.mode,
      cloud_session_id: agent.cloudSessionId,
      cloud_provider: agent.cloudProvider,
      pr_url: agent.prUrl,
      delivery,
      files_created: delta.new_files_created,
      files_modified: delta.new_files_modified,
      files_read: delta.new_files_read,
      files_deleted: delta.new_files_deleted,
      bash_commands: delta.new_bash_commands.map((cmd: string) => truncateBashCommand(cmd)),
      recent_tool_calls: recentToolCalls(events),
      last_messages: delta.new_messages,
      tool_count: delta.new_tool_count,
      has_errors: delta.new_errors.length > 0,
      cursor: agentTimestamp,
    };

    agentStatuses.push(detail);
  }

  debug(`[status] ${lookupLabel}: returning ${agents.length}/${allAgents.length} agents (running=${counts.running}, completed=${counts.completed}, failed=${counts.failed}, stopped=${counts.stopped})`);

  return {
    task_name: normalizedTaskName,
    agents: agentStatuses,
    summary: counts,
    cursor: maxTimestamp,  // Max timestamp across all agents
  };
}

/** List all known tasks grouped by task name, sorted by most recent activity. */
export async function handleTasks(
  manager: AgentManager,
  limit: number = 10
): Promise<TasksResult> {
  debug(`[tasks] Listing tasks (limit=${limit})...`);

  const allAgents = await manager.listAll();

  // Group agents by taskName
  const taskMap = new Map<string, typeof allAgents>();
  for (const agent of allAgents) {
    const existing = taskMap.get(agent.taskName) || [];
    existing.push(agent);
    taskMap.set(agent.taskName, existing);
  }

  const tasks: TaskInfo[] = [];

  for (const [taskName, agents] of taskMap) {
    let pending = 0, running = 0, completed = 0, stranded = 0, failed = 0, stopped = 0;
    let earliestStart: Date | null = null;
    let latestActivity: Date | null = null;
    let workspaceDir: string | null = null;

    for (const agent of agents) {
      // Count by status
      if (agent.status === AgentStatus.PENDING) pending++;
      else if (agent.status === AgentStatus.RUNNING) running++;
      else if (agent.status === AgentStatus.COMPLETED) completed++;
      else if (agent.status === AgentStatus.FAILED) failed++;
      else if (agent.status === AgentStatus.STOPPED) stopped++;

      // Stranded = completed, no PR, local worktree still dirty. Probes the real
      // worktree so `teams tasks` and `teams list --status` don't classify lost
      // work as done (PHNX-2951).
      if (agent.status === AgentStatus.COMPLETED && !agent.prUrl?.trim() && !agent.hostName && agent.workspaceDir) {
        const delivery = resolveTeammateDelivery({
          status: agent.status,
          prUrl: agent.prUrl,
          hasUncommittedChanges: await hasUncommittedChanges(agent.workspaceDir),
        });
        if (delivery === 'stranded') {
          stranded++;
        }
      }

      // Track earliest start (created_at)
      if (!earliestStart || agent.startedAt < earliestStart) {
        earliestStart = agent.startedAt;
      }

      // Track latest activity (modified_at)
      // For running agents, use current time; for others use completedAt or startedAt
      const activityTime = agent.status === AgentStatus.RUNNING
        ? new Date()
        : (agent.completedAt || agent.startedAt);
      if (!latestActivity || activityTime > latestActivity) {
        latestActivity = activityTime;
      }

      // Use first non-null workspaceDir found
      if (!workspaceDir && agent.workspaceDir) {
        workspaceDir = agent.workspaceDir;
      }
    }

    tasks.push({
      task_name: taskName,
      agent_count: agents.length,
      pending,
      running,
      completed,
      stranded,
      failed,
      stopped,
      workspace_dir: workspaceDir,
      created_at: earliestStart?.toISOString() || new Date().toISOString(),
      modified_at: latestActivity?.toISOString() || new Date().toISOString(),
    });
  }

  // Sort by modified_at descending (most recent first)
  tasks.sort((a, b) => new Date(b.modified_at).getTime() - new Date(a.modified_at).getTime());

  // Apply limit
  const limitedTasks = tasks.slice(0, limit);

  debug(`[tasks] Returning ${limitedTasks.length}/${tasks.length} tasks`);

  return { tasks: limitedTasks };
}

/** Stop a specific teammate or all teammates in a task. */
export async function handleStop(
  manager: AgentManager,
  taskName: string,
  agentId?: string
): Promise<StopResult | { error: string }> {
  if (agentId) {
    debug(`[stop] Stopping agent ${agentId} in task "${taskName}"...`);

    const agent = await manager.get(agentId);
    if (!agent) {
      debug(`[stop] Agent ${agentId} not found`);
      return {
        task_name: taskName,
        stopped: [],
        already_stopped: [],
        not_found: [agentId],
      };
    }
    if (agent.taskName !== taskName) {
      debug(`[stop] Agent ${agentId} not in task ${taskName}`);
      return { error: `Agent ${agentId} not in task ${taskName}` };
    }

    if (agent.status === AgentStatus.RUNNING) {
      const success = await manager.stop(agentId);
      debug(`[stop] Agent ${agentId}: ${success ? 'stopped' : 'failed to stop'}`);
      return {
        task_name: taskName,
        stopped: success ? [agentId] : [],
        already_stopped: success ? [] : [agentId],
        not_found: [],
      };
    } else {
      debug(`[stop] Agent ${agentId} already stopped (status=${agent.status})`);
      return {
        task_name: taskName,
        stopped: [],
        already_stopped: [agentId],
        not_found: [],
      };
    }
  } else {
    debug(`[stop] Stopping all agents in task "${taskName}"...`);

    const result = await manager.stopByTask(taskName);

    debug(`[stop] Task "${taskName}": stopped ${result.stopped.length}, already_stopped ${result.alreadyStopped.length}`);

    return {
      task_name: taskName,
      stopped: result.stopped,
      already_stopped: result.alreadyStopped,
      not_found: [],
    };
  }
}
