/** Windows User PATH + execution-policy primitives; the only place that mutates User PATH. Uses the
 * RAW registry value: the .NET Environment API expands %VAR% and downgrades REG_EXPAND_SZ (#308).
 * Prepend/dedup is computed in TS; the write script broadcasts WM_SETTINGCHANGE. */
import { execFileSync } from 'child_process';
import * as path from 'path';

interface WinPathResult {
  success: boolean;
  alreadyPresent?: boolean;
  error?: string;
}

/** Compute the new User PATH from the RAW current value. Pure. Unchanged if `dir` is already first;
 * otherwise remove all occurrences, prepend, drop empty segments. %VAR% is kept verbatim (#308). */
export function computeNewUserPath(currentRaw: string, dir: string): { changed: boolean; value: string } {
  const parts = currentRaw.split(';').filter((p) => p !== '');
  if (parts.length > 0 && parts[0] === dir) {
    return { changed: false, value: currentRaw };
  }
  const others = parts.filter((p) => p !== dir);
  return { changed: true, value: [dir, ...others].join(';') };
}

/** Whether to write PATH back as REG_EXPAND_SZ: true if the original was ExpandString, the raw
 * value has %VAR%, or Path was absent. Only plain String without % stays REG_SZ. Pure. */
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

// Writes the value back with the preserved kind and broadcasts WM_SETTINGCHANGE. The value arrives
// via env var, never interpolated into the script (no injection).
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

/** Prepend `dir` to the Windows User PATH; idempotent, moves an existing later entry to front.
 * Reads raw, computes in TS, writes only on change, preserving type and broadcasting. Values pass
 * via env vars. */
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

/** The effective PowerShell execution policy (e.g. `Restricted`), or null if undeterminable. */
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

/** Whether a policy blocks unsigned local `.ps1` scripts (npm.ps1, agents.ps1), making bare
 * `agents`/`npm` fail in PowerShell even on PATH. Pure. */
export function blocksLocalScripts(policy: string | null): boolean {
  if (!policy) return false;
  const p = policy.trim().toLowerCase();
  return p === 'restricted' || p === 'allsigned';
}

/** Resolve the npm global-bin dir from the package entrypoint. On Windows launchers sit in the
 * prefix root, so that is the prefix. */
export function npmGlobalBinFromEntry(entryJsPath: string): string {
  return path.resolve(path.dirname(entryJsPath), '..', '..', '..', '..');
}
