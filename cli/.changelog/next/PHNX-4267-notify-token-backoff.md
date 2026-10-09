- **A worker that keeps rejecting its owner-notify token is no longer re-minted every exchange.**
  After a worker reports three pushed device tokens unusable in a row, the minting box waits six
  hours before the next attempt and says so in its skip reason; the count resets once the worker
  reports a working token. Source: `cli/src/lib/owner-notify-tokens.ts`.
