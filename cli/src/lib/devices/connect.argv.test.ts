import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { pwshQuote, wrapRemoteCommand } from './connect.js';
import { parseArgvJson } from '../../commands/ssh.js';
import type { DeviceProfile } from './registry.js';

function dev(extra: Partial<DeviceProfile> = {}): DeviceProfile {
  return { name: 'box', shell: 'posix', auth: { method: 'key' }, ...extra } as DeviceProfile;
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

/** `printf` writing each token NUL-terminated, built through the code under test. */
function printfArgv(tokens: string[]): string {
  return wrapRemoteCommand(dev(), ['printf', '%s\\000', ...tokens], { argv: true })!;
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
    // Each token single-quoted; the embedded quote doubled, which is pwsh's own
    // escape inside a single-quoted string.
    expect(script).toBe("'Write-Output' 'two words' 'it''s'");
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
