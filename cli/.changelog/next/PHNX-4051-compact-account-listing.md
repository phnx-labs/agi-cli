- **`agents view` and `agents accounts list` read as name + usage (PHNX-4051).** The
  account table printed IDENTITY, STATE and WHERE on every row — an email, `UNVERIFIED`
  and `on 9 boxes` repeated down the whole list — which pushed the usage bars past the
  terminal width and wrapped every line. A row is now the account name and its usage
  bars, and nothing else when the account is healthy. Only a state worth acting on
  trails the row: `rate-limited` (yellow), `expired` / `revoked` / `missing` (red),
  partial fleet coverage (`usable on 3 of 5 boxes`), then the repair command. A
  blocking marker (`out of credits`) now renders after the bars instead of in front of
  them, so one throttled account no longer misaligns the table, and a stale window is
  `48%* (period ended 2h)` rather than `48% · stale (period ended 2h ago)`. The identity
  and per-device state the columns carried are still one command away —
  `agents accounts list --fleet`, `agents accounts view <name>`, `--json`. A discovered
  login nobody has named is listed by its identity (the email) rather than `unnamed`. Source:
  `cli/src/lib/account-catalog.ts`, `cli/src/lib/accounting/usage.ts`,
  `cli/src/commands/view.ts`, `cli/src/commands/accounts.ts`.
