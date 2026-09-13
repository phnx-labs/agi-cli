/**
 * Shared types for the fleet profile-sync feature (`agents apply` / `ag apply`).
 *
 * `agents.yaml` gains an additive `fleet:` block that declares a *profile*: which
 * agents every device should have installed, which config scopes to reconcile,
 * and whether logins/tokens propagate. `apply` reconciles the live fleet to it.
 *
 * These types are the contract shared by the manifest parser (`manifest.ts`),
 * the reconcile engine (`apply.ts`), the auth propagation (`auth-sync.ts`), and
 * the command (`commands/apply.ts`). Runtime probe/diff shapes live here too so
 * the pure diff can be unit-tested without SSH.
 */

/**
 * How login/token state propagates to a device.
 * - `sync` (default): push portable credentials where possible, surface the rest
 *   as a manual login.
 * - `skip`: probe/report only; take no login action.
 * (A per-agent interactive `prompt` mode is intentionally not offered yet — it
 * was removed rather than accepted as a silent no-op that behaves like `skip`.)
 */
export type FleetLoginMode = 'sync' | 'skip';

/** Defaults applied to every targeted device unless a per-device entry overrides. */
export interface FleetDefaults {
  /** Agent specs to ensure installed, e.g. `['claude@latest', 'codex@latest']`. */
  agents?: string[];
  /** Config sync scopes to reconcile on each device, e.g. `['user']`. */
  sync?: string[];
  /** Login propagation strategy. Default `'sync'`. */
  login?: FleetLoginMode;
  /**
   * Fleet-wide config defaults (`agents devices config --fleet <key> <value>`)
   * — the middle layer of the device-config store: built-in default <
   * `fleet.defaults.config` < per-device `devices/<name>/agents.yaml`
   * `config:`. Inert to the reconcile engine (apply never pushes it; it takes
   * effect through the config read path). Names and non-secret values only.
   */
  config?: Record<string, unknown>;
}

/** Per-device override; any omitted field inherits from `defaults`. */
export interface FleetDeviceOverride {
  agents?: string[];
  sync?: string[];
  login?: FleetLoginMode;
  /**
   * LEGACY home of per-device operator config (#2458); the current store is the
   * per-device doc `devices/<name>/agents.yaml` `config:` block. Existing
   * values are folded into the device doc by lib/devices/config-migration.ts
   * and stripped here — current code never writes this field.
   */
  config?: Record<string, unknown>;
}

/**
 * The `fleet:` block as it appears in `agents.yaml` (or any `-f` file). `devices`
 * is either the literal string `'all'` (every online registered device minus the
 * source machine) or an explicit map of device-name -> override.
 */
export interface FleetManifest {
  defaults?: FleetDefaults;
  devices: 'all' | Record<string, FleetDeviceOverride>;
  /**
   * Fleet-wide extras captured by `agents fleet capture` so a fresh machine can
   * reconstruct the whole environment, not just installed agents. All additive,
   * portable, and LEAK-FREE — names only, never connection details.
   *
   * (Browser profiles are deliberately NOT captured here: the central `browser:`
   * block already syncs verbatim via `agents repo push/pull`, so duplicating it
   * would be redundant — and its ssh:// endpoints can carry `user@host`, which
   * must never be copied into a second location.)
   */
  /** Secrets-bundle NAMES to ensure exist — values live in the keychain and are
   * never captured or pushed; `apply` surfaces missing bundles to recreate. */
  secrets?: { bundles?: string[] };
  /** Routine NAMES that should be active on the fleet (files sync via the repo). */
  routines?: string[];
  /**
   * Portable user decisions for Tailscale discovery. A name maps to `approved`
   * or `ignored`; absence means pending. Connection metadata remains in each
   * machine's local device registry and is never committed.
   */
  discovery?: Record<string, 'approved' | 'ignored'>;
  /**
   * Tailnet node names the user dismissed from auto-discovery, with who
   * dismissed each and when. Lives here rather than in a per-device doc because
   * a dismissed node is deliberately NOT a device — it never enters the
   * registry, so it has no per-device folder. Syncs fleet-wide with the rest of
   * `agents.yaml`, so a dismissal on one box stops the suggestion on every box.
   */
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

/**
 * A device's desired state after merging defaults with its override and
 * expanding `devices: all`. This is what the reconcile engine drives toward.
 */
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

/**
 * What a probe found on one device. Populated from `readyProbe` plus an
 * installed-agents listing; `reachable: false` short-circuits everything else.
 */
export interface DeviceProbe {
  device: string;
  reachable: boolean;
  /** Platform of the device (`linux` | `macos` | `windows`), for login classification. */
  platform?: string;
  /** agents-cli version present on the device (undefined if not installed). */
  cliVersion?: string;
  /** Agent ids currently installed on the device. */
  installedAgents: string[];
  /**
   * Installed version strings per agent id (e.g. `{ claude: ['2.1.170', '2.1.207'] }`),
   * parsed from `agents view --json` on the device. Only populated when the plan
   * involves a version-pinned spec (`claude@2.1.170`, or a `claude@all` expansion)
   * — a bare `claude`/`claude@latest` roster never pays for the extra probe. When
   * undefined, version-pinned specs fall back to id-level presence.
   */
  installedVersions?: Record<string, string[]>;
  /**
   * Secrets bundles already present on the device: name -> `updated_at` (or ''
   * when the remote reports none). Only populated when the manifest declares
   * bundles AND `--provision-secrets` is set — a fleet that uses no bundles
   * never pays for the extra round trip.
   *
   * METADATA ONLY. `agents secrets list --json` returns names and timestamps and
   * explicitly never values, which is what makes this probe safe to run.
   */
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

/**
 * The full reconcile plan: per-device desired vs probed, plus the flat list of
 * actions. Pure output of `diffFleet(desired, probes)` — drives both `--plan`
 * rendering and the confirm prompt.
 */
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
