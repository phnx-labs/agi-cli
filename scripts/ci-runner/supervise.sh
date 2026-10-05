#!/usr/bin/env bash
# supervise.sh: health and self-heal for the shared CI runner box (ci-runner-fsn1) and the crabbox
# idle-reaper, run from launchd/cron on mac-mini. Per dead unit: restart over SSH, verify on
# GitHub, re-register. An unreachable box is reported, not rebuilt.
set -uo pipefail

BOX_IP="${CI_BOX_IP:-78.46.183.46}"
BOX_KEY="${CI_BOX_KEY:-$HOME/.ssh/ci-runner-ops}"
LOG_DIR="$HOME/.cache/infra-ci"
LOG="$LOG_DIR/supervise.log"
REAP_IDLE_SECS="${REAP_IDLE_SECS:-21600}"   # 6h
mkdir -p "$LOG_DIR"

log() { echo "[$(date -u +%FT%TZ)] $*" | tee -a "$LOG"; }
fail=0

box() { ssh -i "$BOX_KEY" -o BatchMode=yes -o IdentitiesOnly=yes -o ConnectTimeout=10 "root@$BOX_IP" "$@" 2>/dev/null; }

hcloud_token() {
  if [ -n "${HCLOUD_TOKEN:-}" ]; then echo "$HCLOUD_TOKEN"; return; fi
  if command -v agents >/dev/null && agents secrets exec hetzner.com -- bash -c 'echo -n "$HCLOUD_TOKEN"' 2>/dev/null | grep -q .; then
    agents secrets exec hetzner.com -- bash -c 'echo -n "$HCLOUD_TOKEN"' 2>/dev/null; return
  fi
  cat "$HOME/.config/infra-ci/hcloud-token" 2>/dev/null
}

# --- 1. box reachable ---------------------------------------------------------
if ! box 'true'; then
  log "FATAL box $BOX_IP unreachable over SSH — runners down; manual re-provision may be needed"
  exit 1
fi

# --- 2. runner units active + GitHub-side online ------------------------------
restart_unit() { box "systemctl restart '$1'" && log "heal: restarted $1"; }

for u in runner@1 runner@2 runner@3 runner@4 runner-phnx@1 runner-phnx@2; do
  state=$(box "systemctl is-active '$u'.service" || echo unknown)
  if [ "$state" != active ]; then
    log "WARN $u is $state — restarting"
    restart_unit "$u" || fail=1
  fi
done

# GitHub-side view: an org runner offline with an active unit means registration drift, so
# re-register the phnx units. Org endpoints need org admin; on 403 GitHub-side healing is skipped
# and unit-state checks carry the health signal.
GH_ORG_OK=1
gh api orgs/phnx-labs/actions/runners --jq '.runners | length' >/dev/null 2>&1 || GH_ORG_OK=0
[ "$GH_ORG_OK" = 0 ] && log "NOTE gh lacks org runner read (403) — GitHub-side checks/heals skipped; unit checks only"

phnx_offline=""
[ "$GH_ORG_OK" = 1 ] && phnx_offline=$(gh api orgs/phnx-labs/actions/runners \
  --jq '.runners[] | select(.name | startswith("ci-runner-fsn1-phnx")) | select(.status != "online") | .name' 2>/dev/null)
for name in $phnx_offline; do
  n=${name##*-}
  log "WARN $name offline on GitHub — re-registering runner-phnx@$n"
  tok=$(gh api -X POST orgs/phnx-labs/actions/runners/registration-token --jq .token 2>/dev/null) || tok=""
  if [ -n "$tok" ]; then
    box "D=/opt/actions-runner-phnx-$n; cd \$D && rm -f .runner .credentials .credentials_rsaparams && \
      sudo -u runner ./config.sh --url https://github.com/phnx-labs --token '$tok' \
      --name 'ci-runner-fsn1-phnx-$n' --labels 'self-hosted,linux,x64,crabbox-ci,tailnet' \
      --runnergroup crabbox-ci --work _work --unattended --replace >/dev/null 2>&1 && \
      systemctl restart runner-phnx@$n" && log "heal: re-registered $name" || { log "FAIL re-register $name"; fail=1; }
  else
    log "FAIL could not mint org registration token (gh auth?)"; fail=1
  fi
done

# --- 3. tailnet + win-mini reach from the box ---------------------------------
ts_ip=$(box 'tailscale ip -4 2>/dev/null' || true)
if [ -z "$ts_ip" ]; then
  log "WARN box is off the tailnet (win-e2e will fail: cannot reach win-mini)"
elif ! box 'ping -c1 -W3 win-mini >/dev/null 2>&1'; then
  log "WARN box tailnet up ($ts_ip) but win-mini unreachable (win-e2e will fail)"
fi

# --- 4. disk ------------------------------------------------------------------
disk=$(box "df --output=pcent / | tail -1 | tr -dc 0-9" || echo 0)
[ "${disk:-0}" -ge 85 ] && { log "WARN disk at ${disk}% — running janitor"; box /usr/local/bin/janitor.sh >/dev/null; }

# --- 5. crabbox idle-reaper ---------------------------------------------------
tok=$(hcloud_token || true)
if [ -n "$tok" ]; then
  now=$(date +%s)
  curl -sf -H "Authorization: Bearer $tok" "https://api.hetzner.cloud/v1/servers?per_page=50" \
  | python3 -c "
import sys, json
now = $now
for s in json.load(sys.stdin)['servers']:
    labels = s.get('labels', {})
    if labels.get('created_by') != 'crabbox':
        continue
    touched = int(labels.get('last_touched_at') or labels.get('created_at') or 0)
    idle = now - touched
    if idle > $REAP_IDLE_SECS:
        print(f'{s[\"id\"]} {s[\"name\"]} idle={idle//3600}h')
" | while read -r sid sname sidle; do
    log "reap: deleting $sname ($sidle)"
    curl -sf -X DELETE -H "Authorization: Bearer $tok" "https://api.hetzner.cloud/v1/servers/$sid" >/dev/null \
      && log "reap: deleted $sname" || { log "FAIL reap $sname"; fail=1; }
  done
else
  log "WARN no hcloud token (unlock hetzner.com or write ~/.config/infra-ci/hcloud-token) — reaper skipped"
fi

online="?"
[ "$GH_ORG_OK" = 1 ] && online=$(gh api orgs/phnx-labs/actions/runners --jq '[.runners[] | select(.status=="online")] | length' 2>/dev/null || echo '?')
log "summary: phnx runners online=$online disk=${disk}% tailnet=${ts_ip:-down} exit=$fail"
exit $fail
