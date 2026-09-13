/**
 * Pure argv helpers for `--device` passthrough — build the remote `agents …`
 * invocation and strip the local-only routing flags before forwarding.
 *
 * Kept free of any SSH/process side effects so the two-layer quoting and the
 * flag-stripping edge cases (glued short forms, `=value`, variadic) are unit
 * testable without a live host. The transport itself lives in `ssh-exec.ts`
 * (`sshExec`/`sshStream`); orchestration lives in `passthrough.ts`.
 */

import { shellQuote } from '../ssh-exec.js';
import { pwshLiteral, pwshNativeExecStatements } from '../pwsh.js';
import { quoteWin32ExecArg } from '../platform/exec.js';
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

/**
 * Remove routing flags (and their values) from a command's args, leaving the
 * rest untouched and in order so they forward verbatim to the remote binary.
 * Handles every form commander accepts: `--host h`, `--host=h`, `-H h`, `-H=h`,
 * and the glued short form `-Hh`.
 *
 * @param args the command's args (already past the command name).
 */
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

/**
 * The routing flags every `--device`-capable command shares. Stripped before
 * forwarding so the flag never leaks to the remote binary (which would
 * re-trigger routing). `--host`/`-H` are kept for backward-compat strip only
 * (they are no longer user-facing routing flags).
 */
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

/**
 * The forwarding contract for `agents run … --device`: every option of the `run`
 * command is classified here, keyed by its commander attribute name. A
 * commander-introspection test (run-forwarding.test.ts) fails when a run
 * option is missing from this table, so a new option can never silently drop
 * at the SSH boundary again — the exact bug this table exists to prevent
 * (--secrets/--effort/--env/--timeout historically vanished on --host runs
 * with no error).
 *
 * Rejections are value-aware at the call site (exec.ts): `--secrets` only
 * rejects when a bundle was actually passed, `--resume` only when bare.
 */
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
  // The notification must land on the box the PERSON is at — the one that
  // dispatched — not on a headless worker with no desktop to post to. The local
  // process follows the remote run to completion, so its exit handler fires at
  // the right moment anyway.
  notify: 'local-only',
  // --no-trace-sync (traceSync=false) gates the LOCAL run-exit trace auto-sync,
  // which only arms for local runs anyway (exec.ts skips it for --device/--lease).
  // On a --device dispatch the remote box runs its own run-exit sync, so this
  // flag is never forwarded — it is a local-exit-behavior toggle, not remote.
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

/**
 * Build the single command string for `ssh <target> <cmd>`. The forwarded args
 * are quoted for the inner login shell, then the whole `agents …` invocation is
 * quoted again so it survives `bash -lc <...>` — `bash -lc` so the remote login
 * PATH resolves `agents`. An optional `cd` runs first for `--remote-cwd`.
 *
 * `os` selects the remote shell dialect: a Windows target gets a PowerShell
 * invocation instead (ssh lands in cmd.exe/PowerShell there, where `bash -lc`
 * does not exist). Anything else — including an unknown/absent OS — keeps the
 * POSIX form, so linux/macos are byte-for-byte unchanged.
 */
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

/**
 * Keys whose values are trusted-static and legitimately need remote shell
 * expansion — `PATH` references the remote `$HOME`/`$PATH`. Every other key is
 * rendered as a shell literal, so an attacker-influenceable value (notably actor
 * provenance, whose name/email can come from a tailnet peer's whois or an
 * unvalidated `AGENTS_ACTOR_*` env var) can never inject shell into a dispatch.
 */
const EXPAND_KEYS = new Set(['PATH']);

/**
 * Build a POSIX `export K=V; …` prefix from an env map — empty string when the
 * map is missing or empty. Values are rendered as shell LITERALS by default
 * (single-quoted via {@link shellQuote}), so a `$(...)` or backtick in a value
 * can never execute on the SSH target. Only {@link EXPAND_KEYS} (`PATH`) keep the
 * expanding double-quote form (`\` and `"` escaped) so the remote `$HOME`/`$PATH`
 * still resolve. Shared by {@link buildRemoteAgentsInvocation} and the
 * detached/interactive dispatch builders (dispatch.ts) so every remote path
 * exports env identically.
 */
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

/**
 * Pick the remote shell dialect from a recorded OS/platform string. A Windows
 * host (device-registry `platform: 'windows'`, or an enrolled `HostEntry.os`
 * that reads `windows`/`Windows`/`win32`/…) speaks PowerShell; everything else,
 * including `undefined`/unknown, defaults to POSIX so linux/macos never regress.
 */
export function remoteShellFor(os: string | undefined): RemoteShell {
  return /^win/i.test((os ?? '').trim()) ? 'powershell' : 'posix';
}

/**
 * PowerShell single-quoted literal: wrap in `'…'` and double any embedded `'`.
 * Single-quoted PS strings are fully literal (no `$var`, no backtick escapes),
 * so this neutralises every metacharacter the same way POSIX `shellQuote` does.
 */
export function powershellQuote(s: string): string {
  return "'" + s.replace(/'/g, "''") + "'";
}

/**
 * Encode a PowerShell script for `powershell -EncodedCommand`: base64 of its
 * UTF-16LE bytes. The payload is a bare base64 word (no spaces or shell
 * metacharacters), so it survives being handed to ssh as a single argument and
 * re-parsed by the remote's cmd.exe/PowerShell with zero quoting hazards —
 * the robust way to ship a complex command to a Windows box over SSH.
 */
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
  /**
   * Append `exit $LASTEXITCODE` so a native `agents` exit code propagates out
   * through `powershell.exe` (which otherwise exits 0 regardless). Default true;
   * pass false for probes whose reachability keys off a sentinel, not the code.
   */
  propagateExit?: boolean;
  /** Remap a reached peer command's 255 to 254 so SSH's own 255 stays unambiguous. */
  remapExit255?: boolean;
}

/**
 * The PowerShell script (pre-encoding) that {@link buildWindowsAgentsCommand}
 * runs. Exposed so tests can decode the `-EncodedCommand` payload and compare
 * against the exact script, without needing PowerShell on the test host.
 *
 * `& agents …` invokes the CLI from the machine PATH (Windows has no login
 * shell, so there is no `bash -lc` equivalent — the shim is simply on PATH).
 */
/**
 * PowerShell prelude that silences the progress stream. PowerShell 5.1 serializes
 * progress records ("Preparing modules for first use.") to CLIXML when stderr is a
 * redirected pipe (an ssh capture, not a console), so a remote `agents …` result
 * otherwise comes back wrapped in a raw `#< CLIXML <Objs …>` blob — unreadable to
 * humans and to the JSON parsers that consume doctor / fleet-status output. Prepend
 * this to EVERY Windows script that invokes `agents` (there is more than one builder
 * in this file). Verified against a live win-mini (PowerShell 5.1): this clears it.
 * (`-OutputFormat Text` does NOT — it governs success-stream object serialization,
 * not the progress stream.)
 */
export const POWERSHELL_PROGRESS_SILENCE = "$ProgressPreference = 'SilentlyContinue'";

/**
 * Strip a PowerShell CLIXML wrapper from stdout relayed off a Windows host.
 *
 * PowerShell 5.1 serializes progress / error / verbose records to CLIXML when a
 * stream is a redirected pipe (an ssh capture, not a console): a `#< CLIXML`
 * banner followed by one or more `<Objs …>…</Objs>` elements. {@link
 * POWERSHELL_PROGRESS_SILENCE} suppresses the common "Preparing modules for
 * first use." progress record at the source, but a Windows peer reached WITHOUT
 * that prelude — a raw `agents ssh <win> 'agents … --json'`, an older peer, or a
 * record on a stream we did not silence — can still emit the banner ahead of the
 * real payload, which breaks a naive `JSON.parse` of the relayed `--json`
 * (RUSH-2286). Remove the banner and every self-contained `<Objs …>…</Objs>`
 * block, leaving the genuine payload untouched. A no-op (returns the input
 * unchanged) when no `#< CLIXML` marker is present, so it is safe to apply on
 * every remote-JSON boundary regardless of the peer's OS.
 */
export function stripClixml(stdout: string): string {
  if (!stdout.includes('#< CLIXML')) return stdout;
  // A CLIXML flush is the `#< CLIXML` banner immediately followed by one or more
  // <Objs …>…</Objs> elements, as one contiguous block. Remove that whole unit,
  // ANCHORED to the banner: the <Objs> removal is scoped to blocks that follow a
  // banner, so a stray `<Objs>` appearing inside a legitimate JSON string value
  // (a session title/prompt that quotes CLIXML text) is never touched — stripping
  // <Objs> globally would silently delete JSON between two such substrings.
  return stdout
    .replace(/#< CLIXML[^\n]*\r?\n?(?:\s*<Objs\b[\s\S]*?<\/Objs>)*/g, '')
    .trim();
}

/**
 * Statements that run the Agents CLI on a Windows peer with EXACT argv, leaving the
 * child's exit code in `$__code`.
 *
 * `& agents …` cannot be used, and the reason is not our quoting. On Windows
 * `agents` is an npm-generated `agents.ps1`, whose body ends in
 *
 *     & "node$exe" --no-warnings=… "$basedir/node_modules/@phnx-labs/agents-cli/dist/index.js" $args
 *
 * — `$args` splatted into a NATIVE program, which is the PowerShell 5.1 lossy
 * serializer. So the loss happens INSIDE the user's shim, after our tokens were
 * already correct: measured on a real peer, `no-such-"menu"-proof` reached the
 * Agents parser as `no-such-menu-proof`. Quoting harder upstream cannot fix that,
 * and rewriting a user's npm shim is not ours to do.
 *
 * Instead the shim is bypassed the same way `getCliLaunch` (`lib/cli-entry.ts`)
 * resolves a launch locally: a node-script entry becomes `<node> <entry> …args`.
 * The entry and runtime are resolved ON THE PEER from the launcher's own location —
 * the identical two-step the shim itself performs — and executed through .NET with
 * a `CommandLineToArgvW`-escaped argument string.
 *
 * A peer whose `agents` is already a native executable is used directly. A peer
 * where neither resolves FAILS LOUD: falling back to `& agents` would silently
 * restore the argument loss, which is worse than an error naming what is missing.
 *
 * The entry comes from the package's DECLARED `bin` rather than a literal
 * `dist/index.js`, so it follows the package instead of needing to be kept in sync
 * with it.
 */
export function windowsAgentsInvocation(args: string[], binName: 'agents' | 'ag' = 'agents'): string {
  const escaped = pwshLiteral(args.map(quoteWin32ExecArg).join(' '));
  return [
    // Set before any resolution: a non-terminating failure below would otherwise
    // leave the exit code null, and `exit $null` reports 0.
    `$ErrorActionPreference = 'Stop'`,
    `$zc = Get-Command ${powershellQuote(binName)} -ErrorAction Stop`,
    `$ze = $zc.Source`,
    `$zr = ''`,
    // A real native executable needs no interpreter prefix. `CommandType` alone is
    // NOT that test: `Get-Command` reports `Application` for `agents.cmd` too, and
    // a .cmd launcher re-parses through cmd.exe with the same argument loss as the
    // .ps1 one — so a cmd-only install must not bypass this either.
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

export function windowsAgentsScript(cmd: WindowsAgentsCommand): string {
  const { args, env, cwd, propagateExit = true, remapExit255 = false } = cmd;
  // `Stop` FIRST, before the env assignments and the Set-Location: a failing
  // `Set-Location` (a cwd that does not exist on the peer) must abort rather than
  // continue into the launcher and run the command in the wrong directory.
  const parts: string[] = [POWERSHELL_PROGRESS_SILENCE, `$ErrorActionPreference = 'Stop'`];
  if (env) for (const [k, v] of Object.entries(env)) parts.push(`$env:${k} = ${powershellQuote(v)}`);
  if (cwd) parts.push(`Set-Location -LiteralPath ${powershellQuote(cwd)}`);
  parts.push(windowsAgentsInvocation(args));
  if (propagateExit) {
    if (remapExit255) parts.push('if ($zq -eq 255) { exit 254 }', 'exit $zq');
    else parts.push('exit $zq');
  }
  return parts.join('; ');
}

/**
 * Build the `ssh <target> <cmd>` string for one `agents …` invocation on a
 * Windows remote: a `powershell -NoProfile -EncodedCommand <base64>` call. The
 * Windows counterpart of `bash -lc '<...>'`, shared by every `--device` site.
 */
/**
 * Render a PowerShell script as the single command string ssh sends to a Windows
 * peer, compressing it when that is genuinely shorter.
 *
 * The plain route is `-EncodedCommand <base64 of UTF-16LE>`, which inflates the
 * script by ~2.67x. That matters because OpenSSH-for-Windows caps the whole remote
 * command far below cmd.exe's 8191 — bisected against a live peer, 2934 characters
 * succeed and 3102 fail — so a longer script eats the headroom a caller's
 * arguments, `--remote-cwd` and forwarded env need.
 *
 * The alternative is to deflate the UTF-8 script and emit a small fixed bootstrap
 * that inflates it back. That trades ~2.67x for ~1.33x on the compressible part,
 * which on scripts of this shape is a large net win. The bootstrap itself still
 * rides the ordinary `-EncodedCommand` route, so the transport, quoting and stdin
 * behaviour are untouched — only the payload representation changes.
 *
 * Applied ONLY when the result is actually shorter: for a small script the fixed
 * bootstrap costs more than it saves, so picking the shorter of the two keeps the
 * plain form in play for every small caller and is obviously correct either way.
 */
export function renderPowershellCommand(script: string): string {
  const plain = `powershell -NoProfile -EncodedCommand ${encodePowershell(script)}`;
  // Raw DEFLATE (RFC 1951) — what .NET's `DeflateStream` reads. `deflateSync`
  // would prepend a zlib header that `DeflateStream` rejects.
  // Raw DEFLATE (RFC 1951) — what .NET's `DeflateStream` reads. `deflateSync`
  // would prepend a zlib header that `DeflateStream` rejects.
  const packed = zlib.deflateRawSync(Buffer.from(script, 'utf-8'), { level: 9 }).toString('base64');
  // The blob is embedded DIRECTLY in a `-Command` string rather than wrapped in a
  // second `-EncodedCommand`: routing an already-base64 payload through the encoded
  // form would inflate it by another 2.67x and cancel most of the compression.
  //
  // The bootstrap is deliberately VARIABLE-FREE — one nested expression, no `$`
  // anywhere. A `$b = …` form is unsafe here: OpenSSH-for-Windows may have
  // PowerShell as its `DefaultShell`, in which case the outer double-quoted string
  // is parsed by PowerShell first and `$b` would be expanded before our script ever
  // runs. With no `$`, no `%`, no backtick and no cmd metacharacter — base64's
  // alphabet is `A-Za-z0-9+/=` and the rest is ASCII punctuation neither shell
  // touches inside quotes — the same text survives either default shell. stdin is
  // untouched by both routes.
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

/**
 * Build the `ssh <target> <cmd>` string for `agents secrets import` on a Windows
 * remote where the `.env` is piped over ssh stdin.
 *
 * We can't just run `agents secrets import <bundle> --from -`: the npm
 * `agents.ps1` shim does NOT forward the ssh-piped stdin down to the underlying
 * node process, so a raw fd-0 read (`--from -`) hangs forever (observed: the
 * push to a Windows host times out). PowerShell ITSELF can read the pipe, so we
 * read stdin into a temp file in PowerShell, import `--from <file>` (a plain
 * file read, which the shim handles fine), and delete the temp file afterwards
 * — success or failure. Backend defaults to the platform native store
 * (Credential Manager, or the headless file store when there's no logon
 * session), matching a local `agents secrets import`.
 */
/**
 * Run `agents <args> --from <tmp>` on a Windows peer, feeding the ssh-piped stdin
 * through a temp file — the `agents.ps1` shim does not forward piped stdin to the
 * node process, so a verb that reads stdin must be handed a file instead. The
 * generic sibling of {@link buildWindowsStdinImportCommand}; the receiving verb
 * MUST accept `--from <path>` (see `usage-ingest.ts`). The temp file is removed in
 * a `finally` so a throw mid-run never leaves the payload behind.
 */
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
  // Create AND write the temp file INSIDE the try so its finally always cleans
  // up: if GetTempFileName succeeds but WriteAllText (or the import) then throws,
  // the secret-bearing temp file would otherwise be left behind (RUSH-1764). $tmp
  // starts null so a GetTempFileName that itself throws leaves nothing to remove.
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
