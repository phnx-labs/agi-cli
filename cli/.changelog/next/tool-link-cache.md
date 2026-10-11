- **The daemon stops crash-looping on tool-row linking (PHNX-4225).** Every feed
  reprojection linked each browser and computer row to its agent session with one
  synchronous lookup per row and rebuilt the launch-id index from every activity log.
  On a busy machine that held the daemon's event loop for up to 21 s per pass, so
  attention-notify missed its 10 s deadline and the daemon restarted about every
  20 s. A found session is now reused for 60 s, and the index is rebuilt at most once
  a minute. A session indexed later still links on the next pass.
  Source: `cli/src/lib/feed/tool-activity.ts`.
