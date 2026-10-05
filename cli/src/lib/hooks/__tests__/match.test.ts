import { describe, it, expect } from 'vitest';
import { shouldFire } from '../match.js';

describe('shouldFire predicate evaluator', () => {
  it('fires when matches is undefined (backward compat)', () => {
    expect(shouldFire(undefined, { prompt: 'anything' })).toBe(true);
  });

  it('fires when matches is empty', () => {
    expect(shouldFire({}, { prompt: 'anything' })).toBe(true);
  });

  describe('prompt_contains', () => {
    it('passes when prompt contains the substring', () => {
      expect(shouldFire({ prompt_contains: '#' }, { prompt: 'hi #checkit' })).toBe(true);
    });
    it('skips when prompt is missing the substring', () => {
      expect(shouldFire({ prompt_contains: '#' }, { prompt: 'hi' })).toBe(false);
    });
    it('skips when prompt is missing entirely', () => {
      expect(shouldFire({ prompt_contains: '#' }, {})).toBe(false);
    });
  });

  describe('prompt_matches', () => {
    it('passes on regex hit', () => {
      expect(shouldFire({ prompt_matches: '^debug ' }, { prompt: 'debug this' })).toBe(true);
    });
    it('skips on regex miss', () => {
      expect(shouldFire({ prompt_matches: '^debug ' }, { prompt: 'plan this' })).toBe(false);
    });
    it('skips on invalid regex', () => {
      expect(shouldFire({ prompt_matches: '[unclosed' }, { prompt: 'x' })).toBe(false);
    });
    it('skips obviously catastrophic nested quantifier regexes', () => {
      expect(shouldFire({ prompt_matches: '(.*?)+foo' }, { prompt: 'foo' })).toBe(false);
    });
  });

  describe('tool_name', () => {
    it('passes when tool_name in single-string allowlist', () => {
      expect(shouldFire({ tool_name: 'Bash' }, { tool_name: 'Bash' })).toBe(true);
    });
    it('passes when tool_name in array allowlist', () => {
      expect(shouldFire({ tool_name: ['Bash', 'Write'] }, { tool_name: 'Write' })).toBe(true);
    });
    it('skips when tool_name not in allowlist', () => {
      expect(shouldFire({ tool_name: ['Bash'] }, { tool_name: 'Read' })).toBe(false);
    });
    it('skips when tool_name absent from input', () => {
      expect(shouldFire({ tool_name: 'Bash' }, {})).toBe(false);
    });
  });

  describe('permission_mode', () => {
    it('passes when input mode is in the allowlist', () => {
      expect(shouldFire({ permission_mode: 'plan' }, { permission_mode: 'plan' })).toBe(true);
    });
    it('passes with array form', () => {
      expect(
        shouldFire({ permission_mode: ['plan', 'acceptEdits'] }, { permission_mode: 'acceptEdits' })
      ).toBe(true);
    });
    it('reads the camelCase spelling', () => {
      expect(shouldFire({ permission_mode: 'plan' }, { permissionMode: 'plan' })).toBe(true);
      expect(shouldFire({ permission_mode: 'plan' }, { permissionMode: 'default' })).toBe(false);
    });
    it('skips on an explicit non-listed mode', () => {
      expect(shouldFire({ permission_mode: 'plan' }, { permission_mode: 'default' })).toBe(false);
    });
    it('fails open when the input carries no mode field (harness does not report mode)', () => {
      expect(shouldFire({ permission_mode: 'plan' }, {})).toBe(true);
    });
  });

  describe('permission_mode_not', () => {
    it('skips in the named mode', () => {
      expect(shouldFire({ permission_mode_not: 'plan' }, { permission_mode: 'plan' })).toBe(false);
    });
    it('fires in every other mode', () => {
      expect(shouldFire({ permission_mode_not: 'plan' }, { permission_mode: 'default' })).toBe(true);
      expect(
        shouldFire({ permission_mode_not: 'plan' }, { permission_mode: 'acceptEdits' })
      ).toBe(true);
    });
    it('fires on a mode the exclusion list has never heard of', () => {
      expect(
        shouldFire({ permission_mode_not: 'plan' }, { permission_mode: 'someFutureMode' })
      ).toBe(true);
    });
    it('accepts the array form', () => {
      expect(
        shouldFire({ permission_mode_not: ['plan', 'acceptEdits'] }, { permission_mode: 'acceptEdits' })
      ).toBe(false);
      expect(
        shouldFire({ permission_mode_not: ['plan', 'acceptEdits'] }, { permission_mode: 'default' })
      ).toBe(true);
    });
    it('reads the camelCase spelling', () => {
      expect(shouldFire({ permission_mode_not: 'plan' }, { permissionMode: 'plan' })).toBe(false);
    });
    it('fails open when the harness reports no mode', () => {
      expect(shouldFire({ permission_mode_not: 'plan' }, {})).toBe(true);
    });
    it('ANDs with the positive form rather than overriding it', () => {
      const m = { permission_mode: ['plan', 'default'], permission_mode_not: 'plan' };
      expect(shouldFire(m, { permission_mode: 'default' })).toBe(true);
      expect(shouldFire(m, { permission_mode: 'plan' })).toBe(false);
    });
  });

  describe('tool_args_match', () => {
    it('matches against serialized object', () => {
      expect(
        shouldFire({ tool_args_match: 'rm -rf' }, { tool_args: { cmd: 'rm -rf /tmp' } })
      ).toBe(true);
    });
    it('matches against string', () => {
      expect(shouldFire({ tool_args_match: 'foo' }, { tool_args: 'foo bar' })).toBe(true);
    });
    it('skips when no match', () => {
      expect(shouldFire({ tool_args_match: 'rm' }, { tool_args: { cmd: 'ls' } })).toBe(false);
    });
  });

  describe('cwd_includes', () => {
    it('passes when cwd contains a needle', () => {
      expect(shouldFire({ cwd_includes: 'src' }, { cwd: '/home/me/src/x' })).toBe(true);
    });
    it('passes with array form', () => {
      expect(
        shouldFire({ cwd_includes: ['/work', '/play'] }, { cwd: '/home/me/work/x' })
      ).toBe(true);
    });
    it('skips when no needle matches', () => {
      expect(shouldFire({ cwd_includes: 'work' }, { cwd: '/home/me/play' })).toBe(false);
    });
  });

  describe('multiple predicates AND together', () => {
    it('passes only when every predicate passes', () => {
      expect(
        shouldFire(
          { prompt_contains: '#', tool_name: 'Bash' },
          { prompt: 'do #foo', tool_name: 'Bash' }
        )
      ).toBe(true);
    });
    it('skips when any predicate fails', () => {
      expect(
        shouldFire(
          { prompt_contains: '#', tool_name: 'Bash' },
          { prompt: 'do #foo', tool_name: 'Read' }
        )
      ).toBe(false);
    });
  });
});
