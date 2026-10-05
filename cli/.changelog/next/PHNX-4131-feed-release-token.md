- **Two processes can no longer both release the same feed answer claim.** The
  release token was created empty and filled a moment later, so a peer that read
  it in that gap judged it stale, deleted it, and released the claim a second
  time. The token is now written to a temp file and linked into place with its
  owner already inside, and a token whose owner cannot be read is aged by its
  file time instead of being treated as abandoned. Source: `cli/src/lib/feed/feed.ts`
  (`acquireReleaseToken`, PHNX-4131).
