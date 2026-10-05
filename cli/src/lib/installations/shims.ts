/**
 * Shim generation, config symlink management, and versioned aliases for agent version switching.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { fileURLToPath } from 'url';
import { confirm, select } from '@inquirer/prompts';
import type { AgentId } from '../types.js';
import { IS_WINDOWS, prependToWindowsUserPath } from '../platform/index.js';
import { getShimsDir, getVersionsDir, getBackupsDir, getHistoryDir, ensureAgentsDir } from '../state.js';
export { getShimsDir };
import { AGENTS, agentConfigDirName, readAuthAccountIdentity } from '../agents.js';
import { acquireAuthOperationLock } from '../accounts/auth-operation-lock.js';
import { codexHomeShimBash } from '../codex-home.js';
import { resolveHarnessAdapter } from '../harness/index.js';
import { slotAwareConfigEnvBash } from '../harness/adapter.js';
import { randomUUID } from 'node:crypto';
import { captureProcessStartTime } from '../platform/process.js';
import { atomicWriteFileSync } from '../fs-atomic.js';

/** Files and directories to always skip during conflict detection and migration. */
const MIGRATION_IGNORE_LIST = new Set([
  'node_modules',
  '.git',
  'bun.lock',
  'bun.lockb',
  'package-lock.json',
  'yarn.lock',
  'pnpm-lock.yaml',
  '.DS_Store',
  'Thumbs.db',
]);

function shouldIgnore(name: string): boolean {
  if (MIGRATION_IGNORE_LIST.has(name)) return true;
  if (name.endsWith('.backup')) return true;
  return false;
}

// Launch leases are written under the shared launch/update gate BEFORE exec or
// spawn. A live launcher protects the gap until its child appears in ps; an
// exec-replacing shim keeps the same PID. A birth fingerprint defeats PID reuse.
function launchLeaseDir(agent: AgentId, label: string): string {
  return path.join(getVersionsDir(), agent, label, '.launch-leases');
}

/** Record that `pid` is about to execute this installation's binary. Call right before handing off to it. */
export function recordLaunchLease(agent: AgentId, label: string, pid: number): () => void {
  const dir = launchLeaseDir(agent, label);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${pid}-${randomUUID()}.json`);
  atomicWriteFileSync(file, JSON.stringify({ pid, birth: captureProcessStartTime(pid, { fresh: true }) }));
  return () => { try { fs.unlinkSync(file); } catch { /* dead leases are also ignored by readers */ } };
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

/** Read-only: stale leases cannot defer an update, and preview never deletes files. */
export function hasLiveLaunchLease(agent: AgentId, label: string): boolean {
  const dir = launchLeaseDir(agent, label);
  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch (err) {
    return (err as NodeJS.ErrnoException).code !== 'ENOENT';
  }
  let live = false;
  for (const entry of entries) {
    const match = entry.match(/^(\d+)(?:-[a-f0-9-]+)?\.json$/);
    if (!match) continue;
    const pid = Number(match[1]);
    if (!pidAlive(pid)) continue;
    try {
      const lease = JSON.parse(fs.readFileSync(path.join(dir, entry), 'utf8')) as { birth?: string | null };
      const birth = captureProcessStartTime(pid, { fresh: true });
      if (!lease.birth || !birth || lease.birth === birth) live = true;
    } catch { live = true; } // Unknown state is busy, never permission to swap.
  }
  return live;
}

export type ConflictStrategy = 'keep-dest' | 'overwrite' | 'ask-per-file';

export interface ConflictInfo {
  agent: AgentId;
  version: string;
  conflicts: string[];
}

/** Detect filenames that exist in both `src` and `dest`, excluding symlinks in `dest`. */
function detectConflicts(src: string, dest: string, prefix = ''): string[] {
  const conflicts: string[] = [];

  if (!fs.existsSync(src) || !fs.existsSync(dest)) {
    return conflicts;
  }

  // Skip if dest is a symlink (managed resources)
  try {
    const destStat = fs.lstatSync(dest);
    if (destStat.isSymbolicLink()) {
      return conflicts;
    }
  } catch {
    /* dest not accessible, no conflicts to report */
    return conflicts;
  }

  const entries = fs.readdirSync(src, { withFileTypes: true });
  for (const entry of entries) {
    // Skip files/directories that should never be migrated
    if (shouldIgnore(entry.name)) {
      continue;
    }

    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;

    // Skip if dest entry is a symlink (managed resource)
    try {
      const entryDestStat = fs.lstatSync(destPath);
      if (entryDestStat.isSymbolicLink()) {
        continue;
      }

      if (entry.isDirectory()) {
        // Recurse into subdirectories
        conflicts.push(...detectConflicts(srcPath, destPath, relativePath));
      } else {
        // File exists in both - it's a conflict
        conflicts.push(relativePath);
      }
    } catch {
      // dest entry doesn't exist, not a conflict
    }
  }

  return conflicts;
}

async function promptConflictStrategy(
  conflictInfos: ConflictInfo[]
): Promise<ConflictStrategy | null> {
  const totalConflicts = conflictInfos.reduce((sum, info) => sum + info.conflicts.length, 0);

  if (totalConflicts === 0) {
    return null; // No conflicts, no prompt needed
  }

  // Show what has conflicts with clear paths
  console.log('\nFile conflicts detected:');
  for (const info of conflictInfos) {
    const agentConfig = AGENTS[info.agent];
    const configDir = agentConfig.configDir; // e.g., ".opencode"
    console.log(`  ${info.conflicts.length} file(s) conflict between:`);
    console.log(`    ~/${configDir}/ (your config)`);
    console.log(`    ${agentConfig.name}@${info.version} (managed version)`);
  }
  console.log();

  // Build choice labels with agent info for clarity
  const firstInfo = conflictInfos[0];
  const firstAgent = AGENTS[firstInfo.agent];
  const versionLabel = conflictInfos.length === 1
    ? `${firstAgent.name}@${firstInfo.version}`
    : 'version';

  const strategy = await select<ConflictStrategy>({
    message: 'Which files should be kept?',
    choices: [
      {
        value: 'keep-dest' as ConflictStrategy,
        name: `Keep ${versionLabel} files (recommended)`,
      },
      {
        value: 'overwrite' as ConflictStrategy,
        name: conflictInfos.length === 1
          ? `Keep ~/${firstAgent.configDir}/ files`
          : 'Keep my config files',
      },
      {
        value: 'ask-per-file' as ConflictStrategy,
        name: `Decide per file (${totalConflicts} file${totalConflicts === 1 ? '' : 's'})`,
      },
    ],
    default: 'keep-dest',
  });

  return strategy;
}

/** Generate the shim script content for an agent. Resolves project/default version, auto-installs if missing, and execs the binary. */
/** Current shim schema version. Bump whenever `generateShimScript` changes so existing on-disk
 * shims must be regenerated; `isShimCurrent` reads this marker. */
// Shim schema history v20-v32: kimi resolves via the generic node_modules/.bin branch; grok
// checks the versioned home first and rejects candidates under 1MB (RUSH-2459); claude shims
// export DISABLE_AUTOUPDATER=1 (user value wins); config-dir pins yield to account-slot launches.
export const SHIM_SCHEMA_VERSION = 33;

/** Internal marker string used to embed the schema version in shim scripts. */
const SHIM_VERSION_MARKER = 'agents-shim-version:';

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** Bash function in every generated grok binary-resolution block; prints the path to use.
 * Prefers a `grok-*` file whose basename (never full path) carries the pinned version; else
 * drops files under MIN_GROK_BINARY_BYTES, takes the newest (RUSH-2459). Mirrors versions.ts. */
const GROK_RESOLVE_BINARY_FN = `_resolve_grok_current() {
  local target
  target=$(readlink -f "$1/bin/grok" 2>/dev/null) || return 0
  [ -f "$target" ] && [ -x "$target" ] || return 0
  [ "$(wc -c < "$target" 2>/dev/null || echo 0)" -ge 1000000 ] || return 0
  printf '%s\\n' "$target"
}
_resolve_grok_binary() {
  local dir="$1" version_hint="$2"
  local candidate base size mtime
  for candidate in "$dir"/grok-*; do
    [ -f "$candidate" ] || continue
    base=$(basename "$candidate")
    case "$base" in
      *"$version_hint"*) printf '%s\\n' "$candidate"; return ;;
    esac
  done
  local min_bytes=1000000
  local best="" best_mtime=-1
  for candidate in "$dir"/grok-*; do
    [ -f "$candidate" ] || continue
    size=$(wc -c < "$candidate" 2>/dev/null || echo 0)
    [ "$size" -ge "$min_bytes" ] || continue
    mtime=$(stat -c %Y "$candidate" 2>/dev/null || stat -f %m "$candidate" 2>/dev/null || echo -1)
    if [ "$mtime" -gt "$best_mtime" ]; then
      best_mtime="$mtime"
      best="$candidate"
    fi
  done
  printf '%s\\n' "$best"
}`;


function getAgentsBinForGeneratedShim(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'index.js');
}

/** Generate the full bash shim script for the agent; it is written to
 * ~/.agents/shims/{cliCommand} and made executable. */
export function generateShimScript(agent: AgentId): string {
  const agentConfig = AGENTS[agent];
  const cliCommand = agentConfig.cliCommand;
  // Derive the relative config-dir path from the registry: `.${agent}` for most agents, but nested
  // layouts like Antigravity (`~/.gemini/antigravity-cli`) carry the full subpath.
  const configDirName = path.relative(os.homedir(), agentConfig.configDir);
  const agentsBin = shellQuote(getAgentsBinForGeneratedShim());
  const managedEnv = resolveHarnessAdapter(agent).shimConfigEnvBash?.({ configDirName }) ?? '';
  const launchArgs = resolveHarnessAdapter(agent).shimLaunchArgs?.() ?? '';

  return `#!/bin/bash
# Auto-generated by agents-cli - do not edit
# Shim for ${agentConfig.name}
# ${SHIM_VERSION_MARKER} ${SHIM_SCHEMA_VERSION}

AGENTS_USER_DIR="\${AGENTS_USER_DIR:-$HOME/.agents}"
AGENTS_BIN=${agentsBin}
AGENT="${agent}"
CLI_COMMAND="${cliCommand}"

if [ -z "$AGENTS_BIN" ] || [ ! -x "$AGENTS_BIN" ]; then
  # The baked dispatcher is gone — e.g. the build that generated this shim (often
  # a dev build under ~/.local/agents-cli-dev) was removed, moved, or its version
  # dir rotated. Self-recover to whatever 'agents' now resolves to on PATH instead
  # of bricking every managed launch. 'agents' is the CLI itself, never a per-agent
  # shim, so this cannot re-enter this dispatcher.
  RECOVERED_BIN="$(command -v agents 2>/dev/null || true)"
  if [ -n "$RECOVERED_BIN" ] && [ -x "$RECOVERED_BIN" ]; then
    AGENTS_BIN="$RECOVERED_BIN"
  else
    echo "agents: agents-cli entrypoint missing or not executable: $AGENTS_BIN" >&2
    echo "agents: could not resolve 'agents' on PATH to recover. Reinstall: npm i -g @phnx-labs/agents-cli" >&2
    exit 127
  fi
fi

# When agents-cli "adopts" a harness's own launcher (symlinks the native binary
# in ~/.local/bin to this dispatcher so version management wins regardless of
# PATH order), it records the real original here. Durable (.history, not the
# regenerable .cache) so the reverse pointer survives a cache wipe. Line 1 is
# the original binary (what we fall through to); line 2 is the launcher path
# (used by --release). It is the only safe fall-through target: exec it by
# ABSOLUTE PATH so we never re-resolve through PATH (which now points back at
# this dispatcher → infinite re-exec loop).
ADOPTED_ORIGINAL="$AGENTS_USER_DIR/.history/adopted-launchers/$CLI_COMMAND"
# Print the recorded original binary iff it is an executable file, else nothing.
adopted_original_bin() {
  [ -f "$ADOPTED_ORIGINAL" ] || return 1
  local orig
  # First line only — line 2 (launcher path) is for --release, not exec.
  IFS= read -r orig < "$ADOPTED_ORIGINAL" 2>/dev/null || return 1
  [ -n "$orig" ] && [ -x "$orig" ] || return 1
  printf '%s' "$orig"
}
# Last-resort fall-through: if a managed version can't be resolved but we've
# adopted this command's native launcher, run the original so the user's command
# never breaks. Replaces the process; returns non-zero only when no usable record.
exec_adopted_original() {
  local orig
  orig=$(adopted_original_bin) || return 1
  exec "$orig" "$@"
}

# Find project agents.yaml walking up from cwd (skip $HOME/.agents/agents.yaml)
find_project_version() {
  local dir="$PWD"
  local user_agents_yaml="$AGENTS_USER_DIR/agents.yaml"
  while [ "$dir" != "/" ]; do
    local candidate="$dir/agents.yaml"
    if [ -f "$candidate" ] && [ "$candidate" != "$user_agents_yaml" ]; then
      # Parse agents: section — same shape as resolve_default_version()
      local version
      version=$(awk -v agent="$AGENT" '
        /^agents:/ { in_agents=1; next }
        in_agents && /^[^ ]/ { in_agents=0 }
        in_agents && $0 ~ "^  " agent ":" { gsub(/.*:[[:space:]]*["'"'"']?|["'"'"']?[[:space:]]*$/, ""); print; exit }
      ' "$candidate")
      if [ -n "$version" ]; then
        echo "$version"
        return 0
      fi
    fi
    dir=$(dirname "$dir")
  done
  return 1
}

# Parse the agents: default map of one agents.yaml for this AGENT's version.
parse_agents_default() {
  local meta="$1"
  [ -f "$meta" ] || return 0
  awk -v agent="$AGENT" '
    /^agents:/ { in_agents=1; next }
    in_agents && /^[^ ]/ { in_agents=0 }
    in_agents && $0 ~ "^  " agent ":" { gsub(/.*:[[:space:]]*["'"'"']?|["'"'"']?[[:space:]]*$/, ""); print; exit }
  ' "$meta"
}

# Parse the pins JSON (~/.agents/.history/devices/pins-<machine>.json) for this
# AGENT's pinned version. The file is JSON.stringify(…, 2) output, so the
# "agents" map sits at 2-space indent and its entries at 4 — a stable shape the
# awk below scrapes without a JSON parser (shims must stay dependency-free).
parse_pins_default() {
  local pins="$1"
  [ -f "$pins" ] || return 0
  # Scope carefully: enter ONLY on a line that opens the agents block
  # (  "agents": {) — an inline-empty map ("agents": {}) must NOT enter,
  # or the needle would leak into a following "isolatedAgents" block and an
  # isolated pin would masquerade as the global default. Exit at the block's
  # closing brace (a trailing comma is fine). Entries sit at exactly 4 spaces.
  awk -v agent="$AGENT" '
    /^  "agents": [{]$/ { in_agents=1; next }
    in_agents && /^  }/ { exit }
    in_agents && /^    "/ {
      needle = "\\"" agent "\\":"
      if (index($0, needle) > 0) {
        line = substr($0, index($0, needle) + length(needle))
        gsub(/[[:space:],"]/, "", line)
        print line; exit
      }
    }
  ' "$pins"
}

# This machine's device id — mirrors machineId()/normalizeHost() in
# src/lib/machine-id.ts: first hostname label, lowercased, non-[a-z0-9_-] -> '-'.
# MUST stay in sync or the shim reads the wrong device folder.
machine_id() {
  local raw="\${AGENTS_SYNC_MACHINE_ID:-$(hostname 2>/dev/null)}"
  # first label -> trim -> lowercase -> non-[a-z0-9_-] to '-' (matches normalizeHost order).
  raw=$(printf '%s' "$raw" | cut -d. -f1 | sed 's/^[[:space:]]*//; s/[[:space:]]*$//' | tr '[:upper:]' '[:lower:]' | sed 's/[^a-z0-9_-]/-/g')
  [ -n "$raw" ] && printf '%s' "$raw" || printf 'unknown'
}

# Resolve the default version. The agents: version pins are MACHINE-LOCAL runtime
# state at .history/devices/pins-<machine>.json (untracked — auto-written pins in
# the tracked device doc caused commit churn); read that first, then fall back to
# the tracked device doc (installs not yet migrated) and finally the central
# agents.yaml (pre-split installs). Must match readMeta()'s central+pins merge in
# state.ts -- reading only the central file (the old behavior) missed every device
# pin and made the shim re-prompt "no default set" on every launch.
resolve_default_version() {
  local v
  v=$(parse_pins_default "$AGENTS_USER_DIR/.history/devices/pins-$(machine_id).json")
  [ -n "$v" ] || v=$(parse_agents_default "$AGENTS_USER_DIR/devices/$(machine_id)/agents.yaml")
  [ -n "$v" ] || v=$(parse_agents_default "$AGENTS_USER_DIR/agents.yaml")
  printf '%s' "$v"
}

# Find the latest installed version by numeric component comparison.
# Handles both semver (2.1.138) and date-based (2026.5.7) version strings.
find_latest_installed() {
  local versions_dir="$AGENTS_USER_DIR/.history/versions/$AGENT"
  [ -d "$versions_dir" ] || return
  ls "$versions_dir" 2>/dev/null | awk '
    BEGIN { best="" }
    {
      cur = $0
      n = split(cur, a, /[^0-9]+/)
      m = split(best, b, /[^0-9]+/)
      maxn = (n > m) ? n : m
      winner = cur
      for (i=1; i<=maxn; i++) {
        ai = (i<=n) ? a[i]+0 : 0
        bi = (i<=m) ? b[i]+0 : 0
        if (ai > bi) { winner=cur; break }
        if (ai < bi) { winner=best; break }
      }
      best = winner
    }
    END { print best }
  '
}

# Try project version first, then global default
VERSION=$(find_project_version)
VERSION_SOURCE="project"
if [ -z "$VERSION" ]; then
  VERSION=$(resolve_default_version)
  VERSION_SOURCE="default"
fi

if [ -z "$VERSION" ]; then
  LATEST=$(find_latest_installed)
  if [ -n "$LATEST" ]; then
    echo "agents: no default set for $AGENT — found $AGENT@$LATEST installed" >&2
    if [ -t 2 ]; then
      printf "  Set as default and continue? [Y/n] " >&2
      read -r _ans </dev/tty
      case "$_ans" in
        ""|y|Y)
          "$AGENTS_BIN" use "$AGENT" "$LATEST" >/dev/null 2>&1
          VERSION="$LATEST"
          VERSION_SOURCE="default"
          ;;
        *)
          exec_adopted_original "$@"
          echo "  Run: agents use $AGENT <version>" >&2
          exit 1
          ;;
      esac
    else
      exec_adopted_original "$@"
      echo "  Run: agents use $AGENT <version>" >&2
      exit 1
    fi
  else
    # No managed version at all. If we adopted this command's native launcher,
    # run it so the command keeps working; otherwise report it's unconfigured.
    exec_adopted_original "$@"
    echo "agents: no version of $AGENT configured" >&2
    echo "  Run: agents add $AGENT@<version>" >&2
    exit 1
  fi
fi

if [[ ! "$VERSION" =~ ^(latest|[A-Za-z0-9._+-]{1,64})$ || "$VERSION" == *..* ]]; then
  echo "agents: invalid version in agents.yaml for $AGENT: $VERSION. Allowed: latest or [A-Za-z0-9._+-]{1,64}" >&2
  exit 1
fi

VERSION_DIR="$AGENTS_USER_DIR/.history/versions/$AGENT/$VERSION"

# Grok special case: binary lives in the versioned home's .grok/downloads (or,
# for pre-fix installs, the global ~/.grok/downloads), not node_modules. We
# still use the agents-cli version dir purely for GROK_HOME isolation.
if [ "$AGENT" = "grok" ]; then
${GROK_RESOLVE_BINARY_FN}
  # Check the versioned home first — this is where the binary lands when the
  # installer runs with GROK_HOME set (i.e. via the shim or a correct
  # \`agents add grok\`), or when grok self-updates from within the shim.
  # \`bin/grok\` is grok's own current-release pointer, kept by its updater in
  # both layouts (\`bin/grok -> ../downloads/grok-<v>-<arch>\` and the newer
  # \`bin/grok -> grok-<v>\`); \`grok update\` never touches downloads/ in the
  # newer one, so scanning downloads/ alone keeps exec'ing a dead release.
  BINARY=$(_resolve_grok_current "$VERSION_DIR/home/.grok")
  GROK_DOWNLOADS="$VERSION_DIR/home/.grok/downloads"
  if [ -z "$BINARY" ] && [ -d "$GROK_DOWNLOADS" ]; then
    BINARY=$(_resolve_grok_binary "$GROK_DOWNLOADS" "$VERSION")
  fi
  # Fall back to the global grok home (binary installed without GROK_HOME set,
  # e.g. an earlier \`agents add grok@latest\` before this resolution fix).
  if [ -z "$BINARY" ] || [ ! -x "$BINARY" ]; then
    BINARY=$(_resolve_grok_current "$HOME/.grok")
  fi
  if [ -z "$BINARY" ] || [ ! -x "$BINARY" ]; then
    GROK_DOWNLOADS="$HOME/.grok/downloads"
    if [ -d "$GROK_DOWNLOADS" ]; then
      BINARY=$(_resolve_grok_binary "$GROK_DOWNLOADS" "$VERSION")
    fi
  fi
  if [ -z "$BINARY" ] || [ ! -x "$BINARY" ]; then
    # Last resort: the adopted native launcher (recorded absolute path) if we
    # adopted grok, else whatever is on PATH. Prefer the adopted record — after
    # adoption, "command -v grok" resolves to the ~/.local/bin symlink that now
    # points at THIS dispatcher, so exec-ing it would re-enter and spin forever.
    BINARY=$(adopted_original_bin || echo "")
    if [ -z "$BINARY" ]; then
      BINARY=$(command -v grok 2>/dev/null || echo "")
      # Refuse anything that resolves into our own shims dir (the dispatcher).
      case "$(command -v "$BINARY" 2>/dev/null; readlink -f "$BINARY" 2>/dev/null)" in
        *"$AGENTS_USER_DIR/.cache/shims/"*) BINARY="" ;;
      esac
    fi
  fi
# Kimi is a normal npm agent: "agents add kimi" npm-installs
# @moonshot-ai/kimi-code into the version dir and the binary lands at
# node_modules/.bin/kimi (a curl-installed kimi is symlinked to the same spot
# by installVersion). So kimi resolves via the generic node_modules branch
# below -- never a bespoke ~/.kimi-code/bin path that does not exist for npm
# installs and fell back to "command -v kimi", which resolves to THIS
# dispatcher (shims dir is ahead on PATH) and re-execs forever. Only
# KIMI_CODE_HOME (config isolation) stays special-cased, separately below.
# Droid (Factory AI) special case: the official installer drops a standalone
# native binary at ~/.local/bin/droid — there is no npm package and nothing
# lands in node_modules/.bin. Resolve the fixed install path directly. The
# PATH fallback explicitly refuses anything under our own shims dir: that path
# IS this dispatcher, so exec'ing it would re-enter and spin in an infinite
# re-exec loop (the bug this branch fixes).
elif [ "$AGENT" = "droid" ]; then
  # Prefer the adopted record first: if droid's ~/.local/bin/droid launcher was
  # adopted, that fixed path now points at THIS dispatcher, so using it directly
  # would infinite-loop. The record holds the real original binary.
  BINARY=$(adopted_original_bin || echo "")
  if [ -z "$BINARY" ]; then
    DROID_BINARY="$HOME/.local/bin/droid"
    if [ -x "$DROID_BINARY" ] && [ "$(readlink -f "$DROID_BINARY" 2>/dev/null)" != "$(readlink -f "$AGENTS_USER_DIR/.cache/shims/$CLI_COMMAND" 2>/dev/null)" ]; then
      BINARY="$DROID_BINARY"
    else
      BINARY=$(command -v droid 2>/dev/null || echo "")
      case "$(readlink -f "$BINARY" 2>/dev/null)" in
        "$AGENTS_USER_DIR/.cache/shims/"*) BINARY="" ;;
      esac
    fi
  fi
elif [ "$AGENT" = "muse" ]; then
  # Muse Code installs a self-updating launcher at ~/.local/bin/muse (curl
  # installer from dev.meta.ai). No npm package. Same shims-dir re-exec guard
  # as droid.
  BINARY=$(adopted_original_bin || echo "")
  if [ -z "$BINARY" ]; then
    MUSE_BINARY="$HOME/.local/bin/muse"
    if [ -x "$MUSE_BINARY" ] && [ "$(readlink -f "$MUSE_BINARY" 2>/dev/null)" != "$(readlink -f "$AGENTS_USER_DIR/.cache/shims/$CLI_COMMAND" 2>/dev/null)" ]; then
      BINARY="$MUSE_BINARY"
    else
      BINARY=$(command -v muse 2>/dev/null || echo "")
      case "$(readlink -f "$BINARY" 2>/dev/null)" in
        "$AGENTS_USER_DIR/.cache/shims/"*) BINARY="" ;;
      esac
    fi
  fi
elif [ "$AGENT" = "warp" ]; then
  # Warp Agent CLI installs a global, self-updating warp binary at
  # ~/.local/bin/warp (curl installer) -- like droid/muse -- so resolve it from
  # PATH with the same shims-dir re-exec guard as droid/muse.
  BINARY=$(adopted_original_bin || echo "")
  if [ -z "$BINARY" ]; then
    BINARY=$(command -v warp 2>/dev/null || echo "")
    case "$(readlink -f "$BINARY" 2>/dev/null)" in
      "$AGENTS_USER_DIR/.cache/shims/"*) BINARY="" ;;
    esac
  fi
else
  BINARY="$VERSION_DIR/node_modules/.bin/$CLI_COMMAND"
fi

# A managed binary must never resolve back into this dispatcher. This can
# happen when an install-script launcher was imported before adoption and was
# later repointed at the agents shim. Use the durable native target recorded by
# adoption instead of recursively exec-ing this script.
if [ -x "$BINARY" ]; then
  RESOLVED_BINARY=$(realpath "$BINARY" 2>/dev/null || readlink -f "$BINARY" 2>/dev/null || echo "")
  RESOLVED_SHIM=$(realpath "$AGENTS_USER_DIR/.cache/shims/$CLI_COMMAND" 2>/dev/null || readlink -f "$AGENTS_USER_DIR/.cache/shims/$CLI_COMMAND" 2>/dev/null || echo "")
  if [ -n "$RESOLVED_BINARY" ] && [ "$RESOLVED_BINARY" = "$RESOLVED_SHIM" ]; then
    BINARY=$(adopted_original_bin || echo "")
  fi
fi

# Auto-install if not present
if [ ! -x "$BINARY" ]; then
  if [ "$VERSION_SOURCE" = "project" ]; then
    echo "agents: $AGENT@$VERSION required by agents.yaml but not installed" >&2

    # Spinner animation
    spin() {
      local pid=$1
      local chars="⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏"
      local i=0
      while kill -0 "$pid" 2>/dev/null; do
        printf "\\r  %s Installing $AGENT@$VERSION..." "\${chars:i++%\${#chars}:1}" >&2
        sleep 0.1
      done
      printf "\\r" >&2
    }

    # Run install in background with spinner
    "$AGENTS_BIN" add "$AGENT@$VERSION" --yes >/dev/null 2>&1 &
    install_pid=$!
    spin $install_pid
    wait $install_pid
    install_status=$?

    if [ $install_status -eq 0 ]; then
      echo "  ✔ Installed $AGENT@$VERSION" >&2
    else
      echo "  ✗ Failed to install $AGENT@$VERSION" >&2
      exec_adopted_original "$@"
      exit 1
    fi
  else
    LATEST=$(find_latest_installed)
    if [ -n "$LATEST" ] && [ "$LATEST" != "$VERSION" ]; then
      echo "agents: $AGENT@$VERSION not installed — found $AGENT@$LATEST installed" >&2
      if [ -t 2 ]; then
        printf "  Switch default to $AGENT@$LATEST and continue? [Y/n] " >&2
        read -r _ans </dev/tty
        case "$_ans" in
          ""|y|Y)
            "$AGENTS_BIN" use "$AGENT" "$LATEST" >/dev/null 2>&1
            VERSION="$LATEST"
            VERSION_DIR="$AGENTS_USER_DIR/.history/versions/$AGENT/$VERSION"
            BINARY="$VERSION_DIR/node_modules/.bin/$CLI_COMMAND"
            ;;
          *)
            exec_adopted_original "$@"
            echo "  Run: agents add $AGENT@$VERSION" >&2
            exit 1
            ;;
        esac
      else
        exec_adopted_original "$@"
        echo "  Run: agents add $AGENT@$VERSION" >&2
        exit 1
      fi
    else
      exec_adopted_original "$@"
      echo "agents: $AGENT@$VERSION not installed" >&2
      echo "  Run: agents add $AGENT@$VERSION" >&2
      exit 1
    fi
  fi
fi

${managedEnv}

# Project-scoped compile (rules, workspace resources, scoped plugin marketplaces).
# Skip-fast: if a sentinel from the last sync exists and is newer than all
# source dirs (project .agents/, user plugins, system plugins), exec the
# agent binary directly without spawning node. Cuts steady-state hot-path
# latency from ~680ms (node startup + agents-cli module init) to ~11ms (a
# handful of stat calls). Never blocks launch on failure of the sync itself.
#
# Known limitation: POSIX dir mtime updates only on entry add/remove at that
# level. Deep edits to existing plugin contents (e.g. editing a SKILL.md
# inside a plugin) won't bump the parent dir's mtime — the marketplace copy
# stays stale until \`agents sync\` runs explicitly or a top-level entry
# changes. Advanced users hot-iterating on plugins know to run sync.
PROJECT_SLUG=\$(printf '%s' "\$PWD" | tr / _ | tr ' ' _)
LAUNCH_SENTINEL="\$AGENTS_USER_DIR/.cache/launch-sync/\${AGENT}@\${VERSION}@\${PROJECT_SLUG}"
LAUNCH_SKIP=0
if [ -f "\$LAUNCH_SENTINEL" ]; then
  LAUNCH_SKIP=1
  for LAUNCH_SRC in "\$PWD/.agents" "\$AGENTS_USER_DIR/plugins" "\$AGENTS_USER_DIR/.system/plugins"; do
    if [ -e "\$LAUNCH_SRC" ] && [ "\$LAUNCH_SRC" -nt "\$LAUNCH_SENTINEL" ]; then
      LAUNCH_SKIP=0
      break
    fi
  done
fi
if [ "\$LAUNCH_SKIP" = "0" ]; then
  "\$AGENTS_BIN" sync --agent "\$AGENT" --agent-version "\$VERSION" --launch --cwd "\$PWD" --quiet 2>/dev/null || true
fi

# Register a launch lease for THIS pid before the exec below replaces this
# process image (PHNX-3940) — \$\$ survives exec, so the lease's pid matches
# the real running binary. Takes the SAME per-installation lock the automatic
# background update uses for its whole stage->commit transaction, so this
# call blocks here (never past the exec below) for as long as an update of
# this exact installation is actively in flight, and otherwise returns almost
# immediately. Unlike the sync call above, this is NOT best-effort: silently
# falling through on failure (a lock the updater is genuinely still holding,
# or any other error) would let this process exec straight into a binary an
# update could be mid-swap on — exactly the race this exists to close. Fail
# closed instead.
if ! "\$AGENTS_BIN" __launch-lease "\$AGENT" "\$VERSION" "\$\$"; then
  echo "agents: could not safely coordinate this launch with a possibly in-progress update of \$AGENT@\$VERSION." >&2
  echo "  Check: agents update \$AGENT@\$VERSION --check    Retry once any update finishes." >&2
  exit 1
fi

${resolveHarnessAdapter(agent).shimExecTail?.(launchArgs) ?? `exec "$BINARY"${launchArgs} "$@"`}
`;
}

/** Which shim files to materialize for a platform (pure). POSIX writes the extensionless
 * `#!/bin/bash` shim; Windows writes only the `.cmd` companion, since PATHEXT makes it the
 * runnable form and the bash file would be dead weight that confuses `where agents`. */
export function shimTargetsFor(platform: NodeJS.Platform): { bash: boolean; cmd: boolean } {
  if (platform === 'win32') return { bash: false, cmd: true };
  return { bash: true, cmd: false };
}

/** Create the shim(s) for an agent. */
export function createShim(agent: AgentId): string {
  // A bare shim puts agents-cli first on PATH for this agent — the opposite of what
  // an isolated-only install promises.
  assertIsolationBoundary(agent, 'create the bare shim');
  ensureAgentsDir();
  const shimsDir = getShimsDir();
  const agentConfig = AGENTS[agent];
  const shimPath = path.join(shimsDir, agentConfig.cliCommand);

  const targets = shimTargetsFor(process.platform);
  if (targets.bash) {
    fs.writeFileSync(shimPath, generateShimScript(agent), { mode: 0o755 });
  }
  // Windows can't execute the bash shim: drop a `.cmd` companion that delegates to the node-side
  // resolver (`agents __shim`), keeping version resolution single-sourced, and skip the bash file.
  if (targets.cmd) {
    writeWindowsCmdShim(shimPath + '.cmd', agentConfig.cliCommand);
  }

  return shimPath;
}

// White-label brand shims are a pure pass-through: unlike agent or alias shims they forward argv
// verbatim to the agents-cli entrypoint with `AGENTS_BRAND` set, so `<brand> <verb>` behaves like
// `agents <verb>` under the brand's name (see lib/brand.ts).

const BRAND_SHIM_MARKER = '# Brand shim:';

/** The POSIX pass-through shim for a brand. */
export function generateBrandShim(name: string): string {
  const agentsBin = shellQuote(getAgentsBinForGeneratedShim());
  return `#!/bin/sh
# Auto-generated by agents-cli - do not edit
${BRAND_SHIM_MARKER} ${name} -> agents-cli (white-label)
AGENTS_BIN=${agentsBin}
if [ -z "$AGENTS_BIN" ] || [ ! -x "$AGENTS_BIN" ]; then
  echo "${name}: agents-cli entrypoint missing or not executable: $AGENTS_BIN" >&2
  exit 127
fi
export AGENTS_BRAND=${name}
exec "$AGENTS_BIN" "$@"
`;
}

/** Write a brand's pass-through shim(s) onto PATH; returns the shim path. */
export function createBrandShim(name: string): string {
  ensureAgentsDir();
  const shimsDir = getShimsDir();
  const shimPath = path.join(shimsDir, name);
  const targets = shimTargetsFor(process.platform);
  if (targets.bash) {
    fs.writeFileSync(shimPath, generateBrandShim(name), { mode: 0o755 });
  }
  if (targets.cmd) {
    writeWindowsBrandShim(shimPath + '.cmd', name);
  }
  return shimPath;
}

/** Windows `.cmd` pass-through: set AGENTS_BRAND then forward argv to the entrypoint. */
function writeWindowsBrandShim(cmdPath: string, name: string): void {
  const indexJs = getAgentsBinForGeneratedShim();
  const content =
    `@echo off\r\n` +
    `rem Auto-generated by agents-cli - do not edit\r\n` +
    `rem Brand shim: ${name}\r\n` +
    `set AGENTS_BRAND=${name}\r\n` +
    `node "${indexJs}" %*\r\n`;
  fs.writeFileSync(cmdPath, content);
}

/** True when the file at the given path is an agents-cli brand shim. */
export function isBrandShim(filePath: string): boolean {
  try {
    const head = fs.readFileSync(filePath, 'utf-8').slice(0, 300);
    return head.includes(BRAND_SHIM_MARKER) || head.includes('rem Brand shim:');
  } catch {
    return false;
  }
}

/** Remove a brand's shim companions. Returns true if anything was removed. */
export function removeBrandShim(name: string): boolean {
  const shimsDir = getShimsDir();
  const shimPath = path.join(shimsDir, name);
  let removed = false;
  for (const p of [shimPath, shimPath + '.cmd']) {
    if (fs.existsSync(p) && isBrandShim(p)) {
      fs.unlinkSync(p);
      removed = true;
    }
  }
  return removed;
}

// gh overload shim: a transparent interceptor for the one thing that keeps rate-limiting the fleet,
// `gh pr checks`. It routes only that to REST via `agents __gh` and execs the real gh otherwise
// (see cli/src/lib/github/gh-overload.ts, PHNX-3501).

const GH_OVERLOAD_MARKER = '# gh overload shim:';

/** The POSIX gh overload shim. Self-healing: it resolves the real gh (first on PATH not in this
 * shims dir) and execs it directly when agents-cli is gone, the recursion sentinel is set, or
 * the verb is not `pr checks`, so an orphaned shim can never break `gh`. */
export function generateGhOverloadShim(): string {
  const agentsBin = shellQuote(getAgentsBinForGeneratedShim());
  const shimsDir = shellQuote(getShimsDir());
  return `#!/bin/sh
# Auto-generated by agents-cli - do not edit
${GH_OVERLOAD_MARKER} routes 'gh pr checks' to REST via 'agents __gh' (GraphQL rate-limit escape)
AGENTS_BIN=${agentsBin}
SHIMS_DIR=${shimsDir}
find_real_gh() {
  _oldifs=$IFS; IFS=:
  for _d in $PATH; do
    [ "$_d" = "$SHIMS_DIR" ] && continue
    if [ -x "$_d/gh" ]; then IFS=$_oldifs; printf '%s\\n' "$_d/gh"; return 0; fi
  done
  IFS=$_oldifs; return 1
}
REAL_GH=$(find_real_gh)
# No real gh on PATH: fail loud like "command not found" (127). NEVER fall back to
# the bare string 'gh' — on a gh-less box that resolves to THIS shim and loops.
if [ -z "$REAL_GH" ]; then
  echo "gh: not found (agents-cli gh overload: no real gh on PATH)" >&2
  exit 127
fi
# Self-heal + recursion guard: agents-cli missing, or already inside the overload,
# or any verb other than 'pr checks' -> just be plain gh. REAL_GH is always an
# absolute path here, so this can never re-enter the shim.
if [ -n "$AGENTS_GH_SHIM" ] || [ -z "$AGENTS_BIN" ] || [ ! -x "$AGENTS_BIN" ]; then
  exec "$REAL_GH" "$@"
fi
if [ "$1" = "pr" ] && [ "$2" = "checks" ]; then
  AGENTS_GH_SHIM=1 exec "$AGENTS_BIN" __gh --real-gh "$REAL_GH" -- "$@"
fi
exec "$REAL_GH" "$@"
`;
}

/** True when the file is our gh overload shim (not a user's real gh). */
export function isGhOverloadShim(filePath: string): boolean {
  try {
    return fs.readFileSync(filePath, 'utf-8').slice(0, 300).includes(GH_OVERLOAD_MARKER);
  } catch {
    return false;
  }
}

/** True when a REAL `gh` binary exists on PATH outside our shims dir. */
function hasRealGhOnPath(): boolean {
  const shimsDir = path.resolve(getShimsDir());
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    if (!dir || path.resolve(dir) === shimsDir) continue;
    const candidate = path.join(dir, 'gh');
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return true;
    } catch {
      // not here / not executable — keep scanning
    }
  }
  return false;
}

/** Create/refresh the gh overload shim so `gh pr checks` escapes the GraphQL rate limit. POSIX
 * only in v1. Returns null when there is no real `gh` to overload, never clobbers a non-shim
 * `gh`, and fails loud with 127 if gh later disappears. */
export function ensureGhOverloadShim(): string | null {
  if (!shimTargetsFor(process.platform).bash) return null;
  if (!hasRealGhOnPath()) return null;
  ensureAgentsDir();
  const shimPath = path.join(getShimsDir(), 'gh');
  if (fs.existsSync(shimPath) && !isGhOverloadShim(shimPath)) return null;
  fs.writeFileSync(shimPath, generateGhOverloadShim(), { mode: 0o755 });
  return shimPath;
}

/** Remove the gh overload shim — real gh returns immediately. Called on uninstall. */
export function removeGhOverloadShim(): boolean {
  const shimPath = path.join(getShimsDir(), 'gh');
  if (fs.existsSync(shimPath) && isGhOverloadShim(shimPath)) {
    fs.unlinkSync(shimPath);
    return true;
  }
  return false;
}

/** Generate a Windows `.cmd` launcher delegating to `agents __shim <spec>`, with node and the
 * dist entrypoint resolved at generation time. `extraMarkerLines` stamps schema markers so
 * readVersionedAliasSchemaVersion can stat the `.cmd`, the only Windows artifact. */
function writeWindowsCmdShim(cmdPath: string, spec: string, extraMarkerLines: string[] = []): void {
  const indexJs = getAgentsBinForGeneratedShim();
  const content =
    `@echo off\r\n` +
    `rem Auto-generated by agents-cli - do not edit\r\n` +
    `rem ${SHIM_VERSION_MARKER} ${SHIM_SCHEMA_VERSION}\r\n` +
    extraMarkerLines.map((line) => `rem ${line}\r\n`).join('') +
    `node "${indexJs}" __shim ${spec} %*\r\n`;
  fs.writeFileSync(cmdPath, content);
}

/** Remove the shim(s) for an agent. */
export function removeShim(agent: AgentId): boolean {
  const shimsDir = getShimsDir();
  const agentConfig = AGENTS[agent];
  const shimPath = path.join(shimsDir, agentConfig.cliCommand);

  // Remove whichever companions exist: the extensionless script (POSIX or a legacy Windows install)
  // and the `.cmd`; keying only off the extensionless path would orphan the `.cmd`.
  let removed = false;
  for (const p of [shimPath, shimPath + '.cmd']) {
    if (fs.existsSync(p)) {
      fs.unlinkSync(p);
      removed = true;
    }
  }
  return removed;
}

/** Current versioned-alias schema; bump whenever `generateVersionedAliasScript` changes so on-
 * disk aliases regenerate. v1-v16 covered per-version config isolation, kimi/grok/droid binary
 * resolution, Windows `.cmd`-only aliases and the RUSH-2459 grok fixes. */
// Alias schema history v17-v21: the claude alias env reuses the adapter's shimConfigEnvBash;
// Cursor aliases swap HOME and use the file credential store; every config-dir pin yields to an
// account-slot launch (AGENTS_EXEC_HOME), which the alias once re-pinned onto the shared home.
export const VERSIONED_ALIAS_SCHEMA_VERSION = 21;

/** Internal marker string used to embed the schema version in versioned alias scripts. */
const VERSIONED_ALIAS_VERSION_MARKER = 'agents-versioned-alias-version:';

// The version string is interpolated into a generated bash script and a filename. parseAgentSpec
// already validates it, but generators are also called from internal paths (e.g. re-emit on schema
// bump), so re-check here; mirrors VERSION_RE in versions.ts.
const ALIAS_VERSION_RE = /^[A-Za-z0-9._+-]{1,64}$/;

function assertSafeVersion(version: string): void {
  if (!ALIAS_VERSION_RE.test(version)) {
    throw new Error(`Refusing to generate shim for unsafe version: ${JSON.stringify(version)}`);
  }
}

/** Agents whose config dir an env var can relocate (the `managedEnv` block in
 * `generateVersionedAliasScript`); only these support `agents add --isolated`. Others isolate only
 * via the symlink an isolated install skips, so it is refused. KEEP IN SYNC; a test enforces it. */
export const CONFIG_ENV_ISOLATED_AGENTS: readonly AgentId[] = ['claude', 'codex', 'copilot', 'cursor', 'grok', 'kimi', 'opencode', 'muse'];

/** Whether an agent supports a clean `--isolated` install: its config location can be redirected
 * by an env var so the copy stays separate from the real `~/.<agent>` (see
 * CONFIG_ENV_ISOLATED_AGENTS). */
export function supportsIsolatedInstall(agent: AgentId): boolean {
  return CONFIG_ENV_ISOLATED_AGENTS.includes(agent);
}

/** Harnesses that isolate by symlink-adopting `~/.<config>` rather than a config-dir env
 * (PHNX-3940 T5): one active slot per device, and `accounts default` repoints the symlink under
 * the auth-op lock. */
export function isSymlinkAdoptedHarness(agent: AgentId): boolean {
  return !CONFIG_ENV_ISOLATED_AGENTS.includes(agent);
}

/** Repoint this harness's adopted `~/.<config>` symlink at `home`'s config dir; no-op for env-
 * isolated harnesses. Fails loud when the adopted path is a real directory, since adopting that
 * is `agents use`, not default. */
export function repointAdoptedConfigToHome(agent: AgentId, home: string): { success: boolean; error?: string } {
  if (!isSymlinkAdoptedHarness(agent)) return { success: true };
  const lock = acquireAuthOperationLock(agent);
  try {
    lock.assertHeld();
    const configPath = getAgentConfigPath(agent);
    const configDirName = path.relative(os.homedir(), AGENTS[agent].configDir);
    const target = path.join(home, configDirName);
    fs.mkdirSync(target, { recursive: true });
    try {
      const stat = fs.lstatSync(configPath);
      if (stat.isSymbolicLink()) {
        const current = path.resolve(path.dirname(configPath), fs.readlinkSync(configPath));
        if (current === path.resolve(target)) return { success: true };
      } else {
        return {
          success: false,
          error: `${configPath} is not a symlink; refusing to replace a real config directory. `
            + `Run \`agents use ${agent}\` once to adopt it, then \`agents accounts default ${agent}\`.`,
        };
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    // Atomic retarget: create temp symlink, rename over existing (same pattern
    // as switchHomeFileSymlinks). A window of "path missing" would let a
    // harness process observe neither the old nor the new target.
    const tmpPath = `${configPath}.agents-tmp-${process.pid}`;
    try { fs.unlinkSync(tmpPath); } catch { /* leftover from a killed prior swap */ }
    try {
      fs.symlinkSync(target, tmpPath, process.platform === 'win32' ? 'junction' : undefined);
      fs.renameSync(tmpPath, configPath);
    } catch (err) {
      try { fs.unlinkSync(tmpPath); } catch { /* rename may have already consumed it */ }
      throw err;
    }
    return { success: true };
  } finally {
    lock.release();
  }
}

/** Generate a versioned alias script that directly execs a specific version (e.g. claude@2.0.65
 * runs that version's binary). */
export function generateVersionedAliasScript(agent: AgentId, version: string): string {
  assertSafeVersion(version);
  const agentConfig = AGENTS[agent];
  const agentsBin = shellQuote(getAgentsBinForGeneratedShim());
  // Same derivation as `generateShimScript` so nested layouts (e.g.,
  // Antigravity's `~/.gemini/antigravity-cli`) land in the right place.
  const configDirName = path.relative(os.homedir(), agentConfig.configDir);
  const managedEnv = agent === 'claude'
    ? `
# Reuse the main shim's Claude config-env verbatim (CLAUDE_CONFIG_DIR pin,
# autoupdater off, AND the Linux .oauth_token setup-token fallback), keyed to this
# version's home via VERSION_DIR. A hand-copied subset here had drifted and lost the
# .oauth_token fallback, so interactive runs on a keychain-less worker could not
# authenticate from the attached setup-token — the main shim (generateShimScript)
# already sources this same adapter block, so sharing it keeps the two in sync.
# plain (not exported) so it feeds shimConfigEnvBash below but never leaks into the
# launched agent process — matching the main shim's convention.
VERSION_DIR="$AGENTS_REAL_HOME/.agents/.history/versions/${agent}/${version}"
${resolveHarnessAdapter(agent).shimConfigEnvBash?.({ configDirName }) ?? ''}`
    : agent === 'codex'
      ? codexHomeShimBash(
          `$AGENTS_REAL_HOME/.agents/.history/versions/${agent}/${version}/home/${configDirName}`,
          `$AGENTS_REAL_HOME/.agents/.codex-homes/${version}`,
        )
      : agent === 'copilot'
        ? `
# Copilot honors COPILOT_HOME to relocate ~/.copilot (settings, mcp-config.json,
# session-state, logs). Point direct aliases at the versioned home so per-
# version MCP and session state are isolated.
${slotAwareConfigEnvBash([{ env: 'COPILOT_HOME', rel: configDirName }], `$AGENTS_REAL_HOME/.agents/.history/versions/${agent}/${version}/home`)}
`
        : agent === 'grok'
          ? `
# Grok Build uses GROK_HOME to isolate its entire configuration tree (skills,
# hooks, plugins, agents, memory, sessions, config.toml, MCP). Point direct
# aliases at the versioned home for isolation parity with the main shim.
${slotAwareConfigEnvBash([{ env: 'GROK_HOME', rel: configDirName }], `$AGENTS_REAL_HOME/.agents/.history/versions/${agent}/${version}/home`)}
`
          : agent === 'opencode'
            ? `
# OpenCode reads plugins, agents, commands, and other config-directory
# resources from OPENCODE_CONFIG_DIR. Point direct aliases at the versioned
# global config tree where agents-cli syncs OpenCode resources.
${slotAwareConfigEnvBash([{ env: 'OPENCODE_CONFIG_DIR', rel: '.config/opencode' }], `$AGENTS_REAL_HOME/.agents/.history/versions/${agent}/${version}/home`)}
`
          : agent === 'kimi'
            ? `
# Kimi Code CLI honors KIMI_CODE_HOME to relocate ~/.kimi-code (config.toml,
# mcp.json, sessions, skills, hooks). Point direct aliases at the versioned home.
${slotAwareConfigEnvBash([{ env: 'KIMI_CODE_HOME', rel: configDirName }], `$AGENTS_REAL_HOME/.agents/.history/versions/${agent}/${version}/home`)}
`
            : agent === 'muse'
              ? `
# Muse Code: no dedicated config env var. Pin XDG so config/sessions live under
# the version home as real directories (not via the adopt symlink at
# ~/.config/muse, which Muse rejects with SymlinkOrReparse).
${slotAwareConfigEnvBash([{ env: 'XDG_CONFIG_HOME', rel: '.config' }, { env: 'XDG_DATA_HOME', rel: '.local/share' }], `$AGENTS_REAL_HOME/.agents/.history/versions/${agent}/${version}/home`)}
`
              : agent === 'cursor'
                ? `
# Cursor defaults to one machine-global OS-keychain login on macOS. Force its
# file store and swap HOME, so ~/.cursor/auth.json belongs to this
# version and direct aliases cannot fall through to the shared keychain login.
# A spawner that already chose HOME (an account slot, PHNX-3940 T5 — it left
# the real home in AGENTS_REAL_HOME) keeps its choice: re-swapping here would
# silently discard the slot.
if [ "$HOME" = "$AGENTS_REAL_HOME" ]; then
  export HOME="$AGENTS_REAL_HOME/.agents/.history/versions/${agent}/${version}/home"
fi
export AGENT_CLI_CREDENTIAL_STORE="file"
`
                : '';
  const launchArgs = resolveHarnessAdapter(agent).shimLaunchArgs?.() ?? '';

  // Resolve the binary like the main shim. Grok (~/.grok/downloads) and Droid (~/.local/bin)
  // aren't in node_modules/.bin, and hardcoding it broke their aliases ("not installed"). Kimi
  // npm-installs into .bin; its old ~/.kimi-code path re-execed the dispatcher forever. Unix-only.
  const versionDir = `$AGENTS_REAL_HOME/.agents/.history/versions/${agent}/${version}`;
  const binaryResolution =
    agent === 'grok'
      ? `# Grok ships its native binary in the versioned home's .grok/downloads (or,
# for pre-fix installs, the global ~/.grok/downloads), not node_modules.
${GROK_RESOLVE_BINARY_FN}
BINARY=$(_resolve_grok_current "${versionDir}/home/.grok")
GROK_DOWNLOADS="${versionDir}/home/.grok/downloads"
if [ -z "$BINARY" ] && [ -d "$GROK_DOWNLOADS" ]; then
  BINARY=$(_resolve_grok_binary "$GROK_DOWNLOADS" "${version}")
fi
# Fall back to the global grok home (binary installed without GROK_HOME set).
if [ -z "$BINARY" ] || [ ! -x "$BINARY" ]; then
  BINARY=$(_resolve_grok_current "$AGENTS_REAL_HOME/.grok")
fi
if [ -z "$BINARY" ] || [ ! -x "$BINARY" ]; then
  GROK_GLOBAL_DOWNLOADS="$AGENTS_REAL_HOME/.grok/downloads"
  if [ -d "$GROK_GLOBAL_DOWNLOADS" ]; then
    BINARY=$(_resolve_grok_binary "$GROK_GLOBAL_DOWNLOADS" "${version}")
  fi
fi
# Refuse a PATH match under our own shims dir — it resolves to this alias's
# sibling dispatcher shim (shims dir is ahead of ~/.local/bin on PATH) and
# re-execs forever. Fall through to the clean "not installed" error instead.
if [ -z "$BINARY" ] || [ ! -x "$BINARY" ]; then
  BINARY=$(command -v grok 2>/dev/null || echo "")
  case "$BINARY" in
    "$AGENTS_REAL_HOME/.agents/.cache/shims/"*) BINARY="" ;;
  esac
fi`
      : agent === 'droid'
          ? `# Droid (Factory AI) installs a standalone native binary at ~/.local/bin/droid;
# there is no npm package and nothing lands in node_modules/.bin. The PATH
# fallback refuses anything under our shims dir to avoid an infinite re-exec.
DROID_BINARY="$AGENTS_REAL_HOME/.local/bin/droid"
if [ -x "$DROID_BINARY" ]; then
  BINARY="$DROID_BINARY"
else
  BINARY=$(command -v droid 2>/dev/null || echo "")
  case "$BINARY" in
    "$AGENTS_REAL_HOME/.agents/.cache/shims/"*) BINARY="" ;;
  esac
fi`
          : agent === 'muse'
            ? `# Muse Code installs a self-updating launcher at ~/.local/bin/muse.
MUSE_BINARY="$AGENTS_REAL_HOME/.local/bin/muse"
if [ -x "$MUSE_BINARY" ]; then
  BINARY="$MUSE_BINARY"
else
  BINARY=$(command -v muse 2>/dev/null || echo "")
  case "$BINARY" in
    "$AGENTS_REAL_HOME/.agents/.cache/shims/"*) BINARY="" ;;
  esac
fi`
          : agent === 'warp'
            ? `# Warp Agent CLI installs a global self-updating \`warp\` binary at
# ~/.local/bin/warp (curl installer) — like droid/muse — so resolve it from
# PATH, refusing anything under our shims dir.
BINARY=$(command -v warp 2>/dev/null || echo "")
case "$BINARY" in
  "$AGENTS_REAL_HOME/.agents/.cache/shims/"*) BINARY="" ;;
esac`
          : `BINARY="${versionDir}/node_modules/.bin/${agentConfig.cliCommand}"`;

  return `#!/bin/bash
# Auto-generated by agents-cli - do not edit
# ${VERSIONED_ALIAS_VERSION_MARKER} ${VERSIONED_ALIAS_SCHEMA_VERSION}
# Direct alias for ${agentConfig.name}@${version}

# The real home. A spawner may have swapped HOME already — an account slot
# launch (PHNX-3940 T5) sets HOME to the slot dir and leaves the real home in
# AGENTS_REAL_HOME — so every agents-owned path below (the installation, the
# version home, the shims dir) is anchored here, never on whatever HOME is now.
# Anchoring on HOME made a slot launch of cursor#<name> answer "not installed"
# and the launch lease fail with "No installation directory".
export AGENTS_REAL_HOME="\${AGENTS_REAL_HOME:-$HOME}"

${binaryResolution}

if [ -z "$BINARY" ] || [ ! -x "$BINARY" ]; then
  echo "agents: ${agent}@${version} not installed" >&2
  exit 1
fi

# Register a launch lease for THIS pid before the exec below (PHNX-3940) — see
# generateShimScript's identical call for what this closes and why it fails
# closed rather than falling through on error. \$\$ survives exec. It runs
# under the REAL home, before any harness HOME swap below: agents-cli's own
# state root is $HOME/.agents, so a swapped HOME cannot find the installation.
if ! HOME="$AGENTS_REAL_HOME" ${agentsBin} __launch-lease "${agent}" "${version}" "\$\$"; then
  echo "agents: could not safely coordinate this launch with a possibly in-progress update of ${agent}@${version}." >&2
  echo "  Check: agents update ${agent}@${version} --check    Retry once any update finishes." >&2
  exit 1
fi
${managedEnv}

${resolveHarnessAdapter(agent).shimExecTail?.(launchArgs) ?? `exec "$BINARY"${launchArgs} "$@"`}
`;
}

/** Read the schema version of an on-disk versioned alias; null if it doesn't exist or is pre-v2
 * (no marker, treated as stale). */
export function readVersionedAliasSchemaVersion(agent: AgentId, version: string): number | null {
  const aliasPath = versionedAliasOnDiskPath(agent, version);
  if (!fs.existsSync(aliasPath)) return null;
  try {
    const content = fs.readFileSync(aliasPath, 'utf8');
    const header = content.split('\n', 10).join('\n');
    const match = header.match(new RegExp(VERSIONED_ALIAS_VERSION_MARKER + '\\s*(\\d+)'));
    if (!match) return null;
    return Number(match[1]);
  } catch {
    return null;
  }
}

/**
 * True if the on-disk versioned alias matches the current schema version.
 */
export function isVersionedAliasCurrent(agent: AgentId, version: string): boolean {
  return readVersionedAliasSchemaVersion(agent, version) === VERSIONED_ALIAS_SCHEMA_VERSION;
}

/** Regenerate a versioned alias if missing or stale, mirroring ensureShimCurrent; callers can
 * surface a one-line notice on upgrade. */
export function ensureVersionedAliasCurrent(agent: AgentId, version: string): 'created' | 'updated' | 'current' {
  if (!fs.existsSync(versionedAliasOnDiskPath(agent, version))) {
    createVersionedAlias(agent, version);
    return 'created';
  }
  // A lingering extensionless bash alias on Windows shadows the `.cmd` (the dotted version reads as
  // an extension and beats PATHEXT), opening the `.sh` editor instead of launching. Regenerate
  // regardless of the `.cmd`'s stamp so the shadow is deleted.
  if (shimTargetsFor(process.platform).cmd && fs.existsSync(getVersionedAliasPath(agent, version))) {
    createVersionedAlias(agent, version);
    return 'updated';
  }
  // Upgrade-only (newest-wins), same rationale as ensureShimCurrent: never
  // downgrade an alias stamped by a newer install sharing the shims dir.
  const onDisk = readVersionedAliasSchemaVersion(agent, version);
  if (onDisk === null || onDisk < VERSIONED_ALIAS_SCHEMA_VERSION) {
    createVersionedAlias(agent, version);
    return 'updated';
  }
  return 'current';
}

/** The filesystem path for a versioned alias: the logical, extensionless launch name. On Windows
 * it is not a real file (see versionedAliasOnDiskFile), so stat/read checks must use the on-
 * disk path. */
export function getVersionedAliasPath(agent: AgentId, version: string): string {
  return path.join(getShimsDir(), `${AGENTS[agent].cliCommand}@${version}`);
}

/** The file createVersionedAlias actually writes: `<cmd>@<version>.cmd` on Windows, the bare
 * bash script on POSIX. Pure; mirrors onDiskShimFile. */
export function versionedAliasOnDiskFile(cliCommand: string, version: string, platform: NodeJS.Platform): string {
  const name = `${cliCommand}@${version}`;
  return shimTargetsFor(platform).cmd ? `${name}.cmd` : name;
}

/** The on-disk versioned-alias path for the current platform. */
function versionedAliasOnDiskPath(agent: AgentId, version: string): string {
  return path.join(getShimsDir(), versionedAliasOnDiskFile(AGENTS[agent].cliCommand, version, process.platform));
}

/** Create a versioned alias (e.g. claude@2.0.65): POSIX writes the bash script, Windows only the
 * `.cmd`. A bash alias beside the `.cmd` is harmful: the dotted version reads as an extension,
 * so the shell opens it in the `.sh` editor. Any legacy bash alias is deleted. */
export function createVersionedAlias(agent: AgentId, version: string): string {
  assertSafeVersion(version);
  ensureAgentsDir();
  const shimsDir = getShimsDir();
  const agentConfig = AGENTS[agent];
  const aliasPath = path.join(shimsDir, `${agentConfig.cliCommand}@${version}`);

  const targets = shimTargetsFor(process.platform);
  if (targets.bash) {
    fs.writeFileSync(aliasPath, generateVersionedAliasScript(agent, version), { mode: 0o755 });
  } else {
    try { fs.unlinkSync(aliasPath); } catch {}
  }
  if (targets.cmd) {
    writeWindowsCmdShim(
      aliasPath + '.cmd',
      `${agentConfig.cliCommand}@${version}`,
      [`${VERSIONED_ALIAS_VERSION_MARKER} ${VERSIONED_ALIAS_SCHEMA_VERSION}`],
    );
  }

  return aliasPath;
}

/** Remove a versioned alias, whichever companions exist (the extensionless script, or a legacy
 * Windows copy, and the `.cmd`), mirroring removeShim. */
export function removeVersionedAlias(agent: AgentId, version: string): boolean {
  const aliasPath = getVersionedAliasPath(agent, version);

  let removed = false;
  for (const p of [aliasPath, aliasPath + '.cmd']) {
    if (fs.existsSync(p)) {
      fs.unlinkSync(p);
      removed = true;
    }
  }
  return removed;
}

/**
 * Check if a versioned alias exists (the on-disk artifact for this platform).
 */
export function versionedAliasExists(agent: AgentId, version: string): boolean {
  return fs.existsSync(versionedAliasOnDiskPath(agent, version));
}

/** Get the agent's config directory path in HOME (e.g. ~/.claude). */
export function getAgentConfigPath(agent: AgentId): string {
  const agentConfig = AGENTS[agent];
  const home = process.env.AGENTS_REAL_HOME || os.homedir();
  return agentConfig.configDir.replace(os.homedir(), home);
}

/** Read the user's configured Codex model from `~/.codex/config.toml`. A dispatch pinned to a
 * version whose home lacks a top-level `model` falls back to Codex's built-in default, which
 * ChatGPT-tier accounts can't use (HTTP 400). Forwarding it via `--model` avoids that. */
export function readCodexConfiguredModel(): string | undefined {
  try {
    const cfg = path.join(getAgentConfigPath('codex'), 'config.toml');
    const text = fs.readFileSync(cfg, 'utf-8');
    // Only trust keys before the first [table]; a `model` under [profile.x] is
    // not the default the CLI uses at top level.
    const topLevel = text.split(/^\s*\[/m)[0];
    return topLevel.match(/^\s*model\s*=\s*["']([^"']+)["']/m)?.[1];
  } catch {
    return undefined;
  }
}

/** Get the version-home config directory path. */
function getVersionConfigPath(agent: AgentId, version: string): string {
  const agentConfig = AGENTS[agent];
  const versionsDir = getVersionsDir();
  // Use the agent's full configDir subpath so nested layouts (e.g. antigravity) work.
  const configDirName = path.relative(os.homedir(), agentConfig.configDir);
  return path.join(versionsDir, agent, version, 'home', configDirName);
}

/** Detect conflicts between the current config directory and the target version home. */
function detectMigrationConflicts(agent: AgentId, version: string): ConflictInfo | null {
  const configPath = getAgentConfigPath(agent);
  const versionConfigPath = getVersionConfigPath(agent, version);

  try {
    const stat = fs.lstatSync(configPath);

    if (stat.isSymbolicLink()) {
      // Already a symlink - no migration needed, no conflicts
      return null;
    } else if (stat.isDirectory()) {
      // Real directory exists - would need migration
      // Detect conflicts between user's current config and version home
      const conflicts = detectConflicts(configPath, versionConfigPath);
      return {
        agent,
        version,
        conflicts,
      };
    }
    // Not a directory or symlink - unusual, no conflicts to report
    return null;
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      // Config path doesn't exist - no migration needed
      return null;
    }
    return null;
  }
}

/** Best-effort account identity for a file-auth agent's credential directory; null when no decodable account claim exists. */
export function readAuthFileIdentity(agent: AgentId, configDir: string): string | null {
  return readAuthAccountIdentity(agent, configDir);
}

/** Carry the freshest existing account credential into `toConfigDir` so version switches don't log out file-auth agents. */
export function carryForwardAuthFiles(agent: AgentId, toConfigDir: string): void {
  const authFiles = AGENTS[agent].authFiles;
  if (!authFiles || authFiles.length === 0) return;

  const configDirName = agentConfigDirName(agent);
  const versionsBase = path.join(getVersionsDir(), agent);
  let sourceDirs: string[] = [];
  try {
    sourceDirs = fs
      .readdirSync(versionsBase)
      .map(v => path.join(versionsBase, v, 'home', configDirName));
  } catch {
    return; // no installed versions to source from
  }

  // Account identity currently installed at the destination (null if empty or undecodable). When
  // known, only a source with the same account may overwrite it, so another account's newer login
  // can't replace the signed-in one (RUSH-1764). Droid identity gates both auth files as a unit.
  const toResolved = path.resolve(toConfigDir);
  const destIdentity = readAuthFileIdentity(agent, toConfigDir);
  const identityCache = new Map<string, string | null>();
  const dirIdentity = (dir: string): string | null => {
    const key = path.resolve(dir);
    if (!identityCache.has(key)) identityCache.set(key, readAuthFileIdentity(agent, dir));
    return identityCache.get(key) ?? null;
  };

  for (const rel of authFiles) {
    const dest = path.join(toConfigDir, rel);
    const destResolved = path.resolve(dest);

    // Newest existing source copy across all version homes (excluding dest),
    // constrained to the destination's account identity when it is known.
    let newest: { path: string; mtimeMs: number } | null = null;
    for (const dir of sourceDirs) {
      if (path.resolve(dir) === toResolved) continue; // never source from self
      const src = path.join(dir, rel);
      if (path.resolve(src) === destResolved) continue;
      let st: fs.Stats;
      try { st = fs.statSync(src); } catch { continue; }
      if (!st.isFile()) continue;
      // Account-identity guard: never carry a different account's credential over
      // an existing login. Only enforced when the destination's identity is known.
      if (destIdentity !== null && dirIdentity(dir) !== destIdentity) continue;
      if (!newest || st.mtimeMs > newest.mtimeMs) newest = { path: src, mtimeMs: st.mtimeMs };
    }
    if (!newest) continue;

    // Skip when the target already has an at-least-as-fresh copy.
    try {
      const dstat = fs.statSync(dest);
      if (dstat.mtimeMs >= newest.mtimeMs) continue;
    } catch { /* dest missing — copy below */ }

    try {
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      const srcStat = fs.statSync(newest.path);
      fs.copyFileSync(newest.path, dest);
      fs.chmodSync(dest, (srcStat.mode & 0o777) || 0o600);
      fs.utimesSync(dest, srcStat.atime, srcStat.mtime);
    } catch { /* best-effort; a failed carry just means a re-login */ }
  }
}

/** Switch the agent's config symlink to point at a specific version, backing up any real directory first. */
export async function switchConfigSymlink(
  agent: AgentId,
  version: string
): Promise<{ success: boolean; backupPath?: string; error?: string }> {
  // Moves the user's real ~/.<agent> aside and symlinks it into a version home.
  assertIsolationBoundary(agent, 'repoint your real config directory');
  const configPath = getAgentConfigPath(agent);
  const versionConfigPath = getVersionConfigPath(agent, version);

  // Ensure version config directory exists
  if (!fs.existsSync(versionConfigPath)) {
    fs.mkdirSync(versionConfigPath, { recursive: true });
  }

  // Carry the account credential into the version being switched to: droid/antigravity/kimi store
  // login inside the per-version home, so repointing the symlink would silently log the CLI out.
  // Seed the target with the freshest credential first.
  carryForwardAuthFiles(agent, versionConfigPath);

  try {
    const stat = fs.lstatSync(configPath);

    if (stat.isSymbolicLink()) {
      // Already a symlink - check if it points to the correct target
      const currentTarget = fs.readlinkSync(configPath);
      const resolvedCurrent = path.resolve(path.dirname(configPath), currentTarget);
      const resolvedTarget = path.resolve(versionConfigPath);
      if (resolvedCurrent === resolvedTarget) {
        // Already pointing to correct target, no-op
        return { success: true };
      }
      // openclaw mixes user data (config, db, per-agent workspaces, memory/) with the version home,
      // so swapping the symlink strips every agent's data. Carry it into the new home first (keep-
      // dest). Other agents keep user data outside the version home.
      if (agent === 'openclaw') {
        try {
          if (fs.existsSync(resolvedCurrent) && fs.statSync(resolvedCurrent).isDirectory()) {
            await copyDirContents(resolvedCurrent, versionConfigPath, 'keep-dest');
          }
        } catch (migrationErr) {
          console.error(
            `Warning: openclaw data migration from ${resolvedCurrent} -> ${versionConfigPath} ` +
              `failed: ${(migrationErr as Error).message}. The previous version's data is intact ` +
              `at the old path; you can copy it manually if needed.`
          );
        }
      }
      // Different target - update it
      fs.unlinkSync(configPath);
      fs.mkdirSync(path.dirname(configPath), { recursive: true });
      fs.symlinkSync(versionConfigPath, configPath, process.platform === 'win32' ? 'junction' : undefined);
      return { success: true };
    } else if (stat.isDirectory()) {
      // Real directory exists - backup and replace with symlink
      const timestamp = Date.now();

      // Move to backup location
      const backupsDir = getBackupsDir();
      const agentBackupDir = path.join(backupsDir, agent);
      const finalBackupPath = path.join(agentBackupDir, String(timestamp));
      fs.mkdirSync(agentBackupDir, { recursive: true });
      fs.renameSync(configPath, finalBackupPath);

      // Session JSONLs under the old configPath just moved to the backup path, so rewrite DB rows
      // with the old prefix to stop phantom rows (issue #136). Dynamic import so loading shims.ts
      // doesn't open the sessions DB (tests partially mock state.js).
      try {
        const { updateSessionFilePaths } = await import('../session/db.js');
        updateSessionFilePaths(configPath, finalBackupPath);
      } catch (err) {
        console.error(
          `Warning: failed to update session file_paths after backing up ${configPath}: ` +
            `${(err as Error).message}. Stale rows may appear in session listings until the next scan.`
        );
      }

      // Create symlink (parent already exists since the dir we just moved was here)
      fs.symlinkSync(versionConfigPath, configPath, process.platform === 'win32' ? 'junction' : undefined);

      return { success: true, backupPath: finalBackupPath };
    } else {
      return { success: false, error: `${configPath} exists but is not a directory or symlink` };
    }
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      // Config path doesn't exist - create symlink.
      // For nested layouts (e.g., ~/.gemini/antigravity-cli) the parent dir
      // may also be missing if the parent agent (Gemini) is not installed.
      fs.mkdirSync(path.dirname(configPath), { recursive: true });
      fs.symlinkSync(versionConfigPath, configPath, process.platform === 'win32' ? 'junction' : undefined);
      return { success: true };
    }
    return { success: false, error: (err as Error).message };
  }
}

/** Switch home-level files (outside the config dir) to per-version symlinks, e.g. ~/.claude.json
 * to the version home's copy. Atomic rename avoids data loss with a running session; first
 * migration merges global auth into all installed versions. */
export function switchHomeFileSymlinks(
  agent: AgentId,
  version: string
): { switched: string[]; errors: string[] } {
  // Same, for home-level files such as ~/.claude.json.
  assertIsolationBoundary(agent, 'repoint your home-level config files');
  const agentConfig = AGENTS[agent];
  const homeFiles = agentConfig.homeFiles;
  if (!homeFiles || homeFiles.length === 0) return { switched: [], errors: [] };

  const home = process.env.AGENTS_REAL_HOME || os.homedir();
  const versionsDir = getVersionsDir();
  const switched: string[] = [];
  const errors: string[] = [];

  // Claude reads CLAUDE_CONFIG_DIR/.claude.json (inside the per-version .claude dir), not the home-
  // level file this function manages; reconcile every installed Claude version so INSIDE is a
  // symlink to OUTSIDE, the single source of truth.
  if (agent === 'claude') {
    const reconcile = ensureAllClaudeInsideSymlinks();
    for (const e of reconcile.errors) errors.push(e);
  }

  for (const fileName of homeFiles) {
    const globalPath = path.join(home, fileName);
    const versionFilePath = path.join(versionsDir, agent, version, 'home', fileName);

    try {
      // Ensure version home dir exists
      const versionFileDir = path.dirname(versionFilePath);
      if (!fs.existsSync(versionFileDir)) {
        fs.mkdirSync(versionFileDir, { recursive: true });
      }

      let stat: fs.Stats | null = null;
      try {
        stat = fs.lstatSync(globalPath);
      } catch {
        // File doesn't exist at global path — just create symlink
        if (!fs.existsSync(versionFilePath)) {
          fs.writeFileSync(versionFilePath, '{}');
        }
        fs.symlinkSync(versionFilePath, globalPath);
        switched.push(fileName);
        continue;
      }

      if (stat.isSymbolicLink()) {
        // Already a symlink — retarget atomically
        const currentTarget = fs.readlinkSync(globalPath);
        const resolvedCurrent = path.resolve(path.dirname(globalPath), currentTarget);
        const resolvedTarget = path.resolve(versionFilePath);
        if (resolvedCurrent === resolvedTarget) {
          switched.push(fileName);
          continue; // Already correct
        }
        // Atomic retarget: create temp symlink, rename over existing
        if (!fs.existsSync(versionFilePath)) {
          fs.writeFileSync(versionFilePath, '{}');
        }
        const tmpPath = `${globalPath}.agents-tmp-${process.pid}`;
        fs.symlinkSync(versionFilePath, tmpPath);
        fs.renameSync(tmpPath, globalPath);
        switched.push(fileName);
      } else if (stat.isFile()) {
        // Real file — first-time migration
        // Read the global file content
        let globalContent: Record<string, unknown>;
        try {
          globalContent = JSON.parse(fs.readFileSync(globalPath, 'utf-8'));
        } catch (err) {
          errors.push(`${fileName}: Could not parse ${globalPath}: ${(err as Error).message}`);
          continue;
        }

        // Merge auth into ALL installed version files for this agent
        const agentVersionsDir = path.join(versionsDir, agent);
        if (fs.existsSync(agentVersionsDir)) {
          for (const ver of fs.readdirSync(agentVersionsDir)) {
            const verFilePath = path.join(agentVersionsDir, ver, 'home', fileName);
            const verFileDir = path.dirname(verFilePath);
            if (!fs.existsSync(verFileDir)) {
              fs.mkdirSync(verFileDir, { recursive: true });
            }
            if (fs.existsSync(verFilePath)) {
              // Merge: version-specific fields + global auth fields
              try {
                const verContent = JSON.parse(fs.readFileSync(verFilePath, 'utf-8'));
                const merged = { ...globalContent, ...verContent };
                // Ensure auth from global always wins
                if (globalContent.oauthAccount) {
                  merged.oauthAccount = globalContent.oauthAccount;
                }
                fs.writeFileSync(verFilePath, JSON.stringify(merged, null, 2));
              } catch {
                // If version file is invalid JSON, overwrite with global
                fs.writeFileSync(verFilePath, JSON.stringify(globalContent, null, 2));
              }
            } else {
              // No version file — copy global wholesale
              fs.writeFileSync(verFilePath, JSON.stringify(globalContent, null, 2));
            }
          }
        }

        // Atomic swap: create temp symlink to target version, rename over real file
        const tmpPath = `${globalPath}.agents-tmp-${process.pid}`;
        fs.symlinkSync(versionFilePath, tmpPath);
        fs.renameSync(tmpPath, globalPath);
        switched.push(fileName);
      }
    } catch (err) {
      errors.push(`${fileName}: ${(err as Error).message}`);
    }
  }

  return { switched, errors };
}

/** Claude reads `$CLAUDE_CONFIG_DIR/.claude.json` (INSIDE the version's .claude dir) while
 * `switchHomeFileSymlinks` manages `<ver>/home/.claude.json` (OUTSIDE). Make INSIDE a symlink
 * to OUTSIDE; a real INSIDE file merges into OUTSIDE first (INSIDE wins for `oauthAccount`). */
export function ensureClaudeInsideSymlink(version: string): void {
  const versionsDir = getVersionsDir();
  const versionHome = path.join(versionsDir, 'claude', version, 'home');
  const outsidePath = path.join(versionHome, '.claude.json');
  const insideDir = path.join(versionHome, '.claude');
  const insidePath = path.join(insideDir, '.claude.json');
  const linkTarget = '../.claude.json'; // relative so version dir can be moved

  if (!fs.existsSync(insideDir)) {
    fs.mkdirSync(insideDir, { recursive: true });
  }

  let insideStat: fs.Stats | null = null;
  try {
    insideStat = fs.lstatSync(insidePath);
  } catch {
    /* INSIDE does not exist */
  }

  if (insideStat?.isSymbolicLink()) {
    const currentTarget = fs.readlinkSync(insidePath);
    if (currentTarget === linkTarget) return;
    // Wrong target — replace.
    if (!fs.existsSync(outsidePath)) fs.writeFileSync(outsidePath, '{}');
    fs.unlinkSync(insidePath);
    fs.symlinkSync(linkTarget, insidePath);
    return;
  }

  if (insideStat?.isFile()) {
    // INSIDE is the authoritative file — Claude has been reading/writing it.
    // Merge INSIDE into OUTSIDE, with INSIDE winning on every field, then
    // replace INSIDE with a symlink.
    let insideContent: Record<string, unknown> = {};
    try {
      insideContent = JSON.parse(fs.readFileSync(insidePath, 'utf-8'));
    } catch {
      /* INSIDE corrupt — treat as empty; OUTSIDE preserved as-is */
    }

    let outsideContent: Record<string, unknown> = {};
    if (fs.existsSync(outsidePath)) {
      try {
        outsideContent = JSON.parse(fs.readFileSync(outsidePath, 'utf-8'));
      } catch {
        /* OUTSIDE corrupt — drop it */
      }
    }

    const merged = { ...outsideContent, ...insideContent };
    fs.writeFileSync(outsidePath, JSON.stringify(merged, null, 2));
    fs.unlinkSync(insidePath);
    fs.symlinkSync(linkTarget, insidePath);
    return;
  }

  // INSIDE missing — ensure OUTSIDE exists, then create symlink.
  if (!fs.existsSync(outsidePath)) fs.writeFileSync(outsidePath, '{}');
  fs.symlinkSync(linkTarget, insidePath);
}

/** Apply `ensureClaudeInsideSymlink` to every installed Claude version; safe to repeat, since
 * each call is idempotent. */
function ensureAllClaudeInsideSymlinks(): { migrated: string[]; errors: string[] } {
  const versionsDir = getVersionsDir();
  const claudeVersionsDir = path.join(versionsDir, 'claude');
  const migrated: string[] = [];
  const errors: string[] = [];

  if (!fs.existsSync(claudeVersionsDir)) return { migrated, errors };

  for (const entry of fs.readdirSync(claudeVersionsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    try {
      ensureClaudeInsideSymlink(entry.name);
      migrated.push(entry.name);
    } catch (err) {
      errors.push(`${entry.name}: ${(err as Error).message}`);
    }
  }

  return { migrated, errors };
}

/**
 * Get the current config symlink target version, if any.
 */
export function getConfigSymlinkVersion(agent: AgentId): string | null {
  const configPath = getAgentConfigPath(agent);

  try {
    const stat = fs.lstatSync(configPath);
    if (!stat.isSymbolicLink()) {
      return null;
    }

    // Normalize separators so this matches on Windows too — readlinkSync there
    // returns backslash paths, which the forward-slash-only regex never matched
    // (misclassifying an owned symlink as foreign, e.g. in `agents uninstall`).
    const target = fs.readlinkSync(configPath).replace(/\\/g, '/');
    // Extract version from path like ~/.agents/versions/claude/2.0.65/home/.claude
    const match = target.match(/versions\/[^/]+\/([^/]+)\/home/);
    return match ? match[1] : null;
  } catch {
    /* config path not accessible or not a symlink */
    return null;
  }
}

/**
 * Context for conflict resolution prompts.
 */
interface CopyContext {
  agent: AgentId;
  version: string;
}

/** Copy directory contents with a configurable conflict strategy ('keep-dest', 'overwrite' or
 * 'ask-per-file'; `context` is used only for prompts). Skips when dest is a symlink (managed
 * resources that must not be overwritten). */
async function copyDirContents(
  src: string,
  dest: string,
  strategy: ConflictStrategy = 'keep-dest',
  context?: CopyContext
): Promise<void> {
  // If dest is a symlink, skip - these are managed resources (skills, commands, etc.)
  // that link to central ~/.agents/ and shouldn't be overwritten with local copies
  try {
    const destStat = fs.lstatSync(dest);
    if (destStat.isSymbolicLink()) {
      return; // Skip - don't copy into symlinked directories
    }
  } catch {
    // dest doesn't exist, that's fine
  }

  if (!fs.existsSync(dest)) {
    fs.mkdirSync(dest, { recursive: true });
  }

  const entries = fs.readdirSync(src, { withFileTypes: true });
  for (const entry of entries) {
    // Skip files/directories that should never be migrated
    if (shouldIgnore(entry.name)) {
      continue;
    }

    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);

    // Skip if dest entry is a symlink (managed resource)
    try {
      const entryDestStat = fs.lstatSync(destPath);
      if (entryDestStat.isSymbolicLink()) {
        continue; // Skip - managed resource
      }
    } catch {
      // dest entry doesn't exist, that's fine
    }

    if (entry.isDirectory()) {
      await copyDirContents(srcPath, destPath, strategy, context);
    } else if (entry.isSymbolicLink()) {
      const linkTarget = fs.readlinkSync(srcPath);
      if (fs.existsSync(destPath)) {
        fs.unlinkSync(destPath);
      }
      fs.symlinkSync(linkTarget, destPath);
    } else {
      // File - check for conflict
      if (fs.existsSync(destPath)) {
        // Handle based on strategy
        if (strategy === 'keep-dest') {
          // Keep existing file, skip copying
          continue;
        } else if (strategy === 'overwrite') {
          // Back up and overwrite
          fs.copyFileSync(destPath, `${destPath}.backup`);
        } else if (strategy === 'ask-per-file') {
          // Back up dest file
          fs.copyFileSync(destPath, `${destPath}.backup`);

          // Ask user with context - use clear path-based terminology
          const agentConfig = context ? AGENTS[context.agent] : null;
          const versionLabel = agentConfig
            ? `${agentConfig.name}@${context!.version}`
            : 'version';
          const useMyFile = await confirm({
            message: `${entry.name}: Use your config file instead of ${versionLabel}?`,
            default: false, // Default to keep version (safer)
          });

          if (!useMyFile) {
            continue; // Keep dest (version file), skip copying src
          }
        }
      }
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

/** The on-disk shim filename for a platform: `<cmd>.cmd` on Windows, bare `<cmd>` on POSIX. */
export function onDiskShimFile(cliCommand: string, platform: NodeJS.Platform): string {
  return shimTargetsFor(platform).cmd ? `${cliCommand}.cmd` : cliCommand;
}

/** The actual on-disk shim path for the current platform. */
function onDiskShimPath(agent: AgentId): string {
  return path.join(getShimsDir(), onDiskShimFile(AGENTS[agent].cliCommand, process.platform));
}

/** Check whether the on-disk shim exists for an agent. */
export function shimExists(agent: AgentId): boolean {
  return fs.existsSync(onDiskShimPath(agent));
}

/** Read the schema version from the on-disk shim header, or null if missing/unreadable. */
function readShimSchemaVersion(agent: AgentId): number | null {
  if (!shimExists(agent)) return null;
  try {
    const content = fs.readFileSync(onDiskShimPath(agent), 'utf8');
    // Look at the first ~10 lines only — the marker lives in the header.
    const header = content.split('\n', 10).join('\n');
    const match = header.match(new RegExp(SHIM_VERSION_MARKER + '\\s*(\\d+)'));
    if (!match) return null;
    return Number(match[1]);
  } catch {
    return null;
  }
}

/** True when the on-disk shim's schema version matches the current schema. */
export function isShimCurrent(agent: AgentId): boolean {
  const version = readShimSchemaVersion(agent);
  return version === SHIM_SCHEMA_VERSION;
}

/** Extract the baked `AGENTS_BIN='...'` value from a shim file, or null. */
function readAgentsBinFromShim(shimPath: string): string | null {
  try {
    const header = fs.readFileSync(shimPath, 'utf8').split('\n', 12).join('\n');
    const m = header.match(/^AGENTS_BIN=(?:'([^']*)'|"([^"]*)"|(\S+))/m);
    return m ? (m[1] ?? m[2] ?? m[3] ?? null) : null;
  } catch {
    return null;
  }
}

/** True when the shim's baked `AGENTS_BIN` is fine to keep: it points at the install we'd
 * generate, or at another install that still exists (regenerating could ping-pong live
 * installs). False only for a removed install (deleted dev build, rotated version dir). */
export function shimPointsAtLiveInstall(agent: AgentId): boolean {
  if (!shimExists(agent)) return true; // missing shim is handled by ensureShimCurrent
  const baked = readAgentsBinFromShim(onDiskShimPath(agent));
  if (!baked) return true;
  if (baked === getAgentsBinForGeneratedShim()) return true; // already the current install
  return fs.existsSync(baked); // a different install — keep only while it still exists
}

/** Shim files in the shims dir, excluding the hooks/ subdir and @-versioned aliases. */
export function listShimFileNames(): string[] {
  try {
    return fs
      .readdirSync(getShimsDir(), { withFileTypes: true })
      .filter((e) => e.isFile() && !e.name.includes('@'))
      .map((e) => e.name);
  } catch {
    return [];
  }
}

/** Legacy command shims wrong even when their baked install is alive (`secrets`, `sessions`,
 * `computer`, `browser`; PHNX-3989/4012/4075/4101): they `exec agents <name>`, a passthrough to
 * the standalone binary, so they re-enter themselves (fork bomb). Pruned. */
const LEGACY_SHIMS_ALWAYS_PRUNED: ReadonlySet<string> = new Set(['secrets', 'sessions', 'computer', 'pty', 'browser']);

/** Prune a stale orphaned command shim (not an agent shim or user alias) whose baked
 * `AGENTS_BIN` points at a removed install; it would exit 127 or shadow the real package bin.
 * Removed only when the target is gone, except LEGACY_SHIMS_ALWAYS_PRUNED. */
export function pruneOrphanedCommandShim(fileName: string): boolean {
  // Never touch a shim that corresponds to a real agent — agents-cli manages those.
  const isAgentCommand = Object.values(AGENTS).some((a) => a.cliCommand === fileName);
  if (isAgentCommand) return false;

  const shimPath = path.join(getShimsDir(), fileName);
  let content: string;
  try {
    content = fs.readFileSync(shimPath, 'utf8');
  } catch {
    return false;
  }
  if (content.includes('# Alias shim:')) return false; // a user `agents setup alias` shim — leave it
  const bin = readAgentsBinFromShim(shimPath);
  if (!bin) return false; // not an AGENTS_BIN-baked shim
  if (fs.existsSync(bin) && !LEGACY_SHIMS_ALWAYS_PRUNED.has(fileName)) return false; // its install is still alive — leave it

  try {
    fs.rmSync(shimPath);
    return true;
  } catch {
    return false;
  }
}

/** Regenerate the shim if missing or older than the current schema; never downgrade a newer on-disk shim. */
export function ensureShimCurrent(agent: AgentId): 'created' | 'updated' | 'current' {
  if (!shimExists(agent)) {
    createShim(agent);
    return 'created';
  }
  // Upgrade-only: avoid ping-pong between two installs sharing the shims dir.
  const onDisk = readShimSchemaVersion(agent);
  if (onDisk === null || onDisk < SHIM_SCHEMA_VERSION) {
    createShim(agent);
    return 'updated';
  }
  return 'current';
}

/** Refresh only existing generated launchers before unattended binary changes. */
export function refreshOwnedLaunchers(agent: AgentId, label: string): void {
  const owned = (file: string): boolean => {
    try { return fs.readFileSync(file, 'utf8').includes('Auto-generated by agents-cli - do not edit'); }
    catch (err: any) { if (err.code === 'ENOENT') return false; throw err; }
  };
  if (owned(onDiskShimPath(agent))) ensureShimCurrent(agent);
  if (owned(versionedAliasOnDiskPath(agent, label))) ensureVersionedAliasCurrent(agent, label);
}

/** Get the logical (extensionless) shim path for an agent. */
export function getShimPath(agent: AgentId): string {
  const shimsDir = getShimsDir();
  const agentConfig = AGENTS[agent];
  return path.join(shimsDir, agentConfig.cliCommand);
}

/** Return the first executable on PATH that would shadow the managed shim, excluding the shim itself and legacy pre-split files. */
export function getPathShadowingExecutable(
  agent: AgentId,
  overrides?: { pathDirs?: string[]; shimPath?: string },
): string | null {
  const pathDirs = overrides?.pathDirs ?? (process.env.PATH || '').split(path.delimiter).filter(Boolean);
  const shimPath = path.resolve(overrides?.shimPath ?? getShimPath(agent));
  const cliCommand = AGENTS[agent].cliCommand;
  const legacyUserShim = path.resolve(path.join(os.homedir(), '.agents', 'shims', cliCommand));
  const managedShimExists = fs.existsSync(shimPath);

  // The shim's own realpath — an adopted launcher is a symlink at a DIFFERENT
  // path that resolves here, so identity must be by resolved target, not the
  // literal path string.
  const shimReal = managedShimExists ? canonicalOrNull(shimPath) : null;

  for (const dir of pathDirs) {
    const candidate = path.resolve(dir, cliCommand);
    if (!fs.existsSync(candidate)) {
      continue;
    }
    if (candidate === shimPath) return null;
    // Adopted launcher: a symlink we repointed at our shim resolves to the same file, so it is not
    // a shadow; otherwise every adopted default would be re-flagged forever, resurfacing the false
    // "runs a native binary" note.
    if (shimReal && canonicalOrNull(candidate) === shimReal) return null;
    if (candidate === legacyUserShim && managedShimExists) {
      // Legacy file from the pre-split layout. Don't treat as shadow — the
      // repair flow deletes it via removeLegacyUserShim instead. Continue
      // scanning so a real binary later in PATH is still detected.
      continue;
    }
    return candidate;
  }

  return null;
}

/** Delete the legacy ~/.agents/shims/<cli> file if present. Pre-split installs used that path,
 * and the leftover caused the repair-prompt loop (PROJ-789): `getPathShadowingExecutable` flags
 * it but `addShimsToPath` only edits rc files. */
export function removeLegacyUserShim(agent: AgentId, overrides?: { homeDir?: string }): boolean {
  const cliCommand = AGENTS[agent].cliCommand;
  const homeDir = overrides?.homeDir || os.homedir();
  const legacyPath = path.join(homeDir, '.agents', 'shims', cliCommand);
  if (!fs.existsSync(legacyPath)) return false;
  // Belt-and-suspenders: only remove if the current managed shim location is
  // different (it always should be — getShimsDir() returns the system dir —
  // but guard against future refactors that might collapse the two).
  const currentShim = path.resolve(getShimPath(agent));
  if (path.resolve(legacyPath) === currentShim) return false;
  try {
    fs.unlinkSync(legacyPath);
    // Best-effort: clean up the legacy shims dir if empty.
    try {
      const legacyDir = path.dirname(legacyPath);
      if (fs.readdirSync(legacyDir).length === 0) fs.rmdirSync(legacyDir);
    } catch { /* best-effort */ }
    return true;
  } catch {
    return false;
  }
}

/** Where an adopted launcher's provenance is recorded: durable `.history` (not the regenerable
 * `.cache`) so the pointer to the native binary survives a cache wipe. Line 1 = original
 * binary, line 2 = launcher path (for `--release`). */
export function getAdoptedRecordPath(agent: AgentId, historyDir: string = getHistoryDir()): string {
  return path.join(historyDir, 'adopted-launchers', AGENTS[agent].cliCommand);
}

/** The launcher a harness's own installer drops in an early-PATH dir. Detection keys on a
 * symlink resolving outside our shims dir, not PATH order, since the shim loses PATH races only
 * in non-interactive shells an `agents` run can't observe. */
export function findAdoptableLauncher(
  agent: AgentId,
  overrides?: { homeDir?: string; shimsDir?: string },
): string | null {
  const cliCommand = AGENTS[agent].cliCommand;
  const homeDir = overrides?.homeDir ?? os.homedir();
  const shimsDirReal = canonical(overrides?.shimsDir ?? getShimsDir());
  // ~/.local/bin is where grok/kimi/antigravity/claude/codex/droid self-install.
  const candidate = path.join(homeDir, '.local', 'bin', cliCommand);
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(candidate);
  } catch {
    return null;
  }
  if (!stat.isSymbolicLink()) return null; // real binaries are never auto-adopted
  let resolved: string;
  try {
    resolved = fs.realpathSync(candidate); // broken symlink throws → skip
  } catch {
    return null;
  }
  // Already ours, or resolves into our shims dir → not adoptable.
  if (resolved === shimsDirReal || resolved.startsWith(shimsDirReal + path.sep)) return null;
  return candidate;
}

/** Canonical path for identity comparison — realpath when it exists (resolves
 * symlinks AND platform aliases like macOS /var → /private/var), else resolve. */
function canonical(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

/** Like canonical(), but null when the path can't be resolved (broken/racy
 * symlink) — used where a failed resolve must NOT collapse to the input path. */
function canonicalOrNull(p: string): string | null {
  try {
    return fs.realpathSync(p);
  } catch {
    return null;
  }
}

export type AdoptResult =
  | { adopted: true; launcher: string; original: string }
  | { adopted: false; reason: 'no-shadow' | 'already-adopted' | 'not-a-symlink' | 'unsafe-target' | 'error'; launcher?: string };

/** Adopt the harness's own launcher that shadows our shim. PATH-ordering fixes can't reliably
 * win across zsh's sourcing chain, so replace the shadowing symlink with one at our shim and
 * record the original in durable `.history`. Symlinks only; idempotent; never records our shim. */
export function adoptShadowingLauncher(
  agent: AgentId,
  overrides?: { shadowedBy?: string; shimsDir?: string; historyDir?: string },
): AdoptResult {
  // Repoints the user's OWN launcher symlink at our shim — the most invasive thing
  // in the codebase, and the one with no isolated-scoped equivalent at all.
  assertIsolationBoundary(agent, 'adopt your launcher');
  const shimsDir = overrides?.shimsDir ?? getShimsDir();
  const shimPath = path.join(shimsDir, AGENTS[agent].cliCommand);
  const shimReal = canonical(shimPath);
  const shimsDirReal = canonical(shimsDir);
  const launcher = overrides?.shadowedBy ?? getPathShadowingExecutable(agent) ?? findAdoptableLauncher(agent, { shimsDir });
  if (!launcher) return { adopted: false, reason: 'no-shadow' };

  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(launcher);
  } catch {
    return { adopted: false, reason: 'error', launcher };
  }

  // Only adopt symlinks. A real binary in an early-PATH dir is left untouched —
  // renaming a multi-hundred-MB native binary is exactly the kind of surprise
  // this feature must avoid. (Its shim stays reachable via the versioned name.)
  if (!stat.isSymbolicLink()) {
    return { adopted: false, reason: 'not-a-symlink', launcher };
  }

  const resolved = canonical(launcher);

  // Already ours → nothing to do.
  if (resolved === shimReal) {
    return { adopted: false, reason: 'already-adopted', launcher };
  }

  // Never record a target that resolves back into our shims dir: exec-ing it
  // from the shim would re-enter this dispatcher and spin forever.
  if (resolved === shimsDirReal || resolved.startsWith(shimsDirReal + path.sep)) {
    return { adopted: false, reason: 'unsafe-target', launcher };
  }

  try {
    const recordPath = getAdoptedRecordPath(agent, overrides?.historyDir);
    fs.mkdirSync(path.dirname(recordPath), { recursive: true });
    // Line 1: original binary (shim fall-through target). Line 2: absolute launcher path, so
    // release restores that exact symlink without a PATH scan that may miss (the M3 fix).
    fs.writeFileSync(recordPath, `${resolved}\n${path.resolve(launcher)}\n`, 'utf-8');
    // Repoint the launcher at our shim. rm + symlink (not atomic rename) is fine
    // here: the record is already written, so a crash between the two leaves a
    // recoverable state and the next run re-adopts idempotently.
    fs.rmSync(launcher);
    fs.symlinkSync(shimPath, launcher);
    return { adopted: true, launcher, original: resolved };
  } catch {
    return { adopted: false, reason: 'error', launcher };
  }
}

/** Undo `adoptShadowingLauncher`: repoint the launcher at the recorded original and drop the
 * record, an escape hatch for users who want the native launcher to win. Returns the restored
 * original path, or null if there was nothing to release. */
export function releaseAdoptedLauncher(
  agent: AgentId,
  overrides?: { shimsDir?: string; historyDir?: string },
): string | null {
  const shimsDir = overrides?.shimsDir ?? getShimsDir();
  const recordPath = getAdoptedRecordPath(agent, overrides?.historyDir);
  let lines: string[];
  try {
    lines = fs.readFileSync(recordPath, 'utf-8').split('\n').map((l) => l.trim());
  } catch {
    return null;
  }
  const original = lines[0] ?? '';
  if (!original) return null;
  // Line 2 is the exact launcher rewritten at adopt time; restoring it directly makes release
  // independent of the current PATH order (the M3 fix). Fall back to a PATH scan only for records
  // written before this format.
  const launcher = lines[1] || getPathShadowingExecutable(agent) || original;

  const shimReal = canonical(path.join(shimsDir, AGENTS[agent].cliCommand));
  const shimPath = path.resolve(path.join(shimsDir, AGENTS[agent].cliCommand));
  try {
    // Only rewrite the launcher if it currently points at our shim (i.e. we own
    // it). If the user has since replaced it themselves, leave it alone.
    let pointsAtShim = false;
    try {
      const stat = fs.lstatSync(launcher);
      if (stat.isSymbolicLink()) {
        const target = fs.readlinkSync(launcher);
        const absoluteTarget = path.resolve(path.dirname(launcher), target);
        pointsAtShim = canonicalOrNull(launcher) === shimReal || absoluteTarget === shimPath;
      }
    } catch { /* launcher gone — recreate below */ }

    if (pointsAtShim || !fs.existsSync(launcher)) {
      try {
        if (fs.lstatSync(launcher).isSymbolicLink()) {
          fs.unlinkSync(launcher);
        } else {
          fs.rmSync(launcher, { force: true });
        }
      } catch { /* may not exist */ }
      fs.symlinkSync(original, launcher);
    }
    fs.rmSync(recordPath);
    return original;
  } catch {
    return null;
  }
}

/** Check whether the agent's CLI command is shadowed by a shell alias: a best-effort scan of RC
 * files for `alias <command>=` (aliases are invisible to a child process). It tracks the last
 * `alias`/`unalias` per file, so a trailing `unalias` avoids false positives. */
function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Walk rc lines in order; a later `unalias` clears an earlier `alias`. */
function isAliasActiveInRcContent(content: string, cliCommand: string): boolean {
  let active = false;
  const aliasPattern = new RegExp(`^\\s*alias\\s+${escapeRegex(cliCommand)}\\s*=`);

  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    if (aliasPattern.test(line)) {
      active = true;
      continue;
    }

    const unaliasMatch = trimmed.match(/^unalias\s+(.+)$/);
    if (!unaliasMatch) continue;

    const tokens = unaliasMatch[1].split(/\s+/).filter((token) => !token.startsWith('-'));
    if (tokens.includes(cliCommand)) {
      active = false;
    }
  }

  return active;
}

export function hasAliasShadowingShim(
  agent: AgentId,
  overrides?: { homeDir?: string },
): boolean {
  const cliCommand = AGENTS[agent].cliCommand;
  const homeDir = overrides?.homeDir ?? os.homedir();
  const rcFiles = [
    path.join(homeDir, '.zshrc'),
    path.join(homeDir, '.bashrc'),
    path.join(homeDir, '.bash_profile'),
    path.join(homeDir, '.profile'),
  ];

  for (const rcFile of rcFiles) {
    try {
      if (!fs.existsSync(rcFile)) continue;
      const content = fs.readFileSync(rcFile, 'utf-8');
      if (isAliasActiveInRcContent(content, cliCommand)) return true;
    } catch {
      // unreadable rc file — skip
    }
  }
  return false;
}

/**
 * Check if shims directory is in PATH.
 */
export function isShimsInPath(): boolean {
  const shimsDir = getShimsDir();
  const pathDirs = (process.env.PATH || '').split(path.delimiter);
  return pathDirs.some((dir) => path.resolve(dir) === path.resolve(shimsDir));
}

function isShimPathCommandLine(line: string, shimsDir: string): boolean {
  const trimmed = line.trim();
  if (trimmed.startsWith('#')) {
    return false;
  }

  const normalized = trimmed.replace(/['"]/g, '');
  const escapeRegex = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const exactMarkers = [
    shimsDir,
    '$HOME/.agents-system/shims',
    '${HOME}/.agents-system/shims',
    '~/.agents-system/shims',
    '$HOME/.agents/shims',
    '${HOME}/.agents/shims',
    '~/.agents/shims',
  ];

  const markerRegexes = exactMarkers.map((marker) => new RegExp(`${escapeRegex(marker)}(?=$|[:\\s])`));
  const suffixRegexes = [
    /\/\.agents-system\/shims(?=$|[:\s])/,
    /\/\.agents\/\.cache\/shims(?=$|[:\s])/,
    /\/\.agents\/shims(?=$|[:\s])/,
  ];

  const touchesShimPath = [...markerRegexes, ...suffixRegexes].some((pattern) => pattern.test(normalized));
  if (!touchesShimPath) {
    return false;
  }

  return trimmed.startsWith('export PATH=') || trimmed.startsWith('fish_add_path ');
}

export function stripShimPathLines(content: string, shimsDir: string): string {
  const lines = content.split('\n');
  const kept: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (
      line.trim() === '# agents-cli: version-managed agent CLIs' &&
      i + 1 < lines.length &&
      isShimPathCommandLine(lines[i + 1], shimsDir)
    ) {
      i++;
      continue;
    }
    if (isShimPathCommandLine(line, shimsDir)) {
      continue;
    }
    kept.push(line);
  }

  return kept.join('\n').replace(/\n{3,}/g, '\n\n');
}

/**
 * Get the shell rc file path for the current shell.
 */
function getShellRcFile(overrides?: { homeDir?: string; shell?: string }): { rcFile: string; rcPath: string; shell: string } {
  const shell = overrides?.shell || process.env.SHELL || '/bin/bash';
  const shellName = path.basename(shell);

  let rcFile: string;
  switch (shellName) {
    case 'zsh':
      rcFile = '.zshrc';
      break;
    case 'fish':
      rcFile = '.config/fish/config.fish';
      break;
    case 'bash':
    default:
      rcFile = '.bashrc';
      break;
  }

  return {
    rcFile,
    rcPath: path.join(overrides?.homeDir || os.homedir(), rcFile),
    shell: shellName,
  };
}

/**
 * Get shell configuration instructions for adding shims to PATH.
 */
export function getPathSetupInstructions(): string {
  const shimsDir = getShimsDir();
  const { rcFile, shell } = getShellRcFile();

  if (shell === 'fish') {
    return `Add to ~/.config/fish/config.fish:
  fish_add_path ${shimsDir}`;
  }

  return `Add to the end of ~/${rcFile} (after any nvm/node setup and agent installers):
  export PATH="${shimsDir}:$PATH"

IMPORTANT: Shims must be the last PATH prepend in your shell config to override global installs.

Then restart your shell or run:
  source ~/${rcFile}`;
}

interface ShimPathResult {
  success: boolean;
  alreadyPresent?: boolean;
  rcFile?: string;
  /** Human label of where the entry landed, e.g. `~/.zshrc` or `your user PATH`. */
  location?: string;
  /** Per-platform "how to pick it up" hint, e.g. `source ~/.zshrc` / open a new terminal. */
  reloadHint?: string;
  error?: string;
}

/** Add the shims directory to PATH: edit the shell rc file on POSIX, or register it on the
 * Windows User PATH (registry plus WM_SETTINGCHANGE). Idempotent. */
export function addShimsToPath(
  overrides?: { homeDir?: string; shell?: string; shimsDir?: string },
): ShimPathResult {
  // Windows has no shell rc file to edit. Register the shims dir on the User PATH
  // via the platform-native mechanism instead. (The `shell` override is the test
  // hook for exercising the POSIX path, so it bypasses this branch.)
  if (IS_WINDOWS && !overrides?.shell) {
    return addShimsToWindowsUserPath(overrides?.shimsDir || getShimsDir());
  }
  const shimsDir = overrides?.shimsDir || getShimsDir();
  const { rcFile, rcPath, shell } = getShellRcFile(overrides);

  // Read current rc file content
  let content = '';
  try {
    if (fs.existsSync(rcPath)) {
      content = fs.readFileSync(rcPath, 'utf-8');
    }
  } catch (err) {
    return { success: false, error: `Could not read ${rcFile}: ${(err as Error).message}` };
  }

  // Generate the canonical PATH block.
  let exportBlock: string;
  if (shell === 'fish') {
    exportBlock = `# agents-cli: version-managed agent CLIs\nfish_add_path ${shimsDir}\n`;
  } else {
    exportBlock = `# agents-cli: version-managed agent CLIs\nexport PATH="${shimsDir}:$PATH"\n`;
  }

  const contentWithoutShimLines = stripShimPathLines(content, shimsDir);

  // Write the updated content
  try {
    // Ensure parent directories exist (especially for fish: ~/.config/fish/)
    const rcDir = path.dirname(rcPath);
    if (!fs.existsSync(rcDir)) {
      fs.mkdirSync(rcDir, { recursive: true });
    }

    // Append at EOF so later installer PATH prepends cannot shadow the shims.
    const separator = contentWithoutShimLines.length > 0 && !contentWithoutShimLines.endsWith('\n') ? '\n' : '';
    let newContent = contentWithoutShimLines + separator + exportBlock;
    newContent = newContent.replace(/\n{2,}$/g, '\n');

    const location = `~/${rcFile}`;
    const reloadHint = `Restart your shell or run: source ~/${rcFile}`;
    if (newContent === content) {
      return { success: true, alreadyPresent: true, rcFile, location, reloadHint };
    }

    fs.writeFileSync(rcPath, newContent, 'utf-8');
    return { success: true, rcFile, location, reloadHint };
  } catch (err) {
    return { success: false, error: `Could not write ${rcFile}: ${(err as Error).message}` };
  }
}

/** Register the shims dir on the Windows User PATH via the .NET environment API (writes the
 * registry and broadcasts WM_SETTINGCHANGE, no `setx` truncation). Idempotent; moves it to the
 * front if misplaced. The dir is passed via env var, never interpolated into the script. */
function addShimsToWindowsUserPath(shimsDir: string): ShimPathResult {
  const r = prependToWindowsUserPath(shimsDir);
  if (!r.success) {
    return { success: false, error: r.error };
  }
  return {
    success: true,
    alreadyPresent: r.alreadyPresent,
    location: 'your user PATH',
    reloadHint: 'Open a new terminal for the change to take effect.',
  };
}

export function listAgentsWithInstalledVersions(): AgentId[] {
  const versionsDir = getVersionsDir();
  if (!fs.existsSync(versionsDir)) {
    return [];
  }

  const entries = fs.readdirSync(versionsDir, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isDirectory() && AGENTS[entry.name as AgentId])
    .map((entry) => entry.name as AgentId)
    .filter((agent) => fs.readdirSync(path.join(versionsDir, agent), { withFileTypes: true }).some((entry) => entry.isDirectory()));
}

function isInstalledVersionIsolated(agent: AgentId, version: string): boolean {
  return fs.existsSync(path.join(getVersionsDir(), agent, version, '.isolated'));
}

/** Thrown when an operation would carry an isolated-only agent across the isolation boundary.
 * Callers catch it to print guidance; the throw makes the boundary a property of the code
 * rather than a convention every call site must remember. */
export class IsolationBoundaryError extends Error {
  constructor(readonly agent: AgentId, readonly operation: string) {
    super(
      `${agent} is installed only as isolated copies; "${operation}" would adopt it into your local setup.`,
    );
    this.name = 'IsolationBoundaryError';
  }
}

/** True when every installed version of `agent` is isolated (and at least one is). `--isolated`
 * is itself the opt-in, per agent; removing the isolated copies drops protection. An agent with
 * any normal version isn't protected: it already owns the launcher and real `~/.<agent>`. */
export function isIsolationProtected(agent: AgentId): boolean {
  const agentVersionsDir = path.join(getVersionsDir(), agent);
  let dirs: string[];
  try {
    dirs = fs.readdirSync(agentVersionsDir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    return false;
  }
  // Count only directories that are actually an install: a bare version dir is scaffolding, and
  // counting it as non-isolated would disable protection when an adopting path does
  // `mkdirSync(<version>/home)` first. Ignoring scaffolding fails toward protecting.
  const installed = dirs.filter((v) => {
    const dir = path.join(agentVersionsDir, v);
    return fs.existsSync(path.join(dir, 'node_modules')) || fs.existsSync(path.join(dir, 'package.json'));
  });
  if (installed.length === 0) return false;
  return installed.every((v) => isInstalledVersionIsolated(agent, v));
}

/** Refuse `operation` when `agent` is isolated-only. */
export function assertIsolationBoundary(agent: AgentId, operation: string): void {
  if (isIsolationProtected(agent)) throw new IsolationBoundaryError(agent, operation);
}

export function listAgentsWithNonIsolatedInstalledVersions(): AgentId[] {
  const versionsDir = getVersionsDir();
  if (!fs.existsSync(versionsDir)) {
    return [];
  }

  const entries = fs.readdirSync(versionsDir, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isDirectory() && AGENTS[entry.name as AgentId])
    .map((entry) => entry.name as AgentId)
    .filter((agent) => {
      const agentVersionsDir = path.join(versionsDir, agent);
      return fs.readdirSync(agentVersionsDir, { withFileTypes: true })
        .some((entry) => entry.isDirectory() && !isInstalledVersionIsolated(agent, entry.name));
    });
}

/**
 * Create shims for all installed agents.
 */
function ensureAllShims(): void {
  const versionsDir = getVersionsDir();
  if (!fs.existsSync(versionsDir)) {
    return;
  }

  const entries = fs.readdirSync(versionsDir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isDirectory() && AGENTS[entry.name as AgentId]) {
      const agent = entry.name as AgentId;
      const agentVersionsDir = path.join(versionsDir, agent);
      const versions = fs.readdirSync(agentVersionsDir, { withFileTypes: true })
        .filter((e) => e.isDirectory() && !isInstalledVersionIsolated(agent, e.name));

      if (versions.length > 0 && !shimExists(agent)) {
        createShim(agent);
      }
    }
  }
}

/** Resource diff between two versions: each field lists resources present in the current version
 * but missing from the target. */
export interface ResourceDiff {
  commands: string[];  // names in current but not in target
  skills: string[];
  hooks: string[];
  memory: { file: string; currentLines: number; targetLines: number }[];
  mcp: string[];  // server names in current but not in target
}

/** Compare resources between two versions: those in currentVersion but not targetVersion. */
function compareVersionResources(
  agent: AgentId,
  currentVersion: string,
  targetVersion: string
): ResourceDiff {
  const agentConfig = AGENTS[agent];
  const currentPath = getVersionConfigPath(agent, currentVersion);
  const targetPath = getVersionConfigPath(agent, targetVersion);

  const diff: ResourceDiff = {
    commands: [],
    skills: [],
    hooks: [],
    memory: [],
    mcp: [],
  };

  // Helper to list directory contents (names only)
  const listDir = (dir: string): string[] => {
    if (!fs.existsSync(dir)) return [];
    try {
      return fs.readdirSync(dir).filter(f => !f.startsWith('.'));
    } catch {
      /* directory not readable */
      return [];
    }
  };

  // Helper to count lines in a file
  const countLines = (filePath: string): number => {
    if (!fs.existsSync(filePath)) return 0;
    try {
      return fs.readFileSync(filePath, 'utf-8').split('\n').length;
    } catch {
      /* file not readable */
      return 0;
    }
  };

  // Compare commands
  const currentCommands = listDir(path.join(currentPath, agentConfig.commandsSubdir));
  const targetCommands = new Set(listDir(path.join(targetPath, agentConfig.commandsSubdir)));
  diff.commands = currentCommands.filter(c => !targetCommands.has(c)).map(c => c.replace(/\.(md|toml)$/, ''));

  // Compare skills
  const currentSkills = listDir(path.join(currentPath, 'skills'));
  const targetSkills = new Set(listDir(path.join(targetPath, 'skills')));
  diff.skills = currentSkills.filter(s => !targetSkills.has(s));

  // Compare hooks
  const currentHooks = listDir(path.join(currentPath, 'hooks'));
  const targetHooks = new Set(listDir(path.join(targetPath, 'hooks')));
  diff.hooks = currentHooks.filter(h => !targetHooks.has(h));

  // Compare memory files (instructionsFile like CLAUDE.md)
  const memoryFile = agentConfig.instructionsFile;
  const currentMemoryPath = path.join(currentPath, memoryFile);
  const targetMemoryPath = path.join(targetPath, memoryFile);
  const currentLines = countLines(currentMemoryPath);
  const targetLines = countLines(targetMemoryPath);
  if (currentLines > 0 && currentLines !== targetLines) {
    diff.memory.push({ file: memoryFile, currentLines, targetLines });
  }

  // Compare MCP servers (from settings.json)
  const readMcpServers = (configPath: string): string[] => {
    const settingsPath = path.join(configPath, 'settings.json');
    if (!fs.existsSync(settingsPath)) return [];
    try {
      const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
      return Object.keys(settings.mcpServers || {});
    } catch {
      /* settings.json corrupt or unreadable */
      return [];
    }
  };

  const currentMcp = readMcpServers(currentPath);
  const targetMcp = new Set(readMcpServers(targetPath));
  diff.mcp = currentMcp.filter(m => !targetMcp.has(m));

  return diff;
}

/**
 * Check if a ResourceDiff has any differences.
 */
export function hasResourceDiff(diff: ResourceDiff): boolean {
  return (
    diff.commands.length > 0 ||
    diff.skills.length > 0 ||
    diff.hooks.length > 0 ||
    diff.memory.length > 0 ||
    diff.mcp.length > 0
  );
}

/** Copy resources from one version to another, only those listed in the diff (missing in
 * target). */
function copyResourcesToVersion(
  agent: AgentId,
  fromVersion: string,
  toVersion: string,
  diff: ResourceDiff
): void {
  const agentConfig = AGENTS[agent];
  const fromPath = getVersionConfigPath(agent, fromVersion);
  const toPath = getVersionConfigPath(agent, toVersion);

  // Helper to copy a file or directory
  const copyItem = (srcDir: string, destDir: string, name: string): void => {
    const srcPath = path.join(srcDir, name);
    const destPath = path.join(destDir, name);
    if (!fs.existsSync(srcPath)) return;

    fs.mkdirSync(destDir, { recursive: true });

    const stat = fs.statSync(srcPath);
    if (stat.isDirectory()) {
      copyDirContents(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  };

  // Copy missing commands
  const commandsSubdir = agentConfig.commandsSubdir;
  const ext = agentConfig.format === 'toml' ? '.toml' : '.md';
  for (const cmd of diff.commands) {
    copyItem(
      path.join(fromPath, commandsSubdir),
      path.join(toPath, commandsSubdir),
      `${cmd}${ext}`
    );
  }

  // Copy missing skills
  for (const skill of diff.skills) {
    copyItem(path.join(fromPath, 'skills'), path.join(toPath, 'skills'), skill);
  }

  // Copy missing hooks
  for (const hook of diff.hooks) {
    copyItem(path.join(fromPath, 'hooks'), path.join(toPath, 'hooks'), hook);
  }

  // Copy memory file if different
  for (const mem of diff.memory) {
    const srcPath = path.join(fromPath, mem.file);
    const destPath = path.join(toPath, mem.file);
    if (fs.existsSync(srcPath)) {
      fs.copyFileSync(srcPath, destPath);
    }
  }

  // Merge MCP servers into target settings.json
  if (diff.mcp.length > 0) {
    const fromSettingsPath = path.join(fromPath, 'settings.json');
    const toSettingsPath = path.join(toPath, 'settings.json');

    if (fs.existsSync(fromSettingsPath)) {
      try {
        const fromSettings = JSON.parse(fs.readFileSync(fromSettingsPath, 'utf-8'));
        let toSettings: Record<string, unknown> = {};

        if (fs.existsSync(toSettingsPath)) {
          toSettings = JSON.parse(fs.readFileSync(toSettingsPath, 'utf-8'));
        }

        if (!toSettings.mcpServers) {
          toSettings.mcpServers = {};
        }

        for (const serverName of diff.mcp) {
          if (fromSettings.mcpServers?.[serverName]) {
            (toSettings.mcpServers as Record<string, unknown>)[serverName] = fromSettings.mcpServers[serverName];
          }
        }

        fs.writeFileSync(toSettingsPath, JSON.stringify(toSettings, null, 2));
      } catch {
        /* settings.json parse error, skip MCP merge */
      }
    }
  }
}
