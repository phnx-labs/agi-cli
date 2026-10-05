#!/usr/bin/env bash
# janitor.sh: daily hygiene for ci-runner-fsn1 (root cron on-box): prunes docker cruft, stale
# runner workdirs, logs, packages; never touches runner registration. With CI_ROOT set (untrusted
# executor) it also sweeps finished run records older than a day, leaving active ones.
set -uo pipefail

log() { echo "[$(date -u +%FT%TZ)] $*"; }

CI_ROOT="${CI_ROOT:-/srv/ci}"

# 1. Docker: dangling images/containers/build cache older than 24h.
if command -v docker >/dev/null; then
  docker system prune -af --filter "until=24h" >/dev/null 2>&1 && log "docker pruned"
fi

# 2. Runner workdirs: delete job workspaces older than 7 days (runners clean
#    per-job, but killed jobs leak). Only inside _work dirs we own.
for d in /opt/actions-runner-*/_work /opt/actions-runner-phnx-*/_work; do
  [ -d "$d" ] || continue
  find "$d" -mindepth 1 -maxdepth 1 -mtime +7 -exec rm -rf {} + 2>/dev/null
done
log "workdirs swept"

# 3. Logs: journald capped at 500M.
journalctl --vacuum-size=500M >/dev/null 2>&1 && log "journal vacuumed"

# 4. Packages: security updates + autoremove (unattended-upgrades handles the
#    patching; this clears the residue).
apt-get autoremove -y >/dev/null 2>&1 && log "apt autoremoved"

# 5. Finished executor runs older than 1 day (never delete admitted/running).
if [ -d "$CI_ROOT/state/runs" ]; then
  now=$(date +%s)
  for f in "$CI_ROOT"/state/runs/*.json; do
    [ -f "$f" ] || continue
    python3 - "$f" "$now" "$CI_ROOT" <<'PY'
import json, os, sys, time
path, now, root = sys.argv[1], int(sys.argv[2]), sys.argv[3]
with open(path) as fh:
    rec = json.load(fh)
if rec.get("status") not in ("succeeded", "failed", "rejected"):
    raise SystemExit(0)
done = rec.get("timings", {}).get("reportedAtMs") or rec.get("timings", {}).get("enqueuedAtMs") or 0
if now - int(done) / 1000 < 86400:
    raise SystemExit(0)
os.remove(path)
result = rec.get("resultPath")
if result and result.startswith(root) and os.path.isdir(result):
    import shutil
    shutil.rmtree(result, ignore_errors=True)
print("swept", rec.get("runId"))
PY
  done
fi

# 6. Report disk.
df -h / | tail -1 | awk '{print "[janitor] disk: "$3" used of "$2" ("$5")"}'
