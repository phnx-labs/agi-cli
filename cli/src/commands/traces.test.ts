import { Command } from 'commander';
import { describe, expect, it } from 'vitest';
import { registerTracesCommands } from './traces.js';

describe('traces commands', () => {
  it('registers setup with the isolated traces resource defaults', () => {
    const program = new Command();
    registerTracesCommands(program);
    const traces = program.commands.find((command) => command.name() === 'traces');
    const setup = traces?.commands.find((command) => command.name() === 'setup');

    expect(setup).toBeDefined();
    expect(setup?.description()).toContain('self-hosted Cloudflare Worker');
    expect(setup?.description()).toMatch(/not required/i);
    expect(setup?.opts()).toMatchObject({
      bundle: 'cloudflare',
      worker: 'agents-traces',
      bucket: 'agents-traces',
      domain: 'traces.agents-cli.sh',
    });
  });
});
