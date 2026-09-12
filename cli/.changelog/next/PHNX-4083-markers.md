- **Run pickers move to `#` (account) and `@` (device), `#@` asks both
  (PHNX-4083).** `agents run claude#` now opens the account picker (the old
  `claude@` menu, same rows and code path); `agents run claude@` opens the new
  fleet device picker — this machine first, offline rows disabled, cached-state
  age in the prompt — and `claude#@` asks the account first, then the device,
  dispatching with the picked account label. A picker combined with an explicit
  pin of the same thing (`claude@2.1.218#`, `claude#work#`, `claude@@`) or a
  conflicting flag (`--account`, `--device`/`--on`/`--computer`/`--host`) fails
  loud; a cancelled menu launches nothing. Source: `src/commands/exec.ts`,
  `src/lib/hosts/dispatch.ts`.
