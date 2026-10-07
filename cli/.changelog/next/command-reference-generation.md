### Fixed

- Release commits now include the generated HTML command reference alongside the
  JSON and Markdown indexes. CI checks all three on release version bumps, help
  changes, and direct HTML edits. Regenerate with `scripts/generate-reference.sh`,
  use `--check` for a read-only freshness check, or `--out-dir` for a separate preview.
