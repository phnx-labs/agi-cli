- **A peer's fleet-state reply now arrives whole over ssh.** `agents __usage-ingest --reply`
  and `agents __usage-export` exited before stdout drained, so a reply larger than one pipe
  buffer was cut at 65,536 bytes and the dialing box logged "malformed JSON payload" for every
  peer. That left peer state stale, which blocked worker owner-notify tokens from minting. Both
  verbs now wait for stdout to flush before exiting. Source: `cli/src/lib/stdout.ts`.
