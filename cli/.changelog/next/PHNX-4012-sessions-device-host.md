- **`agents sessions <read> --device <name>` routes the READ through the standalone `sessions --host` when both sides support it (PHNX-4012).**
  A read `--device` query (search / list / id lookup, and no explicit `--host`) now resolves the
  device to its SSH target and forwards `sessions <read args> --host ssh://<target>` to the local
  standalone — the local-orchestration collapse where `sessions` owns the remote hop, instead of the
  in-repo peer fan-out. It takes this path only when THIS box's `sessions` is ≥ 0.3.0. If the PEER
  lacks the standalone the remote `bash -lc` command-not-found surfaces as exit 127, on which the read
  falls through to the existing in-repo `--device` fan-out so it still succeeds — a capability gate
  keyed on that specific signal (same spirit as the 0.3.0 `--host` version gate), a migration bridge
  until the fleet is uniformly on 0.3.0. Below the host floor, or with no standalone installed, a
  `--device` read stays on the in-repo engine exactly as before. Lifecycle `--device` (resume / watch /
  inject / focus / …) is untouched, and an explicit `--host` still wins. Internal routing change with no
  user-visible behavior change on a healthy fleet. Source: `cli/src/lib/sessions-client.ts`,
  `cli/src/index.ts`.
