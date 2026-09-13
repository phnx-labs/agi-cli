/**
 * POSIX login-PATH primitives for making the `agents` command resolvable.
 *
 * The Unix analog of winpath.ts. `agents`/`ag` land on PATH only via npm's
 * bin symlink into the npm global-bin dir; under nvm (and other per-user node
 * prefixes) that dir is absent from a *non-interactive login* shell's PATH, so
 * `bash -lc 'agents …'` fails with command-not-found. That breaks every
 * consumer that drives a login shell on the box: `agents secrets export --device`
 * (which runs `bash -lc 'agents secrets import …'` on the remote) and the
 * routines daemon (`src/lib/daemon/daemon.ts`, which falls back to bare `agents`).
 *
 * The fix mirrors the Windows postinstall branch (which registers npm's
 * global-bin dir on the user PATH): symlink the entrypoint into ~/.local/bin —
 * the XDG user-bin dir that mainstream distros auto-add to the login PATH when
 * it exists (Debian/Ubuntu via ~/.profile, Fedora via /etc/profile.d) — and,
 * where it is not yet on PATH, the caller adds it.
 *
 * Leaf module — imports only child_process / fs / os / path so it is cheap to
 * load from the npm lifecycle script without pulling the rest of the CLI.
 */
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/** The XDG user-bin dir, `~/.local/bin`. */
export function localBinDir(home: string = os.homedir()): string {
  return path.join(home, '.local', 'bin');
}

interface SymlinkResult {
  /** A usable symlink to `target` exists at the path after this call. */
  ok: boolean;
  /** True only when this call created the symlink (false = already correct, or left untouched). */
  created: boolean;
  /** Why an existing entry was left untouched (set only when ok is false). */
  skippedReason?: string;
  path: string;
}

/**
 * Ensure `<dir>/<name>` is a symlink to `target`, NEVER clobbering a
 * pre-existing real file or a symlink that already points elsewhere — most
 * importantly a developer's `scripts/install.sh` dev build at
 * `~/.local/bin/agents`. Only an absent path, or a symlink already pointing at
 * `target`, is created/treated as ok. Idempotent.
 */
export function ensureLocalBinSymlink(
  name: string,
  target: string,
  dir: string = localBinDir(),
): SymlinkResult {
  const linkPath = path.join(dir, name);
  const want = path.resolve(target);
  let current: string | null = null;
  try {
    current = fs.readlinkSync(linkPath);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'EINVAL') {
      // The path exists but is not a symlink — a real file/dir. Never clobber.
      return { ok: false, created: false, skippedReason: 'a non-symlink file already exists here', path: linkPath };
    }
    if (code !== 'ENOENT') {
      return { ok: false, created: false, skippedReason: (err as Error).message, path: linkPath };
    }
    // ENOENT — nothing there; fall through to create.
  }
  if (current !== null) {
    const resolved = path.isAbsolute(current) ? current : path.resolve(dir, current);
    if (resolved === want) return { ok: true, created: false, path: linkPath };
    // Points somewhere else (e.g. a dev build) — the existing link wins.
    return { ok: false, created: false, skippedReason: `symlink already points to ${current}`, path: linkPath };
  }
  fs.mkdirSync(dir, { recursive: true });
  fs.symlinkSync(target, linkPath);
  return { ok: true, created: true, path: linkPath };
}

/**
 * Absolute path to `bash`. We probe bash specifically — NOT the user's $SHELL —
 * because the consumers we are healing run `bash -lc` regardless of login shell:
 * `secrets export --device` builds `bash -lc 'agents secrets import …'` for the
 * remote, and the routines daemon resolves `agents` the same way. On a box whose
 * login shell is zsh, zsh's login PATH may lack ~/.local/bin while bash's
 * includes it (Debian/Ubuntu ~/.profile) — so probing $SHELL would give the
 * wrong answer for what the consumer actually sees. Resolve from the *current*
 * PATH (the install process has one) and fall back to /bin/bash.
 */
function bashPath(): string {
  const found = (process.env.PATH || '')
    .split(path.delimiter)
    .map((d) => (d ? path.join(d, 'bash') : ''))
    .find((p) => {
      if (!p) return false;
      try { fs.accessSync(p, fs.constants.X_OK); return true; } catch { return false; }
    });
  return found || '/bin/bash';
}

/**
 * Environment for the probe shell that reproduces a *fresh* `bash -lc` — the
 * PATH that `ssh host 'bash -lc …'` and the routines daemon actually get — and
 * NOT the nvm/npm-augmented PATH of the install process.
 *
 * This is the crux: `npm i -g` (and a dev `bun run`) execute under nvm, so the
 * caller's PATH already contains nvm's bin. A spawned shell inherits that PATH,
 * so it would resolve `agents` and the heal would skip — during the very nvm
 * install it exists to fix. We strip PATH (and nvm's hint vars) so the login
 * profile rebuilds PATH from scratch, exactly as an incoming SSH command shell
 * does. Login bash still sources /etc/profile + ~/.profile (which adds
 * ~/.local/bin) but bails out of ~/.bashrc's nvm block early because it is
 * non-interactive — which is precisely why bare `agents` is missing there.
 */
function loginProbeEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.PATH;
  delete env.NVM_BIN;
  delete env.NVM_INC;
  for (const k of Object.keys(env)) if (k.startsWith('npm_')) delete env[k];
  return env;
}

/**
 * Does a fresh `bash -lc` resolve `cmd` on its PATH? This is the real question
 * for the consumers we heal. Best-effort: any probe failure returns false so
 * the caller heals rather than wrongly assuming success. `command -v` is a
 * POSIX builtin.
 */
export function loginShellResolves(cmd: string): boolean {
  try {
    const res = spawnSync(bashPath(), ['-lc', `command -v ${cmd}`], {
      stdio: ['ignore', 'pipe', 'ignore'],
      encoding: 'utf-8',
      timeout: 5000,
      env: loginProbeEnv(),
    });
    return res.status === 0 && !!res.stdout && res.stdout.trim().length > 0;
  } catch {
    return false;
  }
}

/** Is `dir` on a fresh `bash -lc` PATH? Best-effort; a probe failure returns false. */
export function dirOnLoginPath(dir: string): boolean {
  try {
    const res = spawnSync(bashPath(), ['-lc', 'printf %s "$PATH"'], {
      stdio: ['ignore', 'pipe', 'ignore'],
      encoding: 'utf-8',
      timeout: 5000,
      env: loginProbeEnv(),
    });
    if (res.status !== 0 || !res.stdout) return false;
    const want = path.resolve(dir);
    return res.stdout.split(':').some((p) => p && path.resolve(p) === want);
  } catch {
    return false;
  }
}
