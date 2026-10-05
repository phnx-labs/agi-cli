/** Setup-copy for `agents run --lease` (RUSH-1920), push-from-local: replicate the git-tracked
 * subset of local `~/.agents` onto a fresh box. Tracked-only (`git ls-files`) is the safety
 * boundary: no `.history/`, `.cache/`, `.system/` or keychain secrets; never copies `~/.claude`. */

import { spawn, spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { getUserAgentsDir } from '../state.js';
import { crabboxEnv, crabboxSshArgv } from './cli.js';

/** Remote path (relative to the box user's home) the tracked config lands in. */
const REMOTE_AGENTS_DIR = '.agents/';

/** Top-level paths that must never be pushed, even if somehow tracked. */
const NEVER_COPY = new Set(['.claude', '.claude.json']);

interface CopySetupOptions {
  /** crabbox box slug to push to — its per-lease ssh key does the auth. */
  slug: string;
  /** Secrets bundle whose env the ssh/rsync children inherit (crabbox parity). */
  secretsBundle?: string;
  /** Override the local `~/.agents` dir (defaults to `getUserAgentsDir()`). */
  userAgentsDir?: string;
  /** Destination relative to the box user's home. Lease runs set their isolated home; other callers
   * keep the historical `~/.agents/` target. */
  remoteDir?: string;
  /** Receives combined stdout/stderr of the rsync + refresh, if set. */
  onData?: (chunk: string) => void;
  /** Run `agents sync --local` on the box after the push (default true). The lease path sets false
   * and refreshes in the bootstrap, since the host-side push happens before the box has
   * agents-cli. */
  refresh?: boolean;
}

export interface CopySetupResult {
  /** The tracked files enumerated for the push (post-exclusion). */
  files: string[];
  /** rsync exit code, or null when the process failed to spawn. */
  pushExitCode: number | null;
  /** `agents sync --local` exit code, or null when it was skipped/failed to spawn. */
  refreshExitCode: number | null;
}

/** git-tracked files under `dir` (relative paths) minus the never-copy set; `[]` when `dir` is not
 * a git repo. */
export function enumerateTrackedFiles(dir: string): string[] {
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

/** Split crabbox's ssh argv into the `-e` transport string and the `crabbox@host` endpoint,
 * carrying the per-lease identity key and known_hosts a raw ssh lacks. */
export function sshTransportFromArgv(sshArgv: string[]): { rsh: string; host: string } {
  const host = sshArgv[sshArgv.length - 1];
  const rsh = sshArgv.slice(0, -1).join(' '); // 'ssh -i <key> -o … -p 2222'
  return { rsh, host };
}

/** rsync argv to push the tracked file set to `~/.agents` on the box. Reads the NUL-separated list
 * at `filesFrom` (`--from0`, matching `ls-files -z`) so paths with spaces survive; tunnels over
 * crabbox's ssh. */
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

/** Replicate the git-tracked subset of local `~/.agents` onto the box and refresh it. Refresh is
 * skipped when the push fails or the file set is empty. Never throws; failure surfaces via exit
 * codes. */
export async function copySetupToBox(opts: CopySetupOptions): Promise<CopySetupResult> {
  const dir = opts.userAgentsDir ?? getUserAgentsDir();
  const files = enumerateTrackedFiles(dir);
  if (files.length === 0) {
    return { files, pushExitCode: null, refreshExitCode: null };
  }

  // crabbox provisions a per-lease ssh key; a raw `ssh crabbox@ip` fails publickey.
  // Ask crabbox for its exact ssh invocation and tunnel rsync through it.
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
    // NUL-separated list, matching `buildSetupRsyncArgs`'s `--from0`.
    fs.writeFileSync(listPath, files.join('\0'), 'utf-8');
    const rsyncArgs = buildSetupRsyncArgs({ rsh, host, filesFrom: listPath, source: dir, remoteDir: opts.remoteDir });
    const pushExitCode = await runStreaming('rsync', rsyncArgs, env, opts.onData);

    let refreshExitCode: number | null = null;
    if (pushExitCode === 0 && opts.refresh !== false) {
      // ssh <opts> crabbox@host bash -lc 'agents sync --local -y'
      const refreshArgs = [...sshArgv.slice(1), 'bash', '-lc', 'agents sync --local -y'];
      refreshExitCode = await runStreaming('ssh', refreshArgs, env, opts.onData);
    }
    return { files, pushExitCode, refreshExitCode };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}
