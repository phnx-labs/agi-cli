/** Multi-device session transfer over the existing SSH fleet transport (RUSH-1712), no R2 or
 * daemon: export/import run `agents sessions export --stdout` on the peer. Reuses
 * ssh-exec/resolve-target; no second transport. */
import chalk from 'chalk';
import { sshExec } from '../../ssh-exec.js';
import { shellQuote } from '../../ssh-exec.js';
import { resolveExplicitTargets } from '../../devices/resolve-target.js';
import { remoteShellFor, buildWindowsAgentsCommand } from '../../hosts/remote-cmd.js';
import { parseBundle, type ParsedBundle } from '../bundle.js';

/** Remote export can traverse many sessions; give it a generous ceiling. */
const REMOTE_EXPORT_TIMEOUT_MS = 300_000;

/** Build `agents <args>` for the peer's login shell (bash or PowerShell). */
function remoteAgentsCommand(args: string[], os?: string): string {
  if (remoteShellFor(os) === 'powershell') {
    return buildWindowsAgentsCommand({ args });
  }
  const inner = ['agents', ...args].map((t, i) => (i === 0 ? t : shellQuote(t))).join(' ');
  return `bash -lc ${shellQuote(inner)}`;
}

interface RemotePullResult {
  bundles: ParsedBundle[];
  errors: string[];
}

/** Run `agents sessions export …exportArgs --stdout` on each host and parse the bundle. A failing
 * host goes into `errors` and is skipped. `exportArgs` must not contain --device: the remote
 * export runs for itself only. */
export async function pullBundlesFromHosts(hosts: string[], exportArgs: string[]): Promise<RemotePullResult> {
  const targets = await resolveExplicitTargets(hosts);
  const bundles: ParsedBundle[] = [];
  const errors: string[] = [];

  for (const t of targets) {
    const cmd = remoteAgentsCommand(['sessions', 'export', ...exportArgs, '--stdout'], t.os);
    process.stderr.write(chalk.dim(`Pulling sessions from ${t.name}…\n`));
    const res = sshExec(t.target, cmd, { timeoutMs: REMOTE_EXPORT_TIMEOUT_MS, extraSshArgs: t.extraSshArgs });
    if (res.timedOut) {
      errors.push(`${t.name}: timed out after ${Math.round(REMOTE_EXPORT_TIMEOUT_MS / 1000)}s`);
      continue;
    }
    if (res.code !== 0) {
      const tail = res.stderr.trim().split('\n').filter(Boolean).pop();
      errors.push(`${t.name}: remote export failed (${res.code ?? 'ssh error'})${tail ? ': ' + tail : ''}`);
      continue;
    }
    try {
      bundles.push(parseBundle(res.stdout));
    } catch (err) {
      errors.push(`${t.name}: ${(err as Error).message}`);
    }
  }
  return { bundles, errors };
}
