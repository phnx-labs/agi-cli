### Removed

- `agents sessions tail` is gone; use `sessions tail <id>` from the standalone
  sessions CLI. `agents logs -f <id>` runs it for a session.
- Tool-call search moved to the standalone CLI: `sessions --include tools
  --query <clause> [--count] [--host <target>] --json`. It reads the same index
  agents writes (`agents sessions backfill tools` still fills it).
  A tool search through `agents sessions --include tools` (no session id, or a
  `--query` clause) now exits 2 and names that command; reading one session's
  tool calls, `agents sessions <id> --include tools [--json|--markdown]`, is
  unchanged. `--fleet` / `--count` are no longer `agents sessions` flags. `--query` is a
  single search-text flag.

### Changed

- A read query (`agents sessions <query> [--json]`) no longer falls back to an
  in-process read when the `sessions` bin cannot be resolved. It exits 1 with an
  error naming the install.
