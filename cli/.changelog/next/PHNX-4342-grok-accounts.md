- **A Grok account with no balance left reads as out of credits (PHNX-4342).** When xAI
  refuses a turn with `402 Payment Required: Grok Build usage balance exhausted`, that
  account now shows `out of credits` for one hour, and rotation and `--device auto` skip
  it instead of choosing it again. Before this, Grok usage came only from the last
  `billing: fetched credits config` log line, which could be days old, so an exhausted
  account still read as ready. A credits fetch logged after the 402 clears it sooner.
  Source: `cli/src/lib/accounting/usage.ts`.
- **A Grok, Kimi or Muse version with no login of its own reads as signed out.** The
  launcher points these harnesses at their version home (`GROK_HOME`, `KIMI_CODE_HOME`,
  XDG), so they never read the shared `~/.grok` or `~/.kimi-code` login. The account
  check did read it, and listed a version as signed in with that account while the
  harness itself said `Not signed in`. Cursor, Droid and Antigravity keep their
  shared-home lookup. Source: `cli/src/lib/agent-spec/agents.ts`.
