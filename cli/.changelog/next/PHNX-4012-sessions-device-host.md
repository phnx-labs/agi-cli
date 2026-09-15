- **`agents sessions <read> --device <name>` routes a SINGLE-device READ through the standalone `sessions --host` when both sides support it (PHNX-4012).**
  A read `--device` query (search / list / id lookup, and no explicit `--host`) that names exactly one
  device now resolves it to its SSH target and forwards `sessions <read args> --host ssh://<target>` to
  the local standalone — the local-orchestration collapse where `sessions` owns the remote hop, instead
  of the in-repo peer fan-out. `--host` is point-to-one, so a **multi-device** read (`--device box
  mac-mini`, a repeated `--device`, or a `--device all`/`fleet` sentinel) stays on the in-repo `--device`
  fan-out, which merges the peers. It takes the standalone path only when THIS box's `sessions` is ≥ 0.2.1. If the PEER
  lacks the standalone the remote `bash -lc` command-not-found surfaces as exit 127, on which the read
  falls through to the existing in-repo `--device` fan-out so it still succeeds — a capability gate
  keyed on that specific signal (same spirit as the 0.2.1 `--host` version gate), a migration bridge
  until the fleet is uniformly on 0.2.1. Below the host floor, or with no standalone installed, a
  `--device` read stays on the in-repo engine exactly as before. Lifecycle `--device` (resume / watch /
  inject / focus / …) is untouched, and an explicit `--host` still wins. Internal routing change with no
  user-visible behavior change on a healthy fleet. Source: `cli/src/lib/sessions-client.ts`,
  `cli/src/index.ts`.
