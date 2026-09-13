# @agents/session-tracker

Polyglot `SessionStart` hook + descendant-pid lookup. The **writer** side of
live-session tracking. See [README.md](README.md) for the full picture.

This file is a **map**. Read the code for current detail.

## The one thing to understand first

There are **two unrelated "session" surfaces** in this repo — do not conflate:

| | This package | `cli/src/lib/session/` |
|---|---|---|
| Role | **Writes** live-session state | **Reads** agent transcripts |
| Trigger | `SessionStart` hook (`hook.sh`) | `agents sessions` command |
| Data | `~/.agents/.cache/terminals/sessions/<pid>.json` | `~/.claude/projects/*.jsonl`, Codex rollouts, … |
| `SessionState` type | `{session_id, agent, cwd, pid, terminal_id, launch_id, ts, method}` | different type (`activity`, `pr`, `worktree`, `ticket`, …) |
| Consumer | VS Code ext (agi-ext `src/core/liveSession.ts`) | the CLI itself |

They share the word "session" and nothing else. The CLI does **not** import this
package.

## Layout

```
src/hook.sh          Polyglot SessionStart hook — parses each harness's payload, writes the state file
src/index.ts         Entry — re-exports all modules + trackSpawn() / getLiveSession()
src/types.ts         SessionState, AgentId, DetectionMethod, LookupInput
src/state-file.ts    STATE_DIR (canonical path), stateFilePath(), writeStateAtomic(), parseState()
src/writer.ts        recordSession() / clearSession()
src/reader.ts        descendantPids(), findStateByPid/InTree/ByTerminalId/ByLaunchId, pruneStaleSessionState()
src/install-hook.ts  installHookFor(agent) — declarative HOOK_SUPPORT table; writes the hook into per-agent native config (idempotent)
src/adapters/        Ground-truth test helpers (claude snapshot/await-new-session)
tests/scenarios/     cold-spawn (50×, ≥99%) + kill-restart (20×, stale-entry regression)
```

## Gotchas

- **`STATE_DIR` is declared in two places** that must agree: `src/state-file.ts`
  (`STATE_DIR`) and `src/hook.sh` (`STATE_DIR="$HOME/.agents/.cache/terminals/sessions"`).
  Change one → change both.
- **The CLI keeps its own sibling pid→id registry** at
  `~/.agents/.cache/terminals/by-pid/<pid>.json`
  (`cli/src/lib/session/pid-registry.ts`, `writePidSessionEntry`), written by
  `ag run` / the shim **at spawn**. It is the immediate, our-launches-only counterpart
  to this package's hook-written `sessions/<pid>.json` (delayed, any-launch,
  authoritative). Same pid→id data, two writers — the CLI reads `by-pid/`, the
  extension reads `sessions/`. The full picture is in
  [`cli/docs/architecture.md`](../../cli/docs/architecture.md).
- **Files are keyed by the agent PID** (`<pid>.json`). Lookups from a terminal walk
  the descendant-pid tree from the shell pid to find the agent pid.
- **Stale entries** — the spawn-time id goes stale after the user exits + reruns in
  the same terminal, or after `/clear`. `pruneStaleSessionState()` + the
  kill-restart test guard this; the live id from the hook is preferred over any
  cached spawn-time id.
- **`install-hook.ts` is idempotent** — it strips prior `session-tracker/src/hook.sh`
  registrations and the retired builtin `session-tracker.sh` before adding, so re-running never duplicates the sidecar writer. Codex registration trusts both the origin path and the relocated runtime home through the CLI hook bridge.
