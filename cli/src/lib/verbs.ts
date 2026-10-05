import type { Command } from 'commander';

/** The one place defining the CLI's short-form CRUD verb aliases (`ls` for `list`, `rm` for
 * `remove`), applied via `withAliases`. Not cross-verb synonyms. */
export const CANONICAL_ALIASES = {
  list: ['ls'],
  view: ['show'],
  add: [],
  remove: ['rm'],
  rename: ['mv'],
  edit: [],
} as const;

type CanonicalVerb = keyof typeof CANONICAL_ALIASES;

/** Apply the standard aliases for `verb` to an already-created subcommand, returning it. */
export function withAliases(cmd: Command, verb: CanonicalVerb): Command {
  const aliases = CANONICAL_ALIASES[verb];
  return aliases.length ? cmd.aliases([...aliases]) : cmd;
}
