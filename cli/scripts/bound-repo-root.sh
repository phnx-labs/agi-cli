#!/usr/bin/env bash
set -euo pipefail

DIR="${1:?usage: bound-repo-root.sh <dir>}"
[[ -d "$DIR" ]] || { printf 'error: not a directory: %s\n' "$DIR" >&2; exit 1; }
cd "$DIR"

if [[ -e .git ]] && git rev-parse -q --verify HEAD >/dev/null 2>&1; then
  exit 0
fi

git init -q
git add -A
git -c user.email=agents@localhost -c user.name=agents \
    commit -q -m 'shipped tree' >/dev/null 2>&1 || true
