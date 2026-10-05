import { describe, expect, it } from 'vitest';
import { isMissingBinarySignature, probeSpawnSpec } from './installations/versions.js';

// Missing-binary signatures gate install acceptance; ordinary nonzero --version exits do not.
describe('isMissingBinarySignature (gutted-install detector)', () => {
  it('flags the real codex ENOENT crash (wrapper present, native binary missing)', () => {
    const blob =
      'Error: spawn /Users/x/.agents/.history/versions/codex/0.116.0/node_modules/' +
      '@openai/codex-darwin-arm64/vendor/aarch64-apple-darwin/codex/codex ENOENT';
    expect(isMissingBinarySignature(blob)).toBe(true);
  });

  it('flags the other missing-file phrasings', () => {
    expect(isMissingBinarySignature('bash: codex: command not found')).toBe(true);
    expect(isMissingBinarySignature('dyld: no such file or directory')).toBe(true);
    expect(isMissingBinarySignature("'codex' is not recognized as an internal or external command")).toBe(true);
  });

  it('does NOT flag an agent that merely dislikes --version (ordinary nonzero exit)', () => {
    expect(isMissingBinarySignature('error: unknown option `--version`')).toBe(false);
    expect(isMissingBinarySignature('Usage: codex [options] <command>')).toBe(false);
    expect(isMissingBinarySignature('')).toBe(false);
  });

  it('does NOT match on unrelated text that merely contains a substring like "enoent"', () => {
    expect(isMissingBinarySignature('token: abcENOENTxyz')).toBe(false);
  });
});

// Windows probes quote the whole spaced .cmd command and pass no args to avoid false repair.
describe('probeSpawnSpec (launch-probe quoting)', () => {
  it('fully quotes a SPACED Windows .cmd path and empties the args array', () => {
    const spaced =
      'C:\\Users\\John Doe\\.agents\\.history\\versions\\claude\\2.1.191\\node_modules\\.bin\\claude.cmd';
    const spec = probeSpawnSpec(spaced, true);
    expect(spec.shell).toBe(true);
    expect(spec.args).toEqual([]);
    expect(spec.command).toBe(`"${spaced}" --version`);
    expect(spec.command.startsWith('"')).toBe(true);
  });

  it('does not quote a space-free Windows path (nothing to escape) but keeps empty args', () => {
    const p = 'C:\\Users\\muqsit\\.agents\\...\\claude.cmd';
    const spec = probeSpawnSpec(p, true);
    expect(spec.shell).toBe(true);
    expect(spec.args).toEqual([]);
    expect(spec.command).toBe(`${p} --version`);
  });

  it('POSIX: no shell, binary exec\'d directly with --version', () => {
    const p = '/home/user/.agents/.history/versions/claude/2.1.191/node_modules/.bin/claude';
    const spec = probeSpawnSpec(p, false);
    expect(spec.shell).toBe(false);
    expect(spec.command).toBe(p);
    expect(spec.args).toEqual(['--version']);
  });
});
