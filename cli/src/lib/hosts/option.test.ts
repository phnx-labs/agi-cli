import { describe, it, expect } from 'vitest';
import { Command } from 'commander';
import { addHostOption } from './option.js';

describe('addHostOption', () => {
  function build(): Command {
    return addHostOption(new Command('view')).exitOverride();
  }

  it('registers --device so a local fall-through does not error', () => {
    const cmd = build();
    expect(() => cmd.parse(['--device', 'mybox'], { from: 'user' })).not.toThrow();
    expect(cmd.opts().device).toBe('mybox');
  });

  it('rejects leftover --host / -H as an unknown option (RUSH-2494: no alias)', () => {
    const cmd = build();
    expect(() => cmd.parse(['--host', 'box'], { from: 'user' })).toThrow(/unknown option/i);
    expect(() => cmd.parse(['-H', 'box'], { from: 'user' })).toThrow(/unknown option/i);
  });

  it('registers -D short form and companion flags (--remote-cwd / --any)', () => {
    const cmd = build();
    expect(() => cmd.parse(['-D', 'mac', '--remote-cwd', '/srv', '--any'], { from: 'user' })).not.toThrow();
    const o = cmd.opts();
    expect(o.device).toBe('mac');
    expect(o.remoteCwd).toBe('/srv');
    expect(o.any).toBe(true);
  });
});
