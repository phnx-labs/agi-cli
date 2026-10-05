import { describe, it, expect } from 'vitest';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { whichCommand, findExecutable, needsWindowsShell, posixShellPath, quoteWin32ExecArg, composeWin32CommandLine, execFileShellSpec } from './exec.js';

describe('whichCommand', () => {
  it('is `where` on win32, `which` elsewhere', () => {
    expect(whichCommand('win32')).toBe('where');
    expect(whichCommand('darwin')).toBe('which');
    expect(whichCommand('linux')).toBe('which');
  });
});

describe('findExecutable', () => {
  it('resolves a real executable to an absolute path on the current platform', () => {
    const p = findExecutable('node');
    expect(p).toBeTruthy();
    expect(p!.length).toBeGreaterThan(0);
    expect(p).toMatch(/node/i);
  });

  it('returns null for a name that does not exist', () => {
    expect(findExecutable('definitely-not-a-real-binary-xyz123')).toBeNull();
  });
});

describe('needsWindowsShell', () => {
  it('is always false off Windows, even for .cmd or bare names', () => {
    expect(needsWindowsShell('npm', 'linux')).toBe(false);
    expect(needsWindowsShell('npm.cmd', 'linux')).toBe(false);
    expect(needsWindowsShell('/usr/bin/node', 'darwin')).toBe(false);
  });

  it('on win32, needs the shell for .cmd/.bat wrappers (case-insensitive)', () => {
    expect(needsWindowsShell('C:\\Program Files\\nodejs\\npm.cmd', 'win32')).toBe(true);
    expect(needsWindowsShell('C:\\tools\\bun.CMD', 'win32')).toBe(true);
    expect(needsWindowsShell('C:\\x\\run.bat', 'win32')).toBe(true);
  });

  it('on win32, needs the shell for a bare (PATHEXT-resolved) command name', () => {
    expect(needsWindowsShell('npm', 'win32')).toBe(true);
    expect(needsWindowsShell('bun', 'win32')).toBe(true);
  });

  it('on win32, a direct absolute .exe does NOT need the shell', () => {
    expect(needsWindowsShell('C:\\Program Files\\nodejs\\node.exe', 'win32')).toBe(false);
  });
});

describe('quoteWin32ExecArg', () => {
  it('leaves simple args untouched (byte-identical to the old unquoted join)', () => {
    expect(quoteWin32ExecArg('npm')).toBe('npm');
    expect(quoteWin32ExecArg('--version')).toBe('--version');
    expect(quoteWin32ExecArg('sk-proj-AbC123_xyz.789')).toBe('sk-proj-AbC123_xyz.789');
    expect(quoteWin32ExecArg('C:\\bin\\claude.cmd')).toBe('C:\\bin\\claude.cmd');
  });

  it('quotes whitespace so it stays a single argument', () => {
    expect(quoteWin32ExecArg('hello world')).toBe('"hello world"');
    expect(quoteWin32ExecArg('a\tb')).toBe('"a\tb"');
    expect(quoteWin32ExecArg('C:\\Program Files\\node\\node.exe'))
      .toBe('"C:\\Program Files\\node\\node.exe"');
  });

  it('quotes cmd metacharacters so the shell treats them literally', () => {
    expect(quoteWin32ExecArg('a&b')).toBe('"a&b"');
    expect(quoteWin32ExecArg('a|b')).toBe('"a|b"');
    expect(quoteWin32ExecArg('a>b')).toBe('"a>b"');
    expect(quoteWin32ExecArg('a<b')).toBe('"a<b"');
    expect(quoteWin32ExecArg('a^b')).toBe('"a^b"');
    expect(quoteWin32ExecArg('(sub)')).toBe('"(sub)"');
  });

  it('escapes embedded double quotes (CommandLineToArgvW rules)', () => {
    expect(quoteWin32ExecArg('say "hi"')).toBe('"say \\"hi\\""');
  });

  it('doubles a run of backslashes that precedes a quote', () => {
    expect(quoteWin32ExecArg('a\\"b')).toBe('"a\\\\\\"b"');
  });

  it('doubles trailing backslashes before the closing quote (when quoting)', () => {
    expect(quoteWin32ExecArg('a b\\')).toBe('"a b\\\\"');
    expect(quoteWin32ExecArg('two\\\\ end')).toBe('"two\\\\ end"');
  });

  it('leaves a lone trailing backslash unquoted (no trigger char)', () => {
    expect(quoteWin32ExecArg('ends\\')).toBe('ends\\');
  });

  it('turns an empty arg into an explicit ""', () => {
    expect(quoteWin32ExecArg('')).toBe('""');
  });

  it('leaves %VAR%/!VAR! untouched at the quoting layer (documented cmd-expansion caveat)', () => {
    expect(quoteWin32ExecArg('%PATH%')).toBe('%PATH%');
    expect(quoteWin32ExecArg('!DELAYED!')).toBe('!DELAYED!');
  });

  it('passes unicode text through untouched (no trigger char)', () => {
    expect(quoteWin32ExecArg('café')).toBe('café');
    expect(quoteWin32ExecArg('日本語')).toBe('日本語');
    expect(quoteWin32ExecArg('café ☕')).toBe('"café ☕"');
  });
});

describe('composeWin32CommandLine', () => {
  it('joins a simple command + args byte-identically to the old unquoted join', () => {
    expect(composeWin32CommandLine('claude', [])).toBe('claude');
    expect(composeWin32CommandLine('npm', ['view', 'pkg', 'version']))
      .toBe('npm view pkg version');
  });

  it('quotes only the tokens that need it', () => {
    expect(composeWin32CommandLine('C:\\bin\\claude.cmd', ['-p', 'hello world']))
      .toBe('C:\\bin\\claude.cmd -p "hello world"');
    expect(composeWin32CommandLine('C:\\Program Files\\x\\node.exe', ['-e', 'a&b']))
      .toBe('"C:\\Program Files\\x\\node.exe" -e "a&b"');
  });

  it('quotes cmd.exe metacharacters in MCP-shaped command/args', () => {
    const mcpArgs = [
      'mcp', 'add', '--scope', 'user', '--transport', 'stdio', '--',
      'demo',
      'npx',
      'a&b|c>d^e',
    ];
    expect(composeWin32CommandLine('claude.cmd', mcpArgs))
      .toBe('claude.cmd mcp add --scope user --transport stdio -- demo npx "a&b|c>d^e"');
    const line = composeWin32CommandLine('codex.cmd', [
      'mcp', 'add', '--', 'svc', 'node', 'server.js', 'x&y', 'p|q', 'a>b', 'c^d',
    ]);
    expect(line).toContain('"x&y"');
    expect(line).toContain('"p|q"');
    expect(line).toContain('"a>b"');
    expect(line).toContain('"c^d"');
  });
});

describe('execFileShellSpec', () => {
  it('on win32 shell path, MCP command/args with metacharacters become a quoted line + empty argv', () => {
    const args = ['mcp', 'add', '--', 'demo', 'npx', 'a&b|c>d^e'];
    const spec = execFileShellSpec('claude.cmd', args, 'win32');
    expect(spec.shell).toBe(true);
    expect(spec.args).toEqual([]);
    expect(spec.command).toBe('claude.cmd mcp add -- demo npx "a&b|c>d^e"');
  });

  it('off win32 keeps the original argv form (no composition)', () => {
    const args = ['mcp', 'add', '--', 'demo', 'npx', 'a&b|c>d^e'];
    expect(execFileShellSpec('claude', args, 'linux')).toEqual({
      command: 'claude',
      args,
      shell: false,
    });
  });

  it('on win32, absolute .exe (no shell needed) keeps argv form', () => {
    const args = ['mcp', 'add', '--', 'demo', 'node', 'a&b'];
    expect(execFileShellSpec('C:\\tools\\claude.exe', args, 'win32')).toEqual({
      command: 'C:\\tools\\claude.exe',
      args,
      shell: false,
    });
  });
});

describe('composeWin32CommandLine spawn round-trip (win32)', () => {
  const runOnWin32 = process.platform === 'win32' ? it : it.skip;

  runOnWin32('the child receives the tricky args byte-exact', () => {
    const script = 'process.stdout.write(JSON.stringify(process.argv.slice(1)))';
    const trickyArgs = [
      'hello world',
      'say "hi"',
      'a&b|c',
      'less<more>than',
      'C:\\Program Files\\thing',
      'trailing\\',
      'café ☕ 日本語',
      '',
    ];
    const line = composeWin32CommandLine(process.execPath, ['-e', script, ...trickyArgs]);
    const res = spawnSync(line, [], { shell: true, encoding: 'utf-8' });
    expect(res.status).toBe(0);
    expect(res.error).toBeUndefined();
    expect(JSON.parse(res.stdout)).toEqual(trickyArgs);
  });
});

describe('posixShellPath', () => {
  it('is /bin/sh on POSIX platforms', () => {
    expect(posixShellPath('linux')).toBe('/bin/sh');
    expect(posixShellPath('darwin')).toBe('/bin/sh');
  });

  it.runIf(process.platform === 'win32')('resolves a real sh/bash executable on Windows', () => {
    const shell = posixShellPath('win32');
    expect(path.win32.isAbsolute(shell)).toBe(true);
    expect(fs.existsSync(shell)).toBe(true);
    const res = spawnSync(shell, ['-c', "printf 'ok'"], { encoding: 'utf-8' });
    expect(res.status).toBe(0);
    expect(res.stdout).toBe('ok');
  });
});
