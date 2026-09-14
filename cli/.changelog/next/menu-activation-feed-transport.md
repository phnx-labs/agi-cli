- **A feed snapshot larger than the reader budget now reaches the reader whole (PHNX-3999).**
  The daemon's shared feed socket wrote each envelope in one `socket.write` and dropped the
  reader the moment its unflushed bytes passed 4 MiB — so a healthy Menu or `agents feed
  watch --json` client attaching to a fleet whose reset exceeded that got 8 KiB of it, no
  newline, then EOF, and the CLI exited 0 as if the fleet were empty. Each connection now has
  one ordered writer that streams the snapshot before any live event in 64 KiB chunks paced
  by the socket's own `'drain'`. A reader is dropped only when it stays more than 4 MiB of
  live events behind for 2 s, or leaves a chunk unaccepted for 30 s — a burst of peer resets
  to a healthy reader is never a drop. The client rejects any close it did not ask for,
  naming a mid-frame truncation, and a throwing consumer fails that same promise instead of
  escaping as an uncaught exception. Source: `cli/src/lib/feed/hub-server.ts`.
