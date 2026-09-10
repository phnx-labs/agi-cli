/**
 * macOS SUN_LEN-safe CODEX_HOME resolution.
 *
 * Codex reads its config (approval_policy, sandbox_mode, MCP servers, rules)
 * from CODEX_HOME and, for its app-server daemon, binds a Unix-domain control
 * socket at `$CODEX_HOME/app-server-control/app-server-control.sock`. macOS
 * caps Unix socket paths at 104 bytes (SUN_LEN — `sizeof(sockaddr_un.sun_path)`
 * in `<sys/un.h>`). agents-cli points CODEX_HOME at the deep versioned home
 * (`~/.agents/.history/versions/codex/<version>/home/.codex`), which for a
 * typical user is long enough that the derived socket path exceeds 104 bytes.
 * `codex app-server daemon start` then fails with `path must be shorter than
 * SUN_LEN`, and every codex spawn on macOS dies (this took down all OpenClaw
 * agents on mac-mini — RUSH-1866).
 *
 * Codex exposes no socket-path override and resolves symlinks before binding,
 * so a short symlink pointing at the deep home does NOT help (the socket lives
 * at the resolved target). The only fix is to make the *real* CODEX_HOME short.
 * On macOS, when the versioned home's socket path would overflow, we relocate
 * the home once to a short real directory under `~/.agents/.codex-homes/` and
 * leave a symlink behind at the versioned path, then point CODEX_HOME at the
 * short real path. Config, auth, and state migrate intact; there is no socket
 * or sqlite fragmentation because a single physical home simply moves.
 *
 * This module is the single source of truth for that logic. `exec.ts` calls
 * the TS resolver for `agents run`/`agents exec`; `shims.ts` emits the bash
 * equivalent (`codexHomeShimBash`) into the generated codex shims. Keep the two
 * in lockstep.
 *
 * The short home is keyed by the ORIGIN it relocates, never by the version
 * alone. An account slot (`~/.agents/.history/accounts/codex/<id>/.codex`) is
 * long enough to overflow too, and keying it by version handed every
 * `agents run codex#<account>` on macOS the default version's short home —
 * whichever login that happened to hold. `codexShortKey` derives the key; a
 * short home that is not the resolved link target of its origin is refused
 * rather than reused.
 */
import * as fs from 'fs';
import * as path from 'path';

/** macOS Unix-domain socket path cap: `sizeof(sockaddr_un.sun_path)` in <sys/un.h>. */
export const SUN_LEN = 104;

/** Suffix codex appends to CODEX_HOME to reach its app-server control socket. */
export const CODEX_CONTROL_SOCKET_SUFFIX = '/app-server-control/app-server-control.sock';

/**
 * True when this CODEX_HOME's derived control-socket path would overflow
 * SUN_LEN on macOS.
 */
export function codexHomeOverflowsSunLen(home: string): boolean {
  return home.length + CODEX_CONTROL_SOCKET_SUFFIX.length > SUN_LEN;
}

/**
 * The short codex home used when an origin home overflows.
 * `~/.agents/.codex-homes/<key>/.codex` keeps the socket path well under
 * SUN_LEN while staying stable across reboots (unlike $TMPDIR) and isolated
 * per origin.
 */
export function shortCodexHome(agentsUserDir: string, key: string): string {
  return path.join(agentsUserDir, '.codex-homes', key, '.codex');
}

/**
 * The short-home key for a codex config home: the version for a version home,
 * `a-<accountId prefix>` for an account slot under `<historyDir>/accounts/codex/`.
 * Twelve hex characters keep the socket path under SUN_LEN for any home dir
 * (`~/.agents/.codex-homes/a-XXXXXXXXXXXX/.codex` + suffix = 99 bytes on a
 * `/Users/<user>` prefix); the origin-link check in {@link resolveCodexHome}
 * is what rules out two accounts sharing a prefix.
 */
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

/**
 * Resolve a macOS SUN_LEN-safe CODEX_HOME for the given origin home, migrating
 * the home to a short real path (once, idempotently) when needed. `key` is the
 * short-home key from {@link codexShortKey} — it uniquely identifies the origin
 * (the version for a version home, `a-<accountId>` for a slot), so
 * `.codex-homes/<key>` can only ever be THIS origin's own short home. Two
 * different origins never map to one key, which is what makes every branch
 * below safe without guessing whose login a short home holds.
 *
 * On non-darwin platforms, or when the origin already fits, the origin is
 * returned unchanged. Otherwise the short home is authoritative for `key`, and
 * the origin is made a symlink onto it:
 *  - already linked onto it → return it (healthy, the common path).
 *  - linked onto a DIFFERENT target (a pre-fix layout where a slot's `.codex`
 *    was captured into a foreign version short home) → REPOINT to this key's own
 *    short home and warn; the foreign login is never run. The account may need a
 *    re-login, which is correct — its login was never isolated.
 *  - a real directory with the short home ALREADY present → a version/account
 *    reinstall recreated a fresh `.codex`; adopt the short home (which holds the
 *    real login), backing the fresh dir aside so freshly-synced resources are
 *    not lost. This is the case the earlier refuse-and-throw broke
 *    (`agents remove codex@x && agents add codex@x` then `agents run`).
 *  - a real directory with no short home yet → first migration: rename it into
 *    the short home and leave a symlink.
 *  - absent → create/adopt the short home and link the origin to it.
 * If any filesystem step fails the origin is returned (no worse than the pre-fix
 * behavior).
 */
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

/**
 * Emit the bash block that a generated codex shim uses to export a
 * SUN_LEN-safe CODEX_HOME. Mirrors {@link resolveCodexHome} for the one origin
 * a shim ever sees, the version home: an account-slot launch reaches the shim
 * with CODEX_HOME already pinned by `buildExecEnv`, and the block below keeps a
 * caller-provided CODEX_HOME, so the slot key never has to be derived in bash.
 *
 * @param homeExpr      shell expression for the versioned codex home
 *                      (e.g. `$VERSION_DIR/home/.codex`)
 * @param shortBaseExpr shell expression for the per-version short base dir
 *                      (e.g. `$AGENTS_USER_DIR/.codex-homes/$VERSION`)
 */
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
