import type { Command } from 'commander';

export const CANONICAL_ALIASES = {
  list: ['ls'],
  view: ['show'],
  add: [],
  remove: ['rm'],
  rename: ['mv'],
  edit: [],
} as const;

type CanonicalVerb = keyof typeof CANONICAL_ALIASES;

export function withAliases(cmd: Command, verb: CanonicalVerb): Command {
  const aliases = CANONICAL_ALIASES[verb];
  return aliases.length ? cmd.aliases([...aliases]) : cmd;
}
