- **`agents sessions preview <full-id> --device <owner> --json` gets a durable local
  cache and a bounded local fallback (PHNX-3999).** For an exact full session id
  (bare UUID, kimi/rush's `session_<uuid>`, or opencode's `ses_<ulid>`) with exactly
  one `--device`, the command now does ONE bounded SSH hop of the peer's own
  `sessions preview --local --json` instead of a metadata fan-out followed by a
  second render hop, and caches the result in a new `session_remote_preview_cache`
  table (45s fresh window, exponential negative backoff, size-bounded — per-row and
  total-byte caps alongside the existing row cap). The JSON envelope gains two
  additive fields: `cache` (`{source, fetchedAt, stale, state, device, reason}`) and
  `details` (`{request, timeline, files, messages, sourceRevision, partial, reason}`,
  reading the existing daemon-computed `session_timelines` projection rather than
  reparsing). New `--refresh` forces one bounded bypass of the cache/backoff; new
  `--revision <cursor>` lets a caller that already knows nothing changed skip the
  freshness window with zero SSH, or force a refetch when it knows something did.
  Cross-process request de-duplication reuses the existing `withRefreshLease`
  primitive (`refresh-coordinator.ts`). Separately, a LOCAL uncached preview over a
  new 16 MiB bounded-parse limit no longer runs an unbounded whole-file
  `parseSession` — it degrades to a `partial: true` digest built from `tail.ts`'s
  existing bounded 128 KiB tail reader plus the already-indexed
  `SessionMeta.firstUserMessage`, never a full parse and never misattributing the
  last USER turn as the assistant's. A metadata-only row with no transcript and no
  archived digest now returns an explicit `error` instead of a bare empty preview.
  Source: `cli/src/lib/session/remote-preview-cache.ts`,
  `cli/src/lib/session/db.ts`, `cli/src/lib/session/remote/remote-list.ts`,
  `cli/src/commands/sessions.ts`, `cli/src/commands/sessions-picker.ts`.
