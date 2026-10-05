
export {
  findTmuxBinary,
  isTmuxInstalled,
  getTmuxVersion,
  isTmuxVersionSupported,
  MIN_TMUX_VERSION,
  assertTmuxAvailable,
  TmuxUnavailableError,
  TmuxCommandError,
  runTmux,
  attachTmux,
} from './binary.js';

export {
  getDefaultSocketPath,
  getSessionMetaPath,
  ensureTmuxDir,
} from './paths.js';

export {
  assertValidSessionName,
  slugifyName,
  hasSession,
  createSession,
  killSession,
  teardownIfAgentExited,
  killAll,
  listSessions,
  splitPane,
  sendKeys,
  capturePane,
  readSessionMeta,
  TmuxSessionError,
  reconcileSessionHooks,
  ensureSessionHookRepaired,
  type SessionMeta,
  type CreateSessionOptions,
  type ListedSession,
  type SplitOptions,
  type SendOptions,
  type CaptureOptions,
} from './session.js';
