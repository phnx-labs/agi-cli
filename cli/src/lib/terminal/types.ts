
export type Backend = 'iterm' | 'ghostty' | 'tmux' | 'vscodium-agent' | 'terminal';

export type SplitDirection = 'right' | 'down';

export type Layout = 'tab' | 'split-right' | 'split-down';

export interface EngineContext {
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
}

export function currentContext(): EngineContext {
  return { platform: process.platform, env: process.env };
}

export interface LaunchSpec {
  argv: string[];
}

export interface SurfaceMeta {
  agent?: string;
  sessionId?: string;
  title?: string;
}

export interface LaunchRequest {
  backend: Backend;
  layout: Layout;
  cwd: string;
  command: string[];
  host?: string;
  agent?: string;
  sessionId?: string;
  title?: string;
}

export interface LaunchResult {
  ok: boolean;
  request: LaunchRequest;
  error?: string;
}

export interface TerminalBackend {
  readonly id: Backend;
  readonly label: string;
  isAvailable(ctx: EngineContext): boolean;
  buildTab(cwd: string, command: string[], meta?: SurfaceMeta): LaunchSpec;
  buildSplit(cwd: string, command: string[], direction: SplitDirection, meta?: SurfaceMeta): LaunchSpec;
}
