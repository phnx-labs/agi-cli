- **AGI Menu: synchronized Headless-runs defaults, Home and device preferences.**
  Five new `agents config` keys, validated at write time and synced fleet-wide like
  the existing `menubar.menu.*` set: `menubar.menu.headlessAgent` and
  `menubar.menu.headlessFallbackAgent` (each a registered agent id — a typo is
  refused, not stored), `menubar.menu.headlessPlacement`
  (`auto` | `local` | `interactive` | a device name),
  `menubar.menu.sessionUpdates`, and `menubar.menu.deviceSort`
  (`name` | `role` | `load` | `memory` | `disk`).
- **`agents run --fallback <agent>` now reaches the alternate harness when the
  primary's accounts are exhausted before the run starts.** Previously that case
  printed "no healthy account" and exited 1, so a configured alternate never fired
  for the one situation it exists for; the mid-run handoff also no longer stops at
  three accounts when an explicit alternate is configured, so every healthy account
  of the primary is tried before another harness. A signed-out primary still fails
  loud with the login hint — logging in is the fix there, not a different harness.
- **`agents menubar snapshot --json` reports each device's role and specs.** Every
  `devices[]` row gains `role`, `autoEligible` (whether `--device auto` may pick it)
  and `stats` — cores, total/free memory and disk, load, reachability, and when each
  was observed. Read from the existing fleet-stats cache, so no fleet probe; `null`
  for a device never measured, and every unobserved number is `null` rather than `0`.
- **Session rows carry `confirmedProject`.** The registered project whose root
  contains the session's working directory, or `null` when the association is not
  confirmed, on `agents feed watch --json`, `agents sessions watch --json`, and
  `agents sessions --active --json`. A directory no project definition names — even
  one that happens to be a git repository — is no longer filed under a project
  invented from its folder name. The existing `project` field is unchanged.
- **Session titles exclude shell and control scaffolding.** A harness-generated
  title that is a `<bash-input>`/`<command-name>`/`<system-reminder>` wrapper, or a
  bare control command such as `/clear` or `/compact`, is rejected so the row shows
  the generated title or the user's own first prompt instead. A `/rename` title is
  still kept verbatim, and the original prompt stays on the row. Existing indexed
  sessions are re-derived on their next scan.
