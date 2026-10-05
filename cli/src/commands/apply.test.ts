import { describe, it, expect } from 'vitest';
import { Command } from 'commander';
import { stripPad, registerFleetApplyAlias } from './apply.js';
import { buildFullCommandTree } from '../cli/command-registry.js';

const ESC = '\x1b';
const colored = `${ESC}[32mok 2/2${ESC}[39m`;
const strip = (s: string) => s.replace(new RegExp(`${ESC}\\[[0-9;]*m`, 'g'), '');

describe('stripPad', () => {
  it('pads to the visible width, counting the full ANSI escape (ESC byte included) as zero-width', () => {
    const out = stripPad(colored, 12);
    expect(strip(out).length).toBe(12);
    expect(strip(out)).toBe('ok 2/2      ');
  });

  it('pads a plain (uncolored) cell correctly', () => {
    expect(stripPad('hi', 5)).toBe('hi   ');
  });

  it('always adds at least one trailing space, even when already at/over width', () => {
    expect(stripPad('toolong', 4)).toBe('toolong ');
  });
});

describe('fleet apply', () => {
  it('registers apply under devices/fleet, not at the root', async () => {
    const program = await buildFullCommandTree();
    const names = program.commands.flatMap((c) => [c.name(), ...c.aliases()]);
    expect(names).not.toContain('apply');

    const devices = program.commands.find((c) => c.name() === 'devices');
    expect(devices).toBeDefined();
    expect(devices!.commands.map((c) => c.name())).toContain('apply');
  });

  it('attaches the reconcile flags on the nested command', () => {
    const program = new Command();
    const devices = program.command('devices');
    registerFleetApplyAlias(devices);
    const sub = devices.commands.find((c) => c.name() === 'apply');
    expect(sub).toBeDefined();
    const flags = sub!.options.map((o) => o.long);
    expect(flags).toContain('--plan');
    expect(flags).toContain('--device');
    expect(flags).toContain('--provision-secrets');
  });
});
