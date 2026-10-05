import chalk from 'chalk';
import { sshExec } from '../../ssh-exec.js';
import { shellQuote } from '../../ssh-exec.js';
import { resolveExplicitTargets } from '../../devices/resolve-target.js';
import { remoteShellFor, buildWindowsAgentsCommand } from '../../hosts/remote-cmd.js';
import { parseBundle, type ParsedBundle } from '../bundle.js';

const REMOTE_EXPORT_TIMEOUT_MS = 300_000;

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
