---
name: devices
description: "Register and connect to your machines over Tailscale SSH with agents-cli. Use this skill to sync devices from the tailnet, list them, open a shell on another machine, or see agent sessions running across your whole fleet."
argument-hint: "[sync|list|show|add|set|ssh|update|run|fleet]"
allowed-tools: Bash(agents devices*), Bash(agents fleet*), Bash(agents ssh*), Bash(agents ps*), Bash(agents run*), Bash(agents hosts*), Bash(agents events*)
user-invocable: true
---

# Devices Skill

Manage a registry of SSH device profiles and reach your other machines. The
registry self-populates from `tailscale status --json`, so on a tailnet you
rarely hand-enter a host. This skill teaches the `agents devices` /
`agents fleet` (alias) and `agents ssh` CLIs, plus the fleet-wide
`agents ps` view.

`agents fleet` is a synonym for `agents devices` — every subcommand works under
either name (`agents fleet list` == `agents devices list`).

## Register devices

```bash
# Ingest the tailnet into device profiles. In a terminal this opens a
# checkbox to register/unregister nodes; --yes registers every non-ignored one.
agents devices sync
agents devices sync --yes

# Register or dismiss a single discovered node.
agents devices register <name>
agents devices ignore <name>      # never suggest it again
agents devices unignore <name>    # undo an ignore
```

## Inspect

```bash
agents devices list               # platform, address, reachability (alias: ls)
agents devices list --json        # registry as a JSON array (for scripts/hooks)
agents devices show <name>        # full profile for one device
```

`list` marks the machine you are on with `▸ <name>  ← this machine`.

## Add / edit manually

```bash
# target is user@host or host; platform is windows | linux | macos
agents devices add <name> <target> --platform linux

# Update fields on an existing device.
agents devices set <name> --user muqsit --platform macos
agents devices set <name> --auth password --bundle <secrets-bundle>

agents devices rm <name>          # remove from the registry (alias: remove)
```

Auth is either `key` (system ssh agent / on-disk keys) or `password` (pulled
from a Keychain-backed secrets bundle — never stored on disk).

## Connect

```bash
# Open a shell (preflights reachability, picks the shell, authenticates).
agents ssh <name>

# Run a one-off command and return.
agents ssh <name> uname -a
```

## Fleet-wide rollout

```bash
# Roll out the latest agents-cli to every online registered device.
agents fleet update
agents fleet update 1.20.62     # pin a version / dist-tag

# Run an arbitrary command on every online device; offline ones are skipped.
agents fleet run uname -a
agents fleet run 'agents --version'
```

Both print a per-device result table (`ok` / `failed` / `skipped`).

To use plain `ssh <name>`, render the registry into your ssh config:

```bash
agents devices render            # print the Host stanzas to stdout
agents devices render --write    # write ~/.ssh/config.d/agents
```

## Fleet-wide active sessions

`agents ps` groups running agent sessions by machine, pins the
local box first (`▸ <name> ← this machine`), and folds in sessions from your
registered, online devices over SSH:

```bash
agents ps           # this machine + every online device
agents ps --local   # this machine only (no SSH fan-out)
agents ps --device zion --device mac-mini   # specific machines
agents ps --json    # merged, machine-tagged, for scripts
```

Unreachable or CLI-less hosts are skipped with a note, never fatal. If no
devices are registered, it prints a tip pointing you at `agents devices sync`.

## Dispatch a run to a machine

Offload `agents run` itself to a registered host over SSH — it follows live by
default; `--no-follow` detaches and returns immediately.

```bash
agents run claude "profile this build" --device gpu-box   # run there, follow live
agents run claude "..." --device gpu-box --no-follow        # detach

agents devices ps              # list dispatched runs and their status
agents devices stop <id>       # terminate a hung/detached run (alias: kill)
agents events logs --device gpu-box   # pick a run on that host
agents events logs <id> -f        # follow a host-task log
```

`agents events logs <id>` shows a dispatched run's output or a local session by id,
filters with `--device`/`--agent`/`--version`, and `-f` follows a live one;
`agents events` is the timeline.
`agents devices stop <id>` SIGTERMs the remote process group from this machine and
keeps the log for later inspection.

Registered devices are part of the host pool automatically: they appear in
`agents hosts list` (SOURCE `devices`), resolve as `--device` targets by name,
and join capability routing once tagged (`agents hosts add <device> --cap gpu`
enrolls straight from the device profile — no target needed). Password-auth
devices are listed but can't carry a dispatch (BatchMode ssh); switch them with
`agents devices set <name> --auth key`. Devices also work as cloud task targets
(`agents cloud run "…" --device <device>`) and routines placement
(`agents routines add … --run-on <device>`).

## Tips

- Reachability in `list` is a snapshot from the last `sync`; rerun `sync` to
  refresh it.
- iOS/tablet nodes can't run the CLI and are skipped by the `--active` fan-out.
- A device with password auth needs a bundle: `agents devices set <name>
  --auth password --bundle <name>`.
