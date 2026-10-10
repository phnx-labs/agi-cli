# Browser, computer, and terminal interfaces

These interfaces let agents act on real UI surfaces while keeping ownership in the CLI.

## Browser

The standalone `browser` engine (`@phnx-labs/browser-cli`, PHNX-4101) owns profiles, tasks,
CDP connections, recordings, cleanup, and its own IPC service; the shared `agents` daemon
hosts none of it. A task binds later actions to one profile/device at `browser start`.
Fleet-remote control is off by default (`browser remote-control on` opts a machine in) and
the engine enforces it.

The reaper (`browser prune`, also run by the engine every 5 minutes) closes only tabs owned
by abandoned tasks. It never closes user-created tabs or the shared browser window.
Captures stay on disk; session linkage stores metadata.

agents-cli is a consumer: `agents browser` forwards every verb to the engine and supplies
`--device` fleet resolution, remote-control consent, and the acting identity on fd 3. The
seam is documented in [browser.md](browser.md).

## Computer

A signed native helper does the driving and enforces platform permissions, an application
allowlist, and executable peer authentication. It is not an always-on broad desktop
daemon. Focus/frontmost checks are part of correctness, not a presentation detail.

The CLI does not talk to that helper directly. The helper, its transport, and the
autonomous loop belong to the standalone `computer` engine (PHNX-4075); agents-cli is a
consumer that supplies what only the fleet layer knows — the allowlist rendered from the
permissions resource layer, `--device` resolution (the engine opens the tunnel), and the acting identity —
and records the actions the engine reports. The seam is documented in
[computer.md](computer.md).

## Terminal

Interactive backends are pure command builders over one transport and layout policy.
They open attended surfaces; autonomous/cloud execution belongs to the execution engine.
