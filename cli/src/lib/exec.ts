import { captureLaunchBinding, recordCompletedLaunch } from './session/hook-sessions.js';
/** Agent execution: command building, process spawning, and rate-limit fallback. Translates
 * ExecOptions into CLI invocations per agent, manages per-agent environment isolation, and chains
 * fallback agents on rate limits. */
import { spawn } from 'child_process';
import { randomUUID } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import type { AgentId, Mode, RunStrategy } from './types.js';
import { ALL_MODES, REMOTE_INTERACTIVE_ENV } from './types.js';
import { AGENTS, agentConfigDirName, findInPath } from './agents.js';
import { parseTimeout } from './scheduling/routines.js';
import { compareVersions, getBinaryPath, getVersionHomePath, isVersionInstalled, listInstalledVersions, resolveVersion } from './installations/versions.js';
import { resolveModel, buildReasoningFlags } from './models.js';
import { isTierToken, resolveTier } from './model-tiers.js';
import { emit, emitStart, createTimer, redactPrompt, redactArgs, type EventPayload } from './feed/events.js';
import { sanitizeProcessEnv } from './secrets-client.js';
import { resolveActor, actorEnv } from './actor.js';
import { launchIdentityEnv, LAUNCH_IDENTITY_KEYS } from './launch-identity.js';
import { expandLocalHome } from './project-root.js';
import { getShimsDir, getHistoryDir, getUserAgentsDir, getRuntimeStateDir } from './state.js';
import { readCodexConfiguredModel } from './installations/shims.js';
import { withInstallationLease } from './installations/launch-gate.js';
import { getCliLaunch, getAgentsBinPath } from './cli-entry.js';
import { installedReleaseFor } from './installations/store.js';
import { writePidSessionEntry, extractSessionIdArg } from './session/pid-registry.js';
import { writeSessionActorRecord, writeSessionAliasRecord } from './session/actor-sidecar.js';
import { loadHookSessionIndex, resolveHookSessionId } from './session/hook-sessions.js';
import { sessionIdMarkerLine } from './hosts/session-marker.js';
import { recordRunName } from './session/run-names.js';
import { mailboxDir, isValidMailboxId } from './mailbox.js';
import { composeWin32CommandLine } from './platform/index.js';
import { isTmuxInstalled } from './tmux/binary.js';
import { isHeadedDeviceRole, isTmuxEnabled, selfConfiguredDeviceRole } from './device-config.js';
import { machineId } from './machine-id.js';
import { shellQuote } from './ssh-exec.js';
import { codexEditWritableRoots, codexPolicyArgs } from './codex-policy.js';
import { probeUnprivilegedUserns, type UsernsStatus } from './linux-userns.js';
import { resolveClaudeSetupToken, seedClaudeWorkerHomeIdentity } from './claude-account-token.js';
import { applyAddDirs } from './add-dir.js';
import { applyActiveRulesPresetAtRun } from './rules/run-sync.js';
import { applySystemResourcesAtRun } from './system-run-sync.js';
import { resolveHarnessAdapter, stripForeignConfigDir } from './harness/index.js';
import { claudeWorkerLoginTrapPreflight } from './harness/adapters/claude.js';
import { resolveConfigVersion } from './harness/exec-config-version.js';
import { getAccountInfo } from './agents.js';
import {
  getUsageLookupKey,
  noteClaudeSessionLimit,
  noteClaudeOutOfCredits,
  clearClaudeAccountRefusal,
  parseClaudeSessionLimitReset,
  noteClaudeModelRefusal,
  clearClaudeModelRefusal,
  parseClaudeModelRefusal,
  claudeModelRefusalKey,
} from './accounting/usage.js';
import { claudeProjectDirName } from './project-key.js';
import { bootMark, flushBootProfile } from './boot-profile.js';

/** Agent execution modes. Canonical name `skip` (dangerously skip permissions); `full` is a
 * permanent silent alias via normalizeMode(). */
export type ExecMode = Mode;

/** Map a raw mode string (CLI flag, YAML field, env var) to the canonical Mode, rewriting the
 * historical `full` to `skip`. Throws on anything outside the four canonical values so bad input
 * fails loud at the boundary. */
export function normalizeMode(input: string | null | undefined): Mode {
  if (!input) {
    throw new Error(`Mode is required. Use one of: ${ALL_MODES.join(', ')}.`);
  }
  const v = input.trim().toLowerCase();
  if (v === 'full') return 'skip';
  if ((ALL_MODES as readonly string[]).includes(v)) return v as Mode;
  throw new Error(`Invalid mode '${input}'. Use one of: ${ALL_MODES.join(', ')} (or 'full' as a deprecated alias for 'skip').`);
}

/** Detect the headless-plan stall: a slash command (e.g. `/code:commit`) run headless under the
 * implicit default `plan` mode hangs forever at ExitPlanMode with no TTY. Returns the command
 * token to block, else null; an explicit `--mode plan` or a plain-language prompt is not blocked. */
export function headlessPlanStallCommand(args: {
  prompt: string | undefined;
  interactive: boolean | undefined;
  mode: string;
  modeIsDefault: boolean;
}): string | null {
  const { prompt, interactive, mode, modeIsDefault } = args;
  if (interactive === true || prompt === undefined) return null;
  if (!modeIsDefault) return null;
  if (normalizeMode(mode) !== 'plan') return null;
  const trimmed = prompt.trimStart();
  if (!trimmed.startsWith('/')) return null;
  return trimmed.split(/\s+/)[0];
}

/** Resolve a requested mode against an agent's capability table. `auto` without support degrades
 * to `edit`; `plan` without a read-only mode degrades to `modes[0]` and callers must warn. `skip`
 * without support throws: no silent fallback when the user asked to bypass permissions. */
export function resolveMode(agent: AgentId, requested: Mode): Mode {
  const supported = AGENTS[agent].capabilities.modes;
  if (supported.includes(requested)) return requested;

  if (requested === 'auto') {
    // Fall back to edit — guaranteed to exist on every agent (every agent has
    // at least 'edit' in its modes table, since that's the default behavior).
    return 'edit';
  }

  if (requested === 'plan') {
    // No read-only mode on this agent. modes[0] is the declared safest mode
    // (edit for antigravity/…). Prefer that over hard-fail so
    // uniform multi-agent `--mode plan` dispatches still run.
    return supported[0];
  }

  throw new Error(
    `${agent} does not support '${requested}' mode. Supported modes: ${supported.join(', ')}.`,
  );
}

/** Resolve a requested mode for a run, honoring headless. An agent may list `plan` yet set
 * `capabilities.headlessPlan === false` (kimi refuses `--prompt` + `--plan`; grok stalls), so a
 * headless plan degrades to `auto` with a stderr warning; interactive is never downgraded. */
export function resolveHeadlessMode(
  agent: AgentId,
  requested: Mode,
  interactive: boolean,
  warningContext?: string,
  warningState?: ModeWarningState,
): Mode {
  const mode = resolveMode(agent, requested);
  const warn = (message: string): void => {
    if (warningState?.quiet) return;
    if (warningState) {
      warningState.emitted ??= new Set();
      if (warningState.emitted.has(agent)) return;
      warningState.emitted.add(agent);
    }
    process.stderr.write(message);
  };
  if (mode !== requested) {
    const subject = warningContext ? `${warningContext}: ` : '';
    if (requested === 'plan') {
      warn(
        `[agents] ${subject}${agent} has no read-only 'plan' mode; ` +
        `running '${mode}' (writable) instead. Pass --mode ${mode} to silence this.\n`,
      );
    } else {
      warn(`[agents] ${subject}${agent} has no '${requested}' mode; using '${mode}'.\n`);
    }
  }
  if (!interactive && mode === 'plan' && AGENTS[agent].capabilities.headlessPlan === false) {
    warn(`warning: ${agent} has no headless plan mode; running --mode auto instead\n`);
    return resolveMode(agent, 'auto');
  }
  return mode;
}

export interface ModeWarningState {
  /** Agents already warned about, so one run warns once per agent. A fallback
   *  chain degrades each agent independently and the agent that actually ran is
   *  usually not the first, so this cannot be a single boolean. */
  emitted?: Set<AgentId>;
  quiet?: boolean;
}

/** The mode an agent runs in when the caller has no preference: the first entry of
 * `capabilities.modes`, whose declaration order is the source of truth for "the safest mode this
 * agent supports" (`plan` first; antigravity lists `edit`). */
export function defaultModeFor(agent: AgentId): Mode {
  return AGENTS[agent].capabilities.modes[0];
}

/** Safe mode used when the user did not provide --mode or a configured default. */
export function implicitModeFor(agent: AgentId): ExecMode {
  return agent === 'codex' ? 'edit' : 'plan';
}

/** Preflight for Codex's Linux sandbox (PHNX-3285): bubblewrap needs an unprivileged user ns;
 * where restricted (Ubuntu 24.04) a headless codex run lands zero tools yet reports success. Fail
 * loud instead. Only codex, Linux, headless, sandboxed modes (`skip` unaffected); never downgrade. */
export function codexSandboxPreflight(args: {
  agent: AgentId;
  platform: NodeJS.Platform;
  interactive: boolean;
  mode: Mode;
  userns: UsernsStatus;
  machine: string;
}): string | null {
  if (args.agent !== 'codex') return null;
  if (args.platform !== 'linux') return null;
  if (args.interactive) return null;
  if (args.mode === 'skip') return null;
  if (args.userns.state !== 'blocked') return null;

  const reason = args.userns.reason ?? 'unprivileged user namespaces are restricted';
  return (
    `codex's Linux sandbox can't start on ${args.machine}: ${reason}, so codex's ` +
    `bundled bubblewrap fails with "bwrap: setting up uid map: Permission denied" ` +
    `and a headless run lands zero tools. (PHNX-3285)\n` +
    `\n` +
    `Enable it once on this box — keeps codex's workspace-write sandbox intact:\n` +
    `  echo 'kernel.apparmor_restrict_unprivileged_userns=0' | sudo tee /etc/sysctl.d/60-codex-userns.conf\n` +
    `  sudo sysctl --system\n` +
    `  # verify: unshare --user --map-root-user true   (exit 0 = fixed)\n` +
    `(agents-cli ships cli/scripts/enable-codex-sandbox.sh to apply + verify this.)\n` +
    `\n` +
    `Or run codex WITHOUT a filesystem sandbox instead: add --mode skip.`
  );
}

/** Reasoning effort levels passed to agents that support them. 'auto' defers to the agent's default. */
export type ExecEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'auto';

/** Options for spawning an agent process. Omitting `prompt` launches the CLI interactively. */
export interface ExecOptions {
  agent: AgentId;
  /** Custom harness/profile name when launched via `agents run <profile>` (e.g. `deepseek`);
   * `agent` stays the host CLI that executes. Stamped onto `AGENTS_AGENT_NAME`, the pid registry,
   * and the session-actor sidecar so listings tell the profile from a native run (PHNX-2935). */
  harnessName?: string;
  version?: string;
  /** Version home whose native auth/config is overlaid onto this run's binary. */
  configVersion?: string;
  /** HOME-shaped slot dir whose native auth/config is overlaid onto this run's binary (PHNX-3940
   * T5). Wins over {@link configVersion}; the binary still comes from {@link version} (the managed
   * install unless `@<label>` pins one). */
  execHome?: string;
  /** Omit to launch the CLI interactively -- no prompt, no --print, stdio fully inherited. */
  prompt?: string;
  /** Force interactive mode even when a prompt is provided. Wins over `headless`. */
  interactive?: boolean;
  mode: ExecMode;
  /** True when the caller omitted --mode; fallback agents resolve their own safe default. */
  modeWasImplicit?: boolean;
  effort: ExecEffort;
  cwd?: string;
  /** Force headless mode even when no prompt is provided (e.g. piping via stdin). */
  headless?: boolean;
  /** Prefix for mode-degradation warnings emitted by shared headless paths. */
  modeWarningContext?: string;
  /** Shared across command previews/spawns/loop iterations so degradation warns once. */
  modeWarningState?: ModeWarningState;
  json?: boolean;
  model?: string;
  addDirs?: string[];
  timeout?: string;
  sessionId?: string;
  /** Durable `agents run --name <slug>` handle, exported as `AGENT_SESSION_NAME` and, when a
   * session id is known at launch, recorded in the run-name index so `agents sessions <name>`
   * resolves the run. Absent for unnamed runs. */
  name?: string;
  /** Resume the conversation named by `sessionId` with the agent's native resume form (claude
   * `--resume`, codex `resume`) instead of `--session-id` create. Set only where `nativeResume` is
   * true; other agents resume via a `/continue <id>` first message (Tier 2) and leave this unset. */
  resume?: boolean;
  verbose?: boolean;
  env?: Record<string, string>;
  /** Workflow capability scoping (Claude only), from WORKFLOW.md frontmatter `tools:` /
   * `mcpServers:`, translated to headless flags in buildExecCommand. */
  toolsRestrict?: string[];
  /** Path to an ephemeral mcp-config JSON, emitted as `--mcp-config <path>` with
   * `--strict-mcp-config` so only the named servers load (the flag alone only adds to the existing
   * set). */
  mcpConfigPath?: string;
  /** Raw args captured after `--` on the command line, forwarded verbatim to the underlying agent CLI. */
  passthroughArgs?: string[];
  /** Tee-and-tail the child's stdout even with no budget cap, so the caller can scan for
   * rate/usage-limit messages. Claude prints billing refusals to stdout, so a fallback chain
   * inspecting only stderr never cascades. */
  captureStdoutTail?: boolean;
  /** Print the run's resolved session id as a one-line sentinel on exit. Set by `--device` dispatch
   * so the launcher can relate the remote session to itself: Claude's id is forced up front but
   * other agents coin theirs remotely, and this marker carries it home on the followed log. */
  emitSessionId?: boolean;
  /** Escape hatch for the interactive tmux spawn-wrap (see shouldWrapInTmux): when true, spawn the
   * agent directly instead of in a shared-socket tmux session. Also forced by AGENTS_NO_TMUX=1; no
   * effect on headless runs. */
  raw?: boolean;
  /** The run strategy that resolved this launch (pinned/available/balanced). Observability-only:
   * threaded from `agents run` so `run.launch` records how the version was chosen; never read by
   * the spawn. */
  strategy?: RunStrategy;
  /** How the launched version was resolved (e.g. 'pinned-default', 'rotated', 'explicit-pin'), when
   * cheaply determinable. Observability-only, carried on `run.launch`; omitted when
   * unattributable. */
  resolvedVia?: string;
  /** Precomputed launchable-signed-in verdict from a caller that already ran the identical check (a
   * rotated pick carries `rotationResult.picked.signedIn`). `run.launch` uses it instead of
   * re-probing the home, avoiding a double fs read and any disagreement. */
  launchSignedIn?: boolean | null;
  /** Precomputed account email companion to {@link launchSignedIn}. */
  launchEmail?: string | null;
  /** Stable native-account registry id this run authenticates as, independent of `version`, which
   * for a slot launch is the binary (PHNX-3940 T5). Exported as `AGENTS_RUN_ACCOUNT_ID` so
   * model-refusal lookups resolve the exact account. */
  accountId?: string;
}

/** Identity a custom-harness run stamps on env / pid-registry / sidecars: `agent` is the host CLI,
 * `harnessName` the profile the user launched. Blank harness names fall back to the host so a
 * blank stamp never hides a real agent. */
export function stampedAgentName(options: Pick<ExecOptions, 'agent' | 'harnessName'>): string {
  const harness = options.harnessName?.trim();
  return harness || options.agent;
}

/** Profile name when it differs from the host agent; undefined for a native run, keeping
 * pid-registry/sidecar records sparse. */
export function customHarnessName(options: Pick<ExecOptions, 'agent' | 'harnessName'>): string | undefined {
  const harness = options.harnessName?.trim();
  if (!harness || harness === options.agent) return undefined;
  return harness;
}

/** Resolve interactive vs headless. Explicit flags win over inference (`--interactive` over
 * `--headless`; the CLI layer rejects both); with neither, prompt presence decides (prompt
 * headless, none interactive). */
export function resolveInteractive(
  options: Pick<ExecOptions, 'interactive' | 'headless' | 'prompt'>,
): boolean {
  if (options.interactive === true) return true;
  if (options.headless === true) return false;
  return options.prompt === undefined;
}

/** True when a run resolved to inferred interactive intent (no prompt, no explicit `--interactive`)
 * but there is no terminal for the REPL: launching would hang a TUI on dead stdin, so the caller
 * fails fast with headless alternatives (RUSH-1829). An explicit `--interactive` is never blocked. */
export function inferredInteractiveWithoutTty(
  options: Pick<ExecOptions, 'interactive' | 'headless' | 'prompt'>,
  isTty: boolean,
): boolean {
  if (options.interactive === true) return false;
  return resolveInteractive(options) && !isTty;
}

/** Decide whether spawnAgent must capture (PIPE + tee) the child's stdout for the live budget
 * watcher (issue #346). It was piped only when output was piped, so a headless run at a terminal
 * skipped the hard-cap kill. Now every non-interactive capped run is tapped; REPLs never are. */
export function shouldTapStdout(interactive: boolean, piped: boolean, capsActive: boolean, captureTail = false): boolean {
  if (interactive) return false;
  // Always pipe when the caller pipes us downstream (preserve composability),
  // when caps are active so the watcher can read the stream at a TTY, or when
  // a fallback chain needs a stdout tail for rate-limit detection.
  return piped || capsActive || captureTail;
}

/** Pattern for valid environment variable names (C identifier rules). */
const EXEC_ENV_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Parse a single KEY=VALUE string into a tuple, validating the key name. */
function parseExecEnvEntry(entry: string): [string, string] {
  const separatorIndex = entry.indexOf('=');
  if (separatorIndex <= 0) {
    throw new Error(`Invalid --env value "${entry}". Use KEY=VALUE.`);
  }

  const key = entry.slice(0, separatorIndex).trim();
  const value = entry.slice(separatorIndex + 1);

  if (!EXEC_ENV_KEY_PATTERN.test(key)) {
    throw new Error(`Invalid environment variable name "${key}".`);
  }

  return [key, value];
}

/** Parse an array of KEY=VALUE strings into an env record. Returns undefined for empty input. */
export function parseExecEnv(entries: string[]): Record<string, string> | undefined {
  if (entries.length === 0) {
    return undefined;
  }

  return Object.fromEntries(entries.map(parseExecEnvEntry));
}

/** Resolve `AGENT_LAUNCH_ID`, the key the SessionStart hook records with the real session id, so a
 * launch maps to its session under another pid or across SSH. Adopt a valid caller-supplied value
 * (`--device` forwards one), else mint; a malformed one is ignored, never an empty key. */
export function resolveLaunchId(envLaunchId: string | undefined): string {
  const inbound = envLaunchId?.trim();
  return inbound ? inbound : randomUUID();
}

/** Build the process environment for an agent invocation: pin CLAUDE_CONFIG_DIR for Claude,
 * CODEX_HOME for Codex, COPILOT_HOME for Copilot, and strip other agents' env vars so they do not
 * leak. */
export function buildExecEnv(options: ExecOptions): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = { ...sanitizeProcessEnv(process.env) };

  // Config-dir env vars are agent-specific; spreading an inherited one into a different agent's
  // env would leak a pointer the target CLI does not understand.
  const configAdapter = resolveHarnessAdapter(options.agent);
  if (configAdapter.applyExecConfigEnv) {
    // Resolve version/versionHome here (this module already imports installations/versions);
    // adapters must not, or they close a versions -> shims -> harness -> adapter import cycle.
    // execHome is the account slot (PHNX-3940 T5) and wins over a legacy configVersion label.
    const { version, versionHome } = resolveExecConfigHome(options);
    configAdapter.applyExecConfigEnv(result, {
      agent: options.agent,
      version,
      versionHome,
      interactive: resolveInteractive(options),
      deviceRole: selfConfiguredDeviceRole(),
      resolveClaudeSetupToken,
    });
  } else {
    stripForeignConfigDir(result);
  }

  // A new harness must not inherit its spawner's own session/mailbox or editor
  // ownership. Keep those relationships as lineage, including across SSH.
  delete result.AGENT_SESSION_ID;
  delete result.AGENTS_SESSION_ID;
  delete result.AGENTS_MAILBOX_DIR;
  delete result.AGENT_TERMINAL_ID;
  const launchIdentity = launchIdentityEnv();
  Object.assign(result, launchIdentity);

  // Point the agent at its own mailbox so the PreToolUse `mailbox-inject` hook knows which box to
  // drain mid-run, keyed by session id (as `mailboxIdForActiveSession()` resolves). A loop run
  // overrides it to its run-level box via options.env so all iterations share one inbox.
  if (options.sessionId && isValidMailboxId(options.sessionId)) {
    result.AGENTS_MAILBOX_DIR = mailboxDir(options.sessionId);
    // Full session id for agent-callable tools (`agents feed post`, etc.).
    result.AGENT_SESSION_ID = options.sessionId;
    result.AGENTS_SESSION_ID = options.sessionId;
  }
  // Lineage edge: the child's parent is this process's session (the spawner), so a sub-agent's
  // events carry a walkable edge back; events.ts stamps AGENTS_PARENT_SESSION_ID on every event.
  delete result.AGENTS_PARENT_SESSION_ID;
  const spawnerSessionId = launchIdentity.AGENTS_PARENT_SESSION_ID;
  if (spawnerSessionId && spawnerSessionId !== options.sessionId) {
    result.AGENTS_PARENT_SESSION_ID = spawnerSessionId;
  }
  result.AGENTS_RUNTIME = resolveInteractive(options) ? 'terminal' : 'headless';
  // The agent's own `secrets` calls must hit the store agents-cli reads: the process client points
  // the standalone at the user agents dir (buildServeEnv, MIG-1), while bare `secrets` uses
  // ~/.secrets; unset, unlocks were split across two brokers. An explicit SECRETS_HOME wins.
  result.SECRETS_HOME = result.SECRETS_HOME ?? getUserAgentsDir();
  // Durable SessionStart metadata: the hook joins these launch facts to the harness's real session
  // id under the shared history dir, so a later resume can restore the permission boundary without
  // re-parsing harness transcripts.
  result.AGENTS_RUN_MODE = resolveHeadlessMode(
    options.agent,
    normalizeMode(options.mode),
    resolveInteractive(options),
    options.modeWarningContext,
    options.modeWarningState,
  );
  result.AGENTS_HISTORY_DIR = getHistoryDir();
  // Durable origin version for a later native resume, joined by the SessionStart hook to the real
  // session id, so recovery can pin the exact version even when the transcript carries none
  // (PHNX-3626).
  if (options.agent) {
    const runVersion = options.version ?? resolveVersion(options.agent, options.cwd || process.cwd());
    if (runVersion) result.AGENTS_RUN_VERSION = runVersion;
  }
  // So activity/feed posts stamp the right harness without re-detecting. A custom-harness run
  // (`agents run deepseek`) must stamp the profile name, not the host CLI, or sessions and feed
  // posts cannot tell them apart (PHNX-2935).
  if (options.agent) {
    result.AGENTS_AGENT_NAME = stampedAgentName(options);
  }
  if (options.cwd) {
    result.AGENTS_CWD = options.cwd;
  }

  // An account-slot launch (PHNX-3940 T5) tells the versioned alias which HOME-shaped dir owns
  // this run's config, so the alias's version-home pin (claude: CLAUDE_CONFIG_DIR) yields to the
  // slot. Cleared otherwise, so a child never inherits its parent's slot.
  if (options.execHome) {
    result.AGENTS_EXEC_HOME = options.execHome;
  } else {
    delete result.AGENTS_EXEC_HOME;
  }

  // Durable account identity for this run (PHNX-3940 model-refusal tracking).
  // Cleared when absent so a run spawned from inside an account-scoped session
  // never inherits its parent's account id.
  if (options.accountId) {
    result.AGENTS_RUN_ACCOUNT_ID = options.accountId;
  } else {
    delete result.AGENTS_RUN_ACCOUNT_ID;
  }

  // Export the run's durable name (companion to AGENT_SESSION_ID) so a
  // SessionStart hook / the agent can associate its transcript with the handle
  // the user gave the run. Only set when --name was passed.
  if (options.name) {
    result.AGENT_SESSION_NAME = options.name;
  }

  // Actor provenance: who initiated this run. Rides the env so the whole spawn tree shares one
  // actor and, for a resolved human, the agent's git commits credit the person, not the shared
  // account. options.env (spread last) overrides any of these keys.
  Object.assign(result, actorEnv(resolveActor()));

  return {
    ...result,
    ...options.env,
  };
}

/** Materialize config roots for vendor CLIs that do not create parents recursively. */
export function ensureVendorHomeDir(agent: AgentId, versionHome: string): string | null {
  if (agent !== 'cursor' && agent !== 'grok' && agent !== 'copilot') return null;
  const vendorHome = path.join(versionHome, agentConfigDirName(agent));
  fs.mkdirSync(vendorHome, { recursive: true });
  return vendorHome;
}

function resolveExecConfigHome(options: ExecOptions): { version: string | null; versionHome: string | null } {
  if (options.execHome) {
    const resolved = options.configVersion ?? options.version
      ?? resolveConfigVersion(options.agent, options.cwd || process.cwd(), options.version).version;
    return { version: resolved ?? null, versionHome: options.execHome };
  }
  return resolveConfigVersion(
    options.agent,
    options.cwd || process.cwd(),
    options.configVersion ?? options.version,
  );
}

function ensureVendorHomeForSpawn(options: ExecOptions): void {
  const { versionHome } = resolveExecConfigHome(options);
  if (versionHome) ensureVendorHomeDir(options.agent, versionHome);
}


/** How to translate ExecOptions into CLI arguments for one agent. `modeFlags` declares only
 * natively supported modes; keys must agree with AGENTS[agent].capabilities.modes, since
 * resolveMode() routes to a supported mode (or throws) before the flags are looked up. */
interface AgentCommandTemplate {
  base: string[];
  promptFlag: 'positional' | string;
  modeFlags: Partial<Record<Mode, string[]>>;
  jsonFlags?: string[];
  modelFlag?: string;
  printFlags?: string[];
  verboseFlag?: string;
  /** How this agent natively resumes a prior conversation; presence is the single source of truth
   * for `nativeResume(agent)`, others fall back to the universal `/continue <id>` replay. `{ flag
   * }` appends `<flag> <id>` (claude); */
  resume?: (
    { flag: string; interactiveFlag?: string; headlessFlag?: string } |
    { subcommand: string }
  ) & { since?: string };
}

/** CLI command templates for every supported agent. Each agent's `modeFlags` keys must match
 * AGENTS[agent].capabilities.modes; a test in exec.test.ts asserts this. */
export const AGENT_COMMANDS: Record<AgentId, AgentCommandTemplate> = {
  claude: {
    base: ['claude'],
    promptFlag: '-p',
    modeFlags: {
      plan: ['--permission-mode', 'plan'],
      edit: ['--permission-mode', 'acceptEdits'],
      auto: ['--permission-mode', 'auto'],
      skip: ['--dangerously-skip-permissions'],
    },
    jsonFlags: ['--output-format', 'stream-json', '--verbose'],
    modelFlag: '--model',
    printFlags: ['--print'],
    verboseFlag: '--verbose',
    resume: { flag: '--resume' },
  },
  codex: {
    base: ['codex', 'exec'],
    promptFlag: 'positional',
    resume: { subcommand: 'resume' },
    modeFlags: {
      // Native Codex modes are assembled by codexPolicyArgs below. Named
      // permission profiles keep filesystem access and network access
      // independent; legacy --sandbox flags cannot express that combination.
      plan: [],
      edit: [],
      auto: [],
      // skip = codex --yolo: drops the sandbox entirely and approves anything.
      skip: ['--dangerously-bypass-approvals-and-sandbox'],
    },
    jsonFlags: ['--json'],
    modelFlag: '--model',
  },
  cursor: {
    base: ['cursor-agent'],
    promptFlag: '-p',
    modeFlags: {
      plan: ['--plan'],
      edit: [],
      skip: ['-f'],
    },
    jsonFlags: ['--output-format', 'stream-json'],
    modelFlag: '--model',
    resume: { flag: '--resume', since: '2026.7.23' },
  },
  opencode: {
    base: ['opencode', 'run'],
    promptFlag: 'positional',
    // opencode's native resume is `opencode --session <id>` (NOT under `run`), so
    // it does not compose with this headless `run` base. Until that's verified on
    // a box with opencode installed, opencode resumes via Tier-2 `/continue`.
    modeFlags: {
      plan: ['--agent', 'plan'],
      edit: ['--agent', 'build'],
    },
    jsonFlags: ['--format', 'json'],
    modelFlag: '--model',
  },
  openclaw: {
    base: ['openclaw'],
    promptFlag: 'positional',
    modeFlags: {
      plan: ['--mode', 'plan'],
      edit: ['--mode', 'edit'],
      skip: ['--mode', 'full'],
    },
    jsonFlags: ['--output-format', 'stream-json'],
    modelFlag: '--model',
  },
  // GitHub Copilot CLI (`@github/copilot`); flags verified against `copilot --help` v0.0.413+.
  // Plan mode is read-only and needs no tool grant; edit needs `--allow-all-tools` (required for
  // non-interactive tool exec) so headless runs do not stall on prompts.
  copilot: {
    base: ['copilot'],
    promptFlag: '-p',
    modeFlags: {
      plan: ['--mode', 'plan'],
      edit: ['--allow-all-tools'],
      auto: ['--autopilot'],
      skip: ['--allow-all'],
    },
    jsonFlags: ['--output-format', 'json'],
    modelFlag: '--model',
  },
  amp: {
    base: ['amp'],
    promptFlag: 'positional',
    modeFlags: {
      plan: ['--mode', 'plan'],
      edit: ['--mode', 'edit'],
    },
    modelFlag: '--model',
  },
  goose: {
    base: ['goose', 'run'],
    promptFlag: 'positional',
    modeFlags: {
      // goose has no permission flags — edit is the default behavior.
      edit: [],
    },
  },
  // TODO: --output-format json is documented but broken upstream ("flags provided but not defined:
  // -output-format"). Track https://github.com/google-antigravity/antigravity-cli/issues/7 before
  // adding `jsonFlags` here.
  antigravity: {
    base: ['agy'],
    promptFlag: 'positional',
    modeFlags: {
      // agy --help shows no plan/edit flags; default behavior is edit-like
      // (prompts on tool use). Only skip has an explicit flag.
      edit: [],
      skip: ['--dangerously-skip-permissions'],
    },
    printFlags: ['--print'],
    modelFlag: '--model',
  },
  grok: {
    base: ['grok'],
    promptFlag: '-p',
    modeFlags: {
      // grok --help lists `--permission-mode plan`; the TUI defaults to ask.
      plan: ['--permission-mode', 'plan'],
      edit: [],
      skip: ['--always-approve'],
    },
    jsonFlags: ['--output-format', 'streaming-json'],
    modelFlag: '--model',
    resume: { flag: '--resume', since: '0.2.91' },
  },
  kimi: {
    base: ['kimi'],
    promptFlag: '-p',
    modeFlags: {
      plan: ['--plan'],
      edit: [],
      auto: ['--auto'],
      skip: ['--yolo'],
    },
    jsonFlags: ['--output-format', 'stream-json'],
    modelFlag: '--model',
    resume: { flag: '--session', since: '0.19.2' },
  },
  // Factory AI Droid (`droid exec` headless, `droid` TUI), flags from docs.factory.ai: prompt is
  // positional; `--auto low|medium|high` escalates autonomy (default read-only);
  // `--skip-permissions-unsafe` drops all guardrails; `-o stream-json` streams JSONL.
  droid: {
    base: ['droid', 'exec'],
    promptFlag: 'positional',
    modeFlags: {
      plan: [],                          // droid's default exec mode is read-only
      edit: ['--auto', 'low'],           // create/edit files, non-destructive
      auto: ['--auto', 'high'],          // full autonomy
      skip: ['--skip-permissions-unsafe'],
    },
    jsonFlags: ['-o', 'stream-json'],
    modelFlag: '-m',
    resume: { flag: '--resume', headlessFlag: '--session-id', since: '0.186.0' },
  },
  hermes: {
    base: ['hermes', 'chat'],
    promptFlag: 'positional',
    modeFlags: {
      edit: [],
    },
    modelFlag: '--model',
  },
  // Meta Muse Code (`muse exec` headless, `muse` TUI), flags from `muse --help` v0.1.0:
  // `--disable-write` approximates plan; `--disable-approval` keeps the sandbox (auto); `--yolo`
  // drops approval+sandbox (skip); `--json` emits JSONL.
  muse: {
    base: ['muse', 'exec'],
    promptFlag: 'positional',
    modeFlags: {
      plan: ['--disable-write'],
      edit: [],
      auto: ['--disable-approval'],
      skip: ['--yolo'],
    },
    jsonFlags: ['--json'],
    modelFlag: '--model',
    // Flag form covers headless (`--session-id`). Interactive uses the
    // `resume` subcommand — special-cased in buildExecCommand.
    resume: { flag: '--session-id' },
  },
  // Warp Agent CLI (`warp`) is an interactive TUI with no headless one-shot form, so the single
  // `edit` mode maps to no flags. No `resume`: warp is not session-tracked, so declaring it would
  // point nativeResume at an unreachable path.
  warp: {
    base: ['warp'],
    promptFlag: 'positional',
    modeFlags: {
      edit: [],
    },
  },
};

/** Whether `agent` has a native resume form (Tier 1), derived solely from the command template's
 * `resume` field; others resume via the universal Tier-2 `/continue` replay. */
export function nativeResume(agent: AgentId, version?: string): boolean {
  const resume = AGENT_COMMANDS[agent]?.resume;
  if (!resume) return false;
  if (!resume.since) return true;
  return !!version && compareVersions(installedReleaseFor(agent, version), resume.since) >= 0;
}

/** Build the `-c` value adding `dir` to codex's workspace-write writable roots: codex parses it as
 * TOML, so a single-element array of one quoted string. Used on codex resume forms, which reject
 * `--add-dir` and accept only `-c` overrides. */
export function codexWritableRootsConfig(dir: string): string {
  return `sandbox_workspace_write.writable_roots=[${JSON.stringify(dir)}]`;
}

/** Resolve the executable `buildExecCommand` puts in `cmd[0]`, or null. An existence probe: with
 * no version pinned, PATH lookup (self-installs are supported); our shim counts only if a managed
 * version exists (RUSH-2339). A pinned version never falls back to PATH (it would exit 127). */
export function resolveLaunchBinary(agent: AgentId, version?: string): string | null {
  const command = AGENT_COMMANDS[agent].base[0];
  if (version) {
    const versionedShim = path.join(getShimsDir(), `${command}@${version}`);
    if (process.platform === 'win32' && fs.existsSync(versionedShim + '.cmd')) {
      return versionedShim + '.cmd';
    }
    if (fs.existsSync(versionedShim)) return versionedShim;
    const binary = getBinaryPath(agent, version);
    return binary && fs.existsSync(binary) ? binary : null;
  }
  const native = findInPath(command);
  if (native) return native;
  if (listInstalledVersions(agent).length === 0) return null;
  // Re-scan PATH accepting the shim: point findInPath's exclusion at a path that
  // matches nothing, so the real shims dir participates like any other PATH entry.
  return findInPath(command, { shimsDir: path.join(getShimsDir(), '.no-such-dir') });
}

/** Assemble the full CLI argument array for an agent invocation. */
export function buildExecCommand(options: ExecOptions): string[] {
  const template = AGENT_COMMANDS[options.agent];
  const cmd: string[] = [...template.base];
  const interactive = resolveInteractive(options);

  // Codex, Droid, and Muse use `exec` as the headless subcommand, OpenCode uses `run`. Drop it for
  // interactive mode to launch the TUI instead of the one-shot subcommand.
  if (interactive) {
    if (
      (options.agent === 'codex' || options.agent === 'droid' || options.agent === 'muse') &&
      cmd[1] === 'exec'
    ) {
      cmd.splice(1, 1);
    } else if (options.agent === 'opencode' && cmd[1] === 'run') {
      cmd.splice(1, 1);
    }
  }

  // Native resume with a `{ subcommand }` shape (codex) appends the verb to the base (`codex exec
  // resume` headless, `codex resume` TUI); the session id is pushed later as the first positional.
  // `{ flag }` agents (claude) need no base change. Interactive muse pushes `resume <id>` here.
  const resumeSpec = options.resume ? template.resume : undefined;
  let museInteractiveResumeDone = false;
  if (options.agent === 'muse' && options.resume && interactive && options.sessionId) {
    cmd.push('resume', options.sessionId);
    museInteractiveResumeDone = true;
  } else if (resumeSpec && 'subcommand' in resumeSpec) {
    cmd.push(resumeSpec.subcommand);
  }

  // Use a versioned alias if a specific version was requested (e.g. claude@2.1.98), resolved to
  // the shim's absolute path so spawn does not depend on PATH (bare names fail ENOENT where the
  // shims dir is not on PATH). On Windows the alias is a `.cmd` only.
  if (options.version && cmd.length > 0) {
    const versionedName = `${cmd[0]}@${options.version}`;
    const absPath = path.join(getShimsDir(), versionedName);
    if (process.platform === 'win32' && fs.existsSync(absPath + '.cmd')) {
      cmd[0] = absPath + '.cmd';
    } else if (fs.existsSync(absPath)) {
      cmd[0] = absPath;
    } else {
      // No versioned shim on disk: prefer the version's real launch binary
      // (node_modules/.bin/<cli>) over the bare `<cli>@<version>` name, which is not on PATH and
      // spawns ENOENT (the `kimi@0.19.2` failure). Use the literal only if the binary is absent.
      const realBinary = options.agent ? getBinaryPath(options.agent, options.version) : undefined;
      cmd[0] = realBinary && fs.existsSync(realBinary) ? realBinary : versionedName;
    }
  }

  // Resolve the model up front so the reasoning-flag block can honor a cost tier mapping to
  // reasoning effort on a single-model harness (Grok). Explicit --model wins; codex falls back to
  // ~/.codex/config.toml; OpenCode's OPENCODE_MODEL must become `--model` (PHNX-2577).
  const effectiveModel = options.model
    ?? (options.agent === 'codex' ? readCodexConfiguredModel() : undefined)
    ?? (options.agent === 'opencode' ? options.env?.OPENCODE_MODEL : undefined);
  const modelVersion = effectiveModel && template.modelFlag
    ? (options.version || resolveVersion(options.agent, options.cwd || process.cwd()))
    : null;
  const tierResolved = effectiveModel && modelVersion && isTierToken(effectiveModel)
    ? resolveTier(options.agent, modelVersion, effectiveModel)
    : null;
  // An explicit --effort wins; otherwise a single-model tier's effort applies.
  const effortLevel = options.effort !== 'auto' ? options.effort : (tierResolved?.effort ?? options.effort);

  // Add reasoning effort flags (before mode flags for codex -c positioning)
  // For codex, -c must come before 'exec' subcommand, so we insert at position 1
  if (effortLevel !== 'auto') {
    const reasoningFlags = buildReasoningFlags(options.agent, effortLevel);
    if (reasoningFlags.length > 0) {
      if (options.agent === 'codex') {
        // Insert after 'codex' (or 'codex@version') but before 'exec'
        cmd.splice(1, 0, ...reasoningFlags);
      } else {
        // For other agents, append after base
        cmd.push(...reasoningFlags);
      }
    }
  }

  // Resolve the requested mode against the capability table: `auto` without support degrades to
  // `edit`; `plan` without a read-only mode degrades to modes[0]; headless `plan` with
  // headlessPlan:false (kimi, grok) degrades to `auto` with a stderr warning;
  const resolvedMode = resolveHeadlessMode(
    options.agent,
    normalizeMode(options.mode),
    interactive,
    options.modeWarningContext,
    options.modeWarningState,
  );
  const modeFlags = template.modeFlags[resolvedMode];
  if (!modeFlags) {
    // Defense in depth: would only fire if AGENTS.capabilities.modes and
    // AGENT_COMMANDS.modeFlags drifted apart. Tests assert they agree.
    throw new Error(
      `Internal error: ${options.agent} declares '${resolvedMode}' in capabilities.modes but has no entry in AGENT_COMMANDS.modeFlags.${resolvedMode}.`,
    );
  }
  // Launch-arg quirks (the harness axis of Move 3): cursor's additive `--trust` and the codex/kimi
  // mode-flag overrides live in the harness adapter, collapsing the per-agent name chain to one
  // dispatch.
  const launchAdapter = resolveHarnessAdapter(options.agent);
  const launchArgsCtx = {
    resolvedMode,
    interactive,
    cwd: options.cwd ?? process.cwd(),
    addDirs: (options.addDirs ?? []).map(expandLocalHome),
  };
  const preModeArgs = launchAdapter.execPreModeArgs?.(launchArgsCtx);
  if (preModeArgs) {
    cmd.push(...preModeArgs);
  }
  const modeArgsOverride = launchAdapter.execModeArgs?.(launchArgsCtx);
  if (modeArgsOverride !== undefined) {
    cmd.push(...modeArgsOverride);
  } else if (resumeSpec && 'subcommand' in resumeSpec) {
    if (resolvedMode === 'skip') {
      // skip = yolo on resume too; both `codex resume` (TUI) and
      // `codex exec resume` accept the bypass flag.
      cmd.push('--dangerously-bypass-approvals-and-sandbox');
    } else if (interactive) {
      cmd.push(...modeFlags);
    } else {
      // `codex exec resume` rejects `--sandbox <mode>` (verified on 0.142.5) but takes `-c`
      // overrides, so map the mode through sandbox_mode so a non-skip resume never gets the
      // approval/sandbox bypass.
      cmd.push(...modeFlags);
    }
  } else {
    cmd.push(...modeFlags);
  }

  // Add print/headless flags when the run resolved headless (`!interactive`), not on the raw
  // `--headless` flag, which defaults to false and is inferred from prompt presence.
  if (!interactive && template.printFlags) {
    cmd.push(...template.printFlags);
  }

  // Resume vs create. With `resume`, emit the agent's native reference: `{ flag }` agents append
  // `<flag> <id>`; `{ subcommand }` agents (codex) already pushed the verb, so the id is the first
  // positional, before the prompt.
  if (options.resume && options.sessionId && resumeSpec && !museInteractiveResumeDone) {
    if ('flag' in resumeSpec) {
      const flag = interactive
        ? (resumeSpec.interactiveFlag ?? resumeSpec.flag)
        : (resumeSpec.headlessFlag ?? resumeSpec.flag);
      cmd.push(flag, options.sessionId);
    } else {
      cmd.push(options.sessionId);
    }
  } else if (options.sessionId && options.agent === 'claude') {
    cmd.push('--session-id', options.sessionId);
  }

  // Add model. `effectiveModel` already preferred --model, then Codex's
  // configured default, then an OpenCode custom-harness pin (OPENCODE_MODEL).
  if (effectiveModel && template.modelFlag) {
    if (tierResolved) {
      // Cost tier (cheap|default|best|ultra) maps to a concrete model this harness+version ships,
      // covering `agents run` and `agents teams`. A null model means nothing resolved: drop the
      // flag and let the harness pick.
      if (tierResolved.model) {
        cmd.push(template.modelFlag, tierResolved.model);
        if (tierResolved.note) process.stderr.write(`[agents] --model ${effectiveModel} -> ${tierResolved.model} (${tierResolved.note})\n`);
      } else {
        process.stderr.write(`[agents] no model for tier "${effectiveModel}" on ${options.agent}@${modelVersion}; using harness default\n`);
      }
    } else if (modelVersion) {
      const resolved = resolveModel(options.agent, modelVersion, effectiveModel);
      if (resolved.warning) {
        process.stderr.write(`[agents] ${resolved.warning}\n`);
      }
      cmd.push(template.modelFlag, resolved.forwarded);
    } else if (!isTierToken(effectiveModel)) {
      cmd.push(template.modelFlag, effectiveModel);
    } else {
      // Tier token but no version resolved -> forwarding the literal "best"/etc.
      // would be rejected by the CLI, so drop the flag (harness default).
      process.stderr.write(`[agents] cannot resolve tier "${effectiveModel}" without a version; using harness default\n`);
    }
  }

  // Add JSON output flags if requested
  if (options.json && template.jsonFlags) {
    cmd.push(...template.jsonFlags);
  }

  // Add verbose flag independently of JSON
  if (options.verbose && template.verboseFlag) {
    // Avoid duplicate if jsonFlags already included --verbose
    if (!(options.json && template.jsonFlags?.includes(template.verboseFlag))) {
      cmd.push(template.verboseFlag);
    }
  }

  // Add prompt when provided. In pure interactive mode (no prompt) we skip this
  // so the CLI launches its TUI. When --interactive is passed alongside a prompt
  // we still forward the prompt so the agent receives it as the first message.
  if (options.prompt !== undefined) {
    if (interactive && options.agent === 'opencode') {
      // The OpenCode TUI takes an initial prompt via --prompt; a bare positional
      // on the default command is parsed as a project path, not a message.
      cmd.push('--prompt', options.prompt);
    } else if (interactive && options.agent === 'claude') {
      // Claude's -p is --print, not a prompt-value flag. In an interactive run
      // the initial prompt is positional; emitting `-p /continue <id>` turns a
      // focus recovery into a one-shot print process that immediately exits.
      cmd.push(options.prompt);
    } else if (template.promptFlag === 'positional') {
      cmd.push(options.prompt);
    } else {
      cmd.push(template.promptFlag, options.prompt);
    }
  }

  // Project / --add-dir grants. Codex folds them into the named edit profile and its resume
  // rejects `--add-dir`; the rest is strategy-driven in applyAddDirs. `~` is expanded locally:
  // a grant crossing SSH single-quoted would stay a literal `~` dir.
  applyAddDirs(options.agent, cmd, options.addDirs, {
    cwd: options.cwd ?? process.cwd(),
  });

  // Claude workflow scoping: WORKFLOW.md `tools:` becomes `--tools <names...>`, the security
  // boundary (`--allowedTools` only auto-approves, also emitted to avoid headless prompts).
  // `mcpServers:` becomes `--mcp-config` plus `--strict-mcp-config`, else servers are only added.
  if (options.agent === 'claude') {
    if (options.toolsRestrict && options.toolsRestrict.length > 0) {
      cmd.push('--tools', ...options.toolsRestrict);
      cmd.push('--allowedTools', ...options.toolsRestrict);
    }
    if (options.mcpConfigPath) {
      cmd.push('--mcp-config', options.mcpConfigPath);
      cmd.push('--strict-mcp-config');
    }
  }

  // Forward arbitrary native flags supplied after `--` verbatim. Appended last
  // so they cannot be misinterpreted as values for earlier flags or as the prompt.
  if (options.passthroughArgs && options.passthroughArgs.length > 0) {
    cmd.push(...options.passthroughArgs);
  }

  return cmd;
}

/** Spawn an agent and return its exit code. Convenience wrapper over spawnAgent. */
export async function execAgent(options: ExecOptions): Promise<number> {
  const { exitCode } = await spawnAgent(options);
  return exitCode;
}

/** Resolve how to spawn a shim target for a platform; pure. POSIX execs the binary directly (no
 * shell). On Windows a bare name or `.cmd` goes through the shell so cmd.exe resolves PATHEXT;
 * npm always ships a `.cmd` companion, so the target is never a bare `.ps1`. */
export function resolveShimSpawn(
  platform: NodeJS.Platform,
  binary: string,
  extraArgs: string[],
): { command: string; args: string[]; shell: boolean } {
  if (platform === 'win32') {
    // Use win32 path semantics regardless of the host running this (the platform
    // is the parameter, not process.platform) so `C:\...` reads as absolute.
    const useShell = !path.win32.isAbsolute(binary) || binary.endsWith('.cmd');
    if (useShell) {
      // DEP0190-safe: hand cmd.exe one fully-quoted command line with an empty args array, so Node
      // never concatenates `extraArgs` (the user's raw prompt/flags) into the shell line
      // unescaped, which is both the deprecation and a command-injection surface.
      return { command: composeWin32CommandLine(binary, extraArgs), args: [], shell: true };
    }
    return { command: binary, args: extraArgs, shell: false };
  }
  return { command: binary, args: extraArgs, shell: false };
}

/** Transparent passthrough exec for generated shims, the node-side delegate Windows `.cmd` shims
 * call: resolve the active version (explicit pin, else project/default) and exec the real binary
 * with the user's raw args and per-version env isolation, injecting no mode/model/reasoning flags. */
export async function execShimPassthrough(
  agent: AgentId,
  rawArgs: string[],
  cwd: string,
  pinnedVersion?: string,
): Promise<number> {
  const version = pinnedVersion ?? resolveVersion(agent, cwd) ?? undefined;
  if (!version || !isVersionInstalled(agent, version)) return execShimPassthroughLeased(agent, rawArgs, cwd, version);
  return withInstallationLease(agent, version, () => execShimPassthroughLeased(agent, rawArgs, cwd, version));
}

async function execShimPassthroughLeased(
  agent: AgentId,
  rawArgs: string[],
  cwd: string,
  pinnedVersion?: string,
): Promise<number> {
  const version = pinnedVersion ?? resolveVersion(agent, cwd) ?? undefined;
  if (!version || !isVersionInstalled(agent, version)) {
    process.stderr.write(`agents: no installed default for ${agent}. Set one with: agents use ${agent} <version>\n`);
    return 127;
  }

  let binary = getBinaryPath(agent, version);
  if (process.platform === 'win32') {
    // npm ships <cmd>.cmd alongside the bare script on Windows; that's the runnable form.
    const cmdPath = binary + '.cmd';
    if (fs.existsSync(cmdPath)) binary = cmdPath;
  }

  // Match the POSIX shim: direct Codex launches default to the safe writable
  // profile, while later user arguments can still override native settings.
  const launchArgs = agent === 'codex'
    ? ['-c', 'check_for_update_on_startup=false', ...codexPolicyArgs('edit', codexEditWritableRoots(cwd))]
    : [];
  // Mint a launch id and export it as AGENT_LAUNCH_ID so the SessionStart hook records the same
  // id: the join key mapping this launch to its session even though the recorded pid is the
  // cmd.exe wrapper while the hook runs under the agent descendant.
  const launchId = randomUUID();
  // mode/effort are required by ExecOptions but do not affect the derived env, so pass the agent
  // default. With no prompt this resolves interactive, using the per-version login, not the
  // setup-token (EXEC-2a). Known limit: a `-p` passthrough is misclassified. Windows-only.
  const env = buildExecEnv({ agent, version, cwd, mode: defaultModeFor(agent), effort: 'auto', env: { AGENT_LAUNCH_ID: launchId } });
  ensureVendorHomeDir(agent, getVersionHomePath(agent, version));
  const { command, args, shell } = resolveShimSpawn(process.platform, binary, [...launchArgs, ...rawArgs]);

  // Pre-launch marker for the second live launch path: the Windows `.cmd` shim delegates here and
  // spawns the harness directly, so without this a pinned, logged-out version launched via the
  // shim would be invisible.
  await emitRunLaunch({ agent, version, resolvedVia: 'shim' });

  return new Promise((resolve) => {
    // Register listeners in the same synchronous turn as spawn: awaiting a lock
    // release after spawn can miss a fast child's exit/error event.
    const child = spawn(command, args, { cwd, stdio: 'inherit', env, shell });
    // Record the launch so `ag sessions --active` can attribute the agent process to its cwd (and
    // exact session when `--session-id` was passed); vital on Windows, which has no lsof.
    if (child.pid) {
      const passthroughSessionId = extractSessionIdArg(rawArgs);
      writePidSessionEntry({
        pid: child.pid,
        agent,
        sessionId: passthroughSessionId,
        cwd,
        actor: resolveActor().id,
        initiatedBy: resolveActor().kind,
        launchId,
        terminalId: launchIdentityEnv().AGENT_TERMINAL_ID,
        startedAtMs: Date.now(),
      });
      // Durable sessionId -> actor record (RUSH-2019) so the scanner can attribute
      // this session to a person after the pid dies. Best-effort; no-ops without id.
      if (passthroughSessionId) {
        writeSessionActorRecord({
          sessionId: passthroughSessionId,
          actor: resolveActor().id,
          initiatedBy: resolveActor().kind,
          phoenixId: resolveActor().phoenixId,
          startedAtMs: Date.now(),
        });
      }
    }
    child.on('exit', (code, signal) => resolve(code ?? (signal ? 1 : 0)));
    child.on('error', (err) => {
      process.stderr.write(`agents: failed to launch ${agent}: ${err.message}\n`);
      resolve(127);
    });
  });
}

/** Exit code and captured output from a spawned agent process. */
interface SpawnResult {
  exitCode: number;
  stderr: string;
  /** Rolling tail of the child's stdout, captured only when the stream was tapped (budget watcher,
   * piped caller, or captureStdoutTail); empty when inherited. runWithFallback uses it to detect
   * billing refusals Claude prints to stdout. */
  stdout: string;
}

/** Whether a dead pane's failure should be recapped to stderr (RUSH-2185 / EXEC-23a). Headless:
 * only a nonzero exit is a failure. */
export function shouldRecapDeadPane(status: number | undefined, interactive: boolean): boolean {
  return (status ?? 0) !== 0 || interactive;
}

/** The exit code a tmux-wrapped run resolves with (RUSH-2185 / EXEC-23b): success only for an
 * outcome tmux told us about. A clean detach is 0, a dead pane its status; anything unknown is
 * UNKNOWN_OUTCOME_EXIT_CODE, never 0 (a dead tmux server once returned success). */
export function tmuxRunExitCode(
  pane: { dead: boolean; status?: number },
  knownAlive: boolean,
): number {
  if (knownAlive) return 0;
  if (pane.dead && pane.status !== undefined) return pane.status;
  return UNKNOWN_OUTCOME_EXIT_CODE;
}

/** True only when a `display-message #{pane_dead}` query explicitly returned "0" (pane alive), to
 * tell "alive" from "query failed", where `paneExitStatus` conservatively returns `{dead: false}`
 * for both (RUSH-2185 / EXEC-23a). `code` is the tmux command's exit code and `stdout` its output. */
export function isPaneKnownAliveFromQueryResult(code: number, stdout: string): boolean {
  return code === 0 && stdout.trim() === '0';
}

/** Inputs that decide whether an interactive spawn is wrapped in a shared-socket tmux session. */
export interface TmuxWrapContext {
  /** resolveInteractive() result — only interactive REPL launches are wrapped. */
  interactive: boolean;
  /** process.platform — Windows has no tmux path, always spawns bare. */
  platform: NodeJS.Platform;
  /** True when the launcher itself already runs inside tmux ($TMUX set) — never double-wrap. */
  inTmux: boolean;
  /** The `--raw` escape hatch. */
  raw: boolean;
  /** The AGENTS_NO_TMUX=1 escape hatch. */
  noTmuxEnv: boolean;
  /** This device's `tmux.enabled` config — true opts every eligible launch on this box into the wrap. */
  configEnabled: boolean;
  /** True when this run was dispatched onto this box over SSH by `--device` (the launcher exports
   * {@link REMOTE_INTERACTIVE_ENV}). Since PHNX-3316 it no longer forces the wrap, except a
   * followed run whose launcher has no TTY still wraps (`undurable` if tmux is missing). */
  remoteDispatch: boolean;
  /** Whether a tmux binary is on PATH. */
  tmuxAvailable: boolean;
  /** True when this process has a real TTY to attach (`stdout.isTTY`). A piped `agents run
   * --interactive` has none, and wrapping then treating the failed attach as Ctrl-b d leaked live
   * panes for a week (PHNX-3293). */
  hasTty: boolean;
}

/** What to do with an interactive spawn: three outcomes. */
type TmuxWrapDecision =
  /** Run the agent in a detached tmux session and attach this TTY. */
  | { kind: 'wrap' }
  /** Spawn directly — nothing about this run needs a pane. */
  | { kind: 'bare' }
  /** Remote-dispatched, wants the wrap, and tmux is missing: refuse, don't pretend. */
  | { kind: 'undurable' };

/** Tmux is opt-in except when a TTY-less remote launch would otherwise have no interface. Explicit
 * per-run opt-outs always win. */
export function resolveTmuxWrap(ctx: TmuxWrapContext): TmuxWrapDecision {
  // A headless `-p` run has no TTY to attach, Windows has no tmux path, and
  // nesting tmux-in-tmux is pointless.
  if (!ctx.interactive) return { kind: 'bare' };
  if (ctx.platform === 'win32') return { kind: 'bare' };
  if (ctx.inTmux) return { kind: 'bare' };
  // Explicit opt-outs win over every other rule: `--raw` exists precisely to
  // get the unwrapped process.
  if (ctx.raw) return { kind: 'bare' };
  if (ctx.noTmuxEnv) return { kind: 'bare' };
  // Local interactive with no TTY cannot attach. Wrapping anyway creates a
  // detached pane, attach returns immediately, and resolveAfterAttach treats
  // the still-alive pane as Ctrl-b d — the session-tracker test leak.
  if (!ctx.hasTty && !ctx.remoteDispatch) return { kind: 'bare' };
  // tmux.enabled gates the wrap for local and followed remote runs. The one exception: a followed
  // remote run whose launcher has no TTY (CI, scripts) gives the peer nothing to attach to, so the
  // detached pane is its only interface, infrastructure rather than ergonomics.
  if (!ctx.configEnabled && !(ctx.remoteDispatch && !ctx.hasTty)) return { kind: 'bare' };
  // Fail loud rather than launch a remote agent that a blink would kill: the
  // caller refuses the run instead of starting work that cannot be recovered.
  if (!ctx.tmuxAvailable) return ctx.remoteDispatch ? { kind: 'undurable' } : { kind: 'bare' };
  return { kind: 'wrap' };
}

/** True when `options.sessionId` is an id the harness actually received (a real, resumable
 * handle), not launcher bookkeeping. Mirrors buildExecCommand's native-resume and claude
 * `--session-id` branches; a new forced-id flag must update both in the SAME change. */
export function isHarnessKnownSessionId(
  agent: AgentId,
  sessionId: string | undefined,
  resume: boolean | undefined,
): boolean {
  if (!sessionId) return false;
  if (resume && AGENT_COMMANDS[agent]?.resume) return true;
  return agent === 'claude';
}

/** Build the pane command without inheriting stale tmux-server env. Redacted copies keep secret
 * values out of persisted SessionMeta commands. */
export function buildTmuxAgentCommand(
  executable: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  opts: { redactEnvValues?: boolean; envFile?: string } = {},
): string {
  const agentCmd = [executable, ...args].map(shellQuote).join(' ');
  const absentIdentity = LAUNCH_IDENTITY_KEYS.filter(key => env[key] === undefined);
  // envFile: source the values instead of inlining them, so no value lands in the pane's argv.
  // `exec env K=V ...` put every resolved secret in the process table, including the secrets-store
  // master passphrase on a fleet box (RUSH-2100).
  if (opts.envFile) {
    const f = shellQuote(opts.envFile);
    // Remove the file whether or not sourcing succeeds: a bare `. f || exit 1` strands the
    // plaintext env (including the master passphrase) on disk on a source failure, worse than the
    // argv leak this replaces (RUSH-2100). Capture the source rc, unlink, then honor it.
    return `${absentIdentity.length ? `unset ${absentIdentity.join(' ')}; ` : ''}set -a; . ${f}; __agents_rc=$?; set +a; rm -f ${f}; [ "$__agents_rc" -eq 0 ] || exit 1; exec ${agentCmd}`;
  }
  const envPrefix = Object.entries(env)
    .filter(([k, v]) => v !== undefined && EXEC_ENV_KEY_PATTERN.test(k))
    .map(([k, v]) => `${k}=${opts.redactEnvValues ? '<redacted>' : shellQuote(String(v))}`)
    .join(' ');
  return `exec env ${absentIdentity.map(key => `-u ${key}`).join(' ')} ${envPrefix} ${agentCmd}`;
}

/** Serialize the pane env to a shell-sourceable file, created 0600 and exclusively (`wx`) so it
 * never adopts a pre-existing file's mode or content. Every key goes in, not a curated
 * secret-bearing subset: a denylist breaks the moment someone forgets a new credential. */
export function writeTmuxEnvFile(env: NodeJS.ProcessEnv, filePath: string): void {
  const body = Object.entries(env)
    .filter(([k, v]) => v !== undefined && EXEC_ENV_KEY_PATTERN.test(k))
    .map(([k, v]) => `${k}=${shellQuote(String(v))}`)
    .join('\n');
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const fd = fs.openSync(filePath, 'wx', 0o600);
  try {
    fs.writeSync(fd, `${body}\n`);
  } finally {
    fs.closeSync(fd);
  }
}

/** Trim a raw `tmux capture-pane` dump to its last `maxLines` non-empty lines (right-stripped).
 * runInTmux recaps a fast-failed agent's output so a launch crash (e.g. a gutted install dying
 * with ENOENT) is not swallowed by the bare `[detached]` the pane-died hook leaves. */
export function formatPaneTail(raw: string, maxLines = 30): string {
  return raw
    .split('\n')
    .map(l => l.replace(/\s+$/, ''))
    .filter(l => l.length > 0)
    .slice(-maxLines)
    .join('\n');
}

/** Run an interactive agent in a detached tmux session on the shared socket, attach the TTY, and
 * propagate its exit code. A `pane-died` hook guarded on `#{hook_pane}` tears down only when the
 * agent pane exits; a user detach (Ctrl-b d) returns 0 and leaves it for `agents focus`. */
async function runInTmux(options: ExecOptions, executable: string, args: string[]): Promise<SpawnResult> {
  const { createSession, killSession, paneExitStatus, prepareSessionForResume, setSessionHook, slugifyName, agentPaneDiedHook, markSessionHookSchema } = await import('./tmux/session.js');
  const { getDefaultSocketPath } = await import('./tmux/paths.js');
  const { attachTmux, runTmux } = await import('./tmux/binary.js');

  const socket = getDefaultSocketPath();
  const cwd = options.cwd || process.cwd();
  const idSeed = (options.sessionId ?? randomUUID()).slice(0, 8);
  const name = slugifyName(`ag-${options.agent}-${idSeed}`);

  const RED = '\x1b[31m', GRAY = '\x1b[90m', OFF = '\x1b[0m';
  const NO_TMUX_TIP = `${GRAY}  This run used the opt-in tmux wrap. Re-run with --no-tmux for a direct launch, or turn the wrap off: agents config set devices.${machineId()}.tmux off${OFF}\n\n`;

  // Read a dead pane's scrollback before killSession (capture-pane needs the session alive;
  // remain-on-exit keeps the dead pane readable). Best-effort: a gone pane yields ''. Use only for
  // a proven-dead pane, never detach or unknown, so neither masquerades as refusal evidence.
  const capturePaneTail = async (pane: string | undefined): Promise<string> => {
    if (!pane) return '';
    try {
      const r = await runTmux({ socket, args: ['capture-pane', '-p', '-t', pane, '-S', '-200'], throwOnError: false });
      return r.code === 0 ? formatPaneTail(r.stdout) : '';
    } catch {
      return '';
    }
  };

  // Recap a dead pane's tail into this shell's stderr. The pane-died hook detaches the client when
  // the agent exits, so a fast failure (gutted install ENOENT, bad flag, startup crash) would
  // leave only a bare `[detached]`.
  const surfacePaneFailure = async (
    pane: string | undefined,
    status: number | undefined,
    headline: string,
    tail: string,
  ): Promise<void> => {
    if (!pane) return;
    process.stderr.write(`\n${RED}agents: ${headline} (exit ${status ?? UNKNOWN_OUTCOME_EXIT_CODE}).${OFF}\n`);
    if (tail) {
      process.stderr.write(`${GRAY}  ── last output from ${options.agent} ──${OFF}\n`);
      process.stderr.write(tail.replace(/^/gm, '  ') + '\n');
      process.stderr.write(`${GRAY}  ${'─'.repeat(30)}${OFF}\n`);
    }
    process.stderr.write(NO_TMUX_TIP);
  };

  // F3 (RUSH-2185 / EXEC-23a): paneExitStatus returns {dead:false} for both "alive" and "tmux
  // query failed". Require positive proof before the keep-session path: a direct query returning
  // true only when tmux confirms pane_dead=0.
  const checkPaneKnownAlive = async (p: string): Promise<boolean> => {
    try {
      const r = await runTmux({ socket, args: ['display-message', '-pt', p, '-p', '#{pane_dead}'], throwOnError: false });
      return isPaneKnownAliveFromQueryResult(r.code, r.stdout);
    } catch { return false; }
  };

  /** Resolve what an attach client's return means, for every path that attaches. Only asking tmux
   * distinguishes "the user detached" from "the agent exited" from "the session went away"; an
   * attach that skips this can only assume success, the EXEC-23b defect. */
  let paneLaunchBinding: ReturnType<typeof captureLaunchBinding>;
  const bindCompletedPane = () => {
    recordCompletedLaunch(paneLaunchBinding);
  };
  const resolveAfterAttach = async (pane: string | undefined): Promise<{ exitCode: number; stderr: string; stdout: string }> => {
    const after = pane ? await paneExitStatus(pane, socket) : { found: false, dead: false, status: undefined };
    if (after.dead) {
      bindCompletedPane();
      // Positive proof of a completed pane (paneExitStatus confirmed dead): capture its scrollback
      // as refusal evidence before teardown.
      const tail = await capturePaneTail(pane);
      // Nonzero exit after attach means the agent crashed rather than the user detaching (a clean
      // detach leaves the pane alive). F2: for interactive runs also recap a clean exit-0, since
      // exiting without starting a REPL is still a failure.
      if (shouldRecapDeadPane(after.status, resolveInteractive(options))) {
        await surfacePaneFailure(pane, after.status, `${options.agent} exited`, tail);
      }
      await killSession(name, socket).catch(() => {});
      // A dead pane whose status tmux never reported is UNKNOWN, not success —
      // and surfacePaneFailure already printed `exit 1` for it, so the old
      // `?? 0` made the message and the returned code disagree (EXEC-23b).
      return { exitCode: tmuxRunExitCode(after, false), stderr: '', stdout: tail };
    }
    // after.dead===false, but that could be a stale/unreadable-pane result.
    // Require positive proof before keeping the session as "user detached".
    if (pane && await checkPaneKnownAlive(pane)) {
      // Confirmed alive: the user pressed Ctrl-b d; keep the session for `agents focus`.
      return { exitCode: tmuxRunExitCode(after, true), stderr: '', stdout: '' };
    }
    // F4 (EXEC-23b): the outcome is unknown (tmux cannot say whether the agent finished or was
    // killed) and must not be reported as success, or a script would count a run killed mid-work
    // as a clean finish. Tear down so no orphan session is left, say so, and exit non-zero.
    await killSession(name, socket).catch(() => {});
    // One computation feeds both the banner and the return value — printing a
    // code the caller does not receive is the same defect in miniature.
    const exitCode = tmuxRunExitCode(after, false);
    // Two distinct causes reach here, and the banner must not assert the wrong
    // one: a pane we HAD (the session went away under it) versus a run whose
    // pane id tmux never reported at creation, which had nothing to read from.
    const cause = pane
      ? 'The tmux session went away before its exit status could be read, so this run may have been killed mid-work.'
      : 'This run had no readable tmux pane, so its exit status could never be read.';
    process.stderr.write(
      `\n${RED}agents: ${options.agent} outcome unknown (exit ${exitCode}).${OFF}\n` +
      `${GRAY}  ${cause}${OFF}\n` + NO_TMUX_TIP,
    );
    return { exitCode, stderr: '', stdout: '' };
  };

  // A native resume must not create a competing wrapper for a live session.
  // A retained dead pane is reaped before the harness resumes normally.
  const resumePrep = options.resume ? await prepareSessionForResume(name, socket) : { decision: 'create' as const };
  if (resumePrep.decision === 'attach') {
    if (options.sessionId) writeSessionAliasRecord(options.sessionId, name);
    await attachTmux({ socket, args: ['attach-session', '-t', name] });
    // EXEC-23b: a resume-attach is an attach like any other and must ask tmux what happened rather
    // than assume 0; it used to return a hardcoded success, so a resumed run whose server died
    // reported a clean finish.
    return resolveAfterAttach(resumePrep.pane);
  }

  // SessionStart learns some harness IDs only after launch. Carry the wrapper
  // name into that hook so it can bind both identities durably.
  const execEnv = { ...buildExecEnv(options), AGENT_TMUX_SESSION_NAME: name };
  // The pane sources its env from a 0600 file it unlinks before exec, so no resolved secret value
  // reaches the process table (RUSH-2100). SessionMeta.cmd keeps the value-redacted inline form,
  // the human-readable record of what ran, which never carried real values (RUSH-1758).
  const envFile = path.join(
    getRuntimeStateDir(), 'tmux-env', `${name}-${randomUUID().slice(0, 8)}.env`,
  );
  writeTmuxEnvFile(execEnv, envFile);
  let cmd = buildTmuxAgentCommand(executable, args, execEnv, { envFile });
  const leaseVersion = options.version ?? resolveVersion(options.agent, cwd);
  if (leaseVersion && isVersionInstalled(options.agent, leaseVersion)) {
    const leaseCli = getCliLaunch(['__launch-lease', options.agent, leaseVersion], getAgentsBinPath());
    // The pane outlives a detached launcher. Lease its own exec-replaced shell
    // before launching, so detaching cannot open an unprotected launch gap.
    cmd = `${[leaseCli.command, ...leaseCli.args].map(shellQuote).join(' ')} "$$" || exit 1; ${cmd}`;
  }
  const metaCmd = buildTmuxAgentCommand(executable, args, execEnv, { redactEnvValues: true });

  const labels: Record<string, string> = { agent: options.agent };
  // Only publish an id the harness actually received: createSession turns this label into the
  // `@ag_session_id` tmux option status bars read, and a launcher-internal id there looks
  // resumable while `ag focus <id>` rejects it.
  if (isHarnessKnownSessionId(options.agent, options.sessionId, options.resume)) {
    labels.sessionId = options.sessionId as string;
  }

  // Only a launched pane sources-and-unlinks the env file. If createSession throws the pane never
  // runs, so the resolved secrets (including the master passphrase) would linger on disk; remove
  // it on that path (RUSH-2100).
  let meta;
  try {
    meta = await createSession({ name, cmd, metaCmd, cwd, socket, source: 'cli', labels });
  } catch (err) {
    try { fs.rmSync(envFile, { force: true }); } catch { /* best-effort */ }
    throw err;
  }
  const pane = meta.pane;

  if (options.sessionId) writeSessionAliasRecord(options.sessionId, name);

  if (pane) {
    // When the agent pane dies, detach the client (not kill) so the session lives long enough to
    // read the dead pane's exit status.
    const hookInstalled = await setSessionHook(name, 'pane-died', agentPaneDiedHook(name, pane), socket);
    // Stamp the schema marker only after tmux accepted the hook. A failed
    // install stays unmarked so daemon reconciliation retries it later.
    if (hookInstalled) await markSessionHookSchema(name, socket);

    // Record the agent's OS pid (the pane leaf, thanks to `exec`) WITH its tmux
    // pane so the active-scan attributes it exactly and shows the %pane.
    let panePid = 0;
    try {
      const r = await runTmux({ socket, args: ['display-message', '-pt', pane, '-p', '#{pane_pid}'], throwOnError: false });
      panePid = parseInt(r.stdout.trim(), 10) || 0;
    } catch { /* best-effort */ }
    writePidSessionEntry({
      pid: panePid,
      agent: options.agent,
      harness: customHarnessName(options),
      sessionId: options.sessionId,
      cwd,
      actor: resolveActor().id,
      initiatedBy: resolveActor().kind,
      // spawnAgent injected AGENT_LAUNCH_ID into options.env before delegating here; record the
      // same id so the hook (under the pane-leaf agent pid) reconciles by launchId, which holds
      // even when this pane's pid is not the agent's.
      launchId: options.env?.AGENT_LAUNCH_ID,
      terminalId: launchIdentityEnv().AGENT_TERMINAL_ID,
      tmuxPane: pane,
      startedAtMs: Date.now(),
    });
    paneLaunchBinding = captureLaunchBinding(panePid, options.env?.AGENT_LAUNCH_ID ?? '');
    if (options.sessionId) {
      writeSessionActorRecord({
        sessionId: options.sessionId,
        actor: resolveActor().id,
        initiatedBy: resolveActor().kind,
        phoenixId: resolveActor().phoenixId,
        harness: customHarnessName(options),
        accountId: options.accountId,
        startedAtMs: Date.now(),
      });
    }
  }

  // The agent could exit before we attach (fast failure). Don't attach to an
  // already-dead pane — surface its output + status directly and tear down.
  const before = pane ? await paneExitStatus(pane, socket) : { found: false, dead: false, status: undefined };
  if (before.dead) {
    bindCompletedPane();
    // Positive proof of a genuinely completed pane — capture scrollback as
    // refusal evidence before tearing the session down (see the matching
    // comment in resolveAfterAttach).
    const tail = await capturePaneTail(pane);
    // F2 (RUSH-2185 / EXEC-23a): for interactive runs always recap, since a clean exit-0 before
    // attach means the harness has no REPL and the user would see a bare `[detached]`. For
    // headless runs exit-0 stays a quiet success.
    if (shouldRecapDeadPane(before.status, resolveInteractive(options))) {
      await surfacePaneFailure(pane, before.status, `${options.agent} exited before it could start`, tail);
    }
    await killSession(name, socket).catch(() => {});
    // A dead pane whose status tmux never reported is an UNKNOWN outcome, not a
    // success — and the banner one line up already printed `exit 1` for it, so
    // the old `?? 0` also made the message and the returned code disagree.
    return { exitCode: tmuxRunExitCode(before, false), stderr: '', stdout: tail };
  }

  await attachTmux({ socket, args: ['attach-session', '-t', name] });
  return resolveAfterAttach(pane);
}

/** Print the run's resolved session id as a one-line stdout sentinel so a `--device` launcher can
 * relate the remote session to itself. Claude's id was forced up front, so it is authoritative;
 * others are read from the hook index by launchId. No id found emits nothing, never a fake. */
function emitResolvedSessionId(options: ExecOptions, launchId: string, childPid: number | undefined): void {
  let sessionId = options.sessionId;
  if (!sessionId) {
    try {
      sessionId = resolveHookSessionId(loadHookSessionIndex(), {
        pid: childPid ?? 0,
        kind: options.agent,
        launchId,
      });
    } catch {
      /* hook index unreadable — emit nothing rather than a guess */
    }
  }
  if (sessionId) process.stdout.write(sessionIdMarkerLine(sessionId));
}

/** Spawn an agent process and return its exit code plus a tee'd copy of stderr. Stderr is always
 * piped so the caller can inspect it (e.g. rate-limit detection) while every chunk still reaches
 * process.stderr in real time. */
/** Inputs the pre-launch `run.launch` payload is built from. */
interface RunLaunchInput {
  agent: AgentId;
  harnessName?: string;
  /** The version being launched, or undefined when none could be resolved. */
  version?: string;
  strategy?: RunStrategy;
  /** Whether the launched version is launchable-signed-in on this device ({@link
   * isVersionLaunchableHere}). `null` when unknown; a missing verdict must not be read as logged
   * out. */
  signedIn: boolean | null;
  /** Account email of the version home when signed in, else null. */
  email: string | null;
  /** How the version was resolved (explicit-pin / rotated / pinned-default). */
  resolvedVia?: string;
}

/** Build the `run.launch` event payload; pure and exported so the signedIn to launchedLoggedOut
 * mapping is unit-testable. `launchedLoggedOut` is true only when `signedIn` resolved to false
 * (the yosemite-m3 2.1.219 incident); an unknown verdict (`null`) is never logged out. */
export function buildRunLaunchPayload(input: RunLaunchInput): EventPayload {
  return {
    module: 'run',
    agent: input.agent,
    ...(input.harnessName ? { harnessName: input.harnessName } : {}),
    // Omitted only when no version could be resolved at all — the typed `version`
    // field can't carry null, and an absent version is honest.
    version: input.version,
    strategy: input.strategy ?? null,
    signedIn: input.signedIn,
    launchedLoggedOut: input.signedIn === false,
    email: input.email,
    ...(input.resolvedVia ? { resolvedVia: input.resolvedVia } : {}),
  };
}

/** Primitives emitRunLaunch needs — kept narrow so BOTH live launch paths
 *  (spawnAgent and the Windows execShimPassthrough shim) share one emitter. */
interface RunLaunchContext {
  agent: AgentId;
  harnessName?: string;
  /** The version being launched, already resolved by the caller. */
  version: string | undefined;
  strategy?: RunStrategy;
  resolvedVia?: string;
  /** Precomputed launchable-signed-in verdict from a caller that has it (a rotated pick).
   * `undefined` triggers the {@link isVersionLaunchableHere} fallback; `null`/`boolean` are used
   * as-is. */
  launchSignedIn?: boolean | null;
  launchEmail?: string | null;
}

/** Emit the pre-launch `run.launch` observability event just before the harness child spawns.
 * Best-effort: it must never break a launch. `signedIn` is for this version on this device so
 * `launchedLoggedOut` catches logged-out launches; reused from ctx.launchSignedIn when given. */
async function emitRunLaunch(ctx: RunLaunchContext): Promise<void> {
  try {
    let signedIn: boolean | null;
    let email: string | null;
    if (ctx.launchSignedIn !== undefined) {
      // Caller already computed the verdict for this exact version via the same
      // gate — reuse it verbatim.
      signedIn = ctx.launchSignedIn;
      email = ctx.launchEmail ?? null;
    } else {
      // Pinned-default / shim paths: probe the version home now. Without a
      // concrete version we cannot probe, so leave the verdict unknown (null)
      // rather than guess.
      signedIn = null;
      email = null;
      if (ctx.version) {
        try {
          const { isVersionLaunchableHere } = await import('./accounting/rotate.js');
          const state = await isVersionLaunchableHere(ctx.agent, ctx.version);
          signedIn = state.launchable;
          email = state.email;
        } catch {
          /* probe unavailable — record the launch without the signed-in verdict */
        }
      }
    }
    emit('run.launch', buildRunLaunchPayload({
      agent: ctx.agent,
      harnessName: ctx.harnessName,
      version: ctx.version,
      strategy: ctx.strategy,
      signedIn,
      email,
      resolvedVia: ctx.resolvedVia,
    }));
  } catch {
    /* observability must never break a launch */
  }
}

async function spawnAgent(options: ExecOptions): Promise<SpawnResult> {
  if (options.agent === 'claude' && !options.resume && !options.sessionId) options = { ...options, sessionId: randomUUID() };
  const version = options.version ?? resolveVersion(options.agent, options.cwd || process.cwd());
  const home = resolveExecConfigHome(options).versionHome;
  const modelKey = claudeModelRefusalKey(options.accountId, home);
  const transcript = options.agent === 'claude' && home && options.sessionId
    ? path.join(home, '.claude', 'projects', claudeProjectDirName(options.cwd || process.cwd()), `${options.sessionId}.jsonl`)
    : undefined;
  let offset = transcript && fs.existsSync(transcript) ? fs.statSync(transcript).size : 0;
  const observeTranscript = () => {
    if (!transcript || !modelKey) return;
    try {
      const size = fs.statSync(transcript).size;
      if (size <= offset) return;
      const start = Math.max(offset, size - 64 * 1024);
      const fd = fs.openSync(transcript, 'r');
      const bytes = Buffer.alloc(size - start);
      try { fs.readSync(fd, bytes, 0, bytes.length, start); } finally { fs.closeSync(fd); }
      const text = bytes.toString('utf8');
      const lastNewline = text.lastIndexOf('\n');
      if (lastNewline < 0) return;
      offset = start + Buffer.byteLength(text.slice(0, lastNewline + 1));
      for (const line of text.slice(0, lastNewline).split('\n')) {
        try {
          const row = JSON.parse(line);
          if (row.type !== 'assistant') continue;
          const content = Array.isArray(row.message?.content) ? row.message.content.filter((block: { type?: string }) => block.type === 'text').map((block: { text?: string }) => block.text ?? '').join('\n') : '';
          const refusal = row.isApiErrorMessage ? parseClaudeModelRefusal(content) : null;
          if (refusal) noteClaudeModelRefusal(modelKey, refusal.family, { family: refusal.family });
          else if (!row.isApiErrorMessage && row.message?.model && content.trim()) clearClaudeModelRefusal(modelKey, row.message.model);
        } catch { /* Partial or non-message transcript rows provide no evidence. */ }
      }
    } catch { /* Transcript observation must not interrupt the harness. */ }
  };
  const observer = transcript ? setInterval(observeTranscript, 2_000) : undefined;
  observer?.unref();
  try {
    const observedOptions = options.agent === 'claude' ? { ...options, captureStdoutTail: true } : options;
    const result = !version || !isVersionInstalled(options.agent, version)
      ? await spawnAgentLeased(observedOptions)
      : await withInstallationLease(options.agent, version, () => spawnAgentLeased(observedOptions));
    observeTranscript();
    if (options.agent === 'claude' && modelKey) {
      const refusal = parseClaudeModelRefusal(`${result.stderr}\n${result.stdout}`);
      if (refusal) {
        noteClaudeModelRefusal(modelKey, refusal.family, { family: refusal.family });
        return { ...result, exitCode: result.exitCode || 1 };
      }
    }
    return result;
  } finally { if (observer) clearInterval(observer); }
}

async function spawnAgentLeased(options: ExecOptions): Promise<SpawnResult> {
  bootMark('spawn-agent:enter');
  // Assign a known session id up front for agents that accept one, so the launcher records an
  // exact pid-to-session mapping; otherwise headless `ag sessions --active` guesses "newest .jsonl
  // in the cwd" and collapses co-located agents. Claude:
  if (options.agent === 'claude' && !options.resume && !options.sessionId) {
    options = { ...options, sessionId: randomUUID() };
  }
  ensureVendorHomeForSpawn(options);
  // Record the run's --name against its session id (when both are known at
  // launch) so `agents sessions <name>` resolves it. Best-effort; unnamed runs
  // and agents whose id isn't known up front simply skip this.
  if (options.name && options.sessionId) {
    recordRunName({ sessionId: options.sessionId, name: options.name, agent: options.agent, cwd: options.cwd });
  }
  const cmd = buildExecCommand(options);
  const [executable, ...args] = cmd;

  const timeoutMs = options.timeout ? parseTimeout(options.timeout) : undefined;
  const piped = !process.stdout.isTTY;
  const interactive = resolveInteractive(options);

  // Fail loud before spawning a headless codex whose Linux sandbox cannot start, which burns a
  // turn and lands zero tools (PHNX-3285). Cheap check first so the userns probe (one `unshare`)
  // runs only for codex + Linux + headless + a sandboxed mode.
  if (options.agent === 'codex' && process.platform === 'linux' && !interactive) {
    const codexMode = options.mode ? normalizeMode(options.mode) : defaultModeFor(options.agent);
    if (codexMode !== 'skip') {
      const message = codexSandboxPreflight({
        agent: options.agent,
        platform: process.platform,
        interactive,
        mode: codexMode,
        userns: probeUnprivilegedUserns(),
        machine: machineId(),
      });
      if (message) {
        process.stderr.write(`\x1b[31m${message}\x1b[0m\n`);
        return { exitCode: 1, stdout: '', stderr: message };
      }
    }
  }

  // Fail loud before an interactive claude run on a worker with no synced credential falls to
  // Claude Code's "Select login method" screen, an OAuth that never persists on a headless box
  // (the 10-minute re-login loop, PHNX-3502 sibling).
  if (options.agent === 'claude') {
    const { versionHome } = resolveExecConfigHome(options);
    // A credential reaches the child if the worker setup-token resolves for the
    // selected account OR the caller passed an explicit --env override
    // (buildExecEnv merges options.env last, so it wins even the worker strip).
    const hasWorkerCredential =
      Boolean(options.env?.CLAUDE_CODE_OAUTH_TOKEN) ||
      (versionHome ? resolveClaudeSetupToken(versionHome) !== null : false);
    const loginTrap = claudeWorkerLoginTrapPreflight({
      agent: options.agent,
      interactive,
      deviceRole: selfConfiguredDeviceRole(),
      hasWorkerCredential,
      machine: machineId(),
    });
    if (loginTrap) {
      process.stderr.write(`\x1b[31m${loginTrap}\x1b[0m\n`);
      return { exitCode: 1, stdout: '', stderr: loginTrap };
    }
    // A credentialed run on a worker never needs Claude Code's first-run onboarding, and in a
    // provider (setup-token) launch's shared version home nothing else completes it: the tab
    // opened on the theme picker (yosemite-m1, 2026-09-28).
    if (hasWorkerCredential && versionHome && !isHeadedDeviceRole(selfConfiguredDeviceRole())) {
      seedClaudeWorkerHomeIdentity(versionHome);
    }
  }

  // Budget live kill-switch (issue #346): for headless runs parse stream-json usage off stdout
  // incrementally, accumulate cost, and kill the child when a cap is crossed, like --timeout but
  // with a distinct exit code so CI can tell budget-kill from timeout.
  const cwd = options.cwd || process.cwd();
  // Resolve the launch id once: it is the budget watcher's run id and AGENT_LAUNCH_ID, so the
  // SessionStart hook records the same id, reconciling the pid-registry entry under another pid.
  // A `--device` launcher's forwarded id is adopted so one key spans SSH (RUSH-2034); else mint.
  const launchId = resolveLaunchId(options.env?.AGENT_LAUNCH_ID);
  const runId = launchId;
  options = { ...options, env: { ...options.env, AGENT_LAUNCH_ID: launchId } };
  const watcherState = await setupBudgetWatcher(options, cwd, runId);

  const timer = createTimer('agent.run', {
    agent: options.agent,
    version: options.version,
    cwd: options.cwd || process.cwd(),
    // The mode that ran, not the one requested — `agents run` passes the
    // requested mode so the resolver can warn, but telemetry must agree with
    // the audit log. See RUSH-2106 for removing that ambiguity at the source.
    mode: resolveMode(options.agent, normalizeMode(options.mode)),
    model: options.model,
    interactive,
    sessionId: options.sessionId,
    ...redactPrompt(options.prompt),
    command: executable,
    args: redactArgs(args.slice(0, 10)),
  });

  // Interactive spawn-wrap: run the agent inside a shared-socket tmux session (then attach this
  // TTY) so it gets a unique addressable %pane. Opt-in via this device's tmux.enabled, local and
  // remote alike (PHNX-3316); a followed remote run left bare relies on reconnect-and-resume.
  const tmuxWrap = resolveTmuxWrap({
    interactive,
    platform: process.platform,
    inTmux: !!process.env.TMUX,
    raw: options.raw === true,
    noTmuxEnv: process.env.AGENTS_NO_TMUX === '1',
    configEnabled: isTmuxEnabled(),
    remoteDispatch: process.env[REMOTE_INTERACTIVE_ENV] === '1',
    tmuxAvailable: isTmuxInstalled(),
    hasTty: !!process.stdout.isTTY,
  });
  if (tmuxWrap.kind === 'undurable') {
    // Refuse rather than start work a blink would destroy. This is the only check:
    // `ensureHostReady` gates a `--device` dispatch on reachability and the pinned agent, not
    // tmux, and a pre-dispatch probe would only add a round trip per launch.
    const msg = `agents: ${machineId()} has no tmux, so this --device run cannot get the pane it needs.\n`
      + `  install it:              (apt|dnf|brew) install tmux\n`
      + `  or turn the wrap off:    agents ssh ${machineId()} 'agents devices config ${machineId()} tmux.enabled off'\n`
      + `  or accept a bare run:    agents run … --device ${machineId()} --raw\n`;
    process.stderr.write(`\x1b[31m${msg}\x1b[0m`);
    timer.end({ exitCode: 1, status: 'failed', error: 'remote interactive run has no tmux for durability' });
    return { exitCode: 1, stdout: '', stderr: msg };
  }

  // Pre-launch marker (`run.launch`) fired on this device just before the harness child spawns,
  // for tmux-wrapped and bare paths, after the undurable refusal. Unlike `run.dispatched` it
  // records a launch stuck at a login screen, so logged-out launches are visible.
  await emitRunLaunch({
    agent: options.agent,
    harnessName: options.harnessName,
    version: options.version ?? resolveVersion(options.agent, options.cwd || process.cwd()) ?? undefined,
    strategy: options.strategy,
    resolvedVia: options.resolvedVia,
    launchSignedIn: options.launchSignedIn,
    launchEmail: options.launchEmail,
  });

  if (tmuxWrap.kind === 'wrap') {
    timer.mark('startup');
    flushBootProfile('spawn');
    try {
      const result = await runInTmux(options, executable, args);
      timer.end({ exitCode: result.exitCode, status: result.exitCode === 0 ? 'success' : 'failed' });
      return result;
    } catch (err) {
      timer.end({ error: (err as Error).message, exitCode: -1, status: 'error' });
      throw err;
    }
  }

  return new Promise((resolve, reject) => {
    // Interactive mode inherits all stdio so the CLI owns the TTY. Headless pipes stderr to scan
    // for rate limits and feed fallback; stdout is inherited for a TTY, piped when the caller
    // pipes downstream, and tapped for every non-interactive capped run (shouldTapStdout, #346).
    const tapStdout = shouldTapStdout(interactive, piped, watcherState !== null, options.captureStdoutTail);
    const stdio: ('inherit' | 'pipe')[] = interactive
      ? ['inherit', 'inherit', 'inherit']
      : ['inherit', tapStdout ? 'pipe' : 'inherit', 'pipe'];

    // On Windows, `.cmd` batch wrappers (npm-installed CLIs) require shell:true. Then compose one
    // fully-quoted command line with an EMPTY args array (composeWin32CommandLine) so Node never
    // concatenates the prompt into the cmd.exe line unescaped (DEP0190, command injection).
    const useShell = process.platform === 'win32' && (
      !path.isAbsolute(executable) || executable.endsWith('.cmd')
    );
    const spawnCommand = useShell ? composeWin32CommandLine(executable, args) : executable;
    const spawnArgs = useShell ? [] : args;
    flushBootProfile('spawn');
    const child = spawn(spawnCommand, spawnArgs, {
      cwd: options.cwd || process.cwd(),
      stdio,
      env: buildExecEnv(options),
      shell: useShell,
    });

    // Record this launch so `ag sessions --active` maps the pid to its exact session instead of
    // guessing the newest .jsonl in the cwd, which made co-located agents indistinguishable.
    // Best-effort: pruned when the pid dies; a failed write degrades to the heuristic.
    writePidSessionEntry({
      pid: child.pid ?? 0,
      agent: options.agent,
      harness: customHarnessName(options),
      sessionId: options.sessionId,
      cwd: options.cwd || process.cwd(),
      actor: resolveActor().id,
      initiatedBy: resolveActor().kind,
      launchId,
      terminalId: launchIdentityEnv().AGENT_TERMINAL_ID,
      tmuxPane: process.env.TMUX_PANE,
      startedAtMs: Date.now(),
    });
    const launchBinding = captureLaunchBinding(child.pid, launchId);
    if (options.sessionId) {
      writeSessionActorRecord({
        sessionId: options.sessionId,
        actor: resolveActor().id,
        initiatedBy: resolveActor().kind,
        phoenixId: resolveActor().phoenixId,
        harness: customHarnessName(options),
        accountId: options.accountId,
        startedAtMs: Date.now(),
      });
    }

    // Mark startup time (time from function call to process spawn)
    timer.mark('startup');

    let budgetKilled = false;
    let budgetKillTimer: ReturnType<typeof setTimeout> | undefined;
    let stdoutTail = '';
    const STDOUT_TAIL_CAP = 16 * 1024;
    if (!interactive && tapStdout && child.stdout) {
      // TEE the child's stdout back to the parent's so the user still sees
      // output (mirrors stdio:'inherit') while we tap the same stream for usage.
      child.stdout.pipe(process.stdout);
      // Keep a rolling TAIL (billing refusals arrive at the very end of a run)
      // for the fallback chain's rate-limit scan.
      child.stdout.on('data', (chunk: Buffer) => {
        stdoutTail = (stdoutTail + chunk.toString('utf-8')).slice(-STDOUT_TAIL_CAP);
      });
      // Tap the same stream for budget usage events without consuming the pipe
      // (a 'data' listener and .pipe() both receive every chunk). Kill on breach.
      if (watcherState) {
        let pendingLine = '';
        child.stdout.on('data', (chunk: Buffer) => {
          const { events, rest } = watcherState.extract(chunk.toString('utf-8'), pendingLine);
          pendingLine = rest;
          for (const ev of events) watcherState.watcher.feedUsage(ev);
          if (watcherState.watcher.breached() && !budgetKilled) {
            budgetKilled = true;
            process.stderr.write(`[budget] hard cap exceeded — terminating ${options.agent} run\n`);
            child.kill('SIGTERM');
            budgetKillTimer = setTimeout(() => child.kill('SIGKILL'), 5000);
          }
        });
      }
    }

    let stderrBuffer = '';
    const STDERR_BUFFER_CAP = 64 * 1024;
    if (!interactive && child.stderr) {
      child.stderr.on('data', (chunk: Buffer) => {
        process.stderr.write(chunk);
        if (stderrBuffer.length < STDERR_BUFFER_CAP) {
          stderrBuffer += chunk.toString('utf-8');
          if (stderrBuffer.length > STDERR_BUFFER_CAP) {
            stderrBuffer = stderrBuffer.slice(-STDERR_BUFFER_CAP);
          }
        }
      });
    }

    let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
    if (timeoutMs) {
      timeoutTimer = setTimeout(() => {
        child.kill('SIGTERM');
        setTimeout(() => child.kill('SIGKILL'), 5000);
      }, timeoutMs);
    }

    child.on('error', (err) => {
      if (timeoutTimer) clearTimeout(timeoutTimer);
      timer.end({ error: err.message, exitCode: -1, status: 'error' });
      reject(err);
    });
    child.on('close', (code) => {
      recordCompletedLaunch(launchBinding);
      if (timeoutTimer) clearTimeout(timeoutTimer);
      // Clear the budget-kill SIGKILL escalation timer (mirror the --timeout
      // timer cleanup) so a programmatic caller reusing execAgent (the #332 loop
      // driver) never sees a stray 5s kill event fire after the child has exited.
      if (budgetKillTimer) clearTimeout(budgetKillTimer);
      // Record final spend to the shared ledger (issue #346). Best-effort: a
      // ledger write must never mask the run's own outcome.
      if (watcherState) {
        try { watcherState.finalize(); } catch { /* ledger write is non-critical */ }
        // Release the watcher's references / stop accepting events (symmetry).
        try { watcherState.watcher.dispose(); } catch { /* dispose is best-effort */ }
      }
      // Budget kill resolves with a DISTINCT non-zero exit so CI/headless and
      // teams/cloud can tell a budget termination apart from a normal failure.
      const exitCode = budgetKilled ? BUDGET_KILL_EXIT_CODE : (code ?? 0);
      // Relate the session id back to a `--device` launcher (see `emitSessionId`).
      if (options.emitSessionId) emitResolvedSessionId(options, launchId, child.pid);
      timer.end({ exitCode, status: budgetKilled ? 'budget_killed' : code === 0 ? 'success' : 'failed' });
      resolve({ exitCode, stderr: stderrBuffer, stdout: stdoutTail });
    });
  });
}

/** Exit code spawnAgent resolves with when a run is killed for crossing a budget cap. */
export const BUDGET_KILL_EXIT_CODE = 7;

/** Exit code a tmux-wrapped run resolves with when tmux cannot say how the agent finished (pane
 * unreadable, or dead with no status; EXEC-23b). Never 0: an unknown outcome reported as success
 * gets a run killed mid-work counted as a clean finish. */
export const UNKNOWN_OUTCOME_EXIT_CODE = 1;

/** Resolve the budget watcher for a run. Null (dormant) when no caps are configured, so non-budget
 * users pay nothing; otherwise a live watcher seeded with the day/project spend on the ledger,
 * plus a finalize() that appends this run's spend. */
async function setupBudgetWatcher(
  options: ExecOptions,
  cwd: string,
  runId: string,
): Promise<{
  watcher: import('./budget/enforce.js').LiveSpendWatcher;
  extract: (chunk: string, pending: string) => { events: import('./budget/enforce.js').UsageEvent[]; rest: string };
  finalize: () => void;
} | null> {
  const interactive = resolveInteractive(options);
  if (interactive) return null;
  const [{ resolveBudgetConfig, hasAnyCap }, { makeLiveSpendWatcher, capsFromConfig, extractUsageEvents }, ledger] =
    await Promise.all([
      import('./budget/config.js'),
      import('./budget/enforce.js'),
      import('./budget/ledger.js'),
    ]);
  const cfg = resolveBudgetConfig(cwd);
  if (!hasAnyCap(cfg)) return null;

  const today = ledger.localDay();
  const entries = ledger.loadLedger();
  const caps = capsFromConfig(cfg, {
    daySpend: ledger.spendForDay(today, entries),
    projectSpend: ledger.spendForProject(cwd, entries),
    agentDaySpend: { [options.agent]: ledger.spendForAgentDay(options.agent, today, entries) },
  });
  const watcher = makeLiveSpendWatcher({ caps, onBreach: () => { /* kill handled in stdout tap */ } });

  // Accumulate per-(model) usage for a clean final ledger record.
  const seen: Array<{ model: string; usage: import('./budget/ledger.js').UsageObservation }> = [];
  const model = options.model ?? `${options.agent}-default`;

  return {
    watcher,
    extract: (chunk: string, pending: string) => {
      const res = extractUsageEvents(chunk, pending, model, options.agent);
      for (const ev of res.events) {
        seen.push({
          model: ev.model ?? model,
          usage: {
            inputTokens: ev.inputTokens,
            outputTokens: ev.outputTokens,
            cacheReadTokens: ev.cacheReadTokens,
            cacheCreationTokens: ev.cacheCreationTokens,
          },
        });
      }
      return res;
    },
    finalize: () => {
      for (const s of seen) {
        ledger.recordSpend({
          runId,
          agent: options.agent,
          project: cwd,
          model: s.model,
          usage: s.usage,
          source: 'run',
        });
      }
    },
  };
}

/** Patterns indicating a rate/usage limit. Intentionally broad since providers phrase these
 * differently (Anthropic, OpenAI 429s, Google quota). False positives only trigger a fallback
 * attempt; false negatives leave the original error unhandled, which is worse. */
export const RATE_LIMIT_PATTERNS: RegExp[] = [
  /rate[\s-]?limit/i,
  /usage[\s-]?limit/i,
  /quota\s*(exceeded|reached|limit)/i,
  /\b429\b/,
  /5[\s-]?hour[\s-]?limit/i,
  /too many requests/i,
  /api[\s_-]?overloaded/i,
  /\boverloaded\b/i,
  // Claude billing refusals ("You've hit your org's monthly spend limit", "You're out of usage
  // credits") end the run with exit 1 and are what a fallback chain exists to recover from. They
  // print to stdout, hence the stdout tail in SpawnResult.
  /spend[\s-]?limit/i,
  /out of (?:usage )?credits/i,
];

/** Return true if the text contains any known rate-limit or overload indicator. */
export function detectRateLimit(text: string): boolean {
  return RATE_LIMIT_PATTERNS.some(pattern => pattern.test(text));
}

/** Narrow detector for billing exhaustion (tokens/credits out, or the monthly spend cap hit), as
 * opposed to a time-window rate limit. It does not recover on a clock, so rotation remembers it
 * per account (noteClaudeOutOfCredits) until a later successful run clears it. */
const OUT_OF_CREDITS_PATTERNS: RegExp[] = [
  /out of (?:usage )?credits/i,
  /spend[\s-]?limit/i,
];
export function detectOutOfCredits(text: string): boolean {
  return OUT_OF_CREDITS_PATTERNS.some(pattern => pattern.test(text));
}

/** Classify what a Claude run's output and exit code mean for the account's persisted refusal
 * marker. Pure and exported so the persist/clear decision is tested on the real path. */
type ClaudeRefusalAction =
  | { action: 'note_session'; resetsAt: Date }
  | { action: 'note_out_of_credits' }
  | { action: 'note_model_limit'; model: string; family: string }
  | { action: 'clear' }
  | { action: 'none' };

/** Classify a Claude run's output and exit code, model-limit refusal included. Precedence:
 * session-limit reset, clock-less billing exhaustion, then a model-specific refusal, checked
 * before the exit-0 clear so it never reads as a clean success clearing other stale markers. */
export function classifyClaudeRunRefusal(
  output: string,
  exitCode: number,
  model?: string,
): ClaudeRefusalAction {
  const sessionLimitReset = parseClaudeSessionLimitReset(output);
  if (sessionLimitReset) return { action: 'note_session', resetsAt: sessionLimitReset };
  if (detectOutOfCredits(output)) return { action: 'note_out_of_credits' };
  const modelRefusal = parseClaudeModelRefusal(output);
  if (modelRefusal) {
    return { action: 'note_model_limit', model: model ?? modelRefusal.family, family: modelRefusal.family };
  }
  if (exitCode === 0) return { action: 'clear' };
  return { action: 'none' };
}

/** Parse Codex's usage-limit reset (a dated or time-only `8:32 AM` for the 5-hour window). The
 * reset makes this a session-style limit that auto-clears, not clock-less billing exhaustion.
 * Ordinal suffixes are stripped for `Date.parse`. */
export function parseCodexUsageLimitReset(text: string, nowMs = Date.now()): Date | null {
  // Gate on the CLI's own refusal phrasing, not a bare "usage limit": this runs on a 16KB stdout
  // tail of `codex exec`, which streams the whole transcript, so a session discussing usage-limit
  // code would wrongly mark a healthy account excluded. Mirrors the narrow Claude convention.
  if (!/hit your usage limit/i.test(text)) return null;
  const match = /try again (?:at|on)\s+([^.\n]+)/i.exec(text);
  if (!match) return null;
  const segment = match[1].trim().replace(/(\d{1,2})(st|nd|rd|th)\b/gi, '$1');
  const absolute = Date.parse(segment);
  if (!Number.isNaN(absolute)) {
    // A full date parsed: honor it only while in the future; a past reset means the window already
    // recovered. Do not fall through to the clock path, which would understate the real date as
    // today/tomorrow.
    return absolute > nowMs ? new Date(absolute) : null;
  }
  // No date parsed — the 5-hour "try again at 8:32 AM" (time-only) form. Resolve
  // it against today, rolling to tomorrow when the clock has already passed.
  const clock = /(\d{1,2})(?::(\d{2}))?\s*(am|pm)/i.exec(segment);
  if (!clock) return null;
  let hour = Number(clock[1]) % 12;
  if (clock[3].toLowerCase() === 'pm') hour += 12;
  const minute = clock[2] ? Number(clock[2]) : 0;
  const result = new Date(nowMs);
  result.setHours(hour, minute, 0, 0);
  if (result.getTime() <= nowMs) result.setDate(result.getDate() + 1);
  return result;
}

/** Classify what a Codex run's output and exit code mean for the persisted refusal marker, the
 * sibling of {@link classifyClaudeRunRefusal}. Codex's usage limit is time-windowed with a reset,
 * so it is a clock-bearing session limit that auto-clears, not a sticky clock-less out_of_credits. */
export function classifyCodexRunRefusal(
  output: string,
  exitCode: number,
  nowMs = Date.now(),
): ClaudeRefusalAction {
  const reset = parseCodexUsageLimitReset(output, nowMs);
  if (reset) return { action: 'note_session', resetsAt: reset };
  if (detectOutOfCredits(output)) return { action: 'note_out_of_credits' };
  if (exitCode === 0) return { action: 'clear' };
  return { action: 'none' };
}

/** Patterns for an authentication failure (logged out, token revoked, session expired). Unlike a
 * rate limit, failover does not heal it (every chain entry on the account fails identically), so
 * it never triggers a fallback. */
const AUTH_FAILURE_PATTERNS: RegExp[] = [
  /OAuth (?:access token has been revoked|session expired)/i,
  /(?:Please run|run) \/login/i,
  /Please run 'agent login' first/i,
  /\bNot logged in\b/i,
  /Invalid authentication credentials/i,
  /Failed to authenticate/i,
  /organization has (?:disabled|revoked) .*(?:subscription|access)/i,
  /401\b[^\n]*(?:OAuth|authenticat|credential|Unauthorized)/i,
];

/** True if the text contains any known auth-failure indicator. Agent-agnostic: matches the
 * user-visible error wherever it surfaces (stdout tail, error message, plain-text agent output). */
export function detectAuthFailure(text: string): boolean {
  return AUTH_FAILURE_PATTERNS.some(pattern => pattern.test(text));
}

/** True if a stream-json log carries the structural markers of an auth failure, the authoritative
 * signal for Claude: `"error":"authentication_failed"` or a `result` with `is_error:true`.
 * `terminal_reason` reads completed, so exit codes miss it. Gated to Claude-compatible streams. */
export function detectAuthFailureEvent(logText: string, agent: AgentId): boolean {
  if (agent !== 'claude' && agent !== 'cursor') return false;
  const lines = logText.split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed[0] !== '{') continue;
    let parsed: any;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (parsed?.error === 'authentication_failed') return true;
    if (
      parsed?.type === 'result' &&
      parsed?.is_error === true &&
      typeof parsed?.result === 'string' &&
      detectAuthFailure(parsed.result)
    ) {
      return true;
    }
  }
  return false;
}

/** The first human-readable auth-failure phrase in the text, as a short stable run `errorMessage`
 * reason; null when the only signal was the structural `error:"authentication_failed"` marker. */
export function authFailureReason(text: string): string | null {
  for (const pattern of AUTH_FAILURE_PATTERNS) {
    const m = text.match(pattern);
    if (m) return m[0];
  }
  return null;
}

/** Decide whether a run's stream-json log is an auth failure; the single source of truth for
 * foreground and detached paths. The structural marker (`detectAuthFailureEvent`) is authoritative
 * on any exit, catching a logged-out Claude that exits 0. */
export function isAuthFailureFromLog(
  logText: string,
  agent: AgentId,
  opts: { processFailed: boolean },
): boolean {
  if (detectAuthFailureEvent(logText, agent)) return true;
  if (opts.processFailed && detectAuthFailure(logText)) return true;
  return false;
}

/** An agent (with optional pinned version) in a fallback chain. */
export interface FallbackEntry {
  agent: AgentId;
  /** Optional pinned version (e.g. '0.116.0'). When set, takes precedence over the active default. */
  version?: string;
  /** Env vars merged over options.env for this attempt only. Used by profiles with `fallback_model`
   * to swap the model env key (e.g. ANTHROPIC_MODEL) on a same-agent retry without touching auth
   * or base URL. */
  envOverride?: Record<string, string>;
}

/** ExecOptions extended with a fallback chain for rate-limit cascading. */
interface FallbackOptions extends ExecOptions {
  /** Ordered list of agents to try if the primary (options.agent) hits a rate limit. */
  fallback: FallbackEntry[];
  /** Fallback requires a prompt -- chain handoff doesn't apply to interactive sessions. */
  prompt: string;
  /** Out-param the caller reads after the call to learn which chain entry executed, updated as each
   * is attempted, so the audit log records the fallback that really ran, not always the primary
   * (issue #347). */
  dispatchSink?: { agent?: AgentId; version?: string };
}

/** Build the prompt for the fallback agent when the primary was stopped mid-task by a rate limit.
 * A Claude primary has a pinned `--session-id`, so the prompt uses `/continue <id>`; other
 * primaries get a retry-with-context prompt pointing at `agents sessions <id>`. */
export function buildFallbackPrompt(
  prevAgent: AgentId,
  prevSessionId: string | undefined,
  nextAgent: AgentId,
  originalPrompt: string,
): string {
  if (nextAgent === 'claude' && prevSessionId) {
    return `/continue ${prevSessionId}`;
  }
  const lines: string[] = [
    `The previous ${prevAgent} session was interrupted by a rate limit.`,
  ];
  if (prevSessionId) {
    lines.push(
      ``,
      `Prior session ID: ${prevSessionId}`,
      `Read the transcript by running: agents sessions ${prevSessionId}`,
    );
  }
  lines.push(
    ``,
    `Original request: ${originalPrompt}`,
    ``,
    `Continue from where the prior agent left off.`,
  );
  return lines.join('\n');
}

/** Run an agent and cascade through the fallback chain on rate-limit failure. The primary gets the
 * original prompt; later agents get a `/continue <id>` handoff when a session id can be pinned
 * (Claude as primary), else the original prompt plus a retry-with-context note. */
export async function runWithFallback(options: FallbackOptions): Promise<number> {
  const chain: FallbackEntry[] = [
    { agent: options.agent, version: options.version },
    ...options.fallback,
  ];
  let prevAgent: AgentId | undefined;
  let prevSessionId: string | undefined;

  // Workflow capability scoping only works on claude (buildExecCommand guards
  // `--tools`/`--mcp-config`/`--strict-mcp-config` on agent==='claude'). A fallback to another
  // agent drops the sandbox, so warn loudly (issue #324 fail-open).
  const scopingActive = (options.toolsRestrict && options.toolsRestrict.length > 0)
    || !!options.mcpConfigPath;
  if (scopingActive) {
    const unscoped = options.fallback.filter(f => f.agent !== 'claude').map(f => f.agent);
    if (unscoped.length > 0) {
      process.stderr.write(
        `[agents] WARNING: workflow tool/MCP scoping is enforced on claude only. ` +
        `Fallback agent(s) ${[...new Set(unscoped)].join(', ')} would run UNSCOPED ` +
        `(no --tools / --strict-mcp-config restriction) if claude hits a rate limit.\n`,
      );
    }
  }

  for (let i = 0; i < chain.length; i++) {
    const { agent, version, envOverride } = chain[i];
    // Every fallback entry can target a different harness/version home. Sync
    // its active preset immediately before dispatch so entries 2..N cannot
    // inherit the stale rules file left by the primary entry.
    const rulesVersion = version ?? resolveVersion(agent);
    if (rulesVersion) {
      applyActiveRulesPresetAtRun(agent, rulesVersion, getVersionHomePath(agent, rulesVersion));
      applySystemResourcesAtRun(agent, rulesVersion, getVersionHomePath(agent, rulesVersion));
    }
    // Record the entry we're about to attempt so the caller (audit log) sees the
    // agent+version that actually ran, even after a rate-limit handoff.
    if (options.dispatchSink) { options.dispatchSink.agent = agent; options.dispatchSink.version = version; }
    const pinnedSessionId = agent === 'claude' ? randomUUID() : undefined;

    // Same-host retry (same agent+version as previous entry — used by profile
    // `fallback_model` swaps) keeps the original prompt: the model changed,
    // not the CLI, so a `/continue` handoff prompt would be misleading.
    const prev = i > 0 ? chain[i - 1] : undefined;
    const sameHostRetry = !!prev && prev.agent === agent && prev.version === version;
    const prompt = prevAgent && !sameHostRetry
      ? buildFallbackPrompt(prevAgent, prevSessionId, agent, options.prompt)
      : options.prompt;

    const execOpts: ExecOptions = {
      ...options,
      agent,
      version,
      mode: options.modeWasImplicit ? implicitModeFor(agent) : options.mode,
      prompt,
      env: envOverride ? { ...(options.env ?? {}), ...envOverride } : options.env,
      sessionId: pinnedSessionId ?? (i === 0 ? options.sessionId : undefined),
      // Claude prints billing refusals (spend limit / out of credits) to
      // stdout; tail it so the cascade check below can see them.
      captureStdoutTail: true,
    };

    const label = version ? `${agent}@${version}` : agent;
    const modelSwapNote = sameHostRetry && envOverride
      ? ` (retry with ${Object.entries(envOverride).map(([k, v]) => `${k}=${v}`).join(', ')})`
      : '';
    const banner = i === 0
      ? `[agents] running ${label}`
      : sameHostRetry
        ? `[agents] retry → ${label}${modelSwapNote}`
        : `[agents] fallback → ${label}`;
    process.stderr.write(`${banner}${pinnedSessionId ? ` (session ${pinnedSessionId.slice(0, 8)})` : ''}\n`);

    let result: SpawnResult;
    try {
      result = await spawnAgent(execOpts);
    } catch (err: any) {
      if (err.code === 'ENOENT' && i > 0) {
        process.stderr.write(`[agents] ${label} not installed, skipping\n`);
        continue;
      }
      throw err;
    }

    const output = `${result.stderr}\n${result.stdout}`;
    // Persist a per-account refusal marker so rotation stops re-picking a dead account: a
    // session/usage limit recovers on its clock, a billing exhaustion only on a later successful
    // run, and a clean run clears a stale marker.
    const refusal =
      agent === 'claude'
        ? classifyClaudeRunRefusal(output, result.exitCode ?? 1, execOpts.model)
        : agent === 'codex'
          ? classifyCodexRunRefusal(output, result.exitCode ?? 1)
          : null;
    const sessionLimitReset =
      refusal?.action === 'note_session' ? refusal.resetsAt : null;
    if (refusal && version && refusal.action !== 'none') {
      // Resolve the account from the HOME this attempt authenticated from: execHome (a slot dir,
      // PHNX-3940 T5) or configVersion wins over the managed-binary version home.
      const { versionHome: refusalHome } = resolveExecConfigHome(execOpts);
      const account = await getAccountInfo(agent, refusalHome ?? getVersionHomePath(agent, version));
      const usageKey = getUsageLookupKey(account);
      if (usageKey && refusal.action !== 'note_model_limit') {
        if (refusal.action === 'note_session') noteClaudeSessionLimit(usageKey, refusal.resetsAt);
        else if (refusal.action === 'note_out_of_credits') noteClaudeOutOfCredits(usageKey);
        else if (refusal.action === 'clear' && !resolveInteractive(execOpts)) clearClaudeAccountRefusal(usageKey);
      }
    }

    // A model-limit refusal commonly ends the CLI turn with exit 0 (Claude just refuses to
    // continue on that model), so like a session-limit reset it must not be read as a clean
    // success that short-circuits the cascade before the fallback chain runs.
    const modelLimited = refusal?.action === 'note_model_limit';
    if (result.exitCode === 0 && !sessionLimitReset && !modelLimited) return 0;

    const isLast = i === chain.length - 1;
    if (isLast) return result.exitCode || 1;

    if (!sessionLimitReset && !modelLimited && !detectRateLimit(result.stderr) && !detectRateLimit(result.stdout)) {
      return result.exitCode;
    }

    const next = chain[i + 1];
    const nextLabel = next.version ? `${next.agent}@${next.version}` : next.agent;
    const nextSameHost = next.agent === agent && next.version === version;
    const handoffVerb = nextSameHost ? 'Retrying on same host' : 'Handing off';
    process.stderr.write(`[agents] ${label} hit rate limit. ${handoffVerb} to ${nextLabel}...\n`);
    prevAgent = agent;
    prevSessionId = pinnedSessionId;
  }

  return 1;
}
