
import { sshExec, shellQuote } from '../ssh-exec.js';

export function resolveRemoteSessionId(target: string, launchId: string, timeoutMs = 6000): string | undefined {

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
