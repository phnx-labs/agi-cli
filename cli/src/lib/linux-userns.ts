import { execFileSync } from 'child_process';
import * as fs from 'fs';

export const APPARMOR_USERNS_SYSCTL_PATH =
  '/proc/sys/kernel/apparmor_restrict_unprivileged_userns';

export type UsernsState =
  | 'ok'
  | 'blocked'
  | 'unknown';

export interface UsernsStatus {
  state: UsernsState;
  reason?: string;
}

interface UsernsInputs {
  platform: NodeJS.Platform;
  apparmorRestrict: string | null;
  unshareProbe: 'ok' | 'denied' | 'no-tool';
}

export function interpretUsernsInputs(inputs: UsernsInputs): UsernsStatus {
  if (inputs.platform !== 'linux') return { state: 'ok' };

  if (inputs.unshareProbe === 'ok') return { state: 'ok' };

  if (inputs.unshareProbe === 'denied') {
    const via =
      inputs.apparmorRestrict === '1'
        ? ' (kernel.apparmor_restrict_unprivileged_userns=1)'
        : '';
    return {
      state: 'blocked',
      reason: `the kernel denied creating an unprivileged user namespace${via}`,
    };
  }

  if (inputs.apparmorRestrict === '1') {
    return {
      state: 'blocked',
      reason:
        'unprivileged user namespaces are AppArmor-restricted ' +
        '(kernel.apparmor_restrict_unprivileged_userns=1) and `unshare` was not available to confirm',
    };
  }
  return {
    state: 'unknown',
    reason: '`unshare` was not available to probe user-namespace support',
  };
}

export function readApparmorRestrict(
  sysctlPath: string = APPARMOR_USERNS_SYSCTL_PATH,
): string | null {
  try {
    return fs.readFileSync(sysctlPath, 'utf8').trim();
  } catch {
    return null;
  }
}

export function probeUnshare(): 'ok' | 'denied' | 'no-tool' {
  try {
    execFileSync('unshare', ['--user', '--map-root-user', 'true'], {
      stdio: 'ignore',
      timeout: 5000,
    });
    return 'ok';
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === 'ENOENT') return 'no-tool';
    return 'denied';
  }
}

let cached: UsernsStatus | null = null;

export function probeUnprivilegedUserns(
  platform: NodeJS.Platform = process.platform,
): UsernsStatus {
  if (platform !== 'linux') return { state: 'ok' };
  if (cached) return cached;
  cached = interpretUsernsInputs({
    platform,
    apparmorRestrict: readApparmorRestrict(),
    unshareProbe: probeUnshare(),
  });
  return cached;
}
