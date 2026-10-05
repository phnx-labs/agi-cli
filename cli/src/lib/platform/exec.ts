import { execFileSync } from 'child_process';
import * as path from 'path';

export function whichCommand(platform: NodeJS.Platform = process.platform): string {
  return platform === 'win32' ? 'where' : 'which';
}

export function needsWindowsShell(binary: string, platform: NodeJS.Platform = process.platform): boolean {
  if (platform !== 'win32') return false;
  return !path.win32.isAbsolute(binary) || /\.(cmd|bat)$/i.test(binary);
}

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

export function posixShellPath(platform: NodeJS.Platform = process.platform): string {
  if (platform !== 'win32') return '/bin/sh';
  return findExecutable('sh', platform) ?? findExecutable('bash', platform) ?? 'sh';
}

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

export function composeWin32CommandLine(command: string, args: string[]): string {
  return [command, ...args].map(quoteWin32ExecArg).join(' ');
}

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
