/** Pure argv helpers for `--device` passthrough: build the remote `agents …` invocation and
 * strip local-only routing flags. No SSH side effects, so the two-layer quoting and flag edge
 * cases are unit-testable; transport is ssh-exec.ts, orchestration passthrough.ts. */

import { shellQuote } from '../ssh-exec.js';
import { pwshLiteral, pwshNativeExecStatements } from '../pwsh.js';
import { quoteWin32ExecArg } from '../platform/exec.js';
import { homeRemainder } from '../project-root.js';
import * as zlib from 'node:zlib';

/** A flag to strip from a forwarded argv, with whether it consumes a value. */
export interface StripSpec {
  /** Long form without leading dashes, e.g. `host`, `remote-cwd`. */
  long: string;
  /** Optional single-letter short form without the dash, e.g. `H`. */
  short?: string;
  /** True when the flag takes a following value token (`--device <name>`). */
  takesValue: boolean;
}

/** Remove routing flags and their values from a command's args, leaving the rest in order to
 * forward verbatim. Handles `--host h`, `--host=h`, `-H h`, `-H=h` and the glued `-Hh`. */
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
    // Consume a separate value token only for the exact-match (space-separated) forms.
    const isExact = a === `--${spec.long}` || (spec.short && a === `-${spec.short}`);
    if (spec.takesValue && isExact && i + 1 < args.length) i++;
  }
  return out;
}

/** The routing flags every `--device`-capable command shares, stripped before forwarding so they
 * cannot re-trigger routing remotely. `--host`/`-H` remain only as backward-compat strips, no
 * longer user-facing. */
export const HOST_ROUTING_SPECS: StripSpec[] = [
  { long: 'device', short: 'D', takesValue: true },
  { long: 'host', short: 'H', takesValue: true },
  { long: 'remote-cwd', takesValue: true },
];

/** How one `agents run` option behaves when the run is offloaded with `--device`. */
type RunOptionForwarding =
  /** Appended to the remote `agents run` argv — same behavior local or remote. */
  | 'forward'
  /** Refused with an actionable error BEFORE dispatch — never silently dropped. */
  | 'reject'
  /** Consumed by the dispatching side (routing, follow rendering, cwd portability). */
  | 'local-only';

/** The forwarding contract for `agents run … --device`: every `run` option is classified by
 * commander attribute name, and a commander-introspection test (run-forwarding.test.ts) fails
 * on a missing one, so none silently drops at the SSH boundary. */
export const RUN_OPTION_FORWARDING: Record<string, RunOptionForwarding> = {
  // forwarded — the remote run behaves exactly like a local one
  mode: 'forward',
  effort: 'forward',
  model: 'forward',
  env: 'forward',
  addDir: 'forward',
  name: 'forward',
  resume: 'forward', // concrete id only — bare `--resume` rejects (picker can't cross SSH)
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
  json: 'forward', // remote emits ndjson into its log; the local follow streams it verbatim
  verbose: 'forward',
  yes: 'forward', // a detached remote run can't answer the budget-confirm prompt
  acp: 'forward', // the remote CLI routes through ACP on ITS side of the wire
  autoSecrets: 'forward', // workflow frontmatter secrets resolve on the REMOTE keychain
  emitSessionId: 'forward', // remote prints its session id as a stdout sentinel the launcher captures (session-marker.ts)

  // rejected — cannot cross the SSH boundary; fail loud, never degrade
  terminal: 'reject', // opens a tab on THIS machine's desktop; a remote tab is a different request
  secrets: 'reject',
  secretsKeys: 'reject',
  allowExpired: 'reject',
  resumeCheckpoint: 'reject',

  // local-only — routing, dispatch-path choice, and follow rendering
  quiet: 'local-only', // the remote argv always carries --quiet
  headless: 'local-only',
  interactive: 'local-only', // the interactive path forwards --interactive itself
  cwd: 'local-only', // made portable into remoteCwd
  project: 'local-only',
  remoteCwd: 'local-only',
  raw: 'local-only', // interactive builder forwards --raw itself
  tmux: 'local-only',
  disableTmux: 'local-only',
  device: 'local-only',
  where: 'local-only', // expands into host/lease before dispatch; never re-forwarded
  local: 'local-only', // this machine by definition — a local run never reaches the SSH boundary
  on: 'local-only',
  computer: 'local-only',
  any: 'local-only',
  follow: 'local-only',
  lease: 'local-only',
  box: 'local-only',
  keepBox: 'local-only',
  fresh: 'local-only', // skips the warm-pool reuse for --lease; the lease path is always local
  reuse: 'local-only', // reuse-picker choice for --lease; the lease path is always local
  bare: 'local-only', // skips the local setup-copy push; lease-only concern
  tailscale: 'local-only', // --tailscale/--no-tailscale gate the lease net mode; never forwarded
  copyCreds: 'local-only', // copies creds TO the host before dispatch — local concern only
  // Cloud placement: chosen and dispatched from THIS machine via the provider
  // registry; mutually exclusive with --device (placement conflict dies before
  // dispatch), so these never have a remote argv to ride.
  cloud: 'local-only',
  provider: 'local-only',
  repo: 'local-only',
  branch: 'local-only',
  cloudEnv: 'local-only',
  authCheck: 'local-only', // --no-auth-check gates the local interactive login preflight; --host runs skip that preflight entirely
  // The notification must land on the box the person is at (the dispatcher), not a headless worker;
  // the local process follows the run to completion, so its exit handler fires at the right moment.
  notify: 'local-only',
  // --no-trace-sync gates the local run-exit trace auto-sync, which exec.ts skips for
  // --device/--lease; the remote box runs its own, so this local-exit toggle is never forwarded.
  traceSync: 'local-only',
  // Broadcast mode (agents run --broadcast) is its own fan-out dispatch — mutually
  // exclusive with --host. All broadcast options are local-only; exec.ts handles them
  // before any SSH dispatch path is reached.
  broadcast: 'local-only',
  task: 'local-only',
  listTasks: 'local-only',
  results: 'local-only',
  concurrency: 'local-only',
};

/** Actionable messages for value-aware rejections, keyed by attribute name. */
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

/** Build the command string for `ssh <target> <cmd>`: args quoted for the inner login shell,
 * then the whole `agents …` invocation quoted again for `bash -lc` (so login PATH resolves
 * `agents`), with an optional `cd` for `--remote-cwd`. A Windows `os` gets PowerShell. */
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
  // Prepend env exports so the remote command sees the shims dir even when the
  // login shell hasn't sourced the interactive rc files that usually add it.
  const exports = posixEnvExports(env);
  if (!exports) {
    return `bash -lc ${shellQuote(withCwd)}`;
  }
  return `bash -lc ${shellQuote(`${exports}; ${withCwd}`)}`;
}

/** Keys whose trusted-static values need remote shell expansion (`PATH` references the remote
 * `$HOME`/`$PATH`). Every other key is a shell literal, so attacker-influenceable values (actor
 * name/email from whois or `AGENTS_ACTOR_*`) can never inject shell into a dispatch. */
const EXPAND_KEYS = new Set(['PATH']);

/** Build a POSIX `export K=V; …` prefix from an env map. Values are single-quoted literals
 * (shellQuote) so `$(...)` or backticks never execute remotely; only EXPAND_KEYS (`PATH`) keep
 * the expanding form. Shared with dispatch.ts so every remote path exports identically. */
export function posixEnvExports(env?: Record<string, string>): string {
  if (!env || Object.keys(env).length === 0) return '';
  return Object.entries(env)
    .map(([k, v]) =>
      EXPAND_KEYS.has(k)
        ? `export ${shellQuote(k)}="${v.replace(/[\\"]/g, '\\$&')}"`
        : `export ${shellQuote(k)}=${shellQuote(v)}`,
    )
    .join('; ');
}

/** The two remote shell dialects we build commands for. */
type RemoteShell = 'posix' | 'powershell';

/** Pick the remote shell dialect from a recorded OS/platform string: Windows
 * (`windows`/`win32`/…) speaks PowerShell; everything else, including unknown, is POSIX. */
export function remoteShellFor(os: string | undefined): RemoteShell {
  return /^win/i.test((os ?? '').trim()) ? 'powershell' : 'posix';
}

/** PowerShell single-quoted literal: wrap in `'…'` and double embedded `'`; fully literal (no
 * `$var`, no backtick escapes), like POSIX `shellQuote`. */
export function powershellQuote(s: string): string {
  return "'" + s.replace(/'/g, "''") + "'";
}

/** Encode a PowerShell script for `-EncodedCommand` (base64 of UTF-16LE). The bare base64 word
 * has no spaces or metacharacters, so it survives as one ssh argument and the remote
 * cmd.exe/PowerShell re-parse with no quoting hazards. */
export function encodePowershell(script: string): string {
  return Buffer.from(script, 'utf16le').toString('base64');
}

/** Inverse of {@link encodePowershell} — decode an `-EncodedCommand` payload
 * back to its script. Used by tests to assert on the built command. */
export function decodePowershell(encoded: string): string {
  return Buffer.from(encoded, 'base64').toString('utf16le');
}

/** A single `agents …` invocation to run on a Windows remote. */
interface WindowsAgentsCommand {
  /** `agents` argv (command name NOT included; `agents` is prepended). */
  args: string[];
  /** Env vars scoped to this invocation (POSIX `VAR=val` ↔ PS `$env:VAR=…`). */
  env?: Record<string, string>;
  /** Directory to enter before running (`--remote-cwd`). */
  cwd?: string;
  /** `cwd` was derived from the local cwd, not named by the user (see `deriveMirroredCwd`): a
   * directory the peer lacks falls back to `$HOME` instead of failing the run, like
   * `remoteCdPrefix({ mirror })`. */
  mirrorCwd?: boolean;
  /** Append `exit $LASTEXITCODE` so a native `agents` exit code propagates out of
   * `powershell.exe` (which otherwise exits 0). Default true; pass false for probes keyed off a
   * sentinel. */
  propagateExit?: boolean;
  /** Remap a reached peer command's 255 to 254 so SSH's own 255 stays unambiguous. */
  remapExit255?: boolean;
}

/** The PowerShell script (pre-encoding) that buildWindowsAgentsCommand runs, exposed so tests
 * can decode the payload without PowerShell. `& agents …` uses the machine PATH since Windows
 * has no login shell equivalent to `bash -lc`. */
/** Prelude silencing PowerShell's progress stream: 5.1 serializes progress to CLIXML on a
 * redirected stderr (ssh), wrapping a remote `agents …` result in a `#< CLIXML` blob that
 * breaks humans and JSON parsers. Prepend to every Windows script invoking `agents`. */
export const POWERSHELL_PROGRESS_SILENCE = "$ProgressPreference = 'SilentlyContinue'";

/** Strip a PowerShell CLIXML wrapper (`#< CLIXML` banner plus `<Objs …>…</Objs>`) from stdout
 * relayed off a Windows host; a peer reached without POWERSHELL_PROGRESS_SILENCE can break
 * `JSON.parse` (RUSH-2286). A no-op without the marker, so safe at every remote-JSON boundary. */
export function stripClixml(stdout: string): string {
  if (!stdout.includes('#< CLIXML')) return stdout;
  // Remove the banner plus the `<Objs …>…</Objs>` elements that follow it as one unit, anchored to
  // the banner, so a stray `<Objs>` inside a JSON string value (e.g. a session title quoting
  // CLIXML) is never touched; a global strip would delete JSON between two such substrings.
  return stdout
    .replace(/#< CLIXML[^\n]*\r?\n?(?:\s*<Objs\b[\s\S]*?<\/Objs>)*/g, '')
    .trim();
}

/** Run the Agents CLI on a Windows peer with exact argv, exit code in `$zq`. `& agents …` loses
 * quotes (the npm `agents.ps1` shim splats `$args` into a native program), so resolve node and
 * the `bin` entry on the peer and run via .NET. If neither resolves, fail loud; never `& agents`. */
export function windowsAgentsInvocation(args: string[], binName: 'agents' | 'ag' = 'agents'): string {
  const escaped = pwshLiteral(args.map(quoteWin32ExecArg).join(' '));
  return [
    // Set before any resolution: a non-terminating failure below would otherwise
    // leave the exit code null, and `exit $null` reports 0.
    `$ErrorActionPreference = 'Stop'`,
    `$zc = Get-Command ${powershellQuote(binName)} -ErrorAction Stop`,
    `$ze = $zc.Source`,
    `$zr = ''`,
    // A native executable needs no interpreter prefix, but `CommandType` alone is not that test:
    // `Get-Command` reports `Application` for `agents.cmd` too, and a .cmd launcher re-parses
    // through cmd.exe with the same argument loss.
    `if ($zc.CommandType -ne 'Application' -or $ze -match '\\.(cmd|bat)$') {`,
    `  $zb = Split-Path $ze`,
    `  $zk = Join-Path $zb 'node_modules\\@phnx-labs\\agents-cli'`,
    // The package's DECLARED bin, so the entry follows the package rather than a
    // hand-synced `dist/index.js` literal that would rot on upgrade. One check
    // covers a missing bin AND the single-string `bin` form (which yields $null).
    `  $zl = (Get-Content -Raw (Join-Path $zk 'package.json') | ConvertFrom-Json).bin.${binName}`,
    `  if (-not $zl) { throw "agents package at $zk declares no bin.${binName}" }`,
    `  $zt = Join-Path $zk $zl`,
    `  if (-not [IO.File]::Exists($zt)) { throw "agents CLI entry not found at $zt" }`,
    // The npm shim prefers a node.exe beside itself before PATH; match that.
    `  $zd = Join-Path $zb 'node.exe'`,
    `  $ze = if ([IO.File]::Exists($zd)) { $zd } else { 'node' }`,
    // A Windows path cannot contain `"`, so wrapping is sufficient escaping here.
    `  $zr = '--no-warnings=ExperimentalWarning "' + $zt + '" '`,
    `}`,
    ...pwshNativeExecStatements('$ze', `$zr + ${escaped}`),
    // Reported through a plain variable rather than by assigning the automatic
    // $LASTEXITCODE, which nothing set here since no PowerShell command ran.
    `$zq = $zp.ExitCode`,
    // Never let an unknown outcome read as success.
    `if ($null -eq $zq) { $zq = 1 }`,
  // NEWLINE-joined, and that is required rather than stylistic: the caller joins
  // its parts with `'; '`, which between a closing `}` and `else`/an indented block
  // would produce invalid PowerShell.
  ].join('\n');
}

/** PowerShell expression for a remote path: a home-anchored path (`~/x`, `$HOME/x`) re-roots
 * onto the peer's `$HOME` via `Join-Path` (the counterpart of `remoteCdPrefix`), so a mirrored
 * directory resolves; any other path is quoted verbatim. */
export function windowsRemotePath(p: string): string {
  const rest = homeRemainder(p);
  if (rest === null) return powershellQuote(p);
  return rest === '' ? '$HOME' : `(Join-Path $HOME ${powershellQuote(rest)})`;
}

/** The `Set-Location` step of a Windows remote command. `-ErrorAction Stop` is explicit because
 * a missing directory is a non-terminating error that `try`/`catch` would miss: the mirrored
 * form must land in `$HOME`, and the explicit form must abort rather than run elsewhere. */
export function windowsSetLocation(cwd: string, mirror = false): string {
  const enter = `Set-Location -LiteralPath ${windowsRemotePath(cwd)} -ErrorAction Stop`;
  return mirror ? `try { ${enter} } catch { Set-Location -LiteralPath $HOME }` : enter;
}

export function windowsAgentsScript(cmd: WindowsAgentsCommand): string {
  const { args, env, cwd, mirrorCwd = false, propagateExit = true, remapExit255 = false } = cmd;
  // `Stop` FIRST, before the env assignments and the Set-Location: a failing
  // `Set-Location` (a cwd that does not exist on the peer) must abort rather than
  // continue into the launcher and run the command in the wrong directory.
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

/** Build the `ssh <target> <cmd>` string for one `agents …` invocation on a Windows remote: a
 * rendered `powershell -NoProfile` call, the counterpart of `bash -lc '<...>'` shared by every
 * `--device` site. */
/** Render a PowerShell script as the ssh command for a Windows peer, compressing only when
 * shorter. `-EncodedCommand` inflates ~2.67x and OpenSSH-for-Windows caps the command far below
 * 8191 (2934 pass, 3102 fail), so a bootstrap inflating a deflated payload (~1.33x) is used. */
export function renderPowershellCommand(script: string): string {
  const plain = `powershell -NoProfile -EncodedCommand ${encodePowershell(script)}`;
  // Raw DEFLATE (RFC 1951) — what .NET's `DeflateStream` reads. `deflateSync`
  // would prepend a zlib header that `DeflateStream` rejects.
  const packed = zlib.deflateRawSync(Buffer.from(script, 'utf-8'), { level: 9 }).toString('base64');
  // The blob goes in a `-Command` string, not a second `-EncodedCommand` (another 2.67x). The
  // bootstrap is variable-free (no `$`, `%`, backtick or cmd metacharacter): with PowerShell as
  // OpenSSH's `DefaultShell`, `$b = …` would expand early, and the text must survive either shell.
  const bootstrap = 'iex ([IO.StreamReader]::new([IO.Compression.DeflateStream]::new('
    + `[IO.MemoryStream]::new([Convert]::FromBase64String('${packed}')),`
    + '[IO.Compression.CompressionMode]::Decompress),[Text.Encoding]::UTF8).ReadToEnd())';
  const compressed = `powershell -NoProfile -Command "${bootstrap}"`;
  // Only when genuinely shorter: for a small script the fixed bootstrap costs more
  // than it saves, so this keeps the plain form in play for every small caller.
  return compressed.length < plain.length ? compressed : plain;
}

export function buildWindowsAgentsCommand(cmd: WindowsAgentsCommand): string {
  return renderPowershellCommand(windowsAgentsScript(cmd));
}

/** Build the ssh command for `agents secrets import` on a Windows remote with `.env` piped over
 * stdin. The npm `agents.ps1` shim drops piped stdin so `--from -` hangs; PowerShell reads
 * stdin into a temp file, imports `--from <file>` and always deletes it. */
/** Run `agents <args> --from <tmp>` on a Windows peer, feeding ssh-piped stdin through a temp
 * file since the `agents.ps1` shim drops it. Generic sibling of buildWindowsStdinImportCommand;
 * the verb must accept `--from <path>` (see `usage-ingest.ts`). */
export function buildWindowsStdinAgentsCommand(args: string[]): string {
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
  // Create and write the temp file inside the try so its finally always cleans up; otherwise a
  // failure after GetTempFileName would leave the secret-bearing file behind (RUSH-1764). $tmp
  // starts null so a throwing GetTempFileName leaves nothing to remove.
  const script = [
    // Same CLIXML guard as windowsAgentsScript — this builder also runs `& agents …`
    // and its raw stderr is printed to the user on failure (secrets export --device <win>).
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
