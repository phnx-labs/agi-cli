- **`agents accounts usage [harness]` shows how many subscription accounts you actually need.**
  It prints each named account's highest weekly-limit percent per calendar week (last 4 weeks
  by default, `--weeks`), this week's reading projected to the full week, and the summed
  demand in account-weeks, then recommends a count: keep `ceil(peak demand ÷ 0.8)` accounts
  (`--target`), plus one if any account hit its weekly limit. With readings for every active
  account in 3 of the last 4 weeks it names the least-used accounts to pause (never the default
  account), or paused accounts to resume; on thinner history it gives the count only. `--json`
  carries the same table and advice for the menu bar. The history comes from a new weekly-peak
  ledger (`usage-history.json`) fed by every usage cache writer (headed poll, status line, peer
  sync), and every box, worker included, now publishes its ledger on the 15-minute usage-sync
  exchange, so the status-line readings from sessions on workers reach the headed box for the
  first time. Source: `cli/src/lib/accounting/usage-history.ts`, `cli/src/lib/accounting/advise.ts`,
  `cli/src/lib/accounting/usage-sync.ts`, `cli/src/commands/accounts.ts`.
- **`agents accounts pause <harness>#<name>` / `resume`.** A paused account stays registered with
  its credentials but balanced and available rotation never pick it; `agents run <harness>#<name>`
  and resuming its sessions still work. `accounts list` marks it `paused` and stops suggesting a
  repair for it. The flag lives on the fleet-wide account row in `agents.yaml`.
- **The headed daemon tells you when the advice changes.** On the usage-sync tick it sends one owner
  notification per harness when a high-confidence recommendation to pause, resume or add accounts
  changes, deduplicated per week so two headed boxes never both send it. Source:
  `cli/src/lib/accounting/advise-notify.ts`, `cli/src/lib/daemon/usage-sync-service.ts`.
