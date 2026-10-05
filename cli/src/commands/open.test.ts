/** PHNX-3949: `agents open` is the OS callback for `agents://` deep links, hidden as `_callback`,
 * with `open` a hidden alias for handlers written by older CLIs; handler management moved to
 * `agents setup url-scheme`. Pins the surface so an edit cannot break registered OS handlers. */
import { describe, it, expect } from 'vitest';
import { Command } from 'commander';
import { registerOpenCommand, addUrlSchemeSubcommands } from './open.js';

function buildProgram(): Command {
  const program = new Command();
  registerOpenCommand(program);
  return program;
}

describe('registerOpenCommand — machine-only `_callback` with `open` alias', () => {
  it('registers `_callback` as the primary name with `open` as an alias', () => {
    const program = buildProgram();
    const cmd = program.commands.find((c) => c.name() === '_callback');
    expect(cmd).toBeDefined();
    expect(cmd!.aliases()).toContain('open');
  });

  it('hides the command from the top-level surface', () => {
    const program = buildProgram();
    const cmd = program.commands.find((c) => c.name() === '_callback')!;
    expect((cmd as unknown as { _hidden: boolean })._hidden).toBe(true);
  });

  it('resolves `agents open <url>` through the alias (back-compat)', () => {
    const program = buildProgram();
    const byPrimary = program.commands.find((c) => c.name() === '_callback');
    const byAlias = program.commands.find((c) => c.aliases().includes('open'));
    expect(byAlias).toBe(byPrimary);
  });

  it('keeps register/unregister/status as HIDDEN back-compat subcommands', () => {
    const program = buildProgram();
    const cmd = program.commands.find((c) => c.name() === '_callback')!;
    const subs = cmd.commands;
    for (const name of ['register', 'unregister', 'status']) {
      const sub = subs.find((s) => s.name() === name);
      expect(sub, `expected hidden subcommand ${name}`).toBeDefined();
      expect((sub as unknown as { _hidden: boolean })._hidden).toBe(true);
    }
  });
});

describe('addUrlSchemeSubcommands — the shared builder reused under setup', () => {
  it('mounts VISIBLE register/unregister/status when hidden is false', () => {
    const parent = new Command('url-scheme');
    addUrlSchemeSubcommands(parent, { hidden: false });
    const names = parent.commands.map((c) => c.name());
    expect(names).toEqual(['register', 'unregister', 'status']);
    for (const sub of parent.commands) {
      expect((sub as unknown as { _hidden: boolean })._hidden).toBe(false);
    }
  });
});
