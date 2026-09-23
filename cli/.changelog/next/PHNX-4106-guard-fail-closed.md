- **A PreToolUse hook whose script is missing now denies the tool call instead of allowing it (PHNX-4106).**
  Generated hook shims embed one source path inside a version home; when that file was gone (a
  pruned version, sync rewriting `hooks/`) the shim exited 127, which Claude Code, Codex and Droid
  read as "allow". On one laptop the primary-checkout guard was silently disabled for about 17
  hours this way. A `PreToolUse` shim now exits 2 with the repair named (`agents hooks sync`) and
  logs `cache: missing-source`, after the `matches:` gate and only for a PreToolUse firing; other
  events and skipped fires stay fail-open. `agents prune <harness>@<version>` also re-points the
  shims at the surviving home immediately instead of waiting for the daemon. Source:
  `cli/src/lib/hooks/cache.ts`, `cli/src/lib/installations/versions.ts`.

- **Claude no longer gets every plugin skill twice.** Sync flattened each plugin's `skills/` into
  the top-level `skills/` of every harness, but Claude Code already loads them from the plugin
  registration, namespaced (`/sessions:continue`), so the picker listed `/continue` and
  `/sessions:continue` side by side for 47 skills. Claude is flagged `nativePluginSkills`: sync
  stops flattening there, and the leftover copies are swept by the next full `agents sync claude`
  (or `agents prune cleanup skills`). Harnesses that only see plugin skills through the flat copy
  (Codex) are unchanged. Source: `cli/src/lib/staleness/writers/sources.ts`,
  `cli/src/lib/agent-spec/agents.ts`.
