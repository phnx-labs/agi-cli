/**
 * Setup-copy for `agents run --lease` (RUSH-1920), transport = PUSH-FROM-LOCAL.
 *
 * A fresh crabbox box has agents-cli installed but none of the caller's own
 * `~/.agents` config (skills, hooks, commands, MCP, profiles). This module
 * replicates the *git-tracked* subset of the LOCAL `~/.agents` onto the box:
 *
 *   1. `git -C <userAgentsDir> ls-files` — tracked files only. Tracked-only is
 *      the safety boundary: it excludes `.history/`, `.cache/`, `.system/` and
 *      any keychain-backed secrets by construction (those are gitignored), so no
 *      credential material is ever pushed.
 *   2. `rsync` that exact file set to `~/.agents` on the box over crabbox's OWN
 *      ssh invocation (`crabboxSshArgv`) — crabbox provisions a per-lease identity
 *      key, so a raw `ssh crabbox@ip` fails publickey; only crabbox's key works.
 *   3. `agents sync --local` on the box so the copied config takes effect.
 *
 * NEVER copies `~/.claude` / `~/.claude.json` — they live in `$HOME`, not
 * `~/.agents`, and are rebuilt on the box by `agents add` + refresh; an explicit
 * filter belts-and-braces the tracked-only guarantee.
 *
 * This is a self-contained local function the command layer calls; it does NOT
 * ride the box-side bootstrap script (that only echoes the `copy-setup` progress
 * sentinel — see `buildBootstrapScript`).
 */

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
  /**
   * Destination relative to the box user's home. Lease runs set this to their
   * isolated home; other callers retain the historical `~/.agents/` target.
   */
  remoteDir?: string;
  /** Receives combined stdout/stderr of the rsync + refresh, if set. */
  onData?: (chunk: string) => void;
  /**
   * Run `agents sync --local` on the box after the push (default `true`). Set
   * `false` when the caller runs the refresh itself in the box bootstrap — the
   * lease path does this so the refresh runs AFTER the box installs agents-cli
   * (this host-side push happens before the box boots agents-cli, so a host-side
   * refresh here could not find the CLI).
   */
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

/**
 * git-tracked files under `dir` (paths relative to `dir`), minus the never-copy
 * set. Returns `[]` when `dir` is not a git repo — a caller with no tracked
 * `~/.agents` simply copies nothing.
 */
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

/**
 * Split crabbox's ssh argv (`['ssh', …opts, 'crabbox@host']`) into the `-e`
 * transport string (`ssh …opts`) and the `crabbox@host` endpoint. This is what
 * carries the per-lease identity key + known_hosts a raw ssh lacks.
 */
export function sshTransportFromArgv(sshArgv: string[]): { rsh: string; host: string } {
  const host = sshArgv[sshArgv.length - 1];
  const rsh = sshArgv.slice(0, -1).join(' '); // 'ssh -i <key> -o … -p 2222'
  return { rsh, host };
}

/**
 * rsync argv to push the tracked file set to `~/.agents` on the box. Reads the
 * NUL-separated list at `filesFrom` (`--from0`, matching `ls-files -z`) so paths
 * with spaces survive, and tunnels over crabbox's own ssh (`rsh`).
 */
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

/**
 * Replicate the git-tracked subset of the local `~/.agents` onto the crabbox box
 * and refresh it. Enumerates tracked files, rsyncs them over ssh, then runs
 * `agents sync --local` on the box. Refresh is skipped when the push fails or the
 * file set is empty (nothing to refresh). Never throws — surfaces failure through
 * the returned exit codes.
 */
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
