#!/bin/bash
set -euo pipefail


REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
REPO_NAME="$(basename "$REPO_ROOT")"
TASK_ID="${TASK_ID:-$(date +%s)-$$}"

BOX_CLASS="${CRABBOX_CLASS:-cpx62}"

# Read the profile from .crabbox.yaml so we pick only boxes warmed for this repo, falling back to
# "default". `|| true` is required: under `set -e`, awk exiting non-zero on a missing file would
# abort before the fallback runs.
PROFILE="${CRABBOX_PROFILE:-$(awk '/^profile:/ {print $2; exit}' "$REPO_ROOT/.crabbox.yaml" 2>/dev/null || true)}"
PROFILE="${PROFILE:-default}"
export PROFILE

_scripts_dir="${BASH_SOURCE[0]%/*}"; [[ "$_scripts_dir" != "${BASH_SOURCE[0]}" ]] || _scripts_dir=.
source "$_scripts_dir/lib/common.sh"

command -v crabbox >/dev/null || die "crabbox not installed"

# Load credentials: prefer already-set env vars (CI path), else re-enter under chained `agents
# secrets exec` so bundle values ride the child env and never touch stdout (RUSH-2774). Each
# bundle is probed with a real resolve first, so a locked or absent bundle is skipped.
if [[ -z "${SANDBOX_SECRETS_EXEC:-}" ]] && command -v agents >/dev/null; then
  chain=()
  want=()
  [[ -z "${HCLOUD_TOKEN:-}" ]] && want+=(hetzner.com)
  [[ -z "${GITHUB_TOKEN:-}" && -z "${APP_ID:-}" ]] && want+=(github.com)
  [[ -z "${CLAUDE_CODE_OAUTH_TOKEN:-}" ]] && want+=(anthropic.com)
  for b in ${want[@]+"${want[@]}"}; do
    if agents secrets exec "$b" -- true 2>/dev/null; then chain+=(agents secrets exec "$b" --); fi
  done
  if [[ ${#chain[@]} -gt 0 ]]; then
    SANDBOX_SECRETS_EXEC=1 exec "${chain[@]}" "$0" "$@"
  fi
fi
[[ -n "${HCLOUD_TOKEN:-}" ]] || die "HCLOUD_TOKEN is empty after secret resolution"
export HCLOUD_TOKEN

# Generate a GitHub App token for private repo access, resolving the installation ID from a target
# repo so it works for a user or an org install. TOKEN_REPO (required) picks the installation.
generate_github_token() {
  [[ -n "${APP_ID:-}" && -n "${APP_PRIVATE_KEY:-}" ]] || return 1

  local target_repo="${TOKEN_REPO:?TOKEN_REPO must be set (e.g. owner/.agents) to pick the GitHub App installation}"
  local jwt installation_id token

  jwt=$(APP_PRIVATE_KEY="$APP_PRIVATE_KEY" /usr/bin/python3 -c "
import jwt, time, os
key = os.environ['APP_PRIVATE_KEY']
print(jwt.encode({'iat': int(time.time())-60, 'exp': int(time.time())+600, 'iss': '$APP_ID'}, key, 'RS256'))
" 2>/dev/null) || return 1

  installation_id=$(curl -sf \
    -H "Authorization: Bearer $jwt" \
    -H "Accept: application/vnd.github+json" \
    "https://api.github.com/repos/${target_repo}/installation" | \
    /usr/bin/python3 -c "import sys,json; print(json.load(sys.stdin).get('id',''))" 2>/dev/null)

  [[ -n "$installation_id" ]] || return 1

  token=$(curl -s -X POST \
    -H "Authorization: Bearer $jwt" \
    -H "Accept: application/vnd.github+json" \
    "https://api.github.com/app/installations/${installation_id}/access_tokens" | \
    /usr/bin/python3 -c "import sys,json; print(json.load(sys.stdin).get('token',''))" 2>/dev/null)

  [[ -n "$token" ]] && echo "$token"
}

PR_MODE=0
LINEAR_TICKET=""
POST_FILE="COMPLIANCE_AUDIT.md"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --pr) PR_MODE=1; shift ;;
    --linear) LINEAR_TICKET="$2"; shift 2 ;;
    --post-file) POST_FILE="$2"; shift 2 ;;
    --) shift; break ;;
    -*) die "unknown flag: $1" ;;
    *) break ;;
  esac
done

UPSTREAM="${UPSTREAM:-}"
REPO_SLUG=""
if [[ "$PR_MODE" == "1" ]]; then
  if [[ -z "$UPSTREAM" ]]; then
    UPSTREAM=$(git -C "$REPO_ROOT" remote get-url origin 2>/dev/null \
      | sed -E 's|^git@github.com:|https://github.com/|; s|\.git$||')
  fi
  [[ -n "$UPSTREAM" ]] || die "could not detect upstream origin in $REPO_ROOT (set UPSTREAM=... to override)"
  REPO_SLUG="${UPSTREAM#https://github.com/}"
  export TOKEN_REPO="$REPO_SLUG"
fi

if [[ -z "${GITHUB_TOKEN:-}" ]]; then
  GITHUB_TOKEN=$(generate_github_token || true)
fi
[[ -n "$GITHUB_TOKEN" ]] || echo "warn: no GITHUB_TOKEN available (private repos won't clone)" >&2

CLAUDE_CODE_OAUTH_TOKEN="${CLAUDE_CODE_OAUTH_TOKEN:-}"

# List the slugs of running boxes matching $PROFILE, oldest first. Box slugs are ephemeral, so
# always resolve by the stable `profile` label at run time, never a cached name.
running_slugs_for_profile() {
  crabbox list --json 2>/dev/null | /usr/bin/python3 -c "
import sys, json, os
profile = os.environ['PROFILE']
try:
    boxes = json.load(sys.stdin)
except Exception:
    sys.exit(0)
for b in boxes:
    if b.get('status') != 'running': continue
    if b.get('labels', {}).get('profile') != profile: continue
    slug = b.get('labels', {}).get('slug', '')
    if slug:
        print(slug)
" 2>/dev/null || true
}

# Return 0 if $1 is SSH-ready (`ready=true`). A box whose cloud-init failed still reports
# status=running but never becomes ready, and selecting it burns the ~2min SSH-wait before
# failing.
box_ready() {
  local slug="$1"
  [[ -n "$slug" ]] || return 1
  crabbox status --id "$slug" 2>/dev/null \
    | grep -qE '(^|[[:space:]])ready=true([[:space:]]|$)'
}

pick_ready_box() {
  local slug
  while IFS= read -r slug; do
    [[ -n "$slug" ]] || continue
    if box_ready "$slug"; then echo "$slug"; return 0; fi
  done < <(running_slugs_for_profile)
}

# Acquire an SSH-ready box for $PROFILE: reuse a ready one, else warm a fresh box and poll until
# ready. Never select or destroy a not-ready box; leave a dud lease to crabbox's idle timeout so
# concurrent runs and mid-boot boxes stay safe.
get_or_create_box() {
  local box_id waited
  box_id="$(pick_ready_box)"
  [[ -n "$box_id" ]] && { echo "$box_id"; return 0; }

  echo "No ready box for profile '$PROFILE', warming up (~60s)..." >&2
  crabbox warmup --class "$BOX_CLASS" --profile "$PROFILE" >/dev/null || die "crabbox warmup failed"

  waited=0
  while [[ $waited -lt 180 ]]; do
    box_id="$(pick_ready_box)"
    [[ -n "$box_id" ]] && { echo "$box_id"; return 0; }
    sleep 10
    waited=$((waited + 10))
  done
  die "warmed a box for profile '$PROFILE' but none became SSH-ready within 3m (check 'crabbox list' / 'crabbox status')"
}

bootstrap_remote() {
  cat <<'BOOTSTRAP'
set -euo pipefail

if ! command -v make &>/dev/null || ! command -v unzip &>/dev/null; then
  echo "Installing build-essential + unzip..."
  sudo apt-get update -qq && sudo apt-get install -y -qq build-essential unzip
fi

if ! command -v node &>/dev/null || ! node -e "process.exit(parseInt(process.versions.node.split('.')[0]) >= 20 ? 0 : 1)" 2>/dev/null; then
  echo "Installing nodejs 22 from NodeSource..."
  curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - >/dev/null 2>&1
  sudo apt-get install -y -qq nodejs
fi

if ! command -v bun &>/dev/null; then
  echo "Installing bun..."
  curl -fsSL https://bun.sh/install | bash
fi
export PATH="$HOME/.bun/bin:$PATH"

if ! command -v gh &>/dev/null; then
  echo "Installing gh..."
  sudo mkdir -p -m 755 /etc/apt/keyrings
  curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg | \
    sudo tee /etc/apt/keyrings/githubcli-archive-keyring.gpg >/dev/null
  sudo chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" | \
    sudo tee /etc/apt/sources.list.d/github-cli.list >/dev/null
  sudo apt-get update -qq && sudo apt-get install -y -qq gh
fi

git config --global user.email 2>/dev/null || git config --global user.email "ci@crabbox.local"
git config --global user.name 2>/dev/null || git config --global user.name "Crabbox CI"

if [[ -n "${GITHUB_TOKEN:-}" ]]; then
  git config --global --get-regexp '^url\.https://x-access-token:.*@github\.com/\.insteadof$' 2>/dev/null \
    | awk '{print $1}' \
    | sed 's/\.insteadof$//' \
    | sort -u \
    | while read -r section; do
        git config --global --remove-section "$section" 2>/dev/null || true
      done
  git config --global url."https://x-access-token:${GITHUB_TOKEN}@github.com/".insteadOf "git@github.com:"
  git config --global url."https://x-access-token:${GITHUB_TOKEN}@github.com/".insteadOf "https://github.com/"
  export GH_TOKEN="$GITHUB_TOKEN"
  echo "GitHub App token configured for private repos"
fi

if [[ "$PR_MODE" == "1" ]]; then
  if ! command -v agents &>/dev/null; then
    echo "Installing agents-cli..."
    sudo npm install -g @phnx-labs/agents-cli 2>/dev/null || true
  fi
  if command -v agents &>/dev/null; then
    if [[ ! -d ~/.agents/.system ]]; then
      echo "Setting up agents-cli..."
      agents setup 2>&1 | tail -3 || true
    fi
    export PATH="$HOME/.agents/.cache/shims:$PATH"
    if ! grep -q '\.agents/\.cache/shims' ~/.bashrc 2>/dev/null; then
      echo 'export PATH="$HOME/.agents/.cache/shims:$PATH"' >> ~/.bashrc
    fi
    if ! command -v claude &>/dev/null; then
      echo "Installing Claude Code via agents-cli..."
      agents add claude 2>&1 | tail -3 || true
    fi
  fi

  if [[ -n "${CLAUDE_CODE_OAUTH_TOKEN:-}" ]]; then
    echo "Claude Code OAuth token configured"
  fi
fi

echo "Bootstrap complete."
BOOTSTRAP
}

main() {
  local box_id cmd worktree_dir

  box_id=$(get_or_create_box)
  [[ -n "$box_id" ]] || die "Failed to get crabbox"

  echo "Using crabbox: $box_id (task: $TASK_ID)"

  # Verb vocabulary matching every sibling project. Baking in the canonical command stops each
  # caller composing its own, which is how build.sh and the attestation producer ended up running
  # the suite locally (RUSH-3178).
  local test_cmd='cd cli && bun install && bun run build && bun run test'
  case "${1:-}" in
    ''|test)
      cmd="$test_cmd"
      if [[ $# -gt 0 ]]; then shift; fi
      if [[ $# -gt 0 ]]; then
        # Quote each arg with %q rather than splicing "$*": the command string is re-parsed on the
        # remote box, so an arg with a space would be split. test.sh documents `-- <anything>` as
        # a general escape hatch.
        cmd="$cmd --"
        local a
        for a in "$@"; do cmd="$cmd $(printf '%q' "$a")"; done
      fi
      ;;
    verify)  cmd='echo "[sandbox] ready"; uname -srm; bun --version' ;;
    *)       cmd="$*" ;;
  esac

  workspace_dir="workspaces/${REPO_NAME}-${TASK_ID}"

  crabbox run --id "$box_id" --reclaim -- bash -c "
export GITHUB_TOKEN='${GITHUB_TOKEN:-}'
export CLAUDE_CODE_OAUTH_TOKEN='${CLAUDE_CODE_OAUTH_TOKEN:-}'
export PR_MODE='${PR_MODE}'
export UPSTREAM='${UPSTREAM:-}'
export REPO_SLUG='${REPO_SLUG:-}'
$(bootstrap_remote)

REPO_DIR=\"\$(pwd)\"
WORKSPACE_DIR=\"\$HOME/$workspace_dir\"

if [[ \"\$PR_MODE\" == \"1\" ]]; then
  # ---- PR mode: clone from GitHub via cached bare mirror ----
  [[ -n \"\$UPSTREAM\" && -n \"\$GITHUB_TOKEN\" ]] || { echo 'PR mode requires UPSTREAM and GITHUB_TOKEN' >&2; exit 1; }

  CACHE_DIR=\"\$HOME/.cache/git-cache\"
  CACHE_KEY=\$(echo -n \"\$UPSTREAM\" | sha256sum | cut -c1-12)
  MIRROR=\"\$CACHE_DIR/\$CACHE_KEY.git\"
  CLONE_URL=\"https://x-access-token:\${GITHUB_TOKEN}@github.com/\${REPO_SLUG}.git\"

  mkdir -p \"\$CACHE_DIR\"

  if [[ ! -d \"\$MIRROR\" ]]; then
    echo \"[mirror] cold clone: \$UPSTREAM\"
    t0=\$(date +%s)
    git clone --mirror \"\$CLONE_URL\" \"\$MIRROR\" 2>&1 | tail -3
    echo \"[mirror] cold clone took \$((\$(date +%s)-t0))s\"
  else
    echo \"[mirror] warm fetch\"
    t0=\$(date +%s)
    git -C \"\$MIRROR\" remote set-url origin \"\$CLONE_URL\"
    git -C \"\$MIRROR\" fetch --prune origin 2>&1 | tail -3
    echo \"[mirror] warm fetch took \$((\$(date +%s)-t0))s\"
  fi

  if [[ ! -d \"\$WORKSPACE_DIR/.git\" ]]; then
    echo \"[workspace] clone --reference\"
    rm -rf \"\$WORKSPACE_DIR\"
    mkdir -p \"\$(dirname \"\$WORKSPACE_DIR\")\"
    t0=\$(date +%s)
    git clone --reference \"\$MIRROR\" \"\$CLONE_URL\" \"\$WORKSPACE_DIR\"
    echo \"[workspace] clone took \$((\$(date +%s)-t0))s\"
  fi

  cd \"\$WORKSPACE_DIR\"
  git remote set-url origin \"\$CLONE_URL\"
  DEFAULT_BRANCH=\$(git symbolic-ref --short refs/remotes/origin/HEAD 2>/dev/null | sed 's|origin/||')
  [[ -n \"\$DEFAULT_BRANCH\" ]] || DEFAULT_BRANCH=main
  git fetch --prune origin \"\$DEFAULT_BRANCH\" 2>&1 | tail -1
  git reset --hard \"origin/\$DEFAULT_BRANCH\"
  git clean -fdx -e node_modules -e .bun
  git checkout -B \"task-${TASK_ID}\" \"origin/\$DEFAULT_BRANCH\"
  echo \"Working in: \$(pwd) on branch task-${TASK_ID} (base: \$DEFAULT_BRANCH)\"
else
  # ---- Test mode: rsync local tree, blank git for tests that need one ----
  mkdir -p \"\$WORKSPACE_DIR\"
  rsync -a --delete --exclude='node_modules' --exclude='.bun' \
    \"\$REPO_DIR/\" \"\$WORKSPACE_DIR/\"
  cd \"\$WORKSPACE_DIR\"
  if [[ ! -d .git ]]; then
    git init -q
    git add -A
    git commit -q -m 'initial' 2>/dev/null || true
  fi
  echo \"Working in: \$(pwd)\"
fi

echo \"--- Running: $cmd ---\"
$cmd
"

  if [[ -n "$LINEAR_TICKET" ]]; then
    echo "[linear] fetching $POST_FILE from box and posting to $LINEAR_TICKET"
    local tmp_post="/tmp/sandbox-post-${TASK_ID}.md"
    remote_relative_path="$workspace_dir/$POST_FILE"
    crabbox run --id "$box_id" --reclaim --capture-stdout "$tmp_post" -- \
      bash -c 'cat -- "$HOME/$1"' _ "$remote_relative_path" >/dev/null 2>&1
    if [[ -s "$tmp_post" ]]; then
      command -v linear >/dev/null && linear update "$LINEAR_TICKET" --comment "$(cat "$tmp_post")" \
        || echo "warn: linear CLI not installed; report saved at $tmp_post"
    else
      echo "warn: $POST_FILE not found on box at \$HOME/$remote_relative_path"
    fi
  fi
}

main "$@"
