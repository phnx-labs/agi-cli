/**
 * Teams agent lifecycle management.
 *
 * Defines the AgentProcess and AgentManager classes that handle spawning,
 * monitoring, stopping, and persisting teammate processes across all supported
 * agent CLIs (Claude, Codex, Cursor, OpenCode). Supports DAG-based
 * dependency scheduling via --after, per-teammate model/effort overrides, and
 * multiple permission modes (plan, edit, full).
 */
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

// On macOS, os.freemem() returns only the truly-free pool and ignores the
// large inactive+purgeable cache the kernel will reclaim under pressure, so
// it always looks alarmingly low on a healthy Mac. Parse vm_stat to get the
// real "available" figure: free + inactive + purgeable + speculative.
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

/**
 * Compute the Lowest Common Ancestor (LCA) of multiple file paths.
 * Returns the deepest common directory shared by all paths.
 * Returns null if paths is empty or paths have no common ancestor (different roots).
 */
export function computePathLCA(paths: string[]): string | null {
  const validPaths = paths.filter(p => p && p.trim());
  if (validPaths.length === 0) return null;
  if (validPaths.length === 1) return validPaths[0];

  // Normalize and split all paths into segments
  const splitPaths = validPaths.map(p => {
    const normalized = path.resolve(p);
    // Split by path separator, filter empty segments
    return normalized.split(path.sep).filter(seg => seg);
  });

  // Find minimum length
  const minLen = Math.min(...splitPaths.map(p => p.length));

  // Find common prefix
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

  // Reconstruct path (add leading separator for absolute paths)
  const lca = path.sep + commonSegments.join(path.sep);
  return lca;
}

/** Lifecycle status of a teammate process. */
export enum AgentStatus {
  PENDING = 'pending',     // staged with unresolved --after deps
  RUNNING = 'running',
  COMPLETED = 'completed',
  FAILED = 'failed',
  STOPPED = 'stopped',
}

/**
 * The statuses a teammate can never leave — its process has run and finished
 * (or been stopped). Everything else (pending, running) is still live work.
 *
 * This is the ONLY set that retention (cleanupOldAgents) may reap: a `pending`
 * teammate has not launched yet and a `running` one is doing work, so deleting
 * either is data loss. Treating "not running" as "completed" was the RUSH-2356
 * bug — it swept live `pending` `--after` teammates past the 50-record cap.
 */
export const TERMINAL_STATUSES: ReadonlySet<AgentStatus> = new Set([
  AgentStatus.COMPLETED,
  AgentStatus.FAILED,
  AgentStatus.STOPPED,
]);

/** True when a teammate has reached a terminal (completed/failed/stopped) status. */
export function isTerminalStatus(status: AgentStatus): boolean {
  return TERMINAL_STATUSES.has(status);
}

export type TeammateFailureStage = 'placement' | 'spawn' | 'execution' | 'dependency' | 'cloud';

/** Durable evidence observed at a concrete teammate lifecycle boundary. */
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

/**
 * One remote teammate's liveness, resolved by a single host probe. Three states,
 * kept distinct on purpose (RUSH-2366):
 *   - alive=true                                → process still running.
 *   - exitFilePresent=true                      → the `.exit` sentinel exists;
 *     `exit` is its (possibly empty, mid-write) contents.
 *   - alive=false && !exitFilePresent  ("GONE") → the process is gone AND the
 *     wrapper never recorded a sentinel — it was killed / the box died. There is
 *     no exit code coming, so this MUST resolve terminal instead of "running
 *     forever". Collapsing GONE into the empty-`.exit` case is exactly the bug
 *     that left a dead `--device` teammate RUNNING indefinitely.
 */
export interface RemoteLivenessSnapshot {
  alive: boolean;
  exit: string | null;
  exitFilePresent: boolean;
}

/**
 * The per-teammate shell that emits `<id> <ALIVE|EXITED|GONE> <codeOrEmpty>`.
 * Shared by the batched prefetch (many teammates, one round-trip) and the
 * direct single-teammate probe, so both classify liveness identically.
 * `exitFile` is interpolated UNQUOTED so `$HOME` in the dispatch path expands on
 * the remote shell (shellQuote would defeat the `[ -f ]` test).
 */
export function remoteLivenessSnippet(id: string, exitFile: string, pid: number): string {
  return (
    `printf '%s ' ${shellQuote(id)}; ` +
    `if [ -f ${exitFile} ]; then printf 'EXITED '; cat ${exitFile} 2>/dev/null | tr -d '\\n'; printf '\\n'; ` +
    `elif kill -0 ${pid} 2>/dev/null; then printf 'ALIVE\\n'; ` +
    `else printf 'GONE\\n'; fi`
  );
}

/** Parse one `<STATE> <codeOrEmpty>` reading into a snapshot. */
export function parseRemoteLivenessState(state: string, code: string | undefined): RemoteLivenessSnapshot {
  if (state === 'ALIVE') return { alive: true, exit: null, exitFilePresent: false };
  if (state === 'EXITED') return { alive: false, exit: code ?? '', exitFilePresent: true };
  // GONE (or an unrecognised token): process not alive, no sentinel recorded.
  return { alive: false, exit: null, exitFilePresent: false };
}

/** Task type label for Software Factory workflows. Drives planner fan-out. Optional — teammates without a task_type work exactly as before. */
export type TaskType = 'plan' | 'implement' | 'test' | 'review' | 'bugfix' | 'docs';
export const VALID_TASK_TYPES: readonly TaskType[] = [
  'plan', 'implement', 'test', 'review', 'bugfix', 'docs',
] as const;

/**
 * Walk the `after` chain from `startName` within the given map; returns true
 * if `targetName` appears anywhere in the transitive dependency closure.
 * Used to detect cycles before adding a new --after edge.
 */
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

/**
 * Single-quote a string for safe interpolation into a POSIX `sh -c` command.
 * Wraps in single quotes and escapes embedded single quotes via the standard
 * `'\''` close-escape-reopen idiom, so arbitrary prompts/paths can't break out
 * of quoting or inject shell syntax.
 */
function shSingleQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * Wrap a teammate argv in a POSIX shell command that runs it and then records
 * the real exit code to `exitCodePath`. `echo $?` captures the status of the
 * preceding command, so the sentinel reflects the underlying CLI's exit code,
 * not the shell's. Single source of truth shared by launchProcess() and its
 * test. See reapProcess() for how the sentinel is consumed.
 */
export function buildSentinelCommand(cmd: string[], exitCodePath: string): string {
  return `${cmd.map(shSingleQuote).join(' ')}; echo $? > ${shSingleQuote(exitCodePath)}`;
}

/**
 * Env for a locally-spawned teammate. Freezes ONE actor for the whole spawn
 * tree: actorEnv(resolveActor()) stamps AGENTS_ACTOR* onto the child env, so the
 * teammate's inner `agents run` reads it via inheritedActor and short-circuits
 * computeActor instead of re-resolving — every teammate under one orchestrator
 * shares the orchestrator's single frozen actor (see actor.ts). Precedence:
 * process env < actor < the teammate's --env overrides, so an explicit override
 * still wins. Single source of truth shared by launchProcess() and its test.
 */
export function buildTeammateSpawnEnv(
  envOverrides: Record<string, string> | null,
): NodeJS.ProcessEnv {
  return {
    ...sanitizeProcessEnv(process.env),
    ...actorEnv(resolveActor()),
    ...(envOverrides ?? {}),
  };
}

/**
 * Re-exported from `platform/process.ts`, which owns the one implementation.
 *
 * This module used to carry its own near-identical copy, and that copy had no
 * Windows branch — it fell through to `ps`, which does not exist there, so
 * `captureProcessStartTime` always returned null and the pid-reuse guard at
 * `stop()` was silently inert on Windows. That is exactly how `agents teams stop`
 * ends up SIGKILLing an unrelated process group once the OS recycles a pid.
 */
export { captureProcessStartTime };

/** Agent types the team runner supports. */
const TEAM_AGENT_TYPES: AgentType[] = ['codex', 'cursor', 'claude', 'opencode', 'grok', 'antigravity', 'kimi', 'droid', 'warp'];

/**
 * Reasoning-intensity knob. Passed through to `agents run --effort`, which
 * translates it into per-agent reasoning flags (claude --effort, codex
 * model_reasoning_effort override). Mode (plan/edit/full) is a separate knob.
 */
export type EffortLevel = 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'auto';

// Suffix appended to all prompts to ensure agents provide a summary
const PROMPT_SUFFIX = `

When you're done, provide a brief summary of:
1. What you did (1-2 sentences)
2. Key files modified and why
3. Any important classes, functions, or components you added/changed`;

// Prefix for Claude agents in plan mode - explains the headless plan mode restrictions
const CLAUDE_PLAN_MODE_PREFIX = `You are running in HEADLESS PLAN MODE. This mode works like normal plan mode with one exception: you cannot write to ~/.claude/plans/ directory. Instead of writing a plan file, output your complete plan/response as your final message.

`;

// PHNX-3236: the teammate self-merge boundary, injected as a DISPATCH DEFAULT.
// A write-capable teammate has `gh pr merge` and authenticates as the repo owner,
// so it can merge its OWN PR past the required non-author-review gate — which is
// exactly what happened in the RUSH-2988 wave-1 dispatch (PR #1817, #1820). The
// root cause was that the boundary lived in per-brief wording: one teammate in the
// batch was told "open the PR, don't merge" and held off; the others weren't and
// self-merged. Making it a default the runner appends to every non-plan teammate
// gives one HARNESS-INDEPENDENT layer instead of relying on each dispatch prompt
// remembering to say it. The HARD enforcement is merge-guard.sh — a PreToolUse hook
// the teammate inherits from the shared version home, whose self-authored-verdict
// exclusion was closed in the same ticket (.agents-system #395) so a verdict a
// teammate posts on its own PR no longer clears the gate. The two layers do NOT
// overlap everywhere: hook-capable local/remote teammates get both, but cloud
// teammates (provider sandbox, no inherited hook) and hook-incapable harnesses
// (Warp/oz — no hook surface, no allowlist) get ONLY this prompt, so for them it is
// a soft control. That residual is documented in cli/AGENTS.md §6; server-side
// branch protection is the client-independent way to close it. This is the
// harness-independent layer plus the operator hand-off contract, not a replacement
// for the hard block where the hard block can run.
const TEAMMATE_PR_POLICY = `

Teammate PR policy (agents teams): when your work opens a pull request, open it and
hand it off — do NOT merge your OWN PR unless a NON-AUTHOR review verdict has been
posted on that same PR. You authenticate as the repo owner and share that one
GitHub identity with every other teammate, so an APPROVE you post on your own PR
does not count as a non-author review. \`gh pr merge\` on your own PR is blocked by
merge-guard until a genuine non-author verdict exists on it; never pass --admin or
otherwise route around that guard. Report the PR as open and let the orchestrator
or a separate reviewer take it to merge.`;

/**
 * Append {@link TEAMMATE_PR_POLICY} to a teammate prompt for every WRITE-capable
 * mode (all but plan, which is read-only and opens no PR). Exported so the CLOUD
 * dispatch path (`cloudDispatchOptions` in `commands/teams.ts`) applies the SAME
 * boundary this file's `buildRunArgv` applies to LOCAL and REMOTE teammates. A
 * cloud teammate is the case that needs it MOST: it runs in the provider's
 * sandbox, not the shared local version home, so it never inherits the
 * `merge-guard.sh` PreToolUse hook — the prompt policy is then its ONLY
 * self-merge layer. Routing every dispatch surface through one helper keeps that
 * parity from drifting (PHNX-3236).
 */
export function withTeammatePrPolicy(prompt: string, mode: string): string {
  return mode === 'plan' ? prompt : prompt + TEAMMATE_PR_POLICY;
}

// Canonical modes plus the historical `full` alias (rewritten to `skip` by
// normalizeModeValue). Keep `full` listed so user-typed CLI flags and stored
// metadata that pre-date the rename continue to parse.
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

/** Resolve a mode string to a validated Mode, falling back to the given default. */
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

/**
 * Check whether the CLI binary for a given agent type is installed.
 * Returns [available, pathOrError].
 *
 * The agents-managed shims dir (`~/.agents/.cache/shims`) is the canonical
 * install location, so a shim there means installed regardless of the caller's
 * PATH. Non-interactive callers — the menu-bar helper, cron, CI — run with a
 * minimal launchd PATH that omits the shims dir; a bare PATH lookup false-flags
 * every shim-based CLI as "not installed". Check the shim first, PATH second
 * (for CLIs the user installed outside agents-cli).
 */
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

  // A shim file (or a PATH entry) existing does NOT mean the agent is runnable:
  // the managed default version's binary can be a stub or gutted (a partial/raced
  // npm extract leaves the version dir + JS wrapper but no real binary). Verify
  // the resolved default version is actually installed so `teams doctor` reports
  // the truth instead of a false `installed: true` that ENOENTs at spawn.
  const version = resolveVersion(agent);
  if (version && !isVersionInstalled(agent, version)) {
    return [false, `${executable}@${version} is not runnable — its binary is missing/incomplete. Repair: agents add ${agent}@${version}`];
  }
  return [true, dispatch];
}

/** Check availability of all known agent CLIs. Returns a map of agent type to install status. */
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

/** Advisory sign-in status for a `teams doctor` row. */
export interface SignInAdvisory {
  /** true / false from the probe, or null when the agent isn't installed. */
  signedIn: boolean | null;
  /** Whether the agent is currently a running teammate. */
  running: boolean;
}

/**
 * Resolve the advisory sign-in status shown by `teams doctor`. An agent that is
 * currently RUNNING in a team is live proof it works, so it overrides a
 * (frequently false-negative) sign-in probe — doctor must never report a
 * working agent as logged out. Not installed → `signedIn: null` (nothing to
 * probe). Never flips the authoritative installed/ready column.
 */
export function resolveSignInAdvisory(
  installed: boolean,
  running: boolean,
  probeSignedIn: boolean
): SignInAdvisory {
  if (!installed) return { signedIn: null, running: false };
  return { signedIn: running ? true : probeSignedIn, running };
}

/** One row of `agents teams doctor --json` output. */
export interface TeamsDoctorEntry {
  installed: boolean;
  path: string | null;
  error: string | null;
  signedIn: boolean | null;
  running: boolean;
}

/**
 * Collect the same data `agents teams doctor` prints: per-agent install status,
 * launch health, and advisory sign-in state. Kept in one place so `agents doctor
 * --devices` can run it locally or compare it against remote JSON without
 * duplicating the probe logic.
 */
export async function collectTeamsDoctorData(): Promise<Record<string, TeamsDoctorEntry>> {
  const info = checkAllClis();

  // Deep integrity probe. `checkAllClis` reports presence (shim + stub guard),
  // but a gutted native binary still passes that, so actually launch the default
  // version and flip the agent to not-installed if it won't run.
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

  // Advisory enrichment only. Sign-in detection is unreliable, so it never
  // changes the authoritative installed/ready column — it annotates. A running
  // teammate overrides a negative probe.
  const running = new Set<string>();
  try {
    for (const a of await new AgentManager().listRunning()) running.add(a.agentType);
  } catch { /* no teams yet — leave running empty */ }

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

/** Resolve and cache the base directory where teammate process data is stored. */
export async function getAgentsDir(): Promise<string> {
  if (!AGENTS_DIR) {
    AGENTS_DIR = await resolveAgentsDir();
  }
  return AGENTS_DIR;
}

/**
 * Represents a single teammate process within a team.
 *
 * Tracks process metadata (PID, status, timestamps), reads incremental
 * stdout events, persists state to disk as meta.json, and can be
 * reconstituted from disk via loadFromDisk().
 */
export class AgentProcess {
  agentId: string;
  taskName: string;
  agentType: AgentType;
  prompt: string;
  cwd: string | null;
  workspaceDir: string | null;
  mode: Mode = 'plan';
  pid: number | null = null;
  // Captured at spawn time so we can detect PID reuse before signaling.
  // Compared against the live /proc or `ps` value at every kill() call.
  startTime: string | null = null;
  status: AgentStatus = AgentStatus.RUNNING;
  startedAt: Date = new Date();
  completedAt: Date | null = null;
  parentSessionId: string | null = null;
  // Frozen actor (resolveActor().id) this teammate runs under. Stamped onto the
  // local spawn env via actorEnv (buildTeammateSpawnEnv) so the teammate's inner
  // `agents run` inherits one actor for the whole tree instead of re-resolving,
  // and persisted so the record shows who ran it. Set from the resolved actor at
  // construction; loadFromDisk restores the persisted value.
  actor: string | null = null;
  cloudSessionId: string | null = null;
  cloudProvider: string | null = null;
  prUrl: string | null = null;
  version: string | null = null;
  remoteSessionId: string | null = null;
  name: string | null = null;
  // Names of teammates in the same team that this teammate is waiting on.
  // Empty array = no deps = can run immediately. Populated by `teams add --after`.
  after: string[] = [];
  // Reasoning-intensity knob wired into buildReasoningFlags at launch time.
  // Resolved late so config/effort-default changes between spawn and launch
  // are honored for teammates staged via `teams add --after`.
  effort: EffortLevel | null = null;
  // Pinned model for this teammate. When null, the agent's CLI picks its
  // own default (no --model forwarded).
  model: string | null = null;
  // Profile target name when the teammate was added via `agents teams add
  // <team> <profile>`. The launcher targets the profile name so env/keychain
  // injection happens; agentType stays the underlying harness so event
  // parsers and CLI availability checks keep working.
  profileName: string | null = null;
  // Extra env vars passed through to the child process (from --env KEY=VALUE).
  envOverrides: Record<string, string> | null = null;
  // Factory task-type label. Drives planner fan-out. Null for plain teammates — no behavioral change.
  taskType: TaskType | null = null;
  // Repo/branch for cloud dispatches that stage behind --after. Captured
  // at spawn time so startReady() can invoke the dispatcher with the same
  // options the user originally supplied.
  cloudRepo: string | null = null;
  cloudBranch: string | null = null;
  // Worktree isolation: when non-null, this teammate runs in its own git worktree.
  worktreeName: string | null = null;
  worktreePath: string | null = null;
  // The team's `--project`, if it has one. Stored as the NAME, not as resolved
  // directories: an unpinned teammate on a `--devices` pool is placed at LAUNCH
  // (maybeSchedulePlacement), so grants resolved at add time would carry this
  // box's absolute paths onto whatever host the scheduler later picked — and
  // would already have dropped any directory that exists only there. Resolving
  // per launch is what makes local and remote placement both correct.
  project: string | null = null;
  // Distributed teams: when hostName is non-null, this teammate runs on another
  // machine over SSH (the "remote-host" backend), not as a local process. These
  // are set post-construction (like startTime/pid) — placement config at add
  // time (hostName/hostTarget/repoPath) and runtime handles at launch time
  // (remotePid/remoteLog/remoteExit) — so the giant constructor stays untouched.
  hostName: string | null = null;
  hostTarget: string | null = null;
  hostIdentityFile: string | null = null;
  repoPath: string | null = null;
  remotePid: number | null = null;
  remoteLog: string | null = null;
  remoteExit: string | null = null;
  failure: TeammateFailure | null = null;
  // Offset-tail cursor into the REMOTE log (bytes already pulled). Distinct from
  // lastReadPos, which tracks the LOCAL mirror the parser consumes.
  remoteLogOffset: number = 0;
  // Per-wave batched-poll snapshot, refreshed each wave by the supervisor's
  // one-ssh-per-host pre-pass (AgentManager.prefetchRemoteStatus) and read by
  // isProcessAlive()/readNewEvents() so they skip their own SSH round-trip. It is
  // set anew (and cleared for uncovered teammates) at the START of every prefetch,
  // so it persists across BOTH poll passes within one wave (startReady's roster
  // scan + the supervisor's listByTask) yet never carries into the next wave. Null
  // outside a batched wave (e.g. a bare `teams status`), where a direct per-teammate
  // SSH probe is the correctness fallback.
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
    // Any mode that can mutate the workspace counts as "edit mode" for the
    // purposes of guarding read-only flows (plan-mode teammates).
    return this.mode === 'edit' || this.mode === 'auto' || this.mode === 'skip';
  }

  async getAgentDir(): Promise<string> {
    const base = this.baseDir || await getAgentsDir();
    return path.join(base, this.agentId);
  }

  /**
   * Dump the subset of state the Ledger sync hook needs. Keeps sync.ts
   * free of any teams-internal imports.
   */
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

  /**
   * Path to the exit-code sentinel. The launcher wraps the teammate command in
   * a shell that writes the underlying CLI's `$?` here once it exits. Detached
   * teammates can't be wait()ed on by the parent, so this file is the only
   * durable record of the real exit status — see reapProcess().
   */
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

  /**
   * Return the latest timestamp we have seen in the agent's events.
   * Falls back to null when none are available.
   */
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

  /**
   * For a distributed (remote-host) teammate, pull NEW bytes of the host's log
   * into the LOCAL mirror the parser consumes, advance the remote offset, and
   * resolve terminal status from the remote `.exit` sentinel. Runs BEFORE the
   * local read in readNewEvents(), so the existing stream-json parse path then
   * runs unchanged over the freshly-mirrored bytes.
   *
   * Uses a per-wave batched snapshot (remotePollSnapshot) when the supervisor's
   * one-ssh-per-host pre-pass populated it; otherwise falls back to its own
   * round-trips so a bare `teams status`/`teams logs` is still correct.
   *
   * Only polls a teammate that is plausibly still RUNNING (RUSH-2118). Once a
   * remote teammate reaches a terminal status, the poll that resolved it already
   * mirrored the final log bytes and read the `.exit` sentinel in this SAME
   * function (delta pulled before the exit check below) — the underlying process
   * is gone and can never write more, so there is nothing left to fetch. Without
   * this guard every finished remote teammate still cost one ssh round-trip on
   * EVERY `--active`/`listAll` poll forever, which is what made `agents sessions
   * --active --local` take ~4.3s on a box with 30 completed teammates.
   */
  private async syncRemoteMirror(): Promise<void> {
    if (!this.hostName || !this.hostTarget || !this.remoteLog) return;
    if (this.status !== AgentStatus.RUNNING) return;

    // Pull the new remote bytes and append them to the local mirror the parser
    // reads. One offset-tail round-trip; nothing to write when the log is quiet.
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
        // best-effort mirror — leave the offset unadvanced so we retry next poll
      }
    }

    // Resolve terminal status from the host. Prefer this wave's batched snapshot;
    // else probe this teammate directly. The snapshot is left in place (refreshed
    // each wave by prefetch), so a second poll pass within the same wave reuses it.
    const snap = this.remotePollSnapshot ?? (await this.probeRemoteLiveness());
    if (!snap) return; // transient ssh failure — leave RUNNING, retry next poll

    // Only latch terminal on a PARSEABLE exit code. A `.exit` that exists but is
    // momentarily empty (created, not yet written) or garbage must NOT force a
    // spurious FAILED — leave the teammate RUNNING and let the next poll resolve
    // it once the code lands.
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

    // No exit code resolved it. If the remote process is GONE with NO sentinel at
    // all, the wrapper died before recording `$?` (killed, box lost, OOM) — it can
    // never write a code, so this teammate is FAILED, not "running forever"
    // (RUSH-2366). This is the remote analog of reapProcess()'s "sentinel absent
    // -> 1 -> FAILED". An EXITED-but-empty `.exit` (wrapper mid-write) is left
    // RUNNING above precisely so this branch does not misfire on that race.
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

  /**
   * One-shot direct liveness probe for a single remote teammate — the fallback
   * used outside a batched supervisor wave (a bare `teams status`, `mgr.get()`
   * for `teams resume`). Returns null on a transient ssh failure so the caller
   * leaves the teammate RUNNING rather than reaping it on a dropped connection.
   */
  private async probeRemoteLiveness(): Promise<RemoteLivenessSnapshot | null> {
    if (!this.hostTarget || !this.remotePid || !this.remoteExit) return null;
    const res = sshExec(this.hostTarget, remoteLivenessSnippet(this.agentId, this.remoteExit, this.remotePid), {
      timeoutMs: 8000,
      multiplex: true,
      extraSshArgs: this.hostIdentityFile ? ['-i', this.hostIdentityFile, '-o', 'IdentitiesOnly=yes'] : [],
    });
    if (res.code === null) return null; // transient ssh failure — don't reap early
    const trimmed = res.stdout.trim();
    if (!trimmed) return null;
    const [, state, code] = trimmed.split(/\s+/);
    if (!state) return null;
    return parseRemoteLivenessState(state, code);
  }

  /** Reset the local stdout cursor for a newly truncated resume log. */
  resetLogReadPosition(): number {
    const previous = this.lastReadPos;
    this.lastReadPos = 0;
    return previous;
  }

  /** Restore the cursor when a resume transaction puts the prior log back. */
  restoreLogReadPosition(position: number): void {
    this.lastReadPos = position;
  }

  /**
   * @param opts.skipRemote A `--local` caller (RUSH-2118): never dial a
   *   remote-host teammate, not even a still-RUNNING one — report its
   *   last-persisted meta.json state as-is. A local-only query is by definition
   *   this-machine-only, so it must not issue an ssh round-trip at all.
   */
  async readNewEvents(opts: { skipRemote?: boolean } = {}): Promise<void> {
    if (this.hostName && opts.skipRemote) return;
    // Distributed teammate: mirror the host's new log bytes locally first, then
    // fall through to the identical local read+parse below.
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

            // Capture the agent's own session/thread id the first time we see
            // it. For Claude it's the same uuid we passed via --session-id;
            // for others (Codex thread_id, Gemini/Cursor/OpenCode sessionID)
            // it's their internal id, which lets us cross-reference with
            // `agents sessions <id>`.
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

    // Distributed teammate: keep the orchestrator bounded across 10+ remote
    // teammates. The parser has already consumed everything up to lastReadPos
    // (status/digest updated), so both the on-disk mirror tail and the in-memory
    // event backlog are safe to trim. The host keeps the full log.
    if (this.hostName) {
      await this.capMirrorToTail();
      this.capEventsCache();
    }
  }

  /**
   * Truncate the local mirror to its trailing REMOTE_MIRROR_MAX_BYTES and reset
   * lastReadPos to the new (smaller) size so the parser doesn't re-read the kept
   * tail. Only trims when over the cap — a normal-length log is untouched.
   */
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
      // The parser consumed up to lastReadPos already; after truncation the file
      // is `bytesRead` long, so clamp the cursor to the new EOF. It never needs
      // to re-read the retained tail (events already cached).
      this.lastReadPos = Math.min(this.lastReadPos, bytesRead);
    } catch {
      // best-effort — a failed cap just leaves the mirror larger this wave
    }
  }

  /** Cap on the in-memory event backlog kept per remote teammate. */
  private static readonly REMOTE_EVENTS_MAX = 200;

  /**
   * Drop the oldest cached events for a remote teammate once past the cap. The
   * status path only needs recent events (last N messages, recentToolCalls,
   * terminal status) and the getDelta cursor filters by timestamp, so a bounded
   * recent window preserves the digest while bounding the heap. Terminal status
   * is already latched onto `this.status`, so trimming can't lose it.
   */
  private capEventsCache(): void {
    const max = AgentProcess.REMOTE_EVENTS_MAX;
    if (this.eventsCache.length > max) {
      this.eventsCache = this.eventsCache.slice(-max);
    }
  }

  async saveMeta(): Promise<void> {
    // RUSH-2450: a long-lived supervisor (teams start --watch) holds AgentProcess
    // objects in memory. After another process disbands the team and deletes
    // every meta.json, the supervisor's next status refresh would re-write those
    // files via saveMeta — resurrecting PENDING teammates the operator just
    // disbanded, and making `teams start` re-launch already-merged work. Refuse
    // when a disband tombstone is present (set by removeTeam / markTeamDisbanded).
    // Not gated on "team not in registry" alone: tests and mid-add paths write
    // meta before/without a registry entry, and those must keep working.
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

  /**
   * Rename an unreadable meta.json out of the way so it stops silently
   * masquerading as "no record" (RUSH-2429). Before saveMeta() wrote atomically,
   * a process killed mid-write left a truncated, unparseable meta.json that
   * loadFromDisk() returned null for -- indistinguishable from ENOENT -- so
   * retention (loadExistingAgents/rescanFromDisk) never reaped it and
   * isWorktreeClaimed() (which reads meta.json directly, not through this
   * method) failed CLOSED on it forever: it scans every record and answers
   * "claimed" for every worktree name in every team the first time it cannot
   * read one. Quarantining removes meta.json so the NEXT read of this record
   * sees ENOENT (genuinely absent) instead of "unreadable" -- that is what lets
   * isWorktreeClaimed's fail-closed guard recover once the corrupt record is
   * gone, without weakening the guard itself for a record that is still
   * present-but-unreadable at decision time.
   *
   * Best-effort: if the rename itself fails (e.g. EACCES on the directory),
   * the record is left in place and the fail-closed guard keeps protecting
   * worktree removal -- quarantine only ever ADDS a recovery path.
   */
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
      // A READ error is not a corrupt record. ENOENT proves the record is
      // genuinely ABSENT; anything else -- EACCES, EIO, a transient EMFILE
      // under fd pressure -- means the file exists and could not be read THIS
      // time, but its contents are intact. We MUST NOT quarantine (rename) it:
      // renaming a valid record away is exactly the fail-open that RUSH-2429
      // forbids -- isWorktreeClaimed() reads meta.json directly and fails
      // CLOSED on the same read error (safe), but a rename here would delete
      // the record it relies on and turn a live teammate's worktree into
      // "unclaimed", re-arming `git worktree remove --force` over uncommitted
      // work. Return null (skip this scan); the file stays for the next read.
      return null;
    }

    try {
      const meta = JSON.parse(metaContent);

      // Legacy teammates may have mode='ralph', 'cloud', or 'full' from before
      // modes were narrowed/renamed. Coerce to the closest current mode so they
      // still load.
      const modeMap: Record<string, Mode> = {
        plan: 'plan',
        edit: 'edit',
        auto: 'auto',
        skip: 'skip',
        full: 'skip',   // historical alias — `full` is the old name for `skip`
        ralph: 'skip',  // ralph used the same "no-permission" flags as full
        cloud: 'edit',  // cloud teammates had edit-level write access
      };
      const resolvedMode: Mode = modeMap[meta.mode] || 'plan';

      // AgentStatus is a string enum. Validate meta.status against its VALUES
      // (not its keys) — `AgentStatus["pending"]` is undefined but
      // `AgentStatus.PENDING === "pending"` works.
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
      // The persisted actor is the truth for a reload; the constructor set it to
      // THIS process's resolved actor, which is wrong for a teammate someone else
      // ran. Legacy teammates predating the field carry no actor -> null.
      agent.actor = meta.actor ?? null;
      // Distributed-team fields: set post-construction (like startTime) so the
      // constructor signature stays fixed. Null on every pre-existing teammate.
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
      // The team's project. Absent on every teammate added before `--project`.
      agent.project = typeof meta.project === 'string' ? meta.project : null;
      return agent;
    } catch (err) {
      // The file exists but is not valid JSON (or fails a constructor
      // invariant) -- most likely a torn write from before saveMeta() became
      // atomic. Quarantine it; see quarantineCorruptMeta() above.
      await AgentProcess.quarantineCorruptMeta(metaPath, err);
      return null;
    }
  }

  isProcessAlive(): boolean {
    // Distributed teammate: a local PID is meaningless. Alive = the remote `.exit`
    // sentinel is absent AND `kill -0 <remotePid>` succeeds on the host, resolved
    // in a single ssh round-trip. Prefer the supervisor's batched snapshot when
    // present (consume it once so it can't go stale); otherwise probe directly.
    if (this.hostName) {
      // Prefer this wave's batched snapshot (persists across the wave's poll
      // passes; the supervisor refreshes it each wave). Fall back to a direct
      // probe outside a wave.
      if (this.remotePollSnapshot) return this.remotePollSnapshot.alive;
      if (!this.hostTarget || !this.remotePid || !this.remoteExit) return false;
      // remoteExit is a dispatch `$HOME/.agents/.cache/hosts/<hex>.exit` path —
      // interpolate UNQUOTED so `$HOME` expands (shellQuote would defeat it).
      const probe =
        `test -f ${this.remoteExit} && echo DEAD || ` +
        `(kill -0 ${this.remotePid} 2>/dev/null && echo ALIVE || echo DEAD)`;
      const res = sshExec(this.hostTarget, probe, {
        timeoutMs: 8000,
        multiplex: true,
        extraSshArgs: this.hostIdentityFile ? ['-i', this.hostIdentityFile, '-o', 'IdentitiesOnly=yes'] : [],
      });
      if (res.code === null) return true; // transient ssh failure — don't reap early
      return res.stdout.trim().endsWith('ALIVE');
    }

    if (!this.pid) return false;
    try {
      process.kill(this.pid, 0);
    } catch {
      return false;
    }
    // PID is occupied — but is it still OUR process? If we captured a
    // start-time at spawn, refuse to claim aliveness when the live value
    // differs. A null startTime means we never captured one (legacy
    // teammates loaded from disk before this field existed) — fall back to
    // the bare kill(pid, 0) result for those.
    if (this.startTime !== null) {
      const current = captureProcessStartTime(this.pid);
      if (current === null || current !== this.startTime) {
        return false;
      }
    }
    return true;
  }

  /**
   * Read just the persisted status + completion time from meta.json, without
   * reconstructing the whole teammate. Returns null when there is no readable
   * record on disk. Used to detect that ANOTHER process (a `teams stop`, a
   * sibling supervisor) has already moved this teammate to a terminal status.
   */
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

  /**
   * If this in-memory teammate is still non-terminal but disk already shows a
   * terminal status, adopt the disk state. Returns true when it did.
   *
   * This is the guard against the stale-manager race (RUSH-2366): a long-lived
   * supervisor holding a teammate as `running` must never re-persist that stale
   * `running` over a `stopped`/`failed`/`completed` another process just wrote
   * (e.g. an explicit `teams stop` in a separate CLI invocation). A terminal
   * status is a one-way latch, so disk-terminal always wins over memory-running.
   */
  private async adoptDiskTerminalIfNewer(): Promise<boolean> {
    if (isTerminalStatus(this.status)) return false;
    const disk = await this.readDiskStatus();
    if (!disk || !isTerminalStatus(disk.status)) return false;
    this.status = disk.status;
    this.completedAt = disk.completedAt ?? this.completedAt ?? new Date();
    return true;
  }

  /**
   * @param opts.skipRemote A `--local` caller (RUSH-2118): a distributed
   *   teammate is never dialed — its in-memory state (already loaded from
   *   meta.json) stands as-is, no ssh, no re-save.
   */
  async updateStatusFromProcess(opts: { skipRemote?: boolean } = {}): Promise<void> {
    // Stale-manager guard (RUSH-2366): if disk has already latched this teammate
    // terminal, adopt that and stop — a poll of a process that no longer exists
    // must not re-persist `running` over the newer on-disk terminal status.
    if (await this.adoptDiskTerminalIfNewer()) return;

    if (!this.pid) {
      // Distributed (remote-host) teammates have no local PID by design; their
      // lifecycle lives on the host. readNewEvents() mirrors the remote log and
      // resolves terminal status from the remote `.exit` sentinel (see
      // syncRemoteMirror), so we just persist and return — never the local
      // "RUNNING without a PID is impossible" fail path below.
      if (this.hostName) {
        if (opts.skipRemote) return;
        // Staged (--after) distributed teammates also have hostName set but no
        // PID yet (RUSH-2356 sibling bug): without this guard the `!== RUNNING`
        // fallback below stamps a completedAt on a teammate that hasn't even
        // launched, which the age-based reap in loadExistingAgents() would
        // later delete outright once it aged past cleanupAgeDays. Leave it
        // alone until startReady() launches it — matches the local-only guard
        // further below.
        if (this.status === AgentStatus.PENDING) return;
        await this.readNewEvents();
        if (this.status !== AgentStatus.RUNNING && !this.completedAt) {
          this.completedAt = this.getLatestEventTime() || this.startedAt || new Date();
        }
        await this.saveMeta();
        return;
      }

      await this.readNewEvents();

      // Cloud-backed teammates have no local PID by design; their lifecycle
      // is driven by the remote provider instead of a local process.
      if (this.cloudProvider) {
        // Same staged-teammate guard as the hostName branch above — a staged
        // cloud teammate is PENDING with no PID until its deps resolve.
        if (this.status === AgentStatus.PENDING) return;
        if (!this.completedAt && this.status !== AgentStatus.RUNNING) {
          const fallbackCompletion =
            this.getLatestEventTime() || this.startedAt || new Date();
          this.completedAt = fallbackCompletion;
          await this.saveMeta();
        }
        return;
      }

      // Pending teammates with unresolved --after deps also have no PID yet.
      // Leave them alone until startReady() launches them.
      if (this.status === AgentStatus.PENDING) {
        return;
      }

      // A local teammate marked RUNNING without a PID is an impossible state:
      // launch never produced a durable process identity, so it cannot still
      // be doing work. Keep any terminal event parsed from stdout; otherwise
      // fail it and stamp completion so team rollups stop showing it as live.
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

  /**
   * Recover the teammate's exit status after its process is gone.
   *
   * The teammate is spawned detached + unref()'d (see launchProcess), so the
   * parent never gets the child's exit code from the OS. Instead the launcher
   * wraps the command in a shell that records `$?` to the exit-code sentinel.
   * This reads that file:
   *   - still alive            -> null (no verdict yet)
   *   - sentinel present       -> the real exit code (0 = success)
   *   - sentinel absent        -> 1 (the shell was killed before it could write
   *                                  it, e.g. SIGKILL on timeout/stop — a real
   *                                  failure)
   *
   * Returning a real code (not a hardcoded 1) is what lets agents whose stream
   * never emits a parsed terminal event — kimi, antigravity, droid — be marked
   * completed on success instead of falsely failed.
   */
  private async reapProcess(): Promise<{ code: number; sentinelPresent: boolean } | null> {
    if (!this.pid) return null;
    // isProcessAlive() applies the start-time guard, so a recycled PID now
    // owned by an unrelated process doesn't read as still-alive.
    if (this.isProcessAlive()) return null;

    try {
      const raw = (await fs.readFile(await this.getExitCodePath(), 'utf-8')).trim();
      const code = Number.parseInt(raw, 10);
      return { code: Number.isNaN(code) ? 1 : code, sentinelPresent: true };
    } catch {
      // No sentinel: the shell died before recording $? (killed mid-run).
      return { code: 1, sentinelPresent: false };
    }
  }
}

/**
 * Manages the full lifecycle of teammate agent processes.
 *
 * Handles spawning (with DAG dependency resolution), status polling,
 * stopping, and automatic cleanup of old agents. Maintains an in-memory
 * cache backed by on-disk meta.json files.
 */
/**
 * Callback used to dispatch a cloud-backed teammate when its --after deps
 * resolve. Teams.ts registers one via setCloudDispatcher() at startup; the
 * MCP server path leaves it null (cloud teammates aren't dispatched from MCP).
 */
export type CloudDispatchFn = (agent: AgentProcess) => Promise<{ cloudSessionId: string }>;

/**
 * The directories, beyond its cwd, a teammate may reach because of the team's
 * `--project`. Resolved at LAUNCH, from the project name on the record.
 *
 * Resolving here rather than at `teams add` is load-bearing for a pooled team:
 * an unpinned teammate has no host until `maybeSchedulePlacement` runs, so add
 * time cannot know whether to produce absolute local paths or `~/…` — and the
 * local form would additionally have dropped any directory that exists only on
 * the host it later landed on.
 *
 * A project that no longer resolves (renamed, definition deleted) yields no
 * grants rather than failing the launch: the teammate still gets its cwd.
 */
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
    // Degrading is deliberate, but silently degrading is not: a teammate that
    // lost its grants to a renamed or deleted definition should leave a trace.
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
  /**
   * A `--local` caller (RUSH-2118): every poll this manager issues skips the
   * ssh round-trip for a distributed (remote-host) teammate, reporting its
   * last-persisted meta.json state instead. Set once at construction so the
   * INITIAL load in doInitialize()/loadExistingAgents() — which polls every
   * teammate before listRunning()/listAll() ever run — honors it too.
   */
  private localOnly: boolean;

  private constructorAgentsDir: string | null = null;

  /**
   * One-shot memo of the last `validateAddPreconditions` result, so the
   * command-layer pre-worktree call and spawn()'s own call don't each pay a
   * full `listAll()` status refresh (a round of SSH probes on a `--device`
   * team). Consumed by the first matching call — see that method.
   */
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
    // Mark the deferred rejection as observed. Construction fires init
    // fire-and-forget; every public method still surfaces a failed init at its
    // own `await this.initialize()` (the same promise rejects for each new
    // awaiter). Without this, an init that loses a race with its directory
    // being removed — measured twice as an unhandled
    // `ENOENT mkdir /tmp/agents-retention-*` that failed a fully-green suite
    // (exit 1 with 12k tests passed) and blocked release attestation — crashes
    // the process instead of failing the caller that actually cares.
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

  /**
   * Register the callback used to dispatch cloud-backed teammates when their
   * --after deps resolve. Called once at CLI startup by `agents teams`.
   */
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

  /**
   * Scan the agents dir for meta.json files not already in the in-memory
   * cache and load them. Needed when another process (e.g. a Planner
   * teammate running `agents teams add`) creates new teammates while this
   * manager is alive — the supervisor loop calls this each wave so
   * dynamically-added teammates get picked up.
   *
   * For a teammate ALREADY cached, refreshes it only when disk has latched it
   * terminal while the cache still holds it non-terminal — the case where
   * another process (e.g. `agents teams stop` in a separate CLI invocation)
   * moved it to `stopped`/`failed` and this long-lived manager would otherwise
   * never see it and re-persist a stale `running` (RUSH-2366). A still-live
   * cached teammate is left untouched; updateStatusFromProcess() owns that path.
   */
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
        // Adopt a disk-terminal status the cache hasn't seen; never overwrite a
        // cached teammate that is still live with a stale disk read. Terminal is
        // a one-way latch, so this can only move a teammate forward.
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

      // Age-based reap is a SECOND retention mechanism, independent of
      // cleanupOldAgents()'s cap-based one — and must obey the same invariant
      // (RUSH-2356): a non-terminal teammate is never a reap candidate,
      // however old its (possibly spuriously stamped) completedAt is. Belt and
      // suspenders alongside the PENDING guards above that stop completedAt
      // from getting set on a staged teammate in the first place.
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

  /**
   * Validate an add's name uniqueness and `--after` dependency graph, without
   * any side effects. Throws a user-facing error on: a duplicate name, `--after`
   * without `--name`, an unknown dependency, or a cycle. Returns the cleaned
   * (whitespace-filtered) `after` list.
   *
   * Extracted from spawn() so the command layer can run it BEFORE creating a
   * worktree — a rejected add must not leave an orphan `agents/<name>` branch
   * that then breaks the retry with `fatal: a branch ... already exists`
   * (RUSH-2356). spawn() calls it too, so validation lives in exactly one place.
   *
   * The result is cached for exactly ONE subsequent call with the same
   * arguments, which spawn() then consumes. `listByTask()` → `listAll()`
   * refreshes every sibling's status, and on a `--device` team that is a full
   * round of SSH liveness probes — running it twice per `teams add` would
   * double that cost for no gain, since the second pass reads the same snapshot
   * and cannot catch anything the first missed. The cache is single-use so any
   * later spawn (a `teams start --watch` supervisor launching staged teammates)
   * still validates against fresh state and still rejects a duplicate name.
   */
  async validateAddPreconditions(
    taskName: string,
    name: string | null,
    after: string[],
  ): Promise<string[]> {
    await this.initialize();
    const key = JSON.stringify([taskName, name, after]);
    if (this.validatedAdd?.key === key) {
      const cached = this.validatedAdd.cleanAfter;
      this.validatedAdd = null; // single use
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
      // Every --after entry must resolve to an existing teammate name.
      const siblingNames = new Set(siblings.map((a) => a.name).filter(Boolean) as string[]);
      const missing = cleanAfter.filter((dep) => !siblingNames.has(dep));
      if (missing.length > 0) {
        throw new Error(
          `Team '${taskName}' has no teammate named ${missing.map((m) => `'${m}'`).join(', ')} yet.\n` +
            `  Add them first, then add this one.`,
        );
      }
      // Cycle check: walk the transitive deps of each --after entry; if the
      // new teammate's own name shows up, we'd create a cycle.
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

  /**
   * Does any LIVE teammate — in any team — already own `worktreeName`?
   *
   * A RAW disk scan: no status probing, no cache, no `listAll()`. The caller is
   * the `teams add` failure path, where the manager's own status refresh can be
   * the very thing that threw (`cleanupOldAgents()` → `listAll()` →
   * `updateStatusFromProcess()` runs AFTER the staged record is saved), so a
   * check that re-entered that machinery would throw again and answer nothing.
   *
   * `teams add` asks this before removing a worktree, to tell an ORPHAN from
   * someone's live checkout (RUSH-2356). Two deliberate scoping choices:
   *
   * - **Any team, not just the one being added to.** Worktree names are global
   *   to the repo but records are per-team, so a same-named worktree owned by
   *   another team's teammate must also block the removal.
   * - **Non-terminal records only.** A completed/failed/stopped teammate's
   *   worktree was already cleaned up at `teams stop`, and its record lingers
   *   until retention reaps it — counting those would leave a genuine orphan
   *   branch stranded forever, which is the bug this all exists to fix.
   * - **Fails CLOSED.** This guards a `git worktree remove --force`, so the two
   *   errors are not symmetric: a false "claimed" strands an orphan branch that
   *   a human can delete, while a false "unclaimed" deletes a live agent's
   *   checkout and its uncommitted work. Only `ENOENT` proves absence — no
   *   agents dir means no records, and a record with no `meta.json` is not a
   *   record. Any other failure (EACCES, EIO, half-written or invalid JSON,
   *   a race with a writer) means we could not READ the records, which is not
   *   the same as there being none, so it answers `true`. This is deliberate
   *   asymmetry, not defensive coding: the caller acts destructively on `false`.
   */
  async isWorktreeClaimed(worktreeName: string): Promise<boolean> {
    const base = this.agentsDir ?? (await getAgentsDir());
    let entries: string[];
    try {
      entries = await fs.readdir(base);
    } catch (err) {
      // ENOENT is the only error that PROVES nothing claims the worktree: there
      // are no records at all. Every other failure (EACCES, EIO, a transient
      // races with a writer) means we could not read the records, which is not
      // the same as there being none — fail closed.
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
        // A record without a meta.json is not a record — skip it. Anything else
        // (unreadable, half-written, invalid JSON) may be the very record that
        // claims this worktree, and we cannot tell. Fail closed.
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

    // Lineage (RUSH-2019): when the caller didn't name a parent, inherit the
    // orchestrator's own session id from its env (exec.ts stamps AGENTS_SESSION_ID
    // onto every agent process). A team spawned from inside a running agent then
    // records which session created it, so the spawn chain traces back to a parent
    // session; a team started outside any agent simply carries none.
    if (!parentSessionId) {
      parentSessionId = process.env.AGENTS_SESSION_ID ?? null;
    }

    // Validate name uniqueness + --after deps. Throws on any violation. The
    // command layer calls this BEFORE creating a worktree so a rejected add
    // never leaves an orphan `agents/<name>` branch behind (RUSH-2356).
    const cleanAfter = await this.validateAddPreconditions(taskName, name, after);

    // Resolve and validate cwd
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

    // Cloud-backed teammates run on remote infrastructure; we don't need the
    // local CLI for them (the pod has its own). The caller has already
    // dispatched via the cloud provider and passed us the provider + session.
    const isCloudBacked = Boolean(cloudProvider);
    // Distributed teammates run on another machine over SSH — the agent CLI must
    // be present on the HOST (checked via ensureHostReady in the command), not
    // locally. So skip the local availability check for both remote backends.
    const isRemoteBacked = Boolean(hostName);
    if (!isCloudBacked && !isRemoteBacked) {
      // Profile-backed teammates still spawn through `agents run`, which
      // resolves the profile to its host harness — so the CLI we need to be
      // present is the underlying agentType, not the profile name.
      const [available, pathOrError] = checkCliAvailable(agentType);
      if (!available) {
        throw new Error(pathOrError || 'CLI tool not available');
      }
    }

    // Use a full UUIDv4 as the canonical agent_id. For Claude, we pass it via
    // --session-id so it's also Claude's session id (unified identity).
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

    // Distributed-team placement: set post-construction (like startTime), so the
    // giant constructor stays fixed. launchRemoteProcess() reads these to dispatch
    // over SSH and fills in the runtime handles (remotePid/remoteLog/remoteExit).
    agent.hostName = hostName;
    agent.hostTarget = hostTarget;
    agent.repoPath = repoPath;
    // Must be set BEFORE the launch below — this method launches inline for a
    // teammate with no unmet --after deps, so assigning it after spawn()
    // returns would miss the only launch that matters.
    agent.project = project;

    const agentDir = await agent.getAgentDir();
    try {
      await fs.mkdir(agentDir, { recursive: true });
    } catch (err: any) {
      throw new Error(`Failed to create agent directory: ${err.message}`);
    }
    this.agents.set(agentId, agent);

    // Seed the teammate's session label with its friendly team name, so the run
    // shows up as `<name>` in `agents sessions` and resolves by it — consistent
    // with `agents run --name`. For Claude the agent id IS the session id (passed
    // via --session-id in buildCommand); other agents don't expose a launch-time
    // id, so they're seeded once discovery captures one. Best-effort.
    if (agentType === 'claude' && name && !isCloudBacked) {
      recordRunName({ sessionId: agentId, name, agent: agentType, cwd: resolvedCwd ?? undefined });
    }

    if (isStaged) {
      await agent.saveMeta();
      debug(`Staged ${agentType} teammate '${name}' in team '${taskName}' (after: ${cleanAfter.join(', ')})`);
    } else if (isCloudBacked) {
      if (cloudSessionId) {
        // Compatibility path for API callers that already dispatched remotely.
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
      // Distributed teammate that can run now (no unmet --after deps): dispatch
      // it onto its host over SSH instead of a local spawn.
      await this.launchRemoteProcess(agent);
    } else {
      // Unpinned + launching now: consult the pool scheduler before defaulting to
      // local, so an unpinned teammate on a --devices team auto-schedules even when
      // added without --after (it wouldn't pass through startReady otherwise).
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

    // Postcondition: the teammate MUST be durably on disk before we report
    // success. saveMeta() ran above and cleanupOldAgents() can no longer reap a
    // non-terminal record, but a failed write (full disk, permissions) or any
    // future retention regression would otherwise let `teams add` print a full
    // success block for a teammate that does not exist — the RUSH-2356
    // silent-success class. Assert the outcome, not the exit code.
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

  /**
   * Resume a STOPPED teammate (completed / failed / stopped) by re-entering its
   * own session with `message` as the next user turn. Re-launches through the
   * SAME backend the teammate first used (local process or remote host), reusing
   * its stored cwd / worktree / host / version / model / effort, and flips it
   * back to RUNNING so the team tracks it live again.
   *
   * The resume target is the teammate's underlying agent session id: for Claude
   * that IS its agent_id (unified identity, pinned via --session-id at first
   * launch); other harnesses only expose their session/thread id after their
   * first stream event, captured as `remoteSessionId`.
   *
   * Callers branch on status first — a RUNNING teammate is steered via its
   * mailbox, never re-launched — so this method assumes a non-running teammate.
   */
  async resumeTeammate(agentId: string, message: string): Promise<AgentProcess> {
    await this.initialize();
    const agent = await this.get(agentId);
    if (!agent) throw new Error(`No teammate with id ${agentId}`);

    const who = agent.name ?? agent.agentId.slice(0, 8);

    // The message rides as `agents run`'s prompt positional. A leading '-' makes
    // commander parse it as an (unknown) flag, exiting the child non-zero — the
    // teammate would silently land FAILED. `--` can't rescue it: `agents run`
    // treats post-`--` tokens as native passthrough and unsets the prompt. Fail
    // loud and early instead. (Steer/mailbox delivery has no such limit.)
    if (message.startsWith('-')) {
      throw new Error(
        `Resume message can't start with '-' — \`agents run\` would parse it as a flag. ` +
        `Rephrase so it leads with a word (e.g. "Please ${message}").`,
      );
    }

    // Cloud-backed teammates run on remote provider infrastructure with no local
    // or host process to re-launch; continuing them goes through the provider.
    if (agent.cloudProvider) {
      throw new Error(
        `Teammate '${who}' is a ${agent.cloudProvider} cloud task — resume it with ` +
        `\`agents message ${agent.cloudSessionId ?? agent.agentId} "<message>"\` instead.`,
      );
    }

    // For non-Claude teammates the agent_id is NOT the harness session id — that
    // is only known once the agent emitted its first stream event. If it never
    // did (e.g. it failed before its first turn), there is no resumable handle.
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
    // Flip to RUNNING up front so a concurrent status poll can't reap the
    // teammate between the exit-sentinel clear and the new PID landing; the
    // launch re-persists with the fresh pid/startTime. If relaunch fails before
    // that happens, restore the stopped lifecycle state and keep its existing
    // metadata/log directory intact so the user can retry.
    agent.status = AgentStatus.RUNNING;
    // Failure evidence describes the CURRENT attempt. Once a resume has
    // successfully launched, retaining the prior terminal attempt's failure on
    // a RUNNING (and eventually COMPLETED) teammate is false state. Clear it
    // before either launcher persists RUNNING; priorRuntime restores it if the
    // replacement launch fails, so a failed resume never erases the evidence
    // needed to diagnose and retry the original attempt.
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

  /**
   * Actually spawn the OS process for a teammate. Extracted from spawn() so
   * staged teammates can be launched later by startReady().
   */
  private async launchProcess(agent: AgentProcess, resume?: { id: string; message: string }): Promise<void> {
    const running = await this.listRunning();
    warnIfMemoryLow(running.length);

    const effort = agent.effort ?? 'medium';
    // null model means "let the CLI pick its own default" (no --model flag
    // forwarded). Effort is a separate knob wired into buildReasoningFlags
    // inside buildCommand.
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
      // Always TRUNCATE — including on resume. The status reader re-reads the
      // whole log from byte 0 every poll (lastReadPos is in-memory, not
      // persisted) and marks terminal status from the last `result` event it
      // sees, with no liveness guard. If the resumed turn's stream were appended
      // after the prior turn's `result:success`, that stale event would win for
      // the entire duration of the new (still-running) turn — reporting the
      // teammate COMPLETED while it works, and steering a second follow-up into
      // a forked session. Truncating keeps exactly one turn in the log, so the
      // re-read is always correct. The authoritative transcript lives in the
      // agent's own session (resumed via --resume), not this stdout mirror.
      stdoutFile = await fs.open(stdoutPath, 'w');
      const stdoutFd = stdoutFile.fd;

      // Wrap the teammate command in a shell that records the underlying CLI's
      // exit code to a sentinel file. Detached + unref()'d children can't be
      // wait()ed on by this parent, so the sentinel is the only durable record
      // of the real exit status — reapProcess() reads it to decide
      // completed-vs-failed for agents whose stream emits no parsed terminal
      // event (kimi, antigravity, droid). Remove any stale sentinel from a
      // prior run of the same agent id first so a restart can't read it.
      const exitCodePath = await agent.getExitCodePath();
      await fs.rm(exitCodePath, { force: true }).catch(() => {});
      const wrappedCmd = buildSentinelCommand(cmd, exitCodePath);

      // detached:true makes the shell the process-group leader, so stop()'s
      // `kill(-pid)` still reaches the underlying CLI through the group.
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
      // Capture start-time NOW, while we know the PID is ours. Once the
      // OS reuses this PID slot, /proc and `ps` will report a different
      // value — that's the signal stop() uses to refuse to signal an
      // unrelated process.
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

  /**
   * Dispatch a distributed teammate onto its host over SSH — the remote-host
   * analog of launchProcess(). Symmetric to the cloud path: no local process; the
   * lifecycle lives on the host and is polled (isProcessAlive/readNewEvents over
   * SSH via the remote `.exit` sentinel + offset-tailed log).
   *
   * When the team uses worktrees (agent.worktreeName set), a git worktree is first
   * created ON THE HOST off the freshly-fetched default branch; the teammate runs
   * there. Otherwise it runs in the host repo path directly.
   */
  private async launchRemoteProcess(agent: AgentProcess, resume?: { id: string; message: string }): Promise<void> {
    if (!agent.hostName || !agent.hostTarget || !agent.repoPath) {
      throw new Error(`Remote teammate ${agent.agentId} is missing host placement (host/target/repo).`);
    }

    // Re-resolve the device → Host at launch time (it may have moved / changed
    // address since `add` staged the teammate), matching how the command resolved
    // it. The target string on the agent stays the launch-time source of truth for
    // subsequent polling.
    const host = await resolveHost(agent.hostName);
    if (!host) {
      throw new Error(`Cannot launch remote teammate ${agent.agentId}: device "${agent.hostName}" no longer resolves.`);
    }
    agent.hostIdentityFile = host.identityFile ?? null;

    // Ensure agents-cli is present + the pin is installed on the host. A bare
    // agent name still warns (like dispatch.ts); a concrete agent.version pin
    // fails loud so the teammate never reports launched against a missing pin
    // (RUSH-2313).
    try {
      const { warnings } = ensureHostReady(host, {
        agent: agent.agentType,
        version: agent.version ?? undefined,
      });
      for (const w of warnings) process.stderr.write(`[teams] warning: ${w}\n`);
    } catch (err) {
      throw new Error(`Host "${agent.hostName}" not ready for teammate ${agent.agentId}: ${(err as Error).message}`);
    }

    // Worktree isolation on the host, if the team enables it. createRemoteWorktree
    // fetches origin and branches off origin/<default>, returning the host path.
    // On RESUME the worktree already exists from the original launch — reuse it
    // (its path is persisted) instead of re-creating (which would fail on the
    // existing branch and would also discard the teammate's in-progress work).
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

    // Same run argv the local path builds (shared buildRunArgv keeps the prompt
    // scaffolding + flags from drifting); dispatched non-blocking (follow:false)
    // — the supervisor polls the host, we don't block here.
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
    // Project grants for a remote teammate, resolved HERE rather than at add
    // time: an unpinned teammate only learns its host from the scheduler, which
    // runs at launch. `forRemote: true` keeps them `~/…` and skips this box's
    // existence check — the host has its own checkouts. The remote `agents run`
    // expands `~` against the host's HOME before handing it to the harness.
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
      // On resume the offset resets to 0 against a FRESH remote log, and
      // syncRemoteMirror appends the delta onto the local mirror. Truncate that
      // mirror first so the prior turn's terminal event can't linger and get
      // re-read as the current status (same hazard the local path truncates for).
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

  /**
   * Resolve a scheduler-picked device to host placement fields on an unpinned
   * teammate at LAUNCH time (the same resolution `teams add --device` runs, minus
   * the fatal `die()` — a scheduling failure here is per-teammate, not per-add).
   * Sets hostName/hostTarget/repoPath + persists, so the subsequent
   * launchRemoteProcess dispatches over SSH. Mirrors the `add`-time pin path:
   * resolve device → reject Windows (POSIX-only) → ssh target → ensure the repo
   * is present on the host from the team's --repo (ensureRemoteRepo).
   */
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

  /**
   * Place an UNPINNED, non-cloud teammate onto the team pool via the cascade
   * (least-loaded). A poolless team consumes the active worker allowlist and
   * fails loud when none exists; it never silently lands on the orchestrator.
   * A no-op only for a pinned teammate (hostName already set from `--device`) or
   * a cloud teammate. Shared by spawn()
   * (immediate add-launch) and startReady() (staged launch) so an unpinned pool
   * teammate schedules identically no matter how it was fired.
   */
  private async maybeSchedulePlacement(
    agent: AgentProcess,
    taskName: string,
    opts: { probe?: boolean } = {},
  ): Promise<void> {
    if (agent.hostName || agent.cloudProvider) return;
    const teamMeta = await getTeam(taskName);
    if (!teamMeta) return;
    const roster = await this.listByTask(taskName);
    // A poolless team is still an automatic placement request: use the same
    // explicit worker allowlist as `--device auto`. Never silently run it on a
    // personal/desktop orchestrator merely because `devices` was omitted.
    const pool = teamMeta.devices?.length
      ? teamMeta.devices
      : filterAutoPool(listWorkerDevices());
    const maxConcurrent = pool.length > 1 ? readMaxConcurrentCaps(pool) : undefined;
    // On the start path (opts.probe), gather live signals so the pick is health-,
    // harness-, and load-aware (RUSH-2002); the add path stays the cap-only
    // roster count so `teams add` never blocks on an SSH fan-out. Cached per
    // (pool, agent), so a wave placing many teammates probes the pool once.
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

  /** Human label of a teammate's agent for the placement fail-loud message. */
  private placementAgentLabel(agent: AgentProcess): string {
    return agent.version ? `${agent.agentType}@${agent.version}` : String(agent.agentType);
  }

  /**
   * One-ssh-per-host batched liveness/exit pre-pass for a team's remote teammates.
   * The supervisor calls this each wave BEFORE listByTask() so the per-teammate
   * isProcessAlive()/readNewEvents() consume a cached snapshot instead of each
   * issuing its own SSH handshake — avoiding N round-trips per wave at 10+ remote
   * teammates. Groups by hostTarget and, for each host, checks every teammate's
   * `.exit` + `kill -0` in a single ssh call over the shared ControlMaster socket.
   */
  async prefetchRemoteStatus(taskName: string): Promise<void> {
    await this.initialize();
    // Read the in-memory roster directly — going through listByTask()/listAll()
    // would poll each teammate first (an SSH round-trip apiece), defeating the
    // batch. The caller (supervisor) has already rescanned from disk this wave.
    const remotes = Array.from(this.agents.values()).filter(
      (a) => a.taskName === taskName && a.hostName,
    );
    // Fresh snapshots each wave: clear stale ones first so a teammate that has
    // since finished (dropped from the RUNNING filter below) can't carry an old
    // ALIVE reading into this wave's poll.
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
      // Emit one line per teammate: "<agentId> <ALIVE|EXITED|GONE> <codeOrEmpty>".
      // A single round-trip over the multiplexed socket, regardless of teammate
      // count. GONE (process gone, no `.exit`) is kept distinct from EXITED so a
      // teammate killed without recording `$?` resolves terminal instead of
      // reporting RUNNING forever (RUSH-2366).
      const parts = agents.map((a) => remoteLivenessSnippet(a.agentId, a.remoteExit!, a.remotePid!));
      const identityFile = agents[0]?.hostIdentityFile;
      const res = sshExec(target, parts.join('; '), {
        timeoutMs: 12000,
        multiplex: true,
        extraSshArgs: identityFile ? ['-i', identityFile, '-o', 'IdentitiesOnly=yes'] : [],
      });
      if (res.code === null) continue; // transient ssh failure — skip this wave, no snapshot
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

  /**
   * Fire any pending teammates in the given team whose `after` deps have all
   * completed. Returns the list of teammates just launched. Repeatable:
   * call it once per DAG wave. Safe to call on teams with no pending work
   * (returns empty list).
   */
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

      // Auto-scheduling: an UNPINNED teammate (no explicit --device at add time)
      // gets placed now via the pool cascade — same helper spawn() uses so the
      // immediate-add and staged paths agree. A null pick keeps hostName null →
      // local spawn, unchanged. Cloud teammates never schedule.
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
          // Distributed teammate: dispatch onto its host over SSH.
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

  /**
   * Build the argv to spawn for a teammate. Delegates to `agents run` so the
   * agent's CLI flags, version routing, mode handling (plan/edit/full), model
   * injection, and reasoning-intensity flags are owned by a single canonical
   * exec path (src/lib/exec.ts). The team runner just supplies prompt + mode
   * and reads stream-json events off stdout.
   */
  /**
   * Build the `agents run …` argv AFTER the `agents` binary — the flags + prompt
   * scaffolding shared by the LOCAL launch (buildCommand, which prefixes
   * process.execPath + the agents CLI path) and the REMOTE launch
   * (launchRemoteProcess, which prefixes `agents` on the host via dispatch). Kept
   * in one place so the PROMPT_SUFFIX / CLAUDE_PLAN_MODE_PREFIX scaffolding and the
   * flag set can never drift between the two backends.
   *
   * `cwd` is intentionally NOT emitted here: the local path passes it as
   * `--cwd`/`--add-dir` (below), while the remote path `cd`s into the host cwd
   * before invoking `agents`. `sessionId` is likewise local-only (the remote run
   * mints its own session on the host).
   */
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
    // Compose the prompt. On RESUME the message is the teammate's next user turn,
    // not a fresh brief — so skip the original brief and the plan-mode prefix, but
    // keep PROMPT_SUFFIX so the resumed run still emits a final summary the team
    // parser reads. On a fresh launch, add the plan-mode prefix for Claude and the
    // universal summary suffix. These are team-specific prompt scaffolding —
    // `agents run` does not apply them.
    let fullPrompt: string;
    if (resume) {
      fullPrompt = resume.message + PROMPT_SUFFIX;
    } else {
      fullPrompt = prompt + PROMPT_SUFFIX;
      if (agentType === 'claude' && mode === 'plan') {
        fullPrompt = CLAUDE_PLAN_MODE_PREFIX + fullPrompt;
      }
    }
    // PHNX-3236: append the self-merge boundary to every WRITE-capable teammate,
    // fresh or resumed. A plan-mode teammate produces no PR (read-only), so it is
    // skipped to keep its prompt clean; every other mode can open — and could
    // self-merge — a PR, so the policy rides along regardless of harness. The
    // hard block is still merge-guard.sh (inherited hook); see TEAMMATE_PR_POLICY.
    // The cloud dispatch path applies the SAME helper (withTeammatePrPolicy) so
    // local, remote, and cloud teammates never diverge on this boundary.
    fullPrompt = withTeammatePrPolicy(fullPrompt, mode);

    // Profile target takes precedence — `agents run <profile>` resolves the
    // host harness, version pin, and env injection in one place. Plain
    // version pins only apply when no profile is selected.
    const target = profileName ?? (version ? `${agentType}@${version}` : agentType);

    // Keep the prompt as the first positional (right after target), matching the
    // fresh-launch shape, and add `--resume <id>` among the flags. `agents run`
    // continues the teammate's own session natively (claude `--resume`, codex
    // `resume`) or via the universal `/continue` replay for other harnesses.
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
    // Route through getAgentsInvocation so a teammate launched by the compiled
    // standalone binary (#315) doesn't relaunch as `agents /$bunfs/root/agents …`
    // (process.argv[1] is the bun virtual entry there) → "unknown command".
    const inv = getAgentsInvocation(
      this.buildRunArgv(agentType, prompt, mode, model, effort, version, profileName, resume),
    );
    const cmd: string[] = [inv.command, ...inv.args];

    if (cwd) cmd.push('--cwd', cwd);

    // Pin the session UUID to our agent_id so buildExecEnv keys
    // AGENTS_MAILBOX_DIR by the same id mailboxIdForActiveSession returns.
    // Claude also forwards --session-id to its CLI (unified identity);
    // other agents ignore the flag but still get the correct mailbox dir.
    // On RESUME we continue an existing session — `--session-id` CREATES one and
    // `agents run` rejects it alongside `--resume`, so it must be omitted.
    if (sessionId && !resume) {
      cmd.push('--session-id', sessionId);
    }

    // Claude: grant access to the teammate's working directory.
    if (agentType === 'claude' && cwd) {
      cmd.push('--add-dir', cwd);
    }

    // The team's project directories, beyond the one the teammate sits in.
    // `agents run` re-dedupes, but skipping cwd here keeps the launch line
    // readable. Codex folds these into its workspace_roots; other harnesses
    // ignore --add-dir entirely.
    for (const dir of new Set(addDirs)) {
      if (dir !== cwd) cmd.push('--add-dir', dir);
    }

    // Codex's workspace-write sandbox blocks writes outside cwd. Factory
    // teammates need to run further `agents teams add` commands, which
    // write to ~/.agents/. Grant that root so subprocess-issued
    // `agents teams add` calls hit the real store.
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

  /**
   * Resolve a teammate reference to a single agent_id within a team.
   * Accepts (in priority order):
   *   1. exact teammate name                ("alice")
   *   2. exact UUID                         ("b2438499-dc25-4a5e-9e02-9916012580b8")
   *   3. UUID prefix, if unique             ("b2438499")
   *
   * Returns:
   *  - { kind: 'ok', agentId }       when exactly one teammate matches
   *  - { kind: 'none' }              when nothing matches
   *  - { kind: 'ambiguous', matches } when the prefix matches multiple ids
   */
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

  /**
   * Teammates that have reached a terminal status (completed/failed/stopped) —
   * the ONLY records retention may reap. A `pending` teammate has not launched
   * and a `running` one is working, so neither is "completed"; classifying them
   * as such let cleanupOldAgents sweep live `pending` `--after` teammates past
   * the cap (RUSH-2356). Filter on `isTerminalStatus`, never `!== RUNNING`.
   */
  async listCompleted(): Promise<AgentProcess[]> {
    const all = await this.listAll();
    return all.filter(a => isTerminalStatus(a.status));
  }

  async listByTask(taskName: string): Promise<AgentProcess[]> {
    const all = await this.listAll();
    return all.filter(a => a.taskName === taskName);
  }

  /**
   * Terminal removal of every teammate record for a team (RUSH-2450).
   *
   * `teams disband` used to delete log dirs and the registry entry, but left
   * the in-memory AgentProcess cache intact. A concurrent `teams start --watch`
   * supervisor then re-persisted those records via saveMeta, so a second
   * disband still found N logs to clear and `teams start` could re-launch
   * PENDING work that had already merged.
   *
   * This drops every matching record from the manager map AND removes its
   * durable state. With `keepLogs`, only `meta.json` is removed so the
   * teammate is no longer discoverable/startable while stdout/stderr logs
   * remain for postmortem.
   *
   * Returns the agent_ids that were purged.
   */
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
          // Keep log files; remove only the record that makes the teammate
          // reappear in list/status/start.
          await fs.rm(path.join(agentDir, 'meta.json'), { force: true });
        } else {
          await fs.rm(agentDir, { recursive: true, force: true });
        }
        purged.push(agent.agentId);
      } catch (err) {
        debug(`purgeByTask: failed to remove ${agent.agentId}: ${err}`);
        // Still count as purged from the roster — the in-memory drop above is
        // the load-bearing half against same-process resurrection.
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

    // Distributed teammate: no local PID — signal the dedicated process group
    // created by dispatch.ts. The persisted PID is the group leader, so one
    // negative-PID signal reaches the login-shell wrapper and every descendant.
    if (agent.hostName && agent.status === AgentStatus.RUNNING) {
      if (agent.hostTarget && agent.remotePid) {
        try {
          sshExec(agent.hostTarget, `kill -TERM -- -${agent.remotePid} 2>/dev/null`, {
            timeoutMs: 10000,
            multiplex: true,
            extraSshArgs: agent.hostIdentityFile ? ['-i', agent.hostIdentityFile, '-o', 'IdentitiesOnly=yes'] : [],
          });
        } catch {
          // best-effort — record the stop regardless
        }
      }
      agent.status = AgentStatus.STOPPED;
      agent.completedAt = new Date();
      await agent.saveMeta();
      debug(`Stopped remote agent ${agentId} on ${agent.hostName}`);
      return true;
    }

    if (agent.pid && agent.status === AgentStatus.RUNNING) {
      // PID-reuse guard: if the PID we recorded at spawn no longer maps to
      // our process (start-time mismatch), the OS has recycled it. Sending
      // SIGTERM/SIGKILL to -pid here would kill an unrelated process group.
      // Treat as already gone and just record the stop without signaling.
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
    // listCompleted() is terminal-only (isTerminalStatus), so a pending or
    // running teammate is never a reap candidate — retention can only delete a
    // record whose process has finished. (RUSH-2356: the old `!== RUNNING`
    // filter reaped live `pending` `--after` teammates.)
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
