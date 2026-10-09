- **Liveness checks no longer spawn one `ps` per session (PHNX-4225).** Every PID-reuse check
  ran a synchronous `ps -o lstart= -p <pid>` per live session, and several daemon services
  (session state, the feed's tool activity, the recordings settler) repeat that scan. On a busy
  laptop with ~100 live sessions those spawns blocked the event loop past the 5–10 s service
  deadlines, so the supervisor kept restarting the daemon. Start times now come from one
  `ps -A -o pid=,lstart=` per 30 s (35 ms for 2,050 processes on that laptop), with a single
  per-pid read only for a process that started after the snapshot.
  Source: `cli/src/lib/session/active.ts`.
