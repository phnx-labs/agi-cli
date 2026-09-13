- **`agents feed answer` is bounded, exactly-once, and truthful about delivery
  (PHNX-3999).** The AGI Menu abandons a reply at 30s; this path used to blow
  that budget and then report a fabricated receipt.
  - **Bounded.** The requested attention key names its session, so only that
    session is reconciled and the optional `gh pr view` enrichment runs only for
    a key whose generation is a PR review. Previously every active session was
    enriched — one 15s-bounded `gh` call each — *before* the key was compared.
    The whole operation now runs under one deadline, and a forwarded answer is
    raced against it directly rather than trusting the transport's own timer.
  - **Exact tokens across the hop.** A forwarded answer is POSIX-quoted with the
    canonical `shellQuote` and run through the canonical `sshExecAsync`, so a
    multiline answer or one carrying `$`, backticks, quotes or `;` arrives
    byte-identical instead of being re-parsed by the remote shell.
  - **Multiline free text.** A multiline answer is delivered into a tmux rail as
    one bracketed paste (`injectIntoTerminal`'s new `paste` option), so a TUI
    inserts it verbatim instead of submitting one line at a time. A rail that
    cannot carry the framing refuses *before* the claim is taken.
  - **A claim is no longer a resolution.** `recordAnswer` gains a two-phase
    `pending` mode: the claim locks the item but leaves the block `open` and
    writes no resolution tombstone, so an unconfirmed delivery can no longer make
    the request silently vanish from the feed. Only the AGENT's own
    acknowledgement resolves it — a `consumed`/`continued` receipt promotes the
    claim through `confirmAnswerResolution`, bound to the generation and attempt
    it was taken for, so a slow delivery cannot resolve the question the agent
    has since moved on to. A `queued` receipt never does.
  - **Truthful, typed outcomes for the operator UI.** `--json` now emits
    `status` (`delivered` / `already_answered` / `unknown` / `failed`),
    `delivery` (`receipt` / `unconfirmed` / `failed`), `resolved`, `host`,
    `attempt`, and the block's **real** `MessageReceipt` — never a synthesized
    one. `queued` is delivery, never resolution; `dropped`/`expired` read as
    failures rather than as the furthest-along success. A timeout, a truncated
    remote reply, or a partly-written keystroke sequence is `unknown` (the claim
    is kept, so a retry cannot double-send); only a provable non-delivery is
    `failed`.
  - **`agents feed answer <key> --check [--attempt <at>]`** is a new read-only
    reconciliation — the "check delivery" path for an unconfirmed answer. It
    never claims, routes or resends, and it is bound to the requested generation
    and attempt, so a stale card can never be resolved by the next question's
    receipt.
  - **Stranded claims reconcile.** A claim a kill left with no receipt is adopted
    and completed only on the mailbox rail, where the whole spool (inbox,
    processing and consumed) is scanned by block id so the answer is never
    enqueued twice, and only through a compare-and-swap so two retries cannot
    both adopt it.
