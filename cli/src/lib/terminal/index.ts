/**
 * Terminal launch engine — open an interactive command as a tab or split pane
 * in iTerm / Ghostty / tmux, on this machine or a remote host.
 *
 * Public entry point. Callers typically use `openSurfaces` (a batch with a
 * layout policy) or `openSurface` (a single request), and `availableBackends` /
 * `detectCurrentBackend` to pick a target. See docs/interfaces.md.
 */
export type {
  Backend,
  SplitDirection,
  Layout,
  EngineContext,
  LaunchSpec,
  LaunchRequest,
  LaunchResult,
  TerminalBackend,
} from './types.js';
export { currentContext } from './types.js';

export { BACKENDS, detectCurrentBackend, availableBackends, itermBackend, ghosttyBackend, tmuxBackend, vscodiumAgentBackend, terminalAppBackend } from './backends/index.js';
export {
  SESSION_HOST_BACKENDS,
  backendFromSessions,
  resolveLaunchBackend,
  describeBackendChoice,
  type SessionHostSample,
  type BackendSource,
  type LaunchBackendChoice,
} from './preferred.js';
export { makeVscodiumAgentBackend, spawnUri, EDITOR_VARIANTS, type EditorVariant } from './backends/vscodium-agent.js';
export { planLayouts, type Packing } from './policy.js';
export {
  specForRequest,
  buildRequests,
  openSurface,
  openSurfaces,
  type OpenOptions,
  type OpenManyOptions,
  type BuildRequestsOptions,
  type SurfaceItem,
} from './engine.js';
export { runLocal, runRemote, runSpec, remoteCommand, type HostResolver, type RunResult } from './transport.js';
export {
  backendCarriesPaste,
  injectIntoTerminal,
  tmuxSendKeysArgv,
  tmuxInjectSpecs,
  itermInjectScript,
  ghosttyInjectScript,
  appleScriptInjectSpec,
  vscodiumInjectUri,
  vscodiumInjectSpec,
  type InjectTarget,
  type InjectBackend,
  type InjectOptions,
  type InjectResult,
} from './inject.js';
export {
  resolveInjectTarget,
  resolveInjectTargetForSession,
  type InjectResolution,
  type InjectRail,
  type ResolveOptions,
} from './resolve.js';
export { iLoginShell } from './shell.js';
export { shellQuote } from './quote.js';
export { parseTerminalFlag, stripTerminalFlag, buildRunCommand, openRunInTerminal, toHostSamples, TERMINAL_FLAG_BACKENDS } from './run-surface.js';
export type { OpenRunSurfaceParams, OpenRunSurfaceResult } from './run-surface.js';
