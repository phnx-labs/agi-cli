- **The daemon no longer crash-loops on a busy machine with many live sessions (PHNX-4225).**
  Every liveness check spawned a synchronous `ps` per session PID to guard against PID reuse, and
  several services (session state, the feed's tool activity, the recordings settler) repeat that
  scan. On a laptop with ~100 live sessions under load, those spawns blocked the event loop past the
  5–10 s service deadlines, so the supervisor restarted the daemon every 1–2 minutes and the 15-minute
  services (usage-sync, auth-sync) never ran. A PID's start time is now cached for 30 s.
  Source: `cli/src/lib/session/active.ts`.
