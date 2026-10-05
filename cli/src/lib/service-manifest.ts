import * as crypto from 'crypto';
import * as os from 'os';
import * as path from 'path';

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

export function namespacedServiceLabel(base: string): string {
  // Redirected homes namespace labels but still share the real per-user service manager.
  const suffix = isolatedHomeSuffix();
  return suffix ? `${base}.sandbox-${suffix}` : base;
}

export function serviceManifestHomeEnv(): { HOME: string; AGENTS_REAL_HOME: string } {
  // Service managers do not inherit the writer's HOME; every manifest pins both homes.
  const home = process.env.HOME || os.homedir();
  return { HOME: home, AGENTS_REAL_HOME: process.env.AGENTS_REAL_HOME || home };
}

export function serviceManagerRegistrationAllowed(): { allowed: boolean; reason: string } {
  // Registration under redirected HOME requires the explicit test seam.
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
