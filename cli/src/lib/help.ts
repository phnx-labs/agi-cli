import type { Command, Help } from 'commander';

interface CommandGroup {
  title: string;
  names: readonly string[];
}

const commandGroupRegistry = new WeakMap<Command, readonly CommandGroup[]>();

export function registerCommandGroups(parent: Command, groups: readonly CommandGroup[]): void {
  commandGroupRegistry.set(parent, groups);
}

export const FRONT_DOOR_COMMAND_GROUPS: readonly CommandGroup[] = [
  {
    title: 'Quick start',
    names: ['setup', 'view', 'run', 'sessions'],
  },
  {
    title: 'Most-used',
    names: ['teams', 'browser', 'secrets', 'devices', 'accounts', 'add'],
  },
];

const compactRootHelp = new WeakMap<Command, boolean>();

export function setCompactRootHelp(program: Command): void {
  compactRootHelp.set(program, true);
}

interface HelpSections {
  examples?: string;
  notes?: string;
}

const helpSectionRegistry = new WeakMap<Command, HelpSections>();

export function setHelpSections(cmd: Command, sections: HelpSections): void {
  helpSectionRegistry.set(cmd, sections);
}

export function getHelpSections(cmd: Command): Readonly<HelpSections> {
  return helpSectionRegistry.get(cmd) ?? {};
}

function dedent(body: string): string {
  const lines = body.replace(/^\n+/, '').replace(/\s+$/, '').split('\n');
  let minIndent = Infinity;
  for (const line of lines) {
    if (line.trim() === '') continue;
    const indent = line.match(/^[ \t]*/)?.[0].length ?? 0;
    if (indent < minIndent) minIndent = indent;
  }
  if (!Number.isFinite(minIndent) || minIndent === 0) return lines.join('\n');
  return lines.map((line) => (line.length >= minIndent ? line.slice(minIndent) : line)).join('\n');
}

function indentBlock(body: string): string {
  return body
    .split('\n')
    .map((line) => (line.length === 0 ? '' : `  ${line}`))
    .join('\n');
}

function formatHelpCommandsFirst(cmd: Command, helper: Help): string {
  const termWidth = helper.padWidth(cmd, helper);
  const helpWidth = helper.helpWidth || 80;
  const itemIndentWidth = 2;
  const itemSeparatorWidth = 2;

  function formatItem(term: string, description?: string): string {
    if (description) {
      return helper.formatItem(term, termWidth, description, helper);
    }
    return ' '.repeat(itemIndentWidth) + term;
  }

  function formatList(textArray: string[]): string {
    return textArray.join('\n');
  }

  const isHidden = (a: { hidden?: boolean }): boolean => a.hidden === true;
  const registeredArgs = (cmd as unknown as { registeredArguments?: ReadonlyArray<{ name(): string; required: boolean; variadic: boolean; hidden?: boolean }> }).registeredArguments ?? [];

  const parentNames: string[] = [];
  for (let p = cmd.parent; p; p = p.parent) parentNames.unshift(p.name());
  const parentPrefix = parentNames.length > 0 ? parentNames.join(' ') + ' ' : '';
  const visibleArgTokens = registeredArgs
    .filter((a) => !isHidden(a))
    .map((a) => {
      const n = a.name() + (a.variadic ? '...' : '');
      return a.required ? `<${n}>` : `[${n}]`;
    })
    .join(' ');
  const argsToken = visibleArgTokens ? ` ${visibleArgTokens}` : '';
  const commandToken = cmd.commands.length > 0 ? ' [command]' : '';
  const usageLine = `${parentPrefix}${cmd.name()} [options]${argsToken}${commandToken}`;
  let output = [`Usage: ${usageLine}`, ''];

  const commandDescription = helper.commandDescription(cmd);
  if (commandDescription.length > 0) {
    output = output.concat([helper.boxWrap(commandDescription, helpWidth), '']);
  }

  const sections = helpSectionRegistry.get(cmd);
  if (sections?.examples) {
    output = output.concat(['Examples:', indentBlock(dedent(sections.examples)), '']);
  }

  const argumentList = helper
    .visibleArguments(cmd)
    .filter((a) => !isHidden(a as { hidden?: boolean }))
    .map((argument) => {
      return formatItem(helper.argumentTerm(argument), helper.argumentDescription(argument));
    });
  if (argumentList.length > 0) {
    output = output.concat(['Arguments:', formatList(argumentList), '']);
  }

  const visibleCommands = helper.visibleCommands(cmd);
  const subcommandTermNoAlias = (sub: Command): string => {
    const argList = (sub as unknown as { registeredArguments?: ReadonlyArray<{ name(): string; required: boolean; variadic: boolean; hidden?: boolean }> }).registeredArguments ?? [];
    const args = argList
      .filter((a) => !a.hidden)
      .map((a) => {
        const n = a.name() + (a.variadic ? '...' : '');
        return a.required ? `<${n}>` : `[${n}]`;
      })
      .join(' ');
    return sub.name() + (sub.options.length > 0 ? ' [options]' : '') + (args ? ` ${args}` : '');
  };
  const renderCommand = (sub: Command): string =>
    formatItem(subcommandTermNoAlias(sub), helper.subcommandDescription(sub));
  const groups = commandGroupRegistry.get(cmd);
  if (groups && groups.length > 0) {
    const byName = new Map(visibleCommands.map((s) => [s.name(), s] as const));
    const placed = new Set<string>();
    for (const { title, names } of groups) {
      const subs = names
        .map((n) => byName.get(n))
        .filter((s): s is Command => s !== undefined);
      if (subs.length === 0) continue;
      subs.forEach((s) => placed.add(s.name()));
      output = output.concat([`${title}:`, formatList(subs.map(renderCommand)), '']);
    }
    const remaining = visibleCommands.filter((s) => !placed.has(s.name()));
    if (compactRootHelp.get(cmd)) {
      output = output.concat([
        'Commands:',
        `  See "${cmd.name()} --help-all" for every command.`,
        '',
      ]);
    } else if (remaining.length > 0) {
      output = output.concat(['Commands:', formatList(remaining.map(renderCommand)), '']);
    }
  } else if (visibleCommands.length > 0) {
    output = output.concat(['Commands:', formatList(visibleCommands.map(renderCommand)), '']);
  }

  const optionList = helper.visibleOptions(cmd).map((option) => {
    return formatItem(helper.optionTerm(option), helper.optionDescription(option));
  });
  if (optionList.length > 0) {
    output = output.concat(['Options:', formatList(optionList), '']);
  }

  if (helper.showGlobalOptions) {
    const globalOptionList = helper.visibleGlobalOptions(cmd).map((option) => {
      return formatItem(helper.optionTerm(option), helper.optionDescription(option));
    });
    if (globalOptionList.length > 0) {
      output = output.concat(['Global Options:', formatList(globalOptionList), '']);
    }
  }

  if (sections?.notes) {
    output = output.concat(['Notes:', indentBlock(dedent(sections.notes)), '']);
  }

  return output.join('\n');
}

function applyHelpConventionsRecursive(cmd: Command): void {
  cmd
    .helpOption('-h, --help', 'Show help')
    .addHelpCommand(false)
    .configureHelp({
      formatHelp: formatHelpCommandsFirst,
    });

  for (const subcommand of cmd.commands) {
    applyHelpConventionsRecursive(subcommand);
  }
}

export function applyGlobalHelpConventions(root: Command): void {
  applyHelpConventionsRecursive(root);
}
