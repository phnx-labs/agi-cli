# Sessions and session history

A session is a harness-native conversation. agents-cli does not replace the harness's
transcript format; it discovers those transcripts and builds a normalized, searchable
history across harnesses and devices. The transcript remains durable truth. SQLite,
live-process state, summaries, and UI streams are derived views that can be rebuilt.

```mermaid
flowchart LR
  H1[Claude transcript] --> D[Discovery and parsers]
  H2[Codex transcript] --> D
  H3[Other harness transcripts] --> D
  D --> E[Normalized events]
  E --> I[(Session index)]
  E --> V[Rendered/redacted view]
  I --> Q[Search and filters]
  I --> W[Versioned watch stream]
  L[Live pid registry] --> W
  W --> UI[CLI, AGI EXT, menu bar]
```

## Two identities with different lifetimes

The durable session identifier belongs to the harness transcript. The live identity
maps a currently running process to the session it owns. Live identity is ephemeral and
machine-local; it disappears when the process exits. Harnesses reveal conversation IDs
at different points, so the launch ID is the cross-harness correlation seam during
startup rather than a fabricated universal session ID.

Two writers may contribute live identity: launch-time process registration and harness
hooks that learn the native ID. Readers reconcile them into one view. They must tolerate
arrival order without overwriting richer identity with an earlier partial record.

## History pipeline

Discovery locates harness-native transcripts and records their origin device, harness,
version, project, timestamps, and format. Parsers emit a shared event model for messages,
tool calls, results, usage, and lifecycle signals. The index stores searchable text and
metadata, not a second authoritative transcript.

Incremental scans append or enrich known sessions. Enrichment may fill missing actor,
lineage, cost, or resource-usage fields, but must not erase previously known provenance.
Schema migrations preserve the stable machine-readable envelope described in the
[normative session specification](specifications.md#sessions).

```mermaid
sequenceDiagram
  participant Harness
  participant Scanner
  participant Index
  participant Consumer
  Harness->>Harness: append native transcript
  Scanner->>Harness: discover changed content
  Scanner->>Index: upsert normalized events and metadata
  Index-->>Consumer: reset snapshot with stream version
  Index-->>Consumer: monotonic increments
  Note over Consumer: replace on reset; apply newer increments only
```

## Progress and attention

Session state describes progress, not merely whether a PID exists. Running work is
healthy. Waiting for explicit input, idle unfinished work, crashes, and orphaned remote
work require different recovery actions. Finished work is terminal and must remain
distinct from idle work; otherwise a quiet completed session and silently abandoned work
become indistinguishable.

The live registry contributes liveness, while transcript tails, execution records, and
explicit completion markers contribute progress. A reader that lacks one signal reports
degraded or unknown rather than manufacturing certainty.

Orphaned work — a live agent nobody is driving — is derived, not asserted, and centrally
folded (`foldHostLink` over the pure classifier in `host-link.ts`). An idle or
input-waiting session with no client attached becomes `orphaned` on any client loss. A
still-`running` agent is treated more conservatively: zero tmux clients is the normal
steady state for a detached remote pane (`agents run --device` wraps every remote
interactive run in a detached tmux session), so that alone never flags it. The one signal
that promotes a running agent is a LOST WINDOW — its owning IDE window stopped
republishing its heartbeat, so the host died uncleanly and the agent outlived it. That is
the genuinely-stranded case (a remote agent still alive after its laptop rebooted), and
`hostWindowLost` is the predicate that names it. Mere absence of a client is not a running
orphan; only a window that was there and is now gone.

## Cross-device history

Each transcript has an origin device. Fleet search unions indexed metadata without
pretending remote files are local. Detail reads, resume, migration, and export route to
the owning device through explicit transport. Migration transfers the conversation and
its provenance, then records the new origin; it does not create two independent owners.

Routing a read to the owner depends on the row naming the device the agent actually
runs on, and the box that *launched* a dispatched session is the one that gets this
wrong: it keeps a live shim process carrying the session's id, so the session looks
local there even though the conversation is on a peer. Process locality is not
transcript locality. A read therefore only stays local when this box can genuinely
answer for it — the transcript is on this disk, or the row names another device
outright. Otherwise the owner is recovered from the fleet's own view of who is
running what, and the read follows it. A session that is readable locally never
takes a needless hop, and an owner that cannot be reached is an error rather than an
empty local card.

## Off-box backup

`agents sessions export --to-r2` and `agents sessions import --from-r2` are
on-demand backup and restore operations. They do not enable the retired background
R2/CRDT sync cycle.

A signed-in Phoenix user gets the managed backend by default:

```bash
agents sessions export --since 30d --to-r2
agents sessions import --from-r2 --dry-run
agents sessions import --from-r2
```

No personal Cloudflare bucket or `r2.backups` bundle is required. The CLI encrypts
every transcript body locally with AES-256-GCM under a per-account data-encryption
key, and the managed Worker stores only encrypted bundle objects. The key is cached
locally with mode `0600` and escrowed in the account's bearer-protected namespace so
a fresh device signed in to the same Phoenix account can recover it.

That escrow defines the trust boundary: managed backup is confidential against a
raw R2/Cloudflare bucket read, but it is not zero-knowledge against Phoenix because
Phoenix-operated infrastructure can recover the escrowed key. Users who require a
key Phoenix cannot access can force their own bucket:

```bash
agents sessions export --since 30d --to-r2 --byo
agents sessions import --from-r2 --byo
```

The BYO path requires the `r2.backups` secrets bundle. Its `R2_SYNC_ENC_KEY` is the
shared restore key across the user's devices, and the existing
`sessions/<machine>/<agent>/<session>` object layout is unchanged.

The managed endpoint itself (`sessions.agents-cli.sh` — the Worker + R2 bucket) is
provisioned once, by an operator, with `agents sessions backup-setup` (Cloudflare
credentials from the `cloudflare` secrets bundle, e.g. `agents secrets exec
cloudflare -- agents sessions backup-setup`). It is idempotent — re-running
redeploys the current Worker template in place. This is NOT a per-user step: a
signed-in user backs up with zero setup; `backup-setup` is only how the first-party
endpoint is deployed. The BYO path never touches it.

## Derived capabilities

- Search and ranking operate over normalized messages and metadata. A keyword
  content query unions FTS5 hits with the listing page so an indexed transcript
  is returned even when it missed the default cwd/limit window. `--project`,
  `--agent`, and `--routine` still filter that union — a content hit in another
  project does not leak back in. The index covers both sides of the
  conversation: user prompts (`content`) and the agent's own answers
  (`assistant`, weighted lower in ranking), so a phrase that only ever
  appeared in what the agent said is still findable, not just what was asked.
  A `--json` content-search hit carries a short highlighted `snippet` excerpt
  from whichever column matched. `CONTENT_INDEX_VERSION` (`lib/session/db.ts`)
  gates re-extraction independently of file mtime/size, so a future content
  extractor improvement can backfill every already-indexed session on its next
  scan without a destructive reset.
- Each indexed session carries the genuine **full first user turn** as
  `firstUserMessage` — the verbatim originating request, captured at scan time
  and skipping harness-injected scaffolding. It is distinct from `topic` (a
  one-line distillation), `label` / an agent title, and the live row's cleaned
  `userPromptClean`, and it is emitted on `agents sessions --json` and on the
  `agents sessions watch --json` / `agents feed watch --json` streams. Grok
  recovers it via a bounded prefix read of `chat_history.jsonl` so the cheap
  summary-only scan does not open the full log. Its sibling **`lastUserMessage`**
  (schema v48) carries the LATEST genuine turn, which is the operative request of
  a `/continue`d, redirected, or interrupted-and-restated session — and is what
  the row title and the sidebar's Request card are derived from (PHNX-3939).
- Every session row also carries **`request`**, **`timeline`** and **`files`**
  (PHNX-3939). `request` is the latest genuine turn tidied but never rewritten —
  the user's prose joined verbatim, with screenshot / `host:/path` clip
  references and `@dir` mentions split into `attachments`, pasted terminal echo
  counted as `pastedLines`, and a `/name <id>` invocation kept as `command`.
  `timeline` is the narration-anchored step list: one step per line the agent
  SAID, with the tool calls under it folded into per-verb counts plus `failed`
  and `blocked`, and milestones (`worktree created`, `PR opened`); the last 8
  steps ride the row with an `earlier` counter for the rest. `files` is what the
  session created / modified / deleted, from the harness's own ledger where one
  exists. All three are computed by the daemon's reader-gated tick and cached in
  `session_timelines` — never on the request path. `agents sessions trace <id>
  --steps` prints the same fold as text, redacted by default like every other
  derived-label surface. A tool the operator cut short with Ctrl-C counts as
  `blocked`, not `failed`, alongside one a permission rule or hook denied.
  Every string the timeline ships is scrubbed where it is projected — secrets
  redacted (only `--no-redact` opts out) and terminal escapes always stripped —
  because the row is also published into the git-tracked fleet mirror
  (SES-54a).
- Rendering and sharing redact credential-shaped values and local identity by default.
- Export/import preserves provenance and stable IDs while treating indexes as rebuildable.
- Off-box backup (`sessions export --to-r2` / `import --from-r2`) is **managed-first**:
  a signed-in user backs up to the managed Phoenix store with no bucket to provision,
  every transcript body sealed under a mandatory per-account key that is escrowed for
  zero-setup cross-device recovery but is NOT hidden from Phoenix. `--byo` keeps the
  own-bucket, zero-knowledge path. It is a pure on-demand backup, never a background
  sync (SES-50, SES-51, SES-52).
- Insights and resource-usage analysis are projections; they never mutate transcripts.
- Execution records link to sessions when a conversation exists, but remain independently
queryable when a run failed before session creation.

Raw transcripts are private machine state and are never committed as documentation or
attached directly to public work.
