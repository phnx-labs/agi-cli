/** One rule for every service manifest (launchd plists, systemd unit) (RUSH-2639). A service
 * manager does not inherit the caller's environment, so a manifest omitting HOME escapes the
 * hermetic sandbox. Labels too: launchctl/systemctl route by label alone. */
import * as crypto from 'crypto';
import * as os from 'os';
import * as path from 'path';

/** A short stable hash of this process's HOME, only when HOME is redirected from the real home.
 * `os.userInfo().homedir` ignores `$HOME` and `os.homedir()` honors it, so comparing them detects
 * redirection; production identifiers stay unchanged. */
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

/** Namespace a service identifier under a redirected HOME; returns `base` unchanged in production. */
export function namespacedServiceLabel(base: string): string {
  const suffix = isolatedHomeSuffix();
  return suffix ? `${base}.sandbox-${suffix}` : base;
}

/** The home environment every generated service manifest must carry, so the service-manager child
 * resolves the same home as the caller. `AGENTS_REAL_HOME` distinguishes an agent's isolated
 * version home from the installation home; pin it alongside HOME. */
export function serviceManifestHomeEnv(): { HOME: string; AGENTS_REAL_HOME: string } {
  const home = process.env.HOME || os.homedir();
  return { HOME: home, AGENTS_REAL_HOME: process.env.AGENTS_REAL_HOME || home };
}

/** Whether this process may register or tear down a service with the real service manager.
 * launchctl and `systemctl --user` ignore HOME, so a sandboxed process still reaches the real one.
 * `AGENTS_SERVICE_MANAGER_ALLOW_REDIRECTED_HOME=1` is a test-only opt-in. */
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
