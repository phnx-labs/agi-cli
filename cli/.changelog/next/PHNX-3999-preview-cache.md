- **`agents sessions preview <full-id> --device <owner> --json` gets a durable local
  cache and a bounded local fallback (PHNX-3999).** For an exact full session id
  (bare UUID, kimi/rush's `session_<uuid>`, or opencode's `ses_<ulid>`) with exactly
  one `--device`, the command now does ONE bounded SSH hop of the peer's own
  `sessions preview --local --json` instead of a metadata fan-out followed by a
  second render hop, and caches the result in a new `session_remote_preview_cache`
  table (45s fresh window, exponential negative backoff, size-bounded — per-row and
  total-byte caps alongside the existing row cap, atomic upsert+prune). Every peer
  response is schema/session-id/device validated before it is trusted or cached.
  The JSON envelope gains two additive fields: `cache`
  (`{source, fetchedAt, stale, state, device, reason}`) and `details`
  (`{request, timeline, files, messages, sourceRevision, partial, reason}` — reading
  the daemon-computed `session_timelines` projection when present, else an on-demand
  bounded fold over the same events already in hand). `active` is forced `null` on a
  cache hit rather than presenting a stale live snapshot as current. New `--refresh`
  forces one bounded bypass of the cache/backoff (concurrent refreshes coalesce onto
  one SSH attempt, including on failure); new `--revision <cursor>` is a
  caller-owned activity cursor — passing the same value as last time serves the
  cache with zero SSH indefinitely, a different value triggers one bounded refetch.
  Cross-process de-duplication uses a bespoke bounded lease (~11s total budget,
  lease-wait plus one SSH attempt together) rather than the daemon-oriented
  `refresh-coordinator.ts` lease, to fit an interactive latency budget. Separately, a
  LOCAL uncached preview over a new 4 MiB bounded-parse limit no longer runs an
  unbounded whole-file `parseSession` — it degrades to a `partial: true` digest built
  from `tail.ts`'s existing bounded 128 KiB tail reader (plus a new bounded 32 KiB
  head reader, `readSessionHead`, for recovering the session's real original request
  when it isn't already indexed), never a full parse and never misattributing a tail
  follow-up or the last USER turn as the original request/assistant's words. A
  metadata-only row with no transcript and no archived digest now returns an
  explicit `error` instead of a bare empty preview.
  Source: `cli/src/lib/session/remote-preview-cache.ts`,
  `cli/src/lib/session/db.ts`, `cli/src/lib/session/remote/remote-list.ts`,
  `cli/src/lib/session/tail.ts`, `cli/src/commands/sessions.ts`,
  `cli/src/commands/sessions-picker.ts`.
