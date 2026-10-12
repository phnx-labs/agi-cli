import { describe, it, expect } from 'vitest';
import { Command } from 'commander';
import { registerPsCommand } from './ps.js';

function psGroup(): Command {
  const program = new Command();
  program.exitOverride();
  registerPsCommand(program);
  const ps = program.commands.find((c) => c.name() === 'ps');
  if (!ps) throw new Error('ps command not registered');
  return ps;
}

describe('session lifecycle verbs are grouped under `ps`', () => {
  const ps = psGroup();
  const names = ps.commands.map((c) => c.name());

  it('hosts detach as a `ps` subcommand (not top-level)', () => {
    expect(names).toContain('detach');
    expect(names).not.toContain('attach');
    expect(names).not.toContain('go');
    expect(names).not.toContain('reconnect');
  });

  it('keeps them alongside the sibling lifecycle verbs', () => {
    expect(names).toEqual(expect.arrayContaining(['stop', 'focus', 'migrate', 'migrations', 'preview', 'watch']));
    expect(names).not.toContain('resume');
  });

  it("renames migrate's old `detach` alias to `relocate` so it can't collide with the new verb", () => {
    const migrate = ps.commands.find((c) => c.name() === 'migrate');
    expect(migrate).toBeDefined();
    expect(migrate!.aliases()).toContain('relocate');
    expect(migrate!.aliases()).not.toContain('detach');
  });
});

describe('ps routine discovery surface', () => {
  it('registers --routines as an alias and accepts an optional routine name', () => {
    const routine = psGroup().options.find((option) => option.long === '--routine');
    expect(routine).toBeDefined();
    expect(routine!.short).toBe('--routines');
    expect(routine!.optional).toBe(true);
  });
});
