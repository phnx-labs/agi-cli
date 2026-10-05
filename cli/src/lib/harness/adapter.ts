/** Harness adapter registry, the behavior axis of a harness: `AGENTS` (lib/agents.ts) holds what
 * a harness is, while an adapter holds what it does at the execution boundary (config-dir env
 * pins, launch-arg quirks) that call sites would otherwise express as `agent === 'x'` chains. */
import type { AgentId, Mode } from '../types.js';
import type { JobConfig } from '../scheduling/routines.js';
import type { ConfiguredDeviceRole } from '../device-config.js';

/** Context for the exec-time config-env pin (exec.ts side). The caller resolves
 * interactive/version facts once; the adapter only expresses the harness-specific env changes
 * on the accumulating `result` env, as the old per-agent branch did. */
export interface ExecConfigEnvCtx {
  agent: AgentId;
  /** The version to pin, pre-resolved by the caller (null = unresolved/not installed). */
  version: string | null;
  /** That version's home, pre-resolved by the caller (null when version is null). */
  versionHome: string | null;
  /** resolveInteractive(options) — computed once by the caller. */
  interactive: boolean;
  /** The role marked on THIS machine (worker, personal, desktop), from selfConfiguredDeviceRole().
   * On a headed device (personal/desktop) every run, interactive or headless, must use its native
   * login, never the worker setup-token (RUSH-2395). Undefined means non-headed. */
  deviceRole?: ConfiguredDeviceRole;
  /** claude-account-token's resolveClaudeSetupToken, injected: adapters must stay import-leaf,
   * since that module pulls in the secrets stack and sqlite.ts (top-level await), which breaks
   * the cjs transform for subprocess tests loading shims.ts via tsx. Only claude uses it. */
  resolveClaudeSetupToken: (versionHome: string) => string | null;
}

/** Context for the shim-script config-env block (mapping A, shims.ts side). */
export interface ShimConfigEnvCtx {
  /** The config-dir path relative to `$HOME` (e.g. `.claude`, nested `.gemini/antigravity-cli`),
   * derived by the caller from the AGENTS registry. */
  configDirName: string;
}

/** Context for the exec-time launch-arg quirks (exec.ts side); mirrors the locals
 * buildExecCommand already computed. */
export interface ExecLaunchArgsCtx {
  resolvedMode: Mode;
  interactive: boolean;
  cwd: string;
  /** Extra writable roots (`--add-dir`) requested for this run, home-expanded. */
  addDirs: string[];
}

/** Context for routine (daemon-job) launch-arg quirks (runner.ts side). This idiom mutates a
 * token array baked from AGENT_COMMANDS (bakeRoutineArgv), distinct from buildExecCommand's
 * declarative modeFlags, so it is a separate adapter method. */
export interface RoutineLaunchCtx {
  /** normalizeMode(config.mode) — the canonicalized mode. */
  mode: Mode;
  config: JobConfig;
  /** exec.ts resolveHeadlessMode, injected to avoid an import cycle (exec.ts imports this
   * registry); Kimi uses it for its plan-to-auto downgrade warning. */
  resolveHeadlessMode: (agent: AgentId, mode: Mode, interactive: boolean) => void;
}

export interface HarnessAdapter {
  id: AgentId;

  // --- Mapping A: config-dir env, two call sites, one source of truth --------

  /** Applies this harness's config-dir env pins to the process env for `agents run` (exec.ts
   * buildExecEnv), mutating `result` in place. The caller already stripped CONFIG_DIR_ENV_KEYS,
   * so an adapter sets only its own vars (plus extras to delete, e.g. Claude's inherited token). */
  applyExecConfigEnv?(result: NodeJS.ProcessEnv, ctx: ExecConfigEnvCtx): void;

  /** The config-env bash block for this harness's generated shim (shims.ts), spliced verbatim;
   * omitted (empty) for a harness with no managed config-dir env. */
  shimConfigEnvBash?(ctx: ShimConfigEnvCtx): string;

  // --- Mapping B: launch-arg quirks, exec + shim + routine sites -------------

  /** Launch args appended to the shim `exec` line (shims.ts); Codex pins
   * `check_for_update_on_startup=false` and its edit-profile policy args. Empty when none. */
  shimLaunchArgs?(): string;

  /** The shim's `exec` tail (shims.ts). Codex resolves the repo's `.agents` dir from `$PWD` at
   * run time and appends `--add-dir`; the default is `exec "$BINARY"<launchArgs> "$@"`. */
  shimExecTail?(launchArgs: string): string;

  /** Additive launch args emitted before mode-flag resolution in buildExecCommand (exec.ts),
   * e.g. Cursor's `--trust` for a configured headless edit. Undefined when none. */
  execPreModeArgs?(ctx: ExecLaunchArgsCtx): string[] | undefined;

  /** This harness's mode-flag emission for buildExecCommand, overriding the generic
   * `template.modeFlags`/resume path. Codex returns policy args; Kimi returns [] for headless
   * (throwing on an invariant violation). Undefined defers to the generic path. */
  execModeArgs?(ctx: ExecLaunchArgsCtx): string[] | undefined;

  /** This harness's routine (daemon-job) launch-arg quirks for buildJobCommand (runner.ts);
   * mutates the bakeRoutineArgv token array in place and runner appends model/reasoning flags
   * after. Omitted when none. */
  routineModeArgs?(cmd: string[], ctx: RoutineLaunchCtx): void;
}

/** Config-dir env keys a harness pins to its slot or version home. Each buildExecEnv branch
 * deletes those it does not set so a slot never inherits another account's dir (PHNX-3940 T5).
 * GROK_HOME, OPENCODE_CONFIG_DIR and the XDG pair were once omitted and leaked parent pins. */
export const CONFIG_DIR_ENV_KEYS = [
  'CLAUDE_CONFIG_DIR',
  'CODEX_HOME',
  'COPILOT_HOME',
  'KIMI_CODE_HOME',
  'GROK_HOME',
  'OPENCODE_CONFIG_DIR',
  'XDG_CONFIG_HOME',
  'XDG_DATA_HOME',
] as const;

/** Strips every config-dir env key except those this harness sets; `keep=[]` (no-config-dir
 * harness) deletes all. */
export function stripForeignConfigDir(result: NodeJS.ProcessEnv, keep: readonly string[] = []): void {
  for (const key of CONFIG_DIR_ENV_KEYS) {
    if (!keep.includes(key)) delete result[key];
  }
}

/** Bash for a config-dir pin that yields to an account-slot launch (PHNX-3940 T5). The shim used
 * to re-export the version home unconditionally, so a run picked as one account used another's
 * home. It now yields to AGENTS_EXEC_HOME and consumes the marker so nested launches skip it. */
export function slotAwareConfigEnvBash(
  pins: ReadonlyArray<{ env: string; rel: string }>,
  versionHome: string,
): string {
  const slot = pins.map((p) => `  export ${p.env}="$AGENTS_EXEC_HOME/${p.rel}"`).join('\n');
  const version = pins.map((p) => `  export ${p.env}="${versionHome}/${p.rel}"`).join('\n');
  return `if [ -n "\${AGENTS_EXEC_HOME:-}" ]; then
${slot}
  unset AGENTS_EXEC_HOME
else
${version}
fi`;
}

const REGISTRY = new Map<AgentId, HarnessAdapter>();

/** The no-behavior adapter: no managed config-dir env and no launch-arg quirks. buildExecEnv
 * falls back to stripForeignConfigDir when an adapter omits `applyExecConfigEnv`. */
function defaultAdapter(id: AgentId): HarnessAdapter {
  return { id };
}

export function registerHarnessAdapter(adapter: HarnessAdapter): void {
  REGISTRY.set(adapter.id, adapter);
}

/** The behavior adapter for a harness: every `AgentId` resolves, to a registered adapter or the
 * id-only default, so callers never name-check a harness. */
export function resolveHarnessAdapter(id: AgentId): HarnessAdapter {
  return REGISTRY.get(id) ?? defaultAdapter(id);
}

export function listHarnessAdapters(): AgentId[] {
  return [...REGISTRY.keys()].sort();
}
