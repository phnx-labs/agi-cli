/**
 * Custom help formatting for the CLI.
 *
 * Overrides commander's default help layout to show Commands before Options,
 * and applies consistent conventions (short -h flag, no implicit help subcommand).
 */
import type { Command, Help } from 'commander';

/** Description of a named command group rendered as its own section in help output. */
export interface CommandGroup {
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

/** Examples + Notes blocks attached to a command via setHelpSections. */
export interface HelpSections {
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
    if (remaining.length > 0) {
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

/**
 * Front-door tier for root `--help`. Derived from measured session reach
 * (PHNX-3320), not opinion: 1 = start here, 2 = every day. Groups without a
 * tier stay installed and are listed by `agents --help --all`.
 */
export type CommandTier = 1 | 2;

interface FrontDoorRow {
  name: string;
  tier: CommandTier;
  term: string;
  summary: string;
}

/** One row per group that root `--help` names, in display order. */
const FRONT_DOOR_ROWS: readonly FrontDoorRow[] = [
  { name: 'setup', tier: 1, term: 'setup', summary: 'Sign in, install an agent' },
  { name: 'run', tier: 1, term: 'run <agent> ["prompt"]', summary: 'Run an agent (no prompt = TUI)' },
  { name: 'sessions', tier: 1, term: 'sessions', summary: 'Every past run, resumable' },
  { name: 'view', tier: 1, term: 'view', summary: 'Installed, signed in, remaining quota' },
  { name: 'teams', tier: 2, term: 'teams', summary: 'N agents, one worktree each' },
  { name: 'browser', tier: 2, term: 'browser', summary: 'Drive a logged-in browser' },
  { name: 'secrets', tier: 2, term: 'secrets', summary: 'Keychain env bundles' },
  { name: 'devices', tier: 2, term: 'devices', summary: 'Your other machines (-D)' },
  { name: 'accounts', tier: 2, term: 'accounts', summary: 'Rotate logins past a usage limit' },
  { name: 'add', tier: 2, term: 'add <agent>[@version]', summary: 'Install an agent CLI' },
];

/** name → tier for every group the compact root help surfaces. */
export const FRONT_DOOR: Readonly<Record<string, CommandTier>> = Object.fromEntries(
  FRONT_DOOR_ROWS.map((row) => [row.name, row.tier]),
);

/** A visible top-level group as listed by `agents --help --all`. */
export interface RootHelpGroup {
  name: string;
  description: string;
}

function formatHelpRows(rows: ReadonlyArray<{ term: string; summary: string }>): string {
  const width = Math.max(12, ...rows.map((row) => row.term.length));
  return rows.map((row) => `  ${row.term.padEnd(width)}  ${row.summary}`).join('\n');
}

function firstSentence(description: string): string {
  const trimmed = description.replace(/\s+/g, ' ').trim();
  const match = trimmed.match(/^[^.]*\.?/);
  return (match ? match[0] : trimmed).trim();
}

/**
 * Static root help. Compact `--help` renders FRONT_DOOR only plus a pointer to
 * `--all`; pass `groups` (the real registered tree) to list every visible group.
 * Kept as a pure string so compact `--help` still loads zero command modules.
 */
export function renderRootHelp(opts: {
  cliName?: string;
  disabled?: ReadonlySet<string>;
  groups?: readonly RootHelpGroup[];
} = {}): string {
  const cli = opts.cliName ?? 'agents';
  const disabled = opts.disabled ?? new Set<string>();
  const intro = [
    `Usage: ${cli} [command] [options]`,
    '',
    'Install, configure, run, and dispatch AI coding agents from one place.',
    'Works with Claude, Codex, Antigravity, Cursor, OpenCode, OpenClaw, and Droid.',
    '',
  ];

  const body: string[] = [];
  if (opts.groups) {
    const groups = opts.groups.filter((group) => !disabled.has(group.name));
    if (groups.length === 0) {
      throw new Error('renderRootHelp({ groups }) received no visible groups');
    }
    const rows = groups.map((group) => ({
      term: group.name,
      summary: firstSentence(group.description) || group.name,
    }));
    body.push('All command groups:', formatHelpRows(rows), '');
    body.push(`See '${cli} <group> --help' for details. '${cli} --help' lists the start-here groups.`, '');
  } else {
    const visible = FRONT_DOOR_ROWS.filter((row) => !disabled.has(row.name));
    const startHere = visible.filter((row) => row.tier === 1);
    const everyDay = visible.filter((row) => row.tier === 2);
    if (startHere.length > 0) {
      body.push('Start here:', formatHelpRows(startHere), '');
    }
    if (everyDay.length > 0) {
      body.push('Every day:', formatHelpRows(everyDay), '');
    }
    body.push(
      'All groups:',
      formatHelpRows([
        { term: `${cli} --help --all`, summary: 'list every command group' },
        { term: `${cli} <group> --help`, summary: 'details for one group' },
      ]),
      '',
    );
  }

  const options = [
    'Options:',
    formatHelpRows([
      { term: '-V, --version', summary: 'Show version number' },
      { term: '-h, --help', summary: 'Show help' },
      { term: '--verbose', summary: 'Show startup self-heal details on stderr' },
    ]),
    '',
    `System config lives in ~/.agents/.system/. Run '${cli} <command> --help' for details.`,
    '',
  ];

  return [...intro, ...body, ...options].join('\n');
}
