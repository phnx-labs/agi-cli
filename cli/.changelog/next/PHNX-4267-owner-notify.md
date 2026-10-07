- **Owner notifications go through your account (PHNX-4267).** `agents send --to owner`, an
  important or `--blocked` `feed post`, an urgent feed block and a failed routine now post one
  event to rush/api (`POST /me/notifications`), which applies your preferences, quiet hours and
  dedup and delivers by email, Slack DM or iMessage. Edit them in the console Settings page. A
  block is `needs_you` and bypasses quiet hours; a failed routine is `failed`; everything else is
  `message`. Reaching the owner now requires `agents auth login`: a box with no Phoenix session
  (and, on a worker, no device token) reports the send as failed, and `agents doctor` shows the
  critical `owner-not-signed-in` finding (it replaces `owner-sink-unreachable`). `--to owner`
  takes no `--channel`, `--thread` or `--attach`. Source: `cli/src/lib/owner-notify.ts`.
- **Workers get a scoped device token automatically (PHNX-4267).** The first signed-in personal or
  desktop box mints one `notify`-scoped Phoenix device token per `role=worker` device and pushes
  it into that worker's own `__notify-<worker>__` reserved store on the `auth-sync` tick. It is
  never pushed to a headed device. Source: `cli/src/lib/owner-notify-tokens.ts`.
- **A signed-in Mac sends the iMessages (PHNX-4267).** The new macOS-only `owner-device-delivery`
  daemon service claims queued iMessage deliveries every 15 seconds, sends them through Messages
  and reports each result. Source: `cli/src/lib/daemon/owner-device-delivery-service.ts`.
- **`humans.yaml` moves to your account, once (PHNX-4267).** On the first run with a Phoenix
  session, `~/.agents/humans.yaml` is uploaded to your notification preferences (channels, policy,
  quiet hours, timezone, iMessage handle), moved to trash, and its removal committed. Without a
  session the file stays and the upload retries. Transports with no account equivalent (Telegram,
  desktop) are reported and not migrated. `notify.owner` in `agents.yaml` is no longer read.
  Source: `cli/src/lib/installations/migrate.ts`.
- **`agents trash restore` and `agents trash empty` (PHNX-4267).** `agents restore` moves to
  `agents trash restore <agent>@<version>`. `agents trash empty [--older-than <duration>] [--yes]`
  permanently deletes trashed items, optionally only those trashed before the cutoff; it asks
  first in a terminal and refuses without `--yes` elsewhere. `agents prune cleanup trash`, which
  never deleted anything, is gone. Source: `cli/src/commands/trash.ts`, `cli/src/lib/trash.ts`.
- **Removed `agents humans`, `agents reminders`, `agents modes` and `agents feedback`
  (PHNX-4267).** The owner's settings live in the console. Reminders still show in the Claude
  statusline from `~/.agents/reminders/reminders.yaml`. The per-harness mode table now prints in
  `agents run --help`. Explicit `--channel` sends and feed `channel:` sinks no longer forward to a
  Mac peer over SSH when this box cannot deliver. Source: `cli/src/lib/startup/command-registry.ts`.
