import { execFileSync } from 'child_process';
import * as path from 'path';

export function whichCommand(platform: NodeJS.Platform = process.platform): string {
  return platform === 'win32' ? 'where' : 'which';
}

/** Does spawning `binary` require `shell: true`? On Windows a `.cmd`/`.bat` wrapper (npm.cmd, agent
 * shims) or a bare command name can't be exec'd directly (spawn misses PATHEXT, giving
 * ENOENT/EINVAL). Always false off Windows. */
export function needsWindowsShell(binary: string, platform: NodeJS.Platform = process.platform): boolean {
  if (platform !== 'win32') return false;
  return !path.win32.isAbsolute(binary) || /\.(cmd|bat)$/i.test(binary);
}

/** Resolves an executable name to its absolute path via the OS PATH search, or null. On Windows
 * `where` can return several lines (PATHEXT matches); the first is what the shell runs. stderr is
 * dropped: a miss is expected, and `where.exe` would print "INFO: Could not find files" per probe. */
export function findExecutable(name: string, platform: NodeJS.Platform = process.platform): string | null {
  try {
    const out = execFileSync(whichCommand(platform), [name], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const first = out.trim().split(/\r?\n/)[0]?.trim();
    return first || null;
  } catch {
    return null;
  }
}

/** Absolute path of the POSIX shell for `sh -c`: `/bin/sh`, or on Windows Git's `sh.exe`/`bash.exe`
 * from PATH. Falls back to the bare name so a missing shell surfaces as an ENOENT on `sh`, not a
 * misleading one on `/bin/sh`. */
export function posixShellPath(platform: NodeJS.Platform = process.platform): string {
  if (platform !== 'win32') return '/bin/sh';
  return findExecutable('sh', platform) ?? findExecutable('bash', platform) ?? 'sh';
}

/** Quote one arg for a Windows cmd.exe line (shell: true): wrap args with whitespace, quotes or
 * metachars; escape per CommandLineToArgvW. CAVEAT: cmd expands %VAR%/!VAR! even inside quotes
 * (CVE-2024-1874); not escaped as callers own those tokens. */
export function quoteWin32ExecArg(arg: string): string {
  // Shell composition is a DEP0190/CVE-2024-1874 boundary; callers must not pass
  // untrusted percent/exclamation expansion because cmd.exe expands those after quoting.
  if (arg.length > 0 && !/[\s"&|<>()^]/.test(arg)) return arg;
  let result = '"';
  let backslashes = 0;
  for (const ch of arg) {
    if (ch === '\\') {
      backslashes += 1;
      continue;
    }
    if (ch === '"') {
      result += '\\'.repeat(backslashes * 2 + 1) + '"';
      backslashes = 0;
      continue;
    }
    result += '\\'.repeat(backslashes) + ch;
    backslashes = 0;
  }
  result += '\\'.repeat(backslashes * 2) + '"';
  return result;
}

/** Compose a DEP0190-safe Windows command line. Node's shell: true joins cmd and args unescaped
 * (deprecated, and an injection surface for prompts). Quote every token with quoteWin32ExecArg and
 * spawn the line with an EMPTY args array. Simple args pass through unchanged. */
export function composeWin32CommandLine(command: string, args: string[]): string {
  return [command, ...args].map(quoteWin32ExecArg).join(' ');
}

/** DEP0190-safe execFile/spawn spec. When needsWindowsShell(bin), compose one quoted line via
 * composeWin32CommandLine with EMPTY args so user-controlled argv is never concatenated unescaped.
 * Otherwise bin and args pass through. Pure; `platform` override makes win32 testable anywhere. */
export function execFileShellSpec(
  bin: string,
  args: string[],
  platform: NodeJS.Platform = process.platform,
): { command: string; args: string[]; shell: boolean } {
  // Windows PATH commands and cmd/bat files require a shell; direct binaries must avoid it.
  if (!needsWindowsShell(bin, platform)) {
    return { command: bin, args, shell: false };
  }
  return { command: composeWin32CommandLine(bin, args), args: [], shell: true };
}
