import { parseAgentVersionSpec } from '../lib/agent-spec/agents.js';
/**
 * Team management commands for organizing multi-agent collaboration.
 *
 * Implements `agents teams` -- create named teams, add teammates (background
 * agent processes), check status with session-aware previews, manage DAG
 * dependencies between teammates, and clean up when work is done.
 */
import type { Command } from 'commander';
import chalk from 'chalk';
import { die, dieFriction, relTime, truncate, isJsonMode, padRight } from '../lib/format.js';
import * as fs from 'fs/promises';
import { addHostOption } from '../lib/hosts/option.js';
import * as path from 'path';
import {
  AgentManager,
  AgentStatus,
  checkCliSignedIn,
  collectTeamsDoctorData,
  getAgentsDir,
  VALID_TASK_TYPES,
  withTeammatePrPolicy,
  type AgentType,
  type TaskType,
  type TeamsDoctorEntry,
} from '../lib/teams/agents.js';
import { mailboxDir, enqueue } from '../lib/mailbox.js';
import { resolveProvider } from '../lib/cloud/registry.js';
import type { CloudProviderId, DispatchOptions } from '../lib/cloud/types.js';
import { emit } from '../lib/feed/events.js';
import { maybeShowStarNudge } from '../lib/star-nudge.js';
import { shareRuntimeEnv } from '../lib/share/config.js';
import { runSupervisor } from '../lib/teams/supervisor.js';
import { debug } from '../lib/teams/debug.js';
import {
  runPrWatch,
  DEFAULT_MAX_WAVES,
  type WatchTarget,
  type PrWatchSpawnAction,
  type PrWatchEvent,
} from '../lib/teams/pr-watch.js';
import {
  handleSpawn,
  handleStatus,
  handleStop,
  handleTasks,
  toTaskStatusSummary,
  type AgentStatusDetail,
  type AgentStatusSummary,
  type TaskInfo,
} from '../lib/teams/api.js';
import {
  resolveTeammateDelivery,
  deliveryDisplayLabel,
  deliveryColorKey,
  type TeammateDelivery,
} from '../lib/teams/delivery.js';
import {
  createTeam,
  ensureTeam,
  getTeam,
  loadTeams,
  removeTeam,
  teamExists,
} from '../lib/teams/registry.js';
import { setHelpSections } from '../lib/help.js';
import {
  createWorktree,
  commitsBehindDefault,
  isGitRepo,
  hasUncommittedChanges,
  removeWorktree,
  worktreeCheckoutExists,
  worktreeExists,
} from '../lib/teams/worktree.js';
import { resolveHost } from '../lib/hosts/registry.js';
import {
  isDeviceInteractive,
  resolveInteractiveDevice,
  interactiveUnsetError,
} from '../lib/devices/interactive-host.js';
import { isDeviceAuto, resolveDeviceAuto } from '../lib/smart-launch.js';
import { sshTargetFor } from '../lib/hosts/types.js';
import { ensureHostReady } from '../lib/hosts/ready.js';
import { remoteShellFor } from '../lib/hosts/remote-cmd.js';
import { resolveRemoteOsSync } from '../lib/hosts/remote-os.js';
import { remoteWorktreeDirty, removeRemoteWorktree, ensureRemoteRepo, remoteCommitsBehindDefault } from '../lib/teams/remoteWorktree.js';
import { getRemoteUrl } from '../lib/git.js';
import { machineId } from '../lib/session/sync/config.js';
import { isVersionInstalled, resolveVersion, resolveVersionAlias, resolveVersionAliasLoose } from '../lib/installations/versions.js';
import { AGENTS, warnAgentDeprecated } from '../lib/agents.js';
import type { AgentId } from '../lib/types.js';
import { discoverSessions, parseTimeFilter, resolveSessionById } from '../lib/session/discover.js';
import { renderSessionLog } from './sessions.js';
import type { SessionMeta } from '../lib/session/types.js';
import { buildPreview as buildSessionPreview } from './sessions-picker.js';
import { parseExecEnv } from '../lib/exec.js';
import { checkRunAccountReadiness, type AccountReadiness } from '../lib/accounting/rotate.js';
import { teamPicker, printTeamTable, type TeamRow } from './teams-picker.js';
import { teamSpawners, type TeamSpawner } from '../lib/session/db.js';
import { itemPicker } from '../lib/picker.js';
import type { AgentProcess } from '../lib/teams/agents.js';
import { profileExists, readProfile } from '../lib/profiles.js';
import {
  isPromptCancelled,
  isInteractiveTerminal,
  requireDestructiveArg,
  requireInteractiveSelection,
} from './utils.js';

const AGENT_NAMES: Record<AgentType, string> = {
  claude: 'Claude',
  codex: 'Codex',
  gemini: 'Gemini',
  cursor: 'Cursor',
  opencode: 'OpenCode',
  grok: 'Grok',
  antigravity: 'Antigravity',
  kimi: 'Kimi',
  droid: 'Droid',
  warp: 'Warp',
};

const VALID_AGENTS: AgentType[] = ['claude', 'codex', 'cursor', 'opencode', 'grok', 'antigravity', 'kimi', 'droid', 'warp'];
// 'full' kept as historical alias for 'skip'; normalized to 'skip' downstream.
const VALID_MODES = ['plan', 'edit', 'auto', 'skip', 'full'] as const;
const VALID_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max', 'auto'] as const;
const VALID_CLOUD_PROVIDERS = ['rush', 'codex', 'factory'] as const satisfies readonly CloudProviderId[];

type Mode = (typeof VALID_MODES)[number];
type Effort = (typeof VALID_EFFORTS)[number];
type TeamRegistry = Record<string, { created_at: string; description?: string }>;

export interface TeamListAgentSnapshot {
  agent_id: string;
  task_name: string;
  agent_type: string;
  status: string;
  prompt: string;
  started_at: string;
  completed_at: string | null;
  workspace_dir: string | null;
  version: string | null;
  remote_session_id: string | null;
  name: string | null;
  after: string[];
  task_type: TaskType | null;
  host: string | null;
  mode: string | null;
  cloud_session_id: string | null;
  cloud_provider: string | null;
  pr_url: string | null;
}

function statusColor(status: string): (s: string) => string {
  switch (status) {
    case 'pending': return chalk.blue;
    case 'running': return chalk.yellow;
    case 'completed': return chalk.green;
    case 'pr_open': return chalk.magenta; // RUSH-2380: process done, PR not merged
    case 'stranded': return chalk.yellow; // PHNX-2951: done but work not committed
    case 'failed': return chalk.red;
    case 'stopped': return chalk.gray;
    default: return chalk.white;
  }
}

function compactPrompt(s: string, n = 160): string {
  return truncate(s.replace(/\s+/g, ' ').trim(), n);
}

function formatTimestamp(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

function normalizeTeamListStatus(status: unknown): AgentStatus {
  if (Object.values(AgentStatus).includes(status as AgentStatus)) {
    return status as AgentStatus;
  }
  return AgentStatus.RUNNING;
}

function parseTimestamp(value: string | null | undefined): Date | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function durationFromSnapshot(agent: TeamListAgentSnapshot): string | null {
  const startedAt = parseTimestamp(agent.started_at);
  if (!startedAt) return null;
  const completedAt = parseTimestamp(agent.completed_at);
  let seconds: number;
  if (completedAt) {
    seconds = (completedAt.getTime() - startedAt.getTime()) / 1000;
  } else if (normalizeTeamListStatus(agent.status) === AgentStatus.RUNNING) {
    seconds = (Date.now() - startedAt.getTime()) / 1000;
  } else {
    return null;
  }
  if (seconds < 60) return `${Math.max(0, Math.floor(seconds))} seconds`;
  return `${Math.max(0, seconds / 60).toFixed(1)} minutes`;
}

function snapshotActivityTime(agent: TeamListAgentSnapshot): Date {
  const status = normalizeTeamListStatus(agent.status);
  if (status === AgentStatus.RUNNING) return new Date();
  return parseTimestamp(agent.completed_at) || parseTimestamp(agent.started_at) || new Date(0);
}

function snapshotToStatusDetail(agent: TeamListAgentSnapshot): AgentStatusDetail {
  return {
    agent_id: agent.agent_id,
    agent_type: agent.agent_type,
    status: normalizeTeamListStatus(agent.status),
    prompt: agent.prompt,
    started_at: parseTimestamp(agent.started_at)?.toISOString() || new Date(0).toISOString(),
    completed_at: parseTimestamp(agent.completed_at)?.toISOString() || null,
    duration: durationFromSnapshot(agent),
    files_created: [],
    files_modified: [],
    files_read: [],
    files_deleted: [],
    bash_commands: [],
    recent_tool_calls: [],
    last_messages: [],
    tool_count: 0,
    has_errors: false,
    cursor: snapshotActivityTime(agent).toISOString(),
    mode: agent.mode ?? undefined,
    cloud_session_id: agent.cloud_session_id,
    cloud_provider: agent.cloud_provider,
    pr_url: agent.pr_url,
    version: agent.version,
    remote_session_id: agent.remote_session_id,
    session_label: null,
    name: agent.name,
    after: agent.after,
    task_type: agent.task_type,
    host: agent.host,
    workspace_dir: agent.workspace_dir,
  };
}


function fullName(type: AgentType, version: string | null | undefined): string {
  const name = AGENT_NAMES[type];
  return version ? `${name} ${version}` : name;
}

/**
 * One-line operator nudge after `teams start`: teammates are briefed to post
 * IMPORTANT milestones to the feed (RUSH-2250), and this is how to watch them.
 * Print-only — no engine behavior.
 */
export function printFeedHint(team: string): void {
  console.log(
    chalk.gray('Tip: teammates post IMPORTANT milestones to the feed (') +
    chalk.cyan('agents feed timeline') +
    chalk.gray('); watch team progress with ') +
    chalk.cyan(`agents teams status ${team}`) +
    chalk.gray('.'),
  );
}

/**
 * Resolve a teammate spec to its execution target.
 *
 * Accepts:
 *  - `claude`            — default version of an installed agent
 *  - `claude@2.1.112`    — pinned version of an installed agent
 *  - `<profile-name>`    — runs through `agents run <profile>`, with the
 *                          profile's host agent used as the underlying
 *                          AgentType for event parsing and CLI checks.
 *
 * `agent` is always the underlying harness so event parsers, CLI-availability
 * checks, and version pins keep working. `profileName` is set only when the
 * spec resolved through a profile.
 */
export function parseTeammate(spec: string): {
  agent: AgentType;
  version: string | null;
  profileName: string | null;
  account: string | null;
} {
  const parsed = parseAgentVersionSpec(spec);
  const name = 'error' in parsed ? spec : parsed.agent;
  const version = 'error' in parsed ? undefined : parsed.version;

  if (VALID_AGENTS.includes(name as AgentType)) {
    const agent = name as AgentType;
    return {
      agent,
      version: version ?? null,
      profileName: null,
      account: 'error' in parsed ? null : parsed.label ?? null,
    };
  }

  // Not a built-in agent id — try resolving as a profile name. A profile
  // pinning a version is allowed; `profile@<override>` is not (would conflict
  // with the profile's own host.version).
  if (!version && profileExists(name)) {
    try {
      const profile = readProfile(name);
      return {
        agent: profile.host.agent as AgentType,
        version: profile.host.version ?? null,
        profileName: profile.name,
        account: null,
      };
    } catch (err) {
      dieFriction('teams', 'profile-malformed', `Profile '${name}' is malformed: ${(err as Error).message}`);
    }
  }

  dieFriction(
    'teams',
    'unknown-teammate',
    `Unknown teammate '${spec}'. Available agents: ${VALID_AGENTS.join(', ')}.\n` +
      `  Use 'claude', 'kimi@latest', 'kimi@0.19.2' (a version from 'agents view'), or a profile name.`
  );
}

function shortId(id: string): string {
  return id.slice(0, 8);
}

/** Where `teams message`/`teams resume` routes a follow-up, by teammate status. */
export type TeamMessageRoute =
  | { kind: 'steer' }        // running -> mailbox, delivered at next tool call
  | { kind: 'resume' }       // stopped/completed/failed -> re-enter its session
  | { kind: 'need-message' } // actionable, but no message was supplied
  | { kind: 'not-started' }; // pending --after deps, never launched

/**
 * Decide how a follow-up to a teammate is delivered from its reconciled status.
 * Pure — the source of truth for the routing table, unit-tested without I/O.
 *   - pending                       -> not-started (tell them to `teams start`)
 *   - running     + message         -> steer (mailbox)
 *   - stopped/etc + message         -> resume (re-enter session)
 *   - any actionable + no message   -> need-message
 */
export function decideTeamMessageRoute(status: AgentStatus, hasMessage: boolean): TeamMessageRoute {
  if (status === AgentStatus.PENDING) return { kind: 'not-started' };
  if (!hasMessage) return { kind: 'need-message' };
  if (status === AgentStatus.RUNNING) return { kind: 'steer' };
  return { kind: 'resume' };
}

/**
 * Preamble injected into every factory worker's prompt. Tells the worker
 * which team + teammate name + task-type it is, and how to file new tasks.
 * The actual how-to lives in the /factory-worker skill.
 */
function factoryWorkerPreamble(
  team: string,
  name: string | null,
  taskType: TaskType,
  after: string[]
): string {
  const n = name ?? '<anonymous>';
  const deps = after.length > 0 ? after.join(', ') : '(none)';
  return [
    `FACTORY WORKER — team="${team}", name="${n}", task_type="${taskType}", after=${deps}`,
    `You are a teammate in a Software Factory. Read the /factory-worker skill for the full pattern.`,
    `Key rules:`,
    ` - Other teammates may be running now. Coordinate via git and tests only — no direct peer communication.`,
    ` - If you discover work beyond your task, file a new teammate via Bash:`,
    `     agents teams add "${team}" claude "<ask>" --name <slug> --task-type <implement|test|review|bugfix|docs> [--after <dep>]`,
    `   A background supervisor picks up new tasks every wave.`,
    ``,
    `YOUR TASK:`,
  ].join('\n');
}

function mkManager(): AgentManager {
  return new AgentManager();
}

/**
 * Tell the user a worktree from a failed `teams add` is still on disk, and give
 * them the exact commands to remove it. Reached only when we could not remove it
 * ourselves — a leftover `agents/<name>` branch is what makes the retry fail with
 * `fatal: a branch ... already exists`, so it must never be silent (RUSH-2356).
 */
/**
 * Tear down a worktree a failed operation left behind — but ONLY if it is a
 * genuine orphan.
 *
 * Extracted because this guard was hand-duplicated at two call sites (`teams
 * add` and the pr-watch fixer) and the copy at the fixer path was written
 * WITHOUT it, which is RUSH-2356 reoccurring at the one site that skipped the
 * check. One implementation, one place to get it right.
 *
 * The two errors here are not symmetric, so the guard deliberately fails
 * CLOSED: a spurious "claimed" strands a branch a human can delete, while a
 * spurious "unclaimed" runs `git worktree remove --force` over a live
 * teammate's checkout and destroys uncommitted work. So an unreadable record
 * means "leave it alone and tell the user", never "assume it is free".
 *
 * A staged teammate is exactly the case that makes this necessary: `spawn()`
 * persists its meta.json and only THEN runs the retention pass, which refreshes
 * every sibling and can throw on a distributed one — so a failure can land here
 * with a live, durably-recorded, merely-pending `--after` teammate already
 * owning this worktree.
 */
export async function tearDownOrphanWorktree(
  mgr: AgentManager,
  baseCwd: string,
  name: string,
): Promise<void> {
  try {
    if (await mgr.isWorktreeClaimed(name)) return;
  } catch {
    warnOrphanWorktree(baseCwd, name, 'the teammate record could not be read');
    return;
  }

  try {
    await removeWorktree(baseCwd, name);
  } catch (cleanupErr) {
    warnOrphanWorktree(baseCwd, name, (cleanupErr as Error).message);
  }
}

function warnOrphanWorktree(baseCwd: string, name: string, reason: string): void {
  process.stderr.write(
    chalk.yellow(
      `\nWarning: the worktree '${name}' from this failed add is still on disk — ${reason}.\n` +
        `  Remove it manually: git -C ${baseCwd} worktree remove --force .agents/worktrees/${name} ` +
        `&& git -C ${baseCwd} branch -D agents/${name}\n`,
    ),
  );
}

/** Pluralize a commit count: "1 commit" / "3 commits". */
function commitsWord(behind: number): string {
  return `${behind} commit${behind === 1 ? '' : 's'}`;
}

/**
 * The blocking message when `teams add` is pointed at a stale checkout. Pure so
 * the guidance is pinned by tests (mirrors `remoteCwdOnAddError`): it MUST name
 * how far behind, tell the caller to sync with remote main, and mention `--confirm`
 * as the override.
 */
export function staleRepoError(params: {
  team: string;
  where: string;
  behind: number;
  base: string;
  sync: string;
}): string {
  return (
    `${params.where} is ${commitsWord(params.behind)} behind origin/${params.base}. ` +
    `A team started here would build on stale code — bring it up to date with remote main first:\n` +
    `  ${params.sync}\n` +
    `Then re-run \`agents teams add ${params.team} …\`, or pass --confirm to start on the stale repo anyway.`
  );
}

/**
 * Guard against pointing a team at a stale checkout. Before a teammate is bound
 * to a repo, this fetches origin and counts how far behind `origin/<default>` the
 * base checkout is (the local cwd, or the repo provisioned on a `--device` host).
 * If it is behind and the caller did NOT pass `--confirm`, the add is refused with
 * {@link staleRepoError} — because a team started on stale code reasons and builds
 * against a tree that has already moved on (the 71-commit-stale s1 checkout
 * incident). With `--confirm` it prints a one-line advisory and proceeds.
 *
 * A `null` behind-count (offline, non-repo, unreachable host) is "can't tell" and
 * never blocks — this is a freshness nudge, not a hard prerequisite.
 */
async function assertRepoFreshOrConfirm(params: {
  team: string;
  confirm: boolean;
  json: boolean;
  local?: string;
  remote?: { target: string; repoPath: string; host: string; extraSshArgs: string[] };
}): Promise<void> {
  const { team, confirm, json } = params;
  const res = params.remote
    ? remoteCommitsBehindDefault(params.remote.target, params.remote.repoPath, {
        extraSshArgs: params.remote.extraSshArgs,
      })
    : params.local
      ? await commitsBehindDefault(params.local)
      : null;
  if (!res || res.behind <= 0) return;

  const where = params.remote
    ? `The repo on ${params.remote.host} (${params.remote.repoPath})`
    : `This checkout (${params.local})`;
  const sync = params.remote
    ? `agents ssh ${params.remote.host} 'git -C ${params.remote.repoPath} merge --ff-only origin/${res.base}'`
    : `git -C ${params.local} merge --ff-only origin/${res.base}`;

  if (confirm) {
    process.stderr.write(
      chalk.yellow(`⚠ ${where} is ${commitsWord(res.behind)} behind origin/${res.base}; starting anyway (--confirm).\n`),
    );
    return;
  }

  dieFriction('teams', 'repo-stale', staleRepoError({ team, where, behind: res.behind, base: res.base, sync }), 1, { json });
}

/**
 * Register the generic cloud dispatcher — staged cloud teammates get
 * dispatched when their --after deps resolve, using repo/branch stored on
 * the teammate itself so we don't need the original --cloud CLI args.
 */
export function wireCloudDispatcher(mgr: AgentManager): void {
  mgr.setCloudDispatcher(async (a) => {
    if (!a.cloudProvider) {
      throw new Error(`Teammate ${a.agentId} has no cloud provider set`);
    }
    const prov = resolveProvider(a.cloudProvider as CloudProviderId);
    const dispatchOpts = cloudDispatchOptions(a);
    const cloudTask = await prov.dispatch(dispatchOpts);
    return { cloudSessionId: cloudTask.id };
  });
}

export function cloudDispatchOptions(
  agent: Pick<AgentProcess, 'prompt' | 'agentType' | 'cloudRepo' | 'cloudBranch' | 'model' | 'mode'>,
): DispatchOptions {
  return {
    // PHNX-3236: a cloud teammate runs in the provider sandbox and never inherits
    // the local merge-guard.sh hook, so the prompt policy is its ONLY self-merge
    // boundary — apply the same helper buildRunArgv uses for local/remote.
    prompt: withTeammatePrPolicy(agent.prompt, agent.mode),
    agent: agent.agentType,
    repo: agent.cloudRepo ?? undefined,
    branch: agent.cloudBranch ?? undefined,
    model: agent.model ?? undefined,
    env: shareRuntimeEnv(),
  };
}

/**
 * Advisory: warn once per agent type of any still-pending (staged `--after`)
 * teammate whose CLI may not be signed in. Warn-only — never blocks `start`.
 * Local teammates only; cloud teammates authenticate through their provider.
 */
/**
 * Advisory line for a version-pinned teammate whose account can't serve a run
 * right now. A pinned target (`agents run <agent>@<version>`) bypasses account
 * rotation — the pin IS the target — so unlike a bare teammate it can't route
 * around a throttled/expired account; it will launch and likely 429 at once.
 */
function throttleWarningLine(
  agent: AgentType,
  version: string,
  r: Extract<AccountReadiness, { ready: false }>,
): string {
  const who = `${AGENT_NAMES[agent]} ${version}`;
  const acct = r.email ? ` (${r.email})` : '';
  const reason =
    r.reason === 'out_of_credits' ? 'is out of credits'
    : r.reason === 'signed_out' ? 'is not signed in'
    : r.reason === 'revoked' ? 'needs re-login (its token was revoked)'
    : 'is rate-limited right now';
  return (
    chalk.yellow(`⚠ ${who}${acct} ${reason}.`) +
    chalk.gray(
      `\n  A pinned version skips account rotation, so it will launch on this account and may immediately hit its limit.` +
      `\n  Use a bare \`${agent}\` teammate to let the team pick a healthy account, or pass --force to silence this.`,
    )
  );
}

/**
 * Advisory: for each staged VERSION-PINNED teammate, warn if its account is
 * rate-limited / out of credits / signed out right now — reusing the router's
 * own eligibility signal (`checkRunAccountReadiness`) so the warning matches
 * what the spawn would actually do. Bare teammates (rotation handles them) and
 * profile/cloud teammates (account not locally checkable) are skipped. Warns,
 * never blocks. Deduped by agent@version so N teammates on one account warn once.
 */
async function warnThrottledTeammates(mgr: AgentManager, team: string): Promise<void> {
  let pending;
  try {
    pending = (await mgr.listByTask(team)).filter(
      (a) => a.status === 'pending' && !a.cloudProvider && !a.profileName && a.version,
    );
  } catch {
    return; // team not loadable yet — nothing to warn about
  }
  const seen = new Set<string>();
  for (const a of pending) {
    const agent = a.agentType as AgentType;
    const version = a.version as string;
    const key = `${agent}@${version}`;
    if (seen.has(key) || !AGENT_NAMES[agent]) continue;
    seen.add(key);
    const readiness = await checkRunAccountReadiness(agent, version);
    if (!readiness.ready) console.error(throttleWarningLine(agent, version, readiness));
  }
}

async function warnUnsignedTeammates(mgr: AgentManager, team: string): Promise<void> {
  let pending;
  try {
    pending = (await mgr.listByTask(team)).filter((a) => a.status === 'pending' && !a.cloudProvider);
  } catch {
    return; // team not loadable yet — nothing to warn about
  }
  const seen = new Set<AgentType>();
  for (const a of pending) {
    const agent = a.agentType as AgentType;
    if (seen.has(agent) || !AGENT_NAMES[agent]) continue;
    seen.add(agent);
    if (!(await checkCliSignedIn(agent))) {
      console.error(
        chalk.yellow(`⚠ ${AGENT_NAMES[agent]} may not be signed in (detection is unreliable). Launching anyway.`) +
          chalk.gray(`\n  If it fails to start, run \`${AGENTS[agent].cliCommand}\` to log in, or pass --force to silence this.`)
      );
    }
  }
}

/**
 * Single-wave start used by `teams start` without --watch. startReady()
 * terminalizes a placement/spawn/cloud/dependency failure to FAILED with
 * evidence rather than leaving it PENDING, so a teammate that failed this wave
 * appears in neither `launched` nor `still_pending` — it must be diffed against
 * the pre-wave roster and reported explicitly, or the wave reads as a success.
 * A wave that only produced failures sets a non-zero exit code.
 */
export async function runOneWave(mgr: AgentManager, team: string, json: boolean): Promise<void> {
  const preWavePending = new Set(
    (await mgr.listByTask(team)).filter((a) => a.status === 'pending').map((a) => a.agentId)
  );
  const launched = await mgr.startReady(team);
  const all = await mgr.listByTask(team);
  const stillPending = all.filter((a) => a.status === 'pending');
  const failed = all.filter((a) => a.status === 'failed' && preWavePending.has(a.agentId));
  if (failed.length > 0 && launched.length === 0) process.exitCode = 1;

  if (json) {
    console.log(
      JSON.stringify({
        team,
        launched: launched.map((a) => ({ agent_id: a.agentId, name: a.name, after: a.after })),
        still_pending: stillPending.map((a) => ({ agent_id: a.agentId, name: a.name, after: a.after })),
        failed: failed.map((a) => ({ agent_id: a.agentId, name: a.name, after: a.after, failure: a.failure })),
      }, null, 2)
    );
    return;
  }

  if (launched.length === 0 && stillPending.length === 0 && failed.length === 0) {
    console.log(chalk.gray(`No pending teammates in team ${team}.`));
    return;
  }

  if (launched.length > 0) {
    console.log(chalk.green(`Launched ${launched.length} teammate(s) in team ${chalk.cyan(team)}:`));
    for (const a of launched) {
      const who = fullName(a.agentType as AgentType, a.version);
      const h = a.name || shortId(a.agentId);
      console.log(`  ${chalk.cyan(h)}  ${who}`);
    }
  }
  if (failed.length > 0) {
    if (launched.length > 0) console.log();
    console.log(chalk.red(`Failed this wave (${failed.length}):`));
    for (const a of failed) {
      const h = a.name || shortId(a.agentId);
      const why = a.failure ? `${a.failure.code}: ${a.failure.message}` : 'no failure evidence recorded';
      console.log(`  ${chalk.red(h)}  ${why}`);
    }
  }
  if (stillPending.length > 0) {
    console.log();
    console.log(chalk.gray(`Still pending (${stillPending.length}):`));
    for (const a of stillPending) {
      const h = a.name || shortId(a.agentId);
      console.log(`  ${chalk.blue(h)}  ${chalk.gray('after')} ${a.after.join(', ')}`);
    }
  }
  if (launched.length > 0) printFeedHint(team);
}

/**
 * Path to the pr-watch dedupe-state file for a team. Persists the set of
 * already-handled check/comment dedupe keys so a restart of `teams pr-watch`
 * never re-spawns a fix wave for a failure it already reacted to. Lives in the
 * teammate base dir; it's a flat file so loadExistingAgents (dir-only) skips it.
 */
async function prWatchStatePath(team: string): Promise<string> {
  const safe = team.replace(/[^A-Za-z0-9_-]/g, '_');
  return path.join(await getAgentsDir(), `pr-watch-${safe}.json`);
}

interface PrWatchState {
  handled: Set<string>;
  waves: Map<string, number>;
}

async function loadPrWatchState(team: string): Promise<PrWatchState> {
  try {
    const raw = await fs.readFile(await prWatchStatePath(team), 'utf-8');
    const parsed = JSON.parse(raw);
    const handled = new Set(Array.isArray(parsed?.handled) ? (parsed.handled as string[]) : []);
    const waves = new Map<string, number>(
      parsed?.waves && typeof parsed.waves === 'object'
        ? Object.entries(parsed.waves as Record<string, number>).map(([k, v]) => [k, Number(v) || 0])
        : []
    );
    return { handled, waves };
  } catch {
    return { handled: new Set(), waves: new Map() };
  }
}

async function savePrWatchState(team: string, state: PrWatchState): Promise<void> {
  try {
    await fs.writeFile(
      await prWatchStatePath(team),
      JSON.stringify(
        { handled: [...state.handled], waves: Object.fromEntries(state.waves) },
        null,
        2
      )
    );
  } catch (err) {
    debug(`Could not persist pr-watch state for ${team}: ${(err as Error).message}`);
  }
}

/**
 * Resolve the PRs opened by a team's teammates, de-duplicated by PR URL. A
 * teammate's PR URL comes from its own `pr_url` field or, failing that, the
 * session it ran (detected from the transcript's `gh pr create`). The teammate
 * name is the `--after` anchor for the fix/bugfix teammate we spawn.
 */
async function resolvePrWatchTargets(mgr: AgentManager, team: string): Promise<WatchTarget[]> {
  const status = await handleStatus(mgr, team, 'all');
  const sessions = await resolveTeammateSessions(status.agents);
  const byPr = new Map<string, WatchTarget>();
  for (const a of status.agents) {
    const prUrl = a.pr_url || sessions.get(a.agent_id)?.prUrl || null;
    if (!prUrl) continue;
    if (byPr.has(prUrl)) continue; // first teammate to own a PR is its source
    byPr.set(prUrl, { prUrl, sourceTeammate: a.name ?? null });
  }
  return [...byPr.values()];
}

/**
 * React to one decided pr-watch action by spawning a follow-up teammate on the
 * same PR — a ci-fix teammate on RED CI, or a `bugfix` teammate on a new review
 * comment — linked `--after` the teammate that opened the PR so it slots into
 * the same DAG the supervisor already drains. Returns the teammate label.
 */
async function reactWithTeammate(
  mgr: AgentManager,
  team: string,
  action: PrWatchSpawnAction,
  prompt: string,
): Promise<string | null> {
  // Unique name per reaction. The dedupe key is stable across waves (keyed on the
  // check NAME), so the wave number is what keeps successive fixers' names — and
  // their worktrees — distinct within the team.
  const uniq = action.dedupeKey.replace(/[^A-Za-z0-9]/g, '').slice(-10) || `${action.wave}`;
  const slug = `${uniq}-w${action.wave}`;
  const name = action.kind === 'ci-fix' ? `cifix-${slug}` : `bugfix-${slug}`;
  const taskType: TaskType | null = action.kind === 'review-fix' ? 'bugfix' : null;
  // Link --after the source teammate when it's a real, resolvable sibling; a
  // missing source means the PR couldn't be traced to a named teammate, so the
  // fix runs immediately with no dependency edge.
  const after: string[] = [];
  if (action.sourceTeammate) {
    const resolved = await mgr.resolveAgentIdInTask(team, action.sourceTeammate);
    if (resolved.kind === 'ok') after.push(action.sourceTeammate);
  }
  // Isolate each fixer in its own worktree so concurrent `gh pr checkout`s (across
  // PRs, or across waves) never clash in a shared cwd. Requires a git repo — which
  // pr-watch always is, since it operates on PRs; fall back to the cwd only when
  // the checkout somehow isn't a repo.
  const baseCwd = process.cwd();
  let worktreeName: string | null = null;
  let worktreePath: string | null = null;
  let cwd = baseCwd;
  if (await isGitRepo(baseCwd)) {
    try {
      worktreeName = `prwatch-${name}`;
      worktreePath = await createWorktree(baseCwd, worktreeName);
      cwd = worktreePath;
    } catch (err) {
      debug(`pr-watch: could not create worktree for ${name}: ${(err as Error).message}`);
      worktreeName = null;
      worktreePath = null;
      cwd = baseCwd;
    }
  }
  let result;
  try {
    result = await handleSpawn(
      mgr,
      team,
      'claude',
      prompt,
      cwd,
      'edit',
      'medium',
      null,
      cwd,
      null,
      name,
      after,
      null,
      null,
      taskType,
      null,
      null,
      null,
      null,
      worktreeName,
      worktreePath,
      null, // profileName
      null, // hostName
      null, // hostTarget
      null, // repoPath
      // A pr-watch fixer belongs to the same team, so it gets the same project
      // grants as any other teammate. Wiring `--project` into only the
      // `teams add` caller would have left this one silently without them.
      (await getTeam(team))?.project ?? null,
    );
  } catch (err) {
    // The spawn failed after we created this fixer's worktree — tear it down so
    // the branch `agents/<name>` doesn't block the next wave's retry with
    // `fatal: a branch ... already exists` (RUSH-2356). Best-effort; the
    // original failure is what propagates.
    //
    // Guarded exactly like the `teams add` teardown, and for the same reason:
    // handleSpawn -> manager.spawn() persists a staged teammate's meta.json and
    // only THEN runs the retention pass, which refreshes every sibling and can
    // throw on a distributed one. A fixer teammate is staged with `--after` when
    // it follows a source teammate, so a throw there lands here with a LIVE,
    // durably-recorded, merely-pending teammate already owning this worktree —
    // and removing it would destroy real work. Only tear down a genuine orphan.
    if (worktreeName) await tearDownOrphanWorktree(mgr, baseCwd, worktreeName);
    throw err;
  }
  return result.name ?? shortId(result.agent_id);
}

// Pick the display handle for a teammate: explicit teammate name, Claude
// session label, then the 8-char UUID prefix.
function handle(a: { name?: string | null; session_label?: string | null; agent_id: string }): string {
  return a.name || a.session_label || shortId(a.agent_id);
}

function displayHandle(a: AgentStatusDetail): string {
  if (a.name && a.session_label && a.name !== a.session_label) {
    return `${a.name} / ${a.session_label}`;
  }
  return handle(a);
}

type TeammateLookup =
  | { kind: 'ok'; agentId: string }
  | { kind: 'none' }
  | { kind: 'ambiguous'; candidates: { team: string; agentId: string; display: string }[] };

// Resolve a teammate reference (name / UUID / UUID prefix) by scanning every
// meta.json under the agents dir. Team hint narrows the search.
async function resolveTeammateAcrossTeams(
  base: string,
  ref: string,
  teamHint?: string
): Promise<TeammateLookup> {
  let entries: string[] = [];
  try {
    entries = await fs.readdir(base);
  } catch {
    return { kind: 'none' };
  }

  // Cheap path: exact UUID or unique UUID prefix match by directory name.
  const byDir = entries.filter((e) => e === ref || e.startsWith(ref));
  if (byDir.length === 1 && byDir[0] === ref) {
    return { kind: 'ok', agentId: ref };
  }

  // Otherwise scan meta.json files to match on name as well, and respect the
  // team hint if given.
  const candidates: { team: string; agentId: string; display: string; name: string | null }[] = [];
  for (const dir of entries) {
    try {
      const meta = JSON.parse(
        await fs.readFile(path.join(base, dir, 'meta.json'), 'utf-8')
      );
      if (teamHint && meta.task_name !== teamHint) continue;
      const matchesName = meta.name && meta.name === ref;
      const matchesPrefix = dir.startsWith(ref);
      if (matchesName || matchesPrefix) {
        candidates.push({
          team: meta.task_name || '(none)',
          agentId: dir,
          display: meta.name || shortId(dir),
          name: meta.name || null,
        });
      }
    } catch {
      /* skip entries without readable meta.json */
    }
  }

  if (candidates.length === 0) return { kind: 'none' };
  if (candidates.length === 1) return { kind: 'ok', agentId: candidates[0].agentId };

  // If multiple match but one is an exact name hit, prefer it.
  const exactName = candidates.filter((c) => c.name === ref);
  if (exactName.length === 1) return { kind: 'ok', agentId: exactName[0].agentId };

  return { kind: 'ambiguous', candidates };
}

// Print a teammate block using the same session preview the sessions picker
// uses — one canonical renderer across `agents sessions`, teams picker
// preview, and teams status output.
//
// Layout:
//   alice  claude  COMPLETED · 5.0 minutes
//     after: bob
//     <buildSessionPreview output>    (when the session file was found)
//     ! reported an error             (if flagged)
//     PR: <url>                       (if set)
function printAgentDetail(a: AgentStatusDetail, session: SessionMeta | null): void {
  // RUSH-2380: process COMPLETED + open PR → show PR OPEN, not COMPLETED.
  const delivery: TeammateDelivery =
    (a.delivery as TeammateDelivery | undefined) ??
    resolveTeammateDelivery({ status: a.status, prUrl: a.pr_url });
  const colorKey = deliveryColorKey(delivery, a.status);
  const label = statusColor(colorKey)(deliveryDisplayLabel(delivery, a.status));
  const who = fullName(a.agent_type as AgentType, a.version);
  const h = displayHandle(a);
  const secondary = a.name ? chalk.gray(`(${shortId(a.agent_id)})`) : '';
  const duration = a.duration ? `${chalk.gray(' · ')}${chalk.white(a.duration)}` : '';
  console.log(
    `  ${chalk.cyan(h.padEnd(10))} ${secondary.padEnd(11)} ${who.padEnd(18)} ${label}${duration}`
  );

  if (a.task_type) {
    console.log(`    ${chalk.gray('type    ')} ${chalk.magenta(a.task_type)}`);
  }
  if (a.prompt) {
    console.log(`    ${chalk.gray('task    ')} ${chalk.white(compactPrompt(a.prompt))}`);
  }
  const started = formatTimestamp(a.started_at);
  const completed = formatTimestamp(a.completed_at);
  if (started || completed) {
    const parts = [];
    if (started) parts.push(`started ${started}`);
    if (completed) parts.push(`ended ${completed}`);
    console.log(`    ${chalk.gray('time    ')} ${parts.join(chalk.gray(' · '))}`);
  }
  if (a.after && a.after.length) {
    console.log(`    ${chalk.gray('after   ')} ${a.after.join(', ')}`);
  }
  if (a.host) {
    console.log(`    ${chalk.gray('host    ')} ${chalk.cyan(a.host)}`);
  }
  if (a.failure) {
    console.log(`    ${chalk.red('failure ')} ${a.failure.code}: ${a.failure.message}`);
  }
  // If the agent's internal session id differs from ours (non-Claude), show
  // it as a hint for `agents sessions <id>`.
  if (a.remote_session_id && a.remote_session_id !== a.agent_id) {
    console.log(`    ${chalk.gray('session ')} ${chalk.gray(a.remote_session_id)}`);
  }

  if (session) {
    // Hand off to the same renderer the sessions picker uses. Indent so the
    // block visually belongs to this teammate.
    const preview = buildSessionPreview(session);
    for (const line of preview.split('\n')) {
      console.log(line ? `    ${line}` : '');
    }
  } else {
    // Session file not yet on disk (e.g. teammate is pending, or their
    // agent type writes sessions elsewhere). Fall back to a compact summary
    // derived from the live status payload.
    const activity: string[] = [];
    if (a.files_modified.length) activity.push(`${a.files_modified.length} modified`);
    if (a.files_created.length)  activity.push(`${a.files_created.length} created`);
    if (a.files_read.length)     activity.push(`${a.files_read.length} read`);
    if (a.tool_count)            activity.push(`${a.tool_count} tools`);
    if (activity.length) {
      console.log(`    ${chalk.gray(activity.join(' · '))}`);
    }
    const lastMsg = a.last_messages[a.last_messages.length - 1];
    if (lastMsg) {
      const firstLine = lastMsg.split(/\r?\n/).find((l) => l.trim()) || '';
      if (firstLine) console.log(`    ${chalk.gray('> ' + truncate(firstLine, 96))}`);
    }
  }

  if (a.recent_tool_calls.length) {
    console.log(`    ${chalk.gray('tools   ')}`);
    for (const call of a.recent_tool_calls.slice(-5)) {
      const when = call.timestamp ? `${relTime(call.timestamp)} ` : '';
      console.log(`      ${chalk.gray(when)}${chalk.bold(call.tool)} ${chalk.gray(truncate(call.summary, 96))}`);
    }
  }
  if (a.has_errors) console.log(`    ${chalk.red('! reported an error')}`);
  if (delivery === 'stranded' && a.workspace_dir) {
    console.log(`    ${chalk.yellow('! stranded')} uncommitted work at ${a.workspace_dir}`);
  }
  if (a.pr_url) console.log(`    ${chalk.gray('PR  ')}${a.pr_url}`);
}

// Resolve each live teammate to its on-disk session (Claude/Codex/Gemini/
// OpenCode all write parseable session files). `agent_id === remote_session_id`
// for Claude teammates; non-Claude agents may carry their own session UUID on
// `remote_session_id`. We try both.
async function resolveTeammateSessions(
  agents: AgentStatusDetail[]
): Promise<Map<string, SessionMeta | null>> {
  const map = new Map<string, SessionMeta | null>();
  if (agents.length === 0) return map;
  // Scan every project dir — team teammates may have run from anywhere.
  const all = await discoverSessions({ all: true, limit: 5000 });
  for (const a of agents) {
    const candidates = [a.remote_session_id, a.agent_id].filter(Boolean) as string[];
    let found: SessionMeta | null = null;
    for (const id of candidates) {
      const hits = resolveSessionById(all, id);
      if (hits.length) { found = hits[0]; break; }
    }
    map.set(a.agent_id, found);
  }
  return map;
}

// Default compact renderer — one block per teammate, optimized for the
// orchestrator scanning "what state, what did you touch, what did you say
// last." Caller passes the projected AgentStatusSummary; for the full
// verbose layout use printAgentDetail above.
function printAgentSummary(s: AgentStatusSummary): void {
  const delivery: TeammateDelivery =
    (s.delivery as TeammateDelivery | undefined) ??
    resolveTeammateDelivery({ status: s.status, prUrl: s.pr_url });
  const colorKey = deliveryColorKey(delivery, s.status);
  const label = statusColor(colorKey)(deliveryDisplayLabel(delivery, s.status));
  const handle = s.name ?? shortId(s.agent_id);
  const ident = s.name ? chalk.gray(`(${shortId(s.agent_id)})`) : '';
  const duration = s.duration ? `${chalk.gray(' · ')}${chalk.white(s.duration)}` : '';
  const errBadge = s.has_errors ? chalk.red(' !') : '';
  const tools = chalk.gray(` · ${s.tool_count} tools`);
  const hostBadge = s.host ? chalk.gray(' · on ') + chalk.cyan(s.host) : '';
  console.log(
    `  ${chalk.cyan(handle.padEnd(14))} ${ident.padEnd(11)} ${label}${duration}${tools}${hostBadge}${errBadge}`
  );
  if (s.failure) {
    console.log(`    ${chalk.red('failure ')} ${s.failure.code}: ${s.failure.message}`);
  }

  // Files: counts + basenames. Read is count only.
  const fileLines: string[] = [];
  const renderCat = (label: string, cat: { count: number; names: string[] }) => {
    if (cat.count === 0) return;
    const more = cat.count > cat.names.length ? ` +${cat.count - cat.names.length}` : '';
    const names = cat.names.length ? ` ${cat.names.join(', ')}${more}` : '';
    fileLines.push(`${label} ${cat.count}${names}`);
  };
  renderCat('modified', s.files.modified);
  renderCat('created',  s.files.created);
  renderCat('deleted',  s.files.deleted);
  if (s.files.read.count > 0) fileLines.push(`read ${s.files.read.count}`);
  if (fileLines.length) {
    console.log(`    ${chalk.gray('files   ')} ${fileLines.join(chalk.gray(' · '))}`);
  }

  // Last 3 bash commands.
  const recentBash = s.bash_commands.slice(-3);
  if (recentBash.length) {
    console.log(`    ${chalk.gray('bash    ')}`);
    for (const cmd of recentBash) {
      console.log(`      ${chalk.gray('$')} ${truncate(cmd, 96)}`);
    }
  }

  // Last messages — first non-empty line of each, truncated.
  if (s.last_messages.length) {
    console.log(`    ${chalk.gray('messages')}`);
    for (const msg of s.last_messages) {
      const firstLine = msg.split(/\r?\n/).find((l) => l.trim()) || '';
      if (firstLine) console.log(`      ${chalk.gray('>')} ${truncate(firstLine, 96)}`);
    }
  }

  if (delivery === 'stranded' && s.workspace_dir) {
    console.log(`    ${chalk.yellow('! stranded')} uncommitted work at ${s.workspace_dir}`);
  }
  if (s.pr_url) console.log(`    ${chalk.gray('PR      ')} ${chalk.cyan(s.pr_url)}`);
}

function formatTeamStatusSummary(
  summary: { pending: number; running: number; completed: number; stranded: number; failed: number; stopped: number }
): string {
  const done = Math.max(0, summary.completed - summary.stranded);
  const parts: string[] = [];
  if (summary.pending > 0) parts.push(`${summary.pending} pending`);
  if (summary.running > 0 || parts.length === 0) parts.push(`${summary.running} working`);
  if (done > 0 || summary.stranded === 0) parts.push(`${done} done`);
  if (summary.stranded > 0) parts.push(`${summary.stranded} stranded`);
  if (summary.failed > 0 || parts.length === 0) parts.push(`${summary.failed} failed`);
  if (summary.stopped > 0 || parts.length === 0) parts.push(`${summary.stopped} stopped`);
  return `(${parts.join(', ')})`;
}

// Render a team's status in the same format the `status` subcommand uses, so
// the interactive picker's Enter action drops the user into a familiar view.
async function printTeamStatus(team: string, result: import('../lib/teams/api.js').TaskStatusResult): Promise<void> {
  const { summary, agents } = result;
  console.log(
    chalk.bold(`Team ${chalk.cyan(team)}  `) + chalk.gray(formatTeamStatusSummary(summary))
  );
  if (agents.length === 0) {
    console.log(chalk.gray('  (no teammates yet — add one with `agents teams add`)'));
  } else {
    const sessions = await resolveTeammateSessions(agents);
    const width = Math.min(process.stdout.columns || 80, 80);
    const divider = chalk.gray('┈'.repeat(width));
    for (let i = 0; i < agents.length; i++) {
      console.log();
      if (i > 0) {
        console.log(divider);
        console.log();
      }
      printAgentDetail(agents[i], sessions.get(agents[i].agent_id) ?? null);
    }
  }
  console.log();
  console.log(chalk.gray(`cursor: ${result.cursor}`));
}

// Compact default renderer — no session-file dive, no per-teammate
// 15-line preview. One block per teammate, suitable for the orchestrator
// scanning what each agent did. Use `printTeamStatus` (above) for the
// verbose/legacy layout.
function printTeamSummary(
  team: string,
  result: import('../lib/teams/api.js').TaskStatusSummaryResult
): void {
  const { summary, agents } = result;
  console.log(
    chalk.bold(`Team ${chalk.cyan(team)}  `) + chalk.gray(formatTeamStatusSummary(summary))
  );
  if (agents.length === 0) {
    console.log(chalk.gray('  (no teammates yet — add one with `agents teams add`)'));
  } else {
    const width = Math.min(process.stdout.columns || 80, 80);
    const divider = chalk.gray('┈'.repeat(width));
    for (let i = 0; i < agents.length; i++) {
      console.log();
      if (i > 0) {
        console.log(divider);
        console.log();
      }
      printAgentSummary(agents[i]);
    }
  }
  console.log();
  console.log(chalk.gray(`cursor: ${result.cursor}`));
  console.log(chalk.gray('Full detail: agents teams status ' + team + ' --verbose'));
  console.log(chalk.gray('Raw log:     agents teams logs --team ' + team + ' --teammate <name>'));
}

// Classify a team into a single bucket for --status filtering.
//  - empty:    no teammates (created but nobody added yet)
//  - waiting:  only staged teammates — call `teams start` to kick them off
//  - working:  at least one teammate still running
//  - failed:   at least one teammate failed or was stopped (any failure wins —
//              even if others finished, you want to know about the failure)
//  - stranded: everyone finished, but at least one has uncommitted work and no PR
//  - done:     everyone finished successfully, no failures, no stranded work
function classifyTeamStatus(t: TaskInfo): 'empty' | 'waiting' | 'working' | 'stranded' | 'done' | 'failed' {
  if (t.agent_count === 0) return 'empty';
  if (t.running > 0) return 'working';
  if (t.failed + t.stopped > 0) return 'failed';
  // At this point nobody is running/failed/stopped. If there's any pending
  // teammate (agent_count > running+completed+failed+stopped), it's "waiting".
  const accounted = t.running + t.completed + t.failed + t.stopped;
  if (accounted < t.agent_count) return 'waiting';
  // Completed-without-delivery is not "done": the work is still in the worktree
  // and will be lost on cleanup (PHNX-2951).
  if ((t.stranded ?? 0) > 0) return 'stranded';
  return 'done';
}

// Merge persistent team registry with tasks derived from live agents so empty
// teams (created but no teammates yet) still show up.
function mergeTeams(
  registry: TeamRegistry,
  tasks: TaskInfo[]
): TaskInfo[] {
  const byName = new Map<string, TaskInfo>();
  for (const t of tasks) byName.set(t.task_name, t);
  for (const [name, meta] of Object.entries(registry)) {
    if (!byName.has(name)) {
      byName.set(name, {
        task_name: name,
        agent_count: 0,
        pending: 0,
        running: 0,
        completed: 0,
        stranded: 0,
        failed: 0,
        stopped: 0,
        workspace_dir: null,
        created_at: meta.created_at,
        modified_at: meta.created_at,
      });
    }
  }
  return Array.from(byName.values()).sort(
    (a, b) => new Date(b.modified_at).getTime() - new Date(a.modified_at).getTime()
  );
}

async function buildTasksFromSnapshots(agents: TeamListAgentSnapshot[]): Promise<TaskInfo[]> {
  const byTeam = new Map<string, TeamListAgentSnapshot[]>();
  for (const agent of agents) {
    const teamAgents = byTeam.get(agent.task_name) || [];
    teamAgents.push(agent);
    byTeam.set(agent.task_name, teamAgents);
  }

  const tasks: TaskInfo[] = [];
  for (const [taskName, teamAgents] of byTeam) {
    let pending = 0;
    let running = 0;
    let completed = 0;
    let stranded = 0;
    let failed = 0;
    let stopped = 0;
    let earliestStart: Date | null = null;
    let latestActivity: Date | null = null;
    let workspaceDir: string | null = null;

    for (const agent of teamAgents) {
      const status = normalizeTeamListStatus(agent.status);
      if (status === AgentStatus.PENDING) pending++;
      else if (status === AgentStatus.RUNNING) running++;
      else if (status === AgentStatus.COMPLETED) completed++;
      else if (status === AgentStatus.FAILED) failed++;
      else if (status === AgentStatus.STOPPED) stopped++;

      // Stranded = completed with no PR and a dirty local worktree (PHNX-2951).
      if (
        status === AgentStatus.COMPLETED &&
        !agent.pr_url?.trim() &&
        !agent.host &&
        agent.workspace_dir
      ) {
        const dirty = await hasUncommittedChanges(agent.workspace_dir);
        if (dirty) {
          stranded++;
        }
      }

      const startedAt = parseTimestamp(agent.started_at);
      if (startedAt && (!earliestStart || startedAt < earliestStart)) {
        earliestStart = startedAt;
      }

      const activity = snapshotActivityTime(agent);
      if (!latestActivity || activity > latestActivity) {
        latestActivity = activity;
      }

      if (!workspaceDir && agent.workspace_dir) {
        workspaceDir = agent.workspace_dir;
      }
    }

    const fallback = new Date(0);
    tasks.push({
      task_name: taskName,
      agent_count: teamAgents.length,
      pending,
      running,
      completed,
      stranded,
      failed,
      stopped,
      workspace_dir: workspaceDir,
      created_at: (earliestStart || fallback).toISOString(),
      modified_at: (latestActivity || earliestStart || fallback).toISOString(),
    });
  }

  return tasks.sort((a, b) => new Date(b.modified_at).getTime() - new Date(a.modified_at).getTime());
}

export async function buildTeamRowsFromSnapshots(
  registry: TeamRegistry,
  agents: TeamListAgentSnapshot[],
  /** team name -> the session that spawned it (see teamSpawners). */
  spawners?: Map<string, TeamSpawner>
): Promise<{ rows: TeamRow[]; teams: TaskInfo[]; names: string[] }> {
  const byTeam = new Map<string, AgentStatusDetail[]>();
  for (const agent of agents) {
    const details = byTeam.get(agent.task_name) || [];
    details.push(snapshotToStatusDetail(agent));
    byTeam.set(agent.task_name, details);
  }

  const teams = mergeTeams(registry, await buildTasksFromSnapshots(agents));

  // Recompute delivery for cached snapshots so `teams list` reflects stranded
  // work discovered by probing the real worktree (PHNX-2951).
  for (const details of byTeam.values()) {
    for (const a of details) {
      const snapshot = agents.find((s) => s.agent_id === a.agent_id);
      if (
        snapshot &&
        normalizeTeamListStatus(a.status) === AgentStatus.COMPLETED &&
        !snapshot.pr_url?.trim() &&
        !snapshot.host &&
        snapshot.workspace_dir
      ) {
        const dirty = await hasUncommittedChanges(snapshot.workspace_dir);
        a.delivery = resolveTeammateDelivery({
          status: a.status,
          prUrl: snapshot.pr_url,
          hasUncommittedChanges: dirty,
        });
      }
    }
  }

  return {
    teams,
    rows: teams.map((team) => ({
      team,
      agents: byTeam.get(team.task_name) || [],
      description: registry[team.task_name]?.description,
      spawnedBy: spawners?.get(team.task_name)?.shortId,
    })),
    names: teams.map((team) => team.task_name),
  };
}

function snapshotFromMeta(meta: any): TeamListAgentSnapshot | null {
  if (!meta || typeof meta !== 'object') return null;
  const agentId = typeof meta.agent_id === 'string' ? meta.agent_id : '';
  const taskName = typeof meta.task_name === 'string' ? meta.task_name : '';
  const agentType = typeof meta.agent_type === 'string' ? meta.agent_type : '';
  if (!agentId || !taskName || !agentType) return null;
  return {
    agent_id: agentId,
    task_name: taskName,
    agent_type: agentType,
    status: normalizeTeamListStatus(meta.status),
    prompt: typeof meta.prompt === 'string' ? meta.prompt : '',
    started_at: parseTimestamp(meta.started_at)?.toISOString() || new Date(0).toISOString(),
    completed_at: parseTimestamp(meta.completed_at)?.toISOString() || null,
    workspace_dir: typeof meta.workspace_dir === 'string' ? meta.workspace_dir : null,
    version: typeof meta.version === 'string' ? meta.version : null,
    remote_session_id: typeof meta.remote_session_id === 'string' ? meta.remote_session_id : null,
    name: typeof meta.name === 'string' ? meta.name : null,
    after: Array.isArray(meta.after) ? meta.after.filter((name: unknown): name is string => typeof name === 'string') : [],
    task_type: typeof meta.task_type === 'string' && (VALID_TASK_TYPES as readonly string[]).includes(meta.task_type)
      ? meta.task_type as TaskType
      : null,
    host: typeof meta.host_name === 'string' ? meta.host_name : null,
    mode: typeof meta.mode === 'string' ? meta.mode : null,
    cloud_session_id: typeof meta.cloud_session_id === 'string' ? meta.cloud_session_id : null,
    cloud_provider: typeof meta.cloud_provider === 'string' ? meta.cloud_provider : null,
    pr_url: typeof meta.pr_url === 'string' ? meta.pr_url : null,
  };
}

async function loadTeamAgentSnapshots(): Promise<TeamListAgentSnapshot[]> {
  const agentsDir = await getAgentsDir();
  const entries = await fs.readdir(agentsDir).catch(() => []);
  const snapshots = await Promise.all(entries.map(async (entry) => {
    const metaPath = path.join(agentsDir, entry, 'meta.json');
    try {
      const raw = await fs.readFile(metaPath, 'utf-8');
      return snapshotFromMeta(JSON.parse(raw));
    } catch {
      return null;
    }
  }));
  return snapshots.filter((snapshot): snapshot is TeamListAgentSnapshot => snapshot !== null);
}

// Build cached rows for the `list` picker. Shared between `list` and picker
// fallbacks for `status` / `start`; full status stays lazy until a team is picked.
async function loadTeamRows(
  _mgr: AgentManager
): Promise<{ rows: TeamRow[]; names: string[] }> {
  const [registry, agents] = await Promise.all([loadTeams(), loadTeamAgentSnapshots()]);
  // Lineage is read off the session index, not the team registry: the registry is
  // per-machine runtime state, while the transcript that ran `teams create` is
  // indexed, survives the teammate cleanup, and covers teams created before this.
  let spawners: Map<string, TeamSpawner> | undefined;
  try {
    spawners = teamSpawners();
  } catch {
    // The index is an enrichment here — a missing/locked DB just drops the column.
  }
  return await buildTeamRowsFromSnapshots(registry, agents, spawners);
}

// Picker fallback for `teams logs` when the teammate ref is omitted. Shows a
// flat list of every teammate with their team context; Enter picks one.
async function pickTeammateOr(
  mgr: AgentManager,
  command: string
): Promise<{ agentId: string; team: string } | null> {
  if (!isInteractiveTerminal()) {
    requireInteractiveSelection(`Picking a teammate for \`${command}\``, [
      `${command} <teammate>`,
      `agents teams list  # to see teammates per team`,
    ]);
  }
  const all = await mgr.listAll();
  if (all.length === 0) {
    console.log(chalk.gray('No teammates on any team yet.'));
    console.log(chalk.gray('  Add one with:  agents teams add <team> <agent> <task>'));
    return null;
  }
  const nameW = Math.max(8, ...all.map((a) => (a.name || shortId(a.agentId)).length));
  const teamW = Math.max(6, ...all.map((a) => a.taskName.length));
  try {
    const picked = await itemPicker<AgentProcess>({
      message: 'Select a teammate:',
      items: all,
      filter: (query) => {
        const q = query.trim().toLowerCase();
        if (!q) return all;
        return all.filter((a) => {
          const hay = [a.name ?? '', a.agentId, a.taskName, a.agentType, a.status].join(' ').toLowerCase();
          return hay.includes(q);
        });
      },
      labelFor: (a) => {
        const h = (a.name || shortId(a.agentId)).padEnd(nameW);
        const team = a.taskName.padEnd(teamW);
        const who = fullName(a.agentType as AgentType, a.version);
        return `${chalk.cyan(h)}  ${chalk.gray(team)}  ${who}  ${statusColor(a.status)(a.status)}`;
      },
      shortIdFor: (a) => a.name || shortId(a.agentId),
      pageSize: 10,
      emptyMessage: 'No teammates match.',
      enterHint: 'view log',
    });
    if (!picked) return null;
    return { agentId: picked.item.agentId, team: picked.item.taskName };
  } catch (err) {
    if (isPromptCancelled(err)) return null;
    throw err;
  }
}

// Fallback for read-only / constructive subcommands when the user omits the
// team argument. In a TTY, show the picker and return the chosen team. Outside
// a TTY, hard-fail with a clear error so scripts surface the missing arg.
async function pickTeamOr(
  mgr: AgentManager,
  command: string
): Promise<string | null> {
  if (!isInteractiveTerminal()) {
    requireInteractiveSelection(`Picking a team for \`${command}\``, [
      `${command} <team>`,
      `agents teams list  # to see your teams`,
    ]);
  }
  const { rows } = await loadTeamRows(mgr);
  if (rows.length === 0) {
    console.log(chalk.gray("You haven't started any teams yet."));
    console.log(chalk.gray('  Start one with:  agents teams create <name>'));
    return null;
  }
  try {
    const picked = await teamPicker(rows);
    return picked?.team ?? null;
  } catch (err) {
    if (isPromptCancelled(err)) return null;
    throw err;
  }
}

/**
 * `teams add --remote-cwd` is a no-op trap. `--remote-cwd` comes from the shared
 * `--device` option family (option.ts) and is meaningful for commands that *route*
 * to a host, but `teams add` special-cases `--device`/`--device` as PLACEMENT, so
 * the flag is never read — a teammate's directory is the team's repo plus its
 * `--worktree`, not a path passed here. Silently ignoring it misleads you into
 * thinking it set the teammate's repo path (the exact wrong model that turns one
 * team into a teardown-and-rebuild). Reject with guidance instead. Exported for
 * the unit test that pins the message.
 */
export function remoteCwdOnAddError(team: string): string {
  return (
    `--remote-cwd has no effect on 'teams add' — it does not set a teammate's repo or directory.\n` +
    `  A teammate works in the team's repo plus its own --worktree:\n` +
    `    • Set the repo once, on the team:  agents teams create ${team} --repo <url|path>\n` +
    `    • Place the teammate on a machine: agents teams add ${team} <agent> "<task>" --device <host> --worktree <name>\n` +
    `  (Remote worktrees fork from the host's freshly-fetched origin/<default> automatically.)`
  );
}

/** Register the `agents teams` command tree (list, create, add, status, start, remove, disband, logs, doctor). */
export function registerTeamsCommands(program: Command): void {
  const teams = program
    .command('teams')
    .description('Organize AI coding agents into teams that work in parallel on a shared task.');

  setHelpSections(teams, {
    examples: `
      # Create a team for a coordinated task
      agents teams create pricing-page

      # Add a teammate — name them so you can refer to them later
      agents teams add pricing-page claude "Rewrite /v2/pricing endpoint" --name backend

      # Parallel work — frontend stubs API while backend lands
      agents teams add pricing-page codex "Build /pricing route with three-tier layout" --name frontend

      # DAG dependency — QA waits for backend AND frontend to finish
      agents teams add pricing-page claude "Run Playwright suite, fix flakes" --name qa --after backend,frontend

      # Start everyone (respects --after dependencies) and watch live
      agents teams start pricing-page --watch

      # Delta-poll status without rereading everything
      agents teams status pricing-page --since 2026-04-24T09:00:00-07:00

      # Nudge a teammate that stopped with more to do — resumes its own session
      agents teams resume pricing-page backend "Review's in — rebase-merge the PR, then release"

      # Steer a still-running teammate mid-flight (delivered at its next tool call)
      agents teams message pricing-page qa "Skip the flaky screenshot test for now"

      # Wind everyone down when shipped
      agents teams disband pricing-page
    `,
    notes: `
      A team is a named group of agents working in the background on a shared task.
      Teammate sessions show in 'agents sessions --teams' tagged [team/name · mode].

      Teammate syntax:
        'claude'           the default Claude version on this machine
        'claude@2.1.112'   a specific installed version (see 'agents view')
        '<profile>'        a profile from 'agents view' — runs through 'agents
                           run <profile>' with the profile's host harness

      Placement & repos (the part people get wrong):
        --remote-cwd does NOT place a teammate or set its repo — it is ignored on
        'teams add' (and rejected, so you find out immediately). A teammate's
        directory is the team's repo plus its --worktree:
          --device <host>     run THIS teammate on <host>
          create --repo <r>   ONE repo for the whole team (defaults to this
                              checkout's origin). Work spanning repos → one team
                              per repo — don't build a cross-repo team then rebuild.
        With --enable-worktrees each teammate gets its own worktree + branch:
          local teammate      forks from your CURRENT local HEAD — no fetch, so
                              pull/sync the checkout first or it forks stale
          remote (--device)   forks from the freshly-fetched origin/<default> on
                              the host (no manual sync needed)

      Short aliases:
        teams c  = create    teams a  = add       teams s  = status
        teams rm = remove    teams d  = disband   teams ls = list
    `,
  });

  // list
  addHostOption(teams.command('list [query]'))
    .alias('ls')
    .description('List your teams, most recent activity first')
    .option('-a, --agent <agent>', 'Filter: only teams with this agent (e.g. claude or claude@2.1.112)')
    .option('--status <status>', 'Filter: only teams with this status (working, done, stranded, failed, or empty)')
    .option('--since <time>', 'Filter: teams active after this time (e.g. "2h", "7d", or ISO date)')
    .option('--until <time>', 'Filter: teams active before this time (e.g. "30d", or ISO date)')
    .option('-n, --limit <n>', 'Show at most this many teams (default: 20)', '20')
    .option('--json', 'Output machine-readable JSON instead of formatted table')
    .action(async (query: string | undefined, opts: {
      agent?: string; status?: string; since?: string; until?: string;
      limit: string; json?: boolean;
    }) => {
      const limit = Math.max(1, parseInt(opts.limit, 10) || 20);
      const [registry, everyAgent] = await Promise.all([
        loadTeams(),
        loadTeamAgentSnapshots(),
      ]);

      // Group agents by team so we can filter on agent-type / version.
      const byTeam = new Map<string, TeamListAgentSnapshot[]>();
      for (const a of everyAgent) {
        const arr = byTeam.get(a.task_name) || [];
        arr.push(a);
        byTeam.set(a.task_name, arr);
      }

      // Same lineage enrichment as loadTeamRows — without it this listing is the
      // one `teams list` surface that silently drops the "spawned by" column.
      let spawners: Map<string, TeamSpawner> | undefined;
      try {
        spawners = teamSpawners();
      } catch {
        // The session index is an enrichment here; a missing one drops the column.
      }
      let rows = (await buildTeamRowsFromSnapshots(registry, everyAgent, spawners)).rows;

      // --- query: substring match on team name ---
      if (query) {
        const q = query.toLowerCase();
        rows = rows.filter((row) => row.team.task_name.toLowerCase().includes(q));
      }

      // --- --agent: filter teams containing a matching teammate ---
      if (opts.agent) {
        const [wantType, rawVersion] = opts.agent.split('@');
        const wantVersion = VALID_AGENTS.includes(wantType as AgentType)
          ? resolveVersionAliasLoose(wantType as AgentId, rawVersion)
          : rawVersion;
        rows = rows.filter((row) => {
          const teammates = byTeam.get(row.team.task_name) || [];
          return teammates.some(
            (m) => m.agent_type === wantType && (!wantVersion || m.version === wantVersion)
          );
        });
      }

      // --- --status: classify each team, filter ---
      if (opts.status) {
        const want = opts.status.toLowerCase();
        const validStatuses = ['working', 'done', 'stranded', 'failed', 'empty'];
        if (!validStatuses.includes(want)) {
          dieFriction('teams', 'invalid-status-filter', `Invalid --status '${opts.status}'. Use one of: ${validStatuses.join(', ')}`);
        }
        rows = rows.filter((row) => classifyTeamStatus(row.team) === want);
      }

      // --- --since / --until: filter by activity window ---
      if (opts.since) {
        const cutoff = parseTimeFilter(opts.since);
        if (!cutoff) dieFriction('teams', 'invalid-since-filter', `Could not parse --since '${opts.since}'`);
        rows = rows.filter((row) => new Date(row.team.modified_at).getTime() >= cutoff);
      }
      if (opts.until) {
        const cutoff = parseTimeFilter(opts.until);
        if (!cutoff) dieFriction('teams', 'invalid-until-filter', `Could not parse --until '${opts.until}'`);
        rows = rows.filter((row) => new Date(row.team.modified_at).getTime() <= cutoff);
      }

      rows = rows.slice(0, limit);

      if (isJsonMode(opts)) {
        console.log(JSON.stringify({ teams: rows.map((row) => row.team) }, null, 2));
        return;
      }

      if (rows.length === 0) {
        if (query || opts.agent || opts.status || opts.since || opts.until) {
          console.log(chalk.gray('No teams match those filters.'));
        } else {
          console.log(chalk.gray("You haven't started any teams yet."));
          console.log(chalk.gray('  Start one with:  agents teams create <name>'));
        }
        return;
      }

      if (isInteractiveTerminal()) {
        try {
          const picked = await teamPicker(rows, query);
          if (picked) {
            // Fall through to the status subcommand's action for the picked team.
            const mgr = mkManager();
            const result = await handleStatus(mgr, picked.team, 'all');
            await printTeamStatus(picked.team, result);
          }
        } catch (err) {
          if (!isPromptCancelled(err)) throw err;
        }
        return;
      }

      // Non-interactive fallback: rows flow without a header, matching the
      // shape of `agents sessions` when piped.
      printTeamTable(rows);
    });

  // create
  addHostOption(teams.command('create <team>'))
    .aliases(['c', 'new'])
    .description('Start a new team. No teammates yet; add them with `teams add`.')
    .option('-d, --description <text>', 'One-line summary of what this team is working on')
    .option('--enable-worktrees', 'Each teammate works in its own git worktree (requires --worktree on add)')
    .option('--use-worktree <path>', 'All teammates share this existing worktree path (mutually exclusive with --enable-worktrees)')
    .option('--devices <list>', 'Pool of machines this team may run teammates on (comma-separated). Enables distributed auto-scheduling.')
    .option('--repo <urlOrPath>', 'How each remote (--device) teammate gets the code — ONE git URL/path for the whole team (existing checkout reused, else cloned). A team is single-repo; for work across repos, make one team per repo. Defaults to this checkout origin.')
    .option('--project <slug>', "Work this team on a defined project: its primary directory is each local teammate's base cwd, its other directories become --add-dir grants")
    .option('--json', 'Output machine-readable JSON')
    .action(async (team: string, opts: { description?: string; enableWorktrees?: boolean; useWorktree?: string; devices?: string; hosts?: string; repo?: string; project?: string; json?: boolean }) => {
      try {
        // Fail here, not at the first `teams add`: a team created against a
        // project that does not resolve would silently fall back to the
        // orchestrator's cwd for every teammate.
        if (opts.project) {
          const { resolveProjectRef } = await import('../lib/project-root.js');
          try {
            await resolveProjectRef(opts.project, { forRemote: false });
          } catch (err) {
            dieFriction('teams', 'project-unresolved', (err as Error).message);
          }
        }
        // --devices / --hosts are aliases; commander can't express a two-name
        // option that isn't a short flag, so merge them here. Split on comma,
        // trim, drop blanks, dedupe (preserving first-seen order).
        const rawPool = [opts.devices, opts.hosts].filter(Boolean).join(',');
        const devices: string[] = [];
        for (const raw of rawPool.split(',').map((s) => s.trim()).filter(Boolean)) {
          // Resolve `interactive` to the concrete device HERE, the same way the
          // single `--device` pin does. A pool is a set of specific machines the
          // scheduler picks between, so persisting the sentinel would let the
          // pool's membership change silently the next time `interactive.host`
          // is re-pinned — and every later friction message would quote
          // "interactive" instead of a box the user can act on.
          let d = raw;
          if (isDeviceInteractive(d)) {
            const pinned = resolveInteractiveDevice();
            if (!pinned) {
              dieFriction('teams', 'pool-device-interactive-unset', interactiveUnsetError());
            }
            process.stderr.write(chalk.gray(`[teams] pool device=interactive → ${pinned}\n`));
            d = pinned;
          }
          if (!devices.includes(d)) devices.push(d);
        }

        // Validate every pooled device resolves + is POSIX (v1 remote monitor is
        // POSIX-only). A device equal to the local machine is fine (runs local),
        // so skip the resolve/POSIX check for it.
        for (const name of devices) {
          if (name.toLowerCase() === machineId()) continue;
          const host = await resolveHost(name);
          if (!host) {
            dieFriction(
              'teams',
              'pool-device-not-resolvable',
              `Couldn't resolve pool device "${name}". Register it with \`agents devices add ${name} <target>\`, ` +
                `or pass user@host.`,
            );
          }
          if (remoteShellFor(host.os ?? resolveRemoteOsSync(host.name)) === 'powershell') {
            dieFriction(
              'teams',
              'pool-device-windows-unsupported',
              `Distributed teams on Windows device "${host.name}" are not supported yet — ` +
                `the teams remote monitor is POSIX-only. Use a Linux/macOS device.`,
            );
          }
        }

        // --repo: how each device gets the code. Default to the local checkout's
        // origin when a pool is declared and we're inside a git repo, so the user
        // never hand-manages a path per box. A poolless team leaves repo unset.
        let repo = opts.repo;
        if (!repo && devices.length > 0) {
          const cwd = process.cwd();
          if (await isGitRepo(cwd)) {
            const origin = await getRemoteUrl(cwd);
            if (origin) repo = origin;
          }
        }

        const meta = await createTeam(team, {
          description: opts.description,
          enableWorktrees: opts.enableWorktrees,
          useWorktree: opts.useWorktree,
          devices,
          repo,
          project: opts.project,
        });
        if (isJsonMode(opts)) {
          console.log(JSON.stringify({ team, ...meta }, null, 2));
          return;
        }
        console.log(chalk.green(`New team: ${chalk.cyan(team)}`));
        if (meta.description) console.log(chalk.gray(`  ${meta.description}`));
        if (meta.enable_worktrees) console.log(chalk.gray(`  worktrees: per-teammate`));
        if (meta.use_worktree) console.log(chalk.gray(`  worktree: ${meta.use_worktree}`));
        if (meta.devices && meta.devices.length) console.log(chalk.gray(`  devices: ${meta.devices.join(', ')}`));
        if (meta.repo) console.log(chalk.gray(`  repo: ${meta.repo}`));
        if (meta.project) console.log(chalk.gray(`  project: ${meta.project}`));
        console.log();
        console.log(chalk.gray('Add your first teammate:'));
        if (meta.enable_worktrees) {
          console.log(chalk.gray(`  agents teams add ${team} claude "your task here" --name alice --worktree feature-name`));
        } else {
          console.log(chalk.gray(`  agents teams add ${team} claude "your task here"`));
        }
      } catch (err) {
        dieFriction('teams', 'create-failed', (err as Error).message);
      }
    });

  // add
  addHostOption(teams.command('add <team> <teammate> <task>'))
    .alias('a')
    .description("Add a teammate to work on a task. Runs in background; returns immediately. Use 'status' to check in.")
    .option('-n, --name <name>', 'Friendly name for this teammate (e.g. alice). Required if using --after. Unique within team.')
    .option('-m, --mode <mode>', `Permissions: plan (read-only) | edit (can write files) | auto (more autonomous than edit, mechanism per-harness — see 'agents modes <agent>') | skip (bypass all permission prompts). 'full' accepted as alias for skip. Teammates run headless: plan works headless on claude/codex/cursor/droid/opencode; kimi/grok/antigravity have no headless plan mode and auto-downgrade a plan request to auto.`, 'edit')
    .option('-e, --effort <effort>', `Reasoning intensity: ${VALID_EFFORTS.join('|')}`, 'medium')
    .option('--model <model>', 'Cost tier (cheap|default|best|ultra) or a concrete id (e.g. claude-opus-4-8); tiers resolve per harness+version to a supported model')
    .option(
      '--env <key=value>',
      'Set an environment variable for this teammate (repeatable for multiple vars)',
      (val: string, prev: string[]) => [...prev, val],
      []
    )
    .option('--cwd <dir>', 'Working directory for this teammate (default: current directory)')
    .option('--worktree <name>', 'Run this teammate in a dedicated git worktree (required when team has --enable-worktrees)')
    .option('--after <names>', "DAG dependencies: comma-separated teammate names to wait for. Stages as PENDING; run 'teams start' to launch when ready.")
    .option('--task-type <type>', `Factory label: ${VALID_TASK_TYPES.join('|')}. Drives planner fan-out + test-oracle bugfix loop.`)
    .option('--cloud <provider>', `Dispatch to cloud backend instead of local CLI: ${VALID_CLOUD_PROVIDERS.join('|')}`)
    .option('--repo <owner/repo>', 'GitHub repository (required for --cloud rush)')
    .option('--branch <name>', 'Target git branch for cloud dispatch')
    .option('--force', "Skip the advisory 'may not be signed in' / 'account throttled' warnings")
    .option('--confirm', 'Proceed even when the base checkout/repo is behind origin/main (a stale repo otherwise blocks the add)')
    .option('--json', 'Output machine-readable JSON')
    .action(async (team: string, teammate: string, task: string, opts: {
      name?: string; mode: string; effort: string; model?: string; env: string[];
      cwd?: string; worktree?: string; after?: string; json?: boolean;
      taskType?: string; cloud?: string; host?: string; device?: string; repo?: string; branch?: string; force?: boolean;
      confirm?: boolean; remoteCwd?: string;
    }) => {
      // `--remote-cwd` rides the shared --device option family but is never read by
      // `teams add` (placement, not routing). Fail loud with guidance rather than
      // silently ignoring it — see remoteCwdOnAddError. `!== undefined` so even an
      // explicit empty value (`--remote-cwd ""`) is rejected, not silently dropped.
      if (opts.remoteCwd !== undefined) {
        dieFriction('teams', 'remote-cwd-on-add', remoteCwdOnAddError(team));
      }
      if (!(VALID_MODES as readonly string[]).includes(opts.mode)) {
        dieFriction('teams', 'invalid-mode', `Invalid mode '${opts.mode}'. Use one of: ${VALID_MODES.join(', ')}`);
      }
      if (!(VALID_EFFORTS as readonly string[]).includes(opts.effort)) {
        dieFriction('teams', 'invalid-effort', `Invalid effort '${opts.effort}'. Use one of: ${VALID_EFFORTS.join(', ')}`);
      }

      let taskType: TaskType | null = null;
      if (opts.taskType) {
        if (!(VALID_TASK_TYPES as readonly string[]).includes(opts.taskType)) {
          dieFriction('teams', 'invalid-task-type', `Invalid task-type '${opts.taskType}'. Use one of: ${VALID_TASK_TYPES.join(', ')}`);
        }
        taskType = opts.taskType as TaskType;
      }

      let cloudProviderId: CloudProviderId | null = null;
      if (opts.cloud) {
        if (!(VALID_CLOUD_PROVIDERS as readonly string[]).includes(opts.cloud)) {
          dieFriction('teams', 'invalid-cloud-provider', `Invalid cloud provider '${opts.cloud}'. Use one of: ${VALID_CLOUD_PROVIDERS.join(', ')}`);
        }
        cloudProviderId = opts.cloud as CloudProviderId;
        if (cloudProviderId === 'rush' && !opts.repo) {
          dieFriction('teams', 'cloud-rush-needs-repo', `--cloud rush requires --repo <owner/repo>`);
        }
      }

      // Auto-create the team if it doesn't exist yet (friendlier UX than erroring),
      // then load its metadata — needed here for the distributed --repo (how each
      // device gets the code) before we resolve a per-teammate --device pin.
      await ensureTeam(team);
      const teamMeta = await getTeam(team);

      // For `teams add` the passthrough special-cases --device as PLACEMENT,
      // not routing, so the local action reads it here.
      let explicitDevice = opts.device ?? null;

      // `auto` is the same live fleet sentinel `agents run --device auto` resolves
      // (RUSH-2185) — pick the concrete device name up front so the local-machine
      // check right below (and every dieFriction message further down) sees the
      // real target instead of the literal string "auto".
      if (explicitDevice && isDeviceAuto(explicitDevice)) {
        const plan = await resolveDeviceAuto(parseTeammate(teammate).agent);
        const picked = plan.host ?? machineId();
        process.stderr.write(chalk.gray(`[teams] device=auto → ${picked === machineId() ? 'local' : picked}\n`));
        explicitDevice = picked;
      }

      // `interactive` needs the same up-front resolution, and for a sharper
      // reason: `teams add`/`create` bail out of the fleet passthrough
      // (passthrough.ts, the teams subcommand guard), so the sentinel block
      // there never runs and this is the only resolver. Left literal, the
      // local-machine check below compares 'interactive' against the machine id,
      // takes the remote branch on the pinned box itself, and pins the teammate
      // to an SSH hop into this same machine — skipping three local preflights
      // on the way.
      if (explicitDevice && isDeviceInteractive(explicitDevice)) {
        const pinned = resolveInteractiveDevice();
        if (!pinned) {
          dieFriction('teams', 'device-interactive-unset', interactiveUnsetError());
        }
        process.stderr.write(
          chalk.gray(`[teams] device=interactive → ${pinned === machineId() ? 'local' : pinned}\n`),
        );
        explicitDevice = pinned;
      }

      // Distributed teams: --device <name> PINS this teammate to a machine over
      // SSH. Resolve + validate the placement here so a bad target fails at `add`
      // time, not silently at launch. Persisted (hostName/hostTarget/repoPath) so
      // startReady()/launchRemoteProcess dispatch over SSH. Unpinned teammates
      // leave these null — the launch-time scheduler resolves the pool cascade.
      let hostName: string | null = null;
      let hostTarget: string | null = null;
      let hostRepoPath: string | null = null;
      let hostExtraSshArgs: string[] = [];
      if (explicitDevice && explicitDevice.toLowerCase() !== machineId()) {
        if (cloudProviderId) {
          dieFriction('teams', 'device-cloud-mutually-exclusive', `--device and --cloud are mutually exclusive (two different remote backends). Pick one.`);
        }
        const host = await resolveHost(explicitDevice);
        if (!host) {
          dieFriction(
            'teams',
            'device-not-resolvable',
            `Couldn't resolve --device "${explicitDevice}". Register it with \`agents devices add ${explicitDevice} <target>\`, ` +
              `or pass user@host.`,
          );
        }
        // POSIX-only in v1: the remote follow/monitor layer offset-tails the log
        // with tail/cat/kill, which don't exist under PowerShell. Refuse Windows
        // up front, mirroring dispatch.ts launchDetached.
        if (remoteShellFor(host.os ?? resolveRemoteOsSync(host.name)) === 'powershell') {
          dieFriction(
            'teams',
            'device-windows-unsupported',
            `Distributed teammates on Windows host "${host.name}" are not supported yet — ` +
              `the teams remote monitor is POSIX-only (offset-tails the remote log with tail/cat/kill). ` +
              `Use a Linux/macOS host, or run this teammate locally.`,
          );
        }
        try {
          hostTarget = sshTargetFor(host);
        } catch (err) {
          dieFriction('teams', 'ssh-target-unresolvable', `Can't resolve an ssh target for "${host.name}": ${(err as Error).message}`);
        }
        // Ensure agents-cli is present + the pin is installed on the host.
        // Bare agent names still only warn; a concrete pin fails loud so
        // `teams add --device` never stages a teammate the box cannot run
        // (RUSH-2313). parseTeammate already resolves @latest/etc. to a concrete
        // version when one is pinned on the teammate spec.
        try {
          const parsed = parseTeammate(teammate);
          const { warnings } = ensureHostReady(host, {
            agent: parsed.agent,
            version: parsed.version ?? undefined,
            account: parsed.account ?? undefined,
          });
          for (const w of warnings) process.stderr.write(chalk.yellow(`[teams] warning: ${w}\n`));
        } catch (err) {
          dieFriction('teams', 'host-not-ready', `Host "${host.name}" is not ready: ${(err as Error).message}`);
        }
        // Provision the repo on the host from the team's --repo (clone into
        // ~/.agents/repos/<team> or reuse an existing checkout), resolving to the
        // ABSOLUTE git root so every later remote command works from an absolute
        // path (dispatch `cd`, worktree create, polling). When the team has no
        // --repo (the common "just send one teammate elsewhere" case, created
        // without a pool), fall back to THIS checkout's origin so the headline case
        // works with zero extra flags whenever you run `add` inside a git repo.
        let effectiveRepo = teamMeta?.repo ?? '';
        if (!effectiveRepo && (await isGitRepo(process.cwd()))) {
          effectiveRepo = (await getRemoteUrl(process.cwd())) ?? '';
        }
        // Capture the ssh args ensureRemoteRepo uses so the staleness probe below
        // reaches the host with the same identity.
        hostExtraSshArgs = host.identityFile ? ['-i', host.identityFile, '-o', 'IdentitiesOnly=yes'] : [];
        try {
          hostRepoPath = ensureRemoteRepo(hostTarget!, effectiveRepo, team, {
            extraSshArgs: hostExtraSshArgs,
          });
        } catch (err) {
          dieFriction(
            'teams',
            'repo-provision-failed',
            `Couldn't provision the repo on "${host.name}": ${(err as Error).message}\n` +
              `  Set how each device gets the code with: agents teams create ${team} --repo <url|path>`,
          );
        }
        hostName = host.name;
      }

      const { agent, version, profileName, account } = parseTeammate(teammate);
      warnAgentDeprecated(agent);
      // Version-installed check is about the LOCAL machine — a distributed (--on)
      // teammate's agent/version lives on the host, verified by ensureHostReady.
      if (version && !hostName && !isVersionInstalled(agent, version)) {
        dieFriction(
          'teams',
          'agent-version-not-installed',
          `${AGENT_NAMES[agent]} ${version} isn't installed.\n` +
            `  Install it:  agents add ${agent}@${version}\n` +
            `  Or see what's installed (incl. @latest):  agents view ${agent}`
        );
      }

      // Advisory sign-in check: warn but NEVER block. Detection is unreliable
      // for opaque-cred agents, so a false negative must not stop a team. Cloud
      // dispatch authenticates through the provider, not the local CLI — skip it.
      // Distributed (--on) teammates authenticate on the host, not locally — skip.
      if (!opts.force && !cloudProviderId && !hostName && !(await checkCliSignedIn(agent))) {
        console.error(
          chalk.yellow(`⚠ ${AGENT_NAMES[agent]} may not be signed in (detection is unreliable). Adding anyway.`) +
            chalk.gray(`\n  If it fails to start, run \`${AGENTS[agent].cliCommand}\` to log in, or pass --force to silence this.`)
        );
      }

      // Advisory throttle check — only for a version-pinned teammate, which
      // bypasses account rotation and so can't route around a rate-limited /
      // out-of-credits / signed-out account (see throttleWarningLine). Skip bare
      // targets (rotation handles them), profiles (auth-injected account isn't
      // the version-home one we can read), and cloud dispatch. Warn, never block.
      if (!opts.force && !cloudProviderId && !hostName && !profileName && version) {
        const readiness = await checkRunAccountReadiness(agent, version);
        if (!readiness.ready) console.error(throttleWarningLine(agent, version, readiness));
      }

      if (opts.name !== undefined) {
        if (!opts.name || !/^[A-Za-z0-9_-]+$/.test(opts.name)) {
          dieFriction('teams', 'invalid-teammate-name', `Invalid teammate name '${opts.name}'. Use letters, numbers, '-', or '_'.`);
        }
      }

      if (opts.worktree !== undefined) {
        if (!opts.worktree || !/^[A-Za-z0-9_-]+$/.test(opts.worktree)) {
          dieFriction('teams', 'invalid-worktree-name', `Invalid worktree name '${opts.worktree}'. Use letters, numbers, '-', or '_'.`);
        }
      }

      const after = opts.after
        ? opts.after.split(',').map((s) => s.trim()).filter(Boolean)
        : [];
      if (after.length > 0 && !opts.name) {
        dieFriction('teams', 'after-requires-name', "--after requires --name (dependencies reference teammates by name).");
      }

      let envOverrides: Record<string, string> | undefined;
      try {
        envOverrides = parseExecEnv(opts.env);
      } catch (err) {
        dieFriction('teams', 'invalid-env', (err as Error).message);
      }

      // Team already ensured + loaded above (teamMeta) for the --repo provisioning.
      const worktreesEnabled = teamMeta?.enable_worktrees ?? false;
      const sharedWorktree = teamMeta?.use_worktree ?? null;
      let worktreeName: string | null = null;
      let worktreePath: string | null = null;

      const mgr = mkManager();

      // Validate name uniqueness + --after deps BEFORE creating a worktree
      // (RUSH-2356): a rejected add must not leave an orphan `agents/<name>`
      // branch that then breaks the retry with `fatal: a branch ... already
      // exists`. spawn() calls the same method, which memoizes this result for
      // exactly one consumer — so validation still lives in one place without
      // paying for a second sibling status refresh on the way there.
      try {
        await mgr.validateAddPreconditions(team, opts.name ?? null, after);
      } catch (err) {
        dieFriction('teams', 'add-precondition-failed', (err as Error).message);
      }

      // Stale-repo guard: refuse to point a team at a checkout behind origin/main
      // unless --confirm. A cloud teammate clones fresh in the provider, so it has
      // no local/remote checkout to assess — skip it there.
      if (!cloudProviderId) {
        if (hostName) {
          await assertRepoFreshOrConfirm({
            team,
            confirm: Boolean(opts.confirm),
            json: isJsonMode(opts),
            remote: { target: hostTarget!, repoPath: hostRepoPath!, host: hostName, extraSshArgs: hostExtraSshArgs },
          });
        } else {
          const base = sharedWorktree ?? opts.cwd ?? process.cwd();
          if (await isGitRepo(base)) {
            await assertRepoFreshOrConfirm({ team, confirm: Boolean(opts.confirm), json: isJsonMode(opts), local: base });
          }
        }
      }

      // Track a worktree WE create in this add so a later failure (dep race,
      // launch error, cloud dispatch) can tear it down instead of stranding the
      // branch. Only a worktree THIS add created is ever torn down, so a
      // legitimately-pending teammate's worktree is never touched.
      let createdWorktree: { baseCwd: string; name: string } | null = null;
      const tearDownCreatedWorktree = async (): Promise<void> => {
        if (!createdWorktree) return;
        const { baseCwd, name } = createdWorktree;
        createdWorktree = null;

        await tearDownOrphanWorktree(mgr, baseCwd, name);
      };

      if (hostName) {
        // Distributed teammate: the checkout lives on the host, so we NEVER touch
        // the local filesystem here. A shared local worktree makes no sense for a
        // remote teammate; a per-teammate worktree is created ON THE HOST at launch
        // (createRemoteWorktree in launchRemoteProcess) — we just capture its name.
        if (sharedWorktree) {
          dieFriction('teams', 'shared-worktree-remote-conflict', `Team '${team}' uses a shared local --use-worktree, which can't apply to a --device (remote) teammate.`);
        }
        if (worktreesEnabled) {
          if (!opts.worktree) {
            dieFriction('teams', 'worktree-required-remote', `Team '${team}' has worktrees enabled. Use --worktree <name> for the remote teammate (created on ${hostName}).`);
          }
          if (!opts.name) {
            dieFriction('teams', 'name-required-remote', `Team '${team}' has worktrees enabled. Use --name <name> to identify this teammate.`);
          }
          worktreeName = opts.worktree;
        } else if (opts.worktree) {
          dieFriction('teams', 'worktree-requires-enable-worktrees', `--worktree requires --enable-worktrees on the team. Recreate the team with: agents teams create ${team} --enable-worktrees`);
        }
        // Local cwd stays null — the remote cwd is repoPath / the remote worktree.
      } else if (sharedWorktree) {
        // Team uses a shared worktree for all teammates
        const fsp = await import('fs/promises');
        try {
          const stat = await fsp.stat(sharedWorktree);
          if (!stat.isDirectory()) {
            dieFriction('teams', 'shared-worktree-not-dir', `Shared worktree path is not a directory: ${sharedWorktree}`);
          }
        } catch {
          dieFriction('teams', 'shared-worktree-missing', `Shared worktree path does not exist: ${sharedWorktree}`);
        }
        worktreePath = sharedWorktree;
        if (opts.worktree) {
          dieFriction('teams', 'worktree-on-shared-team', `Team '${team}' uses --use-worktree (shared). Don't pass --worktree on add.`);
        }
      } else if (worktreesEnabled) {
        if (!opts.worktree) {
          dieFriction('teams', 'worktree-required', `Team '${team}' has worktrees enabled. Use --worktree <name> to specify a worktree name.`);
        }
        if (!opts.name) {
          dieFriction('teams', 'name-required', `Team '${team}' has worktrees enabled. Use --name <name> to identify this teammate.`);
        }
        const baseCwd = opts.cwd ?? process.cwd();
        if (!(await isGitRepo(baseCwd))) {
          dieFriction('teams', 'worktree-needs-repo', `Worktrees require a git repository. ${baseCwd} is not inside a git repo.`);
        }
        // Was anything under this name already here BEFORE we tried? That is
        // the only sound basis for cleaning up a failed create: the common
        // failure is `fatal: a branch named 'agents/<name>' already exists`,
        // and removing a checkout we did not make can destroy uncommitted work
        // (`teams stop` deliberately KEEPS a dirty worktree, and that teammate's
        // record is terminal by then, so no record-based check protects it).
        const preexisting = await worktreeExists(baseCwd, opts.worktree).catch(() => true);
        try {
          worktreeName = opts.worktree;
          worktreePath = await createWorktree(baseCwd, worktreeName);
          createdWorktree = { baseCwd, name: worktreeName };
        } catch (err) {
          // `git worktree add -b` can also fail PART WAY — branch ref created,
          // checkout not — stranding `agents/<name>` in exactly the way that
          // breaks the retry. Clean that up only when nothing was here before
          // AND there is still no checkout now: all that can be left is a
          // dangling branch ref, so this can never delete anyone's files. The
          // second half matters because a concurrent add can create a real
          // worktree under this name during our `git fetch`, long after the
          // pre-flight probe answered.
          const checkoutNow = await worktreeCheckoutExists(baseCwd, opts.worktree).catch(() => true);
          if (!preexisting && !checkoutNow) {
            try {
              await removeWorktree(baseCwd, opts.worktree);
            } catch {
              // Nothing to remove (the add died before git wrote anything), or
              // we can't. Either way the real error below is what matters.
            }
          }
          const detail = (err as Error).message;
          const hint = /already exists/.test(detail)
            ? `\n  Another teammate already owns the worktree '${opts.worktree}'. Pick a different --worktree name,` +
              ` or free this one: agents teams status ${team}`
            : '';
          dieFriction('teams', 'worktree-create-failed', `Failed to create worktree '${opts.worktree}': ${detail}${hint}`);
        }
      } else if (opts.worktree) {
        dieFriction('teams', 'worktree-requires-enable-worktrees', `--worktree requires --enable-worktrees on the team. Recreate the team with: agents teams create ${team} --enable-worktrees`);
      }

      // The team's project (`teams create --project`) contributes a base cwd and
      // the access grants for its other directories. It sits BELOW --cwd in the
      // precedence chain: an explicit --cwd on this teammate still wins.
      //
      // Grants are attached even when a worktree or --cwd owns the cwd — the
      // sibling repos are what the project binds, not where the teammate sits.
      // Only the base cwd is resolved here — a LOCAL teammate needs a concrete
      // directory to start in. The GRANTS are deliberately not resolved now:
      // an unpinned teammate on a --devices pool is placed at launch, so its
      // shape (absolute vs ~/…) is not yet knowable. The project name rides on
      // the record and resolveTeammateGrants resolves it per launch.
      let projectCwd: string | undefined;
      if (teamMeta?.project && !hostName) {
        const { resolveProjectRef } = await import('../lib/project-root.js');
        try {
          projectCwd = await resolveProjectRef(teamMeta.project, { forRemote: false });
        } catch (err) {
          dieFriction('teams', 'project-unresolved', (err as Error).message);
        }
      }

      // Distributed teammates have no LOCAL cwd — their working dir lives on the
      // host (repoPath / the remote worktree). Local teammates default to the
      // worktree path, then --cwd, then the project's primary directory, then
      // the current directory.
      const cwd = hostName ? null : (worktreePath ?? opts.cwd ?? projectCwd ?? process.cwd());

      // Factory teammates: prepend the worker-skill preamble to every task
      // prompt so implementers/testers/reviewers know about the Ledger, the
      // dynamic DAG, and the pattern for filing new tasks mid-flight. No
      // preamble when --task-type isn't set (plain teammates work as before).
      let effectiveTask = task;
      if (taskType) {
        effectiveTask = factoryWorkerPreamble(team, opts.name ?? null, taskType, after) + '\n\n' + task;
      }

      // Dispatcher callback: when a staged cloud teammate's deps resolve,
      // AgentManager.startReady() invokes this to kick off the remote task.
      if (cloudProviderId) {
        const providerId = cloudProviderId;
        mgr.setCloudDispatcher(async (a) => {
          const prov = resolveProvider(providerId);
          const dispatchOpts: DispatchOptions = {
            // PHNX-3236: same self-merge boundary as the local/remote path — a
            // cloud teammate has no inherited merge-guard.sh, so the prompt is
            // its only layer.
            prompt: withTeammatePrPolicy(a.prompt, a.mode),
            agent: a.agentType,
            repo: opts.repo,
            branch: opts.branch,
            model: a.model ?? undefined,
            env: shareRuntimeEnv(),
          };
          const cloudTask = await prov.dispatch(dispatchOpts);
          return { cloudSessionId: cloudTask.id };
        });
      }

      const cloudSessionId: string | null = null;
      const isStaged = after.length > 0;

      try {
        const result = await handleSpawn(
          mgr,
          team,
          agent,
          effectiveTask,
          cwd,
          opts.mode as Mode,
          opts.effort as Effort,
          null,
          cwd,
          version,
          opts.name ?? null,
          after,
          opts.model ?? null,
          envOverrides ?? null,
          taskType,
          cloudProviderId,
          cloudSessionId,
          opts.repo ?? null,
          opts.branch ?? null,
          worktreeName,
          worktreePath,
          profileName,
          hostName,
          hostTarget,
          hostRepoPath,
          teamMeta?.project ?? null,
          account,
        );

        emit('teams.add', { module: 'teams', team, agent, name: result.name, agent_id: result.agent_id, status: result.status });

        if (isJsonMode(opts)) {
          console.log(JSON.stringify(result, null, 2));
          return;
        }
        const who = profileName ? `${profileName} (via ${fullName(agent, version)})` : fullName(agent, version);
        const staged = result.status === 'pending';
        const verb = staged ? 'Staged' : 'Welcomed';
        const greeting = result.name
          ? `${verb} ${chalk.cyan(result.name)} (${who}) ${staged ? 'in' : 'to'} team ${chalk.cyan(team)}`
          : `${verb} ${who} ${staged ? 'in' : 'to'} team ${chalk.cyan(team)}`;
        console.log(chalk.green(greeting));
        if (result.name) {
          console.log(`  ${chalk.gray('name    ')}  ${chalk.cyan(result.name)}`);
        }
        console.log(`  ${chalk.gray('agent_id')}  ${chalk.cyan(shortId(result.agent_id))} ${chalk.gray(`(${result.agent_id})`)}`);
        console.log(`  ${chalk.gray('status  ')}  ${statusColor(result.status)(result.status)}`);
        console.log(`  ${chalk.gray('mode    ')}  ${opts.mode}`);
        console.log(`  ${chalk.gray('working ')}  ${hostName ? hostRepoPath : cwd}`);
        if (hostName) {
          console.log(`  ${chalk.gray('host    ')}  ${chalk.cyan(hostName)}${chalk.gray(` (${hostTarget})`)}`);
        }
        if (worktreeName) {
          console.log(`  ${chalk.gray('worktree')}  ${chalk.cyan(worktreeName)}`);
        }
        if (result.task_type) {
          console.log(`  ${chalk.gray('task    ')}  ${chalk.cyan(result.task_type)}`);
        }
        if (result.cloud_provider) {
          console.log(`  ${chalk.gray('cloud   ')}  ${chalk.magenta(result.cloud_provider)}${result.cloud_session_id ? chalk.gray(' — ' + result.cloud_session_id.slice(0, 12)) : ''}`);
        }
        if (result.after && result.after.length) {
          console.log(`  ${chalk.gray('after   ')}  ${result.after.join(', ')}`);
        }
        console.log();
        if (staged) {
          console.log(chalk.gray(`Start the ready teammates:  agents teams start ${team}`));
          if (after.length > 0) {
            process.stderr.write(
              chalk.yellow(
                `\nWarning: this teammate has --after dependencies and will NEVER start on its own.\n` +
                `  A supervisor watch process is required to launch it when its deps complete.\n` +
                `  Run this in another terminal:\n` +
                `    agents teams start ${team} --watch\n`
              )
            );
          }
        } else {
          console.log(chalk.gray(`Check in later:  agents teams status ${team}`));
        }
      } catch (err) {
        // The add failed after we created its worktree — tear the worktree +
        // branch down so a retry isn't blocked by `fatal: a branch ... already
        // exists` (RUSH-2356). Best-effort: report the original failure either way.
        await tearDownCreatedWorktree();
        dieFriction('teams', 'add-failed', `Could not add ${fullName(agent, version)} to ${team}: ${(err as Error).message}`);
      }
    });

  // status
  addHostOption(teams.command('status [team]'))
    .aliases(['s', 'st', 'check'])
    .description("Check in on a team: status, files touched, recent commands, last messages. Pass --verbose for the full per-teammate dump; --since for delta polling.")
    .option('-f, --filter <state>', 'Show only teammates in this state: running, completed, failed, stopped, or all (default: all)', 'all')
    .option('-s, --since <iso>', 'Cursor from a previous status call; only show updates after this timestamp (enables efficient polling)')
    .option('--agent-id <id>', 'Show only this one teammate (by UUID or UUID prefix)')
    .option('--parent-session <id>', 'Show the teammates spawned BY this session, across teams. Resolves only teammates whose record survives the teams cleanup window.')
    .option('-v, --verbose', 'Emit the full per-teammate detail (prompt, all file paths, all messages). Default is a compact summary.')
    .option('--json', 'Output machine-readable JSON')
    .action(async (team: string | undefined, opts: {
      filter: string; since?: string; agentId?: string; parentSession?: string; json?: boolean; verbose?: boolean;
    }) => {
      const filter = opts.filter;
      const mgr = mkManager();

      // No team given → drop into the picker (TTY) or fail clearly (script).
      // --parent-session is its own lookup key, so it needs no team at all.
      if (!team && !opts.parentSession) {
        const picked = await pickTeamOr(mgr, 'agents teams status');
        if (!picked) return;
        team = picked;
      }

      try {
        const result = await handleStatus(mgr, team, filter, opts.since, opts.parentSession);
        const agents = opts.agentId
          ? result.agents.filter((a) => a.agent_id.startsWith(opts.agentId!))
          : result.agents;
        const filtered = { ...result, agents };

        if (isJsonMode(opts)) {
          // JSON output also respects --verbose. Default = compact summary
          // shape; --verbose = full AgentStatusDetail. Same toggle covers
          // both text and JSON so MCP-style consumers can opt into detail.
          const payload = opts.verbose
            ? filtered
            : toTaskStatusSummary(filtered);
          console.log(JSON.stringify(payload, null, 2));
          return;
        }

        // A --parent-session lookup spans teams, so there is no single team to
        // check for existence — its label is the session that spawned them.
        const label = team ?? `session ${opts.parentSession!.slice(0, 8)}`;
        if (team) {
          const exists = await teamExists(team);
          if (!exists && result.agents.length === 0) {
            console.log(chalk.yellow(`No team called '${team}'. Create it with: agents teams create ${team}`));
            return;
          }
        } else if (result.agents.length === 0) {
          console.log(chalk.yellow(`No teammates recorded for ${label}.`));
          console.log(chalk.gray('Teammate records are cleaned up after 7 days; an older team may have aged out.'));
          return;
        }

        if (opts.verbose) {
          await printTeamStatus(label, filtered);
        } else {
          printTeamSummary(label, toTaskStatusSummary(filtered));
        }
      } catch (err) {
        // `team` is undefined for a --parent-session lookup, which spans teams.
        dieFriction(
          'teams',
          'status-failed',
          `Could not check on ${team ? `team ${team}` : 'the requested session'}: ${(err as Error).message}`
        );
      }
    });

  // active — list every live teammate across every team, grouped by team.
  teams
    .command('active')
    .description('List every teammate running right now, across all teams (PID-alive check).')
    .option('--json', 'Output machine-readable JSON')
    .action(async (opts: { json?: boolean }) => {
      const mgr = mkManager();
      const running = await mgr.listRunning();

      if (isJsonMode(opts)) {
        console.log(JSON.stringify({ agents: running.map((a) => ({
          agent_id: a.agentId,
          team: a.taskName,
          name: a.name,
          agent_type: a.agentType,
          pid: a.pid,
          started_at: a.startedAt.toISOString(),
          cwd: a.cwd,
          version: a.version,
          host: a.hostName,
        })) }, null, 2));
        return;
      }

      if (running.length === 0) {
        console.log(chalk.gray('No teammates are running right now.'));
        return;
      }

      const byTeam = new Map<string, typeof running>();
      for (const a of running) {
        const arr = byTeam.get(a.taskName) || [];
        arr.push(a);
        byTeam.set(a.taskName, arr);
      }

      for (const [team, agents] of byTeam) {
        console.log(chalk.bold(`Team ${chalk.cyan(team)}  ${chalk.gray(`(${agents.length} working)`)}`));
        for (const a of agents) {
          const ident = a.name || shortId(a.agentId);
          // A distributed teammate has no local pid; show its host + remote pid.
          const pidStr = a.hostName
            ? chalk.cyan(`on ${a.hostName}`) + (a.remotePid ? chalk.gray(` (pid ${a.remotePid})`) : '')
            : a.pid ? chalk.yellow(`pid ${a.pid}`) : chalk.gray('pid ?');
          const started = chalk.gray(relTime(a.startedAt.toISOString()));
          console.log(`  ${chalk.magenta(padRight(fullName(a.agentType, a.version), 18))}  ${chalk.white(padRight(ident, 20))}  ${pidStr}  ${started}`);
        }
        console.log();
      }
      console.log(chalk.gray(`${running.length} teammate${running.length === 1 ? '' : 's'} running. See 'agents sessions --active' for the full cross-context view.`));
    });

  // start — fire any staged teammates whose --after deps have all completed
  addHostOption(teams.command('start [team]'))
    .description('Launch ready teammates independently. Failed launch/placement and blocked --after dependencies persist in status; --watch keeps draining viable DAG branches.')
    .option('--json', 'Output machine-readable JSON')
    .option('--watch', 'Keep running: poll every --interval seconds, fire new waves, exit when the DAG drains.')
    .option('--interval <seconds>', 'Seconds between waves in --watch mode (default 8)', '8')
    .option('--max-waves <n>', 'Safety cap on waves in --watch mode (default 1000)', '1000')
    .option('--force', "Skip the advisory 'may not be signed in' / 'account throttled' warnings for staged teammates")
    .action(async (team: string | undefined, opts: { json?: boolean; watch?: boolean; interval: string; maxWaves: string; force?: boolean }) => {
      const mgr = mkManager();
      wireCloudDispatcher(mgr);

      if (!team) {
        const picked = await pickTeamOr(mgr, 'agents teams start');
        if (!picked) return;
        team = picked;
      }

      // RUSH-2450: a disbanded team must not be re-startable. Orphan PENDING
      // records can no longer resurrect after purge + saveMeta guard, but if a
      // caller still points start at a gone team name, fail loud with a reason
      // instead of launching nothing and looking successful.
      if (!(await teamExists(team))) {
        const orphanCount = (await mgr.listByTask(team)).length;
        const msg = orphanCount > 0
          ? `Team '${team}' is not registered (disbanded?). ${orphanCount} orphan teammate record(s) remain on disk — re-create the team or purge them before starting.`
          : `Team '${team}' is not registered (disbanded or never created). Nothing to start.`;
        if (isJsonMode(opts)) {
          console.log(JSON.stringify({ team, error: 'team-not-found', message: msg, orphan_teammates: orphanCount }));
        } else {
          dieFriction('teams', 'team-not-found', msg, 2);
        }
        process.exitCode = 1;
        return;
      }

      if (!opts.force && !isJsonMode(opts)) {
        await warnUnsignedTeammates(mgr, team);
        await warnThrottledTeammates(mgr, team);
      }

      emit('teams.start', { module: 'teams', team, watch: Boolean(opts.watch) });

      if (!opts.watch) {
        await runOneWave(mgr, team, Boolean(opts.json));
        return;
      }

      if (!isJsonMode(opts)) printFeedHint(team);

      const intervalMs = Math.max(1000, Number.parseInt(opts.interval, 10) * 1000 || 8000);
      const maxWaves = Math.max(1, Number.parseInt(opts.maxWaves, 10) || 1000);
      const json = isJsonMode(opts);

      // Live budget kill-switch (issue #399). Dormant when no caps set — the
      // factory dropping this in returns null and runSupervisor short-circuits.
      const { createTeamBudgetWatcher } = await import('../lib/budget/live-team.js');
      const budgetWatcher = createTeamBudgetWatcher({
        manager: mgr,
        team,
        cwd: process.cwd(),
        onBreach: (b) => {
          process.stderr.write(
            `[budget] cap ${b.cap} exceeded ($${b.spend.toFixed(2)} > $${b.limit.toFixed(2)}) — stopping team ${team}\n`,
          );
        },
      });

      const result = await runSupervisor(mgr, {
        team,
        intervalMs,
        maxWaves,
        budgetWatcher,
        onWave: (s) => {
          const ts = s.timestamp.slice(11, 19);
          if (json) {
            console.log(JSON.stringify({
              wave: s.wave, ts, team: s.team, launched: s.launched.length,
              pending: s.pending, running: s.running, completed: s.completed, failed: s.failed,
            }));
            return;
          }
          console.log(
            `[${ts}] wave ${s.wave}  team ${chalk.cyan(s.team)}  ` +
            `launched=${chalk.green(s.launched.length)}  running=${chalk.yellow(s.running)}  ` +
            `pending=${chalk.blue(s.pending)}  done=${chalk.green(s.completed)}  ` +
            `failed=${s.failed > 0 ? chalk.red(s.failed) : '0'}`
          );
        },
      });

      const elapsed = Math.floor(result.elapsed_ms / 1000);
      emit('teams.complete', { module: 'teams', team, stoppedBy: result.stoppedBy, waves: result.waves, durationMs: result.elapsed_ms });

      if (result.stoppedBy === 'drained') {
        console.log(chalk.green(`Factory drained in ${elapsed}s (${result.waves} waves).`));
        // First-successful-team star nudge (one-time, non-nagging). "drained"
        // only means nothing is pending/running — teammates may have failed — so
        // gate on a clean drain (failed === 0). A team where every teammate
        // failed is not the success this nudge celebrates.
        if ((result.failed ?? 0) === 0) {
          maybeShowStarNudge({ quiet: opts.json });
        }
      } else if (result.stoppedBy === 'max-waves') {
        console.error(chalk.yellow(`Hit --max-waves=${maxWaves}; stopping. Re-run to continue.`));
      } else if (result.stoppedBy === 'signal') {
        console.error(chalk.yellow(`Stopped by signal after ${result.waves} waves.`));
      } else if (result.stoppedBy === 'budget') {
        const b = result.budgetBreach;
        console.error(chalk.red(
          `Budget kill-switch tripped after ${result.waves} waves` +
            (b ? ` (cap ${b.cap}: $${b.spend.toFixed(2)} > $${b.limit.toFixed(2)})` : '') +
            `.`,
        ));
        process.exitCode = 7; // Mirrors BUDGET_KILL_EXIT_CODE for CI/headless.
      }
    });

  // pr-watch — autonomous PR lifecycle (issue #338)
  addHostOption(teams.command('pr-watch [team]'))
    .description('Watch the PRs a team opened and react autonomously: RED CI -> spawn a fix teammate with the failure logs; new review comment -> route a bugfix teammate. Both slot into the team DAG (visible in `teams status`).')
    .option('--interval <seconds>', 'Seconds between polls (default 30)', '30')
    .option('--max-polls <n>', 'Stop after this many polls (default: run until Ctrl-C)', '0')
    .option('--max-waves <n>', `Fix waves per PR before escalating to a human (default ${DEFAULT_MAX_WAVES})`, String(DEFAULT_MAX_WAVES))
    .option('--once', 'Poll a single time and exit (equivalent to --max-polls 1)')
    .option('--json', 'Emit one JSON line per pr-watch event')
    .action(async (team: string | undefined, opts: { interval: string; maxPolls: string; maxWaves: string; once?: boolean; json?: boolean }) => {
      const mgr = mkManager();

      if (!team) {
        const picked = await pickTeamOr(mgr, 'agents teams pr-watch');
        if (!picked) return;
        team = picked;
      }
      const resolvedTeam = team;

      const intervalMs = Math.max(1000, (Number.parseInt(opts.interval, 10) || 30) * 1000);
      const maxPolls = opts.once ? 1 : Math.max(0, Number.parseInt(opts.maxPolls, 10) || 0);
      const maxWaves = Math.max(1, Number.parseInt(opts.maxWaves, 10) || DEFAULT_MAX_WAVES);
      const json = isJsonMode(opts);

      const { handled, waves } = await loadPrWatchState(resolvedTeam);

      let stopSignal = false;
      const onSig = () => { stopSignal = true; };
      process.once('SIGINT', onSig);
      process.once('SIGTERM', onSig);

      const emit = (e: PrWatchEvent) => {
        if (json) { console.log(JSON.stringify(e)); return; }
        const ts = e.timestamp.slice(11, 19);
        if (e.type === 'poll') {
          console.log(`[${ts}] polled ${chalk.cyan(resolvedTeam)} — ${e.targets} PR(s) under watch`);
        } else if (e.type === 'spawned') {
          const verb = e.action.kind === 'ci-fix' ? 'CI-fix' : 'bugfix';
          const detail = e.action.kind === 'ci-fix'
            ? `check ${chalk.yellow(e.action.check.name)}`
            : `comment ${chalk.yellow('#' + e.action.comment.id)}`;
          console.log(
            `[${ts}] ${chalk.green('spawned')} ${verb} teammate ${chalk.cyan(e.label ?? '?')} ` +
            `(wave ${e.action.wave}/${maxWaves}) for ${detail} on ${e.action.prUrl}`
          );
        } else if (e.type === 'needs-human') {
          console.error(
            `[${ts}] ${chalk.red('needs human')} — ${e.prUrl} still failing after ${e.waves} wave(s) ` +
            `(${e.subject}). Not spawning again; hand it to a human.`
          );
        } else if (e.type === 'error') {
          console.error(`[${ts}] ${chalk.red('error')} on ${e.prUrl}: ${e.message}`);
        }
      };

      // A fixer's dedupe guard clears once it settles, so a still-red check can
      // spawn its next (budget-bounded) wave. Terminal = completed/failed/stopped.
      const reactionSettled = async (label: string): Promise<boolean> => {
        const roster = await mgr.listByTask(resolvedTeam);
        const teammate = roster.find((a) => a.name === label || shortId(a.agentId) === label);
        if (!teammate) return false;
        const s = String(teammate.status);
        return s === 'completed' || s === 'failed' || s === 'stopped';
      };

      try {
        const result = await runPrWatch(
          {
            resolveTargets: async () => {
              // Drive the DAG each pass so fix/bugfix teammates staged --after a
              // now-completed source teammate actually launch — no separate
              // `teams start --watch` needed.
              await mgr.rescanFromDisk();
              await mgr.startReady(resolvedTeam);
              return resolvePrWatchTargets(mgr, resolvedTeam);
            },
            react: (action, prompt) => reactWithTeammate(mgr, resolvedTeam, action, prompt),
            reactionSettled,
            onEvent: emit,
          },
          {
            intervalMs,
            maxPolls,
            maxWaves,
            handled,
            waves,
            shouldStop: () => stopSignal,
          }
        );
        await savePrWatchState(resolvedTeam, { handled: result.handled, waves: result.waves });
        if (!json) {
          const humanNote = result.neededHuman > 0
            ? ` ${result.neededHuman} PR(s) escalated to a human.`
            : '';
          console.log(
            chalk.gray(
              `pr-watch stopped (${result.stoppedBy}) after ${result.polls} poll(s); ` +
              `spawned ${result.spawned} follow-up teammate(s).${humanNote}`
            )
          );
          console.log(chalk.gray(`Check the team:  agents teams status ${resolvedTeam}`));
        }
      } finally {
        process.off('SIGINT', onSig);
        process.off('SIGTERM', onSig);
      }
    });

  // stop
  addHostOption(teams.command('stop [team] [teammate]'))
    .description('Stop a running teammate. Resume it later with `agents teams resume`. Cleans up worktree if no uncommitted changes.')
    .option('--json', 'Output machine-readable JSON')
    .action(async (team: string | undefined, ref: string | undefined, opts: { json?: boolean }) => {
      const mgr = mkManager();

      if (!team) {
        const { names } = await loadTeamRows(mgr);
        requireDestructiveArg({
          argName: 'team',
          command: 'agents teams stop',
          itemNoun: 'team',
          available: names,
          emptyHint: "You don't have any teams yet.",
        });
      }
      if (!ref) {
        const roster = await mgr.listByTask(team);
        const running = roster.filter((a) => a.status === 'running');
        requireDestructiveArg({
          argName: 'teammate',
          command: `agents teams stop ${team}`,
          itemNoun: 'teammate',
          available: running.map((a) => a.name || shortId(a.agentId)),
          emptyHint: `Team ${team} has no running teammates.`,
        });
      }

      const lookup = await mgr.resolveAgentIdInTask(team, ref);
      if (lookup.kind === 'none') {
        dieFriction('teams', 'teammate-not-found', `No teammate matching '${ref}' in team ${team}`, 2);
      }
      if (lookup.kind === 'ambiguous') {
        const shorts = lookup.matches.map(shortId).join(', ');
        dieFriction('teams', 'teammate-ambiguous', `'${ref}' matches multiple teammates: ${shorts}. Use more characters or a name.`, 2);
      }
      const agentId = lookup.agentId;

      const agent = await mgr.get(agentId);
      const display = agent?.name || shortId(agentId);

      const stopRes = await handleStop(mgr, team, agentId);
      if ('error' in stopRes) dieFriction('teams', 'stop-failed', stopRes.error);

      // Clean up worktree if this teammate had one
      let worktreeKept = false;
      if (agent?.worktreeName && agent?.worktreePath) {
        try {
          if (agent.hostName && agent.hostTarget && agent.repoPath) {
            // Distributed teammate: guard + remove the worktree ON THE HOST.
            const ssh = { extraSshArgs: agent.hostIdentityFile ? ['-i', agent.hostIdentityFile, '-o', 'IdentitiesOnly=yes'] : [] };
            if (remoteWorktreeDirty(agent.hostTarget, agent.worktreePath, ssh)) {
              worktreeKept = true;
            } else {
              removeRemoteWorktree(agent.hostTarget, agent.repoPath, agent.worktreeName, true, ssh);
            }
          } else {
            const dirty = await hasUncommittedChanges(agent.worktreePath);
            if (dirty) {
              worktreeKept = true;
            } else {
              const baseCwd = process.cwd();
              await removeWorktree(baseCwd, agent.worktreeName);
            }
          }
        } catch {
          // best-effort cleanup
        }
      }

      if (isJsonMode(opts)) {
        console.log(JSON.stringify({
          team,
          agent_id: agentId,
          name: agent?.name ?? null,
          stopped: stopRes.stopped.length > 0,
          worktree_kept: worktreeKept,
        }, null, 2));
        return;
      }

      if (stopRes.stopped.length) {
        console.log(chalk.green(`Stopped ${chalk.cyan(display)} in team ${chalk.cyan(team)}.`));
      } else if (stopRes.already_stopped.length) {
        console.log(chalk.gray(`${display} was already stopped.`));
      }
      if (worktreeKept && agent?.worktreeName) {
        console.log(chalk.yellow(`Worktree '${agent.worktreeName}' has uncommitted changes. Keeping it at: ${agent.worktreePath}`));
      }
    });

  // message / resume — send a follow-up message to a teammate. Routes by the
  // teammate's reconciled status: a RUNNING teammate is STEERED via its mailbox
  // (delivered at its next tool call); a STOPPED one (completed/failed/stopped)
  // is RESUMED — re-entering its own session with the message as the next user
  // turn, re-attaching it to the team as live.
  async function teamMessageAction(
    team: string,
    ref: string,
    message: string | undefined,
    opts: { json?: boolean; from?: string },
  ): Promise<void> {
    const mgr = mkManager();

    const lookup = await mgr.resolveAgentIdInTask(team, ref);
    if (lookup.kind === 'none') dieFriction('teams', 'teammate-not-found', `No teammate matching '${ref}' in team ${team}`, 2);
    if (lookup.kind === 'ambiguous') {
      const shorts = lookup.matches.map(shortId).join(', ');
      dieFriction('teams', 'teammate-ambiguous', `'${ref}' matches multiple teammates: ${shorts}. Use more characters or a name.`, 2);
    }
    const agentId = (lookup as { kind: 'ok'; agentId: string }).agentId;

    // mgr.get reconciles the teammate's status (PID + start-time guard / remote
    // .exit sentinel / exit-code reap) before we branch — so running-vs-stopped
    // is a fact, not a guess.
    const agent = await mgr.get(agentId);
    if (!agent) dieFriction('teams', 'teammate-vanished', `Teammate ${shortId(agentId)} vanished from team ${team}.`);
    const display = agent!.name || shortId(agentId);
    const status = agent!.status;
    const hasMessage = message != null && message.trim().length > 0;

    const route = decideTeamMessageRoute(status, hasMessage);
    switch (route.kind) {
      case 'not-started':
        dieFriction('teams', 'teammate-not-started', `Teammate '${display}' hasn't started yet (waiting on --after deps). Run \`agents teams start ${team}\` to launch it.`);
        return;
      case 'need-message':
        if (status === AgentStatus.RUNNING) {
          dieFriction('teams', 'steer-needs-message', `Teammate '${display}' is running — pass a message to steer it.`);
        }
        dieFriction('teams', 'resume-needs-message', `Teammate '${display}' is ${status} — pass a message to resume it: \`agents teams resume ${team} ${display} "<message>"\`.`);
        return;
      case 'steer': {
        // Running -> steer via mailbox; never re-launch (that forks a 2nd session).
        enqueue(mailboxDir(agentId), { to: agentId, text: message!, from: opts.from });
        if (isJsonMode(opts)) {
          console.log(JSON.stringify({ team, agent_id: agentId, name: agent!.name ?? null, action: 'steer', status }, null, 2));
          return;
        }
        console.log(
          chalk.green(`Steering ${chalk.cyan(display)} (running) — `) +
            chalk.dim('message queued; it will see it at its next tool call.'),
        );
        return;
      }
      case 'resume': {
        // Stopped / completed / failed -> resume its own session with the message.
        try {
          await mgr.resumeTeammate(agentId, message!);
        } catch (err) {
          dieFriction('teams', 'resume-failed', (err as Error).message);
        }
        if (isJsonMode(opts)) {
          console.log(JSON.stringify({ team, agent_id: agentId, name: agent!.name ?? null, action: 'resume', prior_status: status }, null, 2));
          return;
        }
        console.log(
          chalk.green(`Resuming ${chalk.cyan(display)} `) +
            chalk.dim(`(was ${status}) in team ${team} — re-entering its session with your message.`),
        );
        console.log(chalk.dim(`Track it with \`agents teams status ${team}\`.`));
        return;
      }
    }
  }

  addHostOption(teams.command('message <team> <teammate> <message>'))
    .description('Send a follow-up message to a teammate. A running teammate is steered via its mailbox; a stopped one is resumed — re-entering its own session with the message.')
    .option('--from <who>', 'Label recorded as the sender of this message')
    .option('--json', 'Output machine-readable JSON')
    .action(async (team: string, ref: string, message: string, opts: { json?: boolean; from?: string }) => {
      await teamMessageAction(team, ref, message, opts);
    });

  addHostOption(teams.command('resume <team> <teammate> [message]'))
    .description("Resume a stopped teammate (completed/failed/stopped) by re-entering its own session with a message as the next user turn. If the teammate is still running, the message is steered via its mailbox instead.")
    .option('--from <who>', 'Label recorded as the sender of this message')
    .option('--json', 'Output machine-readable JSON')
    .action(async (team: string, ref: string, message: string | undefined, opts: { json?: boolean; from?: string }) => {
      await teamMessageAction(team, ref, message, opts);
    });

  // remove
  teams
    .command('remove [team] [teammate]')
    .alias('rm')
    .description("Remove a stopped teammate's logs and metadata. Use 'stop' first to end a running teammate.")
    .option('--keep-logs', 'Keep their log files on disk (default: delete them)')
    .option('--json', 'Output machine-readable JSON')
    .action(async (team: string | undefined, ref: string | undefined, opts: { keepLogs?: boolean; json?: boolean }) => {
      const mgr = mkManager();

      if (!team) {
        const { names } = await loadTeamRows(mgr);
        requireDestructiveArg({
          argName: 'team',
          command: 'agents teams remove',
          itemNoun: 'team',
          available: names,
          emptyHint: "You don't have any teams yet.",
        });
      }
      if (!ref) {
        const roster = await mgr.listByTask(team);
        const stopped = roster.filter((a) => a.status !== 'running' && a.status !== 'pending');
        requireDestructiveArg({
          argName: 'teammate',
          command: `agents teams remove ${team}`,
          itemNoun: 'stopped teammate',
          available: stopped.map((a) => a.name || shortId(a.agentId)),
          emptyHint: `Team ${team} has no stopped teammates. Use 'agents teams stop' first.`,
        });
      }

      const lookup = await mgr.resolveAgentIdInTask(team, ref);
      if (lookup.kind === 'none') {
        dieFriction('teams', 'teammate-not-found', `No teammate matching '${ref}' in team ${team}`, 2);
      }
      if (lookup.kind === 'ambiguous') {
        const shorts = lookup.matches.map(shortId).join(', ');
        dieFriction('teams', 'teammate-ambiguous', `'${ref}' matches multiple teammates: ${shorts}. Use more characters or a name.`, 2);
      }
      const agentId = lookup.agentId;

      const agent = await mgr.get(agentId);
      const display = agent?.name || shortId(agentId);

      // Require agent to be stopped first
      if (agent?.status === 'running' || agent?.status === 'pending') {
        dieFriction('teams', 'remove-still-running', `Teammate '${display}' is still ${agent.status}. Run 'agents teams stop ${team} ${display}' first.`);
      }

      if (!opts.keepLogs) {
        try {
          const dir = path.join(await getAgentsDir(), agentId);
          await fs.rm(dir, { recursive: true, force: true });
        } catch {
          // best-effort cleanup
        }
      }

      if (isJsonMode(opts)) {
        console.log(JSON.stringify({ team, agent_id: agentId, name: agent?.name ?? null, removed: true }, null, 2));
        return;
      }

      console.log(chalk.green(`Removed ${chalk.cyan(display)} from team ${chalk.cyan(team)}.`));
    });

  // disband
  teams
    .command('disband [team]')
    .alias('d')
    .description('Disband the team. Stops all teammates cleanly and removes the team registry entry.')
    .option('--keep-logs', 'Keep all teammate logs on disk (default: delete them)')
    .option('--json', 'Output machine-readable JSON')
    .action(async (team: string | undefined, opts: { keepLogs?: boolean; json?: boolean }) => {
      const mgr = mkManager();

      if (!team) {
        const { names } = await loadTeamRows(mgr);
        requireDestructiveArg({
          argName: 'team',
          command: 'agents teams disband',
          itemNoun: 'team',
          available: names,
          emptyHint: "You don't have any teams to disband.",
        });
      }

      const stopRes = await handleStop(mgr, team);
      if ('error' in stopRes) dieFriction('teams', 'stop-failed', stopRes.error);

      // Snapshot the roster once for worktree cleanup + messaging. Purge below
      // is the terminal removal of teammate records (RUSH-2450).
      const status = await handleStatus(mgr, team, 'all');
      const rosterBefore = status.agents;

      // Clean up worktrees for all teammates
      const baseCwd = process.cwd();
      const keptWorktrees: string[] = [];
      for (const a of rosterBefore) {
        const agent = await mgr.get(a.agent_id);
        if (agent?.worktreeName && agent?.worktreePath) {
          try {
            if (agent.hostName && agent.hostTarget && agent.repoPath) {
              // Distributed teammate: guard + remove the worktree ON THE HOST.
              const ssh = { extraSshArgs: agent.hostIdentityFile ? ['-i', agent.hostIdentityFile, '-o', 'IdentitiesOnly=yes'] : [] };
              if (remoteWorktreeDirty(agent.hostTarget, agent.worktreePath, ssh)) {
                keptWorktrees.push(agent.worktreeName);
              } else {
                removeRemoteWorktree(agent.hostTarget, agent.repoPath, agent.worktreeName, true, ssh);
              }
            } else {
              const dirty = await hasUncommittedChanges(agent.worktreePath);
              if (dirty) {
                keptWorktrees.push(agent.worktreeName);
              } else {
                await removeWorktree(baseCwd, agent.worktreeName);
              }
            }
          } catch { /* best-effort */ }
        }
      }

      // Drop the registry entry FIRST so any concurrent supervisor's saveMeta
      // (RUSH-2450) refuses to re-persist teammates for this team, then purge
      // the durable teammate records + in-memory cache. Order matters: purge
      // after removeTeam closes the race where a supervisor re-writes meta
      // between the two steps.
      const existed = await removeTeam(team);
      const removedIds = await mgr.purgeByTask(team, { keepLogs: Boolean(opts.keepLogs) });

      if (isJsonMode(opts)) {
        console.log(JSON.stringify({
          team,
          existed,
          stopped: stopRes.stopped,
          removed_members: removedIds,
          already_gone: !existed && rosterBefore.length === 0 && removedIds.length === 0,
        }, null, 2));
        return;
      }
      if (!existed && stopRes.stopped.length === 0 && rosterBefore.length === 0 && removedIds.length === 0) {
        // Second disband on a fully-gone team: clean no-op, not a false success
        // that claims N logs were cleared again.
        dieFriction('teams', 'team-not-found', `No team called '${team}' (already disbanded or never created)`, 2);
      }
      console.log(chalk.green(`Team ${chalk.cyan(team)} disbanded.`));
      if (stopRes.stopped.length) console.log(chalk.gray(`  Stopped ${stopRes.stopped.length} working teammate(s).`));
      if (removedIds.length && !opts.keepLogs) {
        console.log(chalk.gray(`  Cleared ${removedIds.length} teammate record(s).`));
      } else if (removedIds.length && opts.keepLogs) {
        console.log(chalk.gray(`  Removed ${removedIds.length} teammate record(s); logs kept.`));
      }
      if (keptWorktrees.length) {
        console.log(chalk.yellow(`  Kept ${keptWorktrees.length} worktree(s) with uncommitted changes: ${keptWorktrees.join(', ')}`));
      }
    });

  // logs
  teams
    .command('logs [teammate]')
    .alias('log')
    .description("Show a teammate's concise session summary. --full (or -n <lines>) for the raw stdout. Accepts positional name, --teammate <name>, UUID, or UUID prefix.")
    .option('-n, --tail <n>', 'Show the last N lines of raw stdout instead of the concise summary')
    .option('-m, --full', 'Show the full raw stdout log instead of the concise summary')
    .option('--team <team>', 'Disambiguate when the same name appears in multiple teams')
    .option('--teammate <name>', 'Teammate name (alias for the positional arg; useful for scripts)')
    .action(async (ref: string | undefined, opts: { tail?: string; full?: boolean; team?: string; teammate?: string }) => {
      const base = await getAgentsDir();

      // Resolve teammate identity. Precedence:
      //   1. positional `[teammate]` arg (back-compat, most common)
      //   2. --teammate <name> flag (script-friendly alias)
      //   3. interactive picker (TTY only)
      const teammateRef = ref ?? opts.teammate;

      let agentId: string;
      if (!teammateRef) {
        const mgr = mkManager();
        const picked = await pickTeammateOr(mgr, 'agents teams logs');
        if (!picked) return;
        agentId = picked.agentId;
      } else {
        const resolved = await resolveTeammateAcrossTeams(base, teammateRef, opts.team);
        if (resolved.kind === 'none') {
          dieFriction('teams', 'teammate-notes-not-found', `No notes on record for teammate '${teammateRef}'`, 2);
        }
        if (resolved.kind === 'ambiguous') {
          const hints = resolved.candidates.map((c) => `${c.team}/${c.display}`).join(', ');
          dieFriction(
            'teams',
            'teammate-notes-ambiguous',
            `'${teammateRef}' matches multiple teammates: ${hints}.\n` +
              `  Narrow it with --team <team>, or pass a UUID prefix.`,
            2
          );
        }
        agentId = resolved.agentId;
      }

      // Concise by default: a teammate's agentId IS its agent session id (passed
      // as --session-id at launch), so render the same summary digest as
      // `agents sessions <id>`. --full / -n <lines> opt into the raw stdout.log.
      if (!opts.full && !opts.tail) {
        const all = await discoverSessions({ all: true, limit: 5000 });
        const matches = resolveSessionById(all, agentId);
        if (matches.length > 0) {
          await renderSessionLog(matches[0], 'summary');
          return;
        }
        // No resolvable session (e.g. a non-Claude teammate) — fall through to a
        // bounded tail of raw stdout rather than dumping the whole file.
      }

      const logPath = path.join(base, agentId, 'stdout.log');
      try {
        const content = await fs.readFile(logPath, 'utf-8');
        if (opts.full) {
          process.stdout.write(content);
          return;
        }
        // Default tail size keeps an un-resolvable teammate's glance bounded too.
        const n = opts.tail ? Math.max(1, parseInt(opts.tail, 10) || 50) : 40;
        const lines = content.split('\n');
        process.stdout.write(lines.slice(-n).join('\n'));
      } catch {
        dieFriction('teams', 'teammate-notes-not-found', `No notes on record for teammate '${teammateRef ?? agentId}' (looked in ${logPath})`, 2);
      }
    });

  // doctor
  teams
    .command('doctor')
    .alias('dr')
    .description('Check which agents are installed and available to join a team. Verifies CLI paths and shows an advisory sign-in hint.')
    .option('--json', 'Output machine-readable JSON')
    .action(async (opts: { json?: boolean }) => {
      const data = await collectTeamsDoctorData();

      if (isJsonMode(opts)) {
        console.log(JSON.stringify(data, null, 2));
        return;
      }
      console.log(chalk.bold('Who can join a team:'));
      for (const [name, entry] of Object.entries(data)) {
        const pretty = AGENT_NAMES[name as AgentType] || name;
        if (entry.installed) {
          const { signedIn, running: isRunning } = entry;
          const hint = isRunning
            ? chalk.gray('in use')
            : signedIn
              ? chalk.gray('signed in')
              : chalk.gray('sign-in unverified');
          console.log(`  ${chalk.green('ready')}  ${pretty.padEnd(10)} ${chalk.gray(entry.path || '')}  ${hint}`);
        } else {
          console.log(`  ${chalk.red('no   ')}  ${pretty.padEnd(10)} ${chalk.gray(entry.error || 'not installed')}`);
        }
      }
    });
}
