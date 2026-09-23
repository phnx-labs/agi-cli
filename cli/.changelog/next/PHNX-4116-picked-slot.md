- **A balanced pick or the account picker now launches the account it chose (PHNX-4116).**
  Since accounts became registered slots (PHNX-3940), a `balanced` pick and the "no fresh usage"
  picker only set the executable version, so the run started in that version's home with whatever
  login it held. On yosemite-m0 the picker chose `trp` and Claude Code opened as another account,
  in its first-run wizard. Both paths now resolve the picked candidate through the same local
  launch resolver an explicit `--account` uses, so the spawn gets the slot's home and durable
  credential env. Source: `cli/src/commands/exec.ts`.
