- **An `out of credits` mark no longer strands a Claude account for good.** A run
  refused with "You've hit your monthly spend limit" or "out of usage credits"
  writes a per-account `out_of_credits` mark in `~/.agents/.cache/claude-usage.json`,
  and rotation (`balanced`, `available`) skips a marked account. The mark had no
  expiry, and its only clear was a successful run on that account, which rotation
  never launches. On one box three of four Claude accounts sat marked for up to 14
  days while answering fine, and every `agents run claude` landed on the one login
  that was actually refusing. The mark now records when it was noted and expires
  after one hour (`OUT_OF_CREDITS_REPROBE_MS`), so rotation tries the account again;
  a fresh refusal re-marks it. A mark written by an older CLI reads as expired.
  `agents view` shows `out of credits` only while the mark is live.
  Source: `cli/src/lib/accounting/usage.ts`, `cli/src/lib/accounting/usage.test.ts`.
