- **Balanced and available rotation never pick an API-key account (owner decision 2026-10-12).**
  A provider account whose credential is an `api-key` or `bearer-token` (OpenRouter,
  an Anthropic or OpenAI API key, LiteLLM, a proxy) bills per token, yet it joined the
  automatic pool beside subscription logins (RUSH-3182). For example, `agents run claude`
  could land on `openrouter-primary` and run Claude through OpenRouter at API prices.
  Only a `setup-token` provider account now joins the pool, beside native logins.
  An api-key account still runs when named: `--account <name>`, a binding, or
  `agents accounts default`. A harness whose only accounts are API keys gets no
  automatic pick from them.
  Source: `cli/src/lib/accounting/account-pool.ts`, `cli/src/lib/accounting/account-pool.test.ts`,
  `cli/src/lib/accounting/account-pool-collect.test.ts`.
