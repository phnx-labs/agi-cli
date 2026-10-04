- **See CI and recently merged PRs in `agents projects prs`.** Every open PR row in
  `--json` now carries `ciState` (GitHub's rollup of the head commit) and
  `failingChecks`, and each repository adds `recentlyMerged` (PRs merged in the last
  7 days, with CI on the merge commit), `defaultBranch` (the default branch head and
  its CI), `ciError`, and `truncated`, so AGI Menu can show build health without
  opening a browser. Everything is read over REST. A commit's CI is cached once all
  of its checks finished, for an hour when green and five minutes when red, so a
  re-run of a failed job shows up within five minutes. When a read fails, `ciError` says why instead of the
  menu showing "no checks", and `truncated` marks a merged list that hit its page
  cap. Shared monorepos scope merged PRs the same way as open ones. Source:
  `cli/src/lib/github/project-prs.ts`.
