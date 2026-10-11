- **Removed dead and duplicate commands (PHNX-4227, owner decision 2026-10-11).**
  The command index drops from 486 to 425 entries. Removed outright, with no
  aliases: `agents route`/`routes` (and the `routers` resource kind), `registry`,
  `packages` (incl. `packages materialize`), `search`, `install`, `tmux`,
  `message`, `mailboxes`/`mailbox`, `traces` (and the trace auto-sync after runs,
  important feed posts and owner sends, with `--no-trace-sync` and
  `AGENTS_NO_TRACE_SYNC`), `webhooks serve`, `daemon webhooks`, and
  `daemon funnel` (with the `webhook-receiver` daemon service and
  `~/.agents/webhooks/*.yml` handlers). Replacements: `plugins add`, `skills add`
  and `mcp add` install resources; `send --channel mailbox|session` reaches a
  running agent and `cloud message` a cloud task; `routines webhook` fires
  trigger routines from a payload.
- **`agents logs` is now `agents events logs`, and `agents trash` is now
  `agents prune trash list|restore|empty`.** The audit, stats and rotate verbs
  were already under `events`.
- **AGI Menu has no setup commands any more.** `agents menubar` is hidden and
  keeps only the `snapshot`, `update`, `restart` and `disable` verbs AGI Menu
  calls; `setup`, `enable`, `status` and `doctor` are gone. Any `agents` command
  on a Mac installs or heals the login item, `agents doctor` reports duplicate,
  stale, replaced or ad-hoc-signed helpers as `menubar` warnings with the fix,
  and the new device-scoped `menubar.enabled` key (default true) replaces the
  `menubar.disabled` sentinel. An existing sentinel migrates to
  `menubar.enabled=false` on upgrade. Source: `cli/src/commands/menubar.ts`,
  `cli/src/lib/menubar/install-menubar.ts`.
