import { describe, it, expect } from 'vitest';
import {
  resolveAutonomy,
  buildExecArgs,
  buildSshArgs,
  mapResultStatus,
  mapDroidEvent,
  parseComputerList,
  FactoryCloudProvider,
} from './factory.js';
import { SSH_OPTS, SSH_CONTROL_PERSIST_SECONDS } from '../ssh-exec.js';

describe('resolveAutonomy', () => {
  it('passes through valid levels', () => {
    expect(resolveAutonomy('low')).toBe('low');
    expect(resolveAutonomy('medium')).toBe('medium');
    expect(resolveAutonomy('high')).toBe('high');
  });

  it('falls back to high for invalid/missing values', () => {
    expect(resolveAutonomy(undefined)).toBe('high');
    expect(resolveAutonomy('full')).toBe('high');
    expect(resolveAutonomy(42)).toBe('high');
  });

  it('honors a custom fallback', () => {
    expect(resolveAutonomy(undefined, 'low')).toBe('low');
  });
});

describe('buildExecArgs', () => {
  it('builds a headless stream-json exec with autonomy', () => {
    expect(buildExecArgs('fix the bug', { autonomy: 'high' })).toEqual([
      'exec', '--auto', 'high', '--output-format', 'stream-json', 'fix the bug',
    ]);
  });

  it('inserts -s when resuming a session', () => {
    expect(buildExecArgs('keep going', { autonomy: 'medium', sessionId: 'sess-123' })).toEqual([
      'exec', '--auto', 'medium', '--output-format', 'stream-json', '-s', 'sess-123', 'keep going',
    ]);
  });
});

describe('buildSshArgs', () => {
  it('wires the droid relay as an OpenSSH ProxyCommand and quotes the remote cmd', () => {
    const args = buildSshArgs(
      'cloud-vm-1',
      'droid',
      ['exec', '--auto', 'high', '--output-format', 'stream-json', 'do a thing'],
      { droidBin: '/usr/bin/droid', user: 'droid' },
    );
    expect(args).toContain('-o');
    expect(args.some((a) => a.startsWith('ProxyCommand=/usr/bin/droid computer ssh cloud-vm-1 --proxy'))).toBe(true);
    for (const opt of SSH_OPTS) expect(args).toContain(opt);
    if (process.platform !== 'win32') {
      expect(args).toContain('ControlMaster=auto');
      expect(args).toContain(`ControlPersist=${SSH_CONTROL_PERSIST_SECONDS}s`);
    }
    const targetIdx = args.indexOf('droid@cloud-vm-1');
    expect(args.indexOf('ProxyCommand=/usr/bin/droid computer ssh cloud-vm-1 --proxy --port %p')).toBeLessThan(targetIdx);
    expect(args.indexOf('ConnectTimeout=10')).toBeLessThan(targetIdx);
    expect(targetIdx).toBeGreaterThanOrEqual(0);
    expect(args[args.length - 1]).toBe(
      `'droid' 'exec' '--auto' 'high' '--output-format' 'stream-json' 'do a thing'`,
    );
  });

  it('escapes single quotes in the prompt safely', () => {
    const args = buildSshArgs('vm', 'droid', ['exec', `it's fine`], { droidBin: 'droid', user: 'droid' });
    expect(args[args.length - 1]).toContain(`'it'\\''s fine'`);
  });

  it('prefixes runtime env for the remote droid exec command', () => {
    const args = buildSshArgs(
      'vm',
      'droid',
      ['exec', 'publish'],
      { droidBin: 'droid', user: 'droid', env: { SHARE_WRITE_TOKEN: `tok'en` } },
    );
    expect(args[args.length - 1]).toBe(`SHARE_WRITE_TOKEN='tok'\\''en' 'droid' 'exec' 'publish'`);
  });

  it('rejects invalid runtime env keys instead of silently dropping them', () => {
    expect(() =>
      buildSshArgs('vm', 'droid', ['exec'], { droidBin: 'droid', user: 'droid', env: { 'BAD-KEY': 'x' } }),
    ).toThrow(/Invalid runtime env key/);
  });
});

describe('mapResultStatus', () => {
  it('maps is_error to failed', () => {
    expect(mapResultStatus({ is_error: true, subtype: 'error' })).toBe('failed');
  });
  it('maps success to completed', () => {
    expect(mapResultStatus({ is_error: false, subtype: 'success' })).toBe('completed');
  });
  it('detects cancellation in subtype', () => {
    expect(mapResultStatus({ is_error: false, subtype: 'cancelled' })).toBe('cancelled');
  });
});

describe('mapDroidEvent', () => {
  it('maps a result event to done with status + summary', () => {
    const ev = mapDroidEvent({ type: 'result', subtype: 'success', is_error: false, result: 'all green', session_id: 'abc' });
    expect(ev.type).toBe('done');
    if (ev.type === 'done') {
      expect(ev.status).toBe('completed');
      expect(ev.summary).toBe('all green');
    }
  });

  it('maps an errored result to a failed done', () => {
    const ev = mapDroidEvent({ type: 'result', is_error: true, result: 'boom' });
    expect(ev.type).toBe('done');
    if (ev.type === 'done') expect(ev.status).toBe('failed');
  });

  it('maps assistant text', () => {
    const ev = mapDroidEvent({ type: 'assistant', text: 'thinking out loud' });
    expect(ev).toMatchObject({ type: 'text', content: 'thinking out loud' });
  });

  it('extracts text from a content array', () => {
    const ev = mapDroidEvent({ type: 'message', content: [{ text: 'a' }, { text: 'b' }] });
    expect(ev).toMatchObject({ type: 'text', content: 'ab' });
  });

  it('maps tool calls and results', () => {
    expect(mapDroidEvent({ type: 'tool_call', name: 'Bash', input: { cmd: 'ls' } }))
      .toMatchObject({ type: 'tool_use', tool: 'Bash' });
    expect(mapDroidEvent({ type: 'tool_result', name: 'Bash', output: 'files' }))
      .toMatchObject({ type: 'tool_result', tool: 'Bash' });
  });

  it('surfaces unknown event types rather than dropping them', () => {
    const ev = mapDroidEvent({ type: 'mystery', foo: 1 });
    expect(ev.type).toBe('unknown');
    if (ev.type === 'unknown') expect(ev.name).toBe('mystery');
  });
});

describe('parseComputerList', () => {
  it('parses computer names from a tabular listing, skipping the header', () => {
    const out = parseComputerList(
      [
        'NAME            STATUS    TYPE',
        'cloud-vm-1      active    managed',
        'my-laptop       paused    byom',
      ].join('\n'),
    );
    expect(out).toEqual([
      { id: 'cloud-vm-1', label: 'active    managed', kind: 'computer' },
      { id: 'my-laptop', label: 'paused    byom', kind: 'computer' },
    ]);
  });

  it('handles a bare name-per-line listing', () => {
    expect(parseComputerList('alpha\nbeta\n')).toEqual([
      { id: 'alpha', label: undefined, kind: 'computer' },
      { id: 'beta', label: undefined, kind: 'computer' },
    ]);
  });

  it('skips separators and status messages, yielding [] on empty/error output', () => {
    expect(parseComputerList('')).toEqual([]);
    expect(parseComputerList('No authenticated user with organization available')).toEqual([]);
    expect(parseComputerList('-------\n=======')).toEqual([]);
  });
});

describe('FactoryCloudProvider target discovery', () => {
  it('declares computer as its target kind', () => {
    expect(new FactoryCloudProvider().targetKind).toBe('computer');
  });
});
