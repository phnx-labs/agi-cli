/**
 * `agents doctor` — diagnostic readout across the install.
 *
 * Two modes:
 *
 *   1. Overview (no target): three sections —
 *      - CLI availability (which agent binaries can be invoked).
 *      - Sync status per default version (fresh / stale / never-synced).
 *      - Orphans per default version per resource type.
 *
 *   2. Target mode: `agents doctor <agent>[@version]` — full per-resource
 *      diff for a single (agent, version) against the current cwd's resolved
 *      sources. Reports ok / DIFF / MISS / EXTRA per resource with the source
 *      layer (project, user, system, extra repo). With `--diff`, renders a
 *      unified diff body for each divergent file. Mirrors the resolution that
 *      the shim drives at runtime: project > user > system > extras.
 *
 * Read-only always: doctor diagnoses, it never mutates. To fix the gaps it
 * finds — install missing resources, repair Claude-invalid plugin manifests,
 * refresh stale plugins, reconcile drift, repair hook runtime shims — run
 * `agents sync <agent>@all` (the one fixer, a superset of the old `doctor
 * --fix`). Run `agents prune cleanup` to act on orphan readouts. `--fix` is a
 * deprecated no-op that now errors with a pointer to `agents sync`.
 */
import type { Command } from 'commander';
import { IsolationBoundaryError } from '../lib/installations/shims.js';
import { explainIsolationBoundary } from '../lib/isolation-boundary-report.js';
import { addHostOption } from '../lib/hosts/option.js';
import { buildRemoteAgentsInvocation } from '../lib/hosts/remote-cmd.js';
import { loadDevices } from '../lib/devices/registry.js';
import { fanOutDevices, planFleetTargets, remoteFleetTargets, type FanOutDeviceTarget } from '../lib/devices/fleet.js';
import { enterDoctorOverviewGate, writeDoctorOverviewCache } from '../lib/devices/doctor-overview-cache.js';
import { fleetDialTarget } from '../lib/devices/connect.js';
import { compareFleetInventories, FLEET_HOOK_RUNTIME_STATES, type FleetInventory, type FleetVersionSignIn } from '../lib/devices/fleet-divergence.js';
import { collectLocalFleetInventory } from '../lib/devices/fleet-inventory.js';
import {
  buildLocalFindings,
  fleetDivergenceToFindings,
  hookRuntimeToFindings,
  signInToFindings,
  renderFindings,
  remediationFor,
  FINDING_SEVERITY,
  type DoctorFinding,
  type LocalFindingInputs,
} from '../lib/devices/doctor-findings.js';
import { getCliVersion } from '../lib/version.js';
import { resolveHost } from '../lib/hosts/registry.js';
import { sshExecAsync } from '../lib/ssh-exec.js';
import { hostIdentityArgs, sshTargetFor } from '../lib/hosts/types.js';
import { deviceIdentityArgs } from '../lib/devices/connect.js';
import { machineId, normalizeHost } from '../lib/session/sync/config.js';
import { findAmbiguousDevicePins } from '../lib/scheduling/routines.js';
import chalk from 'chalk';
import { checkAllClis, collectTeamsDoctorData, type TeamsDoctorEntry } from '../lib/teams/agents.js';
import { AGENTS, ALL_AGENT_IDS, resolveAgentName, formatAgentError, getAccountInfo, type AccountInfo } from '../lib/agents.js';
import type { AgentId } from '../lib/types.js';
import {
  getVersionHomePath,
  listInstalledVersions,
} from '../lib/installations/versions.js';
import { resolveAgentTargets, AgentSpecError } from '../lib/agent-spec/index.js';
import { loadManifest, isStale } from '../lib/staleness/index.js';
import {
  diffVersionResources,
  DOCTOR_ALL_KINDS,
  type DoctorKind,
  type ResourceDiff,
  type VersionResourceReport,
} from '../lib/doctor-diff.js';
import { inspectDuplicateVersionHooks, type DuplicateVersionHook, type HookWiringReport } from '../lib/hooks/install.js';
import { inspectReservedAuthBundle } from '../lib/secrets-policy.js';
import { isVersionIsolated } from '../lib/installations/versions.js';
import { computeDrift, checkSyncStatus, countOrphans, computeSourceBehind, type SyncStatusRow, type OrphanRow } from '../lib/drift.js';
import { readAuthHealthCache, summarizeHostAuth } from '../lib/auth-health.js';
import { readMeta } from '../lib/state.js';
import { probeOwnerSink } from '../lib/channels/owner-sink.js';
import { unifiedDiff, colorizeUnifiedDiff } from '../lib/diff-text.js';
import { listCliStatus, listCliStatusAsync } from '../lib/cli-resources.js';
import { setHelpSections } from '../lib/help.js';
import { getEffectiveExecutionPolicy } from '../lib/platform/winpath.js';
import { auditWindowsSshEnrollment, diagnoseWindowsSshFailure } from '../lib/devices/windows-ssh-enrollment.js';
import {
  scanUserRcFilesSync,
  masterPassphraseInEnvSync,
  isSecretsTransportError,
} from '../lib/secrets-client.js';
import { terminalWidth, truncateToWidth, stringWidth, padToWidth } from '../lib/session/width.js';
import { readRepoBehindMarkers, type FetchStatusMarker } from '../lib/auto-pull.js';
import { detectAgentsBinaryShadows } from '../lib/binary-shadow.js';
import * as fs from 'fs';
import * as path from 'path';

const AGENT_NAMES: Record<string, string> = Object.fromEntries(
  ALL_AGENT_IDS.map((id) => [id, AGENTS[id].name]),
);

interface DoctorOptions {
  /** Bypass the cached bare-`--json` overview snapshot and recompute live (also refreshes the shared cache). */
  refresh?: boolean;
  json?: boolean;
  diff?: boolean;
  kind?: string;
  cwd?: string;
  fix?: boolean;
  adopt?: string;
  release?: string;
  device?: string;
  devices?: boolean;
  check?: boolean;
  quiet?: boolean;
}

// ─── overview mode (no target) ────────────────────────────────────────────────

// doctor is the umbrella diagnostic and must never crash on one subsystem
// (§Diagnostic command taxonomy). The standalone secrets CLI being absent from
// PATH is a routine, expected state on a box that hasn't installed it — not a
// reason to abort the whole report — so these two checks degrade to "nothing to
// report" on a transport error and let every other finding still print. A data
// error the standalone actually answered with must still surface.
function scanUserRcFiles(): ReturnType<typeof scanUserRcFilesSync> {
  try {
    return scanUserRcFilesSync();
  } catch (error) {
    if (isSecretsTransportError(error)) return [];
    throw error;
  }
}

function masterPassphraseInEnv(): boolean {
  try {
    return masterPassphraseInEnvSync();
  } catch (error) {
    if (isSecretsTransportError(error)) return false;
    throw error;
  }
}

function collapseWhitespace(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

export function wrapLine(prefix: string, text: string, width = terminalWidth()): string[] {
  const words = collapseWhitespace(text).split(' ').filter(Boolean);
  if (words.length === 0) return [prefix.trimEnd()];
  const continuation = ' '.repeat(stringWidth(prefix));
  const lines: string[] = [];
  let linePrefix = prefix;
  let line = prefix;
  let hasWord = false;
  for (const word of words) {
    const room = Math.max(1, width - stringWidth(linePrefix));
    const piece = stringWidth(word) > room ? truncateToWidth(word, room) : word;
    const candidate = hasWord ? `${line} ${piece}` : `${line}${piece}`;
    if (hasWord && stringWidth(candidate) > width) {
      lines.push(line);
      linePrefix = continuation;
      line = continuation + piece;
      hasWord = true;
    } else {
      line = candidate;
      hasWord = true;
    }
  }
  lines.push(line);
  return lines;
}

/** Reshape  into the pure finding-builder's input: install state
 *  per declared CLI, plus the manifests the loader rejected (a bad manifest
 *  declares a CLI that can never install, so it is a finding, not silence). */
function toHostCliInput(
  status: ReturnType<typeof listCliStatus>,
): NonNullable<LocalFindingInputs['hostClis']> {
  return {
    statuses: status.statuses.map((c) => ({ name: c.manifest.name, installed: c.installed })),
    errors: status.errors.map((e) => ({ file: e.file, reason: e.reason })),
  };
}

function printWrappedLine(prefix: string, text: string): void {
  for (const line of wrapLine(prefix, text)) console.log(chalk.gray(line));
}

// ─── repo-behind advisory ─────────────────────────────────────────────────────

/**
 * Render repo-behind notices from background fetch markers as a "Repo updates"
 * section in `agents doctor`. Reads without consuming the markers so repeated
 * invocations keep showing the notice until the user runs `agents repo pull`.
 */

// ─── devices / fleet mode ─────────────────────────────────────────────────────

interface DeviceDoctorResult {
  name: string;
  online: boolean;
  error?: string;
  agents: Record<string, TeamsDoctorEntry>;
  /** This device's self-reported harness inventory (resources / agent versions /
   *  repo state) from its top-level `agents doctor --json`, for cross-device
   *  divergence detection (RUSH-2027). Undefined when the inventory probe failed
   *  or the remote is an older CLI that doesn't emit the `fleet` field. */
  inventory?: FleetInventory;
  /** Secret-hygiene findings the remote reported about ITSELF. The aggregator
   *  can recompute a remote's sign-in and divergence findings from its
   *  inventory, but it cannot see that box's shell rc files or process
   *  environment — only the remote's own doctor can, so those two ride back
   *  here or they are lost (RUSH-1968). */
  secretFindings?: DoctorFinding[];
}

/** What one remote `doctor --json` contributes: its inventory (for the
 *  divergence comparator) plus the findings only it can observe. */
interface RemoteDoctorPayload {
  inventory: FleetInventory | null;
  secretFindings: DoctorFinding[];
}

/**
 * Narrow a remote `findings` array to rows only that device can observe.
 *
 * Deliberately NOT "forward every remote finding". The aggregator already
 * rebuilds a remote's sign-in rows from its inventory and its divergence rows
 * from the comparator, so forwarding wholesale would double them; and pulling a
 * remote's orphan/drift rows into a fleet readout is a much larger UX change
 * than this fix. These kinds are unrecomputable centrally: shell/process secret
 * hygiene and the Windows host's effective OpenSSH key path/content/ACL.
 *
 * **The remote contributes exactly one thing: the KIND.** Severity, message and
 * remediation are all generated HERE. That is not defensiveness for its own
 * sake — the remote runs its own agents-cli, whose version and integrity we do
 * not control, and each forwarded string is load-bearing in a different way:
 *
 *   - `remediation` is a command a human copies and runs. Accepting it from the
 *     wire is an injection channel, full stop.
 *   - `message` is the one place a secret VALUE could re-enter a readout that
 *     otherwise guarantees it never prints one. A local builder cannot leak what
 *     it never receives.
 *   - `severity` decides the CRITICAL section, so a remote could otherwise
 *     promote its own warning and bury real criticals under it.
 *   - `device` is overwritten with the name we dialled, so no box can pin a
 *     finding on another.
 *
 * The cost is detail: the fleet row says which box and which kind, not which
 * file and line. Run `agents doctor` on that box for the specifics — the
 * message says so.
 */
const REMOTE_FORWARDED_KINDS = ['rc-secret-export', 'env-secret-export', 'auth-bundle-wrong-backend', 'ssh-key-enrollment'] as const;
type RemoteForwardedKind = typeof REMOTE_FORWARDED_KINDS[number];

/** Canonical, locally-authored text for a forwarded kind. Never the remote's. */
const REMOTE_SECRET_MESSAGE: Record<RemoteForwardedKind, string> = {
  'rc-secret-export': 'a credential-shaped export was found in this box\'s shell rc files'
    + ' — run `agents doctor` there for the file and line',
  'env-secret-export': 'AGENTS_SECRETS_PASSPHRASE is set in this box\'s process environment'
    + ' — run `agents doctor` there for detail',
  'auth-bundle-wrong-backend': "reserved secrets bundle 'auth' exists but is not file-backed"
    + ' — run `agents doctor` there to recreate it',
  'ssh-key-enrollment': 'Windows OpenSSH key enrollment is invalid'
    + ' — run `agents doctor` on this box for the effective path or ACL failure',
};

export function asRemoteSecretFindings(raw: unknown, device: string): DoctorFinding[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: DoctorFinding[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const kind = (item as Record<string, unknown>).kind;
    if (typeof kind !== 'string') continue;
    if (!(REMOTE_FORWARDED_KINDS as readonly string[]).includes(kind)) continue;
    if (seen.has(kind)) continue;   // one row per kind per box
    seen.add(kind);
    const k = kind as RemoteForwardedKind;
    const base = {
      severity: FINDING_SEVERITY[k],
      kind: k as DoctorFinding['kind'],
      device,
      message: REMOTE_SECRET_MESSAGE[k],
    };
    out.push({ ...base, remediation: remediationFor({ ...base, remediation: '' }) });
  }
  return out;
}

interface FleetTarget {
  name: string;
  sshTarget: string;
  os?: string;
  extraSshArgs?: string[];
}

async function resolveFleetTargets(opts: DoctorOptions): Promise<FleetTarget[]> {
  const singleName = opts.device;
  if (singleName) {
    // --device as a single-device filter: resolve through the device
    // registry first, then the general host registry, then ad-hoc user@host.
    const registry = await loadDevices();
    const deviceProfile = registry[singleName];
    if (deviceProfile) {
      return [{
        name: deviceProfile.name,
        sshTarget: deviceProfile.name,
        os: deviceProfile.platform !== 'unknown' ? deviceProfile.platform : undefined,
        extraSshArgs: deviceIdentityArgs(deviceProfile),
      }];
    }
    const host = await resolveHost(singleName);
    if (host) {
      return [{ name: singleName, sshTarget: sshTargetFor(host), os: host.os, extraSshArgs: hostIdentityArgs(host) }];
    }
    console.error(chalk.red(`Unknown host or device '${singleName}'.`));
    process.exit(1);
  }

  const registry = await loadDevices();
  const localName = machineId();
  return Object.values(registry)
    // Normalize names so zion/ZION/zion.local all match machineId() and we never
    // self-SSH the local box during fleet probes (RUSH-2114).
    .filter((d) => normalizeHost(d.name) !== localName)
    .map((d) => ({
      name: d.name,
      sshTarget: d.name,
      os: d.platform !== 'unknown' ? d.platform : undefined,
      extraSshArgs: deviceIdentityArgs(d),
    }));
}

async function probeFleetTarget(target: FleetTarget): Promise<DeviceDoctorResult> {
  const forwarded = ['teams', 'doctor', '--json'];
  const isWin = /^win/i.test((target.os ?? '').trim());
  const remoteCmd = buildRemoteAgentsInvocation(
    forwarded,
    undefined,
    isWin ? 'windows' : undefined,
    // POSIX login shells often lack the shims dir; Windows PowerShell usually
    // has it via the install profile, and our single-quote escaping would
    // prevent $HOME expansion there, so skip the bootstrap on Windows.
    isWin ? undefined : { PATH: '$HOME/.agents/.cache/shims:$HOME/.local/bin:$PATH' },
  );
  const res = await sshExecAsync(target.sshTarget, remoteCmd, { timeoutMs: 30000, multiplex: true, extraSshArgs: target.extraSshArgs });
  if (res.code !== 0) {
    return {
      name: target.name,
      online: false,
      error: isWin
        ? diagnoseWindowsSshFailure(res.stderr, res.timedOut)
        : res.timedOut ? 'timed out' : (res.stderr || `exit ${res.code ?? 'unknown'}`),
      agents: {},
    };
  }
  try {
    const agents = JSON.parse(res.stdout) as Record<string, TeamsDoctorEntry>;
    return { name: target.name, online: true, agents };
  } catch (err: any) {
    const stderrHint = res.stderr ? ` stderr: ${res.stderr.trim()}` : '';
    return {
      name: target.name,
      online: true,
      error: `invalid JSON (${err?.message ?? 'parse error'})${stderrHint}`,
      agents: {},
    };
  }
}

/**
 * Fetch a device's harness inventory by running its top-level `agents doctor
 * --json` (which carries the `fleet` field, RUSH-2027). Separate from
 * {@link probeFleetTarget} — that forwards `teams doctor --json` for per-agent
 * readiness, a different payload. Returns the parsed {@link FleetInventory} or
 * null (unreachable, non-zero exit, unparseable, or an older CLI with no
 * `fleet` field); a null is skipped by the comparator, never a false gap.
 */
/**
 * How long one remote `doctor --json` probe may take.
 *
 * 180s, matching `ChildProcess.doctorTimeout`, which was set to 180 for this
 * same command for this same reason. The previous 30s sat BELOW the command's
 * real cost — 56s measured on `yosemite-m0`, 136s on an idle box — so every slow
 * device silently contributed nothing at all: no inventory, no sign-in, no
 * divergence, no secret findings. A ceiling under the true cost does not make a
 * probe cheap, it makes it always fail.
 *
 * This does not multiply by device count: `fanOutDevices` is `Promise.all`, so
 * whole-fleet wall time is bounded near the slowest box, not 180s x N.
 */
export const FLEET_INVENTORY_TIMEOUT_MS = 180_000;

async function probeFleetInventory(target: FleetTarget): Promise<RemoteDoctorPayload | null> {
  const isWin = /^win/i.test((target.os ?? '').trim());
  const remoteCmd = buildRemoteAgentsInvocation(
    ['doctor', '--json'],
    undefined,
    isWin ? 'windows' : undefined,
    isWin ? undefined : { PATH: '$HOME/.agents/.cache/shims:$HOME/.local/bin:$PATH' },
  );
  const res = await sshExecAsync(target.sshTarget, remoteCmd, {
    timeoutMs: FLEET_INVENTORY_TIMEOUT_MS,
    multiplex: true,
    extraSshArgs: target.extraSshArgs,
  });
  if (res.code !== 0) return null;
  try {
    const parsed = JSON.parse(res.stdout) as { fleet?: unknown; findings?: unknown };
    return {
      inventory: asFleetInventory(parsed.fleet),
      secretFindings: asRemoteSecretFindings(parsed.findings, target.name),
    };
  } catch {
    return null;
  }
}

/**
 * Narrow a remote `doctor --json` `.fleet` payload to a usable inventory, or null.
 *
 * The remote runs ITS OWN agents-cli, whose version we do not control, so the
 * payload is untrusted input rather than a typed value — a cast alone let a
 * partial object (`{"fleet":{}}` from a skewed or truncated remote) reach
 * `compareFleetInventories`, which indexes `inv.resources[kind]` and
 * `Object.keys(inv.agentVersions)` unconditionally and throws. Returning null
 * routes that device into the existing "older agents-cli / no inventory" path,
 * which is honest and already rendered, instead of aborting the whole fan-out.
 *
 * This validates EVERY field of {@link FleetInventory} that anything downstream
 * reads — `resources`, `agentVersions`, `repos` and each optional `signIn` row.
 * It was tightened four times during review, each round finding the next
 * unvalidated layer, so treat partial validation here as a bug: a field added to
 * the inventory must be checked here in the same change.
 */
export function asFleetInventory(value: unknown): FleetInventory | null {
  // `typeof [] === 'object'`, so a shallow object check is not enough: an array
  // passes it, every `inv.resources[kind] ?? []` then yields empty, and the
  // comparison reports EVERY baseline resource as missing on that device — a
  // screenful of false findings, worse than the crash this guard replaced.
  const isMap = (x: unknown): x is Record<string, unknown> =>
    !!x && typeof x === 'object' && !Array.isArray(x);
  const isStringArray = (x: unknown): x is string[] =>
    Array.isArray(x) && x.every((e) => typeof e === 'string');

  if (!isMap(value)) return null;
  const v = value as Record<string, unknown>;
  if (!isMap(v.resources) || !Object.values(v.resources).every(isStringArray)) return null;
  if (!isMap(v.agentVersions) || !Object.values(v.agentVersions).every(isStringArray)) return null;
  // `repos.agents` / `repos.system` must each be a RepoState or null. Checking
  // only that `repos` is a record let `{agents: [], system: []}` through: `[]` is
  // truthy, so `describeRepoDrift` read `.head`/`.branch`/`.dirty` off an array,
  // got undefined for each, and could emit a bogus repo-drift row.
  const isRepoState = (x: unknown): boolean =>
    x === null
    || (isMap(x)
      && (x.branch === null || typeof x.branch === 'string')
      && (x.head === null || typeof x.head === 'string')
      && typeof x.dirty === 'boolean');
  if (!isMap(v.repos) || !Object.values(v.repos).every(isRepoState)) return null;
  // `signIn` is optional (older remotes omit it) but every FIELD must be
  // well-formed if sent — not just `version`. `provable` and `signedIn` are read
  // as booleans to decide a CRITICAL vs a hedged warning, so a remote sending
  // `provable: "yes"` would print a logged-out critical for a signed-in version,
  // and a non-string `account` would render straight into the accounts line.
  if (v.signIn !== undefined) {
    if (!isMap(v.signIn)) return null;
    const isSignInRow = (r: unknown): boolean =>
      isMap(r)
      && typeof r.version === 'string'
      && typeof r.signedIn === 'boolean'
      && typeof r.provable === 'boolean'
      && (r.account === null || typeof r.account === 'string');
    const rowsOk = Object.values(v.signIn).every(
      (rows) => Array.isArray(rows) && rows.every(isSignInRow),
    );
    if (!rowsOk) return null;
  }

  // Hook-runtime state is optional for wire compatibility with older remotes,
  // but a present field is a closed enum map keyed exactly by the installed
  // agent/version pairs. The fleet never accepts a remote path or diagnostic
  // string, so an untrusted box cannot inject shell paths/text into this doctor.
  if (v.hookRuntime !== undefined) {
    if (!isMap(v.hookRuntime)) return null;
    const validStates = new Set<string>(FLEET_HOOK_RUNTIME_STATES);
    const agentVersions = v.agentVersions as Record<string, string[]>;
    const hookRuntime = v.hookRuntime as Record<string, Record<string, unknown>>;
    const expectedAgents = Object.keys(agentVersions);
    if (Object.keys(hookRuntime).length !== expectedAgents.length) return null;
    for (const agent of expectedAgents) {
      if (!ALL_AGENT_IDS.includes(agent as AgentId)) return null;
      const states = hookRuntime[agent];
      const versions = agentVersions[agent];
      if (!isMap(states) || Object.keys(states).length !== versions.length) return null;
      const expectedVersions = new Set(versions);
      for (const [version, state] of Object.entries(states)) {
        if (!expectedVersions.has(version) || typeof state !== 'string' || !validStates.has(state)) return null;
      }
    }
  }
  return v as unknown as FleetInventory;
}

async function runDevicesDoctor(opts: DoctorOptions): Promise<void> {
  const singleName = opts.device;
  const targets = await resolveFleetTargets(opts);
  const localName = machineId();
  const results: DeviceDoctorResult[] = [];

  // Local machine first, directly. Its inventory is collected in-process — no
  // SSH round-trip to this box.
  if (!singleName) {
    results.push({
      name: localName,
      online: true,
      agents: await collectTeamsDoctorData(),
      inventory: await collectLocalFleetInventory(opts.cwd ?? process.cwd()),
    });
  }

  // Remote targets in parallel: agent readiness (teams doctor) and the harness
  // inventory (top-level doctor --json) in one fan-out per concern. Both run
  // through the shared fleet helper so an offline box degrades to a skipped row.
  const [remoteResults, inventoryResults] = await Promise.all([
    fanOutDevices(targets, probeFleetTarget),
    fanOutDevices(targets, probeFleetInventory),
  ]);
  const payloadByName = new Map<string, RemoteDoctorPayload | null>();
  for (const r of inventoryResults) payloadByName.set(r.name, r.status === 'ok' ? (r.value ?? null) : null);
  results.push(...remoteResults.map((r): DeviceDoctorResult => {
    const payload = payloadByName.get(r.name) ?? null;
    const inventory = payload?.inventory ?? undefined;
    const secretFindings = payload?.secretFindings;
    if (r.status === 'ok' && r.value) return { ...r.value, inventory, secretFindings };
    return {
      name: r.name,
      online: false,
      error: r.error ?? String(r.reason ?? 'skipped'),
      agents: {},
      inventory,
      secretFindings,
    };
  }));

  // Cross-device divergence: compare every device's inventory against the local
  // baseline and flag resources / agent versions / repo state present on one box
  // but missing on another (RUSH-2027). A single-device filter has no baseline
  // to compare against, so the section is only meaningful for the full fan-out.
  const divergence = singleName
    ? null
    : compareFleetInventories(
        results.map((r) => ({ name: r.name, inventory: r.inventory ?? null })),
        localName,
      );

  if (opts.json && results.length === 0) {
    console.log(JSON.stringify({ devices: results, fleet: divergence, findings: [] }, null, 2));
    return;
  }

  if (results.length === 0) {
    console.log(chalk.gray('No registered devices. Run `agents devices` to register some.'));
    return;
  }

  // ── Hybrid fleet view (RUSH-2069): CRITICAL section across all boxes, then a
  // per-computer block for each. Findings come from:
  //   - LOCAL: per-version resource reports + sync/orphan/repo-behind + sign-in.
  //   - REMOTE: the box's self-reported inventory (per-version sign-in) folded to
  //     logged-out findings, plus cross-device divergence (version-skew, repo
  //     drift, missing resources). A remote on an older CLI with no `signIn` in
  //     its inventory emits the "older agents-cli — can't report per-version
  //     sign-in → upgrade" warning so the readout stays honest.
  const cwd = opts.cwd ?? process.cwd();
  const findings: DoctorFinding[] = [];
  const accounts: Record<string, Record<string, FleetVersionSignIn[]>> = {};

  for (const r of results) {
    if (r.name === localName) {
      // Local findings from the real reports (not just the inventory summary).
      const localReports: VersionResourceReport[] = [];
      for (const agent of ALL_AGENT_IDS) {
        for (const version of listInstalledVersions(agent)) {
          localReports.push(diffVersionResources(agent, version, { cwd, excludeProject: true }));
        }
      }
      const localCliMissing = ALL_AGENT_IDS.filter(
        (a) => listInstalledVersions(a).length > 0 && !checkAllClis()[a]?.installed,
      );
      findings.push(...buildLocalFindings({
        device: localName,
        syncRows: checkSyncStatus(cwd),
        orphanRows: countOrphans(),
        repoBehind: readRepoBehindMarkers(),
        reports: localReports,
        signIn: r.inventory?.signIn ?? {},
        cliMissing: localCliMissing,
        duplicateHooks: inspectDuplicateVersionHooks(cwd),
        hostClis: toHostCliInput(listCliStatus(cwd)),
        rcSecrets: scanUserRcFiles(),
        masterPassphraseInEnv: masterPassphraseInEnv(),
        authBundleWrongBackend: !inspectReservedAuthBundle().ok,
        execPolicy: process.platform === 'win32'
          ? { platform: process.platform, policy: getEffectiveExecutionPolicy() }
          : undefined,
        windowsSshEnrollment: auditWindowsSshEnrollment(),
        isolatedVersions: localReports
          .filter((rep) => isVersionIsolated(rep.agent, rep.version))
          .map((rep) => `${rep.agent}@${rep.version}`),
        // Can the owner-delivery lane escalate a block from THIS box? Local only —
        // remote boxes self-report it in their own `agents doctor --json`.
        ownerSink: await probeOwnerSink(readMeta()),
        binaryShadows: detectAgentsBinaryShadows(),
      }));
      accounts[localName] = r.inventory?.signIn ?? {};
      continue;
    }

    // Remote device.
    if (!r.online) {
      // An offline / unreachable box: surface it as a warning so it isn't
      // silently dropped from the per-computer section.
      findings.push({
        severity: 'warning', kind: 'stale-cli', device: r.name,
        message: r.error ? `unreachable — ${r.error}` : 'unreachable',
        remediation: 'check the device',
      });
      continue;
    }
    // Secret hygiene the aggregator cannot see for itself — the remote's shell
    // rc files and its process environment. Without this the fleet readout
    // reports a leaking box as clean (RUSH-1968).
    if (r.secretFindings?.length) findings.push(...r.secretFindings);

    // Unlike sign-in, the remote's hook-runtime payload is deliberately just a
    // closed enum state. Rebuild the finding locally so no remote file path or
    // detector text reaches this host's output.
    findings.push(...hookRuntimeToFindings(r.name, r.inventory?.hookRuntime));

    if (r.inventory?.signIn) {
      findings.push(...signInToFindings(r.name, r.inventory.signIn));
      accounts[r.name] = r.inventory.signIn;
    } else {
      // Reachable, but an older CLI that can't report per-version sign-in.
      findings.push({
        severity: 'warning', kind: 'stale-cli', device: r.name,
        message: "older agents-cli — can't report per-version sign-in",
        remediation: 'upgrade',
      });
      accounts[r.name] = {};
    }
  }

  // Cross-device divergence → version-skew / repo-drift / missing-resource
  // warnings, attributed to the lagging box.
  if (divergence) {
    findings.push(...fleetDivergenceToFindings(divergence.divergences, divergence.baseline));
  }

  // `--json` emits HERE, not before the findings are built: a consumer that reads
  // the JSON must see the same finding set the text renders — same membership,
  // same severities, so the CRITICAL `(N)` and each device's `✗ N critical`
  // reconcile. Emitting early left `--devices --json` with no `findings` at all
  // while the bare `--json` had one.
  if (opts.json) {
    console.log(JSON.stringify({ devices: results, fleet: divergence, findings }, null, 2));
    return;
  }

  const header = `${chalk.gray('agents doctor ·')} ${chalk.hex('#a3e635')(String(results.length))} ${chalk.gray('devices · baseline')} ${chalk.hex('#a3e635')(localName)}`;
  for (const line of renderFindings(findings, accounts, { fleet: true, baseline: localName, header })) {
    console.log(line);
  }
}

// ─── target mode ──────────────────────────────────────────────────────────────

interface ResolvedTarget {
  agent: AgentId;
  versions: string[];
  /** Did the user name a concrete VERSION (`codex@1.2.3`), or just the agent?
   *  The former is an explicit, isolated-copy-inclusive target for diagnosis. */
  versionExplicit: boolean;
}

function parseTargetArg(arg: string): ResolvedTarget | { error: string } {
  const at = arg.indexOf('@');
  const agentPart = at === -1 ? arg : arg.slice(0, at);
  const qualifier = at === -1 ? '' : arg.slice(at + 1);

  const agent = resolveAgentName(agentPart);
  if (!agent) return { error: formatAgentError(agentPart) };

  // No qualifier → diagnose every installed version of the agent.
  if (!qualifier) {
    const versions = listInstalledVersions(agent);
    if (versions.length === 0) return { error: `${AGENTS[agent].name} has no installed versions. Run \`agents add ${agent}@<version>\` first.` };
    return { agent, versions, versionExplicit: false };
  }

  // All explicit qualifiers (@all, @latest, @oldest, @default, @pinned, @x.y.z) → shared resolver
  try {
    const targets = resolveAgentTargets(`${agent}@${qualifier}`, { availableAgents: [agent] });
    const versions = targets.map((t) => t.version).filter((v): v is string => v !== null);
    if (versions.length === 0) return { error: `${AGENTS[agent].name} has no installed versions. Run \`agents add ${agent}@<version>\` first.` };
    return { agent, versions, versionExplicit: true };
  } catch (e) {
    if (e instanceof AgentSpecError) return { error: e.message };
    throw e;
  }
}

function parseKindFilter(arg: string | undefined): DoctorKind[] | { error: string } {
  if (!arg) return DOCTOR_ALL_KINDS as DoctorKind[];
  const requested = arg.split(',').map((s) => s.trim()).filter(Boolean);
  const valid = new Set<DoctorKind>(DOCTOR_ALL_KINDS);
  const out: DoctorKind[] = [];
  for (const k of requested) {
    if (!valid.has(k as DoctorKind)) {
      return { error: `Unknown kind: ${k}. Valid: ${DOCTOR_ALL_KINDS.join(', ')}` };
    }
    out.push(k as DoctorKind);
  }
  return out;
}

function statusLabel(status: ResourceDiff['status']): string {
  switch (status) {
    case 'ok': return chalk.green('ok   ');
    case 'diff': return chalk.yellow('DIFF ');
    case 'missing': return chalk.red('MISS ');
    case 'extra': return chalk.magenta('EXTRA');
  }
}

function sourceLabel(diff: ResourceDiff, layers: VersionResourceReport['layers']): string {
  if (!diff.source) return '';
  if (diff.source === 'extra') {
    // Find which extra repo this came from.
    const sourcePath = diff.sourcePath;
    if (sourcePath) {
      for (const e of layers.extras) {
        if (sourcePath.startsWith(e.dir + '/') || sourcePath === e.dir) {
          return chalk.gray(`source=extra:${e.alias}`);
        }
      }
    }
    return chalk.gray('source=extra');
  }
  return chalk.gray(`source=${diff.source}`);
}

function countByStatus(rows: ResourceDiff[]): { ok: number; diff: number; missing: number; extra: number } {
  let ok = 0, diff = 0, missing = 0, extra = 0;
  for (const r of rows) {
    if (r.status === 'ok') ok++;
    else if (r.status === 'diff') diff++;
    else if (r.status === 'missing') missing++;
    else if (r.status === 'extra') extra++;
  }
  return { ok, diff, missing, extra };
}

function renderKindSection(
  kind: DoctorKind,
  rows: ResourceDiff[],
  layers: VersionResourceReport['layers'],
  options: { showDiff: boolean; requestedKinds?: Set<DoctorKind> },
): void {
  const counts = countByStatus(rows);
  const total = rows.length;
  const summaryParts: string[] = [];
  if (counts.ok) summaryParts.push(`${counts.ok} ok`);
  if (counts.diff) summaryParts.push(chalk.yellow(`${counts.diff} diff`));
  if (counts.missing) summaryParts.push(chalk.red(`${counts.missing} missing`));
  if (counts.extra) summaryParts.push(chalk.magenta(`${counts.extra} extra`));
  const summary = total === 0 ? chalk.gray('(none)') : summaryParts.join(', ');
  console.log(`  ${chalk.bold(kind.padEnd(11))} ${chalk.gray(`${total} item${total === 1 ? '' : 's'}`)}  ${summary}`);

  if (total === 0) return;

  // Hide ok rows by default for big lists; show them only with --diff so the
  // operator can verify presence; otherwise keep output focused on problems.
  const visible = options.showDiff ? rows : rows.filter((r) => r.status !== 'ok');
  if (visible.length === 0) {
    console.log(`    ${chalk.gray('all ok')}`);
    return;
  }

  for (const r of visible) {
    const src = sourceLabel(r, layers);
    const name = padToWidth(truncateToWidth(r.name, 28), 28);
    const prefix = `    ${statusLabel(r.status)}  ${name} ${src}`;
    const detail = r.detail
      ? chalk.gray(`  ${truncateToWidth(collapseWhitespace(r.detail), Math.max(1, terminalWidth() - stringWidth(prefix) - 2))}`)
      : '';
    console.log(prefix + detail);

    if (options.showDiff && r.status === 'diff' && r.sourcePath && r.homePath) {
      const expected = readExpectedForDiff(kind, r);
      const actual = safeRead(r.homePath);
      if (expected != null && actual != null) {
        const patch = unifiedDiff(expected, actual, {
          fromLabel: r.sourcePath,
          toLabel: r.homePath,
          context: 2,
        });
        if (patch) console.log(colorizeUnifiedDiff(patch, '      '));
      }
    }
  }
}

function safeRead(p: string): string | null {
  try { return fs.readFileSync(p, 'utf-8'); } catch { return null; }
}

function readExpectedForDiff(kind: DoctorKind, row: ResourceDiff): string | null {
  // Skills are directories; per-file diffs would need recursive walking.
  // Keep the v1 behaviour minimal: the row already says DIFF, the user can
  // open the source path to inspect.
  if (kind === 'skills') return null;
  if (!row.sourcePath) return null;
  return safeRead(row.sourcePath);
}

export type IssueSeverity = 'critical' | 'warning' | 'info';

/**
 * One triaged health finding. `severity`/`category`/`subject`/`impact`/`fix` are
 * the triage backbone the human report renders and `--json` carries; `text`/`color`
 * stay the terse combined label older readers used, so the shape is additive.
 *
 * Severity model (agent-agnostic — applies to every agent doctor inspects):
 *   - critical (silent breakage): an unwired hook, a missing/unparseable
 *     settings.json, a MISSING hook or plugin.
 *   - warning (stale / drift): a source layer behind origin, a DIVERGENT resource,
 *     a stale / never-synced version, a MISSING resource of any other kind
 *     (see `missingResourceSeverity`, which reads this split from
 *     `FINDING_SEVERITY` — RUSH-2947).
 *   - info (orphan): an EXTRA resource → `agents prune cleanup`.
 */
export interface VerdictIssue {
  severity: IssueSeverity;
  /** machine-stable class: unwired-hook | settings-missing | settings-unparseable
   *  | missing | source-behind | divergent | extra | stale | never-synced | orphan */
  category: string;
  /** the hook / resource / layer / version the finding is about */
  subject: string;
  /** one-line plain-English consequence */
  impact: string;
  /** exact remediation command */
  fix: string;
  /** terse combined label (legacy) */
  text: string;
  color: 'yellow' | 'red' | 'magenta';
}

export interface DoctorVerdict {
  healthy: boolean;
  issues: VerdictIssue[];
  /** Resources (target) / versions (overview) reconciled clean — drives the
   *  healthy line's count. */
  reconciled: number;
}

/** Categories `agents sync` reconciles (vs. `agents repo pull` for a behind
 *  source, or `agents prune cleanup` for an orphan). Drives the heal footer. */
const AUTO_FIXABLE_CATEGORIES = new Set([
  'hook-runtime-broken', 'unwired-hook', 'settings-missing', 'settings-unparseable', 'missing', 'divergent', 'stale', 'never-synced',
]);

export function verdictIsAutoFixable(v: DoctorVerdict): boolean {
  return v.issues.some((i) => AUTO_FIXABLE_CATEGORIES.has(i.category));
}

/**
 * Missing-resource severity for one `DoctorKind`, read from `FINDING_SEVERITY`
 * (the fleet-mode rubric) so target mode agrees with it kind by kind instead of
 * re-hardcoding its own. Hooks and plugins map to their dedicated critical
 * finding kinds; every other kind maps to the generic 'missing-resource' warning.
 */
function missingResourceSeverity(kind: DoctorKind): IssueSeverity {
  if (kind === 'hooks') return FINDING_SEVERITY['missing-hook'];
  if (kind === 'plugins') return FINDING_SEVERITY['missing-plugin'];
  return FINDING_SEVERITY['missing-resource'];
}

/**
 * Fold a version report's divergences into a triaged verdict — one severity-tagged
 * finding per unwired hook, missing/divergent/extra resource, and behind-origin
 * source layer, each carrying its subject, plain-English impact, and exact fix. An
 * UNWIRED hook or a stale source is as unhealthy as a divergent file, not a
 * footnote. Pure so the health rollup is unit-testable without a version home.
 */
export function computeVerdict(report: VersionResourceReport): DoctorVerdict {
  const issues: VerdictIssue[] = [];
  const idLabel = `${report.agent}@${report.version}`;
  // doctor diagnoses; `agents sync` fixes. Every auto-fixable finding points at
  // the one fixer — a command sync can actually deliver (asserted in the tests).
  const fixCmd = `agents sync ${idLabel} --yes`;
  const syncCmd = fixCmd;

  // ── critical: settings.json / unwired hooks (silent breakage) ──
  const w = report.hookWiring;
  for (const issue of w?.runtimeBroken ?? []) {
    issues.push({
      severity: 'critical', category: 'hook-runtime-broken', subject: issue.name,
      impact: `generated hook wrapper is ${issue.reason}; the hook cannot run`,
      fix: fixCmd,
      text: `${issue.name} hook runtime broken`, color: 'red',
    });
  }
  if (w?.settingsMissing) {
    const n = w.expected ?? 0;
    issues.push({
      severity: 'critical', category: 'settings-missing', subject: 'settings.json',
      impact: `not found; ${n} declared hook${n === 1 ? '' : 's'} never fire`,
      fix: syncCmd,
      text: `settings.json missing (${n} hook${n === 1 ? '' : 's'} unwired)`, color: 'red',
    });
  } else if (w?.settingsUnparseable) {
    issues.push({
      severity: 'critical', category: 'settings-unparseable', subject: 'settings.json',
      impact: `unparseable; hook wiring can't be verified`,
      fix: syncCmd,
      text: 'settings.json unparseable', color: 'red',
    });
  } else if (w) {
    for (const u of w.unwired) {
      issues.push({
        severity: 'critical', category: 'unwired-hook', subject: u.name,
        impact: 'on disk but not wired into settings.json; the hook never fires',
        fix: syncCmd,
        text: `${u.name} unwired`, color: 'red',
      });
    }
  }

  // ── missing resources (declared in sources, absent from home) — severity
  // follows FINDING_SEVERITY: hooks/plugins are critical, everything else warns ──
  for (const kind of DOCTOR_ALL_KINDS) {
    for (const r of report.kinds[kind]) {
      if (r.status !== 'missing') continue;
      const severity = missingResourceSeverity(kind);
      issues.push({
        severity, category: 'missing', subject: r.name,
        impact: `declared in sources but absent from the version home (${kind})`,
        fix: fixCmd,
        text: `${r.name} missing`, color: severity === 'critical' ? 'red' : 'yellow',
      });
    }
  }

  // ── warning: source layer behind origin (home reconciled against stale truth) ──
  for (const b of report.sourceBehind ?? []) {
    if (b.behind <= 0) continue;
    issues.push({
      severity: 'warning', category: 'source-behind', subject: b.label,
      impact: `${b.behind} commit${b.behind === 1 ? '' : 's'} behind ${b.branch}; you're running stale config`,
      fix: `agents repo pull ${b.alias}`,
      text: `source ${b.label} ${b.behind} commit${b.behind === 1 ? '' : 's'} behind ${b.branch}`, color: 'yellow',
    });
  }

  // ── warning: divergent resources (drifted from source) ──
  for (const kind of DOCTOR_ALL_KINDS) {
    for (const r of report.kinds[kind]) {
      if (r.status !== 'diff') continue;
      issues.push({
        severity: 'warning', category: 'divergent', subject: r.name,
        impact: r.detail ? collapseWhitespace(r.detail) : 'differs from source',
        fix: fixCmd,
        text: `${r.name} divergent`, color: 'yellow',
      });
    }
  }

  // ── info: extra / orphan resources (present in home, no source) ──
  for (const kind of DOCTOR_ALL_KINDS) {
    for (const r of report.kinds[kind]) {
      if (r.status !== 'extra') continue;
      issues.push({
        severity: 'info', category: 'extra', subject: r.name,
        impact: `orphan in the version home with no source (${kind})`,
        fix: 'agents prune cleanup',
        text: `${r.name} extra`, color: 'magenta',
      });
    }
  }

  return { healthy: issues.length === 0, issues, reconciled: report.summary.ok };
}

// ─── triaged health block (shared by target + overview) ────────────────────────

const SEVERITY_COLOR: Record<IssueSeverity, (s: string) => string> = {
  critical: chalk.red,
  warning: chalk.yellow,
  info: chalk.magenta,
};
// Restrained terminal glyphs — the ✓ ✗ ⚠ set plus a subtle info dot, colored via
// chalk to match the man-page voice. No colorful emoji.
const SEVERITY_GLYPH: Record<IssueSeverity, string> = {
  critical: '✗',
  warning: '⚠',
  info: '·',
};

function severityCounts(issues: VerdictIssue[]): { critical: number; warning: number; info: number } {
  return {
    critical: issues.filter((i) => i.severity === 'critical').length,
    warning: issues.filter((i) => i.severity === 'warning').length,
    info: issues.filter((i) => i.severity === 'info').length,
  };
}

/** The info tier (orphans; one identical `prune cleanup` fix, already enumerated
 *  in the detail section) is capped with a rollup so the block stays scannable
 *  when a version home carries dozens of orphans. Critical + warning are
 *  actionable, each with a distinct subject/fix, so they are never capped. */
const INFO_CAP = 5;

/**
 * Build the lines of a triaged health block: a single green ✓ line when healthy,
 * otherwise a severity-counted ✗ header followed by one row per finding (icon ·
 * severity · subject — impact, then the exact fix under it) and an optional heal
 * footer. Pure — returns the lines so the rendered output is unit-testable. Shared
 * by target mode and the bare overview so both read the same way.
 */
export function healthBlockLines(verdict: DoctorVerdict, opts: { healthySummary: string; healFix?: string }): string[] {
  if (verdict.healthy) {
    return [`  ${chalk.green('✓')} ${chalk.green('healthy')} ${chalk.gray('— ' + opts.healthySummary)}`];
  }
  const lines: string[] = [];
  const c = severityCounts(verdict.issues);
  const bits: string[] = [];
  if (c.critical) bits.push(`${c.critical} critical`);
  if (c.warning) bits.push(`${c.warning} warning${c.warning === 1 ? '' : 's'}`);
  if (c.info) bits.push(`${c.info} info`);
  const total = verdict.issues.length;
  lines.push(`  ${chalk.red('✗')} ${chalk.red('unhealthy')} ${chalk.gray(`— ${total} issue${total === 1 ? '' : 's'} (${bits.join(' · ')})`)}`);
  lines.push('');

  const cont = ' '.repeat(14); // aligns the fix line under the subject column
  const issueLines = (i: VerdictIssue): void => {
    const glyph = SEVERITY_COLOR[i.severity](SEVERITY_GLYPH[i.severity]);
    const word = SEVERITY_COLOR[i.severity](i.severity.padEnd(8));
    lines.push(`  ${glyph} ${word}  ${chalk.bold(i.subject)} ${chalk.gray('— ' + i.impact)}`);
    lines.push(chalk.gray(`${cont}→ ${i.fix}`));
  };
  const actionable = verdict.issues.filter((i) => i.severity !== 'info');
  const infoIssues = verdict.issues.filter((i) => i.severity === 'info');
  for (const i of actionable) issueLines(i);
  for (const i of infoIssues.slice(0, INFO_CAP)) issueLines(i);
  const hiddenInfo = infoIssues.length - Math.min(infoIssues.length, INFO_CAP);
  if (hiddenInfo > 0) {
    const glyph = SEVERITY_COLOR.info(SEVERITY_GLYPH.info);
    const word = SEVERITY_COLOR.info('info'.padEnd(8));
    lines.push(`  ${glyph} ${word}  ${chalk.gray(`+${hiddenInfo} more orphan${hiddenInfo === 1 ? '' : 's'}`)} ${chalk.gray('— agents prune cleanup')}`);
  }

  if (opts.healFix) {
    lines.push('');
    lines.push(`  ${chalk.gray("heal what's auto-fixable:")}  ${opts.healFix}`);
  }
  return lines;
}

function renderHealthBlock(verdict: DoctorVerdict, opts: { healthySummary: string; healFix?: string }): void {
  for (const line of healthBlockLines(verdict, opts)) console.log(line);
}

/**
 * Aggregate the bare `agents doctor` overview into the same triaged verdict target
 * mode uses — folding per-version wiring/sync drift, behind-origin source layers,
 * and orphan resources into severity-tagged findings. Agent-agnostic: every
 * installed version is classified the same way. Pure, so it is unit-testable.
 */
export function computeOverviewHealth(
  syncRows: SyncStatusRow[],
  orphanRows: OrphanRow[],
  repoBehindMarkers: FetchStatusMarker[],
  duplicateHooks: DuplicateVersionHook[] = [],
): DoctorVerdict {
  const issues: VerdictIssue[] = [];
  const pretty = (agent: string, version: string) => `${AGENT_NAMES[agent] || agent}@${version}`;

  // critical/warning: same hook resource materialized in several version homes.
  // Different content is more severe because a stale copy can disagree with
  // the active gate; byte-identical copies are noise and duplicate runtime cost.
  for (const finding of duplicateHooks) {
    const versions = finding.copies.map((copy) => copy.version).join(', ');
    const active = finding.authoritative.version;
    const drift = finding.kind === 'drift';
    issues.push({
      severity: drift ? 'critical' : 'warning',
      category: drift ? 'duplicate-hook-drift' : 'duplicate-hook',
      subject: `${finding.agent}/${finding.name}`,
      impact: `${drift ? 'different content' : 'identical content'} across versions ${versions}; ${active} is authoritative`,
      fix: `agents sync ${finding.agent}@${active} --yes`,
      text: `${finding.name} ${drift ? 'drift' : 'duplicated'} across ${versions}`,
      color: drift ? 'red' : 'yellow',
    });
  }

  // critical: generated hook runtime / unwired hooks / broken settings.json per version
  for (const row of syncRows) {
    const brokenRuntime = row.brokenHookRuntime ?? 0;
    if (brokenRuntime > 0) {
      const label = pretty(row.agent, row.version);
      issues.push({
        severity: 'critical', category: 'hook-runtime-broken', subject: label,
        impact: `${brokenRuntime} generated hook wrapper${brokenRuntime === 1 ? '' : 's'} unusable; affected hooks cannot run`,
        fix: `agents sync ${row.agent}@${row.version} --yes`,
        text: `${label} ${brokenRuntime} hook runtime broken`, color: 'red',
      });
    }
    const n = row.unwiredHooks ?? 0;
    if (n <= 0) continue;
    const label = pretty(row.agent, row.version);
    issues.push({
      severity: 'critical', category: 'unwired-hook', subject: label,
      impact: `${n} hook${n === 1 ? '' : 's'} present on disk but not wired into settings.json; never fire`,
      fix: `agents sync ${row.agent}@${row.version} --yes`,
      text: `${label} ${n} unwired`, color: 'red',
    });
  }

  // warning: source layers behind origin
  for (const m of repoBehindMarkers) {
    if (m.behind <= 0) continue;
    const label = m.alias === 'user' ? '~/.agents' : m.alias;
    issues.push({
      severity: 'warning', category: 'source-behind', subject: label,
      impact: `${m.behind} commit${m.behind === 1 ? '' : 's'} behind ${m.branch}; you're running stale config`,
      fix: `agents repo pull ${m.alias}`,
      text: `${label} ${m.behind} behind`, color: 'yellow',
    });
  }

  // warning: stale / never-synced versions
  for (const row of syncRows) {
    const label = pretty(row.agent, row.version);
    if (row.status === 'stale') {
      issues.push({
        severity: 'warning', category: 'stale', subject: label,
        impact: 'sources changed since last sync',
        fix: `agents sync ${row.agent}@${row.version} --yes`,
        text: `${label} stale`, color: 'yellow',
      });
    } else if (row.status === 'never-synced') {
      issues.push({
        severity: 'warning', category: 'never-synced', subject: label,
        impact: 'installed but never synced',
        fix: `agents sync ${row.agent}@${row.version} --yes`,
        text: `${label} never-synced`, color: 'yellow',
      });
    }
  }

  // info: orphan resources per version
  for (const row of orphanRows) {
    const parts: string[] = [];
    if (row.commands) parts.push(`${row.commands} command${row.commands === 1 ? '' : 's'}`);
    if (row.skills) parts.push(`${row.skills} skill${row.skills === 1 ? '' : 's'}`);
    if (row.hooks) parts.push(`${row.hooks} hook${row.hooks === 1 ? '' : 's'}`);
    const label = pretty(row.agent, row.version);
    issues.push({
      severity: 'info', category: 'orphan', subject: label,
      impact: `${parts.join(', ')} in the version home with no source`,
      fix: 'agents prune cleanup',
      text: `${label} orphan`, color: 'magenta',
    });
  }

  const reconciled = syncRows.filter(
    (r) => r.status === 'fresh' && (r.unwiredHooks ?? 0) === 0 && (r.brokenHookRuntime ?? 0) === 0,
  ).length;
  return { healthy: issues.length === 0, issues, reconciled };
}

/**
 * Render the UNWIRED hook rows (and settings.json problems) inside the hooks
 * section, in the same row style as the reconcile rows above them.
 */
function renderHookWiringRows(w: HookWiringReport): void {
  if (!w.supported) return;
  if (w.settingsMissing) {
    const where = w.settingsPath ? ` at ${w.settingsPath}` : '';
    console.log(`    ${chalk.red('UNWIRED')}  ${chalk.gray(`settings.json not found${where} — ${w.expected ?? 0} declared hook(s) never fire`)}`);
    return;
  }
  if (w.settingsUnparseable) {
    const where = w.settingsPath ? ` at ${w.settingsPath}` : '';
    console.log(`    ${chalk.red('UNWIRED')}  ${chalk.gray(`settings.json unparseable${where} — wiring can't be verified`)}`);
    return;
  }
  for (const u of w.unwired) {
    const name = padToWidth(truncateToWidth(u.name, 28), 28);
    const scope = u.matcher ? `event=${u.event} matcher=${u.matcher}` : `event=${u.event}`;
    console.log(`    ${chalk.red('UNWIRED')}  ${name} ${chalk.gray(scope)}`);
  }
}

function renderTargetText(report: VersionResourceReport, options: { showDiff: boolean; requestedKinds?: Set<DoctorKind> }): void {
  const label = `${AGENT_NAMES[report.agent] || report.agent}@${report.version}`;
  console.log(chalk.bold(label));
  const homePrefix = '  home: ';
  const cwdPrefix = '  cwd:  ';
  console.log(chalk.gray(homePrefix + truncateToWidth(report.home, Math.max(1, terminalWidth() - stringWidth(homePrefix)))));
  console.log(chalk.gray(cwdPrefix + truncateToWidth(report.cwd, Math.max(1, terminalWidth() - stringWidth(cwdPrefix)))));
  const layerStr = [
    report.layers.project ? `project=${report.layers.project}` : null,
    `user=${report.layers.user}`,
    `system=${report.layers.system}`,
    report.layers.extras.length > 0
      ? `extras=[${report.layers.extras.map((e) => e.alias).join(',')}]`
      : null,
  ].filter(Boolean).join(' ');
  printWrappedLine('  layers: ', layerStr);

  // Staleness manifest verdict — single-line summary from the staleness
  // library, sitting alongside the detailed per-resource diff below.
  const manifest = loadManifest(report.agent, report.version);
  if (!manifest) {
    console.log(chalk.gray(`  manifest: ${chalk.gray('cold')} (never synced)`));
  } else {
    const stale = isStale(manifest, report.agent, report.version, report.cwd);
    if (stale) {
      console.log(chalk.gray('  manifest: ') + chalk.yellow('stale') + chalk.gray(' (sources changed since last sync)'));
    } else {
      console.log(chalk.gray('  manifest: ') + chalk.green('fresh'));
    }
  }
  console.log();

  for (const kind of DOCTOR_ALL_KINDS) {
    const rows = report.kinds[kind];
    // Skip kinds that weren't requested (kind filter narrowed the report).
    // We detect this by checking whether the kind has any rows AND was in
    // scope; absent kinds with empty arrays still render so the operator
    // sees what was checked. options.requestedKinds drives this.
    if (options.requestedKinds && !options.requestedKinds.has(kind)) continue;
    if (kind === 'hooks' && report.hookInventory) {
      const wired = report.hookInventory.wiringSupported ? String(report.hookInventory.wired.length) : 'unknown';
      const unmanaged = report.hookInventory.unmanaged.length > 0 ? ` · unmanaged ${report.hookInventory.unmanaged.length}` : '';
      console.log(chalk.gray(`  inventory: capable ${report.hookInventory.capable ? 'yes' : 'no'} · on-disk ${report.hookInventory.onDisk.length} · wired ${wired}${unmanaged}`));
    }
    renderKindSection(kind, rows, report.layers, options);
    // A hook file can reconcile "ok" above yet be absent from settings.json — a
    // present-but-dead hook. Surface that right under the hooks section.
    if (kind === 'hooks' && report.hookWiring) renderHookWiringRows(report.hookWiring);
  }

  console.log();
  const verdict = computeVerdict(report);
  // A source layer behind origin is healed by `agents repo pull`, not by sync —
  // the per-issue fix already names the right command, so the heal footer only
  // shows when something is genuinely sync-fixable (never in the source-behind or
  // orphan-only case, where it would mislead).
  const hooksWired = report.hookWiring?.supported ? ' · hooks wired' : '';
  renderHealthBlock(verdict, {
    healthySummary: `${verdict.reconciled} resource${verdict.reconciled === 1 ? '' : 's'} reconciled${hooksWired} · sources current`,
    healFix: verdictIsAutoFixable(verdict) ? `agents sync ${report.agent}@${report.version} --yes` : undefined,
  });
}

// ─── CI drift gate (doctor --check) ──────────────────────────────────────────
//
// The scriptable exit-code gate, folded in from the former `agents check`. Runs
// the SAME drift diagnostic doctor computes (`computeDrift`), but turns it into
// an exit code: non-zero when any installed version is stale or never-synced,
// zero when the whole install is fresh. `agents doctor` is the human report;
// `agents doctor --check` is the machine gate — same engine, different output.
//
// Orphans are surfaced informationally but never fail the gate: they are a
// `prune` concern, not sync drift (mirrors the sync-status engine).

interface DeviceCheckResult {
  device: string;
  hasDrift: boolean;
  stale: number;
  neverSynced: number;
  orphanVersions: number;
  error?: string;
}

function checkLabel(row: SyncStatusRow): string {
  return `${AGENT_NAMES[row.agent] || row.agent}@${row.version}`;
}

function runCheckGate(opts: DoctorOptions, cwd: string): void {
  const drift = computeDrift(cwd);

  if (opts.json) {
    console.log(JSON.stringify({
      hasDrift: drift.hasDrift,
      stale: drift.staleCount,
      neverSynced: drift.neverSyncedCount,
      unwiredHookVersions: drift.unwiredHookVersions,
      brokenHookRuntimeVersions: drift.brokenHookRuntimeVersions,
      orphanVersions: drift.orphanVersionCount,
      sourceBehind: drift.sourceBehind,
      versions: drift.syncRows.map((r) => ({
        agent: r.agent,
        version: r.version,
        status: r.status,
        isDefault: r.isDefault,
        unwiredHooks: r.unwiredHooks ?? 0,
        brokenHookRuntime: r.brokenHookRuntime ?? 0,
        divergence: r.divergence ?? [],
      })),
    }, null, 2));
    process.exit(drift.hasDrift ? 1 : 0);
  }

  if (drift.syncRows.length === 0) {
    // Nothing installed is a clean state, not a failure — CI on a fresh
    // checkout with no versions should pass, not error.
    console.log(chalk.gray('check: no installed versions — nothing to verify'));
    process.exit(0);
  }

  if (!drift.hasDrift) {
    const orphanNote = drift.orphanVersionCount > 0
      ? chalk.gray(` (${drift.orphanVersionCount} version(s) carry orphans — run \`agents prune cleanup\`)`)
      : '';
    console.log(`${chalk.gray('check:')} ${chalk.green('ok')} — ${drift.syncRows.length} version(s) in sync${orphanNote}`);
    process.exit(0);
  }

  // Drift: one-line verdict always, per-version detail unless --quiet. The
  // `check:` prefix and total count make every verdict line grep/parse-alike
  // whether it's clean or drifted, instead of the bare `drift  <parts>` shape
  // that gave CI logs no anchor to search on.
  const parts: string[] = [];
  if (drift.staleCount > 0) parts.push(`${drift.staleCount} stale`);
  if (drift.neverSyncedCount > 0) parts.push(`${drift.neverSyncedCount} never-synced`);
  if (drift.unwiredHookVersions > 0) parts.push(`${drift.unwiredHookVersions} with unwired hooks`);
  if (drift.brokenHookRuntimeVersions > 0) parts.push(`${drift.brokenHookRuntimeVersions} with broken hook runtime`);
  if (drift.sourceBehind.length > 0) parts.push(`${drift.sourceBehind.length} source layer(s) behind origin`);
  console.error(`${chalk.gray('check:')} ${chalk.red('drift')} — ${parts.join(', ')} across ${drift.syncRows.length} version(s)`);

  if (!opts.quiet) {
    // Fixed-width, left-aligned so rows form a real column; the badge text is
    // the actual status name ('never-synced'), not the unrelated 'cold' label
    // that used to hide it. Width is 'never-synced'.length + a 2-space gap so
    // the longest badge still separates cleanly from the label that follows.
    const STATUS_BADGE_WIDTH = 'never-synced'.length + 2;
    for (const row of drift.syncRows) {
      const unwired = (row.unwiredHooks ?? 0) > 0;
      const brokenRuntime = (row.brokenHookRuntime ?? 0) > 0;
      if (row.status === 'fresh' && !unwired && !brokenRuntime) continue;
      const tag = row.status === 'stale' ? chalk.yellow('stale'.padEnd(STATUS_BADGE_WIDTH))
        : row.status === 'never-synced' ? chalk.gray('never-synced'.padEnd(STATUS_BADGE_WIDTH))
        : chalk.red((brokenRuntime ? 'hook-runtime' : 'unwired').padEnd(STATUS_BADGE_WIDTH));
      console.error(`  ${tag}${checkLabel(row)}`);
      for (const line of row.divergence ?? []) {
        console.error(chalk.gray(`           ${line}`));
      }
    }
    for (const b of drift.sourceBehind) {
      console.error(`  ${chalk.red('behind')} source ${b.label}  ${chalk.gray(`${b.behind} commit${b.behind === 1 ? '' : 's'} behind ${b.branch}`)}`);
    }
    const hints: string[] = [];
    if (drift.staleCount > 0 || drift.neverSyncedCount > 0 || drift.unwiredHookVersions > 0 || drift.brokenHookRuntimeVersions > 0) {
      hints.push('`agents sync <agent>@all` (or `agents sync <agent>@<version>`)');
    }
    if (drift.sourceBehind.length > 0) hints.push('`agents repo pull <alias>` for a source layer behind origin');
    console.error(chalk.gray(`\nReconcile with ${hints.join('; ')}.`));
  }

  process.exit(1);
}

function checkPayload(device: string, drift: ReturnType<typeof computeDrift>): DeviceCheckResult {
  return {
    device,
    hasDrift: drift.hasDrift,
    stale: drift.staleCount,
    neverSynced: drift.neverSyncedCount,
    orphanVersions: drift.orphanVersionCount,
  };
}

interface CheckFanOutTarget extends FanOutDeviceTarget {
  platform?: string;
  /** Registry Tailscale address to dial, not the bare name — see {@link fleetDialTarget}. */
  dialTarget: string;
  extraSshArgs?: string[];
}

async function probeDeviceCheck(target: CheckFanOutTarget): Promise<DeviceCheckResult> {
  const isWin = /^win/i.test((target.platform ?? '').trim());
  const remoteCmd = buildRemoteAgentsInvocation(
    ['doctor', '--check', '--json'],
    undefined,
    isWin ? 'windows' : undefined,
    isWin ? undefined : { PATH: '$HOME/.agents/.cache/shims:$HOME/.local/bin:$PATH' },
  );
  const res = await sshExecAsync(target.dialTarget, remoteCmd, { timeoutMs: 30000, multiplex: true, extraSshArgs: target.extraSshArgs });
  if (res.code !== 0 && !res.stdout.trim()) {
    throw new Error(res.timedOut ? 'timed out' : (res.stderr.trim() || `exit ${res.code ?? 'unknown'}`));
  }
  try {
    const parsed = JSON.parse(res.stdout) as Omit<DeviceCheckResult, 'device'>;
    return {
      device: target.name,
      hasDrift: Boolean(parsed.hasDrift),
      stale: parsed.stale ?? 0,
      neverSynced: parsed.neverSynced ?? 0,
      orphanVersions: parsed.orphanVersions ?? 0,
    };
  } catch (err: any) {
    throw new Error(`invalid JSON (${err?.message ?? 'parse error'})`);
  }
}

async function runDevicesCheck(opts: DoctorOptions, cwd: string): Promise<void> {
  const registry = await loadDevices();
  const self = machineId();
  const planned = planFleetTargets(registry);
  const local = checkPayload(self, computeDrift(cwd));
  const remoteTargets: CheckFanOutTarget[] = remoteFleetTargets(planned, self)
    .map((t) => ({
      name: t.device.name,
      platform: t.device.platform,
      skip: t.skip,
      dialTarget: fleetDialTarget(t.device),
      extraSshArgs: deviceIdentityArgs(t.device),
    }));
  const remote = await fanOutDevices(remoteTargets, probeDeviceCheck);
  const devices: DeviceCheckResult[] = [local];
  for (const result of remote) {
    if (result.status === 'ok' && result.value) {
      devices.push(result.value);
    } else {
      devices.push({
        device: result.name,
        hasDrift: true,
        stale: 0,
        neverSynced: 0,
        orphanVersions: 0,
        error: result.error ?? String(result.reason ?? 'skipped'),
      });
    }
  }
  const hasDrift = devices.some((d) => d.hasDrift || d.error);
  if (opts.json) {
    console.log(JSON.stringify({ hasDrift, devices }, null, 2));
    process.exit(hasDrift ? 1 : 0);
  }
  if (!hasDrift) {
    console.log(chalk.green('ok') + chalk.gray(`  ${devices.length} device(s) in sync`));
    process.exit(0);
  }
  console.error(chalk.red('drift') + chalk.gray(`  ${devices.filter((d) => d.hasDrift || d.error).length} of ${devices.length} device(s)`));
  if (!opts.quiet) {
    for (const d of devices) {
      if (!d.hasDrift && !d.error) continue;
      const detail = d.error
        ? d.error
        : [`${d.stale} stale`, `${d.neverSynced} never-synced`].filter((p) => !p.startsWith('0 ')).join(', ');
      console.error(`  ${chalk.yellow(d.device.padEnd(18))} ${detail || 'drift'}`);
    }
    console.error(chalk.gray('\nReconcile each device with `agents sync <agent>@all` or `agents repo pull user`.'));
  }
  process.exit(1);
}

// ─── command registration ────────────────────────────────────────────────────

export function registerDoctorCommand(program: Command): void {
  const doctorCmd = addHostOption(program.command('doctor [target]'))
    .description('Diagnose CLI availability, sync status, and resource divergence (optionally for a specific agent[@version]).')
    .option('--json', 'Output machine-readable JSON')
    .option('--diff', 'In target mode, include unified diffs for divergent files')
    .option('--fix', '(deprecated) doctor is diagnose-only — this errors with a pointer to `agents sync`, the one fixer')
    .option('--kind <kinds>', 'Restrict to comma-separated resource kinds (commands,skills,hooks,rules,mcp,permissions,subagents,plugins,workflows,memory)')
    .option('--cwd <path>', 'Resolution cwd for project layer detection (default: process.cwd())')
    .option('--adopt <agent>', "Take over the agent's native launcher that shadows the shim (symlink it to the version-managed shim; reversible with --release)")
    .option('--release <agent>', 'Undo --adopt: restore the native launcher agents-cli previously adopted')
    .option('--devices', 'Check agent readiness AND cross-device harness divergence (missing resources/versions, repo drift) on every registered device')
    .option('--check', 'CI drift gate: exit non-zero when any installed version is out of sync (stale or never-synced), zero when clean. Combine with --devices to gate the whole fleet.')
    .option('--refresh', 'Bypass the cached overview snapshot: recompute the bare `doctor --json` overview live and refresh the shared cache that the menu-bar and other pollers read')
    .option('-q, --quiet', 'With --check, suppress per-version lines; print only the one-line verdict');

  setHelpSections(doctorCmd, {
    examples: `
      # Overview: CLI availability + sync status + orphans across all defaults
      agents doctor

      # Machine-readable overview (served from a ~90s cache for pollers like the
      # menu-bar helper); --refresh recomputes live and refreshes that cache
      agents doctor --json
      agents doctor --json --refresh

      # Full per-resource report for the active default
      agents doctor claude@default

      # All installed versions of one agent
      agents doctor antigravity

      # Pin to a specific installed version
      agents doctor codex@0.117.0

      # Inspect only rules and hooks, with full diffs
      agents doctor claude@default --kind rules,hooks --diff

      # Fix every gap across all installed versions (the one fixer)
      agents sync claude@all

      # Fix just one version
      agents sync claude@2.1.207

      # Fleet: agent readiness + cross-device divergence (missing plugins/skills,
      # agent-version gaps, .agents/.system repo drift) vs this machine
      agents doctor --devices

      # CI drift gate: exit 1 if anything drifted (stale/never-synced), 0 if clean
      agents doctor --check
      agents doctor --check --quiet          # just the verdict line
      agents doctor --check --json           # machine-readable, for scripting
      agents doctor --check --devices        # gate every registered device
      agents doctor --check || { echo "resources drifted — run 'agents sync <agent>@all'"; exit 1; }
    `,
  });

  doctorCmd.action(async (target: string | undefined, opts: DoctorOptions) => {
      const cwd = opts.cwd ? opts.cwd : process.cwd();

      // CI drift gate. Kept BEFORE the --devices branch so `doctor --check
      // --devices` routes to the drift gate fan-out (runDevicesCheck), while a
      // bare `doctor --devices` still routes to the readiness matrix below.
      if (opts.check) {
        if (target) {
          console.error(chalk.red('Cannot combine --check with a target argument.'));
          process.exit(1);
        }
        if (opts.devices) {
          await runDevicesCheck(opts, cwd);
        } else {
          runCheckGate(opts, cwd);
        }
        return;
      }

      if (opts.devices) {
        if (target) {
          console.error(chalk.red('Cannot combine --devices with a target argument.'));
          process.exit(1);
        }
        await runDevicesDoctor(opts);
        return;
      }

      // Launcher adoption escape hatch. `--adopt <agent>` forces the take-over
      // even for a non-default agent; `--release <agent>` reverses it.
      if (opts.adopt || opts.release) {
        if (opts.adopt && opts.release) {
          console.error(chalk.red('--adopt and --release are mutually exclusive; pass only one.'));
          process.exit(1);
        }
        const { adoptShadowingLauncher, releaseAdoptedLauncher } = await import('../lib/installations/shims.js');
        const raw = (opts.adopt || opts.release) as string;
        const agent = resolveAgentName(raw);
        if (!agent) {
          console.error(chalk.red(formatAgentError(raw)));
          process.exit(1);
        }
        if (opts.release) {
          const restored = releaseAdoptedLauncher(agent);
          if (restored) {
            console.log(chalk.green(`Released ${AGENTS[agent].cliCommand}: launcher restored to ${restored}.`));
          } else {
            console.log(chalk.gray(`${AGENTS[agent].cliCommand} has no adopted launcher to release.`));
          }
          return;
        }
        // adoptShadowingLauncher resolves the launcher itself (PATH shadow, then
        // the durable ~/.local/bin symlink), so it forces the take-over even when
        // this shell's PATH already has the shim first.
        let result;
        try {
          result = adoptShadowingLauncher(agent);
        } catch (err) {
          if (err instanceof IsolationBoundaryError) { explainIsolationBoundary(err); process.exit(1); }
          throw err;
        }
        if (result.adopted) {
          console.log(chalk.green(`Adopted ${AGENTS[agent].cliCommand} launcher (${result.launcher} -> shim). Original recorded for --release; version management now wins regardless of PATH order.`));
        } else if (result.reason === 'already-adopted') {
          console.log(chalk.gray(`${AGENTS[agent].cliCommand} launcher is already adopted.`));
        } else if (result.reason === 'no-shadow') {
          console.log(chalk.gray(`Nothing to adopt — no ${AGENTS[agent].cliCommand} launcher found shadowing the shim (checked PATH and ~/.local/bin).`));
        } else if (result.reason === 'not-a-symlink') {
          console.log(chalk.yellow(`${AGENTS[agent].cliCommand} is shadowed by a real binary (${result.launcher}), not a symlink. agents-cli won't move a real binary — remove/reorder it or reorder PATH.`));
        } else {
          console.log(chalk.yellow(`Could not adopt ${AGENTS[agent].cliCommand} (${result.reason}).`));
        }
        return;
      }

      // `doctor --fix` moved to `agents sync` — doctor is diagnose-only now.
      // Keep the flag for one release as a signpost: it never heals, it points at
      // the one fixer and exits non-zero so scripts and muscle memory get a clear
      // redirect instead of a silent no-op.
      if (opts.fix) {
        const where = target ? `agents sync ${target}` : 'agents sync <agent>@all';
        console.error(chalk.yellow('`agents doctor --fix` has moved to `agents sync`.'));
        console.error(chalk.gray(`  doctor now only diagnoses. To fix, run: ${where}`));
        process.exit(1);
      }

      if (!target) {
        // Singleflight + short-TTL cache for the bare `doctor --json` overview.
        // This overview probes every host CLI, every agent's sign-in, and every
        // agent×version diff — seconds on an idle box, minutes on a loaded one.
        // The menu-bar helper polls it with only a per-*process* in-flight guard,
        // so a helper relaunch (or any second poller) each launched its own live
        // compute, and a helper killed mid-run orphaned a `doctor --json` that
        // kept spinning — stacking to dozens of concurrent runs pinning the CPU
        // (RUSH-2153). Now: a fresh snapshot serves instantly, and when a compute
        // IS needed exactly one runs while every other caller serves its result.
        // A crashed computer never wedges the gate — the lock is stolen once its
        // directory mtime goes stale (see enterDoctorOverviewGate).
        let releaseOverviewGate: (() => void) | undefined;
        if (opts.json) {
          const gate = await enterDoctorOverviewGate({ forceRefresh: !!opts.refresh });
          if (gate.cached !== null) {
            console.log(gate.cached);
            return;
          }
          releaseOverviewGate = gate.release;
        }
        const clis = checkAllClis();
        const syncRows = checkSyncStatus(cwd);
        const orphanRows = countOrphans();
        // Parallel host-CLI probe (RUSH-2136): the serial spawnSync version ran a
        // dozen+ blocking 10s-timeout checks one after another, which measured
        // ~136s on an idle box and stalled the menu-bar helper's poll.
        const hostClis = await listCliStatusAsync(cwd);
        const repoBehindMarkers = readRepoBehindMarkers();
        // The local inventory now carries per-version sign-in (RUSH-2069), so it
        // is the single source for both the accounts line and the logged-out
        // criticals. Collected once (async: it parses each version's account).
        const inventory = await collectLocalFleetInventory(cwd);
        const localName = machineId();
        const duplicateHooks = inspectDuplicateVersionHooks(cwd);
        // A routine belongs to one device. A multi-device pin used to fire it
        // once per listed device — duplicate agent runs, duplicate spend — so
        // surface any that are still on disk with the exact fix.
        const ambiguousPins = findAmbiguousDevicePins(cwd);

        // Legacy account-global sign-in map, kept for `--json` back-compat
        // (ssh.ts RemoteDoctorJson / menubar read `signIn`). File-based, no home.
        const signIn: Record<string, Pick<AccountInfo, 'signedIn' | 'email' | 'accountId'>> = {};
        await Promise.all(
          Object.entries(clis)
            .filter(([, e]) => e.installed)
            .map(async ([name]) => {
              try {
                signIn[name] = await getAccountInfo(name as AgentId);
              } catch {
                /* advisory only */
              }
            }),
        );

        // Per-version resource reports drive the missing-hook / missing-plugin /
        // unwired / content-drift findings. Non-project layers only (the global
        // home is never reconciled against per-cwd project resources).
        const reports: VersionResourceReport[] = [];
        for (const agent of ALL_AGENT_IDS) {
          for (const version of listInstalledVersions(agent)) {
            reports.push(diffVersionResources(agent, version, { cwd, excludeProject: true }));
          }
        }
        // A MANAGED agent (installed versions) whose binary won't resolve is a
        // real critical — an unmanaged-and-absent agent is not.
        const cliMissing = ALL_AGENT_IDS.filter(
          (a) => listInstalledVersions(a).length > 0 && clis[a] && !clis[a].installed,
        );

        // An isolated copy is skipped by the agent-wide `agents sync` sweep, so
        // its findings must never fold into a collapsed cross-version row.
        const isolatedVersions = reports
          .filter((r) => isVersionIsolated(r.agent, r.version))
          .map((r) => `${r.agent}@${r.version}`);

        const findings = buildLocalFindings({
          device: localName,
          binaryShadows: detectAgentsBinaryShadows(),
          syncRows,
          orphanRows,
          repoBehind: repoBehindMarkers,
          reports,
          signIn: inventory.signIn ?? {},
          cliMissing,
          duplicateHooks,
          hostClis: toHostCliInput(hostClis),
          rcSecrets: scanUserRcFiles(),
          masterPassphraseInEnv: masterPassphraseInEnv(),
          authBundleWrongBackend: !inspectReservedAuthBundle().ok,
          // getEffectiveExecutionPolicy spawns powershell — a doomed process on
          // POSIX, where the advisory never applies. Probe only on Windows.
          execPolicy: process.platform === 'win32'
            ? { platform: process.platform, policy: getEffectiveExecutionPolicy() }
            : undefined,
          isolatedVersions,
          // Can the owner-delivery lane (feed/notify) escalate a block from this
          // box? A factory that cannot escalate is not healthy (RUSH-2262).
          ownerSink: await probeOwnerSink(readMeta()),
        });

        if (opts.json) {
          const overviewPayload = {
            clis,
            signIn,
            // Cached auth-health rollup for THIS host — lets `agents fleet status`
            // show a live-verified Auth column from the same fan-out it already
            // runs, without a separate fleet-wide `fleet ping`.
            auth: summarizeHostAuth(readAuthHealthCache(), machineId()),
            sync: syncRows,
            orphans: orphanRows,
            // Triaged overview health — severity/category/subject/impact/fix per
            // finding, aggregated across versions. Additive; existing consumers
            // reading `sync`/`orphans`/`repos` are unaffected.
            health: computeOverviewHealth(syncRows, orphanRows, repoBehindMarkers, duplicateHooks),
            duplicateHooks,
            // Routines whose `devices` names more than one machine — each used to
            // fire once per device. `owner` is the one that fires now.
            ambiguousDevicePins: ambiguousPins,
            // Prioritized RUSH-2069 findings (critical/warning, per-version, with
            // remediation). Additive alongside the legacy fields above.
            findings,
            // This host's harness inventory — installed resources per kind,
            // installed version ids per agent, `.agents`/`.system` repo state, and
            // per-version sign-in — so `agents doctor --devices` can compare
            // presence and sign-in across the fleet (RUSH-2027/2069). Read-only.
            fleet: inventory,
            hostClis: {
              statuses: hostClis.statuses.map((s) => ({
                name: s.manifest.name,
                source: s.manifest.source,
                description: s.manifest.description ?? null,
                installed: s.installed,
              })),
              errors: hostClis.errors,
            },
            // Repos behind upstream — emitted here so menubar and other consumers
            // can surface the notices without reading stderr from normal commands.
            repos: repoBehindMarkers.map((m) => ({
              alias: m.alias,
              dir: m.dir,
              behind: m.behind,
              branch: m.branch,
              fetchedAt: m.fetchedAt,
            })),
          };
          // Persist for the next poller and release the singleflight lock BEFORE
          // printing, so a concurrent caller picks up the fresh snapshot at once.
          writeDoctorOverviewCache(overviewPayload);
          releaseOverviewGate?.();
          console.log(JSON.stringify(overviewPayload, null, 2));
          return;
        }

        // Single-machine hybrid: CRITICAL section + one `▸ <machine>` block.
        const accounts: Record<string, Record<string, FleetVersionSignIn[]>> = {
          [localName]: inventory.signIn ?? {},
        };
        const header = `${chalk.gray('agents doctor ·')} ${chalk.hex('#a3e635')(localName)}${chalk.gray(`  ${getCliVersion()}`)}`;
        for (const line of renderFindings(findings, accounts, { fleet: false, baseline: localName, header })) {
          console.log(line);
        }
        // Point at the interactive reconcile when anything is out of sync — each
        // finding carries its own fix, but `agents sync status` is the one place that
        // reviews and applies them together (opt-in, never auto-fires here).
        if (syncRows.some((r) => r.status !== 'fresh' || (r.unwiredHooks ?? 0) > 0) || repoBehindMarkers.some((m) => m.behind > 0)) {
          console.log(chalk.gray('\nRun `agents sync status` to review and sync what has drifted.'));
        }
        // A routine runs on exactly one device. Each of these named several and
        // used to fire once per device — duplicate agent runs on every schedule.
        if (ambiguousPins.length > 0) {
          console.log();
          console.log(chalk.yellow(`${ambiguousPins.length} routine(s) pin more than one device — a routine runs on exactly one:`));
          for (const pin of ambiguousPins) {
            console.log(
              `  ${chalk.cyan(pin.name)} ${chalk.gray(`[${pin.devices.join(', ')}]`)} ` +
              `${chalk.gray('→ fires only on')} ${pin.owner}`,
            );
            // Deliberately not prescribing `--set ${pin.owner}`: ownership is the
            // lowest-sorted name, which can be a registry alias that matches no
            // live machine (`worker` here), and cementing that keeps the routine
            // dead. Name the candidates and let the operator pick the real box.
            console.log(chalk.gray(
              `      fix: agents routines devices ${pin.name} --set <${pin.devices.join('|')}>`,
            ));
          }
        }
        return;
      }

      const parsed = parseTargetArg(target);
      if ('error' in parsed) {
        console.error(chalk.red(parsed.error));
        process.exit(1);
      }

      const kinds = parseKindFilter(opts.kind);
      if (!Array.isArray(kinds)) {
        console.error(chalk.red(kinds.error));
        process.exit(1);
      }

      const reports: VersionResourceReport[] = parsed.versions.map((v) =>
        diffVersionResources(parsed.agent, v, { cwd, kinds }),
      );

      // Source-layer staleness is global (same across versions) and needs a git
      // probe kept out of the pure diff — compute once, attach to every report so
      // both --json and the text verdict carry it.
      const sourceBehind = computeSourceBehind();
      for (const r of reports) r.sourceBehind = sourceBehind;

      if (opts.json) {
        // Carry the triaged verdict (severity/category/subject/impact/fix per
        // issue) alongside the report — additive, so existing consumers reading
        // `summary`/`kinds`/`hookWiring`/`sourceBehind` are unaffected.
        const withVerdict = reports.map((r) => ({ ...r, verdict: computeVerdict(r) }));
        console.log(JSON.stringify(withVerdict.length === 1 ? withVerdict[0] : withVerdict, null, 2));
        return;
      }

      const showDiff = !!opts.diff;
      const requestedKinds = opts.kind ? new Set(kinds) : undefined;
      reports.forEach((r, i) => {
        if (i > 0) console.log();
        const home = getVersionHomePath(r.agent, r.version);
        if (!fs.existsSync(home)) {
          console.log(chalk.red(`${AGENT_NAMES[r.agent] || r.agent}@${r.version}: version home not found at ${home}`));
          return;
        }
        renderTargetText(r, { showDiff, requestedKinds });
      });
    });
}
