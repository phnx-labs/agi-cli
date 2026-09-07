- **`agents secrets` no longer recurses into the legacy `secrets` shim after an
  in-place upgrade (PHNX-3989).** Boxes that ran agents-cli before the standalone
  `secrets` engine still carry `~/.agents/.cache/shims/secrets`, a command shim that
  `exec`s `agents secrets`. It sits first on PATH and survives an upgrade because its
  baked entrypoint still exists, and 1.22.85 resolved the standalone with a plain
  `which secrets` — so on every such box `agents secrets …` (and the daemon's
  reserved-store sync, which uses the same resolver) re-entered itself through the
  shim without bound. The resolver now skips agents-cli's own shims dir when looking
  for the standalone (`SECRETS_BIN` still wins; a miss still fails loud with the
  install command), and the self-heal shim pass removes that legacy `secrets` shim
  even though its target install is alive, since it can only recurse. Install the
  standalone with `npm i -g @phnx-labs/secrets-cli` if `agents secrets` reports it
  missing.
