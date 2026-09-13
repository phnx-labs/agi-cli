/**
 * Unprivileged user-namespace availability on Linux — the capability Codex's
 * Linux sandbox needs, and the one Ubuntu 23.10+ restricts by default.
 *
 * Codex ≥0.146 implements its `read-only` and `workspace-write` sandbox modes on
 * Linux with a bundled **bubblewrap** (`bwrap`), extracted per-run to
 * `$CODEX_HOME/tmp/arg0/codex-XXXX/` and exec'd from a memfd. bwrap sets up its
 * mounts inside a fresh **unprivileged user namespace** (`--unshare-user`, then a
 * write to `/proc/self/uid_map`). Ubuntu 24.04 ships
 * `kernel.apparmor_restrict_unprivileged_userns=1`, which denies that to an
 * unconfined binary — so bwrap dies with `bwrap: setting up uid map: Permission
 * denied` and a headless Codex run lands zero tools (no file writes, no shell).
 * `danger-full-access` (our `skip` mode) drops the sandbox and is the only mode
 * that avoids bwrap; the legacy Landlock backend is gone (`use_linux_sandbox_bwrap`
 * is `removed`, `use_legacy_landlock` panics under the permission-profile model).
 *
 * This module is the single detector. It is pure at its core
 * ({@link interpretUsernsInputs}) so the decision is unit-testable without a
 * shell, and {@link probeUnprivilegedUserns} gathers the real inputs once per
 * process. See PHNX-3285.
 */
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
  /**
   * Contents of {@link APPARMOR_USERNS_SYSCTL_PATH} trimmed, or null when the
   * file is absent (older kernels / no AppArmor userns mediation).
   */
  apparmorRestrict: string | null;
  /**
   * Result of actually attempting to create a user namespace with a uid map:
   *   - 'ok'      → the probe created the namespace and mapped root.
   *   - 'denied'  → the kernel refused the uid_map write (the restricted case).
   *   - 'no-tool' → the probe binary (`unshare`) was missing or failed to spawn.
   */
  unshareProbe: 'ok' | 'denied' | 'no-tool';
}

/**
 * Decide userns availability from raw signals. Pure — no I/O.
 *
 * The definitive signal is the actual probe: if we successfully created a userns
 * and wrote a uid map, the sandbox works regardless of the sysctl (an AppArmor
 * profile may grant a specific binary `userns` even while the global knob is 1).
 * A denied probe is a hard `blocked`. When the probe tool is missing we fall back
 * to the sysctl: `1` → `blocked`, `0`/absent → `unknown` (we could not prove it,
 * and refuse to claim `ok` we did not observe).
 */
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

/**
 * Actually try to create a user namespace and map root inside it — the same
 * operation bwrap performs (`unshare --user --map-root-user`). This is the ground
 * truth: it observes exactly what the kernel/AppArmor policy permits for *this*
 * process, rather than inferring from the sysctl alone.
 */
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

/**
 * Resolve whether an unprivileged user namespace can be created on this host,
 * cached for the process (the answer is a stable property of the box). Non-Linux
 * short-circuits to `ok` without spawning anything.
 */
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
