/**
 * Editor identity belongs to the first launch attached to that terminal. The
 * harness inherits it for its own tools, but another `agents run` is a new
 * launch, not another owner of the parent's editor tab. AGENTS_RUNTIME is set
 * by buildExecEnv, whereas an editor's initial launch sets AGENT_TERMINAL_ID
 * (and may already set AGENT_SESSION_ID) without that runtime marker.
 */
export function launchIdentityEnv(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const result: Record<string, string> = {};
  const terminal = env.AGENT_TERMINAL_ID?.trim();
  const nested = env.AGENTS_RUNTIME === 'terminal' || env.AGENTS_RUNTIME === 'headless' || env.AGENTS_RUNTIME === 'teams';
  if (terminal && !nested) result.AGENT_TERMINAL_ID = terminal;
  const originTerminal = env.AGENTS_ORIGIN_TERMINAL_ID?.trim() || terminal;
  if (originTerminal) result.AGENTS_ORIGIN_TERMINAL_ID = originTerminal;
  const parentLaunch = nested ? env.AGENT_LAUNCH_ID : env.AGENTS_PARENT_LAUNCH_ID;
  const parentSession = nested
    ? env.AGENTS_SESSION_ID || env.AGENT_SESSION_ID
    : env.AGENTS_PARENT_SESSION_ID;
  if (parentLaunch) result.AGENTS_PARENT_LAUNCH_ID = parentLaunch;
  if (parentSession) result.AGENTS_PARENT_SESSION_ID = parentSession;
  return result;
}

/** Identity absent from a new launch must not leak back in from a tmux server. */
export const LAUNCH_IDENTITY_KEYS = [
  'AGENT_TERMINAL_ID', 'AGENT_SESSION_ID', 'AGENTS_SESSION_ID', 'AGENTS_MAILBOX_DIR',
  'AGENT_LAUNCH_ID', 'AGENTS_PARENT_SESSION_ID', 'AGENTS_PARENT_LAUNCH_ID', 'AGENTS_ORIGIN_TERMINAL_ID',
] as const;
