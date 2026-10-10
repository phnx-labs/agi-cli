- **The npm package no longer ships test fixtures.** `dist/**/testdata/**` (12 files, including the
  owner-notify fake API server) is excluded from the published tarball; nothing outside tests loads
  them. Source: `cli/package.json`.
