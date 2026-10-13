- **A setup-token session no longer credits its rate limits to the login whose home it runs in.**
  `agents run claude --strategy balanced` on a box whose native login was at 100% kept
  picking that login. A session launched with a provider account (`--account <setup-token>`,
  or balanced picking it) runs inside the native login's version home, and the Claude status
  line read the account from that home, so it wrote the token account's headroom (session 31%,
  week 3%) over the poll's 100%/56% under the native login's usage key. Each write made the
  limited login look healthy again until the next poll, and the run died with "You've hit
  your session limit". The status line now resolves the account from `AGENTS_RUN_ACCOUNT_ID`:
  a provider account's limits land under its own key (`claude:name=<account>`), a native
  login keeps its identity, and an id that matches neither writes nothing. Balanced and
  available rotation read that key, so a limited token account is excluded like a limited
  login instead of being a permanently blind pick; a balanced provider pick now also passes
  its account id to the session, and the pick banner names the provider account (`balanced
  picked turing-token · claude@2.1.260`) instead of only the harness version. Source: `cli/src/lib/claude-statusline.ts`,
  `cli/src/lib/accounting/account-pool-collect.ts`, `cli/src/lib/accounting/account-pool.ts`,
  `cli/src/commands/exec.ts`.
