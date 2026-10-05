
import type {
  FleetManifest,
  FleetDefaults,
  FleetDeviceOverride,
} from './types.js';

export interface CaptureInputs {
  devices: string[];
  agentsByDevice?: Record<string, string[]>;
  defaults?: FleetDefaults;
  secretsBundles?: string[];
  routines?: string[];
}

// Capture serializes device names only; addresses and usernames never enter the manifest.
export function captureFleet(prev: FleetManifest | undefined, inputs: CaptureInputs): FleetManifest {
  const prevDevices = prev && prev.devices !== 'all' && typeof prev.devices === 'object'
    ? prev.devices
    : {};

  const devices: Record<string, FleetDeviceOverride> = {};
  // Preserve hand-authored config for absent peers and legacy manifests during migration.
  for (const [name, prevOverride] of Object.entries(prevDevices)) {
    if (inputs.devices.includes(name)) continue;
    const config = prevOverride?.config;
    if (config && Object.keys(config).length > 0) devices[name] = { config };
  }
  for (const name of inputs.devices) {
    const prevOverride = prevDevices[name] ?? {};
    const override: FleetDeviceOverride = { ...prevOverride };
    const captured = inputs.agentsByDevice?.[name];
    if (override.agents === undefined && captured && captured.length > 0) {
      override.agents = captured;
    }
    devices[name] = override;
  }

  const manifest: FleetManifest = {
    defaults: prev?.defaults ?? inputs.defaults ?? {},
    devices,
  };

  if (prev?.discovery && Object.keys(prev.discovery).length > 0) {
    manifest.discovery = { ...prev.discovery };
  }

  // Discovery dismissals are operator state, not disposable scan output.
  if (prev?.ignored && prev.ignored.length > 0) {
    manifest.ignored = prev.ignored.map((e) => ({ ...e }));
  }

  const bundles = inputs.secretsBundles ?? prev?.secrets?.bundles;
  if (bundles && bundles.length > 0) manifest.secrets = { bundles: [...bundles].sort() };

  const routines = inputs.routines ?? prev?.routines;
  if (routines && routines.length > 0) manifest.routines = [...routines].sort();

  return manifest;
}
