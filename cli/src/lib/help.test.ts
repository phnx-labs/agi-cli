import { Command } from 'commander';
import { describe, expect, it } from 'vitest';

import { applyGlobalHelpConventions, registerCommandGroups, renderRootHelp, setHelpSections } from './help.js';

function buildTestCommand(opts: { examples?: string; notes?: string } = {}): Command {
  const root = new Command('agents');
  const sub = root
    .command('demo')
    .description('Run a demo of the help formatter.')
    .option('--flag', 'a flag');

  applyGlobalHelpConventions(root);
  setHelpSections(sub, opts);
  return sub;
}

describe('setHelpSections + formatHelpCommandsFirst', () => {
  it('renders Examples between the description and Options', () => {
    const sub = buildTestCommand({
      examples: `
        # do the thing
        agents demo
      `,
    });
    const help = sub.helpInformation();

    const descIdx = help.indexOf('Run a demo of the help formatter.');
    const examplesIdx = help.indexOf('Examples:');
    const optionsIdx = help.indexOf('Options:');

    expect(descIdx).toBeGreaterThanOrEqual(0);
    expect(examplesIdx).toBeGreaterThan(descIdx);
    expect(optionsIdx).toBeGreaterThan(examplesIdx);
  });

  it('renders Notes after Options at the very end', () => {
    const sub = buildTestCommand({
      examples: '# x\nagents demo',
      notes: '- a caveat',
    });
    const help = sub.helpInformation();

    const optionsIdx = help.indexOf('Options:');
    const notesIdx = help.indexOf('Notes:');

    expect(optionsIdx).toBeGreaterThanOrEqual(0);
    expect(notesIdx).toBeGreaterThan(optionsIdx);
    expect(help.slice(notesIdx)).toContain('- a caveat');
  });

  it('omits Examples and Notes headings when no sections are set', () => {
    const sub = buildTestCommand();
    const help = sub.helpInformation();

    expect(help).not.toContain('Examples:');
    expect(help).not.toContain('Notes:');
  });

  it('dedents bodies so callers can pass natural indented template literals', () => {
    const sub = buildTestCommand({
      examples: `
            # comment
            agents demo --flag
      `,
    });
    const help = sub.helpInformation();

    // After dedent + 2-space reindent, both comment and command sit at column 2.
    expect(help).toContain('\n  # comment\n');
    expect(help).toContain('\n  agents demo --flag\n');
  });

  it('preserves internal indentation inside dedented blocks', () => {
    const sub = buildTestCommand({
      notes: `
        Modes:
          plan  read-only
          edit  can write
      `,
    });
    const help = sub.helpInformation();
    expect(help).toContain('  Modes:');
    expect(help).toContain('    plan  read-only');
    expect(help).toContain('    edit  can write');
  });
});

describe('registerCommandGroups', () => {
  function buildGroupedParent(): Command {
    const root = new Command('agents');
    const parent = root.command('devices').description('Device registry.');
    for (const name of ['sync', 'list', 'show', 'status', 'prefer']) {
      parent.command(name).description(`${name} devices.`);
    }
    applyGlobalHelpConventions(root);
    registerCommandGroups(parent, [
      { title: 'Discover & register', names: ['sync'] },
      { title: 'Inspect', names: ['list', 'show', 'status'] },
    ]);
    return parent;
  }

  it('renders groups as titled sections in the registered order', () => {
    const help = buildGroupedParent().helpInformation();

    const discoverIdx = help.indexOf('Discover & register:');
    const inspectIdx = help.indexOf('Inspect:');

    expect(discoverIdx).toBeGreaterThanOrEqual(0);
    expect(inspectIdx).toBeGreaterThan(discoverIdx);
    expect(help.slice(discoverIdx, inspectIdx)).toContain('sync');
    expect(help.slice(inspectIdx)).toContain('list');
    expect(help.slice(inspectIdx)).toContain('show');
    expect(help.slice(inspectIdx)).toContain('status');
  });

  it('renders ungrouped subcommands under a plain Commands section after the groups', () => {
    const help = buildGroupedParent().helpInformation();

    const inspectIdx = help.indexOf('Inspect:');
    const commandsIdx = help.indexOf('Commands:');

    expect(commandsIdx).toBeGreaterThan(inspectIdx);
    expect(help.slice(commandsIdx)).toContain('prefer');
    expect(help.slice(commandsIdx)).not.toContain('sync');
  });

  it('skips a group whose names match no visible subcommand', () => {
    const root = new Command('agents');
    const parent = root.command('devices').description('Device registry.');
    parent.command('list').description('List devices.');
    applyGlobalHelpConventions(root);
    registerCommandGroups(parent, [
      { title: 'Ghost group', names: ['nope'] },
      { title: 'Inspect', names: ['list'] },
    ]);
    const help = parent.helpInformation();

    expect(help).not.toContain('Ghost group:');
    expect(help).toContain('Inspect:');
    expect(help).not.toContain('Commands:');
  });
});

describe('renderRootHelp', () => {
  it('lists FRONT_DOOR groups and a pointer to --help --all, not ssh', () => {
    const help = renderRootHelp();

    expect(help).toContain('Start here:');
    expect(help).toContain('Every day:');
    expect(help).toContain('agents --help --all');
    expect(help).toMatch(/^\s{2}setup\s/m);
    expect(help).toMatch(/^\s{2}run /m);
    expect(help).toMatch(/^\s{2}sessions\s/m);
    expect(help).toMatch(/^\s{2}view\s/m);
    expect(help).not.toMatch(/^\s{2}ssh\s/m);
    expect(help).not.toMatch(/^\s{2}repos\s/m);
    expect(help).not.toMatch(/^\s{2}computer\s/m);
    expect(help).not.toMatch(/^\s{2}notify\s/m);

    const twoColumn = help.split('\n').filter((line) => /^\s{2,6}[a-z][a-z0-9_:-]+\s{2,}/.test(line));
    expect(twoColumn.length).toBeLessThanOrEqual(12);
    expect(twoColumn.length).toBeGreaterThanOrEqual(8);
  });

  it('lists every passed group on the --all path, including ssh', () => {
    const help = renderRootHelp({
      groups: [
        { name: 'sessions', description: 'Find, browse, and read transcripts.' },
        { name: 'ssh', description: 'Connect to a registered device.' },
        { name: 'repos', description: 'Manage extra DotAgent repos.' },
      ],
    });

    expect(help).toContain('All command groups:');
    expect(help).toMatch(/^\s{2}ssh\s{2,}Connect to a registered device\./m);
    expect(help).toMatch(/^\s{2}repos\s{2,}/m);
    expect(help).toContain("See 'agents <group> --help'");
    expect(help).not.toContain('Start here:');
  });

  it('drops disabled FRONT_DOOR groups and rewrites the brand name', () => {
    const help = renderRootHelp({ cliName: 'jack', disabled: new Set(['browser', 'devices']) });

    expect(help).toContain('Usage: jack [command] [options]');
    expect(help).toContain('jack --help --all');
    expect(help).not.toMatch(/^\s{2}browser\s{2,}/m);
    expect(help).not.toMatch(/^\s{2}devices\s{2,}/m);
    expect(help).toMatch(/^\s{2}secrets\s{2,}/m);
  });

  it('fails loud when --all is asked to render an empty group list', () => {
    expect(() => renderRootHelp({ groups: [] })).toThrow(/no visible groups/);
    expect(() => renderRootHelp({ groups: [{ name: 'ssh', description: 'x' }], disabled: new Set(['ssh']) })).toThrow(
      /no visible groups/,
    );
  });
});
