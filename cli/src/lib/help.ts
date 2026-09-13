/**
 * Custom help formatting for the CLI.
 *
 * Overrides commander's default help layout to show Commands before Options,
 * and applies consistent conventions (short -h flag, no implicit help subcommand).
 */
import type { Command, Help } from 'commander';

/** Description of a named command group rendered as its own section in help output. */
interface CommandGroup {
  /** Section heading, e.g. 'Bundle commands'. */
  title: string;
  /** Subcommand names (in desired display order) that belong to this group. */
  names: readonly string[];
}

const commandGroupRegistry = new WeakMap<Command, readonly CommandGroup[]>();

/**
 * Register named groups for a parent command so its help output splits the
 * Commands section into multiple labeled sections. Subcommands not listed in
 * any group fall back to a plain "Commands:" section below the groups.
 */
export function registerCommandGroups(parent: Command, groups: readonly CommandGroup[]): void {
  commandGroupRegistry.set(parent, groups);
}

/**
 * Front-door command groups shown on `agents --help`. Derived from measured
 * reach: tier 1 = setup/run/sessions/view, tier 2 = teams/browser/secrets/
 * devices/accounts/add. The remaining groups stay discoverable through the
 * pointer rendered below these groups.
 */
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

/** Mark the root program so its help only renders front-door groups + a pointer. */
export function setCompactRootHelp(program: Command): void {
  compactRootHelp.set(program, true);
}

/** Examples + Notes blocks attached to a command via setHelpSections. */
interface HelpSections {
  examples?: string;
  notes?: string;
}

const helpSectionRegistry = new WeakMap<Command, HelpSections>();

/**
 * Attach an Examples block (rendered between the description and Arguments)
 * and/or a Notes block (rendered at the very end, after Options) to a command.
 *
 * Bodies are normalized: the shared leading indent is stripped, then every line
 * is re-indented by two spaces. Callers can pass natural multiline template
 * literals without babysitting whitespace.
 */
export function setHelpSections(cmd: Command, sections: HelpSections): void {
  helpSectionRegistry.set(cmd, sections);
}

/** Read the workflow-first sections attached to a command for generated references. */
export function getHelpSections(cmd: Command): Readonly<HelpSections> {
  return helpSectionRegistry.get(cmd) ?? {};
}

/** Strip a uniform leading indent from a block and trim surrounding blank lines. */
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

/** Re-indent a dedented block by two spaces so it sits under a section heading. */
function indentBlock(body: string): string {
  return body
    .split('\n')
    .map((line) => (line.length === 0 ? '' : `  ${line}`))
    .join('\n');
}

/** Format help output with Commands listed before Options for better discoverability. */
function formatHelpCommandsFirst(cmd: Command, helper: Help): string {
  const termWidth = helper.padWidth(cmd, helper);
  const helpWidth = helper.helpWidth || 80;
  const itemIndentWidth = 2;
  const itemSeparatorWidth = 2;

  // commander v15 dropped `Help.wrap(str, width, indent)` in favor of
  // `boxWrap(str, width)` plus a built-in `formatItem(term, termWidth,
  // description, helper)` that handles the term-pad + continuation-indent
  // math we used to do by hand. Delegate to it so callers get the same
  // continuation-line alignment under the description column.
  function formatItem(term: string, description?: string): string {
    if (description) {
      return helper.formatItem(term, termWidth, description, helper);
    }
    return ' '.repeat(itemIndentWidth) + term;
  }

  function formatList(textArray: string[]): string {
    // formatItem already prefixes each item with its 2-space indent, so just
    // join. Single-line items (no description) are indented above.
    return textArray.join('\n');
  }

  // Drop arguments flagged as hidden (deprecation / compat slots) from both
  // the Usage line and the Arguments section. Commander v12's Argument lacks
  // hideHelp(), so we read a custom `hidden` field that callers set directly.
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
  // commander always exposes -h/--help, so every command effectively has options.
  // Order matches commander's default: name [options] <args> [command].
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
    // Mirror commander's default subcommandTerm but drop the |alias suffix and
    // skip arguments marked as hidden (Argument#hideHelp()), so deprecation /
    // compatibility slots don't pollute the usage line.
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

/** Recursively apply help conventions (-h flag, no help subcommand, custom formatter). */
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

/** Apply standardized help formatting to the root command and all subcommands. */
export function applyGlobalHelpConventions(root: Command): void {
  applyHelpConventionsRecursive(root);
}
