
import { shellQuote } from '../ssh-exec.js';
import { pwshLiteral, pwshNativeExecStatements } from '../pwsh.js';
import { quoteWin32ExecArg } from '../platform/exec.js';
import { homeRemainder } from '../project-root.js';
import * as zlib from 'node:zlib';

export interface StripSpec {
  long: string;
  short?: string;
  takesValue: boolean;
}

export function stripRoutingFlags(args: string[], specs: StripSpec[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    const spec = specs.find((s) => {
      if (a === `--${s.long}` || a.startsWith(`--${s.long}=`)) return true;
      if (s.short && (a === `-${s.short}` || a.startsWith(`-${s.short}=`) || new RegExp(`^-${s.short}.+`).test(a)))
        return true;
      return false;
    });
    if (!spec) {
      out.push(a);
      continue;
    }
    const isExact = a === `--${spec.long}` || (spec.short && a === `-${spec.short}`);
    if (spec.takesValue && isExact && i + 1 < args.length) i++;
  }
  return out;
}

export const HOST_ROUTING_SPECS: StripSpec[] = [
  { long: 'device', short: 'D', takesValue: true },
  { long: 'host', short: 'H', takesValue: true },
  { long: 'remote-cwd', takesValue: true },
];

type RunOptionForwarding =
  | 'forward'
  | 'reject'
  | 'local-only';

export const RUN_OPTION_FORWARDING: Record<string, RunOptionForwarding> = {
  mode: 'forward',
  effort: 'forward',
  model: 'forward',
  env: 'forward',
  addDir: 'forward',
  name: 'forward',
  resume: 'forward',
  sessionId: 'forward',
  timeout: 'forward',
  fallback: 'forward',
  balanced: 'forward',
  strategy: 'forward',
  account: 'forward',
  loop: 'forward',
  maxIterations: 'forward',
  budget: 'forward',
  until: 'forward',
  interval: 'forward',
  json: 'forward',
  verbose: 'forward',
  yes: 'forward',
  acp: 'forward',
  autoSecrets: 'forward',
  emitSessionId: 'forward',

  terminal: 'reject',
  secrets: 'reject',
  secretsKeys: 'reject',
  allowExpired: 'reject',
  resumeCheckpoint: 'reject',

  quiet: 'local-only',
  headless: 'local-only',
  interactive: 'local-only',
  cwd: 'local-only',
  project: 'local-only',
  remoteCwd: 'local-only',
  raw: 'local-only',
  tmux: 'local-only',
  disableTmux: 'local-only',
  device: 'local-only',
  where: 'local-only',
  local: 'local-only',
  on: 'local-only',
  computer: 'local-only',
  any: 'local-only',
  follow: 'local-only',
  lease: 'local-only',
  box: 'local-only',
  keepBox: 'local-only',
  fresh: 'local-only',
  reuse: 'local-only',
  bare: 'local-only',
  tailscale: 'local-only',
  copyCreds: 'local-only',
  cloud: 'local-only',
  provider: 'local-only',
  repo: 'local-only',
  branch: 'local-only',
  cloudEnv: 'local-only',
  authCheck: 'local-only',
  notify: 'local-only',
  traceSync: 'local-only',
  broadcast: 'local-only',
  task: 'local-only',
  listTasks: 'local-only',
  results: 'local-only',
  concurrency: 'local-only',
};

export const RUN_OPTION_REJECT_MESSAGES: Record<string, string> = {
  terminal:
    '--terminal opens a tab on THIS machine; it cannot be combined with --device. ' +
    'Drop --terminal to dispatch to the device, or drop --device to open the tab here. ' +
    'To watch a remote run in a terminal, dispatch it and follow with `agents sessions focus <id>`.',
  secrets:
    '--secrets cannot cross the SSH boundary — Keychain values are never sent to a host implicitly. ' +
    'Provision the bundle on the host first (agents secrets export --device <name>), then run without --secrets; ' +
    'workflow frontmatter secrets resolve from the HOST\'s own keychain.',
  secretsKeys: '--secrets-keys applies to --secrets bundles, which cannot cross the SSH boundary (see --secrets).',
  allowExpired: '--allow-expired applies to --secrets bundles, which cannot cross the SSH boundary (see --secrets).',
  resumeCheckpoint: '--resume-checkpoint reads a local checkpoint.json — it cannot resume a run on another machine. Run it locally, or start a fresh --loop run on the host.',
  resumeBare: '--resume with no id opens the interactive picker, which cannot run across a detached host dispatch. Pass a concrete session id: agents run <agent> --resume <id> --device <name>.',
};

export function buildRemoteAgentsInvocation(
  forwardedArgs: string[],
  remoteCwd?: string,
  os?: string,
  env?: Record<string, string>,
): string {
  if (remoteShellFor(os) === 'powershell') {
    return buildWindowsAgentsCommand({ args: forwardedArgs, cwd: remoteCwd, env });
  }
  const inner = ['agents', ...forwardedArgs].map(shellQuote).join(' ');
  const withCwd = remoteCwd ? `cd ${shellQuote(remoteCwd)} && ${inner}` : inner;
  const exports = posixEnvExports(env);
  if (!exports) {
    return `bash -lc ${shellQuote(withCwd)}`;
  }
  return `bash -lc ${shellQuote(`${exports}; ${withCwd}`)}`;
}

const EXPAND_KEYS = new Set(['PATH']);

export function posixEnvExports(env?: Record<string, string>): string {
  // Only trusted-static PATH may expand remotely; provenance and every other value are literals.
  if (!env || Object.keys(env).length === 0) return '';
  return Object.entries(env)
    .map(([k, v]) =>
      EXPAND_KEYS.has(k)
        ? `export ${shellQuote(k)}="${v.replace(/[\\"]/g, '\\$&')}"`
        : `export ${shellQuote(k)}=${shellQuote(v)}`,
    )
    .join('; ');
}

type RemoteShell = 'posix' | 'powershell';

export function remoteShellFor(os: string | undefined): RemoteShell {
  return /^win/i.test((os ?? '').trim()) ? 'powershell' : 'posix';
}

export function powershellQuote(s: string): string {
  return "'" + s.replace(/'/g, "''") + "'";
}

export function encodePowershell(script: string): string {
  return Buffer.from(script, 'utf16le').toString('base64');
}

export function decodePowershell(encoded: string): string {
  return Buffer.from(encoded, 'base64').toString('utf16le');
}

interface WindowsAgentsCommand {
  args: string[];
  env?: Record<string, string>;
  cwd?: string;
  mirrorCwd?: boolean;
  propagateExit?: boolean;
  remapExit255?: boolean;
}

export const POWERSHELL_PROGRESS_SILENCE = "$ProgressPreference = 'SilentlyContinue'";

export function stripClixml(stdout: string): string {
  if (!stdout.includes('#< CLIXML')) return stdout;
  return stdout
    .replace(/#< CLIXML[^\n]*\r?\n?(?:\s*<Objs\b[\s\S]*?<\/Objs>)*/g, '')
    .trim();
}

export function windowsAgentsInvocation(args: string[], binName: 'agents' | 'ag' = 'agents'): string {
  // PowerShell 5.1 loses native argv through npm shims; resolve the declared JS bin and fail loud.
  const escaped = pwshLiteral(args.map(quoteWin32ExecArg).join(' '));
  return [
    `$ErrorActionPreference = 'Stop'`,
    `$zc = Get-Command ${powershellQuote(binName)} -ErrorAction Stop`,
    `$ze = $zc.Source`,
    `$zr = ''`,
    `if ($zc.CommandType -ne 'Application' -or $ze -match '\\.(cmd|bat)$') {`,
    `  $zb = Split-Path $ze`,
    `  $zk = Join-Path $zb 'node_modules\\@phnx-labs\\agents-cli'`,
    `  $zl = (Get-Content -Raw (Join-Path $zk 'package.json') | ConvertFrom-Json).bin.${binName}`,
    `  if (-not $zl) { throw "agents package at $zk declares no bin.${binName}" }`,
    `  $zt = Join-Path $zk $zl`,
    `  if (-not [IO.File]::Exists($zt)) { throw "agents CLI entry not found at $zt" }`,
    `  $zd = Join-Path $zb 'node.exe'`,
    `  $ze = if ([IO.File]::Exists($zd)) { $zd } else { 'node' }`,
    `  $zr = '--no-warnings=ExperimentalWarning "' + $zt + '" '`,
    `}`,
    ...pwshNativeExecStatements('$ze', `$zr + ${escaped}`),
    `$zq = $zp.ExitCode`,
    `if ($null -eq $zq) { $zq = 1 }`,
  ].join('\n');
}

export function windowsRemotePath(p: string): string {
  const rest = homeRemainder(p);
  if (rest === null) return powershellQuote(p);
  return rest === '' ? '$HOME' : `(Join-Path $HOME ${powershellQuote(rest)})`;
}

export function windowsSetLocation(cwd: string, mirror = false): string {
  const enter = `Set-Location -LiteralPath ${windowsRemotePath(cwd)} -ErrorAction Stop`;
  return mirror ? `try { ${enter} } catch { Set-Location -LiteralPath $HOME }` : enter;
}

export function windowsAgentsScript(cmd: WindowsAgentsCommand): string {
  const { args, env, cwd, mirrorCwd = false, propagateExit = true, remapExit255 = false } = cmd;
  const parts: string[] = [POWERSHELL_PROGRESS_SILENCE, `$ErrorActionPreference = 'Stop'`];
  if (env) for (const [k, v] of Object.entries(env)) parts.push(`$env:${k} = ${powershellQuote(v)}`);
  if (cwd) parts.push(windowsSetLocation(cwd, mirrorCwd));
  parts.push(windowsAgentsInvocation(args));
  if (propagateExit) {
    if (remapExit255) parts.push('if ($zq -eq 255) { exit 254 }', 'exit $zq');
    else parts.push('exit $zq');
  }
  return parts.join('; ');
}

export function renderPowershellCommand(script: string): string {
  // The variable-free bootstrap survives cmd or PowerShell as OpenSSH's shell; compress only if shorter.
  const plain = `powershell -NoProfile -EncodedCommand ${encodePowershell(script)}`;
  const packed = zlib.deflateRawSync(Buffer.from(script, 'utf-8'), { level: 9 }).toString('base64');
  const bootstrap = 'iex ([IO.StreamReader]::new([IO.Compression.DeflateStream]::new('
    + `[IO.MemoryStream]::new([Convert]::FromBase64String('${packed}')),`
    + '[IO.Compression.CompressionMode]::Decompress),[Text.Encoding]::UTF8).ReadToEnd())';
  const compressed = `powershell -NoProfile -Command "${bootstrap}"`;
  return compressed.length < plain.length ? compressed : plain;
}

export function buildWindowsAgentsCommand(cmd: WindowsAgentsCommand): string {
  return renderPowershellCommand(windowsAgentsScript(cmd));
}

export function buildWindowsStdinAgentsCommand(args: string[]): string {
  // Create stdin payloads inside try and always remove the possibly secret-bearing file in finally.
  const forwarded = args.map(powershellQuote).join(' ');
  const script = [
    POWERSHELL_PROGRESS_SILENCE,
    '$in = [Console]::In.ReadToEnd()',
    '$tmp = $null',
    `try { $tmp = [System.IO.Path]::GetTempFileName(); [System.IO.File]::WriteAllText($tmp, $in); ` +
      `& agents ${forwarded} --from $tmp; $code = $LASTEXITCODE } ` +
      `finally { if ($tmp) { Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue } }`,
    'if ($null -eq $code) { $code = 1 }',
    'exit $code',
  ].join('; ');
  return `powershell -NoProfile -EncodedCommand ${encodePowershell(script)}`;
}

export function buildWindowsStdinImportCommand(bundle: string, opts: { force?: boolean; policyNever?: boolean } = {}): string {
  const force = opts.force ? ' --force' : '';
  const policy = opts.policyNever ? ' --policy never --i-understand' : '';
  const script = [
    POWERSHELL_PROGRESS_SILENCE,
    '$in = [Console]::In.ReadToEnd()',
    '$tmp = $null',
    `try { $tmp = [System.IO.Path]::GetTempFileName(); [System.IO.File]::WriteAllText($tmp, $in); ` +
      `& agents secrets import ${powershellQuote(bundle)} --from $tmp${force}${policy}; $code = $LASTEXITCODE } ` +
      `finally { if ($tmp) { Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue } }`,
    'if ($null -eq $code) { $code = 1 }',
    'exit $code',
  ].join('; ');
  return `powershell -NoProfile -EncodedCommand ${encodePowershell(script)}`;
}
