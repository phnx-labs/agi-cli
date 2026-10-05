/** Resolve a remote-created session id for an interactive `--device` launcher, which has no
 * followed log: it correlates by AGENT_LAUNCH_ID, which the remote `agents run` adopts (exec.ts
 * `resolveLaunchId`) so its SessionStart hook records the real id (RUSH-2033). */

import { sshExec, shellQuote } from '../ssh-exec.js';

export function resolveRemoteSessionId(target: string, launchId: string, timeoutMs = 6000): string | undefined {
  // Resolve on the execution owner; launch id is the durable join for opaque interactive streams.
  if (!launchId) return undefined;
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
