- **Agent asks carry an urgency.** `agents feed watch --json` attention rows carry `urgency`
  (`urgent`, `high`, `normal`, `low`) and, when there is one, `urgencyReason`
  ("Blocks a release (npm publish)", "High ticket PHNX-3890"). An ask that holds up a release,
  deploy or merge is urgent; otherwise the linked ticket's Linear priority decides; otherwise
  normal. A ticket's priority is read at most once per 30 minutes.
  Source: `cli/src/lib/feed/attention.ts`, `cli/src/lib/feed/ticket-priority.ts`.
- **Banner schedules per urgency, with reminders.** New user-scope keys
  `menubar.menu.notifyUrgent`, `notifyHigh`, `notifyNormal` and `notifyLow` set when an ask's
  Mac banner posts: times such as `0m`, `15m`, `1h` measured from when the ask opened (the
  first posts the banner, later ones remind), plus `stay` and `sound`, or just `sidebar` for no
  banner. Defaults: urgent `["0m","15m","30m","stay","sound"]`, high `["0m","30m","stay"]`,
  normal `["5m","1h"]`, low `["sidebar"]`. `agents config set` rejects anything else. The daemon
  withdraws a banner when its ask resolves, and about 10 seconds after posting for a level
  without `stay`. A reminder replaces the earlier banner and says "Still waiting · 15 min".
  Source: `cli/src/lib/daemon/attention-notify-service.ts`, `cli/src/lib/feed/notify-schedule.ts`.
- **Fleet asks reach the machine you sit at.** With `interactive.host` set to this machine,
  this machine posts banners for every device's asks, read from the daemon's shared fleet
  stream; any other machine then posts none. Unset keeps each machine posting its own.
- **AGI Menu argv.** Banners now pass `--level`, `--sound` and `--reminder <n>`, and a resolved
  ask is withdrawn with `"AGI Menu" --notify --withdraw <key>`. Needs AGI Menu
  1.19.0, which this release installs (the `menubar` floor moves to 1.19.0). Source: `cli/src/lib/menubar/notify-desktop.ts`, `cli/docs/menubar.md`.
- **Claude permission asks name their command.** A Claude permission ask reads "Claude needs
  approval to run Bash: <command>" instead of "Claude needs your permission".
  Source: `cli/src/lib/feed/feed.ts` (the next `agents feed` run rewrites the installed hook).
- **Stale asks leave.** The daemon runs the mailbox gc hourly, so an open ask whose session is
  gone is removed a day later without `agents feed --dispatch`, and `agents feed` ranking caps an
  ask's idle time at 24 hours so a weeks-old ask no longer tops the list.
  Source: `cli/src/lib/daemon/attention-notify-service.ts`, `cli/src/lib/feed-ranking.ts`.
