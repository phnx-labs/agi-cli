import { spawn, execSync, execFileSync, ChildProcess } from 'child_process';
import { getAgentsInvocation } from '../daemon/daemon.js';
import * as fs from 'fs/promises';
import * as fsSync from 'fs';
import * as path from 'path';
import * as os from 'os';
import { randomUUID } from 'crypto';
import { resolveAgentsDir } from './persistence.js';
import { findExecutable, captureProcessStartTime } from '../platform/index.js';
import { normalizeEvents, AgentType } from './parsers.js';
import { debug } from './debug.js';
import type { AgentId } from '../types.js';
import { getAgentsDir as getSystemAgentsDir, getShimsDir } from '../state.js';
import { AGENTS, getAccountInfo } from '../agents.js';
import { resolveVersion, isVersionInstalled, verifyInstalledBinaryLaunches } from '../installations/versions.js';
import { sanitizeProcessEnv } from '../secrets-client.js';
import { resolveActor, actorEnv } from '../actor.js';
import { recordRunName } from '../session/run-names.js';
import { sshExec, shellQuote } from '../ssh-exec.js';
import { resolveHost } from '../hosts/registry.js';
import { sshTargetFor } from '../hosts/types.js';
import { dispatchAgentsCommand, terminateDispatchedTask } from '../hosts/dispatch.js';
import { ensureHostReady } from '../hosts/ready.js';
import { remoteShellFor } from '../hosts/remote-cmd.js';
import { resolveRemoteOsSync } from '../hosts/remote-os.js';
import { pullRemoteLogDelta, REMOTE_MIRROR_MAX_BYTES } from '../hosts/progress.js';
import { createRemoteWorktree, ensureRemoteRepo } from './remoteWorktree.js';
import { getTeam, isTeamDisbanded } from './registry.js';
import { atomicWriteJsonSync } from '../fs-atomic.js';
import {
  resolvePlacement,
  classifyExclusions,
  isTransientPlacementBlock,
  NoViableDeviceError,
} from './scheduler.js';
import { probePoolSignals } from './placement-probe.js';
import { readMaxConcurrentCaps } from '../device-config.js';
import { filterAutoPool, listWorkerDevices } from '../devices/pool.js';
import { redactSecrets, sanitizeForTerminal } from '../redact.js';
import chalk from 'chalk';

let lastMemoryWarnAt = 0;

function availableMemoryBytes(): number {
  if (process.platform !== 'darwin') return os.freemem();
  try {
    const out = execSync('vm_stat', { encoding: 'utf8', timeout: 1000 });
    const pageSizeMatch = out.match(/page size of (\d+) bytes/);
    const pageSize = pageSizeMatch ? Number(pageSizeMatch[1]) : 4096;
    const grab = (label: string): number => {
      const m = out.match(new RegExp(`${label}:\\s+(\\d+)\\.`));
      return m ? Number(m[1]) : 0;
    };
    const pages =
      grab('Pages free') +
      grab('Pages inactive') +
      grab('Pages purgeable') +
      grab('Pages speculative');
    if (pages <= 0) return os.freemem();
    return pages * pageSize;
  } catch {
    return os.freemem();
  }
}

function warnIfMemoryLow(runningCount: number): void {
  const total = os.totalmem();
  if (total <= 0) return;
  const available = availableMemoryBytes();
  const freeRatio = available / total;
  if (freeRatio >= 0.15) return;
  const now = Date.now();
  if (now - lastMemoryWarnAt < 60_000) return;
  lastMemoryWarnAt = now;
  const freeGb = (available / 1024 ** 3).toFixed(1);
  const totalGb = (total / 1024 ** 3).toFixed(1);
  process.stderr.write(
    `Heads up: only ${freeGb}GB of ${totalGb}GB free with ${runningCount} teammates already running. ` +
      `Spawning more may slow your machine.\n`
  );
}

export function computePathLCA(paths: string[]): string | null {
  const validPaths = paths.filter(p => p && p.trim());
  if (validPaths.length === 0) return null;
  if (validPaths.length === 1) return validPaths[0];

  const splitPaths = validPaths.map(p => {
    const normalized = path.resolve(p);
    return normalized.split(path.sep).filter(seg => seg);
  });

  const minLen = Math.min(...splitPaths.map(p => p.length));

  const commonSegments: string[] = [];
  for (let i = 0; i < minLen; i++) {
    const segment = splitPaths[0][i];
    const allMatch = splitPaths.every(p => p[i] === segment);
    if (allMatch) {
      commonSegments.push(segment);
    } else {
      break;
    }
  }

  if (commonSegments.length === 0) return null;

  const lca = path.sep + commonSegments.join(path.sep);
  return lca;
}

export enum AgentStatus {
  PENDING = 'pending',
  RUNNING = 'running',
  COMPLETED = 'completed',
  FAILED = 'failed',
  STOPPED = 'stopped',
}

export const TERMINAL_STATUSES: ReadonlySet<AgentStatus> = new Set([
  AgentStatus.COMPLETED,
  AgentStatus.FAILED,
  AgentStatus.STOPPED,
]);
// Retention owns terminal records only; pending/running teammates may still hold work.

function isTerminalStatus(status: AgentStatus): boolean {
  return TERMINAL_STATUSES.has(status);
}

export type TeammateFailureStage = 'placement' | 'spawn' | 'execution' | 'dependency' | 'cloud';

export interface TeammateFailure {
  stage: TeammateFailureStage;
  code: string;
  message: string;
  exit_code: number | null;
  retryable: boolean;
  observed_at: string;
}

function safeFailureMessage(message: string): string {
  return redactSecrets(sanitizeForTerminal(message)).replace(/\s+/g, ' ').trim().slice(0, 500);
}

interface RemoteLivenessSnapshot {
  alive: boolean;
  exit: string | null;
  exitFilePresent: boolean;
}

export function remoteLivenessSnippet(id: string, exitFile: string, pid: number): string {
  // Missing process plus missing exit sentinel is terminal failure, never indefinite running.
  return (
    `printf '%s ' ${shellQuote(id)}; ` +
    `if [ -f ${exitFile} ]; then printf 'EXITED '; cat ${exitFile} 2>/dev/null | tr -d '\\n'; printf '\\n'; ` +
    `elif kill -0 ${pid} 2>/dev/null; then printf 'ALIVE\\n'; ` +
    `else printf 'GONE\\n'; fi`
  );
}

export function parseRemoteLivenessState(state: string, code: string | undefined): RemoteLivenessSnapshot {
  if (state === 'ALIVE') return { alive: true, exit: null, exitFilePresent: false };
  if (state === 'EXITED') return { alive: false, exit: code ?? '', exitFilePresent: true };
  return { alive: false, exit: null, exitFilePresent: false };
}

export type TaskType = 'plan' | 'implement' | 'test' | 'review' | 'bugfix' | 'docs';
export const VALID_TASK_TYPES: readonly TaskType[] = [
  'plan', 'implement', 'test', 'review', 'bugfix', 'docs',
] as const;

function hasTransitiveDep(
  byName: Map<string, { after: string[] }>,
  startName: string,
  targetName: string,
  seen: Set<string> = new Set()
): boolean {
  if (seen.has(startName)) return false;
  seen.add(startName);
  const node = byName.get(startName);
  if (!node) return false;
  for (const dep of node.after) {
    if (dep === targetName) return true;
    if (hasTransitiveDep(byName, dep, targetName, seen)) return true;
  }
  return false;
}

export type { AgentType } from './parsers.js';

function shSingleQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function buildSentinelCommand(cmd: string[], exitCodePath: string): string {
  return `${cmd.map(shSingleQuote).join(' ')}; echo $? > ${shSingleQuote(exitCodePath)}`;
}

export function buildTeammateSpawnEnv(
  envOverrides: Record<string, string> | null,
): NodeJS.ProcessEnv {
  return {
    ...sanitizeProcessEnv(process.env),
    ...actorEnv(resolveActor()),
    ...(envOverrides ?? {}),
  };
}

export { captureProcessStartTime };

const TEAM_AGENT_TYPES: AgentType[] = ['codex', 'cursor', 'claude', 'opencode', 'grok', 'antigravity', 'kimi', 'droid', 'warp'];

export type EffortLevel = 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'auto';

const PROMPT_SUFFIX = `

When you're done, provide a brief summary of:
1. What you did (1-2 sentences)
2. Key files modified and why
3. Any important classes, functions, or components you added/changed`;

const CLAUDE_PLAN_MODE_PREFIX = `You are running in HEADLESS PLAN MODE. This mode works like normal plan mode with one exception: you cannot write to ~/.claude/plans/ directory. Instead of writing a plan file, output your complete plan/response as your final message.

`;

const TEAMMATE_PR_POLICY = `

Teammate PR policy (agents teams): when your work opens a pull request, open it and
hand it off — do NOT merge your OWN PR unless a NON-AUTHOR review verdict has been
posted on that same PR. You authenticate as the repo owner and share that one
GitHub identity with every other teammate, so an APPROVE you post on your own PR
does not count as a non-author review. \`gh pr merge\` on your own PR is blocked by
merge-guard until a genuine non-author verdict exists on it; never pass --admin or
otherwise route around that guard. Report the PR as open and let the orchestrator
or a separate reviewer take it to merge.`;

export function withTeammatePrPolicy(prompt: string, mode: string): string {
  return mode === 'plan' ? prompt : prompt + TEAMMATE_PR_POLICY;
}

export const VALID_MODES = ['plan', 'edit', 'auto', 'skip', 'full'] as const;
type Mode = 'plan' | 'edit' | 'auto' | 'skip';

function normalizeModeValue(modeValue: string | null | undefined): Mode | null {
  if (!modeValue) return null;
  const normalized = modeValue.trim().toLowerCase();
  if (normalized === 'full') return 'skip';
  if ((['plan', 'edit', 'auto', 'skip'] as readonly string[]).includes(normalized)) {
    return normalized as Mode;
  }
  return null;
}

function defaultModeFromEnv(): Mode {
  for (const envVar of ['AGENTS_MCP_MODE', 'AGENTS_MCP_DEFAULT_MODE']) {
    const rawValue = process.env[envVar];
    const parsed = normalizeModeValue(rawValue);
    if (parsed) {
      return parsed;
    }
    if (rawValue) {
      console.warn(`Invalid ${envVar}='${rawValue}'. Use plan, edit, auto, or skip. Falling back to plan mode.`);
    }
  }
  return 'plan';
}

function coerceDate(value: unknown): Date | null {
  if (value === null || value === undefined) return null;

  if (typeof value === 'number' && Number.isFinite(value)) {
    const ms = value < 1e12 ? value * 1000 : value;
    const date = new Date(ms);
    return Number.isNaN(date.getTime()) ? null : date;
  }

  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return null;
    const numeric = Number(trimmed);
    if (!Number.isNaN(numeric)) {
      const ms = numeric < 1e12 ? numeric * 1000 : numeric;
      const date = new Date(ms);
      if (!Number.isNaN(date.getTime())) return date;
    }
    const date = new Date(trimmed);
    return Number.isNaN(date.getTime()) ? null : date;
  }

  return null;
}

function extractTimestamp(raw: any): Date | null {
  if (!raw || typeof raw !== 'object') return null;

  const candidates = [
    raw.timestamp,
    raw.time,
    raw.created_at,
    raw.createdAt,
    raw.ts,
    raw.started_at,
    raw.startedAt,
  ];

  for (const candidate of candidates) {
    const date = coerceDate(candidate);
    if (date) return date;
  }

  return null;
}

export function resolveMode(
  requestedMode: string | null | undefined,
  defaultMode: Mode = 'plan'
): Mode {
  const normalizedDefault = normalizeModeValue(defaultMode);
  if (!normalizedDefault) {
    throw new Error(`Invalid default mode '${defaultMode}'. Use plan, edit, auto, or skip.`);
  }

  if (requestedMode !== null && requestedMode !== undefined) {
    const normalizedMode = normalizeModeValue(requestedMode);
    if (!normalizedMode) {
      throw new Error(`Invalid mode '${requestedMode}'. Valid modes: plan (read-only), edit (can write), auto (smart classifier), skip (bypass all permissions). 'full' is accepted as alias for skip.`);
    }
    return normalizedMode;
  }

  return normalizedDefault;
}

export function checkCliAvailable(agentType: AgentType): [boolean, string | null] {
  const agent = agentType as AgentId;
  const executable = AGENTS[agent]?.cliCommand;
  if (!executable) {
    return [false, `Unknown agent type: ${agentType}`];
  }

  const shimPath = path.join(getShimsDir(), executable);
  const dispatch = fsSync.existsSync(shimPath) ? shimPath : findExecutable(executable);
  if (!dispatch) {
    return [false, `CLI tool '${executable}' not found in PATH. Install it first.`];
  }

  const version = resolveVersion(agent);
  if (version && !isVersionInstalled(agent, version)) {
    return [false, `${executable}@${version} is not runnable — its binary is missing/incomplete. Repair: agents add ${agent}@${version}`];
  }
  return [true, dispatch];
}

export function checkAllClis(): Record<string, { installed: boolean; path: string | null; error: string | null }> {
  const results: Record<string, { installed: boolean; path: string | null; error: string | null }> = {};
  for (const agentType of TEAM_AGENT_TYPES) {
    const [available, pathOrError] = checkCliAvailable(agentType);
    if (available) {
      results[agentType] = { installed: true, path: pathOrError, error: null };
    } else {
      results[agentType] = { installed: false, path: null, error: pathOrError };
    }
  }
  return results;
}

/**
 * Advisory sign-in probe for a teammate's agent. Reads the account-global login
 * (no `home` → active config) via `getAccountInfo`. Deliberately best-effort:
 * sign-in detection is UNRELIABLE for opaque-credential agents (Kimi/Antigravity
 * store an OAuth/JWT with no email claim) and for keychain-probed agents, so a
 * `false` here is often a false negative. Callers must WARN and continue — never
 * block a team on this result. Never throws (returns false on any error).
 */
export async function checkCliSignedIn(agentType: AgentType): Promise<boolean> {
  try {
    const info = await getAccountInfo(agentType as AgentId);
    return info.signedIn;
  } catch {
    return false;
  }
}

interface SignInAdvisory {
  signedIn: boolean | null;
  running: boolean;
}

export function resolveSignInAdvisory(
  installed: boolean,
  running: boolean,
  probeSignedIn: boolean
): SignInAdvisory {
  if (!installed) return { signedIn: null, running: false };
  return { signedIn: running ? true : probeSignedIn, running };
}

export interface TeamsDoctorEntry {
  installed: boolean;
  path: string | null;
  error: string | null;
  signedIn: boolean | null;
  running: boolean;
}

export async function collectTeamsDoctorData(): Promise<Record<string, TeamsDoctorEntry>> {
  const info = checkAllClis();

  await Promise.all(
    Object.entries(info).map(async ([name, entry]) => {
      if (!entry.installed) return;
      const agent = name as AgentId;
      const version = resolveVersion(agent);
      if (!version) return;
      const health = await verifyInstalledBinaryLaunches(agent, version);
      if (!health.ok) {
        entry.installed = false;
        entry.path = null;
        entry.error = `${AGENTS[agent]?.cliCommand ?? name}@${version} is installed but its binary won't launch`
          + `${health.detail ? ` (${health.detail})` : ''}. Repair: agents add ${agent}@${version}`;
      }
    })
  );

  const running = new Set<string>();
  try {
    for (const a of await new AgentManager().listRunning()) running.add(a.agentType);
  } catch {  }

  const result: Record<string, TeamsDoctorEntry> = {};
  await Promise.all(
    Object.entries(info).map(async ([name, entry]) => {
      const isRunning = running.has(name);
      const probe = entry.installed && !isRunning ? await checkCliSignedIn(name as AgentType) : false;
      const auth = resolveSignInAdvisory(entry.installed, isRunning, probe);
      result[name] = { ...entry, ...auth };
    })
  );
  return result;
}

let AGENTS_DIR: string | null = null;

export async function getAgentsDir(): Promise<string> {
  if (!AGENTS_DIR) {
    AGENTS_DIR = await resolveAgentsDir();
  }
  return AGENTS_DIR;
}

export class AgentProcess {
  agentId: string;
  taskName: string;
  agentType: AgentType;
  prompt: string;
  cwd: string | null;
  workspaceDir: string | null;
  mode: Mode = 'plan';
  pid: number | null = null;
  startTime: string | null = null;
  status: AgentStatus = AgentStatus.RUNNING;
  startedAt: Date = new Date();
  completedAt: Date | null = null;
  parentSessionId: string | null = null;
  actor: string | null = null;
  cloudSessionId: string | null = null;
  cloudProvider: string | null = null;
  prUrl: string | null = null;
  version: string | null = null;
  remoteSessionId: string | null = null;
  name: string | null = null;
  after: string[] = [];
  effort: EffortLevel | null = null;
  model: string | null = null;
  profileName: string | null = null;
  envOverrides: Record<string, string> | null = null;
  taskType: TaskType | null = null;
  cloudRepo: string | null = null;
  cloudBranch: string | null = null;
  worktreeName: string | null = null;
  worktreePath: string | null = null;
  project: string | null = null;
  hostName: string | null = null;
  hostTarget: string | null = null;
  hostIdentityFile: string | null = null;
  repoPath: string | null = null;
  remotePid: number | null = null;
  remoteLog: string | null = null;
  remoteExit: string | null = null;
  failure: TeammateFailure | null = null;
  remoteLogOffset: number = 0;
  remotePollSnapshot: RemoteLivenessSnapshot | null = null;
  private eventsCache: any[] = [];
  private lastReadPos: number = 0;
  private baseDir: string | null = null;

  constructor(
    agentId: string,
    taskName: string,
    agentType: AgentType,
    prompt: string,
    cwd: string | null = null,
    mode: Mode = 'plan',
    pid: number | null = null,
    status: AgentStatus = AgentStatus.RUNNING,
    startedAt: Date = new Date(),
    completedAt: Date | null = null,
    baseDir: string | null = null,
    parentSessionId: string | null = null,
    workspaceDir: string | null = null,
    cloudSessionId: string | null = null,
    cloudProvider: string | null = null,
    prUrl: string | null = null,
    version: string | null = null,
    remoteSessionId: string | null = null,
    name: string | null = null,
    after: string[] = [],
    effort: EffortLevel | null = null,
    model: string | null = null,
    envOverrides: Record<string, string> | null = null,
    taskType: TaskType | null = null,
    cloudRepo: string | null = null,
    cloudBranch: string | null = null,
    worktreeName: string | null = null,
    worktreePath: string | null = null,
    profileName: string | null = null,
  ) {
    this.agentId = agentId;
    this.remoteSessionId = remoteSessionId;
    this.name = name;
    this.after = after;
    this.effort = effort;
    this.model = model;
    this.profileName = profileName;
    this.envOverrides = envOverrides;
    this.taskType = taskType;
    this.cloudRepo = cloudRepo;
    this.cloudBranch = cloudBranch;
    this.worktreeName = worktreeName;
    this.worktreePath = worktreePath;
    this.taskName = taskName;
    this.agentType = agentType;
    this.prompt = prompt;
    this.cwd = cwd;
    this.workspaceDir = workspaceDir;
    this.mode = mode;
    this.pid = pid;
    this.status = status;
    this.startedAt = startedAt;
    this.completedAt = completedAt;
    this.baseDir = baseDir;
    this.parentSessionId = parentSessionId;
    this.actor = resolveActor().id;
    this.cloudSessionId = cloudSessionId;
    this.cloudProvider = cloudProvider;
    this.prUrl = prUrl;
    this.version = version;
  }

  get isEditMode(): boolean {
    return this.mode === 'edit' || this.mode === 'auto' || this.mode === 'skip';
  }

  async getAgentDir(): Promise<string> {
    const base = this.baseDir || await getAgentsDir();
    return path.join(base, this.agentId);
  }

  async toSnapshot(): Promise<{
    agent_id: string;
    team_id: string;
    teammate_name: string | null;
    agent_type: string;
    task_type: string | null;
    status: string;
    started_at: string;
    completed_at: string | null;
    after: string[];
    cloud_provider: string | null;
    cloud_session_id: string | null;
    cloud_repo: string | null;
    cloud_branch: string | null;
    failure: TeammateFailure | null;
    agent_dir: string;
    cwd: string | null;
  }> {
    return {
      agent_id: this.agentId,
      team_id: this.taskName,
      teammate_name: this.name,
      agent_type: this.agentType,
      task_type: this.taskType,
      status: this.status,
      started_at: this.startedAt.toISOString(),
      completed_at: this.completedAt?.toISOString() ?? null,
      after: this.after,
      cloud_provider: this.cloudProvider,
      cloud_session_id: this.cloudSessionId,
      cloud_repo: this.cloudRepo,
      cloud_branch: this.cloudBranch,
      failure: this.failure,
      agent_dir: await this.getAgentDir(),
      cwd: this.cwd,
    };
  }

  async getStdoutPath(): Promise<string> {
    return path.join(await this.getAgentDir(), 'stdout.log');
  }

  async getMetaPath(): Promise<string> {
    return path.join(await this.getAgentDir(), 'meta.json');
  }

  async getExitCodePath(): Promise<string> {
    return path.join(await this.getAgentDir(), 'exit_code');
  }

  toDict(): any {
    return {
      agent_id: this.agentId,
      task_name: this.taskName,
      agent_type: this.agentType,
      status: this.status,
      started_at: this.startedAt.toISOString(),
      completed_at: this.completedAt?.toISOString() || null,
      event_count: this.events.length,
      duration: this.duration(),
      mode: this.mode,
      parent_session_id: this.parentSessionId,
      actor: this.actor,
      workspace_dir: this.workspaceDir,
      cloud_session_id: this.cloudSessionId,
      cloud_provider: this.cloudProvider,
      pr_url: this.prUrl,
      version: this.version,
      remote_session_id: this.remoteSessionId,
      name: this.name,
      after: this.after,
      effort: this.effort,
      model: this.model,
      profile_name: this.profileName,
      env_overrides: this.envOverrides,
      task_type: this.taskType,
      cloud_repo: this.cloudRepo,
      cloud_branch: this.cloudBranch,
      failure: this.failure,
    };
  }

  duration(): string | null {
    let seconds: number;
    if (this.completedAt) {
      seconds = (this.completedAt.getTime() - this.startedAt.getTime()) / 1000;
    } else if (this.status === AgentStatus.RUNNING) {
      seconds = (Date.now() - this.startedAt.getTime()) / 1000;
    } else {
      return null;
    }

    if (seconds < 60) {
      return `${Math.floor(seconds)} seconds`;
    } else {
      const minutes = seconds / 60;
      return `${minutes.toFixed(1)} minutes`;
    }
  }

  get events(): any[] {
    return this.eventsCache;
  }

  private getLatestEventTime(): Date | null {
    let latest: Date | null = null;

    for (const event of this.eventsCache) {
      const ts = event?.timestamp;
      if (!ts) continue;
      const parsed = new Date(ts);
      if (!Number.isNaN(parsed.getTime())) {
        if (!latest || parsed > latest) {
          latest = parsed;
        }
      }
    }

    return latest;
  }

  private async syncRemoteMirror(): Promise<void> {
    if (!this.hostName || !this.hostTarget || !this.remoteLog) return;
    if (this.status !== AgentStatus.RUNNING) return;

    const delta = pullRemoteLogDelta(this.hostTarget, {
      remoteLog: this.remoteLog,
      offset: this.remoteLogOffset,
      extraSshArgs: this.hostIdentityFile ? ['-i', this.hostIdentityFile, '-o', 'IdentitiesOnly=yes'] : [],
    });
    if (delta && delta.bytes.length > 0) {
      const stdoutPath = await this.getStdoutPath();
      try {
        await fs.appendFile(stdoutPath, delta.bytes);
        this.remoteLogOffset = delta.newOffset;
      } catch {
      }
    }

    const snap = this.remotePollSnapshot ?? (await this.probeRemoteLiveness());
    if (!snap) return;

    if (snap.exit !== null && snap.exit.trim() !== '' && this.status === AgentStatus.RUNNING) {
      const code = Number.parseInt(snap.exit.trim(), 10);
      if (Number.isFinite(code)) {
        this.status = code === 0 ? AgentStatus.COMPLETED : AgentStatus.FAILED;
        if (code !== 0) {
          this.failure = {
            stage: 'execution', code: 'remote-process-exit-nonzero',
            message: `Remote teammate process exited with code ${code}.`, exit_code: code,
            retryable: false, observed_at: new Date().toISOString(),
          };
        }
        if (!this.completedAt) this.completedAt = new Date();
        return;
      }
    }

    if (this.status === AgentStatus.RUNNING && !snap.alive && !snap.exitFilePresent) {
      this.status = AgentStatus.FAILED;
      this.failure = {
        stage: 'execution', code: 'remote-process-gone',
        message: 'Remote teammate process disappeared before recording an exit code.', exit_code: null,
        retryable: true, observed_at: new Date().toISOString(),
      };
      if (!this.completedAt) this.completedAt = this.getLatestEventTime() || this.startedAt || new Date();
    }
  }

  private async probeRemoteLiveness(): Promise<RemoteLivenessSnapshot | null> {
    if (!this.hostTarget || !this.remotePid || !this.remoteExit) return null;
    const res = sshExec(this.hostTarget, remoteLivenessSnippet(this.agentId, this.remoteExit, this.remotePid), {
      timeoutMs: 8000,
      multiplex: true,
      extraSshArgs: this.hostIdentityFile ? ['-i', this.hostIdentityFile, '-o', 'IdentitiesOnly=yes'] : [],
    });
    if (res.code === null) return null;
    const trimmed = res.stdout.trim();
    if (!trimmed) return null;
    const [, state, code] = trimmed.split(/\s+/);
    if (!state) return null;
    return parseRemoteLivenessState(state, code);
  }

  resetLogReadPosition(): number {
    const previous = this.lastReadPos;
    this.lastReadPos = 0;
    return previous;
  }

  restoreLogReadPosition(position: number): void {
    this.lastReadPos = position;
  }

  async readNewEvents(opts: { skipRemote?: boolean } = {}): Promise<void> {
    if (this.hostName && opts.skipRemote) return;
    if (this.hostName) {
      await this.syncRemoteMirror();
    }
    const stdoutPath = await this.getStdoutPath();
    try {
      const stats = await fs.stat(stdoutPath).catch(() => null);
      if (!stats) return;
      const fallbackTimestamp = (stats.mtime || new Date()).toISOString();

      const fd = await fs.open(stdoutPath, 'r');
      const buffer = Buffer.alloc(1024 * 1024);
      const { bytesRead } = await fd.read(buffer, 0, buffer.length, this.lastReadPos);
      await fd.close();

      if (bytesRead === 0) return;

      const newContent = buffer.toString('utf-8', 0, bytesRead);
      this.lastReadPos += bytesRead;

      const lines = newContent.split('\n').map(l => l.trim()).filter(l => l);
      for (const line of lines) {
        try {
          const rawEvent = JSON.parse(line);
          const events = normalizeEvents(this.agentType, rawEvent);
          const resolvedTimestamp = extractTimestamp(rawEvent)?.toISOString() || fallbackTimestamp;
          for (const event of events) {
            event.timestamp = resolvedTimestamp;
            this.eventsCache.push(event);

            if (!this.remoteSessionId && event.session_id) {
              this.remoteSessionId = event.session_id;
            }

            if (event.type === 'result' || event.type === 'turn.completed' || event.type === 'thread.completed') {
              if (event.status === 'success' || event.type === 'turn.completed') {
                this.status = AgentStatus.COMPLETED;
                this.completedAt = event.timestamp ? new Date(event.timestamp) : new Date();
              } else if (event.status === 'error') {
                this.status = AgentStatus.FAILED;
                this.failure = {
                  stage: 'execution', code: 'harness-reported-error',
                  message: 'The harness reported a terminal error.', exit_code: null,
                  retryable: false, observed_at: new Date().toISOString(),
                };
                this.completedAt = event.timestamp ? new Date(event.timestamp) : new Date();
              }
            }
          }
        } catch {
          this.eventsCache.push({
            type: 'raw',
            content: line,
            timestamp: fallbackTimestamp,
          });
        }
      }
    } catch (err) {
      console.error(`Error reading events for agent ${this.agentId}:`, err);
    }

    if (this.hostName) {
      await this.capMirrorToTail();
      this.capEventsCache();
    }
  }

  private async capMirrorToTail(): Promise<void> {
    const stdoutPath = await this.getStdoutPath();
    try {
      const stats = await fs.stat(stdoutPath).catch(() => null);
      if (!stats || stats.size <= REMOTE_MIRROR_MAX_BYTES) return;
      const keep = REMOTE_MIRROR_MAX_BYTES;
      const fd = await fs.open(stdoutPath, 'r');
      const buf = Buffer.alloc(keep);
      const { bytesRead } = await fd.read(buf, 0, keep, stats.size - keep);
      await fd.close();
      await fs.writeFile(stdoutPath, buf.subarray(0, bytesRead));
      this.lastReadPos = Math.min(this.lastReadPos, bytesRead);
    } catch {
    }
  }

  private static readonly REMOTE_EVENTS_MAX = 200;

  private capEventsCache(): void {
    const max = AgentProcess.REMOTE_EVENTS_MAX;
    if (this.eventsCache.length > max) {
      this.eventsCache = this.eventsCache.slice(-max);
    }
  }

  async saveMeta(): Promise<void> {
    if (this.taskName && (await isTeamDisbanded(this.taskName))) {
      debug(
        `saveMeta: refusing to re-persist ${this.agentId} — team '${this.taskName}' was disbanded`,
      );
      return;
    }
    const agentDir = await this.getAgentDir();
    await fs.mkdir(agentDir, { recursive: true });
    const meta = {
      agent_id: this.agentId,
      task_name: this.taskName,
      agent_type: this.agentType,
      prompt: this.prompt,
      cwd: this.cwd,
      workspace_dir: this.workspaceDir,
      mode: this.mode,
      pid: this.pid,
      start_time: this.startTime,
      status: this.status,
      started_at: this.startedAt.toISOString(),
      completed_at: this.completedAt?.toISOString() || null,
      parent_session_id: this.parentSessionId,
      actor: this.actor,
      cloud_session_id: this.cloudSessionId,
      cloud_provider: this.cloudProvider,
      pr_url: this.prUrl,
      version: this.version,
      remote_session_id: this.remoteSessionId,
      name: this.name,
      after: this.after,
      effort: this.effort,
      model: this.model,
      profile_name: this.profileName,
      env_overrides: this.envOverrides,
      task_type: this.taskType,
      cloud_repo: this.cloudRepo,
      cloud_branch: this.cloudBranch,
      worktree_name: this.worktreeName,
      worktree_path: this.worktreePath,
      project: this.project,
      host_name: this.hostName,
      host_target: this.hostTarget,
      host_identity_file: this.hostIdentityFile,
      repo_path: this.repoPath,
      remote_pid: this.remotePid,
      remote_log: this.remoteLog,
      remote_exit: this.remoteExit,
      remote_log_offset: this.remoteLogOffset,
      failure: this.failure,
    };
    const metaPath = await this.getMetaPath();
    atomicWriteJsonSync(metaPath, meta);
  }

  private static async quarantineCorruptMeta(metaPath: string, cause: unknown): Promise<void> {
    const quarantinePath = `${metaPath}.corrupt`;
    const reason = cause instanceof Error ? cause.message : String(cause);
    try {
      await fs.rename(metaPath, quarantinePath);
      console.warn(`[teams] quarantined unreadable meta.json (${reason}): ${metaPath} -> ${quarantinePath}`);
    } catch (renameErr) {
      console.warn(
        `[teams] found unreadable meta.json but could not quarantine it (${reason}): ${metaPath}: ` +
          `${(renameErr as Error)?.message ?? renameErr}`,
      );
    }
  }

  static async loadFromDisk(agentId: string, baseDir: string | null = null): Promise<AgentProcess | null> {
    const base = baseDir || await getAgentsDir();
    const agentDir = path.join(base, agentId);
    const metaPath = path.join(agentDir, 'meta.json');

    let metaContent: string;
    try {
      metaContent = await fs.readFile(metaPath, 'utf-8');
    } catch (err) {
      return null;
    }

    try {
      const meta = JSON.parse(metaContent);

      const modeMap: Record<string, Mode> = {
        plan: 'plan',
        edit: 'edit',
        auto: 'auto',
        skip: 'skip',
        full: 'skip',
        ralph: 'skip',
        cloud: 'edit',
      };
      const resolvedMode: Mode = modeMap[meta.mode] || 'plan';

      const validStatuses = Object.values(AgentStatus);
      const resolvedStatus: AgentStatus = validStatuses.includes(meta.status as AgentStatus)
        ? (meta.status as AgentStatus)
        : AgentStatus.RUNNING;

      const agent = new AgentProcess(
        meta.agent_id,
        meta.task_name || 'default',
        meta.agent_type,
        meta.prompt,
        meta.cwd || null,
        resolvedMode,
        meta.pid || null,
        resolvedStatus,
        new Date(meta.started_at),
        meta.completed_at ? new Date(meta.completed_at) : null,
        baseDir,
        meta.parent_session_id || null,
        meta.workspace_dir || null,
        meta.cloud_session_id || null,
        meta.cloud_provider || null,
        meta.pr_url || null,
        meta.version || null,
        meta.remote_session_id || null,
        meta.name || null,
        Array.isArray(meta.after) ? meta.after : [],
        meta.effort || null,
        meta.model || null,
        meta.env_overrides || null,
        meta.task_type && (VALID_TASK_TYPES as readonly string[]).includes(meta.task_type)
          ? (meta.task_type as TaskType)
          : null,
        meta.cloud_repo || null,
        meta.cloud_branch || null,
        meta.worktree_name || null,
        meta.worktree_path || null,
        meta.profile_name || null,
      );
      agent.startTime = typeof meta.start_time === 'string' ? meta.start_time : null;
      agent.actor = meta.actor ?? null;
      agent.hostName = meta.host_name || null;
      agent.hostTarget = meta.host_target || null;
      agent.hostIdentityFile = meta.host_identity_file || null;
      agent.repoPath = meta.repo_path || null;
      agent.remotePid = typeof meta.remote_pid === 'number' ? meta.remote_pid : null;
      agent.remoteLog = meta.remote_log || null;
      agent.remoteExit = meta.remote_exit || null;
      agent.remoteLogOffset = typeof meta.remote_log_offset === 'number' ? meta.remote_log_offset : 0;
      agent.failure = meta.failure && typeof meta.failure === 'object'
        ? {
            stage: meta.failure.stage,
            code: String(meta.failure.code),
            message: safeFailureMessage(String(meta.failure.message ?? '')),
            exit_code: typeof meta.failure.exit_code === 'number' ? meta.failure.exit_code : null,
            retryable: Boolean(meta.failure.retryable),
            observed_at: String(meta.failure.observed_at),
          }
        : null;
      agent.project = typeof meta.project === 'string' ? meta.project : null;
      return agent;
    } catch (err) {
      await AgentProcess.quarantineCorruptMeta(metaPath, err);
      return null;
    }
  }

  isProcessAlive(): boolean {
    if (this.hostName) {
      if (this.remotePollSnapshot) return this.remotePollSnapshot.alive;
      if (!this.hostTarget || !this.remotePid || !this.remoteExit) return false;
      const probe =
        `test -f ${this.remoteExit} && echo DEAD || ` +
        `(kill -0 ${this.remotePid} 2>/dev/null && echo ALIVE || echo DEAD)`;
      const res = sshExec(this.hostTarget, probe, {
        timeoutMs: 8000,
        multiplex: true,
        extraSshArgs: this.hostIdentityFile ? ['-i', this.hostIdentityFile, '-o', 'IdentitiesOnly=yes'] : [],
      });
      if (res.code === null) return true;
      return res.stdout.trim().endsWith('ALIVE');
    }

    if (!this.pid) return false;
    try {
      process.kill(this.pid, 0);
    } catch {
      return false;
    }
    if (this.startTime !== null) {
      const current = captureProcessStartTime(this.pid);
      if (current === null || current !== this.startTime) {
        return false;
      }
    }
    return true;
  }

  private async readDiskStatus(): Promise<{ status: AgentStatus; completedAt: Date | null } | null> {
    let raw: string;
    try {
      raw = await fs.readFile(await this.getMetaPath(), 'utf-8');
    } catch {
      return null;
    }
    try {
      const meta = JSON.parse(raw);
      const validStatuses = Object.values(AgentStatus);
      const status = validStatuses.includes(meta.status as AgentStatus)
        ? (meta.status as AgentStatus)
        : AgentStatus.RUNNING;
      const completedAt = meta.completed_at ? new Date(meta.completed_at) : null;
      return { status, completedAt };
    } catch {
      return null;
    }
  }

  private async adoptDiskTerminalIfNewer(): Promise<boolean> {
    if (isTerminalStatus(this.status)) return false;
    const disk = await this.readDiskStatus();
    if (!disk || !isTerminalStatus(disk.status)) return false;
    this.status = disk.status;
    this.completedAt = disk.completedAt ?? this.completedAt ?? new Date();
    return true;
  }

  async updateStatusFromProcess(opts: { skipRemote?: boolean } = {}): Promise<void> {
    if (await this.adoptDiskTerminalIfNewer()) return;

    if (!this.pid) {
      if (this.hostName) {
        if (opts.skipRemote) return;
        if (this.status === AgentStatus.PENDING) return;
        await this.readNewEvents();
        if (this.status !== AgentStatus.RUNNING && !this.completedAt) {
          this.completedAt = this.getLatestEventTime() || this.startedAt || new Date();
        }
        await this.saveMeta();
        return;
      }

      await this.readNewEvents();

      if (this.cloudProvider) {
        if (this.status === AgentStatus.PENDING) return;
        if (!this.completedAt && this.status !== AgentStatus.RUNNING) {
          const fallbackCompletion =
            this.getLatestEventTime() || this.startedAt || new Date();
          this.completedAt = fallbackCompletion;
          await this.saveMeta();
        }
        return;
      }

      if (this.status === AgentStatus.PENDING) {
        return;
      }

      if (this.status === AgentStatus.RUNNING) {
        const fallbackCompletion =
          this.getLatestEventTime() || this.startedAt || new Date();
        if (this.status === AgentStatus.RUNNING) {
          this.status = AgentStatus.FAILED;
          this.failure = {
            stage: 'spawn', code: 'process-identity-missing',
            message: 'The teammate was marked running without a process identity.', exit_code: null,
            retryable: true, observed_at: new Date().toISOString(),
          };
          this.completedAt = fallbackCompletion;
        }
        await this.saveMeta();
        return;
      }

      if (!this.completedAt) {
        const fallbackCompletion =
          this.getLatestEventTime() || this.startedAt || new Date();
        this.completedAt = fallbackCompletion;
        await this.saveMeta();
      }
      return;
    }

    if (this.isProcessAlive()) {
      await this.readNewEvents();
      return;
    }

    if (this.status === AgentStatus.RUNNING) {
      const exit = await this.reapProcess();
      await this.readNewEvents();

      if (this.status === AgentStatus.RUNNING) {
        const fallbackCompletion =
          this.getLatestEventTime() || this.startedAt || new Date();
        if (exit !== null && exit.code !== 0) {
          this.status = AgentStatus.FAILED;
          this.failure = {
            stage: 'execution',
            code: exit.sentinelPresent ? 'process-exit-nonzero' : 'process-exit-unrecorded',
            message: exit.sentinelPresent
              ? `Teammate process exited with code ${exit.code}.`
              : 'Teammate process disappeared before recording an exit code.',
            exit_code: exit.sentinelPresent ? exit.code : null,
            retryable: !exit.sentinelPresent,
            observed_at: new Date().toISOString(),
          };
        } else {
          this.status = AgentStatus.COMPLETED;
        }
        this.completedAt = fallbackCompletion;
      }
    } else if (!this.completedAt) {
      await this.readNewEvents();
      const fallbackCompletion =
        this.getLatestEventTime() || this.startedAt || new Date();
      this.completedAt = fallbackCompletion;
    }

    await this.saveMeta();
  }

  private async reapProcess(): Promise<{ code: number; sentinelPresent: boolean } | null> {
    if (!this.pid) return null;
    if (this.isProcessAlive()) return null;

    try {
      const raw = (await fs.readFile(await this.getExitCodePath(), 'utf-8')).trim();
      const code = Number.parseInt(raw, 10);
      return { code: Number.isNaN(code) ? 1 : code, sentinelPresent: true };
    } catch {
      return { code: 1, sentinelPresent: false };
    }
  }
}

export type CloudDispatchFn = (agent: AgentProcess) => Promise<{ cloudSessionId: string }>;

async function resolveTeammateGrants(
  agent: AgentProcess,
  opts: { forRemote: boolean },
): Promise<string[]> {
  if (!agent.project) return [];
  try {
    const { resolveProjectDirs } = await import('../project-root.js');
    const { extraDirs } = await resolveProjectDirs(agent.project, opts);
    return extraDirs;
  } catch (err) {
    debug(`teammate ${agent.agentId}: project '${agent.project}' did not resolve, no grants: ${(err as Error).message}`);
    return [];
  }
}

interface ResumeLogTransaction {
  agent: AgentProcess;
  stdoutPath: string;
  backupPath: string;
  hadOriginal: boolean;
  previousReadPos: number;
}

export async function beginResumeLogTransaction(agent: AgentProcess): Promise<ResumeLogTransaction> {
  const stdoutPath = await agent.getStdoutPath();
  const backupPath = `${stdoutPath}.resume-backup-${randomUUID()}`;
  let hadOriginal = false;
  try {
    await fs.rename(stdoutPath, backupPath);
    hadOriginal = true;
  } catch (err: any) {
    if (err?.code !== 'ENOENT') throw err;
  }
  const previousReadPos = agent.resetLogReadPosition();
  return { agent, stdoutPath, backupPath, hadOriginal, previousReadPos };
}

export async function commitResumeLogTransaction(transaction: ResumeLogTransaction): Promise<void> {
  if (transaction.hadOriginal) await fs.rm(transaction.backupPath, { force: true });
}

async function rollbackResumeLogTransaction(transaction: ResumeLogTransaction): Promise<void> {
  try {
    await fs.rm(transaction.stdoutPath, { force: true });
    if (transaction.hadOriginal) {
      await fs.rename(transaction.backupPath, transaction.stdoutPath);
    }
  } finally {
    transaction.agent.restoreLogReadPosition(transaction.previousReadPos);
  }
}

export async function terminateSpawnedProcess(pid: number): Promise<void> {
  try {
    process.kill(-pid, 'SIGTERM');
  } catch (err: any) {
    if (err?.code === 'ESRCH') return;
    throw err;
  }

  await new Promise(resolve => setTimeout(resolve, 250));
  try {
    process.kill(-pid, 0);
  } catch (err: any) {
    if (err?.code === 'ESRCH') return;
    throw err;
  }

  try {
    process.kill(-pid, 'SIGKILL');
  } catch (err: any) {
    if (err?.code !== 'ESRCH') throw err;
  }
}

export class AgentManager {
  private agents: Map<string, AgentProcess> = new Map();
  private maxAgents: number;
  private agentsDir: string = '';
  private filterByCwd: string | null;
  private cleanupAgeDays: number;
  private defaultMode: Mode;
  private initPromise: Promise<void> | null = null;
  private cloudDispatcher: CloudDispatchFn | null = null;
  private localOnly: boolean;

  private constructorAgentsDir: string | null = null;

  private validatedAdd: { key: string; cleanAfter: string[] } | null = null;

  constructor(
    maxAgents: number = 50,
    agentsDir: string | null = null,
    defaultMode: Mode | null = null,
    filterByCwd: string | null = null,
    cleanupAgeDays: number = 7,
    localOnly: boolean = false,
  ) {
    this.maxAgents = maxAgents;
    this.constructorAgentsDir = agentsDir;
    this.filterByCwd = filterByCwd;
    this.cleanupAgeDays = cleanupAgeDays;
    this.localOnly = localOnly;
    const resolvedDefaultMode = defaultMode ? normalizeModeValue(defaultMode) : defaultModeFromEnv();
    if (!resolvedDefaultMode) {
      throw new Error(`Invalid default_mode '${defaultMode}'. Use plan, edit, auto, or skip.`);
    }
    this.defaultMode = resolvedDefaultMode;

    this.initPromise = this.doInitialize();
    this.initPromise.catch(() => {});
  }

  private async initialize(): Promise<void> {
    if (!this.initPromise) {
      this.initPromise = this.doInitialize();
    }
    return this.initPromise;
  }

  private async doInitialize(): Promise<void> {
    this.agentsDir = this.constructorAgentsDir || await getAgentsDir();
    await fs.mkdir(this.agentsDir, { recursive: true });

    await this.loadExistingAgents();
  }

  getDefaultMode(): Mode {
    return this.defaultMode;
  }

  setCloudDispatcher(fn: CloudDispatchFn | null): void {
    this.cloudDispatcher = fn;
  }

  registerAgent(agent: AgentProcess): void {
    this.agents.set(agent.agentId, agent);
  }

  private async failAgent(
    agent: AgentProcess,
    failure: Omit<TeammateFailure, 'message' | 'observed_at'> & { message: string },
  ): Promise<void> {
    agent.failure = {
      ...failure,
      message: safeFailureMessage(failure.message),
      observed_at: new Date().toISOString(),
    };
    agent.status = AgentStatus.FAILED;
    agent.completedAt = new Date();
    await agent.saveMeta();
  }

  private async deferAgent(
    agent: AgentProcess,
    failure: Omit<TeammateFailure, 'message' | 'observed_at'> & { message: string },
  ): Promise<void> {
    agent.failure = {
      ...failure,
      message: safeFailureMessage(failure.message),
      observed_at: new Date().toISOString(),
    };
    agent.status = AgentStatus.PENDING;
    agent.completedAt = null;
    await agent.saveMeta();
  }

  async rescanFromDisk(): Promise<number> {
    await this.initialize();
    try {
      await fs.access(this.agentsDir);
    } catch {
      return 0;
    }
    const entries = await fs.readdir(this.agentsDir);
    let added = 0;
    for (const entry of entries) {
      const agentDir = path.join(this.agentsDir, entry);
      const stat = await fs.stat(agentDir).catch(() => null);
      if (!stat || !stat.isDirectory()) continue;

      const cached = this.agents.get(entry);
      if (cached) {
        if (!isTerminalStatus(cached.status)) {
          const fresh = await AgentProcess.loadFromDisk(entry, this.agentsDir);
          if (fresh && isTerminalStatus(fresh.status)) {
            this.agents.set(entry, fresh);
          }
        }
        continue;
      }

      const agent = await AgentProcess.loadFromDisk(entry, this.agentsDir);
      if (!agent) continue;
      if (this.filterByCwd !== null && agent.cwd !== this.filterByCwd) continue;
      this.agents.set(entry, agent);
      added++;
    }
    return added;
  }

  private async loadExistingAgents(): Promise<void> {
    try {
      await fs.access(this.agentsDir);
    } catch {
      return;
    }

    const cutoffDate = new Date(Date.now() - this.cleanupAgeDays * 24 * 60 * 60 * 1000);
    let loadedCount = 0;
    let skippedCwd = 0;
    let cleanedOld = 0;

    const entries = await fs.readdir(this.agentsDir);
    for (const entry of entries) {
      const agentDir = path.join(this.agentsDir, entry);
      const stat = await fs.stat(agentDir).catch(() => null);
      if (!stat || !stat.isDirectory()) continue;

      const agentId = entry;
      const agent = await AgentProcess.loadFromDisk(agentId, this.agentsDir);
      if (!agent) continue;

      if (agent.completedAt && agent.completedAt < cutoffDate && isTerminalStatus(agent.status)) {
        try {
          await fs.rm(agentDir, { recursive: true });
          cleanedOld++;
        } catch (err) {
          console.warn(`Failed to cleanup old agent ${agentId}:`, err);
        }
        continue;
      }

      if (this.filterByCwd !== null) {
        const agentCwd = agent.cwd;
        if (agentCwd !== this.filterByCwd) {
          skippedCwd++;
          continue;
        }
      }

      await agent.updateStatusFromProcess({ skipRemote: this.localOnly });
      this.agents.set(agentId, agent);
      loadedCount++;
    }

    if (cleanedOld > 0) {
      debug(`Cleaned up ${cleanedOld} old agents (older than ${this.cleanupAgeDays} days)`);
    }
    if (skippedCwd > 0) {
      debug(`Skipped ${skippedCwd} agents (different CWD)`);
    }
    debug(`Loaded ${loadedCount} agents from disk`);
  }

  async validateAddPreconditions(
    taskName: string,
    name: string | null,
    after: string[],
  ): Promise<string[]> {
    await this.initialize();
    const key = JSON.stringify([taskName, name, after]);
    if (this.validatedAdd?.key === key) {
      const cached = this.validatedAdd.cleanAfter;
      this.validatedAdd = null;
      return cached;
    }
    const siblings = await this.listByTask(taskName);
    if (name && siblings.some((a) => a.name === name)) {
      throw new Error(
        `Team '${taskName}' already has a teammate named '${name}'. Pick another name or leave --name off.`,
      );
    }

    const cleanAfter = after.filter((s) => s && s.trim());
    if (cleanAfter.length > 0) {
      if (!name) {
        throw new Error(
          "Can't use --after without --name. Dependencies reference teammates by name.",
        );
      }
      const siblingNames = new Set(siblings.map((a) => a.name).filter(Boolean) as string[]);
      const missing = cleanAfter.filter((dep) => !siblingNames.has(dep));
      if (missing.length > 0) {
        throw new Error(
          `Team '${taskName}' has no teammate named ${missing.map((m) => `'${m}'`).join(', ')} yet.\n` +
            `  Add them first, then add this one.`,
        );
      }
      const byName = new Map(siblings.filter((a) => a.name).map((a) => [a.name as string, a]));
      for (const dep of cleanAfter) {
        if (hasTransitiveDep(byName, dep, name)) {
          throw new Error(
            `Adding '${name}' after '${dep}' would create a cycle (${dep} already depends on ${name}).`,
          );
        }
      }
    }
    this.validatedAdd = { key, cleanAfter };
    return cleanAfter;
  }

  async isWorktreeClaimed(worktreeName: string): Promise<boolean> {
    const base = this.agentsDir ?? (await getAgentsDir());
    let entries: string[];
    try {
      entries = await fs.readdir(base);
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return false;
      return true;
    }
    for (const entry of entries) {
      try {
        const raw = await fs.readFile(path.join(base, entry, 'meta.json'), 'utf-8');
        const meta = JSON.parse(raw);
        if (meta?.worktree_name !== worktreeName) continue;
        if (!isTerminalStatus(meta?.status as AgentStatus)) return true;
      } catch (err) {
        if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') continue;
        return true;
      }
    }
    return false;
  }

  async spawn(
    taskName: string,
    agentType: AgentType,
    prompt: string,
    cwd: string | null = null,
    mode: Mode | null = null,
    effort: EffortLevel = 'medium',
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
    project: string | null = null,
  ): Promise<AgentProcess> {
    await this.initialize();
    const resolvedMode = resolveMode(mode, this.defaultMode);

    if (!parentSessionId) {
      parentSessionId = process.env.AGENTS_SESSION_ID ?? null;
    }

    const cleanAfter = await this.validateAddPreconditions(taskName, name, after);

    let resolvedCwd: string | null = null;
    if (cwd !== null) {
      resolvedCwd = path.resolve(cwd);
      const stat = await fs.stat(resolvedCwd).catch(() => null);
      if (!stat) {
        throw new Error(`Working directory does not exist: ${cwd}`);
      }
      if (!stat.isDirectory()) {
        throw new Error(`Working directory is not a directory: ${cwd}`);
      }
    }

    const isCloudBacked = Boolean(cloudProvider);
    const isRemoteBacked = Boolean(hostName);
    if (!isCloudBacked && !isRemoteBacked) {
      const [available, pathOrError] = checkCliAvailable(agentType);
      if (!available) {
        throw new Error(pathOrError || 'CLI tool not available');
      }
    }

    const agentId = randomUUID();
    const isStaged = cleanAfter.length > 0;

    const initialStatus = isStaged || !isCloudBacked || !cloudSessionId
      ? AgentStatus.PENDING
      : AgentStatus.RUNNING;

    const agent = new AgentProcess(
      agentId,
      taskName,
      agentType,
      prompt,
      resolvedCwd,
      resolvedMode,
      null,
      initialStatus,
      new Date(),
      null,
      this.agentsDir,
      parentSessionId,
      workspaceDir,
      cloudSessionId,
      cloudProvider,
      null,
      version,
      null,
      name,
      cleanAfter,
      effort,
      model,
      envOverrides && Object.keys(envOverrides).length > 0 ? envOverrides : null,
      taskType,
      cloudRepo,
      cloudBranch,
      worktreeName,
      worktreePath,
      profileName,
    );

    agent.hostName = hostName;
    agent.hostTarget = hostTarget;
    agent.repoPath = repoPath;
    agent.project = project;

    const agentDir = await agent.getAgentDir();
    try {
      await fs.mkdir(agentDir, { recursive: true });
    } catch (err: any) {
      throw new Error(`Failed to create agent directory: ${err.message}`);
    }
    this.agents.set(agentId, agent);

    if (agentType === 'claude' && name && !isCloudBacked) {
      recordRunName({ sessionId: agentId, name, agent: agentType, cwd: resolvedCwd ?? undefined });
    }

    if (isStaged) {
      await agent.saveMeta();
      debug(`Staged ${agentType} teammate '${name}' in team '${taskName}' (after: ${cleanAfter.join(', ')})`);
    } else if (isCloudBacked) {
      if (cloudSessionId) {
        await agent.saveMeta();
        debug(`Cloud-backed ${agentType} teammate via ${cloudProvider} (session=${cloudSessionId})`);
      } else {
        try {
          if (!this.cloudDispatcher) throw new Error('No cloud dispatcher registered.');
          const dispatched = await this.cloudDispatcher(agent);
          agent.cloudSessionId = dispatched.cloudSessionId;
          agent.status = AgentStatus.RUNNING;
          agent.startedAt = new Date();
          await agent.saveMeta();
        } catch (err) {
          await this.failAgent(agent, {
            stage: 'cloud', code: 'cloud-dispatch-failed', message: (err as Error).message,
            exit_code: null, retryable: true,
          });
          throw err;
        }
      }
    } else if (isRemoteBacked) {
      await this.launchRemoteProcess(agent);
    } else {
      try {
        await this.maybeSchedulePlacement(agent, taskName);
      } catch (err) {
        if (isTransientPlacementBlock(err)) {
          await this.deferAgent(agent, {
            stage: 'placement', code: 'placement-capacity-wait', message: err.message,
            exit_code: null, retryable: true,
          });
          await this.cleanupOldAgents();
          return agent;
        }
        await this.failAgent(agent, {
          stage: 'placement',
          code: err instanceof NoViableDeviceError ? 'no-viable-device' : 'placement-failed',
          message: (err as Error).message,
          exit_code: null,
          retryable: !(err instanceof NoViableDeviceError),
        });
        throw err;
      }
      if (agent.hostName) await this.launchRemoteProcess(agent);
      else await this.launchProcess(agent);
    }

    await this.cleanupOldAgents();

    const persisted = await AgentProcess.loadFromDisk(agentId, this.agentsDir);
    if (!persisted) {
      this.agents.delete(agentId);
      throw new Error(
        `Teammate '${name ?? agentId}' was not durably persisted to disk after add ` +
          `(no meta.json under ${this.agentsDir}/${agentId}). The add did not take effect.`,
      );
    }
    return agent;
  }

  async resumeTeammate(agentId: string, message: string): Promise<AgentProcess> {
    await this.initialize();
    const agent = await this.get(agentId);
    if (!agent) throw new Error(`No teammate with id ${agentId}`);

    const who = agent.name ?? agent.agentId.slice(0, 8);

    if (message.startsWith('-')) {
      throw new Error(
        `Resume message can't start with '-' — \`agents run\` would parse it as a flag. ` +
        `Rephrase so it leads with a word (e.g. "Please ${message}").`,
      );
    }

    if (agent.cloudProvider) {
      throw new Error(
        `Teammate '${who}' is a ${agent.cloudProvider} cloud task — resume it with ` +
        `\`agents message ${agent.cloudSessionId ?? agent.agentId} "<message>"\` instead.`,
      );
    }

    if (agent.agentType !== 'claude' && !agent.remoteSessionId) {
      throw new Error(
        `No resumable session id was captured for ${agent.agentType} teammate '${who}' — ` +
        `its session id is discovered from the agent's own output, which never arrived ` +
        `(it may have failed before its first turn). Start a fresh teammate instead.`,
      );
    }

    const resume = { id: agent.remoteSessionId ?? agent.agentId, message };
    const priorRuntime = {
      status: agent.status,
      failure: agent.failure,
      completedAt: agent.completedAt,
      pid: agent.pid,
      startTime: agent.startTime,
      startedAt: agent.startedAt,
      remotePid: agent.remotePid,
      remoteLog: agent.remoteLog,
      remoteExit: agent.remoteExit,
      remoteLogOffset: agent.remoteLogOffset,
      worktreePath: agent.worktreePath,
    };
    agent.status = AgentStatus.RUNNING;
    agent.failure = null;
    agent.completedAt = null;

    try {
      if (agent.hostName) {
        await this.launchRemoteProcess(agent, resume);
      } else {
        await this.launchProcess(agent, resume);
      }
    } catch (err) {
      Object.assign(agent, priorRuntime);
      try {
        await agent.saveMeta();
      } catch (restoreErr) {
        throw new Error(
          `Failed to resume teammate: ${(err as Error).message}; restoring stopped state also failed: ${(restoreErr as Error).message}`,
          { cause: err },
        );
      }
      throw err;
    }
    return agent;
  }

  private async launchProcess(agent: AgentProcess, resume?: { id: string; message: string }): Promise<void> {
    const running = await this.listRunning();
    warnIfMemoryLow(running.length);

    const effort = agent.effort ?? 'medium';
    const resolvedModel: string | null = agent.model ?? null;
    const cmd = this.buildCommand(
      agent.agentType,
      agent.prompt,
      agent.mode,
      resolvedModel,
      agent.cwd,
      agent.agentId,
      effort,
      agent.version,
      agent.profileName,
      resume,
      await resolveTeammateGrants(agent, { forRemote: false }),
    );

    debug(`Launching ${agent.agentType} agent ${agent.agentId} [${agent.mode}]${resume ? ' (resume)' : ''}: ${cmd.slice(0, 3).join(' ')}...`);

    let childProcess: ChildProcess | null = null;
    let stdoutFile: fs.FileHandle | null = null;
    let resumeLog: ResumeLogTransaction | null = null;

    try {
      if (resume) resumeLog = await beginResumeLogTransaction(agent);
      const stdoutPath = resumeLog?.stdoutPath ?? await agent.getStdoutPath();
      stdoutFile = await fs.open(stdoutPath, 'w');
      const stdoutFd = stdoutFile.fd;

      const exitCodePath = await agent.getExitCodePath();
      await fs.rm(exitCodePath, { force: true }).catch(() => {});
      const wrappedCmd = buildSentinelCommand(cmd, exitCodePath);

      childProcess = spawn('/bin/sh', ['-c', wrappedCmd], {
        stdio: ['ignore', stdoutFd, stdoutFd],
        cwd: agent.cwd || undefined,
        detached: true,
        env: buildTeammateSpawnEnv(agent.envOverrides),
      });

      await new Promise<void>((resolve, reject) => {
        childProcess!.once('spawn', resolve);
        childProcess!.once('error', reject);
      });
      childProcess.unref();
      await stdoutFile.close();
      stdoutFile = null;

      agent.pid = childProcess.pid || null;
      agent.startTime = agent.pid ? captureProcessStartTime(agent.pid) : null;
      agent.status = AgentStatus.RUNNING;
      agent.startedAt = new Date();
      await agent.saveMeta();
      if (resumeLog) await commitResumeLogTransaction(resumeLog);
    } catch (err: any) {
      if (stdoutFile) await stdoutFile.close().catch(() => {});
      if (childProcess?.pid) await terminateSpawnedProcess(childProcess.pid);
      if (resumeLog) await rollbackResumeLogTransaction(resumeLog);
      if (!resume) {
        await this.failAgent(agent, {
          stage: 'spawn',
          code: 'local-spawn-failed',
          message: err.message,
          exit_code: null,
          retryable: true,
        });
      }
      console.error(`Failed to spawn agent ${agent.agentId}:`, err);
      throw new Error(`Failed to spawn agent: ${err.message}`);
    }

    debug(`Launched agent ${agent.agentId} with PID ${agent.pid}`);
  }

  private async launchRemoteProcess(agent: AgentProcess, resume?: { id: string; message: string }): Promise<void> {
    if (!agent.hostName || !agent.hostTarget || !agent.repoPath) {
      throw new Error(`Remote teammate ${agent.agentId} is missing host placement (host/target/repo).`);
    }

    const host = await resolveHost(agent.hostName);
    if (!host) {
      throw new Error(`Cannot launch remote teammate ${agent.agentId}: device "${agent.hostName}" no longer resolves.`);
    }
    agent.hostIdentityFile = host.identityFile ?? null;

    try {
      const { warnings } = ensureHostReady(host, {
        agent: agent.agentType,
        version: agent.version ?? undefined,
      });
      for (const w of warnings) process.stderr.write(`[teams] warning: ${w}\n`);
    } catch (err) {
      throw new Error(`Host "${agent.hostName}" not ready for teammate ${agent.agentId}: ${(err as Error).message}`);
    }

    let remoteCwd = agent.repoPath;
    if (agent.worktreeName) {
      if (resume && agent.worktreePath) {
        remoteCwd = agent.worktreePath;
      } else {
        const worktreePath = createRemoteWorktree(agent.hostTarget, agent.repoPath, agent.worktreeName, {
          extraSshArgs: agent.hostIdentityFile ? ['-i', agent.hostIdentityFile, '-o', 'IdentitiesOnly=yes'] : [],
        });
        agent.worktreePath = worktreePath;
        remoteCwd = worktreePath;
      }
    }

    const effort = agent.effort ?? 'medium';
    const forwardedArgs = this.buildRunArgv(
      agent.agentType,
      agent.prompt,
      agent.mode,
      agent.model ?? null,
      effort,
      agent.version,
      agent.profileName,
      resume,
    );
    for (const dir of await resolveTeammateGrants(agent, { forRemote: true })) {
      if (dir !== remoteCwd) forwardedArgs.push('--add-dir', dir);
    }

    let dispatchedTask: Awaited<ReturnType<typeof dispatchAgentsCommand>>['task'] | null = null;
    let resumeLog: ResumeLogTransaction | null = null;
    try {
      if (resume) {
        resumeLog = await beginResumeLogTransaction(agent);
        await fs.writeFile(resumeLog.stdoutPath, '');
      }
      const { task } = await dispatchAgentsCommand(host, {
        forwardedArgs,
        remoteCwd,
        follow: false,
      });
      dispatchedTask = task;
      agent.remotePid = task.pid ?? null;
      agent.remoteLog = task.remoteLog ?? null;
      agent.remoteExit = task.remoteExit ?? null;
      agent.remoteLogOffset = 0;
      agent.status = AgentStatus.RUNNING;
      agent.startedAt = new Date();
      await agent.saveMeta();
      if (resumeLog) await commitResumeLogTransaction(resumeLog);
    } catch (err: any) {
      let cleanupError: Error | null = null;
      if (dispatchedTask) {
        try {
          terminateDispatchedTask(dispatchedTask);
        } catch (cleanupErr) {
          cleanupError = cleanupErr as Error;
        }
      }
      if (resumeLog) {
        try {
          await rollbackResumeLogTransaction(resumeLog);
        } catch (cleanupErr) {
          cleanupError = cleanupError ?? cleanupErr as Error;
        }
      }
      console.error(`Failed to launch remote teammate ${agent.agentId} on ${agent.hostName}:`, err);
      if (!resume) {
        await this.failAgent(agent, {
          stage: 'spawn',
          code: 'remote-launch-failed',
          message: err.message,
          exit_code: null,
          retryable: true,
        });
      }
      if (cleanupError) {
        throw new Error(
          `Failed to launch remote teammate: ${err.message}; cleanup failed: ${cleanupError.message}`,
          { cause: err },
        );
      }
      throw new Error(`Failed to launch remote teammate: ${err.message}`);
    }

    debug(`Launched remote agent ${agent.agentId} on ${agent.hostName} (remote pid ${agent.remotePid})`);
  }

  private async resolveScheduledPlacement(
    agent: AgentProcess,
    device: string,
    taskName: string,
  ): Promise<void> {
    const host = await resolveHost(device);
    if (!host) {
      throw new Error(`Scheduler picked device "${device}" but it no longer resolves.`);
    }
    if (remoteShellFor(host.os ?? resolveRemoteOsSync(host.name)) === 'powershell') {
      throw new Error(
        `Scheduler picked Windows device "${host.name}", but distributed teammates are POSIX-only in v1.`,
      );
    }
    const target = sshTargetFor(host);
    const teamMeta = await getTeam(taskName);
    const repoRoot = ensureRemoteRepo(target, teamMeta?.repo ?? '', taskName, {
      extraSshArgs: host.identityFile ? ['-i', host.identityFile, '-o', 'IdentitiesOnly=yes'] : [],
    });
    agent.hostName = host.name;
    agent.hostTarget = target;
    agent.hostIdentityFile = host.identityFile ?? null;
    agent.repoPath = repoRoot;
    await agent.saveMeta();
  }

  private async maybeSchedulePlacement(
    agent: AgentProcess,
    taskName: string,
    opts: { probe?: boolean } = {},
  ): Promise<void> {
    if (agent.hostName || agent.cloudProvider) return;
    const teamMeta = await getTeam(taskName);
    if (!teamMeta) return;
    const roster = await this.listByTask(taskName);
    const pool = teamMeta.devices?.length
      ? teamMeta.devices
      : filterAutoPool(listWorkerDevices());
    const maxConcurrent = pool.length > 1 ? readMaxConcurrentCaps(pool) : undefined;
    const signals =
      opts.probe && pool.length > 0
        ? await probePoolSignals(pool, agent.agentType, { now: Date.now() })
        : undefined;
    const placeOpts = {
      maxConcurrent,
      signals,
      defaultDevices: pool,
      agentLabel: this.placementAgentLabel(agent),
    };
    if (signals) {
      for (const e of classifyExclusions(pool, roster, placeOpts).excluded) {
        const why =
          e.reason === 'capped'
            ? `at its agents.max-concurrent cap (${e.detail} running)`
            : e.reason === 'not-installed'
              ? `does not have ${this.placementAgentLabel(agent)} installed`
              : e.reason === 'probe-timed-out'
                ? 'did not answer the probe in time (likely up but on a slow/relayed link)'
                : e.reason;
        console.error(chalk.dim(`[placement] '${e.device}' excluded from auto-pick — ${why}`));
      }
    }
    const { device } = resolvePlacement(teamMeta, null, roster, placeOpts);
    if (device) await this.resolveScheduledPlacement(agent, device, taskName);
  }

  private placementAgentLabel(agent: AgentProcess): string {
    return agent.version ? `${agent.agentType}@${agent.version}` : String(agent.agentType);
  }

  async prefetchRemoteStatus(taskName: string): Promise<void> {
    await this.initialize();
    const remotes = Array.from(this.agents.values()).filter(
      (a) => a.taskName === taskName && a.hostName,
    );
    for (const a of remotes) a.remotePollSnapshot = null;

    const teammates = remotes.filter(
      (a) =>
        a.hostTarget && a.remotePid && a.remoteExit &&
        a.status === AgentStatus.RUNNING,
    );
    if (teammates.length === 0) return;

    const byTarget = new Map<string, { target: string; agents: AgentProcess[] }>();
    for (const a of teammates) {
      const key = `${a.hostTarget!}\0${a.hostIdentityFile ?? ''}`;
      const group = byTarget.get(key) || { target: a.hostTarget!, agents: [] };
      group.agents.push(a);
      byTarget.set(key, group);
    }

    for (const { target, agents } of byTarget.values()) {
      const parts = agents.map((a) => remoteLivenessSnippet(a.agentId, a.remoteExit!, a.remotePid!));
      const identityFile = agents[0]?.hostIdentityFile;
      const res = sshExec(target, parts.join('; '), {
        timeoutMs: 12000,
        multiplex: true,
        extraSshArgs: identityFile ? ['-i', identityFile, '-o', 'IdentitiesOnly=yes'] : [],
      });
      if (res.code === null) continue;
      const snapshots = new Map<string, RemoteLivenessSnapshot>();
      for (const line of res.stdout.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        const [id, state, code] = trimmed.split(/\s+/);
        if (!id || !state) continue;
        snapshots.set(id, parseRemoteLivenessState(state, code));
      }
      for (const a of agents) {
        const snap = snapshots.get(a.agentId);
        if (snap) a.remotePollSnapshot = snap;
      }
    }
  }

  async startReady(taskName: string): Promise<AgentProcess[]> {
    await this.initialize();
    const teammates = await this.listByTask(taskName);
    const byName = new Map(
      teammates.filter((a) => a.name).map((a) => [a.name as string, a])
    );

    const launched: AgentProcess[] = [];
    for (const agent of teammates) {
      if (agent.status !== AgentStatus.PENDING) continue;
      const blockers = agent.after
        .map((depName) => ({ depName, dep: byName.get(depName) }))
        .filter(({ dep }) => !dep || (isTerminalStatus(dep.status) && dep.status !== AgentStatus.COMPLETED));
      if (blockers.length > 0) {
        const names = blockers.map(({ depName, dep }) => `${depName} (${dep?.status ?? 'missing'})`);
        await this.failAgent(agent, {
          stage: 'dependency',
          code: 'dependency-failed',
          message: `Blocked by dependency: ${names.join(', ')}.`,
          exit_code: null,
          retryable: false,
        });
        continue;
      }
      const depsReady = agent.after.every((depName) => {
        const dep = byName.get(depName);
        return dep && dep.status === AgentStatus.COMPLETED;
      });
      if (!depsReady) continue;

      try {
        await this.maybeSchedulePlacement(agent, taskName, { probe: true });
      } catch (err) {
        if (isTransientPlacementBlock(err)) {
          await this.deferAgent(agent, {
            stage: 'placement', code: 'placement-capacity-wait', message: err.message,
            exit_code: null, retryable: true,
          });
          console.error(`Placement deferred for ${agent.agentId}; the pool may free up on a later wave:`, err);
          continue;
        }
        await this.failAgent(agent, {
          stage: 'placement',
          code: err instanceof NoViableDeviceError ? 'no-viable-device' : 'placement-failed',
          message: (err as Error).message,
          exit_code: null,
          retryable: !(err instanceof NoViableDeviceError),
        });
        console.error(`Could not schedule ${agent.agentId} onto the team pool:`, err);
        continue;
      }

      try {
        if (agent.hostName) {
          await this.launchRemoteProcess(agent);
          launched.push(agent);
        } else if (agent.cloudProvider) {
          if (!this.cloudDispatcher) {
            const message = `Cannot start cloud-backed teammate ${agent.agentId}: no dispatcher registered.`;
            await this.failAgent(agent, {
              stage: 'cloud', code: 'cloud-dispatcher-missing', message,
              exit_code: null, retryable: false,
            });
            console.error(message);
            continue;
          }
          const { cloudSessionId } = await this.cloudDispatcher(agent);
          agent.cloudSessionId = cloudSessionId;
          agent.status = AgentStatus.RUNNING;
          agent.startedAt = new Date();
          await agent.saveMeta();
          launched.push(agent);
        } else {
          await this.launchProcess(agent);
          launched.push(agent);
        }
      } catch (err) {
        await this.failAgent(agent, {
          stage: agent.cloudProvider ? 'cloud' : 'spawn',
          code: agent.cloudProvider ? 'cloud-dispatch-failed' : agent.hostName ? 'remote-launch-failed' : 'local-spawn-failed',
          message: (err as Error).message,
          exit_code: null,
          retryable: true,
        });
        console.error(`Could not launch ${agent.agentId}:`, err);
      }
    }
    return launched;
  }

  private buildRunArgv(
    agentType: AgentType,
    prompt: string,
    mode: Mode,
    model: string | null,
    effort: EffortLevel,
    version: string | null,
    profileName: string | null,
    resume?: { id: string; message: string },
  ): string[] {
    let fullPrompt: string;
    if (resume) {
      fullPrompt = resume.message + PROMPT_SUFFIX;
    } else {
      fullPrompt = prompt + PROMPT_SUFFIX;
      if (agentType === 'claude' && mode === 'plan') {
        fullPrompt = CLAUDE_PLAN_MODE_PREFIX + fullPrompt;
      }
    }
    fullPrompt = withTeammatePrPolicy(fullPrompt, mode);

    const target = profileName ?? (version ? `${agentType}@${version}` : agentType);

    const args: string[] = ['run', target, fullPrompt];
    if (resume) {
      args.push('--resume', resume.id);
    }
    args.push('--mode', mode, '--effort', effort, '--json', '--headless', '--quiet');
    if (model) args.push('--model', model);
    args.push('--env', 'AGENTS_RUNTIME=teams');
    return args;
  }

  private buildCommand(
    agentType: AgentType,
    prompt: string,
    mode: Mode,
    model: string | null,
    cwd: string | null = null,
    sessionId: string | null = null,
    effort: EffortLevel = 'medium',
    version: string | null = null,
    profileName: string | null = null,
    resume?: { id: string; message: string },
    addDirs: string[] = [],
  ): string[] {
    const inv = getAgentsInvocation(
      this.buildRunArgv(agentType, prompt, mode, model, effort, version, profileName, resume),
    );
    const cmd: string[] = [inv.command, ...inv.args];

    if (cwd) cmd.push('--cwd', cwd);

    if (sessionId && !resume) {
      cmd.push('--session-id', sessionId);
    }

    if (agentType === 'claude' && cwd) {
      cmd.push('--add-dir', cwd);
    }

    for (const dir of new Set(addDirs)) {
      if (dir !== cwd) cmd.push('--add-dir', dir);
    }

    if (agentType === 'codex') {
      cmd.push('--add-dir', getSystemAgentsDir());
    }

    return cmd;
  }

  async get(agentId: string): Promise<AgentProcess | null> {
    await this.initialize();
    let agent = this.agents.get(agentId) || null;
    if (agent) {
      await agent.readNewEvents();
      await agent.updateStatusFromProcess();
      return agent;
    }

    agent = await AgentProcess.loadFromDisk(agentId, this.agentsDir);
    if (agent) {
      await agent.readNewEvents();
      await agent.updateStatusFromProcess();
      this.agents.set(agentId, agent);
      return agent;
    }

    return null;
  }

  async resolveAgentIdInTask(
    taskName: string,
    ref: string
  ): Promise<
    | { kind: 'ok'; agentId: string }
    | { kind: 'none' }
    | { kind: 'ambiguous'; matches: string[] }
  > {
    const agents = await this.listByTask(taskName);
    const byName = agents.find((a) => a.name === ref);
    if (byName) return { kind: 'ok', agentId: byName.agentId };
    const exact = agents.find((a) => a.agentId === ref);
    if (exact) return { kind: 'ok', agentId: exact.agentId };
    const prefix = agents.filter((a) => a.agentId.startsWith(ref));
    if (prefix.length === 1) return { kind: 'ok', agentId: prefix[0].agentId };
    if (prefix.length === 0) return { kind: 'none' };
    return { kind: 'ambiguous', matches: prefix.map((a) => a.agentId) };
  }

  async listAll(): Promise<AgentProcess[]> {
    await this.initialize();
    const agents = Array.from(this.agents.values());
    for (const agent of agents) {
      await agent.readNewEvents({ skipRemote: this.localOnly });
      await agent.updateStatusFromProcess({ skipRemote: this.localOnly });
    }
    return agents;
  }

  async listRunning(): Promise<AgentProcess[]> {
    const all = await this.listAll();
    return all.filter(a => a.status === AgentStatus.RUNNING);
  }

  async listCompleted(): Promise<AgentProcess[]> {
    const all = await this.listAll();
    return all.filter(a => isTerminalStatus(a.status));
  }

  async listByTask(taskName: string): Promise<AgentProcess[]> {
    const all = await this.listAll();
    return all.filter(a => a.taskName === taskName);
  }

  async purgeByTask(taskName: string, opts?: { keepLogs?: boolean }): Promise<string[]> {
    await this.initialize();
    const roster = await this.listByTask(taskName);
    const purged: string[] = [];
    const base = this.agentsDir || (await getAgentsDir());

    for (const agent of roster) {
      this.agents.delete(agent.agentId);
      const agentDir = path.join(base, agent.agentId);
      try {
        if (opts?.keepLogs) {
          await fs.rm(path.join(agentDir, 'meta.json'), { force: true });
        } else {
          await fs.rm(agentDir, { recursive: true, force: true });
        }
        purged.push(agent.agentId);
      } catch (err) {
        debug(`purgeByTask: failed to remove ${agent.agentId}: ${err}`);
        purged.push(agent.agentId);
      }
    }
    return purged;
  }

  async listByParentSession(parentSessionId: string): Promise<AgentProcess[]> {
    const all = await this.listAll();
    return all.filter(a => a.parentSessionId === parentSessionId);
  }

  async stopByTask(taskName: string): Promise<{ stopped: string[]; alreadyStopped: string[] }> {
    const agents = await this.listByTask(taskName);
    const stopped: string[] = [];
    const alreadyStopped: string[] = [];

    for (const agent of agents) {
      if (agent.status === AgentStatus.RUNNING) {
        const success = await this.stop(agent.agentId);
        if (success) {
          stopped.push(agent.agentId);
        }
      } else {
        alreadyStopped.push(agent.agentId);
      }
    }

    return { stopped, alreadyStopped };
  }

  async stop(agentId: string): Promise<boolean> {
    await this.initialize();
    const agent = this.agents.get(agentId);
    if (!agent) {
      return false;
    }

    if (agent.hostName && agent.status === AgentStatus.RUNNING) {
      if (agent.hostTarget && agent.remotePid) {
        try {
          sshExec(agent.hostTarget, `kill -TERM -- -${agent.remotePid} 2>/dev/null`, {
            timeoutMs: 10000,
            multiplex: true,
            extraSshArgs: agent.hostIdentityFile ? ['-i', agent.hostIdentityFile, '-o', 'IdentitiesOnly=yes'] : [],
          });
        } catch {
        }
      }
      agent.status = AgentStatus.STOPPED;
      agent.completedAt = new Date();
      await agent.saveMeta();
      debug(`Stopped remote agent ${agentId} on ${agent.hostName}`);
      return true;
    }

    if (agent.pid && agent.status === AgentStatus.RUNNING) {
      if (!agent.isProcessAlive()) {
        debug(`Agent ${agentId} PID ${agent.pid} no longer ours (start-time mismatch or exited); skipping signal`);
        agent.status = AgentStatus.STOPPED;
        agent.completedAt = new Date();
        await agent.saveMeta();
        return true;
      }

      try {
        process.kill(-agent.pid, 'SIGTERM');
        debug(`Sent SIGTERM to agent ${agentId} (PID ${agent.pid})`);

        await new Promise(resolve => setTimeout(resolve, 2000));
        if (agent.isProcessAlive()) {
          process.kill(-agent.pid, 'SIGKILL');
          debug(`Sent SIGKILL to agent ${agentId}`);
        }
      } catch {
      }

      agent.status = AgentStatus.STOPPED;
      agent.completedAt = new Date();
      await agent.saveMeta();
      debug(`Stopped agent ${agentId}`);
      return true;
    }

    return false;
  }

  private async cleanupOldAgents(): Promise<void> {
    const completed = await this.listCompleted();
    if (completed.length > this.maxAgents) {
      completed.sort((a, b) => {
        const aTime = a.completedAt?.getTime() || 0;
        const bTime = b.completedAt?.getTime() || 0;
        return aTime - bTime;
      });
      for (const agent of completed.slice(0, completed.length - this.maxAgents)) {
        this.agents.delete(agent.agentId);
        try {
          const agentDir = await agent.getAgentDir();
          await fs.rm(agentDir, { recursive: true });
        } catch (err) {
          console.warn(`Failed to cleanup old agent ${agent.agentId}:`, err);
        }
      }
    }
  }
}
