# Browser, computer, and terminal interfaces

These interfaces let agents act on real UI surfaces while keeping ownership in the CLI.

## Browser

The browser IPC service inside the shared `agents` daemon owns profiles, tasks, CDP connections, recordings, and cleanup. A task
binds later actions to one profile/device. Identity-bearing profile names route to their
declaring device; they never fall back to a local logged-out browser. Fleet-remote control
is off by default and enforced in the daemon for attach as well as launch.

The reaper closes only tabs owned by abandoned tasks. It never closes user-created tabs
or the shared browser window. Captures stay on disk; session linkage stores metadata.

`agents browser start --device <host>` resolves the browser binary and profile on the
TARGET, not the caller: a bare start forwards to the device rather than requiring a local
browser, so a browserless box no longer fails with `No supported browser found`. Client
readiness re-probes across an IPC-server restart (bounded, fail-loud) instead of throwing
on a fixed ceiling. `agents browser stop --service` disables only `browser-ipc`,
signals the daemon to reload, and clears a dead socket after the service releases
it; the shared daemon and its scheduler, secrets, usage, and session services keep
their PID. The next browser action that requires IPC re-enables the service in place. Client version
reconciliation likewise never owns shared-daemon stop/start; an explicit
`agents daemon restart` is an operator lifecycle action (PHNX-3605).

## Computer

A signed native helper does the driving and enforces platform permissions, an application
allowlist, and executable peer authentication. It is not an always-on broad desktop
daemon. Focus/frontmost checks are part of correctness, not a presentation detail.

The CLI does not talk to that helper directly. The helper, its transport, and the
autonomous loop belong to the standalone `computer` engine (PHNX-4075); agents-cli is a
consumer that supplies what only the fleet layer knows — the allowlist rendered from the
permissions resource layer, `--device` resolution and its tunnel, and the acting identity —
and records the actions the engine reports. The seam is documented in
[computer.md](computer.md).

## Terminal

Interactive backends are pure command builders over one transport and layout policy.
They open attended surfaces; autonomous/cloud execution belongs to the execution engine.
