- **Owner notifications no longer have quiet hours.** rush/api dropped quiet hours
  and the notification timezone, so the CLI no longer sends a `settings` object to
  `PUT /me/preferences` and no longer reports a `quiet_hours` suppression. The
  one-time `humans.yaml` upload lists `quietHours`, `quiet_hours` and `timezone`
  under "not migrated" instead of uploading them. Source:
  `cli/src/lib/owner-notify.ts`, `cli/src/lib/installations/migrate.ts`.
