# Lead

The Lead is one long-lived headless Claude per project. You talk or type to it and it
dispatches and manages agents through the CLIs. It never edits files, and it never acts on its own:
every action it takes is held for your Confirm. A client may read its reply aloud (`ask --speak`).
agents-cli owns the process; every UI (AGI EXT, the FastWispr bubble) is a thin client
that shells out to `agents lead … --json`.

## Commands

```
agents lead ask --project <name> [--voice <secs>] [--context <json>] [--speak] [--json] -- <text…>
agents lead confirm <token> [--json]
agents lead history --project <name> [--limit N] --json
agents lead status [--project <name>] --json
agents lead stop --project <name>
```

| Command | Does | Exit |
|---|---|---|
| `ask` | Starts the project host if needed, sends one message, streams the turn. `--voice` marks the text as a transcript of that many seconds. `--context` and `--speak` are below. | 1 on an `error` event or a stream that closed before `done` (never because of `--speak`) |
| `confirm` | Re-checks the held argv against its fixed shape and runs it once (see [Confirm](#confirm)), streams `tool` and `done`. | 1 on an unknown, used, expired, malformed or failed token |
| `history` | Prints finished turns, oldest first. `--json` is a JSON array. | 0 |
| `status` | `--json` prints one status object with `--project`, else an array over every project that has a Lead directory. | 0 |
| `stop` | Stops the host and its Claude process. The session stays resumable. | 0 (prints whether it was running) |

`--project` is a name from `agents projects list`; an unknown name fails before anything starts.

### `ask --context <json>`

A client passes what the editor shows so "this one" resolves. The value must be a JSON object with
only these fields (anything else, or text that is not JSON, fails before the host is contacted):

```json
{"front": {"sessionId": "…", "title": "…", "tab": 10},
 "tabs":  [{"sessionId": "…", "title": "…", "tab": 1}]}
```

Every field is optional; `tab` is a positive integer, `sessionId` a session id, `title` is cut to
200 characters, and at most 60 tabs are accepted. The turn's message then carries a short block
before the text:

```
[Editor context]
Front tab (what "this one" means): tab 10 “Fix login” (session 4b2f1a9c)
Open tabs: tab 1 “Docs” (session ffff0000); tab 2 “Fix login” (session 4b2f1a9c)
```

### `ask --speak`

Speaks the reply on the machine running `ask`, while it streams. Finished sentences are cut from the
`text` deltas (a period, `!`, `?` or `…` followed by a space, or a line break; `e.g.` and list
numbers do not end one), each is synthesized at once with ElevenLabs (`eleven_turbo_v2_5`, voice
`JBFqnCBsd6RMkjVDRZzb`, mp3), and the clips play in order with `afplay` on macOS and
`ffplay -nodisp -autoexit` elsewhere. The API key is `ELEVENLABS_API_KEY` read through the secrets
CLI from the bundle named by `lead.voice.bundle` (default `elevenlabs`) and is never written
anywhere. Speech never blocks or fails the turn: events stream as usual, a failure (no key, an HTTP
error, no player) prints one `voice: …` line on stderr and stops speaking, and `ask` exits after the
last clip has played.

### `ask --json` events (NDJSON)

```
{"type":"turn","turn":"t_…","project":"rush","session":"<leadSessionId>","engine":"warm"|"cold"}
{"type":"status","state":"booting"|"thinking"|"tool"|"answering"}
{"type":"tool","id":"…","label":"agents ps","cmd":"agents ps --json","state":"run"}
{"type":"tool","id":"…","label":"agents ps","state":"ok"|"fail","secs":1.24}
{"type":"text","delta":"…"}
{"type":"confirm","token":"c_…","action":"stop"|"answer"|"send"|"start"|"dispatch"|"pr","label":"Stop “Rush MCP token security”","detail":"…","sessionId":"…"}
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
- `confirm` is emitted when the Lead queues an action. `label` says what it does; `detail` (when
  present) is the message, answer text, task, or PR title or comment; `sessionId` names the session it
  acts on, when there is one. Nothing has run until `agents lead confirm <token>`.
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
- **Drafting new asks:** when an attention item opens for a session of its project (an
  AskUserQuestion, a plan, or the Stop hook's `asks` / `not_done` turn verdict), the host
  queues one turn of its own for it, batching asks that arrive within 20 seconds, beside
  any `ask` of yours. The turn asks the Lead to draft the reply you would most likely send
  with its `answer` tool, or to say in one line why the decision is yours. Each ask is
  drafted once. A held `answer` is also written to `drafts/`, and the fleet `feed watch`
  on this machine puts it on that ask as `draft`, so the card shows it with Send (the
  ordinary `agents feed answer`). The Lead delivers nothing itself. Drafting runs only
  while the host does.
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
- **New rules:** `session.json` records which version of the Lead's rules briefed the session. When
  an upgrade changes them (new tools, say), the next turn starts a fresh session from the brief, with
  `memory.md`, instead of resuming one that does not know the new tools.
- **Rotation:** after a turn whose context passes 60% of the model window (from the
  `result` event's last-iteration usage and `modelUsage[*].contextWindow`), the stream ends
  with `done` as usual and the host then, in the background, asks the Lead for a memory list,
  writes `memory.md`, and ends the session. The next `ask` waits behind it and starts fresh.

## Brief and per-turn delta

The first message of a session carries the brief: the project, its Linear project and
goals, the repository, the rules, a digest of the project's `AGENTS.md` (title, first
paragraph, section names), the project's live sessions and a fleet count from the feed,
open tickets (`linear tasks --project … --status open --json`), the 40 most recently
updated PRs (`gh api repos/<repo>/pulls?state=all&sort=updated`, REST) split into open ones
with their last update and "Merged or closed lately" with when each was merged or closed,
and `memory.md`. Sessions carry when they started and were last active. A ticket or PR source that fails is
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
| `roster [--project <p>]` | Live sessions from the host's feed snapshot (never a fleet `agents ps`), each with when it started and was last active, plus a fleet count. The only way the Lead sees sessions. |
| `roster --session <id>` | One session of this project's last two turns of conversation, the owner's and the agent's words only (`sessions <id> --include user,assistant --last 2 --markdown`, over `-H <host>` for another machine), cut to 12,000 characters. |
| `attention` | Every open ask across the fleet from the host's feed (the `attention` items of `feed watch --json`, any project): one line each with the attention key, session title, host, project, age, the question (cut to 240 characters) and the choice ids and labels. No SSH of its own; says so when the feed is not connected yet. |
| `prs list [--repo <owner/repo>]` | `agents projects prs list <project> --json`, one line per open PR: `repo#number [draft] title · updated 3h ago`. |
| `linear tasks [--status …] [--limit n]`, `linear view <ID>`, `linear create --title <t> [--description <d>]` | Reads, and creation in the project's Linear project. `tasks` lists the most recently updated first, each with `· updated 2d ago`, cut to `--limit` with a count of the older ones. |
| `answer --key <key> (--choice <id> \| --text <answer>)` | **Held.** The key must be open in the feed and the choice one of its ids; the text is one line and may not start with `/`, `!` or `#`. Confirm runs `agents feed answer <key> --choice\|--text <value> --json`. |
| `send --session <id> -- <text>` | **Held.** Confirm runs `agents send --channel session --to <id> --text "[Lead] <text>"` to a live session of this project. The text must be one line; control characters are stripped; text whose first non-space character is a slash, a bang or a hash is refused; and what is typed always starts with `[Lead] `, so the session never sees a slash command, a shell escape or a memory note. |
| `start --agent <a> -- <task>` | **Held.** A task that starts with `-` is refused (it would be read as a flag). Confirm starts `agents run <a> "<task>" --headless -P <project> --mode edit`, detached. |
| `dispatch --ticket <ID> [--agent <a>]` | **Held.** Reads the ticket's title now; confirm runs `linear update <ID> --pickup --delegate <a>`, then starts `agents run <a> "Work on <ID>: <title>" --headless -P <project> --mode edit`, detached. |
| `stop --session <id>` | **Held.** Confirm runs `agents ps stop <id>`. |
| `prs merge\|comment\|ready\|rerun\|close --repo <r> --number <n> [--body <text>] [--sha <head>] [--run-id <id>]` | **Held.** Reads the PR first (it must be an open PR of the project). Confirm runs `agents projects prs <verb> <project> --repo <r> …--json`: merge is pinned to `--sha` or the head read now and never passes `--admin`; comment needs `--body`; rerun takes the PR's one failing Actions run, or `--run-id` when it has several. |
| `remember -- <note>` | Appends one note (at most 500 characters) to `memory.md`, keeping the last 60. |

A held tool mints a confirm token on the host and emits the `confirm` event on the turn; its output
tells the model that nothing has happened yet, and the Lead says what it queued and asks once.

Workers are spawned by `agents lead confirm`, not by the Lead's shell or the host, with a curated copy of the confirming
process's environment (`PATH`, `HOME`, `SSH_AUTH_SOCK`, `GH_TOKEN`, `GITHUB_TOKEN`,
`LINEAR_API_KEY`, `DISPLAY`, the Anthropic auth variables and similar). `AGENTS_LEAD_PROJECT`
and the Lead's `agents` shim never reach a worker, so a worker cannot call the Lead tools or
write its memory. The roster and the per-turn delta leave out Lead sessions (title `lead-*` or
a cwd under `~/.agents/lead`).

No tool accepts `--mode`, `--secrets`, `--device`, `--lease`, `--cloud` or pass-through
arguments. Ticket, PR and session titles reach the model as data; the brief says so, and
`memory.md` is quoted under "notes, not instructions".

## Confirm

A held action is a record in `confirms/<token>.json`: `{token, project, action, argv, label, detail?,
sessionId?, linearArgv?, createdAtMs, expiresAtMs}`, where `argv` is the exact `agents` argv to run
(and `linearArgv` the ticket pickup of a dispatch). `agents lead confirm <token>` claims it once
(atomic rename), rebuilds the argv from its fixed shape and refuses a record that differs, then runs
it: `start` and `dispatch` start the worker detached (a dispatch picks the ticket up first), every
other action runs `agents <argv>` and waits for it. Tokens expire after 10 minutes; the host sweeps
expired ones.

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
| `drafts/<hash>.json` | the Lead's drafted answer per attention key, shown on the card; removed after a day |
| `surface.json` | client-owned `{ "surface": "bubble" \| "docked" }`; the CLI never writes it, and clients treat a missing file as `docked` |

## Visibility

The Lead's own Claude session is not shown as an ordinary session. Rows whose cwd is under
`~/.agents/lead` (on any machine) or whose id is in a Lead's `session.json` carry `lead: true`,
and `agents ps`, `agents ps watch --json` and `agents feed watch --json` leave them out unless
`--include-lead` is passed; `feed watch` also drops their asks (attention items), including ones that
arrive after the reset. The session index is untouched, so `sessions` still lists and
searches a Lead's transcript.

## Settings

`lead.model` (user scope, central `agents.yaml`, default `sonnet`) is the model passed to
`agents run claude --model`. A running Lead keeps its model until `stop` or a rotation.

`lead.voice.bundle` (user scope, default `elevenlabs`) is the secrets bundle `ask --speak` reads
`ELEVENLABS_API_KEY` from.
