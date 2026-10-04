- **`agents sessions` reads use the `sessions` binary this CLI already depends on.**
  With `$SESSIONS_BIN` unset, a read runs the `@phnx-labs/sessions-cli` dependency
  instead of requiring a second global `sessions` install. The package `exports`
  map publishes only `./reader`, so the lookup walks Node's module paths and reads
  the `bin` field. A non-empty `$SESSIONS_BIN` still pins the binary. An empty
  `$SESSIONS_BIN` keeps the PATH lookup. No standalone at all, an older binary,
  and a peer exit 127 still stay on the in-repo engine.
  Source: `cli/src/lib/sessions-client.ts`.
