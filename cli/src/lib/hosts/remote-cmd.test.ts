import { describe, it, expect } from 'vitest';
import { spawnSync } from 'child_process';
import { stripRoutingFlags, buildRemoteAgentsInvocation, buildWindowsAgentsCommand, buildWindowsStdinImportCommand, buildWindowsStdinAgentsCommand, posixEnvExports, remoteShellFor, powershellQuote, decodePowershell, stripClixml, HOST_ROUTING_SPECS, type StripSpec } from './remote-cmd.js';
import { decodeRenderedPowershell } from './remote-cmd.test-fixture.js';

describe('stripClixml', () => {
  // The exact banner + progress element a live win-mini (PowerShell 5.1) emits
  // ahead of relayed output — the RUSH-2286 reproduction.
  const CLIXML_BANNER =
    '#< CLIXML\n' +
    '<Objs Version="1.1.0.1" xmlns="http://schemas.microsoft.com/powershell/2004/04">' +
    '<Obj S="progress" RefId="0"><TN RefId="0"><T>System.Management.Automation.PSCustomObject</T>' +
    '<T>System.Object</T></TN><MS><I64 N="SourceId">1</I64><PR N="Record">' +
    '<AV>Preparing modules for first use.</AV><AI>0</AI><Nil /><PI>-1</PI><PC>-1</PC>' +
    '<T>Completed</T><SR>-1</SR><SD> </SD></PR></MS></Obj></Objs>';

  it('leaves clean stdout untouched (no CLIXML marker → identity)', () => {
    const json = '{"burn":{"outputTokens":123}}';
    expect(stripClixml(json)).toBe(json);
    expect(stripClixml('[]')).toBe('[]');
  });

  it('strips the banner + <Objs> block prefixed to a JSON payload so it parses', () => {
    const payload = '[{"id":"abc","outputTokens":42}]';
    const polluted = CLIXML_BANNER + '\n' + payload;
    const cleaned = stripClixml(polluted);
    expect(cleaned).toBe(payload);
    expect(() => JSON.parse(cleaned)).not.toThrow();
    expect(JSON.parse(cleaned)[0].outputTokens).toBe(42);
  });

  it('strips a CLIXML block appended after the JSON payload', () => {
    const payload = '{"burn":{"outputTokens":7}}';
    const polluted = payload + '\n' + CLIXML_BANNER;
    expect(JSON.parse(stripClixml(polluted)).burn.outputTokens).toBe(7);
  });

  it('yields empty output when the whole stream is CLIXML (no real payload)', () => {
    expect(stripClixml(CLIXML_BANNER)).toBe('');
  });

  it('strips two consecutive CLIXML flushes', () => {
    const payload = '{"outputTokens":9}';
    expect(stripClixml(CLIXML_BANNER + '\n' + CLIXML_BANNER + '\n' + payload)).toBe(payload);
  });

  it('does NOT delete a legitimate JSON value that merely quotes CLIXML text', () => {
    // A real CLIXML banner is present (so the guard fires), and the payload's own
    // string fields contain the literal substrings `<Objs` and `</Objs>`. A naive
    // global `<Objs>…</Objs>` strip would silently delete the JSON between them;
    // the banner-anchored strip must leave the payload intact.
    const payload = '{"topic":"debug <Objs> parsing","label":"</Objs> handler","outputTokens":5}';
    const cleaned = stripClixml(CLIXML_BANNER + '\n' + payload);
    const parsed = JSON.parse(cleaned);
    expect(parsed.topic).toBe('debug <Objs> parsing');
    expect(parsed.label).toBe('</Objs> handler');
    expect(parsed.outputTokens).toBe(5);
  });
});

/** Decode the PowerShell script a Windows `--device` invocation ships, by pulling
 * the base64 payload off `powershell -NoProfile -EncodedCommand <b64>` and
 * reversing the UTF-16LE encoding — the exact bytes the remote PowerShell runs. */
const decodeWindows = decodeRenderedPowershell;

const SPECS: StripSpec[] = [...HOST_ROUTING_SPECS, { long: 'no-tty', takesValue: false }];

/**
 * Decode the argv the *remote* would actually receive. `buildRemoteAgentsInvocation`
 * emits `bash -lc '<...>'`; ssh hands that to the remote login shell, which runs it.
 * We reproduce that exactly with an `agents` shim that prints each arg on its own
 * line, so stdout == the remote argv — the true end-to-end check of the two-layer
 * quoting (injection-safety).
 */
function decodeRemoteArgv(forwarded: string[], remoteCwd?: string): string[] {
  const shim = `agents() { for a in "$@"; do printf '%s\\n' "$a"; done; }; export -f agents; cd /; `;
  const res = spawnSync('bash', ['-c', shim + buildRemoteAgentsInvocation(forwarded, remoteCwd)], {
    encoding: 'utf-8',
  });
  expect(res.status).toBe(0);
  return res.stdout.split('\n').slice(0, -1);
}

describe('stripRoutingFlags', () => {
  it('keeps the command name and drops --device with a separate value', () => {
    expect(stripRoutingFlags(['view', '--device', 'mac', 'claude'], SPECS)).toEqual(['view', 'claude']);
  });

  it('drops the --host=value glued form', () => {
    expect(stripRoutingFlags(['view', '--host=mac', '--json'], SPECS)).toEqual(['view', '--json']);
  });

  it('drops -H (legacy --host short form) with a separate value and the glued form', () => {
    expect(stripRoutingFlags(['view', '-H', 'mac'], SPECS)).toEqual(['view']);
    expect(stripRoutingFlags(['view', '-Hmac', '--json'], SPECS)).toEqual(['view', '--json']);
  });

  it('drops --remote-cwd and its value but keeps other flags in order', () => {
    expect(stripRoutingFlags(['sync', 'claude', '--remote-cwd', '/srv/app', '--yes'], SPECS)).toEqual([
      'sync',
      'claude',
      '--yes',
    ]);
  });

  it('drops --device and its value so it never leaks to the remote binary', () => {
    // --device forwarded to the remote would re-trigger routing there.
    // Both space and =value forms are stripped.
    expect(stripRoutingFlags(['message', 'abc', 'hi', '--device', 'yosemite-s0'], SPECS)).toEqual([
      'message',
      'abc',
      'hi',
    ]);
    expect(stripRoutingFlags(['message', 'abc', 'hi', '--device=yosemite-s0'], SPECS)).toEqual([
      'message',
      'abc',
      'hi',
    ]);
  });

  it('drops -D (--device short form) with a separate value and the glued form', () => {
    expect(stripRoutingFlags(['view', '-D', 'mac'], SPECS)).toEqual(['view']);
    expect(stripRoutingFlags(['view', '-Dmac', '--json'], SPECS)).toEqual(['view', '--json']);
  });

  it('drops the valueless --no-tty without consuming the next token', () => {
    expect(stripRoutingFlags(['view', '--no-tty', 'claude'], SPECS)).toEqual(['view', 'claude']);
  });

  it('does not mistake a positional that merely contains "host" for the flag', () => {
    expect(stripRoutingFlags(['teams', 'add', 't', 'claude', 'fix the host header', '--device', 'mac'], SPECS)).toEqual([
      'teams',
      'add',
      't',
      'claude',
      'fix the host header',
    ]);
  });
});

describe('buildRemoteAgentsInvocation (two-layer quoting is injection-safe)', () => {
  it('round-trips ordinary args through ssh + bash -lc unchanged', () => {
    expect(decodeRemoteArgv(['view', 'claude'])).toEqual(['view', 'claude']);
  });

  it('preserves args with spaces as single argv entries', () => {
    expect(decodeRemoteArgv(['teams', 'add', 't', 'claude', 'refactor the parser'])).toEqual([
      'teams',
      'add',
      't',
      'claude',
      'refactor the parser',
    ]);
  });

  it('neutralizes shell metacharacters — no command substitution executes', () => {
    expect(decodeRemoteArgv(['view', '$(whoami); rm -rf /', '--json'])).toEqual([
      'view',
      '$(whoami); rm -rf /',
      '--json',
    ]);
  });

  it('prefixes a cd for --remote-cwd without leaking it into argv', () => {
    // The shim's cwd change is observable only via the cd prefix; argv stays clean.
    expect(decodeRemoteArgv(['view'], '/tmp')).toEqual(['view']);
  });
});

describe('secrets export --device push command (cross-platform)', () => {
  // The keychain export push drives `agents secrets import --from -` on the
  // remote (`--from -` reads the .env off ssh stdin — the cross-platform
  // replacement for the POSIX-only `/dev/stdin`; `import` auto-creates the
  // bundle so there is no `create … || true`, the POSIXism that broke on
  // PowerShell with `'true' is not recognized`).
  const importArgs = ['secrets', 'import', 'mybundle', '--from', '-'];

  it('POSIX target: bash -lc agents secrets import --from - (no /dev/stdin, no || true)', () => {
    // The remote actually receives these exact argv entries (shim round-trip).
    expect(decodeRemoteArgv(importArgs)).toEqual(['secrets', 'import', 'mybundle', '--from', '-']);
    const cmd = buildRemoteAgentsInvocation(importArgs, undefined, 'linux');
    expect(cmd).toBe(`bash -lc 'agents secrets import mybundle --from -'`);
    expect(cmd).not.toContain('/dev/stdin');
    expect(cmd).not.toContain('|| true');
  });

  it('Windows target: PowerShell EncodedCommand runs the same import (no bash, no /dev/stdin)', () => {
    const cmd = buildRemoteAgentsInvocation(importArgs, undefined, 'windows');
    const script = decodeWindows(cmd);
    expect(script.startsWith(`$ProgressPreference = 'SilentlyContinue'; `)).toBe(true);
    expect(launcherArgs(script)).toBe('secrets import mybundle --from -');
    expect(script.endsWith('exit $zq')).toBe(true);
    expect(script).not.toContain('/dev/stdin');
    expect(script).not.toContain('|| true');
    expect(script).not.toContain('bash');
  });
});

describe('remoteShellFor', () => {
  it('maps Windows platform/OS strings to PowerShell', () => {
    for (const os of ['windows', 'Windows', 'win32', 'WIN32']) {
      expect(remoteShellFor(os)).toBe('powershell');
    }
  });

  it('defaults every non-Windows / unknown / absent OS to POSIX', () => {
    for (const os of ['linux', 'Linux', 'darwin', 'macos', 'Darwin', 'unknown', '', undefined]) {
      expect(remoteShellFor(os as string | undefined)).toBe('posix');
    }
  });
});

describe('powershellQuote', () => {
  it('wraps in single quotes and doubles embedded single quotes', () => {
    expect(powershellQuote('agents')).toBe("'agents'");
    expect(powershellQuote("it's")).toBe("'it''s'");
    // `$()`, `;`, and spaces are all literal inside a single-quoted PS string.
    expect(powershellQuote('$(whoami); rm')).toBe("'$(whoami); rm'");
  });
});

describe('buildRemoteAgentsInvocation — POSIX targets stay byte-identical', () => {
  it('produces the same bash -lc string for undefined and non-Windows OS', () => {
    const base = buildRemoteAgentsInvocation(['view', 'claude']);
    expect(base).toBe("bash -lc 'agents view claude'");
    expect(buildRemoteAgentsInvocation(['view', 'claude'], undefined, 'linux')).toBe(base);
    expect(buildRemoteAgentsInvocation(['view', 'claude'], undefined, 'darwin')).toBe(base);
    expect(buildRemoteAgentsInvocation(['view', 'claude'], undefined, 'macos')).toBe(base);
  });

  it('keeps the cd prefix for --remote-cwd on POSIX unchanged', () => {
    expect(buildRemoteAgentsInvocation(['view'], '/srv/app')).toBe("bash -lc 'cd /srv/app && agents view'");
  });

  it('still round-trips through a real bash login shell (no OS = POSIX)', () => {
    expect(decodeRemoteArgv(['view', 'claude'])).toEqual(['view', 'claude']);
  });

  it('prepends env exports before the command when env is given', () => {
    const cmd = buildRemoteAgentsInvocation(['teams', 'doctor', '--json'], undefined, 'linux', {
      PATH: '$HOME/.agents/.cache/shims:$HOME/.local/bin:$PATH',
    });
    expect(cmd).toBe(
      "bash -lc 'export PATH=\"$HOME/.agents/.cache/shims:$HOME/.local/bin:$PATH\"; agents teams doctor --json'",
    );
  });

  it('omits env prelude when env is empty', () => {
    const base = buildRemoteAgentsInvocation(['teams', 'doctor', '--json']);
    expect(buildRemoteAgentsInvocation(['teams', 'doctor', '--json'], undefined, 'linux', {})).toBe(base);
  });
});

/**
 * The Win32-escaped argument string the emitted launcher hands to .NET.
 *
 * Asserted instead of the whole script text: the launcher resolves the peer's
 * package entry at runtime, so the script is necessarily multi-statement, and
 * pinning it verbatim would test the prose rather than the argv the Agents parser
 * actually receives.
 */
function launcherArgs(script: string): string {
  // Match the single-quoted literal, allowing PowerShell's doubled `''` escape.
  const m = /\$zi\.Arguments\s*=\s*\$zr\s*\+\s*'((?:[^']|'')*)'/.exec(script);
  if (!m) throw new Error(`no launcher Arguments in: ${script}`);
  return m[1]!.replace(/''/g, "'");
}

describe('buildRemoteAgentsInvocation — Windows targets speak PowerShell', () => {
  it('emits powershell -EncodedCommand instead of bash -lc', () => {
    const cmd = buildRemoteAgentsInvocation(['view', 'claude'], undefined, 'windows');
    // Either render route is a PowerShell command; `renderPowershellCommand` picks
    // the shorter of `-EncodedCommand` and the deflated `-Command` bootstrap.
    expect(cmd.startsWith('powershell -NoProfile -')).toBe(true);
    expect(cmd).not.toContain('bash -lc');
    const script = decodeWindows(cmd);
    expect(launcherArgs(script)).toBe('view claude');
    expect(script.endsWith('exit $zq')).toBe(true);
    // The npm `agents.ps1` shim is bypassed: it splats `$args` into native
    // node.exe, which is where PowerShell 5.1 drops empty args and eats quotes.
    expect(script).not.toContain("& 'agents'");
  });

  it('suppresses CLIXML by silencing the progress stream (PowerShell 5.1 serializes it on a redirected pipe)', () => {
    // Without this, a remote agents failure comes back as a raw `#< CLIXML <Objs …>`
    // blob instead of a readable message — verified against a live win-mini.
    const script = decodeWindows(buildWindowsAgentsCommand({ args: ['doctor', '--json'] }));
    expect(script.startsWith("$ProgressPreference = 'SilentlyContinue'; ")).toBe(true);
  });

  it('prefixes Set-Location for --remote-cwd', () => {
    const cmd = buildRemoteAgentsInvocation(['view'], 'C:\\srv\\app', 'windows');
    const script = decodeWindows(cmd);
    expect(script).toContain("Set-Location -LiteralPath 'C:\\srv\\app'");
    // `Set-Location` moves the SHELL's location without updating the .NET
    // process's OS working directory, so the child needs it passed explicitly or
    // `--remote-cwd` is silently ignored.
    expect(script).toMatch(/\$zi\.WorkingDirectory\s*=\s*\(Get-Location\)\.ProviderPath/);
    expect(launcherArgs(script)).toBe('view');
  });

  it('neutralizes injection — metacharacters are literal inside single quotes', () => {
    const cmd = buildRemoteAgentsInvocation(['view', '$(whoami); rm -rf /', '--json'], undefined, 'windows');
    const script = decodeWindows(cmd);
    // One Win32-quoted token, so the peer's argv parse yields it whole; nothing
    // reaches a shell that could interpret `$(…)` or `;`.
    expect(launcherArgs(script)).toBe('view "$(whoami); rm -rf /" --json');
    expect(script).not.toContain('Invoke-Expression');
  });

  it('carries env vars through buildRemoteAgentsInvocation on Windows', () => {
    const cmd = buildRemoteAgentsInvocation(
      ['teams', 'doctor', '--json'],
      undefined,
      'windows',
      { PATH: '$HOME/.agents/.cache/shims:$HOME/.local/bin:$PATH' },
    );
    const script = decodeWindows(cmd);
    expect(script).toContain("$env:PATH = '$HOME/.agents/.cache/shims:$HOME/.local/bin:$PATH'");
    expect(launcherArgs(script)).toBe('teams doctor --json');
  });

  it('carries env vars as $env: assignments (buildWindowsAgentsCommand)', () => {
    const cmd = buildWindowsAgentsCommand({
      args: ['sessions', '--active', '--json'],
      env: { AGENTS_SESSIONS_LOCAL: '1', COLUMNS: '120' },
    });
    const script = decodeWindows(cmd);
    expect(script).toContain("$env:AGENTS_SESSIONS_LOCAL = '1'");
    expect(script).toContain("$env:COLUMNS = '120'");
    expect(launcherArgs(script)).toBe('sessions --active --json');
  });

  it('can drop the exit-code propagation for sentinel-based probes', () => {
    const cmd = buildWindowsAgentsCommand({ args: ['--version'], propagateExit: false });
    const script = decodeWindows(cmd);
    expect(launcherArgs(script)).toBe('--version');
    // No propagation appended, so a sentinel-based probe reads the output not the code.
    expect(script).not.toContain('exit $zq');
  });

  it('remaps a reached agents exit 255 so SSH transport failure stays unambiguous', () => {
    const cmd = buildWindowsAgentsCommand({ args: ['sessions', 'resume', 'abc'], remapExit255: true });
    const script = decodeWindows(cmd);
    expect(script).toContain("if ($zq -eq 255) { exit 254 }");
    expect(script).toContain('exit $zq');
  });
});

describe('buildWindowsStdinImportCommand', () => {
  it('bridges ssh stdin through a temp file (never a hanging --from -)', () => {
    const script = decodeWindows(buildWindowsStdinImportCommand('linear.app', { force: true }));
    // Silences the progress stream first, same CLIXML guard as windowsAgentsScript —
    // this builder also runs `& agents …` and its stderr is shown to the user on failure.
    expect(script.startsWith("$ProgressPreference = 'SilentlyContinue'; ")).toBe(true);
    // Reads the piped .env in PowerShell (the shim can't forward stdin to node).
    expect(script).toContain('[Console]::In.ReadToEnd()');
    expect(script).toContain('[System.IO.Path]::GetTempFileName()');
    // Imports from the temp FILE, not stdin — a plain file read the shim handles.
    expect(script).toContain('agents secrets import \'linear.app\' --from $tmp --force');
    expect(script).not.toContain('--from -');
    // Temp file is always cleaned up, and the import's exit code propagates.
    expect(script).toContain('Remove-Item -LiteralPath $tmp -Force');
    expect(script).toContain('exit $code');
  });

  it('omits --force when not requested', () => {
    const script = decodeWindows(buildWindowsStdinImportCommand('linear.app'));
    expect(script).toContain('agents secrets import \'linear.app\' --from $tmp;');
    expect(script).not.toContain('--force');
  });

  it('buildWindowsStdinAgentsCommand bridges ssh stdin to any verb via --from $tmp', () => {
    const script = decodeWindows(buildWindowsStdinAgentsCommand(['__usage-ingest']));
    expect(script.startsWith("$ProgressPreference = 'SilentlyContinue'; ")).toBe(true);
    expect(script).toContain('[Console]::In.ReadToEnd()');
    expect(script).toContain('[System.IO.Path]::GetTempFileName()');
    // Runs the verb against the temp FILE, never a hanging `--from -`.
    expect(script).toContain('agents \'__usage-ingest\' --from $tmp');
    expect(script).not.toContain('--from -');
    expect(script).toContain('Remove-Item -LiteralPath $tmp -Force');
    expect(script).toContain('exit $code');
  });

  it('sets policy never in the same import process', () => {
    const script = decodeWindows(buildWindowsStdinImportCommand('linear.app', { policyNever: true }));
    expect(script).toContain("agents secrets import 'linear.app' --from $tmp --policy never --i-understand");
    expect(script).not.toContain('secrets policy');
  });

  it('creates + writes the temp file INSIDE the try so a crash still cleans it up (RUSH-1764)', () => {
    const script = decodeWindows(buildWindowsStdinImportCommand('linear.app'));
    // GetTempFileName + WriteAllText must sit after `try {`, so the finally's
    // Remove-Item runs even if WriteAllText throws. The old code created the
    // secret-bearing temp file BEFORE the try, leaking it on a mid-write crash.
    const tryIdx = script.indexOf('try {');
    const tmpIdx = script.indexOf('[System.IO.Path]::GetTempFileName()');
    const writeIdx = script.indexOf('[System.IO.File]::WriteAllText($tmp, $in)');
    const finallyIdx = script.indexOf('finally');
    expect(tryIdx).toBeGreaterThanOrEqual(0);
    expect(tmpIdx).toBeGreaterThan(tryIdx);
    expect(writeIdx).toBeGreaterThan(tmpIdx);
    expect(finallyIdx).toBeGreaterThan(writeIdx);
    // The finally guards on $tmp so a GetTempFileName that itself throws is safe.
    expect(script).toContain('if ($tmp) { Remove-Item -LiteralPath $tmp -Force');
  });
});

describe('posixEnvExports — actor values are shell-literal, PATH still expands', () => {
  // Actor provenance carries attacker-influenceable strings (a tailnet peer's
  // whois display name, or an unvalidated AGENTS_ACTOR_* env). They ride the same
  // export prefix that sends PATH to the remote, so a `$(...)`/backtick in a value
  // must NOT execute. These run the exact `bash -lc "<exports>; …"` shape the
  // dispatch builders send over SSH, against the real shell — no mocks.
  const runExports = (env: Record<string, string>, tail: string) =>
    spawnSync('bash', ['-lc', `${posixEnvExports(env)}; ${tail}`], { encoding: 'utf-8' });

  it('does NOT execute a $(...) command substitution smuggled through an actor value', () => {
    const marker = spawnSync('mktemp', ['-u'], { encoding: 'utf-8' }).stdout.trim();
    const res = runExports(
      { AGENTS_ACTOR_NAME: `$(touch ${marker})`, AGENTS_ACTOR_EMAIL: 'x@y.z' },
      'printf %s "$AGENTS_ACTOR_NAME"',
    );
    // The payload survives verbatim as data, and the file was never created.
    expect(res.stdout).toBe(`$(touch ${marker})`);
    expect(spawnSync('test', ['-e', marker]).status).not.toBe(0);
  });

  it('does NOT execute a backtick command substitution smuggled through an actor value', () => {
    const marker = spawnSync('mktemp', ['-u'], { encoding: 'utf-8' }).stdout.trim();
    const res = runExports({ GIT_AUTHOR_NAME: '`touch ' + marker + '`' }, 'printf %s "$GIT_AUTHOR_NAME"');
    expect(res.stdout).toBe('`touch ' + marker + '`');
    expect(spawnSync('test', ['-e', marker]).status).not.toBe(0);
  });

  it('still expands $HOME/$PATH for the PATH key so `agents` resolves on the remote', () => {
    const res = runExports({ PATH: '$HOME/.agents/.cache/shims:$PATH' }, 'printf %s "$PATH"');
    // $HOME expanded (no literal "$HOME" left) and the shim dir is present.
    expect(res.stdout).toContain('/.agents/.cache/shims:');
    expect(res.stdout).not.toContain('$HOME');
  });
});

describe('the Windows remote command stays well inside the peer length limit', () => {
  it('leaves real call-site payloads comfortably inside the ceiling', () => {
    // These are the shapes the ten `buildWindowsAgentsCommand` callers actually
    // emit; a regression that inflates the fixed script would show up here first.
    const sizes = [
      buildWindowsAgentsCommand({ args: ['feed', '--json'], env: { AGENTS_NO_FANOUT: '1' } }),
      buildWindowsAgentsCommand({ args: ['sessions', '--active', '--json'], env: { AGENTS_SESSIONS_LOCAL: '1', COLUMNS: '120' } }),
      buildWindowsAgentsCommand({ args: ['feed', 'watch', '--json', '--local'] }),
      buildWindowsAgentsCommand({ args: ['secrets', 'import', 'apple.com', '--from', '-'] }),
      buildWindowsAgentsCommand({ args: ['sessions', 'resume', '1234abcd-5678-90ef-1234-567890abcdef'], cwd: 'C:\\Users\\me\\src\\some\\deep\\project' }),
      buildWindowsAgentsCommand({ args: ['sessions', 'resume', 'x'.repeat(500)] }),
    ].map((c) => c.length);
    // Bisected on a live peer: 2934 characters succeed, 3102 fail. Compression is
    // what buys the headroom back — before it the heavy case was 3314 and failed
    // with the peer's opaque `The command line is too long.`
    for (const size of sizes) expect(size).toBeLessThan(2934);
    // A real margin, so a future addition cannot quietly exhaust it.
    expect(Math.max(...sizes)).toBeLessThan(2000);
  });
});
