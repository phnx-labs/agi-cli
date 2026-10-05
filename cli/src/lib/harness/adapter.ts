import type { AgentId, Mode } from '../types.js';
import type { JobConfig } from '../scheduling/routines.js';
import type { ConfiguredDeviceRole } from '../device-config.js';

export interface ExecConfigEnvCtx {
  agent: AgentId;
  version: string | null;
  versionHome: string | null;
  interactive: boolean;
  deviceRole?: ConfiguredDeviceRole;
  resolveClaudeSetupToken: (versionHome: string) => string | null;
}

export interface ShimConfigEnvCtx {
  configDirName: string;
}

export interface ExecLaunchArgsCtx {
  resolvedMode: Mode;
  interactive: boolean;
  cwd: string;
  addDirs: string[];
}

export interface RoutineLaunchCtx {
  mode: Mode;
  config: JobConfig;
  resolveHeadlessMode: (agent: AgentId, mode: Mode, interactive: boolean) => void;
}

export interface HarnessAdapter {
  id: AgentId;


  applyExecConfigEnv?(result: NodeJS.ProcessEnv, ctx: ExecConfigEnvCtx): void;

  shimConfigEnvBash?(ctx: ShimConfigEnvCtx): string;


  shimLaunchArgs?(): string;

  shimExecTail?(launchArgs: string): string;

  execPreModeArgs?(ctx: ExecLaunchArgsCtx): string[] | undefined;

  execModeArgs?(ctx: ExecLaunchArgsCtx): string[] | undefined;

  routineModeArgs?(cmd: string[], ctx: RoutineLaunchCtx): void;
}

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

export function stripForeignConfigDir(result: NodeJS.ProcessEnv, keep: readonly string[] = []): void {
  for (const key of CONFIG_DIR_ENV_KEYS) {
    if (!keep.includes(key)) delete result[key];
  }
}

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

function defaultAdapter(id: AgentId): HarnessAdapter {
  return { id };
}

export function registerHarnessAdapter(adapter: HarnessAdapter): void {
  REGISTRY.set(adapter.id, adapter);
}

export function resolveHarnessAdapter(id: AgentId): HarnessAdapter {
  return REGISTRY.get(id) ?? defaultAdapter(id);
}

export function listHarnessAdapters(): AgentId[] {
  return [...REGISTRY.keys()].sort();
}
