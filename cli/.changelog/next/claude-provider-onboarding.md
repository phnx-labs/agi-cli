- **A setup-token (provider) Claude account no longer opens on Claude Code's first-run
  theme picker.** A provider account has no slot, so it runs in the executable's shared
  version home, and nothing ever marked that home onboarded: an AGI EXT tab dispatched to
  a worker landed on "Choose the text style…" instead of the agent. Every credentialed
  Claude spawn now seeds `hasCompletedOnboarding` in the home it runs in, right after the
  worker login-trap preflight in `spawnAgentLeased`, which every launch route (explicit
  `#account`, default, balanced pick, interactive tmux) passes through. With no email the
  seed writes only the flag, so the home's own login identity is untouched, and a document
  already onboarded is left byte-identical. Source: `cli/src/lib/exec.ts`,
  `cli/src/lib/claude-account-token.ts`.
