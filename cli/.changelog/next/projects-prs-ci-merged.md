- **See CI and recently merged PRs in `agents projects prs`.** Every open PR row in
  `--json` now carries `ciState` (GitHub's rollup of the head commit) and
  `failingChecks`, and each repository adds `recentlyMerged` (PRs merged in the last
  7 days, with CI on the merge commit) and `defaultBranch` (the default branch head
  and its CI), so AGI Menu can show build health without opening a browser. The new
  fields come from one GraphQL query per repository; if it fails they read null or
  empty and the PR list itself is unaffected. Shared monorepos scope merged PRs the
  same way as open ones. Source: `cli/src/lib/github/project-prs.ts`.
