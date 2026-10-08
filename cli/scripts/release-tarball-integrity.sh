#!/usr/bin/env bash
set -euo pipefail

die() { printf 'error: %s\n' "$*" >&2; exit 1; }

sri_for_file() {
  node -e 'const {createHash}=require("node:crypto"); const {readFileSync}=require("node:fs"); process.stdout.write("sha512-"+createHash("sha512").update(readFileSync(process.argv[1])).digest("base64"))' "$1"
}

case "${1:-}" in
  calculate)
    [[ -f "${2:-}" ]] || die "tarball not found: ${2:-unset}"
    sri_for_file "$2"
    ;;
  verify-sri)
    [[ -n "${2:-}" && -f "${3:-}" ]] || die "usage: release-tarball-integrity.sh verify-sri <sha512-SRI> <tarball>"
    actual="$(sri_for_file "$3")"
    [[ "$actual" == "$2" ]] || die "registry artifact integrity $2 != attested tarball integrity $actual"
    ;;
  verify-registry)
    [[ -n "${2:-}" && -n "${3:-}" && -f "${4:-}" ]] \
      || die "usage: release-tarball-integrity.sh verify-registry <package> <version> <tarball>"
    expected="$(npm view "$2@$3" dist.integrity 2>/dev/null)" \
      || die "could not read registry integrity for $2@$3"
    [[ "$expected" == sha512-* ]] || die "registry returned no sha512 integrity for $2@$3"
    "$0" verify-sri "$expected" "$4"
    ;;
  *) die "usage: release-tarball-integrity.sh <calculate|verify-sri|verify-registry> ..." ;;
esac
