- **`--device` routing reads option values the way the command parses them (PHNX-4227).**
  A message such as `--text '--device=other'`, `--text -Dx` or `--text --host=other`
  is now delivered as the message instead of being taken as a routing flag, and
  everything after `--` stays positional. A selector placed before the command
  (`agents --device <peer> send …`, `agents -D<peer> send …`) now finds the command
  instead of failing with `unknown command '<peer>'`. Command discovery, the
  routing-selector read and the flag strip before the SSH hop share one scan
  driven by each command's registered Commander options. Repeated selectors keep
  the first value, as before. Source: `cli/src/lib/hosts/routing-flag.ts`,
  `cli/src/lib/hosts/remote-cmd.ts`, `cli/src/bootstrap.ts`.
