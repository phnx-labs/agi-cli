import * as net from 'net';

import { CDPClient, discoverBrowserWsUrl, verifyBrowserIdentity } from '../cdp.js';
import { launchBrowser, getPortOccupant, getProcessUserDataDir, storeOccupant, storeRelaunchCommand } from '../chrome.js';
import { parseEndpointUrl, isAttachOnlyProfile, resolveProfileDataDir, normalizeDataDir } from '../profiles.js';
import type { BrowserProfile, ConnectionKey } from '../types.js';

/**
 * Cheap TCP-level "is something bound here?" probe. Used as a fallback when
 * `getPortOccupant()` (lsof-based) misses the process — Comet and other
 * Electron apps sometimes hold a TCP socket that lsof's `-sTCP:LISTEN` filter
 * doesn't report. If anything ACKs the connection, we treat the port as taken
 * and surface a friendly error instead of silently auto-launching a fresh
 * browser that would then conflict.
 */
async function probeTcpBound(port: number, host = '127.0.0.1', timeoutMs = 500): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = net.createConnection({ port, host });
    const cleanup = () => {
      sock.removeAllListeners();
      sock.destroy();
    };
    const timer = setTimeout(() => { cleanup(); resolve(false); }, timeoutMs);
    sock.once('connect', () => { clearTimeout(timer); cleanup(); resolve(true); });
    sock.once('error', () => { clearTimeout(timer); cleanup(); resolve(false); });
  });
}

export interface LocalConnection {
  cdp: CDPClient;
  port: number;
  pid: number;
}

/**
 * Local-port listeners we refuse to attach through. These forward CDP traffic
 * to a remote host — silently using them would let a `cdp://127.0.0.1:N`
 * profile drive a browser on a different machine without the caller realizing.
 */
const TUNNEL_PROCESS_NAMES = new Set(['ssh', 'autossh', 'mosh-client', 'socat']);

function isTunnelProcess(command: string): boolean {
  return TUNNEL_PROCESS_NAMES.has(command.toLowerCase());
}

/**
 * Arc is single-instance: relaunching the Arc binary with a fresh
 * `--user-data-dir` does not create a second debuggable process — macOS routes
 * the launch to the running Arc, which was started with no debug port, so the
 * spawn produces a stray window and no CDP endpoint (issue #2779). agents
 * browser therefore ATTACHES to the user's running Arc and never launches its
 * own. When the running Arc exposes no CDP endpoint on the profile's port, we
 * fail loud with the one relaunch that fixes it rather than silently spawning a
 * duplicate. Exported so the contract is unit-testable without a real Arc.
 */
export function arcAttachRequiredError(profileName: string, port: number): Error {
  return new Error(
    `Arc is not exposing a CDP endpoint on cdp://127.0.0.1:${port} for profile ` +
      `"${profileName}". Arc is single-instance — agents browser attaches to your ` +
      `RUNNING Arc and never launches a second one, so it will not start an isolated ` +
      `Arc for you. Quit Arc, then relaunch it with remote debugging on this port:\n` +
      `  open -a Arc --args --remote-debugging-port=${port}\n` +
      `and retry. The port must match the profile's endpoint (\`agents browser profiles list\`).`
  );
}

/**
 * The loud error an ATTACH-ONLY profile raises when nothing debuggable is on its
 * port (PHNX-3967). Same contract as {@link arcAttachRequiredError}, generalized
 * to any browser: agents attach to a browser the user already started and NEVER
 * spawn a rival window, so instead of falling through to `launchBrowser` (which
 * would produce the second, logged-out dock tile this ticket set out to end) we
 * fail loud with the exact relaunch that makes the canonical instance
 * attachable — pinned to the profile's DURABLE `--user-data-dir` so the one-time
 * sign-in persists. Exported so the contract is unit-testable without a browser.
 */
export function attachOnlyRequiredError(
  profile: Pick<BrowserProfile, 'name' | 'browser' | 'userDataDir'>,
  port: number
): Error {
  if (profile.browser === 'arc') return arcAttachRequiredError(profile.name, port);
  const app = profile.browser === 'comet' ? 'Comet' : profile.browser;
  const dataDir = resolveProfileDataDir(profile);
  return new Error(
    `Profile "${profile.name}" is attach-only and nothing is serving the Chrome ` +
      `DevTools Protocol on cdp://127.0.0.1:${port}. agents browser attaches to the ` +
      `${app} you already started and never launches a second one, so it will not spawn ` +
      `a rival window (that is the duplicate, logged-out tile this profile exists to ` +
      `prevent). Launch the canonical ${app} with remote debugging on its durable data dir:\n` +
      `  open -a ${app} --args --remote-debugging-port=${port} --user-data-dir=${dataDir}\n` +
      `and retry. Keep signing in once in that window — the data dir is durable, so the ` +
      `login survives quit+relaunch.`
  );
}

/**
 * The loud error an attach-only profile raises when a browser IS serving CDP on
 * its port but is a FOREIGN instance — its `--user-data-dir` is not the profile's
 * durable dir (PHNX-3967). This closes the port-squat: a logged-out `/tmp/...`
 * Comet answering CDP on the canonical port passes the browser-FAMILY identity
 * check, so without an ownership check agents would drive it as if it were the
 * credentialed browser. Rather than adopt the squatter we reject it and name the
 * fix. Exported for unit testing.
 */
export function foreignInstanceError(
  profile: Pick<BrowserProfile, 'name' | 'browser' | 'userDataDir'>,
  port: number,
  runningDataDir: string,
  pid: number
): Error {
  const expected = resolveProfileDataDir(profile);
  const app = profile.browser === 'comet' ? 'Comet' : profile.browser;
  return new Error(
    `Attach-only ownership check failed for profile "${profile.name}" on ` +
      `cdp://127.0.0.1:${port}: a ${app} is serving CDP there (pid ${pid}) but it is ` +
      `running a FOREIGN user-data-dir\n` +
      `  running:  ${runningDataDir}\n` +
      `  expected: ${expected}\n` +
      `so it is not this profile's credentialed browser. agents will not drive it. Close ` +
      `that instance (\`kill ${pid}\`), then relaunch the canonical ${app}:\n` +
      `  open -a ${app} --args --remote-debugging-port=${port} --user-data-dir=${expected}`
  );
}

/**
 * The loud error a profile pinned to the owner's own store (PHNX-4042) raises
 * when a browser already holds that store without a debug port. Launching on it
 * would not open a second browser: Chromium hands the arguments to the running
 * instance and exits, the port never binds, and the agent would wait out a
 * timeout while the owner sees a stray window. Exported for unit testing.
 */
export function storeInUseError(
  profile: Pick<BrowserProfile, 'name' | 'browser' | 'userDataDir' | 'profileDirectory'>,
  port: number,
  pid: number,
): Error {
  const app = profile.browser === 'comet' ? 'Comet' : profile.browser;
  const dataDir = resolveProfileDataDir(profile);
  return new Error(
    `Profile "${profile.name}" is pinned to ${dataDir}, and a ${app} (pid ${pid}) already has that ` +
      `store open without remote debugging, so nothing serves the Chrome DevTools Protocol on ` +
      `cdp://127.0.0.1:${port}. agents browser will not launch a second ${app} on the same store. ` +
      `Quit that ${app}, then relaunch it with remote debugging:\n` +
      `  ${storeRelaunchCommand(profile.browser, port, dataDir, profile.profileDirectory)}\n` +
      `and retry. Your logins stay: the store is the one you already use.`,
  );
}

/**
 * Prefix every ownership-rejection message carries, so `connectLocal`'s catch can
 * re-throw it verbatim instead of misreading it as "attach failed, launch fresh".
 */
const OWNERSHIP_REJECTION_PREFIX = 'Attach-only ownership check failed';

/**
 * Verify the browser serving CDP on `port` belongs to this attach-only profile,
 * by comparing its live `--user-data-dir` to the profile's durable dir
 * (PHNX-3967). No-op for a `launch`-policy profile. When an occupant IS present
 * but its data dir can't be read, fail LOUD rather than open: a canonical Comet
 * this profile is meant to attach to was launched by the user with the durable
 * `--user-data-dir` and is readable via `ps`, so an unreadable occupant is the
 * suspicious case, not a legitimate one — driving it would be the exact
 * port-squat this guard exists to stop.
 */
function verifyEndpointOwnership(profile: BrowserProfile, port: number): void {
  // Attach-only profiles and profiles pinned to the owner's own store
  // (PHNX-4042) both name the exact user-data dir a running instance must have.
  if (!isAttachOnlyProfile(profile) && !profile.userDataDir) return;
  // Arc is the user's single running instance under its own default data dir; it
  // has no managed durable dir to compare against and no /tmp-squat vector.
  if (profile.browser === 'arc') return;
  const occupant = getPortOccupant(port);
  if (!occupant) return;
  const expected = resolveProfileDataDir(profile);
  const runningDataDir = getProcessUserDataDir(occupant.pid);
  if (!runningDataDir) {
    throw new Error(
      `${OWNERSHIP_REJECTION_PREFIX} for profile "${profile.name}" on cdp://127.0.0.1:${port}: ` +
        `a process (pid ${occupant.pid}) is serving CDP there but its --user-data-dir could not be ` +
        `read, so ownership can't be confirmed. Refusing to attach to an unverified instance. If ` +
        `this is your canonical browser, relaunch it with --user-data-dir=${expected} so the ` +
        `attach-only guard can verify it.`,
    );
  }
  if (normalizeDataDir(runningDataDir) !== normalizeDataDir(expected)) {
    throw foreignInstanceError(profile, port, runningDataDir, occupant.pid);
  }
}

export async function connectLocal(
  endpoint: string,
  profile: BrowserProfile,
  /**
   * Runtime key (`<profile>@<endpoint>`) the launched browser's user-data-dir,
   * pid, and port files are stored under. Separate from `profile.name`, which
   * stays the bare user-facing name and appears only in messages (RUSH-2709).
   */
  key: ConnectionKey,
): Promise<LocalConnection> {
  const url = new URL(endpoint);

  if (url.protocol !== 'cdp:') {
    throw new Error(`Invalid local endpoint: ${endpoint}`);
  }

  // Share the parser with the SSH driver and the collision-detection code
  // path so `cdp://host:N` and `cdp://host?port=N` behave identically.
  const parsed = parseEndpointUrl(endpoint);
  const port = parsed?.port ?? 9222;

  // Refuse to attach through an SSH tunnel before we even try to speak CDP.
  // `verifyBrowserIdentity` only inspects what comes back over the wire — it
  // can't tell whether the browser actually lives on this machine or on the
  // far end of an `ssh -L` tunnel. A stale tunnel from a prior session
  // (common when an SSH-driven profile is deleted before the daemon exits)
  // will silently hijack any "local" profile bound to the same port.
  const preOccupant = getPortOccupant(port);
  if (preOccupant && isTunnelProcess(preOccupant.command)) {
    throw new Error(
      `Port ${port} is held by ${preOccupant.command} (pid ${preOccupant.pid}), an SSH ` +
        `tunnel forwarding to a remote host. Profile "${profile.name}" is configured as ` +
        `local (${endpoint}) but traffic would round-trip to another machine. Either kill ` +
        `the tunnel (\`kill ${preOccupant.pid}\`) and retry, or switch the profile to an ` +
        `ssh:// endpoint to drive the remote browser explicitly.`
    );
  }

  try {
    const { wsUrl, browser } = await discoverBrowserWsUrl(port, 'localhost', profile.name);
    verifyBrowserIdentity(browser, profile.browser, port);
    // Ownership beyond browser FAMILY (PHNX-3967): a foreign /tmp Comet answers
    // CDP on the canonical port and passes verifyBrowserIdentity, so before we
    // adopt the endpoint confirm its --user-data-dir is this profile's durable
    // dir. Rejects the port-squatter loudly instead of driving it.
    verifyEndpointOwnership(profile, port);
    const cdp = new CDPClient();
    await cdp.connect(wsUrl);

    return { cdp, port, pid: 0 };
  } catch (err) {
    if (err instanceof Error && err.message.startsWith('Browser identity mismatch')) {
      throw err;
    }
    // An ownership rejection is a definitive answer — never fall through to a
    // fresh launch or a generic port message. Re-throw it verbatim.
    if (err instanceof Error && err.message.startsWith(OWNERSHIP_REJECTION_PREFIX)) {
      throw err;
    }

    // An attach-only profile reached the catch, so the attach above failed:
    // nothing debuggable is on this port. Never fall through to launchBrowser —
    // that would spawn the duplicate/stray-window this ticket set out to end
    // (Arc: #2779, PHNX-2399; Comet: PHNX-3967). Fail loud with the relaunch that
    // makes the canonical instance attachable.
    if (isAttachOnlyProfile(profile)) {
      throw attachOnlyRequiredError(profile, port);
    }

    // Distinguish "nothing listening on this port" (fine to launch fresh) from
    // "something is listening but it's not a debuggable browser" (bail loudly —
    // silently launching on a different port leads to confusing `pid 0` and
    // `CDP connection not open` errors downstream).
    const occupant = getPortOccupant(port);
    if (occupant) {
      throw new Error(
        `Port ${port} is occupied by ${occupant.command} (pid ${occupant.pid}) but is ` +
          `not serving the Chrome DevTools Protocol. Either stop that process ` +
          `(\`kill ${occupant.pid}\`) or restart it with \`--remote-debugging-port=${port}\` ` +
          `so profile "${profile.name}" can attach.`
      );
    }

    // lsof-based detection misses some Electron-family processes (Comet, custom
    // chrome wrappers). Cheap TCP probe as a safety net: if something ACKs a
    // connect, the port is bound — bail loudly with the profile name + endpoint
    // rather than silently launching a duplicate browser.
    if (await probeTcpBound(port)) {
      throw new Error(
        `Profile "${profile.name}" is configured for cdp://127.0.0.1:${port}, ` +
          `but something is already bound to that port without serving the Chrome ` +
          `DevTools Protocol. If that's your browser running without remote debugging, ` +
          `quit it and relaunch with \`--remote-debugging-port=${port}\`. Otherwise, ` +
          `update the profile to a free port (\`agents browser profiles list\`).`
      );
    }

    // A store-pinned profile launches on the owner's store only while nothing
    // holds it; a browser already open there without a port must be relaunched
    // by the owner, never doubled (PHNX-4042).
    if (profile.userDataDir) {
      const holder = storeOccupant(profile.userDataDir);
      if (holder) throw storeInUseError(profile, port, holder.pid);
    }

    const newPort = port;
    const chromeOpts = {
      ...profile.chrome,
      viewport: profile.viewport,
      // A discovered native profile launches the owner's browser on its own
      // store: one window for the owner and agents, logins intact (PHNX-4042).
      ...(profile.userDataDir
        ? { userDataDir: profile.userDataDir, profileDirectory: profile.profileDirectory }
        : {}),
    };
    let launched;
    try {
      launched = await launchBrowser(
        key,
        profile.browser,
        newPort,
        chromeOpts,
        profile.secrets,
        profile.binary,
        profile.electron === true
      );
    } catch (launchErr) {
      const reason = launchErr instanceof Error ? launchErr.message : String(launchErr);
      throw new Error(
        `Could not start ${profile.browser} for profile "${profile.name}" on port ${newPort}: ${reason}. ` +
          `Check that the browser binary is installed (\`agents browser profiles list\`) and ` +
          `that no other process is holding the port.`
      );
    }
    const cdp = new CDPClient();
    await cdp.connect(launched.wsUrl);

    return { cdp, port: newPort, pid: launched.pid };
  }
}
