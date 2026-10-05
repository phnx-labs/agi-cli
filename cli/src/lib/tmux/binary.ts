/**
 * tmux binary discovery + spawn helpers.
 *
 * Every shell-out goes through `runTmux()` so:
 *  - args are passed as an array, never interpolated into a shell string (no
 *    quoting bugs like swarmify's `command.replace(/'/g, "'\\''")` hack);
 *  - the socket arg is positioned correctly (`-S <sock>` MUST come before the
 *    subcommand);
 *  - stdout/stderr capture is consistent for the session module to parse.
 */

import { spawn, spawnSync, type SpawnOptions } from 'child_process';
import { existsSync } from 'fs';

let cachedBin: string | null | undefined;
let cachedVersion: string | null | undefined;

export const MIN_TMUX_VERSION = '3.2';

export function findTmuxBinary(): string | null {
  if (cachedBin !== undefined) return cachedBin;
  const fromWhich = spawnSync('sh', ['-c', 'command -v tmux'], { encoding: 'utf8' });
  if (fromWhich.status === 0) {
    const out = fromWhich.stdout.trim();
    if (out && existsSync(out)) {
      cachedBin = out;
      return cachedBin;
    }
  }
  for (const p of ['/opt/homebrew/bin/tmux', '/usr/local/bin/tmux', '/usr/bin/tmux']) {
    if (existsSync(p)) {
      cachedBin = p;
      return cachedBin;
    }
  }
  cachedBin = null;
  return null;
}

export function isTmuxInstalled(): boolean {
  return findTmuxBinary() !== null;
}

export function getTmuxVersion(): string | null {
  if (cachedVersion !== undefined) return cachedVersion;
  const bin = findTmuxBinary();
  if (!bin) return null;
  const res = spawnSync(bin, ['-V'], { encoding: 'utf8' });
  if (res.status !== 0) {
    cachedVersion = null;
    return cachedVersion;
  }
  cachedVersion = res.stdout.trim() || null;
  return cachedVersion;
}

export function isTmuxVersionSupported(version: string | null): boolean {
  if (!version) return false;
  const match = /^tmux\s+(\d+)\.(\d+)/.exec(version.trim());
  if (!match) return false;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  return major > 3 || (major === 3 && minor >= 2);
}

export function assertTmuxAvailable(): string {
  const bin = findTmuxBinary();
  if (!bin) {
    const platform = process.platform;
    const hint = platform === 'darwin'
      ? 'Install with: brew install tmux'
      : platform === 'linux'
        ? 'Install with: apt install tmux  (or dnf/yum/pacman equivalent)'
        : 'Install tmux from https://github.com/tmux/tmux';
    throw new TmuxUnavailableError(`tmux is not installed. ${hint}`);
  }
  const version = getTmuxVersion();
  if (!isTmuxVersionSupported(version)) {
    throw new TmuxUnavailableError(
      `${version ?? 'tmux version unknown'} is unsupported. agents requires tmux ${MIN_TMUX_VERSION} or newer.`,
    );
  }
  return bin;
}

export class TmuxUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TmuxUnavailableError';
  }
}

export class TmuxCommandError extends Error {
  readonly stderr: string;
  readonly stdout: string;
  readonly code: number | null;
  constructor(message: string, stderr: string, stdout: string, code: number | null) {
    super(message);
    this.name = 'TmuxCommandError';
    this.stderr = stderr;
    this.stdout = stdout;
    this.code = code;
  }
}

interface RunTmuxOptions {
  socket?: string;
  args: string[];
  throwOnError?: boolean;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
}

export async function runTmux(opts: RunTmuxOptions): Promise<{ stdout: string; stderr: string; code: number }> {
  const bin = assertTmuxAvailable();
  const fullArgs: string[] = [];
  if (opts.socket) fullArgs.push('-S', opts.socket);
  fullArgs.push(...opts.args);

  return new Promise((resolve, reject) => {
    const child = spawn(bin, fullArgs, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: opts.env ?? process.env,
    });
    let stdout = '';
    let stderr = '';
    let timer: ReturnType<typeof setTimeout> | undefined;
    if (opts.timeoutMs && opts.timeoutMs > 0) {
      timer = setTimeout(() => {
        child.kill();
        reject(new Error(`tmux ${fullArgs.join(' ')} timed out after ${opts.timeoutMs}ms`));
      }, opts.timeoutMs);
    }
    child.stdout?.on('data', (b) => { stdout += b.toString('utf8'); });
    child.stderr?.on('data', (b) => { stderr += b.toString('utf8'); });
    child.on('error', (err) => { if (timer) clearTimeout(timer); reject(err); });
    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      const exitCode = code ?? -1;
      const throwOnError = opts.throwOnError !== false;
      if (throwOnError && exitCode !== 0) {
        reject(new TmuxCommandError(
          `tmux ${fullArgs.join(' ')} failed (exit ${exitCode}): ${stderr.trim() || stdout.trim()}`,
          stderr,
          stdout,
          exitCode,
        ));
        return;
      }
      resolve({ stdout, stderr, code: exitCode });
    });
  });
}

export function attachTmux(opts: { socket: string; args: string[]; env?: NodeJS.ProcessEnv }): Promise<number> {
  const bin = assertTmuxAvailable();
  const fullArgs = ['-S', opts.socket, ...opts.args];
  return new Promise((resolve, reject) => {
    const child = spawn(bin, fullArgs, {
      stdio: 'inherit',
      env: opts.env ?? process.env,
    } as SpawnOptions);
    child.on('error', reject);
    child.on('close', (code) => resolve(code ?? 0));
  });
}
