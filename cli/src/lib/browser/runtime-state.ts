import * as fs from 'fs';
import * as path from 'path';
import { execFileSync } from 'child_process';
import {
  getProfileRuntimeDir,
  getBrowserRuntimeDir,
  getEndpointPresets,
  listProfiles,
  getConfiguredDefaultProfileName,
  isProfileLaunchableHere,
  isProfileDeclaredHere,
  deleteProfile,
  DEFAULT_BROWSER_PROFILE_NAME,
  LEGACY_DEFAULT_BROWSER_PROFILE_NAME,
  type BrowserProfileWithDeclarations,
} from './profiles.js';
import { keyBelongsToProfile, type ProfileName } from './types.js';
import { declaringDevices, profileKind } from './registry.js';
import { machineId } from '../machine-id.js';

/**
 * How many devices declare this profile — the shipped model's two kinds.
 *
 * NOT the deleted `scope: local | fleet`, which described where the config was
 * stored. `fungible` means several devices declare the name and each uses its
 * own browser; `identity` means exactly one does, so the name is a singular
 * browser. Prune only ever sees profiles THIS device declares, so `fungible`
 * here means "declared here and elsewhere too".
 */
type PruneProfileClass = 'identity' | 'fungible';

/**
 * Detect an identity-bearing profile whose stored endpoint is loopback, viewed
 * from a machine that is NOT the declaring device.
 *
 * That is the original `comet-local` bug: five real logins on the declaring
 * box, a bare logged-out chromium answering to the same name on a worker
 * because `cdp://localhost:N` is evaluated on the machine running the command.
 * The daemon now tunnels that shape (`resolve-target.ts`); doctor still flags
 * it so a worker does not report a green local binary/port for someone else's
 * browser. Kind comes from the registry (exactly one declaring device), never
 * from a stored field.
 */
export function identityLoopbackMismatch(
  profile: BrowserProfileWithDeclarations,
): { misfiled: false } | { misfiled: true; why: string } {
  if (profileKind(profile.name) !== 'identity') return { misfiled: false };
  const declaringDevice = declaringDevices(profile.name)[0];
  if (!declaringDevice || declaringDevice === machineId()) return { misfiled: false };

  const presets = getEndpointPresets(profile);
  const chosen =
    profile.defaultEndpoint && presets[profile.defaultEndpoint]
      ? profile.defaultEndpoint
      : Object.keys(presets)[0];
  if (!chosen) return { misfiled: false };

  const target = presets[chosen].target;
  if (!target.startsWith('cdp://')) return { misfiled: false };
  let host: string;
  try {
    host = new URL(target).hostname;
  } catch {
    return { misfiled: false };
  }
  if (host !== 'localhost' && host !== '127.0.0.1' && host !== '::1' && host !== '[::1]') {
    return { misfiled: false };
  }

  const here = machineId();
  return {
    misfiled: true,
    why:
      `identity-bearing profile declared on ${declaringDevice}, but "${target}" is a loopback endpoint — ` +
      `on ${here} that address is this device's own browser, not ${declaringDevice}'s. ` +
      `Diagnose the real browser on ${declaringDevice}: agents browser profiles doctor ${profile.name}`,
  };
}

/**
 * Per-profile runtime files we persist under
 * `~/.agents/.cache/browser/<composite>/`:
 *
 *  - `pid`     — child process ID we spawned (or 0 if attached to an
 *                already-running browser)
 *  - `command` — basename of the executable so we can defend against pid
 *                reuse (`process.kill(pid, 0)` only proves *some* process
 *                with that id exists; if the OS recycled it for an
 *                unrelated daemon, we'd happily attach to garbage)
 *  - `meta.json` — richer record: which daemon spawned us, when, the
 *                user-data-dir we wrote into, optional tunnel PID. This
 *                is the file the orphan reaper reads on daemon startup.
 *  - `tasks.json` — open task state (managed elsewhere by service.ts)
 *
 * The one-value-per-file fields are kept for backward compat with older
 * builds; `meta.json` is additive and consulted preferentially.
 */
export interface ProfileRuntime {
  pid: number;
  port?: number;
  command?: string;
  /** Full path of the user-data-dir we passed to --user-data-dir, used by the reaper to confirm. */
  userDataDir?: string;
  /** PID of the daemon that spawned this. When the daemon dies, the next one reaps. */
  daemonPid?: number;
  /** Wall-clock time of spawn — useful for diagnostics and TTL-based cleanup. */
  spawnedAt?: number;
  /** What kind of process: 'browser' (Chrome-family), 'electron' (Notion etc.), or 'tunnel' (ssh -L). */
  kind?: 'browser' | 'electron' | 'tunnel';
  /** Local ssh -L PID, if this profile is SSH-backed. Distinct from `pid` (which is the remote browser, normally 0). */
  tunnelPid?: number;
}

const PID_FILE = 'pid';
const PORT_FILE = 'port';
const COMMAND_FILE = 'command';
const META_FILE = 'meta.json';

function readNumberFile(p: string): number | null {
  try {
    const n = parseInt(fs.readFileSync(p, 'utf-8').trim(), 10);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

function readStringFile(p: string): string | null {
  try {
    return fs.readFileSync(p, 'utf-8').trim() || null;
  } catch {
    return null;
  }
}

/**
 * Save the runtime record atomically. We write the legacy one-value-per-
 * file fields plus a JSON meta blob so future code can read either.
 * The cache directory may not exist yet (first launch); we create it.
 */
export function writeProfileRuntime(
  profileName: string,
  runtime: ProfileRuntime
): void {
  const dir = getProfileRuntimeDir(profileName);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, PID_FILE), String(runtime.pid));
  if (runtime.port !== undefined) {
    fs.writeFileSync(path.join(dir, PORT_FILE), String(runtime.port));
  } else {
    try { fs.unlinkSync(path.join(dir, PORT_FILE)); } catch { /* not present */ }
  }
  if (runtime.command) {
    fs.writeFileSync(path.join(dir, COMMAND_FILE), runtime.command);
  }
  const meta: ProfileRuntime = {
    ...runtime,
    daemonPid: runtime.daemonPid ?? process.pid,
    spawnedAt: runtime.spawnedAt ?? Date.now(),
  };
  fs.writeFileSync(path.join(dir, META_FILE), JSON.stringify(meta));
}

/** Read just the JSON meta record. Returns null when absent or malformed. */
export function readProfileRuntimeMeta(profileName: string): ProfileRuntime | null {
  const dir = getProfileRuntimeDir(profileName);
  try {
    const raw = fs.readFileSync(path.join(dir, META_FILE), 'utf-8');
    const obj = JSON.parse(raw);
    if (typeof obj !== 'object' || obj === null) return null;
    return obj as ProfileRuntime;
  } catch {
    return null;
  }
}

/**
 * Read the runtime triple. Returns null when the files are missing OR when
 * the recorded pid no longer points at the same process we launched —
 * stale data is auto-cleaned to keep the next caller from acting on it.
 */
export function readProfileRuntime(profileName: string): ProfileRuntime | null {
  const dir = getProfileRuntimeDir(profileName);
  const pid = readNumberFile(path.join(dir, PID_FILE));
  const port = readNumberFile(path.join(dir, PORT_FILE));
  const command = readStringFile(path.join(dir, COMMAND_FILE)) ?? undefined;

  if (pid === null || port === null) return null;

  if (!isProcessAlive(pid, command)) {
    clearProfileRuntime(profileName);
    return null;
  }

  return { pid, port, command };
}

/** Remove the pid/port/command/meta files. Leaves chrome-data + tasks.json intact. */
export function clearProfileRuntime(profileName: string): void {
  const dir = getProfileRuntimeDir(profileName);
  for (const f of [PID_FILE, PORT_FILE, COMMAND_FILE, META_FILE]) {
    try { fs.unlinkSync(path.join(dir, f)); } catch { /* not present */ }
  }
}

/**
 * Recursively remove the whole profile cache (chrome-data, tasks.json,
 * everything). Used by `profiles remove` so an old profile name doesn't
 * leak its history into a freshly-recreated one.
 */
export function removeProfileCache(profileName: string): void {
  const dir = getProfileRuntimeDir(profileName);
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* gone */ }
}

/**
 * Find every cache directory belonging to a given profile. A runtime dir name
 * IS a connection key (`<name>@<endpoint>[.<fork>]`), so a single agents-cli
 * profile can have several side by side; this finds them all, plus the legacy
 * non-composite dir from older builds.
 *
 * Membership is decided by {@link keyBelongsToProfile} — the same single rule
 * `status`, `stopProfile`, and `findTask` use (RUSH-2709), so a fork dir is no
 * longer missed here while being matched there.
 */
export function listProfileCacheDirs(profileName: ProfileName): string[] {
  const root = getBrowserRuntimeDir();
  if (!fs.existsSync(root)) return [];
  const matches: string[] = [];
  for (const entry of fs.readdirSync(root)) {
    if (keyBelongsToProfile(entry, profileName)) matches.push(path.join(root, entry));
  }
  return matches;
}

/**
 * `process.kill(pid, 0)` answers "is a process with this id alive?" — but
 * pid reuse is real on long-uptime machines, and a stale cache pointing
 * at a since-reassigned pid would happily call the imposter ours.
 *
 * Strategy: if we recorded the executable basename when we launched, ask
 * `ps` what command the live pid is running and compare. No command on
 * record means we fall back to the existence check (older cache entries
 * or `pid:0` for "attached to an externally-launched browser").
 */
export function isProcessAlive(pid: number, expectedCommand?: string): boolean {
  if (pid === 0) return true;
  try {
    process.kill(pid, 0);
  } catch (err: any) {
    if (err && err.code === 'EPERM') {
      // exists but we can't signal it — count it as alive
      return !expectedCommand || matchesCommand(pid, expectedCommand);
    }
    return false;
  }
  if (!expectedCommand) return true;
  return matchesCommand(pid, expectedCommand);
}

/**
 * Snapshot of one tracked profile, suitable for `agents browser ps` output.
 * Combines the on-disk meta record with live-process probes so callers can
 * tell at a glance which entries are alive, stale, or have outright leaked.
 */
export interface ProfileSnapshot {
  /** Composite name as the cache dir is keyed: `<profile>` or `<profile>@<endpoint>`. */
  name: string;
  /** Absolute path of the cache dir. */
  dir: string;
  meta: ProfileRuntime | null;
  /** Live-process probe: does the recorded pid still exist + match command? */
  pidAlive: boolean;
  /** Live-process probe for the tunnel pid (SSH profiles). */
  tunnelAlive: boolean;
  /** True iff the daemon that started this is still alive. False == orphaned. */
  daemonAlive: boolean;
  /** Number of tasks recorded in tasks.json (open browser tabs). */
  taskCount: number;
}

/**
 * Read every profile cache directory and produce a structured snapshot.
 * Works without the daemon — `agents browser ps` uses this to render a
 * complete state view even when the IPC server is down. The caller can
 * post-process to detect conflicts (e.g. two profiles with the same port,
 * or a port someone else is listening on).
 */
export function listAllProfileSnapshots(): ProfileSnapshot[] {
  const root = getBrowserRuntimeDir();
  if (!fs.existsSync(root)) return [];
  const out: ProfileSnapshot[] = [];
  for (const name of fs.readdirSync(root).sort()) {
    const dir = path.join(root, name);
    let stat;
    try { stat = fs.statSync(dir); } catch { continue; }
    if (!stat.isDirectory()) continue;

    const meta = readProfileRuntimeMeta(name);
    const taskCount = readTaskCount(dir);

    const pidAlive = meta ? isProcessAlive(meta.pid, meta.command) : false;
    const tunnelAlive = meta?.tunnelPid ? isProcessAlive(meta.tunnelPid, 'ssh') : false;
    const daemonAlive = meta?.daemonPid ? isProcessAlive(meta.daemonPid) : false;

    out.push({ name, dir, meta, pidAlive, tunnelAlive, daemonAlive, taskCount });
  }
  return out;
}

function readTaskCount(dir: string): number {
  try {
    const raw = fs.readFileSync(path.join(dir, 'tasks.json'), 'utf-8');
    const obj = JSON.parse(raw);
    if (Array.isArray(obj)) return obj.length;
    if (obj && typeof obj === 'object') return Object.keys(obj).length;
    return 0;
  } catch {
    return 0;
  }
}

/**
 * Reap browser + tunnel processes spawned by daemons that no longer exist.
 * Call once on daemon startup. The idea: every process we spawn records
 * its daemonPid in meta.json. If that daemon is dead (crashed, SIGKILL),
 * its children were left rootless — kill them now so they don't hijack
 * the next session's local ports.
 *
 * We're conservative: a record with no daemonPid (older builds) is left
 * alone — we'd rather leak than wrongly kill a user-owned process that
 * happens to share metadata.
 */
export function reapOrphanedProcesses(): { reaped: number; details: string[] } {
  const root = getBrowserRuntimeDir();
  if (!fs.existsSync(root)) return { reaped: 0, details: [] };

  let reaped = 0;
  const details: string[] = [];

  for (const profileName of fs.readdirSync(root)) {
    const meta = readProfileRuntimeMeta(profileName);
    if (!meta) continue;
    if (!meta.daemonPid) continue;
    if (meta.daemonPid === process.pid) continue;
    // Owning daemon still alive — leave its kids alone.
    if (isProcessAlive(meta.daemonPid)) continue;

    // Kill what the dead daemon left behind. Best-effort.
    const kill = (pid?: number, label?: string): void => {
      if (!pid || pid === 0) return;
      // Only kill if it matches the recorded command — guards against
      // pid reuse handing us an unrelated process to murder.
      if (meta.command && !matchesCommand(pid, meta.command) &&
          !matchesCommand(pid, 'ssh')) return;
      try {
        process.kill(pid, 'SIGTERM');
        reaped++;
        details.push(`reaped ${label ?? 'pid'} ${pid} (profile ${profileName})`);
      } catch { /* already gone */ }
    };

    kill(meta.pid, 'browser');
    kill(meta.tunnelPid, 'tunnel');
    clearProfileRuntime(profileName);
  }

  return { reaped, details };
}

/**
 * True when ANY cache dir belonging to this profile still has a live browser or
 * SSH tunnel, or an open task. The composite naming (`<name>@<endpoint>`) means
 * one profile can own several runtime dirs, so checking only
 * `getProfileRuntimeDir(name)` would miss a running composite — and prune must
 * never remove a profile that is in use.
 *
 * A recorded `pid: 0` means "attached to a browser someone else launched", so it
 * is not our process to protect; an open task on that dir still counts as in use.
 */
export function isProfileInUse(profileName: string): boolean {
  for (const dir of listProfileCacheDirs(profileName)) {
    const entry = path.basename(dir);
    if (readTaskCount(dir) > 0) return true;
    const meta = readProfileRuntimeMeta(entry);
    if (!meta) continue;
    if (meta.pid && isProcessAlive(meta.pid, meta.command)) return true;
    if (meta.tunnelPid && isProcessAlive(meta.tunnelPid, 'ssh')) return true;
  }
  return false;
}

/** Why a profile is considered dead. */
export type PruneReason = 'binary-missing' | 'never-used';

export interface PruneCandidate {
  name: string;
  scope: PruneProfileClass;
  reason: PruneReason;
  /** Cache dirs that would be removed along with the config entry. */
  cacheDirs: string[];
}

export interface PrunePlan {
  /** Profiles that would be (or were) removed. */
  candidates: PruneCandidate[];
  /** Profiles deliberately left alone, with the guard that kept them. */
  kept: Array<{
    name: string;
    scope: PruneProfileClass;
    why: string;
    /**
     * True for an identity-bearing profile whose loopback endpoint only makes
     * sense on the declaring device. A structured flag, not a substring of
     * `why`: both the CLI's human output and `--json` consumers branch on it,
     * and sniffing the reason text would couple them to wording.
     */
    misfiled?: boolean;
  }>;
}

export const PRUNE_REASON_TEXT: Record<PruneReason, string> = {
  'binary-missing': 'its browser/binary is not installed on this machine',
  'never-used': 'it has never been started (no runtime dir)',
};

/**
 * Decide which browser profiles are dead, WITHOUT touching anything.
 * `pruneProfiles` executes exactly this plan, so `--dry-run` and the real run
 * can never disagree.
 *
 * Dead means one of {@link PruneReason}: the configured browser cannot launch
 * here at all, or the profile has never been started so nothing on this disk
 * refers to it. That second reason is what actually reclaims agent-minted
 * throwaway profiles (RUSH-2716) — they are created for an installed browser, so
 * only "never started" identifies them.
 *
 * Four guards, and each exists because removing that profile would be wrong
 * rather than merely tidy:
 *   - **in use** — a live browser, SSH tunnel, or open task on any of its dirs.
 *   - **the configured default** — this machine resolves a bare
 *     `agents browser start` to it; removing it breaks that command.
 *   - **the auto-detected profile** (`auto-chrome`, or the `default` an older
 *     build wrote) — still recognized and resolved by
 *     `ensureDefaultBrowserProfile` as this machine's default; since PHNX-3296
 *     it is no longer re-created on demand, so pruning it forces the user
 *     back through `agents setup` to get a default browser again.
 *
 * Known limitation: `BrowserProfileConfig` records no creation time, so a
 * profile created seconds ago and not yet started is indistinguishable from an
 * abandoned one and is reported `never-used`. That is why the verb is explicit
 * and `--dry-run` exists.
 */
export function planProfilePrune(
  profiles: Array<{
    name: string;
    scope: PruneProfileClass;
    launchableHere: boolean;
    /** Set when this identity-bearing profile's endpoint only makes sense on one machine. */
    misfiledWhy?: string;
  }>,
  opts: { configuredDefault?: string } = {}
): PrunePlan {
  const plan: PrunePlan = { candidates: [], kept: [] };

  for (const { name, scope, launchableHere, misfiledWhy } of profiles) {
    const keep = (why: string, misfiled = false): void => {
      plan.kept.push(misfiled ? { name, scope, why, misfiled } : { name, scope, why });
    };

    // Checked FIRST. A misfiled identity profile's defining symptom is that the
    // browser is absent on whatever box you are standing on — pruning it would
    // delete the declaring device's entry (or throw, for a peer declaration).
    // The repair is to declare it only on the machine that owns the browser;
    // an intentional delete is still available as `profiles remove`.
    if (misfiledWhy) {
      keep(`MISFILED — ${misfiledWhy}`, true);
      continue;
    }

    if (name === DEFAULT_BROWSER_PROFILE_NAME || name === LEGACY_DEFAULT_BROWSER_PROFILE_NAME) {
      keep('the auto-detected default profile');
      continue;
    }
    if (opts.configuredDefault && name === opts.configuredDefault) {
      keep("this machine's configured default profile");
      continue;
    }
    if (isProfileInUse(name)) {
      keep('in use (live browser, tunnel, or open task)');
      continue;
    }

    const cacheDirs = listProfileCacheDirs(name);
    if (!launchableHere) {
      plan.candidates.push({ name, scope, reason: 'binary-missing', cacheDirs });
      continue;
    }
    if (cacheDirs.length === 0) {
      plan.candidates.push({ name, scope, reason: 'never-used', cacheDirs });
      continue;
    }
    keep('healthy (browser installed, has runtime state)');
  }

  return plan;
}

/**
 * Build the prune plan from live config. Split from {@link planProfilePrune} so
 * the decision rules stay unit-testable without a configured machine.
 */
export async function buildProfilePrunePlan(): Promise<PrunePlan> {
  const current = machineId();
  const profiles = await listProfiles();
  const declaredHere: Array<{
    name: string;
    scope: PruneProfileClass;
    launchableHere: boolean;
    misfiledWhy?: string;
  }> = [];
  const peerKept: PrunePlan['kept'] = [];

  for (const profile of profiles) {
    const scope: PruneProfileClass = profile.devices.length > 1 ? 'fungible' : 'identity';
    const misfiled = identityLoopbackMismatch(profile);
    if (profile.arc && !isProfileDeclaredHere(profile.name)) {
      peerKept.push({
        name: profile.name,
        scope,
        why: 'read-only native Arc discovery; no agents-cli alias to prune',
      });
      continue;
    }
    if (profile.devices.includes(current)) {
      declaredHere.push({
        name: profile.name,
        scope,
        launchableHere: isProfileLaunchableHere(profile),
        misfiledWhy: misfiled.misfiled ? misfiled.why : undefined,
      });
      continue;
    }
    if (misfiled.misfiled) {
      peerKept.push({
        name: profile.name,
        scope,
        why: `MISFILED — ${misfiled.why}`,
        misfiled: true,
      });
    } else {
      peerKept.push({
        name: profile.name,
        scope,
        why: `declared on ${profile.devices.join(', ')}, not this device`,
      });
    }
  }

  const plan = planProfilePrune(declaredHere, {
    configuredDefault: getConfiguredDefaultProfileName(),
  });
  plan.kept.push(...peerKept);
  return plan;
}

/**
 * Execute a prune plan: drop each candidate's config entry and wipe its cache
 * dirs. Returns the plan that was applied so the caller can report exactly what
 * went, matching what `--dry-run` printed.
 */
export async function pruneProfiles(plan: PrunePlan): Promise<PrunePlan> {
  for (const candidate of plan.candidates) {
    await deleteProfile(candidate.name);
    for (const dir of candidate.cacheDirs) {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* already gone */ }
    }
    removeProfileCache(candidate.name);
  }
  return plan;
}

function matchesCommand(pid: number, expectedCommand: string): boolean {
  const out = liveProcessCommand(pid);
  if (!out) return false;
  // Match on the basename only — `/Applications/Comet.app/Contents/MacOS/Comet`
  // vs the recorded `Comet`, vs `Google\ Chrome`, vs Windows `chrome.exe`.
  // Case-insensitive.
  const live = path.basename(out).toLowerCase();
  const want = path.basename(expectedCommand).toLowerCase();
  return live === want || live.startsWith(want) || want.startsWith(live);
}

/**
 * The executable/image name the live `pid` is running, or null if it can't be
 * determined. The process-listing API differs per OS: Windows has no `ps`, so
 * we query `tasklist` (CSV image name in column 1); POSIX uses `ps -o comm=`.
 */
function liveProcessCommand(pid: number): string | null {
  try {
    if (process.platform === 'win32') {
      const out = execFileSync('tasklist', ['/FI', `PID eq ${pid}`, '/NH', '/FO', 'CSV'], {
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'ignore'],
        windowsHide: true,
      }).trim();
      // Rows look like: "node.exe","1234","Console","1","12,345 K"
      // A no-match prints an "INFO: No tasks..." line that won't match the regex.
      const m = out.match(/^"([^"]+)"/);
      return m ? m[1] : null;
    }
    const out = execFileSync('ps', ['-p', String(pid), '-o', 'comm='], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return out || null;
  } catch {
    return null;
  }
}
