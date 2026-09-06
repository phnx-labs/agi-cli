/**
 * Resolve a remote-created session id back to an interactive `--device` launcher.
 *
 * A headless `--device` run captures the remote-coined id from the followed log
 * (the `--emit-session-id` marker — see session-marker.ts). An INTERACTIVE run
 * has no followed log: the local TTY is wired straight through `sshStream`
 * (stdio:'inherit'), so nothing can tap the stream for a marker without breaking
 * the agent's raw-mode TUI. Instead we correlate by AGENT_LAUNCH_ID.
 *
 * The launcher forwards a launch id it controls (`--env AGENT_LAUNCH_ID=<id>`);
 * the remote `agents run` adopts it (exec.ts `resolveLaunchId`), so the remote
 * SessionStart hook records the agent's REAL session id. After the stream
 * returns we ask the owning CLI to join that hook with the durable launch
 * registry, using the same index as local focus/session projection. This also
 * supports the deployed legacy hook containing only session_id and pid.
 *
 * This gives the interactive path a real per-agent id to register in the local
 * session index and to reconnect against, for Codex/Kimi/Grok/Gemini — closing
 * the gap RUSH-2033 left for every non-Claude agent (Claude still forces its own
 * id up front and never reaches here).
 */

import { sshExec, shellQuote } from '../ssh-exec.js';

/** Resolve on the execution owner through the canonical read-only CLI projection. */
export function resolveRemoteSessionId(target: string, launchId: string, timeoutMs = 6000): string | undefined {
  if (!launchId) return undefined;
  // Let the owning CLI join its deployed hook and launch registry. A remote
  // caller must not carry a second implementation of session identity rules.
  const cmd = `agents sessions --resolve-launch-id ${shellQuote(launchId)} --json --local`;
  const res = sshExec(target, cmd, { timeoutMs, multiplex: true });
  if (res.code !== 0) return undefined;
  try {
    const record = JSON.parse(res.stdout);
    return record.launchId === launchId && typeof record.sessionId === 'string' && record.sessionId
      ? record.sessionId : undefined;
  } catch {
    return undefined;
  }
}
