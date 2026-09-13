<!-- guide -->
# Watchdog

The watchdog keeps AI coding agents moving. Agents are expected to drive their task
to completion, but they routinely **go idle** — announce a step and never take it,
finish a thought and stall, or ask themselves a question they could answer. Those
idle sessions surface nowhere and quietly waste time. The watchdog's job is to find
them, understand each one, and steer it to finish.

> Normative requirements (MUST/SHOULD, cited to `file:line`) live in
> [specifications.md#watchdog](specifications.md#watchdog). This doc is the how-it-works.

## Strategy: idle → completion

The single goal is **get idle agents moving to completion**. Everything else follows
from that one focus.

**Idle is the watchdog's territory; waiting is the feed's.** A session that explicitly
stopped on a question or a permission prompt (`waiting_input`) already surfaces in the
user's feed — the user can act on it there, so the watchdog leaves it alone. A session
that is merely **idle** — stopped with no prompt, nothing surfacing it — is the silent
tax the watchdog exists to remove. This division is why accurate status detection is the
watchdog's #1 dependency: it must reliably tell `idle` (its job) from `waiting_input`
(the feed's), `working` (leave alone), and completed (nothing to do).

## The loop

The watchdog is owned by the agents daemon, not a UI poller or cron routine. When
`watchdog.enabled` is true in this device's config, the daemon runs one bounded pass
every three minutes. `agents watchdog --nudge` remains the explicit one-shot command:

The human tick view is timestamped and attention-first. Each stalled/actionable row names
the session id and label/topic, agent, host app, machine, project, activity, start/activity
ages, cwd, latest preview, and decision reason. Healthy/non-actionable inspections are
summarized; pass `--verbose` to render every row or `--json` for the complete tick object.

1. **Detect idle.** Enumerate active sessions, classify each by transcript freshness and
   inferred activity (`lib/watchdog/read.ts`, `lib/session/state.ts`). A candidate is a
   session that is stalled (idle past `WATCHDOG_STALL_MS`, before `WATCHDOG_DORMANT_MS`,
   past its cooldown) — not `working`, not freshly `waiting` for the feed. Prioritize the
   ones active most recently: a warm session (last activity ~minutes ago) is the one worth
   steering.
2. **Analyze.** Collect every idle candidate with its originating task and transcript tail
   (`lib/watchdog/watchdogTail.ts`). There is no heuristic pre-filter guessing done-vs-stuck
   — the whole idle set goes to the agent.
3. **Drive it.** The agent judges each candidate in ONE `agents run --mode plan` call per
   tick (`makeWatchdogAgentDecider`, `lib/watchdog/watchdog-agent.ts`): idle-but-unfinished
   → NUDGE; idle-and-done or genuinely-needs-human → SKIP. It crafts the message
   (`WATCHDOG_SYSTEM_PROMPT`, `lib/watchdog/watchdog.ts`). A nudge is **help, not a shove**:
   it restates the goal, references the conclusion the agent already reached, and names the
   concrete next step — the exact action, a tool it forgot, or the sensible default. Never a
   generic "keep going."
4. **Escalate only genuine sign-off.** Credentials, a release/publish, an
   irreversible/outward-facing action, or a real product decision → left for the human
   (surfaced in the feed), never nudged.

## The brain

The decider is a real agent, not a heuristic script. Every idle session on the machine (its
task + tail) is judged in ONE `agents run <watchdog-workflow-or-agent> --mode plan` call per
tick (`makeWatchdogAgentDecider`, `lib/watchdog/watchdog-agent.ts`) — one bounded call for
the whole idle set, spawned only when something is actually idle, never one agent per
session. The prompt is `WATCHDOG_SYSTEM_PROMPT` (`lib/watchdog/watchdog.ts`); a user
playbook at `~/.agents/playbooks/watchdog.md` is appended as **House Rules**
(`composePromptWithPlaybook`) so per-fleet authorization norms ("rolling an
already-published version to my own fleet is authorized — proceed") tune the NUDGE/SKIP line
without editing the built-in prompt. If a `watchdog` workflow resolves (repo > user >
system), it runs by name so its WORKFLOW.md body + `model:` frontmatter apply; absent one,
the built-in prompt runs. Because the decision is one batched call spanning every idle
session (which may live in different projects), the workflow is resolved from the daemon's
own cwd — so the user/system-layer `watchdog` workflow applies fleet-wide, while a
project-layer override only takes effect when the daemon runs from that project.

Four rules govern a good nudge:

- **Read, don't guess.** Judge from the transcript (goal + recent reasoning), not a status
  field alone — an agent that already decided needs "do it," not "decide."
- **Carry context.** Restate the goal, reference what it already concluded, name the step.
- **Split the ask.** Drive the reversible, goal-advancing part; surface only the genuinely
  disruptive part — don't stall the whole task on one risky sub-step.
- **Point at the tool it forgot.** If a tool resolves the blocker, name it —
  `agents computer` (drive the local Mac), `agents ssh <mac> "agents computer …"` (drive a
  Mac from elsewhere), `agents browser` — instead of asking the human.

The rules that ban over-asking are already loaded in every agent's context and ignored
anyway (the model's deference reflex overrides explicit instruction). The watchdog is the
**enforcement** layer that the internal instruction cannot deliver — not a reminder.

## Delivery

A nudge is delivered into the exact terminal split the session lives in, resolved by the
single canonical resolver `resolveInjectTargetForSession` (`lib/terminal/resolve.ts`),
precedence `tmux > iterm > vscodium`, then injected by `injectIntoTerminal`
(`lib/terminal/inject.ts`). VSCodium/Cursor/VS Code integrated terminals are addressed via
the extension's `/inject` URI handler. When no addressable split exists the tick falls back
to a mailbox enqueue or a headless `--resume`, and refuses (flags for the menu-bar) only
when nothing can reach the session. `agents sessions inject` shares this same resolver, so
the manual unblock path and the watchdog agree.

**Confirmed delivery.** A nudge counts as landed — booked in the cooldown ledger and logged
`nudge` — only when delivery is confirmed. tmux / iterm self-confirm: a successful
`send-keys` / `write text` IS delivery (a bad pane or session id errors).
vscodium's `codium --open-url` is fire-and-forget — exiting 0 only means the editor accepted
the URL, not that the extension typed anything — so it is recorded `undelivered` (visible in
`agents watchdog history`) until the swarm-ext extension acks the verb. This ends the
phantom-nudge ledger, where a nudge the extension silently dropped was booked as delivered.

## Rotate (in-place, same tab)

A stalled session whose tail shows a **hard account limit** — "You've hit your weekly
limit · resets …", "usage limit reached", "out of credits" (`ROTATE_LIMIT_PATTERNS`,
`lib/watchdog/rotate.ts`) — cannot be un-stuck by a nudge: "Continue." cannot unspend a
capped account. The tick routes it to the **rotate** path instead:

1. **Detect.** `classifyTailForRotate` matches the transcript tail and parses the
   `resets <time>` clause when present (ISO, or claude's `7am (America/Los_Angeles)`
   time-of-day form).
2. **Gate (first-party).** Before touching the terminal, the tick runs the *same*
   selection `agents run auto` would — `collectHarnessCandidates` +
   `pickHarnessWeighted` (`lib/rotate.ts`, cache-only; no `agents view` subprocess, no
   Keychain probe). Zero healthy → ONE `rotate` skip event per cooldown window in
   `watchdog.log` (cooldown = `earliestResetAcross` from the candidates, else the parsed
   tail reset, else 30m) and the terminal is left untouched.
3. **Relaunch in place.** The harness's exit sequence (claude: `Esc, Ctrl+C, Ctrl+C`;
   codex/gemini/cursor/opencode: `Ctrl+C, Ctrl+C` — the table ported from the
   extension's prewarm configs) is injected as raw bytes into the resolved rail, then
   `agents run auto --interactive --session-id <uuid>` is typed into the **same tab**.
4. **Replay.** When the new session's TUI is live, the tick injects the resume replay:
   "Resume previous work by loading session \<old-id\>. Run `agents sessions <old-id>` …".
   Readiness is a transcript for the new session id (primary — a claude pick honors
   `--session-id`), with a **correlated** fallback for non-claude picks: a fresh active
   session counts only when it started after the rotate began AND shares the old
   session's cwd AND machine (`isCorrelatedRelaunch`) — an unrelated fresh session on a
   busy box never satisfies it. The readiness wait is bounded (60s default); on timeout
   the session is **flagged** and the machine stops — never blind-type into a dead shell.
   The flag says the terminal may sit at a bare shell and needs a manual
   `agents run auto`; a failed rotate is suppressed for 15m (`suppressUntilMs` in the
   state file) before the tick will retry it.

The machine spans ticks — the exit sequence kills the old session, so it drops out of
the active-session list before the new TUI is live — and persists at
`~/.agents/.cache/state/watchdog/rotate/<sessionId>.json` as
`exiting → launching → awaiting-tui → replaying → done | failed`. A post-loop sweep
advances in-flight rotates whose session left the active list. All rotate activity
(rotate start / done / failed / skip) is appended to the shared `watchdog.log` as
`rotate`-kind events, so the Fleet status card keeps working unchanged.

Rotate is **on by default**. `agents watchdog rotate on|off` writes `watchdog.rotate`
in `~/.agents/agents.yaml` (re-read per tick) and is rotate-only — nudging is
unaffected. Rotate obeys the same gates as a nudge: it acts only on a `--nudge`
tick, honors `handsoff` (flag, never rotate), and requires the same addressable-rail
safety gate — an un-addressable terminal is flagged, never rotated blind.
`agents watchdog status` (`--json`) reports the rotate config and every persisted
rotate state.

## Audit history

`agents watchdog history [sessionId]` shows every session inspection plus persisted
decisions, nudges, rotates, and errors newest-first. Use `--since 24h`, `--limit 100`, or `--all` to include heartbeat
ticks; `--json` provides the same filtered records for scripts. Raw transcript tails and
message excerpts are never returned by this command. The optional session id accepts a
full id or prefix.

## Fleet model

The watchdog reads the **whole fleet** (`agents sessions --active --json` fans out to every
device, status computed on each origin host) but delivers **locally** on each session's
origin box, where injection is reliable. Enable it per host with
`agents watchdog enable|disable`; this writes the device-local `watchdog.enabled` setting under
`~/.agents/devices/<hostname>/agents.yaml`. The menu bar only renders the daemon's
persisted result and never executes a pass.

## Per-session policy

`agents watchdog policy <id> off|keep|handsoff` — `off` excludes a session entirely;
`handsoff` detects and flags it but never delivers; `keep` (default) is the normal path.

## File map

| File | Role |
|---|---|
| `lib/daemon/daemon.ts` | Sole automatic scheduler: one non-overlapping pass every three minutes. |
| `lib/watchdog/runner.ts` | One tick: enumerate → classify → decide (batched agent) → deliver (confirmed) → log. |
| `lib/watchdog/watchdog-agent.ts` | The agent decider: batches every idle candidate into ONE `agents run --mode plan` call, maps verdicts by terminalId. |
| `lib/watchdog/watchdog.ts` | `WATCHDOG_SYSTEM_PROMPT`, playbook composition, prompt render, response parse. |
| `lib/watchdog/read.ts` | Locate a transcript and read its tail; stall thresholds. |
| `lib/watchdog/watchdogTail.ts` | Summarize a tail into last-user / last-assistant for the brain + log. |
| `lib/watchdog/rotate.ts` | In-place rotate: limit detection, exit-sequence table, state machine, health gate. |
| `lib/watchdog/log.ts`, `history.ts` | Persist, parse, and safely select the Watchdog audit history. |
| `commands/watchdog.ts` | `agents watchdog` — timestamped attention view, `--verbose`, `on`/`off`/`status`/`history`/`policy`/`--nudge`/`--watch`. |
| `lib/session/state.ts`, `active.ts` | Status inference (`working`/`waiting_input`/`idle`) the watchdog reads. |
| `lib/terminal/resolve.ts`, `inject.ts` | Resolve the exact split and deliver the nudge. |

## Roadmap

The strategy is landing in stages. Shipped: idle detection, version-home-safe transcript
resolution, the unified inject resolver, and the context-carrying/tool-pointing brain
prompt. Planned: seeding the brain with the full fleet snapshot as its starting context; a
distinct `done` state (so a finished session is never confused with idle); status coverage
for non-Claude/Codex harnesses; and the shipped default `watchdog/WORKFLOW.md` decider.
