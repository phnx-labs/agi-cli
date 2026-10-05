#!/usr/bin/env bash
# Give a shipped tree its own git repo. Mirrors sandbox.sh's "blank git" for the crabbox path. The
# tree now ships to `~/.cache/agents-cli/test-runs/tree` with no git ancestor, so the escape is
# structurally impossible; only the compatibility need remains.
set -euo pipefail

DIR="${1:?usage: bound-repo-root.sh <dir>}"
[[ -d "$DIR" ]] || { printf 'error: not a directory: %s\n' "$DIR" >&2; exit 1; }
cd "$DIR"

# Gate on HEAD resolving and `-e .git` first: `git rev-parse --verify HEAD` walks up through
# parents like `--show-toplevel`, so on a fresh worker the ancestor's HEAD (`~/.agents` is a
# committed repo) would satisfy it and the script would do nothing.
if [[ -e .git ]] && git rev-parse -q --verify HEAD >/dev/null 2>&1; then
  exit 0
fi

# `git init` and `git add` are not wrapped in `|| true`: a failure means the root is still
# unbounded and swallowing it would silently restore the original bug. Only the commit tolerates
# failure (an empty tree has nothing to commit; the repo still bounds the walk).
git init -q
git add -A
# Identity via `-c`, never written to the box's config: a worker generally has
# no git identity, and without one the commit fails and leaves an unborn HEAD.
git -c user.email=agents@localhost -c user.name=agents \
    commit -q -m 'shipped tree' >/dev/null 2>&1 || true
