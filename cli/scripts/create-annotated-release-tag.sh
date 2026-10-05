#!/usr/bin/env bash
set -euo pipefail

[[ $# -eq 2 || $# -eq 3 ]] || {
  echo "usage: create-annotated-release-tag.sh <version> <commit> [--force]" >&2
  exit 2
}

version="$1"
commit="$2"
force="${3:-}"
notes_path="cli/.changelog/${version}.md"

[[ -n "$version" && -n "$commit" ]] || {
  echo "error: create-annotated-release-tag.sh needs <version> <commit>" >&2
  exit 1
}
[[ -z "$force" || "$force" == "--force" ]] || {
  echo "error: unknown flag '$force' (expected --force or nothing)" >&2
  exit 2
}

commit="$(git rev-parse "$commit^{commit}")"
git cat-file -e "${commit}:${notes_path}" 2>/dev/null || notes_path="apps/cli/.changelog/${version}.md"
if ! notes_body="$(git show "${commit}:${notes_path}" 2>/dev/null)"; then
  echo "error: refusing to tag v${version}: ${commit:0:9} has no ${notes_path}" >&2
  exit 1
fi
[[ -n "$notes_body" ]] || {
  echo "error: refusing to tag v${version}: ${notes_path} is empty on ${commit:0:9}" >&2
  exit 1
}

msg="$(mktemp)"
trap 'rm -f "$msg"' EXIT
{
  printf 'Release %s\n\n' "$version"
  printf '%s\n' "$notes_body"
} > "$msg"

if [[ "$force" == "--force" ]]; then
  git tag -a -f "v${version}" -F "$msg" "$commit"
else
  git tag -a "v${version}" -F "$msg" "$commit"
fi
