- **Merge a blocked PR as an admin, or let it merge itself once checks pass.**
  `agents projects prs merge` now refuses a PR that is not mergeable as-is (blocked by
  branch protection, behind, or a state GitHub has not computed yet) unless `--admin`
  is passed; `--admin` lets a repository admin merge past branch
  protection where GitHub allows it, and is meant only for a person's explicit
  confirm (AGI Menu's "Confirm admin merge"). The fleet's `gh-merge-guard` denies it
  to agents. Refusals now read plainly: "Required check test hasn't passed", "The
  head moved since you looked". New `agents projects prs automerge` turns GitHub
  auto-merge on (pinned to the head you reviewed) or off with `--off`. `prs --json`
  gains `merge: { viewerIsAdmin, adminBypass, autoMergeAllowed, methods }` per
  repository and `autoMerge` per PR. `prs review --approve` on your own PR answers
  without calling GitHub. Source: `cli/src/lib/github/project-prs.ts`.
