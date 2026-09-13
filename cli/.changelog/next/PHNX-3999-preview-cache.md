- **Session previews retain details across devices (PHNX-3999).** An exact session
  ID and owning device use one bounded request, with a durable local copy for
  offline reading. Reopening unchanged sessions avoids network requests; activity
  changes invalidate the copy, and failed requests back off without hiding prior
  content. Concurrent requests coalesce, including failed manual refreshes.
  SQLite contention, lock waiting, and transport share a 10-second budget.
- **Large local transcripts show bounded recent details.** Previews reuse the
  canonical transcript parsers and timeline projection, mark partial history,
  and report missing transcripts explicitly. Cached timeline data is accepted
  only for the exact file modification time and size that produced it.
