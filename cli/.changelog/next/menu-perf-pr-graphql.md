- **`agents projects prs` reads open PRs in one GraphQL query per repository or owner.**
  The project read and the all-orgs read behind AGI Menu's GitHub tab used to read each
  open PR three more times (`pulls/{n}`, check-runs, status), one `gh` process per call.
  Each page of 100 PRs now carries the head, merge state and check rollup for 2 GraphQL
  points: a 102-PR repository reads in about 7 s instead of 40 s, and the all-orgs read
  of 203 PRs (97.9 s and 39 CPU-seconds before) no longer starts a process per PR. The
  JSON envelopes are unchanged. Source: `cli/src/lib/github/project-prs.ts`,
  `cli/src/lib/github/open-prs.ts`.
