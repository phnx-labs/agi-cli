- **The daemon no longer crash-loops on self-heal.** The self-heal pass compared every
  synced skill and plugin file in every version home synchronously on the daemon's only
  thread. On a box with many version homes that took over a minute, other services missed
  their deadlines, the daemon exited for a restart, and the restart ran self-heal again
  30 seconds later, pinning a CPU core and dropping the feed stream every ~77 seconds.
  Self-heal now runs in its own child process (`agents __self-heal-run`), a restart no
  longer re-runs it inside its 6-hour interval, and identical files are compared as raw
  bytes instead of being decoded as text. Because a restart no longer triggers a pass, a
  daemon restart (including after `agents upgrade`) no longer heals 30 seconds after boot; the
  pass runs once 6 hours have passed since the previous one. Run `agents sync` to heal immediately. If you disabled self-heal as
  a stopgap, turn it back on with `agents daemon services enable self-heal`.
