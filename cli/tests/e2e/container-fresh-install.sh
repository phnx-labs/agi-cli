#!/usr/bin/env bash
# Runs inside a fresh node:24 container, replaying issues #112/#137: a user with existing Claude
# Code and Codex configs installs agents-cli, adopts both agents, and triggers the launch-time
# factory sync. Asserts no user setting is lost.
set -euo pipefail

fail() { echo "FAIL: $1" >&2; exit 1; }
step() { echo; echo "==> $1"; }

# ---------------------------------------------------------------------------
# 1. Seed pre-existing user config (what Emanuele had before installing us)
# ---------------------------------------------------------------------------
step "Seed unmanaged ~/.claude and ~/.codex"

mkdir -p ~/.claude
cat > ~/.claude/settings.json <<'JSON'
{
  "env": { "FOO": "bar", "DEBUG": "true" },
  "permissions": { "allow": ["Bash(npm *)"], "deny": ["Bash(rm -rf *)"] },
  "hooks": {
    "PreToolUse": [
      { "matcher": "Bash", "hooks": [{ "type": "command", "command": "echo guard" }] }
    ]
  },
  "mcpServers": { "fooServer": { "command": "/bin/foo", "args": ["--bar"] } },
  "customKey": { "nested": "preserved" }
}
JSON
echo "# my global rules" > ~/.claude/CLAUDE.md
cat > ~/.claude.json <<'JSON'
{ "theme": "dark", "mcpServers": { "userServer": { "command": "/bin/user-mcp" } } }
JSON

mkdir -p ~/.codex
cat > ~/.codex/config.toml <<'TOML'
model = "gpt-5.5"
approval_policy = "on-request"

[mcp_servers.tomlServer]
command = "/bin/toml-mcp"

[projects."/root/work"]
trust_level = "trusted"
TOML
echo '{"OPENAI_API_KEY":"sk-test-not-real"}' > ~/.codex/auth.json

cp ~/.claude/settings.json /tmp/claude-settings.before.json
cp ~/.codex/config.toml /tmp/codex-config.before.toml

# ---------------------------------------------------------------------------
# 2. Install the real agent CLIs (the unmanaged installs agents-cli will adopt)
# ---------------------------------------------------------------------------
step "npm install -g claude-code + codex"
npm install -g --silent @anthropic-ai/claude-code @openai/codex

# ---------------------------------------------------------------------------
# 3. Install agents-cli from the local tarball (postinstall runs here)
# ---------------------------------------------------------------------------
step "npm install -g agents-cli tarball"
npm install -g /e2e/agents-cli.tgz 2>&1 | tail -40

assert_claude_settings() {
  local phase="$1"
  node -e '
    const fs = require("fs");
    const before = JSON.parse(fs.readFileSync("/tmp/claude-settings.before.json", "utf8"));
    const after = JSON.parse(fs.readFileSync(process.env.HOME + "/.claude/settings.json", "utf8"));
    const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
    const errs = [];
    for (const key of ["env", "mcpServers", "customKey"]) {
      if (!eq(before[key], after[key])) errs.push(`${key} changed: ${JSON.stringify(after[key])}`);
    }
    // Hooks: factory sync legitimately merges system hooks into user entries,
    // so assert the user hook survived and fires exactly once (a stale-union
    // carry-forward bug would duplicate it).
    const fires = (after.hooks?.PreToolUse || [])
      .flatMap((e) => e.hooks || [])
      .filter((h) => h.command === "echo guard").length;
    if (fires !== 1) errs.push(`user hook "echo guard" fires ${fires} times (want exactly 1)`);
    for (const list of ["allow", "deny"]) {
      for (const rule of before.permissions[list]) {
        if (!(after.permissions?.[list] || []).includes(rule)) errs.push(`permissions.${list} lost: ${rule}`);
      }
    }
    if (errs.length) { console.error(errs.join("\n")); process.exit(1); }
  ' || fail "claude settings.json lost user config ($phase)"
  echo "ok: claude settings survived ($phase)"
}

assert_codex_config() {
  local phase="$1"
  for needle in 'model = "gpt-5.5"' 'tomlServer' 'trust_level = "trusted"'; do
    grep -qF "$needle" ~/.codex/config.toml || fail "codex config.toml lost: $needle ($phase)"
  done
  grep -qF 'sk-test-not-real' ~/.codex/auth.json || fail "codex auth.json lost ($phase)"
  echo "ok: codex config survived ($phase)"
}

assert_claude_settings "after npm install"
assert_codex_config "after npm install"

# Step 4: first-run setup (clones the public system repo), then adopt both agents via
# importAgentConfig, as interactive setup does.
step "agents setup"
agents setup </dev/null || fail "agents setup exited non-zero"

step "agents import claude + codex"
agents import claude --yes </dev/null || fail "agents import claude failed"
agents import codex --yes </dev/null || fail "agents import codex failed"

[ -L ~/.claude ] || fail "~/.claude is not a symlink after import"
[ -L ~/.codex ] || fail "~/.codex is not a symlink after import"
echo "ok: config dirs adopted ($(readlink ~/.claude))"

assert_claude_settings "after import"
assert_codex_config "after import"

# Step 5: trigger the launch-time factory sync, the call the claude shim makes on every launch and
# the path that wiped settings in #112/#137.
step "launch sync (factory settings writers)"
CLAUDE_VERSION=$(ls ~/.agents/.history/versions/claude/ | head -1)
agents sync --agent claude --agent-version "$CLAUDE_VERSION" --launch --cwd "$HOME" --quiet </dev/null \
  || echo "warn: launch sync exited non-zero (continuing to assertions)"
CODEX_VERSION=$(ls ~/.agents/.history/versions/codex/ | head -1)
agents sync --agent codex --agent-version "$CODEX_VERSION" --launch --cwd "$HOME" --quiet </dev/null \
  || echo "warn: codex launch sync exited non-zero (continuing to assertions)"

assert_claude_settings "after launch sync"
assert_codex_config "after launch sync"

# Step 6: version switch: install a second claude version and switch; the carry-forward must seed
# the new empty home with the imported version's settings.
SWITCH_CLAUDE_VERSION="${SWITCH_CLAUDE_VERSION:-2.1.170}"
step "version switch carry-forward (claude@$SWITCH_CLAUDE_VERSION)"
agents add "claude@$SWITCH_CLAUDE_VERSION" --yes </dev/null || fail "agents add claude@$SWITCH_CLAUDE_VERSION failed"
agents use "claude@$SWITCH_CLAUDE_VERSION" </dev/null || fail "agents use claude@$SWITCH_CLAUDE_VERSION failed"

readlink ~/.claude | grep -q "$SWITCH_CLAUDE_VERSION" || fail "~/.claude does not point at $SWITCH_CLAUDE_VERSION after use"
assert_claude_settings "after version switch"

echo
echo "PASS: all user settings survived install, import, factory sync, and version switch"
