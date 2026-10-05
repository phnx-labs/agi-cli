import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export function localBinDir(home: string = os.homedir()): string {
  return path.join(home, '.local', 'bin');
}

interface SymlinkResult {
  ok: boolean;
  created: boolean;
  skippedReason?: string;
  path: string;
}

export function ensureLocalBinSymlink(
  name: string,
  target: string,
  dir: string = localBinDir(),
): SymlinkResult {
  // PATH healing never clobbers a real file or a symlink owned by another installation.
  const linkPath = path.join(dir, name);
  const want = path.resolve(target);
  let current: string | null = null;
  try {
    current = fs.readlinkSync(linkPath);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'EINVAL') {
      return { ok: false, created: false, skippedReason: 'a non-symlink file already exists here', path: linkPath };
    }
    if (code !== 'ENOENT') {
      return { ok: false, created: false, skippedReason: (err as Error).message, path: linkPath };
    }
  }
  if (current !== null) {
    const resolved = path.isAbsolute(current) ? current : path.resolve(dir, current);
    if (resolved === want) return { ok: true, created: false, path: linkPath };
    return { ok: false, created: false, skippedReason: `symlink already points to ${current}`, path: linkPath };
  }
  fs.mkdirSync(dir, { recursive: true });
  fs.symlinkSync(target, linkPath);
  return { ok: true, created: true, path: linkPath };
}

function bashPath(): string {
  const found = (process.env.PATH || '')
    .split(path.delimiter)
    .map((d) => (d ? path.join(d, 'bash') : ''))
    .find((p) => {
      if (!p) return false;
      try { fs.accessSync(p, fs.constants.X_OK); return true; } catch { return false; }
    });
  return found || '/bin/bash';
}

function loginProbeEnv(): NodeJS.ProcessEnv {
  // Remove inherited PATH/tool-manager state so bash computes a fresh login environment.
  const env = { ...process.env };
  delete env.PATH;
  delete env.NVM_BIN;
  delete env.NVM_INC;
  for (const k of Object.keys(env)) if (k.startsWith('npm_')) delete env[k];
  return env;
}

export function loginShellResolves(cmd: string): boolean {
  try {
    const res = spawnSync(bashPath(), ['-lc', `command -v ${cmd}`], {
      stdio: ['ignore', 'pipe', 'ignore'],
      encoding: 'utf-8',
      timeout: 5000,
      env: loginProbeEnv(),
    });
    return res.status === 0 && !!res.stdout && res.stdout.trim().length > 0;
  } catch {
    return false;
  }
}

export function dirOnLoginPath(dir: string): boolean {
  try {
    const res = spawnSync(bashPath(), ['-lc', 'printf %s "$PATH"'], {
      stdio: ['ignore', 'pipe', 'ignore'],
      encoding: 'utf-8',
      timeout: 5000,
      env: loginProbeEnv(),
    });
    if (res.status !== 0 || !res.stdout) return false;
    const want = path.resolve(dir);
    return res.stdout.split(':').some((p) => p && path.resolve(p) === want);
  } catch {
    return false;
  }
}
