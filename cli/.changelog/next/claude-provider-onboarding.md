- **A setup-token (provider) Claude account no longer opens on Claude Code's first-run
  theme picker on a worker.** A provider account has no slot, so it runs in the
  executable's shared version home, and nothing ever marked that home onboarded: an AGI
  EXT tab dispatched to a worker landed on "Choose the text style…" instead of the agent.
  A credentialed Claude spawn on a non-headed device now seeds `hasCompletedOnboarding` in
  the home it runs in, right after the worker login-trap preflight in `spawnAgentLeased`
  (explicit `#account`, default account, balanced pick, interactive tmux). Headless paths
  that spawn elsewhere (`--loop`, routines) never show onboarding in print mode; the
  Windows `.cmd` shim passthrough is not covered. With no email the seed writes only the
  flag, so the home's own login identity is untouched; it writes through the
  `.claude/.claude.json -> ../.claude.json` link instead of replacing it; and a document
  already onboarded is left byte-identical. Source: `cli/src/lib/exec.ts`,
  `cli/src/lib/claude-account-token.ts`.
