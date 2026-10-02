- **The transcript reader is imported from `@phnx-labs/sessions-cli/reader`, not kept
  in-repo (PHNX-4118).** The pure parse→render→analyze pipeline (parse, render, state,
  tool-calls, timeline, prompt, insights, bash-command, trajectory + text/html/lineage/
  compare, digest, tail, highlights, shell-programs, team-filter, linear, artifacts,
  stream-render, share-html, and the `SessionEvent`/`SessionMeta`/`SessionStep` types)
  now comes from the published `@phnx-labs/sessions-cli@0.3.0` package's `/reader`
  subpath — the same code the standalone `sessions` bin runs — deleting ~13k LOC of a
  byte-for-byte in-repo copy. The reader is imported **in-process** (a normal
  node_modules import, never a subprocess), so the indexer warm-tick (`db.ts`), the eval
  loop (`lib/traces/sync.ts`), and live-state (`active.ts`) still parse without shelling
  out. No user-visible behavior change: `sessions <id> --json`/`--markdown`, `trace`,
  `timeline`, and `insights` render exactly as before. The CLI-owned half — the
  writer/indexer, lifecycle, live-identity, and remote/sync code — stays in
  `cli/src/lib/session/`. Source: `cli/package.json`, `cli/src/lib/session/`,
  `cli/src/lib/traces/sync.ts`.
