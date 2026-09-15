import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir, homedir } from 'os';
import { buildJobCommand, extractReport, inferFinalStatusFromLog } from '../src/lib/daemon/runner.js';
import { toPosix } from '../src/lib/platform/index.js';
import type { JobConfig } from '../src/lib/jobs.js';

const TEST_DIR = join(tmpdir(), 'agents-cli-runner-test');

function makeConfig(overrides: Partial<JobConfig> = {}): JobConfig {
  return {
    name: 'test-job',
    schedule: '0 9 * * *',
    agent: 'claude',
    mode: 'plan',
    effort: 'default',
    timeout: '30m',
    enabled: true,
    prompt: 'do something',
    ...overrides,
  };
}

describe('buildJobCommand', () => {
  describe('claude', () => {
    it('builds basic plan mode command', () => {
      const cmd = buildJobCommand(makeConfig(), 'hello world');
      expect(cmd[0]).toBe('claude');
      expect(cmd).toContain('-p');
      expect(cmd).toContain('hello world');
      expect(cmd).toContain('--permission-mode');
      expect(cmd).toContain('plan');
    });

    it('switches to acceptEdits in edit mode', () => {
      const cmd = buildJobCommand(makeConfig({ mode: 'edit' }), 'hello');
      expect(cmd).toContain('acceptEdits');
      expect(cmd).not.toContain('plan');
    });

    it('adds --add-dir for allowed dirs', () => {
      const config = makeConfig({
        allow: { dirs: ['~/projects/foo', '~/reports'] },
      });
      const cmd = buildJobCommand(config, 'hello');
      const addDirIndices = cmd.reduce<number[]>((acc, v, i) => {
        if (v === '--add-dir') acc.push(i);
        return acc;
      }, []);
      expect(addDirIndices.length).toBe(2);
      // The `~` expansion (os.homedir() + the rest of the entry) yields mixed
      // separators on Windows; compare separator-agnostically.
      expect(toPosix(cmd[addDirIndices[0] + 1])).toBe(toPosix(join(homedir(), 'projects/foo')));
      expect(toPosix(cmd[addDirIndices[1] + 1])).toBe(toPosix(join(homedir(), 'reports')));
    });

    it('adds --model flag when config.model is set', () => {
      const config = makeConfig({ config: { model: 'claude-sonnet-4-5' } });
      const cmd = buildJobCommand(config, 'hello');
      const modelIdx = cmd.indexOf('--model');
      expect(modelIdx).toBeGreaterThan(-1);
      expect(cmd[modelIdx + 1]).toBe('claude-sonnet-4-5');
    });

    it('does not add --model when not set', () => {
      const cmd = buildJobCommand(makeConfig(), 'hello');
      expect(cmd).not.toContain('--model');
    });
  });

  describe('codex', () => {
    it('builds basic command', () => {
      const cmd = buildJobCommand(makeConfig({ agent: 'codex' }), 'hello');
      expect(cmd[0]).toBe('codex');
      expect(cmd).toContain('exec');
      expect(cmd).toContain('hello');
    });

    it('edit mode uses the networked writable profile, no approval bypass', () => {
      const cmd = buildJobCommand(makeConfig({ agent: 'codex', mode: 'edit' }), 'hello');
      expect(cmd).not.toContain('--dangerously-bypass-approvals-and-sandbox');
      expect(cmd).toContain('default_permissions="agents-edit"');
      expect(cmd.join(' ')).toContain('extends = ":workspace"');
      expect(cmd.join(' ')).toContain('network = { enabled = true, allow_local_binding = true }');
    });

    it('plan mode uses the networked read-only profile, no bypass flag', () => {
      const cmd = buildJobCommand(makeConfig({ agent: 'codex', mode: 'plan' }), 'hello');
      expect(cmd).not.toContain('--dangerously-bypass-approvals-and-sandbox');
      expect(cmd).toContain('default_permissions="agents-plan"');
      expect(cmd.join(' ')).toContain('extends = ":read-only"');
    });

    // A routine runs with nobody watching, so `on-request` there is not a safety
    // net — it is a job that hangs on a dialog until the timeout kills it.
    it('auto mode keeps edit\'s sandbox but never prompts', () => {
      const cmd = buildJobCommand(makeConfig({ agent: 'codex', mode: 'auto' }), 'hello');
      expect(cmd).not.toContain('--dangerously-bypass-approvals-and-sandbox');
      expect(cmd).toContain('default_permissions="agents-auto"');
      expect(cmd).toContain('approval_policy="never"');
      expect(cmd.join(' ')).toContain('extends = ":workspace"');
      expect(cmd.join(' ')).toContain('network = { enabled = true, allow_local_binding = true }');
    });

    it('skip mode drops the sandbox and adds the bypass flag', () => {
      const cmd = buildJobCommand(makeConfig({ agent: 'codex', mode: 'skip' }), 'hello');
      expect(cmd).toContain('--dangerously-bypass-approvals-and-sandbox');
      expect(cmd).not.toContain('--sandbox');
    });

    it('adds --model flag when config.model is set', () => {
      const config = makeConfig({ agent: 'codex', config: { model: 'gpt-5.2-codex' } });
      const cmd = buildJobCommand(config, 'hello');
      const modelIdx = cmd.indexOf('--model');
      expect(modelIdx).toBeGreaterThan(-1);
      expect(cmd[modelIdx + 1]).toBe('gpt-5.2-codex');
    });
  });

  describe('gemini (hard-deprecated — no longer a routine target, RUSH-2719)', () => {
    it('buildJobCommand refuses gemini: it is outside ROUTINE_AGENT_IDS', () => {
      expect(() => buildJobCommand(makeConfig({ agent: 'gemini' }), 'hello'))
        .toThrow('Unsupported agent for daemon jobs: gemini');
    });
  });

  describe('cursor', () => {
    it('builds the exact edit mode command without a mode flag', () => {
      expect(buildJobCommand(makeConfig({ agent: 'cursor', mode: 'edit' }), 'hello')).toEqual([
        'cursor-agent',
        '-p',
        'hello',
        '--output-format',
        'stream-json',
        '--trust',
      ]);
    });

    it('builds the exact skip mode command with force approval', () => {
      expect(buildJobCommand(makeConfig({ agent: 'cursor', mode: 'skip' }), 'hello')).toEqual([
        'cursor-agent',
        '-p',
        'hello',
        '--output-format',
        'stream-json',
        '-f',
      ]);
    });

    it('builds the exact plan mode command with --plan', () => {
      expect(buildJobCommand(makeConfig({ agent: 'cursor', mode: 'plan' }), 'hello')).toEqual([
        'cursor-agent',
        '-p',
        'hello',
        '--output-format',
        'stream-json',
        '--plan',
      ]);
    });

    it('adds --model when config.model is set', () => {
      expect(buildJobCommand(makeConfig({
        agent: 'cursor',
        mode: 'edit',
        config: { model: 'sonnet-4-thinking' },
      }), 'hello')).toEqual([
        'cursor-agent',
        '-p',
        'hello',
        '--output-format',
        'stream-json',
        '--trust',
        '--model',
        'sonnet-4-thinking',
      ]);
    });
  });

  it('throws for unsupported agent', () => {
    expect(() => buildJobCommand(makeConfig({ agent: 'no-such-agent' as any }), 'hello')).toThrow(
      'Unsupported agent for daemon jobs: no-such-agent'
    );
  });
});

describe('inferFinalStatusFromLog', () => {
  it('recognizes a successful Cursor result event after a detached run is reaped', () => {
    const stdoutPath = join(TEST_DIR, 'cursor-result.jsonl');
    mkdirSync(TEST_DIR, { recursive: true });
    writeFileSync(stdoutPath, JSON.stringify({
      type: 'result',
      subtype: 'success',
      is_error: false,
      result: 'RUSH_2080_CURSOR_ROUTINE_OK',
    }));

    expect(inferFinalStatusFromLog(stdoutPath, 'cursor')).toEqual({
      status: 'completed',
      exitCode: 0,
    });
  });
});

describe('extractReport', () => {
  beforeEach(() => {
    mkdirSync(TEST_DIR, { recursive: true });
  });

  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it('extracts last text from claude stream-json', () => {
    const lines = [
      JSON.stringify({
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'First message' }] },
      }),
      JSON.stringify({
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'Final report here' }] },
      }),
    ];
    const logPath = join(TEST_DIR, 'claude.log');
    writeFileSync(logPath, lines.join('\n'), 'utf-8');

    expect(extractReport(logPath, 'claude')).toBe('Final report here');
  });

  it('extracts last text from codex output', () => {
    const lines = [
      JSON.stringify({ type: 'message', content: 'First' }),
      JSON.stringify({ type: 'message', content: 'Second report' }),
    ];
    const logPath = join(TEST_DIR, 'codex.log');
    writeFileSync(logPath, lines.join('\n'), 'utf-8');

    expect(extractReport(logPath, 'codex')).toBe('Second report');
  });

  it('extracts the last assistant text from cursor stream-json', () => {
    const lines = [
      JSON.stringify({
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'First' }] },
      }),
      JSON.stringify({
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'Cursor final report' }] },
      }),
    ];
    const logPath = join(TEST_DIR, 'cursor.log');
    writeFileSync(logPath, lines.join('\n'), 'utf-8');

    expect(extractReport(logPath, 'cursor')).toBe('Cursor final report');
  });

  it('returns null for nonexistent file', () => {
    expect(extractReport('/tmp/nonexistent-file-xyz.log', 'claude')).toBeNull();
  });

  it('returns null for empty file', () => {
    const logPath = join(TEST_DIR, 'empty.log');
    writeFileSync(logPath, '', 'utf-8');
    expect(extractReport(logPath, 'claude')).toBeNull();
  });

  it('handles non-JSON lines gracefully', () => {
    const lines = [
      'not json',
      JSON.stringify({
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'valid' }] },
      }),
      'also not json',
    ];
    const logPath = join(TEST_DIR, 'mixed.log');
    writeFileSync(logPath, lines.join('\n'), 'utf-8');

    expect(extractReport(logPath, 'claude')).toBe('valid');
  });

  it('skips non-text content blocks for claude', () => {
    const lines = [
      JSON.stringify({
        type: 'assistant',
        message: {
          content: [
            { type: 'tool_use', name: 'Read', input: {} },
            { type: 'text', text: 'The actual report' },
          ],
        },
      }),
    ];
    const logPath = join(TEST_DIR, 'claude-tools.log');
    writeFileSync(logPath, lines.join('\n'), 'utf-8');

    expect(extractReport(logPath, 'claude')).toBe('The actual report');
  });
});
