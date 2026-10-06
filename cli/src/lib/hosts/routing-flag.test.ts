import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Command } from 'commander';
import { registerSendCommand } from '../../commands/send.js';
import { stripRoutingFlags } from './remote-cmd.js';
import {
  commandTokenIndex,
  flagValue,
  hasHostRoutingFlag,
  ROUTING_OPTION_SPECS,
  setArgvCommandTree,
} from './routing-flag.js';

describe('flagValue', () => {
  it('reads the space-separated long form', () => {
    expect(flagValue(['view', '--device', 'mac'], 'device', 'D')).toBe('mac');
  });
  it('reads the --device=value form', () => {
    expect(flagValue(['view', '--device=mac'], 'device', 'D')).toBe('mac');
  });
  it('reads the -D value and glued -Dmac forms', () => {
    expect(flagValue(['view', '-D', 'mac'], 'device', 'D')).toBe('mac');
    expect(flagValue(['view', '-Dmac'], 'device', 'D')).toBe('mac');
  });
  it('reads --remote-cwd (long-only, no short)', () => {
    expect(flagValue(['sync', '--remote-cwd', '/srv'], 'remote-cwd')).toBe('/srv');
  });
  it('returns undefined when absent', () => {
    expect(flagValue(['view', '--json'], 'device', 'D')).toBeUndefined();
  });
});

describe('hasHostRoutingFlag', () => {
  it('is false for ordinary local argvs (the majority path bootstrap must skip)', () => {
    expect(hasHostRoutingFlag(['view'])).toBe(false);
    expect(hasHostRoutingFlag(['sync', 'claude', '--yes'])).toBe(false);
    expect(hasHostRoutingFlag(['skills', 'list'])).toBe(false);
    expect(hasHostRoutingFlag(['doctor'])).toBe(false);
    expect(
      hasHostRoutingFlag([
        'run',
        'claude',
        '--mode',
        'edit',
        '--name',
        'bench',
        '--profile',
        'default',
        '-p',
        'do the thing',
        '--json',
      ]),
    ).toBe(false);
  });

  it('is true for every form maybeRunOnHost accepts', () => {
    expect(hasHostRoutingFlag(['view', '--device', 'box'])).toBe(true);
    expect(hasHostRoutingFlag(['view', '--device=box'])).toBe(true);
    expect(hasHostRoutingFlag(['view', '-D', 'box'])).toBe(true);
    expect(hasHostRoutingFlag(['view', '-Dbox'])).toBe(true);
    expect(hasHostRoutingFlag(['view', '--hosts', 'all'])).toBe(true);
    expect(hasHostRoutingFlag(['view', '--hosts=all'])).toBe(true);
    expect(hasHostRoutingFlag(['view', '--devices', 'all'])).toBe(true);
    expect(hasHostRoutingFlag(['view', '--devices=all'])).toBe(true);
  });

  it('does not treat --remote-cwd alone as a routing flag (local-only companion)', () => {
    expect(hasHostRoutingFlag(['view', '--remote-cwd', '/srv'])).toBe(false);
  });
});

describe('option-aware routing scan over the registered command tree', () => {
  beforeEach(() => {
    const program = new Command().option('--verbose');
    registerSendCommand(program);
    setArgvCommandTree(program);
  });
  afterEach(() => setArgvCommandTree(undefined));

  const SEND = ['send', '--channel', 'session', '--to', 'beef1234'];

  it('keeps a routing-shaped --text value as the message and routes on the real selector', () => {
    for (const text of ['--device=other', '-Dx', '--host=other', '--device', '-D']) {
      const argv = [...SEND, '--text', text, '--no-enter', '--device', 'peer'];
      expect(flagValue(argv, 'device', 'D'), text).toBe('peer');
      expect(stripRoutingFlags(argv, ROUTING_OPTION_SPECS), text).toEqual([...SEND, '--text', text, '--no-enter']);
    }
  });

  it('does not route on a selector-shaped message that precedes the real selector', () => {
    const argv = [...SEND, '--text', '--device=other', '--device', 'peer'];
    expect(flagValue(argv, 'device', 'D')).toBe('peer');
    expect(hasHostRoutingFlag([...SEND, '--text', '--device=other'])).toBe(false);
  });

  it('treats a joined --text=--device=other as one option', () => {
    const argv = [...SEND, '--text=--device=other', '-Dpeer'];
    expect(flagValue(argv, 'device', 'D')).toBe('peer');
    expect(stripRoutingFlags(argv, ROUTING_OPTION_SPECS)).toEqual([...SEND, '--text=--device=other']);
  });

  it('leaves everything after -- as positional data', () => {
    const argv = [...SEND, '--device', 'peer', '--', '--device=other', '-Dx'];
    expect(flagValue(argv, 'device', 'D')).toBe('peer');
    expect(stripRoutingFlags(argv, ROUTING_OPTION_SPECS)).toEqual([...SEND, '--', '--device=other', '-Dx']);
    expect(hasHostRoutingFlag([...SEND, '--', '--device=other'])).toBe(false);
  });

  it('finds the command after global routing and root options in every form', () => {
    expect(commandTokenIndex(['--device', 'peer', ...SEND])).toBe(2);
    expect(commandTokenIndex(['--device=peer', ...SEND])).toBe(1);
    expect(commandTokenIndex(['-Dpeer', ...SEND])).toBe(1);
    expect(commandTokenIndex(['--verbose', '--remote-cwd', '/srv', '-D', 'peer', ...SEND])).toBe(5);
    expect(commandTokenIndex(['--', 'send'])).toBeUndefined();
    expect(stripRoutingFlags(['--device', 'peer', ...SEND, '--text', 'x'], ROUTING_OPTION_SPECS)).toEqual([...SEND, '--text', 'x']);
  });

  it('keeps the first of repeated selectors and strips all of them', () => {
    const argv = [...SEND, '--device', 'a', '-Db', '--text', 'x'];
    expect(flagValue(argv, 'device', 'D')).toBe('a');
    expect(stripRoutingFlags(argv, ROUTING_OPTION_SPECS)).toEqual([...SEND, '--text', 'x']);
  });

  it('consumes a variadic option value only up to the next dash-led token', () => {
    const argv = [...SEND, '--url', 'https://a.test', 'https://b.test', '--device=peer'];
    expect(flagValue(argv, 'device', 'D')).toBe('peer');
  });
});
