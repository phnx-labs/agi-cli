// EncodedCommand uses UTF-16LE so scripts cross Node → sshd → cmd.exe without shell quoting.
export function encodePwshBase64(script: string): string {
  return Buffer.from(script, 'utf16le').toString('base64');
}

export function pwshLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

export function pwshNativeExecStatements(
  fileNameExpr: string,
  argumentsExpr: string,
  exitVar = '$zp',
): string[] {
  // ProcessStartInfo receives caller-prequoted Win32 argv because PowerShell 5.1 cannot preserve empty or quoted native arguments.
  // Keep this terse: UTF-16/base64 expansion approaches Windows OpenSSH command-line limits.
  return [
    `$zi=New-Object Diagnostics.ProcessStartInfo`,
    `$zi.FileName=${fileNameExpr}`,
    `$zi.Arguments=${argumentsExpr}`,
    `$zi.UseShellExecute=$false`,
    // Set-Location does not update process cwd; ProviderPath gives the child the requested remote cwd.
    `$zi.WorkingDirectory=(Get-Location).ProviderPath`,
    `${exitVar}=[Diagnostics.Process]::Start($zi)`,
    `if($null -eq ${exitVar}){throw "start failed: $($zi.FileName)"}`,
    `${exitVar}.WaitForExit()`,
  ];
}
