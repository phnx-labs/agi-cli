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

function launchLeaseDir(agent: AgentId, label: string): string {
  return path.join(getVersionsDir(), agent, label, '.launch-leases');
}

export function recordLaunchLease(agent: AgentId, label: string, pid: number): () => void {
  const dir = launchLeaseDir(agent, label);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${pid}-${randomUUID()}.json`);
  atomicWriteFileSync(file, JSON.stringify({ pid, birth: captureProcessStartTime(pid, { fresh: true }) }));
  return () => { try { fs.unlinkSync(file); } catch {  } };
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

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
    } catch { live = true; }
  }
  return live;
}

export type ConflictStrategy = 'keep-dest' | 'overwrite' | 'ask-per-file';

export interface ConflictInfo {
  agent: AgentId;
  version: string;
  conflicts: string[];
}

function detectConflicts(src: string, dest: string, prefix = ''): string[] {
  const conflicts: string[] = [];

  if (!fs.existsSync(src) || !fs.existsSync(dest)) {
    return conflicts;
  }

  try {
    const destStat = fs.lstatSync(dest);
    if (destStat.isSymbolicLink()) {
      return conflicts;
    }
  } catch {
    return conflicts;
  }

  const entries = fs.readdirSync(src, { withFileTypes: true });
  for (const entry of entries) {
    if (shouldIgnore(entry.name)) {
      continue;
    }

    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;

    try {
      const entryDestStat = fs.lstatSync(destPath);
      if (entryDestStat.isSymbolicLink()) {
        continue;
      }

      if (entry.isDirectory()) {
        conflicts.push(...detectConflicts(srcPath, destPath, relativePath));
      } else {
        conflicts.push(relativePath);
      }
    } catch {
    }
  }

  return conflicts;
}

async function promptConflictStrategy(
  conflictInfos: ConflictInfo[]
): Promise<ConflictStrategy | null> {
  const totalConflicts = conflictInfos.reduce((sum, info) => sum + info.conflicts.length, 0);

  if (totalConflicts === 0) {
    return null;
  }

  console.log('\nFile conflicts detected:');
  for (const info of conflictInfos) {
    const agentConfig = AGENTS[info.agent];
    const configDir = agentConfig.configDir;
    console.log(`  ${info.conflicts.length} file(s) conflict between:`);
    console.log(`    ~/${configDir}/ (your config)`);
    console.log(`    ${agentConfig.name}@${info.version} (managed version)`);
  }
  console.log();

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

// Bump when generated behavior changes; mixed-version fleets never downgrade a newer shim.
export const SHIM_SCHEMA_VERSION = 33;

const SHIM_VERSION_MARKER = 'agents-shim-version:';

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

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

export function generateShimScript(agent: AgentId): string {
  const agentConfig = AGENTS[agent];
  const cliCommand = agentConfig.cliCommand;
  const configDirName = path.relative(os.homedir(), agentConfig.configDir);
  const agentsBin = shellQuote(getAgentsBinForGeneratedShim());
  const managedEnv = resolveHarnessAdapter(agent).shimConfigEnvBash?.({ configDirName }) ?? '';
  const launchArgs = resolveHarnessAdapter(agent).shimLaunchArgs?.() ?? '';

  return `#!/bin/bash
# Auto-generated by agents-cli - do not edit
# ${SHIM_VERSION_MARKER} ${SHIM_SCHEMA_VERSION}

AGENTS_USER_DIR="\${AGENTS_USER_DIR:-$HOME/.agents}"
AGENTS_BIN=${agentsBin}
AGENT="${agent}"
CLI_COMMAND="${cliCommand}"

if [ -z "$AGENTS_BIN" ] || [ ! -x "$AGENTS_BIN" ]; then
  RECOVERED_BIN="$(command -v agents 2>/dev/null || true)"
  if [ -n "$RECOVERED_BIN" ] && [ -x "$RECOVERED_BIN" ]; then
    AGENTS_BIN="$RECOVERED_BIN"
  else
    echo "agents: agents-cli entrypoint missing or not executable: $AGENTS_BIN" >&2
    echo "agents: could not resolve 'agents' on PATH to recover. Reinstall: npm i -g @phnx-labs/agents-cli" >&2
    exit 127
  fi
fi

ADOPTED_ORIGINAL="$AGENTS_USER_DIR/.history/adopted-launchers/$CLI_COMMAND"
adopted_original_bin() {
  [ -f "$ADOPTED_ORIGINAL" ] || return 1
  local orig
  IFS= read -r orig < "$ADOPTED_ORIGINAL" 2>/dev/null || return 1
  [ -n "$orig" ] && [ -x "$orig" ] || return 1
  printf '%s' "$orig"
}
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

parse_agents_default() {
  local meta="$1"
  [ -f "$meta" ] || return 0
  awk -v agent="$AGENT" '
    /^agents:/ { in_agents=1; next }
    in_agents && /^[^ ]/ { in_agents=0 }
    in_agents && $0 ~ "^  " agent ":" { gsub(/.*:[[:space:]]*["'"'"']?|["'"'"']?[[:space:]]*$/, ""); print; exit }
  ' "$meta"
}

parse_pins_default() {
  local pins="$1"
  [ -f "$pins" ] || return 0
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

machine_id() {
  local raw="\${AGENTS_SYNC_MACHINE_ID:-$(hostname 2>/dev/null)}"
  raw=$(printf '%s' "$raw" | cut -d. -f1 | sed 's/^[[:space:]]*//; s/[[:space:]]*$//' | tr '[:upper:]' '[:lower:]' | sed 's/[^a-z0-9_-]/-/g')
  [ -n "$raw" ] && printf '%s' "$raw" || printf 'unknown'
}

resolve_default_version() {
  local v
  v=$(parse_pins_default "$AGENTS_USER_DIR/.history/devices/pins-$(machine_id).json")
  [ -n "$v" ] || v=$(parse_agents_default "$AGENTS_USER_DIR/devices/$(machine_id)/agents.yaml")
  [ -n "$v" ] || v=$(parse_agents_default "$AGENTS_USER_DIR/agents.yaml")
  printf '%s' "$v"
}

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

if [ "$AGENT" = "grok" ]; then
${GROK_RESOLVE_BINARY_FN}
  BINARY=$(_resolve_grok_current "$VERSION_DIR/home/.grok")
  GROK_DOWNLOADS="$VERSION_DIR/home/.grok/downloads"
  if [ -z "$BINARY" ] && [ -d "$GROK_DOWNLOADS" ]; then
    BINARY=$(_resolve_grok_binary "$GROK_DOWNLOADS" "$VERSION")
  fi
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
    BINARY=$(adopted_original_bin || echo "")
    if [ -z "$BINARY" ]; then
      BINARY=$(command -v grok 2>/dev/null || echo "")
      case "$(command -v "$BINARY" 2>/dev/null; readlink -f "$BINARY" 2>/dev/null)" in
        *"$AGENTS_USER_DIR/.cache/shims/"*) BINARY="" ;;
      esac
    fi
  fi
elif [ "$AGENT" = "droid" ]; then
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

if [ -x "$BINARY" ]; then
  RESOLVED_BINARY=$(realpath "$BINARY" 2>/dev/null || readlink -f "$BINARY" 2>/dev/null || echo "")
  RESOLVED_SHIM=$(realpath "$AGENTS_USER_DIR/.cache/shims/$CLI_COMMAND" 2>/dev/null || readlink -f "$AGENTS_USER_DIR/.cache/shims/$CLI_COMMAND" 2>/dev/null || echo "")
  if [ -n "$RESOLVED_BINARY" ] && [ "$RESOLVED_BINARY" = "$RESOLVED_SHIM" ]; then
    BINARY=$(adopted_original_bin || echo "")
  fi
fi

if [ ! -x "$BINARY" ]; then
  if [ "$VERSION_SOURCE" = "project" ]; then
    echo "agents: $AGENT@$VERSION required by agents.yaml but not installed" >&2

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

if ! "\$AGENTS_BIN" __launch-lease "\$AGENT" "\$VERSION" "\$\$"; then
  echo "agents: could not safely coordinate this launch with a possibly in-progress update of \$AGENT@\$VERSION." >&2
  echo "  Check: agents update \$AGENT@\$VERSION --check    Retry once any update finishes." >&2
  exit 1
fi

${resolveHarnessAdapter(agent).shimExecTail?.(launchArgs) ?? `exec "$BINARY"${launchArgs} "$@"`}
`;
}

export function shimTargetsFor(platform: NodeJS.Platform): { bash: boolean; cmd: boolean } {
  if (platform === 'win32') return { bash: false, cmd: true };
  return { bash: true, cmd: false };
}

export function createShim(agent: AgentId): string {
  assertIsolationBoundary(agent, 'create the bare shim');
  ensureAgentsDir();
  const shimsDir = getShimsDir();
  const agentConfig = AGENTS[agent];
  const shimPath = path.join(shimsDir, agentConfig.cliCommand);

  const targets = shimTargetsFor(process.platform);
  if (targets.bash) {
    fs.writeFileSync(shimPath, generateShimScript(agent), { mode: 0o755 });
  }
  if (targets.cmd) {
    writeWindowsCmdShim(shimPath + '.cmd', agentConfig.cliCommand);
  }

  return shimPath;
}


const BRAND_SHIM_MARKER = '# Brand shim:';

export function generateBrandShim(name: string): string {
  const agentsBin = shellQuote(getAgentsBinForGeneratedShim());
  return `#!/bin/sh
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

export function isBrandShim(filePath: string): boolean {
  try {
    const head = fs.readFileSync(filePath, 'utf-8').slice(0, 300);
    return head.includes(BRAND_SHIM_MARKER) || head.includes('rem Brand shim:');
  } catch {
    return false;
  }
}

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


const GH_OVERLOAD_MARKER = '# gh overload shim:';

export function generateGhOverloadShim(): string {
  const agentsBin = shellQuote(getAgentsBinForGeneratedShim());
  const shimsDir = shellQuote(getShimsDir());
  return `#!/bin/sh
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
if [ -z "$REAL_GH" ]; then
  echo "gh: not found (agents-cli gh overload: no real gh on PATH)" >&2
  exit 127
fi
if [ -n "$AGENTS_GH_SHIM" ] || [ -z "$AGENTS_BIN" ] || [ ! -x "$AGENTS_BIN" ]; then
  exec "$REAL_GH" "$@"
fi
if [ "$1" = "pr" ] && [ "$2" = "checks" ]; then
  AGENTS_GH_SHIM=1 exec "$AGENTS_BIN" __gh --real-gh "$REAL_GH" -- "$@"
fi
exec "$REAL_GH" "$@"
`;
}

export function isGhOverloadShim(filePath: string): boolean {
  try {
    return fs.readFileSync(filePath, 'utf-8').slice(0, 300).includes(GH_OVERLOAD_MARKER);
  } catch {
    return false;
  }
}

function hasRealGhOnPath(): boolean {
  const shimsDir = path.resolve(getShimsDir());
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    if (!dir || path.resolve(dir) === shimsDir) continue;
    const candidate = path.join(dir, 'gh');
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return true;
    } catch {
    }
  }
  return false;
}

export function ensureGhOverloadShim(): string | null {
  if (!shimTargetsFor(process.platform).bash) return null;
  if (!hasRealGhOnPath()) return null;
  ensureAgentsDir();
  const shimPath = path.join(getShimsDir(), 'gh');
  if (fs.existsSync(shimPath) && !isGhOverloadShim(shimPath)) return null;
  fs.writeFileSync(shimPath, generateGhOverloadShim(), { mode: 0o755 });
  return shimPath;
}

export function removeGhOverloadShim(): boolean {
  const shimPath = path.join(getShimsDir(), 'gh');
  if (fs.existsSync(shimPath) && isGhOverloadShim(shimPath)) {
    fs.unlinkSync(shimPath);
    return true;
  }
  return false;
}

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

export function removeShim(agent: AgentId): boolean {
  const shimsDir = getShimsDir();
  const agentConfig = AGENTS[agent];
  const shimPath = path.join(shimsDir, agentConfig.cliCommand);

  let removed = false;
  for (const p of [shimPath, shimPath + '.cmd']) {
    if (fs.existsSync(p)) {
      fs.unlinkSync(p);
      removed = true;
    }
  }
  return removed;
}

// Versioned aliases use the same monotonic regeneration contract as shared shims.
export const VERSIONED_ALIAS_SCHEMA_VERSION = 21;

const VERSIONED_ALIAS_VERSION_MARKER = 'agents-versioned-alias-version:';

const ALIAS_VERSION_RE = /^[A-Za-z0-9._+-]{1,64}$/;

function assertSafeVersion(version: string): void {
  if (!ALIAS_VERSION_RE.test(version)) {
    throw new Error(`Refusing to generate shim for unsafe version: ${JSON.stringify(version)}`);
  }
}

export const CONFIG_ENV_ISOLATED_AGENTS: readonly AgentId[] = ['claude', 'codex', 'copilot', 'cursor', 'grok', 'kimi', 'opencode', 'muse'];

export function supportsIsolatedInstall(agent: AgentId): boolean {
  return CONFIG_ENV_ISOLATED_AGENTS.includes(agent);
}

export function isSymlinkAdoptedHarness(agent: AgentId): boolean {
  return !CONFIG_ENV_ISOLATED_AGENTS.includes(agent);
}

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
    const tmpPath = `${configPath}.agents-tmp-${process.pid}`;
    try { fs.unlinkSync(tmpPath); } catch {  }
    try {
      fs.symlinkSync(target, tmpPath, process.platform === 'win32' ? 'junction' : undefined);
      fs.renameSync(tmpPath, configPath);
    } catch (err) {
      try { fs.unlinkSync(tmpPath); } catch {  }
      throw err;
    }
    return { success: true };
  } finally {
    lock.release();
  }
}

export function generateVersionedAliasScript(agent: AgentId, version: string): string {
  assertSafeVersion(version);
  const agentConfig = AGENTS[agent];
  const agentsBin = shellQuote(getAgentsBinForGeneratedShim());
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

export AGENTS_REAL_HOME="\${AGENTS_REAL_HOME:-$HOME}"

${binaryResolution}

if [ -z "$BINARY" ] || [ ! -x "$BINARY" ]; then
  echo "agents: ${agent}@${version} not installed" >&2
  exit 1
fi

if ! HOME="$AGENTS_REAL_HOME" ${agentsBin} __launch-lease "${agent}" "${version}" "\$\$"; then
  echo "agents: could not safely coordinate this launch with a possibly in-progress update of ${agent}@${version}." >&2
  echo "  Check: agents update ${agent}@${version} --check    Retry once any update finishes." >&2
  exit 1
fi
${managedEnv}

${resolveHarnessAdapter(agent).shimExecTail?.(launchArgs) ?? `exec "$BINARY"${launchArgs} "$@"`}
`;
}

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

export function isVersionedAliasCurrent(agent: AgentId, version: string): boolean {
  return readVersionedAliasSchemaVersion(agent, version) === VERSIONED_ALIAS_SCHEMA_VERSION;
}

export function ensureVersionedAliasCurrent(agent: AgentId, version: string): 'created' | 'updated' | 'current' {
  if (!fs.existsSync(versionedAliasOnDiskPath(agent, version))) {
    createVersionedAlias(agent, version);
    return 'created';
  }
  if (shimTargetsFor(process.platform).cmd && fs.existsSync(getVersionedAliasPath(agent, version))) {
    createVersionedAlias(agent, version);
    return 'updated';
  }
  const onDisk = readVersionedAliasSchemaVersion(agent, version);
  if (onDisk === null || onDisk < VERSIONED_ALIAS_SCHEMA_VERSION) {
    createVersionedAlias(agent, version);
    return 'updated';
  }
  return 'current';
}

export function getVersionedAliasPath(agent: AgentId, version: string): string {
  return path.join(getShimsDir(), `${AGENTS[agent].cliCommand}@${version}`);
}

export function versionedAliasOnDiskFile(cliCommand: string, version: string, platform: NodeJS.Platform): string {
  const name = `${cliCommand}@${version}`;
  return shimTargetsFor(platform).cmd ? `${name}.cmd` : name;
}

function versionedAliasOnDiskPath(agent: AgentId, version: string): string {
  return path.join(getShimsDir(), versionedAliasOnDiskFile(AGENTS[agent].cliCommand, version, process.platform));
}

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

export function versionedAliasExists(agent: AgentId, version: string): boolean {
  return fs.existsSync(versionedAliasOnDiskPath(agent, version));
}

export function getAgentConfigPath(agent: AgentId): string {
  const agentConfig = AGENTS[agent];
  const home = process.env.AGENTS_REAL_HOME || os.homedir();
  return agentConfig.configDir.replace(os.homedir(), home);
}

export function readCodexConfiguredModel(): string | undefined {
  try {
    const cfg = path.join(getAgentConfigPath('codex'), 'config.toml');
    const text = fs.readFileSync(cfg, 'utf-8');
    const topLevel = text.split(/^\s*\[/m)[0];
    return topLevel.match(/^\s*model\s*=\s*["']([^"']+)["']/m)?.[1];
  } catch {
    return undefined;
  }
}

function getVersionConfigPath(agent: AgentId, version: string): string {
  const agentConfig = AGENTS[agent];
  const versionsDir = getVersionsDir();
  const configDirName = path.relative(os.homedir(), agentConfig.configDir);
  return path.join(versionsDir, agent, version, 'home', configDirName);
}

function detectMigrationConflicts(agent: AgentId, version: string): ConflictInfo | null {
  const configPath = getAgentConfigPath(agent);
  const versionConfigPath = getVersionConfigPath(agent, version);

  try {
    const stat = fs.lstatSync(configPath);

    if (stat.isSymbolicLink()) {
      return null;
    } else if (stat.isDirectory()) {
      const conflicts = detectConflicts(configPath, versionConfigPath);
      return {
        agent,
        version,
        conflicts,
      };
    }
    return null;
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return null;
    }
    return null;
  }
}

export function readAuthFileIdentity(agent: AgentId, configDir: string): string | null {
  return readAuthAccountIdentity(agent, configDir);
}

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
    return;
  }

  const toResolved = path.resolve(toConfigDir);
  // When destination identity is known, carry credentials only from that same account.
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

    let newest: { path: string; mtimeMs: number } | null = null;
    for (const dir of sourceDirs) {
      if (path.resolve(dir) === toResolved) continue;
      const src = path.join(dir, rel);
      if (path.resolve(src) === destResolved) continue;
      let st: fs.Stats;
      try { st = fs.statSync(src); } catch { continue; }
      if (!st.isFile()) continue;
      if (destIdentity !== null && dirIdentity(dir) !== destIdentity) continue;
      if (!newest || st.mtimeMs > newest.mtimeMs) newest = { path: src, mtimeMs: st.mtimeMs };
    }
    if (!newest) continue;

    try {
      const dstat = fs.statSync(dest);
      if (dstat.mtimeMs >= newest.mtimeMs) continue;
    } catch {  }

    try {
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      const srcStat = fs.statSync(newest.path);
      fs.copyFileSync(newest.path, dest);
      fs.chmodSync(dest, (srcStat.mode & 0o777) || 0o600);
      fs.utimesSync(dest, srcStat.atime, srcStat.mtime);
    } catch {  }
  }
}

export async function switchConfigSymlink(
  agent: AgentId,
  version: string
): Promise<{ success: boolean; backupPath?: string; error?: string }> {
  assertIsolationBoundary(agent, 'repoint your real config directory');
  const configPath = getAgentConfigPath(agent);
  const versionConfigPath = getVersionConfigPath(agent, version);

  if (!fs.existsSync(versionConfigPath)) {
    fs.mkdirSync(versionConfigPath, { recursive: true });
  }

  carryForwardAuthFiles(agent, versionConfigPath);

  try {
    const stat = fs.lstatSync(configPath);

    if (stat.isSymbolicLink()) {
      const currentTarget = fs.readlinkSync(configPath);
      const resolvedCurrent = path.resolve(path.dirname(configPath), currentTarget);
      const resolvedTarget = path.resolve(versionConfigPath);
      if (resolvedCurrent === resolvedTarget) {
        return { success: true };
      }
      if (agent === 'openclaw') {
        // Copy workspace and memory before repointing the live symlink.
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
      fs.unlinkSync(configPath);
      fs.mkdirSync(path.dirname(configPath), { recursive: true });
      fs.symlinkSync(versionConfigPath, configPath, process.platform === 'win32' ? 'junction' : undefined);
      return { success: true };
    } else if (stat.isDirectory()) {
      const timestamp = Date.now();

      const backupsDir = getBackupsDir();
      const agentBackupDir = path.join(backupsDir, agent);
      const finalBackupPath = path.join(agentBackupDir, String(timestamp));
      fs.mkdirSync(agentBackupDir, { recursive: true });
      fs.renameSync(configPath, finalBackupPath);

      try {
        const { updateSessionFilePaths } = await import('../session/db.js');
        updateSessionFilePaths(configPath, finalBackupPath);
      } catch (err) {
        console.error(
          `Warning: failed to update session file_paths after backing up ${configPath}: ` +
            `${(err as Error).message}. Stale rows may appear in session listings until the next scan.`
        );
      }

      fs.symlinkSync(versionConfigPath, configPath, process.platform === 'win32' ? 'junction' : undefined);

      return { success: true, backupPath: finalBackupPath };
    } else {
      return { success: false, error: `${configPath} exists but is not a directory or symlink` };
    }
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      fs.mkdirSync(path.dirname(configPath), { recursive: true });
      fs.symlinkSync(versionConfigPath, configPath, process.platform === 'win32' ? 'junction' : undefined);
      return { success: true };
    }
    return { success: false, error: (err as Error).message };
  }
}

export function switchHomeFileSymlinks(
  agent: AgentId,
  version: string
): { switched: string[]; errors: string[] } {
  assertIsolationBoundary(agent, 'repoint your home-level config files');
  const agentConfig = AGENTS[agent];
  const homeFiles = agentConfig.homeFiles;
  if (!homeFiles || homeFiles.length === 0) return { switched: [], errors: [] };

  const home = process.env.AGENTS_REAL_HOME || os.homedir();
  const versionsDir = getVersionsDir();
  const switched: string[] = [];
  const errors: string[] = [];

  if (agent === 'claude') {
    const reconcile = ensureAllClaudeInsideSymlinks();
    for (const e of reconcile.errors) errors.push(e);
  }

  for (const fileName of homeFiles) {
    const globalPath = path.join(home, fileName);
    const versionFilePath = path.join(versionsDir, agent, version, 'home', fileName);

    try {
      const versionFileDir = path.dirname(versionFilePath);
      if (!fs.existsSync(versionFileDir)) {
        fs.mkdirSync(versionFileDir, { recursive: true });
      }

      let stat: fs.Stats | null = null;
      try {
        stat = fs.lstatSync(globalPath);
      } catch {
        if (!fs.existsSync(versionFilePath)) {
          fs.writeFileSync(versionFilePath, '{}');
        }
        fs.symlinkSync(versionFilePath, globalPath);
        switched.push(fileName);
        continue;
      }

      if (stat.isSymbolicLink()) {
        const currentTarget = fs.readlinkSync(globalPath);
        const resolvedCurrent = path.resolve(path.dirname(globalPath), currentTarget);
        const resolvedTarget = path.resolve(versionFilePath);
        if (resolvedCurrent === resolvedTarget) {
          switched.push(fileName);
          continue;
        }
        if (!fs.existsSync(versionFilePath)) {
          fs.writeFileSync(versionFilePath, '{}');
        }
        const tmpPath = `${globalPath}.agents-tmp-${process.pid}`;
        fs.symlinkSync(versionFilePath, tmpPath);
        fs.renameSync(tmpPath, globalPath);
        switched.push(fileName);
      } else if (stat.isFile()) {
        let globalContent: Record<string, unknown>;
        try {
          globalContent = JSON.parse(fs.readFileSync(globalPath, 'utf-8'));
        } catch (err) {
          errors.push(`${fileName}: Could not parse ${globalPath}: ${(err as Error).message}`);
          continue;
        }

        const agentVersionsDir = path.join(versionsDir, agent);
        if (fs.existsSync(agentVersionsDir)) {
          for (const ver of fs.readdirSync(agentVersionsDir)) {
            const verFilePath = path.join(agentVersionsDir, ver, 'home', fileName);
            const verFileDir = path.dirname(verFilePath);
            if (!fs.existsSync(verFileDir)) {
              fs.mkdirSync(verFileDir, { recursive: true });
            }
            if (fs.existsSync(verFilePath)) {
              try {
                const verContent = JSON.parse(fs.readFileSync(verFilePath, 'utf-8'));
                const merged = { ...globalContent, ...verContent };
                if (globalContent.oauthAccount) {
                  merged.oauthAccount = globalContent.oauthAccount;
                }
                fs.writeFileSync(verFilePath, JSON.stringify(merged, null, 2));
              } catch {
                fs.writeFileSync(verFilePath, JSON.stringify(globalContent, null, 2));
              }
            } else {
              fs.writeFileSync(verFilePath, JSON.stringify(globalContent, null, 2));
            }
          }
        }

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

export function ensureClaudeInsideSymlink(version: string): void {
  const versionsDir = getVersionsDir();
  const versionHome = path.join(versionsDir, 'claude', version, 'home');
  const outsidePath = path.join(versionHome, '.claude.json');
  const insideDir = path.join(versionHome, '.claude');
  const insidePath = path.join(insideDir, '.claude.json');
  const linkTarget = '../.claude.json';

  if (!fs.existsSync(insideDir)) {
    fs.mkdirSync(insideDir, { recursive: true });
  }

  let insideStat: fs.Stats | null = null;
  try {
    insideStat = fs.lstatSync(insidePath);
  } catch {
  }

  if (insideStat?.isSymbolicLink()) {
    const currentTarget = fs.readlinkSync(insidePath);
    if (currentTarget === linkTarget) return;
    if (!fs.existsSync(outsidePath)) fs.writeFileSync(outsidePath, '{}');
    fs.unlinkSync(insidePath);
    fs.symlinkSync(linkTarget, insidePath);
    return;
  }

  if (insideStat?.isFile()) {
    let insideContent: Record<string, unknown> = {};
    try {
      insideContent = JSON.parse(fs.readFileSync(insidePath, 'utf-8'));
    } catch {
    }

    let outsideContent: Record<string, unknown> = {};
    if (fs.existsSync(outsidePath)) {
      try {
        outsideContent = JSON.parse(fs.readFileSync(outsidePath, 'utf-8'));
      } catch {
      }
    }

    const merged = { ...outsideContent, ...insideContent };
    fs.writeFileSync(outsidePath, JSON.stringify(merged, null, 2));
    fs.unlinkSync(insidePath);
    fs.symlinkSync(linkTarget, insidePath);
    return;
  }

  if (!fs.existsSync(outsidePath)) fs.writeFileSync(outsidePath, '{}');
  fs.symlinkSync(linkTarget, insidePath);
}

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

export function getConfigSymlinkVersion(agent: AgentId): string | null {
  const configPath = getAgentConfigPath(agent);

  try {
    const stat = fs.lstatSync(configPath);
    if (!stat.isSymbolicLink()) {
      return null;
    }

    const target = fs.readlinkSync(configPath).replace(/\\/g, '/');
    const match = target.match(/versions\/[^/]+\/([^/]+)\/home/);
    return match ? match[1] : null;
  } catch {
    return null;
  }
}

interface CopyContext {
  agent: AgentId;
  version: string;
}

async function copyDirContents(
  src: string,
  dest: string,
  strategy: ConflictStrategy = 'keep-dest',
  context?: CopyContext
): Promise<void> {
  try {
    const destStat = fs.lstatSync(dest);
    if (destStat.isSymbolicLink()) {
      return;
    }
  } catch {
  }

  if (!fs.existsSync(dest)) {
    fs.mkdirSync(dest, { recursive: true });
  }

  const entries = fs.readdirSync(src, { withFileTypes: true });
  for (const entry of entries) {
    if (shouldIgnore(entry.name)) {
      continue;
    }

    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);

    try {
      const entryDestStat = fs.lstatSync(destPath);
      if (entryDestStat.isSymbolicLink()) {
        continue;
      }
    } catch {
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
      if (fs.existsSync(destPath)) {
        if (strategy === 'keep-dest') {
          continue;
        } else if (strategy === 'overwrite') {
          fs.copyFileSync(destPath, `${destPath}.backup`);
        } else if (strategy === 'ask-per-file') {
          fs.copyFileSync(destPath, `${destPath}.backup`);

          const agentConfig = context ? AGENTS[context.agent] : null;
          const versionLabel = agentConfig
            ? `${agentConfig.name}@${context!.version}`
            : 'version';
          const useMyFile = await confirm({
            message: `${entry.name}: Use your config file instead of ${versionLabel}?`,
            default: false,
          });

          if (!useMyFile) {
            continue;
          }
        }
      }
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

export function onDiskShimFile(cliCommand: string, platform: NodeJS.Platform): string {
  return shimTargetsFor(platform).cmd ? `${cliCommand}.cmd` : cliCommand;
}

function onDiskShimPath(agent: AgentId): string {
  return path.join(getShimsDir(), onDiskShimFile(AGENTS[agent].cliCommand, process.platform));
}

export function shimExists(agent: AgentId): boolean {
  return fs.existsSync(onDiskShimPath(agent));
}

function readShimSchemaVersion(agent: AgentId): number | null {
  if (!shimExists(agent)) return null;
  try {
    const content = fs.readFileSync(onDiskShimPath(agent), 'utf8');
    const header = content.split('\n', 10).join('\n');
    const match = header.match(new RegExp(SHIM_VERSION_MARKER + '\\s*(\\d+)'));
    if (!match) return null;
    return Number(match[1]);
  } catch {
    return null;
  }
}

export function isShimCurrent(agent: AgentId): boolean {
  const version = readShimSchemaVersion(agent);
  return version === SHIM_SCHEMA_VERSION;
}

function readAgentsBinFromShim(shimPath: string): string | null {
  try {
    const header = fs.readFileSync(shimPath, 'utf8').split('\n', 12).join('\n');
    const m = header.match(/^AGENTS_BIN=(?:'([^']*)'|"([^"]*)"|(\S+))/m);
    return m ? (m[1] ?? m[2] ?? m[3] ?? null) : null;
  } catch {
    return null;
  }
}

export function shimPointsAtLiveInstall(agent: AgentId): boolean {
  if (!shimExists(agent)) return true;
  const baked = readAgentsBinFromShim(onDiskShimPath(agent));
  if (!baked) return true;
  if (baked === getAgentsBinForGeneratedShim()) return true;
  return fs.existsSync(baked);
}

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

const LEGACY_SHIMS_ALWAYS_PRUNED: ReadonlySet<string> = new Set(['secrets', 'sessions', 'computer', 'pty', 'browser']);

export function pruneOrphanedCommandShim(fileName: string): boolean {
  const isAgentCommand = Object.values(AGENTS).some((a) => a.cliCommand === fileName);
  if (isAgentCommand) return false;

  const shimPath = path.join(getShimsDir(), fileName);
  let content: string;
  try {
    content = fs.readFileSync(shimPath, 'utf8');
  } catch {
    return false;
  }
  if (content.includes('# Alias shim:')) return false;
  const bin = readAgentsBinFromShim(shimPath);
  if (!bin) return false;
  if (fs.existsSync(bin) && !LEGACY_SHIMS_ALWAYS_PRUNED.has(fileName)) return false;

  try {
    fs.rmSync(shimPath);
    return true;
  } catch {
    return false;
  }
}

export function ensureShimCurrent(agent: AgentId): 'created' | 'updated' | 'current' {
  if (!shimExists(agent)) {
    createShim(agent);
    return 'created';
  }
  const onDisk = readShimSchemaVersion(agent);
  if (onDisk === null || onDisk < SHIM_SCHEMA_VERSION) {
    createShim(agent);
    return 'updated';
  }
  return 'current';
}

export function refreshOwnedLaunchers(agent: AgentId, label: string): void {
  const owned = (file: string): boolean => {
    try { return fs.readFileSync(file, 'utf8').includes('Auto-generated by agents-cli - do not edit'); }
    catch (err: any) { if (err.code === 'ENOENT') return false; throw err; }
  };
  if (owned(onDiskShimPath(agent))) ensureShimCurrent(agent);
  if (owned(versionedAliasOnDiskPath(agent, label))) ensureVersionedAliasCurrent(agent, label);
}

export function getShimPath(agent: AgentId): string {
  const shimsDir = getShimsDir();
  const agentConfig = AGENTS[agent];
  return path.join(shimsDir, agentConfig.cliCommand);
}

export function getPathShadowingExecutable(
  agent: AgentId,
  overrides?: { pathDirs?: string[]; shimPath?: string },
): string | null {
  const pathDirs = overrides?.pathDirs ?? (process.env.PATH || '').split(path.delimiter).filter(Boolean);
  const shimPath = path.resolve(overrides?.shimPath ?? getShimPath(agent));
  const cliCommand = AGENTS[agent].cliCommand;
  const legacyUserShim = path.resolve(path.join(os.homedir(), '.agents', 'shims', cliCommand));
  const managedShimExists = fs.existsSync(shimPath);

  const shimReal = managedShimExists ? canonicalOrNull(shimPath) : null;

  for (const dir of pathDirs) {
    const candidate = path.resolve(dir, cliCommand);
    if (!fs.existsSync(candidate)) {
      continue;
    }
    if (candidate === shimPath) return null;
    if (shimReal && canonicalOrNull(candidate) === shimReal) return null;
    if (candidate === legacyUserShim && managedShimExists) {
      continue;
    }
    return candidate;
  }

  return null;
}

export function removeLegacyUserShim(agent: AgentId, overrides?: { homeDir?: string }): boolean {
  const cliCommand = AGENTS[agent].cliCommand;
  const homeDir = overrides?.homeDir || os.homedir();
  const legacyPath = path.join(homeDir, '.agents', 'shims', cliCommand);
  if (!fs.existsSync(legacyPath)) return false;
  const currentShim = path.resolve(getShimPath(agent));
  if (path.resolve(legacyPath) === currentShim) return false;
  try {
    fs.unlinkSync(legacyPath);
    try {
      const legacyDir = path.dirname(legacyPath);
      if (fs.readdirSync(legacyDir).length === 0) fs.rmdirSync(legacyDir);
    } catch {  }
    return true;
  } catch {
    return false;
  }
}

export function getAdoptedRecordPath(agent: AgentId, historyDir: string = getHistoryDir()): string {
  return path.join(historyDir, 'adopted-launchers', AGENTS[agent].cliCommand);
}

export function findAdoptableLauncher(
  agent: AgentId,
  overrides?: { homeDir?: string; shimsDir?: string },
): string | null {
  const cliCommand = AGENTS[agent].cliCommand;
  const homeDir = overrides?.homeDir ?? os.homedir();
  const shimsDirReal = canonical(overrides?.shimsDir ?? getShimsDir());
  const candidate = path.join(homeDir, '.local', 'bin', cliCommand);
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(candidate);
  } catch {
    return null;
  }
  if (!stat.isSymbolicLink()) return null;
  let resolved: string;
  try {
    resolved = fs.realpathSync(candidate);
  } catch {
    return null;
  }
  if (resolved === shimsDirReal || resolved.startsWith(shimsDirReal + path.sep)) return null;
  return candidate;
}

function canonical(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

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

export function adoptShadowingLauncher(
  agent: AgentId,
  overrides?: { shadowedBy?: string; shimsDir?: string; historyDir?: string },
): AdoptResult {
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

  if (!stat.isSymbolicLink()) {
    return { adopted: false, reason: 'not-a-symlink', launcher };
  }

  const resolved = canonical(launcher);

  if (resolved === shimReal) {
    return { adopted: false, reason: 'already-adopted', launcher };
  }

  if (resolved === shimsDirReal || resolved.startsWith(shimsDirReal + path.sep)) {
    return { adopted: false, reason: 'unsafe-target', launcher };
  }

  try {
    const recordPath = getAdoptedRecordPath(agent, overrides?.historyDir);
    fs.mkdirSync(path.dirname(recordPath), { recursive: true });
    fs.writeFileSync(recordPath, `${resolved}\n${path.resolve(launcher)}\n`, 'utf-8');
    fs.rmSync(launcher);
    fs.symlinkSync(shimPath, launcher);
    return { adopted: true, launcher, original: resolved };
  } catch {
    return { adopted: false, reason: 'error', launcher };
  }
}

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
  const launcher = lines[1] || getPathShadowingExecutable(agent) || original;

  const shimReal = canonical(path.join(shimsDir, AGENTS[agent].cliCommand));
  const shimPath = path.resolve(path.join(shimsDir, AGENTS[agent].cliCommand));
  try {
    let pointsAtShim = false;
    try {
      const stat = fs.lstatSync(launcher);
      if (stat.isSymbolicLink()) {
        const target = fs.readlinkSync(launcher);
        const absoluteTarget = path.resolve(path.dirname(launcher), target);
        pointsAtShim = canonicalOrNull(launcher) === shimReal || absoluteTarget === shimPath;
      }
    } catch {  }

    if (pointsAtShim || !fs.existsSync(launcher)) {
      try {
        if (fs.lstatSync(launcher).isSymbolicLink()) {
          fs.unlinkSync(launcher);
        } else {
          fs.rmSync(launcher, { force: true });
        }
      } catch {  }
      fs.symlinkSync(original, launcher);
    }
    fs.rmSync(recordPath);
    return original;
  } catch {
    return null;
  }
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

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
    }
  }
  return false;
}

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
  location?: string;
  reloadHint?: string;
  error?: string;
}

export function addShimsToPath(
  overrides?: { homeDir?: string; shell?: string; shimsDir?: string },
): ShimPathResult {
  if (IS_WINDOWS && !overrides?.shell) {
    return addShimsToWindowsUserPath(overrides?.shimsDir || getShimsDir());
  }
  const shimsDir = overrides?.shimsDir || getShimsDir();
  const { rcFile, rcPath, shell } = getShellRcFile(overrides);

  let content = '';
  try {
    if (fs.existsSync(rcPath)) {
      content = fs.readFileSync(rcPath, 'utf-8');
    }
  } catch (err) {
    return { success: false, error: `Could not read ${rcFile}: ${(err as Error).message}` };
  }

  let exportBlock: string;
  if (shell === 'fish') {
    exportBlock = `# agents-cli: version-managed agent CLIs\nfish_add_path ${shimsDir}\n`;
  } else {
    exportBlock = `# agents-cli: version-managed agent CLIs\nexport PATH="${shimsDir}:$PATH"\n`;
  }

  const contentWithoutShimLines = stripShimPathLines(content, shimsDir);

  try {
    const rcDir = path.dirname(rcPath);
    if (!fs.existsSync(rcDir)) {
      fs.mkdirSync(rcDir, { recursive: true });
    }

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

export class IsolationBoundaryError extends Error {
  constructor(readonly agent: AgentId, readonly operation: string) {
    super(
      `${agent} is installed only as isolated copies; "${operation}" would adopt it into your local setup.`,
    );
    this.name = 'IsolationBoundaryError';
  }
}

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
  const installed = dirs.filter((v) => {
    const dir = path.join(agentVersionsDir, v);
    return fs.existsSync(path.join(dir, 'node_modules')) || fs.existsSync(path.join(dir, 'package.json'));
  });
  if (installed.length === 0) return false;
  return installed.every((v) => isInstalledVersionIsolated(agent, v));
}

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

export interface ResourceDiff {
  commands: string[];
  skills: string[];
  hooks: string[];
  memory: { file: string; currentLines: number; targetLines: number }[];
  mcp: string[];
}

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

  const listDir = (dir: string): string[] => {
    if (!fs.existsSync(dir)) return [];
    try {
      return fs.readdirSync(dir).filter(f => !f.startsWith('.'));
    } catch {
      return [];
    }
  };

  const countLines = (filePath: string): number => {
    if (!fs.existsSync(filePath)) return 0;
    try {
      return fs.readFileSync(filePath, 'utf-8').split('\n').length;
    } catch {
      return 0;
    }
  };

  const currentCommands = listDir(path.join(currentPath, agentConfig.commandsSubdir));
  const targetCommands = new Set(listDir(path.join(targetPath, agentConfig.commandsSubdir)));
  diff.commands = currentCommands.filter(c => !targetCommands.has(c)).map(c => c.replace(/\.(md|toml)$/, ''));

  const currentSkills = listDir(path.join(currentPath, 'skills'));
  const targetSkills = new Set(listDir(path.join(targetPath, 'skills')));
  diff.skills = currentSkills.filter(s => !targetSkills.has(s));

  const currentHooks = listDir(path.join(currentPath, 'hooks'));
  const targetHooks = new Set(listDir(path.join(targetPath, 'hooks')));
  diff.hooks = currentHooks.filter(h => !targetHooks.has(h));

  const memoryFile = agentConfig.instructionsFile;
  const currentMemoryPath = path.join(currentPath, memoryFile);
  const targetMemoryPath = path.join(targetPath, memoryFile);
  const currentLines = countLines(currentMemoryPath);
  const targetLines = countLines(targetMemoryPath);
  if (currentLines > 0 && currentLines !== targetLines) {
    diff.memory.push({ file: memoryFile, currentLines, targetLines });
  }

  const readMcpServers = (configPath: string): string[] => {
    const settingsPath = path.join(configPath, 'settings.json');
    if (!fs.existsSync(settingsPath)) return [];
    try {
      const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
      return Object.keys(settings.mcpServers || {});
    } catch {
      return [];
    }
  };

  const currentMcp = readMcpServers(currentPath);
  const targetMcp = new Set(readMcpServers(targetPath));
  diff.mcp = currentMcp.filter(m => !targetMcp.has(m));

  return diff;
}

export function hasResourceDiff(diff: ResourceDiff): boolean {
  return (
    diff.commands.length > 0 ||
    diff.skills.length > 0 ||
    diff.hooks.length > 0 ||
    diff.memory.length > 0 ||
    diff.mcp.length > 0
  );
}

function copyResourcesToVersion(
  agent: AgentId,
  fromVersion: string,
  toVersion: string,
  diff: ResourceDiff
): void {
  const agentConfig = AGENTS[agent];
  const fromPath = getVersionConfigPath(agent, fromVersion);
  const toPath = getVersionConfigPath(agent, toVersion);

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

  const commandsSubdir = agentConfig.commandsSubdir;
  const ext = agentConfig.format === 'toml' ? '.toml' : '.md';
  for (const cmd of diff.commands) {
    copyItem(
      path.join(fromPath, commandsSubdir),
      path.join(toPath, commandsSubdir),
      `${cmd}${ext}`
    );
  }

  for (const skill of diff.skills) {
    copyItem(path.join(fromPath, 'skills'), path.join(toPath, 'skills'), skill);
  }

  for (const hook of diff.hooks) {
    copyItem(path.join(fromPath, 'hooks'), path.join(toPath, 'hooks'), hook);
  }

  for (const mem of diff.memory) {
    const srcPath = path.join(fromPath, mem.file);
    const destPath = path.join(toPath, mem.file);
    if (fs.existsSync(srcPath)) {
      fs.copyFileSync(srcPath, destPath);
    }
  }

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
      }
    }
  }
}
