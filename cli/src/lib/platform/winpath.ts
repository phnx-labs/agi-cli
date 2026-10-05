import { execFileSync } from 'child_process';
import * as path from 'path';

interface WinPathResult {
  success: boolean;
  alreadyPresent?: boolean;
  error?: string;
}

export function computeNewUserPath(currentRaw: string, dir: string): { changed: boolean; value: string } {
  const parts = currentRaw.split(';').filter((p) => p !== '');
  if (parts.length > 0 && parts[0] === dir) {
    return { changed: false, value: currentRaw };
  }
  const others = parts.filter((p) => p !== dir);
  return { changed: true, value: [dir, ...others].join(';') };
}

export function shouldWriteExpandable(originalKind: string | null, rawValue: string): boolean {
  // Preserve raw %VAR% references and their expandable registry value kind.
  if (originalKind === null || originalKind === 'Absent') return true;
  if (originalKind === 'ExpandString') return true;
  return rawValue.includes('%');
}

const READ_MARKER = '===AGENTS-PATH-VALUE===';

const READ_SCRIPT = [
  "$key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment', $false)",
  'if ($null -eq $key) {',
  "  Write-Output 'KIND:Absent'",
  `  Write-Output '${READ_MARKER}'`,
  "  Write-Output ''",
  '} else {',
  "  try { $kind = $key.GetValueKind('Path').ToString() } catch { $kind = 'Absent' }",
  "  $val = $key.GetValue('Path', '', [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)",
  "  Write-Output ('KIND:' + $kind)",
  `  Write-Output '${READ_MARKER}'`,
  '  Write-Output $val',
  '}',
].join('\n');

const WRITE_SCRIPT = [
  "$key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment', $true)",
  "if ($null -eq $key) { $key = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey('Environment') }",
  '$val = $env:AGENTS_WINPATH_VALUE',
  "if ($env:AGENTS_WINPATH_EXPAND -eq '1') {",
  '  $kind = [Microsoft.Win32.RegistryValueKind]::ExpandString',
  '} else {',
  '  $kind = [Microsoft.Win32.RegistryValueKind]::String',
  '}',
  "$key.SetValue('Path', $val, $kind)",
  'Add-Type @"',
  'using System;',
  'using System.Runtime.InteropServices;',
  'public static class AgentsWinPath {',
  '  [DllImport("user32.dll", SetLastError=true, CharSet=CharSet.Auto)]',
  '  public static extern IntPtr SendMessageTimeout(IntPtr hWnd, uint Msg, UIntPtr wParam, string lParam, uint fuFlags, uint uTimeout, out UIntPtr lpdwResult);',
  '}',
  '"@',
  // Broadcast WM_SETTINGCHANGE so future processes observe the updated user environment.
  '$res = [UIntPtr]::Zero',
  "[AgentsWinPath]::SendMessageTimeout([IntPtr]0xffff, 0x1a, [UIntPtr]::Zero, 'Environment', 2, 5000, [ref]$res) | Out-Null",
  "Write-Output 'written'",
].join('\n');

function runPowerShell(script: string, extraEnv?: Record<string, string>): string {
  return execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], {
    encoding: 'utf-8',
    env: extraEnv ? { ...process.env, ...extraEnv } : process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
}

function parseReadOutput(out: string): { kind: string | null; raw: string } {
  const idx = out.indexOf(READ_MARKER);
  if (idx === -1) return { kind: null, raw: '' };
  const head = out.slice(0, idx);
  const kindMatch = head.match(/KIND:(\S+)/);
  const kind = kindMatch ? kindMatch[1] : null;
  const raw = out
    .slice(idx + READ_MARKER.length)
    .replace(/^\r?\n/, '')
    .replace(/\r?\n$/, '');
  return { kind, raw };
}

export function prependToWindowsUserPath(dir: string): WinPathResult {
  try {
    const readOut = runPowerShell(READ_SCRIPT);
    const { kind, raw } = parseReadOutput(readOut);
    const { changed, value } = computeNewUserPath(raw, dir);
    if (!changed) {
      return { success: true, alreadyPresent: true };
    }
    const expandable = shouldWriteExpandable(kind, value);
    runPowerShell(WRITE_SCRIPT, {
      AGENTS_WINPATH_VALUE: value,
      AGENTS_WINPATH_EXPAND: expandable ? '1' : '0',
    });
    return { success: true, alreadyPresent: false };
  } catch (err) {
    return { success: false, error: `Could not update the Windows user PATH: ${(err as Error).message}` };
  }
}

export function getEffectiveExecutionPolicy(): string | null {
  try {
    const out = execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', 'Get-ExecutionPolicy'], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    }).trim();
    return out || null;
  } catch {
    return null;
  }
}

export function blocksLocalScripts(policy: string | null): boolean {
  if (!policy) return false;
  const p = policy.trim().toLowerCase();
  return p === 'restricted' || p === 'allsigned';
}

export function npmGlobalBinFromEntry(entryJsPath: string): string {
  return path.resolve(path.dirname(entryJsPath), '..', '..', '..', '..');
}
