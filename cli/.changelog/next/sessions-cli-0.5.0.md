- **Session titles no longer show the injected credentials catalog.** The transcript
  reader moves to `@phnx-labs/sessions-cli` 0.5.0, which treats the SessionStart
  `## Credentials you can reach` block as injected context like `## Host & Fleet`, so a
  harness that records hook output as a user turn (Codex) keeps the real first prompt as
  its topic. Source: `cli/package.json`.
