
import { hasStaleMetaHeader, readTopLevelUserMeta } from './state.js';

export interface ConfigDrift {
  staleHeader: boolean;
  centralLeaks: string[];
}

function isMap(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

export function detectConfigDrift(): ConfigDrift {
  const staleHeader = hasStaleMetaHeader();
  const raw = readTopLevelUserMeta();
  const centralLeaks: string[] = [];

  if (raw) {
    if (isMap(raw.browser) && Object.keys(raw.browser).length > 0) {
      centralLeaks.push('browser');
    }

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

    if (isMap(raw.hosts) && Object.keys(raw.hosts).length > 0) {
      centralLeaks.push('hosts');
    }

    const accounts = isMap(raw.accounts) ? raw.accounts : undefined;
    const native = accounts && isMap(accounts.native) ? accounts.native : undefined;
    if (native && Object.values(native).some((a) => isMap(a) && a.scope === 'device')) {
      centralLeaks.push('accounts (device-scoped)');
    }
  }

  return { staleHeader, centralLeaks };
}

export function hasConfigDrift(d: ConfigDrift): boolean {
  return d.staleHeader || d.centralLeaks.length > 0;
}
