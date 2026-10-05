/** macOS SUN_LEN-safe CODEX_HOME: codex binds a control socket under it and macOS caps socket
 * paths at 104 bytes, so the deep home killed every codex spawn (RUSH-1866); a symlink can't help.
 * Relocate to `.codex-homes/<origin key>` (never by version); keep exec.ts/shims.ts in lockstep. */
import * as fs from 'fs';
import * as path from 'path';

/** macOS Unix-domain socket path cap: `sizeof(sockaddr_un.sun_path)` in <sys/un.h>. */
export const SUN_LEN = 104;

/** Suffix codex appends to CODEX_HOME to reach its app-server control socket. */
export const CODEX_CONTROL_SOCKET_SUFFIX = '/app-server-control/app-server-control.sock';

/** True when this CODEX_HOME's derived control-socket path would overflow SUN_LEN on macOS. */
export function codexHomeOverflowsSunLen(home: string): boolean {
  return home.length + CODEX_CONTROL_SOCKET_SUFFIX.length > SUN_LEN;
}

/** The short codex home for an overflowing origin: `~/.agents/.codex-homes/<key>/.codex`, stable
 * across reboots (unlike $TMPDIR) and isolated per origin. */
export function shortCodexHome(agentsUserDir: string, key: string): string {
  return path.join(agentsUserDir, '.codex-homes', key, '.codex');
}

/** Short-home key: the version for a version home, `a-<accountId prefix>` for an account slot.
 * Twelve hex characters keep the socket path under SUN_LEN; the origin-link check in
 * resolveCodexHome rules out prefix collisions. */
export function codexShortKey(home: string, version: string, historyDir: string): string {
  const slotsRoot = path.resolve(historyDir, 'accounts', 'codex');
  const resolved = path.resolve(home);
  if (!resolved.startsWith(slotsRoot + path.sep)) return version;
  const accountId = resolved.slice(slotsRoot.length + 1).split(path.sep)[0] ?? '';
  if (!accountId) return version;
  return `a-${accountId.slice(0, 12)}`;
}

function realpathOrNull(p: string): string | null {
  try { return fs.realpathSync(p); } catch { return null; }
}

function isSymlinkOnto(link: string, target: string): boolean {
  try {
    if (!fs.lstatSync(link).isSymbolicLink()) return false;
    const t = realpathOrNull(target);
    return t !== null && realpathOrNull(link) === t;
  } catch {
    return false;
  }
}

/** Resolve a SUN_LEN-safe CODEX_HOME, migrating the origin to a short real path once, idempotently
 * (unchanged on non-darwin or if short). The short home is authoritative for `key`: a foreign link
 * is repointed with a warning; a real dir is adopted. Failures return the origin. */
export function resolveCodexHome(
  originHome: string,
  agentsUserDir: string,
  key: string,
  platform: NodeJS.Platform = process.platform,
): string {
  if (platform !== 'darwin') return originHome;
  if (!codexHomeOverflowsSunLen(originHome)) return originHome;

  const short = shortCodexHome(agentsUserDir, key);
  if (isSymlinkOnto(originHome, short)) return short;

  const origin = fs.lstatSync(originHome, { throwIfNoEntry: false });

  try {
    fs.mkdirSync(path.dirname(short), { recursive: true });

    if (origin?.isSymbolicLink()) {
      // Mis-linked onto a foreign target (pre-fix bug): never run that identity.
      // Repoint onto this key's own short home, creating it if absent.
      process.stderr.write(
        `[codex] ${originHome} was linked to a foreign home; repointing to ${short} `
        + `(this account may need to log in again).\n`,
      );
      if (!fs.existsSync(short)) fs.mkdirSync(short, { recursive: true });
      fs.rmSync(originHome); // removes the symlink only, never its target
      fs.symlinkSync(short, originHome);
    } else if (origin?.isDirectory()) {
      if (fs.existsSync(short)) {
        // Reinstall: the fresh real `.codex` has re-derivable resources but no
        // login; the short home holds the real login. Adopt the short home and
        // set the fresh dir aside (non-destructive) rather than lose either.
        const superseded = `${originHome}.superseded-${Date.now()}`;
        fs.renameSync(originHome, superseded);
        fs.symlinkSync(short, originHome);
      } else {
        // First migration: relocate the deep home so config/auth/state stay
        // intact, then leave a symlink behind so anything referencing the origin
        // path still resolves (session discovery, the slot record, the shim).
        fs.renameSync(originHome, short);
        fs.symlinkSync(short, originHome);
      }
    } else {
      // Fresh origin: create (or adopt) the short home and link the origin to it.
      fs.mkdirSync(short, { recursive: true });
      fs.mkdirSync(path.dirname(originHome), { recursive: true });
      fs.symlinkSync(short, originHome);
    }
  } catch {
    // A filesystem step lost a race or hit a permission error. Fall back to the
    // origin rather than crash the invocation.
    return originHome;
  }
  return isSymlinkOnto(originHome, short) ? short : originHome;
}

/** Emit the bash block a codex shim uses to export a SUN_LEN-safe CODEX_HOME, mirroring
 * resolveCodexHome for the version home (slot launches arrive with CODEX_HOME pinned by
 * `buildExecEnv`, which it keeps). */
export function codexHomeShimBash(homeExpr: string, shortBaseExpr: string): string {
  return `
# Codex reads its config (approval_policy, sandbox_mode, MCP servers, rules)
# from CODEX_HOME and binds a Unix control socket at
# "\$CODEX_HOME/app-server-control/app-server-control.sock" for its app-server
# daemon. macOS caps Unix socket paths at 104 bytes (SUN_LEN); the deep
# versioned home overflows, so "codex app-server daemon start" fails with
# "path must be shorter than SUN_LEN" and every codex spawn dies (RUSH-1866).
# Codex has no socket-path override and resolves symlinks before binding, so a
# short symlink to the deep home does NOT help. On macOS, when the derived
# socket path would overflow, relocate the home once to a short real dir and
# leave a symlink behind, then point CODEX_HOME at the short real path. A
# caller-provided CODEX_HOME always wins.
if [ -z "\${CODEX_HOME:-}" ]; then
  CODEX_HOME="${homeExpr}"
  # 43 = length of "/app-server-control/app-server-control.sock"; 104 = SUN_LEN.
  if [ "\$(uname -s)" = "Darwin" ] && [ "\$(( \${#CODEX_HOME} + 43 ))" -gt 104 ]; then
    _codex_short="${shortBaseExpr}/.codex"
    if [ ! -e "\$_codex_short" ]; then
      mkdir -p "${shortBaseExpr}"
      if [ -d "\$CODEX_HOME" ] && [ ! -L "\$CODEX_HOME" ]; then
        if mv "\$CODEX_HOME" "\$_codex_short" 2>/dev/null; then
          ln -snf "\$_codex_short" "\$CODEX_HOME"
        fi
      elif [ ! -e "\$CODEX_HOME" ]; then
        mkdir -p "\$_codex_short"
        ln -snf "\$_codex_short" "\$CODEX_HOME"
      fi
    fi
    [ -d "\$_codex_short" ] && CODEX_HOME="\$_codex_short"
  fi
fi
export CODEX_HOME="\$CODEX_HOME"
`;
}
