import { Command } from 'commander';
import { describe, expect, it } from 'vitest';
import { registerSessionsWatchCommand } from './sessions-watch.js';

describe('sessions watch command', () => {
  it('registers the JSON and local stream surface', () => {
    const parent = new Command('sessions');
    registerSessionsWatchCommand(parent);
    const command = parent.commands.find((candidate) => candidate.name() === 'watch');
    expect(command).toBeDefined();
    expect(command!.options.map((option) => option.long)).toEqual(['--json', '--local', '--include-lead']);
  });
});
