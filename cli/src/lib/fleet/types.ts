
export type FleetLoginMode = 'sync' | 'skip';

export interface FleetDefaults {
  agents?: string[];
  sync?: string[];
  login?: FleetLoginMode;
  config?: Record<string, unknown>;
}

export interface FleetDeviceOverride {
  agents?: string[];
  sync?: string[];
  login?: FleetLoginMode;
  config?: Record<string, unknown>;
}

export interface FleetManifest {
  defaults?: FleetDefaults;
  devices: 'all' | Record<string, FleetDeviceOverride>;
  secrets?: { bundles?: string[] };
  routines?: string[];
  discovery?: Record<string, 'approved' | 'ignored'>;
  ignored?: IgnoredDeviceEntry[];
}

export interface IgnoredDeviceEntry {
  name: string;
  ignoredAt: string;
  ignoredOn: string;
}

export interface DeviceDesired {
  device: string;
  agents: string[];
  sync: string[];
  login: FleetLoginMode;
}

export interface DeviceProbe {
  device: string;
  reachable: boolean;
  platform?: string;
  cliVersion?: string;
  installedAgents: string[];
  installedVersions?: Record<string, string[]>;
  remoteBundles?: Record<string, string>;
  note?: string;
}

export type FleetActionKind =
  | 'install-cli'
  | 'upgrade-cli'
  | 'add-agent'
  | 'sync-config'
  | 'needs-login'
  | 'push-secret'
  | 'needs-secret';

export interface FleetAction {
  device: string;
  kind: FleetActionKind;
  agent?: string;
  spec?: string;
  bundle?: string;
  detail: string;
}

export interface FleetPlan {
  devices: DeviceDiff[];
  actions: FleetAction[];
}

export interface DeviceDiff {
  device: string;
  desired: DeviceDesired;
  probe: DeviceProbe;
  actions: FleetAction[];
  loginBlocked: string[];
  secretsNeeded: string[];
}

export interface AuthFilePayload {
  agent: string;
  rel: string;
  contentB64: string;
  mode: number;
}

export interface AuthSnapshotResult {
  files: AuthFilePayload[];
  bound: string[];
}
