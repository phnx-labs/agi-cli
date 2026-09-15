- **`agents upgrade` works again on a bun-installed copy.** Every upgrade on a
  bun install failed at the install step with `error: An internal error occurred
  (DependencyLoop)` and left the CLI on the version it already had, because
  `bun add -g <tarball>` refuses to resolve a tarball whose package name is
  already pinned to an exact version in bun's global `package.json` — it keeps
  the old requirement alongside the tarball resolution and reports the package
  as depending on itself (bun 1.3.14). `installPackageWithBun` now clears that
  entry before the install and writes it back as the version actually on disk
  afterwards; the second half matters too, since bun otherwise records the
  tarball's path under the upgrade's temp directory, which is deleted on the way
  out and breaks the next `bun install -g`. An install that fails or is aborted
  puts the entry back, so a failed upgrade no longer leaves the CLI installed
  but unpinned — a state in which `bun remove -g` reports success and removes
  nothing. Neither `bun.lock` nor `trustedDependencies` is involved, and the
  npm install path is unchanged.
  Source: `cli/src/lib/self-update.ts`, `cli/src/lib/self-update.test.ts`.
