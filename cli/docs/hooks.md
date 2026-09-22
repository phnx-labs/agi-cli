<!-- guide -->
# Hooks

Shell scripts that run automatically in response to agent lifecycle events — session start, tool calls, task completion, and more.

## Overview

Hooks are shell scripts in `~/.agents/hooks/` that fire when an agent crosses a lifecycle event boundary. Each hook is declared in a manifest (the `hooks:` section of `agents.yaml`) that binds it to one or more events, specifies an optional timeout, and optionally declares predicate matchers that gate execution. At agent launch, agents-cli reads the merged system + user manifest and writes the resolved script paths into the agent's native settings file — `settings.json` for Claude, `hooks.json` for Codex, and so on.

All declared predicates AND together at fire time: every predicate in the `matches:` block must pass, or the script is skipped. An empty `matches:` block always passes.

Hooks are separate from plugin-bundled hooks (which use a `hooks/hooks.json` inside the plugin directory). Central hooks in `~/.agents/hooks/` follow the same layered resolution as every other resource: project overrides user overrides system. See [resource-sync.md](resource-sync.md) for the full resolution model.

## Architecture

```
Central storage (user > system):
  ~/.agents/hooks/                    User-authored scripts (higher precedence)
  ~/.agents-system/hooks/             System-shipped scripts

  Manifest declarations:
  ~/.agents/agents.yaml               User-layer hook manifest  (hooks: section)
  ~/.agents-system/agents.yaml        System-layer hook manifest (hooks: section)

  Merge rule: user wins on key collision.
              enabled: false in user layer disables a system hook without forking it.

                         agents hooks add / agents use
                                    │
                                    ▼
  <version-home>/
    .claude/hooks/<name>.sh          Copied script (Claude)
    .codex/hooks/<name>.sh           Copied script (Codex)
    ...

  registerHooksToSettings() writes resolved paths into agent-native config:
    Claude:   <version-home>/.claude/settings.json        (hooks: {...})
    Codex:    <version-home>/.codex/hooks.json            + config.toml features.codex_hooks=true
    Gemini:   <version-home>/.gemini/settings.json        (hooks: {...})
    Agy:      <version-home>/.gemini/antigravity-cli/settings.json

                         Agent fires event
                                    │
                                    ▼
  Agent reads registered hooks from its settings file and execs the registered
  command with event context as JSON on stdin. For a hook that declares
  matches:, cache:, or a bare matcher: (the tool-name filter, e.g. git-guard's
  matcher: Bash), the registered command is a generated wrapper shim, not the
  raw script. The shim evaluates the matches: predicates first (a port of
  shouldFire() in src/lib/hooks/match.ts): if any predicate fails it exits 0
  without running the script; if all pass it execs the real script (then
  applies cache: if set) and appends a hook.fire timing sample either way. A
  hook with none of matches:/cache:/matcher: is registered by its raw script
  path with no timing wrapper — a bare lifecycle hook with nothing to gate,
  cache, or filter by tool.
```

## Command Reference

| Command | Description |
|---------|-------------|
| `agents hooks list [agent]` | Show registered hooks per agent version and which events they respond to |
| `agents hooks add [source]` | Install from GitHub, local path, or pick interactively from `~/.agents/hooks/` |
| `agents hooks remove [name]` | Delete a hook from agent version homes |
| `agents hooks view [name]` | Print the shell script source for a hook |

### Options

| Command | Flag | Effect |
|---------|------|--------|
| `list` | `-a, --agent <agent>` | Filter to a specific agent; supports `agent@version` syntax |
| `list` | `-s, --scope <scope>` | `user` (global), `project` (repo), or `all` (default) |
| `add` | `-a, --agents <list>` | Target specific agents/versions: `claude`, `codex@0.116.0`, `antigravity@default` |
| `add` | `--names <list>` | Install specific hooks by name from `~/.agents/hooks/` (comma-separated) |
| `add` | `-y, --yes` | Skip all prompts |
| `remove` | `-a, --agents <list>` | Limit removal to specific agents |

## Hook Manifest Schema

Hooks are declared in the `hooks:` section of `agents.yaml`. The schema maps to `ManifestHook` in `src/lib/types.ts:110`.

```yaml
# ~/.agents/agents.yaml  (user layer)
hooks:
  post-edit:
    script: post-edit.sh               # filename in ~/.agents/hooks/
    events:
      - PostToolUse
    timeout: 30s                       # seconds, or a duration string (5s, 2m, 1h30m); default 600
    matcher: "Edit"                    # optional: tool name filter (PreToolUse/PostToolUse)
    matches:
      cwd_includes: /projects/myapp    # predicate: only fire in this path
    override: true                     # silence shadow warning when overriding system hook

  session-start:
    script: session-start.sh
    events:
      - SessionStart
    timeout: 10

  prompt-guard:
    script: prompt-guard.sh
    events:
      - UserPromptSubmit
    matches:
      prompt_contains: "deploy"        # only fire when prompt mentions deploy
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `script` | string | yes | Filename of the shell script in `~/.agents/hooks/` (or system hooks dir) |
| `events` | `string[]` | yes | One or more lifecycle events that trigger this hook |
| `timeout` | number \| string | no | Time before the hook is killed; default `600`. A bare number is seconds; a duration string (`5s`, `2m`, `1h30m`) is also accepted and normalized to seconds |
| `matcher` | string | no | Tool name substring filter for `PreToolUse`/`PostToolUse` events (Codex) |
| `matches` | `HookMatches` | no | Predicate set; all predicates AND together |
| `enabled` | boolean | no | Set `false` in user layer to disable a system-shipped hook of the same name |
| `override` | boolean | no | Set `true` to silence the shadow warning when a user hook has the same name as a system hook |
| `cache` | string \| object | no | Opt-in caching + per-invocation timing. See [Caching](#caching). |

## Caching

Any hook that runs slow — API call, heavy script, anything over a few hundred ms — should declare `cache:` so the registrar wraps it in a shim that serves cached output and logs timing. The underlying script stays unchanged.

### Shorthand

```yaml
hooks:
  linear-inject-tasks:
    script: 03-linear-inject-tasks-context.sh
    events: [SessionStart]
    cache: 5m         # ttl=5min, key=global, prefetch=none
```

| Shorthand | Meaning |
|-----------|---------|
| `30s` | 30-second TTL, sync refresh on miss |
| `5m` | 5-minute TTL, sync refresh on miss |
| `1h` | 1-hour TTL, sync refresh on miss |
| `5m-bg` | 5-minute TTL, stale-while-revalidate: serve stale immediately + refresh in background |

### Full object form

```yaml
cache:
  ttl: 1h                # seconds or "30s" / "5m" / "1h"
  key: per-cwd           # global | per-cwd | per-session | per-project
  prefetch: background   # none | background
```

| Key | Effect | Use when |
|-----|--------|----------|
| `global` (default) | One cache file per hook, shared everywhere | SessionStart hooks pulling org-wide context (Linear sprint, GitHub notifications) |
| `per-cwd` | Cache keyed on the `cwd` field in the hook's stdin JSON | Per-repo context injection |
| `per-session` | Cache lives for the agent's `session_id` | Memoization within a session for hooks that fire repeatedly |
| `per-project` | Cache keyed on the nearest git repo root above cwd | Per-project context injection |

`prefetch: background` is the magic flag for SessionStart-style hooks: boot is always instant because the shim serves the cached file immediately, then refreshes in a detached child for the next session.

### What it generates

When the registrar sees `cache:`, `matches:`, or a bare `matcher:` on a hook,
it writes a per-hook shim under `~/.agents/.cache/shims/hooks/<name>.sh` and
registers that shim's path in the agent's native settings file
(`~/.claude/settings.json`, `~/.codex/hooks.json`, etc.) instead of the raw
script. The shim:

1. Reads stdin once (Claude/Codex/Gemini pass JSON to every hook).
2. If `cache:` is set: computes the cache file path from `key:`, serves it if
   fresh (cache=hit), serves stale + spawns a detached refresh when
   `prefetch: background` (cache=stale-prefetch), or runs the real script +
   caches the output (cache=miss). A hook with no `cache:` (matches:/matcher:
   only) is a pure pass-through — it just execs the script, no cache read/write.
3. Appends one JSONL line per fire to `~/.agents/.cache/logs/events-YYYY-MM-DD.jsonl`.
4. Appends one NDJSON line to the disposable perf spool
   (`~/.agents/.cache/perf/spool.jsonl`), drained into `perf.db` on the next
   `agents perf` / `agents hooks profile` open. This line carries `cwd` and
   `session_id` when the hook's own stdin JSON has them — that's what lets
   `agents perf hooks --project <key>` scope a hook's rollup to one repo.

Steps 3-4 (timing) run for EVERY shimmed hook, cache or not — that's what
makes a matcher-only hook like git-guard show up in `agents perf hooks`.

Stale shim files are garbage-collected automatically when a hook is renamed,
deleted, or loses its `cache:`/`matches:`/`matcher:` field entirely.

A shim embeds one `SOURCE=` path, the script inside the canonical version
home. If that file is not on disk when the hook fires (the version was pruned,
or sync is rewriting the hooks dir), a `PreToolUse` shim exits 2 with
`<hook>: hook source is missing (...); refusing the tool call unchecked
(fail-closed). Run: agents hooks sync` and logs `cache: missing-source`. Every
harness reads any other exit code as "allow", which is how a missing guard
script used to wave tool calls through silently (exit 127). Shims for other
events stay fail-open. Removing a version re-points the shims at the
surviving canonical home immediately, without waiting for the daemon's
self-heal pass.

### `agents hooks profile` / `agents perf hooks`

```
agents hooks profile              # last 7 days, table form
agents hooks profile --days 30
agents hooks profile --json | jq
agents hooks profile --warn-ms 500
agents perf hooks                 # same rollup under the perf surface
```

Aggregates hook timings into per-hook p50/p95/p99/mean/max + cache hit rate +
error/timeout rate. Primary source is the indexed warehouse
`~/.agents/.cache/perf/perf.db` (safe to wipe). Falls back to the legacy daily
JSONL when the warehouse is empty. Any hook whose p99 exceeds `--warn-ms`
(default 2000) and has no cache hits gets flagged as a candidate for `cache:`.

Hooks are instrumented when a generated shim wraps them — `cache:`, `matches:`,
or a bare `matcher:` are each enough. A hook with none of the three (a plain
lifecycle hook with nothing to gate, cache, or filter by tool) is the only kind
that never shows up here; add `matches:`/`matcher:`/`cache:` to opt it in, then
resync.

See also [`observability.md`](./observability.md) for the `agents perf`
summary (`commands`, `run`, multi-section default).


### Supported Events

| Event | When it fires | Agents |
|-------|--------------|--------|
| `SessionStart` | Agent session begins | Claude, Codex, Grok, Copilot (`sessionStart`), Goose, Cursor (`sessionStart`), Hermes (`on_session_start`) |
| `SessionEnd` | Agent session ends | Claude, Grok, Copilot (`sessionEnd`), Goose, Cursor (`sessionEnd`), Hermes (`on_session_end`) |
| `UserPromptSubmit` | User prompt received before model sees it | Claude, Grok, Copilot (`userPromptSubmitted`), Goose, Cursor (`beforeSubmitPrompt`), Hermes (`pre_llm_call`) |
| `PreToolUse` | Before a tool call executes | Claude, Codex, Antigravity (`before_tool_call`), Copilot (`preToolUse`), Goose, Cursor (`preToolUse`), Hermes (`pre_tool_call`) |
| `PostToolUse` | After a tool call completes | Claude, Codex, Antigravity (mapped to `after_model_call`), Copilot (`postToolUse`), Goose, Cursor (`postToolUse`), Hermes (`post_tool_call`) |
| `SubagentStop` | A subagent finishes | Claude, Cursor (`subagentStop`), Hermes (`subagent_stop`) |
| `PreCompact` | Before context compaction | Claude, Grok, Copilot (`preCompact`), Cursor (`preCompact`) |
| `Stop` | Agent stops (final turn) | Claude, Codex, Antigravity (`on_loop_stop`), Grok, Copilot (`agentStop`), Goose, Cursor (`stop`), Hermes (`on_session_finalize`) |
| `Notification` | Agent sends a notification | Claude, Grok, Copilot (`notification`) |
| `OnError` | Agent encounters an error | Antigravity (`on_error`), Copilot (`errorOccurred`) |

Event name mapping across agents is handled in `src/lib/hooks/install.ts`: `GEMINI_EVENT_MAP`, `ANTIGRAVITY_EVENT_MAP`, Grok's `eventMap`, `COPILOT_EVENT_MAP`, `GOOSE_EVENT_MAP`, `CURSOR_EVENT_MAP`, and `HERMES_EVENT_MAP`.

## Version-home deduplication

Each installed harness version has its own synced hook scripts. Every native
registrar emits one entry per logical manifest resource and event. For the
Claude-shaped and Codex read-modify-write formats, existing registrations are
also deduplicated by logical hook resource name, not absolute path, so the same
hook copied under several version homes is registered once and the active
version's command is authoritative. Other harnesses rewrite their one managed
hook file from the manifest on each sync and therefore cannot accumulate sibling
version paths there.

Run `agents doctor` to inspect the copies. Identical same-name scripts across
versions are warnings because they add runtime noise and cost if registered
together. Same-name scripts with different SHA-256 hashes are critical drift:
an older version can otherwise enforce stale rules while the active copy passes.
The inspection covers every hooks-capable harness. The text report and `agents
doctor --json` both name every affected version and the authoritative active
version; JSON consumers such as the menu-bar health view receive the same
findings under `health.issues` and `duplicateHooks`.

Hermes (Nous Research, ≥ 0.11.0) declares hooks under a `hooks:` block in `~/.hermes/config.yaml` (shared with `mcp_servers`); the registrar read-modify-writes that YAML doc so sibling keys survive. Each entry is `{ command, timeout, matcher? }` (timeout defaults to 60s, capped at 300s).

## Predicate Matchers

All predicates live in `matches:`. They AND together — every declared predicate must pass. Evaluated by `shouldFire()` in `src/lib/hooks/match.ts:120`. The hook input context (`HookInput`) is passed by the agent CLI as JSON to each registered script.

| Matcher | Tests | Example |
|---------|-------|---------|
| `prompt_contains` | User prompt string contains this substring (exact) | `prompt_contains: "deploy"` |
| `prompt_matches` | User prompt matches this regex | `prompt_matches: "^(deploy\|release)"` |
| `tool_name` | Tool name equals one of these values (`string` or `string[]`) | `tool_name: ["Edit", "Write"]` |
| `tool_args_match` | Serialized tool arguments match this regex | `tool_args_match: "production"` |
| `cwd_includes` | Current working directory contains any of these substrings (`string` or `string[]`) | `cwd_includes: "/projects/myapp"` |
| `project_has` | Project root (nearest `.git` ancestor) contains this file or directory | `project_has: "Cargo.toml"` |
| `git_dirty` | Working tree dirty state matches this boolean | `git_dirty: true` |
| `permission_mode` | Reported permission mode is one of these values (`string` or `string[]`). Fail-open: an input with no `permission_mode`/`permissionMode` field passes, because only some harnesses (Claude Code) report the live mode | `permission_mode: "plan"` |
| `permission_mode_not` | Reported permission mode is **not** one of these values (`string` or `string[]`). Same fail-open rule. Use this — not an enumerated `permission_mode` allowlist — to gate a hook **off** in one mode | `permission_mode_not: "plan"` |

### Matcher Implementation Notes

- `prompt_contains`: `src/lib/hooks/match.ts:125` — `prompt.includes(matches.prompt_contains)`
- `prompt_matches`: `src/lib/hooks/match.ts:130` — compiled via `compileHookRegex()`; capped at 200 chars and max group depth 3 to prevent ReDoS
- `tool_name`: `src/lib/hooks/match.ts:137` — accepts a string or array; `arrayOf()` normalizes both
- `tool_args_match`: `src/lib/hooks/match.ts:156` — serializes `tool_args` to JSON if not already a string, then applies regex
- `cwd_includes`: `src/lib/hooks/match.ts:166` — `cwd.includes(n)` for each needle; passes if any matches
- `project_has`: `src/lib/hooks/match.ts:174` — walks up to the nearest `.git` directory via `findProjectRoot()`, then checks `fs.existsSync(path.join(root, matches.project_has))`
- `git_dirty`: `src/lib/hooks/match.ts:180` — runs `git status --porcelain` in `cwd`; returns true if output is non-empty
- `permission_mode`: `src/lib/hooks/match.ts:145` — reads `permission_mode` or camelCase `permissionMode` from the input; skips only on an explicit value outside the allowlist. Unlike `tool_name`, absence passes — a harness that never reports a mode keeps firing the hook
- `permission_mode_not`: `src/lib/hooks/match.ts:156` — the inverse; skips only on an explicit value **inside** the deny list. It exists because the allowlist cannot express "everywhere except plan" without naming every other mode, and such an enumeration silently stops firing the moment a harness adds or renames one — for a guard, that means it quietly stops guarding. Naming the mode to skip keeps unknown modes firing, so the failure direction is "ran unnecessarily", never "did not run". Both forms AND together when declared on the same hook

### Two evaluators, kept in lockstep by test

`shouldFire()` in `match.ts` is the **reference**, not the runtime. A hook fire is
decided by a hand-mirrored Python copy of that logic embedded in the generated shim
(`src/lib/hooks/cache.ts`, the `GATE_PY` block), which the shim runs against
`$MATCHES_JSON` and the event payload before invoking the hook script. Nothing in the
fire path calls `shouldFire()`.

That means **a predicate added to `match.ts` alone does nothing.** It must land in the
Python gate in the same change. The gate fails open by design — any evaluation error
runs the hook — so an unmirrored predicate is silently ignored rather than crashing,
which is how `permission_mode_not` shipped inert (RUSH-3116).

`cache-matches.test.ts` guards this: it runs the real shim under `bash` for each
fixture and asserts the decision equals `shouldFire()`, and a completeness test
derives the predicate list from the `HookMatches` interface in `types.ts` so a new key
fails the suite until it is exercised against both implementations.


## Script Resolution

`resolveHookScriptPath(script)` in `src/lib/hooks/install.ts` resolves a script filename by checking, in order:

1. `~/.agents/hooks/<script>` (user dir)
2. Each enabled extra repo's `hooks/` directory (insertion order)
3. `~/.agents-system/hooks/<script>` (system dir)

The first match wins. At agent launch, scripts are copied from the central dirs into the version home (`<version-home>/.claude/hooks/`), and the registered command paths in `settings.json` point to the version-local copies — so scripts remain stable even when the source directories change.

## Disabling System Hooks

To disable a hook shipped by `~/.agents-system/`, add an entry with `enabled: false` in your `~/.agents/agents.yaml`:

```yaml
hooks:
  03-linear-inject-tasks-context:
    script: 03-linear-inject-tasks-context.sh
    events:
      - UserPromptSubmit
    enabled: false          # Disables the system-shipped hook
```

`parseHookManifest()` in `src/lib/hooks/install.ts` strips entries where `enabled === false` from the returned map before the registrar sees them.

## Recipes

**1. List all registered hooks**

```bash
agents hooks list
agents hooks list claude
agents hooks list claude@2.1.112
agents hooks list --scope user
```

**2. Install hooks from GitHub**

```bash
agents hooks add gh:team/hooks --agents claude,codex
agents hooks add gh:team/hooks --agents claude@2.1.112
```

**3. Install a specific hook by name**

```bash
agents hooks add --names post-edit --agents claude
agents hooks add --names post-edit,session-start --agents claude@default
```

**4. Gate a hook to fire only on Edit tool calls**

In `~/.agents/agents.yaml`:

```yaml
hooks:
  post-edit:
    script: post-edit.sh
    events:
      - PostToolUse
    matches:
      tool_name: "Edit"
```

**5. Gate a hook to a specific working directory**

```yaml
hooks:
  deploy-check:
    script: deploy-check.sh
    events:
      - UserPromptSubmit
    matches:
      cwd_includes: /projects/myapp
      prompt_contains: deploy
```

**6. Disable a system-shipped hook from user layer**

```yaml
# ~/.agents/agents.yaml
hooks:
  03-linear-inject-tasks-context:
    script: 03-linear-inject-tasks-context.sh
    events:
      - UserPromptSubmit
    enabled: false
```

**7. Fire a hook only on session start in dirty repos**

```yaml
hooks:
  dirty-tree-warn:
    script: dirty-tree-warn.sh
    events:
      - SessionStart
    matches:
      git_dirty: true
```

**8. View a hook's script source**

```bash
agents hooks view post-edit
agents hooks view       # interactive picker
```

**9. Remove a hook**

```bash
agents hooks remove post-edit
agents hooks remove     # interactive picker
agents hooks remove post-edit --agents claude
```

## Demo

<video autoplay loop muted playsinline width="100%" src="../assets/videos/hooks.mp4"></video>

## See Also

- [resource-sync.md](resource-sync.md) — hooks participate in the same layered resource sync as commands, skills, and rules
- [docs/plugins.md](plugins.md) — plugins can bundle hooks alongside skills and MCP servers
- docs/workflows.md — workflow lifecycle events that hooks can observe
- [docs/subagents.md](subagents.md) — subagent definitions that parent agents dispatch to
