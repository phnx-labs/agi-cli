/**
 * Reconcile engine for `agents apply`. The diff (`diffFleet`) is pure and unit-
 * tested; execution (`probeDevice`, `reconcileDevice`, `runFleetApply`) drives
 * the real fleet over SSH and is verified end-to-end against live devices.
 *
 * Flow per device: probe → install/upgrade agents-cli → add missing agents →
 * sync config → propagate login. Every step reuses an existing primitive
 * (`readyProbe`, `bootstrapAgentsCli`, `buildRemoteAgentsInvocation`, `sshExec`).
 */

import * as os from 'os';
import type { DeviceProfile } from '../devices/registry.js';
import { pushBundleToHost } from '../secrets-client.js';
import type { RemoteBackend } from '../secrets-types.js';
import { AUTH_BUNDLE_NAME, inspectReservedAuthBundle, isReservedBundleName } from '../secrets-policy.js';
import { deviceIdentityArgs, sshTargetFor } from '../devices/connect.js';
import { readyProbe, bootstrapAgentsCli } from '../hosts/ready.js';
import { buildRemoteAgentsInvocation } from '../hosts/remote-cmd.js';
import { sshExec } from '../ssh-exec.js';
import type { TeamsDoctorEntry } from '../teams/agents.js';
import { hasPortableAuthFiles } from './auth-sync.js';
import type {
  DeviceDesired,
  DeviceProbe,
  DeviceDiff,
  FleetAction,
  FleetPlan,
  AuthFilePayload,
} from './types.js';

/** Strip a version suffix from an agent spec: `claude@latest` -> `claude`. */
export function agentIdOf(spec: string): string {
  return spec.split('@')[0].trim();
}

/**
 * The explicit pinned version of a spec, or undefined for an id-level spec.
 * `claude@2.1.170` -> `2.1.170`; `claude`, `claude@latest`, `claude@oldest`, and
 * `claude@all` all return undefined (the label channels install-latest / are
 * expanded upstream, so they diff at id granularity, not per-version).
 */
export function pinnedVersion(spec: string): string | undefined {
  const at = spec.indexOf('@');
  if (at < 0) return undefined;
  const v = spec.slice(at + 1).trim();
  if (!v || v === 'latest' || v === 'oldest' || v === 'all') return undefined;
  return v;
}

/** True when any spec in the roster pins an explicit version (needs a version probe). */
export function rosterNeedsVersions(desired: DeviceDesired[]): boolean {
  return desired.some((d) => d.agents.some((s) => pinnedVersion(s) !== undefined));
}

/**
 * Expand any `<agent>@all` spec into one pinned spec per version installed on the
 * source, so `--agent claude@all` replicates THIS machine's exact version set.
 * `versionsOf` returns the source's installed versions for an agent id. Every
 * other spec passes through unchanged; the result is de-duplicated in order.
 * Throws if `@all` names an agent with no installed versions here (nothing to
 * replicate — a clear misconfig, not a silent no-op).
 */
export function expandAllSpecs(specs: string[], versionsOf: (id: string) => string[]): string[] {
  const out: string[] = [];
  for (const spec of specs) {
    const at = spec.indexOf('@');
    const label = at >= 0 ? spec.slice(at + 1).trim() : '';
    if (label !== 'all') {
      out.push(spec);
      continue;
    }
    const id = agentIdOf(spec);
    const versions = versionsOf(id);
    if (versions.length === 0) {
      throw new Error(`--agent ${spec}: no ${id} versions installed on this machine to replicate.`);
    }
    for (const v of versions) out.push(`${id}@${v}`);
  }
  return [...new Set(out)];
}

/**
 * Parse `agents view --json` (the all-agents array form) into a map of agent id
 * -> installed version strings. Tolerant: returns undefined on any parse failure
 * so a version-pinned spec falls back to id-level presence rather than crashing.
 */
export function parseInstalledVersions(stdout: string): Record<string, string[]> | undefined {
  try {
    const arr = JSON.parse(stdout) as Array<{ agent?: unknown; versions?: unknown }>;
    if (!Array.isArray(arr)) return undefined;
    const out: Record<string, string[]> = {};
    for (const a of arr) {
      if (a && typeof a.agent === 'string' && Array.isArray(a.versions)) {
        out[a.agent] = (a.versions as Array<{ version?: unknown }>)
          .map((v) => v?.version)
          .filter((v): v is string => typeof v === 'string');
      }
    }
    return out;
  } catch {
    return undefined;
  }
}

/** Source-side auth availability, computed once from `snapshotAuth`. */
export interface SourceAuth {
  /** Agent ids the source has a readable, propagatable credential file for. */
  available: Set<string>;
  /** Agent ids whose source auth is device-bound (macOS keychain). */
  bound: Set<string>;
  /** The captured file payloads, keyed by agent. */
  filesByAgent: Map<string, AuthFilePayload[]>;
}

/**
 * Bundles `fleet apply` considers for push. The reserved file-backed `auth`
 * bundle is always included when it exists locally — it is the fleet-shared
 * setup-token store and must not wait on `--provision-secrets` / a manifest
 * list (PHNX-2371).
 */
export function fleetSecretsBundles(declared: string[] | undefined): string[] {
  const out = [...(declared ?? [])];
  const auth = inspectReservedAuthBundle();
  if (auth.exists && auth.ok && !out.includes(AUTH_BUNDLE_NAME)) {
    out.push(AUTH_BUNDLE_NAME);
  }
  return out;
}

export interface DiffContext {
  /** agents-cli version the source is on — the fleet target version. */
  targetCliVersion: string;
  sourceAuth: SourceAuth;
  /** Secrets-bundle names the profile declares. */
  secretsBundles?: string[];
  /** `--provision-secrets`. OFF by default: pushing a bundle moves credential
   *  VALUES to another machine, so it is opted into per invocation and never
   *  defaulted from the shared `agents.yaml` (RUSH-1968). */
  provisionSecrets?: boolean;
  /** Is this device's host key pinned? Injected so `decideSecretPush` stays pure
   *  and its refusals are testable against real known_hosts fixtures with no
   *  network. Absent = treated as unpinned, i.e. refuse. */
  isHostPinned?: (device: string) => boolean;
  /** `--force`: push a declared bundle even when the device already has it. */
  forceSecrets?: boolean;
}

/** Pure: desired vs probed -> per-device diff + flat action list. */
export function diffFleet(desired: DeviceDesired[], probes: Map<string, DeviceProbe>, ctx: DiffContext): FleetPlan {
  const devices: DeviceDiff[] = [];
  const actions: FleetAction[] = [];

  for (const d of desired) {
    const probe = probes.get(d.device) ?? {
      device: d.device,
      reachable: false,
      installedAgents: [],
      note: 'not probed',
    };
    const rowActions: FleetAction[] = [];
    const loginBlocked: string[] = [];
    const secretsNeeded: string[] = [];

    if (probe.reachable) {
      // agents-cli presence.
      if (!probe.cliVersion) {
        rowActions.push({ device: d.device, kind: 'install-cli', detail: `install agents-cli ${ctx.targetCliVersion}` });
      } else if (probe.cliVersion !== ctx.targetCliVersion) {
        rowActions.push({ device: d.device, kind: 'upgrade-cli', detail: `agents-cli ${probe.cliVersion} -> ${ctx.targetCliVersion}` });
      }
      // agents. A version-pinned spec (`claude@2.1.170`, or an expanded
      // `claude@all` member) is present only when that exact version is on the
      // device; a bare/latest spec diffs at id granularity. So `--agent claude@all`
      // installs every missing version even when some claude is already there.
      for (const spec of d.agents) {
        const id = agentIdOf(spec);
        const want = pinnedVersion(spec);
        const present = want !== undefined
          ? (probe.installedVersions?.[id]?.includes(want) ?? false)
          : probe.installedAgents.includes(id);
        if (!present) {
          rowActions.push({ device: d.device, kind: 'add-agent', agent: id, spec, detail: `install ${spec}` });
        }
      }
      // config.
      if (d.sync.length > 0) {
        rowActions.push({ device: d.device, kind: 'sync-config', detail: `sync config (${d.sync.join(', ')})` });
      }
      // login — per agent id, not per spec: `claude@all` names one id many times,
      // but a login is established once per agent (its credential is version-shared).
      if (d.login === 'sync') {
        for (const id of [...new Set(d.agents.map(agentIdOf))]) {
          // SING-1b: a native OAuth / session login MUST NOT be copied between
          // devices — a rotating token invalidates the fleet on its next refresh
          // (droid/WorkOS collapsed 10 boxes to 1 overnight). `apply` therefore no
          // longer propagates any login; it surfaces per-box login / portable
          // provider-account guidance for every agent that has a login to
          // establish. An agent with no portable login file, or a source that
          // isn't signed in, is silently skipped the same on every OS.
          if (hasPortableAuthFiles(id)) {
            loginBlocked.push(id);
            rowActions.push({
              device: d.device,
              kind: 'needs-login',
              agent: id,
              detail: `${id}: a native OAuth login can't be copied between devices (SING-1b) — log in on ${d.device} itself, or sync a portable provider account (agents accounts sync)`,
            });
          }
        }
      }
      // secrets. Declared once at the manifest level, so every reachable device
      // is considered. Historically this was ALWAYS a manual reminder — "surfaced,
      // never pushed" — and that gap is a direct cause of RUSH-1968: an operator
      // who needed secrets on a worker box had no supported path, so they
      // hand-exported the file store's master key across the fleet instead.
      //
      // It is now pushable, but only deliberately. `--provision-secrets` is off by
      // default and is a FLAG, not a manifest field: `agents.yaml` is shared, and
      // a file-level default would mean someone else's `apply -y` silently ships
      // credential values — the same shape of accident this ticket is about.
      // Everything the gate refuses stays a `needs-secret` reminder, so nothing
      // is ever silently skipped.
      if (ctx.secretsBundles && ctx.secretsBundles.length > 0) {
        for (const bundle of ctx.secretsBundles) {
          const decision = decideSecretPush(bundle, d, probe, ctx);
          if (decision.push) {
            rowActions.push({
              device: d.device,
              kind: 'push-secret',
              bundle,
              detail: `push secrets bundle '${bundle}' (${decision.backend} backend)`,
            });
          } else {
            secretsNeeded.push(bundle);
            rowActions.push({ device: d.device, kind: 'needs-secret', bundle, detail: decision.reason });
          }
        }
      }
    }

    devices.push({ device: d.device, desired: d, probe, actions: rowActions, loginBlocked, secretsNeeded });
    actions.push(...rowActions);
  }

  return { devices, actions };
}

/** Why a declared bundle is or is not pushed to one device. */
export interface SecretPushDecision {
  push: boolean;
  /** Where it would land on the remote. Only meaningful when `push`. */
  backend: RemoteBackend;
  /** Set when `push` is false — rendered as the `needs-secret` reminder. */
  reason: string;
}

/**
 * Decide whether `fleet apply` may push one declared bundle to one device.
 *
 * PURE — no ssh, no keychain, no filesystem beyond the injectable pin check — so
 * every branch is unit-testable with no live fleet. Three gates, in order, and
 * each REFUSAL still yields a `needs-secret` reminder rather than silence:
 *
 *   1. `--provision-secrets` must be set. Off by default, and deliberately a
 *      flag rather than an `agents.yaml` field: the manifest is shared, so a
 *      file-level default means someone else's `apply -y` ships credential
 *      values without deciding to (RUSH-1968's shape of accident).
 *   2. The device must be reachable — nothing to push to otherwise.
 *   3. The host key must be PINNED. This moves credential values to another
 *      machine, so it reuses the same bar `agents exec --copy-creds` already
 *      sets (EXEC-34): an unpinned device earns its pin through a normal
 *      `agents ssh <device>` first.
 *
 * Backend follows the platform, and this is the load-bearing default of the
 * whole feature: **file on Linux, keychain on macOS/Windows**. A headless Linux
 * box has no keychain (`lib/secrets/linux.ts`), and the file store there
 * auto-provisions its OWN machine-local key — so each box ends up with an
 * unshared at-rest key and NO passphrase is forwarded. That is the direct
 * alternative to the fleet-wide shared secret this ticket exists to remove.
 *
 * The reserved `auth` bundle is the exception: it is always file-backed
 * (SEC-GAP-3) and is pushed even without `--provision-secrets`, because it is
 * the one fleet-shared setup-token store (PHNX-2371).
 */
export function decideSecretPush(
  bundle: string,
  desired: DeviceDesired,
  probe: DeviceProbe,
  ctx: DiffContext,
): SecretPushDecision {
  const device = desired.device;
  const reserved = isReservedBundleName(bundle);
  const backend: RemoteBackend = reserved || probe.platform === 'linux' ? 'file' : 'keychain';
  const manual = `recreate secrets bundle '${bundle}' (\`agents ssh ${device} -- secrets create ${bundle}\`)`;

  if (!ctx.provisionSecrets && !reserved) {
    return { push: false, backend, reason: `${manual} — or re-run with --provision-secrets to push it` };
  }
  if (!probe.reachable) {
    return { push: false, backend, reason: manual };
  }
  // Already there? Skip — otherwise every `apply` re-resolves the bundle, and a
  // resolve can prompt for Touch ID, so a converged fleet would nag on every run.
  //
  // Known limitation, stated rather than hidden: this compares PRESENCE (and
  // carries `updated_at` for a future content check). It is a timestamp
  // heuristic, not a content hash — a bundle whose VALUES changed locally still
  // reads as present. `--force` is the way to overwrite regardless.
  // hasOwnProperty, NOT `in`: `in` walks the prototype chain, so a bundle named
  // `toString` / `constructor` / `valueOf` would read as present on an EMPTY map
  // and be silently skipped — leaving that device unprovisioned, the worse of the
  // two errors this gate can make.
  if (!ctx.forceSecrets && probe.remoteBundles
      && Object.prototype.hasOwnProperty.call(probe.remoteBundles, bundle)) {
    return { push: false, backend, reason: `secrets bundle '${bundle}' already present on ${device} — pass --force to overwrite` };
  }

  if (!ctx.isHostPinned?.(device)) {
    // Same bar as `exec --copy-creds`: never ship credential values to a host
    // whose key we have not pinned.
    return {
      push: false,
      backend,
      reason: `${manual} — host key not pinned; run \`agents ssh ${device}\` once to pin it, then re-apply`,
    };
  }
  return { push: true, backend, reason: '' };
}

// ---- execution (real SSH; verified end-to-end, not unit-mocked) ----

function osHint(platform: string | undefined): string | undefined {
  return platform === 'windows' ? 'windows' : undefined;
}

/** POSIX login shells often miss the shims dir; inject it (mirrors doctor). */
function remoteEnv(platform: string | undefined): Record<string, string> | undefined {
  return platform === 'windows' ? undefined : { PATH: '$HOME/.agents/.cache/shims:$HOME/.local/bin:$PATH' };
}

export interface ProbeOptions {
  /** Also fetch per-agent installed versions (one extra `agents view --json`
   * round-trip). Enable only when the plan has a version-pinned spec. */
  withVersions?: boolean;
  /** Also fetch which secrets bundles the device already has (one extra
   *  `agents secrets list --json`). Enable only when the manifest declares
   *  bundles and provisioning is on — same cost discipline as `withVersions`. */
  withSecrets?: boolean;
}

/** Probe one device: reachability + agents-cli version + installed agent ids
 * (and, when `withVersions`, the installed version strings per agent). */
export function probeDevice(device: DeviceProfile, opts?: ProbeOptions): DeviceProbe {
  let target: string;
  try {
    target = sshTargetFor(device);
  } catch (e) {
    return { device: device.name, reachable: false, platform: device.platform, installedAgents: [], note: (e as Error).message };
  }
  const hint = osHint(device.platform);
  const extraSshArgs = deviceIdentityArgs(device);
  const ready = readyProbe(target, hint, extraSshArgs);
  if (!ready.reachable) {
    return { device: device.name, reachable: false, platform: device.platform, installedAgents: [], note: 'unreachable' };
  }
  let installed: string[] = [];
  const remoteCmd = buildRemoteAgentsInvocation(['teams', 'doctor', '--json'], undefined, hint, remoteEnv(device.platform));
  const res = sshExec(target, remoteCmd, { timeoutMs: 30000, multiplex: true, extraSshArgs });
  if (res.code === 0) {
    try {
      const map = JSON.parse(res.stdout) as Record<string, TeamsDoctorEntry>;
      installed = Object.entries(map).filter(([, e]) => e?.installed).map(([k]) => k);
    } catch {
      /* agents-cli present but doctor output unparsable — treat as no agents */
    }
  }
  let installedVersions: Record<string, string[]> | undefined;
  if (opts?.withVersions) {
    const viewCmd = buildRemoteAgentsInvocation(['view', '--json'], undefined, hint, remoteEnv(device.platform));
    const vres = sshExec(target, viewCmd, { timeoutMs: 30000, multiplex: true, extraSshArgs });
    if (vres.code === 0) installedVersions = parseInstalledVersions(vres.stdout);
  }
  let remoteBundles: Record<string, string> | undefined;
  if (opts?.withSecrets) {
    // Metadata only — `secrets list --json` returns names + timestamps and never
    // values, which is why this is safe to run across the fleet.
    const listCmd = buildRemoteAgentsInvocation(['secrets', 'list', '--json'], undefined, hint, remoteEnv(device.platform));
    const lres = sshExec(target, listCmd, { timeoutMs: 30000, multiplex: true, extraSshArgs });
    if (lres.code === 0) remoteBundles = parseRemoteBundles(lres.stdout);
  }
  return {
    device: device.name,
    reachable: true,
    platform: device.platform,
    cliVersion: ready.version ?? undefined,
    installedAgents: installed,
    installedVersions,
    remoteBundles,
  };
}

/**
 * Narrow a remote `secrets list --json` payload to `name -> updated_at`.
 *
 * Exported and pure so the parse is unit-tested against real payload shapes with
 * no live fleet. Returns `{}` rather than throwing on anything unexpected: the
 * remote runs its own agents-cli version, and a parse failure must degrade to
 * "unknown, so push" — never to "present, so skip", which would silently leave a
 * device unprovisioned.
 */
export function parseRemoteBundles(stdout: string): Record<string, string> {
  try {
    const parsed = JSON.parse(stdout) as unknown;
    const rows = Array.isArray(parsed)
      ? parsed
      : Array.isArray((parsed as { bundles?: unknown })?.bundles)
        ? (parsed as { bundles: unknown[] }).bundles
        : [];
    // Null-prototype: a remote-supplied name is used as a KEY here, so `{}` would
    // let `__proto__` hit the prototype setter instead of becoming an own
    // property (and then read back as absent). It also means the presence check
    // cannot see inherited names.
    const out: Record<string, string> = Object.create(null);
    for (const row of rows) {
      if (!row || typeof row !== 'object') continue;
      const r = row as Record<string, unknown>;
      const name = typeof r.name === 'string' ? r.name : undefined;
      if (!name) continue;
      // `updatedAt` is the real field name in `secrets list --json` — verified
      // against a live payload, not assumed. `updated_at` is accepted too so an
      // older remote is not silently recorded with an empty timestamp.
      const ts = typeof r.updatedAt === 'string' ? r.updatedAt
        : typeof r.updated_at === 'string' ? r.updated_at
          : '';
      out[name] = ts;
    }
    return out;
  } catch {
    return {};
  }
}

export interface ApplyStep {
  kind: FleetAction['kind'];
  ok: boolean;
  detail: string;
}

export interface DeviceApplyResult {
  device: string;
  ok: boolean;
  steps: ApplyStep[];
  note?: string;
}

export interface ExecContext {
  targetCliVersion: string;
  source: string;
  sourceAuth: SourceAuth;
  /** Set for a dry run — probe + plan only, execute nothing. */
  dryRun?: boolean;
}

/** Execute one device's planned actions in order. Real SSH — no mocks. */
export async function reconcileDevice(row: DeviceDiff, device: DeviceProfile, ctx: ExecContext): Promise<DeviceApplyResult> {
  if (!row.probe.reachable) {
    return { device: row.device, ok: false, steps: [], note: row.probe.note ?? 'unreachable' };
  }
  const steps: ApplyStep[] = [];
  let target: string;
  try {
    target = sshTargetFor(device);
  } catch (e) {
    return { device: row.device, ok: false, steps: [], note: (e as Error).message };
  }
  const hint = osHint(device.platform);
  const env = remoteEnv(device.platform);
  const extraSshArgs = deviceIdentityArgs(device);
  let ok = true;

  const sshAgents = (args: string[], input?: string) =>
    sshExec(target, buildRemoteAgentsInvocation(args, undefined, hint, env), { timeoutMs: 300000, multiplex: true, input, extraSshArgs });

  // 1. agents-cli install/upgrade.
  const cliAction = row.actions.find((a) => a.kind === 'install-cli' || a.kind === 'upgrade-cli');
  if (cliAction) {
    const r = bootstrapAgentsCli(target, ctx.targetCliVersion, hint, extraSshArgs);
    steps.push({ kind: cliAction.kind, ok: r.ok, detail: cliAction.detail });
    ok = ok && r.ok;
  }

  // 2. agents. Every add-agent action carries the full spec (set in diffFleet);
  // install it directly rather than re-parsing the human-readable detail string.
  for (const a of row.actions.filter((x) => x.kind === 'add-agent')) {
    const spec = a.spec!;
    const r = sshAgents(['add', spec, '--yes']);
    steps.push({ kind: 'add-agent', ok: r.code === 0, detail: a.detail });
    ok = ok && r.code === 0;
  }

  // 3. config sync — one `agents sync <scope>` per declared scope. Each scope is
  // a positional repo target (system/user/project/alias); a bare `agents sync`
  // would ignore the profile's declared scopes entirely.
  if (row.actions.some((a) => a.kind === 'sync-config')) {
    const scopes = row.desired.sync.length > 0 ? row.desired.sync : [''];
    let syncOk = true;
    for (const scope of scopes) {
      const r = sshAgents(scope ? ['sync', scope] : ['sync']);
      syncOk = syncOk && r.code === 0;
    }
    steps.push({ kind: 'sync-config', ok: syncOk, detail: `sync config (${row.desired.sync.join(', ') || 'default'})` });
    ok = ok && syncOk;
  }

  // 4. Native login materialization does not exist. Every agent that needs a login is surfaced as
  // `needs-login` (per-box login / portable-account guidance) in the diff above.

  // 5. secrets provisioning — LAST, and deliberately so. It is the most
  // sensitive mutation apply performs (credential VALUES crossing to another
  // machine), so every lower-risk step above is already recorded before we
  // touch it: a failure here never obscures what did land.
  //
  // Resolve ONCE per device even for several bundles is not possible (a resolve
  // is per bundle), but each bundle resolves once and pushes once — the read can
  // prompt, so it must not repeat.
  const pushSecrets = row.actions.filter((a) => a.kind === 'push-secret');
  for (const action of pushSecrets) {
    const bundle = action.bundle;
    if (!bundle) {
      // A push-secret action without a bundle name is a planner bug, not a
      // recoverable state — fail loud rather than push nothing and report ok.
      steps.push({ kind: 'push-secret', ok: false, detail: 'push-secret action carried no bundle name' });
      ok = false;
      continue;
    }
    const backend: RemoteBackend = isReservedBundleName(bundle) || device.platform === 'linux' ? 'file' : 'keychain';
    try {
      const out = await pushBundleToHost(bundle, target, {
        remoteBackend: backend,
        operation: `fleet apply ${row.device}`,
        // No passphrase, ever, from this path. On the file backend the remote
        // auto-provisions its OWN machine-local key, which is the entire point:
        // each box gets an unshared at-rest key instead of the fleet-wide shared
        // secret RUSH-1968 is about.
      });
      steps.push({
        kind: 'push-secret',
        ok: out.ok,
        detail: out.ok
          ? `secrets '${bundle}' -> ${row.device} (${backend}): ${out.message}`
          : `secrets '${bundle}' -> ${row.device}: ${out.message}`,
      });
      ok = ok && out.ok;
    } catch (e) {
      // A local resolve failure (locked store, missing bundle, multi-line value)
      // is reported per bundle rather than aborting the whole device.
      steps.push({ kind: 'push-secret', ok: false, detail: `secrets '${bundle}': ${(e as Error).message}` });
      ok = false;
    }
  }

  // Surface blocked logins as (non-fatal) informational steps.
  for (const blocked of row.loginBlocked) {
    steps.push({ kind: 'needs-login', ok: false, detail: `${blocked} needs a manual login (\`agents ssh ${row.device} -- ${blocked}\`)` });
  }
  // Surface declared secrets bundles as (non-fatal) manual-recreate reminders —
  // values are keychain-local, never captured or pushed.
  for (const bundle of row.secretsNeeded) {
    steps.push({ kind: 'needs-secret', ok: false, detail: `secrets bundle '${bundle}' must exist on ${row.device} (\`agents ssh ${row.device} -- secrets create ${bundle}\`)` });
  }

  return { device: row.device, ok, steps };
}

/** Run a pool of async tasks with a concurrency cap, preserving input order. */
export async function pool<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return results;
}

/** Reconcile every device row in parallel (capped). */
export async function runFleetApply(
  rows: DeviceDiff[],
  nameToProfile: Map<string, DeviceProfile>,
  ctx: ExecContext,
  concurrency = 6,
): Promise<DeviceApplyResult[]> {
  return pool(rows, concurrency, async (row) => {
    const profile = nameToProfile.get(row.device);
    if (!profile) return { device: row.device, ok: false, steps: [], note: 'no device profile' };
    return reconcileDevice(row, profile, ctx);
  });
}

/** Default home for source snapshots (overridable in tests). */
export function sourceHome(): string {
  return os.homedir();
}
