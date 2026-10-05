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
  return [
    `$zi=New-Object Diagnostics.ProcessStartInfo`,
    `$zi.FileName=${fileNameExpr}`,
    `$zi.Arguments=${argumentsExpr}`,
    `$zi.UseShellExecute=$false`,

    `$zi.WorkingDirectory=(Get-Location).ProviderPath`,
    `${exitVar}=[Diagnostics.Process]::Start($zi)`,
    `if($null -eq ${exitVar}){throw "start failed: $($zi.FileName)"}`,
    `${exitVar}.WaitForExit()`,
  ];
}
