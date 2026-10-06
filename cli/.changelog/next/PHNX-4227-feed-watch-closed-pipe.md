- **`agents feed watch --json` exits cleanly when its reader goes away (PHNX-4227).**
  When the consumer closed the pipe (`| head -n1`, a client that stops reading),
  the Node CLI crashed with an unhandled `EPIPE` stack trace and exit 1, and under
  Bun it kept running and printed a stack trace on every heartbeat. It now ends
  the stream with exit 0 and nothing on stderr, matching `agents sessions watch
  --json`. Any other stdout write failure, such as `ENOSPC`, still exits 1, and a
  hub failure that reconnecting does not recover still fails.
  Source: `cli/src/commands/feed-watch.ts`.
