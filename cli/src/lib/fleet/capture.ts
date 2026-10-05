/** Serializes the live environment into a `fleet:` manifest. `captureFleet` is pure (previous
 * manifest plus gathered inputs); all I/O lives in `commands/fleet-capture.ts`, so the
 * names-only privacy contract (never IPs or usernames) is testable. */

import type {
  FleetManifest,
  FleetDefaults,
  FleetDeviceOverride,
} from './types.js';

export interface CaptureInputs {
  /** Registered device names to record (the roster — names only). */
  devices: string[];
  /** Optional per-device agent specs (e.g. from `--from-pins`), keyed by name. */
  agentsByDevice?: Record<string, string[]>;
  /** Fleet defaults to seed when the manifest has none (source's own agents). */
  defaults?: FleetDefaults;
  /** Secrets-bundle NAMES to ensure exist (values stay in the keychain). */
  secretsBundles?: string[];
  /** Routine NAMES that should be active on the fleet. */
  routines?: string[];
}

/** Builds the new `fleet:` manifest from the previous one and captured inputs. Pure; the result
 * carries device names and desired state only, so serializing it can assert no address or
 * username appears. */
export function captureFleet(prev: FleetManifest | undefined, inputs: CaptureInputs): FleetManifest {
  const prevDevices = prev && prev.devices !== 'all' && typeof prev.devices === 'object'
    ? prev.devices
    : {};

  // Roster: a hand-authored override for a still-existing device is preserved; a captured agent
  // list fills in only when none is pinned. A device absent from `inputs.devices` drops out.
  // A legacy `config:` (#2458) is carried forward so capture cannot re-strip an unmigrated peer.
  const devices: Record<string, FleetDeviceOverride> = {};
  for (const [name, prevOverride] of Object.entries(prevDevices)) {
    if (inputs.devices.includes(name)) continue; // handled by the roster loop below
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
    // Keep hand-authored defaults; otherwise seed from the source snapshot.
    defaults: prev?.defaults ?? inputs.defaults ?? {},
    devices,
  };

  if (prev?.discovery && Object.keys(prev.discovery).length > 0) {
    manifest.discovery = { ...prev.discovery };
  }

  // Dismissals are operator state, not live state — a capture must never wipe
  // them (fleet.ignored syncs; losing it re-suggests every dismissed node
  // fleet-wide). Carry forward verbatim, same contract as `discovery`.
  if (prev?.ignored && prev.ignored.length > 0) {
    manifest.ignored = prev.ignored.map((e) => ({ ...e }));
  }

  const bundles = inputs.secretsBundles ?? prev?.secrets?.bundles;
  if (bundles && bundles.length > 0) manifest.secrets = { bundles: [...bundles].sort() };

  const routines = inputs.routines ?? prev?.routines;
  if (routines && routines.length > 0) manifest.routines = [...routines].sort();

  return manifest;
}
