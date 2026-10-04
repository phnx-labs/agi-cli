- **See CI and recently merged PRs in `agents projects prs`.** Every open PR row in
  `--json` now carries `ciState` (GitHub's rollup of the head commit) and
  `failingChecks`, and each repository adds `recentlyMerged` (PRs merged in the last
  7 days, with CI on the merge commit), `defaultBranch` (the default branch head and
  its CI), and `ciError`, so AGI Menu can show build health without opening a
  browser. Everything is read over REST, and a commit's CI is cached once all of its
  checks have finished, so a repeat run only re-reads what is still running. When a
  read fails, `ciError` says why instead of the menu showing "no checks". Shared
  monorepos scope merged PRs the same way as open ones. Source:
  `cli/src/lib/github/project-prs.ts`.
