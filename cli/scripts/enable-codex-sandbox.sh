#!/usr/bin/env bash
set -euo pipefail

SYSCTL_KNOB="kernel.apparmor_restrict_unprivileged_userns"
SYSCTL_PROC="/proc/sys/kernel/apparmor_restrict_unprivileged_userns"
DROPIN="/etc/sysctl.d/60-codex-userns.conf"

CHECK_ONLY=0
[[ "${1:-}" == "--check" ]] && CHECK_ONLY=1

if [[ "$(uname -s)" != "Linux" ]]; then
  echo "not Linux -- codex uses no bwrap/userns sandbox here; nothing to do."
  exit 0
fi

probe_userns() {
  if ! command -v unshare >/dev/null 2>&1; then
    return 2
  fi
  unshare --user --map-root-user true >/dev/null 2>&1
}

report() {
  local knob="absent"
  [[ -r "$SYSCTL_PROC" ]] && knob="$(cat "$SYSCTL_PROC" 2>/dev/null || echo '?')"
  echo "  ${SYSCTL_KNOB} = ${knob}"
  if probe_userns; then
    echo "  userns probe          = OK (codex's sandbox can start here)"
    return 0
  else
    local rc=$?
    if [[ $rc -eq 2 ]]; then
      echo "  userns probe          = unknown (\`unshare\` not installed)"
    else
      echo "  userns probe          = DENIED (codex's bwrap sandbox will fail)"
    fi
    return 1
  fi
}

echo "codex Linux sandbox (userns) status on $(hostname -s 2>/dev/null || hostname):"
if report; then
  echo "Already good -- codex's sandbox can start. Nothing to change."
  exit 0
fi

if [[ $CHECK_ONLY -eq 1 ]]; then
  echo
  echo "Restricted. Re-run WITHOUT --check as root to fix:"
  echo "  sudo bash cli/scripts/enable-codex-sandbox.sh"
  exit 1
fi

if [[ "$(id -u)" -ne 0 ]]; then
  echo
  echo "error: applying the fix needs root. Re-run:  sudo bash $0" >&2
  exit 1
fi

echo
echo "Applying: ${SYSCTL_KNOB}=0 via ${DROPIN}"
printf '# Managed by agents-cli enable-codex-sandbox.sh (PHNX-3285).\n# Re-enables unprivileged user namespaces so codex workspace-write sandbox works.\n%s=0\n' \
  "$SYSCTL_KNOB" > "$DROPIN"
sysctl -w "${SYSCTL_KNOB}=0" >/dev/null

echo "Verifying..."
if report; then
  echo "Done -- codex's workspace-write sandbox now works on this box."
  exit 0
fi

echo >&2
echo "FAILED: the knob was set but userns is still denied." >&2
echo "This box may enforce userns via an AppArmor policy the sysctl alone does not lift." >&2
echo "Inspect: aa-status; and any /etc/apparmor.d profile mediating this binary." >&2
exit 1
