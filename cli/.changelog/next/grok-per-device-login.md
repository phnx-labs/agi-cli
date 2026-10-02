- **Grok subscription seats log in per worker through the device-code flow.** `grok` now has the
  same `per-device:device-auth` worker path as `codex`: `agents accounts add grok <name> --per-device`
  registers the account with no API key, and `agents accounts login grok#<name> --per-device` on a
  worker runs `grok login --device-auth` into that account's slot. The box prints a URL and code
  that you approve in your own browser, so SuperGrok / X Premium+ seats run on workers without an
  `XAI_API_KEY`, which bills API credits rather than the subscription. `accounts login --per-device`
  is new and is the one login a worker may run for a dual-path harness (codex too); the plain
  re-login stays headed-only. Source: `cli/src/lib/harness-auth-capabilities.ts`,
  `cli/src/lib/accounts/add.ts`, `cli/src/commands/accounts.ts`.
