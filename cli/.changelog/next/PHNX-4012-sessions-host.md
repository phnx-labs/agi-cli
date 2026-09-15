- **`agents sessions … --host <target>` forwards to the standalone `sessions` CLI (PHNX-4012).**
  A point-to-one remote read (`agents sessions <query> --host box` — SSH to ONE box, run
  `sessions … --local`, stream JSON back) now takes the standalone fast path when the installed
  `sessions` is ≥ 0.2.1, mirroring how the 0.2.0 filter/sort flags are version-gated. A box with
  `sessions` below the 0.2.1 host floor — or none installed — keeps the query on the in-repo engine
  exactly as before (which resolves `--device` against the fleet), so nothing mis-routes or crashes.
  This is an internal routing change: `--host` behaves the same for callers, only the engine that
  answers it changes. Source: `cli/src/lib/sessions-client.ts`, `cli/src/index.ts`.
