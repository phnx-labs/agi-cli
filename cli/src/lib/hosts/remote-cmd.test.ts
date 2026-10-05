import { describe, it, expect } from 'vitest';
import { spawnSync } from 'child_process';
import { stripRoutingFlags, buildRemoteAgentsInvocation, buildWindowsAgentsCommand, buildWindowsStdinImportCommand, buildWindowsStdinAgentsCommand, posixEnvExports, remoteShellFor, powershellQuote, decodePowershell, windowsRemotePath, windowsSetLocation, stripClixml, HOST_ROUTING_SPECS, type StripSpec } from './remote-cmd.js';
import { decodeRenderedPowershell } from './remote-cmd.test-fixture.js';

describe('stripClixml', () => {
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
    // A real CLIXML banner is present and the payload's own strings contain `<Objs` and `</Objs>`;
    // a naive global strip would delete the JSON between them, so the banner-anchored strip must
    // leave the payload intact.
    const payload = '{"topic":"debug <Objs> parsing","label":"</Objs> handler","outputTokens":5}';
    const cleaned = stripClixml(CLIXML_BANNER + '\n' + payload);
    const parsed = JSON.parse(cleaned);
    expect(parsed.topic).toBe('debug <Objs> parsing');
    expect(parsed.label).toBe('</Objs> handler');
    expect(parsed.outputTokens).toBe(5);
  });
});

const decodeWindows = decodeRenderedPowershell;

const SPECS: StripSpec[] = [...HOST_ROUTING_SPECS, { long: 'no-tty', takesValue: false }];

/** Decode the argv the remote would receive: `buildRemoteAgentsInvocation` emits `bash -lc
 * '<...>'` and an `agents` shim prints each arg per line, so stdout is the remote argv, an end-
 * to-end check of the two-layer quoting (injection safety). */
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
    expect(decodeRemoteArgv(['view'], '/tmp')).toEqual(['view']);
  });
});

describe('secrets export --device push command (cross-platform)', () => {
  // The keychain export push runs `agents secrets import --from -` remotely (`--from -` reads the
  // .env from ssh stdin, replacing POSIX-only `/dev/stdin`); `import` auto-creates the bundle, so
  // there is no `create … || true`, which broke on PowerShell.
  const importArgs = ['secrets', 'import', 'mybundle', '--from', '-'];

  it('POSIX target: bash -lc agents secrets import --from - (no /dev/stdin, no || true)', () => {
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

/** The Win32-escaped argument string the launcher hands to .NET. Asserted instead of the whole
 * script, which is multi-statement because the launcher resolves the peer's package entry at
 * runtime; pinning it verbatim would test prose, not the argv the parser receives. */
function launcherArgs(script: string): string {
  const m = /\$zi\.Arguments\s*=\s*\$zr\s*\+\s*'((?:[^']|'')*)'/.exec(script);
  if (!m) throw new Error(`no launcher Arguments in: ${script}`);
  return m[1]!.replace(/''/g, "'");
}

describe('buildRemoteAgentsInvocation — Windows targets speak PowerShell', () => {
  it('emits powershell -EncodedCommand instead of bash -lc', () => {
    const cmd = buildRemoteAgentsInvocation(['view', 'claude'], undefined, 'windows');
    expect(cmd.startsWith('powershell -NoProfile -')).toBe(true);
    expect(cmd).not.toContain('bash -lc');
    const script = decodeWindows(cmd);
    expect(launcherArgs(script)).toBe('view claude');
    expect(script.endsWith('exit $zq')).toBe(true);
    expect(script).not.toContain("& 'agents'");
  });

  it('suppresses CLIXML by silencing the progress stream (PowerShell 5.1 serializes it on a redirected pipe)', () => {
    const script = decodeWindows(buildWindowsAgentsCommand({ args: ['doctor', '--json'] }));
    expect(script.startsWith("$ProgressPreference = 'SilentlyContinue'; ")).toBe(true);
  });

  it('prefixes Set-Location for --remote-cwd', () => {
    const cmd = buildRemoteAgentsInvocation(['view'], 'C:\\srv\\app', 'windows');
    const script = decodeWindows(cmd);
    expect(script).toContain("Set-Location -LiteralPath 'C:\\srv\\app'");
    expect(script).toMatch(/\$zi\.WorkingDirectory\s*=\s*\(Get-Location\)\.ProviderPath/);
    expect(launcherArgs(script)).toBe('view');
  });

  it('neutralizes injection — metacharacters are literal inside single quotes', () => {
    const cmd = buildRemoteAgentsInvocation(['view', '$(whoami); rm -rf /', '--json'], undefined, 'windows');
    const script = decodeWindows(cmd);
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
    expect(script.startsWith("$ProgressPreference = 'SilentlyContinue'; ")).toBe(true);
    expect(script).toContain('[Console]::In.ReadToEnd()');
    expect(script).toContain('[System.IO.Path]::GetTempFileName()');
    expect(script).toContain('agents secrets import \'linear.app\' --from $tmp --force');
    expect(script).not.toContain('--from -');
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
    const tryIdx = script.indexOf('try {');
    const tmpIdx = script.indexOf('[System.IO.Path]::GetTempFileName()');
    const writeIdx = script.indexOf('[System.IO.File]::WriteAllText($tmp, $in)');
    const finallyIdx = script.indexOf('finally');
    expect(tryIdx).toBeGreaterThanOrEqual(0);
    expect(tmpIdx).toBeGreaterThan(tryIdx);
    expect(writeIdx).toBeGreaterThan(tmpIdx);
    expect(finallyIdx).toBeGreaterThan(writeIdx);
    expect(script).toContain('if ($tmp) { Remove-Item -LiteralPath $tmp -Force');
  });
});

describe('posixEnvExports — actor values are shell-literal, PATH still expands', () => {
  // Actor provenance carries attacker-influenceable strings (a tailnet peer's whois name,
  // unvalidated AGENTS_ACTOR_* env) on the same export prefix as PATH, so a `$(...)`/backtick must
  // not execute. These run the exact `bash -lc` shape dispatch sends, in a real shell.
  const runExports = (env: Record<string, string>, tail: string) =>
    spawnSync('bash', ['-lc', `${posixEnvExports(env)}; ${tail}`], { encoding: 'utf-8' });

  it('does NOT execute a $(...) command substitution smuggled through an actor value', () => {
    const marker = spawnSync('mktemp', ['-u'], { encoding: 'utf-8' }).stdout.trim();
    const res = runExports(
      { AGENTS_ACTOR_NAME: `$(touch ${marker})`, AGENTS_ACTOR_EMAIL: 'x@y.z' },
      'printf %s "$AGENTS_ACTOR_NAME"',
    );
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
    expect(res.stdout).toContain('/.agents/.cache/shims:');
    expect(res.stdout).not.toContain('$HOME');
  });
});

describe('the Windows remote command stays well inside the peer length limit', () => {
  it('leaves real call-site payloads comfortably inside the ceiling', () => {
    const sizes = [
      buildWindowsAgentsCommand({ args: ['feed', '--json'], env: { AGENTS_NO_FANOUT: '1' } }),
      buildWindowsAgentsCommand({ args: ['sessions', '--active', '--json'], env: { AGENTS_SESSIONS_LOCAL: '1', COLUMNS: '120' } }),
      buildWindowsAgentsCommand({ args: ['feed', 'watch', '--json', '--local'] }),
      buildWindowsAgentsCommand({ args: ['secrets', 'import', 'apple.com', '--from', '-'] }),
      buildWindowsAgentsCommand({ args: ['sessions', 'resume', '1234abcd-5678-90ef-1234-567890abcdef'], cwd: 'C:\\Users\\me\\src\\some\\deep\\project' }),
      buildWindowsAgentsCommand({ args: ['sessions', 'resume', 'x'.repeat(500)] }),
    ].map((c) => c.length);
    for (const size of sizes) expect(size).toBeLessThan(2934);
    expect(Math.max(...sizes)).toBeLessThan(2000);
  });
});

describe('windowsRemotePath / windowsSetLocation — the PowerShell analogue of remoteCdPrefix', () => {
  it('re-roots a home-anchored path onto the peer $HOME and quotes any other verbatim', () => {
    expect(windowsRemotePath('~/tools/cgraph')).toBe("(Join-Path $HOME 'tools/cgraph')");
    expect(windowsRemotePath('$HOME/.agents/.cache/hosts/abc.log')).toBe("(Join-Path $HOME '.agents/.cache/hosts/abc.log')");
    expect(windowsRemotePath('~')).toBe('$HOME');
    expect(windowsRemotePath("C:\\Users\\me\\it's")).toBe("'C:\\Users\\me\\it''s'");
  });

  it('an explicit cwd aborts on a missing directory; a mirrored one falls back to $HOME', () => {
    expect(windowsSetLocation('C:\\src\\repo')).toBe("Set-Location -LiteralPath 'C:\\src\\repo' -ErrorAction Stop");
    expect(windowsSetLocation('~/src/repo', true)).toBe(
      "try { Set-Location -LiteralPath (Join-Path $HOME 'src/repo') -ErrorAction Stop } catch { Set-Location -LiteralPath $HOME }",
    );
  });
});
