import { captureLaunchBinding, recordCompletedLaunch } from './session/hook-sessions.js';
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
import { launchIdentityEnv, launchOrigin, LAUNCH_IDENTITY_KEYS } from './launch-identity.js';
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

export type ExecMode = Mode;

export function normalizeMode(input: string | null | undefined): Mode {
  if (!input) {
    throw new Error(`Mode is required. Use one of: ${ALL_MODES.join(', ')}.`);
  }
  const v = input.trim().toLowerCase();
  if (v === 'full') return 'skip';
  if ((ALL_MODES as readonly string[]).includes(v)) return v as Mode;
  throw new Error(`Invalid mode '${input}'. Use one of: ${ALL_MODES.join(', ')} (or 'full' as a deprecated alias for 'skip').`);
}

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

export function resolveMode(agent: AgentId, requested: Mode): Mode {
  const supported = AGENTS[agent].capabilities.modes;
  if (supported.includes(requested)) return requested;

  if (requested === 'auto') {
    return 'edit';
  }

  if (requested === 'plan') {
    return supported[0];
  }

  throw new Error(
    `${agent} does not support '${requested}' mode. Supported modes: ${supported.join(', ')}.`,
  );
}

/**
 * Resolve a requested mode for a run, honoring whether the run is HEADLESS.
 *
 * Wraps resolveMode with one extra rule: an agent may list `plan` in its modes
 * (so interactive plan works) yet declare `capabilities.headlessPlan === false`
 * because plan is broken in a headless `--prompt`/`-p` run — kimi refuses
 * `--prompt` + `--plan`, and grok's `--permission-mode plan` silently stalls at
 * its ExitPlanMode gate. For those agents, a headless plan request degrades to
 * `auto` (kimi -p auto-runs; grok maps auto→edit via resolveMode) with a visible
 * one-line stderr warning, mirroring the graceful plan→edit degrade antigravity
 * get for having no plan flag at all. Interactive runs are never
 * downgraded. This is the single source of truth shared by buildExecCommand
 * (agents run / teams) and the routine runner.
 */
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
  emitted?: Set<AgentId>;
  quiet?: boolean;
}

export function defaultModeFor(agent: AgentId): Mode {
  return AGENTS[agent].capabilities.modes[0];
}

export function implicitModeFor(agent: AgentId): ExecMode {
  return agent === 'codex' ? 'edit' : 'plan';
}

/**
 * Preflight for Codex's Linux sandbox. Codex ≥0.146 sandboxes `read-only` and
 * `workspace-write` runs with a bundled bubblewrap that needs an unprivileged
 * user namespace; on a box that restricts it (Ubuntu 24.04
 * `apparmor_restrict_unprivileged_userns=1`) bwrap dies with "setting up uid map:
 * Permission denied" and a HEADLESS codex run lands zero tools — no file writes,
 * no shell — while still reporting a completed turn. That silent under-delivery
 * is what breaks `agents teams` codex teammates (always headless + workspace-write)
 * and headless `agents run codex` alike on the fleet. Returns a loud, actionable
 * message to fail the launch with instead of spawning that doomed run; returns
 * null when the run is fine to proceed.
 *
 * Deliberately scoped: only `codex`, only Linux, only a HEADLESS run (an
 * interactive TUI surfaces the bwrap error to the operator itself), and only a
 * SANDBOXED mode — `skip` is codex `--dangerously-bypass-approvals-and-sandbox`,
 * which uses no bwrap and is unaffected. The intended auto=workspace-write config
 * is never weakened here; the run fails loud rather than silently downgrading.
 * PHNX-3285.
 */
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

export type ExecEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'auto';

export interface ExecOptions {
  agent: AgentId;
  harnessName?: string;
  version?: string;
  configVersion?: string;
  execHome?: string;
  prompt?: string;
  interactive?: boolean;
  mode: ExecMode;
  modeWasImplicit?: boolean;
  effort: ExecEffort;
  cwd?: string;
  headless?: boolean;
  modeWarningContext?: string;
  modeWarningState?: ModeWarningState;
  json?: boolean;
  model?: string;
  addDirs?: string[];
  timeout?: string;
  sessionId?: string;
  name?: string;
  resume?: boolean;
  verbose?: boolean;
  env?: Record<string, string>;
  toolsRestrict?: string[];
  mcpConfigPath?: string;
  passthroughArgs?: string[];
  captureStdoutTail?: boolean;
  emitSessionId?: boolean;
  raw?: boolean;
  strategy?: RunStrategy;
  resolvedVia?: string;
  launchSignedIn?: boolean | null;
  launchEmail?: string | null;
  accountId?: string;
}

export function stampedAgentName(options: Pick<ExecOptions, 'agent' | 'harnessName'>): string {
  const harness = options.harnessName?.trim();
  return harness || options.agent;
}

export function customHarnessName(options: Pick<ExecOptions, 'agent' | 'harnessName'>): string | undefined {
  const harness = options.harnessName?.trim();
  if (!harness || harness === options.agent) return undefined;
  return harness;
}

export function resolveInteractive(
  options: Pick<ExecOptions, 'interactive' | 'headless' | 'prompt'>,
): boolean {
  if (options.interactive === true) return true;
  if (options.headless === true) return false;
  return options.prompt === undefined;
}

export function inferredInteractiveWithoutTty(
  options: Pick<ExecOptions, 'interactive' | 'headless' | 'prompt'>,
  isTty: boolean,
): boolean {
  if (options.interactive === true) return false;
  return resolveInteractive(options) && !isTty;
}

export function shouldTapStdout(interactive: boolean, piped: boolean, capsActive: boolean, captureTail = false): boolean {
  if (interactive) return false;
  return piped || capsActive || captureTail;
}

const EXEC_ENV_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

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

export function parseExecEnv(entries: string[]): Record<string, string> | undefined {
  if (entries.length === 0) {
    return undefined;
  }

  return Object.fromEntries(entries.map(parseExecEnvEntry));
}

export function resolveLaunchId(envLaunchId: string | undefined): string {
  const inbound = envLaunchId?.trim();
  return inbound ? inbound : randomUUID();
}

// Child runs shed parent session/mailbox/account/exec-home identity; lineage is reintroduced only through explicit parent fields.
export function buildExecEnv(options: ExecOptions): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = { ...sanitizeProcessEnv(process.env) };

  const configAdapter = resolveHarnessAdapter(options.agent);
  if (configAdapter.applyExecConfigEnv) {
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

  delete result.AGENT_SESSION_ID;
  delete result.AGENTS_SESSION_ID;
  delete result.AGENTS_MAILBOX_DIR;
  delete result.AGENT_TERMINAL_ID;
  const launchIdentity = launchIdentityEnv();
  Object.assign(result, launchIdentity);

  if (options.sessionId && isValidMailboxId(options.sessionId)) {
    result.AGENTS_MAILBOX_DIR = mailboxDir(options.sessionId);
    result.AGENT_SESSION_ID = options.sessionId;
    result.AGENTS_SESSION_ID = options.sessionId;
  }
  delete result.AGENTS_PARENT_SESSION_ID;
  const spawnerSessionId = launchIdentity.AGENTS_PARENT_SESSION_ID;
  if (spawnerSessionId && spawnerSessionId !== options.sessionId) {
    result.AGENTS_PARENT_SESSION_ID = spawnerSessionId;
  }
  result.AGENTS_RUNTIME = resolveInteractive(options) ? 'terminal' : 'headless';
  // Bind the standalone secrets client to the same store agents-cli resolved.
  result.SECRETS_HOME = result.SECRETS_HOME ?? getUserAgentsDir();
  result.AGENTS_RUN_MODE = resolveHeadlessMode(
    options.agent,
    normalizeMode(options.mode),
    resolveInteractive(options),
    options.modeWarningContext,
    options.modeWarningState,
  );
  result.AGENTS_HISTORY_DIR = getHistoryDir();
  if (options.agent) {
    const runVersion = options.version ?? resolveVersion(options.agent, options.cwd || process.cwd());
    if (runVersion) result.AGENTS_RUN_VERSION = runVersion;
  }
  if (options.agent) {
    result.AGENTS_AGENT_NAME = stampedAgentName(options);
  }
  if (options.cwd) {
    result.AGENTS_CWD = options.cwd;
  }

  if (options.execHome) {
    result.AGENTS_EXEC_HOME = options.execHome;
  } else {
    delete result.AGENTS_EXEC_HOME;
  }

  if (options.accountId) {
    result.AGENTS_RUN_ACCOUNT_ID = options.accountId;
  } else {
    delete result.AGENTS_RUN_ACCOUNT_ID;
  }

  if (options.name) {
    result.AGENT_SESSION_NAME = options.name;
  }

  Object.assign(result, actorEnv(resolveActor()));

  return {
    ...result,
    ...options.env,
  };
}

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


interface AgentCommandTemplate {
  base: string[];
  promptFlag: 'positional' | string;
  modeFlags: Partial<Record<Mode, string[]>>;
  jsonFlags?: string[];
  modelFlag?: string;
  printFlags?: string[];
  verboseFlag?: string;
  resume?: (
    { flag: string; interactiveFlag?: string; headlessFlag?: string } |
    { subcommand: string }
  ) & { since?: string };
}

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
      plan: [],
      edit: [],
      auto: [],
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
      edit: [],
    },
  },
  // TODO: --output-format json is documented but currently broken upstream
  antigravity: {
    base: ['agy'],
    promptFlag: 'positional',
    modeFlags: {
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
  droid: {
    base: ['droid', 'exec'],
    promptFlag: 'positional',
    modeFlags: {
      plan: [],
      edit: ['--auto', 'low'],
      auto: ['--auto', 'high'],
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
    resume: { flag: '--session-id' },
  },
  warp: {
    base: ['warp'],
    promptFlag: 'positional',
    modeFlags: {
      edit: [],
    },
  },
};

export function nativeResume(agent: AgentId, version?: string): boolean {
  const resume = AGENT_COMMANDS[agent]?.resume;
  if (!resume) return false;
  if (!resume.since) return true;
  return !!version && compareVersions(installedReleaseFor(agent, version), resume.since) >= 0;
}

export function codexWritableRootsConfig(dir: string): string {
  return `sandbox_workspace_write.writable_roots=[${JSON.stringify(dir)}]`;
}

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
  return findInPath(command, { shimsDir: path.join(getShimsDir(), '.no-such-dir') });
}

export function buildExecCommand(options: ExecOptions): string[] {
  const template = AGENT_COMMANDS[options.agent];
  const cmd: string[] = [...template.base];
  const interactive = resolveInteractive(options);

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

  const resumeSpec = options.resume ? template.resume : undefined;
  let museInteractiveResumeDone = false;
  if (options.agent === 'muse' && options.resume && interactive && options.sessionId) {
    cmd.push('resume', options.sessionId);
    museInteractiveResumeDone = true;
  } else if (resumeSpec && 'subcommand' in resumeSpec) {
    cmd.push(resumeSpec.subcommand);
  }

  if (options.version && cmd.length > 0) {
    const versionedName = `${cmd[0]}@${options.version}`;
    const absPath = path.join(getShimsDir(), versionedName);
    if (process.platform === 'win32' && fs.existsSync(absPath + '.cmd')) {
      cmd[0] = absPath + '.cmd';
    } else if (fs.existsSync(absPath)) {
      cmd[0] = absPath;
    } else {
      const realBinary = options.agent ? getBinaryPath(options.agent, options.version) : undefined;
      cmd[0] = realBinary && fs.existsSync(realBinary) ? realBinary : versionedName;
    }
  }

  const effectiveModel = options.model
    ?? (options.agent === 'codex' ? readCodexConfiguredModel() : undefined)
    ?? (options.agent === 'opencode' ? options.env?.OPENCODE_MODEL : undefined);
  const modelVersion = effectiveModel && template.modelFlag
    ? (options.version || resolveVersion(options.agent, options.cwd || process.cwd()))
    : null;
  const tierResolved = effectiveModel && modelVersion && isTierToken(effectiveModel)
    ? resolveTier(options.agent, modelVersion, effectiveModel)
    : null;
  const effortLevel = options.effort !== 'auto' ? options.effort : (tierResolved?.effort ?? options.effort);

  if (effortLevel !== 'auto') {
    const reasoningFlags = buildReasoningFlags(options.agent, effortLevel);
    if (reasoningFlags.length > 0) {
      if (options.agent === 'codex') {
        cmd.splice(1, 0, ...reasoningFlags);
      } else {
        cmd.push(...reasoningFlags);
      }
    }
  }

  const resolvedMode = resolveHeadlessMode(
    options.agent,
    normalizeMode(options.mode),
    interactive,
    options.modeWarningContext,
    options.modeWarningState,
  );
  const modeFlags = template.modeFlags[resolvedMode];
  if (!modeFlags) {
    throw new Error(
      `Internal error: ${options.agent} declares '${resolvedMode}' in capabilities.modes but has no entry in AGENT_COMMANDS.modeFlags.${resolvedMode}.`,
    );
  }
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
      cmd.push('--dangerously-bypass-approvals-and-sandbox');
    } else if (interactive) {
      cmd.push(...modeFlags);
    } else {
      cmd.push(...modeFlags);
    }
  } else {
    cmd.push(...modeFlags);
  }

  if (!interactive && template.printFlags) {
    cmd.push(...template.printFlags);
  }

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

  if (effectiveModel && template.modelFlag) {
    if (tierResolved) {
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
      process.stderr.write(`[agents] cannot resolve tier "${effectiveModel}" without a version; using harness default\n`);
    }
  }

  if (options.json && template.jsonFlags) {
    cmd.push(...template.jsonFlags);
  }

  if (options.verbose && template.verboseFlag) {
    if (!(options.json && template.jsonFlags?.includes(template.verboseFlag))) {
      cmd.push(template.verboseFlag);
    }
  }

  if (options.prompt !== undefined) {
    if (interactive && options.agent === 'opencode') {
      cmd.push('--prompt', options.prompt);
    } else if (interactive && options.agent === 'claude') {
      cmd.push(options.prompt);
    } else if (template.promptFlag === 'positional') {
      cmd.push(options.prompt);
    } else {
      cmd.push(template.promptFlag, options.prompt);
    }
  }

  applyAddDirs(options.agent, cmd, options.addDirs, {
    cwd: options.cwd ?? process.cwd(),
  });

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

  if (options.passthroughArgs && options.passthroughArgs.length > 0) {
    cmd.push(...options.passthroughArgs);
  }

  return cmd;
}

export async function execAgent(options: ExecOptions): Promise<number> {
  const { exitCode } = await spawnAgent(options);
  return exitCode;
}

export function resolveShimSpawn(
  platform: NodeJS.Platform,
  binary: string,
  extraArgs: string[],
): { command: string; args: string[]; shell: boolean } {
  if (platform === 'win32') {
    const useShell = !path.win32.isAbsolute(binary) || binary.endsWith('.cmd');
    if (useShell) {
      return { command: composeWin32CommandLine(binary, extraArgs), args: [], shell: true };
    }
    return { command: binary, args: extraArgs, shell: false };
  }
  return { command: binary, args: extraArgs, shell: false };
}

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
    const cmdPath = binary + '.cmd';
    if (fs.existsSync(cmdPath)) binary = cmdPath;
  }

  const launchArgs = agent === 'codex'
    ? ['-c', 'check_for_update_on_startup=false', ...codexPolicyArgs('edit', codexEditWritableRoots(cwd))]
    : [];
  const launchId = randomUUID();
  const env = buildExecEnv({ agent, version, cwd, mode: defaultModeFor(agent), effort: 'auto', env: { AGENT_LAUNCH_ID: launchId } });
  ensureVendorHomeDir(agent, getVersionHomePath(agent, version));
  const { command, args, shell } = resolveShimSpawn(process.platform, binary, [...launchArgs, ...rawArgs]);

  await emitRunLaunch({ agent, version, resolvedVia: 'shim' });

  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd, stdio: 'inherit', env, shell });
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
        originTerminal: launchOrigin(),
        startedAtMs: Date.now(),
      });
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

interface SpawnResult {
  exitCode: number;
  stderr: string;
  stdout: string;
}

export function shouldRecapDeadPane(status: number | undefined, interactive: boolean): boolean {
  return (status ?? 0) !== 0 || interactive;
}

export function tmuxRunExitCode(
  pane: { dead: boolean; status?: number },
  knownAlive: boolean,
): number {
  if (knownAlive) return 0;
  if (pane.dead && pane.status !== undefined) return pane.status;
  return UNKNOWN_OUTCOME_EXIT_CODE;
}

export function isPaneKnownAliveFromQueryResult(code: number, stdout: string): boolean {
  return code === 0 && stdout.trim() === '0';
}

export interface TmuxWrapContext {
  interactive: boolean;
  platform: NodeJS.Platform;
  inTmux: boolean;
  raw: boolean;
  noTmuxEnv: boolean;
  configEnabled: boolean;
  remoteDispatch: boolean;
  tmuxAvailable: boolean;
  hasTty: boolean;
}

type TmuxWrapDecision =
  | { kind: 'wrap' }
  | { kind: 'bare' }
  | { kind: 'undurable' };

export function resolveTmuxWrap(ctx: TmuxWrapContext): TmuxWrapDecision {
  if (!ctx.interactive) return { kind: 'bare' };
  if (ctx.platform === 'win32') return { kind: 'bare' };
  if (ctx.inTmux) return { kind: 'bare' };
  if (ctx.raw) return { kind: 'bare' };
  if (ctx.noTmuxEnv) return { kind: 'bare' };
  if (!ctx.hasTty && !ctx.remoteDispatch) return { kind: 'bare' };
  if (!ctx.configEnabled && !(ctx.remoteDispatch && !ctx.hasTty)) return { kind: 'bare' };
  if (!ctx.tmuxAvailable) return ctx.remoteDispatch ? { kind: 'undurable' } : { kind: 'bare' };
  return { kind: 'wrap' };
}

export function isHarnessKnownSessionId(
  agent: AgentId,
  sessionId: string | undefined,
  resume: boolean | undefined,
): boolean {
  if (!sessionId) return false;
  if (resume && AGENT_COMMANDS[agent]?.resume) return true;
  return agent === 'claude';
}

// Resolved env values never enter tmux argv/metadata; source an exclusive 0600 file, unlink it, and abort if sourcing fails.
export function buildTmuxAgentCommand(
  executable: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  opts: { redactEnvValues?: boolean; envFile?: string } = {},
): string {
  const agentCmd = [executable, ...args].map(shellQuote).join(' ');
  const absentIdentity = LAUNCH_IDENTITY_KEYS.filter(key => env[key] === undefined);
  if (opts.envFile) {
    const f = shellQuote(opts.envFile);
    return `${absentIdentity.length ? `unset ${absentIdentity.join(' ')}; ` : ''}set -a; . ${f}; __agents_rc=$?; set +a; rm -f ${f}; [ "$__agents_rc" -eq 0 ] || exit 1; exec ${agentCmd}`;
  }
  const envPrefix = Object.entries(env)
    .filter(([k, v]) => v !== undefined && EXEC_ENV_KEY_PATTERN.test(k))
    .map(([k, v]) => `${k}=${opts.redactEnvValues ? '<redacted>' : shellQuote(String(v))}`)
    .join(' ');
  return `exec env ${absentIdentity.map(key => `-u ${key}`).join(' ')} ${envPrefix} ${agentCmd}`;
}

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

export function formatPaneTail(raw: string, maxLines = 30): string {
  return raw
    .split('\n')
    .map(l => l.replace(/\s+$/, ''))
    .filter(l => l.length > 0)
    .slice(-maxLines)
    .join('\n');
}

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

  const capturePaneTail = async (pane: string | undefined): Promise<string> => {
    if (!pane) return '';
    try {
      const r = await runTmux({ socket, args: ['capture-pane', '-p', '-t', pane, '-S', '-200'], throwOnError: false });
      return r.code === 0 ? formatPaneTail(r.stdout) : '';
    } catch {
      return '';
    }
  };

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

  const checkPaneKnownAlive = async (p: string): Promise<boolean> => {
    try {
      const r = await runTmux({ socket, args: ['display-message', '-pt', p, '-p', '#{pane_dead}'], throwOnError: false });
      return isPaneKnownAliveFromQueryResult(r.code, r.stdout);
    } catch { return false; }
  };

  let paneLaunchBinding: ReturnType<typeof captureLaunchBinding>;
  const bindCompletedPane = () => {
    recordCompletedLaunch(paneLaunchBinding);
  };
  const resolveAfterAttach = async (pane: string | undefined): Promise<{ exitCode: number; stderr: string; stdout: string }> => {
    const after = pane ? await paneExitStatus(pane, socket) : { found: false, dead: false, status: undefined };
    if (after.dead) {
      bindCompletedPane();
      const tail = await capturePaneTail(pane);
      if (shouldRecapDeadPane(after.status, resolveInteractive(options))) {
        await surfacePaneFailure(pane, after.status, `${options.agent} exited`, tail);
      }
      await killSession(name, socket).catch(() => {});
      return { exitCode: tmuxRunExitCode(after, false), stderr: '', stdout: tail };
    }
    if (pane && await checkPaneKnownAlive(pane)) {
      return { exitCode: tmuxRunExitCode(after, true), stderr: '', stdout: '' };
    }
    await killSession(name, socket).catch(() => {});
    const exitCode = tmuxRunExitCode(after, false);
    const cause = pane
      ? 'The tmux session went away before its exit status could be read, so this run may have been killed mid-work.'
      : 'This run had no readable tmux pane, so its exit status could never be read.';
    process.stderr.write(
      `\n${RED}agents: ${options.agent} outcome unknown (exit ${exitCode}).${OFF}\n` +
      `${GRAY}  ${cause}${OFF}\n` + NO_TMUX_TIP,
    );
    return { exitCode, stderr: '', stdout: '' };
  };

  const resumePrep = options.resume ? await prepareSessionForResume(name, socket) : { decision: 'create' as const };
  if (resumePrep.decision === 'attach') {
    if (options.sessionId) writeSessionAliasRecord(options.sessionId, name);
    await attachTmux({ socket, args: ['attach-session', '-t', name] });
    return resolveAfterAttach(resumePrep.pane);
  }

  const execEnv = { ...buildExecEnv(options), AGENT_TMUX_SESSION_NAME: name };
  const envFile = path.join(
    getRuntimeStateDir(), 'tmux-env', `${name}-${randomUUID().slice(0, 8)}.env`,
  );
  writeTmuxEnvFile(execEnv, envFile);
  let cmd = buildTmuxAgentCommand(executable, args, execEnv, { envFile });
  const leaseVersion = options.version ?? resolveVersion(options.agent, cwd);
  if (leaseVersion && isVersionInstalled(options.agent, leaseVersion)) {
    const leaseCli = getCliLaunch(['__launch-lease', options.agent, leaseVersion], getAgentsBinPath());
    cmd = `${[leaseCli.command, ...leaseCli.args].map(shellQuote).join(' ')} "$$" || exit 1; ${cmd}`;
  }
  const metaCmd = buildTmuxAgentCommand(executable, args, execEnv, { redactEnvValues: true });

  const labels: Record<string, string> = { agent: options.agent };
  if (isHarnessKnownSessionId(options.agent, options.sessionId, options.resume)) {
    labels.sessionId = options.sessionId as string;
  }

  let meta;
  try {
    meta = await createSession({ name, cmd, metaCmd, cwd, socket, source: 'cli', labels });
  } catch (err) {
    try { fs.rmSync(envFile, { force: true }); } catch {  }
    throw err;
  }
  const pane = meta.pane;

  if (options.sessionId) writeSessionAliasRecord(options.sessionId, name);

  if (pane) {
    const hookInstalled = await setSessionHook(name, 'pane-died', agentPaneDiedHook(name, pane), socket);
    if (hookInstalled) await markSessionHookSchema(name, socket);

    let panePid = 0;
    try {
      const r = await runTmux({ socket, args: ['display-message', '-pt', pane, '-p', '#{pane_pid}'], throwOnError: false });
      panePid = parseInt(r.stdout.trim(), 10) || 0;
    } catch {  }
    writePidSessionEntry({
      pid: panePid,
      agent: options.agent,
      harness: customHarnessName(options),
      sessionId: options.sessionId,
      cwd,
      actor: resolveActor().id,
      initiatedBy: resolveActor().kind,
      launchId: options.env?.AGENT_LAUNCH_ID,
      terminalId: launchIdentityEnv().AGENT_TERMINAL_ID,
      originTerminal: launchOrigin(),
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

  const before = pane ? await paneExitStatus(pane, socket) : { found: false, dead: false, status: undefined };
  if (before.dead) {
    bindCompletedPane();
    const tail = await capturePaneTail(pane);
    if (shouldRecapDeadPane(before.status, resolveInteractive(options))) {
      await surfacePaneFailure(pane, before.status, `${options.agent} exited before it could start`, tail);
    }
    await killSession(name, socket).catch(() => {});
    return { exitCode: tmuxRunExitCode(before, false), stderr: '', stdout: tail };
  }

  await attachTmux({ socket, args: ['attach-session', '-t', name] });
  return resolveAfterAttach(pane);
}

// Publish only a session id supplied by the harness or joined through the shared launch id.
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
    }
  }
  if (sessionId) process.stdout.write(sessionIdMarkerLine(sessionId));
}

interface RunLaunchInput {
  agent: AgentId;
  harnessName?: string;
  version?: string;
  strategy?: RunStrategy;
  signedIn: boolean | null;
  email: string | null;
  resolvedVia?: string;
}

export function buildRunLaunchPayload(input: RunLaunchInput): EventPayload {
  return {
    module: 'run',
    agent: input.agent,
    ...(input.harnessName ? { harnessName: input.harnessName } : {}),
    version: input.version,
    strategy: input.strategy ?? null,
    signedIn: input.signedIn,
    launchedLoggedOut: input.signedIn === false,
    email: input.email,
    ...(input.resolvedVia ? { resolvedVia: input.resolvedVia } : {}),
  };
}

interface RunLaunchContext {
  agent: AgentId;
  harnessName?: string;
  version: string | undefined;
  strategy?: RunStrategy;
  resolvedVia?: string;
  launchSignedIn?: boolean | null;
  launchEmail?: string | null;
}

async function emitRunLaunch(ctx: RunLaunchContext): Promise<void> {
  try {
    let signedIn: boolean | null;
    let email: string | null;
    if (ctx.launchSignedIn !== undefined) {
      signedIn = ctx.launchSignedIn;
      email = ctx.launchEmail ?? null;
    } else {
      signedIn = null;
      email = null;
      if (ctx.version) {
        try {
          const { isVersionLaunchableHere } = await import('./accounting/rotate.js');
          const state = await isVersionLaunchableHere(ctx.agent, ctx.version);
          signedIn = state.launchable;
          email = state.email;
        } catch {
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
        } catch {  }
      }
    } catch {  }
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
  if (options.agent === 'claude' && !options.resume && !options.sessionId) {
    options = { ...options, sessionId: randomUUID() };
  }
  ensureVendorHomeForSpawn(options);
  if (options.name && options.sessionId) {
    recordRunName({ sessionId: options.sessionId, name: options.name, agent: options.agent, cwd: options.cwd });
  }
  const cmd = buildExecCommand(options);
  const [executable, ...args] = cmd;

  const timeoutMs = options.timeout ? parseTimeout(options.timeout) : undefined;
  const piped = !process.stdout.isTTY;
  const interactive = resolveInteractive(options);

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

  // Headed Claude uses native OAuth only; workers require the selected slot's durable setup token and never open interactive login.
  if (options.agent === 'claude') {
    const { versionHome } = resolveExecConfigHome(options);
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
    if (hasWorkerCredential && versionHome && !isHeadedDeviceRole(selfConfiguredDeviceRole())) {
      seedClaudeWorkerHomeIdentity(versionHome);
    }
  }

  const cwd = options.cwd || process.cwd();
  // One launch id joins SSH, tmux, hook, and tracker observations into the same run.
  const launchId = resolveLaunchId(options.env?.AGENT_LAUNCH_ID);
  const runId = launchId;
  options = { ...options, env: { ...options.env, AGENT_LAUNCH_ID: launchId } };
  const watcherState = await setupBudgetWatcher(options, cwd, runId);

  const timer = createTimer('agent.run', {
    agent: options.agent,
    version: options.version,
    cwd: options.cwd || process.cwd(),
    mode: resolveMode(options.agent, normalizeMode(options.mode)),
    model: options.model,
    interactive,
    sessionId: options.sessionId,
    ...redactPrompt(options.prompt),
    command: executable,
    args: redactArgs(args.slice(0, 10)),
  });

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
    const msg = `agents: ${machineId()} has no tmux, so this --device run cannot get the pane it needs.\n`
      + `  install it:              (apt|dnf|brew) install tmux\n`
      + `  or turn the wrap off:    agents ssh ${machineId()} 'agents devices config ${machineId()} tmux.enabled off'\n`
      + `  or accept a bare run:    agents run … --device ${machineId()} --raw\n`;
    process.stderr.write(`\x1b[31m${msg}\x1b[0m`);
    timer.end({ exitCode: 1, status: 'failed', error: 'remote interactive run has no tmux for durability' });
    return { exitCode: 1, stdout: '', stderr: msg };
  }

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
    const tapStdout = shouldTapStdout(interactive, piped, watcherState !== null, options.captureStdoutTail);
    const stdio: ('inherit' | 'pipe')[] = interactive
      ? ['inherit', 'inherit', 'inherit']
      : ['inherit', tapStdout ? 'pipe' : 'inherit', 'pipe'];

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
      originTerminal: launchOrigin(),
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

    timer.mark('startup');

    let budgetKilled = false;
    let budgetKillTimer: ReturnType<typeof setTimeout> | undefined;
    let stdoutTail = '';
    const STDOUT_TAIL_CAP = 16 * 1024;
    if (!interactive && tapStdout && child.stdout) {
      child.stdout.pipe(process.stdout);
      child.stdout.on('data', (chunk: Buffer) => {
        stdoutTail = (stdoutTail + chunk.toString('utf-8')).slice(-STDOUT_TAIL_CAP);
      });
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
      if (budgetKillTimer) clearTimeout(budgetKillTimer);
      if (watcherState) {
        try { watcherState.finalize(); } catch {  }
        try { watcherState.watcher.dispose(); } catch {  }
      }
      const exitCode = budgetKilled ? BUDGET_KILL_EXIT_CODE : (code ?? 0);
      if (options.emitSessionId) emitResolvedSessionId(options, launchId, child.pid);
      timer.end({ exitCode, status: budgetKilled ? 'budget_killed' : code === 0 ? 'success' : 'failed' });
      resolve({ exitCode, stderr: stderrBuffer, stdout: stdoutTail });
    });
  });
}

export const BUDGET_KILL_EXIT_CODE = 7;

export const UNKNOWN_OUTCOME_EXIT_CODE = 1;

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
  const watcher = makeLiveSpendWatcher({ caps, onBreach: () => {  } });

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

export const RATE_LIMIT_PATTERNS: RegExp[] = [
  /rate[\s-]?limit/i,
  /usage[\s-]?limit/i,
  /quota\s*(exceeded|reached|limit)/i,
  /\b429\b/,
  /5[\s-]?hour[\s-]?limit/i,
  /too many requests/i,
  /api[\s_-]?overloaded/i,
  /\boverloaded\b/i,
  /spend[\s-]?limit/i,
  /out of (?:usage )?credits/i,
];

export function detectRateLimit(text: string): boolean {
  return RATE_LIMIT_PATTERNS.some(pattern => pattern.test(text));
}

const OUT_OF_CREDITS_PATTERNS: RegExp[] = [
  /out of (?:usage )?credits/i,
  /spend[\s-]?limit/i,
];
export function detectOutOfCredits(text: string): boolean {
  return OUT_OF_CREDITS_PATTERNS.some(pattern => pattern.test(text));
}

type ClaudeRefusalAction =
  | { action: 'note_session'; resetsAt: Date }
  | { action: 'note_out_of_credits' }
  | { action: 'note_model_limit'; model: string; family: string }
  | { action: 'clear' }
  | { action: 'none' };

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

export function parseCodexUsageLimitReset(text: string, nowMs = Date.now()): Date | null {
  if (!/hit your usage limit/i.test(text)) return null;
  const match = /try again (?:at|on)\s+([^.\n]+)/i.exec(text);
  if (!match) return null;
  const segment = match[1].trim().replace(/(\d{1,2})(st|nd|rd|th)\b/gi, '$1');
  const absolute = Date.parse(segment);
  if (!Number.isNaN(absolute)) {
    return absolute > nowMs ? new Date(absolute) : null;
  }
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

/**
 * Patterns that indicate an authentication failure — the agent is logged out,
 * its token was revoked, or the session expired. These are the user-visible
 * strings a logged-out agent surfaces (observed across the routine-run corpus).
 * Unlike a rate limit, an auth failure is NOT self-healing by failover — every
 * chain entry on the same account fails identically — so it is classified
 * separately and never triggers a fallback attempt.
 *
 * The bare `401` is deliberately paired with an auth keyword: a plain "401" can
 * appear in legitimate output (an HTTP-status table, a log line), so it only
 * counts when it co-occurs with OAuth/authentication/credentials/Unauthorized.
 */
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

export function detectAuthFailure(text: string): boolean {
  return AUTH_FAILURE_PATTERNS.some(pattern => pattern.test(text));
}

/**
 * Return true if a stream-json log carries the structural markers of an auth
 * failure. This is the authoritative signal for Claude: a logged-out run emits
 *   {"type":"system","subtype":"api_retry","error":"authentication_failed",…}
 *   {"type":"assistant",…,"error":"authentication_failed"}
 *   {"type":"result","is_error":true,"result":"Failed to authenticate…"}
 * Note `terminal_reason` is "completed" on such a run, so exit-code / terminal-
 * reason logic can never catch it — the `error:"authentication_failed"` marker
 * and the `result`+`is_error` text are the reliable signals.
 *
 * Gated on the Claude-compatible stream-json shape emitted by Claude and Cursor;
 * callers pass their agent so unrelated stream formats cannot match by accident.
 */
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

export function authFailureReason(text: string): string | null {
  for (const pattern of AUTH_FAILURE_PATTERNS) {
    const m = text.match(pattern);
    if (m) return m[0];
  }
  return null;
}

export function isAuthFailureFromLog(
  logText: string,
  agent: AgentId,
  opts: { processFailed: boolean },
): boolean {
  if (detectAuthFailureEvent(logText, agent)) return true;
  if (opts.processFailed && detectAuthFailure(logText)) return true;
  return false;
}

export interface FallbackEntry {
  agent: AgentId;
  version?: string;
  envOverride?: Record<string, string>;
}

interface FallbackOptions extends ExecOptions {
  fallback: FallbackEntry[];
  prompt: string;
  dispatchSink?: { agent?: AgentId; version?: string };
}

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

// Fallback preserves an explicit mode; only an implicit mode is re-resolved for the next harness.
export async function runWithFallback(options: FallbackOptions): Promise<number> {
  const chain: FallbackEntry[] = [
    { agent: options.agent, version: options.version },
    ...options.fallback,
  ];
  let prevAgent: AgentId | undefined;
  let prevSessionId: string | undefined;

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
    const rulesVersion = version ?? resolveVersion(agent);
    if (rulesVersion) {
      applyActiveRulesPresetAtRun(agent, rulesVersion, getVersionHomePath(agent, rulesVersion));
      applySystemResourcesAtRun(agent, rulesVersion, getVersionHomePath(agent, rulesVersion));
    }
    if (options.dispatchSink) { options.dispatchSink.agent = agent; options.dispatchSink.version = version; }
    const pinnedSessionId = agent === 'claude' ? randomUUID() : undefined;

    const prev = i > 0 ? chain[i - 1] : undefined;
    // Same-agent entries are account/model retries, not cross-harness transcript handoff.
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
    const refusal =
      agent === 'claude'
        ? classifyClaudeRunRefusal(output, result.exitCode ?? 1, execOpts.model)
        : agent === 'codex'
          ? classifyCodexRunRefusal(output, result.exitCode ?? 1)
          : null;
    const sessionLimitReset =
      refusal?.action === 'note_session' ? refusal.resetsAt : null;
    if (refusal && version && refusal.action !== 'none') {
      const { versionHome: refusalHome } = resolveExecConfigHome(execOpts);
      const account = await getAccountInfo(agent, refusalHome ?? getVersionHomePath(agent, version));
      const usageKey = getUsageLookupKey(account);
      if (usageKey && refusal.action !== 'note_model_limit') {
        if (refusal.action === 'note_session') noteClaudeSessionLimit(usageKey, refusal.resetsAt);
        else if (refusal.action === 'note_out_of_credits') noteClaudeOutOfCredits(usageKey);
        else if (refusal.action === 'clear' && !resolveInteractive(execOpts)) clearClaudeAccountRefusal(usageKey);
      }
    }

    const modelLimited = refusal?.action === 'note_model_limit';
    if (result.exitCode === 0 && !sessionLimitReset && !modelLimited) return 0;

    const isLast = i === chain.length - 1;
    if (isLast) return result.exitCode || 1;

    // Authentication and ordinary failures never trigger provider fallback; only explicit capacity signals do.
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
