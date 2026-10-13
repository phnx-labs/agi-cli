# Lead

The Lead is one long-lived headless Claude per project. You talk or type to it and it
dispatches and manages agents through the CLIs. It never speaks and never edits files.
agents-cli owns the process; every UI (AGI EXT, the FastWispr bubble) is a thin client
that shells out to `agents lead … --json`.

## Commands

```
agents lead ask --project <name> [--voice <secs>] [--json] -- <text…>
agents lead confirm <token> [--json]
agents lead history --project <name> [--limit N] --json
agents lead status [--project <name>] --json
agents lead stop --project <name>
```

| Command | Does | Exit |
|---|---|---|
| `ask` | Starts the project host if needed, sends one message, streams the turn. `--voice` marks the text as a transcript of that many seconds. | 1 on an `error` event or a stream that closed before `done` |
| `confirm` | Runs the action a `confirm` event held (today only `stop`, as `agents ps stop <sessionId>`), streams `tool` and `done`. | 1 on an unknown, used, expired or failed token |
| `history` | Prints finished turns, oldest first. `--json` is a JSON array. | 0 |
| `status` | `--json` prints one status object with `--project`, else an array over every project that has a Lead directory. | 0 |
| `stop` | Stops the host and its Claude process. The session stays resumable. | 0 (prints whether it was running) |

`--project` is a name from `agents projects list`; an unknown name fails before anything starts.

### `ask --json` events (NDJSON)

```
{"type":"turn","turn":"t_…","project":"rush","session":"<leadSessionId>","engine":"warm"|"cold"}
{"type":"status","state":"booting"|"thinking"|"tool"|"answering"}
{"type":"tool","id":"…","label":"agents ps","cmd":"agents ps --json","state":"run"}
{"type":"tool","id":"…","label":"agents ps","state":"ok"|"fail","secs":1.24}
{"type":"text","delta":"…"}
{"type":"confirm","token":"c_…","action":"stop","sessionId":"…","label":"Stop “Rush MCP token security”"}
{"type":"done","turn":"t_…","text":"<full reply>","summary":"<first sentence, ≤80 chars>","refs":[…],"timing":{"boot":0,"model":1.45,"tools":1.24}}
{"type":"error","message":"…"}
```

- `turn` is always first. `engine` is `cold` when this turn had to start the Claude
  process (first use, after `stop`, after a crash, after a rotation) and `warm` otherwise.
  If a `--resume` start fails before Claude initializes, the host starts a fresh session
  from the brief and emits a second `turn` event carrying the new session id.
- `text` deltas are everything the model writes, including narration between tool calls;
  `done.text` is the final answer and is authoritative.
- `refs` come from scanning `done.text`: Linear keys (`PHNX-4365`, url from the brief's
  ticket list or the linear-cli workspace), `#123` and GitHub PR urls (repo from the
  project definition), and live session titles or ids from the feed (`kind: "session"`,
  with `host`). The Lead's own session is never a ref.
- `timing` is seconds: `boot` (spawn to Claude's init, cold turns only), `tools` (union of
  tool run time), `model` (the rest).

### History and status shapes

A history turn is `{turn, at, ask, voice?, text, summary, refs, tools, session, timing}`:
`at` is ISO 8601, `voice` is seconds when spoken, `tools` is `[{label, cmd, state, secs}]`.
A confirm run appends a turn whose `ask` names the token.

A status object is `{project, state, session, engine, model, host, brief, memory, tools,
pid, busy, queued, turns, contextPct, lastTurnAt}`. `state` is `warm` (host and Claude
running), `cold` (host up, Claude not started or exited) or `stopped` (no host). `brief` is
a short list describing the last brief, `memory` the lines of `memory.md`, `tools` the
allow-list.

## Process model

```
agents lead ask ──unix socket──▶ host (agents __lead-host <project>, detached)
                                   ├─ agents run claude --headless … stream-json   (warm child)
                                   └─ agents feed watch --json                       (live roster)
```

- **One host per project**, started by `ask` on demand as a detached process, listening on
  `~/.agents/lead/<project>/host.sock`. It survives the caller exiting, VSCodium reloads and
  VSCodium being closed. It exits after 4 hours without a request or on `agents lead stop`.
- **Why a host and not the daemon:** the daemon is shared and stays on production code
  (`scripts/install.sh` does not bounce it), restarts on self-update, and has no per-request
  streaming IPC for a child it owns. A daemon restart would kill every warm Lead. A small
  host per project isolates each Lead's crash and restart, keeps its stream on its own
  socket, and needs no daemon change.
- **Launch:** `agents run claude --headless --quiet -P <project> --model <lead.model>
  --effort low (--session-id <uuid> --name lead-<project> | --resume <id>) -- --input-format
  stream-json --output-format stream-json --verbose --include-partial-messages --tools Bash
  --permission-mode dontAsk --allowedTools … --disallowedTools …`. Each turn is one
  stream-json user line on its stdin. Turns are serialized; a second `ask` waits its turn.
- **Recovery:** if the child exits, the next turn re-spawns it with `--resume <session>`.
- **Rotation:** after a turn whose context passes 60% of the model window (from the
  `result` event's last-iteration usage and `modelUsage[*].contextWindow`), the host asks the
  Lead for a memory list, writes `memory.md`, ends the session, and the next turn starts a
  fresh session whose brief carries that memory.

## Brief and per-turn delta

The first message of a session carries the brief: the project, its Linear project and
goals, the repository, the rules, a digest of the project's `AGENTS.md` (title, first
paragraph, section names), the project's live sessions and a fleet count from the feed,
open tickets (`linear tasks --project … --status open --json`), open PRs
(`gh api repos/<repo>/pulls`, REST), and `memory.md`. A ticket or PR source that fails is
named in the brief as unavailable, never silently dropped.

Every later message starts with `[State delta]`: sessions of this project that started,
ended, changed status or were renamed since the last turn, then one fleet line counting
live sessions by status. Both come from the host's `agents feed watch --json` subscription,
so a turn never waits on a fleet `agents ps`.

## Tools and confirms

The Lead's shell is limited to `agents ps|send|run|feed`, `sessions`, `artifacts list`,
`linear` and `jq` (pipelines through `jq` keep JSON small). `Edit`, `Write`, `MultiEdit`,
`NotebookEdit` and `agents ps stop` are denied. The harness also lets read-only shell
builtins such as `head` and `cat` through; nothing that writes.

When the Lead calls `agents ps stop <id>`, the call is denied by the harness and the host
turns it into a `confirm` event with a token stored in `~/.agents/lead/confirms/`.
`agents lead confirm <token>` claims it once (atomic rename) and runs the stop. Tokens
expire after 10 minutes.

## Files

`~/.agents/lead/` holds a `.gitignore` of `*`, so nothing here syncs with the user repo.

| Path | Holds |
|---|---|
| `<project>/session.json` | lead session id, model, turns, last context use, brief summary, last roster |
| `<project>/memory.md` | memory carried across rotations |
| `<project>/history.ndjson` | one line per finished turn |
| `<project>/host.json`, `host.sock`, `host.log` | the running host |
| `confirms/<token>.json` | pending confirms |
| `surface.json` | client-owned `{ "surface": "bubble" \| "docked" }`; the CLI never writes it, and clients treat a missing file as `docked` |

## Setting

`lead.model` (user scope, central `agents.yaml`, default `sonnet`) is the model passed to
`agents run claude --model`. A running Lead keeps its model until `stop` or a rotation.
