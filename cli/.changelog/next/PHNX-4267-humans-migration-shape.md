- **The one-time `humans.yaml` upload now carries your channels and quiet hours (PHNX-4267).**
  1.22.123 read each channel's `transport` as the channel, but in a real `humans.yaml` that
  field names the delivery provider (`rush`, `openclaw-telegram`) and the `id` names the
  channel, so every channel was dropped: the iMessage handle and the per-severity routing
  never reached your account. It also read `quiet_hours` where the file says `quietHours`.
  The upload now maps channels by `id` and reads `quietHours`. If 1.22.123 already moved
  your file to trash with only the timezone uploaded, put it back at `~/.agents/humans.yaml`
  and the next run uploads the rest. Source: `cli/src/lib/installations/migrate.ts`.
