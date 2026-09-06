# Observability

Observability is a set of projections over owned stores, not a second source of truth.

- Events are the unified operational and activity timeline.
- Sessions are conversations and live process identity.
- Feed is the operator attention ledger plus deliberate progress posts.
- Performance is a disposable latency warehouse.
- Insights derive behavioral and usage aggregates.
- Cost/output join token burn to durable delivery evidence.
- Doctor compares declared, installed, authenticated, and synchronized state.

Every event is stamped with machine, transport, caller, session, and resolved actor when
known. Provenance travels across child processes and SSH so a remote execution is not
misattributed to the shared machine account.

Attention is an explicit lifecycle. Resolution tombstones are recorded before an open
block clears, preventing stale session reads from resurrecting answered asks. The CLI
publishes one versioned stream; thin clients replace state on reset and apply monotonic
increments.

## Feed broadcast routing

`agents feed post` records the complete event first, then mirrors it through the
named sinks under `feed.broadcast` in `agents.yaml`. A sink is either a direct
argv template (`command:`) or an in-process provider delivery (`channel:`). Both
shapes use post context rather than asking the agent to repeat domain facts: the
session index supplies `{ticket}` and `{ticket_url}`, and the raw `{ticket_url}` /
`{links}` scalars stay available for a custom `message:` template to place itself,
while `{message}` is the compact human-facing title, body, provenance, and a
`Sent from …` footer — with the session crumb and any named ticket key surfaced as
inline links only on a sink that can render them (see below). `{message}` no longer
dumps a raw ticket or attachment URL on any sink.

`{message}` is built to be **tappable — and only where a destination can render a
link** (PHNX-3698). The two references an owner cares about (the session crumb and
every ticket key) surface as **inline labeled links** on a destination that renders
them, and as plain text — never a dumped URL — on one that doesn't. `{message}` is
one logical post; the *format* is decided **per destination**, keyed on the
destination's **resolved provider** (`sinkMessageFormat` in `sink-format.ts`, the
same `notify.transports` remap delivery uses), and the body is re-rendered in that
format. This is a per-destination decision, not a per-sink one: the owner policy
fan-out (`sendToOwner`) resolves each channel in `owner.policy.normal`
independently, so a policy listing both iMessage and Slack sends plain to iMessage
and the labeled-link variant to Slack from the one post.

- **Any destination that resolves to the Slack provider gets mrkdwn labeled
  links** — a direct Slack `channel:` sink, *and* a Slack channel in the owner
  policy. Slack renders `<url|label>` as blue tappable text, so the composer turns
  each reference into a labeled link **in place**:
  - The `Sent from claude/6fc1db18 on zion` footer keeps its human sentence, but
    the crumb `claude/6fc1db18` becomes
    `<https://prix.dev/console/sessions/<full-id>|claude/6fc1db18>` — it reads the
    same and taps through to the owner-view console page.
  - Every `TEAM-N` key the title or body *names* — not just the session's own
    `ticketId` — becomes `<https://linear.app/<workspace>/issue/<KEY>|<KEY>>` where
    the key stands (deduped, workspace resolved config-first, unit strings like
    `UTF-8` denylisted). So a ping that only mentions `PHNX-3689` in prose, with no
    `session.ticketId` on the row, is still tappable.
  - There is **never a trailing URL line** — every link is inline (footer crumb,
    prose key).
- **iMessage, owner-scoped rush, `command:`, desktop, and every other channel stay
  plain.** They cannot render a labeled link, and a dumped naked URL reads as
  noise, so the message is the human sentence with **no URLs** — the crumb and
  ticket keys stay as text. An 8-char footer crumb whose full id can't resolve
  never becomes a link on any sink.

The **only** links `{message}` surfaces are the two the owner's directive names —
the session crumb and every ticket key the prose spells out. An **attached** URL
(a post's PR/plan link, `ctx.links`) and a session's own `ticketUrl` when the prose
never names its key are deliberately **not** surfaced, on any sink, because the
owner's rule is "never a trailing URL line" and neither has an inline anchor to
attach to. On a Slack sink the crumb already taps through to the console session
page, which carries that PR/ticket context — so the link is one tap away, not lost.
A custom `message:` template that wants an attached URL in a specific channel can
still place the raw `{ticket_url}` / `{links}` scalar itself. (Rendering attached
links as their own Slack labeled links is a possible future enhancement tracked in
PHNX-3708, pending owner sign-off, since it reintroduces a trailing line the
current directive forbids.)

An **important** post (and every `--blocked` post) also fires a best-effort,
opt-in `agents traces sync` in the background so that console page exists when the
owner taps a Slack crumb — trace sync otherwise only runs on `agents run` exit
(PHNX-3628), which a mid-run ping precedes. The sync is gated exactly like the
run-exit arm (signed in and already opted into the store; `AGENTS_NO_TRACE_SYNC=1`
opts out) and never blocks or fails the post.

`agents notify` and `agents send --to owner` deliver through this **same**
composer, so an owner ping is identical to an important `feed post` of the same
event — short-shaped body with a `Sent from …` footer — instead of the raw body
dump they sent before. The owner fan-out re-renders that body **per destination**
(`ownerMessageComposer` → `sendToOwner`, PHNX-3698): an iMessage/rush owner channel
keeps its keys and crumb as plain text, while a Slack owner channel gets the same
mrkdwn labeled links a direct Slack sink does — the two destinations of one policy
get two different bodies from the one ping. A non-owner `agents send` (explicit
`--channel`/`--to`) is delivered verbatim.

Channel sinks may set `message:` to customize their outbound body. It supports
the same placeholders as command sinks. If any referenced value is absent, the
sink is skipped instead of delivering a malformed message. That makes the
template itself a routing declaration:

```yaml
feed:
  broadcast:
    owner:
      channel: owner
      minLevel: important
    engineering:
      channel: slack
      to: C01234567
      minLevel: important
      message: "{message}"
```

To restrict the engineering sink to ticket-backed posts, set its template to
`"{ticket_url}"` or otherwise reference `{ticket}` / `{ticket_url}`; fail-closed
placeholder rendering skips ticketless posts. Canonical Linear URL construction
is shared product behavior, while the Slack destination remains operator
configuration.

## Performance latency warehouse

Performance is a disposable SQLite warehouse at `~/.agents/.cache/perf/perf.db`
(safe to delete). Timers emit a `perf.timing` sample carrying the total duration
plus a `phases` map of named sub-phase marks; `agent.run` records a `startup`
phase — wall time from entering `spawnAgent` to the child actually spawning, i.e.
the boot cost — so a slow launch is attributable independently of the total run.
The phases ride each sample's `meta_json`, and `aggregateSamples` folds them into
a per-label `phases` break-out (p50/p90 over the samples that carried each phase).

`agents insights perf run` shows the rollup and renders each phase as an indented
sub-line under its label:

```
agent.run    412   1.3s   2.9s   3.1s   1.6s   3.2s
  └ startup: p50 63ms  p90 105ms  (n=412)
```

This is the tracked signal for boot performance (PHNX-3468): the total run is
dominated by the agent's own work, so the `startup` percentiles are what a boot
regression moves. A sample with no phase mark still counts toward the label total;
only samples carrying the phase contribute to its `n`.

## Account and usage projections

Authentication health and quota are separate signals with separate freshness. Provider
collectors normalize quota into stable window slots; unavailable evidence renders as
unavailable rather than as zero usage.

Claude quota is event-fed rather than polled. Claude Code sends native five-hour and
seven-day rate-limit fields to the managed status-line command after an inference
response. Ingestion merges whichever windows arrived into the previous per-account
snapshot, so one omitted window does not erase the other. No interactive OAuth or
Keychain credential is copied or read to populate usage.

Grok quota is also event-fed: Grok writes its current weekly billing meter to the
shared real home `~/.grok/logs/unified.jsonl` (not the version home). The daemon or an
explicit `view --refresh` publishes that derived snapshot, attributed only to the Grok
identity that owns `~/.grok` — a version home whose own `auth.json` matches the shared
login, or a home that is the real home itself. Other version-scoped Grok identities
with no per-version log stay as no-recent-usage rather than inheriting that meter.
Agents-cli never invokes an upstream Grok usage API. When the latest billing period has
expired, the row still shows the last-known percentage with a "period ended" age; a
numberless `run grok@version once` hint is reserved for identities with no reading at
all.

Managed Cursor versions select Cursor's file credential store under their isolated
`XDG_CONFIG_HOME`. Cursor's machine-global macOS Keychain login is not imported or
deleted; a managed version without `auth.json` is signed out until Cursor's native login
flow authenticates that version. Usage uses the same version-local access token as the
run, so account identity and quota cannot silently refer to different logins.

Identity and plan come from version-home state. The human-facing account row exposes one
last-active timestamp; probe age remains machine-readable health metadata rather than a
second activity timestamp.

Health findings use one severity registry and one remediation vocabulary. A finding must
name a command that fixes the full scope represented by its row. Unavailable evidence is
reported as unknown or degraded, never healthy by default.

**Severity rubric** — `FINDING_SEVERITY` in `src/lib/devices/doctor-findings.ts` is the
single source of truth; this prose copy is pinned to it by a test, so the two cannot
drift.

**CRITICAL** — needs you now: `logged-out`, `missing-hook`, `missing-plugin`,
`unwired-hook`, `hook-runtime-broken`, `cli-missing`, `owner-sink-unreachable`,
`ssh-key-enrollment`.

**WARNING** — worth fixing, not urgent: `logout-unprovable`,
`hook-runtime-visibility-unavailable`, `missing-resource`, `content-drift`,
`never-synced`, `stale`, `repo-behind`, `repo-drift`, `fleet-resource-gap`,
`version-skew`, `orphan`, `duplicate-hook`, `duplicate-hook-drift`, `host-cli-missing`,
`host-cli-invalid`, `rc-secret-export`, `env-secret-export`, `auth-bundle-wrong-backend`, `exec-policy`, `stale-cli`,
`binary-shadow`, `leaked-daemon`.

The split is provability and blast radius: a critical is something the operator can act
on right now with a known fix, while a warning is drift that one sweep resolves.
