# Shared helpers for the release/test scripts in cli/scripts/. Source it by path
# relative to the caller, before any cd, so it resolves from any checkout or
# worktree. Pure bash (no dirname), so it still loads with an empty PATH:
#
#   _scripts_dir="${BASH_SOURCE[0]%/*}"; [[ "$_scripts_dir" != "${BASH_SOURCE[0]}" ]] || _scripts_dir=.
#   source "$_scripts_dir/lib/common.sh"
#
# Only for scripts executed from a real checkout. A script piped over
# `ssh … bash -s` has no file to source from and keeps its own helpers.
#
# die exits with $DIE_STATUS (default 1); a caller whose contract reserves a
# different failure code sets it before sourcing (release-lease.sh uses 2).

red()    { printf '\033[31m%s\033[0m\n' "$*" >&2; }
green()  { printf '\033[32m%s\033[0m\n' "$*"; }
yellow() { printf '\033[33m%s\033[0m\n' "$*"; }
gray()   { printf '\033[2m%s\033[0m\n'  "$*"; }
bold()   { printf '\033[1m%s\033[0m\n'  "$*"; }
die()    { red "error: $*"; exit "${DIE_STATUS:-1}"; }

file_sha256() {
  local f="$1"
  [[ -f "$f" ]] || die "not a file: $f"
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$f" | awk '{print $1}'
  else
    shasum -a 256 "$f" | awk '{print $1}'
  fi
}

str_sha256() {
  if command -v sha256sum >/dev/null 2>&1; then
    printf '%s' "$1" | sha256sum | awk '{print $1}'
  else
    printf '%s' "$1" | shasum -a 256 | awk '{print $1}'
  fi
}
