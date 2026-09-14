- **`browser status` no longer goes blank when one Arc task is stale (PHNX-3999).** A
  single Arc tab that had been moved to another window or Space — or closed — made
  `agents browser status` throw, and **every** profile vanished from the listing,
  including healthy ones with nothing to do with Arc. The refusal to adopt a moved
  tab is correct and is unchanged: an action still will not drive a tab its task no
  longer owns. What changed is that read-only `status` no longer inherits the blast
  radius. An unreadable task is reported with the tab count it owns on disk plus the
  reason its live tabs could not be read, an unreadable profile is listed with an
  `unavailable` reason instead of disappearing, and the other profiles are reported
  normally. `tabs` is absent rather than empty for such a task, so nothing claims a
  stale tab is live. Source: `cli/src/lib/browser/service.ts`.
- **`browser status` reads Arc once per pass instead of once per tab (PHNX-3999).** A
  profile with 28 tasks paid one AppleScript round trip per owned tab, plus one
  liveness probe per saved Arc runtime while reconnecting, so a cold `status` spent
  dozens of serialized round trips before printing anything. It now takes a single
  snapshot and a single liveness probe for the entire pass, shared across every Arc
  profile, and never contacts Arc at all when no Arc profile is present. Actions are
  unchanged and still read Arc live per tab. Source: `cli/src/lib/browser/service.ts`.
