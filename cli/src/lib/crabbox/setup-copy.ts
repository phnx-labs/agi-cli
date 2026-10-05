
import { spawn, spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { getUserAgentsDir } from '../state.js';
import { crabboxEnv, crabboxSshArgv } from './cli.js';

const REMOTE_AGENTS_DIR = '.agents/';

const NEVER_COPY = new Set(['.claude', '.claude.json']);

interface CopySetupOptions {
  slug: string;
  secretsBundle?: string;
  userAgentsDir?: string;
  remoteDir?: string;
  onData?: (chunk: string) => void;
  refresh?: boolean;
}

export interface CopySetupResult {
  files: string[];
  pushExitCode: number | null;
  refreshExitCode: number | null;
}

export function enumerateTrackedFiles(dir: string): string[] {
  // Copy git-tracked setup only; native OAuth and untracked history/cache stay local.
  const r = spawnSync('git', ['-C', dir, 'ls-files', '-z'], { encoding: 'utf-8' });
  if (r.status !== 0 || !r.stdout) return [];
  return r.stdout
    .split('\0')
    .filter(Boolean)
    .filter((f) => {
      const top = f.split('/')[0];
      return !NEVER_COPY.has(f) && !NEVER_COPY.has(top);
    });
}

export function sshTransportFromArgv(sshArgv: string[]): { rsh: string; host: string } {
  // Reuse crabbox's per-lease SSH transport, not ambient fleet SSH configuration.
  const host = sshArgv[sshArgv.length - 1];
  const rsh = sshArgv.slice(0, -1).join(' ');
  return { rsh, host };
}

export function buildSetupRsyncArgs(opts: {
  rsh: string;
  host: string;
  filesFrom: string;
  source: string;
  remoteDir?: string;
}): string[] {
  const remote = `${opts.host}:${opts.remoteDir ?? REMOTE_AGENTS_DIR}`;
  const source = opts.source.endsWith('/') ? opts.source : `${opts.source}/`;
  return ['-az', '--files-from', opts.filesFrom, '--from0', '-e', opts.rsh, source, remote];
}

function runStreaming(
  cmd: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  onData?: (chunk: string) => void,
): Promise<number | null> {
  return new Promise((resolve) => {
    const proc = spawn(cmd, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
    const pump = (chunk: Buffer) => {
      const s = chunk.toString('utf-8');
      if (onData) onData(s);
      else process.stdout.write(s);
    };
    proc.stdout.on('data', pump);
    proc.stderr.on('data', pump);
    proc.on('error', () => resolve(null));
    proc.on('close', (code) => resolve(code));
  });
}

export async function copySetupToBox(opts: CopySetupOptions): Promise<CopySetupResult> {
  const dir = opts.userAgentsDir ?? getUserAgentsDir();
  const files = enumerateTrackedFiles(dir);
  if (files.length === 0) {
    return { files, pushExitCode: null, refreshExitCode: null };
  }

  const sshArgv = crabboxSshArgv(opts.slug, { secretsBundle: opts.secretsBundle });
  if (!sshArgv) {
    return { files, pushExitCode: null, refreshExitCode: null };
  }
  const { rsh, host } = sshTransportFromArgv(sshArgv);

  const env = crabboxEnv({ secretsBundle: opts.secretsBundle });
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-setup-copy-'));
  const listPath = path.join(tmp, 'files.lst');
  try {
    if (opts.remoteDir) {
      if (!/^[a-zA-Z0-9._/-]+$/.test(opts.remoteDir) || opts.remoteDir.startsWith('/') || opts.remoteDir.split('/').includes('..')) {
        throw new Error(`remote setup directory must stay under the box home: ${opts.remoteDir}`);
      }
      const remoteDir = opts.remoteDir.replace(/\/$/, '');
      const prepareArgs = [
        ...sshArgv.slice(1),
        'bash',
        '-lc',
        `mkdir -p "$HOME"/${JSON.stringify(remoteDir)}`,
      ];
      const prepareExitCode = await runStreaming('ssh', prepareArgs, env, opts.onData);
      if (prepareExitCode !== 0) {
        return { files, pushExitCode: prepareExitCode, refreshExitCode: null };
      }
    }
    fs.writeFileSync(listPath, files.join('\0'), 'utf-8');
    const rsyncArgs = buildSetupRsyncArgs({ rsh, host, filesFrom: listPath, source: dir, remoteDir: opts.remoteDir });
    const pushExitCode = await runStreaming('rsync', rsyncArgs, env, opts.onData);

    let refreshExitCode: number | null = null;
    if (pushExitCode === 0 && opts.refresh !== false) {
      const refreshArgs = [...sshArgv.slice(1), 'bash', '-lc', 'agents sync --local -y'];
      refreshExitCode = await runStreaming('ssh', refreshArgs, env, opts.onData);
    }
    return { files, pushExitCode, refreshExitCode };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}
