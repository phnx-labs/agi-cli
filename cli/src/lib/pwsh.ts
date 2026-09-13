/**
 * PowerShell `-EncodedCommand` helper.
 *
 * Base64 of a script's UTF-16LE bytes is a single quote-free token, so it rides
 * through Node spawn → Windows sshd → cmd.exe with zero escaping hazards
 * (hand-quoted `powershell -Command "…"` is fragile the moment a path, URL, or
 * newline is involved). Shared by the browser SSH driver (which builds a
 * `powershell -EncodedCommand …` string) and the Windows secrets backend (which
 * spawns powershell.exe with an argv array).
 */
export function encodePwshBase64(script: string): string {
  return Buffer.from(script, 'utf16le').toString('base64');
}

/** Single-quote a value for PowerShell's own parser (embedded `'` doubled). */
export function pwshLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/**
 * PowerShell statements that run a NATIVE program with exact argv.
 *
 * Windows has no argv array: a process receives ONE string and splits it itself.
 * PowerShell 5.1 rebuilds that string when it invokes a native program, and its
 * serializer is lossy — measured on a real peer, an EMPTY argument is dropped and
 * an embedded `"` is discarded. So the arguments are pre-escaped by the caller to
 * the `CommandLineToArgvW` rules (`quoteWin32ExecArg`) and handed to .NET as one
 * `Arguments` string, which `CreateProcess` receives essentially verbatim. No shell
 * is involved, so no `%VAR%` expansion and no newline sensitivity.
 *
 * `UseShellExecute = $false` with no redirection leaves the child on the inherited
 * handles, which is what lets a binary stdout stream through unchanged.
 *
 * `WorkingDirectory` is set explicitly from `(Get-Location).ProviderPath`, and that
 * is not belt-and-braces: PowerShell's `Set-Location` moves the SHELL's location
 * without updating the .NET process's OS working directory, so a child launched
 * through `ProcessStartInfo` would otherwise start in whatever directory the
 * process began in — silently ignoring a caller's `cwd` (`--remote-cwd`). The
 * `ProviderPath` form is what yields a real filesystem path rather than a
 * PowerShell provider path.
 *
 * @param fileNameExpr a PowerShell EXPRESSION for the executable (a quoted literal,
 *   or something like `$__c.Source`) — not a raw path, so a caller that resolved the
 *   target on the peer can pass its variable.
 * @param argumentsExpr a PowerShell EXPRESSION producing the argument string —
 *   `pwshLiteral(line)` for a static one, or a concatenation when part of it is
 *   only known on the peer (a resolved interpreter entry, say).
 * @param exitVar variable name for the child, so a caller can chain on it.
 */
export function pwshNativeExecStatements(
  fileNameExpr: string,
  argumentsExpr: string,
  exitVar = '$zp',
): string[] {
  // Deliberately terse. The whole script is base64'd into ONE ssh command line,
  // and OpenSSH-for-Windows caps that far below cmd.exe's 8191 — measured on a
  // real peer, it fails between ~2.8k and ~4.1k characters. UTF-16LE + base64
  // inflates by ~2.7x, so every character here costs almost three on the wire.
  // `System.` is implicit for these types, and `-EA` is the canonical alias.
  return [
    `$zi=New-Object Diagnostics.ProcessStartInfo`,
    `$zi.FileName=${fileNameExpr}`,
    `$zi.Arguments=${argumentsExpr}`,
    `$zi.UseShellExecute=$false`,
    `$zi.WorkingDirectory=(Get-Location).ProviderPath`,
    // The CALLER sets `$ErrorActionPreference='Stop'` for the whole script, so it
    // is not repeated here — every character costs ~2.7 on the wire after base64.
    // The null guard below is what makes a swallowed Start failure impossible to
    // mistake for success: without it the handle is $null, the code is $null, and
    // `exit $null` reports 0.
    `${exitVar}=[Diagnostics.Process]::Start($zi)`,
    `if($null -eq ${exitVar}){throw "start failed: $($zi.FileName)"}`,
    `${exitVar}.WaitForExit()`,
  ];
}
