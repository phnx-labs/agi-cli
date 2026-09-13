import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { buildSshInvocation, fleetRemotePrelude, markFleetRemote, pwshQuote, wrapRemoteCommand } from './connect.js';
import { quoteWin32ExecArg } from '../platform/exec.js';
import { parseArgvJson } from '../../commands/ssh.js';
import type { DeviceProfile } from './registry.js';

function dev(extra: Partial<DeviceProfile> = {}): DeviceProfile {
  // `address` is required by `buildSshInvocation` (via `sshTargetFor`), so the
  // full-pipeline tests below need it; the quoter-only tests ignore it.
  return {
    name: 'box', platform: 'linux', shell: 'posix',
    address: { via: 'manual', ip: '198.51.100.7' },
    auth: { method: 'key' },
    createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
    ...extra,
  } as DeviceProfile;
}

/**
 * The tokens a REAL shell hands the program, given what we told ssh to run.
 *
 * This is the whole point of the feature, so it is exercised through an actual
 * `sh -c` rather than asserted against a quoting snapshot: the command string we
 * build is what a remote login shell parses, and only a real parse proves the
 * tokens survive.
 *
 * The delimiter is NUL, not newline. A token is allowed to CONTAIN a newline —
 * that is one of the cases this feature exists for — so a newline-delimited
 * read-back cannot tell "one token with a newline in it" from "two tokens", and
 * would report a pass for a string the shell had actually split.
 */
function tokensAfterRealShell(command: string): string[] {
  const out = execFileSync('sh', ['-c', command], { encoding: 'utf8' });
  return out.split('\u0000').slice(0, -1);
}

/** sh `printf` format that NUL-terminates each argument. */
const PRINTF_NUL = '%s\\000';
/** The same format, pre-quoted for inline use in a probe script. */
const PRINTF_NUL_Q = "'%s\\000'";

/** `printf` writing each token NUL-terminated, built through the code under test. */
function printfArgv(tokens: string[]): string {
  return wrapRemoteCommand(dev(), ['printf', PRINTF_NUL, ...tokens], { argv: true })!;
}

describe('argv mode delivers exact tokens through a real shell', () => {
  const nasty = [
    'two words',
    'a & b',
    'pipe | it',
    '$HOME',
    '`whoami`',
    "it's",
    'say "hi"',
    'semi; colon',
    'glob*',
    'sub$(echo x)',
    'new\nline',
    'tab\there',
    '',
  ];

  it('round-trips every metacharacter token byte-for-byte', () => {
    expect(tokensAfterRealShell(printfArgv(nasty))).toEqual(nasty);
  });

  it('keeps a token that is only a quote, and one that is only whitespace', () => {
    const odd = ["'", '"', '   ', '\\'];
    expect(tokensAfterRealShell(printfArgv(odd))).toEqual(odd);
  });

  it('does NOT expand a variable or a glob the caller passed literally', () => {
    const tokens = tokensAfterRealShell(printfArgv(['$HOME', '/etc/*']));
    expect(tokens).toEqual(['$HOME', '/etc/*']);
    expect(tokens[0]).not.toContain('/home');
  });

  it('leaves the DEFAULT mode parsed by the shell, which existing callers rely on', () => {
    // The positional form must keep meaning what it means today: a string whose
    // separators and pipeline the remote shell expands. Quoting it would ship the
    // whole line as one literal argument and break every such caller.
    const script = String.raw`printf '%s\000' one; printf '%s\000' two`;
    const joined = wrapRemoteCommand(dev(), [script])!;
    expect(joined).toBe(script);
    expect(tokensAfterRealShell(joined)).toEqual(['one', 'two']);
    // The SAME input in argv mode is one literal token instead of a script.
    expect(tokensAfterRealShell(printfArgv([script]))).toEqual([script]);
  });

  it('reproduces the native bug the default mode has, so the fix is not theoretical', () => {
    // What a native client actually hit: real argv joined raw, so the shell split
    // a single token on its space.
    const broken = wrapRemoteCommand(dev(), ['printf', String.raw`'%s\000'`, 'two words'])!;
    expect(tokensAfterRealShell(broken)).toEqual(['two', 'words']);
    expect(tokensAfterRealShell(printfArgv(['two words']))).toEqual(['two words']);
  });

  it('returns undefined for an empty command in both modes (interactive login)', () => {
    expect(wrapRemoteCommand(dev(), [])).toBeUndefined();
    expect(wrapRemoteCommand(dev(), [], { argv: true })).toBeUndefined();
  });
});

describe('argv mode on a PowerShell device', () => {
  it('base64-encodes a pwsh script whose tokens are single-quoted', () => {
    const wrapped = wrapRemoteCommand(dev({ shell: 'powershell' }), ['Write-Output', 'two words', "it's"], { argv: true })!;
    expect(wrapped.startsWith('powershell -NoProfile -EncodedCommand ')).toBe(true);
    const encoded = wrapped.split(' ').pop()!;
    const script = Buffer.from(encoded, 'base64').toString('utf16le');
    // The PROGRAM is pwsh-quoted (PowerShell resolves it), then `--%` stops
    // parsing and the ARGUMENTS are Win32-quoted for the callee's own split.
    expect(script).toBe(`& 'Write-Output' --% ${quoteWin32ExecArg('two words')} ${quoteWin32ExecArg("it's")}`);
  });

  it('quotes every byte that would otherwise be pwsh syntax', () => {
    // Inside pwsh single quotes only `'` is special, so this is total.
    expect(pwshQuote('$env:PATH')).toBe("'$env:PATH'");
    expect(pwshQuote('`backtick`')).toBe("'`backtick`'");
    expect(pwshQuote("it's")).toBe("'it''s'");
    expect(pwshQuote('')).toBe("''");
    expect(pwshQuote('a\nb')).toBe("'a\nb'");
  });
});

describe('the browser provenance gate still fires on the argv form', () => {
  it('stamps a browser drive passed as real argv, metacharacters and all', () => {
    const argv = ['agents', 'browser', 'navigate', '--url', 'https://x.test/?a=1&b=2'];
    // The URL's `&` is exactly what the raw join loses; in argv mode it survives
    // as one token, which is what the far-side consent gate then sees.
    expect(tokensAfterRealShell(printfArgv(argv))).toEqual(argv);
  });
});

describe('--argv parsing fails loud', () => {
  const errs: string[] = [];
  const log = (line: string) => { errs.push(line); };
  const parse = (raw: string) => { errs.length = 0; return parseArgvJson(raw, log); };

  it('accepts a JSON array of strings', () => {
    expect(parse('["uptime","-p"]')).toEqual(['uptime', '-p']);
    expect(parse('[]')).toEqual([]);
    expect(errs).toEqual([]);
  });

  it('rejects malformed JSON, naming the problem', () => {
    expect(parse('[not json')).toBeUndefined();
    expect(errs.join(' ')).toMatch(/not valid JSON/);
  });

  it('rejects a non-array, including a bare string that looks plausible', () => {
    expect(parse('"uptime -p"')).toBeUndefined();
    expect(errs.join(' ')).toMatch(/must be a JSON ARRAY/);
    expect(parse('{"0":"uptime"}')).toBeUndefined();
  });

  it('rejects a non-string element and says which index', () => {
    expect(parse('["uptime",7]')).toBeUndefined();
    expect(errs.join(' ')).toMatch(/element 1 is number/);
    expect(parse('["a",null]')).toBeUndefined();
    expect(errs.join(' ')).toMatch(/element 1 is object/);
  });
});

describe('the FULL buildSshInvocation pipeline, not just the quoter', () => {
  /**
   * The command string ssh would send, extracted from a real `buildSshInvocation`.
   *
   * The earlier tests here exercised `wrapRemoteCommand` in isolation, which is
   * exactly where the provenance bug hid: `buildSshInvocation` applied
   * `markFleetRemote` BEFORE quoting, so the already-quoted prelude got quoted a
   * second time and nothing in a quoter-only test could see it.
   */
  function remoteCommandFrom(device: DeviceProfile, cmd: string[], argv: boolean): string {
    const { args } = buildSshInvocation(device, cmd, '/nonexistent/askpass', {}, argv ? { argv: true } : {});
    return args[args.length - 1]!;
  }

  const actor = {
    AGENTS_ACTOR: 'Some Name',
    AGENTS_ACTOR_ID: "o'brien",
    GIT_AUTHOR_NAME: 'a & b',
  };

  it('quotes the actor pairs exactly ONCE on a POSIX browser drive', () => {
    const remote = remoteCommandFrom(dev(), ['agents', 'browser', 'navigate', '--url', 'https://x.test/?a=1&b=2'], true);
    expect(remote.startsWith('env AGENTS_FLEET_REMOTE=1 ')).toBe(true);
    // The double-quoting signature must not appear anywhere.
    expect(remote).not.toContain("'\\''");
    // The URL's `&` survives as one token rather than backgrounding the command.
    expect(remote).toContain("'https://x.test/?a=1&b=2'");
  });

  it('delivers provenance AND exact argv through a real shell, in one command', () => {
    // The invoked program prints BOTH its argv and the variables it can see, so a
    // single real execution proves the two halves together. Reading the variables
    // in a *later* command would read the ambient shell instead: `env K=V cmd`
    // scopes them to `cmd` alone, which is exactly what `markFleetRemote` relies on.
    const prelude = fleetRemotePrelude(dev(), actor);
    const script = 'printf ' + PRINTF_NUL_Q + ' "$@" "$AGENTS_FLEET_REMOTE" "$AGENTS_ACTOR" "$AGENTS_ACTOR_ID" "$GIT_AUTHOR_NAME"';
    const remote = wrapRemoteCommand(
      dev(),
      ['sh', '-c', script, 'sh', 'two words', 'a & b'],
      { argv: true, prelude },
    )!;
    expect(tokensAfterRealShell(remote)).toEqual([
      // the caller's tokens, intact through quoting
      'two words', 'a & b',
      // the provenance the program actually received, intact
      '1', 'Some Name', "o'brien", 'a & b',
    ]);
  });

  it('keeps the marker exact-once when a caller pre-marked the command', () => {
    const pre = markFleetRemote(['agents', 'browser', 'status'], dev(), actor);
    const remote = remoteCommandFrom(dev(), pre, true);
    // One marker, not two: `buildSshInvocation` must not add a second prelude on
    // top of one the caller already applied.
    expect(remote.match(/AGENTS_FLEET_REMOTE=1/g)).toHaveLength(1);
  });

  it('does not stamp provenance on a non-browser command', () => {
    expect(remoteCommandFrom(dev(), ['uptime', '-p'], true)).not.toContain('AGENTS_FLEET_REMOTE');
  });

  it('emits an EXECUTABLE PowerShell script: call operator plus unquoted prelude', () => {
    const remote = remoteCommandFrom(dev({ shell: 'powershell' }), ['agents', 'browser', 'navigate', '--url', 'https://x.test/?a=1&b=2'], true);
    const script = Buffer.from(remote.split(' ').pop()!, 'base64').toString('utf16le');
    // The prelude must be live pwsh STATEMENTS, not quoted strings.
    expect(script).toContain("$env:AGENTS_FLEET_REMOTE='1';");
    expect(script).not.toContain("'$env:AGENTS_FLEET_REMOTE=");
    // `&` is what makes the quoted program run instead of being echoed.
    expect(script).toMatch(/; & 'agents' --% browser navigate /);
    // The URL carries `&`; Win32 quoting wraps it rather than losing it.
    expect(script).toContain(quoteWin32ExecArg('https://x.test/?a=1&b=2'));
  });

  it('escapes a quote in a PowerShell provenance value without breaking the statement', () => {
    const prelude = fleetRemotePrelude(dev({ shell: 'powershell' }), actor);
    const remote = wrapRemoteCommand(dev({ shell: 'powershell' }), ['prog'], { argv: true, prelude })!;
    const script = Buffer.from(remote.split(' ').pop()!, 'base64').toString('utf16le');
    // pwsh doubles an embedded single quote; the statement stays terminated.
    expect(script).toContain("$env:AGENTS_ACTOR_ID='o''brien';");
    expect(script).toContain("$env:AGENTS_ACTOR='Some Name';");
    // A lone program has no arguments, so no `--%` is emitted for it.
    expect(script.endsWith("& 'prog'")).toBe(true);
  });

  it('leaves a NON-argv powershell drive as an unquoted command, as before', () => {
    // The default mode must keep working: the program is a bare word there, so it
    // needs no call operator and must not gain one.
    const script = Buffer.from(
      remoteCommandFrom(dev({ shell: 'powershell' }), ['agents', 'browser', 'status'], false).split(' ').pop()!,
      'base64',
    ).toString('utf16le');
    expect(script).toContain('agents browser status');
    expect(script).not.toContain("& 'agents'");
  });
});

describe('PowerShell 5.1 loses arguments unless they are Win32-quoted after --%', () => {
  /**
   * Measured on a real Windows peer (win-mini, PowerShell 5.1), NOT inferred:
   * PowerShell re-serializes arguments when invoking a NATIVE program, and its
   * serializer drops an empty argument entirely and discards embedded double
   * quotes. Before this, `['a','','b']` arrived on the peer as two arguments and
   * `say "hi"` arrived as `say hi` — the callee's argv silently shifted.
   */
  function pwshScript(cmd: string[]): string {
    const wrapped = wrapRemoteCommand(dev({ shell: 'powershell' }), cmd, { argv: true })!;
    return Buffer.from(wrapped.split(' ').pop()!, 'base64').toString('utf16le');
  }

  it('emits the stop-parsing token so PowerShell cannot rebuild the line', () => {
    expect(pwshScript(['prog', 'a'])).toBe(`& 'prog' --% a`);
  });

  it('represents an EMPTY argument, which PowerShell 5.1 otherwise drops', () => {
    const script = pwshScript(['prog', 'before', '', 'after']);
    expect(script).toBe(`& 'prog' --% before "" after`);
    // The empty token must occupy a position, not vanish.
    expect(script.split(' ').slice(3)).toHaveLength(3);
  });

  it('preserves an embedded double quote, which PowerShell 5.1 otherwise eats', () => {
    expect(pwshScript(['prog', 'say "hi"'])).toBe(`& 'prog' --% "say \\"hi\\""`);
  });

  it('doubles backslashes only where a closing quote follows them', () => {
    // A trailing backslash in an UNQUOTED token needs no doubling — nothing
    // follows it to escape. This is the canonical quoter's rule, not a shortcut.
    expect(pwshScript(['prog', 'C:\\dir\\'])).toBe(`& 'prog' --% C:\\dir\\`);
    // Once the token must be quoted, the trailing run doubles before the close.
    expect(pwshScript(['prog', 'C:\\my dir\\'])).toBe(`& 'prog' --% ${quoteWin32ExecArg('C:\\my dir\\')}`);
    // A backslash directly before an embedded quote doubles plus escapes it.
    expect(pwshScript(['prog', 'a\\"b'])).toBe(`& 'prog' --% ${quoteWin32ExecArg('a\\"b')}`);
  });

  it('leaves a plain token unquoted and quotes one with a metacharacter', () => {
    expect(pwshScript(['prog', 'simple'])).toBe(`& 'prog' --% simple`);
    expect(pwshScript(['prog', 'a & b'])).toBe(`& 'prog' --% "a & b"`);
  });

  it('reuses the canonical Win32 quoter rather than a second implementation', () => {
    // Same algorithm as the `.cmd` shim path; a divergent copy would drift.
    for (const token of ['', 'a b', 'say "hi"', 'C:\\dir\\', 'a\\"b', 'plain', 'a|b']) {
      expect(pwshScript(['prog', token])).toBe(`& 'prog' --% ${quoteWin32ExecArg(token)}`);
    }
  });

  it('still quotes the PROGRAM for PowerShell, which resolves it', () => {
    // The program is not Win32-quoted: PowerShell itself looks it up.
    expect(pwshScript(['C:\\Program Files\\x\\p.exe', 'arg'])).toBe(
      `& 'C:\\Program Files\\x\\p.exe' --% arg`,
    );
  });
});
