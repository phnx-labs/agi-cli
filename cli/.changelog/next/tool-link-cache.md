- **The daemon stops crash-looping on tool-row linking (PHNX-4225).** Every feed
  reprojection linked each browser and computer row to its agent session with one
  synchronous lookup per row, and rebuilt the launch-id index from every activity log
  on the daemon's event loop. On a busy machine that held the loop for up to 21 s per
  pass, so attention-notify missed its 10 s deadline and the daemon restarted about
  every 20 s. Linking is now incremental and yields:
  - A found session is reused for 60 to 120 s, with staggered expiry.
  - A session-id miss is retried after 10 s.
  - The launch-id index is rebuilt at most once a minute by an async scan that only
    re-reads logs that changed, so a new launch id links within 60 s.

  Measured on the affected machine: the longest event-loop stall per pass dropped from
  587 ms to 62 ms cold and 1 ms warm, with identical links.
  Source: `cli/src/lib/feed/tool-activity.ts`.
