/**
 * Windows User PATH + execution-policy primitives.
 *
 * The single place that mutates the Windows User PATH. It reads and writes the
 * RAW registry value via `Microsoft.Win32.Registry` (NOT the .NET
 * `[Environment]::*Environment*Variable` API, which expands `%VAR%` references
 * on read and downgrades REG_EXPAND_SZ to REG_SZ on write — issue #308,
 * dotnet/runtime#89695 / #1442). The prepend/dedup itself is computed in TS
 * (`computeNewUserPath`, the single source of truth) so it has unit coverage on
 * every OS; PowerShell is used only for the registry primitives. Because a raw
 * `SetValue` does NOT broadcast the change (the old `[Environment]` API did), the
 * write script broadcasts WM_SETTINGCHANGE itself so a new terminal picks up the
 * PATH without re-login.
 * Consumers: `shims.ts` (shims dir) and `scripts/postinstall.js` (npm global-bin
 * dir, so the `agents` command itself resolves).
 *
 * Leaf module — imports only `child_process` and `path` so it is cheap to load
 * from the npm lifecycle script without pulling the rest of the CLI.
 */
import { execFileSync } from 'child_process';
import * as path from 'path';

interface WinPathResult {
  success: boolean;
  /** True when `dir` was already the first PATH entry (no write performed). */
  alreadyPresent?: boolean;
  error?: string;
}

/**
 * Compute the new User PATH from the RAW (unexpanded) current value. Pure and
 * OS-independent — the single source of truth for the prepend/dedup logic.
 *
 * Idempotent: returns `{ changed: false }` (value unchanged, verbatim) when
 * `dir` is already the first `;`-split entry. Otherwise removes every existing
 * occurrence of `dir` and prepends it, dropping empty segments — matching POSIX
 * `export PATH="${dir}:$PATH"`. `%VAR%` segments are preserved verbatim (never
 * expanded), which is the #308 regression this fix targets.
 */
export function computeNewUserPath(currentRaw: string, dir: string): { changed: boolean; value: string } {
  const parts = currentRaw.split(';').filter((p) => p !== '');
  if (parts.length > 0 && parts[0] === dir) {
    return { changed: false, value: currentRaw };
  }
  const others = parts.filter((p) => p !== dir);
  return { changed: true, value: [dir, ...others].join(';') };
}

/**
 * Decide whether to write the User PATH back as REG_EXPAND_SZ (ExpandString) vs
 * REG_SZ (String). Pure — testable on any host.
 *
 * True (expandable) when the original value was already ExpandString, when the
 * raw value contains a `%VAR%` reference, or when `Path` was absent (default to
 * ExpandString — Windows' native Path type). Only a plain String value with no
 * `%` stays REG_SZ. `originalKind` is the .NET RegistryValueKind name
 * (`ExpandString`/`String`/…) or `null`/`Absent` when `Path` had no value.
 */
export function shouldWriteExpandable(originalKind: string | null, rawValue: string): boolean {
  if (originalKind === null || originalKind === 'Absent') return true;
  if (originalKind === 'ExpandString') return true;
  return rawValue.includes('%');
}

// Sentinel separating the value kind from the (possibly '%'-laden) raw value in
// the read script's stdout — PATH entries never contain a newline, so an
// exclusive line marker parses unambiguously.
const READ_MARKER = '===AGENTS-PATH-VALUE===';

// Reads the RAW User PATH preserving REG_EXPAND_SZ: DoNotExpandEnvironmentNames
// keeps `%VAR%` literal, and GetValueKind reports the original type (throws when
// 'Path' is absent -> caught, reported as Absent).
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

// Writes the computed value back with the preserved kind and broadcasts
// WM_SETTINGCHANGE (raw SetValue does not, unlike the old [Environment] API).
// The value comes in via AGENTS_WINPATH_VALUE so it is never interpolated into
// the script text (preserves the no-injection property for '%'-laden paths).
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
  '$res = [UIntPtr]::Zero',
  // HWND_BROADCAST=0xffff, WM_SETTINGCHANGE=0x1a, SMTO_ABORTIFHUNG=2, 5s timeout
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

/** Parse the read script's stdout into the original value kind and RAW value. */
function parseReadOutput(out: string): { kind: string | null; raw: string } {
  const idx = out.indexOf(READ_MARKER);
  if (idx === -1) return { kind: null, raw: '' };
  const head = out.slice(0, idx);
  const kindMatch = head.match(/KIND:(\S+)/);
  const kind = kindMatch ? kindMatch[1] : null;
  // Everything after the marker line, minus the leading/trailing newline PS adds.
  const raw = out
    .slice(idx + READ_MARKER.length)
    .replace(/^\r?\n/, '')
    .replace(/\r?\n$/, '');
  return { kind, raw };
}

/**
 * Prepend `dir` to the Windows User PATH. Idempotent: a no-op when `dir` is
 * already first; moves it to the front when it exists but is positioned later
 * (e.g. appended by an older install) so it overrides conflicting entries.
 *
 * Reads the RAW registry value (preserving `%VAR%` and the REG_EXPAND_SZ type),
 * computes the new value in TS via `computeNewUserPath`, and only writes when
 * the value actually changes — preserving the original value type and
 * broadcasting WM_SETTINGCHANGE. `dir` and the computed value are passed via env
 * vars so they are never interpolated into the script text.
 */
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

/**
 * The effective PowerShell execution policy (e.g. `Restricted`, `RemoteSigned`),
 * or null if it can't be determined (PowerShell missing / errored).
 */
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

/**
 * Whether a policy blocks running unsigned local `.ps1` scripts — which is what
 * npm and agents-cli generate (`npm.ps1`, `agents.ps1`). Under these the bare
 * `agents` / `npm` commands fail in PowerShell with a security error even when
 * on PATH. Pure — testable on any host.
 */
export function blocksLocalScripts(policy: string | null): boolean {
  if (!policy) return false;
  const p = policy.trim().toLowerCase();
  return p === 'restricted' || p === 'allsigned';
}

/**
 * Resolve the npm global-bin directory (where the generated `agents` /
 * `agents.cmd` launchers live, and where npm expects PATH to point) from the
 * package entrypoint. On Windows npm places bin launchers directly in the
 * prefix root, so the bin dir is the prefix itself.
 *
 * entry = `<prefix>/node_modules/@phnx-labs/agents-cli/dist/index.js` → `<prefix>`
 */
export function npmGlobalBinFromEntry(entryJsPath: string): string {
  return path.resolve(path.dirname(entryJsPath), '..', '..', '..', '..');
}
