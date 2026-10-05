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

export const SUN_LEN = 104;

export const CODEX_CONTROL_SOCKET_SUFFIX = '/app-server-control/app-server-control.sock';

export function codexHomeOverflowsSunLen(home: string): boolean {
  return home.length + CODEX_CONTROL_SOCKET_SUFFIX.length > SUN_LEN;
}

export function shortCodexHome(agentsUserDir: string, key: string): string {
  return path.join(agentsUserDir, '.codex-homes', key, '.codex');
}

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

export function resolveCodexHome(
  originHome: string,
  agentsUserDir: string,
  key: string,
  platform: NodeJS.Platform = process.platform,
): string {
  // A short home never adopts a foreign login; repoint symlinks without deleting their targets.
  if (platform !== 'darwin') return originHome;
  if (!codexHomeOverflowsSunLen(originHome)) return originHome;

  const short = shortCodexHome(agentsUserDir, key);
  if (isSymlinkOnto(originHome, short)) return short;

  const origin = fs.lstatSync(originHome, { throwIfNoEntry: false });

  try {
    fs.mkdirSync(path.dirname(short), { recursive: true });

    if (origin?.isSymbolicLink()) {
      process.stderr.write(
        `[codex] ${originHome} was linked to a foreign home; repointing to ${short} `
        + `(this account may need to log in again).\n`,
      );
      if (!fs.existsSync(short)) fs.mkdirSync(short, { recursive: true });
      fs.rmSync(originHome);
      fs.symlinkSync(short, originHome);
    } else if (origin?.isDirectory()) {
      if (fs.existsSync(short)) {
        const superseded = `${originHome}.superseded-${Date.now()}`;
        fs.renameSync(originHome, superseded);
        fs.symlinkSync(short, originHome);
      } else {
        fs.renameSync(originHome, short);
        fs.symlinkSync(short, originHome);
      }
    } else {
      fs.mkdirSync(short, { recursive: true });
      fs.mkdirSync(path.dirname(originHome), { recursive: true });
      fs.symlinkSync(short, originHome);
    }
  } catch {
    return originHome;
  }
  return isSymlinkOnto(originHome, short) ? short : originHome;
}

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
