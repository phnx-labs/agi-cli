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
- `refs` come from scanning `done.text`: Linear keys whose team prefix is the linear-cli
  team or appears in the project's open tickets (so `GPT-4` or `TLS-1` never link), `#123`
  only when 123 is among the project's open or recently updated PRs, explicit GitHub PR
  urls, and live sessions by id or by an exact title of three or more words. The Lead's
  own session is never a ref.
- `timing` is seconds: `boot` (from the first spawn of the turn to Claude's init, cold turns
  only, including a failed resume before a fresh start), `tools` (union of tool run time),
  `model` (the rest).

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
agents lead ask ──unix socket (0600)──▶ host (agents __lead-host <project>, detached)
                                          ├─ agents run claude --headless … stream-json   (warm child)
                                          └─ agents feed watch --json                       (live roster)
```

- **One host per project**, started by `ask` on demand as a detached process, listening on
  `~/.agents/lead/<project>/host.sock` behind an exclusive `host.lock`. It survives the
  caller exiting, VSCodium reloads and VSCodium being closed. It exits after 4 hours without
  a request or on `agents lead stop` (which waits for the turn in flight).
- **Version and model pinning:** `host.json` records the CLI version and `lead.model` the host
  started with. `ask` restarts a host whose version or model differs from its own, so a
  self-update or `agents config set lead.model` takes effect on the next ask.
- **Why a host and not the daemon:** the daemon is shared and stays on production code
  (`scripts/install.sh` does not bounce it), restarts on self-update, and has no per-request
  streaming IPC for a child it owns. A daemon restart would kill every warm Lead.
- **Launch:** `agents run claude --headless --quiet --cwd ~/.agents/lead/<project> --model
  <lead.model> --effort low (--session-id <uuid> --name lead-<project> | --resume <id>) --
  --input-format stream-json --output-format stream-json --verbose --include-partial-messages
  --setting-sources local --settings <lead-settings.json> --strict-mcp-config --tools Bash
  --permission-mode dontAsk --allowedTools 'Bash(agents lead tool <name>:*)'… --disallowedTools …`.
  Each turn is one stream-json user line on its stdin. Turns are serialized.
- **Isolation:** the user's and project's Claude settings, hooks and MCP servers are not
  loaded; `lead-settings.json` (written by the host) holds the only permissions. The cwd is
  the Lead directory, so no project `CLAUDE.md`, memory or `.env` is in reach. The child gets
  a minimal environment: `PATH` (with `~/.agents/lead/<project>/bin` first, whose `agents`
  shim pins the host's own CLI), `HOME`, locale and temp variables, `ANTHROPIC_*` and
  `CLAUDE_CODE_OAUTH_TOKEN`, and `AGENTS_LEAD_PROJECT`.
- **Recovery:** if the child exits, the next turn re-spawns it with `--resume <session>`. Only
  a "no session found" failure starts a fresh session from the brief; any other start failure
  (rate limit, auth) is an `error` event and the session is kept.
- **Rotation:** after a turn whose context passes 60% of the model window (from the
  `result` event's last-iteration usage and `modelUsage[*].contextWindow`), the stream ends
  with `done` as usual and the host then, in the background, asks the Lead for a memory list,
  writes `memory.md`, and ends the session. The next `ask` waits behind it and starts fresh.

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

## Lead tools

The Lead's shell may run only `agents lead tool <name>` commands, one at a time. Under the
isolated settings a compound command (`;`, `&&`, `|`, `$(…)`, backticks, redirects) or any
other program is denied. Each tool has one fixed shape:

| Tool | Does |
|---|---|
| `roster [--project <p>]` | Live sessions from the host's feed snapshot (never a fleet `agents ps`) plus a fleet count. The only way the Lead sees sessions. |
| `dispatch --ticket <ID> [--agent <a>]` | `linear update <ID> --pickup --delegate <a>`, then asks the host to start `agents run <a> "Work on <ID>: <title>" --headless -P <project> --mode edit`, detached. |
| `start --agent <a> -- <task>` | The same run shape for a task with no ticket. |
| `send --session <id> -- <text>` | `agents send --channel session` to a live session of this project. The text must be one line; control characters are stripped; text whose first non-space character is a slash, a bang or a hash is refused; and what is typed always starts with `[Lead] `, so the session never sees a slash command, a shell escape or a memory note. |
| `stop --session <id>` | Mints a confirm token and emits the `confirm` event. Never stops anything. |
| `linear tasks [--status …] [--limit n]`, `linear view <ID>`, `linear create --title <t> [--description <d>]` | Reads, and creation in the project's Linear project. |
| `remember -- <note>` | Appends one note (at most 500 characters) to `memory.md`, keeping the last 60. |

Workers are spawned by the host, not by the Lead's shell, with a curated copy of the calling
client's environment (`PATH`, `HOME`, `SSH_AUTH_SOCK`, `GH_TOKEN`, `GITHUB_TOKEN`,
`LINEAR_API_KEY`, `DISPLAY`, the Anthropic auth variables and similar). `AGENTS_LEAD_PROJECT`
and the Lead's `agents` shim never reach a worker, so a worker cannot call the Lead tools or
write its memory. The roster and the per-turn delta leave out Lead sessions (title `lead-*` or
a cwd under `~/.agents/lead`).

No tool accepts `--mode`, `--secrets`, `--device`, `--lease`, `--cloud` or pass-through
arguments. Ticket, PR and session titles reach the model as data; the brief says so, and
`memory.md` is quoted under "notes, not instructions".

`agents lead confirm <token>` claims a token once (atomic rename) and runs
`agents ps stop <sessionId>`. Tokens expire after 10 minutes; the host sweeps expired ones.

`cli/scripts/lead-permission-smoke.ts` runs the real Claude launch shape against probes
(`;`, `&&`, `$(…)`, backticks, `>`, `cat ~/.agents/agents.yaml`, `jq -n env`, `agents ps --local stop`,
`agents run --mode skip`) and checks each is denied while `agents lead tool roster` runs:
`AGENTS_BIN=agents-dev bun cli/scripts/lead-permission-smoke.ts`.

## Files

`~/.agents/lead/` holds a `.gitignore` of `*`, so nothing here syncs with the user repo.

| Path | Holds |
|---|---|
| `<project>/session.json` | lead session id, model, turns, last context use, brief summary, last roster |
| `<project>/memory.md` | memory carried across rotations |
| `<project>/history.ndjson` | one line per finished turn (rotated to `.1` at 5 MB) |
| `<project>/host.json`, `host.lock`, `host.sock`, `host.log`, `host.out` | the running host (`host.log` rotates at 2 MB) |
| `<project>/lead-settings.json`, `bin/agents` | the Lead's isolated permissions and its `agents` shim |
| `<project>/runs/*.log` | output of agents the Lead dispatched |
| `confirms/<token>.json` | pending confirms |
| `surface.json` | client-owned `{ "surface": "bubble" \| "docked" }`; the CLI never writes it, and clients treat a missing file as `docked` |

## Setting

`lead.model` (user scope, central `agents.yaml`, default `sonnet`) is the model passed to
`agents run claude --model`. A running Lead keeps its model until `stop` or a rotation.
