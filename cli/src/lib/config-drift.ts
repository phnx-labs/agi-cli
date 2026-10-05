/** Config drift: has this box drained its device-scoped state into `devices/<host>/agents.yaml`, or
 * still carries it in the shared `agents.yaml` (PHNX-3315)? Read-only: it must not run the
 * migration (that would drain the leak it reports), so it reads the raw user file. */

import { hasStaleMetaHeader, readTopLevelUserMeta } from './state.js';

export interface ConfigDrift {
  /** Top-level `agents.yaml` header != the current META_HEADER (the P1 case). */
  staleHeader: boolean;
  /** Labels of central blocks that should have folded into this box's device doc but linger: the P1
   * `browser` tombstone and P2 `fleet` / `hosts` / `accounts`. Empty on a drained box. */
  centralLeaks: string[];
}

function isMap(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

/** Inspect on-disk state for config drift. Pure read; mirrors the gather step of
 * migrateDeviceConfigStores plus the browser tombstone, so a leak is exactly what a fold would
 * drain. */
export function detectConfigDrift(): ConfigDrift {
  const staleHeader = hasStaleMetaHeader();
  const raw = readTopLevelUserMeta();
  const centralLeaks: string[] = [];

  if (raw) {
    // P1: the leftover central `browser:` tombstone (should fold into deviceBrowser).
    if (isMap(raw.browser) && Object.keys(raw.browser).length > 0) {
      centralLeaks.push('browser');
    }

    // P2: fleet.discovery / fleet.ignored, and the short-lived per-device config
    // store under fleet.devices.<name>.config — all fold into the device doc.
    const fleet = isMap(raw.fleet) ? raw.fleet : undefined;
    if (fleet) {
      if (isMap(fleet.discovery) && Object.keys(fleet.discovery).length > 0) {
        centralLeaks.push('fleet.discovery');
      }
      if (Array.isArray(fleet.ignored) && fleet.ignored.length > 0) {
        centralLeaks.push('fleet.ignored');
      }
      if (isMap(fleet.devices)) {
        const anyDeviceConfig = Object.values(fleet.devices).some(
          (ov) => isMap(ov) && isMap(ov.config) && Object.keys(ov.config).length > 0,
        );
        if (anyDeviceConfig) centralLeaks.push('fleet.devices.*.config');
      }
    }

    // P2: the central `hosts:` registry (should fold into deviceHosts).
    if (isMap(raw.hosts) && Object.keys(raw.hosts).length > 0) {
      centralLeaks.push('hosts');
    }

    // P2: central native accounts marked scope:'device' — identity PII that
    // belongs in the device doc, off the git-tracked shared file. Fleet-shared /
    // version-scoped identities stay central and are NOT a leak.
    const accounts = isMap(raw.accounts) ? raw.accounts : undefined;
    const native = accounts && isMap(accounts.native) ? accounts.native : undefined;
    if (native && Object.values(native).some((a) => isMap(a) && a.scope === 'device')) {
      centralLeaks.push('accounts (device-scoped)');
    }
  }

  return { staleHeader, centralLeaks };
}

/** True when either drift class is present. */
export function hasConfigDrift(d: ConfigDrift): boolean {
  return d.staleHeader || d.centralLeaks.length > 0;
}
