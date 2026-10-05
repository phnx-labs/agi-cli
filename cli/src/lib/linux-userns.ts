/** Detects unprivileged userns on Linux (PHNX-3285). Codex >=0.146 sandboxes with bubblewrap, which
 * needs one; Ubuntu 24.04 denies it by default and a headless run lands zero tools. Only
 * `danger-full-access` (`skip`) avoids bwrap. Pure core: interpretUsernsInputs. */
import { execFileSync } from 'child_process';
import * as fs from 'fs';

/** Path of the AppArmor knob that gates unprivileged userns on Ubuntu 23.10+. */
export const APPARMOR_USERNS_SYSCTL_PATH =
  '/proc/sys/kernel/apparmor_restrict_unprivileged_userns';

export type UsernsState =
  /** A new user namespace with a uid map can be created — Codex's sandbox works. */
  | 'ok'
  /** Unprivileged userns is restricted — Codex's bwrap sandbox cannot start. */
  | 'blocked'
  /** Could not determine (non-Linux, or the probe could not run). */
  | 'unknown';

export interface UsernsStatus {
  state: UsernsState;
  /** One-line human reason, present when `blocked` or `unknown`. */
  reason?: string;
}

/** The raw signals the pure interpreter reasons over. */
interface UsernsInputs {
  platform: NodeJS.Platform;
  /** Trimmed contents of APPARMOR_USERNS_SYSCTL_PATH, or null when absent (older kernel / no
   * AppArmor userns mediation). */
  apparmorRestrict: string | null;
  /** Result of attempting a user namespace with a uid map: 'ok' (created and mapped root), 'denied'
   * (kernel refused the uid_map write), 'no-tool' (`unshare` missing or failed to spawn). */
  unshareProbe: 'ok' | 'denied' | 'no-tool';
}

/** Decides userns availability from raw signals, no I/O. The probe is definitive: success means the
 * sandbox works even if the sysctl is 1; denial is `blocked`. With no probe tool, sysctl `1` is
 * `blocked`, else `unknown` (never claim `ok` unobserved). */
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

  // Probe tool unavailable — lean on the AppArmor knob.
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

/** Read the AppArmor userns sysctl, or null when the file is absent. */
export function readApparmorRestrict(
  sysctlPath: string = APPARMOR_USERNS_SYSCTL_PATH,
): string | null {
  try {
    return fs.readFileSync(sysctlPath, 'utf8').trim();
  } catch {
    return null;
  }
}

/** Attempts the same operation bwrap does (`unshare --user --map-root-user`). This is ground truth
 * for what the kernel/AppArmor policy permits this process, rather than inferring from the sysctl. */
export function probeUnshare(): 'ok' | 'denied' | 'no-tool' {
  try {
    execFileSync('unshare', ['--user', '--map-root-user', 'true'], {
      stdio: 'ignore',
      timeout: 5000,
    });
    return 'ok';
  } catch (err: unknown) {
    // ENOENT / spawn failure → the tool isn't here; anything else (nonzero exit
    // from the denied uid_map write) is the restricted case.
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === 'ENOENT') return 'no-tool';
    return 'denied';
  }
}

let cached: UsernsStatus | null = null;

/** Whether an unprivileged userns can be created here, cached per process (a stable property of the
 * box). Non-Linux returns `ok` without spawning anything. */
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
