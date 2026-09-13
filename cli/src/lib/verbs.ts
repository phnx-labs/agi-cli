import type { Command } from 'commander';

/**
 * The ONE place that defines the CLI's standard short-form verb aliases.
 *
 * These are the canonical short forms an agent or user reaches for on a
 * command group's CRUD verbs — `ls` for `list`, `rm` for `remove`, and so on.
 * They are NOT cross-verb synonyms (`info`/`install`/`create`); those are
 * per-command back-compat aliases owned by the individual commands.
 *
 * Apply them with {@link withAliases} so every group stays in lockstep instead
 * of each command hand-rolling its own `.alias('rm')`.
 */
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
