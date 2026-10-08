# CleanShot recordings

`agents recordings` is an opt-in publisher for finished screen recordings. One
daemon service owns discovery and upload on a device; no editor, menu-bar app, or
second watcher polls the folder.

## Start and stop

```bash
agents recordings watch
agents recordings watch --dir ~/Movies/CleanShot
agents recordings list
agents recordings list --json
agents recordings unwatch
```

On macOS, `watch` reads `pl.maketheweb.cleanshotx exportPath` when `--dir` is not
given. The selected folder persists in `~/.agents/recordings/config.json`.
`watch` enables the otherwise-disabled `recordings` daemon service and signals a
running daemon to apply it live. Its persisted enable time is the discovery baseline:
files already in the folder are not bulk-published. `unwatch` disables only this service.

Use `agents recordings upload <file>` for one existing `.mp4` or `.mov`; it uses
the same checks, transcode, metadata, and ledger as automatic discovery.

## Data flow

```text
CleanShot folder
  → .mp4/.mov size unchanged for 10 seconds
  → organization identity check
  → temporary ffmpeg H.264/AAC copy (≤1080p, 30 fps, ~3 Mbps, fast-start)
  → artifacts share … --visibility org --expire never
  → ~/.agents/recordings/ledger.json
```

The source file is read-only. macOS uses `h264_videotoolbox`; other platforms use
`libx264`. Missing `ffmpeg` is an error with an installation hint. Temporary files
are removed after either success or failure.

The explicit artifacts metadata records `source=cleanshot`, the file birth time as
`recorded-at`, and the canonical CleanShot stem. Artifacts stamps the publishing
device from its own hostname. The publisher passes `AGENTS_SESSION_ID` only when
exactly one local agents session was active when the export was first observed and
that session had started by the file birth time; otherwise it clears inherited
session variables so artifacts does not attribute the recording to the daemon.

## Re-exports, retries, and access

CleanShot appends a number when it exports the same recording again. For example,
`CleanShot 2026-10-08 at 4.51.47 AM 3.mp4` has the canonical stem
`CleanShot 2026-10-08 at 4.51.47 AM`. Every version therefore publishes to the
same slug. Discovering a newer version cancels an older upload in flight before
the replacement is queued.

The ledger stores the source path, stem, slug, status, URL, and last error.
Successful source fingerprints are not uploaded again after a restart;
interrupted and failed rows retry.

Before every non-empty batch, the service runs `artifacts auth whoami`. A signed-out
or expired session leaves files queued. Public inbox domains such as Gmail, iCloud,
Outlook, and Yahoo are refused for organization recordings. Either condition raises
an `agents feed post --blocked` attention item instead of silently skipping files.
