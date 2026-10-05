/** PowerShell `-EncodedCommand` helper: base64 of a script's UTF-16LE bytes is one quote-free token,
 * so it passes through Node spawn, Windows sshd and cmd.exe without escaping hazards. Shared by the
 * browser SSH driver and the Windows secrets backend. */
export function encodePwshBase64(script: string): string {
  return Buffer.from(script, 'utf16le').toString('base64');
}

/** Single-quote a value for PowerShell's own parser (embedded `'` doubled). */
export function pwshLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/** Run a NATIVE program with exact argv from PowerShell. PowerShell 5.1 drops empty arguments and
 * discards embedded quotes, so args are pre-escaped (`CommandLineToArgvW`) and passed to .NET as
 * one string. `WorkingDirectory` is explicit: `Set-Location` doesn't move the process cwd. */
export function pwshNativeExecStatements(
  fileNameExpr: string,
  argumentsExpr: string,
  exitVar = '$zp',
): string[] {
  // Deliberately terse: the script is base64'd into ONE ssh command line and OpenSSH-for-Windows
  // caps it far below 8191 (fails around 2.8k-4.1k chars). UTF-16LE + base64 inflates ~2.7x, so
  // every character counts.
  return [
    `$zi=New-Object Diagnostics.ProcessStartInfo`,
    `$zi.FileName=${fileNameExpr}`,
    `$zi.Arguments=${argumentsExpr}`,
    `$zi.UseShellExecute=$false`,
    `$zi.WorkingDirectory=(Get-Location).ProviderPath`,
    // The CALLER sets `$ErrorActionPreference='Stop'`, not repeated here (each character costs ~2.7
    // on the wire). The null guard makes a swallowed Start failure impossible to mistake for
    // success: otherwise the handle and code are $null and `exit $null` reports 0.
    `${exitVar}=[Diagnostics.Process]::Start($zi)`,
    `if($null -eq ${exitVar}){throw "start failed: $($zi.FileName)"}`,
    `${exitVar}.WaitForExit()`,
  ];
}
