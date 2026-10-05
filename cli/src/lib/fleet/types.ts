/** Shared types for the fleet profile-sync feature (`agents apply`): the additive `fleet:` block
 * in `agents.yaml` declares which agents, config scopes and login handling each device gets. */

/** How login/token state propagates: `sync` (default) pushes portable credentials where possible
 * and surfaces the rest as a manual login; `skip` only probes/reports. A per-agent interactive
 * `prompt` mode was removed rather than accepted as a silent no-op. */
export type FleetLoginMode = 'sync' | 'skip';

/** Defaults applied to every targeted device unless a per-device entry overrides. */
export interface FleetDefaults {
  /** Agent specs to ensure installed, e.g. `['claude@latest', 'codex@latest']`. */
  agents?: string[];
  /** Config sync scopes to reconcile on each device, e.g. `['user']`. */
  sync?: string[];
  /** Login propagation strategy. Default `'sync'`. */
  login?: FleetLoginMode;
  /** Fleet-wide config defaults (`agents devices config --fleet`): the middle layer of device
   * config (built-in default, `fleet.defaults.config`, per-device `config:`). Inert to the
   * reconcile engine; applies via the config read path. Names and non-secret values only. */
  config?: Record<string, unknown>;
}

/** Per-device override; any omitted field inherits from `defaults`. */
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
  /** Routine NAMES that should be active on the fleet (files sync via the repo). */
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

/** One dismissal record in {@link FleetManifest.ignored}. */
export interface IgnoredDeviceEntry {
  /** Tailscale node name the user dismissed. */
  name: string;
  /** ISO-8601 timestamp of the dismissal. */
  ignoredAt: string;
  /** machineId() of the box the dismissal was made on. */
  ignoredOn: string;
}

/** A device's desired state after merging defaults with its override and expanding `devices:
 * all`; what the reconcile engine drives toward. */
export interface DeviceDesired {
  /** Registered device name (from `agents devices`). */
  device: string;
  /** Resolved agent specs to ensure installed. */
  agents: string[];
  /** Config sync scopes. */
  sync: string[];
  /** Login propagation strategy for this device. */
  login: FleetLoginMode;
}

/** What a probe found on one device, from `readyProbe` plus an installed-agents listing;
 * `reachable: false` short-circuits the rest. */
export interface DeviceProbe {
  device: string;
  reachable: boolean;
  /** Platform of the device (`linux` | `macos` | `windows`), for login classification. */
  platform?: string;
  /** agents-cli version present on the device (undefined if not installed). */
  cliVersion?: string;
  /** Agent ids currently installed on the device. */
  installedAgents: string[];
  /** Installed versions per agent id, parsed from `agents view --json` on the device. Populated
   * only when the plan has a version-pinned spec (`claude@2.1.170` or an `@all` expansion), so
   * bare rosters skip the probe. When undefined, pinned specs fall back to id-level presence. */
  installedVersions?: Record<string, string[]>;
  /** Secrets bundles already on the device: name to `updated_at` ('' if none). Populated only
   * when the manifest declares bundles and `--provision-secrets` is set. Metadata only: `agents
   * secrets list --json` never returns values, which makes the probe safe. */
  remoteBundles?: Record<string, string>;
  /** Reason string when `reachable` is false or the probe partially failed. */
  note?: string;
}

/** One planned action against a device, in a single reconcile dimension. */
export type FleetActionKind =
  | 'install-cli'
  | 'upgrade-cli'
  | 'add-agent'
  | 'sync-config'
  | 'needs-login'
  /** Push a declared secrets bundle to the device over SSH. Opt-in only
   * (`--provision-secrets`) and gated on a pinned host key, because this moves
   * credential VALUES to another machine (RUSH-1968). */
  | 'push-secret'
  /** A declared secrets bundle that could NOT be pushed — the flag is off, the
   * host key isn't pinned, or the bundle is already current. Surfaced as a manual
   * recreate, like `needs-login`. */
  | 'needs-secret';

export interface FleetAction {
  device: string;
  kind: FleetActionKind;
  /** Agent id for agent/login actions; undefined for cli/config actions. */
  agent?: string;
  /** Full agent spec for `add-agent` (e.g. `claude@2.1.170`) so the plan can show
   * the exact version being installed; equals the id for a bare/latest spec. */
  spec?: string;
  /** Bundle name for `push-secret` / `needs-secret`, so the executor pushes the
   *  bundle the planner decided on rather than re-deriving it from the detail
   *  string. */
  bundle?: string;
  /** Human, one-line description of the action. */
  detail: string;
}

/** The full reconcile plan: per-device desired vs probed plus the flat action list. Pure output
 * of `diffFleet`; drives `--plan` and the confirm prompt. */
export interface FleetPlan {
  devices: DeviceDiff[];
  actions: FleetAction[];
}

/** Per-device diff row rendered in the plan matrix. */
export interface DeviceDiff {
  device: string;
  desired: DeviceDesired;
  probe: DeviceProbe;
  actions: FleetAction[];
  /** Agents that must be logged in on the device but can't be propagated
   * (source token is device-bound, e.g. macOS keychain). Surfaced, not faked. */
  loginBlocked: string[];
  /** Secrets-bundle names the profile declares that must be recreated on the
   * device (values are keychain-local — never captured or pushed). Surfaced. */
  secretsNeeded: string[];
}

/** A portable auth file captured from a source agent home, ready to propagate. */
export interface AuthFilePayload {
  /** Agent id this file belongs to. */
  agent: string;
  /** Path relative to the agent's config dir (or $HOME), reconstructed on target. */
  rel: string;
  /** File contents, base64. */
  contentB64: string;
  /** POSIX mode to restore (e.g. 0o600 for credentials). */
  mode: number;
}

/** Result of classifying one source agent's auth for propagation. */
export interface AuthSnapshotResult {
  files: AuthFilePayload[];
  /** Agent ids whose auth is device-bound (keychain) and cannot be captured. */
  bound: string[];
}
