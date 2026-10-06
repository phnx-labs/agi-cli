- **`agents projects prs merge` no longer refuses a PR whose mergeability GitHub
  never computed.** On some repositories `mergeable_state` stays `unknown` for
  hours, so the merge (and AGI Menu's Merge button) was never possible. An
  uncomputed state now goes on to the merge pinned to the reviewed head commit,
  and GitHub's own merge check decides: it merges, or refuses with its reason.
  `blocked`, `behind`, `dirty` and `draft` are still refused before any write.
  Source: `cli/src/lib/github/project-prs.ts`.
