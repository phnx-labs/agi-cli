/** Shared types for the fleet profile-sync feature (`agents apply`): the additive `fleet:` block
 * in `agents.yaml` declares which agents, config scopes and login handling each device gets. */

/** How login/token state propagates: `sync` (default) pushes portable credentials where possible
 * and surfaces the rest as a manual login; `skip` only probes/reports. A per-agent interactive
 * `prompt` mode was removed rather than accepted as a silent no-op. */
export type FleetLoginMode = 'sync' | 'skip';

export interface FleetDefaults {
  agents?: string[];
  sync?: string[];
  login?: FleetLoginMode;
  /** Fleet-wide config defaults (`agents devices config --fleet`): the middle layer of device
   * config (built-in default, `fleet.defaults.config`, per-device `config:`). Inert to the
   * reconcile engine; applies via the config read path. Names and non-secret values only. */
  config?: Record<string, unknown>;
}

export interface FleetDeviceOverride {
  agents?: string[];
  sync?: string[];
  login?: FleetLoginMode;
  /** LEGACY home of per-device operator config (#2458); the current store is the per-device doc
   * `devices/<name>/agents.yaml` `config:`. lib/devices/config-migration.ts folds existing
   * values in and strips them here; current code never writes this field. */
  config?: Record<string, unknown>;
}

/** The `fleet:` block as it appears in `agents.yaml` (or any `-f` file). `devices` is `'all'`
 * (every online registered device minus the source) or an explicit map of device name to
 * override. */
export interface FleetManifest {
  defaults?: FleetDefaults;
  devices: 'all' | Record<string, FleetDeviceOverride>;
  /** Fleet-wide extras captured by `agents fleet capture` so a fresh machine can rebuild the
   * environment: additive, portable and leak-free (names only, never connection details).
   * Browser profiles are not captured: their ssh:// endpoints can carry user@host. */
  /** Secrets-bundle NAMES to ensure exist — values live in the keychain and are
   * never captured or pushed; `apply` surfaces missing bundles to recreate. */
  secrets?: { bundles?: string[] };
  routines?: string[];
  /** Portable user decisions for Tailscale discovery: a name maps to `approved` or `ignored`,
   * absence means pending. Connection metadata stays in each machine's local registry and is
   * never committed. */
  discovery?: Record<string, 'approved' | 'ignored'>;
  /** Tailnet node names dismissed from auto-discovery, with who and when. Kept here, not in a
   * per-device doc, since a dismissed node is not a device and has no per-device folder; it
   * syncs with `agents.yaml`, so a dismissal on one box stops the suggestion everywhere. */
  ignored?: IgnoredDeviceEntry[];
}

export interface IgnoredDeviceEntry {
  name: string;
  ignoredAt: string;
  ignoredOn: string;
}

/** A device's desired state after merging defaults with its override and expanding `devices:
 * all`; what the reconcile engine drives toward. */
export interface DeviceDesired {
  device: string;
  agents: string[];
  sync: string[];
  login: FleetLoginMode;
}

/** What a probe found on one device, from `readyProbe` plus an installed-agents listing;
 * `reachable: false` short-circuits the rest. */
export interface DeviceProbe {
  device: string;
  reachable: boolean;
  platform?: string;
  cliVersion?: string;
  installedAgents: string[];
  /** Installed versions per agent id, parsed from `agents view --json` on the device. Populated
   * only when the plan has a version-pinned spec (`claude@2.1.170` or an `@all` expansion), so
   * bare rosters skip the probe. When undefined, pinned specs fall back to id-level presence. */
  installedVersions?: Record<string, string[]>;
  /** Secrets bundles already on the device: name to `updated_at` ('' if none). Populated only
   * when the manifest declares bundles and `--provision-secrets` is set. Metadata only: `agents
   * secrets list --json` never returns values, which makes the probe safe. */
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

/** The full reconcile plan: per-device desired vs probed plus the flat action list. Pure output
 * of `diffFleet`; drives `--plan` and the confirm prompt. */
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
