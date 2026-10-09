# Installation and release architecture

Pinnable harness versions live in isolated homes behind stable shims. Resolution follows
project pin, user default, then a deterministic installed fallback. Isolated copies have
their own default namespace and cannot be accidentally adopted by later mutations.

Migration is one-way at installation time. Runtime consumers assume the current layout
and do not carry fallback reads for historical paths. Uninstall reverses adoption through
recoverable moves and restores the prior executable surface before removing managed data.

An ordinary agents-cli release starts with one branch push. `scripts/release.sh
<version> --apply` prepares a metadata-only commit on `release/<version>` and opens
its PR. The accepted forms are `release/x.y.z` and `release/x.y.z-pre.n`; the branch
name is the package version.

`.github/workflows/release.yml` is the only publisher. Its single GitHub-hosted job:

1. searches the full `main` ancestry for the newest retained attestation. When CLI
   executable inputs, packaged session-tracker, and impact policy are byte-identical,
   it inherits that suite result; otherwise it runs the current bounded impact plan
   across every change since the newest retained tested ancestor. Before either path,
   it rejects every diff outside `cli/**`, `apps/cli/**`,
   `packages/session-tracker/**`, `scripts/ci-scope.ts`, and the root `CHANGELOG.md`
   between that attested
   commit and the release head, including any `.github/**` change;
2. runs `release-attestation-produce.sh` in inherit or impact mode, then binds the
   passing result to the exact release tree;
3. builds and packs the exact release tree, then creates annotated tag `v<version>`
   and a GitHub release carrying `release-attestation.json` plus that tarball;
4. runs `release.sh --ci-publish`, which downloads those assets, verifies the tree
   and tarball digest, installs the tarball into a clean prefix, executes its version
   command, and publishes the same bytes to npm with provenance.

npm authentication is trusted publishing: the `npm-publish` environment job alone has
`id-token: write`, requires
npm 11.5.1 or newer, and carries no npm token. Stable versions publish on `latest`; `-pre.n`
versions publish on `next`, leaving CLI auto-update on the stable channel. The npm
package's Trusted Publisher record must name canonical repository `phnx-labs/agi-cli` and
workflow `release.yml`, scoped to environment `npm-publish`. That GitHub environment limits
deployment branches to `release/**` and requires its owner reviewer.

The job verifies that remote `release/<version>` still names the event commit before
tag/release creation and immediately before npm publication. A later push of the same
version branch therefore cannot publish the superseded workflow checkout.

The ordinary path builds only the CLI. Native helpers remain content-addressed,
independently released assets; no helper build, Apple signing, persistent host, or
second publisher participates.

Retry the canonical `scripts/release.sh <version> --apply` command after a partial
release. The release branch is immutable from its first push; the operator path
reruns the existing GitHub Actions job for that exact commit, and once `v<version>`
exists it additionally requires the tag and branch to match. An already-visible
npm version counts as success only when its registry sha512 integrity equals the
attested tarball.

Immediately before the first branch push, the operator path holds the repository's
release lease and re-checks current npm versions, tags, exact-shape release branches,
and canonical open PRs. A release that started or completed during local preparation
therefore invalidates the stale plan instead of racing another version onto `latest`.

Build, test, install, and release scripts are the entry points. They own stamping,
packaging, attestation, and clean-install verification; hand-rolled substitutes are
not equivalent.
