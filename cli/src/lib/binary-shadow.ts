/** Detect `agents` binaries that could shadow the running CLI. Scheduled routines invoke bare
 * `agents`, so an older install earlier on PATH silently runs stale code (RUSH-2431); `agents
 * doctor` warns on these shadows. */
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { getAgentsBinPath } from './cli-entry.js';

export interface AgentsBinaryShadow {
  /** Path of the shadowing binary as it appears to the caller. */
  path: string;
  /** Its self-reported version, if we can run it. */
  version?: string;
}

/** Realpath of `p`, or `p` itself if it cannot be resolved. */
function safeRealpath(p: string): string {
  try { return fs.realpathSync(p); }
  catch { return p; }
}

/** Whether two path spellings identify the same file. On Windows `realpathSync` doesn't expand 8.3
 * short names (`RUNNER~1` vs `runneradmin`), so compare device+inode first and fall back to
 * case-insensitive resolved spellings. */
export function sameFile(a: string, b: string): boolean {
  try {
    const aStat = fs.statSync(a);
    const bStat = fs.statSync(b);
    if (aStat.dev === bStat.dev && aStat.ino === bStat.ino) return true;
  } catch { /* compare their resolved path spellings below */ }

  const aReal = safeRealpath(a);
  const bReal = safeRealpath(b);
  return process.platform === 'win32'
    ? aReal.toLowerCase() === bReal.toLowerCase()
    : aReal === bReal;
}

/** Find `agents` installs that aren't the running binary: an active shadow where `which`/`where
 * agents` resolves elsewhere, or a latent shadow where a well-known install dir holds a different
 * executable that could win under another PATH (e.g. the daemon's). */
export function detectAgentsBinaryShadows(
  currentBin: string = getAgentsBinPath(),
  extraDirs: readonly string[] = defaultWellKnownDirs(),
): AgentsBinaryShadow[] {
  const currentReal = safeRealpath(currentBin);

  const seen = new Set<string>();
  const shadows: AgentsBinaryShadow[] = [];

  function addIfShadow(candidate: string): void {
    if (seen.has(candidate)) return;
    seen.add(candidate);
    if (sameFile(candidate, currentReal)) return;
    let version: string | undefined;
    try {
      version = execFileSync(candidate, ['--version'], { encoding: 'utf-8', env: process.env })
        .trim()
        .split('\n')[0];
    } catch { /* binary may be unreadable/unrunnable — still report it */ }
    shadows.push({ path: candidate, version });
  }

  // Active shadow under the current environment's PATH.
  try {
    const resolver = process.platform === 'win32' ? 'where' : 'which';
    const pathAgents = execFileSync(resolver, ['agents'], { encoding: 'utf-8', env: process.env })
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean)[0];
    if (pathAgents && !sameFile(pathAgents, currentReal)) {
      addIfShadow(pathAgents);
    }
  } catch { /* no `agents` resolved on PATH */ }

  // Latent shadows in well-known install locations.
  for (const dir of extraDirs) {
    for (const name of agentBinaryNames()) {
      const candidate = path.join(dir, name);
      try {
        fs.accessSync(candidate, fs.constants.X_OK);
        addIfShadow(candidate);
      } catch { /* ignore */ }
    }
  }

  return shadows;
}

function agentBinaryNames(): string[] {
  return process.platform === 'win32' ? ['agents.exe', 'agents.cmd', 'agents'] : ['agents'];
}

function defaultWellKnownDirs(): string[] {
  const home = os.homedir();
  if (process.platform === 'win32') {
    const programFiles = process.env.ProgramFiles ?? 'C:\\Program Files';
    return [
      path.join(home, 'AppData', 'Roaming', 'npm'),
      path.join(programFiles, 'nodejs'),
      path.dirname(process.execPath),
    ];
  }
  return [
    path.join(home, '.local', 'bin'),
    '/usr/local/bin',
    '/opt/homebrew/bin',
    path.join(home, '.npm-global', 'bin'),
    path.join(home, '.bun', 'bin'),
    path.dirname(process.execPath),
  ];
}
