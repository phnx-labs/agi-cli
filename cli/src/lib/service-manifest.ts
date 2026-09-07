/**
 * One rule for every service manifest this CLI writes — the launchd plists and
 * the systemd unit that a service manager, not this process, will later start.
 *
 * RUSH-2639. A service manager does NOT inherit the environment of whoever
 * called `launchctl bootstrap` / `systemctl --user start`. The started child
 * sees the login session's own environment plus whatever the manifest declares,
 * so a manifest that omits HOME hands its child the ACCOUNT home no matter what
 * HOME the process that generated and loaded it was running under. In
 * production that is a no-op — the login session's HOME already is the account
 * home — but under the hermetic test harness (`tests/setup.ts` redirects HOME to
 * a fork-private sandbox) it means a service-manager-started process silently
 * escapes the sandbox and bootstraps the developer's or the CI runner's REAL
 * `~/.agents` (`ensureAgentsDir`, `state.ts`, creates `.system`, `.history`,
 * `.cache`, `routines`).
 *
 * The same asymmetry applies to the service IDENTIFIER. `launchctl` and
 * `systemctl` route `bootout`/`bootstrap`/`unload`/`load`/`list` by identifier
 * alone, never by the manifest file's path, so a sandboxed instance's own
 * teardown of its own never-loaded manifest tears down whatever job the OS
 * already has registered under that same label — on a developer's machine, the
 * real always-on service; in CI, another concurrent test fork's.
 *
 * Both were fixed once for the daemon and left unfixed for the menu-bar helper
 * (`lib/menubar/install-menubar.ts`) and the computer helper
 * (`commands/computer.ts`), which is why the leak survived the daemon fix. This
 * module is the single place both rules live, so a new manifest has one obvious
 * thing to call.
 *
 * A third consumer that used to keep its own literal `SERVICE_LABEL` for a
 * retire-only `bootout` — the in-repo secrets broker's launchd cleanup — moved
 * out of this repo entirely with the standalone `secrets` engine (PHNX-3989).
 */
import * as crypto from 'crypto';
import * as os from 'os';
import * as path from 'path';

/**
 * A short, stable hash of this process's HOME when — and only when — HOME has
 * been redirected away from the account's real home.
 *
 * `os.userInfo().homedir` reads the OS/passwd record directly and ignores
 * `$HOME` (unlike `os.homedir()`, which honors it), so comparing the two
 * detects exactly that redirection: true for every hermetic test process, false
 * for every real interactive or production invocation. A real user's services
 * therefore keep registering under their unchanged production identifiers.
 */
export function isolatedHomeSuffix(): string | null {
  try {
    const effective = path.resolve(process.env.HOME || os.homedir());
    const real = path.resolve(os.userInfo().homedir);
    if (effective === real) return null;
    return crypto.createHash('sha256').update(effective).digest('hex').slice(0, 12);
  } catch {
    return null;
  }
}

/**
 * Namespace a service identifier under a redirected HOME. Returns `base`
 * unchanged for a real production invocation.
 */
export function namespacedServiceLabel(base: string): string {
  const suffix = isolatedHomeSuffix();
  return suffix ? `${base}.sandbox-${suffix}` : base;
}

/**
 * The home-resolution environment every generated service manifest must carry,
 * so the service-manager-started child resolves the SAME home the caller did.
 *
 * `AGENTS_REAL_HOME` is the canonical seam that distinguishes an agent's
 * isolated version home from the active installation home; pinning it alongside
 * HOME keeps a child that a login shell or service manager re-homes pointed at
 * the installation the caller meant.
 */
export function serviceManifestHomeEnv(): { HOME: string; AGENTS_REAL_HOME: string } {
  const home = process.env.HOME || os.homedir();
  return { HOME: home, AGENTS_REAL_HOME: process.env.AGENTS_REAL_HOME || home };
}

/**
 * Whether this process may safely register (or tear down) a service with the
 * user's real service manager.
 *
 * `launchctl` and `systemctl --user` are per-user-session and HOME-independent:
 * a process running under a redirected HOME still talks to the SAME launchd or
 * systemd instance as a normal login session. service-manifest.ts namespaces the
 * job label under a redirected HOME, but that only changes the identifier — the
 * registration still lands in the real service manager. A hermetic test fork (or
 * any CLI running under a sandbox HOME) must therefore never touch launchd/
 * systemd unless it has explicitly opted in.
 *
 * `AGENTS_SERVICE_MANAGER_ALLOW_REDIRECTED_HOME=1` is the test seam for the
 * shim/PATH-based tests that intentionally exercise the registration code path
 * under a redirected HOME. Production code must never set it.
 */
export function serviceManagerRegistrationAllowed(): { allowed: boolean; reason: string } {
  const suffix = isolatedHomeSuffix();
  if (!suffix) {
    return { allowed: true, reason: 'production HOME: service-manager registration allowed' };
  }
  if (process.env.AGENTS_SERVICE_MANAGER_ALLOW_REDIRECTED_HOME === '1') {
    return {
      allowed: true,
      reason: `test seam AGENTS_SERVICE_MANAGER_ALLOW_REDIRECTED_HOME allows registration under sandbox-${suffix}`,
    };
  }
  return {
    allowed: false,
    reason:
      `refusing service-manager registration under redirected HOME (sandbox-${suffix}): ` +
      `launchctl/systemd are per-user-session and HOME-independent, so a sandboxed process ` +
      `would register in the real service manager (RUSH-2968)`,
  };
}
